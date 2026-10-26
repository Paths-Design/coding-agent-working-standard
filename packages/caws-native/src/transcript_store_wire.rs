//! Native-owned fixed-query exchange on the existing pre-proposal transport.
//! This finite development profile does not select a stock handler or authorize
//! publication. Its database and session come from the original native request.

use crate::transcript_store::{
    self, AcquisitionLimits, CleanupCall, OwnedCancellation, SqlCell, Visit, VisitorFailure,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::CStr,
    path::{Component, Path},
    sync::Arc,
    time::Instant,
};

pub const CAPABILITY: &str = "caws.runtime.transcript-store.v1";
pub const REQUEST_SCHEMA: &str = "caws.runtime.transcript-store.request.v1";
pub const ROW_SCHEMA: &str = "caws.runtime.transcript-store.row.v1";
pub const CONTROL_SCHEMA: &str = "caws.runtime.transcript-store.control.v1";
pub const UTC_SCHEMA: &str = "caws.runtime.transcript-store.utc.v1";
pub const CLOSED_SCHEMA: &str = "caws.runtime.transcript-store.closed.v1";
pub const PROFILE: &str = "cpython-3.11.13-sqlite3.53.4-store-development.v1";
pub const MAX_REQUEST_BYTES: usize = 8192;
pub const MAX_CONTROL_BYTES: usize = 512;
pub const MAX_EXTRA_ENGINE_STDOUT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ROWS: u64 = 4096;
pub const MAX_CELL_BYTES: usize = 256 * 1024;
pub const MAX_TOTAL_CELL_BYTES: usize = 16 * 1024 * 1024;

/// Scope of the development exchange, not a dispatch or project grant.
pub fn supports_invocation(surface: &str, event: &str, configuration: &str) -> bool {
    matches!(surface, "opencode" | "zcode") && event == "stop" && configuration == "system"
}

#[derive(Debug, PartialEq, Eq)]
pub enum ServeFailurePhase {
    Exchange,
    ClosedEncoding,
    ClosedWrite,
    UnconfirmedClose,
}

/// An acquired source remains owned even when the engine transport is lost.
#[derive(Debug)]
pub enum ServeError {
    BeforeAcquisition(String),
    AfterProjectBinding(String),
    ProjectObservation(Box<crate::invocation_project::ProjectFailure>),
    AfterAcquisition {
        phase: ServeFailurePhase,
        message: String,
        outcome: Box<transcript_store::Acquisition<String>>,
    },
}

impl ServeError {
    /// Only native-established original project agreement permits reuse of the
    /// Ready project namespace for operational failure accounting.
    pub fn original_project_bound(&self) -> bool {
        matches!(
            self,
            Self::AfterProjectBinding(_) | Self::AfterAcquisition { .. }
        )
    }

    fn after_project_binding(self) -> Self {
        match self {
            Self::BeforeAcquisition(message) => Self::AfterProjectBinding(message),
            other => other,
        }
    }
    /// Query cleanup is independent of both engine and SQLite cleanup.
    pub fn retry_project_cleanup(&mut self) -> Result<(), String> {
        match self {
            Self::ProjectObservation(error) => error.retry_cleanup(),
            _ => Ok(()),
        }
    }
    pub(crate) fn settled(
        phase: ServeFailurePhase,
        message: String,
        outcome: transcript_store::Acquisition<String>,
    ) -> Self {
        Self::AfterAcquisition {
            phase,
            message,
            outcome: Box::new(outcome),
        }
    }
}

impl From<String> for ServeError {
    fn from(message: String) -> Self {
        Self::BeforeAcquisition(message)
    }
}
impl From<&str> for ServeError {
    fn from(message: &str) -> Self {
        Self::BeforeAcquisition(message.into())
    }
}
impl std::fmt::Display for ServeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeforeAcquisition(message) => formatter.write_str(message),
            Self::AfterProjectBinding(message) => formatter.write_str(message),
            Self::ProjectObservation(error) => {
                write!(formatter, "store project observation: {error}")
            }
            Self::AfterAcquisition {
                phase,
                message,
                outcome,
            } => write!(
                formatter,
                "store {phase:?}: {message}; acquisition: {:?}; SQL cleanup: {:?}; sourceClosed={}",
                outcome.first_failure,
                outcome.cleanup,
                source_closed(outcome)
            ),
        }
    }
}

fn source_closed(outcome: &transcript_store::Acquisition<String>) -> bool {
    matches!(outcome.cleanup.close, CleanupCall::Succeeded)
        && !outcome.cleanup.retained_uncertain
        && outcome.retained.is_none()
}

/// The frontend owns these observations; they are not engine frame fields.
pub struct Invocation<'a> {
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
    pub database: Option<&'a str>,
    pub caller_cwd: &'a str,
    pub caller_environment: &'a BTreeMap<String, String>,
}

