//! One request-owned scope strike operation. The engine never selects state paths.
//! Typed publication evidence survives transport and terminal failure; no replay.
use caws_native::{
    context_git::file_tools::Preparation,
    guard_strikes::{CommittedStrike, Error, StrikeIdentity, StrikeStore, TransactionBudget},
    monotonic_deadline::MonotonicDeadline,
};
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use serde_json::value::RawValue;
use std::{fmt, path::PathBuf, time::Instant};

pub(crate) const CAPABILITY: &str = "caws.runtime.guard-strikes.v1";
pub(crate) const REQUEST_SCHEMA: &str = "caws.runtime.guard-strikes.request.v1";
const RESULT_SCHEMA: &str = "caws.runtime.guard-strikes.result.v1";
pub(crate) const NATIVE_CAPABILITY: &str = "caws.runtime.guard-strikes.v2";
pub(crate) const NATIVE_REQUEST_SCHEMA: &str = "caws.runtime.guard-strikes.request.v2";
const NATIVE_RESULT_SCHEMA: &str = "caws.runtime.guard-strikes.result.v2";
pub(crate) const MAX_REQUEST: usize = 1024;
pub(crate) const MAX_CONTROL_CREDIT: usize = MAX_REQUEST + 1;
const MAX_REPLY: usize = 4096;
const MAX_COUNT: u64 = 9_007_199_254_740_991;

