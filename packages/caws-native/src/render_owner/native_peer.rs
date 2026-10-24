//! Kernel-bound admission of one original native frontend connection.
//!
//! This authenticates a cooperative admitted native producer, not its invocation
//! contents, launcher ancestry, immutable execution image, or policy authority.
//! Same-UID injection/descriptor theft and modified trusted native code are
//! outside this boundary. Registration must still bind the exact original data.
use crate::{
    installed_generation::{MemberMetadata, Selection, Verification},
    monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline},
};
use std::{
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, PartialEq, Eq)]
struct ProcessInstance {
    pid: u32,
    started_seconds: u64,
    started_microseconds: u64,
}

#[derive(Debug, PartialEq, Eq)]
struct PeerIdentity {
    process: ProcessInstance,
    executable: PathBuf,
}

/// Neither Clone nor Deserialize: only the authenticated connection constructs
/// this value. The borrowed original clock cannot be renewed by a later caller.
/// The held descriptor is private and close-on-exec; never export it to Node.
pub(super) struct NativePeer<'deadline> {
    held: UnixStream,
    identity: PeerIdentity,
    generation: Selection,
    native_path: PathBuf,
    native_metadata: MemberMetadata,
    deadline: &'deadline MonotonicDeadline,
    original_deadline: DeadlineEnvelope,
}

fn checkpoint(deadline: &MonotonicDeadline, cancel: &mut impl FnMut() -> Result<()>) -> Result<()> {
    cancel()?;
    deadline.check().map_err(|e| e.to_string())
}

fn held_connection(stream: &UnixStream) -> Result<UnixStream> {
    let held = stream.try_clone().map_err(|e| e.to_string())?;
    let flags = unsafe { libc::fcntl(held.as_raw_fd(), libc::F_GETFD) };
    if flags < 0 || flags & libc::FD_CLOEXEC == 0 {
        return Err("Native peer retained descriptor is not close-on-exec".into());
    }
    Ok(held)
}

fn connection_open(stream: &UnixStream) -> Result<()> {
    let mut byte = 0u8;
    let n = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    if n == 0 {
        return Err("Native peer connection closed".into());
    }
    if n < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::WouldBlock {
            return Err(format!("Native peer connection unavailable: {error}"));
        }
    }
    // Buffered bytes are not an EOF proof. The registration protocol must read
    // its complete bounded frame and reject surplus/EOF at its own boundary.
    Ok(())
}

#[cfg(target_os = "macos")]
fn process_instance(pid: u32) -> Result<ProcessInstance> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if count != size as i32 {
        return Err("Native peer process birth unavailable".into());
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid
        || info.pbi_uid != unsafe { libc::geteuid() }
        || info.pbi_start_tvsec == 0
        || info.pbi_start_tvusec >= 1_000_000
        || info.pbi_status == libc::SZOMB
    {
        return Err("Native peer process instance invalid".into());
    }
    Ok(ProcessInstance {
        pid,
        started_seconds: info.pbi_start_tvsec,
        started_microseconds: info.pbi_start_tvusec,
    })
}

#[cfg(target_os = "macos")]
fn peer_identity(stream: &UnixStream) -> Result<PeerIdentity> {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let mut uid = 0;
    let mut gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { libc::geteuid() }
    {
        return Err("Native peer UID unavailable or different".into());
    }
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of_val(&pid)
        || pid <= 1
    {
        return Err("Native peer kernel PID unavailable".into());
    }
    let before = process_instance(pid as u32)?;
    let mut bytes = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let count = unsafe { libc::proc_pidpath(pid, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if count <= 0 || count as usize > bytes.len() {
        return Err("Native peer executable pathname unavailable".into());
    }
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("Native peer executable pathname is not terminated")?;
    if end == 0 {
        return Err("Native peer executable pathname is empty".into());
    }
    bytes.truncate(end);
    let executable = PathBuf::from(OsString::from_vec(bytes));
    if !executable.is_absolute() {
        return Err("Native peer executable pathname is not absolute".into());
    }
    if process_instance(pid as u32)? != before {
        return Err("Native peer process changed during executable observation".into());
    }
    connection_open(stream)?;
    Ok(PeerIdentity {
        process: before,
        executable,
    })
}

#[cfg(not(target_os = "macos"))]
fn peer_identity(_stream: &UnixStream) -> Result<PeerIdentity> {
    // Linux SO_PEERCRED alone does not establish the same process/path profile.
    // Production activation is deliberately macOS-only until separately proved.
    Err("Original native peer admission is qualified only on macOS".into())
}

impl<'deadline> NativePeer<'deadline> {
    pub(super) fn capture(
        stream: &UnixStream,
        trusted_home: &Path,
        exact_request_generation: &str,
        deadline: &'deadline MonotonicDeadline,
        mut cancel: impl FnMut() -> Result<()>,
    ) -> Result<Self> {
        checkpoint(deadline, &mut cancel)?;
        let held = held_connection(stream)?;
        let identity = peer_identity(&held)?;
        checkpoint(deadline, &mut cancel)?;
        let mut checked = || checkpoint(deadline, &mut cancel);
        let mut verify = Verification::new(deadline.expires(), &mut checked);
        let generation =
            Selection::read_generation(trusted_home, exact_request_generation, &mut verify)?;
        let (native_path, _, _) = generation.native_paths(&mut verify)?;
        if identity.executable != native_path {
            return Err("Native peer executable differs from exact admitted generation".into());
        }
        let native_metadata = MemberMetadata::read(&native_path, false, &mut verify)?;
        generation.revalidate(&mut verify)?;
        if MemberMetadata::read(&native_path, false, &mut verify)? != native_metadata {
            return Err("Native peer generation member changed during admission".into());
        }
        if peer_identity(&held)? != identity {
            return Err("Native peer changed during generation verification".into());
        }
        verify.checkpoint()?;
        Ok(Self {
            held,
            identity,
            generation,
            native_path,
            native_metadata,
            deadline,
            original_deadline: deadline.envelope(),
        })
    }

    /// Revalidate the retained connection and original clock, never another
    /// socket, current pointer, JSON PID/path or freshly supplied deadline.
    pub(super) fn revalidate(&self, mut cancel: impl FnMut() -> Result<()>) -> Result<()> {
        checkpoint(self.deadline, &mut cancel)?;
        if self.deadline.envelope() != self.original_deadline {
            return Err("Native peer original deadline changed".into());
        }
        if peer_identity(&self.held)? != self.identity {
            return Err("Native peer original process or executable changed".into());
        }
        let mut checked = || checkpoint(self.deadline, &mut cancel);
        let mut verify = Verification::new(self.deadline.expires(), &mut checked);
        if MemberMetadata::read(&self.native_path, false, &mut verify)? != self.native_metadata {
            return Err("Native peer admitted generation member identity changed".into());
        }
        self.generation.revalidate(&mut verify)?;
        if MemberMetadata::read(&self.native_path, false, &mut verify)? != self.native_metadata {
            return Err("Native peer admitted generation member identity changed".into());
        }
        if peer_identity(&self.held)? != self.identity {
            return Err("Native peer changed during generation revalidation".into());
        }
        verify.checkpoint()
    }
}
