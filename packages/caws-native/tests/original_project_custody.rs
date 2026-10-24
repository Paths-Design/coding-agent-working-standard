//! Actual binary-private custodian topology; fixture Git executables are explicit
//! controls, not production Git/Stop admission or installed-harness proof.
#![cfg(target_os = "macos")]
use base64::{Engine, engine::general_purpose::STANDARD};
use caws_native::{
    context_git::original_project::{self, FailureKind, Input, RemoteFailure},
    invocation_project::{ExecutableIdentity, ProjectPhase, SelectedExecutable},
    monotonic_deadline::MonotonicDeadline,
};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            fs::{MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
            process::ExitStatusExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "original-project-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn environment(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "PATH".into(),
                format!("{}:/usr/bin:/bin", self.root.join("bin").display()),
            ),
            ("HOME".into(), self.root.to_str().unwrap().into()),
            ("LC_ALL".into(), "C".into()),
        ])
    }
    fn wrapper(&self, body: &str) {
        fs::create_dir_all(self.root.join("bin")).unwrap();
        let file = self.root.join("bin/git");
        fs::write(
            &file,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n{body}\n",
                self.root.join("queries").display()
            ),
        )
        .unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(base) = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT") {
            let base = PathBuf::from(base);
            fs::create_dir_all(&base).unwrap();
            fs::write(
                base.join(format!(
                    "original-project-fixture-{}.json",
                    self.root.file_name().unwrap().to_str().unwrap()
                )),
                serde_json::to_vec_pretty(&json!({"retainedFixtureRoot":self.root})).unwrap(),
            )
            .unwrap();
        } else {
            fs::remove_dir_all(&self.root).unwrap()
        }
    }
}
fn retain(name: &str, value: Value) {
    let bytes = serde_json::to_vec_pretty(&value).unwrap();
    println!(
        "original-project evidence {name}: {} serialized bytes",
        bytes.len()
    );
    if let Some(base) = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT") {
        let base = PathBuf::from(base);
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join(name), bytes).unwrap();
    }
}
// Test fixture snapshot only. Production callers must supply their generation's
// already-selected native executor; no engine request chooses this path.
fn executor() -> SelectedExecutable {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_caws-native"));
    let physical_path = path.canonicalize().unwrap();
    let meta = fs::metadata(&path).unwrap();
    SelectedExecutable {
        path,
        physical_path,
        sha256: format!(
            "{:x}",
            Sha256::digest(fs::read(env!("CARGO_BIN_EXE_caws-native")).unwrap())
        ),
        identity: ExecutableIdentity {
            device: meta.dev(),
            inode: meta.ino(),
            bytes: meta.len(),
            mode: meta.mode(),
            modified_seconds: meta.mtime(),
            modified_nanoseconds: meta.mtime_nsec(),
            changed_seconds: meta.ctime(),
            changed_nanoseconds: meta.ctime_nsec(),
        },
    }
}
fn raw(text: String) -> Box<RawValue> {
    RawValue::from_string(text).unwrap()
}
fn capture<'a>(
    root: &'a Path,
    environment: &'a BTreeMap<String, String>,
    payload: &'a RawValue,
    deadline: &MonotonicDeadline,
    cancelled: &dyn Fn() -> bool,
) -> Result<original_project::CapturedProject, RemoteFailure> {
    original_project::capture(
        Input {
            id: "actual-original-project",
            runtime_digest: &"a".repeat(64),
            caller_cwd: root.to_str().unwrap(),
            environment,
            payload,
        },
        &executor(),
        deadline,
        cancelled,
    )
}
fn settle(failure: &mut RemoteFailure) {
    let until = Instant::now() + Duration::from_secs(3);
    while !failure.cleanup_settled() && Instant::now() < until {
        let _ = failure.retry_cleanup();
        std::thread::sleep(Duration::from_millis(2))
    }
    assert!(failure.cleanup_settled(), "{failure:?}");
}
#[test]
fn exact_original_payload_candidate_filtered_environment_and_two_actual_cwds() {
    let f = Fixture::new();
    let candidate = f.root.join("payload");
    let checkout = f.root.join("checkout");
    let canonical = f.root.join("canonical");
    for path in [&candidate, &checkout, &canonical] {
        fs::create_dir(path).unwrap()
    }
    f.wrapper(&format!("printf '%s|%s|%s|%s\\n' \"$PWD\" \"${{GIT_DIR-unset}}\" \"${{HOOK_TEST-unset}}\" \"$KEEP\" >> '{}'\ncase \"$*\" in\n'rev-parse --show-toplevel') printf '%s\\n' '{}' ;;\n'rev-parse --path-format=absolute --git-common-dir') printf '%s/.git\\n' '{}' ;;\n*) exit 99 ;;\nesac",f.root.join("executed").display(),checkout.display(),canonical.display()));
    let mut env = f.environment();
    env.insert("GIT_DIR".into(), "hostile".into());
    env.insert("HOOK_TEST".into(), "hostile".into());
    env.insert("KEEP".into(), "retained".into());
    env.insert(
        "CAWS_PROJECT_DIR".into(),
        canonical.to_str().unwrap().into(),
    );
    let payload = raw(format!(
        "{{\n\"opaque\":1e9999,\"cwd\":{}\n}}",
        serde_json::to_string(candidate.to_str().unwrap()).unwrap()
    ));
    let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
    let captured = capture(&f.root, &env, &payload, &deadline, &|| false).unwrap();
    assert_eq!(captured.id(), "actual-original-project");
    assert_eq!(captured.runtime_digest(), "a".repeat(64));
    assert_eq!(captured.deadline(), deadline.envelope());
    assert_eq!(captured.input_digest().len(), 64);
    assert_eq!(captured.project().checkout, checkout);
    assert_eq!(captured.project().canonical_root, canonical);
    assert_eq!(
        captured.query_cwds(),
        &[candidate.clone(), checkout.clone()]
    );
    assert_eq!(
        fs::read_to_string(f.root.join("queries")).unwrap(),
        "rev-parse --show-toplevel\nrev-parse --path-format=absolute --git-common-dir\n"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("executed")).unwrap(),
        format!(
            "{}|unset|unset|retained\n{}|unset|unset|retained\n",
            candidate.display(),
            checkout.display()
        )
    );
    for q in &captured.project().queries {
        assert!(q.pid.is_some());
        assert!(q.exit_observed);
        assert!(q.settled());
        assert!(q.pipes.stdout_eof && q.pipes.stderr_eof);
        assert!(!q.ownership_retained);
        assert_eq!(q.reaped.unwrap().code, Some(0));
    }
    retain(
        "original-project-success.json",
        json!({"scope":"actual native custodian with fixture Git; no admission","root":f.root,"originalPayload":payload.get(),"id":captured.id(),"runtimeDigest":captured.runtime_digest(),"inputDigest":captured.input_digest(),"deadline":captured.deadline(),"queryCwds":captured.query_cwds(),"project":{"checkout":captured.project().checkout,"canonicalRoot":captured.project().canonical_root,"gitPath":captured.project().executable.path,"gitPhysicalPath":captured.project().executable.physical_path,"gitSha256":captured.project().executable.sha256,"queries":captured.project().queries.iter().map(|q|json!({"pid":q.pid,"exitObserved":q.exit_observed,"reapedCode":q.reaped.unwrap().code,"reapedSignal":q.reaped.unwrap().signal,"ownershipRetained":q.ownership_retained,"stdoutOpen":q.pipes.stdout_open,"stderrOpen":q.pipes.stderr_open,"stdoutEof":q.pipes.stdout_eof,"stderrEof":q.pipes.stderr_eof})).collect::<Vec<_>>(),"queryBytes":captured.project().query_bytes.iter().map(|q|json!({"stdout":STANDARD.encode(&q.stdout),"stderr":STANDARD.encode(&q.stderr)})).collect::<Vec<_>>() },"executed":fs::read_to_string(f.root.join("executed")).unwrap()}),
    );
}
#[test]
fn original_expired_or_cancelled_before_spawn_has_no_custodian_or_query() {
    let f = Fixture::new();
    f.wrapper("exit 99");
    let env = f.environment();
    let payload = raw("{}".into());
    let cancelled = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
    let failure = capture(&f.root, &env, &payload, &cancelled, &|| true).unwrap_err();
    assert_eq!(failure.kind, FailureKind::Cancelled);
    assert_eq!(failure.custodian_pid(), None);
    assert!(failure.cleanup_settled());
    let expired = MonotonicDeadline::capture(Duration::from_millis(1)).unwrap();
    while expired.check().is_ok() {
        std::thread::sleep(Duration::from_millis(1))
    }
    let failure = capture(&f.root, &env, &payload, &expired, &|| false).unwrap_err();
    assert_eq!(failure.kind, FailureKind::Deadline);
    assert_eq!(failure.custodian_pid(), None);
    assert!(failure.cleanup_settled());
    assert!(!f.root.join("queries").exists());
    let mut wrong_executor = executor();
    wrong_executor.identity.inode ^= 1;
    let live = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
    let wrong = original_project::capture(
        Input {
            id: "actual-original-project",
            runtime_digest: &"a".repeat(64),
            caller_cwd: f.root.to_str().unwrap(),
            environment: &env,
            payload: &payload,
        },
        &wrong_executor,
        &live,
        &|| false,
    )
    .unwrap_err();
    assert_eq!(wrong.kind, FailureKind::Project(ProjectPhase::BeforeLaunch));
    assert_eq!(wrong.custodian_pid(), None);
    assert!(wrong.cleanup_settled());
    assert!(!f.root.join("queries").exists());
    retain(
        "original-project-pre-spawn-refusal.json",
        json!({"root":f.root,"expiredKind":format!("{:?}",failure.kind),"custodianPid":failure.custodian_pid(),"queryFilePresent":false}),
    );
}
#[test]
fn nonzero_malformed_utf8_output_limit_and_running_cancellation_refuse_query_two() {
    let mut records = Vec::new();
    for (name, body, expected, cancel) in [
        (
            "nonzero",
            "printf rejected >&2; exit 7",
            FailureKind::Project(ProjectPhase::QueryStatus),
            false,
        ),
        (
            "bad-checkout",
            "printf 'relative\\n'",
            FailureKind::Project(ProjectPhase::CheckoutOutput),
            false,
        ),
        (
            "bad-stderr",
            "printf '/private/tmp\\n'; printf '\\377' >&2",
            FailureKind::Project(ProjectPhase::QueryStatus),
            false,
        ),
        (
            "identity-change",
            "printf '# changed\\n' >> \"$0\"; printf '/private/tmp\\n'",
            FailureKind::Project(ProjectPhase::AfterLaunch),
            false,
        ),
        (
            "output-limit",
            "exec /usr/bin/yes x",
            FailureKind::Project(ProjectPhase::OutputLimit),
            false,
        ),
        (
            "cancelled",
            "printf started > started; /bin/sleep 30",
            FailureKind::Cancelled,
            true,
        ),
        (
            "deadline",
            "printf started > started; /bin/sleep 30",
            FailureKind::Deadline,
            false,
        ),
    ] {
        let f = Fixture::new();
        f.wrapper(body);
        let env = f.environment();
        let payload = raw("{}".into());
        let deadline = MonotonicDeadline::capture(if name == "deadline" {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(8)
        })
        .unwrap();
        let mut failure = capture(&f.root, &env, &payload, &deadline, &|| {
            cancel && f.root.join("started").exists()
        })
        .unwrap_err();
        retain(
            &format!("original-project-refusal-{name}.json"),
            json!({"name":name,"root":f.root,"expected":format!("{expected:?}"),
                "observed":format!("{failure:?}"),"receipt":failure.receipt()}),
        );
        assert_eq!(failure.kind, expected, "{name}: {failure:?}");
        settle(&mut failure);
        assert_eq!(
            fs::read_to_string(f.root.join("queries")).unwrap(),
            "rev-parse --show-toplevel\n",
            "{name}"
        );
        let receipt = failure.receipt().unwrap();
        assert!(receipt["terminal"].as_bool().unwrap());
        assert!(receipt["project"].is_null());
        assert_eq!(receipt["rows"].as_array().unwrap().len(), 1);
        if name == "nonzero" {
            assert_eq!(receipt["rows"][0]["receipt"]["exitCode"], 7);
            assert!(receipt["rows"][0]["receipt"]["signal"].is_null())
        }
        records.push(json!({"name":name,"root":f.root,"kind":format!("{:?}",failure.kind),"settled":failure.cleanup_settled(),"receipt":receipt}));
    }
    retain("original-project-refusals.json", json!(records));
}