/// One reader and one writer are supplied by the original invocation owner.
/// Credit applies only after a complete control frame has passed validation.
pub trait Transport {
    fn write(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String>;
    fn read(&mut self, deadline: Instant) -> Result<Vec<u8>, String>;
    fn credit(&mut self, bytes: usize) -> Result<(), String>;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    canonical_root: String,
    profile: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    ordinal: u64,
    action: String,
    #[serde(default, deserialize_with = "present_seconds")]
    seconds: Option<String>,
}
fn present_seconds<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn safe_sid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}
fn canonical_root(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute()
        && !value.contains('\0')
        && value.len() <= 4096
        && path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
        && path.as_os_str().to_str() == Some(value)
        && (value == "/" || !value.ends_with('/'))
        && !value.contains("//")
}
/// Pure correlation validation before a resident owner observes/routs the
/// original invocation. This function opens no database or project state.
pub(crate) fn correlation_root(
    bytes: &[u8],
    invocation: &Invocation<'_>,
) -> Result<String, ServeError> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("store request exceeds byte bound".into());
    }
    if !invocation.ready_active
        || !invocation.dispatched
        || !supports_invocation(
            invocation.surface,
            invocation.event,
            invocation.configuration,
        )
    {
        return Err("store operation outside active dispatched system OpenCode/ZCode Stop".into());
    }
    let request: Request =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid store request: {error}"))?;
    if request.schema != REQUEST_SCHEMA
        || request.id != invocation.id
        || request.runtime_digest != invocation.runtime_digest
        || request.profile != PROFILE
        || request.token.is_empty()
        || request.token.len() > 128
        || !request
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || !canonical_root(&request.canonical_root)
        || Some(format!("{:x}", Sha256::digest(request.canonical_root.as_bytes())).as_str())
            != invocation.ready_project_digest
    {
        return Err("store request binding mismatch".into());
    }
    let sid = crate::invocation_project::payload_string(invocation.original_payload, "session_id")?
        .ok_or("store requires original string session_id")?;
    if !safe_sid(&sid) || Some(sid.as_str()) != invocation.ready_session_id {
        return Err("store original session binding mismatch".into());
    }
    invocation
        .database
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or("captured store database unavailable")?;
    Ok(request.canonical_root)
}
fn encode(value: Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("store response exceeds frame bound".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}
fn cell(value: &SqlCell) -> Value {
    match value {
        SqlCell::Null => json!({"storageClass":"null"}),
        SqlCell::Integer(value) => json!({"storageClass":"integer","decimal":value.to_string()}),
        SqlCell::RealBits(bits) => {
            json!({"storageClass":"real","binary64Hex":format!("{bits:016x}")})
        }
        SqlCell::Text(bytes) => json!({"storageClass":"text","base64":STANDARD.encode(bytes)}),
        SqlCell::Blob(bytes) => json!({"storageClass":"blob","base64":STANDARD.encode(bytes)}),
    }
}
fn checked_seconds(value: &str) -> Result<i64, String> {
    let seconds = value
        .parse::<i64>()
        .map_err(|_| "invalid store UTC seconds")?;
    if seconds.to_string() != value {
        return Err("noncanonical store UTC seconds".into());
    }
    Ok(seconds)
}

/// Return raw native calendar fields. Python calendar interpretation is a
/// separate typed stage; there is no guessed year bound or JS Date conversion.
fn utc(seconds: i64) -> Result<Value, String> {
    #[cfg(all(unix, target_pointer_width = "64"))]
    {
        if std::mem::size_of::<libc::time_t>() != 8 || std::mem::size_of::<libc::c_int>() != 4 {
            return Err("unqualified native UTC representation".into());
        }
        let time = seconds as libc::time_t;
        let mut result = std::mem::MaybeUninit::<libc::tm>::uninit();
        // SAFETY: valid input pointer and writable storage for a complete tm.
        let returned = unsafe { libc::gmtime_r(&time, result.as_mut_ptr()) };
        if returned.is_null() {
            let code = std::io::Error::last_os_error()
                .raw_os_error()
                .filter(|code| *code != 0)
                .unwrap_or(libc::EINVAL);
            // Capture the actual locale-dependent native diagnostic. Unsupported
            // encoding is a port failure, never a manufactured reference error.
            let pointer = unsafe { libc::strerror(code) };
            if pointer.is_null() {
                return Err("native strerror unavailable".into());
            }
            let message = unsafe { CStr::from_ptr(pointer) }
                .to_str()
                .map_err(|_| "native strerror encoding")?;
            return Ok(
                json!({"kind":"os_error","seconds":seconds.to_string(),"errno":code,"message":message}),
            );
        }
        // SAFETY: gmtime_r returned success after initializing result.
        let result = unsafe { result.assume_init() };
        Ok(json!({"kind":"utc_calendar","seconds":seconds.to_string(),
            "tmYear":result.tm_year,"tmMon":result.tm_mon,"tmMday":result.tm_mday,
            "tmHour":result.tm_hour,"tmMin":result.tm_min,"tmSec":result.tm_sec}))
    }
    #[cfg(not(all(unix, target_pointer_width = "64")))]
    {
        let _ = seconds;
        Err("unqualified native UTC representation".into())
    }
}

/// Exactly one acquisition attempt is enforced by the outer pre-proposal loop.
/// Errors never grant compatibility replay or publication of a partial result.
/// Ok retains the complete acquisition after CLOSED was written and source
/// close was confirmed. It can contain Stopped or Failed; it is not an
/// exhausted-source assertion, engine-consumption receipt or publication grant.
pub fn serve<C: Fn() -> bool + Send + Sync + 'static>(
    bytes: &[u8],
    invocation: Invocation<'_>,
    deadline: Instant,
    is_cancelled: C,
    transport: &mut impl Transport,
) -> Result<transcript_store::Acquisition<String>, ServeError> {
    serve_inner(bytes, invocation, deadline, is_cancelled, transport, None)
}

