//! Staged installed entry: one native generation selection, without consuming hook stdin.
//!
//! Legacy compatibility deliberately delegates selection to the unchanged legacy
//! bootstrap. Its later pointer read, rather than this classification, determines
//! the executed legacy generation. A failed native invocation never takes that route.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const SCHEMA: &str = "caws.runtime.native-entry.v1";
const METADATA: &str = "native-entry.json";
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_METADATA: u64 = 64 * 1024;
const SURFACES: &[&str] = &[
    "codex",
    "claude-code",
    "kimi-code",
    "qwen-code",
    "zcode",
    "opencode",
    "dsh",
];
const EVENTS: &[&str] = &[
    "pre_tool_use",
    "post_tool_use",
    "session_start",
    "stop",
    "pre_compact",
    "session_end",
];

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub surface: String,
    pub event: String,
    pub system: bool,
    pub describe: bool,
    original: Vec<String>,
}
impl Invocation {
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let usage = "Usage: caws-hook-native <surface> <pre_tool_use|post_tool_use|session_start|stop|pre_compact|session_end> [--system] [--describe]";
        if args.len() < 2
            || !SURFACES.contains(&args[0].as_str())
            || !EVENTS.contains(&args[1].as_str())
        {
            return Err(usage.into());
        }
        let mut system = false;
        let mut describe = false;
        for argument in &args[2..] {
            match argument.as_str() {
                "--system" if !system => system = true,
                "--describe" if !describe => describe = true,
                _ => return Err(usage.into()),
            }
        }
        Ok(Self {
            surface: args[0].clone(),
            event: args[1].clone(),
            system,
            describe,
            original: args.to_vec(),
        })
    }
}

