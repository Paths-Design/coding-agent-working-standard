//! Original-child custody, byte transport and cleanup for one native invocation.
//! This process never receives containment authority or adopts a reported PID.
use super::*;
use caws_native::owned_group::{settlement_before_reap, stop_before_reap};
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicI32, Ordering},
};

const CHANNEL_LIMIT: usize = 65_536;
const TICK: Duration = Duration::from_millis(10);
const RETRY: Duration = Duration::from_millis(50);
static SIGNAL: AtomicI32 = AtomicI32::new(0);

extern "C" fn interrupted(signal: libc::c_int) {
    SIGNAL.store(signal, Ordering::Relaxed);
}
fn signals() -> Result<(), String> {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGPIPE] {
        let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
        action.sa_sigaction = interrupted as *const () as usize;
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(format!(
                "custodian signal configuration: {:?}",
                io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

trait ReceiptSink {
    fn length(&self) -> io::Result<u64>;
    fn append(&mut self, bytes: &[u8]) -> io::Result<usize>;
    fn sync(&mut self) -> io::Result<()>;
}
impl ReceiptSink for File {
    fn length(&self) -> io::Result<u64> {
        Ok(self.metadata()?.len())
    }
    fn append(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.write(bytes)
    }
    fn sync(&mut self) -> io::Result<()> {
        self.sync_all()
    }
}
struct Publication {
    receipt: Receipt,
    bytes: Vec<u8>,
    written: usize,
}
struct Journal<S> {
    sink: S,
    length: u64,
    pending: Option<Publication>,
    durable: Option<Receipt>,
    blocked: Option<String>,
}
fn same_record(a: &Receipt, b: &Receipt) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.sequence = 0;
    b.sequence = 0;
    a == b
}
impl<S: ReceiptSink> Journal<S> {
    fn new(sink: S) -> Self {
        Self {
            sink,
            length: 0,
            pending: None,
            durable: None,
            blocked: None,
        }
    }
    fn drive(&mut self) -> Result<(), String> {
        let Some(pending) = &mut self.pending else {
            return Ok(());
        };
        if self
            .sink
            .length()
            .map_err(|e| format!("receipt metadata: {e:?}"))?
            != self.length
        {
            self.blocked = Some("receipt length changed outside its sole publisher".into());
            return Err(self.blocked.clone().expect("set receipt failure"));
        }
        while pending.written < pending.bytes.len() {
            let count = self
                .sink
                .append(&pending.bytes[pending.written..])
                .map_err(|e| format!("receipt append: {e:?}"))?;
            if count == 0 {
                return Err("receipt append made no progress".into());
            }
            pending.written += count;
            self.length += count as u64;
        }
        self.sink
            .sync()
            .map_err(|e| format!("receipt fsync: {e:?}"))?;
        self.durable = Some(self.pending.take().expect("pending receipt").receipt);
        Ok(())
    }
    fn publish(&mut self, receipt: &Receipt) -> Result<(), String> {
        if let Some(error) = &self.blocked {
            return Err(error.clone());
        }
        // Complete the same bytes after a partial write/fsync error. Never append
        // a different JSON record behind an unterminated or unsynced record.
        self.drive()?;
        if let Some(old) = &self.durable
            && old.terminal()
        {
            return if same_record(old, receipt) {
                Ok(())
            } else {
                Err("a terminal custody record is already durable".into())
            };
        }
        if self
            .durable
            .as_ref()
            .is_some_and(|old| same_record(old, receipt))
        {
            return Ok(());
        }
        let mut receipt = receipt.clone();
        receipt.sequence = self.durable.as_ref().map_or(1, |old| old.sequence + 1);
        let mut bytes = serde_json::to_vec(&receipt).map_err(|e| format!("receipt encode: {e}"))?;
        bytes.push(b'\n');
        if self.length + bytes.len() as u64 > MAX_JOURNAL {
            self.blocked =
                Some("custody journal reached its 1MiB bound; completion unconfirmed".into());
            return Err(self.blocked.clone().expect("set receipt limit"));
        }
        self.pending = Some(Publication {
            receipt,
            bytes,
            written: 0,
        });
        self.drive()
    }

    fn terminal_candidate(&self) -> Option<Receipt> {
        self.pending
            .as_ref()
            .map(|pending| &pending.receipt)
            .filter(|row| row.terminal())
            .or_else(|| self.durable.as_ref().filter(|row| row.terminal()))
            .cloned()
    }
}

#[derive(Default)]
struct Queue {
    bytes: VecDeque<u8>,
    accepted: u64,
    delivered: u64,
    discarded: u64,
}
impl Queue {
    fn capacity(&self) -> usize {
        CHANNEL_LIMIT - self.bytes.len()
    }
    fn push(&mut self, bytes: &[u8]) {
        assert!(bytes.len() <= self.capacity());
        self.bytes.extend(bytes);
        self.accepted += bytes.len() as u64;
    }
    fn consume(&mut self, count: usize) {
        self.bytes.drain(..count);
        self.delivered += count as u64;
    }
    fn discard(&mut self) {
        self.discarded += self.bytes.len() as u64;
        self.bytes.clear();
    }
    fn accounted(&self) -> bool {
        self.accepted == self.delivered + self.discarded + self.bytes.len() as u64
    }
}

fn read_channel(fd: RawFd, queue: &mut Queue) -> io::Result<bool> {
    let mut buffer = [0u8; 8192];
    let limit = buffer.len().min(queue.capacity());
    if limit == 0 {
        return Ok(false);
    }
    let n = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), limit) };
    if n == 0 {
        return Ok(true);
    }
    if n < 0 {
        let error = io::Error::last_os_error();
        return if matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            Ok(false)
        } else {
            Err(error)
        };
    }
    queue.push(&buffer[..n as usize]);
    Ok(false)
}
fn write_channel(fd: RawFd, queue: &mut Queue) -> io::Result<()> {
    let bytes = queue.bytes.as_slices().0;
    if bytes.is_empty() {
        return Ok(());
    }
    let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
    if n < 0 {
        let error = io::Error::last_os_error();
        return if matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            Ok(())
        } else {
            Err(error)
        };
    }
    if n == 0 {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "proxy write made no progress",
        ));
    }
    queue.consume(n as usize);
    Ok(())
}

