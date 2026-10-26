use crate::cli::Config;
use serde_json::value::RawValue;
use std::{
    io,
    os::{
        fd::{AsRawFd, RawFd},
        unix::process::CommandExt,
    },
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};

pub const MAX_PAYLOAD: usize = 1_048_576;
pub const MAX_REQUEST: usize = 8 * 1024 * 1024;
pub const MAX_FRAME: usize = 4_194_304 + 4096;
const MAX_ENGINE_STDERR: usize = 65_536;
const CLEANUP_BUDGET: Duration = Duration::from_millis(500);
pub const DELIVERY_BUDGET: Duration = Duration::from_millis(500);
pub const TERMINAL_BUDGET: Duration = Duration::from_millis(1000);
pub const DIAGNOSTIC_BUDGET: Duration = Duration::from_millis(100);

/// Earlier processing/terminal cutoffs reserve existing frontend work inside
/// the original interval. Short calls retain half their interval for processing.
pub struct CallbackBounds {
    pub processing: Instant,
    pub terminal: Instant,
    pub cleanup: Instant,
}
impl CallbackBounds {
    pub fn original(original: &caws_native::monotonic_deadline::MonotonicDeadline) -> Self {
        let interval = original.envelope();
        let total = Duration::from_nanos(interval.expires_ns - interval.started_ns);
        let reserve = (TERMINAL_BUDGET + CLEANUP_BUDGET + DIAGNOSTIC_BUDGET).min(total / 2);
        let diagnostic = reserve / 16;
        let cleanup = reserve * 5 / 16;
        Self {
            processing: original.expires() - reserve,
            terminal: original.expires() - diagnostic - cleanup,
            cleanup: original.expires() - diagnostic,
        }
    }
}
pub fn check_until(
    original: &caws_native::monotonic_deadline::MonotonicDeadline,
    until: Instant,
) -> Result<(), String> {
    original.check().map_err(|error| error.to_string())?;
    if Instant::now() >= until.min(original.expires()) {
        return Err("request deadline expired".into());
    }
    Ok(())
}
pub fn cap_until(
    original: &caws_native::monotonic_deadline::MonotonicDeadline,
    until: Instant,
    cap: Duration,
) -> Instant {
    original.expires().min(until).min(Instant::now() + cap)
}

/// Invoke has no incoming descriptor capability contract. Mark inherited
/// nonstandard descriptors before creating private custodian descriptors.
/// Descriptor flags are process-local; shared file-status flags stay intact.
pub fn isolate_invoke_descriptors(
    original: &caws_native::monotonic_deadline::MonotonicDeadline,
) -> Result<(), String> {
    let check = || original.check().map_err(|error| error.to_string());
    check()?;
    let entries = std::fs::read_dir("/dev/fd");
    check()?;
    let mut entries = entries.map_err(|error| format!("invoke descriptor enumeration: {error}"))?;
    loop {
        check()?;
        let entry = entries.next();
        check()?;
        let Some(entry) = entry else {
            break;
        };
        let entry = entry.map_err(|error| format!("invoke descriptor enumeration: {error}"))?;
        let descriptor = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<RawFd>().ok())
            .filter(|descriptor| *descriptor >= 0)
            .ok_or("invoke descriptor enumeration contains a non-descriptor name")?;
        if descriptor <= libc::STDERR_FILENO {
            continue;
        }
        check()?;
        // SAFETY: query only flags on an enumerated descriptor, without pointers.
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        let error = (flags < 0).then(io::Error::last_os_error);
        check()?;
        if let Some(error) = error {
            if error.raw_os_error() == Some(libc::EBADF) {
                continue;
            }
            return Err(format!("invoke descriptor {descriptor} flags: {error}"));
        }
        check()?;
        // SAFETY: preserve descriptor flags while adding close-on-exec.
        let result = unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
        let error = (result < 0).then(io::Error::last_os_error);
        check()?;
        if let Some(error) = error {
            if error.raw_os_error() == Some(libc::EBADF) {
                continue;
            }
            return Err(format!(
                "invoke descriptor {descriptor} close-on-exec: {error}"
            ));
        }
    }
    check()
}

fn nonblocking(fd: RawFd) -> Result<i32, String> {
    // SAFETY: fcntl operates on a borrowed, live descriptor, without pointer arguments.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(format!(
            "nonblocking pipe configuration: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(flags)
}

fn poll(fds: &mut [libc::pollfd], deadline: Instant) -> Result<(), String> {
    poll_with_cancellation(fds, deadline, true)
}

fn poll_with_cancellation(
    fds: &mut [libc::pollfd],
    deadline: Instant,
    observe_cancellation: bool,
) -> Result<(), String> {
    poll_with_max_wait(fds, deadline, observe_cancellation, 100)
}

fn poll_with_max_wait(
    fds: &mut [libc::pollfd],
    deadline: Instant,
    observe_cancellation: bool,
    max_wait_ms: i32,
) -> Result<(), String> {
    if observe_cancellation {
        crate::cancellation::check()?;
    }
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or("request deadline expired")?;
    // Floor sub-millisecond waits instead of extending the absolute bound.
    let timeout = (remaining.as_millis().min(100) as i32).min(max_wait_ms);
    // SAFETY: fds points at an initialized writable array for its stated length.
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(format!("pipe polling: {error}"));
        }
    }
    if observe_cancellation {
        crate::cancellation::check()?;
    }
    Ok(())
}

fn read_chunk(fd: RawFd, output: &mut Vec<u8>, limit: usize) -> Result<bool, String> {
    let mut buffer = [0_u8; 16_384];
    // SAFETY: buffer is writable for buffer.len(); fd remains owned by caller.
    let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
    if count == 0 {
        return Ok(true);
    }
    if count < 0 {
        let error = io::Error::last_os_error();
        if matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            return Ok(false);
        }
        return Err(format!("pipe read: {error}"));
    }
    if output.len() + count as usize > limit {
        return Err(format!("pipe exceeded {limit} byte budget"));
    }
    output.extend_from_slice(&buffer[..count as usize]);
    Ok(false)
}

pub fn read_payload(deadline: Instant) -> Result<(Box<RawValue>, String), String> {
    let fd = libc::STDIN_FILENO;
    let original = nonblocking(fd)?;
    let read = (|| {
        let mut bytes = Vec::new();
        loop {
            let mut descriptors = [libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            }];
            poll(&mut descriptors, deadline)?;
            if read_chunk(fd, &mut bytes, MAX_PAYLOAD)? {
                break;
            }
        }
        let input = String::from_utf8(bytes).map_err(|_| "hook JSON must be valid UTF-8")?;
        // Validate JSON grammar without materializing unknown numerals as f64 or
        // interpreting object keys as a serializer's private numeric sentinel.
        let payload = RawValue::from_string(if input.is_empty() {
            "{}".into()
        } else {
            input.clone()
        })
        .map_err(|e| format!("invalid hook JSON: {e}"))?;
        if !payload.get().trim_start().starts_with('{') {
            return Err("hook JSON must be an object".into());
        }
        Ok((payload, input))
    })();
    // SAFETY: restore flags on the same live descriptor, including error paths.
    unsafe {
        libc::fcntl(fd, libc::F_SETFL, original);
    }
    read
}

#[derive(Default)]
struct CleanupState {
    completed: Option<std::process::ExitStatus>,
}
impl CleanupState {
    fn pending(&self) -> bool {
        self.completed.is_none()
    }

    fn finish_with<E>(
        &mut self,
        attempt: impl FnOnce() -> Result<std::process::ExitStatus, E>,
    ) -> Result<std::process::ExitStatus, E> {
        if let Some(status) = self.completed {
            return Ok(status);
        }
        let status = attempt()?;
        self.completed = Some(status);
        Ok(status)
    }

    fn cleanup_with<E>(
        &mut self,
        attempt: impl FnOnce() -> Result<std::process::ExitStatus, E>,
    ) -> Result<(), E> {
        self.finish_with(attempt).map(|_| ())
    }
}

#[derive(Debug)]
enum CleanupFailure {
    Stop(caws_native::owned_group::StopError),
    Reap(io::Error),
    Deadline(caws_native::owned_group::GroupStop),
}
impl std::fmt::Display for CleanupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stop(error) => write!(f, "engine cleanup: {error}"),
            Self::Reap(error) => write!(f, "engine reap: {error}"),
            Self::Deadline(stop) => write!(
                f,
                "owned engine stop returned {stop:?} but the child could not be reaped within the 500ms cleanup budget"
            ),
        }
    }
}

trait CleanupOperations {
    fn stop(
        &mut self,
    ) -> Result<caws_native::owned_group::GroupStop, caws_native::owned_group::StopError>;
    fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>>;
    fn elapsed(&self) -> Duration;
    fn pause(&mut self);
}

fn cleanup_attempt(
    ops: &mut impl CleanupOperations,
) -> Result<std::process::ExitStatus, CleanupFailure> {
    // A refused stop must not reap the child that still pins group identity.
    let stop = ops.stop().map_err(CleanupFailure::Stop)?;
    let started = ops.elapsed();
    loop {
        if let Some(status) = ops.try_wait().map_err(CleanupFailure::Reap)? {
            return Ok(status);
        }
        if ops.elapsed().saturating_sub(started) >= CLEANUP_BUDGET {
            return Err(CleanupFailure::Deadline(stop));
        }
        ops.pause();
    }
}

struct ChildCleanup<'a> {
    child: &'a mut Child,
    clock: Instant,
}
impl CleanupOperations for ChildCleanup<'_> {
    fn stop(
        &mut self,
    ) -> Result<caws_native::owned_group::GroupStop, caws_native::owned_group::StopError> {
        caws_native::owned_group::stop_before_reap(self.child)
    }

    fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    fn elapsed(&self) -> Duration {
        self.clock.elapsed()
    }

    fn pause(&mut self) {
        std::thread::sleep(Duration::from_millis(2));
    }
}

struct OwnedGroup {
    child: Child,
    cleanup: CleanupState,
}
impl OwnedGroup {
    fn finish(&mut self) -> Result<std::process::ExitStatus, CleanupFailure> {
        self.cleanup
            .finish_with(|| Self::finish_child(&mut self.child))
    }

    fn cleanup(&mut self) -> Result<(), CleanupFailure> {
        self.cleanup
            .cleanup_with(|| Self::finish_child(&mut self.child))
    }

    fn finish_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<std::process::ExitStatus, String> {
        // Preserve the legacy direct-child cleanup and cached-exit semantics.
        // Its existing 500ms cleanup attempt and possible Drop retry remain
        // outside the strict callback claim for non-macOS/test-only direct owners.
        // Normal macOS invocation uses the separately bounded custodian owner.
        check_until(original, until)?;
        let finished = self.finish().map_err(|error| error.to_string());
        // A late completion stays cached by CleanupState even when this caller
        // observes deadline failure. Failed cleanup retains the actual Child.
        match (finished, check_until(original, until)) {
            (Ok(status), Ok(())) => Ok(status),
            (Err(cleanup), Ok(())) => Err(cleanup),
            (Ok(_), Err(clock)) => Err(clock),
            (Err(cleanup), Err(clock)) => Err(format!("{cleanup}; deadline: {clock}")),
        }
    }

