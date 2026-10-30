//! Native construction of a private prepared record and advisory discovery.
//!
//! The caller must bind `UnverifiedCall` to the already authenticated host
//! stdio invocation, independently resolve its canonical Git project, and pass
//! the original non-renewed deadline. A parsed call or this output is not an
//! authority or launch permit. Source and private stdin are never logged.
//! Node, its entrypoints and their dependency tree are trusted versioned inputs;
//! path/hash checks are cooperative, not loaded-memory attestation. Discovery
//! executes the fixed Node entry outside the sandbox; it never executes source.
//! The fixed child process must be spawned by a single-threaded producer with a
//! quiescent descriptor table, no fd-mutating signal handlers, and no concurrent
//! child reaper. The native execution owner must perform both authorization phases.
use crate::{
    execution_authorizer_wire::{DiscoveryRequest, DiscoveryStatus, FrameDecoder},
    execution_child::{self, TerminationGrace},
    execution_fd_transport::configure_private_child,
    execution_host::HostContext,
    execution_ingress::UnverifiedCall,
    execution_owner::PinnedAuthorizer,
    execution_prepared::{
        CargoProject, CargoRuntime, Execution, NpmProject, PreparedRecord, ProgramImage,
    },
    execution_server::private_roots::PrivateLaunch,
    monotonic_deadline::{self, EffectCheck, MonotonicDeadline},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrepareRefusal {
    Host,
    Identity,
    Context,
    Image,
    Deadline,
    Cancelled,
    Control,
    Record,
    DiscoverySpawn,
    DiscoveryIo,
    DiscoveryReply,
    DiscoveryUnresolved,
    Utility,
}
/// Caller must retain and settle this actual child when present; no retry until
/// custody is resolved. The result has no Debug to avoid payload disclosure.
#[must_use = "retain any discovery child until settled"]
pub(crate) struct PrepareFailure {
    pub reason: PrepareRefusal,
    pub child: Option<Child>,
}
fn failure(reason: PrepareRefusal) -> PrepareFailure {
    PrepareFailure {
        reason,
        child: None,
    }
}
/// Association copied from the admitted invocation, without any worker
/// compatibility proof. The startup carrier must establish that separately.
pub(crate) struct PreparedAssociation {
    pub invocation_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub caller_anchor: String,
    pub server_environment_id: String,
    pub project_root: String,
    pub environment_anchor: String,
}
pub(crate) struct PreparedExecution {
    pub record: PreparedRecord,
    pub association: PreparedAssociation,
    pub sandboxed_launch: Option<PrivateLaunch>,
}
pub(crate) struct NpmPreparation<'a> {
    pub root: &'a str,
    pub entry: &'a ProgramImage,
    pub scratch_root: &'a str,
    pub generation_manifest_sha256: &'a str,
}
pub(crate) struct CargoPreparation<'a> {
    pub runtime: &'a CargoRuntime,
    pub scratch_root: &'a str,
}

