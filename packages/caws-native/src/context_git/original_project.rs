//! Original project discovery with durable, binary-private actual-Child custody.
//! This is an observation capability, not project authority or store admission.
//! Only inherited configuration reaches the worker; no engine frame selects its
//! executor, deadline or query grammar. Executable pinning is pathname/metadata/
//! byte verification, not atomic descriptor-bound exec or same-UID attestation.
use super::*;
use crate::{
    invocation_project as project,
    monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline},
};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) const CONFIG_SCHEMA: &str = "caws.native.original-project.configuration.v1";
const REPLY_SCHEMA: &str = "caws.native.original-project.reply.v1";
// Two queries, each with at most MAX_OUTPUT raw bytes, plus base64, bounded
// paths and metadata. At most one pending and one terminal frame are accepted.
const MAX_REPLY: usize = 2 * MAX_RESULT;
const MAX_STREAM: usize = 2 * (MAX_REPLY + 1);

/// Borrowed original native inputs. This type has no wire deserializer. The
/// caller must retain these before Node and supply its native-selected executor.
pub struct Input<'a> {
    pub id: &'a str,
    pub runtime_digest: &'a str,
    pub caller_cwd: &'a str,
    pub environment: &'a BTreeMap<String, String>,
    pub payload: &'a RawValue,
}

