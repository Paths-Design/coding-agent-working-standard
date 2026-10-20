//! Mechanism controls use a deliberately small owned stdlib fixture, not the
//! Sterling implementation or a claim of renderer parity/installed selection.
use super::*;
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicU64, Ordering},
};

#[test]
fn legacy_arguments_preserve_cr_and_refuse_delimiters_and_nul() {
    let mut args: [String; 12] = std::array::from_fn(|_| String::new());
    args[4] = "model\rname".into();
    assert!(validate_arguments(&args).is_ok());
    for (value, expected) in [
        ("line\nfeed", FailureCode::UnsupportedLegacyWire),
        ("unit\x1fseparator", FailureCode::UnsupportedLegacyWire),
        ("nul\0value", FailureCode::InvalidArguments),
    ] {
        args[4] = value.into();
        assert_eq!(validate_arguments(&args).unwrap_err().code, expected);
    }
    args[4] = "x".repeat(65536);
    assert_eq!(
        validate_arguments(&args).unwrap_err().code,
        FailureCode::InvalidArguments
    );
}
#[test]
fn daemon_reply_requires_exact_counter_safe_numbers_and_whole_frame() {
    assert_eq!(
        parse_reply(b"ok 1 27\n", 1).unwrap(),
        DaemonResponse {
            served: 1,
            elapsed_ms: 27,
            cached: false
        }
    );
    assert_eq!(
        parse_reply(b"ok 2 0 cached\n", 2).unwrap(),
        DaemonResponse {
            served: 2,
            elapsed_ms: 0,
            cached: true
        }
    );
    for bytes in [
        b"ok 0 0\n".as_slice(),
        b"ok 2 0\n",
        b"ok 01 0\n",
        b"ok 1 -1\n",
        b"ok 1 9007199254740992\n",
        b"ok 1 1 cached\n",
        b"ok 1 0 extra\n",
        b"ok 1 0\nerror x\n",
        b"ok 1 0",
        b"error fixture\n",
        b"denied\n",
        b"stale\n",
        b"ok 1 \xff\n",
    ] {
        assert_eq!(
            parse_reply(bytes, 1).unwrap_err().code,
            FailureCode::InvalidDaemonReply,
            "{bytes:?}"
        );
    }
}
#[test]
fn control_is_closed_bounded_and_observes_eof_and_partial_read_deadline() {
    let (mut host, worker) = UnixStream::pair().unwrap();
    nonblocking(worker.as_raw_fd()).unwrap();
    let mut control = Control {
        stream: worker,
        pending: Vec::new(),
        partial_since: None,
        read_ms: 10,
    };
    host.write_all(b"{\"schema\":\"caws.renderer.worker.command.v1\",\"command\":{\"type\":\"stop\"},\"extra\":true}\n").unwrap();
    assert_eq!(
        control.next().unwrap_err().code,
        FailureCode::ControlProtocol
    );
    control.pending = b"{".to_vec();
    control.partial_since = Some(Instant::now() - Duration::from_secs(1));
    assert_eq!(control.next().unwrap_err().code, FailureCode::Deadline);
    control.pending.clear();
    control.partial_since = None;
    drop(host);
    assert_eq!(control.next().unwrap_err().code, FailureCode::HostClosed);
}
#[test]
fn command_roundtrip_retains_delimiter_values_for_explicit_worker_rejection() {
    let mut arguments: [String; 12] = std::array::from_fn(|_| String::new());
    arguments[4] = "cr\rline\nunit\x1f".into();
    let bytes = encode_command(HostCommand::Render {
        request_id: "a".repeat(64),
        arguments: Box::new(arguments.clone()),
    })
    .unwrap();
    assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 1);
    let frame: HostFrame = serde_json::from_slice(&bytes).unwrap();
    match frame.command {
        HostCommand::Render {
            arguments: actual, ..
        } => assert_eq!(*actual, arguments),
        _ => panic!("wrong command"),
    }
    assert!(
        encode_command(HostCommand::Render {
            request_id: "bad".into(),
            arguments: Box::new(arguments)
        })
        .is_err()
    );
}
#[test]
fn pipe_capture_drains_past_its_retained_prefix_and_reports_exact_loss() {
    let (reader, mut writer) = UnixStream::pair().unwrap();
    nonblocking(reader.as_raw_fd()).unwrap();
    let sender = thread::spawn(move || writer.write_all(&vec![0x5a; 200_000]).unwrap());
    let expires = Instant::now() + Duration::from_secs(5);
    let mut capture = Capture::new();
    while !capture.stats.eof {
        capture.drain(reader.as_raw_fd());
        assert!(Instant::now() < expires);
        thread::sleep(Duration::from_millis(1));
    }
    sender.join().unwrap();
    assert_eq!(capture.bytes, vec![0x5a; MAX_CAPTURE]);
    assert_eq!(capture.stats.bytes_seen, 200_000);
    assert_eq!(capture.stats.bytes_retained, MAX_CAPTURE);
    assert!(capture.stats.truncated && capture.stats.eof && !capture.stats.io_failed);
}
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    base: PathBuf,
    spec: PinnedBackendSpec,
    retained: bool,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let parent = fs::canonicalize(parent).unwrap();
        let base = parent.join(format!(
            "renderer-backend-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let hooks = base.join("hooks");
        let work = base.join("worker");
        for dir in [&hooks, &work] {
            fs::create_dir(dir).unwrap();
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::create_dir(hooks.join("lib")).unwrap();
        let daemon=r#"import argparse,hashlib,json,os,secrets,socket,sys,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--hooks-dir');p.add_argument('--lease-file');p.add_argument('--idle-s');a=p.parse_args()
h=Path(a.hooks_dir);sys.path.insert(0,str(h));import session_log_renderer
entries=[f'{f}:{f.stat().st_mtime_ns}' for f in sorted([h/'session_log_renderer.py',h/'session_log_daemon.py',*sorted((h/'lib').glob('*.py'))])]
fingerprint=hashlib.sha256('\n'.join(entries).encode()).hexdigest()
s=socket.socket();s.bind(('127.0.0.1',0));s.listen(8);token=secrets.token_hex(16)
lease={'pid':os.getpid()+(1 if 'FIXTURE_MODE'=='bad_pid' else 0),'port':s.getsockname()[1],'token':token,'fingerprint':fingerprint,'hooks_dir':str(h),'served':0}
def publish():
 t=Path(a.lease_file+'.tmp');t.write_text(json.dumps(lease));os.chmod(t,0o600);t.replace(a.lease_file)
publish()
if 'FIXTURE_MODE'=='leader_holder':
 holder=os.fork()
 if holder==0:
  root=Path(a.lease_file).parent
  (root/'holder-ready.json').write_text(json.dumps({'pid':os.getpid(),'group':os.getpgrp()}))
  until=time.monotonic()+15
  while not (root/'release-holder').exists() and time.monotonic()<until:time.sleep(.01)
  os._exit(0)
 while not Path(a.lease_file).with_name('exit-leader').exists():time.sleep(.01)
 os._exit(0)
while True:
 c,_=s.accept()
 with c:
  raw=b''
  while not raw.endswith(b'\n') and len(raw)<65536:
   part=c.recv(4096)
   if not part:break
   raw+=part
  fields=raw.decode().rstrip('\n').split('\x1f')
  if len(fields)!=13 or fields[0]!=token:
   try:c.sendall(b'denied\n')
   except OSError:pass
   continue
  Path(a.lease_file).with_name('observed.json').write_text(json.dumps(fields[1:]))
  if 'FIXTURE_MODE'=='stall':time.sleep(60)
  if 'FIXTURE_MODE'=='lost':continue
  if 'FIXTURE_MODE'=='flood':
   os.write(1,b'x'*200000);os.write(2,b'y'*200000)
  lease['served']+=1;publish();c.sendall(f"ok {lease['served']} 0\n".encode())
  if 'FIXTURE_MODE'=='reply_exit':os._exit(0)
"#.replace("FIXTURE_MODE",mode);
        let daemon_path = hooks.join("session_log_daemon.py");
        let renderer_path = hooks.join("session_log_renderer.py");
        fs::write(&daemon_path, daemon).unwrap();
        fs::write(&renderer_path, b"# owned import fixture\n").unwrap();
        let pinned = |path: PathBuf| PinnedFile {
            sha256: format!("{:x}", Sha256::digest(fs::read(&path).unwrap())),
            path,
        };
        let python = fs::canonicalize(
            std::env::var_os("CAWS_NATIVE_TEST_PYTHON")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/usr/bin/python3")),
        )
        .unwrap();
        let spec = PinnedBackendSpec {
            python: pinned(python),
            hooks_dir: hooks,
            image_files: vec![pinned(daemon_path), pinned(renderer_path)],
            image_digest: "a".repeat(64),
            work_dir: work,
            home: base.clone(),
            search_path: "/usr/bin:/bin".into(),
            agent_surface: "codex".into(),
            idle_seconds: 30,
            cache_megabytes: 1,
            git_view: None,
        };
        Self {
            base,
            spec,
            retained: false,
        }
    }
    fn lifetime(&self) -> OwnedFd {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.base.join("lifetime.lock"))
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        file.into()
    }
    fn launch(
        &self,
    ) -> (
        UnixStream,
        BufReader<UnixStream>,
        thread::JoinHandle<WorkerExit>,
    ) {
        let (host, worker) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let reader = BufReader::new(host.try_clone().unwrap());
        let spec = self.spec.clone();
        let lifetime = self.lifetime();
        let limits = WorkerLimits {
            startup_ms: 10000,
            connect_ms: 1000,
            write_ms: 1000,
            render_ms: 2000,
            read_ms: 1000,
            cleanup_ms: 1000,
        };
        let join = thread::spawn(move || run_worker(spec, worker, limits, lifetime));
        (host, reader, join)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.retained && std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT").is_none() {
            let _ = fs::remove_dir_all(&self.base);
        } else {
            eprintln!(
                "renderer backend artifacts retained: {}",
                self.base.display()
            );
        }
    }
}
fn event(reader: &mut BufReader<UnixStream>) -> WorkerEvent {
    let mut line = Vec::new();
    assert!(reader.read_until(b'\n', &mut line).unwrap() > 0);
    decode_event(&line).unwrap().event
}
fn ready(reader: &mut BufReader<UnixStream>) -> u32 {
    match event(reader) {
        WorkerEvent::Ready {
            readiness,
            child_pid,
            ..
        } => {
            assert_eq!(readiness, "owned_child_lease_and_listener");
            child_pid
        }
        other => panic!("expected readiness: {other:?}"),
    }
}
fn send(host: &mut UnixStream, args: [String; 12]) {
    host.write_all(
        &encode_command(HostCommand::Render {
            request_id: "b".repeat(64),
            arguments: Box::new(args),
        })
        .unwrap(),
    )
    .unwrap();
}

