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
// Darwin has signals 1..31; stopped/continued statuses are never terminal.
const MAX_SIGNAL: u32 = 31;
const PACKET: usize = 5;
static SIGNAL: AtomicI32 = AtomicI32::new(0);

extern "C" fn interrupted(signal: libc::c_int) {
    SIGNAL.store(signal, Ordering::Relaxed);
}

struct Signals(Vec<(i32, libc::sigaction)>);
impl Signals {
    fn install() -> io::Result<Self> {
        SIGNAL.store(0, Ordering::Relaxed);
        let mut installed = Self(Vec::new());
        for signal in [
            libc::SIGTERM,
            libc::SIGINT,
            libc::SIGHUP,
            libc::SIGPIPE,
            libc::SIGCHLD,
        ] {
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
            installed.0.push((signal, previous));
        }
        Ok(installed)
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        for (signal, action) in self.0.iter().rev() {
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
fn allowed(deadline: &MonotonicDeadline) -> bool {
    let original = deadline.envelope();
    original
        .expires_ns
        .checked_sub(original.started_ns)
        .is_some_and(|interval| interval > 0 && interval <= MAX_ORIGINAL_NS)
        && deadline.check().is_ok()
}
fn check(deadline: &MonotonicDeadline) -> io::Result<()> {
    if allowed(deadline) {
        Ok(())
    } else {
        Err(io::Error::other(
            "original compatibility deadline invalid or expired",
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
fn poll(fds: &mut [libc::pollfd], deadline: Option<&MonotonicDeadline>) -> io::Result<()> {
    let timeout = if let Some(deadline) = deadline {
        check(deadline)?;
        deadline
            .expires()
            .saturating_duration_since(Instant::now())
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

fn emit(fd: RawFd, bytes: &[u8], deadline: Option<&MonotonicDeadline>) {
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
    deadline: Option<&MonotonicDeadline>,
) -> u8 {
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
fn incomplete(deadline: &MonotonicDeadline, reason: &str) {
    if !allowed(deadline) {
        return;
    }
    let Ok(_flags) = Flags::set(2) else {
        return;
    };
    let bytes = format!("[CAWS native installed entry: delivery incomplete; {reason}]\n");
    if allowed(deadline) {
        // One nonblocking diagnostic attempt cannot delay a cancellation until
        // the rest of the invocation budget expires. No stdout is synthesized.
        unsafe { libc::write(2, bytes.as_ptr().cast(), bytes.len()) };
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
pub(crate) fn run(mut command: Command, deadline: &MonotonicDeadline, event: &str) -> u8 {
    if !cfg!(target_os = "macos") {
        return refuse_before_dispatch(
            event,
            "Compatibility custody requires macOS group settlement",
            Some(deadline),
        );
    }
    if !allowed(deadline) {
        return policy(event);
    }
    let signals = match Signals::install() {
        Ok(signals) => signals,
        Err(_) => {
            return refuse_before_dispatch(
                event,
                "Compatibility signal configuration failed",
                Some(deadline),
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
            Some(deadline),
        );
    }
    let (foreground, worker) = match channels() {
        Ok(pair) => pair,
        Err(_) => {
            return refuse_before_dispatch(
                event,
                "Compatibility private channels unavailable",
                Some(deadline),
            );
        }
    };
    if !allowed(deadline) {
        return policy(event);
    }
    let original_parent = unsafe { libc::getppid() };
    // SAFETY: this entry has started no threads. The child uses only its copied
    // command/clock and terminates with _exit, never returning to the caller.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return refuse_before_dispatch(event, "Compatibility worker fork failed", Some(deadline));
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
    deadline: &MonotonicDeadline,
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
    // Description inspects selection without consuming the caller's input.
    // Keep the private child input channel open until completion or cancellation.
    let forward_input = event != "describe";
    loop {
        if !allowed(deadline) {
            return policy(event);
        }
        let signal = SIGNAL.load(Ordering::Relaxed);
        if signal != 0 {
            return foreground_failure(
                &channels,
                deadline,
                event,
                &format!("caller interrupted; raw signal {signal}; cleanup unconfirmed"),
            );
        }
        if (original_parent > 1 && unsafe { libc::getppid() } != original_parent)
            || output_closed(1)
        {
            return foreground_failure(
                &channels,
                deadline,
                event,
                "caller cancelled; cleanup unconfirmed",
            );
        }
        let operation = (|| -> io::Result<()> {
            check(deadline)?;
            if forward_input && !input_eof && input_open && input.space() > 0 {
                input_eof = input.read(0)?;
            }
            check(deadline)?;
            if input_open && !input.empty() {
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
            if matches!(terminal, Some((SIGNALLED, _))) {
                // Preserve the raw-signal diagnostic even if a host sink has
                // become unwritable. No more compatibility output is required.
                return Ok(());
            }
            check(deadline)?;
            output.write(1)?;
            check(deadline)?;
            error.write(2)?;
            check(deadline)?;
            Ok(())
        })();
        if operation.is_err() {
            return foreground_failure(
                &channels,
                deadline,
                event,
                "compatibility transport or cleanup unconfirmed",
            );
        }
        if let Some((SIGNALLED, signal)) = terminal {
            return foreground_failure(
                &channels,
                deadline,
                event,
                &format!("compatibility child interrupted; raw signal {signal}"),
            );
        }
        if let Some((NO_CHILD, _)) = terminal {
            return refuse_before_dispatch(
                event,
                "Compatibility worker failed before child creation",
                Some(deadline),
            );
        }
        if output_eof && error_eof && output.empty() && error.empty() {
            if let Some((NATURAL, code)) = terminal {
                return code as u8;
            }
            if let Some((STOPPED, _)) = terminal {
                return foreground_failure(
                    &channels,
                    deadline,
                    event,
                    "compatibility execution stopped",
                );
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
        if forward_input && !input_eof && input_open && input.space() > 0 {
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
            return policy(event);
        }
    }
}

fn foreground_failure(
    channels: &Channels,
    deadline: &MonotonicDeadline,
    event: &str,
    reason: &str,
) -> u8 {
    // Request cancellation before attempting even best-effort diagnostics.
    let _ = channels.control.shutdown(std::net::Shutdown::Both);
    incomplete(deadline, reason);
    policy(event)
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
fn no_child(channels: &Channels, deadline: &MonotonicDeadline) -> ! {
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

fn worker_main(command: &mut Command, deadline: &MonotonicDeadline, channels: Channels) -> ! {
    if isolate_host().is_err() || !allowed(deadline) || SIGNAL.load(Ordering::Relaxed) != 0 {
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
            for signal in [
                libc::SIGTERM,
                libc::SIGINT,
                libc::SIGHUP,
                libc::SIGPIPE,
                libc::SIGCHLD,
            ] {
                if libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    if !allowed(deadline) {
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
fn own_child(mut child: Child, channels: Channels, deadline: &MonotonicDeadline) -> ! {
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
fn pump_child(custody: &mut Custody, deadline: &MonotonicDeadline) -> ! {
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
    let mut unknown_sent = false;
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
                _ => {
                    disconnected = true;
                    failed = true;
                    stopping = true;
                }
            }
        }
        if !allowed(deadline) || SIGNAL.load(Ordering::Relaxed) != 0 {
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
                if !allowed(deadline) {
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
        if failed && !unknown_sent {
            status.packet(UNCERTAIN, 0);
            unknown_sent = true;
        }
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
