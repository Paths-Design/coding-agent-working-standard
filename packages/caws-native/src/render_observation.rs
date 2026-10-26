//! Original-frontend observations carried by the existing publication transport.
//!
//! This adapter is dormant until its owner wraps a publication Transport. It
//! adds no reader and transfers no observation custody to the resident Actor.
use crate::{
    render_context::{self as git, CustodiedRenderContext, RenderContextOwner},
    renderer_calendar::{CalendarFailure, CapturedCalendar, OriginalCalendar, OriginalContext},
    session_publication::Transport,
    session_publication_wire as publication,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::time::Instant;

pub const BINDING: &str = "caws.runtime.render-observation.binding.v1";
pub const STOP_BINDING: &str = "caws.runtime.render-observation.binding.v2";
pub const REQUEST: &str = "caws.runtime.render-observation.request.v1";
pub const RESULT: &str = "caws.runtime.render-observation.result.v1";
pub const CHUNK: &str = "caws.runtime.render-observation.chunk.v1";
pub const FAILURE: &str = "caws.runtime.render-observation.failure.v1";
pub const MAX_CALENDAR_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_SEQUENCE: u32 = 65_537;

/// The first failure owns the actual Git failure, including any unreaped Child.
/// A wire cleanup flag or a failed transport write cannot settle this custody.
#[must_use = "retain or explicitly transfer uncertain Render observation custody"]
#[derive(Debug)]
pub struct Failure {
    pub category: &'static str,
    pub diagnostic: String,
    pub git: Option<git::Failure>,
    pub calendar: Option<CalendarFailure>,
}
impl Failure {
    fn plain(category: &'static str, diagnostic: impl Into<String>) -> Self {
        Self {
            category,
            diagnostic: diagnostic.into(),
            git: None,
            calendar: None,
        }
    }
    pub fn cleanup_settled(&self) -> bool {
        self.git.as_ref().is_none_or(git::Failure::cleanup_settled)
    }
    pub fn retry_cleanup_until(
        &mut self,
        original: &crate::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        self.git.as_mut().map_or(Ok(()), |failure| {
            failure.retry_cleanup_until(original, until)
        })
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        self.git
            .as_mut()
            .map_or(Ok(()), git::Failure::retry_cleanup)
    }
}

#[derive(Clone)]
struct Phase {
    correlation: publication::Correlation,
    observation_id: String,
    input_digest: String,
    source_catalog: Option<Value>,
}
impl Phase {
    fn frame(&self, schema: &str, fields: Value) -> Result<Vec<u8>, String> {
        let mut value = serde_json::to_value(&self.correlation).map_err(|e| e.to_string())?;
        let object = value
            .as_object_mut()
            .ok_or("observation correlation encoding")?;
        object.insert("schema".into(), schema.into());
        object.insert("observationId".into(), self.observation_id.clone().into());
        object.insert("inputDigest".into(), self.input_digest.clone().into());
        object.extend(
            fields
                .as_object()
                .ok_or("observation fields encoding")?
                .clone(),
        );
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if bytes.len() > publication::MAX_FRAME_BYTES {
            return Err("Render observation frame exceeds publication bound".into());
        }
        Ok(bytes)
    }
}

/// Keep this owner in the original frontend until both the publication exchange
/// and any `Failure` custody have settled. Dropping a temporary transport wrapper
/// does not drop the failure. Taking the failure transfers custody explicitly and
/// leaves the owner terminal; it never reopens a failed lease.
pub struct ObservationOwner {
    id: String,
    runtime_digest: String,
    cwd: String,
    executable: git::Executable,
    calendar_context: OriginalContext,
    captured_git: Option<CustodiedRenderContext>,
    captured_calendar: Option<CapturedCalendar>,
    git: Option<RenderContextOwner>,
    calendar: Option<OriginalCalendar>,
    correlation: Option<publication::Correlation>,
    phase: Option<Phase>,
    render_seen: bool,
    active: bool,
    closed: bool,
    terminal: bool,
    git_completed: bool,
    next_sequence: u32,
    expires: Instant,
    failure: Option<Failure>,
    failure_transferred: bool,
    credit: publication::CreditBudget,
}
impl ObservationOwner {
    pub fn new(
        git: CustodiedRenderContext,
        calendar: CapturedCalendar,
        expires: Instant,
    ) -> Result<Self, Failure> {
        // These accessors are original capture facts, not engine-provided echoes.
        if git.id() != calendar.id() || git.runtime_digest() != calendar.runtime_digest() {
            return Err(Failure::plain(
                "binding",
                "Render Git/calendar original identity mismatch",
            ));
        }
        if Instant::now() >= expires {
            return Err(Failure::plain(
                "deadline",
                "Original Render observation deadline expired",
            ));
        }
        Ok(Self {
            id: git.id().into(),
            runtime_digest: git.runtime_digest().into(),
            cwd: git.cwd().into(),
            executable: git.executable(),
            calendar_context: calendar.context().clone(),
            captured_git: Some(git),
            captured_calendar: Some(calendar),
            git: None,
            calendar: None,
            correlation: None,
            phase: None,
            render_seen: false,
            active: false,
            closed: false,
            terminal: false,
            git_completed: false,
            next_sequence: 1,
            expires,
            failure: None,
            failure_transferred: false,
            credit: publication::CreditBudget::default(),
        })
    }
    pub fn transport<'a, T: Transport>(
        &'a mut self,
        inner: &'a mut T,
        cancelled: &'a dyn Fn() -> bool,
    ) -> ObservationTransport<'a, T> {
        ObservationTransport {
            owner: self,
            inner,
            cancelled,
        }
    }
    pub fn failure(&self) -> Option<&Failure> {
        self.failure.as_ref()
    }
    pub fn take_failure(&mut self) -> Option<Failure> {
        let failure = self.failure.take();
        self.failure_transferred |= failure.is_some();
        failure
    }
    pub fn cleanup_settled(&self) -> bool {
        !self.failure_transferred && self.failure.as_ref().is_none_or(Failure::cleanup_settled)
    }
    pub fn retry_cleanup_until(
        &mut self,
        original: &crate::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        if self.failure_transferred {
            return Err("Render observation failure custody was transferred".into());
        }
        self.failure.as_mut().map_or(Ok(()), |failure| {
            failure.retry_cleanup_until(original, until)
        })
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        if self.failure_transferred {
            return Err("Render observation failure custody was transferred".into());
        }
        self.failure.as_mut().map_or(Ok(()), Failure::retry_cleanup)
    }
    fn latch(&mut self, failure: Failure) -> String {
        self.active = false;
        self.closed = true;
        self.terminal = true;
        if self.failure.is_none() {
            self.failure = Some(failure);
        }
        self.message()
    }
    fn message(&self) -> String {
        self.failure.as_ref().map_or_else(
            || "Render observation lease is terminal".into(),
            |f| format!("{}: {}", f.category, f.diagnostic),
        )
    }
}

