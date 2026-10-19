//! Restricted terminal containment effects. Process identity is not logical-session
//! authority. Legacy second-resolution arm stamps and Darwin's recheck/kill race
//! remain qualification limits; syscall acceptance never establishes target exit.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io,
    path::Path,
    time::{Duration, Instant},
};

const MAX_ANCESTORS: usize = 16;
const CAPTURE_BUDGET: Duration = Duration::from_millis(250);
const COMM_LIMIT: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainmentIntent {
    pub schema: String,
    pub pid: u32,
    pub start_epoch: String,
    pub comm: String,
    pub session_id: String,
    pub latch_path: String,
    pub latch_generation: String,
}
impl ContainmentIntent {
    pub fn validate(&self) -> Result<(), String> {
        let text = |s: &str, max| !s.is_empty() && s.len() <= max && !s.contains('\0');
        if self.schema != "caws.containment.intent.v1"
            || self.pid == 0
            || self.pid > i32::MAX as u32
            || !text(&self.start_epoch, 20)
            || self.start_epoch.starts_with('0')
            || !self.start_epoch.bytes().all(|b| b.is_ascii_digit())
            || !text(&self.comm, COMM_LIMIT)
            || !text(&self.session_id, 128)
            || self.session_id == "unknown"
            || !text(&self.latch_path, 4096)
            || !Path::new(&self.latch_path).is_absolute()
            || self.latch_generation.len() != 32
            || !self
                .latch_generation
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid containment intent".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HeldReason {
    SignalAccepted,
    NotCaptured,
    UnsafeTarget,
    IdentityMismatch,
    ObservationUnavailable,
    SignalFailed,
    CaptureUnavailable,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainmentReceipt {
    schema: &'static str,
    pid: u32,
    start_epoch: String,
    comm: String,
    session_id: String,
    latch_path: String,
    latch_generation: String,
    status: &'static str,
    reason: HeldReason,
    errno: Option<i32>,
}
impl ContainmentReceipt {
    pub fn held(intent: &ContainmentIntent, reason: HeldReason) -> Self {
        Self {
            schema: "caws.containment.receipt.v1",
            pid: intent.pid,
            start_epoch: intent.start_epoch.clone(),
            comm: intent.comm.clone(),
            session_id: intent.session_id.clone(),
            latch_path: intent.latch_path.clone(),
            latch_generation: intent.latch_generation.clone(),
            status: "held",
            reason,
            errno: None,
        }
    }
}

/// This checks the terminal mechanical contract, not latch/claim authority.
pub struct EffectContext<'a> {
    pub surface: &'a str,
    pub event: &'a str,
    pub active: bool,
    pub session_id: Option<&'a str>,
    pub exit_code: u8,
    pub stdout: &'a [u8],
}
pub fn eligible(intent: &ContainmentIntent, context: &EffectContext<'_>) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Block {
        decision: String,
        reason: String,
    }
    context.active
        && context.surface == "codex"
        && context.event == "pre_tool_use"
        && context.session_id == Some(intent.session_id.as_str())
        && context.exit_code == 2
        && serde_json::from_slice::<Block>(context.stdout)
            .is_ok_and(|block| block.decision == "block" && !block.reason.is_empty())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Birth {
    seconds: u64,
    precise: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Observation {
    pid: u32,
    parent: u32,
    birth: Birth,
    comm: String,
}
#[derive(Clone, Copy)]
enum LookupMode {
    Strict,
    Terminal,
}
fn checkpoint(deadline: Instant, mode: LookupMode) -> Result<(), String> {
    if matches!(mode, LookupMode::Strict) {
        crate::cancellation::check()?;
    }
    if Instant::now() >= deadline {
        return Err("process observation deadline expired".into());
    }
    Ok(())
}
trait Observer {
    fn observe(
        &mut self,
        pid: u32,
        deadline: Instant,
        mode: LookupMode,
    ) -> Result<Observation, String>;
    fn sigterm(&mut self, pid: u32) -> Result<(), i32>;
}
struct NativeObserver;
impl Observer for NativeObserver {
    fn observe(
        &mut self,
        pid: u32,
        deadline: Instant,
        mode: LookupMode,
    ) -> Result<Observation, String> {
        checkpoint(deadline, mode)?;
        let (parent, birth) = platform_birth(pid)?;
        let comm = legacy_comm(pid, deadline, mode)?;
        checkpoint(deadline, mode)?;
        if platform_birth(pid)? != (parent, birth.clone()) {
            return Err("process instance changed during observation".into());
        }
        Ok(Observation {
            pid,
            parent,
            birth,
            comm,
        })
    }
    fn sigterm(&mut self, pid: u32) -> Result<(), i32> {
        // SAFETY: only a consumed ValidatedTarget can reach this private adapter;
        // pid is positive, signed-range checked, captured and reobserved.
        if unsafe { libc::kill(pid as i32, libc::SIGTERM) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error()
                .raw_os_error()
                .filter(|n| *n > 0)
                .unwrap_or(libc::EIO))
        }
    }
}

pub struct CapturedAncestors {
    native_pid: u32,
    observations: Vec<Observation>,
    available: bool,
}
impl CapturedAncestors {
    pub fn capture(request_deadline: Instant) -> Self {
        let now = Instant::now();
        // Keep cold lookup from consuming the whole ordinary invocation budget.
        let budget = request_deadline.saturating_duration_since(now) / 4;
        let deadline = request_deadline.min(now + budget.min(CAPTURE_BUDGET));
        let native_pid = std::process::id();
        // SAFETY: getppid has no pointer arguments.
        let parent = unsafe { libc::getppid() } as u32;
        Self::capture_with(&mut NativeObserver, native_pid, parent, deadline)
    }
    fn capture_with(
        observer: &mut impl Observer,
        native_pid: u32,
        mut pid: u32,
        deadline: Instant,
    ) -> Self {
        let mut result = Self {
            native_pid,
            observations: Vec::new(),
            available: true,
        };
        let mut visited = HashSet::new();
        for _ in 0..MAX_ANCESTORS {
            if pid <= 1 {
                break;
            }
            if pid == native_pid || !visited.insert(pid) {
                result.available = false;
                break;
            }
            let row = match observer.observe(pid, deadline, LookupMode::Strict) {
                Ok(row) if row.pid == pid => row,
                _ => {
                    result.available = false;
                    break;
                }
            };
            // Recheck the previous edge so a reparented/reused intermediate
            // process cannot splice a different lineage into this capture.
            if let Some(previous) = result.observations.last() {
                match observer.observe(previous.pid, deadline, LookupMode::Strict) {
                    Ok(current) if current == *previous => (),
                    _ => {
                        result.available = false;
                        break;
                    }
                }
            }
            pid = row.parent;
            result.observations.push(row);
        }
        result
    }
    pub fn validate(&self, intent: &ContainmentIntent) -> Result<ValidatedTarget, HeldReason> {
        if intent.pid <= 1 || intent.pid == self.native_pid {
            return Err(HeldReason::UnsafeTarget);
        }
        if !self.available {
            return Err(HeldReason::CaptureUnavailable);
        }
        let observed = self
            .observations
            .iter()
            .find(|row| row.pid == intent.pid)
            .ok_or(HeldReason::NotCaptured)?;
        if observed.birth.seconds.to_string() != intent.start_epoch || observed.comm != intent.comm
        {
            return Err(HeldReason::IdentityMismatch);
        }
        Ok(ValidatedTarget {
            intent: intent.clone(),
            observed: observed.clone(),
        })
    }
}

/// Construction is private; ownership of this value is consumed by one attempt.
pub struct ValidatedTarget {
    intent: ContainmentIntent,
    observed: Observation,
}
impl ValidatedTarget {
    pub fn attempt(self, deadline: Instant) -> ContainmentReceipt {
        self.attempt_with(&mut NativeObserver, deadline)
    }
    fn attempt_with(self, observer: &mut impl Observer, deadline: Instant) -> ContainmentReceipt {
        let mut receipt =
            ContainmentReceipt::held(&self.intent, HeldReason::ObservationUnavailable);
        let current = match observer.observe(self.intent.pid, deadline, LookupMode::Terminal) {
            Ok(row) => row,
            Err(_) => return receipt,
        };
        if current != self.observed {
            receipt.reason = HeldReason::IdentityMismatch;
            return receipt;
        }
        if Instant::now() >= deadline {
            return receipt;
        }
        // No retry: a failed/uncertain syscall does not authorize another effect.
        match observer.sigterm(self.intent.pid) {
            Ok(()) => {
                receipt.status = "signal-accepted";
                receipt.reason = HeldReason::SignalAccepted;
            }
            Err(errno) => {
                receipt.reason = HeldReason::SignalFailed;
                receipt.errno = Some(errno);
            }
        }
        receipt
    }
}

#[cfg(target_os = "macos")]
fn platform_birth(pid: u32) -> Result<(u32, Birth), String> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: valid writable buffer of exactly the requested platform structure.
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if count != size as i32 {
        return Err("Darwin process birth observation unavailable".into());
    }
    // SAFETY: exact successful byte count initialized the complete structure.
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000 {
        return Err("invalid Darwin process birth observation".into());
    }
    Ok((
        info.pbi_ppid,
        Birth {
            seconds: info.pbi_start_tvsec,
            precise: info.pbi_start_tvusec,
        },
    ))
}

