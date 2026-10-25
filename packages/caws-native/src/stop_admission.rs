//! Finite native stock-selection prerequisite for ordinary OpenCode Stop.
//!
//! This is deliberately not EligibleStop or QualifiedStop. It proves a closed
//! selected source/policy/registration domain from native-owned observations;
//! semantic SQL/renderer/calendar qualification and prefix completion are separate
//! obligations of the enclosing native owner. No engine selection JSON, profile
//! selector, test artifact, or caller assertion constructs this receipt.
use crate::{
    cli::Config,
    selection_observation::{GenerationValidationScope, SelectionObservationReceipt},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use caws_native::{monotonic_deadline::MonotonicDeadline, session_cache_wire::OriginalStopCapture};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
};

const CHAIN: [&str; 4] = [
    "goal-ac-gate.sh",
    "plan-transcript-finalize.sh",
    "session-log.sh",
    "agent-stop.sh",
];
const LOGGER_INDEX: usize = 2;
const PRODUCER: &str = "surfaces/opencode/native-plugin.ts";

// Reviewed local source identities from component-comparison controlled-05's
// reference.sharedFiles and baseline2188b06e runtime templates, with the
// reviewed R06 guard-config and R19 reprieve shell/CJS cohorts. These pins prove stock source
// identity only, never the remaining semantic/profile joins.

const STOCK: &[(&str, &str)] = &[
    (
        "agent-stop.sh",
        "c94358159f8fd77585bcb8c3679cd81c8d3d5dba0ff0970c50bf91a0f5f5eaa5",
    ),
    (
        "dispatch.sh",
        "5f8a185f8b63e601aa29af3431d0ddafedb9a44f45d6a2d9279d32410fc2150f",
    ),
    (
        "dispatch/stop.sh",
        "2cf037d5a6c0e3dae637b2af75967a145c8c086caf8c490bcec5b1a1563f2d58",
    ),
    (
        "goal-ac-gate.sh",
        "ef16f932c95c0d8e32a070ddd5b3309705d720f0d1e6ff96c51781671f100402",
    ),
    (
        "handler-env.sh",
        "901ecd961b65f5383a48ec0e4db7ef2117975963f117ff48d5ed1fab75773cc7",
    ),
    (
        "lib/agent-pid.sh",
        "f075356c6fe4179ac14ff3e1131ba355690f55a2ced04dd2f42df6aa0f8ff800",
    ),
    (
        "lib/agent-surface.sh",
        "9fb104eab8cc5955157dd2da7dc25c19a4bfcd008aa148cfacfba842c9310c32",
    ),
    (
        "lib/ask-capability.sh",
        "7aa8a0be53438fb45f82c3feae7d7043abb9b2734f77048a41794ac3d52ead30",
    ),
    (
        "lib/bash-mutation-targets.sh",
        "3b40bcc29a9793c85c7db4f01c0e4650429be46db504df774e3ff95d6ab8f6ac",
    ),
    (
        "lib/caws-state.sh",
        "2d27e94fbc3303ca96d7729720d8d7570ec772bc0f9a02d5b1bf46b98f4931e1",
    ),
    (
        "lib/emit.sh",
        "32bd200bf9160dffc5d349a7e13341bbcf6644ab9c47ad3f491f68d3ba77bcf4",
    ),
    (
        "lib/guard-config.cjs",
        "b7947a24da1670613bb43a548be9951d7fe3be6d4be2f9418607a35dac945a85",
    ),
    (
        "lib/guard-config.sh",
        "c3d9d5b0f6ffb4eb6add5a3f27b2d3d2bf7f46d86b39614c351e8b5bba06c73c",
    ),
    (
        "lib/guard-message.sh",
        "7b8a131c93cefb31c4205564f4429586325a292924ea809c396b4b154004e148",
    ),
    (
        "lib/harness_claude.py",
        "c6d94da874c7af48c9dcb90e5f6fa53671bf04154f8a1b8e3c945e71c853026d",
    ),
    (
        "lib/harness_codex.py",
        "fca73c2b632122bc471322b38452db3ea41cf3eab693d02be757fd9217b31ee0",
    ),
    (
        "lib/harness_common.py",
        "819debd387cfcbc1c996078b15831d250e3bb0543e0c9d407cb1e0522cf680c2",
    ),
    (
        "lib/harness_dsh.py",
        "328305c956708a3413e5e8e9a4101681da53d30b972b41b3be3ec14b5125f1ab",
    ),
    (
        "lib/harness_kimi.py",
        "da3af2f3400f8cd5e4aeb4c3fa7e239b50b7de76026e1a62465d5e9bd4306684",
    ),
    (
        "lib/harness_opencode.py",
        "4a1499d1e16991998565c0376f3944e915b8ec5f016f3cae11a7ac11ffdcb612",
    ),
    (
        "lib/harness_qwen.py",
        "6d204c98df6a3dcfc5625f98f11a0645513987cc535e19b6368af4334e53b605",
    ),
    (
        "lib/harness_zcode.py",
        "3c8cd2b60bc9011f81f56176ace3ea524c334b938e3ba561fac84e6466e021b4",
    ),
    (
        "lib/heredoc.sh",
        "75643e42630f6077959da625f50f6cdf888ed82e4d0d983a560378d928cc5e0d",
    ),
    (
        "lib/hook-utilities.py",
        "dd9362ce74a7a2f524c9eebff3cc62d63f14805a436e665d97ca88e47fb2c362",
    ),
    (
        "lib/local-chain.sh",
        "311ae6596cab43a9f222287c37cfa104ae4257597526cfe2a0aea8d17b529075",
    ),
    (
        "lib/parse-input.sh",
        "b61ca58672ec23722042fa55b4ba65b8c95ebc67a28dbcdc4f335770fe32d5de",
    ),
    (
        "lib/reprieve-reader.cjs",
        "d95a202b321d446b5726d5d2f8721e3b5dc2c273c71398f844a8303b8f83b6d2",
    ),
    (
        "lib/reprieve.sh",
        "5eaa9953d1edc0e98ec73a365560371cf1daea25d4ec4f812e1d38403cf04a9d",
    ),
    (
        "lib/run-handlers.sh",
        "90945b5dd70c9c6e223beefab24208603c2c1a822e4ba85d8bd298d430660093",
    ),
    (
        "lib/session-cache.sh",
        "eea9bb74ec74d07931eb13ac45e6822a348ce7fb49e4a7baa9d590e321e093cb",
    ),
    (
        "lib/session-id.sh",
        "cf662f10e6d3477cecbf5deabd8d2b63284f6f4ac14fa7070725ff8502515c53",
    ),
    (
        "lib/session-log.schema.json",
        "8726b0c3f77adc277951e4f9e8a55b4d6523e469f03270006c5e4aec170ff7b3",
    ),
    (
        "lib/session-render-writer.sh",
        "9d6ff82dc71ca28d182ccfa727c5e6b8812019e92d9f076295fc58c7feb7e803",
    ),
    (
        "lib/surfaces-registry.sh",
        "561eadbfc1a80b94526ea5c294867a89a5ef255143ea76ae061285f80692153e",
    ),
    (
        "lib/transcript-store.py",
        "197e82ddcd1f91edfca2cb9481c82c3f535c54dcc7e793ad54b78e2bc2652039",
    ),
    (
        "lib/worktree-claim-oracle.cjs",
        "fb06d6b1248c3ec765f76e5694db5fe7554a7db076b9c066c80227e883584c48",
    ),
    (
        "lib/write-allowlist.sh",
        "f0eba9d9a03d65b68d7f0808f820593bc4711dd96dd31285d329ad52f65fcdd1",
    ),
    (
        "plan-transcript-finalize.sh",
        "8ed0b7173c5add2991a67789a2219a03b809046a39596c5d8a60d052f3d02ce2",
    ),
    (
        "runtime-paths.sh",
        "c2cc098b08c110723c2d1805170ba2d73a855f0864e5792bb7a88a2c3def7f08",
    ),
    (
        "session-log.sh",
        "8f6358e4ec37e9dcd35c98d77d2a77776e6d73c761895f37069b21e61f2f66a9",
    ),
    (
        "session_log_renderer.py",
        "e45f7ec6d8da093da975df7492db10ec59edff69dd78db7ccdbc3b48bf85cdcf",
    ),
];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// Unsupported/custom/incomplete readset. Compatibility is an enclosing
    /// owner's choice only before any prefix effects, never after completion.
    Unsupported(String),
    /// Original clock/cancellation or retained identity changed. Do not turn
    /// this into permission to replay SQL or a completed native prefix.
    Invalidated(String),
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(s) | Self::Invalidated(s) => f.write_str(s),
        }
    }
}
impl From<String> for Refusal {
    fn from(reason: String) -> Self {
        Self::Invalidated(reason)
    }
}
fn unsupported(message: impl Into<String>) -> Refusal {
    Refusal::Unsupported(message.into())
}

