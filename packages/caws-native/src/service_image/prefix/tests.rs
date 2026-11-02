use super::*;

// Discriminator controls use synthetic metadata and authentic retained source
// bytes. They do not establish filesystem admission or an actual prefix run.
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RetainedSource {
    runtime_relative: String,
    byte_length: usize,
    sha256: String,
    bytes_base64: String,
}
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RetainedLibrary {
    name: String,
    kind: String,
    runtime_relative: String,
}
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RetainedSnapshot {
    schema_version: u32,
    source_commit: String,
    profile: String,
    profile_sha256: String,
    sources: Vec<RetainedSource>,
    selected_libraries: Vec<RetainedLibrary>,
}
struct RetainedPrefix {
    sources: BTreeMap<String, Vec<u8>>,
    selected_libraries: Vec<RetainedLibrary>,
}
fn read_retained_snapshot() -> RetainedSnapshot {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/reviewed-stop-prefix.json"
    ))
    .expect("repository-owned reviewed prefix fixture")
}
fn decode_retained_snapshot(
    snapshot: &RetainedSnapshot,
) -> std::result::Result<RetainedPrefix, &'static str> {
    if snapshot.schema_version != 1
        || snapshot.source_commit != "58ed781a854b1fd8fe42592d7f765441b672aa2c"
        || snapshot.profile != "codex-stop-session-prefix-v1"
        || snapshot.profile_sha256 != hash(include_bytes!("../prefix-profile.json"))
    {
        return Err("retained review provenance mismatch");
    }
    if snapshot.sources.len() != 44 || snapshot.sources.len() != reviewed_sources().len() {
        return Err("retained source inventory size");
    }
    let mut sources = BTreeMap::new();
    for source in &snapshot.sources {
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &source.bytes_base64,
        )
        .map_err(|_| "invalid retained source encoding")?;
        let expected = reviewed_sources()
            .get(&source.runtime_relative)
            .ok_or("unreviewed retained source")?;
        if bytes.len() != source.byte_length {
            return Err("retained source length changed");
        }
        if &source.sha256 != expected || hash(&bytes) != *expected {
            return Err("retained source bytes differ from compiled review");
        }
        if sources
            .insert(source.runtime_relative.clone(), bytes)
            .is_some()
        {
            return Err("duplicate retained source");
        }
    }
    if !sources.keys().eq(reviewed_sources().keys())
        || snapshot
            .sources
            .windows(2)
            .any(|rows| rows[0].runtime_relative >= rows[1].runtime_relative)
    {
        return Err("retained source inventory is not complete and sorted");
    }
    let mut expected_libraries = BTreeMap::new();
    for (kind, prefix) in [("shared", "lib/"), ("surface", "surfaces/codex/lib/")] {
        for relative in sources.keys() {
            if let Some(name) = relative.strip_prefix(prefix) {
                if name.is_empty() || name.contains('/') {
                    return Err("invalid retained library namespace");
                }
                expected_libraries.insert(name.to_owned(), (kind.to_owned(), relative.clone()));
            }
        }
    }
    if snapshot.selected_libraries.len() != 34
        || expected_libraries.len() != snapshot.selected_libraries.len()
    {
        return Err("retained library inventory size");
    }
    if snapshot
        .selected_libraries
        .windows(2)
        .any(|rows| rows[0].name >= rows[1].name)
    {
        return Err("retained library inventory is not sorted and unique");
    }
    for library in &snapshot.selected_libraries {
        let (kind, relative) = expected_libraries
            .get(&library.name)
            .ok_or("unreviewed retained library")?;
        if kind != &library.kind || relative != &library.runtime_relative {
            return Err("retained library binding mismatch");
        }
    }
    Ok(RetainedPrefix {
        sources,
        selected_libraries: snapshot.selected_libraries.clone(),
    })
}
fn retained_prefix() -> &'static RetainedPrefix {
    static RETAINED: std::sync::OnceLock<RetainedPrefix> = std::sync::OnceLock::new();
    RETAINED.get_or_init(|| {
        decode_retained_snapshot(&read_retained_snapshot())
            .expect("fixture bytes and inventory must match compiled review")
    })
}
fn native_prefix_source(relative: &str) -> Option<Vec<u8>> {
    retained_prefix().sources.get(relative).cloned()
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
    // Historical selection is retained with the source bytes; current template
    // additions cannot silently acquire this compiled review's eligibility.
    manifest.selection.libraries.clear();
    for library in &retained_prefix().selected_libraries {
        let relative = &library.runtime_relative;
        let bytes = native_prefix_source(relative).unwrap();
        originals
            .bytes
            .insert(("runtime".into(), relative.clone()), bytes.clone());
        manifest.selection.libraries.push(Library {
            name: library.name.clone(),
            path: format!("/machine/runtime/{relative}"),
            sha256: hash(&bytes),
            kind: library.kind.clone(),
        });
    }
    assert!(matches!(
        derive_prefix_concurrency(&manifest, &originals),
        PrefixConcurrency::Session(_)
    ));
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
        sha256: hash(b"synthetic extra heartbeat source"),
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

#[test]
fn retained_fixture_rejects_changed_missing_duplicate_and_misbound_inputs() {
    let original = read_retained_snapshot();
    assert!(decode_retained_snapshot(&original).is_ok());

    let mut changed = original.clone();
    let source = &mut changed.sources[0];
    let mut bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &source.bytes_base64,
    )
    .unwrap();
    bytes[0] ^= 1;
    source.bytes_base64 =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    source.sha256 = hash(&bytes);
    assert!(matches!(
        decode_retained_snapshot(&changed),
        Err("retained source bytes differ from compiled review")
    ));

    let mut missing = original.clone();
    missing.sources.pop().unwrap();
    assert!(matches!(
        decode_retained_snapshot(&missing),
        Err("retained source inventory size")
    ));

    let mut duplicate = original.clone();
    duplicate.sources[1] = duplicate.sources[0].clone();
    assert!(matches!(
        decode_retained_snapshot(&duplicate),
        Err("duplicate retained source")
    ));

    let mut changed_kind = original.clone();
    changed_kind.selected_libraries[0].kind = "project".into();
    assert!(matches!(
        decode_retained_snapshot(&changed_kind),
        Err("retained library binding mismatch")
    ));

    let mut missing_library = original;
    missing_library.selected_libraries.pop().unwrap();
    assert!(matches!(
        decode_retained_snapshot(&missing_library),
        Err("retained library inventory size")
    ));
}
