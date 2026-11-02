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
        "advisory_truncate.cjs",
        "dispatch.sh",
        "handler-env.sh",
        "runtime-paths.sh",
        "lib/run-handlers.sh",
        "lib/session-cache.sh",
        "lib/guard-config.sh",
        "lib/guard-config.cjs",
        "lib/reprieve.sh",
        "lib/reprieve-reader.cjs",
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
    // Mirror real stock selection's shared-then-surface precedence using the
    // repository files, independently of the compiled reviewed hash table.
    let templates = Path::new(env!("CARGO_MANIFEST_DIR")).join("../caws-cli/templates/hook-packs");
    let mut libraries = BTreeMap::new();
    for (kind, directory, prefix) in [
        ("shared", "shared/lib", "lib"),
        ("surface", "codex/hooks/lib", "surfaces/codex/lib"),
    ] {
        for entry in std::fs::read_dir(templates.join(directory)).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                let name = entry.file_name().into_string().unwrap();
                assert!(!name.starts_with(".env"));
                libraries.insert(name.clone(), (kind, format!("{prefix}/{name}")));
            }
        }
    }
    manifest.selection.libraries.clear();
    for (name, (kind, relative)) in libraries {
        let bytes = native_prefix_source(&relative).unwrap();
        originals
            .bytes
            .insert(("runtime".into(), relative.clone()), bytes.clone());
        manifest.selection.libraries.push(Library {
            name,
            path: format!("/machine/runtime/{relative}"),
            sha256: hash(&bytes),
            kind: kind.into(),
        });
    }
    manifest
        .selection
        .libraries
        .sort_by(|a, b| a.name.cmp(&b.name));
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
fn optional_advisory_tools_do_not_change_reviewed_four_handler_prefix_eligibility() {
    for names in [&[][..], &["cmp"][..], &["iconv"][..], &["cmp", "iconv"][..]] {
        let (mut manifest, originals) = fixture();
        for name in names {
            manifest.toolchain_tcb.tools.push(Tool {
                name: (*name).into(),
                path: format!("/tools/{name}"),
                sha256: "c".repeat(64),
            });
        }
        manifest
            .toolchain_tcb
            .tools
            .sort_by(|a, b| a.name.cmp(&b.name));
        assert!(valid_tool_names(&manifest.toolchain_tcb.tools));
        assert!(
            matches!(
                derive_prefix_concurrency(&manifest, &originals),
                PrefixConcurrency::Session(_)
            ),
            "optional tools {names:?}"
        );
    }
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
        let comment = if key.1 == "advisory_truncate.cjs" {
            &b"\n// changed\n"[..]
        } else {
            &b"\n# changed\n"[..]
        };
        changed
            .bytes
            .get_mut(key)
            .unwrap()
            .extend_from_slice(comment);
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
fn missing_advisory_helper_or_extra_heartbeat_keeps_prefix_serial() {
    let (manifest, mut originals) = fixture();
    assert!(
        originals
            .bytes
            .remove(&("runtime".into(), "advisory_truncate.cjs".into()))
            .is_some()
    );
    assert!(matches!(
        derive_prefix_concurrency(&manifest, &originals),
        PrefixConcurrency::Serial(SerialPrefixReason::UnreviewedPrefix)
    ));

    let (mut manifest, originals) = fixture();
    manifest.selection.handlers.push(Handler {
        path: "/machine/runtime/agent-heartbeat.sh".into(),
        sha256: hash(&native_prefix_source("agent-heartbeat.sh").unwrap()),
        entry: "agent-heartbeat.sh".into(),
        name: "agent-heartbeat.sh".into(),
        args: vec![],
        tier: "stock".into(),
        kind: "stock".into(),
    });
    assert_eq!(manifest.selection.handlers.len(), 5);
    assert!(matches!(
        derive_prefix_concurrency(&manifest, &originals),
        PrefixConcurrency::Serial(SerialPrefixReason::UnreviewedPrefix)
    ));
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

#[test]
fn reprieve_cohort_requires_selected_shared_routes_and_exact_sibling_bytes() {
    let (manifest, originals) = fixture();
    assert!(reviewed_shared_siblings(&manifest.selection, &originals));
    for name in REVIEWED_SHARED_SIBLINGS {
        for kind in ["surface", "project", "user", "unknown"] {
            let mut changed = manifest.clone();
            changed
                .selection
                .libraries
                .iter_mut()
                .find(|library| library.name == name)
                .unwrap()
                .kind = kind.into();
            assert!(
                !reviewed_shared_siblings(&changed.selection, &originals),
                "{name}: {kind}"
            );
            assert!(matches!(
                derive_prefix_concurrency(&changed, &originals),
                PrefixConcurrency::Serial(_)
            ));
        }
        let mut changed = manifest.clone();
        changed
            .selection
            .libraries
            .iter_mut()
            .find(|library| library.name == name)
            .unwrap()
            .sha256 = "0".repeat(64);
        assert!(
            !reviewed_shared_siblings(&changed.selection, &originals),
            "unbound digest: {name}"
        );
        assert!(matches!(
            derive_prefix_concurrency(&changed, &originals),
            PrefixConcurrency::Serial(_)
        ));
        let key = ("runtime".into(), format!("lib/{name}"));
        let mut changed = Originals {
            bytes: originals.bytes.clone(),
            pins: vec![],
            runtime_files: BTreeMap::new(),
        };
        let original = changed.bytes.remove(&key).unwrap();
        assert!(
            !reviewed_shared_siblings(&manifest.selection, &changed),
            "missing sibling: {name}"
        );
        assert!(matches!(
            derive_prefix_concurrency(&manifest, &changed),
            PrefixConcurrency::Serial(_)
        ));
        changed.bytes.insert(
            key,
            [original.as_slice(), b"\n// unreviewed sibling\n"].concat(),
        );
        assert!(
            !reviewed_shared_siblings(&manifest.selection, &changed),
            "changed sibling: {name}"
        );
        assert!(matches!(
            derive_prefix_concurrency(&manifest, &changed),
            PrefixConcurrency::Serial(_)
        ));
    }
}

#[test]
fn reprieve_cohort_omitted_metadata_cannot_hide_present_changed_or_missing_closure() {
    let (manifest, originals) = fixture();
    assert!(reviewed_shared_siblings(&manifest.selection, &originals));
    for name in REVIEWED_SHARED_SIBLINGS {
        let mut omitted = manifest.clone();
        omitted
            .selection
            .libraries
            .retain(|library| library.name != name);
        assert!(
            !reviewed_shared_siblings(&omitted.selection, &originals),
            "omitted selected sibling: {name}"
        );
        assert!(matches!(
            derive_prefix_concurrency(&omitted, &originals),
            PrefixConcurrency::Serial(_)
        ));
        let key = ("runtime".into(), format!("lib/{name}"));
        let mut changed = Originals {
            bytes: originals.bytes.clone(),
            pins: vec![],
            runtime_files: BTreeMap::new(),
        };
        changed
            .bytes
            .get_mut(&key)
            .unwrap()
            .extend_from_slice(b"\n// omitted mutation\n");
        assert!(
            !reviewed_shared_siblings(&omitted.selection, &changed),
            "omitted mutated closure: {name}"
        );
        assert!(matches!(
            derive_prefix_concurrency(&omitted, &changed),
            PrefixConcurrency::Serial(_)
        ));
        changed.bytes.remove(&key).unwrap();
        assert!(
            !reviewed_shared_siblings(&omitted.selection, &changed),
            "omitted missing closure: {name}"
        );
        assert!(matches!(
            derive_prefix_concurrency(&omitted, &changed),
            PrefixConcurrency::Serial(_)
        ));
    }
}
