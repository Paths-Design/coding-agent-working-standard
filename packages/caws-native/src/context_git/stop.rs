//! Fixed maintained-distribution Stop queries. Every Security.framework call
//! and resolver/Git Child stays in the native custodian. The frontend retains
//! its actual custodian Child and sole liveness channel through terminal cleanup.
//! Apple signing, the platform loader, trust store and linked system libraries
//! are TCB; hashes observe an installation, never authorize arbitrary PATH code.
//! File pinning detects ordinary replacement, not hostile same-UID race attacks.
use super::*;
use crate::{invocation_project as project, session_cache_wire::OriginalStopCapture};
use std::{collections::BTreeMap, path::Path};

pub(super) const CONFIG_SCHEMA: &str = "caws.native.stop-git.configuration.v1";
const REPLY_SCHEMA: &str = "caws.native.stop-git.reply.v1";
pub const OBSERVATION_SCHEMA: &str = "caws.runtime.stop-git-distribution.v1";
// Five bounded query rows can each retain one MAX_OUTPUT payload in base64,
// alongside the independently bounded distribution observation.
const MAX_REPLY: usize = 8 * 1024 * 1024;
const GIT_REQUIREMENT: &str = "identifier \"com.apple.git\" and anchor apple";
const SHIM_REQUIREMENT: &str =
    "identifier \"com.apple.dt.xcode_select.tool-shim-public\" and anchor apple";
const RESOLVER_REQUIREMENT: &str = "identifier \"com.apple.xcrun\" and anchor apple";
const SELECTOR_REQUIREMENT: &str = "identifier \"com.apple.xcode-select\" and anchor apple";
const LOADER_TCB: &[&str] = &[
    "macos-platform-loader",
    "apple-code-signing-trust-store",
    "Security.framework",
    "CoreFoundation.framework",
    "CoreServices.framework",
    "libSystem",
    "libz",
    "libiconv",
];
// Filesystem identifiers are full-width u64 values. JSON numbers lose actual
// macOS inode bits when the observation passes through the Node producer.
mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value = text.parse::<u64>().map_err(D::Error::custom)?;
        if value.to_string() != text {
            return Err(D::Error::custom("noncanonical filesystem identity"));
        }
        Ok(value)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pinned {
    path: PathBuf,
    physical_path: PathBuf,
    sha256: String,
    #[serde(with = "decimal_u64")]
    device: u64,
    #[serde(with = "decimal_u64")]
    inode: u64,
    bytes: u64,
    mode: u32,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}
