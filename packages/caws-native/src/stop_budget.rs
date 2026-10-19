//! Persistent, operational Stop infrastructure-failure budget.
//!
//! Callers charge only an undeliverable infrastructure result, preserve valid
//! guard refusals, and reset only after a successful nonblocking native handoff.
//! This module does not identify guards, deliver output, or grant authority.
//!
//! Cooperative writers serialize on a separate, stable flock inode. Atomic
//! same-directory rename prevents partial JSON after a process crash. No fsync
//! is performed: completed transactions are NOT promised durable over power
//! loss. Deadlines bound lock retries and are checked around filesystem work;
//! they cannot interrupt an uninterruptible kernel filesystem operation.
//!
//! The private namespace is
//! `state/projects/<full-digest>/sessions/<sid-SID|unkeyed>/stop-undeliverable.json`.
//! Legacy global session counters are never read, imported, or changed.
//! An unavailable transaction may already have committed before its deadline
//! was observed. Callers must not retry it as an exactly-once operation.

use serde::{Deserialize, Serialize};
use std::{
    ffi::{CStr, CString},
    fmt,
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const COUNTER: &CStr = c"stop-undeliverable.json";
const LOCK: &CStr = c".stop-undeliverable.lock";
const MAX_COUNTER_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableKind {
    Identity,
    UnsafePath,
    Corrupt,
    Io,
    Deadline,
}

#[derive(Debug)]
pub struct Unavailable {
    pub kind: UnavailableKind,
    operation: &'static str,
    source: Option<io::Error>,
}
impl Unavailable {
    fn new(kind: UnavailableKind, operation: &'static str) -> Self {
        Self {
            kind,
            operation,
            source: None,
        }
    }
    fn io(operation: &'static str) -> Self {
        Self::with_source(operation, io::Error::last_os_error())
    }
    fn with_source(operation: &'static str, source: io::Error) -> Self {
        let kind = if matches!(source.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
            UnavailableKind::UnsafePath
        } else {
            UnavailableKind::Io
        };
        Self {
            kind,
            operation,
            source: Some(source),
        }
    }
}
impl fmt::Display for Unavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Stop budget unavailable: {}", self.operation)?;
        if let Some(source) = &self.source {
            write!(f, ": {source}")?;
        }
        Ok(())
    }
}
impl std::error::Error for Unavailable {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|error| error as _)
    }
}

/// An explicitly supplied canonical-project SHA256 and a validated session key.
/// Valid sessions use a lowercase base32 encoding of their exact bytes;
/// missing or unsafe session keys use the
/// reserved `unkeyed` directory inside that project only.
/// The project digest namespaces operational state; it does not confer authority.
#[derive(Debug, Clone)]
pub struct BudgetIdentity {
    project_digest: String,
    session: String,
}
impl BudgetIdentity {
    pub fn resolve(
        session: Option<&str>,
        canonical_project_digest: Option<&str>,
    ) -> Result<Self, Unavailable> {
        let digest = canonical_project_digest
            .filter(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            .ok_or_else(|| {
                Unavailable::new(
                    UnavailableKind::Identity,
                    "canonical-project digest required for every Stop budget",
                )
            })?;
        let session = session
            .filter(|sid| {
                !sid.is_empty()
                    && sid.len() <= 128
                    && *sid != "."
                    && *sid != ".."
                    && sid
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.@:-".contains(&c))
            })
            .map(session_directory)
            .unwrap_or_else(|| "unkeyed".into());
        Ok(Self {
            project_digest: digest.into(),
            session,
        })
    }
}

// Lowercase filename alphabet is injective under ordinary filesystem case
// folding. At 128 source bytes the key is 209 bytes, below NAME_MAX=255.
fn session_directory(sid: &str) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut result = String::from("sid-");
    let mut pending = 0_u16;
    let mut bits = 0;
    for byte in sid.bytes() {
        pending = (pending << 8) | u16::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            result.push(char::from(ALPHABET[usize::from((pending >> bits) & 31)]));
        }
    }
    if bits > 0 {
        result.push(char::from(
            ALPHABET[usize::from((pending << (5 - bits)) & 31)],
        ));
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Charge {
    Refuse,
    Release,
}

/// A directory capability rooted in explicit CAWS_HOME. No environment is read.
pub struct StopBudget {
    directory: OwnedFd,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Counter {
    consecutive_undeliverable: u8,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Inode {
    device: libc::dev_t,
    inode: libc::ino_t,
}
struct Observed {
    count: u8,
    inode: Option<Inode>,
}

fn deadline(expires: Instant) -> Result<(), Unavailable> {
    if Instant::now() >= expires {
        Err(Unavailable::new(
            UnavailableKind::Deadline,
            "transaction deadline expired",
        ))
    } else {
        Ok(())
    }
}

fn fd(raw: RawFd, operation: &'static str) -> Result<OwnedFd, Unavailable> {
    if raw < 0 {
        Err(Unavailable::io(operation))
    } else {
        // SAFETY: a successful open returned this fresh descriptor exactly once.
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    }
}

fn filesystem_anchor() -> Result<OwnedFd, Unavailable> {
    fd(
        unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        },
        "open filesystem anchor",
    )
}

fn mkdir_if_absent(parent: RawFd, name: &CStr, expires: Instant) -> Result<(), Unavailable> {
    deadline(expires)?;
    if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } != 0
        && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
    {
        return Err(Unavailable::io("create budget directory"));
    }
    Ok(())
}

fn metadata(raw: RawFd) -> Result<libc::stat, Unavailable> {
    let mut value = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: fstat initializes the writable stat structure on success.
    if unsafe { libc::fstat(raw, value.as_mut_ptr()) } != 0 {
        return Err(Unavailable::io("inspect owned descriptor"));
    }
    Ok(unsafe { value.assume_init() })
}

fn same_name(parent: RawFd, name: &CStr, file: RawFd) -> bool {
    let mut named = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            named.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return false;
    }
    let named = unsafe { named.assume_init() };
    metadata(file).is_ok_and(|opened| {
        named.st_dev == opened.st_dev
            && named.st_ino == opened.st_ino
            && named.st_mode & libc::S_IFMT == libc::S_IFREG
    })
}

fn safe_directory(raw: RawFd) -> Result<(), Unavailable> {
    let value = metadata(raw)?;
    // SAFETY: geteuid has no arguments or preconditions.
    if value.st_mode & libc::S_IFMT != libc::S_IFDIR
        || value.st_uid != unsafe { libc::geteuid() }
        || value.st_mode & 0o022 != 0
        || value.st_mode & 0o700 != 0o700
    {
        return Err(Unavailable::new(
            UnavailableKind::UnsafePath,
            "directory must be owned, owner-accessible, and not shared-writable",
        ));
    }
    Ok(())
}

