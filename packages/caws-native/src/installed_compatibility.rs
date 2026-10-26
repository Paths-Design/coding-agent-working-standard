//! Compatibility custody for an already admitted installed-entry command.
//!
//! The single-threaded installed entry forks before starting any threads. The
//! fork copies the prepared Command and opaque deadline; no wire or environment
//! can replace either. Only the foreground parent writes harness stdout/stderr.
//! The worker retains its actual Child while cleanup or pipe EOF is uncertain.
//! This is private-process-group custody, not an escaped-descendant census.
use caws_native::monotonic_deadline::MonotonicDeadline;
use caws_native::owned_group::{GroupSettlement, settlement_before_reap, stop_before_reap};
use std::{
    collections::VecDeque,
    io,
    os::{
        fd::{AsRawFd, RawFd},
        unix::{
            net::UnixStream,
            process::{CommandExt, ExitStatusExt},
        },
    },
    panic::{AssertUnwindSafe, catch_unwind},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicI32, Ordering},
    time::{Duration, Instant},
};

const QUEUE_LIMIT: usize = 65_536;
const CHUNK: usize = 8192;
const TICK_MS: i32 = 10;
const MAX_ORIGINAL_NS: u64 = 30_000_000_000;
const RETRY: Duration = Duration::from_millis(50);
const SPAWNED: u8 = 1;
const NO_CHILD: u8 = 2;
const NATURAL: u8 = 3;
const STOPPED: u8 = 4;
const UNCERTAIN: u8 = 5;
const SIGNALLED: u8 = 6;
// Private stop request; unlike control EOF, this preserves status delivery.
const CANCEL: u8 = 1;
// Darwin has signals 1..31; stopped/continued statuses are never terminal.
const MAX_SIGNAL: u32 = 31;
const PACKET: usize = 5;
const MANAGED_SIGNALS: [i32; 5] = [
    libc::SIGTERM,
    libc::SIGINT,
    libc::SIGHUP,
    libc::SIGPIPE,
    libc::SIGCHLD,
];
// This caps inventory memory/work, not the numeric value of an inherited fd.
// An over-cap inventory refuses dispatch and exits the worker before any child.
const MAX_FD_ENTRIES: usize = 65_536;
static SIGNAL: AtomicI32 = AtomicI32::new(0);

extern "C" fn interrupted(signal: libc::c_int) {
    SIGNAL.store(signal, Ordering::Relaxed);
}

struct Signals {
    actions: Vec<(i32, libc::sigaction)>,
    original_mask: libc::sigset_t,
}
impl Signals {
    fn install() -> io::Result<Self> {
        SIGNAL.store(0, Ordering::Relaxed);
        let mut original_mask = unsafe { std::mem::zeroed() };
        // pthread_sigmask returns its error directly, rather than through errno.
        let result = unsafe {
            libc::pthread_sigmask(libc::SIG_SETMASK, std::ptr::null(), &mut original_mask)
        };
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        let mut installed = Self {
            actions: Vec::new(),
            original_mask,
        };
        let mut managed = unsafe { std::mem::zeroed() };
        unsafe { libc::sigemptyset(&mut managed) };
        for signal in MANAGED_SIGNALS {
            if unsafe { libc::sigaddset(&mut managed, signal) } != 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: both structures are initialized for sigaction. The handler
            // performs only an atomic store; installation precedes the fork.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            // Clear inherited SA_NOCLDWAIT and handlers that could reap the child.
            action.sa_sigaction = if signal == libc::SIGCHLD {
                libc::SIG_DFL
            } else {
                interrupted as *const () as usize
            };
            unsafe { libc::sigemptyset(&mut action.sa_mask) };
            if unsafe { libc::sigaction(signal, &action, &mut previous) } != 0 {
                return Err(io::Error::last_os_error());
            }
            installed.actions.push((signal, previous));
        }
        // An inherited blocked TERM/INT/HUP/PIPE must not defeat cancellation;
        // CHLD is also unblocked without changing any unrelated signal's mask.
        let result =
            unsafe { libc::pthread_sigmask(libc::SIG_UNBLOCK, &managed, std::ptr::null_mut()) };
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        Ok(installed)
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        // Reblock signals the caller had blocked before restoring its actions.
        unsafe {
            libc::pthread_sigmask(libc::SIG_SETMASK, &self.original_mask, std::ptr::null_mut())
        };
        for (signal, action) in self.actions.iter().rev() {
            // SAFETY: restore the actions returned by successful installation.
            unsafe { libc::sigaction(*signal, action, std::ptr::null_mut()) };
        }
    }
}

struct Flags {
    fd: RawFd,
    old: i32,
}
impl Flags {
    fn set(fd: RawFd) -> io::Result<Self> {
        // SAFETY: borrowed descriptor, no pointer arguments.
        let old = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if old < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, old | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { fd, old })
    }
}
impl Drop for Flags {
    fn drop(&mut self) {
        // SAFETY: the borrowed host descriptor remains live until this guard drops.
        unsafe { libc::fcntl(self.fd, libc::F_SETFL, self.old) };
    }
}

