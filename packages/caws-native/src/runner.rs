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
const DELIVERY_BUDGET: Duration = Duration::from_millis(500);

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
    let timeout = (remaining.as_millis().clamp(1, 100) as i32).min(max_wait_ms);
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
    fn pre_creation_failure(&mut self) -> Result<Option<String>, String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.pre_creation_failure(),
            Self::Direct(_) => Ok(None),
        }
    }
    fn exit_observed(&mut self) -> Result<bool, String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.exit_observed(),
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
        }
    }
    fn finish(&mut self, deadline: Instant) -> Result<std::process::ExitStatus, String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.finish(deadline),
            Self::Direct(group) => {
                let _ = deadline;
                group.finish().map_err(|error| error.to_string())
            }
        }
    }
    fn cleanup(&mut self) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Custodied(owner) => owner.cleanup(),
            Self::Direct(group) => group.cleanup().map_err(|error| error.to_string()),
        }
    }
}

pub struct Session {
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
    pub fn start(config: &Config, invocation_id: &str, deadline: Instant) -> Result<Self, String> {
        Self::start_inner(config, invocation_id, deadline, cfg!(target_os = "macos"))
    }

    fn start_inner(
        config: &Config,
        invocation_id: &str,
        deadline: Instant,
        custody: bool,
    ) -> Result<Self, String> {
        crate::cancellation::check()?;
        if Instant::now() >= deadline {
            return Err("request deadline expired before engine spawn".into());
        }
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
            let spawned =
                crate::engine_custody::Owner::spawn(config, invocation_id, render_sources)?;
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
            // SAFETY: setpgid is async-signal-safe and this closure performs no allocation.
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
                    Ok(())
                });
            }
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
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("caws-render-admission".into())
            .spawn(move || {
                let _ = sender.send(crate::render_bridge::connect(preparation, deadline));
            })
            .map_err(|e| format!("render admission thread: {e}"))?;
        let admission = loop {
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
        if Instant::now() >= deadline {
            return Err("render admission exceeded native deadline".into());
        }
        let (bridge, dispatch) = crate::render_bridge::activate(
            self.render_bank.as_mut().ok_or("render bank unavailable")?,
            admission,
            request,
        )?;
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
        if let Some(bridge) = &mut self.render_bridge {
            bridge.tick();
        }
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
        let mut written = 0;
        if let Some(bytes) = write
            && descriptors[0].revents != 0
        {
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
            let before = self.buffered.len();
            self.out_done = read_chunk(self.stdout.as_raw_fd(), &mut self.buffered, MAX_FRAME)?;
            self.stdout_bytes += self.buffered.len() - before;
            if self.stdout_bytes > MAX_FRAME + 16_384 + self.control_credit() {
                return Err("engine stream exceeded total byte budget".into());
            }
        }
        if !self.err_done && descriptors[2].revents != 0 {
            self.err_done = read_chunk(
                self.stderr.as_raw_fd(),
                &mut self.diagnostics,
                MAX_ENGINE_STDERR,
            )?;
        }
        if let Some(bridge) = &mut self.render_bridge {
            bridge.tick();
        }
        Ok(written)
    }

    pub fn send(&mut self, bytes: &[u8], deadline: Instant) -> Result<(), String> {
        let mut offset = 0;
        while offset < bytes.len() {
            offset += self.pump(Some(&bytes[offset..]), deadline)?;
        }
        Ok(())
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
        let mut pending = owner.begin(frame)?;
        let exchange: Result<(), String> = (|| {
            let credit = self
                .context_git_control_credit
                .checked_add(frame.len() + 1)
                .ok_or("context Git control credit overflow")?;
            if credit > caws_native::context_git::MAX_EXTRA_ENGINE_STDOUT_BYTES {
                return Err("context Git control credit exceeds two requests".into());
            }
            self.context_git_control_credit = credit;
            loop {
                crate::cancellation::check()?;
                // Check an already-buffered second frame/partial frame before
                // advancing the new operation, including coalesced requests.
                if !self.buffered.is_empty() {
                    return Err("engine output overlapped pending context Git request".into());
                }
                let result = pending.advance()?;
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
                if let Err(cleanup) = pending.cancel_and_settle(Instant::now() + CLEANUP_BUDGET) {
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
        let mut reply = owner.capture_json(&encoded, crate::cancellation::check)?;
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
        let sha256 = reply.sha256(crate::cancellation::check)?;
        let header = serde_json::json!({"schema":crate::protocol::SELECTION_OBSERVATION_RESULT,
            "id":request.id,"runtimeDigest":request.runtime_digest,"snapshotId":snapshot_id,
            "sequence":sequence,"byteLength":byte_len,"sha256":sha256});
        self.send_selection_frame(&header, false, deadline)?;
        let mut offset = 0usize;
        while let Some(chunk) = reply.next_chunk(64 * 1024, crate::cancellation::check)? {
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
                + self.selection_control_credit
                + self.publication_control_credit
                + self.store_control_credit
        }
        #[cfg(not(feature = "sqlite-store"))]
        {
            self.cache_control_credit
                + self.context_git_control_credit
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
        loop {
            crate::cancellation::check()?;
            if let Some(bytes) = self.buffered_frame()? {
                return Ok(bytes);
            }
            if self.out_done {
                let mut message = "engine stream closed before a complete frame".to_owned();
                if let Some(cause) = self.group.pre_creation_failure()? {
                    message.push_str("; ");
                    message.push_str(&cause);
                }
                return Err(message);
            }
            self.pump(None, deadline)?;
        }
    }

    pub fn settle(&mut self, deadline: Instant) -> Result<(), String> {
        // Pipes can close before the process exits. A nonblocking waitid observes
        // termination WITHOUT reaping, preserving ownership until group cleanup.
        loop {
            if !self.terminal_containment {
                crate::cancellation::check()?;
            }
            if self.group.exit_observed()? {
                break;
            }
            self.pump(None, deadline)?;
        }
        let status = self.group.finish(deadline)?;
        if !status.success() {
            return Err(format!(
                "engine exited unsuccessfully after proposal ({status})"
            ));
        }
        Ok(())
    }

    pub fn cleanup(&mut self) -> Result<(), String> {
        self.group.cleanup()
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
    budget: Duration,
    observe_cancellation: bool,
) -> Result<(), String> {
    if observe_cancellation {
        crate::cancellation::check()?;
    }
    let _stdout_flags = Flags::nonblocking(libc::STDOUT_FILENO)?;
    let _stderr_flags = Flags::nonblocking(libc::STDERR_FILENO)?;
    let buffers = [stdout, stderr];
    let descriptors = [libc::STDOUT_FILENO, libc::STDERR_FILENO];
    let mut offsets = [0_usize; 2];
    let deadline = Instant::now() + budget;
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
        poll_with_cancellation(&mut fds, deadline, observe_cancellation)
            .map_err(|e| format!("bounded output write: {e}"))?;
        for index in 0..2 {
            if fds[index].revents == 0 {
                continue;
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
    Ok(())
}

pub fn write_native(stdout: &[u8], stderr: &[u8]) -> Result<(), String> {
    write_output(stdout, stderr, DELIVERY_BUDGET, true)
}

/// Only the owner of a validated terminal target may use this delivery path.
/// Output closure/backpressure cannot revoke an already earned containment effect.
pub fn write_terminal_native(
    stdout: &[u8],
    stderr: &[u8],
    _target: &crate::process_effect::ValidatedTarget,
) -> Result<(), String> {
    write_output(stdout, stderr, DELIVERY_BUDGET, false)
}

pub fn write_diagnostic(stderr: &[u8]) {
    // Cancellation diagnostics are best effort with their own 100ms ceiling;
    // they must not recurse through the cancellation that caused the failure.
    let _ = write_output(&[], stderr, Duration::from_millis(100), false);
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
        Session::start_inner(&config, "runner-unit", deadline(), false).unwrap()
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

/// Optional original observation, never publication eligibility. A failed
/// preparation remains failed while the existing compatibility route may run.
/// Keeping this owner through native output/fallback also keeps remote custody.
pub struct OriginalStopPreparation<'deadline> {
    pub generation: Option<crate::native_generation::GenerationReceipt>,
    pub original: Option<caws_native::session_cache_wire::OriginalStopCapture<'deadline>>,
    pub failure: Option<Box<caws_native::session_cache_wire::OriginalStopCaptureFailure>>,
    pub refusal: Option<String>,
}
impl<'deadline> OriginalStopPreparation<'deadline> {
    pub fn candidate(config: &Config) -> bool {
        cfg!(target_os = "macos")
            && config.configuration == "system"
            && config.surface == "opencode"
            && config.event == "stop"
    }
    pub fn capture(
        config: &Config,
        request: &crate::protocol::Request,
        deadline: &'deadline caws_native::monotonic_deadline::MonotonicDeadline,
        mut phase: impl FnMut(&'static str),
    ) -> Self {
        let mut prepared = Self {
            generation: None,
            original: None,
            failure: None,
            refusal: None,
        };
        if !Self::candidate(config) {
            return prepared;
        }
        let environment = request.caller_environment();
        let home = match environment.get("CAWS_HOME").filter(|v| !v.is_empty()) {
            Some(value) => std::path::PathBuf::from(value),
            None => match environment.get("HOME") {
                Some(value) if !value.is_empty() => std::path::PathBuf::from(value).join(".caws"),
                _ => {
                    prepared.refusal = Some("original machine home unavailable".into());
                    return prepared;
                }
            },
        };
        if !home.is_absolute() {
            prepared.refusal = Some("original machine home must be absolute".into());
            return prepared;
        }
        phase("generation-capture");
        let generation = match crate::native_generation::GenerationReceipt::capture(
            &home,
            config,
            deadline.expires(),
            || {
                crate::cancellation::check()?;
                deadline.check().map_err(|e| e.to_string())
            },
        ) {
            Ok(value) => value,
            Err(error) => {
                prepared.refusal = Some(error);
                return prepared;
            }
        };
        phase("original-executor");
        let executor = match generation.selected_native_executor(deadline.expires(), || {
            crate::cancellation::check()?;
            deadline.check().map_err(|e| e.to_string())
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
            crate::cancellation::check,
        );
        prepared.generation = Some(generation);
        match result {
            Ok(original) => prepared.original = Some(original),
            Err(error) => {
                prepared.refusal = Some(error.to_string());
                prepared.failure = Some(Box::new(error));
            }
        }
        prepared
    }
    pub fn cleanup_settled(&self) -> bool {
        self.failure.as_ref().is_none_or(|e| e.cleanup_settled())
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        self.failure.as_mut().map_or(Ok(()), |e| e.retry_cleanup())
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