fn transfer_pipe_writer(mut socket: &UnixStream) {
    let mut pid = std::process::id().to_ne_bytes();
    let mut iov = libc::iovec {
        iov_base: pid.as_mut_ptr().cast(),
        iov_len: pid.len(),
    };
    let mut control = [0usize; 8];
    let size = std::mem::size_of::<i32>() as u32;
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = unsafe { libc::CMSG_SPACE(size) } as _;
    assert!((message.msg_controllen as usize) <= std::mem::size_of_val(&control));
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        assert!(!header.is_null());
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size) as _;
        *libc::CMSG_DATA(header).cast::<i32>() = libc::STDOUT_FILENO;
    }
    assert_eq!(
        unsafe { libc::sendmsg(socket.as_raw_fd(), &message, 0) },
        pid.len() as isize
    );
    let mut ack = [0u8; 1];
    socket.read_exact(&mut ack).unwrap();
    assert_eq!(&ack, b"A");
}
fn receive_pipe_writer(socket: &UnixStream) -> (OwnedFd, u32) {
    socket.set_nonblocking(true).unwrap();
    let mut pid = [0u8; 4];
    let mut iov = libc::iovec {
        iov_base: pid.as_mut_ptr().cast(),
        iov_len: pid.len(),
    };
    let mut control = [0usize; 8];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = std::mem::size_of_val(&control) as _;
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(Instant::now() < until, "pipe transfer receive deadline");
        message.msg_controllen = std::mem::size_of_val(&control) as _;
        message.msg_flags = 0;
        let count = unsafe { libc::recvmsg(socket.as_raw_fd(), &mut message, 0) };
        if count < 0
            && matches!(
                std::io::Error::last_os_error().kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            )
        {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        assert_eq!(
            count,
            pid.len() as isize,
            "pipe transfer receive: {}",
            std::io::Error::last_os_error()
        );
        break;
    }
    assert_eq!(message.msg_flags & libc::MSG_CTRUNC, 0);
    let writer = unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        assert!(!header.is_null());
        assert_eq!((*header).cmsg_level, libc::SOL_SOCKET);
        assert_eq!((*header).cmsg_type, libc::SCM_RIGHTS);
        assert_eq!(
            (*header).cmsg_len,
            libc::CMSG_LEN(std::mem::size_of::<i32>() as u32) as libc::socklen_t
        );
        assert!(libc::CMSG_NXTHDR(&message, header).is_null());
        OwnedFd::from_raw_fd(*libc::CMSG_DATA(header).cast::<i32>())
    };
    assert_eq!(
        unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
        0
    );
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::fstat(writer.as_raw_fd(), &mut stat) }, 0);
    assert_eq!(stat.st_mode & libc::S_IFMT, libc::S_IFIFO);
    assert_eq!(
        unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE,
        libc::O_WRONLY
    );
    (writer, u32::from_ne_bytes(pid))
}