impl Pinned {
    fn capture(value: &project::SelectedExecutable) -> Self {
        let i = &value.identity;
        Self {
            path: value.path.clone(),
            physical_path: value.physical_path.clone(),
            sha256: value.sha256.clone(),
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryIdentity {
    physical_path: PathBuf,
    #[serde(with = "decimal_u64")]
    device: u64,
    #[serde(with = "decimal_u64")]
    inode: u64,
    mode: u32,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}
impl DirectoryIdentity {
    fn capture(path: &Path) -> Result<Self, String> {
        let physical_path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let m = fs::metadata(&physical_path).map_err(|e| e.to_string())?;
        if !m.is_dir() {
            return Err("default developer route is not a directory".into());
        }
        Ok(Self {
            physical_path,
            device: m.dev(),
            inode: m.ino(),
            mode: m.mode(),
            modified_seconds: m.mtime(),
            modified_nanoseconds: m.mtime_nsec(),
            changed_seconds: m.ctime(),
            changed_nanoseconds: m.ctime_nsec(),
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OsIdentity {
    kernel_release: String,
    kernel_version: String,
    machine: String,
}
fn os_identity() -> Result<OsIdentity, String> {
    let mut u = std::mem::MaybeUninit::<libc::utsname>::zeroed();
    if unsafe { libc::uname(u.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    let u = unsafe { u.assume_init() };
    let text = |p: *const libc::c_char| {
        unsafe { std::ffi::CStr::from_ptr(p) }
            .to_str()
            .map(str::to_owned)
            .map_err(|e| e.to_string())
    };
    Ok(OsIdentity {
        kernel_release: text(u.release.as_ptr())?,
        kernel_version: text(u.version.as_ptr())?,
        machine: text(u.machine.as_ptr())?,
    })
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provenance {
    authenticator: String,
    requirements: Vec<String>,
    loader_tcb: Vec<String>,
}
fn provenance() -> Provenance {
    Provenance {
        authenticator:
            "Security.framework/SecStaticCodeCheckValidity/all-architectures+strict/no-network"
                .into(),
        requirements: [
            GIT_REQUIREMENT,
            SHIM_REQUIREMENT,
            RESOLVER_REQUIREMENT,
            SELECTOR_REQUIREMENT,
        ]
        .map(str::to_owned)
        .to_vec(),
        loader_tcb: LOADER_TCB.iter().map(|s| (*s).into()).collect(),
    }
}
/// Serializable observed data only. This type never grants execution or effects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    schema: String,
    platform: String,
    os: OsIdentity,
    inspector_native_sha256: String,
    caller_git: Pinned,
    resolver: Pinned,
    developer_selector: Pinned,
    developer_directory: PathBuf,
    developer_identity: DirectoryIdentity,
    implementation: Pinned,
    provenance: Provenance,
}
impl Observation {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != OBSERVATION_SCHEMA
            || self.platform != "macos"
            || !lower_hex(&self.inspector_native_sha256)
            || [
                &self.caller_git,
                &self.resolver,
                &self.developer_selector,
                &self.implementation,
            ]
            .iter()
            .any(|p| !p.valid())
            || self.resolver.path != Path::new("/usr/bin/xcrun")
            || self.developer_selector.path != Path::new("/usr/bin/xcode-select")
            || !self.developer_directory.is_absolute()
            || !self.developer_identity.physical_path.is_absolute()
            || self.developer_directory.as_os_str().as_bytes().contains(&0)
            || self.developer_directory.as_os_str().as_bytes().len() > 4096
            || [
                &self.os.kernel_release,
                &self.os.kernel_version,
                &self.os.machine,
            ]
            .iter()
            .any(|s| s.is_empty() || s.len() > 4096 || s.contains('\0'))
            || self.provenance != provenance()
        {
            return Err("unsupported observed Stop Git distribution or provenance".into());
        }
        Ok(())
    }
    pub fn inspector_native_sha256(&self) -> &str {
        &self.inspector_native_sha256
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    cwd: PathBuf,
    caller_git: Pinned,
    executor: Pinned,
    environment: BTreeMap<String, String>,
    expires_ns: u64,
    expected: Option<Observation>,
    common_dir: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    status: String,
    diagnostic: String,
    observation: Option<Observation>,
    common_dir: Option<String>,
    rows: Vec<QueryReceipt>,
}
fn positive_cleanup(r: &QueryReceipt) -> bool {
    let c = &r.cleanup;
    c.group_settled && c.stdout_eof && c.stderr_eof && c.reaped
}
fn validate_reply(r: &Reply, id: &str, digest: &str, token: &str) -> Result<(), String> {
    if r.schema != REPLY_SCHEMA
        || r.id != id
        || r.runtime_digest != digest
        || r.token != token
        || r.rows.len() > 5
        || r.diagnostic.len() > 1024
        || !matches!(
            r.status.as_str(),
            "observed" | "common_dir" | "best_effort" | "unsupported" | "invalidated"
        )
    {
        return Err("private Stop reply identity/domain mismatch".into());
    }
    for q in &r.rows {
        let out = STANDARD
            .decode(&q.stdout)
            .map_err(|_| "Stop stdout encoding")?;
        let err = STANDARD
            .decode(&q.stderr)
            .map_err(|_| "Stop stderr encoding")?;
        if !positive_cleanup(q)
            || out.len() + err.len() > MAX_OUTPUT
            || STANDARD.encode(&out) != q.stdout
            || STANDARD.encode(&err) != q.stderr
            || q.pid.is_some_and(|p| p <= 1)
            || q.exit_code.is_some() && q.signal.is_some()
            || q.status == "exited"
                && (q.pid.is_none() || q.exit_code.is_none() && q.signal.is_none())
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
        {
            return Err("private Stop query/cleanup mismatch".into());
        }
    }
    if let Some(observation) = &r.observation {
        observation.validate()?;
    }
    let successful =
        |q: &QueryReceipt| q.status == "exited" && q.signal.is_none() && q.exit_code == Some(0);
    if matches!(r.status.as_str(), "observed" | "common_dir" | "best_effort") {
        if r.rows
            .iter()
            .enumerate()
            .any(|(i, q)| !(r.status == "best_effort" && i == 2) && !successful(q))
        {
            return Err("successful Stop result contains failed query".into());
        }
        if r.status == "best_effort"
            && !r.rows.get(2).is_some_and(|q| {
                q.status == "exited" && q.signal.is_none() && q.exit_code.is_some_and(|c| c != 0)
            })
        {
            return Err("Stop best-effort result lacks nonzero Git query".into());
        }
        if let Some(path) = &r.common_dir {
            let bytes = r
                .rows
                .get(2)
                .ok_or("Stop common-dir query missing")
                .and_then(|q| {
                    STANDARD
                        .decode(&q.stdout)
                        .map_err(|_| "Stop common-dir encoding")
                })?;
            if output_path(&bytes)?.to_str() != Some(path) {
                return Err("Stop common-dir differs from query bytes".into());
            }
        }
    }
    match r.status.as_str() {
        "observed" if r.observation.is_some() && r.common_dir.is_none() && r.rows.len() == 4 => {
            Ok(())
        }
        "common_dir" if r.observation.is_some() && r.common_dir.is_some() && r.rows.len() == 5 => {
            Ok(())
        }
        "best_effort" if r.observation.is_some() && r.common_dir.is_none() && r.rows.len() == 5 => {
            Ok(())
        }
        "unsupported" | "invalidated" if r.common_dir.is_none() => Ok(()),
        _ => Err("private Stop result missing fixed observations".into()),
    }
}
/// Actual remote ownership. Drop closes liveness; it does not kill or detach a
/// Git child. The remote owns Git until settlement/EOF/reap; this value owns its
/// actual custodian Child until terminal exit and channel EOF are observed.
#[must_use = "retain the actual remote Stop custodian through cleanup"]
pub struct Failure {
    pub diagnostic: String,
    pending: Pending,
}
impl std::fmt::Debug for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StopGitFailure")
            .field("diagnostic", &self.diagnostic)
            .field("custodianPid", &self.pending.pid)
            .field("reply", &self.pending.reply)
            .field("cleanupSettled", &self.cleanup_settled())
            .finish()
    }
}
impl Failure {
    pub fn cleanup_settled(&self) -> bool {
        self.pending.child.is_none()
            && self.pending.exited_successfully
            && self.pending.eof
            && (self.pending.pid == 0
                || self.pending.aborted_configuration
                || self
                    .pending
                    .reply
                    .as_ref()
                    .is_some_and(|r| r.rows.iter().all(positive_cleanup)))
    }
    /// Only the frontend wait is bounded here. The existing custodian keeps
    /// actual-child custody after the original invocation stops waiting.
    pub fn retry_cleanup_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        if self.cleanup_settled() {
            return Ok(());
        }
        self.pending.cancel();
        let until = until.min(original.expires());
        loop {
            frontend_cleanup_check(original, until)?;
            match self
                .pending
                .advance_checked(|| frontend_cleanup_check(original, until).map(|_| ()))
            {
                Ok(true) => {
                    return if self.cleanup_settled() {
                        Ok(())
                    } else {
                        Err("remote Stop cleanup lacks terminal custody receipt".into())
                    };
                }
                Ok(false) => (),
                Err(error) => {
                    // A malformed receipt cannot prove cleanup, but the exact
                    // custodian Child may still be observed/reaped nonblocking.
                    if let Some(child) = self.pending.child.as_mut()
                        && let Some(status) = child.try_wait().map_err(|e| e.to_string())?
                    {
                        self.pending.child = None;
                        self.pending.exited_successfully = status.success();
                    }
                    return Err(error);
                }
            }
            let mut fds = self
                .pending
                .control
                .as_ref()
                .map(|control| libc::pollfd {
                    fd: control.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                })
                .into_iter()
                .collect::<Vec<_>>();
            frontend_cleanup_poll(original, until, &mut fds)?;
        }
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        if self.cleanup_settled() {
            return Ok(());
        }
        self.pending.cancel();
        let until = Instant::now() + CLEANUP;
        loop {
            match self.pending.advance() {
                Ok(true) => {
                    return if self.cleanup_settled() {
                        Ok(())
                    } else {
                        Err("remote Stop cleanup lacks terminal custody receipt".into())
                    };
                }
                Ok(false) => (),
                Err(e) => {
                    // A malformed/abnormal terminal response cannot prove Git
                    // settlement. It must not prevent observing our actual Child.
                    if let Some(child) = self.pending.child.as_mut() {
                        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                            self.pending.child = None;
                            self.pending.exited_successfully = status.success();
                        }
                    }
                    return Err(e);
                }
            }
            if Instant::now() >= until {
                return Err("remote Stop custodian retains unsettled custody".into());
            }
            self.pending.tick();
        }
    }
    /// Actual process custody only; false does not manufacture a cleanup proof.
    pub fn custodian_retained(&self) -> bool {
        self.pending.child.is_some()
    }
    pub fn custodian_pid(&self) -> u32 {
        self.pending.pid
    }
    /// Untrusted bounded transport bytes, never an observation or cleanup grant.
    pub fn raw_reply(&self) -> &[u8] {
        &self.pending.output
    }
    pub fn receipt(&self) -> Option<serde_json::Value> {
        self.pending
            .reply
            .as_ref()
            .and_then(|r| serde_json::to_value(r).ok())
    }
}
struct Pending {
    child: Option<Child>,
    pid: u32,
    control: Option<UnixStream>,
    input: Vec<u8>,
    written: usize,
    output: Vec<u8>,
    frame_end: Option<usize>,
    reply: Option<Reply>,
    eof: bool,
    exited_successfully: bool,
    id: String,
    digest: String,
    token: String,
    aborted_configuration: bool,
    cancel_requested: bool,
}
impl Pending {
    fn cancel(&mut self) {
        if self.cancel_requested {
            return;
        }
        self.cancel_requested = true;
        if self.written < self.input.len() {
            self.aborted_configuration = true;
            self.input.truncate(self.written);
        }
        if let Some(control) = &self.control {
            let _ = control.shutdown(std::net::Shutdown::Write);
        }
    }
    fn tick(&self) {
        if let Some(control) = &self.control {
            tick(&mut [libc::pollfd {
                fd: control.as_raw_fd(),
                events: libc::POLLIN
                    | if self.written < self.input.len() {
                        libc::POLLOUT
                    } else {
                        0
                    },
                revents: 0,
            }]);
        } else {
            std::thread::sleep(TICK);
        }
    }
    fn advance(&mut self) -> Result<bool, String> {
        self.advance_checked(|| Ok(()))
    }
    fn advance_checked(
        &mut self,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<bool, String> {
        check()?;
        if self.output.len() > MAX_REPLY {
            return Err("private Stop reply exceeded bound".into());
        }
        let control = self
            .control
            .as_mut()
            .ok_or("remote Stop control unavailable")?;
        while self.written < self.input.len() {
            check()?;
            match control.write(&self.input[self.written..]) {
                Ok(0) => return Err("remote Stop configuration write closed".into()),
                Ok(n) => self.written += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        if !self.eof {
            loop {
                check()?;
                let mut bytes = [0u8; 8192];
                let capacity = (MAX_REPLY + 1 - self.output.len()).min(bytes.len());
                match control.read(&mut bytes[..capacity]) {
                    Ok(0) => {
                        self.eof = true;
                        break;
                    }
                    Ok(n) => {
                        if self.frame_end.is_none() {
                            self.frame_end = bytes[..n]
                                .iter()
                                .position(|b| *b == b'\n')
                                .map(|offset| self.output.len() + offset);
                        }
                        self.output.extend_from_slice(&bytes[..n]);
                        if self.output.len() > MAX_REPLY {
                            return Err("private Stop reply exceeded bound".into());
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        check()?;
        if let Some(end) = self.frame_end {
            if end + 1 != self.output.len() {
                return Err("trailing private Stop reply bytes".into());
            }
            if self.reply.is_none() {
                let reply: Reply =
                    serde_json::from_slice(&self.output[..end]).map_err(|e| e.to_string())?;
                validate_reply(&reply, &self.id, &self.digest, &self.token)?;
                self.reply = Some(reply);
            }
        }
        check()?;
        if self.eof {
            let Some(child) = self.child.as_mut() else {
                return Ok(true);
            };
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                self.child = None;
                self.exited_successfully = status.success();
                if !status.success() {
                    return Err(format!("Stop custodian exited abnormally: {status}"));
                }
                if self.reply.is_none() && !self.aborted_configuration {
                    return Err("Stop custodian closed without a complete receipt".into());
                }
                return Ok(true);
            }
        }
        Ok(false)
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.control.take();
        if let Some(mut child) = self.child.take() {
            let _ = std::thread::Builder::new()
                .name("caws-stop-git-reap".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

fn empty_pending(id: &str, digest: &str, token: &str) -> Pending {
    Pending {
        child: None,
        pid: 0,
        control: None,
        input: Vec::new(),
        written: 0,
        output: Vec::new(),
        frame_end: None,
        reply: None,
        eof: true,
        exited_successfully: true,
        id: id.into(),
        digest: digest.into(),
        token: token.into(),
        aborted_configuration: false,
        cancel_requested: false,
    }
}
fn remote(
    mut config: Configuration,
    executor: &project::SelectedExecutable,
    expires: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<Pending, Failure> {
    let token = config.token.clone();
    let mut pending = empty_pending(&config.id, &config.runtime_digest, &token);
    let start = (|| -> Result<(), String> {
        project::verify_executable(
            executor,
            project::ProjectPhase::BeforeLaunch,
            expires,
            cancelled,
        )
        .map_err(|e| e.to_string())?;
        config.expires_ns = monotonic_ns().saturating_add(
            expires
                .saturating_duration_since(Instant::now())
                .as_nanos()
                .min(u128::from(u64::MAX)) as u64,
        );
        let mut bytes = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
        if bytes.len() >= MAX_CONFIGURATION {
            return Err("Stop configuration exceeds original environment bound".into());
        }
        bytes.push(b'\n');
        let (control, remote) = UnixStream::pair().map_err(|e| e.to_string())?;
        control.set_nonblocking(true).map_err(|e| e.to_string())?;
        let fd = unsafe { libc::fcntl(remote.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        if fd < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let remote = unsafe { OwnedFd::from_raw_fd(fd) };
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
        let child = command.spawn().map_err(|e| e.to_string())?;
        let pid = child.id();
        drop(remote);
        pending.child = Some(child);
        pending.pid = pid;
        pending.control = Some(control);
        pending.input = bytes;
        pending.eof = false;
        pending.exited_successfully = false;
        Ok(())
    })();
    if let Err(diagnostic) = start {
        return Err(Failure {
            diagnostic,
            pending,
        });
    }
    loop {
        let interrupted = cancelled();
        if interrupted || Instant::now() >= expires {
            pending.cancel();
            return Err(Failure {
                diagnostic: if interrupted {
                    "original Stop Git cancelled"
                } else {
                    "original Stop Git deadline"
                }
                .into(),
                pending,
            });
        }
        match pending.advance() {
            Ok(true) => {
                if let Err(e) = project::verify_executable(
                    executor,
                    project::ProjectPhase::AfterLaunch,
                    expires,
                    cancelled,
                ) {
                    return Err(Failure {
                        diagnostic: e.to_string(),
                        pending,
                    });
                }
                return Ok(pending);
            }
            Ok(false) => pending.tick(),
            Err(diagnostic) => {
                pending.cancel();
                return Err(Failure {
                    diagnostic,
                    pending,
                });
            }
        }
    }
}
fn configuration(
    id: &str,
    digest: &str,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    git: &project::SelectedExecutable,
    executor: &project::SelectedExecutable,
    expected: Option<Observation>,
    common_dir: bool,
) -> Configuration {
    Configuration {
        schema: CONFIG_SCHEMA.into(),
        id: id.into(),
        runtime_digest: digest.into(),
        token: format!("stop-git-{}-{}", std::process::id(), monotonic_ns()),
        cwd: cwd.into(),
        caller_git: Pinned::capture(git),
        executor: Pinned::capture(executor),
        environment: environment.clone(),
        expires_ns: 0,
        expected,
        common_dir,
    }
}
/// Evidence-only tooling captures its own process inputs and one original 5s
/// operation deadline. Failure retains custody; the command must finish cleanup.
pub fn inspect_current() -> Result<Observation, Failure> {
    let expires = Instant::now() + Duration::from_secs(5);
    let fail = |diagnostic: String| Failure {
        diagnostic,
        pending: empty_pending("stop-git-inspect", &"0".repeat(64), ""),
    };
    let environment = std::env::vars_os()
        .map(|(k, v)| {
            Ok((
                k.into_string()
                    .map_err(|_| fail("inspection environment key is not UTF8".into()))?,
                v.into_string()
                    .map_err(|_| fail("inspection environment value is not UTF8".into()))?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, Failure>>()?;
    let path = std::env::current_exe().map_err(|e| fail(e.to_string()))?;
    let executor =
        project::pin_executable(&path, expires, &|| false).map_err(|e| fail(e.to_string()))?;
    let cwd = std::env::current_dir().map_err(|e| fail(e.to_string()))?;
    inspect(&executor, &cwd, &environment, expires, &|| false)
}
/// Evidence only: neither this function nor its JSON can construct admission.
pub fn inspect(
    executor: &project::SelectedExecutable,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    expires: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<Observation, Failure> {
    let id = format!("stop-git-inspect-{}", std::process::id());
    let digest = &executor.sha256;
    let git = project::select_render_executable(
        cwd.to_str().ok_or_else(|| Failure {
            diagnostic: "inspection cwd is not UTF8".into(),
            pending: empty_pending(&id, digest, ""),
        })?,
        environment,
        expires,
        cancelled,
    )
    .map_err(|e| Failure {
        diagnostic: e.to_string(),
        pending: empty_pending(&id, digest, ""),
    })?;
    let config = configuration(&id, digest, cwd, environment, &git, executor, None, false);
    let mut pending = remote(config, executor, expires, cancelled)?;
    let reply = pending.reply.as_mut().expect("validated terminal reply");
    if reply.status != "observed" {
        return Err(Failure {
            diagnostic: reply.diagnostic.clone(),
            pending,
        });
    }
    Ok(reply
        .observation
        .take()
        .expect("validated observed distribution"))
}
/// A live admission borrows the real original and its monotonic deadline. It is
/// non-Clone/non-Deserialize; retained JSON is comparison data only.
pub struct DistributionReceipt<'original, 'deadline> {
    original: &'original OriginalStopCapture<'deadline>,
    executor: project::SelectedExecutable,
    observation: Observation,
}
pub enum AdmissionFailure {
    Unsupported(String),
    Invocation(Failure),
}
impl<'original, 'deadline> DistributionReceipt<'original, 'deadline> {
    pub fn admit(
        original: &'original OriginalStopCapture<'deadline>,
        executor: &project::SelectedExecutable,
        expected: &Observation,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Self, AdmissionFailure> {
        expected.validate().map_err(AdmissionFailure::Unsupported)?;
        if expected.inspector_native_sha256 != executor.sha256 {
            return Err(AdmissionFailure::Unsupported(
                "Git observation belongs to another native image".into(),
            ));
        }
        let config = configuration(
            original.id(),
            original.runtime_digest(),
            &original.observed_project().checkout,
            original.caller_environment(),
            &original.observed_project().executable,
            executor,
            Some(expected.clone()),
            false,
        );
        let mut pending = remote(config, executor, original.deadline().expires(), cancelled)
            .map_err(AdmissionFailure::Invocation)?;
        let reply = pending.reply.as_mut().expect("validated terminal reply");
        if reply.status == "unsupported" {
            return Err(AdmissionFailure::Unsupported(reply.diagnostic.clone()));
        }
        if reply.status != "observed" {
            return Err(AdmissionFailure::Invocation(Failure {
                diagnostic: reply.diagnostic.clone(),
                pending,
            }));
        }
        Ok(Self {
            original,
            executor: executor.clone(),
            observation: reply
                .observation
                .take()
                .expect("validated observed distribution"),
        })
    }
    pub fn revalidate(&self, cancelled: &dyn Fn() -> bool) -> Result<(), Failure> {
        let config = configuration(
            self.original.id(),
            self.original.runtime_digest(),
            &self.original.observed_project().checkout,
            self.original.caller_environment(),
            &self.original.observed_project().executable,
            &self.executor,
            Some(self.observation.clone()),
            false,
        );
        let pending = remote(
            config,
            &self.executor,
            self.original.deadline().expires(),
            cancelled,
        )?;
        let reply = pending.reply.as_ref().expect("validated terminal reply");
        if reply.status != "observed" {
            return Err(Failure {
                diagnostic: reply.diagnostic.clone(),
                pending,
            });
        }
        Ok(())
    }
    /// Consumed exactly once by the late requesting-consumer boundary. This
    /// returns a fresh query result, never a lease-write permission or replay.
    pub fn observe_common_dir(
        self,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<SettledCommonDir, Failure> {
        let config = configuration(
            self.original.id(),
            self.original.runtime_digest(),
            &self.original.observed_project().checkout,
            self.original.caller_environment(),
            &self.original.observed_project().executable,
            &self.executor,
            Some(self.observation),
            true,
        );
        let mut pending = remote(
            config,
            &self.executor,
            self.original.deadline().expires(),
            cancelled,
        )?;
        let reply = pending.reply.as_mut().expect("validated terminal reply");
        match reply.status.as_str() {
            "best_effort" => Ok(SettledCommonDir::GitFailed),
            "common_dir" => {
                let raw = reply.common_dir.take().expect("validated common-dir");
                let common = PathBuf::from(raw);
                if common.parent()
                    != Some(self.original.observed_project().canonical_root.as_path())
                {
                    return Err(Failure {
                        diagnostic: "late Stop Git root differs from original admission".into(),
                        pending,
                    });
                }
                Ok(SettledCommonDir::Resolved { common_dir: common })
            }
            _ => Err(Failure {
                diagnostic: reply.diagnostic.clone(),
                pending,
            }),
        }
    }
}
/// A settled failed command must preserve the ordinary best-effort no-lease path.
pub enum SettledCommonDir {
    Resolved { common_dir: PathBuf },
    GitFailed,
}

#[cfg(target_os = "macos")]
mod signing {
    use super::*;
    use std::ffi::c_void;
    type Ref = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(
            a: Ref,
            b: *const u8,
            len: isize,
            dir: u8,
        ) -> Ref;
        fn CFStringCreateWithCString(a: Ref, s: *const libc::c_char, encoding: u32) -> Ref;
        fn CFRelease(value: Ref);
    }
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecStaticCodeCreateWithPath(path: Ref, flags: u32, code: *mut Ref) -> i32;
        fn SecRequirementCreateWithString(text: Ref, flags: u32, requirement: *mut Ref) -> i32;
        fn SecStaticCodeCheckValidity(code: Ref, flags: u32, requirement: Ref) -> i32;
    }
    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }
    pub(super) fn authenticate(path: &Path, requirement: &str) -> Result<(), String> {
        let bytes = path.as_os_str().as_bytes();
        let s = std::ffi::CString::new(requirement).map_err(|e| e.to_string())?;
        let url = Owned(unsafe {
            CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
                0,
            )
        });
        let text =
            Owned(unsafe { CFStringCreateWithCString(std::ptr::null(), s.as_ptr(), 0x08000100) });
        if url.0.is_null() || text.0.is_null() {
            return Err("Apple signature input allocation failed".into());
        }
        let mut code = Owned(std::ptr::null());
        let mut req = Owned(std::ptr::null());
        let a = unsafe { SecStaticCodeCreateWithPath(url.0, 0, &mut code.0) };
        let b = unsafe { SecRequirementCreateWithString(text.0, 0, &mut req.0) };
        if a != 0 || b != 0 {
            return Err(format!(
                "Apple signature object/requirement refused: {a}/{b}"
            ));
        }
        let status = unsafe { SecStaticCodeCheckValidity(code.0, (1 << 0) | (1 << 4), req.0) };
        if status != 0 {
            return Err(format!("Apple signature requirement refused: {status}"));
        }
        Ok(())
    }
}
#[cfg(not(target_os = "macos"))]
mod signing {
    use super::*;
    pub(super) fn authenticate(_: &Path, _: &str) -> Result<(), String> {
        Err("maintained Git requires macOS Apple signing".into())
    }
}
fn checkpoint(expires: u64) -> Result<(), String> {
    if SIGNAL.load(Ordering::Relaxed) != 0 || monotonic_ns() >= expires {
        return Err("Stop Git custodian interrupted or deadline".into());
    }
    Ok(())
}
fn pin(path: &Path, expires: u64) -> Result<project::SelectedExecutable, String> {
    checkpoint(expires)?;
    project::pin_executable(
        path,
        Instant::now() + Duration::from_nanos(expires.saturating_sub(monotonic_ns())),
        &|| SIGNAL.load(Ordering::Relaxed) != 0,
    )
    .map_err(|e| e.to_string())
}
enum CaptureFailure {
    Unsupported(String),
    Invalidated(String),
}
impl From<String> for CaptureFailure {
    fn from(e: String) -> Self {
        Self::Invalidated(e)
    }
}
impl CaptureFailure {
    fn diagnostic(self) -> String {
        match self {
            Self::Unsupported(e) | Self::Invalidated(e) => e,
        }
    }
}
fn authenticate(
    selected: &project::SelectedExecutable,
    requirement: &str,
    expires: u64,
) -> Result<(), CaptureFailure> {
    checkpoint(expires)?;
    let before = pin(&selected.path, expires)?;
    if before != *selected {
        return Err(CaptureFailure::Invalidated(
            "Stop Git executable changed before authentication".into(),
        ));
    }
    signing::authenticate(&selected.physical_path, requirement)
        .map_err(CaptureFailure::Unsupported)?;
    checkpoint(expires)?;
    if pin(&selected.path, expires)? != *selected {
        return Err(CaptureFailure::Invalidated(
            "Stop Git executable changed during authentication".into(),
        ));
    }
    Ok(())
}
fn cli_trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn output_path(bytes: &[u8]) -> Result<PathBuf, String> {
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let text = cli_trim(text);
    if text.is_empty() || text.len() > 4096 || text.contains('\0') || !Path::new(text).is_absolute()
    {
        return Err("Stop Git path outside finite absolute UTF8 domain".into());
    }
    Ok(text.into())
}
fn query(
    stream: &mut UnixStream,
    config: &Configuration,
    selected: &project::SelectedExecutable,
    argv: &'static [&'static str],
    rows: &mut Vec<QueryReceipt>,
) -> Result<Vec<u8>, String> {
    checkpoint(config.expires_ns)?;
    let environment: Vec<_> = config
        .environment
        .iter()
        .map(|(k, v)| (k.as_bytes().to_vec(), v.as_bytes().to_vec()))
        .collect();
    let until = config.expires_ns.saturating_sub(CLEANUP.as_nanos() as u64);
    let mut row = run_owned_query(
        stream,
        QuerySpec {
            executable: &selected.path,
            cwd: &config.cwd,
            environment: &environment,
            argv,
            expires_ns: until,
        },
        false,
        |_, _| true,
    );
    if row.status == "exited" && pin(&selected.path, config.expires_ns).as_ref() != Ok(selected) {
        row.status = "identity_changed".into();
    }
    let answer = if row.status == "exited" && row.signal.is_none() && row.exit_code == Some(0) {
        STANDARD.decode(&row.stdout).map_err(|e| e.to_string())
    } else {
        Err(format!(
            "fixed Stop query {} exit {:?} signal {:?}",
            row.status, row.exit_code, row.signal
        ))
    };
    rows.push(row);
    answer
}
fn unsupported_environment(environment: &BTreeMap<String, String>) -> bool {
    ["DEVELOPER_DIR", "TOOLCHAINS", "SDKROOT"]
        .iter()
        .any(|k| environment.get(*k).is_some_and(|v| !v.is_empty()))
        || environment.iter().any(|(key, value)| {
            !value.is_empty() && (key.starts_with("DYLD_") || key.starts_with("LD_"))
        })
}
fn capture(
    stream: &mut UnixStream,
    config: &Configuration,
    rows: &mut Vec<QueryReceipt>,
) -> Result<Observation, CaptureFailure> {
    if !cfg!(target_os = "macos") || unsupported_environment(&config.environment) {
        return Err(CaptureFailure::Unsupported(
            "unsupported platform, developer routing or loader environment".into(),
        ));
    }
    let resolver = pin(Path::new("/usr/bin/xcrun"), config.expires_ns)?;
    authenticate(&resolver, RESOLVER_REQUIREMENT, config.expires_ns)?;
    let selector = pin(Path::new("/usr/bin/xcode-select"), config.expires_ns)?;
    authenticate(&selector, SELECTOR_REQUIREMENT, config.expires_ns)?;
    let caller = config.caller_git.selected();
    // The common shim identifier covers unrelated Apple tools too. This fixed
    // platform Git component locator is necessary in addition to signing.
    let shim = caller.physical_path == Path::new("/usr/bin/git")
        && caller.path.file_name().is_some_and(|n| n == "git");
    authenticate(
        &caller,
        if shim {
            SHIM_REQUIREMENT
        } else {
            GIT_REQUIREMENT
        },
        config.expires_ns,
    )?;
    let developer_directory = output_path(&query(stream, config, &selector, &["-p"], rows)?)?;
    let developer_identity = DirectoryIdentity::capture(&developer_directory)?;
    let implementation_path =
        output_path(&query(stream, config, &resolver, &["--find", "git"], rows)?)?;
    let implementation = pin(&implementation_path, config.expires_ns)?;
    authenticate(&implementation, GIT_REQUIREMENT, config.expires_ns)?;
    if !shim && caller != implementation {
        return Err(CaptureFailure::Unsupported(
            "selected Apple Git is not the authenticated default-route implementation".into(),
        ));
    }
    if DirectoryIdentity::capture(&developer_directory)? != developer_identity {
        return Err(CaptureFailure::Invalidated(
            "default developer directory identity changed".into(),
        ));
    }
    authenticate(&resolver, RESOLVER_REQUIREMENT, config.expires_ns)?;
    authenticate(&selector, SELECTOR_REQUIREMENT, config.expires_ns)?;
    authenticate(
        &caller,
        if shim {
            SHIM_REQUIREMENT
        } else {
            GIT_REQUIREMENT
        },
        config.expires_ns,
    )?;
    authenticate(&implementation, GIT_REQUIREMENT, config.expires_ns)?;
    checkpoint(config.expires_ns)?;
    let observed = Observation {
        schema: OBSERVATION_SCHEMA.into(),
        platform: "macos".into(),
        os: os_identity()?,
        inspector_native_sha256: config.executor.sha256.clone(),
        caller_git: config.caller_git.clone(),
        resolver: Pinned::capture(&resolver),
        developer_selector: Pinned::capture(&selector),
        developer_directory,
        developer_identity,
        implementation: Pinned::capture(&implementation),
        provenance: provenance(),
    };
    observed.validate()?;
    Ok(observed)
}
pub(super) fn run_configuration(
    stream: &mut UnixStream,
    bytes: &[u8],
    cancelled: bool,
) -> Result<(), String> {
    let config: Configuration = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if config.schema != CONFIG_SCHEMA
        || config.id.is_empty()
        || config.id.len() > 128
        || config.id.contains('\0')
        || !lower_hex(&config.runtime_digest)
        || config.token.is_empty()
        || config.token.len() > 128
        || !config
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        || !config.cwd.is_absolute()
        || config.cwd.as_os_str().as_bytes().len() > 4096
        || config.cwd.as_os_str().as_bytes().contains(&0)
        || !config.caller_git.valid()
        || !config.executor.valid()
        || config.common_dir && config.expected.is_none()
        || config
            .environment
            .iter()
            .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
    {
        return Err("invalid private Stop configuration".into());
    }
    if let Some(expected) = &config.expected {
        expected.validate()?;
    }
    let actual = std::env::current_exe().map_err(|e| e.to_string())?;
    if fs::canonicalize(actual).map_err(|e| e.to_string())? != config.executor.physical_path {
        return Err("private Stop native image path changed".into());
    }
    let mut reply = Reply {
        schema: REPLY_SCHEMA.into(),
        id: config.id.clone(),
        runtime_digest: config.runtime_digest.clone(),
        token: config.token.clone(),
        status: "invalidated".into(),
        diagnostic: String::new(),
        observation: None,
        common_dir: None,
        rows: Vec::new(),
    };
    let work = (|| -> Result<(), String> {
        if cancelled {
            return Err("original Stop cancelled before private configuration".into());
        }
        if pin(&config.executor.path, config.expires_ns)? != config.executor.selected() {
            return Err("private Stop native executor identity changed".into());
        }
        let first = match capture(stream, &config, &mut reply.rows) {
            Ok(o) => o,
            Err(e) => {
                if matches!(&e, CaptureFailure::Unsupported(_)) {
                    reply.status = "unsupported".into();
                }
                return Err(e.diagnostic());
            }
        };
        if config.expected.as_ref().is_some_and(|e| *e != first) {
            reply.status = "unsupported".into();
            return Err(
                "observed Git distribution or developer route differs from generation profile"
                    .into(),
            );
        }
        let mut common = None;
        let mut failed = false;
        if config.common_dir {
            let git = first.implementation.selected();
            match query(
                stream,
                &config,
                &git,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                &mut reply.rows,
            ) {
                Ok(bytes) => common = Some(output_path(&bytes)?.to_string_lossy().into_owned()),
                Err(e) => {
                    let q = reply.rows.last().ok_or_else(|| e.clone())?;
                    if q.status == "exited"
                        && q.signal.is_none()
                        && q.exit_code.is_some_and(|c| c != 0)
                    {
                        failed = true;
                    } else {
                        return Err(e);
                    }
                }
            }
        }
        let after =
            capture(stream, &config, &mut reply.rows).map_err(CaptureFailure::diagnostic)?;
        if first != after {
            return Err(
                "Stop Git distribution or developer route changed across fixed operation".into(),
            );
        }
        reply.observation = Some(after);
        reply.common_dir = common;
        reply.status = if failed {
            "best_effort"
        } else if config.common_dir {
            "common_dir"
        } else {
            "observed"
        }
        .into();
        Ok(())
    })();
    if let Err(e) = work {
        reply.diagnostic = QueryReceipt::new("", &e).diagnostic;
        reply.common_dir = None;
    }
    let encoded = serde_json::to_vec(&reply).map_err(|e| e.to_string())?;
    if encoded.len() >= MAX_REPLY {
        return Err("private Stop result exceeds bound".into());
    }
    publish_bytes(stream, encoded);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn retained_transport_child() -> (Failure, UnixStream, std::process::ChildStdin) {
        // A real original Child and transport endpoints exercise frontend
        // custody only. This peer cannot mint native Git cleanup receipts.
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let release = child.stdin.take().unwrap();
        let (control, peer) = UnixStream::pair().unwrap();
        control.set_nonblocking(true).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut pending = empty_pending("bounded-cleanup-fixture", &"a".repeat(64), "fixture");
        pending.pid = child.id();
        pending.child = Some(child);
        pending.control = Some(control);
        pending.eof = false;
        pending.exited_successfully = false;
        (
            Failure {
                diagnostic: "original fixture failure".into(),
                pending,
            },
            peer,
            release,
        )
    }
    fn passive_reap_observed(pid: u32) {
        let until = Instant::now() + Duration::from_secs(1);
        loop {
            let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    information.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result < 0 {
                assert_eq!(
                    io::Error::last_os_error().raw_os_error(),
                    Some(libc::ECHILD)
                );
                break;
            }
            assert_eq!(result, 0);
            assert!(
                Instant::now() < until,
                "passive owner did not reap original child"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    #[test]
    fn bounded_frontend_wait_retains_actual_child_and_drop_passively_reaps_without_receipt() {
        let (mut failure, mut peer, release) = retained_transport_child();
        let pid = failure.custodian_pid();
        let original = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        let until = Instant::now() + Duration::from_millis(10);
        let error = failure.retry_cleanup_until(&original, until).unwrap_err();
        assert!(error.contains("frontend cleanup deadline"));
        assert!(
            original.check().is_ok(),
            "caller reserve is the earlier bound"
        );
        assert!(failure.custodian_retained());
        assert_eq!(failure.pending.child.as_ref().unwrap().id(), pid);
        assert!(!failure.cleanup_settled());
        assert!(failure.receipt().is_none());
        assert!(failure.raw_reply().is_empty());
        let mut byte = [0u8; 1];
        assert_eq!(
            peer.read(&mut byte).unwrap(),
            0,
            "owned cancel shuts down frontend writes"
        );
        assert!(failure.pending.cancel_requested);
        drop(failure);
        // The original child is still blocked on its retained input. Frontend
        // Drop must transfer the Child to the passive wait, without killing it.
        let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    information.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            },
            0
        );
        assert_eq!(unsafe { information.assume_init().si_pid() }, 0);
        drop(release);
        passive_reap_observed(pid);
    }
    #[test]
    fn expired_original_requests_cancel_but_does_not_read_or_renew_frontend_cleanup() {
        let (mut failure, mut peer, release) = retained_transport_child();
        let pid = failure.custodian_pid();
        let original = MonotonicDeadline::capture(Duration::from_millis(5)).unwrap();
        while original.check().is_ok() {
            std::thread::sleep(Duration::from_millis(1));
        }
        peer.write_all(b"not a custody receipt\\n").unwrap();
        let error = failure
            .retry_cleanup_until(&original, Instant::now() + Duration::from_secs(1))
            .unwrap_err();
        assert!(error.contains("Original monotonic deadline expired"));
        assert!(failure.custodian_retained());
        assert!(!failure.cleanup_settled());
        assert!(
            failure.raw_reply().is_empty(),
            "no transport read after original expiry"
        );
        assert!(failure.receipt().is_none());
        let mut byte = [0u8; 1];
        assert_eq!(
            peer.read(&mut byte).unwrap(),
            0,
            "cancel remains best effort after expiry"
        );
        drop(failure);
        drop(release);
        passive_reap_observed(pid);
    }

    #[test]
    fn filesystem_identity_json_retains_all_u64_bits_and_rejects_numeric_or_noncanonical_inputs() {
        let value = DirectoryIdentity {
            physical_path: PathBuf::from("/Developer"),
            device: u64::MAX,
            inode: 1_152_921_500_312_571_562,
            mode: 16877,
            modified_seconds: 1,
            modified_nanoseconds: 0,
            changed_seconds: 1,
            changed_nanoseconds: 0,
        };
        let encoded = serde_json::to_value(&value).unwrap();
        assert_eq!(encoded["device"], "18446744073709551615");
        assert_eq!(encoded["inode"], "1152921500312571562");
        assert_eq!(
            serde_json::from_value::<DirectoryIdentity>(encoded.clone()).unwrap(),
            value
        );
        for invalid in [
            serde_json::json!(1152921500312571562u64),
            serde_json::json!("01"),
            serde_json::json!("+1"),
            serde_json::json!("-1"),
            serde_json::json!("18446744073709551616"),
        ] {
            let mut bad = encoded.clone();
            bad["inode"] = invalid;
            assert!(serde_json::from_value::<DirectoryIdentity>(bad).is_err());
        }
    }
    #[test]
    fn cli_trim_matches_js_edges_not_rust_extra_whitespace() {
        assert_eq!(cli_trim("\u{feff} /repo/.git\n"), "/repo/.git");
        assert_eq!(cli_trim("\u{85}/repo/.git\u{85}"), "\u{85}/repo/.git\u{85}");
        assert_eq!(
            output_path(b" /repo/.git\n").unwrap(),
            Path::new("/repo/.git")
        );
        assert!(output_path(b"relative\n").is_err());
        assert!(output_path(b"/repo\0/.git").is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn apple_requirements_authenticate_fixed_resolvers_and_reject_unrelated_signed_tool() {
        signing::authenticate(Path::new("/usr/bin/xcrun"), RESOLVER_REQUIREMENT).unwrap();
        signing::authenticate(Path::new("/usr/bin/xcode-select"), SELECTOR_REQUIREMENT).unwrap();
        signing::authenticate(Path::new("/usr/bin/git"), SHIM_REQUIREMENT).unwrap();
        assert!(signing::authenticate(Path::new("/usr/bin/true"), GIT_REQUIREMENT).is_err());
        assert!(
            signing::authenticate(Path::new("/usr/bin/xcode-select"), RESOLVER_REQUIREMENT)
                .is_err()
        );
    }

    struct HostileTransportPeer {
        root: PathBuf,
        executor: project::SelectedExecutable,
    }
    impl HostileTransportPeer {
        fn new(body: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT_PEER: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "stop-git-hostile-peer-{}-{}-{}",
                std::process::id(),
                monotonic_ns(),
                NEXT_PEER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let path = root.join("peer");
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let executor =
                project::pin_executable(&path, Instant::now() + Duration::from_secs(2), &|| false)
                    .unwrap();
            Self { root, executor }
        }
        fn failure(&self, expires: Instant, cancelled: &dyn Fn() -> bool) -> Failure {
            // Hostile protocol peer only. This fixture is not the actual native
            // inspector and cannot mint a distribution or admission receipt.
            let environment = BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
            inspect(&self.executor, &self.root, &environment, expires, cancelled).unwrap_err()
        }
    }
    impl Drop for HostileTransportPeer {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    fn require_terminal_without_observation(mut failure: Failure) {
        let until = Instant::now() + Duration::from_secs(2);
        while failure.custodian_retained() && Instant::now() < until {
            let _ = failure.retry_cleanup();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            !failure.custodian_retained(),
            "actual hostile peer retained: {failure:?}"
        );
        assert!(
            !failure.cleanup_settled(),
            "terminal peer cannot manufacture fixed-query cleanup evidence"
        );
        assert!(
            failure.receipt().is_none(),
            "malformed/absent reply became observation"
        );
    }
    #[test]
    fn abnormal_custodian_exit_is_terminal_without_observation_or_cleanup_proof() {
        let peer = HostileTransportPeer::new("exit 75");
        // This is a protocol/exit falsifier, not a one-second performance test.
        let failure = peer.failure(Instant::now() + Duration::from_secs(5), &|| false);
        assert!(failure.diagnostic.contains("abnormally"), "{failure:?}");
        require_terminal_without_observation(failure);
    }
    #[test]
    fn malformed_peer_reply_cannot_prevent_observing_actual_child_exit() {
        let peer = HostileTransportPeer::new("printf 'malformed\\n' >&\"$2\"\nexit 0");
        let failure = peer.failure(Instant::now() + Duration::from_secs(5), &|| false);
        assert!(failure.diagnostic.contains("expected value"), "{failure:?}");
        require_terminal_without_observation(failure);
    }
    #[test]
    fn original_deadline_retains_peer_until_control_eof_and_terminal_exit() {
        let peer = HostileTransportPeer::new(
            "IFS= read -r configuration <&\"$2\"\nIFS= read -r cancelled <&\"$2\"\nexit 0",
        );
        let start = Instant::now();
        let failure = peer.failure(start + Duration::from_millis(80), &|| false);
        assert!(failure.diagnostic.contains("deadline"), "{failure:?}");
        assert!(failure.custodian_pid() > 1);
        require_terminal_without_observation(failure);
    }
    #[test]
    fn original_cancellation_retains_peer_until_control_eof_and_terminal_exit() {
        let peer = HostileTransportPeer::new(
            "IFS= read -r configuration <&\"$2\"\nIFS= read -r cancelled <&\"$2\"\nexit 0",
        );
        let start = Instant::now();
        let failure = peer.failure(start + Duration::from_secs(1), &|| {
            Instant::now().duration_since(start) >= Duration::from_millis(80)
        });
        assert!(failure.diagnostic.contains("cancelled"), "{failure:?}");
        assert!(failure.custodian_pid() > 1);
        require_terminal_without_observation(failure);
    }
    #[test]
    fn oversized_reply_stays_bounded_across_cleanup_retries() {
        let script = format!(
            "remaining={}; while [ \"$remaining\" -gt 0 ]; do printf '%8192s' x >&\"$2\"; remaining=$((remaining-1)); done; printf '%2s' xx >&\"$2\"; exit 0",
            MAX_REPLY / 8192
        );
        let peer = HostileTransportPeer::new(&script);
        let mut failure = peer.failure(Instant::now() + Duration::from_secs(3), &|| false);
        assert_eq!(failure.diagnostic, "private Stop reply exceeded bound");
        assert_eq!(failure.raw_reply().len(), MAX_REPLY + 1);
        for _ in 0..4 {
            let _ = failure.retry_cleanup();
            assert_eq!(failure.raw_reply().len(), MAX_REPLY + 1);
            assert_eq!(failure.diagnostic, "private Stop reply exceeded bound");
        }
        require_terminal_without_observation(failure);
    }
    #[test]
    fn developer_and_loader_overrides_are_outside_the_maintained_domain() {
        for key in [
            "DEVELOPER_DIR",
            "TOOLCHAINS",
            "SDKROOT",
            "DYLD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_FUTURE_SELECTOR",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "LD_AUDIT",
            "LD_FUTURE_SELECTOR",
        ] {
            let mut environment = BTreeMap::from([(key.into(), "override".into())]);
            assert!(unsupported_environment(&environment), "{key}");
            environment.insert(key.into(), String::new());
            assert!(!unsupported_environment(&environment), "empty {key}");
        }
        assert!(!unsupported_environment(&BTreeMap::from([(
            "UNRELATED".into(),
            "value".into()
        )])));
    }
}
