//! Resident acquisition, distinct from RenderOffer v1 and its LF+EOF bridge.
//! Records are finite, unreleased, and never replayed or evicted. Registry weak
//! references make status depend on the actual surviving actor/quarantine owner.
use super::*;
use crate::{transcript_store as sql, transcript_store_wire as store};
use serde_json::value::RawValue;
use std::sync::{Weak, atomic::AtomicBool};

const ACQUIRE_SCHEMA: &str = "caws.render.owner.store-acquire.v1";
const STATUS_SCHEMA: &str = "caws.render.owner.store-status.v1";
const REPLY_SCHEMA: &str = "caws.render.owner.store-relay-reply.v1";
const STATUS_MAX: usize = 8192;
const REPLY_MAX: usize = 4096;

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
    remaining_budget_ms: u64,
}
impl StoreAcquire {
    pub fn capture(bytes: &[u8], i: store::Invocation<'_>, expires: Instant) -> Self {
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
            remaining_budget_ms: expires
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(120_000) as u64,
        }
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
        if self.schema != ACQUIRE_SCHEMA
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
            || !(1..=120_000).contains(&self.remaining_budget_ms)
            || self.database.as_ref() != self.caller_environment.get("CAWS_TRANSCRIPT_DATABASE")
            || self.request_base64.len() > store::MAX_REQUEST_BYTES.div_ceil(3) * 4
        {
            return Err("resident store original invocation envelope mismatch".into());
        }
        STANDARD.decode(&self.request_base64).map_err(err)
    }
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
            retained: true,
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
            error: match &self.result {
                Some(Err(e)) => Some(error_kind(e)),
                _ => None,
            },
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
}
impl StoreRegistry {
    pub(super) fn new(maximum: usize) -> Self {
        Self {
            maximum,
            records: BTreeMap::new(),
            quarantine: Vec::new(),
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
        let key = original.id.clone();
        let runtime = original.runtime_digest.clone();
        let record = Arc::new(Mutex::new(StoreRecord {
            original: Arc::new(original),
            registration: registration.clone(),
            phase: "registered",
            original_project_bound: false,
            result: None,
        }));
        self.records
            .insert(key, (runtime, registration, Arc::downgrade(&record)));
        Ok(record)
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

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum OwnerFrame {
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
    Complete {
        completion: StoreCompletion,
    },
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
    Written,
    Read { base64: String },
    Credited,
}

/// Returns finite status even when relay loss prevents delivery of settlement.
/// A success acknowledgement is produced only after the actual frontend call.
pub fn acquire_store(
    c: &OwnerConfig,
    acquire: StoreAcquire,
    expires: Instant,
    is_cancelled: impl Fn() -> bool,
    transport: &mut impl store::Transport,
) -> StoreCompletion {
    let mut completion = StoreCompletion::unavailable(
        &acquire.id,
        &acquire.runtime_digest,
        "resident store transport did not settle".into(),
    );
    let exchange = (|| -> Result<()> {
        let mut stream = connect(c, expires)?;
        write_all(
            &stream,
            &encoded(&acquire, c.limits.max_frame_bytes as usize)?,
            expires,
        )?;
        let mut pending = Vec::new();
        let mut sequence = 0u64;
        loop {
            let bytes = frame_while(
                &mut stream,
                &mut pending,
                c.limits.max_frame_bytes as usize,
                expires,
                || {
                    if is_cancelled() {
                        Err("resident store frontend cancelled".into())
                    } else {
                        Ok(())
                    }
                },
            )?;
            match serde_json::from_slice::<OwnerFrame>(&bytes).map_err(err)? {
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
                                || !result.retained
                                || result.acquisition.is_none()))
                    {
                        return Err("resident store completion correlation mismatch".into());
                    }
                    completion = result;
                    return Ok(());
                }
                command => {
                    let received = match &command {
                        OwnerFrame::WriteEngineFrame { sequence, .. }
                        | OwnerFrame::ReadEngineFrame { sequence }
                        | OwnerFrame::Credit { sequence, .. } => *sequence,
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
                                .and_then(|bytes| transport.write(&bytes, expires))
                                .map(|()| ReplyValue::Written),
                        ),
                        OwnerFrame::ReadEngineFrame { sequence } => (
                            sequence,
                            transport.read(expires).and_then(|bytes| {
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
                            transport.credit(bytes).map(|()| ReplyValue::Credited),
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
    limit: usize,
}
impl RelayTransport {
    fn exchange(&mut self, command: OwnerFrame, expected: &'static str) -> Result<ReplyValue> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("resident store frontend disconnected".into());
        }
        write_all(&self.stream, &encoded(&command, self.limit)?, self.expires)?;
        loop {
            match self.replies.recv_timeout(TICK) {
                Ok(reply) => {
                    if reply.schema != REPLY_SCHEMA || reply.sequence != self.sequence {
                        return Err("resident store relay acknowledgement mismatch".into());
                    }
                    let value = reply.result?;
                    if !matches!(
                        (&value, expected),
                        (ReplyValue::Written, "write")
                            | (ReplyValue::Read { .. }, "read")
                            | (ReplyValue::Credited, "credit")
                    ) {
                        return Err(
                            "resident store relay acknowledgement operation mismatch".into()
                        );
                    }
                    return Ok(value);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    check(self.expires)?;
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
                STANDARD.decode(base64).map_err(err)
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
        self.stage("store_acquisition_start", &original.id);
        let result = match self.check_unknown_fence(&original.id, job.transport.expires) {
            Err(reason) => Err(store::ServeError::AfterProjectBinding(reason)),
            Ok(()) => match original.request() {
                Err(reason) => Err(store::ServeError::AfterProjectBinding(reason)),
                Ok(bytes) => {
                    let cancelled = Arc::clone(&job.transport.cancelled);
                    store::serve(
                        &bytes,
                        original.invocation(),
                        job.transport.expires,
                        move || cancelled.load(Ordering::Acquire),
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
    struct Envelope {
        schema: String,
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
    if envelope.schema != ACQUIRE_SCHEMA {
        return false;
    }
    let parsed = serde_json::from_slice::<StoreAcquire>(bytes).map_err(err);
    let Ok(acquire) = parsed else { return true };
    let expires = (received + Duration::from_millis(acquire.remaining_budget_ms.min(120_000)))
        .min(received + Duration::from_millis(c.limits.request_ms as u64));
    let mut refused = StoreCompletion::unavailable(
        &acquire.id,
        &acquire.runtime_digest,
        "resident store refused".into(),
    );
    let prepared = (|| -> Result<(Arc<Mutex<StoreRecord>>, Vec<u8>, String)> {
        if !surplus.is_empty() {
            return Err("resident store unsolicited first-message bytes".into());
        }
        let request = acquire.request()?;
        let root = store::correlation_root(&request, &acquire.invocation()).map_err(err)?;
        let record = registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reserve(acquire)?;
        Ok((record, request, root))
    })();
    let (record, _request, expected_root) = match prepared {
        Ok(value) => value,
        Err(error) => {
            refused.error = Some(error);
            let _ = encoded(
                &OwnerFrame::Complete {
                    completion: refused,
                },
                STATUS_MAX,
            )
            .and_then(|bytes| write_all(stream, &bytes, expires));
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
    let reader_join = thread::spawn(move || {
        let mut pending = Vec::new();
        loop {
            let result = frame(&mut reader, &mut pending, REPLY_MAX, expires)
                .and_then(|bytes| serde_json::from_slice::<RelayReply>(&bytes).map_err(err));
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
        let project = crate::invocation_project::observe(
            &original.caller_cwd,
            &original.caller_environment,
            &original.original_payload,
            expires,
            &|| cancelled.load(Ordering::Acquire),
        )
        .map_err(|error| store::ServeError::ProjectObservation(Box::new(error)))?;
        if project.canonical_root.to_str() != Some(&expected_root) {
            return Err(store::ServeError::BeforeAcquisition(
                "store original project binding mismatch".into(),
            ));
        }
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
        let key = wire::project_service_key(
            project
                .canonical_root
                .to_str()
                .ok_or("store project encoding")?,
        )
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
                limit: c.limits.max_frame_bytes as usize,
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