fn safe_file(raw: RawFd) -> Result<libc::stat, Unavailable> {
    let value = metadata(raw)?;
    // Existing private or read-shared legacy0644 counters are accepted. Only
    // their owner may write; all files created here start with mode0600.
    if value.st_mode & libc::S_IFMT != libc::S_IFREG
        || value.st_uid != unsafe { libc::geteuid() }
        || value.st_nlink != 1
        || value.st_mode & 0o022 != 0
        || value.st_mode & 0o600 != 0o600
    {
        return Err(Unavailable::new(
            UnavailableKind::UnsafePath,
            "file must be regular, owned, single-link, and not shared-writable",
        ));
    }
    Ok(value)
}

fn directory_at(
    parent: RawFd,
    name: &CStr,
    create: bool,
    expires: Instant,
) -> Result<OwnedFd, Unavailable> {
    deadline(expires)?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: parent is live and name is a nul-terminated single component.
    let mut raw = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if raw < 0 {
        let error = io::Error::last_os_error();
        if create && error.raw_os_error() == Some(libc::ENOENT) {
            mkdir_if_absent(parent, name, expires)?;
            raw = unsafe { libc::openat(parent, name.as_ptr(), flags) };
        } else {
            return Err(Unavailable::with_source(
                "open budget directory without symlinks",
                error,
            ));
        }
    }
    fd(raw, "open budget directory without symlinks")
}

impl StopBudget {
    pub fn open(
        home: &Path,
        identity: BudgetIdentity,
        expires: Instant,
    ) -> Result<Self, Unavailable> {
        deadline(expires)?;
        if !home.is_absolute()
            || home
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err(Unavailable::new(
                UnavailableKind::UnsafePath,
                "CAWS_HOME must be absolute without traversal",
            ));
        }
        // Walk from / using held directory descriptors. Never validate a realpath
        // and later reopen it by name; every component rejects symlinks itself.
        let mut directory = filesystem_anchor()?;
        for part in home.components() {
            if let Component::Normal(name) = part {
                let name = CString::new(name.as_bytes()).map_err(|_| {
                    Unavailable::new(UnavailableKind::UnsafePath, "nul in CAWS_HOME")
                })?;
                directory = directory_at(directory.as_raw_fd(), &name, false, expires)?;
            }
        }
        safe_directory(directory.as_raw_fd())?;
        let key = CString::new(identity.session).map_err(|_| {
            Unavailable::new(UnavailableKind::Identity, "invalid validated identity")
        })?;
        let project = CString::new(identity.project_digest).expect("validated ASCII digest");
        for component in [
            c"state",
            c"projects",
            project.as_c_str(),
            c"sessions",
            key.as_c_str(),
        ] {
            directory = directory_at(directory.as_raw_fd(), component, true, expires)?;
            safe_directory(directory.as_raw_fd())?;
        }
        deadline(expires)?;
        Ok(Self { directory })
    }

    pub fn charge(&self, expires: Instant) -> Result<Charge, Unavailable> {
        let _lock = self.lock(expires)?;
        let previous = self.read(expires)?;
        let (next, result) = if previous.count >= 3 {
            (0, Charge::Release)
        } else {
            (previous.count + 1, Charge::Refuse)
        };
        self.replace(next, previous.inode, expires)?;
        Ok(result)
    }

    /// Call only after successful nonblocking native handoff, never for a guard refusal.
    pub fn reset(&self, expires: Instant) -> Result<(), Unavailable> {
        let _lock = self.lock(expires)?;
        let previous = self.read(expires)?;
        if previous.count != 0 {
            self.replace(0, previous.inode, expires)?;
        }
        Ok(())
    }

    fn lock(&self, expires: Instant) -> Result<OwnedFd, Unavailable> {
        deadline(expires)?;
        safe_directory(self.directory.as_raw_fd())?;
        let flags = libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
        // Darwin can return ENOENT to simultaneous nonexclusive O_CREAT opens.
        // Exclusive creation selects one creator; contenders open the existing
        // stable lock inode. No counter transaction is replayed.
        let mut raw = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                LOCK.as_ptr(),
                flags | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        let created = raw >= 0;
        if raw < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EEXIST) {
                raw = unsafe { libc::openat(self.directory.as_raw_fd(), LOCK.as_ptr(), flags) };
            } else {
                return Err(Unavailable::with_source("open transaction lock", error));
            }
        }
        let lock = fd(raw, "open transaction lock")?;
        if created && unsafe { libc::fchmod(lock.as_raw_fd(), 0o600) } != 0 {
            return Err(Unavailable::io("set private lock permissions"));
        }
        safe_file(lock.as_raw_fd())?;
        loop {
            deadline(expires)?;
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if !matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) {
                return Err(Unavailable::io("acquire transaction lock"));
            }
            thread::sleep(
                Duration::from_millis(2).min(expires.saturating_duration_since(Instant::now())),
            );
        }
        safe_file(lock.as_raw_fd())?;
        if metadata(lock.as_raw_fd())?.st_size != 0
            || !same_name(self.directory.as_raw_fd(), LOCK, lock.as_raw_fd())
        {
            return Err(Unavailable::new(
                UnavailableKind::UnsafePath,
                "transaction lock is not the stable empty lock inode",
            ));
        }
        Ok(lock)
    }

    fn read(&self, expires: Instant) -> Result<Observed, Unavailable> {
        deadline(expires)?;
        let raw = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                COUNTER.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if raw < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            return Ok(Observed {
                count: 0,
                inode: None,
            });
        }
        let file = fd(raw, "open budget counter")?;
        let value = safe_file(file.as_raw_fd())?;
        read_opened_counter(&mut File::from(file), value, expires)
    }

    fn replace(
        &self,
        count: u8,
        previous: Option<Inode>,
        expires: Instant,
    ) -> Result<(), Unavailable> {
        deadline(expires)?;
        let mut temporary = Temporary::create(self.directory.as_raw_fd(), expires)?;
        let mut bytes = serde_json::to_vec(&Counter {
            consecutive_undeliverable: count,
        })
        .map_err(|_| Unavailable::new(UnavailableKind::Corrupt, "encode budget counter"))?;
        bytes.push(b'\n');
        write_bytes(&mut temporary.file, &bytes, expires)?;
        safe_file(temporary.file.as_raw_fd())?;
        if !same_name(
            self.directory.as_raw_fd(),
            &temporary.name,
            temporary.file.as_raw_fd(),
        ) {
            return Err(Unavailable::new(
                UnavailableKind::UnsafePath,
                "private temporary name was replaced",
            ));
        }
        if self.read(expires)?.inode != previous {
            return Err(Unavailable::new(
                UnavailableKind::UnsafePath,
                "counter changed outside locked transaction",
            ));
        }
        deadline(expires)?;
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                temporary.name.as_ptr(),
                self.directory.as_raw_fd(),
                COUNTER.as_ptr(),
            )
        } != 0
        {
            return Err(Unavailable::io("replace budget counter atomically"));
        }
        temporary.renamed = true;
        // A late syscall can already have committed. Never retry an unavailable
        // transaction, and never claim that the deadline interrupted the kernel.
        deadline(expires)
    }
}

