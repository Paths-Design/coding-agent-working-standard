//! Resident acquisition, distinct from RenderOffer v1 and its LF+EOF bridge.
//! Records are finite, unreleased, and never replayed or evicted. Registry weak
//! references make status depend on the actual surviving actor/quarantine owner.
use super::*;
use crate::monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline};
use crate::{
    session_publication as publication, session_publication_wire as publication_wire,
    transcript_store as sql, transcript_store_wire as store,
};
use serde_json::value::RawValue;
use std::sync::{Weak, atomic::AtomicBool};

const ACQUIRE_SCHEMA: &str = "caws.render.owner.store-acquire.v2";
const NATIVE_ACQUIRE_SCHEMA: &str = "caws.render.owner.store-acquire.native-stop.v1";
const MAX_NATIVE_CHECKS: usize = 6;
const ACQUIRE_PREFIX: &str = "caws.render.owner.store-acquire.";
const STATUS_SCHEMA: &str = "caws.render.owner.store-status.v1";
const REPLY_SCHEMA: &str = "caws.render.owner.store-relay-reply.v1";
#[cfg(test)]
thread_local! {
    // A test installs this on the receive_first thread only. The probe confirms
    // actual mutex contention without replacing the production lock operation.
    static BEFORE_STORE_REGISTRY_LOCK: std::cell::RefCell<Option<mpsc::SyncSender<bool>>> =
        const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
fn observe_store_registry_contention(registry: &Arc<Mutex<StoreRegistry>>) {
    BEFORE_STORE_REGISTRY_LOCK.with(|slot| {
        if let Some(sender) = slot.borrow_mut().take() {
            let contended = matches!(
                registry.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
            sender
                .send(contended)
                .expect("contention observer receiver");
        }
    });
}
const STATUS_MAX: usize = 8192;
const REPLY_MAX: usize = publication_wire::MAX_RELAY_FRAME_BYTES;

fn captured_utc() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|time| libc::time_t::try_from(time.as_secs()).ok());
    let Some(seconds) = seconds else {
        return String::new();
    };
    let mut calendar: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut calendar) }.is_null() {
        return String::new();
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        calendar.tm_year + 1900,
        calendar.tm_mon + 1,
        calendar.tm_mday,
        calendar.tm_hour,
        calendar.tm_min,
        calendar.tm_sec
    )
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreAcquire {
    schema: String,
    id: String,
    runtime_digest: String,
    original_payload: Box<RawValue>,
    surface: String,
    event: String,
    configuration: String,
    ready_active: bool,
    ready_project_digest: Option<String>,
    ready_session_id: Option<String>,
    dispatched: bool,
    database: Option<String>,
    caller_cwd: String,
    caller_environment: BTreeMap<String, String>,
    request_base64: String,
    deadline: DeadlineEnvelope,
    #[serde(default)]
    publication: bool,
    #[serde(default)]
    captured_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_stop: Option<NativeStopBinding>,
}
impl StoreAcquire {
    pub fn capture(bytes: &[u8], i: store::Invocation<'_>, deadline: &MonotonicDeadline) -> Self {
        Self {
            schema: ACQUIRE_SCHEMA.into(),
            id: i.id.into(),
            runtime_digest: i.runtime_digest.into(),
            original_payload: i.original_payload.to_owned(),
            surface: i.surface.into(),
            event: i.event.into(),
            configuration: i.configuration.into(),
            ready_active: i.ready_active,
            ready_project_digest: i.ready_project_digest.map(str::to_owned),
            ready_session_id: i.ready_session_id.map(str::to_owned),
            dispatched: i.dispatched,
            database: i.database.map(str::to_owned),
            caller_cwd: i.caller_cwd.into(),
            caller_environment: i.caller_environment.clone(),
            request_base64: STANDARD.encode(bytes),
            deadline: deadline.envelope(),
            publication: false,
            captured_at: captured_utc(),
            native_stop: None,
        }
    }
    /// Root calls this only for the newly selected native session-log path.
    /// It must not also dispatch the legacy renderer service for this original.
    pub fn capture_publication(
        bytes: &[u8],
        i: store::Invocation<'_>,
        deadline: &MonotonicDeadline,
    ) -> Self {
        let mut captured = Self::capture(bytes, i, deadline);
        captured.publication = true;
        captured
    }
    fn invocation(&self) -> store::Invocation<'_> {
        store::Invocation {
            id: &self.id,
            runtime_digest: &self.runtime_digest,
            original_payload: &self.original_payload,
            surface: &self.surface,
            event: &self.event,
            configuration: &self.configuration,
            ready_active: self.ready_active,
            ready_project_digest: self.ready_project_digest.as_deref(),
            ready_session_id: self.ready_session_id.as_deref(),
            dispatched: self.dispatched,
            database: self.database.as_deref(),
            caller_cwd: &self.caller_cwd,
            caller_environment: &self.caller_environment,
        }
    }
    fn request(&self) -> Result<Vec<u8>> {
        if !matches!(self.schema.as_str(), ACQUIRE_SCHEMA | NATIVE_ACQUIRE_SCHEMA)
            || self.id.is_empty()
            || self.id.len() > 256
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            || self.runtime_digest.len() != 64
            || !self
                .runtime_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || (self.schema == ACQUIRE_SCHEMA
                && self.database.as_ref()
                    != self.caller_environment.get("CAWS_TRANSCRIPT_DATABASE"))
            || self.request_base64.len() > store::MAX_REQUEST_BYTES.div_ceil(3) * 4
        {
            return Err("resident store original invocation envelope mismatch".into());
        }
        if (self.schema == NATIVE_ACQUIRE_SCHEMA) != self.native_stop.is_some()
            || (self.native_stop.is_some() && !self.publication)
        {
            return Err("native Stop registration schema/binding mismatch".into());
        }
        let bytes = STANDARD.decode(&self.request_base64).map_err(err)?;
        if STANDARD.encode(&bytes) != self.request_base64 {
            return Err("resident store request encoding is not canonical".into());
        }
        Ok(bytes)
    }
}

/// Native check phases are fixed by the owner, never engine-selected actions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeStopPhase {
    Registration,
    BeforeReservation,
    BeforeWriter,
    WriterLocked,
    WriterRetired,
    BeforeSql,
    BeforePublication,
}
fn native_phase_follows(previous: Option<NativeStopPhase>, next: NativeStopPhase) -> bool {
    use NativeStopPhase::*;
    matches!(
        (previous, next),
        (None, BeforeReservation)
            | (Some(BeforeReservation), BeforeWriter)
            | (Some(BeforeWriter), WriterLocked | WriterRetired)
            | (Some(WriterLocked), WriterRetired)
            | (Some(WriterRetired), BeforeSql)
            | (Some(BeforeSql), BeforePublication)
    )
}
/// Delivered only to the native caller's retained qualification callback.
/// A callback must check its genuine stock/profile/prefix/original owners.
pub struct NativeStopCheck {
    phase: NativeStopPhase,
}
impl NativeStopCheck {
    pub fn phase(&self) -> NativeStopPhase {
        self.phase
    }
}

/// Transport data only. Kernel peer admission and a native-local callback are
/// both required before this can select the admitted-project store entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeStopBinding {
    canonical_root: String,
    render_cwd: String,
    session_id: String,
    payload_sha256: String,
    prefix_sha256: String,
    prefix_token: String,
    original_deadline: DeadlineEnvelope,
}
impl NativeStopBinding {
    fn validate(&self, acquire: &StoreAcquire, request: &[u8]) -> Result<()> {
        if acquire.schema != NATIVE_ACQUIRE_SCHEMA
            || !acquire.publication
            || self.original_deadline != acquire.deadline
            || self.payload_sha256 != sha(acquire.original_payload.get().as_bytes())
            || self.prefix_sha256.len() != 64
            || !self
                .prefix_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.prefix_token.is_empty()
            || self.prefix_token.len() > 128
            || self.render_cwd.len() > 4096
            || !Path::new(&self.render_cwd).is_absolute()
            || self.render_cwd.contains('\0')
            || crate::invocation_project::payload_string(&acquire.original_payload, "cwd")?
                .as_deref()
                != Some(self.render_cwd.as_str())
            || store::correlation_root(request, &acquire.invocation()).map_err(err)?
                != self.canonical_root
            || crate::invocation_project::payload_string(&acquire.original_payload, "session_id")?
                .as_deref()
                != Some(self.session_id.as_str())
            || acquire.ready_session_id.as_deref() != Some(self.session_id.as_str())
        {
            return Err("native Stop original/prefix/project binding mismatch".into());
        }
        Ok(())
    }
    fn digest(&self, acquire: &StoreAcquire) -> Result<String> {
        Ok(sha(&serde_json::to_vec(&(acquire, self)).map_err(err)?))
    }
}

