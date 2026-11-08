//! Session-global guard-strike transactions for cooperative current-generation writers.
//!
//! The native owner supplies original HOME/.caws, the original payload session,
//! and native-derived legacy paths. None is selected by a Node control request.
//! Stable sibling flocks cover import, read, mutation, publication and reset audit.
//! Published files and their directory are synced. Kernel filesystem operations
//! cannot be interrupted by a cooperative deadline. Any error after a visible
//! effect is terminal PublicationUncertain: callers must not replay the request.
//! Historical writers that do not use this flock require a separate drain gate.

use crate::monotonic_deadline::MonotonicDeadline;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString},
    fmt,
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const STATE: &CStr = c"strikes.json";
const LOCK: &CStr = c".guard-strikes.lock";
const MARKER: &CStr = c".guard-strikes-imported.json";
const AUDIT: &CStr = c"strike-resets.log";
const AUDIT_LOCK: &CStr = c".strike-resets.lock";
const MAX_BYTES: usize = 65_536;
// One complete bounded state plus metadata: the <=4096-byte home and fixed
// suffix can expand to <=26KiB when JSON escaped; bounded IDs/hashes/keys fit
// inside the remaining 6KiB. Refuse overflow instead of truncating evidence.
const MAX_AUDIT_RECORD_BYTES: usize = MAX_BYTES + 32_768;
pub const MAX_COUNT: u64 = 9_007_199_254_740_991;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Identity,
    UnsafePath,
    Corrupt,
    Overflow,
    Io,
    Deadline,
    Cancelled,
    PublicationUncertain,
}
#[derive(Debug)]
pub struct Error {
    pub kind: ErrorKind,
    pub detail: String,
    /// Known publication identity, if an increment reached the rename boundary.
    pub publication: Option<CommittedStrike>,
    source_errno: Option<i32>,
}
impl Error {
    fn new(kind: ErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
            publication: None,
            source_errno: None,
        }
    }
    fn io(operation: &str) -> Self {
        let error = io::Error::last_os_error();
        Self::source(operation, error)
    }
    fn source(operation: &str, error: io::Error) -> Self {
        let kind = if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
            ErrorKind::UnsafePath
        } else {
            ErrorKind::Io
        };
        let mut result = Self::new(kind, format!("{operation}: {error}"));
        result.source_errno = error.raw_os_error();
        result
    }
    fn uncertain(mut self, publication: Option<CommittedStrike>) -> Self {
        self.detail = format!(
            "publication uncertain; do not replay ({:?}): {}",
            self.kind, self.detail
        );
        self.kind = ErrorKind::PublicationUncertain;
        self.publication = publication;
        self
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "guard strikes {:?}: {}", self.kind, self.detail)
    }
}
impl std::error::Error for Error {}
type Result<T> = std::result::Result<T, Error>;

/// No renewable Instant-only constructor is offered to native callers.
#[derive(Clone, Copy)]
pub struct TransactionBudget<'a> {
    original: &'a MonotonicDeadline,
    until: Instant,
    cancelled: &'a dyn Fn() -> bool,
}
impl<'a> TransactionBudget<'a> {
    pub fn original(
        original: &'a MonotonicDeadline,
        until: Instant,
        cancelled: &'a dyn Fn() -> bool,
    ) -> Self {
        Self {
            original,
            until: until.min(original.expires()),
            cancelled,
        }
    }
    fn check(self) -> Result<()> {
        self.original
            .check()
            .map_err(|e| Error::new(ErrorKind::Deadline, e.to_string()))?;
        if (self.cancelled)() {
            return Err(Error::new(
                ErrorKind::Cancelled,
                "original invocation cancelled",
            ));
        }
        if Instant::now() >= self.until {
            return Err(Error::new(
                ErrorKind::Deadline,
                "original invocation bound expired",
            ));
        }
        Ok(())
    }
}

