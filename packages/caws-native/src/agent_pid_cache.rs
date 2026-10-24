//! Finite macOS session-prefix PID correlation and progressive reaping. These
//! provenance caches never confer project or session ownership authority.
//! Capture runs in the original frontend, never in a retained owner or Node.
use crate::{
    process_comm_macos,
    session_cache::{self, FailureKind},
};
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, Visitor},
};
use serde_json::{json, value::RawValue};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fmt,
    fs::{File, Metadata},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const MAX_HOPS: usize = 16;
pub const MAX_RECORD_BYTES: usize = 65_536;
pub const MAX_RECORDS: usize = 1_024;
pub const MAX_DIRECTORY_ENTRIES: usize = 4_096;
pub const MAX_COMBINED_BYTES: usize = 1_048_576;
const MARKER: &CStr = c".agent-pid-reap-marker";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Birth {
    parent: u32,
    seconds: u64,
    micros: u64,
}
#[derive(Clone)]
struct Row {
    pid: u32,
    birth: Birth,
}
#[derive(Clone)]
pub struct OriginalAncestry {
    surface: String,
    supported: bool,
    rows: Vec<Row>,
    matched: Option<u32>,
    unavailable: bool,
}
fn checkpoint(
    expires: Instant,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), FailureKind> {
    cancel().map_err(FailureKind::Cancelled)?;
    if Instant::now() >= expires {
        Err(FailureKind::Deadline)
    } else {
        Ok(())
    }
}
#[cfg(target_os = "macos")]
fn birth(pid: u32) -> io::Result<Birth> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(io::Error::other("invalid process PID"));
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if count != size as i32 {
        return Err(io::Error::other("native process birth unavailable"));
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000 {
        return Err(io::Error::other("invalid native process birth"));
    }
    Ok(Birth {
        parent: info.pbi_ppid,
        seconds: info.pbi_start_tvsec,
        micros: info.pbi_start_tvusec,
    })
}
#[cfg(not(target_os = "macos"))]
fn birth(_: u32) -> io::Result<Birth> {
    Err(io::Error::other("unsupported native PID cache platform"))
}
// Exact shipped shared/lib/agent-surface.sh defaults; no caller-selected list.
fn selected_names(surface: &str) -> Option<&'static [&'static [u8]]> {
    match surface {
        "codex" => Some(&[b"codex"]),
        "claude-code" => Some(&[b"claude"]),
        "opencode" => Some(&[b"opencode"]),
        "zcode" => Some(&[
            b"zcode-cli",
            b"zcode-host-local-1",
            b"zcode-host-local-2",
            b"zcode-host-local-3",
        ]),
        _ => None,
    }
}
fn selected_profile(surface: &str) -> Option<&'static [u8]> {
    match surface {
        "codex" => Some(b"codex"),
        "claude-code" => Some(b"claude"),
        "opencode" => Some(b"opencode"),
        "zcode" => Some(b"zcode-cli zcode-host-local-1 zcode-host-local-2 zcode-host-local-3"),
        _ => None,
    }
}
fn selected_comm(surface: &str, comm: &[u8]) -> bool {
    let name = comm.rsplit(|byte| *byte == b'/').next().unwrap_or_default();
    selected_names(surface).is_some_and(|names| names.contains(&name))
}
#[cfg(target_os = "macos")]
fn find_profile() -> bool {
    unsafe extern "C" {
        fn compat_mode(function: *const libc::c_char, mode: *const libc::c_char) -> bool;
    }
    // Same native selection as /usr/bin/find, observed in the original frontend.
    unsafe { compat_mode(c"bin/find".as_ptr(), c"unix2003".as_ptr()) }
}
#[cfg(not(target_os = "macos"))]
fn find_profile() -> bool {
    false
}
trait Observer {
    fn birth(&mut self, pid: u32) -> io::Result<Birth>;
    fn comm(&mut self, pid: u32, expires: Instant) -> io::Result<Vec<u8>>;
}
struct NativeObserver;
impl Observer for NativeObserver {
    fn birth(&mut self, pid: u32) -> io::Result<Birth> {
        birth(pid)
    }
    fn comm(&mut self, pid: u32, expires: Instant) -> io::Result<Vec<u8>> {
        process_comm_macos::read(pid, expires)
            .map(|value| value.comm_bytes().to_vec())
            .map_err(|_| io::Error::other("native process comm unavailable"))
    }
}
impl OriginalAncestry {
    /// Must be invoked by the original frontend before any resident handoff.
    /// No asserted PID, Node field, environment PID or owner ancestry is accepted.
    pub fn capture(
        surface: &str,
        expires: Instant,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        let selected = selected_profile(surface);
        let names = std::env::var_os("CAWS_AGENT_PROCESS_NAMES");
        let supported = find_profile()
            && selected.is_some()
            && names.as_ref().is_none_or(|names| {
                names.is_empty() || names.as_encoded_bytes() == selected.unwrap()
            });
        Self::capture_with(
            surface,
            std::process::id(),
            supported,
            expires,
            &mut cancel,
            &mut NativeObserver,
        )
        .map_err(|error| format!("original agent ancestry capture failed: {error:?}"))
    }
    fn capture_with(
        surface: &str,
        original: u32,
        supported: bool,
        expires: Instant,
        cancel: &mut impl FnMut() -> Result<(), String>,
        observer: &mut impl Observer,
    ) -> Result<Self, FailureKind> {
        let mut captured = Self {
            surface: surface.into(),
            supported,
            rows: Vec::new(),
            matched: None,
            unavailable: false,
        };
        checkpoint(expires, cancel)?;
        if !supported {
            return Ok(captured);
        }
        let mut pid = original;
        for _ in 0..MAX_HOPS {
            checkpoint(expires, cancel)?;
            if pid <= 1 || pid > i32::MAX as u32 || captured.rows.iter().any(|row| row.pid == pid) {
                break;
            }
            // Recheck the preceding edge so a reused/reparented intermediate
            // cannot connect an observed process to a different ancestry.
            if let Some(previous) = captured.rows.last() {
                if observer.birth(previous.pid).ok().as_ref() != Some(&previous.birth) {
                    captured.unavailable = true;
                    break;
                }
            }
            let before = match observer.birth(pid) {
                Ok(value) => value,
                Err(_) => {
                    captured.unavailable = true;
                    break;
                }
            };
            checkpoint(expires, cancel)?;
            let comm = match observer.comm(pid, expires) {
                Ok(value) => value,
                Err(_) => {
                    checkpoint(expires, cancel)?;
                    captured.unavailable = true;
                    break;
                }
            };
            checkpoint(expires, cancel)?;
            if observer.birth(pid).ok().as_ref() != Some(&before) {
                captured.unavailable = true;
                break;
            }
            captured.rows.push(Row {
                pid,
                birth: before.clone(),
            });
            if selected_comm(surface, &comm) {
                captured.matched = Some(pid);
                break;
            }
            if before.parent == pid {
                break;
            }
            pid = before.parent;
        }
        checkpoint(expires, cancel)?;
        Ok(captured)
    }
    pub(crate) fn supports(&self, surface: &str) -> bool {
        self.supported && self.surface == surface
    }
    fn confirm(
        &self,
        expires: Instant,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<bool, FailureKind> {
        for row in &self.rows {
            checkpoint(expires, cancel)?;
            if birth(row.pid).ok().as_ref() != Some(&row.birth) {
                return Ok(false);
            }
        }
        if let Some(pid) = self.matched {
            let before = match birth(pid) {
                Ok(value) => value,
                Err(_) => return Ok(false),
            };
            let comm = match process_comm_macos::read(pid, expires) {
                Ok(value) => value,
                Err(_) => {
                    checkpoint(expires, cancel)?;
                    return Ok(false);
                }
            };
            checkpoint(expires, cancel)?;
            if birth(pid).ok().as_ref() != Some(&before) {
                return Ok(false);
            }
            return Ok(selected_comm(&self.surface, comm.comm_bytes()));
        }
        Ok(!self.unavailable)
    }
}

#[derive(Debug)]
pub(crate) enum PrepareError {
    Unsupported(&'static str),
    Failure(FailureKind),
}
impl From<io::Error> for PrepareError {
    fn from(error: io::Error) -> Self {
        Self::Failure(FailureKind::Io(error))
    }
}
impl From<FailureKind> for PrepareError {
    fn from(error: FailureKind) -> Self {
        Self::Failure(error)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPidOutcome {
    Refreshed,
    NotFound,
    Unavailable,
    NotRun,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReapOutcome {
    Completed,
    RateLimited,
    Unavailable,
    NotRun,
}
pub(crate) struct Outcome {
    pub agent_pid: AgentPidOutcome,
    pub reap: ReapOutcome,
    pub failure: Option<FailureKind>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
    mode: u32,
}
fn identity(metadata: &Metadata) -> Identity {
    Identity {
        dev: metadata.dev(),
        ino: metadata.ino(),
        size: metadata.len(),
        mtime: metadata.mtime(),
        mtime_ns: metadata.mtime_nsec(),
        ctime: metadata.ctime(),
        ctime_ns: metadata.ctime_nsec(),
        mode: metadata.mode(),
    }
}
fn open_at(parent: &File, name: &CStr, flags: i32) -> io::Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn optional_file(parent: &File, name: &CStr) -> io::Result<Option<File>> {
    match open_at(parent, name, libc::O_RDONLY) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn record_bytes(file: &File, total: &mut usize) -> Result<Vec<u8>, PrepareError> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES as u64 {
        return Err(PrepareError::Unsupported(
            "unsupported agent PID record file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    *total = total
        .checked_add(bytes.len())
        .ok_or(PrepareError::Unsupported("agent PID byte count overflow"))?;
    if bytes.len() > MAX_RECORD_BYTES || *total > MAX_COMBINED_BYTES {
        return Err(PrepareError::Unsupported("agent PID record byte limit"));
    }
    Ok(bytes)
}
struct FlatRecord(BTreeMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for FlatRecord {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Flat;
        impl<'de> Visitor<'de> for Flat {
            type Value = FlatRecord;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("finite flat agent PID record")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = BTreeMap::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !key.is_ascii() || values.len() >= 32 || values.contains_key(&key) {
                        return Err(de::Error::custom("unsupported or duplicate record key"));
                    }
                    values.insert(key, map.next_value::<Box<RawValue>>()?);
                }
                Ok(FlatRecord(values))
            }
        }
        deserializer.deserialize_map(Flat)
    }
}
struct Record {
    pid: u32,
    created: Option<String>,
}
fn parse_record(bytes: &[u8]) -> Result<Record, PrepareError> {
    let unsupported = || PrepareError::Unsupported("unsupported old agent PID JSON profile");
    let FlatRecord(values) =
        serde_json::from_slice::<FlatRecord>(bytes).map_err(|_| unsupported())?;
    let mut pid = None;
    let mut created = None;
    for (key, raw) in values {
        if key == "agent_pid" {
            let token = raw.get();
            if token.is_empty()
                || !token.bytes().all(|byte| byte.is_ascii_digit())
                || token.starts_with('0')
            {
                return Err(unsupported());
            }
            pid = Some(
                token
                    .parse::<u32>()
                    .ok()
                    .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
                    .ok_or_else(unsupported)?,
            );
        } else if raw.get() == "null" && key == "started_at" {
        } else {
            let value = serde_json::from_str::<String>(raw.get()).map_err(|_| unsupported())?;
            // Python strings outside this deliberately finite ASCII profile,
            // including lone UTF-16 surrogates, decline instead of being repaired.
            if !value.is_ascii() || value.contains('\0') {
                return Err(unsupported());
            }
            if key == "started_at"
                && (!value.bytes().all(|b| b.is_ascii_digit()) || value.is_empty())
            {
                return Err(unsupported());
            }
            if key == "created_at" {
                // The old Python print feeds Bash command substitution, which
                // strips all trailing LF bytes before passing the value back.
                let value = value.trim_end_matches('\n');
                if !value.is_empty() {
                    created = Some(value.into());
                }
            }
        }
    }
    Ok(Record {
        pid: pid.ok_or_else(unsupported)?,
        created,
    })
}
struct Directory(*mut libc::DIR);
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}
fn errno_pointer() -> *mut libc::c_int {
    #[cfg(target_os = "macos")]
    {
        unsafe { libc::__error() }
    }
    #[cfg(target_os = "linux")]
    {
        unsafe { libc::__errno_location() }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        std::ptr::null_mut()
    }
}
fn names(
    sessions: &File,
    expires: Instant,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<Vec<CString>, PrepareError> {
    // A new open description avoids advancing the retained capability's offset.
    let scan = session_cache::directory_at(sessions, c".", false)?;
    use std::os::fd::IntoRawFd;
    let raw = scan.into_raw_fd();
    let directory = unsafe { libc::fdopendir(raw) };
    if directory.is_null() {
        unsafe {
            libc::close(raw);
        };
        return Err(io::Error::last_os_error().into());
    }
    let directory = Directory(directory);
    let mut names = Vec::new();
    let mut count = 0;
    loop {
        checkpoint(expires, cancel)?;
        let errno = errno_pointer();
        if !errno.is_null() {
            unsafe {
                *errno = 0;
            }
        }
        let entry = unsafe { libc::readdir(directory.0) };
        if entry.is_null() {
            if !errno.is_null() && unsafe { *errno } != 0 {
                return Err(io::Error::last_os_error().into());
            }
            break;
        }
        count += 1;
        if count > MAX_DIRECTORY_ENTRIES {
            return Err(PrepareError::Unsupported("agent PID directory entry limit"));
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        let record = bytes.starts_with(b"agent-pid-") && bytes.ends_with(b".json");
        let orphan =
            bytes.starts_with(b".agent-pid-") && bytes.windows(5).any(|part| part == b".tmp.");
        if record || orphan {
            if !bytes.is_ascii() || names.len() >= MAX_RECORDS {
                return Err(PrepareError::Unsupported(
                    "agent PID filename profile or record limit",
                ));
            }
            names.push(CString::new(bytes).unwrap());
        }
    }
    names.sort();
    Ok(names)
}
struct Candidate {
    name: CString,
    file: File,
    identity: Identity,
    pid: Option<u32>,
    orphan: bool,
}
pub(crate) struct PreparedPid {
    original: OriginalAncestry,
    created: Option<String>,
    candidates: Vec<Candidate>,
    recent: bool,
}
fn now_seconds() -> io::Result<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs()
        .try_into()
        .map_err(io::Error::other)
}
// Actual macOS unix2003 find: days truncate; minutes round up and -N has
// TIME_CORRECT. Confirmed by actual /usr/bin/find boundary fixtures, not its
// misleading generic manual description. Subsecond metadata is not consulted.
fn hard(age: i128) -> bool {
    age / 86400 > 7
}
fn grace(age: i128) -> bool {
    let days = age / 86400;
    days > 3 && days < 7
}
fn marker_recent(age: i128) -> bool {
    (age + 59) / 60 < 61
}
fn orphan_old(age: i128) -> bool {
    (age + 59) / 60 > 60
}
pub(crate) fn prepare(
    sessions: Option<&File>,
    original: &OriginalAncestry,
    expires: Instant,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<PreparedPid, PrepareError> {
    checkpoint(expires, cancel)?;
    let mut prepared = PreparedPid {
        original: original.clone(),
        created: None,
        candidates: Vec::new(),
        recent: false,
    };
    let Some(pid) = original.matched else {
        return Ok(prepared);
    };
    let Some(sessions) = sessions else {
        return Ok(prepared);
    };
    let own = CString::new(format!("agent-pid-{pid}.json")).unwrap();
    let mut total = 0;
    if let Some(file) = optional_file(sessions, &own)? {
        prepared.created = parse_record(&record_bytes(&file, &mut total)?)?.created;
    }
    if let Some(marker) = optional_file(sessions, MARKER)? {
        let metadata = marker.metadata()?;
        if !metadata.is_file() {
            return Err(PrepareError::Unsupported("unsupported PID reaper marker"));
        }
        prepared.recent = marker_recent(now_seconds()? as i128 - metadata.mtime() as i128);
    }
    if prepared.recent {
        return Ok(prepared);
    };
    for name in names(sessions, expires, cancel)? {
        checkpoint(expires, cancel)?;
        if name == own {
            continue;
        }
        let Some(file) = optional_file(sessions, &name)? else {
            continue;
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(PrepareError::Unsupported(
                "unsupported PID reaper candidate",
            ));
        }
        let orphan = name.to_bytes().starts_with(b".agent-pid-");
        let record = if orphan {
            None
        } else {
            Some(parse_record(&record_bytes(&file, &mut total)?)?)
        };
        prepared.candidates.push(Candidate {
            name,
            file,
            identity: identity(&metadata),
            pid: record.map(|record| record.pid),
            orphan,
        });
    }
    Ok(prepared)
}

fn same_entry(parent: &File, name: &CStr, expected: &Identity) -> io::Result<bool> {
    let Some(file) = optional_file(parent, name)? else {
        return Ok(false);
    };
    Ok(identity(&file.metadata()?) == *expected)
}
#[cfg(target_os = "macos")]
fn restore(source: &File, target: &File, name: &CStr) -> io::Result<()> {
    if unsafe {
        libc::renameatx_np(
            source.as_raw_fd(),
            c"entry".as_ptr(),
            target.as_raw_fd(),
            name.as_ptr(),
            libc::RENAME_EXCL,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(not(target_os = "macos"))]
fn restore(_: &File, _: &File, _: &CStr) -> io::Result<()> {
    Err(io::Error::other("conditional restore unavailable"))
}
static QUARANTINE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
trait ReapPort {
    fn before_move(&mut self, _name: &CStr) -> io::Result<()> {
        Ok(())
    }
    fn after_move(&mut self, _name: &CStr) -> io::Result<()> {
        Ok(())
    }
}
struct NativeReap;
impl ReapPort for NativeReap {}
fn remove_candidate(
    sessions: &File,
    candidate: &Candidate,
    port: &mut impl ReapPort,
) -> io::Result<()> {
    if identity(&candidate.file.metadata()?) != candidate.identity
        || !same_entry(sessions, &candidate.name, &candidate.identity)?
    {
        return Err(io::Error::other(
            "PID reap candidate changed before removal",
        ));
    }
    let mut quarantine = None;
    for _ in 0..16 {
        let name = CString::new(format!(
            ".caws-agent-pid-reap.{}.{}",
            std::process::id(),
            QUARANTINE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
        .unwrap();
        if unsafe { libc::mkdirat(sessions.as_raw_fd(), name.as_ptr(), 0o700) } == 0 {
            quarantine = Some((session_cache::directory_at(sessions, &name, false)?, name));
            break;
        }
        if io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
            return Err(io::Error::last_os_error());
        }
    }
    let (directory, name) =
        quarantine.ok_or_else(|| io::Error::other("PID reap quarantine collision limit"))?;
    let result = (|| {
        port.before_move(&candidate.name)?;
        if unsafe {
            libc::renameat(
                sessions.as_raw_fd(),
                candidate.name.as_ptr(),
                directory.as_raw_fd(),
                c"entry".as_ptr(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        port.after_move(&candidate.name)?;
        // Rename may update ctime. Compare the moved name with the still-held
        // original FD, and require its other content/instance fields unchanged.
        let held = identity(&candidate.file.metadata()?);
        let content_unchanged = held.dev == candidate.identity.dev
            && held.ino == candidate.identity.ino
            && held.size == candidate.identity.size
            && held.mtime == candidate.identity.mtime
            && held.mtime_ns == candidate.identity.mtime_ns
            && held.mode == candidate.identity.mode;
        if !content_unchanged || !same_entry(&directory, c"entry", &held)? {
            return match restore(&directory, sessions, &candidate.name) {
                Ok(()) => Err(io::Error::other(
                    "replaced PID reap entry restored without deletion",
                )),
                Err(error) => Err(io::Error::other(format!(
                    "replaced PID reap entry retained in {} after restore failed: {error}",
                    name.to_string_lossy()
                ))),
            };
        }
        // Only the validated moved instance is removed inside the retained
        // private directory. No subsequent lookup of the shared name is deleted.
        if unsafe { libc::unlinkat(directory.as_raw_fd(), c"entry".as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    // AT_REMOVEDIR only removes an empty quarantine; never recursively delete
    // a retained mismatch or an entry whose restore could not complete.
    unsafe {
        libc::unlinkat(sessions.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR);
    }
    result
}
impl PreparedPid {
    pub(crate) fn commit(
        self,
        sessions: &mut session_cache::PreparedPrefix,
        sid: &str,
        root: &str,
        expires: Instant,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Outcome {
        let mut refreshed = false;
        let result = (|| {
            checkpoint(expires, cancel)?;
            if self.original.matched.is_none() {
                if self.original.unavailable {
                    return Err(FailureKind::Io(io::Error::other(
                        "original agent ancestry unavailable",
                    )));
                }
                return Ok((AgentPidOutcome::NotFound, ReapOutcome::NotRun));
            }
            if !self.original.confirm(expires, cancel)? {
                return Err(FailureKind::Io(io::Error::other(
                    "original agent process instance changed",
                )));
            }
            let pid = self.original.matched.unwrap();
            let observed = self
                .original
                .rows
                .iter()
                .find(|row| row.pid == pid)
                .unwrap();
            let directory = sessions.ensure_sessions().map_err(FailureKind::Io)?;
            let now = session_cache::timestamp().map_err(FailureKind::Io)?;
            let mut bytes=serde_json::to_vec(&json!({"agent_pid":pid,"session_id":sid,"surface":self.original.surface,"repo_root":root,"created_at":self.created.as_ref().unwrap_or(&now),"last_seen_at":now,"started_at":observed.birth.seconds.to_string()})).map_err(|error|FailureKind::Io(io::Error::other(error)))?;
            bytes.push(b'\n');
            session_cache::publish_json(
                directory,
                &CString::new(format!("agent-pid-{pid}.json")).unwrap(),
                &bytes,
                expires,
                cancel,
            )?;
            refreshed = true;
            checkpoint(expires, cancel)?;
            // The legacy marker is checked/claimed only AFTER successful own
            // refresh. Recheck its current mtime, not only the preflight value.
            if let Some(marker) = optional_file(directory, MARKER).map_err(FailureKind::Io)? {
                if marker_recent(
                    now_seconds().map_err(FailureKind::Io)? as i128
                        - marker.metadata().map_err(FailureKind::Io)?.mtime() as i128,
                ) {
                    return Ok((AgentPidOutcome::Refreshed, ReapOutcome::RateLimited));
                }
            }
            // A preflight recent marker may have aged meanwhile: another call
            // will reap. Do not claim/scan an unprepared directory after effects.
            if self.recent {
                return Err(FailureKind::Io(io::Error::other(
                    "PID reap marker aged after preflight",
                )));
            }
            // Atomic empty replacement updates the same mtime contract without
            // truncating a hard-linked file outside the directory capability.
            session_cache::publish_json(directory, MARKER, b"", expires, cancel)?;
            // Preserve distinct hard/grace/orphan pass start times and ordering.
            let mut reap_errors = Vec::new();
            for pass in 0..3 {
                let now = now_seconds().map_err(FailureKind::Io)?;
                for candidate in &self.candidates {
                    checkpoint(expires, cancel)?;
                    let age = now as i128 - candidate.identity.mtime as i128;
                    let selected = match pass {
                        0 => !candidate.orphan && hard(age),
                        1 => !candidate.orphan && grace(age),
                        _ => candidate.orphan && orphan_old(age),
                    };
                    if !selected {
                        continue;
                    }
                    if pass == 1 {
                        let pid = candidate.pid.unwrap();
                        if unsafe { libc::kill(pid as i32, 0) } == 0 {
                            continue;
                        }
                        // Shell kill -0 failure, including EPERM, selects rm.
                    }
                    if let Err(error) = remove_candidate(directory, candidate, &mut NativeReap) {
                        // Legacy rm failures do not suppress the remaining
                        // candidates or later passes. Retain a bounded diagnostic.
                        if reap_errors.len() < 8 {
                            reap_errors.push(error.to_string());
                        }
                    }
                }
            }
            if !reap_errors.is_empty() {
                return Err(FailureKind::Io(io::Error::other(reap_errors.join("; "))));
            }
            Ok((AgentPidOutcome::Refreshed, ReapOutcome::Completed))
        })();
        match result {
            Ok((agent_pid, reap)) => Outcome {
                agent_pid,
                reap,
                failure: None,
            },
            Err(failure) => Outcome {
                agent_pid: if refreshed {
                    AgentPidOutcome::Refreshed
                } else {
                    AgentPidOutcome::Unavailable
                },
                reap: if refreshed {
                    ReapOutcome::Unavailable
                } else {
                    ReapOutcome::NotRun
                },
                failure: Some(failure),
            },
        }
    }
}

#[cfg(test)]
impl OriginalAncestry {
    pub(crate) fn fixture_not_found(surface: &str) -> Self {
        Self {
            surface: surface.into(),
            supported: cfg!(target_os = "macos"),
            rows: Vec::new(),
            matched: None,
            unavailable: false,
        }
    }
    pub(crate) fn fixture_current(surface: &str) -> Self {
        let pid = std::process::id();
        Self {
            surface: surface.into(),
            supported: cfg!(target_os = "macos"),
            rows: vec![Row {
                pid,
                birth: birth(pid).unwrap(),
            }],
            matched: Some(pid),
            unavailable: false,
        }
    }
}

#[cfg(test)]
#[path = "agent_pid_cache/tests.rs"]
mod tests;