#[derive(Default)]
struct Queue(VecDeque<u8>);
impl Queue {
    fn empty(&self) -> bool {
        self.0.is_empty()
    }
    fn space(&self) -> usize {
        QUEUE_LIMIT - self.0.len()
    }
    fn discard(&mut self) {
        self.0.clear();
    }
    fn read(&mut self, fd: RawFd) -> io::Result<bool> {
        let mut bytes = [0u8; CHUNK];
        let limit = bytes.len().min(self.space());
        if limit == 0 {
            return Ok(false);
        }
        // SAFETY: buffer is writable for limit bytes and fd is live/nonblocking.
        let n = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), limit) };
        if n < 0 {
            let error = io::Error::last_os_error();
            return if transient(&error) {
                Ok(false)
            } else {
                Err(error)
            };
        }
        self.0.extend(&bytes[..n as usize]);
        Ok(n == 0)
    }
    fn write(&mut self, fd: RawFd) -> io::Result<()> {
        let bytes = self.0.as_slices().0;
        if bytes.is_empty() {
            return Ok(());
        }
        let bytes = &bytes[..bytes.len().min(CHUNK)];
        // SAFETY: buffer is readable and fd is live/nonblocking.
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if n < 0 {
            let error = io::Error::last_os_error();
            return if transient(&error) {
                Ok(())
            } else {
                Err(error)
            };
        }
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "no output progress",
            ));
        }
        self.0.drain(..n as usize);
        Ok(())
    }
    fn packet(&mut self, kind: u8, value: u32) {
        self.0.push_back(kind);
        self.0.extend(value.to_be_bytes());
    }
}
fn transient(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}
pub(crate) fn failure_status(event: &str) -> u8 {
    match event {
        "post_tool_use" | "session_start" | "stop" | "pre_compact" | "session_end" => 0,
        // "describe" is an internal policy marker, never a child argv change.
        _ => 2,
    }
}
fn policy(event: &str) -> u8 {
    failure_status(event)
}
/// Earlier operational cutoffs, never replacement deadline authority. Both
/// retained clocks must remain live at every foreground/effect boundary.
struct CompatibilityBudget<'a> {
    original: &'a MonotonicDeadline,
    policy: Option<&'a MonotonicDeadline>,
    execution_end: Option<Instant>,
    foreground_end: Instant,
}
impl<'a> CompatibilityBudget<'a> {
    fn new(
        original: &'a MonotonicDeadline,
        policy: Option<&'a MonotonicDeadline>,
    ) -> io::Result<Self> {
        let outer = original.envelope();
        let interval = outer
            .expires_ns
            .checked_sub(outer.started_ns)
            .filter(|interval| *interval > 0 && *interval <= MAX_ORIGINAL_NS)
            .ok_or_else(|| io::Error::other("invalid original compatibility interval"))?;
        let (interval, expires) = if let Some(policy) = policy {
            let selected = policy.envelope();
            if selected.started_ns != outer.started_ns || selected.expires_ns > outer.expires_ns {
                return Err(io::Error::other(
                    "compatibility policy is not an original restriction",
                ));
            }
            let selected_interval = selected
                .expires_ns
                .checked_sub(selected.started_ns)
                .filter(|interval| *interval > 0)
                .ok_or_else(|| io::Error::other("invalid compatibility policy interval"))?;
            (selected_interval, original.expires().min(policy.expires()))
        } else {
            (interval, original.expires())
        };
        let duration = Duration::from_nanos(interval);
        // Stop/EOF/status observation and residual host delivery run concurrently.
        // Existing 500ms cleanup/delivery and 100ms diagnostic ceilings are caps,
        // not promises that kernel operations complete inside these allocations.
        let terminal = (duration / 4).clamp(Duration::from_millis(1), Duration::from_millis(500));
        let returning = (duration / 8).clamp(Duration::from_millis(1), Duration::from_millis(100));
        let foreground_end = expires
            .checked_sub(returning)
            .ok_or_else(|| io::Error::other("compatibility foreground cutoff underflow"))?;
        let reserved = terminal
            .checked_add(returning)
            .ok_or_else(|| io::Error::other("compatibility reserve overflow"))?;
        let execution_end = if reserved < duration {
            Some(
                expires
                    .checked_sub(reserved)
                    .ok_or_else(|| io::Error::other("compatibility execution cutoff underflow"))?,
            )
        } else {
            // A valid short interval can have no dispatch phase. Never replace
            // it with a new clock or spawn merely to report its exhaustion.
            None
        };
        Ok(Self {
            original,
            policy,
            execution_end,
            foreground_end,
        })
    }
    fn clocks_live(&self) -> bool {
        self.original.check().is_ok() && self.policy.is_none_or(|clock| clock.check().is_ok())
    }
    fn execution_allowed(&self) -> bool {
        self.clocks_live() && self.execution_end.is_some_and(|end| Instant::now() < end)
    }
    fn execution_check(&self) -> io::Result<()> {
        if self.execution_allowed() {
            Ok(())
        } else {
            Err(io::Error::other(
                "compatibility execution phase unavailable",
            ))
        }
    }
    fn foreground_allowed(&self) -> bool {
        self.clocks_live() && Instant::now() < self.foreground_end
    }
}
fn allowed(budget: &CompatibilityBudget<'_>) -> bool {
    budget.foreground_allowed()
}
fn check(budget: &CompatibilityBudget<'_>) -> io::Result<()> {
    if allowed(budget) {
        Ok(())
    } else {
        Err(io::Error::other(
            "compatibility foreground deadline invalid or expired",
        ))
    }
}
fn interests(fds: &mut Vec<libc::pollfd>, fd: RawFd, events: i16) {
    fds.push(libc::pollfd {
        fd,
        events,
        revents: 0,
    });
}
fn poll(fds: &mut [libc::pollfd], deadline: Option<&CompatibilityBudget<'_>>) -> io::Result<()> {
    let timeout = if let Some(deadline) = deadline {
        check(deadline)?;
        let now = Instant::now();
        let next = deadline
            .execution_end
            .filter(|end| now < *end)
            .map_or(deadline.foreground_end, |end| {
                end.min(deadline.foreground_end)
            });
        next.saturating_duration_since(now)
            .as_millis()
            .min(TICK_MS as u128) as i32
    } else {
        TICK_MS
    };
    // SAFETY: fds points to the initialized writable slice for this call.
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    if let Some(deadline) = deadline {
        check(deadline)?;
    }
    Ok(())
}

fn emit(fd: RawFd, bytes: &[u8], deadline: Option<&CompatibilityBudget<'_>>) {
    let Ok(_flags) = Flags::set(fd) else {
        return;
    };
    let mut offset = 0;
    loop {
        if deadline.is_some_and(|clock| !allowed(clock)) {
            return;
        }
        // With no usable clock, one nonblocking attempt is the entire allowance.
        let part = &bytes[offset..bytes.len().min(offset + CHUNK)];
        if part.is_empty() {
            return;
        }
        let n = unsafe { libc::write(fd, part.as_ptr().cast(), part.len()) };
        if n > 0 {
            offset += n as usize;
        } else if n == 0 || !transient(&io::Error::last_os_error()) {
            return;
        }
        if offset == bytes.len() || deadline.is_none() {
            return;
        }
        let mut fds = [libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        }];
        if poll(&mut fds, deadline).is_err() {
            return;
        }
    }
}

/// Configuration failure before any compatibility child can have been spawned.
/// A missing/expired clock never mints a delivery grace period. Only PreToolUse
/// may receive a synthesized block, and all writes are best effort/nonblocking.
pub(crate) fn refuse_before_dispatch(
    event: &str,
    error: &str,
    original: Option<&MonotonicDeadline>,
    policy_deadline: Option<&MonotonicDeadline>,
) -> u8 {
    let budget = match original {
        Some(original) => match CompatibilityBudget::new(original, policy_deadline) {
            Ok(budget) if budget.foreground_allowed() => Some(budget),
            _ => return policy(event),
        },
        None if policy_deadline.is_none() => None,
        None => return policy(event),
    };
    let deadline = budget.as_ref();
    let Ok(_signals) = Signals::install() else {
        return policy(event);
    };
    let message = format!(
        "CAWS native installed entry: {}",
        error.chars().take(512).collect::<String>()
    );
    if event == "pre_tool_use" {
        let mut json =
            serde_json::to_vec(&serde_json::json!({"decision":"block", "reason":message}))
                .unwrap_or_default();
        json.push(b'\n');
        emit(1, &json, deadline);
    }
    emit(2, format!("[{message}]\n").as_bytes(), deadline);
    policy(event)
}
fn incomplete(deadline: &CompatibilityBudget<'_>, reason: &str) {
    let bytes = format!("[CAWS native installed entry: delivery incomplete; {reason}]\n");
    emit_incomplete(2, bytes.as_bytes(), deadline);
}

