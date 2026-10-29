//! Bounded stdio MCP producer and same-image dedicated execution worker.
//!
//! A reviewed config and its complete Node dependency tree require protected
//! generation custody. Hashes do not establish that custody or sandbox placement.
//! The producer is single threaded and installs no signal handlers or reaper.
use crate::{
    execution_carrier,
    execution_child::{self, TerminationGrace},
    execution_fd_transport::{configure_child_fds, configure_private_child},
    execution_host::{HostContext, ProducerPeer},
    execution_ingress,
    execution_owner::{self, OwnerOutcome, PinnedAuthorizer},
    execution_prepare::{self, PrepareRefusal},
    execution_prepared::ProgramImage,
    monotonic_deadline::MonotonicDeadline,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeSet, VecDeque},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd},
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            net::UnixStream,
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const INPUT_LIMIT: usize = 1024 * 1024;
const REPLY_LIMIT: usize = 2 * 1024 * 1024;
const STARTUP_FD: i32 = 3;
fn refused() -> io::Error {
    io::Error::other("execution boundary refused")
}

/// Startup-only trusted configuration. No model argument can replace a pin.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    schema: String,
    native: ProgramImage,
    host: ProgramImage,
    node: ProgramImage,
    authorizer: ProgramImage,
    discovery: ProgramImage,
    writer: ProgramImage,
    generation: Generation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Generation {
    root: String,
    manifest: ProgramImage,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String,
    files: Vec<ProgramImage>,
}
fn load_config(path: &Path) -> io::Result<Config> {
    if !path.is_absolute() || fs::canonicalize(path)? != path {
        return Err(refused());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > 65536 {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(refused());
    }
    let shape: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    for pointer in [
        "",
        "/native",
        "/host",
        "/node",
        "/authorizer",
        "/discovery",
        "/writer",
        "/generation",
        "/generation/manifest",
    ] {
        if !shape.pointer(pointer).is_some_and(Value::is_object) {
            return Err(refused());
        }
    }
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if config.schema != "caws.execution.server-config.v1" {
        return Err(refused());
    }
    for image in [
        &config.native,
        &config.host,
        &config.node,
        &config.authorizer,
        &config.discovery,
        &config.writer,
        &config.generation.manifest,
    ] {
        if !Path::new(&image.path).is_absolute()
            || image.sha256.len() != 64
            || !image
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(refused());
        }
    }
    if Path::new(&config.authorizer.path)
        .parent()
        .ok_or_else(refused)?
        .join("writer-main.js")
        != Path::new(&config.writer.path)
    {
        return Err(refused());
    }
    Ok(config)
}
fn verify_generation(config: &Config, deadline: &MonotonicDeadline) -> io::Result<()> {
    let root = Path::new(&config.generation.root);
    if !root.is_absolute()
        || fs::canonicalize(root)? != root
        || Path::new(&config.generation.manifest.path).starts_with(root)
    {
        return Err(refused());
    }
    for image in [
        &config.node,
        &config.authorizer,
        &config.discovery,
        &config.writer,
    ] {
        if !Path::new(&image.path).starts_with(root) {
            return Err(refused());
        }
    }
    verify_generation_image(&config.generation.manifest, deadline)?;
    let mut bytes = Vec::new();
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&config.generation.manifest.path)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(refused());
    }
    if format!("{:x}", Sha256::digest(&bytes)) != config.generation.manifest.sha256 {
        return Err(refused());
    }
    let shape: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if !shape.is_object()
        || !shape
            .get("files")
            .and_then(Value::as_array)
            .is_some_and(|files| files.iter().all(Value::is_object))
    {
        return Err(refused());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if manifest.schema != "caws.execution.generation.v1"
        || manifest.files.is_empty()
        || manifest.files.len() > 100000
    {
        return Err(refused());
    }
    let mut expected = BTreeSet::new();
    let mut previous: Option<&[u8]> = None;
    for file in &manifest.files {
        let rel = Path::new(&file.path);
        if file.path.is_empty()
            || rel.is_absolute()
            || rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            || previous.is_some_and(|p| p >= file.path.as_bytes())
        {
            return Err(refused());
        }
        previous = Some(file.path.as_bytes());
        let path = root.join(rel);
        let image = ProgramImage {
            path: path.to_str().ok_or_else(refused)?.into(),
            sha256: file.sha256.clone(),
        };
        verify_generation_image(&image, deadline)?;
        expected.insert(path);
    }
    let mut pending = vec![root.to_path_buf()];
    let mut actual = BTreeSet::new();
    let mut entries = 0;
    while let Some(dir) = pending.pop() {
        deadline.check().map_err(|_| refused())?;
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            entries += 1;
            if entries > 200000 {
                return Err(refused());
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                actual.insert(entry.path());
            } else {
                return Err(refused());
            }
        }
    }
    if actual != expected {
        return Err(refused());
    }
    verify_generation_image(&config.generation.manifest, deadline)
}
fn verify_generation_image(image: &ProgramImage, deadline: &MonotonicDeadline) -> io::Result<()> {
    let before = fs::symlink_metadata(&image.path)?;
    if !before.is_file() || before.nlink() != 1 {
        return Err(refused());
    }
    verify_image(image, deadline)?;
    let after = fs::symlink_metadata(&image.path)?;
    if !after.is_file()
        || after.nlink() != 1
        || before.dev() != after.dev()
        || before.ino() != after.ino()
    {
        return Err(refused());
    }
    Ok(())
}
fn verify_image(image: &ProgramImage, deadline: &MonotonicDeadline) -> io::Result<()> {
    let check = || deadline.check().map_err(|_| PrepareRefusal::Deadline);
    let actual = execution_prepare::program(&image.path, &check).map_err(|_| refused())?;
    if actual.sha256 != image.sha256 {
        return Err(refused());
    }
    Ok(())
}
fn verify_self(config: &Config, deadline: &MonotonicDeadline) -> io::Result<()> {
    if fs::canonicalize(std::env::current_exe()?)? != Path::new(&config.native.path) {
        return Err(refused());
    }
    verify_image(&config.native, deadline)
}
struct HostChannel {
    input: ProducerPeer,
    output: ProducerPeer,
}
impl HostChannel {
    fn revalidate(&self, config: &Config, deadline: &MonotonicDeadline) -> io::Result<()> {
        self.input
            .revalidate(unsafe { BorrowedFd::borrow_raw(0) }, &config.host, deadline)?;
        self.output
            .revalidate(unsafe { BorrowedFd::borrow_raw(1) }, &config.host, deadline)
    }
}
fn host_channel(config: &Config, deadline: &MonotonicDeadline) -> io::Result<HostChannel> {
    let mut input = std::mem::MaybeUninit::<libc::stat>::uninit();
    let mut output = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(0, input.as_mut_ptr()) } != 0
        || unsafe { libc::fstat(1, output.as_mut_ptr()) } != 0
    {
        return Err(refused());
    }
    let input = unsafe { input.assume_init() };
    let output = unsafe { output.assume_init() };
    if input.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || input.st_dev != output.st_dev
        || input.st_ino != output.st_ino
    {
        return Err(refused());
    }
    let mut kind: libc::c_int = 0;
    let mut size = std::mem::size_of_val(&kind) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            0,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut kind as *mut libc::c_int).cast(),
            &mut size,
        )
    } != 0
        || kind != libc::SOCK_STREAM
    {
        return Err(refused());
    }
    let host = HostContext::capture(&config.host, deadline)?;
    let peer = ProducerPeer::capture(unsafe { BorrowedFd::borrow_raw(0) }, &config.host, deadline)?;
    if peer.pid() != host.pid() || peer.birth() != host.birth() {
        return Err(refused());
    }
    let output =
        ProducerPeer::capture(unsafe { BorrowedFd::borrow_raw(1) }, &config.host, deadline)?;
    if output.pid() != peer.pid() || output.birth() != peer.birth() {
        return Err(refused());
    }
    Ok(HostChannel {
        input: peer,
        output,
    })
}
fn grace() -> TerminationGrace {
    TerminationGrace::new(Duration::from_millis(1000)).unwrap()
}
/// Never abandon a returned unreaped direct child, even when the reply pipe is
/// gone. Repeated failed settlement keeps this process and its custody alive.
fn settle(mut child: Option<Child>) {
    while let Some(owned) = child.take() {
        child = execution_child::stop_child(owned, grace()).0;
    }
}
fn nonblocking(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A single bounded stdin owner. The same loop handles cancellation and EOF
/// while private children run; no background reader mutates the fd table.
struct Input {
    partial: Vec<u8>,
    queued: VecDeque<Vec<u8>>,
    pending_cancels: Vec<Value>,
    eof: bool,
}
impl Input {
    fn new() -> io::Result<Self> {
        nonblocking(0)?;
        Ok(Self {
            partial: Vec::new(),
            queued: VecDeque::new(),
            pending_cancels: Vec::new(),
            eof: false,
        })
    }
    fn pump(&mut self, active: Option<&Value>, cancelled: &AtomicBool) -> io::Result<()> {
        if let Some(active) = active {
            if let Some(index) = self.pending_cancels.iter().position(|id| id == active) {
                self.pending_cancels.remove(index);
                cancelled.store(true, Ordering::Release);
            }
        }
        let mut bytes = [0u8; 8192];
        loop {
            let count = unsafe { libc::read(0, bytes.as_mut_ptr().cast(), bytes.len()) };
            if count == 0 {
                self.eof = true;
                break;
            }
            if count < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::WouldBlock {
                    break;
                }
                if e.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            self.partial.extend_from_slice(&bytes[..count as usize]);
            if self.partial.len() > INPUT_LIMIT {
                return Err(refused());
            }
            while let Some(end) = self.partial.iter().position(|b| *b == b'\n') {
                let mut line: Vec<u8> = self.partial.drain(..=end).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let value: Value = serde_json::from_slice(&line).map_err(|_| refused())?;
                if value.get("method").and_then(Value::as_str) == Some("notifications/cancelled") {
                    if active.is_some() && value.pointer("/params/requestId") == active {
                        cancelled.store(true, Ordering::Release);
                    } else if let Some(request) = value.pointer("/params/requestId") {
                        if self.pending_cancels.len() >= 4 {
                            return Err(refused());
                        }
                        self.pending_cancels.push(request.clone());
                    }
                } else {
                    if self.queued.len() >= 4 {
                        return Err(refused());
                    }
                    self.queued.push_back(line);
                }
            }
        }
        if self.eof && active.is_some() {
            return Err(refused());
        }
        Ok(())
    }
    fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            if let Some(line) = self.queued.pop_front() {
                return Ok(Some(line));
            }
            if self.eof {
                return if self.partial.is_empty() {
                    Ok(None)
                } else {
                    Err(refused())
                };
            }
            self.pump(None, &AtomicBool::new(false))?;
            if self.queued.is_empty() && !self.eof {
                let mut p = libc::pollfd {
                    fd: 0,
                    events: libc::POLLIN,
                    revents: 0,
                };
                if unsafe { libc::poll(&mut p, 1, 100) } < 0
                    && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                {
                    return Err(io::Error::last_os_error());
                }
            }
        }
    }
}
fn write_json(value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    if bytes.len() > 3 * 1024 * 1024 {
        return Err(refused());
    }
    bytes.push(b'\n');
    nonblocking(1)?;
    let end = Instant::now() + Duration::from_secs(5);
    let mut rest = bytes.as_slice();
    while !rest.is_empty() {
        if Instant::now() >= end {
            return Err(refused());
        }
        let count = unsafe { libc::write(1, rest.as_ptr().cast(), rest.len()) };
        if count > 0 {
            rest = &rest[count as usize..];
            continue;
        }
        if count == 0 {
            return Err(refused());
        }
        let e = io::Error::last_os_error();
        if e.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if e.kind() != io::ErrorKind::WouldBlock {
            return Err(e);
        }
        let mut p = libc::pollfd {
            fd: 1,
            events: libc::POLLOUT,
            revents: 0,
        };
        unsafe {
            libc::poll(&mut p, 1, 10);
        }
    }
    Ok(())
}
fn result(id: Value, value: Value, error: bool) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":{"isError":error,
        "content":[{"type":"text","text":value.to_string()}]}})
}
fn tool_description(config: &Config) -> String {
    let quote = |path: &str| format!("'{}'", path.replace('\'', "'\\''"));
    format!(
        "Execute source admitted by closed CAWS Bash profiles.\n\
Configured evidence writer prefix:\n{} {}\n\
Append this grammar to that configured prefix as one literal command:\n\
specs evidence SPEC_ID --ac AC_ID --status STATUS --evidence-ref 'CITATION' [--command 'DESCRIPTION'] [--exit-code INTEGER] [--artifact-path 'RELATIVE_PATH'] [--commit-sha COMMIT_SHA] [--verify]\n\
Replace the capitalized placeholders with evidence for the active owned spec. STATUS is pass, fail, or unchecked. AC_ID starts with a letter or digit and contains only letters, digits, underscore, dot, or hyphen. CITATION must be nonblank. Each flag occurs at most once. INTEGER is a decimal safe integer; RELATIVE_PATH is a normalized repository-relative path; COMMIT_SHA is exactly 40 lowercase hexadecimal characters. Use literal shell words and quote data; this writer grammar admits no expansions, substitutions, operators, redirections, or general CLI commands.\n\
--verify requires both --artifact-path and --commit-sha. Verification checks citations only and never runs tests. --command and --exit-code record supplied evidence; they do not execute a command or establish a fresh test result. Program names, braces, and operators inside quoted CITATION or DESCRIPTION remain inert data.\n\
Results contain exitCode, stdoutBase64, stderrBase64, and userSpawnMayHaveOccurred. Decode the base64 stdout to inspect the writer's auditCommit, specSha256, eventSequence, and auditCommitContinuation or its publication-failure disposition.\n\
For a pending audit, use the ordinary authorized CLI workflow: caws specs commit SPEC_ID, then check clean status before merge or closure. After failed publication, inspect the canonical spec and events before considering any retry.\n\
These paths are configured, not a live generation or authority verification. Each execution still validates its native context, pins, source profile, authority, and fence. Other closed Bash profiles remain available under their existing authorization rules.",
        quote(&config.node.path),
        quote(&config.writer.path),
    )
}
fn execution_result(id: Value, value: Value) -> Value {
    let error = value.get("ok") != Some(&Value::Bool(true));
    result(id, value, error)
}

