//! Durable operational service-operation records. This journal grants neither
//! project authority nor process ownership. Its caller must independently verify
//! requests and may write to a daemon only with a returned private Dispatch.
//!
//! Production opens require a generation-independent Custody acquired from a
//! dedicated stable machine home outside the operational root. The custody
//! registry pins the operational root inode and owner-lock inode. Normal acquire
//! never initializes or repairs missing state. Journal and Dispatch both retain
//! the same lifetime machine-owner lock. A substituted/missing operational root
//! is refused even after all old handles have gone away. The stable machine home
//! itself and cooperative preservation of journal subdirectories/records are
//! explicit trust preconditions: this is not arbitrary record-deletion detection,
//! a malicious same-UID defense, or a root migration/handover implementation.
//!
//! One lifetime flock spans generations of the same project/service key. Each
//! operation is an independently checksummed, atomically replaced private file.
//! File sync precedes rename; directory sync precedes a successful response or
//! Dispatch. Publication errors poison the handle. A failed running publication returns no
//! Dispatch: an old queued record after reopen is safe because no write was
//! permitted. Persisted running records recover to unknown and retain the global
//! serialization fence. Unknown is never replayed, cleared, or evicted here.
//! Queued cancellation retains an accepted tombstone and grants neither dispatch
//! nor inline fallback. Its caller independently verifies retirement/withdrawal
//! and revalidates authority before dispatch; this journal evaluates no policy.
//!
//! maxRetainedRecords is explicit and persisted, with no production default or
//! retention policy. Full capacity rejects admission without evicting any ID.
//! The journal creates at most that many 256-KiB records, a 1-KiB config, an empty
//! lock, and one 256-KiB temporary. This is not production retention parity.
//!
//! Checksums detect changed/corrupt persisted bytes, not malicious same-UID
//! writers. The private filesystem and cooperative lifetime lock are the write
//! trust boundary. fsync relies on OS/storage semantics, not a power-cut proof.
//! Deadlines bound retries and are checked around filesystem operations; they
//! cannot interrupt a stalled kernel syscall. Opaque verified-request bytes are
//! bounded here, but their policy, argument count and argument digest are not
//! re-derived by this component.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::{CStr, CString},
    fmt,
    fs::{File, Metadata},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

mod custody;
pub use custody::Custody;