fn emit_incomplete(fd: RawFd, bytes: &[u8], deadline: &CompatibilityBudget<'_>) {
    if !allowed(deadline) {
        return;
    }
    let Ok(_flags) = Flags::set(fd) else {
        return;
    };
    // This is an operational cap inside both retained clocks, never a new
    // deadline or permission to write after the foreground phase. A full host
    // pipe may recover after its last payload chunk; allow that bounded retry.
    let until = Instant::now()
        .checked_add(Duration::from_millis(100))
        .unwrap_or(deadline.foreground_end)
        .min(deadline.foreground_end)
        .min(deadline.original.expires());
    let mut offset = 0;
    while offset < bytes.len() && allowed(deadline) && Instant::now() < until {
        let part = &bytes[offset..bytes.len().min(offset + CHUNK)];
        let n = unsafe { libc::write(fd, part.as_ptr().cast(), part.len()) };
        if n > 0 {
            offset += n as usize;
        } else if n == 0 || !transient(&io::Error::last_os_error()) {
            return;
        }
        if offset == bytes.len() || !allowed(deadline) || Instant::now() >= until {
            return;
        }
        let mut fds = [libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        }];
        let timeout = until
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(TICK_MS as u128) as i32;
        if unsafe { libc::poll(fds.as_mut_ptr(), 1, timeout) } < 0
            && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
        {
            return;
        }
        // The loop checks both original/policy clocks and the earlier cap after
        // every poll, including EINTR, before another nonblocking write.
    }
}

struct Channels {
    control: UnixStream,
    input: UnixStream,
    output: UnixStream,
    error: UnixStream,
    status: UnixStream,
}
fn channels() -> io::Result<(Channels, Channels)> {
    let (a, b) = UnixStream::pair()?;
    let (c, d) = UnixStream::pair()?;
    let (e, f) = UnixStream::pair()?;
    let (g, h) = UnixStream::pair()?;
    let (i, j) = UnixStream::pair()?;
    let pair = (
        Channels {
            control: a,
            input: c,
            output: e,
            error: g,
            status: i,
        },
        Channels {
            control: b,
            input: d,
            output: f,
            error: h,
            status: j,
        },
    );
    for side in [&pair.0, &pair.1] {
        for stream in [
            &side.control,
            &side.input,
            &side.output,
            &side.error,
            &side.status,
        ] {
            stream.set_nonblocking(true)?;
            let fd = stream.as_raw_fd();
            let old = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if old < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, old | libc::FD_CLOEXEC) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(pair)
}
fn output_closed(fd: RawFd) -> bool {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, metadata.as_mut_ptr()) } != 0 {
        return true;
    }
    let mode = unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT;
    if mode != libc::S_IFIFO && mode != libc::S_IFSOCK {
        return false;
    }
    let mut fds = [libc::pollfd {
        fd,
        events: libc::POLLOUT,
        revents: 0,
    }];
    (unsafe { libc::poll(fds.as_mut_ptr(), 1, 0) }) > 0
        && fds[0].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0
}
fn reap_worker(pid: libc::pid_t) {
    // Never wait for custody to finish. The worker survives foreground exit.
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
}

/// Consume an admitted command without changing its argv, cwd or environment.
/// macOS is required for owned-group settlement. The caller must remain single
/// threaded through this fork. Returns independently of unresolved worker cleanup.
pub(crate) fn run(
    mut command: Command,
    original: &MonotonicDeadline,
    policy_deadline: Option<&MonotonicDeadline>,
    event: &str,
) -> u8 {
    let budget = match CompatibilityBudget::new(original, policy_deadline) {
        Ok(budget) => budget,
        Err(_) => return policy(event),
    };
    let deadline = &budget;
    // A consumed/insufficient execution phase is status-only, even if a small
    // foreground remainder exists. Never fork merely to report this failure.
    if !deadline.execution_allowed() {
        return policy(event);
    }
    if !cfg!(target_os = "macos") {
        return refuse_before_dispatch(
            event,
            "Compatibility custody requires macOS group settlement",
            Some(original),
            policy_deadline,
        );
    }
    let signals = match Signals::install() {
        Ok(signals) => signals,
        Err(_) => {
            return refuse_before_dispatch(
                event,
                "Compatibility signal configuration failed",
                Some(original),
                policy_deadline,
            );
        }
    };
    // Reserve the host stdio slots before creating private descriptors. A closed
    // host slot must not be reused as an IPC socket and then mistaken for stdin
    // or an output channel by the foreground pump.
    if [0, 1, 2]
        .into_iter()
        .any(|fd| unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0)
    {
        return refuse_before_dispatch(
            event,
            "Compatibility host stdio descriptor unavailable",
            Some(original),
            policy_deadline,
        );
    }
    let (foreground, worker) = match channels() {
        Ok(pair) => pair,
        Err(_) => {
            return refuse_before_dispatch(
                event,
                "Compatibility private channels unavailable",
                Some(original),
                policy_deadline,
            );
        }
    };
    if !deadline.execution_allowed() {
        return policy(event);
    }
    let original_parent = unsafe { libc::getppid() };
    // SAFETY: this entry has started no threads. The child uses only its copied
    // command/clock and terminates with _exit, never returning to the caller.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return refuse_before_dispatch(
            event,
            "Compatibility worker fork failed",
            Some(original),
            policy_deadline,
        );
    }
    if pid == 0 {
        // Close host stdio before any fallible setup or Rust cleanup. A worker
        // paused before these first operations remains an explicit fork-boundary
        // limitation; post-isolation uncertainty cannot retain host output.
        unsafe {
            libc::close(0);
            libc::close(1);
            libc::close(2);
        }
        drop(foreground);
        worker_main(&mut command, deadline, worker);
    }
    drop(worker);
    let result = foreground_main(foreground, deadline, event, original_parent);
    reap_worker(pid);
    drop(signals);
    result
}

