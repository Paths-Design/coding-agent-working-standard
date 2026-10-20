//! Native admission of the first reviewed session-render service image.
//!
//! Manifest hashes identify bytes; only the separate native-derived operator
//! declaration permits this service lifetime. No project write authority is
//! issued here. Expected selection and tool/client roots must come from the
//! trusted pinned engine/configuration, never from the image being checked.
//! The reviewed foreign source table is deliberately closed: source changes
//! require a reviewed profile revision, even if an operator changes a digest.
//! OS libraries, interpreter standard libraries, and the trusted engine are TCB,
//! not a hash-complete source closure. The existing versioned CAWS CLI package
//! and dependencies are also explicit authority-adapter TCB, not recursively
//! sealed here. The native owner separately admits each private Git view and
//! descriptor right; this module alone issues no offer or spawn permission. Same-UID hostile writers are outside the
//! cooperative custody boundary; sealed modes alone cannot prevent owner chmod.
//! Deadlines bracket bounded I/O but cannot interrupt a stalled kernel syscall.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{CStr, CString},
    fmt,
    fs::{File, Metadata},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
    time::Instant,
};

pub const PROFILE: &str = "sterling-session-log-codex-stop-v1";
pub const ADAPTER: &str = "sterling-session-log-broker-v1";
pub const MAX_FILES: usize = 1024;
pub const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_POLICY_BYTES: u64 = 16 * 1024;
const MAX_TOOL_BYTES: u64 = 256 * 1024 * 1024;
const IMAGE_SCHEMA: &str = "caws.service.render.image.v1";

// Reviewed source identity only; no foreign source bytes are distributed here.
// First-profile provenance is the read-only Sterling source baseline observed
// during the native service-image contract review. Every admission rehashes the
// current original files against these exact fingerprints.
pub const FOREIGN_PROFILE: &[(&str, &str)] = &[
    (
        "session-log.sh",
        "b51e147dada255a3eecf3676956428e7f404611b8c3333fc41b215b2db9fa099",
    ),
    (
        "session_log_renderer.py",
        "156197775e1b79fa0d74d95c856beedce5b501d66945941ab21b01380f98be39",
    ),
    (
        "session_log_daemon.py",
        "7f03eaa578b7336ebbf5c872630c14d04df7012c7f1d082e431ec3ed3d856a63",
    ),
    (
        "runtime-paths.sh",
        "396b13bad3d34be89f8719e56662de18ccfe85c2b9ce15c4905778449e876325",
    ),
    (
        "lib/agent-pid.sh",
        "c7857c7d1e3ebf9a13feaefebc0f13a58e8b16a35f140db666f1609b86ac7fe9",
    ),
    (
        "lib/agent-surface.sh",
        "8e70aaf8c1ef334d4f8cce08f0030ecc512610feaf3b04ba8c0d32ee1dc9fe36",
    ),
    (
        "lib/bash-mutation-targets.sh",
        "31b3eed7c5d650b3fdaa33c0f6d5cfb529b08b27387afafcd1e79e86d7579250",
    ),
    (
        "lib/caws-state.sh",
        "305a671e75b8e7aed6a6e7e14b1a790338c6a05a76887f519e2ab0e3c2d4fdf7",
    ),
    (
        "lib/emit.sh",
        "f2098113d5133b1da7c06910a313a26811456fdf47f683e58c62ddfa1cacd5f4",
    ),
    (
        "lib/guard-message.sh",
        "39bb7658443ab8bee62ca493ce278f31de20dfa0a9c5f08ac766ffb6df01d8b9",
    ),
    (
        "lib/harness_claude.py",
        "f2957c64267973ef93871010592e646357b0f111c4c80ef7ab2fb6f2286a1106",
    ),
    (
        "lib/harness_codex.py",
        "0d706f7b3c011748648da72a2b1c7d7a7483f97a7ee68e84d9a7dc6c2c204618",
    ),
    (
        "lib/harness_common.py",
        "588123f740fd2d651552d72143bc41f6afc1e9d73786271e9a63e8f159d052d9",
    ),
    (
        "lib/harness_dsh.py",
        "ea729e888fa293ed56690953aa4aa6d7ab357dc428cf5b8d3ec355103a020277",
    ),
    (
        "lib/harness_opencode.py",
        "dee130fa802a469568f9b79767fe1b44ed646faa24af211f4ca45d013fc88320",
    ),
    (
        "lib/harness_qwen.py",
        "b2ea715d658062da563cca71821035195c66ebc87bab49f568bad1068231ffd4",
    ),
    (
        "lib/harness_zcode.py",
        "1a3bbad7ed8eb62bb21adb667f272a0e4aed1c270089902f4a4592baa43fa326",
    ),
    (
        "lib/heredoc.sh",
        "34639f74e3ce55c17009ec8be3627029aa072d6e698ef215712423bd9b674b98",
    ),
    (
        "lib/opencode-transcript.py",
        "97c01342baa6094a512c70598f97d1d761205445531b482b452562b55ddb9283",
    ),
    (
        "lib/parse-input.sh",
        "fa014098b03d39541590d67909569cf99781a1dff53bb06fd393e3e8c214adf7",
    ),
    (
        "lib/reprieve.sh",
        "772c43f82a80688bfb9592eea1f88700fd161d9dc99bcf47f78fb6538b38d19b",
    ),
    (
        "lib/run-handlers.sh",
        "3279fd826435f1dccc37de690446938415f33901d2bc98325273a390604d7f8b",
    ),
    (
        "lib/session-id.sh",
        "e3a4c15325016892b4448c4bbbeee8bd8560f3b1b2a2bb7848f985cb3832d3e6",
    ),
    (
        "lib/session-log-daemon-client.sh",
        "84abf3a80c95eeb637bebac87974b90e83200263e81b62e17685f5982713adc5",
    ),
    (
        "lib/surfaces-registry.sh",
        "f88ef9ee4b527dffcec411e4ab7630fd4bd8512d47ace083778e210e422c0644",
    ),
    (
        "lib/worktree-claim-oracle.cjs",
        "4b29d09d8d3c357963fa1028aa1797fea174d6b4814653f921d4645f773fea23",
    ),
    (
        "lib/write-allowlist.sh",
        "4f72b71c8d4d9a859ce5dbe237c1823543e2ac4db156afefbb52901e37a7cfb6",
    ),
    (
        "lib/zcode-transcript.py",
        "8edc4cc4ec9185bd4ce4babb4aab14fc9a09ebe0c1c784ae45b62f6f89b358b3",
    ),
];
pub const TOOLS: &[&str] = &[
    "awk", "basename", "bash", "cat", "caws", "cp", "cut", "date", "dirname", "find", "git",
    "grep", "head", "jq", "mkdir", "mktemp", "node", "pgrep", "ps", "python3", "readlink", "rm",
    "sed", "sh", "sleep", "sort", "stat", "tail", "tr", "wc",
];
pub const PLAN_TOOL: &str = "caws-native";
mod prefix;
use prefix::derive_prefix_concurrency;
pub use prefix::{IsolatedPrefix, PrefixConcurrency, SerialPrefixReason};