pub const MAX_RETAINED_RECORDS: u16 = 256;
pub const MAX_VERIFIED_REQUEST_BYTES: usize = 131_072;
pub const MAX_RECORD_BYTES: usize = 256 * 1024;
const MAX_CONFIG_BYTES: usize = 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const RECORD_SCHEMA: &str = "caws.service.operation.v1";
const CONFIG_SCHEMA: &str = "caws.service.journal.v1";
const LOCK: &CStr = c".journal.lock";
const CONFIG: &CStr = c".journal.json";
const TEMP: &CStr = c".operation.tmp";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Invalid,
    UnsafePath,
    Corrupt,
    Busy,
    Deadline,
    Io,
    Poisoned,
    Fenced,
    SourceMismatch,
}
#[derive(Debug)]
pub struct JournalError {
    pub kind: ErrorKind,
    pub publication_may_have_happened: bool,
    operation: &'static str,
    source: Option<io::Error>,
}
impl JournalError {
    fn new(kind: ErrorKind, operation: &'static str) -> Self {
        Self {
            kind,
            publication_may_have_happened: false,
            operation,
            source: None,
        }
    }
    fn io(operation: &'static str, source: io::Error) -> Self {
        let kind = if matches!(source.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
            ErrorKind::UnsafePath
        } else {
            ErrorKind::Io
        };
        Self {
            kind,
            publication_may_have_happened: false,
            operation,
            source: Some(source),
        }
    }
}
impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "service journal unavailable: {}", self.operation)?;
        if let Some(source) = &self.source {
            write!(f, ": {source}")?;
        }
        Ok(())
    }
}
impl std::error::Error for JournalError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|source| source as _)
    }
}
type Result<T> = std::result::Result<T, JournalError>;
fn check_deadline(expires: Instant) -> Result<()> {
    if Instant::now() >= expires {
        Err(JournalError::new(ErrorKind::Deadline, "deadline expired"))
    } else {
        Ok(())
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub request_id: String,
    pub argument_digest: String,
    pub project_service_key: String,
    pub source_generation: String,
    pub execution_image_digest: String,
}
impl Identity {
    fn valid(&self) -> bool {
        [
            &self.request_id,
            &self.argument_digest,
            &self.project_service_key,
            &self.source_generation,
            &self.execution_image_digest,
        ]
        .into_iter()
        .all(|value| digest(value))
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Accepted {
    #[serde(rename = "accepted")]
    Value,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Rejected {
    #[serde(rename = "rejected")]
    Value,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum KnownNotExecuted {
    #[serde(rename = "known_not_executed")]
    Value,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum OkResponse {
    #[serde(rename = "ok")]
    Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ReturnedResult {
    #[serde(rename = "process_exit")]
    ProcessExit {
        #[serde(deserialize_with = "required_nullable")]
        code: Option<u8>,
        #[serde(deserialize_with = "required_nullable")]
        signal: Option<u8>,
    },
    #[serde(rename = "daemon_response")]
    DaemonResponse {
        response: OkResponse,
        served: u64,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
        cached: bool,
    },
}
impl ReturnedResult {
    fn valid(&self) -> bool {
        match self {
            Self::ProcessExit { code, signal } => {
                code.is_some() != signal.is_some()
                    && signal.is_none_or(|signal| (1..=127).contains(&signal))
            }
            Self::DaemonResponse {
                served, elapsed_ms, ..
            } => (1..=MAX_SAFE_INTEGER).contains(served) && *elapsed_ms <= MAX_SAFE_INTEGER,
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CancelReason {
    #[serde(rename = "source_retired")]
    SourceRetired,
    #[serde(rename = "grant_withdrawn")]
    GrantWithdrawn,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "execution", deny_unknown_fields)]
pub enum AcceptedOutcome {
    #[serde(rename = "queued")]
    Queued { admission: Accepted },
    #[serde(rename = "running")]
    Running { admission: Accepted },
    #[serde(rename = "unknown")]
    Unknown { admission: Accepted },
    #[serde(rename = "cancelled_before_dispatch")]
    CancelledBeforeDispatch {
        admission: Accepted,
        reason: CancelReason,
    },
    #[serde(rename = "returned")]
    Returned {
        admission: Accepted,
        result: ReturnedResult,
        #[serde(
            rename = "artifactManifestDigest",
            deserialize_with = "required_nullable"
        )]
        artifact_manifest_digest: Option<String>,
    },
}
impl AcceptedOutcome {
    fn queued() -> Self {
        Self::Queued {
            admission: Accepted::Value,
        }
    }
    fn running() -> Self {
        Self::Running {
            admission: Accepted::Value,
        }
    }
    fn unknown() -> Self {
        Self::Unknown {
            admission: Accepted::Value,
        }
    }
    fn fenced(&self) -> bool {
        matches!(self, Self::Running { .. } | Self::Unknown { .. })
    }
    fn valid(&self) -> bool {
        match self {
            Self::Returned {
                result,
                artifact_manifest_digest,
                ..
            } => result.valid() && artifact_manifest_digest.as_deref().is_none_or(digest),
            _ => true,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RejectedOutcome {
    pub admission: Rejected,
    pub execution: KnownNotExecuted,
    pub reason: String,
}
impl RejectedOutcome {
    fn new(reason: &'static str) -> Self {
        debug_assert!(reason.len() <= 1024);
        Self {
            admission: Rejected::Value,
            execution: KnownNotExecuted::Value,
            reason: reason.into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    identity: Identity,
    sequence: u64,
    verified_request_base64: String,
    verified_request_sha256: String,
    outcome: AcceptedOutcome,
}
impl Operation {
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn outcome(&self) -> &AcceptedOutcome {
        &self.outcome
    }
    pub fn verified_request(&self) -> Result<Vec<u8>> {
        STANDARD
            .decode(&self.verified_request_base64)
            .map_err(|_| JournalError::new(ErrorKind::Corrupt, "invalid payload encoding"))
    }
    fn validate(&self, key: &str, file_id: &str) -> Result<()> {
        if !self.identity.valid()
            || self.identity.project_service_key != key
            || self.identity.request_id != file_id
            || self.sequence == 0
            || !digest(&self.verified_request_sha256)
            || !self.outcome.valid()
            || self.verified_request_base64.len() > MAX_VERIFIED_REQUEST_BYTES.div_ceil(3) * 4
        {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "invalid operation fields",
            ));
        }
        let bytes = self.verified_request()?;
        if bytes.len() > MAX_VERIFIED_REQUEST_BYTES
            || STANDARD.encode(&bytes) != self.verified_request_base64
            || hash(&bytes) != self.verified_request_sha256
        {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "operation payload mismatch",
            ));
        }
        Ok(())
    }
}
#[derive(Debug)]
pub enum Admission {
    Accepted {
        operation: Box<Operation>,
        duplicate: bool,
    },
    Rejected(RejectedOutcome),
}
/// Not deserializable or externally constructible. Returning this is the sole
/// journal boundary permitting the owner to attempt a daemon write.
#[derive(Debug)]
pub struct Dispatch {
    operation: Operation,
    custody: Arc<Custody>,
}
impl Dispatch {
    pub fn operation(&self) -> &Operation {
        &self.operation
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema: String,
    body: Operation,
    body_sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    schema: String,
    project_service_key: String,
    max_retained_records: u16,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    bytes: u64,
    modified: i64,
    modified_nanos: i64,
}
impl Stamp {
    fn of(value: &Metadata) -> Self {
        Self {
            device: value.dev(),
            inode: value.ino(),
            bytes: value.len(),
            modified: value.mtime(),
            modified_nanos: value.mtime_nsec(),
        }
    }
}
#[derive(Debug)]
struct Entry {
    operation: Operation,
    stamp: Stamp,
}
#[derive(Debug)]
pub struct Journal {
    custody: Arc<Custody>,
    root: OwnedFd,
    services: OwnedFd,
    directory: OwnedFd,
    key_name: CString,
    key: String,
    lock: File,
    config_stamp: Option<Stamp>,
    capacity: u16,
    entries: Vec<Entry>,
    poisoned: bool,
    #[cfg(test)]
    sync_count: usize,
    #[cfg(test)]
    fail_sync: Option<usize>,
}
fn owned_fd(raw: RawFd, operation: &'static str) -> Result<OwnedFd> {
    if raw < 0 {
        Err(JournalError::io(operation, io::Error::last_os_error()))
    } else {
        // SAFETY: successful open returned one fresh descriptor, transferred once.
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    }
}
// MetadataExt::mode() is u32; libc::mode_t is u16 on Darwin and u32 on
// Linux. Keep the conversion generic so both targets type-check without a
// platform-dependent no-op cast or lint suppression.
fn metadata_mode_bits(bits: impl Into<u32>) -> u32 {
    bits.into()
}
fn file_shape(uid: u32, mode: u32, links: u64) -> Result<()> {
    // SAFETY: geteuid has no pointer arguments or preconditions.
    if uid != unsafe { libc::geteuid() }
        || mode & metadata_mode_bits(libc::S_IFMT) != metadata_mode_bits(libc::S_IFREG)
        || mode & 0o7777 != 0o600
        || links != 1
    {
        Err(JournalError::new(
            ErrorKind::UnsafePath,
            "file is not private, owned, regular and single-link",
        ))
    } else {
        Ok(())
    }
}
fn private_file(file: &File) -> Result<Metadata> {
    let metadata = file
        .metadata()
        .map_err(|error| JournalError::io("file metadata", error))?;
    file_shape(metadata.uid(), metadata.mode(), metadata.nlink())?;
    Ok(metadata)
}
fn private_directory(fd: RawFd) -> Result<()> {
    let file = File::from(owned_fd(
        unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) },
        "duplicate directory",
    )?);
    let metadata = file
        .metadata()
        .map_err(|error| JournalError::io("directory metadata", error))?;
    if metadata.uid() != unsafe { libc::geteuid() }
        || !metadata.is_dir()
        || metadata.mode() & 0o7777 != 0o700
    {
        Err(JournalError::new(
            ErrorKind::UnsafePath,
            "directory is not private and owned",
        ))
    } else {
        Ok(())
    }
}
fn sync_fd(fd: RawFd, expires: Instant) -> Result<()> {
    loop {
        check_deadline(expires)?;
        // SAFETY: fd is an owned, live regular-file or directory descriptor.
        if unsafe { libc::fsync(fd) } == 0 {
            #[cfg(test)]
            tests::after_direct_sync(fd, expires)?;
            return check_deadline(expires);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(JournalError::io("fsync", error));
        }
    }
}
fn directory_at(parent: RawFd, name: &CStr, create: bool, expires: Instant) -> Result<OwnedFd> {
    check_deadline(expires)?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut raw = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    let mut created = false;
    if raw < 0 && create && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        created = unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } == 0;
        if !created && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(JournalError::io("mkdirat", io::Error::last_os_error()));
        }
        raw = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    }
    let value = owned_fd(raw, "open directory without symlinks")?;
    if created && unsafe { libc::fchmod(value.as_raw_fd(), 0o700) } != 0 {
        return Err(JournalError::io(
            "private directory mode",
            io::Error::last_os_error(),
        ));
    }
    if create {
        private_directory(value.as_raw_fd())?;
        // An existing name may have survived a failed initialization attempt
        // without its parent publication being synced. Re-anchor both inode
        // and parent name on every creation-enabled open, not only mkdir.
        // create=false is read-only traversal of unrelated root ancestors.
        sync_fd(value.as_raw_fd(), expires)?;
        sync_fd(parent, expires)?;
    }
    Ok(value)
}
fn private_root(root: &Path, expires: Instant) -> Result<OwnedFd> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(JournalError::new(
            ErrorKind::UnsafePath,
            "root must be absolute without traversal",
        ));
    }
    let mut directory = owned_fd(
        unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        },
        "filesystem anchor",
    )?;
    for component in root.components() {
        if let Component::Normal(name) = component {
            let name = CString::new(name.as_bytes())
                .map_err(|_| JournalError::new(ErrorKind::UnsafePath, "nul in root"))?;
            directory = directory_at(directory.as_raw_fd(), &name, false, expires)?;
        }
    }
    private_directory(directory.as_raw_fd())?;
    Ok(directory)
}
fn same_name(parent: RawFd, name: &CStr, file: RawFd, kind: libc::mode_t) -> bool {
    let mut named = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let mut opened = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: both stat outputs are writable; descriptors and name are live.
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            named.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
        || unsafe { libc::fstat(file, opened.as_mut_ptr()) } != 0
    {
        return false;
    }
    let named = unsafe { named.assume_init() };
    let opened = unsafe { opened.assume_init() };
    named.st_dev == opened.st_dev
        && named.st_ino == opened.st_ino
        && named.st_mode & libc::S_IFMT == kind
}
fn open_file(directory: RawFd, name: &CStr) -> Result<File> {
    Ok(File::from(owned_fd(
        unsafe {
            libc::openat(
                directory,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        },
        "open private file",
    )?))
}
fn read_file(
    directory: RawFd,
    name: &CStr,
    limit: usize,
    expires: Instant,
) -> Result<(Vec<u8>, Stamp)> {
    check_deadline(expires)?;
    let mut file = open_file(directory, name)?;
    let before = Stamp::of(&private_file(&file)?);
    if before.bytes > limit as u64 {
        return Err(JournalError::new(
            ErrorKind::Corrupt,
            "file exceeds byte bound",
        ));
    }
    let mut bytes = Vec::new();
    let mut reader = (&mut file).take((limit + 1) as u64);
    loop {
        check_deadline(expires)?;
        let mut chunk = [0u8; 16_384];
        let count = reader
            .read(&mut chunk)
            .map_err(|error| JournalError::io("read private file", error))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > limit {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "file grew beyond byte bound",
            ));
        }
    }
    if Stamp::of(&private_file(&file)?) != before
        || !same_name(directory, name, file.as_raw_fd(), libc::S_IFREG)
    {
        return Err(JournalError::new(
            ErrorKind::UnsafePath,
            "file changed during bounded read",
        ));
    }
    check_deadline(expires)?;
    Ok((bytes, before))
}
unsafe fn errno_pointer() -> *mut libc::c_int {
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    {
        unsafe { libc::__error() }
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        unsafe { libc::__errno_location() }
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        std::ptr::null_mut()
    }
}
struct DirectoryStream(*mut libc::DIR);
impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}
fn names(directory: RawFd, limit: usize, expires: Instant) -> Result<BTreeSet<String>> {
    let errno = unsafe { errno_pointer() };
    if errno.is_null() {
        return Err(JournalError::new(
            ErrorKind::Io,
            "directory observation unsupported on this platform",
        ));
    }
    // A new open description avoids sharing readdir offsets with the held
    // directory capability or another scan (dup would share that offset).
    let duplicate = owned_fd(
        unsafe {
            libc::openat(
                directory,
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        },
        "open anchored scan directory",
    )?;
    let raw = duplicate.into_raw_fd();
    let stream = unsafe { libc::fdopendir(raw) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(raw);
        }
        return Err(JournalError::io("fdopendir", error));
    }
    let stream = DirectoryStream(stream);
    let mut result = BTreeSet::new();
    loop {
        check_deadline(expires)?;
        unsafe {
            *errno = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if unsafe { *errno } != 0 {
                return Err(JournalError::io("readdir", io::Error::last_os_error()));
            }
            break;
        }
        let value = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        let value = value
            .to_str()
            .map_err(|_| JournalError::new(ErrorKind::Corrupt, "non-UTF8 journal filename"))?;
        if matches!(value, "." | "..") {
            continue;
        }
        if !result.insert(value.into()) || result.len() > limit {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "journal file-count bound exceeded",
            ));
        }
    }
    Ok(result)
}
fn record_name(id: &str) -> CString {
    CString::new(format!("{id}.json")).expect("validated ASCII request ID")
}
fn record_id(name: &str) -> Option<&str> {
    name.strip_suffix(".json").filter(|id| digest(id))
}
struct Temporary {
    parent: RawFd,
    file: File,
    renamed: bool,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.renamed && same_name(self.parent, TEMP, self.file.as_raw_fd(), libc::S_IFREG) {
            unsafe {
                libc::unlinkat(self.parent, TEMP.as_ptr(), 0);
            }
        }
    }
}

