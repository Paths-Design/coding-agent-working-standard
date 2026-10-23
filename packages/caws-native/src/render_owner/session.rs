//! Ordinary non-store SessionEnd ownership. The engine request correlates with
//! independently captured frontend facts; it never selects output paths.
use super::relay::{Frame, Relay, Reply, Value};
use super::*;
use crate::{
    invocation_project as project, session_publication as publication,
    session_publication_wire as publication_wire,
};
use publication::Transport;
use serde_json::value::RawValue;
use std::sync::atomic::AtomicBool;
const ACQUIRE_SCHEMA: &str = "caws.render.owner.session-acquire.v1";
const REQUEST_SCHEMA: &str = "caws.runtime.session-seal.request.v1";
const COMPLETE_MAX: usize = 8192;

pub struct SessionInvocation<'a> {
    pub id: &'a str,
    pub runtime_digest: &'a str,
    pub original_payload: &'a RawValue,
    pub surface: &'a str,
    pub event: &'a str,
    pub configuration: &'a str,
    pub ready_active: bool,
    pub ready_project_digest: Option<&'a str>,
    pub ready_session_id: Option<&'a str>,
    pub dispatched: bool,
    pub caller_cwd: &'a str,
    pub caller_environment: &'a BTreeMap<String, String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAcquire {
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
    caller_cwd: String,
    caller_environment: BTreeMap<String, String>,
    request_base64: String,
    session_id: String,
    reason: String,
    captured_at: String,
    remaining_budget_ms: u64,
}
fn native_identity(
    payload: &RawValue,
    environment: &BTreeMap<String, String>,
    surface: &str,
) -> Result<String> {
    let valid = |s: &str| !s.is_empty() && s != "unknown";
    let payload_id = project::payload_string(payload, "session_id")?;
    let pin = match surface {
        "codex" => "CODEX_THREAD_ID",
        "claude-code" => "CLAUDE_SESSION_ID",
        _ => return Err("unsupported non-store session surface".into()),
    };
    let candidate = payload_id
        .as_deref()
        .filter(|s| valid(s))
        .or_else(|| {
            environment
                .get(pin)
                .map(String::as_str)
                .filter(|s| valid(s))
        })
        .or_else(|| {
            environment
                .get("CAWS_SESSION_ID")
                .map(String::as_str)
                .filter(|s| valid(s))
        })
        .or_else(|| {
            [
                "CLAUDE_SESSION_ID",
                "CLAUDE_CODE_SESSION_ID",
                "CODEX_THREAD_ID",
                "QWEN_CODE_SESSION_ID",
                "DSH_SESSION_ID",
                "CURSOR_TRACE_ID",
            ]
            .iter()
            .find_map(|key| {
                environment
                    .get(*key)
                    .map(String::as_str)
                    .filter(|s| valid(s))
            })
        })
        .ok_or("original native session identity unavailable")?;
    if !publication_wire::leaf(candidate) || candidate.len() > 128 {
        return Err("original session identity is not a safe ASCII leaf".into());
    }
    Ok(candidate.into())
}
fn native_reason(payload: &RawValue) -> Result<String> {
    let reason = project::payload_string(payload, "reason")?
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "other".into());
    if reason.len() > 4096 || reason.contains('\0') {
        return Err("original SessionEnd reason exceeds native profile".into());
    }
    Ok(reason)
}
fn native_utc() -> Result<String> {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_secs();
    let seconds = libc::time_t::try_from(seconds).map_err(err)?;
    let mut calendar: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut calendar) }.is_null() {
        return Err("native UTC timestamp unavailable".into());
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        calendar.tm_year + 1900,
        calendar.tm_mon + 1,
        calendar.tm_mday,
        calendar.tm_hour,
        calendar.tm_min,
        calendar.tm_sec
    ))
}
impl SessionAcquire {
    pub fn capture(bytes: &[u8], i: &SessionInvocation<'_>, expires: Instant) -> Result<Self> {
        let result = Self {
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
            caller_cwd: i.caller_cwd.into(),
            caller_environment: i.caller_environment.clone(),
            request_base64: STANDARD.encode(bytes),
            session_id: native_identity(i.original_payload, i.caller_environment, i.surface)?,
            reason: native_reason(i.original_payload)?,
            captured_at: native_utc()?,
            remaining_budget_ms: expires
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(120_000) as u64,
        };
        result.request()?;
        Ok(result)
    }
    fn request(&self) -> Result<SealRequest> {
        if self.schema != ACQUIRE_SCHEMA
            || self.id.is_empty()
            || self.id.len() > 256
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            || !publication_wire::digest(&self.runtime_digest)
            || self.event != "session_end"
            || self.configuration != "system"
            || !self.ready_active
            || !self.dispatched
            || !(1..=120_000).contains(&self.remaining_budget_ms)
            || self.request_base64.len() > 8192
            || native_identity(
                &self.original_payload,
                &self.caller_environment,
                &self.surface,
            )? != self.session_id
            || self.ready_session_id.as_deref() != Some(&self.session_id)
            || native_reason(&self.original_payload)? != self.reason
            || self.captured_at.len() != 20
            || !self.captured_at.ends_with('Z')
        {
            return Err("native SessionEnd original envelope mismatch".into());
        }
        let bytes = STANDARD.decode(&self.request_base64).map_err(err)?;
        if STANDARD.encode(&bytes) != self.request_base64 {
            return Err("invalid SessionEnd request encoding".into());
        }
        let request: SealRequest = serde_json::from_slice(&bytes).map_err(err)?;
        if request.schema != REQUEST_SCHEMA
            || request.id != self.id
            || request.runtime_digest != self.runtime_digest
            || request.token.is_empty()
            || request.token.len() > 128
            || !request
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            || !Path::new(&request.canonical_root).is_absolute()
            || request.canonical_root.contains('\0')
            || request.canonical_root.len() > 4096
            || Some(sha(request.canonical_root.as_bytes()).as_str())
                != self.ready_project_digest.as_deref()
        {
            return Err("SessionEnd request correlation mismatch".into());
        }
        Ok(request)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SealRequest {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    canonical_root: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCompletion {
    pub id: String,
    pub runtime_digest: String,
    pub registration: Option<String>,
    pub original_project_bound: bool,
    pub retained: bool,
    pub error: Option<String>,
}
impl SessionCompletion {
    fn unavailable(a: &SessionAcquire, reason: &str) -> Self {
        Self {
            id: a.id.clone(),
            runtime_digest: a.runtime_digest.clone(),
            registration: None,
            original_project_bound: false,
            retained: false,
            error: Some(reason.into()),
        }
    }
    pub fn status(&self) -> Result<()> {
        self.error.clone().map_or(Ok(()), Err)
    }
}

/// A transport failure is not an owner completion. In particular, an absent
/// registration receipt cannot establish that the original was not retained.
#[derive(Debug, Serialize)]
#[serde(tag = "observation", rename_all = "snake_case")]
pub enum SessionAcquisition {
    Complete(SessionCompletion),
    Unconfirmed {
        id: String,
        runtime_digest: String,
        registration: Option<String>,
        original_project_bound: bool,
        error: String,
    },
}
impl SessionAcquisition {
    pub fn status(&self) -> Result<()> {
        match self {
            Self::Complete(completion) => completion.status(),
            Self::Unconfirmed { error, .. } => Err(error.clone()),
        }
    }
}
struct Record {
    original: Arc<SessionAcquire>,
    completion: SessionCompletion,
    _operation: relay::OperationPermit,
    project_failure: Option<project::ProjectFailure>,
    writer: Option<Arc<journal::Custody>>,
    publication: Option<publication::Publication>,
}
pub(super) struct SessionRegistry {
    records: BTreeMap<String, Arc<Mutex<Record>>>,
    capacity: Arc<relay::OperationCapacity>,
}
impl SessionRegistry {
    pub(super) fn new(capacity: Arc<relay::OperationCapacity>) -> Self {
        Self {
            records: BTreeMap::new(),
            capacity,
        }
    }
    fn reserve(&mut self, original: SessionAcquire) -> Result<Arc<Mutex<Record>>> {
        if self.records.contains_key(&original.id) {
            return Err("session original already retained; no replay".into());
        }
        let permit = self.capacity.acquire()?;
        let mut completion =
            SessionCompletion::unavailable(&original, "SessionEnd is not consumed");
        completion.registration = Some(random()?);
        completion.retained = true;
        let id = original.id.clone();
        let record = Arc::new(Mutex::new(Record {
            original: Arc::new(original),
            completion,
            _operation: permit,
            project_failure: None,
            writer: None,
            publication: None,
        }));
        self.records.insert(id, Arc::clone(&record));
        Ok(record)
    }
}

/// The only frontend port for this profile. Each write acknowledgement follows
/// the actual frontend write; reads use the existing single engine reader.
pub fn acquire_session(
    c: &OwnerConfig,
    acquire: SessionAcquire,
    expires: Instant,
    is_cancelled: impl Fn() -> bool,
    transport: &mut impl Transport,
) -> SessionAcquisition {
    let mut completion =
        SessionCompletion::unavailable(&acquire, "session owner transport did not settle");
    let result = (|| -> Result<()> {
        acquire.request()?;
        let mut stream = connect(c, expires)?;
        write_all(
            &stream,
            &encoded(&acquire, c.limits.max_frame_bytes as usize)?,
            expires,
        )?;
        let mut pending = Vec::new();
        let mut sequence = 0u64;
        let mut publication_credit = publication_wire::CreditBudget::default();
        loop {
            let bytes = frame_while(
                &mut stream,
                &mut pending,
                (c.limits.max_frame_bytes as usize).max(publication_wire::MAX_RELAY_FRAME_BYTES),
                expires,
                || {
                    if is_cancelled() {
                        Err("SessionEnd frontend cancelled".into())
                    } else {
                        Ok(())
                    }
                },
            )?;
            match relay::decode_owner_frame(&bytes, c.limits.max_frame_bytes as usize)? {
                Frame::Registered {
                    id,
                    runtime_digest,
                    registration,
                } => {
                    if id != acquire.id
                        || runtime_digest != acquire.runtime_digest
                        || completion.registration.is_some()
                        || !publication_wire::digest(&registration)
                    {
                        return Err("session registration mismatch".into());
                    }
                    completion.registration = Some(registration);
                    // Registration confirms a strong owner record. A later
                    // frontend/engine transport failure cannot erase custody.
                    completion.retained = true;
                }
                Frame::ProjectBound {
                    id,
                    runtime_digest,
                    registration,
                } => {
                    if id != acquire.id
                        || runtime_digest != acquire.runtime_digest
                        || completion.registration.as_deref() != Some(&registration)
                    {
                        return Err("session project binding mismatch".into());
                    }
                    completion.original_project_bound = true;
                }
                Frame::Complete { completion: actual } => {
                    if actual.id != acquire.id
                        || actual.runtime_digest != acquire.runtime_digest
                        || (completion.registration.is_some()
                            && actual.registration != completion.registration)
                        || (completion.original_project_bound && !actual.original_project_bound)
                        || (actual.error.is_none()
                            && (actual.retained
                                || !actual.original_project_bound
                                || actual.registration.is_none()))
                    {
                        return Err("session completion mismatch".into());
                    }
                    completion = actual;
                    return Ok(());
                }
                command => {
                    let received = match &command {
                        Frame::ReadEngineFrame { sequence }
                        | Frame::WriteEngineFrame { sequence, .. }
                        | Frame::PublicationCredit { sequence, .. } => *sequence,
                        _ => unreachable!(),
                    };
                    if received != sequence + 1
                        || completion.registration.is_none()
                        || !completion.original_project_bound
                    {
                        return Err(
                            "session relay before original binding or wrong sequence".into()
                        );
                    }
                    let result = match command {
                        Frame::WriteEngineFrame { base64, .. } => STANDARD
                            .decode(&base64)
                            .map_err(err)
                            .and_then(|bytes| {
                                if bytes.len() > publication_wire::MAX_FRAME_BYTES
                                    || STANDARD.encode(&bytes) != base64
                                {
                                    Err("session frame bound or encoding".into())
                                } else {
                                    transport.write(&bytes, expires)
                                }
                            })
                            .map(|()| Value::Written),
                        Frame::PublicationCredit { bytes, .. } => publication_credit
                            .accept(bytes)
                            .and_then(|()| transport.credit(bytes))
                            .map(|()| Value::Credited),
                        Frame::ReadEngineFrame { .. } => {
                            transport.read(expires).and_then(|bytes| {
                                if bytes.len() > publication_wire::MAX_FRAME_BYTES {
                                    Err("session incoming frame bound".into())
                                } else {
                                    Ok(Value::Read {
                                        base64: STANDARD.encode(bytes),
                                    })
                                }
                            })
                        }
                        _ => unreachable!(),
                    };
                    sequence = received;
                    write_all(
                        &stream,
                        &encoded(
                            &Reply {
                                schema: relay::REPLY_SCHEMA.into(),
                                sequence,
                                result,
                            },
                            relay::REPLY_MAX,
                        )?,
                        expires,
                    )?;
                }
            }
        }
    })();
    match result {
        Ok(()) => SessionAcquisition::Complete(completion),
        Err(error) => SessionAcquisition::Unconfirmed {
            id: completion.id,
            runtime_digest: completion.runtime_digest,
            registration: completion.registration,
            original_project_bound: completion.original_project_bound,
            error,
        },
    }
}
pub(super) struct SessionJob {
    record: Arc<Mutex<Record>>,
    registry: Arc<Mutex<SessionRegistry>>,
    transport: Relay,
    _connection: Arc<ConnectionPermit>,
    _project: Arc<ProjectPermit>,
}
impl SessionJob {
    pub(super) fn invocation_id(&self) -> String {
        self.record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .original
            .id
            .clone()
    }
    pub(super) fn refuse(self, reason: &str) {
        self.record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .completion
            .error = Some(reason.into());
        self.complete();
    }
    fn complete(&self) {
        let completion = self
            .record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .completion
            .clone();
        let _ = encoded(&Frame::Complete { completion }, COMPLETE_MAX)
            .and_then(|bytes| write_all(&self.transport.stream, &bytes, self.transport.expires));
    }
}
impl Drop for SessionJob {
    fn drop(&mut self) {
        let _ = self.transport.stream.shutdown(std::net::Shutdown::Both);
    }
}
impl Actor {
    pub(super) fn acquire_session_job(&mut self, mut job: SessionJob) {
        let original = Arc::clone(
            &job.record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .original,
        );
        let expires = job.transport.expires;
        let mut dispatch = None;
        let mut rejected_execution = None;
        let result = (|| -> Result<()> {
            let request = original.request()?;
            self.check_unknown_fence(&original.id, expires)?;
            let verified = sha(&serde_json::to_vec(&*original).map_err(err)?);
            let id = publication::original_request_id(&original.id);
            let key = wire::project_service_key(&request.canonical_root).map_err(err)?;
            match self
                .journal
                .admit(
                    journal::Identity {
                        request_id: id.clone(),
                        argument_digest: verified.clone(),
                        project_service_key: key,
                        source_generation: original.runtime_digest.clone(),
                        execution_image_digest: original.runtime_digest.clone(),
                    },
                    verified.as_bytes(),
                    expires,
                )
                .map_err(err)?
            {
                journal::Admission::Accepted {
                    duplicate: false, ..
                } => {}
                journal::Admission::Accepted { .. } => {
                    return Err("session original already reserved; no replay".into());
                }
                journal::Admission::Rejected(outcome) => {
                    // Only the journal's typed non-execution receipt can refund
                    // this transient registration. An admission I/O error or an
                    // accepted duplicate still has uncertain prior effects.
                    rejected_execution = Some(outcome.execution);
                    return Err(outcome.reason);
                }
            }
            let reserved = self
                .journal
                .begin_next(&original.runtime_digest, &original.runtime_digest, expires)
                .map_err(err)?
                .ok_or("SessionEnd dispatch unavailable")?;
            if reserved.operation().identity().request_id != id {
                self.unknown = true;
                return Err("another queued original precedes SessionEnd".into());
            }
            dispatch = Some(reserved);
            self.stage("session_original_reserved", &original.id);
            let writer = self.publication_writer(Path::new(&request.canonical_root), expires)?;
            job.record.lock().unwrap_or_else(|e| e.into_inner()).writer = Some(Arc::clone(&writer));
            self.stage("session_writer_retained", &original.id);
            let mut publication = publication::Publication::capture(
                publication::OriginalBinding {
                    project: PathBuf::from(&request.canonical_root),
                    id: original.id.clone(),
                    runtime_digest: original.runtime_digest.clone(),
                    token: request.token,
                    session_id: original.session_id.clone(),
                    reason: original.reason.clone(),
                    ended_at: original.captured_at.clone(),
                },
                writer,
                dispatch.as_ref().expect("reserved"),
                vec![],
                expires,
            )?;
            let result = (|| -> Result<()> {
                publication.exchange_phase(
                    publication_wire::Kind::Seal,
                    &mut job.transport,
                    expires,
                )?;
                if !publication.aborted() {
                    publication.publish(expires)?;
                }
                let terminal = publication.terminal_digest()?;
                let returned = self
                    .journal
                    .returned(
                        dispatch.as_ref().expect("reserved"),
                        journal::ReturnedResult::SessionPublication {
                            terminal_digest: terminal.clone(),
                        },
                        Some(terminal),
                        expires,
                    )
                    .map_err(err)?;
                publication.write_result(&mut job.transport, expires)?;
                let consumed = publication::Transport::read(&mut job.transport, expires)?;
                let digest = publication.consume_receipt(&consumed, &mut job.transport, expires)?;
                self.journal
                    .consume(&returned, &digest, expires)
                    .map_err(err)?;
                self.stage("session_consumed_durable", &original.id);
                Ok(())
            })();
            job.record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .publication = Some(publication);
            result
        })();
        match result {
            Ok(()) => {
                {
                    let mut record = job.record.lock().unwrap_or_else(|e| e.into_inner());
                    record.completion.error = None;
                    record.completion.retained = false;
                    record.publication.take();
                    record.writer.take();
                }
                job.registry
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .records
                    .remove(&original.id);
                self.writer_custody.take();
                self.stage("session_heavy_released", &original.id);
            }
            Err(reason) if matches!(rejected_execution, Some(journal::KnownNotExecuted::Value)) => {
                {
                    let mut record = job.record.lock().unwrap_or_else(|e| e.into_inner());
                    record.completion.error = Some(reason);
                    record.completion.retained = false;
                }
                job.registry
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .records
                    .remove(&original.id);
                self.stage("session_rejected_before_effects", &original.id);
            }
            Err(reason) => {
                if let Some(dispatch) = &dispatch {
                    self.unknown = true;
                    let _ = self.journal.unknown(
                        dispatch,
                        Instant::now()
                            + Duration::from_millis(self.config.limits.request_ms as u64),
                    );
                }
                job.record
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .completion
                    .error = Some(reason);
                self.stage("session_retained", &original.id);
            }
        }
        job.complete();
    }
}

pub(super) fn receive_first(
    stream: &mut UnixStream,
    bytes: &[u8],
    surplus: &[u8],
    received: Instant,
    c: &Arc<OwnerConfig>,
    routing: &Arc<Mutex<Routing>>,
    permit: &Arc<ConnectionPermit>,
    registry: &Arc<Mutex<SessionRegistry>>,
) -> bool {
    #[derive(Deserialize)]
    struct Envelope {
        schema: String,
    }
    match serde_json::from_slice::<Envelope>(bytes) {
        Ok(e) if e.schema == ACQUIRE_SCHEMA => {}
        _ => return false,
    }
    let Ok(acquire) = serde_json::from_slice::<SessionAcquire>(bytes) else {
        return true;
    };
    let expires = (received + Duration::from_millis(acquire.remaining_budget_ms.min(120_000)))
        .min(received + Duration::from_millis(c.limits.request_ms as u64));
    let mut refused = SessionCompletion::unavailable(&acquire, "SessionEnd refused");
    let reservation = (|| -> Result<_> {
        if !surplus.is_empty() {
            return Err("unsolicited session request bytes".into());
        }
        let request = acquire.request()?;
        let record = registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reserve(acquire)?;
        Ok((record, request))
    })();
    let (record, request) = match reservation {
        Ok(v) => v,
        Err(reason) => {
            refused.error = Some(reason);
            let _ = encoded(
                &Frame::Complete {
                    completion: refused,
                },
                COMPLETE_MAX,
            )
            .and_then(|bytes| write_all(stream, &bytes, expires));
            return true;
        }
    };
    let original = Arc::clone(&record.lock().unwrap_or_else(|e| e.into_inner()).original);
    let registration = record
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .completion
        .registration
        .clone()
        .expect("registered");
    let cancelled = Arc::new(AtomicBool::new(false));
    let (sender, replies) = mpsc::sync_channel(1);
    let mut reader = match stream.try_clone() {
        Ok(reader) => reader,
        Err(reason) => {
            record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .completion
                .error = Some(err(reason));
            return true;
        }
    };
    let reader_cancelled = Arc::clone(&cancelled);
    let reply_generic_limit = c.limits.max_frame_bytes as usize;
    let reader_join = thread::spawn(move || {
        let mut pending = Vec::new();
        loop {
            let reply =
                frame(&mut reader, &mut pending, relay::REPLY_MAX, expires).and_then(|bytes| {
                    let reply: Reply = serde_json::from_slice(&bytes).map_err(err)?;
                    if bytes.len() > reply_generic_limit
                        && !matches!(&reply.result, Ok(Value::Read { .. }))
                    {
                        return Err("relay reply variant envelope bound".into());
                    }
                    Ok(reply)
                });
            match reply {
                Ok(reply) => {
                    if sender.try_send(reply).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        reader_cancelled.store(true, Ordering::Release);
    });
    let prepared = (|| -> Result<()> {
        write_all(
            stream,
            &encoded(
                &Frame::<SessionCompletion>::Registered {
                    id: original.id.clone(),
                    runtime_digest: original.runtime_digest.clone(),
                    registration: registration.clone(),
                },
                COMPLETE_MAX,
            )?,
            expires,
        )?;
        let observed = match project::observe(
            &original.caller_cwd,
            &original.caller_environment,
            &original.original_payload,
            expires,
            &|| cancelled.load(Ordering::Acquire),
        ) {
            Ok(p) => p,
            Err(failure) => {
                let reason = err(&failure);
                record
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .project_failure = Some(failure);
                return Err(reason);
            }
        };
        if observed.canonical_root.to_str() != Some(&request.canonical_root) {
            return Err("SessionEnd original project binding mismatch".into());
        }
        record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .completion
            .original_project_bound = true;
        write_all(
            stream,
            &encoded(
                &Frame::<SessionCompletion>::ProjectBound {
                    id: original.id.clone(),
                    runtime_digest: original.runtime_digest.clone(),
                    registration,
                },
                COMPLETE_MAX,
            )?,
            expires,
        )?;
        let key = wire::project_service_key(&request.canonical_root).map_err(err)?;
        let route = routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .route(&key, expires)?;
        let project_permit = route.capacity.acquire()?;
        let job = SessionJob {
            record: Arc::clone(&record),
            registry: Arc::clone(registry),
            transport: Relay {
                stream: stream.try_clone().map_err(err)?,
                replies,
                cancelled: Arc::clone(&cancelled),
                sequence: 0,
                expires,
                limit: c.limits.max_frame_bytes as usize,
            },
            _connection: Arc::clone(permit),
            _project: project_permit,
        };
        match route.sender.try_send(Mailbox::Session(job)) {
            Ok(()) => Ok(()),
            Err(
                mpsc::TrySendError::Full(Mailbox::Session(job))
                | mpsc::TrySendError::Disconnected(Mailbox::Session(job)),
            ) => {
                job.refuse("session project mailbox unavailable");
                Err("session mailbox refused".into())
            }
            Err(_) => unreachable!(),
        }
    })();
    let failed = prepared.is_err();
    match prepared {
        Ok(()) => {}
        Err(reason) => {
            let mut record = record.lock().unwrap_or_else(|e| e.into_inner());
            record.completion.error = Some(reason);
            let _ = encoded(
                &Frame::Complete {
                    completion: record.completion.clone(),
                },
                COMPLETE_MAX,
            )
            .and_then(|bytes| write_all(stream, &bytes, expires));
        }
    }
    if failed {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
    let _ = reader_join.join();
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.into()).unwrap()
    }
    #[test]
    fn original_identity_uses_payload_and_surface_pin_before_foreign_environment() {
        let environment = BTreeMap::from([
            ("CODEX_THREAD_ID".into(), "codex".into()),
            ("CLAUDE_SESSION_ID".into(), "claude".into()),
            ("CAWS_SESSION_ID".into(), "canonical".into()),
        ]);
        assert_eq!(
            native_identity(
                &payload("{\"session_id\":\"payload\"}"),
                &environment,
                "codex"
            )
            .unwrap(),
            "payload"
        );
        assert_eq!(
            native_identity(&payload("{}"), &environment, "codex").unwrap(),
            "codex"
        );
        assert_eq!(
            native_identity(&payload("{}"), &environment, "claude-code").unwrap(),
            "claude"
        );
        assert!(
            native_identity(&payload("{\"session_id\":false}"), &environment, "codex").is_err()
        );
        assert!(
            native_identity(
                &payload("{\"session_id\":\"../other\"}"),
                &environment,
                "codex"
            )
            .is_err()
        );
        assert!(native_identity(&payload("{}"), &BTreeMap::new(), "codex").is_err());
    }
    #[test]
    fn reason_defaults_without_replacing_authored_text_or_accepting_malformed_values() {
        for text in ["{}", "{\"reason\":null}", "{\"reason\":\"\"}"] {
            assert_eq!(native_reason(&payload(text)).unwrap(), "other");
        }
        assert_eq!(
            native_reason(&payload("{\"reason\":\"closed by user\\nexact\"}")).unwrap(),
            "closed by user\nexact"
        );
        assert!(native_reason(&payload("{\"reason\":17}")).is_err());
    }
    #[test]
    fn ready_session_and_engine_root_never_create_original_identity() {
        let raw = payload("{\"session_id\":\"original\"}");
        let environment = BTreeMap::new();
        let runtime = "a".repeat(64);
        let root = "/private/tmp/root";
        let project_digest = sha(root.as_bytes());
        let request=serde_json::to_vec(&serde_json::json!({"schema":REQUEST_SCHEMA,"id":"id","runtimeDigest":runtime,"token":"token","canonicalRoot":root})).unwrap();
        let mut invocation = SessionInvocation {
            id: "id",
            runtime_digest: &runtime,
            original_payload: &raw,
            surface: "codex",
            event: "session_end",
            configuration: "system",
            ready_active: true,
            ready_project_digest: Some(&project_digest),
            ready_session_id: Some("forged"),
            dispatched: true,
            caller_cwd: root,
            caller_environment: &environment,
        };
        let expires = Instant::now() + Duration::from_secs(10);
        assert!(
            SessionAcquire::capture(&request, &invocation, expires)
                .unwrap_err()
                .contains("original envelope mismatch")
        );
        invocation.ready_session_id = Some("original");
        let captured = SessionAcquire::capture(&request, &invocation, expires).unwrap();
        assert_eq!(captured.session_id, "original");
        assert_eq!(captured.reason, "other");
        assert!(captured.request().is_ok());
        let mut foreign: serde_json::Value = serde_json::from_slice(&request).unwrap();
        foreign["canonicalRoot"] = serde_json::json!("/private/tmp/foreign");
        assert!(
            SessionAcquire::capture(&serde_json::to_vec(&foreign).unwrap(), &invocation, expires)
                .unwrap_err()
                .contains("correlation mismatch")
        );
    }
}

#[cfg(test)]
#[path = "session/tests.rs"]
mod integration_tests;