/// Finite native-cache-compatible ASCII domain. The historical sanitized bucket
/// is retained, including ':'/'@' collisions; its lock belongs to that bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrikeIdentity {
    raw: String,
    safe: String,
}
impl StrikeIdentity {
    pub fn resolve(raw: &str) -> Result<Self> {
        if raw.is_empty()
            || raw.len() > 128
            || matches!(raw, "unknown" | "." | "..")
            || !raw
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.@:-".contains(&c))
        {
            return Err(Error::new(
                ErrorKind::Identity,
                "original session is outside the qualified ASCII domain",
            ));
        }
        let safe = raw
            .bytes()
            .map(|c| {
                if c.is_ascii_alphanumeric() || b"._-".contains(&c) {
                    char::from(c)
                } else {
                    '_'
                }
            })
            .collect();
        Ok(Self {
            raw: raw.into(),
            safe,
        })
    }
    pub fn sanitized(&self) -> &str {
        &self.safe
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedStrike {
    pub count: u64,
    pub state_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetReceipt {
    pub transaction: String,
    pub before_sha256: String,
    pub after_sha256: Option<String>,
}

/// Held physical directory chain. Components are opened without following links;
/// relevant owned descendants and every retained parent/name binding are rechecked.
struct Directory {
    chain: Vec<OwnedFd>,
    names: Vec<CString>,
    owned_from: usize,
}
fn descriptor(raw: RawFd, operation: &str) -> Result<OwnedFd> {
    if raw < 0 {
        Err(Error::io(operation))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    }
}
fn metadata(fd: RawFd) -> Result<libc::stat> {
    let mut value = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(fd, value.as_mut_ptr()) } != 0 {
        return Err(Error::io("inspect descriptor"));
    }
    Ok(unsafe { value.assume_init() })
}
fn owned_directory(fd: RawFd) -> Result<()> {
    let m = metadata(fd)?;
    if m.st_mode & libc::S_IFMT != libc::S_IFDIR
        || m.st_uid != unsafe { libc::geteuid() }
        || m.st_mode & 0o022 != 0
        || m.st_mode & 0o700 != 0o700
    {
        return Err(Error::new(
            ErrorKind::UnsafePath,
            "directory must be owned, owner-accessible and not shared-writable",
        ));
    }
    Ok(())
}
fn owned_file(fd: RawFd) -> Result<libc::stat> {
    let m = metadata(fd)?;
    if m.st_mode & libc::S_IFMT != libc::S_IFREG
        || m.st_uid != unsafe { libc::geteuid() }
        || m.st_nlink != 1
        || m.st_mode & 0o022 != 0
        || m.st_mode & 0o600 != 0o600
    {
        return Err(Error::new(
            ErrorKind::UnsafePath,
            "file must be regular, owned, single-link and not shared-writable",
        ));
    }
    Ok(m)
}
fn named_metadata(parent: RawFd, name: &CStr) -> Result<Option<libc::stat>> {
    let mut m = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            m.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        let e = io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::ENOENT) {
            return Ok(None);
        }
        return Err(Error::source("inspect retained name", e));
    }
    Ok(Some(unsafe { m.assume_init() }))
}
fn same_inode(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev
        && a.st_ino == b.st_ino
        && a.st_mode & libc::S_IFMT == b.st_mode & libc::S_IFMT
}
fn same_name(parent: RawFd, name: &CStr, fd: RawFd) -> Result<bool> {
    Ok(named_metadata(parent, name)?
        .is_some_and(|m| metadata(fd).is_ok_and(|f| same_inode(&m, &f))))
}
impl Directory {
    fn open(path: &Path, budget: TransactionBudget<'_>) -> Result<Self> {
        budget.check()?;
        let raw_path = path.as_os_str().as_bytes();
        if !path.is_absolute()
            || raw_path.len() > 4096
            || raw_path.contains(&0)
            || raw_path
                .split(|b| *b == b'/')
                .skip(1)
                .any(|p| p.is_empty() || p == b"." || p == b"..")
        {
            return Err(Error::new(
                ErrorKind::UnsafePath,
                "directory path must be physical absolute without traversal",
            ));
        }
        let root = descriptor(
            unsafe {
                libc::open(
                    c"/".as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            },
            "open filesystem anchor",
        )?;
        let mut result = Self {
            chain: vec![root],
            names: Vec::new(),
            owned_from: usize::MAX,
        };
        for component in path.components() {
            if let Component::Normal(name) = component {
                result.descend(
                    &CString::new(name.as_bytes())
                        .map_err(|_| Error::new(ErrorKind::UnsafePath, "nul component"))?,
                    false,
                    budget,
                )?;
            }
        }
        result.owned_from = result.chain.len() - 1;
        result.verify(budget)?;
        Ok(result)
    }
    fn fd(&self) -> RawFd {
        self.chain.last().unwrap().as_raw_fd()
    }
    fn descend(&mut self, name: &CStr, create: bool, budget: TransactionBudget<'_>) -> Result<()> {
        budget.check()?;
        let parent = self.fd();
        let flags = libc::O_RDONLY
            | libc::O_DIRECTORY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK;
        let mut raw = unsafe { libc::openat(parent, name.as_ptr(), flags) };
        if raw < 0 && create && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            budget.check()?;
            if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } != 0
                && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
            {
                return Err(Error::io("create strike directory"));
            }
            budget.check()?;
            if unsafe { libc::fsync(parent) } != 0 {
                return Err(Error::io("sync parent after strike directory creation"));
            }
            budget.check()?;
            raw = unsafe { libc::openat(parent, name.as_ptr(), flags) };
        }
        let child = descriptor(raw, "open physical directory component")?;
        self.names.push(name.into());
        self.chain.push(child);
        budget.check()
    }
    fn verify(&self, budget: TransactionBudget<'_>) -> Result<()> {
        budget.check()?;
        for (i, name) in self.names.iter().enumerate() {
            if !same_name(
                self.chain[i].as_raw_fd(),
                name,
                self.chain[i + 1].as_raw_fd(),
            )? {
                return Err(Error::new(
                    ErrorKind::UnsafePath,
                    "retained directory was replaced",
                ));
            }
        }
        for fd in self.chain.iter().skip(self.owned_from) {
            owned_directory(fd.as_raw_fd())?;
        }
        budget.check()
    }
    fn sync(&self, budget: TransactionBudget<'_>) -> Result<()> {
        budget.check()?;
        if unsafe { libc::fsync(self.fd()) } != 0 {
            return Err(Error::io("sync strike directory"));
        }
        budget.check()
    }
    fn lock(&self, name: &CStr, budget: TransactionBudget<'_>) -> Result<OwnedFd> {
        self.verify(budget)?;
        let flags = libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
        let mut raw = unsafe {
            libc::openat(
                self.fd(),
                name.as_ptr(),
                flags | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        if raw < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            raw = unsafe { libc::openat(self.fd(), name.as_ptr(), flags) };
        }
        let lock = descriptor(raw, "open stable transaction lock")?;
        owned_file(lock.as_raw_fd())?;
        loop {
            budget.check()?;
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let e = io::Error::last_os_error();
            if !matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) {
                return Err(Error::source("acquire transaction flock", e));
            }
            thread::sleep(
                Duration::from_millis(2)
                    .min(budget.until.saturating_duration_since(Instant::now())),
            );
        }
        self.verify(budget)?;
        if owned_file(lock.as_raw_fd())?.st_size != 0
            || !same_name(self.fd(), name, lock.as_raw_fd())?
        {
            return Err(Error::new(
                ErrorKind::UnsafePath,
                "stable lock name or inode changed",
            ));
        }
        budget.check()?;
        Ok(lock)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Observation {
    bytes: Vec<u8>,
    device: libc::dev_t,
    inode: libc::ino_t,
}
fn read(
    directory: &Directory,
    name: &CStr,
    budget: TransactionBudget<'_>,
) -> Result<Option<Observation>> {
    directory.verify(budget)?;
    let raw = unsafe {
        libc::openat(
            directory.fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if raw < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        budget.check()?;
        return Ok(None);
    }
    let fd = descriptor(raw, "open strike state")?;
    let before = owned_file(fd.as_raw_fd())?;
    if before.st_size < 0 || before.st_size as u64 > MAX_BYTES as u64 {
        return Err(Error::new(
            ErrorKind::Corrupt,
            "strike state exceeds byte bound",
        ));
    }
    let mut file = File::from(fd);
    let mut bytes = Vec::new();
    let mut bounded = (&mut file).take((MAX_BYTES + 1) as u64);
    loop {
        budget.check()?;
        let mut block = [0u8; 4096];
        let n = bounded
            .read(&mut block)
            .map_err(|e| Error::source("read strike state", e))?;
        budget.check()?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&block[..n]);
        if bytes.len() > MAX_BYTES {
            return Err(Error::new(
                ErrorKind::Corrupt,
                "growing strike state exceeds byte bound",
            ));
        }
    }
    let after = owned_file(file.as_raw_fd())?;
    if !same_inode(&before, &after)
        || before.st_size != after.st_size
        || before.st_mtime != after.st_mtime
        || before.st_ctime != after.st_ctime
        || !same_name(directory.fd(), name, file.as_raw_fd())?
    {
        return Err(Error::new(
            ErrorKind::UnsafePath,
            "strike state changed while observed",
        ));
    }
    Ok(Some(Observation {
        bytes,
        device: before.st_dev,
        inode: before.st_ino,
    }))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// Every nested object rejects duplicate keys rather than silently choosing a
// winner. Other valid JSON values retain their semantic values.
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("duplicate-free JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Number(v.into())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Number(v.into())))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
                Number::from_f64(v)
                    .map(|n| Strict(Value::Number(n)))
                    .ok_or_else(|| E::custom("nonfinite JSON number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::String(v.into())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::String(v)))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> std::result::Result<Strict, E> {
                self.visit_unit()
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut values = Vec::new();
                while let Some(Strict(v)) = seq.next_element()? {
                    values.push(v);
                }
                Ok(Strict(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                    let Strict(v) = map.next_value()?;
                    values.insert(key, v);
                }
                Ok(Strict(Value::Object(values)))
            }
        }
        decoder.deserialize_any(Any)
    }
}
fn object(bytes: &[u8]) -> Result<Map<String, Value>> {
    match serde_json::from_slice::<Strict>(bytes)
        .map_err(|e| Error::new(ErrorKind::Corrupt, format!("invalid strike JSON: {e}")))?
        .0
    {
        Value::Object(value) => Ok(value),
        _ => Err(Error::new(
            ErrorKind::Corrupt,
            "strike JSON must be an object",
        )),
    }
}
fn count(value: Option<&Value>) -> Result<u64> {
    let Some(value) = value else {
        return Ok(0);
    };
    let n = match value {
        Value::Number(n) => n.as_u64().filter(|v| *v <= MAX_COUNT).or_else(|| {
            n.as_f64()
                .filter(|f| {
                    f.is_finite() && *f >= 0.0 && f.fract() == 0.0 && *f <= MAX_COUNT as f64
                })
                .map(|f| f as u64)
        }),
        _ => None,
    }
    .ok_or_else(|| {
        Error::new(
            ErrorKind::Corrupt,
            "guard count must be a nonnegative safe integer",
        )
    })?;
    Ok(n)
}
fn encoded(value: &Map<String, Value>) -> Result<Vec<u8>> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|e| Error::new(ErrorKind::Corrupt, e.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(Error::new(
            ErrorKind::Corrupt,
            "updated strike state exceeds byte bound",
        ));
    }
    Ok(bytes)
}
fn guard_key(guard: &str) -> Result<()> {
    if guard.is_empty()
        || guard.len() > 128
        || !guard
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(Error::new(ErrorKind::Identity, "invalid guard key"));
    }
    Ok(())
}

