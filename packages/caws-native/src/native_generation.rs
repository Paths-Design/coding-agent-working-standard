//! Request-owned evidence for one exact installed generation.
//!
//! This reuses installed-entry verification and the cooperative engine/CLI TCB.
//! current_exe identifies the configured native pathname and its verified on-disk
//! member, not a sealed in-memory executable or proof of launcher provenance.
//! Correct direct invocation of a verified installed generation is admissible.
//! No policy decision, project authority, SQL capability, or frame is issued here.
use crate::{
    cli::Config,
    installed_generation::{
        MemberMetadata, Selection, Verification, VerificationDiagnostics, VerificationPhase,
        VerificationSnapshot,
    },
};
use std::{
    cell::Cell,
    collections::BTreeMap,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, Instant},
};

/// Request-local diagnostic accumulation. Never consulted by verification or
/// authority. A shared handle preserves failed-capture measurements after the
/// partial receipt is dropped; it is not a cache or a process-global counter.
#[derive(Clone, Default)]
pub(crate) struct CheckTimings(Rc<Cell<CheckTimingTotals>>, VerificationDiagnostics);
#[derive(Clone, Copy, Default)]
struct CheckTimingTotals {
    count: u64,
    elapsed: Duration,
}
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckTimingSnapshot {
    pub count: u64,
    pub elapsed_micros: u64,
}
impl CheckTimings {
    pub(crate) fn verification_snapshot(&self) -> VerificationSnapshot {
        self.1.snapshot()
    }
    pub(crate) fn measure<R>(&self, operation: impl FnOnce() -> R) -> R {
        let started = Instant::now();
        let result = operation();
        // Record after either successful or refused completion; the operation's
        // exact result is returned unchanged. Panics are outside CLI outcomes.
        self.record(started.elapsed());
        result
    }
    fn record(&self, elapsed: Duration) {
        let previous = self.0.get();
        self.0.set(CheckTimingTotals {
            count: previous.count.saturating_add(1),
            elapsed: previous.elapsed.saturating_add(elapsed),
        });
    }
    pub(crate) fn snapshot(&self) -> CheckTimingSnapshot {
        let totals = self.0.get();
        CheckTimingSnapshot {
            count: totals.count,
            elapsed_micros: totals.elapsed.as_micros().min(u64::MAX as u128) as u64,
        }
    }
}

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
    receipt_revalidation_timings: CheckTimings,
    selection: Selection,
    expires: Instant,
    files: BTreeMap<PathBuf, MemberMetadata>,
    directories: BTreeMap<PathBuf, MemberMetadata>,
    ancestors: BTreeMap<PathBuf, MemberMetadata>,
}
impl GenerationReceipt {
    #[cfg(test)]
    pub(crate) fn capture(
        home: &Path,
        config: &Config,
        expires: Instant,
        cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        Self::capture_with_diagnostics(home, config, expires, CheckTimings::default(), cancel)
    }

    pub(crate) fn capture_with_diagnostics(
        home: &Path,
        config: &Config,
        expires: Instant,
        receipt_revalidation_timings: CheckTimings,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        let mut verify = Verification::new(expires, &mut cancel);
        verify.checkpoint()?;
        let running = std::env::current_exe();
        verify.checkpoint()?;
        Self::capture_at_with_diagnostics(
            home,
            config,
            &running.map_err(|e| e.to_string())?,
            &mut verify,
            receipt_revalidation_timings,
        )
    }

    // The image path and chunk observer are private test seams only.
    #[cfg(test)]
    fn capture_at(
        home: &Path,
        config: &Config,
        running_native: &Path,
        verify: &mut Verification<'_>,
    ) -> Result<Self, String> {
        Self::capture_at_with_diagnostics(
            home,
            config,
            running_native,
            verify,
            CheckTimings::default(),
        )
    }