// A read-only kernel process-table observation. This never supplies signal or
// reap authority; proc_pidinfo alone may omit the exited process being checked.
fn process_table_state(pid: u32) -> Result<Value, String> {
    let mut child = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "pid=,ppid=,pgid=,stat="])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() >= until {
            // Only this retained, unreaped diagnostic Child anchors its kill.
            let _ = child.kill();
            let stop = Instant::now() + Duration::from_secs(2);
            while child.try_wait().map_err(|e| e.to_string())?.is_none() && Instant::now() < stop {
                std::thread::sleep(Duration::from_millis(2));
            }
            return Err("read-only ps observation exceeded its bound".into());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    if !output.status.success() || !output.stderr.is_empty() {
        return Err(format!("ps {}: {text}; {:?}", output.status, output.stderr));
    }
    let fields: Vec<_> = text.split_whitespace().collect();
    if fields.len() != 4 {
        return Err(format!("unexpected process table row: {text}"));
    }
    let number = |index: usize| fields[index].parse::<u32>().map_err(|e| e.to_string());
    Ok(
        json!({"pid":number(0)?,"parent":number(1)?,"group":number(2)?,"state":fields[3],"raw":text}),
    )
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProcessBirth {
    pid: u32,
    parent: u32,
    group: u32,
    start_seconds: u64,
    start_micros: u64,
    status: u32,
}
fn process_birth(pid: u32) -> Option<ProcessBirth> {
    let mut raw = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    unsafe {
        *libc::__error() = 0;
    }
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            raw.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if count == 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return None;
    }
    assert_eq!(
        count,
        size as i32,
        "process observation unavailable for {pid}: {}",
        std::io::Error::last_os_error()
    );
    let raw = unsafe { raw.assume_init() };
    assert_eq!(raw.pbi_pid, pid);
    assert!(raw.pbi_start_tvsec > 0 && raw.pbi_start_tvusec < 1_000_000);
    Some(ProcessBirth {
        pid,
        parent: raw.pbi_ppid,
        group: raw.pbi_pgid,
        start_seconds: raw.pbi_start_tvsec,
        start_micros: raw.pbi_start_tvusec,
        status: raw.pbi_status,
    })
}
fn same_birth(a: &ProcessBirth, b: &ProcessBirth) -> bool {
    a.pid == b.pid && a.start_seconds == b.start_seconds && a.start_micros == b.start_micros
}

