use crate::cli::Config;
use serde_json::{Map, Value};
use std::{
    io,
    os::{
        fd::{AsRawFd, RawFd},
        unix::process::CommandExt,
    },
    process::{Child, Command, Stdio},
    time::Instant,
};

pub const MAX_PAYLOAD: usize = 1_048_576;
const MAX_RESPONSE: usize = 4_194_304;
const MAX_ENGINE_STDERR: usize = 65_536;

pub struct Failure {
    pub started: bool,
    pub message: String,
}
impl Failure {
    pub fn configuration(message: String) -> Self {
        Self {
            started: false,
            message,
        }
    }
    pub fn execution(message: String) -> Self {
        Self {
            started: true,
            message,
        }
    }
}

fn nonblocking(fd: RawFd) -> Result<i32, String> {
    // SAFETY: fcntl operates on a borrowed, live descriptor, without pointer arguments.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(format!(
            "nonblocking pipe configuration: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(flags)
}

fn poll(fds: &mut [libc::pollfd], deadline: Instant) -> Result<(), String> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or("request deadline expired")?;
    let timeout = remaining.as_millis().clamp(1, 100) as i32;
    // SAFETY: fds points at an initialized writable array for its stated length.
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(format!("pipe polling: {error}"));
        }
    }
    Ok(())
}

fn read_chunk(fd: RawFd, output: &mut Vec<u8>, limit: usize) -> Result<bool, String> {
    let mut buffer = [0_u8; 16_384];
    // SAFETY: buffer is writable for buffer.len(); fd remains owned by caller.
    let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
    if count == 0 {
        return Ok(true);
    }
    if count < 0 {
        let error = io::Error::last_os_error();
        if matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            return Ok(false);
        }
        return Err(format!("pipe read: {error}"));
    }
    if output.len() + count as usize > limit {
        return Err(format!("pipe exceeded {limit} byte budget"));
    }
    output.extend_from_slice(&buffer[..count as usize]);
    Ok(false)
}

pub fn read_payload(deadline: Instant) -> Result<(Map<String, Value>, String), String> {
    let fd = libc::STDIN_FILENO;
    let original = nonblocking(fd)?;
    let read = (|| {
        let mut bytes = Vec::new();
        loop {
            let mut descriptors = [libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            }];
            poll(&mut descriptors, deadline)?;
            if read_chunk(fd, &mut bytes, MAX_PAYLOAD)? {
                break;
            }
        }
        let input = String::from_utf8(bytes).map_err(|_| "hook JSON must be valid UTF-8")?;
        let value: Value =
            serde_json::from_str(&input).map_err(|e| format!("invalid hook JSON: {e}"))?;
        let payload = value
            .as_object()
            .cloned()
            .ok_or("hook JSON must be an object")?;
        Ok((payload, input))
    })();
    // SAFETY: restore flags on the same live descriptor, including error paths.
    unsafe {
        libc::fcntl(fd, libc::F_SETFL, original);
    }
    read
}

struct OwnedGroup {
    child: Child,
    reaped: bool,
}
impl OwnedGroup {
    fn finish(&mut self) -> Result<std::process::ExitStatus, String> {
        // The direct child is deliberately NOT reaped before signaling: its PID
        // pins the group identity, preventing a recycled PID from targeting others.
        // SAFETY: pre_exec successfully made this child its own group leader.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let status = self.child.wait().map_err(|e| format!("engine reap: {e}"))?;
        self.reaped = true;
        Ok(status)
    }
}
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.finish();
        }
    }
}

pub fn invoke(config: &Config, request: &[u8], deadline: Instant) -> Result<Vec<u8>, Failure> {
    if Instant::now() >= deadline {
        return Err(Failure::configuration(
            "request deadline expired before engine spawn".into(),
        ));
    }
    let mut command = Command::new(&config.node);
    command
        .arg(&config.engine)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: setpgid is async-signal-safe and this closure performs no allocation.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let child = command
        .spawn()
        .map_err(|e| Failure::configuration(format!("engine spawn: {e}")))?;
    let mut group = OwnedGroup {
        child,
        reaped: false,
    };
    run(&mut group, request, deadline).map_err(Failure::execution)
}

fn run(group: &mut OwnedGroup, request: &[u8], deadline: Instant) -> Result<Vec<u8>, String> {
    let mut stdin = group.child.stdin.take();
    let stdout = group.child.stdout.take().ok_or("missing engine stdout")?;
    let stderr = group.child.stderr.take().ok_or("missing engine stderr")?;
    nonblocking(stdin.as_ref().ok_or("missing engine stdin")?.as_raw_fd())?;
    nonblocking(stdout.as_raw_fd())?;
    nonblocking(stderr.as_raw_fd())?;
    let mut written = 0;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let (mut out_done, mut err_done) = (false, false);
    loop {
        let mut descriptors = [
            libc::pollfd {
                fd: stdin.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: if out_done { -1 } else { stdout.as_raw_fd() },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if err_done { -1 } else { stderr.as_raw_fd() },
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        poll(&mut descriptors, deadline)?;
        if let Some(pipe) = stdin.as_ref()
            && descriptors[0].revents != 0
        {
            let chunk = &request[written..request.len().min(written + 16_384)];
            // SAFETY: chunk is readable for its length; the pipe is live and nonblocking.
            let count =
                unsafe { libc::write(pipe.as_raw_fd(), chunk.as_ptr().cast(), chunk.len()) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    return Err(format!("engine input write: {error}"));
                }
            } else {
                written += count as usize;
            }
            if written == request.len() {
                stdin.take();
            }
        }
        if !out_done && descriptors[1].revents != 0 {
            out_done = read_chunk(stdout.as_raw_fd(), &mut out, MAX_RESPONSE)?;
        }
        if !err_done && descriptors[2].revents != 0 {
            err_done = read_chunk(stderr.as_raw_fd(), &mut err, MAX_ENGINE_STDERR)?;
        }
        if out_done && err_done && stdin.is_none() {
            break;
        }
    }
    // Pipes can close before the process exits. A nonblocking waitid observes
    // termination WITHOUT reaping, preserving ownership until group cleanup.
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: valid child PID and initialized writable siginfo storage.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                group.child.id(),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            return Err(format!(
                "engine exit observation: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: waitid initialized this structure (zeroed when no child exited).
        if unsafe { info.assume_init().si_pid() } != 0 {
            break;
        }
        poll(&mut [], deadline)?;
    }
    let status = group.finish()?;
    if !status.success() {
        return Err(format!("engine process exited unsuccessfully ({status})"));
    }
    Ok(out)
}
