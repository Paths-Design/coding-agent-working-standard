//! Bind already-authorized source paths; this module grants no write authority.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    os::fd::{AsRawFd, RawFd},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024;
pub(crate) const SOURCE_ROOT_FD: RawFd = 10;
fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "source write binding unavailable",
    )
}

fn physical(path: &Path) -> io::Result<()> {
    let s = path.to_str().ok_or_else(denied)?;
    if !path.is_absolute()
        || s.chars().any(char::is_control)
        || (s != "/"
            && s.split('/')
                .skip(1)
                .any(|c| c.is_empty() || c == "." || c == ".."))
        || fs::canonicalize(path)? != path
    {
        return Err(denied());
    }
    for p in path.ancestors() {
        if fs::symlink_metadata(p)?.file_type().is_symlink() {
            return Err(denied());
        }
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn no_extended_acl(fd: RawFd) -> io::Result<()> {
    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, ty: libc::c_int) -> *mut libc::c_void;
        fn acl_free(p: *mut libc::c_void) -> libc::c_int;
    }
    let acl = unsafe { acl_get_fd_np(fd, 0x100) };
    if acl.is_null() {
        let e = io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::ENOENT) {
            Ok(())
        } else {
            Err(e)
        }
    } else {
        unsafe {
            acl_free(acl);
        }
        Err(denied())
    }
}
#[cfg(target_os = "linux")]
fn no_extended_acl(fd: RawFd) -> io::Result<()> {
    let result = unsafe {
        libc::fgetxattr(
            fd,
            c"system.posix_acl_access".as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) {
        Ok(())
    } else {
        Err(denied())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn no_extended_acl(_: RawFd) -> io::Result<()> {
    Err(denied())
}
fn open_dir(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}
fn open_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
}
fn identity(m: &Metadata) -> (u64, u64, u64, u32, u32, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.size(),
        m.uid(),
        m.mode(),
        m.nlink(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn directory_check(path: &Path, fd: &File) -> io::Result<Metadata> {
    physical(path)?;
    let named = fs::symlink_metadata(path)?;
    let held = fd.metadata()?;
    if !held.is_dir() || held.mode() & 0o022 != 0 || identity(&named) != identity(&held) {
        return Err(denied());
    }
    no_extended_acl(fd.as_raw_fd())?;
    Ok(held)
}
fn protected(relative: &Path) -> bool {
    relative.components().any(|c| match c {
        Component::Normal(s) => s.to_str().is_none_or(|s| {
            matches!(
                s,
                ".git" | ".caws" | ".codex" | ".agents" | ".claude" | ".env"
            ) || s.starts_with(".env.")
        }),
        _ => true,
    })
}
struct SourceFile {
    path: PathBuf,
    file: File,
    parent: File,
    expected: Value,
}
pub(crate) struct SourceWriteBinding {
    root: PathBuf,
    root_handle: File,
    files: Vec<SourceFile>,
    read_only: Vec<PathBuf>,
}
impl SourceWriteBinding {
    /// Paths must already have been admitted by the caller's Source authority.
    pub(crate) fn bind(
        root: &Path,
        source_files: &[PathBuf],
        read_only: &[PathBuf],
    ) -> io::Result<Self> {
        physical(root)?;
        if root == Path::new("/")
            || source_files.len() > 256
            || read_only.is_empty()
            || read_only.len() > 4096
        {
            return Err(denied());
        }
        let root_handle = open_dir(root)?;
        directory_check(root, &root_handle)?;
        let mut ro = read_only.to_vec();
        for p in &ro {
            physical(p)?;
            let m = fs::symlink_metadata(p)?;
            if !m.is_file() && !m.is_dir() {
                return Err(denied());
            }
        }
        ro.sort();
        ro.dedup();
        let mut paths = source_files.to_vec();
        paths.sort();
        if paths.windows(2).any(|w| w[0] == w[1]) {
            return Err(denied());
        }
        let mut files = Vec::new();
        let mut total = 0_u64;
        let mut objects = HashSet::new();
        for (i, path) in paths.into_iter().enumerate() {
            physical(&path)?;
            let rel = path.strip_prefix(root).map_err(|_| denied())?;
            if rel.as_os_str().is_empty()
                || protected(rel)
                || ro.iter().any(|p| path.starts_with(p))
            {
                return Err(denied());
            }
            let parent_path = path.parent().ok_or_else(denied)?;
            for ancestor in parent_path.ancestors().take_while(|p| p.starts_with(root)) {
                let d = open_dir(ancestor)?;
                directory_check(ancestor, &d)?;
            }
            let parent = open_dir(parent_path)?;
            directory_check(parent_path, &parent)?;
            let file = open_file(&path)?;
            let expected = Self::snapshot(&path, &file, &parent, i)?;
            let meta = file.metadata()?;
            total = total.checked_add(meta.size()).ok_or_else(denied)?;
            if total > MAX_TOTAL || !objects.insert((meta.dev(), meta.ino())) {
                return Err(denied());
            }
            files.push(SourceFile {
                path,
                file,
                parent,
                expected,
            });
        }
        let result = Self {
            root: root.to_path_buf(),
            root_handle,
            files,
            read_only: ro,
        };
        result.validate()?;
        Ok(result)
    }
    fn snapshot(path: &Path, file: &File, parent: &File, index: usize) -> io::Result<Value> {
        let before = file.metadata()?;
        let named = fs::symlink_metadata(path)?;
        if !before.is_file()
            || before.uid() != unsafe { libc::geteuid() }
            || before.nlink() != 1
            || before.mode() & 0o7133 != 0
            || before.size() > MAX_FILE
            || identity(&before) != identity(&named)
        {
            return Err(denied());
        }
        no_extended_acl(file.as_raw_fd())?;
        let pm = directory_check(path.parent().ok_or_else(denied)?, parent)?;
        let mut clone = file.try_clone()?;
        clone.seek(SeekFrom::Start(0))?;
        let mut hash = Sha256::new();
        let mut n = 0_u64;
        let mut buffer = [0_u8; 16384];
        loop {
            let count = clone.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            n += count as u64;
            if n > MAX_FILE {
                return Err(denied());
            }
            hash.update(&buffer[..count]);
        }
        clone.seek(SeekFrom::Start(0))?;
        let after = file.metadata()?;
        if n != before.size()
            || identity(&before) != identity(&after)
            || identity(&after) != identity(&fs::symlink_metadata(path)?)
            || identity(&pm)
                != identity(&directory_check(path.parent().ok_or_else(denied)?, parent)?)
        {
            return Err(denied());
        }
        Ok(
            json!({"path":path,"fileFd":11 + index as i32 * 2,"parentFd":12 + index as i32 * 2,"device":before.dev().to_string(),"inode":before.ino().to_string(),"size":before.size().to_string(),"uid":before.uid(),"mode":before.mode(),"parentDevice":pm.dev().to_string(),"parentInode":pm.ino().to_string(),"sha256":format!("{:x}", hash.finalize())}),
        )
    }
    pub(crate) fn validate(&self) -> io::Result<()> {
        directory_check(&self.root, &self.root_handle)?;
        for p in &self.read_only {
            physical(p)?;
            let m = fs::symlink_metadata(p)?;
            if !m.is_file() && !m.is_dir() {
                return Err(denied());
            }
        }
        for (i, f) in self.files.iter().enumerate() {
            for ancestor in f
                .path
                .parent()
                .ok_or_else(denied)?
                .ancestors()
                .take_while(|p| p.starts_with(&self.root))
            {
                let d = open_dir(ancestor)?;
                directory_check(ancestor, &d)?;
            }
            if Self::snapshot(&f.path, &f.file, &f.parent, i)? != f.expected {
                return Err(denied());
            }
        }
        Ok(())
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn paths(&self) -> Vec<&Path> {
        self.files.iter().map(|f| f.path.as_path()).collect()
    }
    pub(crate) fn records(&self) -> Vec<&Value> {
        self.files.iter().map(|f| &f.expected).collect()
    }
    pub(crate) fn read_only(&self) -> &[PathBuf] {
        &self.read_only
    }
    pub(crate) fn fd_mappings(&self) -> Vec<(RawFd, RawFd)> {
        let mut fds = vec![(self.root_handle.as_raw_fd(), SOURCE_ROOT_FD)];
        for (i, f) in self.files.iter().enumerate() {
            fds.push((f.file.as_raw_fd(), 11 + i as i32 * 2));
            fds.push((f.parent.as_raw_fd(), 12 + i as i32 * 2));
        }
        fds
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        ro: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "caws-source-binding-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            let root = base.join(".caws/worktrees/lane");
            let ro = base.join("readonly");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir(&ro).unwrap();
            Self { base, root, ro }
        }
        fn file(&self, name: &str) -> PathBuf {
            let p = self.root.join(name);
            fs::write(&p, b"content").unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
            p
        }
        fn bind(&self, files: &[PathBuf]) -> io::Result<SourceWriteBinding> {
            SourceWriteBinding::bind(&self.root, files, std::slice::from_ref(&self.ro))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }
    #[test]
    fn source_binding_linked_worktree_and_identity_replacement() {
        let f = Fixture::new();
        let file = f.file("normal");
        let binding = f.bind(std::slice::from_ref(&file)).unwrap();
        assert_eq!(
            binding.records()[0]["sha256"],
            format!("{:x}", Sha256::digest(b"content"))
        );
        fs::rename(&file, f.root.join("old")).unwrap();
        fs::write(&file, b"content").unwrap();
        assert!(binding.validate().is_err());
    }
    #[test]
    fn source_binding_refuses_protected_aliases_permissions_and_readonly_overlap() {
        let f = Fixture::new();
        let file = f.file("normal");
        let alias = f.root.join("alias");
        symlink(&file, &alias).unwrap();
        assert!(f.bind(&[alias]).is_err());
        let hard = f.root.join("hard");
        fs::hard_link(&file, &hard).unwrap();
        assert!(f.bind(std::slice::from_ref(&file)).is_err());
        fs::remove_file(hard).unwrap();
        for mode in [0o664, 0o646, 0o744, 0o4644] {
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).unwrap();
            assert!(
                f.bind(std::slice::from_ref(&file)).is_err(),
                "mode {mode:o}"
            );
        }
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(SourceWriteBinding::bind(
            &f.root,
            std::slice::from_ref(&file),
            std::slice::from_ref(&f.root)
        )
        .is_err());
        for name in [
            ".git",
            ".caws",
            ".codex",
            ".agents",
            ".claude",
            ".env",
            ".env.local",
        ] {
            let p = f.file(name);
            assert!(f.bind(&[p]).is_err(), "{name}");
        }
        assert!(f.bind(&[file.clone(), file.clone()]).is_err());
        fs::set_permissions(&f.root, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(f.bind(&[file]).is_err());
    }
    #[test]
    fn source_binding_refuses_limits_and_invalid_paths() {
        let f = Fixture::new();
        let file = f.file("normal");
        assert!(f.bind(&vec![file.clone(); 257]).is_err());
        assert!(SourceWriteBinding::bind(&f.root, &[], &[]).is_err());
        assert!(SourceWriteBinding::bind(&f.root, &[], &vec![f.ro.clone(); 4097]).is_err());
        assert!(f.bind(&[f.root.join(".").join("normal")]).is_err());
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(MAX_FILE + 1)
            .unwrap();
        assert!(f.bind(&[file]).is_err());
    }
}