#[test]
fn withheld_stdout_writer_is_pending_until_actual_eof_and_reap() {
    const ROLE: &str = "CAWS_TEST_ORIGINAL_PROJECT_PIPE_SOCKET";
    if let Some(socket) = std::env::var_os(ROLE) {
        let socket = UnixStream::connect(socket).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let marker = b"held-original-project\n";
        assert_eq!(
            unsafe { libc::write(libc::STDOUT_FILENO, marker.as_ptr().cast(), marker.len()) },
            marker.len() as isize
        );
        transfer_pipe_writer(&socket);
        std::process::exit(7);
    }
    let f = Fixture::new();
    let anchor = PathBuf::from(format!(
        "/private/tmp/caws-opipe-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&anchor).unwrap();
    fs::set_permissions(&anchor, fs::Permissions::from_mode(0o700)).unwrap();
    let socket_path = anchor.join("s");
    let listener = UnixListener::bind(&socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    f.wrapper(&format!("{ROLE}='{}' exec '{}' --exact withheld_stdout_writer_is_pending_until_actual_eof_and_reap --nocapture --test-threads=1",socket_path.display(),std::env::current_exe().unwrap().display()));
    let (captured_tx, captured_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(6);
        let peer = loop {
            match listener.accept() {
                Ok((p, _)) => break p,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < until,
                        "actual Git did not transfer stdout writer"
                    );
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(e) => panic!("accept pipe writer: {e}"),
            }
        };
        let (writer, pid) = receive_pipe_writer(&peer);
        let birth = process_birth(pid).expect("original Git waits for ACK");
        (&peer).write_all(b"A").unwrap();
        captured_tx.send(birth).unwrap();
        let released = release_rx.recv_timeout(Duration::from_secs(6)).is_ok();
        drop(writer);
        released
    });
    let env = f.environment();
    let payload = raw("{}".into());
    let deadline = MonotonicDeadline::capture(Duration::from_secs(8)).unwrap();
    let mut failure = capture(&f.root, &env, &payload, &deadline, &|| false).unwrap_err();
    let git_birth = captured_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let custodian_pid = failure.custodian_pid().unwrap();
    let custodian_before = process_birth(custodian_pid);
    let initial = failure
        .receipt()
        .expect("cleanup allowance should send a pending receipt before original deadline");
    let initial_settled = failure.cleanup_settled();
    let git_before = process_table_state(git_birth.pid);
    // Release even if a subsequent assertion detects the defect under test.
    release_tx.send(()).unwrap();
    let released = holder.join().unwrap();
    fs::remove_file(socket_path).unwrap();
    fs::remove_dir(anchor).unwrap();
    settle(&mut failure);
    let final_receipt = failure.receipt().unwrap();
    let git_after = process_birth(git_birth.pid);
    let custodian_after = process_birth(custodian_pid);
    retain(
        "original-project-withheld-pipe.json",
        json!({"scope":"test-owned transferred stdout FD; actual custodian/Git ownership and EOF, no admission","root":f.root,"initialReceipt":initial,"initialSettled":initial_settled,"custodianBefore":custodian_before,"gitBirth":git_birth,"gitBefore":git_before,"writerReleased":released,"finalReceipt":final_receipt,"finalSettled":failure.cleanup_settled(),"custodianAfter":custodian_after,"gitAfter":git_after}),
    );
    assert_eq!(failure.kind, FailureKind::Project(ProjectPhase::Cleanup));
    assert!(!initial_settled);
    assert!(released);
    assert_eq!(git_birth.parent, custodian_pid);
    assert_eq!(git_birth.group, git_birth.pid);
    assert!(custodian_before.is_some_and(|p| p.status != libc::SZOMB));
    let git_before = git_before.unwrap();
    assert_eq!(git_before["parent"], custodian_pid);
    assert!(
        git_before["state"].as_str().unwrap().starts_with('Z'),
        "actual Git must remain unreaped while stdout has no EOF: {git_before}"
    );
    assert_eq!(initial["terminal"], false);
    assert_eq!(initial["rows"][0]["receipt"]["status"], "cleanup_unsettled");
    assert_eq!(initial["rows"][0]["receipt"]["exitCode"], 7);
    assert_eq!(initial["rows"][0]["receipt"]["cleanup"]["stdoutEof"], false);
    assert_eq!(initial["rows"][0]["receipt"]["cleanup"]["reaped"], false);
    assert_eq!(final_receipt["terminal"], true);
    assert!(final_receipt["project"].is_null());
    assert_eq!(final_receipt["failure"]["phase"], "Cleanup");
    assert_eq!(final_receipt["rows"].as_array().unwrap().len(), 1);
    assert_eq!(final_receipt["rows"][0]["receipt"]["exitCode"], 7);
    assert!(final_receipt["rows"][0]["receipt"]["signal"].is_null());
    for name in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
        assert_eq!(
            final_receipt["rows"][0]["receipt"]["cleanup"][name], true,
            "{name}"
        )
    }
    assert_eq!(
        fs::read_to_string(f.root.join("queries")).unwrap(),
        "rev-parse --show-toplevel\n"
    );
    assert!(git_after.is_none());
    assert!(custodian_after.is_none());
}

