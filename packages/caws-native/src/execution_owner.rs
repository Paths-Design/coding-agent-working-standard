//! In-sandbox direct parent for the two observations and the single USER spawn.
//!
//! The caller must authenticate `TrustedInvocation` from the native startup
//! carrier, prove a same-host macOS PID/monotonic domain, and retain custody of
//! this worker if its reply is lost. Fields in a submitted record are not that
//! proof. Node, the entry script, their versioned dependency tree and image
//! directories must be protected against concurrent replacement by untrusted
//! writers. The fence similarly requires cooperating lifecycle writers.
//! This owner runs in a dedicated single-threaded worker. Its caller must
//! exclude signal handlers or other threads that open/close descriptors or reap
//! children. In particular, descriptor setup through spawn requires the
//! quiescent-table contract in execution_fd_transport. A threaded MCP server
//! must use a separate worker rather than call this owner in its own process.
use crate::{
    execution_authorizer_wire::{
        Decision, Fence, FrameDecoder, Phase, ReplyObservation, RequestRecord,
    },
    execution_child::{self, Completed, Failure, TerminationGrace},
    execution_fd_transport::{configure_child_fds, configure_private_child},
    execution_fence::ExecutionFence,
    execution_prepared::{PreparedRecord, ProgramImage},
    monotonic_deadline::{self, EffectCheck, MonotonicDeadline},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read},
    os::{
        fd::AsFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Native authenticated identity, never constructed from a submitted record.
pub(crate) struct TrustedInvocation {
    pub invocation_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub caller_anchor: String,
    pub server_environment_id: String,
    pub project_root: String,
    pub environment_anchor: String,
    /// Explicit startup-carrier proof, not a field parsed from user input.
    pub same_host_macos_verified: bool,
}
/// Pins are supplied by trusted startup configuration, not the record.
pub(crate) struct PinnedAuthorizer {
    pub node: ProgramImage,
    pub entry: ProgramImage,
    pub writer: Option<ProgramImage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    Unsupported,
    Identity,
    InvalidDeadline,
    Cancelled,
    Control,
    Expired,
    Image,
    AuthorizerSpawn,
    AuthorizerIo,
    AuthorizerReply,
    Denied,
    Fence,
    FenceRelease,
    UserSpawnMayHaveOccurred,
    JobIo,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum AuthorizerNonAllowDecision {
    Deny,
    Unresolved,
}
/// Only a fully correlated wire observation can construct this closed detail.
/// Its reason strings already passed the wire whitelist and 32-code bound.
/// No record, revision, authorizer output, or arbitrary error enters this value.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizerRefusalDetail {
    phase: Phase,
    decision: AuthorizerNonAllowDecision,
    reason_codes: Vec<String>,
}
impl AuthorizerRefusalDetail {
    fn from_observation(phase: Phase, observation: &ReplyObservation) -> Option<Self> {
        let decision = match observation.decision() {
            Decision::Allow => return None,
            Decision::Deny => AuthorizerNonAllowDecision::Deny,
            Decision::Unresolved => AuthorizerNonAllowDecision::Unresolved,
        };
        Some(Self {
            phase,
            decision,
            reason_codes: observation.reason_codes().to_vec(),
        })
    }
}
/// When a child remains, the caller MUST retain it and retry settlement. When
/// `fence` remains, settle the authorizer before attempting fence release.
/// Never automatically retry a possible USER spawn. No payload Debug/logging.
pub(crate) struct OwnerFailure {
    pub reason: Refusal,
    pub child: Option<Child>,
    pub fence: Option<ExecutionFence>,
    pub job_failure: Option<Failure>,
    pub authorizer_refusal: Option<AuthorizerRefusalDetail>,
    pub user_spawn_may_have_occurred: bool,
}
pub(crate) enum OwnerOutcome {
    Completed(Completed),
    Failed(OwnerFailure),
}
fn failure(reason: Refusal) -> OwnerFailure {
    OwnerFailure {
        reason,
        child: None,
        fence: None,
        job_failure: None,
        authorizer_refusal: None,
        user_spawn_may_have_occurred: reason == Refusal::UserSpawnMayHaveOccurred,
    }
}
fn association_matches(record: &PreparedRecord, trusted: &TrustedInvocation) -> bool {
    let p = record.value();
    let a = &p.association;
    trusted.same_host_macos_verified
        && cfg!(target_os = "macos")
        && p.invocation_id == trusted.invocation_id
        && a.session_id == trusted.session_id
        && a.thread_id == trusted.thread_id
        && a.call_id == trusted.call_id
        && a.caller_anchor == trusted.caller_anchor
        && a.server_environment_id == trusted.server_environment_id
        && p.project_root == trusted.project_root
        && p.sandbox.environment_anchor == trusted.environment_anchor
}
fn wall_valid(record: &PreparedRecord) -> bool {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .is_some_and(|d| {
            d.as_millis() < u128::from(record.value().limits.preparation_deadline_unix_ms)
        })
}
fn check(
    record: &PreparedRecord,
    trusted: &TrustedInvocation,
    deadline: &MonotonicDeadline,
    cancelled: &AtomicBool,
) -> Result<(), Refusal> {
    if !association_matches(record, trusted) {
        return Err(Refusal::Identity);
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(Refusal::Cancelled);
    }
    if deadline.check().is_err() || !wall_valid(record) {
        return Err(Refusal::Expired);
    }
    Ok(())
}
fn interval_valid(deadline: &MonotonicDeadline) -> bool {
    let e = deadline.envelope();
    e.expires_ns
        .checked_sub(e.started_ns)
        .is_some_and(|n| n > 0 && n <= 30_000_000_000)
}
fn image_valid(
    image: &ProgramImage,
    check_live: &impl Fn() -> Result<(), Refusal>,
) -> Result<(), Refusal> {
    check_live()?;
    let path = Path::new(&image.path);
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
        return Err(Refusal::Image);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| Refusal::Image)?;
    let before = file.metadata().map_err(|_| Refusal::Image)?;
    if !before.is_file() || before.len() > 268_435_456 {
        return Err(Refusal::Image);
    }
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut bytes = [0u8; 65536];
    loop {
        check_live()?;
        let n = file.read(&mut bytes).map_err(|_| Refusal::Image)?;
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or(Refusal::Image)?;
        if total > 268_435_456 {
            return Err(Refusal::Image);
        }
        hash.update(&bytes[..n]);
    }
    let after = file.metadata().map_err(|_| Refusal::Image)?;
    let named = fs::symlink_metadata(path).map_err(|_| Refusal::Image)?;
    if total != before.len()
        || format!("{:x}", hash.finalize()) != image.sha256
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || !named.is_file()
        || named.dev() != before.dev()
        || named.ino() != before.ino()
    {
        return Err(Refusal::Image);
    }
    check_live()
}
fn images(
    record: &PreparedRecord,
    pins: &PinnedAuthorizer,
    live: &impl Fn() -> Result<(), Refusal>,
) -> Result<(), Refusal> {
    if record.value().profile.kind == "caws-evidence-v1" {
        let e = &record.value().execution;
        let writer = Path::new(&pins.entry.path)
            .parent()
            .ok_or(Refusal::Image)?
            .join("writer-main.js");
        let pinned_writer = pins.writer.as_ref().ok_or(Refusal::Image)?;
        if e.executable.path != pins.node.path
            || e.executable.sha256 != pins.node.sha256
            || e.argv.len() < 5
            || e.argv[0] != pins.node.path
            || Path::new(&e.argv[1]) != writer
            || e.argv[2] != "specs"
            || e.argv[3] != "evidence"
            || Path::new(&pinned_writer.path) != writer
            || !record
                .value()
                .profile
                .utilities
                .iter()
                .any(|u| u.path == pinned_writer.path && u.sha256 == pinned_writer.sha256)
        {
            return Err(Refusal::Image);
        }
        image_valid(pinned_writer, live)?;
    }
    image_valid(&pins.node, live)?;
    image_valid(&pins.entry, live)?;
    image_valid(&record.value().execution.executable, live)?;
    image_valid(&record.value().sandbox.launcher, live)?;
    for utility in &record.value().profile.utilities {
        image_valid(utility, live)?;
    }
    Ok(())
}
fn pipe_command(path: &str) -> Command {
    let mut c = Command::new(path);
    c.process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}
