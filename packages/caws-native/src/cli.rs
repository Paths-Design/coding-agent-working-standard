use caws_native::monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline};
use serde::Deserialize;
use std::{collections::HashMap, path::PathBuf, time::Duration};

pub const EVENTS: &[&str] = &[
    "pre_tool_use",
    "post_tool_use",
    "session_start",
    "stop",
    "pre_compact",
    "session_end",
];
// This is the machine runtime's supported subset of the canonical registry.
pub const SURFACES: &[&str] = &[
    "codex",
    "claude-code",
    "kimi-code",
    "qwen-code",
    "zcode",
    "opencode",
    "dsh",
];

pub struct Config {
    pub engine: PathBuf,
    pub node: PathBuf,
    pub surface: String,
    pub event: String,
    pub configuration: String,
    pub digest: String,
    pub timeout: Duration,
}

impl Config {
    pub fn parse(args: &[String]) -> Result<Self, String> {
        if args.first().map(String::as_str) != Some("invoke") || args.len() != 15 {
            return Err("usage: caws-native invoke --engine <absolute JS> --node <absolute Node> --surface <surface> --event <event> --runtime-digest <64lowerhex> --timeout-ms <1..120000> --configuration <system|project>".into());
        }
        let mut flags = HashMap::new();
        for pair in args[1..].chunks_exact(2) {
            if ![
                "--engine",
                "--node",
                "--surface",
                "--event",
                "--runtime-digest",
                "--timeout-ms",
                "--configuration",
            ]
            .contains(&pair[0].as_str())
                || flags.insert(pair[0].as_str(), pair[1].as_str()).is_some()
            {
                return Err("unknown or duplicate option".into());
            }
        }
        let get = |name| {
            flags
                .get(name)
                .copied()
                .ok_or_else(|| format!("missing {name}"))
        };
        let engine = PathBuf::from(get("--engine")?);
        let node = PathBuf::from(get("--node")?);
        if !engine.is_absolute() || !node.is_absolute() {
            return Err("engine and Node paths must be absolute".into());
        }
        let surface = get("--surface")?;
        let event = get("--event")?;
        if !SURFACES.contains(&surface) || !EVENTS.contains(&event) {
            return Err("unsupported runtime surface or event".into());
        }
        let configuration = get("--configuration")?;
        if !["system", "project"].contains(&configuration) {
            return Err("unsupported runtime entry configuration".into());
        }
        let digest = get("--runtime-digest")?;
        if !valid_digest(digest) {
            return Err("runtime digest must be 64 lowercase hexadecimal characters".into());
        }
        let timeout = get("--timeout-ms")?
            .parse::<u64>()
            .map_err(|_| "invalid timeout")?;
        if !(1..=120_000).contains(&timeout) {
            return Err("timeout must be in 1..120000 milliseconds".into());
        }
        Ok(Self {
            engine,
            node,
            surface: surface.into(),
            event: event.into(),
            configuration: configuration.into(),
            digest: digest.into(),
            timeout: Duration::from_millis(timeout),
        })
    }
}

/// A single invocation clock. Installed transport restricts timing and binds
/// the selected generation; this data never grants origin or dispatch authority.
pub struct Invocation {
    pub config: Config,
    pub deadline: MonotonicDeadline,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledDeadline {
    started_ns: String,
    expires_ns: String,
    runtime_digest: String,
}

fn canonical_u64(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("installed original deadline requires canonical decimal strings".into());
    }
    value
        .parse()
        .map_err(|_| "installed original deadline integer overflow".into())
}

impl Invocation {
    pub fn parse(args: &[String]) -> Result<Self, String> {
        if args.first().map(String::as_str) != Some("invoke-installed-v1") {
            let config = Config::parse(args)?;
            let deadline = MonotonicDeadline::capture(config.timeout).map_err(|e| e.to_string())?;
            return Ok(Self { config, deadline });
        }
        if args.len() != 17 {
            return Err("invoke-installed-v1 requires the existing invoke flags and one --original-deadline".into());
        }
        let mut ordinary = vec!["invoke".to_owned()];
        let mut original = None;
        for pair in args[1..].chunks_exact(2) {
            if pair[0] == "--original-deadline" {
                if original.replace(pair[1].as_str()).is_some() {
                    return Err("duplicate installed --original-deadline".into());
                }
            } else {
                ordinary.extend_from_slice(pair);
            }
        }
        let original = original.ok_or("missing installed --original-deadline")?;
        if original.len() > 512 {
            return Err("installed original deadline exceeds 512 bytes".into());
        }
        let config = Config::parse(&ordinary)?;
        if config.timeout > Duration::from_millis(30_000) {
            return Err("installed timeout exceeds 30000ms".into());
        }
        let value: InstalledDeadline = serde_json::from_str(original)
            .map_err(|e| format!("invalid installed original deadline: {e}"))?;
        if value.runtime_digest != config.digest {
            return Err("installed original deadline runtime digest differs".into());
        }
        let envelope = DeadlineEnvelope {
            started_ns: canonical_u64(&value.started_ns)?,
            expires_ns: canonical_u64(&value.expires_ns)?,
        };
        let interval = envelope
            .expires_ns
            .checked_sub(envelope.started_ns)
            .filter(|value| *value > 0)
            .ok_or("installed original deadline interval must be positive")?;
        if Duration::from_nanos(interval) > config.timeout {
            return Err("installed original deadline interval exceeds configured timeout".into());
        }
        // Receive exactly once. Invalid, expired or future input never selects
        // capture(), and ambient environment never supplies a missing handoff.
        let deadline = MonotonicDeadline::receive(envelope)
            .map_err(|e| format!("invalid installed original deadline: {e}"))?;
        Ok(Self { config, deadline })
    }
}