#[cfg(target_os = "linux")]
fn platform_birth(pid: u32) -> Result<(u32, Birth), String> {
    use std::{fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt};
    fn bounded(path: &str) -> Result<String, String> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut text = String::new();
        file.take(65_537)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        if text.len() > 65_536 {
            return Err("procfs observation exceeds byte limit".into());
        }
        Ok(text)
    }
    let stat = bounded(&format!("/proc/{pid}/stat"))?;
    let end = stat.rfind(')').ok_or("invalid procfs process stat")?;
    let fields: Vec<_> = stat[end + 1..].split_whitespace().collect();
    let parent = fields
        .get(1)
        .ok_or("missing procfs parent")?
        .parse::<u32>()
        .map_err(|e| e.to_string())?;
    let ticks = fields
        .get(19)
        .ok_or("missing procfs birth")?
        .parse::<u64>()
        .map_err(|e| e.to_string())?;
    let boot = bounded("/proc/stat")?
        .lines()
        .find_map(|line| line.strip_prefix("btime "))
        .ok_or("missing procfs boot epoch")?
        .parse::<u64>()
        .map_err(|e| e.to_string())?;
    // SAFETY: querying a constant system configuration key has no pointer arguments.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return Err("unavailable process clock frequency".into());
    }
    let seconds = boot
        .checked_add(ticks / hz as u64)
        .ok_or("process birth overflow")?;
    Ok((
        parent,
        Birth {
            seconds,
            precise: ticks,
        },
    ))
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_birth(_pid: u32) -> Result<(u32, Birth), String> {
    Err("process instance observation unsupported on this target".into())
}

