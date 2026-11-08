//! Native-original file-tool context. Observation is never CAWS authority.
//! Capture and late Git custody stay with this original invocation on failure.
use super::original_project::{self, CapturedProject, Input, RemoteFailure};
use super::{ContextGitOwner, Invocation, Operation, PendingGit, Request, ResultFrame, STANDARD};
use crate::{
    execution_fence::ExecutionFence, invocation_project as project,
    monotonic_deadline::MonotonicDeadline,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Instant,
};

pub const CAPABILITY: &str = "caws.runtime.file-tool-context.v1";
pub const REQUEST_SCHEMA: &str = "caws.runtime.file-tool-context.request.v1";
const RESULT_SCHEMA: &str = "caws.runtime.file-tool-context.result.v1";
pub const NATIVE_CAPABILITY: &str = "caws.runtime.file-tool-context.v2";
pub const NATIVE_REQUEST_SCHEMA: &str = "caws.runtime.file-tool-context.request.v2";
const NATIVE_RESULT_SCHEMA: &str = "caws.runtime.file-tool-context.result.v2";
pub const MAX_REQUEST: usize = 1024;
pub const MAX_CONTROL_CREDIT: usize = 2 * (MAX_REQUEST + 1);
const NATIVE_CONTROL_CREDIT: usize = 3 * (MAX_REQUEST + 1);
const MAX_REPLY: usize = 2 * 1024 * 1024;
const MAX_WORKTREES: usize = 4096;

pub fn eligible_payload(payload: &RawValue) -> Result<bool, String> {
    #[derive(Deserialize)]
    struct Tool {
        tool_name: Option<String>,
    }
    let tool: Tool = serde_json::from_str(payload.get())
        .map_err(|error| format!("original file-tool name: {error}"))?;
    Ok(matches!(
        tool.tool_name.as_deref(),
        Some("apply_patch" | "Write" | "Edit")
    ))
}
pub fn eligible_native_payload(payload: &RawValue) -> Result<bool, String> {
    #[derive(Deserialize)]
    struct Tool {
        tool_name: Option<String>,
    }
    let tool: Tool = serde_json::from_str(payload.get())
        .map_err(|error| format!("original native file-tool name: {error}"))?;
    if !matches!(tool.tool_name.as_deref(), Some("Write" | "Edit")) {
        return Ok(false);
    }
    native_original_session(payload)?;
    Ok(true)
}