#[test]
fn frontend_term_and_kill_leave_actual_custodian_to_settle_git_group() {
    const ROLE: &str = "CAWS_TEST_ORIGINAL_PROJECT_FRONTEND_ROOT";
    if let Some(root) = std::env::var_os(ROLE) {
        let f = Fixture {
            root: PathBuf::from(root),
        };
        let env = f.environment();
        let payload = raw("{}".into());
        let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
        let outcome = capture(&f.root, &env, &payload, &deadline, &|| false);
        fs::write(f.root.join("unexpected-return"), format!("{outcome:?}")).unwrap();
        panic!("original frontend returned before parent terminated it");
    }
    let mut records = Vec::new();
    for signal in [libc::SIGTERM, libc::SIGKILL] {
        let f = Fixture::new();
        f.wrapper("/bin/sleep 30 & printf '%s %s %s\\n' \"$PPID\" \"$$\" \"$!\" > chain; wait");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "frontend_term_and_kill_leave_actual_custodian_to_settle_git_group",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ROLE, &f.root)
            .stdin(Stdio::null())
            .stdout(fs::File::create(f.root.join("frontend.stdout.log")).unwrap())
            .stderr(fs::File::create(f.root.join("frontend.stderr.log")).unwrap())
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(4);
        let ids = loop {
            if let Ok(text) = fs::read_to_string(f.root.join("chain")) {
                let ids: Vec<u32> = text
                    .split_whitespace()
                    .map(|s| s.parse().unwrap())
                    .collect();
                if ids.len() == 3 {
                    break ids;
                }
            }
            assert!(
                Instant::now() < until,
                "actual query topology did not appear"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        let frontend = process_birth(child.id()).unwrap();
        let custodian = process_birth(ids[0]).unwrap();
        let git = process_birth(ids[1]).unwrap();
        let descendant = process_birth(ids[2]).unwrap();
        assert_eq!(custodian.parent, frontend.pid);
        assert_eq!(git.parent, custodian.pid);
        assert_eq!(descendant.parent, git.pid);
        assert_eq!(git.group, git.pid);
        assert_eq!(descendant.group, git.group);
        // Original, unreaped frontend Child anchors this signal. Process-table
        // PIDs are observation only and are never used to signal its survivors.
        assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
        let wait_until = Instant::now() + Duration::from_secs(2);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < wait_until,
                "original frontend did not terminate"
            );
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(status.signal(), Some(signal));
        let until = Instant::now() + Duration::from_secs(4);
        let after = loop {
            let after: Vec<_> = [&custodian, &git, &descendant]
                .into_iter()
                .map(|p| process_birth(p.pid))
                .collect();
            if after
                .iter()
                .zip([&custodian, &git, &descendant])
                .all(|(a, b)| a.as_ref().is_none_or(|a| !same_birth(a, b)))
            {
                break after;
            }
            if Instant::now() >= until {
                records.push(json!({"signal":signal,"root":f.root,"frontend":frontend,"custodian":custodian,"git":git,"descendant":descendant,"after":after,"settled":false}));
                retain("original-project-frontend-death.json", json!(records));
                panic!("actual owned process instances remain after frontend loss")
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(!f.root.join("unexpected-return").exists());
        records.push(json!({"signal":signal,"root":f.root,"frontend":frontend,"custodian":custodian,"git":git,"descendant":descendant,"after":after,"settled":true}));
        retain("original-project-frontend-death.json", json!(records));
    }
}

#[test]
fn dropping_remote_failure_preserves_custodian_while_test_writer_prevents_eof() {
    const ROLE: &str = "CAWS_TEST_ORIGINAL_PROJECT_PIPE_SOCKET";
    let f = Fixture::new();
    let anchor = PathBuf::from(format!(
        "/private/tmp/caws-odrop-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&anchor).unwrap();
    fs::set_permissions(&anchor, fs::Permissions::from_mode(0o700)).unwrap();
    let socket_path = anchor.join("s");
    let listener = UnixListener::bind(&socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    f.wrapper(&format!("{ROLE}='{}' exec '{}' --exact withheld_stdout_writer_is_pending_until_actual_eof_and_reap --nocapture --test-threads=1",socket_path.display(),std::env::current_exe().unwrap().display()));
    let (captured_tx, captured_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(6);
        let peer = loop {
            match listener.accept() {
                Ok((p, _)) => break p,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < until,
                        "actual Git did not transfer stdout writer"
                    );
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(e) => panic!("accept pipe writer: {e}"),
            }
        };
        let (writer, pid) = receive_pipe_writer(&peer);
        let birth = process_birth(pid).expect("Git must wait for ACK");
        (&peer).write_all(b"A").unwrap();
        captured_tx.send(birth).unwrap();
        let released = release_rx.recv_timeout(Duration::from_secs(6)).is_ok();
        drop(writer);
        released
    });
    let env = f.environment();
    let payload = raw("{}".into());
    let deadline = MonotonicDeadline::capture(Duration::from_secs(8)).unwrap();
    let failure = capture(&f.root, &env, &payload, &deadline, &|| false).unwrap_err();
    let git = captured_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let custodian = process_birth(failure.custodian_pid().unwrap()).unwrap();
    let receipt = failure.receipt().unwrap();
    assert!(!failure.cleanup_settled());
    assert_eq!(receipt["terminal"], false);
    drop(failure);
    // Cross the ordinary stop/reap retry interval while the external writer is
    // still held. EOF on the private control may cancel Git, not its custodian.
    std::thread::sleep(Duration::from_millis(100));
    let custodian_after_drop = process_birth(custodian.pid);
    let git_after_drop = process_table_state(git.pid);
    release_tx.send(()).unwrap();
    let released = holder.join().unwrap();
    fs::remove_file(socket_path).unwrap();
    fs::remove_dir(anchor).unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    let after = loop {
        let after = [process_birth(custodian.pid), process_birth(git.pid)];
        if after[0].as_ref().is_none_or(|v| !same_birth(v, &custodian))
            && after[1].as_ref().is_none_or(|v| !same_birth(v, &git))
        {
            break after;
        }
        assert!(
            Instant::now() < until,
            "custodian/Git did not disappear after actual writer release"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    retain(
        "original-project-drop-while-unsettled.json",
        json!({"root":f.root,"scope":"actual RemoteFailure Drop while test-owned stdout writer prevents EOF; no admission","pendingReceipt":receipt,"custodian":custodian,"git":git,"custodianAfterDrop":custodian_after_drop,"gitAfterDrop":git_after_drop,"writerReleased":released,"afterRelease":after}),
    );
    assert!(released);
    assert!(
        custodian_after_drop
            .as_ref()
            .is_some_and(|v| same_birth(v, &custodian) && v.status != libc::SZOMB)
    );
    let held = git_after_drop.unwrap();
    assert_eq!(held["parent"], custodian.pid);
    assert!(held["state"].as_str().unwrap().starts_with('Z'));
    assert_eq!(receipt["rows"][0]["receipt"]["cleanup"]["stdoutEof"], false);
    assert_eq!(receipt["rows"][0]["receipt"]["cleanup"]["reaped"], false);
    assert_eq!(
        fs::read_to_string(f.root.join("queries")).unwrap(),
        "rev-parse --show-toplevel\n"
    );
}