/// The admitted capability has no public constructor or wire deserializer.
/// Only the authenticated owner creates it after the original native callback
/// has revalidated after queueing and immediately before SQL.
pub(crate) fn serve_admitted<C: Fn() -> bool + Send + Sync + 'static>(
    bytes: &[u8],
    invocation: Invocation<'_>,
    project: &crate::render_owner::NativeStoreProject,
    deadline: Instant,
    is_cancelled: C,
    transport: &mut impl Transport,
) -> Result<transcript_store::Acquisition<String>, ServeError> {
    project
        .validate(bytes, &invocation)
        .map_err(ServeError::AfterProjectBinding)?;
    serve_inner(
        bytes,
        invocation,
        deadline,
        is_cancelled,
        transport,
        Some(project),
    )
}
fn serve_inner<C: Fn() -> bool + Send + Sync + 'static>(
    bytes: &[u8],
    invocation: Invocation<'_>,
    deadline: Instant,
    is_cancelled: C,
    transport: &mut impl Transport,
    admitted: Option<&crate::render_owner::NativeStoreProject>,
) -> Result<transcript_store::Acquisition<String>, ServeError> {
    let is_cancelled: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(is_cancelled);
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("store request exceeds byte bound".into());
    }
    if !invocation.ready_active
        || !invocation.dispatched
        || !supports_invocation(
            invocation.surface,
            invocation.event,
            invocation.configuration,
        )
    {
        return Err("store operation outside active dispatched system OpenCode/ZCode Stop".into());
    }
    let request: Request =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid store request: {error}"))?;
    if request.schema != REQUEST_SCHEMA
        || request.id != invocation.id
        || request.runtime_digest != invocation.runtime_digest
        || request.profile != PROFILE
        || request.token.is_empty()
        || request.token.len() > 128
        || !request
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || !canonical_root(&request.canonical_root)
        || Some(format!("{:x}", Sha256::digest(request.canonical_root.as_bytes())).as_str())
            != invocation.ready_project_digest
    {
        return Err("store request binding mismatch".into());
    }
    let sid = crate::invocation_project::payload_string(invocation.original_payload, "session_id")?
        .ok_or("store requires original string session_id")?;
    if !safe_sid(&sid) || Some(sid.as_str()) != invocation.ready_session_id {
        return Err("store original session binding mismatch".into());
    }
    let database = invocation
        .database
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or("captured store database unavailable")?;
    if let Some(project) = admitted {
        project
            .validate(bytes, &invocation)
            .map_err(ServeError::AfterProjectBinding)?;
    } else {
        let project = crate::invocation_project::observe(
            invocation.caller_cwd,
            invocation.caller_environment,
            invocation.original_payload,
            deadline,
            &|| is_cancelled(),
        )
        .map_err(|error| ServeError::ProjectObservation(Box::new(error)))?;
        // The development path keeps its independent observation contract.
        if project.canonical_root.to_str() != Some(request.canonical_root.as_str()) {
            return Err("store original project binding mismatch".into());
        }
    }
    // Preserve the established identity even when DB resolution/open or later
    // transport fails. Earlier failures cannot lend Ready a budget namespace.
    let result = (|| {
        if is_cancelled() || Instant::now() >= deadline {
            return Err("store project observation cancelled or expired".into());
        }
        let path = if Path::new(database).is_absolute() {
            Path::new(database).to_path_buf()
        } else {
            Path::new(invocation.caller_cwd).join(database)
        };
        // Python resolves the supplied path before its read-only SQLite open. This
        // finite profile refuses missing/unresolvable files without guessing an URI.
        let path = path
            .canonicalize()
            .map_err(|error| format!("store path resolution: {error}"))?;
        let path = path.to_str().ok_or("store path is not UTF-8")?;
        if rusqlite::version() != "3.53.4" {
            return Err("unqualified native store SQLite version".into());
        }
        transport.credit(bytes.len() + 1)?;
        let common = |schema: &str| json!({"schema":schema,"id":request.id,"runtimeDigest":request.runtime_digest,"token":request.token});
        let mut exchange_error = None;
        if let Some(project) = admitted {
            project.check().map_err(ServeError::AfterProjectBinding)?;
        }
        let outcome = transcript_store::acquire_owned(
            path,
            &sid,
            AcquisitionLimits {
                max_rows: MAX_ROWS,
                max_cell_bytes: MAX_CELL_BYTES,
                max_total_bytes: MAX_TOTAL_CELL_BYTES,
            },
            OwnedCancellation {
                is_cancelled: Arc::clone(&is_cancelled),
                deadline,
            },
            |row| {
                let exchange = (|| -> Result<Visit, String> {
                    let mut frame = common(ROW_SCHEMA);
                    frame["ordinal"] = json!(row.ordinal);
                    frame["cells"] = Value::Array(row.cells.iter().map(cell).collect());
                    transport.write(&encode(frame)?, deadline)?;
                    let mut calendar_requested = false;
                    loop {
                        let bytes = transport.read(deadline)?;
                        if bytes.len() > MAX_CONTROL_BYTES {
                            return Err("store control exceeds byte bound".into());
                        }
                        let control: Control = serde_json::from_slice(&bytes)
                            .map_err(|error| format!("invalid store control: {error}"))?;
                        if control.schema != CONTROL_SCHEMA
                            || control.id != request.id
                            || control.runtime_digest != request.runtime_digest
                            || control.token != request.token
                            || control.ordinal != row.ordinal
                        {
                            return Err("store row control binding mismatch".into());
                        }
                        match control.action.as_str() {
                            "continue" | "stop" if control.seconds.is_none() => {
                                transport.credit(bytes.len() + 1)?;
                                return Ok(if control.action == "continue" {
                                    Visit::Continue
                                } else {
                                    Visit::Stop
                                });
                            }
                            "utc" if !calendar_requested => {
                                let seconds = checked_seconds(
                                    control
                                        .seconds
                                        .as_deref()
                                        .ok_or("store UTC seconds absent")?,
                                )?;
                                transport.credit(bytes.len() + 1)?;
                                calendar_requested = true;
                                if is_cancelled() || Instant::now() >= deadline {
                                    return Err("store UTC cancelled or expired".into());
                                }
                                let calendar = utc(seconds)?;
                                if is_cancelled() || Instant::now() >= deadline {
                                    return Err("store UTC cancelled or expired".into());
                                }
                                let mut frame = common(UTC_SCHEMA);
                                frame["ordinal"] = json!(row.ordinal);
                                frame["calendar"] = calendar;
                                transport.write(&encode(frame)?, deadline)?;
                            }
                            _ => return Err("invalid or repeated store row action".into()),
                        }
                    }
                })();
                exchange.map_err(|error| {
                    exchange_error = Some(error.clone());
                    VisitorFailure::Transport(error)
                })
            },
        );
        if let Some(error) = exchange_error {
            return Err(ServeError::settled(
                ServeFailurePhase::Exchange,
                error,
                outcome,
            ));
        }
        let closed = source_closed(&outcome);
        let mut frame = common(CLOSED_SCHEMA);
        frame["closed"] = json!(closed);
        frame["end"] = json!(match outcome.end {
            transcript_store::End::Exhausted => "exhausted",
            transcript_store::End::Stopped => "stopped",
            transcript_store::End::Failed => "failed",
        });
        // Internal typed diagnostic, deliberately not a CPython exception rendering.
        frame["failure"] = outcome
            .first_failure
            .as_ref()
            .map_or(Value::Null, |failure| json!(format!("{failure:?}")));
        frame["cleanup"] = json!({"progressUnregistered":outcome.cleanup.progress_unregistered,
        "busyUnregistered":format!("{:?}",outcome.cleanup.busy_unregistered),
        "finalized":format!("{:?}",outcome.cleanup.finalized),"rollback":format!("{:?}",outcome.cleanup.rollback)});
        frame["metrics"] = json!({"rowsCopied":outcome.metrics.rows_copied,"rowsDelivered":outcome.metrics.rows_delivered,"cellBytes":outcome.metrics.accounted_cell_bytes});
        let bytes = match encode(frame) {
            Ok(bytes) => bytes,
            Err(error) => {
                return Err(ServeError::settled(
                    ServeFailurePhase::ClosedEncoding,
                    error,
                    outcome,
                ));
            }
        };
        if let Err(error) = transport.write(&bytes, deadline) {
            return Err(ServeError::settled(
                ServeFailurePhase::ClosedWrite,
                error,
                outcome,
            ));
        }
        if !closed {
            return Err(ServeError::settled(
                ServeFailurePhase::UnconfirmedClose,
                "store connection cleanup remains uncertain".into(),
                outcome,
            ));
        }
        Ok(outcome)
    })();
    result.map_err(ServeError::after_project_binding)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{
            LazyLock,
            atomic::{AtomicU64, Ordering},
        },
        time::Duration,
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    static ENVIRONMENT: LazyLock<BTreeMap<String, String>> = LazyLock::new(|| {
        BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), "/nonexistent-caws-store-test-home".into()),
        ])
    });
    fn never_cancel() -> bool {
        false
    }
    struct MemoryTransport {
        received: VecDeque<Vec<u8>>,
        sent: Vec<Value>,
        credit: usize,
    }
    impl Transport for MemoryTransport {
        fn write(&mut self, bytes: &[u8], _: Instant) -> Result<(), String> {
            self.sent.push(serde_json::from_slice(bytes).unwrap());
            Ok(())
        }
        fn read(&mut self, _: Instant) -> Result<Vec<u8>, String> {
            self.received
                .pop_front()
                .ok_or("controlled transport EOF".into())
        }
        fn credit(&mut self, bytes: usize) -> Result<(), String> {
            self.credit += bytes;
            if self.credit > MAX_EXTRA_ENGINE_STDOUT_BYTES {
                return Err("over credit".into());
            }
            Ok(())
        }
    }
    fn transport(controls: Vec<Value>) -> MemoryTransport {
        MemoryTransport {
            received: controls
                .iter()
                .map(|value| serde_json::to_vec(value).unwrap())
                .collect(),
            sent: Vec::new(),
            credit: 0,
        }
    }
    fn request() -> Vec<u8> {
        serde_json::to_vec(
            &json!({"schema":REQUEST_SCHEMA,"id":"invocation","runtimeDigest":"a".repeat(64),
            "token":"token","canonicalRoot":"/private/tmp/store-root","profile":PROFILE}),
        )
        .unwrap()
    }
    fn invocation<'a>(
        payload: &'a RawValue,
        database: Option<&'a str>,
        digest: &'a str,
    ) -> Invocation<'a> {
        Invocation {
            id: "invocation",
            runtime_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            original_payload: payload,
            surface: "opencode",
            event: "stop",
            configuration: "system",
            ready_active: true,
            ready_project_digest: Some(digest),
            ready_session_id: Some("s"),
            dispatched: true,
            database,
            caller_cwd: "/",
            caller_environment: &ENVIRONMENT,
        }
    }
    fn control(action: &str) -> Value {
        json!({"schema":CONTROL_SCHEMA,"id":"invocation","runtimeDigest":"a".repeat(64),"token":"token","ordinal":1,"action":action})
    }
    struct Fixture {
        directory: std::path::PathBuf,
        database: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "caws-store-wire-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir(&directory).unwrap();
            let directory = directory.canonicalize().unwrap();
            let initialized = std::process::Command::new("/usr/bin/git")
                .args(["init", "--quiet"])
                .arg(&directory)
                .env_clear()
                .envs(ENVIRONMENT.iter())
                .output()
                .unwrap();
            assert!(initialized.status.success(), "{initialized:?}");
            let database = directory.join("source.sqlite");
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection.execute_batch("CREATE TABLE message(id,session_id,time_created,data);CREATE TABLE part(id,message_id,time_created,data);INSERT INTO message VALUES('m','s',0,'{}');INSERT INTO part VALUES('p','m',0,'{}');").unwrap();
            connection.close().unwrap();
            Self {
                directory,
                database,
            }
        }
        fn path(&self) -> &str {
            self.database.to_str().unwrap()
        }
        fn root(&self) -> &str {
            self.directory.to_str().unwrap()
        }
        fn digest(&self) -> String {
            format!("{:x}", Sha256::digest(self.root().as_bytes()))
        }
        fn request(&self) -> Vec<u8> {
            let mut value: Value = serde_json::from_slice(&request()).unwrap();
            value["canonicalRoot"] = json!(self.root());
            serde_json::to_vec(&value).unwrap()
        }
        fn invocation<'a>(&'a self, payload: &'a RawValue, digest: &'a str) -> Invocation<'a> {
            let mut context = invocation(payload, Some(self.path()), digest);
            context.caller_cwd = self.root();
            context
        }
        fn can_lock(&self) {
            let connection = rusqlite::Connection::open(&self.database).unwrap();
            connection
                .execute_batch("BEGIN EXCLUSIVE;ROLLBACK")
                .unwrap();
            connection.close().unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.directory).unwrap();
        }
    }
    fn run(
        bytes: &[u8],
        invocation: Invocation<'_>,
        transport: &mut MemoryTransport,
    ) -> Result<transcript_store::Acquisition<String>, ServeError> {
        serve(
            bytes,
            invocation,
            Instant::now() + Duration::from_secs(3),
            never_cancel,
            transport,
        )
    }
    #[test]
    fn transcript_store_binding_refusals_precede_source_and_transport() {
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = format!("{:x}", Sha256::digest(b"/private/tmp/store-root"));
        for variant in 0..12 {
            let mut context = invocation(&payload, Some("/does/not/exist"), &digest);
            let mut bytes: Value = serde_json::from_slice(&request()).unwrap();
            match variant {
                0 => context.ready_active = false,
                1 => context.dispatched = false,
                2 => context.surface = "codex",
                3 => context.event = "pre_tool_use",
                4 => context.configuration = "project",
                5 => context.ready_session_id = Some("other"),
                6 => context.database = None,
                7 => bytes["id"] = json!("foreign"),
                8 => bytes["profile"] = json!("unknown"),
                9 => bytes["canonicalRoot"] = json!("/private/tmp/../store-root"),
                10 => bytes["database"] = json!("/injected"),
                _ => bytes["token"] = json!("bad token"),
            }
            let mut transport = transport(vec![]);
            let error = run(
                &serde_json::to_vec(&bytes).unwrap(),
                context,
                &mut transport,
            )
            .unwrap_err();
            assert!(
                matches!(&error, ServeError::BeforeAcquisition(message) if !message.contains("path resolution")),
                "binding must fail before attempting source open: {error}"
            );
            assert!(transport.sent.is_empty());
            assert_eq!(transport.credit, 0);
        }
    }
    #[test]
    fn transcript_store_actual_row_calendar_and_closed_ack_keep_source_bytes() {
        let fixture = Fixture::new();
        let before = std::fs::read(&fixture.database).unwrap();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        let mut utc_control = control("utc");
        utc_control["seconds"] = json!("0");
        let mut transport = transport(vec![utc_control, control("continue")]);
        let outcome = run(
            &fixture.request(),
            fixture.invocation(&payload, &digest),
            &mut transport,
        )
        .unwrap();
        assert_eq!(outcome.end, transcript_store::End::Exhausted);
        assert!(outcome.first_failure.is_none());
        assert_eq!(outcome.metrics.rows_copied, 1);
        assert_eq!(outcome.metrics.rows_delivered, 1);
        assert!(matches!(outcome.cleanup.close, CleanupCall::Succeeded));
        assert!(!outcome.cleanup.retained_uncertain);
        assert!(outcome.retained.is_none());
        assert_eq!(transport.sent.len(), 3);
        assert_eq!(transport.sent[0]["schema"], ROW_SCHEMA);
        assert_eq!(
            transport.sent[0]["cells"][0],
            json!({"storageClass":"text","base64":"bQ=="})
        );
        assert_eq!(transport.sent[1]["schema"], UTC_SCHEMA);
        assert_eq!(transport.sent[1]["calendar"]["tmYear"], 70);
        assert_eq!(transport.sent[1]["calendar"]["tmMon"], 0);
        assert_eq!(transport.sent[1]["calendar"]["seconds"], "0");
        assert_eq!(transport.sent[2]["schema"], CLOSED_SCHEMA);
        assert_eq!(transport.sent[2]["end"], "exhausted");
        assert_eq!(transport.sent[2]["closed"], true);
        assert_eq!(transport.sent[2]["failure"], Value::Null);
        assert_eq!(transport.sent[2]["metrics"]["rowsDelivered"], 1);
        fixture.can_lock();
        assert_eq!(std::fs::read(&fixture.database).unwrap(), before);
        println!(
            "store row/UTC/closed frames={:?}; database SHA256 before/after={:x}; exclusive lock reacquired",
            transport.sent,
            Sha256::digest(&before)
        );
    }
    #[test]
    fn transcript_store_completed_exchange_retains_stopped_acquisition() {
        let fixture = Fixture::new();
        let before = std::fs::read(&fixture.database).unwrap();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        let mut transport = transport(vec![control("stop")]);
        let outcome = run(
            &fixture.request(),
            fixture.invocation(&payload, &digest),
            &mut transport,
        )
        .unwrap();
        assert_eq!(outcome.end, transcript_store::End::Stopped);
        assert!(outcome.first_failure.is_none());
        assert_eq!(outcome.metrics.rows_copied, 1);
        assert_eq!(outcome.metrics.rows_delivered, 1);
        assert!(source_closed(&outcome));
        assert!(matches!(outcome.cleanup.close, CleanupCall::Succeeded));
        assert!(outcome.retained.is_none());
        assert_eq!(transport.sent.len(), 2);
        assert_eq!(transport.sent[1]["schema"], CLOSED_SCHEMA);
        assert_eq!(transport.sent[1]["end"], "stopped");
        assert_eq!(transport.sent[1]["closed"], true);
        assert_eq!(transport.sent[1]["failure"], Value::Null);
        fixture.can_lock();
        assert_eq!(std::fs::read(&fixture.database).unwrap(), before);
    }
    #[test]
    fn transcript_store_completed_exchange_retains_failed_but_closed_acquisition() {
        let fixture = Fixture::new();
        let connection = rusqlite::Connection::open(&fixture.database).unwrap();
        connection
            .execute_batch("UPDATE part SET data=CAST(X'80' AS TEXT)")
            .unwrap();
        connection.close().unwrap();
        let before = std::fs::read(&fixture.database).unwrap();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        let mut transport = transport(vec![]);
        let outcome = run(
            &fixture.request(),
            fixture.invocation(&payload, &digest),
            &mut transport,
        )
        .unwrap();
        assert_eq!(outcome.end, transcript_store::End::Failed);
        assert!(
            matches!(&outcome.first_failure, Some(transcript_store::Failure::Text(failure))
            if failure.raw == [0x80] && failure.valid_up_to == 0 && failure.error_len == Some(1))
        );
        assert_eq!(outcome.metrics.rows_delivered, 0);
        assert!(source_closed(&outcome));
        assert!(matches!(outcome.cleanup.close, CleanupCall::Succeeded));
        assert!(outcome.retained.is_none());
        assert_eq!(transport.sent.len(), 1);
        assert_eq!(transport.sent[0]["schema"], CLOSED_SCHEMA);
        assert_eq!(transport.sent[0]["end"], "failed");
        assert_eq!(transport.sent[0]["closed"], true);
        assert!(!transport.sent[0]["failure"].is_null());
        fixture.can_lock();
        assert_eq!(std::fs::read(&fixture.database).unwrap(), before);
    }
    #[test]
    fn transcript_store_agreeing_foreign_engine_root_refuses_before_database_resolution() {
        let original = Fixture::new();
        let foreign = Fixture::new();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let foreign_digest = foreign.digest();
        let mut context = original.invocation(&payload, &foreign_digest);
        context.database = Some("/does/not/exist-caws-root-binding-control");
        let mut transport = transport(vec![]);
        let error = run(&foreign.request(), context, &mut transport).unwrap_err();
        assert!(!error.original_project_bound());
        assert!(
            matches!(&error, ServeError::BeforeAcquisition(message)
            if message == "store original project binding mismatch"),
            "{error}"
        );
        assert_eq!(transport.credit, 0);
        assert!(transport.sent.is_empty());
        original.can_lock();
        foreign.can_lock();
        println!(
            "matching foreign Ready/root refusal={error}; original={}; foreign={}; credit={}; frames={:?}",
            original.root(),
            foreign.root(),
            transport.credit,
            transport.sent
        );
    }
    #[test]
    fn transcript_store_path_failure_preserves_established_original_project_binding() {
        let fixture = Fixture::new();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        let mut context = fixture.invocation(&payload, &digest);
        context.database = Some("/does/not/exist-caws-bound-path-control");
        let mut transport = transport(vec![]);
        let error = run(&fixture.request(), context, &mut transport).unwrap_err();
        assert!(error.original_project_bound());
        assert!(
            matches!(&error, ServeError::AfterProjectBinding(message) if message.starts_with("store path resolution:")),
            "{error}"
        );
        assert_eq!(transport.credit, 0);
        assert!(transport.sent.is_empty());
        println!(
            "bound pre-acquisition path failure retains only established project context: {error}"
        );
    }
    #[test]
    fn transcript_store_original_environment_ignores_foreign_git_routing() {
        let original = Fixture::new();
        let foreign = Fixture::new();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let mut environment = ENVIRONMENT.clone();
        environment.insert(
            "GIT_DIR".into(),
            foreign.directory.join(".git").to_str().unwrap().into(),
        );
        environment.insert("GIT_WORK_TREE".into(), foreign.root().into());
        environment.insert("HOOK_PROJECT_DIR".into(), foreign.root().into());
        for wrong_root in [false, true] {
            let digest = if wrong_root {
                foreign.digest()
            } else {
                original.digest()
            };
            let mut context = original.invocation(&payload, &digest);
            context.caller_environment = &environment;
            let mut transport = transport(vec![control("continue")]);
            let bytes = if wrong_root {
                foreign.request()
            } else {
                original.request()
            };
            let result = run(&bytes, context, &mut transport);
            if wrong_root {
                assert!(
                    matches!(result, Err(ServeError::BeforeAcquisition(ref message))
                    if message == "store original project binding mismatch")
                );
                assert_eq!(transport.credit, 0);
                assert!(transport.sent.is_empty());
            } else {
                result.unwrap();
                assert_eq!(transport.sent.last().unwrap()["closed"], true);
            }
        }
    }
    #[test]
    fn transcript_store_opaque_extension_and_duplicate_owned_keys_preserve_last_value() {
        let fixture = Fixture::new();
        let payload = RawValue::from_string(
            r#"{"session_id":false,"cwd":false,"unused":1e9999,"\ud800":{"value":"\udfff"},"session\u005fid":"s","cwd":""}"#.into()
        ).unwrap();
        let digest = fixture.digest();
        let mut transport = transport(vec![control("continue")]);
        run(
            &fixture.request(),
            fixture.invocation(&payload, &digest),
            &mut transport,
        )
        .unwrap();
        assert_eq!(transport.sent.last().unwrap()["end"], "exhausted");
    }
    #[test]
    fn transcript_store_linked_worktree_observes_common_directory_parent() {
        let fixture = Fixture::new();
        let git = |args: &[&str]| {
            let result = std::process::Command::new("/usr/bin/git")
                .current_dir(&fixture.directory)
                .env_clear()
                .envs(ENVIRONMENT.iter())
                .args(args)
                .output()
                .unwrap();
            assert!(result.status.success(), "{result:?}");
        };
        git(&[
            "-c",
            "user.name=CAWS",
            "-c",
            "user.email=caws@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "fixture",
        ]);
        let linked = fixture.directory.join("linked");
        git(&[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            linked.to_str().unwrap(),
        ]);
        let nested = linked.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        let mut context = fixture.invocation(&payload, &digest);
        context.caller_cwd = nested.to_str().unwrap();
        let mut transport = transport(vec![control("continue")]);
        run(&fixture.request(), context, &mut transport).unwrap();
        assert_eq!(transport.sent.last().unwrap()["closed"], true);
        fixture.can_lock();
    }
    #[test]
    fn transcript_store_cancelled_project_observation_never_credits_or_opens_source() {
        let fixture = Fixture::new();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        let mut context = fixture.invocation(&payload, &digest);
        context.database = Some("/does/not/exist-caws-cancellation-control");
        let mut transport = transport(vec![]);
        let error = serve(
            &fixture.request(),
            context,
            Instant::now() + Duration::from_secs(3),
            || true,
            &mut transport,
        )
        .unwrap_err();
        assert!(
            matches!(error, ServeError::ProjectObservation(_)),
            "{error}"
        );
        assert_eq!(transport.credit, 0);
        assert!(transport.sent.is_empty());
        fixture.can_lock();
    }
    #[test]
    fn transcript_store_control_failures_end_query_without_continuation() {
        let fixture = Fixture::new();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        for variant in 0..7 {
            let mut first = control("continue");
            let controls = match variant {
                0 => vec![],
                1 => {
                    first["ordinal"] = json!(2);
                    vec![first]
                }
                2 => {
                    first["token"] = json!("foreign");
                    vec![first]
                }
                3 => {
                    first["action"] = json!("publish");
                    vec![first]
                }
                4 => {
                    first["seconds"] = json!("0");
                    vec![first]
                }
                5 => {
                    first["action"] = json!("utc");
                    first["seconds"] = json!("00");
                    vec![first]
                }
                _ => {
                    first["action"] = json!("utc");
                    first["seconds"] = json!("0");
                    vec![first.clone(), first]
                }
            };
            let mut transport = transport(controls);
            let error = run(
                &fixture.request(),
                fixture.invocation(&payload, &digest),
                &mut transport,
            )
            .unwrap_err();
            assert!(error.original_project_bound());
            let ServeError::AfterAcquisition { phase, outcome, .. } = error else {
                panic!("control failure lost acquisition");
            };
            assert_eq!(phase, ServeFailurePhase::Exchange);
            assert!(
                matches!(&outcome.first_failure, Some(transcript_store::Failure::Transport(message)) if !message.is_empty())
            );
            assert!(source_closed(&outcome));
            assert!(matches!(outcome.cleanup.rollback, CleanupCall::Succeeded));
            assert_eq!(transport.sent[0]["schema"], ROW_SCHEMA);
            assert!(
                !transport
                    .sent
                    .iter()
                    .any(|frame| frame["schema"] == CLOSED_SCHEMA)
            );
            fixture.can_lock();
        }
    }
    #[test]
    fn transcript_store_closed_delivery_failure_retains_successful_sql_close() {
        struct FailClosed(MemoryTransport);
        impl Transport for FailClosed {
            fn write(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String> {
                let frame: Value = serde_json::from_slice(bytes).unwrap();
                if frame["schema"] == CLOSED_SCHEMA {
                    return Err("closed-delivery-sentinel".into());
                }
                self.0.write(bytes, deadline)
            }
            fn read(&mut self, deadline: Instant) -> Result<Vec<u8>, String> {
                self.0.read(deadline)
            }
            fn credit(&mut self, bytes: usize) -> Result<(), String> {
                self.0.credit(bytes)
            }
        }
        let fixture = Fixture::new();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let digest = fixture.digest();
        let mut transport = FailClosed(transport(vec![control("continue")]));
        let error = serve(
            &fixture.request(),
            fixture.invocation(&payload, &digest),
            Instant::now() + Duration::from_secs(3),
            never_cancel,
            &mut transport,
        )
        .unwrap_err();
        let ServeError::AfterAcquisition {
            phase,
            message,
            outcome,
        } = error
        else {
            panic!("lost settlement");
        };
        assert_eq!(phase, ServeFailurePhase::ClosedWrite);
        assert_eq!(message, "closed-delivery-sentinel");
        assert_eq!(outcome.end, transcript_store::End::Exhausted);
        assert!(outcome.first_failure.is_none());
        assert!(source_closed(&outcome));
        assert_eq!(outcome.metrics.rows_delivered, 1);
        assert_eq!(transport.0.sent.len(), 1);
        assert_eq!(transport.0.sent[0]["schema"], ROW_SCHEMA);
        fixture.can_lock();
    }

    #[test]
    fn transcript_store_native_calendar_keeps_out_of_datetime_year_and_real_os_error() {
        let year10000 = utc(253402300800).unwrap();
        assert_eq!(year10000["kind"], "utc_calendar");
        assert_eq!(year10000["tmYear"], 8100);
        let beyond_tm = utc(i64::MAX).unwrap();
        assert_eq!(beyond_tm["kind"], "os_error");
        assert!(beyond_tm["errno"].as_i64().is_some_and(|value| value != 0));
        assert!(
            beyond_tm["message"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        for bad in ["-0", "00", "+1", " 1", "9223372036854775808"] {
            assert!(checked_seconds(bad).is_err());
        }
    }
}
