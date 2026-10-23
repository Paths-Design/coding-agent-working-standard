//! Cooperative, cross-generation renderer exclusion. This cannot fence an
//! unmodified foreign renderer which never acquires it. Adopting all launch
//! paths and draining prior writers remains a separate migration prerequisite.
use crate::{
    owned_group,
    service_journal::{
        Admission, Custody, Dispatch, Identity, Journal, MAX_RETAINED_RECORDS, NotStartedStage,
        ReturnedResult,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn canonical(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || fs::canonicalize(path).map_err(|e| e.to_string())? != path {
        return Err("renderer custody requires a canonical absolute existing directory".into());
    }
    if !fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("renderer custody requires a directory".into());
    }
    Ok(())
}
fn private(path: &Path) -> Result<(), String> {
    canonical(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o7777 != 0o700 {
        return Err("renderer custody directory must be private and owned".into());
    }
    Ok(())
}
fn mkdir(path: &Path) -> Result<bool, String> {
    use std::os::unix::fs::DirBuilderExt;
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {
            private(path)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            private(path)?;
            Ok(false)
        }
        Err(error) => Err(error.to_string()),
    }
}
pub fn project_key(project: &Path) -> Result<String, String> {
    canonical(project)?;
    let text = project.to_str().ok_or("renderer project is not UTF-8")?;
    let bytes =
        serde_json::to_vec(&("caws-render-writer-project-v1", text)).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provisioned {
    schema: String,
    canonical_project: String,
    leaf_device: u64,
    leaf_inode: u64,
}
fn registration(file: &File, named: &Path, project: &Path, directory: &Path) -> Result<(), String> {
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.nlink() != 1
        || before.mode() & 0o7777 != 0o600
        || before.len() > 1024
    {
        return Err("invalid renderer writer provisioning registration".into());
    }
    let mut bytes = Vec::new();
    file.take(1025)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let row: Provisioned = serde_json::from_slice(&bytes)
        .map_err(|_| "partial or invalid renderer writer provisioning")?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    let current = fs::symlink_metadata(named).map_err(|e| e.to_string())?;
    let stamp = |m: &fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    private(directory)?;
    let leaf = fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
    if stamp(&before) != stamp(&after)
        || stamp(&before) != stamp(&current)
        || row.schema != "caws.render.writer.provisioned.v1"
        || Some(row.canonical_project.as_str()) != project.to_str()
        || row.leaf_device != leaf.dev()
        || row.leaf_inode != leaf.ino()
    {
        return Err("renderer writer provisioning anchor changed".into());
    }
    Ok(())
}
/// The canonical output project's anchor survives machine-home and generation
/// changes. Session never alters this project-wide lock, matching the current
/// backend's project serialization. Home is only a private receipt destination.
pub fn acquire(home: &Path, project: &Path, expires: Instant) -> Result<Arc<Custody>, String> {
    private(home)?;
    let key = project_key(project)?;
    let governance = project.join(".caws");
    canonical(&governance)?;
    let stat = fs::symlink_metadata(&governance).map_err(|e| e.to_string())?;
    if stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o022 != 0 {
        return Err("canonical governance root must be owned and not group/world writable".into());
    }
    let directory = governance.join(".render-writer-custody");
    let marker = governance.join(".render-writer-provisioned");
    let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    let (mut provisioned, created) = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(flags)
        .open(&marker)
    {
        Ok(file) => (file, true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (
            OpenOptions::new()
                .read(true)
                .custom_flags(flags)
                .open(&marker)
                .map_err(|e| e.to_string())?,
            false,
        ),
        Err(error) => return Err(error.to_string()),
    };
    let custody = if created {
        // Persist the no-reset tombstone BEFORE creating custody. A crash at
        // any intermediate step leaves partial provisioning, never permission
        // to initialize a new owner domain over an old writer's state.
        provisioned.sync_all().map_err(|e| e.to_string())?;
        File::open(&governance)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        if !mkdir(&directory)? {
            return Err("unregistered renderer custody already exists".into());
        }
        File::open(&governance)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        let custody = Custody::initialize(&directory, expires).map_err(|e| e.to_string())?;
        let leaf = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        serde_json::to_writer(
            &mut provisioned,
            &Provisioned {
                schema: "caws.render.writer.provisioned.v1".into(),
                canonical_project: project.to_str().ok_or("non-UTF8 canonical project")?.into(),
                leaf_device: leaf.dev(),
                leaf_inode: leaf.ino(),
            },
        )
        .map_err(|e| e.to_string())?;
        provisioned.sync_all().map_err(|e| e.to_string())?;
        File::open(&governance)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        custody
    } else {
        registration(&provisioned, &marker, project, &directory)?;
        Custody::acquire(&directory, expires).map_err(|e| e.to_string())?
    };
    provisioned.rewind().map_err(|e| e.to_string())?;
    registration(&provisioned, &marker, project, &directory)?;
    let journal = Journal::open(Arc::clone(&custody), &key, MAX_RETAINED_RECORDS, expires)
        .map_err(|e| e.to_string())?;
    if journal.has_unknown(expires).map_err(|e| e.to_string())?
        || !journal
            .queued_request_ids(expires)
            .map_err(|e| e.to_string())?
            .is_empty()
    {
        return Err(
            "renderer writer domain retains an unresolved execution; no replay or fallback".into(),
        );
    }
    drop(journal);
    Ok(custody)
}

/// A persistent dispatch intent. Dropping it does not settle the operation: a
/// later process recovers it as unknown and refuses all cooperative writers.
pub struct WriterIntent {
    journal: Journal,
    dispatch: Dispatch,
}
pub fn begin(
    custody: Arc<Custody>,
    project: &Path,
    generation: &str,
    verified_request: &[u8],
    expires: Instant,
) -> Result<WriterIntent, String> {
    let key = project_key(project)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let request_id = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                "caws-render-writer-intent-v1",
                &key,
                std::process::id(),
                nonce,
                verified_request
            ))
            .map_err(|e| e.to_string())?
        )
    );
    let argument_digest = format!("{:x}", Sha256::digest(verified_request));
    let mut journal =
        Journal::open(custody, &key, MAX_RETAINED_RECORDS, expires).map_err(|e| e.to_string())?;
    match journal
        .admit(
            Identity {
                request_id,
                argument_digest,
                project_service_key: key,
                source_generation: generation.into(),
                execution_image_digest: generation.into(),
            },
            verified_request,
            expires,
        )
        .map_err(|e| e.to_string())?
    {
        Admission::Accepted {
            duplicate: false, ..
        } => {}
        _ => return Err("writer intent was not newly admitted; no effect".into()),
    }
    let dispatch = journal
        .begin_next(generation, generation, expires)
        .map_err(|e| e.to_string())?
        .ok_or("writer intent dispatch unavailable")?;
    Ok(WriterIntent { journal, dispatch })
}
/// Caller must independently establish both a returned result and definitive
/// cleanup. Timeout, delivery loss and a live-but-unresponsive writer are not
/// permission to settle. This API has no reset or unknown-to-returned path.
pub fn settle(
    mut intent: WriterIntent,
    result: ReturnedResult,
    expires: Instant,
) -> Result<(), String> {
    let returned = intent
        .journal
        .returned(&intent.dispatch, result, None, expires)
        .map_err(|e| e.to_string())?;
    let digest = returned.consumption_digest().map_err(|e| e.to_string())?;
    intent
        .journal
        .consume(&returned, &digest, expires)
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn not_started(
    intent: WriterIntent,
    stage: NotStartedStage,
    errno: Option<i32>,
    expires: Instant,
) -> Result<(), String> {
    settle(intent, ReturnedResult::NotStarted { stage, errno }, expires)
}

struct Config {
    home: PathBuf,
    project: PathBuf,
    output: PathBuf,
    session: String,
    generation: String,
    timeout: Duration,
    program: PathBuf,
    arguments: Vec<String>,
}
fn parse(args: &[String]) -> Result<Config, String> {
    let separator = args
        .iter()
        .position(|a| a == "--")
        .ok_or("render-writer requires an argv separator")?;
    if separator != 12 || args.len() <= separator + 1 {
        return Err("render-writer requires six explicit options and an absolute program".into());
    }
    let expected = [
        "--home",
        "--canonical-project",
        "--output-directory",
        "--session-id",
        "--source-generation",
        "--timeout-ms",
    ];
    // Six option pairs precede --. Reject duplicate, reordered and unknown flags.
    if separator != expected.len() * 2 {
        return Err("invalid render-writer options".into());
    }
    for (index, flag) in expected.iter().enumerate() {
        if args[index * 2] != *flag {
            return Err("invalid render-writer option".into());
        }
    }
    let timeout: u64 = args[11]
        .parse()
        .map_err(|_| "invalid render-writer timeout")?;
    if !(1..=120000).contains(&timeout) {
        return Err("render-writer timeout out of range".into());
    }
    let mut config = Config {
        home: args[1].clone().into(),
        project: args[3].clone().into(),
        output: args[5].clone().into(),
        session: args[7].clone(),
        generation: args[9].clone(),
        timeout: Duration::from_millis(timeout),
        program: args[separator + 1].clone().into(),
        arguments: args[separator + 2..].to_vec(),
    };
    canonical(&config.project)?;
    private(&config.home)?;
    if config.session.is_empty()
        || config.session.len() > 128
        || !config
            .session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:@".contains(&b))
        || config.session == "."
        || config.session == ".."
        || config.output != config.project.join(".caws/sessions").join(&config.session)
        || config.generation.len() != 64
        || !config
            .generation
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !config.program.is_absolute()
    {
        return Err("invalid render-writer identity or output".into());
    }
    canonical(&config.output)?;
    config.program = fs::canonicalize(&config.program).map_err(|e| e.to_string())?;
    let executable = fs::metadata(&config.program).map_err(|e| e.to_string())?;
    if !executable.is_file() || executable.mode() & 0o111 == 0 {
        return Err("render-writer program must be a regular executable file".into());
    }
    Ok(config)
}
fn nonblocking(fd: i32) -> Result<(), String> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err(io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}
fn drain(input: &mut impl Read, sink: &mut impl Write, eof: &mut bool) -> Result<(), String> {
    let mut bytes = [0u8; 8192];
    // Yield to deadline/exit observation even under continuously full pipes.
    // Sink writes can block; custody remains held across that delivery.
    for _ in 0..16 {
        match input.read(&mut bytes) {
            Ok(0) => {
                *eof = true;
                return Ok(());
            }
            Ok(count) => sink.write_all(&bytes[..count]).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
struct Owned {
    child: Option<Child>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    out_eof: bool,
    err_eof: bool,
    _custody: Arc<Custody>,
    _child_fence: OwnedFd,
}
impl Owned {
    fn drain(&mut self) -> Result<(), String> {
        drain(&mut self.stdout, &mut io::stdout(), &mut self.out_eof)?;
        drain(&mut self.stderr, &mut io::stderr(), &mut self.err_eof)
    }
    fn exited(&self) -> Result<bool, String> {
        let pid = self.child.as_ref().ok_or("writer child released")?.id();
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(unsafe { info.assume_init().si_pid() } == pid as libc::pid_t)
    }
    fn stop_reap(&mut self) -> Result<std::process::ExitStatus, String> {
        owned_group::stop_before_reap(self.child.as_ref().ok_or("writer child released")?)
            .map_err(|e| format!("writer cleanup ownership unavailable: {e:?}"))?;
        let status = self
            .child
            .as_mut()
            .expect("retained child")
            .wait()
            .map_err(|e| e.to_string())?;
        self.child = None;
        while !self.out_eof || !self.err_eof {
            self.drain()?;
            thread::sleep(Duration::from_millis(2));
        }
        Ok(status)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // A cleanup uncertainty quarantines this process while custody stays
        // held. Deadline expiry never authorizes another writer to start.
        while self.child.is_some() || !self.out_eof || !self.err_eof {
            if self.child.is_some() && self.stop_reap().is_ok() {
                break;
            }
            let _ = self.drain();
            thread::sleep(Duration::from_millis(10));
        }
    }
}
fn receipt(config: &Config, value: serde_json::Value) -> Result<(), String> {
    mkdir(&config.home.join("state"))?;
    let parent = config.home.join("state/render-writer-receipts");
    mkdir(&parent)?;
    let directory = parent.join(project_key(&config.project)?);
    mkdir(&directory)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let file = directory.join(format!("{}-{nonce}.json", std::process::id()));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(file)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut output, &value).map_err(|e| e.to_string())?;
    output
        .write_all(b"\n")
        .and_then(|()| output.sync_all())
        .map_err(|e| e.to_string())?;
    File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
/// Operator command only; generation is provenance, never authority. Returns 75
/// whenever custody or execution is unavailable. No retry is initiated here.
pub fn run(args: &[String]) -> Result<u8, String> {
    let config = parse(args)?;
    let expires = Instant::now() + config.timeout;
    let custody = acquire(&config.home, &config.project, expires)?;
    // A directly created child inherits the actual open-file-description flock,
    // so wrapper death cannot unlock a still-running cooperative writer. The
    // parent retains its duplicate until owned cleanup and both output EOFs.
    let child_fence = custody
        .duplicate_lifetime(expires)
        .map_err(|e| e.to_string())?;
    let fence_fd = child_fence.as_raw_fd();
    let verified_request = serde_json::to_vec(&json!({"kind":"cooperative-one-shot",
        "canonicalProject":config.project,"outputDirectory":config.output,"sessionId":config.session,
        "program":config.program,"arguments":config.arguments})).map_err(|e| e.to_string())?;
    let intent = begin(
        Arc::clone(&custody),
        &config.project,
        &config.generation,
        &verified_request,
        expires,
    )?;
    let mut command = Command::new(&config.program);
    command
        .args(&config.arguments)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) == 0 && libc::fcntl(fence_fd, libc::F_SETFD, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = error.to_string();
            not_started(
                intent,
                NotStartedStage::Spawn,
                error.raw_os_error(),
                Instant::now() + Duration::from_secs(2),
            )
            .map_err(|publication| {
                format!("{message}; known nonexecution publication unavailable: {publication}")
            })?;
            return Err(message);
        }
    };
    let mut owned = Owned {
        stdout: child.stdout.take().expect("piped stdout"),
        stderr: child.stderr.take().expect("piped stderr"),
        child: Some(child),
        out_eof: false,
        err_eof: false,
        _custody: custody,
        _child_fence: child_fence,
    };
    nonblocking(owned.stdout.as_raw_fd())?;
    nonblocking(owned.stderr.as_raw_fd())?;
    let identity = json!({"schema":"caws.render.writer.receipt.v1", "canonicalProject":config.project,
        "outputDirectory":config.output, "sessionId":config.session, "sourceGeneration":config.generation,
        "program":config.program, "ownedChildPid":owned.child.as_ref().expect("owned child").id()});
    receipt(&config, json!({"identity":identity,"state":"running"}))?;
    let timed_out = loop {
        owned.drain()?;
        if owned.exited()? {
            break false;
        }
        if Instant::now() >= expires {
            break true;
        }
        thread::sleep(Duration::from_millis(2));
    };
    receipt(
        &config,
        json!({"identity":identity,"state":"cleanup_pending","timedOut":timed_out}),
    )?;
    let status = owned.stop_reap()?;
    if !timed_out {
        use std::os::unix::process::ExitStatusExt;
        settle(
            intent,
            ReturnedResult::ProcessExit {
                code: status.code().and_then(|code| u8::try_from(code).ok()),
                signal: status.signal().and_then(|signal| u8::try_from(signal).ok()),
            },
            Instant::now() + Duration::from_secs(2),
        )?;
    }
    receipt(
        &config,
        json!({"identity":identity,"state":"reaped_and_output_eof","timedOut":timed_out,"exitCode":status.code()}),
    )?;
    Ok(if timed_out {
        75
    } else {
        status
            .code()
            .and_then(|code| u8::try_from(code).ok())
            .unwrap_or(75)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        root: PathBuf,
        home: PathBuf,
        project: PathBuf,
        output: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            Self::at(std::env::temp_dir())
        }
        fn at(parent: PathBuf) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = parent
                .canonicalize()
                .unwrap()
                .join(format!("caws-render-writer-{}-{nonce}", std::process::id()));
            fs::create_dir(&root).unwrap();
            let home = root.join("home");
            let project = root.join("project");
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            let output = project.join(".caws/sessions/session-1");
            fs::create_dir_all(&output).unwrap();
            Self {
                root,
                home,
                project,
                output,
            }
        }
        fn args(&self) -> Vec<String> {
            [
                "--home",
                self.home.to_str().unwrap(),
                "--canonical-project",
                self.project.to_str().unwrap(),
                "--output-directory",
                self.output.to_str().unwrap(),
                "--session-id",
                "session-1",
                "--source-generation",
                &"a".repeat(64),
                "--timeout-ms",
                "1000",
                "--",
                "/usr/bin/true",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn project_key_is_canonical_and_generation_independent() {
        let fixture = Fixture::new();
        let mut args = fixture.args();
        let first = parse(&args).unwrap();
        args[9] = "b".repeat(64);
        let next = parse(&args).unwrap();
        assert_ne!(first.generation, next.generation);
        assert_eq!(
            project_key(&first.project).unwrap(),
            project_key(&next.project).unwrap()
        );
        assert!(project_key(&fixture.project.join("..")).is_err());
    }
    #[test]
    fn actual_lock_refuses_peer_then_readmits_without_reset_and_isolates_projects() {
        // Opt-in retention survives assertion unwind; capabilities and probe
        // descriptors keep ordinary RAII on both the retained and default path.
        struct EvidenceFixture {
            fixture: std::mem::ManuallyDrop<Fixture>,
            retain: bool,
        }
        impl std::ops::Deref for EvidenceFixture {
            type Target = Fixture;
            fn deref(&self) -> &Fixture {
                &self.fixture
            }
        }
        impl Drop for EvidenceFixture {
            fn drop(&mut self) {
                if !self.retain {
                    unsafe { std::mem::ManuallyDrop::drop(&mut self.fixture) };
                }
            }
        }
        fn identity(file: &File) -> (u64, u64) {
            let metadata = file.metadata().unwrap();
            (metadata.dev(), metadata.ino())
        }
        fn same_identity(file: &File, expected: (u64, u64)) -> Result<(), (u64, u64)> {
            let actual = identity(file);
            if actual == expected {
                Ok(())
            } else {
                Err(actual)
            }
        }
        fn describe(metadata: &fs::Metadata) -> serde_json::Value {
            json!({
                "device": metadata.dev(), "inode": metadata.ino(),
                "mode": metadata.mode(), "uid": metadata.uid(),
                "links": metadata.nlink(), "bytes": metadata.len(),
            })
        }
        fn entries(directory: &Path) -> Vec<String> {
            let mut names: Vec<_> = fs::read_dir(directory)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        }
        fn snapshot(fixture: &Fixture, alternate_home: &Path) -> serde_json::Value {
            let anchor = fixture.project.join(".caws/.render-writer-custody");
            let service = anchor
                .join("operations/services")
                .join(project_key(&fixture.project).unwrap());
            let mut stable = serde_json::Map::new();
            for (name, path) in [
                ("custody", anchor.clone()),
                ("operations", anchor.join("operations")),
                ("services", anchor.join("operations/services")),
                ("journalDirectory", service.clone()),
                (
                    "marker",
                    fixture.project.join(".caws/.render-writer-provisioned"),
                ),
                ("registry", anchor.join(".service-root.json")),
                ("namedLock", anchor.join(".service-owner.lock")),
                ("journalConfig", service.join(".journal.json")),
                ("journalLock", service.join(".journal.lock")),
            ] {
                let metadata = fs::symlink_metadata(&path).unwrap();
                let contents = if metadata.is_dir() {
                    json!({"entries": entries(&path)})
                } else {
                    json!({"bytes": fs::read(&path).unwrap()})
                };
                stable.insert(
                    name.into(),
                    json!({"metadata": describe(&metadata), "contents": contents}),
                );
            }
            json!({
                "stable": stable,
                "homeEntries": entries(&fixture.home),
                "alternateHomeEntries": entries(alternate_home),
            })
        }
        let artifact_parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT");
        let fixture = EvidenceFixture {
            retain: artifact_parent.is_some(),
            fixture: std::mem::ManuallyDrop::new(Fixture::at(
                artifact_parent
                    .map(PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir),
            )),
        };
        let expires = || Instant::now() + Duration::from_millis(500);
        let alternate_home = fixture.root.join("alternate-home");
        fs::create_dir(&alternate_home).unwrap();
        fs::set_permissions(&alternate_home, fs::Permissions::from_mode(0o700)).unwrap();
        let first = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        let held = File::from(first.duplicate_lifetime(expires()).unwrap());
        let original_identity = identity(&held);
        let anchor = fixture.project.join(".caws/.render-writer-custody");
        let lock_path = anchor.join(".service-owner.lock");
        let diagnostic_path = fixture.root.join("cross-home-lock-exclusion.json");
        let persist = |diagnostic: &serde_json::Value| {
            fs::write(
                &diagnostic_path,
                serde_json::to_vec_pretty(diagnostic).unwrap(),
            )
            .unwrap();
            eprintln!(
                "writer cross-home checkpoint: {}",
                diagnostic_path.display()
            );
        };
        let before = snapshot(&fixture, &alternate_home);
        let mut diagnostic = json!({
            "schema": "caws.render.writer.cross-home-lock-exclusion.v1",
            "fixture": fixture.root, "deadlineMs": 5, "readmissionDeadlineMs": 500,
            "originalIdentity": original_identity, "originalHeld": describe(&held.metadata().unwrap()),
            "originalCustody": format!("{first:?}"), "before": before,
            "childProcesses": 0,
        });
        persist(&diagnostic);
        // acquire exposes String errors. Derive the sole accepted Deadline
        // spelling through the public typed API; arbitrary failures do not pass.
        let deadline = Custody::acquire(&anchor, Instant::now()).unwrap_err();
        diagnostic["deadlineControl"] = json!({
            "kind": format!("{:?}", deadline.kind), "error": deadline.to_string(),
        });
        persist(&diagnostic);
        assert_eq!(deadline.kind, crate::service_journal::ErrorKind::Deadline);
        let deadline_text = deadline.to_string();
        let busy_text = "service journal unavailable: another machine owner retains custody";
        for (name, home) in [
            ("sameHome", &fixture.home),
            ("alternateHome", &alternate_home),
        ] {
            let started = Instant::now();
            let result = acquire(home, &fixture.project, started + Duration::from_millis(5));
            let elapsed = started.elapsed();
            diagnostic[name] = json!({
                "home": home, "elapsedNs": elapsed.as_nanos().to_string(),
                "result": format!("{result:?}"),
                "error": result.as_ref().err(),
            });
            // Preserve the actual result and elapsed before further observation
            // or assertions can fail. Diagnostic I/O follows the 5ms attempt.
            persist(&diagnostic);
            diagnostic[name]["after"] = snapshot(&fixture, &alternate_home);
            persist(&diagnostic);
            let refusal = result.unwrap_err();
            assert!(
                refusal == busy_text || refusal == deadline_text,
                "{name} actual refusal: {refusal}; retained diagnostic: {}",
                diagnostic_path.display(),
            );
            assert_eq!(diagnostic["before"], diagnostic[name]["after"]);
        }
        let wrong_path = fixture.root.join("unrelated-lock");
        let wrong = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&wrong_path)
            .unwrap();
        let wrong_identity = identity(&wrong);
        let wrong_result = same_identity(&wrong, original_identity);
        diagnostic["wrongInodeControl"] = json!({
            "metadata": describe(&wrong.metadata().unwrap()),
            "identityCheck": format!("{wrong_result:?}"), "expectedIdentity": original_identity,
        });
        persist(&diagnostic);
        assert_ne!(wrong_identity, original_identity);
        assert_eq!(wrong_result, Err(wrong_identity));
        drop(wrong);
        let probe = |diagnostic: &mut serde_json::Value, name: &str, expected: (u64, u64)| {
            // Existing-only fresh open: dup would share the held flock's open
            // description and could not independently demonstrate exclusion.
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(&lock_path)
                .unwrap();
            let metadata = file.metadata().unwrap();
            let identity_check = same_identity(&file, expected);
            diagnostic[name] = json!({
                "metadata": describe(&metadata), "fd": file.as_raw_fd(),
                "identityCheck": format!("{identity_check:?}"), "expectedIdentity": expected,
            });
            persist(diagnostic);
            assert_eq!(identity_check, Ok(()));
            assert!(metadata.is_file());
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(metadata.mode() & 0o7777, 0o600);
            assert_eq!(metadata.nlink(), 1);
            assert_eq!(metadata.len(), 0);
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            let errno = if result == -1 {
                io::Error::last_os_error().raw_os_error()
            } else {
                None
            };
            diagnostic[name]["flockResult"] = json!(result);
            diagnostic[name]["errno"] = json!(errno);
            persist(diagnostic);
            assert_eq!(result, -1, "{name}: {}", diagnostic_path.display());
            assert_eq!(errno, Some(libc::EWOULDBLOCK));
            file
        };
        let original_probe = probe(&mut diagnostic, "originalHeldProbe", original_identity);
        let other = fixture.root.join("other-project");
        fs::create_dir(&other).unwrap();
        fs::create_dir(other.join(".caws")).unwrap();
        let separate_result = acquire(&fixture.home, &other, expires());
        diagnostic["otherProjectAcquire"] = json!({"result": format!("{separate_result:?}")});
        persist(&diagnostic);
        let separate = separate_result.unwrap();
        let separate_held = File::from(separate.duplicate_lifetime(expires()).unwrap());
        diagnostic["otherProjectHeldIdentity"] = json!(identity(&separate_held));
        diagnostic["afterOtherProject"] = snapshot(&fixture, &alternate_home);
        persist(&diagnostic);
        assert_ne!(identity(&separate_held), original_identity);
        assert_eq!(diagnostic["before"], diagnostic["afterOtherProject"]);
        drop(separate_held);
        drop(separate);
        drop(original_probe);
        drop(held);
        drop(first);
        let next_result = acquire(&alternate_home, &fixture.project, expires());
        diagnostic["readmissionResult"] = json!(format!("{next_result:?}"));
        persist(&diagnostic);
        let next = next_result.unwrap();
        let next_held = File::from(next.duplicate_lifetime(expires()).unwrap());
        diagnostic["readmittedIdentity"] = json!(identity(&next_held));
        diagnostic["readmitted"] = snapshot(&fixture, &alternate_home);
        persist(&diagnostic);
        assert_eq!(identity(&next_held), original_identity);
        assert_eq!(diagnostic["before"], diagnostic["readmitted"]);
        // Readmission must actually hold the kernel lock, not merely return a
        // capability which names the old inode after dropping its owner flock.
        let next_probe = probe(&mut diagnostic, "readmittedHeldProbe", original_identity);
        drop(next_probe);
        drop(next_held);
        drop(next);
        diagnostic["completion"] = json!({
            "state": "both_homes_refused_kernel_exclusion_independent_project_locked_readmission",
            "allProbeDescriptorsClosed": true, "allLifetimeDuplicatesClosed": true,
            "originalCustodyDropped": true, "otherProjectCustodyDropped": true,
            "readmittedCustodyDropped": true, "childProcesses": 0,
        });
        persist(&diagnostic);
    }
    #[test]
    fn preexisting_empty_or_partially_missing_anchor_is_never_reinitialized() {
        let fixture = Fixture::new();
        let expires = || Instant::now() + Duration::from_millis(500);
        let first = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        drop(first);
        let directory = fixture.project.join(".caws/.render-writer-custody");
        fs::remove_file(directory.join(".service-root.json")).unwrap();
        assert!(acquire(&fixture.home, &fixture.project, expires()).is_err());
        assert!(!directory.join(".service-root.json").exists());
        let empty = fixture.root.join("empty-project");
        fs::create_dir(&empty).unwrap();
        let empty_anchor = empty.join(".caws/.render-writer-custody");
        fs::create_dir_all(&empty_anchor).unwrap();
        fs::set_permissions(&empty_anchor, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(acquire(&fixture.home, &empty, expires()).is_err());
        assert_eq!(fs::read_dir(empty_anchor).unwrap().count(), 0);
    }
    #[test]
    fn abandoned_dispatch_blocks_next_generation_after_real_lock_release() {
        let fixture = Fixture::new();
        let expires = || Instant::now() + Duration::from_secs(1);
        let custody = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        let intent = begin(
            Arc::clone(&custody),
            &fixture.project,
            &"a".repeat(64),
            b"real-dispatch-input",
            expires(),
        )
        .unwrap();
        drop(intent);
        drop(custody);
        let refusal = acquire(&fixture.home, &fixture.project, expires()).unwrap_err();
        assert!(refusal.contains("unresolved execution"), "{refusal}");
    }
    #[test]
    fn registered_leaf_removal_replacement_and_partial_provision_never_initialize_a_new_domain() {
        let fixture = Fixture::new();
        let expires = || Instant::now() + Duration::from_millis(500);
        let custody = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        let anchor = fixture.project.join(".caws/.render-writer-custody");
        let moved = fixture.project.join(".caws/.render-writer-moved");
        fs::rename(&anchor, &moved).unwrap();
        assert!(acquire(&fixture.home, &fixture.project, expires()).is_err());
        assert!(!anchor.exists(), "missing registered anchor was recreated");
        fs::create_dir(&anchor).unwrap();
        fs::set_permissions(&anchor, fs::Permissions::from_mode(0o700)).unwrap();
        let replacement = Custody::initialize(&anchor, expires()).unwrap();
        drop(replacement);
        assert!(
            acquire(&fixture.home, &fixture.project, expires())
                .unwrap_err()
                .contains("anchor changed")
        );
        fs::remove_dir_all(&anchor).unwrap();
        fs::rename(&moved, &anchor).unwrap();
        drop(custody);
        let next = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        drop(next);
        let other = fixture.root.join("partial-provision");
        fs::create_dir_all(other.join(".caws")).unwrap();
        let marker = other.join(".caws/.render-writer-provisioned");
        let empty = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&marker)
            .unwrap();
        drop(empty);
        assert!(acquire(&fixture.home, &other, expires()).is_err());
        assert!(!other.join(".caws/.render-writer-custody").exists());
        assert_eq!(fs::read(marker).unwrap(), b"");
    }
    #[test]
    fn disposable_session_cache_replacement_cannot_partition_live_writer_custody() {
        fn describe(value: fs::Metadata) -> serde_json::Value {
            json!({
                "device": value.dev(), "inode": value.ino(), "mode": value.mode(),
                "uid": value.uid(), "links": value.nlink(), "bytes": value.len(),
                "mtime": value.mtime(), "mtimeNs": value.mtime_nsec(),
                "ctime": value.ctime(), "ctimeNs": value.ctime_nsec(),
            })
        }
        fn identity(file: &File) -> (u64, u64) {
            let metadata = file.metadata().unwrap();
            (metadata.dev(), metadata.ino())
        }
        // Both real probes and the wrong-inode control pass through this
        // identity oracle. Opening an existing name creates a separate open
        // file description; dup of the held flock would not test exclusion.
        fn open_same_lock(path: &Path, expected: (u64, u64)) -> Result<File, (u64, u64)> {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(path)
                .unwrap();
            let metadata = file.metadata().unwrap();
            assert!(metadata.is_file());
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(metadata.mode() & 0o7777, 0o600);
            assert_eq!(metadata.nlink(), 1);
            assert_eq!(metadata.len(), 0);
            let actual = (metadata.dev(), metadata.ino());
            if actual != expected {
                return Err(actual);
            }
            Ok(file)
        }
        fn snapshot(fixture: &Fixture, anchor: &Path, held: &File) -> serde_json::Value {
            let key = project_key(&fixture.project).unwrap();
            let service = anchor.join("operations/services").join(key);
            let mut stable = serde_json::Map::new();
            for (name, path) in [
                ("custody", anchor.to_path_buf()),
                ("operations", anchor.join("operations")),
                ("services", anchor.join("operations/services")),
                ("journalDirectory", service.clone()),
                (
                    "marker",
                    fixture.project.join(".caws/.render-writer-provisioned"),
                ),
                ("registry", anchor.join(".service-root.json")),
                ("namedLock", anchor.join(".service-owner.lock")),
                ("journalConfig", service.join(".journal.json")),
                ("journalLock", service.join(".journal.lock")),
            ] {
                let metadata = fs::symlink_metadata(&path).unwrap();
                let contents = if metadata.is_dir() {
                    let mut entries: Vec<_> = fs::read_dir(&path)
                        .unwrap()
                        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                        .collect();
                    entries.sort();
                    json!({"entries": entries})
                } else {
                    json!({"bytes": fs::read(&path).unwrap()})
                };
                stable.insert(
                    name.into(),
                    json!({
                        "device": metadata.dev(), "inode": metadata.ino(),
                        "mode": metadata.mode(), "uid": metadata.uid(),
                        "links": metadata.nlink(), "contents": contents,
                    }),
                );
            }
            let governance = fs::symlink_metadata(fixture.project.join(".caws")).unwrap();
            // Replacing a child legitimately changes parent timestamps, link
            // count and directory size; its identity and authority must survive.
            stable.insert(
                "governance".into(),
                json!({
                    "device": governance.dev(), "inode": governance.ino(),
                    "mode": governance.mode(), "uid": governance.uid(),
                }),
            );
            json!({
                "stable": stable,
                "governanceMetadata": describe(governance),
                "sessions": describe(fs::symlink_metadata(fixture.project.join(".caws/sessions")).unwrap()),
                "heldLock": describe(held.metadata().unwrap()),
                "heldFd": held.as_raw_fd(),
            })
        }
        // Retain this fresh fixture even on assertion unwind. It holds paths
        // only; every custody and probe descriptor retains ordinary RAII.
        let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let fixture = std::mem::ManuallyDrop::new(Fixture::at(parent));
        let expires = || Instant::now() + Duration::from_millis(500);
        let custody = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        let held = File::from(custody.duplicate_lifetime(expires()).unwrap());
        let original_identity = identity(&held);
        let anchor = fixture.project.join(".caws/.render-writer-custody");
        let lock_path = anchor.join(".service-owner.lock");
        let diagnostic_path = fixture.root.join("stable-lock-exclusion.json");
        let persist = |diagnostic: &serde_json::Value| {
            fs::write(
                &diagnostic_path,
                serde_json::to_vec_pretty(diagnostic).unwrap(),
            )
            .unwrap();
            eprintln!(
                "writer stable-lock checkpoint: {}; refusal={}; originalProbe={}; readmittedProbe={}",
                diagnostic_path.display(),
                diagnostic["acceptedRefusal"],
                diagnostic["originalHeldProbe"],
                diagnostic["readmittedHeldProbe"],
            );
        };
        let before = snapshot(&fixture, &anchor, &held);
        let mut diagnostic = json!({
            "schema": "caws.render.writer.stable-lock-exclusion.v1",
            "fixture": fixture.root, "deadlineMs": 5, "readmissionDeadlineMs": 500,
            "before": before, "originalIdentity": original_identity,
            "originalCustody": format!("{custody:?}"), "childProcesses": 0,
        });
        persist(&diagnostic);
        let sessions = fixture.project.join(".caws/sessions");
        fs::rename(&sessions, fixture.project.join(".caws/sessions-removed")).unwrap();
        fs::create_dir(&sessions).unwrap();
        let after_replacement = snapshot(&fixture, &anchor, &held);
        let started = Instant::now();
        let result = acquire(
            &fixture.home,
            &fixture.project,
            Instant::now() + Duration::from_millis(5),
        );
        let elapsed = started.elapsed();
        diagnostic["acquireElapsedNs"] = json!(elapsed.as_nanos().to_string());
        diagnostic["acquireResult"] = json!(format!("{result:?}"));
        diagnostic["afterReplacement"] = after_replacement;
        diagnostic["afterAcquire"] = snapshot(&fixture, &anchor, &held);
        persist(&diagnostic);
        let refusal = result.unwrap_err();
        // JournalError's constructor is private. Derive Deadline through its
        // public typed API; Busy is the exact Display of custody::owner_lock's
        // closed operation string, not a substring or arbitrary failure.
        let deadline = Custody::acquire(&anchor, Instant::now()).unwrap_err();
        assert_eq!(deadline.kind, crate::service_journal::ErrorKind::Deadline);
        let deadline_text = deadline.to_string();
        let busy_text = "service journal unavailable: another machine owner retains custody";
        diagnostic["acceptedRefusal"] = json!(refusal);
        diagnostic["acceptedRefusalKind"] = json!(if refusal == busy_text {
            "Busy"
        } else if refusal == deadline_text {
            "Deadline"
        } else {
            "Unrecognized"
        });
        persist(&diagnostic);
        assert!(
            refusal == busy_text || refusal == deadline_text,
            "actual refusal: {refusal}; retained diagnostic: {}",
            diagnostic_path.display(),
        );
        assert_ne!(
            diagnostic["before"]["sessions"]["inode"],
            diagnostic["afterReplacement"]["sessions"]["inode"]
        );
        assert_eq!(
            diagnostic["before"]["stable"],
            diagnostic["afterReplacement"]["stable"]
        );
        assert_eq!(
            diagnostic["before"]["stable"],
            diagnostic["afterAcquire"]["stable"]
        );

        let wrong_path = fixture.root.join("unrelated-lock");
        let wrong = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&wrong_path)
            .unwrap();
        let wrong_identity = identity(&wrong);
        let rejected_identity = open_same_lock(&wrong_path, original_identity).unwrap_err();
        diagnostic["wrongInodeControl"] = json!({
            "metadata": describe(wrong.metadata().unwrap()),
            "rejectedIdentity": rejected_identity, "expectedIdentity": original_identity,
        });
        persist(&diagnostic);
        assert_ne!(wrong_identity, original_identity);
        assert_eq!(rejected_identity, wrong_identity);
        drop(wrong);

        let probe = open_same_lock(&lock_path, original_identity).unwrap();
        let first_result = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        let first_errno = if first_result == -1 {
            io::Error::last_os_error().raw_os_error()
        } else {
            None
        };
        diagnostic["originalHeldProbe"] = json!({
            "metadata": describe(probe.metadata().unwrap()), "fd": probe.as_raw_fd(),
            "flockResult": first_result, "errno": first_errno,
        });
        persist(&diagnostic);
        assert_eq!(first_result, -1);
        assert_eq!(first_errno, Some(libc::EWOULDBLOCK));
        assert_eq!(
            custody.service_keys(1, expires()).unwrap(),
            vec![project_key(&fixture.project).unwrap()]
        );
        let journal = Journal::open(
            Arc::clone(&custody),
            &project_key(&fixture.project).unwrap(),
            MAX_RETAINED_RECORDS,
            expires(),
        )
        .unwrap();
        assert!(!journal.has_unknown(expires()).unwrap());
        assert!(journal.queued_request_ids(expires()).unwrap().is_empty());
        drop(journal);
        diagnostic["originalOwnerStillUsable"] = json!(true);
        diagnostic["afterOriginalUse"] = snapshot(&fixture, &anchor, &held);
        persist(&diagnostic);
        assert_eq!(
            diagnostic["before"]["stable"],
            diagnostic["afterOriginalUse"]["stable"]
        );
        drop(probe);
        drop(held);
        drop(custody);
        let next = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        let next_held = File::from(next.duplicate_lifetime(expires()).unwrap());
        diagnostic["readmitted"] = snapshot(&fixture, &anchor, &next_held);
        diagnostic["readmittedIdentity"] = json!(identity(&next_held));
        persist(&diagnostic);
        assert_eq!(identity(&next_held), original_identity);
        assert_eq!(
            diagnostic["before"]["stable"],
            diagnostic["readmitted"]["stable"]
        );
        // A successful reopen with the right inode is insufficient: the new
        // full-path capability must actually retain its lifetime kernel lock.
        let next_probe = open_same_lock(&lock_path, identity(&next_held)).unwrap();
        let next_result =
            unsafe { libc::flock(next_probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        let next_errno = if next_result == -1 {
            io::Error::last_os_error().raw_os_error()
        } else {
            None
        };
        diagnostic["readmittedHeldProbe"] = json!({
            "metadata": describe(next_probe.metadata().unwrap()), "fd": next_probe.as_raw_fd(),
            "flockResult": next_result, "errno": next_errno,
        });
        persist(&diagnostic);
        assert_eq!(next_result, -1);
        assert_eq!(next_errno, Some(libc::EWOULDBLOCK));
        drop(next_probe);
        drop(next_held);
        drop(next);
        fs::write(
            fixture.root.join("stable-lock-completion.json"),
            br#"{"state":"recognized_refusal_kernel_exclusion_and_locked_readmission","childProcesses":0,"allProbeDescriptorsClosed":true,"allLifetimeDuplicatesClosed":true,"originalCustodyDropped":true,"readmittedCustodyDropped":true}"#,
        )
        .unwrap();
        eprintln!("writer stable-lock completed diagnostic: {diagnostic}");
    }
    #[test]
    fn settled_actual_result_allows_next_generation_without_deleting_history() {
        let fixture = Fixture::new();
        let expires = || Instant::now() + Duration::from_secs(1);
        let custody = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        let intent = begin(
            Arc::clone(&custody),
            &fixture.project,
            &"a".repeat(64),
            b"finished-input",
            expires(),
        )
        .unwrap();
        settle(
            intent,
            ReturnedResult::ProcessExit {
                code: Some(7),
                signal: None,
            },
            expires(),
        )
        .unwrap();
        drop(custody);
        let next = acquire(&fixture.home, &fixture.project, expires()).unwrap();
        let intent = begin(
            Arc::clone(&next),
            &fixture.project,
            &"b".repeat(64),
            b"next-input",
            expires(),
        )
        .unwrap();
        settle(
            intent,
            ReturnedResult::ProcessExit {
                code: Some(0),
                signal: None,
            },
            expires(),
        )
        .unwrap();
        let journal = Journal::open(
            Arc::clone(&next),
            &project_key(&fixture.project).unwrap(),
            MAX_RETAINED_RECORDS,
            expires(),
        )
        .unwrap();
        assert!(!journal.has_unknown(expires()).unwrap());
        assert!(journal.queued_request_ids(expires()).unwrap().is_empty());
    }
    #[test]
    fn invalid_owner_output_session_generation_and_timeout_refuse_before_acquisition() {
        let fixture = Fixture::new();
        for (index, replacement) in [
            (5, "/tmp/other"),
            (7, "../other"),
            (9, "untrusted"),
            (11, "0"),
            (11, "120001"),
            (13, "relative-program"),
        ] {
            let mut args = fixture.args();
            args[index] = replacement.into();
            assert!(
                parse(&args).is_err(),
                "accepted field {index}: {replacement}"
            );
        }
        let mut duplicate = fixture.args();
        duplicate[2] = "--home".into();
        assert!(parse(&duplicate).is_err());
        assert!(!fixture.home.join("state").exists());
    }
    #[test]
    fn continuous_output_yields_after_bounded_bytes_without_claiming_eof() {
        struct Infinite;
        impl Read for Infinite {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                bytes.fill(b'x');
                Ok(bytes.len())
            }
        }
        let mut sink = Vec::new();
        let mut eof = false;
        drain(&mut Infinite, &mut sink, &mut eof).unwrap();
        assert_eq!(sink.len(), 16 * 8192);
        assert!(!eof);
    }
    #[test]
    fn direct_child_exit_is_preserved_and_timeout_retains_durable_unknown() {
        let fixture = Fixture::new();
        let mut args = fixture.args();
        args[13] = "/bin/sh".into();
        args.extend(["-c".into(), "exit 7".into()]);
        assert_eq!(run(&args).unwrap(), 7);
        args[11] = "50".into();
        args[15] = "sleep 5".into();
        assert_eq!(run(&args).unwrap(), 75);
        let refusal = acquire(
            &fixture.home,
            &fixture.project,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(refusal.contains("unresolved execution"));
    }
    #[test]
    fn actual_spawn_nochild_records_not_started_and_next_program_reuses_the_same_anchor() {
        let fixture = Fixture::new();
        let initial = acquire(
            &fixture.home,
            &fixture.project,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        drop(initial);
        let anchor = fixture
            .project
            .join(".caws/.render-writer-custody/.service-owner.lock");
        let inode = fs::metadata(&anchor).unwrap().ino();
        let mut args = fixture.args();
        args[13] = fixture
            .root
            .join("absent-executable")
            .to_str()
            .unwrap()
            .into();
        assert!(
            run(&args).is_err(),
            "missing program was not rejected before intent"
        );
        let script = fixture.root.join("executable-with-missing-interpreter");
        fs::write(&script, b"#!/definitely-absent-caws-interpreter\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        args[13] = script.to_str().unwrap().into();
        assert!(run(&args).is_err(), "actual exec ENOENT did not surface");
        fn records(directory: &Path, values: &mut Vec<serde_json::Value>) {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    records(&path, values);
                } else if path.extension().is_some_and(|ext| ext == "json") {
                    values.push(serde_json::from_slice(&fs::read(path).unwrap()).unwrap());
                }
            }
        }
        let mut values = Vec::new();
        records(
            &fixture
                .project
                .join(".caws/.render-writer-custody/operations"),
            &mut values,
        );
        let not_started: Vec<_> = values
            .iter()
            .filter(|row| row["body"]["outcome"]["terminal"]["result"]["kind"] == "not_started")
            .collect();
        assert_eq!(not_started.len(), 1);
        assert_eq!(not_started[0]["body"]["outcome"]["execution"], "consumed");
        assert_eq!(not_started[0]["body"]["verifiedRequestBase64"], "");
        assert_eq!(
            not_started[0]["body"]["outcome"]["terminal"]["result"]["stage"],
            "spawn"
        );
        assert_eq!(
            not_started[0]["body"]["outcome"]["terminal"]["result"]["errno"],
            libc::ENOENT
        );
        assert_eq!(run(&fixture.args()).unwrap(), 0);
        assert_eq!(fs::metadata(anchor).unwrap().ino(), inode);
    }
}