struct Temporary<'a> {
    directory: &'a Directory,
    name: CString,
    file: File,
    renamed: bool,
}
impl<'a> Temporary<'a> {
    fn create(directory: &'a Directory, budget: TransactionBudget<'_>) -> Result<Self> {
        for _ in 0..16 {
            budget.check()?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| Error::new(ErrorKind::Io, e.to_string()))?
                .as_nanos();
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let name = CString::new(format!(
                ".guard-strikes.{}.{stamp}.{sequence}.tmp",
                std::process::id()
            ))
            .unwrap();
            let raw = unsafe {
                libc::openat(
                    directory.fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if raw < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
                continue;
            }
            let file = File::from(descriptor(raw, "create exclusive strike temporary")?);
            return Ok(Self {
                directory,
                name,
                file,
                renamed: false,
            });
        }
        Err(Error::new(
            ErrorKind::Io,
            "private strike temporary names exhausted",
        ))
    }
}
impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if !self.renamed
            && same_name(self.directory.fd(), &self.name, self.file.as_raw_fd()).unwrap_or(false)
        {
            unsafe {
                libc::unlinkat(self.directory.fd(), self.name.as_ptr(), 0);
            }
        }
    }
}
fn publish(
    directory: &Directory,
    name: &CStr,
    expected: &Option<Observation>,
    bytes: &[u8],
    budget: TransactionBudget<'_>,
    visible: &mut bool,
) -> Result<()> {
    directory.verify(budget)?;
    let mut temporary = Temporary::create(directory, budget)?;
    let mut remaining = bytes;
    while !remaining.is_empty() {
        budget.check()?;
        let n = temporary
            .file
            .write(remaining)
            .map_err(|e| Error::source("write private strike temporary", e))?;
        if n == 0 {
            return Err(Error::new(
                ErrorKind::Io,
                "private strike write made no progress",
            ));
        }
        remaining = &remaining[n..];
    }
    budget.check()?;
    temporary
        .file
        .sync_all()
        .map_err(|e| Error::source("sync private strike state", e))?;
    directory.verify(budget)?;
    owned_file(temporary.file.as_raw_fd())?;
    if !same_name(directory.fd(), &temporary.name, temporary.file.as_raw_fd())?
        || read(directory, name, budget)? != *expected
    {
        return Err(Error::new(
            ErrorKind::UnsafePath,
            "strike state or private temporary changed before publication",
        ));
    }
    budget.check()?;
    if unsafe {
        libc::renameat(
            directory.fd(),
            temporary.name.as_ptr(),
            directory.fd(),
            name.as_ptr(),
        )
    } != 0
    {
        return Err(Error::io("publish strike state"));
    }
    temporary.renamed = true;
    *visible = true;
    directory.sync(budget)
}
fn verify_lock(
    directory: &Directory,
    name: &CStr,
    lock: &OwnedFd,
    budget: TransactionBudget<'_>,
) -> Result<()> {
    directory.verify(budget)?;
    if owned_file(lock.as_raw_fd())?.st_size != 0
        || !same_name(directory.fd(), name, lock.as_raw_fd())?
    {
        return Err(Error::new(
            ErrorKind::UnsafePath,
            "retained transaction lock was replaced",
        ));
    }
    Ok(())
}
fn imported_marker() -> Vec<u8> {
    b"{\"schema\":\"caws.guard-strikes.imported.v1\",\"imported\":true}\n".to_vec()
}

