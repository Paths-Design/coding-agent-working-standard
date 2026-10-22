//! Staged installed entry: one native generation selection, without consuming hook stdin.
//!
//! Legacy compatibility deliberately delegates selection to the unchanged legacy
//! bootstrap. Its later pointer read, rather than this classification, determines
//! the executed legacy generation. A failed native invocation never takes that route.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

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
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn confined(root: &Path, relative: &str) -> Result<PathBuf, String> {
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
    let mut cursor = root.to_path_buf();
    for part in std::iter::once(None).chain(suffix.components().map(Some)) {
        if let Some(part) = part {
            cursor.push(part.as_os_str());
        }
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|e| format!("Generation path unavailable {}: {e}", cursor.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("Refusing symlink: {}", cursor.display()));
        }
    }
    Ok(cursor)
}
fn open_regular(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err(format!("Not a regular file: {}", path.display()));
    }
    Ok(file)
}
fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    open_regular(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > maximum {
        return Err(format!("File exceeds bound: {}", path.display()));
    }
    Ok(bytes)
}
fn file_digest(path: &Path) -> Result<String, String> {
    let mut input = open_regular(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let length = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn verify_files(root: &Path, manifest: &BTreeMap<String, String>) -> Result<(), String> {
    for (relative, expected) in manifest {
        if !valid_digest(expected) {
            return Err(format!("Invalid member digest: {relative}"));
        }
        let file = confined(root, relative)?;
        if file_digest(&file)? != *expected {
            return Err(format!("Runtime member integrity failure: {relative}"));
        }
    }
    if manifest.contains_key(METADATA) {
        let modes: BTreeMap<String, u32> = serde_json::from_slice(&read_bounded(
            &confined(root, "native-modes.json")?,
            MAX_MANIFEST,
        )?)
        .map_err(|e| format!("Malformed native mode inventory: {e}"))?;
        if modes.keys().ne(manifest.keys()) || !manifest.contains_key("native/caws-hook-native") {
            return Err(
                "Native mode inventory differs from manifest or lacks entry identity".into(),
            );
        }
        fn visit(
            root: &Path,
            current: &Path,
            actual: &mut Vec<String>,
            modes: &BTreeMap<String, u32>,
        ) -> Result<(), String> {
            for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                let stat = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                if stat.is_dir() {
                    visit(root, &path, actual, modes)?;
                } else {
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_str()
                        .ok_or("Native image paths must be UTF-8")?
                        .to_owned();
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
                    actual.push(relative);
                }
            }
            Ok(())
        }
        let mut actual = Vec::new();
        visit(root, root, &mut actual, &modes)?;
        actual.sort();
        if actual.iter().ne(manifest.keys()) {
            return Err("Native runtime inventory differs from manifest".into());
        }
    }
    Ok(())
}

impl Selection {
    pub fn read(home: &Path) -> Result<Self, String> {
        if !home.is_absolute() {
            return Err("CAWS_HOME must be absolute".into());
        }
        let pointer_file = confined(home, "state/adapter-runtime.json")?;
        let pointer: Pointer = serde_json::from_slice(&read_bounded(&pointer_file, MAX_METADATA)?)
            .map_err(|e| format!("Malformed runtime pointer: {e}"))?;
        if pointer.version != 1 || !valid_digest(&pointer.digest) {
            return Err("Malformed runtime pointer".into());
        }
        let root = confined(home, &format!("lib/runtimes/{}", pointer.digest))?;
        let manifest_file = confined(&root, "manifest.json")?;
        let bytes = read_bounded(&manifest_file, MAX_MANIFEST)?;
        if format!("{:x}", Sha256::digest(&bytes)) != pointer.digest {
            return Err("Runtime manifest integrity failure".into());
        }
        let manifest: BTreeMap<String, String> = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Malformed runtime manifest: {e}"))?;
        if !manifest
            .get("launcher.py")
            .is_some_and(|value| valid_digest(value))
        {
            return Err("Version-1 manifest lacks the legacy driver identity".into());
        }
        verify_files(&root, &manifest)?;
        let route = if manifest.contains_key(METADATA) {
            let entry: NativeEntry =
                serde_json::from_slice(&read_bounded(&confined(&root, METADATA)?, MAX_METADATA)?)
                    .map_err(|e| format!("Malformed native entry: {e}"))?;
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
                confined(&root, name)?;
            }
            for name in [&entry.native_executable, &entry.node_executable] {
                if fs::metadata(confined(&root, name)?)
                    .map_err(|e| e.to_string())?
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
            if fs::symlink_metadata(root.join(METADATA)).is_ok() {
                return Err(
                    "Untracked native entry metadata cannot select legacy compatibility".into(),
                );
            }
            if !manifest.contains_key("bootstrap.py") {
                return Err("Unrecognized legacy generation: no verified bootstrap".into());
            }
            Route::Legacy {
                bootstrap: confined(&root, "bootstrap.py")?,
            }
        };
        Ok(Self {
            root,
            inspected_digest: pointer.digest,
            manifest,
            route,
        })
    }

    pub(crate) fn command(&self, invocation: &Invocation) -> Result<Command, String> {
        // Recheck the selected generation, never the pointer. This detects changes
        // before this launch attempt; it does not claim custody of future imports.
        if file_digest(&confined(&self.root, "manifest.json")?)? != self.inspected_digest {
            return Err("Selected manifest changed before launch".into());
        }
        verify_files(&self.root, &self.manifest)?;
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
                    let mut command = Command::new(confined(&self.root, &entry.node_executable)?);
                    command.arg(confined(&self.root, &entry.describe_entry)?);
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
                    let mut command = Command::new(confined(&self.root, &entry.native_executable)?);
                    command
                        .arg("invoke")
                        .arg("--engine")
                        .arg(confined(&self.root, &entry.engine_entry)?)
                        .arg("--node")
                        .arg(confined(&self.root, &entry.node_executable)?)
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