pub struct ObservationTransport<'a, T: Transport> {
    owner: &'a mut ObservationOwner,
    inner: &'a mut T,
    cancelled: &'a dyn Fn() -> bool,
}
impl<T: Transport> ObservationTransport<'_, T> {
    fn fail(&mut self, category: &'static str, message: impl Into<String>) -> String {
        self.owner.latch(Failure::plain(category, message))
    }
    fn checkpoint(&mut self, expires: Instant) -> Result<Instant, String> {
        if self.owner.terminal {
            return Err(self.owner.message());
        }
        if (self.cancelled)() {
            return Err(self.fail("cancelled", "Original Render observation cancelled"));
        }
        let expires = expires.min(self.owner.expires);
        if Instant::now() >= expires {
            return Err(self.fail("deadline", "Original Render observation deadline expired"));
        }
        Ok(expires)
    }
    fn emit(&mut self, schema: &str, fields: Value, expires: Instant) -> Result<(), String> {
        let bytes = self
            .owner
            .phase
            .as_ref()
            .ok_or("missing Render observation phase")?
            .frame(schema, fields)?;
        self.inner.write(&bytes, expires)
    }
    fn outgoing(&mut self, bytes: &[u8], expires: Instant) -> Result<bool, String> {
        let value = frame_value(bytes)?;
        let schema = value.get("schema").and_then(Value::as_str).unwrap_or("");
        if schema == publication::PREPARE || schema == crate::session_publication::STOP_PREPARE {
            let prepare: Prepare = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            let correlation = prepare.correlation();
            let stop = prepare.schema == crate::session_publication::STOP_PREPARE;
            let input_digest = match &prepare.snapshot.source_catalog {
                Some(catalog)
                    if stop
                        && prepare.kind == publication::Kind::Render
                        && catalog.get("schema").and_then(Value::as_str)
                            == Some(crate::session_publication::STOP_SOURCE_CATALOG) =>
                {
                    crate::session_publication::stop_source_input_digest(
                        &prepare.snapshot.files,
                        catalog,
                    )?
                }
                None if !stop => {
                    sha(&serde_json::to_vec(&prepare.snapshot.files).map_err(|e| e.to_string())?)
                }
                _ => return Err("native Stop catalog version mismatch".into()),
            };
            if (prepare.schema != publication::PREPARE && !stop)
                || prepare.id != self.owner.id
                || prepare.runtime_digest != self.owner.runtime_digest
                || !valid_token(&prepare.token)
                || !text(&prepare.attempt, 128)
                || !publication::digest(&prepare.snapshot.observation_id)
                || !publication::digest(&prepare.snapshot.input_digest)
                || !prepare.snapshot.valid()
                || input_digest != prepare.snapshot.input_digest
                || self
                    .owner
                    .correlation
                    .as_ref()
                    .is_some_and(|prior| prior != &correlation)
            {
                return Err("native Render PREPARE binding mismatch".into());
            }
            self.owner.correlation = Some(correlation.clone());
            if prepare.kind == publication::Kind::Render {
                if self.owner.render_seen || self.owner.closed {
                    return Err("Render observation phase replay".into());
                }
                self.owner.render_seen = true;
                self.owner.phase = Some(Phase {
                    correlation,
                    observation_id: prepare.snapshot.observation_id,
                    input_digest: prepare.snapshot.input_digest,
                    source_catalog: prepare.snapshot.source_catalog,
                });
                let git = self
                    .owner
                    .captured_git
                    .take()
                    .ok_or("missing original Git capture")?;
                self.owner.git = Some(git.bind(prepare.token.clone()).map_err(|failure| {
                    self.owner.latch(Failure {
                        category: "binding",
                        diagnostic: failure.diagnostic.clone(),
                        git: Some(failure),
                        calendar: None,
                    })
                })?);
                let calendar = self
                    .owner
                    .captured_calendar
                    .take()
                    .ok_or("missing original calendar capture")?;
                self.owner.calendar = Some(calendar.bind(prepare.token).map_err(|failure| {
                    self.owner.latch(Failure {
                        category: "binding",
                        diagnostic: failure.to_string(),
                        git: None,
                        calendar: Some(failure),
                    })
                })?);
            }
        } else if schema == publication::READY {
            let ready: publication::Ready =
                serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            if ready.kind == publication::Kind::Render && ready.direction == "inputs" {
                if self.owner.active
                    || self.owner.closed
                    || self
                        .owner
                        .phase
                        .as_ref()
                        .is_none_or(|phase| phase.correlation != ready.correlation())
                {
                    return Err("native Render INPUTS READY transition mismatch".into());
                }
                self.inner.write(bytes, expires)?;
                let mut fields = json!({"cwd":self.owner.cwd,"executable":self.owner.executable,"calendarContext":self.owner.calendar_context});
                let schema = if let Some(catalog) = self
                    .owner
                    .phase
                    .as_ref()
                    .and_then(|phase| phase.source_catalog.as_ref())
                {
                    fields
                        .as_object_mut()
                        .ok_or("Stop observation binding encoding")?
                        .insert("sourceCatalog".into(), catalog.clone());
                    STOP_BINDING
                } else {
                    BINDING
                };
                self.emit(schema, fields, expires)?;
                self.owner.active = true;
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn response(&mut self, request: Request, expires: Instant) -> Result<(), String> {
        let sequence = request.sequence();
        let operation = request.operation();
        let phase = self.owner.phase.as_ref().ok_or("missing Render phase")?;
        if request.schema() != REQUEST
            || !request.matches(phase)
            || sequence != self.owner.next_sequence
            || sequence > MAX_SEQUENCE
            || (operation == "git" && (sequence != 1 || self.owner.git_completed))
            || (operation == "calendar" && !self.owner.git_completed)
        {
            return Err(self.fail(
                "protocol",
                "Render observation identity, operation or sequence mismatch",
            ));
        }
        let result = match request {
            Request::Git(_) => {
                let observed = self
                    .owner
                    .git
                    .as_mut()
                    .ok_or("missing bound Git owner")?
                    .observe(expires, self.cancelled);
                observed
                    .and_then(|value| value.bytes())
                    .map_err(|failure| Failure {
                        category: failure.category,
                        diagnostic: failure.diagnostic.clone(),
                        git: Some(failure),
                        calendar: None,
                    })
            }
            Request::Calendar(request) => {
                let mut cancel = || {
                    if (self.cancelled)() {
                        Err("Original Render observation cancelled".into())
                    } else if Instant::now() >= expires {
                        Err("Original Render observation deadline expired".into())
                    } else {
                        Ok(())
                    }
                };
                self.owner
                    .calendar
                    .as_mut()
                    .ok_or("missing bound calendar owner")?
                    .observe(request.request.get().as_bytes(), &mut cancel)
                    .map_err(|failure| Failure {
                        category: "calendar",
                        diagnostic: failure.to_string(),
                        git: None,
                        calendar: Some(failure),
                    })
            }
        };
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(failure) => {
                let diagnostic = bounded(&failure.diagnostic, 1024);
                let category = failure.category;
                let settled = failure.cleanup_settled();
                let message = self.owner.latch(failure);
                // A failed error write leaves the first actual failure in Owner.
                let _ = self.emit(FAILURE, json!({"sequence":sequence,"operation":operation,"category":category,"diagnostic":diagnostic,"cleanupSettled":settled}), expires);
                return Err(message);
            }
        };
        let maximum = if operation == "git" {
            git::MAX_BYTES
        } else {
            MAX_CALENDAR_BYTES
        };
        if bytes.is_empty() || bytes.len() > maximum {
            return Err(self.fail("output_limit", "Render observation output exceeded bound"));
        }
        self.checkpoint(expires)?;
        self.emit(RESULT, json!({"sequence":sequence,"operation":operation,"byteLength":bytes.len(),"sha256":sha(&bytes)}), expires)?;
        for (index, chunk) in bytes.chunks(publication::MAX_CHUNK_BYTES).enumerate() {
            self.checkpoint(expires)?;
            self.emit(CHUNK, json!({"sequence":sequence,"operation":operation,"offset":index*publication::MAX_CHUNK_BYTES,"base64":STANDARD.encode(chunk)}), expires)?;
        }
        self.owner.git_completed |= operation == "git";
        self.owner.next_sequence += 1;
        Ok(())
    }
}
impl<T: Transport> Transport for ObservationTransport<'_, T> {
    fn write(&mut self, bytes: &[u8], expires: Instant) -> Result<(), String> {
        let expires = self.checkpoint(expires)?;
        let result = self.outgoing(bytes, expires).and_then(|handled| {
            if handled {
                Ok(())
            } else {
                self.inner.write(bytes, expires)
            }
        });
        result.map_err(|error| self.fail("transport", error))
    }
    fn read(&mut self, expires: Instant) -> Result<Vec<u8>, String> {
        let expires = self.checkpoint(expires)?;
        loop {
            let bytes = self
                .inner
                .read(expires)
                .map_err(|error| self.fail("transport", error))?;
            self.checkpoint(expires)?;
            let value = frame_value(&bytes).map_err(|error| self.fail("protocol", error))?;
            let schema = value.get("schema").and_then(Value::as_str).unwrap_or("");
            if !self.owner.active {
                if schema.starts_with("caws.runtime.render-observation.") {
                    return Err(self.fail("protocol", "Render observation outside active phase"));
                }
                return Ok(bytes);
            }
            if schema == publication::PREPARED {
                let prepared: publication::Prepared = serde_json::from_slice(&bytes)
                    .map_err(|error| self.fail("protocol", error.to_string()))?;
                let phase = self.owner.phase.as_ref().ok_or("missing Render phase")?;
                if prepared.kind != publication::Kind::Render
                    || prepared.correlation() != phase.correlation
                    || prepared.observation_id != phase.observation_id
                    || prepared.input_digest != phase.input_digest
                    || !matches!(prepared.disposition.as_str(), "ready" | "aborted")
                    || (prepared.disposition == "ready" && !self.owner.git_completed)
                {
                    return Err(self.fail(
                        "protocol",
                        "Render PREPARED before Git completion or wrong phase binding",
                    ));
                }
                self.owner.active = false;
                self.owner.closed = true;
                return Ok(bytes);
            }
            if schema != REQUEST || bytes.len() > MAX_REQUEST_BYTES {
                return Err(self.fail(
                    "protocol",
                    "Unexpected or oversized Render observation request",
                ));
            }
            let request = Request::parse(&bytes).map_err(|error| self.fail("protocol", error))?;
            // response validates identity before it performs an observation. Credit
            // is issued only after the entire operation succeeds, and remains
            // subject to both this adapter and the existing transport's ceilings.
            self.response(request, expires)
                .map_err(|error| self.fail("transport", error))?;
            self.owner
                .credit
                .accept(bytes.len())
                .map_err(|error| self.fail("credit", error))?;
            self.inner
                .credit(bytes.len())
                .map_err(|error| self.fail("transport", error))?;
        }
    }
    fn credit(&mut self, bytes: usize) -> Result<(), String> {
        self.checkpoint(self.owner.expires)?;
        self.inner
            .credit(bytes)
            .map_err(|error| self.fail("transport", error))
    }
}