fn private_exec_check(command: &mut Command, deadline: &MonotonicDeadline, wall_ms: u64) {
    let envelope = deadline.envelope();
    // SAFETY: this closure performs only async-signal-safe
    // clock calls; it neither allocates nor takes locks in the forked child.
    unsafe {
        command.pre_exec(move || {
            monotonic_deadline::check_before_exec(envelope)
                .map_err(io::Error::from_raw_os_error)?;
            let mut now = std::mem::MaybeUninit::<libc::timespec>::uninit();
            if libc::clock_gettime(libc::CLOCK_REALTIME, now.as_mut_ptr()) != 0 {
                return Err(io::Error::last_os_error());
            }
            let now = now.assume_init();
            if now.tv_sec < 0
                || now.tv_nsec < 0
                || now.tv_nsec >= 1_000_000_000
                || (now.tv_sec as u128) * 1000 + (now.tv_nsec as u128) / 1_000_000
                    >= u128::from(wall_ms)
            {
                return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
            }
            Ok(())
        });
    }
}
fn authorizer(
    record: &PreparedRecord,
    trusted: &TrustedInvocation,
    pins: &PinnedAuthorizer,
    deadline: &MonotonicDeadline,
    cancelled: &Arc<AtomicBool>,
    control: &EffectCheck<'_>,
    grace: TerminationGrace,
    phase: Phase,
    revision: Option<String>,
    fence: Option<&ExecutionFence>,
) -> Result<String, OwnerFailure> {
    let live = || {
        check(record, trusted, deadline, cancelled)?;
        control("execution_preparation").map_err(|_| Refusal::Control)
    };
    live().map_err(failure)?;
    image_valid(&pins.node, &live).map_err(failure)?;
    image_valid(&pins.entry, &live).map_err(failure)?;
    let wire_fence = match fence {
        Some(f) => Some(
            Fence::new(f.dev(), f.ino(), f.nonce().to_owned())
                .map_err(|_| failure(Refusal::Fence))?,
        ),
        None => None,
    };
    let request = RequestRecord::new(
        phase,
        record.value().invocation_id.clone(),
        record.original().to_vec(),
        revision,
        wire_fence,
    )
    .map_err(|_| failure(Refusal::AuthorizerReply))?;
    let input = request
        .encode()
        .map_err(|_| failure(Refusal::AuthorizerReply))?;
    let mut command = pipe_command(&pins.node.path);
    command
        .arg(&pins.entry.path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C");
    configure_private_child(&mut command).map_err(|_| failure(Refusal::AuthorizerSpawn))?;
    if let Some(f) = fence {
        configure_child_fds(&mut command, &[(f.file().as_fd(), 3)])
            .map_err(|_| failure(Refusal::Fence))?;
    }
    private_exec_check(
        &mut command,
        deadline,
        record.value().limits.preparation_deadline_unix_ms,
    );
    live().map_err(failure)?;
    let child = command
        .spawn()
        .map_err(|_| failure(Refusal::AuthorizerSpawn))?;
    drop(command);
    let effect =
        |_: &'static str| live().map_err(|_| "execution deadline or cancellation".to_owned());
    let output = match execution_child::service_child(
        child,
        &input,
        deadline.expires(),
        cancelled,
        65_540,
        65_536,
        131_076,
        grace,
        &effect,
    ) {
        Ok(v) => v,
        Err(e) => {
            return Err(OwnerFailure {
                reason: Refusal::AuthorizerIo,
                child: e.retained_child,
                fence: None,
                job_failure: None,
                authorizer_refusal: None,
                user_spawn_may_have_occurred: false,
            });
        }
    };
    let mut decoder = FrameDecoder::reply();
    decoder
        .push(&output.stdout)
        .map_err(|_| failure(Refusal::AuthorizerReply))?;
    let payload = decoder
        .finish()
        .map_err(|_| failure(Refusal::AuthorizerReply))?;
    let observation = request
        .correlate_reply(&payload)
        .map_err(|_| failure(Refusal::AuthorizerReply))?;
    if observation.decision() != Decision::Allow {
        let mut denied = failure(Refusal::Denied);
        denied.authorizer_refusal = AuthorizerRefusalDetail::from_observation(phase, &observation);
        return Err(denied);
    }
    let revision = observation
        .authority_revision()
        .ok_or_else(|| failure(Refusal::AuthorizerReply))?;
    live().map_err(failure)?;
    Ok(revision.to_owned())
}

/// Consumes the prepared record once; no launch retry is performed here.
/// The caller owns returned process/fence custody and must not drop it silently.
/// `control` polls the already-open private carrier for cancellation or loss.
/// It must be nonblocking and must not change the descriptor table or reap
/// children. It supplies liveness only, never project or launch authority.
pub(crate) fn execute(
    record: PreparedRecord,
    trusted: &TrustedInvocation,
    pins: &PinnedAuthorizer,
    deadline: &MonotonicDeadline,
    cancelled: Arc<AtomicBool>,
    control: &EffectCheck<'_>,
) -> OwnerOutcome {
    if record.value().profile.kind == "npm-test-v1" {
        return OwnerOutcome::Failed(failure(Refusal::Unsupported));
    }
    match execute_inner(record, trusted, pins, deadline, cancelled, control) {
        Ok(v) => OwnerOutcome::Completed(v),
        Err(e) => OwnerOutcome::Failed(e),
    }
}
fn execute_inner(
    record: PreparedRecord,
    trusted: &TrustedInvocation,
    pins: &PinnedAuthorizer,
    deadline: &MonotonicDeadline,
    cancelled: Arc<AtomicBool>,
    control: &EffectCheck<'_>,
) -> Result<Completed, OwnerFailure> {
    if !cfg!(target_os = "macos") || !trusted.same_host_macos_verified {
        return Err(failure(Refusal::Unsupported));
    }
    if !interval_valid(deadline) {
        return Err(failure(Refusal::InvalidDeadline));
    }
    let grace = TerminationGrace::new(Duration::from_millis(
        record.value().limits.termination_grace_ms,
    ))
    .map_err(|_| failure(Refusal::InvalidDeadline))?;
    let writer = record.value().profile.kind == "caws-evidence-v1";
    let live = || {
        check(&record, trusted, deadline, &cancelled)?;
        control("execution_preparation").map_err(|_| Refusal::Control)
    };
    live().map_err(failure)?;
    images(&record, pins, &live).map_err(failure)?;
    let revision = authorizer(
        &record,
        trusted,
        pins,
        deadline,
        &cancelled,
        control,
        grace,
        Phase::Analyze,
        None,
        None,
    )?;
    live().map_err(failure)?;
    let dir = PathBuf::from(&trusted.project_root).join(".caws");
    let mut fence = ExecutionFence::acquire(&dir).map_err(|_| failure(Refusal::Fence))?;
    let under_fence = (|| -> Result<(Child, Instant), OwnerFailure> {
        let _ = authorizer(
            &record,
            trusted,
            pins,
            deadline,
            &cancelled,
            control,
            grace,
            Phase::FinalValidate,
            Some(revision),
            Some(&fence),
        )?;
        fence.validate().map_err(|_| failure(Refusal::Fence))?;
        images(&record, pins, &live).map_err(failure)?;
        fence.validate().map_err(|_| failure(Refusal::Fence))?;
        live().map_err(failure)?;
        let e = &record.value().execution;
        let mut command = pipe_command(&e.executable.path);
        command
            .arg0(&e.argv[0])
            .args(&e.argv[1..])
            .current_dir(&e.cwd)
            .env_clear();
        for entry in &e.environment {
            command.env(&entry.name, &entry.value);
        }
        configure_private_child(&mut command)
            .map_err(|_| failure(Refusal::UserSpawnMayHaveOccurred))?;
        if writer {
            // This dedicated pinned consumer borrows the same fence through
            // completion. Generic USER receives no private descriptors.
            configure_child_fds(&mut command, &[(fence.file().as_fd(), 3)])
                .map_err(|_| failure(Refusal::UserSpawnMayHaveOccurred))?;
        }
        private_exec_check(
            &mut command,
            deadline,
            record.value().limits.preparation_deadline_unix_ms,
        );
        // The fence and transport descriptors are CLOEXEC; no fd 3 is mapped to USER.
        // This parent observation is the cancellation boundary for the launch
        // attempt. Cancellation racing with spawn cannot promise zero effects;
        // every subsequent failure retains possible-spawn disposition. A forked
        // Arc<AtomicBool> would not observe later parent writes (copy-on-write).
        check(&record, trusted, deadline, &cancelled).map_err(failure)?;
        control("execution_user_spawn").map_err(|_| failure(Refusal::Control))?;
        let job_deadline = Instant::now()
            .checked_add(Duration::from_millis(record.value().limits.job_timeout_ms))
            .ok_or_else(|| failure(Refusal::JobIo))?;
        let child = command
            .spawn()
            .map_err(|_| failure(Refusal::UserSpawnMayHaveOccurred))?;
        Ok((child, job_deadline))
    })();
    match under_fence {
        Err(mut problem) => {
            if problem.child.is_some() {
                problem.fence = Some(fence);
                return Err(problem);
            }
            if fence.try_release().is_err() {
                problem.reason = Refusal::FenceRelease;
                problem.authorizer_refusal = None;
                problem.fence = Some(fence);
            }
            Err(problem)
        }
        Ok((child, job_deadline)) => {
            let (child, mut held_fence) = if writer {
                (child, Some(fence))
            } else {
                (release_after_spawn(child, fence, grace)?, None)
            };
            // The preparation deadline does not constrain the job lifetime.
            // Liveness/cancellation of the private carrier still does.
            let job_control = |_: &'static str| {
                control("execution_job").map_err(|_| "execution control unavailable".to_owned())
            };
            let serviced = execution_child::service_child(
                child,
                record.stdin(),
                job_deadline,
                &cancelled,
                record.value().limits.max_output_bytes,
                record.value().limits.max_output_bytes,
                record.value().limits.max_output_bytes,
                grace,
                &job_control,
            );
            let mut serviced = match serviced {
                Ok(done) => Ok(done),
                Err(e) => Err(OwnerFailure {
                    reason: Refusal::JobIo,
                    child: None,
                    fence: None,
                    job_failure: Some(e),
                    authorizer_refusal: None,
                    user_spawn_may_have_occurred: true,
                }),
            };
            if let Some(mut fence) = held_fence.take() {
                let retained = serviced
                    .as_ref()
                    .err()
                    .and_then(|f| f.job_failure.as_ref())
                    .is_some_and(|j| j.retained_child.is_some());
                if retained {
                    serviced.as_mut().err().unwrap().fence = Some(fence);
                } else if fence.try_release().is_err() {
                    let mut problem = serviced
                        .err()
                        .unwrap_or_else(|| failure(Refusal::FenceRelease));
                    problem.reason = Refusal::FenceRelease;
                    problem.authorizer_refusal = None;
                    problem.user_spawn_may_have_occurred = true;
                    problem.fence = Some(fence);
                    return Err(problem);
                }
            }
            serviced
        }
    }
}