struct Temporary {
    parent: RawFd,
    name: CString,
    file: File,
    renamed: bool,
}
impl Temporary {
    fn create(parent: RawFd, expires: Instant) -> Result<Self, Unavailable> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| {
                Unavailable::new(
                    UnavailableKind::Io,
                    "clock unavailable for private temporary",
                )
            })?
            .as_nanos();
        for attempt in 0..16 {
            deadline(expires)?;
            let name = CString::new(format!(
                ".stop-undeliverable.{}.{stamp}.{attempt}.tmp",
                std::process::id()
            ))
            .expect("numeric temporary name");
            if let Some(value) = Self::candidate(parent, name, expires)? {
                return Ok(value);
            }
        }
        Err(Unavailable::new(
            UnavailableKind::Io,
            "exclusive temporary names exhausted",
        ))
    }

    fn candidate(
        parent: RawFd,
        name: CString,
        expires: Instant,
    ) -> Result<Option<Self>, Unavailable> {
        deadline(expires)?;
        let raw = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if raw < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            return Ok(None);
        }
        let value = Self {
            parent,
            name,
            file: File::from(fd(raw, "create exclusive budget temporary")?),
            renamed: false,
        };
        if unsafe { libc::fchmod(value.file.as_raw_fd(), 0o600) } != 0 {
            return Err(Unavailable::io("set private temporary permissions"));
        }
        deadline(expires)?;
        Ok(Some(value))
    }
}