trait CleanupOps {
    fn stop(&mut self) -> Result<GroupStop, StopError>;
    fn settlement(&mut self) -> Result<GroupSettlement, SettlementError>;
    fn reap(&mut self) -> io::Result<Option<ExitStatus>>;
}
impl CleanupOps for Child {
    fn stop(&mut self) -> Result<GroupStop, StopError> {
        stop_before_reap(self)
    }
    fn settlement(&mut self) -> Result<GroupSettlement, SettlementError> {
        settlement_before_reap(self)
    }
    fn reap(&mut self) -> io::Result<Option<ExitStatus>> {
        self.try_wait()
    }
}
#[derive(Default)]
struct Cleanup {
    stop: Option<Result<GroupStop, StopError>>,
    settlement: Option<Result<GroupSettlement, SettlementError>>,
    exit: Option<i32>,
    error: Option<String>,
    retry_stop: bool,
}
impl Cleanup {
    fn retry(&mut self) {
        if self.exit.is_none() {
            self.retry_stop = true;
        }
    }
    fn step(&mut self, ops: &mut impl CleanupOps) {
        if self.exit.is_some() {
            return;
        }
        if self.retry_stop || !matches!(self.stop, Some(Ok(_))) {
            self.retry_stop = false;
            self.stop = Some(ops.stop());
            if let Some(Err(error)) = &self.stop {
                self.error = Some(error.to_string());
                return;
            }
        }
        self.settlement = Some(ops.settlement());
        match &self.settlement {
            Some(Ok(GroupSettlement::Exited { .. })) => match ops.reap() {
                Ok(Some(status)) => {
                    self.exit = Some(status.into_raw());
                    self.error = None;
                }
                Ok(None) => {
                    self.error =
                        Some("exited group observed but direct-child reap is pending".into())
                }
                Err(error) => self.error = Some(format!("engine reap: {error:?}")),
            },
            Some(Err(error)) => self.error = Some(error.to_string()),
            _ => self.error = None,
        }
    }
}

