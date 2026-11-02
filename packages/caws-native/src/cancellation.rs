use std::{
    io,
    sync::atomic::{AtomicI32, Ordering},
};

static SIGNAL: AtomicI32 = AtomicI32::new(0);
static PARENT: AtomicI32 = AtomicI32::new(0);

extern "C" fn cancelled(signal: libc::c_int) {
    // Only a lock-free atomic store is performed in signal context.
    SIGNAL.store(signal, Ordering::Relaxed);
}

pub fn install() -> Result<(), String> {
    // SAFETY: getppid has no pointer arguments or preconditions.
    PARENT.store(unsafe { libc::getppid() }, Ordering::Relaxed);
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: sigaction is initialized before use; the handler has the C ABI
        // and does not allocate, acquire locks, or perform cleanup in the handler.
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = cancelled as usize;
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        action.sa_flags = 0;
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(format!(
                "cancellation handler configuration: {}",
                io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

pub fn check() -> Result<(), String> {
    let signal = SIGNAL.load(Ordering::Relaxed);
    if signal != 0 {
        return Err(format!("native invocation cancelled by signal {signal}"));
    }
    let parent = PARENT.load(Ordering::Relaxed);
    // A normal stdin EOF finishes the request; it does not mean cancellation.
    // Reparenting is a separate observation that the original caller exited.
    if parent > 1 && unsafe { libc::getppid() } != parent {
        return Err("native invocation cancelled because the original caller exited".into());
    }
    if output_closed(libc::STDOUT_FILENO) {
        return Err("native invocation cancelled because the caller output channel closed".into());
    }
    Ok(())
}

fn output_closed(fd: libc::c_int) -> bool {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: fstat initializes the writable structure on success.
    if unsafe { libc::fstat(fd, metadata.as_mut_ptr()) } != 0 {
        return io::Error::last_os_error().raw_os_error() == Some(libc::EBADF);
    }
    // SAFETY: successful fstat initialized the complete structure.
    let mode = unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT;
    if mode != libc::S_IFIFO && mode != libc::S_IFSOCK {
        // Darwin poll reports POLLNVAL for valid /dev/null descriptors. Only
        // a pipe or socket can establish that the caller's reader disappeared.
        return false;
    }
    let mut output = libc::pollfd {
        fd,
        // Darwin does not report the closed reader with an empty event mask.
        events: libc::POLLOUT,
        revents: 0,
    };
    // SAFETY: this is a zero-time observation of the live process stdout slot.
    (unsafe { libc::poll(&mut output, 1, 0) }) > 0
        && output.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    #[test]
    fn writer_observes_closed_reader_without_writing_or_signaling() {
        let mut fds = [-1; 2];
        // SAFETY: fds has capacity for the two initialized pipe descriptors.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: pipe returned two fresh descriptors, each transferred once.
        let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
        assert!(!output_closed(write.as_raw_fd()));
        drop(read);
        assert!(output_closed(write.as_raw_fd()));
    }

    #[test]
    fn valid_regular_file_and_null_device_are_not_closed_caller_channels() {
        let null = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .unwrap();
        let regular =
            std::fs::File::open(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
        assert!(!output_closed(null.as_raw_fd()));
        assert!(!output_closed(regular.as_raw_fd()));
    }
}
