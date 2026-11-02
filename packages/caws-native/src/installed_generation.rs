//! Verification of one exact installed runtime generation.
//!
//! This component never reads the current pointer or launches an entry. The
//! stable transport and original invoke receipt each retain their own expiry.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

const SCHEMA: &str = "caws.runtime.native-entry.v1";
const METADATA: &str = "native-entry.json";
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_METADATA: u64 = 64 * 1024;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeEntry {
    schema: String,
    pub(crate) native_executable: String,
    pub(crate) node_executable: String,
    pub(crate) engine_entry: String,
    pub(crate) describe_entry: String,
    pub(crate) timeout_ms: u64,
}
#[derive(Debug)]
enum Route {
    Native(NativeEntry),
    /// This is a compatibility classification, not an executed-generation witness.
    Legacy,
}
#[derive(Debug)]
pub(crate) struct Selection {
    root: PathBuf,
    pub inspected_digest: String,
    manifest: BTreeMap<String, String>,
    // Derived only from this immutable admitted manifest, never filesystem state.
    allowed_directories: BTreeSet<PathBuf>,
    route: Route,
}

/// Fixed-size request-local observations, never consulted by verification.
/// Phase times are inclusive: selection verification contains member hashing
/// and inventory/modes. Failed phases and partially completed I/O count too.
#[derive(Clone, Default)]
pub(crate) struct VerificationDiagnostics(Rc<VerificationTotals>);
#[derive(Clone, Copy, Default)]
struct PhaseTotals {
    count: u64,
    failures: u64,
    elapsed: Duration,
}
#[derive(Default)]
struct VerificationTotals {
    phases: [Cell<PhaseTotals>; 7],
    path_metadata_operations: Cell<u64>,
    fd_metadata_operations: Cell<u64>,
    hash_calls: Cell<u64>,
    bytes_hashed: Cell<u64>,
}
#[derive(Clone, Copy)]
pub(crate) enum VerificationPhase {
    IdentityBefore,
    SelectionVerification,
    IdentityAfter,
    MemberHashing,
    InventoryModes,
    ManifestDirectoryPlan,
    ManifestAuthentication,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhaseSnapshot {
    pub count: u64,
    pub failures: u64,
    pub elapsed_micros: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerificationSnapshot {
    pub identity_before: PhaseSnapshot,
    pub selection_verification: PhaseSnapshot,
    pub identity_after: PhaseSnapshot,
    pub member_hashing: PhaseSnapshot,
    pub inventory_modes: PhaseSnapshot,
    pub manifest_directory_plan: PhaseSnapshot,
    pub manifest_authentication: PhaseSnapshot,
    pub path_metadata_operations: u64,
    pub fd_metadata_operations: u64,
    pub hash_calls: u64,
    pub bytes_hashed: u64,
}
impl VerificationDiagnostics {
    fn phase(&self, phase: VerificationPhase, elapsed: Duration, failed: bool) {
        let slot = &self.0.phases[phase as usize];
        let previous = slot.get();
        slot.set(PhaseTotals {
            count: previous.count.saturating_add(1),
            failures: previous.failures.saturating_add(u64::from(failed)),
            elapsed: previous.elapsed.saturating_add(elapsed),
        });
    }
    fn path_metadata(&self) {
        let value = &self.0.path_metadata_operations;
        value.set(value.get().saturating_add(1));
    }
    fn fd_metadata(&self) {
        let value = &self.0.fd_metadata_operations;
        value.set(value.get().saturating_add(1));
    }
    fn hash_call(&self) {
        let value = &self.0.hash_calls;
        value.set(value.get().saturating_add(1));
    }
    fn hashed(&self, bytes: usize) {
        let value = &self.0.bytes_hashed;
        value.set(value.get().saturating_add(bytes as u64));
    }
    pub(crate) fn snapshot(&self) -> VerificationSnapshot {
        let phase = |kind: VerificationPhase| {
            let entry = self.0.phases[kind as usize].get();
            PhaseSnapshot {
                count: entry.count,
                failures: entry.failures,
                elapsed_micros: entry.elapsed.as_micros().min(u64::MAX as u128) as u64,
            }
        };
        VerificationSnapshot {
            identity_before: phase(VerificationPhase::IdentityBefore),
            selection_verification: phase(VerificationPhase::SelectionVerification),
            identity_after: phase(VerificationPhase::IdentityAfter),
            member_hashing: phase(VerificationPhase::MemberHashing),
            inventory_modes: phase(VerificationPhase::InventoryModes),
            manifest_directory_plan: phase(VerificationPhase::ManifestDirectoryPlan),
            manifest_authentication: phase(VerificationPhase::ManifestAuthentication),
            path_metadata_operations: self.0.path_metadata_operations.get(),
            fd_metadata_operations: self.0.fd_metadata_operations.get(),
            hash_calls: self.0.hash_calls.get(),
            bytes_hashed: self.0.bytes_hashed.get(),
        }
    }
}

/// One caller-owned expiry and cancellation callback for the complete operation.
/// Checkpoints bracket bounded I/O; they cannot interrupt a stalled kernel syscall.
pub(crate) struct Verification<'a> {
    expires: Instant,
    cancel: &'a mut dyn FnMut() -> Result<(), String>,
    diagnostics: Option<VerificationDiagnostics>,
    // Storage only; every consumed byte is overwritten by the current read.
    scratch: Option<Box<[u8; 65536]>>,
    #[cfg(test)]
    pub(crate) last_parent_fd: Option<i32>,
    #[cfg(test)]
    pub(crate) scratch_allocations: u64,
    #[cfg(test)]
    pub(crate) on_chunk: Option<Box<dyn FnMut(&Path, u64) + 'a>>,
    #[cfg(test)]
    pub(crate) on_phase: Option<Box<dyn FnMut(VerificationPhase) + 'a>>,
    #[cfg(test)]
    on_open_result: Option<Box<dyn FnMut(Option<i32>) + 'a>>,
    #[cfg(test)]
    on_read_result: Option<Box<dyn FnMut(&std::io::Result<usize>) + 'a>>,
}
impl<'a> Verification<'a> {
    pub(crate) fn new(expires: Instant, cancel: &'a mut dyn FnMut() -> Result<(), String>) -> Self {
        Self {
            expires,
            cancel,
            diagnostics: None,
            scratch: None,
            #[cfg(test)]
            last_parent_fd: None,
            #[cfg(test)]
            scratch_allocations: 0,
            #[cfg(test)]
            on_chunk: None,
            #[cfg(test)]
            on_phase: None,
            #[cfg(test)]
            on_open_result: None,
            #[cfg(test)]
            on_read_result: None,
        }
    }
    /// Only the receipt revalidation scope attaches request diagnostics. Restore
    /// the previous handle even on refusal; no initial load/member lookup leaks
    /// into the precisely named receipt counters when the verifier is reused.
    pub(crate) fn diagnosed<R>(
        &mut self,
        diagnostics: &VerificationDiagnostics,
        operation: impl FnOnce(&mut Self) -> R,
    ) -> R {
        let previous = self.diagnostics.replace(diagnostics.clone());
        let result = operation(self);
        self.diagnostics = previous;
        result
    }
    pub(crate) fn phase<R>(
        &mut self,
        phase: VerificationPhase,
        operation: impl FnOnce(&mut Self) -> Result<R, String>,
    ) -> Result<R, String> {
        // No per-member or per-metadata timer: only fixed phase boundaries.
        let measurement = self
            .diagnostics
            .as_ref()
            .map(|value| (value.clone(), Instant::now()));
        #[cfg(test)]
        if let Some(hook) = self.on_phase.as_mut() {
            hook(phase);
        }
        let result = operation(self);
        if let Some((diagnostics, started)) = measurement {
            diagnostics.phase(phase, started.elapsed(), result.is_err());
        }
        result
    }
    pub(crate) fn expires(&self) -> Instant {
        self.expires
    }
    #[cfg(test)]
    pub(crate) fn scratch_address(&self) -> Option<usize> {
        self.scratch.as_ref().map(|buffer| buffer.as_ptr() as usize)
    }
    #[cfg(test)]
    fn allocated_scratch(&mut self) {
        self.scratch_allocations += 1;
    }
    pub(crate) fn checkpoint(&mut self) -> Result<(), String> {
        (self.cancel)()?;
        if Instant::now() >= self.expires {
            return Err("Runtime verification deadline expired".into());
        }
        Ok(())
    }
}

/// Exact native metadata; never project nanosecond stamps through a JS number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemberMetadata {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mode: u32,
    pub nlink: u64,
    pub uid: u32,
    pub gid: u32,
    pub mtime: i64,
    pub mtime_nsec: i64,
    pub ctime: i64,
    pub ctime_nsec: i64,
}
impl MemberMetadata {
    fn of(m: &fs::Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            size: m.size(),
            mode: m.mode(),
            nlink: m.nlink(),
            uid: m.uid(),
            gid: m.gid(),
            mtime: m.mtime(),
            mtime_nsec: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_nsec: m.ctime_nsec(),
        }
    }
    pub(crate) fn read(
        path: &Path,
        directory: bool,
        verify: &mut Verification<'_>,
    ) -> Result<Self, String> {
        let m = path_metadata(path, verify)?;
        if if directory { !m.is_dir() } else { !m.is_file() } {
            return Err("Admitted generation path type changed".into());
        }
        Ok(Self::of(&m))
    }
}
fn path_metadata(path: &Path, verify: &mut Verification<'_>) -> Result<fs::Metadata, String> {
    verify.checkpoint()?;
    if let Some(diagnostics) = &verify.diagnostics {
        diagnostics.path_metadata();
    }
    let result = fs::symlink_metadata(path);
    verify.checkpoint()?;
    result.map_err(|e| format!("Generation path unavailable {}: {e}", path.display()))
}
fn file_metadata(file: &File, verify: &mut Verification<'_>) -> Result<fs::Metadata, String> {
    verify.checkpoint()?;
    if let Some(diagnostics) = &verify.diagnostics {
        diagnostics.fd_metadata();
    }
    let result = file.metadata();
    verify.checkpoint()?;
    result.map_err(|e| e.to_string())
}
pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn relative_path(relative: &str) -> Result<&Path, String> {
    if relative.is_empty()
        || relative.contains(['\0', '\\'])
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("Invalid generation path: {relative:?}"));
    }
    let suffix = Path::new(relative);
    if suffix
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Path escapes generation: {relative:?}"));
    }
    Ok(suffix)
}
fn confined(root: &Path, relative: &str, verify: &mut Verification<'_>) -> Result<PathBuf, String> {
    verify.checkpoint()?;
    let suffix = relative_path(relative)?;
    let mut cursor = root.to_path_buf();
    for part in std::iter::once(None).chain(suffix.components().map(Some)) {
        if let Some(part) = part {
            cursor.push(part.as_os_str());
        }
        if path_metadata(&cursor, verify)?.file_type().is_symlink() {
            return Err(format!("Refusing symlink: {}", cursor.display()));
        }
    }
    Ok(cursor)
}
/// One parent capability for a consecutive native-manifest member group.
/// Full named traversal stamps bracket its use; the held FD alone is not a
/// freshness claim. Only one additional parent FD is live, not one per directory.
struct MemberParent {
    path: PathBuf,
    directory: File,
    anchors: Vec<(PathBuf, MemberMetadata)>,
}
fn hashing_directory_metadata(
    path: &Path,
    verify: &mut Verification<'_>,
) -> Result<MemberMetadata, String> {
    let metadata = path_metadata(path, verify)?;
    if metadata.file_type().is_symlink() {
        return Err(format!("Refusing symlink: {}", path.display()));
    }
    if !metadata.is_dir() {
        return Err("Admitted generation path type changed".into());
    }
    Ok(MemberMetadata::of(&metadata))
}
impl MemberParent {
    fn capture(root: &Path, parent: &Path, verify: &mut Verification<'_>) -> Result<Self, String> {
        verify.checkpoint()?;
        let mut path = root.to_path_buf();
        let mut anchors = Vec::new();
        for component in std::iter::once(None).chain(parent.components().map(Some)) {
            if let Some(component) = component {
                path.push(component.as_os_str());
            }
            let metadata = hashing_directory_metadata(&path, verify)?;
            anchors.push((path.clone(), metadata));
        }
        verify.checkpoint()?;
        let result = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&path);
        #[cfg(test)]
        if let Ok(file) = &result {
            verify.last_parent_fd = Some(file.as_raw_fd());
        }
        verify.checkpoint()?;
        let directory = result.map_err(|error| {
            format!("Cannot open hashing directory {}: {error}", path.display())
        })?;
        let opened = file_metadata(&directory, verify)?;
        if !opened.is_dir() || MemberMetadata::of(&opened) != anchors.last().unwrap().1 {
            return Err("Runtime hashing directory changed at open".into());
        }
        Ok(Self {
            path,
            directory,
            anchors,
        })
    }
    fn finish(self, verify: &mut Verification<'_>) -> Result<(), String> {
        verify.checkpoint()?;
        let held = file_metadata(&self.directory, verify)?;
        if !held.is_dir() || MemberMetadata::of(&held) != self.anchors.last().unwrap().1 {
            return Err("Runtime hashing directory changed before group closed".into());
        }
        for (path, expected) in &self.anchors {
            if hashing_directory_metadata(path, verify)? != *expected {
                return Err("Runtime hashing traversal changed before group closed".into());
            }
        }
        verify.checkpoint()
    }
}
fn open_regular(
    path: &Path,
    parent: Option<&File>,
    verify: &mut Verification<'_>,
) -> Result<(File, MemberMetadata), String> {
    // Also performs the no-follow leaf check formerly performed by confined().
    // A held parent never replaces named-leaf/opened-FD identity comparison.
    let named = path_metadata(path, verify)?;
    if named.file_type().is_symlink() {
        return Err(format!("Refusing symlink: {}", path.display()));
    }
    if !named.is_file() {
        return Err("Admitted generation path type changed".into());
    }
    let before = MemberMetadata::of(&named);
    verify.checkpoint()?;
    let flags = libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let result = if let Some(parent) = parent {
        let leaf = CString::new(
            path.file_name()
                .ok_or("Runtime member has no file name")?
                .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        let fd = unsafe { libc::openat(parent.as_raw_fd(), leaf.as_ptr(), libc::O_RDONLY | flags) };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // Own the FD before checking cancellation so every refusal closes it.
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    } else {
        OpenOptions::new().read(true).custom_flags(flags).open(path)
    };
    #[cfg(test)]
    if let Some(hook) = verify.on_open_result.as_mut() {
        hook(result.as_ref().ok().map(|file| file.as_raw_fd()));
    }
    let file = match result {
        Ok(file) => file,
        Err(error) => {
            // Even a failed open must observe cancellation/expiry before its
            // I/O error escapes. A successful File is already RAII-owned.
            verify.checkpoint()?;
            return Err(format!("Cannot open {}: {error}", path.display()));
        }
    };
    // This entry checkpoint also closes the successful open's I/O bracket;
    // only ownership transfer and pure control flow intervene.
    let opened = file_metadata(&file, verify)?;
    if !opened.is_file() || MemberMetadata::of(&opened) != before {
        return Err(format!("Runtime file identity changed: {}", path.display()));
    }
    Ok((file, before))
}
/// Read no more than the observed initial size. Growth is detected by post-read
/// fd/path metadata, never by following a growing EOF. Payload retention has a
/// separate reviewed maximum; hashing keeps only one 64KiB chunk.
fn read_regular(
    path: &Path,
    parent: Option<&File>,
    maximum: Option<u64>,
    verify: &mut Verification<'_>,
    mut consume: impl FnMut(&[u8]),
) -> Result<(), String> {
    let (mut file, before) = open_regular(path, parent, verify)?;
    if maximum.is_some_and(|maximum| before.size > maximum) {
        return Err(format!("File exceeds bound: {}", path.display()));
    }
    let mut count = 0u64;
    if before.size > 0 && verify.scratch.is_none() {
        verify.scratch = Some(Box::new([0u8; 65536]));
        #[cfg(test)]
        verify.allocated_scratch();
    }
    while count < before.size {
        verify.checkpoint()?;
        let remaining = (before.size - count).min(65536) as usize;
        let result = file.read(&mut verify.scratch.as_mut().unwrap()[..remaining]);
        #[cfg(test)]
        if let Some(hook) = verify.on_read_result.as_mut() {
            hook(&result);
        }
        verify.checkpoint()?;
        let length = result.map_err(|e| e.to_string())?;
        if length == 0 {
            return Err(format!("Runtime file truncated: {}", path.display()));
        }
        count += length as u64; // length <= before.size - count
        #[cfg(test)]
        if let Some(hook) = verify.on_chunk.as_mut() {
            hook(path, count);
        }
        verify.checkpoint()?;
        consume(&verify.scratch.as_ref().unwrap()[..length]);
        // The next iteration's entry check, or file_metadata's entry check
        // below, closes consumption before any further read/metadata I/O.
    }
    let after = file_metadata(&file, verify)?;
    let named = MemberMetadata::read(path, false, verify)?;
    if MemberMetadata::of(&after) != before || named != before {
        return Err(format!("Runtime file identity changed: {}", path.display()));
    }
    verify.checkpoint()
}
fn read_bounded(
    path: &Path,
    maximum: u64,
    verify: &mut Verification<'_>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    read_regular(path, None, Some(maximum), verify, |chunk| {
        bytes.extend_from_slice(chunk)
    })?;
    Ok(bytes)
}
pub(crate) fn read_metadata(
    root: &Path,
    relative: &str,
    maximum: u64,
    verify: &mut Verification<'_>,
) -> Result<Vec<u8>, String> {
    read_bounded(&confined(root, relative, verify)?, maximum, verify)
}

