//! Cooperative attestation of the direct native host of an MCP server.
//!
//! The configured physical image and digest come from trusted native startup,
//! never request metadata. This checks a live parent instance and the image on
//! disk; it is not loaded-memory attestation or protection against same-UID
//! descriptor injection, modified trusted code, or a hostile directory writer.
//! The caller must revalidate before admitting each request and retain the same
//! stdin/stdout channel. This module does not authenticate arbitrary pipe data,
//! establish sandbox placement, or grant authority to execute.
use crate::{execution_prepared::ProgramImage, monotonic_deadline::MonotonicDeadline};
use std::{io, path::Path};

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        ffi::OsString,
        fs::{self, OpenOptions},
        io::Read,
        os::unix::{
            ffi::OsStringExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
        path::PathBuf,
    };

    fn refused() -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "native host identity unavailable or changed",
        )
    }
    fn live(deadline: &MonotonicDeadline) -> io::Result<()> {
        deadline.check().map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "original deadline unavailable or expired",
            )
        })
    }
    #[derive(Clone, PartialEq, Eq)]
    struct ProcessInstance {
        pid: u32,
        seconds: u64,
        microseconds: u64,
    }
    #[derive(Clone, PartialEq, Eq)]
    struct ImageIdentity {
        dev: u64,
        ino: u64,
        size: u64,
        mode: u32,
        mtime: i64,
        mtime_nsec: i64,
        ctime: i64,
        ctime_nsec: i64,
    }
    fn identity(m: &fs::Metadata) -> ImageIdentity {
        ImageIdentity {
            dev: m.dev(),
            ino: m.ino(),
            size: m.len(),
            mode: m.mode(),
            mtime: m.mtime(),
            mtime_nsec: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_nsec: m.ctime_nsec(),
        }
    }
    fn parent_pid() -> io::Result<u32> {
        let pid = unsafe { libc::getppid() };
        if pid <= 1 {
            return Err(refused());
        }
        Ok(pid as u32)
    }
    fn process_instance(pid: u32) -> io::Result<ProcessInstance> {
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
            return Err(refused());
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid
            || info.pbi_uid != unsafe { libc::geteuid() }
            || info.pbi_start_tvsec == 0
            || info.pbi_start_tvusec >= 1_000_000
            || info.pbi_status == libc::SZOMB
        {
            return Err(refused());
        }
        Ok(ProcessInstance {
            pid,
            seconds: info.pbi_start_tvsec,
            microseconds: info.pbi_start_tvusec,
        })
    }
    fn process_path(pid: u32) -> io::Result<PathBuf> {
        let mut bytes = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let count = unsafe {
            libc::proc_pidpath(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32)
        };
        if count <= 0 || count as usize > bytes.len() {
            return Err(refused());
        }
        let end = bytes.iter().position(|b| *b == 0).ok_or_else(refused)?;
        if end == 0 {
            return Err(refused());
        }
        bytes.truncate(end);
        let path = PathBuf::from(OsString::from_vec(bytes));
        if !path.is_absolute() {
            return Err(refused());
        }
        Ok(path)
    }
    fn image(path: &Path, hash: &str, deadline: &MonotonicDeadline) -> io::Result<ImageIdentity> {
        live(deadline)?;
        if !path.is_absolute()
            || fs::canonicalize(path)? != path
            || hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(refused());
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        let before = file.metadata()?;
        if !before.is_file() || before.len() > 268_435_456 {
            return Err(refused());
        }
        let snapshot = identity(&before);
        let mut digest = Sha256::new();
        let mut total = 0u64;
        let mut chunk = [0u8; 65536];
        loop {
            live(deadline)?;
            let count = file.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            total = total.checked_add(count as u64).ok_or_else(refused)?;
            if total > 268_435_456 {
                return Err(refused());
            }
            digest.update(&chunk[..count]);
        }
        let after = file.metadata()?;
        let named = fs::symlink_metadata(path)?;
        if total != before.len()
            || !named.is_file()
            || identity(&after) != snapshot
            || named.dev() != before.dev()
            || named.ino() != before.ino()
            || format!("{:x}", digest.finalize()) != hash
        {
            return Err(refused());
        }
        live(deadline)?;
        Ok(snapshot)
    }
    /// Cannot be deserialized or cloned. Retains the original admitted process
    /// instance and configured physical image, not a request-supplied identity.
    pub(crate) struct HostContext {
        process: ProcessInstance,
        path: PathBuf,
        sha256: String,
        disk: ImageIdentity,
    }
    impl HostContext {
        pub(crate) fn capture(
            configured_host: &ProgramImage,
            deadline: &MonotonicDeadline,
        ) -> io::Result<Self> {
            live(deadline)?;
            let pid = parent_pid()?;
            let before = process_instance(pid)?;
            let path = process_path(pid)?;
            if path != Path::new(&configured_host.path) {
                return Err(refused());
            }
            let disk = image(&path, &configured_host.sha256, deadline)?;
            if parent_pid()? != pid
                || process_instance(pid)? != before
                || process_path(pid)? != path
            {
                return Err(refused());
            }
            live(deadline)?;
            Ok(Self {
                process: before,
                path,
                sha256: configured_host.sha256.clone(),
                disk,
            })
        }
        pub(crate) fn revalidate(&self, deadline: &MonotonicDeadline) -> io::Result<()> {
            live(deadline)?;
            if parent_pid()? != self.process.pid
                || process_instance(self.process.pid)? != self.process
                || process_path(self.process.pid)? != self.path
            {
                return Err(refused());
            }
            if image(&self.path, &self.sha256, deadline)? != self.disk
                || parent_pid()? != self.process.pid
                || process_instance(self.process.pid)? != self.process
                || process_path(self.process.pid)? != self.path
            {
                return Err(refused());
            }
            live(deadline)
        }
        pub(crate) fn pid(&self) -> u32 {
            self.process.pid
        }
        pub(crate) fn birth(&self) -> (u64, u64) {
            (self.process.seconds, self.process.microseconds)
        }
        pub(crate) fn executable(&self) -> &Path {
            &self.path
        }
    }

    /// Darwin reports the socketpair creator, not the current writer after an
    /// endpoint transfer. The producer must retain exclusive peer custody and
    /// keep its endpoint CLOEXEC. The pin is derived outside the startup frame.
    pub(crate) struct ProducerPeer {
        process: ProcessInstance,
        path: PathBuf,
        disk: ImageIdentity,
    }
    fn peer_pid(fd: std::os::fd::BorrowedFd<'_>) -> io::Result<u32> {
        use std::os::fd::AsRawFd;
        let (mut uid, mut gid) = (0, 0);
        if unsafe { libc::getpeereid(fd.as_raw_fd(), &mut uid, &mut gid) } != 0
            || uid != unsafe { libc::geteuid() }
        {
            return Err(refused());
        }
        let mut pid: libc::pid_t = 0;
        let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut libc::pid_t).cast(),
                &mut len,
            )
        } != 0
            || len as usize != std::mem::size_of_val(&pid)
            || pid <= 1
        {
            return Err(refused());
        }
        Ok(pid as u32)
    }
    impl ProducerPeer {
        pub(crate) fn pid(&self) -> u32 {
            self.process.pid
        }
        pub(crate) fn birth(&self) -> (u64, u64) {
            (self.process.seconds, self.process.microseconds)
        }
        pub(crate) fn capture(
            fd: std::os::fd::BorrowedFd<'_>,
            pin: &ProgramImage,
            deadline: &MonotonicDeadline,
        ) -> io::Result<Self> {
            live(deadline)?;
            let pid = peer_pid(fd)?;
            let process = process_instance(pid)?;
            let path = process_path(pid)?;
            if path != Path::new(&pin.path) {
                return Err(refused());
            }
            let disk = image(&path, &pin.sha256, deadline)?;
            if peer_pid(fd)? != pid
                || process_instance(pid)? != process
                || process_path(pid)? != path
            {
                return Err(refused());
            }
            live(deadline)?;
            Ok(Self {
                process,
                path,
                disk,
            })
        }
        pub(crate) fn revalidate(
            &self,
            fd: std::os::fd::BorrowedFd<'_>,
            pin: &ProgramImage,
            deadline: &MonotonicDeadline,
        ) -> io::Result<()> {
            live(deadline)?;
            let pid = self.process.pid;
            if peer_pid(fd)? != pid
                || process_instance(pid)? != self.process
                || process_path(pid)? != self.path
                || self.path != Path::new(&pin.path)
                || image(&self.path, &pin.sha256, deadline)? != self.disk
                || peer_pid(fd)? != pid
                || process_instance(pid)? != self.process
                || process_path(pid)? != self.path
            {
                return Err(refused());
            }
            live(deadline)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::execution_fd_transport::{configure_child_fds, configure_private_child};
        use std::{
            io::{Read, Write},
            os::{
                fd::{AsFd, AsRawFd, FromRawFd},
                unix::net::UnixStream,
            },
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        const FIXTURE: &str = "execution_host::macos::tests::isolated_fixture";
        fn self_image() -> ProgramImage {
            let path = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
            ProgramImage {
                sha256: format!("{:x}", Sha256::digest(fs::read(&path).unwrap())),
                path: path.into_os_string().into_string().unwrap(),
            }
        }
        fn invoke(mode: &str) -> Command {
            let mut c = Command::new(std::env::current_exe().unwrap());
            c.arg("--exact")
                .arg(FIXTURE)
                .arg("--nocapture")
                .arg("--test-threads=1")
                .env("CAWS_HOST_TEST_MODE", mode)
                .stdin(Stdio::null());
            c
        }
        fn deadline() -> MonotonicDeadline {
            MonotonicDeadline::capture(Duration::from_secs(30)).unwrap()
        }
        fn observe_peer(stream: &UnixStream) -> io::Result<libc::pid_t> {
            let mut uid = 0;
            let mut gid = 0;
            if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
                || uid != unsafe { libc::geteuid() }
            {
                return Err(refused());
            }
            let mut pid: libc::pid_t = 0;
            let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_LOCAL,
                    libc::LOCAL_PEERPID,
                    (&mut pid as *mut libc::pid_t).cast(),
                    &mut len,
                )
            } != 0
                || len as usize != std::mem::size_of_val(&pid)
                || pid <= 1
            {
                return Err(refused());
            }
            Ok(pid)
        }
        #[test]
        fn isolated_fixture() {
            let Ok(mode) = std::env::var("CAWS_HOST_TEST_MODE") else {
                return;
            };
            match mode.as_str() {
                "host-child" => {
                    let deadline = deadline();
                    let config = self_image();
                    let mut context =
                        HostContext::capture(&config, &deadline).expect("direct parent attested");
                    assert_eq!(context.pid(), unsafe { libc::getppid() } as u32);
                    assert!(context.birth().0 > 0);
                    assert_eq!(context.executable(), Path::new(&config.path));
                    context.revalidate(&deadline).unwrap();
                    context.process.microseconds = (context.process.microseconds + 1) % 1_000_000;
                    assert!(
                        context.revalidate(&deadline).is_err(),
                        "birth mismatch must refuse"
                    );
                    context.process = process_instance(context.pid()).unwrap();
                    context.path = PathBuf::from("/not/the/configured/host");
                    assert!(
                        context.revalidate(&deadline).is_err(),
                        "path mismatch must refuse"
                    );
                    let mut wrong = self_image();
                    wrong.sha256 = "0".repeat(64);
                    assert!(
                        HostContext::capture(&wrong, &deadline).is_err(),
                        "wrong hash must refuse"
                    );
                    wrong = self_image();
                    wrong.path = "/bin/sh".into();
                    assert!(
                        HostContext::capture(&wrong, &deadline).is_err(),
                        "wrong path must refuse"
                    );
                }
                "peer-parent" => {
                    let (local, remote) = UnixStream::pair().unwrap();
                    let expected = std::process::id();
                    let mut c = invoke("peer-child");
                    c.env("CAWS_HOST_TEST_EXPECTED_PID", expected.to_string());
                    configure_private_child(&mut c).unwrap();
                    configure_child_fds(&mut c, &[(remote.as_fd(), 3)]).unwrap();
                    let output = c.output().unwrap();
                    drop(c);
                    drop(remote);
                    drop(local);
                    assert!(
                        output.status.success(),
                        "stdout={} stderr={}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                    println!("{}", String::from_utf8_lossy(&output.stdout));
                }
                "peer-child" => {
                    let stream = unsafe { UnixStream::from_raw_fd(3) };
                    let expected: i32 = std::env::var("CAWS_HOST_TEST_EXPECTED_PID")
                        .unwrap()
                        .parse()
                        .unwrap();
                    let actual = observe_peer(&stream)
                        .expect("LOCAL_PEERPID available on inherited socketpair");
                    let pin = self_image();
                    let bound = deadline();
                    let mut peer = ProducerPeer::capture(stream.as_fd(), &pin, &bound).unwrap();
                    peer.revalidate(stream.as_fd(), &pin, &bound).unwrap();
                    peer.process.microseconds = (peer.process.microseconds + 1) % 1_000_000;
                    assert!(peer.revalidate(stream.as_fd(), &pin, &bound).is_err());
                    let wrong = ProgramImage {
                        path: pin.path,
                        sha256: "0".repeat(64),
                    };
                    assert!(ProducerPeer::capture(stream.as_fd(), &wrong, &bound).is_err());
                    println!("observed LOCAL_PEERPID={actual}, creator={expected}");
                    assert_eq!(
                        actual, expected,
                        "Darwin inherited socketpair peer PID differs from creator"
                    );
                }
                "orphan-parent" => {
                    let (mut local, remote) = UnixStream::pair().unwrap();
                    let mut command = invoke("orphan-child");
                    command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
                    configure_private_child(&mut command).unwrap();
                    configure_child_fds(&mut command, &[(remote.as_fd(), 3)]).unwrap();
                    let _child = command.spawn().unwrap();
                    drop(command);
                    drop(remote);
                    local
                        .set_read_timeout(Some(Duration::from_secs(10)))
                        .unwrap();
                    let mut ready = [0];
                    local.read_exact(&mut ready).unwrap();
                    assert_eq!(ready, *b"R");
                    std::process::exit(0);
                }
                "orphan-child" => {
                    let mut stream = unsafe { UnixStream::from_raw_fd(3) };
                    let deadline = deadline();
                    let ctx = HostContext::capture(&self_image(), &deadline).unwrap();
                    stream.write_all(b"R").unwrap();
                    let timeout = Instant::now() + Duration::from_secs(10);
                    while unsafe { libc::getppid() } as u32 == ctx.pid() && Instant::now() < timeout
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    assert_ne!(
                        unsafe { libc::getppid() } as u32,
                        ctx.pid(),
                        "intermediate parent must exit"
                    );
                    assert!(
                        ctx.revalidate(&deadline).is_err(),
                        "lost parent must refuse"
                    );
                    println!("ORPHAN_REFUSED");
                }
                _ => panic!("invalid fixture mode"),
            }
        }
        #[test]
        fn child_checks_real_parent_and_hostile_identity_changes() {
            let output = invoke("host-child").output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[test]
        fn inherited_socketpair_reports_kernel_peer_pid() {
            let output = invoke("peer-parent").output().unwrap();
            assert!(
                output.status.success(),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let observed = String::from_utf8_lossy(&output.stdout);
            assert!(observed.contains("observed LOCAL_PEERPID="));
            println!("{observed}");
        }
        #[test]
        fn lost_real_parent_is_refused() {
            let output = invoke("orphan-parent").output().unwrap();
            assert!(output.status.success());
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("ORPHAN_REFUSED"),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
#[cfg(target_os = "macos")]
pub(crate) use macos::{HostContext, ProducerPeer};
#[cfg(not(target_os = "macos"))]
pub(crate) struct ProducerPeer {
    never: std::convert::Infallible,
}
#[cfg(not(target_os = "macos"))]
impl ProducerPeer {
    pub(crate) fn pid(&self) -> u32 {
        match self.never {}
    }
    pub(crate) fn birth(&self) -> (u64, u64) {
        match self.never {}
    }
    pub(crate) fn capture(
        _: std::os::fd::BorrowedFd<'_>,
        _: &ProgramImage,
        _: &MonotonicDeadline,
    ) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "producer peer unsupported platform",
        ))
    }
    pub(crate) fn revalidate(
        &self,
        _: std::os::fd::BorrowedFd<'_>,
        _: &ProgramImage,
        _: &MonotonicDeadline,
    ) -> io::Result<()> {
        match self.never {}
    }
}
#[cfg(not(target_os = "macos"))]
pub(crate) struct HostContext {
    never: std::convert::Infallible,
}
#[cfg(not(target_os = "macos"))]
impl HostContext {
    pub(crate) fn capture(_: &ProgramImage, _: &MonotonicDeadline) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "host attestation unsupported platform",
        ))
    }
    pub(crate) fn revalidate(&self, _: &MonotonicDeadline) -> io::Result<()> {
        match self.never {}
    }
    pub(crate) fn pid(&self) -> u32 {
        match self.never {}
    }
    pub(crate) fn birth(&self) -> (u64, u64) {
        match self.never {}
    }
    pub(crate) fn executable(&self) -> &Path {
        match self.never {}
    }
}
