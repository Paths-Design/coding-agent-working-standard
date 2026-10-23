//! Binary-private, fixed Render Git profile. The frontend never parents Git.
//! The original executable snapshot is pathname/metadata/hash custody, not a
//! descriptor-bound image or protection against hostile same-UID replacement.
use super::*;
use crate::{invocation_project as project, render_context as context};
use std::collections::BTreeMap;

const CONFIG_SCHEMA: &str = "caws.native.render-git.configuration.v1";
const REPLY_SCHEMA: &str = "caws.native.render-git.reply.v1";
const MAX_REPLY: usize = context::MAX_BYTES;

#[derive(Clone, Serialize, Deserialize)]
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
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderConfiguration {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    cwd: PathBuf,
    git: Pinned,
    executor: Pinned,
    environment: BTreeMap<String, String>,
    expires_ns: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Query {
    Inside,
    Branch,
    Head,
    Status,
}
const QUERIES: [Query; 4] = [Query::Inside, Query::Branch, Query::Head, Query::Status];
impl Query {
    fn label(self) -> &'static str {
        match self {
            Self::Inside => "inside",
            Self::Branch => "branch",
            Self::Head => "head",
            Self::Status => "status",
        }
    }
    fn argv(self) -> &'static [&'static str] {
        match self {
            Self::Inside => &["rev-parse", "--is-inside-work-tree"],
            Self::Branch => &["symbolic-ref", "--quiet", "--short", "HEAD"],
            Self::Head => &["rev-parse", "--short", "HEAD"],
            Self::Status => &["status", "--porcelain"],
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    ordinal: u8,
    operation: Query,
    receipt: QueryReceipt,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    complete: bool,
    rows: Vec<Row>,
}
fn positive_cleanup(row: &QueryReceipt) -> bool {
    let c = &row.cleanup;
    c.group_settled && c.stdout_eof && c.stderr_eof && c.reaped
}
fn verification_status(error: &project::ProjectFailure) -> &'static str {
    match error.first_phase {
        project::ProjectPhase::Cancelled => "cancelled",
        project::ProjectPhase::QueryDeadline => "deadline",
        _ => "identity_changed",
    }
}
fn validate_reply(reply: &Reply, id: &str, digest: &str, token: &str) -> Result<(), String> {
    if reply.schema != REPLY_SCHEMA
        || reply.id != id
        || reply.runtime_digest != digest
        || reply.token != token
        || reply.rows.is_empty()
        || reply.rows.len() > 4
    {
        return Err("private Render reply identity or count mismatch".into());
    }
    for (index, row) in reply.rows.iter().enumerate() {
        let r = &row.receipt;
        if row.ordinal != index as u8 + 1
            || row.operation != QUERIES[index]
            || r.diagnostic.len() > 1024
            || !matches!(
                r.status.as_str(),
                "exited"
                    | "spawn_failed"
                    | "cancelled"
                    | "deadline"
                    | "output_limit"
                    | "cleanup_unsettled"
                    | "identity_changed"
            )
        {
            return Err("private Render query receipt mismatch".into());
        }
        let out = STANDARD
            .decode(&r.stdout)
            .map_err(|_| "private Render stdout encoding")?;
        let err = STANDARD
            .decode(&r.stderr)
            .map_err(|_| "private Render stderr encoding")?;
        if out.len() + err.len() > MAX_OUTPUT
            || STANDARD.encode(&out) != r.stdout
            || STANDARD.encode(&err) != r.stderr
        {
            return Err("private Render output bound or canonical encoding mismatch".into());
        }
        if !positive_cleanup(r)
            || r.pid.is_some_and(|pid| pid <= 1)
            || r.exit_code.is_some() && r.signal.is_some()
            || r.status == "exited"
                && (r.pid.is_none() || r.exit_code.is_none() && r.signal.is_none())
            || index + 1 < reply.rows.len() && r.status != "exited"
        {
            return Err("private Render cleanup or status mismatch".into());
        }
    }
    let last = reply.rows.last().unwrap();
    if reply.complete {
        if last.receipt.status != "exited"
            || !(reply.rows.len() == 4
                || reply.rows.len() == 1 && last.receipt.exit_code != Some(0))
        {
            return Err("private Render incomplete success".into());
        }
    } else if last.receipt.status == "exited" {
        return Err("private Render failure lacks failed query".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{cell::Cell, os::unix::fs::PermissionsExt};

    #[test]
    fn verification_classification_preserves_typed_deadline_and_cancellation_during_hash() {
        let root = std::env::temp_dir().join(format!(
            "render-verification-{}-{}",
            std::process::id(),
            monotonic_ns()
        ));
        fs::create_dir(&root).unwrap();
        let image = root.join("image");
        fs::write(&image, vec![b'x'; 65536]).unwrap();
        fs::set_permissions(&image, fs::Permissions::from_mode(0o700)).unwrap();
        let selected =
            project::pin_executable(&image, Instant::now() + Duration::from_secs(5), &|| false)
                .unwrap();
        let calls = Cell::new(0);
        let cancelled = project::verify_executable(
            &selected,
            project::ProjectPhase::BeforeLaunch,
            Instant::now() + Duration::from_secs(5),
            &|| {
                calls.set(calls.get() + 1);
                calls.get() == 3
            },
        )
        .unwrap_err();
        assert_eq!(calls.get(), 3);
        assert_eq!(cancelled.first_phase, project::ProjectPhase::Cancelled);
        assert_eq!(verification_status(&cancelled), "cancelled");
        let calls = Cell::new(0);
        let expires = Instant::now() + Duration::from_secs(1);
        let deadline = project::verify_executable(
            &selected,
            project::ProjectPhase::BeforeLaunch,
            expires,
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 3 {
                    std::thread::sleep(
                        expires.saturating_duration_since(Instant::now())
                            + Duration::from_millis(1),
                    );
                }
                false
            },
        )
        .unwrap_err();
        assert_eq!(calls.get(), 3);
        assert_eq!(deadline.first_phase, project::ProjectPhase::QueryDeadline);
        assert_eq!(verification_status(&deadline), "deadline");
        fs::write(&image, b"changed").unwrap();
        let replaced = project::verify_executable(
            &selected,
            project::ProjectPhase::AfterLaunch,
            Instant::now() + Duration::from_secs(5),
            &|| false,
        )
        .unwrap_err();
        assert_eq!(replaced.first_phase, project::ProjectPhase::AfterLaunch);
        assert_eq!(verification_status(&replaced), "identity_changed");
        fs::remove_dir_all(root).unwrap();
    }

    fn receipt(status: &str) -> QueryReceipt {
        QueryReceipt {
            status: status.into(),
            pid: Some(99),
            exit_code: Some(0),
            signal: None,
            stdout: STANDARD.encode(b"true\n"),
            stderr: String::new(),
            cleanup: Cleanup {
                group_settled: true,
                stdout_eof: true,
                stderr_eof: true,
                reaped: true,
            },
            diagnostic: String::new(),
        }
    }
    fn reply() -> Reply {
        Reply {
            schema: REPLY_SCHEMA.into(),
            id: "original".into(),
            runtime_digest: "a".repeat(64),
            token: "original-uuid-token".into(),
            complete: true,
            rows: QUERIES
                .into_iter()
                .enumerate()
                .map(|(index, operation)| Row {
                    ordinal: index as u8 + 1,
                    operation,
                    receipt: receipt("exited"),
                })
                .collect(),
        }
    }
    fn valid(value: &Reply) -> Result<(), String> {
        validate_reply(value, "original", &"a".repeat(64), "original-uuid-token")
    }

    #[test]
    fn remote_receipt_requires_exact_binding_order_terminal_and_all_cleanup() {
        let good = reply();
        assert!(valid(&good).is_ok());
        for key in ["schema", "id", "runtimeDigest", "token"] {
            let mut value = serde_json::to_value(&good).unwrap();
            value[key] = json!("foreign");
            assert!(
                valid(&serde_json::from_value(value).unwrap()).is_err(),
                "accepted {key}"
            );
        }
        for key in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
            let mut value = serde_json::to_value(&good).unwrap();
            value["rows"][0]["receipt"]["cleanup"][key] = json!(false);
            assert!(
                valid(&serde_json::from_value(value).unwrap()).is_err(),
                "accepted missing {key}"
            );
        }
        let mut value = good.clone();
        value.rows[1].ordinal = 1;
        assert!(valid(&value).is_err());
        let mut value = good.clone();
        value.rows.swap(1, 2);
        assert!(valid(&value).is_err());
        let mut value = good.clone();
        value.rows.truncate(2);
        assert!(valid(&value).is_err());
        let mut value = good.clone();
        value.complete = false;
        assert!(valid(&value).is_err());
        let mut value = good.clone();
        value.rows[0].receipt.signal = Some(15);
        assert!(valid(&value).is_err());
        let mut value = good.clone();
        value.rows[0].receipt.pid = None;
        assert!(valid(&value).is_err());
        let mut value = good.clone();
        value.rows[0].receipt.stdout = "dHJ1ZQo=\n".into();
        assert!(valid(&value).is_err());
        let mut value = good;
        value.rows[0].receipt.stdout = STANDARD.encode(vec![b'x'; MAX_OUTPUT + 1]);
        assert!(valid(&value).is_err());
    }

    #[test]
    fn outside_and_failed_query_receipts_keep_actual_exit_separate_from_cleanup() {
        let mut value = reply();
        value.rows.truncate(1);
        value.rows[0].receipt.exit_code = Some(128);
        assert!(valid(&value).is_ok());
        assert_eq!(queries(&value)[0].exit_code, Some(128));
        value.complete = false;
        value.rows[0].receipt.status = "deadline".into();
        value.rows[0].receipt.signal = Some(15);
        value.rows[0].receipt.exit_code = None;
        assert!(valid(&value).is_ok());
        assert!(queries(&value).is_empty());
        value.complete = true;
        assert!(valid(&value).is_err());
    }

    #[test]
    fn private_configuration_rejects_argv_environment_selection_and_unknown_profiles_before_spawn()
    {
        let pinned = Pinned {
            path: "/missing/git".into(),
            physical_path: "/missing/git".into(),
            sha256: "b".repeat(64),
            device: 1,
            inode: 2,
            bytes: 3,
            mode: 0o100700,
            modified_seconds: 1,
            modified_nanoseconds: 0,
            changed_seconds: 1,
            changed_nanoseconds: 0,
        };
        let base = serde_json::to_value(RenderConfiguration {
            schema: CONFIG_SCHEMA.into(),
            id: "original".into(),
            runtime_digest: "a".repeat(64),
            token: "original-uuid-token".into(),
            cwd: "/tmp".into(),
            git: pinned.clone(),
            executor: pinned,
            environment: BTreeMap::new(),
            expires_ns: 0,
        })
        .unwrap();
        let (mut stream, _peer) = UnixStream::pair().unwrap();
        for (key, value) in [
            ("args", json!(["-c", "arbitrary"])),
            ("operation", json!("exec")),
            ("schema", json!("foreign")),
            ("token", json!("bad/token")),
            ("cwd", json!("relative")),
        ] {
            let mut malformed = base.clone();
            malformed[key] = value;
            let error =
                run_configuration(&mut stream, &serde_json::to_vec(&malformed).unwrap(), false)
                    .unwrap_err();
            assert!(
                error.contains("unknown field") || error == "invalid private Render configuration",
                "{key}: {error}"
            );
        }
        assert_eq!(Query::Inside.argv(), ["rev-parse", "--is-inside-work-tree"]);
        assert_eq!(
            Query::Branch.argv(),
            ["symbolic-ref", "--quiet", "--short", "HEAD"]
        );
        assert_eq!(Query::Head.argv(), ["rev-parse", "--short", "HEAD"]);
        assert_eq!(Query::Status.argv(), ["status", "--porcelain"]);
    }
}
fn queries(reply: &Reply) -> Vec<context::Query> {
    reply
        .rows
        .iter()
        .filter(|r| r.receipt.status == "exited")
        .map(|row| {
            let r = &row.receipt;
            context::Query {
                ordinal: row.ordinal,
                operation: row.operation.label(),
                exit_code: r.exit_code,
                signal: r.signal,
                stdout: r.stdout.clone(),
                stderr: r.stderr.clone(),
                cleanup: context::Cleanup {
                    exit_observed: r.exit_code.is_some() || r.signal.is_some(),
                    group_settled: r.cleanup.group_settled,
                    stdout_eof: r.cleanup.stdout_eof,
                    stderr_eof: r.cleanup.stderr_eof,
                    reaped: r.cleanup.reaped,
                    ownership_retained: false,
                },
            }
        })
        .collect()
}