/// Only protocol::Request supplies this, before the engine starts. No decoder.
pub(crate) struct OriginalInput<'a> {
    pub id: &'a str,
    pub runtime_digest: &'a str,
    pub home: Option<&'a str>,
    pub payload: &'a RawValue,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attempt {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
}
fn lower_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
// Match original JSON member semantics without decoding unrelated payload data.
// RawValue preserves numbers/strings belonging to other handlers.
struct PayloadSession(Option<Box<RawValue>>);
impl<'de> Deserialize<'de> for PayloadSession {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Top;
        impl<'de> Visitor<'de> for Top {
            type Value = PayloadSession;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("original payload object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut session = None;
                while let Some(key) = map.next_key::<String>()? {
                    let value = map.next_value::<Box<RawValue>>()?;
                    if key == "session_id" {
                        session = Some(value);
                    }
                }
                Ok(PayloadSession(session))
            }
        }
        decoder.deserialize_map(Top)
    }
}
fn original_session(payload: &RawValue) -> Result<String, String> {
    let PayloadSession(raw) =
        serde_json::from_str(payload.get()).map_err(|e| format!("original strike session: {e}"))?;
    let raw = raw.ok_or("scope strike requires original session_id")?;
    serde_json::from_str(raw.get())
        .map_err(|e| format!("original strike session is not a string: {e}"))
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum NativeOperation {
    #[serde(rename = "increment_scope_guard")]
    ScopeGuard,
    #[serde(rename = "increment_shortcut_language")]
    ShortcutLanguage,
}
impl NativeOperation {
    fn index(self) -> usize {
        match self {
            Self::ScopeGuard => 0,
            Self::ShortcutLanguage => 1,
        }
    }
    fn action(self) -> &'static str {
        match self {
            Self::ScopeGuard => "increment_scope_guard",
            Self::ShortcutLanguage => "increment_shortcut_language",
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::ScopeGuard => "scope_guard",
            Self::ShortcutLanguage => "shortcut_language",
        }
    }
    fn phase(self) -> caws_native::context_git::file_tools::NativeStrikePhase {
        use caws_native::context_git::file_tools::NativeStrikePhase;
        match self {
            Self::ScopeGuard => NativeStrikePhase::ScopeGuard,
            Self::ShortcutLanguage => NativeStrikePhase::ShortcutLanguage,
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeAttempt {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    operation: NativeOperation,
    context_snapshot_token: String,
}
#[derive(Default)]
struct NativeSlot {
    attempted: bool,
    delivered: bool,
    publication: Option<CommittedStrike>,
    failure: Option<Error>,
}
#[derive(Default)]
struct NativeLedger {
    slots: [NativeSlot; 2],
    pending: Option<NativeAttempt>,
    pending_delivery: Option<usize>,
    poisoned: bool,
}

pub(crate) struct Owner {
    id: String,
    runtime_digest: String,
    home: Option<PathBuf>,
    payload: Box<RawValue>,
    original: MonotonicDeadline,
    attempted: bool,
    dispatch_written: bool,
    dispatch_active: bool,
    publication: Option<CommittedStrike>,
    // Own the error, including uncertain-publication status, through fallback.
    failure: Option<Error>,
    native: Option<NativeLedger>,
    native_session: Option<Result<String, String>>,
}
impl Owner {
    pub(crate) fn retain(input: OriginalInput<'_>, original: &MonotonicDeadline) -> Self {
        Self {
            id: input.id.into(),
            runtime_digest: input.runtime_digest.into(),
            home: input.home.map(PathBuf::from),
            payload: input.payload.to_owned(),
            original: original.clone(),
            attempted: false,
            dispatch_written: false,
            dispatch_active: false,
            publication: None,
            failure: None,
            native: None,
            native_session: None,
        }
    }
    pub(crate) fn retain_native(input: OriginalInput<'_>, original: &MonotonicDeadline) -> Self {
        Self::retain_native_for_surface(input, "claude-code", original)
    }
    pub(crate) fn retain_native_for_surface(
        input: OriginalInput<'_>,
        surface: &str,
        original: &MonotonicDeadline,
    ) -> Self {
        let mut owner = Self::retain(input, original);
        owner.native_session = Some(
            caws_native::context_git::file_tools::operation::capture(surface, &owner.payload)
                .map(|operation| operation.session_id),
        );
        owner.native = Some(NativeLedger::default());
        owner
    }
    fn retained_native_session(&self) -> Result<&str, String> {
        self.native_session
            .as_ref()
            .ok_or("native strike lacks retained original session validation")?
            .as_ref()
            .map(String::as_str)
            .map_err(|error| error.clone())
    }
    pub(crate) fn control_credit_limit(&self) -> usize {
        if self.native.is_some() {
            2 * MAX_CONTROL_CREDIT
        } else {
            MAX_CONTROL_CREDIT
        }
    }
    pub(crate) fn poison(&mut self) {
        if let Some(ledger) = self.native.as_mut() {
            ledger.poisoned = true;
        }
    }
    pub(crate) fn result_delivered(&mut self) -> Result<(), String> {
        let result = (|| {
            let Some(ledger) = self.native.as_mut() else {
                return Ok(());
            };
            let index = ledger
                .pending_delivery
                .take()
                .ok_or("native strike has no pending result delivery")?;
            let slot = &mut ledger.slots[index];
            if ledger.poisoned
                || !slot.attempted
                || slot.delivered
                || slot.publication.is_none()
                || slot.failure.is_some()
            {
                return Err("native strike delivery phase differs; no replay".into());
            }
            slot.delivered = true;
            Ok(())
        })();
        if result.is_err() {
            self.poison();
        }
        result
    }
    /// Called only after the actual dispatch frame has been completely written.
    pub(crate) fn grant_written(&mut self, active: bool) -> Result<(), String> {
        if self.attempted || self.dispatch_written {
            return Err("scope strike dispatch cannot be replayed or upgraded".into());
        }
        self.dispatch_written = true;
        self.dispatch_active = active;
        Ok(())
    }
    pub(crate) fn begin(&mut self, bytes: &[u8]) -> Result<Attempt, String> {
        if self.native.is_some() {
            return self.begin_native(bytes);
        }
        // Even a malformed or premature recognized attempt permanently consumes.
        if std::mem::replace(&mut self.attempted, true) {
            return Err("scope strike attempt already consumed; no replay".into());
        }
        if bytes.len() > MAX_REQUEST {
            return Err("scope strike request exceeds frame bound".into());
        }
        let control: Attempt =
            serde_json::from_slice(bytes).map_err(|e| format!("scope strike request: {e}"))?;
        if control.schema != REQUEST_SCHEMA
            || control.id != self.id
            || control.runtime_digest != self.runtime_digest
            || !lower_hex(&control.token)
        {
            return Err("scope strike request identity or token differs".into());
        }
        if !self.dispatch_written || !self.dispatch_active {
            return Err("scope strike requires successful active dispatch grant".into());
        }
        Ok(control)
    }
    pub(crate) fn execute(
        &mut self,
        control: Attempt,
        context: Option<&Preparation>,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<u8>, String> {
        if self.native.is_some() {
            let result = self.execute_native(control, context, until, cancelled);
            if result.is_err() {
                self.poison();
            }
            return result;
        }
        self.original.check().map_err(|e| e.to_string())?;
        if cancelled() || Instant::now() >= until.min(self.original.expires()) {
            return Err("original scope strike cancelled or expired".into());
        }
        let roots = context
            .ok_or("scope strike lacks original file-tool context")?
            .scope_strike_roots(
                &self.id,
                &self.runtime_digest,
                &self.original,
                until,
                cancelled,
            )?;
        let home = self
            .home
            .as_deref()
            .ok_or("scope strike lacks original HOME")?;
        let text = home.to_str().ok_or("original HOME is not UTF-8")?;
        if !home.is_absolute() || text.len() > 4096 || text.contains('\0') {
            return Err("original HOME is outside the absolute path domain".into());
        }
        let raw_sid = original_session(&self.payload)?;
        let identity = StrikeIdentity::resolve(&raw_sid).map_err(|e| e.to_string())?;
        let filename = format!("guard-strikes-{}.json", identity.sanitized());
        let legacy = [
            roots.checkout().join(".codex/logs").join(&filename),
            roots.git_dir().join("caws-guard-strikes").join(&filename),
        ];
        let budget = TransactionBudget::original(&self.original, until, cancelled);
        let result = StrikeStore::open(&home.join(".caws"), identity, budget)
            .and_then(|store| store.increment_scope_guard(&legacy, budget));
        // Record BEFORE encoding, cancellation checks, or a possible failed write.
        self.retain_result(result)?;
        result_frame(
            &control,
            self.publication
                .as_ref()
                .ok_or("scope strike publication missing")?,
        )
    }
    fn begin_native(&mut self, bytes: &[u8]) -> Result<Attempt, String> {
        self.attempted = true;
        let result = (|| {
            self.retained_native_session()?;
            let ledger = self.native.as_mut().unwrap();
            if ledger.poisoned
                || ledger.pending.is_some()
                || ledger.pending_delivery.is_some()
                || bytes.len() > MAX_REQUEST
            {
                return Err("native strike exhausted, poisoned or oversized; no replay".into());
            }
            let control: NativeAttempt = serde_json::from_slice(bytes)
                .map_err(|error| format!("native strike request: {error}"))?;
            let slot = &mut ledger.slots[control.operation.index()];
            if std::mem::replace(&mut slot.attempted, true) {
                return Err("native strike operation already consumed; no replay".into());
            }
            if control.schema != NATIVE_REQUEST_SCHEMA
                || control.id != self.id
                || control.runtime_digest != self.runtime_digest
                || !lower_hex(&control.token)
                || !lower_hex(&control.context_snapshot_token)
                || !self.dispatch_written
                || !self.dispatch_active
            {
                return Err(
                    "native strike original identity, token or active dispatch differs".into(),
                );
            }
            let carrier = Attempt {
                schema: control.schema.clone(),
                id: control.id.clone(),
                runtime_digest: control.runtime_digest.clone(),
                token: control.token.clone(),
            };
            ledger.pending = Some(control);
            Ok(carrier)
        })();
        if result.is_err() {
            self.poison();
        }
        result
    }
    fn execute_native(
        &mut self,
        control: Attempt,
        context: Option<&Preparation>,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<u8>, String> {
        let pending = self
            .native
            .as_mut()
            .unwrap()
            .pending
            .take()
            .ok_or("native strike lacks retained one-shot attempt")?;
        if control.schema != pending.schema
            || control.id != pending.id
            || control.runtime_digest != pending.runtime_digest
            || control.token != pending.token
        {
            return Err("native strike retained attempt differs; no replay".into());
        }
        self.original.check().map_err(|error| error.to_string())?;
        if cancelled() || Instant::now() >= until.min(self.original.expires()) {
            return Err("original native strike cancelled or expired".into());
        }
        // Original context supplies roots and phase standing. Neither a request
        // nor a strike count grants path/spec/ownership authority.
        let _roots = context
            .ok_or("native strike lacks original file context")?
            .native_strike_roots(
                pending.operation.phase(),
                &pending.token,
                &pending.context_snapshot_token,
                &self.id,
                &self.runtime_digest,
                &self.original,
                until,
                cancelled,
            )?;
        let home = self
            .home
            .as_deref()
            .ok_or("native strike lacks original HOME")?;
        let text = home.to_str().ok_or("original HOME is not UTF-8")?;
        if !home.is_absolute() || text.len() > 4096 || text.contains('\0') {
            return Err("original HOME is outside the absolute path domain".into());
        }
        let raw_session = self.retained_native_session()?;
        let identity = StrikeIdentity::resolve(raw_session).map_err(|error| error.to_string())?;
        if identity.sanitized() != raw_session {
            return Err("native session requires a lossless strike bucket identity".into());
        }
        let budget = TransactionBudget::original(&self.original, until, cancelled);
        let result =
            StrikeStore::open_original_home(home, identity, budget).and_then(|store| match pending
                .operation
            {
                NativeOperation::ScopeGuard => store.increment_scope_guard(&[], budget),
                NativeOperation::ShortcutLanguage => store.increment_shortcut_language(&[], budget),
            });
        let index = pending.operation.index();
        // Completed or uncertain publication stays with the original owner
        // before encoding, cancellation handling or attempted result delivery.
        let slot = &mut self.native.as_mut().unwrap().slots[index];
        match result {
            Ok(publication) => slot.publication = Some(publication),
            Err(error) => {
                slot.publication = error.publication.clone();
                slot.failure = Some(error);
                return Err(slot.failure.as_ref().unwrap().to_string());
            }
        }
        let publication = slot.publication.as_ref().unwrap();
        if !valid_receipt(publication) {
            return Err("native strike core returned invalid publication; no replay".into());
        }
        let mut reply = serde_json::to_vec(&serde_json::json!({
            "schema":NATIVE_RESULT_SCHEMA,
            "id":pending.id,
            "runtimeDigest":pending.runtime_digest,
            "token":pending.token,
            "operation":pending.operation.action(),
            "contextSnapshotToken":pending.context_snapshot_token,
            "count":publication.count,
            "stateSha256":publication.state_sha256
        }))
        .map_err(|error| error.to_string())?;
        if reply.len() > MAX_REPLY {
            return Err("native strike reply exceeds frame bound; no replay".into());
        }
        reply.push(b'\n');
        self.native.as_mut().unwrap().pending_delivery = Some(index);
        Ok(reply)
    }
    fn retain_result(&mut self, result: Result<CommittedStrike, Error>) -> Result<(), String> {
        match result {
            Ok(committed) => {
                self.publication = Some(committed);
                Ok(())
            }
            Err(error) => {
                self.publication = error.publication.clone();
                self.failure = Some(error);
                Err(self.failure.as_ref().unwrap().to_string())
            }
        }
    }
    pub(crate) fn terminal_note(&self) -> Option<String> {
        if let Some(ledger) = self.native.as_ref() {
            if !self.attempted {
                return None;
            }
            let mut notes = Vec::new();
            for operation in [
                NativeOperation::ScopeGuard,
                NativeOperation::ShortcutLanguage,
            ] {
                let slot = &ledger.slots[operation.index()];
                if !slot.attempted {
                    continue;
                }
                let status = slot
                    .failure
                    .as_ref()
                    .map(|error| format!("{:?}", error.kind))
                    .unwrap_or_else(|| {
                        if slot.delivered {
                            "delivered".into()
                        } else {
                            "delivery_unconfirmed".into()
                        }
                    });
                let publication = match slot.publication.as_ref().filter(|p| valid_receipt(p)) {
                    Some(receipt) => format!(
                        "count={}; stateSha256={}",
                        receipt.count, receipt.state_sha256
                    ),
                    None => "publication unconfirmed".into(),
                };
                notes.push(format!(
                    "Native strike {} retained: status={status}; {publication}; no retry.",
                    operation.key()
                ));
            }
            if notes.is_empty() {
                notes.push(
                    "Native strike malformed attempt retained; publication unconfirmed; no retry."
                        .into(),
                );
            }
            return Some(notes.join(" "));
        }
        if !self.attempted {
            return None;
        }
        let status = self
            .failure
            .as_ref()
            .map(|e| format!("{:?}", e.kind))
            .unwrap_or_else(|| "observed".into());
        match self.publication.as_ref().filter(|p| valid_receipt(p)) {
            Some(receipt) => Some(format!(
                "Scope strike publication retained: status={status}; count={}; stateSha256={}; no retry.",
                receipt.count, receipt.state_sha256
            )),
            None => Some(format!(
                "Scope strike attempt retained: status={status}; publication unconfirmed; no retry."
            )),
        }
    }
}
fn valid_receipt(receipt: &CommittedStrike) -> bool {
    (1..=MAX_COUNT).contains(&receipt.count) && lower_hex(&receipt.state_sha256)
}
fn result_frame(control: &Attempt, receipt: &CommittedStrike) -> Result<Vec<u8>, String> {
    if !valid_receipt(receipt) {
        return Err("scope strike core returned an invalid publication receipt; no replay".into());
    }
    let mut bytes = serde_json::to_vec(&serde_json::json!({"schema":RESULT_SCHEMA,
        "id":control.id,"runtimeDigest":control.runtime_digest,"token":control.token,
        "count":receipt.count,"stateSha256":receipt.state_sha256}))
    .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REPLY {
        return Err("scope strike reply exceeds frame bound; no replay".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn owner() -> Owner {
        let payload = RawValue::from_string(r#"{"session_id":"original-session"}"#.into()).unwrap();
        Owner::retain(
            OriginalInput {
                id: "original",
                runtime_digest: &"a".repeat(64),
                home: Some("/original-home"),
                payload: &payload,
            },
            &MonotonicDeadline::capture(Duration::from_secs(2)).unwrap(),
        )
    }
    fn frame() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"schema":REQUEST_SCHEMA,"id":"original","runtimeDigest":"a".repeat(64),"token":"b".repeat(64)})).unwrap()
    }
    #[test]
    fn strict_decode_consumes_unknown_duplicate_missing_forged_and_oversized_attempts() {
        let value: serde_json::Value = serde_json::from_slice(&frame()).unwrap();
        let mut invalid = vec![vec![b' '; MAX_REQUEST + 1], b"{".to_vec()];
        for (key, value) in [
            ("schema", serde_json::json!("other")),
            ("id", serde_json::json!("neighbor")),
            ("runtimeDigest", serde_json::json!("c".repeat(64))),
            ("token", serde_json::json!("B".repeat(64))),
            ("home", serde_json::json!("/neighbor")),
            ("guard", serde_json::json!("other")),
            ("session_id", serde_json::json!("neighbor")),
            ("path", serde_json::json!("/neighbor")),
            ("argv", serde_json::json!(["reset"])),
        ] {
            let mut row: serde_json::Value = serde_json::from_slice(&frame()).unwrap();
            row[key] = value;
            invalid.push(serde_json::to_vec(&row).unwrap());
        }
        for field in ["schema", "id", "runtimeDigest", "token"] {
            let mut row = value.clone();
            row.as_object_mut().unwrap().remove(field);
            invalid.push(serde_json::to_vec(&row).unwrap());
        }
        let text = String::from_utf8(frame()).unwrap();
        invalid.push(
            text.replacen(
                "\"id\":\"original\"",
                "\"id\":\"original\",\"id\":\"original\"",
                1,
            )
            .into_bytes(),
        );
        for bytes in invalid {
            let mut owner = owner();
            owner.grant_written(true).unwrap();
            assert!(
                owner.begin(&bytes).is_err(),
                "{}",
                String::from_utf8_lossy(&bytes)
            );
            assert!(owner.attempted && owner.publication.is_none());
            assert!(owner.begin(&frame()).unwrap_err().contains("consumed"));
        }
    }
    #[test]
    fn grant_is_actual_active_and_cannot_upgrade_a_premature_attempt() {
        let mut early = owner();
        assert!(early.begin(&frame()).is_err());
        assert!(early.grant_written(true).is_err());
        let mut inactive = owner();
        inactive.grant_written(false).unwrap();
        assert!(inactive.begin(&frame()).is_err());
        let mut unused = owner();
        assert!(unused.terminal_note().is_none());
        unused.grant_written(true).unwrap();
        assert!(unused.terminal_note().is_none());
        assert!(unused.grant_written(true).is_err());
        assert!(unused.begin(&frame()).is_ok());
        assert!(unused.begin(&frame()).is_err());
    }
    #[test]
    fn count_hash_and_canonical_integer_reply_are_checked_after_publication_retention() {
        let mut owner = owner();
        owner.grant_written(true).unwrap();
        let control = owner.begin(&frame()).unwrap();
        for count in [1, 2, MAX_COUNT] {
            let receipt = CommittedStrike {
                count,
                state_sha256: "c".repeat(64),
            };
            let bytes = result_frame(&control, &receipt).unwrap();
            let text = std::str::from_utf8(&bytes).unwrap();
            assert!(text.contains(&format!("\"count\":{count},")));
            let decoded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.as_object().unwrap().len(), 6);
            assert_eq!(decoded["count"].as_u64(), Some(count));
        }
        for count in [0, MAX_COUNT + 1] {
            assert!(
                result_frame(
                    &control,
                    &CommittedStrike {
                        count,
                        state_sha256: "c".repeat(64)
                    }
                )
                .is_err()
            );
        }
        for hash in [
            "c".repeat(63),
            "C".repeat(64),
            format!("{}\n", "c".repeat(64)),
        ] {
            assert!(
                result_frame(
                    &control,
                    &CommittedStrike {
                        count: 1,
                        state_sha256: hash
                    }
                )
                .is_err()
            );
        }
        // Publication metadata, not an OS-lock proof: a later delivery error
        // cannot discard a completed receipt or allow another attempt.
        owner
            .retain_result(Ok(CommittedStrike {
                count: 2,
                state_sha256: "d".repeat(64),
            }))
            .unwrap();
        let delivery: Result<(), String> = Err("simulated delivery failure".into());
        assert!(delivery.is_err());
        assert_eq!(owner.publication.as_ref().unwrap().count, 2);
        assert!(
            owner
                .terminal_note()
                .unwrap()
                .contains(&format!("count=2; stateSha256={}", "d".repeat(64)))
        );
        assert!(owner.begin(&frame()).is_err());
    }
    #[test]
    fn original_sid_uses_original_last_member_without_decoding_unowned_payload() {
        for (payload, expected) in [
            (
                r#"{"session_id":"earlier","session_id":"final","unowned":1e999}"#,
                "final",
            ),
            (r#"{"session_id":"a:@b"}"#, "a:@b"),
        ] {
            assert_eq!(
                original_session(&RawValue::from_string(payload.into()).unwrap()).unwrap(),
                expected
            );
        }
        for payload in [
            "{}",
            r#"{"session_id":null}"#,
            r#"{"session_id":7}"#,
            r#"{"session_id":"first","session_id":false}"#,
        ] {
            assert!(original_session(&RawValue::from_string(payload.into()).unwrap()).is_err());
        }
    }
    #[test]
    fn absent_context_or_cancelled_original_never_reaches_the_store_and_stays_consumed() {
        for cancelled in [false, true] {
            let mut owner = owner();
            owner.grant_written(true).unwrap();
            let control = owner.begin(&frame()).unwrap();
            assert!(
                owner
                    .execute(control, None, owner.original.expires(), &|| cancelled)
                    .is_err()
            );
            assert!(owner.publication.is_none() && owner.failure.is_none());
            assert!(owner.begin(&frame()).is_err());
        }
    }
}
