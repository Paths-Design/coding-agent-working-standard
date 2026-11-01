//! Private lifecycle-to-native Git-hook bridge wire protocol.
//!
//! The socket is a capability held only by the pinned lifecycle and callback
//! clients. Deserializing a request does not admit it or grant write authority.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt,
    io::{self, Read, Write},
    os::unix::{fs::DirBuilderExt, net::UnixStream},
    path::Component,
};

const PROTOCOL: &str = "caws.execution.git-bridge.v1";
const FRAME_LIMIT: usize = 1024 * 1024;

/// Non-renewing lifetime of the original lifecycle job. This is distinct from
/// the <=30-second preparation envelopes used by nested Host admissions.
pub(crate) struct GitHookJobDeadline {
    expires_ns: u64,
    expires: Instant,
}
impl GitHookJobDeadline {
    pub(crate) fn capture(timeout_ms: u64) -> io::Result<Self> {
        if !(1..=86_400_000).contains(&timeout_ms) {
            return Err(invalid());
        }
        let before = Instant::now();
        let start = monotonic_now()?;
        let expires_ns = start
            .checked_add(timeout_ms.checked_mul(1_000_000).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        let expires = before
            .checked_add(Duration::from_millis(timeout_ms))
            .ok_or_else(invalid)?;
        Ok(Self {
            expires_ns,
            expires,
        })
    }
    pub(crate) fn expires(&self) -> Instant {
        self.expires
    }
    pub(crate) fn expires_ns(&self) -> u64 {
        self.expires_ns
    }
    pub(crate) fn check(&self) -> io::Result<()> {
        if Instant::now() >= self.expires || monotonic_now()? >= self.expires_ns {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "git hook job expired",
            ));
        }
        Ok(())
    }
}
fn monotonic_now() -> io::Result<u64> {
    let mut raw = std::mem::MaybeUninit::<libc::timespec>::uninit();
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, raw.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let raw = unsafe { raw.assume_init() };
    if raw.tv_sec < 0 || !(0..1_000_000_000).contains(&raw.tv_nsec) {
        return Err(invalid());
    }
    (raw.tv_sec as u64)
        .checked_mul(1_000_000_000)
        .and_then(|v| v.checked_add(raw.tv_nsec as u64))
        .ok_or_else(invalid)
}