/// Exact remote ownership, not a reconstructed frontend ProjectFailure. Drop
/// closes sole liveness; the separate native process still owns the actual Git
/// Child. Explicit retry can observe settlement, but never authorizes replay.
#[must_use = "retain remote Render custody or explicitly transfer this value"]
pub struct Failure {
    pub diagnostic: String,
    pending: Pending,
}
impl std::fmt::Debug for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteRenderFailure")
            .field("diagnostic", &self.diagnostic)
            .field("custodianPid", &self.pending.pid)
            .field("reply", &self.pending.reply)
            .field("receivedBytes", &self.pending.output.len())
            .field("controlEof", &self.pending.eof)
            .field(
                "custodianExitedSuccessfully",
                &self.pending.exited_successfully,
            )
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
                    .is_some_and(|r| r.rows.iter().all(|r| positive_cleanup(&r.receipt))))
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
                        Err("remote Render cleanup lacks a complete receipt".into())
                    };
                }
                Ok(false) => (),
                Err(error) => return Err(error),
            }
            if Instant::now() >= until {
                return Err("remote Render custodian retains unsettled Git custody".into());
            }
            self.pending.tick();
        }
    }
    pub fn custodian_pid(&self) -> u32 {
        self.pending.pid
    }
    pub fn receipt(&self) -> Option<serde_json::Value> {
        self.pending
            .reply
            .as_ref()
            .and_then(|r| serde_json::to_value(r).ok())
    }
    pub(crate) fn completed(&self) -> Vec<context::Query> {
        self.pending.reply.as_ref().map_or_else(Vec::new, queries)
    }
    pub(crate) fn partial(&self) -> (Vec<u8>, Vec<u8>) {
        self.pending
            .reply
            .as_ref()
            .filter(|r| !r.complete)
            .and_then(|r| r.rows.last())
            .map_or_else(
                || (Vec::new(), Vec::new()),
                |r| {
                    (
                        STANDARD.decode(&r.receipt.stdout).unwrap_or_default(),
                        STANDARD.decode(&r.receipt.stderr).unwrap_or_default(),
                    )
                },
            )
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
}
impl Pending {
    fn cancel(&mut self) {
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
        let control = self
            .control
            .as_mut()
            .ok_or("remote Render control unavailable")?;
        while self.written < self.input.len() {
            match control.write(&self.input[self.written..]) {
                Ok(0) => return Err("remote Render configuration write closed".into()),
                Ok(n) => self.written += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        if !self.eof {
            loop {
                let mut bytes = [0u8; 8192];
                match control.read(&mut bytes) {
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
                            return Err("private Render reply exceeded bound".into());
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        if let Some(end) = self.frame_end {
            if end + 1 != self.output.len() {
                return Err("trailing private Render reply bytes".into());
            }
            if self.reply.is_none() {
                let reply: Reply =
                    serde_json::from_slice(&self.output[..end]).map_err(|e| e.to_string())?;
                validate_reply(&reply, &self.id, &self.digest, &self.token)?;
                self.reply = Some(reply);
            }
        }
        if self.eof {
            let Some(child) = self.child.as_mut() else {
                return Ok(true);
            };
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                self.child = None;
                self.exited_successfully = status.success();
                if !status.success() {
                    return Err(format!("Render custodian exited abnormally: {status}"));
                }
                if self.reply.is_none() && !self.aborted_configuration {
                    return Err("Render custodian closed without a complete receipt".into());
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
                .name("caws-render-git-reap".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}
pub(crate) struct Input<'a> {
    pub invocation: &'a context::OriginalInvocation,
    pub git: &'a project::SelectedExecutable,
    pub executor: &'a project::SelectedExecutable,
    pub token: &'a str,
    pub expires: Instant,
}
pub(crate) fn observe(
    input: Input<'_>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<context::Query>, Failure> {
    let start = (|| -> Result<Pending, String> {
        project::verify_executable(
            input.executor,
            project::ProjectPhase::BeforeLaunch,
            input.expires,
            cancelled,
        )
        .map_err(|e| e.to_string())?;
        let configuration = RenderConfiguration {
            schema: CONFIG_SCHEMA.into(),
            id: input.invocation.id.clone(),
            runtime_digest: input.invocation.runtime_digest.clone(),
            token: input.token.into(),
            cwd: input.invocation.cwd.clone().into(),
            git: Pinned::capture(input.git),
            executor: Pinned::capture(input.executor),
            environment: input.invocation.environment.clone(),
            expires_ns: monotonic_ns().saturating_add(
                input
                    .expires
                    .saturating_duration_since(Instant::now())
                    .as_nanos()
                    .min(u128::from(u64::MAX)) as u64,
            ),
        };
        let mut bytes = serde_json::to_vec(&configuration).map_err(|e| e.to_string())?;
        if bytes.len() >= MAX_CONFIGURATION {
            return Err("private Render configuration exceeds original environment bound".into());
        }
        bytes.push(b'\n');
        let (control, remote) = UnixStream::pair().map_err(|e| e.to_string())?;
        control.set_nonblocking(true).map_err(|e| e.to_string())?;
        let fd = unsafe { libc::fcntl(remote.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        if fd < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let remote = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut command = Command::new(&input.executor.path);
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
        Ok(Pending {
            child: Some(child),
            pid,
            control: Some(control),
            input: bytes,
            written: 0,
            output: Vec::new(),
            frame_end: None,
            reply: None,
            eof: false,
            exited_successfully: false,
            id: configuration.id,
            digest: configuration.runtime_digest,
            token: configuration.token,
            aborted_configuration: false,
        })
    })();
    // No Git can exist before successful custodian spawn. Keep a typed empty
    // handle for pre-spawn failures; it never fabricates a Git exit receipt.
    let mut pending = match start {
        Ok(p) => p,
        Err(diagnostic) => {
            return Err(Failure {
                diagnostic,
                pending: Pending {
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
                    id: input.invocation.id.clone(),
                    digest: input.invocation.runtime_digest.clone(),
                    token: input.token.into(),
                    aborted_configuration: false,
                },
            });
        }
    };
    loop {
        if cancelled() || Instant::now() >= input.expires {
            pending.cancel();
            return Err(Failure {
                diagnostic: if cancelled() {
                    "original Render cancelled"
                } else {
                    "original Render deadline"
                }
                .into(),
                pending,
            });
        }
        match pending.advance() {
            Ok(true) => {
                if let Err(error) = project::verify_executable(
                    input.executor,
                    project::ProjectPhase::AfterLaunch,
                    input.expires,
                    cancelled,
                ) {
                    return Err(Failure {
                        diagnostic: error.to_string(),
                        pending,
                    });
                }
                let reply = pending.reply.as_ref().expect("validated complete receipt");
                if reply.complete {
                    return Ok(queries(reply));
                }
                return Err(Failure {
                    diagnostic: reply
                        .rows
                        .last()
                        .map_or("private Render failed", |r| r.receipt.status.as_str())
                        .into(),
                    pending,
                });
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

pub(super) fn run_configuration(
    stream: &mut UnixStream,
    bytes: &[u8],
    cancelled: bool,
) -> Result<(), String> {
    let config: RenderConfiguration = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
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
        || !config.git.valid()
        || !config.executor.valid()
        || config
            .environment
            .iter()
            .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
    {
        return Err("invalid private Render configuration".into());
    }
    let git = config.git.selected();
    let executor = config.executor.selected();
    let actual = std::env::current_exe().map_err(|e| e.to_string())?;
    if fs::canonicalize(actual).map_err(|e| e.to_string())? != executor.physical_path {
        return Err("private Render native image path changed".into());
    }
    let environment: Vec<_> = config
        .environment
        .iter()
        .map(|(k, v)| (k.as_bytes().to_vec(), v.as_bytes().to_vec()))
        .collect();
    let mut reply = Reply {
        schema: REPLY_SCHEMA.into(),
        id: config.id,
        runtime_digest: config.runtime_digest,
        token: config.token,
        complete: false,
        rows: Vec::new(),
    };
    for (index, operation) in QUERIES.into_iter().enumerate() {
        let remaining = config.expires_ns.saturating_sub(monotonic_ns());
        let expires = Instant::now() + Duration::from_nanos(remaining);
        let checked = (if index == 0 {
            project::verify_executable(
                &executor,
                project::ProjectPhase::BeforeLaunch,
                expires,
                &|| cancelled,
            )
        } else {
            Ok(())
        })
        .and_then(|()| {
            project::verify_executable(&git, project::ProjectPhase::BeforeLaunch, expires, &|| {
                cancelled
            })
        });
        let receipt = match checked {
            Err(error) => {
                let mut r = QueryReceipt::new(verification_status(&error), &error.to_string());
                r.cleanup = Cleanup {
                    group_settled: true,
                    stdout_eof: true,
                    stderr_eof: true,
                    reaped: true,
                };
                r
            }
            Ok(()) => {
                let until = config
                    .expires_ns
                    .saturating_sub(CLEANUP.as_nanos() as u64)
                    .min(monotonic_ns().saturating_add(Duration::from_secs(5).as_nanos() as u64));
                // The shared loop retains Git even after its cleanup allowance.
                // This profile sends only the final truthful receipt; a frontend
                // deadline returns a remote handle while the loop keeps custody.
                let mut r = run_owned_query(
                    stream,
                    QuerySpec {
                        executable: &git.path,
                        cwd: &config.cwd,
                        environment: &environment,
                        argv: operation.argv(),
                        expires_ns: until,
                    },
                    cancelled,
                    |_, _| true,
                );
                if r.status == "exited"
                    && let Err(error) = project::verify_executable(
                        &git,
                        project::ProjectPhase::AfterLaunch,
                        expires,
                        &|| false,
                    )
                {
                    r.status = verification_status(&error).into();
                    r.diagnostic = QueryReceipt::new("", &error.to_string()).diagnostic;
                }
                r
            }
        };
        let failed = receipt.status != "exited";
        let outside = operation == Query::Inside && receipt.exit_code != Some(0);
        reply.rows.push(Row {
            ordinal: index as u8 + 1,
            operation,
            receipt,
        });
        if failed {
            break;
        }
        if outside || index == 3 {
            reply.complete = true;
            break;
        }
    }
    let mut encoded = serde_json::to_vec(&reply).map_err(|e| e.to_string())?;
    if encoded.len() >= MAX_REPLY {
        return Err("private Render result exceeds bound".into());
    }
    encoded.push(b'\n');
    let until = Instant::now() + CLEANUP;
    let mut sent = 0;
    while sent < encoded.len() && Instant::now() < until {
        match stream.write(&encoded[sent..]) {
            Ok(0) => break,
            Ok(n) => sent += n,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                tick(&mut [libc::pollfd {
                    fd: stream.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                }])
            }
            Err(_) => break,
        }
    }
    Ok(())
}
