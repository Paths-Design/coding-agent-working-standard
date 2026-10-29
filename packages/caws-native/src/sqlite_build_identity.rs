//! Linked SQLite identity observation and an invocation-owned exact-match receipt.
//! This primitive supplies no production policy, SQL interpreter qualification,
//! calendar qualification, selection admission, or publication authority.
use crate::native_generation::GenerationReceipt;
use crate::selection_observation::GenerationValidationScope;
use caws_native::monotonic_deadline::MonotonicDeadline;
use serde::Serialize;
use std::io::Write;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SqliteBuildIdentity {
    schema: &'static str,
    version: String,
    source_id: String,
    thread_safe: i32,
    compile_options: Vec<String>,
    compiled_prefix_sha256: String,
}

/// Native policy input, not a caller assertion of qualification. The production
/// owner must qualify and authenticate this expected data separately before
/// using it for production admission. This constructor only validates data shape.
/// No Deserialize implementation or default profile is provided.
pub(crate) struct ExpectedSqliteIdentity(SqliteBuildIdentity);
impl ExpectedSqliteIdentity {
    pub(crate) fn from_expected_data(
        version: String,
        source_id: String,
        thread_safe: i32,
        mut compile_options: Vec<String>,
        compiled_prefix_sha256: String,
    ) -> Result<Self, String> {
        compile_options.sort();
        if version.is_empty()
            || source_id.is_empty()
            || !matches!(thread_safe, 0..=2)
            || compile_options.is_empty()
            || compile_options
                .iter()
                .any(|option| option.is_empty() || option.contains('\0'))
            || compile_options.windows(2).any(|pair| pair[0] == pair[1])
            || compiled_prefix_sha256.len() != 64
            || !compiled_prefix_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid expected SQLite identity".into());
        }
        Ok(Self(SqliteBuildIdentity {
            schema: "caws.sqlite_build_identity.v1",
            version,
            source_id,
            thread_safe,
            compile_options,
            compiled_prefix_sha256,
        }))
    }
}

fn checkpoint(
    original_deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    cancel()?;
    original_deadline.check().map_err(|error| error.to_string())
}

/// The statement is dropped before explicit connection close. Neither a success
/// nor an error leaves a live SQLite handle in the returned value.
fn observe_linked() -> Result<SqliteBuildIdentity, String> {
    let connection = rusqlite::Connection::open_in_memory().map_err(|error| error.to_string())?;
    let observed = (|| -> Result<SqliteBuildIdentity, rusqlite::Error> {
        let source_id = connection.query_row("SELECT sqlite_source_id()", [], |row| row.get(0))?;
        let mut compile_options = {
            let mut options = connection.prepare("PRAGMA compile_options")?;
            let values = options
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            values
        };
        compile_options.sort();
        // No arguments, pointers or callback lifetimes cross this direct FFI call.
        let thread_safe = unsafe { libsqlite3_sys::sqlite3_threadsafe() };
        Ok(SqliteBuildIdentity {
            schema: "caws.sqlite_build_identity.v1",
            version: rusqlite::version().into(),
            source_id,
            thread_safe,
            compile_options,
            compiled_prefix_sha256: env!("CAWS_SQLITE_PREFIX_SHA256").into(),
        })
    })();
    let closed = connection.close().map_err(|(connection, error)| {
        drop(connection);
        error.to_string()
    });
    match (observed, closed) {
        (Ok(identity), Ok(())) => Ok(identity),
        (Err(error), Ok(())) => Err(error.to_string()),
        (Ok(_), Err(close)) => Err(format!("SQLite identity close failed: {close}")),
        (Err(error), Err(close)) => Err(format!("{error}; SQLite identity close failed: {close}")),
    }
}

pub(crate) fn observe(
    original_deadline: &MonotonicDeadline,
    mut cancel: impl FnMut() -> Result<(), String>,
) -> Result<SqliteBuildIdentity, String> {
    checkpoint(original_deadline, &mut cancel)?;
    let result = observe_linked();
    // Even an introspection error must not skip the original deadline check.
    checkpoint(original_deadline, &mut cancel)?;
    result
}

fn exact_match(
    observed: &SqliteBuildIdentity,
    expected: &ExpectedSqliteIdentity,
) -> Result<(), String> {
    let expected = &expected.0;
    let mut mismatched = Vec::new();
    if observed.version != expected.version {
        mismatched.push("version");
    }
    if observed.source_id != expected.source_id {
        mismatched.push("sourceId");
    }
    if observed.thread_safe != expected.thread_safe {
        mismatched.push("threadSafe");
    }
    if observed.compile_options != expected.compile_options {
        mismatched.push("compileOptions");
    }
    if observed.compiled_prefix_sha256 != expected.compiled_prefix_sha256 {
        mismatched.push("compiledPrefixSha256");
    }
    if mismatched.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "linked SQLite identity mismatch: {}",
            mismatched.join(",")
        ))
    }
}

