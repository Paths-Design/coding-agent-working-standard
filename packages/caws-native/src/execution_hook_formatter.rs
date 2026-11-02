//! Fixed formatter role. The caller supplies Source-admitted paths under its fence.
//! Retained custody requires the worker itself to stay alive; a stale lock is not
//! evidence that an unobserved writer has exited.
use super::*;
use crate::execution_prepared::Execution;
use crate::execution_server::private_roots::SourceWriteBinding;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    os::fd::{BorrowedFd, RawFd},
    process::ExitStatus,
};

#[derive(Clone, Copy)]
pub(crate) enum FormatterKind {
    Eslint,
    Prettier,
}

/// Every image and identity here comes from the authenticated native startup
/// carrier. There is deliberately no caller-provided argv or environment.
pub(crate) struct FormatterRuntime<'a> {
    pub host: &'a ProgramImage,
    pub node: &'a ProgramImage,
    pub bootstrap: &'a ProgramImage,
    pub entry: &'a ProgramImage,
    pub sandbox_state_json: &'a str,
    pub scratch_root: &'a Path,
    pub homes: &'a RuntimeHomes,
    pub session_id: &'a str,
    pub thread_id: &'a str,
    pub call_id: &'a str,
    pub agent_surface: &'a str,
}
pub(crate) struct FormatterRequest<'a> {
    pub kind: FormatterKind,
    pub source_root: &'a Path,
    pub source_files: &'a [PathBuf],
    pub read_only_paths: &'a [PathBuf],
}

