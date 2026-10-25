//! Recognize the executed prefix's mutation domains, separately from source
//! admission. A self-consistent old/custom runtime remains valid but serial.
use super::*;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewedProfile {
    profile: String,
    sources: BTreeMap<String, String>,
}
fn reviewed_sources() -> &'static BTreeMap<String, String> {
    static SOURCES: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    SOURCES.get_or_init(|| {
        // An intentional source review updates this policy. Recompiling an
        // altered stock runtime does not refresh its own overlap eligibility.
        let profile: ReviewedProfile = serde_json::from_str(include_str!("prefix-profile.json"))
            .expect("compiled reviewed-prefix policy");
        assert_eq!(profile.profile, "codex-stop-session-prefix-v1");
        assert!(
            profile
                .sources
                .iter()
                .all(|(path, value)| relative(path) && digest(value))
        );
        profile.sources
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SerialPrefixReason {
    LegacyHelper,
    UnreviewedPrefix,
}
#[derive(Debug, Clone)]
pub enum PrefixConcurrency {
    Serial(SerialPrefixReason),
    Session(IsolatedPrefix),
}
/// Private construction follows native reconstruction and checked source I/O.
/// No wire field, caller environment value or operator label mints this proof.
#[derive(Debug, Clone)]
pub struct IsolatedPrefix {
    canonical_project: String,
    source_generation: String,
    image_digest: String,
}
impl IsolatedPrefix {
    pub fn canonical_project(&self) -> &str {
        &self.canonical_project
    }
    pub fn source_generation(&self) -> &str {
        &self.source_generation
    }
    pub fn image_digest(&self) -> &str {
        &self.image_digest
    }
    pub fn proof_profile(&self) -> &str {
        "codex-stop-session-prefix-v1"
    }
}

// These selected libraries execute siblings by lexical location. Check both
// the selected shared route and the complete executed sibling closure, even
// when a caller omits a closure file from selection metadata. read_originals
// independently verifies the actual runtime path, file identity and byte pins.
const REVIEWED_SHARED_SIBLINGS: [&str; 4] = [
    "guard-config.cjs",
    "guard-config.sh",
    "reprieve-reader.cjs",
    "reprieve.sh",
];
fn reviewed_shared_siblings(selection: &Selection, originals: &Originals) -> bool {
    REVIEWED_SHARED_SIBLINGS.into_iter().all(|name| {
        let relative = format!("lib/{name}");
        reviewed_sources().get(&relative).is_some_and(|expected| {
            originals
                .bytes
                .get(&("runtime".to_owned(), relative))
                .is_some_and(|observed| &hash(observed) == expected)
                && selection.libraries.iter().any(|library| {
                    library.name == name && library.kind == "shared" && &library.sha256 == expected
                })
        })
    })
}

pub(super) fn derive_prefix_concurrency(
    manifest: &PreparedImageManifest,
    originals: &Originals,
) -> PrefixConcurrency {
    use SerialPrefixReason::*;
    if !manifest
        .toolchain_tcb
        .tools
        .iter()
        .any(|tool| tool.name == PLAN_TOOL)
    {
        return PrefixConcurrency::Serial(LegacyHelper);
    }
    let selection = &manifest.selection;
    let handlers = [
        "goal-ac-gate.sh",
        "plan-transcript-finalize.sh",
        "session-log.sh",
        "agent-stop.sh",
    ];
    let matches_source = |relative: &str| {
        reviewed_sources().get(relative).is_some_and(|expected| {
            originals
                .bytes
                .get(&("runtime".to_owned(), relative.to_owned()))
                .is_some_and(|observed| &hash(observed) == expected)
        })
    };
    // The known parser writes an atomic provenance-only last-hook pointer and
    // a per-session envelope. The preloaded marker prevents the pinned foreign
    // parser/PID reaper from rerunning. Same-session prefixes remain exclusive.
    // The native-owned finalizer replaces the ownerless legacy-list consumer;
    // actual snapshot effects are independently target-locked by its helper.
    let recognized = selection.surface == "codex"
        && selection.event == "stop"
        && selection.configuration == "system"
        && selection.selected_index == 2
        && selection.handlers.len() == handlers.len()
        && selection.handlers.iter().zip(handlers).enumerate().all(
            |(index, (handler, expected))| {
                handler.entry == expected
                    && handler.name == expected
                    && handler.args.is_empty()
                    && if index == 2 {
                        handler.kind == "project-override"
                    } else {
                        handler.kind == "stock" && matches_source(expected)
                    }
            },
        )
        && matches_source("advisory_truncate.cjs")
        && [
            "dispatch.sh",
            "handler-env.sh",
            "runtime-paths.sh",
            "lib/run-handlers.sh",
            "lib/session-cache.sh",
            "lib/agent-surface.sh",
            "lib/session-id.sh",
            "surfaces/codex/lib/parse-input.sh",
            "surfaces/codex/lib/run-handlers.sh",
        ]
        .into_iter()
        .all(matches_source)
        && reviewed_shared_siblings(selection, originals)
        && !selection.libraries.is_empty()
        && selection.libraries.iter().all(|library| {
            let relative = match library.kind.as_str() {
                "shared" => format!("lib/{}", library.name),
                "surface" => format!("surfaces/codex/lib/{}", library.name),
                _ => return false,
            };
            matches_source(&relative)
        });
    if !recognized {
        return PrefixConcurrency::Serial(UnreviewedPrefix);
    }
    PrefixConcurrency::Session(IsolatedPrefix {
        canonical_project: selection.canonical_project.clone(),
        source_generation: manifest.source_generation.clone(),
        image_digest: hash(&json(manifest).expect("validated manifest serializes")),
    })
}

#[cfg(test)]
mod tests;