fn release_after_spawn(
    child: Child,
    mut fence: ExecutionFence,
    grace: TerminationGrace,
) -> Result<Child, OwnerFailure> {
    if fence.try_release().is_err() {
        // Failure to release authority ends this attempt. Terminate and reap
        // the private group before reporting; retain actual custody if bounded
        // settlement fails, and never unlink a replacement lock.
        let (child, cleanup_detail) = execution_child::stop_child(child, grace);
        return Err(OwnerFailure {
            reason: Refusal::FenceRelease,
            child,
            fence: Some(fence),
            job_failure: cleanup_detail.map(|detail| Failure {
                kind: execution_child::FailureKind::Settlement(detail.clone()),
                stdout: Vec::new(),
                stderr: Vec::new(),
                retained_child: None,
                cleanup_detail: Some(detail),
            }),
            authorizer_refusal: None,
            user_spawn_may_have_occurred: true,
        });
    }
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    #[cfg(target_os = "macos")]
    fn release_failure_stops_user_before_returning_and_preserves_replaced_lock() {
        let dir = std::env::temp_dir().join(format!("caws-release-fault-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let fence = ExecutionFence::acquire(&dir).unwrap();
        let mut command = pipe_command("/bin/sh");
        command.args(["-c", "printf ready; exec /bin/sleep 30"]);
        let mut child = command.spawn().unwrap();
        let pid = child.id() as i32;
        let mut ready = [0; 5];
        child
            .stdout
            .as_mut()
            .unwrap()
            .read_exact(&mut ready)
            .unwrap();
        assert_eq!(&ready, b"ready");
        let lock = dir.join("state.lock");
        fs::remove_file(&lock).unwrap();
        fs::write(&lock, b"foreign replacement").unwrap();
        let grace = TerminationGrace::new(Duration::from_millis(10)).unwrap();
        let mut problem = match release_after_spawn(child, fence, grace) {
            Err(e) => e,
            Ok(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("replacement must fail release");
            }
        };
        let retained_live_child = problem.child.is_some();
        // Cleanup the red control before making assertions.
        if let Some(child) = problem.child.take() {
            let (remaining, detail) = execution_child::stop_child(child, grace);
            assert!(remaining.is_none(), "test cleanup failed: {detail:?}");
        }
        assert_eq!(problem.reason, Refusal::FenceRelease);
        assert!(problem.user_spawn_may_have_occurred);
        assert!(problem.fence.is_some());
        drop(problem);
        assert_eq!(fs::read(&lock).unwrap(), b"foreign replacement");
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        fs::remove_dir_all(dir).unwrap();
        assert!(
            !retained_live_child,
            "settle USER before returning fence-release failure"
        );
    }

    fn prepared() -> PreparedRecord {
        let image = json!({"path":"/bin/bash","sha256":"a".repeat(64)});
        let value = json!({
            "schema":"caws.execution.prepared.v1", "invocationId":"invocation",
            "association":{"kind":"codex-mcp-v1","sessionId":"lineage","threadId":"thread",
                "callId":"call","callerAnchor":"/project","serverEnvironmentId":"host"},
            "projectRoot":"/project",
            "execution":{"executable":image,"argv":["/bin/bash","--noprofile","--norc","-c","true"],
                "cwd":"/project","environment":[],"stdinBase64":""},
            "profile":{"kind":"bash-clean-v1","source":"true","utilities":[]},
            "sandbox":{"stateBase64":"e30=","stateSha256":format!("{:x}",Sha256::digest(b"{}")),
                "launcher":image,"environmentAnchor":"/sandbox"},
            "limits":{"preparationDeadlineUnixMs":9007199254740991u64,"jobTimeoutMs":1000,
                "terminationGraceMs":100,"maxOutputBytes":4096}
        });
        PreparedRecord::decode(serde_json::to_vec(&value).unwrap()).unwrap()
    }
    fn trusted() -> TrustedInvocation {
        TrustedInvocation {
            invocation_id: "invocation".into(),
            session_id: "lineage".into(),
            thread_id: "thread".into(),
            call_id: "call".into(),
            caller_anchor: "/project".into(),
            server_environment_id: "host".into(),
            project_root: "/project".into(),
            environment_anchor: "/sandbox".into(),
            same_host_macos_verified: true,
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn native_identity_each_field_is_binding_and_cancellation_precedes_effect() {
        let record = prepared();
        let mut t = trusted();
        assert!(association_matches(&record, &t));
        t.thread_id.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.call_id.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.session_id.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.invocation_id.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.caller_anchor.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.server_environment_id.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.project_root.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.environment_anchor.push('x');
        assert!(!association_matches(&record, &t));
        t = trusted();
        t.same_host_macos_verified = false;
        assert!(!association_matches(&record, &t));
        let deadline = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        assert_eq!(
            check(&record, &trusted(), &deadline, &AtomicBool::new(true)),
            Err(Refusal::Cancelled)
        );
    }
    #[test]
    fn cap_applies_to_original_interval_and_image_pin_is_enforced() {
        let long = MonotonicDeadline::capture(Duration::from_secs(31)).unwrap();
        let valid = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        assert!(!interval_valid(&long));
        assert!(interval_valid(&valid));
        let image = ProgramImage {
            path: "/dev/null".into(),
            sha256: "0".repeat(64),
        };
        assert_eq!(image_valid(&image, &|| Ok(())), Err(Refusal::Image));
        let image = ProgramImage {
            path: "/no-such-caws-image".into(),
            sha256: "0".repeat(64),
        };
        assert_eq!(image_valid(&image, &|| Ok(())), Err(Refusal::Image));
    }
}
// Explicit opt-in real Source authorizer join. Synthetic fixture identity is
// not host-carrier, sandbox, or native caller-attestation evidence.
#[cfg(all(test, target_os = "macos"))]
mod consumer_tests {
    use super::*;
    use crate::execution_child::{self, FailureKind, TerminationGrace};
    use serde_json::Value;
    use std::{
        cell::{Cell, RefCell},
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        sync::{Arc, atomic::AtomicBool},
        time::Duration,
    };

    const SETUP: &str = r#"
const fixtureModule = require(process.argv[1]);
const which = process.argv[2];
const f = fixtureModule.authorityFixture();
const scripts = {
  positive: 'printf exact > src/result.txt; printf stdout; printf stderr >&2',
  foreign: 'printf forbidden > ../foreign.txt',
  cancel: 'printf forbidden > src/cancel.txt',
  output: 'printf 12345678; printf abcdefgh >&2',
  revoke_before: 'printf once >> src/result.txt',
  revoke_held: 'printf once >> src/result.txt',
};
if (!Object.hasOwn(scripts, which)) throw new Error('unknown test fixture');
if (which.startsWith('revoke_')) {
  const fs = require('node:fs'), path = require('node:path');
  const {spawnSync} = require('node:child_process');
  const yaml = require(require.resolve('js-yaml', {paths:[path.dirname(process.argv[1])]}));
  // The reader fixture uses valid JSON-as-YAML. The real writer deliberately
  // edits YAML source nodes, so construct its native fixture in ordinary YAML.
  fs.writeFileSync(f.specPath, yaml.dump(f.spec));
  const git = (...args) => {
    const r = spawnSync('/usr/bin/git', ['-c','core.hooksPath=/dev/null',
      '-c','commit.gpgsign=false', ...args],
      {cwd:f.root, env:process.env, encoding:'utf8', timeout:5000});
    if (r.status !== 0) throw new Error('controlled fixture Git setup failed: '+r.stderr);
  };
  git('add','--force','--','.caws/specs/EXEC-001.yaml','.caws/worktrees.json','.caws/policy.yaml');
  git('commit','-qm','fixture authority baseline');
  f.record.limits.preparationDeadlineUnixMs = Date.now()+30000;
}
fixtureModule.source(f, scripts[which]);
if (which === 'output') f.record.limits.maxOutputBytes = 12;
process.stdout.write(JSON.stringify({record:f.record, root:f.root, caws:f.caws,
  lane:f.lane, registry:f.registryPath}) + '\n');
// Keep factory's exit cleanup from deleting the repository before the owner
// runs. On successful test, closing stdin lets the factory clean up. On test
// failure Rust sends SIGKILL, retaining the fixture paths printed to stderr.
process.stdin.resume();
"#;

    fn required(name: &str) -> String {
        let value = std::env::var(name)
            .unwrap_or_else(|_| panic!("{name} is required for ignored consumer test"));
        let path = Path::new(&value);
        assert!(path.is_absolute(), "{name} must be absolute");
        assert_eq!(
            fs::canonicalize(path).expect("configured test artifact exists"),
            path,
            "{name} must be physical"
        );
        value
    }
    fn image(path: String) -> ProgramImage {
        ProgramImage {
            sha256: format!(
                "{:x}",
                Sha256::digest(fs::read(&path).expect("read trusted test image"))
            ),
            path,
        }
    }
    struct Fixture {
        child: Child,
        data: Value,
        clean: bool,
        private_home: Option<PathBuf>,
    }
    impl Fixture {
        fn create(case: &str, node: &str, fixture_path: &str) -> Self {
            Self::create_with_environment(case, node, fixture_path, false)
        }
        fn create_with_environment(
            case: &str,
            node: &str,
            fixture_path: &str,
            isolated: bool,
        ) -> Self {
            let mut command = Command::new(node);
            let private_home = isolated.then(|| {
                let home = std::env::temp_dir().join(format!(
                    "caws-ordering-home-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                fs::create_dir(&home).unwrap();
                command
                    .env_clear()
                    .env("HOME", &home)
                    .env("CAWS_HOME", home.join(".caws"))
                    .env(
                        "PATH",
                        format!(
                            "{}:/usr/bin:/bin",
                            Path::new(node).parent().unwrap().display()
                        ),
                    )
                    .env("CODEX_THREAD_ID", "thread-owned")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_CONFIG_SYSTEM", "/dev/null")
                    .env("GIT_AUTHOR_NAME", "Native ordering fixture")
                    .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
                    .env("GIT_COMMITTER_NAME", "Native ordering fixture")
                    .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
                home
            });
            let mut child = command
                .arg("-e")
                .arg(SETUP)
                .arg(fixture_path)
                .arg(case)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("trusted Node fixture setup spawn");
            let mut line = String::new();
            BufReader::new(child.stdout.take().expect("fixture stdout"))
                .read_line(&mut line)
                .expect("fixture JSON read");
            let data: Value = serde_json::from_str(&line).expect("fixture produced JSON");
            eprintln!(
                "consumer fixture root={} caws={} lane={} registry={}",
                data["root"], data["caws"], data["lane"], data["registry"]
            );
            Self {
                child,
                data,
                clean: false,
                private_home,
            }
        }
        fn text(&self, key: &str) -> &str {
            self.data[key].as_str().expect("fixture path")
        }
        fn path(&self, key: &str) -> PathBuf {
            PathBuf::from(self.text(key))
        }
        fn finish(mut self) {
            drop(self.child.stdin.take());
            let status = self.child.wait().expect("fixture cleanup wait");
            assert!(status.success(), "fixture cleanup failed");
            assert!(
                !self.path("root").exists(),
                "fixture cleanup must remove root"
            );
            if let Some(home) = &self.private_home {
                fs::remove_dir_all(home).expect("private machine fixture cleanup");
            }
            self.clean = true;
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if !self.clean {
                eprintln!(
                    "retaining failed consumer fixture root={}",
                    self.data["root"]
                );
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
    fn run(f: &Fixture, node: &str, entry: &str, cancel: bool) -> OwnerOutcome {
        run_with_control(f, node, entry, cancel, &|_| Ok(()))
    }
    fn run_with_control(
        f: &Fixture,
        node: &str,
        entry: &str,
        cancel: bool,
        control: &EffectCheck<'_>,
    ) -> OwnerOutcome {
        let record = PreparedRecord::decode(serde_json::to_vec(&f.data["record"]).unwrap())
            .expect("fixture prepared record");
        let p = record.value();
        let a = &p.association;
        // This is a synthetic test context. It does not assert that a real
        // native carrier authenticated these values or established a sandbox.
        let trusted = TrustedInvocation {
            invocation_id: p.invocation_id.clone(),
            session_id: a.session_id.clone(),
            thread_id: a.thread_id.clone(),
            call_id: a.call_id.clone(),
            caller_anchor: a.caller_anchor.clone(),
            server_environment_id: a.server_environment_id.clone(),
            project_root: p.project_root.clone(),
            environment_anchor: p.sandbox.environment_anchor.clone(),
            same_host_macos_verified: true,
        };
        let pins = PinnedAuthorizer {
            writer: None,
            node: image(node.into()),
            entry: image(entry.into()),
        };
        let deadline = MonotonicDeadline::capture(Duration::from_secs(30)).unwrap();
        execute(
            record,
            &trusted,
            &pins,
            &deadline,
            Arc::new(AtomicBool::new(cancel)),
            control,
        )
    }
    struct FailureSummary {
        reason: Refusal,
        possible: bool,
        child_was_retained: bool,
        fence_was_retained: bool,
        job_child_was_retained: bool,
        job_kind: Option<FailureKind>,
    }
    fn consume_failure(mut f: OwnerFailure) -> FailureSummary {
        let child_was_retained = f.child.is_some();
        let fence_was_retained = f.fence.is_some();
        let job_child_was_retained = f
            .job_failure
            .as_ref()
            .is_some_and(|x| x.retained_child.is_some());
        let mut unsettled = false;
        let grace = TerminationGrace::new(Duration::from_millis(10)).unwrap();
        if let Some(child) = f.child.take() {
            if let (Some(child), _) = execution_child::stop_child(child, grace) {
                unsettled = true;
                std::mem::forget(child);
            }
        }
        if let Some(job) = &mut f.job_failure {
            if let Some(child) = job.retained_child.take() {
                if let (Some(child), _) = execution_child::stop_child(child, grace) {
                    unsettled = true;
                    std::mem::forget(child);
                }
            }
        }
        if let Some(mut fence) = f.fence.take() {
            if unsettled || fence.try_release().is_err() {
                std::mem::forget(fence);
            }
        }
        FailureSummary {
            reason: f.reason,
            possible: f.user_spawn_may_have_occurred,
            child_was_retained,
            fence_was_retained,
            job_child_was_retained,
            job_kind: f.job_failure.map(|x| x.kind),
        }
    }
    fn failed(outcome: OwnerOutcome) -> FailureSummary {
        match outcome {
            OwnerOutcome::Failed(f) => consume_failure(f),
            OwnerOutcome::Completed(_) => panic!("expected refusal or job failure"),
        }
    }
    fn assert_no_custody(s: &FailureSummary) {
        assert!(
            !s.child_was_retained && !s.fence_was_retained && !s.job_child_was_retained,
            "unexpected retained process/fence: {:?}",
            s.reason
        );
    }
    fn config() -> (String, String, String) {
        (
            required("CAWS_TEST_NODE"),
            required("CAWS_TEST_AUTHORIZER_ENTRY"),
            required("CAWS_TEST_AUTHORITY_FIXTURE"),
        )
    }

    // This wrapper runs the actual Source evaluator in its own authorizer
    // process. It observes completed evaluations, never manufactures replies
    // or interposes a second Node parent between Source and the native owner.
    fn ordering_entry(f: &Fixture, entry: &str) -> PathBuf {
        let wrapper = f.path("root").join("ordering-authorizer.cjs");
        let body = format!(
            r#"const fs=require('node:fs'),path=require('node:path');
const entry={entry};
const root={root};
const {{readAuthorizerInput}}=require(entry);
const {{decodeAuthorizerRequest,encodeAuthorizerReply}}=require(path.join(path.dirname(entry),'protocol.js'));
const {{evaluatePreparedExecution}}=require(path.join(path.dirname(entry),'authorizer.js'));
(async()=>{{
  const {{request,record}}=decodeAuthorizerRequest(await readAuthorizerInput(process.stdin));
  if(record.projectRoot!==root) throw new Error('fixture root mismatch');
  const reply=await evaluatePreparedExecution(record,request);
  const marker=path.join(root,request.phase+'.json');
  fs.writeFileSync(marker+'.pending',JSON.stringify(reply));
  fs.renameSync(marker+'.pending',marker);
  process.stdout.write(encodeAuthorizerReply(reply));
}})().catch(()=>{{process.stderr.write('ordering fixture infrastructure failure\n');process.exitCode=2;}});
"#,
            entry = serde_json::to_string(entry).unwrap(),
            root = serde_json::to_string(f.text("root")).unwrap(),
        );
        fs::write(&wrapper, body).unwrap();
        wrapper
    }

    fn ordering_observation(name: &str, value: &Value) {
        eprintln!("ordering observation {name}: {value}");
        if let Ok(dir) = std::env::var("CAWS_TEST_OBSERVATION_DIR") {
            let dir = Path::new(&dir);
            assert!(dir.is_absolute(), "observation directory must be absolute");
            fs::create_dir_all(dir).unwrap();
            fs::write(
                dir.join(format!("{name}.json")),
                serde_json::to_vec_pretty(value).unwrap(),
            )
            .unwrap();
        }
    }

    fn ordering_manifest(
        name: &str,
        f: &Fixture,
        node: &str,
        entry: &str,
        fixture: &str,
        wrapper: &Path,
    ) {
        let identity = |path: &str| {
            let pin = image(path.into());
            serde_json::json!({"path":pin.path,"sha256":pin.sha256})
        };
        ordering_observation(
            name,
            &serde_json::json!({"preparedRecord":f.data["record"],
                "configuredNode":identity(node),"configuredSourceAuthorizer":identity(entry),
                "configuredAuthorityFixture":identity(fixture),
                "wrapper":identity(wrapper.to_str().unwrap()),"wrapperBody":fs::read_to_string(wrapper).unwrap(),
                "nativePreparationBudgetMs":30000,"cliServiceBudgetMs":5000,
                "syntheticTrustedInvocation":true,"realCarrierVerified":false}),
        );
    }

    fn ordering_state(f: &Fixture) -> Value {
        let bytes = fs::read(f.path("caws").join("specs/EXEC-001.yaml")).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        // These controlled fixture paths are plain YAML scalars. Do not treat
        // this small observation reader as a general spec/authority parser.
        let scope: Vec<_> = text
            .lines()
            .skip_while(|line| *line != "  in:")
            .skip(1)
            .take_while(|line| line.starts_with("    - "))
            .map(|line| line.trim_start().strip_prefix("- ").unwrap())
            .collect();
        assert!(!scope.is_empty(), "fixture scope.in must parse");
        let events = fs::read_to_string(f.path("caws").join("events.jsonl")).unwrap_or_default();
        let events: Vec<Value> = events
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        // The fixture has a loose, local main ref. Observe it without an
        // unbounded subprocess inside the owner's cancellation callback.
        let git = f.path("root").join(".git");
        assert_eq!(
            fs::read_to_string(git.join("HEAD")).unwrap(),
            "ref: refs/heads/main\n"
        );
        let head = fs::read_to_string(git.join("refs/heads/main")).unwrap();
        serde_json::json!({"scopeIn":scope,"specSha256":format!("{:x}",Sha256::digest(&bytes)),
            "head":head.trim(),"events":events,
            "fencePresent":f.path("caws").join("state.lock").exists(),
            "userMarker":fs::read_to_string(f.path("lane").join("src/result.txt")).ok()})
    }

    fn revoke_scope(f: &Fixture, node: &str, entry: &str) -> Value {
        let cli = Path::new(entry)
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("index.js");
        assert!(
            cli.is_file(),
            "real CLI entry must be beside execution directory"
        );
        let args = [
            cli.to_str().unwrap(),
            "specs",
            "amend-scope",
            "EXEC-001",
            "--remove",
            "src/",
            "--add",
            "allowed-after-revocation/",
        ];
        let home = f
            .private_home
            .as_ref()
            .expect("ordering fixture private home");
        let mut command = pipe_command(node);
        command
            .args(args)
            .current_dir(f.path("root"))
            .env_clear()
            .env("HOME", home)
            .env("CAWS_HOME", home.join(".caws"))
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin",
                    Path::new(node).parent().unwrap().display()
                ),
            )
            .env("CODEX_THREAD_ID", "thread-owned")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Native ordering fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Native ordering fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
        let child = command.spawn().expect("real CLI scope writer spawn");
        let result = execution_child::service_child(
            child,
            &[],
            Instant::now() + Duration::from_secs(5),
            &Arc::new(AtomicBool::new(false)),
            262144,
            262144,
            524288,
            TerminationGrace::new(Duration::from_millis(100)).unwrap(),
            &|_| Ok(()),
        );
        let argv: Vec<String> = std::iter::once(node.to_owned())
            .chain(args.iter().map(|value| value.to_string()))
            .collect();
        match result {
            Ok(done) => {
                serde_json::json!({"argv":argv,
                "status":done.status.code(),"stdout":String::from_utf8(done.stdout).unwrap(),
                "stderr":String::from_utf8(done.stderr).unwrap()})
            }
            Err(mut problem) => {
                if let FailureKind::Nonzero(status) = &problem.kind {
                    assert!(
                        problem.retained_child.is_none(),
                        "completed CLI must be settled"
                    );
                    return serde_json::json!({"argv":argv,"status":status.code(),
                        "stdout":String::from_utf8(problem.stdout).unwrap(),
                        "stderr":String::from_utf8(problem.stderr).unwrap()});
                }
                if let Some(child) = problem.retained_child.take() {
                    let (retained, _) = execution_child::stop_child(
                        child,
                        TerminationGrace::new(Duration::from_millis(100)).unwrap(),
                    );
                    assert!(retained.is_none(), "CLI fixture child custody must settle");
                }
                panic!(
                    "real CLI writer failed to complete within bounded fixture call: {:?}",
                    problem.kind
                );
            }
        }
    }

    fn phase_observation(f: &Fixture, phase: &str) -> Option<Value> {
        fs::read(f.path("root").join(format!("{phase}.json")))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    fn owner_observation(outcome: &OwnerOutcome) -> Value {
        match outcome {
            OwnerOutcome::Completed(done) => {
                serde_json::json!({"kind":"completed", "exitCode":done.status.code(),
                "stdout":String::from_utf8_lossy(&done.stdout),"stderr":String::from_utf8_lossy(&done.stderr)})
            }
            OwnerOutcome::Failed(problem) => {
                serde_json::json!({"kind":"failed","reason":format!("{:?}",problem.reason),
                "userSpawnMayHaveOccurred":problem.user_spawn_may_have_occurred,
                "childRetained":problem.child.is_some(),"fenceRetained":problem.fence.is_some(),
                "authorizerRefusal":problem.authorizer_refusal})
            }
        }
    }

    fn assert_scope_revocation(before: &Value, after: &Value) {
        assert_eq!(before["scopeIn"], serde_json::json!(["src/"]));
        assert_eq!(
            after["scopeIn"],
            serde_json::json!(["allowed-after-revocation/"])
        );
        assert_ne!(before["specSha256"], after["specSha256"]);
        assert_ne!(before["head"], after["head"]);
        let amendments = |state: &Value| {
            state["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["event"] == "spec_scope_amended")
                .cloned()
                .collect::<Vec<_>>()
        };
        let prior = amendments(before);
        let events = amendments(after);
        assert_eq!(events.len(), prior.len() + 1);
        let event = events.last().unwrap();
        assert_eq!(event["spec_id"], "EXEC-001");
        assert_eq!(event["actor"]["session_id"], "thread-owned");
        assert_eq!(
            event["data"]["added_in"],
            serde_json::json!(["allowed-after-revocation/"])
        );
        assert_eq!(event["data"]["removed_in"], serde_json::json!(["src/"]));
        assert_eq!(event["data"]["resulting_scope_in"], after["scopeIn"]);
    }

    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn real_scope_writer_revokes_after_analyze_before_native_fence() {
        let (node, entry, source) = config();
        let f = Fixture::create_with_environment("revoke_before", &node, &source, true);
        let wrapper = ordering_entry(&f, &entry);
        ordering_manifest(
            "revoke-before-manifest",
            &f,
            &node,
            &entry,
            &source,
            &wrapper,
        );
        let before = ordering_state(&f);
        ordering_observation("revoke-before-initial", &before);
        let attempted = Cell::new(false);
        let writer = RefCell::new(None);
        let ordering = RefCell::new(Vec::<Value>::new());
        let control = |phase: &'static str| {
            if !attempted.get() && phase_observation(&f, "analyze").is_some() {
                attempted.set(true);
                let analyzed = phase_observation(&f, "analyze").unwrap();
                let state = ordering_state(&f);
                ordering.borrow_mut().push(serde_json::json!({"event":"analyze-completed-before-cli","nativeControlPhase":phase,"reply":analyzed,"state":state}));
                let result = revoke_scope(&f, &node, &entry);
                let after = ordering_state(&f);
                ordering.borrow_mut().push(serde_json::json!({"event":"cli-completed-before-fence","nativeControlPhase":phase,"status":result["status"],"state":after}));
                ordering_observation(
                    "revoke-before-writer",
                    &serde_json::json!({"analyze":analyzed,"before":state,"writer":result,"after":after}),
                );
                let valid = analyzed["decision"] == "allow"
                    && state["fencePresent"] == false
                    && state["userMarker"].is_null()
                    && result["status"] == 0;
                *writer.borrow_mut() = Some(result);
                if !valid {
                    return Err("ordering fixture writer prerequisite failed".to_owned());
                }
            }
            Ok(())
        };
        let outcome = run_with_control(&f, &node, wrapper.to_str().unwrap(), false, &control);
        let detail = match &outcome {
            OwnerOutcome::Failed(problem) => {
                serde_json::to_value(&problem.authorizer_refusal).unwrap()
            }
            OwnerOutcome::Completed(_) => Value::Null,
        };
        let final_state = ordering_state(&f);
        ordering.borrow_mut().push(serde_json::json!({"event":"owner-returned","finalValidate":phase_observation(&f,"final_validate"),"owner":owner_observation(&outcome),"state":final_state}));
        ordering_observation(
            "revoke-before-outcome",
            &serde_json::json!({"owner":owner_observation(&outcome),"authorizerRefusal":detail,"state":final_state,"wrapper":image(wrapper.to_str().unwrap().into()).sha256,"callbackOrder":ordering.borrow().clone()}),
        );
        let refused = failed(outcome);
        assert!(attempted.get());
        assert_eq!(writer.borrow().as_ref().unwrap()["status"], 0);
        assert_eq!(refused.reason, Refusal::Denied);
        assert!(!refused.possible);
        assert_no_custody(&refused);
        assert_eq!(detail["phase"], "final_validate");
        assert_eq!(detail["decision"], "unresolved");
        assert_eq!(
            detail["reasonCodes"],
            serde_json::json!(["authority_changed"])
        );
        assert_scope_revocation(&before, &final_state);
        assert!(final_state["userMarker"].is_null());
        assert_eq!(final_state["fencePresent"], false);
        f.finish();
    }

    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn real_scope_writer_refuses_after_final_validate_until_native_fence_release() {
        let (node, entry, source) = config();
        let f = Fixture::create_with_environment("revoke_held", &node, &source, true);
        let wrapper = ordering_entry(&f, &entry);
        ordering_manifest("revoke-held-manifest", &f, &node, &entry, &source, &wrapper);
        let before = ordering_state(&f);
        ordering_observation("revoke-held-initial", &before);
        let attempted = Cell::new(false);
        let writer = RefCell::new(None);
        let ordering = RefCell::new(Vec::<Value>::new());
        let control = |phase: &'static str| {
            if !attempted.get() && phase == "execution_user_spawn" {
                attempted.set(true);
                let validated = phase_observation(&f, "final_validate")
                    .expect("native spawn checkpoint follows consumed final reply");
                let state = ordering_state(&f);
                ordering.borrow_mut().push(serde_json::json!({"event":"native-user-spawn-check-before-cli","nativeControlPhase":phase,"analyze":phase_observation(&f,"analyze"),"reply":validated,"state":state}));
                let result = revoke_scope(&f, &node, &entry);
                let after = ordering_state(&f);
                ordering.borrow_mut().push(serde_json::json!({"event":"cli-refused-under-fence","nativeControlPhase":phase,"status":result["status"],"state":after}));
                ordering_observation(
                    "revoke-held-writer",
                    &serde_json::json!({"analyze":phase_observation(&f,"analyze"),"finalValidate":validated,"before":state,"writer":result,"after":after}),
                );
                let valid = validated["decision"] == "allow"
                    && state["fencePresent"] == true
                    && state["userMarker"].is_null()
                    && result["status"] == 1
                    && result["stderr"]
                        .as_str()
                        .unwrap()
                        .contains("store.lifecycle.lock_contention")
                    && state["specSha256"] == after["specSha256"]
                    && state["events"] == after["events"]
                    && state["head"] == after["head"]
                    && after["fencePresent"] == true
                    && after["userMarker"].is_null();
                *writer.borrow_mut() = Some(result);
                if !valid {
                    return Err("ordering fixture fence prerequisite failed".to_owned());
                }
            }
            Ok(())
        };
        let outcome = run_with_control(&f, &node, wrapper.to_str().unwrap(), false, &control);
        let after_owner = ordering_state(&f);
        ordering.borrow_mut().push(serde_json::json!({"event":"owner-returned","owner":owner_observation(&outcome),"state":after_owner}));
        ordering_observation(
            "revoke-held-owner",
            &serde_json::json!({"owner":owner_observation(&outcome),"state":after_owner,"wrapper":image(wrapper.to_str().unwrap().into()).sha256,"callbackOrder":ordering.borrow().clone()}),
        );
        let done = match outcome {
            OwnerOutcome::Completed(done) => done,
            OwnerOutcome::Failed(problem) => {
                let s = consume_failure(problem);
                panic!(
                    "held-fence owner refused: {:?}, possible={}",
                    s.reason, s.possible
                );
            }
        };
        assert!(attempted.get());
        assert_eq!(writer.borrow().as_ref().unwrap()["status"], 1);
        assert!(done.status.success());
        assert_eq!(after_owner["userMarker"], "once");
        assert_eq!(after_owner["fencePresent"], false);
        assert_eq!(before["scopeIn"], after_owner["scopeIn"]);
        assert_eq!(before["specSha256"], after_owner["specSha256"]);
        assert_eq!(before["events"], after_owner["events"]);
        assert_eq!(before["head"], after_owner["head"]);
        let later = revoke_scope(&f, &node, &entry);
        let after_writer = ordering_state(&f);
        ordering_observation(
            "revoke-held-later-writer",
            &serde_json::json!({"writer":later,"after":after_writer}),
        );
        assert_eq!(later["status"], 0);
        assert_scope_revocation(&before, &after_writer);
        assert_eq!(after_writer["userMarker"], "once");
        f.finish();
    }
    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn actual_authorizer_allows_direct_job_and_releases_fence() {
        let (node, entry, source) = config();
        let f = Fixture::create("positive", &node, &source);
        let result = match run(&f, &node, &entry, false) {
            OwnerOutcome::Completed(c) => c,
            OwnerOutcome::Failed(e) => {
                let s = consume_failure(e);
                panic!(
                    "real authorizer positive failed: {:?}, possible={}",
                    s.reason, s.possible
                );
            }
        };
        assert!(result.status.success());
        assert_eq!(result.stdout, b"stdout");
        assert_eq!(result.stderr, b"stderr");
        assert_eq!(
            fs::read(f.path("lane").join("src/result.txt")).unwrap(),
            b"exact"
        );
        assert!(!f.path("caws").join("state.lock").exists());
        f.finish();
    }
    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn actual_authorizer_denies_foreign_write_without_spawn() {
        let (node, entry, source) = config();
        let f = Fixture::create("foreign", &node, &source);
        let s = failed(run(&f, &node, &entry, false));
        assert_eq!(s.reason, Refusal::Denied);
        assert!(!s.possible);
        assert_no_custody(&s);
        assert!(!f.path("root").join("foreign.txt").exists());
        assert!(!f.path("caws").join("state.lock").exists());
        f.finish();
    }
    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn cancellation_before_execute_has_no_effect() {
        let (node, entry, source) = config();
        let f = Fixture::create("cancel", &node, &source);
        let s = failed(run(&f, &node, &entry, true));
        assert_eq!(s.reason, Refusal::Cancelled);
        assert!(!s.possible);
        assert_no_custody(&s);
        assert!(!f.path("lane").join("src/cancel.txt").exists());
        assert!(!f.path("caws").join("state.lock").exists());
        f.finish();
    }
    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn combined_output_limit_settles_after_possible_spawn() {
        let (node, entry, source) = config();
        let f = Fixture::create("output", &node, &source);
        let s = failed(run(&f, &node, &entry, false));
        assert_eq!(s.reason, Refusal::JobIo);
        assert!(s.possible);
        assert_no_custody(&s);
        assert!(matches!(s.job_kind, Some(FailureKind::TotalOutputLimit)));
        assert!(!f.path("caws").join("state.lock").exists());
        f.finish();
    }
    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn control_refusal_before_preparation_prevents_user_launch() {
        let (node, entry, source) = config();
        let f = Fixture::create("cancel", &node, &source);
        let control = |_: &'static str| Err("injected carrier loss".to_owned());
        let s = failed(run_with_control(&f, &node, &entry, false, &control));
        assert_eq!(s.reason, Refusal::Control);
        assert!(!s.possible);
        assert_no_custody(&s);
        assert!(!f.path("lane").join("src/cancel.txt").exists());
        assert!(!f.path("caws").join("state.lock").exists());
        f.finish();
    }
    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn control_refusal_at_native_user_spawn_prevents_effect_and_releases_fence() {
        let (node, entry, source) = config();
        let f = Fixture::create("cancel", &node, &source);
        let reached = Cell::new(false);
        let control = |phase: &'static str| {
            if phase == "execution_user_spawn" {
                reached.set(true);
                Err("injected carrier loss at native spawn".to_owned())
            } else {
                Ok(())
            }
        };
        let outcome = run_with_control(&f, &node, &entry, false, &control);
        ordering_observation(
            "control-at-user-spawn",
            &serde_json::json!({"checkpoint":"execution_user_spawn","reached":reached.get(),
                "owner":owner_observation(&outcome),
                "userMarkerPresent":f.path("lane").join("src/cancel.txt").exists(),
                "fencePresent":f.path("caws").join("state.lock").exists()}),
        );
        let s = failed(outcome);
        assert!(reached.get());
        assert_eq!(s.reason, Refusal::Control);
        assert!(!s.possible);
        assert_no_custody(&s);
        assert!(!f.path("lane").join("src/cancel.txt").exists());
        assert!(!f.path("caws").join("state.lock").exists());
        f.finish();
    }
    #[test]
    #[ignore = "requires explicit external real Source fixture, Node, and built authorizer entry"]
    fn control_loss_while_servicing_job_stops_and_reports_possible_effects() {
        let (node, entry, source) = config();
        let f = Fixture::create("positive", &node, &source);
        let control = |phase: &'static str| match phase {
            "execution_preparation" | "execution_user_spawn" => Ok(()),
            "execution_job" => Err("injected carrier loss".to_owned()),
            _ => panic!("unexpected control phase"),
        };
        let s = failed(run_with_control(&f, &node, &entry, false, &control));
        assert_eq!(s.reason, Refusal::JobIo);
        assert!(s.possible);
        assert_no_custody(&s);
        assert!(matches!(s.job_kind, Some(FailureKind::EffectCheck(_))));
        assert!(!f.path("caws").join("state.lock").exists());
        // The job may already have written its file before control was polled.
        f.finish();
    }
}
