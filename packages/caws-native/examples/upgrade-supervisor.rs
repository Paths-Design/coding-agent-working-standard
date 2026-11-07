//! Qualification-only command custody. This is not a runtime hook transport.
//! The foreground may return an unsettled receipt; the private custodian keeps
//! the actual Child and continues settlement. No PID recovered from a report
//! is ever used as signal authority. Darwin proves only the original group.
use base64::{Engine, engine::general_purpose::STANDARD};
use caws_native::owned_group::{self, GroupSettlement, GroupStop};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::OpenOptionsExt,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};

const MAX_REQUEST: u64 = 2 * 1024 * 1024;
const MAX_BUFFER: usize = 16 * 1024 * 1024;
const GRACE_NS: u64 = 2_000_000_000;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    input: String,
    timeout_ms: u64,
    max_buffer: usize,
    artifact_directory: PathBuf,
}

fn now() -> io::Result<u64> {
    let mut value = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: clock_gettime writes this timespec on success.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, value.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let value = unsafe { value.assume_init() };
    u64::try_from(value.tv_sec)
        .ok()
        .and_then(|s| s.checked_mul(1_000_000_000))
        .and_then(|s| {
            u64::try_from(value.tv_nsec)
                .ok()
                .and_then(|n| s.checked_add(n))
        })
        .ok_or_else(|| io::Error::other("invalid monotonic clock"))
}

fn expired(expires: u64) -> bool {
    now().map_or(true, |value| value >= expires)
}

fn private_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

fn write_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let temporary = path.with_extension("pending");
    let mut file = private_file(&temporary)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)
}

fn publish_outcome(root: &Path, outcome: &impl Serialize) -> io::Result<()> {
    write_json(&root.join("outcome.json"), outcome)?;
    // Only this custodian owns the pipe's writer. Target stdout/stderr replace
    // these descriptors at exec; a target-written artifact is never a grant.
    let mut pipe = io::stdout().lock();
    serde_json::to_writer(&mut pipe, outcome)?;
    pipe.write_all(b"\n")?;
    pipe.flush()
}