fn live(
    deadline: &MonotonicDeadline,
    cancelled: &AtomicBool,
    control: &EffectCheck<'_>,
) -> Result<(), PrepareRefusal> {
    if cancelled.load(Ordering::Acquire) {
        return Err(PrepareRefusal::Cancelled);
    }
    deadline.check().map_err(|_| PrepareRefusal::Deadline)?;
    control("execution_preparation").map_err(|_| PrepareRefusal::Control)
}
fn physical(path: &str) -> Result<String, PrepareRefusal> {
    let p = Path::new(path);
    if !p.is_absolute() || path.contains('\0') {
        return Err(PrepareRefusal::Context);
    }
    fs::canonicalize(p)
        .map_err(|_| PrepareRefusal::Context)?
        .to_str()
        .map(str::to_owned)
        .ok_or(PrepareRefusal::Context)
}
fn physical_dir(path: &str) -> Result<String, PrepareRefusal> {
    let resolved = physical(path)?;
    if !fs::metadata(&resolved)
        .map_err(|_| PrepareRefusal::Context)?
        .is_dir()
    {
        return Err(PrepareRefusal::Context);
    }
    Ok(resolved)
}
fn sandbox_anchor(uri: &str) -> Result<String, PrepareRefusal> {
    let body = uri.strip_prefix("file://").ok_or(PrepareRefusal::Context)?;
    if !body.starts_with('/') || body.contains('?') || body.contains('#') {
        return Err(PrepareRefusal::Context);
    }
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let mut bytes = Vec::new();
    let raw = body.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            if i + 2 >= raw.len() {
                return Err(PrepareRefusal::Context);
            }
            bytes.push(
                (hex(raw[i + 1]).ok_or(PrepareRefusal::Context)? << 4)
                    | hex(raw[i + 2]).ok_or(PrepareRefusal::Context)?,
            );
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| PrepareRefusal::Context)?;
    physical_dir(text)
}
pub(crate) fn program(
    path: &str,
    check: &impl Fn() -> Result<(), PrepareRefusal>,
) -> Result<ProgramImage, PrepareRefusal> {
    check()?;
    if physical(path)? != path {
        return Err(PrepareRefusal::Image);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| PrepareRefusal::Image)?;
    let before = file.metadata().map_err(|_| PrepareRefusal::Image)?;
    if !before.is_file() || before.len() > 268_435_456 {
        return Err(PrepareRefusal::Image);
    }
    let mut h = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        check()?;
        let n = file.read(&mut buffer).map_err(|_| PrepareRefusal::Image)?;
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or(PrepareRefusal::Image)?;
        if total > 268_435_456 {
            return Err(PrepareRefusal::Image);
        }
        h.update(&buffer[..n]);
    }
    let after = file.metadata().map_err(|_| PrepareRefusal::Image)?;
    let named = fs::symlink_metadata(path).map_err(|_| PrepareRefusal::Image)?;
    if total != before.len()
        || !named.is_file()
        || named.dev() != before.dev()
        || named.ino() != before.ino()
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(PrepareRefusal::Image);
    }
    check()?;
    Ok(ProgramImage {
        path: path.to_owned(),
        sha256: format!("{:x}", h.finalize()),
    })
}
fn pin(
    image: &ProgramImage,
    check: &impl Fn() -> Result<(), PrepareRefusal>,
) -> Result<(), PrepareRefusal> {
    if program(&image.path, check)?.sha256 != image.sha256 {
        return Err(PrepareRefusal::Image);
    }
    Ok(())
}
fn protected_system(path: &str) -> bool {
    let p = Path::new(path);
    if !matches!(p.parent().and_then(Path::to_str), Some("/bin" | "/usr/bin")) {
        return false;
    }
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.uid() == 0 && m.mode() & 0o022 == 0)
}
fn safe_path(node: &ProgramImage) -> Result<Vec<String>, PrepareRefusal> {
    let node_dir = Path::new(&node.path)
        .parent()
        .and_then(Path::to_str)
        .ok_or(PrepareRefusal::Context)?;
    let mut result = Vec::new();
    for dir in [node_dir, "/usr/bin", "/bin"] {
        let dir = physical_dir(dir)?;
        if dir.contains(':') {
            return Err(PrepareRefusal::Context);
        }
        if !result.contains(&dir) {
            result.push(dir);
        }
    }
    Ok(result)
}
fn executable(path: &Path) -> io::Result<bool> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let name =
        CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::other("invalid path"))?;
    if unsafe { libc::access(name.as_ptr(), libc::X_OK) } == 0 {
        return Ok(true);
    }
    let e = io::Error::last_os_error();
    if matches!(e.raw_os_error(), Some(libc::ENOENT) | Some(libc::ENOTDIR)) {
        Ok(false)
    } else {
        Err(e)
    }
}
fn resolve(
    name: &str,
    dirs: &[String],
    node: &ProgramImage,
    authorizer: &ProgramImage,
    check: &impl Fn() -> Result<(), PrepareRefusal>,
) -> Result<ProgramImage, PrepareRefusal> {
    check()?;
    let path = Path::new(name);
    let chosen = if path.is_absolute() {
        physical(name).map_err(|_| PrepareRefusal::Utility)?
    } else {
        if name.contains('/') || name.is_empty() || name.contains('\0') {
            return Err(PrepareRefusal::Utility);
        }
        let mut found = None;
        for dir in dirs {
            check()?;
            let candidate = Path::new(dir).join(name);
            match executable(&candidate) {
                Ok(false) => continue,
                Err(_) => return Err(PrepareRefusal::Utility),
                Ok(true) => {
                    let m = fs::metadata(&candidate).map_err(|_| PrepareRefusal::Utility)?;
                    if m.is_file() {
                        found = Some(physical(
                            candidate.to_str().ok_or(PrepareRefusal::Utility)?,
                        )?);
                        break;
                    }
                }
            }
        }
        found.ok_or(PrepareRefusal::Utility)?
    };
    let requested = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(PrepareRefusal::Utility)?;
    let actual = Path::new(&chosen)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(PrepareRefusal::Utility)?;
    const ALLOWED: &[&str] = &[
        "sed", "rg", "grep", "cat", "head", "tail", "wc", "ls", "cut", "tr", "uniq", "printf",
        "echo", "pwd", "true", "false", "test", "[",
    ];
    let writer = Path::new(&authorizer.path)
        .parent()
        .ok_or(PrepareRefusal::Utility)?
        .join("writer-main.js");
    let lifecycle = writer
        .parent()
        .ok_or(PrepareRefusal::Utility)?
        .join("lifecycle-main.js");
    if (Path::new(name) == writer && Path::new(&chosen) == writer)
        || (Path::new(name) == lifecycle && Path::new(&chosen) == lifecycle)
    {
        // A dedicated pinned consumer file argument, not a general file callee.
    } else if name == "/usr/bin/git" && chosen == "/usr/bin/git" && protected_system(&chosen) {
    } else if requested == "node" {
        if chosen != node.path {
            return Err(PrepareRefusal::Utility);
        }
    } else if !ALLOWED.contains(&requested) || actual != requested || !protected_system(&chosen) {
        return Err(PrepareRefusal::Utility);
    }
    let image = program(&chosen, check)?;
    if requested == "node" && image.sha256 != node.sha256 {
        return Err(PrepareRefusal::Image);
    }
    Ok(image)
}
fn invocation_id(
    check: &impl Fn() -> Result<(), PrepareRefusal>,
) -> Result<String, PrepareRefusal> {
    check()?;
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|_| PrepareRefusal::Context)?;
    check()?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn wall_deadline(deadline: &MonotonicDeadline) -> Result<u64, PrepareRefusal> {
    deadline.check().map_err(|_| PrepareRefusal::Deadline)?;
    let remaining = deadline
        .expires()
        .saturating_duration_since(Instant::now())
        .as_millis();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PrepareRefusal::Deadline)?
        .as_millis();
    let result = now.checked_add(remaining).ok_or(PrepareRefusal::Deadline)?;
    if remaining == 0 || result > 9_007_199_254_740_991 {
        return Err(PrepareRefusal::Deadline);
    }
    u64::try_from(result).map_err(|_| PrepareRefusal::Deadline)
}
fn image_json(p: &ProgramImage) -> Value {
    json!({"path":p.path,"sha256":p.sha256})
}
fn lower_npm(
    value: &mut Value,
    call: &UnverifiedCall,
    pins: &PinnedAuthorizer,
    npm: &NpmPreparation<'_>,
    project: &NpmProject,
    path: &str,
    deadline: &MonotonicDeadline,
    check: &impl Fn() -> Result<(), PrepareRefusal>,
) -> Result<PrivateLaunch, PrepareRefusal> {
    check()?;
    let cwd = value["execution"]["cwd"]
        .as_str()
        .ok_or(PrepareRefusal::Record)?
        .to_owned();
    let root = value["projectRoot"]
        .as_str()
        .ok_or(PrepareRefusal::Record)?
        .to_owned();
    if call.source != "npm test"
        || project
            .npmrc
            .as_ref()
            .is_some_and(|config| Path::new(&config.path) != Path::new(&cwd).join(".npmrc"))
        || Path::new(&project.package_json.path) != Path::new(&cwd).join("package.json")
        || Path::new(&npm.entry.path) != Path::new(npm.root).join("bin/npm-cli.js")
        || program(&project.package_json.path, check)?.sha256 != project.package_json.sha256
    {
        return Err(PrepareRefusal::Image);
    }
    pin(npm.entry, check)?;
    if let Some(config) = &project.npmrc {
        pin(config, check)?;
    }
    let mut launch = PrivateLaunch::create(
        Path::new(npm.scratch_root),
        Path::new(&root),
        &call.session_id,
        &call.thread_id,
        &call.call_id,
        &call.sandbox_state_json,
    )
    .map_err(|_| PrepareRefusal::Context)?;
    let text = |p: &Path| p.to_str().map(str::to_owned).ok_or(PrepareRefusal::Context);
    let mut environment = BTreeMap::new();
    for (name, value) in [
        ("CAWS_EXECUTION_CALL", call.call_id.clone()),
        ("CAWS_EXECUTION_CALLER", call.caller_anchor.clone()),
        ("CAWS_EXECUTION_PROJECT", root),
        ("CAWS_EXECUTION_SESSION", call.session_id.clone()),
        ("CAWS_EXECUTION_THREAD", call.thread_id.clone()),
        ("CODEX_SANDBOX", "seatbelt".into()),
        ("CODEX_SANDBOX_NETWORK_DISABLED", "1".into()),
        ("HOME", text(&launch.invocation_root)?),
        ("LC_ALL", "C".into()),
        ("NPM_CONFIG_CACHE", text(&launch.cache_root)?),
        ("NPM_CONFIG_GLOBALCONFIG", "/dev/null".into()),
        ("NPM_CONFIG_SCRIPT_SHELL", "/bin/sh".into()),
        ("NPM_CONFIG_USERCONFIG", "/dev/null".into()),
        ("PATH", path.into()),
        ("TMPDIR", text(&launch.tmp_root)?),
    ] {
        environment.insert(name, value);
    }
    value["execution"]["executable"] = image_json(&pins.node);
    value["execution"]["argv"] = json!([
        pins.node.path,
        npm.entry.path,
        "--prefix",
        cwd,
        "--workspaces=false",
        "test"
    ]);
    value["execution"]["environment"] = json!(
        environment
            .into_iter()
            .map(|(name, value)| json!({"name":name,"value":value}))
            .collect::<Vec<_>>()
    );
    value["profile"]["kind"] = json!("npm-test-v1");
    value["profile"]["npm"] = json!({"runtime":{
        "node":image_json(&pins.node),"entry":image_json(npm.entry),"root":npm.root,
        "generationManifestSha256":npm.generation_manifest_sha256},"project":{
        "packageJson":image_json(&project.package_json),"npmrc":project.npmrc.as_ref().map(image_json),
        "testScript":project.test_script,"pathShadowSha256":project.path_shadow_sha256}});
    let execution: Execution =
        serde_json::from_value(value["execution"].clone()).map_err(|_| PrepareRefusal::Record)?;
    launch
        .bind_execution(&execution, deadline)
        .map_err(|_| PrepareRefusal::Record)?;
    value["sandbox"]["writeCeiling"] = json!({"schema":"caws.execution.write-ceiling.v1",
        "launchId":launch.launch_id,"invocationRoot":launch.invocation_root,
        "outputRoot":launch.output_root,"tmpRoot":launch.tmp_root,"cacheRoot":launch.cache_root,
        "manifestSha256":launch.manifest_sha256});
    check()?;
    Ok(launch)
}
fn lower_cargo(
    value: &mut Value,
    call: &UnverifiedCall,
    cargo: &CargoPreparation<'_>,
    project: &CargoProject,
    relative: &str,
    deadline: &MonotonicDeadline,
    check: &impl Fn() -> Result<(), PrepareRefusal>,
) -> Result<PrivateLaunch, PrepareRefusal> {
    check()?;
    let cwd = value["execution"]["cwd"]
        .as_str()
        .ok_or(PrepareRefusal::Record)?
        .to_owned();
    let root = value["projectRoot"]
        .as_str()
        .ok_or(PrepareRefusal::Record)?
        .to_owned();
    let runtime = cargo.runtime;
    let manifest = Path::new(&cwd).join(relative);
    let package = manifest.parent().ok_or(PrepareRefusal::Record)?;
    if call.source != format!("cargo run --manifest-path {relative}")
        || relative.is_empty()
        || !relative.is_ascii()
        || relative.len() > 4096
        || relative
            .bytes()
            .any(|b| b.is_ascii_control() || matches!(b, b'\\' | b':'))
        || Path::new(relative).is_absolute()
        || relative
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
        || Path::new(&project.manifest.path) != manifest
        || Path::new(&project.lock.path) != package.join("Cargo.lock")
        || Path::new(&project.entry.path) != package.join("src/main.rs")
        || !project.valid()
        || !runtime.valid()
        || physical_dir(&runtime.root)? != runtime.root
        || physical_dir(&runtime.sdk_root)? != runtime.sdk_root
    {
        return Err(PrepareRefusal::Record);
    }
    for image in [
        &runtime.cargo,
        &runtime.rustc,
        &runtime.linker,
        &project.manifest,
        &project.lock,
        &project.entry,
    ] {
        pin(image, check)?;
    }
    let mut launch = PrivateLaunch::create(
        Path::new(cargo.scratch_root),
        Path::new(&root),
        &call.session_id,
        &call.thread_id,
        &call.call_id,
        &call.sandbox_state_json,
    )
    .map_err(|_| PrepareRefusal::Context)?;
    let text = |p: &Path| p.to_str().map(str::to_owned).ok_or(PrepareRefusal::Context);
    let mut environment = BTreeMap::new();
    for (name, entry) in [
        ("CAWS_EXECUTION_CALL", call.call_id.clone()),
        ("CAWS_EXECUTION_CALLER", call.caller_anchor.clone()),
        ("CAWS_EXECUTION_PROJECT", root),
        ("CAWS_EXECUTION_SESSION", call.session_id.clone()),
        ("CAWS_EXECUTION_THREAD", call.thread_id.clone()),
        ("CARGO_HOME", text(&launch.cache_root)?),
        (
            "CARGO_ENCODED_RUSTFLAGS",
            format!(
                "--sysroot\u{1f}{}\u{1f}-C\u{1f}linker={}",
                runtime.root, runtime.linker.path
            ),
        ),
        ("CODEX_SANDBOX", "seatbelt".into()),
        ("CODEX_SANDBOX_NETWORK_DISABLED", "1".into()),
        ("HOME", text(&launch.invocation_root)?),
        ("LC_ALL", "C".into()),
        ("PATH", format!("{}/bin:/usr/bin:/bin", runtime.root)),
        ("RUSTC", runtime.rustc.path.clone()),
        ("SDKROOT", runtime.sdk_root.clone()),
        ("TMPDIR", text(&launch.tmp_root)?),
    ] {
        environment.insert(name, entry);
    }
    value["execution"]["executable"] = image_json(&runtime.cargo);
    value["execution"]["argv"] = json!([
        runtime.cargo.path,
        "run",
        "--locked",
        "--offline",
        "--frozen",
        "--jobs",
        "1",
        "--manifest-path",
        project.manifest.path,
        "--target-dir",
        format!("{}/target", text(&launch.output_root)?),
        "--bin",
        project.package_name,
        "--message-format",
        "json-render-diagnostics"
    ]);
    value["execution"]["environment"] = json!(
        environment
            .into_iter()
            .map(|(name, value)| json!({"name":name,"value":value}))
            .collect::<Vec<_>>()
    );
    value["profile"]["kind"] = json!("cargo-run-v1");
    value["profile"]["cargo"] = json!({"runtime":{
        "cargo":image_json(&runtime.cargo),"rustc":image_json(&runtime.rustc),"linker":image_json(&runtime.linker),
        "root":runtime.root,"sdkRoot":runtime.sdk_root,"toolchainVersion":runtime.toolchain_version,
        "generationManifestSha256":runtime.generation_manifest_sha256},"project":{
        "manifest":image_json(&project.manifest),"lock":image_json(&project.lock),"entry":image_json(&project.entry),
        "packageName":project.package_name,"version":project.version,"edition":project.edition,"configurationSha256":project.configuration_sha256}});
    let execution: Execution =
        serde_json::from_value(value["execution"].clone()).map_err(|_| PrepareRefusal::Record)?;
    launch
        .bind_execution(&execution, deadline)
        .map_err(|_| PrepareRefusal::Record)?;
    value["sandbox"]["writeCeiling"] = json!({"schema":"caws.execution.write-ceiling.v1",
        "launchId":launch.launch_id,"invocationRoot":launch.invocation_root,
        "outputRoot":launch.output_root,"tmpRoot":launch.tmp_root,"cacheRoot":launch.cache_root,
        "manifestSha256":launch.manifest_sha256});
    check()?;
    Ok(launch)
}
fn private_deadline(command: &mut Command, deadline: &MonotonicDeadline) {
    let envelope = deadline.envelope();
    // SAFETY: check_before_exec uses only async-signal-safe clock operations.
    unsafe {
        command.pre_exec(move || {
            monotonic_deadline::check_before_exec(envelope).map_err(io::Error::from_raw_os_error)
        });
    }
}

