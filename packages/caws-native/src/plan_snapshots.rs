//! Owner-partitioned plan transcript snapshots. Explicit request identity is
//! provenance, never a project-write grant. The caller owns admission and the
//! trusted checkout/home binding. No identity is inferred from PID caches.
//!
//! A stable per-target flock protects an immutable owner claim, independently
//! published pending tickets, and atomic snapshot replacement. Locks are never
//! unlinked or age-stolen. Tickets survive failed publication and are removed
//! only after snapshot file and directory fsync. A crash before acknowledgement
//! permits replay; no aggregate list can consume a concurrent producer's ticket.
//! Same-UID hostile mutation remains outside the cooperative boundary. Named
//! directory/file pins and nofollow I/O refuse observed replacement. Deadlines
//! bound cooperative work, not an uninterruptible kernel syscall.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::{CStr, CString},
    fmt,
    fs::{File, Metadata},
    io::{self, Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

pub const MAX_TRANSCRIPT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PENDING_TICKETS: usize = 128;
const MAX_RECORD_BYTES: usize = 16 * 1024;
const SCHEMA: &str = "caws.plan.snapshot.v1";
static TEMPORARY: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct Context {
    pub home: PathBuf,
    pub legacy_user_home: Option<PathBuf>,
    /// Independently validated checkout, supplied by the caller, not the JSON.
    pub checkout: Option<PathBuf>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub canonical_project: PathBuf,
    pub surface: String,
    pub session_id: String,
    pub transcript_path: PathBuf,
    pub action: Action,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Produce {
        #[serde(rename = "planPath")]
        plan_path: PathBuf,
    },
    Finalize,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub produced: usize,
    pub finalized: usize,
    pub diagnostics: Vec<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Identity,
    UnsafePath,
    OwnerConflict,
    TranscriptChanged,
    Corrupt,
    Limit,
    Deadline,
    Io,
}
#[derive(Debug)]
pub struct SnapshotError {
    pub kind: ErrorKind,
    operation: &'static str,
    source: Option<io::Error>,
}
impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "plan snapshot unavailable: {}", self.operation)?;
        if let Some(source) = &self.source {
            write!(f, ": {source}")?;
        }
        Ok(())
    }
}
impl std::error::Error for SnapshotError {}
impl SnapshotError {
    pub fn operation(&self) -> &'static str {
        self.operation
    }
}
type Result<T> = std::result::Result<T, SnapshotError>;
fn failure(kind: ErrorKind, operation: &'static str) -> SnapshotError {
    SnapshotError {
        kind,
        operation,
        source: None,
    }
}
fn io_failure(operation: &'static str, source: io::Error) -> SnapshotError {
    let kind = if matches!(source.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
        ErrorKind::UnsafePath
    } else {
        ErrorKind::Io
    };
    SnapshotError {
        kind,
        operation,
        source: Some(source),
    }
}
fn require(value: bool, kind: ErrorKind, operation: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(failure(kind, operation))
    }
}
fn deadline(expires: Instant) -> Result<()> {
    require(
        Instant::now() < expires,
        ErrorKind::Deadline,
        "deadline expired; pending state preserved",
    )
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn json(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| failure(ErrorKind::Corrupt, "record serialization"))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn normalized(path: &Path) -> bool {
    path.to_str().is_some_and(|s| {
        s.starts_with('/')
            && s.len() <= 4096
            && !s.chars().any(char::is_control)
            && (s == "/" || !s.ends_with('/'))
            && !s.contains("//")
    }) && path
        .components()
        .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && path
            .to_str()
            .is_some_and(|s| !s.split('/').any(|c| c == "." || c == ".."))
}
fn encoded(name: &str) -> Result<CString> {
    require(
        !name.is_empty() && !name.contains('/') && name != "." && name != "..",
        ErrorKind::UnsafePath,
        "unsafe path component",
    )?;
    CString::new(name).map_err(|_| failure(ErrorKind::UnsafePath, "NUL path component"))
}
fn opened(fd: libc::c_int, operation: &'static str) -> Result<File> {
    if fd < 0 {
        Err(io_failure(operation, io::Error::last_os_error()))
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn metadata(file: &File, directory: bool, private: bool) -> Result<Metadata> {
    let m = file
        .metadata()
        .map_err(|e| io_failure("descriptor metadata", e))?;
    let uid = unsafe { libc::geteuid() };
    let source_owner = m.uid() == uid || m.uid() == 0;
    let source_mode =
        m.mode() & 0o022 == 0 || (m.is_dir() && m.uid() == 0 && m.mode() & 0o1000 != 0);
    require(
        if private {
            m.uid() == uid && m.mode() & 0o7777 == if directory { 0o700 } else { 0o600 }
        } else {
            source_owner && source_mode
        },
        ErrorKind::UnsafePath,
        "owner or mode violates snapshot custody",
    )?;
    require(
        if directory {
            m.is_dir()
        } else {
            m.is_file() && m.nlink() == 1
        },
        ErrorKind::UnsafePath,
        "snapshot custody type or hardlink",
    )?;
    Ok(m)
}
fn child_directory(parent: &File, name: &str, create: bool) -> Result<File> {
    let name = encoded(name)?;
    let mut created = false;
    if create && unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EEXIST) {
            return Err(io_failure("create private directory", e));
        }
    } else if create {
        created = true;
    }
    let file = opened(
        unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        },
        "open directory component",
    )?;
    metadata(&file, true, create)?;
    if created {
        parent
            .sync_all()
            .map_err(|e| io_failure("sync private directory creation", e))?;
    }
    Ok(file)
}
fn directory(path: &Path, private: bool, expires: Instant) -> Result<File> {
    deadline(expires)?;
    require(
        normalized(path),
        ErrorKind::UnsafePath,
        "directory is not normalized absolute",
    )?;
    let mut current = opened(
        unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        },
        "open filesystem root",
    )?;
    for component in path.components() {
        deadline(expires)?;
        if let Component::Normal(name) = component {
            current = child_directory(
                &current,
                name.to_str()
                    .ok_or_else(|| failure(ErrorKind::UnsafePath, "non-UTF8 directory"))?,
                false,
            )?;
        }
    }
    metadata(&current, true, private)?;
    Ok(current)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryIdentity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
}
impl DirectoryIdentity {
    fn of(file: &File) -> Result<Self> {
        let m = file
            .metadata()
            .map_err(|e| io_failure("directory identity", e))?;
        Ok(Self {
            dev: m.dev(),
            ino: m.ino(),
            uid: m.uid(),
            mode: m.mode(),
        })
    }
}
struct PinnedDirectory {
    path: PathBuf,
    file: File,
    identity: DirectoryIdentity,
    private: bool,
}
impl PinnedDirectory {
    fn open(path: PathBuf, private: bool, expires: Instant) -> Result<Self> {
        let file = directory(&path, private, expires)?;
        let identity = DirectoryIdentity::of(&file)?;
        Ok(Self {
            path,
            file,
            identity,
            private,
        })
    }
    fn check(&self, expires: Instant) -> Result<()> {
        require(
            DirectoryIdentity::of(&directory(&self.path, self.private, expires)?)? == self.identity,
            ErrorKind::UnsafePath,
            "named directory custody changed",
        )
    }
}
fn open_child(parent: &File, name: &str, flags: libc::c_int, mode: libc::mode_t) -> Result<File> {
    let name = encoded(name)?;
    opened(
        unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                mode as libc::c_uint,
            )
        },
        "open regular child",
    )
}
fn source(path: &Path, expires: Instant) -> Result<(PinnedDirectory, File)> {
    require(
        normalized(path),
        ErrorKind::UnsafePath,
        "source is not normalized absolute",
    )?;
    let parent = PinnedDirectory::open(
        path.parent()
            .ok_or_else(|| failure(ErrorKind::UnsafePath, "source parent missing"))?
            .to_owned(),
        false,
        expires,
    )?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| failure(ErrorKind::UnsafePath, "source name missing"))?;
    let file = open_child(&parent.file, name, libc::O_RDONLY, 0)?;
    metadata(&file, false, false)?;
    Ok((parent, file))
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptIdentity {
    path: PathBuf,
    dev: u64,
    ino: u64,
}
struct CapturedTranscript {
    identity: TranscriptIdentity,
    bytes: Vec<u8>,
}
fn read_exact_prefix(file: &mut File, count: usize, expires: Instant) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| io_failure("seek transcript", e))?;
    let mut bytes = vec![0; count];
    for chunk in bytes.chunks_mut(65536) {
        deadline(expires)?;
        file.read_exact(chunk)
            .map_err(|e| io_failure("read transcript prefix", e))?;
    }
    Ok(bytes)
}
fn capture_transcript(path: &Path, expires: Instant) -> Result<CapturedTranscript> {
    let (parent, mut file) = source(path, expires)?;
    let before = metadata(&file, false, false)?;
    require(
        before.len() <= MAX_TRANSCRIPT_BYTES as u64,
        ErrorKind::Limit,
        "transcript exceeds byte limit",
    )?;
    let bytes = read_exact_prefix(&mut file, before.len() as usize, expires)?;
    let after = metadata(&file, false, false)?;
    require(
        after.dev() == before.dev() && after.ino() == before.ino() && after.len() >= before.len(),
        ErrorKind::TranscriptChanged,
        "transcript truncated during capture",
    )?;
    require(
        read_exact_prefix(&mut file, bytes.len(), expires)? == bytes,
        ErrorKind::TranscriptChanged,
        "transcript prefix changed during capture",
    )?;
    parent.check(expires)?;
    let (_, named) = source(path, expires)?;
    let named = metadata(&named, false, false)?;
    require(
        (named.dev(), named.ino()) == (before.dev(), before.ino()),
        ErrorKind::TranscriptChanged,
        "named transcript replaced",
    )?;
    Ok(CapturedTranscript {
        identity: TranscriptIdentity {
            path: path.to_owned(),
            dev: before.dev(),
            ino: before.ino(),
        },
        bytes,
    })
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    canonical_project: PathBuf,
    surface: String,
    session_id: String,
}
impl Owner {
    fn key(&self) -> Result<String> {
        Ok(hash(json(self)?))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    schema: String,
    owner: Owner,
    transcript: TranscriptIdentity,
    plan: PathBuf,
    snapshot: PathBuf,
    snapshot_parent: DirectoryIdentity,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ticket {
    schema: String,
    claim: Claim,
    prefix_bytes: u64,
    prefix_sha256: String,
}
impl Ticket {
    fn name(&self) -> Result<String> {
        Ok(format!("{}.json", hash(json(self)?)))
    }
}
fn vendor(surface: &str) -> Option<&'static str> {
    Some(match surface {
        "codex" => ".codex",
        "claude-code" => ".claude",
        "qwen-code" => ".qwen",
        "zcode" => ".zcode",
        "opencode" => ".opencode",
        "kimi-code" => ".kimi-code",
        "dsh" => ".dsh",
        "cursor" => ".cursor",
        "windsurf" => ".windsurf",
        _ => return None,
    })
}
fn validate_request(context: &Context, request: &Request, expires: Instant) -> Result<Owner> {
    require(
        normalized(&request.canonical_project)
            && normalized(&request.transcript_path)
            && vendor(&request.surface).is_some()
            && !request.session_id.is_empty()
            && request.session_id.len() <= 128
            && request.session_id != "unknown"
            && request.session_id != "."
            && request.session_id != ".."
            && request
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b)),
        ErrorKind::Identity,
        "explicit project surface session and transcript required",
    )?;
    let canonical = directory(&request.canonical_project, false, expires)?;
    child_directory(&canonical, ".caws", false)?;
    if let Some(checkout) = &context.checkout {
        directory(checkout, false, expires)?;
    }
    if let Some(home) = &context.legacy_user_home {
        require(
            normalized(home),
            ErrorKind::UnsafePath,
            "legacy user home is not absolute",
        )?;
    }
    Ok(Owner {
        canonical_project: request.canonical_project.clone(),
        surface: request.surface.clone(),
        session_id: request.session_id.clone(),
    })
}
fn snapshot_path(
    context: &Context,
    owner: &Owner,
    plan: &Path,
    expires: Instant,
) -> Result<PathBuf> {
    require(
        normalized(plan) && plan.extension().is_some_and(|s| s == "md"),
        ErrorKind::UnsafePath,
        "plan path is not normalized markdown",
    )?;
    let mut roots = vec![
        owner.canonical_project.join(".caws/plans"),
        owner.canonical_project.join("plans"),
    ];
    if let Some(checkout) = &context.checkout {
        roots.extend([checkout.join(".caws/plans"), checkout.join("plans")]);
    }
    if let Some(home) = &context.legacy_user_home {
        roots.push(
            home.join(vendor(&owner.surface).expect("validated surface"))
                .join("plans"),
        );
    }
    require(
        roots.iter().any(|root| {
            plan.strip_prefix(root)
                .is_ok_and(|tail| tail.components().next().is_some())
        }),
        ErrorKind::UnsafePath,
        "plan is outside explicit project checkout or vendor plan roots",
    )?;
    source(plan, expires)?;
    let stem = plan
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failure(ErrorKind::UnsafePath, "plan basename missing"))?;
    require(
        stem.len() <= 160
            && stem
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b)),
        ErrorKind::UnsafePath,
        "plan basename requires bounded ASCII for filesystem alias safety",
    )?;
    Ok(plan.with_file_name(format!("{stem}.transcript.jsonl")))
}
fn sync(file: &File, expires: Instant) -> Result<()> {
    deadline(expires)?;
    file.sync_all()
        .map_err(|e| io_failure("sync snapshot custody", e))?;
    deadline(expires)
}
fn rename_new(parent: &File, from: &str, to: &str) -> Result<()> {
    let from = encoded(from)?;
    let to = encoded(to)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let result = -1;
    if result == 0 {
        Ok(())
    } else {
        Err(io_failure(
            "publish immutable snapshot record",
            io::Error::last_os_error(),
        ))
    }
}
fn unlink(parent: &File, name: &str) -> Result<()> {
    let name = encoded(name)?;
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(io_failure(
            "unlink acknowledged ticket",
            io::Error::last_os_error(),
        ))
    }
}
fn temporary(parent: &File) -> Result<(String, File)> {
    for _ in 0..16 {
        let name = format!(
            ".tmp-{}-{}",
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        );
        match open_child(
            parent,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        ) {
            Ok(file) => return Ok((name, file)),
            Err(e)
                if e.source
                    .as_ref()
                    .is_some_and(|e| e.raw_os_error() == Some(libc::EEXIST)) =>
            {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(failure(
        ErrorKind::Limit,
        "exclusive temporary collision limit",
    ))
}
fn publish(
    parent: &PinnedDirectory,
    name: &str,
    bytes: &[u8],
    immutable: bool,
    expires: Instant,
) -> Result<()> {
    parent.check(expires)?;
    let (temporary_name, mut file) = temporary(&parent.file)?;
    let result = (|| {
        for chunk in bytes.chunks(65536) {
            deadline(expires)?;
            file.write_all(chunk)
                .map_err(|e| io_failure("write snapshot staging file", e))?;
        }
        sync(&file, expires)?;
        parent.check(expires)?;
        if immutable {
            rename_new(&parent.file, &temporary_name, name)?;
        } else {
            let from = encoded(&temporary_name)?;
            let to = encoded(name)?;
            if unsafe {
                libc::renameat(
                    parent.file.as_raw_fd(),
                    from.as_ptr(),
                    parent.file.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(io_failure(
                    "replace snapshot atomically",
                    io::Error::last_os_error(),
                ));
            }
        }
        sync(&parent.file, expires)?;
        parent.check(expires)
    })();
    if result.is_err() {
        let _ = unlink(&parent.file, &temporary_name);
    }
    result
}
fn read_record<T: for<'de> Deserialize<'de> + Serialize>(
    parent: &File,
    name: &str,
    expires: Instant,
) -> Result<T> {
    deadline(expires)?;
    let mut file = open_child(parent, name, libc::O_RDONLY, 0)?;
    let before = metadata(&file, false, true)?;
    require(
        before.len() <= MAX_RECORD_BYTES as u64,
        ErrorKind::Limit,
        "snapshot record exceeds limit",
    )?;
    let bytes = read_exact_prefix(&mut file, before.len() as usize, expires)?;
    let after = metadata(&file, false, true)?;
    require(
        (
            before.dev(),
            before.ino(),
            before.len(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) == (
            after.dev(),
            after.ino(),
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        ),
        ErrorKind::Corrupt,
        "snapshot record changed during read",
    )?;
    let value: T = serde_json::from_slice(&bytes)
        .map_err(|_| failure(ErrorKind::Corrupt, "malformed snapshot record"))?;
    require(
        json(&value)? == bytes,
        ErrorKind::Corrupt,
        "snapshot record is not canonical typed JSON",
    )?;
    Ok(value)
}
fn missing(error: &SnapshotError) -> bool {
    error
        .source
        .as_ref()
        .is_some_and(|e| e.raw_os_error() == Some(libc::ENOENT))
}
struct Namespace {
    home: PinnedDirectory,
    owner: PinnedDirectory,
    pending: PinnedDirectory,
    targets: PinnedDirectory,
}
fn namespace(context: &Context, owner: &Owner, expires: Instant) -> Result<Namespace> {
    let home = PinnedDirectory::open(context.home.clone(), true, expires)?;
    let mut file = child_directory(&home.file, "state", true)?;
    let mut path = context.home.join("state");
    for name in ["plan-snapshots", "v1"] {
        file = child_directory(&file, name, true)?;
        path.push(name);
    }
    let targets_file = child_directory(&file, "targets", true)?;
    let targets = PinnedDirectory {
        identity: DirectoryIdentity::of(&targets_file)?,
        file: targets_file,
        path: path.join("targets"),
        private: true,
    };
    let owners = child_directory(&file, "owners", true)?;
    let key = owner.key()?;
    let owner_file = child_directory(&owners, &key, true)?;
    let pending_file = child_directory(&owner_file, "pending", true)?;
    let owner = PinnedDirectory {
        identity: DirectoryIdentity::of(&owner_file)?,
        file: owner_file,
        path: path.join("owners").join(&key),
        private: true,
    };
    let pending = PinnedDirectory {
        identity: DirectoryIdentity::of(&pending_file)?,
        file: pending_file,
        path: path.join("owners").join(key).join("pending"),
        private: true,
    };
    home.check(expires)?;
    Ok(Namespace {
        home,
        owner,
        pending,
        targets,
    })
}
fn lock_target(
    namespace: &Namespace,
    snapshot: &Path,
    expires: Instant,
) -> Result<(PinnedDirectory, File)> {
    namespace.home.check(expires)?;
    namespace.targets.check(expires)?;
    let parent = PinnedDirectory::open(
        snapshot
            .parent()
            .ok_or_else(|| failure(ErrorKind::UnsafePath, "snapshot parent missing"))?
            .to_owned(),
        false,
        expires,
    )?;
    let name = snapshot
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| failure(ErrorKind::UnsafePath, "snapshot UTF8"))?;
    require(
        name.is_ascii(),
        ErrorKind::UnsafePath,
        "snapshot basename is not ASCII",
    )?;
    // Directory identity removes path-alias ambiguity; ASCII folding prevents
    // distinct lock inodes for case aliases on case-insensitive filesystems.
    let key = hash(json(&(
        parent.identity.dev,
        parent.identity.ino,
        name.to_ascii_lowercase(),
    ))?);
    let file = child_directory(&namespace.targets.file, &key, true)?;
    let target = PinnedDirectory {
        identity: DirectoryIdentity::of(&file)?,
        file,
        path: namespace.targets.path.join(key),
        private: true,
    };
    let lock = stable_lock(&target, expires)?;
    Ok((target, lock))
}
fn stable_lock(target: &PinnedDirectory, expires: Instant) -> Result<File> {
    target.check(expires)?;
    let lock = open_child(&target.file, ".lock", libc::O_RDWR | libc::O_CREAT, 0o600)?;
    metadata(&lock, false, true)?;
    loop {
        deadline(expires)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            break;
        }
        let e = io::Error::last_os_error();
        if !matches!(
            e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            return Err(io_failure("snapshot target flock", e));
        }
        thread::sleep(
            Duration::from_millis(2).min(expires.saturating_duration_since(Instant::now())),
        );
    }
    target.check(expires)?;
    let named = open_child(&target.file, ".lock", libc::O_RDWR, 0)?;
    let m = metadata(&named, false, true)?;
    let held = metadata(&lock, false, true)?;
    require(
        (m.dev(), m.ino()) == (held.dev(), held.ino()),
        ErrorKind::UnsafePath,
        "stable snapshot lock replaced",
    )?;
    Ok(lock)
}
fn claim_target(target: &PinnedDirectory, expected: &Claim, expires: Instant) -> Result<()> {
    match read_record::<Claim>(&target.file, "owner.json", expires) {
        Ok(existing) => require(
            existing == *expected,
            ErrorKind::OwnerConflict,
            "snapshot destination has another owner; explicit maintenance required",
        ),
        Err(e) if missing(&e) => {
            let parent = PinnedDirectory::open(
                expected
                    .snapshot
                    .parent()
                    .expect("validated snapshot parent")
                    .to_owned(),
                false,
                expires,
            )?;
            require(
                parent.identity == expected.snapshot_parent,
                ErrorKind::UnsafePath,
                "snapshot parent changed before first claim",
            )?;
            let name = encoded(
                expected
                    .snapshot
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| failure(ErrorKind::UnsafePath, "snapshot basename"))?,
            )?;
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    parent.file.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } == 0
            {
                return Err(failure(
                    ErrorKind::OwnerConflict,
                    "preexisting snapshot has no native owner; explicit adoption required",
                ));
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOENT) {
                return Err(io_failure("inspect destination before first claim", error));
            }
            parent.check(expires)?;
            publish(target, "owner.json", &json(expected)?, true, expires)
        }
        Err(e) => Err(e),
    }
}
fn check_existing_snapshot(parent: &File, name: &str, expires: Instant) -> Result<()> {
    deadline(expires)?;
    match open_child(parent, name, libc::O_RDONLY, 0) {
        Ok(file) => {
            metadata(&file, false, false)?;
            Ok(())
        }
        Err(e) if missing(&e) => Ok(()),
        Err(e) => Err(e),
    }
}
fn write_snapshot(claim: &Claim, bytes: &[u8], expires: Instant) -> Result<()> {
    let parent = PinnedDirectory::open(
        claim
            .snapshot
            .parent()
            .expect("validated snapshot parent")
            .to_owned(),
        false,
        expires,
    )?;
    require(
        parent.identity == claim.snapshot_parent,
        ErrorKind::UnsafePath,
        "snapshot parent changed before publication",
    )?;
    let name = claim
        .snapshot
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| failure(ErrorKind::UnsafePath, "snapshot basename"))?;
    check_existing_snapshot(&parent.file, name, expires)?;
    publish(&parent, name, bytes, false, expires)
}
fn legacy_diagnostic(
    context: &Context,
    owner: &Owner,
    outcome: &mut Outcome,
    expires: Instant,
) -> Result<()> {
    let Some(home) = &context.legacy_user_home else {
        return Ok(());
    };
    let root = match directory(home, false, expires) {
        Ok(file) => file,
        Err(e) if missing(&e) => return Ok(()),
        Err(e) => return Err(e),
    };
    let vendor = match child_directory(
        &root,
        vendor(&owner.surface).expect("validated surface"),
        false,
    ) {
        Ok(file) => file,
        Err(e) if missing(&e) => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            vendor.as_raw_fd(),
            c".pending-plan-snapshots".as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == 0
    {
        outcome.diagnostics.push("legacy ownerless pending plan snapshots preserved; explicit provenance migration required".into());
    } else {
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::ENOENT) {
            return Err(io_failure("observe legacy pending list", e));
        }
    }
    Ok(())
}
fn ticket_names(parent: &File, expires: Instant) -> Result<Vec<String>> {
    let duplicate = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if duplicate < 0 {
        return Err(io_failure(
            "open pending enumeration",
            io::Error::last_os_error(),
        ));
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        unsafe { libc::close(duplicate) };
        return Err(io_failure(
            "pending enumeration",
            io::Error::last_os_error(),
        ));
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe { libc::closedir(self.0) };
        }
    }
    let stream = Stream(stream);
    let mut names = BTreeSet::new();
    let mut entries = 0;
    loop {
        deadline(expires)?;
        unsafe { *errno_pointer() = 0 };
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if unsafe { *errno_pointer() } != 0 {
                return Err(io_failure(
                    "pending enumeration interrupted",
                    io::Error::last_os_error(),
                ));
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .map_err(|_| failure(ErrorKind::Corrupt, "pending filename UTF8"))?;
        if name == "." || name == ".." {
            continue;
        }
        entries += 1;
        require(
            entries <= MAX_PENDING_TICKETS * 4,
            ErrorKind::Limit,
            "pending directory entry limit",
        )?;
        if name.starts_with(".tmp-") {
            continue;
        }
        require(
            name.strip_suffix(".json").is_some_and(digest),
            ErrorKind::Corrupt,
            "unexpected pending entry preserved",
        )?;
        require(
            names.len() < MAX_PENDING_TICKETS && names.insert(name.to_owned()),
            ErrorKind::Limit,
            "pending snapshot ticket limit",
        )?;
    }
    Ok(names.into_iter().collect())
}
#[cfg(target_os = "macos")]
fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__error() }
}
#[cfg(not(target_os = "macos"))]
fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}
fn produce(
    context: &Context,
    request: &Request,
    owner: &Owner,
    namespace: &Namespace,
    plan: &Path,
    expires: Instant,
) -> Result<()> {
    let snapshot = snapshot_path(context, owner, plan, expires)?;
    require(
        snapshot != request.transcript_path,
        ErrorKind::UnsafePath,
        "transcript source aliases snapshot destination",
    )?;
    let snapshot_parent = DirectoryIdentity::of(&directory(
        plan.parent().expect("validated plan parent"),
        false,
        expires,
    )?)?;
    let (target, _lock) = lock_target(namespace, &snapshot, expires)?;
    require(
        DirectoryIdentity::of(&directory(
            plan.parent().expect("validated plan parent"),
            false,
            expires,
        )?)? == snapshot_parent,
        ErrorKind::UnsafePath,
        "snapshot parent changed while acquiring target",
    )?;
    let captured = capture_transcript(&request.transcript_path, expires)?;
    match source(&snapshot, expires) {
        Ok((parent, existing)) => {
            let existing = metadata(&existing, false, false)?;
            require(
                (existing.dev(), existing.ino()) != (captured.identity.dev, captured.identity.ino),
                ErrorKind::UnsafePath,
                "transcript inode aliases snapshot destination",
            )?;
            parent.check(expires)?;
        }
        Err(error) if missing(&error) => {}
        Err(error) => return Err(error),
    }
    let claim = Claim {
        schema: SCHEMA.into(),
        owner: owner.clone(),
        transcript: captured.identity,
        plan: plan.to_owned(),
        snapshot,
        snapshot_parent,
    };
    claim_target(&target, &claim, expires)?;
    let ticket = Ticket {
        schema: SCHEMA.into(),
        claim: claim.clone(),
        prefix_bytes: captured.bytes.len() as u64,
        prefix_sha256: hash(&captured.bytes),
    };
    let name = ticket.name()?;
    let owner_lock = stable_lock(&namespace.owner, expires)?;
    let names = ticket_names(&namespace.pending.file, expires)?;
    require(
        names.contains(&name) || names.len() < MAX_PENDING_TICKETS,
        ErrorKind::Limit,
        "pending snapshot ticket limit",
    )?;
    match read_record::<Ticket>(&namespace.pending.file, &name, expires) {
        Ok(existing) => require(
            existing == ticket,
            ErrorKind::Corrupt,
            "ticket key collision",
        )?,
        Err(e) if missing(&e) => {
            publish(&namespace.pending, &name, &json(&ticket)?, true, expires)?
        }
        Err(e) => return Err(e),
    }
    drop(owner_lock);
    // Publish the durable obligation before its initial destination. A crash
    // leaves a recoverable ticket, never an untracked successful snapshot.
    write_snapshot(&claim, &captured.bytes, expires)?;
    target.check(expires)?;
    namespace.home.check(expires)
}
fn finalize(
    context: &Context,
    request: &Request,
    owner: &Owner,
    namespace: &Namespace,
    expires: Instant,
    outcome: &mut Outcome,
) -> Result<()> {
    finalize_with_publication(context, request, owner, namespace, expires, outcome, || {
        Ok(())
    })
}
fn finalize_with_publication(
    context: &Context,
    request: &Request,
    owner: &Owner,
    namespace: &Namespace,
    expires: Instant,
    outcome: &mut Outcome,
    mut after_publication: impl FnMut() -> Result<()>,
) -> Result<()> {
    let names = {
        let _lock = stable_lock(&namespace.owner, expires)?;
        ticket_names(&namespace.pending.file, expires)?
    };
    for name in names {
        let ticket: Ticket = match read_record(&namespace.pending.file, &name, expires) {
            Ok(ticket) => ticket,
            Err(e) if missing(&e) => continue,
            Err(e) => return Err(e),
        };
        require(
            ticket.schema == SCHEMA
                && ticket.claim.schema == SCHEMA
                && ticket.claim.owner == *owner
                && ticket.name()? == name
                && ticket.prefix_bytes <= MAX_TRANSCRIPT_BYTES as u64
                && digest(&ticket.prefix_sha256),
            ErrorKind::Corrupt,
            "pending ticket owner schema or generation mismatch",
        )?;
        require(
            snapshot_path(context, owner, &ticket.claim.plan, expires)? == ticket.claim.snapshot
                && ticket.claim.transcript.path == request.transcript_path,
            ErrorKind::TranscriptChanged,
            "pending ticket path provenance differs",
        )?;
        require(
            DirectoryIdentity::of(&directory(
                ticket
                    .claim
                    .snapshot
                    .parent()
                    .expect("validated snapshot parent"),
                false,
                expires,
            )?)? == ticket.claim.snapshot_parent,
            ErrorKind::UnsafePath,
            "snapshot parent changed since production",
        )?;
        let (target, _lock) = lock_target(namespace, &ticket.claim.snapshot, expires)?;
        // A duplicate finalizer may have acknowledged the listed ticket while
        // this caller waited. Missing is safe only after taking its target lock.
        match read_record::<Ticket>(&namespace.pending.file, &name, expires) {
            Ok(current) => require(
                current == ticket,
                ErrorKind::Corrupt,
                "pending ticket replaced",
            )?,
            Err(e) if missing(&e) => continue,
            Err(e) => return Err(e),
        }
        require(
            read_record::<Claim>(&target.file, "owner.json", expires)? == ticket.claim,
            ErrorKind::OwnerConflict,
            "snapshot destination owner changed; maintenance required",
        )?;
        let captured = capture_transcript(&request.transcript_path, expires)?;
        require(
            captured.identity == ticket.claim.transcript
                && captured.bytes.len() as u64 >= ticket.prefix_bytes
                && hash(&captured.bytes[..ticket.prefix_bytes as usize]) == ticket.prefix_sha256,
            ErrorKind::TranscriptChanged,
            "original transcript replaced truncated or prefix changed",
        )?;
        write_snapshot(&ticket.claim, &captured.bytes, expires)?;
        after_publication()?;
        target.check(expires)?;
        let _owner_lock = stable_lock(&namespace.owner, expires)?;
        namespace.pending.check(expires)?;
        namespace.home.check(expires)?;
        require(
            read_record::<Ticket>(&namespace.pending.file, &name, expires)? == ticket,
            ErrorKind::Corrupt,
            "ticket changed before acknowledgement",
        )?;
        unlink(&namespace.pending.file, &name)?;
        sync(&namespace.pending.file, expires)?;
        outcome.finalized += 1;
    }
    Ok(())
}
/// Perform one admitted operational snapshot action. This function never
/// discovers a caller, acquires governance authority, or consumes legacy lists.
pub fn execute(context: &Context, request: &Request, expires: Instant) -> Result<Outcome> {
    deadline(expires)?;
    let owner = validate_request(context, request, expires)?;
    let mut outcome = Outcome::default();
    legacy_diagnostic(context, &owner, &mut outcome, expires)?;
    let namespace = namespace(context, &owner, expires)?;
    match &request.action {
        Action::Produce { plan_path } => {
            produce(context, request, &owner, &namespace, plan_path, expires)?;
            outcome.produced = 1;
        }
        Action::Finalize => finalize(context, request, &owner, &namespace, expires, &mut outcome)?,
    }
    Ok(outcome)
}

