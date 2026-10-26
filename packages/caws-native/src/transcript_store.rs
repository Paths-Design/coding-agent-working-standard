use libsqlite3_sys as ffi;
use rusqlite::{Connection, OpenFlags, Row, Statement, types::ValueRef};
use std::cell::Cell;
use std::ffi::{c_int, c_void};
use std::fmt;
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

// Process-local diagnostic evidence only; never admission or authority.
// Includes unsuccessful opens and excludes profile identity's in-memory database.
static TRANSCRIPT_DATABASE_OPEN_ATTEMPTS: AtomicU64 = AtomicU64::new(0);

fn record_database_open_attempt(counter: &AtomicU64) {
    let _ = counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        Some(value.saturating_add(1))
    });
}

/// Saturation means the count cannot establish an unchanged-open observation.
pub(crate) fn transcript_database_open_attempts() -> u64 {
    TRANSCRIPT_DATABASE_OPEN_ATTEMPTS.load(Ordering::SeqCst)
}

const QUERY: &str = "\
SELECT m.id AS message_id, m.data AS message_data, \
p.id AS part_id, p.data AS part_data, p.time_created AS part_time \
FROM message m JOIN part p ON p.message_id=m.id \
WHERE m.session_id=? ORDER BY m.time_created,m.id,p.id";

const COLUMN_NAMES: [&str; 5] = [
    "message_id",
    "message_data",
    "part_id",
    "part_data",
    "part_time",
];
const PROGRESS_INSTRUCTIONS: c_int = 1000;
const BUSY_CEILING: Duration = Duration::from_secs(1);
const BUSY_POLL: Duration = Duration::from_millis(1);

#[derive(Debug)]
pub enum SqlCell {
    Null,
    Integer(i64),
    /// Bits of the binary64 value returned by SQLite.
    RealBits(u64),
    /// Strict UTF-8 validation has succeeded; original bytes are retained.
    Text(Vec<u8>),
    Blob(Vec<u8>),
}

#[derive(Debug)]
pub struct StoreRow {
    /// One-based ordinal in this cursor, not a database or authority identity.
    pub ordinal: u64,
    pub cells: [SqlCell; 5],
}

#[derive(Clone, Copy, Debug)]
pub struct AcquisitionLimits {
    pub max_rows: u64,
    pub max_cell_bytes: usize,
    pub max_total_bytes: usize,
}

#[derive(Clone, Copy)]
pub struct Cancellation {
    /// Must be nonblocking and must not reenter SQLite.
    /// Atomic state reads are the intended implementation.
    pub is_cancelled: fn() -> bool,
    pub deadline: Instant,
}

