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