use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopSample {
    phase: &'static str,
    child_retained: bool,
    exited_unreaped: bool,
    custody_busy: bool,
    reap_calls: usize,
    stdout_eof: bool,
    stderr_eof: bool,
}
struct StopProbe {
    lock_probe: File,
    observe_left: usize,
    signal_left: usize,
    allow_stop: bool,
    wait_reply_exit: bool,
    reply_exit_seen: bool,
    reap_calls: usize,
    reap_custody_busy: bool,
    samples: Vec<StopSample>,
}
type SharedProbe = Arc<Mutex<StopProbe>>;
type ProbedWorker = (
    UnixStream,
    BufReader<UnixStream>,
    thread::JoinHandle<WorkerExit>,
    SharedProbe,
);
std::thread_local! {static STOP_PROBE:RefCell<Option<SharedProbe>>=const{RefCell::new(None)};}
struct ProbeScope {
    previous: Option<SharedProbe>,
}
impl ProbeScope {
    fn install(probe: SharedProbe) -> Self {
        Self {
            previous: STOP_PROBE.with(|slot| slot.replace(Some(probe))),
        }
    }
}
impl Drop for ProbeScope {
    fn drop(&mut self) {
        STOP_PROBE.with(|slot| *slot.borrow_mut() = self.previous.take());
    }
}
fn current_probe() -> Option<SharedProbe> {
    STOP_PROBE.with(|slot| slot.borrow().clone())
}
fn custody_busy(file: &File) -> bool {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
        false
    } else {
        io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock
    }
}
impl StopProbe {
    fn record(&mut self, phase: &'static str, group: &OwnedBackend) {
        let sample = StopSample {
            phase,
            child_retained: group.child.is_some(),
            exited_unreaped: matches!(group.observe(), Ok(false)),
            custody_busy: custody_busy(&self.lock_probe),
            reap_calls: self.reap_calls,
            stdout_eof: group.out.stats.eof,
            stderr_eof: group.err.stats.eof,
        };
        if self.samples.len() < 128 {
            self.samples.push(sample);
        }
    }
}
pub(super) fn before_stop_observe(group: &OwnedBackend) -> Result<()> {
    if let Some(shared) = current_probe() {
        let mut probe = shared.lock().unwrap_or_else(|error| error.into_inner());
        if probe.observe_left > 0 {
            probe.observe_left -= 1;
            probe.record("observe_error", group);
            return Err(Failure {
                code: FailureCode::Io,
                errno: Some(libc::EINTR),
            });
        }
    }
    Ok(())
}
pub(super) fn before_stop_signal(group: &OwnedBackend) -> Result<()> {
    if let Some(shared) = current_probe() {
        let mut probe = shared.lock().unwrap_or_else(|error| error.into_inner());
        if probe.signal_left > 0 {
            probe.signal_left -= 1;
            probe.record("signal_error", group);
            return Err(Failure {
                code: FailureCode::Io,
                errno: Some(libc::EPERM),
            });
        }
        if !probe.allow_stop {
            probe.record("quarantine", group);
            return Err(Failure {
                code: FailureCode::Io,
                errno: Some(libc::EPERM),
            });
        }
    }
    Ok(())
}
pub(super) fn before_reap() {
    if let Some(shared) = current_probe() {
        let mut probe = shared.lock().unwrap_or_else(|error| error.into_inner());
        probe.reap_calls = probe.reap_calls.saturating_add(1);
        probe.reap_custody_busy &= custody_busy(&probe.lock_probe);
    }
}
pub(super) fn before_reply_read(group: &OwnedBackend) -> Result<()> {
    let Some(shared) = current_probe() else {
        return Ok(());
    };
    if !shared
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .wait_reply_exit
    {
        return Ok(());
    }
    let expires = Instant::now() + Duration::from_secs(5);
    loop {
        if !group.observe()? {
            shared
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .reply_exit_seen = true;
            return Ok(());
        }
        deadline(expires)?;
        thread::sleep(Duration::from_millis(1));
    }
}
fn launch_probed(fixture: &Fixture, cleanup_faults: bool) -> ProbedWorker {
    let (host, worker) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let reader = BufReader::new(host.try_clone().unwrap());
    let lifetime = fixture.lifetime();
    let lock_probe = OpenOptions::new()
        .write(true)
        .open(fixture.base.join("lifetime.lock"))
        .unwrap();
    let probe = Arc::new(Mutex::new(StopProbe {
        lock_probe,
        observe_left: if cleanup_faults { 2 } else { 0 },
        signal_left: if cleanup_faults { 2 } else { 0 },
        allow_stop: !cleanup_faults,
        wait_reply_exit: !cleanup_faults,
        reply_exit_seen: false,
        reap_calls: 0,
        reap_custody_busy: true,
        samples: Vec::new(),
    }));
    let worker_probe = Arc::clone(&probe);
    let spec = fixture.spec.clone();
    let limits = WorkerLimits {
        startup_ms: 10000,
        connect_ms: 1000,
        write_ms: 1000,
        render_ms: 2000,
        read_ms: 1000,
        cleanup_ms: if cleanup_faults { 1 } else { 1000 },
    };
    let join = thread::spawn(move || {
        let _scope = ProbeScope::install(worker_probe);
        run_worker(spec, worker, limits, lifetime)
    });
    (host, reader, join, probe)
}
struct ReleaseProbe {
    probe: SharedProbe,
    work_dir: PathBuf,
}
impl Drop for ReleaseProbe {
    fn drop(&mut self) {
        self.probe
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .allow_stop = true;
        let _ = fs::write(self.work_dir.join("release-holder"), b"release");
    }
}
fn private_observation(fixture: &Fixture, name: &str, value: &serde_json::Value) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(fixture.base.join(name))
        .unwrap();
    file.write_all(&serde_json::to_vec_pretty(value).unwrap())
        .unwrap();
}
#[test]
fn cleanup_failures_keep_exited_leader_and_custody_until_holder_group_is_stopped() {
    let fixture = Fixture::new("leader_holder");
    let (_host, mut reader, join, probe) = launch_probed(&fixture, true);
    let release = ReleaseProbe {
        probe: Arc::clone(&probe),
        work_dir: fixture.spec.work_dir.clone(),
    };
    let pid = ready(&mut reader);
    let expires = Instant::now() + Duration::from_secs(5);
    let holder = loop {
        match fs::read(fixture.spec.work_dir.join("holder-ready.json")) {
            Ok(bytes) => break serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                assert!(Instant::now() < expires, "holder did not become ready");
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("holder observation: {error}"),
        }
    };
    assert_eq!(holder["group"], serde_json::json!(pid));
    fs::write(fixture.spec.work_dir.join("exit-leader"), b"exit").unwrap();
    let deadline_seen = loop {
        match event(&mut reader) {
            WorkerEvent::Failed { failure } if failure.code == FailureCode::ChildExited => {}
            WorkerEvent::CleanupDeadline { child_pid } => break child_pid == pid,
            _ => break false,
        }
    };
    let expires = Instant::now() + Duration::from_secs(5);
    let reached_quarantine = loop {
        let state = probe.lock().unwrap_or_else(|error| error.into_inner());
        let reached = state.observe_left == 0
            && state.signal_left == 0
            && state
                .samples
                .iter()
                .any(|sample| sample.phase == "quarantine");
        drop(state);
        if reached {
            break true;
        }
        if join.is_finished() || Instant::now() >= expires {
            break false;
        }
        thread::sleep(Duration::from_millis(1));
    };
    let (busy_before_release, reaps_before_release, samples) = {
        let mut state = probe.lock().unwrap_or_else(|error| error.into_inner());
        let observed = (
            custody_busy(&state.lock_probe),
            state.reap_calls,
            state.samples.clone(),
        );
        state.allow_stop = true;
        observed
    };
    let exit = join.join().unwrap();
    let (busy_after_return, final_reaps, reap_custody_busy) = {
        let state = probe.lock().unwrap_or_else(|error| error.into_inner());
        (
            custody_busy(&state.lock_probe),
            state.reap_calls,
            state.reap_custody_busy,
        )
    };
    drop(release);
    private_observation(
        &fixture,
        "cleanup-fault-observation.json",
        &serde_json::json!({"holder":holder,"deadlineSeen":deadline_seen,"reachedQuarantine":reached_quarantine,"custodyBusyBeforeRelease":busy_before_release,"reapsBeforeRelease":reaps_before_release,"custodyBusyAfterReturn":busy_after_return,"reapCalls":final_reaps,"custodyBusyAtReap":reap_custody_busy,"samples":samples,"workerExit":exit}),
    );
    assert!(deadline_seen && reached_quarantine);
    assert!(busy_before_release && !busy_after_return);
    assert_eq!(reaps_before_release, 0);
    assert_eq!(final_reaps, 1);
    assert!(reap_custody_busy);
    assert_eq!(
        samples
            .iter()
            .filter(|sample| sample.phase == "observe_error")
            .count(),
        2
    );
    assert_eq!(
        samples
            .iter()
            .filter(|sample| sample.phase == "signal_error")
            .count(),
        2
    );
    assert!(samples.iter().all(|sample| sample.child_retained
        && sample.exited_unreaped
        && sample.custody_busy
        && sample.reap_calls == 0
        && !sample.stdout_eof
        && !sample.stderr_eof));
    assert_eq!(exit.cleanup.child_pid, Some(pid));
    assert!(
        exit.cleanup.deadline_exceeded
            && exit.cleanup.identity_verified_before_signal
            && exit.cleanup.group_signal_accepted
            && exit.cleanup.direct_child_reaped
    );
    assert!(exit.cleanup.stdout.eof && exit.cleanup.stderr.eof);
    let backend_exit = exit.cleanup.backend_exit.unwrap();
    assert_eq!(backend_exit.code, Some(0));
    assert_eq!(backend_exit.signal, None);
}
#[test]
fn daemon_reply_queued_before_exit_remains_a_response_separate_from_backend_exit() {
    let fixture = Fixture::new("reply_exit");
    let (mut host, mut reader, join, probe) = launch_probed(&fixture, false);
    let pid = ready(&mut reader);
    send(&mut host, std::array::from_fn(|_| String::new()));
    assert!(matches!(event(&mut reader), WorkerEvent::Progress { .. }));
    let result_event = event(&mut reader);
    let exit = join.join().unwrap();
    let exit_seen_before_read = probe
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .reply_exit_seen;
    private_observation(
        &fixture,
        "reply-after-exit-observation.json",
        &serde_json::json!({"exitSeenBeforeFirstReplyRead":exit_seen_before_read,"resultEvent":result_event,"workerExit":exit}),
    );
    assert!(exit_seen_before_read);
    match result_event {
        WorkerEvent::Result {
            request_id,
            result: RequestResult::Returned { response },
            reply_bytes,
        } => {
            assert_eq!(request_id, "b".repeat(64));
            assert_eq!(
                response,
                DaemonResponse {
                    served: 1,
                    elapsed_ms: 0,
                    cached: false
                }
            );
            assert_eq!(reply_bytes, b"ok 1 0\n");
        }
        other => panic!("queued ACK was lost or changed: {other:?}"),
    }
    assert_eq!(exit.last_reply_bytes, b"ok 1 0\n");
    assert!(matches!(
        exit.last_result,
        Some(RequestResult::Returned { .. })
    ));
    assert_eq!(exit.cleanup.child_pid, Some(pid));
    assert!(exit.cleanup.direct_child_reaped);
    let backend_exit = exit.cleanup.backend_exit.unwrap();
    assert_eq!(backend_exit.code, Some(0));
    assert_eq!(backend_exit.signal, None);
}
#[test]
fn owned_daemon_returns_real_response_reuses_instance_preserves_cr_and_drains_flood() {
    let fixture = Fixture::new("flood");
    let (mut host, mut reader, join) = fixture.launch();
    let pid = ready(&mut reader);
    assert!(
        !fixture.spec.work_dir.join("observed.json").exists(),
        "readiness performed a render"
    );
    let mut args: [String; 12] = std::array::from_fn(|_| String::new());
    args[4] = "model\rcarried".into();
    for expected in 1..=2 {
        send(&mut host, args.clone());
        assert!(matches!(event(&mut reader), WorkerEvent::Progress { .. }));
        match event(&mut reader) {
            WorkerEvent::Result {
                result: RequestResult::Returned { response },
                reply_bytes,
                ..
            } => {
                assert_eq!(response.served, expected);
                assert_eq!(reply_bytes, format!("ok {expected} 0\n").as_bytes());
            }
            other => panic!("expected actual response: {other:?}"),
        }
    }
    assert_eq!(
        serde_json::from_slice::<Vec<String>>(
            &fs::read(fixture.spec.work_dir.join("observed.json")).unwrap()
        )
        .unwrap(),
        args
    );
    host.write_all(&encode_command(HostCommand::Stop).unwrap())
        .unwrap();
    let exit = join.join().unwrap();
    assert_eq!(exit.cleanup.child_pid, Some(pid));
    assert!(exit.cleanup.direct_child_reaped && exit.cleanup.identity_verified_before_signal);
    assert!(exit.cleanup.stdout.truncated && exit.cleanup.stderr.truncated);
    assert!(exit.cleanup.stdout.bytes_seen >= 400_000 && exit.cleanup.stderr.bytes_seen >= 400_000);
    assert_eq!(
        fs::metadata(fixture.spec.work_dir.join("stdout.bin"))
            .unwrap()
            .len(),
        MAX_CAPTURE as u64
    );
}
fn write_stop_case_evidence(fixture: &Fixture, name: &str, value: &serde_json::Value) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(fixture.base.join(name))
        .unwrap();
    file.write_all(&serde_json::to_vec_pretty(value).unwrap())
        .unwrap();
    file.sync_all().unwrap();
}

