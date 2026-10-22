//! Invocation-owned descriptors and nonblocking relay to the persistent owner.
//! Public hashes bind bytes; the native owner and current image admission supply
//! permission. Transport loss never supplies evidence of nonexecution or retry.
use crate::{
    cli::Config,
    protocol::{Ready, Request},
};
use caws_native::{
    render_owner::{self, Offer, OwnerConfig, PreparedConnection},
    service_image,
    service_protocol::{self, RenderRequest, ServiceRenderGrant},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    net::Shutdown,
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::{
            fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::UnixStream,
        },
    },
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

fn check(deadline: Instant) -> Result<(), String> {
    if Instant::now() >= deadline {
        Err("render admission deadline expired".into())
    } else {
        Ok(())
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|s| s.len() <= 4096 && !s.contains(['\0', '\r', '\n']))
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}
fn no_symlinks(path: &Path) -> Result<(), String> {
    if !absolute(path) {
        return Err("noncanonical native render path".into());
    }
    let mut cursor = PathBuf::from("/");
    for part in path.components().skip(1) {
        cursor.push(part.as_os_str());
        let metadata =
            fs::symlink_metadata(&cursor).map_err(|e| format!("render path metadata: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err("symlink native render path".into());
        }
        if metadata.uid() != unsafe { libc::geteuid() } && metadata.uid() != 0 {
            return Err("foreign-owned native render path".into());
        }
        if metadata.mode() & 0o022 != 0
            && !(metadata.is_dir() && metadata.uid() == 0 && metadata.mode() & 0o1000 != 0)
        {
            return Err("writable native render path".into());
        }
    }
    Ok(())
}
fn high_file(file: File) -> io::Result<File> {
    let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn high_stream(stream: UnixStream) -> io::Result<UnixStream> {
    let fd = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}
static SERIAL: AtomicU64 = AtomicU64::new(0);

pub struct DescriptorBank {
    root: PathBuf,
    client: Option<UnixStream>,
    engine: Option<UnixStream>,
    engine_grant: Option<File>,
    engine_receipt: Option<File>,
    grant_writer: File,
    receipt_reader: File,
}
impl DescriptorBank {
    pub fn new() -> Result<Self, String> {
        let parent = std::env::temp_dir()
            .canonicalize()
            .map_err(|e| format!("render temp parent: {e}"))?;
        no_symlinks(&parent)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "render clock before epoch")?
            .as_nanos();
        let root = parent.join(format!(
            "caws-render-invocation-{}-{nonce}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|e| format!("private render descriptor directory: {e}"))?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let construct = || -> io::Result<Self> {
            let grant_path = root.join("grant.json");
            let grant_writer = high_file(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&grant_path)?,
            )?;
            let engine_grant = high_file(
                OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&grant_path)?,
            )?;
            grant_writer.set_permissions(fs::Permissions::from_mode(0o400))?;
            let receipt_path = root.join("receipt.json");
            let engine_receipt = high_file(
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&receipt_path)?,
            )?;
            engine_receipt.set_permissions(fs::Permissions::from_mode(0o600))?;
            let receipt_reader = high_file(
                OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&receipt_path)?,
            )?;
            let (client, engine) = UnixStream::pair()?;
            let client = high_stream(client)?;
            let engine = high_stream(engine)?;
            client.set_nonblocking(true)?;
            Ok(Self {
                root: root.clone(),
                client: Some(client),
                engine: Some(engine),
                engine_grant: Some(engine_grant),
                engine_receipt: Some(engine_receipt),
                grant_writer,
                receipt_reader,
            })
        };
        construct().map_err(|e| {
            let _ = fs::remove_dir_all(&root);
            format!("private render descriptors: {e}")
        })
    }
    pub fn child_sources(&self) -> [RawFd; 3] {
        [
            self.engine.as_ref().expect("before spawn").as_raw_fd(),
            self.engine_grant
                .as_ref()
                .expect("before spawn")
                .as_raw_fd(),
            self.engine_receipt
                .as_ref()
                .expect("before spawn")
                .as_raw_fd(),
        ]
    }
    pub fn spawned(&mut self) {
        self.engine.take();
        self.engine_grant.take();
        self.engine_receipt.take();
    }
    pub fn withdraw(&mut self) {
        if let Some(client) = self.client.take() {
            let _ = client.shutdown(Shutdown::Both);
        }
    }
    fn install_grant(&mut self, grant: &ServiceRenderGrant) -> Result<(), String> {
        let bytes = service_protocol::encode_service_grant(grant).map_err(|e| e.to_string())?;
        if self
            .grant_writer
            .metadata()
            .map_err(|e| e.to_string())?
            .len()
            != 0
        {
            return Err("render grant descriptor was already filled".into());
        }
        self.grant_writer
            .write_all_at(&bytes, 0)
            .map_err(|e| format!("render grant write: {e}"))?;
        self.grant_writer
            .sync_all()
            .map_err(|e| format!("render grant sync: {e}"))?;
        self.grant_writer
            .set_permissions(fs::Permissions::from_mode(0o400))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
impl Drop for DescriptorBank {
    fn drop(&mut self) {
        self.withdraw();
        // Only these invocation-created regular files are disposed. Never walk
        // an owner namespace or infer cleanup authority from a reported PID.
        let _ = fs::remove_file(self.root.join("grant.json"));
        let _ = fs::remove_file(self.root.join("receipt.json"));
        let _ = fs::remove_dir(&self.root);
    }
}

pub struct Preparation {
    config: OwnerConfig,
    offer: Offer,
    context: service_image::AdmissionContext,
}
/// Bind a distinct owner operation to native code roots and captured home.
/// This check grants no renderer eligibility or publication authority.
#[cfg(feature = "sqlite-store")]
pub fn captured_store_owner_config(
    config: &Config,
    request: &Request,
    ready: &Ready,
) -> Result<OwnerConfig, String> {
    let environment = request.caller_environment();
    let home = match environment.get("CAWS_HOME").filter(|s| !s.is_empty()) {
        Some(home) => PathBuf::from(home),
        None => {
            PathBuf::from(environment.get("HOME").ok_or("store home unavailable")?).join(".caws")
        }
    };
    if !absolute(&home) || ready.budget_home != home {
        return Err("store home differs from captured caller home".into());
    }
    let client_root = config
        .engine
        .parent()
        .ok_or("trusted engine has no client root")?;
    let package_root = client_root
        .parent()
        .and_then(Path::parent)
        .ok_or("trusted engine has no package root")?;
    let config_path = home.join("state/render-service/config.json");
    no_symlinks(&config_path)?;
    let owner = render_owner::read_config(&config_path)?;
    if owner.home != home
        || owner.client_root != client_root
        || owner.template_root != package_root.join("templates/hook-packs/runtime/service-image")
        || owner.client_shell_source
            != package_root.join("templates/hook-packs/shared/lib/session-render-service-client.sh")
        || owner.native_executable != std::env::current_exe().map_err(|e| e.to_string())?
    {
        return Err("store owner code roots differ from trusted native configuration".into());
    }
    Ok(owner)
}
pub fn prepare_offer(
    config: &Config,
    request: &Request,
    ready: &Ready,
    mut offer: Offer,
    deadline: Instant,
) -> Result<Preparation, String> {
    check(deadline)?;
    if config.surface != "codex"
        || config.event != "stop"
        || config.configuration != "system"
        || !ready.active
    {
        return Err("render offer outside active system Codex Stop".into());
    }
    let environment = request.caller_environment();
    let home = if let Some(home) = environment.get("CAWS_HOME").filter(|s| !s.is_empty()) {
        PathBuf::from(home)
    } else {
        PathBuf::from(environment.get("HOME").ok_or("render home unavailable")?).join(".caws")
    };
    if !absolute(&home) || ready.budget_home != home {
        return Err("render home differs from captured caller home".into());
    }
    let selection = &offer.expected_selection;
    if offer.schema != "caws.render.owner.offer.v1"
        || offer.invocation_id != request.id
        || offer.caller_environment != *environment
        || Some(offer.session_id.as_str()) != ready.session_id.as_deref()
        || ready.project_digest.as_deref()
            != Some(hash(selection.canonical_project.as_bytes()).as_str())
        || selection.runtime_digest != request.runtime_digest
        || selection.surface != "codex"
        || selection.event != "stop"
        || selection.configuration != "system"
        || offer.prepared.manifest.selection != *selection
        || !absolute(Path::new(&offer.checkout))
        || !absolute(Path::new(&selection.canonical_project))
    {
        return Err("render offer differs from native request and pinned selection".into());
    }
    let cwd = Path::new(request.caller_cwd())
        .canonicalize()
        .map_err(|e| format!("render checkout observation: {e}"))?;
    if !cwd.starts_with(&offer.checkout) {
        return Err("render checkout does not contain native caller".into());
    }
    let client_root = config
        .engine
        .parent()
        .ok_or("trusted engine has no client root")?
        .to_path_buf();
    let package_root = client_root
        .parent()
        .and_then(Path::parent)
        .ok_or("trusted engine has no package root")?;
    let template_root = package_root.join("templates/hook-packs/runtime/service-image");
    let client_shell_source =
        package_root.join("templates/hook-packs/shared/lib/session-render-service-client.sh");
    let config_path = home.join("state/render-service/config.json");
    no_symlinks(&config_path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(&config_path)
        .map_err(|e| format!("explicit render owner config unavailable: {e}"))?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o7777 != 0o600
        || before.nlink() != 1
        || before.len() > 65_536
    {
        return Err("unsafe explicit render owner config".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    if bytes.len() as u64 != before.len()
        || (
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
        )
    {
        return Err("render owner config changed during read".into());
    }
    let owner: OwnerConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("invalid explicit render owner config: {e}"))?;
    let native = std::env::current_exe().map_err(|e| e.to_string())?;
    if owner.schema != "caws.render.owner.config.v1"
        || owner.home != home
        || owner.client_root != client_root
        || owner.template_root != template_root
        || owner.client_shell_source != client_shell_source
        || owner.native_executable != native
    {
        return Err(
            "render owner config code roots differ from trusted native configuration".into(),
        );
    }
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or("render deadline expired")?
        .as_millis() as u64;
    if offer.remaining_budget_ms == 0
        || offer.remaining_budget_ms > 120_000
        || u128::from(offer.remaining_budget_ms) > config.timeout.as_millis()
    {
        return Err("render offer exceeds native remaining budget".into());
    }
    offer.remaining_budget_ms = offer.remaining_budget_ms.min(remaining);
    if offer.remaining_budget_ms == 0 {
        return Err("no native render admission budget".into());
    }
    let context = service_image::AdmissionContext {
        home,
        canonical_project: selection.canonical_project.clone(),
        runtime_digest: request.runtime_digest.clone(),
        client_root,
        template_root,
        client_shell_source,
        native_executable: Some(native),
        expected_selection: selection.clone(),
        expected_image_digest: offer.prepared.image_digest.clone(),
        expected_policy_sha256: offer.policy_sha256.clone(),
        caller_environment: environment.clone(),
    };
    check(deadline)?;
    Ok(Preparation {
        config: owner,
        offer,
        context,
    })
}

pub struct Admission {
    connection: PreparedConnection,
    prepared: render_owner::OwnerPrepared,
}
pub fn connect(preparation: Preparation, deadline: Instant) -> Result<Admission, String> {
    check(deadline)?;
    let offer = preparation.offer;
    let connection = render_owner::prepare(&preparation.config, offer.clone(), deadline)?;
    let prepared = connection.prepared().clone();
    let grant = &prepared.grant;
    grant.validate().map_err(|e| e.to_string())?;
    let manifest = &offer.prepared.manifest;
    if service_image::image_key(manifest).map_err(|e| e.to_string())? != offer.prepared.image_key {
        return Err("render image key differs from native derivation".into());
    }
    let selected = offer
        .expected_selection
        .handlers
        .get(usize::from(offer.expected_selection.selected_index))
        .ok_or("render selected index missing")?;
    let root = Path::new(&manifest.execution.root);
    let logical_lease = Path::new(&offer.expected_selection.canonical_project)
        .join(".caws/sessions/.renderer-daemon.json");
    let client = manifest
        .execution
        .files
        .iter()
        .find(|f| f.path == "client/service-client.js")
        .ok_or("render client missing")?;
    if prepared.schema != "caws.render.owner.prepared.v1"
        || prepared.image.manifest != *manifest
        || prepared.image.image_digest != offer.prepared.image_digest
        || prepared.image.image_key != offer.prepared.image_key
        || grant.invocation_id != offer.invocation_id
        || grant.selected_index != offer.expected_selection.selected_index
        || grant.canonical_project != offer.expected_selection.canonical_project
        || grant.source_generation != manifest.source_generation
        || grant.original_source.handler_sha256 != selected.sha256
        || grant.original_source.closure_digest != manifest.original_closure_digest
        || grant.execution_image.image_digest != offer.prepared.image_digest
        || grant.execution_image.client_sha256 != client.sha256
        || grant.original_handler_entry != selected.entry
        || grant.original_handler_path != selected.path
        || Path::new(&grant.hooks_directory) != root.join(&manifest.execution.hooks)
        || Path::new(&grant.lease_file) != logical_lease
        || grant.remaining_budget_ms > offer.remaining_budget_ms
        || prepared.git_view.git_work_tree != Path::new(&offer.checkout)
        || prepared.backend_pid == 0
    {
        return Err("owner prepared grant differs from native issued expectation".into());
    }
    // Independently verify the full source/tool closure and image custody here.
    // No work separates this admission from the deadline check; the owner
    // revalidates again at dispatch, including after any queue wait.
    service_image::validate_image(root, &preparation.context, deadline)
        .map_err(|e| e.to_string())?;
    check(deadline)?;
    Ok(Admission {
        connection,
        prepared,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderAdmission<'a> {
    schema: &'static str,
    grant: &'a ServiceRenderGrant,
    image: &'a render_owner::OwnerImage,
    descriptors: Descriptors,
    git_directory: &'a Path,
    git_work_tree: &'a Path,
    git_original_directory: &'a Path,
    git_common_directory: &'a Path,
}
#[derive(Serialize)]
struct Descriptors {
    transport: u8,
    grant: u8,
    receipt: u8,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dispatch<'a> {
    schema: &'static str,
    id: &'a str,
    runtime_digest: &'a str,
    render_admission: RenderAdmission<'a>,
}
pub fn activate(
    bank: &mut DescriptorBank,
    admission: Admission,
    request: &Request,
) -> Result<(Bridge, Vec<u8>), String> {
    let client = bank.client.as_ref().ok_or("render descriptors withdrawn")?;
    let mut byte = [0u8; 1];
    let count = unsafe {
        libc::recv(
            client.as_raw_fd(),
            byte.as_mut_ptr().cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    if count >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::WouldBlock {
        return Err("render client used transport before grant".into());
    }
    bank.install_grant(&admission.prepared.grant)?;
    let prepared = admission.prepared;
    let row = RenderAdmission {
        schema: "caws.service.render.admission.v1",
        grant: &prepared.grant,
        image: &prepared.image,
        descriptors: Descriptors {
            transport: 3,
            grant: 4,
            receipt: 5,
        },
        git_directory: &prepared.git_view.git_directory,
        git_work_tree: &prepared.git_view.git_work_tree,
        git_original_directory: &prepared.git_view.git_original_directory,
        git_common_directory: &prepared.git_view.git_common_directory,
    };
    let mut dispatch = serde_json::to_vec(&Dispatch {
        schema: "caws.runtime.dispatch.v2",
        id: &request.id,
        runtime_digest: &request.runtime_digest,
        render_admission: row,
    })
    .map_err(|e| e.to_string())?;
    dispatch.push(b'\n');
    let bridge = Bridge {
        client: bank.client.take(),
        owner: Some(admission.connection.into_stream()),
        grant: prepared.grant,
        request: None,
        request_bytes: Vec::new(),
        reply_bytes: Vec::new(),
        written: 0,
        stage: Stage::ClientRequest,
        diagnostic: None,
    };
    Ok((bridge, dispatch))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    ClientRequest,
    OwnerWrite,
    OwnerRead,
    ClientWrite,
    Done,
}
pub struct Bridge {
    client: Option<UnixStream>,
    owner: Option<UnixStream>,
    grant: ServiceRenderGrant,
    request: Option<RenderRequest>,
    request_bytes: Vec<u8>,
    reply_bytes: Vec<u8>,
    written: usize,
    stage: Stage,
    diagnostic: Option<String>,
}
fn read_bounded(stream: &mut UnixStream, bytes: &mut Vec<u8>, max: usize) -> Result<bool, String> {
    let mut chunk = [0u8; 16_384];
    match stream.read(&mut chunk) {
        Ok(0) => Ok(true),
        Ok(n) => {
            if bytes.len() + n > max + 1 {
                return Err("render bridge frame exceeds bound".into());
            }
            bytes.extend_from_slice(&chunk[..n]);
            Ok(false)
        }
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(format!("render bridge read: {e}")),
    }
}
fn send_some(stream: &UnixStream, bytes: &[u8]) -> Result<usize, String> {
    #[cfg(target_os = "macos")]
    let flags = {
        let enabled: libc::c_int = 1;
        if unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&enabled as *const libc::c_int).cast(),
                std::mem::size_of_val(&enabled) as libc::socklen_t,
            )
        } != 0
        {
            return Err(format!(
                "render socket SIGPIPE protection: {}",
                io::Error::last_os_error()
            ));
        }
        0
    };
    #[cfg(not(target_os = "macos"))]
    let flags = libc::MSG_NOSIGNAL;
    let count = unsafe {
        libc::send(
            stream.as_raw_fd(),
            bytes.as_ptr().cast(),
            bytes.len().min(16_384),
            flags,
        )
    };
    if count < 0 {
        let e = io::Error::last_os_error();
        if matches!(
            e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            Ok(0)
        } else {
            Err(format!("render bridge write: {e}"))
        }
    } else if count == 0 {
        Err("render bridge write made no progress".into())
    } else {
        Ok(count as usize)
    }
}
fn one_frame(bytes: &[u8]) -> Result<(), String> {
    if bytes.last() != Some(&b'\n') || bytes[..bytes.len() - 1].contains(&b'\n') {
        Err("render bridge requires one LF frame and EOF".into())
    } else {
        Ok(())
    }
}
impl Bridge {
    pub fn interests(&self) -> Vec<libc::pollfd> {
        match self.stage {
            Stage::ClientRequest | Stage::ClientWrite => self
                .client
                .as_ref()
                .map(|s| {
                    vec![libc::pollfd {
                        fd: s.as_raw_fd(),
                        events: if self.stage == Stage::ClientRequest {
                            libc::POLLIN
                        } else {
                            libc::POLLOUT
                        },
                        revents: 0,
                    }]
                })
                .unwrap_or_default(),
            Stage::OwnerWrite | Stage::OwnerRead => self
                .owner
                .as_ref()
                .map(|s| {
                    vec![libc::pollfd {
                        fd: s.as_raw_fd(),
                        events: if self.stage == Stage::OwnerRead {
                            libc::POLLIN
                        } else {
                            libc::POLLOUT
                        },
                        revents: 0,
                    }]
                })
                .unwrap_or_default(),
            Stage::Done => Vec::new(),
        }
    }
    pub fn tick(&mut self) {
        if let Err(error) = self.advance() {
            self.diagnostic = Some(error);
            self.close();
        }
    }
    fn advance(&mut self) -> Result<(), String> {
        match self.stage {
            Stage::ClientRequest => {
                if read_bounded(
                    self.client.as_mut().ok_or("missing render client")?,
                    &mut self.request_bytes,
                    service_protocol::MAX_SERVICE_BRIDGE_REQUEST_BYTES,
                )? {
                    one_frame(&self.request_bytes)?;
                    let incoming = service_protocol::decode_service_bridge_request(
                        &self.request_bytes,
                        &self.grant,
                    )
                    .map_err(|e| e.to_string())?;
                    let expected = self
                        .grant
                        .request(incoming.request.arguments.clone())
                        .map_err(|e| e.to_string())?;
                    service_protocol::validate_issued_request(&incoming, &self.grant, &expected)
                        .map_err(|e| e.to_string())?;
                    self.request = Some(expected);
                    self.stage = Stage::OwnerWrite;
                    self.written = 0;
                }
            }
            Stage::OwnerWrite => {
                let owner = self.owner.as_ref().ok_or("missing render owner")?;
                self.written += send_some(owner, &self.request_bytes[self.written..])?;
                if self.written == self.request_bytes.len() {
                    owner.shutdown(Shutdown::Write).map_err(|e| e.to_string())?;
                    self.stage = Stage::OwnerRead;
                    self.written = 0;
                }
            }
            Stage::OwnerRead => {
                if read_bounded(
                    self.owner.as_mut().ok_or("missing render owner")?,
                    &mut self.reply_bytes,
                    service_protocol::MAX_SERVICE_BRIDGE_REPLY_BYTES,
                )? {
                    one_frame(&self.reply_bytes)?;
                    service_protocol::decode_service_bridge_reply(
                        &self.reply_bytes,
                        &self.grant,
                        self.request.as_ref().ok_or("missing issued request")?,
                    )
                    .map_err(|e| e.to_string())?;
                    self.stage = Stage::ClientWrite;
                    self.written = 0;
                }
            }
            Stage::ClientWrite => {
                let client = self.client.as_ref().ok_or("missing render client")?;
                self.written += send_some(client, &self.reply_bytes[self.written..])?;
                if self.written == self.reply_bytes.len() {
                    client
                        .shutdown(Shutdown::Write)
                        .map_err(|e| e.to_string())?;
                    self.close();
                }
            }
            Stage::Done => {}
        }
        Ok(())
    }
    fn close(&mut self) {
        self.stage = Stage::Done;
        if let Some(client) = self.client.take() {
            let _ = client.shutdown(Shutdown::Both);
        }
        self.owner.take();
    }
    pub fn diagnostic(&self, bank: &DescriptorBank) -> Option<String> {
        let mut notes = Vec::new();
        if let Some(error) = &self.diagnostic {
            notes.push(format!("render relay: {error}; request not retried"));
        }
        let observed = (|| -> Result<(), String> {
            let length = bank
                .receipt_reader
                .metadata()
                .map_err(|e| e.to_string())?
                .len() as usize;
            if length == 0 {
                return Ok(());
            }
            if length > service_protocol::MAX_SERVICE_RECEIPT_BYTES + 1 {
                return Err("render receipt exceeds byte bound".into());
            }
            let mut bytes = vec![0u8; length];
            bank.receipt_reader
                .read_exact_at(&mut bytes, 0)
                .map_err(|e| e.to_string())?;
            let request = self
                .request
                .as_ref()
                .ok_or("receipt without admitted request; diagnostic only")?;
            let receipt =
                service_protocol::decode_service_client_receipt(&bytes, &self.grant, request)
                    .map_err(|e| e.to_string())?;
            if !matches!(
                receipt.outcome,
                service_protocol::ClientObservation::OwnerOutcome { .. }
            ) {
                return Err(format!(
                    "render client observation: {:?}; no retry",
                    receipt.outcome
                ));
            }
            Ok(())
        })();
        if let Err(error) = observed {
            notes.push(error);
        }
        (!notes.is_empty()).then(|| notes.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::io::Write;

    fn issued() -> (ServiceRenderGrant, RenderRequest) {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("service_protocol/fixtures.json")).unwrap();
        let grant = STANDARD.decode(fixture["grant"].as_str().unwrap()).unwrap();
        let request = STANDARD
            .decode(fixture["request"].as_str().unwrap())
            .unwrap();
        (
            service_protocol::decode_service_grant(&grant).unwrap(),
            service_protocol::decode_render_request(&request).unwrap(),
        )
    }
    fn bridge() -> (Bridge, UnixStream, UnixStream, RenderRequest) {
        let (grant, request) = issued();
        let (client, client_peer) = UnixStream::pair().unwrap();
        let (owner, owner_peer) = UnixStream::pair().unwrap();
        client.set_nonblocking(true).unwrap();
        owner.set_nonblocking(true).unwrap();
        (
            Bridge {
                client: Some(client),
                owner: Some(owner),
                grant,
                request: None,
                request_bytes: Vec::new(),
                reply_bytes: Vec::new(),
                written: 0,
                stage: Stage::ClientRequest,
                diagnostic: None,
            },
            client_peer,
            owner_peer,
            request,
        )
    }
    fn drive(bridge: &mut Bridge, expected: Stage) {
        for _ in 0..1024 {
            bridge.tick();
            if bridge.stage == expected {
                return;
            }
        }
        panic!(
            "bridge did not reach expected state; diagnostic {:?}",
            bridge.diagnostic
        );
    }
    #[test]
    fn descriptor_bank_keeps_grant_and_receipt_access_directions_and_positions_separate() {
        let (grant, _) = issued();
        let mut bank = DescriptorBank::new().unwrap();
        let root = bank.root.clone();
        let sources = bank.child_sources();
        assert!(sources.iter().all(|fd| *fd >= 10));
        for fd in sources {
            assert_ne!(
                unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
        }
        assert_eq!(
            unsafe { libc::fcntl(sources[1], libc::F_GETFL) } & libc::O_ACCMODE,
            libc::O_RDONLY
        );
        assert_eq!(
            unsafe { libc::fcntl(sources[2], libc::F_GETFL) } & libc::O_ACCMODE,
            libc::O_WRONLY
        );
        assert_eq!(
            bank.engine_grant
                .as_ref()
                .unwrap()
                .metadata()
                .unwrap()
                .mode()
                & 0o7777,
            0o400
        );
        assert_eq!(
            bank.engine_receipt
                .as_ref()
                .unwrap()
                .metadata()
                .unwrap()
                .mode()
                & 0o7777,
            0o600
        );
        assert_eq!(
            bank.engine_grant
                .as_ref()
                .unwrap()
                .metadata()
                .unwrap()
                .len(),
            0
        );
        bank.install_grant(&grant).unwrap();
        assert!(bank.install_grant(&grant).is_err());
        let mut bytes = Vec::new();
        bank.engine_grant
            .as_mut()
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(
            bytes,
            service_protocol::encode_service_grant(&grant).unwrap()
        );
        assert_eq!(
            unsafe { libc::write(sources[1], b"x".as_ptr().cast(), 1) },
            -1
        );
        let mut byte = [0u8; 1];
        assert_eq!(
            unsafe { libc::read(sources[2], byte.as_mut_ptr().cast(), 1) },
            -1
        );
        bank.engine_receipt
            .as_mut()
            .unwrap()
            .write_all(b"receipt")
            .unwrap();
        let mut receipt = [0u8; 7];
        bank.receipt_reader.read_exact_at(&mut receipt, 0).unwrap();
        assert_eq!(&receipt, b"receipt");
        drop(bank);
        assert!(!root.exists());
    }
    #[test]
    fn relay_waits_for_eof_then_preserves_exact_request_and_reply_bytes() {
        let (mut bridge, mut client, mut owner, request) = bridge();
        let request_bytes =
            service_protocol::encode_service_bridge_request(&bridge.grant, &request).unwrap();
        client.write_all(&request_bytes).unwrap();
        for _ in 0..4 {
            bridge.tick();
        }
        assert!(bridge.stage == Stage::ClientRequest);
        assert!(bridge.request.is_none());
        owner.set_nonblocking(true).unwrap();
        let mut byte = [0; 1];
        assert_eq!(
            owner.read(&mut byte).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        client.shutdown(Shutdown::Write).unwrap();
        drive(&mut bridge, Stage::OwnerRead);
        owner.set_nonblocking(false).unwrap();
        let mut forwarded = Vec::new();
        owner.read_to_end(&mut forwarded).unwrap();
        assert_eq!(forwarded, request_bytes);
        assert_eq!(bridge.request.as_ref().unwrap(), &request);
        let outcome = service_protocol::RenderOutcomeFrame::for_request(
            &request,
            service_protocol::RenderOutcome::Unknown,
        )
        .unwrap();
        let reply =
            service_protocol::encode_service_bridge_reply(&bridge.grant, &request, &outcome)
                .unwrap();
        owner.write_all(&reply[..reply.len() / 2]).unwrap();
        bridge.tick();
        assert!(bridge.stage == Stage::OwnerRead);
        owner.write_all(&reply[reply.len() / 2..]).unwrap();
        owner.shutdown(Shutdown::Write).unwrap();
        drive(&mut bridge, Stage::Done);
        let mut observed = Vec::new();
        client.read_to_end(&mut observed).unwrap();
        assert_eq!(observed, reply);
        assert!(bridge.diagnostic.is_none());
    }
    #[test]
    fn malformed_owner_reply_closes_client_without_fabricating_an_outcome_or_retrying() {
        let (mut bridge, mut client, mut owner, request) = bridge();
        client
            .write_all(
                &service_protocol::encode_service_bridge_request(&bridge.grant, &request).unwrap(),
            )
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        drive(&mut bridge, Stage::OwnerRead);
        let mut forwarded = Vec::new();
        owner.read_to_end(&mut forwarded).unwrap();
        assert_eq!(
            forwarded,
            service_protocol::encode_service_bridge_request(&bridge.grant, &request).unwrap()
        );
        owner.write_all(b"{}\n").unwrap();
        owner.shutdown(Shutdown::Write).unwrap();
        drive(&mut bridge, Stage::Done);
        let mut observed = Vec::new();
        client.read_to_end(&mut observed).unwrap();
        assert!(observed.is_empty());
        assert!(bridge.diagnostic.is_some());
        assert_eq!(bridge.request.as_ref().unwrap(), &request);
    }
    #[test]
    fn multiple_client_frames_are_rejected_before_any_owner_request_bytes() {
        let (mut bridge, mut client, mut owner, request) = bridge();
        let bytes =
            service_protocol::encode_service_bridge_request(&bridge.grant, &request).unwrap();
        client.write_all(&bytes).unwrap();
        client.write_all(&bytes).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        drive(&mut bridge, Stage::Done);
        let mut forwarded = Vec::new();
        owner.read_to_end(&mut forwarded).unwrap();
        assert!(forwarded.is_empty());
        assert!(bridge.request.is_none());
        assert_eq!(
            bridge.diagnostic.as_deref(),
            Some("render bridge requires one LF frame and EOF")
        );
    }
    #[test]
    fn one_frame_and_read_bounds_reject_trailing_bytes_empty_and_unterminated_data() {
        for bytes in [b"".as_slice(), b"{}", b"{}\n{}\n", b"{}\ntrailing"] {
            assert!(one_frame(bytes).is_err());
        }
        assert!(one_frame(b"{}\n").is_ok());
        let (mut receiver, mut sender) = UnixStream::pair().unwrap();
        receiver.set_nonblocking(true).unwrap();
        sender.write_all(b"12345").unwrap();
        assert!(read_bounded(&mut receiver, &mut Vec::new(), 3).is_err());
    }
}