pub(crate) enum FormatterOutcome {
    Refused {
        fence: ExecutionFence,
        reason: String,
    },
    Settled {
        fence: ExecutionFence,
        status: ExitStatus,
        gate_may_have_opened: bool,
        refused: bool,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    /// Caller must retain this value AND the worker process until settlement.
    Retained {
        custody: RetainedFormatter,
        reason: String,
    },
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "formatter launch unavailable",
    )
}
fn safe_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}
fn digest(value: &impl serde::Serialize) -> io::Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn arguments(kind: FormatterKind, root: &Path, files: &[PathBuf]) -> io::Result<Vec<String>> {
    if files.is_empty() || files.len() > 256 {
        return Err(invalid());
    }
    let mut paths = files.to_vec();
    paths.sort();
    if paths.windows(2).any(|w| w[0] == w[1]) {
        return Err(invalid());
    }
    let mut args = match kind {
        FormatterKind::Eslint => vec!["--fix".into(), "--".into()],
        FormatterKind::Prettier => vec![
            "--write".into(),
            "--no-error-on-unmatched-pattern".into(),
            "--".into(),
        ],
    };
    for path in paths {
        let rel = path.strip_prefix(root).map_err(|_| invalid())?;
        let s = rel.to_str().ok_or_else(invalid)?;
        if !safe_text(s)
            || s.starts_with('/')
            || rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(invalid());
        }
        args.push(format!("./{s}"));
    }
    if serde_json::to_vec(&args)?.len() > 65536 {
        return Err(invalid());
    }
    Ok(args)
}
fn environment(
    node_dir: &str,
    root: &str,
    tmp: &str,
    homes: &RuntimeHomes,
    thread_id: &str,
    agent_surface: &str,
) -> io::Result<BTreeMap<String, String>> {
    if !safe_text(node_dir) || node_dir.contains(':') || !safe_text(root) || !safe_text(tmp) {
        return Err(invalid());
    }
    let mut result = BTreeMap::new();
    for (key, value) in [
        ("PATH", format!("{node_dir}:/usr/bin:/bin")),
        ("LC_ALL", "C".to_owned()),
        ("PWD", root.to_owned()),
        ("TMPDIR", tmp.to_owned()),
        ("HOME", homes.home.clone()),
        ("CAWS_HOME", homes.caws_home.clone()),
        ("CODEX_HOME", homes.codex_home.clone()),
        ("CODEX_THREAD_ID", thread_id.to_owned()),
        ("CODEX_SANDBOX", "seatbelt".to_owned()),
        ("CODEX_SANDBOX_NETWORK_DISABLED", "1".to_owned()),
        ("CAWS_AGENT_SURFACE", agent_surface.to_owned()),
        ("CAWS_PROJECT_DIR", root.to_owned()),
    ] {
        if !safe_text(&value) || result.insert(key.to_owned(), value).is_some() {
            return Err(invalid());
        }
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    schema: String,
    launch_id: String,
    pid: u32,
    node: String,
    cwd: String,
    argv_sha256: String,
    environment_sha256: String,
}
fn ready(
    bytes: &[u8],
    launch_id: &str,
    node: &str,
    cwd: &str,
    argv_hash: &str,
    env_hash: &str,
) -> io::Result<u32> {
    let prefix = b"CAWS_FORMATTER_READY_V1 ";
    let json = bytes.strip_prefix(prefix).ok_or_else(invalid)?;
    let message: Ready = serde_json::from_slice(json)?;
    if message.schema != "caws.execution.formatter-ready.v1"
        || message.launch_id != launch_id
        || message.pid <= 1
        || message.node != node
        || message.cwd != cwd
        || message.argv_sha256 != argv_hash
        || message.environment_sha256 != env_hash
    {
        return Err(invalid());
    }
    Ok(message.pid)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        os::{fd::FromRawFd, unix::ffi::OsStrExt},
    };

    #[derive(PartialEq, Eq)]
    struct Instance {
        pid: u32,
        parent: u32,
        sec: u64,
        usec: u64,
    }
    fn instance(pid: u32, host: u32, node: &Path) -> io::Result<Instance> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        if unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as i32,
            )
        } != size as i32
        {
            return Err(invalid());
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid
            || info.pbi_ppid != host
            || info.pbi_uid != unsafe { libc::geteuid() }
            || info.pbi_start_tvsec == 0
            || info.pbi_start_tvusec >= 1_000_000
            || info.pbi_status == libc::SZOMB
        {
            return Err(invalid());
        }
        let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let len =
            unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
        if len <= 0
            || len as usize > path.len()
            || Path::new(
                std::str::from_utf8(&path[..len as usize])
                    .map_err(|_| invalid())?
                    .trim_end_matches('\0'),
            ) != node
        {
            return Err(invalid());
        }
        Ok(Instance {
            pid,
            parent: host,
            sec: info.pbi_start_tvsec,
            usec: info.pbi_start_tvusec,
        })
    }
    pub(super) struct Observer {
        queue: File,
        pid: u32,
        exited: bool,
    }
    impl Observer {
        fn register(pid: u32, host: u32, node: &Path) -> io::Result<Self> {
            let before = instance(pid, host, node)?;
            let raw = unsafe { libc::kqueue() };
            if raw < 0 {
                return Err(io::Error::last_os_error());
            }
            let queue = unsafe { File::from_raw_fd(raw) };
            let flags = unsafe { libc::fcntl(raw, libc::F_GETFD) };
            if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            event.ident = pid as _;
            event.filter = libc::EVFILT_PROC;
            event.flags = (libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR) as _;
            event.fflags = libc::NOTE_EXIT;
            if unsafe { libc::kevent(raw, &event, 1, std::ptr::null_mut(), 0, std::ptr::null()) }
                < 0
            {
                return Err(io::Error::last_os_error());
            }
            if instance(pid, host, node)? != before {
                return Err(invalid());
            }
            let mut result = Self {
                queue,
                pid,
                exited: false,
            };
            if result.poll()? {
                return Err(invalid());
            }
            Ok(result)
        }
        fn poll(&mut self) -> io::Result<bool> {
            if self.exited {
                return Ok(true);
            }
            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            let timeout = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            let n = unsafe {
                libc::kevent(
                    self.queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut event,
                    1,
                    &timeout,
                )
            };
            if n < 0 {
                return Err(io::Error::last_os_error());
            }
            if n == 1 {
                if event.ident != self.pid as usize
                    || event.filter != libc::EVFILT_PROC
                    || event.flags & libc::EV_ERROR != 0
                    || event.fflags & libc::NOTE_EXIT == 0
                {
                    return Err(invalid());
                }
                self.exited = true;
            }
            Ok(self.exited)
        }
    }
    fn install_gate(launch: &PrivateLaunch) -> io::Result<()> {
        let temp = launch.invocation_root.join("formatter-go.pending");
        let dest = launch.invocation_root.join("formatter-go.json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)?;
        let bytes = serde_json::to_vec(
            &json!({"schema":"caws.execution.formatter-go.v1","launchId":launch.launch_id}),
        )?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        let old = CString::new(temp.as_os_str().as_bytes()).map_err(|_| invalid())?;
        let new = CString::new(dest.as_os_str().as_bytes()).map_err(|_| invalid())?;
        unsafe extern "C" {
            fn renameatx_np(
                fromfd: libc::c_int,
                from: *const libc::c_char,
                tofd: libc::c_int,
                to: *const libc::c_char,
                flags: libc::c_uint,
            ) -> libc::c_int;
        }
        if unsafe {
            renameatx_np(
                libc::AT_FDCWD,
                old.as_ptr(),
                libc::AT_FDCWD,
                new.as_ptr(),
                4,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    fn nonblocking(fd: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    pub(super) fn prepare_observer(pid: u32, host: u32, node: &Path) -> io::Result<Observer> {
        Observer::register(pid, host, node)
    }
    pub(super) fn gate(launch: &PrivateLaunch) -> io::Result<()> {
        install_gate(launch)
    }
    pub(super) fn exited(observer: &mut Observer) -> io::Result<bool> {
        observer.poll()
    }
    pub(super) fn set_nonblocking(fd: RawFd) -> io::Result<()> {
        nonblocking(fd)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn formatter_note_exit_binds_direct_child_instance_and_reports_real_exit() {
            let node = fs::canonicalize("/bin/sleep").unwrap();
            let mut child = Command::new(&node).arg("2").spawn().unwrap();
            let pid = child.id();
            let host = std::process::id();
            assert!(Observer::register(pid, host + 1, &node).is_err());
            let mut observer = Observer::register(pid, host, &node).unwrap();
            assert!(!observer.poll().unwrap());
            child.kill().unwrap();
            let mut seen = false;
            for _ in 0..200 {
                if observer.poll().unwrap() {
                    seen = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(seen, "no NOTE_EXIT for direct child");
            assert!(!child.wait().unwrap().success());
        }
    }
}

/// Owns the unreaped supervisor and the actual writer observation. Dropping it
/// leaks these objects and the armed lock instead of silently unlocking; that
/// does not survive worker exit as live custody and needs operator recovery.
pub(crate) struct RetainedFormatter {
    host: Option<Child>,
    fence: Option<ExecutionFence>,
    launch: Option<PrivateLaunch>,
    pump: Option<ManifestPump>,
    #[cfg(target_os = "macos")]
    observer: Option<platform::Observer>,
    go: bool,
    refused: bool,
    ready_line: Vec<u8>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    node: String,
    cwd: String,
    argv_hash: String,
    env_hash: String,
}
impl Drop for RetainedFormatter {
    fn drop(&mut self) {
        if let Some(v) = self.host.take() {
            std::mem::forget(v);
        }
        if let Some(v) = self.fence.take() {
            std::mem::forget(v);
        }
        if let Some(v) = self.launch.take() {
            std::mem::forget(v);
        }
        if let Some(v) = self.pump.take() {
            std::mem::forget(v);
        }
        #[cfg(target_os = "macos")]
        if let Some(v) = self.observer.take() {
            std::mem::forget(v);
        }
    }
}
#[cfg(target_os = "macos")]
impl RetainedFormatter {
    /// Poll without killing the supervisor or assuming group/PID census proves exit.
    pub(crate) fn poll(
        &mut self,
        deadline: &MonotonicDeadline,
        control: &EffectCheck<'_>,
    ) -> io::Result<Option<(ExitStatus, bool, bool, Vec<u8>, Vec<u8>, ExecutionFence)>> {
        let result = self.poll_inner(deadline, control);
        if result.is_err() {
            self.refused = true;
        }
        result
    }
    fn poll_inner(
        &mut self,
        deadline: &MonotonicDeadline,
        control: &EffectCheck<'_>,
    ) -> io::Result<Option<(ExitStatus, bool, bool, Vec<u8>, Vec<u8>, ExecutionFence)>> {
        let host = self.host.as_mut().ok_or_else(invalid)?;
        if !self.go {
            if let Some(status) = host.try_wait()? {
                let fence = self.fence.take().ok_or_else(invalid)?;
                self.host.take();
                self.launch.take();
                self.pump.take();
                return Ok(Some((
                    status,
                    false,
                    self.refused,
                    std::mem::take(&mut self.stdout),
                    std::mem::take(&mut self.stderr),
                    fence,
                )));
            }
            // An earlier readiness/control/transport failure permanently closes
            // admission. Continuing custody polling must never reopen GO.
            if self.refused {
                self.pump.take();
                return Ok(None);
            }
        }
        if let Some(pump) = self.pump.as_mut() {
            pump.pump()?;
        }
        fn drain<T: Read>(
            pipe: &mut Option<T>,
            output: &mut Vec<u8>,
            refused: bool,
        ) -> io::Result<()> {
            if let Some(reader) = pipe.as_mut() {
                let mut b = [0; 8192];
                loop {
                    match reader.read(&mut b) {
                        Ok(0) => {
                            *pipe = None;
                            break;
                        }
                        Ok(n) => {
                            let left = (1024 * 1024_usize).saturating_sub(output.len());
                            if n > left && !refused {
                                return Err(invalid());
                            }
                            output.extend_from_slice(&b[..n.min(left)]);
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(e) => return Err(e),
                    }
                }
            }
            Ok(())
        }
        drain(&mut host.stdout, &mut self.stdout, self.refused)?;
        drain(&mut host.stderr, &mut self.stderr, self.refused)?;
        if !self.go {
            if let Some(end) = self.stdout.iter().position(|b| *b == b'\n') {
                self.ready_line = self.stdout.drain(..=end).collect();
                self.ready_line.pop();
                let launch = self.launch.as_ref().ok_or_else(invalid)?;
                let pid = ready(
                    &self.ready_line,
                    &launch.launch_id,
                    &self.node,
                    &self.cwd,
                    &self.argv_hash,
                    &self.env_hash,
                )?;
                let mut observer =
                    platform::prepare_observer(pid, host.id(), Path::new(&self.node))?;
                deadline.check().map_err(|_| invalid())?;
                control("formatter_before_go").map_err(|_| invalid())?;
                self.fence.as_ref().ok_or_else(invalid)?.validate()?;
                launch.verify_empty()?;
                deadline.check().map_err(|_| invalid())?;
                control("formatter_gate_commit").map_err(|_| invalid())?;
                if platform::exited(&mut observer)? {
                    return Err(invalid());
                }
                self.observer = Some(observer);
                // From this point errors must retain the observer and fence: the
                // atomic rename may have taken effect even when reporting failure.
                self.go = true;
                platform::gate(launch)?;
            } else if self.stdout.len() > 65536 {
                return Err(invalid());
            }
        }
        if self.go && platform::exited(self.observer.as_mut().ok_or_else(invalid)?)? {
            if let Some(status) = host.try_wait()? {
                if host.stdout.is_none() && host.stderr.is_none() {
                    let fence = self.fence.take().ok_or_else(invalid)?;
                    self.host.take();
                    self.launch.take();
                    self.pump.take();
                    self.observer.take();
                    return Ok(Some((
                        status,
                        true,
                        self.refused,
                        std::mem::take(&mut self.stdout),
                        std::mem::take(&mut self.stderr),
                        fence,
                    )));
                }
            }
        }
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn run_formatter(
    runtime: &FormatterRuntime<'_>,
    request: &FormatterRequest<'_>,
    fence: ExecutionFence,
    deadline: &MonotonicDeadline,
    control: &EffectCheck<'_>,
) -> FormatterOutcome {
    let setup = (|| -> io::Result<(PrivateLaunch, Execution, String, String)> {
        deadline.check().map_err(|_| invalid())?;
        fence.validate()?;
        let live = || deadline.check().map_err(|_| Refusal::Expired);
        runtime.homes.validate(&live).map_err(|_| invalid())?;
        for image in [runtime.host, runtime.node, runtime.bootstrap, runtime.entry] {
            image_valid(image, &live).map_err(|_| invalid())?;
        }
        for value in [
            runtime.session_id,
            runtime.thread_id,
            runtime.call_id,
            runtime.agent_surface,
        ] {
            if !safe_text(value) {
                return Err(invalid());
            }
        }
        if runtime.sandbox_state_json.is_empty() || runtime.sandbox_state_json.contains('\0') {
            return Err(invalid());
        }
        let root = request
            .source_root
            .to_str()
            .filter(|s| safe_text(s))
            .ok_or_else(invalid)?;
        let node_dir = Path::new(&runtime.node.path)
            .parent()
            .and_then(Path::to_str)
            .filter(|s| safe_text(s) && !s.contains(':'))
            .ok_or_else(invalid)?;
        if Path::new(&runtime.bootstrap.path)
            .file_name()
            .and_then(|s| s.to_str())
            != Some("git-hook-formatter-main.js")
        {
            return Err(invalid());
        }
        let args = arguments(request.kind, request.source_root, request.source_files)?;
        let binding = SourceWriteBinding::bind(
            request.source_root,
            request.source_files,
            request.read_only_paths,
        )?;
        control("formatter_prepare").map_err(|_| invalid())?;
        let mut launch = PrivateLaunch::create(
            runtime.scratch_root,
            request.source_root,
            runtime.session_id,
            runtime.thread_id,
            runtime.call_id,
            runtime.sandbox_state_json,
        )?;
        let remaining = deadline
            .expires()
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(30_000) as u64;
        if remaining == 0 {
            return Err(invalid());
        }
        let descriptor = json!({"schema":"caws.execution.formatter-bootstrap.v1","launchId":launch.launch_id,"invocationRoot":launch.invocation_root,"cwd":root,"entry":{"path":runtime.entry.path,"sha256":runtime.entry.sha256},"args":args,"timeoutMs":remaining});
        let encoded = STANDARD.encode(serde_json::to_vec(&descriptor)?);
        if encoded.len() > 131072 {
            return Err(invalid());
        }
        let argv = vec![
            runtime.node.path.clone(),
            runtime.bootstrap.path.clone(),
            "--launch".to_owned(),
            encoded,
        ];
        let env = environment(
            node_dir,
            root,
            launch.tmp_root.to_str().ok_or_else(invalid)?,
            runtime.homes,
            runtime.thread_id,
            runtime.agent_surface,
        )?;
        let argv_hash = digest(&argv)?;
        let env_hash = digest(&env)?;
        let entries: Vec<Value> = env
            .iter()
            .map(|(name, value)| json!({"name":name,"value":value}))
            .collect();
        let execution: Execution = serde_json::from_value(
            json!({"executable":{"path":runtime.node.path,"sha256":runtime.node.sha256},"argv":argv,"cwd":root,"environment":entries,"stdinBase64":""}),
        )?;
        launch.bind_execution(&execution, deadline)?;
        launch.attach_source_writes(binding)?;
        launch.verify_execution(&execution, deadline)?;
        fence.validate()?;
        deadline.check().map_err(|_| invalid())?;
        Ok((launch, execution, argv_hash, env_hash))
    })();
    let (launch, execution, argv_hash, env_hash) = match setup {
        Ok(v) => v,
        Err(e) => {
            return FormatterOutcome::Refused {
                fence,
                reason: e.to_string(),
            }
        }
    };
    let spawn = (|| -> io::Result<(Child, ManifestPump)> {
        let (reader, pump) = ManifestPump::new(&launch.manifest)?;
        let mut command = Command::new(&runtime.host.path);
        command
            .arg("sandbox")
            .arg("--sandbox-state-json")
            .arg(runtime.sandbox_state_json)
            .arg("--sandbox-state-write-ceiling-json")
            .arg(&launch.ceiling_json)
            .arg("--sandbox-state-write-ceiling-manifest-fd")
            .arg(MANIFEST_FD.to_string())
            .arg("--")
            .args(&execution.argv)
            .current_dir("/")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_private_child(&mut command)?;
        let raw_sources = launch.source_fd_mappings();
        let mut mappings = vec![(reader.as_fd(), MANIFEST_FD)];
        for (handle, target) in launch.handles().iter().zip(ROLE_FDS) {
            mappings.push((handle.as_fd(), target));
        }
        // SAFETY: `launch` owns all source descriptors through `spawn`; the
        // table is quiescent, and no borrowed descriptor is closed or remapped.
        for (fd, target) in raw_sources {
            mappings.push((unsafe { BorrowedFd::borrow_raw(fd) }, target));
        }
        configure_child_fds(&mut command, &mappings)?;
        let envelope = deadline.envelope();
        unsafe {
            command.pre_exec(move || {
                monotonic_deadline::check_before_exec(envelope)
                    .map_err(io::Error::from_raw_os_error)
            });
        }
        launch.verify_execution(&execution, deadline)?;
        fence.validate()?;
        deadline.check().map_err(|_| invalid())?;
        control("formatter_host_spawn").map_err(|_| invalid())?;
        Ok((command.spawn()?, pump))
    })();
    let (host, pump) = match spawn {
        Ok(v) => v,
        Err(e) => {
            return FormatterOutcome::Refused {
                fence,
                reason: e.to_string(),
            }
        }
    };
    let mut custody = RetainedFormatter {
        host: Some(host),
        fence: Some(fence),
        launch: Some(launch),
        pump: Some(pump),
        observer: None,
        go: false,
        refused: false,
        ready_line: Vec::new(),
        stdout: Vec::new(),
        stderr: Vec::new(),
        node: runtime.node.path.clone(),
        cwd: execution.cwd,
        argv_hash,
        env_hash,
    };
    let descriptors = custody.host.as_ref().and_then(|h| {
        Some((
            h.stdout.as_ref()?.as_raw_fd(),
            h.stderr.as_ref()?.as_raw_fd(),
        ))
    });
    match descriptors {
        Some((out, err)) => {
            if let Err(e) =
                platform::set_nonblocking(out).and_then(|_| platform::set_nonblocking(err))
            {
                custody.refused = true;
                return FormatterOutcome::Retained {
                    custody,
                    reason: e.to_string(),
                };
            }
        }
        None => {
            custody.refused = true;
            return FormatterOutcome::Retained {
                custody,
                reason: "formatter host streams missing".into(),
            };
        }
    }
    loop {
        match custody.poll(deadline, control) {
            Ok(Some((status, gate_may_have_opened, refused, stdout, stderr, fence))) => {
                return FormatterOutcome::Settled {
                    fence,
                    status,
                    gate_may_have_opened,
                    refused,
                    stdout,
                    stderr,
                }
            }
            Ok(None) => {}
            Err(e) => {
                return FormatterOutcome::Retained {
                    custody,
                    reason: e.to_string(),
                }
            }
        }
        if deadline.check().is_err() {
            custody.refused = true;
            return FormatterOutcome::Retained {
                custody,
                reason: "formatter deadline expired; supervisor retained".into(),
            };
        }
        if control("formatter_wait").is_err() {
            custody.refused = true;
            return FormatterOutcome::Retained {
                custody,
                reason: "formatter control lost; supervisor retained".into(),
            };
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn run_formatter(
    _: &FormatterRuntime<'_>,
    _: &FormatterRequest<'_>,
    fence: ExecutionFence,
    _: &MonotonicDeadline,
    _: &EffectCheck<'_>,
) -> FormatterOutcome {
    FormatterOutcome::Refused {
        fence,
        reason: "formatter custody requires macOS".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formatter_arguments_are_fixed_sorted_and_never_cli_options() {
        let root = Path::new("/project");
        let files = vec![PathBuf::from("/project/z"), PathBuf::from("/project/-a")];
        assert_eq!(
            arguments(FormatterKind::Eslint, root, &files).unwrap(),
            vec!["--fix", "--", "./-a", "./z"]
        );
        assert_eq!(
            arguments(FormatterKind::Prettier, root, &files).unwrap(),
            vec![
                "--write",
                "--no-error-on-unmatched-pattern",
                "--",
                "./-a",
                "./z"
            ]
        );
        assert!(arguments(FormatterKind::Eslint, root, &[PathBuf::from("/outside")]).is_err());
        assert!(arguments(
            FormatterKind::Eslint,
            root,
            &[files[0].clone(), files[0].clone()]
        )
        .is_err());
        assert!(arguments(FormatterKind::Eslint, root, &[]).is_err());
    }
    #[test]
    fn formatter_ready_requires_exact_tuple_and_closed_schema() {
        let make = |value: Value| format!("CAWS_FORMATTER_READY_V1 {value}").into_bytes();
        let value = json!({"schema":"caws.execution.formatter-ready.v1","launchId":"id","pid":321,"node":"/node","cwd":"/root","argvSha256":"argv","environmentSha256":"env"});
        assert_eq!(
            ready(&make(value.clone()), "id", "/node", "/root", "argv", "env").unwrap(),
            321
        );
        for (field, bad) in [
            ("schema", json!("wrong")),
            ("launchId", json!("wrong")),
            ("pid", json!(1)),
            ("node", json!("/wrong")),
            ("cwd", json!("/wrong")),
            ("argvSha256", json!("wrong")),
            ("environmentSha256", json!("wrong")),
            ("extra", json!(true)),
        ] {
            let mut modified = value.clone();
            modified[field] = bad;
            assert!(
                ready(&make(modified), "id", "/node", "/root", "argv", "env").is_err(),
                "{field}"
            );
        }
        assert!(ready(b"fake", "id", "/node", "/root", "argv", "env").is_err());
    }
    #[test]
    fn formatter_environment_is_positive_and_excludes_startup_influences() {
        let homes = RuntimeHomes {
            home: "/home/u".into(),
            caws_home: "/home/u/.caws".into(),
            codex_home: "/home/u/.codex".into(),
        };
        let env = environment(
            "/opt/node",
            "/project",
            "/private/tmp",
            &homes,
            "thread",
            "codex",
        )
        .unwrap();
        assert_eq!(
            env.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "CAWS_AGENT_SURFACE",
                "CAWS_HOME",
                "CAWS_PROJECT_DIR",
                "CODEX_HOME",
                "CODEX_SANDBOX",
                "CODEX_SANDBOX_NETWORK_DISABLED",
                "CODEX_THREAD_ID",
                "HOME",
                "LC_ALL",
                "PATH",
                "PWD",
                "TMPDIR"
            ]
        );
        assert_eq!(env["PATH"], "/opt/node:/usr/bin:/bin");
        for forbidden in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "NODE_REPL_EXTERNAL_MODULE",
            "DYLD_INSERT_LIBRARIES",
        ] {
            assert!(!env.contains_key(forbidden));
        }
        assert!(environment(
            "/node:/attacker",
            "/project",
            "/tmp",
            &homes,
            "thread",
            "codex"
        )
        .is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn formatter_bad_ready_permanently_closes_gate_while_custody_is_retained() {
        use std::os::unix::fs::PermissionsExt;
        let base = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("caws-formatter-bad-ready-{}", std::process::id()));
        fs::create_dir(&base).unwrap();
        let scratch = base.join("scratch");
        let project = base.join("project");
        let authority = base.join("authority");
        for path in [&scratch, &project, &authority] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let launch = PrivateLaunch::create(&scratch, &project, "s", "t", "c", "{}").unwrap();
        let fence = ExecutionFence::acquire(&authority).unwrap();
        let host = Command::new("/bin/sh").arg("-c").arg("printf 'bad-ready\\n'; read value; printf 'CAWS_FORMATTER_READY_V1 {}\\n'; read value")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        platform::set_nonblocking(host.stdout.as_ref().unwrap().as_raw_fd()).unwrap();
        platform::set_nonblocking(host.stderr.as_ref().unwrap().as_raw_fd()).unwrap();
        let gate = launch.invocation_root.join("formatter-go.json");
        let mut custody = RetainedFormatter {
            host: Some(host),
            fence: Some(fence),
            launch: Some(launch),
            pump: None,
            observer: None,
            go: false,
            refused: false,
            ready_line: Vec::new(),
            stdout: Vec::new(),
            stderr: Vec::new(),
            node: "/node".into(),
            cwd: project.to_str().unwrap().into(),
            argv_hash: "argv".into(),
            env_hash: "env".into(),
        };
        let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
        let allow = |_: &'static str| Ok(());
        let mut rejected = false;
        for _ in 0..200 {
            match custody.poll(&deadline, &allow) {
                Err(_) => {
                    rejected = true;
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Ok(Some(_)) => panic!("host exited before rejection"),
            }
        }
        assert!(rejected);
        assert!(custody.refused);
        assert!(!gate.exists());
        custody
            .host
            .as_mut()
            .unwrap()
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"continue\n")
            .unwrap();
        for _ in 0..20 {
            assert!(custody.poll(&deadline, &allow).unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!gate.exists());
        custody.host.as_mut().unwrap().kill().unwrap();
        let mut returned = None;
        for _ in 0..200 {
            if let Some(done) = custody.poll(&deadline, &allow).unwrap() {
                returned = Some(done);
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let (_, opened, refused, _, _, mut fence) = returned.expect("host did not settle");
        assert!(!opened);
        assert!(refused);
        fence.try_release().unwrap();
        drop(custody);
        fs::remove_dir_all(base).unwrap();
    }
}
