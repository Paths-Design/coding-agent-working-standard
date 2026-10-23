//! Verification of one exact installed runtime generation.
//!
//! This component never reads the current pointer or launches an entry. The
//! stable transport and original invoke receipt each retain their own expiry.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

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
    route: Route,
}

/// One caller-owned expiry and cancellation callback for the complete operation.
/// Checkpoints bracket bounded I/O; they cannot interrupt a stalled kernel syscall.
pub(crate) struct Verification<'a> {
    expires: Instant,
    cancel: &'a mut dyn FnMut() -> Result<(), String>,
    #[cfg(test)]
    pub(crate) on_chunk: Option<Box<dyn FnMut(&Path, u64) + 'a>>,
}
impl<'a> Verification<'a> {
    pub(crate) fn new(expires: Instant, cancel: &'a mut dyn FnMut() -> Result<(), String>) -> Self {
        Self {
            expires,
            cancel,
            #[cfg(test)]
            on_chunk: None,
        }
    }
    pub(crate) fn expires(&self) -> Instant {
        self.expires
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
    let result = fs::symlink_metadata(path);
    verify.checkpoint()?;
    result.map_err(|e| format!("Generation path unavailable {}: {e}", path.display()))
}
fn file_metadata(file: &File, verify: &mut Verification<'_>) -> Result<fs::Metadata, String> {
    verify.checkpoint()?;
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
fn open_regular(
    path: &Path,
    verify: &mut Verification<'_>,
) -> Result<(File, MemberMetadata), String> {
    let before = MemberMetadata::read(path, false, verify)?;
    verify.checkpoint()?;
    let result = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path);
    verify.checkpoint()?;
    let file = result.map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
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
    maximum: Option<u64>,
    verify: &mut Verification<'_>,
    mut consume: impl FnMut(&[u8]),
) -> Result<(), String> {
    let (mut file, before) = open_regular(path, verify)?;
    if maximum.is_some_and(|maximum| before.size > maximum) {
        return Err(format!("File exceeds bound: {}", path.display()));
    }
    let mut count = 0u64;
    let mut buffer = [0u8; 65536];
    while count < before.size {
        verify.checkpoint()?;
        let remaining = (before.size - count).min(buffer.len() as u64) as usize;
        let result = file.read(&mut buffer[..remaining]);
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
        consume(&buffer[..length]);
        verify.checkpoint()?;
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
    read_regular(path, Some(maximum), verify, |chunk| {
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
    if format!("{:x}", Sha256::digest(&bytes)) != *expected {
        return Err(format!("Runtime member integrity failure: {relative}"));
    }
    verify.checkpoint()?;
    Ok(bytes)
}

fn file_digest(path: &Path, verify: &mut Verification<'_>) -> Result<String, String> {
    let mut hash = Sha256::new();
    read_regular(path, None, verify, |chunk| hash.update(chunk))?;
    Ok(format!("{:x}", hash.finalize()))
}
fn verify_files(
    root: &Path,
    manifest: &BTreeMap<String, String>,
    verify: &mut Verification<'_>,
) -> Result<(), String> {
    // The already byte-bounded manifest determines every permitted directory.
    // Do not recurse into undeclared empty trees or invent a full-image byte cap.
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
    for (relative, expected) in manifest {
        verify.checkpoint()?;
        if !valid_digest(expected) {
            return Err(format!("Invalid member digest: {relative}"));
        }
        let file = confined(root, relative, verify)?;
        if file_digest(&file, verify)? != *expected {
            return Err(format!("Runtime member integrity failure: {relative}"));
        }
    }
    if manifest.contains_key(METADATA) {
        let modes: BTreeMap<String, u32> = serde_json::from_slice(&read_manifest_metadata(
            root,
            "native-modes.json",
            MAX_MANIFEST,
            manifest,
            verify,
        )?)
        .map_err(|e| format!("Malformed native mode inventory: {e}"))?;
        verify.checkpoint()?;
        if modes.keys().ne(manifest.keys()) || !manifest.contains_key("native/caws-hook-native") {
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
                    if !directories.contains(Path::new(&relative)) {
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
        verify_files(&root, &manifest, verify)?;
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
        if file_digest(&confined(&self.root, "manifest.json", verify)?, verify)?
            != self.inspected_digest
        {
            return Err("Selected manifest changed before launch".into());
        }
        verify_files(&self.root, &self.manifest, verify)
    }

    pub(crate) fn native_entry(&self) -> Option<&NativeEntry> {
        match &self.route {
            Route::Native(entry) => Some(entry),
            Route::Legacy => None,
        }
    }
}
