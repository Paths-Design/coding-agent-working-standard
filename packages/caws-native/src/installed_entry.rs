//! Stable installed-entry adapter: pointer selection, argv and launch policy.
//!
//! Legacy compatibility delegates the later pointer read to its verified
//! bootstrap. A failed native invocation never takes that route.
use crate::installed_generation::{
    self, MAX_METADATA, Selection as GenerationSelection, Verification,
};
use caws_native::monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "installed_compatibility.rs"]
mod compatibility;

const ORIGINAL_TIMEOUT_MS: u64 = installed_generation::MAX_ORIGINAL_TIMEOUT_MS;

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
    fn failure_event(&self) -> &str {
        if self.describe {
            "describe"
        } else {
            &self.event
        }
    }

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
// Ephemeral description data, never a deadline constructor or dispatch carrier.
// Fixed fields keep phase estimates, selector data and authority out of this view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DescribeDeadlineEnvelope {
    started_ns: String,
    expires_ns: String,
}

#[derive(Serialize)]
struct DescribeDeadlineObservation {
    original: DescribeDeadlineEnvelope,
    selected: Option<DescribeDeadlineEnvelope>,
}

fn describe_deadline_observation(
    original: &MonotonicDeadline,
    selected: Option<&MonotonicDeadline>,
) -> DescribeDeadlineObservation {
    fn observed(deadline: &MonotonicDeadline) -> DescribeDeadlineEnvelope {
        let envelope = deadline.envelope();
        DescribeDeadlineEnvelope {
            started_ns: envelope.started_ns.to_string(),
            expires_ns: envelope.expires_ns.to_string(),
        }
    }
    DescribeDeadlineObservation {
        original: observed(original),
        selected: selected.map(observed),
    }
}

#[derive(Debug)]
pub struct Selection {
    generation: GenerationSelection,
    // Compatibility projection for existing installed-entry callers. Launch
    // arguments and revalidation use the private verified generation directly.
    pub inspected_digest: String,
    original_deadline: Arc<MonotonicDeadline>,
    policy_deadline: Option<Arc<MonotonicDeadline>>,
}
struct SelectionFailure {
    message: String,
    // Keep the global clock even when selection creates an earlier policy bound.
    original_deadline: Arc<MonotonicDeadline>,
    // None means the selected policy could not yield a live delivery clock.
    // It never authorizes a fresh clock or a best-effort post-expiry write.
    delivery_deadline: Option<Arc<MonotonicDeadline>>,
}
impl Selection {
    pub fn read(home: &Path) -> Result<Self, String> {
        let deadline = MonotonicDeadline::capture(Duration::from_millis(ORIGINAL_TIMEOUT_MS))
            .map_err(|e| e.to_string())?;
        Self::read_with_deadline(home, deadline)
    }

    /// The run entry captures this clock before argument, pointer or generation
    /// work. This API accepts only an existing restriction, never ambient data.
    pub(crate) fn read_with_deadline(
        home: &Path,
        original_deadline: MonotonicDeadline,
    ) -> Result<Self, String> {
        Self::read_with_shared_deadline(home, Arc::new(original_deadline))
            .map_err(|failure| failure.message)
    }