fn read_opened_counter(
    reader: &mut impl Read,
    value: libc::stat,
    expires: Instant,
) -> Result<Observed, Unavailable> {
    deadline(expires)?;
    if value.st_size < 0 || value.st_size as u64 > MAX_COUNTER_BYTES as u64 {
        return Err(Unavailable::new(
            UnavailableKind::Corrupt,
            "counter exceeds byte budget",
        ));
    }
    // One sentinel byte distinguishes a complete allowed file from a file that
    // grew after fstat. Total reads are bounded, not just the accumulated Vec.
    let mut bounded = reader.take((MAX_COUNTER_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    loop {
        deadline(expires)?;
        let mut buffer = [0_u8; 256];
        let count = bounded
            .read(&mut buffer)
            .map_err(|error| Unavailable::with_source("read budget counter", error))?;
        deadline(expires)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_COUNTER_BYTES {
            return Err(Unavailable::new(
                UnavailableKind::Corrupt,
                "counter exceeds byte budget",
            ));
        }
    }
    let counter: Counter = serde_json::from_slice(&bytes).map_err(|_| {
        Unavailable::new(
            UnavailableKind::Corrupt,
            "counter is not valid bounded JSON",
        )
    })?;
    if counter.consecutive_undeliverable > 3 {
        return Err(Unavailable::new(
            UnavailableKind::Corrupt,
            "counter value exceeds failure budget",
        ));
    }
    Ok(Observed {
        count: counter.consecutive_undeliverable,
        inode: Some(Inode {
            device: value.st_dev,
            inode: value.st_ino,
        }),
    })
}

fn write_bytes(writer: &mut impl Write, bytes: &[u8], expires: Instant) -> Result<(), Unavailable> {
    let mut remaining = bytes;
    while !remaining.is_empty() {
        deadline(expires)?;
        let written = writer
            .write(remaining)
            .map_err(|error| Unavailable::with_source("write private budget temporary", error))?;
        deadline(expires)?;
        if written == 0 {
            return Err(Unavailable::new(
                UnavailableKind::Io,
                "private budget write made no progress",
            ));
        }
        remaining = &remaining[written..];
    }
    Ok(())
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.renamed && same_name(self.parent, &self.name, self.file.as_raw_fd()) {
            // Remove only the name we successfully created with O_EXCL.
            unsafe {
                libc::unlinkat(self.parent, self.name.as_ptr(), 0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt, symlink},
        sync::{Arc, Barrier},
    };

    const PROJECT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Fixture {
        root: std::path::PathBuf,
        home: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            // Resolve only the test harness's temp root (/var and /tmp can be
            // symlinks on macOS). Production deliberately never does this.
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = base.join(format!("caws-stop-budget-{}-{stamp}", std::process::id()));
            fs::create_dir(&root).unwrap();
            let home = root.join("home");
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            Self { root, home }
        }
        fn budget(&self, session: &str) -> StopBudget {
            StopBudget::open(
                &self.home,
                BudgetIdentity::resolve(Some(session), Some(PROJECT)).unwrap(),
                soon(),
            )
            .unwrap()
        }
        fn directory(&self, session: &str) -> std::path::PathBuf {
            self.home
                .join("state/projects")
                .join(PROJECT)
                .join("sessions")
                .join(
                    BudgetIdentity::resolve(Some(session), Some(PROJECT))
                        .unwrap()
                        .session,
                )
        }
        fn counter(&self, session: &str) -> std::path::PathBuf {
            self.directory(session).join("stop-undeliverable.json")
        }
        fn count(&self, session: &str) -> u8 {
            serde_json::from_slice::<Counter>(&fs::read(self.counter(session)).unwrap())
                .unwrap()
                .consecutive_undeliverable
        }
        fn put(&self, session: &str, bytes: &[u8]) {
            fs::write(self.counter(session), bytes).unwrap();
            fs::set_permissions(self.counter(session), fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(3)
    }
    fn kind<T>(result: Result<T, Unavailable>, expected: UnavailableKind) {
        match result {
            Err(error) => assert_eq!(error.kind, expected, "{error}"),
            Ok(_) => panic!("expected unavailable {expected:?}"),
        }
    }

    #[test]
    fn session_directory_encoding_preserves_bytes_and_filename_bounds() {
        for (source, expected) in [
            ("f", "my"),
            ("fo", "mzxq"),
            ("foo", "mzxw6"),
            ("foob", "mzxw6yq"),
            ("fooba", "mzxw6ytb"),
            ("foobar", "mzxw6ytboi"),
            ("CaseA", "inqxgzkb"),
            ("casea", "mnqxgzlb"),
        ] {
            assert_eq!(session_directory(source), format!("sid-{expected}"));
        }
        let longest = "x".repeat(128);
        let key = session_directory(&longest);
        assert_eq!(key.len(), 209);
        assert!(
            key.bytes()
                .all(|byte| byte.is_ascii_lowercase() || b"-234567".contains(&byte))
        );
        let fixture = Fixture::new();
        assert_eq!(
            fixture.budget(&longest).charge(soon()).unwrap(),
            Charge::Refuse
        );
        assert_eq!(fixture.count(&longest), 1);
    }

    #[test]
    fn mixed_case_session_ids_do_not_share_or_reset_counters() {
        let upper = BudgetIdentity::resolve(Some("CaseA"), Some(PROJECT)).unwrap();
        let lower = BudgetIdentity::resolve(Some("casea"), Some(PROJECT)).unwrap();
        assert_ne!(
            upper.session.to_ascii_lowercase(),
            lower.session.to_ascii_lowercase(),
            "session directory keys must remain distinct on case-insensitive filesystems"
        );
        let fixture = Fixture::new();
        let a = fixture.budget("CaseA");
        let b = fixture.budget("casea");
        assert_eq!(a.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(a.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(b.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(fixture.count("CaseA"), 2);
        assert_eq!(fixture.count("casea"), 1);
        b.reset(soon()).unwrap();
        assert_eq!(fixture.count("CaseA"), 2);
        assert_eq!(fixture.count("casea"), 0);
        let a_stat = fs::metadata(fixture.directory("CaseA")).unwrap();
        let b_stat = fs::metadata(fixture.directory("casea")).unwrap();
        assert_ne!((a_stat.dev(), a_stat.ino()), (b_stat.dev(), b_stat.ino()));
    }

    #[test]
    fn charge_sequence_release_reset_and_explicit_handoff_reset() {
        let fixture = Fixture::new();
        let budget = fixture.budget("session-a");
        let outcomes: Vec<_> = (0..4).map(|_| budget.charge(soon()).unwrap()).collect();
        assert_eq!(
            outcomes,
            [
                Charge::Refuse,
                Charge::Refuse,
                Charge::Refuse,
                Charge::Release
            ]
        );
        assert_eq!(fixture.count("session-a"), 0);
        assert_eq!(budget.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(fixture.count("session-a"), 1);
        budget.reset(soon()).unwrap();
        assert_eq!(fixture.count("session-a"), 0);
        assert_eq!(budget.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(
            fs::metadata(fixture.counter("session-a")).unwrap().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::read_dir(fixture.directory("session-a"))
                .unwrap()
                .count(),
            2,
            "only counter and persistent lock remain"
        );
    }

    #[test]
    fn project_digest_is_required_even_with_valid_session_and_unsafe_sessions_are_project_local() {
        for sid in [
            None,
            Some("safe-session"),
            Some(""),
            Some(".."),
            Some("a/b"),
            Some("bad\nidentity"),
            Some("雪"),
        ] {
            kind(
                BudgetIdentity::resolve(sid, None),
                UnavailableKind::Identity,
            );
        }
        kind(
            BudgetIdentity::resolve(Some("safe"), Some(&"A".repeat(64))),
            UnavailableKind::Identity,
        );
        let identity = BudgetIdentity::resolve(Some("safe-_.@colon:1"), Some(PROJECT)).unwrap();
        assert_eq!(identity.session, "sid-onqwmzjnl4xeay3pnrxw4orr");
        assert_eq!(identity.project_digest, PROJECT);
        let fixture = Fixture::new();
        for sid in [None, Some("../unsafe"), Some(&"x".repeat(129))] {
            let identity = BudgetIdentity::resolve(sid, Some(PROJECT)).unwrap();
            assert_eq!(identity.session, "unkeyed");
            let budget = StopBudget::open(&fixture.home, identity, soon()).unwrap();
            budget.charge(soon()).unwrap();
        }
        let fallback_path = fixture
            .home
            .join("state/projects")
            .join(PROJECT)
            .join("sessions/unkeyed/stop-undeliverable.json");
        let fallback: Counter = serde_json::from_slice(&fs::read(&fallback_path).unwrap()).unwrap();
        assert_eq!(fallback.consecutive_undeliverable, 3);
        fixture.budget("unkeyed").charge(soon()).unwrap();
        assert_eq!(fixture.count("unkeyed"), 1);
        let preserved: Counter = serde_json::from_slice(&fs::read(fallback_path).unwrap()).unwrap();
        assert_eq!(preserved.consecutive_undeliverable, 3);
    }

    #[test]
    fn same_session_in_different_projects_has_independent_concurrent_transactions() {
        let fixture = Fixture::new();
        let projects = [PROJECT.to_string(), "b".repeat(64)];
        let budgets: Vec<_> = projects
            .iter()
            .map(|digest| {
                Arc::new(
                    StopBudget::open(
                        &fixture.home,
                        BudgetIdentity::resolve(Some("same-session"), Some(digest)).unwrap(),
                        soon(),
                    )
                    .unwrap(),
                )
            })
            .collect();
        let barrier = Arc::new(Barrier::new(16));
        let workers: Vec<_> = (0..16)
            .map(|index| {
                let budget = Arc::clone(&budgets[index % 2]);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    (index % 2, budget.charge(soon()))
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let results: Vec<_> = results
            .into_iter()
            .map(|(project, result)| (project, result.unwrap()))
            .collect();
        for (index, digest) in projects.iter().enumerate() {
            assert_eq!(
                results
                    .iter()
                    .filter(|&&(project, result)| project == index && result == Charge::Release)
                    .count(),
                2
            );
            assert_eq!(
                results
                    .iter()
                    .filter(|&&(project, result)| project == index && result == Charge::Refuse)
                    .count(),
                6
            );
            let path = fixture
                .home
                .join("state/projects")
                .join(digest)
                .join("sessions/sid-onqw2zjnonsxg43jn5xa/stop-undeliverable.json");
            let counter: Counter = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(counter.consecutive_undeliverable, 0);
        }
        budgets[0].charge(soon()).unwrap();
        assert_eq!(fixture.count("same-session"), 1);
        let other: Counter = serde_json::from_slice(
            &fs::read(
                fixture
                    .home
                    .join("state/projects")
                    .join(&projects[1])
                    .join("sessions/sid-onqw2zjnonsxg43jn5xa/stop-undeliverable.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(other.consecutive_undeliverable, 0);
    }

    #[test]
    fn legacy_global_session_counter_is_never_imported_or_modified() {
        let fixture = Fixture::new();
        let legacy = fixture.home.join("state/sessions/same-session");
        fs::create_dir_all(&legacy).unwrap();
        let path = legacy.join("stop-undeliverable.json");
        let bytes = b"{\"consecutive_undeliverable\":3}";
        fs::write(&path, bytes).unwrap();
        let budget = fixture.budget("same-session");
        assert_eq!(budget.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(fixture.count("same-session"), 1);
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn concurrent_transactions_have_no_lost_charges_or_partial_visible_json() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let fixture = Fixture::new();
        let budget = Arc::new(fixture.budget("concurrent"));
        fixture.put("concurrent", br#"{"consecutive_undeliverable":0}"#);
        let barrier = Arc::new(Barrier::new(17));
        let done = Arc::new(AtomicBool::new(false));
        let reader_barrier = Arc::clone(&barrier);
        let reader_done = Arc::clone(&done);
        let path = fixture.counter("concurrent");
        let reader = thread::spawn(move || {
            let initial: Counter = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(initial.consecutive_undeliverable, 0);
            reader_barrier.wait();
            let mut observations = 0;
            loop {
                let current: Counter = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                assert!(current.consecutive_undeliverable <= 3);
                observations += 1;
                if reader_done.load(Ordering::Acquire) {
                    return observations;
                }
                thread::yield_now();
            }
        });
        let workers: Vec<_> = (0..16)
            .map(|_| {
                let budget = Arc::clone(&budget);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    budget.charge(soon())
                })
            })
            .collect();
        // Join every writer before asserting its result, so a failed assertion
        // cannot remove the fixture while other transactions are active.
        let outcomes: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        done.store(true, Ordering::Release);
        assert!(reader.join().unwrap() > 0);
        let outcomes: Vec<_> = outcomes.into_iter().map(|result| result.unwrap()).collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|&&result| result == Charge::Release)
                .count(),
            4
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|&&result| result == Charge::Refuse)
                .count(),
            12
        );
        assert_eq!(fixture.count("concurrent"), 0);
        assert_eq!(
            fs::read_dir(fixture.directory("concurrent"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn simultaneous_first_lock_creation_is_available_in_each_fresh_session() {
        let fixture = Fixture::new();
        for round in 0..4 {
            let sid = format!("fresh-{round}");
            let budget = Arc::new(fixture.budget(&sid));
            let barrier = Arc::new(Barrier::new(16));
            let workers: Vec<_> = (0..16)
                .map(|_| {
                    let budget = Arc::clone(&budget);
                    let barrier = Arc::clone(&barrier);
                    thread::spawn(move || {
                        barrier.wait();
                        budget.charge(soon())
                    })
                })
                .collect();
            let results: Vec<_> = workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect();
            let outcomes: Vec<_> = results.into_iter().map(|result| result.unwrap()).collect();
            assert_eq!(
                outcomes
                    .iter()
                    .filter(|&&result| result == Charge::Release)
                    .count(),
                4
            );
            assert_eq!(fixture.count(&sid), 0);
        }
    }

    #[test]
    fn legacy_owned_0644_counter_is_read_but_replacement_is_private() {
        let fixture = Fixture::new();
        let budget = fixture.budget("legacy");
        fixture.put("legacy", br#"{"consecutive_undeliverable":2}"#);
        fs::set_permissions(fixture.counter("legacy"), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(budget.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(fixture.count("legacy"), 3);
        assert_eq!(
            fs::metadata(fixture.counter("legacy")).unwrap().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn corruption_is_unavailable_and_preserves_original_bytes() {
        let fixture = Fixture::new();
        let budget = fixture.budget("corrupt");
        for bytes in [
            b"".to_vec(),
            b"{bad".to_vec(),
            b"[]".to_vec(),
            b"{}".to_vec(),
            br#"{"consecutive_undeliverable":true}"#.to_vec(),
            br#"{"consecutive_undeliverable":-1}"#.to_vec(),
            br#"{"consecutive_undeliverable":4}"#.to_vec(),
            br#"{"consecutive_undeliverable":1,"unknown":1}"#.to_vec(),
            vec![b' '; 1025],
        ] {
            fixture.put("corrupt", &bytes);
            kind(budget.charge(soon()), UnavailableKind::Corrupt);
            kind(budget.reset(soon()), UnavailableKind::Corrupt);
            assert_eq!(fs::read(fixture.counter("corrupt")).unwrap(), bytes);
        }
    }

    #[test]
    fn symlink_and_hardlink_targets_never_write_outside() {
        let fixture = Fixture::new();
        let budget = fixture.budget("attack");
        let outside = fixture.root.join("outside");
        fs::write(&outside, b"outside original").unwrap();
        symlink(&outside, fixture.counter("attack")).unwrap();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        fs::remove_file(fixture.counter("attack")).unwrap();
        fs::hard_link(&outside, fixture.counter("attack")).unwrap();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        fs::remove_file(fixture.counter("attack")).unwrap();
        let lock = fixture.directory("attack").join(".stop-undeliverable.lock");
        fs::remove_file(&lock).unwrap();
        symlink(&outside, &lock).unwrap();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        fs::remove_file(&lock).unwrap();
        fs::hard_link(&outside, &lock).unwrap();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        assert_eq!(fs::read(&outside).unwrap(), b"outside original");
        assert!(!fixture.counter("attack").exists());
    }

    #[test]
    fn symlink_directories_and_unsafe_directory_modes_are_unavailable() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, fixture.home.join("state")).unwrap();
        kind(
            StopBudget::open(
                &fixture.home,
                BudgetIdentity::resolve(Some("attack"), Some(PROJECT)).unwrap(),
                soon(),
            ),
            UnavailableKind::UnsafePath,
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_file(fixture.home.join("state")).unwrap();
        let _budget = fixture.budget("attack");
        fs::set_permissions(
            fixture.home.join("state"),
            fs::Permissions::from_mode(0o777),
        )
        .unwrap();
        kind(
            StopBudget::open(
                &fixture.home,
                BudgetIdentity::resolve(Some("attack"), Some(PROJECT)).unwrap(),
                soon(),
            ),
            UnavailableKind::UnsafePath,
        );
        kind(
            StopBudget::open(
                Path::new("relative"),
                BudgetIdentity::resolve(Some("attack"), Some(PROJECT)).unwrap(),
                soon(),
            ),
            UnavailableKind::UnsafePath,
        );
        let linked_home = fixture.root.join("linked-home");
        symlink(&fixture.home, &linked_home).unwrap();
        kind(
            StopBudget::open(
                &linked_home,
                BudgetIdentity::resolve(Some("attack"), Some(PROJECT)).unwrap(),
                soon(),
            ),
            UnavailableKind::UnsafePath,
        );
    }

    #[test]
    fn fifo_and_shared_writable_counter_fail_without_blocking() {
        let fixture = Fixture::new();
        let budget = fixture.budget("permissions");
        let counter = CString::new(fixture.counter("permissions").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(counter.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        assert!(started.elapsed() < Duration::from_millis(500));
        fs::remove_file(fixture.counter("permissions")).unwrap();
        fixture.put("permissions", br#"{"consecutive_undeliverable":1}"#);
        fs::set_permissions(
            fixture.counter("permissions"),
            fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        fs::set_permissions(
            fixture.counter("permissions"),
            fs::Permissions::from_mode(0o400),
        )
        .unwrap();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
    }

    #[test]
    fn held_lock_deadline_does_not_consume_a_charge() {
        let fixture = Fixture::new();
        let budget = fixture.budget("lock");
        budget.charge(soon()).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(fixture.directory("lock").join(".stop-undeliverable.lock"))
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let started = Instant::now();
        kind(
            budget.charge(started + Duration::from_millis(60)),
            UnavailableKind::Deadline,
        );
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(started.elapsed() < Duration::from_millis(300));
        assert_eq!(fixture.count("lock"), 1);
        drop(lock);
        budget.charge(soon()).unwrap();
        assert_eq!(fixture.count("lock"), 2);
        kind(budget.reset(Instant::now()), UnavailableKind::Deadline);
        assert_eq!(fixture.count("lock"), 2);
    }

    #[test]
    fn anchored_directory_does_not_follow_a_replaced_session_path() {
        let fixture = Fixture::new();
        let budget = fixture.budget("anchored");
        let original = fixture.directory("anchored");
        let retained = fixture.home.join("retained-session");
        fs::rename(&original, &retained).unwrap();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("stop-undeliverable.json"), b"outside original").unwrap();
        symlink(&outside, &original).unwrap();
        assert_eq!(budget.charge(soon()).unwrap(), Charge::Refuse);
        assert_eq!(
            fs::read(outside.join("stop-undeliverable.json")).unwrap(),
            b"outside original"
        );
        assert!(retained.join("stop-undeliverable.json").is_file());
    }

    #[test]
    fn temporary_cleanup_removes_only_the_created_inode() {
        let fixture = Fixture::new();
        let budget = fixture.budget("temporary");
        let temporary = Temporary::create(budget.directory.as_raw_fd(), soon()).unwrap();
        let name = fixture
            .directory("temporary")
            .join(std::ffi::OsStr::from_bytes(temporary.name.to_bytes()));
        assert_eq!(fs::metadata(&name).unwrap().mode() & 0o777, 0o600);
        drop(temporary);
        assert!(!name.exists());
        let temporary = Temporary::create(budget.directory.as_raw_fd(), soon()).unwrap();
        let name = fixture
            .directory("temporary")
            .join(std::ffi::OsStr::from_bytes(temporary.name.to_bytes()));
        fs::remove_file(&name).unwrap();
        fs::write(&name, b"replacement belongs to another writer").unwrap();
        drop(temporary);
        assert_eq!(
            fs::read(name).unwrap(),
            b"replacement belongs to another writer"
        );
    }
    #[test]
    fn foreign_owned_regular_file_is_rejected_without_writing() {
        let uid = unsafe { libc::geteuid() };
        if uid == 0 {
            let fixture = Fixture::new();
            let _budget = fixture.budget("foreign");
            fixture.put("foreign", br#"{"consecutive_undeliverable":1}"#);
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(fixture.counter("foreign"))
                .unwrap();
            assert_eq!(unsafe { libc::fchown(file.as_raw_fd(), 1, !0) }, 0);
            kind(safe_file(file.as_raw_fd()), UnavailableKind::UnsafePath);
            assert_eq!(fixture.count("foreign"), 1);
        } else {
            let file = fs::File::open("/etc/passwd").unwrap();
            assert_ne!(file.metadata().unwrap().uid(), uid);
            kind(safe_file(file.as_raw_fd()), UnavailableKind::UnsafePath);
        }
    }

    #[test]
    fn fifo_lock_and_expired_open_are_unavailable_without_creating_counter() {
        let fixture = Fixture::new();
        let budget = fixture.budget("fifo-lock");
        let path = fixture
            .directory("fifo-lock")
            .join(".stop-undeliverable.lock");
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(!fixture.counter("fifo-lock").exists());
        let identity = BudgetIdentity::resolve(Some("not-created"), Some(PROJECT)).unwrap();
        kind(
            StopBudget::open(&fixture.home, identity, Instant::now()),
            UnavailableKind::Deadline,
        );
        assert!(!fixture.directory("not-created").exists());
    }

    #[test]
    fn identity_boundaries_and_error_causes_are_exact() {
        for sid in ["", ".", "..", "slash/name", "space name", "雪"] {
            assert_eq!(
                BudgetIdentity::resolve(Some(sid), Some(PROJECT))
                    .unwrap()
                    .session,
                "unkeyed"
            );
        }
        assert_eq!(
            BudgetIdentity::resolve(Some(&"x".repeat(128)), Some(PROJECT))
                .unwrap()
                .session,
            session_directory(&"x".repeat(128))
        );
        assert_eq!(
            BudgetIdentity::resolve(Some(&"x".repeat(129)), Some(PROJECT))
                .unwrap()
                .session,
            "unkeyed"
        );
        for digest in [
            "".to_owned(),
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
        ] {
            kind(
                BudgetIdentity::resolve(None, Some(&digest)),
                UnavailableKind::Identity,
            );
        }
        let plain = Unavailable::new(UnavailableKind::Deadline, "exact operation");
        assert_eq!(
            plain.to_string(),
            "Stop budget unavailable: exact operation"
        );
        assert!(std::error::Error::source(&plain).is_none());
        let error =
            Unavailable::with_source("read control", io::Error::from_raw_os_error(libc::EIO));
        assert_eq!(error.kind, UnavailableKind::Io);
        assert_eq!(
            std::error::Error::source(&error)
                .unwrap()
                .downcast_ref::<io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(libc::EIO)
        );
        assert!(
            error
                .to_string()
                .starts_with("Stop budget unavailable: read control: ")
        );
        kind::<()>(
            Err(Unavailable::with_source(
                "loop",
                io::Error::from_raw_os_error(libc::ELOOP),
            )),
            UnavailableKind::UnsafePath,
        );
    }

    #[test]
    fn directory_type_and_ownership_fail_independently() {
        let fixture = Fixture::new();
        let path = fixture.root.join("regular-executable");
        fs::write(&path, b"regular").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let file = File::open(path).unwrap();
        kind(
            safe_directory(file.as_raw_fd()),
            UnavailableKind::UnsafePath,
        );
        if unsafe { libc::geteuid() } != 0 {
            let root = filesystem_anchor().unwrap();
            assert_eq!(metadata(root.as_raw_fd()).unwrap().st_mode & 0o777, 0o755);
            kind(
                safe_directory(root.as_raw_fd()),
                UnavailableKind::UnsafePath,
            );
        } else {
            let directory = File::open(&fixture.home).unwrap();
            assert_eq!(unsafe { libc::fchown(directory.as_raw_fd(), 1, !0) }, 0);
            kind(
                safe_directory(directory.as_raw_fd()),
                UnavailableKind::UnsafePath,
            );
            assert_eq!(unsafe { libc::fchown(directory.as_raw_fd(), 0, !0) }, 0);
        }
    }

    fn assert_cloexec(raw: RawFd) {
        assert_ne!(
            unsafe { libc::fcntl(raw, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }

    #[test]
    fn directory_open_preserves_flags_and_does_not_create_missing_home() {
        let fixture = Fixture::new();
        let root = filesystem_anchor().unwrap();
        assert_cloexec(root.as_raw_fd());
        let home = File::open(&fixture.home).unwrap();
        mkdir_if_absent(home.as_raw_fd(), c"existing", soon()).unwrap();
        mkdir_if_absent(home.as_raw_fd(), c"existing", soon()).unwrap();
        let opened = directory_at(home.as_raw_fd(), c"existing", false, soon()).unwrap();
        assert_cloexec(opened.as_raw_fd());
        fs::write(fixture.home.join("regular"), b"ordinary file").unwrap();
        kind(
            directory_at(home.as_raw_fd(), c"regular", false, soon()),
            UnavailableKind::UnsafePath,
        );
        kind(
            directory_at(home.as_raw_fd(), c"missing", false, soon()),
            UnavailableKind::Io,
        );
        assert!(!fixture.home.join("missing").exists());
        let absent = fixture.root.join("absent-home");
        kind(
            StopBudget::open(
                &absent,
                BudgetIdentity::resolve(None, Some(PROJECT)).unwrap(),
                soon(),
            ),
            UnavailableKind::Io,
        );
        assert!(!absent.exists());
        kind(mkdir_if_absent(-1, c"missing", soon()), UnavailableKind::Io);
        kind(
            directory_at(-1, c"missing", true, soon()),
            UnavailableKind::Io,
        );
    }

    #[test]
    fn empty_symlink_lock_is_rejected_before_waiting_on_its_target() {
        let fixture = Fixture::new();
        let budget = fixture.budget("empty-symlink");
        let outside = fixture.root.join("empty-outside");
        let held = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&outside)
            .unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let link = fixture
            .directory("empty-symlink")
            .join(".stop-undeliverable.lock");
        symlink(&outside, &link).unwrap();
        kind(
            budget.charge(Instant::now() + Duration::from_millis(60)),
            UnavailableKind::UnsafePath,
        );
        assert_eq!(fs::metadata(&outside).unwrap().len(), 0);
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
        assert!(!fixture.counter("empty-symlink").exists());
    }

    #[test]
    fn lock_size_and_flags_are_observed_without_other_invalid_predicates() {
        let fixture = Fixture::new();
        let budget = fixture.budget("lock-controls");
        let lock = budget.lock(soon()).unwrap();
        assert_cloexec(lock.as_raw_fd());
        let flags = unsafe { libc::fcntl(lock.as_raw_fd(), libc::F_GETFL) };
        assert_ne!(flags & libc::O_NONBLOCK, 0);
        assert_eq!(flags & libc::O_ACCMODE, libc::O_RDWR);
        drop(lock);
        let path = fixture
            .directory("lock-controls")
            .join(".stop-undeliverable.lock");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        drop(budget.lock(soon()).unwrap());
        assert_eq!(
            fs::metadata(&path).unwrap().mode() & 0o777,
            0o644,
            "a noncreator must not chmod an existing lock"
        );
        fs::write(path, b"nonempty").unwrap();
        kind(budget.charge(soon()), UnavailableKind::UnsafePath);
        assert!(!fixture.counter("lock-controls").exists());
    }

    #[test]
    fn replaced_lock_name_is_rejected_after_a_wait() {
        let fixture = Fixture::new();
        let budget = Arc::new(fixture.budget("replaced-lock"));
        let held = budget.lock(soon()).unwrap();
        let original = metadata(held.as_raw_fd()).unwrap();
        let waiter = Arc::clone(&budget);
        let worker = thread::spawn(move || waiter.charge(soon()));
        let until = soon();
        loop {
            let matches = (0..1024)
                .filter(|raw| {
                    metadata(*raw).is_ok_and(|value| {
                        value.st_dev == original.st_dev && value.st_ino == original.st_ino
                    })
                })
                .count();
            if matches >= 2 {
                break;
            }
            assert!(Instant::now() < until, "waiter never opened held lock");
            thread::yield_now();
        }
        let path = fixture
            .directory("replaced-lock")
            .join(".stop-undeliverable.lock");
        let retained = fixture.directory("replaced-lock").join("retained-lock");
        fs::rename(&path, &retained).unwrap();
        fs::write(&path, b"").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(metadata(held.as_raw_fd()).unwrap().st_nlink, 1);
        drop(held);
        kind(worker.join().unwrap(), UnavailableKind::UnsafePath);
        assert!(!fixture.counter("replaced-lock").exists());
        assert_eq!(fs::read(retained).unwrap(), b"");
    }

    fn padded_counter(length: usize) -> Vec<u8> {
        let mut bytes = br#"{"consecutive_undeliverable":2}"#.to_vec();
        bytes.resize(length, b' ');
        bytes
    }

    #[test]
    fn exact_counter_limit_and_post_stat_growth_are_bounded() {
        let fixture = Fixture::new();
        let budget = fixture.budget("limits");
        fixture.put("limits", &padded_counter(1024));
        assert_eq!(budget.read(soon()).unwrap().count, 2);
        fixture.put("limits", &padded_counter(1025));
        kind(budget.read(soon()), UnavailableKind::Corrupt);
        let mut opened = File::open(fixture.counter("limits")).unwrap();
        let oversized = metadata(opened.as_raw_fd()).unwrap();
        fixture.put("limits", &padded_counter(64));
        kind(
            read_opened_counter(&mut opened, oversized, soon()),
            UnavailableKind::Corrupt,
        );
        fixture.put("limits", b"");
        let mut opened = File::open(fixture.counter("limits")).unwrap();
        let empty = metadata(opened.as_raw_fd()).unwrap();
        fixture.put("limits", &padded_counter(1024));
        assert_eq!(
            read_opened_counter(&mut opened, empty, soon())
                .unwrap()
                .count,
            2
        );
        let mut opened = File::open(fixture.counter("limits")).unwrap();
        fixture.put("limits", &padded_counter(1025));
        kind(
            read_opened_counter(&mut opened, empty, soon()),
            UnavailableKind::Corrupt,
        );
        let mut invalid = padded_counter(1024);
        invalid[1023] = b'x';
        fixture.put("limits", &invalid);
        kind(budget.read(soon()), UnavailableKind::Corrupt);
        assert_eq!(fs::read(fixture.counter("limits")).unwrap(), invalid);
    }

    #[test]
    fn reader_deadline_errors_and_negative_size_are_typed() {
        struct SlowRead;
        impl Read for SlowRead {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                thread::sleep(Duration::from_millis(20));
                Ok(0)
            }
        }
        struct FailedRead;
        impl Read for FailedRead {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::from_raw_os_error(libc::EIO))
            }
        }
        let fixture = Fixture::new();
        let _budget = fixture.budget("read-errors");
        fixture.put("read-errors", b"");
        let file = File::open(fixture.counter("read-errors")).unwrap();
        let value = metadata(file.as_raw_fd()).unwrap();
        kind(
            read_opened_counter(
                &mut SlowRead,
                value,
                Instant::now() + Duration::from_millis(10),
            ),
            UnavailableKind::Deadline,
        );
        kind(
            read_opened_counter(&mut FailedRead, value, soon()),
            UnavailableKind::Io,
        );
        let mut negative = value;
        negative.st_size = -1;
        kind(
            read_opened_counter(&mut io::Cursor::new(padded_counter(64)), negative, soon()),
            UnavailableKind::Corrupt,
        );
    }

    #[test]
    fn partial_writes_preserve_bytes_and_zero_errors_and_late_writes_fail() {
        struct Partial {
            bytes: Vec<u8>,
            calls: usize,
            stop: Option<usize>,
            slow: bool,
        }
        impl Write for Partial {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.calls += 1;
                if self.slow {
                    thread::sleep(Duration::from_millis(20));
                }
                if self.stop == Some(self.calls) {
                    return Ok(0);
                }
                if self.stop == Some(0) {
                    return Err(io::Error::from_raw_os_error(libc::ENOSPC));
                }
                let count = bytes.len().min(2);
                self.bytes.extend_from_slice(&bytes[..count]);
                Ok(count)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut writer = Partial {
            bytes: vec![],
            calls: 0,
            stop: None,
            slow: false,
        };
        write_bytes(&mut writer, b"exact-byte-control", soon()).unwrap();
        assert_eq!(writer.bytes, b"exact-byte-control");
        assert_eq!(writer.calls, 9);
        writer.bytes.clear();
        writer.calls = 0;
        writer.stop = Some(2);
        kind(
            write_bytes(&mut writer, b"abcdef", soon()),
            UnavailableKind::Io,
        );
        assert_eq!(writer.bytes, b"ab");
        writer.stop = Some(0);
        kind(
            write_bytes(&mut writer, b"abcdef", soon()),
            UnavailableKind::Io,
        );
        writer.stop = None;
        writer.slow = true;
        kind(
            write_bytes(
                &mut writer,
                b"abcdef",
                Instant::now() + Duration::from_millis(10),
            ),
            UnavailableKind::Deadline,
        );
        writer.slow = false;
        writer.calls = 0;
        kind(
            write_bytes(&mut writer, b"abcdef", Instant::now()),
            UnavailableKind::Deadline,
        );
        assert_eq!(writer.calls, 0);
    }

    #[test]
    fn exclusive_temporary_collision_preserves_existing_inodes_and_errors() {
        let fixture = Fixture::new();
        let budget = fixture.budget("candidate");
        let path = fixture.directory("candidate").join("candidate");
        fs::write(&path, b"existing-owner").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            Temporary::candidate(budget.directory.as_raw_fd(), c"candidate".into(), soon())
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(&path).unwrap(), b"existing-owner");
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
        fs::remove_file(&path).unwrap();
        let outside = fixture.root.join("outside-candidate");
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(
            Temporary::candidate(budget.directory.as_raw_fd(), c"candidate".into(), soon())
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(outside).unwrap(), b"outside");
        let temporary = Temporary::candidate(budget.directory.as_raw_fd(), c"fresh".into(), soon())
            .unwrap()
            .unwrap();
        assert_cloexec(temporary.file.as_raw_fd());
        assert_eq!(
            unsafe { libc::fcntl(temporary.file.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE,
            libc::O_WRONLY
        );
        drop(temporary);
        assert!(!fixture.directory("candidate").join("fresh").exists());
        kind(
            Temporary::candidate(-1, c"bad".into(), soon()),
            UnavailableKind::Io,
        );
        kind(
            Temporary::candidate(
                budget.directory.as_raw_fd(),
                c"expired".into(),
                Instant::now(),
            ),
            UnavailableKind::Deadline,
        );
        assert!(!fixture.directory("candidate").join("expired").exists());
    }

    #[test]
    fn isolated_zero_descriptor_and_restrictive_umask_controls() {
        const MARKER: &str = "CAWS_STOP_BUDGET_LIBRARY_CHILD";
        if std::env::var_os(MARKER).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "stop_budget::tests::isolated_zero_descriptor_and_restrictive_umask_controls",
                    "--test-threads=1",
                ])
                .env(MARKER, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "child: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        // Process-local destructive controls belong only in this library test
        // subprocess. The production CLI exposes no testing mode.
        let fixture = Fixture::new();
        let budget = fixture.budget("isolated");
        assert_eq!(unsafe { libc::close(0) }, 0);
        let zero = fd(
            unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) },
            "fd zero",
        )
        .unwrap();
        assert_eq!(zero.as_raw_fd(), 0);
        drop(zero);
        let zero = filesystem_anchor().unwrap();
        assert_eq!(zero.as_raw_fd(), 0);
        assert_cloexec(zero.as_raw_fd());
        drop(zero);
        let zero = directory_at(budget.directory.as_raw_fd(), c".", false, soon()).unwrap();
        assert_eq!(zero.as_raw_fd(), 0);
        drop(zero);
        let expires = soon();
        let name = c"fd-zero".into();
        // A successful open need not clear errno. Control both operands of the
        // collision predicate: fd0 is valid even when errno still says EEXIST.
        assert_eq!(
            unsafe { libc::mkdirat(budget.directory.as_raw_fd(), c".".as_ptr(), 0o700) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::EEXIST)
        );
        let temporary = Temporary::candidate(budget.directory.as_raw_fd(), name, expires)
            .unwrap()
            .unwrap();
        assert_eq!(temporary.file.as_raw_fd(), 0);
        drop(temporary);
        let old_mask = unsafe { libc::umask(0o777) };
        let charged = budget.charge(soon());
        unsafe {
            libc::umask(old_mask);
        }
        assert_eq!(charged.unwrap(), Charge::Refuse);
        assert_eq!(
            budget.read(soon()).unwrap().count,
            1,
            "counter opens must accept descriptor zero too"
        );
        assert_eq!(
            fs::metadata(fixture.counter("isolated")).unwrap().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(
                fixture
                    .directory("isolated")
                    .join(".stop-undeliverable.lock")
            )
            .unwrap()
            .mode()
                & 0o777,
            0o600
        );
    }
}
