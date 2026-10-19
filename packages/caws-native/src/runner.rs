use crate::cli::Config;
use serde_json::value::RawValue;
use std::{
    io,
    os::{
        fd::{AsRawFd, RawFd},
        unix::process::CommandExt,
    },
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};

pub const MAX_PAYLOAD: usize = 1_048_576;
pub const MAX_REQUEST: usize = 8 * 1024 * 1024;
pub const MAX_FRAME: usize = 4_194_304 + 4096;
const MAX_ENGINE_STDERR: usize = 65_536;
const CLEANUP_BUDGET: Duration = Duration::from_millis(500);
const DELIVERY_BUDGET: Duration = Duration::from_millis(500);

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
    poll_with_cancellation(fds, deadline, true)
}

fn poll_with_cancellation(
    fds: &mut [libc::pollfd],
    deadline: Instant,
    observe_cancellation: bool,
) -> Result<(), String> {
    if observe_cancellation {
        crate::cancellation::check()?;
    }
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
    if observe_cancellation {
        crate::cancellation::check()?;
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

pub fn read_payload(deadline: Instant) -> Result<(Box<RawValue>, String), String> {
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
        // Validate JSON grammar without materializing unknown numerals as f64 or
        // interpreting object keys as a serializer's private numeric sentinel.
        let payload = RawValue::from_string(if input.is_empty() {
            "{}".into()
        } else {
            input.clone()
        })
        .map_err(|e| format!("invalid hook JSON: {e}"))?;
        if !payload.get().trim_start().starts_with('{') {
            return Err("hook JSON must be an object".into());
        }
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
    cleanup_attempted: bool,
}
impl OwnedGroup {
    fn finish(&mut self) -> Result<std::process::ExitStatus, String> {
        self.cleanup_attempted = true;
        // The direct child is deliberately NOT reaped before signaling: its PID
        // pins the group identity, preventing a recycled PID from targeting others.
        // SAFETY: pre_exec successfully made this child its own group leader.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let deadline = Instant::now() + CLEANUP_BUDGET;
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .map_err(|e| format!("engine reap: {e}"))?
            {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                return Err("owned engine was signaled but could not be reaped within the 500ms cleanup budget".into());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        if !self.cleanup_attempted {
            let _ = self.finish();
        }
    }
}

pub struct Session {
    group: OwnedGroup,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    buffered: Vec<u8>,
    diagnostics: Vec<u8>,
    stdout_bytes: usize,
    out_done: bool,
    err_done: bool,
    terminal_containment: bool,
}

impl Session {
    pub fn start(config: &Config, deadline: Instant) -> Result<Self, String> {
        crate::cancellation::check()?;
        if Instant::now() >= deadline {
            return Err("request deadline expired before engine spawn".into());
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
        let child = command.spawn().map_err(|e| format!("engine spawn: {e}"))?;
        let mut group = OwnedGroup {
            child,
            cleanup_attempted: false,
        };
        let stdin = group.child.stdin.take().ok_or("missing engine stdin")?;
        let stdout = group.child.stdout.take().ok_or("missing engine stdout")?;
        let stderr = group.child.stderr.take().ok_or("missing engine stderr")?;
        nonblocking(stdin.as_raw_fd())?;
        nonblocking(stdout.as_raw_fd())?;
        nonblocking(stderr.as_raw_fd())?;
        Ok(Self {
            group,
            stdin,
            stdout,
            stderr,
            buffered: Vec::new(),
            diagnostics: Vec::new(),
            stdout_bytes: 0,
            out_done: false,
            err_done: false,
            terminal_containment: false,
        })
    }

    // Every write also drains bounded engine output, so neither side can deadlock
    // by filling the opposite pipe. Request stdin remains open through handoff.
    fn pump(&mut self, write: Option<&[u8]>, deadline: Instant) -> Result<usize, String> {
        let mut descriptors = [
            libc::pollfd {
                fd: if write.is_some() {
                    self.stdin.as_raw_fd()
                } else {
                    -1
                },
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: if self.out_done {
                    -1
                } else {
                    self.stdout.as_raw_fd()
                },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if self.err_done {
                    -1
                } else {
                    self.stderr.as_raw_fd()
                },
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        poll_with_cancellation(&mut descriptors, deadline, !self.terminal_containment)?;
        let mut written = 0;
        if let Some(bytes) = write
            && descriptors[0].revents != 0
        {
            let chunk = &bytes[..bytes.len().min(16_384)];
            // SAFETY: chunk is readable for its length; the pipe is live and nonblocking.
            let count =
                unsafe { libc::write(self.stdin.as_raw_fd(), chunk.as_ptr().cast(), chunk.len()) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    return Err(format!("engine input write: {error}"));
                }
            } else if count == 0 {
                return Err("engine input write made no progress".into());
            } else {
                written = count as usize;
            }
        }
        if !self.out_done && descriptors[1].revents != 0 {
            let before = self.buffered.len();
            self.out_done = read_chunk(self.stdout.as_raw_fd(), &mut self.buffered, MAX_FRAME)?;
            self.stdout_bytes += self.buffered.len() - before;
            if self.stdout_bytes > MAX_FRAME + 16_384 {
                return Err("engine stream exceeded total byte budget".into());
            }
        }
        if !self.err_done && descriptors[2].revents != 0 {
            self.err_done = read_chunk(
                self.stderr.as_raw_fd(),
                &mut self.diagnostics,
                MAX_ENGINE_STDERR,
            )?;
        }
        Ok(written)
    }

    pub fn send(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String> {
        let mut offset = 0;
        while offset < bytes.len() {
            offset += self.pump(Some(&bytes[offset..]), deadline)?;
        }
        Ok(())
    }

    pub fn begin_terminal_containment(&mut self, _target: &crate::process_effect::ValidatedTarget) {
        // The private target capability is available only after terminal intent
        // validation. This mode can only flush its ACK and settle; never dispatch.
        self.terminal_containment = true;
    }

    pub fn frame(&mut self, deadline: Instant) -> Result<Vec<u8>, String> {
        if self.terminal_containment {
            return Err("no engine frames admitted after terminal containment".into());
        }
        loop {
            crate::cancellation::check()?;
            if let Some(end) = self.buffered.iter().position(|b| *b == b'\n') {
                let bytes: Vec<u8> = self.buffered.drain(..=end).collect();
                if end == 0 {
                    return Err("empty engine frame".into());
                }
                return Ok(bytes[..end].to_vec());
            }
            if self.out_done {
                return Err("engine stream closed before a complete frame".into());
            }
            self.pump(None, deadline)?;
        }
    }

    pub fn settle(&mut self, deadline: Instant) -> Result<(), String> {
        // Pipes can close before the process exits. A nonblocking waitid observes
        // termination WITHOUT reaping, preserving ownership until group cleanup.
        loop {
            if !self.terminal_containment {
                crate::cancellation::check()?;
            }
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: valid child PID and initialized writable siginfo storage.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.group.child.id(),
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
            self.pump(None, deadline)?;
        }
        let status = self.group.finish()?;
        if !status.success() {
            return Err(format!(
                "engine exited unsuccessfully after proposal ({status})"
            ));
        }
        Ok(())
    }

    pub fn cleanup(&mut self) -> Result<(), String> {
        if !self.group.cleanup_attempted {
            self.group.finish()?;
        }
        Ok(())
    }
}

struct Flags {
    fd: RawFd,
    original: i32,
}
impl Flags {
    fn nonblocking(fd: RawFd) -> Result<Self, String> {
        Ok(Self {
            fd,
            original: nonblocking(fd)?,
        })
    }
}
impl Drop for Flags {
    fn drop(&mut self) {
        // SAFETY: these borrowed process stdio descriptors remain live here.
        unsafe {
            libc::fcntl(self.fd, libc::F_SETFL, self.original);
        }
    }
}

fn write_output(
    stdout: &[u8],
    stderr: &[u8],
    budget: Duration,
    observe_cancellation: bool,
) -> Result<(), String> {
    if observe_cancellation {
        crate::cancellation::check()?;
    }
    let _stdout_flags = Flags::nonblocking(libc::STDOUT_FILENO)?;
    let _stderr_flags = Flags::nonblocking(libc::STDERR_FILENO)?;
    let buffers = [stdout, stderr];
    let descriptors = [libc::STDOUT_FILENO, libc::STDERR_FILENO];
    let mut offsets = [0_usize; 2];
    let deadline = Instant::now() + budget;
    while offsets[0] < stdout.len() || offsets[1] < stderr.len() {
        let mut fds = [
            libc::pollfd {
                fd: if offsets[0] < stdout.len() {
                    descriptors[0]
                } else {
                    -1
                },
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: if offsets[1] < stderr.len() {
                    descriptors[1]
                } else {
                    -1
                },
                events: libc::POLLOUT,
                revents: 0,
            },
        ];
        poll_with_cancellation(&mut fds, deadline, observe_cancellation)
            .map_err(|e| format!("bounded output write: {e}"))?;
        for index in 0..2 {
            if fds[index].revents == 0 {
                continue;
            }
            let bytes =
                &buffers[index][offsets[index]..buffers[index].len().min(offsets[index] + 16_384)];
            // SAFETY: bytes is readable for its length; stdio remains live and nonblocking.
            let count =
                unsafe { libc::write(descriptors[index], bytes.as_ptr().cast(), bytes.len()) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    return Err(format!("native output write: {error}"));
                }
            } else if count == 0 {
                return Err("native output write made no progress".into());
            } else {
                offsets[index] += count as usize;
            }
        }
    }
    Ok(())
}

pub fn write_native(stdout: &[u8], stderr: &[u8]) -> Result<(), String> {
    write_output(stdout, stderr, DELIVERY_BUDGET, true)
}

/// Only the owner of a validated terminal target may use this delivery path.
/// Output closure/backpressure cannot revoke an already earned containment effect.
pub fn write_terminal_native(
    stdout: &[u8],
    stderr: &[u8],
    _target: &crate::process_effect::ValidatedTarget,
) -> Result<(), String> {
    write_output(stdout, stderr, DELIVERY_BUDGET, false)
}

pub fn write_diagnostic(stderr: &[u8]) {
    // Cancellation diagnostics are best effort with their own 100ms ceiling;
    // they must not recurse through the cancellation that caused the failure.
    let _ = write_output(&[], stderr, Duration::from_millis(100), false);
}