/// Request-owned cancellation remains alive with uncertain cleanup handles.
#[derive(Clone)]
pub struct OwnedCancellation {
    pub is_cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub deadline: Instant,
}
impl From<Cancellation> for OwnedCancellation {
    fn from(value: Cancellation) -> Self {
        Self {
            is_cancelled: Arc::new(value.is_cancelled),
            deadline: value.deadline,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    Requested,
    Deadline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ControlFailure {
    Requested,
    Deadline,
    CallbackPanic,
}

#[derive(Clone, Debug)]
pub struct SqlFailure {
    pub phase: &'static str,
    pub primary_code: Option<i32>,
    pub extended_code: Option<i32>,
    pub message: String,
}

#[derive(Debug)]
pub struct TextFailure {
    pub row_ordinal: u64,
    pub column: usize,
    pub column_name: &'static str,
    /// Complete cell bytes, bounded by max_cell_bytes and max_total_bytes.
    /// Rendering a CPython-specific message belongs to the caller.
    pub raw: Vec<u8>,
    pub valid_up_to: usize,
    pub error_len: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourceFailure {
    Rows,
    CellBytes,
    TotalBytes,
    Allocation,
    CounterOverflow,
}

#[derive(Debug)]
pub enum VisitorFailure<E> {
    Visitor(E),
    Transport(E),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visit {
    Continue,
    Stop,
}

#[derive(Debug)]
pub enum Failure<E> {
    Input(&'static str),
    Sql(SqlFailure),
    Text(TextFailure),
    Resource(ResourceFailure),
    Cancelled(CancelReason),
    CancellationCallbackPanic,
    Visitor(E),
    Transport(E),
    VisitorPanic,
    Cleanup(&'static str),
}

#[derive(Clone, Debug)]
pub enum CleanupCall {
    NotNeeded,
    Succeeded,
    Failed(SqlFailure),
}

#[derive(Debug)]
pub struct Cleanup {
    pub progress_unregistered: bool,
    pub busy_unregistered: CleanupCall,
    pub finalized: CleanupCall,
    pub rollback: CleanupCall,
    pub close: CleanupCall,
    pub retained_uncertain: bool,
}

impl Default for Cleanup {
    fn default() -> Self {
        Self {
            progress_unregistered: false,
            busy_unregistered: CleanupCall::NotNeeded,
            finalized: CleanupCall::NotNeeded,
            rollback: CleanupCall::NotNeeded,
            close: CleanupCall::NotNeeded,
            retained_uncertain: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Exhausted,
    Stopped,
    Failed,
}

#[derive(Debug, Default)]
pub struct Metrics {
    pub rows_copied: u64,
    /// Rows handed to the native visitor, including visitor/transport failures.
    /// This is not a successful engine-write or consumer-delivery receipt.
    pub rows_delivered: u64,
    /// TEXT/BLOB byte lengths; INTEGER/REAL charge eight bytes; NULL charges zero.
    pub accounted_cell_bytes: usize,
}

#[derive(Debug)]
pub struct Acquisition<E> {
    pub end: End,
    pub first_failure: Option<Failure<E>>,
    pub cleanup: Cleanup,
    pub metrics: Metrics,
    /// No SQL/source-operation methods are exposed.
    pub retained: Option<RetainedConnection>,
}

impl<E> Acquisition<E> {
    fn failed(failure: Failure<E>) -> Self {
        Self {
            end: End::Failed,
            first_failure: Some(failure),
            cleanup: Cleanup::default(),
            metrics: Metrics::default(),
            retained: None,
        }
    }
}

struct Control {
    cancellation: OwnedCancellation,
    first_failure: Cell<Option<ControlFailure>>,
    busy_started: Cell<Option<Instant>>,
}

impl Control {
    fn new(cancellation: impl Into<OwnedCancellation>) -> Self {
        Self {
            cancellation: cancellation.into(),
            first_failure: Cell::new(None),
            busy_started: Cell::new(None),
        }
    }

    fn mark(&self, failure: ControlFailure) {
        if self.first_failure.get().is_none() {
            self.first_failure.set(Some(failure));
        }
    }

    fn poll(&self) -> bool {
        if self.first_failure.get().is_some() {
            return false;
        }
        match catch_unwind(AssertUnwindSafe(|| (self.cancellation.is_cancelled)())) {
            Ok(true) => self.mark(ControlFailure::Requested),
            Ok(false) => {
                if Instant::now() >= self.cancellation.deadline {
                    self.mark(ControlFailure::Deadline);
                }
            }
            Err(_) => self.mark(ControlFailure::CallbackPanic),
        }
        self.first_failure.get().is_none()
    }

    fn failure<E>(&self) -> Option<Failure<E>> {
        self.first_failure.get().map(|failure| match failure {
            ControlFailure::Requested => Failure::Cancelled(CancelReason::Requested),
            ControlFailure::Deadline => Failure::Cancelled(CancelReason::Deadline),
            ControlFailure::CallbackPanic => Failure::CancellationCallbackPanic,
        })
    }

    fn check<E>(&self) -> Result<(), Failure<E>> {
        if self.poll() {
            Ok(())
        } else {
            Err(self.failure().expect("failed poll records a reason"))
        }
    }
}

fn sql_failure(phase: &'static str, error: rusqlite::Error) -> SqlFailure {
    let rendered = error.to_string();
    match error {
        rusqlite::Error::SqliteFailure(code, message) => SqlFailure {
            phase,
            primary_code: Some(code.extended_code & 0xff),
            extended_code: Some(code.extended_code),
            message: message.unwrap_or(rendered),
        },
        _ => SqlFailure {
            phase,
            primary_code: None,
            extended_code: None,
            message: rendered,
        },
    }
}

fn code_failure(phase: &'static str, code: c_int) -> SqlFailure {
    sql_failure(
        phase,
        rusqlite::Error::SqliteFailure(ffi::Error::new(code), None),
    )
}

fn operation_error<E>(
    control: &Control,
    phase: &'static str,
    error: rusqlite::Error,
) -> Failure<E> {
    control
        .failure()
        .unwrap_or_else(|| Failure::Sql(sql_failure(phase, error)))
}

unsafe extern "C" fn progress_callback(context: *mut c_void) -> c_int {
    if context.is_null() {
        return 1;
    }
    // SAFETY: HookScope owns this stable Box until unregistration/connection
    // cleanup. This private connection is used synchronously on one thread.
    let control = unsafe { &*(context.cast::<Control>()) };
    match catch_unwind(AssertUnwindSafe(|| control.poll())) {
        Ok(true) => 0,
        Ok(false) => 1,
        Err(_) => {
            control.mark(ControlFailure::CallbackPanic);
            1
        }
    }
}

unsafe extern "C" fn busy_callback(context: *mut c_void, count: c_int) -> c_int {
    if context.is_null() {
        return 0;
    }
    // SAFETY: same scoped, stable userdata invariant as progress_callback.
    let control = unsafe { &*(context.cast::<Control>()) };
    match catch_unwind(AssertUnwindSafe(|| {
        if !control.poll() {
            return false;
        }
        let now = Instant::now();
        if count <= 0 || control.busy_started.get().is_none() {
            control.busy_started.set(Some(now));
        }
        let began = control.busy_started.get().expect("busy start established");
        let remaining_busy = BUSY_CEILING.saturating_sub(now.duration_since(began));
        let remaining_deadline = control.cancellation.deadline.saturating_duration_since(now);
        let wait = BUSY_POLL.min(remaining_busy).min(remaining_deadline);
        if wait.is_zero() {
            control.poll();
            return false;
        }
        thread::sleep(wait);
        control.poll() && began.elapsed() < BUSY_CEILING
    })) {
        Ok(retry) => c_int::from(retry),
        Err(_) => {
            control.mark(ControlFailure::CallbackPanic);
            0
        }
    }
}

/// Must only receive the still-live handle of this module's private connection.
unsafe fn unregister(db: *mut ffi::sqlite3) -> c_int {
    // Progress removal has no result code. Busy removal's result is retained.
    unsafe {
        ffi::sqlite3_progress_handler(db, 0, None, ptr::null_mut());
        ffi::sqlite3_busy_handler(db, None, ptr::null_mut())
    }
}

struct HookScope<'connection> {
    db: *mut ffi::sqlite3,
    control: Option<Box<Control>>,
    armed: bool,
    _connection: PhantomData<&'connection Connection>,
}

impl<'connection> HookScope<'connection> {
    fn install(connection: &'connection Connection, mut control: Box<Control>) -> (Self, c_int) {
        // SAFETY: no handle escapes the module or is concurrently used.
        let db = unsafe { connection.handle() };
        let context = (&mut *control as *mut Control).cast::<c_void>();
        let scope = Self {
            db,
            control: Some(control),
            armed: true,
            _connection: PhantomData,
        };
        let result = unsafe {
            ffi::sqlite3_progress_handler(
                db,
                PROGRESS_INSTRUCTIONS,
                Some(progress_callback),
                context,
            );
            // Replaces rusqlite's default five-second busy timeout.
            ffi::sqlite3_busy_handler(db, Some(busy_callback), context)
        };
        (scope, result)
    }

    fn control(&self) -> &Control {
        self.control.as_deref().expect("hook userdata exists")
    }

    fn detach(mut self) -> (Box<Control>, c_int) {
        let result = unsafe { unregister(self.db) };
        self.armed = false;
        (self.control.take().expect("hook userdata exists"), result)
    }
}

impl Drop for HookScope<'_> {
    fn drop(&mut self) {
        if self.armed {
            let result = unsafe { unregister(self.db) };
            if result != ffi::SQLITE_OK {
                // Exceptional unwind fallback only: freeing possibly registered
                // userdata would be unsafe. Normal close failures return an owner.
                if let Some(control) = self.control.take() {
                    let _ = Box::leak(control);
                }
            }
        }
    }
}

/// Opaque cleanup ownership after an explicitly failed close.
/// No connection handle or source-operation interface is exposed.
pub struct RetainedConnection {
    // Declaration order keeps the connection alive until Drop's unregistration,
    // and drops it before userdata in the ordinary fallback.
    connection: Option<Connection>,
    control: Option<Box<Control>>,
}

impl fmt::Debug for RetainedConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RetainedConnection")
            .field("retained_uncertain", &self.connection.is_some())
            .finish()
    }
}

impl RetainedConnection {
    /// Cleanup-only retry. Failure retains ownership in this object.
    pub fn retry_close(&mut self) -> Result<(), SqlFailure> {
        let Some(connection) = self.connection.as_ref() else {
            return Ok(());
        };
        let result = unsafe { unregister(connection.handle()) };
        if result != ffi::SQLITE_OK {
            return Err(code_failure("retry_unregister_busy", result));
        }
        if !connection.is_autocommit() {
            connection
                .execute_batch("ROLLBACK")
                .map_err(|error| sql_failure("retry_rollback", error))?;
        }
        let connection = self.connection.take().expect("retained connection exists");
        match connection.close() {
            Ok(()) => {
                self.control.take();
                Ok(())
            }
            Err((connection, error)) => {
                self.connection = Some(connection);
                Err(sql_failure("retry_close", error))
            }
        }
    }
}

impl Drop for RetainedConnection {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.as_ref() {
            let result = unsafe { unregister(connection.handle()) };
            if result != ffi::SQLITE_OK {
                // If the caller discards an uncertain owner and unregistration
                // fails, retain userdata rather than leave a dangling callback.
                // This does not claim the database handle has been released.
                if let Some(control) = self.control.take() {
                    let _ = Box::leak(control);
                }
            }
        }
        // Connection's ordinary Drop may retry close. Its result is not exposed;
        // therefore this path establishes no FD-release or successful-close claim.
    }
}

fn charge<E>(
    bytes: usize,
    limits: AcquisitionLimits,
    metrics: &mut Metrics,
) -> Result<(), Failure<E>> {
    if bytes > limits.max_cell_bytes {
        return Err(Failure::Resource(ResourceFailure::CellBytes));
    }
    let total = metrics
        .accounted_cell_bytes
        .checked_add(bytes)
        .ok_or(Failure::Resource(ResourceFailure::CounterOverflow))?;
    if total > limits.max_total_bytes {
        return Err(Failure::Resource(ResourceFailure::TotalBytes));
    }
    metrics.accounted_cell_bytes = total;
    Ok(())
}

fn own_bytes<E>(bytes: &[u8]) -> Result<Vec<u8>, Failure<E>> {
    let mut owned = Vec::new();
    owned
        .try_reserve_exact(bytes.len())
        .map_err(|_| Failure::Resource(ResourceFailure::Allocation))?;
    owned.extend_from_slice(bytes);
    Ok(owned)
}

fn own_row<E>(
    row: &Row<'_>,
    control: &Control,
    limits: AcquisitionLimits,
    metrics: &mut Metrics,
) -> Result<StoreRow, Failure<E>> {
    if metrics.rows_copied >= limits.max_rows {
        return Err(Failure::Resource(ResourceFailure::Rows));
    }
    let ordinal = metrics
        .rows_copied
        .checked_add(1)
        .ok_or(Failure::Resource(ResourceFailure::CounterOverflow))?;
    let mut cells = std::array::from_fn(|_| SqlCell::Null);
    for column in 0..5 {
        control.check()?;
        let value = row
            .get_ref(column)
            .map_err(|error| operation_error(control, "current_row_cell", error))?;
        cells[column] = match value {
            ValueRef::Null => SqlCell::Null,
            ValueRef::Integer(value) => {
                charge(8, limits, metrics)?;
                SqlCell::Integer(value)
            }
            ValueRef::Real(value) => {
                charge(8, limits, metrics)?;
                SqlCell::RealBits(value.to_bits())
            }
            ValueRef::Text(bytes) => {
                charge(bytes.len(), limits, metrics)?;
                let owned = own_bytes(bytes)?;
                if let Err(error) = std::str::from_utf8(&owned) {
                    return Err(Failure::Text(TextFailure {
                        row_ordinal: ordinal,
                        column,
                        column_name: COLUMN_NAMES[column],
                        valid_up_to: error.valid_up_to(),
                        error_len: error.error_len(),
                        raw: owned,
                    }));
                }
                SqlCell::Text(owned)
            }
            ValueRef::Blob(bytes) => {
                charge(bytes.len(), limits, metrics)?;
                SqlCell::Blob(own_bytes(bytes)?)
            }
        };
    }
    metrics.rows_copied = ordinal;
    Ok(StoreRow { ordinal, cells })
}

// The public entry prepares only QUERY. Accepting a prepared statement here keeps
// cursor ordering independently testable against real SQLite VM failures.
fn visit_statement<E, F>(
    prepared: &mut Statement<'_>,
    session: Option<&str>,
    control: &Control,
    limits: AcquisitionLimits,
    metrics: &mut Metrics,
    visitor: &mut F,
) -> Result<End, Failure<E>>
where
    F: FnMut(StoreRow) -> Result<Visit, VisitorFailure<E>>,
{
    if prepared.column_count() != 5 {
        return Err(Failure::Input("fixed query did not expose five columns"));
    }
    if let Some(session) = session {
        prepared
            .raw_bind_parameter(1, session)
            .map_err(|error| operation_error(control, "bind", error))?;
    }
    let mut rows = prepared.raw_query();
    let mut current = rows
        .next()
        .map_err(|error| operation_error(control, "first_step", error))?;
    while let Some(row) = current {
        let owned = own_row(row, control, limits, metrics)?;
        // Convert CURRENT, then VM-step NEXT, then deliver CURRENT. Do not inspect
        // next-row columns until the current visitor returns Continue.
        current = rows
            .next()
            .map_err(|error| operation_error(control, "lookahead_step", error))?;
        control.check()?;
        metrics.rows_delivered = metrics
            .rows_delivered
            .checked_add(1)
            .ok_or(Failure::Resource(ResourceFailure::CounterOverflow))?;
        match catch_unwind(AssertUnwindSafe(|| visitor(owned))) {
            Ok(Ok(Visit::Continue)) => {}
            Ok(Ok(Visit::Stop)) => return Ok(End::Stopped),
            Ok(Err(VisitorFailure::Visitor(error))) => return Err(Failure::Visitor(error)),
            Ok(Err(VisitorFailure::Transport(error))) => return Err(Failure::Transport(error)),
            Err(_) => return Err(Failure::VisitorPanic),
        }
    }
    Ok(End::Exhausted)
}

/// Runs only the fixed acquisition query. It performs no JSON reconstruction,
/// publication, transport discovery, or source/schema admission.
///
/// Resource bounds cover owned row payloads, not SQLite's complete VM/cache/sort
/// memory. Cancellation/deadline polling is cooperative, not an OS I/O deadline.
pub fn acquire<E, F>(
    database: &str,
    session: &str,
    limits: AcquisitionLimits,
    cancellation: Cancellation,
    visitor: F,
) -> Acquisition<E>
where
    F: FnMut(StoreRow) -> Result<Visit, VisitorFailure<E>>,
{
    acquire_owned(database, session, limits, cancellation.into(), visitor)
}

pub fn acquire_owned<E, F>(
    database: &str,
    session: &str,
    limits: AcquisitionLimits,
    cancellation: OwnedCancellation,
    mut visitor: F,
) -> Acquisition<E>
where
    F: FnMut(StoreRow) -> Result<Visit, VisitorFailure<E>>,
{
    if database.contains('\0') || !Path::new(database).is_absolute() {
        return Acquisition::failed(Failure::Input("database must be absolute without NUL"));
    }
    if limits.max_cell_bytes > isize::MAX as usize || limits.max_total_bytes > isize::MAX as usize {
        return Acquisition::failed(Failure::Input("byte limits exceed addressable slice range"));
    }
    let control = Box::new(Control::new(cancellation));
    if let Err(error) = control.check() {
        return Acquisition::failed(error);
    }
    record_database_open_attempt(&TRANSCRIPT_DATABASE_OPEN_ATTEMPTS);
    let connection = match Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            return Acquisition::failed(Failure::Sql(sql_failure("open", error)));
        }
    };
    let (hooks, install_result) = HookScope::install(&connection, control);
    let mut result = Acquisition {
        end: End::Failed,
        first_failure: None,
        cleanup: Cleanup::default(),
        metrics: Metrics::default(),
        retained: None,
    };
    let mut statement: Option<Statement<'_>> = None;
    let operation = (|| -> Result<End, Failure<E>> {
        let control = hooks.control();
        if install_result != ffi::SQLITE_OK {
            return Err(Failure::Sql(code_failure(
                "install_busy_handler",
                install_result,
            )));
        }
        control.check()?;
        connection
            .execute_batch("PRAGMA query_only=ON")
            .map_err(|error| operation_error(control, "query_only", error))?;
        control.check()?;
        connection
            .execute_batch("BEGIN")
            .map_err(|error| operation_error(control, "begin", error))?;
        control.check()?;
        statement = Some(
            connection
                .prepare(QUERY)
                .map_err(|error| operation_error(control, "prepare", error))?,
        );
        let prepared = statement.as_mut().expect("prepared statement exists");
        visit_statement(
            prepared,
            Some(session),
            control,
            limits,
            &mut result.metrics,
            &mut visitor,
        )
    })();

    match operation {
        Ok(end) => result.end = end,
        Err(error) => result.first_failure = Some(error),
    }

    // Keep userdata alive through all cleanup. Disable cancellation callbacks
    // before explicit finalize, rollback and close.
    let (control, unregister_result) = hooks.detach();
    result.cleanup.progress_unregistered = true;
    let mut first_cleanup_failure = None;
    result.cleanup.busy_unregistered = if unregister_result == ffi::SQLITE_OK {
        CleanupCall::Succeeded
    } else {
        first_cleanup_failure = Some("unregister_busy");
        CleanupCall::Failed(code_failure("unregister_busy", unregister_result))
    };

    if let Some(prepared) = statement.take() {
        result.cleanup.finalized = match prepared.finalize() {
            Ok(()) => CleanupCall::Succeeded,
            Err(error) => {
                first_cleanup_failure.get_or_insert("finalize");
                CleanupCall::Failed(sql_failure("finalize", error))
            }
        };
    }
    drop(statement);

    if !connection.is_autocommit() {
        result.cleanup.rollback = match connection.execute_batch("ROLLBACK") {
            Ok(()) => CleanupCall::Succeeded,
            Err(error) => {
                first_cleanup_failure.get_or_insert("rollback");
                CleanupCall::Failed(sql_failure("rollback", error))
            }
        };
    }
    match connection.close() {
        Ok(()) => {
            result.cleanup.close = CleanupCall::Succeeded;
            drop(control);
        }
        Err((connection, error)) => {
            first_cleanup_failure.get_or_insert("close");
            result.cleanup.close = CleanupCall::Failed(sql_failure("close", error));
            result.cleanup.retained_uncertain = true;
            result.retained = Some(RetainedConnection {
                connection: Some(connection),
                control: Some(control),
            });
        }
    }
    if result.first_failure.is_none()
        && let Some(phase) = first_cleanup_failure
    {
        result.first_failure = Some(Failure::Cleanup(phase));
    }
    if result.first_failure.is_some() {
        result.end = End::Failed;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    #[test]
    fn database_open_attempt_counter_increments_and_saturates_without_wrapping() {
        // A local counter gives exact assertions independent of parallel acquisitions.
        let counter = AtomicU64::new(0);
        record_database_open_attempt(&counter);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        record_database_open_attempt(&counter);
        assert_eq!(counter.load(Ordering::SeqCst), 2);
        counter.store(u64::MAX - 1, Ordering::SeqCst);
        record_database_open_attempt(&counter);
        assert_eq!(counter.load(Ordering::SeqCst), u64::MAX);
        record_database_open_attempt(&counter);
        assert_eq!(counter.load(Ordering::SeqCst), u64::MAX);
    }

    static NEXT: AtomicU64 = AtomicU64::new(0);
    static BUSY_CANCEL: AtomicBool = AtomicBool::new(false);
    static HOOK_PANIC: AtomicBool = AtomicBool::new(false);
    fn never_cancel() -> bool {
        false
    }
    fn busy_cancel() -> bool {
        BUSY_CANCEL.load(Ordering::SeqCst)
    }
    fn hook_panic() -> bool {
        assert!(
            !HOOK_PANIC.load(Ordering::SeqCst),
            "controlled cancellation callback panic"
        );
        false
    }
    fn panic_cancel() -> bool {
        panic!("controlled cancellation panic")
    }
    fn limits() -> AcquisitionLimits {
        AcquisitionLimits {
            max_rows: 32,
            max_cell_bytes: 4096,
            max_total_bytes: 65536,
        }
    }
    fn cancellation() -> Cancellation {
        Cancellation {
            is_cancelled: never_cancel,
            deadline: Instant::now() + Duration::from_secs(3),
        }
    }
    struct Fixture {
        directory: PathBuf,
        database: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let mut chosen = None;
            for _ in 0..64 {
                let directory = std::env::temp_dir().join(format!(
                    "caws-store-reader-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::SeqCst)
                ));
                match fs::create_dir(&directory) {
                    Ok(()) => {
                        chosen = Some(directory);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("fixture directory: {error}"),
                }
            }
            let directory = chosen.expect("unique fixture directory");
            let database = directory.join("source.sqlite");
            let connection = Connection::open(&database).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE message(id,session_id,time_created,data);\
                 CREATE TABLE part(id,message_id,time_created,data);\
                 INSERT INTO message VALUES('m','target',0,'{\"role\":\"assistant\"}');\
                 INSERT INTO part VALUES('p','m',1,'{\"type\":\"text\",\"text\":\"hello\"}');",
                )
                .unwrap();
            connection.close().unwrap();
            Self {
                directory,
                database,
            }
        }
        fn path(&self) -> &str {
            self.database.to_str().unwrap()
        }
        fn open(&self) -> Connection {
            Connection::open(&self.database).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.directory).unwrap();
        }
    }
    fn fixed<F>(
        fixture: &Fixture,
        bounds: AcquisitionLimits,
        visitor: F,
    ) -> Acquisition<&'static str>
    where
        F: FnMut(StoreRow) -> Result<Visit, VisitorFailure<&'static str>>,
    {
        acquire(fixture.path(), "target", bounds, cancellation(), visitor)
    }
    fn assert_cleanup<E: fmt::Debug>(outcome: &Acquisition<E>) {
        assert!(outcome.cleanup.progress_unregistered);
        assert!(matches!(
            outcome.cleanup.busy_unregistered,
            CleanupCall::Succeeded
        ));
        assert!(matches!(outcome.cleanup.finalized, CleanupCall::Succeeded));
        assert!(matches!(outcome.cleanup.rollback, CleanupCall::Succeeded));
        assert!(matches!(outcome.cleanup.close, CleanupCall::Succeeded));
        assert!(!outcome.cleanup.retained_uncertain);
        assert!(outcome.retained.is_none());
    }
    struct QueryRun {
        operation: Result<End, Failure<&'static str>>,
        metrics: Metrics,
        finalized: rusqlite::Result<()>,
    }
    // Real SQLite statements exercise the private traversal; only the public
    // acquire path constitutes a fixed-query/database acquisition observation.
    fn query<F>(sql: &str, bounds: AcquisitionLimits, mut visitor: F) -> QueryRun
    where
        F: FnMut(StoreRow) -> Result<Visit, VisitorFailure<&'static str>>,
    {
        let connection = Connection::open_in_memory().unwrap();
        let mut statement = connection.prepare(sql).unwrap();
        let control = Control::new(cancellation());
        let mut metrics = Metrics::default();
        let operation = visit_statement(
            &mut statement,
            None,
            &control,
            bounds,
            &mut metrics,
            &mut visitor,
        );
        let finalized = statement.finalize();
        connection.close().unwrap();
        QueryRun {
            operation,
            metrics,
            finalized,
        }
    }

    #[test]
    fn fixed_query_filters_session_and_keeps_message_time_id_part_id_order() {
        let fixture = Fixture::new();
        let connection = fixture.open();
        connection.execute_batch(
            "DELETE FROM part; DELETE FROM message;\
             INSERT INTO message VALUES('a','target',1,'{}'),('b','target',0,'{}'),('f','foreign',-1,'{}');\
             INSERT INTO part VALUES('z0','a',-999,'{}'),('a0','a',999,'{}'),\
             ('b0','b',888,'{}'),('foreign','f',0,'{}');"
        ).unwrap();
        connection.close().unwrap();
        let mut ids = Vec::new();
        let outcome = fixed(&fixture, limits(), |row| {
            match &row.cells[2] {
                SqlCell::Text(bytes) => ids.push(bytes.clone()),
                other => panic!("unexpected part ID {other:?}"),
            }
            Ok(Visit::Continue)
        });
        assert_eq!(outcome.end, End::Exhausted);
        assert!(outcome.first_failure.is_none());
        assert_eq!(ids, vec![b"b0".to_vec(), b"a0".to_vec(), b"z0".to_vec()]);
        assert_eq!(outcome.metrics.rows_delivered, 3);
        assert_cleanup(&outcome);
    }

    #[test]
    fn fixed_query_preserves_all_five_storage_classes_without_json_interpretation() {
        let fixture = Fixture::new();
        let connection = fixture.open();
        connection
            .execute_batch("DELETE FROM part; DELETE FROM message;")
            .unwrap();
        connection
            .execute("INSERT INTO message VALUES(?1,'target',0,NULL)", [i64::MIN])
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES(?1,?2,?3,?4)",
                rusqlite::params![1.5_f64, i64::MIN, vec![0xff_u8, 0, 0x80], "x\0😀"],
            )
            .unwrap();
        connection.close().unwrap();
        let mut rows = Vec::new();
        let outcome = fixed(&fixture, limits(), |row| {
            rows.push(row);
            Ok(Visit::Continue)
        });
        assert_eq!(outcome.end, End::Exhausted);
        assert_eq!(rows.len(), 1);
        assert!(matches!(rows[0].cells[0], SqlCell::Integer(i64::MIN)));
        assert!(matches!(rows[0].cells[1], SqlCell::Null));
        assert!(matches!(rows[0].cells[2], SqlCell::RealBits(bits) if bits == 1.5_f64.to_bits()));
        match &rows[0].cells[3] {
            SqlCell::Text(bytes) => assert_eq!(bytes, "x\0😀".as_bytes()),
            other => panic!("unexpected TEXT {other:?}"),
        }
        match &rows[0].cells[4] {
            SqlCell::Blob(bytes) => assert_eq!(bytes, &[0xff, 0, 0x80]),
            other => panic!("unexpected BLOB {other:?}"),
        }
        assert_cleanup(&outcome);
    }

