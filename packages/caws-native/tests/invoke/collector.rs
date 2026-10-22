//! Bounded collection for the native invocation test harness.
//! Child exit and output EOF are separate observations.
use std::{
    io::Read,
    os::fd::AsRawFd,
    thread,
    time::{Duration, Instant},
};

pub(super) fn set_nonblocking(pipe: &impl AsRawFd) {
    // SAFETY: the retained pipe owns this descriptor throughout this call.
    let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
    assert!(
        flags >= 0,
        "read pipe flags: {}",
        std::io::Error::last_os_error()
    );
    // SAFETY: the same retained descriptor is valid; only O_NONBLOCK is added.
    let result = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) };
    assert!(
        result >= 0,
        "set pipe nonblocking: {}",
        std::io::Error::last_os_error()
    );
}

#[derive(Default)]
pub(super) struct PipeCapture {
    pub(super) bytes: Vec<u8>,
    pub(super) eof: bool,
    pub(super) error: Option<String>,
}

impl PipeCapture {
    pub(super) fn poll(&mut self, pipe: &mut impl Read) {
        if self.eof || self.error.is_some() {
            return;
        }
        // A continuously writing producer cannot monopolize the deadline loop.
        for _ in 0..16 {
            let mut buffer = [0; 8192];
            match pipe.read(&mut buffer) {
                Ok(0) => {
                    self.eof = true;
                    return;
                }
                Ok(count) => self.bytes.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    self.error = Some(error.to_string());
                    return;
                }
            }
        }
    }
}

pub(super) fn collection_outcome(
    child_reaped: bool,
    input_terminal: bool,
    out: &PipeCapture,
    err: &PipeCapture,
    expired: bool,
) -> Result<bool, &'static str> {
    if out.error.is_some() || err.error.is_some() {
        Err("native pipe observation failed")
    } else if child_reaped && input_terminal && out.eof && err.eof {
        Ok(true)
    } else if expired {
        Err("native invocation watchdog: child/pipe settlement unknown")
    } else {
        Ok(false)
    }
}

pub(super) fn cleanup_execute_child(child: &mut std::process::Child) -> &'static str {
    // The caller retains the original, unreaped Child. No discovered PID or
    // inferred process group supplies cleanup authority.
    // SAFETY: the unreaped original Child pins this direct signal target.
    let term = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    if term != 0 {
        return "original child SIGTERM failed; cleanup settlement unknown";
    }
    for force in [false, true] {
        if force && child.kill().is_err() {
            return "original child SIGKILL failed; cleanup settlement unknown";
        }
        let deadline = Instant::now() + Duration::from_millis(700);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    return "original child reaped after watchdog; pipe settlement remains failed";
                }
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(_) => {
                    return "original child cleanup observation unavailable; settlement unknown";
                }
            }
        }
    }
    "original child not reaped within cleanup deadline; settlement unknown"
}
