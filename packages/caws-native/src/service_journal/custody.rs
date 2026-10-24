//! One cooperative machine-owner lifetime lock outside the operational tree.
//! A dedicated, durably provisioned private machine home must remain stable. Initialize
//! is an explicit first-install operation, never an acquire-error fallback.
//! Ambiguous partial initialization is refused without cleanup or rebinding.
//! Registry/root pinning detects whole-root replacement, not arbitrary deletion
//! of accepted IDs inside the pinned tree. No reset, migration or handover API is
//! provided; the future owner must preserve history and settle execution first.
use super::*;
use std::path::PathBuf;

const OWNER_LOCK: &CStr = c".service-owner.lock";
const REGISTRY: &CStr = c".service-root.json";
const REGISTRY_TEMP: &CStr = c".service-root.tmp";
const OPERATIONAL_ROOT: &CStr = c"operations";
const REGISTRY_SCHEMA: &str = "caws.service.custody.v1";
const REGISTRY_LIMIT: usize = 1024;
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    schema: String,
    root_device: u64,
    root_inode: u64,
    lock_device: u64,
    lock_inode: u64,
}
/// A private cooperative machine-owner capability. Acquire it once and share the
/// Arc across all projects/generations. A new home is a new trust domain; this
/// component does not discover or authorize the canonical machine-home path.
#[derive(Debug)]
pub struct Custody {
    home_path: PathBuf,
    home_identity: (u64, u64),
    home: OwnedFd,
    root: OwnedFd,
    owner_lock: File,
    registry_file: File,
    registry_stamp: Stamp,
    registry: Registry,
}
fn duplicate(fd: RawFd) -> Result<OwnedFd> {
    owned_fd(
        unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) },
        "duplicate custody descriptor",
    )
}
fn identity(fd: RawFd) -> Result<(u64, u64)> {
    let file = File::from(duplicate(fd)?);
    let metadata = file
        .metadata()
        .map_err(|e| JournalError::io("custody identity", e))?;
    Ok((metadata.dev(), metadata.ino()))
}
fn owner_lock_checked(file: &File, expires: Instant, check: &EffectCheck<'_>) -> Result<()> {
    loop {
        original_check(check, "custody.owner_lock")?;
        if Instant::now() >= expires {
            return Err(JournalError::new(
                ErrorKind::Busy,
                "another machine owner retains custody",
            ));
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            original_check(check, "custody.owner_locked")?;
            return check_deadline(expires);
        }
        let error = io::Error::last_os_error();
        if !matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            return Err(JournalError::io("machine custody flock", error));
        }
        thread::sleep(
            Duration::from_millis(2).min(expires.saturating_duration_since(Instant::now())),
        );
    }
}
fn expected_names() -> BTreeSet<String> {
    [OWNER_LOCK, REGISTRY, OPERATIONAL_ROOT]
        .into_iter()
        .map(|name| name.to_str().expect("constant ASCII").to_owned())
        .collect()
}
fn exclusive_file_checked(home: RawFd, name: &CStr, check: &EffectCheck<'_>) -> Result<File> {
    original_check(check, "custody.exclusive_file")?;
    let file = File::from(owned_fd(
        unsafe {
            libc::openat(
                home,
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
                0o600,
            )
        },
        "exclusive custody file",
    )?);
    original_check(check, "custody.file_mode")?;
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
        return Err(JournalError::io(
            "custody private mode",
            io::Error::last_os_error(),
        ));
    }
    private_file(&file)?;
    Ok(file)
}
impl Custody {
    /// Explicit initial installation in an EMPTY dedicated private home. This
    /// function must never be used to recover acquire failures. It will not
    /// delete/reuse preexisting locks, roots, registries or incomplete state.
    pub fn initialize(home_path: &Path, expires: Instant) -> Result<Arc<Self>> {
        Self::initialize_checked(home_path, expires, &|_| Ok(()))
    }
    pub(crate) fn initialize_checked(
        home_path: &Path,
        expires: Instant,
        check: &EffectCheck<'_>,
    ) -> Result<Arc<Self>> {
        original_check(check, "custody.initialize")?;
        check_deadline(expires)?;
        let home = private_root(home_path, expires)?;
        if !names(home.as_raw_fd(), 3, expires)?.is_empty() {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "custody home is not pristine",
            ));
        }
        let lock = exclusive_file_checked(home.as_raw_fd(), OWNER_LOCK, check)?;
        owner_lock_checked(&lock, expires, check)?;
        sync_fd_checked(lock.as_raw_fd(), expires, check)?;
        sync_fd_checked(home.as_raw_fd(), expires, check)?;
        check_deadline(expires)?;
        original_check(check, "custody.mkdir")?;
        if unsafe { libc::mkdirat(home.as_raw_fd(), OPERATIONAL_ROOT.as_ptr(), 0o700) } != 0 {
            return Err(JournalError::io(
                "exclusive operational root",
                io::Error::last_os_error(),
            ));
        }
        let root = directory_at(home.as_raw_fd(), OPERATIONAL_ROOT, false, expires)?;
        original_check(check, "custody.directory_mode")?;
        if unsafe { libc::fchmod(root.as_raw_fd(), 0o700) } != 0 {
            return Err(JournalError::io(
                "private operational root mode",
                io::Error::last_os_error(),
            ));
        }
        private_directory(root.as_raw_fd())?;
        sync_fd_checked(root.as_raw_fd(), expires, check)?;
        sync_fd_checked(home.as_raw_fd(), expires, check)?;
        let (root_device, root_inode) = identity(root.as_raw_fd())?;
        let (lock_device, lock_inode) = identity(lock.as_raw_fd())?;
        let registry = Registry {
            schema: REGISTRY_SCHEMA.into(),
            root_device,
            root_inode,
            lock_device,
            lock_inode,
        };
        let bytes = serde_json::to_vec(&registry)
            .map_err(|_| JournalError::new(ErrorKind::Corrupt, "encode custody registry"))?;
        if bytes.len() > REGISTRY_LIMIT {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "custody registry byte bound",
            ));
        }
        let mut temporary = exclusive_file_checked(home.as_raw_fd(), REGISTRY_TEMP, check)?;
        let mut remaining = bytes.as_slice();
        while !remaining.is_empty() {
            original_check(check, "custody.registry.write")?;
            check_deadline(expires)?;
            let count = temporary
                .write(remaining)
                .map_err(|e| JournalError::io("write custody registry", e))?;
            if count == 0 {
                return Err(JournalError::new(
                    ErrorKind::Io,
                    "custody write made no progress",
                ));
            }
            remaining = &remaining[count..];
        }
        sync_fd_checked(temporary.as_raw_fd(), expires, check)?;
        if !same_name(
            home.as_raw_fd(),
            REGISTRY_TEMP,
            temporary.as_raw_fd(),
            libc::S_IFREG,
        ) {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "custody temporary replaced",
            ));
        }
        check_deadline(expires)?;
        // linkat is an atomic no-replace publication; unlike rename it cannot
        // overwrite a registry that appeared unexpectedly. Initialization never
        // cleans ambiguous artifacts. A crash with two links is refused later.
        original_check(check, "custody.registry.link")?;
        if unsafe {
            libc::linkat(
                home.as_raw_fd(),
                REGISTRY_TEMP.as_ptr(),
                home.as_raw_fd(),
                REGISTRY.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(JournalError::io(
                "publish custody registry",
                io::Error::last_os_error(),
            ));
        }
        if let Err(mut error) = original_check(check, "custody.registry.linked") {
            error.publication_may_have_happened = true;
            return Err(error);
        }
        if unsafe { libc::unlinkat(home.as_raw_fd(), REGISTRY_TEMP.as_ptr(), 0) } != 0 {
            let mut error = JournalError::io(
                "remove linked custody temporary",
                io::Error::last_os_error(),
            );
            error.publication_may_have_happened = true;
            return Err(error);
        }
        if let Err(mut error) = sync_fd_checked(home.as_raw_fd(), expires, check) {
            error.publication_may_have_happened = true;
            return Err(error);
        }
        let registry_stamp = Stamp::of(&private_file(&temporary)?);
        let custody = Arc::new(Self {
            home_path: home_path.to_owned(),
            home_identity: identity(home.as_raw_fd())?,
            home,
            root,
            owner_lock: lock,
            registry_file: temporary,
            registry_stamp,
            registry,
        });
        if let Err(mut error) = original_check(check, "custody.initialized") {
            error.publication_may_have_happened = true;
            return Err(error);
        }
        custody.check(expires)?;
        Ok(custody)
    }
    /// Reopen existing custody. Missing/partial/replaced state is an error; this
    /// path never creates an inode, resets a registry, or selects a fresh root.
    pub fn acquire(home_path: &Path, expires: Instant) -> Result<Arc<Self>> {
        Self::acquire_checked(home_path, expires, &|_| Ok(()))
    }
    pub(crate) fn acquire_checked(
        home_path: &Path,
        expires: Instant,
        check: &EffectCheck<'_>,
    ) -> Result<Arc<Self>> {
        original_check(check, "custody.acquire")?;
        check_deadline(expires)?;
        let home = private_root(home_path, expires)?;
        let lock = File::from(owned_fd(
            unsafe {
                libc::openat(
                    home.as_raw_fd(),
                    OWNER_LOCK.as_ptr(),
                    libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            },
            "open existing machine custody lock",
        )?);
        if private_file(&lock)?.len() != 0 {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "custody lock is not empty",
            ));
        }
        owner_lock_checked(&lock, expires, check)?;
        if names(home.as_raw_fd(), 3, expires)? != expected_names() {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "custody state missing or incomplete",
            ));
        }
        let (bytes, registry_stamp) =
            read_file(home.as_raw_fd(), REGISTRY, REGISTRY_LIMIT, expires)?;
        let registry: Registry = serde_json::from_slice(&bytes)
            .map_err(|_| JournalError::new(ErrorKind::Corrupt, "invalid custody registry"))?;
        if registry.schema != REGISTRY_SCHEMA
            || registry.root_inode == 0
            || registry.lock_inode == 0
        {
            return Err(JournalError::new(
                ErrorKind::Corrupt,
                "invalid custody identity",
            ));
        }
        let registry_file = open_file(home.as_raw_fd(), REGISTRY)?;
        if Stamp::of(&private_file(&registry_file)?) != registry_stamp {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "custody registry changed during acquisition",
            ));
        }
        let root = directory_at(home.as_raw_fd(), OPERATIONAL_ROOT, false, expires)?;
        let custody = Arc::new(Self {
            home_path: home_path.to_owned(),
            home_identity: identity(home.as_raw_fd())?,
            home,
            root,
            owner_lock: lock,
            registry_file,
            registry_stamp,
            registry,
        });
        custody.check(expires)?;
        // A complete visible initialization whose last directory fsync reported
        // failure may be retried. Re-establish every pinned publication boundary
        // before exposing custody, without manufacturing or repairing any state.
        sync_fd_checked(custody.owner_lock.as_raw_fd(), expires, check)?;
        sync_fd_checked(custody.registry_file.as_raw_fd(), expires, check)?;
        sync_fd_checked(custody.root.as_raw_fd(), expires, check)?;
        sync_fd_checked(custody.home.as_raw_fd(), expires, check)?;
        custody.check(expires)?;
        original_check(check, "custody.acquired")?;
        Ok(custody)
    }
    pub(super) fn check(&self, expires: Instant) -> Result<()> {
        check_deadline(expires)?;
        let named_home = private_root(&self.home_path, expires)?;
        private_directory(self.home.as_raw_fd())?;
        private_directory(self.root.as_raw_fd())?;
        if identity(named_home.as_raw_fd())? != self.home_identity
            || private_file(&self.owner_lock)?.len() != 0
            || identity(self.owner_lock.as_raw_fd())?
                != (self.registry.lock_device, self.registry.lock_inode)
            || identity(self.root.as_raw_fd())?
                != (self.registry.root_device, self.registry.root_inode)
            || Stamp::of(&private_file(&self.registry_file)?) != self.registry_stamp
            || !same_name(
                self.home.as_raw_fd(),
                OWNER_LOCK,
                self.owner_lock.as_raw_fd(),
                libc::S_IFREG,
            )
            || !same_name(
                self.home.as_raw_fd(),
                REGISTRY,
                self.registry_file.as_raw_fd(),
                libc::S_IFREG,
            )
            || !same_name(
                self.home.as_raw_fd(),
                OPERATIONAL_ROOT,
                self.root.as_raw_fd(),
                libc::S_IFDIR,
            )
            || names(self.home.as_raw_fd(), 3, expires)? != expected_names()
        {
            return Err(JournalError::new(
                ErrorKind::UnsafePath,
                "machine custody anchor changed",
            ));
        }
        check_deadline(expires)
    }
    pub(super) fn duplicate_root(&self, expires: Instant) -> Result<OwnedFd> {
        self.check(expires)?;
        duplicate(self.root.as_raw_fd())
    }
    /// Duplicate the actual anchored lifetime flock for an owned worker. This
    /// grants no project authority and must remain held through backend cleanup.
    pub fn duplicate_lifetime(&self, expires: Instant) -> Result<OwnedFd> {
        self.check(expires)?;
        duplicate(self.owner_lock.as_raw_fd())
    }
    /// Enumerate every existing service before admitting fresh global capacity.
    /// Missing services is pristine operational state; malformed entries refuse.
    pub fn service_keys(&self, limit: usize, expires: Instant) -> Result<Vec<String>> {
        self.check(expires)?;
        if limit == 0 || limit > 1024 {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "service enumeration bound",
            ));
        }
        let raw = unsafe {
            libc::openat(
                self.root.as_raw_fd(),
                c"services".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            let e = io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::ENOENT) {
                return Ok(Vec::new());
            }
            return Err(JournalError::io("enumerate anchored services", e));
        }
        let services = owned_fd(raw, "anchored services")?;
        private_directory(services.as_raw_fd())?;
        let keys = names(services.as_raw_fd(), limit, expires)?;
        for key in &keys {
            if !digest(key) {
                return Err(JournalError::new(
                    ErrorKind::Corrupt,
                    "invalid service directory",
                ));
            }
            let name = CString::new(key.as_str()).expect("validated ASCII key");
            let directory = directory_at(services.as_raw_fd(), &name, false, expires)?;
            private_directory(directory.as_raw_fd())?;
        }
        self.check(expires)?;
        Ok(keys.into_iter().collect())
    }
}
