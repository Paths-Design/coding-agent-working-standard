use super::*;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);
#[test]
fn tool_profile_order_matches_canonical_lexical_manifest_order() {
    assert!(TOOLS.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(&TOOLS[..3], &["awk", "basename", "bash"]);
}
fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let base = std::env::temp_dir().canonicalize().unwrap();
        let root = base.join(format!(
            "caws-image-unit-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        fn restore(p: &Path) {
            let Ok(meta) = fs::symlink_metadata(p) else {
                return;
            };
            if meta.is_dir() {
                let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o700));
                if let Ok(entries) = fs::read_dir(p) {
                    for e in entries.flatten() {
                        restore(&e.path());
                    }
                }
            }
        }
        restore(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn write_mode(path: &Path, bytes: &[u8], mode: u32) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

// Synthetic metadata exercises individual validation stages, not filesystem
// admission. No foreign source bytes or synthetic admitted backend are used.
fn binding_fixture() -> (PreparedImageManifest, AdmissionContext) {
    let canonical_project = "/project".to_owned();
    let runtime_digest = "a".repeat(64);
    let selection = Selection {
        canonical_project: canonical_project.clone(),
        surface: "codex".into(),
        event: "stop".into(),
        configuration: "system".into(),
        runtime_digest: runtime_digest.clone(),
        selected_index: 0,
        handlers: vec![Handler {
            path: "/project/.caws/hooks/session-log.sh".into(),
            sha256: FOREIGN_PROFILE[0].1.into(),
            entry: "session-log.sh".into(),
            name: "session-log.sh".into(),
            args: vec![],
            tier: "machine-policy".into(),
            kind: "project-override".into(),
        }],
        libraries: vec![],
    };
    let mut closure: Vec<_> = FOREIGN_PROFILE
        .iter()
        .map(|(path, hash)| SourceFile {
            origin: "project".into(),
            path: format!("/project/.caws/hooks/{path}"),
            relative_path: (*path).into(),
            sha256: (*hash).into(),
            bytes: 1,
        })
        .collect();
    for path in ["service-client.js", "service-protocol.js"] {
        closure.push(SourceFile {
            origin: "client".into(),
            path: format!("/cli/{path}"),
            relative_path: path.into(),
            sha256: "b".repeat(64),
            bytes: 1,
        });
    }
    closure.sort_by(|a, b| (&a.origin, &a.relative_path).cmp(&(&b.origin, &b.relative_path)));
    let tcb = ToolchainTcb {
        tools: TOOLS
            .iter()
            .map(|name| Tool {
                name: (*name).into(),
                path: match *name {
                    "bash" => "/bin/bash".into(),
                    "caws" => "/index.js".into(),
                    "sh" => "/bin/sh".into(),
                    _ => format!("/tools/{name}"),
                },
                sha256: "c".repeat(64),
            })
            .collect(),
        python_flags: vec!["-I".into(), "-S".into(), "-B".into()],
        system_dependencies: "trusted-not-hash-complete".into(),
    };
    let mut manifest = PreparedImageManifest {
        schema: IMAGE_SCHEMA.into(),
        adapter: ADAPTER.into(),
        profile: PROFILE.into(),
        selection: selection.clone(),
        original_closure: closure,
        original_closure_digest: String::new(),
        source_generation: String::new(),
        execution: Execution {
            root: String::new(),
            dispatcher: "runtime/dispatch.sh".into(),
            hooks: "hooks".into(),
            client: "client/service-client.js".into(),
            handler_routes: vec![],
            resolved_libraries: vec![],
            files: vec![ImageFile {
                path: "hooks/session-log.sh".into(),
                sha256: FOREIGN_PROFILE[0].1.into(),
                bytes: 1,
                mode: 0o555,
            }],
        },
        toolchain_tcb: tcb,
    };
    manifest.original_closure_digest = original_closure_digest(&manifest).unwrap();
    manifest.source_generation = source_generation(&manifest).unwrap();
    let mut context = AdmissionContext {
        home: PathBuf::from("/machine"),
        canonical_project,
        runtime_digest,
        client_root: PathBuf::from("/cli"),
        template_root: PathBuf::from("/templates/service-image"),
        client_shell_source: PathBuf::from("/templates/session-render-service-client.sh"),
        expected_selection: selection,
        expected_image_digest: "d".repeat(64),
        expected_policy_sha256: "e".repeat(64),
        caller_environment: BTreeMap::new(),
    };
    manifest.execution.root = image_parent(&context)
        .join(image_key(&manifest).unwrap())
        .to_str()
        .unwrap()
        .into();
    context.expected_image_digest = hash(&json(&manifest).unwrap());
    (manifest, context)
}
fn reseal_metadata(manifest: &mut PreparedImageManifest, context: &mut AdmissionContext) {
    manifest.original_closure_digest = original_closure_digest(manifest).unwrap();
    manifest.source_generation = source_generation(manifest).unwrap();
    manifest.execution.root = image_parent(context)
        .join(image_key(manifest).unwrap())
        .to_str()
        .unwrap()
        .into();
    context.expected_image_digest = hash(&json(manifest).unwrap());
}

#[test]
fn static_foreign_profile_refuses_changed_missing_duplicate_and_unreviewed_code() {
    let (manifest, _) = binding_fixture();
    validate_foreign_profile(&manifest.original_closure).unwrap();
    let project_index = manifest
        .original_closure
        .iter()
        .position(|r| r.origin == "project")
        .unwrap();
    let mut rows = manifest.original_closure.clone();
    rows[project_index].sha256 = "0".repeat(64);
    assert!(validate_foreign_profile(&rows).is_err());
    let mut rows = manifest.original_closure.clone();
    rows.remove(project_index);
    assert!(validate_foreign_profile(&rows).is_err());
    let mut rows = manifest.original_closure.clone();
    rows.push(rows[project_index].clone());
    assert!(validate_foreign_profile(&rows).is_err());
    let mut rows = manifest.original_closure.clone();
    rows[project_index].relative_path = "lib/unreviewed.py".into();
    assert!(validate_foreign_profile(&rows).is_err());
    assert_eq!(FOREIGN_PROFILE.len(), 28);
}
#[test]
fn self_consistent_changed_foreign_hash_does_not_manufacture_profile_admission() {
    let (mut manifest, mut context) = binding_fixture();
    let row = manifest
        .original_closure
        .iter_mut()
        .find(|r| r.origin == "project" && r.relative_path == "session_log_renderer.py")
        .unwrap();
    row.sha256 = "f".repeat(64);
    reseal_metadata(&mut manifest, &mut context);
    assert_eq!(
        validate_binding(&manifest, &context, Path::new(&manifest.execution.root))
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedProfile
    );
}
#[test]
fn operator_declaration_binds_complete_profile_and_original_handler_not_image_digest() {
    let (manifest, _) = binding_fixture();
    let selected = &manifest.selection.handlers[0];
    let policy = OperatorPolicy {
        version: 1,
        adapter: ADAPTER.into(),
        profile: PROFILE.into(),
        root: manifest.selection.canonical_project.clone(),
        handler: OperatorHandler {
            entry: "session-log.sh".into(),
            path: selected.path.clone(),
            sha256: selected.sha256.clone(),
        },
        source_profile_digest: manifest.original_closure_digest.clone(),
    };
    validate_policy(&policy, &manifest).unwrap();
    let mut stale = policy.clone();
    stale.source_profile_digest = "0".repeat(64);
    assert!(validate_policy(&stale, &manifest).is_err());
    let mut wrong = policy.clone();
    wrong.handler.path = "/other/session-log.sh".into();
    assert!(validate_policy(&wrong, &manifest).is_err());
    let mut wrong = policy.clone();
    wrong.root = "/other".into();
    assert!(validate_policy(&wrong, &manifest).is_err());
    let mut changed = manifest.clone();
    changed.toolchain_tcb.tools[0].sha256 = "0".repeat(64);
    changed.original_closure_digest = original_closure_digest(&changed).unwrap();
    assert!(validate_policy(&policy, &changed).is_err());
    let valid = String::from_utf8(json(&policy).unwrap()).unwrap();
    assert!(
        serde_json::from_str::<OperatorPolicy>(
            &valid.replace("\"version\":1", "\"version\":1,\"version\":1")
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<OperatorPolicy>(
            &valid.replace("\"version\":1", "\"version\":1,\"unknown\":true")
        )
        .is_err()
    );
}
#[test]
fn trusted_selection_and_native_derived_image_location_cannot_be_self_asserted() {
    let (manifest, context) = binding_fixture();
    let root = Path::new(&manifest.execution.root);
    validate_binding(&manifest, &context, root).unwrap();
    let mut wrong = context.clone();
    wrong.expected_image_digest = "0".repeat(64);
    assert!(validate_binding(&manifest, &wrong, root).is_err());
    let mut wrong = context.clone();
    wrong.expected_selection.selected_index = 1;
    assert!(validate_binding(&manifest, &wrong, root).is_err());
    let mut wrong = context.clone();
    wrong.canonical_project = "/another-project".into();
    assert!(validate_binding(&manifest, &wrong, root).is_err());
    assert!(validate_binding(&manifest, &context, Path::new("/caller-selected/image")).is_err());
    let mut changed = manifest.clone();
    changed.selection.configuration = "project-policy".into();
    let mut matching = context.clone();
    matching.expected_selection = changed.selection.clone();
    reseal_metadata(&mut changed, &mut matching);
    assert!(validate_binding(&changed, &matching, Path::new(&changed.execution.root)).is_err());
}
#[test]
fn unsupported_preloads_refuse_even_with_otherwise_matching_public_hashes() {
    let (manifest, context) = binding_fixture();
    for name in [
        "BASH_ENV",
        "ENV",
        "CAWS_PRIOR_BASH_ENV",
        "CAWS_GUARD_CONFIG_PY",
        "CAWS_GIT_BINARY",
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_EXTRA_CA_CERTS",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PYTHONUSERBASE",
        "PYTHONDONTWRITEBYTECODE",
        "LD_PRELOAD",
        "LD_AUDIT",
        "DYLD_INSERT_LIBRARIES",
        "CAWS_SERVICE_GIT_DIRECTORY",
        "CAWS_BIN",
        "_HOOK_HANDLER_PATH",
        "_CAWS_SOURCE_PATH",
        "SHELLOPTS",
        "BASHOPTS",
        "BASH_FUNC_f%%",
    ] {
        let mut context = context.clone();
        context
            .caller_environment
            .insert(name.into(), "arbitrary".into());
        assert_eq!(
            validate_binding(&manifest, &context, Path::new(&manifest.execution.root))
                .unwrap_err()
                .kind,
            ErrorKind::UnsupportedProfile,
            "{name}"
        );
    }
    let mut permitted = context.clone();
    for (name, value) in [("PYTHONDONTWRITEBYTECODE", "1"), ("CAWS_BIN", "caws")] {
        permitted
            .caller_environment
            .insert(name.into(), value.into());
    }
    validate_binding(&manifest, &permitted, Path::new(&manifest.execution.root)).unwrap();
}
#[test]
fn nofollow_component_walk_and_private_sealed_modes_are_enforced() {
    let scratch = Scratch::new();
    let actual = scratch.0.join("actual");
    fs::DirBuilder::new().mode(0o700).create(&actual).unwrap();
    symlink(&actual, scratch.0.join("alias")).unwrap();
    assert!(absolute_directory(&scratch.0.join("alias"), Access::Source, expires()).is_err());
    assert!(absolute_directory(&actual, Access::SealedDirectory, expires()).is_err());
    fs::set_permissions(&actual, fs::Permissions::from_mode(0o500)).unwrap();
    absolute_directory(&actual, Access::SealedDirectory, expires()).unwrap();
    let file = scratch.0.join("file");
    write_mode(&file, b"sealed", 0o555);
    let (bytes, stamp) = read_file(
        absolute_file(&file, Access::SealedFile, expires()).unwrap(),
        100,
        Access::SealedFile,
        expires(),
    )
    .unwrap();
    assert_eq!(bytes, b"sealed");
    fs::hard_link(&file, scratch.0.join("linked")).unwrap();
    assert!(absolute_file(&file, Access::SealedFile, expires()).is_err());
    fs::remove_file(scratch.0.join("linked")).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(absolute_file(&file, Access::SealedFile, expires()).is_err());
    write_mode(&file, b"changed length", 0o555);
    assert_eq!(
        check_pins(
            &[Pin {
                path: file,
                stamp,
                access: Access::SealedFile
            }],
            expires()
        )
        .unwrap_err()
        .kind,
        ErrorKind::Changed
    );
}
#[test]
fn source_cache_exclusion_never_hides_unreviewed_source_or_symlink_entries() {
    let scratch = Scratch::new();
    write_mode(&scratch.0.join("module.py"), b"source", 0o644);
    write_mode(&scratch.0.join("orphan.pyc"), b"not source", 0o644);
    let cache = scratch.0.join("__pycache__");
    fs::DirBuilder::new().mode(0o700).create(&cache).unwrap();
    write_mode(&cache.join("module.cpython.pyc"), b"not copied", 0o644);
    let root = absolute_directory(&scratch.0, Access::Source, expires()).unwrap();
    let mut files = BTreeSet::new();
    let mut dirs = BTreeSet::new();
    scan_tree(&root, "", false, true, &mut files, &mut dirs, expires()).unwrap();
    assert_eq!(files, ["module.py".to_owned()].into_iter().collect());
    assert!(dirs.is_empty());
    write_mode(&scratch.0.join("unreviewed.py"), b"code", 0o644);
    let first = names(&root, expires()).unwrap();
    assert_eq!(
        names(&root, expires()).unwrap(),
        first,
        "directory scans must not share an exhausted offset"
    );
    let mut files = BTreeSet::new();
    let mut dirs = BTreeSet::new();
    scan_tree(&root, "", false, true, &mut files, &mut dirs, expires()).unwrap();
    assert!(files.contains("unreviewed.py"));
    symlink(scratch.0.join("module.py"), scratch.0.join("symlink.pyc")).unwrap();
    assert!(
        scan_tree(
            &root,
            "",
            false,
            true,
            &mut BTreeSet::new(),
            &mut BTreeSet::new(),
            expires()
        )
        .is_err()
    );
}
#[test]
fn sealed_tree_refuses_extra_files_and_file_reads_refuse_byte_bounds() {
    let scratch = Scratch::new();
    write_mode(&scratch.0.join("entry"), b"abcd", 0o555);
    assert!(
        read_file(
            absolute_file(&scratch.0.join("entry"), Access::SealedFile, expires()).unwrap(),
            3,
            Access::SealedFile,
            expires()
        )
        .is_err()
    );
    let root = absolute_directory(&scratch.0, Access::PrivateParent, expires()).unwrap();
    let mut files = BTreeSet::new();
    let mut dirs = BTreeSet::new();
    scan_tree(&root, "", false, false, &mut files, &mut dirs, expires()).unwrap();
    assert_eq!(files, ["entry".to_owned()].into_iter().collect());
    write_mode(&scratch.0.join("extra"), b"unadmitted", 0o555);
    files.clear();
    scan_tree(&root, "", false, false, &mut files, &mut dirs, expires()).unwrap();
    assert_ne!(files, ["entry".to_owned()].into_iter().collect());
    assert!(deadline(Instant::now() - Duration::from_millis(1)).is_err());
}

#[test]
fn native_marker_expansion_is_single_pass_and_refuses_missing_duplicate_markers() {
    assert_eq!(quoted("a'b"), "'a'\\''b'");
    assert_eq!(
        expand(
            "left __ONE__ middle __TWO__ end\n",
            &[
                ("__ONE__", "data __TWO__".into()),
                ("__TWO__", "value".into())
            ]
        )
        .unwrap(),
        b"left data __TWO__ middle value end\n"
    );
    assert!(expand("__ONE____ONE__", &[("__ONE__", "value".into())]).is_err());
    assert!(expand("missing", &[("__ONE__", "value".into())]).is_err());
    assert!(replace_exact("a anchor anchor z", "anchor", "replacement", 1).is_err());
}
#[test]
fn package_client_shell_is_independently_required_and_must_match_native_owned_bytes() {
    let (manifest, _) = binding_fixture();
    let mut originals = Originals {
        bytes: TEMPLATES
            .iter()
            .map(|(name, source)| {
                (
                    ("client".to_owned(), format!("service-image/{name}")),
                    source.as_bytes().to_vec(),
                )
            })
            .collect(),
        pins: vec![],
        runtime_files: BTreeMap::new(),
    };
    assert_eq!(
        execution_bytes(&manifest, &originals)
            .unwrap_err()
            .operation(),
        "required original source missing"
    );
    originals.bytes.insert(
        ("client".into(), "session-render-service-client.sh".into()),
        b"unreviewed shell".to_vec(),
    );
    assert_eq!(
        execution_bytes(&manifest, &originals)
            .unwrap_err()
            .operation(),
        "service client shell differs from native-owned bytes"
    );
    originals.bytes.insert(
        ("client".into(), "session-render-service-client.sh".into()),
        CLIENT_SHELL.as_bytes().to_vec(),
    );
    // The correct package client passes its own check; this deliberately partial
    // fixture then refuses at runtime reconstruction, never full admission.
    assert_eq!(
        execution_bytes(&manifest, &originals)
            .unwrap_err()
            .operation(),
        "required runtime adaptation source missing"
    );
}
#[test]
fn first_profile_caws_entry_is_config_derived_not_an_arbitrary_executable() {
    let (mut manifest, mut context) = binding_fixture();
    manifest
        .toolchain_tcb
        .tools
        .iter_mut()
        .find(|t| t.name == "caws")
        .unwrap()
        .path = "/mutable/bin/caws".into();
    reseal_metadata(&mut manifest, &mut context);
    assert_eq!(
        validate_binding(&manifest, &context, Path::new(&manifest.execution.root))
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedProfile
    );
}
#[test]
fn staged_publication_selection_is_native_derived_and_bounded() {
    let (_, context) = binding_fixture();
    let allowed = image_parent(&context).join(".stage-Abc123");
    assert_eq!(stage_name(&allowed, &context).unwrap(), ".stage-Abc123");
    for path in [
        image_parent(&context).join(".stage-"),
        image_parent(&context).join("caller-image"),
        PathBuf::from("/other/.stage-Abc123"),
        image_parent(&context).join(format!(".stage-{}", "x".repeat(129))),
    ] {
        assert!(stage_name(&path, &context).is_err());
    }
}
#[test]
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn atomic_publication_never_overwrites_an_existing_destination() {
    let scratch = Scratch::new();
    let stage = scratch.0.join(".stage-abc123");
    let destination = scratch.0.join("existing");
    fs::DirBuilder::new().mode(0o700).create(&stage).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&destination)
        .unwrap();
    write_mode(&stage.join("payload"), b"stage bytes", 0o600);
    write_mode(&destination.join("payload"), b"existing bytes", 0o600);
    let original = fs::metadata(&stage).unwrap();
    let parent = absolute_directory(&scratch.0, Access::PrivateParent, expires()).unwrap();
    assert_eq!(
        rename_no_replace(parent.as_raw_fd(), ".stage-abc123", "existing")
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EEXIST)
    );
    assert_eq!(fs::read(stage.join("payload")).unwrap(), b"stage bytes");
    assert_eq!(
        fs::read(destination.join("payload")).unwrap(),
        b"existing bytes"
    );
    rename_no_replace(parent.as_raw_fd(), ".stage-abc123", "published").unwrap();
    assert!(!stage.exists());
    assert_eq!(
        fs::read(scratch.0.join("published/payload")).unwrap(),
        b"stage bytes"
    );
    let published = fs::metadata(scratch.0.join("published")).unwrap();
    assert_eq!(
        (published.dev(), published.ino()),
        (original.dev(), original.ino())
    );
}

#[test]
fn binding_preserves_ordered_stock_stop_chain_and_nonzero_selected_index() {
    let (mut manifest, mut context) = binding_fixture();
    let stock = |name: &str| Handler {
        path: format!("/machine/lib/runtimes/{}/{name}", context.runtime_digest),
        sha256: "d".repeat(64),
        entry: name.into(),
        name: name.into(),
        args: vec![],
        tier: "stock".into(),
        kind: "stock".into(),
    };
    manifest
        .selection
        .handlers
        .insert(0, stock("plan-transcript-snapshot.sh"));
    manifest.selection.handlers.push(stock("agents-stop.sh"));
    manifest.selection.selected_index = 1;
    context.expected_selection = manifest.selection.clone();
    reseal_metadata(&mut manifest, &mut context);
    validate_binding(&manifest, &context, Path::new(&manifest.execution.root)).unwrap();
    assert_eq!(
        manifest
            .selection
            .handlers
            .iter()
            .map(|h| h.entry.as_str())
            .collect::<Vec<_>>(),
        [
            "plan-transcript-snapshot.sh",
            "session-log.sh",
            "agents-stop.sh"
        ]
    );
    assert_eq!(manifest.selection.selected_index, 1);
}