    #[test]
    fn lookahead_sql_error_discards_current_row_before_visitor() {
        let mut called = 0;
        let run = query(
            "SELECT 1,NULL,NULL,NULL,NULL UNION ALL SELECT abs(-9223372036854775808),NULL,NULL,NULL,NULL",
            limits(),
            |_| {
                called += 1;
                Ok(Visit::Stop)
            },
        );
        assert_eq!(called, 0);
        assert_eq!(run.metrics.rows_copied, 1);
        assert_eq!(run.metrics.rows_delivered, 0);
        match run.operation {
            Err(Failure::Sql(error)) => {
                assert_eq!(error.phase, "lookahead_step");
                assert_eq!(error.primary_code, Some(ffi::SQLITE_ERROR));
                assert!(error.message.contains("integer overflow"));
            }
            other => panic!("lookahead error lost: {other:?}"),
        }
        // finalize is observed by QueryRun, not assumed successful because the
        // cursor failed. It frees the Statement even when returning an error.
        let _observed_finalize = run.finalized;
    }

    #[test]
    fn current_text_error_precedes_next_step_sql_error_and_checks_columns_in_order() {
        let run = query(
            "SELECT CAST(X'FF' AS TEXT),CAST(X'FE' AS TEXT),NULL,NULL,NULL \
             UNION ALL SELECT abs(-9223372036854775808),NULL,NULL,NULL,NULL",
            limits(),
            |_| panic!("JSON/visitor stage must not run"),
        );
        match run.operation {
            Err(Failure::Text(error)) => {
                assert_eq!(error.column, 0);
                assert_eq!(error.column_name, "message_id");
                assert_eq!(error.raw, vec![0xff]);
                assert_eq!(error.valid_up_to, 0);
            }
            other => panic!("current TEXT did not win: {other:?}"),
        }
        assert_eq!(run.metrics.rows_delivered, 0);
        for column in 0..5 {
            let mut values = vec!["'valid'"; 5];
            values[column] = "CAST(X'FF' AS TEXT)";
            let run = query(&format!("SELECT {}", values.join(",")), limits(), |_| {
                panic!("visitor must wait for all five column conversions")
            });
            match run.operation {
                Err(Failure::Text(error)) => {
                    assert_eq!(error.column, column);
                    assert_eq!(error.column_name, COLUMN_NAMES[column]);
                    assert_eq!(error.raw, vec![0xff]);
                }
                other => panic!("column conversion lost: {other:?}"),
            }
        }
    }