// serde's usual map deserializer accepts a repeated key with last-value wins.
// On a capability channel there must be only one interpretation of each field.
fn unique_map<'de, D, V>(deserializer: D) -> Result<BTreeMap<String, V>, D::Error>
where
    D: Deserializer<'de>,
    V: Deserialize<'de>,
{
    struct MapVisitor<V>(std::marker::PhantomData<V>);
    impl<'de, V: Deserialize<'de>> Visitor<'de> for MapVisitor<V> {
        type Value = BTreeMap<String, V>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an object with unique keys")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut input: A) -> Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = input.next_entry::<String, V>()? {
                if result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate key"));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(MapVisitor(std::marker::PhantomData))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Envelope {
    protocol: String,
    request_id: String,
    request: Request,
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Configure {
        roots: Vec<Root>,
    },
    Open {
        cwd: String,
        hook: String,
        args: Vec<String>,
        #[serde(deserialize_with = "unique_map")]
        git_environment: BTreeMap<String, String>,
        stdin_base64: String,
    },
    Execute {
        context_id: String,
        seed_index_path: String,
        seed_index_sha256: String,
        object_directory: String,
    },
    Assert {
        context_id: String,
    },
    Finish {
        context_id: String,
        exit_code: i32,
        publication: Publication,
    },
    Verdict {},
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Root {
    cwd: String,
    hooks_directory: String,
    authorized_paths: Vec<String>,
    #[serde(deserialize_with = "unique_map")]
    hooks: BTreeMap<String, Option<HookImage>>,
    formatters: Formatters,
    read_only_paths: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HookImage {
    path: String,
    sha256: String,
    dev: String,
    ino: String,
    mode: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Formatters {
    eslint: Option<FormatterImage>,
    prettier: Option<FormatterImage>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatterImage {
    path: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Publication {
    NotPublished,
    ObjectsMayExist,
    IndexPublished,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply<'a> {
    protocol: &'static str,
    request_id: &'a str,
    response: Response,
}
#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum Response {
    Ok {
        data: serde_json::Map<String, serde_json::Value>,
    },
    Refused {
        reason: &'static str,
        user_spawn_may_have_occurred: bool,
    },
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid git bridge frame")
}
fn parse_frame(bytes: &[u8]) -> io::Result<Envelope> {
    let value: Envelope = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if value.protocol != PROTOCOL
        || value.request_id.len() != 32
        || !value
            .request_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    Ok(value)
}

/// Incrementally buffers requests and replies. EOF, bad framing, or bad JSON
/// closes the channel; it never attempts to resynchronize attacker-controlled bytes.
struct Wire {
    socket: UnixStream,
    input: Vec<u8>,
    output: VecDeque<Vec<u8>>,
    output_offset: usize,
    eof: bool,
}
impl Wire {
    fn new(socket: UnixStream) -> io::Result<Self> {
        socket.set_nonblocking(true)?;
        Ok(Self {
            socket,
            input: Vec::new(),
            output: VecDeque::new(),
            output_offset: 0,
            eof: false,
        })
    }
    fn read(&mut self) -> io::Result<Vec<Envelope>> {
        let mut buf = [0; 8192];
        while !self.eof {
            match self.socket.read(&mut buf) {
                Ok(0) => {
                    self.eof = true;
                    break;
                }
                Ok(n) => {
                    self.input.extend_from_slice(&buf[..n]);
                    if self.input.len() > 2 * (FRAME_LIMIT + 4) {
                        return Err(invalid());
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        let mut result = Vec::new();
        loop {
            if self.input.len() < 4 {
                break;
            }
            let size =
                u32::from_be_bytes(self.input[..4].try_into().map_err(|_| invalid())?) as usize;
            if size == 0 || size > FRAME_LIMIT {
                return Err(invalid());
            }
            if self.input.len() < size + 4 {
                break;
            }
            result.push(parse_frame(&self.input[4..size + 4])?);
            self.input.drain(..size + 4);
        }
        if self.eof && !self.input.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "incomplete git bridge frame",
            ));
        }
        Ok(result)
    }
    fn reply(&mut self, request_id: &str, response: Response) -> io::Result<()> {
        let body = serde_json::to_vec(&Reply {
            protocol: PROTOCOL,
            request_id,
            response,
        })?;
        if body.is_empty() || body.len() > FRAME_LIMIT || self.output.len() >= 32 {
            return Err(invalid());
        }
        let mut frame = Vec::with_capacity(body.len() + 4);
        frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
        frame.extend_from_slice(&body);
        self.output.push_back(frame);
        Ok(())
    }
    fn flush(&mut self) -> io::Result<()> {
        while let Some(frame) = self.output.front() {
            match self.socket.write(&frame[self.output_offset..]) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "git bridge closed",
                    ));
                }
                Ok(n) => {
                    self.output_offset += n;
                    if self.output_offset == frame.len() {
                        self.output.pop_front();
                        self.output_offset = 0;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

const HOOK_NAMES: [&str; 22] = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-auto-gc",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-rebase",
    "post-rewrite",
    "reference-transaction",
    "post-index-change",
    "push-to-checkout",
    "proc-receive",
    "update",
    "pre-receive",
    "post-receive",
    "post-update",
];

/// Every field is supplied by the authenticated producer, not the socket.
pub(crate) struct GitHookRuntime<'a> {
    pub host: &'a ProgramImage,
    pub node: &'a ProgramImage,
    pub lifecycle: &'a ProgramImage,
    pub client: &'a ProgramImage,
    pub launcher: &'a ProgramImage,
    pub formatter_bootstrap: &'a ProgramImage,
    pub scratch_root: &'a Path,
    pub homes: &'a RuntimeHomes,
    pub trusted: &'a TrustedInvocation,
    pub sandbox_state_json: &'a str,
    pub agent_surface: &'a str,
}

fn safe_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn relative(value: &str) -> bool {
    safe_text(value)
        && !value.contains('\\')
        && value.split('/').all(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && !s.eq_ignore_ascii_case(".git")
                && s != ".caws"
        })
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
fn physical_dir(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || !safe_text(path.to_str().ok_or_else(invalid)?)
        || fs::canonicalize(path)? != path
        || !fs::symlink_metadata(path)?.is_dir()
    {
        return Err(invalid());
    }
    Ok(())
}
fn random_id() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn decimal(value: &str) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}
fn image(image: &ProgramImage, deadline: &GitHookJobDeadline) -> io::Result<()> {
    image_valid(image, &|| deadline.check().map_err(|_| Refusal::Expired)).map_err(|_| invalid())
}
fn hook_valid(hook: &HookImage, expected: &Path, deadline: &GitHookJobDeadline) -> io::Result<()> {
    if Path::new(&hook.path) != expected || !hex(&hook.sha256, 64) {
        return Err(invalid());
    }
    let m = fs::symlink_metadata(expected)?;
    if !m.is_file()
        || decimal(&hook.dev) != Some(m.dev())
        || decimal(&hook.ino) != Some(m.ino())
        || decimal(&hook.mode) != Some(u64::from(m.mode()))
    {
        return Err(invalid());
    }
    image(
        &ProgramImage {
            path: hook.path.clone(),
            sha256: hook.sha256.clone(),
        },
        deadline,
    )
}
fn git_admin(cwd: &Path) -> io::Result<PathBuf> {
    let dotgit = cwd.join(".git");
    let meta = fs::symlink_metadata(&dotgit)?;
    let dir = if meta.is_dir() {
        fs::canonicalize(&dotgit)?
    } else if meta.is_file() {
        let bytes = fs::read(&dotgit)?;
        if bytes.len() > 4096 {
            return Err(invalid());
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| invalid())?
            .trim_end_matches('\n');
        let target = text
            .strip_prefix("gitdir: ")
            .filter(|v| safe_text(v))
            .ok_or_else(invalid)?;
        fs::canonicalize(cwd.join(target))?
    } else {
        return Err(invalid());
    };
    Ok(dir)
}
fn git_common(cwd: &Path) -> io::Result<PathBuf> {
    let dir = git_admin(cwd)?;
    let common_file = dir.join("commondir");
    match fs::read(&common_file) {
        Ok(bytes) => {
            if bytes.len() > 4096 {
                return Err(invalid());
            }
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| invalid())?
                .trim_end_matches('\n');
            if !safe_text(text) {
                return Err(invalid());
            }
            fs::canonicalize(dir.join(text))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(dir),
        Err(e) => Err(e),
    }
}
fn validate_git_paths(env: &BTreeMap<String, String>, cwd: &Path) -> io::Result<()> {
    let admin = git_admin(cwd)?;
    let common = git_common(cwd)?;
    for (key, expected) in [
        ("GIT_DIR", &admin),
        ("GIT_COMMON_DIR", &common),
        ("GIT_WORK_TREE", &cwd.to_path_buf()),
        ("GIT_OBJECT_DIRECTORY", &common.join("objects")),
    ] {
        if let Some(value) = env.get(key) {
            if value.is_empty() || fs::canonicalize(cwd.join(value))? != *expected {
                return Err(invalid());
            }
        }
    }
    if let Some(index) = env.get("GIT_INDEX_FILE") {
        let path = cwd.join(index);
        let parent = path.parent().ok_or_else(invalid)?;
        let parent = fs::canonicalize(parent)?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(invalid)?;
        let next = name
            .strip_prefix("next-index-")
            .map(|s| s.strip_suffix(".lock").unwrap_or(s))
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        if parent != admin || (name != "index" && name != "index.lock" && !next) {
            return Err(invalid());
        }
    }
    Ok(())
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn callback_environment(
    mut env: BTreeMap<String, String>,
    shim: &Path,
) -> io::Result<BTreeMap<String, String>> {
    const PUBLIC: &[&str] = &[
        "PATH",
        "LC_ALL",
        "PWD",
        "HOME",
        "TMPDIR",
        "CAWS_HOME",
        "CODEX_HOME",
        "CODEX_THREAD_ID",
        "CAWS_AGENT_SURFACE",
        "CAWS_PROJECT_DIR",
    ];
    const GIT: &[&str] = &[
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_PREFIX",
        "GIT_INTERNAL_SUPER_PREFIX",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_SHALLOW_FILE",
        "GIT_GRAFT_FILE",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_REPLACE_REF_BASE",
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_AUTHOR_DATE",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
        "GIT_COMMITTER_DATE",
        "GIT_EDITOR",
        "GIT_REFLOG_ACTION",
        "GIT_EXEC_PATH",
        "GIT_OPTIONAL_LOCKS",
        "GIT_LITERAL_PATHSPECS",
    ];
    if env.len() > 128 || env.values().any(|v| v.len() > 65536 || v.contains('\0')) {
        return Err(invalid());
    }
    let count = env
        .remove("GIT_CONFIG_COUNT")
        .ok_or_else(invalid)?
        .parse::<usize>()
        .map_err(|_| invalid())?;
    // Upstream runtime injects exactly these three. Foreign config entries need
    // independent admission; they cannot ride this capability implicitly.
    if count != 3 {
        return Err(invalid());
    }
    let mut entries = Vec::new();
    for n in 0..count {
        entries.push((
            env.remove(&format!("GIT_CONFIG_KEY_{n}"))
                .ok_or_else(invalid)?,
            env.remove(&format!("GIT_CONFIG_VALUE_{n}"))
                .ok_or_else(invalid)?,
        ));
    }
    if entries[0].0 != "core.hooksPath"
        || Path::new(&entries[0].1) != shim
        || entries[1] != ("maintenance.auto".into(), "false".into())
        || entries[2] != ("gc.auto".into(), "0".into())
    {
        return Err(invalid());
    }
    for key in env.keys() {
        if !PUBLIC.contains(&key.as_str()) && !GIT.contains(&key.as_str()) {
            return Err(invalid());
        }
    }
    for key in PUBLIC {
        env.remove(*key);
    }
    env.insert("GIT_CONFIG_COUNT".into(), "2".into());
    for (i, (key, value)) in entries.into_iter().skip(1).enumerate() {
        env.insert(format!("GIT_CONFIG_KEY_{i}"), key);
        env.insert(format!("GIT_CONFIG_VALUE_{i}"), value);
    }
    Ok(env)
}

struct ConfiguredRoot {
    root: Root,
    shim_directory: PathBuf,
}
#[derive(Clone)]
struct Context {
    root_index: usize,
    hook: String,
    args: Vec<String>,
    git_environment: BTreeMap<String, String>,
    stdin_base64: String,
    transaction_root: PathBuf,
    executed: bool,
    hook_failed: bool,
}

struct HookCustody {
    child: Child,
    _launch: PrivateLaunch,
    _pump: ManifestPump,
}
struct FormatterCustody {
    writer: hook_formatter::RetainedFormatter,
    deadline: MonotonicDeadline,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormatRequest {
    schema: String,
    nonce: String,
    sequence: u64,
    kind: String,
    paths: Vec<String>,
    all_paths: Vec<String>,
}

pub(crate) struct GitHookBridge<'a> {
    runtime: GitHookRuntime<'a>,
    wire: Wire,
    roots: Vec<ConfiguredRoot>,
    contexts: BTreeMap<String, Context>,
    configured: bool,
    failed: bool,
    ever_spawn_may_have_occurred: bool,
    retained: Option<FormatterCustody>,
    retained_hook: Option<HookCustody>,
    verdict_requested: bool,
    closed: bool,
}
impl<'a> GitHookBridge<'a> {
    pub(crate) fn new(runtime: GitHookRuntime<'a>, socket: UnixStream) -> io::Result<Self> {
        if !runtime.trusted.same_host_macos_verified
            || !runtime.homes.well_formed()
            || !safe_text(runtime.agent_surface)
            || runtime.sandbox_state_json.is_empty()
            || runtime.sandbox_state_json.contains('\0')
        {
            return Err(invalid());
        }
        let parent = Path::new(&runtime.lifecycle.path)
            .parent()
            .ok_or_else(invalid)?;
        for (entry, name) in [
            (runtime.client, "git-hook-client-main.js"),
            (runtime.launcher, "git-hook-launcher-main.js"),
            (runtime.formatter_bootstrap, "git-hook-formatter-main.js"),
        ] {
            if Path::new(&entry.path) != parent.join(name) {
                return Err(invalid());
            }
        }
        physical_dir(runtime.scratch_root)?;
        let m = fs::metadata(runtime.scratch_root)?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7777 != 0o700 {
            return Err(invalid());
        }
        Ok(Self {
            runtime,
            wire: Wire::new(socket)?,
            roots: Vec::new(),
            contexts: BTreeMap::new(),
            configured: false,
            failed: false,
            ever_spawn_may_have_occurred: false,
            retained: None,
            retained_hook: None,
            verdict_requested: false,
            closed: false,
        })
    }
    pub(crate) fn has_live_custody(&self) -> bool {
        self.retained.is_some() || self.retained_hook.is_some()
    }
    pub(crate) fn is_cleanly_closed(&self) -> bool {
        self.closed
    }
    pub(crate) fn verdict_requested(&self) -> bool {
        self.verdict_requested
    }
    pub(crate) fn succeeded(&self) -> bool {
        self.closed && !self.failed && self.contexts.is_empty() && !self.has_live_custody()
    }

    fn check_runtime(&self, deadline: &GitHookJobDeadline) -> io::Result<()> {
        let live = || deadline.check().map_err(|_| Refusal::Expired);
        self.runtime.homes.validate(&live).map_err(|_| invalid())?;
        for entry in [
            self.runtime.host,
            self.runtime.node,
            self.runtime.lifecycle,
            self.runtime.client,
            self.runtime.launcher,
            self.runtime.formatter_bootstrap,
        ] {
            image(entry, deadline)?;
        }
        Ok(())
    }
    fn check_root(&self, root: &Root, deadline: &GitHookJobDeadline) -> io::Result<()> {
        let cwd = Path::new(&root.cwd);
        physical_dir(cwd)?;
        let trusted = Path::new(&self.runtime.trusted.project_root);
        physical_dir(trusted)?;
        if cwd == Path::new("/")
            || git_common(cwd)? != git_common(trusted)?
            || self.runtime.scratch_root.starts_with(cwd)
            || cwd.starts_with(self.runtime.scratch_root)
        {
            return Err(invalid());
        }
        let dir = Path::new(&root.hooks_directory);
        let null_hooks = dir == Path::new("/dev/null");
        if null_hooks {
            use std::os::unix::fs::FileTypeExt;
            let named = fs::symlink_metadata(dir)?;
            let opened = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(dir)?
                .metadata()?;
            if fs::canonicalize(dir)? != dir
                || !named.file_type().is_char_device()
                || named.uid() != 0
                || named.rdev() == 0
                || named.dev() != opened.dev()
                || named.ino() != opened.ino()
                || named.rdev() != opened.rdev()
                || root.hooks.values().any(Option::is_some)
            {
                return Err(invalid());
            }
        } else {
            physical_dir(dir)?;
        }
        if root.hooks.len() != HOOK_NAMES.len()
            || root.authorized_paths.len() > 256
            || root.read_only_paths.len() > 256
        {
            return Err(invalid());
        }
        let mut paths = BTreeSet::new();
        for path in &root.authorized_paths {
            if !relative(path) || !paths.insert(path) {
                return Err(invalid());
            }
        }
        for path in &root.read_only_paths {
            let p = Path::new(path);
            if !p.is_absolute() || fs::canonicalize(p)? != p {
                return Err(invalid());
            }
        }
        for name in HOOK_NAMES {
            if null_hooks {
                if !matches!(root.hooks.get(name), Some(None)) {
                    return Err(invalid());
                }
                continue;
            }
            let expected = dir.join(name);
            match root.hooks.get(name).ok_or_else(invalid)? {
                Some(hook) => hook_valid(hook, &expected, deadline)?,
                None => match fs::symlink_metadata(expected) {
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    _ => return Err(invalid()),
                },
            }
        }
        for entry in [&root.formatters.eslint, &root.formatters.prettier]
            .into_iter()
            .flatten()
        {
            let p = Path::new(&entry.path);
            if !p.is_absolute() || !hex(&entry.sha256, 64) {
                return Err(invalid());
            }
            image(
                &ProgramImage {
                    path: entry.path.clone(),
                    sha256: entry.sha256.clone(),
                },
                deadline,
            )?;
        }
        Ok(())
    }
    fn make_directory(&self, prefix: &str) -> io::Result<PathBuf> {
        let path = self
            .runtime
            .scratch_root
            .join(format!("{prefix}-{}", random_id()?));
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(path)
    }
    fn configure(
        &mut self,
        roots: Vec<Root>,
        fence: &ExecutionFence,
        deadline: &GitHookJobDeadline,
    ) -> io::Result<Value> {
        if self.configured || roots.is_empty() || roots.len() > 2 {
            return Err(invalid());
        }
        fence.validate()?;
        self.check_runtime(deadline)?;
        let mut seen = BTreeSet::new();
        for root in &roots {
            if !seen.insert(root.cwd.clone()) {
                return Err(invalid());
            }
            self.check_root(root, deadline)?;
        }
        let mut result = Vec::new();
        for root in roots {
            let directory = self.make_directory("caws-hook-shims")?;
            for name in HOOK_NAMES {
                if root.hooks[name]
                    .as_ref()
                    .is_some_and(|h| decimal(&h.mode).is_some_and(|m| m & 0o111 != 0))
                {
                    let script = format!(
                        "#!/bin/sh\nexec {} {} --hook {} -- \"$@\"\n",
                        shell_quote(&self.runtime.node.path),
                        shell_quote(&self.runtime.client.path),
                        shell_quote(name)
                    );
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o700)
                        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                        .open(directory.join(name))?;
                    file.write_all(script.as_bytes())?;
                    file.sync_all()?;
                }
            }
            result.push(json!({"cwd":root.cwd,"shimDirectory":directory}));
            self.roots.push(ConfiguredRoot {
                root,
                shim_directory: directory,
            });
        }
        self.configured = true;
        Ok(json!({"shimDirectories":result}))
    }
    fn open(
        &mut self,
        cwd: String,
        hook: String,
        args: Vec<String>,
        git_environment: BTreeMap<String, String>,
        stdin_base64: String,
        fence: &ExecutionFence,
        deadline: &GitHookJobDeadline,
    ) -> io::Result<Value> {
        if !self.configured
            || self.contexts.len() >= 128
            || args.len() > 64
            || args.iter().any(|v| v.len() > 65536 || v.contains('\0'))
            || !HOOK_NAMES.contains(&hook.as_str())
        {
            return Err(invalid());
        }
        let stdin = STANDARD.decode(&stdin_base64).map_err(|_| invalid())?;
        if stdin.len() > 1024 * 1024 || STANDARD.encode(&stdin) != stdin_base64 {
            return Err(invalid());
        }
        let index = self
            .roots
            .iter()
            .position(|r| r.root.cwd == cwd)
            .ok_or_else(invalid)?;
        if self.roots[index]
            .root
            .hooks
            .get(&hook)
            .and_then(Option::as_ref)
            .is_none_or(|h| decimal(&h.mode).is_none_or(|m| m & 0o111 == 0))
        {
            return Err(invalid());
        }
        fence.validate()?;
        self.check_runtime(deadline)?;
        self.check_root(&self.roots[index].root, deadline)?;
        let git_environment =
            callback_environment(git_environment, &self.roots[index].shim_directory)?;
        validate_git_paths(&git_environment, Path::new(&cwd))?;
        let transaction_root = self.make_directory("caws-hook-transaction")?;
        let context_id = random_id()?;
        if self.contexts.contains_key(&context_id) {
            return Err(invalid());
        }
        let data = json!({"contextId":context_id,"projectRoot":cwd,"transactionRoot":transaction_root,"authorizedPaths":self.roots[index].root.authorized_paths,"gitEnvironment":git_environment});
        self.contexts.insert(
            context_id,
            Context {
                root_index: index,
                hook,
                args,
                git_environment,
                stdin_base64,
                transaction_root,
                executed: false,
                hook_failed: false,
            },
        );
        Ok(data)
    }

    fn format_request(
        &mut self,
        context_id: &str,
        root: &Root,
        transaction: &Path,
        line: &[u8],
        expected_sequence: u64,
        fence: &mut Option<ExecutionFence>,
        job: &GitHookJobDeadline,
        control: &EffectCheck<'_>,
    ) -> io::Result<()> {
        let payload = line
            .strip_prefix(b"CAWS_FORMATTER_REQUEST_V1 ")
            .ok_or_else(invalid)?;
        let decoded = STANDARD.decode(payload).map_err(|_| invalid())?;
        if STANDARD.encode(&decoded).as_bytes() != payload || decoded.len() > 65536 {
            return Err(invalid());
        }
        let request: FormatRequest = serde_json::from_slice(&decoded).map_err(|_| invalid())?;
        if request.schema != "caws.git-hook.format-request.v1"
            || request.nonce != context_id
            || request.sequence != expected_sequence
            || request.paths.is_empty()
            || request.paths.len() > 256
            || request.all_paths.len() > 256
        {
            return Err(invalid());
        }
        let allowed: BTreeSet<_> = root.authorized_paths.iter().map(String::as_str).collect();
        let mut all = BTreeSet::new();
        for path in &request.all_paths {
            if !relative(path) || !allowed.contains(path.as_str()) || !all.insert(path.as_str()) {
                return Err(invalid());
            }
            let physical = Path::new(&root.cwd).join(path);
            let metadata = fs::symlink_metadata(&physical)?;
            if fs::canonicalize(&physical)? != physical
                || !metadata.is_file()
                || metadata.nlink() != 1
            {
                return Err(invalid());
            }
            for protected in &root.read_only_paths {
                let protected = Path::new(protected);
                if physical.starts_with(protected) || protected.starts_with(&physical) {
                    return Err(invalid());
                }
            }
        }
        let mut selected = BTreeSet::new();
        for path in &request.paths {
            if !relative(path) || !all.contains(path.as_str()) || !selected.insert(path.as_str()) {
                return Err(invalid());
            }
        }
        let (kind, entry) = match request.kind.as_str() {
            "eslint" => (
                hook_formatter::FormatterKind::Eslint,
                root.formatters.eslint.as_ref(),
            ),
            "prettier" => (
                hook_formatter::FormatterKind::Prettier,
                root.formatters.prettier.as_ref(),
            ),
            _ => return Err(invalid()),
        };
        let entry = entry.ok_or_else(invalid)?;
        let entry = ProgramImage {
            path: entry.path.clone(),
            sha256: entry.sha256.clone(),
        };
        let source_root = Path::new(&root.cwd);
        let files: Vec<PathBuf> = request.paths.iter().map(|p| source_root.join(p)).collect();
        let readonly: Vec<PathBuf> = root.read_only_paths.iter().map(PathBuf::from).collect();
        self.check_runtime(job)?;
        self.check_root(root, job)?;
        let preparation = nested_deadline(job)?;
        let formatter = hook_formatter::FormatterRuntime {
            host: self.runtime.host,
            node: self.runtime.node,
            bootstrap: self.runtime.formatter_bootstrap,
            entry: &entry,
            sandbox_state_json: self.runtime.sandbox_state_json,
            scratch_root: self.runtime.scratch_root,
            homes: self.runtime.homes,
            session_id: &self.runtime.trusted.session_id,
            thread_id: &self.runtime.trusted.thread_id,
            call_id: &self.runtime.trusted.call_id,
            agent_surface: self.runtime.agent_surface,
        };
        let arguments = hook_formatter::FormatterRequest {
            kind,
            source_root,
            source_files: &files,
            read_only_paths: &readonly,
        };
        let held = fence.take().ok_or_else(invalid)?;
        let bounded_control = |stage| {
            job.check().map_err(|_| "job expired".to_owned())?;
            control(stage)
        };
        let outcome = hook_formatter::run_formatter(
            &formatter,
            &arguments,
            held,
            &preparation,
            &bounded_control,
        );
        let (exit_code, stdout, stderr) = match outcome {
            hook_formatter::FormatterOutcome::Refused { fence: held, .. } => {
                *fence = Some(held);
                return Err(invalid());
            }
            hook_formatter::FormatterOutcome::Retained { custody, .. } => {
                self.retained = Some(FormatterCustody {
                    writer: custody,
                    deadline: preparation,
                });
                return Err(invalid());
            }
            hook_formatter::FormatterOutcome::Settled {
                fence: held,
                status,
                gate_may_have_opened,
                refused,
                stdout,
                stderr,
            } => {
                *fence = Some(held);
                if refused || !gate_may_have_opened {
                    return Err(invalid());
                }
                (status_code(status), stdout, stderr)
            }
        };
        let body = serde_json::to_vec(
            &json!({"schema":"caws.git-hook.format-reply.v1","nonce":context_id,"sequence":expected_sequence,"exitCode":exit_code,"stdoutBase64":STANDARD.encode(stdout),"stderrBase64":STANDARD.encode(stderr)}),
        )?;
        let temp = transaction.join(format!("format-{context_id}-{expected_sequence}.pending"));
        let target = transaction.join(format!("format-{context_id}-{expected_sequence}.json"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)?;
        file.write_all(&body)?;
        file.sync_all()?;
        fs::hard_link(&temp, &target)?;
        fs::remove_file(temp)?;
        Ok(())
    }

    fn execute(
        &mut self,
        context_id: &str,
        seed_index_path: &str,
        seed_index_sha256: &str,
        object_directory: &str,
        fence: &mut Option<ExecutionFence>,
        job: &GitHookJobDeadline,
        control: &EffectCheck<'_>,
    ) -> Result<Value, (io::Error, bool)> {
        let mut spawned = false;
        let result = (|| -> io::Result<Value> {
            if !hex(context_id, 64) || !hex(seed_index_sha256, 64) || self.has_live_custody() {
                return Err(invalid());
            }
            let context = self.contexts.get(context_id).cloned().ok_or_else(invalid)?;
            if context.executed {
                return Err(invalid());
            }
            let root = self.roots[context.root_index].root.clone();
            fence.as_ref().ok_or_else(invalid)?.validate()?;
            self.check_runtime(job)?;
            self.check_root(&root, job)?;
            control("git_hook_prepare").map_err(|_| invalid())?;
            let seed = Path::new(seed_index_path);
            if seed.parent() != Some(context.transaction_root.as_path())
                || fs::canonicalize(seed)? != seed
            {
                return Err(invalid());
            }
            let metadata = fs::symlink_metadata(seed)?;
            if !metadata.is_file()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.nlink() != 1
                || metadata.mode() & 0o222 != 0
                || metadata.len() > 32 * 1024 * 1024
            {
                return Err(invalid());
            }
            image(
                &ProgramImage {
                    path: seed_index_path.to_owned(),
                    sha256: seed_index_sha256.to_owned(),
                },
                job,
            )?;
            let objects = Path::new(object_directory);
            physical_dir(objects)?;
            if fs::canonicalize(git_common(Path::new(&root.cwd))?.join("objects"))? != objects {
                return Err(invalid());
            }
            let mut launch = PrivateLaunch::create(
                self.runtime.scratch_root,
                Path::new(&root.cwd),
                &self.runtime.trusted.session_id,
                &self.runtime.trusted.thread_id,
                &self.runtime.trusted.call_id,
                self.runtime.sandbox_state_json,
            )?;
            let remaining = job
                .expires()
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(30_000) as u64;
            if remaining == 0 {
                return Err(invalid());
            }
            let hook = root
                .hooks
                .get(&context.hook)
                .and_then(Option::as_ref)
                .ok_or_else(invalid)?;
            let descriptor = json!({"schema":"caws.execution.git-hook-launcher.v1","hook":{"path":hook.path,"sha256":hook.sha256},"args":context.args,"cwd":root.cwd,"seedIndex":{"path":seed_index_path,"sha256":seed_index_sha256},"objectDirectory":object_directory,"outputRoot":launch.output_root,"tmpRoot":launch.tmp_root,"cacheRoot":launch.cache_root,"channel":{"schema":"caws.git-hook.format-channel.v1","nonce":context_id,"replyRoot":context.transaction_root,"timeoutMs":remaining},"stdinBase64":context.stdin_base64});
            let descriptor_bytes = serde_json::to_vec(&descriptor)?;
            if descriptor_bytes.len() > FRAME_LIMIT {
                return Err(invalid());
            }
            let descriptor_path = context
                .transaction_root
                .join(format!("descriptor-{context_id}.json"));
            let mut descriptor_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o400)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&descriptor_path)?;
            descriptor_file.write_all(&descriptor_bytes)?;
            descriptor_file.sync_all()?;
            let descriptor_hash = format!("{:x}", Sha256::digest(&descriptor_bytes));
            let argv = vec![
                self.runtime.node.path.clone(),
                self.runtime.launcher.path.clone(),
                "--descriptor".into(),
                descriptor_path.to_str().ok_or_else(invalid)?.to_owned(),
                "--sha256".into(),
                descriptor_hash,
            ];
            let mut env = context.git_environment.clone();
            let node_dir = Path::new(&self.runtime.node.path)
                .parent()
                .and_then(Path::to_str)
                .filter(|s| safe_text(s) && !s.contains(':'))
                .ok_or_else(invalid)?;
            for (key, value) in [
                ("PATH", format!("{node_dir}:/usr/bin:/bin")),
                ("LC_ALL", "C".into()),
                ("PWD", root.cwd.clone()),
                (
                    "TMPDIR",
                    launch.tmp_root.to_str().ok_or_else(invalid)?.into(),
                ),
                ("HOME", self.runtime.homes.home.clone()),
                ("CAWS_HOME", self.runtime.homes.caws_home.clone()),
                ("CODEX_HOME", self.runtime.homes.codex_home.clone()),
                ("CODEX_THREAD_ID", self.runtime.trusted.thread_id.clone()),
                ("CAWS_AGENT_SURFACE", self.runtime.agent_surface.into()),
                ("CAWS_PROJECT_DIR", root.cwd.clone()),
            ] {
                env.insert(key.into(), value);
            }
            let entries: Vec<Value> = env
                .iter()
                .map(|(name, value)| json!({"name":name,"value":value}))
                .collect();
            let execution: crate::execution_prepared::Execution = serde_json::from_value(
                json!({"executable":{"path":self.runtime.node.path,"sha256":self.runtime.node.sha256},"argv":argv,"cwd":root.cwd,"environment":entries,"stdinBase64":""}),
            )?;
            let preparation = nested_deadline(job)?;
            launch.bind_execution(&execution, &preparation)?;
            launch.verify_execution(&execution, &preparation)?;
            let (reader, mut pump) = ManifestPump::new(&launch.manifest)?;
            let mut command = Command::new(&self.runtime.host.path);
            command
                .arg("sandbox")
                .arg("--sandbox-state-json")
                .arg(self.runtime.sandbox_state_json)
                .arg("--sandbox-state-write-ceiling-json")
                .arg(&launch.ceiling_json)
                .arg("--sandbox-state-write-ceiling-manifest-fd")
                .arg(MANIFEST_FD.to_string())
                .arg("--")
                .args(&execution.argv)
                .current_dir("/")
                .env_clear()
                .envs(&env)
                .env("CODEX_SANDBOX", "seatbelt")
                .env("CODEX_SANDBOX_NETWORK_DISABLED", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            configure_private_child(&mut command)?;
            let mut mappings = vec![(reader.as_fd(), MANIFEST_FD)];
            for (file, target) in launch.handles().iter().zip(ROLE_FDS) {
                mappings.push((file.as_fd(), target));
            }
            configure_child_fds(&mut command, &mappings)?;
            let envelope = preparation.envelope();
            unsafe {
                command.pre_exec(move || {
                    monotonic_deadline::check_before_exec(envelope)
                        .map_err(io::Error::from_raw_os_error)
                });
            }
            self.check_runtime(job)?;
            self.check_root(&root, job)?;
            fence.as_ref().ok_or_else(invalid)?.validate()?;
            let final_seed = fs::symlink_metadata(seed)?;
            if final_seed.dev() != metadata.dev()
                || final_seed.ino() != metadata.ino()
                || final_seed.mode() != metadata.mode()
                || final_seed.nlink() != metadata.nlink()
                || final_seed.len() != metadata.len()
            {
                return Err(invalid());
            }
            image(
                &ProgramImage {
                    path: seed_index_path.to_owned(),
                    sha256: seed_index_sha256.to_owned(),
                },
                job,
            )?;
            launch.verify_execution(&execution, &preparation)?;
            job.check().map_err(|_| invalid())?;
            control("git_hook_spawn").map_err(|_| invalid())?;
            self.contexts
                .get_mut(context_id)
                .ok_or_else(invalid)?
                .executed = true;
            spawned = true;
            self.ever_spawn_may_have_occurred = true;
            let mut child = command.spawn()?;
            let setup = (|| -> io::Result<()> {
                nonblocking(child.stdout.as_ref().ok_or_else(invalid)?.as_raw_fd())?;
                nonblocking(child.stderr.as_ref().ok_or_else(invalid)?.as_raw_fd())?;
                Ok(())
            })();
            if let Err(error) = setup {
                let _ = child.kill();
                self.retained_hook = Some(HookCustody {
                    child,
                    _launch: launch,
                    _pump: pump,
                });
                return Err(error);
            }
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut pending = Vec::new();
            let mut sequence = 0u64;
            let serviced = (|| -> io::Result<std::process::ExitStatus> {
                loop {
                    job.check().map_err(|_| invalid())?;
                    control("git_hook_wait").map_err(|_| invalid())?;
                    pump.pump()?;
                    drain_pipe(&mut child.stdout, &mut pending)?;
                    drain_pipe(&mut child.stderr, &mut stderr)?;
                    let status = child.try_wait()?;
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        if line.starts_with(b"CAWS_FORMATTER_REQUEST_V1 ") {
                            if status.is_some() {
                                return Err(invalid());
                            }
                            self.format_request(
                                context_id,
                                &root,
                                &context.transaction_root,
                                &line[..line.len() - 1],
                                sequence,
                                fence,
                                job,
                                control,
                            )?;
                            sequence = sequence.checked_add(1).ok_or_else(invalid)?;
                        } else {
                            append_bounded(&mut stdout, &line)?;
                        }
                    }
                    if let Some(status) = status {
                        append_bounded(&mut stdout, &pending)?;
                        return Ok(status);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            })();
            match serviced {
                Ok(status) => {
                    let code = status_code(status);
                    if code != 0 {
                        self.contexts
                            .get_mut(context_id)
                            .ok_or_else(invalid)?
                            .hook_failed = true;
                        self.failed = true;
                    }
                    if stdout.len().saturating_add(stderr.len()) > (FRAME_LIMIT - 4096) * 3 / 4 {
                        return Err(invalid());
                    }
                    Ok(
                        json!({"exitCode":code,"stdoutBase64":STANDARD.encode(stdout),"stderrBase64":STANDARD.encode(stderr),"privateIndexPath":launch.output_root.join("transaction/index"),"privateObjectDirectory":launch.output_root.join("transaction/objects")}),
                    )
                }
                Err(error) => {
                    let _ = child.kill();
                    self.retained_hook = Some(HookCustody {
                        child,
                        _launch: launch,
                        _pump: pump,
                    });
                    Err(error)
                }
            }
        })();
        result.map_err(|error| (error, spawned))
    }

    /// Service queued frames without blocking on socket I/O. Hook execution is
    /// bounded by the original job deadline and polls `control` while it runs.
    pub(crate) fn pump(
        &mut self,
        fence: &mut Option<ExecutionFence>,
        job: &GitHookJobDeadline,
        control: &EffectCheck<'_>,
    ) -> io::Result<()> {
        if self.has_live_custody() {
            return Err(invalid());
        }
        if self.closed {
            return Ok(());
        }
        let requests = self.wire.read()?;
        for envelope in requests {
            let mut spawned = false;
            let result: io::Result<Value> = (|| {
                if self.verdict_requested {
                    return Err(invalid());
                }
                job.check().map_err(|_| invalid())?;
                control("git_bridge_request").map_err(|_| invalid())?;
                match envelope.request {
                    Request::Configure { roots } => {
                        self.configure(roots, fence.as_ref().ok_or_else(invalid)?, job)
                    }
                    Request::Open {
                        cwd,
                        hook,
                        args,
                        git_environment,
                        stdin_base64,
                    } => self.open(
                        cwd,
                        hook,
                        args,
                        git_environment,
                        stdin_base64,
                        fence.as_ref().ok_or_else(invalid)?,
                        job,
                    ),
                    Request::Execute {
                        context_id,
                        seed_index_path,
                        seed_index_sha256,
                        object_directory,
                    } => {
                        match self.execute(
                            &context_id,
                            &seed_index_path,
                            &seed_index_sha256,
                            &object_directory,
                            fence,
                            job,
                            control,
                        ) {
                            Ok(value) => Ok(value),
                            Err((error, possible)) => {
                                spawned = possible;
                                Err(error)
                            }
                        }
                    }
                    Request::Assert { context_id } => {
                        let context = self.contexts.get(&context_id).ok_or_else(invalid)?;
                        fence.as_ref().ok_or_else(invalid)?.validate()?;
                        self.check_runtime(job)?;
                        self.check_root(&self.roots[context.root_index].root, job)?;
                        control("git_bridge_assert").map_err(|_| invalid())?;
                        Ok(json!({}))
                    }
                    Request::Finish {
                        context_id,
                        exit_code,
                        publication,
                    } => {
                        if !(0..=255).contains(&exit_code) {
                            return Err(invalid());
                        }
                        fence.as_ref().ok_or_else(invalid)?.validate()?;
                        let root_index = self
                            .contexts
                            .get(&context_id)
                            .ok_or_else(invalid)?
                            .root_index;
                        self.check_runtime(job)?;
                        self.check_root(&self.roots[root_index].root, job)?;
                        let context = self.contexts.remove(&context_id).ok_or_else(invalid)?;
                        // Publication is reported for provenance; it does not
                        // confer authority or turn a hook failure into success.
                        if exit_code != 0
                            || context.hook_failed
                            || !context.executed
                            || !matches!(publication, Publication::IndexPublished)
                        {
                            self.failed = true;
                        }
                        Ok(json!({}))
                    }
                    Request::Verdict {} => {
                        fence.as_ref().ok_or_else(invalid)?.validate()?;
                        self.check_runtime(job)?;
                        self.verdict_requested = true;
                        Ok(
                            json!({"failed":self.failed || !self.contexts.is_empty() || self.has_live_custody()}),
                        )
                    }
                }
            })();
            let response = match result {
                Ok(Value::Object(data)) => Response::Ok { data },
                _ => {
                    self.failed = true;
                    Response::Refused {
                        reason: "git_bridge_refused",
                        user_spawn_may_have_occurred: spawned || self.ever_spawn_may_have_occurred,
                    }
                }
            };
            self.wire.reply(&envelope.request_id, response)?;
        }
        self.wire.flush()?;
        if self.wire.eof {
            if !self.verdict_requested || !self.contexts.is_empty() || self.has_live_custody() {
                self.failed = true;
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unexpected git bridge closure",
                ));
            }
            if self.wire.output.is_empty() {
                self.closed = true;
            }
        }
        Ok(())
    }

    /// On uncertainty the owner must keep this worker alive and poll until
    /// the actual writer and its supervisor settle. A lockfile alone is not
    /// live custody. This never reopens a formatter's GO gate.
    pub(crate) fn poll_custody(
        &mut self,
        fence: &mut Option<ExecutionFence>,
        job: &GitHookJobDeadline,
        control: &EffectCheck<'_>,
    ) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(mut retained) = self.retained.take() {
            if fence.is_some() {
                self.retained = Some(retained);
                return Err(invalid());
            }
            match retained.writer.poll(&retained.deadline, control) {
                Ok(Some((_status, _gate, _refused, _out, _err, held))) => {
                    *fence = Some(held);
                }
                Ok(None) | Err(_) => self.retained = Some(retained),
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (&fence, job, control);
        if let Some(custody) = self.retained_hook.as_mut() {
            if custody.child.try_wait()?.is_some() {
                self.retained_hook = None;
            }
        }
        Ok(())
    }
}

fn nested_deadline(job: &GitHookJobDeadline) -> io::Result<MonotonicDeadline> {
    job.check().map_err(|_| invalid())?;
    let fresh = MonotonicDeadline::capture(Duration::from_secs(30)).map_err(|_| invalid())?;
    let mut envelope = fresh.envelope();
    envelope.expires_ns = envelope.expires_ns.min(job.expires_ns);
    MonotonicDeadline::receive(envelope).map_err(|_| invalid())
}
fn nonblocking(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn append_bounded(target: &mut Vec<u8>, bytes: &[u8]) -> io::Result<()> {
    if target
        .len()
        .checked_add(bytes.len())
        .is_none_or(|n| n > FRAME_LIMIT)
    {
        return Err(invalid());
    }
    target.extend_from_slice(bytes);
    Ok(())
}
fn drain_pipe<R: Read>(pipe: &mut Option<R>, output: &mut Vec<u8>) -> io::Result<()> {
    if let Some(stream) = pipe.as_mut() {
        let mut buf = [0; 8192];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => {
                    *pipe = None;
                    break;
                }
                Ok(n) => append_bounded(output, &buf[..n])?,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}
fn status_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
        .clamp(0, 255)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn envelope(request: &str) -> String {
        format!(
            r#"{{"protocol":"{PROTOCOL}","requestId":"0123456789abcdef0123456789abcdef","request":{request}}}"#
        )
    }
    #[test]
    fn closed_schema_rejects_duplicate_unknown_and_invalid_ids() {
        assert!(parse_frame(envelope(r#"{"operation":"verdict"}"#).as_bytes()).is_ok());
        for request in [
            r#"{"operation":"verdict","extra":1}"#,
            r#"{"operation":"verdict","operation":"verdict"}"#,
            r#"{"operation":"open","cwd":"/p","hook":"pre-commit","args":[],"gitEnvironment":{"a":"1","a":"2"},"stdinBase64":""}"#,
        ] {
            assert!(
                parse_frame(envelope(request).as_bytes()).is_err(),
                "{request}"
            );
        }
        assert!(parse_frame(
            envelope(r#"{"operation":"verdict"}"#)
                .replace("0123456789abcdef0123456789abcdef", "ABC")
                .as_bytes()
        )
        .is_err());
    }
    #[test]
    fn unix_stream_buffers_partial_and_multiple_frames() {
        let (mut peer, socket) = UnixStream::pair().unwrap();
        let mut wire = Wire::new(socket).unwrap();
        let body = envelope(r#"{"operation":"verdict"}"#);
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(body.as_bytes());
        peer.write_all(&frame[..3]).unwrap();
        assert!(wire.read().unwrap().is_empty());
        peer.write_all(&frame[3..]).unwrap();
        peer.write_all(&frame).unwrap();
        assert_eq!(wire.read().unwrap().len(), 2);
        wire.reply(
            "0123456789abcdef0123456789abcdef",
            Response::Ok {
                data: Default::default(),
            },
        )
        .unwrap();
        wire.flush().unwrap();
        let mut size = [0; 4];
        peer.read_exact(&mut size).unwrap();
        let mut reply = vec![0; u32::from_be_bytes(size) as usize];
        peer.read_exact(&mut reply).unwrap();
        let actual: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(
            actual,
            serde_json::json!({"protocol":PROTOCOL,"requestId":"0123456789abcdef0123456789abcdef","response":{"status":"ok","data":{}}})
        );
    }
    #[test]
    fn framing_rejects_oversize_and_truncated_eof() {
        let (mut peer, socket) = UnixStream::pair().unwrap();
        let mut wire = Wire::new(socket).unwrap();
        peer.write_all(&((FRAME_LIMIT as u32) + 1).to_be_bytes())
            .unwrap();
        assert!(wire.read().is_err());
        let (mut peer, socket) = UnixStream::pair().unwrap();
        let mut wire = Wire::new(socket).unwrap();
        peer.write_all(&12u32.to_be_bytes()).unwrap();
        peer.write_all(b"short").unwrap();
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(
            wire.read().err().unwrap().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    fn pinned(path: &Path) -> ProgramImage {
        fs::write(path, b"pinned image").unwrap();
        ProgramImage {
            path: path.to_str().unwrap().into(),
            sha256: format!("{:x}", Sha256::digest(b"pinned image")),
        }
    }
    fn fixture(test: impl FnOnce(GitHookRuntime<'_>, Root, &Path)) {
        let base = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("git-bridge-test-{}", random_id().unwrap()));
        fs::create_dir(&base).unwrap();
        let project = base.join("project");
        let git = project.join(".git");
        let hooks = git.join("hooks");
        let scratch = base.join("scratch");
        let home = base.join("home");
        let generation = base.join("generation");
        for dir in [
            &project,
            &git,
            &hooks,
            &scratch,
            &home,
            &generation,
            &project.join(".caws"),
            &home.join(".caws"),
            &home.join(".codex"),
        ] {
            fs::DirBuilder::new().mode(0o700).create(dir).unwrap();
        }
        let host = pinned(&base.join("host"));
        let node = pinned(&base.join("node"));
        let lifecycle = pinned(&generation.join("lifecycle-main.js"));
        let client = pinned(&generation.join("git-hook-client-main.js"));
        let launcher = pinned(&generation.join("git-hook-launcher-main.js"));
        let formatter = pinned(&generation.join("git-hook-formatter-main.js"));
        let homes = RuntimeHomes {
            home: home.to_str().unwrap().into(),
            caws_home: home.join(".caws").to_str().unwrap().into(),
            codex_home: home.join(".codex").to_str().unwrap().into(),
        };
        let trusted = TrustedInvocation {
            invocation_id: "invocation".into(),
            session_id: "session".into(),
            thread_id: "thread".into(),
            call_id: "call".into(),
            caller_anchor: "caller".into(),
            server_environment_id: "server".into(),
            project_root: project.to_str().unwrap().into(),
            environment_anchor: "environment".into(),
            same_host_macos_verified: true,
        };
        let root = Root {
            cwd: project.to_str().unwrap().into(),
            hooks_directory: hooks.to_str().unwrap().into(),
            authorized_paths: vec![],
            hooks: HOOK_NAMES
                .into_iter()
                .map(|name| (name.into(), None))
                .collect(),
            formatters: Formatters {
                eslint: None,
                prettier: None,
            },
            read_only_paths: vec![],
        };
        let runtime = GitHookRuntime {
            host: &host,
            node: &node,
            lifecycle: &lifecycle,
            client: &client,
            launcher: &launcher,
            formatter_bootstrap: &formatter,
            scratch_root: &scratch,
            homes: &homes,
            trusted: &trusted,
            sandbox_state_json: "{}",
            agent_surface: "codex",
        };
        test(runtime, root, &base);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn catalog_detects_new_hooks_mode_changes_and_image_drift() {
        use std::os::unix::fs::PermissionsExt;
        fixture(|runtime, mut root, _base| {
            let (_peer, socket) = UnixStream::pair().unwrap();
            let bridge = GitHookBridge::new(runtime, socket).unwrap();
            let deadline = GitHookJobDeadline::capture(10_000).unwrap();
            bridge.check_root(&root, &deadline).unwrap();
            let hook_path = Path::new(&root.hooks_directory).join("pre-commit");
            fs::write(&hook_path, b"baseline").unwrap();
            assert!(
                bridge.check_root(&root, &deadline).is_err(),
                "absent hook became present"
            );
            fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o600)).unwrap();
            let meta = fs::metadata(&hook_path).unwrap();
            root.hooks.insert(
                "pre-commit".into(),
                Some(HookImage {
                    path: hook_path.to_str().unwrap().into(),
                    sha256: format!("{:x}", Sha256::digest(b"baseline")),
                    dev: meta.dev().to_string(),
                    ino: meta.ino().to_string(),
                    mode: meta.mode().to_string(),
                }),
            );
            bridge.check_root(&root, &deadline).unwrap();
            fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(
                bridge.check_root(&root, &deadline).is_err(),
                "nonexecuting hook became executable"
            );
            fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o600)).unwrap();
            fs::write(&hook_path, b"changed!").unwrap();
            assert!(
                bridge.check_root(&root, &deadline).is_err(),
                "same-size hook image changed"
            );
            fs::write(&bridge.runtime.client.path, b"changed image").unwrap();
            assert!(
                bridge.check_runtime(&deadline).is_err(),
                "pinned callback client changed"
            );
        });
    }
    #[test]
    fn existing_null_hook_configuration_requires_all_absent() {
        fixture(|runtime, mut root, _base| {
            root.hooks_directory = "/dev/null".into();
            let (_peer, socket) = UnixStream::pair().unwrap();
            let bridge = GitHookBridge::new(runtime, socket).unwrap();
            let deadline = GitHookJobDeadline::capture(10_000).unwrap();
            bridge.check_root(&root, &deadline).unwrap();
            root.hooks.insert(
                "pre-commit".into(),
                Some(HookImage {
                    path: "/dev/null/pre-commit".into(),
                    sha256: "0".repeat(64),
                    dev: "1".into(),
                    ino: "1".into(),
                    mode: "1".into(),
                }),
            );
            assert!(bridge.check_root(&root, &deadline).is_err());
        });
    }
    #[test]
    fn callback_index_never_targets_unrelated_git_metadata() {
        fixture(|_runtime, root, _base| {
            let cwd = Path::new(&root.cwd);
            let mut env = BTreeMap::new();
            for name in [
                "index",
                "index.lock",
                "next-index-123",
                "next-index-123.lock",
            ] {
                env.insert(
                    "GIT_INDEX_FILE".into(),
                    cwd.join(".git").join(name).to_str().unwrap().into(),
                );
                assert!(validate_git_paths(&env, cwd).is_ok(), "{name}");
            }
            for name in ["config", "next-index-evil", "next-index-123.lock.extra"] {
                env.insert(
                    "GIT_INDEX_FILE".into(),
                    cwd.join(".git").join(name).to_str().unwrap().into(),
                );
                assert!(validate_git_paths(&env, cwd).is_err(), "{name}");
            }
        });
    }
    #[test]
    fn callback_environment_removes_only_verified_shim_and_refuses_startup_injection() {
        let mut env = BTreeMap::from([
            ("GIT_CONFIG_COUNT".into(), "3".into()),
            ("GIT_CONFIG_KEY_0".into(), "core.hooksPath".into()),
            ("GIT_CONFIG_VALUE_0".into(), "/shim".into()),
            ("GIT_CONFIG_KEY_1".into(), "maintenance.auto".into()),
            ("GIT_CONFIG_VALUE_1".into(), "false".into()),
            ("GIT_CONFIG_KEY_2".into(), "gc.auto".into()),
            ("GIT_CONFIG_VALUE_2".into(), "0".into()),
            ("HOME".into(), "/untrusted".into()),
            ("GIT_AUTHOR_NAME".into(), "author".into()),
        ]);
        let clean = callback_environment(env.clone(), Path::new("/shim")).unwrap();
        assert_eq!(clean["GIT_CONFIG_COUNT"], "2");
        assert_eq!(clean["GIT_CONFIG_KEY_0"], "maintenance.auto");
        assert_eq!(clean["GIT_AUTHOR_NAME"], "author");
        assert!(!clean.contains_key("HOME"));
        env.insert("NODE_OPTIONS".into(), "--require /tmp/evil".into());
        assert!(callback_environment(env, Path::new("/shim")).is_err());
    }
    #[test]
    fn job_deadline_supports_full_lifecycle_range_without_extending_nested_role() {
        assert!(GitHookJobDeadline::capture(0).is_err());
        assert!(GitHookJobDeadline::capture(86_400_001).is_err());
        let long_job = GitHookJobDeadline::capture(120_001).unwrap();
        let role = nested_deadline(&long_job).unwrap();
        assert!(role.envelope().expires_ns <= long_job.expires_ns);
        assert!(role.envelope().expires_ns - role.envelope().started_ns <= 30_000_000_000);
        let short_job = GitHookJobDeadline::capture(1_000).unwrap();
        assert!(nested_deadline(&short_job).unwrap().envelope().expires_ns <= short_job.expires_ns);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn failed_callback_remains_sticky_through_successful_finish_and_verdict() {
        fixture(|runtime, root, base| {
            let (mut peer, socket) = UnixStream::pair().unwrap();
            let mut bridge = GitHookBridge::new(runtime, socket).unwrap();
            let scratch = bridge.runtime.scratch_root.to_path_buf();
            bridge.roots.push(ConfiguredRoot {
                root,
                shim_directory: scratch.clone(),
            });
            bridge.configured = true;
            let id = "a".repeat(64);
            bridge.contexts.insert(
                id.clone(),
                Context {
                    root_index: 0,
                    hook: "pre-commit".into(),
                    args: vec![],
                    git_environment: BTreeMap::new(),
                    stdin_base64: String::new(),
                    transaction_root: scratch,
                    executed: true,
                    hook_failed: true,
                },
            );
            let mut fence = Some(ExecutionFence::acquire(&base.join("project/.caws")).unwrap());
            let deadline = GitHookJobDeadline::capture(10_000).unwrap();
            let rpc = |peer: &mut UnixStream,
                       bridge: &mut GitHookBridge<'_>,
                       fence: &mut Option<ExecutionFence>,
                       request: &str|
             -> Value {
                let body = envelope(request);
                let mut frame = (body.len() as u32).to_be_bytes().to_vec();
                frame.extend_from_slice(body.as_bytes());
                peer.write_all(&frame).unwrap();
                bridge.pump(fence, &deadline, &|_| Ok(())).unwrap();
                let mut size = [0; 4];
                peer.read_exact(&mut size).unwrap();
                let mut bytes = vec![0; u32::from_be_bytes(size) as usize];
                peer.read_exact(&mut bytes).unwrap();
                serde_json::from_slice(&bytes).unwrap()
            };
            let finished = rpc(
                &mut peer,
                &mut bridge,
                &mut fence,
                &format!(
                    r#"{{"operation":"finish","contextId":"{id}","exitCode":0,"publication":"index-published"}}"#
                ),
            );
            assert_eq!(finished["response"]["status"], "ok");
            assert!(
                bridge.failed,
                "hook failure must remain sticky after finish"
            );
            bridge.ever_spawn_may_have_occurred = true;
            let refused = rpc(
                &mut peer,
                &mut bridge,
                &mut fence,
                r#"{"operation":"assert","contextId":"unknown"}"#,
            );
            assert_eq!(refused["response"]["status"], "refused");
            assert_eq!(refused["response"]["userSpawnMayHaveOccurred"], true);
            let verdict = rpc(
                &mut peer,
                &mut bridge,
                &mut fence,
                r#"{"operation":"verdict"}"#,
            );
            assert_eq!(verdict["response"]["data"]["failed"], true);
            peer.shutdown(std::net::Shutdown::Write).unwrap();
            bridge.pump(&mut fence, &deadline, &|_| Ok(())).unwrap();
            assert!(bridge.is_cleanly_closed());
            assert!(!bridge.succeeded());
            fence.take().unwrap().release().unwrap();
        });
    }
}