/// Private command entry. All paths and identity arrive explicitly; environment
/// variables and PID correlation records are deliberately not consulted.
fn command_context(args: &[String]) -> std::result::Result<Context, String> {
    let mut home = None;
    let mut checkout = None;
    let mut legacy_user_home = None;
    let mut index = 0;
    let mut seen = BTreeSet::new();
    while index < args.len() {
        let value = args
            .get(index + 1)
            .ok_or_else(|| "plan-snapshots requires option values".to_owned())?;
        if !seen.insert(args[index].as_str()) {
            return Err("plan-snapshots refuses duplicate options".into());
        }
        let slot = match args[index].as_str() {
            "--home" => &mut home,
            "--checkout" => &mut checkout,
            "--legacy-user-home" => &mut legacy_user_home,
            _ => {
                return Err(
                    "plan-snapshots accepts only --home --checkout and --legacy-user-home".into(),
                );
            }
        };
        if args[index] == "--legacy-user-home" && value.is_empty() {
            // An explicitly absent HOME is not a root-level legacy namespace.
            *slot = None;
        } else {
            *slot = Some(PathBuf::from(value));
        }
        index += 2;
    }
    Ok(Context {
        home: home.ok_or_else(|| "plan-snapshots requires --home".to_owned())?,
        checkout: Some(checkout.ok_or_else(|| "plan-snapshots requires --checkout".to_owned())?),
        legacy_user_home,
    })
}
pub fn run(args: &[String]) -> std::result::Result<u8, String> {
    let context = command_context(args)?;
    let expires = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    loop {
        deadline(expires).map_err(|e| e.to_string())?;
        let mut poll = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let remaining = expires
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(100) as libc::c_int;
        let ready = unsafe { libc::poll(&mut poll, 1, remaining) };
        if ready < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io_failure("poll request stdin", e).to_string());
        }
        if ready == 0 {
            continue;
        }
        if poll.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err("plan-snapshots request stdin unavailable".into());
        }
        let mut chunk = [0u8; 4096];
        let count =
            unsafe { libc::read(libc::STDIN_FILENO, chunk.as_mut_ptr().cast(), chunk.len()) };
        if count < 0 {
            let e = io::Error::last_os_error();
            if matches!(
                e.kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                continue;
            }
            return Err(io_failure("read request stdin", e).to_string());
        }
        if count == 0 {
            break;
        }
        if bytes.len() + count as usize > MAX_RECORD_BYTES {
            return Err("plan-snapshots request exceeds byte limit".into());
        }
        bytes.extend_from_slice(&chunk[..count as usize]);
    }
    let request: Request = serde_json::from_slice(&bytes)
        .map_err(|_| "plan-snapshots requires one bounded typed JSON request".to_owned())?;
    let outcome = execute(&context, &request, expires).map_err(|e| e.to_string())?;
    for diagnostic in &outcome.diagnostics {
        eprintln!("[caws plan snapshots] {diagnostic}");
    }
    let mut output = json(&outcome).map_err(|e| e.to_string())?;
    output.push(b'\n');
    deadline(expires).map_err(|e| e.to_string())?;
    io::stdout()
        .write_all(&output)
        .map_err(|e| io_failure("write snapshot outcome", e).to_string())?;
    Ok(0)
}

#[cfg(test)]
#[path = "plan_snapshots/tests.rs"]
mod tests;
