//! Direct child descriptor transport. Sources remain owned by the Command.
//!
//! This only establishes descriptor identity. It does not authorize an executable
//! or give a child access to any descriptor that its caller did not provide.

use std::io;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::Command;

/// Prevent inherited nonstdio descriptors from crossing this child's exec.
/// Enumerate before spawn, then set FD_CLOEXEC only in the child; do not close
/// descriptors, including any Command-internal exec-error pipe that reuses a
/// snapshotted number. The parent descriptor flags are unchanged.
///
/// The caller must keep the descriptor table quiescent from enumeration through
/// fork: no concurrent opens or close/reuse except newly-created CLOEXEC fds
/// (including Rust's own spawn pipes). Call this before configure_child_fds;
/// that later callback explicitly clears CLOEXEC for its mapped targets.
/// A failed /dev/fd enumeration is an error, never an empty allow-all result.
pub(crate) fn configure_private_child(command: &mut Command) -> io::Result<()> {
    let mut descriptors = Vec::new();
    for entry in std::fs::read_dir("/dev/fd")? {
        let entry = entry?;
        let name = entry.file_name();
        let fd: RawFd = name
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "non-UTF8 descriptor name"))?
            .parse()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid descriptor name"))?;
        if fd >= 3 {
            descriptors.push(fd);
        }
    }
    descriptors.sort_unstable();
    descriptors.dedup();
    // SAFETY: child callback uses only async-signal-safe fcntl operations.
    unsafe {
        command.pre_exec(move || {
            for &fd in &descriptors {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags < 0 {
                    let e = io::Error::last_os_error();
                    if e.raw_os_error() == Some(libc::EBADF) {
                        continue;
                    }
                    return Err(e);
                }
                if flags & libc::FD_CLOEXEC == 0
                    && libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0
                {
                    let e = io::Error::last_os_error();
                    if e.raw_os_error() != Some(libc::EBADF) {
                        return Err(e);
                    }
                }
            }
            Ok(())
        });
    }
    Ok(())
}