fn identify_stop_case(fixture: &Fixture, test: &str, mode: &str, boundary: &str) {
    write_stop_case_evidence(
        fixture,
        "test-case.json",
        &serde_json::json!({
            "schema": "caws.renderer.worker.stop-test-case.v1",
            "test": format!("renderer_backend::tests::{test}"),
            "fixtureMode": mode,
            "expectedStopBoundary": boundary,
            "testProcessPid": std::process::id(),
            "fixtureBase": fixture.base,
            "workerDirectory": fixture.spec.work_dir,
            "state": "before_launch"
        }),
    );
}

fn send_case_stop(fixture: &Fixture, host: &mut UnixStream, pid: u32, boundary: &str) {
    let command = encode_command(HostCommand::Stop).unwrap();
    // These are the actual bytes sent next, retained before the action.
    let mut raw = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(fixture.base.join("stop-command.jsonl"))
        .unwrap();
    raw.write_all(&command).unwrap();
    raw.sync_all().unwrap();
    write_stop_case_evidence(
        fixture,
        "stop-action.json",
        &serde_json::json!({
            "schema": "caws.renderer.worker.stop-test-action.v1",
            "caseIdentity": fixture.base.join("test-case.json"),
            "backendChildPid": pid,
            "stopBoundary": boundary,
            "rawCommand": fixture.base.join("stop-command.jsonl"),
            "state": "before_stop_write"
        }),
    );
    host.write_all(&command).unwrap();
}