/// Neither Deserialize nor Clone. Construction borrows the actual original and
/// completed prefix; the enclosing QualifiedStop owns stock/profile eligibility.
/// A serialized registration is not a capability and is refused without its
/// exact native producer and native-local phase checks.
pub struct NativeStopRegistration<'capture, 'deadline> {
    acquire: StoreAcquire,
    original: &'capture crate::session_cache_wire::OriginalStopCapture<'deadline>,
    completed: &'capture crate::session_cache_wire::CompletedStopPrefix<'deadline>,
}
impl<'capture, 'deadline> NativeStopRegistration<'capture, 'deadline> {
    pub fn capture(
        bytes: &[u8],
        invocation: store::Invocation<'_>,
        original: &'capture crate::session_cache_wire::OriginalStopCapture<'deadline>,
        completed: &'capture crate::session_cache_wire::CompletedStopPrefix<'deadline>,
    ) -> Result<Self> {
        original.deadline().check().map_err(err)?;
        completed.check()?;
        let prefix = completed.correlation();
        let project = original.observed_project();
        if !std::ptr::eq(original.deadline(), completed.deadline())
            || original.id() != invocation.id
            || original.runtime_digest() != invocation.runtime_digest
            || original.surface() != invocation.surface
            || invocation.event != "stop"
            || invocation.configuration != "system"
            || !invocation.ready_active
            || !invocation.dispatched
            || original.original_payload().get() != invocation.original_payload.get()
            || original.caller_cwd() != invocation.caller_cwd
            || original.caller_environment() != invocation.caller_environment
            || prefix.id() != original.id()
            || prefix.runtime_digest() != original.runtime_digest()
            || completed.surface() != original.surface()
            || project.canonical_root.to_str() != Some(completed.canonical_root())
            || invocation.ready_session_id != Some(completed.supplied_session_id())
        {
            return Err("native Stop registration requires this original completed prefix".into());
        }
        // This finite profile retains the absolute original payload cwd. An
        // unproved relative payload cwd cannot borrow the resident's cwd.
        let supplied =
            crate::invocation_project::payload_string(original.original_payload(), "cwd")?
                .filter(|s| !s.is_empty())
                .ok_or("native Stop requires captured absolute render cwd")?;
        if !Path::new(&supplied).is_absolute()
            || Path::new(&supplied) != original.query_cwds()[0].as_path()
        {
            return Err("native Stop render cwd differs from original queried candidate".into());
        }
        let mut acquire = StoreAcquire::capture_publication(bytes, invocation, original.deadline());
        acquire.schema = NATIVE_ACQUIRE_SCHEMA.into();
        let binding = NativeStopBinding {
            canonical_root: completed.canonical_root().into(),
            render_cwd: supplied,
            session_id: completed.supplied_session_id().into(),
            payload_sha256: sha(original.original_payload().get().as_bytes()),
            prefix_sha256: sha(&completed.result().encode().map_err(err)?),
            prefix_token: prefix.token().into(),
            original_deadline: original.deadline().envelope(),
        };
        acquire.native_stop = Some(binding);
        let registration = Self {
            acquire,
            original,
            completed,
        };
        registration.check()?;
        Ok(registration)
    }
    fn check(&self) -> Result<()> {
        self.original.deadline().check().map_err(err)?;
        self.completed.check()?;
        let bytes = self.acquire.request()?;
        self.acquire
            .native_stop
            .as_ref()
            .ok_or("native Stop binding absent")?
            .validate(&self.acquire, &bytes)
    }
}

/// Non-deserializable binding issued only inside authenticated queued admission.
/// The SQL entry consumes this instead of observing a different project again.
pub(crate) struct NativeStoreProject {
    id: String,
    runtime_digest: String,
    root: String,
    session_id: String,
    payload_sha256: String,
    deadline: Arc<MonotonicDeadline>,
}
impl NativeStoreProject {
    pub(crate) fn validate(
        &self,
        request: &[u8],
        invocation: &store::Invocation<'_>,
    ) -> Result<()> {
        self.deadline.check().map_err(err)?;
        if self.id != invocation.id
            || self.runtime_digest != invocation.runtime_digest
            || self.payload_sha256 != sha(invocation.original_payload.get().as_bytes())
            || invocation.ready_session_id != Some(self.session_id.as_str())
            || store::correlation_root(request, invocation).map_err(err)? != self.root
        {
            return Err("authenticated native store project binding changed".into());
        }
        Ok(())
    }
    pub(crate) fn check(&self) -> Result<()> {
        self.deadline.check().map_err(err)
    }
}
struct NativeAdmission {
    peer: super::native_peer::NativePeer,
    id: String,
    runtime_digest: String,
    binding: NativeStopBinding,
    binding_digest: String,
    registration: String,
    checks: usize,
    last_phase: Option<NativeStopPhase>,
}

