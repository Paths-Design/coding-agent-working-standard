//! Private framing and correlation only. No observation here confers launch authority.
//! The caller must independently establish child exit/EOF, its original deadline,
//! host association, fence ownership and one-use execution before any effect.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const REQUEST_LIMIT: usize = 4 * 1024 * 1024;
pub(crate) const REPLY_LIMIT: usize = 64 * 1024;
const PROTOCOL: &str = "caws.execution.authorizer.v1";
const REASON_CODES: &[&str] = &[
    "invalid_frame",
    "invalid_record",
    "identity_unverified",
    "context_unresolved",
    "unsupported_profile",
    "source_unresolved",
    "source_denied",
    "binding_unavailable",
    "foreign_owner",
    "scope_refused",
    "authority_changed",
    "fence_unverified",
    "deadline_expired",
    "cancelled",
    "infrastructure_unavailable",
];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WireError {
    Frame,
    Schema,
    Identity,
    Record,
    Correlation,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Analyze,
    FinalValidate,
}

// Unlike Option<T>, this type rejects a missing field while accepting explicit null.
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum Nullable<T> {
    Null(()),
    Value(T),
}

impl<T> Nullable<T> {
    fn as_ref(&self) -> Option<&T> {
        match self {
            Self::Null(()) => None,
            Self::Value(value) => Some(value),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Fence {
    dev: String,
    ino: String,
    nonce: String,
}

impl Fence {
    pub(crate) fn new(dev: u64, ino: u64, nonce: String) -> Result<Self, WireError> {
        let fence = Self {
            dev: dev.to_string(),
            ino: ino.to_string(),
            nonce,
        };
        fence.validate()?;
        Ok(fence)
    }

    fn validate(&self) -> Result<(), WireError> {
        for value in [&self.dev, &self.ino] {
            let parsed = value.parse::<u64>().map_err(|_| WireError::Identity)?;
            if parsed.to_string() != *value {
                return Err(WireError::Identity);
            }
        }
        bounded_text(&self.nonce, 256)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol: String,
    phase: Phase,
    invocation_id: String,
    record_base64: String,
    execution_digest: String,
    expected_authority_revision: Nullable<String>,
    fence: Nullable<Fence>,
}

/// Owns the exact record bytes, without reconstructing their JSON representation.
/// Deliberately has no Debug implementation: records may contain private inputs.
pub(crate) struct RequestRecord {
    envelope: Request,
    record: Vec<u8>,
}

impl RequestRecord {
    pub(crate) fn new(
        phase: Phase,
        invocation_id: String,
        record: Vec<u8>,
        revision: Option<String>,
        fence: Option<Fence>,
    ) -> Result<Self, WireError> {
        if record.len() > REQUEST_LIMIT {
            return Err(WireError::Record);
        }
        let envelope = Request {
            protocol: PROTOCOL.into(),
            phase,
            invocation_id,
            record_base64: STANDARD.encode(&record),
            execution_digest: digest(&record),
            expected_authority_revision: revision.map_or(Nullable::Null(()), Nullable::Value),
            fence: fence.map_or(Nullable::Null(()), Nullable::Value),
        };
        let result = Self { envelope, record };
        result.validate()?;
        // Apply the actual envelope limit, including base64 and metadata overhead.
        result.encode()?;
        Ok(result)
    }

    pub(crate) fn decode(payload: &[u8]) -> Result<Self, WireError> {
        if payload.is_empty() || payload.len() > REQUEST_LIMIT {
            return Err(WireError::Frame);
        }
        validate_representation(payload, true)?;
        let envelope: Request = serde_json::from_slice(payload).map_err(|_| WireError::Schema)?;
        let record = STANDARD
            .decode(&envelope.record_base64)
            .map_err(|_| WireError::Record)?;
        let result = Self { envelope, record };
        result.validate()?;
        Ok(result)
    }

    fn validate(&self) -> Result<(), WireError> {
        let e = &self.envelope;
        if e.protocol != PROTOCOL {
            return Err(WireError::Schema);
        }
        bounded_text(&e.invocation_id, 256)?;
        let text = std::str::from_utf8(&self.record).map_err(|_| WireError::Record)?;
        serde_json::from_str::<&serde_json::value::RawValue>(text)
            .map_err(|_| WireError::Record)?;
        if STANDARD.encode(&self.record) != e.record_base64
            || digest(&self.record) != e.execution_digest
        {
            return Err(WireError::Record);
        }
        match (
            e.phase,
            e.expected_authority_revision.as_ref(),
            e.fence.as_ref(),
        ) {
            (Phase::Analyze, None, None) => Ok(()),
            (Phase::FinalValidate, Some(revision), Some(fence)) => {
                bounded_text(revision, 256)?;
                fence.validate()
            }
            _ => Err(WireError::Schema),
        }
    }

    pub(crate) fn record_bytes(&self) -> &[u8] {
        &self.record
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, WireError> {
        let payload = serde_json::to_vec(&self.envelope).map_err(|_| WireError::Schema)?;
        encode_frame(&payload, REQUEST_LIMIT)
    }

    pub(crate) fn correlate_reply(&self, payload: &[u8]) -> Result<ReplyObservation, WireError> {
        if payload.is_empty() || payload.len() > REPLY_LIMIT {
            return Err(WireError::Frame);
        }
        validate_representation(payload, false)?;
        let reply: Reply = serde_json::from_slice(payload).map_err(|_| WireError::Schema)?;
        if reply.protocol != PROTOCOL
            || reply.phase != self.envelope.phase
            || reply.invocation_id != self.envelope.invocation_id
            || reply.execution_digest != self.envelope.execution_digest
        {
            return Err(WireError::Correlation);
        }
        if let Some(revision) = reply.authority_revision.as_ref() {
            bounded_text(revision, 256)?;
        }
        if reply.reason_codes.len() > 32 {
            return Err(WireError::Schema);
        }
        for reason in &reply.reason_codes {
            if !REASON_CODES.contains(&reason.as_str()) {
                return Err(WireError::Schema);
            }
        }
        if reply.decision == Decision::Allow
            && reply.phase == Phase::FinalValidate
            && reply.authority_revision.as_ref()
                != self.envelope.expected_authority_revision.as_ref()
        {
            return Err(WireError::Correlation);
        }
        Ok(ReplyObservation { reply })
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Decision {
    Allow,
    Deny,
    Unresolved,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    protocol: String,
    phase: Phase,
    invocation_id: String,
    execution_digest: String,
    decision: Decision,
    authority_revision: Nullable<String>,
    reason_codes: Vec<String>,
}

/// A parsed observation, never a launch permit or proof of physical EOF/exit.
pub(crate) struct ReplyObservation {
    reply: Reply,
}

impl ReplyObservation {
    pub(crate) fn decision(&self) -> Decision {
        self.reply.decision
    }
    pub(crate) fn authority_revision(&self) -> Option<&str> {
        self.reply.authority_revision.as_ref().map(String::as_str)
    }
    pub(crate) fn reason_codes(&self) -> &[String] {
        &self.reply.reason_codes
    }
}

// Serde structs also accept positional sequences and unit enums accept object
// variants. The wire contract requires objects with string enum values. This
// representation check does not replace parsing the ORIGINAL bytes into the
// deny_unknown_fields structs: that second parse preserves duplicate-key refusal.
fn validate_representation(payload: &[u8], request: bool) -> Result<(), WireError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| WireError::Schema)?;
    let object = value.as_object().ok_or(WireError::Schema)?;
    if object
        .get("phase")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err(WireError::Schema);
    }
    if request {
        match object.get("fence") {
            Some(serde_json::Value::Null | serde_json::Value::Object(_)) => (),
            _ => return Err(WireError::Schema),
        }
    } else if object
        .get("decision")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err(WireError::Schema);
    }
    Ok(())
}

fn bounded_text(value: &str, limit: usize) -> Result<(), WireError> {
    if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        Err(WireError::Identity)
    } else {
        Ok(())
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn encode_frame(payload: &[u8], limit: usize) -> Result<Vec<u8>, WireError> {
    if payload.is_empty() || payload.len() > limit {
        return Err(WireError::Frame);
    }
    let size = u32::try_from(payload.len()).map_err(|_| WireError::Frame)?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&size.to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Incremental one-frame decoder. finish consumes it at caller-reported EOF;
/// this type cannot establish an actual pipe EOF, child exit or process settlement.
pub(crate) struct FrameDecoder {
    limit: usize,
    header: Vec<u8>,
    payload: Vec<u8>,
    expected: Option<usize>,
    failed: bool,
}

impl FrameDecoder {
    pub(crate) fn request() -> Self {
        Self::new(REQUEST_LIMIT)
    }
    pub(crate) fn reply() -> Self {
        Self::new(REPLY_LIMIT)
    }
    fn new(limit: usize) -> Self {
        Self {
            limit,
            header: Vec::with_capacity(4),
            payload: Vec::new(),
            expected: None,
            failed: false,
        }
    }

    pub(crate) fn push(&mut self, mut bytes: &[u8]) -> Result<(), WireError> {
        if self.failed {
            return Err(WireError::Frame);
        }
        let result = self.push_inner(&mut bytes);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn push_inner(&mut self, bytes: &mut &[u8]) -> Result<(), WireError> {
        if self.header.len() < 4 {
            let take = (4 - self.header.len()).min(bytes.len());
            self.header.extend_from_slice(&bytes[..take]);
            *bytes = &bytes[take..];
            if self.header.len() < 4 {
                return Ok(());
            }
            let size = u32::from_be_bytes(self.header[..].try_into().unwrap()) as usize;
            if size == 0 || size > self.limit {
                return Err(WireError::Frame);
            }
            self.expected = Some(size);
        }
        let remaining = self.expected.unwrap() - self.payload.len();
        if bytes.len() > remaining {
            return Err(WireError::Frame);
        }
        self.payload.extend_from_slice(bytes);
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<Vec<u8>, WireError> {
        if self.failed || self.expected != Some(self.payload.len()) {
            return Err(WireError::Frame);
        }
        Ok(self.payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn request(phase: Phase) -> RequestRecord {
        RequestRecord::new(
            phase,
            "inv-α".into(),
            " {\"é\":\"\\u0061\"}\n".as_bytes().to_vec(),
            (phase == Phase::FinalValidate).then(|| "revision-1".into()),
            (phase == Phase::FinalValidate)
                .then(|| Fence::new(0, u64::MAX, "nonce".into()).unwrap()),
        )
        .unwrap()
    }
    fn request_json(request: &RequestRecord) -> Value {
        serde_json::from_slice(&request.encode().unwrap()[4..]).unwrap()
    }
    fn reply(request: &RequestRecord) -> Value {
        json!({"protocol":PROTOCOL,"phase":request.envelope.phase,
            "invocationId":request.envelope.invocation_id,
            "executionDigest":request.envelope.execution_digest,"decision":"allow",
            "authorityRevision":request.envelope.expected_authority_revision,"reasonCodes":[]})
    }
    fn accepts(request: &RequestRecord, value: &Value) -> bool {
        request
            .correlate_reply(&serde_json::to_vec(value).unwrap())
            .is_ok()
    }
    fn decodes(value: &Value) -> bool {
        RequestRecord::decode(&serde_json::to_vec(value).unwrap()).is_ok()
    }

    #[test]
    fn original_record_bytes_and_independent_sha_are_preserved() {
        for phase in [Phase::Analyze, Phase::FinalValidate] {
            let original = request(phase);
            assert_eq!(
                original.envelope.execution_digest,
                "45212cc7bd6549900344a047de87d115bb1373a0582a8f0106199f95372a0259"
            );
            let frame = original.encode().unwrap();
            assert_eq!(
                u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
                frame.len() - 4
            );
            let decoded = RequestRecord::decode(&frame[4..]).unwrap();
            assert_eq!(decoded.record_bytes(), original.record_bytes());
            assert_eq!(decoded.encode().unwrap(), frame);
            let parsed: Value = serde_json::from_slice(original.record_bytes()).unwrap();
            assert_ne!(
                digest(&serde_json::to_vec(&parsed).unwrap()),
                original.envelope.execution_digest
            );
        }
    }

    #[test]
    fn protocol_limits_accept_exact_sized_valid_json_and_refuse_one_more_byte() {
        // Protocol sizes are independent oracle values, not derived from the
        // implementation constant that mutation testing can change.
        assert_eq!(REQUEST_LIMIT, 4_194_304);
        assert_eq!(REPLY_LIMIT, 65_536);
        let req = request(Phase::Analyze);
        let mut payload = serde_json::to_vec(&request_json(&req)).unwrap();
        payload.resize(4_194_304, b' ');
        assert_eq!(
            RequestRecord::decode(&payload).unwrap().record_bytes(),
            req.record_bytes()
        );
        payload.push(b' ');
        assert!(matches!(
            RequestRecord::decode(&payload),
            Err(WireError::Frame)
        ));
        assert!(matches!(RequestRecord::decode(&[]), Err(WireError::Frame)));
        let mut payload = serde_json::to_vec(&reply(&req)).unwrap();
        payload.resize(65_536, b' ');
        assert!(req.correlate_reply(&payload).unwrap().decision() == Decision::Allow);
        payload.push(b' ');
        assert!(matches!(
            req.correlate_reply(&payload),
            Err(WireError::Frame)
        ));
        assert!(matches!(req.correlate_reply(&[]), Err(WireError::Frame)));
    }

    #[test]
    fn positional_arrays_cannot_replace_keyed_envelopes_or_fence() {
        for phase in [Phase::Analyze, Phase::FinalValidate] {
            let req = request(phase);
            let r = request_json(&req);
            let sequence = json!([
                r["protocol"],
                r["phase"],
                r["invocationId"],
                r["recordBase64"],
                r["executionDigest"],
                r["expectedAuthorityRevision"],
                r["fence"]
            ]);
            assert!(!decodes(&sequence), "request must be a keyed object");
            let r = reply(&req);
            let sequence = json!([
                r["protocol"],
                r["phase"],
                r["invocationId"],
                r["executionDigest"],
                r["decision"],
                r["authorityRevision"],
                r["reasonCodes"]
            ]);
            assert!(!accepts(&req, &sequence), "reply must be a keyed object");
        }
        let mut r = request_json(&request(Phase::FinalValidate));
        r["fence"] = json!(["0", "18446744073709551615", "nonce"]);
        assert!(!decodes(&r), "fence must be a keyed object");
    }

    #[test]
    fn enum_objects_cannot_replace_protocol_strings() {
        for phase in [Phase::Analyze, Phase::FinalValidate] {
            let req = request(phase);
            let name = if phase == Phase::Analyze {
                "analyze"
            } else {
                "final_validate"
            };
            let mut r = request_json(&req);
            r["phase"] = json!({name:null});
            assert!(!decodes(&r));
            let mut r = reply(&req);
            r["phase"] = json!({name:null});
            assert!(!accepts(&req, &r));
            for decision in ["allow", "deny", "unresolved"] {
                let mut r = reply(&req);
                r["decision"] = json!({decision:null});
                assert!(!accepts(&req, &r));
            }
        }
    }

    #[test]
    fn every_split_and_every_partial_eof_are_checked() {
        let req = request(Phase::Analyze);
        let request_frame = req.encode().unwrap();
        let reply_frame =
            encode_frame(&serde_json::to_vec(&reply(&req)).unwrap(), REPLY_LIMIT).unwrap();
        for (frame, limit) in [(&request_frame, REQUEST_LIMIT), (&reply_frame, REPLY_LIMIT)] {
            for split in 0..=frame.len() {
                let mut decoder = FrameDecoder::new(limit);
                decoder.push(&frame[..split]).unwrap();
                decoder.push(&frame[split..]).unwrap();
                assert_eq!(decoder.finish().unwrap(), frame[4..]);
            }
            for end in 0..frame.len() {
                let mut decoder = FrameDecoder::new(limit);
                decoder.push(&frame[..end]).unwrap();
                assert_eq!(decoder.finish(), Err(WireError::Frame));
            }
            let mut decoder = FrameDecoder::new(limit);
            for byte in frame {
                decoder.push(&[*byte]).unwrap();
            }
            assert_eq!(decoder.finish().unwrap(), frame[4..]);
        }
    }

    #[test]
    fn frame_limits_zero_trailing_second_frame_and_poison_are_enforced() {
        for limit in [REQUEST_LIMIT, REPLY_LIMIT] {
            for size in [0, limit + 1, u32::MAX as usize] {
                let mut decoder = FrameDecoder::new(limit);
                assert_eq!(
                    decoder.push(&(size as u32).to_be_bytes()),
                    Err(WireError::Frame)
                );
                assert!(decoder.payload.is_empty());
                assert_eq!(decoder.push(&[]), Err(WireError::Frame));
                assert_eq!(decoder.finish(), Err(WireError::Frame));
            }
            let frame = encode_frame(&vec![b'x'; limit], limit).unwrap();
            let mut decoder = FrameDecoder::new(limit);
            decoder.push(&frame).unwrap();
            assert_eq!(decoder.finish().unwrap().len(), limit);
            assert_eq!(
                encode_frame(&vec![0; limit + 1], limit),
                Err(WireError::Frame)
            );
            for suffix in [vec![0], frame.clone()] {
                let mut decoder = FrameDecoder::new(limit);
                decoder.push(&frame).unwrap();
                assert_eq!(decoder.push(&suffix), Err(WireError::Frame));
                assert_eq!(decoder.push(&[]), Err(WireError::Frame));
                assert_eq!(decoder.finish(), Err(WireError::Frame));
                let mut joined = frame.clone();
                joined.extend(suffix);
                let mut decoder = FrameDecoder::new(limit);
                assert_eq!(decoder.push(&joined), Err(WireError::Frame));
                assert_eq!(decoder.finish(), Err(WireError::Frame));
            }
        }
        let mut request = FrameDecoder::request();
        request.push(&[0, 0, 0, 1, b'x']).unwrap();
        assert_eq!(request.finish().unwrap(), b"x");
        let mut reply = FrameDecoder::reply();
        reply.push(&[0, 0, 0, 1, b'y']).unwrap();
        assert_eq!(reply.finish().unwrap(), b"y");
    }

    #[test]
    fn every_required_key_unknown_and_duplicate_fields_are_rejected() {
        for phase in [Phase::Analyze, Phase::FinalValidate] {
            let request = request(phase);
            let value = request_json(&request);
            for key in value.as_object().unwrap().keys() {
                let mut missing = value.clone();
                missing.as_object_mut().unwrap().remove(key);
                assert!(!decodes(&missing), "missing request key {key}");
                let original = serde_json::to_string(&value).unwrap();
                let duplicate = format!("{{{key:?}:{},{}", value[key], &original[1..]);
                assert!(
                    RequestRecord::decode(duplicate.as_bytes()).is_err(),
                    "duplicate request key {key}"
                );
            }
            let mut unknown = value.clone();
            unknown["extra"] = json!(true);
            assert!(!decodes(&unknown));
            let value = reply(&request);
            for key in value.as_object().unwrap().keys() {
                let mut missing = value.clone();
                missing.as_object_mut().unwrap().remove(key);
                assert!(!accepts(&request, &missing), "missing reply key {key}");
                let original = serde_json::to_string(&value).unwrap();
                let duplicate = format!("{{{key:?}:{},{}", value[key], &original[1..]);
                assert!(
                    request.correlate_reply(duplicate.as_bytes()).is_err(),
                    "duplicate reply key {key}"
                );
            }
            let mut unknown = value;
            unknown["extra"] = json!(true);
            assert!(!accepts(&request, &unknown));
        }
        let value = request_json(&request(Phase::FinalValidate));
        for key in ["dev", "ino", "nonce"] {
            let mut missing = value.clone();
            missing["fence"].as_object_mut().unwrap().remove(key);
            assert!(!decodes(&missing));
            let original = serde_json::to_string(&value).unwrap();
            let marker = "\"fence\":{";
            let duplicate = original.replacen(
                marker,
                &format!("{marker}{key:?}:{},", value["fence"][key]),
                1,
            );
            assert!(RequestRecord::decode(duplicate.as_bytes()).is_err());
        }
        let mut extra = value;
        extra["fence"]["extra"] = json!(0);
        assert!(!decodes(&extra));
    }

    #[test]
    fn malformed_records_base64_digest_and_utf8_are_rejected() {
        let req = request(Phase::Analyze);
        for bytes in [vec![255], b"{".to_vec(), b"{} {}".to_vec(), vec![]] {
            assert!(
                RequestRecord::new(Phase::Analyze, "i".into(), bytes.clone(), None, None).is_err()
            );
            let mut value = request_json(&req);
            value["recordBase64"] = json!(STANDARD.encode(&bytes));
            value["executionDigest"] = json!(digest(&bytes));
            assert!(!decodes(&value));
        }
        for encoded in ["e30", "e31=", "e30=\n", "!!!!"] {
            let mut value = request_json(&req);
            value["recordBase64"] = json!(encoded);
            value["executionDigest"] = json!(digest(b"{}"));
            assert!(!decodes(&value));
        }
        let mut value = request_json(&req);
        value["executionDigest"] = json!("0".repeat(64));
        assert!(!decodes(&value));
        assert!(RequestRecord::decode(&[255]).is_err());
        assert!(req.correlate_reply(&[255]).is_err());
        assert!(req.correlate_reply(&vec![b' '; REPLY_LIMIT + 1]).is_err());
        assert!(RequestRecord::decode(&vec![b' '; REQUEST_LIMIT + 1]).is_err());
        assert!(
            RequestRecord::new(
                Phase::Analyze,
                "i".into(),
                vec![b' '; REQUEST_LIMIT],
                None,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn phase_nullable_fields_and_correlation_are_semantic() {
        let analyze = request(Phase::Analyze);
        let final_req = request(Phase::FinalValidate);
        for (req, wrong) in [(&analyze, &final_req), (&final_req, &analyze)] {
            for key in ["expectedAuthorityRevision", "fence"] {
                let mut value = request_json(req);
                value[key] = request_json(wrong)[key].clone();
                assert!(!decodes(&value));
            }
        }
        for req in [&analyze, &final_req] {
            for (key, wrong) in [
                ("protocol", json!("wrong")),
                ("phase", json!("bad")),
                ("invocationId", json!("other")),
                ("executionDigest", json!("0".repeat(64))),
            ] {
                let mut value = reply(req);
                value[key] = wrong;
                assert!(!accepts(req, &value));
            }
            let other_phase = if req.envelope.phase == Phase::Analyze {
                "final_validate"
            } else {
                "analyze"
            };
            let mut value = reply(req);
            value["phase"] = json!(other_phase);
            assert!(!accepts(req, &value));
            for (name, decision) in [
                ("allow", Decision::Allow),
                ("deny", Decision::Deny),
                ("unresolved", Decision::Unresolved),
            ] {
                let mut value = reply(req);
                value["decision"] = json!(name);
                value["reasonCodes"] = json!(["source_denied"]);
                let observation = req
                    .correlate_reply(&serde_json::to_vec(&value).unwrap())
                    .unwrap();
                assert!(observation.decision() == decision);
                assert_eq!(observation.reason_codes(), &["source_denied"]);
                assert_eq!(
                    observation.authority_revision(),
                    req.envelope
                        .expected_authority_revision
                        .as_ref()
                        .map(String::as_str)
                );
            }
            let mut value = reply(req);
            value["decision"] = json!("permit");
            assert!(!accepts(req, &value));
        }
        for revision in [Value::Null, json!("stale")] {
            let mut value = reply(&final_req);
            value["authorityRevision"] = revision;
            assert!(!accepts(&final_req, &value));
            value["decision"] = json!("deny");
            assert!(accepts(&final_req, &value));
        }
        let mut value = reply(&analyze);
        value["authorityRevision"] = json!("new-revision");
        assert!(accepts(&analyze, &value));
    }

    #[test]
    fn canonical_fence_numbers_and_scalar_byte_bounds_are_enforced() {
        let req = request(Phase::FinalValidate);
        for key in ["dev", "ino"] {
            for good in ["0", "18446744073709551615"] {
                let mut value = request_json(&req);
                value["fence"][key] = json!(good);
                assert!(decodes(&value));
            }
            for bad in ["", "+1", "01", "-1", "18446744073709551616", "1.0", " 1"] {
                let mut value = request_json(&req);
                value["fence"][key] = json!(bad);
                assert!(!decodes(&value));
            }
            let mut value = request_json(&req);
            value["fence"][key] = json!(1);
            assert!(!decodes(&value));
        }
        for key in ["invocationId", "expectedAuthorityRevision", "nonce"] {
            for (text, expected) in [
                ("a".repeat(256), true),
                ("é".repeat(128), true),
                ("é".repeat(129), false),
                ("a".repeat(257), false),
                (String::new(), false),
                ("a\u{007f}".into(), false),
                ("a\n".into(), false),
            ] {
                let mut value = request_json(&req);
                if key == "nonce" {
                    value["fence"][key] = json!(text);
                } else {
                    value[key] = json!(text);
                }
                assert_eq!(decodes(&value), expected, "field {key}");
            }
        }
        for text in [
            "a".repeat(128),
            "é".repeat(64),
            "é".repeat(65),
            "a".repeat(129),
            String::new(),
            "x\n".into(),
            "reason".into(),
        ] {
            let mut value = reply(&req);
            value["reasonCodes"] = json!([text]);
            assert!(!accepts(&req, &value));
        }
        // Every protocol reason is accepted; the list is pinned independently
        // from the implementation constant so dropping a code is observable.
        for reason in [
            "invalid_frame",
            "invalid_record",
            "identity_unverified",
            "context_unresolved",
            "unsupported_profile",
            "source_unresolved",
            "source_denied",
            "binding_unavailable",
            "foreign_owner",
            "scope_refused",
            "authority_changed",
            "fence_unverified",
            "deadline_expired",
            "cancelled",
            "infrastructure_unavailable",
        ] {
            let mut value = reply(&req);
            value["reasonCodes"] = json!([reason]);
            assert!(accepts(&req, &value));
        }
        for (count, expected) in [(32, true), (33, false)] {
            let mut value = reply(&req);
            value["reasonCodes"] = json!(vec!["source_denied"; count]);
            assert_eq!(accepts(&req, &value), expected);
        }
        for bad in [json!(null), json!([1]), json!("reason")] {
            let mut value = reply(&req);
            value["reasonCodes"] = bad;
            assert!(!accepts(&req, &value));
        }
        let mut value = reply(&req);
        value["authorityRevision"] = json!("x".repeat(257));
        value["decision"] = json!("deny");
        assert!(!accepts(&req, &value));
    }
}