fn reset_child_policy() -> io::Result<()> {
    // This standalone executable has no threads or competing child waiters.
    // Explicitly remove inherited SIG_IGN / SA_NOCLDWAIT before any spawn.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = libc::SIG_DFL;
    if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0
        || unsafe { libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn read_request(mut reader: impl Read) -> io::Result<Request> {
    let mut raw = Vec::new();
    reader
        .by_ref()
        .take(MAX_REQUEST + 1)
        .read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_REQUEST {
        return Err(io::Error::other("qualification request exceeds bound"));
    }
    let request: Request = serde_json::from_slice(&raw)?;
    if request.command.is_empty()
        || request.command.contains('\0')
        || request.args.len() > 4096
        || request.args.iter().any(|s| s.contains('\0'))
        || !request.cwd.is_absolute()
        || !request.artifact_directory.is_absolute()
        || request.timeout_ms == 0
        || request.timeout_ms > 300_000
        || request.max_buffer == 0
        || request.max_buffer > MAX_BUFFER
    {
        return Err(io::Error::other("invalid qualification request"));
    }
    Ok(request)
}

fn frontend() -> io::Result<()> {
    let started = now()?;
    eprintln!(
        "{}",
        serde_json::json!({"event": "qualification_frontend_started", "startedNs": started.to_string()})
    );
    reset_child_policy()?;
    let request = read_request(io::stdin().lock())?;
    let expires = started
        .checked_add(request.timeout_ms * 1_000_000)
        .ok_or_else(|| io::Error::other("deadline overflow"))?;
    let root = &request.artifact_directory;
    if fs::canonicalize(root)? != *root
        || !fs::metadata(root)?.is_dir()
        || fs::read_dir(root)?.next().is_some()
    {
        return Err(io::Error::other(
            "physical private artifact directory required",
        ));
    }
    let request_path = root.join("request.json");
    write_json(&request_path, &request)?;
    let stderr = private_file(&root.join("custodian.stderr"))?;
    if expired(expires) {
        println!(
            "{}",
            serde_json::json!({"complete": false, "root": root,
            "reason": "original deadline expired before custodian spawn", "custodianPid": null})
        );
        return Ok(());
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--custodian",
            request_path
                .to_str()
                .ok_or_else(|| io::Error::other("UTF-8 path required"))?,
        ])
        .arg(started.to_string())
        .arg(expires.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .process_group(0);
    // SAFETY: the executable is single-threaded and this closure only checks
    // the retained deadline before exec; it never creates a replacement clock.
    unsafe {
        command.pre_exec(move || {
            if expired(expires) {
                Err(io::Error::from_raw_os_error(libc::ETIMEDOUT))
            } else {
                Ok(())
            }
        });
    }
    let mut custodian = command.spawn()?;
    let mut control = custodian.stdout.take().expect("piped custodian control");
    nonblocking(control.as_raw_fd())?;
    let mut frame = Vec::new();
    let foreground_end = expires.saturating_add(GRACE_NS);
    loop {
        let mut buffer = [0u8; 8192];
        let eof = match control.read(&mut buffer) {
            Ok(0) => true,
            Ok(count) => {
                frame.extend_from_slice(&buffer[..count]);
                if frame.len() > 65536 {
                    return Err(io::Error::other("custodian frame exceeds bound"));
                }
                false
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                false
            }
            Err(error) => return Err(error),
        };
        if eof && !frame.is_empty() {
            let outcome: serde_json::Value = serde_json::from_slice(&frame)?;
            // No group signal is ever sent to the custodian. Reap only if it has
            // exited; after foreground return the custodian retains target custody.
            let _ = custodian.try_wait();
            println!(
                "{}",
                serde_json::json!({"complete": true, "root": root,
                "custodianPid": custodian.id(), "outcome": outcome})
            );
            return Ok(());
        }
        if expired(foreground_end) || eof {
            println!(
                "{}",
                serde_json::json!({"complete": false, "root": root,
                "custodianPid": custodian.id(), "reason": "custodian settlement or report unproven"})
            );
            return Ok(());
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn nonblocking(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn leader_exited(child: &Child) -> io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    if unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    if unsafe { info.si_pid() } == 0 && info.si_code == 0 {
        return Ok(false);
    }
    if unsafe { info.si_pid() } == child.id() as i32
        && matches!(
            info.si_code,
            libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED
        )
    {
        return Ok(true);
    }
    Err(io::Error::other("unexpected child ownership observation"))
}

struct Output {
    pipe: Option<Box<dyn Read>>,
    file: File,
    captured: usize,
    observed: u64,
    eof: bool,
}
impl Output {
    fn drain(&mut self, limit: usize) -> io::Result<bool> {
        let Some(pipe) = self.pipe.as_mut() else {
            return Ok(false);
        };
        let mut buffer = [0u8; 8192];
        // Bound every pass so flooding cannot starve the original deadline.
        for _ in 0..8 {
            match pipe.read(&mut buffer) {
                Ok(0) => {
                    self.eof = true;
                    self.pipe = None;
                    break;
                }
                Ok(count) => {
                    self.observed = self.observed.saturating_add(count as u64);
                    let keep = count.min(limit.saturating_sub(self.captured));
                    self.file.write_all(&buffer[..keep])?;
                    self.captured += keep;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(self.observed > limit as u64)
    }
}

fn custodian(request_path: &Path, started: u64, expires: u64) -> io::Result<()> {
    reset_child_policy()?;
    #[cfg(target_os = "linux")]
    {
        // Dedicated childless process: adopted descendants cannot be confused
        // with unrelated application children. Failure refuses target creation.
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let request = read_request(File::open(request_path)?)?;
    if expires
        != started
            .checked_add(request.timeout_ms * 1_000_000)
            .ok_or_else(|| io::Error::other("deadline overflow"))?
        || now()? < started
    {
        return Err(io::Error::other("invalid original deadline"));
    }
    let root = &request.artifact_directory;
    let input = STANDARD.decode(&request.input).map_err(io::Error::other)?;
    let stdout = private_file(&root.join("stdout"))?;
    let stderr = private_file(&root.join("stderr"))?;
    let mut command = Command::new(&request.command);
    command
        .args(&request.args)
        .current_dir(&request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    // The exact same clock interval crosses both executable boundaries.
    // SAFETY: pre_exec only samples the clock and returns an errno.
    unsafe {
        command.pre_exec(move || {
            if expired(expires) {
                Err(io::Error::from_raw_os_error(libc::ETIMEDOUT))
            } else {
                Ok(())
            }
        });
    }
    if expired(expires) {
        return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            publish_outcome(
                root,
                &serde_json::json!({
                    "pid": 0, "status": null, "signal": null, "error": error.to_string(),
                    "errorCode": if error.raw_os_error() == Some(libc::ENOENT) { "ENOENT" } else { "ESPAWN" },
                    "durationMs": now()?.saturating_sub(started) / 1_000_000,
                    "timeoutCleanup": null, "custody": {"directChildReaped": true,
                        "groupSettlement": "not_started", "descendantSettlement": "not_started",
                        "stdoutEof": true, "stderrEof": true, "uncertain": true}
                }),
            )?;
            return Ok(());
        }
    };
    let pid = child.id();
    let mut input_pipe = child.stdin.take();
    let stdout_pipe = child.stdout.take().expect("piped stdout");
    let stderr_pipe = child.stderr.take().expect("piped stderr");
    // From this point no error return may drop a live child's custody.
    let mut failure = None::<String>;
    let mut error_code = None::<&str>;
    for fd in [
        input_pipe.as_ref().unwrap().as_raw_fd(),
        stdout_pipe.as_raw_fd(),
        stderr_pipe.as_raw_fd(),
    ] {
        if let Err(error) = nonblocking(fd) {
            failure = Some(error.to_string());
            error_code = Some("EPIPESETUP");
        }
    }
    let mut out = Output {
        pipe: Some(Box::new(stdout_pipe)),
        file: stdout,
        captured: 0,
        observed: 0,
        eof: false,
    };
    let mut err = Output {
        pipe: Some(Box::new(stderr_pipe)),
        file: stderr,
        captured: 0,
        observed: 0,
        eof: false,
    };
    let pipes_abandoned = error_code == Some("EPIPESETUP");
    if pipes_abandoned {
        // A failed fcntl leaves a potentially blocking pipe. Do not enter IO
        // before stopping the owned group; retain the missing EOF observation.
        input_pipe = None;
        out.pipe = None;
        err.pipe = None;
    }
    let mut input_offset: usize = 0;
    let mut stop = None::<GroupStop>;
    let mut status = None;
    let mut settled = false;
    let mut ownership_error = None::<String>;
    loop {
        if failure.is_none() && expired(expires) {
            failure = Some("original command timeout".into());
            error_code = Some("ETIMEDOUT");
        }
        if failure.is_some() {
            input_pipe = None;
        }
        if let Some(pipe) = input_pipe.as_mut() {
            let end = input.len().min(input_offset.saturating_add(65536));
            match pipe.write(&input[input_offset..end]) {
                Ok(count) => {
                    input_offset += count;
                    if input_offset == input.len() {
                        input_pipe = None;
                    }
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                    input_pipe = None;
                }
                Err(error) => {
                    failure.get_or_insert(error.to_string());
                    error_code.get_or_insert("EINPUT");
                    input_pipe = None;
                }
            }
        }
        for output in [&mut out, &mut err] {
            match output.drain(request.max_buffer) {
                Ok(true) => {
                    failure.get_or_insert("command output exceeds bound".into());
                    error_code.get_or_insert("ENOBUFS");
                }
                Ok(false) => {}
                Err(error) => {
                    failure.get_or_insert(error.to_string());
                    error_code.get_or_insert("EOUTPUT");
                }
            }
        }
        if status.is_none() {
            let exited = match leader_exited(&child) {
                Ok(value) => value,
                Err(error) => {
                    ownership_error = Some(error.to_string());
                    false
                }
            };
            if failure.is_some() || exited {
                // A successful stop is not a settlement observation. It also
                // runs for natural leader exit so residual group children stop.
                if stop.is_none() {
                    match owned_group::stop_before_reap(&child) {
                        Ok(value) => stop = Some(value),
                        Err(error) => ownership_error = Some(error.to_string()),
                    }
                }
                #[cfg(target_os = "macos")]
                if matches!(
                    owned_group::settlement_before_reap(&child),
                    Ok(GroupSettlement::Exited { .. })
                ) {
                    match child.wait() {
                        Ok(value) => {
                            status = Some(value);
                            settled = true;
                        }
                        Err(error) => ownership_error = Some(error.to_string()),
                    }
                }
                #[cfg(target_os = "linux")]
                if exited && stop.is_some() {
                    match child.wait() {
                        Ok(value) => status = Some(value),
                        Err(error) => ownership_error = Some(error.to_string()),
                    }
                }
            }
        }
        #[cfg(target_os = "linux")]
        if status.is_some() && !settled {
            // The last group signal happened before reaping its leader. From
            // here only wait on actual adopted children, never signal a number.
            for _ in 0..64 {
                let mut raw_status = 0;
                let waited = unsafe { libc::waitpid(-1, &mut raw_status, libc::WNOHANG) };
                if waited > 0 {
                    continue;
                }
                if waited < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                    settled = true;
                }
                break;
            }
        }
        if settled && ((out.eof && err.eof) || pipes_abandoned) {
            let status = status.expect("settlement requires leader reap");
            let timeout_cleanup = (error_code == Some("ETIMEDOUT")).then(|| serde_json::json!({
                "result": if matches!(stop, Some(GroupStop::Signalled)) { "signaled" } else { "settled" },
                "scope": "original_private_process_group", "observation": stop
            }));
            let outcome = serde_json::json!({
                "pid": pid, "status": status.code(), "signal": status.signal(),
                "error": failure, "errorCode": error_code,
                "durationMs": now().unwrap_or(expires).saturating_sub(started) / 1_000_000,
                "timeoutCleanup": timeout_cleanup,
                "stdoutBytes": out.captured, "stderrBytes": err.captured,
                "stdoutObservedBytes": out.observed, "stderrObservedBytes": err.observed,
                "custody": {"directChildReaped": true, "groupSettlement": "settled",
                    "descendantSettlement": if cfg!(target_os = "linux") { "subreaper_echild" } else { "escaped_descendants_unproven" },
                    "stdoutEof": out.eof, "stderrEof": err.eof, "uncertain": failure.is_some(),
                    "ownershipDiagnostic": ownership_error}
            });
            // If durable reporting fails, foreground returns uncertainty with
            // the retained root. No fixture deletion is authorized by this path.
            out.file.sync_all()?;
            err.file.sync_all()?;
            publish_outcome(root, &outcome)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let result = match args.as_slice() {
        [_] => frontend(),
        [_, flag, request, started, expires] if flag == "--custodian" => {
            match (started.parse(), expires.parse()) {
                (Ok(started), Ok(expires)) => custodian(Path::new(request), started, expires),
                _ => Err(io::Error::other("invalid deadline arguments")),
            }
        }
        _ => Err(io::Error::other(
            "unexpected qualification supervisor arguments",
        )),
    };
    if let Err(error) = result {
        eprintln!("qualification supervisor: {error}");
        std::process::exit(1);
    }
}