/// The absolute deadline is native-owned same-host evidence, not sender
/// attestation. The request limit is an additional cap, never a replacement.
fn restore_deadline(
    acquire: &StoreAcquire,
    received: Instant,
    request_ms: u32,
) -> Result<(Arc<MonotonicDeadline>, Instant)> {
    let deadline = Arc::new(MonotonicDeadline::receive(acquire.deadline).map_err(err)?);
    let cap = received
        .checked_add(Duration::from_millis(u64::from(request_ms)))
        .ok_or("resident store request deadline overflow")?;
    let expires = deadline.expires().min(cap);
    check(expires)?;
    deadline.check().map_err(err)?;
    Ok((deadline, expires))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquisitionSummary {
    pub end: String,
    pub first_failure: Option<String>,
    pub rows_copied: u64,
    /// Native visitor invocations, not acknowledged engine delivery.
    pub rows_delivered: u64,
    pub progress_unregistered: bool,
    pub busy_unregistered: String,
    pub finalized: String,
    pub rollback: String,
    pub close: String,
    pub retained_uncertain: bool,
    pub retained_handle: bool,
}
fn cleanup_kind(call: &sql::CleanupCall) -> String {
    match call {
        sql::CleanupCall::NotNeeded => "not_needed",
        sql::CleanupCall::Succeeded => "succeeded",
        sql::CleanupCall::Failed(_) => "failed",
    }
    .into()
}
fn failure_kind(failure: &sql::Failure<String>) -> String {
    match failure {
        sql::Failure::Input(_) => "input",
        sql::Failure::Sql(_) => "sql",
        sql::Failure::Text(_) => "text",
        sql::Failure::Resource(_) => "resource",
        sql::Failure::Cancelled(_) => "cancelled",
        sql::Failure::CancellationCallbackPanic => "cancellation_callback_panic",
        sql::Failure::Visitor(_) => "visitor",
        sql::Failure::Transport(_) => "transport",
        sql::Failure::VisitorPanic => "visitor_panic",
        sql::Failure::Cleanup(_) => "cleanup",
    }
    .into()
}
fn summary(a: &sql::Acquisition<String>) -> AcquisitionSummary {
    AcquisitionSummary {
        end: format!("{:?}", a.end),
        first_failure: a.first_failure.as_ref().map(failure_kind),
        rows_copied: a.metrics.rows_copied,
        rows_delivered: a.metrics.rows_delivered,
        progress_unregistered: a.cleanup.progress_unregistered,
        busy_unregistered: cleanup_kind(&a.cleanup.busy_unregistered),
        finalized: cleanup_kind(&a.cleanup.finalized),
        rollback: cleanup_kind(&a.cleanup.rollback),
        close: cleanup_kind(&a.cleanup.close),
        retained_uncertain: a.cleanup.retained_uncertain,
        retained_handle: a.retained.is_some(),
    }
}
fn error_kind(error: &store::ServeError) -> String {
    match error {
        store::ServeError::BeforeAcquisition(_) => "before_acquisition".into(),
        store::ServeError::AfterProjectBinding(_) => "after_project_binding".into(),
        store::ServeError::ProjectObservation(_) => "project_observation".into(),
        store::ServeError::AfterAcquisition { phase, .. } => format!("{phase:?}"),
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreCompletion {
    pub id: String,
    pub runtime_digest: String,
    pub registration: Option<String>,
    pub original_project_bound: bool,
    pub retained: bool,
    pub acquisition: Option<AcquisitionSummary>,
    pub project_cleanup: Option<ProjectCleanupSummary>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCleanupSummary {
    pub first_phase: String,
    pub settled: bool,
    pub retained_owner: bool,
    pub exit_observed: bool,
    pub reaped: bool,
    pub stdout_open: bool,
    pub stderr_open: bool,
}
impl StoreCompletion {
    pub fn status(&self) -> Result<()> {
        self.error.clone().map_or(Ok(()), Err)
    }
    pub fn unavailable(id: &str, runtime: &str, message: String) -> Self {
        Self {
            id: id.into(),
            runtime_digest: runtime.into(),
            registration: None,
            original_project_bound: false,
            retained: false,
            acquisition: None,
            project_cleanup: None,
            error: Some(message),
        }
    }
}
type Settlement = std::result::Result<sql::Acquisition<String>, store::ServeError>;
#[derive(Debug)]
pub(super) struct StoreRecord {
    original: Arc<StoreAcquire>,
    registration: String,
    phase: &'static str,
    original_project_bound: bool,
    result: Option<Settlement>,
    writer: Option<Arc<journal::Custody>>,
    publication: Option<publication::Publication>,
    publication_error: Option<String>,
    consumed: bool,
    _operation: relay::OperationPermit,
}
impl StoreRecord {
    fn completion(&self) -> StoreCompletion {
        let acquisition = match &self.result {
            Some(Ok(a)) => Some(summary(a)),
            Some(Err(store::ServeError::AfterAcquisition { outcome, .. })) => {
                Some(summary(outcome))
            }
            _ => None,
        };
        StoreCompletion {
            id: self.original.id.clone(),
            runtime_digest: self.original.runtime_digest.clone(),
            registration: Some(self.registration.clone()),
            original_project_bound: self.original_project_bound,
            retained: !self.consumed,
            acquisition,
            project_cleanup: match &self.result {
                Some(Err(store::ServeError::ProjectObservation(error))) => {
                    Some(ProjectCleanupSummary {
                        first_phase: format!("{:?}", error.first_phase),
                        settled: error.cleanup.settled(),
                        retained_owner: error.retained.is_some(),
                        exit_observed: error.cleanup.exit_observed,
                        reaped: error.cleanup.reaped.is_some(),
                        stdout_open: error.cleanup.pipes.stdout_open,
                        stderr_open: error.cleanup.pipes.stderr_open,
                    })
                }
                _ => None,
            },
            error: self
                .publication_error
                .clone()
                .or_else(|| match &self.result {
                    Some(Err(e)) => Some(error_kind(e)),
                    _ => None,
                }),
        }
    }
    fn settle(&mut self, result: Settlement) {
        self.original_project_bound |= match &result {
            Ok(_) => true,
            Err(e) => e.original_project_bound(),
        };
        self.result = Some(result);
        self.phase = "settled";
    }
}
pub(super) struct StoreRegistry {
    maximum: usize,
    records: BTreeMap<String, (String, String, Weak<Mutex<StoreRecord>>)>,
    quarantine: Vec<Arc<Mutex<StoreRecord>>>,
    capacity: Arc<relay::OperationCapacity>,
}
impl StoreRegistry {
    pub(super) fn new(maximum: usize) -> Self {
        Self::with_capacity(maximum, relay::OperationCapacity::new(maximum))
    }
    pub(super) fn with_capacity(maximum: usize, capacity: Arc<relay::OperationCapacity>) -> Self {
        Self {
            maximum,
            records: BTreeMap::new(),
            quarantine: Vec::new(),
            capacity,
        }
    }
    pub(super) fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
    fn reserve(&mut self, original: StoreAcquire) -> Result<Arc<Mutex<StoreRecord>>> {
        if self.records.contains_key(&original.id) {
            return Err("resident store duplicate invocation; no replay".into());
        }
        if self.records.len() >= self.maximum {
            return Err("resident store retention capacity exhausted before SQL".into());
        }
        let registration = random()?;
        let operation = self.capacity.acquire()?;
        let key = original.id.clone();
        let runtime = original.runtime_digest.clone();
        let record = Arc::new(Mutex::new(StoreRecord {
            original: Arc::new(original),
            registration: registration.clone(),
            phase: "registered",
            original_project_bound: false,
            result: None,
            writer: None,
            publication: None,
            publication_error: None,
            consumed: false,
            _operation: operation,
        }));
        self.records
            .insert(key, (runtime, registration, Arc::downgrade(&record)));
        Ok(record)
    }
    fn release_consumed(&mut self, record: &Arc<Mutex<StoreRecord>>) -> Result<()> {
        let record = record.lock().unwrap_or_else(|e| e.into_inner());
        if !record.consumed {
            return Err("store record has no durable exact consumption".into());
        }
        match self.records.get(&record.original.id) {
            Some((runtime, registration, _))
                if *runtime == record.original.runtime_digest
                    && *registration == record.registration => {}
            _ => return Err("store consumed registration changed".into()),
        }
        // Replay history lives in the durable Journal tombstone, not this
        // process-local heavy-record index. Removing this entry evicts no ID.
        self.records.remove(&record.original.id);
        Ok(())
    }
    fn status(&self, query: &StoreStatusQuery) -> StoreStatus {
        let record = self
            .records
            .get(&query.id)
            .filter(|(runtime, registration, _)| {
                *runtime == query.runtime_digest && *registration == query.registration
            })
            .and_then(|(_, _, record)| record.upgrade());
        match record {
            Some(record) => {
                let record = record.lock().unwrap_or_else(|e| e.into_inner());
                StoreStatus {
                    present: true,
                    phase: record.phase.into(),
                    completion: Some(record.completion()),
                }
            }
            None => StoreStatus {
                present: false,
                phase: "missing".into(),
                completion: None,
            },
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreStatusQuery {
    schema: String,
    pub id: String,
    pub runtime_digest: String,
    pub registration: String,
}
impl StoreStatusQuery {
    pub fn new(id: String, runtime_digest: String, registration: String) -> Self {
        Self {
            schema: STATUS_SCHEMA.into(),
            id,
            runtime_digest,
            registration,
        }
    }
    fn validate(&self) -> Result<()> {
        if self.schema != STATUS_SCHEMA
            || self.id.is_empty()
            || self.id.len() > 256
            || self.runtime_digest.len() != 64
            || self.registration.len() != 64
            || !self.registration.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("resident store status correlation invalid".into());
        }
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreStatus {
    pub present: bool,
    pub phase: String,
    pub completion: Option<StoreCompletion>,
}

#[derive(Default)]
struct NativeChallengeState {
    checks: usize,
    last_phase: Option<NativeStopPhase>,
}
impl NativeChallengeState {
    fn accept(
        &mut self,
        acquire: &StoreAcquire,
        registration: Option<&str>,
        project_bound: bool,
        expected_sequence: u64,
        frame: &NativeChallengeFrame,
    ) -> Result<()> {
        let binding = acquire
            .native_stop
            .as_ref()
            .ok_or("native Stop challenge has no registration")?;
        if registration != Some(frame.registration.as_str())
            || !project_bound
            || frame.sequence != expected_sequence
            || frame.id != acquire.id
            || frame.runtime_digest != acquire.runtime_digest
            || frame.binding_digest != binding.digest(acquire)?
            || frame.original_deadline != acquire.deadline
            || frame.challenge.len() != 64
            || !frame
                .challenge
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || frame.phase == NativeStopPhase::Registration
            || !native_phase_follows(self.last_phase, frame.phase)
            || self.checks >= MAX_NATIVE_CHECKS
        {
            return Err("native Stop challenge correlation, phase or budget mismatch".into());
        }
        MonotonicDeadline::receive(acquire.deadline)
            .map_err(err)?
            .check()
            .map_err(err)?;
        self.checks += 1;
        self.last_phase = Some(frame.phase);
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeChallengeFrame {
    sequence: u64,
    id: String,
    runtime_digest: String,
    registration: String,
    binding_digest: String,
    original_deadline: DeadlineEnvelope,
    challenge: String,
    phase: NativeStopPhase,
}
fn verify_native_reply(
    value: ReplyValue,
    challenge: &str,
    binding: &str,
    phase: NativeStopPhase,
) -> Result<()> {
    match value {
        ReplyValue::NativeStopChecked {
            challenge: actual,
            binding_digest,
            phase: actual_phase,
        } if actual == challenge && binding_digest == binding && actual_phase == phase => Ok(()),
        _ => Err("native Stop callback response differs from this challenge".into()),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum OwnerFrame {
    NativeStopCheck(NativeChallengeFrame),
    Registered {
        id: String,
        runtime_digest: String,
        registration: String,
    },
    ProjectBound {
        id: String,
        runtime_digest: String,
        registration: String,
    },
    WriteEngineFrame {
        sequence: u64,
        base64: String,
    },
    ReadEngineFrame {
        sequence: u64,
    },
    Credit {
        sequence: u64,
        bytes: usize,
    },
    PublicationWriteEngineFrame {
        sequence: u64,
        base64: String,
    },
    PublicationReadEngineFrame {
        sequence: u64,
    },
    PublicationCredit {
        sequence: u64,
        bytes: usize,
    },
    Complete {
        completion: StoreCompletion,
    },
}
fn decode_owner_frame(bytes: &[u8], generic_limit: usize) -> Result<OwnerFrame> {
    if bytes.len() > generic_limit.max(publication_wire::MAX_RELAY_FRAME_BYTES) {
        return Err("store relay envelope bound".into());
    }
    let frame = serde_json::from_slice(bytes).map_err(err)?;
    let limit = if matches!(&frame, OwnerFrame::PublicationWriteEngineFrame { .. }) {
        publication_wire::MAX_RELAY_FRAME_BYTES
    } else if matches!(&frame, OwnerFrame::NativeStopCheck(_)) {
        generic_limit.min(STATUS_MAX)
    } else {
        generic_limit
    };
    if bytes.len() > limit {
        return Err("store relay variant envelope bound".into());
    }
    Ok(frame)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayReply {
    schema: String,
    sequence: u64,
    result: std::result::Result<ReplyValue, String>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum ReplyValue {
    NativeStopChecked {
        challenge: String,
        binding_digest: String,
        phase: NativeStopPhase,
    },
    Written,
    Read {
        base64: String,
    },
    Credited,
}

/// Returns finite status even when relay loss prevents delivery of settlement.
/// A success acknowledgement is produced only after the actual frontend call.
pub fn acquire_store(
    c: &OwnerConfig,
    acquire: StoreAcquire,
    expires: Instant,
    is_cancelled: impl Fn() -> bool,
    transport: &mut (impl store::Transport + publication::Transport),
) -> StoreCompletion {
    if acquire.native_stop.is_some() || acquire.schema == NATIVE_ACQUIRE_SCHEMA {
        return StoreCompletion::unavailable(
            &acquire.id,
            &acquire.runtime_digest,
            "native Stop registration requires its native-local qualification callback".into(),
        );
    }
    acquire_store_inner(c, &acquire, expires, is_cancelled, None, transport)
}

/// The retained callback runs in the original native process; no owner challenge
/// is forwarded to the engine transport. The caller's QualifiedStop owns the
/// stock/profile/source checks and completed-prefix effect boundary.
pub fn acquire_native_stop_store(
    c: &OwnerConfig,
    registration: NativeStopRegistration<'_, '_>,
    expires: Instant,
    is_cancelled: impl Fn() -> bool,
    mut revalidate: impl FnMut(NativeStopCheck) -> Result<()>,
    transport: &mut (impl store::Transport + publication::Transport),
) -> StoreCompletion {
    let mut checked = |phase| {
        registration.check()?;
        revalidate(NativeStopCheck { phase })?;
        registration.check()
    };
    if let Err(reason) = checked(NativeStopPhase::Registration) {
        return StoreCompletion::unavailable(
            &registration.acquire.id,
            &registration.acquire.runtime_digest,
            reason,
        );
    }
    acquire_store_inner(
        c,
        &registration.acquire,
        expires,
        is_cancelled,
        Some(&mut checked),
        transport,
    )
}

fn acquire_store_inner(
    c: &OwnerConfig,
    acquire: &StoreAcquire,
    expires: Instant,
    is_cancelled: impl Fn() -> bool,
    mut native_check: Option<&mut dyn FnMut(NativeStopPhase) -> Result<()>>,
    transport: &mut (impl store::Transport + publication::Transport),
) -> StoreCompletion {
    let mut completion = StoreCompletion::unavailable(
        &acquire.id,
        &acquire.runtime_digest,
        "resident store transport did not settle".into(),
    );
    let exchange = (|| -> Result<()> {
        let original_deadline = MonotonicDeadline::receive(acquire.deadline).map_err(err)?;
        let expires = expires.min(original_deadline.expires());
        original_deadline.check().map_err(err)?;
        check(expires)?;
        let mut stream = connect(c, expires)?;
        write_all(
            &stream,
            &encoded(&acquire, c.limits.max_frame_bytes as usize)?,
            expires,
        )?;
        let mut pending = Vec::new();
        let mut sequence = 0u64;
        let mut publication_credit = publication_wire::CreditBudget::default();
        let mut native_state = NativeChallengeState::default();
        loop {
            let bytes = frame_while(
                &mut stream,
                &mut pending,
                (c.limits.max_frame_bytes as usize).max(publication_wire::MAX_RELAY_FRAME_BYTES),
                expires,
                || {
                    original_deadline.check().map_err(err)?;
                    if is_cancelled() {
                        Err("resident store frontend cancelled".into())
                    } else {
                        Ok(())
                    }
                },
            )
            .map_err(|reason| {
                if completion.registration.is_none() {
                    format!(
                        "resident store acquisition v2 unavailable before registration: {reason}"
                    )
                } else {
                    reason
                }
            })?;
            match decode_owner_frame(&bytes, c.limits.max_frame_bytes as usize)? {
                OwnerFrame::Registered {
                    id,
                    runtime_digest,
                    registration,
                } => {
                    if id != acquire.id
                        || runtime_digest != acquire.runtime_digest
                        || completion.registration.is_some()
                        || registration.len() != 64
                    {
                        return Err("resident store registration correlation mismatch".into());
                    }
                    completion.registration = Some(registration);
                }
                OwnerFrame::ProjectBound {
                    id,
                    runtime_digest,
                    registration,
                } => {
                    if id != acquire.id
                        || runtime_digest != acquire.runtime_digest
                        || completion.registration.as_deref() != Some(&registration)
                    {
                        return Err("resident store project binding correlation mismatch".into());
                    }
                    completion.original_project_bound = true;
                }
                OwnerFrame::Complete { completion: result } => {
                    if result.id != acquire.id
                        || result.runtime_digest != acquire.runtime_digest
                        || (completion.registration.is_some()
                            && result.registration != completion.registration)
                        || (completion.original_project_bound && !result.original_project_bound)
                        || (result.error.is_none()
                            && (completion.registration.is_none()
                                || result.acquisition.is_none()
                                || (acquire.native_stop.is_some()
                                    && native_state.last_phase
                                        != Some(NativeStopPhase::BeforePublication))))
                    {
                        return Err("resident store completion correlation mismatch".into());
                    }
                    completion = result;
                    return Ok(());
                }
                OwnerFrame::NativeStopCheck(frame) => {
                    native_state.accept(
                        acquire,
                        completion.registration.as_deref(),
                        completion.original_project_bound,
                        sequence
                            .checked_add(1)
                            .ok_or("native relay sequence overflow")?,
                        &frame,
                    )?;
                    sequence = frame.sequence;
                    let result = native_check
                        .as_mut()
                        .ok_or("native Stop challenge has no local owner")?(
                        frame.phase
                    )
                    .and_then(|()| {
                        original_deadline.check().map_err(err)?;
                        check(expires)?;
                        Ok(ReplyValue::NativeStopChecked {
                            challenge: frame.challenge,
                            binding_digest: frame.binding_digest,
                            phase: frame.phase,
                        })
                    });
                    let failed = result.as_ref().err().cloned();
                    // Refusal is a fixed bounded wire value; the original native
                    // frontend retains the complete local qualification reason.
                    let wire_result =
                        result.map_err(|_| "original native Stop qualification refused".to_owned());
                    write_all(
                        &stream,
                        &encoded(
                            &RelayReply {
                                schema: REPLY_SCHEMA.into(),
                                sequence,
                                result: wire_result,
                            },
                            STATUS_MAX,
                        )?,
                        expires,
                    )?;
                    if let Some(reason) = failed {
                        return Err(reason);
                    }
                }
                command => {
                    if acquire.native_stop.is_some()
                        && !matches!(
                            native_state.last_phase,
                            Some(NativeStopPhase::BeforeSql | NativeStopPhase::BeforePublication)
                        )
                    {
                        return Err("native engine relay preceded native SQL admission".into());
                    }
                    let received = match &command {
                        OwnerFrame::WriteEngineFrame { sequence, .. }
                        | OwnerFrame::ReadEngineFrame { sequence }
                        | OwnerFrame::Credit { sequence, .. }
                        | OwnerFrame::PublicationWriteEngineFrame { sequence, .. }
                        | OwnerFrame::PublicationReadEngineFrame { sequence }
                        | OwnerFrame::PublicationCredit { sequence, .. } => *sequence,
                        _ => unreachable!(),
                    };
                    if received != sequence + 1
                        || completion.registration.is_none()
                        || !completion.original_project_bound
                    {
                        return Err("resident store relay sequence or phase mismatch".into());
                    }
                    let (received, result) = match command {
                        OwnerFrame::WriteEngineFrame { sequence, base64 } => (
                            sequence,
                            STANDARD
                                .decode(base64)
                                .map_err(err)
                                .and_then(|bytes| {
                                    store::Transport::write(transport, &bytes, expires)
                                })
                                .map(|()| ReplyValue::Written),
                        ),
                        OwnerFrame::ReadEngineFrame { sequence } => (
                            sequence,
                            store::Transport::read(transport, expires).and_then(|bytes| {
                                if bytes.len() > store::MAX_CONTROL_BYTES {
                                    Err("resident store control exceeds bound".into())
                                } else {
                                    Ok(ReplyValue::Read {
                                        base64: STANDARD.encode(bytes),
                                    })
                                }
                            }),
                        ),
                        OwnerFrame::Credit { sequence, bytes } => (
                            sequence,
                            store::Transport::credit(transport, bytes)
                                .map(|()| ReplyValue::Credited),
                        ),
                        OwnerFrame::PublicationWriteEngineFrame { sequence, base64 } => (
                            sequence,
                            STANDARD
                                .decode(&base64)
                                .map_err(err)
                                .and_then(|bytes| {
                                    if bytes.len() > publication_wire::MAX_FRAME_BYTES
                                        || STANDARD.encode(&bytes) != base64
                                    {
                                        Err("resident publication write bound or encoding".into())
                                    } else {
                                        publication::Transport::write(transport, &bytes, expires)
                                    }
                                })
                                .map(|()| ReplyValue::Written),
                        ),
                        OwnerFrame::PublicationReadEngineFrame { sequence } => (
                            sequence,
                            publication::Transport::read(transport, expires).and_then(|bytes| {
                                if bytes.len() > publication_wire::MAX_FRAME_BYTES {
                                    Err("resident publication frame exceeds bound".into())
                                } else {
                                    Ok(ReplyValue::Read {
                                        base64: STANDARD.encode(bytes),
                                    })
                                }
                            }),
                        ),
                        OwnerFrame::PublicationCredit { sequence, bytes } => (
                            sequence,
                            publication_credit
                                .accept(bytes)
                                .and_then(|()| publication::Transport::credit(transport, bytes))
                                .map(|()| ReplyValue::Credited),
                        ),
                        _ => unreachable!(),
                    };
                    sequence = received;
                    let reply = RelayReply {
                        schema: REPLY_SCHEMA.into(),
                        sequence,
                        result,
                    };
                    write_all(&stream, &encoded(&reply, REPLY_MAX)?, expires)?;
                }
            }
        }
    })();
    if let Err(error) = exchange {
        completion.error = Some(error);
    }
    completion
}
/// Read only an existing owner. Absence never starts a replacement owner.
pub fn store_status(
    c: &OwnerConfig,
    query: &StoreStatusQuery,
    expires: Instant,
) -> Result<StoreStatus> {
    query.validate()?;
    validate_config(c)?;
    same_config(c, &read_config(&config_path(c))?)?;
    let mut stream = UnixStream::connect(socket_path(c)).map_err(err)?;
    peer(&stream)?;
    stream.set_nonblocking(true).map_err(err)?;
    write_all(&stream, &encoded(query, STATUS_MAX)?, expires)?;
    let mut pending = Vec::new();
    let bytes = frame(&mut stream, &mut pending, STATUS_MAX, expires)?;
    if !pending.is_empty() {
        return Err("resident status unsolicited bytes".into());
    }
    serde_json::from_slice(&bytes).map_err(err)
}

struct RelayTransport {
    stream: UnixStream,
    replies: mpsc::Receiver<RelayReply>,
    cancelled: Arc<AtomicBool>,
    sequence: u64,
    expires: Instant,
    deadline: Arc<MonotonicDeadline>,
    limit: usize,
    native: Option<NativeAdmission>,
}
impl RelayTransport {
    fn check_deadline(&self) -> Result<()> {
        self.deadline.check().map_err(err)?;
        check(self.expires)?;
        if let Some(native) = &self.native {
            native.peer.check_live(|| {
                if self.cancelled.load(Ordering::Acquire) {
                    Err("resident native Stop frontend disconnected".into())
                } else {
                    Ok(())
                }
            })?;
        }
        Ok(())
    }
    fn exchange(&mut self, command: OwnerFrame, expected: &'static str) -> Result<ReplyValue> {
        self.check_deadline()?;
        if self.cancelled.load(Ordering::Acquire) {
            return Err("resident store frontend disconnected".into());
        }
        let limit = if matches!(&command, OwnerFrame::PublicationWriteEngineFrame { .. }) {
            publication_wire::MAX_RELAY_FRAME_BYTES
        } else {
            self.limit
        };
        write_all(&self.stream, &encoded(&command, limit)?, self.expires)?;
        loop {
            match self.replies.recv_timeout(TICK) {
                Ok(reply) => {
                    self.check_deadline()?;
                    if reply.schema != REPLY_SCHEMA || reply.sequence != self.sequence {
                        return Err("resident store relay acknowledgement mismatch".into());
                    }
                    let value = reply.result?;
                    if !matches!(
                        (&value, expected),
                        (ReplyValue::Written, "write")
                            | (ReplyValue::Read { .. }, "read")
                            | (ReplyValue::Credited, "credit")
                            | (ReplyValue::NativeStopChecked { .. }, "native_stop")
                    ) {
                        return Err(
                            "resident store relay acknowledgement operation mismatch".into()
                        );
                    }
                    return Ok(value);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.check_deadline()?;
                    if self.cancelled.load(Ordering::Acquire) {
                        return Err("resident store frontend disconnected".into());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("resident store relay reader closed".into());
                }
            }
        }
    }
}
impl RelayTransport {
    fn native_check(&mut self, phase: NativeStopPhase) -> Result<()> {
        let Some(mut native) = self.native.take() else {
            return Ok(());
        };
        let result = (|| {
            self.check_deadline()?;
            if phase == NativeStopPhase::Registration
                || native.checks >= MAX_NATIVE_CHECKS
                || !native_phase_follows(native.last_phase, phase)
            {
                return Err("resident native Stop check phase or budget mismatch".into());
            }
            let cancelled = Arc::clone(&self.cancelled);
            let check_cancelled = || {
                if cancelled.load(Ordering::Acquire) {
                    Err("resident native Stop frontend disconnected".into())
                } else {
                    Ok(())
                }
            };
            // Full admitted-image verification occurs after queueing. Later
            // local checks retain this producer; the original frontend callback
            // revalidates its genuine stock/source/profile owners per phase.
            if phase == NativeStopPhase::BeforeReservation {
                native.peer.revalidate(check_cancelled)?;
            } else {
                native.peer.check_live(check_cancelled)?;
            }
            native.checks += 1;
            native.last_phase = Some(phase);
            self.sequence = self
                .sequence
                .checked_add(1)
                .ok_or("native relay sequence exhausted")?;
            let challenge = random()?;
            let reply = self.exchange(
                OwnerFrame::NativeStopCheck(NativeChallengeFrame {
                    sequence: self.sequence,
                    id: native.id.clone(),
                    runtime_digest: native.runtime_digest.clone(),
                    registration: native.registration.clone(),
                    binding_digest: native.binding_digest.clone(),
                    original_deadline: native.binding.original_deadline,
                    challenge: challenge.clone(),
                    phase,
                }),
                "native_stop",
            )?;
            verify_native_reply(reply, &challenge, &native.binding_digest, phase)?;
            native.peer.check_live(|| {
                if self.cancelled.load(Ordering::Acquire) {
                    Err("resident native Stop frontend disconnected".into())
                } else {
                    Ok(())
                }
            })?;
            self.check_deadline()
        })();
        self.native = Some(native);
        result
    }
    fn native_project(&self) -> Result<NativeStoreProject> {
        let native = self
            .native
            .as_ref()
            .ok_or("native store has no authenticated producer")?;
        if native.last_phase != Some(NativeStopPhase::BeforeSql) {
            return Err("native store project requires its before-SQL check".into());
        }
        self.check_deadline()?;
        Ok(NativeStoreProject {
            id: native.id.clone(),
            runtime_digest: native.runtime_digest.clone(),
            root: native.binding.canonical_root.clone(),
            session_id: native.binding.session_id.clone(),
            payload_sha256: native.binding.payload_sha256.clone(),
            deadline: Arc::clone(&self.deadline),
        })
    }
}

impl store::Transport for RelayTransport {
    fn write(&mut self, bytes: &[u8], _: Instant) -> Result<()> {
        self.sequence += 1;
        self.exchange(
            OwnerFrame::WriteEngineFrame {
                sequence: self.sequence,
                base64: STANDARD.encode(bytes),
            },
            "write",
        )
        .map(|_| ())
    }
    fn read(&mut self, _: Instant) -> Result<Vec<u8>> {
        self.sequence += 1;
        match self.exchange(
            OwnerFrame::ReadEngineFrame {
                sequence: self.sequence,
            },
            "read",
        )? {
            ReplyValue::Read { base64 }
                if base64.len() <= store::MAX_CONTROL_BYTES.div_ceil(3) * 4 =>
            {
                let bytes = STANDARD.decode(&base64).map_err(err)?;
                if bytes.len() > store::MAX_CONTROL_BYTES || STANDARD.encode(&bytes) != base64 {
                    return Err("resident store control exceeds bound or encoding".into());
                }
                Ok(bytes)
            }
            _ => Err("resident store control exceeds bound".into()),
        }
    }
    fn credit(&mut self, bytes: usize) -> Result<()> {
        self.sequence += 1;
        self.exchange(
            OwnerFrame::Credit {
                sequence: self.sequence,
                bytes,
            },
            "credit",
        )
        .map(|_| ())
    }
}
impl publication::Transport for RelayTransport {
    fn credit(&mut self, bytes: usize) -> Result<()> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("publication relay sequence exhausted")?;
        self.exchange(
            OwnerFrame::PublicationCredit {
                sequence: self.sequence,
                bytes,
            },
            "credit",
        )
        .map(|_| ())
    }

    fn write(&mut self, bytes: &[u8], deadline: Instant) -> Result<()> {
        if bytes.len() > publication_wire::MAX_FRAME_BYTES {
            return Err("publication relay write bound".into());
        }
        check(deadline)?;
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("publication relay sequence exhausted")?;
        self.exchange(
            OwnerFrame::PublicationWriteEngineFrame {
                sequence: self.sequence,
                base64: STANDARD.encode(bytes),
            },
            "write",
        )
        .map(|_| ())
    }
    fn read(&mut self, _: Instant) -> Result<Vec<u8>> {
        self.sequence += 1;
        match self.exchange(
            OwnerFrame::PublicationReadEngineFrame {
                sequence: self.sequence,
            },
            "read",
        )? {
            ReplyValue::Read { base64 }
                if base64.len() <= publication_wire::MAX_FRAME_BYTES.div_ceil(3) * 4 =>
            {
                let bytes = STANDARD.decode(&base64).map_err(err)?;
                if bytes.len() > publication_wire::MAX_FRAME_BYTES
                    || STANDARD.encode(&bytes) != base64
                {
                    return Err("invalid publication relay bytes".into());
                }
                Ok(bytes)
            }
            _ => Err("publication relay frame bound".into()),
        }
    }
}

pub(super) struct StoreJob {
    record: Arc<Mutex<StoreRecord>>,
    registry: Arc<Mutex<StoreRegistry>>,
    transport: RelayTransport,
    _connection: Arc<ConnectionPermit>,
    _project: Arc<ProjectPermit>,
}
/// The waiting slot is a mailbox barrier: no later mailbox item is read while
/// it is occupied, and an admitted renderer cohort retains its whole lifetime.
pub(super) fn take_after_cohort(
    waiting: &mut Option<StoreJob>,
    pending: usize,
) -> Option<StoreJob> {
    if pending == 0 { waiting.take() } else { None }
}
impl StoreJob {
    pub(super) fn invocation_id(&self) -> String {
        // Release the record lock before the caller emits an observation.
        let invocation = {
            self.record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .original
                .id
                .clone()
        };
        invocation
    }
    pub(super) fn refuse(self, reason: &str) {
        settle_quarantine(
            &self.registry,
            &self.record,
            Err(store::ServeError::AfterProjectBinding(reason.into())),
        );
        self.complete();
    }
    fn complete(&self) {
        let completion = self
            .record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .completion();
        let _ = encoded(&OwnerFrame::Complete { completion }, STATUS_MAX)
            .and_then(|bytes| write_all(&self.transport.stream, &bytes, self.transport.expires));
    }
}
impl Drop for StoreJob {
    fn drop(&mut self) {
        let _ = self.transport.stream.shutdown(std::net::Shutdown::Both);
    }
}
fn settle_quarantine(
    registry: &Arc<Mutex<StoreRegistry>>,
    record: &Arc<Mutex<StoreRecord>>,
    result: Settlement,
) {
    record
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .settle(result);
    registry
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .quarantine
        .push(Arc::clone(record));
}
impl Actor {
    pub(super) fn acquire_store_job(&mut self, mut job: StoreJob) {
        // Store work is reached only after the prepared renderer cohort drains.
        // Retain the strong record BEFORE any acquisition attempt.
        self.store_records.push(Arc::clone(&job.record));
        let original = {
            let mut record = job.record.lock().unwrap_or_else(|e| e.into_inner());
            record.phase = "acquiring";
            Arc::clone(&record.original)
        };
        let deadline_check = if job.transport.deadline.envelope() != original.deadline {
            Err("resident store deadline binding mismatch".into())
        } else {
            job.transport.check_deadline()
        };
        if let Err(reason) = deadline_check {
            self.stage("store_deadline_refused", &original.id);
            job.refuse(&reason);
            return;
        }
        if original.native_stop.is_some() != job.transport.native.is_some() {
            job.refuse("native Stop registration lost authenticated producer custody");
            return;
        }
        if original.publication {
            self.acquire_publication_job(job, original);
            return;
        }
        self.stage("store_acquisition_start", &original.id);
        let result = match self.check_unknown_fence(&original.id, job.transport.expires) {
            Err(reason) => Err(store::ServeError::AfterProjectBinding(reason)),
            Ok(()) => match original.request() {
                Err(reason) => Err(store::ServeError::AfterProjectBinding(reason)),
                Ok(bytes) => {
                    let cancelled = Arc::clone(&job.transport.cancelled);
                    let deadline = Arc::clone(&job.transport.deadline);
                    let expires = job.transport.expires;
                    store::serve(
                        &bytes,
                        original.invocation(),
                        job.transport.expires,
                        move || {
                            cancelled.load(Ordering::Acquire)
                                || deadline.check().is_err()
                                || Instant::now() >= expires
                        },
                        &mut job.transport,
                    )
                }
            },
        };
        job.record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .settle(result);
        self.stage("store_settlement_retained", &original.id);
        job.complete();
    }

    fn reserve_original(
        &mut self,
        original: &StoreAcquire,
        expires: Instant,
        effect_check: &crate::monotonic_deadline::EffectCheck<'_>,
    ) -> Result<journal::Dispatch> {
        self.check_unknown_fence(&original.id, expires)?;
        let original_bytes = serde_json::to_vec(original).map_err(err)?;
        let verified = sha(&original_bytes);
        let key =
            store::correlation_root(&original.request()?, &original.invocation()).map_err(err)?;
        let service_key = wire::project_service_key(&key).map_err(err)?;
        let request_id = publication::original_request_id(&original.id);
        match self
            .journal
            .admit_checked(
                journal::Identity {
                    request_id: request_id.clone(),
                    argument_digest: verified.clone(),
                    project_service_key: service_key,
                    source_generation: original.runtime_digest.clone(),
                    execution_image_digest: original.runtime_digest.clone(),
                },
                verified.as_bytes(),
                expires,
                effect_check,
            )
            .map_err(err)?
        {
            journal::Admission::Accepted {
                duplicate: false, ..
            } => {}
            journal::Admission::Accepted { .. } => {
                return Err("original invocation already reserved; no replay".into());
            }
            journal::Admission::Rejected(outcome) => return Err(outcome.reason),
        }
        let dispatch = self
            .journal
            .begin_next_checked(
                &original.runtime_digest,
                &original.runtime_digest,
                expires,
                effect_check,
            )
            .map_err(err)?
            .ok_or("original dispatch unavailable")?;
        if dispatch.operation().identity().request_id != request_id {
            self.unknown = true;
            return Err("another queued operation precedes original publication".into());
        }
        Ok(dispatch)
    }
    fn acquire_publication_job(&mut self, mut job: StoreJob, original: Arc<StoreAcquire>) {
        let expires = job.transport.expires;
        let mut dispatch = None;
        let outcome = (|| -> Result<()> {
            let request = original.request()?;
            let root = store::correlation_root(&request, &original.invocation()).map_err(err)?;
            job.transport.check_deadline()?;
            let effect_deadline = Arc::clone(&job.transport.deadline);
            let effect_cancelled = Arc::clone(&job.transport.cancelled);
            let native_route = job.transport.native.is_some();
            // The actor is single-threaded. Interior borrowing keeps one relay
            // sequence/reader while checked filesystem boundaries can perform a
            // native-only roundtrip; no socket or callback reaches Node.
            let relay = std::cell::RefCell::new(&mut job.transport);
            relay
                .borrow_mut()
                .native_check(NativeStopPhase::BeforeReservation)?;
            if native_route {
                self.stage("native_stop_postqueue_validated", &original.id);
            }
            let effect_check = |at: &'static str| {
                effect_deadline.check().map_err(err)?;
                check(expires)?;
                if effect_cancelled.load(Ordering::Acquire) {
                    return Err("publication original frontend disconnected".into());
                }
                let phase = match at {
                    "owner.writer" => Some(NativeStopPhase::BeforeWriter),
                    "custody.owner_locked" => Some(NativeStopPhase::WriterLocked),
                    "owner.writer.retired" => Some(NativeStopPhase::WriterRetired),
                    _ => None,
                };
                if let Some(phase) = phase {
                    relay.borrow_mut().native_check(phase)?;
                }
                relay.borrow().check_deadline()
            };
            let reserved = self.reserve_original(&original, expires, &effect_check)?;
            self.stage("publication_original_reserved", &original.id);
            dispatch = Some(reserved);
            relay.borrow().check_deadline()?;
            let writer =
                self.publication_writer_checked(Path::new(&root), expires, &effect_check)?;
            job.record.lock().unwrap_or_else(|e| e.into_inner()).writer = Some(Arc::clone(&writer));
            self.stage("publication_writer_retained", &original.id);
            relay.borrow().check_deadline()?;
            let cancelled = Arc::clone(&effect_cancelled);
            let deadline = Arc::clone(&effect_deadline);
            relay
                .borrow_mut()
                .native_check(NativeStopPhase::BeforeSql)?;
            let cancelled = move || {
                cancelled.load(Ordering::Acquire)
                    || deadline.check().is_err()
                    || Instant::now() >= expires
            };
            let acquired = if native_route {
                let project = relay.borrow().native_project()?;
                store::serve_admitted(
                    &request,
                    original.invocation(),
                    &project,
                    expires,
                    cancelled,
                    &mut **relay.borrow_mut(),
                )
            } else {
                store::serve(
                    &request,
                    original.invocation(),
                    expires,
                    cancelled,
                    &mut **relay.borrow_mut(),
                )
            };
            let exhausted_closed = acquired.as_ref().is_ok_and(|a| {
                matches!(a.end, sql::End::Exhausted)
                    && a.first_failure.is_none()
                    && a.cleanup.progress_unregistered
                    && matches!(a.cleanup.busy_unregistered, sql::CleanupCall::Succeeded)
                    && matches!(a.cleanup.finalized, sql::CleanupCall::Succeeded)
                    && matches!(a.cleanup.rollback, sql::CleanupCall::Succeeded)
                    && matches!(a.cleanup.close, sql::CleanupCall::Succeeded)
                    && !a.cleanup.retained_uncertain
                    && a.retained.is_none()
            });
            job.record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .settle(acquired);
            if !exhausted_closed {
                return Err(
                    "publication requires actual exhausted acquisition and confirmed CLOSED".into(),
                );
            }
            self.stage("publication_store_closed", &original.id);
            let token = serde_json::from_slice::<serde_json::Value>(&request)
                .map_err(err)?
                .get("token")
                .and_then(|v| v.as_str())
                .ok_or("original store token unavailable")?
                .to_owned();
            let sid = original
                .ready_session_id
                .as_deref()
                .ok_or("original store session unavailable")?;
            let vendor = match original.surface.as_str() {
                "opencode" => ".opencode",
                "zcode" => ".zcode",
                _ => return Err("unsupported original store publication surface".into()),
            };
            let audit_root = original
                .caller_environment
                .get("CAWS_LOG_DIR")
                .filter(|v| !v.is_empty())
                .map(|value| {
                    let path = PathBuf::from(value);
                    if path.is_absolute() {
                        path
                    } else if let Some(binding) = &original.native_stop {
                        Path::new(&binding.render_cwd).join(path)
                    } else {
                        path
                    }
                })
                .unwrap_or_else(|| Path::new(&root).join(vendor).join("logs"));
            let sources = publication::CapturedStopSources::capture(
                Path::new(&root),
                sid,
                &audit_root,
                Arc::clone(&effect_deadline),
                Arc::clone(&effect_cancelled),
                expires,
                &effect_check,
            )?;
            let mut publication = publication::Publication::capture_stop_checked(
                publication::OriginalBinding {
                    project: PathBuf::from(root),
                    id: original.id.clone(),
                    runtime_digest: original.runtime_digest.clone(),
                    token,
                    session_id: sid.into(),
                    reason: String::new(),
                    ended_at: original.captured_at.clone(),
                },
                writer,
                dispatch.as_ref().expect("original reserved"),
                sources,
                expires,
                &effect_check,
            )?;
            let result = (|| -> Result<()> {
                publication.exchange_phase(
                    publication_wire::Kind::Projection,
                    &mut **relay.borrow_mut(),
                    expires,
                )?;
                if !publication.aborted() {
                    publication.exchange_phase(
                        publication_wire::Kind::Render,
                        &mut **relay.borrow_mut(),
                        expires,
                    )?;
                }
                relay
                    .borrow_mut()
                    .native_check(NativeStopPhase::BeforePublication)?;
                if !publication.aborted() {
                    relay.borrow().check_deadline()?;
                    publication.publish_checked(expires, &effect_check)?;
                }
                let terminal = publication.terminal_digest()?;
                relay.borrow().check_deadline()?;
                let returned = self
                    .journal
                    .returned_checked(
                        dispatch.as_ref().expect("original reserved"),
                        journal::ReturnedResult::SessionPublication {
                            terminal_digest: terminal.clone(),
                        },
                        Some(terminal),
                        expires,
                        &effect_check,
                    )
                    .map_err(err)?;
                self.stage("publication_marker_committed", &original.id);
                publication.write_result(&mut **relay.borrow_mut(), expires)?;
                let consumed = publication::Transport::read(&mut **relay.borrow_mut(), expires)?;
                let terminal =
                    publication.consume_receipt(&consumed, &mut **relay.borrow_mut(), expires)?;
                self.journal
                    .consume_checked(&returned, &terminal, expires, &effect_check)
                    .map_err(err)?;
                self.stage("publication_consumed_durable", &original.id);
                Ok(())
            })();
            job.record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .publication = Some(publication);
            result
        })();
        match outcome {
            Ok(()) => {
                {
                    let mut record = job.record.lock().unwrap_or_else(|e| e.into_inner());
                    record.consumed = true;
                    record.phase = "consumed";
                    record.publication.take();
                    record.writer.take();
                }
                let release = job
                    .registry
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .release_consumed(&job.record);
                if let Err(reason) = release {
                    self.unknown = true;
                    job.record
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .publication_error = Some(reason);
                } else {
                    self.store_records
                        .retain(|record| !Arc::ptr_eq(record, &job.record));
                    self.writer_custody.take();
                    self.stage("publication_heavy_released", &original.id);
                }
            }
            Err(reason) => {
                // Durable Running or returned publication keeps the restart
                // fence. The record/actor retain every live ownership handle.
                if let Some(dispatch) = &dispatch {
                    self.unknown = true;
                    let expires = Instant::now()
                        + Duration::from_millis(self.config.limits.request_ms as u64);
                    let _ = self.journal.unknown(dispatch, expires);
                }
                job.record
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .publication_error = Some(reason);
                self.stage("publication_retained", &original.id);
            }
        }
        job.complete();
    }
}

/// Called only after the existing host connection/peer admission. Distinct
/// first-message schemas leave RenderOffer v1 and renderer EOF rules intact.
pub(super) fn receive_first(
    stream: &mut UnixStream,
    bytes: &[u8],
    surplus: &[u8],
    received: Instant,
    c: &Arc<OwnerConfig>,
    routing: &Arc<Mutex<Routing>>,
    permit: &Arc<ConnectionPermit>,
    registry: &Arc<Mutex<StoreRegistry>>,
) -> bool {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Envelope {
        schema: String,
        id: Option<String>,
        runtime_digest: Option<String>,
    }
    let Ok(envelope) = serde_json::from_slice::<Envelope>(bytes) else {
        return false;
    };
    if envelope.schema == STATUS_SCHEMA {
        let result = (|| -> Result<()> {
            if !surplus.is_empty() || bytes.len() > STATUS_MAX {
                return Err("resident status frame bound".into());
            }
            let query: StoreStatusQuery = serde_json::from_slice(bytes).map_err(err)?;
            query.validate()?;
            let status = registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .status(&query);
            write_all(
                stream,
                &encoded(&status, STATUS_MAX)?,
                until(
                    c.limits.first_frame_ms as u64,
                    received + Duration::from_millis(c.limits.request_ms as u64),
                ),
            )
        })();
        let _ = result;
        return true;
    }
    if !envelope.schema.starts_with(ACQUIRE_PREFIX) {
        return false;
    }
    // This separate deadline permits a refusal diagnostic only. It never
    // admits a store operation or renews an expired invocation.
    let Some(refusal_expires) =
        received.checked_add(Duration::from_millis(u64::from(c.limits.first_frame_ms)))
    else {
        return true;
    };
    let refuse = |stream: &mut UnixStream, reason: String| {
        let id = envelope
            .id
            .as_deref()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .unwrap_or("");
        let runtime = envelope
            .runtime_digest
            .as_deref()
            .filter(|s| s.len() == 64)
            .unwrap_or("");
        let completion = StoreCompletion::unavailable(id, runtime, reason);
        let _ = encoded(&OwnerFrame::Complete { completion }, STATUS_MAX)
            .and_then(|bytes| write_all(stream, &bytes, refusal_expires));
    };
    if !matches!(
        envelope.schema.as_str(),
        ACQUIRE_SCHEMA | NATIVE_ACQUIRE_SCHEMA
    ) {
        refuse(
            stream,
            "resident store unsupported acquisition schema; v2 absolute deadline required".into(),
        );
        return true;
    }
    let acquire = match serde_json::from_slice::<StoreAcquire>(bytes) {
        Ok(acquire) => acquire,
        Err(_) => {
            refuse(
                stream,
                "resident store invalid v2 absolute deadline envelope".into(),
            );
            return true;
        }
    };
    let mut refused = StoreCompletion::unavailable(
        &acquire.id,
        &acquire.runtime_digest,
        "resident store refused".into(),
    );
    let prepared = (|| -> Result<(Arc<Mutex<StoreRecord>>, Vec<u8>, String, Arc<MonotonicDeadline>, Instant, Option<super::native_peer::NativePeer>)> {
        // Validate before request routing or registry/capacity reservation.
        let (deadline, expires) = restore_deadline(&acquire, received, c.limits.request_ms)?;
        if !surplus.is_empty() {
            return Err("resident store unsolicited first-message bytes".into());
        }
        let request = acquire.request()?;
        let root = store::correlation_root(&request, &acquire.invocation()).map_err(err)?;
        let native_peer = if let Some(binding) = &acquire.native_stop {
            binding.validate(&acquire, &request)?;
            Some(super::native_peer::NativePeer::capture(stream, &c.home,
                &acquire.runtime_digest, Arc::clone(&deadline), || {
                    deadline.check().map_err(err)?; check(expires)
                })?)
        } else { None };
        #[cfg(test)]
        observe_store_registry_contention(registry);
        let record = {
            let mut locked = registry.lock().unwrap_or_else(|e| e.into_inner());
            // Waiting for registry custody consumes the original deadline too.
            // Retain the same original and cap; do not reconstruct or renew.
            deadline.check().map_err(err)?;
            check(expires)?;
            locked.reserve(acquire)?
        };
        Ok((record, request, root, deadline, expires, native_peer))
    })();
    let (record, _request, expected_root, deadline, expires, native_peer) = match prepared {
        Ok(value) => value,
        Err(error) => {
            refused.error = Some(error);
            let _ = encoded(
                &OwnerFrame::Complete {
                    completion: refused,
                },
                STATUS_MAX,
            )
            .and_then(|bytes| write_all(stream, &bytes, refusal_expires));
            return true;
        }
    };
    let (original, registration) = {
        let record = record.lock().unwrap_or_else(|e| e.into_inner());
        (Arc::clone(&record.original), record.registration.clone())
    };
    routing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .observations
        .emit(Observation::StoreRegistered {
            invocation_id: &original.id,
            runtime_digest: &original.runtime_digest,
            registration: &registration,
        });
    let native = match native_peer {
        Some(peer) => {
            let binding = original
                .native_stop
                .as_ref()
                .expect("native admission binding")
                .clone();
            let digest = binding.digest(&original);
            let binding_digest = match digest {
                Ok(value) => value,
                Err(reason) => {
                    settle_quarantine(
                        registry,
                        &record,
                        Err(store::ServeError::BeforeAcquisition(reason)),
                    );
                    return true;
                }
            };
            Some(NativeAdmission {
                peer,
                id: original.id.clone(),
                runtime_digest: original.runtime_digest.clone(),
                binding,
                binding_digest,
                registration: registration.clone(),
                checks: 0,
                last_phase: None,
            })
        }
        None => None,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let (reply_tx, replies) = mpsc::sync_channel(1);
    let mut reader = match stream.try_clone() {
        Ok(reader) => reader,
        Err(error) => {
            settle_quarantine(
                registry,
                &record,
                Err(store::ServeError::BeforeAcquisition(error.to_string())),
            );
            return true;
        }
    };
    let reader_cancelled = Arc::clone(&cancelled);
    let reader_deadline = Arc::clone(&deadline);
    let reply_generic_limit = c.limits.max_frame_bytes as usize;
    let reader_join = thread::spawn(move || {
        let mut pending = Vec::new();
        loop {
            let result = frame_while(&mut reader, &mut pending, REPLY_MAX, expires, || {
                reader_deadline.check().map_err(err)
            })
            .and_then(|bytes| {
                let reply: RelayReply = serde_json::from_slice(&bytes).map_err(err)?;
                if matches!(&reply.result, Ok(ReplyValue::NativeStopChecked { .. }))
                    && bytes.len() > STATUS_MAX
                {
                    return Err("native Stop callback reply exceeds bound".into());
                }
                if bytes.len() > reply_generic_limit
                    && !matches!(&reply.result, Ok(ReplyValue::Read { .. }))
                {
                    return Err("relay reply variant envelope bound".into());
                }
                Ok(reply)
            });
            match result {
                Ok(reply) => {
                    if reply_tx.try_send(reply).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        reader_cancelled.store(true, Ordering::Release);
    });
    let admission = (|| -> std::result::Result<(), store::ServeError> {
        let bytes = encoded(
            &OwnerFrame::Registered {
                id: original.id.clone(),
                runtime_digest: original.runtime_digest.clone(),
                registration: registration.clone(),
            },
            STATUS_MAX,
        )?;
        write_all(stream, &bytes, expires)?;
        record.lock().unwrap_or_else(|e| e.into_inner()).phase = "observing_original";
        let canonical_root = if let Some(admitted) = &native {
            admitted.peer.check_live(|| {
                if cancelled.load(Ordering::Acquire) {
                    Err("native original disconnected before routing".into())
                } else {
                    deadline.check().map_err(err)
                }
            })?;
            if admitted.binding.canonical_root != expected_root {
                return Err(store::ServeError::BeforeAcquisition(
                    "native original project routing mismatch".into(),
                ));
            }
            PathBuf::from(&admitted.binding.canonical_root)
        } else {
            let project = crate::invocation_project::observe(
                &original.caller_cwd,
                &original.caller_environment,
                &original.original_payload,
                expires,
                &|| cancelled.load(Ordering::Acquire) || deadline.check().is_err(),
            )
            .map_err(|error| store::ServeError::ProjectObservation(Box::new(error)))?;
            if project.canonical_root.to_str() != Some(&expected_root) {
                return Err(store::ServeError::BeforeAcquisition(
                    "store original project binding mismatch".into(),
                ));
            }
            project.canonical_root
        };
        record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .original_project_bound = true;
        let bytes = encoded(
            &OwnerFrame::ProjectBound {
                id: original.id.clone(),
                runtime_digest: original.runtime_digest.clone(),
                registration,
            },
            STATUS_MAX,
        )
        .map_err(store::ServeError::AfterProjectBinding)?;
        write_all(stream, &bytes, expires).map_err(store::ServeError::AfterProjectBinding)?;
        let key =
            wire::project_service_key(canonical_root.to_str().ok_or("store project encoding")?)
                .map_err(err)
                .map_err(store::ServeError::AfterProjectBinding)?;
        let route = routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .route(&key, expires)
            .map_err(store::ServeError::AfterProjectBinding)?;
        let project_permit = route
            .capacity
            .acquire()
            .map_err(store::ServeError::AfterProjectBinding)?;
        let job = StoreJob {
            record: Arc::clone(&record),
            registry: Arc::clone(registry),
            transport: RelayTransport {
                stream: stream
                    .try_clone()
                    .map_err(err)
                    .map_err(store::ServeError::AfterProjectBinding)?,
                replies,
                cancelled: Arc::clone(&cancelled),
                sequence: 0,
                expires,
                deadline: Arc::clone(&deadline),
                limit: c.limits.max_frame_bytes as usize,
                native,
            },
            _connection: Arc::clone(permit),
            _project: project_permit,
        };
        record.lock().unwrap_or_else(|e| e.into_inner()).phase = "queued";
        match route.sender.try_send(Mailbox::Store(job)) {
            Ok(()) => {}
            Err(
                mpsc::TrySendError::Full(Mailbox::Store(job))
                | mpsc::TrySendError::Disconnected(Mailbox::Store(job)),
            ) => job.refuse("resident store project mailbox unavailable"),
            Err(_) => unreachable!("only store jobs sent here"),
        }
        // Mailbox owns the job and its connection/project admission now.
        Ok(())
    })();
    match admission {
        Ok(()) => {}
        Err(error) => {
            settle_quarantine(registry, &record, Err(error));
            let completion = record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .completion();
            let _ = encoded(&OwnerFrame::Complete { completion }, STATUS_MAX)
                .and_then(|bytes| write_all(stream, &bytes, expires));
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
    // A reader is bounded by the same original deadline and wakes on Job Drop.
    let _ = reader_join.join();
    true
}

#[cfg(test)]
mod tests;