    #[test]
    fn later_invalid_text_is_not_converted_before_stop_or_first_visitor_error() {
        let sql = "SELECT 'first',NULL,NULL,NULL,NULL UNION ALL SELECT CAST(X'FF' AS TEXT),NULL,NULL,NULL,NULL";
        let mut calls = 0;
        let stopped = query(sql, limits(), |_| {
            calls += 1;
            Ok(Visit::Stop)
        });
        assert!(matches!(stopped.operation, Ok(End::Stopped)));
        assert_eq!(calls, 1);
        assert_eq!(stopped.metrics.rows_copied, 1);
        assert!(stopped.finalized.is_ok());
        let visitor = query(sql, limits(), |_| {
            Err(VisitorFailure::Visitor("first error"))
        });
        assert!(matches!(
            visitor.operation,
            Err(Failure::Visitor("first error"))
        ));
        let transport = query(sql, limits(), |_| {
            Err(VisitorFailure::Transport("write failed"))
        });
        assert!(matches!(
            transport.operation,
            Err(Failure::Transport("write failed"))
        ));
        let mut calls = 0;
        let continued = query(sql, limits(), |_| {
            calls += 1;
            Ok(Visit::Continue)
        });
        assert_eq!(calls, 1);
        assert!(matches!(
            continued.operation,
            Err(Failure::Text(TextFailure {
                row_ordinal: 2,
                column: 0,
                ..
            }))
        ));
    }