    fn finish_child(child: &mut Child) -> Result<std::process::ExitStatus, CleanupFailure> {
        cleanup_attempt(&mut ChildCleanup {
            child,
            clock: Instant::now(),
        })
    }
}
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        if self.cleanup.pending() {
            // One bounded best-effort attempt, including a retry after an earlier
            // error. Failure remains unresolved; dropping this frontend cannot
            // preserve Child ownership after exit. Durable custody needs a
            // separate owner. Accepted stop plus leader reap is not proof that
            // every nonleader has settled.
            if let Err(error) = self.finish() {
                eprintln!("owned engine cleanup unresolved during drop: {error}");
            }
        }
    }
}

enum EngineOwner {
    Direct(OwnedGroup),
    #[cfg(target_os = "macos")]
    Custodied(Box<crate::engine_custody::Owner>),
}
impl EngineOwner {
    fn pre_creation_failure_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<Option<String>, String> {
        check_until(original, until)?;
        let result = match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.pre_creation_failure_until(original, until),
            Self::Direct(_) => Ok(None),
        }?;
        check_until(original, until)?;
        Ok(result)
    }
    fn exit_observed_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<bool, String> {
        check_until(original, until)?;
        let result = match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.exit_observed_until(original, until),
            Self::Direct(group) => {
                let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
                // Observe without reaping the original ownership anchor.
                if unsafe {
                    libc::waitid(
                        libc::P_PID,
                        group.child.id(),
                        info.as_mut_ptr(),
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                } != 0
                {
                    return Err(format!(
                        "engine exit observation: {}",
                        io::Error::last_os_error()
                    ));
                }
                Ok(unsafe { info.assume_init().si_pid() } != 0)
            }
        }?;
        check_until(original, until)?;
        Ok(result)
    }
    fn finish_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<std::process::ExitStatus, String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.finish_until(original, until),
            Self::Direct(group) => group.finish_until(original, until),
        }
    }
    fn cleanup_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.cleanup_until(original, until),
            Self::Direct(group) => group.finish_until(original, until).map(|_| ()),
        }
    }
}

pub struct Session {
    original_deadline: caws_native::monotonic_deadline::MonotonicDeadline,
    group: EngineOwner,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    buffered: Vec<u8>,
    scan_from: usize,
    #[cfg(test)]
    examined_bytes: usize,
    diagnostics: Vec<u8>,
    stdout_bytes: usize,
    cache_control_credit: usize,
    publication_control_credit: usize,
    context_git_control_credit: usize,
    stop_lease_context_used: bool,
    stop_lease_context_control_credit: usize,
    selection_control_credit: usize,
    #[cfg(feature = "sqlite-store")]
    store_control_credit: usize,
    out_done: bool,
    err_done: bool,
    terminal_containment: bool,
    render_bank: Option<crate::render_bridge::DescriptorBank>,
    render_bridge: Option<crate::render_bridge::Bridge>,
}

impl caws_native::session_publication::Transport for Session {
    fn write(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String> {
        self.send(bytes, deadline)
    }
    fn read(&mut self, deadline: Instant) -> Result<Vec<u8>, String> {
        // frame() consumes exactly one LF and leaves an optional CR in the
        // returned bytes. Restore that consumed delimiter for exact credit.
        let mut bytes = self.frame(deadline)?;
        bytes.push(b'\n');
        Ok(bytes)
    }
    fn credit(&mut self, bytes: usize) -> Result<(), String> {
        let credit = self
            .publication_control_credit
            .checked_add(bytes)
            .ok_or("publication control credit overflow")?;
        if bytes == 0
            || credit
                > caws_native::session_publication_wire::MAX_EXTRA_PUBLICATION_ENGINE_STDOUT_BYTES
        {
            return Err("publication control credit exceeds one finite operation".into());
        }
        self.publication_control_credit = credit;
        Ok(())
    }
}

#[cfg(feature = "sqlite-store")]
impl caws_native::transcript_store_wire::Transport for Session {
    fn write(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String> {
        self.send(bytes, deadline)
    }
    fn read(&mut self, deadline: Instant) -> Result<Vec<u8>, String> {
        self.frame(deadline)
    }
    fn credit(&mut self, bytes: usize) -> Result<(), String> {
        let credit = self
            .store_control_credit
            .checked_add(bytes)
            .ok_or("store control credit overflow")?;
        if credit > caws_native::transcript_store_wire::MAX_EXTRA_ENGINE_STDOUT_BYTES {
            return Err("store control credit exceeds one finite acquisition".into());
        }
        self.store_control_credit = credit;
        Ok(())
    }
}

impl Session {
    pub fn start(
        config: &Config,
        invocation_id: &str,
        original_deadline: &caws_native::monotonic_deadline::MonotonicDeadline,
    ) -> Result<Self, String> {
        Self::start_inner(
            config,
            invocation_id,
            original_deadline,
            cfg!(target_os = "macos"),
        )
    }