fn worker_reply(outcome: OwnerOutcome) -> Value {
    match outcome {
        OwnerOutcome::Completed(done) => {
            json!({"ok":done.status.success(),"stdoutBase64":STANDARD.encode(done.stdout),
            "stderrBase64":STANDARD.encode(done.stderr),"exitCode":done.status.code(),"userSpawnMayHaveOccurred":true})
        }
        OwnerOutcome::Failed(mut f) => {
            settle(f.child.take());
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;
            if let Some(mut job) = f.job_failure.take() {
                settle(job.retained_child.take());
                if let execution_child::FailureKind::Nonzero(status) = &job.kind {
                    exit_code = status.code();
                }
                stdout = job.stdout;
                stderr = job.stderr;
            }
            let fence_released = f.fence.as_mut().is_none_or(|f| f.try_release().is_ok());
            json!({"ok":false,"reason":format!("{:?}",f.reason),"userSpawnMayHaveOccurred":f.user_spawn_may_have_occurred,
                "fenceReleased":fence_released,"exitCode":exit_code,"stdoutBase64":STANDARD.encode(stdout),"stderrBase64":STANDARD.encode(stderr)})
        }
    }
}

/// Cancellation, EOF and reply loss never kill a worker which may own a USER
/// child in another process group. Signal the control socket, drain bounded
/// output, and retain the actual worker until it has settled its own custody.
fn service_worker(
    mut child: Child,
    mut producer: UnixStream,
    deadline: Instant,
    control: &crate::monotonic_deadline::EffectCheck<'_>,
) -> io::Result<Value> {
    // Piped streams are installed by our sole caller before this actual spawn.
    let mut stdout = child.stdout.take().expect("private worker stdout");
    let mut stderr = child.stderr.take().expect("private worker stderr");
    drop(child.stdin.take());
    let stdout_nonblocking = nonblocking(stdout.as_raw_fd()).is_ok();
    let stderr_nonblocking = nonblocking(stderr.as_raw_fd()).is_ok();
    let mut output = Vec::new();
    let mut out_eof = false;
    let mut err_eof = false;
    let mut failed = !stdout_nonblocking || !stderr_nonblocking;
    let mut signalled = false;
    let mut stderr_bytes = 0usize;
    loop {
        if Instant::now() >= deadline || control("worker_service").is_err() {
            failed = true;
        }
        if failed && !signalled {
            let _ = producer.write_all(&[crate::execution_control::CANCEL_BYTE]);
            let _ = producer.shutdown(std::net::Shutdown::Write);
            signalled = true;
        }
        let out_fd = stdout.as_raw_fd();
        let err_fd = stderr.as_raw_fd();
        for (reader, eof, is_stdout, fd, nonblock) in [
            (
                &mut stdout as &mut dyn Read,
                &mut out_eof,
                true,
                out_fd,
                stdout_nonblocking,
            ),
            (
                &mut stderr as &mut dyn Read,
                &mut err_eof,
                false,
                err_fd,
                stderr_nonblocking,
            ),
        ] {
            for _ in 0..16 {
                if !nonblock {
                    let mut poll = libc::pollfd {
                        fd,
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    if unsafe { libc::poll(&mut poll, 1, 0) } <= 0 {
                        break;
                    }
                }
                let mut bytes = [0u8; 8192];
                match reader.read(&mut bytes) {
                    Ok(0) => {
                        *eof = true;
                        break;
                    }
                    Ok(n) => {
                        if is_stdout {
                            if output.len() + n <= REPLY_LIMIT {
                                output.extend_from_slice(&bytes[..n]);
                            } else {
                                failed = true;
                            }
                        } else {
                            stderr_bytes = stderr_bytes.saturating_add(n);
                            if stderr_bytes > 65536 {
                                failed = true;
                            }
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        failed = true;
                        *eof = true;
                        break;
                    }
                }
            }
        }
        // The worker's source contract settles every owned child before exit.
        // Keep its unreaped identity while pipes or descendants remain active.
        match crate::owned_group::settlement_before_reap(&child) {
            Ok(crate::owned_group::GroupSettlement::Exited { .. }) if out_eof && err_eof => {
                let status = child.wait()?;
                if failed || !status.success() {
                    return Err(refused());
                }
                return serde_json::from_slice(&output).map_err(|_| refused());
            }
            Ok(_) => (),
            Err(_) => {
                failed = true;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Resolve canonical common checkout with the fixed system Git only. This
/// command does not run hooks, helpers, discovery, pager or fsmonitor programs.
fn project(
    caller: &str,
    deadline: &MonotonicDeadline,
    cancelled: &AtomicBool,
    control: &crate::monotonic_deadline::EffectCheck<'_>,
) -> io::Result<String> {
    if fs::canonicalize(caller)? != Path::new(caller) || !fs::metadata(caller)?.is_dir() {
        return Err(refused());
    }
    let mut cmd = Command::new("/usr/bin/git");
    cmd.args([
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-C",
        caller,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ])
    .env_clear()
    .env("PATH", "/usr/bin:/bin")
    .env("LC_ALL", "C")
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env("GIT_CONFIG_SYSTEM", "/dev/null")
    .env("GIT_CONFIG_GLOBAL", "/dev/null")
    .env("GIT_TERMINAL_PROMPT", "0")
    .current_dir("/")
    .process_group(0)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    configure_private_child(&mut cmd)?;
    control("project_spawn").map_err(|_| refused())?;
    let child = cmd.spawn()?;
    drop(cmd);
    let output = execution_child::service_child(
        child,
        b"",
        deadline.expires(),
        cancelled,
        8192,
        8192,
        16384,
        grace(),
        control,
    )
    .map_err(|f| {
        settle(f.retained_child);
        refused()
    })?;
    let raw = String::from_utf8(output.stdout).map_err(|_| refused())?;
    let common = raw.strip_suffix('\n').ok_or_else(refused)?;
    let common = Path::new(common);
    if common.file_name().and_then(|p| p.to_str()) != Some(".git") {
        return Err(refused());
    }
    let common = fs::canonicalize(common)?;
    let root = common.parent().ok_or_else(refused)?;
    if !root.join(".caws").is_dir() {
        return Err(refused());
    }
    root.to_str().map(str::to_owned).ok_or_else(refused)
}

fn execute_call(
    config: &Config,
    config_path: &Path,
    input: &RefCell<Input>,
    peer: &HostChannel,
    bytes: &[u8],
    possible: &Cell<bool>,
) -> io::Result<Value> {
    let prep = MonotonicDeadline::capture(Duration::from_secs(30)).map_err(|_| refused())?;
    // This earlier producer bound also clips a long worker job. It is never
    // renewed by host revalidation, startup, or reply transit.
    let overall = MonotonicDeadline::capture(Duration::from_secs(120)).map_err(|_| refused())?;
    let call = execution_ingress::parse_call(bytes).map_err(|_| refused())?;
    let id: Value = serde_json::from_str(&call.id_json).map_err(|_| refused())?;
    let cancelled = AtomicBool::new(false);
    let host = HostContext::capture(&config.host, &prep)?;
    peer.revalidate(config, &prep)?;
    if peer.input.pid() != host.pid() || peer.input.birth() != host.birth() {
        return Err(refused());
    }
    let next_host_check = Cell::new(Instant::now());
    let control = |stage: &'static str| {
        input
            .borrow_mut()
            .pump(Some(&id), &cancelled)
            .map_err(|_| "stdio unavailable".to_owned())?;
        if cancelled.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        if matches!(
            stage,
            "project_spawn" | "worker_spawn" | "execution_discovery_spawn"
        ) || Instant::now() >= next_host_check.get()
        {
            host.revalidate(&overall)
                .map_err(|_| "host unavailable".to_owned())?;
            peer.revalidate(config, &overall)
                .map_err(|_| "channel unavailable".to_owned())?;
            next_host_check.set(Instant::now() + Duration::from_secs(1));
        }
        Ok(())
    };
    control("project").map_err(|_| refused())?;
    verify_self(config, &prep)?;
    verify_generation(config, &prep)?;
    verify_image(&config.writer, &prep)?;
    let canonical = project(&call.caller_anchor, &prep, &cancelled, &control)?;
    let pins = PinnedAuthorizer {
        node: ProgramImage {
            path: config.node.path.clone(),
            sha256: config.node.sha256.clone(),
        },
        entry: ProgramImage {
            path: config.authorizer.path.clone(),
            sha256: config.authorizer.sha256.clone(),
        },
        writer: Some(ProgramImage {
            path: config.writer.path.clone(),
            sha256: config.writer.sha256.clone(),
        }),
    };
    let prepared = execution_prepare::prepare(
        &call,
        &host,
        &canonical,
        &config.host,
        &pins,
        &config.discovery,
        &prep,
        &cancelled,
        &control,
    )
    .map_err(|f| {
        settle(f.child);
        refused()
    })?;
    let frame = execution_carrier::encode_startup(&prepared, &pins, &prep)?;
    let (mut producer, worker) = UnixStream::pair()?;
    producer.set_nonblocking(true)?;
    // Both endpoints are CLOEXEC in the producer; only child fd3 is exported.
    for endpoint in [&producer, &worker] {
        let flags = unsafe { libc::fcntl(endpoint.as_raw_fd(), libc::F_GETFD) };
        if flags < 0
            || unsafe {
                libc::fcntl(
                    endpoint.as_raw_fd(),
                    libc::F_SETFD,
                    flags | libc::FD_CLOEXEC,
                )
            } < 0
        {
            return Err(refused());
        }
    }
    let mut command = Command::new(&config.host.path);
    command
        .arg("sandbox")
        .arg("--sandbox-state-json")
        .arg(&call.sandbox_state_json)
        .arg("--")
        .arg(&config.native.path)
        .arg("--worker")
        .arg("--config")
        .arg(config_path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .current_dir("/")
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_private_child(&mut command)?;
    configure_child_fds(&mut command, &[(worker.as_fd(), STARTUP_FD)])?;
    host.revalidate(&prep)?;
    verify_self(config, &prep)?;
    verify_generation(config, &prep)?;
    verify_image(&config.writer, &prep)?;
    control("worker_spawn").map_err(|_| refused())?;
    // A lost/invalid worker reply cannot establish that no USER spawn happened.
    possible.set(true);
    let child = command.spawn()?;
    drop(command);
    drop(worker);
    // A failed frame write closes the liveness socket, but custody of the real
    // launcher/worker is still settled before returning.
    let mut remaining = frame.as_slice();
    while !remaining.is_empty() {
        if prep.check().is_err() || control("startup_write").is_err() {
            drop(producer);
            settle(Some(child));
            return Err(refused());
        }
        match producer.write(remaining) {
            Ok(0) => {
                drop(producer);
                settle(Some(child));
                return Err(refused());
            }
            Ok(n) => remaining = &remaining[n..],
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                let mut p = libc::pollfd {
                    fd: producer.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                unsafe {
                    libc::poll(&mut p, 1, 10);
                }
            }
            Err(_) => {
                drop(producer);
                settle(Some(child));
                return Err(refused());
            }
        }
    }
    service_worker(child, producer, overall.expires(), &control)
}

fn worker(config: &Config) -> io::Result<()> {
    let bootstrap = MonotonicDeadline::capture(Duration::from_secs(30)).map_err(|_| refused())?;
    verify_self(config, &bootstrap)?;
    verify_generation(config, &bootstrap)?;
    verify_image(&config.writer, &bootstrap)?;
    // No fallback to stdin, environment, a file, or a reconnecting socket.
    if unsafe { libc::fcntl(STARTUP_FD, libc::F_GETFD) } < 0 {
        return Err(refused());
    }
    let stream = unsafe { UnixStream::from_raw_fd(STARTUP_FD) };
    let startup = execution_carrier::receive_startup(stream, &config.native, &bootstrap)?;
    let (record, trusted, pins, deadline, control, _) = startup.into_parts();
    if pins.node.path != config.node.path
        || pins.node.sha256 != config.node.sha256
        || pins.entry.path != config.authorizer.path
        || pins.entry.sha256 != config.authorizer.sha256
        || pins
            .writer
            .as_ref()
            .is_none_or(|w| w.path != config.writer.path || w.sha256 != config.writer.sha256)
    {
        return Err(refused());
    }
    let live = |_: &'static str| {
        control
            .poll()
            .map_err(|_| "producer unavailable".to_owned())
    };
    let outcome = execution_owner::execute(
        record,
        &trusted,
        &pins,
        &deadline,
        Arc::new(AtomicBool::new(false)),
        &live,
    );
    let reply = worker_reply(outcome);
    write_json(&reply)
}

/// Entrypoint intentionally exposes no direct execution API to model callers.
pub fn main_entry() -> i32 {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    let worker_mode = first.as_deref() == Some(std::ffi::OsStr::new("--worker"));
    let config_flag = if worker_mode { args.next() } else { first };
    if config_flag.as_deref() != Some(std::ffi::OsStr::new("--config")) {
        return 2;
    }
    let Some(path) = args.next().map(PathBuf::from) else {
        return 2;
    };
    if args.next().is_some() {
        return 2;
    }
    let config = match load_config(&path) {
        Ok(c) => c,
        Err(_) => return 2,
    };
    if worker_mode {
        return if worker(&config).is_ok() { 0 } else { 2 };
    }
    let startup = match MonotonicDeadline::capture(Duration::from_secs(30)) {
        Ok(d) => d,
        Err(_) => return 2,
    };
    if verify_self(&config, &startup).is_err() {
        return 2;
    }
    let peer = match host_channel(&config, &startup) {
        Ok(p) => p,
        Err(_) => return 2,
    };
    let input = match Input::new() {
        Ok(i) => RefCell::new(i),
        Err(_) => return 2,
    };
    loop {
        let line = match input.borrow_mut().next() {
            Ok(Some(l)) => l,
            Ok(None) => return 0,
            Err(_) => return 2,
        };
        let packet_bound = match MonotonicDeadline::capture(Duration::from_secs(30)) {
            Ok(d) => d,
            Err(_) => return 2,
        };
        if peer.revalidate(&config, &packet_bound).is_err() {
            return 2;
        }
        let value: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => return 2,
        };
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let reply = match value.get("method").and_then(Value::as_str) {
            Some("initialize") => json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion":"2024-11-05","serverInfo":{"name":"caws-execution","version":"1"},
                "capabilities":{"tools":{},"experimental":{"codex/caller-context":{"version":1},"codex/sandbox-state":{}}}}}),
            Some("notifications/initialized") => continue,
            Some("ping") => json!({"jsonrpc":"2.0","id":id,"result":{}}),
            Some("tools/list") => json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{
                "name":"caws_exec","description":tool_description(&config),
                "inputSchema":{"type":"object","additionalProperties":false,"required":["source"],
                    "properties":{"source":{"type":"string"},"cwd":{"type":"string"}}}}]}}),
            Some("tools/call") => {
                let possible = Cell::new(false);
                match execute_call(&config, &path, &input, &peer, &line, &possible) {
                    Ok(v) => execution_result(id, v),
                    Err(_) => result(
                        id,
                        json!({"ok":false,"reason":"NativeBoundaryRefused","userSpawnMayHaveOccurred":possible.get()}),
                        true,
                    ),
                }
            }
            _ if id.is_null() => continue,
            _ => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
            }
        };
        if write_json(&reply).is_err() {
            return 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    #[test]
    fn consumer_exit_status_controls_mcp_error_without_losing_structured_stdout() {
        for code in [0, 1] {
            let source = json!({"status":if code == 0 {"published"} else {"partial_publication"},
                "eventPublished":true,"specPublished":code == 0})
            .to_string();
            let source_stdout = format!("{source}\n").into_bytes();
            let output = Command::new("/bin/sh")
                .args(["-c", "printf '%s\\n' \"$2\"; exit \"$1\"", "fixture"])
                .arg(code.to_string())
                .arg(source)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(code));
            assert_eq!(output.stdout, source_stdout);
            let reply = worker_reply(OwnerOutcome::Completed(execution_child::Completed {
                status: output.status,
                stdout: output.stdout.clone(),
                stderr: output.stderr.clone(),
            }));
            assert_eq!(reply["ok"], code == 0);
            assert_eq!(reply["exitCode"], code);
            assert_eq!(reply["userSpawnMayHaveOccurred"], true);
            let mcp = execution_result(json!(42), reply);
            assert_eq!(mcp["result"]["isError"], code != 0);
            let detail: Value =
                serde_json::from_str(mcp["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(
                STANDARD
                    .decode(detail["stdoutBase64"].as_str().unwrap())
                    .unwrap(),
                source_stdout
            );
            if code == 1 {
                // The real owner currently classifies nonzero child exit as a
                // job failure; retain its code and exact Source result too.
                let reply = worker_reply(OwnerOutcome::Failed(execution_owner::OwnerFailure {
                    reason: execution_owner::Refusal::JobIo,
                    child: None,
                    fence: None,
                    job_failure: Some(execution_child::Failure {
                        kind: execution_child::FailureKind::Nonzero(output.status),
                        stdout: output.stdout,
                        stderr: output.stderr,
                        retained_child: None,
                        cleanup_detail: None,
                    }),
                    user_spawn_may_have_occurred: true,
                }));
                assert_eq!(reply["exitCode"], 1);
                assert_eq!(reply["userSpawnMayHaveOccurred"], true);
                assert_eq!(
                    STANDARD
                        .decode(reply["stdoutBase64"].as_str().unwrap())
                        .unwrap(),
                    source_stdout
                );
                assert_eq!(
                    execution_result(json!(43), reply)["result"]["isError"],
                    true
                );
            }
        }
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "caws-server-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn config(&self) -> Config {
            let root = self.0.join("generation");
            fs::create_dir(&root).unwrap();
            let image = |path: &Path| ProgramImage {
                path: path.to_str().unwrap().into(),
                sha256: format!("{:x}", Sha256::digest(fs::read(path).unwrap())),
            };
            let files = ["authorizer.js", "discovery.js", "node", "writer-main.js"];
            for name in files {
                fs::write(root.join(name), name).unwrap();
            }
            let manifest = self.0.join("manifest.json");
            fs::write(&manifest, serde_json::to_vec(&json!({"schema":"caws.execution.generation.v1",
                "files":files.map(|name| json!({"path":name,"sha256":image(&root.join(name)).sha256}))})).unwrap()).unwrap();
            Config {
                schema: "caws.execution.server-config.v1".into(),
                native: image(&root.join("node")),
                host: image(&root.join("node")),
                node: image(&root.join("node")),
                authorizer: image(&root.join("authorizer.js")),
                discovery: image(&root.join("discovery.js")),
                writer: image(&root.join("writer-main.js")),
                generation: Generation {
                    root: root.to_str().unwrap().into(),
                    manifest: image(&manifest),
                },
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn generation_checks_content_additions_removals_and_symlinks() {
        let fixture = Fixture::new();
        let config = fixture.config();
        let deadline = MonotonicDeadline::capture(Duration::from_secs(30)).unwrap();
        assert!(verify_generation(&config, &deadline).is_ok());
        let root = Path::new(&config.generation.root);
        fs::write(root.join("added.js"), "injected").unwrap();
        assert!(verify_generation(&config, &deadline).is_err());
        fs::remove_file(root.join("added.js")).unwrap();
        fs::write(root.join("writer-main.js"), "different").unwrap();
        assert!(verify_generation(&config, &deadline).is_err());
        fs::write(root.join("writer-main.js"), "writer-main.js").unwrap();
        fs::remove_file(root.join("discovery.js")).unwrap();
        assert!(verify_generation(&config, &deadline).is_err());
        fs::write(root.join("discovery.js"), "discovery.js").unwrap();
        std::os::unix::fs::symlink(root.join("node"), root.join("injected-link")).unwrap();
        assert!(verify_generation(&config, &deadline).is_err());
        fs::remove_file(root.join("injected-link")).unwrap();
        fs::hard_link(
            root.join("writer-main.js"),
            fixture.0.join("outside-hardlink"),
        )
        .unwrap();
        assert!(verify_generation(&config, &deadline).is_err());
        fs::remove_file(fixture.0.join("outside-hardlink")).unwrap();
        assert!(verify_generation(&config, &deadline).is_ok());
    }
    #[test]
    fn cancellation_retains_worker_until_its_child_cleanup_finishes() {
        let fixture = Fixture::new();
        let marker = fixture.0.join("settled");
        let (producer, worker) = UnixStream::pair().unwrap();
        let mut cmd = Command::new("/bin/bash");
        cmd.args(["--noprofile","--norc","-c",
            "sleep 60 & pid=$!; IFS= read -r -n1 c <&3; kill $pid; wait $pid; printf settled > \"$1\"; printf '{\"ok\":true}'", "fixture"])
            .arg(&marker).process_group(0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        configure_private_child(&mut cmd).unwrap();
        configure_child_fds(&mut cmd, &[(worker.as_fd(), 3)]).unwrap();
        let child = cmd.spawn().unwrap();
        drop(cmd);
        drop(worker);
        let failure = |_: &'static str| Err("cancelled".into());
        assert!(
            service_worker(
                child,
                producer,
                Instant::now() + Duration::from_secs(5),
                &failure
            )
            .is_err()
        );
        assert_eq!(fs::read(marker).unwrap(), b"settled");
    }
    #[test]
    fn config_rejects_unknown_fields_and_missing_independent_pins() {
        let image = json!({"path":"/bin/true","sha256":"a".repeat(64)});
        let good = json!({"schema":"caws.execution.server-config.v1","native":image,"host":image,
            "node":image,"authorizer":image,"discovery":image,"writer":image,
            "generation":{"root":"/generation","manifest":image}});
        assert!(serde_json::from_value::<Config>(good.clone()).is_ok());
        let mut bad = good.clone();
        bad["sameHostMacosVerified"] = json!(true);
        assert!(serde_json::from_value::<Config>(bad).is_err());
        let mut bad = good;
        bad.as_object_mut().unwrap().remove("native");
        assert!(serde_json::from_value::<Config>(bad).is_err());
    }
}