fn settle_stop_case(fixture: &Fixture, pid: u32, exit: &WorkerExit, receipt: &CleanupReceipt) {
    let raw_exit = fixture.spec.work_dir.join("worker-exit.json");
    let bytes = fs::read(&raw_exit).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        serde_json::to_value(exit).unwrap(),
        "retained raw worker exit differs from the joined worker result"
    );
    write_stop_case_evidence(
        fixture,
        "test-settled.json",
        &serde_json::json!({
            "schema": "caws.renderer.worker.stop-test-settled.v1",
            "caseIdentity": fixture.base.join("test-case.json"),
            "backendChildPid": pid,
            "workerDirectory": fixture.spec.work_dir,
            "rawWorkerExit": raw_exit,
            "rawWorkerExitSha256": format!("{:x}", Sha256::digest(&bytes)),
            "workerExit": exit,
            "observedCleanupEventReceipt": receipt,
            "state": "all_case_assertions_passed"
        }),
    );
}

#[test]
fn explicit_idle_stop_before_render_is_clean_and_has_no_render_effect() {
    let fixture = Fixture::new("normal");
    identify_stop_case(
        &fixture,
        "explicit_idle_stop_before_render_is_clean_and_has_no_render_effect",
        "normal",
        "ready_before_any_render",
    );
    let (mut host, mut reader, join) = fixture.launch();
    let pid = ready(&mut reader);
    send_case_stop(&fixture, &mut host, pid, "ready_before_any_render");
    // Cleanup must be the next event: Failed/Progress/Result are all defects.
    let receipt = match event(&mut reader) {
        WorkerEvent::Cleanup { receipt } => receipt,
        other => panic!("idle Stop must only clean up: {other:?}"),
    };
    let exit = join.join().unwrap();
    assert!(exit.failure.is_none());
    assert!(exit.last_request_id.is_none() && exit.last_result.is_none());
    assert!(exit.last_reply_bytes.is_empty());
    assert_eq!(receipt.child_pid, Some(pid));
    assert!(receipt.direct_child_reaped && receipt.identity_verified_before_signal);
    assert!(receipt.stdout.eof && receipt.stderr.eof && receipt.logs_persisted);
    assert!(!receipt.deadline_exceeded);
    assert!(!fixture.spec.work_dir.join("observed.json").exists());
    let mut trailing = Vec::new();
    assert_eq!(reader.read_until(b'\n', &mut trailing).unwrap(), 0);
    settle_stop_case(&fixture, pid, &exit, &receipt);
}