/// Duplicate sources before installing a child-only mapping. Targets must be
/// unique, in 3..=522 (the v3 source-binding role range). The duplicates are closed when the command is dropped,
/// including on partial configuration or spawn failure. The original sources
/// are never closed or modified by this function.
///
/// Vacant targets are reserved until Command drop, so its private exec-error
/// channel cannot occupy them. Callers must keep already-occupied targets open
/// until spawn completes and prevent concurrent closure/reuse during setup. The
/// function never replaces or closes any caller-owned descriptor.
pub(crate) fn configure_child_fds(
    command: &mut Command,
    mappings: &[(BorrowedFd<'_>, RawFd)],
) -> io::Result<()> {
    let mut seen = [false; 523];
    for &(_, target) in mappings {
        if !(3..=522).contains(&target) || seen[target as usize] {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid or duplicate child fd target",
            ));
        }
        seen[target as usize] = true;
    }
    // Duplicates must lie above every possible target: otherwise a later
    // dup2 in a mapping cycle could overwrite a still-needed source.
    let duplicate_floor = mappings
        .iter()
        .map(|(_, target)| *target)
        .max()
        .unwrap_or(63)
        .max(63)
        + 1;
    let mut owned = Vec::with_capacity(mappings.len());
    for &(source, target) in mappings {
        let duplicate =
            unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD_CLOEXEC, duplicate_floor) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: F_DUPFD_CLOEXEC returned a fresh owned descriptor.
        owned.push((unsafe { OwnedFd::from_raw_fd(duplicate) }, target));
    }
    // Reserve only vacant target numbers, without dup2 in the parent. The
    // first free number >= target is target exactly if it was vacant. Keep
    // those reservations in the closure along with the source duplicates.
    let mut reservations = Vec::with_capacity(mappings.len());
    for &(_, target) in mappings {
        let reservation =
            unsafe { libc::fcntl(owned[0].0.as_raw_fd(), libc::F_DUPFD_CLOEXEC, target) };
        if reservation < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fcntl returned a fresh descriptor, even if above target.
        let reservation = unsafe { OwnedFd::from_raw_fd(reservation) };
        if reservation.as_raw_fd() == target {
            reservations.push(reservation);
        }
    }
    // SAFETY: the closure only calls async-signal-safe syscalls and does not
    // allocate, acquire locks, or access mutable shared state after fork.
    unsafe {
        command.pre_exec(move || {
            let _keep_reservations_alive = &reservations;
            for (source, target) in &owned {
                if libc::dup2(source.as_raw_fd(), *target) < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::fcntl(*target, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::fd::{AsFd, FromRawFd};
    use std::os::unix::net::UnixStream;
    use std::process::Stdio;

    // Run every descriptor-manipulating case in its own process: fd 3 belongs
    // to the test harness or its parent and must never be overwritten there.
    fn fixture(mode: &str) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.arg("--exact")
            .arg("execution_fd_transport::tests::isolated_fixture")
            .arg("--nocapture")
            .env("CAWS_FD_FIXTURE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    fn stat(fd: RawFd) -> (u64, u64) {
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        assert_eq!(unsafe { libc::fstat(fd, st.as_mut_ptr()) }, 0);
        let st = unsafe { st.assume_init() };
        (st.st_dev as u64, st.st_ino as u64)
    }

    fn occupy(fd: RawFd, source: RawFd) {
        assert_eq!(unsafe { libc::dup2(source, fd) }, fd);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }

    fn open_high() -> Vec<RawFd> {
        (64..512)
            .filter(|&fd| unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0)
            .collect()
    }

    #[test]
    fn isolated_fixture() {
        let Ok(mode) = std::env::var("CAWS_FD_FIXTURE") else {
            return;
        };
        if mode == "high_probe" {
            let expected_521 = std::env::var("CAWS_EXPECT_521").unwrap();
            let expected_522 = std::env::var("CAWS_EXPECT_522").unwrap();
            let (dev, ino) = stat(521);
            assert_eq!(format!("{dev}:{ino}"), expected_521);
            let (dev, ino) = stat(522);
            assert_eq!(format!("{dev}:{ino}"), expected_522);
            return;
        }
        if mode == "high_parent" {
            let a = std::fs::File::open("/dev/null").unwrap();
            let b = std::fs::File::open("/dev/zero").unwrap();
            occupy(521, a.as_raw_fd());
            occupy(522, b.as_raw_fd());
            let a_identity = stat(521);
            let b_identity = stat(522);
            // SAFETY: both occupied descriptors stay open until command drop.
            let a_fd = unsafe { BorrowedFd::borrow_raw(521) };
            let b_fd = unsafe { BorrowedFd::borrow_raw(522) };
            let mut cmd = fixture("high_probe");
            cmd.env(
                "CAWS_EXPECT_521",
                format!("{}:{}", b_identity.0, b_identity.1),
            );
            cmd.env(
                "CAWS_EXPECT_522",
                format!("{}:{}", a_identity.0, a_identity.1),
            );
            configure_private_child(&mut cmd).unwrap();
            configure_child_fds(&mut cmd, &[(a_fd, 522), (b_fd, 521)]).unwrap();
            let out = cmd.output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(stat(521), a_identity);
            assert_eq!(stat(522), b_identity);
            let mut invalid = Command::new("/bin/true");
            assert_eq!(
                configure_child_fds(&mut invalid, &[(a_fd, 523)])
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
            assert_eq!(
                configure_child_fds(&mut invalid, &[(a_fd, 522), (b_fd, 522)])
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
            return;
        }
        if mode == "hygiene_probe" {
            let fd: RawFd = std::env::var("CAWS_HYGIENE_FD").unwrap().parse().unwrap();
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
            eprintln!("stderr-preserved");
            return;
        }
        if mode == "hygiene_parent" {
            let source = std::fs::File::open("/dev/null").unwrap();
            let fd = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 400) };
            assert!(fd >= 400);
            let sentinel = unsafe { OwnedFd::from_raw_fd(fd) };
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, 0) }, 0);
            let mut cmd = fixture("hygiene_probe");
            cmd.env("CAWS_HYGIENE_FD", fd.to_string());
            configure_private_child(&mut cmd).unwrap();
            let out = cmd.output().unwrap();
            assert!(
                out.status.success(),
                "stdout: {} stderr: {}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(String::from_utf8_lossy(&out.stderr).contains("stderr-preserved"));
            assert_eq!(
                unsafe { libc::fcntl(sentinel.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
            // Snapshot may include a directory fd that is closed before spawn;
            // it can be reused by Command's private exec-error pipe.
            let mut missing = Command::new("/this/caws-fd-test-executable-does-not-exist");
            configure_private_child(&mut missing).unwrap();
            assert_eq!(
                missing.spawn().unwrap_err().raw_os_error(),
                Some(libc::ENOENT)
            );
            let mut fail = Command::new("/bin/true");
            configure_private_child(&mut fail).unwrap();
            unsafe {
                fail.pre_exec(|| Err(io::Error::from_raw_os_error(libc::EACCES)));
            }
            assert_eq!(fail.spawn().unwrap_err().raw_os_error(), Some(libc::EACCES));
            return;
        }
        if mode == "probe4" {
            let expected = std::env::var("CAWS_FD_ID").unwrap();
            let (dev, ino) = stat(4);
            assert_eq!(format!("{dev}:{ino}"), expected);
            assert_eq!(
                unsafe { libc::fcntl(4, libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
            return;
        }
        if mode == "vacant4" {
            use std::os::fd::IntoRawFd;
            let raw = std::fs::File::open("/dev/null").unwrap().into_raw_fd();
            let saved = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 64) };
            assert!(saved >= 64);
            let saved = unsafe { OwnedFd::from_raw_fd(saved) };
            unsafe {
                libc::close(raw);
                if raw != 4 {
                    libc::close(4);
                }
            }
            let before = open_high();
            let identity = stat(saved.as_raw_fd());
            let mut cmd = fixture("probe4");
            cmd.env("CAWS_FD_ID", format!("{}:{}", identity.0, identity.1));
            configure_private_child(&mut cmd).unwrap();
            configure_child_fds(&mut cmd, &[(saved.as_fd(), 4)]).unwrap();
            let out = cmd.output().unwrap();
            assert!(
                out.status.success(),
                "stdout: {} stderr: {}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            drop(cmd);
            assert_eq!(unsafe { libc::fcntl(4, libc::F_GETFD) }, -1);
            let mut fail = Command::new("/bin/true");
            configure_private_child(&mut fail).unwrap();
            configure_child_fds(&mut fail, &[(saved.as_fd(), 4)]).unwrap();
            unsafe {
                fail.pre_exec(|| Err(io::Error::from_raw_os_error(libc::EACCES)));
            }
            assert_eq!(fail.spawn().unwrap_err().raw_os_error(), Some(libc::EACCES));
            drop(fail);
            assert_eq!(unsafe { libc::fcntl(4, libc::F_GETFD) }, -1);
            let mut missing = Command::new("/this/caws-fd-test-executable-does-not-exist");
            configure_private_child(&mut missing).unwrap();
            configure_child_fds(&mut missing, &[(saved.as_fd(), 4)]).unwrap();
            assert_eq!(
                missing.spawn().unwrap_err().raw_os_error(),
                Some(libc::ENOENT)
            );
            drop(missing);
            assert_eq!(unsafe { libc::fcntl(4, libc::F_GETFD) }, -1);
            assert_eq!(open_high(), before);
            return;
        }
        if mode == "probe" {
            let expected = std::env::var("CAWS_FD_ID").unwrap();
            let (dev, ino) = stat(3);
            assert_eq!(format!("{dev}:{ino}"), expected);
            assert_eq!(
                unsafe { libc::fcntl(3, libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
            // The unrelated descriptor is CLOEXEC and must not cross exec.
            let unrelated: RawFd = std::env::var("CAWS_UNRELATED_FD").unwrap().parse().unwrap();
            assert_eq!(unsafe { libc::fcntl(unrelated, libc::F_GETFD) }, -1);
            let mut f = unsafe { std::fs::File::from_raw_fd(3) };
            let mut b = [0; 4];
            f.read_exact(&mut b).unwrap();
            assert_eq!(&b, b"test");
            return;
        }
        assert_eq!(mode, "parent");
        let initial = std::fs::File::open("/dev/null").unwrap();
        occupy(3, initial.as_raw_fd());
        let (mut parent, child) = UnixStream::pair().unwrap();
        let (mut sentinel_peer, sentinel) = UnixStream::pair().unwrap();
        // Protect source handles if they happen to occupy fd 3.
        let saved = unsafe { libc::fcntl(child.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        assert!(saved >= 64);
        let saved = unsafe { OwnedFd::from_raw_fd(saved) };
        let sentinel_copy = unsafe { libc::fcntl(sentinel.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        assert!(sentinel_copy >= 64);
        let sentinel_copy = unsafe { OwnedFd::from_raw_fd(sentinel_copy) };
        occupy(3, sentinel_copy.as_raw_fd());
        let sentinel_identity = stat(3);
        let identity = stat(saved.as_raw_fd());
        let unrelated = unsafe { libc::fcntl(saved.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 400) };
        assert!(unrelated >= 400);
        let unrelated = unsafe { OwnedFd::from_raw_fd(unrelated) };
        assert_eq!(
            unsafe { libc::fcntl(unrelated.as_raw_fd(), libc::F_SETFD, 0) },
            0
        );
        let before = open_high();
        let mut cmd = fixture("probe");
        cmd.env("CAWS_FD_ID", format!("{}:{}", identity.0, identity.1))
            .env("CAWS_UNRELATED_FD", unrelated.as_raw_fd().to_string());
        configure_private_child(&mut cmd).unwrap();
        configure_child_fds(&mut cmd, &[(saved.as_fd(), 3)]).unwrap();
        parent.write_all(b"test").unwrap();
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(stat(3), sentinel_identity);
        assert_eq!(
            unsafe { libc::fcntl(unrelated.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        sentinel_peer.write_all(b"x").unwrap();
        let mut b = [0];
        assert_eq!(unsafe { libc::read(3, b.as_mut_ptr().cast(), 1) }, 1);
        assert_eq!(b, *b"x");
        drop(cmd);
        assert_eq!(open_high(), before);

        let mut invalid = fixture("probe");
        assert_eq!(
            configure_child_fds(&mut invalid, &[(saved.as_fd(), 2)])
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            configure_child_fds(&mut invalid, &[(saved.as_fd(), 3), (saved.as_fd(), 3)])
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            configure_child_fds(&mut invalid, &[(saved.as_fd(), -1)])
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        // Exercise a vacant target and verify the reservation survives spawn.
        // The fixture is isolated, so closing an inherited descriptor is safe.
        unsafe {
            libc::close(32);
        }
        let mut vacant = Command::new("/bin/true");
        configure_child_fds(&mut vacant, &[(saved.as_fd(), 32)]).unwrap();
        assert!(unsafe { libc::fcntl(32, libc::F_GETFD) } >= 0);
        unsafe {
            vacant.pre_exec(|| Err(io::Error::from_raw_os_error(libc::EACCES)));
        }
        assert_eq!(
            vacant.spawn().unwrap_err().raw_os_error(),
            Some(libc::EACCES)
        );
        drop(vacant);
        assert_eq!(unsafe { libc::fcntl(32, libc::F_GETFD) }, -1);
        assert_eq!(open_high(), before);

        let mut missing = Command::new("/this/caws-fd-test-executable-does-not-exist");
        configure_child_fds(&mut missing, &[(saved.as_fd(), 3)]).unwrap();
        assert!(missing.spawn().is_err());
        drop(missing);
        assert_eq!(open_high(), before);

        let mut fail = Command::new("/bin/true");
        configure_child_fds(&mut fail, &[(saved.as_fd(), 3)]).unwrap();
        unsafe {
            fail.pre_exec(|| Err(io::Error::from_raw_os_error(libc::EACCES)));
        }
        assert_eq!(fail.spawn().unwrap_err().raw_os_error(), Some(libc::EACCES));
        drop(fail);
        assert_eq!(open_high(), before);
    }

    #[test]
    fn direct_child_identity_collision_and_cleanup() {
        let output = fixture("parent").output().unwrap();
        assert!(
            output.status.success(),
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn vacant_fd4_identity_and_spawn_errors() {
        let out = fixture("vacant4").output().unwrap();
        assert!(
            out.status.success(),
            "stdout: {} stderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn inherited_non_cloexec_is_private_and_spawn_errors_survive() {
        let out = fixture("hygiene_parent").output().unwrap();
        assert!(
            out.status.success(),
            "stdout: {} stderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn formatter_transport_high_targets_preserve_cycles_and_refuse_523() {
        let out = fixture("high_parent").output().unwrap();
        assert!(
            out.status.success(),
            "stdout: {} stderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