    fn read_with_shared_deadline(
        home: &Path,
        original_deadline: Arc<MonotonicDeadline>,
    ) -> Result<Self, SelectionFailure> {
        let before_policy = |message: String| SelectionFailure {
            message,
            original_deadline: Arc::clone(&original_deadline),
            delivery_deadline: Some(Arc::clone(&original_deadline)),
        };
        original_deadline
            .check()
            .map_err(|e| before_policy(e.to_string()))?;
        let original = original_deadline.envelope();
        if original.expires_ns - original.started_ns > ORIGINAL_TIMEOUT_MS * 1_000_000 {
            return Err(before_policy(
                "Installed entry original interval exceeds 30000ms".into(),
            ));
        }
        let generation = (|| -> Result<GenerationSelection, String> {
            let mut cancel = || original_deadline.check().map_err(|e| e.to_string());
            let mut verify = Verification::new(original_deadline.expires(), &mut cancel);
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
            GenerationSelection::read_generation(home, &pointer.digest, &mut verify)
        })()
        .map_err(before_policy)?;
        // Verified metadata may shorten the original 30s maximum from the same
        // start. Capability admission remains separate from recognizing v1.
        let policy_deadline = if let Some(entry) = generation.native_entry() {
            let configured = entry.timeout_ms.min(ORIGINAL_TIMEOUT_MS);
            let expires_ns = original
                .started_ns
                .checked_add(configured * 1_000_000)
                .ok_or_else(|| SelectionFailure {
                    message: "Installed entry deadline overflow".into(),
                    original_deadline: Arc::clone(&original_deadline),
                    delivery_deadline: None,
                })?
                .min(original.expires_ns);
            if expires_ns < original.expires_ns {
                Some(Arc::new(
                    MonotonicDeadline::receive(DeadlineEnvelope {
                        started_ns: original.started_ns,
                        expires_ns,
                    })
                    .map_err(|e| SelectionFailure {
                        message: e.to_string(),
                        original_deadline: Arc::clone(&original_deadline),
                        delivery_deadline: None,
                    })?,
                ))
            } else {
                None
            }
        } else {
            None
        };
        let selected = Self {
            inspected_digest: generation.inspected_digest.clone(),
            generation,
            original_deadline,
            policy_deadline,
        };
        selected.checkpoint().map_err(|message| SelectionFailure {
            message,
            original_deadline: Arc::clone(&selected.original_deadline),
            delivery_deadline: Some(Arc::clone(selected.delivery_deadline())),
        })?;
        Ok(selected)
    }

    fn delivery_deadline(&self) -> &Arc<MonotonicDeadline> {
        self.policy_deadline
            .as_ref()
            .unwrap_or(&self.original_deadline)
    }

    fn checkpoint(&self) -> Result<(), String> {
        self.original_deadline.check().map_err(|e| e.to_string())?;
        if let Some(policy) = &self.policy_deadline {
            policy.check().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn expires(&self) -> Instant {
        self.policy_deadline
            .as_ref()
            .map_or(self.original_deadline.expires(), |policy| {
                policy.expires().min(self.original_deadline.expires())
            })
    }

    fn forwarded_deadline(&self) -> DeadlineEnvelope {
        self.policy_deadline
            .as_ref()
            .unwrap_or(&self.original_deadline)
            .envelope()
    }

    pub(crate) fn command(&self, invocation: &Invocation) -> Result<Command, String> {
        // Recheck the selected generation, never the pointer. This detects changes
        // before this launch attempt; it does not claim custody of future imports.
        self.checkpoint()?;
        let mut cancel = || self.checkpoint();
        let mut verify = Verification::new(self.expires(), &mut cancel);
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
                // run retains the original clock while supervising compatibility.
                self.checkpoint()?;
                Ok(command)
            }
            Some(entry) => {
                let configuration = if invocation.system {
                    "system"
                } else {
                    "project"
                };
                let mut command = if invocation.describe {
                    // run supervises describe with the selected original clock.
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
                        "deadlineObservation": describe_deadline_observation(
                            &self.original_deadline, self.policy_deadline.as_deref(),
                        ),
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
                    // Admit from the already verified selected metadata before
                    // constructing a native command. Never probe or retry v1.
                    let entry = self.generation.installed_invocation_entry()?;
                    let mut command = Command::new(
                        self.generation
                            .member_path(&entry.native_executable, &mut verify)?,
                    );
                    command
                        .arg("invoke-installed-v1")
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
                        .arg(entry.timeout_ms.min(ORIGINAL_TIMEOUT_MS).to_string());
                    // Forward only the retained native clock and selected digest.
                    // Ambient environment cannot renew or replace this carrier;
                    // an unsupported or failed receiver is never retried.
                    let deadline = self.forwarded_deadline();
                    command.arg("--original-deadline").arg(
                        serde_json::to_string(&serde_json::json!({
                            "startedNs": deadline.started_ns.to_string(),
                            "expiresNs": deadline.expires_ns.to_string(),
                            "runtimeDigest": self.inspected_digest,
                        }))
                        .map_err(|e| e.to_string())?,
                    );
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
                self.checkpoint()?;
                Ok(command)
            }
        }
    }
}

fn configuration_failure(
    invocation: &Invocation,
    error: &str,
    original: Option<&MonotonicDeadline>,
    policy: Option<&MonotonicDeadline>,
) -> u8 {
    compatibility::refuse_before_dispatch(invocation.failure_event(), error, original, policy)
}

pub fn run() -> u8 {
    // Capture before argument decoding, machine-home or generation lookup.
    let original_deadline = MonotonicDeadline::capture(Duration::from_millis(ORIGINAL_TIMEOUT_MS));
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
            return compatibility::refuse_before_dispatch(
                "invalid-invocation",
                &error,
                original_deadline.as_ref().ok(),
                None,
            );
        }
    };
    let original_deadline = match original_deadline {
        Ok(deadline) => Arc::new(deadline),
        Err(error) => return configuration_failure(&invocation, &error.to_string(), None, None),
    };
    let home = match std::env::var_os("CAWS_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".caws")))
    {
        Some(home) => home,
        None => {
            return configuration_failure(
                &invocation,
                "Machine home is unavailable",
                Some(&original_deadline),
                None,
            );
        }
    };
    let selected = match Selection::read_with_shared_deadline(&home, original_deadline) {
        Ok(selected) => selected,
        Err(failure) => {
            return match failure.delivery_deadline {
                Some(deadline) => configuration_failure(
                    &invocation,
                    &failure.message,
                    Some(&failure.original_deadline),
                    Some(&deadline),
                ),
                // An expired/invalid selected clock cannot authorize delivery.
                None => compatibility::failure_status(invocation.failure_event()),
            };
        }
    };
    let mut command = match selected.command(&invocation).and_then(|command| {
        selected.checkpoint()?;
        Ok(command)
    }) {
        Ok(command) => command,
        Err(error) => {
            return configuration_failure(
                &invocation,
                &error,
                Some(&selected.original_deadline),
                selected.policy_deadline.as_deref(),
            );
        }
    };
    if selected.generation.native_entry().is_some() && !invocation.describe {
        // Native dispatch preserves PID, cwd and stdio. Its receiver consumes
        // the exact original-clock carrier already bound into this command.
        let error = format!("Selected entry launch failed: {}", command.exec());
        configuration_failure(
            &invocation,
            &error,
            Some(&selected.original_deadline),
            selected.policy_deadline.as_deref(),
        )
    } else {
        compatibility::run(
            command,
            &selected.original_deadline,
            selected.policy_deadline.as_deref(),
            invocation.failure_event(),
        )
    }
}

