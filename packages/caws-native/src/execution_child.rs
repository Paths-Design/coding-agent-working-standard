//! Bounded pipe service for a caller-spawned direct child.
//! Caller configures and spawns the private process group and releases its
//! spawn fence before entering this service. No output confers authority.
use crate::{
    monotonic_deadline::EffectCheck,
    owned_group::{self, GroupSettlement},
};
use std::{
    io::{self, Read, Write},
    os::fd::AsRawFd,
    process::{Child, ExitStatus},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// Validated TERM-to-KILL delay from the prepared execution contract.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TerminationGrace(Duration);
impl TerminationGrace {
    pub(crate) fn new(value: Duration) -> io::Result<Self> {
        if value > Duration::from_secs(10) {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "termination grace exceeds 10 seconds",
            ))
        } else {
            Ok(Self(value))
        }
    }
}

#[derive(Debug)]
pub(crate) struct Completed {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: ExitStatus,
}
#[derive(Debug)]
pub(crate) enum FailureKind {
    Cancelled,
    Deadline,
    EffectCheck(String),
    Io(String),
    EarlyStdinClose,
    StdoutLimit,
    StderrLimit,
    TotalOutputLimit,
    Nonzero(ExitStatus),
    Settlement(String),
}
#[derive(Debug)]
pub(crate) struct Failure {
    pub kind: FailureKind,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// If present, retain this unreaped identity and retry group cleanup.
    pub retained_child: Option<Child>,
    pub cleanup_detail: Option<String>,
}
fn nonblocking(fd: i32) -> io::Result<()> {
    let f = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if f < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, f | libc::O_NONBLOCK) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
