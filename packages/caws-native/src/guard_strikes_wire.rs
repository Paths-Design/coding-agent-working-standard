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
use std::{
    fmt,
    path::PathBuf,
    time::Instant,
};

pub(crate) const CAPABILITY: &str = "caws.runtime.guard-strikes.v1";
pub(crate) const REQUEST_SCHEMA: &str = "caws.runtime.guard-strikes.request.v1";
const RESULT_SCHEMA: &str = "caws.runtime.guard-strikes.result.v1";
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
        }
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