/// Match the selected legacy comm representation without a shell, caller PATH,
/// unbounded output, or a child whose lifetime escapes the lookup deadline.
fn legacy_comm(pid: u32, deadline: Instant, mode: LookupMode) -> Result<String, String> {
    use std::{
        io::Read,
        os::fd::AsRawFd,
        process::{Child, Command, Stdio},
    };
    struct LookupChild(Child);
    impl Drop for LookupChild {
        fn drop(&mut self) {
            // The observer owns this unreaped child. Kill/reap only that child;
            // never a group or a PID supplied by the engine.
            match self.0.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => (), // This direct child remains owned and unreaped.
                Err(_) => {
                    // Cleanup ownership is uncertain after a failed wait. Do not
                    // signal a PID that might already have been reaped/reused.
                    // The failed lookup stays unavailable; cleanup is unconfirmed.
                    return;
                }
            }
            let _ = self.0.kill();
            // Reaping is best effort but bounded even on kernel/process faults.
            let until = Instant::now() + Duration::from_millis(50);
            while Instant::now() < until {
                if !matches!(self.0.try_wait(), Ok(None)) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    checkpoint(deadline, mode)?;
    let child = Command::new("/bin/ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .env_clear()
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("process comm lookup: {e}"))?;
    let mut child = LookupChild(child);
    let mut output = child.0.stdout.take().ok_or("missing process comm pipe")?;
    let fd = output.as_raw_fd();
    // SAFETY: fd is borrowed from this live owned pipe.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("process comm pipe cannot become nonblocking".into());
    }
    let mut bytes = Vec::new();
    let mut eof = false;
    loop {
        checkpoint(deadline, mode)?;
        if !eof {
            let mut chunk = [0u8; 4097];
            match output.read(&mut chunk) {
                Ok(0) => eof = true,
                Ok(count) => {
                    bytes.extend_from_slice(&chunk[..count]);
                    if bytes.len() > COMM_LIMIT + 1 {
                        return Err("process comm exceeds byte limit".into());
                    }
                }
                Err(e)
                    if e.kind() == io::ErrorKind::WouldBlock
                        || e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(format!("process comm read: {e}")),
            }
        }
        if eof && let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err("process comm unavailable".into());
            }
            let text = String::from_utf8(bytes).map_err(|_| "process comm is not UTF-8")?;
            let text = text.trim_end_matches('\n');
            if text.is_empty() || text.len() > COMM_LIMIT || text.contains('\0') {
                return Err("invalid process comm".into());
            }
            return Ok(text.into());
        }
        let mut pollfd = libc::pollfd {
            fd: if eof { -1 } else { fd },
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one initialized pollfd and a bounded 2ms poll.
        if unsafe { libc::poll(&mut pollfd, 1, 2) } < 0
            && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
        {
            return Err("process comm poll failed".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        rows: Vec<Observation>,
        signals: Vec<u32>,
        fail_signal: bool,
    }
    impl Observer for Fake {
        fn observe(
            &mut self,
            pid: u32,
            _deadline: Instant,
            _mode: LookupMode,
        ) -> Result<Observation, String> {
            self.rows
                .iter()
                .find(|row| row.pid == pid)
                .cloned()
                .ok_or("unavailable".into())
        }
        fn sigterm(&mut self, pid: u32) -> Result<(), i32> {
            self.signals.push(pid);
            if self.fail_signal {
                Err(libc::EPERM)
            } else {
                Ok(())
            }
        }
    }
    fn row() -> Observation {
        Observation {
            pid: 44,
            parent: 1,
            birth: Birth {
                seconds: 123,
                precise: 456,
            },
            comm: "/fixture/agent".into(),
        }
    }
    fn intent() -> ContainmentIntent {
        ContainmentIntent {
            schema: "caws.containment.intent.v1".into(),
            pid: 44,
            start_epoch: "123".into(),
            comm: "/fixture/agent".into(),
            session_id: "session".into(),
            latch_path: "/fixture/latch.json".into(),
            latch_generation: "a".repeat(32),
        }
    }
    fn fake() -> Fake {
        Fake {
            rows: vec![row()],
            signals: vec![],
            fail_signal: false,
        }
    }
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(1)
    }
    #[test]
    fn identity_checks_and_consumed_attempt_never_signal_foreign_or_reused_instances() {
        let mut observer = fake();
        let captured = CapturedAncestors::capture_with(&mut observer, 99, 44, deadline());
        for pid in [0, 1, 99, 100] {
            let mut changed = intent();
            changed.pid = pid;
            assert!(captured.validate(&changed).is_err());
        }
        let mut changed = intent();
        changed.comm.push('x');
        assert!(matches!(
            captured.validate(&changed),
            Err(HeldReason::IdentityMismatch)
        ));
        let target = captured.validate(&intent()).ok().unwrap();
        observer.rows[0].birth.precise += 1;
        let receipt = target.attempt_with(&mut observer, deadline());
        assert_eq!(receipt.reason, HeldReason::IdentityMismatch);
        assert!(observer.signals.is_empty());
    }
    #[test]
    fn accepted_and_failed_syscalls_are_not_target_exit_claims() {
        let mut observer = fake();
        let captured = CapturedAncestors::capture_with(&mut observer, 99, 44, deadline());
        let receipt = captured
            .validate(&intent())
            .ok()
            .unwrap()
            .attempt_with(&mut observer, deadline());
        assert_eq!(receipt.status, "signal-accepted");
        assert_eq!(observer.signals, [44]);
        observer.fail_signal = true;
        let receipt = captured
            .validate(&intent())
            .ok()
            .unwrap()
            .attempt_with(&mut observer, deadline());
        assert_eq!(receipt.reason, HeldReason::SignalFailed);
        assert_eq!(receipt.errno, Some(libc::EPERM));
        let encoded = serde_json::to_value(receipt).unwrap();
        assert!(encoded.get("terminated").is_none());
    }
    #[test]
    fn capture_unavailable_and_expired_attempt_hold_without_signaling() {
        let mut observer = fake();
        let captured = CapturedAncestors::capture_with(&mut observer, 99, 55, deadline());
        assert!(matches!(
            captured.validate(&intent()),
            Err(HeldReason::CaptureUnavailable)
        ));
        let captured = CapturedAncestors::capture_with(&mut observer, 99, 44, deadline());
        let receipt = captured
            .validate(&intent())
            .ok()
            .unwrap()
            .attempt_with(&mut observer, Instant::now());
        assert_eq!(receipt.reason, HeldReason::ObservationUnavailable);
        assert!(observer.signals.is_empty());
    }
    #[test]
    fn intent_syntax_is_exact_and_bounded() {
        let good = serde_json::json!({"schema":"caws.containment.intent.v1","pid":44,"startEpoch":"123","comm":"/fixture/agent","sessionId":"session","latchPath":"/fixture/latch.json","latchGeneration":"a".repeat(32)});
        for (key, value) in [
            ("pid", serde_json::json!(0)),
            ("pid", serde_json::json!(2147483648u64)),
            ("startEpoch", serde_json::json!("01")),
            ("startEpoch", serde_json::json!("123456789012345678901")),
            ("comm", serde_json::json!("")),
            ("sessionId", serde_json::json!("unknown")),
            ("latchPath", serde_json::json!("relative")),
            ("latchGeneration", serde_json::json!("A".repeat(32))),
        ] {
            let mut changed = good.clone();
            changed[key] = value;
            assert!(
                serde_json::from_value::<ContainmentIntent>(changed)
                    .map(|v| v.validate().is_err())
                    .unwrap_or(true)
            );
        }
        let mut extra = good;
        extra["signal"] = serde_json::json!(9);
        assert!(serde_json::from_value::<ContainmentIntent>(extra).is_err());
    }
    #[test]
    fn mechanical_context_requires_exact_refusal_surface_event_and_session() {
        let intent = intent();
        let block = br#"{"decision":"block","reason":"guard"}"#;
        let mut context = EffectContext {
            surface: "codex",
            event: "pre_tool_use",
            active: true,
            session_id: Some("session"),
            exit_code: 2,
            stdout: block,
        };
        assert!(eligible(&intent, &context));
        for output in [
            br#"{"decision":"allow","reason":"guard"}"#.as_slice(),
            br#"{"decision":"allow","hookSpecificOutput":{"permissionDecision":"deny"}}"#
                .as_slice(),
            br#"{"decision":"block","reason":"guard","extra":true}"#.as_slice(),
            br#"{"decision":"allow","decision":"block","reason":"guard"}"#.as_slice(),
            b"block".as_slice(),
        ] {
            context.stdout = output;
            assert!(!eligible(&intent, &context));
        }
        context.stdout = block;
        context.session_id = Some("neighbor");
        assert!(!eligible(&intent, &context));
        context.session_id = Some("session");
        context.exit_code = 0;
        assert!(!eligible(&intent, &context));
        context.exit_code = 2;
        context.event = "stop";
        assert!(!eligible(&intent, &context));
        context.event = "pre_tool_use";
        context.surface = "opencode";
        assert!(!eligible(&intent, &context));
        context.surface = "codex";
        context.active = false;
        assert!(!eligible(&intent, &context));
    }
    #[test]
    fn missing_live_target_or_changed_parent_holds_without_signal() {
        let mut observer = fake();
        let captured = CapturedAncestors::capture_with(&mut observer, 99, 44, deadline());
        let target = captured.validate(&intent()).ok().unwrap();
        observer.rows.clear();
        assert_eq!(
            target.attempt_with(&mut observer, deadline()).reason,
            HeldReason::ObservationUnavailable
        );
        observer.rows.push(row());
        let target = captured.validate(&intent()).ok().unwrap();
        observer.rows[0].parent = 55;
        assert_eq!(
            target.attempt_with(&mut observer, deadline()).reason,
            HeldReason::IdentityMismatch
        );
        assert!(observer.signals.is_empty());
    }
    #[test]
    fn ancestor_cycles_are_not_a_partial_signal_capability() {
        let mut observer = fake();
        observer.rows[0].parent = 44;
        let captured = CapturedAncestors::capture_with(&mut observer, 99, 44, deadline());
        assert!(matches!(
            captured.validate(&intent()),
            Err(HeldReason::CaptureUnavailable)
        ));
        assert!(observer.signals.is_empty());
    }
}