#[cfg(test)]
mod deadline_observation_tests {
    use super::*;

    #[test]
    fn observes_retained_original_and_restricted_selected_without_renewal() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let original_envelope = original.envelope();
        let original_local_expiry = original.expires();
        let selected_envelope = DeadlineEnvelope {
            started_ns: original_envelope.started_ns,
            expires_ns: original_envelope
                .started_ns
                .checked_add(1_200_000_000)
                .unwrap(),
        };
        let selected = MonotonicDeadline::receive(selected_envelope).unwrap();
        let selected_local_expiry = selected.expires();

        let observation =
            serde_json::to_value(describe_deadline_observation(&original, Some(&selected)))
                .unwrap();

        // Exact object equality also rejects numeric timestamps, extra phase
        // estimates, authority fields and unrelated caller context.
        assert_eq!(
            observation,
            serde_json::json!({
                "original": {
                    "startedNs": original_envelope.started_ns.to_string(),
                    "expiresNs": original_envelope.expires_ns.to_string(),
                },
                "selected": {
                    "startedNs": selected_envelope.started_ns.to_string(),
                    "expiresNs": selected_envelope.expires_ns.to_string(),
                },
            })
        );
        assert_ne!(
            observation["original"]["expiresNs"],
            observation["selected"]["expiresNs"]
        );
        assert_eq!(original.envelope(), original_envelope);
        assert_eq!(original.expires(), original_local_expiry);
        assert_eq!(selected.envelope(), selected_envelope);
        assert_eq!(selected.expires(), selected_local_expiry);
    }

    #[test]
    fn absent_selected_is_null_and_does_not_duplicate_or_renew_original() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let original_envelope = original.envelope();
        let original_local_expiry = original.expires();

        let observation =
            serde_json::to_value(describe_deadline_observation(&original, None)).unwrap();

        assert_eq!(
            observation,
            serde_json::json!({
                "original": {
                    "startedNs": original_envelope.started_ns.to_string(),
                    "expiresNs": original_envelope.expires_ns.to_string(),
                },
                "selected": null,
            })
        );
        assert!(observation["selected"].is_null());
        assert_eq!(original.envelope(), original_envelope);
        assert_eq!(original.expires(), original_local_expiry);
    }
}