/// Borrows the original native generation, never a TS digest/string claim.
/// Non-Clone and non-Deserialize. This is only SQLite identity evidence: the
/// enclosing owner must retain invocation/selection identity and all other
/// profile receipts, then revalidate the combined carrier before any effects.
pub(crate) struct SqliteIdentityReceipt<'original> {
    generation: &'original GenerationReceipt,
    original_deadline: &'original MonotonicDeadline,
    observed: SqliteBuildIdentity,
}
impl<'original> SqliteIdentityReceipt<'original> {
    /// The unforgeable scope supplies the full generation bracket. This helper
    /// still observes the actual linked SQLite and checks the exact owner/clock.
    pub(crate) fn capture_in_scope(
        scope: &GenerationValidationScope<'_, '_>,
        generation: &'original GenerationReceipt,
        expected: &ExpectedSqliteIdentity,
        original_deadline: &'original MonotonicDeadline,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        scope.check_binding(generation, original_deadline, &mut cancel)?;
        let observed = observe(original_deadline, &mut cancel)?;
        exact_match(&observed, expected)?;
        scope.check_binding(generation, original_deadline, &mut cancel)?;
        Ok(Self {
            generation,
            original_deadline,
            observed,
        })
    }

    pub(crate) fn capture(
        generation: &'original GenerationReceipt,
        expected: &ExpectedSqliteIdentity,
        original_deadline: &'original MonotonicDeadline,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        checkpoint(original_deadline, &mut cancel)?;
        generation.revalidate(original_deadline.expires(), || {
            checkpoint(original_deadline, &mut cancel)
        })?;
        let observed = observe(original_deadline, &mut cancel)?;
        exact_match(&observed, expected)?;
        generation.revalidate(original_deadline.expires(), || {
            checkpoint(original_deadline, &mut cancel)
        })?;
        checkpoint(original_deadline, &mut cancel)?;
        Ok(Self {
            generation,
            original_deadline,
            observed,
        })
    }

    /// No renewed expiry and no current-pointer lookup. Linked identity is
    /// reobserved rather than accepting a caller-supplied identity or boolean.
    pub(crate) fn revalidate(
        &self,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        checkpoint(self.original_deadline, &mut cancel)?;
        self.generation
            .revalidate(self.original_deadline.expires(), || {
                checkpoint(self.original_deadline, &mut cancel)
            })?;
        let current = observe(self.original_deadline, &mut cancel)?;
        if current != self.observed {
            return Err("linked SQLite identity changed".into());
        }
        self.generation
            .revalidate(self.original_deadline.expires(), || {
                checkpoint(self.original_deadline, &mut cancel)
            })?;
        checkpoint(self.original_deadline, &mut cancel)
    }

    pub(crate) fn revalidate_in_scope(
        &self,
        scope: &GenerationValidationScope<'_, '_>,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        scope.check_binding(self.generation, self.original_deadline, &mut cancel)?;
        let current = observe(self.original_deadline, &mut cancel)?;
        if current != self.observed {
            return Err("linked SQLite identity changed".into());
        }
        scope.check_binding(self.generation, self.original_deadline, &mut cancel)
    }
}

