//! Stable installed-entry adapter: pointer selection, argv and launch policy.
//!
//! Legacy compatibility delegates the later pointer read to its verified
//! bootstrap. A failed native invocation never takes that route.
use crate::installed_generation::{
    self, MAX_METADATA, Selection as GenerationSelection, Verification,
};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

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
#[derive(Debug)]
pub struct Selection {
    generation: GenerationSelection,
    // Compatibility projection for existing installed-entry callers. Launch
    // arguments and revalidation use the private verified generation directly.
    pub inspected_digest: String,
    expires: Instant,
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
        let pointer: Pointer = serde_json::from_slice(&installed_generation::read_metadata(
            home,
            "state/adapter-runtime.json",
            MAX_METADATA,
            &mut verify,
        )?)
        .map_err(|e| format!("Malformed runtime pointer: {e}"))?;
        if pointer.version != 1 || !installed_generation::valid_digest(&pointer.digest) {
            return Err("Malformed runtime pointer".into());
        }
        let generation = GenerationSelection::read_generation(home, &pointer.digest, &mut verify)?;
        Ok(Self {
            inspected_digest: generation.inspected_digest.clone(),
            generation,
            expires,
        })
    }

    pub(crate) fn command(&self, invocation: &Invocation) -> Result<Command, String> {
        // Recheck the selected generation, never the pointer. This detects changes
        // before this launch attempt; it does not claim custody of future imports.
        let mut cancel = || Ok(());
        let mut verify = Verification::new(self.expires, &mut cancel);
        self.generation.revalidate(&mut verify)?;
        if self.inspected_digest != self.generation.inspected_digest {
            return Err("Selected manifest changed before launch".into());
        }
        match self.generation.native_entry() {
            None => {
                let mut command = Command::new("python3");
                command
                    .arg(self.generation.member_path("bootstrap.py", &mut verify)?)
                    .args(&invocation.original);
                Ok(command)
            }
            Some(entry) => {
                let configuration = if invocation.system {
                    "system"
                } else {
                    "project"
                };
                let mut command = if invocation.describe {
                    let mut command = Command::new(
                        self.generation
                            .member_path(&entry.node_executable, &mut verify)?,
                    );
                    command.arg(
                        self.generation
                            .member_path(&entry.describe_entry, &mut verify)?,
                    );
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
                    let mut command = Command::new(
                        self.generation
                            .member_path(&entry.native_executable, &mut verify)?,
                    );
                    command
                        .arg("invoke")
                        .arg("--engine")
                        .arg(
                            self.generation
                                .member_path(&entry.engine_entry, &mut verify)?,
                        )
                        .arg("--node")
                        .arg(
                            self.generation
                                .member_path(&entry.node_executable, &mut verify)?,
                        )
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
