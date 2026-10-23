//! Demand-start native renderer owner. Private per-project actors serialize
//! durable requests while independent projects own independent native workers.
//! Custody, backend identity, journal outcomes and project authority are distinct.
//! Filesystem/peer ownership assumes cooperative same-UID preservation; kernel
//! calls have no hard interruption bound. Git objects/worktree remain live data.
use crate::{
    renderer_backend as backend, service_git_view as git, service_image as image,
    service_journal as journal, service_protocol as wire,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStderr, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;
const CONFIG_SCHEMA: &str = "caws.render.owner.config.v1";
const OFFER_SCHEMA: &str = "caws.render.owner.offer.v1";
const PREPARED_SCHEMA: &str = "caws.render.owner.prepared.v1";
const TICK: Duration = Duration::from_millis(2);
mod observations;
use observations::{
    Observation, ObservationLog, git_capture_failure, image_admission_failure, observation_reason,
    prefix_file,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerLimits {
    pub max_connections: u16,
    pub max_projects: u16,
    pub max_backends: u16,
    pub max_queue_per_project: u16,
    pub max_frame_bytes: u32,
    pub max_retained_records: u16,
    pub first_frame_ms: u32,
    pub request_ms: u32,
    pub startup_ms: u32,
    pub idle_ms: u32,
    pub backend_idle_seconds: u32,
    pub cache_megabytes: u16,
    pub worker: backend::WorkerLimits,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerConfig {
    pub schema: String,
    pub home: PathBuf,
    pub client_root: PathBuf,
    pub template_root: PathBuf,
    pub client_shell_source: PathBuf,
    pub native_executable: PathBuf,
    pub limits: OwnerLimits,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedImage {
    pub schema: String,
    pub image_key: String,
    pub image_digest: String,
    pub manifest: image::PreparedImageManifest,
    pub staging_root: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Offer {
    pub schema: String,
    pub prepared: PreparedImage,
    pub expected_selection: image::Selection,
    pub policy_sha256: String,
    pub checkout: String,
    pub session_id: String,
    pub invocation_id: String,
    pub caller_environment: BTreeMap<String, String>,
    pub remaining_budget_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerImage {
    pub image_key: String,
    pub image_digest: String,
    pub manifest: image::PreparedImageManifest,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerPrepared {
    pub schema: String,
    pub grant: wire::ServiceRenderGrant,
    pub image: OwnerImage,
    pub git_view: git::GitView,
    pub backend_pid: u32,
}
pub struct PreparedConnection {
    prepared: OwnerPrepared,
    stream: UnixStream,
}
impl PreparedConnection {
    pub fn prepared(&self) -> &OwnerPrepared {
        &self.prepared
    }
    pub fn stream(&self) -> &UnixStream {
        &self.stream
    }
    pub fn stream_mut(&mut self) -> &mut UnixStream {
        &mut self.stream
    }
    pub fn into_stream(self) -> UnixStream {
        self.stream
    }
    /// One bounded nonblocking read; empty means EOF, WouldBlock remains distinct.
    pub fn try_read_bounded(&mut self, limit: usize) -> io::Result<Vec<u8>> {
        if limit == 0 || limit > 4_194_304 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "read bound"));
        }
        let mut bytes = vec![0; limit.min(65_536)];
        let n = self.stream.read(&mut bytes)?;
        bytes.truncate(n);
        Ok(bytes)
    }
    /// One nonblocking write; the caller retains its partial-write cursor.
    pub fn write_frame(&mut self, frame: &[u8]) -> io::Result<usize> {
        send(&self.stream, frame)
    }
}
impl AsRawFd for PreparedConnection {
    fn as_raw_fd(&self) -> RawFd {
        self.stream.as_raw_fd()
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
fn check(expires: Instant) -> Result<()> {
    if Instant::now() >= expires {
        Err("renderer owner deadline expired".into())
    } else {
        Ok(())
    }
}
fn until(ms: u64, outer: Instant) -> Instant {
    outer.min(Instant::now() + Duration::from_millis(ms))
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn random() -> Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .map_err(err)?
        .read_exact(&mut bytes)
        .map_err(err)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn canonical(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|p| p.len() > 4096 || p.contains('\0'))
        || fs::canonicalize(path).map_err(err)? != path
    {
        return Err("renderer owner path is not canonical absolute".into());
    }
    Ok(())
}
fn private_dir(path: &Path, create: bool) -> Result<()> {
    if create {
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(err(e)),
        }
    }
    canonical(path)?;
    let m = fs::symlink_metadata(path).map_err(err)?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7777 != 0o700 {
        return Err("renderer owner directory is not private".into());
    }
    Ok(())
}
fn validate_config(c: &OwnerConfig) -> Result<()> {
    if c.schema != CONFIG_SCHEMA {
        return Err("renderer owner config schema".into());
    }
    for path in [
        &c.home,
        &c.client_root,
        &c.template_root,
        &c.client_shell_source,
        &c.native_executable,
    ] {
        canonical(path)?;
    }
    for path in [&c.native_executable, &c.client_shell_source] {
        let m = fs::symlink_metadata(path).map_err(err)?;
        if !m.is_file() || m.mode() & 0o022 != 0 {
            return Err("renderer owner trusted source permissions".into());
        }
    }
    let l = &c.limits;
    if !(1..=256).contains(&l.max_connections)
        || !(1..=128).contains(&l.max_projects)
        || !(1..=128).contains(&l.max_backends)
        || l.max_backends > l.max_projects
        || !(1..=256).contains(&l.max_queue_per_project)
        || !(1..=256).contains(&l.max_retained_records)
        || !(1024..=2_097_152).contains(&l.max_frame_bytes)
        || !(1..=86_400).contains(&l.backend_idle_seconds)
        || !(1..=4096).contains(&l.cache_megabytes)
        || ![
            l.first_frame_ms,
            l.request_ms,
            l.startup_ms,
            l.idle_ms,
            l.worker.startup_ms,
            l.worker.connect_ms,
            l.worker.write_ms,
            l.worker.render_ms,
            l.worker.read_ms,
            l.worker.cleanup_ms,
        ]
        .iter()
        .all(|v| (1..=300_000).contains(v))
    {
        return Err("renderer owner explicit limits invalid".into());
    }
    Ok(())
}
fn base(c: &OwnerConfig) -> PathBuf {
    c.home.join("state/render-service")
}
pub fn config_path(c: &OwnerConfig) -> PathBuf {
    base(c).join("config.json")
}
fn custody_path(c: &OwnerConfig) -> PathBuf {
    base(c).join("custody")
}
fn rendezvous(c: &OwnerConfig) -> PathBuf {
    PathBuf::from("/private/tmp").join(format!(
        "caws-render-{}-{}",
        unsafe { libc::geteuid() },
        &sha(c.home.as_os_str().as_encoded_bytes())[..24]
    ))
}
fn socket_path(c: &OwnerConfig) -> PathBuf {
    rendezvous(c).join("owner.sock")
}
fn stamp(m: &fs::Metadata) -> (u64, u64, u64, u32, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mode(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
pub fn read_config(path: &Path) -> Result<OwnerConfig> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(err)?;
    let m = f.metadata().map_err(err)?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
        || m.len() > 65_536
    {
        return Err("renderer owner config is not a private bounded regular file".into());
    }
    let mut bytes = Vec::new();
    f.take(65_537).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() > 65_536 || stamp(&m) != stamp(&fs::symlink_metadata(path).map_err(err)?) {
        return Err("renderer owner config changed".into());
    }
    let c: OwnerConfig = serde_json::from_slice(&bytes).map_err(err)?;
    validate_config(&c)?;
    if config_path(&c) != path {
        return Err("renderer owner config outside native-derived path".into());
    }
    private_dir(&base(&c), false)?;
    Ok(c)
}
fn same_config(a: &OwnerConfig, b: &OwnerConfig) -> Result<()> {
    if serde_json::to_vec(a).map_err(err)? != serde_json::to_vec(b).map_err(err)? {
        return Err("renderer owner configuration changed; incompatible upgrade refused".into());
    }
    Ok(())
}
/// Explicit first installation only. No acquire-error recovery calls this path.
pub fn provision(c: &OwnerConfig, expires: Instant) -> Result<()> {
    validate_config(c)?;
    check(expires)?;
    canonical(&c.home.join("state"))?;
    private_dir(&base(c), true)?;
    if fs::read_dir(base(c)).map_err(err)?.next().is_some() {
        return Err("renderer service initialization requires pristine state".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(config_path(c))
        .map_err(err)?;
    file.write_all(&serde_json::to_vec(c).map_err(err)?)
        .map_err(err)?;
    file.sync_all().map_err(err)?;
    private_dir(&custody_path(c), true)?;
    let custody = journal::Custody::initialize(&custody_path(c), expires).map_err(err)?;
    drop(custody);
    File::open(base(c)).map_err(err)?.sync_all().map_err(err)?;
    check(expires)
}
fn peer(stream: &UnixStream) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut uid = 0;
        let mut gid = 0;
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
            || uid != unsafe { libc::geteuid() }
        {
            return Err("renderer owner peer UID mismatch".into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of_val(&cred) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            )
        } != 0
            || len as usize != std::mem::size_of_val(&cred)
            || cred.uid != unsafe { libc::geteuid() }
        {
            return Err("renderer owner peer UID mismatch".into());
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = stream;
        return Err("renderer owner peer credentials unsupported".into());
    }
    Ok(())
}
fn send(stream: &UnixStream, bytes: &[u8]) -> io::Result<usize> {
    let n = unsafe {
        libc::send(
            stream.as_raw_fd(),
            bytes.as_ptr().cast(),
            bytes.len(),
            libc::MSG_NOSIGNAL,
        )
    };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}
fn write_all(stream: &UnixStream, mut bytes: &[u8], expires: Instant) -> Result<()> {
    while !bytes.is_empty() {
        check(expires)?;
        match send(stream, bytes) {
            Ok(0) => return Err("renderer owner closed during write".into()),
            Ok(n) => bytes = &bytes[n..],
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                thread::sleep(TICK)
            }
            Err(e) => return Err(err(e)),
        }
    }
    Ok(())
}
fn frame(
    stream: &mut UnixStream,
    pending: &mut Vec<u8>,
    limit: usize,
    expires: Instant,
) -> Result<Vec<u8>> {
    frame_while(stream, pending, limit, expires, || Ok(()))
}
fn frame_while(
    stream: &mut UnixStream,
    pending: &mut Vec<u8>,
    limit: usize,
    expires: Instant,
    mut watch: impl FnMut() -> Result<()>,
) -> Result<Vec<u8>> {
    loop {
        check(expires)?;
        watch()?;
        if let Some(at) = pending.iter().position(|b| *b == b'\n') {
            if at + 1 > limit {
                return Err("renderer owner frame too large".into());
            }
            return Ok(pending.drain(..=at).collect());
        }
        if pending.len() >= limit {
            return Err("renderer owner frame too large".into());
        }
        let mut bytes = [0u8; 8192];
        let available = (limit - pending.len()).min(bytes.len());
        match stream.read(&mut bytes[..available]) {
            Ok(0) => return Err("renderer owner peer EOF".into()),
            Ok(n) => pending.extend_from_slice(&bytes[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                thread::sleep(TICK)
            }
            Err(e) => return Err(err(e)),
        }
    }
}
/// The request's write EOF is required framing. Only loss of the caller's
/// response reader withdraws the request; no probe bytes are written.
fn response_channel(stream: &UnixStream) -> Result<()> {
    let mut state = libc::pollfd {
        fd: stream.as_raw_fd(),
        events: libc::POLLOUT,
        revents: 0,
    };
    if unsafe { libc::poll(&mut state, 1, 0) } < 0 {
        let failure = io::Error::last_os_error();
        if failure.kind() != io::ErrorKind::Interrupted {
            return Err(err(failure));
        }
    } else if state.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
        return Err("renderer caller response channel closed".into());
    }
    Ok(())
}
/// The prepared connection carries exactly one bridge request and a write EOF.
/// No request bytes are released for decode/admission/dispatch until EOF; the
/// first Offer deliberately uses frame() because this connection stays open.
fn bridge_frame_eof(stream: &mut UnixStream, limit: usize, expires: Instant) -> Result<Vec<u8>> {
    let mut pending = Vec::new();
    let bytes = frame(stream, &mut pending, limit, expires)?;
    if !pending.is_empty() {
        return Err("renderer owner bridge request has surplus bytes".into());
    }
    loop {
        check(expires)?;
        let mut extra = [0u8; 1];
        match stream.read(&mut extra) {
            Ok(0) => return Ok(bytes),
            Ok(_) => return Err("renderer owner bridge request has surplus bytes".into()),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                thread::sleep(TICK)
            }
            Err(e) => return Err(err(e)),
        }
    }
}
fn encoded<T: Serialize>(v: &T, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(v).map_err(err)?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err("renderer owner encoded frame too large".into());
    }
    Ok(bytes)
}
/// Connect/start only the native-derived resident owner; no custody initialization.
fn connect(c: &OwnerConfig, expires: Instant) -> Result<UnixStream> {
    validate_config(c)?;
    same_config(c, &read_config(&config_path(c))?)?;
    check(expires)?;
    let startup = until(c.limits.startup_ms as u64, expires);
    let mut launched: Option<Child> = None;
    let mut start_lock: Option<File> = None;
    let stream = loop {
        check(startup)?;
        match UnixStream::connect(socket_path(c)) {
            Ok(s) => break s,
            Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ECONNREFUSED)) => {
                if launched.is_none() {
                    if start_lock.is_none() {
                        let lock = OpenOptions::new()
                            .read(true)
                            .write(true)
                            .create(true)
                            .truncate(false)
                            .mode(0o600)
                            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                            .open(base(c).join("startup.lock"))
                            .map_err(err)?;
                        let m = lock.metadata().map_err(err)?;
                        if !m.is_file()
                            || m.len() != 0
                            || m.nlink() != 1
                            || m.uid() != unsafe { libc::geteuid() }
                            || m.mode() & 0o7777 != 0o600
                        {
                            return Err("renderer owner startup lock unsafe".into());
                        }
                        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }
                            != 0
                        {
                            let e = io::Error::last_os_error();
                            if matches!(
                                e.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                            ) {
                                thread::sleep(TICK);
                                continue;
                            }
                            return Err(err(e));
                        }
                        start_lock = Some(lock);
                        // Recheck after serializing startup; another frontend
                        // may have published the resident socket while we waited.
                        continue;
                    }
                    let mut cmd = Command::new(&c.native_executable);
                    cmd.arg("renderer-host")
                        .arg("--config")
                        .arg(config_path(c))
                        .env_clear()
                        .env("HOME", &c.home)
                        .env("PATH", "/usr/bin:/bin")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    unsafe {
                        cmd.pre_exec(|| {
                            if libc::setsid() < 0 {
                                Err(io::Error::last_os_error())
                            } else {
                                Ok(())
                            }
                        });
                    }
                    launched = Some(cmd.spawn().map_err(err)?);
                }
                if let Some(child) = launched.as_mut()
                    && child.try_wait().map_err(err)?.is_some()
                {
                    return Err("renderer owner startup exited".into());
                }
                thread::sleep(TICK);
            }
            Err(e) => return Err(err(e)),
        }
    };
    drop(start_lock);
    peer(&stream)?;
    stream.set_nonblocking(true).map_err(err)?;
    Ok(stream)
}
pub fn prepare(c: &OwnerConfig, offer: Offer, expires: Instant) -> Result<PreparedConnection> {
    let mut stream = connect(c, expires)?;
    let bytes = encoded(&offer, c.limits.max_frame_bytes as usize)?;
    write_all(&stream, &bytes, expires)?;
    let mut pending = Vec::new();
    let bytes = frame(
        &mut stream,
        &mut pending,
        c.limits.max_frame_bytes as usize,
        expires,
    )?;
    if !pending.is_empty() {
        return Err("renderer owner unsolicited prepared bytes".into());
    }
    let prepared: OwnerPrepared = serde_json::from_slice(&bytes).map_err(err)?;
    validate_prepared(&offer, &prepared)?;
    Ok(PreparedConnection { prepared, stream })
}
fn validate_prepared(offer: &Offer, prepared: &OwnerPrepared) -> Result<()> {
    let manifest = &offer.prepared.manifest;
    let selected = offer
        .expected_selection
        .handlers
        .get(offer.expected_selection.selected_index as usize)
        .ok_or("selected handler missing")?;
    let client = manifest
        .execution
        .files
        .iter()
        .find(|f| f.path == "client/service-client.js")
        .ok_or("image client missing")?;
    let grant = &prepared.grant;
    if prepared.schema != PREPARED_SCHEMA
        || prepared.image.image_key != offer.prepared.image_key
        || prepared.image.image_digest != offer.prepared.image_digest
        || prepared.image.manifest != *manifest
        || prepared.image.manifest.selection != offer.expected_selection
        || prepared.backend_pid <= 1
        || prepared.git_view.git_work_tree != Path::new(&offer.checkout)
        || grant.invocation_id != offer.invocation_id
        || grant.canonical_project != offer.expected_selection.canonical_project
        || grant.selected_index != offer.expected_selection.selected_index
        || grant.source_generation != manifest.source_generation
        || grant.original_handler_entry != selected.entry
        || grant.original_handler_path != selected.path
        || grant.original_source.handler_sha256 != selected.sha256
        || grant.original_source.closure_digest != manifest.original_closure_digest
        || grant.execution_image.image_digest != offer.prepared.image_digest
        || grant.execution_image.client_sha256 != client.sha256
        || grant.hooks_directory
            != Path::new(&manifest.execution.root)
                .join(&manifest.execution.hooks)
                .to_str()
                .ok_or("hooks encoding")?
        || grant.lease_file
            != Path::new(&offer.expected_selection.canonical_project)
                .join(".caws/sessions/.renderer-daemon.json")
                .to_str()
                .ok_or("lease encoding")?
        || grant.remaining_budget_ms > offer.remaining_budget_ms
    {
        return Err("renderer owner prepared binding mismatch".into());
    }
    grant.validate().map_err(err)
}

#[cfg(feature = "sqlite-store")]
mod store;
#[cfg(feature = "sqlite-store")]
pub use store::{
    StoreAcquire, StoreCompletion, StoreStatus, StoreStatusQuery, acquire_store, store_status,
};

mod pending;
use pending::*;
mod relay;
mod session;
pub use session::{
    SessionAcquire, SessionAcquisition, SessionCompletion, SessionInvocation, acquire_session,
};

struct Budget {
    used: usize,
    maximum: usize,
}
#[derive(Debug)]
struct BackendCapacityExhausted {
    used: usize,
    maximum: usize,
}
impl From<BackendCapacityExhausted> for String {
    fn from(_: BackendCapacityExhausted) -> Self {
        "renderer backend capacity exhausted; unknown reservations retained".into()
    }
}
impl Budget {
    fn reserve(&mut self) -> std::result::Result<(), BackendCapacityExhausted> {
        if self.used >= self.maximum {
            return Err(BackendCapacityExhausted {
                used: self.used,
                maximum: self.maximum,
            });
        }
        self.used += 1;
        Ok(())
    }
    fn release(&mut self) {
        assert!(self.used > 0);
        self.used -= 1;
    }
}
struct Actor {
    config: Arc<OwnerConfig>,
    custody: Arc<journal::Custody>,
    writer_custody: Option<Arc<journal::Custody>>,
    writer_intent: Option<crate::render_writer::WriterIntent>,
    journal: journal::Journal,
    budget: Arc<Mutex<Budget>>,
    process: Option<BackendProcess>,
    reserved: bool,
    unknown: bool,
    observations: Arc<ObservationLog>,
    phase: &'static str,
    #[cfg(feature = "sqlite-store")]
    store_records: Vec<Arc<Mutex<store::StoreRecord>>>,
}
struct BackendProcess {
    child: Option<Child>,
    control: UnixStream,
    pending: Vec<u8>,
    backend_pid: u32,
    image_digest: String,
    view: git::GitView,
    directory: PathBuf,
    cleanup_seen: bool,
    cleanup_exit: Option<backend::BackendExit>,
    observations: Arc<ObservationLog>,
    stderr: Option<ChildStderr>,
    stderr_nonblocking: bool,
    stderr_prefix: Vec<u8>,
    control_unavailable_logged: bool,
    retained_exit_logged: bool,
}
struct ScratchDirectory {
    path: PathBuf,
    transferred: bool,
}
impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        if !self.transferred {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
impl BackendProcess {
    fn drain_stderr(&mut self) {
        if !self.stderr_nonblocking {
            return;
        }
        let Some(stderr) = self.stderr.as_mut() else {
            return;
        };
        let mut remaining = 65_536;
        let mut bytes = [0u8; 4096];
        while remaining > 0 {
            match stderr.read(&mut bytes) {
                Ok(0) => {
                    self.stderr.take();
                    break;
                }
                Ok(n) => {
                    remaining -= n;
                    let retain = n.min(512 - self.stderr_prefix.len());
                    self.stderr_prefix.extend_from_slice(&bytes[..retain]);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }
    fn control_unavailable(&mut self) {
        self.drain_stderr();
        if !self.control_unavailable_logged {
            self.observations
                .emit(Observation::WorkerControlUnavailable {
                    native_worker_pid: self.child.as_ref().map(Child::id),
                    backend_pid: self.backend_pid,
                    worker_stderr_prefix_base64: STANDARD.encode(&self.stderr_prefix),
                });
            self.control_unavailable_logged = true;
        }
        if !self.retained_exit_logged
            && let Some(child) = &self.child
        {
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.id() as libc::id_t,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            } == 0
            {
                let info = unsafe { info.assume_init() };
                let pid = unsafe { info.si_pid() };
                if pid == child.id() as i32 {
                    self.observations.emit(Observation::WorkerRetainedExit {
                        native_worker_pid: child.id(),
                        backend_pid: self.backend_pid,
                        observed_pid: pid,
                        waitid_code: info.si_code,
                        worker_stderr_prefix_base64: STANDARD.encode(&self.stderr_prefix),
                    });
                    self.retained_exit_logged = true;
                }
            }
        }
    }
    fn viable(&mut self) -> Result<bool> {
        let child = self.child.as_ref().ok_or("worker already reaped")?;
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(err(io::Error::last_os_error()));
        }
        let observed = unsafe { info.assume_init().si_pid() };
        if observed != 0 {
            return Ok(false);
        }
        if !self.pending.is_empty() {
            return Ok(false);
        }
        let mut byte = 0u8;
        let count = unsafe {
            libc::recv(
                self.control.as_raw_fd(),
                (&mut byte as *mut u8).cast(),
                1,
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        if count >= 0 {
            return Ok(false);
        }
        let e = io::Error::last_os_error();
        if e.kind() == io::ErrorKind::WouldBlock {
            Ok(true)
        } else {
            Err(err(e))
        }
    }
    fn event(&mut self, expires: Instant) -> Result<backend::WorkerEvent> {
        self.event_while(expires, None)
    }
    fn event_while(
        &mut self,
        expires: Instant,
        caller: Option<&UnixStream>,
    ) -> Result<backend::WorkerEvent> {
        self.drain_stderr();
        let bytes = match frame_while(
            &mut self.control,
            &mut self.pending,
            backend::MAX_EVENT_BYTES,
            expires,
            || caller.map(response_channel).transpose().map(|_| ()),
        ) {
            Ok(bytes) => bytes,
            Err(reason) => {
                if caller.is_none_or(|stream| response_channel(stream).is_ok()) {
                    self.control_unavailable();
                }
                return Err(reason);
            }
        };
        self.drain_stderr();
        let event = backend::decode_event(&bytes)
            .map_err(|e| format!("worker event: {e:?}"))?
            .event;
        if let backend::WorkerEvent::Cleanup { receipt } = &event {
            self.cleanup_seen =
                (receipt.direct_child_reaped && receipt.stdout.eof && receipt.stderr.eof)
                    || (self.backend_pid == 0 && receipt.child_pid.is_none());
            self.cleanup_exit = receipt.backend_exit.clone();
            self.observations.emit(Observation::WorkerCleanup {
                native_worker_pid: self.child.as_ref().map(Child::id),
                backend_pid: self.backend_pid,
                receipt,
                stdout_prefix_base64: prefix_file(&self.directory.join("backend/stdout.bin")),
                stderr_prefix_base64: prefix_file(&self.directory.join("backend/stderr.bin")),
                worker_stderr_prefix_base64: STANDARD.encode(&self.stderr_prefix),
            });
        }
        if let backend::WorkerEvent::CleanupDeadline { child_pid } = &event {
            self.observations.emit(Observation::WorkerCleanupDeadline {
                native_worker_pid: self.child.as_ref().map(Child::id),
                backend_pid: *child_pid,
            });
        }
        if let backend::WorkerEvent::Failed { failure } = &event {
            self.observations.emit(Observation::WorkerFailure {
                native_worker_pid: self.child.as_ref().map(Child::id),
                failure: *failure,
            });
        }
        Ok(event)
    }
    /// Only the worker's observed backend cleanup permits releasing this slot.
    /// EOF/failure without cleanup quarantines the actual Child and custody.
    fn retire(&mut self) -> Option<backend::BackendExit> {
        let request = backend::encode_command(backend::HostCommand::Stop);
        if let Ok(bytes) = request {
            let _ = write_all(
                &self.control,
                &bytes,
                Instant::now() + Duration::from_millis(100),
            );
        }
        let _ = self.control.shutdown(std::net::Shutdown::Write);
        while !self.cleanup_seen {
            let _ = self.event(Instant::now() + Duration::from_millis(100));
            if !self.cleanup_seen {
                thread::sleep(TICK);
            }
        }
        if let Some(child) = self.child.as_mut() {
            loop {
                match child.wait() {
                    Ok(status) => {
                        self.observations.emit(Observation::WorkerExit {
                            native_worker_pid: child.id(),
                            backend_pid: self.backend_pid,
                            code: status.code(),
                            signal: status.signal(),
                            worker_stderr_prefix_base64: STANDARD.encode(&self.stderr_prefix),
                        });
                        break;
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => thread::sleep(TICK),
                }
            }
        }
        self.child.take();
        let _ = fs::remove_dir_all(&self.directory);
        self.cleanup_exit.clone()
    }
}
impl Drop for BackendProcess {
    fn drop(&mut self) {
        if self.child.is_some() {
            self.retire();
        }
    }
}

fn high_duplicate(fd: RawFd) -> Result<OwnedFd> {
    let raw = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if raw < 0 {
        return Err(err(io::Error::last_os_error()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}
struct WorkerCustody<'a> {
    machine: &'a journal::Custody,
    writer: &'a journal::Custody,
}
#[derive(Debug)]
struct SpawnFailure {
    reason: String,
    child_started: bool,
    stage: journal::NotStartedStage,
    errno: Option<i32>,
}
impl From<String> for SpawnFailure {
    fn from(reason: String) -> Self {
        Self {
            reason,
            child_started: false,
            stage: journal::NotStartedStage::Preparation,
            errno: None,
        }
    }
}
impl From<&str> for SpawnFailure {
    fn from(reason: &str) -> Self {
        reason.to_owned().into()
    }
}
impl SpawnFailure {
    fn started(reason: String) -> Self {
        Self {
            reason,
            child_started: true,
            stage: journal::NotStartedStage::Spawn,
            errno: None,
        }
    }
}
fn spawn_worker(
    c: &OwnerConfig,
    custody: WorkerCustody<'_>,
    manifest: &image::PreparedImageManifest,
    view: git::GitView,
    directory: PathBuf,
    observations: Arc<ObservationLog>,
    expires: Instant,
) -> std::result::Result<BackendProcess, SpawnFailure> {
    let root = PathBuf::from(&manifest.execution.root);
    let hooks = root.join(&manifest.execution.hooks);
    let python = manifest
        .toolchain_tcb
        .tools
        .iter()
        .find(|t| t.name == "python3")
        .ok_or("image Python missing")?;
    let work_dir = directory.join("backend");
    private_dir(&work_dir, true)?;
    let spec = backend::PinnedBackendSpec {
        python: backend::PinnedFile {
            path: python.path.clone().into(),
            sha256: python.sha256.clone(),
        },
        hooks_dir: hooks.clone(),
        image_files: manifest
            .execution
            .files
            .iter()
            .filter(|f| f.path.starts_with("hooks/"))
            .map(|f| backend::PinnedFile {
                path: root.join(&f.path),
                sha256: f.sha256.clone(),
            })
            .collect(),
        image_digest: sha(&serde_json::to_vec(manifest).map_err(err)?),
        work_dir,
        home: c.home.clone(),
        search_path: root
            .join("bin")
            .to_str()
            .ok_or("image PATH encoding")?
            .to_owned(),
        agent_surface: manifest.selection.surface.clone(),
        idle_seconds: c.limits.backend_idle_seconds,
        cache_megabytes: c.limits.cache_megabytes,
        git_view: Some(view.clone()),
    };
    let configuration = backend::entry::WorkerConfiguration {
        schema: "caws.renderer.worker.configuration.v1".into(),
        backend: spec,
        limits: c.limits.worker,
    };
    let config_file = directory.join("worker.json");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&config_file)
        .map_err(err)?;
    file.write_all(&serde_json::to_vec(&configuration).map_err(err)?)
        .map_err(err)?;
    file.sync_all().map_err(err)?;
    file.set_permissions(fs::Permissions::from_mode(0o400))
        .map_err(err)?;
    drop(file);
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&config_file)
        .map_err(err)?;
    let (host, worker) = UnixStream::pair().map_err(err)?;
    host.set_nonblocking(true).map_err(err)?;
    let worker_fd = high_duplicate(worker.as_raw_fd())?;
    let config_fd = high_duplicate(file.as_raw_fd())?;
    let lifetime = custody.machine.duplicate_lifetime(expires).map_err(err)?;
    let lifetime_fd = high_duplicate(lifetime.as_raw_fd())?;
    let writer_lifetime = custody.writer.duplicate_lifetime(expires).map_err(err)?;
    let writer_lifetime_fd = high_duplicate(writer_lifetime.as_raw_fd())?;
    let descriptors = [
        (worker_fd.as_raw_fd(), 3),
        (config_fd.as_raw_fd(), 4),
        (lifetime_fd.as_raw_fd(), 6),
        (writer_lifetime_fd.as_raw_fd(), 7),
    ];
    let mut command = Command::new(&c.native_executable);
    command
        .arg("renderer-worker")
        .env_clear()
        .env("HOME", &c.home)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            for (source, target) in descriptors {
                if libc::dup2(source, target) < 0 || libc::fcntl(target, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    check(expires)?;
    let mut child = command.spawn().map_err(|failure| SpawnFailure {
        reason: err(&failure),
        child_started: false,
        stage: journal::NotStartedStage::Spawn,
        errno: failure.raw_os_error(),
    })?;
    let stderr = child.stderr.take();
    let stderr_nonblocking = if let Some(stderr) = &stderr {
        let flags = unsafe { libc::fcntl(stderr.as_raw_fd(), libc::F_GETFL) };
        flags >= 0
            && unsafe { libc::fcntl(stderr.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                == 0
    } else {
        false
    };
    observations.emit(Observation::WorkerSpawned {
        native_worker_pid: child.id(),
        image_digest: &configuration.backend.image_digest,
        git_metadata_digest: &view.metadata_digest,
    });
    drop(worker);
    let mut process = BackendProcess {
        child: Some(child),
        control: host,
        pending: Vec::new(),
        backend_pid: 0,
        image_digest: configuration.backend.image_digest.clone(),
        view,
        directory,
        cleanup_seen: false,
        cleanup_exit: None,
        observations,
        stderr,
        stderr_nonblocking,
        stderr_prefix: Vec::new(),
        control_unavailable_logged: false,
        retained_exit_logged: false,
    };
    let event = process
        .event(until(c.limits.worker.startup_ms as u64, expires))
        .map_err(SpawnFailure::started)?;
    match event {
        backend::WorkerEvent::Ready {
            readiness,
            child_pid,
            image_digest,
            ..
        } if readiness == "owned_child_lease_and_listener"
            && child_pid > 1
            && image_digest == process.image_digest =>
        {
            process.backend_pid = child_pid;
            process.observations.emit(Observation::WorkerCreated {
                native_worker_pid: process.child.as_ref().expect("owned worker").id(),
                backend_pid: child_pid,
                image_digest: &process.image_digest,
                git_metadata_digest: &process.view.metadata_digest,
            });
            Ok(process)
        }
        _ => Err(SpawnFailure::started(
            "worker did not establish owned-child readiness".into(),
        )),
    }
}

fn context(c: &OwnerConfig, offer: &Offer) -> image::AdmissionContext {
    image::AdmissionContext {
        home: c.home.clone(),
        canonical_project: offer.expected_selection.canonical_project.clone(),
        runtime_digest: offer.expected_selection.runtime_digest.clone(),
        client_root: c.client_root.clone(),
        template_root: c.template_root.clone(),
        client_shell_source: c.client_shell_source.clone(),
        native_executable: Some(c.native_executable.clone()),
        expected_selection: offer.expected_selection.clone(),
        expected_image_digest: offer.prepared.image_digest.clone(),
        expected_policy_sha256: offer.policy_sha256.clone(),
        caller_environment: offer.caller_environment.clone(),
    }
}
fn validate_offer(offer: &Offer) -> Result<()> {
    if offer.schema != OFFER_SCHEMA
        || offer.prepared.schema != "caws.service.prepared.image.v1"
        || !(1..=120_000).contains(&offer.remaining_budget_ms)
        || offer.session_id.is_empty()
        || offer.session_id.len() > 128
        || !offer
            .session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("invalid renderer owner offer".into());
    }
    canonical(Path::new(&offer.checkout))?;
    canonical(Path::new(&offer.expected_selection.canonical_project))?;
    if image::image_key(&offer.prepared.manifest).map_err(err)? != offer.prepared.image_key {
        return Err("renderer image key mismatch".into());
    }
    Ok(())
}
fn grant(offer: &Offer, expires: Instant) -> Result<wire::ServiceRenderGrant> {
    let manifest = &offer.prepared.manifest;
    let selected = offer
        .expected_selection
        .handlers
        .get(offer.expected_selection.selected_index as usize)
        .ok_or("selected handler missing")?;
    let client = manifest
        .execution
        .files
        .iter()
        .find(|f| f.path == "client/service-client.js")
        .ok_or("image client missing")?;
    let remaining = expires
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    let grant = wire::ServiceRenderGrant {
        schema: "caws.service.render.grant.v1".into(),
        grant_id: random()?,
        adapter: image::ADAPTER.into(),
        invocation_id: offer.invocation_id.clone(),
        selected_index: offer.expected_selection.selected_index,
        canonical_project: offer.expected_selection.canonical_project.clone(),
        source_generation: manifest.source_generation.clone(),
        original_source: wire::OriginalSource {
            handler_sha256: selected.sha256.clone(),
            closure_digest: manifest.original_closure_digest.clone(),
        },
        execution_image: wire::ExecutionImage {
            image_digest: offer.prepared.image_digest.clone(),
            client_sha256: client.sha256.clone(),
        },
        original_handler_entry: selected.entry.clone(),
        original_handler_path: selected.path.clone(),
        hooks_directory: Path::new(&manifest.execution.root)
            .join(&manifest.execution.hooks)
            .to_str()
            .ok_or("hooks path encoding")?
            .into(),
        lease_file: Path::new(&offer.expected_selection.canonical_project)
            .join(".caws/sessions/.renderer-daemon.json")
            .to_str()
            .ok_or("lease path encoding")?
            .into(),
        remaining_budget_ms: remaining,
    };
    grant.validate().map_err(err)?;
    Ok(grant)
}
fn outcome(operation: &journal::Operation) -> Result<wire::RenderOutcome> {
    serde_json::from_value(serde_json::to_value(operation.outcome()).map_err(err)?).map_err(err)
}
fn reject(
    request: &wire::RenderRequest,
    reason: impl Into<String>,
) -> Result<wire::RenderOutcomeFrame> {
    wire::RenderOutcomeFrame::for_request(
        request,
        wire::RenderOutcome::Rejected {
            reason: reason.into(),
        },
    )
    .map_err(err)
}
fn arguments_bound(
    request: &wire::RenderRequest,
    project: &str,
    checkout: &str,
    session: &str,
) -> bool {
    let logdir = Path::new(project).join(".caws/sessions").join(session);
    logdir.to_str().is_some_and(|p| request.arguments[0] == p)
        && request.arguments[1] == checkout
        && request.arguments[2] == session
        && backend::validate_arguments(&request.arguments).is_ok()
}
fn recover_journal(journal: &mut journal::Journal, expires: Instant) -> Result<bool> {
    // The old owner generation's connections and issued grants are withdrawn.
    // Only effects that never received Dispatch earn cancellation tombstones.
    for id in journal.queued_request_ids(expires).map_err(err)? {
        journal
            .cancel_queued(&id, journal::CancelReason::GrantWithdrawn, expires)
            .map_err(err)?;
    }
    journal.has_unknown(expires).map_err(err)
}
struct PreDispatchFailure {
    reason: journal::CancelReason,
    diagnostic: String,
}
fn begin_issued_dispatch(
    journal: &mut journal::Journal,
    request: &wire::RenderRequest,
    verified: &[u8],
    expires: Instant,
    revalidate: impl FnOnce() -> std::result::Result<(), PreDispatchFailure>,
) -> std::result::Result<journal::Dispatch, PreDispatchFailure> {
    let withdrawn = |diagnostic| PreDispatchFailure {
        reason: journal::CancelReason::GrantWithdrawn,
        diagnostic,
    };
    check(expires).map_err(withdrawn)?;
    revalidate()?;
    check(expires).map_err(withdrawn)?;
    // Prove the journal's oldest queued effect is this exact issued operation
    // before requesting Dispatch. A different queued ID never becomes running
    // merely because a newer connection exists in the same source generation.
    let queued = journal
        .queued_request_ids(expires)
        .map_err(|e| withdrawn(err(e)))?;
    if queued.first() != Some(&request.request_id) {
        return Err(withdrawn(
            "oldest queued request differs from issued request".into(),
        ));
    }
    let operation = journal
        .lookup(&request.request_id, expires)
        .map_err(|e| withdrawn(err(e)))?
        .ok_or_else(|| withdrawn("issued queued request unavailable".into()))?;
    if operation
        .verified_request()
        .map_err(|e| withdrawn(err(e)))?
        != verified
    {
        return Err(withdrawn(
            "retained queued request differs from issued request".into(),
        ));
    }
    journal
        .begin_next(
            &request.source_generation,
            &request.execution_image.image_digest,
            expires,
        )
        .map_err(|e| withdrawn(err(e)))?
        .ok_or_else(|| withdrawn("queued render unavailable".into()))
}
fn cancel_undispatched(
    journal: &mut journal::Journal,
    request_id: &str,
    reason: journal::CancelReason,
    record_ms: u32,
) -> Result<journal::Operation> {
    // The client/job expiry cannot be the deadline for retaining its withdrawal.
    // Each attempt has a fresh explicit custody-record budget; syscall latency
    // remains unbounded. Failed publication retains custody for quarantine/retry.
    let expires = Instant::now() + Duration::from_millis(record_ms as u64);
    let operation = journal
        .lookup(request_id, expires)
        .map_err(err)?
        .ok_or("queued cancellation record unavailable")?;
    match operation.outcome() {
        journal::AcceptedOutcome::Queued { .. } => journal
            .cancel_queued(request_id, reason, expires)
            .map_err(err),
        journal::AcceptedOutcome::CancelledBeforeDispatch { .. } => Ok(operation),
        _ => Err("queued cancellation refused after dispatch".into()),
    }
}
impl Actor {
    fn startup_failed(&mut self, failure: SpawnFailure) -> String {
        if failure.child_started {
            self.unknown = true;
        } else if let Some(intent) = self.writer_intent.take()
            && let Err(reason) = crate::render_writer::not_started(
                intent,
                failure.stage,
                failure.errno,
                Instant::now() + Duration::from_millis(self.config.limits.request_ms as u64),
            )
        {
            self.unknown = true;
            self.observations.emit(Observation::ActorError {
                stage: "writer_not_started",
                reason: observation_reason(&reason),
            });
        }
        self.retire();
        failure.reason
    }
    fn stage(&mut self, stage: &'static str, invocation_id: &str) {
        self.phase = stage;
        self.observations.emit(Observation::ActorStage {
            stage,
            invocation_id,
        });
    }
    fn check_unknown_fence(&mut self, invocation_id: &str, expires: Instant) -> Result<()> {
        if self.unknown || self.journal.has_unknown(expires).map_err(err)? {
            self.unknown = true;
            let (backend_used, backend_maximum) = {
                let budget = self.budget.lock().unwrap_or_else(|e| e.into_inner());
                (budget.used, budget.maximum)
            };
            self.observations.emit(Observation::AdmissionDenied {
                invocation_id,
                reason: observations::AdmissionDenial::UnknownFence,
                backend_used,
                backend_maximum,
            });
            return Err("project unknown effect retains backend reservation".into());
        }
        Ok(())
    }
    fn reserve_backend(&mut self, invocation_id: &str) -> Result<()> {
        let result = self
            .budget
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reserve();
        if let Err(capacity) = result {
            self.observations.emit(Observation::AdmissionDenied {
                invocation_id,
                reason: observations::AdmissionDenial::BackendCapacityExhausted,
                backend_used: capacity.used,
                backend_maximum: capacity.maximum,
            });
            return Err(capacity.into());
        }
        self.reserved = true;
        Ok(())
    }
    fn retire(&mut self) {
        self.retire_backend(false);
    }
    /// Retire the actual warm backend without releasing/reacquiring its writer
    /// capability. The operation keeps this exact Arc through SQL and ordinary
    /// generation consumption. Failed retirement retains the actor quarantine.
    fn publication_writer(
        &mut self,
        project: &Path,
        expires: Instant,
    ) -> Result<Arc<journal::Custody>> {
        if self.writer_custody.is_none() {
            self.writer_custody = Some(crate::render_writer::acquire(
                &self.config.home,
                project,
                expires,
            )?);
        }
        let retained = Arc::clone(self.writer_custody.as_ref().expect("writer acquired"));
        self.retire_backend(true);
        if self.unknown || self.process.is_some() || self.writer_intent.is_some() {
            return Err("publication writer retirement is unsettled".into());
        }
        if !Arc::ptr_eq(
            self.writer_custody.as_ref().expect("writer retained"),
            &retained,
        ) {
            return Err("publication writer handoff changed capability".into());
        }
        Ok(retained)
    }
    fn retire_backend(&mut self, keep_writer: bool) {
        let mut backend_exit = None;
        if let Some(mut process) = self.process.take() {
            backend_exit = process.retire();
        }
        if !self.unknown && self.writer_intent.is_some() {
            if let Some(exit) = backend_exit {
                let result = journal::ReturnedResult::ProcessExit {
                    code: exit.code.and_then(|code| u8::try_from(code).ok()),
                    signal: exit.signal.and_then(|signal| u8::try_from(signal).ok()),
                };
                if let Err(reason) = crate::render_writer::settle(
                    self.writer_intent.take().expect("writer intent observed"),
                    result,
                    Instant::now() + Duration::from_millis(self.config.limits.request_ms as u64),
                ) {
                    self.unknown = true;
                    self.observations.emit(Observation::ActorError {
                        stage: "writer_settle",
                        reason: observation_reason(&reason),
                    });
                }
            } else {
                self.unknown = true;
            }
        }
        if self.reserved && !self.unknown {
            self.budget
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .release();
            self.reserved = false;
        }
        if !keep_writer && !self.unknown && self.writer_intent.is_none() && self.process.is_none() {
            self.writer_custody.take();
        }
    }
    fn prepare_job(
        &mut self,
        job: &mut Job,
        cohort: Option<&PreparedState>,
    ) -> Result<Option<PreparedState>> {
        self.phase = "offer_validation";
        check(job.expires)?;
        validate_offer(&job.offer)?;
        self.phase = "config_revalidation";
        same_config(&self.config, &read_config(&config_path(&self.config))?)?;
        self.phase = "journal_fence";
        self.check_unknown_fence(&job.offer.invocation_id, job.expires)?;
        let context = context(&self.config, &job.offer);
        self.stage("image_admission", &job.offer.invocation_id);
        let admitted = if let Some(stage) = &job.offer.prepared.staging_root {
            let mut publication_observer = |publication| {
                self.observations.emit(Observation::ImagePublicationPhase {
                    invocation_id: &job.offer.invocation_id,
                    publication,
                });
            };
            image::publish_staged_image_observed(
                Path::new(stage),
                &context,
                job.expires,
                Some(&mut publication_observer),
            )
            .map_err(|failure| {
                image_admission_failure(&self.observations, &job.offer, &failure);
                err(failure)
            })?
            .image
        } else {
            image::validate_image(
                Path::new(&job.offer.prepared.manifest.execution.root),
                &context,
                job.expires,
            )
            .map_err(|failure| {
                image_admission_failure(&self.observations, &job.offer, &failure);
                err(failure)
            })?
        };
        if admitted.manifest() != &job.offer.prepared.manifest
            || admitted.image_digest() != job.offer.prepared.image_digest
        {
            return Err("admitted renderer image differs from offer".into());
        }
        self.stage("image_admission_complete", &job.offer.invocation_id);
        let disposition = admitted.prefix_concurrency();
        observations::prefix_disposition(&self.observations, &job.offer, &disposition);
        let isolation = PrefixIdentity::from_concurrency(disposition);
        if isolation
            .as_ref()
            .is_some_and(|proof| !proof.binds(&job.offer))
        {
            return Err("native prefix proof differs from admitted offer".into());
        }
        if let Some(held) = cohort
            && (isolation.is_none() || isolation != held.isolation)
        {
            return Ok(None);
        }
        if !self.reserved {
            self.reserve_backend(&job.offer.invocation_id)?;
        }
        self.stage("worker_namespace", &job.offer.invocation_id);
        let workers = base(&self.config).join("workers");
        private_dir(&workers, true)?;
        let directory = workers.join(random()?);
        private_dir(&directory, true)?;
        let mut scratch = ScratchDirectory {
            path: directory.clone(),
            transferred: false,
        };
        let git_tool = admitted
            .manifest()
            .toolchain_tcb
            .tools
            .iter()
            .find(|t| t.name == "git")
            .ok_or("image Git missing")?;
        self.stage("git_capture", &job.offer.invocation_id);
        let view = git::capture(
            &backend::PinnedFile {
                path: git_tool.path.clone().into(),
                sha256: git_tool.sha256.clone(),
            },
            Path::new(&job.offer.checkout),
            &self.config.home,
            &directory.join("git"),
            job.expires,
        )
        .inspect_err(|reason| git_capture_failure(&self.observations, reason))?;
        let viable = self
            .process
            .as_mut()
            .map(BackendProcess::viable)
            .transpose()?
            .unwrap_or(false);
        let reuse = viable
            && self.process.as_ref().is_some_and(|process| {
                BackendCohort::of(process).compatible(&job.offer.prepared.image_digest, &view)
            });
        if let Some(held) = cohort
            && (!reuse
                || self.process.as_ref().map(BackendCohort::of).as_ref() != Some(&held.cohort))
        {
            return Ok(None);
        }
        if reuse {
            let process = self.process.as_ref().expect("reuse requires owned worker");
            self.observations.emit(Observation::BackendReused {
                native_worker_pid: process.child.as_ref().expect("owned worker").id(),
                backend_pid: process.backend_pid,
                image_digest: &process.image_digest,
                git_metadata_digest: &process.view.metadata_digest,
            });
            fs::remove_dir_all(&directory).map_err(err)?;
        } else {
            // A changed private Git image or source generation retires and reaps
            // the previous actual worker before any replacement may be spawned.
            self.stage("backend_retirement", &job.offer.invocation_id);
            if self.process.is_some() {
                self.retire();
            }
            if self.unknown {
                return Err("renderer retirement retains an unresolved writer intent".into());
            }
            if self.writer_custody.is_none() {
                self.stage("writer_custody", &job.offer.invocation_id);
                self.writer_custody = Some(crate::render_writer::acquire(
                    &self.config.home,
                    Path::new(&job.offer.expected_selection.canonical_project),
                    job.expires,
                )?);
            }
            if !self.reserved {
                self.reserve_backend(&job.offer.invocation_id)?;
            }
            self.stage("pre_spawn_revalidation", &job.offer.invocation_id);
            admitted
                .revalidate(&context, job.expires)
                .map_err(|failure| {
                    image_admission_failure(&self.observations, &job.offer, &failure);
                    err(failure)
                })?;
            self.stage("worker_startup", &job.offer.invocation_id);
            let intent_bytes = serde_json::to_vec(&serde_json::json!({
                "schema": "caws.render.writer.backend-intent.v1",
                "canonicalProject": job.offer.expected_selection.canonical_project,
                "imageDigest": admitted.image_digest(),
                "sourceGeneration": admitted.manifest().source_generation,
            }))
            .map_err(err)?;
            self.writer_intent = Some(crate::render_writer::begin(
                Arc::clone(
                    self.writer_custody
                        .as_ref()
                        .expect("writer custody acquired"),
                ),
                Path::new(&job.offer.expected_selection.canonical_project),
                &admitted.manifest().source_generation,
                &intent_bytes,
                job.expires,
            )?);
            let spawned = spawn_worker(
                &self.config,
                WorkerCustody {
                    machine: &self.custody,
                    writer: self
                        .writer_custody
                        .as_deref()
                        .expect("writer custody acquired"),
                },
                admitted.manifest(),
                view,
                directory,
                Arc::clone(&self.observations),
                job.expires,
            );
            self.process = Some(match spawned {
                Ok(process) => process,
                Err(failure) => return Err(self.startup_failed(failure)),
            });
            scratch.transferred = true;
        }
        self.stage("prepared_revalidation", &job.offer.invocation_id);
        admitted
            .revalidate(&context, job.expires)
            .map_err(|failure| {
                image_admission_failure(&self.observations, &job.offer, &failure);
                err(failure)
            })?;
        self.stage("grant_issue", &job.offer.invocation_id);
        let issued = grant(&job.offer, job.expires)?;
        let process = self.process.as_ref().ok_or("backend unavailable")?;
        let prepared = OwnerPrepared {
            schema: PREPARED_SCHEMA.into(),
            grant: issued.clone(),
            image: OwnerImage {
                image_key: job.offer.prepared.image_key.clone(),
                image_digest: admitted.image_digest().into(),
                manifest: admitted.manifest().clone(),
            },
            git_view: process.view.clone(),
            backend_pid: process.backend_pid,
        };
        self.phase = "prepared_write";
        write_all(
            &job.stream,
            &encoded(&prepared, self.config.limits.max_frame_bytes as usize)?,
            job.expires,
        )?;
        self.observations.emit(Observation::Prepared {
            invocation_id: &job.offer.invocation_id,
            session_id: &job.offer.session_id,
            selected_index: job.offer.expected_selection.selected_index,
            backend_pid: process.backend_pid,
        });
        let cohort = BackendCohort::of(process);
        self.stage("bridge_read", &job.offer.invocation_id);
        job.reader_start
            .take()
            .ok_or("renderer bridge reader already started")?
            .try_send(())
            .map_err(|_| "renderer bridge reader unavailable")?;
        Ok(Some(PreparedState {
            admitted,
            context,
            issued,
            cohort,
            isolation,
        }))
    }
    fn finish_prepared(&mut self, pending: &PendingJob, incoming: Vec<u8>) -> Result<()> {
        let job = &pending.job;
        let PreparedState {
            admitted,
            context,
            issued,
            cohort,
            ..
        } = &pending.state;
        self.check_unknown_fence(&job.offer.invocation_id, job.expires)?;
        check(job.expires)?;
        if self.process.as_ref().map(BackendCohort::of).as_ref() != Some(cohort) {
            return Err("prepared backend cohort differs from owned generation".into());
        }
        self.stage("bridge_dequeued", &job.offer.invocation_id);
        self.phase = "bridge_validation";
        let incoming = wire::decode_service_bridge_request(&incoming, issued).map_err(err)?;
        let expected = issued
            .request(incoming.request.arguments.clone())
            .map_err(err)?;
        wire::validate_issued_request(&incoming, issued, &expected).map_err(err)?;
        let result = self.execute(&expected, job, admitted, context)?;
        let (execution, served, cached) = match &result.outcome {
            wire::RenderOutcome::Rejected { .. } => ("rejected", None, None),
            wire::RenderOutcome::Queued => ("queued", None, None),
            wire::RenderOutcome::Running => ("running", None, None),
            wire::RenderOutcome::Unknown => ("unknown", None, None),
            wire::RenderOutcome::CancelledBeforeDispatch { .. } => {
                ("cancelled_before_dispatch", None, None)
            }
            wire::RenderOutcome::Returned {
                result: wire::RenderResult::DaemonResponse { served, cached, .. },
                ..
            } => ("daemon_response", Some(*served), Some(*cached)),
            wire::RenderOutcome::Returned {
                result: wire::RenderResult::ProcessExit { .. },
                ..
            } => ("process_exit", None, None),
        };
        self.observations.emit(Observation::RenderOutcome {
            request_id: &expected.request_id,
            execution,
            served,
            cached,
        });
        self.phase = "bridge_reply_write";
        let bytes = wire::encode_service_bridge_reply(issued, &expected, &result).map_err(err)?;
        write_all(&job.stream, &bytes, job.expires)?;
        job.stream
            .shutdown(std::net::Shutdown::Write)
            .map_err(err)?;
        Ok(())
    }
    fn execute(
        &mut self,
        request: &wire::RenderRequest,
        job: &Job,
        admitted: &image::ValidatedImage,
        context: &image::AdmissionContext,
    ) -> Result<wire::RenderOutcomeFrame> {
        let offer = &job.offer;
        let caller = &job.stream;
        let expires = job.expires;
        // These positional writes are constrained independently of client hashes.
        self.phase = "argument_binding";
        if !arguments_bound(
            request,
            &offer.expected_selection.canonical_project,
            &offer.checkout,
            &offer.session_id,
        ) {
            return reject(
                request,
                "renderer arguments do not match issued checkout/session/log directory",
            );
        }
        self.stage("dispatch_source_revalidation", &offer.invocation_id);
        admitted.revalidate(context, expires).map_err(|failure| {
            image_admission_failure(&self.observations, offer, &failure);
            err(failure)
        })?;
        self.stage(
            "dispatch_source_revalidation_complete",
            &offer.invocation_id,
        );
        let verified = wire::encode_render_request(request).map_err(err)?;
        let identity = journal::Identity {
            request_id: request.request_id.clone(),
            argument_digest: request.argument_digest.clone(),
            project_service_key: request.project_service_key.clone(),
            source_generation: request.source_generation.clone(),
            execution_image_digest: request.execution_image.image_digest.clone(),
        };
        self.phase = "journal_admission";
        match self
            .journal
            .admit(identity, &verified, expires)
            .map_err(err)?
        {
            journal::Admission::Rejected(rejected) => {
                let v = serde_json::to_value(rejected).map_err(err)?;
                return reject(
                    request,
                    v["reason"].as_str().unwrap_or("journal refused request"),
                );
            }
            journal::Admission::Accepted {
                operation,
                duplicate: true,
            } => {
                return wire::RenderOutcomeFrame::for_request(request, outcome(&operation)?)
                    .map_err(err);
            }
            journal::Admission::Accepted { .. } => {}
        }
        self.stage("journal_dispatch", &request.invocation_id);
        let observations = Arc::clone(&self.observations);
        let dispatch =
            match begin_issued_dispatch(&mut self.journal, request, &verified, expires, || {
                response_channel(caller).map_err(|diagnostic| PreDispatchFailure {
                    reason: journal::CancelReason::GrantWithdrawn,
                    diagnostic,
                })?;
                observations.emit(Observation::ActorStage {
                    stage: "pre_dispatch_source_revalidation",
                    invocation_id: &request.invocation_id,
                });
                admitted.revalidate(context, expires).map_err(|failure| {
                    image_admission_failure(&observations, offer, &failure);
                    PreDispatchFailure {
                        reason: if failure.kind == image::ErrorKind::Changed {
                            journal::CancelReason::SourceRetired
                        } else {
                            journal::CancelReason::GrantWithdrawn
                        },
                        diagnostic: err(failure),
                    }
                })?;
                observations.emit(Observation::ActorStage {
                    stage: "pre_dispatch_source_revalidation_complete",
                    invocation_id: &request.invocation_id,
                });
                Ok(())
            }) {
                Ok(dispatch) => dispatch,
                Err(failure) => {
                    self.observations.emit(Observation::ActorError {
                        stage: "pre_dispatch",
                        reason: observation_reason(&failure.diagnostic),
                    });
                    self.phase = "queued_cancellation";
                    // Until the queued-only tombstone is retained, this actor cannot
                    // accept a later job and accidentally dispatch the withdrawn ID.
                    // Publication uncertainty quarantines; no known non-attempt is
                    // relabelled unknown and no Dispatch/running effect is cancelled.
                    let mut reported = false;
                    let cancelled = loop {
                        match cancel_undispatched(
                            &mut self.journal,
                            &request.request_id,
                            failure.reason,
                            self.config.limits.request_ms,
                        ) {
                            Ok(operation) => break operation,
                            Err(reason) => {
                                if !reported {
                                    self.observations.emit(Observation::ActorError {
                                        stage: "queued_cancellation",
                                        reason: observation_reason(&reason),
                                    });
                                    reported = true;
                                }
                                thread::sleep(TICK);
                            }
                        }
                    };
                    self.observations.emit(Observation::QueuedCancelled {
                        request_id: &request.request_id,
                        reason: failure.reason,
                    });
                    return wire::RenderOutcomeFrame::for_request(request, outcome(&cancelled)?)
                        .map_err(err);
                }
            };
        self.observations.emit(Observation::JournalDispatch {
            request_id: &request.request_id,
            native_worker_pid: self
                .process
                .as_ref()
                .and_then(|p| p.child.as_ref().map(Child::id)),
            backend_pid: self.process.as_ref().map(|p| p.backend_pid),
        });
        self.phase = "worker_render";
        let result = self.dispatch(request, caller, expires);
        // Once Dispatch exists, every unobserved result retains unknown. Never
        // infer render success from worker exit or retry a potentially sent write.
        let record_deadline =
            Instant::now() + Duration::from_millis(self.config.limits.request_ms as u64);
        self.phase = "journal_outcome";
        let operation = match result {
            Ok(response) => self
                .journal
                .returned(
                    &dispatch,
                    journal::ReturnedResult::DaemonResponse {
                        response: journal::OkResponse::Value,
                        served: response.served,
                        elapsed_ms: response.elapsed_ms,
                        cached: response.cached,
                    },
                    None,
                    record_deadline,
                )
                .map_err(err),
            Err(reason) => {
                self.observations.emit(Observation::ActorError {
                    stage: "worker_render",
                    reason: observation_reason(&reason),
                });
                self.unknown = true;
                self.journal
                    .unknown(&dispatch, record_deadline)
                    .map_err(err)
            }
        };
        if operation.is_err() {
            self.unknown = true;
        }
        // The actor withdraws all prepared grants before quarantine cleanup.
        // Dispatch already retained Running. Failed outcome publication may
        // leave that record, publish its replacement, or poison this handle;
        // none permits this owner to issue another effect.
        wire::RenderOutcomeFrame::for_request(request, outcome(&operation?)?).map_err(err)
    }
    fn dispatch(
        &mut self,
        request: &wire::RenderRequest,
        caller: &UnixStream,
        expires: Instant,
    ) -> Result<backend::DaemonResponse> {
        let process = self.process.as_mut().ok_or("backend process unavailable")?;
        let command = backend::encode_command(backend::HostCommand::Render {
            request_id: request.request_id.clone(),
            arguments: Box::new(request.arguments.clone()),
        })
        .map_err(|e| format!("worker command: {e:?}"))?;
        write_all(&process.control, &command, expires)?;
        loop {
            match process.event_while(expires, Some(caller))? {
                backend::WorkerEvent::Progress { request_id, .. }
                    if request_id == request.request_id => {}
                backend::WorkerEvent::Result {
                    request_id,
                    result: backend::RequestResult::Returned { response },
                    ..
                } if request_id == request.request_id => return Ok(response),
                _ => return Err("worker render did not return a matching daemon response".into()),
            }
        }
    }
}

struct Routing {
    actors: BTreeMap<String, ProjectRoute>,
    joins: Vec<thread::JoinHandle<()>>,
    config: Arc<OwnerConfig>,
    custody: Arc<journal::Custody>,
    budget: Arc<Mutex<Budget>>,
    observations: Arc<ObservationLog>,
}
impl Routing {
    fn insert(
        &mut self,
        key: String,
        journal: journal::Journal,
        unknown: bool,
    ) -> Result<ProjectRoute> {
        if self.actors.len() >= self.config.limits.max_projects as usize {
            return Err("renderer project capacity exhausted".into());
        }
        let (tx, rx) = mpsc::sync_channel(self.config.limits.max_queue_per_project as usize);
        let route = ProjectRoute {
            sender: tx,
            capacity: Arc::new(ProjectCapacity {
                used: AtomicUsize::new(0),
                maximum: 1 + self.config.limits.max_queue_per_project as usize,
            }),
        };
        let actor = Actor {
            config: Arc::clone(&self.config),
            custody: Arc::clone(&self.custody),
            writer_custody: None,
            writer_intent: None,
            journal,
            budget: Arc::clone(&self.budget),
            process: None,
            reserved: unknown,
            unknown,
            observations: Arc::clone(&self.observations),
            phase: "waiting",
            #[cfg(feature = "sqlite-store")]
            store_records: Vec::new(),
        };
        self.joins.push(thread::spawn(move || actor.run(rx)));
        self.actors.insert(key, route.clone());
        Ok(route)
    }
    fn route(&mut self, key: &str, expires: Instant) -> Result<ProjectRoute> {
        if let Some(sender) = self.actors.get(key) {
            return Ok(sender.clone());
        }
        if self.actors.len() >= self.config.limits.max_projects as usize {
            return Err("renderer project capacity exhausted".into());
        }
        let journal = journal::Journal::open(
            Arc::clone(&self.custody),
            key,
            self.config.limits.max_retained_records,
            expires,
        )
        .map_err(err)?;
        let unknown = journal.has_unknown(expires).map_err(err)?;
        if unknown {
            self.budget
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .reserve()?;
        }
        self.insert(key.into(), journal, unknown)
    }
}
/// Private CLI host entry. Acquires existing custody, recovers every journal,
/// then publishes rendezvous; it never calls pristine provisioning as recovery.
pub fn host(path: &Path) -> Result<()> {
    let started = Instant::now();
    let c = Arc::new(read_config(path)?);
    let startup = Instant::now() + Duration::from_millis(c.limits.startup_ms as u64);
    let custody = journal::Custody::acquire(&custody_path(&c), startup).map_err(err)?;
    let observations = Arc::new(
        ObservationLog::open(&c, started).unwrap_or_else(|_| ObservationLog::unavailable(started)),
    );
    observations.emit(Observation::HostStarted {
        host_pid: std::process::id(),
    });
    let budget = Arc::new(Mutex::new(Budget {
        used: 0,
        maximum: c.limits.max_backends as usize,
    }));
    let mut routing = Routing {
        actors: BTreeMap::new(),
        joins: Vec::new(),
        config: Arc::clone(&c),
        custody: Arc::clone(&custody),
        budget,
        observations: Arc::clone(&observations),
    };
    // Recover running->unknown before any fresh global slot can be granted.
    for key in custody
        .service_keys(c.limits.max_projects as usize, startup)
        .map_err(err)?
    {
        let mut journal = journal::Journal::open(
            Arc::clone(&custody),
            &key,
            c.limits.max_retained_records,
            startup,
        )
        .map_err(err)?;
        let unknown = recover_journal(&mut journal, startup)?;
        observations.emit(Observation::JournalRecovered {
            project_service_key: &key,
            unknown,
        });
        if unknown {
            routing
                .budget
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .reserve()?;
        }
        routing.insert(key, journal, unknown)?;
    }
    private_dir(&rendezvous(&c), true)?;
    let socket = socket_path(&c);
    match fs::symlink_metadata(&socket) {
        Ok(m)
            if m.file_type().is_socket()
                && m.uid() == unsafe { libc::geteuid() }
                && m.mode() & 0o7777 == 0o600 =>
        {
            fs::remove_file(&socket).map_err(err)?
        }
        Ok(_) => return Err("renderer rendezvous socket is unsafe".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(err(e)),
    }
    let listener = UnixListener::bind(&socket).map_err(err)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).map_err(err)?;
    listener.set_nonblocking(true).map_err(err)?;
    let routing = Arc::new(Mutex::new(routing));
    let active = Arc::new(AtomicUsize::new(0));
    let operation_capacity = relay::OperationCapacity::new(c.limits.max_retained_records as usize);
    let session_registry = Arc::new(Mutex::new(session::SessionRegistry::new(Arc::clone(
        &operation_capacity,
    ))));
    #[cfg(feature = "sqlite-store")]
    let store_registry = Arc::new(Mutex::new(store::StoreRegistry::with_capacity(
        c.limits.max_retained_records as usize,
        Arc::clone(&operation_capacity),
    )));
    let mut idle_since = Instant::now();
    loop {
        #[cfg(feature = "sqlite-store")]
        let retained_store = !store_registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        #[cfg(not(feature = "sqlite-store"))]
        let retained_store = false;
        if active.load(Ordering::Acquire) > 0 || retained_store || operation_capacity.retained() {
            idle_since = Instant::now();
        } else if idle_since.elapsed() >= Duration::from_millis(c.limits.idle_ms as u64) {
            break;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if active.load(Ordering::Acquire) >= c.limits.max_connections as usize {
                    continue;
                }
                if peer(&stream).is_err() || stream.set_nonblocking(true).is_err() {
                    continue;
                }
                active.fetch_add(1, Ordering::AcqRel);
                let permit = Arc::new(ConnectionPermit(Arc::clone(&active)));
                let routing = Arc::clone(&routing);
                let c = Arc::clone(&c);
                let observations = Arc::clone(&observations);
                let session_registry = Arc::clone(&session_registry);
                #[cfg(feature = "sqlite-store")]
                let store_registry = Arc::clone(&store_registry);
                let received_at = Instant::now();
                thread::spawn(move || {
                    let receive =
                        Instant::now() + Duration::from_millis(c.limits.first_frame_ms as u64);
                    let mut pending = Vec::new();
                    let offer = frame(
                        &mut stream,
                        &mut pending,
                        c.limits.max_frame_bytes as usize,
                        receive,
                    );
                    if let Ok(bytes) = &offer {
                        if session::receive_first(
                            &mut stream,
                            bytes,
                            &pending,
                            received_at,
                            &c,
                            &routing,
                            &permit,
                            &session_registry,
                        ) {
                            return;
                        }
                    }
                    #[cfg(feature = "sqlite-store")]
                    if let Ok(bytes) = &offer {
                        if store::receive_first(
                            &mut stream,
                            bytes,
                            &pending,
                            received_at,
                            &c,
                            &routing,
                            &permit,
                            &store_registry,
                        ) {
                            return;
                        }
                    }
                    let offer = offer
                        .and_then(|bytes| serde_json::from_slice::<Offer>(&bytes).map_err(err));
                    let offer = match offer {
                        Ok(offer) => offer,
                        Err(reason) => {
                            observations.emit(Observation::ActorError {
                                stage: "offer_read",
                                reason: observation_reason(&reason),
                            });
                            return;
                        }
                    };
                    if !pending.is_empty() || validate_offer(&offer).is_err() {
                        observations.emit(Observation::ActorError {
                            stage: "offer_validation",
                            reason: "offer_refused",
                        });
                        return;
                    }
                    let expires = (received_at + Duration::from_millis(offer.remaining_budget_ms))
                        .min(received_at + Duration::from_millis(c.limits.request_ms as u64));
                    let Ok(key) =
                        wire::project_service_key(&offer.expected_selection.canonical_project)
                    else {
                        return;
                    };
                    let sender = routing
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .route(&key, expires);
                    match sender {
                        Ok(sender) => {
                            let invocation_id = offer.invocation_id.clone();
                            let project_permit = match sender.capacity.acquire() {
                                Ok(permit) => permit,
                                Err(_) => {
                                    observations.emit(Observation::ActorQueueRefused {
                                        invocation_id: &invocation_id,
                                        reason: "queue_full",
                                    });
                                    return;
                                }
                            };
                            let owner_stream = match stream.try_clone() {
                                Ok(stream) => stream,
                                Err(_) => return,
                            };
                            let (start_tx, start_rx) = mpsc::sync_channel(1);
                            let (bridge_tx, bridge_rx) = mpsc::sync_channel(1);
                            match sender.sender.try_send(Mailbox::Render(Job {
                                stream: owner_stream,
                                offer,
                                expires,
                                reader_start: Some(start_tx),
                                bridge: bridge_rx,
                                _permit: Arc::clone(&permit),
                                _project_permit: Arc::clone(&project_permit),
                            })) {
                                Err(refusal) => {
                                    let reason = match refusal {
                                        mpsc::TrySendError::Full(_) => "queue_full",
                                        mpsc::TrySendError::Disconnected(_) => "queue_disconnected",
                                    };
                                    observations.emit(Observation::ActorQueueRefused {
                                        invocation_id: &invocation_id,
                                        reason,
                                    });
                                    observations.emit(Observation::ActorError {
                                        stage: "actor_queue",
                                        reason: "queue_unavailable",
                                    });
                                }
                                Ok(()) => {
                                    observations.emit(Observation::ActorQueued {
                                        invocation_id: &invocation_id,
                                    });
                                    read_prepared_bridge(
                                        &mut stream,
                                        start_rx,
                                        bridge_tx,
                                        expires,
                                        &observations,
                                        &invocation_id,
                                    );
                                }
                            }
                            // Both actor and reader must terminate before these
                            // exact connection/project admission slots are free.
                            drop(stream);
                            drop((permit, project_permit));
                        }
                        Err(reason) => observations.emit(Observation::ActorError {
                            stage: "project_route",
                            reason: observation_reason(&reason),
                        }),
                    }
                });
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                thread::sleep(TICK)
            }
            Err(e) => return Err(err(e)),
        }
    }
    drop(listener);
    // Closing all actor inboxes requests owned-worker cleanup. Joining retains
    // custody through quarantine; an idle timeout is never an authority override.
    let joins = {
        let mut routing = routing.lock().unwrap_or_else(|e| e.into_inner());
        routing.actors.clear();
        std::mem::take(&mut routing.joins)
    };
    for join in joins {
        let _ = join.join();
    }
    // Only this custody owner can remove its native-derived rendezvous.
    fs::remove_file(&socket).map_err(err)?;
    observations.emit(Observation::HostIdleExit {
        host_pid: std::process::id(),
    });
    Ok(())
}

#[cfg(test)]
#[path = "render_owner/tests.rs"]
mod tests;