    fn capture_at_with_diagnostics(
        home: &Path,
        config: &Config,
        running_native: &Path,
        verify: &mut Verification<'_>,
        receipt_revalidation_timings: CheckTimings,
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
            receipt_revalidation_timings,
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

    /// Exact admitted root, independent of the active runtime pointer.
    pub(crate) fn root(&self) -> &Path {
        self.selection.root()
    }

    /// The caller's native custodian executor comes from the already admitted
    /// NativeEntry member. No engine frame, PATH or current pointer selects it.
    pub(crate) fn selected_native_executor(
        &self,
        expires: Instant,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<caws_native::invocation_project::SelectedExecutable, String> {
        let mut verify = Verification::new(expires.min(self.expires), &mut cancel);
        self.check_identities(&mut verify)?;
        let entry = self
            .selection
            .native_entry()
            .ok_or("Generation has no native executor")?;
        let (path, _, _) = self.selection.native_paths(&mut verify)?;
        let member = self.member_digest_with(&entry.native_executable, &mut verify)?;
        verify.checkpoint()?;
        let physical_path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        verify.checkpoint()?;
        self.check_identities(&mut verify)?;
        let m = member.metadata;
        Ok(caws_native::invocation_project::SelectedExecutable {
            path,
            physical_path,
            sha256: member.sha256,
            identity: caws_native::invocation_project::ExecutableIdentity {
                device: m.dev,
                inode: m.ino,
                bytes: m.size,
                mode: m.mode,
                modified_seconds: m.mtime,
                modified_nanoseconds: m.mtime_nsec,
                changed_seconds: m.ctime,
                changed_nanoseconds: m.ctime_nsec,
            },
        })
    }

    pub(crate) fn digest(&self) -> &str {
        &self.selection.inspected_digest
    }

    /// Return only the already verified original manifest. This is snapshot
    /// data, not a freshness/selection/profile grant. The observation owner must
    /// keep its existing full-generation construction/seal/revalidation checks.
    /// Only the exact retained root spelling selects this snapshot: aliases and
    /// current-pointer/sibling generations cannot query it.
    pub(crate) fn manifest_summary(
        &self,
        exact_root: &Path,
        expires: Instant,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<BTreeMap<String, String>, String> {
        let mut verify = Verification::new(expires.min(self.expires), &mut cancel);
        self.manifest_summary_with(exact_root, &mut verify)
    }
    fn manifest_summary_with(
        &self,
        exact_root: &Path,
        verify: &mut Verification<'_>,
    ) -> Result<BTreeMap<String, String>, String> {
        verify.checkpoint()?;
        if exact_root.as_os_str() != self.root().as_os_str() {
            return Err("Runtime generation summary requires the exact original root".into());
        }
        self.check_summary_bindings(verify)?;
        // The input manifest was byte-bounded and completely verified at native
        // admission. Check the original budget for every copied entry; do not
        // hash members or enumerate the whole inventory for each summary read.
        let mut manifest = BTreeMap::new();
        for (relative, digest) in self.selection.members() {
            verify.checkpoint()?;
            manifest.insert(relative.clone(), digest.clone());
        }
        self.check_summary_bindings(verify)?;
        verify.checkpoint()?;
        Ok(manifest)
    }
    fn check_summary_bindings(&self, verify: &mut Verification<'_>) -> Result<(), String> {
        self.check_ancestors(verify)?;
        let root = self.root();
        if MemberMetadata::read(root, true, verify)?
            != *self
                .directories
                .get(root)
                .ok_or("Generation root identity unavailable")?
        {
            return Err("Admitted generation directory changed".into());
        }
        let manifest = root.join("manifest.json");
        if MemberMetadata::read(&manifest, false, verify)?
            != *self
                .files
                .get(&manifest)
                .ok_or("Manifest identity unavailable")?
        {
            return Err("Admitted generation manifest changed".into());
        }
        verify.checkpoint()
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

    /// Bounded no-follow bytes from an already authenticated member. Reuses
    /// installed metadata I/O and checks both retained identity and parsed-byte
    /// digest, closing the manifest-hash-to-parse replacement window.
    pub(crate) fn member_bytes(
        &self,
        relative: &str,
        maximum: u64,
        expires: Instant,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Vec<u8>, String> {
        use sha2::{Digest, Sha256};
        let mut verify = Verification::new(expires.min(self.expires), &mut cancel);
        let expected = self.member_digest_with(relative, &mut verify)?;
        let bytes = crate::installed_generation::read_metadata(
            self.root(),
            relative,
            maximum,
            &mut verify,
        )?;
        let mut hash = Sha256::new();
        for chunk in bytes.chunks(64 * 1024) {
            verify.checkpoint()?;
            hash.update(chunk);
        }
        if format!("{:x}", hash.finalize()) != expected.sha256 {
            return Err("Authenticated runtime member bytes changed".into());
        }
        if self.member_digest_with(relative, &mut verify)? != expected {
            return Err("Authenticated runtime member identity changed".into());
        }
        verify.checkpoint()?;
        Ok(bytes)
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
        self.receipt_revalidation_timings.measure(|| {
            verify.diagnosed(&self.receipt_revalidation_timings.1, |verify| {
                verify.phase(VerificationPhase::IdentityBefore, |verify| {
                    self.check_identities(verify)
                })?;
                verify.phase(VerificationPhase::SelectionVerification, |verify| {
                    self.selection.revalidate(verify)
                })?;
                verify.phase(VerificationPhase::IdentityAfter, |verify| {
                    self.check_identities(verify)
                })
            })
        })
    }
}

/// Test-only adapter to the existing verified generation fixture. It captures
/// through the original verifier seam; no receipt fields are fabricated.
#[cfg(all(test, feature = "sqlite-store"))]
pub(crate) fn with_sqlite_identity_generation_fixture<R>(
    action: impl FnOnce(&GenerationReceipt, &Path, &Path) -> R,
) -> R {
    tests::with_sqlite_identity_generation_fixture(action)
}

#[cfg(test)]
pub(crate) fn with_selection_generation_fixture<R>(
    action: impl FnOnce(&GenerationReceipt, &Path, &Path) -> R,
) -> R {
    tests::with_selection_generation_fixture(action)
}

/// Fixed additive large-inventory fixture, captured through the same original
/// verifier seam. This cannot construct or override a production receipt.
#[cfg(test)]
pub(crate) fn with_large_selection_generation_fixture<R>(
    action: impl FnOnce(&GenerationReceipt, &Path, &Path) -> R,
) -> R {
    tests::with_large_selection_generation_fixture(action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn authenticated_member_bytes_preserve_bound_identity_and_original_expiry() {
        let fixture = Fixture::new();
        let mut generation = fixture.capture().unwrap();
        assert_eq!(
            generation
                .member_bytes("engine.js", 1024, expires(), || Ok(()))
                .unwrap(),
            b"engine\n"
        );
        assert!(
            generation
                .member_bytes("engine.js", 1, expires(), || Ok(()))
                .unwrap_err()
                .contains("bound")
        );
        assert!(
            generation
                .member_bytes("not-admitted.json", 1024, expires(), || Ok(()))
                .is_err()
        );
        assert_eq!(
            generation
                .member_bytes("engine.js", 1024, expires(), || Err(
                    "cancel exact member".into()
                ))
                .unwrap_err(),
            "cancel exact member"
        );
        generation.expires = Instant::now() - Duration::from_secs(1);
        assert!(
            generation
                .member_bytes(
                    "engine.js",
                    1024,
                    Instant::now() + Duration::from_secs(3600),
                    || Ok(())
                )
                .unwrap_err()
                .contains("deadline")
        );
        let generation = fixture.capture().unwrap();
        let retired = fixture.root.join("retired-engine");
        fs::rename(fixture.root.join("engine.js"), &retired).unwrap();
        fs::write(fixture.root.join("engine.js"), b"engine\n").unwrap();
        assert!(
            generation
                .member_bytes("engine.js", 1024, expires(), || Ok(()))
                .unwrap_err()
                .contains("changed")
        );
        fixture.record("authenticated-member-refusals", serde_json::json!({"bound":1,"sameByteReplacementRefused":true,"originalExpiryRetained":true,"syntheticGeneration":true}));
    }

    #[test]
    fn diagnostic_timings_accumulate_submicroseconds_and_preserve_refusal_results() {
        let timings = CheckTimings::default();
        let shared = timings.clone();
        timings.record(Duration::from_nanos(500));
        shared.record(Duration::from_nanos(500));
        assert_eq!(timings.snapshot().count, 2);
        assert_eq!(timings.snapshot().elapsed_micros, 1);
        let result = shared.measure(|| Err::<(), _>("original diagnostic refusal"));
        assert_eq!(result, Err("original diagnostic refusal"));
        assert_eq!(
            timings.snapshot().count,
            3,
            "errors count on the same request-owned handle"
        );
        assert!(timings.snapshot().elapsed_micros >= 1);
    }
    #[test]
    fn receipt_diagnostic_timings_count_success_and_cancelled_revalidations_only() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        let initial = receipt.receipt_revalidation_timings.snapshot();
        assert_eq!(
            initial.count, 1,
            "capture's receipt revalidation counts; initial Selection read does not"
        );
        receipt.revalidate(expires(), || Ok(())).unwrap();
        assert_eq!(receipt.receipt_revalidation_timings.snapshot().count, 2);
        assert_eq!(
            receipt.revalidate(expires(), || Err("exact cancellation".into())),
            Err("exact cancellation".into())
        );
        let after = receipt.receipt_revalidation_timings.snapshot();
        assert_eq!(after.count, 3);
        assert!(after.elapsed_micros >= initial.elapsed_micros);
        receipt
            .member_digest("engine.js", expires(), || Ok(()))
            .unwrap();
        assert_eq!(
            receipt.receipt_revalidation_timings.snapshot().count,
            3,
            "member lookup is outside this precisely named counter"
        );
    }
    fn member_parent_metadata(path: &Path, directory: bool) -> MemberMetadata {
        let mut cancel = || Ok(());
        MemberMetadata::read(
            path,
            directory,
            &mut Verification::new(expires(), &mut cancel),
        )
        .unwrap()
    }
    fn member_parent_metadata_json(value: &MemberMetadata) -> serde_json::Value {
        serde_json::json!({"dev":value.dev,"ino":value.ino,"size":value.size,"mode":value.mode,
            "mtime":value.mtime,"mtimeNs":value.mtime_nsec,"ctime":value.ctime,"ctimeNs":value.ctime_nsec})
    }
    fn member_parent_fd_closed(verify: &Verification<'_>) {
        let fd = verify
            .last_parent_fd
            .expect("the actual parent group must have opened");
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EBADF),
            "the original group FD must be closed, not merely unreachable from a path"
        );
    }
    #[test]
    fn member_parent_standalone_selection_hashes_every_byte_and_reuses_only_storage() {
        let bytes = vec![b'x'; 2 * 65536 + 17];
        let f = Fixture::with_engine(&bytes);
        let diagnostics = VerificationDiagnostics::default();
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expires(), &mut cancel);
        assert_eq!(verify.scratch_address(), None);
        let selection = verify
            .diagnosed(&diagnostics, |verify| {
                Selection::read_generation(&f.home, &f.config.digest, verify)
            })
            .unwrap();
        assert_eq!(selection.inspected_digest, f.config.digest);
        assert!(selection.native_entry().is_some());
        assert_eq!(
            verify.scratch_allocations, 1,
            "one real allocation across manifest, member and parser reads"
        );
        let address = verify.scratch_address().unwrap();
        member_parent_fd_closed(&verify);
        let phases = diagnostics.snapshot();
        assert_eq!(phases.member_hashing.count, 1);
        assert_eq!(phases.member_hashing.failures, 0);
        assert_eq!(phases.inventory_modes.count, 1);
        assert_eq!(phases.inventory_modes.failures, 0);
        let expected = selection
            .members()
            .keys()
            .map(|name| fs::metadata(f.root.join(name)).unwrap().len())
            .sum::<u64>()
            + fs::metadata(f.root.join("native-modes.json"))
                .unwrap()
                .len()
            + fs::metadata(f.root.join("native-entry.json"))
                .unwrap()
                .len();
        assert_eq!(phases.bytes_hashed, expected);
        assert_eq!(phases.hash_calls, selection.members().len() as u64 + 2);
        let large = crate::installed_generation::read_metadata(
            &f.root,
            "engine.js",
            bytes.len() as u64,
            &mut verify,
        )
        .unwrap();
        assert_eq!(large, bytes);
        let small =
            crate::installed_generation::read_metadata(&f.root, "describe.js", 1024, &mut verify)
                .unwrap();
        assert_eq!(
            small, b"describe\n",
            "reused storage must not append the previous large file's tail"
        );
        assert_eq!(verify.scratch_address(), Some(address));
        assert_eq!(verify.scratch_allocations, 1);
        f.record("member-parent-standalone", serde_json::json!({"phases":phases,"expectedHashedBytes":expected,
            "scratchAllocations":verify.scratch_allocations,"parentFdClosed":true,"generationReceiptUsed":false,"syntheticGeneration":true}));
    }
    #[test]
    fn member_parent_final_group_refuses_replaced_then_restored_ancestor_without_receipt() {
        let f = Fixture::new();
        let target = f.root.join("native/node");
        let held = f.home.join("held-root");
        let leaf_before = member_parent_metadata(&target, false);
        let directory_before = member_parent_metadata(&f.root, true);
        let changed = Cell::new(false);
        let diagnostics = VerificationDiagnostics::default();
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expires(), &mut cancel);
        verify.on_chunk = Some(Box::new(|path, _| {
            if path == target && !changed.replace(true) {
                fs::rename(&f.root, &held).unwrap();
                fs::create_dir(&f.root).unwrap();
                fs::remove_dir(&f.root).unwrap();
                fs::rename(&held, &f.root).unwrap();
                assert_eq!(
                    member_parent_metadata(&target, false),
                    leaf_before,
                    "the leaf identity check alone must not distinguish this attack"
                );
                assert_ne!(
                    member_parent_metadata(&f.root, true),
                    directory_before,
                    "the filesystem must retain an observable traversal mutation"
                );
            }
        }));
        let error = verify
            .diagnosed(&diagnostics, |verify| {
                Selection::read_generation(&f.home, &f.config.digest, verify)
            })
            .unwrap_err();
        assert!(
            changed.get(),
            "mutation must execute inside the final group"
        );
        assert_eq!(
            error,
            "Runtime hashing traversal changed before group closed"
        );
        let phases = diagnostics.snapshot();
        assert_eq!(phases.member_hashing.failures, 1);
        assert_eq!(
            phases.inventory_modes.count, 0,
            "no successful group may escape to inventory"
        );
        let manifest: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(f.root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(
            phases.hash_calls,
            manifest.len() as u64,
            "even the final member completed hashing before closing refusal"
        );
        assert_eq!(
            phases.bytes_hashed,
            manifest
                .keys()
                .map(|name| fs::metadata(f.root.join(name)).unwrap().len())
                .sum::<u64>()
        );
        member_parent_fd_closed(&verify);
        f.record("member-parent-final-restored-ancestor", serde_json::json!({"error":error,"phases":phases,
            "directoryBefore":member_parent_metadata_json(&directory_before),"directoryAfter":member_parent_metadata_json(&member_parent_metadata(&f.root,true)),
            "sameLeafIdentity":member_parent_metadata_json(&leaf_before),"generationReceiptUsed":false,"parentFdClosed":true,"syntheticGeneration":true}));
    }
    #[test]
    fn member_parent_transition_refuses_restored_traversal_before_next_group() {
        let f = Fixture::new();
        let held = f.home.join("held-root");
        let target = f.root.join("engine.js");
        let changed = Cell::new(false);
        let next_group_read = Cell::new(false);
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expires(), &mut cancel);
        verify.on_chunk = Some(Box::new(|path, _| {
            if path.starts_with(f.root.join("native")) {
                next_group_read.set(true);
            }
            if path == target && !changed.replace(true) {
                let before = member_parent_metadata(&f.root, true);
                fs::rename(&f.root, &held).unwrap();
                fs::create_dir(&f.root).unwrap();
                fs::remove_dir(&f.root).unwrap();
                fs::rename(&held, &f.root).unwrap();
                assert_ne!(member_parent_metadata(&f.root, true), before);
            }
        }));
        let error = Selection::read_generation(&f.home, &f.config.digest, &mut verify).unwrap_err();
        assert!(changed.get());
        assert_eq!(
            error,
            "Runtime hashing directory changed before group closed"
        );
        assert!(
            !next_group_read.get(),
            "the changed old group must close before the next parent can be opened/read"
        );
        member_parent_fd_closed(&verify);
        f.record("member-parent-transition", serde_json::json!({"error":error,"nextGroupRead":next_group_read.get(),"parentFdClosed":true,"generationReceiptUsed":false,"syntheticGeneration":true}));
    }
    #[test]
    fn member_parent_refuses_parent_symlink_and_type_change_during_group() {
        for mutation in ["symlink", "file"] {
            let f = Fixture::new();
            let parent = f.root.join("native");
            let held = f.home.join("held-native");
            let target = parent.join("node");
            let changed = Cell::new(false);
            let diagnostics = VerificationDiagnostics::default();
            let mut cancel = || Ok(());
            let mut verify = Verification::new(expires(), &mut cancel);
            verify.on_chunk = Some(Box::new(|path, _| {
                if path == target && !changed.replace(true) {
                    fs::rename(&parent, &held).unwrap();
                    if mutation == "symlink" {
                        symlink(&held, &parent).unwrap();
                    } else {
                        fs::write(&parent, b"not a directory").unwrap();
                    }
                }
            }));
            let error = verify
                .diagnosed(&diagnostics, |verify| {
                    Selection::read_generation(&f.home, &f.config.digest, verify)
                })
                .unwrap_err();
            assert!(changed.get());
            if mutation == "symlink" {
                assert!(
                    error == "Runtime hashing directory changed before group closed"
                        || error == "Runtime hashing traversal changed before group closed"
                        || error.starts_with("Refusing symlink:"),
                    "{error}"
                );
            } else {
                assert!(error.starts_with("Generation path unavailable"), "{error}");
            }
            let phases = diagnostics.snapshot();
            assert_eq!(phases.member_hashing.failures, 1);
            assert_eq!(
                phases.inventory_modes.count, 0,
                "refusal must occur in the group, not be rescued by later inventory"
            );
            member_parent_fd_closed(&verify);
            f.record("member-parent-kind-change",serde_json::json!({"mutation":mutation,"error":error,"phases":phases,"parentFdClosed":true,"generationReceiptUsed":false,"syntheticGeneration":true}));
        }
    }
    #[test]
    fn member_parent_mid_group_cancellation_and_original_expiry_close_the_fd() {
        for kind in ["cancel", "expiry"] {
            let f = Fixture::new();
            let target = f.root.join("native/caws-hook-native");
            let entered = Cell::new(false);
            let stop = Cell::new(false);
            let original_expiry = Instant::now() + Duration::from_secs(1);
            let mut cancel = || {
                if stop.get() {
                    Err("original mid-group cancellation".into())
                } else {
                    Ok(())
                }
            };
            let mut verify = Verification::new(original_expiry, &mut cancel);
            verify.on_chunk = Some(Box::new(|path, _| {
                if path == target {
                    entered.set(true);
                    if kind == "cancel" {
                        stop.set(true);
                    } else {
                        while Instant::now() < original_expiry {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                    }
                }
            }));
            let error =
                Selection::read_generation(&f.home, &f.config.digest, &mut verify).unwrap_err();
            assert!(
                entered.get(),
                "must refuse after the real native parent was opened/read"
            );
            assert_eq!(verify.expires(), original_expiry);
            assert_eq!(
                error,
                if kind == "cancel" {
                    "original mid-group cancellation"
                } else {
                    "Runtime verification deadline expired"
                }
            );
            member_parent_fd_closed(&verify);
            f.record("member-parent-mid-group-refusal",serde_json::json!({"kind":kind,"error":error,"parentFdClosed":true,"enteredGroup":entered.get(),"originalExpiryUnchanged":true,"syntheticGeneration":true}));
        }
    }
    fn full_verification_hash_bytes(f: &Fixture, receipt: &GenerationReceipt) -> u64 {
        // Manifest bytes, every member, and the separately authenticated mode
        // parser input are all actually hashed once in a successful full pass.
        fs::metadata(f.root.join("manifest.json")).unwrap().len()
            + receipt
                .selection
                .members()
                .keys()
                .map(|name| fs::metadata(f.root.join(name)).unwrap().len())
                .sum::<u64>()
            + fs::metadata(f.root.join("native-modes.json"))
                .unwrap()
                .len()
    }
    #[test]
    fn verification_phase_diagnostics_count_hash_bytes_and_exclude_unscoped_work() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        let first = receipt.receipt_revalidation_timings.verification_snapshot();
        for phase in [
            first.identity_before,
            first.selection_verification,
            first.identity_after,
            first.member_hashing,
            first.inventory_modes,
        ] {
            assert_eq!(
                phase.count, 1,
                "only capture's closing receipt verification counts"
            );
            assert_eq!(phase.failures, 0);
        }
        let expected_bytes = full_verification_hash_bytes(&f, &receipt);
        let expected_hashes = receipt.selection.members().len() as u64 + 2;
        assert_eq!(first.hash_calls, expected_hashes);
        assert_eq!(first.bytes_hashed, expected_bytes);
        assert_eq!(
            first.fd_metadata_operations,
            2 * expected_hashes + 4,
            "each authenticated read checks both FD endpoints; the fixture's root/native parent groups each check their held FD twice"
        );
        assert!(first.path_metadata_operations > first.fd_metadata_operations);
        receipt
            .member_digest("engine.js", expires(), || Ok(()))
            .unwrap();
        receipt
            .member_bytes("engine.js", 1024, expires(), || Ok(()))
            .unwrap();
        assert_eq!(
            receipt.receipt_revalidation_timings.verification_snapshot(),
            first,
            "ordinary lookups and authenticated byte reads are not full receipt checks"
        );
        receipt.revalidate(expires(), || Ok(())).unwrap();
        let second = receipt.receipt_revalidation_timings.verification_snapshot();
        assert_eq!(second.identity_before.count, 2);
        assert_eq!(second.selection_verification.count, 2);
        assert_eq!(second.identity_after.count, 2);
        assert_eq!(second.member_hashing.count, 2);
        assert_eq!(second.inventory_modes.count, 2);
        assert_eq!(second.hash_calls, 2 * expected_hashes);
        assert_eq!(second.bytes_hashed, 2 * expected_bytes);
        assert_eq!(
            second.path_metadata_operations,
            2 * first.path_metadata_operations
        );
        assert_eq!(
            second.fd_metadata_operations,
            2 * first.fd_metadata_operations
        );
        f.record("verification-phase-success", serde_json::json!({"snapshot":second,"expectedBytesPerPass":expected_bytes,"initialLoadExcluded":true,"memberLookupsExcluded":true,"syntheticGeneration":true}));
    }
    #[test]
    fn verification_phase_diagnostics_count_failed_entry_and_restore_the_scope() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        let initial = receipt.receipt_revalidation_timings.verification_snapshot();
        let cancelled = Cell::new(true);
        let mut cancel = || {
            if cancelled.get() {
                Err("exact entry refusal".into())
            } else {
                Ok(())
            }
        };
        let mut verify = Verification::new(expires(), &mut cancel);
        assert_eq!(
            receipt.revalidate_with(&mut verify),
            Err("exact entry refusal".into())
        );
        let refused = receipt.receipt_revalidation_timings.verification_snapshot();
        assert_eq!(
            refused.identity_before.count,
            initial.identity_before.count + 1
        );
        assert_eq!(refused.identity_before.failures, 1);
        assert_eq!(
            refused.selection_verification,
            initial.selection_verification
        );
        assert_eq!(refused.identity_after, initial.identity_after);
        assert_eq!(refused.member_hashing, initial.member_hashing);
        assert_eq!(refused.inventory_modes, initial.inventory_modes);
        assert_eq!(
            refused.path_metadata_operations, initial.path_metadata_operations,
            "pre-call cancellation performed no metadata syscall"
        );
        assert_eq!(
            refused.fd_metadata_operations,
            initial.fd_metadata_operations
        );
        assert_eq!(refused.bytes_hashed, initial.bytes_hashed);
        cancelled.set(false);
        MemberMetadata::read(&f.root, true, &mut verify).unwrap();
        assert_eq!(
            receipt.receipt_revalidation_timings.verification_snapshot(),
            refused,
            "refusal restores unscoped verifier state"
        );
        let io_diagnostics = VerificationDiagnostics::default();
        verify.diagnosed(&io_diagnostics, |verify| {
            MemberMetadata::read(&f.root, true, verify).unwrap();
            assert!(
                MemberMetadata::read(&f.root.join("missing"), false, verify)
                    .unwrap_err()
                    .contains("Generation path unavailable")
            );
            cancelled.set(true);
            assert_eq!(
                MemberMetadata::read(&f.root, true, verify),
                Err("exact entry refusal".into())
            );
        });
        let io = io_diagnostics.snapshot();
        assert_eq!(
            io.path_metadata_operations, 2,
            "successful and failed syscalls count; pre-call cancellation does not"
        );
        assert_eq!(io.fd_metadata_operations, 0);
        assert_eq!(io.hash_calls, 0);
        assert_eq!(io.bytes_hashed, 0);
        f.record("verification-phase-entry-refusal", serde_json::json!({"snapshot":refused,"metadataControl":io,"error":"exact entry refusal","scopeRestored":true,"syntheticGeneration":true}));
    }
    #[test]
    fn verification_phase_diagnostics_count_inventory_refusal_after_complete_hashing() {
        let f = Fixture::new();
        let receipt = f.capture().unwrap();
        let initial = receipt.receipt_revalidation_timings.verification_snapshot();
        let expected_bytes = full_verification_hash_bytes(&f, &receipt);
        let last_member = f.root.join("native/node");
        assert_eq!(
            receipt.selection.members().keys().next_back().unwrap(),
            "native/node"
        );
        let changed = Cell::new(false);
        let launcher = f.root.join("launcher.py");
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expires(), &mut cancel);
        verify.on_chunk = Some(Box::new(|path, _| {
            if path == last_member {
                fs::set_permissions(&launcher, fs::Permissions::from_mode(0o600)).unwrap();
                changed.set(true);
            }
        }));
        let error = receipt.revalidate_with(&mut verify).unwrap_err();
        assert!(
            changed.get(),
            "mutation must happen after the opening identity sweep"
        );
        assert_eq!(error, "Native runtime mode mismatch: launcher.py");
        let refused = receipt.receipt_revalidation_timings.verification_snapshot();
        assert_eq!(
            refused.identity_before.count,
            initial.identity_before.count + 1
        );
        assert_eq!(refused.identity_before.failures, 0);
        assert_eq!(
            refused.selection_verification.count,
            initial.selection_verification.count + 1
        );
        assert_eq!(refused.selection_verification.failures, 1);
        assert_eq!(
            refused.member_hashing.count,
            initial.member_hashing.count + 1
        );
        assert_eq!(refused.member_hashing.failures, 0);
        assert_eq!(
            refused.inventory_modes.count,
            initial.inventory_modes.count + 1
        );
        assert_eq!(refused.inventory_modes.failures, 1);
        assert_eq!(
            refused.identity_after, initial.identity_after,
            "failed verification never reaches the closing identity sweep"
        );
        assert_eq!(refused.bytes_hashed - initial.bytes_hashed, expected_bytes);
        f.record("verification-phase-inventory-refusal", serde_json::json!({"snapshot":refused,"error":error,"expectedHashedBytesBeforeRefusal":expected_bytes,"syntheticGeneration":true}));
    }
    #[test]
    fn failed_capture_retains_its_receipt_revalidation_diagnostics_in_original_request() {
        let f = Fixture::new();
        let timings = CheckTimings::default();
        let cancelled = Rc::new(Cell::new(false));
        let flag = cancelled.clone();
        let mut cancel = move || {
            if flag.get() {
                Err("capture receipt revalidation refused".into())
            } else {
                Ok(())
            }
        };
        let reads = Rc::new(Cell::new(0));
        let observed = reads.clone();
        let target = f.root.join("engine.js");
        let mut verify = Verification::new(expires(), &mut cancel);
        verify.on_chunk = Some(Box::new(move |path, _| {
            if path == target {
                observed.set(observed.get() + 1);
                // First read belongs to Selection::read_generation. The second
                // is inside the receipt's own revalidate_with, before return.
                if observed.get() == 2 {
                    cancelled.set(true);
                }
            }
        }));
        let failure = GenerationReceipt::capture_at_with_diagnostics(
            &f.home,
            &f.config,
            &f.native,
            &mut verify,
            timings.clone(),
        )
        .err()
        .expect("the receipt's capture revalidation must refuse");
        assert_eq!(failure, "capture receipt revalidation refused");
        assert_eq!(reads.get(), 2);
        assert_eq!(
            timings.snapshot().count,
            1,
            "failed capture must not discard the request's measurement"
        );
        let phases = timings.verification_snapshot();
        assert_eq!(phases.identity_before.count, 1);
        assert_eq!(phases.identity_before.failures, 0);
        assert_eq!(phases.selection_verification.count, 1);
        assert_eq!(phases.selection_verification.failures, 1);
        assert_eq!(phases.member_hashing.count, 1);
        assert_eq!(phases.member_hashing.failures, 1);
        assert_eq!(phases.inventory_modes.count, 0);
        assert_eq!(phases.identity_after.count, 0);
        assert_eq!(
            phases.hash_calls, 3,
            "manifest and describe.js hashed; engine.js hash attempted but cancelled before compression"
        );
        assert_eq!(
            phases.bytes_hashed,
            fs::metadata(f.root.join("manifest.json")).unwrap().len()
                + fs::metadata(f.root.join("describe.js")).unwrap().len(),
            "bytes read into the refused chunk are not counted as hashed"
        );
        f.record(
            "failed-capture-revalidation-diagnostics",
            serde_json::json!({
                "receiptRevalidations":timings.snapshot(), "verificationPhases":phases,
                "engineReads":reads.get(), "error":failure,
                "initialSelectionReadExcluded":true,
            }),
        );
    }

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
            Self::with_engine_and_extra_members(engine_bytes, 0)
        }
        fn with_engine_and_extra_members(engine_bytes: &[u8], extra_members: usize) -> Self {
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
            for index in 0..extra_members {
                bodies.insert(
                    format!("fixture-members/{index:05}.json"),
                    format!("{{\"fixtureMember\":{index}}}\n").into_bytes(),
                );
            }
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
                fs::create_dir_all(stage.join(&name).parent().unwrap()).unwrap();
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
    pub(super) fn with_selection_generation_fixture<R>(
        action: impl FnOnce(&GenerationReceipt, &Path, &Path) -> R,
    ) -> R {
        let fixture = Fixture::new();
        let generation = fixture.capture().unwrap();
        action(&generation, &fixture.home, &fixture.root)
    }

    pub(super) fn with_large_selection_generation_fixture<R>(
        action: impl FnOnce(&GenerationReceipt, &Path, &Path) -> R,
    ) -> R {
        let fixture = Fixture::with_engine_and_extra_members(b"engine\n", 4100);
        // Fixture preparation is outside the invocation. Its retained native
        // receipt still receives one fixed, non-renewed budget for all checks.
        let mut cancel = || Ok(());
        let mut verify = Verification::new(Instant::now() + Duration::from_secs(120), &mut cancel);
        let generation = GenerationReceipt::capture_at(
            &fixture.home,
            &fixture.config,
            &fixture.native,
            &mut verify,
        )
        .unwrap();
        drop(verify);
        action(&generation, &fixture.home, &fixture.root)
    }

    #[cfg(feature = "sqlite-store")]
    pub(super) fn with_sqlite_identity_generation_fixture<R>(
        action: impl FnOnce(&GenerationReceipt, &Path, &Path) -> R,
    ) -> R {
        let fixture = Fixture::new();
        let generation = fixture.capture().unwrap();
        action(&generation, &fixture.home, &fixture.root)
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

    // The existing read observer changes a DIFFERENT member while a later
    // manifest member is being hashed. It never mutates the file currently
    // being read, so the ordinary in-read identity checks remain effective.
    fn metadata_hash_to_parse_window(target_name: &'static str) {
        use std::{cell::RefCell, rc::Rc};
        let f = Fixture::new();
        let target = f.root.join(target_name);
        let original = fs::read(&target).unwrap();
        let manifest: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(f.root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(hash(&original), manifest[target_name]);
        let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
        let engine = f.root.join("engine.js");
        let original_mode = fs::metadata(&engine).unwrap().permissions().mode() & 0o7777;
        let trigger_name = match target_name {
            "native-entry.json" => {
                value["timeoutMs"] = serde_json::json!(1001);
                "native-modes.json"
            }
            "native-modes.json" => {
                value["engine.js"] = serde_json::json!(0o755);
                "native/caws-hook-native"
            }
            _ => panic!("unsupported test metadata member"),
        };
        let altered = serde_json::to_vec(&value).unwrap();
        assert_eq!(altered.len(), original.len());
        assert_ne!(hash(&altered), manifest[target_name]);
        let trigger = f.root.join(trigger_name);
        let reads = Rc::new(RefCell::new(Vec::<serde_json::Value>::new()));
        let observed_reads = reads.clone();
        let changed = Rc::new(std::cell::Cell::new(false));
        let mutation_done = changed.clone();
        let target_in_hook = target.clone();
        let engine_in_hook = engine.clone();
        let altered_in_hook = altered.clone();
        let original_len = original.len() as u64;
        let deadline = expires();
        let mut cancel = || Ok(());
        let mut verify = Verification::new(deadline, &mut cancel);
        verify.on_chunk = Some(Box::new(move |path, total| {
            if path == target_in_hook {
                assert_eq!(total, original_len);
                let mut events = observed_reads.borrow_mut();
                let read = events.len() + 1;
                events.push(serde_json::json!({
                    "phase":if read == 1 { "manifest_member_hash" } else { "metadata_parse_read" },
                    "read":read,"observedBytes":total,
                    "namedPayloadSha256":hash(&fs::read(&target_in_hook).unwrap())
                }));
            }
            if path == trigger && !mutation_done.get() {
                // BTreeMap order gives a completed first target hash and a
                // later still-original parse read, with no clock or race loop.
                assert_eq!(observed_reads.borrow().len(), 1);
                fs::write(&target_in_hook, &altered_in_hook).unwrap();
                if target_name == "native-modes.json" {
                    fs::set_permissions(&engine_in_hook, fs::Permissions::from_mode(0o755))
                        .unwrap();
                }
                mutation_done.set(true);
            }
        }));
        let selected = Selection::read_generation(&f.home, &f.config.digest, &mut verify);
        drop(verify);
        assert!(changed.get(), "test never installed its hostile metadata");
        assert_eq!(
            reads.borrow().len(),
            2,
            "test missed the actual parser read"
        );
        assert_eq!(reads.borrow()[0]["namedPayloadSha256"], hash(&original));
        assert_eq!(reads.borrow()[1]["namedPayloadSha256"], hash(&altered));
        let mode_at_return = fs::metadata(&engine).unwrap().permissions().mode() & 0o7777;
        let bytes_at_return = hash(&fs::read(&target).unwrap());
        // Restore OUTSIDE the completed parser read. No inode/timestamp spoof
        // and no mutation of the current read descriptor is needed. The old
        // Selection revalidation sees the original hashes/modes again.
        fs::write(&target, &original).unwrap();
        fs::set_permissions(&engine, fs::Permissions::from_mode(original_mode)).unwrap();
        assert_eq!(hash(&fs::read(&target).unwrap()), manifest[target_name]);
        let (admitted, selected_timeout, revalidation_ok, revalidation_error, error) =
            match selected {
                Ok(selection) => {
                    let timeout = selection.native_entry().unwrap().timeout_ms;
                    let mut verify = Verification::new(deadline, &mut cancel);
                    let result = selection.revalidate(&mut verify);
                    (
                        true,
                        Some(timeout),
                        Some(result.is_ok()),
                        result.err(),
                        None,
                    )
                }
                Err(error) => (false, None, None, None, Some(error)),
            };
        f.record(target_name, serde_json::json!({
            "schema":"caws.metadata_hash_to_parse.observation.v1","synthetic":true,
            "component":"Selection::read_generation","target":target_name,
            "trigger":trigger_name,"manifestDigest":f.config.digest,
            "expectedPayloadSha256":manifest[target_name],"alteredPayloadSha256":hash(&altered),
            "namedPayloadSha256AtReturn":bytes_at_return,"reads":*reads.borrow(),
            "admitted":admitted,"selectedTimeoutMs":selected_timeout,
            "originalTimeoutMs":1000,"originalEngineMode":original_mode,
            "engineModeAtReturn":mode_at_return,"alteredMode":if target_name == "native-modes.json" { Some(0o755) } else { None },
            "restoredPayloadSha256":hash(&fs::read(&target).unwrap()),
            "restoredRevalidationOk":revalidation_ok,"restoredRevalidationError":revalidation_error,
            "error":error,"originalDeadlineReused":true
        }));
        if admitted {
            assert_eq!(
                revalidation_ok,
                Some(true),
                "old admission was not restored before revalidation: {revalidation_error:?}"
            );
            if target_name == "native-entry.json" {
                assert_eq!(selected_timeout, Some(1001));
            } else {
                assert_eq!(mode_at_return, 0o755);
                assert_eq!(selected_timeout, Some(1000));
            }
        }
        assert_eq!(
            error,
            Some(format!("Runtime member integrity failure: {target_name}")),
            "metadata parser admitted unbound bytes; admitted={admitted}, selected_timeout={selected_timeout:?}, restored_revalidation={revalidation_ok:?}"
        );
    }

    #[test]
    fn hash_to_parse_native_entry_bytes_must_match_manifest() {
        metadata_hash_to_parse_window("native-entry.json");
    }

    #[test]
    fn hash_to_parse_native_modes_bytes_must_match_manifest() {
        metadata_hash_to_parse_window("native-modes.json");
    }

    #[test]
    fn hash_to_parse_unchanged_metadata_retains_admission_and_revalidation() {
        use std::{cell::RefCell, rc::Rc};
        let f = Fixture::new();
        let expected: BTreeMap<String, String> = ["native-entry.json", "native-modes.json"]
            .into_iter()
            .map(|name| (name.into(), hash(&fs::read(f.root.join(name)).unwrap())))
            .collect();
        let reads = Rc::new(RefCell::new(BTreeMap::<String, Vec<String>>::new()));
        let observed = reads.clone();
        let root = f.root.clone();
        let deadline = expires();
        let mut cancel = || Ok(());
        let mut verify = Verification::new(deadline, &mut cancel);
        verify.on_chunk = Some(Box::new(move |path, _| {
            for name in ["native-entry.json", "native-modes.json"] {
                if path == root.join(name) {
                    observed
                        .borrow_mut()
                        .entry(name.into())
                        .or_default()
                        .push(hash(&fs::read(path).unwrap()));
                }
            }
        }));
        let selection = Selection::read_generation(&f.home, &f.config.digest, &mut verify).unwrap();
        drop(verify);
        assert_eq!(selection.native_entry().unwrap().timeout_ms, 1000);
        for (name, digest) in &expected {
            assert_eq!(reads.borrow()[name], vec![digest.clone(), digest.clone()]);
        }
        let mut verify = Verification::new(deadline, &mut cancel);
        selection.revalidate(&mut verify).unwrap();
        f.record(
            "unchanged-metadata-hash-to-parse",
            serde_json::json!({
                "schema":"caws.metadata_hash_to_parse.observation.v1","synthetic":true,
                "component":"Selection::read_generation","reads":*reads.borrow(),
                "expectedPayloadSha256":expected,"admitted":true,"selectedTimeoutMs":1000,
                "restoredRevalidationOk":true,"originalDeadlineReused":true
            }),
        );
    }
    #[test]
    fn selected_executor_is_exact_admitted_member_and_original_expiry() {
        let fixture = Fixture::new();
        let generation = fixture.capture().unwrap();
        assert_eq!(generation.root(), fixture.root);
        let selected = generation
            .selected_native_executor(expires(), || Ok(()))
            .unwrap();
        let native = generation
            .member_digest("native/caws-native", expires(), || Ok(()))
            .unwrap();
        assert_eq!(selected.path, fixture.native);
        assert_eq!(
            selected.physical_path,
            fixture.native.canonicalize().unwrap()
        );
        assert_eq!(selected.sha256, native.sha256);
        assert_eq!(selected.identity.device, native.metadata.dev);
        assert_eq!(selected.identity.inode, native.metadata.ino);
        assert_eq!(selected.identity.bytes, native.metadata.size);
        assert_eq!(
            selected.identity.modified_nanoseconds,
            native.metadata.mtime_nsec
        );
        assert!(
            generation
                .selected_native_executor(Instant::now() - Duration::from_secs(1), || Ok(()))
                .is_err()
        );
        assert_eq!(
            generation
                .selected_native_executor(expires(), || Err("original cancelled".into()))
                .unwrap_err(),
            "original cancelled"
        );
        let bytes = fs::read(&fixture.native).unwrap();
        let replacement = fixture.native.with_file_name("replacement");
        fs::write(&replacement, bytes).unwrap();
        fs::set_permissions(
            &replacement,
            fs::Permissions::from_mode(selected.identity.mode & 0o7777),
        )
        .unwrap();
        fs::rename(replacement, &fixture.native).unwrap();
        assert!(
            generation
                .selected_native_executor(expires(), || Ok(()))
                .is_err(),
            "same-byte new native inode cannot become this generation's executor"
        );
    }
    #[test]
    fn generation_summary_returns_retained_manifest_without_member_body_reads() {
        let fixture = Fixture::new();
        let generation = fixture.capture().unwrap();
        let reads = std::cell::Cell::new(0);
        let mut cancel = || Ok(());
        let mut verify = Verification::new(expires(), &mut cancel);
        verify.on_chunk = Some(Box::new(|_, _| reads.set(reads.get() + 1)));
        let manifest = generation
            .manifest_summary_with(&fixture.root, &mut verify)
            .unwrap();
        assert_eq!(&manifest, generation.selection.members());
        assert_eq!(
            reads.get(),
            0,
            "summary must not invoke existing member-content readers"
        );
        drop(verify);
        fs::write(
            fixture.home.join("state/adapter-runtime.json"),
            b"different pointer",
        )
        .unwrap();
        assert_eq!(
            generation
                .manifest_summary(&fixture.root, expires(), || Ok(()))
                .unwrap(),
            manifest
        );
    }
    #[test]
    fn generation_summary_rejects_aliases_manifest_replacement_expiry_and_cancel() {
        let fixture = Fixture::new();
        let generation = fixture.capture().unwrap();
        for root in [
            fixture.home.clone(),
            fixture.root.with_file_name("0".repeat(64)),
            PathBuf::from(format!("{}/", fixture.root.display())),
            PathBuf::from(format!("{}/.", fixture.root.display())),
        ] {
            assert!(
                generation
                    .manifest_summary(&root, expires(), || Ok(()))
                    .is_err(),
                "alias {}",
                root.display()
            );
        }
        assert!(
            generation
                .manifest_summary(
                    &fixture.root,
                    Instant::now() - Duration::from_secs(1),
                    || Ok(())
                )
                .unwrap_err()
                .contains("deadline")
        );
        assert_eq!(
            generation
                .manifest_summary(&fixture.root, expires(), || Err(
                    "original summary cancelled".into()
                ))
                .unwrap_err(),
            "original summary cancelled"
        );
        let manifest = fixture.root.join("manifest.json");
        let replacement = fixture.home.join("replacement-manifest");
        fs::write(&replacement, fs::read(&manifest).unwrap()).unwrap();
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o644)).unwrap();
        fs::rename(&replacement, &manifest).unwrap();
        assert!(
            generation
                .manifest_summary(&fixture.root, expires(), || Ok(()))
                .unwrap_err()
                .contains("changed")
        );
    }
    #[test]
    fn generation_summary_cannot_renew_the_retained_receipt_expiry() {
        let fixture = Fixture::new();
        let mut generation = fixture.capture().unwrap();
        // Private negative clock seam: model the original receipt expiring,
        // then supply a later caller bound. It must still refuse this snapshot.
        generation.expires = Instant::now() - Duration::from_secs(1);
        assert!(
            generation
                .manifest_summary(
                    &fixture.root,
                    Instant::now() + Duration::from_secs(3600),
                    || Ok(())
                )
                .unwrap_err()
                .contains("deadline")
        );
    }
}
