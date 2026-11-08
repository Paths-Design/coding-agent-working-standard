//! Live file-Git admission, not a published expected-distribution profile.
//! Apple signing/loader/trust services are TCB. Protected-path checks and pins
//! detect replacement; this is not atomic descriptor-bound exec attestation.
use super::super::{NATIVE_FILE_GIT_PATH, NATIVE_FILE_GIT_POLICY as POLICY};
use super::{Pinned, QueryReceipt, project};
use crate::context_git::apple_signature;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    time::Instant,
};

const GIT: &str = "identifier \"com.apple.git\" and anchor apple";
pub(super) fn validate_environment(env: &BTreeMap<String, String>) -> Result<(), String> {
    if env.iter().any(|(key, value)| {
        !value.is_empty()
            && (["DEVELOPER_DIR", "TOOLCHAINS", "SDKROOT"].contains(&key.as_str())
                || key.starts_with("DYLD_")
                || key.starts_with("LD_"))
    }) {
        return Err("unsupported original developer or loader environment".into());
    }
    Ok(())
}
fn check(until: Instant, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    if cancelled() || Instant::now() >= until {
        return Err("native system Git cancelled or expired".into());
    }
    Ok(())
}
fn no_acl(fd: libc::c_int) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }
        let acl = unsafe { acl_get_fd_np(fd, 0x100) };
        if !acl.is_null() {
            unsafe {
                acl_free(acl);
            }
            return Err("native system Git path has unsupported ACL protection".into());
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
            return Err("native system Git ACL observation failed".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = fd;
        Err("native system Git requires macOS path protection".into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Protected {
    path: PathBuf,
    directory: bool,
    device: u64,
    inode: u64,
    bytes: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}
impl Protected {
    fn of(path: &Path, directory: bool, m: &fs::Metadata) -> Self {
        Self {
            path: path.into(),
            directory,
            device: m.dev(),
            inode: m.ino(),
            bytes: m.len(),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            modified_seconds: m.mtime(),
            modified_nanoseconds: m.mtime_nsec(),
            changed_seconds: m.ctime(),
            changed_nanoseconds: m.ctime_nsec(),
        }
    }
    fn capture(
        path: &Path,
        directory: bool,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Self, String> {
        check(until, cancelled)?;
        let text = path.to_str().ok_or("non-UTF8 protected platform path")?;
        if !path.is_absolute()
            || text.len() > 4096
            || text.chars().any(char::is_control)
            || (text != "/"
                && text
                    .split('/')
                    .skip(1)
                    .any(|part| part.is_empty() || part == "." || part == ".."))
            || fs::canonicalize(path).map_err(|error| error.to_string())? != path
        {
            return Err("unsupported protected platform path spelling".into());
        }
        let named = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if named.file_type().is_symlink()
            || (directory && !named.is_dir())
            || (!directory && !named.is_file())
            || named.uid() != 0
            || named.mode() & 0o6022 != 0
        {
            return Err(format!(
                "native system Git path is not root-owned protected content: {}; uid={} mode={:o}",
                path.display(),
                named.uid(),
                named.mode() & 0o7777
            ));
        }
        let handle = OpenOptions::new()
            .read(true)
            .custom_flags(
                libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | if directory { libc::O_DIRECTORY } else { 0 },
            )
            .open(path)
            .map_err(|error| error.to_string())?;
        no_acl(handle.as_raw_fd())?;
        let held = Self::of(
            path,
            directory,
            &handle.metadata().map_err(|e| e.to_string())?,
        );
        let before = Self::of(path, directory, &named);
        let after = Self::of(
            path,
            directory,
            &fs::symlink_metadata(path).map_err(|e| e.to_string())?,
        );
        if before != held || held != after {
            return Err("protected platform path changed while observed".into());
        }
        check(until, cancelled)?;
        Ok(held)
    }
}
fn tree(
    path: &Path,
    directory: bool,
    until: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<Protected>, String> {
    let paths: Vec<_> = path.ancestors().collect();
    if paths.len() > 32 {
        return Err("platform path exceeds supported protection depth".into());
    }
    paths
        .into_iter()
        .rev()
        .map(|part| Protected::capture(part, part != path || directory, until, cancelled))
        .collect()
}
fn image(
    path: &Path,
    requirement: &str,
    until: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Pinned, Vec<Protected>), String> {
    check(until, cancelled)?;
    let selected = project::pin_executable(path, until, cancelled).map_err(|e| e.to_string())?;
    if selected.path != selected.physical_path {
        return Err("native system Git tool uses an unsupported alias".into());
    }
    let protection = tree(path, false, until, cancelled)?;
    apple_signature::authenticate(&selected.physical_path, requirement)?;
    check(until, cancelled)?;
    project::verify_executable(
        &selected,
        project::ProjectPhase::AfterLaunch,
        until,
        cancelled,
    )
    .map_err(|e| e.to_string())?;
    Ok((Pinned::capture(&selected), protection))
}

/// Fresh native-owned facts for one fixed protected Command Line Tools image.
/// No caller PATH, developer selection, resolver process, or serialized engine
/// observation can choose the implementation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Facts {
    policy: String,
    executor_sha256: String,
    pub(super) implementation: Pinned,
    protected: Vec<Protected>,
}
impl Facts {
    pub(super) fn validate(
        &self,
        executor: &Pinned,
        queries: &[QueryReceipt],
    ) -> Result<(), String> {
        if self.policy != POLICY
            || self.executor_sha256 != executor.sha256
            || self.implementation.path != Path::new(NATIVE_FILE_GIT_PATH)
            || self.implementation.path != self.implementation.physical_path
            || !self.implementation.valid()
            || !queries.is_empty()
        {
            return Err("invalid native Command Line Tools Git observation binding".into());
        }
        let mut expected: Vec<_> = self.implementation.path.ancestors().collect();
        expected.reverse();
        if expected.len() > 32
            || expected.len() != self.protected.len()
            || expected.iter().zip(&self.protected).any(|(path, actual)| {
                *path != actual.path.as_path()
                    || actual.directory != (*path != self.implementation.path.as_path())
                    || actual.uid != 0
                    || actual.mode & 0o6022 != 0
            })
        {
            return Err("incomplete protected Command Line Tools path observation".into());
        }
        Ok(())
    }
    pub(super) fn verify(
        &self,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        for expected in &self.protected {
            if Protected::capture(&expected.path, expected.directory, until, cancelled)?
                != *expected
            {
                return Err("admitted platform path identity changed".into());
            }
        }
        project::verify_executable(
            &self.implementation.selected(),
            project::ProjectPhase::BeforeLaunch,
            until,
            cancelled,
        )
        .map_err(|e| e.to_string())?;
        check(until, cancelled)
    }
}

/// A fixed supported platform profile, not an ambient default-toolchain lookup.
/// Xcode-only installations without this protected CLT image refuse explicitly.
pub(super) fn admit(
    original_environment: &BTreeMap<String, String>,
    executor: &Pinned,
    until: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<Facts, String> {
    validate_environment(original_environment)?;
    if !cfg!(target_os = "macos") {
        return Err("native Command Line Tools Git requires macOS".into());
    }
    let (implementation, protected) =
        image(Path::new(NATIVE_FILE_GIT_PATH), GIT, until, cancelled)?;
    let facts = Facts {
        policy: POLICY.into(),
        executor_sha256: executor.sha256.clone(),
        implementation,
        protected,
    };
    facts.validate(executor, &[])?;
    facts.verify(until, cancelled)?;
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn executor(until: Instant) -> Pinned {
        let path = std::env::current_exe().unwrap().canonicalize().unwrap();
        Pinned::capture(&project::pin_executable(&path, until, &|| false).unwrap())
    }
    #[test]
    fn developer_and_loader_controls_refuse_before_any_tool_query() {
        // Negative-only configuration data; this is not a live admission.
        let executor = Pinned {
            path: "/not-a-native-executor".into(),
            physical_path: "/not-a-native-executor".into(),
            sha256: "a".repeat(64),
            device: 0,
            inode: 0,
            bytes: 0,
            mode: 0,
            modified_seconds: 0,
            modified_nanoseconds: 0,
            changed_seconds: 0,
            changed_nanoseconds: 0,
        };
        for key in [
            "DEVELOPER_DIR",
            "TOOLCHAINS",
            "SDKROOT",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_FUTURE_SELECTOR",
            "LD_PRELOAD",
            "LD_FUTURE_SELECTOR",
        ] {
            let env = BTreeMap::from([(key.into(), "/untrusted".into())]);
            let error = admit(
                &env,
                &executor,
                Instant::now() + std::time::Duration::from_secs(2),
                &|| false,
            )
            .unwrap_err();
            assert!(
                error.contains("unsupported original developer or loader environment"),
                "{key}"
            );
        }
        assert!(
            validate_environment(&BTreeMap::from([
                ("PATH".into(), "/untrusted".into()),
                ("CAWS_GIT_BINARY".into(), "/untrusted/git".into()),
            ]))
            .is_ok(),
            "caller selections are ignored, never used to choose an image"
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn fixed_protected_image_is_admitted_without_a_resolver_or_caller_selection() {
        let until = Instant::now() + std::time::Duration::from_secs(3);
        let executor = executor(until);
        let env = BTreeMap::from([
            ("PATH".into(), "/untrusted".into()),
            ("CAWS_GIT_BINARY".into(), "/untrusted/git".into()),
        ]);
        let facts = admit(&env, &executor, until, &|| false).unwrap();
        assert_eq!(facts.implementation.path, Path::new(NATIVE_FILE_GIT_PATH));
        facts.validate(&executor, &[]).unwrap();
        facts.verify(until, &|| false).unwrap();
        let mut wrong = facts.clone();
        wrong.implementation.path = "/usr/bin/git".into();
        assert!(wrong.validate(&executor, &[]).is_err());
        let mut missing = facts.clone();
        missing.protected.pop();
        assert!(missing.validate(&executor, &[]).is_err());
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn unrelated_signed_program_is_not_git_and_signed_copy_is_not_protected() {
        let until = Instant::now() + std::time::Duration::from_secs(3);
        let error = image(Path::new("/usr/bin/true"), GIT, until, &|| false).unwrap_err();
        assert!(
            error.contains("Apple signature requirement refused"),
            "{error}"
        );
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "caws-signed-copy-{}-{}",
            std::process::id(),
            crate::context_git::monotonic_ns()
        ));
        fs::create_dir(&root).unwrap();
        let copy = root.join("git");
        fs::copy(NATIVE_FILE_GIT_PATH, &copy).unwrap();
        apple_signature::authenticate(&copy, GIT).unwrap();
        assert!(tree(&copy, false, until, &|| false).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn retained_protected_identity_cannot_be_changed_to_another_inode() {
        let until = Instant::now() + std::time::Duration::from_secs(3);
        let executor = executor(until);
        let facts = admit(&BTreeMap::new(), &executor, until, &|| false).unwrap();
        facts.verify(until, &|| false).unwrap();
        let mut invalid = facts;
        invalid.protected.last_mut().unwrap().inode ^= 1;
        invalid.validate(&executor, &[]).unwrap();
        assert!(invalid.verify(until, &|| false).is_err());
    }
}
