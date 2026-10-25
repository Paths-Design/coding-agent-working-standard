//! Generation-bound controlled semantic evidence for a future native Stop owner.
//! No selection, prefix, calendar, engine-dispatch or publication grant is made.
//! Provenance contains only offline hashes; runtime never locates or runs Python.
use crate::native_generation::GenerationReceipt;
use crate::selection_observation::GenerationValidationScope;
#[cfg(feature = "sqlite-store")]
use crate::sqlite_build_identity::{ExpectedSqliteIdentity, SqliteIdentityReceipt};
use caws_native::{monotonic_deadline::MonotonicDeadline, session_cache_wire::OriginalStopCapture};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Component, Path},
};

const MEMBER: &str = "native-stop-profile.json";
// Same byte ceiling as the installed manifest. Runtime implementation identity
// can cover a full package; it must not inherit the smaller entry-metadata cap.
const MAXIMUM: u64 = 8 * 1024 * 1024;
const SQL_CASES: &[&str] = &[
    "message-int4300",
    "message-int4301",
    "message-negative4300",
    "message-negative4301",
    "part-int4301",
    "message-string4301",
    "message-float4301",
];
const RENDER_CASES: &[&str] = &[
    "plain",
    "integer4300",
    "integer4301",
    "negative4301",
    "string4301",
    "float4301",
    "html-literal4301",
    "html-decimal4301",
];
const REMAINING: &[&str] = &[
    "native-calendar-original-environment",
    "bundled-engine-dispatch-equivalence",
    "native-selection-prefix-and-queued-peer-admission",
    "ordinary-publication-reopened-consumer-and-release",
    "ambient-legacy-startup-equivalence",
    "other-supported-surfaces",
];
const PREFIX: &str = "native-prefix/node_modules/@paths.design/caws-cli/dist/";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema: String,
    surface: String,
    event: String,
    scope: String,
    #[serde(deserialize_with = "unique_members")]
    implementation: BTreeMap<String, String>,
    selectors: Selectors,
    sqlite_identity: SqliteData,
    environment: Environment,
    comparison: Comparison,
    provenance: Provenance,
    remaining_joins: Vec<String>,
    #[serde(default, deserialize_with = "present_git_distribution")]
    git_distribution: Option<Option<caws_native::context_git::stop::Observation>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selectors {
    sql: Vec<Selector>,
    renderer: Vec<Selector>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selector {
    id: String,
    integer_max_digits: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SqliteData {
    schema: String,
    version: String,
    source_id: String,
    thread_safe: i32,
    compile_options: Vec<String>,
    compiled_prefix_sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Environment {
    tz: String,
    tzdir: String,
    integer_max_digits: Vec<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Comparison {
    receipt_sha256: String,
    driver_sha256: String,
    comparisons: Vec<Row>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    id: String,
    result: String,
    reference_sha256: String,
    candidate_sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provenance {
    reference_mode: String,
    reference_adapter_sha256: String,
    reference_shared_inventory_sha256: String,
    corpus_sha256: String,
}
fn present_git_distribution<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<Option<caws_native::context_git::stop::Observation>>, D::Error> {
    Ok(Some(Option::deserialize(decoder)?))
}
fn unique_members<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("unique implementation members")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate implementation member"));
                }
            }
            Ok(result)
        }
    }
    decoder.deserialize_map(Unique)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn member(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', '\0'])
        && !name.starts_with("..")
        && !name.starts_with('/')
        && name
            .split('/')
            .all(|v| !v.is_empty() && v != "." && v != "..")
        && Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
fn implementation(name: &str) -> bool {
    name.starts_with("native-prefix/")
        || name.starts_with("native/")
        || matches!(name, "native-entry.json" | "native-build-provenance.json")
}
fn check(
    deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    cancel()?;
    deadline.check().map_err(|e| e.to_string())
}
fn selected_digits(environment: &BTreeMap<String, String>) -> Result<u32, String> {
    if environment.get("TZ").map(String::as_str) != Some("UTC0")
        || environment.contains_key("TZDIR")
    {
        return Err("Stop semantic profile requires original TZ=UTC0 and absent TZDIR".into());
    }
    // This records CPython's stock no-X invocation mapping, not a host probe or
    // a fallback to a convenient profile. Other explicit values need comparison.
    match environment.get("PYTHONINTMAXSTRDIGITS").map(String::as_str) {
        None | Some("4300") => Ok(4300),
        Some("0") => Ok(0),
        _ => Err("Original Python integer environment is outside compared domain".into()),
    }
}
fn validate(document: &Document) -> Result<(), String> {
    let version_matches = match document.schema.as_str() {
        "caws.runtime.stop-semantic-profile.v1" => document.git_distribution.is_none(),
        "caws.runtime.stop-semantic-profile.v2" => document
            .git_distribution
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|v| v.validate().is_ok()),
        _ => false,
    };
    if document
        .git_distribution
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|v| {
            document
                .implementation
                .get("native/caws-native")
                .map(String::as_str)
                != Some(v.inspector_native_sha256())
        })
    {
        return Err("Stop Git observation differs from semantic native implementation".into());
    }
    if !version_matches
        || document.surface != "opencode"
        || document.event != "stop"
        || document.scope != "controlled-components"
    {
        return Err("Unsupported Stop semantic evidence domain".into());
    }
    if document.environment.tz != "UTC0"
        || document.environment.tzdir != "absent"
        || document.environment.integer_max_digits != [4300, 0]
        || document
            .remaining_joins
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != REMAINING
    {
        return Err(
            "Stop semantic evidence must retain exact supported domain and remaining joins".into(),
        );
    }
    for (selectors, renderer) in [
        (&document.selectors.sql, false),
        (&document.selectors.renderer, true),
    ] {
        if selectors.len() != 2 {
            return Err("Independent compared selectors required".into());
        }
        for (selector, digits) in selectors.iter().zip([4300, 0]) {
            let id = if renderer {
                format!("cpython3.11-json/int-max-str-digits:{digits}")
            } else {
                format!("cpython-3.11.13-unicode14-int{digits}")
            };
            if selector.integer_max_digits != digits || selector.id != id {
                return Err("Unsupported independent Stop selector".into());
            }
        }
    }
    let mut required = Vec::new();
    for limit in [4300, 0] {
        for (category, cases) in [("sql", SQL_CASES), ("renderer", RENDER_CASES)] {
            for name in cases {
                required.push(format!("{category}/{limit}/{name}"));
            }
        }
    }
    required.sort();
    let mut actual = document
        .comparison
        .comparisons
        .iter()
        .map(|r| r.id.clone())
        .collect::<Vec<_>>();
    actual.sort();
    if actual != required
        || !hash(&document.comparison.receipt_sha256)
        || !hash(&document.comparison.driver_sha256)
    {
        return Err("Incomplete fixed Stop semantic comparison coverage".into());
    }
    for row in &document.comparison.comparisons {
        if row.result != "equal"
            || !hash(&row.reference_sha256)
            || row.reference_sha256 != row.candidate_sha256
        {
            return Err("Failed or unequal Stop semantic comparison".into());
        }
    }
    let provenance = &document.provenance;
    if provenance.reference_mode != "controlled-no-site-explicit-X"
        || provenance.reference_adapter_sha256
            != "074dcc4c9880758ea9bfc092612034bff7f78b7d07bed2b4331e02d5916171a9"
        || provenance.reference_shared_inventory_sha256
            != "9976411f31abc0c6249433c79a45e6e556901ebcc9ae948218416fc9a92eaad8"
        || provenance.corpus_sha256
            != "e9d9303ec7ce77dc15260aceadfa8392c7b2dbd5b3c70803354cedec6e097d19"
    {
        return Err("Unreviewed offline Stop reference provenance".into());
    }
    if document.implementation.is_empty()
        || document
            .implementation
            .iter()
            .any(|(p, h)| !member(p) || !implementation(p) || !hash(h))
    {
        return Err("Invalid Stop implementation inventory".into());
    }
    for required in [
        "native/caws-native",
        "native/node",
        "native/caws-hook-native",
        "native-entry.json",
        "native-build-provenance.json",
    ] {
        if !document.implementation.contains_key(required) {
            return Err("Incomplete Stop native image inventory".into());
        }
    }
    for leaf in [
        "runtime/engine-entry.js",
        "runtime/describe-entry.js",
        "transcripts/store-projection.js",
        "transcripts/render-prepare.js",
    ] {
        if !document
            .implementation
            .contains_key(&format!("{PREFIX}{leaf}"))
        {
            return Err("Incomplete Stop implementation closure".into());
        }
    }
    let sql = &document.sqlite_identity;
    if sql.schema != "caws.sqlite_build_identity.v1"
        || sql.version.is_empty()
        || sql.source_id.is_empty()
        || !matches!(sql.thread_safe, 0..=2)
        || !hash(&sql.compiled_prefix_sha256)
        || sql.compile_options.is_empty()
        || sql.compile_options.len() > 1024
        || sql
            .compile_options
            .iter()
            .any(|v| v.is_empty() || v.len() > 4096 || v.contains('\0'))
        || sql.compile_options.windows(2).any(|p| p[0] >= p[1])
    {
        return Err("Invalid compared SQLite identity".into());
    }
    Ok(())
}