#[test]
fn explicit_idle_stop_after_returned_preserves_result_without_another_render() {
    let fixture = Fixture::new("normal");
    identify_stop_case(
        &fixture,
        "explicit_idle_stop_after_returned_preserves_result_without_another_render",
        "normal",
        "after_returned_before_next_render",
    );
    let (mut host, mut reader, join) = fixture.launch();
    let pid = ready(&mut reader);
    let arguments = std::array::from_fn(|index| format!("argument-{index}"));
    send(&mut host, arguments.clone());
    assert!(matches!(event(&mut reader), WorkerEvent::Progress { .. }));
    match event(&mut reader) {
        WorkerEvent::Result {
            result: RequestResult::Returned { response },
            reply_bytes,
            ..
        } => {
            assert_eq!(response.served, 1);
            assert_eq!(reply_bytes, b"ok 1 0\n");
        }
        other => panic!("expected completed render before Stop: {other:?}"),
    }
    let observed = fs::read(fixture.spec.work_dir.join("observed.json")).unwrap();
    let lease = fs::read(fixture.spec.work_dir.join("lease.json")).unwrap();
    send_case_stop(
        &fixture,
        &mut host,
        pid,
        "after_returned_before_next_render",
    );
    let receipt = match event(&mut reader) {
        WorkerEvent::Cleanup { receipt } => receipt,
        other => panic!("completed render Stop must only clean up: {other:?}"),
    };
    let exit = join.join().unwrap();
    assert!(exit.failure.is_none());
    assert!(matches!(
        &exit.last_result,
        Some(RequestResult::Returned { response }) if response.served == 1
    ));
    assert_eq!(exit.last_reply_bytes, b"ok 1 0\n");
    assert_eq!(receipt.child_pid, Some(pid));
    assert!(receipt.direct_child_reaped && receipt.identity_verified_before_signal);
    assert!(receipt.stdout.eof && receipt.stderr.eof && receipt.logs_persisted);
    assert!(!receipt.deadline_exceeded);
    assert_eq!(
        fs::read(fixture.spec.work_dir.join("observed.json")).unwrap(),
        observed
    );
    assert_eq!(
        fs::read(fixture.spec.work_dir.join("lease.json")).unwrap(),
        lease
    );
    assert_eq!(
        serde_json::from_slice::<Vec<String>>(&observed).unwrap(),
        arguments
    );
    let mut trailing = Vec::new();
    assert_eq!(reader.read_until(b'\n', &mut trailing).unwrap(), 0);
    settle_stop_case(&fixture, pid, &exit, &receipt);
}