pub struct StrikeStore {
    directory: Directory,
    identity: StrikeIdentity,
    target: PathBuf,
}
impl StrikeStore {
    /// `home` is original HOME/.caws, deliberately independent of CAWS_HOME.
    pub fn open(
        home: &Path,
        identity: StrikeIdentity,
        budget: TransactionBudget<'_>,
    ) -> Result<Self> {
        let mut directory = Directory::open(home, budget)?;
        let session = CString::new(identity.safe.as_bytes()).unwrap();
        for component in [c"state", c"sessions", session.as_c_str()] {
            directory.verify(budget)?;
            directory.descend(component, true, budget)?;
            directory.verify(budget)?;
        }
        let target = home
            .join("state/sessions")
            .join(&identity.safe)
            .join("strikes.json");
        Ok(Self {
            directory,
            identity,
            target,
        })
    }
    fn state(
        &self,
        legacy: &[PathBuf],
        budget: TransactionBudget<'_>,
    ) -> Result<(Option<Observation>, Option<Observation>, Map<String, Value>)> {
        if legacy.len() > 2 {
            return Err(Error::new(
                ErrorKind::Identity,
                "at most two native-derived legacy candidates are admitted",
            ));
        }
        let state = read(&self.directory, STATE, budget)?;
        let marker = read(&self.directory, MARKER, budget)?;
        if let Some(marker) = &marker {
            if Value::Object(object(&marker.bytes)?)
                != json!({"schema":"caws.guard-strikes.imported.v1","imported":true})
            {
                return Err(Error::new(
                    ErrorKind::Corrupt,
                    "invalid strike import marker",
                ));
            }
        }
        let mut value = match &state {
            Some(state) => object(&state.bytes)?,
            None => Map::new(),
        };
        // Existing global state is already imported even if its marker is absent.
        if state.is_none() && marker.is_none() {
            for candidate in legacy {
                let parent = candidate.parent().ok_or_else(|| {
                    Error::new(ErrorKind::UnsafePath, "legacy candidate has no parent")
                })?;
                let leaf = candidate.file_name().ok_or_else(|| {
                    Error::new(ErrorKind::UnsafePath, "legacy candidate has no leaf")
                })?;
                let directory = match Directory::open(parent, budget) {
                    Ok(directory) => directory,
                    Err(e) if e.kind == ErrorKind::Io && e.source_errno == Some(libc::ENOENT) => {
                        continue;
                    }
                    Err(e) => return Err(e),
                };
                let name = CString::new(leaf.as_bytes())
                    .map_err(|_| Error::new(ErrorKind::UnsafePath, "nul legacy name"))?;
                if let Some(old) = read(&directory, &name, budget)? {
                    value.extend(object(&old.bytes)?);
                }
            }
        }
        Ok((state, marker, value))
    }
    pub fn increment_scope_guard(
        &self,
        legacy: &[PathBuf],
        budget: TransactionBudget<'_>,
    ) -> Result<CommittedStrike> {
        self.increment("scope_guard", legacy, budget)
    }
    pub fn increment_shortcut_language(
        &self,
        legacy: &[PathBuf],
        budget: TransactionBudget<'_>,
    ) -> Result<CommittedStrike> {
        self.increment("shortcut_language", legacy, budget)
    }
    /// Generic Rust-only entry for existing shell guards; no Node guard selector.
    pub fn increment(
        &self,
        guard: &str,
        legacy: &[PathBuf],
        budget: TransactionBudget<'_>,
    ) -> Result<CommittedStrike> {
        guard_key(guard)?;
        let _lock = self.directory.lock(LOCK, budget)?;
        let mut visible = false;
        let mut publication = None;
        let result = (|| {
            let (state, marker, mut value) = self.state(legacy, budget)?;
            let previous = count(value.get(guard))?;
            let next = previous
                .checked_add(1)
                .filter(|v| *v <= MAX_COUNT)
                .ok_or_else(|| {
                    Error::new(
                        ErrorKind::Overflow,
                        "guard count increment exceeds safe integer domain",
                    )
                })?;
            value.insert(guard.into(), Value::Number(next.into()));
            let bytes = encoded(&value)?;
            let committed = CommittedStrike {
                count: next,
                state_sha256: digest(&bytes),
            };
            // Set before publish so a late fsync/deadline error retains identity.
            publication = Some(committed.clone());
            verify_lock(&self.directory, LOCK, &_lock, budget)?;
            publish(&self.directory, STATE, &state, &bytes, budget, &mut visible)?;
            verify_lock(&self.directory, LOCK, &_lock, budget)?;
            // State first: a crash before marker publication leaves an existing
            // global file, which independently prevents legacy re-import.
            if marker.is_none() {
                publish(
                    &self.directory,
                    MARKER,
                    &None,
                    &imported_marker(),
                    budget,
                    &mut visible,
                )?;
            }
            verify_lock(&self.directory, LOCK, &_lock, budget)?;
            budget.check()?;
            Ok(committed)
        })();
        result.map_err(|e: Error| if visible { e.uncertain(publication) } else { e })
    }
    /// Trusted human-reset adapter only. The Node increment port never exposes
    /// this capability. Lock order is session first, project audit second.
    pub fn reset(
        &self,
        guard: Option<&str>,
        legacy: &[PathBuf],
        audit: &ResetAudit,
        budget: TransactionBudget<'_>,
    ) -> Result<ResetReceipt> {
        if let Some(guard) = guard {
            guard_key(guard)?;
        }
        let _session_lock = self.directory.lock(LOCK, budget)?;
        let _audit_lock = audit.directory.lock(AUDIT_LOCK, budget)?;
        let mut visible = false;
        let result = (|| {
            let (mut state, marker, before) = self.state(legacy, budget)?;
            let before_bytes = encoded(&before)?;
            let mode = if guard.is_some() {
                ResetMode::Guard
            } else {
                ResetMode::All
            };
            // The intent retains the complete preimage, not only its digest.
            let before_state = Value::Object(before.clone());
            let mut after = before;
            if let Some(guard) = guard {
                after.remove(guard);
            } else {
                after.clear();
            }
            let after_bytes = if after.is_empty() {
                None
            } else {
                Some(encoded(&after)?)
            };
            let transaction = format!(
                "{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| Error::new(ErrorKind::Io, e.to_string()))?
                    .as_nanos(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            );
            let receipt = ResetReceipt {
                transaction,
                before_sha256: digest(&before_bytes),
                after_sha256: after_bytes.as_deref().map(digest),
            };
            verify_lock(&self.directory, LOCK, &_session_lock, budget)?;
            verify_lock(&audit.directory, AUDIT_LOCK, &_audit_lock, budget)?;
            audit.append(&json!({"schema":"caws.guard-strikes.reset.v1","action":ResetAction::Reset,"mode":mode,"dryRun":false,"phase":"intent","transaction":receipt.transaction,"session":self.identity.raw,"bucket":self.identity.safe,"guard":guard,"target":self.target,"before":receipt.before_sha256,"beforeState":before_state,"after":receipt.after_sha256}), budget, &mut visible)?;
            // Persist an imported legacy baseline before marking it imported.
            // A crash between these publications preserves unrelated guard keys.
            if state.is_none() && marker.is_none() {
                verify_lock(&self.directory, LOCK, &_session_lock, budget)?;
                verify_lock(&audit.directory, AUDIT_LOCK, &_audit_lock, budget)?;
                publish(
                    &self.directory,
                    STATE,
                    &None,
                    &before_bytes,
                    budget,
                    &mut visible,
                )?;
                state = read(&self.directory, STATE, budget)?;
            }
            verify_lock(&self.directory, LOCK, &_session_lock, budget)?;
            verify_lock(&audit.directory, AUDIT_LOCK, &_audit_lock, budget)?;
            // Marker precedes deletion: reset cannot resurrect legacy strikes.
            if marker.is_none() {
                publish(
                    &self.directory,
                    MARKER,
                    &None,
                    &imported_marker(),
                    budget,
                    &mut visible,
                )?;
            }
            verify_lock(&self.directory, LOCK, &_session_lock, budget)?;
            verify_lock(&audit.directory, AUDIT_LOCK, &_audit_lock, budget)?;
            if let Some(bytes) = after_bytes {
                publish(&self.directory, STATE, &state, &bytes, budget, &mut visible)?;
            } else if state.is_some() {
                self.directory.verify(budget)?;
                if read(&self.directory, STATE, budget)? != state {
                    return Err(Error::new(
                        ErrorKind::UnsafePath,
                        "strike state changed before reset deletion",
                    ));
                }
                budget.check()?;
                if unsafe { libc::unlinkat(self.directory.fd(), STATE.as_ptr(), 0) } != 0 {
                    return Err(Error::io("delete reset strike state"));
                }
                visible = true;
                self.directory.sync(budget)?;
            }
            verify_lock(&self.directory, LOCK, &_session_lock, budget)?;
            verify_lock(&audit.directory, AUDIT_LOCK, &_audit_lock, budget)?;
            audit.append(&json!({"schema":"caws.guard-strikes.reset.v1","action":ResetAction::Reset,"mode":mode,"dryRun":false,"phase":"commit","transaction":receipt.transaction,"session":self.identity.raw,"bucket":self.identity.safe,"guard":guard,"target":self.target,"before":receipt.before_sha256,"after":receipt.after_sha256}), budget, &mut visible)?;
            budget.check()?;
            Ok(receipt)
        })();
        result.map_err(|e: Error| if visible { e.uncertain(None) } else { e })
    }
}
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ResetAction {
    Reset,
}
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ResetMode {
    Guard,
    All,
}

pub struct ResetAudit {
    directory: Directory,
}
impl ResetAudit {
    /// Native-selected existing physical project log directory, never a Node path.
    pub fn open(log_directory: &Path, budget: TransactionBudget<'_>) -> Result<Self> {
        Ok(Self {
            directory: Directory::open(log_directory, budget)?,
        })
    }
    fn append(
        &self,
        value: &Value,
        budget: TransactionBudget<'_>,
        visible: &mut bool,
    ) -> Result<()> {
        budget.check()?;
        let mut bytes =
            serde_json::to_vec(value).map_err(|e| Error::new(ErrorKind::Corrupt, e.to_string()))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_AUDIT_RECORD_BYTES {
            return Err(Error::new(
                ErrorKind::Corrupt,
                "complete audit record exceeds state plus metadata bound",
            ));
        }
        self.directory.verify(budget)?;
        let previous = named_metadata(self.directory.fd(), AUDIT)?;
        let flags =
            libc::O_RDWR | libc::O_APPEND | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
        budget.check()?;
        let raw = unsafe {
            libc::openat(
                self.directory.fd(),
                AUDIT.as_ptr(),
                flags
                    | if previous.is_none() {
                        libc::O_CREAT | libc::O_EXCL
                    } else {
                        0
                    },
                0o600,
            )
        };
        let fd = descriptor(raw, "open reset audit log")?;
        // Creation is a visible audit write even before the first data byte.
        if previous.is_none() {
            *visible = true;
        }
        let current = owned_file(fd.as_raw_fd())?;
        if previous
            .as_ref()
            .is_some_and(|old| !same_inode(old, &current))
            || !same_name(self.directory.fd(), AUDIT, fd.as_raw_fd())?
        {
            return Err(Error::new(ErrorKind::UnsafePath, "audit log was replaced"));
        }
        let mut file = File::from(fd);
        if current.st_size > 0 {
            budget.check()?;
            file.seek(SeekFrom::End(-1))
                .map_err(|e| Error::source("seek audit tail", e))?;
            let mut tail = [0u8; 1];
            file.read_exact(&mut tail)
                .map_err(|e| Error::source("read audit tail", e))?;
            if tail[0] != b'\n' {
                return Err(Error::new(
                    ErrorKind::Corrupt,
                    "audit log ends with an incomplete record",
                ));
            }
        }
        let mut remaining = bytes.as_slice();
        while !remaining.is_empty() {
            budget.check()?;
            let n = file
                .write(remaining)
                .map_err(|e| Error::source("append reset audit", e))?;
            if n == 0 {
                return Err(Error::new(ErrorKind::Io, "audit append made no progress"));
            }
            *visible = true;
            remaining = &remaining[n..];
        }
        budget.check()?;
        file.sync_all()
            .map_err(|e| Error::source("sync reset audit", e))?;
        self.directory.verify(budget)?;
        owned_file(file.as_raw_fd())?;
        if !same_name(self.directory.fd(), AUDIT, file.as_raw_fd())? {
            return Err(Error::new(
                ErrorKind::UnsafePath,
                "audit log changed after append",
            ));
        }
        self.directory.sync(budget)
    }
}

#[cfg(test)]
mod tests;