    #[test]
    fn row_and_byte_limits_are_distinct_and_exact() {
        let sql = "SELECT X'0102',X'0304',NULL,NULL,NULL";
        let exact = AcquisitionLimits {
            max_rows: 1,
            max_cell_bytes: 2,
            max_total_bytes: 4,
        };
        let good = query(sql, exact, |_| Ok(Visit::Continue));
        assert!(matches!(good.operation, Ok(End::Exhausted)));
        assert_eq!(good.metrics.accounted_cell_bytes, 4);
        assert!(good.finalized.is_ok());
        let cell = query(
            sql,
            AcquisitionLimits {
                max_cell_bytes: 1,
                ..exact
            },
            |_| panic!("over budget"),
        );
        assert!(matches!(
            cell.operation,
            Err(Failure::Resource(ResourceFailure::CellBytes))
        ));
        let total = query(
            sql,
            AcquisitionLimits {
                max_total_bytes: 3,
                ..exact
            },
            |_| panic!("over budget"),
        );
        assert!(matches!(
            total.operation,
            Err(Failure::Resource(ResourceFailure::TotalBytes))
        ));
        let rows = query(
            sql,
            AcquisitionLimits {
                max_rows: 0,
                ..exact
            },
            |_| panic!("over budget"),
        );
        assert!(matches!(
            rows.operation,
            Err(Failure::Resource(ResourceFailure::Rows))
        ));
        let empty = query(
            "SELECT NULL,NULL,NULL,NULL,NULL WHERE 0",
            AcquisitionLimits {
                max_rows: 0,
                max_cell_bytes: 0,
                max_total_bytes: 0,
            },
            |_| panic!("empty"),
        );
        assert!(matches!(empty.operation, Ok(End::Exhausted)));
    }