fn foreground_main(
    channels: Channels,
    deadline: &CompatibilityBudget<'_>,
    event: &str,
    original_parent: i32,
) -> u8 {
    let _flags = match [0, 1, 2]
        .map(Flags::set)
        .into_iter()
        .collect::<io::Result<Vec<_>>>()
    {
        Ok(flags) => flags,
        Err(_) => {
            return foreground_failure(
                &channels,
                deadline,
                event,
                "host descriptor configuration failed; worker custody unconfirmed",
            );
        }
    };
    let mut input = Queue::default();
    let mut output = Queue::default();
    let mut error = Queue::default();
    let mut status = Queue::default();
    let mut input_eof = false;
    let mut input_open = true;
    let mut output_eof = false;
    let mut error_eof = false;
    let mut status_eof = false;
    let mut spawned = false;
    let mut terminal = None;
    let mut failure: Option<String> = None;
    let mut cancel_sent = false;
    // Description inspects selection without consuming the caller's input.
    // Keep the private child input channel open until completion or cancellation.
    let forward_input = event != "describe";
    loop {
        if !allowed(deadline) {
            return foreground_failure(
                &channels,
                deadline,
                event,
                "foreground cutoff reached; cleanup unconfirmed",
            );
        }
        let signal = SIGNAL.load(Ordering::Relaxed);
        if signal != 0 && failure.is_none() {
            failure = Some(format!("caller interrupted; raw signal {signal}"));
        }
        if (original_parent > 1 && unsafe { libc::getppid() } != original_parent)
            || output_closed(1)
        {
            failure.get_or_insert_with(|| "caller cancelled".into());
        }
        if terminal.is_none() && !deadline.execution_allowed() && failure.is_none() {
            failure = Some("compatibility execution cutoff reached".into());
        }
        if failure.is_some() || terminal.is_some() {
            if failure.is_some() && !cancel_sent {
                cancel_sent = request_cancel(&channels);
            }
            input.discard();
            if input_open {
                let _ = channels.input.shutdown(std::net::Shutdown::Write);
                input_open = false;
            }
        }
        let operation = (|| -> io::Result<()> {
            check(deadline)?;
            if failure.is_none() && forward_input && !input_eof && input_open && input.space() > 0 {
                deadline.execution_check()?;
                input_eof = input.read(0)?;
            }
            check(deadline)?;
            if input_open && !input.empty() {
                deadline.execution_check()?;
                if let Err(issue) = input.write(channels.input.as_raw_fd()) {
                    if matches!(
                        issue.kind(),
                        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                    ) {
                        input.discard();
                        input_open = false;
                    } else {
                        return Err(issue);
                    }
                }
            }
            if input_open && input_eof && input.empty() {
                channels.input.shutdown(std::net::Shutdown::Write)?;
                input_open = false;
            }
            check(deadline)?;
            if !output_eof && output.space() > 0 {
                output_eof = output.read(channels.output.as_raw_fd())?;
            }
            check(deadline)?;
            if !error_eof && error.space() > 0 {
                error_eof = error.read(channels.error.as_raw_fd())?;
            }
            check(deadline)?;
            if !status_eof {
                status_eof = status.read(channels.status.as_raw_fd())?;
            }
            if status.0.len() > 4 * PACKET {
                return Err(io::Error::other("invalid worker status bound"));
            }
            while status.0.len() >= PACKET {
                let kind = status.0.pop_front().expect("complete packet");
                let mut value = [0; 4];
                for byte in &mut value {
                    *byte = status.0.pop_front().expect("complete packet");
                }
                let value = u32::from_be_bytes(value);
                match kind {
                    SPAWNED if !spawned && terminal.is_none() && value > 1 => spawned = true,
                    NO_CHILD if !spawned && terminal.is_none() && value == 0 => {
                        terminal = Some((NO_CHILD, 0))
                    }
                    NATURAL if spawned && terminal.is_none() && value <= 255 => {
                        terminal = Some((NATURAL, value))
                    }
                    SIGNALLED
                        if spawned && terminal.is_none() && (1..=MAX_SIGNAL).contains(&value) =>
                    {
                        terminal = Some((SIGNALLED, value));
                    }
                    STOPPED if spawned && terminal.is_none() && value == 0 => {
                        terminal = Some((STOPPED, 0))
                    }
                    UNCERTAIN if spawned && value == 0 => {
                        return Err(io::Error::other("worker cleanup unconfirmed"));
                    }
                    _ => return Err(io::Error::other("invalid worker status transition")),
                }
            }
            check(deadline)?;
            output.write(1)?;
            check(deadline)?;
            error.write(2)?;
            check(deadline)?;
            Ok(())
        })();
        if operation.is_err() {
            let reason = if let Some((SIGNALLED, signal)) = terminal {
                let child = format!("compatibility child interrupted; raw signal {signal}");
                failure
                    .as_ref()
                    .map_or(child.clone(), |reason| format!("{reason}; {child}"))
            } else {
                failure
                    .clone()
                    .unwrap_or_else(|| "compatibility transport or cleanup unconfirmed".into())
            };
            return foreground_failure(&channels, deadline, event, &reason);
        }
        if let Some((NO_CHILD, _)) = terminal {
            return refuse_before_dispatch(
                event,
                "Compatibility worker failed before child creation",
                Some(deadline.original),
                deadline.policy,
            );
        }
        if output_eof && error_eof && output.empty() && error.empty() {
            if let Some((SIGNALLED, signal)) = terminal {
                let child = format!("compatibility child interrupted; raw signal {signal}");
                let reason = failure
                    .as_ref()
                    .map_or(child.clone(), |reason| format!("{reason}; {child}"));
                incomplete(deadline, &reason);
                return policy(event);
            }
            if let Some((NATURAL, code)) = terminal {
                if let Some(reason) = failure {
                    incomplete(deadline, &reason);
                    return policy(event);
                }
                return code as u8;
            }
            if let Some((STOPPED, _)) = terminal {
                incomplete(
                    deadline,
                    failure
                        .as_deref()
                        .unwrap_or("compatibility execution stopped"),
                );
                return policy(event);
            }
        }
        if status_eof && (terminal.is_none() || !status.empty()) {
            return foreground_failure(
                &channels,
                deadline,
                event,
                "worker exited without terminal custody observation",
            );
        }
        let mut fds = Vec::with_capacity(6);
        if failure.is_none() && forward_input && !input_eof && input_open && input.space() > 0 {
            interests(&mut fds, 0, libc::POLLIN);
        }
        if input_open && !input.empty() {
            interests(&mut fds, channels.input.as_raw_fd(), libc::POLLOUT);
        }
        if !output_eof && output.space() > 0 {
            interests(&mut fds, channels.output.as_raw_fd(), libc::POLLIN);
        }
        if !error_eof && error.space() > 0 {
            interests(&mut fds, channels.error.as_raw_fd(), libc::POLLIN);
        }
        if !status_eof {
            interests(&mut fds, channels.status.as_raw_fd(), libc::POLLIN);
        }
        if !output.empty() {
            interests(&mut fds, 1, libc::POLLOUT);
        }
        if !error.empty() {
            interests(&mut fds, 2, libc::POLLOUT);
        }
        if poll(&mut fds, Some(deadline)).is_err() {
            return foreground_failure(
                &channels,
                deadline,
                event,
                "foreground poll or clock failed; cleanup unconfirmed",
            );
        }
    }
}

/// Request stopping without closing the independent terminal-status channel.
/// A transient full control socket is retried by the caller; permanent failure
/// falls back to EOF, which the worker treats as loss of its foreground owner.
fn request_cancel(channels: &Channels) -> bool {
    let byte = [CANCEL];
    let n = unsafe { libc::write(channels.control.as_raw_fd(), byte.as_ptr().cast(), 1) };
    if n == 1 {
        true
    } else if n < 0 && transient(&io::Error::last_os_error()) {
        false
    } else {
        let _ = channels.control.shutdown(std::net::Shutdown::Write);
        true
    }
}

fn foreground_failure(
    channels: &Channels,
    deadline: &CompatibilityBudget<'_>,
    event: &str,
    reason: &str,
) -> u8 {
    let mut cancelled = request_cancel(channels);
    let _ = channels.input.shutdown(std::net::Shutdown::Write);
    let mut status = Queue::default();
    // A failed host descriptor/transport cannot be used to deliver more output.
    // Drain only private sockets while the same foreground phase remains live.
    // These observations do not synthesize EOF or confer a successful result.
    while allowed(deadline) {
        if !cancelled {
            cancelled = request_cancel(channels);
        }
        for stream in [&channels.output, &channels.error] {
            let mut discarded = Queue::default();
            let _ = discarded.read(stream.as_raw_fd());
        }
        let status_eof = match status.read(channels.status.as_raw_fd()) {
            Ok(eof) => eof,
            Err(_) => break,
        };
        if status.0.len() > 4 * PACKET {
            break;
        }
        while status.0.len() >= PACKET {
            let kind = status.0.pop_front().expect("complete packet");
            let mut value = [0; 4];
            for byte in &mut value {
                *byte = status.0.pop_front().expect("complete packet");
            }
            let value = u32::from_be_bytes(value);
            if matches!((kind, value), (NO_CHILD | STOPPED, 0))
                || (kind == NATURAL && value <= 255)
                || (kind == SIGNALLED && (1..=MAX_SIGNAL).contains(&value))
            {
                incomplete(deadline, reason);
                return policy(event);
            }
        }
        if status_eof {
            break;
        }
        // Retry ticks are scheduling only. The phase check before/after poll
        // prevents a full tick from being appended to the foreground allowance.
        let mut fds = [libc::pollfd {
            fd: channels.status.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        }];
        if poll(&mut fds, Some(deadline)).is_err() {
            break;
        }
    }
    incomplete(deadline, reason);
    policy(event)
}