    fn start_inner(
        config: &Config,
        invocation_id: &str,
        original_deadline: &caws_native::monotonic_deadline::MonotonicDeadline,
        custody: bool,
    ) -> Result<Self, String> {
        crate::cancellation::check()?;
        original_deadline
            .check()
            .map_err(|error| error.to_string())?;
        let mut command = Command::new(&config.node);
        command
            .arg(&config.engine)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Keep the raw snapshot in Request for admission, while preventing an
        // ambient preload from replacing the pinned engine's Ready producer.
        command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
        for (name, _) in std::env::vars_os() {
            if name
                .to_str()
                .is_some_and(|s| s.starts_with("LD_") || s.starts_with("DYLD_"))
            {
                command.env_remove(name);
            }
        }
        let mut render_bank = if config.configuration == "system"
            && config.surface == "codex"
            && config.event == "stop"
        {
            Some(crate::render_bridge::DescriptorBank::new()?)
        } else {
            None
        };
        let render_sources = render_bank.as_ref().map(|bank| bank.child_sources());
        #[cfg(target_os = "macos")]
        let spawned = if custody {
            let spawned = crate::engine_custody::Owner::spawn(
                config,
                invocation_id,
                render_sources,
                original_deadline,
            )?;
            Some((
                EngineOwner::Custodied(Box::new(spawned.owner)),
                spawned.stdin,
                spawned.stdout,
                spawned.stderr,
            ))
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        let spawned: Option<(EngineOwner, ChildStdin, ChildStdout, ChildStderr)> = {
            let _ = (invocation_id, custody);
            None
        };
        let (group, stdin, stdout, stderr) = if let Some(spawned) = spawned {
            spawned
        } else {
            let original_envelope = original_deadline.envelope();
            // SAFETY: only async-signal-safe operations and allocation-free checks.
            unsafe {
                command.pre_exec(move || {
                    if libc::setpgid(0, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if let Some(sources) = render_sources {
                        for (source, target) in sources.into_iter().zip([3, 4, 5]) {
                            if libc::dup2(source, target) < 0 {
                                return Err(io::Error::last_os_error());
                            }
                        }
                        // FD6 is never an engine capability. All original bank
                        // descriptions are >=10 and close-on-exec.
                        libc::close(6);
                    }
                    caws_native::monotonic_deadline::check_before_exec(original_envelope)
                        .map_err(io::Error::from_raw_os_error)
                });
            }
            original_deadline
                .check()
                .map_err(|error| error.to_string())?;
            let child = command.spawn().map_err(|e| format!("engine spawn: {e}"))?;
            let mut group = OwnedGroup {
                child,
                cleanup: CleanupState::default(),
            };
            let stdin = group.child.stdin.take().ok_or("missing engine stdin")?;
            let stdout = group.child.stdout.take().ok_or("missing engine stdout")?;
            let stderr = group.child.stderr.take().ok_or("missing engine stderr")?;
            (EngineOwner::Direct(group), stdin, stdout, stderr)
        };
        if let Some(bank) = &mut render_bank {
            bank.spawned();
        }
        nonblocking(stdin.as_raw_fd())?;
        nonblocking(stdout.as_raw_fd())?;
        nonblocking(stderr.as_raw_fd())?;
        Ok(Self {
            original_deadline: original_deadline.clone(),
            group,
            stdin,
            stdout,
            stderr,
            buffered: Vec::new(),
            scan_from: 0,
            #[cfg(test)]
            examined_bytes: 0,
            diagnostics: Vec::new(),
            stdout_bytes: 0,
            cache_control_credit: 0,
            publication_control_credit: 0,
            context_git_control_credit: 0,
            stop_lease_context_used: false,
            stop_lease_context_control_credit: 0,
            selection_control_credit: 0,
            #[cfg(feature = "sqlite-store")]
            store_control_credit: 0,
            out_done: false,
            err_done: false,
            terminal_containment: false,
            render_bank,
            render_bridge: None,
        })
    }

    /// Starts/connects the independently provisioned owner while continuing to
    /// drain engine output. No service read ever blocks the engine frame pump.
    /// Returns a v2 dispatch frame only after native image/grant admission.
    pub fn admit_render_offer(
        &mut self,
        config: &Config,
        request: &crate::protocol::Request,
        ready: &mut crate::protocol::Ready,
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>, String> {
        let original = self.original_deadline.clone();
        let deadline = deadline.min(original.expires());
        check_until(&original, deadline)?;
        let Some(offer) = ready.service_offer.take() else {
            if let Some(bank) = &mut self.render_bank {
                bank.withdraw();
            }
            return Ok(None);
        };
        if self.render_bridge.is_some() {
            return Err("render offer already admitted".into());
        }
        if self.render_bank.is_none() {
            return Err("render offer has no native descriptor bank".into());
        }
        let preparation =
            crate::render_bridge::prepare_offer(config, request, ready, *offer, deadline)?;
        check_until(&original, deadline)?;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("caws-render-admission".into())
            .spawn(move || {
                let _ = sender.send(crate::render_bridge::connect(preparation, deadline));
            })
            .map_err(|e| format!("render admission thread: {e}"))?;
        let admission = loop {
            check_until(&original, deadline)?;
            match receiver.try_recv() {
                Ok(result) => break result?,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err("render admission worker closed".into());
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    self.pump(None, deadline)?;
                }
            }
        };
        check_until(&original, deadline)?;
        let (bridge, dispatch) = crate::render_bridge::activate(
            self.render_bank.as_mut().ok_or("render bank unavailable")?,
            admission,
            request,
        )?;
        check_until(&original, deadline)?;
        self.render_bridge = Some(bridge);
        Ok(Some(dispatch))
    }

    /// Diagnostic observation only: never substitutes for the engine proposal
    /// or changes an already earned protective result.
    pub fn render_diagnostic(&self) -> Option<String> {
        self.render_bridge.as_ref().and_then(|bridge| {
            self.render_bank
                .as_ref()
                .and_then(|bank| bridge.diagnostic(bank))
        })
    }

    // Every write also drains bounded engine output, so neither side can deadlock
    // by filling the opposite pipe. Request stdin remains open through handoff.
    fn pump(&mut self, write: Option<&[u8]>, deadline: Instant) -> Result<usize, String> {
        self.pump_with_interests(write, deadline, &[], 100)
    }

    fn pump_with_interests(
        &mut self,
        write: Option<&[u8]>,
        deadline: Instant,
        extra: &[libc::pollfd],
        max_wait_ms: i32,
    ) -> Result<usize, String> {
        self.pump_checked(write, deadline, extra, max_wait_ms, &mut || Ok(()))
    }
    fn pump_checked(
        &mut self,
        write: Option<&[u8]>,
        deadline: Instant,
        extra: &[libc::pollfd],
        max_wait_ms: i32,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<usize, String> {
        let retained = self.original_deadline.clone();
        let deadline = deadline.min(retained.expires());
        let caller_check = check;
        let mut check = || {
            check_until(&retained, deadline)?;
            caller_check()
        };
        check()?;
        if let Some(bridge) = &mut self.render_bridge {
            bridge.tick();
        }
        check()?;
        let mut descriptors = vec![
            libc::pollfd {
                fd: if write.is_some() {
                    self.stdin.as_raw_fd()
                } else {
                    -1
                },
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: if self.out_done {
                    -1
                } else {
                    self.stdout.as_raw_fd()
                },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if self.err_done {
                    -1
                } else {
                    self.stderr.as_raw_fd()
                },
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        if let Some(bridge) = &self.render_bridge {
            descriptors.extend(bridge.interests());
        }
        descriptors.extend_from_slice(extra);
        poll_with_max_wait(
            &mut descriptors,
            deadline,
            !self.terminal_containment,
            max_wait_ms,
        )?;
        check()?;
        let mut written = 0;
        if let Some(bytes) = write
            && descriptors[0].revents != 0
        {
            check()?;
            let chunk = &bytes[..bytes.len().min(16_384)];
            // SAFETY: chunk is readable for its length; the pipe is live and nonblocking.
            let count =
                unsafe { libc::write(self.stdin.as_raw_fd(), chunk.as_ptr().cast(), chunk.len()) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    return Err(format!("engine input write: {error}"));
                }
            } else if count == 0 {
                return Err("engine input write made no progress".into());
            } else {
                written = count as usize;
            }
        }
        if !self.out_done && descriptors[1].revents != 0 {
            check()?;
            let before = self.buffered.len();
            self.out_done = read_chunk(self.stdout.as_raw_fd(), &mut self.buffered, MAX_FRAME)?;
            check()?;
            self.stdout_bytes += self.buffered.len() - before;
            if self.stdout_bytes > MAX_FRAME + 16_384 + self.control_credit() {
                return Err("engine stream exceeded total byte budget".into());
            }
        }
        if !self.err_done && descriptors[2].revents != 0 {
            check()?;
            self.err_done = read_chunk(
                self.stderr.as_raw_fd(),
                &mut self.diagnostics,
                MAX_ENGINE_STDERR,
            )?;
            check()?;
        }
        check()?;
        if let Some(bridge) = &mut self.render_bridge {
            bridge.tick();
        }
        check()?;
        Ok(written)
    }

    pub fn send(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String> {
        let original = self.original_deadline.clone();
        self.send_until(bytes, &original, deadline)
    }

    pub fn send_until(
        &mut self,
        bytes: &[u8],
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        let retained = self.original_deadline.clone();
        let until = until.min(original.expires()).min(retained.expires());
        check_until(&retained, until)?;
        check_until(original, until)?;
        let mut offset = 0;
        while offset < bytes.len() {
            offset += self.pump_checked(
                Some(&bytes[offset..]),
                until.min(original.expires()),
                &[],
                100,
                &mut || check_until(original, until),
            )?;
        }
        check_until(&retained, until)?;
        check_until(original, until)
    }

    /// Only one pre-Ready exchange is live. While Git runs, Node stderr is
    /// drained and cancellation remains observable. Node stdout must remain
    /// silent until the result: even a well-formed Failure is an overlapping
    /// frame at this point. EOF is transport loss, not successful Git cleanup.
    /// After result delivery the ordinary frame reader admits Failure normally.
    pub fn run_context_git(
        &mut self,
        owner: &mut caws_native::context_git::ContextGitOwner,
        frame: &[u8],
        deadline: Instant,
    ) -> Result<(), String> {
        self.run_context_git_checked(owner, frame, deadline, None)
    }
    pub fn run_context_git_until(
        &mut self,
        owner: &mut caws_native::context_git::ContextGitOwner,
        frame: &[u8],
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        check_until(original, until)?;
        self.run_context_git_checked(owner, frame, until.min(original.expires()), Some(original))
    }
    fn run_context_git_checked(
        &mut self,
        owner: &mut caws_native::context_git::ContextGitOwner,
        frame: &[u8],
        deadline: Instant,
        original: Option<&caws_native::monotonic_deadline::MonotonicDeadline>,
    ) -> Result<(), String> {
        let retained = self.original_deadline.clone();
        let deadline = deadline.min(retained.expires());
        check_until(&retained, deadline)?;
        let mut pending = owner.begin(frame)?;
        let exchange: Result<(), String> = (|| {
            let credit = self
                .context_git_control_credit
                .checked_add(frame.len() + 1)
                .ok_or("context Git control credit overflow")?;
            if credit > owner.control_credit_limit() {
                return Err("context Git control credit exceeds selected fixed profile".into());
            }
            self.context_git_control_credit = credit;
            loop {
                check_until(&retained, deadline)?;
                crate::cancellation::check()?;
                // Check an already-buffered second frame/partial frame before
                // advancing the new operation, including coalesced requests.
                if !self.buffered.is_empty() {
                    return Err("engine output overlapped pending context Git request".into());
                }
                let result = pending.advance_until(&retained, deadline)?;
                check_until(&retained, deadline)?;
                self.pump_with_interests(
                    None,
                    deadline,
                    &pending.interests(),
                    if result.is_some() { 0 } else { 100 },
                )?;
                if !self.buffered.is_empty() {
                    return Err("engine output overlapped pending context Git request".into());
                }
                if self.out_done {
                    return Err(
                        "engine stream closed during pending context Git request; cleanup required"
                            .into(),
                    );
                }
                if let Some(mut bytes) = result {
                    bytes.push(b'\n');
                    let mut offset = 0;
                    while offset < bytes.len() {
                        offset += self.pump(Some(&bytes[offset..]), deadline)?;
                        if offset < bytes.len() && (!self.buffered.is_empty() || self.out_done) {
                            return Err(
                                "engine output overlapped partial context Git result".into()
                            );
                        }
                    }
                    // The final write can wake a legitimate second request or
                    // Ready. Preserve those buffered bytes for the phase loop;
                    // a post-final probe cannot establish an earlier overlap.
                    return Ok(());
                }
            }
        })();
        match exchange {
            Ok(()) => Ok(()),
            Err(mut error) => {
                let cleanup = match original {
                    Some(clock) => pending.cancel_and_settle_until(clock, deadline),
                    None => pending.cancel_and_settle_until(&retained, deadline),
                };
                if let Err(cleanup) = cleanup {
                    error.push_str(&format!("; context Git cleanup: {cleanup}"));
                }
                // Dropping closes sole frontend control even on an uncertain
                // attempt. The separate custodian retains the actual Git Child.
                Err(error)
            }
        }
    }

    /// Respond using the actual pre-Node query observations. This path has no
    /// process-spawn operation and cannot upgrade a failed optional candidate.
    pub fn replay_context_git(
        &mut self,
        replay: &mut crate::protocol::CapturedContext,
        frame: &[u8],
        deadline: Instant,
    ) -> Result<(), String> {
        let original = self.original_deadline.clone();
        check_until(&original, deadline)?;
        crate::cancellation::check()?;
        let credit = self
            .context_git_control_credit
            .checked_add(frame.len() + 1)
            .ok_or("context Git control credit overflow")?;
        if credit > caws_native::context_git::MAX_EXTRA_ENGINE_STDOUT_BYTES {
            return Err("context Git control credit exceeds two requests".into());
        }
        self.context_git_control_credit = credit;
        if !self.buffered.is_empty() {
            return Err("engine output overlapped captured context request".into());
        }
        let bytes = replay.response(frame)?;
        check_until(&original, deadline)?;
        self.pump_with_interests(None, deadline, &[], 0)?;
        if !self.buffered.is_empty() || self.out_done {
            return Err("engine output overlapped captured context request".into());
        }
        let mut offset = 0;
        while offset < bytes.len() {
            offset += self.pump(Some(&bytes[offset..]), deadline)?;
            if offset < bytes.len() && (!self.buffered.is_empty() || self.out_done) {
                return Err("engine output overlapped partial captured context result".into());
            }
        }
        Ok(())
    }

    /// Serial pre-Ready selection exchange on the existing sole reader. Only a
    /// fully correlated and actually captured request receives bounded credit.
    pub fn run_selection_observation(
        &mut self,
        owner: &mut crate::selection_observation::SelectionObservationOwner<'_>,
        request: &crate::protocol::Request,
        frame: &[u8],
        deadline: Instant,
    ) -> Result<(), String> {
        let original = self.original_deadline.clone();
        let check = || {
            check_until(&original, deadline)?;
            crate::cancellation::check()
        };
        check()?;
        crate::cancellation::check()?;
        if !self.buffered.is_empty() {
            return Err("engine output overlapped selection observation request".into());
        }
        let inner = request.selection_request(frame)?;
        let sequence = inner.sequence;
        let snapshot_id = inner.snapshot_id.clone();
        let encoded = serde_json::to_vec(&serde_json::json!({"snapshotId":inner.snapshot_id,
            "sequence":inner.sequence,"operation":inner.operation}))
        .map_err(|e| e.to_string())?;
        let mut reply = owner.capture_json(&encoded, check)?;
        check()?;
        let credit = self
            .selection_control_credit
            .checked_add(frame.len() + 1)
            .ok_or("selection control credit overflow")?;
        if credit > request.selection_control_limit()? {
            return Err("selection control credit exceeds native observation bound".into());
        }
        self.selection_control_credit = credit;
        self.pump_with_interests(None, deadline, &[], 0)?;
        if !self.buffered.is_empty() || self.out_done {
            return Err("engine output overlapped selection observation request".into());
        }
        let byte_len = reply.byte_len();
        let sha256 = reply.sha256(check)?;
        check()?;
        let header = serde_json::json!({"schema":crate::protocol::SELECTION_OBSERVATION_RESULT,
            "id":request.id,"runtimeDigest":request.runtime_digest,"snapshotId":snapshot_id,
            "sequence":sequence,"byteLength":byte_len,"sha256":sha256});
        self.send_selection_frame(&header, false, deadline)?;
        let mut offset = 0usize;
        while let Some(chunk) = reply.next_chunk(64 * 1024, check)? {
            check()?;
            use base64::Engine as _;
            let count = chunk.len();
            let chunk_frame = serde_json::json!({"schema":crate::protocol::SELECTION_OBSERVATION_CHUNK,
                "id":request.id,"runtimeDigest":request.runtime_digest,"snapshotId":snapshot_id,
                "sequence":sequence,"offset":offset,
                "base64":base64::engine::general_purpose::STANDARD.encode(chunk)});
            offset = offset
                .checked_add(count)
                .ok_or("selection response offset overflow")?;
            self.send_selection_frame(&chunk_frame, offset == byte_len, deadline)?;
        }
        if offset != byte_len {
            return Err("selection response was not exhausted".into());
        }
        check()?;
        Ok(())
    }
    fn send_selection_frame(
        &mut self,
        frame: &serde_json::Value,
        final_frame: bool,
        deadline: Instant,
    ) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let mut offset = 0;
        while offset < bytes.len() {
            offset += self.pump(Some(&bytes[offset..]), deadline)?;
            // A legitimate next request may arrive after the last chunk's final
            // write. Preserve that queued frame for the ordinary phase loop.
            if (!final_frame || offset < bytes.len())
                && (!self.buffered.is_empty() || self.out_done)
            {
                return Err("engine output overlapped partial selection observation result".into());
            }
        }
        Ok(())
    }

    /// One dedicated late consumer request only. Generic context Git credit
    /// and pre-Ready discovery admission remain unchanged.
    pub(crate) fn begin_stop_lease_context(
        &mut self,
        validated_bytes: usize,
    ) -> Result<(), String> {
        if self.stop_lease_context_used {
            return Err("Stop lease context request already consumed".into());
        }
        self.stop_lease_context_used = true;
        if validated_bytes > crate::protocol::MAX_STOP_LEASE_CONTEXT_REQUEST + 1 {
            return Err("Stop lease context control credit exceeds one request".into());
        }
        self.stop_lease_context_control_credit = validated_bytes;
        Ok(())
    }
    /// Called by the actual synchronous Git owner's cancellation checkpoints.
    /// Drain stderr and detect engine overlap while the original owner runs;
    /// no Node frame supplies argv, a path, an environment, or a new deadline.
    pub(crate) fn stop_lease_context_checkpoint(
        &mut self,
        deadline: Instant,
    ) -> Result<(), String> {
        check_until(&self.original_deadline, deadline)?;
        crate::cancellation::check()?;
        if Instant::now() >= deadline {
            return Err("original Stop lease context deadline expired".into());
        }
        if !self.buffered.is_empty() || self.out_done {
            return Err("engine output overlapped pending Stop lease context".into());
        }
        self.pump_with_interests(None, deadline, &[], 0)?;
        if !self.buffered.is_empty() || self.out_done {
            return Err("engine output overlapped pending Stop lease context".into());
        }
        Ok(())
    }
    pub(crate) fn finish_stop_lease_context(
        &mut self,
        bytes: &[u8],
        deadline: Instant,
    ) -> Result<(), String> {
        self.stop_lease_context_checkpoint(deadline)?;
        let mut offset = 0;
        while offset < bytes.len() {
            offset += self.pump(Some(&bytes[offset..]), deadline)?;
            // After the final write a legitimate next phase may arrive.
            if offset < bytes.len() && (!self.buffered.is_empty() || self.out_done) {
                return Err("engine output overlapped partial Stop lease context result".into());
            }
        }
        Ok(())
    }

    /// Credit only exact, already validated one-shot cache control bytes.
    /// The ordinary proposal frame and unclassified output budgets do not grow.
    pub fn credit_session_cache_control(&mut self, bytes: usize) -> Result<(), String> {
        let credit = self
            .cache_control_credit
            .checked_add(bytes)
            .ok_or("cache control credit overflow")?;
        if credit > caws_native::session_cache_wire::MAX_EXTRA_ENGINE_STDOUT_BYTES {
            return Err("cache control credit exceeds one exchange".into());
        }
        self.cache_control_credit = credit;
        Ok(())
    }

    fn control_credit(&self) -> usize {
        #[cfg(feature = "sqlite-store")]
        {
            self.cache_control_credit
                + self.context_git_control_credit
                + self.stop_lease_context_control_credit
                + self.selection_control_credit
                + self.publication_control_credit
                + self.store_control_credit
        }
        #[cfg(not(feature = "sqlite-store"))]
        {
            self.cache_control_credit
                + self.context_git_control_credit
                + self.stop_lease_context_control_credit
                + self.selection_control_credit
                + self.publication_control_credit
        }
    }

    pub fn begin_terminal_containment(&mut self, _target: &crate::process_effect::ValidatedTarget) {
        // The private target capability is available only after terminal intent
        // validation. This mode can only flush its ACK and settle; never dispatch.
        self.terminal_containment = true;
    }

    fn buffered_frame(&mut self) -> Result<Option<Vec<u8>>, String> {
        // The retained prefix has already been checked and contains no newline.
        // Consuming a frame changes offsets, so the next frame starts at zero.
        let end = self.buffered[self.scan_from..]
            .iter()
            .position(|byte| {
                #[cfg(test)]
                {
                    self.examined_bytes += 1;
                }
                *byte == b'\n'
            })
            .map(|offset| self.scan_from + offset);
        if let Some(end) = end {
            let bytes: Vec<u8> = self.buffered.drain(..=end).collect();
            self.scan_from = 0;
            if end == 0 {
                return Err("empty engine frame".into());
            }
            return Ok(Some(bytes[..end].to_vec()));
        }
        self.scan_from = self.buffered.len();
        Ok(None)
    }

    pub fn frame(&mut self, deadline: Instant) -> Result<Vec<u8>, String> {
        if self.terminal_containment {
            return Err("no engine frames admitted after terminal containment".into());
        }
        let original = self.original_deadline.clone();
        let deadline = deadline.min(original.expires());
        loop {
            check_until(&original, deadline)?;
            crate::cancellation::check()?;
            if let Some(bytes) = self.buffered_frame()? {
                check_until(&original, deadline)?;
                return Ok(bytes);
            }
            if self.out_done {
                let mut message = "engine stream closed before a complete frame".to_owned();
                if let Some(cause) = self.group.pre_creation_failure_until(&original, deadline)? {
                    message.push_str("; ");
                    message.push_str(&cause);
                }
                check_until(&original, deadline)?;
                return Err(message);
            }
            self.pump(None, deadline)?;
        }
    }

    pub fn settle(&mut self, deadline: Instant) -> Result<(), String> {
        let original = self.original_deadline.clone();
        self.settle_until(&original, deadline)
    }

    pub fn cleanup(&mut self) -> Result<(), String> {
        let original = self.original_deadline.clone();
        self.cleanup_until(&original, original.expires())
    }

    pub fn settle_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        let retained = self.original_deadline.clone();
        let until = until.min(original.expires()).min(retained.expires());
        let mut check = || {
            check_until(&retained, until)?;
            check_until(original, until)
        };
        loop {
            check()?;
            if !self.terminal_containment {
                crate::cancellation::check()?;
            }
            let exited = self.group.exit_observed_until(&retained, until)?;
            check()?;
            if exited {
                break;
            }
            self.pump_checked(None, until.min(original.expires()), &[], 100, &mut check)?;
        }
        let status = self.group.finish_until(&retained, until)?;
        check()?;
        if !status.success() {
            return Err(format!(
                "engine exited unsuccessfully after proposal ({status})"
            ));
        }
        Ok(())
    }
    pub fn cleanup_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        self.group.cleanup_until(original, until)
    }
}

struct Flags {
    fd: RawFd,
    original: i32,
}
impl Flags {
    fn nonblocking(fd: RawFd) -> Result<Self, String> {
        Ok(Self {
            fd,
            original: nonblocking(fd)?,
        })
    }
}
impl Drop for Flags {
    fn drop(&mut self) {
        // SAFETY: these borrowed process stdio descriptors remain live here.
        unsafe {
            libc::fcntl(self.fd, libc::F_SETFL, self.original);
        }
    }
}

fn write_output(
    stdout: &[u8],
    stderr: &[u8],
    deadline: Instant,
    observe_cancellation: bool,
    descriptors: [RawFd; 2],
    check: &mut impl FnMut(&'static str) -> Result<(), String>,
) -> Result<(), String> {
    check("native-output-start").map_err(|error| format!("bounded output write: {error}"))?;
    if observe_cancellation {
        crate::cancellation::check()?;
    }
    let _stdout_flags = Flags::nonblocking(descriptors[0])?;
    let _stderr_flags = Flags::nonblocking(descriptors[1])?;
    let buffers = [stdout, stderr];
    let mut offsets = [0_usize; 2];
    while offsets[0] < stdout.len() || offsets[1] < stderr.len() {
        let mut fds = [
            libc::pollfd {
                fd: if offsets[0] < stdout.len() {
                    descriptors[0]
                } else {
                    -1
                },
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: if offsets[1] < stderr.len() {
                    descriptors[1]
                } else {
                    -1
                },
                events: libc::POLLOUT,
                revents: 0,
            },
        ];
        check("native-output-before-poll")
            .map_err(|error| format!("bounded output write: {error}"))?;
        poll_with_cancellation(&mut fds, deadline, observe_cancellation)
            .map_err(|e| format!("bounded output write: {e}"))?;
        check("native-output-after-poll")
            .map_err(|error| format!("bounded output write: {error}"))?;
        for index in 0..2 {
            if fds[index].revents == 0 {
                continue;
            }
            check("native-output-before-write")
                .map_err(|error| format!("bounded output write: {error}"))?;
            if Instant::now() >= deadline {
                return Err("bounded output write: request deadline expired".into());
            }
            let bytes =
                &buffers[index][offsets[index]..buffers[index].len().min(offsets[index] + 16_384)];
            // SAFETY: bytes is readable for its length; stdio remains live and nonblocking.
            let count =
                unsafe { libc::write(descriptors[index], bytes.as_ptr().cast(), bytes.len()) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    return Err(format!("native output write: {error}"));
                }
            } else if count == 0 {
                return Err("native output write made no progress".into());
            } else {
                offsets[index] += count as usize;
            }
        }
    }
    check("native-output-complete").map_err(|error| format!("bounded output write: {error}"))?;
    Ok(())
}

pub fn write_native(
    stdout: &[u8],
    stderr: &[u8],
    original: &caws_native::monotonic_deadline::MonotonicDeadline,
    until: Instant,
) -> Result<(), String> {
    write_native_checked(stdout, stderr, original, until, true)
}
fn write_native_checked(
    stdout: &[u8],
    stderr: &[u8],
    original: &caws_native::monotonic_deadline::MonotonicDeadline,
    until: Instant,
    observe_cancellation: bool,
) -> Result<(), String> {
    let until = until.min(original.expires());
    write_output(
        stdout,
        stderr,
        until,
        observe_cancellation,
        [libc::STDOUT_FILENO, libc::STDERR_FILENO],
        &mut |_| check_until(original, until),
    )
}

/// A validated target keeps its earned output-loss policy; original expiry can
/// still hold its later signal. There is no renewed terminal delivery window.
pub fn write_terminal_native(
    stdout: &[u8],
    stderr: &[u8],
    _target: &crate::process_effect::ValidatedTarget,
    original: &caws_native::monotonic_deadline::MonotonicDeadline,
    until: Instant,
) -> Result<(), String> {
    write_native_checked(stdout, stderr, original, until, false)
}

pub fn write_diagnostic(
    stderr: &[u8],
    original: &caws_native::monotonic_deadline::MonotonicDeadline,
    until: Instant,
) {
    let until = cap_until(original, until, DIAGNOSTIC_BUDGET);
    let _ = write_native_checked(&[], stderr, original, until, false);
}

/// Invalid configuration has no honest original clock. One nonblocking attempt
/// per descriptor reports what it can; it does not mint a replacement interval.
pub fn write_unclocked_configuration(stdout: &[u8], stderr: &[u8]) -> Result<(), String> {
    let _stdout_flags = Flags::nonblocking(libc::STDOUT_FILENO)?;
    let _stderr_flags = Flags::nonblocking(libc::STDERR_FILENO)?;
    for (fd, bytes) in [(libc::STDOUT_FILENO, stdout), (libc::STDERR_FILENO, stderr)] {
        if bytes.is_empty() {
            continue;
        }
        let mut fds = [libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        }];
        if unsafe { libc::poll(fds.as_mut_ptr(), 1, 0) } < 0 || fds[0].revents == 0 {
            return Err("configuration output unavailable without waiting".into());
        }
        let bytes = &bytes[..bytes.len().min(16_384)];
        let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if count != bytes.len() as isize {
            return Err("configuration output partial or unavailable; not retried".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use caws_native::owned_group::{GroupObservation, GroupStop, StopError, StopStage};
    use std::{collections::VecDeque, os::unix::process::ExitStatusExt, path::PathBuf};

    // Pure operations at the same seam used by ChildCleanup. No Child, waitid,
    // signal, real sleep, or privileged fault injection is involved.
    struct CleanupFixture {
        stops: VecDeque<Result<GroupStop, StopError>>,
        waits: VecDeque<io::Result<Option<std::process::ExitStatus>>>,
        elapsed: Duration,
        calls: Vec<&'static str>,
    }
    impl CleanupFixture {
        fn new(
            stops: Vec<Result<GroupStop, StopError>>,
            waits: Vec<io::Result<Option<std::process::ExitStatus>>>,
        ) -> Self {
            Self {
                stops: stops.into(),
                waits: waits.into(),
                elapsed: Duration::ZERO,
                calls: Vec::new(),
            }
        }
    }
    impl CleanupOperations for CleanupFixture {
        fn stop(&mut self) -> Result<GroupStop, StopError> {
            self.calls.push("stop");
            self.stops.pop_front().expect("unexpected extra stop")
        }

        fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
            self.calls.push("wait");
            self.waits.pop_front().unwrap_or(Ok(None))
        }

        fn elapsed(&self) -> Duration {
            self.elapsed
        }

        fn pause(&mut self) {
            self.calls.push("pause");
            self.elapsed += Duration::from_millis(2);
            assert!(
                self.elapsed <= Duration::from_secs(1),
                "injected cleanup exceeded its bound"
            );
        }
    }

    fn stop_refusal() -> StopError {
        StopError {
            stage: StopStage::ExitedGroup,
            raw_errno: Some(libc::EIO),
            signal_errno: Some(libc::EPERM),
            observed_pid: Some(123),
            observed_code: Some(libc::CLD_EXITED),
            group: Some(GroupObservation {
                reason: 4,
                query_errno: libc::ENOMEM,
                bytes: 64,
                capacity: 64,
                members: 2,
                zombies: 1,
                leaders: 1,
            }),
        }
    }

    #[test]
    fn cleanup_state_failure_never_becomes_completion() {
        let mut state = CleanupState::default();
        let mut attempts = 0;
        for _ in 0..2 {
            let result: Result<(), String> = state.cleanup_with(|| {
                attempts += 1;
                Err("injected cleanup refusal".into())
            });
            assert_eq!(result, Err("injected cleanup refusal".into()));
            assert!(
                state.pending(),
                "failed attempt must remain eligible for Drop cleanup"
            );
        }
        assert_eq!(attempts, 2);
    }

    #[test]
    fn cleanup_stop_refusal_preserves_all_fields_and_never_reaps() {
        let expected = stop_refusal();
        let mut ops =
            CleanupFixture::new(vec![Err(expected.clone()), Err(expected.clone())], vec![]);
        let mut state = CleanupState::default();
        for _ in 0..2 {
            let error = state.finish_with(|| cleanup_attempt(&mut ops)).unwrap_err();
            assert_eq!(error.to_string(), format!("engine cleanup: {expected}"));
            match error {
                CleanupFailure::Stop(actual) => assert_eq!(actual, expected),
                other => panic!("lost stop failure: {other:?}"),
            }
            assert!(state.pending());
        }
        assert_eq!(ops.calls, ["stop", "stop"]);
        assert_eq!(ops.elapsed, Duration::ZERO);
    }

    #[test]
    fn cleanup_reap_errors_stay_errors_on_retry() {
        let mut ops = CleanupFixture::new(
            vec![Ok(GroupStop::Signalled), Ok(GroupStop::Absent)],
            vec![
                Err(io::Error::from_raw_os_error(libc::EIO)),
                Err(io::Error::from_raw_os_error(libc::ECHILD)),
            ],
        );
        let mut state = CleanupState::default();
        for expected in [libc::EIO, libc::ECHILD] {
            match state
                .cleanup_with(|| cleanup_attempt(&mut ops))
                .unwrap_err()
            {
                CleanupFailure::Reap(error) => assert_eq!(error.raw_os_error(), Some(expected)),
                other => panic!("lost reap failure: {other:?}"),
            }
            assert!(state.pending());
        }
        assert_eq!(ops.calls, ["stop", "wait", "stop", "wait"]);
    }

    #[test]
    fn cleanup_retry_caches_actual_exit_without_second_stop_or_reap() {
        let actual = std::process::ExitStatus::from_raw(42 << 8);
        let mut ops = CleanupFixture::new(
            vec![Ok(GroupStop::Signalled), Ok(GroupStop::Absent)],
            vec![
                Err(io::Error::from_raw_os_error(libc::EINTR)),
                Ok(Some(actual)),
            ],
        );
        let mut state = CleanupState::default();
        assert!(matches!(
            state.finish_with(|| cleanup_attempt(&mut ops)),
            Err(CleanupFailure::Reap(_))
        ));
        assert!(state.pending());
        let returned = state.finish_with(|| cleanup_attempt(&mut ops)).unwrap();
        assert_eq!(returned, actual);
        assert_eq!(returned.code(), Some(42));
        assert!(!state.pending());
        assert_eq!(
            state.finish_with(|| cleanup_attempt(&mut ops)).unwrap(),
            actual
        );
        state.cleanup_with(|| cleanup_attempt(&mut ops)).unwrap();
        assert_eq!(ops.calls, ["stop", "wait", "stop", "wait"]);
        assert!(ops.stops.is_empty());
        assert!(ops.waits.is_empty());
    }

    #[test]
    fn cleanup_timeout_remains_pending_at_unchanged_budget_then_can_retry() {
        let mut ops = CleanupFixture::new(vec![Ok(GroupStop::Signalled)], vec![]);
        let mut state = CleanupState::default();
        assert!(matches!(
            state.cleanup_with(|| cleanup_attempt(&mut ops)),
            Err(CleanupFailure::Deadline(GroupStop::Signalled))
        ));
        assert!(state.pending());
        assert_eq!(CLEANUP_BUDGET, Duration::from_millis(500));
        assert_eq!(ops.elapsed, CLEANUP_BUDGET);
        assert_eq!(ops.calls.iter().filter(|&&s| s == "stop").count(), 1);
        assert_eq!(ops.calls.iter().filter(|&&s| s == "wait").count(), 251);
        assert_eq!(ops.calls.iter().filter(|&&s| s == "pause").count(), 250);
        ops.stops.push_back(Ok(GroupStop::Absent));
        let actual = std::process::ExitStatus::from_raw(0);
        ops.waits.push_back(Ok(Some(actual)));
        assert_eq!(
            state.finish_with(|| cleanup_attempt(&mut ops)).unwrap(),
            actual
        );
        assert!(!state.pending());
        assert_eq!(&ops.calls[ops.calls.len() - 2..], ["stop", "wait"]);
    }

    #[test]
    fn cleanup_absent_and_exited_only_do_not_substitute_for_reap() {
        let observation = GroupObservation {
            members: 3,
            zombies: 3,
            leaders: 1,
            bytes: 96,
            capacity: 128,
            ..GroupObservation::default()
        };
        for stop in [GroupStop::Absent, GroupStop::ExitedOnly { observation }] {
            let mut ops = CleanupFixture::new(vec![Ok(stop)], vec![]);
            let mut state = CleanupState::default();
            match state.finish_with(|| cleanup_attempt(&mut ops)).unwrap_err() {
                CleanupFailure::Deadline(actual) => assert_eq!(actual, stop),
                other => panic!("stop observation lost: {other:?}"),
            }
            assert!(state.pending());
            assert_eq!(ops.elapsed, CLEANUP_BUDGET);
            assert!(ops.calls.contains(&"wait"));
        }
    }

    #[test]
    fn reserve_stays_inside_original_interval_and_short_calls_keep_processing_time() {
        use caws_native::monotonic_deadline::MonotonicDeadline;
        for duration in [
            Duration::from_millis(20),
            Duration::from_millis(2000),
            Duration::from_secs(30),
        ] {
            let original = MonotonicDeadline::capture(duration).unwrap();
            let envelope = original.envelope();
            let bounds = CallbackBounds::original(&original);
            assert!(bounds.processing < bounds.terminal);
            assert!(bounds.terminal < bounds.cleanup);
            assert!(bounds.cleanup < original.expires());
            assert!(original.expires() - bounds.processing <= duration / 2);
            assert_eq!(original.envelope(), envelope);
            assert!(check_until(&original, bounds.processing).is_ok());
        }
    }

    #[test]
    fn output_checks_original_clock_after_poll_and_before_each_chunk() {
        use std::io::Read;
        use std::os::unix::net::UnixStream;
        for failure in [
            "Original monotonic deadline expired",
            "CLOCK_MONOTONIC unavailable",
        ] {
            for stage in ["native-output-after-poll", "native-output-before-write"] {
                let (mut reader, writer) = UnixStream::pair().unwrap();
                let (_error_reader, error_writer) = UnixStream::pair().unwrap();
                let mut stages = Vec::new();
                let result = write_output(
                    b"must remain withheld",
                    &[],
                    Instant::now() + Duration::from_secs(1),
                    false,
                    [writer.as_raw_fd(), error_writer.as_raw_fd()],
                    &mut |observed| {
                        stages.push(observed);
                        if observed == stage {
                            Err(failure.into())
                        } else {
                            Ok(())
                        }
                    },
                );
                assert_eq!(
                    result.unwrap_err(),
                    format!("bounded output write: {failure}")
                );
                assert!(stages.contains(&stage));
                drop(writer);
                let mut output = Vec::new();
                reader.read_to_end(&mut output).unwrap();
                assert!(output.is_empty(), "{stage}: bytes escaped after {failure}");
            }
        }
        let (mut reader, writer) = UnixStream::pair().unwrap();
        let (_error_reader, error_writer) = UnixStream::pair().unwrap();
        let mut chunks = 0;
        let result = write_output(
            &vec![b'x'; 32_768],
            &[],
            Instant::now() + Duration::from_secs(1),
            false,
            [writer.as_raw_fd(), error_writer.as_raw_fd()],
            &mut |stage| {
                if stage == "native-output-before-poll" {
                    chunks += 1;
                    if chunks == 2 {
                        return Err("Original monotonic deadline expired".into());
                    }
                }
                Ok(())
            },
        );
        assert_eq!(
            result.unwrap_err(),
            "bounded output write: Original monotonic deadline expired"
        );
        assert_eq!(chunks, 2);
        drop(writer);
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        // A nonblocking socket may accept a partial first chunk. Fail before
        // polling again rather than waiting for an undrained socket to refill.
        assert!((1..=16_384).contains(&output.len()));
        assert_eq!(
            output,
            vec![b'x'; output.len()],
            "only the accepted first prefix may escape"
        );
    }

    #[test]
    fn output_live_clock_control_preserves_exact_bytes() {
        use std::io::Read;
        use std::os::unix::net::UnixStream;
        let (mut reader, writer) = UnixStream::pair().unwrap();
        let (_error_reader, error_writer) = UnixStream::pair().unwrap();
        write_output(
            b"exact\0native",
            &[],
            Instant::now() + Duration::from_secs(1),
            false,
            [writer.as_raw_fd(), error_writer.as_raw_fd()],
            &mut |_| Ok(()),
        )
        .unwrap();
        drop(writer);
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        assert_eq!(output, b"exact\0native");
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    fn session(engine: &str) -> Session {
        let config = Config {
            node: PathBuf::from("/bin/cat"),
            engine: PathBuf::from(engine),
            surface: "codex".into(),
            event: "pre_tool_use".into(),
            configuration: "system".into(),
            digest: "a".repeat(64),
            timeout: Duration::from_secs(10),
        };
        // The unit-test executable is libtest, not the production custodian
        // entrypoint. Actual custody is qualified through the built binary.
        let original =
            caws_native::monotonic_deadline::MonotonicDeadline::capture(config.timeout).unwrap();
        Session::start_inner(&config, "runner-unit", &original, false).unwrap()
    }

    #[test]
    fn expired_earlier_bound_does_not_consume_a_buffered_frame() {
        let mut session = session("/dev/stdin");
        session.buffered.extend_from_slice(b"queued\nnext\n");
        assert!(session.original_deadline.check().is_ok());
        assert_eq!(
            session
                .frame(Instant::now() - Duration::from_millis(1))
                .unwrap_err(),
            "request deadline expired"
        );
        assert_eq!(session.buffered, b"queued\nnext\n");
        assert_eq!(session.examined_bytes, 0);
        let until = session.original_deadline.expires();
        assert_eq!(session.frame(until).unwrap(), b"queued");
        assert_eq!(session.frame(until).unwrap(), b"next");
    }

    #[test]
    fn buffered_data_and_empty_send_cannot_outlive_the_retained_clock() {
        let mut session = session("/dev/stdin");
        // Expire only this private transport test seam; its child and the
        // caller's later Instant remain live.
        session.original_deadline =
            caws_native::monotonic_deadline::MonotonicDeadline::capture(Duration::from_millis(1))
                .unwrap();
        session.buffered.extend_from_slice(b"queued\n");
        std::thread::sleep(Duration::from_millis(2));
        let later = Instant::now() + Duration::from_secs(1);
        assert_eq!(
            session.frame(later).unwrap_err(),
            "Original monotonic deadline expired"
        );
        assert_eq!(session.buffered, b"queued\n");
        assert_eq!(session.examined_bytes, 0);
        assert!(session.send(b"", later).is_err());
    }

    #[test]
    fn fragmented_frame_examines_each_received_byte_once() {
        let mut session = session("/dev/stdin");
        let mut expected = Vec::new();
        for byte in b"opaque fragmented frame" {
            session.buffered.push(*byte);
            expected.push(*byte);
            assert!(session.buffered_frame().unwrap().is_none());
            assert_eq!(session.examined_bytes, expected.len());
            assert!(session.buffered_frame().unwrap().is_none());
            assert_eq!(session.examined_bytes, expected.len());
        }
        session.buffered.push(b'\n');
        assert_eq!(session.frame(deadline()).unwrap(), expected);
        assert_eq!(session.examined_bytes, expected.len() + 1);
        assert!(session.buffered.is_empty());
        println!(
            "scan evidence: received={}, examined={}",
            expected.len() + 1,
            session.examined_bytes
        );
    }

    #[test]
    fn queued_frames_and_fragmented_tail_preserve_order_and_scan_work() {
        let mut session = session("/dev/stdin");
        session.buffered.extend_from_slice(b"one\ntwo\ntai");
        assert_eq!(session.frame(deadline()).unwrap(), b"one");
        assert_eq!(session.frame(deadline()).unwrap(), b"two");
        assert!(session.buffered_frame().unwrap().is_none());
        assert_eq!(session.examined_bytes, 11);
        session.buffered.extend_from_slice(b"l\nnext\n");
        assert_eq!(session.frame(deadline()).unwrap(), b"tail");
        assert_eq!(session.frame(deadline()).unwrap(), b"next");
        assert_eq!(session.examined_bytes, 18);
        assert!(session.buffered.is_empty());
    }

    #[test]
    fn real_pipe_frames_preserve_opaque_bytes_and_queued_tail() {
        let mut session = session("/dev/stdin");
        let expires = deadline();
        session.send(b"first\n{\n\xff\0tail", expires).unwrap();
        assert_eq!(session.frame(expires).unwrap(), b"first");
        assert_eq!(session.frame(expires).unwrap(), b"{");
        session.send(b"-end\n", expires).unwrap();
        assert_eq!(session.frame(expires).unwrap(), b"\xff\0tail-end");
        assert_eq!(session.examined_bytes, b"first\n{\n\xff\0tail-end\n".len());
    }

    #[test]
    fn empty_frame_does_not_hide_the_following_frame() {
        let mut session = session("/dev/stdin");
        let expires = deadline();
        session.send(b"\nfollowing\n", expires).unwrap();
        assert_eq!(session.frame(expires).unwrap_err(), "empty engine frame");
        assert_eq!(session.frame(expires).unwrap(), b"following");
        assert_eq!(session.examined_bytes, b"\nfollowing\n".len());
    }

    #[test]
    fn incomplete_tail_at_eof_is_not_a_frame() {
        let mut session = session("/dev/null");
        session.buffered.extend_from_slice(b"unfinished");
        assert_eq!(
            session.frame(deadline()).unwrap_err(),
            "engine stream closed before a complete frame"
        );
        assert_eq!(session.buffered, b"unfinished");
        assert_eq!(session.examined_bytes, b"unfinished".len());
    }

    #[test]
    fn real_pipe_accepts_the_existing_frame_byte_boundary() {
        let mut session = session("/dev/stdin");
        let expires = deadline();
        let mut wire = vec![b'x'; MAX_FRAME - 1];
        wire.push(b'\n');
        session.send(&wire, expires).unwrap();
        let frame = session.frame(expires).unwrap();
        assert_eq!(frame, wire[..wire.len() - 1]);
        assert_eq!(session.examined_bytes, MAX_FRAME);
    }

    #[test]
    fn real_pipe_rejects_bytes_past_the_existing_frame_budget() {
        let mut session = session("/dev/stdin");
        let expires = deadline();
        let wire = vec![b'x'; MAX_FRAME + 1];
        let outcome = session
            .send(&wire, expires)
            .and_then(|()| session.frame(expires).map(|_| ()));
        assert_eq!(
            outcome.unwrap_err(),
            format!("pipe exceeded {MAX_FRAME} byte budget")
        );
    }

    #[test]
    fn validated_control_credit_preserves_a_full_later_proposal_and_has_a_fixed_cap() {
        let mut session = session("/dev/stdin");
        let expires = deadline();
        let mut control = vec![b'c'; 90_000];
        control.push(b'\n');
        session.send(&control, expires).unwrap();
        assert_eq!(
            session.frame(expires).unwrap(),
            control[..control.len() - 1]
        );
        session.credit_session_cache_control(control.len()).unwrap();
        let mut proposal = vec![b'p'; MAX_FRAME - 1];
        proposal.push(b'\n');
        session.send(&proposal, expires).unwrap();
        assert_eq!(
            session.frame(expires).unwrap(),
            proposal[..proposal.len() - 1]
        );
        let remaining =
            caws_native::session_cache_wire::MAX_EXTRA_ENGINE_STDOUT_BYTES - control.len();
        session.credit_session_cache_control(remaining).unwrap();
        assert_eq!(
            session.credit_session_cache_control(1).unwrap_err(),
            "cache control credit exceeds one exchange"
        );
    }

    #[test]
    fn late_stop_context_credit_is_dedicated_single_use_and_overlap_is_refused() {
        let mut current = session("/dev/stdin");
        current.begin_stop_lease_context(512).unwrap();
        assert_eq!(current.stop_lease_context_control_credit, 512);
        assert_eq!(current.context_git_control_credit, 0);
        assert_eq!(current.cache_control_credit, 0);
        assert_eq!(
            current.begin_stop_lease_context(512).unwrap_err(),
            "Stop lease context request already consumed"
        );
        current.buffered.extend_from_slice(b"forged next frame");
        assert!(
            current
                .stop_lease_context_checkpoint(deadline())
                .unwrap_err()
                .contains("overlapped")
        );
        let mut oversized = session("/dev/stdin");
        assert!(
            oversized
                .begin_stop_lease_context(crate::protocol::MAX_STOP_LEASE_CONTEXT_REQUEST + 2)
                .is_err()
        );
        assert_eq!(oversized.stop_lease_context_control_credit, 0);
        assert!(oversized.begin_stop_lease_context(1).is_err());
    }

    #[test]
    fn uncredited_output_still_exhausts_the_original_total_budget() {
        let mut session = session("/dev/stdin");
        let expires = deadline();
        let mut control = vec![b'c'; 90_000];
        control.push(b'\n');
        session.send(&control, expires).unwrap();
        assert_eq!(session.frame(expires).unwrap().len(), 90_000);
        let mut proposal = vec![b'p'; MAX_FRAME - 1];
        proposal.push(b'\n');
        let outcome = session
            .send(&proposal, expires)
            .and_then(|()| session.frame(expires).map(|_| ()));
        assert_eq!(
            outcome.unwrap_err(),
            "engine stream exceeded total byte budget"
        );
    }

    #[test]
    fn publication_credit_preserves_raw_delimiters_and_separate_fixed_budget() {
        use caws_native::session_publication::Transport;
        let mut session = session("/dev/stdin");
        let expires = deadline();
        let mut bytes = vec![b'p'; 1024 * 1024];
        bytes.extend_from_slice(b"\r\n");
        for _ in 0..5 {
            session.send(&bytes, expires).unwrap();
            let received = Transport::read(&mut session, expires).unwrap();
            assert_eq!(
                received, bytes,
                "credit must account for exact consumed CR/LF"
            );
            Transport::credit(&mut session, received.len()).unwrap();
        }
        assert_eq!(session.publication_control_credit, bytes.len() * 5);
        assert_eq!(session.cache_control_credit, 0);
        #[cfg(feature = "sqlite-store")]
        assert_eq!(session.store_control_credit, 0);
        assert!(Transport::credit(&mut session, 0).is_err());
        let maximum =
            caws_native::session_publication_wire::MAX_EXTRA_PUBLICATION_ENGINE_STDOUT_BYTES;
        let remaining = maximum - session.publication_control_credit;
        Transport::credit(&mut session, remaining).unwrap();
        assert!(Transport::credit(&mut session, 1).is_err());
        assert!(Transport::credit(&mut session, usize::MAX).is_err());
        assert_eq!(session.publication_control_credit, maximum);
        // Credit cannot enlarge a single frame even when the full operation
        // allowance remains. Owner validation is exercised by owner tests.
        let oversized = vec![b'x'; MAX_FRAME + 1];
        let outcome = session
            .send(&oversized, expires)
            .and_then(|()| Transport::read(&mut session, expires).map(|_| ()));
        assert_eq!(
            outcome.unwrap_err(),
            format!("pipe exceeded {MAX_FRAME} byte budget")
        );
    }

    #[test]
    fn cache_credit_does_not_enlarge_the_individual_frame_limit() {
        let mut session = session("/dev/stdin");
        let expires = deadline();
        session
            .credit_session_cache_control(
                caws_native::session_cache_wire::MAX_EXTRA_ENGINE_STDOUT_BYTES,
            )
            .unwrap();
        let wire = vec![b'x'; MAX_FRAME + 1];
        let outcome = session
            .send(&wire, expires)
            .and_then(|()| session.frame(expires).map(|_| ()));
        assert_eq!(
            outcome.unwrap_err(),
            format!("pipe exceeded {MAX_FRAME} byte budget")
        );
    }

    #[test]
    fn waiting_for_a_frame_retains_the_request_deadline() {
        let mut session = session("/dev/stdin");
        assert_eq!(
            session
                .frame(Instant::now() - Duration::from_millis(1))
                .unwrap_err(),
            "request deadline expired"
        );
        assert_eq!(session.examined_bytes, 0);
    }
}

/// Original-frontend capabilities, captured before Node and activated only by
/// the late Render phase. This owner remains outside each temporary transport
/// wrapper so an interrupted Git query retains its actual cleanup custody.
#[derive(Default)]
pub(crate) struct OriginalRenderPreparation {
    owner: Option<caws_native::render_observation::ObservationOwner>,
    capture_failure: Option<Box<caws_native::render_observation::Failure>>,
}
impl OriginalRenderPreparation {
    fn capture(
        original: &caws_native::session_cache_wire::OriginalStopCapture<'_>,
        executor: &caws_native::invocation_project::SelectedExecutable,
    ) -> Self {
        let cwd =
            caws_native::invocation_project::payload_string(original.original_payload(), "cwd");
        let result = (|| {
            let cwd = cwd?
                .filter(|value| !value.is_empty())
                .ok_or("Original Render requires captured absolute payload cwd")?;
            if !std::path::Path::new(&cwd).is_absolute()
                || std::path::Path::new(&cwd) != original.query_cwds()[0]
            {
                return Err("Original Render cwd differs from original queried candidate".into());
            }
            Ok(cwd)
        })();
        match result {
            Ok(cwd) => Self::capture_inputs(
                original.id(),
                original.runtime_digest(),
                original.caller_cwd(),
                &cwd,
                original.caller_environment(),
                &executor.path,
                CallbackBounds::original(original.deadline()).processing,
            ),
            Err(diagnostic) => Self {
                owner: None,
                capture_failure: Some(Box::new(caws_native::render_observation::Failure {
                    category: "capture",
                    diagnostic,
                    git: None,
                    calendar: None,
                })),
            },
        }
    }
    fn capture_inputs(
        id: &str,
        runtime_digest: &str,
        caller_cwd: &str,
        cwd: &str,
        environment: &std::collections::BTreeMap<String, String>,
        executor: &std::path::Path,
        expires: Instant,
    ) -> Self {
        use caws_native::{
            render_context as git, render_observation as observation, renderer_calendar as calendar,
        };
        let cancelled = || crate::cancellation::check().is_err();
        let result = (|| {
            let git = git::CapturedRenderContext::capture(
                git::OriginalInvocation {
                    id: id.into(),
                    runtime_digest: runtime_digest.into(),
                    caller_cwd: caller_cwd.into(),
                    cwd: cwd.into(),
                    environment: environment.clone(),
                },
                expires,
                &cancelled,
            )
            .and_then(|captured| captured.custodied(executor, &cancelled))
            .map_err(|failure| observation::Failure {
                category: "capture",
                diagnostic: failure.diagnostic.clone(),
                git: Some(failure),
                calendar: None,
            })?;
            let calendar = calendar::CapturedCalendar::capture(calendar::OriginalInvocation {
                id: id.into(),
                runtime_digest: runtime_digest.into(),
                deadline: expires,
                max_queries: calendar::MAX_TOTAL_QUERIES,
            })
            .map_err(|failure| observation::Failure {
                category: "calendar",
                diagnostic: failure.to_string(),
                git: None,
                calendar: Some(failure),
            })?;
            observation::ObservationOwner::new(git, calendar, expires)
        })();
        match result {
            Ok(owner) => Self {
                owner: Some(owner),
                capture_failure: None,
            },
            Err(failure) => Self {
                owner: None,
                capture_failure: Some(Box::new(failure)),
            },
        }
    }
    pub(crate) fn available(&self) -> bool {
        self.owner
            .as_ref()
            .is_some_and(|owner| owner.failure().is_none())
            && self.capture_failure.is_none()
    }
    /// Missing original ownership cannot enter a native effect operation. The
    /// returned error is terminal after dispatch; it never requests replay.
    pub(crate) fn with_transport<T, R>(
        &mut self,
        inner: &mut T,
        cancelled: &dyn Fn() -> bool,
        operation: impl FnOnce(&mut caws_native::render_observation::ObservationTransport<'_, T>) -> R,
    ) -> Result<R, String>
    where
        T: caws_native::session_publication::Transport,
    {
        if !self.available() {
            return Err("Original Render ownership unavailable; native Stop cannot publish".into());
        }
        let owner = self
            .owner
            .as_mut()
            .ok_or("Native Stop requires original Render observations")?;
        Ok(operation(&mut owner.transport(inner, cancelled)))
    }
    fn cleanup_settled(&self) -> bool {
        self.capture_failure
            .as_ref()
            .is_none_or(|failure| failure.cleanup_settled())
            && self
                .owner
                .as_ref()
                .is_none_or(|owner| owner.cleanup_settled())
    }
    fn retry_cleanup_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        let capture = self.capture_failure.as_mut().map_or(Ok(()), |failure| {
            failure.retry_cleanup_until(original, until)
        });
        let owner = self
            .owner
            .as_mut()
            .map_or(Ok(()), |owner| owner.retry_cleanup_until(original, until));
        match (capture, owner) {
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
    fn retry_cleanup(&mut self) -> Result<(), String> {
        // Evaluate both: the first failed cleanup must not strand another owner.
        let capture = self
            .capture_failure
            .as_mut()
            .map_or(Ok(()), |failure| failure.retry_cleanup());
        let owner = self
            .owner
            .as_mut()
            .map_or(Ok(()), |owner| owner.retry_cleanup());
        match (capture, owner) {
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
}

/// Optional original observation, never publication eligibility. A failed
/// preparation remains failed while the existing compatibility route may run.
/// Keeping this owner through native output/fallback also keeps remote custody.
pub struct OriginalStopPreparation<'deadline> {
    pub generation: Option<crate::native_generation::GenerationReceipt>,
    pub original: Option<caws_native::session_cache_wire::OriginalStopCapture<'deadline>>,
    pub failure: Option<Box<caws_native::session_cache_wire::OriginalStopCaptureFailure>>,
    pub refusal: Option<String>,
    pub(crate) render: OriginalRenderPreparation,
}
impl<'deadline> OriginalStopPreparation<'deadline> {
    pub fn candidate(config: &Config) -> bool {
        cfg!(target_os = "macos")
            && config.configuration == "system"
            && config.surface == "opencode"
            && config.event == "stop"
    }
    pub(crate) fn capture_with_diagnostics(
        config: &Config,
        request: &crate::protocol::Request,
        deadline: &'deadline caws_native::monotonic_deadline::MonotonicDeadline,
        supplied_generation: Option<crate::native_generation::GenerationReceipt>,
        generation_receipt_revalidations: crate::native_generation::CheckTimings,
        mut phase: impl FnMut(&'static str),
    ) -> Self {
        let processing = CallbackBounds::original(deadline).processing;
        let mut prepared = Self {
            generation: supplied_generation,
            original: None,
            failure: None,
            refusal: None,
            render: OriginalRenderPreparation::default(),
        };
        if !Self::candidate(config) {
            return prepared;
        }
        let generation = match prepared.generation.take() {
            Some(generation) => generation,
            None => {
                let home = match Self::generation_home(request) {
                    Ok(home) => home,
                    Err(error) => {
                        prepared.refusal = Some(error);
                        return prepared;
                    }
                };
                phase("generation-capture");
                match crate::native_generation::GenerationReceipt::capture_with_diagnostics(
                    &home,
                    config,
                    deadline.expires(),
                    generation_receipt_revalidations,
                    || {
                        crate::cancellation::check()?;
                        check_until(deadline, processing)
                    },
                ) {
                    Ok(generation) => generation,
                    Err(error) => {
                        prepared.refusal = Some(error);
                        return prepared;
                    }
                }
            }
        };
        phase("original-executor");
        let executor = match generation.selected_native_executor(deadline.expires(), || {
            crate::cancellation::check()?;
            check_until(deadline, processing)
        }) {
            Ok(value) => value,
            Err(error) => {
                prepared.generation = Some(generation);
                prepared.refusal = Some(error);
                return prepared;
            }
        };
        phase("original-context-capture");
        let result = caws_native::session_cache_wire::OriginalStopCapture::capture(
            request.original_stop_input(),
            &executor,
            deadline,
            || {
                crate::cancellation::check()?;
                check_until(deadline, processing)
            },
        );
        prepared.generation = Some(generation);
        match result {
            Ok(original) => {
                phase("original-render-capture");
                prepared.render = OriginalRenderPreparation::capture(&original, &executor);
                prepared.original = Some(original);
            }
            Err(error) => {
                prepared.refusal = Some(error.to_string());
                prepared.failure = Some(Box::new(error));
            }
        }
        prepared
    }
    pub(crate) fn generation_home(
        request: &crate::protocol::Request,
    ) -> Result<std::path::PathBuf, String> {
        let environment = request.caller_environment();
        let home = match environment
            .get("CAWS_HOME")
            .filter(|value| !value.is_empty())
        {
            Some(value) => std::path::PathBuf::from(value),
            None => match environment.get("HOME").filter(|value| !value.is_empty()) {
                Some(value) => std::path::PathBuf::from(value).join(".caws"),
                None => return Err("original machine home unavailable".into()),
            },
        };
        if !home.is_absolute() {
            return Err("original machine home must be absolute".into());
        }
        Ok(home)
    }

    pub fn cleanup_settled(&self) -> bool {
        self.failure.as_ref().is_none_or(|e| e.cleanup_settled()) && self.render.cleanup_settled()
    }
    pub fn retry_cleanup_until(
        &mut self,
        original: &caws_native::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        let capture = self.failure.as_mut().map_or(Ok(()), |failure| {
            failure.retry_cleanup_until(original, until)
        });
        let render = self.render.retry_cleanup_until(original, until);
        match (capture, render) {
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        let original = self.failure.as_mut().map_or(Ok(()), |e| e.retry_cleanup());
        let render = self.render.retry_cleanup();
        match (original, render) {
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod original_stop_preparation_tests {
    use super::*;
    #[test]
    fn optional_candidate_domain_excludes_custom_project_and_unsupported_surfaces() {
        let mut config = Config {
            engine: "/engine".into(),
            node: "/node".into(),
            surface: "opencode".into(),
            event: "stop".into(),
            configuration: "system".into(),
            digest: "a".repeat(64),
            timeout: Duration::from_secs(10),
        };
        assert_eq!(
            OriginalStopPreparation::candidate(&config),
            cfg!(target_os = "macos")
        );
        for (surface, event, configuration) in [
            ("zcode", "stop", "system"),
            ("opencode", "session_start", "system"),
            ("opencode", "stop", "project"),
            ("codex", "stop", "system"),
        ] {
            config.surface = surface.into();
            config.event = event.into();
            config.configuration = configuration.into();
            assert!(!OriginalStopPreparation::candidate(&config));
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod original_render_join_tests {
    use super::*;
    use caws_native::{
        render_observation as observation, session_publication::Transport,
        session_publication_wire as wire,
    };
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::{
        cell::Cell,
        collections::{BTreeMap, VecDeque},
    };

    const ID: &str = "original-render-preparation";
    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    fn frame(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }
    #[derive(Default)]
    struct Recording {
        writes: Vec<Value>,
        reads: VecDeque<Vec<u8>>,
    }
    impl Transport for Recording {
        fn write(&mut self, bytes: &[u8], _: Instant) -> Result<(), String> {
            self.writes.push(serde_json::from_slice(bytes).unwrap());
            Ok(())
        }
        fn read(&mut self, _: Instant) -> Result<Vec<u8>, String> {
            self.reads.pop_front().ok_or("test EOF".into())
        }
        fn credit(&mut self, _: usize) -> Result<(), String> {
            Ok(())
        }
    }
    fn capture(cwd: &str, expires: Instant) -> OriginalRenderPreparation {
        // Pinning this executable launches no custodian. This test deliberately
        // never requests Git; real native-custodian execution remains integration.
        OriginalRenderPreparation::capture_inputs(
            ID,
            &"a".repeat(64),
            "/tmp",
            cwd,
            &BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            &std::env::current_exe().unwrap(),
            expires,
        )
    }
    fn preparation(render: OriginalRenderPreparation) -> OriginalStopPreparation<'static> {
        OriginalStopPreparation {
            generation: None,
            original: None,
            failure: None,
            refusal: None,
            render,
        }
    }
    #[test]
    fn missing_original_render_never_enters_native_exchange() {
        let mut render = OriginalRenderPreparation::default();
        let mut recording = Recording::default();
        let effects = Cell::new(0);
        assert!(!render.available());
        let result = render.with_transport(&mut recording, &|| false, |_| effects.set(1));
        assert!(result.unwrap_err().contains("ownership unavailable"));
        assert_eq!(
            effects.get(),
            0,
            "missing ownership must refuse before native effects"
        );
        assert!(recording.writes.is_empty());
    }
    #[test]
    fn refused_original_render_retains_typed_capture_failure_and_disables_exchange() {
        let mut render = capture(
            "relative-render-cwd",
            Instant::now() + Duration::from_secs(10),
        );
        assert!(!render.available());
        let failure = render.capture_failure.as_ref().unwrap();
        assert_eq!(failure.category, "capture");
        assert_eq!(failure.git.as_ref().unwrap().category, "unsupported");
        assert!(failure.diagnostic.contains("CWD"));
        let diagnostic = failure.diagnostic.clone();
        let mut recording = Recording::default();
        assert!(
            render
                .with_transport(&mut recording, &|| false, |_| panic!(
                    "effect after refusal"
                ))
                .is_err()
        );
        render.retry_cleanup().unwrap();
        assert_eq!(
            render.capture_failure.as_ref().unwrap().diagnostic,
            diagnostic
        );
        assert!(render.cleanup_settled());
    }
    #[test]
    fn preparation_wraps_late_stop_ready_and_keeps_terminal_phase_failure_after_wrapper_drop() {
        let expires = Instant::now() + Duration::from_secs(10);
        let mut prepared = preparation(capture("/tmp", expires));
        assert!(prepared.render.available());
        let token = "original-token";
        let catalog = json!({"schema":"caws.runtime.stop-render-sources.v1",
            "transcriptPath":"/repo/.caws/sessions/s/.transcript-projection.jsonl",
            "audit":{"path":"/repo/.opencode/logs/audit.log","disposition":"absent"},
            "hookOutcomes":{"path":"/repo/.caws/sessions/s/hook-events.jsonl","disposition":"absent"},
            "subagents":{"claudeCandidate":{"path":"/repo/.caws/sessions/s/s/subagents","kind":"absent"},
            "qwenCandidate":{"path":"/repo/.caws/sessions/subagents/s","kind":"absent"}}});
        let input_digest =
            digest(&serde_json::to_vec(&json!({"files":[],"sourceCatalog":catalog})).unwrap());
        let tuple = |schema: &str| {
            json!({"schema":schema,"id":ID,"runtimeDigest":"a".repeat(64),
            "token":token,"attempt":"attempt","kind":"render","observationId":"b".repeat(64),
            "inputDigest":input_digest})
        };
        let prepare = json!({"schema":caws_native::session_publication::STOP_PREPARE,
            "id":ID,"runtimeDigest":"a".repeat(64),"token":token,"attempt":"attempt","kind":"render",
            "snapshot":{"observationId":"b".repeat(64),"inputDigest":input_digest,
            "sessionId":"s","reason":"exit","endedAt":"2026-10-23T00:00:00Z",
            "files":[],"priorInventory":[],"sourceCatalog":catalog}});
        let ready = json!({"schema":wire::READY,"id":ID,"runtimeDigest":"a".repeat(64),
            "token":token,"attempt":"attempt","kind":"render","direction":"inputs"});
        let mut early_prepared = tuple(wire::PREPARED);
        early_prepared["disposition"] = "ready".into();
        early_prepared["artifacts"] = json!([]);
        early_prepared["removals"] = json!([]);
        let mut recording = Recording {
            reads: VecDeque::from([frame(early_prepared)]),
            ..Default::default()
        };
        let error = prepared
            .render
            .with_transport(&mut recording, &|| false, |transport| {
                transport.write(&frame(prepare), expires).unwrap();
                transport.write(&frame(ready), expires).unwrap();
                transport.read(expires).unwrap_err()
            })
            .unwrap();
        assert!(error.contains("before Git completion"), "{error}");
        assert_eq!(recording.writes.len(), 3);
        let binding = &recording.writes[2];
        assert_eq!(binding["schema"], observation::STOP_BINDING);
        assert_eq!(binding["cwd"], "/tmp");
        assert_eq!(
            binding["calendarContext"]["originalPid"],
            std::process::id()
        );
        for (name, field) in [("TZ", "tz"), ("TZDIR", "tzdir")] {
            let expected = match std::env::var(name) {
                Ok(value) => json!({"kind":"present","value":value}),
                Err(_) => json!({"kind":"absent"}),
            };
            assert_eq!(binding["calendarContext"][field], expected);
        }
        assert_eq!(binding["sourceCatalog"], catalog);
        assert!(
            !prepared.render.available(),
            "failed owner cannot authorize another exchange"
        );
        let first = prepared
            .render
            .owner
            .as_ref()
            .unwrap()
            .failure()
            .unwrap()
            .diagnostic
            .clone();
        prepared.retry_cleanup().unwrap();
        assert!(prepared.cleanup_settled());
        assert_eq!(
            prepared
                .render
                .owner
                .as_ref()
                .unwrap()
                .failure()
                .unwrap()
                .diagnostic,
            first
        );
        let effects = Cell::new(0);
        assert!(
            prepared
                .render
                .with_transport(&mut recording, &|| false, |_| effects.set(1))
                .is_err()
        );
        assert_eq!(
            effects.get(),
            0,
            "terminal owner must not re-enter native exchange"
        );
    }
    #[test]
    fn preparation_cleanup_never_treats_unsettled_render_receipt_as_success() {
        use caws_native::{
            invocation_project::{ProjectFailure, ProjectPhase, QueryCleanup},
            render_context,
        };
        // An adversarial retained cleanup receipt, not an actual child. This
        // asserts the enclosing owner's propagation; real custody has its own tests.
        let git = render_context::Failure {
            category: "query",
            diagnostic: "retained-original".into(),
            completed: vec![],
            stdout: b"partial-original".to_vec(),
            stderr: vec![],
            remote: None,
            cause: Some(ProjectFailure {
                first_phase: ProjectPhase::Cleanup,
                first_message: "retained-original".into(),
                retained: None,
                cleanup: Box::new(QueryCleanup {
                    pid: Some(123),
                    ..Default::default()
                }),
            }),
        };
        let mut prepared = preparation(OriginalRenderPreparation {
            owner: None,
            capture_failure: Some(Box::new(observation::Failure {
                category: "capture",
                diagnostic: "retained-original".into(),
                git: Some(git),
                calendar: None,
            })),
        });
        assert!(!prepared.cleanup_settled());
        assert!(
            prepared
                .retry_cleanup()
                .unwrap_err()
                .contains("cleanup remains uncertain")
        );
        assert!(!prepared.cleanup_settled());
        let retained = prepared
            .render
            .capture_failure
            .as_ref()
            .unwrap()
            .git
            .as_ref()
            .unwrap();
        assert_eq!(retained.stdout, b"partial-original");
        assert_eq!(
            retained.cause.as_ref().unwrap().first_message,
            "retained-original"
        );
        assert!(!prepared.render.available());
    }
}