/// `call` must come from the authenticated host stdio invocation represented by
/// `host`; `canonical_project` comes from independent fixed-Git discovery.
/// Neither field supplied in user tool arguments nor JSON shape alone proves it.
pub(crate) fn prepare(
    call: &UnverifiedCall,
    host: &HostContext,
    canonical_project: &str,
    host_image: &ProgramImage,
    pins: &PinnedAuthorizer,
    discovery: &ProgramImage,
    npm: Option<&NpmPreparation<'_>>,
    cargo: Option<&CargoPreparation<'_>>,
    deadline: &MonotonicDeadline,
    cancelled: &AtomicBool,
    control: &EffectCheck<'_>,
) -> Result<PreparedExecution, PrepareFailure> {
    let envelope = deadline.envelope();
    if !cfg!(target_os = "macos")
        || envelope
            .expires_ns
            .checked_sub(envelope.started_ns)
            .is_none_or(|n| n == 0 || n > 30_000_000_000)
    {
        return Err(failure(PrepareRefusal::Deadline));
    }
    let check = || live(deadline, cancelled, control);
    check().map_err(failure)?;
    host.revalidate(deadline)
        .map_err(|_| failure(PrepareRefusal::Host))?;
    if host.executable() != Path::new(&host_image.path) || call.sandbox_launcher != host_image.path
    {
        return Err(failure(PrepareRefusal::Identity));
    }
    pin(host_image, &check).map_err(failure)?;
    pin(&pins.node, &check).map_err(failure)?;
    pin(&pins.entry, &check).map_err(failure)?;
    if let Some(writer) = &pins.writer {
        pin(writer, &check).map_err(failure)?;
    }
    if let Some(lifecycle) = &pins.lifecycle {
        pin(lifecycle, &check).map_err(failure)?;
    }
    pin(discovery, &check).map_err(failure)?;
    let caller = physical_dir(&call.caller_anchor).map_err(failure)?;
    if caller != call.caller_anchor {
        return Err(failure(PrepareRefusal::Context));
    }
    let project = physical_dir(canonical_project).map_err(failure)?;
    if project != canonical_project {
        return Err(failure(PrepareRefusal::Context));
    }
    let cwd = physical_dir(call.cwd.as_deref().unwrap_or(&caller)).map_err(failure)?;
    let environment_anchor = sandbox_anchor(&call.sandbox_cwd_uri).map_err(failure)?;
    let bash_path = physical("/bin/bash").map_err(failure)?;
    if Path::new(&bash_path).file_name().and_then(|n| n.to_str()) != Some("bash")
        || !protected_system(&bash_path)
    {
        return Err(failure(PrepareRefusal::Image));
    }
    let bash = program(&bash_path, &check).map_err(failure)?;
    let dirs = safe_path(&pins.node).map_err(failure)?;
    let path = dirs.join(":");
    let id = invocation_id(&check).map_err(failure)?;
    let state = call.sandbox_state_json.as_bytes();
    let unix_deadline = wall_deadline(deadline).map_err(failure)?;
    let draft = json!({"schema":"caws.execution.prepared.v1","invocationId":id,
        "association":{"kind":"codex-mcp-v1","sessionId":call.session_id,"threadId":call.thread_id,
            "callId":call.call_id,"callerAnchor":caller,"serverEnvironmentId":call.server_environment_id},
        "projectRoot":project,
        "execution":{"executable":image_json(&bash),"argv":[bash.path,"--noprofile","--norc","-c",call.source],
            "cwd":cwd,"environment":[
                {"name":"CAWS_EXECUTION_CALL","value":call.call_id},
                {"name":"CAWS_EXECUTION_CALLER","value":caller},
                {"name":"CAWS_EXECUTION_PROJECT","value":project},
                {"name":"CAWS_EXECUTION_SESSION","value":call.session_id},
                {"name":"CAWS_EXECUTION_THREAD","value":call.thread_id},
                {"name":"LC_ALL","value":"C"},{"name":"PATH","value":path}],"stdinBase64":""},
        "profile":{"kind":"bash-clean-v1","source":call.source,"utilities":[]},
        "sandbox":{"stateBase64":STANDARD.encode(state),"stateSha256":format!("{:x}",Sha256::digest(state)),
            "launcher":image_json(host_image),"environmentAnchor":environment_anchor},
        "limits":{"preparationDeadlineUnixMs":unix_deadline,"jobTimeoutMs":120000,"terminationGraceMs":1000,"maxOutputBytes":1048576}});
    let draft_bytes = serde_json::to_vec(&draft).map_err(|_| failure(PrepareRefusal::Record))?;
    let request =
        DiscoveryRequest::new(draft_bytes).map_err(|_| failure(PrepareRefusal::Record))?;
    let input = request
        .encode()
        .map_err(|_| failure(PrepareRefusal::Record))?;
    check().map_err(failure)?;
    pin(&pins.node, &check).map_err(failure)?;
    pin(discovery, &check).map_err(failure)?;
    host.revalidate(deadline)
        .map_err(|_| failure(PrepareRefusal::Host))?;
    let mut command = Command::new(&pins.node.path);
    command
        .arg(&discovery.path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .current_dir("/")
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_private_child(&mut command).map_err(|_| failure(PrepareRefusal::DiscoverySpawn))?;
    private_deadline(&mut command, deadline);
    check().map_err(failure)?;
    let grace = TerminationGrace::new(Duration::from_millis(1000))
        .map_err(|_| failure(PrepareRefusal::Deadline))?;
    control("execution_discovery_spawn").map_err(|_| failure(PrepareRefusal::Control))?;
    let child = command
        .spawn()
        .map_err(|_| failure(PrepareRefusal::DiscoverySpawn))?;
    drop(command);
    let effect =
        |_: &'static str| check().map_err(|_| "preparation control or deadline".to_owned());
    let output = match execution_child::service_child(
        child,
        &input,
        deadline.expires(),
        cancelled,
        65_540,
        65_536,
        131_076,
        grace,
        &effect,
    ) {
        Ok(value) => value,
        Err(e) => {
            return Err(PrepareFailure {
                reason: PrepareRefusal::DiscoveryIo,
                child: e.retained_child,
            });
        }
    };
    let mut frame = FrameDecoder::reply();
    frame
        .push(&output.stdout)
        .map_err(|_| failure(PrepareRefusal::DiscoveryReply))?;
    let payload = frame
        .finish()
        .map_err(|_| failure(PrepareRefusal::DiscoveryReply))?;
    let observed = request
        .correlate_reply(&payload)
        .map_err(|_| failure(PrepareRefusal::DiscoveryReply))?;
    if observed.status() != DiscoveryStatus::Observed {
        return Err(failure(PrepareRefusal::DiscoveryUnresolved));
    }
    let mut seen = BTreeSet::new();
    let mut utilities = Vec::new();
    for name in observed.commands() {
        let writer = Path::new(&pins.entry.path)
            .parent()
            .ok_or_else(|| failure(PrepareRefusal::Utility))?
            .join("writer-main.js");
        let lifecycle = writer
            .parent()
            .ok_or_else(|| failure(PrepareRefusal::Utility))?
            .join("lifecycle-main.js");
        if observed.execution().is_none()
            && (name == "/usr/bin/git" || Path::new(name) == writer || Path::new(name) == lifecycle)
        {
            return Err(failure(PrepareRefusal::Utility));
        }
        let utility = resolve(name, &dirs, &pins.node, &pins.entry, &check).map_err(failure)?;
        if seen.insert(utility.path.clone()) {
            utilities.push(image_json(&utility));
        }
        if utilities.len() > 32 {
            return Err(failure(PrepareRefusal::Utility));
        }
    }
    let mut final_value = draft;
    let mut sandboxed_launch = None;
    if let Some(execution) = observed.execution() {
        if execution.kind == "npm-test-v1" {
            if call.source != "npm test" || !observed.commands().is_empty() {
                return Err(failure(PrepareRefusal::Utility));
            }
            sandboxed_launch = Some(
                lower_npm(
                    &mut final_value,
                    call,
                    pins,
                    npm.ok_or_else(|| failure(PrepareRefusal::Utility))?,
                    execution
                        .project
                        .as_ref()
                        .ok_or_else(|| failure(PrepareRefusal::Record))?,
                    &path,
                    deadline,
                    &check,
                )
                .map_err(failure)?,
            );
        } else if execution.kind == "cargo-run-v1" {
            if !observed.commands().is_empty() {
                return Err(failure(PrepareRefusal::Utility));
            }
            sandboxed_launch = Some(
                lower_cargo(
                    &mut final_value,
                    call,
                    cargo.ok_or_else(|| failure(PrepareRefusal::Utility))?,
                    execution
                        .cargo_project
                        .as_ref()
                        .ok_or_else(|| failure(PrepareRefusal::Record))?,
                    &execution.argv[3],
                    deadline,
                    &check,
                )
                .map_err(failure)?,
            );
        } else {
            let lifecycle = execution.kind == "caws-lifecycle-v1";
            let consumer = Path::new(&pins.entry.path)
                .parent()
                .ok_or_else(|| failure(PrepareRefusal::Utility))?
                .join(if lifecycle {
                    "lifecycle-main.js"
                } else {
                    "writer-main.js"
                });
            let consumer_pin = if lifecycle {
                &pins.lifecycle
            } else {
                &pins.writer
            }
            .as_ref()
            .ok_or_else(|| failure(PrepareRefusal::Image))?;
            if execution.argv[0] != pins.node.path
                || Path::new(&execution.argv[1]) != consumer
                || Path::new(&consumer_pin.path) != consumer
                || (!lifecycle && (execution.argv[2] != "specs" || execution.argv[3] != "evidence"))
            {
                return Err(failure(PrepareRefusal::Utility));
            }
            if lifecycle
                && matches!(execution.argv[2].as_str(), "doctor" | "gates-run")
                && pins.lifecycle_context.is_none()
            {
                return Err(failure(PrepareRefusal::Utility));
            }
            // Discovery is advisory. Both Source phases must prove the exact
            // source-to-argv relation and writer authority before this can execute.
            final_value["profile"]["kind"] = json!(execution.kind);
            final_value["execution"]["executable"] = image_json(&pins.node);
            final_value["execution"]["argv"] = json!(execution.argv);
            for env in final_value["execution"]["environment"]
                .as_array_mut()
                .unwrap()
            {
                if env["name"] == "PATH" {
                    env["value"] = json!("/usr/bin:/bin");
                }
            }
            if lifecycle {
                if let Some(context) = &pins.lifecycle_context {
                    if !context.well_formed() {
                        return Err(failure(PrepareRefusal::Identity));
                    }
                    let environment = final_value["execution"]["environment"]
                        .as_array_mut()
                        .unwrap();
                    for (name, value) in context.environment() {
                        physical_dir(value).map_err(failure)?;
                        environment.push(json!({"name":name,"value":value}));
                    }
                    environment.sort_by(|a, b| {
                        a["name"]
                            .as_str()
                            .unwrap()
                            .as_bytes()
                            .cmp(b["name"].as_str().unwrap().as_bytes())
                    });
                }
            }
            for name in [
                &pins.node.path,
                consumer
                    .to_str()
                    .ok_or_else(|| failure(PrepareRefusal::Utility))?,
                "/usr/bin/git",
            ] {
                let utility =
                    resolve(name, &dirs, &pins.node, &pins.entry, &check).map_err(failure)?;
                if seen.insert(utility.path.clone()) {
                    utilities.push(image_json(&utility));
                }
            }
        }
    }
    final_value["profile"]["utilities"] = Value::Array(utilities);
    let final_bytes =
        serde_json::to_vec(&final_value).map_err(|_| failure(PrepareRefusal::Record))?;
    let record =
        PreparedRecord::decode(final_bytes).map_err(|_| failure(PrepareRefusal::Record))?;
    host.revalidate(deadline)
        .map_err(|_| failure(PrepareRefusal::Host))?;
    check().map_err(failure)?;
    let association = PreparedAssociation {
        invocation_id: record.value().invocation_id.clone(),
        session_id: call.session_id.clone(),
        thread_id: call.thread_id.clone(),
        call_id: call.call_id.clone(),
        caller_anchor: caller,
        server_environment_id: call.server_environment_id.clone(),
        project_root: project,
        environment_anchor,
    };
    Ok(PreparedExecution {
        record,
        association,
        sandboxed_launch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_deadline_is_bounded_and_never_renewed() {
        let deadline = MonotonicDeadline::capture(Duration::from_millis(500)).unwrap();
        let before = deadline.envelope();
        let wall = wall_deadline(&deadline).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(wall >= now && wall <= now + 500);
        assert_eq!(deadline.envelope(), before);
    }
    #[test]
    fn malformed_sandbox_uris_and_relative_programs_fail_closed() {
        for uri in [
            "file://remote/tmp",
            "https://example.test/",
            "file:///tmp?x",
            "file:///tmp%00x",
            "file:///tmp%Q1",
        ] {
            assert!(sandbox_anchor(uri).is_err(), "{uri}");
        }
        let node = ProgramImage {
            path: "/bin/node".into(),
            sha256: "0".repeat(64),
        };
        assert!(resolve("foo/bar", &["/usr/bin".into()], &node, &node, &|| Ok(())).is_err());
        assert!(resolve("", &["/usr/bin".into()], &node, &node, &|| Ok(())).is_err());
    }
    #[test]
    fn cancellation_and_carrier_loss_refuse_before_io() {
        let deadline = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        assert_eq!(
            live(&deadline, &AtomicBool::new(true), &|_| Ok(())),
            Err(PrepareRefusal::Cancelled)
        );
        assert_eq!(
            live(&deadline, &AtomicBool::new(false), &|_| Err("lost".into())),
            Err(PrepareRefusal::Control)
        );
    }
}
// Opt-in integration against the actual Source Node discovery and authorizer.
// The process-parent and fixture identity are real local test observations, not
// Codex host identity, an authenticated MCP carrier, or sandbox placement.
#[cfg(all(test, target_os = "macos"))]
mod consumer_tests {
    use super::*;
    use crate::execution_owner::{self, OwnerOutcome, TrustedInvocation};
    use serde_json::Value;
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        sync::{Arc, atomic::AtomicBool},
        time::Duration,
    };

    const FIXTURE: &str = "execution_prepare::consumer_tests::isolated_fixture";
    const SETUP: &str = r#"
const fs = require('node:fs');
const path = require('node:path');
const mod = require(process.argv[1]);
const f = mod.authorityFixture();
fs.writeFileSync(path.join(f.lane, 'src', 'data.txt'), 'seed\n');
process.stdout.write(JSON.stringify({root:f.root,caws:f.caws,lane:f.lane,
  registry:f.registryPath,record:f.record})+'\n');
process.stdin.resume();
"#;
    const STATE: &str = "{ \"fixture\":true, \"opaque\":1, \"opaque\":2 }";

    fn required(name: &str) -> String {
        let value = std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"));
        let path = Path::new(&value);
        assert!(path.is_absolute(), "{name} must be absolute");
        assert_eq!(
            fs::canonicalize(path).unwrap(),
            path,
            "{name} must be physical"
        );
        value
    }
    fn image(path: &str) -> ProgramImage {
        ProgramImage {
            path: path.to_owned(),
            sha256: format!("{:x}", Sha256::digest(fs::read(path).unwrap())),
        }
    }
    fn file_uri(path: &str) -> String {
        let mut result = String::from("file://");
        for byte in path.bytes() {
            if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
                result.push(byte as char);
            } else {
                use std::fmt::Write as _;
                write!(&mut result, "%{byte:02X}").unwrap();
            }
        }
        result
    }
    struct Fixture {
        child: Child,
        data: Value,
        clean: bool,
    }
    impl Fixture {
        fn create(node: &str, fixture: &str) -> Self {
            let mut child = Command::new(node)
                .arg("-e")
                .arg(SETUP)
                .arg(fixture)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let mut line = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            let data: Value = serde_json::from_str(&line).unwrap();
            eprintln!(
                "prepare consumer fixture root={} lane={} registry={}",
                data["root"], data["lane"], data["registry"]
            );
            Self {
                child,
                data,
                clean: false,
            }
        }
        fn text(&self, key: &str) -> &str {
            self.data[key].as_str().unwrap()
        }
        fn path(&self, key: &str) -> PathBuf {
            PathBuf::from(self.text(key))
        }
        fn finish(mut self) {
            drop(self.child.stdin.take());
            let status = self.child.wait().unwrap();
            assert!(status.success());
            assert!(!self.path("root").exists());
            self.clean = true;
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if !self.clean {
                eprintln!(
                    "retaining failed prepare fixture root={}",
                    self.data["root"]
                );
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
    fn call(f: &Fixture, host_path: &str, source: &str) -> UnverifiedCall {
        let a = &f.data["record"]["association"];
        let text = |key: &str| a[key].as_str().unwrap().to_owned();
        UnverifiedCall {
            id_json: "1".into(),
            source: source.into(),
            cwd: None,
            session_id: text("sessionId"),
            thread_id: text("threadId"),
            call_id: text("callId"),
            caller_anchor: f.text("lane").into(),
            server_environment_id: text("serverEnvironmentId"),
            sandbox_state_json: STATE.into(),
            sandbox_cwd_uri: file_uri(f.text("root")),
            sandbox_launcher: host_path.into(),
        }
    }
    fn prep_failure(mut f: PrepareFailure) -> PrepareRefusal {
        if let Some(child) = f.child.take() {
            let grace = TerminationGrace::new(Duration::from_millis(100)).unwrap();
            if let (Some(child), _) = execution_child::stop_child(child, grace) {
                std::mem::forget(child);
            }
            panic!("unexpected retained discovery child: {:?}", f.reason);
        }
        f.reason
    }
    fn owner_failure(mut f: execution_owner::OwnerFailure) -> ! {
        let grace = TerminationGrace::new(Duration::from_millis(100)).unwrap();
        let mut unsettled = false;
        if let Some(child) = f.child.take() {
            if let (Some(child), _) = execution_child::stop_child(child, grace) {
                unsettled = true;
                std::mem::forget(child);
            }
        }
        if let Some(job) = &mut f.job_failure {
            if let Some(child) = job.retained_child.take() {
                if let (Some(child), _) = execution_child::stop_child(child, grace) {
                    unsettled = true;
                    std::mem::forget(child);
                }
            }
        }
        if let Some(mut fence) = f.fence.take() {
            if unsettled || fence.try_release().is_err() {
                std::mem::forget(fence);
            }
        }
        panic!(
            "owner failed: {:?}, possible={}",
            f.reason, f.user_spawn_may_have_occurred
        )
    }
    fn environment() -> (String, String, String, String) {
        (
            required("CAWS_TEST_NODE"),
            required("CAWS_TEST_AUTHORIZER_ENTRY"),
            required("CAWS_TEST_DISCOVERY_ENTRY"),
            required("CAWS_TEST_AUTHORITY_FIXTURE"),
        )
    }
    #[test]
    fn isolated_fixture() {
        let Ok(case) = std::env::var("CAWS_PREPARE_CONSUMER_CASE") else {
            return;
        };
        let (node, entry, discovery, fixture) = environment();
        let f = Fixture::create(&node, &fixture);
        let self_path = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        let host_image = image(self_path.to_str().unwrap());
        let deadline = MonotonicDeadline::capture(if case == "expired" {
            Duration::from_millis(2)
        } else {
            Duration::from_secs(30)
        })
        .unwrap();
        // This child is launched directly by the same test binary, so the
        // actual parent process/image is measured by HostContext.
        let host = if case == "expired" {
            // Capture before expiry using a separate live context deadline;
            // the invocation deadline below remains the original expired one.
            let startup = MonotonicDeadline::capture(Duration::from_secs(30)).unwrap();
            HostContext::capture(&host_image, &startup).unwrap()
        } else {
            HostContext::capture(&host_image, &deadline).unwrap()
        };
        let pins = PinnedAuthorizer {
            writer: None,
            lifecycle: None,
            lifecycle_context: None,
            node: image(&node),
            entry: image(&entry),
        };
        let selected = if case == "wrong_protocol" {
            image(&entry)
        } else {
            image(&discovery)
        };
        let source = match case.as_str() {
            "positive" => "cat src/data.txt > src/result.txt; head -n 1 src/data.txt; printf done",
            "unresolved" => "printf forbidden > src/unresolved.txt; \"$missing\" arg",
            "wrong_protocol" => "printf forbidden > src/wrong_protocol.txt",
            "expired" => "printf forbidden > src/expired.txt",
            "cancelled" => "printf forbidden > src/cancelled.txt",
            "control" => "printf forbidden > src/control.txt",
            _ => panic!("unknown case"),
        };
        let input = call(&f, &host_image.path, source);
        if case == "expired" {
            std::thread::sleep(Duration::from_millis(5));
        }
        let cancelled = AtomicBool::new(case == "cancelled");
        let check = |_: &'static str| {
            if case == "control" {
                Err("injected loss".into())
            } else {
                Ok(())
            }
        };
        let result = prepare(
            &input,
            &host,
            f.text("root"),
            &host_image,
            &pins,
            &selected,
            None,
            None,
            &deadline,
            &cancelled,
            &check,
        );
        if case == "positive" {
            let prepared = match result {
                Ok(x) => x,
                Err(e) => panic!("prepare failed: {:?}", prep_failure(e)),
            };
            assert_eq!(prepared.record.sandbox_state(), STATE.as_bytes());
            assert_eq!(prepared.record.value().profile.source, source);
            assert!(
                !f.path("lane").join("src/result.txt").exists(),
                "discovery must not execute source"
            );
            let images = &prepared.record.value().profile.utilities;
            let actual = images
                .iter()
                .map(|i| i.path.clone())
                .collect::<BTreeSet<_>>();
            let expected = ["/bin/cat", "/usr/bin/head"]
                .into_iter()
                .map(|p| fs::canonicalize(p).unwrap().to_str().unwrap().to_owned())
                .collect::<BTreeSet<_>>();
            assert_eq!(actual, expected);
            assert_eq!(images.len(), 2);
            let assoc = prepared.association;
            // Synthetic test-only compatibility value; not a sandbox proof.
            let trusted = TrustedInvocation {
                invocation_id: assoc.invocation_id,
                session_id: assoc.session_id,
                thread_id: assoc.thread_id,
                call_id: assoc.call_id,
                caller_anchor: assoc.caller_anchor,
                server_environment_id: assoc.server_environment_id,
                project_root: assoc.project_root,
                environment_anchor: assoc.environment_anchor,
                same_host_macos_verified: true,
            };
            let output = match execution_owner::execute(
                prepared.record,
                &trusted,
                &pins,
                &deadline,
                Arc::new(AtomicBool::new(false)),
                &|_| Ok(()),
            ) {
                OwnerOutcome::Completed(output) => output,
                OwnerOutcome::Failed(e) => owner_failure(e),
            };
            assert!(output.status.success());
            assert_eq!(output.stdout, b"seed\ndone");
            assert!(output.stderr.is_empty());
            assert_eq!(
                fs::read(f.path("lane").join("src/result.txt")).unwrap(),
                b"seed\n"
            );
            assert!(!f.path("caws").join("state.lock").exists());
        } else {
            let expected = match case.as_str() {
                "unresolved" => PrepareRefusal::DiscoveryUnresolved,
                "wrong_protocol" => PrepareRefusal::DiscoveryReply,
                "expired" => PrepareRefusal::Deadline,
                "cancelled" => PrepareRefusal::Cancelled,
                "control" => PrepareRefusal::Control,
                _ => unreachable!(),
            };
            let why = match result {
                Ok(_) => panic!("unexpected prepared record"),
                Err(e) => prep_failure(e),
            };
            assert_eq!(why, expected);
            assert!(!f.path("lane").join(format!("src/{case}.txt")).exists());
            assert!(!f.path("caws").join("state.lock").exists());
        }
        f.finish();
    }
    fn case(name: &str) {
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(FIXTURE)
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env("CAWS_PREPARE_CONSUMER_CASE", name)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "case={name} stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
    #[test]
    #[ignore = "requires explicit real Node, Source entries, fixture and isolated process"]
    fn actual_discovery_freezes_utilities_then_worker_authorizes_and_runs() {
        case("positive");
    }
    #[test]
    #[ignore = "requires explicit real Node, Source entries, fixture and isolated process"]
    fn actual_unresolved_and_wrong_authorizer_protocol_never_make_final_record() {
        case("unresolved");
        case("wrong_protocol");
    }
    #[test]
    #[ignore = "requires explicit real Node, Source entries, fixture and isolated process"]
    fn expired_cancelled_and_lost_control_refuse_before_launch() {
        case("expired");
        case("cancelled");
        case("control");
    }
}