#[cfg(target_os = "macos")]
struct DescriptorDirectory(*mut libc::DIR);
#[cfg(target_os = "macos")]
impl DescriptorDirectory {
    fn close(mut self) -> io::Result<()> {
        // closedir owns both its DIR allocation and descriptor, including fd 0
        // when opendir reused the raw stdio slot closed immediately after fork.
        let raw = std::mem::replace(&mut self.0, std::ptr::null_mut());
        if unsafe { libc::closedir(raw) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
#[cfg(target_os = "macos")]
impl Drop for DescriptorDirectory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { libc::closedir(self.0) };
        }
    }
}

/// Inventory the single-threaded worker's own stable descriptor table. Numeric
/// descriptor values have no assumed maximum beyond RawFd's representable range;
/// exceeding the inventory's work/memory cap fails closed before child creation.
#[cfg(target_os = "macos")]
fn close_inherited_descriptors(
    channels: &Channels,
    deadline: &CompatibilityBudget<'_>,
) -> io::Result<()> {
    deadline.execution_check()?;
    let keep = [
        channels.control.as_raw_fd(),
        channels.input.as_raw_fd(),
        channels.output.as_raw_fd(),
        channels.error.as_raw_fd(),
        channels.status.as_raw_fd(),
    ];
    if keep.iter().any(|fd| *fd <= 2) {
        return Err(io::Error::other("private descriptor overlaps closed stdio"));
    }
    // /dev/fd is the trusted OS view of this worker, not a foreign PID lookup.
    let directory = DescriptorDirectory(unsafe { libc::opendir(c"/dev/fd".as_ptr()) });
    if directory.0.is_null() {
        return Err(io::Error::last_os_error());
    }
    let inventory_fd = unsafe { libc::dirfd(directory.0) };
    if inventory_fd < 0 || keep.contains(&inventory_fd) {
        return Err(io::Error::other(
            "descriptor inventory identity unavailable",
        ));
    }
    let mut descriptors = Vec::<RawFd>::new();
    let mut seen_private = [false; 5];
    let mut entries = 0;
    loop {
        deadline.execution_check()?;
        if SIGNAL.load(Ordering::Relaxed) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "descriptor isolation interrupted",
            ));
        }
        // POSIX readdir uses errno to distinguish a complete EOF from failure.
        // Darwin exposes this calling thread's errno slot through __error().
        let entry = unsafe {
            *libc::__error() = 0;
            libc::readdir(directory.0)
        };
        if entry.is_null() {
            let error = unsafe { *libc::__error() };
            if error != 0 {
                return Err(io::Error::from_raw_os_error(error));
            }
            break;
        }
        // SAFETY: successful readdir returns a live, NUL-terminated d_name until
        // the next readdir call. No reference survives this iteration.
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        if name.is_empty() || entries == MAX_FD_ENTRIES {
            return Err(io::Error::other(
                "descriptor inventory incomplete or over cap",
            ));
        }
        entries += 1;
        let mut fd: RawFd = 0;
        for digit in name {
            if !digit.is_ascii_digit() {
                return Err(io::Error::other("unexpected descriptor inventory entry"));
            }
            fd = fd
                .checked_mul(10)
                .and_then(|fd| fd.checked_add(RawFd::from(*digit - b'0')))
                .ok_or_else(|| io::Error::other("descriptor inventory value out of range"))?;
        }
        if let Some(index) = keep.iter().position(|private| *private == fd) {
            seen_private[index] = true;
        } else if fd != inventory_fd {
            descriptors
                .try_reserve(1)
                .map_err(|_| io::Error::other("descriptor inventory allocation refused"))?;
            descriptors.push(fd);
        }
    }
    if !seen_private.into_iter().all(|seen| seen) {
        return Err(io::Error::other(
            "descriptor inventory omitted a private channel",
        ));
    }
    // Do not change the enumerated table while readdir is in progress. Close the
    // temporary DIR first; no descriptor-creating operation follows this point.
    directory.close()?;
    for fd in descriptors {
        deadline.execution_check()?;
        if unsafe { libc::close(fd) } != 0 {
            // In particular, do not retry close after EINTR using a potentially
            // reused number. Refuse dispatch; _exit releases every remaining fd.
            return Err(io::Error::last_os_error());
        }
    }
    deadline.execution_check()
}
#[cfg(not(target_os = "macos"))]
fn close_inherited_descriptors(_: &Channels, _: &CompatibilityBudget<'_>) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "descriptor isolation requires macOS",
    ))
}

fn isolate_host() -> io::Result<()> {
    if unsafe { libc::setsid() } < 0 {
        return Err(io::Error::last_os_error());
    }
    // No worker or child holds an inherited harness output description. Only
    // private pipes connect the admitted command to the foreground parent.
    let null = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
    if null < 0 {
        return Err(io::Error::last_os_error());
    }
    for target in [0, 1, 2] {
        if unsafe { libc::dup2(null, target) } < 0 {
            if null > 2 {
                unsafe { libc::close(null) };
            }
            return Err(io::Error::last_os_error());
        }
    }
    if null > 2 {
        unsafe { libc::close(null) };
    }
    Ok(())
}
fn no_child(channels: &Channels, deadline: &CompatibilityBudget<'_>) -> ! {
    let mut status = Queue::default();
    status.packet(NO_CHILD, 0);
    while !status.empty() && allowed(deadline) {
        if status.write(channels.status.as_raw_fd()).is_err() {
            break;
        }
        let mut fds = [libc::pollfd {
            fd: channels.status.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        }];
        if poll(&mut fds, Some(deadline)).is_err() {
            break;
        }
    }
    unsafe { libc::_exit(0) }
}
fn terminal_status(status: ExitStatus) -> Option<(u8, u32)> {
    if let Some(code) = status.code() {
        return u32::try_from(code)
            .ok()
            .filter(|code| *code <= 255)
            .map(|code| (NATURAL, code));
    }
    status.signal().and_then(|signal| {
        u32::try_from(signal)
            .ok()
            .filter(|signal| (1..=MAX_SIGNAL).contains(signal))
            .map(|signal| (SIGNALLED, signal))
    })
}