/// Original callback identity only. Known selectors reject duplicates while
/// unrelated extension values remain opaque. No fallback supplies a session.
pub fn native_original_session(payload: &RawValue) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Original {
        session_id: String,
        tool_name: String,
        #[serde(rename = "cwd")]
        _cwd: Option<String>,
        #[serde(rename = "execution_workdir")]
        _execution_workdir: Option<Box<RawValue>>,
        tool_input: Box<RawValue>,
        #[serde(rename = "tool_use_id")]
        _tool_use_id: Option<Box<RawValue>>,
        #[serde(rename = "permission_mode")]
        _permission_mode: Option<Box<RawValue>>,
    }
    #[derive(Deserialize)]
    struct ToolInput {
        #[serde(rename = "file_path")]
        _file_path: Option<Box<RawValue>>,
        #[serde(rename = "cwd")]
        _cwd: Option<Box<RawValue>>,
        #[serde(rename = "workdir")]
        _workdir: Option<Box<RawValue>>,
        #[serde(rename = "command")]
        _command: Option<Box<RawValue>>,
        #[serde(rename = "content")]
        _content: Option<Box<RawValue>>,
        #[serde(rename = "old_string")]
        _old_string: Option<Box<RawValue>>,
        #[serde(rename = "new_string")]
        _new_string: Option<Box<RawValue>>,
        #[serde(rename = "replace_all")]
        _replace_all: Option<Box<RawValue>>,
    }
    let original: Original = serde_json::from_str(payload.get())
        .map_err(|error| format!("original native file selectors: {error}"))?;
    if !matches!(original.tool_name.as_str(), "Write" | "Edit")
        || original.session_id.is_empty()
        || original.session_id.trim().is_empty()
    {
        return Err(
            "native file callback lacks a nonempty original session or eligible tool".into(),
        );
    }
    let _: ToolInput = serde_json::from_str(original.tool_input.get())
        .map_err(|error| format!("original native file input selectors: {error}"))?;
    Ok(original.session_id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeStrikePhase {
    ScopeGuard,
    ShortcutLanguage,
}

fn check(
    original: &MonotonicDeadline,
    until: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    original.check().map_err(|error| error.to_string())?;
    if cancelled() {
        return Err("original file-tool context cancelled".into());
    }
    if Instant::now() >= until.min(original.expires()) {
        return Err("original file-tool context deadline expired".into());
    }
    Ok(())
}
fn nullable<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(decoder)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    ordinal: u8,
    #[serde(deserialize_with = "nullable")]
    snapshot_token: Option<String>,
}
#[derive(Default)]
struct Exchanges {
    native: bool,
    consumed: u8,
    ready: bool,
    poisoned: bool,
    unused: bool,
    token: Option<String>,
    snapshot: Option<String>,
}
impl Exchanges {
    fn admit(
        &mut self,
        bytes: &[u8],
        id: &str,
        digest: &str,
        after_dispatch: bool,
    ) -> Result<Control, String> {
        let admitted = (|| {
            let maximum = if self.native { 3 } else { 2 };
            if self.poisoned || self.unused || self.consumed >= maximum || bytes.len() > MAX_REQUEST
            {
                return Err("file-tool context exhausted, poisoned or oversized".into());
            }
            let control: Control = serde_json::from_slice(bytes)
                .map_err(|error| format!("file-tool context request: {error}"))?;
            let schema = if self.native {
                NATIVE_REQUEST_SCHEMA
            } else {
                REQUEST_SCHEMA
            };
            let dispatched_ordinal = if self.native {
                control.ordinal >= 2
            } else {
                control.ordinal == 2
            };
            if control.schema != schema
                || control.id != id
                || control.runtime_digest != digest
                || !super::lower_hex(&control.token)
                || control.ordinal != self.consumed + 1
                || after_dispatch != dispatched_ordinal
                || self.ready != after_dispatch
            {
                return Err("file-tool context identity, ordinal or phase differs".into());
            }
            if control.ordinal == 1 {
                if control.snapshot_token.is_some() {
                    return Err("initial file-tool context must have null snapshotToken".into());
                }
            } else if self.token.as_deref() != Some(control.token.as_str())
                || self.snapshot.is_none()
                || control.snapshot_token != self.snapshot
            {
                return Err("file-tool context token or original snapshot differs".into());
            }
            Ok(control)
        })();
        match admitted {
            Ok(control) => {
                self.consumed += 1;
                if self.consumed == 1 {
                    self.token = Some(control.token.clone());
                }
                Ok(control)
            }
            Err(error) => {
                self.poisoned = true;
                Err(error)
            }
        }
    }
    fn scope_strike_phase(&self) -> Result<(), String> {
        if self.poisoned
            || self.unused
            || !self.ready
            || self.consumed != 1
            || self.snapshot.is_none()
        {
            return Err(
                "scope strike requires completed capture1 and Ready, before capture2".into(),
            );
        }
        Ok(())
    }
    fn mark_ready(&mut self) -> Result<(), String> {
        if self.poisoned
            || self.ready
            || (self.consumed != 0 && (self.consumed != 1 || self.snapshot.is_none()))
        {
            self.poisoned = true;
            return Err("Ready requires an untouched offer or one completed original file-tool context capture".into());
        }
        // A custom/unsupported selection may decline the optional offer. Ready
        // freezes that choice: it cannot be upgraded to native context later.
        self.unused = self.consumed == 0;
        self.ready = true;
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
struct RootPin {
    path: PathBuf,
    device: u64,
    inode: u64,
}
impl RootPin {
    fn capture(
        path: &Path,
        checkpoint: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        checkpoint()?;
        valid_path(path)?;
        let physical =
            fs::canonicalize(path).map_err(|error| format!("file-tool root: {error}"))?;
        checkpoint()?;
        if physical != path {
            return Err("file-tool root is not its original physical path".into());
        }
        let first = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !first.is_dir() || first.file_type().is_symlink() {
            return Err("file-tool root is not a physical directory".into());
        }
        checkpoint()?;
        let second = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !second.is_dir()
            || first.dev() != second.dev()
            || first.ino() != second.ino()
            || fs::canonicalize(path).map_err(|error| error.to_string())? != path
        {
            return Err("file-tool root changed while observed".into());
        }
        checkpoint()?;
        Ok(Self {
            path: path.into(),
            device: first.dev(),
            inode: first.ino(),
        })
    }
    fn verify(&self, checkpoint: &mut impl FnMut() -> Result<(), String>) -> Result<(), String> {
        let observed = Self::capture(&self.path, checkpoint)?;
        if observed.device != self.device || observed.inode != self.inode {
            return Err("original file-tool root was replaced".into());
        }
        Ok(())
    }
}
fn valid_path(path: &Path) -> Result<(), String> {
    let text = path.to_str().ok_or("file-tool path is not UTF-8")?;
    if !path.is_absolute() || text.len() > 4096 || text.contains('\0') {
        return Err("file-tool path is outside the absolute UTF-8 domain".into());
    }
    Ok(())
}
fn line(bytes: &[u8]) -> Result<&str, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "file-tool Git output is not UTF-8")?;
    let text = text.strip_suffix('\n').unwrap_or(text);
    if text.is_empty() || text.contains(['\0', '\n', '\r']) || text.len() > 4096 {
        return Err("file-tool Git output is not one bounded nonempty line".into());
    }
    Ok(text)
}
fn physical_query_path(
    bytes: &[u8],
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<PathBuf, String> {
    let selected = Path::new(line(bytes)?);
    valid_path(selected)?;
    checkpoint()?;
    let physical = fs::canonicalize(selected).map_err(|error| error.to_string())?;
    checkpoint()?;
    valid_path(&physical)?;
    Ok(physical)
}
fn settled_query(bytes: &[u8]) -> Result<(i32, Vec<u8>), String> {
    let row: ResultFrame = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if row.status != "exited"
        || row.signal.is_some()
        || row.exit_code.is_none()
        || !row.cleanup.group_settled
        || !row.cleanup.stdout_eof
        || !row.cleanup.stderr_eof
        || !row.cleanup.reaped
    {
        return Err(format!(
            "file-tool Git query did not settle: {}",
            row.status
        ));
    }
    let stdout = STANDARD
        .decode(&row.stdout)
        .map_err(|error| error.to_string())?;
    let code = row.exit_code.unwrap();
    if !(0..=255).contains(&code) {
        return Err("invalid settled file-tool Git exit code".into());
    }
    Ok((code, stdout))
}
fn branch_observation(code: i32, bytes: &[u8]) -> Result<Option<String>, String> {
    if code == 0 {
        Ok(Some(line(bytes)?.to_owned()))
    } else {
        Ok(None)
    }
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Worktree {
    path: PathBuf,
    branch: Option<String>,
    detached: bool,
    prunable: bool,
    bare: bool,
}
fn worktrees(bytes: &[u8]) -> Result<Vec<Worktree>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "worktree inventory is not UTF-8")?;
    if text.is_empty() || !text.ends_with("\0\0") {
        return Err("incomplete NUL worktree inventory".into());
    }
    let mut result = Vec::new();
    let mut paths = BTreeSet::new();
    for record in text[..text.len() - 2].split("\0\0") {
        if result.len() >= MAX_WORKTREES || record.is_empty() {
            return Err("worktree inventory exceeds row bound or has an empty record".into());
        }
        let mut path = None;
        let mut head = false;
        let mut branch = None;
        let mut detached = false;
        let mut prunable = false;
        let mut locked = false;
        let mut bare = false;
        for field in record.split('\0') {
            if let Some(value) = field.strip_prefix("worktree ") {
                if path.is_some() {
                    return Err("duplicate worktree path".into());
                }
                let selected = PathBuf::from(value);
                valid_path(&selected)?;
                path = Some(selected);
            } else if let Some(value) = field.strip_prefix("HEAD ") {
                if head
                    || !matches!(value.len(), 40 | 64)
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                {
                    return Err("invalid or duplicate worktree HEAD".into());
                }
                head = true;
            } else if let Some(value) = field.strip_prefix("branch ") {
                if branch.is_some()
                    || detached
                    || !value.starts_with("refs/heads/")
                    || value.len() <= 11
                    || value.len() > 4096
                    || value.chars().any(char::is_control)
                {
                    return Err("invalid or duplicate worktree branch".into());
                }
                branch = Some(value.to_owned());
            } else if field == "bare" {
                if bare {
                    return Err("duplicate bare worktree field".into());
                }
                bare = true;
            } else if field == "detached" {
                if detached || branch.is_some() {
                    return Err("invalid or duplicate detached worktree".into());
                }
                detached = true;
            } else if field == "prunable" || field.starts_with("prunable ") {
                if prunable {
                    return Err("duplicate prunable worktree field".into());
                }
                prunable = true;
            } else if field == "locked" || field.starts_with("locked ") {
                if locked {
                    return Err("duplicate locked worktree field".into());
                }
                locked = true;
            } else {
                return Err("unknown worktree inventory field".into());
            }
        }
        let path = path.ok_or("worktree record lacks path")?;
        let complete = if bare {
            !head && branch.is_none() && !detached
        } else {
            head && (branch.is_some() != detached)
        };
        if !complete || !paths.insert(path.clone()) {
            return Err("incomplete or duplicate worktree inventory record".into());
        }
        result.push(Worktree {
            path,
            branch,
            detached,
            prunable,
            bare,
        });
    }
    Ok(result)
}
fn validate_bare_roots(
    rows: &[Worktree],
    common_dir: &Path,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    for row in rows.iter().filter(|row| row.bare) {
        checkpoint()?;
        let physical = fs::canonicalize(&row.path).map_err(|error| error.to_string())?;
        checkpoint()?;
        if physical != common_dir {
            return Err("bare primary does not identify the original Git common directory".into());
        }
    }
    Ok(())
}
fn merge_in_progress(
    git_dir: &Path,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    checkpoint()?;
    let selected = git_dir.join("MERGE_HEAD");
    let before = match fs::symlink_metadata(&selected) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            checkpoint()?;
            return Ok(false);
        }
        Err(error) => return Err(error.to_string()),
    };
    if !before.is_file() || before.file_type().is_symlink() {
        return Err("MERGE_HEAD is not a no-follow regular file".into());
    }
    checkpoint()?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&selected)
        .map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    let after = fs::symlink_metadata(&selected).map_err(|error| error.to_string())?;
    checkpoint()?;
    if !opened.is_file()
        || !after.is_file()
        || before.dev() != opened.dev()
        || before.ino() != opened.ino()
        || opened.dev() != after.dev()
        || opened.ino() != after.ino()
    {
        return Err("MERGE_HEAD changed while observed".into());
    }
    Ok(true)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    checkout: PathBuf,
    canonical: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    branch: Option<String>,
    merge_in_progress: bool,
    worktrees: Vec<Worktree>,
}
struct Owner {
    original: MonotonicDeadline,
    captured: CapturedProject,
    native: project::SelectedExecutable,
    git: ContextGitOwner,
    checkout: RootPin,
    canonical: RootPin,
    directories: Option<[RootPin; 2]>,
    pending: Option<PendingGit>,
    query_ordinal: u8,
    // Cooperative canonical writers cannot revoke authority during the
    // checked capture/proposal window. V1 observations acquire no fence.
    fence: Option<ExecutionFence>,
}
impl Owner {
    fn verify(
        &self,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
        checkpoint: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        check(&self.original, until, cancelled)?;
        self.captured
            .verify_native_file_git(&self.native, until, cancelled)?;
        project::verify_executable(
            &self.native,
            project::ProjectPhase::BeforeLaunch,
            until,
            cancelled,
        )
        .map_err(|error| error.to_string())?;
        project::verify_executable(
            &self.captured.project().executable,
            project::ProjectPhase::BeforeLaunch,
            until,
            cancelled,
        )
        .map_err(|error| error.to_string())?;
        self.checkout.verify(checkpoint)?;
        self.canonical.verify(checkpoint)?;
        if let Some(fence) = &self.fence {
            fence
                .validate()
                .map_err(|error| format!("native file authority fence: {error}"))?;
        }
        if let Some(directories) = &self.directories {
            for root in directories {
                root.verify(checkpoint)?;
            }
        }
        check(&self.original, until, cancelled)
    }
    fn query(
        &mut self,
        operation: Operation,
        token: &str,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
        pump: &mut impl FnMut(&[libc::pollfd], i32) -> Result<(), String>,
    ) -> Result<(i32, Vec<u8>), String> {
        check(&self.original, until, cancelled)?;
        self.captured
            .verify_native_file_git(&self.native, until, cancelled)?;
        if self.pending.is_some() {
            return Err("file-tool query retains previous custody".into());
        }
        self.query_ordinal = self
            .query_ordinal
            .checked_add(1)
            .ok_or("file-tool query ordinal overflow")?;
        let query = Request {
            schema: super::REQUEST_SCHEMA.into(),
            id: self.captured.id().into(),
            runtime_digest: self.captured.runtime_digest().into(),
            token: token.into(),
            ordinal: self.query_ordinal,
            operation,
            executable: self.captured.project().executable.path.clone(),
            cwd: self.checkout.path.clone(),
        };
        // Store before any poll or fallible response handling. An error cannot
        // reduce the actual pending custodian to a diagnostic string.
        self.pending = Some(self.git.start_query(query)?);
        loop {
            check(&self.original, until, cancelled)?;
            pump(&self.pending.as_ref().unwrap().interests(), 0)?;
            let value = self
                .pending
                .as_mut()
                .unwrap()
                .advance_until(&self.original, until)?;
            pump(
                &self.pending.as_ref().unwrap().interests(),
                if value.is_some() { 0 } else { 100 },
            )?;
            check(&self.original, until, cancelled)?;
            if let Some(bytes) = value {
                let (code, stdout) = settled_query(&bytes)?;
                self.pending.take();
                self.captured
                    .verify_native_file_git(&self.native, until, cancelled)?;
                project::verify_executable(
                    &self.native,
                    project::ProjectPhase::AfterLaunch,
                    until,
                    cancelled,
                )
                .map_err(|error| error.to_string())?;
                project::verify_executable(
                    &self.captured.project().executable,
                    project::ProjectPhase::AfterLaunch,
                    until,
                    cancelled,
                )
                .map_err(|error| error.to_string())?;
                return Ok((code, stdout));
            }
        }
    }
    fn observe(
        &mut self,
        control: &Control,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
        pump: &mut impl FnMut(&[libc::pollfd], i32) -> Result<(), String>,
    ) -> Result<Context, String> {
        let clock = self.original.clone();
        let mut checkpoint = || {
            check(&clock, until, cancelled)?;
            pump(&[], 0)?;
            check(&clock, until, cancelled)
        };
        self.verify(until, cancelled, &mut checkpoint)?;
        let (branch_code, branch_bytes) = self.query(
            Operation::FileBranch,
            &control.token,
            until,
            cancelled,
            pump,
        )?;
        let branch = branch_observation(branch_code, &branch_bytes)?;
        let (git_code, git_bytes) = self.query(
            Operation::FileGitDir,
            &control.token,
            until,
            cancelled,
            pump,
        )?;
        let (common_code, common_bytes) = self.query(
            Operation::FileCommonDir,
            &control.token,
            until,
            cancelled,
            pump,
        )?;
        if git_code != 0 || common_code != 0 {
            return Err("file-tool Git directory query failed".into());
        }
        let mut checkpoint = || {
            check(&clock, until, cancelled)?;
            pump(&[], 0)?;
            check(&clock, until, cancelled)
        };
        let git_dir = physical_query_path(&git_bytes, &mut checkpoint)?;
        let common_dir = physical_query_path(&common_bytes, &mut checkpoint)?;
        // Use the original shared project parser's parent-before-realpath
        // mapping, rather than deriving canonical authority from a new path.
        let common_spelling = Path::new(line(&common_bytes)?);
        let common_parent = common_spelling
            .parent()
            .ok_or("common directory has no parent")?;
        checkpoint()?;
        if fs::canonicalize(common_parent).map_err(|error| error.to_string())?
            != self.canonical.path
        {
            return Err("file-tool canonical project mapping changed".into());
        }
        if let Some(roots) = &self.directories {
            if roots[0].path != git_dir || roots[1].path != common_dir {
                return Err("original file-tool Git roots changed".into());
            }
        } else {
            self.directories = Some([
                RootPin::capture(&git_dir, &mut checkpoint)?,
                RootPin::capture(&common_dir, &mut checkpoint)?,
            ]);
        }
        let (inventory_code, inventory_bytes) = self.query(
            Operation::FileWorktrees,
            &control.token,
            until,
            cancelled,
            pump,
        )?;
        if inventory_code != 0 {
            return Err("file-tool worktree inventory query failed".into());
        }
        let inventory = worktrees(&inventory_bytes)?;
        let mut checkpoint = || {
            check(&clock, until, cancelled)?;
            pump(&[], 0)?;
            check(&clock, until, cancelled)
        };
        validate_bare_roots(&inventory, &common_dir, &mut checkpoint)?;
        let merge = merge_in_progress(&git_dir, &mut checkpoint)?;
        self.verify(until, cancelled, &mut checkpoint)?;
        Ok(Context {
            checkout: self.checkout.path.clone(),
            canonical: self.canonical.path.clone(),
            git_dir,
            common_dir,
            branch,
            merge_in_progress: merge,
            worktrees: inventory,
        })
    }
    fn snapshot_token(&self) -> Result<String, String> {
        let roots = self
            .directories
            .as_ref()
            .ok_or("file-tool Git roots unavailable")?;
        let identity = serde_json::to_vec(&(
            self.captured.input_digest(),
            &self.checkout,
            &self.canonical,
            &roots[0],
            &roots[1],
        ))
        .map_err(|error| error.to_string())?;
        Ok(format!("{:x}", Sha256::digest(identity)))
    }
}