/// Opaque, non-Clone and non-Deserialize. Contains necessary semantic evidence
/// only. The original native owner must separately discharge every remaining
/// join before constructing EligibleStop and retain/revalidate this receipt.
pub(crate) struct StopProfileReceipt<'original> {
    generation: &'original GenerationReceipt,
    original: &'original OriginalStopCapture<'original>,
    profile_digest: String,
    document: Document,
    selected: u32,
    #[cfg(feature = "sqlite-store")]
    sqlite: SqliteIdentityReceipt<'original>,
}
impl<'original> StopProfileReceipt<'original> {
    pub(crate) fn capture(
        generation: &'original GenerationReceipt,
        original: &'original OriginalStopCapture<'original>,
        cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        Self::capture_impl(generation, original, None, cancel)
    }
    pub(crate) fn capture_in_scope(
        scope: &GenerationValidationScope<'_, '_>,
        generation: &'original GenerationReceipt,
        original: &'original OriginalStopCapture<'original>,
        cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        Self::capture_impl(generation, original, Some(scope), cancel)
    }
    // Only this module can select a path; every scoped path requires the real
    // bracket token, exact generation pointer and original clock.
    fn capture_impl(
        generation: &'original GenerationReceipt,
        original: &'original OriginalStopCapture<'original>,
        scope: Option<&GenerationValidationScope<'_, '_>>,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        if let Some(scope) = scope {
            scope.check_binding(generation, original.deadline(), &mut cancel)?;
        }
        check(original.deadline(), &mut cancel)?;
        #[cfg(not(feature = "sqlite-store"))]
        {
            let _ = generation;
            return Err("Stop semantic profiles require sqlite-store feature".into());
        }
        #[cfg(feature = "sqlite-store")]
        {
            if original.runtime_digest() != generation.digest() || original.surface() != "opencode"
            {
                return Err("Stop semantic evidence differs from original invocation".into());
            }
            let selected = selected_digits(original.caller_environment())?;
            let bytes =
                generation.member_bytes(MEMBER, MAXIMUM, original.deadline().expires(), || {
                    check(original.deadline(), &mut cancel)
                })?;
            let document: Document = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid Stop semantic profile: {e}"))?;
            validate(&document)?;
            check_implementation(generation, &document, original.deadline(), &mut cancel)?;
            let sql = &document.sqlite_identity;
            let expected = ExpectedSqliteIdentity::from_expected_data(
                sql.version.clone(),
                sql.source_id.clone(),
                sql.thread_safe,
                sql.compile_options.clone(),
                sql.compiled_prefix_sha256.clone(),
            )?;
            let sqlite = match scope {
                Some(scope) => SqliteIdentityReceipt::capture_in_scope(
                    scope,
                    generation,
                    &expected,
                    original.deadline(),
                    &mut cancel,
                ),
                None => SqliteIdentityReceipt::capture(
                    generation,
                    &expected,
                    original.deadline(),
                    &mut cancel,
                ),
            }?;
            let profile_digest = generation
                .member_digest(MEMBER, original.deadline().expires(), || {
                    check(original.deadline(), &mut cancel)
                })?
                .sha256;
            check(original.deadline(), &mut cancel)?;
            Ok(Self {
                generation,
                original,
                profile_digest,
                document,
                selected,
                sqlite,
            })
        }
    }
    /// Observed data, never an eligibility receipt. v1 remains controlled-only;
    /// native Stop admission must require a separate live Git receipt for v2.
    pub(crate) fn git_distribution(&self) -> Option<&caws_native::context_git::stop::Observation> {
        self.document
            .git_distribution
            .as_ref()
            .and_then(Option::as_ref)
    }
    pub(crate) fn sql_selector(&self) -> &str {
        &self
            .document
            .selectors
            .sql
            .iter()
            .find(|p| p.integer_max_digits == self.selected)
            .expect("validated SQL selector")
            .id
    }
    pub(crate) fn renderer_selector(&self) -> (&str, u32) {
        let selector = self
            .document
            .selectors
            .renderer
            .iter()
            .find(|p| p.integer_max_digits == self.selected)
            .expect("validated renderer selector");
        (&selector.id, selector.integer_max_digits)
    }
    pub(crate) fn remaining_joins(&self) -> impl Iterator<Item = &str> {
        self.document.remaining_joins.iter().map(String::as_str)
    }
    pub(crate) fn runtime_digest(&self) -> &str {
        self.generation.digest()
    }
    pub(crate) fn revalidate(
        &self,
        cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self.revalidate_impl(None, cancel)
    }
    pub(crate) fn revalidate_in_scope(
        &self,
        scope: &GenerationValidationScope<'_, '_>,
        cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self.revalidate_impl(Some(scope), cancel)
    }
    fn revalidate_impl(
        &self,
        scope: Option<&GenerationValidationScope<'_, '_>>,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        if let Some(scope) = scope {
            scope.check_binding(self.generation, self.original.deadline(), &mut cancel)?;
        }
        check(self.original.deadline(), &mut cancel)?;
        #[cfg(not(feature = "sqlite-store"))]
        {
            return Err("Stop semantic profiles require sqlite-store feature".into());
        }
        #[cfg(feature = "sqlite-store")]
        {
            if selected_digits(self.original.caller_environment())? != self.selected {
                return Err("Original Stop selector changed".into());
            }
            if self
                .generation
                .member_digest(MEMBER, self.original.deadline().expires(), || {
                    check(self.original.deadline(), &mut cancel)
                })?
                .sha256
                != self.profile_digest
            {
                return Err("Stop semantic member changed".into());
            }
            match scope {
                Some(scope) => self.sqlite.revalidate_in_scope(scope, &mut cancel),
                None => self.sqlite.revalidate(&mut cancel),
            }?;
            check(self.original.deadline(), &mut cancel)
        }
    }
}
#[cfg(feature = "sqlite-store")]
fn check_implementation(
    generation: &GenerationReceipt,
    document: &Document,
    deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let actual = generation
        .manifest_summary(generation.root(), deadline.expires(), || {
            check(deadline, cancel)
        })?
        .into_iter()
        .filter(|(name, _)| implementation(name))
        .collect::<BTreeMap<_, _>>();
    if actual != document.implementation {
        return Err("Stop semantic implementation differs from original generation".into());
    }
    check(deadline, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::time::Duration;
    // Synthetic policy DATA tests; no native receipt or comparison is earned.
    fn fixture() -> Value {
        let mut rows = Vec::new();
        for limit in [4300, 0] {
            for (category, cases) in [("sql", SQL_CASES), ("renderer", RENDER_CASES)] {
                for name in cases {
                    rows.push(json!({"id":format!("{category}/{limit}/{name}"),"result":"equal","referenceSha256":"a".repeat(64),"candidateSha256":"a".repeat(64)}));
                }
            }
        }
        let mut implementation = BTreeMap::new();
        for name in [
            "native/caws-native",
            "native/node",
            "native/caws-hook-native",
            "native-entry.json",
            "native-build-provenance.json",
        ] {
            implementation.insert(name.to_owned(), "a".repeat(64));
        }
        for leaf in [
            "runtime/engine-entry.js",
            "runtime/describe-entry.js",
            "transcripts/store-projection.js",
            "transcripts/render-prepare.js",
        ] {
            implementation.insert(format!("{PREFIX}{leaf}"), "a".repeat(64));
        }
        json!({"schema":"caws.runtime.stop-semantic-profile.v1","surface":"opencode","event":"stop","scope":"controlled-components",
            "implementation":implementation,"selectors":{"sql":[{"id":"cpython-3.11.13-unicode14-int4300","integerMaxDigits":4300},{"id":"cpython-3.11.13-unicode14-int0","integerMaxDigits":0}],
            "renderer":[{"id":"cpython3.11-json/int-max-str-digits:4300","integerMaxDigits":4300},{"id":"cpython3.11-json/int-max-str-digits:0","integerMaxDigits":0}]},
            "sqliteIdentity":{"schema":"caws.sqlite_build_identity.v1","version":"fixture","sourceId":"fixture","threadSafe":1,"compileOptions":["A=1"],"compiledPrefixSha256":"b".repeat(64)},
            "environment":{"tz":"UTC0","tzdir":"absent","integerMaxDigits":[4300,0]},
            "comparison":{"receiptSha256":"c".repeat(64),"driverSha256":"d".repeat(64),"comparisons":rows},
            "provenance":{"referenceMode":"controlled-no-site-explicit-X","referenceAdapterSha256":"074dcc4c9880758ea9bfc092612034bff7f78b7d07bed2b4331e02d5916171a9","referenceSharedInventorySha256":"9976411f31abc0c6249433c79a45e6e556901ebcc9ae948218416fc9a92eaad8","corpusSha256":"e9d9303ec7ce77dc15260aceadfa8392c7b2dbd5b3c70803354cedec6e097d19"},"remainingJoins":REMAINING})
    }
    fn validate_value(value: Value) -> Result<(), String> {
        validate(&serde_json::from_value::<Document>(value).map_err(|e| e.to_string())?)
    }
    #[test]
    fn fixed_coverage_independent_selectors_and_remaining_joins_are_required() {
        assert_eq!(validate_value(fixture()), Ok(()));
        let mut omitted = fixture();
        omitted["comparison"]["comparisons"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(validate_value(omitted).unwrap_err().contains("coverage"));
        let mut duplicate = fixture();
        let first = duplicate["comparison"]["comparisons"][0].clone();
        duplicate["comparison"]["comparisons"]
            .as_array_mut()
            .unwrap()
            .push(first);
        assert!(validate_value(duplicate).unwrap_err().contains("coverage"));
        let mut failed = fixture();
        failed["comparison"]["comparisons"][0]["result"] = json!("failed");
        assert!(validate_value(failed).unwrap_err().contains("unequal"));
        let mut unequal = fixture();
        unequal["comparison"]["comparisons"][0]["candidateSha256"] = json!("b".repeat(64));
        assert!(validate_value(unequal).unwrap_err().contains("unequal"));
        let mut swapped = fixture();
        swapped["selectors"]["sql"] = swapped["selectors"]["renderer"].clone();
        assert!(validate_value(swapped).unwrap_err().contains("independent"));
        let mut overclaim = fixture();
        overclaim["remainingJoins"] = json!([]);
        assert!(
            validate_value(overclaim)
                .unwrap_err()
                .contains("remaining joins")
        );
    }
    #[test]
    fn unsupported_domain_unsafe_inventory_and_unreviewed_provenance_refuse() {
        for field in ["surface", "scope"] {
            let mut value = fixture();
            value[field] = json!("unqualified");
            assert!(validate_value(value).unwrap_err().contains("domain"));
        }
        for name in [
            "../escape",
            "..fixture",
            "native/../escape",
            "native//node",
            "native-stop-profile.json",
            "manifest.json",
        ] {
            let mut value = fixture();
            value["implementation"][name] = json!("a".repeat(64));
            assert!(validate_value(value).unwrap_err().contains("inventory"));
        }
        let mut old_reference = fixture();
        old_reference["provenance"]["corpusSha256"] = json!("b".repeat(64));
        assert!(
            validate_value(old_reference)
                .unwrap_err()
                .contains("provenance")
        );
        let mut unknown = fixture();
        unknown["qualified"] = json!(true);
        assert!(
            validate_value(unknown)
                .unwrap_err()
                .contains("unknown field")
        );
        let duplicate = serde_json::to_string(&fixture()).unwrap().replace(
            "\"implementation\":{",
            &format!(
                "\"implementation\":{{\"native/caws-native\":\"{}\",",
                "a".repeat(64)
            ),
        );
        assert!(
            serde_json::from_str::<Document>(&duplicate)
                .err()
                .unwrap()
                .to_string()
                .contains("duplicate implementation member")
        );
        let mut sqlite = fixture();
        sqlite["sqliteIdentity"]["compileOptions"] = json!(["A=1", "A=1"]);
        assert!(validate_value(sqlite).unwrap_err().contains("SQLite"));
    }
    #[test]
    fn original_environment_domain_is_explicit_without_reference_locale_restrictions() {
        let mut environment = BTreeMap::from([
            ("TZ".into(), "UTC0".into()),
            ("LC_ALL".into(), "fixture-local-locale".into()),
        ]);
        assert_eq!(selected_digits(&environment), Ok(4300));
        environment.insert("PYTHONINTMAXSTRDIGITS".into(), "0".into());
        assert_eq!(selected_digits(&environment), Ok(0));
        for value in ["640", "", " 0", "4301"] {
            environment.insert("PYTHONINTMAXSTRDIGITS".into(), value.into());
            assert!(
                selected_digits(&environment)
                    .unwrap_err()
                    .contains("outside compared domain")
            );
        }
        environment.remove("PYTHONINTMAXSTRDIGITS");
        environment.insert("TZDIR".into(), "".into());
        assert!(selected_digits(&environment).unwrap_err().contains("TZDIR"));
        environment.remove("TZDIR");
        environment.insert("TZ".into(), "America/Los_Angeles".into());
        assert!(
            selected_digits(&environment)
                .unwrap_err()
                .contains("TZ=UTC0")
        );
        environment.remove("TZ");
        assert!(selected_digits(&environment).is_err());
    }
    #[test]
    fn original_clock_and_cancellation_cannot_be_refreshed() {
        let deadline = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        assert_eq!(
            check(&deadline, &mut || Err("original cancelled".into())).unwrap_err(),
            "original cancelled"
        );
        // Exercise this same captured owner after expiry. A one-millisecond
        // capture can expire inside its own host-clock bracket under load.
        std::thread::sleep(
            deadline
                .expires()
                .saturating_duration_since(std::time::Instant::now())
                + Duration::from_millis(2),
        );
        assert!(check(&deadline, &mut || Ok(())).is_err());
    }

    fn git_observation() -> Value {
        let snapshot = json!({"path":"/usr/bin/git","physicalPath":"/usr/bin/git","sha256":"b".repeat(64),"device":"1","inode":"1152921500312571562","bytes":3,"mode":33261,"modifiedSeconds":4,"modifiedNanoseconds":0,"changedSeconds":5,"changedNanoseconds":0});
        let mut resolver = snapshot.clone();
        resolver["path"] = json!("/usr/bin/xcrun");
        let mut selector = snapshot.clone();
        selector["path"] = json!("/usr/bin/xcode-select");
        json!({"schema":"caws.runtime.stop-git-distribution.v1","platform":"macos","os":{"kernelRelease":"synthetic","kernelVersion":"synthetic","machine":"arm64"},"inspectorNativeSha256":"a".repeat(64),"callerGit":snapshot,"resolver":resolver,"developerSelector":selector,"developerDirectory":"/Developer","developerIdentity":{"physicalPath":"/Developer","device":"1","inode":"18446744073709551615","mode":16877,"modifiedSeconds":4,"modifiedNanoseconds":0,"changedSeconds":5,"changedNanoseconds":0},"implementation":snapshot,"provenance":{"authenticator":"Security.framework/SecStaticCodeCheckValidity/all-architectures+strict/no-network","requirements":["identifier \"com.apple.git\" and anchor apple","identifier \"com.apple.dt.xcode_select.tool-shim-public\" and anchor apple","identifier \"com.apple.xcrun\" and anchor apple","identifier \"com.apple.xcode-select\" and anchor apple"],"loaderTcb":["macos-platform-loader","apple-code-signing-trust-store","Security.framework","CoreFoundation.framework", "CoreServices.framework","libSystem","libz","libiconv"]}})
    }
    #[test]
    fn observed_distribution_versions_preserve_missing_null_and_provenance_boundaries() {
        // Schema consistency only: synthetic evidence cannot mint a live receipt.
        assert_eq!(validate_value(fixture()), Ok(()));
        let mut value = fixture();
        value["gitDistribution"] = Value::Null;
        assert!(validate_value(value).is_err());
        let mut value = fixture();
        value["gitDistribution"] = git_observation();
        assert!(validate_value(value).is_err());
        let mut value = fixture();
        value["schema"] = json!("caws.runtime.stop-semantic-profile.v2");
        assert!(validate_value(value.clone()).is_err());
        value["gitDistribution"] = Value::Null;
        assert!(validate_value(value.clone()).is_err());
        value["gitDistribution"] = git_observation();
        assert_eq!(validate_value(value.clone()), Ok(()));
        for changed in [
            "unknown",
            "missing provenance",
            "wrong native image",
            "supplied permission",
        ] {
            let mut bad = value.clone();
            match changed {
                "unknown" => bad["gitDistribution"]["platform"] = json!("custom"),
                "missing provenance" => {
                    bad["gitDistribution"]
                        .as_object_mut()
                        .unwrap()
                        .remove("provenance");
                }
                "wrong native image" => {
                    bad["gitDistribution"]["inspectorNativeSha256"] = json!("f".repeat(64))
                }
                _ => bad["gitDistribution"]["permission"] = json!(true),
            }
            assert!(validate_value(bad).is_err(), "{changed}");
        }
    }
}