#[test]
fn explicit_stop_after_write_progress_remains_unknown_and_failed() {
    let fixture = Fixture::new("stall");
    identify_stop_case(
        &fixture,
        "explicit_stop_after_write_progress_remains_unknown_and_failed",
        "stall",
        "after_write_attempted_before_reply",
    );
    let (mut host, mut reader, join) = fixture.launch();
    let pid = ready(&mut reader);
    send(&mut host, std::array::from_fn(|_| String::new()));
    match event(&mut reader) {
        WorkerEvent::Progress { phase, .. } => assert_eq!(phase, "write_attempted"),
        other => panic!("expected actual write boundary: {other:?}"),
    }
    send_case_stop(
        &fixture,
        &mut host,
        pid,
        "after_write_attempted_before_reply",
    );
    match event(&mut reader) {
        WorkerEvent::Result {
            result: RequestResult::Unknown { failure },
            reply_bytes,
            ..
        } => {
            assert_eq!(failure.code, FailureCode::HostStopped);
            assert!(reply_bytes.is_empty());
        }
        other => panic!("in-flight Stop must retain uncertainty: {other:?}"),
    }
    assert!(matches!(
        event(&mut reader),
        WorkerEvent::Failed { failure } if failure.code == FailureCode::HostStopped
    ));
    let receipt = match event(&mut reader) {
        WorkerEvent::Cleanup { receipt } => receipt,
        other => panic!("expected owned cleanup after failure: {other:?}"),
    };
    let exit = join.join().unwrap();
    assert_eq!(exit.failure.unwrap().code, FailureCode::HostStopped);
    assert!(matches!(
        &exit.last_result,
        Some(RequestResult::Unknown { failure }) if failure.code == FailureCode::HostStopped
    ));
    assert!(exit.last_reply_bytes.is_empty());
    assert_eq!(receipt.child_pid, Some(pid));
    assert!(receipt.direct_child_reaped && receipt.identity_verified_before_signal);
    assert!(receipt.stdout.eof && receipt.stderr.eof && receipt.logs_persisted);
    assert!(!receipt.deadline_exceeded);
    let mut trailing = Vec::new();
    assert_eq!(reader.read_until(b'\n', &mut trailing).unwrap(), 0);
    settle_stop_case(&fixture, pid, &exit, &receipt);
}

