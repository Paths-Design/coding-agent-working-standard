//! Private per-invocation engine custody. This is transport and original-child
//! ownership, never project authority or permission to adopt a process by PID.
use crate::cli::Config;
use caws_native::owned_group::{GroupSettlement, GroupStop, SettlementError, StopError};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::UnixStream,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::PathBuf,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
mod tests;
pub(crate) mod worker;
pub(super) const CONFIG_SCHEMA: &str = "caws.engine.custody.configuration.v1";
pub(super) const RECEIPT_SCHEMA: &str = "caws.engine.custody.receipt.v1";
pub(super) const MAX_CONFIG: u64 = 65_536;
pub(super) const MAX_JOURNAL: u64 = 1_048_576;
pub(super) const CLEANUP_ATTEMPT: Duration = Duration::from_millis(500);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Configuration {
    pub schema: String,
    pub invocation_id: String,
    pub runtime_digest: String,
    pub node: PathBuf,
    pub engine: PathBuf,
    pub control_fd: RawFd,
    pub receipt_fd: RawFd,
    pub render_fds: Option<[RawFd; 3]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ReceiptState {
    Started,
    Pending,
    Complete,
    NoChild,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub schema: String,
    pub invocation_id: String,
    pub runtime_digest: String,
    pub sequence: u64,
    pub custodian_pid: u32,
    pub node_pid: Option<u32>,
    pub state: ReceiptState,
    pub reason: Option<String>,
    pub stop: Option<Result<GroupStop, StopError>>,
    pub settlement: Option<Result<GroupSettlement, SettlementError>>,
    pub child_exit_raw: Option<i32>,
    pub stdout_eof: bool,
    pub stderr_eof: bool,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub output_discarded: bool,
    pub error: Option<String>,
}
impl Receipt {
    pub(super) fn terminal(&self) -> bool {
        match self.state {
            ReceiptState::NoChild => {
                self.node_pid.is_none()
                    && self.child_exit_raw.is_none()
                    && self.stop.is_none()
                    && self.settlement.is_none()
                    && self.stdout_eof
                    && self.stderr_eof
                    && self.stdout_bytes == 0
                    && self.stderr_bytes == 0
            }
            ReceiptState::Complete => {
                self.node_pid.is_some_and(|pid| pid > 1)
                    && self.child_exit_raw.is_some()
                    && matches!(self.stop, Some(Ok(_)))
                    && matches!(self.settlement, Some(Ok(GroupSettlement::Exited { observation }))
                        if observation.reason == 0 && observation.query_errno == 0
                            && observation.members > 0 && observation.members == observation.zombies
                            && observation.leaders == 1 && observation.bytes > 0
                            && observation.bytes < observation.capacity)
                    && self.stdout_eof
                    && self.stderr_eof
                    && self.error.is_none()
            }
            _ => false,
        }
    }
}

fn high(fd: RawFd) -> io::Result<OwnedFd> {
    // Retained sources, rather than arbitrary fixed targets, prevent collision
    // with std::process::Command's private exec-error pipe during pre_exec.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 32) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}
pub(super) fn close_on_exec(fd: RawFd) -> io::Result<()> {
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
pub(super) fn nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn metadata(fd: RawFd, rights: i32, socket: bool) -> Result<fs::Metadata, String> {
    if !(32..=1_048_576).contains(&fd) {
        return Err("invalid custody descriptor number".into());
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || flags & libc::O_ACCMODE != rights {
        return Err("invalid custody descriptor rights".into());
    }
    let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
    let copy = borrowed.try_clone_to_owned().map_err(|e| e.to_string())?;
    let meta = File::from(copy).metadata().map_err(|e| e.to_string())?;
    if (socket && !meta.file_type().is_socket()) || (!socket && !meta.is_file()) {
        return Err("invalid custody descriptor type".into());
    }
    if !socket && (meta.uid() != unsafe { libc::geteuid() } || meta.nlink() != 1) {
        return Err("invalid custody file ownership".into());
    }
    Ok(meta)
}

pub(super) struct WorkerInput {
    pub configuration: Configuration,
    pub control: UnixStream,
    pub receipt: File,
    pub render: Option<[OwnedFd; 3]>,
}
pub(super) fn worker_input(config_fd: RawFd) -> Result<WorkerInput, String> {
    let before = metadata(config_fd, libc::O_RDONLY, false)?;
    if before.mode() & 0o7777 != 0o400 || before.len() > MAX_CONFIG {
        return Err("unsafe custody configuration".into());
    }
    close_on_exec(config_fd).map_err(|e| e.to_string())?;
    let mut file = unsafe { File::from_raw_fd(config_fd) };
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    if (
        before.dev(),
        before.ino(),
        before.len(),
        before.mtime(),
        before.mtime_nsec(),
        before.ctime(),
        before.ctime_nsec(),
    ) != (
        after.dev(),
        after.ino(),
        after.len(),
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    ) || bytes.len() as u64 != before.len()
    {
        return Err("custody configuration changed".into());
    }
    let configuration: Configuration = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if configuration.schema != CONFIG_SCHEMA
        || configuration.invocation_id.is_empty()
        || configuration.invocation_id.len() > 128
        || !configuration
            .invocation_id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"-_.".contains(&v))
        || !crate::cli::valid_digest(&configuration.runtime_digest)
        || !configuration.node.is_absolute()
        || !configuration.engine.is_absolute()
    {
        return Err("invalid custody configuration fields".into());
    }
    let mut descriptors = vec![
        config_fd,
        configuration.control_fd,
        configuration.receipt_fd,
    ];
    if let Some(render) = configuration.render_fds {
        descriptors.extend(render);
    }
    if descriptors.iter().copied().collect::<BTreeSet<_>>().len() != descriptors.len() {
        return Err("aliased custody descriptor slots".into());
    }
    metadata(configuration.control_fd, libc::O_RDWR, true)?;
    let receipt_meta = metadata(configuration.receipt_fd, libc::O_WRONLY, false)?;
    if receipt_meta.mode() & 0o7777 != 0o600
        || receipt_meta.len() != 0
        || unsafe { libc::fcntl(configuration.receipt_fd, libc::F_GETFL) } & libc::O_APPEND == 0
        || (receipt_meta.dev(), receipt_meta.ino()) == (before.dev(), before.ino())
    {
        return Err("unsafe custody receipt file".into());
    }
    if let Some([transport, grant, receipt]) = configuration.render_fds {
        metadata(transport, libc::O_RDWR, true)?;
        let grant_meta = metadata(grant, libc::O_RDONLY, false)?;
        let render_receipt = metadata(receipt, libc::O_WRONLY, false)?;
        if grant_meta.mode() & 0o7777 != 0o400 || render_receipt.mode() & 0o7777 != 0o600 {
            return Err("unsafe engine render descriptor rights".into());
        }
        let files = [&before, &receipt_meta, &grant_meta, &render_receipt];
        if files
            .iter()
            .map(|file| (file.dev(), file.ino()))
            .collect::<BTreeSet<_>>()
            .len()
            != files.len()
        {
            return Err("aliased custody descriptors".into());
        }
    }
    for &fd in &descriptors {
        close_on_exec(fd).map_err(|e| e.to_string())?;
    }
    let control = unsafe { UnixStream::from_raw_fd(configuration.control_fd) };
    let receipt = unsafe { File::from_raw_fd(configuration.receipt_fd) };
    let render = configuration
        .render_fds
        .map(|fds| fds.map(|fd| unsafe { OwnedFd::from_raw_fd(fd) }));
    Ok(WorkerInput {
        configuration,
        control,
        receipt,
        render,
    })
}

fn remove_preloads(command: &mut Command) {
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    for (name, _) in std::env::vars_os() {
        if name
            .to_str()
            .is_some_and(|v| v.starts_with("LD_") || v.starts_with("DYLD_"))
        {
            command.env_remove(name);
        }
    }
}
static SERIAL: AtomicU64 = AtomicU64::new(0);
pub(crate) struct Spawned {
    pub owner: Owner,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}
pub(crate) struct Owner {
    child: Option<Child>,
    custodian_pid: u32,
    custodian_exit: Option<ExitStatus>,
    control: Option<UnixStream>,
    receipt: File,
    root: PathBuf,
    invocation_id: String,
    runtime_digest: String,
    latest: Option<Receipt>,
    observed_length: u64,
    observed_prefix: Vec<u8>,
}
impl Owner {
    pub fn spawn(
        config: &Config,
        invocation_id: &str,
        render: Option<[RawFd; 3]>,
    ) -> Result<Spawned, String> {
        let parent = std::env::temp_dir()
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let root = parent.join(format!(
            "caws-engine-invocation-{}-{nonce}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|e| e.to_string())?;
        let configuration_path = root.join("configuration.json");
        let receipt_path = root.join("cleanup.jsonl");
        let (control, remote) = UnixStream::pair().map_err(|e| e.to_string())?;
        control.set_nonblocking(true).map_err(|e| e.to_string())?;
        let remote = high(remote.as_raw_fd()).map_err(|e| e.to_string())?;
        let writer = OpenOptions::new()
            .append(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&receipt_path)
            .map_err(|e| e.to_string())?;
        let receipt_writer = high(writer.as_raw_fd()).map_err(|e| e.to_string())?;
        let receipt = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&receipt_path)
            .map_err(|e| e.to_string())?;
        let render = render
            .map(|fds| fds.map(high))
            .map(|fds| {
                let [a, b, c] = fds;
                Ok::<_, io::Error>([a?, b?, c?])
            })
            .transpose()
            .map_err(|e| e.to_string())?;
        let configuration = Configuration {
            schema: CONFIG_SCHEMA.into(),
            invocation_id: invocation_id.into(),
            runtime_digest: config.digest.clone(),
            node: config.node.clone(),
            engine: config.engine.clone(),
            control_fd: remote.as_raw_fd(),
            receipt_fd: receipt_writer.as_raw_fd(),
            render_fds: render
                .as_ref()
                .map(|fds| fds.each_ref().map(|fd| fd.as_raw_fd())),
        };
        let bytes = serde_json::to_vec(&configuration).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_CONFIG {
            return Err("custody configuration exceeds byte limit".into());
        }
        let mut config_writer = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&configuration_path)
            .map_err(|e| e.to_string())?;
        config_writer
            .write_all(&bytes)
            .and_then(|()| config_writer.sync_all())
            .map_err(|e| e.to_string())?;
        config_writer
            .set_permissions(fs::Permissions::from_mode(0o400))
            .map_err(|e| e.to_string())?;
        drop(config_writer);
        let config_reader = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&configuration_path)
            .map_err(|e| e.to_string())?;
        let config_reader = high(config_reader.as_raw_fd()).map_err(|e| e.to_string())?;
        let mut sources = vec![
            remote.as_raw_fd(),
            receipt_writer.as_raw_fd(),
            config_reader.as_raw_fd(),
        ];
        if let Some(render) = &render {
            sources.extend(render.iter().map(AsRawFd::as_raw_fd));
        }
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("engine-custodian")
            .arg(config_reader.as_raw_fd().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        remove_preloads(&mut command);
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                for &fd in &sources {
                    if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let child = command
            .spawn()
            .map_err(|e| format!("engine custodian spawn: {e}; retained {}", root.display()))?;
        let custodian_pid = child.id();
        let mut owner = Self {
            child: Some(child),
            custodian_pid,
            custodian_exit: None,
            control: Some(control),
            receipt,
            root,
            invocation_id: invocation_id.into(),
            runtime_digest: config.digest.clone(),
            latest: None,
            observed_length: 0,
            observed_prefix: Vec::new(),
        };
        // Once spawned, every error drops Owner, closing liveness and requesting
        // owned cleanup; it never sends a signal to the custodian.
        let child = owner.child.as_mut().expect("created custodian");
        let stdin = child.stdin.take().ok_or("missing custodian stdin")?;
        let stdout = child.stdout.take().ok_or("missing custodian stdout")?;
        let stderr = child.stderr.take().ok_or("missing custodian stderr")?;
        Ok(Spawned {
            owner,
            stdin,
            stdout,
            stderr,
        })
    }

    fn refresh(&mut self) -> Result<(), String> {
        use std::os::unix::fs::FileExt;
        let length = self.receipt.metadata().map_err(|e| e.to_string())?.len();
        if length > MAX_JOURNAL {
            return Err("custody journal exceeds byte limit".into());
        }
        if length < self.observed_length {
            return Err("custody journal was truncated".into());
        }
        let mut bytes = vec![0; length as usize];
        self.receipt
            .read_exact_at(&mut bytes, 0)
            .map_err(|e| e.to_string())?;
        if !bytes.starts_with(&self.observed_prefix) {
            return Err("custody journal prefix changed".into());
        }
        let mut latest = None;
        for line in bytes.split_inclusive(|&b| b == b'\n') {
            if !line.ends_with(b"\n") {
                break;
            }
            let receipt: Receipt = serde_json::from_slice(line)
                .map_err(|e| format!("invalid custody journal: {e}"))?;
            if receipt.schema != RECEIPT_SCHEMA
                || receipt.invocation_id != self.invocation_id
                || receipt.runtime_digest != self.runtime_digest
                || receipt.custodian_pid != self.custodian_pid
                || receipt.sequence == 0
                || latest
                    .as_ref()
                    .is_some_and(|old: &Receipt| receipt.sequence <= old.sequence)
            {
                return Err("custody journal correlation differs".into());
            }
            if matches!(
                receipt.state,
                ReceiptState::Complete | ReceiptState::NoChild
            ) && !receipt.terminal()
            {
                return Err("invalid terminal custody receipt".into());
            }
            if let Some(old) = &latest
                && (old.terminal()
                    || (old.node_pid.is_some() && old.node_pid != receipt.node_pid)
                    || receipt.stdout_bytes < old.stdout_bytes
                    || receipt.stderr_bytes < old.stderr_bytes
                    || (old.stdout_eof && !receipt.stdout_eof)
                    || (old.stderr_eof && !receipt.stderr_eof)
                    || (old.output_discarded && !receipt.output_discarded)
                    || (old.child_exit_raw.is_some()
                        && old.child_exit_raw != receipt.child_exit_raw))
            {
                return Err("custody journal state regressed".into());
            }
            latest = Some(receipt);
        }
        self.observed_length = length;
        self.observed_prefix = bytes;
        if let Some(receipt) = latest {
            self.latest = Some(receipt);
        }
        Ok(())
    }
    pub fn exit_observed(&mut self) -> Result<bool, String> {
        self.refresh()?;
        if self.latest.as_ref().is_some_and(Receipt::terminal) {
            return Ok(true);
        }
        let Some(child) = &self.child else {
            return Err("custodian exited without terminal receipt".into());
        };
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                child.id(),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().to_string());
        }
        if unsafe { info.assume_init().si_pid() } != 0 {
            return Err(format!(
                "custodian exited without confirmed engine cleanup; retained {}",
                self.root.display()
            ));
        }
        Ok(false)
    }
    fn join_terminal(&mut self, deadline: Instant) -> Result<(), String> {
        loop {
            self.refresh()?;
            if self.latest.as_ref().is_some_and(Receipt::terminal) {
                if let Some(child) = &mut self.child {
                    match child.try_wait().map_err(|e| e.to_string())? {
                        Some(status) => {
                            self.custodian_exit = Some(status);
                            self.child.take();
                        }
                        None if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(2));
                            continue;
                        }
                        None => {
                            return Err(format!(
                                "engine settled; custodian exit pending at {}",
                                self.root.display()
                            ));
                        }
                    }
                }
                let status = self
                    .custodian_exit
                    .ok_or("missing original custodian exit status")?;
                if !status.success() {
                    return Err(format!(
                        "custodian exited abnormally ({status}); cleanup publication unconfirmed at {}",
                        self.root.display()
                    ));
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "engine cleanup pending; custodian retains Child at {}",
                    self.root.display()
                ));
            }
            self.exit_observed()?;
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn finish(&mut self, deadline: Instant) -> Result<ExitStatus, String> {
        self.join_terminal(deadline)?;
        let receipt = self.latest.as_ref().expect("terminal receipt");
        receipt
            .child_exit_raw
            .map(ExitStatus::from_raw)
            .ok_or_else(|| {
                format!(
                    "engine not spawned: {:?}; receipt {}",
                    receipt.error,
                    self.root.display()
                )
            })
    }
    pub fn cleanup(&mut self) -> Result<(), String> {
        if let Some(control) = &mut self.control {
            match control.write(b"S") {
                Ok(1) => (),
                Ok(_) => return Err("custodian stop channel accepted no byte".into()),
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => (),
                Err(e) => return Err(format!("custodian stop request: {e}")),
            }
        }
        self.join_terminal(Instant::now() + CLEANUP_ATTEMPT)
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if let Some(mut control) = self.control.take() {
            let _ = control.write(b"S");
        }
        // Closing this sole frontend endpoint triggers cleanup even after an
        // interrupted stop write. Keep the original custodian Child in a passive
        // join while this process lives; never kill it to make cleanup look done.
        if let Some(mut child) = self.child.take()
            && let Err(error) = std::thread::Builder::new()
                .name("caws-custodian-reap".into())
                .spawn(move || {
                    let _ = child.wait();
                })
        {
            eprintln!(
                "custodian passive reap thread unavailable: {error}; retained {}",
                self.root.display()
            );
        }
        // Diagnostic receipts are retained, including after frontend death.
        // They are operational evidence, never authority or replay permission.
    }
}