impl Journal {
    pub fn open(
        custody: Arc<Custody>,
        project_service_key: &str,
        max_retained_records: u16,
        expires: Instant,
    ) -> Result<Self> {
        check_deadline(expires)?;
        if !digest(project_service_key)
            || !(1..=MAX_RETAINED_RECORDS).contains(&max_retained_records)
        {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "invalid key or explicit retention bound",
            ));
        }
        let root = custody.duplicate_root(expires)?;
        let services = directory_at(root.as_raw_fd(), c"services", true, expires)?;
        private_directory(services.as_raw_fd())?;
        let key_name = CString::new(project_service_key).expect("validated ASCII key");
        let directory = directory_at(services.as_raw_fd(), &key_name, true, expires)?;
        private_directory(directory.as_raw_fd())?;
        let flags = libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
        let mut raw = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                LOCK.as_ptr(),
                flags | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        let created = raw >= 0;
        if raw < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            raw = unsafe { libc::openat(directory.as_raw_fd(), LOCK.as_ptr(), flags) };
        }
        let lock = File::from(owned_fd(raw, "open stable journal lock")?);
        if created && unsafe { libc::fchmod(lock.as_raw_fd(), 0o600) } != 0 {
            return Err(JournalError::io(
                "private lock mode",
                io::Error::last_os_error(),
            ));
        }
        if private_file(&lock)?.len() != 0 {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "lock is not empty",
            ));
        }
        loop {
            if Instant::now() >= expires {
                return Err(JournalError::new(
                    ErrorKind::Busy,
                    "another journal owner holds the lifetime lock",
                ));
            }
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if !matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) {
                return Err(JournalError::io("flock", error));
            }
            thread::sleep(
                Duration::from_millis(2).min(expires.saturating_duration_since(Instant::now())),
            );
        }
        if !same_name(directory.as_raw_fd(), LOCK, lock.as_raw_fd(), libc::S_IFREG) {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "lock inode replaced",
            ));
        }
        if created {
            sync_fd(lock.as_raw_fd(), expires)?;
            sync_fd(directory.as_raw_fd(), expires)?;
        }
        let mut journal = Self {
            custody,
            root,
            services,
            directory,
            key_name,
            key: project_service_key.into(),
            lock,
            config_stamp: None,
            capacity: max_retained_records,
            entries: Vec::new(),
            poisoned: false,
            #[cfg(test)]
            sync_count: 0,
            #[cfg(test)]
            fail_sync: None,
        };
        journal.remove_abandoned_temporary(expires)?;
        let files = names(
            journal.directory.as_raw_fd(),
            usize::from(max_retained_records) + 2,
            expires,
        )?;
        if files.contains(CONFIG.to_str().expect("ASCII config")) {
            if created {
                return Err(JournalError::new(
                    ErrorKind::UnsafePath,
                    "existing journal lost its stable lock inode",
                ));
            }
            let (bytes, stamp) = read_file(
                journal.directory.as_raw_fd(),
                CONFIG,
                MAX_CONFIG_BYTES,
                expires,
            )?;
            let config: Config = serde_json::from_slice(&bytes)
                .map_err(|_| JournalError::new(ErrorKind::Corrupt, "invalid journal config"))?;
            if config.schema != CONFIG_SCHEMA
                || config.project_service_key != project_service_key
                || config.max_retained_records != max_retained_records
            {
                return Err(JournalError::new(
                    ErrorKind::Corrupt,
                    "journal config identity or capacity mismatch",
                ));
            }
            journal.config_stamp = Some(stamp);
        } else {
            if files
                .iter()
                .any(|name| name != LOCK.to_str().expect("ASCII lock"))
            {
                return Err(JournalError::new(
                    ErrorKind::Corrupt,
                    "records exist without journal config",
                ));
            }
            let config = Config {
                schema: CONFIG_SCHEMA.into(),
                project_service_key: project_service_key.into(),
                max_retained_records,
            };
            let bytes = serde_json::to_vec(&config)
                .map_err(|_| JournalError::new(ErrorKind::Corrupt, "encode config"))?;
            journal.config_stamp = Some(journal.atomic(CONFIG, &bytes, None, expires)?);
        }
        let mut sequences = BTreeSet::new();
        for name in files {
            if name == LOCK.to_str().expect("ASCII lock")
                || name == CONFIG.to_str().expect("ASCII config")
            {
                continue;
            }
            let id = record_id(&name)
                .ok_or_else(|| JournalError::new(ErrorKind::Corrupt, "unexpected journal entry"))?;
            let entry = journal.read_record(id, expires)?;
            if !sequences.insert(entry.operation.sequence) {
                return Err(JournalError::new(
                    ErrorKind::Corrupt,
                    "duplicate operation sequence",
                ));
            }
            journal.entries.push(entry);
        }
        if journal.entries.len() > usize::from(journal.capacity) {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "accepted capacity exceeded",
            ));
        }
        journal
            .entries
            .sort_by_key(|entry| entry.operation.sequence);
        if journal
            .entries
            .iter()
            .filter(|entry| entry.operation.outcome.fenced())
            .count()
            > 1
        {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "multiple serialized operations are fenced",
            ));
        }
        // No handle is exposed while a persisted running operation remains
        // eligible for replay. Recovery itself must be durably published.
        for index in 0..journal.entries.len() {
            if matches!(
                journal.entries[index].operation.outcome,
                AcceptedOutcome::Running { .. }
            ) {
                let mut operation = journal.entries[index].operation.clone();
                operation.outcome = AcceptedOutcome::unknown();
                journal.replace(index, operation, expires)?;
            }
        }
        Ok(journal)
    }
    fn anchor(&self, expires: Instant) -> Result<()> {
        self.custody.check(expires)?;
        for fd in [
            self.root.as_raw_fd(),
            self.services.as_raw_fd(),
            self.directory.as_raw_fd(),
        ] {
            private_directory(fd)?;
        }
        if private_file(&self.lock)?.len() != 0
            || !same_name(
                self.root.as_raw_fd(),
                c"services",
                self.services.as_raw_fd(),
                libc::S_IFDIR,
            )
            || !same_name(
                self.services.as_raw_fd(),
                &self.key_name,
                self.directory.as_raw_fd(),
                libc::S_IFDIR,
            )
            || !same_name(
                self.directory.as_raw_fd(),
                LOCK,
                self.lock.as_raw_fd(),
                libc::S_IFREG,
            )
        {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "held journal anchors or lock changed",
            ));
        }
        Ok(())
    }
    fn current(&self, expires: Instant) -> Result<()> {
        if self.poisoned {
            return Err(JournalError::new(
                ErrorKind::Poisoned,
                "handle poisoned; release owner lock and reopen",
            ));
        }
        self.anchor(expires)?;
        let actual = names(
            self.directory.as_raw_fd(),
            usize::from(self.capacity) + 2,
            expires,
        )?;
        let mut expected = BTreeSet::from([
            LOCK.to_str().unwrap().into(),
            CONFIG.to_str().unwrap().into(),
        ]);
        for entry in &self.entries {
            expected.insert(
                record_name(&entry.operation.identity.request_id)
                    .to_str()
                    .unwrap()
                    .into(),
            );
        }
        if actual != expected {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "journal names changed outside the owner",
            ));
        }
        let metadata = private_file(&open_file(self.directory.as_raw_fd(), CONFIG)?)?;
        if self.config_stamp != Some(Stamp::of(&metadata)) {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "journal config changed outside the owner",
            ));
        }
        // Stable lifetime ownership lets us retain verified payloads in memory.
        // Metadata changes are refused; selected records are fully reread and
        // checksummed before a state transition. This is not hostile-same-UID
        // protection, and no directory change is silently imported.
        for entry in &self.entries {
            check_deadline(expires)?;
            let file = open_file(
                self.directory.as_raw_fd(),
                &record_name(&entry.operation.identity.request_id),
            )?;
            if Stamp::of(&private_file(&file)?) != entry.stamp {
                return Err(JournalError::new(
                    ErrorKind::UnsafePath,
                    "operation changed outside the owner",
                ));
            }
        }
        Ok(())
    }
    fn read_record(&self, id: &str, expires: Instant) -> Result<Entry> {
        let (bytes, stamp) = read_file(
            self.directory.as_raw_fd(),
            &record_name(id),
            MAX_RECORD_BYTES,
            expires,
        )?;
        let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|_| {
            JournalError::new(ErrorKind::Corrupt, "invalid closed operation record")
        })?;
        let body = serde_json::to_vec(&envelope.body)
            .map_err(|_| JournalError::new(ErrorKind::Corrupt, "encode operation checksum"))?;
        if envelope.schema != RECORD_SCHEMA
            || !digest(&envelope.body_sha256)
            || hash(&body) != envelope.body_sha256
        {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "operation checksum mismatch",
            ));
        }
        envelope.body.validate(&self.key, id)?;
        Ok(Entry {
            operation: envelope.body,
            stamp,
        })
    }
    fn selected(&self, index: usize, expires: Instant) -> Result<()> {
        let previous = &self.entries[index];
        let observed = self.read_record(&previous.operation.identity.request_id, expires)?;
        if observed.stamp != previous.stamp || observed.operation != previous.operation {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "selected operation changed",
            ));
        }
        Ok(())
    }
    fn sync(&mut self, fd: RawFd, expires: Instant) -> Result<()> {
        sync_fd(fd, expires)?;
        #[cfg(test)]
        {
            self.sync_count += 1;
            // Inject a reported error after a real fsync. Tests inspect actual
            // files and reopen, rather than trusting this hook as evidence.
            if self.fail_sync == Some(self.sync_count) {
                return Err(JournalError::io(
                    "injected sync error after real fsync",
                    io::Error::other("injected sync report"),
                ));
            }
        }
        Ok(())
    }
    fn atomic(
        &mut self,
        name: &CStr,
        bytes: &[u8],
        previous: Option<Stamp>,
        expires: Instant,
    ) -> Result<Stamp> {
        self.poisoned = true;
        let mut published = false;
        let result = (|| {
            self.anchor(expires)?;
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(JournalError::new(
                    ErrorKind::Corrupt,
                    "serialized record exceeds bound",
                ));
            }
            let file = File::from(owned_fd(
                unsafe {
                    libc::openat(
                        self.directory.as_raw_fd(),
                        TEMP.as_ptr(),
                        libc::O_RDWR
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                },
                "exclusive operation temporary",
            )?);
            let mut temporary = Temporary {
                parent: self.directory.as_raw_fd(),
                file,
                renamed: false,
            };
            if unsafe { libc::fchmod(temporary.file.as_raw_fd(), 0o600) } != 0 {
                return Err(JournalError::io(
                    "private temporary mode",
                    io::Error::last_os_error(),
                ));
            }
            let mut remaining = bytes;
            while !remaining.is_empty() {
                check_deadline(expires)?;
                let written = temporary
                    .file
                    .write(&remaining[..remaining.len().min(16_384)])
                    .map_err(|error| JournalError::io("write operation temporary", error))?;
                if written == 0 {
                    return Err(JournalError::new(
                        ErrorKind::Io,
                        "operation write made no progress",
                    ));
                }
                remaining = &remaining[written..];
            }
            self.sync(temporary.file.as_raw_fd(), expires)?;
            let new_stamp = Stamp::of(&private_file(&temporary.file)?);
            if !same_name(
                self.directory.as_raw_fd(),
                TEMP,
                temporary.file.as_raw_fd(),
                libc::S_IFREG,
            ) {
                return Err(JournalError::new(
                    ErrorKind::UnsafePath,
                    "temporary name replaced",
                ));
            }
            match open_file(self.directory.as_raw_fd(), name) {
                Ok(file) => {
                    if previous != Some(Stamp::of(&private_file(&file)?))
                        || !same_name(
                            self.directory.as_raw_fd(),
                            name,
                            file.as_raw_fd(),
                            libc::S_IFREG,
                        )
                    {
                        return Err(JournalError::new(
                            ErrorKind::UnsafePath,
                            "publication target changed",
                        ));
                    }
                }
                Err(error)
                    if error.source.as_ref().and_then(io::Error::raw_os_error)
                        == Some(libc::ENOENT)
                        && previous.is_none() => {}
                Err(error) => return Err(error),
            }
            check_deadline(expires)?;
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    TEMP.as_ptr(),
                    self.directory.as_raw_fd(),
                    name.as_ptr(),
                )
            } != 0
            {
                return Err(JournalError::io(
                    "atomic operation rename",
                    io::Error::last_os_error(),
                ));
            }
            temporary.renamed = true;
            published = true;
            self.sync(self.directory.as_raw_fd(), expires)?;
            if !same_name(
                self.directory.as_raw_fd(),
                name,
                temporary.file.as_raw_fd(),
                libc::S_IFREG,
            ) {
                return Err(JournalError::new(
                    ErrorKind::UnsafePath,
                    "published name replaced",
                ));
            }
            check_deadline(expires)?;
            Ok(new_stamp)
        })();
        match result {
            Ok(stamp) => {
                self.poisoned = false;
                Ok(stamp)
            }
            Err(mut error) => {
                error.publication_may_have_happened = published;
                Err(error)
            }
        }
    }
    fn remove_abandoned_temporary(&self, expires: Instant) -> Result<()> {
        match open_file(self.directory.as_raw_fd(), TEMP) {
            Ok(file) => {
                if private_file(&file)?.len() > MAX_RECORD_BYTES as u64
                    || !same_name(
                        self.directory.as_raw_fd(),
                        TEMP,
                        file.as_raw_fd(),
                        libc::S_IFREG,
                    )
                {
                    return Err(JournalError::new(
                        ErrorKind::UnsafePath,
                        "unsafe abandoned temporary",
                    ));
                }
                if unsafe { libc::unlinkat(self.directory.as_raw_fd(), TEMP.as_ptr(), 0) } != 0 {
                    return Err(JournalError::io(
                        "remove abandoned temporary",
                        io::Error::last_os_error(),
                    ));
                }
                sync_fd(self.directory.as_raw_fd(), expires)
            }
            Err(error)
                if error.source.as_ref().and_then(io::Error::raw_os_error)
                    == Some(libc::ENOENT) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
    fn replace(&mut self, index: usize, operation: Operation, expires: Instant) -> Result<()> {
        self.selected(index, expires)?;
        let bytes = encode(&operation)?;
        let stamp = self.atomic(
            &record_name(&operation.identity.request_id),
            &bytes,
            Some(self.entries[index].stamp),
            expires,
        )?;
        self.entries[index] = Entry { operation, stamp };
        Ok(())
    }
    pub fn lookup(&self, request_id: &str, expires: Instant) -> Result<Option<Operation>> {
        if !digest(request_id) {
            return Err(JournalError::new(ErrorKind::Invalid, "invalid request ID"));
        }
        self.current(expires)?;
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.operation.identity.request_id == request_id)
        {
            self.selected(index, expires)?;
            Ok(Some(self.entries[index].operation.clone()))
        } else {
            Ok(None)
        }
    }
    pub fn admit(
        &mut self,
        identity: Identity,
        verified_request: &[u8],
        expires: Instant,
    ) -> Result<Admission> {
        self.current(expires)?;
        if !identity.valid()
            || identity.project_service_key != self.key
            || verified_request.len() > MAX_VERIFIED_REQUEST_BYTES
        {
            return Ok(Admission::Rejected(RejectedOutcome::new(
                "invalid identity or verified-request byte bound",
            )));
        }
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.operation.identity.request_id == identity.request_id)
        {
            self.selected(index, expires)?;
            let previous = &self.entries[index].operation;
            if previous.identity != identity || previous.verified_request()? != verified_request {
                return Ok(Admission::Rejected(RejectedOutcome::new(
                    "request ID collision; this identity was not accepted; the prior operation may have executed",
                )));
            }
            return Ok(Admission::Accepted {
                operation: Box::new(previous.clone()),
                duplicate: true,
            });
        }
        if self.entries.len() >= usize::from(self.capacity) {
            return Ok(Admission::Rejected(RejectedOutcome::new(
                "retained accepted-operation capacity exhausted; no operation was evicted",
            )));
        }
        let Some(sequence) = self
            .entries
            .last()
            .map_or(Some(1), |entry| entry.operation.sequence.checked_add(1))
        else {
            return Ok(Admission::Rejected(RejectedOutcome::new(
                "operation sequence exhausted; request was not accepted",
            )));
        };
        let operation = Operation {
            identity,
            sequence,
            verified_request_base64: STANDARD.encode(verified_request),
            verified_request_sha256: hash(verified_request),
            outcome: AcceptedOutcome::queued(),
        };
        let bytes = encode(&operation)?;
        let stamp = self.atomic(
            &record_name(&operation.identity.request_id),
            &bytes,
            None,
            expires,
        )?;
        self.entries.push(Entry {
            operation: operation.clone(),
            stamp,
        });
        Ok(Admission::Accepted {
            operation: Box::new(operation),
            duplicate: false,
        })
    }
    /// Retain an accepted cancellation tombstone only while no Dispatch exists.
    /// The caller verifies the retirement/withdrawal reason independently and
    /// must revalidate authority immediately before any subsequent dispatch.
    /// This operation never grants inline-fallback permission.
    pub fn cancel_queued(
        &mut self,
        request_id: &str,
        reason: CancelReason,
        expires: Instant,
    ) -> Result<Operation> {
        if !digest(request_id) {
            return Err(JournalError::new(ErrorKind::Invalid, "invalid request ID"));
        }
        self.current(expires)?;
        let index = self
            .entries
            .iter()
            .position(|entry| entry.operation.identity.request_id == request_id)
            .ok_or_else(|| {
                JournalError::new(ErrorKind::Invalid, "queued operation was not retained")
            })?;
        self.selected(index, expires)?;
        match &self.entries[index].operation.outcome {
            AcceptedOutcome::Queued { .. } => {}
            AcceptedOutcome::CancelledBeforeDispatch {
                reason: previous, ..
            } => {
                if *previous == reason {
                    return Ok(self.entries[index].operation.clone());
                }
                return Err(JournalError::new(
                    ErrorKind::Invalid,
                    "cancellation reason conflicts with retained cancellation",
                ));
            }
            _ => {
                return Err(JournalError::new(
                    ErrorKind::Invalid,
                    "only queued operations can be cancelled before dispatch",
                ));
            }
        }
        let mut operation = self.entries[index].operation.clone();
        operation.outcome = AcceptedOutcome::CancelledBeforeDispatch {
            admission: Accepted::Value,
            reason,
        };
        self.replace(index, operation.clone(), expires)?;
        Ok(operation)
    }
    pub fn begin_next(
        &mut self,
        source_generation: &str,
        execution_image_digest: &str,
        expires: Instant,
    ) -> Result<Option<Dispatch>> {
        self.current(expires)?;
        if !digest(source_generation) || !digest(execution_image_digest) {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "invalid execution identity",
            ));
        }
        if self
            .entries
            .iter()
            .any(|entry| entry.operation.outcome.fenced())
        {
            return Err(JournalError::new(
                ErrorKind::Fenced,
                "running or unknown operation retains the serialization fence",
            ));
        }
        let Some(index) = self
            .entries
            .iter()
            .position(|entry| matches!(entry.operation.outcome, AcceptedOutcome::Queued { .. }))
        else {
            return Ok(None);
        };
        let mut operation = self.entries[index].operation.clone();
        if operation.identity.source_generation != source_generation
            || operation.identity.execution_image_digest != execution_image_digest
        {
            return Err(JournalError::new(
                ErrorKind::SourceMismatch,
                "oldest queued operation requires its exact execution image; queue was not skipped",
            ));
        }
        operation.outcome = AcceptedOutcome::running();
        self.replace(index, operation.clone(), expires)?;
        Ok(Some(Dispatch {
            operation,
            custody: Arc::clone(&self.custody),
        }))
    }
    fn transition_index(&self, dispatch: &Dispatch, expires: Instant) -> Result<usize> {
        self.current(expires)?;
        if !Arc::ptr_eq(&self.custody, &dispatch.custody) {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "dispatch belongs to another custody owner",
            ));
        }
        self.entries
            .iter()
            .position(|entry| {
                entry.operation == dispatch.operation
                    && matches!(entry.operation.outcome, AcceptedOutcome::Running { .. })
            })
            .ok_or_else(|| {
                JournalError::new(
                    ErrorKind::Invalid,
                    "dispatch no longer names the running operation",
                )
            })
    }
    /// Call only for an actually observed worker exit or validated daemon reply.
    /// An intent, successful write, timeout or lost reply is not a returned result.
    pub fn returned(
        &mut self,
        dispatch: &Dispatch,
        result: ReturnedResult,
        artifact_manifest_digest: Option<String>,
        expires: Instant,
    ) -> Result<Operation> {
        let index = self.transition_index(dispatch, expires)?;
        if !result.valid()
            || artifact_manifest_digest
                .as_deref()
                .is_some_and(|value| !digest(value))
        {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "invalid observed result or artifact digest",
            ));
        }
        let mut operation = dispatch.operation.clone();
        operation.outcome = AcceptedOutcome::Returned {
            admission: Accepted::Value,
            result,
            artifact_manifest_digest,
        };
        self.replace(index, operation.clone(), expires)?;
        Ok(operation)
    }
    pub fn unknown(&mut self, dispatch: &Dispatch, expires: Instant) -> Result<Operation> {
        let index = self.transition_index(dispatch, expires)?;
        let mut operation = dispatch.operation.clone();
        operation.outcome = AcceptedOutcome::unknown();
        self.replace(index, operation.clone(), expires)?;
        Ok(operation)
    }
}
fn encode(operation: &Operation) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(operation)
        .map_err(|_| JournalError::new(ErrorKind::Corrupt, "encode operation body"))?;
    let envelope = Envelope {
        schema: RECORD_SCHEMA.into(),
        body: operation.clone(),
        body_sha256: hash(&body),
    };
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|_| JournalError::new(ErrorKind::Corrupt, "encode operation envelope"))?;
    if bytes.len() > MAX_RECORD_BYTES {
        Err(JournalError::new(
            ErrorKind::Corrupt,
            "encoded operation exceeds byte bound",
        ))
    } else {
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests;