pub fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args() -> Vec<String> {
        [
            "invoke",
            "--engine",
            "/engine.js",
            "--node",
            "/node",
            "--surface",
            "codex",
            "--event",
            "pre_tool_use",
            "--runtime-digest",
            &"a".repeat(64),
            "--timeout-ms",
            "1000",
            "--configuration",
            "system",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }
    #[test]
    fn validates_runtime_domain_and_bounds() {
        assert!(Config::parse(&args()).is_ok());
        for (index, values) in [
            (6, vec!["cursor", "windsurf", "none", "claude"]),
            (8, vec!["unknown", "PreToolUse"]),
            (10, vec!["", "A", &"A".repeat(64)]),
            (12, vec!["0", "120001", "-1", "NaN"]),
            (2, vec!["relative.js"]),
            (14, vec!["legacy", "true", ""]),
        ] {
            for value in values {
                let mut input = args();
                input[index] = value.into();
                assert!(Config::parse(&input).is_err(), "{value}");
            }
        }
        let mut duplicate = args();
        duplicate[11] = "--node".into();
        assert!(Config::parse(&duplicate).is_err());
        let mut project = args();
        project[14] = "project".into();
        assert_eq!(Config::parse(&project).unwrap().configuration, "project");
    }
}

#[cfg(test)]
mod installed_deadline_tests {
    use super::*;
    use caws_native::monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline};
    use std::time::{Duration, Instant};

    fn args(envelope: DeadlineEnvelope, timeout: u64) -> Vec<String> {
        let original = serde_json::json!({
            "startedNs": envelope.started_ns.to_string(),
            "expiresNs": envelope.expires_ns.to_string(),
            "runtimeDigest": "a".repeat(64),
        })
        .to_string();
        [
            "invoke-installed-v1",
            "--engine",
            "/engine.js",
            "--node",
            "/node",
            "--surface",
            "codex",
            "--event",
            "pre_tool_use",
            "--runtime-digest",
            &"a".repeat(64),
            "--timeout-ms",
            &timeout.to_string(),
            "--configuration",
            "system",
            "--original-deadline",
            &original,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }

    #[test]
    fn installed_receive_preserves_exact_envelope_and_consumes_transit() {
        let original = MonotonicDeadline::capture(Duration::from_secs(30))
            .unwrap()
            .envelope();
        let envelope = DeadlineEnvelope {
            started_ns: original.started_ns - 1_000_000_000,
            expires_ns: original.expires_ns - 1_000_000_000,
        };
        let received = Invocation::parse(&args(envelope, 30_000)).unwrap();
        assert_eq!(received.deadline.envelope(), envelope);
        assert_eq!(received.config.timeout, Duration::from_secs(30));
        received.deadline.check().unwrap();
        assert!(
            received.deadline.expires().duration_since(Instant::now()) <= Duration::from_secs(29)
        );
    }

    #[test]
    fn installed_interval_is_exact_nanoseconds_not_rounded_milliseconds() {
        let original = MonotonicDeadline::capture(Duration::from_secs(1))
            .unwrap()
            .envelope();
        assert!(Invocation::parse(&args(original, 1000)).is_ok());
        let larger = DeadlineEnvelope {
            expires_ns: original.expires_ns + 1,
            ..original
        };
        assert!(
            Invocation::parse(&args(larger, 1000))
                .err()
                .unwrap()
                .contains("interval exceeds configured timeout")
        );
    }

    #[test]
    fn canonical_integer_domain_keeps_u64_exact_without_whitespace_or_signs() {
        assert_eq!(canonical_u64("0").unwrap(), 0);
        assert_eq!(canonical_u64("18446744073709551615").unwrap(), u64::MAX);
        for bad in [
            "",
            "00",
            "01",
            "+1",
            "-1",
            " 1",
            "1 ",
            "1\n",
            "1.0",
            "1e3",
            "１２",
            "18446744073709551616",
        ] {
            assert!(canonical_u64(bad).is_err(), "{bad:?}");
        }
    }
}