/// Bind the exact retained bytes supplied to a metadata parser to the
/// selected manifest, rather than relying on an earlier read of the pathname.
fn read_manifest_metadata(
    root: &Path,
    relative: &str,
    maximum: u64,
    manifest: &BTreeMap<String, String>,
    verify: &mut Verification<'_>,
) -> Result<Vec<u8>, String> {
    let expected = manifest
        .get(relative)
        .ok_or_else(|| format!("Runtime metadata is not in manifest: {relative}"))?;
    let bytes = read_metadata(root, relative, maximum, verify)?;
    verify.checkpoint()?;
    if let Some(diagnostics) = &verify.diagnostics {
        diagnostics.hash_call();
    }
    let digest = Sha256::digest(&bytes);
    if let Some(diagnostics) = &verify.diagnostics {
        diagnostics.hashed(bytes.len());
    }
    if format!("{digest:x}") != *expected {
        return Err(format!("Runtime member integrity failure: {relative}"));
    }
    verify.checkpoint()?;
    Ok(bytes)
}

fn file_digest(path: &Path, verify: &mut Verification<'_>) -> Result<String, String> {
    file_digest_at(path, None, verify)
}
fn file_digest_at(
    path: &Path,
    parent: Option<&File>,
    verify: &mut Verification<'_>,
) -> Result<String, String> {
    let mut hash = Sha256::new();
    let diagnostics = verify.diagnostics.clone();
    if let Some(diagnostics) = &diagnostics {
        diagnostics.hash_call();
    }
    read_regular(path, parent, None, verify, |chunk| {
        hash.update(chunk);
        if let Some(diagnostics) = &diagnostics {
            diagnostics.hashed(chunk.len());
        }
    })?;
    Ok(format!("{:x}", hash.finalize()))
}
// Accounting is at the actual full hash/inventory implementation, on each test
// thread independently. Production carries no counter or alternate verifier.
#[cfg(test)]
std::thread_local! {
    static VERIFICATION_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
pub(crate) fn verification_count() -> usize {
    VERIFICATION_COUNT.with(std::cell::Cell::get)
}
// Construct once from authenticated manifest bytes under the original budget.
// Reuse does not authenticate current files, modes, inventory or identities.
fn manifest_directory_plan(
    manifest: &BTreeMap<String, String>,
    verify: &mut Verification<'_>,
) -> Result<BTreeSet<PathBuf>, String> {
    // The already byte-bounded manifest determines every permitted directory.
    // Do not recurse into undeclared empty trees or invent a full-image byte cap.
    verify.phase(VerificationPhase::ManifestDirectoryPlan, |verify| {
        let mut directories = BTreeSet::new();
        for relative in manifest.keys() {
            verify.checkpoint()?;
            let mut parent = relative_path(relative)?.parent();
            while let Some(path) = parent {
                verify.checkpoint()?;
                if path.as_os_str().is_empty() {
                    break;
                }
                directories.insert(path.to_path_buf());
                parent = path.parent();
            }
        }
        Ok(directories)
    })
}

fn verify_files(
    root: &Path,
    manifest: &BTreeMap<String, String>,
    allowed_directories: &BTreeSet<PathBuf>,
    verify: &mut Verification<'_>,
) -> Result<(), String> {
    #[cfg(test)]
    VERIFICATION_COUNT.with(|count| count.set(count.get() + 1));
    verify.checkpoint()?;
    verify.phase(VerificationPhase::MemberHashing, |verify| {
        let native = manifest.contains_key(METADATA);
        let mut group: Option<MemberParent> = None;
        for (relative, expected) in manifest {
            verify.checkpoint()?;
            if !valid_digest(expected) {
                return Err(format!("Invalid member digest: {relative}"));
            }
            let digest = if native {
                let suffix = relative_path(relative)?;
                let parent = suffix.parent().ok_or("Runtime member has no parent")?;
                let parent_path = root.join(parent);
                if group
                    .as_ref()
                    .is_none_or(|current| current.path != parent_path)
                {
                    if let Some(previous) = group.take() {
                        previous.finish(verify)?;
                    }
                    group = Some(MemberParent::capture(root, parent, verify)?);
                }
                file_digest_at(
                    &root.join(suffix),
                    Some(&group.as_ref().unwrap().directory),
                    verify,
                )?
            } else {
                // Legacy non-native images preserve their original traversal.
                file_digest(&confined(root, relative, verify)?, verify)?
            };
            if digest != *expected {
                return Err(format!("Runtime member integrity failure: {relative}"));
            }
        }
        // Standalone Selection has no outer receipt: closing the final group
        // must precede success here, not depend on a later caller validation.
        if let Some(last) = group {
            last.finish(verify)?;
        }
        Ok(())
    })?;
    if manifest.contains_key(METADATA) {
        verify.phase(VerificationPhase::InventoryModes, |verify| {
            let modes: BTreeMap<String, u32> = serde_json::from_slice(&read_manifest_metadata(
                root,
                "native-modes.json",
                MAX_MANIFEST,
                manifest,
                verify,
            )?)
            .map_err(|e| format!("Malformed native mode inventory: {e}"))?;
            verify.checkpoint()?;
            if modes.keys().ne(manifest.keys()) || !manifest.contains_key("native/caws-hook-native")
            {
                return Err(
                    "Native mode inventory differs from manifest or lacks entry identity".into(),
                );
            }
            let mut pending = vec![root.to_path_buf()];
            let mut actual = BTreeSet::new();
            while let Some(current) = pending.pop() {
                verify.checkpoint()?;
                let result = fs::read_dir(&current);
                verify.checkpoint()?;
                let mut entries = result.map_err(|e| e.to_string())?;
                loop {
                    verify.checkpoint()?;
                    let next = entries.next();
                    verify.checkpoint()?;
                    let Some(entry) = next else {
                        break;
                    };
                    let path = entry.map_err(|e| e.to_string())?.path();
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_str()
                        .ok_or("Native image paths must be UTF-8")?
                        .to_owned();
                    let stat = path_metadata(&path, verify)?;
                    if stat.is_dir() {
                        if !allowed_directories.contains(Path::new(&relative)) {
                            return Err(format!("Undeclared native runtime directory: {relative}"));
                        }
                        pending.push(path);
                        continue;
                    }
                    if !stat.is_file() || stat.nlink() != 1 {
                        return Err(format!("Unsupported native runtime member: {relative}"));
                    }
                    if relative == "manifest.json" {
                        if stat.permissions().mode() & 0o7777 != 0o644 {
                            return Err("Native manifest mode mismatch".into());
                        }
                        continue;
                    }
                    let expected = modes
                        .get(&relative)
                        .ok_or_else(|| format!("Undeclared native runtime member: {relative}"))?;
                    if ![0o644, 0o755].contains(expected)
                        || stat.permissions().mode() & 0o7777 != *expected
                    {
                        return Err(format!("Native runtime mode mismatch: {relative}"));
                    }
                    actual.insert(relative);
                }
            }
            if actual.iter().ne(manifest.keys()) {
                return Err("Native runtime inventory differs from manifest".into());
            }
            Ok(())
        })?;
    }
    verify.checkpoint()
}

impl Selection {
    /// Verify this exact generation. This path never reads the runtime pointer.
    pub(crate) fn read_generation(
        home: &Path,
        digest: &str,
        verify: &mut Verification<'_>,
    ) -> Result<Self, String> {
        verify.checkpoint()?;
        if !home.is_absolute() || !valid_digest(digest) {
            return Err("Invalid exact runtime generation".into());
        }
        let root = confined(home, &format!("lib/runtimes/{digest}"), verify)?;
        let bytes = read_metadata(&root, "manifest.json", MAX_MANIFEST, verify)?;
        if format!("{:x}", Sha256::digest(&bytes)) != digest {
            return Err("Runtime manifest integrity failure".into());
        }
        let manifest: BTreeMap<String, String> = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Malformed runtime manifest: {e}"))?;
        verify.checkpoint()?;
        if !manifest
            .get("launcher.py")
            .is_some_and(|value| valid_digest(value))
        {
            return Err("Version-1 manifest lacks the legacy driver identity".into());
        }
        let allowed_directories = manifest_directory_plan(&manifest, verify)?;
        verify_files(&root, &manifest, &allowed_directories, verify)?;
        let route = if manifest.contains_key(METADATA) {
            let entry: NativeEntry = serde_json::from_slice(&read_manifest_metadata(
                &root,
                METADATA,
                MAX_METADATA,
                &manifest,
                verify,
            )?)
            .map_err(|e| format!("Malformed native entry: {e}"))?;
            verify.checkpoint()?;
            if entry.schema != SCHEMA || !(1..=120_000).contains(&entry.timeout_ms) {
                return Err("Unsupported native entry schema or timeout".into());
            }
            for name in [
                &entry.native_executable,
                &entry.node_executable,
                &entry.engine_entry,
                &entry.describe_entry,
            ] {
                if !manifest.contains_key(name) {
                    return Err(format!("Native entry asset is not in manifest: {name}"));
                }
                confined(&root, name, verify)?;
            }
            for name in [&entry.native_executable, &entry.node_executable] {
                if path_metadata(&confined(&root, name, verify)?, verify)?
                    .permissions()
                    .mode()
                    & 0o111
                    == 0
                {
                    return Err(format!("Native entry asset is not executable: {name}"));
                }
            }
            Route::Native(entry)
        } else {
            verify.checkpoint()?;
            let metadata_exists = fs::symlink_metadata(root.join(METADATA));
            verify.checkpoint()?;
            if metadata_exists.is_ok() {
                return Err(
                    "Untracked native entry metadata cannot select legacy compatibility".into(),
                );
            }
            if !manifest.contains_key("bootstrap.py") {
                return Err("Unrecognized legacy generation: no verified bootstrap".into());
            }
            Route::Legacy
        };
        verify.checkpoint()?;
        Ok(Self {
            root,
            inspected_digest: digest.to_owned(),
            manifest,
            allowed_directories,
            route,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn members(&self) -> &BTreeMap<String, String> {
        &self.manifest
    }

    pub(crate) fn member_path(
        &self,
        relative: &str,
        verify: &mut Verification<'_>,
    ) -> Result<PathBuf, String> {
        verify.checkpoint()?;
        if !self.manifest.contains_key(relative) {
            return Err("Runtime member was not admitted".into());
        }
        confined(&self.root, relative, verify)
    }

    pub(crate) fn native_paths(
        &self,
        verify: &mut Verification<'_>,
    ) -> Result<(PathBuf, PathBuf, PathBuf), String> {
        verify.checkpoint()?;
        let Some(entry) = self.native_entry() else {
            return Err("Exact generation has no native entry".into());
        };
        Ok((
            self.member_path(&entry.native_executable, verify)?,
            self.member_path(&entry.node_executable, verify)?,
            self.member_path(&entry.engine_entry, verify)?,
        ))
    }

    pub(crate) fn revalidate(&self, verify: &mut Verification<'_>) -> Result<(), String> {
        verify.checkpoint()?;
        verify.phase(VerificationPhase::ManifestAuthentication, |verify| {
            if file_digest(&confined(&self.root, "manifest.json", verify)?, verify)?
                != self.inspected_digest
            {
                return Err("Selected manifest changed before launch".into());
            }
            Ok(())
        })?;
        verify_files(
            &self.root,
            &self.manifest,
            &self.allowed_directories,
            verify,
        )
    }

    pub(crate) fn native_entry(&self) -> Option<&NativeEntry> {
        match &self.route {
            Route::Native(entry) => Some(entry),
            Route::Legacy => None,
        }
    }
}

#[cfg(test)]
mod checkpoint_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct FileFixture {
        directory: PathBuf,
        path: PathBuf,
    }
    impl FileFixture {
        fn new(bytes: &[u8]) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "caws-generation-checkpoint-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            let path = directory.join("member");
            fs::write(&path, bytes).unwrap();
            Self { directory, path }
        }
    }
    impl Drop for FileFixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.directory).unwrap();
        }
    }
    fn retain(name: &str, value: serde_json::Value) {
        if let Some(root) = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT") {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(PathBuf::from(root).join(format!("checkpoint-{name}.json")))
                .unwrap();
            serde_json::to_writer_pretty(file, &value).unwrap();
        }
    }

    #[test]
    fn completed_open_preserves_cancellation_error_precedence_and_fd_custody() {
        let mut observations = Vec::new();
        for successful in [false, true] {
            for cancelled in [false, true] {
                let fixture = FileFixture::new(b"current bytes");
                // A real regular-file parent makes openat return ENOTDIR after
                // the named leaf was successfully observed.
                let parent = (!successful).then(|| File::open(&fixture.path).unwrap());
                let armed = Cell::new(false);
                let opened_fd = Cell::new(None);
                let open_results = Cell::new(0usize);
                let mut cancel = || {
                    if armed.get() {
                        Err("cancelled after actual open result".into())
                    } else {
                        Ok(())
                    }
                };
                let expiry = Instant::now() + Duration::from_secs(5);
                let mut verify = Verification::new(expiry, &mut cancel);
                verify.on_open_result = Some(Box::new(|fd| {
                    open_results.set(open_results.get() + 1);
                    assert_eq!(fd.is_some(), successful);
                    opened_fd.set(fd);
                    armed.set(cancelled);
                }));
                let diagnostics = VerificationDiagnostics::default();
                let result = verify.diagnosed(&diagnostics, |verify| {
                    open_regular(&fixture.path, parent.as_ref(), verify)
                });
                assert_eq!(open_results.get(), 1, "the actual open was attempted");
                let error = if cancelled {
                    let error = result.unwrap_err();
                    assert_eq!(error, "cancelled after actual open result");
                    Some(error)
                } else if successful {
                    let (file, stamp) = result.unwrap();
                    assert_eq!(stamp, MemberMetadata::of(&file.metadata().unwrap()));
                    drop(file);
                    None
                } else {
                    let error = result.unwrap_err();
                    assert_eq!(
                        error,
                        format!(
                            "Cannot open {}: {}",
                            fixture.path.display(),
                            std::io::Error::from_raw_os_error(libc::ENOTDIR)
                        )
                    );
                    Some(error)
                };
                assert_eq!(opened_fd.get().is_some(), successful);
                if let Some(fd) = opened_fd.get() {
                    // SAFETY: F_GETFD observes this saved descriptor number;
                    // it neither dereferences memory nor takes FD ownership.
                    assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
                    assert_eq!(
                        std::io::Error::last_os_error().raw_os_error(),
                        Some(libc::EBADF)
                    );
                }
                let snapshot = diagnostics.snapshot();
                assert_eq!(snapshot.path_metadata_operations, 1);
                assert_eq!(
                    snapshot.fd_metadata_operations,
                    u64::from(successful && !cancelled)
                );
                assert_eq!(verify.expires(), expiry);
                assert_eq!(fs::read(&fixture.path).unwrap(), b"current bytes");
                observations.push(serde_json::json!({
                    "successfulOpen":successful,"cancelled":cancelled,"error":error,
                    "openResults":open_results.get(),"fdClosed":successful,
                    "snapshot":snapshot,"expiryUnchanged":true
                }));
            }
        }
        retain("completed-open", serde_json::json!({"cases":observations}));
    }

    #[test]
    fn post_consume_check_precedes_next_read_or_final_metadata_and_keeps_chunks() {
        let mut observations = Vec::new();
        for size in [0, 17, 2 * 65536 + 17] {
            for cancelled in [false, true] {
                let bytes = vec![b'x'; size];
                let fixture = FileFixture::new(&bytes);
                let armed = Cell::new(false);
                let mut cancel = || {
                    if armed.get() {
                        Err("cancelled after chunk consumption".into())
                    } else {
                        Ok(())
                    }
                };
                let expiry = Instant::now() + Duration::from_secs(5);
                let mut read_results = Vec::new();
                let mut read_totals = Vec::new();
                let mut verify = Verification::new(expiry, &mut cancel);
                verify.on_read_result = Some(Box::new(|result| {
                    read_results.push(result.as_ref().ok().copied());
                }));
                verify.on_chunk = Some(Box::new(|path, total| {
                    assert_eq!(path, fixture.path);
                    read_totals.push(total);
                }));
                let mut consumed = Vec::new();
                let mut chunks = Vec::new();
                let diagnostics = VerificationDiagnostics::default();
                let result = verify.diagnosed(&diagnostics, |verify| {
                    read_regular(&fixture.path, None, None, verify, |chunk| {
                        chunks.push(chunk.len());
                        consumed.extend_from_slice(chunk);
                        armed.set(cancelled);
                    })
                });
                let snapshot = diagnostics.snapshot();
                assert_eq!(verify.expires(), expiry);
                drop(verify);
                if cancelled && size > 0 {
                    assert_eq!(result, Err("cancelled after chunk consumption".into()));
                    assert_eq!(chunks, vec![size.min(65536)]);
                    assert_eq!(read_results, vec![Some(size.min(65536))]);
                    assert_eq!(read_totals, vec![size.min(65536) as u64]);
                    assert_eq!(consumed, bytes[..size.min(65536)]);
                    assert_eq!(snapshot.path_metadata_operations, 1);
                    assert_eq!(snapshot.fd_metadata_operations, 1);
                } else {
                    assert_eq!(result, Ok(()));
                    assert_eq!(consumed, bytes);
                    assert_eq!(
                        chunks,
                        match size {
                            0 => vec![],
                            17 => vec![17],
                            _ => vec![65536, 65536, 17],
                        }
                    );
                    assert_eq!(read_totals.last().copied().unwrap_or(0), size as u64);
                    assert_eq!(
                        read_results,
                        chunks.iter().copied().map(Some).collect::<Vec<_>>()
                    );
                    assert_eq!(snapshot.path_metadata_operations, 2);
                    assert_eq!(snapshot.fd_metadata_operations, 2);
                }
                observations.push(serde_json::json!({
                    "size":size,"cancelled":cancelled,"result":result,
                    "actualReadResults":read_results,
                    "readTotals":read_totals,"consumedChunks":chunks,
                    "snapshot":snapshot,"expiryUnchanged":true
                }));
            }
        }
        retain("post-consume", serde_json::json!({"cases":observations}));
    }

    #[test]
    fn post_consume_expiry_uses_original_clock_before_final_metadata() {
        let fixture = FileFixture::new(b"last chunk");
        let expiry = Instant::now() + Duration::from_millis(250);
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expiry, &mut cancel);
        let diagnostics = VerificationDiagnostics::default();
        let consumed = Cell::new(0usize);
        let result = verify.diagnosed(&diagnostics, |verify| {
            read_regular(&fixture.path, None, None, verify, |chunk| {
                assert_eq!(chunk, b"last chunk");
                consumed.set(consumed.get() + 1);
                std::thread::sleep(
                    expiry.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
                );
            })
        });
        assert_eq!(result, Err("Runtime verification deadline expired".into()));
        assert_eq!(consumed.get(), 1);
        assert_eq!(verify.expires(), expiry);
        let snapshot = diagnostics.snapshot();
        assert_eq!(snapshot.path_metadata_operations, 1);
        assert_eq!(snapshot.fd_metadata_operations, 1);
        retain(
            "post-consume-expiry",
            serde_json::json!({
                "result":result,"consumedChunks":consumed.get(),"snapshot":snapshot,
                "expiryUnchanged":true
            }),
        );
    }
}
