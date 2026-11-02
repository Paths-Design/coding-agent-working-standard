//! Private process entry for a native owner. Descriptors are supplied by its
//! creator, never discovered from a PID, lease, environment variable or pathname.
use super::*;
use std::os::unix::fs::FileTypeExt;
use std::sync::atomic::{AtomicBool, Ordering};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);
pub(super) fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::Relaxed)
}
extern "C" fn stop(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Relaxed);
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerConfiguration {
    pub schema: String,
    pub backend: PinnedBackendSpec,
    pub limits: WorkerLimits,
}

fn descriptor(fd: RawFd, kind: libc::mode_t, rights: i32) -> Result<fs::Metadata> {
    let access = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if access < 0 || access & libc::O_ACCMODE != rights {
        return fail(FailureCode::InvalidSpec);
    }
    let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
    let owned = borrowed.try_clone_to_owned().map_err(Failure::io)?;
    let metadata = File::from(owned).metadata().map_err(Failure::io)?;
    let correct_type = match kind {
        libc::S_IFREG => metadata.is_file(),
        libc::S_IFSOCK => metadata.file_type().is_socket(),
        _ => false,
    };
    if !correct_type {
        return fail(FailureCode::InvalidSpec);
    }
    Ok(metadata)
}
fn configuration() -> Result<WorkerConfiguration> {
    let meta = descriptor(4, libc::S_IFREG, libc::O_RDONLY)?;
    if meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != 0o400
        || meta.nlink() != 1
        || meta.len() > 1_048_576
    {
        return fail(FailureCode::InvalidSpec);
    }
    let mut bytes = vec![0; meta.len() as usize];
    let mut at = 0;
    while at < bytes.len() {
        let read = unsafe {
            libc::pread(
                4,
                bytes[at..].as_mut_ptr().cast(),
                bytes.len() - at,
                at as libc::off_t,
            )
        };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(Failure::io(error));
        }
        if read == 0 {
            return fail(FailureCode::InvalidSpec);
        }
        at += read as usize;
    }
    let after = descriptor(4, libc::S_IFREG, libc::O_RDONLY)?;
    if (
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    ) != (
        after.dev(),
        after.ino(),
        after.len(),
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    ) {
        return fail(FailureCode::InvalidSpec);
    }
    let config: WorkerConfiguration =
        serde_json::from_slice(&bytes).map_err(|_| Failure::new(FailureCode::InvalidSpec))?;
    if config.schema != "caws.renderer.worker.configuration.v1" {
        return fail(FailureCode::InvalidSpec);
    }
    config.limits.validate()?;
    Ok(config)
}

/// The only accepted invocation is `renderer-worker`. This entry is not a
/// project-authority API: production admission belongs to the native owner.
/// FD3=private control socket, FD4=readonly configuration, FD6=machine custody,
/// FD7=project writer custody inherited by the actual backend.
pub fn run() -> std::result::Result<WorkerExit, Failure> {
    let config = configuration()?;
    descriptor(3, libc::S_IFSOCK, libc::O_RDWR)?;
    let custody = descriptor(6, libc::S_IFREG, libc::O_RDWR)?;
    let writer = descriptor(7, libc::S_IFREG, libc::O_RDWR)?;
    if custody.uid() != unsafe { libc::geteuid() }
        || custody.mode() & 0o7777 != 0o600
        || custody.nlink() != 1
        || writer.uid() != unsafe { libc::geteuid() }
        || writer.mode() & 0o7777 != 0o600
        || writer.nlink() != 1
        || (writer.dev(), writer.ino()) == (custody.dev(), custody.ino())
    {
        return fail(FailureCode::InvalidSpec);
    }
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = stop as *const () as usize;
        unsafe { libc::sigemptyset(&mut action.sa_mask) };
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(Failure::io(io::Error::last_os_error()));
        }
    }
    // SAFETY: the private CLI entry owns these distinct inherited descriptors.
    let control = unsafe { UnixStream::from_raw_fd(3) };
    let custody = unsafe { OwnedFd::from_raw_fd(6) };
    let writer = unsafe { OwnedFd::from_raw_fd(7) };
    unsafe { libc::close(4) };
    Ok(run_worker_with_writer(
        config.backend,
        control,
        config.limits,
        custody,
        writer,
    ))
}