// Store acquisition precedes the publication exchange on this same reader.
// Its fixed-query protocol is passed to the original transport, while the
// original cancellation/deadline and first-failure latch remain authoritative.
#[cfg(feature = "sqlite-store")]
impl<T: Transport + crate::transcript_store_wire::Transport> crate::transcript_store_wire::Transport
    for ObservationTransport<'_, T>
{
    fn write(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String> {
        let deadline = self.checkpoint(deadline)?;
        crate::transcript_store_wire::Transport::write(self.inner, bytes, deadline)
            .map_err(|error| self.fail("transport", error))
    }
    fn read(&mut self, deadline: Instant) -> Result<Vec<u8>, String> {
        let deadline = self.checkpoint(deadline)?;
        crate::transcript_store_wire::Transport::read(self.inner, deadline)
            .map_err(|error| self.fail("transport", error))
    }
    fn credit(&mut self, bytes: usize) -> Result<(), String> {
        self.checkpoint(self.owner.expires)?;
        crate::transcript_store_wire::Transport::credit(self.inner, bytes)
            .map_err(|error| self.fail("transport", error))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    attempt: String,
    kind: publication::Kind,
    snapshot: Snapshot,
}
impl Prepare {
    fn correlation(&self) -> publication::Correlation {
        publication::Correlation {
            id: self.id.clone(),
            runtime_digest: self.runtime_digest.clone(),
            token: self.token.clone(),
            attempt: self.attempt.clone(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    observation_id: String,
    input_digest: String,
    session_id: String,
    reason: String,
    ended_at: String,
    files: Vec<publication::Descriptor>,
    prior_inventory: Vec<publication::Descriptor>,
    #[serde(default)]
    #[serde(deserialize_with = "present_catalog")]
    source_catalog: Option<Value>,
}
fn present_catalog<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if !value.is_object() {
        return Err(serde::de::Error::custom(
            "Stop source catalog must be an object",
        ));
    }
    Ok(Some(value))
}
impl Snapshot {
    fn valid(&self) -> bool {
        publication::leaf(&self.session_id)
            && self.session_id.len() <= 128
            && self.reason.len() <= 4096
            && self.ended_at.len() <= 128
            && self.files.len() <= publication::MAX_ARTIFACTS
            && self.prior_inventory.len() <= publication::MAX_ARTIFACTS
            && [&self.files, &self.prior_inventory]
                .iter()
                .all(|descriptors| {
                    let mut names = std::collections::BTreeSet::new();
                    let mut total = 0usize;
                    descriptors.iter().all(|d| {
                        total = total.saturating_add(d.byte_length);
                        publication::leaf(&d.name)
                            && text(&d.role, 128)
                            && names.insert(&d.name)
                            && publication::digest(&d.sha256)
                            && d.byte_length <= publication::MAX_ARTIFACT_BYTES
                            && total <= publication::MAX_TOTAL_BYTES
                    })
                })
    }
}
macro_rules! request_struct {
    ($name:ident $(, $field:ident: $type:ty)?) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $name {
            schema: String, id: String, runtime_digest: String, token: String, attempt: String,
            observation_id: String, input_digest: String, sequence: u32, operation: String,
            $($field: $type,)?
        }
    }
}
request_struct!(GitRequest);
request_struct!(CalendarRequest, request: Box<RawValue>);
enum Request {
    Git(GitRequest),
    Calendar(CalendarRequest),
}
impl Request {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let value = frame_value(bytes)?;
        // Reparse the original bytes into an exact struct: duplicate/unknown
        // outer members are rejected, and calendar JSON stays raw for its own
        // strict native decoder instead of losing duplicate members in Value.
        match value.get("operation").and_then(Value::as_str) {
            Some("git") => serde_json::from_slice(bytes)
                .map(Self::Git)
                .map_err(|e| e.to_string()),
            Some("calendar") => serde_json::from_slice(bytes)
                .map(Self::Calendar)
                .map_err(|e| e.to_string()),
            _ => Err("Unknown Render observation operation".into()),
        }
    }
    fn schema(&self) -> &str {
        match self {
            Self::Git(r) => &r.schema,
            Self::Calendar(r) => &r.schema,
        }
    }
    fn sequence(&self) -> u32 {
        match self {
            Self::Git(r) => r.sequence,
            Self::Calendar(r) => r.sequence,
        }
    }
    fn operation(&self) -> &'static str {
        match self {
            Self::Git(_) => "git",
            Self::Calendar(_) => "calendar",
        }
    }
    fn matches(&self, phase: &Phase) -> bool {
        macro_rules! matches {
            ($r:expr) => {
                $r.id == phase.correlation.id
                    && $r.runtime_digest == phase.correlation.runtime_digest
                    && $r.token == phase.correlation.token
                    && $r.attempt == phase.correlation.attempt
                    && $r.observation_id == phase.observation_id
                    && $r.input_digest == phase.input_digest
                    && $r.operation == self.operation()
            };
        }
        match self {
            Self::Git(r) => matches!(r),
            Self::Calendar(r) => matches!(r),
        }
    }
}
fn frame_value(bytes: &[u8]) -> Result<Value, String> {
    if bytes.is_empty()
        || bytes.len() > publication::MAX_FRAME_BYTES
        || bytes.last() != Some(&b'\n')
        || bytes[..bytes.len() - 1].contains(&b'\n')
    {
        return Err("Render observation frame bound or LF mismatch".into());
    }
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}
fn text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.contains('\0')
}
fn valid_token(value: &str) -> bool {
    text(value, 128)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn bounded(value: &str, maximum: usize) -> String {
    let mut end = value.len().min(maximum);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}