fn worker_main(command: &mut Command, deadline: &CompatibilityBudget<'_>, channels: Channels) -> ! {
    if close_inherited_descriptors(&channels, deadline).is_err()
        || isolate_host().is_err()
        || !deadline.execution_allowed()
        || SIGNAL.load(Ordering::Relaxed) != 0
    {
        no_child(&channels, deadline);
    }
    let mut control = Queue::default();
    match control.read(channels.control.as_raw_fd()) {
        Ok(false) if control.empty() => (),
        _ => no_child(&channels, deadline),
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            let mut managed = std::mem::zeroed();
            libc::sigemptyset(&mut managed);
            for signal in MANAGED_SIGNALS {
                if libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR {
                    return Err(io::Error::last_os_error());
                }
                if libc::sigaddset(&mut managed, signal) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            if libc::sigprocmask(libc::SIG_UNBLOCK, &managed, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    if !deadline.execution_allowed() {
        no_child(&channels, deadline);
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => no_child(&channels, deadline),
    };
    // No return, unwinding cleanup, or Child drop is an accepted post-spawn path.
    // The worker remains the child's actual parent until confirmed settlement.
    own_child(child, channels, deadline)
}

struct Custody {
    child: Child,
    channels: Channels,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
}
fn own_child(mut child: Child, channels: Channels, deadline: &CompatibilityBudget<'_>) -> ! {
    // All identity and pipe handles live outside the unwind boundary. A panic
    // cannot drop Child or turn a lost pipe observation into confirmed EOF.
    let mut custody = Custody {
        stdin: child.stdin.take(),
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
        child,
        channels,
    };
    let result: std::thread::Result<()> =
        catch_unwind(AssertUnwindSafe(|| pump_child(&mut custody, deadline)));
    if let Err(payload) = result {
        // A custom panic payload may itself panic on drop. Retain that payload
        // too, so handling one unwind cannot unwind through the custody owner.
        std::mem::forget(payload);
    }
    // pump_child never returns. Unwind means cleanup evidence is unavailable;
    // retain all handles indefinitely rather than reaping or claiming settlement.
    let packet = [UNCERTAIN, 0, 0, 0, 0];
    unsafe {
        libc::write(
            custody.channels.status.as_raw_fd(),
            packet.as_ptr().cast(),
            packet.len(),
        )
    };
    let _ = custody.channels.status.shutdown(std::net::Shutdown::Write);
    loop {
        if let Err(payload) = catch_unwind(AssertUnwindSafe(|| {
            let _ = stop_before_reap(&custody.child);
        })) {
            std::mem::forget(payload);
        }
        // Cleanup scheduling only; this cannot extend foreground I/O permission.
        unsafe { libc::poll(std::ptr::null_mut(), 0, RETRY.as_millis() as i32) };
    }
}
fn close_channel(channel: &mut Option<&UnixStream>) {
    if let Some(stream) = channel.take() {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}
fn pump_child(custody: &mut Custody, deadline: &CompatibilityBudget<'_>) -> ! {
    let Custody {
        child,
        channels,
        stdin,
        stdout,
        stderr,
    } = custody;
    let mut ready = true;
    for fd in [
        stdin.as_ref().map(AsRawFd::as_raw_fd),
        stdout.as_ref().map(AsRawFd::as_raw_fd),
        stderr.as_ref().map(AsRawFd::as_raw_fd),
    ] {
        if let Some(fd) = fd {
            // These owned private pipes are never restored to blocking mode.
            let old = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if old < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, old | libc::O_NONBLOCK) } < 0 {
                ready = false;
            }
        } else {
            ready = false;
        }
    }
    let mut status = Queue::default();
    status.packet(SPAWNED, child.id());
    let mut input = Queue::default();
    let mut output = Queue::default();
    let mut error = Queue::default();
    let mut input_eof = false;
    let mut output_eof = false;
    let mut error_eof = false;
    let mut failed = !ready;
    let mut stopping = !ready;
    let mut disconnected = false;
    let mut next_stop = Instant::now();
    let mut stop_accepted = false;
    let mut exit = None;
    let mut terminal_sent = false;
    let mut out_channel = Some(&channels.output);
    let mut err_channel = Some(&channels.error);
    loop {
        let mut live = Queue::default();
        if !disconnected {
            match live.read(channels.control.as_raw_fd()) {
                Ok(false) if live.empty() => (),
                Ok(false) if !live.empty() && live.0.iter().all(|byte| *byte == CANCEL) => {
                    // Foreground may request stopping before it has read this
                    // worker's terminal packet. Do not discard a reaped child's
                    // residual output because that private request arrived late.
                    if exit.is_none() {
                        failed = true;
                        stopping = true;
                    }
                }
                _ => {
                    disconnected = true;
                    failed = true;
                    stopping = true;
                }
            }
        }
        if !allowed(deadline)
            || (exit.is_none() && !deadline.execution_allowed())
            || SIGNAL.load(Ordering::Relaxed) != 0
        {
            failed = true;
            stopping = true;
        }
        if !ready {
            failed = true;
            stopping = true;
        }
        if exit.is_none() {
            match settlement_before_reap(&child) {
                Ok(GroupSettlement::LeaderRunning) => (),
                Ok(GroupSettlement::GroupLive { .. } | GroupSettlement::Exited { .. }) => {
                    stopping = true
                }
                Err(_) => {
                    failed = true;
                    stopping = true;
                }
            }
        }
        if stopping {
            stdin.take();
            input.discard();
            // Natural leader exit still delivers already produced bytes. Any
            // failure/expiry closes foreground output and drains only for cleanup.
            if failed {
                output.discard();
                error.discard();
                close_channel(&mut out_channel);
                close_channel(&mut err_channel);
            }
        } else if ready {
            if !input_eof && input.space() > 0 {
                match input.read(channels.input.as_raw_fd()) {
                    Ok(eof) => input_eof = eof,
                    Err(_) => {
                        failed = true;
                        stopping = true;
                    }
                }
            }
            if let Some(pipe) = &stdin {
                if !deadline.execution_allowed() {
                    failed = true;
                    stopping = true;
                } else if input.write(pipe.as_raw_fd()).is_err() {
                    stdin.take();
                    input.discard();
                    input_eof = true;
                }
            }
            if input_eof && input.empty() {
                stdin.take();
            }
        }
        if ready {
            for (fd, queue, eof) in [
                (
                    stdout.as_ref().map(AsRawFd::as_raw_fd),
                    &mut output,
                    &mut output_eof,
                ),
                (
                    stderr.as_ref().map(AsRawFd::as_raw_fd),
                    &mut error,
                    &mut error_eof,
                ),
            ] {
                if !*eof
                    && queue.space() > 0
                    && let Some(fd) = fd
                {
                    match queue.read(fd) {
                        Ok(done) => *eof = done,
                        Err(_) => {
                            failed = true;
                            stopping = true;
                        }
                    }
                }
                if failed {
                    queue.discard();
                }
            }
        }
        if !failed && allowed(deadline) {
            for (channel, queue) in [
                (&mut out_channel, &mut output),
                (&mut err_channel, &mut error),
            ] {
                if !allowed(deadline) {
                    failed = true;
                    stopping = true;
                    break;
                }
                if let Some(stream) = channel
                    && queue.write(stream.as_raw_fd()).is_err()
                {
                    failed = true;
                    stopping = true;
                }
            }
        }
        if output_eof && output.empty() {
            close_channel(&mut out_channel);
        }
        if error_eof && error.empty() {
            close_channel(&mut err_channel);
        }
        if stopping && exit.is_none() && Instant::now() >= next_stop {
            match stop_before_reap(&child) {
                Ok(_) => stop_accepted = true,
                Err(_) => {
                    failed = true;
                    stop_accepted = false;
                }
            }
            next_stop = Instant::now() + RETRY;
        }
        if stopping
            && exit.is_none()
            && stop_accepted
            && output_eof
            && error_eof
            && matches!(
                settlement_before_reap(&child),
                Ok(GroupSettlement::Exited { .. })
            )
        {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // try_wait observes a true reaped exit, never WSTOPPED.
                    exit = terminal_status(status);
                    if exit.is_none() {
                        failed = true;
                    }
                }
                Ok(None) => (),
                Err(_) => failed = true,
            }
        }
        // Execution failure is not a cleanup-unknown attestation. Keep the
        // actual Child through stop/EOF/settlement/reap observation. Only the
        // completed chain can publish a terminal packet below.
        if let Some((kind, value)) = exit
            && output_eof
            && error_eof
            && !terminal_sent
        {
            // A raw signal is never encoded as an apparently normal 128+signal.
            // Publish it before queued output can consume the remaining budget.
            let (kind, value) = if kind == SIGNALLED {
                (kind, value)
            } else if failed {
                (STOPPED, 0)
            } else {
                (kind, value)
            };
            status.packet(kind, value);
            terminal_sent = true;
        }
        if !disconnected && status.write(channels.status.as_raw_fd()).is_err() {
            disconnected = true;
            failed = true;
            stopping = true;
        }
        if disconnected {
            status.discard();
        }
        if terminal_sent && status.empty() && output.empty() && error.empty() {
            unsafe { libc::_exit(0) }
        }
        let mut fds = Vec::with_capacity(7);
        if !disconnected {
            interests(&mut fds, channels.control.as_raw_fd(), libc::POLLIN);
        }
        if !disconnected && !status.empty() {
            interests(&mut fds, channels.status.as_raw_fd(), libc::POLLOUT);
        }
        if !stopping && !input_eof && input.space() > 0 {
            interests(&mut fds, channels.input.as_raw_fd(), libc::POLLIN);
        }
        if !stopping
            && !input.empty()
            && let Some(pipe) = &stdin
        {
            interests(&mut fds, pipe.as_raw_fd(), libc::POLLOUT);
        }
        if ready
            && !output_eof
            && output.space() > 0
            && let Some(pipe) = &stdout
        {
            interests(&mut fds, pipe.as_raw_fd(), libc::POLLIN);
        }
        if ready
            && !error_eof
            && error.space() > 0
            && let Some(pipe) = &stderr
        {
            interests(&mut fds, pipe.as_raw_fd(), libc::POLLIN);
        }
        if !failed
            && !output.empty()
            && let Some(stream) = &out_channel
        {
            interests(&mut fds, stream.as_raw_fd(), libc::POLLOUT);
        }
        if !failed
            && !error.empty()
            && let Some(stream) = &err_channel
        {
            interests(&mut fds, stream.as_raw_fd(), libc::POLLOUT);
        }
        // A retry tick is cleanup scheduling, never permission for more work.
        if poll(&mut fds, if stopping { None } else { Some(deadline) }).is_err() {
            failed = true;
            stopping = true;
        }
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use caws_native::monotonic_deadline::DeadlineEnvelope;

    #[test]
    fn original_thirty_seconds_reserves_six_hundred_and_one_hundred_milliseconds() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let envelope = original.envelope();
        let budget = CompatibilityBudget::new(&original, None).unwrap();

        assert_eq!(
            original
                .expires()
                .checked_duration_since(budget.execution_end.unwrap()),
            Some(Duration::from_millis(600))
        );
        assert_eq!(
            original
                .expires()
                .checked_duration_since(budget.foreground_end),
            Some(Duration::from_millis(100))
        );
        assert!(std::ptr::eq(budget.original, &original));
        assert!(budget.policy.is_none());
        assert_eq!(original.envelope(), envelope);
    }

    #[test]
    fn selected_twelve_hundred_milliseconds_uses_both_retained_local_bounds() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let envelope = original.envelope();
        let selected_envelope = DeadlineEnvelope {
            started_ns: envelope.started_ns,
            expires_ns: envelope.started_ns.checked_add(1_200_000_000).unwrap(),
        };
        let selected = MonotonicDeadline::receive(selected_envelope).unwrap();
        let budget = CompatibilityBudget::new(&original, Some(&selected)).unwrap();
        let retained_end = original.expires().min(selected.expires());

        assert_eq!(
            retained_end.checked_duration_since(budget.execution_end.unwrap()),
            Some(Duration::from_millis(400))
        );
        assert_eq!(
            retained_end.checked_duration_since(budget.foreground_end),
            Some(Duration::from_millis(100))
        );
        assert!(budget.foreground_end < original.expires());
        assert!(budget.foreground_end < selected.expires());
        assert!(std::ptr::eq(budget.original, &original));
        assert!(std::ptr::eq(budget.policy.unwrap(), &selected));
        assert_eq!(original.envelope(), envelope);
        assert_eq!(selected.envelope(), selected_envelope);
    }

    #[test]
    fn equal_policy_interval_also_uses_the_earlier_captured_local_bound() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let selected = MonotonicDeadline::receive(original.envelope()).unwrap();
        let budget = CompatibilityBudget::new(&original, Some(&selected)).unwrap();
        let retained_end = original.expires().min(selected.expires());

        assert_eq!(
            retained_end.checked_duration_since(budget.execution_end.unwrap()),
            Some(Duration::from_millis(600))
        );
        assert_eq!(
            retained_end.checked_duration_since(budget.foreground_end),
            Some(Duration::from_millis(100))
        );
    }

    #[test]
    fn one_and_two_millisecond_intervals_have_no_execution_phase() {
        for milliseconds in [1, 2] {
            let original = MonotonicDeadline::capture(Duration::from_millis(milliseconds)).unwrap();
            let budget = CompatibilityBudget::new(&original, None).unwrap();
            assert!(
                budget.execution_end.is_none(),
                "{milliseconds}ms must not create a dispatch phase"
            );
            assert_eq!(
                original
                    .expires()
                    .checked_duration_since(budget.foreground_end),
                Some(Duration::from_millis(1))
            );
        }
    }

    #[test]
    fn three_milliseconds_retains_exactly_one_millisecond_for_execution() {
        let original = MonotonicDeadline::capture(Duration::from_millis(3)).unwrap();
        let budget = CompatibilityBudget::new(&original, None).unwrap();
        assert_eq!(
            original
                .expires()
                .checked_duration_since(budget.execution_end.unwrap()),
            Some(Duration::from_millis(2))
        );
        assert_eq!(
            original
                .expires()
                .checked_duration_since(budget.foreground_end),
            Some(Duration::from_millis(1))
        );
    }

    #[test]
    fn selected_policy_cannot_change_the_original_start() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let envelope = original.envelope();
        let selected = MonotonicDeadline::receive(DeadlineEnvelope {
            started_ns: envelope.started_ns.checked_sub(1).unwrap(),
            expires_ns: envelope.expires_ns,
        })
        .unwrap();

        assert!(CompatibilityBudget::new(&original, Some(&selected)).is_err());
    }

    #[test]
    fn selected_policy_cannot_extend_the_original_expiry() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let envelope = original.envelope();
        let selected = MonotonicDeadline::receive(DeadlineEnvelope {
            started_ns: envelope.started_ns,
            expires_ns: envelope.expires_ns.checked_add(1).unwrap(),
        })
        .unwrap();

        assert!(CompatibilityBudget::new(&original, Some(&selected)).is_err());
    }

    #[test]
    fn compatibility_rejects_an_original_above_thirty_seconds() {
        let original = MonotonicDeadline::capture(Duration::from_millis(30_001)).unwrap();
        assert!(CompatibilityBudget::new(&original, None).is_err());
    }

    fn diagnostic_full_socket() -> (UnixStream, UnixStream, usize) {
        let (writer, reader) = UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        reader.set_nonblocking(true).unwrap();
        let capacity: libc::c_int = 4096;
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    writer.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_SNDBUF,
                    (&capacity as *const libc::c_int).cast(),
                    std::mem::size_of_val(&capacity) as libc::socklen_t,
                )
            },
            0
        );
        let chunk = [b'Q'; 8192];
        let last_byte = [b'Q'];
        let mut filled = 0;
        // The final single-byte pass establishes actual lack of write capacity,
        // rather than only lack of room for the preceding large write.
        for bytes in [&chunk[..], &last_byte[..]] {
            let mut blocked = false;
            for _ in 0..2048 {
                let count =
                    unsafe { libc::write(writer.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
                if count > 0 {
                    filled += count as usize;
                    assert!(
                        filled <= 1_048_576,
                        "socket fill exceeded its finite fixture cap"
                    );
                } else if count < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::WouldBlock {
                        blocked = true;
                        break;
                    }
                    assert_eq!(error.kind(), io::ErrorKind::Interrupted, "{error}");
                } else {
                    panic!("socket fill made no progress");
                }
            }
            assert!(
                blocked,
                "socket never reached WouldBlock within its fixture cap"
            );
        }
        assert!(filled > 0);
        let mut writable = [libc::pollfd {
            fd: writer.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        }];
        assert_eq!(unsafe { libc::poll(writable.as_mut_ptr(), 1, 0) }, 0);
        (writer, reader, filled)
    }

    fn diagnostic_drain_socket(reader: &mut UnixStream) -> Vec<u8> {
        use std::io::Read;
        let mut observed = Vec::new();
        let mut chunk = [0; 8192];
        let mut blocked = false;
        for _ in 0..2048 {
            match reader.read(&mut chunk) {
                Ok(0) => panic!("owned writer unexpectedly closed before diagnostic observation"),
                Ok(count) => {
                    observed.extend_from_slice(&chunk[..count]);
                    assert!(
                        observed.len() <= 1_056_768,
                        "socket drain exceeded its fixture cap"
                    );
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    blocked = true;
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => (),
                Err(error) => panic!("socket drain failed: {error}"),
            }
        }
        assert!(
            blocked,
            "socket drain never reached WouldBlock within its fixture cap"
        );
        observed
    }

    #[test]
    fn incomplete_diagnostic_full_socket_observes_one_hundred_millisecond_retry_cap() {
        let (writer, mut reader, filled) = diagnostic_full_socket();
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let envelope = original.envelope();
        let budget = CompatibilityBudget::new(&original, None).unwrap();
        let original_live_before = original.check().is_ok();
        let started = Instant::now();
        let foreground_remaining = budget.foreground_end.duration_since(started);
        emit_incomplete(writer.as_raw_fd(), b"DIAGNOSTIC MUST NOT FIT\n", &budget);
        let elapsed = started.elapsed();
        let original_live_after = original.check().is_ok();
        let observed = diagnostic_drain_socket(&mut reader);
        eprintln!(
            "diagnostic_cap filled={} drained={} elapsed_ns={} foreground_remaining_ns={} original_live_before={} original_live_after={}",
            filled,
            observed.len(),
            elapsed.as_nanos(),
            foreground_remaining.as_nanos(),
            original_live_before,
            original_live_after,
        );
        assert!(original_live_before);
        // This scheduling observation window does not permit retry work after
        // the helper's internal 100ms cap. It rejects both a single attempt and
        // borrowing the much later retained foreground deadline.
        assert!(
            elapsed >= Duration::from_millis(75),
            "retry returned early: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_millis(150),
            "retry exceeded observation window: {elapsed:?}"
        );
        assert_eq!(
            observed,
            vec![b'Q'; filled],
            "diagnostic bytes entered a full socket"
        );
        assert_eq!(original.envelope(), envelope);
    }

    #[test]
    fn incomplete_diagnostic_uses_earlier_foreground_cutoff_without_borrowing_one_hundred_ms() {
        let (writer, mut reader, filled) = diagnostic_full_socket();
        let original = MonotonicDeadline::capture(Duration::from_millis(30_000)).unwrap();
        let envelope = original.envelope();
        let selected_envelope = DeadlineEnvelope {
            started_ns: envelope.started_ns,
            expires_ns: envelope.started_ns.checked_add(80_000_000).unwrap(),
        };
        let selected = MonotonicDeadline::receive(selected_envelope).unwrap();
        let budget = CompatibilityBudget::new(&original, Some(&selected)).unwrap();
        let original_live_before = original.check().is_ok();
        let selected_live_before = selected.check().is_ok();
        let started = Instant::now();
        let foreground_remaining = budget.foreground_end.duration_since(started);
        assert!(foreground_remaining < Duration::from_millis(80));
        emit_incomplete(
            writer.as_raw_fd(),
            b"EARLIER DIAGNOSTIC MUST NOT FIT\n",
            &budget,
        );
        let ended = Instant::now();
        let elapsed = ended.duration_since(started);
        let original_live_after = original.check().is_ok();
        let selected_live_after = selected.check().is_ok();
        let observed = diagnostic_drain_socket(&mut reader);
        eprintln!(
            "diagnostic_earlier filled={} drained={} elapsed_ns={} foreground_remaining_ns={} past_foreground={} before_selected_expiry={} original_live_before={} selected_live_before={} original_live_after={} selected_live_after={}",
            filled,
            observed.len(),
            elapsed.as_nanos(),
            foreground_remaining.as_nanos(),
            ended >= budget.foreground_end,
            ended < selected.expires(),
            original_live_before,
            selected_live_before,
            original_live_after,
            selected_live_after,
        );
        assert!(original_live_before && selected_live_before);
        assert!(
            ended >= budget.foreground_end,
            "retry returned before its earlier cutoff"
        );
        assert!(
            ended < selected.expires(),
            "retry borrowed time beyond selected original interval"
        );
        assert!(
            elapsed < Duration::from_millis(100),
            "retry borrowed a fresh 100ms: {elapsed:?}"
        );
        assert_eq!(
            observed,
            vec![b'Q'; filled],
            "diagnostic bytes entered a full socket"
        );
        assert_eq!(original.envelope(), envelope);
        assert_eq!(selected.envelope(), selected_envelope);
    }
}