fn valid_tool_names(tools: &[Tool]) -> bool {
    let mut expected: Vec<_> = TOOLS.to_vec();
    if tools.iter().any(|tool| tool.name == PLAN_TOOL) {
        expected.push(PLAN_TOOL);
        expected.sort_unstable();
    }
    tools.iter().map(|tool| tool.name.as_str()).eq(expected)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Invalid,
    UnsupportedProfile,
    UnsafePath,
    Changed,
    Deadline,
    Io,
}
#[derive(Debug)]
pub struct AdmissionError {
    pub kind: ErrorKind,
    pub publication_may_have_happened: bool,
    operation: &'static str,
    source: Option<io::Error>,
}
impl AdmissionError {
    /// Static native validation stage only; never reflects caller path/data.
    pub const fn operation(&self) -> &'static str {
        self.operation
    }
}
impl fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "service image unavailable: {}", self.operation)?;
        if let Some(e) = &self.source {
            write!(f, ": {e}")?;
        }
        Ok(())
    }
}
impl std::error::Error for AdmissionError {}
pub type Result<T> = std::result::Result<T, AdmissionError>;
fn fail(kind: ErrorKind, operation: &'static str) -> AdmissionError {
    AdmissionError {
        kind,
        publication_may_have_happened: false,
        operation,
        source: None,
    }
}
fn io_error(operation: &'static str, source: io::Error) -> AdmissionError {
    AdmissionError {
        kind: ErrorKind::Io,
        publication_may_have_happened: false,
        operation,
        source: Some(source),
    }
}
fn require(value: bool, kind: ErrorKind, operation: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(fail(kind, operation))
    }
}
fn deadline(expires: Instant) -> Result<()> {
    require(
        Instant::now() < expires,
        ErrorKind::Deadline,
        "deadline expired",
    )
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn json<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| fail(ErrorKind::Invalid, "JSON encoding"))
}
fn absolute(value: &str) -> bool {
    value.len() <= 4096
        && value.starts_with('/')
        && !value.contains('\0')
        && (value == "/" || value[1..].split('/').all(|c| !matches!(c, "" | "." | "..")))
}
fn relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.starts_with('/')
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c))
        && value.split('/').all(|c| !matches!(c, "" | "." | ".."))
}
fn sorted_unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut previous = None;
    for value in values {
        if previous.is_some_and(|p| p >= value) {
            return false;
        }
        previous = Some(value);
    }
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handler {
    pub path: String,
    pub sha256: String,
    pub entry: String,
    pub name: String,
    pub args: Vec<String>,
    pub tier: String,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Library {
    pub name: String,
    pub path: String,
    pub sha256: String,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub canonical_project: String,
    pub surface: String,
    pub event: String,
    pub configuration: String,
    pub runtime_digest: String,
    pub selected_index: u16,
    pub handlers: Vec<Handler>,
    pub libraries: Vec<Library>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFile {
    pub origin: String,
    pub path: String,
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandlerRoute {
    pub selected_index: u16,
    pub entry: String,
    pub original_path: String,
    pub original_sha256: String,
    pub execution_relative: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedLibrary {
    pub name: String,
    pub original_path: String,
    pub original_sha256: String,
    pub execution_relative: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ImageFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub mode: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Execution {
    pub root: String,
    pub dispatcher: String,
    pub hooks: String,
    pub client: String,
    pub handler_routes: Vec<HandlerRoute>,
    pub resolved_libraries: Vec<ResolvedLibrary>,
    pub files: Vec<ImageFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolchainTcb {
    pub tools: Vec<Tool>,
    pub python_flags: Vec<String>,
    pub system_dependencies: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedImageManifest {
    pub schema: String,
    pub adapter: String,
    pub profile: String,
    pub selection: Selection,
    pub original_closure: Vec<SourceFile>,
    pub original_closure_digest: String,
    pub source_generation: String,
    pub execution: Execution,
    pub toolchain_tcb: ToolchainTcb,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperatorHandler {
    pub entry: String,
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorPolicy {
    pub version: u8,
    pub adapter: String,
    pub profile: String,
    pub root: String,
    pub handler: OperatorHandler,
    pub source_profile_digest: String,
}

/// Config/engine-owned inputs. Filling these from an untrusted image would
/// destroy the expected-selection and code-custody comparison boundary.
#[derive(Debug, Clone)]
pub struct AdmissionContext {
    pub home: PathBuf,
    pub canonical_project: String,
    pub runtime_digest: String,
    pub client_root: PathBuf,
    pub template_root: PathBuf,
    pub client_shell_source: PathBuf,
    pub native_executable: Option<PathBuf>,
    pub expected_selection: Selection,
    pub expected_image_digest: String,
    pub expected_policy_sha256: String,
    pub caller_environment: BTreeMap<String, String>,
}
pub fn policy_path(context: &AdmissionContext) -> PathBuf {
    context
        .home
        .join("state/projects")
        .join(hash(context.canonical_project.as_bytes()))
        .join("render-service.json")
}
pub fn image_parent(context: &AdmissionContext) -> PathBuf {
    context
        .home
        .join("state/projects")
        .join(hash(context.canonical_project.as_bytes()))
        .join("service-images")
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientSource {
    pub relative_path: String,
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}
pub fn client_source_table(manifest: &PreparedImageManifest) -> Vec<ClientSource> {
    manifest
        .original_closure
        .iter()
        .filter(|r| r.origin == "client")
        .map(|r| ClientSource {
            relative_path: r.relative_path.clone(),
            path: r.path.clone(),
            sha256: r.sha256.clone(),
            bytes: r.bytes,
        })
        .collect()
}
pub fn image_key(manifest: &PreparedImageManifest) -> Result<String> {
    Ok(hash(&json(&(
        "caws-service-image-key-v1",
        &manifest.source_generation,
        client_source_table(manifest),
    ))?))
}
pub fn original_closure_digest(manifest: &PreparedImageManifest) -> Result<String> {
    Ok(hash(&json(&(
        "caws-service-original-closure-v1",
        &manifest.original_closure,
        &manifest.toolchain_tcb,
    ))?))
}
pub fn source_generation(manifest: &PreparedImageManifest) -> Result<String> {
    let s = &manifest.selection;
    Ok(hash(&json(&(
        "caws-service-source-generation-v1",
        &manifest.profile,
        &s.canonical_project,
        &s.runtime_digest,
        s.selected_index,
        &s.handlers,
        &s.libraries,
        &manifest.original_closure_digest,
        &manifest.toolchain_tcb,
    ))?))
}
fn reject_preloads(environment: &BTreeMap<String, String>) -> Result<()> {
    require(
        !environment.iter().any(|(name, value)| {
            !value.is_empty()
                && (matches!(
                    name.as_str(),
                    "BASH_ENV"
                        | "ENV"
                        | "CAWS_PRIOR_BASH_ENV"
                        | "CAWS_GUARD_CONFIG_PY"
                        | "CAWS_GIT_BINARY"
                        | "SHELLOPTS"
                        | "BASHOPTS"
                ) || name.starts_with("CAWS_SERVICE_")
                    || name.starts_with("_HOOK_")
                    || name.starts_with("_CAWS_")
                    || name.starts_with("NODE_")
                    || name.starts_with("LD_")
                    || name.starts_with("DYLD_")
                    || name.starts_with("BASH_FUNC_")
                    || (name.starts_with("PYTHON")
                        && !(name == "PYTHONDONTWRITEBYTECODE" && value == "1"))
                    || (name == "CAWS_BIN" && value != "caws"))
        }),
        ErrorKind::UnsupportedProfile,
        "caller interpreter preload unsupported",
    )
}
fn validate_foreign_profile(rows: &[SourceFile]) -> Result<()> {
    let observed: BTreeMap<_, _> = rows
        .iter()
        .filter(|r| r.origin == "project")
        .map(|r| (r.relative_path.as_str(), r.sha256.as_str()))
        .collect();
    let expected: BTreeMap<_, _> = FOREIGN_PROFILE.iter().copied().collect();
    require(
        observed == expected
            && rows.iter().filter(|r| r.origin == "project").count() == FOREIGN_PROFILE.len(),
        ErrorKind::UnsupportedProfile,
        "foreign source profile differs",
    )
}
fn validate_policy(policy: &OperatorPolicy, manifest: &PreparedImageManifest) -> Result<()> {
    let handler = manifest
        .selection
        .handlers
        .get(usize::from(manifest.selection.selected_index))
        .ok_or_else(|| fail(ErrorKind::Invalid, "selected handler missing"))?;
    require(
        policy.version == 1
            && policy.adapter == ADAPTER
            && policy.profile == PROFILE
            && policy.root == manifest.selection.canonical_project
            && policy.handler.entry == "session-log.sh"
            && policy.handler.path == handler.path
            && policy.handler.sha256 == handler.sha256
            && policy.source_profile_digest == manifest.original_closure_digest,
        ErrorKind::Changed,
        "operator declaration does not admit image source profile",
    )
}
fn validate_binding(
    manifest: &PreparedImageManifest,
    context: &AdmissionContext,
    root: &Path,
) -> Result<()> {
    reject_preloads(&context.caller_environment)?;
    let home = context
        .home
        .to_str()
        .ok_or_else(|| fail(ErrorKind::Invalid, "home is not UTF-8"))?;
    let templates = context
        .template_root
        .to_str()
        .ok_or_else(|| fail(ErrorKind::Invalid, "template root is not UTF-8"))?;
    let client_shell = context
        .client_shell_source
        .to_str()
        .ok_or_else(|| fail(ErrorKind::Invalid, "client shell source is not UTF-8"))?;
    let client = context
        .client_root
        .to_str()
        .ok_or_else(|| fail(ErrorKind::Invalid, "client root is not UTF-8"))?;
    let root_text = root
        .to_str()
        .ok_or_else(|| fail(ErrorKind::Invalid, "image root is not UTF-8"))?;
    require(
        absolute(home)
            && absolute(client)
            && absolute(templates)
            && absolute(client_shell)
            && absolute(&context.canonical_project)
            && absolute(root_text)
            && digest(&context.runtime_digest)
            && digest(&context.expected_image_digest)
            && digest(&context.expected_policy_sha256),
        ErrorKind::Invalid,
        "invalid trusted admission context",
    )?;
    require(
        root == image_parent(context).join(image_key(manifest)?)
            && manifest.execution.root == root_text,
        ErrorKind::UnsafePath,
        "image is outside native-derived image parent",
    )?;
    require(
        manifest.schema == IMAGE_SCHEMA
            && manifest.adapter == ADAPTER
            && manifest.profile == PROFILE
            && manifest.selection == context.expected_selection
            && manifest.selection.canonical_project == context.canonical_project
            && manifest.selection.runtime_digest == context.runtime_digest,
        ErrorKind::Changed,
        "prepared image selection mismatch",
    )?;
    let selection = &manifest.selection;
    require(
        selection.surface == "codex"
            && selection.event == "stop"
            && selection.configuration == "system"
            && !selection.handlers.is_empty()
            && selection.handlers.len() <= 256,
        ErrorKind::UnsupportedProfile,
        "unsupported selected runtime profile",
    )?;
    let selected = selection
        .handlers
        .get(usize::from(selection.selected_index))
        .ok_or_else(|| fail(ErrorKind::Invalid, "selected handler missing"))?;
    require(
        selected.entry == "session-log.sh"
            && selected.name == "session-log.sh"
            && selected.args.is_empty()
            && selected.kind == "project-override"
            && selected.path.ends_with("/session-log.sh"),
        ErrorKind::UnsupportedProfile,
        "selected render handler is not exact project override",
    )?;
    require(
        manifest.execution.dispatcher == "runtime/dispatch.sh"
            && manifest.execution.hooks == "hooks"
            && manifest.execution.client == "client/service-client.js",
        ErrorKind::UnsupportedProfile,
        "unsupported sealed execution entry",
    )?;
    require(
        manifest.original_closure.len() <= MAX_FILES
            && manifest.execution.files.len() <= MAX_FILES
            && !manifest.execution.files.is_empty(),
        ErrorKind::Invalid,
        "image file count bound",
    )?;
    require(
        manifest
            .original_closure
            .windows(2)
            .all(|w| (&w[0].origin, &w[0].relative_path) < (&w[1].origin, &w[1].relative_path)),
        ErrorKind::Invalid,
        "original closure not sorted unique",
    )?;
    require(
        manifest.original_closure.iter().all(|r| {
            matches!(r.origin.as_str(), "runtime" | "project" | "client")
                && absolute(&r.path)
                && relative(&r.relative_path)
                && digest(&r.sha256)
                && r.bytes <= MAX_FILE_BYTES
        }),
        ErrorKind::Invalid,
        "invalid original closure row",
    )?;
    require(
        sorted_unique(manifest.execution.files.iter().map(|r| r.path.as_str()))
            && manifest.execution.files.iter().all(|r| {
                relative(&r.path)
                    && digest(&r.sha256)
                    && r.bytes <= MAX_FILE_BYTES
                    && r.mode == 0o555
            })
            && manifest
                .execution
                .files
                .iter()
                .try_fold(0u64, |n, f| n.checked_add(f.bytes))
                .is_some_and(|n| n <= MAX_TOTAL_BYTES),
        ErrorKind::Invalid,
        "invalid sealed file table",
    )?;
    validate_foreign_profile(&manifest.original_closure)?;
    require(
        valid_tool_names(&manifest.toolchain_tcb.tools)
            && manifest
                .toolchain_tcb
                .tools
                .iter()
                .all(|t| absolute(&t.path) && digest(&t.sha256))
            && manifest.toolchain_tcb.python_flags == ["-I", "-S", "-B"]
            && manifest.toolchain_tcb.system_dependencies == "trusted-not-hash-complete",
        ErrorKind::UnsupportedProfile,
        "unsupported toolchain declaration",
    )?;
    for tool in &manifest.toolchain_tcb.tools {
        if tool.name == PLAN_TOOL {
            require(
                context.native_executable.as_deref() == Some(Path::new(&tool.path)),
                ErrorKind::UnsupportedProfile,
                "plan helper is not the configured native executable",
            )?;
        }
        if tool.name == "caws" {
            require(
                context
                    .client_root
                    .parent()
                    .map(|p| p.join("index.js"))
                    .as_deref()
                    == Some(Path::new(&tool.path)),
                ErrorKind::UnsupportedProfile,
                "CAWS entry is not derived from configured versioned distribution",
            )?;
        }
        if tool.name == "bash" {
            require(
                tool.path == "/bin/bash",
                ErrorKind::UnsupportedProfile,
                "bash tool is not canonical system executable",
            )?;
        }
        if tool.name == "sh" {
            require(
                tool.path == "/bin/sh",
                ErrorKind::UnsupportedProfile,
                "sh tool is not canonical system executable",
            )?;
        }
    }
    require(
        original_closure_digest(manifest)? == manifest.original_closure_digest
            && source_generation(manifest)? == manifest.source_generation,
        ErrorKind::Invalid,
        "derived image source identity mismatch",
    )?;
    require(
        hash(&json(manifest)?) == context.expected_image_digest,
        ErrorKind::Changed,
        "image digest mismatch",
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    size: u64,
    uid: u32,
    mode: u32,
    links: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
}
impl Stamp {
    fn of(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            size: m.len(),
            uid: m.uid(),
            mode: m.mode(),
            links: m.nlink(),
            mtime: m.mtime(),
            mtime_ns: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_ns: m.ctime_nsec(),
        }
    }
}
/// A private image parent is a mutable namespace: other valid callers may add
/// stages or publish sibling images during admission. Its custody is its named
/// directory identity and access profile, not its child count or timestamps.
/// Immutable image roots, files, policy and sources continue to use full Stamp.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PrivateParentIdentity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
}
impl PrivateParentIdentity {
    fn checked(file: &File) -> Result<Self> {
        let metadata = checked_metadata(file, Access::PrivateParent)?;
        Ok(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            uid: metadata.uid(),
            mode: metadata.mode(),
        })
    }
}
fn check_named_image_custody(
    root: &Path,
    root_stamp: &Stamp,
    parent: &Path,
    parent_identity: &PrivateParentIdentity,
    expires: Instant,
) -> Result<()> {
    require(
        Stamp::of(&checked_metadata(
            &absolute_directory(root, Access::SealedDirectory, expires)?,
            Access::SealedDirectory,
        )?) == *root_stamp
            && PrivateParentIdentity::checked(&absolute_directory(
                parent,
                Access::PrivateParent,
                expires,
            )?)? == *parent_identity,
        ErrorKind::Changed,
        "named image custody changed",
    )
}
#[derive(Clone, Copy)]
enum Access {
    Source,
    PrivateParent,
    SealedDirectory,
    Manifest,
    SealedFile,
    OperatorPolicy,
}
fn checked_metadata(file: &File, access: Access) -> Result<Metadata> {
    let m = file.metadata().map_err(|e| io_error("file metadata", e))?;
    let uid = unsafe { libc::geteuid() };
    let owner = if matches!(access, Access::Source) {
        m.uid() == uid || m.uid() == 0
    } else {
        m.uid() == uid
    };
    let valid = match access {
        Access::Source => {
            (m.is_file() || m.is_dir())
                && (m.mode() & 0o022 == 0 || (m.is_dir() && m.uid() == 0 && m.mode() & 0o1000 != 0))
        }
        Access::PrivateParent => m.is_dir() && m.mode() & 0o7777 == 0o700,
        Access::SealedDirectory => m.is_dir() && m.mode() & 0o7777 == 0o500,
        Access::Manifest => m.is_file() && m.mode() & 0o7777 == 0o400 && m.nlink() == 1,
        Access::SealedFile => m.is_file() && m.mode() & 0o7777 == 0o555 && m.nlink() == 1,
        Access::OperatorPolicy => m.is_file() && m.mode() & 0o7777 == 0o600 && m.nlink() == 1,
    };
    require(
        owner && valid,
        ErrorKind::UnsafePath,
        "file owner/type/mode violates image profile",
    )?;
    Ok(m)
}
fn owned(fd: libc::c_int) -> Result<OwnedFd> {
    if fd < 0 {
        Err(io_error(
            "open nofollow component",
            io::Error::last_os_error(),
        ))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}
fn duplicate(fd: RawFd) -> Result<OwnedFd> {
    owned(unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) })
}
fn component(parent: RawFd, name: &str, directory: bool) -> Result<File> {
    let name = CString::new(name).map_err(|_| fail(ErrorKind::UnsafePath, "NUL path component"))?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    Ok(File::from(owned(unsafe {
        libc::openat(parent, name.as_ptr(), flags)
    })?))
}
fn absolute_directory(path: &Path, access: Access, expires: Instant) -> Result<File> {
    deadline(expires)?;
    let text = path
        .to_str()
        .ok_or_else(|| fail(ErrorKind::UnsafePath, "directory path is not UTF-8"))?;
    require(
        absolute(text),
        ErrorKind::UnsafePath,
        "directory path is not normalized absolute",
    )?;
    let mut current = File::from(owned(unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    })?);
    if text != "/" {
        for name in text[1..].split('/') {
            deadline(expires)?;
            let next = component(current.as_raw_fd(), name, true)?;
            checked_metadata(&next, Access::Source)?;
            current = next;
        }
    }
    checked_metadata(&current, access)?;
    deadline(expires)?;
    Ok(current)
}
fn relative_file(
    parent: &File,
    relative_path: &str,
    access: Access,
    expires: Instant,
) -> Result<File> {
    require(
        relative(relative_path),
        ErrorKind::UnsafePath,
        "invalid relative file path",
    )?;
    let mut current = File::from(duplicate(parent.as_raw_fd())?);
    let names: Vec<_> = relative_path.split('/').collect();
    for name in &names[..names.len() - 1] {
        deadline(expires)?;
        let next = component(current.as_raw_fd(), name, true)?;
        checked_metadata(
            &next,
            if matches!(access, Access::SealedFile | Access::Manifest) {
                Access::SealedDirectory
            } else {
                Access::Source
            },
        )?;
        current = next;
    }
    let file = component(current.as_raw_fd(), names[names.len() - 1], false)?;
    checked_metadata(&file, access)?;
    deadline(expires)?;
    Ok(file)
}
fn read_file(
    mut file: File,
    max: u64,
    access: Access,
    expires: Instant,
) -> Result<(Vec<u8>, Stamp)> {
    deadline(expires)?;
    let before = Stamp::of(&checked_metadata(&file, access)?);
    require(
        file.metadata()
            .map_err(|e| io_error("read metadata", e))?
            .is_file()
            && before.size <= max,
        ErrorKind::UnsafePath,
        "regular file exceeds byte bound",
    )?;
    let mut bytes = Vec::with_capacity(before.size as usize);
    let mut buffer = [0u8; 65536];
    loop {
        deadline(expires)?;
        let n = file
            .read(&mut buffer)
            .map_err(|e| io_error("bounded file read", e))?;
        if n == 0 {
            break;
        }
        require(
            (bytes.len() as u64).saturating_add(n as u64) <= max,
            ErrorKind::Invalid,
            "file grew beyond byte bound",
        )?;
        bytes.extend_from_slice(&buffer[..n]);
    }
    require(
        Stamp::of(&checked_metadata(&file, access)?) == before && bytes.len() as u64 == before.size,
        ErrorKind::Changed,
        "file changed during read",
    )?;
    deadline(expires)?;
    Ok((bytes, before))
}
fn absolute_file(path: &Path, access: Access, expires: Instant) -> Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| fail(ErrorKind::UnsafePath, "file has no parent"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| fail(ErrorKind::UnsafePath, "file name is not UTF-8"))?;
    let directory = absolute_directory(parent, Access::Source, expires)?;
    relative_file(&directory, name, access, expires)
}
fn errno_pointer() -> *mut libc::c_int {
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    {
        unsafe { libc::__error() }
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        unsafe { libc::__errno_location() }
    }
}
fn names(directory: &File, expires: Instant) -> Result<Vec<String>> {
    deadline(expires)?;
    // A new description avoids sharing readdir offsets with another scan.
    let copy = owned(unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    })?;
    let raw = std::os::fd::IntoRawFd::into_raw_fd(copy);
    let stream = unsafe { libc::fdopendir(raw) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(raw);
        }
        return Err(io_error("directory stream", error));
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = Stream(stream);
    let mut result = BTreeSet::new();
    loop {
        deadline(expires)?;
        unsafe {
            *errno_pointer() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if unsafe { *errno_pointer() } != 0 {
                return Err(io_error(
                    "directory enumeration",
                    io::Error::last_os_error(),
                ));
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .map_err(|_| fail(ErrorKind::UnsafePath, "directory name not UTF-8"))?;
        if name == "." || name == ".." {
            continue;
        }
        require(
            relative(name) && !name.contains('/'),
            ErrorKind::UnsafePath,
            "invalid directory entry",
        )?;
        require(
            result.len() < MAX_FILES * 4 && result.insert(name.to_owned()),
            ErrorKind::Invalid,
            "directory entry bound or duplicate",
        )?;
    }
    Ok(result.into_iter().collect())
}
fn file_kind(directory: &File, name: &str) -> Result<libc::mode_t> {
    let name =
        CString::new(name).map_err(|_| fail(ErrorKind::UnsafePath, "NUL directory entry"))?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io_error(
            "directory entry metadata",
            io::Error::last_os_error(),
        ));
    }
    Ok(unsafe { stat.assume_init() }.st_mode & libc::S_IFMT)
}
fn scan_tree(
    directory: &File,
    prefix: &str,
    sealed: bool,
    skip_python_cache: bool,
    files: &mut BTreeSet<String>,
    directories: &mut BTreeSet<String>,
    expires: Instant,
) -> Result<()> {
    deadline(expires)?;
    require(
        files.len() + directories.len() <= MAX_FILES * 4,
        ErrorKind::Invalid,
        "tree entry bound",
    )?;
    for name in names(directory, expires)? {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        match file_kind(directory, &name)? {
            libc::S_IFDIR => {
                let child = component(directory.as_raw_fd(), &name, true)?;
                checked_metadata(
                    &child,
                    if sealed {
                        Access::SealedDirectory
                    } else {
                        Access::Source
                    },
                )?;
                if skip_python_cache && name == "__pycache__" {
                    continue;
                }
                require(
                    directories.insert(path.clone()),
                    ErrorKind::Invalid,
                    "duplicate directory",
                )?;
                scan_tree(
                    &child,
                    &path,
                    sealed,
                    skip_python_cache,
                    files,
                    directories,
                    expires,
                )?;
            }
            libc::S_IFREG => {
                if skip_python_cache && (name.ends_with(".pyc") || name.ends_with(".pyo")) {
                    continue;
                }
                require(files.insert(path), ErrorKind::Invalid, "duplicate file")?;
            }
            _ => {
                return Err(fail(
                    ErrorKind::UnsafePath,
                    "nonregular or symlink tree entry",
                ));
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
pub struct ValidatedImage {
    manifest: PreparedImageManifest,
    image_digest: String,
    root: PathBuf,
    root_stamp: Stamp,
    policy_stamp: Stamp,
    _root_handle: File,
    prefix_concurrency: PrefixConcurrency,
}

impl ValidatedImage {
    pub fn prefix_concurrency(&self) -> PrefixConcurrency {
        self.prefix_concurrency.clone()
    }
    pub fn manifest(&self) -> &PreparedImageManifest {
        &self.manifest
    }
    pub fn image_digest(&self) -> &str {
        &self.image_digest
    }
    /// Re-run source, declaration, transform, and sealed-file checks immediately
    /// before backend spawn. Replacement is a refusal, never a fresh admission.
    pub fn revalidate(&self, context: &AdmissionContext, expires: Instant) -> Result<()> {
        let current = validate_image(&self.root, context, expires)?;
        require(
            current.manifest == self.manifest
                && current.root_stamp == self.root_stamp
                && current.policy_stamp == self.policy_stamp,
            ErrorKind::Changed,
            "admitted image or policy inode changed",
        )
    }
}

#[derive(Debug)]
struct RuntimeFiles(BTreeMap<String, String>);
impl<'de> Deserialize<'de> for RuntimeFiles {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = RuntimeFiles;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("unique runtime file hashes")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut files = BTreeMap::new();
                while let Some((path, hash)) = a.next_entry::<String, String>()? {
                    if files.insert(path, hash).is_some() {
                        return Err(serde::de::Error::custom("duplicate runtime path"));
                    }
                }
                Ok(RuntimeFiles(files))
            }
        }
        d.deserialize_map(V)
    }
}
struct Pin {
    path: PathBuf,
    stamp: Stamp,
    access: Access,
}
struct Originals {
    bytes: BTreeMap<(String, String), Vec<u8>>,
    pins: Vec<Pin>,
    runtime_files: BTreeMap<String, String>,
}
impl Originals {
    fn get(&self, origin: &str, relative: &str) -> Result<&[u8]> {
        self.bytes
            .get(&(origin.to_owned(), relative.to_owned()))
            .map(Vec::as_slice)
            .ok_or_else(|| fail(ErrorKind::Invalid, "required original source missing"))
    }
}
fn read_originals(
    manifest: &PreparedImageManifest,
    context: &AdmissionContext,
    expires: Instant,
) -> Result<Originals> {
    let runtime_root = context
        .home
        .join("lib/runtimes")
        .join(&context.runtime_digest);
    let runtime = absolute_directory(&runtime_root, Access::Source, expires)?;
    let (runtime_manifest, runtime_stamp) = read_file(
        relative_file(&runtime, "manifest.json", Access::Source, expires)?,
        MAX_MANIFEST_BYTES,
        Access::Source,
        expires,
    )?;
    require(
        hash(&runtime_manifest) == context.runtime_digest,
        ErrorKind::Changed,
        "runtime manifest generation mismatch",
    )?;
    let RuntimeFiles(runtime_files) = serde_json::from_slice(&runtime_manifest)
        .map_err(|_| fail(ErrorKind::Invalid, "invalid runtime manifest"))?;
    require(
        !runtime_files.is_empty()
            && runtime_files.len() < MAX_FILES
            && runtime_files
                .keys()
                .all(|p| relative(p) && p != "manifest.json")
            && runtime_files.values().all(|h| digest(h)),
        ErrorKind::Invalid,
        "invalid runtime source table",
    )?;
    for mandatory in [
        "launcher.py",
        "dispatch.sh",
        "handler-env.sh",
        "lib/run-handlers.sh",
    ] {
        require(
            runtime_files.contains_key(mandatory),
            ErrorKind::UnsupportedProfile,
            "runtime lacks required image source",
        )?;
    }
    let expected_runtime: BTreeSet<_> = runtime_files
        .keys()
        .cloned()
        .chain(std::iter::once("manifest.json".to_owned()))
        .collect();
    let mut runtime_observed = BTreeSet::new();
    let mut runtime_directories = BTreeSet::new();
    scan_tree(
        &runtime,
        "",
        false,
        false,
        &mut runtime_observed,
        &mut runtime_directories,
        expires,
    )?;
    require(
        runtime_observed == expected_runtime,
        ErrorKind::Changed,
        "runtime tree has undeclared or missing files",
    )?;
    let selected = &manifest.selection.handlers[usize::from(manifest.selection.selected_index)];
    let project_root = Path::new(&selected.path)
        .parent()
        .ok_or_else(|| fail(ErrorKind::Invalid, "original handler has no parent"))?;
    require(
        project_root.starts_with(&context.canonical_project),
        ErrorKind::UnsafePath,
        "project handler escapes canonical project",
    )?;
    let project = absolute_directory(project_root, Access::Source, expires)?;
    let project_lib = component(project.as_raw_fd(), "lib", true)?;
    checked_metadata(&project_lib, Access::Source)?;
    let mut project_observed = BTreeSet::new();
    let mut project_directories = BTreeSet::new();
    scan_tree(
        &project_lib,
        "lib",
        false,
        true,
        &mut project_observed,
        &mut project_directories,
        expires,
    )?;
    let expected_lib: BTreeSet<_> = FOREIGN_PROFILE
        .iter()
        .filter(|(p, _)| p.starts_with("lib/"))
        .map(|(p, _)| (*p).to_owned())
        .collect();
    require(
        project_observed == expected_lib,
        ErrorKind::UnsupportedProfile,
        "unreviewed or missing foreign library source",
    )?;
    let client_sources = configured_client_sources(context);
    let expected_client: BTreeSet<_> = client_sources.keys().cloned().collect();
    let expected_project: BTreeSet<_> = FOREIGN_PROFILE
        .iter()
        .map(|(p, _)| (*p).to_owned())
        .collect();
    let mut expected = BTreeSet::new();
    for (origin, paths) in [
        ("runtime", &expected_runtime),
        ("project", &expected_project),
        ("client", &expected_client),
    ] {
        for path in paths {
            expected.insert((origin.to_owned(), path.clone()));
        }
    }
    let declared: BTreeSet<_> = manifest
        .original_closure
        .iter()
        .map(|r| (r.origin.clone(), r.relative_path.clone()))
        .collect();
    require(
        expected == declared,
        ErrorKind::Invalid,
        "original closure membership differs from known profile",
    )?;
    let mut originals = Originals {
        bytes: BTreeMap::new(),
        pins: vec![Pin {
            path: runtime_root.join("manifest.json"),
            stamp: runtime_stamp,
            access: Access::Source,
        }],
        runtime_files,
    };
    let mut total = 0u64;
    for row in &manifest.original_closure {
        deadline(expires)?;
        let path = match row.origin.as_str() {
            "runtime" => runtime_root.join(&row.relative_path),
            "project" => project_root.join(&row.relative_path),
            "client" => client_sources
                .get(&row.relative_path)
                .ok_or_else(|| fail(ErrorKind::Invalid, "unknown configured client source"))?
                .clone(),
            _ => return Err(fail(ErrorKind::Invalid, "unknown source origin")),
        };
        require(
            path.to_str() == Some(row.path.as_str()),
            ErrorKind::UnsafePath,
            "original source path differs from configured root",
        )?;
        let (bytes, stamp) = read_file(
            absolute_file(&path, Access::Source, expires)?,
            MAX_FILE_BYTES,
            Access::Source,
            expires,
        )?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| fail(ErrorKind::Invalid, "source closure size overflow"))?;
        require(
            total <= MAX_TOTAL_BYTES
                && bytes.len() as u64 == row.bytes
                && hash(&bytes) == row.sha256,
            ErrorKind::Changed,
            "original source bytes changed",
        )?;
        if row.origin == "runtime" && row.relative_path != "manifest.json" {
            require(
                originals.runtime_files.get(&row.relative_path) == Some(&row.sha256),
                ErrorKind::Changed,
                "runtime file digest mismatch",
            )?;
        }
        originals.pins.push(Pin {
            path,
            stamp,
            access: Access::Source,
        });
        originals
            .bytes
            .insert((row.origin.clone(), row.relative_path.clone()), bytes);
    }
    require(
        selected.sha256 == hash(originals.get("project", "session-log.sh")?),
        ErrorKind::Changed,
        "selected handler fingerprint mismatch",
    )?;
    require(
        manifest.execution.handler_routes.len() == manifest.selection.handlers.len(),
        ErrorKind::Invalid,
        "handler route count differs",
    )?;
    for (index, handler) in manifest.selection.handlers.iter().enumerate() {
        require(
            absolute(&handler.path)
                && digest(&handler.sha256)
                && relative(&handler.name)
                && !handler.name.contains('/')
                && handler.name.ends_with(".sh")
                && handler.args.iter().all(|a| {
                    !a.is_empty()
                        && a.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_.:/-".contains(&c))
                })
                && matches!(
                    handler.tier.as_str(),
                    "stock" | "repo-policy" | "machine-policy"
                )
                && handler.entry
                    == std::iter::once(handler.name.as_str())
                        .chain(handler.args.iter().map(String::as_str))
                        .collect::<Vec<_>>()
                        .join(" "),
            ErrorKind::Invalid,
            "malformed selected handler",
        )?;
        let execution_relative = if index == usize::from(manifest.selection.selected_index) {
            "hooks/session-log.sh".to_owned()
        } else {
            require(
                handler.kind == "stock"
                    && handler.path
                        == runtime_root.join(&handler.name).to_str().ok_or_else(|| {
                            fail(ErrorKind::Invalid, "runtime handler path not UTF-8")
                        })?
                    && originals.runtime_files.get(&handler.name) == Some(&handler.sha256),
                ErrorKind::UnsupportedProfile,
                "other selected handler is not verified runtime stock",
            )?;
            format!("runtime/{}", handler.name)
        };
        let route = &manifest.execution.handler_routes[index];
        require(
            route.selected_index as usize == index
                && route.entry == handler.entry
                && route.original_path == handler.path
                && route.original_sha256 == handler.sha256
                && route.execution_relative == execution_relative,
            ErrorKind::Invalid,
            "handler route does not match actual selection",
        )?;
    }
    require(
        sorted_unique(manifest.selection.libraries.iter().map(|l| l.name.as_str()))
            && manifest.execution.resolved_libraries.len() == manifest.selection.libraries.len(),
        ErrorKind::Invalid,
        "resolved library count or order differs",
    )?;
    for (library, resolved) in manifest
        .selection
        .libraries
        .iter()
        .zip(&manifest.execution.resolved_libraries)
    {
        require(
            relative(&library.name) && !library.name.contains('/') && digest(&library.sha256),
            ErrorKind::Invalid,
            "malformed selected library",
        )?;
        let relative = match library.kind.as_str() {
            "shared" => format!("lib/{}", library.name),
            "surface" => format!("surfaces/codex/lib/{}", library.name),
            _ => {
                return Err(fail(
                    ErrorKind::UnsupportedProfile,
                    "project or user library unsupported",
                ));
            }
        };
        require(
            library.path
                == runtime_root
                    .join(&relative)
                    .to_str()
                    .ok_or_else(|| fail(ErrorKind::Invalid, "runtime library path not UTF-8"))?
                && originals.runtime_files.get(&relative) == Some(&library.sha256)
                && resolved.name == library.name
                && resolved.original_path == library.path
                && resolved.original_sha256 == library.sha256
                && resolved.execution_relative == format!("runtime/{relative}"),
            ErrorKind::Changed,
            "library route does not match runtime selection",
        )?;
    }
    Ok(originals)
}
fn verify_tool(tool: &Tool, context: &AdmissionContext, expires: Instant) -> Result<Pin> {
    deadline(expires)?;
    if tool.name == PLAN_TOOL {
        require(
            context.native_executable.as_deref() == Some(Path::new(&tool.path)),
            ErrorKind::UnsupportedProfile,
            "plan helper is not the configured native executable",
        )?;
    }
    if tool.name == "caws" {
        require(
            context
                .client_root
                .parent()
                .map(|p| p.join("index.js"))
                .as_deref()
                == Some(Path::new(&tool.path)),
            ErrorKind::UnsupportedProfile,
            "CAWS entry is not derived from configured versioned distribution",
        )?;
    }
    let mut file = absolute_file(Path::new(&tool.path), Access::Source, expires)?;
    let meta = checked_metadata(&file, Access::Source)?;
    let before = Stamp::of(&meta);
    require(
        meta.is_file()
            && (tool.name == "caws" || meta.mode() & 0o111 != 0)
            && meta.len() <= MAX_TOOL_BYTES,
        ErrorKind::UnsafePath,
        "tool is not bounded executable regular file",
    )?;
    let mut hasher = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        deadline(expires)?;
        let n = file
            .read(&mut buffer)
            .map_err(|e| io_error("tool fingerprint read", e))?;
        if n == 0 {
            break;
        }
        count = count.saturating_add(n as u64);
        require(
            count <= MAX_TOOL_BYTES,
            ErrorKind::Invalid,
            "tool grew beyond bound",
        )?;
        hasher.update(&buffer[..n]);
    }
    require(
        count == before.size
            && Stamp::of(&checked_metadata(&file, Access::Source)?) == before
            && format!("{:x}", hasher.finalize()) == tool.sha256,
        ErrorKind::Changed,
        "tool fingerprint changed",
    )?;
    Ok(Pin {
        path: PathBuf::from(&tool.path),
        stamp: before,
        access: Access::Source,
    })
}
fn check_pins(pins: &[Pin], expires: Instant) -> Result<()> {
    for pin in pins {
        deadline(expires)?;
        let file = absolute_file(&pin.path, pin.access, expires)?;
        require(
            Stamp::of(&checked_metadata(&file, pin.access)?) == pin.stamp,
            ErrorKind::Changed,
            "captured file changed during admission",
        )?;
    }
    Ok(())
}
fn expected_directories(files: &BTreeSet<String>) -> BTreeSet<String> {
    let mut dirs = BTreeSet::new();
    for path in files {
        let mut parent = Path::new(path).parent();
        while let Some(p) = parent {
            if p.as_os_str().is_empty() {
                break;
            }
            dirs.insert(
                p.to_str()
                    .expect("validated ASCII relative path")
                    .to_owned(),
            );
            parent = p.parent();
        }
    }
    dirs
}

pub fn validate_image(
    root: &Path,
    context: &AdmissionContext,
    expires: Instant,
) -> Result<ValidatedImage> {
    validate_image_at(root, root, context, expires)
}
fn validate_image_at(
    root: &Path,
    logical_root: &Path,
    context: &AdmissionContext,
    expires: Instant,
) -> Result<ValidatedImage> {
    deadline(expires)?;
    // Native-derived private parent is checked before opening the supplied child.
    let parent = absolute_directory(&image_parent(context), Access::PrivateParent, expires)?;
    let parent_identity = PrivateParentIdentity::checked(&parent)?;
    require(
        root.parent() == Some(image_parent(context).as_path()),
        ErrorKind::UnsafePath,
        "image is outside native-derived parent",
    )?;
    let directory = absolute_directory(root, Access::SealedDirectory, expires)?;
    let root_stamp = Stamp::of(&checked_metadata(&directory, Access::SealedDirectory)?);
    let (manifest_bytes, manifest_stamp) = read_file(
        relative_file(&directory, "manifest.json", Access::Manifest, expires)?,
        MAX_MANIFEST_BYTES,
        Access::Manifest,
        expires,
    )?;
    let manifest: PreparedImageManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| fail(ErrorKind::Invalid, "malformed sealed image manifest"))?;
    require(
        json(&manifest)? == manifest_bytes,
        ErrorKind::Invalid,
        "sealed manifest is not canonical fixed-order JSON",
    )?;
    validate_binding(&manifest, context, logical_root)?;
    let policy_file = policy_path(context);
    let (policy_bytes, policy_stamp) = read_file(
        absolute_file(&policy_file, Access::OperatorPolicy, expires)?,
        MAX_POLICY_BYTES,
        Access::OperatorPolicy,
        expires,
    )?;
    require(
        hash(&policy_bytes) == context.expected_policy_sha256,
        ErrorKind::Changed,
        "explicit operator declaration bytes changed",
    )?;
    let policy: OperatorPolicy = serde_json::from_slice(&policy_bytes)
        .map_err(|_| fail(ErrorKind::Invalid, "malformed operator declaration"))?;
    validate_policy(&policy, &manifest)?;
    let mut originals = read_originals(&manifest, context, expires)?;
    for tool in &manifest.toolchain_tcb.tools {
        originals.pins.push(verify_tool(tool, context, expires)?);
    }
    let expected = execution_bytes(&manifest, &originals)?;
    let expected_names: BTreeSet<_> = expected
        .keys()
        .cloned()
        .chain(std::iter::once("manifest.json".to_owned()))
        .collect();
    let declared_names: BTreeSet<_> = manifest
        .execution
        .files
        .iter()
        .map(|f| f.path.clone())
        .chain(std::iter::once("manifest.json".to_owned()))
        .collect();
    require(
        expected_names == declared_names,
        ErrorKind::Invalid,
        "sealed file membership differs from reconstructed image",
    )?;
    let mut observed = BTreeSet::new();
    let mut directories = BTreeSet::new();
    scan_tree(
        &directory,
        "",
        true,
        false,
        &mut observed,
        &mut directories,
        expires,
    )?;
    require(
        observed == expected_names && directories == expected_directories(&expected_names),
        ErrorKind::UnsafePath,
        "sealed image has missing or extra entries",
    )?;
    for row in &manifest.execution.files {
        deadline(expires)?;
        let (bytes, stamp) = read_file(
            relative_file(&directory, &row.path, Access::SealedFile, expires)?,
            MAX_FILE_BYTES,
            Access::SealedFile,
            expires,
        )?;
        require(
            bytes.len() as u64 == row.bytes
                && hash(&bytes) == row.sha256
                && expected.get(&row.path) == Some(&bytes),
            ErrorKind::Changed,
            "sealed image bytes differ from native reconstruction",
        )?;
        originals.pins.push(Pin {
            path: root.join(&row.path),
            stamp,
            access: Access::SealedFile,
        });
    }
    originals.pins.push(Pin {
        path: root.join("manifest.json"),
        stamp: manifest_stamp,
        access: Access::Manifest,
    });
    originals.pins.push(Pin {
        path: policy_file,
        stamp: policy_stamp.clone(),
        access: Access::OperatorPolicy,
    });
    check_pins(&originals.pins, expires)?;
    check_named_image_custody(
        root,
        &root_stamp,
        &image_parent(context),
        &parent_identity,
        expires,
    )?;
    deadline(expires)?;
    let prefix_concurrency = derive_prefix_concurrency(&manifest, &originals);
    Ok(ValidatedImage {
        manifest,
        image_digest: context.expected_image_digest.clone(),
        root: root.to_owned(),
        root_stamp,
        policy_stamp,
        _root_handle: directory,
        prefix_concurrency,
    })
}

const CLIENT_SHELL: &str =
    include_str!("../../caws-cli/templates/hook-packs/shared/lib/session-render-service-client.sh");
const TEMPLATES: &[(&str, &str)] = &[
    (
        "caws.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/caws.sh"),
    ),
    (
        "codex-parser-runtime.sh",
        include_str!(
            "../../caws-cli/templates/hook-packs/runtime/service-image/codex-parser-runtime.sh"
        ),
    ),
    (
        "dispatch.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/dispatch.sh"),
    ),
    (
        "execute-handler.sh",
        include_str!(
            "../../caws-cli/templates/hook-packs/runtime/service-image/execute-handler.sh"
        ),
    ),
    (
        "git.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/git.sh"),
    ),
    (
        "handler-env.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/handler-env.sh"),
    ),
    (
        "handler-routes.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/handler-routes.sh"),
    ),
    (
        "libraries.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/libraries.sh"),
    ),
    (
        "parse-input.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/parse-input.sh"),
    ),
    (
        "plan-transcript-finalize.sh",
        include_str!(
            "../../caws-cli/templates/hook-packs/runtime/service-image/plan-transcript-finalize.sh"
        ),
    ),
    (
        "tool.sh",
        include_str!("../../caws-cli/templates/hook-packs/runtime/service-image/tool.sh"),
    ),
];
fn template(name: &str) -> Result<&'static str> {
    TEMPLATES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, s)| *s)
        .ok_or_else(|| fail(ErrorKind::Invalid, "unknown owned adapter template"))
}
fn configured_client_sources(context: &AdmissionContext) -> BTreeMap<String, PathBuf> {
    let mut sources = BTreeMap::new();
    for name in ["service-client.js", "service-protocol.js"] {
        sources.insert(name.to_owned(), context.client_root.join(name));
    }
    sources.insert(
        "session-render-service-client.sh".into(),
        context.client_shell_source.clone(),
    );
    for (name, _) in TEMPLATES {
        sources.insert(
            format!("service-image/{name}"),
            context.template_root.join(name),
        );
    }
    sources
}
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
/// Substitute original template marker occurrences exactly once. Inserted data
/// is never scanned again and cannot introduce a second expansion instruction.
fn expand(source: &str, replacements: &[(&str, String)]) -> Result<Vec<u8>> {
    let mut positions = Vec::new();
    for (marker, value) in replacements {
        let found: Vec<_> = source.match_indices(marker).map(|(at, _)| at).collect();
        require(
            found.len() == 1,
            ErrorKind::UnsupportedProfile,
            "owned template marker count differs",
        )?;
        positions.push((found[0], *marker, value));
    }
    positions.sort_by_key(|(at, _, _)| *at);
    let mut result = Vec::new();
    let mut offset = 0;
    for (at, marker, value) in positions {
        require(
            at >= offset,
            ErrorKind::Invalid,
            "overlapping template markers",
        )?;
        result.extend_from_slice(&source.as_bytes()[offset..at]);
        result.extend_from_slice(value.as_bytes());
        offset = at + marker.len();
    }
    result.extend_from_slice(&source.as_bytes()[offset..]);
    Ok(result)
}
fn text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| {
        fail(
            ErrorKind::UnsupportedProfile,
            "adapter source is not lossless UTF-8",
        )
    })
}
fn replace_exact(source: &str, needle: &str, replacement: &str, count: usize) -> Result<String> {
    require(
        source.matches(needle).count() == count,
        ErrorKind::UnsupportedProfile,
        "runtime adaptation anchor count differs",
    )?;
    Ok(source.replace(needle, replacement))
}
fn transformed_run_handlers(original: &[u8], manifest: &PreparedImageManifest) -> Result<Vec<u8>> {
    let routes=manifest.execution.handler_routes.iter().map(|route|format!("      {}) [[ \"$entry\" == {} && \"$handler_path\" == {} ]] || return 2; handler_execution_path={} ;;",route.selected_index,quoted(&route.entry),quoted(&route.original_path),quoted(&format!("{}/{}",manifest.execution.root,route.execution_relative)))).collect::<Vec<_>>().join("\n");
    let route_fragment = expand(
        template("handler-routes.sh")?,
        &[("__CAWS_IMAGE_HANDLER_CASES__", routes)],
    )?;
    let mut source = replace_exact(
        text(original)?,
        "\"$handler_path\" \"$@\"",
        "_caws_service_image_exec \"$@\"",
        2,
    )?;
    let anchor = "    if [[ ! -x \"$handler_path\" ]]; then\n";
    source = replace_exact(
        &source,
        anchor,
        &format!("{}{anchor}", text(&route_fragment)?),
        1,
    )?;
    source = replace_exact(
        &source,
        "    source \"${HOOKS_DIR}/lib/parse-input.sh\" 2>/dev/null || return 0\n",
        template("parse-input.sh")?,
        1,
    )?;
    let mut result = expand(
        template("execute-handler.sh")?,
        &[(
            "__CAWS_IMAGE_SELECTED_INDEX__",
            manifest.selection.selected_index.to_string(),
        )],
    )?;
    result.extend_from_slice(source.as_bytes());
    Ok(result)
}
const CODEX_PARSER_BOOTSTRAP: &str = r#"_codex_pi_shared="${CAWS_PROJECT_DIR:-.}/.caws/hooks/runtime-paths.sh"
if [[ -f "$_codex_pi_shared" ]]; then
  # shellcheck disable=SC1090
  source "$_codex_pi_shared"