fn receipt(config: &Configuration, state: ReceiptState, node_pid: Option<u32>) -> Receipt {
    Receipt {
        schema: RECEIPT_SCHEMA.into(),
        invocation_id: config.invocation_id.clone(),
        runtime_digest: config.runtime_digest.clone(),
        sequence: 0,
        custodian_pid: std::process::id(),
        node_pid,
        state,
        reason: None,
        stop: None,
        settlement: None,
        child_exit_raw: None,
        stdout_eof: state == ReceiptState::NoChild,
        stderr_eof: state == ReceiptState::NoChild,
        stdout_bytes: 0,
        stderr_bytes: 0,
        output_discarded: false,
        frontend_output_errno: None,
        error: None,
    }
}
fn same_transition(a: &Receipt, b: &Receipt) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.stdout_bytes = 0;
    a.stderr_bytes = 0;
    b.stdout_bytes = 0;
    b.stderr_bytes = 0;
    same_record(&a, &b)
}
fn control_reason(bytes: &[u8]) -> &'static str {
    if bytes.is_empty() {
        "frontend_gone"
    } else if bytes.iter().all(|&b| b == b'S') {
        "stop_requested"
    } else {
        "invalid_control"
    }
}
#[derive(Default)]
struct ControlLiveness {
    lost: bool,
}
impl ControlLiveness {
    fn observe(&mut self, result: &Result<Option<&str>, String>) {
        if matches!(result, Ok(Some("frontend_gone")) | Err(_)) {
            self.lost = true;
        }
    }
    fn poll_descriptor(&self, fd: RawFd) -> Option<libc::pollfd> {
        (!self.lost).then_some(libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
    }
}
fn input_drained(eof: bool, queue: &Queue) -> bool {
    eof && queue.bytes.is_empty()
}
fn cleanup_complete(
    cleanup: &Cleanup,
    row: &Receipt,
    input: &Queue,
    out: &Queue,
    err: &Queue,
) -> bool {
    cleanup.exit.is_some()
        && matches!(cleanup.stop, Some(Ok(_)))
        && matches!(cleanup.settlement, Some(Ok(GroupSettlement::Exited { .. })))
        && row.stdout_eof
        && row.stderr_eof
        && [input, out, err]
            .iter()
            .all(|queue| queue.bytes.is_empty() && queue.accounted())
}
fn control(stream: &mut UnixStream) -> Result<Option<&'static str>, String> {
    let mut bytes = [0u8; 32];
    match stream.read(&mut bytes) {
        Ok(n) => Ok(Some(control_reason(&bytes[..n]))),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(format!("custodian control: {error:?}")),
    }
}