// WNOWAIT validates the still-owned child without releasing its group identity.
// The caller must exclude concurrent reaping/SIGCHLD handlers.
fn term(child: &Child) -> io::Result<()> {
    let pid = i32::try_from(child.id()).map_err(|_| io::Error::other("invalid pid"))?;
    if pid <= 1 || pid == unsafe { libc::getpid() } || pid == unsafe { libc::getpgrp() } {
        return Err(io::Error::other("invalid private group"));
    }
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    if unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    let seen = unsafe { info.si_pid() };
    if (seen == 0 && info.si_code != 0)
        || (seen != 0
            && (seen != pid
                || !matches!(
                    info.si_code,
                    libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED
                )))
    {
        return Err(io::Error::other("child identity not retained"));
    }
    if unsafe { libc::kill(-pid, libc::SIGTERM) } == 0 {
        return Ok(());
    }
    let e = io::Error::last_os_error();
    if matches!(e.raw_os_error(), Some(libc::ESRCH) | Some(libc::EPERM)) {
        Ok(())
    } else {
        Err(e)
    }
}
pub(crate) fn stop_child(
    mut child: Child,
    grace: TerminationGrace,
) -> (Option<Child>, Option<String>) {
    let mut detail = term(&child).err().map(|e| e.to_string());
    let start = Instant::now();
    let mut killed = false;
    loop {
        if !killed && start.elapsed() >= grace.0 {
            if let Err(e) = owned_group::stop_before_reap(&child) {
                detail = Some(e.to_string());
            }
            killed = true;
        }
        match owned_group::settlement_before_reap(&child) {
            Ok(GroupSettlement::Exited { .. }) => match child.try_wait() {
                Ok(Some(_)) => return (None, detail),
                Ok(None) => {}
                Err(e) => return (Some(child), Some(e.to_string())),
            },
            Ok(_) => {}
            Err(e) => detail = Some(e.to_string()),
        }
        if start.elapsed() >= grace.0 + Duration::from_millis(250) {
            return (
                Some(child),
                Some(detail.unwrap_or_else(|| "cleanup grace expired".into())),
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn fail(
    kind: FailureKind,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    child: Child,
    grace: TerminationGrace,
) -> Failure {
    let (retained_child, cleanup_detail) = stop_child(child, grace);
    Failure {
        kind,
        stdout,
        stderr,
        retained_child,
        cleanup_detail,
    }
}
/// The child MUST be the direct, unreaped child in its private process group,
/// with all three standard streams piped. No concurrent wait/reap is permitted.
/// Success requires full stdin, both EOFs, settled group, and exit zero.
/// The original absolute deadline is never renewed. Cleanup has a separate,
/// configured TERM grace, followed by a fixed 250ms settlement window. It returns
/// unreaped custody if settlement is unknown.
pub(crate) fn service_child(
    mut child: Child,
    input: &[u8],
    deadline: Instant,
    cancelled: &AtomicBool,
    stdout_limit: usize,
    stderr_limit: usize,
    total_output_limit: usize,
    grace: TerminationGrace,
    effect_check: &EffectCheck<'_>,
) -> Result<Completed, Failure> {
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut written = 0;
    if stdin.is_none() || stdout.is_none() || stderr.is_none() {
        return Err(fail(
            FailureKind::Io("missing standard pipe".into()),
            out,
            err,
            child,
            grace,
        ));
    }
    for fd in [
        stdin.as_ref().unwrap().as_raw_fd(),
        stdout.as_ref().unwrap().as_raw_fd(),
        stderr.as_ref().unwrap().as_raw_fd(),
    ] {
        if let Err(e) = nonblocking(fd) {
            return Err(fail(FailureKind::Io(e.to_string()), out, err, child, grace));
        }
    }
    if input.is_empty() {
        stdin.take();
    }
    loop {
        let problem = if cancelled.load(Ordering::Acquire) {
            Some(FailureKind::Cancelled)
        } else if Instant::now() >= deadline {
            Some(FailureKind::Deadline)
        } else {
            effect_check("execution_child_io")
                .err()
                .map(FailureKind::EffectCheck)
        };
        if let Some(kind) = problem {
            return Err(fail(kind, out, err, child, grace));
        }
        if stdin.is_none() && stdout.is_none() && stderr.is_none() {
            match owned_group::settlement_before_reap(&child) {
                Ok(GroupSettlement::Exited { .. }) => match child.try_wait() {
                    Ok(Some(status)) if status.success() => {
                        return Ok(Completed {
                            stdout: out,
                            stderr: err,
                            status,
                        });
                    }
                    Ok(Some(status)) => {
                        return Err(Failure {
                            kind: FailureKind::Nonzero(status),
                            stdout: out,
                            stderr: err,
                            retained_child: None,
                            cleanup_detail: None,
                        });
                    }
                    Ok(None) => {}
                    Err(e) => {
                        return Err(fail(FailureKind::Io(e.to_string()), out, err, child, grace));
                    }
                },
                Ok(_) => {}
                Err(e) => {
                    return Err(fail(
                        FailureKind::Settlement(e.to_string()),
                        out,
                        err,
                        child,
                        grace,
                    ));
                }
            }
        }
        let mut p = [
            libc::pollfd {
                fd: stdin.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: stdout.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: stderr.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(20) as i32;
        if unsafe { libc::poll(p.as_mut_ptr(), p.len() as libc::nfds_t, ms) } < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(fail(FailureKind::Io(e.to_string()), out, err, child, grace));
        }
        if p[0].revents != 0 {
            match stdin.as_mut().unwrap().write(&input[written..]) {
                Ok(0) => return Err(fail(FailureKind::EarlyStdinClose, out, err, child, grace)),
                Ok(n) => {
                    written += n;
                    if written == input.len() {
                        stdin.take();
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => {
                    return Err(fail(FailureKind::EarlyStdinClose, out, err, child, grace));
                }
                Err(e) => return Err(fail(FailureKind::Io(e.to_string()), out, err, child, grace)),
            }
        }
        for i in 1..=2 {
            if p[i].revents == 0 {
                continue;
            }
            let total_left = total_output_limit.saturating_sub(out.len().saturating_add(err.len()));
            let (buffer, limit) = if i == 1 {
                (&mut out, stdout_limit)
            } else {
                (&mut err, stderr_limit)
            };
            let mut bytes = [0u8; 8192];
            let result = if i == 1 {
                stdout.as_mut().unwrap().read(&mut bytes)
            } else {
                stderr.as_mut().unwrap().read(&mut bytes)
            };
            match result {
                Ok(0) => {
                    if i == 1 {
                        stdout.take();
                    } else {
                        stderr.take();
                    }
                }
                Ok(n) => {
                    let stream_left = limit.saturating_sub(buffer.len());
                    let left = stream_left.min(total_left);
                    buffer.extend_from_slice(&bytes[..n.min(left)]);
                    if n > left {
                        let kind = if total_left <= stream_left {
                            FailureKind::TotalOutputLimit
                        } else if i == 1 {
                            FailureKind::StdoutLimit
                        } else {
                            FailureKind::StderrLimit
                        };
                        return Err(fail(kind, out, err, child, grace));
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(fail(FailureKind::Io(e.to_string()), out, err, child, grace)),
            }
        }
    }
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{
        os::unix::process::CommandExt,
        process::{Command, Stdio},
    };
    fn invoke(
        cmd: &mut Command,
        input: &[u8],
        ms: u64,
        limit: usize,
        cancel: &AtomicBool,
    ) -> Result<Completed, Failure> {
        cmd.process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = cmd.spawn().unwrap();
        service_child(
            child,
            input,
            Instant::now() + Duration::from_millis(ms),
            cancel,
            limit,
            limit,
            limit.saturating_mul(2),
            TerminationGrace::new(Duration::from_millis(40)).unwrap(),
            &|_| Ok(()),
        )
    }
    fn sh(script: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(script);
        c
    }
    fn failed(result: Result<Completed, Failure>, predicate: impl FnOnce(&FailureKind) -> bool) {
        let error = result.unwrap_err();
        assert!(predicate(&error.kind), "{error:?}");
        assert!(
            error.retained_child.is_none(),
            "cleanup did not settle: {error:?}"
        );
    }
    #[test]
    fn exact_input_output_and_nonzero() {
        let cancel = AtomicBool::new(false);
        let ok = invoke(&mut Command::new("/bin/cat"), b"abc", 2000, 32, &cancel).unwrap();
        assert_eq!(ok.stdout, b"abc");
        assert!(ok.stderr.is_empty());
        assert!(ok.status.success());
        failed(
            invoke(&mut sh("exit 7"), b"", 2000, 32, &cancel),
            |k| matches!(k, FailureKind::Nonzero(s) if s.code() == Some(7)),
        );
    }
    #[test]
    fn limits_timeout_and_descendant_pipe() {
        let cancel = AtomicBool::new(false);
        failed(
            invoke(&mut sh("printf 123456 >&2"), b"", 2000, 3, &cancel),
            |k| matches!(k, FailureKind::StderrLimit),
        );
        failed(invoke(&mut sh("sleep 5"), b"", 80, 32, &cancel), |k| {
            matches!(k, FailureKind::Deadline)
        });
        failed(
            invoke(&mut sh("sleep 5 & exit 0"), b"", 80, 32, &cancel),
            |k| matches!(k, FailureKind::Deadline),
        );
    }
    #[test]
    fn cancellation_and_early_stdin_close() {
        let cancel = AtomicBool::new(true);
        failed(invoke(&mut sh("sleep 5"), b"", 2000, 32, &cancel), |k| {
            matches!(k, FailureKind::Cancelled)
        });
        cancel.store(false, Ordering::Release);
        failed(
            invoke(
                &mut sh("exec 0<&-; sleep 1"),
                &vec![0; 1000000],
                2000,
                32,
                &cancel,
            ),
            |k| matches!(k, FailureKind::EarlyStdinClose),
        );
    }

    #[test]
    fn ppid_fixture() {
        if let Ok(parent) = std::env::var("CAWS_CHILD_EXPECT_PPID") {
            let expected: i32 = parent.parse().unwrap();
            assert_eq!(unsafe { libc::getppid() }, expected);
            println!("direct-child-ppid-verified");
        }
    }
    #[test]
    fn direct_child_ppid_and_stdout_limit() {
        let cancel = AtomicBool::new(false);
        let mut c = Command::new(std::env::current_exe().unwrap());
        c.arg("--exact")
            .arg("execution_child::tests::ppid_fixture")
            .arg("--nocapture")
            .env(
                "CAWS_CHILD_EXPECT_PPID",
                unsafe { libc::getpid() }.to_string(),
            );
        let ok = invoke(&mut c, b"", 2000, 8192, &cancel).unwrap();
        assert!(String::from_utf8_lossy(&ok.stdout).contains("direct-child-ppid-verified"));
        failed(
            invoke(&mut sh("printf 123456"), b"", 2000, 3, &cancel),
            |k| matches!(k, FailureKind::StdoutLimit),
        );
    }
    #[test]
    fn in_flight_cancellation_and_effect_failure() {
        use std::sync::{Arc, Barrier};
        let cancel = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));
        let c = Arc::clone(&cancel);
        let b = Arc::clone(&barrier);
        let setter = std::thread::spawn(move || {
            b.wait();
            std::thread::sleep(Duration::from_millis(10));
            c.store(true, Ordering::Release);
        });
        let mut cmd = Command::new("/bin/cat");
        cmd.process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = cmd.spawn().unwrap();
        let input = vec![1; 64 * 1024 * 1024];
        barrier.wait();
        let result = service_child(
            child,
            &input,
            Instant::now() + Duration::from_secs(5),
            &cancel,
            input.len(),
            32,
            input.len().saturating_add(32),
            TerminationGrace::new(Duration::from_millis(40)).unwrap(),
            &|_| Ok(()),
        );
        setter.join().unwrap();
        failed(result, |k| matches!(k, FailureKind::Cancelled));
        let mut cmd = sh("sleep 5");
        cmd.process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = cmd.spawn().unwrap();
        let result = service_child(
            child,
            b"",
            Instant::now() + Duration::from_secs(2),
            &AtomicBool::new(false),
            32,
            32,
            64,
            TerminationGrace::new(Duration::from_millis(40)).unwrap(),
            &|_| Err("original deadline rejected".into()),
        );
        failed(
            result,
            |k| matches!(k, FailureKind::EffectCheck(s) if s == "original deadline rejected"),
        );
    }
    #[test]
    fn configured_grace_precedes_kill() {
        let mut command = sh("trap '' TERM; printf ready; while :; do sleep 1; done");
        command
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let mut ready = [0; 5];
        child
            .stdout
            .as_mut()
            .unwrap()
            .read_exact(&mut ready)
            .unwrap();
        assert_eq!(&ready, b"ready");
        let start = Instant::now();
        let (retained, detail) = stop_child(
            child,
            TerminationGrace::new(Duration::from_millis(150)).unwrap(),
        );
        assert!(start.elapsed() >= Duration::from_millis(140));
        assert!(retained.is_none(), "cleanup retained child: {detail:?}");
    }
    #[test]
    fn termination_grace_bounds() {
        assert!(TerminationGrace::new(Duration::from_secs(10)).is_ok());
        assert!(TerminationGrace::new(Duration::from_millis(10001)).is_err());
        assert!(TerminationGrace::new(Duration::ZERO).is_ok());
    }

    #[test]
    fn combined_output_limit_exact_and_plus_one() {
        let cancel = AtomicBool::new(false);
        fn both(script: &str, cancel: &AtomicBool) -> Result<Completed, Failure> {
            let mut cmd = sh(script);
            cmd.process_group(0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let child = cmd.spawn().unwrap();
            service_child(
                child,
                b"",
                Instant::now() + Duration::from_secs(2),
                cancel,
                5,
                5,
                6,
                TerminationGrace::new(Duration::from_millis(40)).unwrap(),
                &|_| Ok(()),
            )
        }
        let exact = both("printf abc; printf def >&2", &cancel).unwrap();
        assert_eq!(exact.stdout, b"abc");
        assert_eq!(exact.stderr, b"def");
        let error = both("printf abc; printf defg >&2", &cancel).unwrap_err();
        assert!(
            matches!(error.kind, FailureKind::TotalOutputLimit),
            "{error:?}"
        );
        assert_eq!(error.stdout.len() + error.stderr.len(), 6);
        assert!(error.retained_child.is_none(), "{error:?}");
    }
}