else
  # Fallback: try to find runtime-paths.sh relative to this file's parent's
  # parent (override lib -> override dir -> .caws/hooks).
  _codex_pi_fallback="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && cd ../../.. && pwd)/runtime-paths.sh"
  # shellcheck disable=SC1090
  [[ -f "$_codex_pi_fallback" ]] && source "$_codex_pi_fallback"
fi
unset _codex_pi_shared _codex_pi_fallback
"#;
fn execution_bytes(
    manifest: &PreparedImageManifest,
    originals: &Originals,
) -> Result<BTreeMap<String, Vec<u8>>> {
    // Every adapted byte is derived here from native-owned literal templates.
    // The manifest's self-declared file hashes cannot authorize arbitrary code.
    for (name, expected) in TEMPLATES {
        require(
            originals.get("client", &format!("service-image/{name}"))? == expected.as_bytes(),
            ErrorKind::Changed,
            "adapter template differs from native-owned bytes",
        )?;
    }
    require(
        originals.get("client", "session-render-service-client.sh")? == CLIENT_SHELL.as_bytes(),
        ErrorKind::Changed,
        "service client shell differs from native-owned bytes",
    )?;
    let mut files = BTreeMap::new();
    for ((origin, path), bytes) in &originals.bytes {
        let target = match origin.as_str() {
            "runtime" => Some(format!("runtime/{path}")),
            "project" => Some(format!("hooks/{path}")),
            "client" if matches!(path.as_str(), "service-client.js" | "service-protocol.js") => {
                Some(format!("client/{path}"))
            }
            _ => None,
        };
        if let Some(target) = target {
            require(
                files.insert(target, bytes.clone()).is_none(),
                ErrorKind::Invalid,
                "duplicate reconstructed image file",
            )?;
        }
    }
    require(
        !files.contains_key("runtime/sealed-libraries.sh"),
        ErrorKind::UnsupportedProfile,
        "original runtime collides with sealed library resolver",
    )?;
    let resolver = quoted(&format!(
        "{}/runtime/sealed-libraries.sh",
        manifest.execution.root
    ));
    for name in ["dispatch.sh", "handler-env.sh"] {
        require(
            files.contains_key(&format!("runtime/{name}")),
            ErrorKind::UnsupportedProfile,
            "required runtime adaptation source missing",
        )?;
        files.insert(
            format!("runtime/{name}"),
            expand(
                template(name)?,
                &[("__CAWS_IMAGE_RESOLVER__", resolver.clone())],
            )?,
        );
    }
    let library_cases = manifest
        .execution
        .resolved_libraries
        .iter()
        .map(|library| {
            format!(
                "    {}) source {}; return $? ;;",
                quoted(&library.name),
                quoted(&format!(
                    "{}/{}",
                    manifest.execution.root, library.execution_relative
                ))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    files.insert(
        "runtime/sealed-libraries.sh".into(),
        expand(
            template("libraries.sh")?,
            &[("__CAWS_IMAGE_LIBRARY_CASES__", library_cases)],
        )?,
    );
    let parser_path = "surfaces/codex/lib/parse-input.sh";
    let replacement = expand(
        template("codex-parser-runtime.sh")?,
        &[(
            "__CAWS_IMAGE_RUNTIME_PATHS__",
            quoted(&format!(
                "{}/runtime/runtime-paths.sh",
                manifest.execution.root
            )),
        )],
    )?;
    let parser = replace_exact(
        text(originals.get("runtime", parser_path)?)?,
        CODEX_PARSER_BOOTSTRAP,
        text(&replacement)?,
        1,
    )?;
    files.insert(format!("runtime/{parser_path}"), parser.into_bytes());
    let run_handlers =
        transformed_run_handlers(originals.get("runtime", "lib/run-handlers.sh")?, manifest)?;
    files.insert("runtime/lib/run-handlers.sh".into(), run_handlers);
    if let Some(native) = manifest
        .toolchain_tcb
        .tools
        .iter()
        .find(|tool| tool.name == PLAN_TOOL)
    {
        let home = Path::new(&manifest.execution.root)
            .ancestors()
            .nth(5)
            .and_then(Path::to_str)
            .ok_or_else(|| fail(ErrorKind::Invalid, "image home missing"))?;
        files.insert(
            "runtime/plan-transcript-finalize.sh".into(),
            expand(
                template("plan-transcript-finalize.sh")?,
                &[
                    (
                        "__CAWS_IMAGE_PLAN_PROJECT__",
                        quoted(&manifest.selection.canonical_project),
                    ),
                    ("__CAWS_IMAGE_PLAN_NATIVE__", quoted(&native.path)),
                    ("__CAWS_IMAGE_PLAN_HOME__", quoted(home)),
                ],
            )?,
        );
    }
    let node = &manifest
        .toolchain_tcb
        .tools
        .iter()
        .find(|tool| tool.name == "node")
        .ok_or_else(|| fail(ErrorKind::Invalid, "Node tool missing"))?
        .path;
    let entry = format!("{}/client/service-client.js", manifest.execution.root);
    require(
        !node.contains(['\r', '\n']) && !entry.contains(['\r', '\n']),
        ErrorKind::UnsupportedProfile,
        "client executable paths contain line delimiters",
    )?;
    files.insert(
        "hooks/lib/session-log-daemon-client.sh".into(),
        expand(
            CLIENT_SHELL,
            &[
                ("__CAWS_SERVICE_CLIENT_NODE__", quoted(node)),
                ("__CAWS_SERVICE_CLIENT_ENTRY__", quoted(&entry)),
            ],
        )?,
    );
    files.insert(
        "client/package.json".into(),
        b"{\"type\":\"commonjs\"}\n".to_vec(),
    );
    for tool in &manifest.toolchain_tcb.tools {
        let body = if tool.name == "caws" {
            let git = &manifest
                .toolchain_tcb
                .tools
                .iter()
                .find(|tool| tool.name == "git")
                .ok_or_else(|| fail(ErrorKind::Invalid, "Git tool missing"))?
                .path;
            expand(
                template("caws.sh")?,
                &[
                    ("__CAWS_IMAGE_GIT_PATH__", quoted(git)),
                    ("__CAWS_IMAGE_NODE_PATH__", quoted(node)),
                    ("__CAWS_IMAGE_CLI_ENTRY__", quoted(&tool.path)),
                ],
            )?
        } else if tool.name == "git" {
            expand(
                template("git.sh")?,
                &[("__CAWS_IMAGE_TOOL_PATH__", quoted(&tool.path))],
            )?
        } else {
            let tool_path = tool.path.as_str();
            let flags = if tool.name == "python3" {
                manifest
                    .toolchain_tcb
                    .python_flags
                    .iter()
                    .map(|flag| quoted(flag))
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                String::new()
            };
            expand(
                template("tool.sh")?,
                &[
                    ("__CAWS_IMAGE_TOOL_PATH__", quoted(tool_path)),
                    ("__CAWS_IMAGE_TOOL_FLAGS__", flags),
                ],
            )?
        };
        require(
            files.insert(format!("bin/{}", tool.name), body).is_none(),
            ErrorKind::Invalid,
            "tool wrapper path collision",
        )?;
    }
    require(
        files.len() <= MAX_FILES
            && files
                .values()
                .all(|bytes| bytes.len() as u64 <= MAX_FILE_BYTES)
            && files
                .values()
                .try_fold(0u64, |n, bytes| n.checked_add(bytes.len() as u64))
                .is_some_and(|n| n <= MAX_TOTAL_BYTES),
        ErrorKind::Invalid,
        "reconstructed image exceeds file bounds",
    )?;
    Ok(files)
}

/// Native publication result. A valid existing destination is reused without
/// replacing it; its independently validated temporary sibling is retained for
/// the owner's later explicit disposal. This result issues no descriptor grant.
#[derive(Debug)]
pub struct PublishedImage {
    pub image: ValidatedImage,
    pub published: bool,
    pub retained_stage: Option<PathBuf>,
}
fn stage_name<'a>(stage: &'a Path, context: &AdmissionContext) -> Result<&'a str> {
    require(
        stage.parent() == Some(image_parent(context).as_path()),
        ErrorKind::UnsafePath,
        "staging directory is outside native-derived parent",
    )?;
    let name = stage
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| fail(ErrorKind::UnsafePath, "staging name is not UTF-8"))?;
    require(
        name.starts_with(".stage-")
            && name.len() > 7
            && name.len() <= 128
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
        ErrorKind::UnsafePath,
        "staging name is not an admitted private child",
    )?;
    Ok(name)
}
/// Only a confirmed missing directory entry permits publication. Existing
/// entries must be safe sealed directories before the full final validator is
/// called; a symlink, wrong mode, or metadata error is never treated as absence.
fn existing_image_root(parent: &File, name: &str, expires: Instant) -> Result<bool> {
    deadline(expires)?;
    require(
        digest(name),
        ErrorKind::UnsafePath,
        "existing image name is not a derived key",
    )?;
    checked_metadata(parent, Access::PrivateParent)?;
    let encoded = CString::new(name).expect("digest has no NUL");
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            encoded.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            deadline(expires)?;
            return Ok(false);
        }
        return Err(io_error("existing image metadata", error));
    }
    require(
        unsafe { stat.assume_init() }.st_mode & libc::S_IFMT == libc::S_IFDIR,
        ErrorKind::UnsafePath,
        "existing image is not a directory",
    )?;
    checked_metadata(
        &component(parent.as_raw_fd(), name, true)?,
        Access::SealedDirectory,
    )?;
    deadline(expires)?;
    Ok(true)
}
fn require_same_prepared_image(
    stage: &PreparedImageManifest,
    final_image: &PreparedImageManifest,
) -> Result<()> {
    require(
        stage == final_image,
        ErrorKind::Changed,
        "existing image differs from validated stage",
    )
}
fn rename_no_replace(parent: RawFd, stage: &str, destination: &str) -> std::io::Result<()> {
    let stage = CString::new(stage)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL staging name"))?;
    let destination = CString::new(destination)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL destination name"))?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            parent,
            stage.as_ptr(),
            parent,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            parent,
            stage.as_ptr(),
            parent,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace image publication unavailable",
    ));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn sync_image_tree(root: &Path, manifest: &PreparedImageManifest, expires: Instant) -> Result<()> {
    let directory = absolute_directory(root, Access::SealedDirectory, expires)?;
    for path in manifest
        .execution
        .files
        .iter()
        .map(|row| row.path.as_str())
        .chain(std::iter::once("manifest.json"))
    {
        deadline(expires)?;
        let file = relative_file(
            &directory,
            path,
            if path == "manifest.json" {
                Access::Manifest
            } else {
                Access::SealedFile
            },
            expires,
        )?;
        file.sync_all()
            .map_err(|e| io_error("sync sealed image file", e))?;
        deadline(expires)?;
    }
    let files = manifest
        .execution
        .files
        .iter()
        .map(|row| row.path.clone())
        .chain(std::iter::once("manifest.json".to_owned()))
        .collect();
    let mut directories: Vec<_> = expected_directories(&files).into_iter().collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.split('/').count()));
    for path in directories {
        deadline(expires)?;
        absolute_directory(&root.join(path), Access::SealedDirectory, expires)?
            .sync_all()
            .map_err(|e| io_error("sync sealed image directory", e))?;
    }
    directory
        .sync_all()
        .map_err(|e| io_error("sync sealed image root", e))?;
    deadline(expires)
}
/// Validate the staged sealed bytes against their deterministic FINAL logical
/// paths, then publish using a platform atomic no-replace operation. No manifest
/// rewrite, overwrite, fallback rename, or error-path deletion occurs. After any
/// successful rename, a failed sync/revalidation reports possible publication
/// and returns no validated image. Unsupported filesystem operations refuse.
/// Existing destinations earn reuse only through the same full final validator.
pub fn publish_staged_image(
    stage: &Path,
    context: &AdmissionContext,
    expires: Instant,
) -> Result<PublishedImage> {
    deadline(expires)?;
    let stage_component = stage_name(stage, context)?.to_owned();
    let directory = absolute_directory(stage, Access::SealedDirectory, expires)?;
    let (bytes, _) = read_file(
        relative_file(&directory, "manifest.json", Access::Manifest, expires)?,
        MAX_MANIFEST_BYTES,
        Access::Manifest,
        expires,
    )?;
    let header: PreparedImageManifest = serde_json::from_slice(&bytes)
        .map_err(|_| fail(ErrorKind::Invalid, "malformed staged image manifest"))?;
    let key = image_key(&header)?;
    let final_root = image_parent(context).join(&key);
    let staged = validate_image_at(stage, &final_root, context, expires)?;
    let parent = absolute_directory(&image_parent(context), Access::PrivateParent, expires)?;
    let parent_identity = PrivateParentIdentity::checked(&parent)?;
    if existing_image_root(&parent, &key, expires)? {
        let image = validate_image(&final_root, context, expires)?;
        require_same_prepared_image(staged.manifest(), image.manifest())?;
        check_named_image_custody(
            stage,
            &staged.root_stamp,
            &image_parent(context),
            &parent_identity,
            expires,
        )?;
        return Ok(PublishedImage {
            image,
            published: false,
            retained_stage: Some(stage.to_owned()),
        });
    }
    sync_image_tree(stage, staged.manifest(), expires)?;
    let named_stage = absolute_directory(stage, Access::SealedDirectory, expires)?;
    require(
        Stamp::of(&checked_metadata(&named_stage, Access::SealedDirectory)?) == staged.root_stamp,
        ErrorKind::Changed,
        "staging inode changed before publication",
    )?;
    deadline(expires)?;
    match rename_no_replace(parent.as_raw_fd(), &stage_component, &key) {
        Ok(()) => {
            let finish = || -> Result<ValidatedImage> {
                parent
                    .sync_all()
                    .map_err(|e| io_error("sync published image parent", e))?;
                deadline(expires)?;
                let current_parent =
                    absolute_directory(&image_parent(context), Access::PrivateParent, expires)?;
                require(
                    PrivateParentIdentity::checked(&current_parent)? == parent_identity,
                    ErrorKind::Changed,
                    "image parent changed during publication",
                )?;
                let image = validate_image(&final_root, context, expires)?;
                require(
                    image.root_stamp.dev == staged.root_stamp.dev
                        && image.root_stamp.ino == staged.root_stamp.ino,
                    ErrorKind::Changed,
                    "published image inode differs from stage",
                )?;
                Ok(image)
            };
            let image = finish().map_err(|mut e| {
                e.publication_may_have_happened = true;
                e
            })?;
            Ok(PublishedImage {
                image,
                published: true,
                retained_stage: None,
            })
        }
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
            let image = validate_image(&final_root, context, expires)?;
            require_same_prepared_image(staged.manifest(), image.manifest())?;
            Ok(PublishedImage {
                image,
                published: false,
                retained_stage: Some(stage.to_owned()),
            })
        }
        Err(error) => {
            let mut error = io_error("atomic no-replace image publication", error);
            error.publication_may_have_happened = true;
            Err(error)
        }
    }
}

#[cfg(test)]
#[path = "service_image/tests.rs"]
mod tests;
