use super::*;

// Discriminator controls use synthetic metadata and real repository source bytes.
// They do not substitute for filesystem admission or an actual prefix run.
fn native_prefix_source(relative: &str) -> Option<Vec<u8>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../caws-cli/templates/hook-packs");
    let path = if let Some(name) = relative.strip_prefix("surfaces/codex/lib/") {
        root.join("codex/hooks/lib").join(name)
    } else if matches!(relative, "dispatch.sh" | "handler-env.sh") {
        root.join("runtime").join(relative)
    } else {
        root.join("shared").join(relative)
    };
    std::fs::read(path).ok()
}
fn fixture() -> (PreparedImageManifest, Originals) {
    let (mut manifest, _) = super::super::tests::binding_fixture();
    let selected = manifest.selection.handlers[0].clone();
    let stock = |name: &str| Handler {
        path: format!("/machine/runtime/{name}"),
        sha256: hash(&native_prefix_source(name).unwrap()),
        entry: name.into(),
        name: name.into(),
        args: vec![],
        tier: "stock".into(),
        kind: "stock".into(),
    };
    manifest.selection.handlers = vec![
        stock("goal-ac-gate.sh"),
        stock("plan-transcript-finalize.sh"),
        selected,
        stock("agent-stop.sh"),
    ];
    manifest.selection.selected_index = 2;
    manifest.toolchain_tcb.tools.push(Tool {
        name: PLAN_TOOL.into(),
        path: "/native/caws-native".into(),
        sha256: "f".repeat(64),
    });
    manifest
        .toolchain_tcb
        .tools
        .sort_by(|a, b| a.name.cmp(&b.name));
    let mut originals = Originals {
        bytes: BTreeMap::new(),
        pins: vec![],
        runtime_files: BTreeMap::new(),
    };
    for relative in [
        "dispatch.sh",
        "handler-env.sh",
        "runtime-paths.sh",
        "lib/run-handlers.sh",
        "lib/session-cache.sh",
        "lib/agent-surface.sh",
        "lib/session-id.sh",
        "surfaces/codex/lib/parse-input.sh",
        "surfaces/codex/lib/run-handlers.sh",
        "goal-ac-gate.sh",
        "plan-transcript-finalize.sh",
        "agent-stop.sh",
    ] {
        originals.bytes.insert(
            ("runtime".into(), relative.into()),
            native_prefix_source(relative).unwrap().to_vec(),
        );
    }
    manifest.selection.libraries.push(Library {
        name: "session-cache.sh".into(),
        path: "/machine/runtime/lib/session-cache.sh".into(),
        sha256: hash(&native_prefix_source("lib/session-cache.sh").unwrap()),
        kind: "shared".into(),
    });
    (manifest, originals)
}
#[test]
fn reviewed_executed_prefix_has_owned_bound_identity() {
    let (manifest, originals) = fixture();
    let PrefixConcurrency::Session(proof) = derive_prefix_concurrency(&manifest, &originals) else {
        panic!("reviewed prefix stayed serial")
    };
    assert_eq!(
        proof.canonical_project(),
        manifest.selection.canonical_project
    );
    assert_eq!(proof.source_generation(), manifest.source_generation);
    assert_eq!(proof.image_digest(), hash(&json(&manifest).unwrap()));
    assert_eq!(proof.proof_profile(), "codex-stop-session-prefix-v1");
}
#[test]
fn public_profile_and_valid_legacy_toolset_cannot_activate_overlap() {
    let (mut manifest, originals) = fixture();
    manifest
        .toolchain_tcb
        .tools
        .retain(|pin| pin.name != PLAN_TOOL);
    assert!(valid_tool_names(&manifest.toolchain_tcb.tools));
    assert!(matches!(
        derive_prefix_concurrency(&manifest, &originals),
        PrefixConcurrency::Serial(SerialPrefixReason::LegacyHelper)
    ));
}
#[test]
fn changed_executed_source_does_not_inherit_proof_from_public_profile() {
    let (manifest, originals) = fixture();
    for key in originals.bytes.keys() {
        let mut changed = Originals {
            bytes: originals.bytes.clone(),
            pins: vec![],
            runtime_files: BTreeMap::new(),
        };
        changed
            .bytes
            .get_mut(key)
            .unwrap()
            .extend_from_slice(b"\n# changed\n");
        assert!(
            matches!(
                derive_prefix_concurrency(&manifest, &changed),
                PrefixConcurrency::Serial(SerialPrefixReason::UnreviewedPrefix)
            ),
            "changed source remained isolated: {}",
            key.1
        );
    }
}
#[test]
fn unknown_library_tier_or_handler_order_never_earns_proof() {
    let (manifest, originals) = fixture();
    for kind in ["project", "user", "unknown"] {
        let mut changed = manifest.clone();
        changed.selection.libraries[0].kind = kind.into();
        assert!(matches!(
            derive_prefix_concurrency(&changed, &originals),
            PrefixConcurrency::Serial(_)
        ));
    }
    let mut changed = manifest;
    changed.selection.handlers.swap(0, 1);
    assert!(matches!(
        derive_prefix_concurrency(&changed, &originals),
        PrefixConcurrency::Serial(_)
    ));
}