/// Advertise the compiled receiver to tooling. Internal identity remains v1.
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let identity = observe_linked().map_err(std::io::Error::other)?;
    let diagnostic = serde_json::json!({
        "schema": "caws.sqlite_build_identity.v2",
        "version": identity.version,
        "sourceId": identity.source_id,
        "threadSafe": identity.thread_safe,
        "compileOptions": identity.compile_options,
        "compiledPrefixSha256": identity.compiled_prefix_sha256,
        "installedInvocation": {
            "protocol": "invoke-installed-v1",
            "maxOriginalTimeoutMs": 30_000,
        },
    });
    let mut bytes = serde_json::to_vec(&diagnostic)?;
    bytes.push(b'\n');
    std::io::stdout().lock().write_all(&bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn deadline() -> MonotonicDeadline {
        MonotonicDeadline::capture(Duration::from_secs(10)).unwrap()
    }
    fn retain(name: &str, value: serde_json::Value) {
        let Some(root) = std::env::var_os("CAWS_TEST_ARTIFACT_DIR") else {
            return;
        };
        let directory = std::path::PathBuf::from(root)
            .join(format!("sqlite-build-identity-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(format!("{name}.json")))
            .unwrap();
        serde_json::to_writer_pretty(&mut file, &value).unwrap();
        file.write_all(b"\n").unwrap();
    }
    fn expected(identity: &SqliteBuildIdentity) -> ExpectedSqliteIdentity {
        ExpectedSqliteIdentity::from_expected_data(
            identity.version.clone(),
            identity.source_id.clone(),
            identity.thread_safe,
            identity.compile_options.clone(),
            identity.compiled_prefix_sha256.clone(),
        )
        .unwrap()
    }

    #[test]
    fn actual_linked_identity_matches_exactly_and_preserves_diagnostic_schema() {
        let observed = observe(&deadline(), || Ok(())).unwrap();
        exact_match(&observed, &expected(&observed)).unwrap();
        retain(
            "actual-linked-identity",
            serde_json::json!({"observed": &observed}),
        );
        let value = serde_json::to_value(&observed).unwrap();
        let keys: std::collections::BTreeSet<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "schema",
                "version",
                "sourceId",
                "threadSafe",
                "compileOptions",
                "compiledPrefixSha256"
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(value["version"], rusqlite::version());
        assert_eq!(value["schema"], "caws.sqlite_build_identity.v1");
    }

    #[test]
    fn same_version_changed_fields_and_extra_options_refuse() {
        let observed = observe(&deadline(), || Ok(())).unwrap();
        for case in 0..6 {
            let mut changed = expected(&observed);
            match case {
                0 => changed.0.version.push_str("-different"),
                1 => changed.0.source_id.push_str("-different"),
                2 => changed.0.thread_safe = (changed.0.thread_safe + 1) % 3,
                3 => changed
                    .0
                    .compile_options
                    .push("CAWS_UNQUALIFIED_EXTRA=1".into()),
                4 => {
                    changed.0.compile_options.pop();
                }
                5 => {
                    changed.0.compiled_prefix_sha256 =
                        if observed.compiled_prefix_sha256 == "0".repeat(64) {
                            "1".repeat(64)
                        } else {
                            "0".repeat(64)
                        }
                }
                _ => unreachable!(),
            }
            let diagnostic = exact_match(&observed, &changed).unwrap_err();
            retain(
                &format!("mismatch-{case}"),
                serde_json::json!({
                    "observed": &observed, "expected": &changed.0, "diagnostic": &diagnostic
                }),
            );
            let field = [
                "version",
                "sourceId",
                "threadSafe",
                "compileOptions",
                "compileOptions",
                "compiledPrefixSha256",
            ][case];
            assert_eq!(
                diagnostic,
                format!("linked SQLite identity mismatch: {field}")
            );
            if case != 0 {
                assert_eq!(changed.0.version, observed.version);
            }
        }
    }

    #[test]
    fn expired_observation_and_cancelled_post_observation_refuse() {
        let mut calls = 0;
        let original = MonotonicDeadline::capture(Duration::from_millis(1)).unwrap();
        std::thread::sleep(Duration::from_millis(2));
        let expired = observe(&original, || {
            calls += 1;
            Ok(())
        });
        let expired = expired.unwrap_err();
        retain(
            "expired-original-deadline",
            serde_json::json!({"envelope": original.envelope(), "diagnostic": &expired, "checkpointCalls": calls}),
        );
        assert_eq!(expired, "Original monotonic deadline expired");
        assert_eq!(calls, 1);
        calls = 0;
        let cancelled = observe(&deadline(), || {
            calls += 1;
            if calls == 2 {
                Err("post-observation cancellation".into())
            } else {
                Ok(())
            }
        });
        let cancelled = cancelled.unwrap_err();
        retain(
            "post-observation-cancellation",
            serde_json::json!({"diagnostic": &cancelled, "checkpointCalls": calls}),
        );
        assert_eq!(cancelled, "post-observation cancellation");
        assert_eq!(calls, 2);
    }
    fn fixture_identity(
        generation: &GenerationReceipt,
        home: &std::path::Path,
        root: &std::path::Path,
    ) -> serde_json::Value {
        let manifest_bytes = std::fs::read(root.join("manifest.json")).unwrap();
        serde_json::json!({
            "syntheticGenerationFixture": true,
            "home": home, "root": root, "generationDigest": generation.digest(),
            "manifestBytes": manifest_bytes,
            "manifest": serde_json::from_slice::<serde_json::Value>(&manifest_bytes).unwrap(),
            "pointerBytes": std::fs::read(home.join("state/adapter-runtime.json")).unwrap()
        })
    }

    #[test]
    fn sqlite_receipt_binds_actual_generation_and_revalidates_linked_identity() {
        crate::native_generation::with_sqlite_identity_generation_fixture(
            |generation, home, root| {
                let original = deadline();
                let observed = observe(&original, || Ok(())).unwrap();
                let expected = expected(&observed);
                let mut mismatched = self::expected(&observed);
                mismatched.0.source_id.push_str("-unqualified");
                let denied =
                    SqliteIdentityReceipt::capture(generation, &mismatched, &original, || Ok(()))
                        .err()
                        .expect("changed source ID must not issue a receipt");
                assert_eq!(denied, "linked SQLite identity mismatch: sourceId");
                let receipt =
                    SqliteIdentityReceipt::capture(generation, &expected, &original, || Ok(()))
                        .unwrap();
                let revalidated = receipt.revalidate(|| Ok(()));
                retain(
                    "receipt-actual-generation",
                    serde_json::json!({
                        "fixture": fixture_identity(generation, home, root),
                        "observed": &observed, "receiptObserved": &receipt.observed,
                        "mismatchedExpected": &mismatched.0, "mismatchDiagnostic": denied,
                        "originalDeadline": original.envelope(),
                        "revalidationDiagnostic": revalidated.as_ref().err()
                    }),
                );
                assert_eq!(receipt.observed, observed);
                assert!(std::ptr::eq(receipt.generation, generation));
                assert!(std::ptr::eq(receipt.original_deadline, &original));
                revalidated.unwrap();
            },
        );
    }

    #[test]
    fn sqlite_receipt_refuses_corrupted_original_generation_member() {
        crate::native_generation::with_sqlite_identity_generation_fixture(
            |generation, home, root| {
                let original = deadline();
                let observed = observe(&original, || Ok(())).unwrap();
                let expected = expected(&observed);
                let fixture = fixture_identity(generation, home, root);
                let receipt =
                    SqliteIdentityReceipt::capture(generation, &expected, &original, || Ok(()))
                        .unwrap();
                let engine = root.join("engine.js");
                let before = std::fs::read(&engine).unwrap();
                std::fs::write(&engine, b"corrupted original engine\n").unwrap();
                let after = std::fs::read(&engine).unwrap();
                let revalidate_error = receipt.revalidate(|| Ok(())).unwrap_err();
                let capture_error =
                    SqliteIdentityReceipt::capture(generation, &expected, &original, || Ok(()))
                        .err()
                        .expect("corrupted generation must not issue a second receipt");
                retain(
                    "receipt-corrupted-generation",
                    serde_json::json!({
                        "fixture": fixture, "observed": &observed, "engineBefore": before,
                        "engineAfter": after, "revalidationDiagnostic": &revalidate_error,
                        "captureDiagnostic": &capture_error
                    }),
                );
                assert_eq!(revalidate_error, "Admitted generation member changed");
                assert_eq!(capture_error, "Admitted generation member changed");
            },
        );
    }

    #[test]
    fn sqlite_receipt_refuses_replaced_original_generation_directory() {
        crate::native_generation::with_sqlite_identity_generation_fixture(
            |generation, home, root| {
                let original = deadline();
                let observed = observe(&original, || Ok(())).unwrap();
                let expected = expected(&observed);
                let fixture = fixture_identity(generation, home, root);
                let receipt =
                    SqliteIdentityReceipt::capture(generation, &expected, &original, || Ok(()))
                        .unwrap();
                let retired = home.join("retained-original-generation");
                std::fs::rename(root, &retired).unwrap();
                std::fs::create_dir(root).unwrap();
                let diagnostic = receipt.revalidate(|| Ok(())).unwrap_err();
                retain(
                    "receipt-replaced-generation",
                    serde_json::json!({
                        "fixture": fixture, "observed": &observed,
                        "originalRetainedAt": retired, "replacement": root,
                        "diagnostic": &diagnostic
                    }),
                );
                assert_eq!(diagnostic, "Admitted generation directory changed");
            },
        );
    }

    #[test]
    fn sqlite_receipt_refuses_expired_original_deadline_for_revalidation_and_capture() {
        crate::native_generation::with_sqlite_identity_generation_fixture(
            |generation, home, root| {
                let original = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
                let observed = observe(&original, || Ok(())).unwrap();
                let expected = expected(&observed);
                let receipt =
                    SqliteIdentityReceipt::capture(generation, &expected, &original, || Ok(()))
                        .unwrap();
                std::thread::sleep(
                    original
                        .expires()
                        .saturating_duration_since(std::time::Instant::now())
                        + Duration::from_millis(1),
                );
                let revalidate_error = receipt.revalidate(|| Ok(())).unwrap_err();
                let capture_error =
                    SqliteIdentityReceipt::capture(generation, &expected, &original, || Ok(()))
                        .err()
                        .expect("expired original deadline must not issue a receipt");
                // A fresh clock is live but cannot replace the receipt's borrowed clock.
                let renewed = deadline();
                renewed.check().unwrap();
                retain(
                    "receipt-expired-original",
                    serde_json::json!({
                        "fixture": fixture_identity(generation, home, root), "observed": &observed,
                        "originalDeadline": original.envelope(), "unrelatedFreshDeadline": renewed.envelope(),
                        "revalidationDiagnostic": &revalidate_error, "captureDiagnostic": &capture_error
                    }),
                );
                assert_eq!(revalidate_error, "Original monotonic deadline expired");
                assert_eq!(capture_error, "Original monotonic deadline expired");
            },
        );
    }
}