/// Constructed only after correlated terminal reply, EOF, original custodian
/// reap, pinned executor revalidation and shared project parser revalidation.
#[derive(Debug)]
pub struct CapturedProject {
    id: String,
    runtime_digest: String,
    input_digest: String,
    deadline: DeadlineEnvelope,
    project: project::ObservedProject,
    query_cwds: [PathBuf; 2],
}
impl CapturedProject {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn runtime_digest(&self) -> &str {
        &self.runtime_digest
    }
    pub fn input_digest(&self) -> &str {
        &self.input_digest
    }
    pub fn deadline(&self) -> DeadlineEnvelope {
        self.deadline
    }
    pub fn project(&self) -> &project::ObservedProject {
        &self.project
    }
    pub fn query_cwds(&self) -> &[PathBuf; 2] {
        &self.query_cwds
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Deadline,
    Cancelled,
    Project(project::ProjectPhase),
    Protocol,
    Io,
}
/// This owns the *custodian* Child/control, never a reconstructed Git Child.
/// Drop closes frontend liveness and passively reaps the custodian; it never
/// signals that process, whose actual Git custody can remain unresolved.
#[must_use = "retain remote project custody until settlement or transfer/drop it explicitly"]
pub struct RemoteFailure {
    pub kind: FailureKind,
    pub diagnostic: String,
    pending: Option<Pending>,
}
impl std::fmt::Debug for RemoteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteProjectFailure")
            .field("kind", &self.kind)
            .field("diagnostic", &self.diagnostic)
            .field("custodianPid", &self.custodian_pid())
            .field("receipt", &self.receipt())
            .field("cleanupSettled", &self.cleanup_settled())
            .field("receivedBytes", &self.pending.as_ref().map(|p| p.received))
            .field(
                "bufferedBytes",
                &self.pending.as_ref().map(|p| p.output.len()),
            )
            .finish()
    }
}
impl std::fmt::Display for RemoteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.diagnostic)
    }
}
impl std::error::Error for RemoteFailure {}
impl RemoteFailure {
    fn before(kind: FailureKind, diagnostic: impl Into<String>) -> Self {
        Self {
            kind,
            diagnostic: diagnostic.into(),
            pending: None,
        }
    }
    pub fn custodian_pid(&self) -> Option<u32> {
        self.pending.as_ref().map(|p| p.pid)
    }
    pub fn receipt(&self) -> Option<serde_json::Value> {
        self.pending
            .as_ref()?
            .latest
            .as_ref()
            .and_then(|v| serde_json::to_value(v).ok())
    }
    pub fn cleanup_settled(&self) -> bool {
        self.pending.as_ref().is_none_or(Pending::settled)
    }
    /// Settlement only: retry cannot upgrade a failed/pending capture to success
    /// or launch a second query. Its independent cleanup wait renews no request.
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        let Some(p) = self.pending.as_mut() else {
            return Ok(());
        };
        if p.settled() {
            return Ok(());
        }
        p.cancel();
        let until = Instant::now() + CLEANUP;
        loop {
            p.advance()?;
            if p.settled() {
                return Ok(());
            }
            if Instant::now() >= until {
                return Err("original-project custodian retains unresolved custody".into());
            }
            p.tick();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pinned {
    path: PathBuf,
    physical_path: PathBuf,
    sha256: String,
    device: u64,
    inode: u64,
    bytes: u64,
    mode: u32,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}
impl Pinned {
    fn capture(v: &project::SelectedExecutable) -> Self {
        let i = &v.identity;
        Self {
            path: v.path.clone(),
            physical_path: v.physical_path.clone(),
            sha256: v.sha256.clone(),
            device: i.device,
            inode: i.inode,
            bytes: i.bytes,
            mode: i.mode,
            modified_seconds: i.modified_seconds,
            modified_nanoseconds: i.modified_nanoseconds,
            changed_seconds: i.changed_seconds,
            changed_nanoseconds: i.changed_nanoseconds,
        }
    }
    fn selected(&self) -> project::SelectedExecutable {
        project::SelectedExecutable {
            path: self.path.clone(),
            physical_path: self.physical_path.clone(),
            sha256: self.sha256.clone(),
            identity: project::ExecutableIdentity {
                device: self.device,
                inode: self.inode,
                bytes: self.bytes,
                mode: self.mode,
                modified_seconds: self.modified_seconds,
                modified_nanoseconds: self.modified_nanoseconds,
                changed_seconds: self.changed_seconds,
                changed_nanoseconds: self.changed_nanoseconds,
            },
        }
    }
    fn valid(&self) -> bool {
        [&self.path, &self.physical_path].iter().all(|p| {
            p.is_absolute()
                && p.as_os_str().as_bytes().len() <= 4096
                && !p.as_os_str().as_bytes().contains(&0)
        }) && lower_hex(&self.sha256)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    schema: String,
    id: String,
    runtime_digest: String,
    nonce: String,
    input_digest: String,
    caller_cwd: String,
    environment: BTreeMap<String, String>,
    // Exact RawValue bytes, including original whitespace/numeric spellings.
    payload: String,
    deadline: DeadlineEnvelope,
    executor: Pinned,
}
impl Configuration {
    fn digest(&self) -> Result<String, String> {
        let bytes = serde_json::to_vec(&(
            &self.id,
            &self.runtime_digest,
            &self.nonce,
            &self.caller_cwd,
            &self.environment,
            &self.payload,
            self.deadline,
            &self.executor,
        ))
        .map_err(|e| e.to_string())?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
    fn payload(&self) -> Result<Box<RawValue>, String> {
        let bytes = STANDARD.decode(&self.payload).map_err(|e| e.to_string())?;
        if STANDARD.encode(&bytes) != self.payload {
            return Err("noncanonical original payload encoding".into());
        }
        RawValue::from_string(String::from_utf8(bytes).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema != CONFIG_SCHEMA
            || self.id.is_empty()
            || self.id.len() > 128
            || self.id.contains('\0')
            || !lower_hex(&self.runtime_digest)
            || !lower_hex(&self.nonce)
            || !lower_hex(&self.input_digest)
            || self.input_digest != self.digest()?
            || !self.executor.valid()
            || !self.caller_cwd.starts_with('/')
            || self.caller_cwd.len() > 4096
            || self.caller_cwd.contains('\0')
            || self
                .environment
                .iter()
                .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
        {
            return Err("invalid private original-project configuration".into());
        }
        self.payload()?;
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    ordinal: u8,
    operation: Operation,
    cwd: PathBuf,
    receipt: QueryReceipt,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectResult {
    checkout: PathBuf,
    canonical_root: PathBuf,
    git: Pinned,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFailure {
    phase: String,
    message: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    schema: String,
    id: String,
    runtime_digest: String,
    nonce: String,
    input_digest: String,
    deadline: DeadlineEnvelope,
    terminal: bool,
    rows: Vec<Row>,
    project: Option<ProjectResult>,
    failure: Option<WireFailure>,
}
fn positive(r: &QueryReceipt) -> bool {
    r.cleanup.group_settled && r.cleanup.stdout_eof && r.cleanup.stderr_eof && r.cleanup.reaped
}
fn phase(value: &str) -> Option<project::ProjectPhase> {
    use project::ProjectPhase::*;
    [
        Caller,
        Payload,
        Candidate,
        SelectExecutable,
        PinExecutable,
        BeforeLaunch,
        Spawn,
        Pipes,
        Query,
        QueryDeadline,
        Cancelled,
        OutputLimit,
        ExitObservation,
        Cleanup,
        QueryStatus,
        AfterLaunch,
        CheckoutOutput,
        CommonDirectoryOutput,
        PhysicalRoot,
    ]
    .into_iter()
    .find(|p| format!("{p:?}") == value)
}
fn kind(p: project::ProjectPhase) -> FailureKind {
    match p {
        project::ProjectPhase::Cancelled => FailureKind::Cancelled,
        project::ProjectPhase::QueryDeadline => FailureKind::Deadline,
        _ => FailureKind::Project(p),
    }
}
fn checkpoint(
    deadline: &MonotonicDeadline,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), RemoteFailure> {
    if cancelled() {
        return Err(RemoteFailure::before(
            FailureKind::Cancelled,
            "original project cancelled",
        ));
    }
    deadline
        .check()
        .map_err(|e| RemoteFailure::before(FailureKind::Deadline, e.to_string()))
}
fn validate_reply(r: &Reply, c: &Configuration, payload: &RawValue) -> Result<(), String> {
    if r.schema != REPLY_SCHEMA
        || r.id != c.id
        || r.runtime_digest != c.runtime_digest
        || r.nonce != c.nonce
        || r.input_digest != c.input_digest
        || r.deadline != c.deadline
        || r.rows.len() > 2
    {
        return Err("private original-project reply binding mismatch".into());
    }
    if r.terminal {
        if r.project.is_some() == r.failure.is_some()
            || r.rows.iter().any(|v| !positive(&v.receipt))
        {
            return Err("invalid terminal project receipt".into());
        }
    } else if r.project.is_some()
        || r.failure.is_some()
        || r.rows.is_empty()
        || r.rows.last().unwrap().receipt.status != "cleanup_unsettled"
        || positive(&r.rows.last().unwrap().receipt)
        || r.rows.last().unwrap().receipt.pid.is_none()
        || r.rows.last().unwrap().receipt.cleanup.reaped
    {
        return Err("invalid pending project receipt".into());
    }
    let mut expected =
        project::candidate(&c.caller_cwd, &c.environment, payload).map_err(|e| e.to_string());
    for (i, row) in r.rows.iter().enumerate() {
        let operation = if i == 0 {
            Operation::Checkout
        } else {
            Operation::CommonDir
        };
        if row.ordinal != i as u8 + 1
            || row.operation != operation
            || expected.as_ref().ok() != Some(&row.cwd)
            || row.receipt.diagnostic.len() > 1024
        {
            return Err("private original-project query binding mismatch".into());
        }
        let q = &row.receipt;
        let out = STANDARD
            .decode(&q.stdout)
            .map_err(|_| "invalid stdout encoding")?;
        let err = STANDARD
            .decode(&q.stderr)
            .map_err(|_| "invalid stderr encoding")?;
        if out.len() + err.len() > MAX_OUTPUT
            || STANDARD.encode(&out) != q.stdout
            || STANDARD.encode(&err) != q.stderr
            || q.pid.is_some_and(|v| v <= 1)
            || q.exit_code.is_some() && q.signal.is_some()
            || q.pid.is_none() && (q.exit_code.is_some() || q.signal.is_some())
            || !matches!(
                q.status.as_str(),
                "exited"
                    | "spawn_failed"
                    | "cancelled"
                    | "deadline"
                    | "output_limit"
                    | "cleanup_unsettled"
                    | "identity_changed"
            )
            || q.status == "exited"
                && (q.pid.is_none() || q.exit_code.is_none() && q.signal.is_none())
            || i + 1 < r.rows.len()
                && (!positive(q)
                    || q.status != "exited"
                    || q.exit_code != Some(0)
                    || q.signal.is_some())
        {
            return Err("private original-project output/status mismatch".into());
        }
        expected = project::git_path(&out, project::ProjectPhase::CheckoutOutput)
            .map_err(|e| e.to_string());
    }
    if let Some(p) = &r.project {
        if r.rows.len() != 2
            || !p.git.valid()
            || !p.checkout.is_absolute()
            || !p.canonical_root.is_absolute()
            || r.rows.iter().any(|r| {
                r.receipt.status != "exited"
                    || r.receipt.exit_code != Some(0)
                    || r.receipt.signal.is_some()
            })
        {
            return Err("incomplete original-project success".into());
        }
    }
    if let Some(f) = &r.failure
        && (phase(&f.phase).is_none() || f.message.len() > 4096)
    {
        return Err("invalid project failure classification".into());
    }
    Ok(())
}

struct Pending {
    child: Option<Child>,
    pid: u32,
    control: UnixStream,
    input: Vec<u8>,
    written: usize,
    output: Vec<u8>,
    received: usize,
    frames: u8,
    latest: Option<Reply>,
    eof: bool,
    exited_successfully: bool,
    aborted_configuration: bool,
    configuration: Configuration,
    payload: Box<RawValue>,
    protocol_error: Option<String>,
}
impl Pending {
    fn cancel(&mut self) {
        if self.written < self.input.len() {
            self.aborted_configuration = true;
            self.input.truncate(self.written);
        }
        let _ = self.control.shutdown(std::net::Shutdown::Write);
    }
    fn settled(&self) -> bool {
        self.child.is_none()
            && self.exited_successfully
            && self.eof
            && self.protocol_error.is_none()
            && (self.aborted_configuration
                || self
                    .latest
                    .as_ref()
                    .is_some_and(|r| r.terminal && r.rows.iter().all(|v| positive(&v.receipt))))
    }
    fn tick(&self) {
        tick(&mut [libc::pollfd {
            fd: self.control.as_raw_fd(),
            events: libc::POLLIN
                | if self.written < self.input.len() {
                    libc::POLLOUT
                } else {
                    0
                },
            revents: 0,
        }]);
    }
    fn advance(&mut self) -> Result<(), String> {
        // Bounded work per call keeps the original deadline/cancellation live.
        for _ in 0..8 {
            if self.written == self.input.len() {
                break;
            }
            match self.control.write(&self.input[self.written..]) {
                Ok(0) => return Err("original-project configuration write closed".into()),
                Ok(n) => self.written += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => (),
                Err(e) => return Err(e.to_string()),
            }
        }
        for _ in 0..8 {
            if self.eof {
                break;
            }
            let mut bytes = [0u8; 8192];
            match self.control.read(&mut bytes) {
                Ok(0) => {
                    self.eof = true;
                    break;
                }
                Ok(n) => {
                    self.received += n;
                    if self.received > MAX_STREAM {
                        return Err("private original-project stream exceeds bound".into());
                    }
                    // Previous buffered bytes have already been scanned. Repeated
                    // whole-prefix scans turn bounded large receipts quadratic
                    // and can exhaust the custodian's bounded response writer.
                    let mut scan_from = self.output.len();
                    self.output.extend_from_slice(&bytes[..n]);
                    while let Some(relative) =
                        self.output[scan_from..].iter().position(|b| *b == b'\n')
                    {
                        let end = scan_from + relative;
                        if end > MAX_REPLY {
                            return Err("private original-project frame exceeds bound".into());
                        }
                        let r: Reply = serde_json::from_slice(&self.output[..end])
                            .map_err(|e| e.to_string())?;
                        validate_reply(&r, &self.configuration, &self.payload)?;
                        if self.frames >= 2
                            || self.latest.as_ref().is_some_and(|r| r.terminal)
                            || self.frames == 1 && !r.terminal
                        {
                            return Err("duplicate/trailing private original-project frame".into());
                        }
                        if let Some(p) = &self.latest {
                            if r.failure.is_none() {
                                return Err(
                                    "pending project capture cannot become successful".into()
                                );
                            }
                            // Pending can advance cleanup, not rewrite completed queries,
                            // operation/cwd/pid or already observed exit/output bytes.
                            if p.rows.len() != r.rows.len() {
                                return Err("project settlement changed query count".into());
                            }
                            for (before, after) in p.rows.iter().zip(&r.rows) {
                                if before.ordinal != after.ordinal
                                    || before.operation != after.operation
                                    || before.cwd != after.cwd
                                    || before.receipt.pid != after.receipt.pid
                                    || before.receipt.exit_code.is_some()
                                        && before.receipt.exit_code != after.receipt.exit_code
                                    || before.receipt.signal.is_some()
                                        && before.receipt.signal != after.receipt.signal
                                    || !STANDARD.decode(&after.receipt.stdout).unwrap().starts_with(
                                        &STANDARD.decode(&before.receipt.stdout).unwrap(),
                                    )
                                    || !STANDARD.decode(&after.receipt.stderr).unwrap().starts_with(
                                        &STANDARD.decode(&before.receipt.stderr).unwrap(),
                                    )
                                {
                                    return Err("project settlement rewrote observations".into());
                                }
                            }
                        }
                        self.frames += 1;
                        self.latest = Some(r);
                        self.output.drain(..=end);
                        scan_from = 0;
                    }
                    if self.output.len() > MAX_REPLY {
                        return Err("private original-project frame exceeds bound".into());
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => (),
                Err(e) => return Err(e.to_string()),
            }
        }
        if self.eof && !self.output.is_empty() {
            return Err("incomplete private original-project frame".into());
        }
        if self.eof
            && let Some(child) = self.child.as_mut()
            && let Some(status) = child.try_wait().map_err(|e| e.to_string())?
        {
            self.child = None;
            self.exited_successfully = status.success();
            if !status.success() {
                return Err(format!(
                    "original-project custodian exited abnormally: {status}"
                ));
            }
            if !self.aborted_configuration && !self.latest.as_ref().is_some_and(|r| r.terminal) {
                return Err("custodian closed without terminal project receipt".into());
            }
        }
        Ok(())
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = self.control.shutdown(std::net::Shutdown::Both);
        if let Some(mut child) = self.child.take() {
            let _ = std::thread::Builder::new()
                .name("caws-original-project-reap".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

/// Starts the existing custodian grammar with native-selected executable and
/// private original inputs. The original clock is never reset for transfer.
pub fn capture(
    input: Input<'_>,
    executor: &project::SelectedExecutable,
    deadline: &MonotonicDeadline,
    cancelled: &dyn Fn() -> bool,
) -> Result<CapturedProject, RemoteFailure> {
    checkpoint(deadline, cancelled)?;
    project::verify_executable(
        executor,
        project::ProjectPhase::BeforeLaunch,
        deadline.expires(),
        cancelled,
    )
    .map_err(|e| RemoteFailure::before(kind(e.first_phase), e.to_string()))?;
    let mut random = [0u8; 32];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut random))
        .map_err(|e| RemoteFailure::before(FailureKind::Io, e.to_string()))?;
    checkpoint(deadline, cancelled)?;
    let mut c = Configuration {
        schema: CONFIG_SCHEMA.into(),
        id: input.id.into(),
        runtime_digest: input.runtime_digest.into(),
        nonce: format!("{:x}", Sha256::digest(random)),
        input_digest: String::new(),
        caller_cwd: input.caller_cwd.into(),
        environment: input.environment.clone(),
        payload: STANDARD.encode(input.payload.get().as_bytes()),
        deadline: deadline.envelope(),
        executor: Pinned::capture(executor),
    };
    c.input_digest = c
        .digest()
        .map_err(|e| RemoteFailure::before(FailureKind::Protocol, e))?;
    c.validate()
        .map_err(|e| RemoteFailure::before(FailureKind::Protocol, e))?;
    let payload = c
        .payload()
        .map_err(|e| RemoteFailure::before(FailureKind::Protocol, e))?;
    let mut bytes = serde_json::to_vec(&c)
        .map_err(|e| RemoteFailure::before(FailureKind::Protocol, e.to_string()))?;
    if bytes.len() >= MAX_CONFIGURATION {
        return Err(RemoteFailure::before(
            FailureKind::Protocol,
            "original-project configuration exceeds inherited bound",
        ));
    }
    bytes.push(b'\n');
    checkpoint(deadline, cancelled)?;
    let (control, remote) =
        UnixStream::pair().map_err(|e| RemoteFailure::before(FailureKind::Io, e.to_string()))?;
    control
        .set_nonblocking(true)
        .map_err(|e| RemoteFailure::before(FailureKind::Io, e.to_string()))?;
    let fd = unsafe { libc::fcntl(remote.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
    if fd < 0 {
        return Err(RemoteFailure::before(
            FailureKind::Io,
            io::Error::last_os_error().to_string(),
        ));
    }
    let inherited = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut command = Command::new(&executor.path);
    command
        .arg("context-git-custodian")
        .arg(fd.to_string())
        .current_dir("/")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 || libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    // Final original-clock check precedes the only native-custodian spawn.
    checkpoint(deadline, cancelled)?;
    let child = command
        .spawn()
        .map_err(|e| RemoteFailure::before(FailureKind::Io, e.to_string()))?;
    drop(inherited);
    drop(remote);
    let mut p = Pending {
        pid: child.id(),
        child: Some(child),
        control,
        input: bytes,
        written: 0,
        output: Vec::new(),
        received: 0,
        frames: 0,
        latest: None,
        eof: false,
        exited_successfully: false,
        aborted_configuration: false,
        configuration: c,
        payload,
        protocol_error: None,
    };
    loop {
        if let Err(mut failure) = checkpoint(deadline, cancelled) {
            p.cancel();
            failure.pending = Some(p);
            return Err(failure);
        }
        if let Err(diagnostic) = p.advance() {
            p.protocol_error = Some(diagnostic.clone());
            p.cancel();
            return Err(RemoteFailure {
                kind: FailureKind::Protocol,
                diagnostic,
                pending: Some(p),
            });
        }
        if p.latest.as_ref().is_some_and(|r| !r.terminal) {
            p.cancel();
            return Err(RemoteFailure {
                kind: FailureKind::Project(project::ProjectPhase::Cleanup),
                diagnostic: "native custodian retains unsettled original-project query".into(),
                pending: Some(p),
            });
        }
        if p.settled() {
            let r = p.latest.as_ref().expect("terminal reply");
            if let Some(f) = &r.failure {
                return Err(RemoteFailure {
                    kind: kind(phase(&f.phase).unwrap()),
                    diagnostic: f.message.clone(),
                    pending: Some(p),
                });
            }
            let result = (|| -> Result<CapturedProject, RemoteFailure> {
                checkpoint(deadline, cancelled)?;
                project::verify_executable(
                    executor,
                    project::ProjectPhase::AfterLaunch,
                    deadline.expires(),
                    cancelled,
                )
                .map_err(|e| RemoteFailure::before(kind(e.first_phase), e.to_string()))?;
                let expected = r.project.as_ref().unwrap();
                let mut index = 0;
                let observed = project::observe_with_query(
                    input.caller_cwd,
                    input.environment,
                    input.payload,
                    deadline.expires(),
                    cancelled,
                    |selected, cwd, _, args, _, _| {
                        let row = r.rows.get(index).ok_or_else(|| {
                            project::ProjectFailure::new(
                                project::ProjectPhase::Query,
                                "missing private query",
                            )
                        })?;
                        if Pinned::capture(selected) != expected.git
                            || cwd != row.cwd
                            || args != row.operation.argv()
                        {
                            return Err(project::ProjectFailure::new(
                                project::ProjectPhase::Query,
                                "private original-project selection/cwd mismatch",
                            ));
                        }
                        index += 1;
                        successful_output(&row.receipt)
                    },
                )
                .map_err(|e| RemoteFailure::before(kind(e.first_phase), e.to_string()))?;
                if index != 2
                    || observed.checkout != expected.checkout
                    || observed.canonical_root != expected.canonical_root
                {
                    return Err(RemoteFailure::before(
                        FailureKind::Protocol,
                        "private physical project result changed",
                    ));
                }
                checkpoint(deadline, cancelled)?;
                Ok(CapturedProject {
                    id: r.id.clone(),
                    runtime_digest: r.runtime_digest.clone(),
                    input_digest: r.input_digest.clone(),
                    deadline: r.deadline,
                    project: observed,
                    query_cwds: [r.rows[0].cwd.clone(), r.rows[1].cwd.clone()],
                })
            })();
            return result.map_err(|mut e| {
                e.pending = Some(p);
                e
            });
        }
        p.tick();
    }
}

// Only success (exit zero, no signal) is adapted to the shared parser. A remote
// nonzero/signal receipt is retained as such, never forged into an owning local
// ProjectFailure or a guessed core-dump observation.
fn successful_output(r: &QueryReceipt) -> Result<project::QueryOutput, project::ProjectFailure> {
    use project::ProjectPhase as P;
    if !positive(r)
        || r.status != "exited"
        || r.exit_code != Some(0)
        || r.signal.is_some()
        || r.pid.is_none()
    {
        return Err(project::ProjectFailure::new(
            P::QueryStatus,
            format!(
                "Git query failed (status {}; exit {:?}; signal {:?})",
                r.status, r.exit_code, r.signal
            ),
        ));
    }
    let stdout = STANDARD
        .decode(&r.stdout)
        .map_err(|e| project::ProjectFailure::new(P::Query, e.to_string()))?;
    let stderr = STANDARD
        .decode(&r.stderr)
        .map_err(|e| project::ProjectFailure::new(P::Query, e.to_string()))?;
    let cleanup = project::QueryCleanup {
        pid: r.pid,
        exit_observed: true,
        pipes: project::PipeObservation {
            stdout_eof: true,
            stderr_eof: true,
            stdout_bytes: stdout.len(),
            stderr_bytes: stderr.len(),
            ..Default::default()
        },
        reaped: Some(project::ExitObservation {
            success: true,
            code: Some(0),
            signal: None,
            core_dumped: false,
        }),
        ..Default::default()
    };
    project::project_query_output(project::ObservedQueryOutput {
        stdout,
        stderr,
        cleanup,
    })
}
fn peer_cancelled(fd: RawFd, initial: bool) -> bool {
    if initial || SIGNAL.load(Ordering::Relaxed) != 0 {
        return true;
    }
    let mut byte = 0u8;
    let n = unsafe {
        libc::recv(
            fd,
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    n >= 0
        || !matches!(
            io::Error::last_os_error().kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        )
}
fn send(stream: &mut UnixStream, r: &Reply) -> bool {
    match serde_json::to_vec(r) {
        Ok(bytes) if bytes.len() <= MAX_REPLY => publish_bytes(stream, bytes),
        _ => false,
    }
}
fn wire_failure(e: &project::ProjectFailure) -> WireFailure {
    // Query custody is retained in the correlated rows. The shared parser's
    // empty local cleanup placeholder is not a remote process observation.
    let text = format!("project {:?}: {}", e.first_phase, e.first_message);
    let mut end = text.len().min(4096);
    while !text.is_char_boundary(end) {
        end -= 1
    }
    WireFailure {
        phase: format!("{:?}", e.first_phase),
        message: text[..end].into(),
    }
}
pub(super) fn run_configuration(
    stream: &mut UnixStream,
    bytes: &[u8],
    initial_cancelled: bool,
) -> Result<(), String> {
    let c: Configuration = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    c.validate()?;
    let payload = c.payload()?;
    let executor = c.executor.selected();
    if fs::canonicalize(std::env::current_exe().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?
        != executor.physical_path
    {
        return Err("private original-project executor image mismatch".into());
    }
    let mut reply = Reply {
        schema: REPLY_SCHEMA.into(),
        id: c.id.clone(),
        runtime_digest: c.runtime_digest.clone(),
        nonce: c.nonce.clone(),
        input_digest: c.input_digest.clone(),
        deadline: c.deadline,
        terminal: false,
        rows: Vec::new(),
        project: None,
        failure: None,
    };
    // Invalid/expired clocks produce a correlated no-query refusal, never a new
    // timeout. The private configuration still authenticates original binding.
    let deadline = match MonotonicDeadline::receive(c.deadline) {
        Ok(d) => d,
        Err(e) => {
            reply.terminal = true;
            reply.failure = Some(WireFailure {
                phase: "QueryDeadline".into(),
                message: e.to_string(),
            });
            send(stream, &reply);
            return Ok(());
        }
    };
    let fd = stream.as_raw_fd();
    let stopped = || peer_cancelled(fd, initial_cancelled);
    let mut pending_sent = false;
    let result = project::verify_executable(
        &executor,
        project::ProjectPhase::BeforeLaunch,
        deadline.expires(),
        &stopped,
    )
    .and_then(|()| {
        project::observe_with_query(
            &c.caller_cwd,
            &c.environment,
            &payload,
            deadline.expires(),
            &stopped,
            |selected, cwd, environment, args, expires, cancelled| {
                let index = reply.rows.len();
                let operation = match index {
                    0 => Operation::Checkout,
                    1 => Operation::CommonDir,
                    _ => {
                        return Err(project::ProjectFailure::new(
                            project::ProjectPhase::Query,
                            "extra original-project query",
                        ));
                    }
                };
                if args != operation.argv() {
                    return Err(project::ProjectFailure::new(
                        project::ProjectPhase::Query,
                        "original-project query grammar changed",
                    ));
                }
                let until = expires.min(Instant::now() + project::QUERY_BUDGET);
                project::verify_executable(
                    selected,
                    project::ProjectPhase::BeforeLaunch,
                    until,
                    cancelled,
                )?;
                deadline.check().map_err(|e| {
                    project::ProjectFailure::new(
                        project::ProjectPhase::QueryDeadline,
                        e.to_string(),
                    )
                })?;
                let cwd = cwd.to_path_buf();
                let env: Vec<_> = environment
                    .iter()
                    .map(|(k, v)| (k.as_bytes().to_vec(), v.as_bytes().to_vec()))
                    .collect();
                let native_before = monotonic_ns();
                if native_before == 0 {
                    return Err(project::ProjectFailure::new(
                        project::ProjectPhase::QueryDeadline,
                        "native monotonic clock unavailable before original query",
                    ));
                }
                let remaining = until
                    .saturating_duration_since(Instant::now())
                    .as_nanos()
                    .min(u128::from(u64::MAX)) as u64;
                let ns = deadline
                    .envelope()
                    .expires_ns
                    .min(native_before.saturating_add(remaining));
                let receipt = run_owned_query(
                    stream,
                    QuerySpec {
                        executable: &selected.path,
                        cwd: &cwd,
                        environment: &env,
                        argv: operation.argv(),
                        expires_ns: ns,
                    },
                    stopped(),
                    |stream, r| {
                        if r.status == "cleanup_unsettled" && !pending_sent {
                            let mut interim = reply.clone();
                            interim.rows.push(Row {
                                ordinal: index as u8 + 1,
                                operation,
                                cwd: cwd.clone(),
                                receipt: r.clone(),
                            });
                            pending_sent = true;
                            send(stream, &interim)
                        } else {
                            true
                        }
                    },
                );
                reply.rows.push(Row {
                    ordinal: index as u8 + 1,
                    operation,
                    cwd,
                    receipt,
                });
                if pending_sent {
                    return Err(project::ProjectFailure::new(
                        project::ProjectPhase::Cleanup,
                        "original project query exceeded cleanup response bound; no continuation",
                    ));
                }
                let r = &reply.rows.last().unwrap().receipt;
                if r.status != "exited" {
                    let phase = match r.status.as_str() {
                        "cancelled" => project::ProjectPhase::Cancelled,
                        "deadline" => project::ProjectPhase::QueryDeadline,
                        "output_limit" => project::ProjectPhase::OutputLimit,
                        "spawn_failed" => project::ProjectPhase::Spawn,
                        "identity_changed" => project::ProjectPhase::AfterLaunch,
                        _ => project::ProjectPhase::Cleanup,
                    };
                    return Err(project::ProjectFailure::new(
                        phase,
                        format!("{}: {}", r.status, r.diagnostic),
                    ));
                }
                project::verify_executable(
                    selected,
                    project::ProjectPhase::AfterLaunch,
                    until,
                    cancelled,
                )?;
                successful_output(r)
            },
        )
    })
    .and_then(|observed| {
        deadline.check().map_err(|e| {
            project::ProjectFailure::new(project::ProjectPhase::QueryDeadline, e.to_string())
        })?;
        project::verify_executable(
            &executor,
            project::ProjectPhase::AfterLaunch,
            deadline.expires(),
            &stopped,
        )?;
        Ok(observed)
    });
    reply.terminal = true;
    match result {
        Ok(observed) => {
            reply.project = Some(ProjectResult {
                checkout: observed.checkout,
                canonical_root: observed.canonical_root,
                git: Pinned::capture(&observed.executable),
            })
        }
        Err(e) => reply.failure = Some(wire_failure(&e)),
    }
    // No unresolved Git Child can reach this line. Failure to deliver is not
    // permission to release ownership earlier in the shared actual-Child loop.
    send(stream, &reply);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn config() -> Configuration {
        let mut c = Configuration {
            schema: CONFIG_SCHEMA.into(),
            id: "original".into(),
            runtime_digest: "a".repeat(64),
            nonce: "b".repeat(64),
            input_digest: String::new(),
            caller_cwd: "/tmp".into(),
            environment: BTreeMap::new(),
            payload: STANDARD.encode(b"{\n\"opaque\":1e9999,\"cwd\":\"/tmp\"\n}"),
            deadline: DeadlineEnvelope {
                started_ns: 1,
                expires_ns: 2,
            },
            executor: Pinned {
                path: "/native".into(),
                physical_path: "/native".into(),
                sha256: "c".repeat(64),
                device: 1,
                inode: 2,
                bytes: 3,
                mode: 0o100700,
                modified_seconds: 1,
                modified_nanoseconds: 0,
                changed_seconds: 1,
                changed_nanoseconds: 0,
            },
        };
        c.input_digest = c.digest().unwrap();
        c
    }
    fn reply(c: &Configuration) -> Reply {
        let cleanup = Cleanup {
            group_settled: true,
            stdout_eof: true,
            stderr_eof: true,
            reaped: true,
        };
        Reply {
            schema: REPLY_SCHEMA.into(),
            id: c.id.clone(),
            runtime_digest: c.runtime_digest.clone(),
            nonce: c.nonce.clone(),
            input_digest: c.input_digest.clone(),
            deadline: c.deadline,
            terminal: true,
            rows: [Operation::Checkout, Operation::CommonDir]
                .into_iter()
                .enumerate()
                .map(|(i, operation)| Row {
                    ordinal: i as u8 + 1,
                    operation,
                    cwd: "/tmp".into(),
                    receipt: QueryReceipt {
                        status: "exited".into(),
                        pid: Some(100 + i as u32),
                        exit_code: Some(0),
                        signal: None,
                        stdout: STANDARD.encode(if i == 0 {
                            b"/tmp\n".as_slice()
                        } else {
                            b"/tmp/.git\n".as_slice()
                        }),
                        stderr: String::new(),
                        cleanup: cleanup.clone(),
                        diagnostic: String::new(),
                    },
                })
                .collect(),
            project: Some(ProjectResult {
                checkout: "/tmp".into(),
                canonical_root: "/tmp".into(),
                git: c.executor.clone(),
            }),
            failure: None,
        }
    }
    #[test]
    fn two_query_reply_uses_its_own_bound_and_preserves_exact_wire_bytes() {
        let c = config();
        let mut r = reply(&c);
        for row in &mut r.rows {
            let stdout = STANDARD.decode(&row.receipt.stdout).unwrap();
            row.receipt.stderr = STANDARD.encode(vec![b'x'; MAX_OUTPUT - stdout.len()]);
        }
        validate_reply(&r, &c, &c.payload().unwrap()).unwrap();
        let mut expected = serde_json::to_vec(&r).unwrap();
        assert!(expected.len() > MAX_RESULT);
        assert!(expected.len() < MAX_REPLY);
        expected.push(b'\n');
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        // The production writer bounds socket progress after serialization.
        // This receiver ends on the explicit shutdown below; a reader timeout
        // started before serialization would impose a different timing contract.
        let receiver = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let sent = send(&mut writer, &r);
        writer.shutdown(std::net::Shutdown::Write).unwrap();
        let received = receiver.join().unwrap();
        assert!(sent, "two bounded query receipts must fit the reply writer");
        assert_eq!(received, expected);

        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        r.rows[0].receipt.stderr = "x".repeat(MAX_REPLY);
        assert!(!send(&mut writer, &r));
        assert_eq!(
            reader.read(&mut [0u8; 1]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn original_bytes_deadline_and_all_private_input_members_bind_digest() {
        let c = config();
        c.validate().unwrap();
        assert_eq!(
            c.payload().unwrap().get(),
            "{\n\"opaque\":1e9999,\"cwd\":\"/tmp\"\n}"
        );
        let encoded = serde_json::to_vec(&c).unwrap();
        assert!(
            !encoded.contains(&b'\n'),
            "configuration must remain one physical frame"
        );
        for (key, value) in [
            ("id", json!("foreign")),
            ("runtimeDigest", json!("d".repeat(64))),
            ("nonce", json!("e".repeat(64))),
            ("callerCwd", json!("/other")),
            ("environment", json!({"HOME":"/other"})),
            ("payload", json!(STANDARD.encode(b"{}"))),
            ("deadline", json!({"startedNs":1,"expiresNs":3})),
        ] {
            let mut changed = serde_json::to_value(&c).unwrap();
            changed[key] = value;
            assert!(
                serde_json::from_value::<Configuration>(changed)
                    .unwrap()
                    .validate()
                    .is_err(),
                "unbound {key}"
            );
        }
        let mut changed = serde_json::to_value(&c).unwrap();
        changed["executor"]["inode"] = json!(99);
        assert!(
            serde_json::from_value::<Configuration>(changed)
                .unwrap()
                .validate()
                .is_err()
        );
        let mut changed = serde_json::to_value(&c).unwrap();
        changed["argv"] = json!(["arbitrary"]);
        assert!(serde_json::from_value::<Configuration>(changed).is_err());
    }
    #[test]
    fn reply_requires_original_binding_cwd_order_status_and_real_eof() {
        let c = config();
        let payload = c.payload().unwrap();
        let good = reply(&c);
        validate_reply(&good, &c, &payload).unwrap();
        for key in ["schema", "id", "runtimeDigest", "nonce", "inputDigest"] {
            let mut changed = serde_json::to_value(&good).unwrap();
            changed[key] = json!("foreign");
            assert!(
                validate_reply(&serde_json::from_value(changed).unwrap(), &c, &payload).is_err(),
                "accepted {key}"
            );
        }
        for (key, value) in [
            ("ordinal", json!(2)),
            ("operation", json!("commonDir")),
            ("cwd", json!("/foreign")),
        ] {
            let mut changed = serde_json::to_value(&good).unwrap();
            changed["rows"][0][key] = value;
            assert!(
                validate_reply(&serde_json::from_value(changed).unwrap(), &c, &payload).is_err(),
                "accepted query {key}"
            );
        }
        for key in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
            let mut changed = serde_json::to_value(&good).unwrap();
            changed["rows"][0]["receipt"]["cleanup"][key] = json!(false);
            assert!(
                validate_reply(&serde_json::from_value(changed).unwrap(), &c, &payload).is_err(),
                "accepted missing {key}"
            );
        }
        let mut changed = good.clone();
        changed.deadline.expires_ns += 1;
        assert!(validate_reply(&changed, &c, &payload).is_err());
        let mut changed = good.clone();
        changed.rows[0].receipt.exit_code = Some(7);
        assert!(validate_reply(&changed, &c, &payload).is_err());
        let mut changed = good.clone();
        changed.rows[0].receipt.stdout = STANDARD.encode(vec![b'x'; MAX_OUTPUT + 1]);
        assert!(validate_reply(&changed, &c, &payload).is_err());
        let mut changed = good;
        changed.rows[1].receipt.stdout.push('\n');
        assert!(validate_reply(&changed, &c, &payload).is_err());
    }
    #[test]
    fn pending_is_not_capture_and_terminal_failure_keeps_actual_exit_separate() {
        let c = config();
        let payload = c.payload().unwrap();
        let mut r = reply(&c);
        r.rows.truncate(1);
        r.terminal = false;
        r.project = None;
        r.rows[0].receipt.status = "cleanup_unsettled".into();
        r.rows[0].receipt.cleanup.stdout_eof = false;
        r.rows[0].receipt.cleanup.reaped = false;
        r.rows[0].receipt.exit_code = Some(7);
        validate_reply(&r, &c, &payload).unwrap();
        assert!(successful_output(&r.rows[0].receipt).is_err());
        r.terminal = true;
        r.failure = Some(WireFailure {
            phase: "Cleanup".into(),
            message: "actual custody pending".into(),
        });
        assert!(
            validate_reply(&r, &c, &payload).is_err(),
            "terminal cannot close pipes and call that EOF"
        );
        r.rows[0].receipt.status = "exited".into();
        r.rows[0].receipt.cleanup.stdout_eof = true;
        r.rows[0].receipt.cleanup.reaped = true;
        validate_reply(&r, &c, &payload).unwrap();
        assert_eq!(r.rows[0].receipt.exit_code, Some(7));
        assert_eq!(
            successful_output(&r.rows[0].receipt)
                .err()
                .unwrap()
                .first_phase,
            project::ProjectPhase::QueryStatus
        );
    }
    #[test]
    fn shared_success_parser_refuses_non_utf8_stderr_and_nonzero_status() {
        let c = config();
        let good = reply(&c);
        let q = &good.rows[0].receipt;
        let parsed = successful_output(q).unwrap();
        assert_eq!(parsed.stdout, b"/tmp\n");
        assert!(parsed.cleanup.pipes.stdout_eof);
        assert!(parsed.cleanup.pipes.stderr_eof);
        assert!(!parsed.cleanup.ownership_retained);
        let mut q = q.clone();
        q.stderr = STANDARD.encode([0xff]);
        assert_eq!(
            successful_output(&q).err().unwrap().first_phase,
            project::ProjectPhase::QueryStatus
        );
        q.stderr.clear();
        q.exit_code = None;
        q.signal = Some(libc::SIGTERM);
        assert_eq!(
            successful_output(&q).err().unwrap().first_phase,
            project::ProjectPhase::QueryStatus
        );
    }
    #[test]
    fn private_frames_reject_duplicate_trailing_incomplete_and_rewritten_pending() {
        fn pending(c: Configuration) -> (Pending, UnixStream) {
            let payload = c.payload().unwrap();
            let (control, peer) = UnixStream::pair().unwrap();
            control.set_nonblocking(true).unwrap();
            (
                Pending {
                    child: None,
                    pid: 0,
                    control,
                    input: Vec::new(),
                    written: 0,
                    output: Vec::new(),
                    received: 0,
                    frames: 0,
                    latest: None,
                    eof: false,
                    exited_successfully: true,
                    aborted_configuration: false,
                    configuration: c,
                    payload,
                    protocol_error: None,
                },
                peer,
            )
        }
        fn encoded(r: &Reply) -> Vec<u8> {
            let mut bytes = serde_json::to_vec(r).unwrap();
            bytes.push(b'\n');
            bytes
        }
        for case in [
            "duplicate-terminal",
            "incomplete",
            "trailing",
            "rewritten-pid",
            "duplicate-pending",
            "pending-then-success",
        ] {
            let c = config();
            let terminal = reply(&c);
            let (mut p, mut peer) = pending(c);
            let mut bytes = encoded(&terminal);
            match case {
                "duplicate-terminal" => bytes.extend(encoded(&terminal)),
                "incomplete" => {
                    bytes.pop();
                }
                "trailing" => bytes.extend(b"unexpected"),
                "pending-then-success" => {
                    let mut initial = terminal.clone();
                    initial.terminal = false;
                    initial.project = None;
                    initial.rows[1].receipt.status = "cleanup_unsettled".into();
                    initial.rows[1].receipt.cleanup.stdout_eof = false;
                    initial.rows[1].receipt.cleanup.reaped = false;
                    bytes = encoded(&initial);
                    bytes.extend(encoded(&terminal));
                }
                "rewritten-pid" | "duplicate-pending" => {
                    let mut initial = terminal.clone();
                    initial.rows.truncate(1);
                    initial.terminal = false;
                    initial.project = None;
                    initial.rows[0].receipt.status = "cleanup_unsettled".into();
                    initial.rows[0].receipt.cleanup.stdout_eof = false;
                    initial.rows[0].receipt.cleanup.reaped = false;
                    bytes = encoded(&initial);
                    if case == "duplicate-pending" {
                        bytes.extend(encoded(&initial))
                    } else {
                        let mut settled = initial.clone();
                        settled.terminal = true;
                        settled.failure = Some(WireFailure {
                            phase: "Cleanup".into(),
                            message: "settled".into(),
                        });
                        settled.rows[0].receipt.pid = Some(999);
                        settled.rows[0].receipt.cleanup.stdout_eof = true;
                        settled.rows[0].receipt.cleanup.reaped = true;
                        bytes.extend(encoded(&settled));
                    }
                }
                _ => unreachable!(),
            }
            peer.write_all(&bytes).unwrap();
            peer.shutdown(std::net::Shutdown::Write).unwrap();
            assert!(p.advance().is_err(), "accepted {case}");
        }
    }
}