#[test]
fn owner_eof_after_write_is_unknown_and_actual_owned_child_is_reaped() {
    fn identity(probe: &File, path: &Path) -> serde_json::Value {
        let held = probe.metadata();
        let named = fs::symlink_metadata(path);
        let fd_flags = unsafe { libc::fcntl(probe.as_raw_fd(), libc::F_GETFD) };
        let fd_errno = (fd_flags < 0).then(|| io::Error::last_os_error().raw_os_error());
        let status_flags = unsafe { libc::fcntl(probe.as_raw_fd(), libc::F_GETFL) };
        let status_errno = (status_flags < 0).then(|| io::Error::last_os_error().raw_os_error());
        let describe = |meta: &fs::Metadata| {
            serde_json::json!({
                "device": meta.dev(), "inode": meta.ino(), "mode": meta.mode(),
                "uid": meta.uid(), "links": meta.nlink(), "bytes": meta.len(),
                "mtime": meta.mtime(), "mtimeNanos": meta.mtime_nsec(),
                "ctime": meta.ctime(), "ctimeNanos": meta.ctime_nsec()
            })
        };
        serde_json::json!({
            "fd": probe.as_raw_fd(), "namedPath": path,
            "fdFlags": fd_flags, "fdFlagsErrno": fd_errno,
            "statusFlags": status_flags, "statusFlagsErrno": status_errno,
            "held": held.as_ref().ok().map(describe),
            "heldMetadataErrno": held.as_ref().err().and_then(io::Error::raw_os_error),
            "named": named.as_ref().ok().map(describe),
            "namedMetadataErrno": named.as_ref().err().and_then(io::Error::raw_os_error)
        })
    }
    fn retain(fixture: &Fixture, name: &str, value: &serde_json::Value) {
        eprintln!("owner EOF diagnostic {name}: {value}");
        write_stop_case_evidence(fixture, name, value);
    }
    let mut fixture = Fixture::new("stall");
    fixture.retained = true;
    retain(
        &fixture,
        "test-case.json",
        &serde_json::json!({
            "schema": "caws.renderer.worker.owner-eof-test-case.v1",
            "test": "renderer_backend::tests::owner_eof_after_write_is_unknown_and_actual_owned_child_is_reaped",
            "fixtureMode": "stall", "fixtureBase": fixture.base,
            "workerDirectory": fixture.spec.work_dir, "testProcessPid": std::process::id(),
            "state": "before_launch"
        }),
    );
    let (mut host, mut reader, join) = fixture.launch();
    let pid = ready(&mut reader);
    let lock_path = fixture.base.join("lifetime.lock");
    let probe = OpenOptions::new().write(true).open(&lock_path).unwrap();
    let initial_flock = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    let initial_error = (initial_flock < 0).then(io::Error::last_os_error);
    retain(
        &fixture,
        "before-owner-eof.json",
        &serde_json::json!({
            "caseIdentity": fixture.base.join("test-case.json"), "backendChildPid": pid,
            "initialFlockResult": initial_flock,
            "initialFlockErrno": initial_error.as_ref().and_then(io::Error::raw_os_error),
            "probe": identity(&probe, &lock_path), "state": "ready_before_render_and_owner_close"
        }),
    );
    assert_eq!(initial_flock, -1);
    assert_eq!(initial_error.unwrap().kind(), io::ErrorKind::WouldBlock);
    send(&mut host, std::array::from_fn(|_| String::new()));
    let progress = event(&mut reader);
    assert!(matches!(progress, WorkerEvent::Progress { .. }));
    drop(reader);
    drop(host);
    let exit = join.join().unwrap();
    // Capture the original first post-join syscall and errno before any
    // diagnostic metadata/read/write can overwrite errno or permit a retry.
    let post_join_flock = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    let post_join_error = (post_join_flock < 0).then(io::Error::last_os_error);
    let raw_exit = fixture.spec.work_dir.join("worker-exit.json");
    let raw_bytes = fs::read(&raw_exit);
    retain(
        &fixture,
        "after-join.json",
        &serde_json::json!({
            "caseIdentity": fixture.base.join("test-case.json"),
            "beforeOwnerEof": fixture.base.join("before-owner-eof.json"),
            "backendChildPid": pid, "workerDirectory": fixture.spec.work_dir,
            "observedProgress": progress, "returnedWorkerExit": exit,
            "rawWorkerExit": raw_exit,
            "rawWorkerExitSha256": raw_bytes.as_ref().ok().map(|bytes| format!("{:x}",Sha256::digest(bytes))),
            "rawWorkerExitReadErrno": raw_bytes.as_ref().err().and_then(io::Error::raw_os_error),
            "postJoinFlockResult": post_join_flock,
            "postJoinFlockErrno": post_join_error.as_ref().and_then(io::Error::raw_os_error),
            "postJoinFlockErrorKind": post_join_error.as_ref().map(|e| format!("{:?}",e.kind())),
            "postJoinFlockError": post_join_error.as_ref().map(ToString::to_string),
            "probe": identity(&probe, &lock_path), "state": "before_strict_post_join_flock_assertion"
        }),
    );
    assert_eq!(post_join_flock, 0);
    assert!(matches!(
        exit.last_result,
        Some(RequestResult::Unknown { .. })
    ));
    assert_eq!(
        exit.last_request_id.as_deref(),
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
    assert_eq!(exit.cleanup.child_pid, Some(pid));
    assert!(exit.cleanup.direct_child_reaped && exit.cleanup.identity_verified_before_signal);
    assert_eq!(
        exit.cleanup.backend_exit.unwrap().signal,
        Some(libc::SIGKILL)
    );
    retain(
        &fixture,
        "test-settled.json",
        &serde_json::json!({
            "caseIdentity": fixture.base.join("test-case.json"),
            "afterJoin": fixture.base.join("after-join.json"), "backendChildPid": pid,
            "state": "all_original_assertions_passed"
        }),
    );
}

#[test]
fn actual_backend_exec_retains_project_writer_lock_after_native_duplicate_closes() {
    let fixture = Fixture::new("normal");
    let writer = fixture.lifetime();
    close_on_exec(writer.as_raw_fd()).unwrap();
    let probe = OpenOptions::new()
        .write(true)
        .open(fixture.base.join("lifetime.lock"))
        .unwrap();
    let backend = OwnedBackend::spawn(
        &fixture.spec,
        &fixture.spec.work_dir.join("lease.json"),
        Some(writer.as_raw_fd()),
    )
    .unwrap();
    let expires = Instant::now() + Duration::from_secs(5);
    let lease_path = fixture.spec.work_dir.join("lease.json");
    let lease: Lease = loop {
        backend.live().unwrap();
        match fs::read(&lease_path) {
            Ok(bytes) => break serde_json::from_slice(&bytes).unwrap(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                assert!(
                    Instant::now() < expires,
                    "actual backend did not publish readiness"
                );
                thread::sleep(TICK);
            }
            Err(error) => panic!("backend lease read: {error}"),
        }
    };
    assert_eq!(lease.pid, backend.pid);
    drop(writer);
    // Only the actual exec'd backend holds this open-file-description now.
    assert_eq!(
        unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        -1
    );
    assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
    // Drop owns this direct Child and performs verified group stop + wait.
    drop(backend);
    assert_eq!(
        unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
}
#[test]
fn lost_daemon_reply_never_becomes_process_exit_success_or_automatic_retry() {
    let fixture = Fixture::new("lost");
    let (mut host, mut reader, join) = fixture.launch();
    ready(&mut reader);
    send(&mut host, std::array::from_fn(|_| String::new()));
    assert!(matches!(event(&mut reader), WorkerEvent::Progress { .. }));
    match event(&mut reader) {
        WorkerEvent::Result {
            result: RequestResult::Unknown { failure },
            reply_bytes,
            ..
        } => {
            assert_eq!(failure.code, FailureCode::InvalidDaemonReply);
            assert!(reply_bytes.is_empty());
        }
        other => panic!("expected unknown: {other:?}"),
    }
    let exit = join.join().unwrap();
    assert!(exit.cleanup.direct_child_reaped);
    assert!(fixture.spec.work_dir.join("observed.json").exists());
}
#[test]
fn wrong_lease_pid_never_replaces_the_actual_spawned_child_ownership() {
    let fixture = Fixture::new("bad_pid");
    let (_host, mut reader, join) = fixture.launch();
    assert!(matches!(
        event(&mut reader),
        WorkerEvent::Failed {
            failure: Failure {
                code: FailureCode::UnsafePrivateState,
                ..
            }
        }
    ));
    let exit = join.join().unwrap();
    let lease: Lease =
        serde_json::from_slice(&fs::read(fixture.spec.work_dir.join("lease.json")).unwrap())
            .unwrap();
    assert_ne!(exit.cleanup.child_pid, Some(lease.pid));
    assert!(exit.cleanup.direct_child_reaped && exit.cleanup.identity_verified_before_signal);
    assert_eq!(
        exit.cleanup.backend_exit.unwrap().signal,
        Some(libc::SIGKILL)
    );
    assert!(exit.last_result.is_none());
}

#[test]
fn delimiter_requests_are_explicit_nonattempts_and_do_not_touch_the_owned_daemon() {
    let fixture = Fixture::new("normal");
    let (mut host, mut reader, join) = fixture.launch();
    ready(&mut reader);
    for (index, value) in ["line\nfeed", "unit\x1fseparator"].iter().enumerate() {
        let mut arguments: [String; 12] = std::array::from_fn(|_| String::new());
        arguments[4] = (*value).into();
        host.write_all(
            &encode_command(HostCommand::Render {
                request_id: format!("{index:064x}"),
                arguments: Box::new(arguments),
            })
            .unwrap(),
        )
        .unwrap();
        match event(&mut reader) {
            WorkerEvent::Result {
                result: RequestResult::KnownNotAttempted { failure },
                reply_bytes,
                ..
            } => {
                assert_eq!(failure.code, FailureCode::UnsupportedLegacyWire);
                assert!(reply_bytes.is_empty());
            }
            other => panic!("expected nonattempt without write progress: {other:?}"),
        }
        assert!(!fixture.spec.work_dir.join("observed.json").exists());
    }
    send(&mut host, std::array::from_fn(|_| String::new()));
    assert!(matches!(event(&mut reader), WorkerEvent::Progress { .. }));
    match event(&mut reader) {
        WorkerEvent::Result {
            result: RequestResult::Returned { response },
            ..
        } => assert_eq!(response.served, 1),
        other => panic!("expected first real render: {other:?}"),
    }
    host.write_all(&encode_command(HostCommand::Stop).unwrap())
        .unwrap();
    assert!(join.join().unwrap().cleanup.direct_child_reaped);
}