#[derive(Deserialize)]
struct Pointer {
    version: u64,
    digest: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeEntry {
    schema: String,
    native_executable: String,
    node_executable: String,
    engine_entry: String,
    describe_entry: String,
    timeout_ms: u64,
}
#[derive(Debug)]
enum Route {
    Native(NativeEntry),
    /// This is a compatibility classification, not an executed-generation witness.
    Legacy {
        bootstrap: PathBuf,
    },
}
#[derive(Debug)]
pub struct Selection {
    root: PathBuf,
    pub inspected_digest: String,
    manifest: BTreeMap<String, String>,
    route: Route,
    expires: Instant,
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
fn valid_digest(value: &str) -> bool {
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
        let mode_file = confined(root, "native-modes.json", verify)?;
        let modes: BTreeMap<String, u32> =
            serde_json::from_slice(&read_bounded(&mode_file, MAX_MANIFEST, verify)?)
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
    pub fn read(home: &Path) -> Result<Self, String> {
        // The installed entry precedes Config. Reuse its existing maximum
        // native timeout; command revalidation retains this original expiry.
        let expires = Instant::now() + Duration::from_millis(120_000);
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expires, &mut cancel);
        verify.checkpoint()?;
        if !home.is_absolute() {
            return Err("CAWS_HOME must be absolute".into());
        }
        let pointer_file = confined(home, "state/adapter-runtime.json", &mut verify)?;
        let pointer: Pointer =
            serde_json::from_slice(&read_bounded(&pointer_file, MAX_METADATA, &mut verify)?)
                .map_err(|e| format!("Malformed runtime pointer: {e}"))?;
        if pointer.version != 1 || !valid_digest(&pointer.digest) {
            return Err("Malformed runtime pointer".into());
        }
        Self::read_generation(home, &pointer.digest, &mut verify)
    }

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
        let manifest_file = confined(&root, "manifest.json", verify)?;
        let bytes = read_bounded(&manifest_file, MAX_MANIFEST, verify)?;
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
            let entry: NativeEntry = serde_json::from_slice(&read_bounded(
                &confined(&root, METADATA, verify)?,
                MAX_METADATA,
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
            Route::Legacy {
                bootstrap: confined(&root, "bootstrap.py", verify)?,
            }
        };
        verify.checkpoint()?;
        Ok(Self {
            root,
            inspected_digest: digest.to_owned(),
            manifest,
            route,
            expires: verify.expires,
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
        let Route::Native(entry) = &self.route else {
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

    pub(crate) fn command(&self, invocation: &Invocation) -> Result<Command, String> {
        // Recheck the selected generation, never the pointer. This detects changes
        // before this launch attempt; it does not claim custody of future imports.
        let mut cancel = || Ok(());
        let mut verify = Verification::new(self.expires, &mut cancel);
        self.revalidate(&mut verify)?;
        match &self.route {
            Route::Legacy { bootstrap } => {
                let mut command = Command::new("python3");
                command.arg(bootstrap).args(&invocation.original);
                Ok(command)
            }
            Route::Native(entry) => {
                let configuration = if invocation.system {
                    "system"
                } else {
                    "project"
                };
                let mut command = if invocation.describe {
                    let mut command =
                        Command::new(confined(&self.root, &entry.node_executable, &mut verify)?);
                    command.arg(confined(&self.root, &entry.describe_entry, &mut verify)?);
                    // Transport original context as inert data before removing loader inputs.
                    // The entry overwrites any caller-supplied value of this private channel.
                    let environment = std::env::vars_os()
                        .map(|(name, value)| {
                            Ok((
                                name.into_string()
                                    .map_err(|_| "Environment names must be UTF-8")?,
                                value
                                    .into_string()
                                    .map_err(|_| "Environment values must be UTF-8")?,
                            ))
                        })
                        .collect::<Result<BTreeMap<_, _>, String>>()?;
                    let context = serde_json::to_string(&serde_json::json!({
                        "cwd": std::env::current_dir().map_err(|e| e.to_string())?,
                        "environment": environment,
                    }))
                    .map_err(|e| e.to_string())?;
                    if context.len() > 128 * 1024 {
                        return Err("Describe context exceeds transport bound".into());
                    }
                    for name in environment.keys() {
                        if name == "NODE_OPTIONS"
                            || name == "NODE_PATH"
                            || name.starts_with("LD_")
                            || name.starts_with("DYLD_")
                        {
                            command.env_remove(name);
                        }
                    }
                    command.env("CAWS_NATIVE_DESCRIBE_CONTEXT", context);
                    command
                } else {
                    let mut command =
                        Command::new(confined(&self.root, &entry.native_executable, &mut verify)?);
                    command
                        .arg("invoke")
                        .arg("--engine")
                        .arg(confined(&self.root, &entry.engine_entry, &mut verify)?)
                        .arg("--node")
                        .arg(confined(&self.root, &entry.node_executable, &mut verify)?)
                        .arg("--timeout-ms")
                        .arg(entry.timeout_ms.to_string());
                    command
                };
                command
                    .arg("--surface")
                    .arg(&invocation.surface)
                    .arg("--event")
                    .arg(&invocation.event)
                    .arg("--runtime-digest")
                    .arg(&self.inspected_digest)
                    .arg("--configuration")
                    .arg(configuration);
                Ok(command)
            }
        }
    }
}

fn configuration_failure(invocation: &Invocation, error: &str) -> u8 {
    let message = format!("CAWS native installed entry: {error}");
    let _ = writeln!(std::io::stderr(), "[{message}]");
    if invocation.event == "pre_tool_use" {
        let _ = writeln!(
            std::io::stdout(),
            "{}",
            serde_json::json!({"decision":"block", "reason":message})
        );
        2
    } else {
        0
    }
}

pub fn run() -> u8 {
    let arguments = std::env::args_os()
        .skip(1)
        .map(|value| value.into_string())
        .collect::<Result<Vec<_>, _>>();
    let invocation = match arguments
        .map_err(|_| "Invocation arguments must be UTF-8".to_owned())
        .and_then(|args| Invocation::parse(&args))
    {
        Ok(value) => value,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "[CAWS native installed entry] {error}");
            return 2;
        }
    };
    let result = (|| {
        let home = std::env::var_os("CAWS_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".caws")))
            .ok_or("Machine home is unavailable")?;
        let selected = Selection::read(&home)?;
        let mut command = selected.command(&invocation)?;
        // exec retains the caller's PID, cwd and stdio; the selected native
        // frontend captures the original environment before sanitizing Node.
        Err::<(), String>(format!("Selected entry launch failed: {}", command.exec()))
    })();
    configuration_failure(&invocation, &result.unwrap_err())
}