    #[test]
    fn visitor_and_cancellation_panics_are_typed_and_cleanup_is_real() {
        let fixture = Fixture::new();
        let outcome = fixed(&fixture, limits(), |_| panic!("controlled visitor panic"));
        assert!(matches!(outcome.first_failure, Some(Failure::VisitorPanic)));
        assert_eq!(outcome.end, End::Failed);
        assert_cleanup(&outcome);
        let outcome = acquire::<&'static str, _>(
            fixture.path(),
            "target",
            limits(),
            Cancellation {
                is_cancelled: panic_cancel,
                deadline: Instant::now() + Duration::from_secs(1),
            },
            |_| panic!("must not visit"),
        );
        assert!(matches!(
            outcome.first_failure,
            Some(Failure::CancellationCallbackPanic)
        ));
        assert!(matches!(outcome.cleanup.close, CleanupCall::NotNeeded));
    }

    #[test]
    fn progress_hook_interrupts_actual_vm_and_contains_c_callback_panic() {
        const HEAVY: &str = "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x),NULL,NULL,NULL,NULL FROM n";
        for panic_mode in [false, true] {
            HOOK_PANIC.store(false, Ordering::SeqCst);
            let connection = Connection::open_in_memory().unwrap();
            // Compile before installing the deliberately short execution deadline:
            // this control measures VM stepping, not scheduler-sensitive prepare.
            let mut statement = connection.prepare(HEAVY).unwrap();
            let control = Box::new(Control::new(Cancellation {
                is_cancelled: hook_panic,
                deadline: Instant::now()
                    + if panic_mode {
                        Duration::from_secs(3)
                    } else {
                        Duration::from_millis(1)
                    },
            }));
            let (hooks, installed) = HookScope::install(&connection, control);
            assert_eq!(installed, ffi::SQLITE_OK);
            HOOK_PANIC.store(panic_mode, Ordering::SeqCst);
            let interrupted = {
                let mut rows = statement.query([]).unwrap();
                matches!(rows.next(), Err(rusqlite::Error::SqliteFailure(code,_)) if code.extended_code & 0xff == ffi::SQLITE_INTERRUPT)
            };
            HOOK_PANIC.store(false, Ordering::SeqCst);
            assert!(
                interrupted,
                "must be an actual sqlite3_step interrupt, not a later Rust poll"
            );
            let expected = if panic_mode {
                ControlFailure::CallbackPanic
            } else {
                ControlFailure::Deadline
            };
            assert_eq!(hooks.control().first_failure.get(), Some(expected));
            let (control, removed) = hooks.detach();
            assert_eq!(removed, ffi::SQLITE_OK);
            let _observed_finalize = statement.finalize();
            connection.close().unwrap();
            drop(control);
        }
    }

    #[test]
    fn short_busy_lock_can_clear_but_deadline_and_cancel_stay_failures_not_empty() {
        let fixture = Fixture::new();
        let holder = fixture.open();
        holder
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE")
            .unwrap();
        let released = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            holder.execute_batch("ROLLBACK").unwrap();
            holder.close().unwrap();
        });
        let outcome = fixed(&fixture, limits(), |_| Ok(Visit::Continue));
        released.join().unwrap();
        assert_eq!(outcome.end, End::Exhausted);
        assert_eq!(outcome.metrics.rows_delivered, 1);
        assert_cleanup(&outcome);
        let holder = fixture.open();
        holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let deadline = acquire::<&'static str, _>(
            fixture.path(),
            "target",
            limits(),
            Cancellation {
                is_cancelled: never_cancel,
                deadline: Instant::now() + Duration::from_millis(25),
            },
            |_| panic!("locked"),
        );
        assert!(matches!(
            deadline.first_failure,
            Some(Failure::Cancelled(CancelReason::Deadline))
        ));
        assert_eq!(deadline.end, End::Failed);
        assert_eq!(deadline.metrics.rows_delivered, 0);
        assert!(matches!(deadline.cleanup.close, CleanupCall::Succeeded));
        BUSY_CANCEL.store(false, Ordering::SeqCst);
        let trigger = thread::spawn(|| {
            thread::sleep(Duration::from_millis(25));
            BUSY_CANCEL.store(true, Ordering::SeqCst);
        });
        let cancelled = acquire::<&'static str, _>(
            fixture.path(),
            "target",
            limits(),
            Cancellation {
                is_cancelled: busy_cancel,
                deadline: Instant::now() + Duration::from_secs(3),
            },
            |_| panic!("locked"),
        );
        trigger.join().unwrap();
        BUSY_CANCEL.store(false, Ordering::SeqCst);
        holder.execute_batch("ROLLBACK").unwrap();
        holder.close().unwrap();
        assert!(matches!(
            cancelled.first_failure,
            Some(Failure::Cancelled(CancelReason::Requested))
        ));
        assert_eq!(cancelled.end, End::Failed);
        assert!(matches!(cancelled.cleanup.close, CleanupCall::Succeeded));
    }

    #[test]
    fn busy_ceiling_is_sql_busy_and_missing_schema_is_sql_not_empty() {
        let fixture = Fixture::new();
        let holder = fixture.open();
        holder
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE")
            .unwrap();
        let outcome = fixed(&fixture, limits(), |_| panic!("locked"));
        holder.execute_batch("ROLLBACK").unwrap();
        holder.close().unwrap();
        match outcome.first_failure {
            Some(Failure::Sql(error)) => assert_eq!(error.primary_code, Some(ffi::SQLITE_BUSY)),
            other => panic!("busy became another result: {other:?}"),
        }
        assert_eq!(outcome.end, End::Failed);
        assert!(matches!(outcome.cleanup.close, CleanupCall::Succeeded));
        let connection = fixture.open();
        connection.execute_batch("DROP TABLE part").unwrap();
        connection.close().unwrap();
        let outcome = fixed(&fixture, limits(), |_| panic!("no schema"));
        assert!(matches!(
            outcome.first_failure,
            Some(Failure::Sql(SqlFailure {
                phase: "prepare",
                ..
            }))
        ));
        assert_eq!(outcome.end, End::Failed);
        assert!(matches!(outcome.cleanup.finalized, CleanupCall::NotNeeded));
        assert!(matches!(outcome.cleanup.rollback, CleanupCall::Succeeded));
        assert!(matches!(outcome.cleanup.close, CleanupCall::Succeeded));
    }

    #[test]
    fn transcript_store_wire_failure_retains_independent_cleanup_and_owner() {
        use crate::transcript_store_wire::{ServeError, ServeFailurePhase};
        // Inject settlement observations at the error-transfer boundary. The
        // connection is real; this does not simulate an OS close failure.
        for uncertain in [false, true] {
            let owner = uncertain.then(|| RetainedConnection {
                connection: Some(Connection::open_in_memory().unwrap()),
                control: None,
            });
            let outcome = Acquisition {
                end: End::Failed,
                first_failure: Some(Failure::Transport("primary-read-sentinel".into())),
                cleanup: Cleanup {
                    progress_unregistered: true,
                    busy_unregistered: CleanupCall::Succeeded,
                    finalized: CleanupCall::Succeeded,
                    rollback: CleanupCall::Failed(SqlFailure {
                        phase: "rollback",
                        primary_code: Some(10),
                        extended_code: Some(10),
                        message: "independent-rollback-sentinel".into(),
                    }),
                    close: if uncertain {
                        CleanupCall::Failed(SqlFailure {
                            phase: "close",
                            primary_code: Some(5),
                            extended_code: Some(5),
                            message: "independent-close-sentinel".into(),
                        })
                    } else {
                        CleanupCall::Succeeded
                    },
                    retained_uncertain: uncertain,
                },
                metrics: Metrics::default(),
                retained: owner,
            };
            let error = ServeError::settled(
                ServeFailurePhase::Exchange,
                "read-boundary-sentinel".into(),
                outcome,
            );
            let diagnostic = error.to_string();
            assert!(diagnostic.contains("primary-read-sentinel"));
            assert!(diagnostic.contains("independent-rollback-sentinel"));
            assert!(diagnostic.contains(if uncertain {
                "sourceClosed=false"
            } else {
                "sourceClosed=true"
            }));
            let ServeError::AfterAcquisition {
                phase,
                message,
                mut outcome,
            } = error
            else {
                panic!("lost settlement");
            };
            assert_eq!(phase, ServeFailurePhase::Exchange);
            assert_eq!(message, "read-boundary-sentinel");
            assert!(
                matches!(&outcome.first_failure, Some(Failure::Transport(message)) if message == "primary-read-sentinel")
            );
            assert!(
                matches!(&outcome.cleanup.rollback, CleanupCall::Failed(error) if error.message == "independent-rollback-sentinel")
            );
            assert_eq!(outcome.retained.is_some(), uncertain);
            if uncertain {
                assert!(diagnostic.contains("independent-close-sentinel"));
                let owner = outcome.retained.as_mut().expect("uncertain owner retained");
                assert!(owner.connection.is_some());
                owner.retry_close().unwrap();
                assert!(owner.connection.is_none());
            }
        }
    }
}
