//! Strict native view of the immutable producer record. Decoding is not provenance.
//! The original bytes, rather than a reserialization, cross both authorizer phases.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

pub(crate) const RECORD_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProgramImage {
    pub path: String,
    pub sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Association {
    pub kind: String,
    pub session_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub caller_anchor: String,
    pub server_environment_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EnvironmentEntry {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Execution {
    pub executable: ProgramImage,
    pub argv: Vec<String>,
    pub cwd: String,
    pub environment: Vec<EnvironmentEntry>,
    pub stdin_base64: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    pub kind: String,
    pub source: String,
    pub utilities: Vec<ProgramImage>,
    #[serde(default)]
    pub npm: Option<NpmProfile>,
    #[serde(default)]
    pub cargo: Option<CargoProfile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CargoProfile {
    pub runtime: CargoRuntime,
    pub project: CargoProject,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CargoRuntime {
    pub cargo: ProgramImage,
    pub rustc: ProgramImage,
    pub linker: ProgramImage,
    pub root: String,
    pub sdk_root: String,
    pub toolchain_version: String,
    pub generation_manifest_sha256: String,
}
impl CargoRuntime {
    pub(crate) fn valid(&self) -> bool {
        image(&self.cargo)
            && image(&self.rustc)
            && image(&self.linker)
            && path(&self.root)
            && path(&self.sdk_root)
            && numeric_version(&self.toolchain_version)
            && digest(&self.generation_manifest_sha256)
            && self.cargo.path == format!("{}/bin/cargo", self.root)
            && self.rustc.path == format!("{}/bin/rustc", self.root)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CargoProject {
    pub manifest: ProgramImage,
    pub lock: ProgramImage,
    pub entry: ProgramImage,
    pub package_name: String,
    pub version: String,
    pub edition: String,
    pub configuration_sha256: String,
}

impl CargoProject {
    pub(crate) fn valid(&self) -> bool {
        image(&self.manifest)
            && image(&self.lock)
            && image(&self.entry)
            && cargo_package_name(&self.package_name)
            && numeric_version(&self.version)
            && matches!(self.edition.as_str(), "2015" | "2018" | "2021" | "2024")
            && digest(&self.configuration_sha256)
    }
}

pub(crate) fn cargo_project_shape(shape: &serde_json::Value, base: &str) -> bool {
    ["", "/manifest", "/lock", "/entry"].iter().all(|suffix| {
        shape
            .pointer(&format!("{base}{suffix}"))
            .is_some_and(serde_json::Value::is_object)
    })
}

fn cargo_package_name(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn numeric_version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            (1..=9).contains(&part.len())
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NpmProfile {
    pub runtime: NpmRuntime,
    pub project: NpmProject,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NpmRuntime {
    pub node: ProgramImage,
    pub entry: ProgramImage,
    pub root: String,
    pub generation_manifest_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NpmProject {
    pub package_json: ProgramImage,
    pub npmrc: Option<ProgramImage>,
    pub test_script: String,
    pub path_shadow_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WriteCeiling {
    pub schema: String,
    pub launch_id: String,
    pub invocation_root: String,
    pub output_root: String,
    pub tmp_root: String,
    pub cache_root: String,
    pub manifest_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Sandbox {
    pub state_base64: String,
    pub state_sha256: String,
    pub launcher: ProgramImage,
    pub environment_anchor: String,
    #[serde(default)]
    pub write_ceiling: Option<WriteCeiling>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Limits {
    pub preparation_deadline_unix_ms: u64,
    pub job_timeout_ms: u64,
    pub termination_grace_ms: u64,
    pub max_output_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepared {
    schema: String,
    pub invocation_id: String,
    pub association: Association,
    pub project_root: String,
    pub execution: Execution,
    pub profile: Profile,
    pub sandbox: Sandbox,
    pub limits: Limits,
}

/// Kept private to the native owner; no Debug to disclose source or environment.
pub(crate) struct PreparedRecord {
    original: Vec<u8>,
    value: Prepared,
    stdin: Vec<u8>,
    sandbox_state: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InvalidRecord;
type Result<T> = std::result::Result<T, InvalidRecord>;

fn require(value: bool) -> Result<()> {
    if value { Ok(()) } else { Err(InvalidRecord) }
}
fn text(value: &str, bound: usize, empty: bool) -> bool {
    (empty || !value.is_empty()) && value.len() <= bound && !value.contains('\0')
}
fn identity(value: &str) -> bool {
    text(value, 256, false) && !value.chars().any(char::is_control)
}
fn path(value: &str) -> bool {
    text(value, 4096, false) && Path::new(value).is_absolute()
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn image(value: &ProgramImage) -> bool {
    path(&value.path) && digest(&value.sha256)
}
fn bytes(value: &str, limit: usize) -> Result<Vec<u8>> {
    require(value.len() <= 4 * limit.div_ceil(3))?;
    let decoded = STANDARD.decode(value).map_err(|_| InvalidRecord)?;
    require(decoded.len() <= limit && STANDARD.encode(&decoded) == value)?;
    Ok(decoded)
}

impl PreparedRecord {
    pub(crate) fn decode(original: Vec<u8>) -> Result<Self> {
        require(!original.is_empty() && original.len() <= RECORD_LIMIT)?;
        // Serde structs also accept positional arrays. Enforce object shape
        // separately, then decode the ORIGINAL bytes so duplicates still fail.
        let shape: serde_json::Value =
            serde_json::from_slice(&original).map_err(|_| InvalidRecord)?;
        for pointer in [
            "",
            "/association",
            "/execution",
            "/execution/executable",
            "/profile",
            "/sandbox",
            "/sandbox/launcher",
            "/limits",
        ] {
            require(
                shape
                    .pointer(pointer)
                    .is_some_and(serde_json::Value::is_object),
            )?;
        }
        for pointer in ["/execution/environment", "/profile/utilities"] {
            let rows = shape
                .pointer(pointer)
                .and_then(serde_json::Value::as_array)
                .ok_or(InvalidRecord)?;
            require(rows.iter().all(serde_json::Value::is_object))?;
        }
        // Typed serde objects reject duplicates, unknown fields, fractional and
        // exponent spellings of integer fields, invalid UTF-8 and lone surrogates.
        let value: Prepared = serde_json::from_slice(&original).map_err(|_| InvalidRecord)?;
        require(value.schema == "caws.execution.prepared.v1" && identity(&value.invocation_id))?;
        let a = &value.association;
        require(
            a.kind == "codex-mcp-v1"
                && [
                    &a.session_id,
                    &a.thread_id,
                    &a.call_id,
                    &a.server_environment_id,
                ]
                .iter()
                .all(|s| identity(s))
                && path(&a.caller_anchor)
                && path(&value.project_root),
        )?;
        let e = &value.execution;
        let p = &value.profile;
        let npm = p.kind == "npm-test-v1";
        let cargo = p.kind == "cargo-run-v1";
        require(
            image(&e.executable)
                && path(&e.cwd)
                && (1..=256).contains(&e.argv.len())
                && e.argv.iter().all(|s| text(s, 65536, true))
                && e.argv.iter().map(|s| s.len() + 1).sum::<usize>() <= 65536
                && text(&p.source, 65536, true)
                && ((p.kind == "bash-clean-v1"
                    && e.argv
                        == [&e.executable.path, "--noprofile", "--norc", "-c", &p.source]
                            .map(str::to_owned))
                    || (p.kind == "caws-evidence-v1"
                        && e.argv.len() >= 5
                        && e.argv[0] == e.executable.path)
                    || (p.kind == "caws-lifecycle-v1"
                        && e.argv.len() >= 3
                        && e.argv[0] == e.executable.path)
                    || npm
                    || cargo),
        )?;
        if npm {
            let profile = p.npm.as_ref().ok_or(InvalidRecord)?;
            let runtime = &profile.runtime;
            let project = &profile.project;
            require(
                shape
                    .pointer("/profile/npm")
                    .is_some_and(serde_json::Value::is_object)
                    && shape
                        .pointer("/profile/npm/runtime")
                        .is_some_and(serde_json::Value::is_object)
                    && shape
                        .pointer("/profile/npm/project")
                        .is_some_and(serde_json::Value::is_object)
                    && [
                        "/profile/npm/runtime/node",
                        "/profile/npm/runtime/entry",
                        "/profile/npm/project/packageJson",
                    ]
                    .into_iter()
                    .all(|pointer| {
                        shape
                            .pointer(pointer)
                            .is_some_and(serde_json::Value::is_object)
                    })
                    && shape
                        .pointer("/profile/npm/project/npmrc")
                        .is_some_and(|value| value.is_null() || value.is_object())
                    && p.source == "npm test"
                    && p.utilities.is_empty()
                    && e.stdin_base64.is_empty()
                    && image(&runtime.node)
                    && image(&runtime.entry)
                    && path(&runtime.root)
                    && digest(&runtime.generation_manifest_sha256)
                    && Path::new(&runtime.entry.path)
                        == Path::new(&runtime.root).join("bin/npm-cli.js")
                    && image(&project.package_json)
                    && project.npmrc.as_ref().is_none_or(image)
                    && text(&project.test_script, 65536, false)
                    && digest(&project.path_shadow_sha256)
                    && e.executable.path == runtime.node.path
                    && e.executable.sha256 == runtime.node.sha256
                    && e.argv
                        == [
                            runtime.node.path.as_str(),
                            runtime.entry.path.as_str(),
                            "--prefix",
                            e.cwd.as_str(),
                            "--workspaces=false",
                            "test",
                        ],
            )?;
        } else {
            require(p.npm.is_none() && shape.pointer("/profile/npm").is_none())?;
        }
        if cargo {
            let profile = p.cargo.as_ref().ok_or(InvalidRecord)?;
            let runtime = &profile.runtime;
            let project = &profile.project;
            let ceiling = value.sandbox.write_ceiling.as_ref().ok_or(InvalidRecord)?;
            let target = format!("{}/target", ceiling.output_root);
            require(
                [
                    "/profile/cargo",
                    "/profile/cargo/runtime",
                    "/profile/cargo/runtime/cargo",
                    "/profile/cargo/runtime/rustc",
                    "/profile/cargo/runtime/linker",
                ]
                .iter()
                .all(|pointer| {
                    shape
                        .pointer(pointer)
                        .is_some_and(serde_json::Value::is_object)
                }) && cargo_project_shape(&shape, "/profile/cargo/project")
                    && p.utilities.is_empty()
                    && e.stdin_base64.is_empty()
                    && image(&runtime.cargo)
                    && image(&runtime.rustc)
                    && image(&runtime.linker)
                    && path(&runtime.root)
                    && path(&runtime.sdk_root)
                    && numeric_version(&runtime.toolchain_version)
                    && digest(&runtime.generation_manifest_sha256)
                    && runtime.cargo.path == format!("{}/bin/cargo", runtime.root)
                    && runtime.rustc.path == format!("{}/bin/rustc", runtime.root)
                    && project.valid()
                    && e.executable.path == runtime.cargo.path
                    && e.executable.sha256 == runtime.cargo.sha256
                    && e.argv
                        == [
                            runtime.cargo.path.as_str(),
                            "run",
                            "--locked",
                            "--offline",
                            "--frozen",
                            "--jobs",
                            "1",
                            "--manifest-path",
                            project.manifest.path.as_str(),
                            "--target-dir",
                            target.as_str(),
                            "--bin",
                            project.package_name.as_str(),
                            "--message-format",
                            "json-render-diagnostics",
                        ],
            )?;
        } else {
            require(p.cargo.is_none() && shape.pointer("/profile/cargo").is_none())?;
        }
        require(e.environment.len() <= 1024)?;
        let mut previous: Option<&str> = None;
        let mut environment_bytes = 0;
        for entry in &e.environment {
            require(
                text(&entry.name, 131072, false)
                    && !entry.name.contains('=')
                    && text(&entry.value, 131072, true)
                    && previous.is_none_or(|prior| prior.as_bytes() < entry.name.as_bytes()),
            )?;
            previous = Some(&entry.name);
            environment_bytes += entry.name.len() + entry.value.len() + 2;
        }
        require(environment_bytes <= 131072)?;
        let stdin = bytes(&e.stdin_base64, 524288)?;
        require(p.utilities.len() <= 32)?;
        let mut paths = BTreeSet::new();
        require(
            p.utilities
                .iter()
                .all(|u| image(u) && paths.insert(&u.path)),
        )?;
        let s = &value.sandbox;
        require(digest(&s.state_sha256) && image(&s.launcher) && path(&s.environment_anchor))?;
        if npm || cargo {
            let ceiling = s.write_ceiling.as_ref().ok_or(InvalidRecord)?;
            require(
                shape
                    .pointer("/sandbox/writeCeiling")
                    .is_some_and(serde_json::Value::is_object)
                    && ceiling.schema == "caws.execution.write-ceiling.v1"
                    && digest(&ceiling.launch_id)
                    && digest(&ceiling.manifest_sha256)
                    && path(&ceiling.invocation_root)
                    && path(&ceiling.output_root)
                    && path(&ceiling.tmp_root)
                    && path(&ceiling.cache_root)
                    && Path::new(&ceiling.output_root)
                        == Path::new(&ceiling.invocation_root).join("output")
                    && Path::new(&ceiling.tmp_root)
                        == Path::new(&ceiling.invocation_root).join("tmp")
                    && Path::new(&ceiling.cache_root)
                        == Path::new(&ceiling.invocation_root).join("cache"),
            )?;
        } else {
            require(s.write_ceiling.is_none() && shape.pointer("/sandbox/writeCeiling").is_none())?;
        }
        let sandbox_state = bytes(&s.state_base64, 262144)?;
        require(format!("{:x}", Sha256::digest(&sandbox_state)) == s.state_sha256)?;
        // Grammar only: duplicate keys and policy extensions stay opaque, and
        // the original state bytes are forwarded unchanged to the pinned host.
        serde_json::from_slice::<&serde_json::value::RawValue>(&sandbox_state)
            .map_err(|_| InvalidRecord)?;
        let l = &value.limits;
        require(
            (1..=9_007_199_254_740_991).contains(&l.preparation_deadline_unix_ms)
                && (1..=86_400_000).contains(&l.job_timeout_ms)
                && (1..=10_000).contains(&l.termination_grace_ms)
                && (1..=16_777_216).contains(&l.max_output_bytes),
        )?;
        Ok(Self {
            original,
            value,
            stdin,
            sandbox_state,
        })
    }

    pub(crate) fn original(&self) -> &[u8] {
        &self.original
    }

    // Shared views only: the authorized bytes and launch inputs cannot diverge
    // after decoding. Do not add mutable accessors or interior mutability.
    pub(crate) fn value(&self) -> &Prepared {
        &self.value
    }

    pub(crate) fn stdin(&self) -> &[u8] {
        &self.stdin
    }

    pub(crate) fn sandbox_state(&self) -> &[u8] {
        &self.sandbox_state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn npm_fixture() -> Value {
        let mut value = fixture();
        let node = json!({"path":"/generation/node", "sha256":"a".repeat(64)});
        let entry = json!({"path":"/generation/npm/bin/npm-cli.js", "sha256":"b".repeat(64)});
        value["execution"]["executable"] = node.clone();
        value["execution"]["argv"] = json!([
            "/generation/node",
            "/generation/npm/bin/npm-cli.js",
            "--prefix",
            value["execution"]["cwd"],
            "--workspaces=false",
            "test"
        ]);
        value["execution"]["stdinBase64"] = json!("");
        value["profile"] = json!({"kind":"npm-test-v1", "source":"npm test", "utilities":[],
            "npm":{"runtime":{"node":node,"entry":entry,"root":"/generation/npm",
                "generationManifestSha256":"c".repeat(64)},
            "project":{"packageJson":{"path":"/project/package.json","sha256":"d".repeat(64)},
                "npmrc":null,"testScript":"node tests/run.js","pathShadowSha256":"e".repeat(64)}}});
        value["sandbox"]["writeCeiling"] = json!({"schema":"caws.execution.write-ceiling.v1",
            "launchId":"f".repeat(64),"invocationRoot":"/private/run",
            "outputRoot":"/private/run/output","tmpRoot":"/private/run/tmp",
            "cacheRoot":"/private/run/cache","manifestSha256":"1".repeat(64)});
        value
    }

    pub(crate) fn cargo_fixture() -> Value {
        let mut value = npm_fixture();
        let pin = |path: &str, hash: &str| json!({"path":path,"sha256":hash.repeat(64)});
        let cargo = pin("/generation/rust/bin/cargo", "a");
        value["execution"]["executable"] = cargo.clone();
        value["execution"]["argv"] = json!([
            "/generation/rust/bin/cargo",
            "run",
            "--locked",
            "--offline",
            "--frozen",
            "--jobs",
            "1",
            "--manifest-path",
            "/project/demo/Cargo.toml",
            "--target-dir",
            "/private/run/output/target",
            "--bin",
            "demo",
            "--message-format",
            "json-render-diagnostics"
        ]);
        value["profile"] = json!({"kind":"cargo-run-v1",
            "source":"cargo run --manifest-path demo/Cargo.toml", "utilities":[],
            "cargo":{"runtime":{"cargo":cargo,"rustc":pin("/generation/rust/bin/rustc","b"),
                "linker":pin("/generation/toolchain/bin/clang","c"),"root":"/generation/rust",
                "sdkRoot":"/generation/sdk","toolchainVersion":"1.90.0",
                "generationManifestSha256":"d".repeat(64)},
            "project":{"manifest":pin("/project/demo/Cargo.toml","e"),
                "lock":pin("/project/demo/Cargo.lock","f"),"entry":pin("/project/demo/src/main.rs","1"),
                "packageName":"demo","version":"0.1.0","edition":"2024",
                "configurationSha256":"2".repeat(64)}}});
        value
    }

    #[test]
    fn cargo_record_preserves_exact_tuple_and_original_opaque_bytes() {
        let value = cargo_fixture();
        let original = serde_json::to_vec_pretty(&value).unwrap();
        let record = PreparedRecord::decode(original.clone()).unwrap();
        assert_eq!(record.original(), original);
        assert_eq!(record.sandbox_state(), b"{ \"future\": 1, \"future\": 2 }");
        assert_eq!(
            record.value().execution.argv,
            [
                "/generation/rust/bin/cargo",
                "run",
                "--locked",
                "--offline",
                "--frozen",
                "--jobs",
                "1",
                "--manifest-path",
                "/project/demo/Cargo.toml",
                "--target-dir",
                "/private/run/output/target",
                "--bin",
                "demo",
                "--message-format",
                "json-render-diagnostics"
            ]
        );
        let profile = record.value().profile.cargo.as_ref().unwrap();
        assert_eq!(profile.project.package_name, "demo");
        assert_eq!(profile.project.version, "0.1.0");
        assert_eq!(profile.runtime.toolchain_version, "1.90.0");
        assert!(record.stdin().is_empty());
        for edition in ["2015", "2018", "2021", "2024"] {
            let mut good = value.clone();
            good["profile"]["cargo"]["project"]["edition"] = json!(edition);
            assert!(PreparedRecord::decode(serde_json::to_vec(&good).unwrap()).is_ok());
        }
    }

    #[test]
    fn cargo_record_refuses_runtime_argv_project_and_ceiling_disagreement() {
        let value = cargo_fixture();
        for (pointer, replacement) in [
            ("/execution/executable/path", json!("/usr/bin/cargo")),
            ("/execution/executable/sha256", json!("9".repeat(64))),
            ("/execution/argv/1", json!("build")),
            ("/execution/argv/2", json!("--release")),
            ("/execution/argv/6", json!("2")),
            ("/execution/argv/8", json!("/project/other/Cargo.toml")),
            ("/execution/argv/10", json!("/project/target")),
            ("/execution/argv/12", json!("other")),
            ("/execution/argv/14", json!("json")),
            ("/execution/stdinBase64", json!("YQ==")),
            (
                "/profile/utilities",
                json!([{"path":"/bin/cat","sha256":"a".repeat(64)}]),
            ),
            ("/profile/cargo/runtime/root", json!("/generation/other")),
            ("/profile/cargo/runtime/cargo/path", json!("/usr/bin/cargo")),
            ("/profile/cargo/runtime/rustc/path", json!("/usr/bin/rustc")),
            ("/profile/cargo/runtime/linker/path", json!("clang")),
            ("/profile/cargo/runtime/sdkRoot", json!("sdk")),
            (
                "/profile/cargo/runtime/toolchainVersion",
                json!("1.90.0-nightly"),
            ),
            ("/profile/cargo/runtime/toolchainVersion", json!("01.90.0")),
            (
                "/profile/cargo/runtime/generationManifestSha256",
                json!("bad"),
            ),
            ("/profile/cargo/project/manifest/path", json!("Cargo.toml")),
            ("/profile/cargo/project/lock/sha256", json!("F".repeat(64))),
            ("/profile/cargo/project/entry/path", json!("src/main.rs")),
            ("/profile/cargo/project/configurationSha256", json!("bad")),
            ("/profile/cargo/project/packageName", json!("-demo")),
            ("/profile/cargo/project/packageName", json!("a".repeat(65))),
            ("/profile/cargo/project/version", json!("0.1.0+local")),
            ("/profile/cargo/project/version", json!("0.01.0")),
            ("/profile/cargo/project/edition", json!("2027")),
            ("/sandbox/writeCeiling/tmpRoot", json!("/project/tmp")),
            (
                "/sandbox/writeCeiling/outputRoot",
                json!("/private/run/output/"),
            ),
            ("/sandbox/writeCeiling/manifestSha256", json!("bad")),
        ] {
            let mut bad = value.clone();
            *bad.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err(),
                "{pointer}"
            );
        }
        for pointer in ["/profile/cargo", "/sandbox/writeCeiling"] {
            let mut bad = value.clone();
            *bad.pointer_mut(pointer).unwrap() = Value::Null;
            assert!(PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err());
        }
        let mut missing = value.clone();
        missing["sandbox"]
            .as_object_mut()
            .unwrap()
            .remove("writeCeiling");
        assert!(PreparedRecord::decode(serde_json::to_vec(&missing).unwrap()).is_err());
        let mut extra = value.clone();
        extra["execution"]["argv"]
            .as_array_mut()
            .unwrap()
            .push(json!("--release"));
        assert!(PreparedRecord::decode(serde_json::to_vec(&extra).unwrap()).is_err());
    }

    #[test]
    fn cargo_record_refuses_positional_unknown_duplicate_and_cross_kind_objects() {
        let value = cargo_fixture();
        for (pointer, keys) in [
            ("/profile/cargo", vec!["runtime", "project"]),
            (
                "/profile/cargo/runtime",
                vec![
                    "cargo",
                    "rustc",
                    "linker",
                    "root",
                    "sdkRoot",
                    "toolchainVersion",
                    "generationManifestSha256",
                ],
            ),
            (
                "/profile/cargo/project",
                vec![
                    "manifest",
                    "lock",
                    "entry",
                    "packageName",
                    "version",
                    "edition",
                    "configurationSha256",
                ],
            ),
            ("/profile/cargo/runtime/cargo", vec!["path", "sha256"]),
            ("/profile/cargo/runtime/rustc", vec!["path", "sha256"]),
            ("/profile/cargo/runtime/linker", vec!["path", "sha256"]),
            ("/profile/cargo/project/manifest", vec!["path", "sha256"]),
            ("/profile/cargo/project/lock", vec!["path", "sha256"]),
            ("/profile/cargo/project/entry", vec!["path", "sha256"]),
            (
                "/sandbox/writeCeiling",
                vec![
                    "schema",
                    "launchId",
                    "invocationRoot",
                    "outputRoot",
                    "tmpRoot",
                    "cacheRoot",
                    "manifestSha256",
                ],
            ),
        ] {
            let mut bad = value.clone();
            let row = bad.pointer_mut(pointer).unwrap();
            *row = Value::Array(keys.iter().map(|key| row[key].clone()).collect());
            assert!(
                PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err(),
                "positional {pointer}"
            );
            let mut bad = value.clone();
            bad.pointer_mut(pointer).unwrap()["unexpected"] = json!(true);
            assert!(
                PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err(),
                "unknown {pointer}"
            );
        }
        let original = serde_json::to_string(&value).unwrap();
        let duplicate = original.replacen(
            "\"edition\":\"2024\"",
            "\"edition\":\"2024\",\"edition\":\"2024\"",
            1,
        );
        assert_ne!(original, duplicate);
        assert!(PreparedRecord::decode(duplicate.into_bytes()).is_err());
        let mut bad = value;
        bad["profile"]["npm"] = Value::Null;
        assert!(PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err());
        for mut other in [fixture(), npm_fixture()] {
            other["profile"]["cargo"] = Value::Null;
            assert!(PreparedRecord::decode(serde_json::to_vec(&other).unwrap()).is_err());
        }
    }

    #[test]
    fn npm_record_requires_exact_test_runtime_project_and_ceiling() {
        let value = npm_fixture();
        let record = PreparedRecord::decode(serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(record.value().profile.kind, "npm-test-v1");
        assert_eq!(record.value().execution.argv[5], "test");
        for (pointer, replacement) in [
            ("/profile/source", json!("npm test -- --watch")),
            ("/execution/argv/2", json!("install")),
            (
                "/profile/npm/runtime/entry/path",
                json!("/generation/npm/other.js"),
            ),
            ("/profile/npm/project/testScript", json!("")),
            ("/sandbox/writeCeiling/tmpRoot", json!("/project/tmp")),
            ("/sandbox/writeCeiling/manifestSha256", json!("0")),
        ] {
            let mut bad = value.clone();
            *bad.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err(),
                "{pointer}"
            );
        }
        let mut bad = value.clone();
        bad["profile"]["npm"]["project"]
            .as_object_mut()
            .unwrap()
            .remove("npmrc");
        assert!(PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err());
        for pointer in [
            "/profile/npm/runtime/node",
            "/profile/npm/runtime/entry",
            "/profile/npm/project/packageJson",
        ] {
            let mut bad = value.clone();
            let image = bad.pointer(pointer).unwrap().clone();
            *bad.pointer_mut(pointer).unwrap() = json!([image["path"], image["sha256"]]);
            assert!(
                PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err(),
                "{pointer}"
            );
        }
        let mut npmrc = value.clone();
        npmrc["profile"]["npm"]["project"]["npmrc"] =
            json!({"path":"/project/.npmrc","sha256":"2".repeat(64)});
        assert!(PreparedRecord::decode(serde_json::to_vec(&npmrc).unwrap()).is_ok());
        npmrc["profile"]["npm"]["project"]["npmrc"] = json!(["/project/.npmrc", "2".repeat(64)]);
        assert!(PreparedRecord::decode(serde_json::to_vec(&npmrc).unwrap()).is_err());
        let mut bad = fixture();
        bad["profile"]["npm"] = json!(null);
        assert!(PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err());
    }

    #[test]
    fn dedicated_writer_record_requires_direct_executable_argv_and_known_profile() {
        let mut value = fixture();
        value["profile"]["kind"] = json!("caws-evidence-v1");
        value["execution"]["executable"]["path"] = json!("/generation/node");
        value["execution"]["argv"] = json!([
            "/generation/node",
            "/generation/writer-main.js",
            "specs",
            "evidence",
            "S"
        ]);
        assert_eq!(
            PreparedRecord::decode(serde_json::to_vec(&value).unwrap())
                .unwrap()
                .value()
                .profile
                .kind,
            "caws-evidence-v1"
        );
        let mut wrong = value.clone();
        wrong["execution"]["argv"][0] = json!("/usr/bin/env");
        assert!(PreparedRecord::decode(serde_json::to_vec(&wrong).unwrap()).is_err());
        let mut wrong = value.clone();
        wrong["execution"]["argv"] = json!(["/generation/node", "script.js"]);
        assert!(PreparedRecord::decode(serde_json::to_vec(&wrong).unwrap()).is_err());
        value["profile"]["kind"] = json!("unreviewed-writer");
        assert!(PreparedRecord::decode(serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn lifecycle_record_requires_direct_executable_and_consumer_argument() {
        let mut value = fixture();
        value["profile"]["kind"] = json!("caws-lifecycle-v1");
        value["execution"]["executable"]["path"] = json!("/generation/node");
        value["execution"]["argv"] = json!([
            "/generation/node",
            "/generation/lifecycle-main.js",
            "git-head"
        ]);
        let decoded = PreparedRecord::decode(serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(decoded.value().profile.kind, "caws-lifecycle-v1");
        assert_eq!(decoded.value().execution.argv[2], "git-head");
        let mut wrong = value.clone();
        wrong["execution"]["argv"][0] = json!("/usr/bin/env");
        assert!(PreparedRecord::decode(serde_json::to_vec(&wrong).unwrap()).is_err());
        wrong = value.clone();
        wrong["execution"]["argv"] = json!(["/generation/node", "/generation/lifecycle-main.js"]);
        assert!(PreparedRecord::decode(serde_json::to_vec(&wrong).unwrap()).is_err());
        value["profile"]["npm"] = json!(null);
        assert!(PreparedRecord::decode(serde_json::to_vec(&value).unwrap()).is_err());
    }

    pub(crate) fn fixture() -> Value {
        let state = b"{ \"future\": 1, \"future\": 2 }";
        let pin = json!({"path":"/bin/bash", "sha256":"a".repeat(64)});
        json!({
            "schema":"caws.execution.prepared.v1", "invocationId":"invocation",
            "association":{"kind":"codex-mcp-v1", "sessionId":"lineage", "threadId":"thread",
                "callId":"call", "callerAnchor":"/project", "serverEnvironmentId":"host"},
            "projectRoot":"/project",
            "execution":{"executable":pin, "argv":["/bin/bash","--noprofile","--norc","-c","printf ok"],
                "cwd":"/project", "environment":[{"name":"PATH","value":"/bin:/usr/bin"}],
                "stdinBase64":STANDARD.encode([0,255,10])},
            "profile":{"kind":"bash-clean-v1", "source":"printf ok", "utilities":[]},
            "sandbox":{"stateBase64":STANDARD.encode(state),
                "stateSha256":format!("{:x}",Sha256::digest(state)), "launcher":pin,
                "environmentAnchor":"/sandbox"},
            "limits":{"preparationDeadlineUnixMs":1900000000000_u64, "jobTimeoutMs":1000,
                "terminationGraceMs":100, "maxOutputBytes":4096}
        })
    }

    #[test]
    fn preserves_original_and_opaque_sandbox_bytes() {
        let original = serde_json::to_vec_pretty(&fixture()).unwrap();
        let record = PreparedRecord::decode(original.clone()).unwrap();
        assert_eq!(record.original(), original);
        assert_eq!(record.stdin, [0, 255, 10]);
        assert_eq!(record.sandbox_state, b"{ \"future\": 1, \"future\": 2 }");
        assert_eq!(record.value.association.thread_id, "thread");
    }

    #[test]
    fn rejects_disagreement_unknown_fields_unsorted_environment_and_bad_hash() {
        for (pointer, replacement) in [
            ("/execution/argv/4", json!("different source")),
            ("/association/threadId", json!("control\n")),
            ("/sandbox/stateSha256", json!("b".repeat(64))),
            ("/execution/stdinBase64", json!("YQ")),
            (
                "/execution/environment",
                json!([{"name":"Z","value":""},{"name":"A","value":""}]),
            ),
            ("/limits/jobTimeoutMs", json!(0)),
            ("/limits/maxOutputBytes", json!(16777217)),
        ] {
            let mut f = fixture();
            *f.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                PreparedRecord::decode(serde_json::to_vec(&f).unwrap()).is_err(),
                "{pointer}"
            );
        }
        let mut f = fixture();
        f["execution"]["allow"] = json!(true);
        assert!(PreparedRecord::decode(serde_json::to_vec(&f).unwrap()).is_err());
    }

    #[test]
    fn rejects_duplicate_keys_numeric_aliases_invalid_unicode_and_large_records() {
        let valid = serde_json::to_string(&fixture()).unwrap();
        for bad in [
            valid.replacen(
                "\"jobTimeoutMs\":1000",
                "\"jobTimeoutMs\":1000,\"jobTimeoutMs\":1000",
                1,
            ),
            valid.replacen("\"jobTimeoutMs\":1000", "\"jobTimeoutMs\":1e3", 1),
            valid.replacen("\"jobTimeoutMs\":1000", "\"jobTimeoutMs\":1000.0", 1),
            valid.replacen("\"thread\"", "\"\\ud800\"", 1),
        ] {
            assert_ne!(bad, valid);
            assert!(PreparedRecord::decode(bad.into_bytes()).is_err());
        }
        let mut invalid = valid.into_bytes();
        invalid[0] = 0xff;
        assert!(PreparedRecord::decode(invalid).is_err());
        assert!(PreparedRecord::decode(vec![b' '; RECORD_LIMIT + 1]).is_err());
    }

    #[test]
    fn rejects_positional_objects_even_when_values_follow_struct_order() {
        let f = fixture();
        for (pointer, fields) in [
            ("/execution/executable", vec!["path", "sha256"]),
            ("/execution/environment/0", vec!["name", "value"]),
            (
                "/association",
                vec![
                    "kind",
                    "sessionId",
                    "threadId",
                    "callId",
                    "callerAnchor",
                    "serverEnvironmentId",
                ],
            ),
            (
                "/limits",
                vec![
                    "preparationDeadlineUnixMs",
                    "jobTimeoutMs",
                    "terminationGraceMs",
                    "maxOutputBytes",
                ],
            ),
        ] {
            let mut bad = f.clone();
            let row = bad.pointer_mut(pointer).unwrap();
            *row = Value::Array(fields.iter().map(|key| row[key].clone()).collect());
            assert!(
                PreparedRecord::decode(serde_json::to_vec(&bad).unwrap()).is_err(),
                "{pointer}"
            );
        }
    }
}
