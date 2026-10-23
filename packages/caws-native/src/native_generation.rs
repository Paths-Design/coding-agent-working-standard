//! Request-owned evidence for one exact installed generation.
//!
//! This reuses installed-entry verification and the cooperative engine/CLI TCB.
//! current_exe identifies the configured native pathname and its verified on-disk
//! member, not a sealed in-memory executable or proof of launcher provenance.
//! Correct direct invocation of a verified installed generation is admissible.
//! No policy decision, project authority, SQL capability, or frame is issued here.
use crate::{
    cli::Config,
    installed_entry::{MemberMetadata, Selection, Verification},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

/// Fixed-size metadata plus the 64-byte digest; never the runtime file body.
/// Not deserializable: only this native owner constructs an observation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeMemberDigest {
    pub sha256: String,
    pub metadata: MemberMetadata,
}

/// No Clone/Deserialize and no caller-supplied receipt or global cache. A future
/// protocol owner must retain this value for the original invocation, correlate
/// its observation ids/readset, and call revalidate before consuming selection.
pub(crate) struct GenerationReceipt {
    selection: Selection,
    expires: Instant,
    files: BTreeMap<PathBuf, MemberMetadata>,
    directories: BTreeMap<PathBuf, MemberMetadata>,
    ancestors: BTreeMap<PathBuf, MemberMetadata>,
}
impl GenerationReceipt {
    pub(crate) fn capture(
        home: &Path,
        config: &Config,
        expires: Instant,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        let mut verify = Verification::new(expires, &mut cancel);
        verify.checkpoint()?;
        let running = std::env::current_exe();
        verify.checkpoint()?;
        Self::capture_at(
            home,
            config,
            &running.map_err(|e| e.to_string())?,
            &mut verify,
        )
    }

    // The image path and chunk observer are private test seams only.
    fn capture_at(
        home: &Path,
        config: &Config,
        running_native: &Path,
        verify: &mut Verification<'_>,
    ) -> Result<Self, String> {
        verify.checkpoint()?;
        let selection = Selection::read_generation(home, &config.digest, verify)?;
        let (native, node, engine) = selection.native_paths(verify)?;
        if running_native != native || config.node != node || config.engine != engine {
            return Err("Invocation paths differ from admitted native generation".into());
        }
        let mut files = BTreeMap::new();
        let mut directories = BTreeMap::new();
        directories.insert(
            selection.root().to_path_buf(),
            MemberMetadata::read(selection.root(), true, verify)?,
        );
        // Ancestors provide traversal identity, not selected-generation inventory.
        // Sibling installs and pointer updates may change their directory stamps.
        let mut ancestors = BTreeMap::new();
        let mut directory = selection.root().parent().ok_or("Generation escaped home")?;
        loop {
            if !directory.starts_with(home) {
                return Err("Generation escaped home".into());
            }
            ancestors.insert(
                directory.to_path_buf(),
                MemberMetadata::read(directory, true, verify)?,
            );
            if directory == home {
                break;
            }
            directory = directory.parent().ok_or("Generation escaped home")?;
        }
        for relative in selection
            .members()
            .keys()
            .map(String::as_str)
            .chain(std::iter::once("manifest.json"))
        {
            let file = if relative == "manifest.json" {
                selection.root().join(relative)
            } else {
                selection.member_path(relative, verify)?
            };
            files.insert(file.clone(), MemberMetadata::read(&file, false, verify)?);
            let mut parent = file.parent().ok_or("Runtime member has no parent")?;
            while parent != selection.root() {
                directories.insert(
                    parent.to_path_buf(),
                    MemberMetadata::read(parent, true, verify)?,
                );
                parent = parent.parent().ok_or("Runtime member escaped generation")?;
            }
        }
        let receipt = Self {
            selection,
            expires: verify.expires(),
            files,
            directories,
            ancestors,
        };
        // Hashes and inventory must agree with the retained file identities.
        receipt.revalidate_with(verify)?;
        Ok(receipt)
    }