/// These are copied from the original native Request before Node. There is no
/// wire deserializer and no path/environment fallback from an engine frame.
struct RetainedInput {
    id: String,
    runtime_digest: String,
    caller_cwd: String,
    environment: BTreeMap<String, String>,
    payload: Box<RawValue>,
}
impl RetainedInput {
    fn input(&self) -> Input<'_> {
        Input {
            id: &self.id,
            runtime_digest: &self.runtime_digest,
            caller_cwd: &self.caller_cwd,
            environment: &self.environment,
            payload: &self.payload,
        }
    }
}
#[derive(Default)]
struct NativeState {
    dispatch_written: bool,
    active: bool,
    sealed: bool,
    delivered: u8,
    pending_delivery: Option<u8>,
    // Encoded and fully delivered are distinct receipts. The original owner
    // retains actual replies through transport failure and terminal cleanup.
    replies: [Option<Vec<u8>>; 3],
}

/// Moved intact into Failure/fallback. An untouched offer has never started a
/// Git custodian. Failed/partial capture and late pending Git remain cleanup-only.
pub struct Preparation {
    input: RetainedInput,
    original: MonotonicDeadline,
    native: Option<project::SelectedExecutable>,
    owner: Option<Owner>,
    // Retain completed capture facts even if later root/fence setup refuses.
    retained_capture: Option<CapturedProject>,
    capture_failure: Option<RemoteFailure>,
    refusal: Option<String>,
    exchanges: Exchanges,
    native_state: Option<NativeState>,
}
/// Borrowed original roots; cannot be decoded or manufactured by the engine.
pub struct ScopeStrikeRoots<'a> {
    checkout: &'a Path,
    git_dir: &'a Path,
}
impl ScopeStrikeRoots<'_> {
    pub fn checkout(&self) -> &Path {
        self.checkout
    }
    pub fn git_dir(&self) -> &Path {
        self.git_dir
    }
}
impl Preparation {
    pub fn scope_strike_roots(
        &self,
        id: &str,
        runtime_digest: &str,
        original: &MonotonicDeadline,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<ScopeStrikeRoots<'_>, String> {
        self.exchanges.scope_strike_phase()?;
        self.bound_strike_roots(id, runtime_digest, original, until, cancelled)
    }
    fn bound_strike_roots(
        &self,
        id: &str,
        runtime_digest: &str,
        original: &MonotonicDeadline,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<ScopeStrikeRoots<'_>, String> {
        if self.input.id != id
            || self.input.runtime_digest != runtime_digest
            || self.original.envelope() != original.envelope()
            || self.original.expires() != original.expires()
            || self.capture_failure.is_some()
            || self.refusal.is_some()
        {
            return Err("scope strike original context binding differs or retains failure".into());
        }
        let owner = self
            .owner
            .as_ref()
            .ok_or("scope strike original context owner unavailable")?;
        if owner.pending.is_some()
            || owner.captured.id() != id
            || owner.captured.runtime_digest() != runtime_digest
            || owner.original.envelope() != original.envelope()
        {
            return Err("scope strike original context retains pending custody or differs".into());
        }
        let roots = owner
            .directories
            .as_ref()
            .ok_or("scope strike original Git roots unavailable")?;
        // Uses the original cancellation observer for executable and all four
        // physical-root checks; no engine path or compatibility discovery.
        owner.verify(until, cancelled, &mut || check(original, until, cancelled))?;
        Ok(ScopeStrikeRoots {
            checkout: &owner.checkout.path,
            git_dir: &roots[0].path,
        })
    }
    /// Retain original identity and pin the actual native executor, but do not
    /// discover a Git project for an optional offer that may remain unused.
    pub fn retain_original(
        input: Input<'_>,
        original: &MonotonicDeadline,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Self {
        let retained = RetainedInput {
            id: input.id.into(),
            runtime_digest: input.runtime_digest.into(),
            caller_cwd: input.caller_cwd.into(),
            environment: input.environment.clone(),
            payload: input.payload.to_owned(),
        };
        let pin = (|| {
            check(original, until, cancelled)?;
            let path = std::env::current_exe().map_err(|error| error.to_string())?;
            project::pin_executable(&path, until, cancelled).map_err(|error| error.to_string())
        })();
        let (native, refusal) = match pin {
            Ok(native) => (Some(native), None),
            Err(error) => (None, Some(error)),
        };
        Self {
            input: retained,
            original: original.clone(),
            native,
            owner: None,
            retained_capture: None,
            capture_failure: None,
            refusal,
            exchanges: Exchanges::default(),
            native_state: None,
        }
    }
    /// No project query or transaction starts until the original engine
    /// requests observation. An unused V2 callback may refuse, never allow.
    pub fn retain_native(
        input: Input<'_>,
        original: &MonotonicDeadline,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Self {
        let mut owner = Self::retain_original(input, original, until, cancelled);
        owner.exchanges.native = true;
        owner.native_state = Some(NativeState::default());
        owner
    }
    pub fn control_credit_limit(&self) -> usize {
        if self.native_state.is_some() {
            NATIVE_CONTROL_CREDIT
        } else {
            MAX_CONTROL_CREDIT
        }
    }
    pub fn poison(&mut self) {
        if self.native_state.is_some() {
            self.exchanges.poisoned = true;
        }
    }
    /// Called only after the original dispatch grant is fully written.
    pub fn grant_written(&mut self, active: bool) -> Result<(), String> {
        let Some(state) = self.native_state.as_mut() else {
            return Ok(());
        };
        if state.dispatch_written || state.sealed || self.exchanges.poisoned {
            self.exchanges.poisoned = true;
            return Err("native file dispatch cannot be replayed or upgraded".into());
        }
        state.dispatch_written = true;
        state.active = active;
        Ok(())
    }
    /// Sole runner writer acknowledgement, never query-completion credit.
    pub fn observation_delivered(&mut self) -> Result<(), String> {
        let result = (|| {
            let Some(state) = self.native_state.as_mut() else {
                return Ok(());
            };
            let ordinal = state
                .pending_delivery
                .take()
                .ok_or("native context has no pending result delivery")?;
            if self.exchanges.poisoned
                || state.sealed
                || ordinal != state.delivered + 1
                || ordinal != self.exchanges.consumed
                || state.replies[usize::from(ordinal - 1)].is_none()
            {
                return Err("native context delivery phase differs".into());
            }
            state.delivered = ordinal;
            Ok(())
        })();
        if result.is_err() {
            self.poison();
        }
        result
    }
    pub fn requires_finality(&self) -> bool {
        self.native_state.is_some()
    }
    /// Observation is not permission. The admitted engine separately validates
    /// canonical policy/spec/binding/source/preimage synchronously. This seal
    /// enforces delivered observations and existing original native custody.
    pub fn seal_proposal(
        &mut self,
        exit_code: u8,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        if self.native_state.is_none() {
            return Ok(());
        }
        let result = (|| {
            check(&self.original, until, cancelled)?;
            let state = self.native_state.as_mut().unwrap();
            if std::mem::replace(&mut state.sealed, true) {
                return Err("native file proposal already sealed".into());
            }
            // A protective refusal starts no additional query/effect. Existing
            // pending custody/publications remain with their original owners.
            if exit_code == 2 {
                return Ok(());
            }
            if self.exchanges.poisoned || state.pending_delivery.is_some() {
                return Err("native file proposal retains poisoned or partial observation".into());
            }
            if !state.dispatch_written
                || !state.active
                || self.exchanges.unused
                || !self.exchanges.ready
                || self.exchanges.consumed != 3
                || state.delivered != 3
                || state.replies.iter().any(Option::is_none)
                || self.capture_failure.is_some()
                || self.refusal.is_some()
            {
                return Err(
                    "native nonblocking file proposal requires three delivered observations".into(),
                );
            }
            let owner = self
                .owner
                .as_ref()
                .ok_or("native final observation has no original project owner")?;
            if owner.pending.is_some() {
                return Err("native final observation retains pending Git custody".into());
            }
            owner.verify(until, cancelled, &mut || {
                check(&self.original, until, cancelled)
            })?;
            check(&self.original, until, cancelled)
        })();
        if result.is_err() {
            self.poison();
        }
        result
    }
    pub fn native_strike_roots(
        &self,
        phase: NativeStrikePhase,
        token: &str,
        snapshot: &str,
        id: &str,
        runtime_digest: &str,
        original: &MonotonicDeadline,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<ScopeStrikeRoots<'_>, String> {
        let state = self
            .native_state
            .as_ref()
            .ok_or("native strike lacks original native file context")?;
        let expected = match phase {
            NativeStrikePhase::ScopeGuard => 1,
            NativeStrikePhase::ShortcutLanguage => 2,
        };
        if self.exchanges.poisoned
            || self.exchanges.unused
            || !self.exchanges.ready
            || state.sealed
            || !state.dispatch_written
            || !state.active
            || state.pending_delivery.is_some()
            || self.exchanges.consumed != expected
            || state.delivered != expected
            || self.exchanges.token.as_deref() != Some(token)
            || self.exchanges.snapshot.as_deref() != Some(snapshot)
        {
            return Err("native strike token, snapshot or delivered phase differs".into());
        }
        if phase == NativeStrikePhase::ShortcutLanguage {
            #[derive(Deserialize)]
            struct Tool {
                tool_name: Option<String>,
            }
            let tool: Tool = serde_json::from_str(self.input.payload.get())
                .map_err(|error| format!("original shortcut tool: {error}"))?;
            if tool.tool_name.as_deref() != Some("Write") {
                return Err("native shortcut strike requires original Write".into());
            }
        }
        self.bound_strike_roots(id, runtime_digest, original, until, cancelled)
    }
    fn initialize(
        &mut self,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
        pump: &mut impl FnMut(&[libc::pollfd], i32) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.owner.is_some() {
            return Ok(());
        }
        if let Some(failure) = &self.capture_failure {
            return Err(format!(
                "original file-tool capture refused: {}",
                failure.diagnostic
            ));
        }
        if let Some(refusal) = &self.refusal {
            return Err(refusal.clone());
        }
        let native = self
            .native
            .as_ref()
            .ok_or("original native executor was not retained")?
            .clone();
        let clock = self.original.clone();
        // The existing capture API takes a shared cancellation observer. The
        // RefCells only adapt the sole runner reader; they confer no standing.
        let transport_error = RefCell::new(None::<String>);
        let captured = {
            let reader = RefCell::new(&mut *pump);
            let interrupted = || {
                if check(&clock, until, cancelled).is_err() {
                    return true;
                }
                match (*reader.borrow_mut())(&[], 0) {
                    Ok(()) => false,
                    Err(error) => {
                        if transport_error.borrow().is_none() {
                            *transport_error.borrow_mut() = Some(error);
                        }
                        true
                    }
                }
            };
            if self.native_state.is_some() {
                original_project::capture_native_file(
                    self.input.input(),
                    &native,
                    &clock,
                    &interrupted,
                )
            } else {
                original_project::capture(self.input.input(), &native, &clock, &interrupted)
            }
        };
        let captured = match captured {
            Ok(captured) => captured,
            Err(failure) => {
                let message = transport_error
                    .into_inner()
                    .unwrap_or_else(|| failure.diagnostic.clone());
                self.capture_failure = Some(failure);
                return Err(message);
            }
        };
        // A transport failure cannot be upgraded by a concurrently arriving
        // successful capture; no additional queries or effects may follow it.
        if let Some(error) = transport_error.into_inner() {
            self.retained_capture = Some(captured);
            return Err(error);
        }
        self.retained_capture = Some(captured);
        let captured = self.retained_capture.as_ref().unwrap();
        let mut checkpoint = || {
            check(&clock, until, cancelled)?;
            pump(&[], 0)?;
            check(&clock, until, cancelled)
        };
        let checkout = RootPin::capture(&captured.project().checkout, &mut checkpoint)?;
        let canonical = RootPin::capture(&captured.project().canonical_root, &mut checkpoint)?;
        let fence = if self.native_state.is_some() {
            checkpoint()?;
            let fence = ExecutionFence::acquire(&canonical.path.join(".caws"))
                .map_err(|error| format!("native file authority fence unavailable: {error}"))?;
            checkpoint()?;
            Some(fence)
        } else {
            None
        };
        let invocation = Invocation {
            id: self.input.id.clone(),
            runtime_digest: self.input.runtime_digest.clone(),
            deadline: until,
            environment: self
                .input
                .environment
                .iter()
                .map(|(name, value)| (name.into(), value.into()))
                .collect(),
        };
        let git = if self.native_state.is_some() {
            ContextGitOwner::new_native_file(invocation, captured)?
        } else {
            ContextGitOwner::new(invocation)?
        };
        self.owner = Some(Owner {
            original: clock,
            captured: self.retained_capture.take().unwrap(),
            native,
            git,
            checkout,
            canonical,
            directories: None,
            pending: None,
            query_ordinal: 0,
            fence,
        });
        Ok(())
    }
    pub fn mark_ready(&mut self) -> Result<(), String> {
        if let Some(state) = self.native_state.as_ref()
            && (state.pending_delivery.is_some()
                || state.delivered != self.exchanges.consumed
                || state.sealed)
        {
            self.poison();
            return Err("native Ready precedes complete context delivery".into());
        }
        self.exchanges.mark_ready()
    }
    pub fn observe(
        &mut self,
        bytes: &[u8],
        after_dispatch: bool,
        until: Instant,
        cancelled: &dyn Fn() -> bool,
        mut pump: impl FnMut(&[libc::pollfd], i32) -> Result<(), String>,
    ) -> Result<Vec<u8>, String> {
        let result = (|| {
            if let Some(state) = self.native_state.as_ref()
                && (state.sealed
                    || state.pending_delivery.is_some()
                    || state.delivered != self.exchanges.consumed
                    || (after_dispatch && (!state.dispatch_written || !state.active)))
            {
                return Err("native context request precedes delivery or active dispatch".into());
            }
            // Consume/poison before starting any lazy original query.
            let control = self.exchanges.admit(
                bytes,
                &self.input.id,
                &self.input.runtime_digest,
                after_dispatch,
            )?;
            let ordinal = control.ordinal;
            self.initialize(until, cancelled, &mut pump)?;
            let owner = self
                .owner
                .as_mut()
                .ok_or("original file-tool context unavailable")?;
            let context = owner.observe(&control, until, cancelled, &mut pump)?;
            if control.ordinal == 1 {
                self.exchanges.snapshot = Some(owner.snapshot_token()?);
            }
            let schema = if self.native_state.is_some() {
                NATIVE_RESULT_SCHEMA
            } else {
                RESULT_SCHEMA
            };
            let mut reply = serde_json::to_vec(&serde_json::json!({
                "schema":schema,"id":control.id,"runtimeDigest":control.runtime_digest,
                "token":control.token,"ordinal":control.ordinal,"snapshotToken":self.exchanges.snapshot,
                "context":context
            })).map_err(|error| error.to_string())?;
            if reply.len() > MAX_REPLY {
                return Err("file-tool context reply exceeds 2MiB".into());
            }
            reply.push(b'\n');
            if let Some(state) = self.native_state.as_mut() {
                state.replies[usize::from(ordinal - 1)] = Some(reply.clone());
                state.pending_delivery = Some(ordinal);
            }
            Ok(reply)
        })();
        if result.is_err() {
            self.exchanges.poisoned = true;
        }
        result
    }
    pub fn retry_cleanup_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Some(failure) = self.capture_failure.as_mut() {
            if let Err(error) = failure.retry_cleanup_until(original, until) {
                errors.push(error);
            }
        }
        if let Some(owner) = self.owner.as_mut() {
            if let Some(pending) = owner.pending.as_mut() {
                match pending.cancel_and_settle_until(original, until) {
                    Ok(_) => {
                        owner.pending.take();
                    }
                    Err(error) => errors.push(error),
                }
            }
        }
        if let Err(error) = self.release_native_fence() {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Terminal-only cleanup. The successful caller retains this owner through
    /// actual native output and engine settlement; refusal paths may release
    /// sooner because no permission is delivered. Never unlink a successor.
    pub fn release_native_fence(&mut self) -> Result<(), String> {
        if let Some(owner) = self.owner.as_mut()
            && let Some(fence) = owner.fence.as_mut()
        {
            fence
                .try_release()
                .map_err(|error| format!("native file authority fence cleanup: {error}"))?;
            owner.fence.take();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::symlink,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    fn control(ordinal: u8, snapshot: Option<&str>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"schema":REQUEST_SCHEMA,"id":"original","runtimeDigest":"a".repeat(64),
            "token":"b".repeat(64),"ordinal":ordinal,"snapshotToken":snapshot})).unwrap()
    }
    #[test]
    fn scope_strike_root_phase_refuses_unused_partial_poisoned_and_capture2() {
        let mut state = Exchanges::default();
        assert!(state.scope_strike_phase().is_err());
        state.mark_ready().unwrap();
        assert!(state.scope_strike_phase().is_err());
        let mut state = Exchanges::default();
        state
            .admit(&control(1, None), "original", &"a".repeat(64), false)
            .unwrap();
        assert!(state.scope_strike_phase().is_err());
        state.snapshot = Some("c".repeat(64));
        assert!(state.scope_strike_phase().is_err());
        state.mark_ready().unwrap();
        assert!(state.scope_strike_phase().is_ok());
        state.poisoned = true;
        assert!(state.scope_strike_phase().is_err());
        state.poisoned = false;
        state
            .admit(
                &control(2, Some(&"c".repeat(64))),
                "original",
                &"a".repeat(64),
                true,
            )
            .unwrap();
        assert!(state.scope_strike_phase().is_err());
        // A phase fixture cannot manufacture an opaque native owner/root receipt.
        let mut preparation = unused_offer();
        preparation.exchanges = Exchanges {
            consumed: 1,
            ready: true,
            snapshot: Some("c".repeat(64)),
            ..Exchanges::default()
        };
        let original = preparation.original.clone();
        assert!(
            preparation
                .scope_strike_roots(
                    "original",
                    &"a".repeat(64),
                    &original,
                    original.expires(),
                    &|| false
                )
                .is_err()
        );
    }
    #[test]
    fn two_phases_bind_original_snapshot_and_refuse_replay() {
        let mut state = Exchanges::default();
        state
            .admit(&control(1, None), "original", &"a".repeat(64), false)
            .unwrap();
        state.snapshot = Some("c".repeat(64));
        state.mark_ready().unwrap();
        state
            .admit(
                &control(2, Some(&"c".repeat(64))),
                "original",
                &"a".repeat(64),
                true,
            )
            .unwrap();
        assert_eq!(state.consumed, 2);
        assert!(
            state
                .admit(
                    &control(2, Some(&"c".repeat(64))),
                    "original",
                    &"a".repeat(64),
                    true
                )
                .is_err()
        );
        assert!(state.poisoned);
    }
    #[test]
    fn wrong_phase_identity_missing_null_duplicate_and_forged_fields_poison_capture() {
        let valid = control(1, None);
        let value: serde_json::Value = serde_json::from_slice(&valid).unwrap();
        let mut invalid = Vec::new();
        for (field, changed) in [
            ("id", serde_json::json!("neighbor")),
            ("runtimeDigest", serde_json::json!("d".repeat(64))),
            ("token", serde_json::json!("B".repeat(64))),
            ("ordinal", serde_json::json!(2)),
            ("snapshotToken", serde_json::json!("c".repeat(64))),
            ("cwd", serde_json::json!("/neighbor")),
            ("argv", serde_json::json!(["status"])),
            ("deadlineEpochMs", serde_json::json!(999999)),
        ] {
            let mut row = value.clone();
            row[field] = changed;
            invalid.push(serde_json::to_vec(&row).unwrap());
        }
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove("snapshotToken");
        invalid.push(serde_json::to_vec(&missing).unwrap());
        let text = String::from_utf8(valid.clone()).unwrap();
        invalid.push(
            text.replacen("\"ordinal\":1", "\"ordinal\":1,\"ordinal\":1", 1)
                .into_bytes(),
        );
        invalid.push(
            text.replacen("\"ordinal\":1", "\"ordinal\":1e0", 1)
                .into_bytes(),
        );
        invalid.push(vec![b' '; MAX_REQUEST + 1]);
        for bytes in invalid {
            let mut state = Exchanges::default();
            assert!(
                state
                    .admit(&bytes, "original", &"a".repeat(64), false)
                    .is_err(),
                "{}",
                String::from_utf8_lossy(&bytes)
            );
            assert!(state.poisoned);
            assert!(
                state
                    .admit(&valid, "original", &"a".repeat(64), false)
                    .is_err()
            );
        }
        let mut state = Exchanges::default();
        assert!(
            state
                .admit(&valid, "original", &"a".repeat(64), true)
                .is_err()
        );
        assert!(state.mark_ready().is_err());
    }
    #[test]
    fn late_exchange_requires_the_same_client_token_and_native_snapshot() {
        for (field, replacement) in [("token", "d".repeat(64)), ("snapshotToken", "e".repeat(64))] {
            let mut state = Exchanges::default();
            state
                .admit(&control(1, None), "original", &"a".repeat(64), false)
                .unwrap();
            state.snapshot = Some("c".repeat(64));
            state.mark_ready().unwrap();
            let mut value: serde_json::Value =
                serde_json::from_slice(&control(2, Some(&"c".repeat(64)))).unwrap();
            value[field] = replacement.into();
            assert!(
                state
                    .admit(
                        &serde_json::to_vec(&value).unwrap(),
                        "original",
                        &"a".repeat(64),
                        true
                    )
                    .is_err()
            );
            assert!(state.poisoned);
        }
    }
    #[test]
    fn worktree_inventory_preserves_detached_and_prunable_middle_records() {
        let head = "a".repeat(40);
        let bytes = format!(
            "worktree /repo\0HEAD {head}\0branch refs/heads/main\0\0worktree /repo/lane-a\0HEAD {head}\0detached\0locked reason\0\0worktree /repo/lane-b\0HEAD {head}\0branch refs/heads/topic\0prunable reason\0\0"
        );
        let rows = worktrees(bytes.as_bytes()).unwrap();
        assert_eq!(
            serde_json::to_value(rows).unwrap(),
            serde_json::json!([
            {"path":"/repo","branch":"refs/heads/main","detached":false,"prunable":false,"bare":false},
            {"path":"/repo/lane-a","branch":null,"detached":true,"prunable":false,"bare":false},
            {"path":"/repo/lane-b","branch":"refs/heads/topic","detached":false,"prunable":true,"bare":false}])
        );
        for bad in [
            bytes.replace("HEAD ", "foreign "),
            bytes.replace("detached\0", "detached\0detached\0"),
            bytes.replace("worktree /repo/lane-a", "worktree /repo"),
            bytes.trim_end_matches('\0').into(),
            bytes.replace("worktree /repo/lane-a", "worktree relative"),
            bytes.replace("detached\0", "branch refs/heads/both\0detached\0"),
        ] {
            assert!(worktrees(bad.as_bytes()).is_err(), "{bad:?}");
        }
        let row = format!("worktree /repo\0HEAD {head}\0detached\0\0");
        assert!(worktrees(row.repeat(MAX_WORKTREES + 1).as_bytes()).is_err());
    }
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "caws-file-context-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn root_identity_allows_directory_metadata_changes_but_refuses_replacement() {
        let directory = Directory::new();
        let selected = directory.0.join("root");
        fs::create_dir(&selected).unwrap();
        let pin = RootPin::capture(&selected, &mut || Ok(())).unwrap();
        fs::write(selected.join("new-fact"), b"branch changed").unwrap();
        pin.verify(&mut || Ok(())).unwrap();
        fs::rename(&selected, directory.0.join("old-root")).unwrap();
        fs::create_dir(&selected).unwrap();
        assert_eq!(
            pin.verify(&mut || Ok(())).unwrap_err(),
            "original file-tool root was replaced"
        );
    }
    #[test]
    fn merge_fact_is_fresh_and_never_follows_a_symlink() {
        let directory = Directory::new();
        assert!(!merge_in_progress(&directory.0, &mut || Ok(())).unwrap());
        fs::write(directory.0.join("MERGE_HEAD"), b"commit\n").unwrap();
        assert!(merge_in_progress(&directory.0, &mut || Ok(())).unwrap());
        fs::remove_file(directory.0.join("MERGE_HEAD")).unwrap();
        assert!(!merge_in_progress(&directory.0, &mut || Ok(())).unwrap());
        fs::write(directory.0.join("target"), b"commit\n").unwrap();
        symlink(directory.0.join("target"), directory.0.join("MERGE_HEAD")).unwrap();
        assert_eq!(
            merge_in_progress(&directory.0, &mut || Ok(())).unwrap_err(),
            "MERGE_HEAD is not a no-follow regular file"
        );
    }
    #[test]
    fn original_clock_and_cancellation_are_both_observed() {
        let clock = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        assert_eq!(
            check(&clock, clock.expires(), &|| true).unwrap_err(),
            "original file-tool context cancelled"
        );
        assert_eq!(
            check(&clock, Instant::now(), &|| false).unwrap_err(),
            "original file-tool context deadline expired"
        );
    }
    #[test]
    fn only_original_supported_tool_names_are_candidates() {
        for name in ["apply_patch", "Write", "Edit"] {
            assert!(
                eligible_payload(
                    &RawValue::from_string(format!("{{\"tool_name\":\"{name}\"}}")).unwrap()
                )
                .unwrap()
            );
        }
        for payload in [
            "{}",
            "{\"tool_name\":\"Bash\"}",
            "{\"tool_name\":\"write\"}",
        ] {
            assert!(!eligible_payload(&RawValue::from_string(payload.into()).unwrap()).unwrap());
        }
        assert!(
            eligible_payload(
                &RawValue::from_string("{\"tool_name\":\"Write\",\"tool_name\":\"Bash\"}".into())
                    .unwrap()
            )
            .is_err()
        );
    }
    #[test]
    fn only_settled_nonzero_git_exit_can_become_unknown_branch() {
        let request = super::super::Request {
            schema: super::super::REQUEST_SCHEMA.into(),
            id: "original".into(),
            runtime_digest: "a".repeat(64),
            token: "b".repeat(64),
            ordinal: 1,
            operation: Operation::FileBranch,
            executable: "/usr/bin/git".into(),
            cwd: "/".into(),
        };
        let mut row = super::super::result(&request, "exited", "");
        row.exit_code = Some(128);
        row.cleanup = super::super::Cleanup {
            group_settled: true,
            stdout_eof: true,
            stderr_eof: true,
            reaped: true,
        };
        let (code, bytes) = settled_query(&serde_json::to_vec(&row).unwrap()).unwrap();
        assert_eq!(branch_observation(code, &bytes).unwrap(), None);
        assert_eq!(
            branch_observation(0, b"topic\n").unwrap(),
            Some("topic".into())
        );
        assert!(branch_observation(0, b"").is_err());
        for field in [
            "status",
            "signal",
            "exitCode",
            "groupSettled",
            "stdoutEof",
            "stderrEof",
            "reaped",
        ] {
            let mut changed = serde_json::to_value(&row).unwrap();
            match field {
                "status" => changed[field] = "deadline".into(),
                "signal" => changed[field] = 9.into(),
                "exitCode" => changed[field] = serde_json::Value::Null,
                _ => changed["cleanup"][field] = false.into(),
            }
            assert!(
                settled_query(&serde_json::to_vec(&changed).unwrap()).is_err(),
                "{field}"
            );
        }
    }

    fn unused_offer() -> Preparation {
        // State/transport fixture, not an attested project or custody receipt.
        Preparation {
            input: RetainedInput {
                id: "original".into(),
                runtime_digest: "a".repeat(64),
                caller_cwd: "/original".into(),
                environment: BTreeMap::new(),
                payload: RawValue::from_string("{}".into()).unwrap(),
            },
            original: MonotonicDeadline::capture(Duration::from_secs(1)).unwrap(),
            native: None,
            owner: None,
            retained_capture: None,
            capture_failure: None,
            refusal: Some("unused native pin refusal".into()),
            exchanges: Exchanges::default(),
            native_state: None,
        }
    }
    #[test]
    fn custom_selection_can_decline_untouched_offer_without_capture_or_heartbeat_exchange() {
        let mut offer = unused_offer();
        offer.mark_ready().unwrap();
        assert!(offer.exchanges.unused);
        assert_eq!(offer.exchanges.consumed, 0);
        assert!(offer.owner.is_none());
        assert!(offer.capture_failure.is_none());
        for frame in [control(1, None), control(2, Some(&"c".repeat(64)))] {
            let mut pumps = 0;
            assert!(
                offer
                    .observe(&frame, true, offer.original.expires(), &|| false, |_, _| {
                        pumps += 1;
                        Ok(())
                    })
                    .is_err()
            );
            assert_eq!(
                pumps, 0,
                "late use cannot initialize Git or reach a consumer"
            );
        }
    }
    #[test]
    fn partial_or_malformed_capture_cannot_decline_the_offer_at_ready() {
        let mut partial = Exchanges::default();
        partial
            .admit(&control(1, None), "original", &"a".repeat(64), false)
            .unwrap();
        assert!(partial.mark_ready().is_err());
        assert!(partial.poisoned);
        let mut malformed = unused_offer();
        let mut pumps = 0;
        assert!(
            malformed
                .observe(
                    b"{}",
                    false,
                    malformed.original.expires(),
                    &|| false,
                    |_, _| {
                        pumps += 1;
                        Ok(())
                    }
                )
                .is_err()
        );
        assert_eq!(pumps, 0);
        assert!(malformed.mark_ready().is_err());
        assert!(malformed.capture_failure.is_none());
    }
    #[test]
    fn attempted_native_capture_failure_poisoning_survives_ready_and_late_frames() {
        let mut offer = unused_offer();
        let mut pumps = 0;
        assert_eq!(
            offer
                .observe(
                    &control(1, None),
                    false,
                    offer.original.expires(),
                    &|| false,
                    |_, _| {
                        pumps += 1;
                        Ok(())
                    }
                )
                .unwrap_err(),
            "unused native pin refusal"
        );
        assert_eq!(pumps, 0);
        assert!(offer.exchanges.poisoned);
        assert!(offer.mark_ready().is_err());
        assert!(
            offer
                .observe(
                    &control(2, Some(&"c".repeat(64))),
                    true,
                    offer.original.expires(),
                    &|| false,
                    |_, _| panic!("poisoned offer must not pump")
                )
                .is_err()
        );
    }
    #[test]
    fn bare_primary_is_preserved_without_fabricating_head_branch_or_detachment() {
        let rows = worktrees(b"worktree /repo/.bare\0bare\0\0").unwrap();
        assert_eq!(
            serde_json::to_value(&rows).unwrap(),
            serde_json::json!([
            {"path":"/repo/.bare","branch":null,"detached":false,"prunable":false,"bare":true}])
        );
        for record in [
            "worktree /repo/.bare\0bare\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0\0",
            "worktree /repo/.bare\0bare\0branch refs/heads/main\0\0",
            "worktree /repo/.bare\0bare\0detached\0\0",
            "worktree /repo/.bare\0bare\0bare\0\0",
        ] {
            assert!(worktrees(record.as_bytes()).is_err(), "{record:?}");
        }
        let directory = Directory::new();
        let actual = vec![Worktree {
            path: directory.0.clone(),
            branch: None,
            detached: false,
            prunable: false,
            bare: true,
        }];
        validate_bare_roots(&actual, &directory.0, &mut || Ok(())).unwrap();
        let other = Directory::new();
        assert_eq!(
            validate_bare_roots(&actual, &other.0, &mut || Ok(())).unwrap_err(),
            "bare primary does not identify the original Git common directory"
        );
    }
}