pub(crate) fn run(config_fd: RawFd) -> Result<(), String> {
    let WorkerInput {
        configuration,
        control: mut connection,
        receipt: file,
        render,
    } = worker_input(config_fd)?;
    if !cfg!(target_os = "macos") {
        return Err("engine custodian group settlement is unsupported on this platform".into());
    }
    signals()?;
    nonblocking(connection.as_raw_fd()).map_err(|e| format!("control nonblocking: {e:?}"))?;
    for fd in [0, 1, 2] {
        nonblocking(fd).map_err(|e| format!("proxy nonblocking: {e:?}"))?;
    }
    let mut journal = Journal::new(file);
    if let Some(reason) = control(&mut connection)? {
        let mut no_child = receipt(&configuration, ReceiptState::NoChild, None);
        no_child.reason = Some(reason.into());
        journal.publish(&no_child)?;
        return Ok(());
    }
    if SIGNAL.load(Ordering::Relaxed) != 0 {
        let mut no_child = receipt(&configuration, ReceiptState::NoChild, None);
        no_child.reason = Some("signal_before_spawn".into());
        journal.publish(&no_child)?;
        return Ok(());
    }
    let sources = render
        .as_ref()
        .map(|fds| fds.each_ref().map(AsRawFd::as_raw_fd));
    let mut command = Command::new(&configuration.node);
    command
        .arg(&configuration.engine)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    remove_preloads(&mut command);
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            if let Some(sources) = sources {
                for (source, target) in sources.into_iter().zip([3, 4, 5]) {
                    if libc::dup2(source, target) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
            }
            Ok(())
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let mut no_child = receipt(&configuration, ReceiptState::NoChild, None);
            no_child.reason = Some("spawn_failed".into());
            no_child.error = Some(format!("engine spawn: {error:?}"));
            journal.publish(&no_child)?;
            return Ok(());
        }
    };
    // From this point no error returns or Drop-based cleanup are permitted.
    // This worker retains the exact created Child across every failed attempt.
    drop(render);
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_fd = stdout.as_ref().map(AsRawFd::as_raw_fd);
    let err_fd = stderr.as_ref().map(AsRawFd::as_raw_fd);
    let mut row = receipt(&configuration, ReceiptState::Started, Some(child.id()));
    let mut reason = None;
    let mut failure = None;
    if let Some(pipe) = &stdin
        && let Err(error) = nonblocking(pipe.as_raw_fd())
    {
        reason = Some("pipe_configuration".to_owned());
        failure = Some(format!("engine stdin: {error:?}"));
    }
    let mut out_ready = false;
    let mut err_ready = false;
    if stdin.is_none() || stdout.is_none() || stderr.is_none() {
        reason = Some("missing_engine_pipe".into());
        failure = Some("created engine pipe is missing; EOF cannot be assumed".into());
    }
    if let Err(error) = journal.publish(&row) {
        reason = Some("receipt_publication".into());
        failure = Some(error);
    }
    let mut input = Queue::default();
    let mut out = Queue::default();
    let mut err = Queue::default();
    let mut input_eof = false;
    let mut discard_output = reason.as_deref() == Some("receipt_publication");
    let mut cleanup = Cleanup::default();
    let mut attempt: Option<Instant> = None;
    let mut attempt_expired = false;
    let mut next_step = Instant::now();
    let mut last_pending: Option<Receipt> = None;
    let mut liveness = ControlLiveness::default();
    loop {
        for (pipe, ready) in [(out_fd, &mut out_ready), (err_fd, &mut err_ready)] {
            if !*ready && let Some(pipe) = pipe {
                match nonblocking(pipe) {
                    Ok(()) => *ready = true,
                    Err(error) => {
                        reason.get_or_insert_with(|| "pipe_configuration".into());
                        failure = Some(format!(
                            "engine output configuration: {error:?}; EOF unconfirmed"
                        ));
                    }
                }
            }
        }
        let signal = SIGNAL.load(Ordering::Relaxed);
        if signal != 0 && reason.is_none() {
            reason = Some(format!("signal_{signal}"));
        }
        let control_result = if liveness.lost {
            Ok(None)
        } else {
            control(&mut connection)
        };
        liveness.observe(&control_result);
        match control_result {
            Ok(Some(value)) => {
                if value == "frontend_gone" {
                    discard_output = true;
                }
                if reason.is_none() {
                    reason = Some(value.into());
                }
            }
            Err(error) => {
                discard_output = true;
                if reason.is_none() {
                    reason = Some("control_failure".into());
                }
                failure = Some(error);
            }
            _ => (),
        }
        if reason.is_none() {
            match settlement_before_reap(&child) {
                Ok(GroupSettlement::LeaderRunning) => (),
                observed => {
                    if let Err(error) = &observed {
                        cleanup.error = Some(error.to_string());
                    }
                    cleanup.settlement = Some(observed);
                    reason = Some("engine_exit_or_observation_failure".into());
                    // Publish this first observation before a later cleanup
                    // observation can replace it, including a transient error.
                    next_step = Instant::now() + TICK;
                }
            }
        }
        if reason.is_none() && !input_eof && input.capacity() > 0 {
            match read_channel(0, &mut input) {
                Ok(eof) => input_eof = eof,
                Err(error) => {
                    reason = Some("input_failure".into());
                    failure = Some(format!("frontend input: {error:?}"));
                }
            }
        }
        if reason.is_none() {
            if let Some(pipe) = &stdin
                && let Err(error) = write_channel(pipe.as_raw_fd(), &mut input)
            {
                reason = Some("engine_input_failure".into());
                failure = Some(format!("engine stdin: {error:?}"));
            }
            if input_drained(input_eof, &input) {
                stdin.take();
            }
        } else {
            stdin.take();
            input.discard();
        }
        if discard_output {
            out.discard();
            err.discard();
        }
        for (pipe, queue, eof, ready, label) in [
            (out_fd, &mut out, &mut row.stdout_eof, out_ready, "stdout"),
            (err_fd, &mut err, &mut row.stderr_eof, err_ready, "stderr"),
        ] {
            if ready
                && !*eof
                && queue.capacity() > 0
                && let Some(pipe) = pipe
            {
                match read_channel(pipe, queue) {
                    Ok(done) => *eof = done,
                    Err(error) => {
                        if reason.is_none() {
                            reason = Some("engine_output_failure".into());
                        }
                        failure = Some(format!("engine {label}: {error:?}; EOF unconfirmed"));
                    }
                }
            }
        }
        if discard_output {
            out.discard();
            err.discard();
        } else {
            for (fd, queue) in [(1, &mut out), (2, &mut err)] {
                if let Err(error) = write_channel(fd, queue) {
                    row.frontend_output_errno = error.raw_os_error();
                    discard_output = true;
                    if reason.is_none() {
                        reason = Some("output_failure".into());
                    }
                    failure = Some(format!("frontend output: {error:?}"));
                }
            }
            if discard_output {
                out.discard();
                err.discard();
            }
        }
        if reason.is_some() && cleanup.exit.is_none() && Instant::now() >= next_step {
            let started = *attempt.get_or_insert_with(Instant::now);
            cleanup.step(&mut child);
            if started.elapsed() >= CLEANUP_ATTEMPT {
                // An attempt deadline reports Pending; it never releases Child.
                // Retry/backoff is explicit process custody, not an unbounded Drop.
                cleanup.retry();
                attempt = Some(Instant::now());
                attempt_expired = true;
                next_step = Instant::now() + RETRY;
            } else {
                next_step = Instant::now() + TICK;
            }
        }
        row.reason = reason.clone();
        if attempt_expired && let Some(reason) = &mut row.reason {
            reason.push_str(";cleanup_attempt_budget_exceeded");
        }
        row.stop = cleanup.stop.clone();
        row.settlement = cleanup.settlement.clone();
        row.child_exit_raw = cleanup.exit;
        row.stdout_bytes = out.accepted;
        row.stderr_bytes = err.accepted;
        row.output_discarded = out.discarded > 0 || err.discarded > 0;
        row.error = cleanup.error.clone().or_else(|| failure.clone());
        let settled = cleanup_complete(&cleanup, &row, &input, &out, &err);
        if settled {
            if let Some(terminal) = journal.terminal_candidate() {
                // A terminal line can be partially written or awaiting fsync.
                // Resume it exactly; never append a Pending/duplicate terminal
                // behind it, and never resignal this already-reaped child.
                if journal.publish(&terminal).is_ok() {
                    return Ok(());
                }
            } else {
                let failures_retained = if row.error.is_some() {
                    row.state = ReceiptState::Pending;
                    match journal.publish(&row) {
                        Ok(()) => true,
                        Err(error) => {
                            failure = Some(error);
                            false
                        }
                    }
                } else {
                    true
                };
                // Earlier durable records preserve transport/cleanup failures. The
                // terminal record attests cleanup only, never successful delivery.
                if failures_retained {
                    row.state = ReceiptState::Complete;
                    row.error = None;
                    if row.terminal() {
                        match journal.publish(&row) {
                            Ok(()) => return Ok(()),
                            Err(error) => {
                                failure = Some(error);
                            }
                        }
                    } else {
                        failure = Some("terminal custody invariants were not satisfied".into());
                    }
                }
            }
        } else if reason.is_some() {
            row.state = ReceiptState::Pending;
            if last_pending
                .as_ref()
                .is_none_or(|old| !same_transition(old, &row))
            {
                match journal.publish(&row) {
                    Ok(()) => {
                        last_pending = Some(row.clone());
                    }
                    Err(error) => {
                        failure = Some(error);
                    }
                }
            }
        }
        let mut descriptors: Vec<_> = liveness
            .poll_descriptor(connection.as_raw_fd())
            .into_iter()
            .collect();
        if reason.is_none() && !input_eof && input.capacity() > 0 {
            descriptors.push(libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            });
        }
        if reason.is_none()
            && !input.bytes.is_empty()
            && let Some(pipe) = &stdin
        {
            descriptors.push(libc::pollfd {
                fd: pipe.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            });
        }
        for (pipe, queue, eof, ready) in [
            (out_fd, &out, row.stdout_eof, out_ready),
            (err_fd, &err, row.stderr_eof, err_ready),
        ] {
            if ready
                && !eof
                && queue.capacity() > 0
                && let Some(pipe) = pipe
            {
                descriptors.push(libc::pollfd {
                    fd: pipe,
                    events: libc::POLLIN,
                    revents: 0,
                });
            }
        }
        if !discard_output {
            for (fd, queue) in [(1, &out), (2, &err)] {
                if !queue.bytes.is_empty() {
                    descriptors.push(libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    });
                }
            }
        }
        let result = unsafe {
            libc::poll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                TICK.as_millis() as i32,
            )
        };
        if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            reason.get_or_insert_with(|| "poll_failure".into());
            failure = Some(format!("custodian poll: {:?}", io::Error::last_os_error()));
        }
        // HUP and persistent errors are level-triggered. A fixed sleep bounds
        // retry CPU even when the frontend has permanently disconnected.
        if reason.is_some() {
            std::thread::sleep(TICK);
        }
    }
}

#[cfg(test)]
mod tests;