    pub(crate) fn digest(&self) -> &str {
        &self.selection.inspected_digest
    }

    /// Lookup is bounded by the already bounded manifest; no member bytes cross
    /// this boundary and an undeclared/escaping path is never a file-read oracle.
    pub(crate) fn member_digest(
        &self,
        relative: &str,
        expires: Instant,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<RuntimeMemberDigest, String> {
        let mut verify = Verification::new(expires.min(self.expires), &mut cancel);
        self.member_digest_with(relative, &mut verify)
    }
    fn member_digest_with(
        &self,
        relative: &str,
        verify: &mut Verification<'_>,
    ) -> Result<RuntimeMemberDigest, String> {
        verify.checkpoint()?;
        // Do not rescan other runtime members for each lookup. Final admission
        // must still revalidate the entire receipt before selection is consumed.
        let file = self.selection.member_path(relative, verify)?;
        self.check_ancestors(verify)?;
        let mut directory = file.parent().ok_or("Runtime member has no parent")?;
        loop {
            let expected = self
                .directories
                .get(directory)
                .ok_or("Member ancestry unavailable")?;
            if MemberMetadata::read(directory, true, verify)? != *expected {
                return Err("Admitted generation directory changed".into());
            }
            if directory == self.selection.root() {
                break;
            }
            directory = directory.parent().ok_or("Member escaped generation")?;
        }
        if MemberMetadata::read(&file, false, verify)?
            != *self.files.get(&file).ok_or("Member identity unavailable")?
        {
            return Err("Admitted generation member changed".into());
        }
        verify.checkpoint()?;
        Ok(RuntimeMemberDigest {
            sha256: self.selection.members()[relative].clone(),
            metadata: self
                .files
                .get(&file)
                .ok_or("Member identity unavailable")?
                .clone(),
        })
    }

    fn check_ancestors(&self, verify: &mut Verification<'_>) -> Result<(), String> {
        verify.checkpoint()?;
        for (path, expected) in &self.ancestors {
            let current = MemberMetadata::read(path, true, verify)?;
            // mtime/ctime, size and nlink describe sibling inventory and are not
            // dependencies of this exact generation. Type is checked by read.
            if current.dev != expected.dev
                || current.ino != expected.ino
                || current.mode != expected.mode
                || current.uid != expected.uid
                || current.gid != expected.gid
            {
                return Err("Admitted generation ancestor changed".into());
            }
        }
        verify.checkpoint()
    }

    fn check_identities(&self, verify: &mut Verification<'_>) -> Result<(), String> {
        verify.checkpoint()?;
        self.check_ancestors(verify)?;
        for (path, expected) in &self.directories {
            if MemberMetadata::read(path, true, verify)? != *expected {
                return Err("Admitted generation directory changed".into());
            }
        }
        for (path, expected) in &self.files {
            if MemberMetadata::read(path, false, verify)? != *expected {
                return Err("Admitted generation member changed".into());
            }
        }
        verify.checkpoint()
    }

    /// Rechecks this same generation, never the current pointer. Replacement is
    /// refusal, even when replacement bytes happen to match the original hash.
    pub(crate) fn revalidate(
        &self,
        expires: Instant,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut verify = Verification::new(expires.min(self.expires), &mut cancel);
        self.revalidate_with(&mut verify)
    }
    fn revalidate_with(&self, verify: &mut Verification<'_>) -> Result<(), String> {
        self.check_identities(verify)?;
        self.selection.revalidate(verify)?;
        self.check_identities(verify)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn expires() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }
    use sha2::{Digest, Sha256};
    use std::{
        os::unix::fs::{PermissionsExt, symlink},
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        home: PathBuf,
        root: PathBuf,
        config: Config,
        native: PathBuf,
    }
    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    impl Fixture {
        fn new() -> Self {
            Self::with_engine(b"engine\n")
        }
        fn with_engine(engine_bytes: &[u8]) -> Self {
            let base = std::env::var_os("CAWS_NATIVE_GENERATION_TEST_ARTIFACTS")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            assert!(base.is_absolute(), "fixture artifact root must be absolute");
            fs::create_dir_all(&base).unwrap();
            let home = base.join(format!(
                "caws-generation-receipt-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&home).unwrap();
            fs::create_dir_all(home.join("lib/runtimes")).unwrap();
            fs::create_dir(home.join("state")).unwrap();
            let stage = home.join("lib/runtimes/stage");
            fs::create_dir_all(stage.join("native")).unwrap();
            let entry = serde_json::json!({
                "schema":"caws.runtime.native-entry.v1", "nativeExecutable":"native/caws-native",
                "nodeExecutable":"native/node", "engineEntry":"engine.js", "describeEntry":"describe.js", "timeoutMs":1000
            });
            let mut bodies = BTreeMap::from([
                ("launcher.py".to_owned(), b"legacy identity\n".to_vec()),
                ("native/caws-native".to_owned(), b"native image\n".to_vec()),
                (
                    "native/caws-hook-native".to_owned(),
                    b"installed image\n".to_vec(),
                ),
                ("native/node".to_owned(), b"node image\n".to_vec()),
                ("engine.js".to_owned(), engine_bytes.to_vec()),
                ("describe.js".to_owned(), b"describe\n".to_vec()),
                (
                    "native-entry.json".to_owned(),
                    serde_json::to_vec(&entry).unwrap(),
                ),
            ]);
            let mut modes: BTreeMap<String, u32> = bodies
                .keys()
                .map(|name| {
                    (
                        name.clone(),
                        if name.starts_with("native/") {
                            0o755
                        } else {
                            0o644
                        },
                    )
                })
                .collect();
            modes.insert("native-modes.json".into(), 0o644);
            bodies.insert(
                "native-modes.json".into(),
                serde_json::to_vec(&modes).unwrap(),
            );
            let mut manifest = BTreeMap::new();
            for (name, bytes) in bodies {
                fs::write(stage.join(&name), &bytes).unwrap();
                fs::set_permissions(stage.join(&name), fs::Permissions::from_mode(modes[&name]))
                    .unwrap();
                manifest.insert(name, hash(&bytes));
            }
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let digest = hash(&bytes);
            fs::write(stage.join("manifest.json"), bytes).unwrap();
            fs::set_permissions(
                stage.join("manifest.json"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap();
            let root = home.join("lib/runtimes").join(&digest);
            fs::rename(stage, &root).unwrap();
            fs::write(
                home.join("state/adapter-runtime.json"),
                serde_json::to_vec(&serde_json::json!({"version":1,"digest":digest})).unwrap(),
            )
            .unwrap();
            let native = root.join("native/caws-native");
            let config = Config {
                engine: root.join("engine.js"),
                node: root.join("native/node"),
                surface: "opencode".into(),
                event: "stop".into(),
                configuration: "system".into(),
                digest,
                timeout: Duration::from_millis(1000),
            };
            let fixture = Self {
                home,
                root,
                config,
                native,
            };
            fixture.record("fixture", serde_json::json!({"schema":"caws.native.generation.fixture.v1", "home":fixture.home, "root":fixture.root, "digest":fixture.config.digest, "synthetic":true}));
            fixture
        }
        fn record(&self, label: &str, value: serde_json::Value) {
            if std::env::var_os("CAWS_NATIVE_GENERATION_TEST_ARTIFACTS").is_some() {
                fs::write(
                    self.home.join(format!("{label}.json")),
                    serde_json::to_vec_pretty(&value).unwrap(),
                )
                .unwrap();
            }
        }
        fn capture(&self) -> Result<GenerationReceipt, String> {
            self.capture_as(&self.native)
        }
        fn capture_as(&self, native: &Path) -> Result<GenerationReceipt, String> {
            let mut cancel = || Ok(());
            let mut verify = Verification::new(expires(), &mut cancel);
            GenerationReceipt::capture_at(&self.home, &self.config, native, &mut verify)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if std::env::var_os("CAWS_NATIVE_GENERATION_TEST_ARTIFACTS").is_some() {
                let result = serde_json::json!({"schema":"caws.native.generation.fixture-result.v1", "synthetic":true, "completedWithoutPanic":!std::thread::panicking(), "home":self.home, "root":self.root, "digest":self.config.digest});
                if let Err(error) = fs::write(
                    self.home.join("result.json"),
                    serde_json::to_vec_pretty(&result).unwrap(),
                ) {
                    if !std::thread::panicking() {
                        panic!("generation fixture result write failed: {error}");
                    }
                    eprintln!("generation fixture result write failed while unwinding: {error}");
                }
                eprintln!(
                    "retained native generation fixture: {}",
                    self.home.display()
                );
            } else {
                let _ = fs::remove_dir_all(&self.home);
            }
        }
    }

    #[test]
    fn exact_verified_direct_invocation_returns_member_digest_without_body() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        assert_eq!(receipt.digest(), f.config.digest);
        let observed = receipt
            .member_digest("native/node", expires(), || Ok(()))
            .unwrap();
        assert_eq!(observed.sha256, hash(b"node image\n"));
        assert_eq!(observed.metadata.size, 11);
        assert_eq!(observed.metadata.mode & 0o7777, 0o755);
        assert_eq!(observed.metadata.nlink, 1);
        receipt.revalidate(expires(), || Ok(())).unwrap();
    }
    #[test]
    fn production_capture_derives_the_native_identity_internally() {
        let f = Fixture::new();
        // This test executable is not the fixture's installed native member.
        // The public native API has no parameter with which to override it.
        assert!(
            GenerationReceipt::capture(&f.home, &f.config, expires(), || Ok(()))
                .unwrap_err_text()
                .contains("Invocation paths differ")
        );
    }
    #[test]
    fn spoofed_engine_node_native_or_digest_cannot_admit() {
        let mut f = Fixture::new();
        let engine = f.config.engine.clone();
        f.config.engine = f.root.join("describe.js");
        assert!(
            f.capture()
                .unwrap_err_text()
                .contains("Invocation paths differ")
        );
        f.config.engine = engine;
        let node = f.config.node.clone();
        f.config.node = f.native.clone();
        assert!(
            f.capture()
                .unwrap_err_text()
                .contains("Invocation paths differ")
        );
        f.config.node = node;
        assert!(
            f.capture_as(&f.root.join("native/caws-hook-native"))
                .unwrap_err_text()
                .contains("Invocation paths differ")
        );
        f.config.digest = "../escape".into();
        assert!(
            f.capture()
                .unwrap_err_text()
                .contains("Invalid exact runtime generation")
        );
        f.config.digest = "0".repeat(64);
        assert!(f.capture().is_err());
    }
    // Avoid requiring Debug on the private receipt just to inspect refusals.
    trait ErrorText {
        fn unwrap_err_text(self) -> String;
    }
    impl ErrorText for Result<GenerationReceipt, String> {
        fn unwrap_err_text(self) -> String {
            match self {
                Err(e) => e,
                Ok(_) => panic!("unexpected admission"),
            }
        }
    }
    #[test]
    fn pointer_change_and_removal_do_not_retarget_or_invalidate_selected_generation() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        fs::write(f.home.join("state/adapter-runtime.json"), b"not a pointer").unwrap();
        receipt.revalidate(expires(), || Ok(())).unwrap();
        assert_eq!(f.capture().unwrap().digest(), f.config.digest);
        fs::remove_file(f.home.join("state/adapter-runtime.json")).unwrap();
        receipt.revalidate(expires(), || Ok(())).unwrap();
        assert_eq!(f.capture().unwrap().digest(), f.config.digest);
    }
    #[test]
    fn unrelated_generation_and_pointer_change_preserve_old_receipt() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        let sibling = f.home.join("lib/runtimes").join("b".repeat(64));
        fs::create_dir(&sibling).unwrap();
        fs::write(sibling.join("unrelated"), b"unrelated generation").unwrap();
        fs::write(
            f.home.join("state/adapter-runtime.json"),
            serde_json::to_vec(&serde_json::json!({"version":1,"digest":"b".repeat(64)})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            receipt
                .member_digest("native/node", expires(), || Ok(()))
                .unwrap()
                .sha256,
            hash(b"node image\n")
        );
        receipt.revalidate(expires(), || Ok(())).unwrap();
        assert_eq!(f.capture().unwrap().digest(), f.config.digest);
    }

    #[test]
    fn replacing_selected_generation_ancestor_refuses_unchanged_generation() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        let runtimes = f.home.join("lib/runtimes");
        let old = f.home.join("lib/old-runtimes");
        fs::rename(&runtimes, &old).unwrap();
        fs::create_dir(&runtimes).unwrap();
        // Preserve the selected generation's members and inode; only its
        // traversed runtimes ancestor is replaced.
        fs::rename(old.join(&f.config.digest), &f.root).unwrap();
        assert!(
            receipt
                .member_digest("native/node", expires(), || Ok(()))
                .unwrap_err()
                .contains("ancestor changed")
        );
        assert!(
            receipt
                .revalidate(expires(), || Ok(()))
                .unwrap_err()
                .contains("ancestor changed")
        );
    }

    #[test]
    fn changed_member_bytes_refuse_existing_and_new_receipts() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        fs::write(f.root.join("engine.js"), b"tampered").unwrap();
        // A member lookup checks only that member and its ancestry; unrelated
        // file mutation is caught by the mandatory final full revalidation.
        assert_eq!(
            receipt
                .member_digest("native/node", expires(), || Ok(()))
                .unwrap()
                .sha256,
            hash(b"node image\n")
        );
        assert!(receipt.revalidate(expires(), || Ok(())).is_err());
        assert!(
            f.capture()
                .unwrap_err_text()
                .contains("Runtime member integrity failure")
        );
    }
    #[test]
    fn identical_byte_file_replacement_is_refused() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        // Keep the old inode alive so the filesystem cannot immediately reuse it.
        let old = fs::File::open(f.root.join("engine.js")).unwrap();
        fs::remove_file(f.root.join("engine.js")).unwrap();
        fs::write(f.root.join("engine.js"), b"engine\n").unwrap();
        fs::set_permissions(f.root.join("engine.js"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            receipt
                .revalidate(expires(), || Ok(()))
                .unwrap_err()
                .contains("generation")
        );
        assert!(
            receipt
                .member_digest("engine.js", expires(), || Ok(()))
                .is_err()
        );
        drop(old);
    }
    #[test]
    fn changed_manifest_mode_symlink_and_extra_inventory_are_refused() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        fs::set_permissions(
            f.root.join("native/node"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(receipt.revalidate(expires(), || Ok(())).is_err());
        assert!(f.capture().is_err());
        fs::set_permissions(
            f.root.join("native/node"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(f.root.join("extra"), b"unlisted").unwrap();
        assert!(
            f.capture()
                .unwrap_err_text()
                .contains("Undeclared native runtime member")
        );
        fs::remove_file(f.root.join("extra")).unwrap();
        fs::remove_file(f.root.join("engine.js")).unwrap();
        symlink("describe.js", f.root.join("engine.js")).unwrap();
        assert!(f.capture().unwrap_err_text().contains("Refusing symlink"));
        fs::remove_file(f.root.join("engine.js")).unwrap();
        fs::write(f.root.join("engine.js"), b"engine\n").unwrap();
        fs::write(f.root.join("manifest.json"), b"{}").unwrap();
        assert!(f.capture().unwrap_err_text().contains("manifest integrity"));
    }
    #[test]
    fn only_admitted_members_are_digest_addressable() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        for name in [
            "../engine.js",
            "manifest.json",
            "/etc/passwd",
            "native/../engine.js",
            "missing",
        ] {
            assert!(
                receipt
                    .member_digest(name, expires(), || Ok(()))
                    .unwrap_err()
                    .contains("not admitted"),
                "{name}"
            );
        }
        assert_eq!(
            receipt
                .member_digest("engine.js", expires(), || Ok(()))
                .unwrap()
                .sha256,
            hash(b"engine\n")
        );
    }
    #[test]
    fn replaced_generation_directory_is_refused_even_with_identical_members() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        let old = f.home.join("lib/runtimes/old");
        fs::rename(&f.root, &old).unwrap();
        fs::create_dir(&f.root).unwrap();
        assert!(
            receipt
                .revalidate(expires(), || Ok(()))
                .unwrap_err()
                .contains("directory changed")
        );
    }

    #[test]
    fn original_deadline_and_cancellation_gate_every_receipt_api() {
        let f = Fixture::new();
        let past = Instant::now() - Duration::from_millis(1);
        let capture_error =
            GenerationReceipt::capture(&f.home.join("missing"), &f.config, past, || Ok(()))
                .unwrap_err_text();
        assert!(
            capture_error.contains("deadline expired"),
            "{capture_error}"
        );
        let receipt = f.capture().unwrap();
        assert!(
            receipt
                .member_digest("engine.js", past, || Ok(()))
                .unwrap_err()
                .contains("deadline expired")
        );
        assert!(
            receipt
                .revalidate(past, || Ok(()))
                .unwrap_err()
                .contains("deadline expired")
        );
        let refusal = || Err("test cancellation before IO".to_owned());
        assert_eq!(
            GenerationReceipt::capture(&f.home, &f.config, expires(), refusal).unwrap_err_text(),
            "test cancellation before IO"
        );
        assert_eq!(
            receipt
                .member_digest("engine.js", expires(), refusal)
                .unwrap_err(),
            "test cancellation before IO"
        );
        assert_eq!(
            receipt.revalidate(expires(), refusal).unwrap_err(),
            "test cancellation before IO"
        );
        // Positive control uses the same receipt after refused requests.
        receipt.revalidate(expires(), || Ok(())).unwrap();
        f.record("deadline-cancel", serde_json::json!({"captureError":capture_error,"expiredLookup":true,"expiredRevalidation":true,"cancelledAllApis":true,"positiveRevalidation":true}));
    }

    #[test]
    fn later_call_cannot_refresh_the_retained_original_expiry() {
        let f = Fixture::new();
        let mut receipt = f.capture().unwrap();
        // Private clock seam: expire the retained original budget without sleeping.
        receipt.expires = Instant::now() - Duration::from_millis(1);
        let lookup = receipt
            .member_digest("engine.js", expires(), || Ok(()))
            .unwrap_err();
        let revalidation = receipt.revalidate(expires(), || Ok(())).unwrap_err();
        assert!(lookup.contains("deadline expired"), "{lookup}");
        assert!(revalidation.contains("deadline expired"), "{revalidation}");
        f.record("retained-expiry", serde_json::json!({"lookupError":lookup,"revalidationError":revalidation,"laterSuppliedExpiryDidNotRefresh":true}));
    }

    #[test]
    fn hash_chunk_cancellation_stops_before_the_next_chunk() {
        use std::{
            cell::{Cell, RefCell},
            rc::Rc,
        };
        let f = Fixture::with_engine(&vec![b'x'; 2 * 65536 + 17]);
        let cancelled = Rc::new(Cell::new(false));
        let flag = cancelled.clone();
        let mut cancel = move || {
            if flag.get() {
                Err("test cancelled after first hash chunk".into())
            } else {
                Ok(())
            }
        };
        let totals = Rc::new(RefCell::new(Vec::new()));
        let observed = totals.clone();
        let flag = cancelled.clone();
        let target = f.root.join("engine.js");
        let mut verify = Verification::new(expires(), &mut cancel);
        verify.on_chunk = Some(Box::new(move |path, total| {
            if path == target {
                observed.borrow_mut().push(total);
                flag.set(true);
            }
        }));
        let error = GenerationReceipt::capture_at(&f.home, &f.config, &f.native, &mut verify)
            .unwrap_err_text();
        assert_eq!(error, "test cancelled after first hash chunk");
        assert_eq!(&*totals.borrow(), &[65536]);
        f.record("chunk-cancellation", serde_json::json!({"error":error,"observedBytes":*totals.borrow(),"initialBytes":2*65536+17}));
    }

    #[test]
    fn hash_chunk_expiry_uses_the_original_deadline() {
        use std::{cell::RefCell, rc::Rc};
        let f = Fixture::with_engine(&vec![b'x'; 2 * 65536 + 17]);
        let expires = Instant::now() + Duration::from_millis(250);
        let totals = Rc::new(RefCell::new(Vec::new()));
        let observed = totals.clone();
        let target = f.root.join("engine.js");
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expires, &mut cancel);
        verify.on_chunk = Some(Box::new(move |path, total| {
            if path == target {
                observed.borrow_mut().push(total);
                if let Some(remaining) = expires.checked_duration_since(Instant::now()) {
                    std::thread::sleep(remaining + Duration::from_millis(1));
                }
            }
        }));
        let error = GenerationReceipt::capture_at(&f.home, &f.config, &f.native, &mut verify)
            .unwrap_err_text();
        assert!(error.contains("deadline expired"), "{error}");
        assert_eq!(&*totals.borrow(), &[65536]);
        f.record("chunk-deadline", serde_json::json!({"error":error,"observedBytes":*totals.borrow(),"deadlineRefreshed":false}));
    }

    #[test]
    fn hash_refuses_growth_truncation_and_same_byte_replacement_during_read() {
        use std::{cell::RefCell, io::Write, rc::Rc};
        for mutation in ["growth", "truncation", "same-byte-replacement"] {
            let bytes = vec![b'x'; 2 * 65536 + 17];
            let f = Fixture::with_engine(&bytes);
            let target = f.root.join("engine.js");
            let replacement = f.home.join("prepared-replacement");
            fs::write(&replacement, &bytes).unwrap();
            fs::set_permissions(&replacement, fs::Permissions::from_mode(0o644)).unwrap();
            let totals = Rc::new(RefCell::new(Vec::new()));
            let observed = totals.clone();
            let mut cancel = || Ok(());
            let mut verify = Verification::new(expires(), &mut cancel);
            let mut changed = false;
            verify.on_chunk = Some(Box::new(move |path, total| {
                if path == target {
                    observed.borrow_mut().push(total);
                    if !changed {
                        changed = true;
                        match mutation {
                            "growth" => fs::OpenOptions::new()
                                .append(true)
                                .open(&target)
                                .unwrap()
                                .write_all(b"growth")
                                .unwrap(),
                            "truncation" => fs::OpenOptions::new()
                                .write(true)
                                .open(&target)
                                .unwrap()
                                .set_len(1)
                                .unwrap(),
                            _ => fs::rename(&replacement, &target).unwrap(),
                        }
                    }
                }
            }));
            let error = GenerationReceipt::capture_at(&f.home, &f.config, &f.native, &mut verify)
                .unwrap_err_text();
            if mutation == "truncation" {
                assert!(error.contains("truncated"), "{error}");
            } else {
                assert!(error.contains("identity changed"), "{error}");
            }
            assert!(!totals.borrow().is_empty());
            assert!(
                totals
                    .borrow()
                    .iter()
                    .all(|total| *total <= bytes.len() as u64)
            );
            if mutation != "truncation" {
                assert_eq!(totals.borrow().last(), Some(&(bytes.len() as u64)));
            }
            f.record("during-read-refusal", serde_json::json!({"mutation":mutation,"error":error,"observedBytes":*totals.borrow(),"initialBytes":bytes.len()}));
        }
    }

    #[test]
    fn undeclared_directory_is_refused_before_descent() {
        let f = Fixture::new();
        fs::create_dir_all(f.root.join("undeclared/deeper/deepest")).unwrap();
        let error = f.capture().unwrap_err_text();
        assert_eq!(error, "Undeclared native runtime directory: undeclared");
        f.record("undeclared-directory", serde_json::json!({"error":error,"firstUndeclaredComponent":"undeclared","descendantDepth":3}));
    }
}