/// Necessary source-selection evidence; no Clone, Deserialize, publication
/// method, or semantic-profile constructor. Original capture and sealed readset
/// remain externally owned. An unsupported attempt cannot consume the readset
/// needed by compatibility's strict predispatch revalidation; successful
/// selection borrows the same owners without a self-reference.
pub(crate) struct StockStopSelection<'original, 'native> {
    original: &'original OriginalStopCapture<'native>,
    readset: &'original SelectionObservationReceipt<'native>,
    home: PathBuf,
}
impl<'original, 'native> StockStopSelection<'original, 'native> {
    pub(crate) fn admit(
        original: &'original OriginalStopCapture<'native>,
        config: &Config,
        readset: &'original SelectionObservationReceipt<'native>,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, Refusal> {
        readset.validate_with(&mut cancel, |scope, cancel| {
            Self::admit_in_scope(original, config, readset, scope, cancel)
        })
    }
    pub(crate) fn admit_in_scope(
        original: &'original OriginalStopCapture<'native>,
        config: &Config,
        readset: &'original SelectionObservationReceipt<'native>,
        scope: &GenerationValidationScope<'_, 'native>,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Self, Refusal> {
        checkpoint(original.deadline(), cancel)?;
        if config.surface != "opencode"
            || config.event != "stop"
            || config.configuration != "system"
            || original.surface() != "opencode"
            || config.digest != original.runtime_digest()
            || readset.runtime_digest() != original.runtime_digest()
            || !std::ptr::eq(readset.deadline(), original.deadline())
        {
            return Err(unsupported(
                "Stock Stop original/configuration/readset binding mismatch",
            ));
        }
        let home = machine_home(original.caller_environment())?;
        let root = home.join("lib/runtimes").join(original.runtime_digest());
        if readset.generation_root() != root {
            return Err(unsupported(
                "Stock Stop generation differs from original machine home",
            ));
        }
        readset.validate_in_scope(scope, cancel, |cancel| {
            let view = Readset::new(readset)?;
            let project = original.observed_project();
            let context = Context {
                home: &home,
                root: &root,
                checkout: &project.checkout,
                canonical: &project.canonical_root,
                caller: Path::new(original.caller_cwd()),
                environment: original.caller_environment(),
            };
            validate_selection(&view, &context)?;
            for &(relative, expected) in STOCK {
                checkpoint(original.deadline(), cancel)?;
                let current = readset
                    .runtime_member(relative, &mut *cancel)
                    .map_err(Refusal::Invalidated)?;
                if current.sha256 != expected {
                    return Err(unsupported(format!("Unreviewed stock source: {relative}")));
                }
            }
            validate_producer_identity(&view, &context, readset, cancel)?;
            checkpoint(original.deadline(), cancel)?;
            Ok(Self {
                original,
                readset,
                home,
            })
        })
    }
    pub(crate) fn original(&self) -> &'original OriginalStopCapture<'native> {
        self.original
    }
    pub(crate) fn readset(&self) -> &'original SelectionObservationReceipt<'native> {
        self.readset
    }
    pub(crate) fn home(&self) -> &Path {
        &self.home
    }
    /// Replace exactly this position. The other selected handlers and their
    /// order/protective results remain owned by the ordinary composer.
    pub(crate) fn logger_index(&self) -> usize {
        LOGGER_INDEX
    }
    pub(crate) fn handler_entries(&self) -> &'static [&'static str] {
        &CHAIN
    }
    pub(crate) fn revalidate(
        &self,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), Refusal> {
        checkpoint(self.original.deadline(), &mut cancel)?;
        self.readset
            .revalidate(&mut cancel)
            .map_err(Refusal::Invalidated)?;
        checkpoint(self.original.deadline(), &mut cancel)
    }
}
fn checkpoint(
    deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), Refusal> {
    deadline
        .check()
        .map_err(|e| Refusal::Invalidated(e.to_string()))?;
    cancel().map_err(Refusal::Invalidated)?;
    deadline
        .check()
        .map_err(|e| Refusal::Invalidated(e.to_string()))
}
struct Context<'a> {
    home: &'a Path,
    root: &'a Path,
    checkout: &'a Path,
    canonical: &'a Path,
    caller: &'a Path,
    environment: &'a BTreeMap<String, String>,
}
struct Readset<'a> {
    rows: BTreeMap<(String, String, bool), &'a Value>,
}
impl<'a> Readset<'a> {
    fn new(receipt: &'a SelectionObservationReceipt<'_>) -> Result<Self, Refusal> {
        let mut rows = BTreeMap::new();
        for observation in receipt.observations() {
            let operation = &observation["operation"];
            let kind = operation["kind"]
                .as_str()
                .ok_or_else(|| unsupported("Missing native operation kind"))?;
            let path = operation["path"]
                .as_str()
                .ok_or_else(|| unsupported("Missing native operation path"))?;
            let key = (
                kind.into(),
                path.into(),
                operation["singleLink"].as_bool().unwrap_or(false),
            );
            if rows.insert(key, &observation["result"]).is_some() {
                return Err(unsupported("Duplicate native selection dependency"));
            }
        }
        Ok(Self { rows })
    }
    fn result(&self, kind: &str, path: &Path, single_link: bool) -> Result<&Value, Refusal> {
        let path = path
            .to_str()
            .ok_or_else(|| unsupported("Non-UTF8 stock path"))?;
        self.rows
            .get(&(kind.into(), path.into(), single_link))
            .copied()
            .ok_or_else(|| {
                unsupported(format!(
                    "Missing native selection observation: {kind} {path}"
                ))
            })
    }
    fn confined(&self, root: &Path, path: &Path) -> Result<(), Refusal> {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| unsupported("Selection path escapes its native root"))?;
        let mut cursor = root.to_path_buf();
        self.no_symlink(&cursor)?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(unsupported("Non-normal stock selection path"));
            };
            cursor.push(name);
            self.no_symlink(&cursor)?;
        }
        Ok(())
    }
    fn no_symlink(&self, path: &Path) -> Result<(), Refusal> {
        let result = self.result("path-identity", path, false)?;
        if result["kind"] == "path-identity" && result["value"]["kind"] != "symlink" {
            return Ok(());
        }
        if result["kind"] == "error" && result["code"] == "ENOENT" {
            return Ok(());
        }
        Err(unsupported(format!(
            "Redirected or unavailable stock selection path: {}",
            path.display()
        )))
    }
    fn exists(&self, path: &Path) -> Result<bool, Refusal> {
        let result = self.result("exists", path, false)?;
        if result["kind"] != "exists" {
            return Err(unsupported(format!(
                "Existence observation failed: {}",
                path.display()
            )));
        }
        result["value"]
            .as_bool()
            .ok_or_else(|| unsupported("Malformed native existence result"))
    }
    fn absent(&self, path: &Path) -> Result<(), Refusal> {
        let absent = if let Ok(result) = self.result("exists", path, false) {
            result["kind"] == "exists" && result["value"] == false
        } else {
            let result = self.result("stat", path, false)?;
            result["kind"] == "error" && result["code"] == "ENOENT"
        };
        if absent {
            Ok(())
        } else {
            Err(unsupported(format!(
                "Higher-priority or unsupported selection source is present: {}",
                path.display()
            )))
        }
    }
    fn info_kind(&self, path: &Path, kind: &str) -> Result<(), Refusal> {
        let result = self.result("stat", path, false)?;
        if result["kind"] == "info" && result["value"]["kind"] == kind {
            Ok(())
        } else {
            Err(unsupported(format!(
                "Wrong stock path kind: {}",
                path.display()
            )))
        }
    }
    fn bytes(&self, path: &Path, runtime: bool, single_link: bool) -> Result<Vec<u8>, Refusal> {
        let result = self.result(
            if runtime { "runtime-file" } else { "read" },
            path,
            single_link,
        )?;
        if result["kind"] != if runtime { "runtime-file" } else { "bytes" } {
            return Err(unsupported("Native file bytes unavailable"));
        }
        let encoded = result["base64"]
            .as_str()
            .ok_or_else(|| unsupported("Native file bytes missing"))?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| unsupported("Native file bytes invalid"))?;
        if STANDARD.encode(&bytes) != encoded {
            return Err(unsupported("Native file bytes noncanonical"));
        }
        Ok(bytes)
    }
    fn json(&self, path: &Path) -> Result<Value, Refusal> {
        serde_json::from_slice(&self.bytes(path, false, false)?)
            .map_err(|_| unsupported(format!("Unsupported stock JSON: {}", path.display())))
    }
    fn listing(&self, path: &Path) -> Result<BTreeSet<String>, Refusal> {
        let result = self.result("list", path, false)?;
        if result["kind"] != "listing" {
            return Err(unsupported("Native selection listing unavailable"));
        }
        result["entries"]
            .as_array()
            .ok_or_else(|| unsupported("Native selection listing missing"))?
            .iter()
            .map(|entry| {
                entry
                    .as_str()
                    .map(String::from)
                    .ok_or_else(|| unsupported("Native selection listing entry invalid"))
            })
            .collect()
    }
}
fn machine_home(environment: &BTreeMap<String, String>) -> Result<PathBuf, Refusal> {
    let home = match environment.get("CAWS_HOME").filter(|s| !s.is_empty()) {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(
            environment
                .get("HOME")
                .filter(|s| !s.is_empty())
                .ok_or_else(|| unsupported("Original HOME missing"))?,
        )
        .join(".caws"),
    };
    normal_absolute(&home)?;
    Ok(home)
}
fn normal_absolute(path: &Path) -> Result<(), Refusal> {
    if !path.is_absolute()
        || path.to_str().is_none()
        || path.as_os_str().as_encoded_bytes().contains(&0)
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        Err(unsupported(
            "Absolute normal native selection root required",
        ))
    } else {
        Ok(())
    }
}
fn object_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}
fn empty_surface(value: &Value) -> bool {
    object_keys(value, &["disabled", "extensions", "handlers", "libraries"])
        && value
            .as_object()
            .unwrap()
            .values()
            .all(|value| value.as_object().is_some_and(|object| object.is_empty()))
}
fn validate_selection(view: &Readset<'_>, context: &Context<'_>) -> Result<(), Refusal> {
    // The reviewed shell defaults to its pinned CJS sibling. An explicit
    // Python parser selects executable bytes outside this stock source cohort.
    if context
        .environment
        .get("CAWS_GUARD_CONFIG_PY")
        .is_some_and(|v| !v.is_empty())
    {
        return Err(unsupported(
            "Custom guard configuration parser requires compatibility",
        ));
    }
    for root in [
        context.home,
        context.root,
        context.checkout,
        context.canonical,
        context.caller,
    ] {
        normal_absolute(root)?;
    }
    if !context.caller.starts_with(context.checkout) {
        return Err(unsupported("Original OpenCode caller is outside checkout"));
    }
    for root in [context.home, context.checkout, context.canonical] {
        view.confined(root, root)?;
    }
    let governance = context.canonical.join(".caws");
    view.confined(context.canonical, &governance)?;
    if !view.exists(&governance)? {
        return Err(unsupported("Original project governance absent"));
    }
    for (relative, kind) in [(".caws/policy.yaml", "file"), (".caws/specs", "directory")] {
        let path = context.canonical.join(relative);
        view.confined(context.canonical, &path)?;
        view.info_kind(&path, kind)?;
    }
    let working = context.canonical.join(".caws/working-spec.yaml");
    view.confined(context.canonical, &working)?;
    view.absent(&working)?;
    let settings = context.home.join("surfaces/opencode/settings.json");
    view.confined(context.home, &settings)?;
    if !view.exists(&settings)?
        || view.json(&settings)?
            != json!({"version":1,"enabled":true,"transport":"project-native-stop"})
    {
        return Err(unsupported(
            "OpenCode native Stop is not explicitly configured",
        ));
    }
    let project = context.home.join("state/projects").join(format!(
        "{}.json",
        hash(context.canonical.to_str().unwrap().as_bytes())
    ));
    view.confined(context.home, &project)?;
    if !view.exists(&project)? {
        return Err(unsupported("OpenCode project policy migration is absent"));
    }
    let policy = view.json(&project)?;
    if !object_keys(&policy, &["version", "root", "surfaces"])
        || policy["version"] != 1
        || policy["root"] != context.canonical.to_str().unwrap()
        || !policy["surfaces"].is_object()
        || !empty_surface(&policy["surfaces"]["opencode"])
    {
        return Err(unsupported(
            "OpenCode project policy is outside the finite stock selection",
        ));
    }
    let repo = context.canonical.join(".caws/hooks/hook-policy.json");
    view.confined(context.canonical, &repo)?;
    let repo_stat = view.result("stat", &repo, false)?;
    if !(repo_stat["kind"] == "error" && repo_stat["code"] == "ENOENT") {
        view.info_kind(&repo, "file")?;
        let policy = view.json(&repo)?;
        if policy != json!({"version":1})
            && policy != json!({"version":1,"surfaces":{},"guards":{}})
            && policy != json!({"version":1,"surfaces":{}})
        {
            return Err(unsupported(
                "Repository policy is outside the finite stock selection",
            ));
        }
    }
    let defaults = context.root.join("system-policy.json");
    view.confined(context.root, &defaults)?;
    let defaults = view.json(&defaults)?;
    if !object_keys(&defaults, &["version", "events"])
        || defaults["version"] != 1
        || defaults["events"]["stop"] != json!(CHAIN)
    {
        return Err(unsupported(
            "Stock Stop handler order differs from reviewed selection",
        ));
    }
    for name in CHAIN {
        let path = context.root.join(name);
        view.confined(context.root, &path)?;
        view.info_kind(&path, "file")?;
        if view.result("executable", &path, false)?["kind"] != "executable" {
            return Err(unsupported("Stock handler is not executable"));
        }
        let expected = STOCK
            .iter()
            .find(|(relative, _)| *relative == name)
            .unwrap()
            .1;
        if hash(&view.bytes(&path, false, false)?) != expected {
            return Err(unsupported(format!(
                "Selected stock handler differs: {name}"
            )));
        }
    }
    validate_libraries(view, context)?;
    validate_local_registration(view, context)?;
    Ok(())
}
fn validate_libraries(view: &Readset<'_>, context: &Context<'_>) -> Result<(), Refusal> {
    let shared = context.root.join("lib");
    let names: BTreeSet<String> = STOCK
        .iter()
        .filter_map(|(relative, _)| relative.strip_prefix("lib/").map(String::from))
        .collect();
    view.confined(context.root, &shared)?;
    if !view.exists(&shared)? || view.listing(&shared)? != names {
        return Err(unsupported("Stock shared-library inventory differs"));
    }
    validate_adapter_absence(view, context, &names)?;
    for name in &names {
        let path = shared.join(name);
        view.confined(context.root, &path)?;
        view.info_kind(&path, "file")?;
        let expected = STOCK
            .iter()
            .find(|(relative, _)| *relative == format!("lib/{name}"))
            .unwrap()
            .1;
        if hash(&view.bytes(&path, false, false)?) != expected {
            return Err(unsupported(format!(
                "Selected stock library differs: {name}"
            )));
        }
    }
    Ok(())
}
fn validate_adapter_absence(
    view: &Readset<'_>,
    context: &Context<'_>,
    names: &BTreeSet<String>,
) -> Result<(), Refusal> {
    let surface = context.root.join("surfaces/opencode/lib");
    let user = context.home.join("surfaces/opencode/lib");
    // No user/surface adapters are selected in this finite OpenCode stock pack.
    for (root, directory) in [(context.home, &user), (context.root, &surface)] {
        view.confined(root, directory)?;
        if view.exists(directory)? && !view.listing(directory)?.is_empty() {
            return Err(unsupported(
                "Custom adapter inventory requires compatibility",
            ));
        }
        for name in names {
            let path = directory.join(name);
            view.confined(root, &path)?;
            view.absent(&path)?;
        }
        let transcript = directory.join("session-transcript.py");
        view.confined(root, &transcript)?;
        view.absent(&transcript)?;
    }
    Ok(())
}
fn registration_roots(
    context: &Context<'_>,
) -> Result<(BTreeSet<PathBuf>, BTreeSet<PathBuf>), Refusal> {
    let environment = context.environment;
    for name in [
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_AUTH_CONTENT",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_TEST_HOME",
        "OPENCODE_PURE",
        "OPENCODE_TEST_MANAGED_CONFIG_DIR",
        "OPENCODE_PLUGIN_META_FILE",
        "OPENCODE_WORKSPACE_ID",
        "OPENCODE_EXPERIMENTAL_WORKSPACES",
    ] {
        if environment.get(name).is_some_and(|value| !value.is_empty()) {
            return Err(unsupported(format!(
                "Unsupported original OpenCode discovery environment: {name}"
            )));
        }
    }
    let user = PathBuf::from(
        environment
            .get("HOME")
            .ok_or_else(|| unsupported("Original OpenCode HOME missing"))?,
    );
    normal_absolute(&user)?;
    let config = environment
        .get("XDG_CONFIG_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user.join(".config"));
    normal_absolute(&config)?;
    let global = config.join("opencode");
    let mut projects = BTreeSet::new();
    let mut cursor = context.caller;
    loop {
        projects.insert(cursor.to_path_buf());
        if cursor == context.checkout {
            break;
        }
        cursor = cursor
            .parent()
            .ok_or_else(|| unsupported("Original discovery escaped checkout"))?;
    }
    let mut directories = BTreeSet::from([global.clone(), user.join(".opencode")]);
    directories.extend(projects.iter().map(|root| root.join(".opencode")));
    if let Some(extra) = environment
        .get("OPENCODE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
    {
        let extra = PathBuf::from(extra);
        normal_absolute(&extra)?;
        directories.insert(extra);
    }
    let mut configs = BTreeSet::new();
    for name in ["config.json", "opencode.json", "opencode.jsonc"] {
        configs.insert(global.join(name));
    }
    for directory in projects.iter().chain(directories.iter()) {
        for name in ["opencode.json", "opencode.jsonc"] {
            configs.insert(directory.join(name));
        }
    }
    Ok((directories, configs))
}
fn validate_local_registration(view: &Readset<'_>, context: &Context<'_>) -> Result<(), Refusal> {
    let (directories, configs) = registration_roots(context)?;
    for directory in &directories {
        let legacy = directory.join("config");
        view.confined(Path::new("/"), &legacy)?;
        view.absent(&legacy)?;
    }
    for file in configs {
        view.confined(Path::new("/"), &file)?;
        if !view.exists(&file)? {
            continue;
        }
        view.info_kind(&file, "file")?;
        validate_config_bytes(&view.bytes(&file, false, false)?)?;
    }
    let mut producers = BTreeSet::new();
    for directory in directories {
        for name in ["plugin", "plugins"] {
            let folder = directory.join(name);
            view.confined(Path::new("/"), &folder)?;
            if !view.exists(&folder)? {
                continue;
            }
            view.info_kind(&folder, "directory")?;
            for entry in view.listing(&folder)? {
                if entry.ends_with(".ts") || entry.ends_with(".js") {
                    let file = folder.join(entry);
                    view.confined(Path::new("/"), &file)?;
                    view.info_kind(&file, "file")?;
                    producers.insert(file);
                }
            }
        }
    }
    if producers != BTreeSet::from([context.checkout.join(".opencode/plugins/caws.ts")]) {
        return Err(unsupported(
            "OpenCode requires one understood project producer",
        ));
    }
    Ok(())
}
fn validate_config_bytes(bytes: &[u8]) -> Result<(), Refusal> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| unsupported("OpenCode config is not UTF-8"))?;
    if text.contains("{env:") || text.contains("{file:") {
        return Err(unsupported(
            "OpenCode config substitutions require compatibility",
        ));
    }
    let value: Value = serde_json::from_str(text)
        .map_err(|_| unsupported("OpenCode config requires literal JSON"))?;
    let object = value
        .as_object()
        .ok_or_else(|| unsupported("OpenCode config must be an object"))?;
    if object.contains_key("plugins")
        || object
            .get("plugin")
            .is_some_and(|plugins| plugins.as_array().is_none_or(|plugins| !plugins.is_empty()))
    {
        return Err(unsupported(
            "OpenCode config plugin imports require compatibility",
        ));
    }
    Ok(())
}
fn validate_producer_identity(
    view: &Readset<'_>,
    context: &Context<'_>,
    readset: &SelectionObservationReceipt<'_>,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), Refusal> {
    let selected = context.root.join(PRODUCER);
    view.confined(Path::new("/"), &selected)?;
    let selected_bytes = view.bytes(&selected, true, false)?;
    let expected = readset
        .runtime_member(PRODUCER, &mut *cancel)
        .map_err(Refusal::Invalidated)?;
    if hash(&selected_bytes) != expected.sha256 {
        return Err(unsupported(
            "Selected OpenCode producer differs from admitted member",
        ));
    }
    let binding = format!(
        "const NATIVE_STOP_HOME: string | null = {};",
        serde_json::to_string(context.home.to_str().unwrap()).unwrap()
    );
    let text = std::str::from_utf8(&selected_bytes)
        .map_err(|_| unsupported("OpenCode producer is not UTF-8"))?;
    if text.matches(&binding).count() != 1 {
        return Err(unsupported(
            "OpenCode producer machine-home binding differs",
        ));
    }
    let project = context.checkout.join(".opencode/plugins/caws.ts");
    if view.bytes(&project, true, false)? != selected_bytes {
        return Err(unsupported(
            "Project producer differs from admitted OpenCode member",
        ));
    }
    let stable = context.home.join("bin/caws-hook-native");
    view.confined(Path::new("/"), &stable)?;
    let stable_bytes = view.bytes(&stable, true, true)?;
    let result = view.result("runtime-file", &stable, true)?;
    let mode = result["stat"]["mode"]
        .as_u64()
        .ok_or_else(|| unsupported("Stable entry mode missing"))?;
    let expected = readset
        .runtime_member("native/caws-hook-native", &mut *cancel)
        .map_err(Refusal::Invalidated)?;
    if mode & 0o7777 != 0o755 || hash(&stable_bytes) != expected.sha256 {
        return Err(unsupported("Stable entry differs from admitted generation"));
    }
    Ok(())
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Integration-only bridge to the private assertions below. Cargo's real
/// binary is supplied by the integration target, which can use
/// CARGO_BIN_EXE_caws-native without changing ordinary binary-unit-test setup.
/// This constructs no authority and is absent from production builds.
#[cfg(all(test, target_os = "macos"))]
#[allow(dead_code)]
pub(crate) fn assert_admit_invalidation_with_real_custodian(
    executor: &caws_native::invocation_project::SelectedExecutable,
) {
    tests::admit_invalidation_with_real_custodian(executor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        native_generation::GenerationReceipt,
        selection_observation::{
            Limits, Operation, OperationKind, SelectionObservationOwner,
            SelectionObservationRequest,
        },
    };
    use std::{cell::Cell, fs, time::Duration};

    // Actual filesystem -> native observation -> sealed readset -> predicate.
    // These synthetic-generation controls deliberately do not mint a successful
    // StockStopSelection. The actual stock-generation positive belongs to the
    // enclosing installed-image integration, not a permissive test profile.
    fn fixture(action: impl FnOnce(&GenerationReceipt, &Path, &Path)) {
        crate::native_generation::with_selection_generation_fixture(action)
    }
    /// The integration wrapper supplies Cargo's actual native executable and
    /// an understood argv0 solely for the ancestry fixture. This helper calls
    /// the production OriginalStopCapture/custodian and StockStopSelection
    /// constructors; no OriginalStopCapture fields or stock grant are forged.
    /// Generation inventory remains explicitly synthetic: its inert native/Node
    /// members are not claimed to execute or establish installed admission.
    #[cfg(target_os = "macos")]
    pub(super) fn admit_invalidation_with_real_custodian(
        executor: &caws_native::invocation_project::SelectedExecutable,
    ) {
        use caws_native::session_cache_wire::OriginalStopCaptureInput;
        use serde_json::value::RawValue;
        use std::process::Command;

        fixture(|generation, home, root| {
            let project = home.join("actual-original-project");
            fs::create_dir_all(project.join(".caws")).unwrap();
            // macOS temporary roots may have a /var -> /private/var alias.
            // Use the actual Git checkout spelling for original caller inputs.
            let project = fs::canonicalize(project).unwrap();
            let mut environment = environment(home);
            for (key, value) in [
                ("PATH", "/usr/bin:/bin"),
                ("LANG", "C"),
                ("LC_ALL", "C"),
                ("CAWS_GIT_BINARY", "/usr/bin/git"),
            ] {
                environment.insert(key.into(), value.into());
            }
            environment.insert("CAWS_PROJECT_DIR".into(), project.to_str().unwrap().into());
            let initialized = Command::new("/usr/bin/git")
                .args(["init", "--quiet"])
                .arg(&project)
                .env_clear()
                .envs(&environment)
                .output()
                .unwrap();
            assert!(
                initialized.status.success(),
                "{}",
                String::from_utf8_lossy(&initialized.stderr)
            );
            let payload =
                RawValue::from_string(json!({"session_id":"s","cwd":project}).to_string()).unwrap();
            let clock = clock();
            let original = OriginalStopCapture::capture(
                OriginalStopCaptureInput {
                    id: "direct-stock-admit",
                    runtime_digest: generation.digest(),
                    surface: "opencode",
                    caller_cwd: project.to_str().unwrap(),
                    caller_environment: &environment,
                    original_payload: &payload,
                },
                executor,
                &clock,
                || Ok(()),
            )
            .unwrap();
            assert_eq!(original.observed_project().checkout, project);
            assert_eq!(original.observed_project().canonical_root, project);
            assert_eq!(original.observed_project().queries.len(), 2);
            for query in &original.observed_project().queries {
                assert!(query.pid.is_some_and(|pid| pid > 0));
                assert!(query.settled());
                assert!(query.exit_observed && !query.ownership_retained);
                assert!(query.pipes.stdout_eof && query.pipes.stderr_eof);
                assert!(!query.pipes.stdout_open && !query.pipes.stderr_open);
                assert!(query.reaped.as_ref().is_some_and(|exit| exit.success));
            }
            let config = Config {
                engine: root.join("engine.js"),
                node: root.join("native/node"),
                surface: "opencode".into(),
                event: "stop".into(),
                configuration: "system".into(),
                digest: generation.digest().into(),
                timeout: Duration::from_secs(30),
            };
            let selected = home.join("observed-before-admit");
            fs::write(&selected, b"original observed bytes").unwrap();
            let mut recorder = Recorder::new(generation, &clock, home);
            recorder.read(OperationKind::Read, &selected);
            let receipt = recorder.owner.seal(|| Ok(())).unwrap();
            assert!(std::ptr::eq(receipt.deadline(), original.deadline()));
            assert_eq!(receipt.runtime_digest(), original.runtime_digest());
            assert_eq!(receipt.generation_root(), root);
            assert_eq!(
                original.caller_environment()["CAWS_HOME"],
                home.to_str().unwrap()
            );

            // The fresh sparse readset passes freshness then refuses missing
            // policy/path observations. That refusal must leave it available.
            let untouched = match StockStopSelection::admit(&original, &config, &receipt, || Ok(()))
            {
                Err(refusal) => refusal,
                Ok(_) => panic!("sparse readset minted stock selection"),
            };
            let missing = format!(
                "Missing native selection observation: path-identity {}",
                home.display()
            );
            assert_eq!(untouched, Refusal::Unsupported(missing.clone()));
            receipt.revalidate(|| Ok(())).unwrap();

            let ready = crate::protocol::Ready {
                active: true,
                budget_home: home.to_path_buf(),
                project_digest: Some(hash(project.to_str().unwrap().as_bytes())),
                session_id: Some("s".into()),
                service_offer: None,
            };
            let scans_before = crate::installed_generation::verification_count();
            let mut pregrant_custody = crate::stop_git::FailureCustody::default();
            let pregrant = crate::stop_execution::PregrantStop::admit(
                &original,
                &config,
                &receipt,
                generation,
                &ready,
                || Ok(()),
                &mut pregrant_custody,
            )
            .unwrap();
            pregrant_custody.check().unwrap();
            assert!(
                matches!(
                    pregrant,
                    crate::stop_execution::PregrantStop::Unsupported(None)
                ),
                "sparse readset cannot mint eligibility"
            );
            let combined_scans = crate::installed_generation::verification_count() - scans_before;
            assert_eq!(combined_scans, 2);

            // A dependency changed after sealing is invalidated, even when
            // the retained selection would otherwise be unsupported.
            fs::write(&selected, b"changed after seal").unwrap();
            let stale = match StockStopSelection::admit(&original, &config, &receipt, || Ok(())) {
                Err(refusal) => refusal,
                Ok(_) => panic!("stale readset minted stock selection"),
            };
            let changed = format!("Selection dependency changed: read {}", selected.display());
            assert_eq!(stale, Refusal::Invalidated(changed.clone()));
            let mut stale_custody = crate::stop_git::FailureCustody::default();
            let combined_stale = crate::stop_execution::PregrantStop::admit(
                &original,
                &config,
                &receipt,
                generation,
                &ready,
                || Ok(()),
                &mut stale_custody,
            )
            .err()
            .expect("stale combined admission must refuse");
            assert_eq!(combined_stale, changed);
            assert_eq!(stale_custody.check().unwrap_err(), changed);

            let calls = Cell::new(0usize);
            let sentinel = "direct stock admission cancellation sentinel";
            let cancelled = match StockStopSelection::admit(&original, &config, &receipt, || {
                calls.set(calls.get() + 1);
                Err(sentinel.into())
            }) {
                Err(refusal) => refusal,
                Ok(_) => panic!("cancelled readset minted stock selection"),
            };
            assert_eq!(cancelled, Refusal::Invalidated(sentinel.into()));
            assert_eq!(
                calls.get(),
                1,
                "original callback was skipped, replaced or repeated"
            );
            let mut cancelled_custody = crate::stop_git::FailureCustody::default();
            let combined_cancelled = crate::stop_execution::PregrantStop::admit(
                &original,
                &config,
                &receipt,
                generation,
                &ready,
                || Err(sentinel.into()),
                &mut cancelled_custody,
            )
            .err()
            .expect("cancelled combined admission must refuse");
            assert_eq!(combined_cancelled, sentinel);
            assert_eq!(cancelled_custody.check().unwrap_err(), sentinel);
            clock.check().unwrap();
            assert!(!project.join(".caws/sessions").exists());
            if std::env::var_os("CAWS_NATIVE_GENERATION_TEST_ARTIFACTS").is_some() {
                fs::write(home.join("direct-stock-admit.json"), serde_json::to_vec_pretty(&json!({
                    "scope":"actual OriginalStopCapture + native custodian + Git; synthetic verified generation, no stock-positive/publication grant",
                    "combinedFullVerifications":combined_scans,"combinedUnsupported":true,
                    "combinedStaleRefusal":combined_stale,"combinedCancellation":combined_cancelled,
                    "generation":generation.digest(),"root":root,"home":home,"project":project,
                    "originalDeadline":clock.envelope(),"custodianExecutable":executor.path,
                    "custodianPhysicalPath":executor.physical_path,"custodianSha256":executor.sha256,
                    "queryPids":original.observed_project().queries.iter().map(|q|q.pid).collect::<Vec<_>>(),
                    "untouched":{"kind":"Unsupported","message":missing},
                    "stale":{"kind":"Invalidated","message":changed},
                    "cancelled":{"kind":"Invalidated","message":sentinel,"callbackCalls":calls.get()},
                    "sessionsExist":false
                })).unwrap()).unwrap();
            }
        });
    }

    struct Recorder<'a> {
        owner: SelectionObservationOwner<'a>,
        seen: BTreeSet<(OperationKind, PathBuf)>,
        sequence: usize,
    }
    impl<'a> Recorder<'a> {
        fn new(
            generation: &'a GenerationReceipt,
            deadline: &'a MonotonicDeadline,
            home: &Path,
        ) -> Self {
            Self {
                owner: SelectionObservationOwner::new(
                    generation,
                    deadline,
                    vec![home.into()],
                    Limits::default(),
                    || Ok(()),
                )
                .unwrap(),
                seen: BTreeSet::new(),
                sequence: 0,
            }
        }
        fn read(&mut self, kind: OperationKind, path: &Path) {
            if !self.seen.insert((kind, path.into())) {
                return;
            }
            self.sequence += 1;
            let request = SelectionObservationRequest {
                snapshot_id: self.owner.snapshot_id().into(),
                sequence: self.sequence,
                operation: Operation {
                    kind,
                    path: path.to_str().unwrap().into(),
                    single_link: None,
                },
            };
            self.owner.capture(request, || Ok(())).unwrap();
        }
        fn confined(&mut self, root: &Path, path: &Path) {
            self.read(OperationKind::PathIdentity, root);
            let mut cursor = root.to_path_buf();
            for component in path.strip_prefix(root).unwrap().components() {
                cursor.push(component);
                self.read(OperationKind::PathIdentity, &cursor);
            }
        }
        fn adapter_dependencies(
            &mut self,
            home: &Path,
            root: &Path,
            names: &BTreeSet<String>,
            omit: Option<&Path>,
        ) {
            for (base, directory) in [
                (home, home.join("surfaces/opencode/lib")),
                (root, root.join("surfaces/opencode/lib")),
            ] {
                self.confined(base, &directory);
                self.read(OperationKind::Exists, &directory);
                if directory.exists() {
                    self.read(OperationKind::List, &directory);
                }
                for name in names
                    .iter()
                    .map(String::as_str)
                    .chain(std::iter::once("session-transcript.py"))
                {
                    let path = directory.join(name);
                    self.confined(base, &path);
                    if omit != Some(path.as_path()) {
                        self.read(OperationKind::Stat, &path);
                    }
                }
            }
        }
    }
    fn clock() -> MonotonicDeadline {
        MonotonicDeadline::capture(Duration::from_secs(30)).unwrap()
    }
    fn context<'a>(
        home: &'a Path,
        root: &'a Path,
        environment: &'a BTreeMap<String, String>,
    ) -> Context<'a> {
        Context {
            home,
            root,
            checkout: home,
            canonical: home,
            caller: home,
            environment,
        }
    }
    fn environment(home: &Path) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("HOME".into(), home.to_str().unwrap().into()),
            ("CAWS_HOME".into(), home.to_str().unwrap().into()),
        ])
    }
    fn effect_after_adapter_check(
        receipt: &SelectionObservationReceipt<'_>,
        context: &Context<'_>,
        names: &BTreeSet<String>,
        effects: &Cell<usize>,
    ) -> Result<(), Refusal> {
        receipt
            .revalidate(|| Ok(()))
            .map_err(Refusal::Invalidated)?;
        validate_adapter_absence(&Readset::new(receipt)?, context, names)?;
        effects.set(effects.get() + 1);
        Ok(())
    }
    // The ordinary shared manifest installs every library in this template
    // directory except the service-image-only client (manifest-shared.ts).
    // Read actual repository bytes rather than generating files from STOCK pins.
    fn repository_libraries(target: &Path) {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../caws-cli/templates/hook-packs/shared/lib");
        fs::create_dir_all(target.join("lib")).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() == "session-render-service-client.sh" {
                continue;
            }
            assert!(entry.file_type().unwrap().is_file());
            fs::copy(entry.path(), target.join("lib").join(entry.file_name())).unwrap();
        }
    }
    fn library_admission(
        generation: &GenerationReceipt,
        home: &Path,
        root: &Path,
    ) -> Result<(), Refusal> {
        let clock = clock();
        let env = environment(home);
        let context = context(home, root, &env);
        let mut recorder = Recorder::new(generation, &clock, home);
        let directory = root.join("lib");
        recorder.confined(root, &directory);
        recorder.read(OperationKind::Exists, &directory);
        recorder.read(OperationKind::List, &directory);
        let names = STOCK
            .iter()
            .filter_map(|(name, _)| name.strip_prefix("lib/").map(String::from))
            .collect();
        recorder.adapter_dependencies(home, root, &names, None);
        for entry in fs::read_dir(&directory).unwrap() {
            let file = entry.unwrap().path();
            recorder.confined(root, &file);
            recorder.read(OperationKind::Stat, &file);
            if fs::symlink_metadata(&file).unwrap().is_file() {
                recorder.read(OperationKind::Read, &file);
            }
        }
        let receipt = recorder.owner.seal(|| Ok(())).unwrap();
        receipt
            .revalidate(|| Ok(()))
            .map_err(Refusal::Invalidated)?;
        validate_libraries(&Readset::new(&receipt)?, &context)
    }
    #[test]
    fn repository_stock_libraries_admit_reviewed_guard_config_and_reprieve_cohort() {
        fixture(|generation, home, _| {
            let root = home.join("repository-stock");
            repository_libraries(&root);
            assert!(!root.join("lib/guard-config.py").exists());
            assert!(root.join("lib/guard-config.cjs").is_file());
            assert!(root.join("lib/reprieve-reader.cjs").is_file());
            library_admission(generation, home, &root).unwrap();
        });
    }
    #[test]
    fn guard_config_and_reprieve_dependencies_and_unknown_inventory_refuse_before_effects() {
        fixture(|generation, home, _| {
            let root = home.join("repository-stock");
            repository_libraries(&root);
            library_admission(generation, home, &root).unwrap();
            for name in [
                "guard-config.cjs",
                "guard-config.sh",
                "reprieve-reader.cjs",
                "reprieve.sh",
            ] {
                let file = root.join("lib").join(name);
                let original = fs::read(&file).unwrap();
                fs::remove_file(&file).unwrap();
                assert!(matches!(library_admission(generation, home, &root),
                    Err(Refusal::Unsupported(message)) if message == "Stock shared-library inventory differs"));
                fs::write(&file, b"unreviewed dependency").unwrap();
                assert!(matches!(library_admission(generation, home, &root),
                    Err(Refusal::Unsupported(message)) if message == format!("Selected stock library differs: {name}")));
                fs::remove_file(&file).unwrap();
                std::os::unix::fs::symlink(root.join("lib/session-id.sh"), &file).unwrap();
                assert!(matches!(library_admission(generation, home, &root),
                    Err(Refusal::Unsupported(message)) if message.contains("Redirected or unavailable")));
                fs::remove_file(&file).unwrap();
                fs::write(&file, original).unwrap();
                library_admission(generation, home, &root).unwrap();
                let override_file = home.join("surfaces/opencode/lib").join(name);
                fs::create_dir_all(override_file.parent().unwrap()).unwrap();
                fs::write(&override_file, b"higher priority custom dependency").unwrap();
                assert!(matches!(library_admission(generation, home, &root),
                    Err(Refusal::Unsupported(message)) if message == "Custom adapter inventory requires compatibility"));
                fs::remove_file(override_file).unwrap();
            }
            fs::write(root.join("lib/unknown.cjs"), b"unreviewed").unwrap();
            assert!(matches!(library_admission(generation, home, &root),
                Err(Refusal::Unsupported(message)) if message == "Stock shared-library inventory differs"));
        });
    }
    #[test]
    fn custom_guard_config_selector_refuses_before_policy_or_effects() {
        fixture(|generation, home, root| {
            let clock = clock();
            let recorder = Recorder::new(generation, &clock, home);
            let receipt = recorder.owner.seal(|| Ok(())).unwrap();
            let mut env = environment(home);
            let custom = home.join("custom.py");
            let witness = b"raise Exception('must not execute')\n";
            fs::write(&custom, witness).unwrap();
            env.insert(
                "CAWS_GUARD_CONFIG_PY".into(),
                custom.to_str().unwrap().into(),
            );
            let result =
                validate_selection(&Readset::new(&receipt).unwrap(), &context(home, root, &env));
            assert!(matches!(result, Err(Refusal::Unsupported(message))
                if message == "Custom guard configuration parser requires compatibility"));
            assert_eq!(fs::read(&custom).unwrap(), witness);
            assert!(!home.join(".caws/sessions").exists());
        });
    }
    #[test]
    fn confinement_requires_explicit_path_identity_without_lstat_fallback() {
        fixture(|generation, home, _| {
            let clock = clock();
            let path = home.join("confinement-directory");
            std::fs::create_dir(&path).unwrap();
            let mut old = Recorder::new(generation, &clock, home);
            old.read(OperationKind::Lstat, &path);
            let old_receipt = old.owner.seal(|| Ok(())).unwrap();
            assert!(
                matches!(Readset::new(&old_receipt).unwrap().no_symlink(&path),
                Err(Refusal::Unsupported(message)) if message.contains("path-identity"))
            );
            let mut narrow = Recorder::new(generation, &clock, home);
            narrow.read(OperationKind::PathIdentity, &path);
            let receipt = narrow.owner.seal(|| Ok(())).unwrap();
            Readset::new(&receipt).unwrap().no_symlink(&path).unwrap();
            let link = home.join("confinement-link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            let mut redirected = Recorder::new(generation, &clock, home);
            redirected.read(OperationKind::PathIdentity, &link);
            let receipt = redirected.owner.seal(|| Ok(())).unwrap();
            assert!(matches!(Readset::new(&receipt).unwrap().no_symlink(&link),
                Err(Refusal::Unsupported(message)) if message.contains("Redirected")));
        });
    }
    #[test]
    fn omitted_absent_higher_priority_observation_cannot_be_inferred_from_other_rows() {
        fixture(|generation, home, root| {
            let clock = clock();
            let env = environment(home);
            let context = context(home, root, &env);
            let names = BTreeSet::from(["harness_opencode.py".into()]);
            let omitted = home.join("surfaces/opencode/lib/harness_opencode.py");
            let mut recorder = Recorder::new(generation, &clock, home);
            recorder.adapter_dependencies(home, root, &names, Some(&omitted));
            let receipt = recorder.owner.seal(|| Ok(())).unwrap();
            let effects = Cell::new(0);
            let failure =
                effect_after_adapter_check(&receipt, &context, &names, &effects).unwrap_err();
            assert!(
                matches!(failure,Refusal::Unsupported(ref message) if message.contains("Missing native selection observation")),
                "{failure}"
            );
            assert_eq!(effects.get(), 0);
        });
    }
    #[test]
    fn appearing_higher_priority_adapter_blocks_effect_with_complete_original_readset() {
        fixture(|generation, home, root| {
            let clock = clock();
            let env = environment(home);
            let context = context(home, root, &env);
            let names = BTreeSet::from(["harness_opencode.py".into()]);
            let mut recorder = Recorder::new(generation, &clock, home);
            recorder.adapter_dependencies(home, root, &names, None);
            let receipt = recorder.owner.seal(|| Ok(())).unwrap();
            let valid_effects = Cell::new(0);
            effect_after_adapter_check(&receipt, &context, &names, &valid_effects).unwrap();
            assert_eq!(valid_effects.get(), 1);
            let target = home.join("surfaces/opencode/lib/harness_opencode.py");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, b"custom adapter").unwrap();
            let effects = Cell::new(0);
            assert!(matches!(
                effect_after_adapter_check(&receipt, &context, &names, &effects),
                Err(Refusal::Invalidated(_))
            ));
            assert_eq!(effects.get(), 0);
        });
    }
    #[test]
    fn unknown_inventory_entry_is_custom_even_when_no_selected_name_is_overridden() {
        fixture(|generation, home, root| {
            let clock = clock();
            let env = environment(home);
            let context = context(home, root, &env);
            let directory = home.join("surfaces/opencode/lib");
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("unknown.py"), b"custom").unwrap();
            let names = BTreeSet::from(["harness_opencode.py".into()]);
            let mut recorder = Recorder::new(generation, &clock, home);
            recorder.adapter_dependencies(home, root, &names, None);
            let receipt = recorder.owner.seal(|| Ok(())).unwrap();
            let effects = Cell::new(0);
            assert!(matches!(
                effect_after_adapter_check(&receipt, &context, &names, &effects),
                Err(Refusal::Unsupported(_))
            ));
            assert_eq!(effects.get(), 0);
        });
    }
    #[test]
    fn literal_config_validation_consumes_actual_observed_bytes() {
        fixture(|generation, home, _| {
            let clock = clock();
            for (name, bytes, valid) in [
                (
                    "empty.json",
                    br#"{"plugin":[],"theme":"x"}"#.as_slice(),
                    true,
                ),
                (
                    "imports.json",
                    br#"{"plugin":["foreign"]}"#.as_slice(),
                    false,
                ),
                (
                    "substitution.json",
                    br#"{"path":"{file:secret}"}"#.as_slice(),
                    false,
                ),
                ("plural.json", br#"{"plugins":[]}"#.as_slice(), false),
            ] {
                let path = home.join(name);
                fs::write(&path, bytes).unwrap();
                let mut recorder = Recorder::new(generation, &clock, home);
                recorder.read(OperationKind::Read, &path);
                let receipt = recorder.owner.seal(|| Ok(())).unwrap();
                let view = Readset::new(&receipt).unwrap();
                let result = validate_config_bytes(&view.bytes(&path, false, false).unwrap());
                assert_eq!(result.is_ok(), valid, "{name}: {result:?}");
            }
        });
    }
    #[test]
    fn discovery_roots_use_original_home_xdg_and_additional_config_directory() {
        fixture(|_, home, root| {
            let mut env = environment(home);
            env.insert(
                "XDG_CONFIG_HOME".into(),
                home.join("xdg").to_str().unwrap().into(),
            );
            env.insert(
                "OPENCODE_CONFIG_DIR".into(),
                home.join("extra").to_str().unwrap().into(),
            );
            let original_context = context(home, root, &env);
            let (directories, configs) = registration_roots(&original_context).unwrap();
            for path in [
                home.join("xdg/opencode"),
                home.join(".opencode"),
                home.join("extra"),
            ] {
                assert!(directories.contains(&path));
            }
            assert!(configs.contains(&home.join("opencode.json")));
            assert!(configs.contains(&home.join("xdg/opencode/config.json")));
            env.insert("OPENCODE_CONFIG_CONTENT".into(), "{}".into());
            assert!(registration_roots(&context(home, root, &env)).is_err());
        });
    }
    #[test]
    fn exact_logger_replacement_preserves_protective_handlers_and_order() {
        assert_eq!(
            CHAIN,
            [
                "goal-ac-gate.sh",
                "plan-transcript-finalize.sh",
                "session-log.sh",
                "agent-stop.sh"
            ]
        );
        assert_eq!(CHAIN[LOGGER_INDEX], "session-log.sh");
        assert_eq!(
            &CHAIN[..LOGGER_INDEX],
            ["goal-ac-gate.sh", "plan-transcript-finalize.sh"]
        );
        assert_eq!(&CHAIN[LOGGER_INDEX + 1..], ["agent-stop.sh"]);
        assert!(!empty_surface(
            &json!({"disabled":{"stop":["goal-ac-gate.sh"]},"extensions":{},"handlers":{},"libraries":{}})
        ));
        assert!(empty_surface(
            &json!({"disabled":{},"extensions":{},"handlers":{},"libraries":{}})
        ));
    }
}
