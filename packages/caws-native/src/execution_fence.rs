//! Cooperative lifecycle fence for the direct execution worker.
//!
//! This protocol assumes the canonical directory and lock pathname are not
//! maliciously exchanged by an external actor. Identity checks and unlink are
//! not atomic. Existing locks are always refused; no stale recovery is done.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Darwin O_NOFOLLOW. create_new uses O_CREAT | O_EXCL; a preexisting
    // symlink is never followed even without this additional defense.
    const O_NOFOLLOW: i32 = 0x0000_0100;

    fn invalid() -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "execution fence identity changed",
        )
    }

    fn iso_utc(now: SystemTime) -> io::Result<String> {
        let elapsed = now.duration_since(UNIX_EPOCH).map_err(|_| invalid())?;
        let secs = elapsed.as_secs();
        let days = i64::try_from(secs / 86_400).map_err(|_| invalid())?;
        // Proleptic Gregorian date from days since 1970-01-01.
        let z = days.checked_add(719_468).ok_or_else(invalid)?;
        let era = z / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let mut year = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = mp + if mp < 10 { 3 } else { -9 };
        year += i64::from(month <= 2);
        if !(1970..=9999).contains(&year) {
            return Err(invalid());
        }
        let day_secs = secs % 86_400;
        Ok(format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
            day_secs / 3600,
            (day_secs % 3600) / 60,
            day_secs % 60,
            elapsed.subsec_millis()
        ))
    }

    fn nonce() -> io::Result<String> {
        let mut random = [0u8; 32];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let mut result = String::with_capacity(64);
        use std::fmt::Write as _;
        for byte in random {
            write!(&mut result, "{byte:02x}").map_err(|_| invalid())?;
        }
        Ok(result)
    }

    fn same(meta: &fs::Metadata, dev: u64, ino: u64) -> bool {
        meta.file_type().is_file() && meta.nlink() == 1 && meta.dev() == dev && meta.ino() == ino
    }

    /// Private handle: retaining the descriptor prevents inode reuse until release.
    pub(crate) struct ExecutionFence {
        path: PathBuf,
        file: File,
        dev: u64,
        ino: u64,
        nonce: String,
        expected: Option<Vec<u8>>,
        armed: bool,
    }

    impl ExecutionFence {
        pub(crate) fn acquire(caws_dir: &Path) -> io::Result<Self> {
            Self::acquire_with(caws_dir, |file, bytes| {
                file.write_all(bytes)?;
                file.sync_all()
            })
        }

        // The writer seam also verifies cleanup after a partial initialization.
        fn acquire_with<F>(caws_dir: &Path, writer: F) -> io::Result<Self>
        where
            F: FnOnce(&mut File, &[u8]) -> io::Result<()>,
        {
            if !caws_dir.is_absolute()
                || fs::canonicalize(caws_dir)? != caws_dir
                || !fs::metadata(caws_dir)?.is_dir()
            {
                return Err(invalid());
            }
            let nonce = nonce()?;
            let at = iso_utc(SystemTime::now())?;
            let path = caws_dir.join("state.lock");
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(O_NOFOLLOW)
                .open(&path)?;
            let meta = file.metadata()?;
            // If fstat itself fails, ownership cannot be established and the
            // created pathname is left for operator recovery, not guessed away.
            let mut fence = Self {
                path,
                file,
                dev: meta.dev(),
                ino: meta.ino(),
                nonce,
                expected: None,
                armed: true,
            };
            if !same(&meta, fence.dev, fence.ino) {
                return Err(invalid());
            }
            let bytes = format!("{{\"pid\":{},\"at\":\"{}\",\"purpose\":\"execution-launch\",\"nonce\":\"{}\",\"protocol\":\"caws.execution.fence.v1\"}}",
                std::process::id(), at, fence.nonce).into_bytes();
            writer(&mut fence.file, &bytes)?;
            fence.expected = Some(bytes);
            fence.validate()?;
            Ok(fence)
        }

        pub(crate) fn file(&self) -> &File {
            &self.file
        }
        pub(crate) fn dev(&self) -> u64 {
            self.dev
        }
        pub(crate) fn ino(&self) -> u64 {
            self.ino
        }
        pub(crate) fn nonce(&self) -> &str {
            &self.nonce
        }

        /// Verify descriptor, pathname and exact metadata before the USER spawn.
        pub(crate) fn validate(&self) -> io::Result<()> {
            let expected = self.expected.as_ref().ok_or_else(invalid)?;
            let before = self.file.metadata()?;
            let named = fs::symlink_metadata(&self.path)?;
            if !same(&before, self.dev, self.ino)
                || !same(&named, self.dev, self.ino)
                || before.len() != expected.len() as u64
                || before.len() == 0
                || before.len() > 4096
            {
                return Err(invalid());
            }
            let mut bytes = vec![0; expected.len()];
            let mut offset = 0;
            while offset < bytes.len() {
                let count = self.file.read_at(&mut bytes[offset..], offset as u64)?;
                if count == 0 {
                    return Err(invalid());
                }
                offset += count;
            }
            let after = self.file.metadata()?;
            let final_path = fs::symlink_metadata(&self.path)?;
            if bytes != *expected
                || !same(&after, self.dev, self.ino)
                || !same(&final_path, self.dev, self.ino)
                || after.len() != before.len()
                || after.mtime() != before.mtime()
                || after.mtime_nsec() != before.mtime_nsec()
                || after.ctime() != before.ctime()
                || after.ctime_nsec() != before.ctime_nsec()
            {
                return Err(invalid());
            }
            Ok(())
        }

        fn cleanup(&self) -> io::Result<()> {
            if self.expected.is_some() {
                self.validate()?;
            } else {
                // Initialization failed: only unlink the inode created here.
                let held = self.file.metadata()?;
                let named = fs::symlink_metadata(&self.path)?;
                if !same(&held, self.dev, self.ino) || !same(&named, self.dev, self.ino) {
                    return Err(invalid());
                }
            }
            fs::remove_file(&self.path)
        }

        /// Retain the live handle after failure for the native custodian. A retry
        /// must pass the same identity/content checks; it never removes a successor.
        pub(crate) fn try_release(&mut self) -> io::Result<()> {
            if !self.armed {
                return Err(invalid());
            }
            self.cleanup()?;
            self.armed = false;
            Ok(())
        }

        /// One release attempt only, including on error; never delete a successor.
        pub(crate) fn release(mut self) -> io::Result<()> {
            self.armed = false;
            self.cleanup()
        }
    }

    impl Drop for ExecutionFence {
        fn drop(&mut self) {
            if self.armed {
                self.armed = false;
                let _ = self.cleanup();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        struct Dir(PathBuf);
        impl Dir {
            fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "caws-fence-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&path).unwrap();
                Self(fs::canonicalize(path).unwrap())
            }
            fn lock(&self) -> PathBuf {
                self.0.join("state.lock")
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn metadata_fd_identity_and_release() {
            let dir = Dir::new();
            let fence = ExecutionFence::acquire(&dir.0).unwrap();
            assert_eq!(fence.file().metadata().unwrap().ino(), fence.ino());
            assert_eq!(fs::symlink_metadata(dir.lock()).unwrap().dev(), fence.dev());
            let text = fs::read_to_string(dir.lock()).unwrap();
            assert!(text.starts_with(&format!("{{\"pid\":{},\"at\":\"", std::process::id())));
            assert!(text.contains(&format!("\"purpose\":\"execution-launch\",\"nonce\":\"{}\",\"protocol\":\"caws.execution.fence.v1\"", fence.nonce())));
            assert_eq!(fence.nonce().len(), 64);
            fence.validate().unwrap();
            fence.release().unwrap();
            assert!(!dir.lock().exists());
        }
        #[test]
        fn busy_file_and_symlink_are_never_modified() {
            let dir = Dir::new();
            fs::write(dir.lock(), b"foreign").unwrap();
            assert!(ExecutionFence::acquire(&dir.0).is_err());
            assert_eq!(fs::read(dir.lock()).unwrap(), b"foreign");
            fs::remove_file(dir.lock()).unwrap();
            let target = dir.0.join("target");
            fs::write(&target, b"target").unwrap();
            symlink(&target, dir.lock()).unwrap();
            assert!(ExecutionFence::acquire(&dir.0).is_err());
            assert!(
                fs::symlink_metadata(dir.lock())
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(fs::read(target).unwrap(), b"target");
        }
        #[test]
        fn replaced_or_modified_lock_is_not_removed() {
            for modified in [false, true] {
                let dir = Dir::new();
                let fence = ExecutionFence::acquire(&dir.0).unwrap();
                if modified {
                    fs::write(dir.lock(), b"foreign").unwrap();
                } else {
                    fs::remove_file(dir.lock()).unwrap();
                    fs::write(dir.lock(), b"foreign").unwrap();
                }
                assert!(fence.validate().is_err());
                assert!(fence.release().is_err());
                assert_eq!(fs::read(dir.lock()).unwrap(), b"foreign");
            }
        }
        #[test]
        fn drop_cleans_owned_but_preserves_replacement() {
            let dir = Dir::new();
            drop(ExecutionFence::acquire(&dir.0).unwrap());
            assert!(!dir.lock().exists());
            let fence = ExecutionFence::acquire(&dir.0).unwrap();
            fs::remove_file(dir.lock()).unwrap();
            fs::write(dir.lock(), b"successor").unwrap();
            drop(fence);
            assert_eq!(fs::read(dir.lock()).unwrap(), b"successor");
        }
        #[test]
        fn failed_release_retains_original_handle_and_refuses_successor() {
            let dir = Dir::new();
            let mut fence = ExecutionFence::acquire(&dir.0).unwrap();
            let original = dir.0.join("original");
            fs::rename(dir.lock(), &original).unwrap();
            fs::write(dir.lock(), b"successor").unwrap();
            assert!(fence.try_release().is_err());
            assert_eq!(fence.file().metadata().unwrap().ino(), fence.ino());
            assert_eq!(fs::read(dir.lock()).unwrap(), b"successor");
            // Restore our path under the test's exclusive ownership, then
            // exercise the custodian's checked retry and one-use disposition.
            fs::remove_file(dir.lock()).unwrap();
            fs::rename(original, dir.lock()).unwrap();
            fence.try_release().unwrap();
            assert!(fence.try_release().is_err());
            assert!(!dir.lock().exists());
        }
        #[test]
        fn partial_initialization_cleans_only_owned_path() {
            let dir = Dir::new();
            let result = ExecutionFence::acquire_with(&dir.0, |file, _| {
                file.write_all(b"partial")?;
                Err(io::Error::other("injected"))
            });
            assert!(result.is_err());
            assert!(!dir.lock().exists());
            let result = ExecutionFence::acquire_with(&dir.0, |file, _| {
                file.write_all(b"partial")?;
                fs::remove_file(dir.lock())?;
                fs::write(dir.lock(), b"successor")?;
                Err(io::Error::other("injected"))
            });
            assert!(result.is_err());
            assert_eq!(fs::read(dir.lock()).unwrap(), b"successor");
        }
        #[test]
        fn utc_format_pins_epoch_and_leap_boundaries() {
            assert_eq!(iso_utc(UNIX_EPOCH).unwrap(), "1970-01-01T00:00:00.000Z");
            assert_eq!(
                iso_utc(UNIX_EPOCH + std::time::Duration::from_millis(951_782_400_123)).unwrap(),
                "2000-02-29T00:00:00.123Z"
            );
            assert!(iso_utc(UNIX_EPOCH - std::time::Duration::from_secs(1)).is_err());
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use platform::ExecutionFence;

// Do not silently substitute different platform or PID namespace semantics.
#[cfg(not(target_os = "macos"))]
pub(crate) struct ExecutionFence {
    never: std::convert::Infallible,
}
#[cfg(not(target_os = "macos"))]
impl ExecutionFence {
    pub(crate) fn acquire(_: &Path) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "execution fence unsupported platform",
        ))
    }
    pub(crate) fn file(&self) -> &File {
        match self.never {}
    }
    pub(crate) fn dev(&self) -> u64 {
        match self.never {}
    }
    pub(crate) fn ino(&self) -> u64 {
        match self.never {}
    }
    pub(crate) fn nonce(&self) -> &str {
        match self.never {}
    }
    pub(crate) fn validate(&self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "execution fence unsupported platform",
        ))
    }
    pub(crate) fn release(self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "execution fence unsupported platform",
        ))
    }
    pub(crate) fn try_release(&mut self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "execution fence unsupported platform",
        ))
    }
}
