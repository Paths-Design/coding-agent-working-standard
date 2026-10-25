//! Original-invocation selection reads owned by native code.
//!
//! Requests and serialized replies are correlation data, never authority. The
//! owner retains the actual positive and negative dependencies, exact native
//! operation-specific metadata, and original deadline. A sealed readset is necessary input to the
//! selection qualifier; it does not establish that the resolver requested every
//! mandatory input, chose the right profile, or may publish anything.
use crate::native_generation::{GenerationReceipt, RuntimeMemberDigest};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use caws_native::monotonic_deadline::MonotonicDeadline;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    collections::{BTreeSet, VecDeque},
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};

const CHUNK: usize = 64 * 1024;
const JS_MAX: u64 = 9_007_199_254_740_991;

/// Native-authored resource bounds, not values accepted from an engine frame.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub maximum_observations: usize,
    pub maximum_bytes: usize,
    pub maximum_path_bytes: usize,
    pub maximum_file_bytes: usize,
    pub maximum_directory_entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            maximum_observations: 4096,
            maximum_bytes: 64 * 1024 * 1024,
            maximum_path_bytes: 16 * 1024,
            maximum_file_bytes: 32 * 1024 * 1024,
            maximum_directory_entries: 16_384,
        }
    }
}
impl Limits {
    fn validate(self) -> Result<Self, String> {
        if [
            self.maximum_observations,
            self.maximum_bytes,
            self.maximum_path_bytes,
            self.maximum_file_bytes,
            self.maximum_directory_entries,
        ]
        .into_iter()
        .any(|n| n == 0 || n as u128 > JS_MAX as u128)
        {
            return Err("Positive safe-integer native selection limits required".into());
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum OperationKind {
    PathIdentity,
    Lstat,
    Stat,
    Exists,
    Read,
    List,
    Executable,
    RuntimeFile,
    RuntimeDigest,
    RuntimeGeneration,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Operation {
    pub kind: OperationKind,
    pub path: String,
    #[serde(
        default,
        deserialize_with = "present_single_link",
        skip_serializing_if = "Option::is_none"
    )]
    pub single_link: Option<bool>,
}
// A present null is not absence. This preserves the exact operation schema and
// lets runtime-generation reject every present singleLink field, including false.
fn present_single_link<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<bool>, D::Error> {
    bool::deserialize(deserializer).map(Some)
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionObservationRequest {
    pub snapshot_id: String,
    pub sequence: usize,
    pub operation: Operation,
}

/// Nanoseconds, inode, ownership and link count remain native evidence. The
/// millisecond JS projection in the reply is never used to revalidate identity.
#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    size: u64,
    nlink: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}
impl Stamp {
    fn of(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            mode: m.mode(),
            uid: m.uid(),
            gid: m.gid(),
            size: m.size(),
            nlink: m.nlink(),
            mtime: m.mtime(),
            mtime_nsec: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_nsec: m.ctime_nsec(),
        }
    }
}
/// Explicit path-confinement evidence. Directory inventory, contents and link
/// count belong to separate strict observations; uid/gid remain native-only.
#[derive(Debug, PartialEq, Eq)]
struct PathIdentity {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    gid: u32,
}
impl PathIdentity {
    fn of(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            mode: m.mode(),
            uid: m.uid(),
            gid: m.gid(),
        }
    }
    fn projected(&self) -> Value {
        json!({"kind":file_kind(self.mode),"dev":self.dev.to_string(),
            "ino":self.ino.to_string(),"mode":self.mode})
    }
}
/// An ancestor's directory inventory is not a dependency of every child read.
/// A list operation retains that inventory separately. Symlink identity/target
/// are retained so traversal cannot silently switch while the leaf stays equal.
#[derive(Debug, PartialEq, Eq)]
enum Anchor {
    Found {
        path: PathBuf,
        dev: u64,
        ino: u64,
        mode: u32,
        uid: u32,
        gid: u32,
        link: Option<PathBuf>,
    },
    Failed {
        path: PathBuf,
        errno: i32,
    },
}
#[derive(Debug, PartialEq, Eq)]
enum Leaf {
    Identity(PathIdentity),
    Present(Stamp),
    ExistsDirectory(PathIdentity),
    Absent,
    Failed(i32),
}
/// Followed metadata remains explicit. Only present-directory Exists omits
/// inventory size/times/link count; type/mode, dev/ino and uid/gid stay native.
#[derive(Debug, PartialEq, Eq)]
enum Followed {
    Exact(Stamp),
    ExistsDirectory(PathIdentity),
}
impl Followed {
    fn of(kind: OperationKind, metadata: &Metadata) -> Self {
        if kind == OperationKind::Exists && metadata.is_dir() {
            Self::ExistsDirectory(PathIdentity::of(metadata))
        } else {
            Self::Exact(Stamp::of(metadata))
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
struct Evidence {
    anchors: Vec<Anchor>,
    leaf: Leaf,
    followed: Option<Followed>,
    result_sha256: String,
}
struct Record {
    operation: Operation,
    observation: Value,
    evidence: Evidence,
}

/// Neither Clone nor Deserialize; construction performs actual native reads.
pub(crate) struct SelectionObservationOwner<'a> {
    generation: &'a GenerationReceipt,
    deadline: &'a MonotonicDeadline,
    roots: Vec<PathBuf>,
    real_roots: Vec<PathBuf>,
    limits: Limits,
    snapshot_id: String,
    records: Vec<Record>,
    operations: BTreeSet<(OperationKind, String, bool)>,
    bytes: usize,
    sealed: bool,
}
/// An opaque owner keeps the exact readset alive across the queue, borrowing
/// only the retained original generation and deadline. This is not serializable
/// and has no constructor accepting JSON receipts.
pub(crate) struct SelectionObservationReceipt<'native> {
    owner: SelectionObservationOwner<'native>,
}

std::thread_local! {
    // Also reject nesting through a different receipt on the same native thread.
    static VALIDATING: Cell<bool> = const { Cell::new(false) };
}

/// Only an active native readset bracket can construct this token. No cloning,
/// serialization or public constructor can bypass the complete bracket.
pub(crate) struct GenerationValidationScope<'scope, 'native> {
    generation: &'native GenerationReceipt,
    deadline: &'native MonotonicDeadline,
    active: &'scope Cell<bool>,
    owner: &'scope SelectionObservationOwner<'native>,
}
impl GenerationValidationScope<'_, '_> {
    pub(crate) fn check_binding(
        &self,
        generation: &GenerationReceipt,
        deadline: &MonotonicDeadline,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.active.get()
            || !std::ptr::eq(self.generation, generation)
            || !std::ptr::eq(self.deadline, deadline)
        {
            return Err("Scoped generation/original deadline binding mismatch".into());
        }
        checkpoint(self.deadline, cancel)
    }
}
struct ValidationGuard<'a>(&'a Cell<bool>);
impl Drop for ValidationGuard<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}
/// The transport may send these bounded chunks in its own correlated frames.
/// A reply contains the exact existing TS inner observation JSON, including the
/// explicit runtime-digest extension. Chunk delivery never renews the budget.
pub(crate) struct ObservationReply<'a> {
    bytes: Vec<u8>,
    cursor: usize,
    deadline: &'a MonotonicDeadline,
}
impl ObservationReply<'_> {
    pub(crate) fn next_chunk(
        &mut self,
        maximum: usize,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Option<&[u8]>, String> {
        checkpoint(self.deadline, &mut cancel)?;
        if maximum == 0 || maximum > CHUNK {
            return Err("Selection reply chunk bound must be 1..65536".into());
        }
        if self.cursor == self.bytes.len() {
            return Ok(None);
        }
        let end = self.bytes.len().min(self.cursor.saturating_add(maximum));
        let start = self.cursor;
        self.cursor = end;
        checkpoint(self.deadline, &mut cancel)?;
        Ok(Some(&self.bytes[start..end]))
    }
    pub(crate) fn sha256(
        &self,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<String, String> {
        let mut digest = Sha256::new();
        for chunk in self.bytes.chunks(CHUNK) {
            checkpoint(self.deadline, &mut cancel)?;
            digest.update(chunk);
        }
        checkpoint(self.deadline, &mut cancel)?;
        Ok(hex(&digest.finalize()))
    }
    pub(crate) fn byte_len(&self) -> usize {
        self.bytes.len()
    }
}

impl<'a> SelectionObservationOwner<'a> {
    /// roots must come from retained original native inputs (machine home,
    /// original project, original HOME/XDG selection roots), never engine JSON.
    /// Metadata probes on their ancestors are allowed for TS path confinement.
    pub(crate) fn new(
        generation: &'a GenerationReceipt,
        deadline: &'a MonotonicDeadline,
        roots: Vec<PathBuf>,
        limits: Limits,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        let limits = limits.validate()?;
        checkpoint(deadline, &mut cancel)?;
        if roots.is_empty() {
            return Err("Native selection roots required".into());
        }
        let mut real_roots = Vec::new();
        for root in &roots {
            validate_path(root, limits.maximum_path_bytes)?;
            checkpoint(deadline, &mut cancel)?;
            real_roots.push(resolve_root(root, deadline, &mut cancel)?);
            checkpoint(deadline, &mut cancel)?;
        }
        generation.revalidate(deadline.expires(), || checkpoint(deadline, &mut cancel))?;
        let mut nonce = [0u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut nonce))
            .map_err(|e| format!("Selection snapshot nonce: {e}"))?;
        checkpoint(deadline, &mut cancel)?;
        Ok(Self {
            generation,
            deadline,
            roots,
            real_roots,
            limits,
            snapshot_id: format!("selection-{}", hex(&nonce)),
            records: Vec::new(),
            operations: BTreeSet::new(),
            bytes: 0,
            sealed: false,
        })
    }
    pub(crate) fn snapshot_id(&self) -> &str {
        &self.snapshot_id
    }
    pub(crate) fn capture_json(
        &mut self,
        request: &[u8],
        cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<ObservationReply<'a>, String> {
        // Correlation overhead is fixed; reject an oversized frame before parse.
        if request.len() > self.limits.maximum_path_bytes.saturating_add(1024) {
            return Err("Selection observation request exceeds bound".into());
        }
        let request: SelectionObservationRequest = serde_json::from_slice(request)
            .map_err(|e| format!("Invalid selection observation request: {e}"))?;
        self.capture(request, cancel)
    }
    pub(crate) fn capture(
        &mut self,
        request: SelectionObservationRequest,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<ObservationReply<'a>, String> {
        checkpoint(self.deadline, &mut cancel)?;
        if self.sealed {
            return Err("Selection observations are sealed".into());
        }
        if request.snapshot_id != self.snapshot_id || request.sequence != self.records.len() + 1 {
            return Err("Selection observation correlation mismatch".into());
        }
        self.validate_operation(&request.operation)?;
        let key = (
            request.operation.kind,
            request.operation.path.clone(),
            request.operation.single_link.unwrap_or(false),
        );
        if self.operations.contains(&key) {
            return Err("Duplicate selection operation".into());
        }
        if self.records.len() >= self.limits.maximum_observations {
            return Err("Selection observation count exceeds bound".into());
        }
        let (result, evidence) = self.observe(&request.operation, &mut cancel)?;
        let observation = json!({"snapshotId": self.snapshot_id,
            "sequence":request.sequence,
            "observationId":format!("{}-{}",self.snapshot_id,request.sequence),
            "operation":request.operation,"result":result});
        let bytes = serde_json::to_vec(&observation).map_err(|e| e.to_string())?;
        let total = self
            .bytes
            .checked_add(bytes.len())
            .ok_or("Selection bytes overflow")?;
        if total > self.limits.maximum_bytes {
            return Err("Selection observation bytes exceed bound".into());
        }
        checkpoint(self.deadline, &mut cancel)?;
        self.records.push(Record {
            operation: request.operation,
            observation,
            evidence,
        });
        self.operations.insert(key);
        self.bytes = total;
        Ok(ObservationReply {
            bytes,
            cursor: 0,
            deadline: self.deadline,
        })
    }
    pub(crate) fn seal(
        mut self,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<SelectionObservationReceipt<'a>, String> {
        if self.sealed {
            return Err("Selection observations already sealed".into());
        }
        // A failed seal cannot be continued by requesting an alternate readset.
        self.sealed = true;
        self.revalidate(&mut cancel)?;
        Ok(SelectionObservationReceipt { owner: self })
    }
    fn revalidate(&self, cancel: &mut impl FnMut() -> Result<(), String>) -> Result<(), String> {
        checkpoint(self.deadline, cancel)?;
        self.generation.revalidate(self.deadline.expires(), || {
            checkpoint(self.deadline, cancel)
        })?;
        self.revalidate_records(cancel)?;
        // Generation hashes/inventory bracket re-reading the local readset.
        self.generation.revalidate(self.deadline.expires(), || {
            checkpoint(self.deadline, cancel)
        })?;
        checkpoint(self.deadline, cancel)
    }
    fn revalidate_records(
        &self,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        for record in &self.records {
            let (_, actual) = self.observe(&record.operation, cancel)?;
            if actual != record.evidence {
                return Err(format!(
                    "Selection dependency changed: {} {}",
                    kind_name(record.operation.kind),
                    record.operation.path
                ));
            }
        }
        checkpoint(self.deadline, cancel)
    }
    fn validate_operation(&self, operation: &Operation) -> Result<(), String> {
        let path = Path::new(&operation.path);
        validate_path(path, self.limits.maximum_path_bytes)?;
        if operation.single_link.is_some()
            && !matches!(
                operation.kind,
                OperationKind::RuntimeFile | OperationKind::RuntimeDigest
            )
        {
            return Err("singleLink is only valid for runtime reads".into());
        }
        if operation.kind == OperationKind::RuntimeGeneration
            && path.as_os_str() != self.generation.root().as_os_str()
        {
            return Err("Runtime generation summary requires the exact original root".into());
        }
        let metadata = matches!(
            operation.kind,
            OperationKind::PathIdentity
                | OperationKind::Lstat
                | OperationKind::Stat
                | OperationKind::Exists
        );
        if !self
            .roots
            .iter()
            .any(|r| path.starts_with(r) || (metadata && r.starts_with(path)))
        {
            return Err("Selection read escapes native roots".into());
        }
        if operation.kind == OperationKind::RuntimeDigest
            && !path.starts_with(self.generation.root())
        {
            return Err("Runtime digest is outside the admitted generation".into());
        }
        Ok(())
    }
    fn observe(
        &self,
        operation: &Operation,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(Value, Evidence), String> {
        checkpoint(self.deadline, cancel)?;
        let path = Path::new(&operation.path);
        let follow_leaf = !matches!(
            operation.kind,
            OperationKind::PathIdentity
                | OperationKind::Lstat
                | OperationKind::RuntimeFile
                | OperationKind::RuntimeDigest
                | OperationKind::RuntimeGeneration
        );
        let before = anchors(path, follow_leaf, self.deadline, cancel)?;
        let leaf_before = operation_leaf(path, operation.kind);
        let mut followed = None;
        let result = if operation.kind == OperationKind::RuntimeGeneration {
            let manifest =
                self.generation
                    .manifest_summary(path, self.deadline.expires(), || {
                        checkpoint(self.deadline, cancel)
                    })?;
            json!({"kind":"runtime-generation","digest":self.generation.digest(),"manifest":manifest})
        } else if operation.kind == OperationKind::RuntimeDigest {
            let relative = path
                .strip_prefix(self.generation.root())
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("Non-UTF8 runtime member")?;
            let member =
                self.generation
                    .member_digest(relative, self.deadline.expires(), || {
                        checkpoint(self.deadline, cancel)
                    })?;
            if operation.single_link.unwrap_or(false) && member.metadata.nlink != 1 {
                return Err("Native entry member is not single-link".into());
            }
            json!({"kind":"runtime-digest","sha256":member.sha256,
                "stat":member_info(&member)?})
        } else {
            // Only OS failures become captured error results. Cancellation,
            // exhausted budgets, path-policy refusal and incoherent reads abort.
            match self.read_operation(operation, cancel, &mut followed)? {
                Ok(value) => value,
                Err(error) => {
                    if operation.kind == OperationKind::Exists && absent(&error) {
                        json!({"kind":"exists","value":false})
                    } else {
                        error_result(&error)
                    }
                }
            }
        };
        checkpoint(self.deadline, cancel)?;
        let leaf_after = operation_leaf(path, operation.kind);
        let after = anchors(path, follow_leaf, self.deadline, cancel)?;
        if before != after || leaf_before != leaf_after {
            return Err(format!(
                "Selection path changed during read: {}",
                operation.path
            ));
        }
        let result_sha256 = hash(&serde_json::to_vec(&result).map_err(|e| e.to_string())?);
        Ok((
            result,
            Evidence {
                anchors: after,
                leaf: leaf_after,
                followed,
                result_sha256,
            },
        ))
    }
    fn read_operation(
        &self,
        operation: &Operation,
        cancel: &mut impl FnMut() -> Result<(), String>,
        followed: &mut Option<Followed>,
    ) -> Result<io::Result<Value>, String> {
        let path = Path::new(&operation.path);
        let metadata = matches!(
            operation.kind,
            OperationKind::PathIdentity
                | OperationKind::Lstat
                | OperationKind::Stat
                | OperationKind::Exists
        );
        if !metadata {
            checkpoint(self.deadline, cancel)?;
            match fs::canonicalize(path) {
                Ok(real) if self.real_roots.iter().any(|r| real.starts_with(r)) => {}
                Ok(_) => {
                    return Err("Selection content follows a symlink outside native roots".into());
                }
                Err(e) => return Ok(Err(e)),
            }
            checkpoint(self.deadline, cancel)?;
        }
        let value = match operation.kind {
            OperationKind::PathIdentity => fs::symlink_metadata(path)
                .map(|m| json!({"kind":"path-identity","value":PathIdentity::of(&m).projected()})),
            OperationKind::Lstat => fs::symlink_metadata(path)
                .and_then(|m| info(&m))
                .map(|value| json!({"kind":"info","value":value})),
            OperationKind::Stat | OperationKind::Exists => match fs::metadata(path) {
                Ok(m) => {
                    *followed = Some(Followed::of(operation.kind, &m));
                    if operation.kind == OperationKind::Exists {
                        Ok(json!({"kind":"exists","value":true}))
                    } else {
                        info(&m).map(|value| json!({"kind":"info","value":value}))
                    }
                }
                Err(e) => Err(e),
            },
            OperationKind::List => {
                let initial = match fs::metadata(path) {
                    Ok(m) => m,
                    Err(e) => return Ok(Err(e)),
                };
                let directory = match fs::read_dir(path) {
                    Ok(d) => d,
                    Err(e) => return Ok(Err(e)),
                };
                let mut entries = Vec::new();
                let mut names_bytes = 0usize;
                for entry in directory {
                    checkpoint(self.deadline, cancel)?;
                    let entry = match entry {
                        Ok(e) => e,
                        Err(e) => return Ok(Err(e)),
                    };
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "Non-UTF8 selection directory entry")?;
                    if name.is_empty()
                        || name == "."
                        || name == ".."
                        || name.contains('/')
                        || name.contains('\0')
                    {
                        return Err("Invalid selection directory entry".into());
                    }
                    names_bytes = names_bytes
                        .checked_add(name.len())
                        .ok_or("Selection listing bytes overflow")?;
                    if entries.len() >= self.limits.maximum_directory_entries
                        || names_bytes > self.limits.maximum_bytes
                    {
                        return Err("Selection listing exceeds bound".into());
                    }
                    entries.push(name);
                }
                entries.sort();
                let final_metadata = match fs::metadata(path) {
                    Ok(m) => m,
                    Err(e) => return Ok(Err(e)),
                };
                if Stamp::of(&initial) != Stamp::of(&final_metadata) {
                    return Err("Selection directory changed during listing".into());
                }
                *followed = Some(Followed::of(operation.kind, &final_metadata));
                Ok(json!({"kind":"listing","entries":entries}))
            }
            OperationKind::Read | OperationKind::RuntimeFile => {
                return self.read_bytes(operation, cancel, followed);
            }
            OperationKind::Executable => {
                let cpath = std::ffi::CString::new(path.as_os_str().as_bytes())
                    .map_err(|e| e.to_string())?;
                // access(X_OK) matches the existing TS adapter's real-ID check.
                if unsafe { libc::access(cpath.as_ptr(), libc::X_OK) } != 0 {
                    Err(io::Error::last_os_error())
                } else {
                    match fs::metadata(path) {
                        Ok(m) => {
                            *followed = Some(Followed::of(operation.kind, &m));
                            Ok(json!({"kind":"executable"}))
                        }
                        Err(e) => Err(e),
                    }
                }
            }
            OperationKind::RuntimeDigest | OperationKind::RuntimeGeneration => unreachable!(),
        };
        checkpoint(self.deadline, cancel)?;
        Ok(value)
    }
    fn read_bytes(
        &self,
        operation: &Operation,
        cancel: &mut impl FnMut() -> Result<(), String>,
        followed: &mut Option<Followed>,
    ) -> Result<io::Result<Value>, String> {
        let path = Path::new(&operation.path);
        let runtime = operation.kind == OperationKind::RuntimeFile;
        let initial = match if runtime {
            fs::symlink_metadata(path)
        } else {
            fs::metadata(path)
        } {
            Ok(m) => m,
            Err(e) => return Ok(Err(e)),
        };
        if !initial.is_file() {
            return Ok(Err(io::Error::from_raw_os_error(if initial.is_dir() {
                libc::EISDIR
            } else {
                libc::EINVAL
            })));
        }
        if operation.single_link.unwrap_or(false) && initial.nlink() != 1 {
            return Err("Native entry member is not single-link".into());
        }
        if initial.size() > self.limits.maximum_file_bytes as u64 {
            return Err("Selection file exceeds native byte bound".into());
        }
        let flags = libc::O_CLOEXEC | libc::O_NONBLOCK | if runtime { libc::O_NOFOLLOW } else { 0 };
        let mut file = match OpenOptions::new().read(true).custom_flags(flags).open(path) {
            Ok(f) => f,
            Err(e) => return Ok(Err(e)),
        };
        let opened = match file.metadata() {
            Ok(m) => m,
            Err(e) => return Ok(Err(e)),
        };
        if Stamp::of(&initial) != Stamp::of(&opened) {
            return Err("Selection file replaced before read".into());
        }
        let mut bytes = Vec::new();
        let mut chunk = [0u8; CHUNK];
        loop {
            checkpoint(self.deadline, cancel)?;
            let count = match file.read(&mut chunk) {
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Ok(Err(e)),
            };
            if count == 0 {
                break;
            }
            if bytes
                .len()
                .checked_add(count)
                .filter(|n| *n <= self.limits.maximum_file_bytes)
                .is_none()
            {
                return Err("Selection file exceeds native byte bound".into());
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        let finished = match file.metadata() {
            Ok(m) => m,
            Err(e) => return Ok(Err(e)),
        };
        let pathname = match if runtime {
            fs::symlink_metadata(path)
        } else {
            fs::metadata(path)
        } {
            Ok(m) => m,
            Err(e) => return Ok(Err(e)),
        };
        if Stamp::of(&initial) != Stamp::of(&finished)
            || Stamp::of(&initial) != Stamp::of(&pathname)
            || finished.size() != bytes.len() as u64
        {
            return Err("Selection file changed during read".into());
        }
        *followed = Some(Followed::of(operation.kind, &finished));
        checkpoint(self.deadline, cancel)?;
        if runtime {
            Ok(info(&finished).map(
                |stat| json!({"kind":"runtime-file","base64":STANDARD.encode(&bytes),"stat":stat}),
            ))
        } else {
            Ok(Ok(json!({"kind":"bytes","base64":STANDARD.encode(&bytes)})))
        }
    }
}
impl<'native> SelectionObservationReceipt<'native> {
    /// Native-only binding accessors; no engine field supplies these facts.
    pub(crate) fn runtime_digest(&self) -> &str {
        self.owner.generation.digest()
    }
    pub(crate) fn generation_root(&self) -> &Path {
        self.owner.generation.root()
    }
    pub(crate) fn deadline(&self) -> &MonotonicDeadline {
        self.owner.deadline
    }
    pub(crate) fn snapshot_id(&self) -> &str {
        self.owner.snapshot_id()
    }
    pub(crate) fn revalidate(
        &self,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        if VALIDATING.with(Cell::get) {
            return Err("Nested selection validation is not permitted".into());
        }
        self.owner.revalidate(&mut cancel)
    }
    /// Full hashes/inventory enclose both local sweeps and the native-only
    /// profile/SQLite work. A callback result cannot return before the second
    /// sweep and full verification. Its fresh token lifetime cannot escape.
    pub(crate) fn validate_with<T, E, C>(
        &self,
        mut cancel: C,
        checks: impl for<'scope> FnOnce(
            &GenerationValidationScope<'scope, 'native>,
            &mut C,
        ) -> Result<T, E>,
    ) -> Result<T, E>
    where
        C: FnMut() -> Result<(), String>,
        E: From<String>,
    {
        VALIDATING.with(|active| {
            if active.replace(true) {
                return Err(E::from(
                    "Nested selection validation is not permitted".into(),
                ));
            }
            let guard = ValidationGuard(active);
            checkpoint(self.owner.deadline, &mut cancel).map_err(E::from)?;
            self.owner
                .generation
                .revalidate(self.owner.deadline.expires(), || {
                    checkpoint(self.owner.deadline, &mut cancel)
                })
                .map_err(E::from)?;
            self.owner
                .revalidate_records(&mut cancel)
                .map_err(E::from)?;
            let scope = GenerationValidationScope {
                generation: self.owner.generation,
                deadline: self.owner.deadline,
                active: guard.0,
                owner: &self.owner,
            };
            let result = checks(&scope, &mut cancel);
            self.owner
                .revalidate_records(&mut cancel)
                .map_err(E::from)?;
            self.owner
                .generation
                .revalidate(self.owner.deadline.expires(), || {
                    checkpoint(self.owner.deadline, &mut cancel)
                })
                .map_err(E::from)?;
            checkpoint(self.owner.deadline, &mut cancel).map_err(E::from)?;
            result
        })
    }
    /// Keep each phase's readset sweeps inside one fresh generation bracket.
    /// A token from another receipt cannot supply this owner's validation.
    pub(crate) fn validate_in_scope<T, E, C>(
        &self,
        scope: &GenerationValidationScope<'_, 'native>,
        cancel: &mut C,
        checks: impl FnOnce(&mut C) -> Result<T, E>,
    ) -> Result<T, E>
    where
        C: FnMut() -> Result<(), String>,
        E: From<String>,
    {
        if !std::ptr::eq(scope.owner, &self.owner) {
            return Err(E::from("Scoped selection owner mismatch".into()));
        }
        scope
            .check_binding(self.owner.generation, self.owner.deadline, cancel)
            .map_err(E::from)?;
        self.owner.revalidate_records(cancel).map_err(E::from)?;
        let result = checks(cancel);
        self.owner.revalidate_records(cancel).map_err(E::from)?;
        scope
            .check_binding(self.owner.generation, self.owner.deadline, cancel)
            .map_err(E::from)?;
        result
    }
    /// Native qualifier consumes these retained native-produced values. An
    /// engine echo of an equal JSON value cannot construct this borrowed owner.
    pub(crate) fn observations(&self) -> impl Iterator<Item = &Value> {
        self.owner.records.iter().map(|record| &record.observation)
    }
    pub(crate) fn runtime_member(
        &self,
        relative: &str,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<RuntimeMemberDigest, String> {
        checkpoint(self.owner.deadline, &mut cancel)?;
        self.owner
            .generation
            .member_digest(relative, self.owner.deadline.expires(), || {
                checkpoint(self.owner.deadline, &mut cancel)
            })
    }
}
fn checkpoint(
    deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    deadline.check().map_err(|e| e.to_string())?;
    cancel()?;
    deadline.check().map_err(|e| e.to_string())
}
fn kind_name(kind: OperationKind) -> &'static str {
    match kind {
        OperationKind::PathIdentity => "path-identity",
        OperationKind::Lstat => "lstat",
        OperationKind::Stat => "stat",
        OperationKind::Exists => "exists",
        OperationKind::Read => "read",
        OperationKind::List => "list",
        OperationKind::Executable => "executable",
        OperationKind::RuntimeFile => "runtime-file",
        OperationKind::RuntimeDigest => "runtime-digest",
        OperationKind::RuntimeGeneration => "runtime-generation",
    }
}
fn validate_path(path: &Path, maximum: usize) -> Result<(), String> {
    if !path.is_absolute()
        || path.as_os_str().as_bytes().len() > maximum
        || path.as_os_str().as_bytes().contains(&0)
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || path.to_str().is_none()
    {
        return Err("Absolute normalized bounded UTF-8 selection path required".into());
    }
    Ok(())
}
fn absent(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOENT) | Some(libc::ENOTDIR)
    )
}
fn operation_leaf(path: &Path, kind: OperationKind) -> Leaf {
    if !matches!(kind, OperationKind::PathIdentity | OperationKind::Exists) {
        return optional_stamp(path, false);
    }
    match fs::symlink_metadata(path) {
        Ok(m) if kind == OperationKind::PathIdentity => Leaf::Identity(PathIdentity::of(&m)),
        Ok(m) if m.is_dir() => Leaf::ExistsDirectory(PathIdentity::of(&m)),
        // A symlink leaf keeps its exact link stamp even when its followed
        // target is a directory; resolved target/ancestry remain separate.
        Ok(m) => Leaf::Present(Stamp::of(&m)),
        Err(e) if absent(&e) => Leaf::Absent,
        Err(e) => Leaf::Failed(e.raw_os_error().unwrap_or(0)),
    }
}
fn optional_stamp(path: &Path, follow: bool) -> Leaf {
    match if follow {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    } {
        Ok(m) => Leaf::Present(Stamp::of(&m)),
        Err(e) if absent(&e) => Leaf::Absent,
        Err(e) => Leaf::Failed(e.raw_os_error().unwrap_or(0)),
    }
}
fn anchors(
    path: &Path,
    follow_leaf: bool,
    deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<Vec<Anchor>, String> {
    let mut result = Vec::new();
    for parent in path.ancestors().skip(1) {
        checkpoint(deadline, cancel)?;
        let m = match fs::symlink_metadata(parent) {
            Ok(m) => m,
            Err(e) if absent(&e) => continue,
            Err(e) => {
                result.push(Anchor::Failed {
                    path: parent.into(),
                    errno: e.raw_os_error().unwrap_or(0),
                });
                continue;
            }
        };
        let link = if m.file_type().is_symlink() {
            match fs::read_link(parent) {
                Ok(link) => Some(link),
                Err(e) => {
                    result.push(Anchor::Failed {
                        path: parent.into(),
                        errno: e.raw_os_error().unwrap_or(0),
                    });
                    continue;
                }
            }
        } else {
            None
        };
        result.push(Anchor::Found {
            path: parent.into(),
            dev: m.dev(),
            ino: m.ino(),
            mode: m.mode(),
            uid: m.uid(),
            gid: m.gid(),
            link,
        });
    }
    // Lexical anchors alone miss a replaced symlink target directory when
    // both directories contain a preexisting hardlink to the same leaf. Walk
    // the actual target chain, retaining every traversed object identity.
    result.extend(resolved_anchors(path, follow_leaf, deadline, cancel)?);
    checkpoint(deadline, cancel)?;
    Ok(result)
}
#[derive(Debug)]
enum TraversalComponent {
    Root,
    Parent,
    Name(std::ffi::OsString),
}
fn components(path: &Path) -> Result<VecDeque<TraversalComponent>, String> {
    path.components()
        .filter_map(|component| match component {
            Component::RootDir => Some(Ok(TraversalComponent::Root)),
            Component::ParentDir => Some(Ok(TraversalComponent::Parent)),
            Component::Normal(name) => Some(Ok(TraversalComponent::Name(name.to_owned()))),
            Component::CurDir => None,
            Component::Prefix(_) => Some(Err("Unsupported selection traversal prefix".into())),
        })
        .collect()
}
fn resolved_anchors(
    path: &Path,
    follow_leaf: bool,
    deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<Vec<Anchor>, String> {
    let target = if follow_leaf {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    let mut pending = components(target)?;
    let mut resolved = PathBuf::from("/");
    let mut result = Vec::new();
    let mut links = 0usize;
    let mut steps = 0usize;
    while let Some(component) = pending.pop_front() {
        checkpoint(deadline, cancel)?;
        steps += 1;
        if steps > 16_384 {
            return Err("Selection traversal exceeds native component bound".into());
        }
        match component {
            TraversalComponent::Root => {
                resolved = PathBuf::from("/");
            }
            TraversalComponent::Parent => {
                resolved.pop();
                if resolved.as_os_str().is_empty() {
                    resolved.push("/");
                }
            }
            TraversalComponent::Name(name) => {
                resolved.push(name);
            }
        }
        let metadata = match fs::symlink_metadata(&resolved) {
            Ok(metadata) => metadata,
            Err(error) => {
                // Missing and denied target paths are dependencies too. Do not
                // turn a denied traversal into a false existence result.
                result.push(Anchor::Failed {
                    path: resolved.clone(),
                    errno: error.raw_os_error().unwrap_or(0),
                });
                break;
            }
        };
        let link = if metadata.file_type().is_symlink() {
            match fs::read_link(&resolved) {
                Ok(target) => Some(target),
                Err(error) => {
                    result.push(Anchor::Failed {
                        path: resolved.clone(),
                        errno: error.raw_os_error().unwrap_or(0),
                    });
                    break;
                }
            }
        } else {
            None
        };
        result.push(Anchor::Found {
            path: resolved.clone(),
            dev: metadata.dev(),
            ino: metadata.ino(),
            mode: metadata.mode(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            link: link.clone(),
        });
        if let Some(target) = link {
            links += 1;
            if links > 40 {
                result.push(Anchor::Failed {
                    path: resolved.clone(),
                    errno: libc::ELOOP,
                });
                break;
            }
            // Relative targets start at the symlink's containing directory;
            // absolute targets reset at Root. Preserve all target components,
            // including objects traversed before '..', and nested symlinks.
            resolved.pop();
            let mut target_components = components(&target)?;
            target_components.append(&mut pending);
            pending = target_components;
        }
    }
    checkpoint(deadline, cancel)?;
    Ok(result)
}
/// Resolve a native-authored root even if its final selection directory is
/// absent. Canonicalize the existing ancestor, retaining the lexical remainder.
fn resolve_root(
    path: &Path,
    deadline: &MonotonicDeadline,
    cancel: &mut impl FnMut() -> Result<(), String>,
) -> Result<PathBuf, String> {
    let mut existing = path;
    let mut remainder = Vec::new();
    loop {
        checkpoint(deadline, cancel)?;
        match fs::canonicalize(existing) {
            Ok(mut root) => {
                for name in remainder.into_iter().rev() {
                    root.push(name);
                }
                return Ok(root);
            }
            Err(e) if absent(&e) => {
                remainder.push(
                    existing
                        .file_name()
                        .ok_or("Selection root has no existing ancestor")?
                        .to_os_string(),
                );
                existing = existing
                    .parent()
                    .ok_or("Selection root has no existing ancestor")?;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}
fn error_result(error: &io::Error) -> Value {
    let code = match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        Some(libc::ELOOP) => "ELOOP",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::EMFILE) => "EMFILE",
        Some(libc::ENFILE) => "ENFILE",
        Some(libc::EIO) => "EIO",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::EOVERFLOW) => "EOVERFLOW",
        _ => "EUNKNOWN",
    };
    json!({"kind":"error","name":"Error","message":error.to_string(),"code":code})
}
fn file_kind(mode: u32) -> &'static str {
    match mode & libc::S_IFMT as u32 {
        value if value == libc::S_IFREG as u32 => "file",
        value if value == libc::S_IFDIR as u32 => "directory",
        value if value == libc::S_IFLNK as u32 => "symlink",
        _ => "other",
    }
}
fn info(m: &Metadata) -> io::Result<Value> {
    projected_info(
        m.mode(),
        m.dev(),
        m.ino(),
        m.size(),
        m.nlink(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn member_info(member: &RuntimeMemberDigest) -> Result<Value, String> {
    let m = &member.metadata;
    projected_info(
        m.mode,
        m.dev,
        m.ino,
        m.size,
        m.nlink,
        m.mtime,
        m.mtime_nsec,
        m.ctime,
        m.ctime_nsec,
    )
    .map_err(|e| e.to_string())
}
#[allow(clippy::too_many_arguments)]
fn projected_info(
    mode: u32,
    dev: u64,
    ino: u64,
    size: u64,
    nlink: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
) -> io::Result<Value> {
    if size > JS_MAX || nlink > JS_MAX {
        return Err(io::Error::from_raw_os_error(libc::EOVERFLOW));
    }
    let kind = file_kind(mode);
    Ok(
        json!({"kind":kind,"dev":dev.to_string(),"ino":ino.to_string(),"size":size,"mode":mode,"nlink":nlink,
        "mtimeMs":mtime as f64*1000.0+mtime_nsec as f64/1_000_000.0,
        "ctimeMs":ctime as f64*1000.0+ctime_nsec as f64/1_000_000.0}),
    )
}
fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, os::unix::fs::symlink, time::Duration};

    // This fixture verifies filesystem observation and generation binding. Its
    // synthetic generation is not proof that an actual installed image ran.
    fn fixture(action: impl FnOnce(&GenerationReceipt, &Path, &Path)) {
        crate::native_generation::with_selection_generation_fixture(action)
    }
    fn deadline() -> MonotonicDeadline {
        MonotonicDeadline::capture(Duration::from_secs(30)).unwrap()
    }
    fn owner<'a>(
        generation: &'a GenerationReceipt,
        deadline: &'a MonotonicDeadline,
        home: &Path,
    ) -> SelectionObservationOwner<'a> {
        SelectionObservationOwner::new(
            generation,
            deadline,
            vec![home.into()],
            Limits::default(),
            || Ok(()),
        )
        .unwrap()
    }
    fn request(
        owner: &SelectionObservationOwner<'_>,
        kind: OperationKind,
        path: &Path,
        single_link: Option<bool>,
    ) -> SelectionObservationRequest {
        SelectionObservationRequest {
            snapshot_id: owner.snapshot_id().into(),
            sequence: owner.records.len() + 1,
            operation: Operation {
                kind,
                path: path.to_str().unwrap().into(),
                single_link,
            },
        }
    }
    fn capture(
        owner: &mut SelectionObservationOwner<'_>,
        kind: OperationKind,
        path: &Path,
    ) -> Value {
        let request = request(owner, kind, path, None);
        let mut reply = owner.capture(request, || Ok(())).unwrap();
        let mut bytes = Vec::new();
        while let Some(chunk) = reply.next_chunk(13, || Ok(())).unwrap() {
            bytes.extend_from_slice(chunk);
        }
        serde_json::from_slice(&bytes).unwrap()
    }
    fn effect_after_revalidation(
        receipt: &SelectionObservationReceipt<'_>,
        effects: &Cell<usize>,
    ) -> Result<(), String> {
        receipt.revalidate(|| Ok(()))?;
        effects.set(effects.get() + 1);
        Ok(())
    }
    fn retain(home: &Path, name: &str, value: Value) {
        if std::env::var_os("CAWS_NATIVE_GENERATION_TEST_ARTIFACTS").is_some() {
            let path = home.join(format!("selection-{name}.json"));
            fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
            println!("selection observation artifact: {}", path.display());
        }
    }

    #[test]
    fn root_custody_survives_actual_outer_and_scoped_closing_readset_refusals() {
        use crate::stop_git::{CustodiedFailure, RetainedFailures};
        use std::rc::Rc;

        // A cleanup-only owner tests storage and drop ordering. This constructs
        // no Git permission, actual custodian, or native Stop eligibility.
        struct CleanupOwner {
            retained: bool,
            attempts: Rc<Cell<usize>>,
            drops: Rc<Cell<usize>>,
        }
        impl Drop for CleanupOwner {
            fn drop(&mut self) {
                self.drops.set(self.drops.get() + 1);
            }
        }
        impl CustodiedFailure for CleanupOwner {
            fn diagnostic(&self) -> &str {
                "synthetic Git failure"
            }
            fn custodian_retained(&self) -> bool {
                self.retained
            }
            fn cleanup_settled(&self) -> bool {
                !self.retained
            }
            fn retry_cleanup(&mut self) -> Result<(), String> {
                assert!(self.retained);
                self.attempts.set(self.attempts.get() + 1);
                self.retained = false;
                Ok(())
            }
        }
        for scoped in [false, true] {
            fixture(|generation, home, _root| {
                let policy = home.join("custody-policy.json");
                fs::write(&policy, b"original").unwrap();
                let clock = deadline();
                let original_envelope = clock.envelope();
                let mut observed = owner(generation, &clock, home);
                capture(&mut observed, OperationKind::Read, &policy);
                let receipt = observed.seal(|| Ok(())).unwrap();
                let attempts = Rc::new(Cell::new(0));
                let drops = Rc::new(Cell::new(0));
                let calls = Cell::new(0);
                // Root ownership is outside both real validation brackets.
                let mut custody = RetainedFailures::default();
                let result: Result<(), String> = receipt.validate_with(
                    || Ok(()),
                    |scope, cancel| {
                        let mut checks = || {
                            calls.set(calls.get() + 1);
                            let failure: Result<(), CleanupOwner> = Err(CleanupOwner {
                                retained: true,
                                attempts: attempts.clone(),
                                drops: drops.clone(),
                            });
                            let result = custody.retain(failure);
                            // This mutation occurs only after the actual owner
                            // moved to root storage and became a String error.
                            fs::write(&policy, b"changed in callback").unwrap();
                            result
                        };
                        let result = if scoped {
                            receipt.validate_in_scope(scope, cancel, |_| checks())
                        } else {
                            checks()
                        };
                        custody.preserve(result)
                    },
                );
                let closing = result.as_ref().unwrap_err();
                assert!(
                    closing.starts_with("Selection dependency changed"),
                    "{closing}"
                );
                let error = custody.preserve(result).unwrap_err();
                assert!(
                    error.starts_with("synthetic Git failure; subsequent validation failure: ")
                );
                assert!(error.contains("Selection dependency changed"));
                assert_eq!(calls.get(), 1);
                assert_eq!(attempts.get(), 0);
                assert_eq!(
                    drops.get(),
                    0,
                    "real closing sweep cannot drop root custody"
                );
                assert_eq!(clock.envelope(), original_envelope);
                assert!(custody.settle_cleanup().is_none());
                assert_eq!(attempts.get(), 1);
                assert_eq!(drops.get(), 0, "root retains record through output");
                drop(custody);
                assert_eq!(drops.get(), 1);
                retain(
                    home,
                    if scoped {
                        "scoped-custody"
                    } else {
                        "outer-custody"
                    },
                    json!({
                        "callbackCalls": calls.get(), "cleanupAttempts": attempts.get(),
                        "dropsAfterRootRelease": drops.get(), "closingRefusal": error,
                        "originalDeadlineUnchanged": clock.envelope() == original_envelope,
                        "scope": "actual generation/readset brackets with synthetic cleanup owner; no native Stop or actual Git custodian proof"
                    }),
                );
            });
        }
    }

    #[test]
    fn scoped_phases_keep_local_sweeps_and_exact_owner_inside_two_full_checks() {
        fixture(|generation, home, _root| {
            let policy = home.join("phase-policy.json");
            fs::write(&policy, b"original").unwrap();
            let clock = deadline();
            let mut observed = owner(generation, &clock, home);
            capture(&mut observed, OperationKind::Read, &policy);
            let receipt = observed.seal(|| Ok(())).unwrap();
            let other = owner(generation, &clock, home).seal(|| Ok(())).unwrap();
            let before = crate::installed_generation::verification_count();
            let phases = Cell::new(0);
            let wrong_owner_calls = Cell::new(0);
            let result: Result<Vec<usize>, String> = receipt.validate_with(
                || Ok(()),
                |scope, cancel| {
                    let wrong: Result<(), String> = other.validate_in_scope(scope, cancel, |_| {
                        wrong_owner_calls.set(1);
                        Ok(())
                    });
                    assert_eq!(wrong.unwrap_err(), "Scoped selection owner mismatch");
                    (1..=3)
                        .map(|phase| {
                            receipt.validate_in_scope(scope, cancel, |_| {
                                phases.set(phases.get() + 1);
                                Ok(phase)
                            })
                        })
                        .collect()
                },
            );
            assert_eq!(result.unwrap(), vec![1, 2, 3]);
            let scans = crate::installed_generation::verification_count() - before;
            assert_eq!(scans, 2);
            assert_eq!(phases.get(), 3);
            assert_eq!(wrong_owner_calls.get(), 0);

            let later_phase_calls = Cell::new(0);
            let result: Result<(), String> = receipt.validate_with(
                || Ok(()),
                |scope, cancel| {
                    let changed: Result<Option<()>, String> =
                        receipt.validate_in_scope(scope, cancel, |_| {
                            fs::write(&policy, b"changed during unsupported phase").unwrap();
                            Ok(None)
                        });
                    // The phase's own closing sweep refuses before subsequent work,
                    // even though the outer bracket would also reject this change.
                    assert!(
                        changed
                            .as_ref()
                            .unwrap_err()
                            .contains("Selection dependency changed")
                    );
                    changed?;
                    later_phase_calls.set(1);
                    Ok(())
                },
            );
            assert!(result.unwrap_err().contains("Selection dependency changed"));
            assert_eq!(later_phase_calls.get(), 0);
            retain(
                home,
                "pregrant-phases",
                json!({
                    "actualFullVerifications":scans,"purePhases":phases.get(),
                    "foreignOwnerCalls":wrong_owner_calls.get(),
                    "phasesAfterInvalidation":later_phase_calls.get(),
                    "scope":"actual readset and generation checks; synthetic image, no EligibleStop or dispatch"
                }),
            );
        });
    }

    #[test]
    fn coalesced_validation_runs_two_real_full_verifications_and_rejects_nested_work() {
        fixture(|generation, home, _root| {
            let policy = home.join("scope-policy.json");
            fs::write(&policy, b"unchanged").unwrap();
            let clock = deadline();
            let mut observed = owner(generation, &clock, home);
            capture(&mut observed, OperationKind::Read, &policy);
            let receipt = observed.seal(|| Ok(())).unwrap();
            let before = crate::installed_generation::verification_count();
            let work = Cell::new(0);
            let result: Result<usize, String> = receipt.validate_with(
                || Ok(()),
                |scope, cancel| {
                    scope.check_binding(generation, &clock, cancel)?;
                    let nested: Result<(), String> =
                        receipt.validate_with(|| Ok(()), |_, _| Ok(()));
                    assert!(nested.unwrap_err().contains("Nested"));
                    assert!(
                        receipt
                            .revalidate(|| Ok(()))
                            .unwrap_err()
                            .contains("Nested")
                    );
                    work.set(work.get() + 1);
                    Ok(17)
                },
            );
            assert_eq!(result.unwrap(), 17);
            let scans = crate::installed_generation::verification_count() - before;
            assert_eq!(
                scans, 2,
                "count actual verify_files calls, not mocked scope entries"
            );
            assert_eq!(work.get(), 1);
            receipt.revalidate(|| Ok(())).unwrap(); // scope guard was released
            retain(
                home,
                "coalesced-count",
                json!({"actualFullVerifications":scans,"innerCalls":work.get(),"returned":17,"nestedRefused":true,"syntheticGeneration":true}),
            );
        });
    }

    #[test]
    fn coalesced_validation_refuses_expiry_during_inner_unsupported_none() {
        // This pins closing-scope expiry, not actual EligibleStop construction.
        fixture(|generation, home, _root| {
            let clock = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
            let original_envelope = clock.envelope();
            let receipt = owner(generation, &clock, home).seal(|| Ok(())).unwrap();
            let inner_calls = Cell::new(0);
            let positive: Result<Option<()>, String> = receipt.validate_with(
                || Ok(()),
                |scope, cancel| {
                    scope.check_binding(generation, &clock, cancel)?;
                    inner_calls.set(inner_calls.get() + 1);
                    Ok(None)
                },
            );
            assert_eq!(
                positive.unwrap(),
                None,
                "fresh unsupported result remains compatibility"
            );
            let result: Result<Option<()>, String> = receipt.validate_with(
                || Ok(()),
                |scope, cancel| {
                    scope.check_binding(generation, &clock, cancel)?;
                    // Consume the unchanged real original deadline only after
                    // the inner work was reached. No receipt/clock is forged.
                    std::thread::sleep(
                        clock
                            .expires()
                            .saturating_duration_since(std::time::Instant::now())
                            + Duration::from_millis(2),
                    );
                    assert_eq!(
                        clock.check().unwrap_err().to_string(),
                        "Original monotonic deadline expired"
                    );
                    inner_calls.set(inner_calls.get() + 1);
                    Ok(None)
                },
            );
            let error =
                result.expect_err("expired inner Ok(None) must not escape as compatibility");
            assert_eq!(error, "Original monotonic deadline expired");
            assert_eq!(
                inner_calls.get(),
                2,
                "both callbacks actually returned unsupported None"
            );
            assert_eq!(clock.envelope(), original_envelope);

            // A failed closing check must release the thread's scope guard.
            // This is a distinct control invocation, not a renewed old clock.
            let fresh_clock = deadline();
            let fresh = owner(generation, &fresh_clock, home)
                .seal(|| Ok(()))
                .unwrap();
            let subsequent: Result<Option<()>, String> =
                fresh.validate_with(|| Ok(()), |_, _| Ok(None));
            assert_eq!(subsequent.unwrap(), None);
            retain(
                home,
                "coalesced-expired-inner-none",
                json!({"error":error,"innerCalls":inner_calls.get(),"innerReturnedNone":true,
                    "expiredUnsupportedNotReturned":true,"originalDeadlineUnchanged":true,
                    "guardReleased":true,"syntheticGeneration":true,"actualEligibilityConstructed":false}),
            );
        });
    }

    #[test]
    fn coalesced_validation_refuses_changed_readset_after_inner_unsupported_result() {
        fixture(|generation, home, _root| {
            let policy = home.join("scope-policy.json");
            fs::write(&policy, b"before").unwrap();
            let clock = deadline();
            let mut observed = owner(generation, &clock, home);
            capture(&mut observed, OperationKind::Read, &policy);
            let receipt = observed.seal(|| Ok(())).unwrap();
            let result: Result<(), String> = receipt.validate_with(
                || Ok(()),
                |_, _| {
                    fs::write(&policy, b"after!").unwrap();
                    Err("inner unsupported fixture".into())
                },
            );
            let error = result.unwrap_err();
            assert!(error.contains("Selection dependency changed"), "{error}");
            assert!(!error.contains("inner unsupported"));
            retain(
                home,
                "coalesced-late-readset",
                json!({"error":error,"innerResultNotReturned":true,"syntheticGeneration":true}),
            );
        });
    }

    #[test]
    fn coalesced_validation_refuses_same_byte_generation_replacement_at_closing_bracket() {
        fixture(|generation, home, root| {
            let policy = home.join("scope-policy.json");
            fs::write(&policy, b"unchanged").unwrap();
            let clock = deadline();
            let mut observed = owner(generation, &clock, home);
            capture(&mut observed, OperationKind::Read, &policy);
            let receipt = observed.seal(|| Ok(())).unwrap();
            let result: Result<usize, String> = receipt.validate_with(
                || Ok(()),
                |_, _| {
                    let engine = root.join("engine.js");
                    let replacement = home.join("replacement-engine");
                    fs::write(&replacement, fs::read(&engine).unwrap()).unwrap();
                    fs::set_permissions(&replacement, fs::metadata(&engine).unwrap().permissions())
                        .unwrap();
                    fs::rename(&replacement, &engine).unwrap();
                    Ok(23)
                },
            );
            let error = result.unwrap_err();
            assert!(
                matches!(
                    error.as_str(),
                    "Admitted generation directory changed" | "Admitted generation member changed"
                ),
                "{error}"
            );
            retain(
                home,
                "coalesced-closing-generation",
                json!({"error":error,"sameByteReplacement":true,"valueNotReturned":23,"syntheticGeneration":true}),
            );
        });
    }

    #[test]
    fn coalesced_scope_binds_exact_native_generation_clock_and_cancellation() {
        fixture(|generation, home, _| {
            fixture(|other, other_home, _| {
                let clock = deadline();
                let alien_clock = deadline();
                let other_receipt = owner(other, &clock, other_home).seal(|| Ok(())).unwrap();
                let receipt = owner(generation, &clock, home).seal(|| Ok(())).unwrap();
                let result: Result<(), String> = receipt.validate_with(
                    || Ok(()),
                    |scope, cancel| {
                        let nested: Result<(), String> =
                            other_receipt.validate_with(|| Ok(()), |_, _| Ok(()));
                        assert!(nested.unwrap_err().contains("Nested"));
                        assert!(
                            scope
                                .check_binding(other, &clock, cancel)
                                .unwrap_err()
                                .contains("binding mismatch")
                        );
                        assert!(
                            scope
                                .check_binding(generation, &alien_clock, cancel)
                                .unwrap_err()
                                .contains("binding mismatch")
                        );
                        scope.check_binding(generation, &clock, cancel)
                    },
                );
                result.unwrap();
                let cancelled = Cell::new(false);
                let result: Result<(), String> = receipt.validate_with(
                    || {
                        if cancelled.get() {
                            Err("original scope cancellation".into())
                        } else {
                            Ok(())
                        }
                    },
                    |_, _| {
                        cancelled.set(true);
                        Ok(())
                    },
                );
                assert_eq!(result.unwrap_err(), "original scope cancellation");
                receipt.revalidate(|| Ok(())).unwrap();
                retain(
                    home,
                    "coalesced-binding-cancel",
                    json!({"foreignGenerationRefused":true,"differentOriginalClockRefused":true,"cancelCause":"original scope cancellation","guardReleased":true,"syntheticGeneration":true}),
                );
            })
        });
    }

    #[cfg(feature = "sqlite-store")]
    #[test]
    fn coalesced_scope_checks_actual_linked_sqlite_without_nested_full_verifications() {
        use crate::sqlite_build_identity::{ExpectedSqliteIdentity, SqliteIdentityReceipt};
        fixture(|generation, home, _| {
            let clock = deadline();
            let observed = crate::sqlite_build_identity::observe(&clock, || Ok(())).unwrap();
            let value = serde_json::to_value(&observed).unwrap();
            let expected = |source: String| {
                ExpectedSqliteIdentity::from_expected_data(
                    value["version"].as_str().unwrap().into(),
                    source,
                    value["threadSafe"].as_i64().unwrap() as i32,
                    value["compileOptions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap().into())
                        .collect(),
                    value["compiledPrefixSha256"].as_str().unwrap().into(),
                )
                .unwrap()
            };
            let expected_identity = expected(value["sourceId"].as_str().unwrap().into());
            let receipt = owner(generation, &clock, home).seal(|| Ok(())).unwrap();
            let before = crate::installed_generation::verification_count();
            let result: Result<(), String> = receipt.validate_with(
                || Ok(()),
                |scope, mut cancel| {
                    let linked = SqliteIdentityReceipt::capture_in_scope(
                        scope,
                        generation,
                        &expected_identity,
                        &clock,
                        &mut cancel,
                    )?;
                    linked.revalidate_in_scope(scope, &mut cancel)
                },
            );
            result.unwrap();
            let scans = crate::installed_generation::verification_count() - before;
            assert_eq!(scans, 2);
            let wrong = expected(format!(
                "{}-unqualified",
                value["sourceId"].as_str().unwrap()
            ));
            let result: Result<SqliteIdentityReceipt<'_>, String> = receipt.validate_with(
                || Ok(()),
                |scope, cancel| {
                    SqliteIdentityReceipt::capture_in_scope(
                        scope, generation, &wrong, &clock, cancel,
                    )
                },
            );
            let error = result
                .err()
                .expect("changed actual SQLite identity must refuse");
            assert!(
                error.contains("SQLite identity mismatch: sourceId"),
                "{error}"
            );
            retain(
                home,
                "coalesced-actual-sqlite",
                json!({"actualLinked":value,"actualFullVerifications":scans,"changedExpectedError":error,"syntheticGeneration":true,"noStockOrSemanticGrant":true}),
            );
        });
    }

    #[test]
    fn path_identity_accepts_unrelated_sibling_inventory_changes() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let directory = home.join("identity-directory");
            fs::create_dir(&directory).unwrap();
            let original = fs::symlink_metadata(&directory).unwrap();
            let mut observed = owner(generation, &clock, home);
            let row = capture(&mut observed, OperationKind::PathIdentity, &directory);
            assert_eq!(
                row["result"],
                json!({"kind":"path-identity","value":{
                    "kind":"directory","dev":original.dev().to_string(),
                    "ino":original.ino().to_string(),"mode":original.mode()}})
            );
            fs::write(directory.join("before-seal"), b"sibling").unwrap();
            let receipt = observed.seal(|| Ok(())).unwrap();
            fs::write(directory.join("after-seal"), b"another sibling").unwrap();
            let effects = Cell::new(0);
            effect_after_revalidation(&receipt, &effects).unwrap();
            assert_eq!(effects.get(), 1);
        });
    }

    #[test]
    fn path_identity_excludes_regular_file_contents_size_times_and_link_count() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let path = home.join("identity-file");
            fs::write(&path, b"original").unwrap();
            let before = fs::symlink_metadata(&path).unwrap();
            let mut observed = owner(generation, &clock, home);
            capture(&mut observed, OperationKind::PathIdentity, &path);
            let receipt = observed.seal(|| Ok(())).unwrap();
            fs::write(&path, b"changed contents and length").unwrap();
            fs::hard_link(&path, home.join("identity-file-hardlink")).unwrap();
            let after = fs::symlink_metadata(&path).unwrap();
            assert_ne!(Stamp::of(&before), Stamp::of(&after));
            assert_eq!(PathIdentity::of(&before), PathIdentity::of(&after));
            receipt.revalidate(|| Ok(())).unwrap();
        });
    }

    #[test]
    fn path_identity_inode_mode_and_symlink_replacements_refuse_effects() {
        use std::os::unix::fs::PermissionsExt;
        for change in ["inode", "mode", "symlink"] {
            fixture(|generation, home, _| {
                let clock = deadline();
                let path = home.join("identity-leaf");
                let replacement = home.join("identity-replacement");
                fs::write(&path, b"same bytes").unwrap();
                fs::write(&replacement, b"same bytes").unwrap();
                let before = PathIdentity::of(&fs::symlink_metadata(&path).unwrap());
                let mut observed = owner(generation, &clock, home);
                capture(&mut observed, OperationKind::PathIdentity, &path);
                let receipt = observed.seal(|| Ok(())).unwrap();
                match change {
                    "inode" => fs::rename(&replacement, &path).unwrap(),
                    "mode" => fs::set_permissions(
                        &path,
                        fs::Permissions::from_mode((before.mode & 0o7777) ^ 0o100),
                    )
                    .unwrap(),
                    "symlink" => {
                        fs::remove_file(&path).unwrap();
                        symlink(&replacement, &path).unwrap();
                    }
                    _ => unreachable!(),
                }
                assert_ne!(
                    before,
                    PathIdentity::of(&fs::symlink_metadata(&path).unwrap())
                );
                let effects = Cell::new(0);
                assert!(
                    effect_after_revalidation(&receipt, &effects).is_err(),
                    "{change}"
                );
                assert_eq!(effects.get(), 0, "{change}");
            });
        }
    }

    #[test]
    fn path_identity_absence_becoming_present_refuses_seal_and_dispatch() {
        for before_seal in [true, false] {
            fixture(|generation, home, _| {
                let clock = deadline();
                let path = home.join("absent-identity");
                let mut observed = owner(generation, &clock, home);
                let row = capture(&mut observed, OperationKind::PathIdentity, &path);
                assert_eq!(row["result"]["kind"], "error");
                assert_eq!(row["result"]["code"], "ENOENT");
                if before_seal {
                    fs::write(&path, b"appeared").unwrap();
                    assert!(observed.seal(|| Ok(())).is_err());
                } else {
                    let receipt = observed.seal(|| Ok(())).unwrap();
                    fs::write(&path, b"appeared").unwrap();
                    let effects = Cell::new(0);
                    assert!(effect_after_revalidation(&receipt, &effects).is_err());
                    assert_eq!(effects.get(), 0);
                }
            });
        }
    }

    #[test]
    fn path_identity_keeps_resolved_symlink_ancestor_replacement_evidence() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let first = home.join("identity-target");
            let replacement = home.join("identity-target-replacement");
            fs::create_dir(&first).unwrap();
            fs::create_dir(&replacement).unwrap();
            fs::write(first.join("file"), b"same inode").unwrap();
            fs::hard_link(first.join("file"), replacement.join("file")).unwrap();
            symlink("identity-target", home.join("identity-link")).unwrap();
            let path = home.join("identity-link/file");
            let before = PathIdentity::of(&fs::symlink_metadata(&path).unwrap());
            let mut observed = owner(generation, &clock, home);
            capture(&mut observed, OperationKind::PathIdentity, &path);
            let receipt = observed.seal(|| Ok(())).unwrap();
            fs::rename(&first, home.join("identity-target-retired")).unwrap();
            fs::rename(&replacement, &first).unwrap();
            assert_eq!(
                before,
                PathIdentity::of(&fs::symlink_metadata(&path).unwrap())
            );
            let effects = Cell::new(0);
            assert!(effect_after_revalidation(&receipt, &effects).is_err());
            assert_eq!(effects.get(), 0);
        });
    }

    #[test]
    fn strict_lstat_and_list_still_refuse_actual_inventory_changes() {
        for kind in [OperationKind::Lstat, OperationKind::List] {
            fixture(|generation, home, _| {
                let clock = deadline();
                let directory = home.join("strict-inventory");
                fs::create_dir(&directory).unwrap();
                let before = Stamp::of(&fs::symlink_metadata(&directory).unwrap());
                let mut observed = owner(generation, &clock, home);
                capture(&mut observed, kind, &directory);
                let receipt = observed.seal(|| Ok(())).unwrap();
                fs::create_dir(directory.join("new-directory")).unwrap();
                assert_ne!(
                    before,
                    Stamp::of(&fs::symlink_metadata(&directory).unwrap())
                );
                let effects = Cell::new(0);
                assert!(
                    effect_after_revalidation(&receipt, &effects).is_err(),
                    "{kind:?}"
                );
                assert_eq!(effects.get(), 0);
            });
        }
    }

    #[test]
    fn path_identity_keeps_ancestor_scope_exact_schema_cancel_and_original_deadline() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let mut observed = owner(generation, &clock, home);
            let outside = home.parent().unwrap().join("unowned-identity-sibling");
            let denied = request(&observed, OperationKind::PathIdentity, &outside, None);
            assert!(
                observed
                    .capture(denied, || Ok(()))
                    .err()
                    .unwrap()
                    .contains("escapes native roots")
            );
            for single_link in [Some(false), Some(true)] {
                let invalid = request(&observed, OperationKind::PathIdentity, home, single_link);
                assert!(
                    observed
                        .capture(invalid, || Ok(()))
                        .err()
                        .unwrap()
                        .contains("singleLink")
                );
            }
            let null_field = json!({"snapshotId":observed.snapshot_id(),"sequence":1,
                "operation":{"kind":"path-identity","path":home,"singleLink":null}});
            assert!(
                observed
                    .capture_json(&serde_json::to_vec(&null_field).unwrap(), || Ok(()))
                    .is_err()
            );
            let cancelled = request(&observed, OperationKind::PathIdentity, home, None);
            assert_eq!(
                observed
                    .capture(cancelled, || Err("identity cancelled".into()))
                    .err()
                    .unwrap(),
                "identity cancelled"
            );
            assert!(observed.records.is_empty());
            let row = capture(&mut observed, OperationKind::PathIdentity, Path::new("/"));
            assert_eq!(row["result"]["value"]["kind"], "directory");
            let receipt = observed.seal(|| Ok(())).unwrap();
            assert!(std::ptr::eq(receipt.deadline(), &clock));
            assert_eq!(
                receipt
                    .revalidate(|| Err("queued identity cancelled".into()))
                    .unwrap_err(),
                "queued identity cancelled"
            );
            let expired = MonotonicDeadline::capture(Duration::from_millis(1)).unwrap();
            std::thread::sleep(Duration::from_millis(2));
            assert!(
                SelectionObservationOwner::new(
                    generation,
                    &expired,
                    vec![home.into()],
                    Limits::default(),
                    || Ok(())
                )
                .is_err()
            );
        });
    }

    #[test]
    fn appearing_higher_priority_candidate_blocks_effect_after_seal() {
        fixture(|generation, home, _| {
            let original_clock = deadline();
            let selected = home.join("shared-adapter.json");
            let higher = home.join("user-adapter.json");
            fs::write(&selected, b"shared").unwrap();
            let mut owner = owner(generation, &original_clock, home);
            let absent = capture(&mut owner, OperationKind::Exists, &higher);
            assert_eq!(absent["result"], json!({"kind":"exists","value":false}));
            let selected_value = capture(&mut owner, OperationKind::Read, &selected);
            assert_eq!(
                selected_value["result"]["base64"],
                STANDARD.encode(b"shared")
            );
            let receipt = owner.seal(|| Ok(())).unwrap();
            let effects = Cell::new(0);
            fs::write(&higher, b"user").unwrap();
            let failure = effect_after_revalidation(&receipt, &effects).unwrap_err();
            assert!(
                failure.contains("Selection dependency changed"),
                "{failure}"
            );
            assert_eq!(effects.get(), 0);
            retain(
                home,
                "appearing-override",
                json!({
                    "scope":"actual filesystem observations with synthetic generation and a test effect counter; no store activation",
                    "originalAbsence":absent,"selected":selected_value,
                    "appearedBytesBase64":STANDARD.encode(fs::read(higher).unwrap()),
                    "failure":failure,"effectCount":effects.get(),
                    "observations":receipt.observations().collect::<Vec<_>>()
                }),
            );
        });
    }
    #[test]
    fn absent_stat_is_error_and_parent_appearance_is_retained() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let candidate = home.join("absent-directory/adapter.json");
            let mut owner = owner(generation, &clock, home);
            let row = capture(&mut owner, OperationKind::Stat, &candidate);
            assert_eq!(row["result"]["kind"], "error");
            assert_eq!(row["result"]["code"], "ENOENT");
            let receipt = owner.seal(|| Ok(())).unwrap();
            fs::create_dir(candidate.parent().unwrap()).unwrap();
            assert!(receipt.revalidate(|| Ok(())).is_err());
        });
    }
    #[test]
    fn same_bytes_replacement_and_content_change_are_both_dependencies() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let path = home.join("selected.json");
            fs::write(&path, b"original").unwrap();
            let mut first = owner(generation, &clock, home);
            capture(&mut first, OperationKind::Read, &path);
            let receipt = first.seal(|| Ok(())).unwrap();
            let replacement = home.join("replacement.json");
            fs::write(&replacement, b"original").unwrap();
            fs::rename(&replacement, &path).unwrap();
            assert!(receipt.revalidate(|| Ok(())).is_err());
            let mut second = owner(generation, &clock, home);
            capture(&mut second, OperationKind::Read, &path);
            let receipt = second.seal(|| Ok(())).unwrap();
            fs::write(&path, b"changed!").unwrap();
            assert!(receipt.revalidate(|| Ok(())).is_err());
        });
    }
    #[test]
    fn listing_inventory_and_runtime_single_link_are_observed() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let directory = home.join("plugins");
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("a.ts"), b"a").unwrap();
            let mut first = owner(generation, &clock, home);
            let row = capture(&mut first, OperationKind::List, &directory);
            assert_eq!(row["result"]["entries"], json!(["a.ts"]));
            let receipt = first.seal(|| Ok(())).unwrap();
            fs::write(directory.join("b.ts"), b"b").unwrap();
            assert!(receipt.revalidate(|| Ok(())).is_err());
            let mut second = owner(generation, &clock, home);
            let request = request(
                &second,
                OperationKind::RuntimeFile,
                &directory.join("a.ts"),
                Some(true),
            );
            second.capture(request, || Ok(())).unwrap();
            fs::hard_link(directory.join("a.ts"), directory.join("alias.ts")).unwrap();
            assert!(second.seal(|| Ok(())).is_err());
        });
    }
    #[test]
    fn runtime_digest_is_exact_admitted_member_without_body_or_pointer_lookup() {
        fixture(|generation, home, root| {
            let clock = deadline();
            let mut owner = owner(generation, &clock, home);
            let row = capture(
                &mut owner,
                OperationKind::RuntimeDigest,
                &root.join("native/node"),
            );
            let expected = generation
                .member_digest("native/node", clock.expires(), || Ok(()))
                .unwrap();
            assert_eq!(row["result"]["kind"], "runtime-digest");
            assert_eq!(row["result"]["sha256"], expected.sha256);
            assert!(row["result"].get("base64").is_none());
            assert_eq!(row["result"]["stat"]["size"], expected.metadata.size);
            // A current pointer update cannot select another generation.
            fs::write(
                home.join("state/adapter-runtime.json"),
                b"unrelated pointer",
            )
            .unwrap();
            let snapshot_id = owner.snapshot_id().to_owned();
            let receipt = owner.seal(|| Ok(())).unwrap();
            assert_eq!(
                receipt.runtime_member("native/node", || Ok(())).unwrap(),
                expected
            );
            assert_eq!(receipt.observations().count(), 1);
            assert_eq!(receipt.snapshot_id(), snapshot_id);
        });
    }
    #[test]
    fn chunks_are_correlated_actual_bytes_and_no_operation_can_follow_seal() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let path = home.join("binary.bin");
            let bytes = [0, 1, 2, 255];
            fs::write(&path, bytes).unwrap();
            let mut owner = owner(generation, &clock, home);
            let initial_request = request(&owner, OperationKind::Read, &path, None);
            let encoded = serde_json::to_vec(&json!({"snapshotId":initial_request.snapshot_id,
                "sequence":initial_request.sequence,"operation":initial_request.operation}))
            .unwrap();
            let mut reply = owner.capture_json(&encoded, || Ok(())).unwrap();
            assert!(reply.byte_len() > bytes.len());
            assert!(reply.next_chunk(CHUNK + 1, || Ok(())).is_err());
            let mut assembled = Vec::new();
            while let Some(chunk) = reply.next_chunk(1, || Ok(())).unwrap() {
                assembled.extend_from_slice(chunk);
            }
            let row: Value = serde_json::from_slice(&assembled).unwrap();
            assert_eq!(row["snapshotId"], owner.snapshot_id());
            assert_eq!(row["sequence"], 1);
            assert_eq!(row["result"]["base64"], STANDARD.encode(bytes));
            let duplicate = request(&owner, OperationKind::Read, &path, None);
            assert!(
                owner
                    .capture(duplicate, || Ok(()))
                    .err()
                    .unwrap()
                    .contains("Duplicate")
            );
            let mut receipt = owner.seal(|| Ok(())).unwrap();
            let next = request(&receipt.owner, OperationKind::Exists, &path, None);
            assert!(
                receipt
                    .owner
                    .capture(next, || Ok(()))
                    .err()
                    .unwrap()
                    .contains("sealed")
            );
        });
    }
    #[test]
    fn resource_limits_cancellation_and_path_policy_fail_closed() {
        fixture(|generation, home, root| {
            let clock = deadline();
            let path = home.join("large.json");
            fs::write(&path, b"too large").unwrap();
            let mut bounds = Limits::default();
            bounds.maximum_file_bytes = 3;
            let mut owner = SelectionObservationOwner::new(
                generation,
                &clock,
                vec![home.into()],
                bounds,
                || Ok(()),
            )
            .unwrap();
            let read = request(&owner, OperationKind::Read, &path, None);
            assert!(
                owner
                    .capture(read, || Ok(()))
                    .err()
                    .unwrap()
                    .contains("byte bound")
            );
            assert!(owner.records.is_empty());
            let cancelled = request(&owner, OperationKind::Exists, &path, None);
            assert_eq!(
                owner
                    .capture(cancelled, || Err("native cancelled".into()))
                    .err()
                    .unwrap(),
                "native cancelled"
            );
            assert!(owner.records.is_empty());
            let escape = request(
                &owner,
                OperationKind::RuntimeDigest,
                &home.join("state/adapter-runtime.json"),
                None,
            );
            assert!(
                owner
                    .capture(escape, || Ok(()))
                    .err()
                    .unwrap()
                    .contains("outside the admitted generation")
            );
            let undeclared = request(
                &owner,
                OperationKind::RuntimeDigest,
                &root.join("undeclared"),
                None,
            );
            assert!(owner.capture(undeclared, || Ok(())).is_err());
            let invalid=br#"{"snapshotId":"x","sequence":1,"operation":{"kind":"exists","path":"/","extra":true}}"#;
            assert!(owner.capture_json(invalid, || Ok(())).is_err());
        });
    }
    #[test]
    fn runtime_file_symlink_refused_and_nonruntime_read_preserves_bytes() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let target = home.join("target");
            let link = home.join("link");
            fs::write(&target, b"actual").unwrap();
            symlink(&target, &link).unwrap();
            let mut owner = owner(generation, &clock, home);
            let runtime = capture(&mut owner, OperationKind::RuntimeFile, &link);
            assert_eq!(runtime["result"]["kind"], "error");
            let ordinary = capture(&mut owner, OperationKind::Read, &link);
            assert_eq!(ordinary["result"]["base64"], STANDARD.encode(b"actual"));
            owner.seal(|| Ok(())).unwrap();
        });
    }
    #[test]
    fn replaced_resolved_target_directory_with_same_hardlinked_leaf_blocks_effect() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let target = home.join("target");
            let replacement = home.join("replacement");
            fs::create_dir(&target).unwrap();
            fs::create_dir(&replacement).unwrap();
            fs::write(target.join("file"), b"same inode and bytes").unwrap();
            fs::hard_link(target.join("file"), replacement.join("file")).unwrap();
            symlink("target", home.join("link")).unwrap();
            let path = home.join("link/file");
            let original_leaf = Stamp::of(&fs::metadata(&path).unwrap());
            let mut owner = owner(generation, &clock, home);
            capture(&mut owner, OperationKind::Read, &path);
            let receipt = owner.seal(|| Ok(())).unwrap();
            fs::rename(&target, home.join("retired")).unwrap();
            fs::rename(&replacement, &target).unwrap();
            let current_leaf = Stamp::of(&fs::metadata(&path).unwrap());
            assert_eq!(current_leaf, original_leaf);
            let effects = Cell::new(0);
            let failure = effect_after_revalidation(&receipt, &effects).unwrap_err();
            assert!(failure.contains("Selection dependency changed"));
            assert_eq!(effects.get(), 0);
            retain(
                home,
                "resolved-parent-replacement",
                json!({
                    "scope":"actual filesystem observations with synthetic generation and a test effect counter; no store activation",
                    "leafBefore":format!("{original_leaf:?}"),"leafAfter":format!("{current_leaf:?}"),
                    "leafBytesBase64":STANDARD.encode(fs::read(&path).unwrap()),
                    "retiredDirectory":info(&fs::metadata(home.join("retired")).unwrap()).unwrap(),
                    "replacementDirectory":info(&fs::metadata(&target).unwrap()).unwrap(),
                    "failure":failure,"effectCount":effects.get(),
                    "observations":receipt.observations().collect::<Vec<_>>()
                }),
            );
        });
    }
    #[test]
    fn nested_symlink_target_chain_and_absent_target_directory_are_dependencies() {
        fixture(|generation, home, _| {
            let clock = deadline();
            let target = home.join("target");
            let replacement = home.join("replacement");
            fs::create_dir(&target).unwrap();
            fs::create_dir(&replacement).unwrap();
            symlink("target", home.join("middle")).unwrap();
            symlink("middle", home.join("link")).unwrap();
            let path = home.join("link/absent.json");
            let mut owner = owner(generation, &clock, home);
            assert_eq!(
                capture(&mut owner, OperationKind::Exists, &path)["result"]["value"],
                false
            );
            let receipt = owner.seal(|| Ok(())).unwrap();
            fs::rename(&target, home.join("retired")).unwrap();
            fs::rename(&replacement, &target).unwrap();
            assert!(!path.exists());
            let effects = Cell::new(0);
            let failure = effect_after_revalidation(&receipt, &effects).unwrap_err();
            assert_eq!(effects.get(), 0);
            retain(
                home,
                "nested-absent-parent-replacement",
                json!({
                    "scope":"actual filesystem observations with synthetic generation and a test effect counter; no store activation",
                    "leafRemainsAbsent":!path.exists(),"failure":failure,"effectCount":effects.get(),
                    "observations":receipt.observations().collect::<Vec<_>>()
                }),
            );
        });
    }
    #[test]
    fn denied_error_never_means_absent_and_native_ns_are_not_js_projection() {
        let error = io::Error::from_raw_os_error(libc::EACCES);
        assert!(!absent(&error));
        assert_eq!(error_result(&error)["code"], "EACCES");
        assert_eq!(error_result(&error)["kind"], "error");
        let a = projected_info(libc::S_IFREG as u32, 1, 2, 3, 1, 1, 1, 1, 1).unwrap();
        assert_eq!(a["kind"], "file");
        assert_eq!(a["dev"], "1");
        assert!(projected_info(libc::S_IFREG as u32, 1, 2, JS_MAX + 1, 1, 1, 1, 1, 1).is_err());
        let a = Stamp {
            dev: 1,
            ino: 2,
            mode: 0,
            uid: 1,
            gid: 1,
            size: 0,
            nlink: 1,
            mtime: 1,
            mtime_nsec: 1,
            ctime: 1,
            ctime_nsec: 1,
        };
        let b = Stamp {
            mtime_nsec: 2,
            ..Stamp {
                dev: 1,
                ino: 2,
                mode: 0,
                uid: 1,
                gid: 1,
                size: 0,
                nlink: 1,
                mtime: 1,
                mtime_nsec: 1,
                ctime: 1,
                ctime_nsec: 1,
            }
        };
        assert_ne!(a, b);
    }
    #[test]
    fn runtime_generation_observes_over_4096_actual_members_in_one_chunked_read() {
        crate::native_generation::with_large_selection_generation_fixture(
            |generation, home, root| {
                let clock = MonotonicDeadline::capture(Duration::from_secs(60)).unwrap();
                let mut checkpoints = 0;
                let cancelled = generation.manifest_summary(root, clock.expires(), || {
                    checkpoints += 1;
                    if checkpoints == 100 {
                        Err("retained manifest copy cancelled".into())
                    } else {
                        Ok(())
                    }
                });
                assert_eq!(cancelled.unwrap_err(), "retained manifest copy cancelled");
                assert_eq!(checkpoints, 100);
                let mut owner = owner(generation, &clock, home);
                let discovery = request(&owner, OperationKind::RuntimeGeneration, root, None);
                let mut reply = owner.capture(discovery, || Ok(())).unwrap();
                let mut chunks = 0;
                let mut bytes = Vec::new();
                while let Some(chunk) = reply.next_chunk(CHUNK, || Ok(())).unwrap() {
                    chunks += 1;
                    bytes.extend_from_slice(chunk);
                }
                let observation: Value = serde_json::from_slice(&bytes).unwrap();
                let result = &observation["result"];
                let keys: BTreeSet<_> = result
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect();
                assert_eq!(keys, BTreeSet::from(["kind", "digest", "manifest"]));
                assert_eq!(result["kind"], "runtime-generation");
                assert_eq!(result["digest"], generation.digest());
                let manifest = result["manifest"].as_object().unwrap();
                assert!(
                    manifest.len() > 4096,
                    "real native manifest must exceed the per-file observation quota"
                );
                assert_eq!(manifest.len(), 4108);
                assert_eq!(
                    manifest["fixture-members/04099.json"],
                    hash(b"{\"fixtureMember\":4099}\n")
                );
                assert!(!manifest.contains_key("manifest.json"));
                assert!(chunks > 1);
                assert_eq!(owner.records.len(), 1);
                assert_eq!(owner.bytes, bytes.len());
                assert_eq!(
                    owner.records[0].operation.kind,
                    OperationKind::RuntimeGeneration
                );
                let receipt = owner.seal(|| Ok(())).unwrap();
                assert_eq!(receipt.observations().count(), 1);
                assert!(std::ptr::eq(receipt.deadline(), &clock));
                receipt.revalidate(|| Ok(())).unwrap();
                retain(
                    home,
                    "generation-large",
                    json!({"members":manifest.len(),"observations":1,"chunks":chunks,"bytes":bytes.len(),"digest":generation.digest(),"revalidated":true}),
                );
            },
        );
    }
    #[test]
    fn runtime_generation_mutated_member_inventory_and_mode_refuse_before_effect() {
        for mode in ["member", "inventory", "mode"] {
            fixture(|generation, home, root| {
                use std::os::unix::fs::PermissionsExt;
                let clock = deadline();
                let mut owner = owner(generation, &clock, home);
                let observation = capture(&mut owner, OperationKind::RuntimeGeneration, root);
                assert_eq!(observation["result"]["kind"], "runtime-generation");
                match mode {
                    "member" => fs::write(root.join("engine.js"), b"mutated member").unwrap(),
                    "inventory" => {
                        fs::write(root.join("native/undeclared"), b"new inventory").unwrap()
                    }
                    "mode" => fs::set_permissions(
                        root.join("engine.js"),
                        fs::Permissions::from_mode(0o755),
                    )
                    .unwrap(),
                    _ => unreachable!(),
                }
                let effects = Cell::new(0);
                let result = owner
                    .seal(|| Ok(()))
                    .and_then(|receipt| effect_after_revalidation(&receipt, &effects));
                assert!(
                    result.is_err(),
                    "{mode} change must refuse original summary"
                );
                assert_eq!(effects.get(), 0);
                retain(
                    home,
                    &format!("generation-{mode}"),
                    json!({"refused":true,"effects":effects.get(),"failure":result.unwrap_err()}),
                );
            });
        }
    }
    #[test]
    fn runtime_generation_stale_after_seal_refuses_and_pointer_update_does_not_reselect() {
        fixture(|generation, home, root| {
            let clock = deadline();
            let mut owner = owner(generation, &clock, home);
            let observation = capture(&mut owner, OperationKind::RuntimeGeneration, root);
            let receipt = owner.seal(|| Ok(())).unwrap();
            fs::write(
                home.join("state/adapter-runtime.json"),
                b"another current pointer",
            )
            .unwrap();
            receipt.revalidate(|| Ok(())).unwrap();
            assert_eq!(observation["result"]["digest"], generation.digest());
            fs::write(root.join("engine.js"), b"changed after seal").unwrap();
            let effects = Cell::new(0);
            assert!(effect_after_revalidation(&receipt, &effects).is_err());
            assert_eq!(effects.get(), 0);
        });
    }
    #[test]
    fn runtime_generation_rejects_foreign_root_alias_and_every_present_single_link() {
        fixture(|generation, home, root| {
            let clock = deadline();
            let mut owner = owner(generation, &clock, home);
            let alias = home.join("generation-alias");
            symlink(root, &alias).unwrap();
            let repeated = PathBuf::from(format!(
                "{}//{}",
                root.parent().unwrap().display(),
                root.file_name().unwrap().to_str().unwrap()
            ));
            for path in [
                home.to_path_buf(),
                root.with_file_name("0".repeat(64)),
                alias,
                PathBuf::from(format!("{}/", root.display())),
                PathBuf::from(format!("{}/.", root.display())),
                repeated,
            ] {
                let discovery = request(&owner, OperationKind::RuntimeGeneration, &path, None);
                assert!(
                    owner
                        .capture(discovery, || Ok(()))
                        .err()
                        .unwrap()
                        .contains("exact original root")
                );
                assert!(owner.records.is_empty());
            }
            for single_link in [Some(false), Some(true)] {
                let discovery =
                    request(&owner, OperationKind::RuntimeGeneration, root, single_link);
                assert!(owner.capture(discovery, || Ok(())).is_err());
                assert!(owner.records.is_empty());
            }
            let raw = json!({"snapshotId":owner.snapshot_id(),"sequence":1,"operation":{"kind":"runtime-generation","path":root,"singleLink":null}});
            assert!(
                owner
                    .capture_json(&serde_json::to_vec(&raw).unwrap(), || Ok(()))
                    .is_err()
            );
            assert!(owner.records.is_empty());
        });
    }
    #[test]
    fn runtime_generation_preserves_count_byte_cancel_and_expired_original_limits() {
        fixture(|generation, home, root| {
            let clock = deadline();
            let mut limits = Limits::default();
            limits.maximum_observations = 1;
            let mut owner = SelectionObservationOwner::new(
                generation,
                &clock,
                vec![home.into()],
                limits,
                || Ok(()),
            )
            .unwrap();
            let discovery = request(&owner, OperationKind::RuntimeGeneration, root, None);
            assert_eq!(
                owner
                    .capture(discovery, || Err("original summary cancelled".into()))
                    .err()
                    .unwrap(),
                "original summary cancelled"
            );
            assert!(owner.records.is_empty());
            capture(&mut owner, OperationKind::RuntimeGeneration, root);
            let excess = request(
                &owner,
                OperationKind::Exists,
                &home.join("unobserved"),
                None,
            );
            assert!(
                owner
                    .capture(excess, || Ok(()))
                    .err()
                    .unwrap()
                    .contains("count exceeds")
            );
            let mut limits = Limits::default();
            limits.maximum_bytes = 128;
            let mut bounded = SelectionObservationOwner::new(
                generation,
                &clock,
                vec![home.into()],
                limits,
                || Ok(()),
            )
            .unwrap();
            let discovery = request(&bounded, OperationKind::RuntimeGeneration, root, None);
            assert!(
                bounded
                    .capture(discovery, || Ok(()))
                    .err()
                    .unwrap()
                    .contains("bytes exceed")
            );
            assert!(bounded.records.is_empty());
            let expired = MonotonicDeadline::capture(Duration::from_millis(1)).unwrap();
            std::thread::sleep(Duration::from_millis(2));
            assert!(
                SelectionObservationOwner::new(
                    generation,
                    &expired,
                    vec![home.into()],
                    Limits::default(),
                    || Ok(())
                )
                .err()
                .unwrap()
                .contains("Original monotonic deadline expired")
            );
        });
    }
    fn exists_directory_metadata(path: &Path) -> Value {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                json!({"kind":file_kind(metadata.mode()),"dev":metadata.dev(),"ino":metadata.ino(),
                "mode":metadata.mode(),"uid":metadata.uid(),"gid":metadata.gid(),"size":metadata.size(),"nlink":metadata.nlink(),
                "mtime":metadata.mtime(),"mtimeNsec":metadata.mtime_nsec(),"ctime":metadata.ctime(),"ctimeNsec":metadata.ctime_nsec()})
            }
            Err(error) => json!({"errno":error.raw_os_error(),"error":error.to_string()}),
        }
    }

    #[test]
    fn exists_directory_writer_bootstrap_preserves_original_receipt() {
        use std::os::unix::fs::PermissionsExt;
        fixture(|generation, home, _| {
            let physical_home = home.canonicalize().unwrap();
            let project = physical_home.join("exists-writer-project");
            let machine = physical_home.join("exists-writer-machine");
            for directory in [&project, &machine] {
                fs::create_dir(directory).unwrap();
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
            }
            let governance = project.join(".caws");
            fs::create_dir(&governance).unwrap();
            fs::set_permissions(&governance, fs::Permissions::from_mode(0o700)).unwrap();
            let policy = governance.join("policy.yaml");
            fs::write(&policy, b"selected policy bytes\n").unwrap();
            let clock = deadline();
            let before = fs::symlink_metadata(&governance).unwrap();
            let mut observed = owner(generation, &clock, &physical_home);
            let original_exists = capture(&mut observed, OperationKind::Exists, &governance);
            assert_eq!(
                original_exists["result"],
                json!({"kind":"exists","value":true})
            );
            capture(&mut observed, OperationKind::PathIdentity, &governance);
            capture(&mut observed, OperationKind::Read, &policy);
            let receipt = observed.seal(|| Ok(())).unwrap();
            // Public real writer bootstrap. The checked callback is library-
            // private; this binary-module test revalidates the same receipt
            // before and after acquisition, without changing that API.
            receipt.revalidate(|| Ok(())).unwrap();
            let writer =
                caws_native::render_writer::acquire(&machine, &project, clock.expires()).unwrap();
            let after = fs::symlink_metadata(&governance).unwrap();
            assert_eq!(PathIdentity::of(&before), PathIdentity::of(&after));
            assert_ne!(Stamp::of(&before), Stamp::of(&after));
            assert_eq!(fs::read(&policy).unwrap(), b"selected policy bytes\n");
            let effects = Cell::new(0);
            let result = effect_after_revalidation(&receipt, &effects);
            retain(
                home,
                "exists-directory-writer-bootstrap",
                json!({
                    "scope":"actual public writer bootstrap and actual native observation receipt with synthetic generation; no installed Stop callback join",
                    "project":project,"writerMachineHome":machine,"originalExists":original_exists,
                    "before":{"identity":format!("{:?}",PathIdentity::of(&before)),"stamp":format!("{:?}",Stamp::of(&before))},
                    "after":exists_directory_metadata(&governance),"sameParentIdentity":true,"fullMetadataChanged":true,
                    "markerPath":governance.join(".render-writer-provisioned"),
                    "markerBase64":STANDARD.encode(fs::read(governance.join(".render-writer-provisioned")).unwrap()),
                    "custodyPath":governance.join(".render-writer-custody"),
                    "custodyMetadata":exists_directory_metadata(&governance.join(".render-writer-custody")),
                    "effectCount":effects.get(),"error":result.as_ref().err(),
                    "nativeEvidence":format!("{:?}",receipt.owner.records[0].evidence),
                    "observations":receipt.observations().collect::<Vec<_>>()
                }),
            );
            assert!(
                result.is_ok(),
                "writer bootstrap must not invalidate directory existence: {:?}",
                result.err()
            );
            assert_eq!(effects.get(), 1);
            drop(writer);
        });
    }

    #[test]
    fn exists_directory_identity_and_absence_changes_refuse_effects() {
        use std::os::unix::fs::PermissionsExt;
        for change in ["absent", "replacement", "mode", "symlink", "file-type"] {
            fixture(|generation, home, _| {
                let directory = home.join("exists-directory");
                fs::create_dir(&directory).unwrap();
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
                let original = exists_directory_metadata(&directory);
                let clock = deadline();
                let mut observed = owner(generation, &clock, home);
                let row = capture(&mut observed, OperationKind::Exists, &directory);
                let receipt = observed.seal(|| Ok(())).unwrap();
                match change {
                    "absent" => fs::remove_dir(&directory).unwrap(),
                    "replacement" => {
                        fs::rename(&directory, home.join("retained-directory")).unwrap();
                        fs::create_dir(&directory).unwrap();
                        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
                    }
                    "mode" => {
                        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap()
                    }
                    "symlink" => {
                        let moved = home.join("retained-directory");
                        fs::rename(&directory, &moved).unwrap();
                        symlink(&moved, &directory).unwrap();
                    }
                    "file-type" => {
                        fs::remove_dir(&directory).unwrap();
                        fs::write(&directory, b"present file").unwrap();
                    }
                    _ => unreachable!(),
                }
                let effects = Cell::new(0);
                let result = effect_after_revalidation(&receipt, &effects);
                retain(
                    home,
                    &format!("exists-directory-{change}"),
                    json!({"change":change,"originalExists":row,
                    "before":original,"after":exists_directory_metadata(&directory),"effectCount":effects.get(),
                    "error":result.as_ref().err(),"nativeEvidence":format!("{:?}",receipt.owner.records[0].evidence)}),
                );
                assert!(result.is_err(), "{change}");
                assert_eq!(effects.get(), 0, "{change}");
            });
        }
        fixture(|generation, home, _| {
            let directory = home.join("absent-exists-directory");
            let clock = deadline();
            let mut observed = owner(generation, &clock, home);
            let row = capture(&mut observed, OperationKind::Exists, &directory);
            assert_eq!(row["result"]["value"], false);
            let receipt = observed.seal(|| Ok(())).unwrap();
            fs::create_dir(&directory).unwrap();
            let effects = Cell::new(0);
            let result = effect_after_revalidation(&receipt, &effects);
            retain(
                home,
                "exists-directory-absence-appears",
                json!({"originalExists":row,"after":exists_directory_metadata(&directory),"error":result.as_ref().err(),"effectCount":effects.get()}),
            );
            assert!(result.is_err());
            assert_eq!(effects.get(), 0);
        });
    }

    #[test]
    fn exists_directory_projection_preserves_native_identity_and_symlink_target() {
        fixture(|generation, home, _| {
            let target = home.join("exists-target");
            fs::create_dir(&target).unwrap();
            let link = home.join("exists-link");
            symlink(&target, &link).unwrap();
            let metadata = fs::metadata(&target).unwrap();
            let expected = PathIdentity {
                dev: metadata.dev(),
                ino: metadata.ino(),
                mode: metadata.mode(),
                uid: metadata.uid(),
                gid: metadata.gid(),
            };
            assert_eq!(
                operation_leaf(&target, OperationKind::Exists),
                Leaf::ExistsDirectory(expected)
            );
            let expected = PathIdentity {
                dev: metadata.dev(),
                ino: metadata.ino(),
                mode: metadata.mode(),
                uid: metadata.uid(),
                gid: metadata.gid(),
            };
            assert_eq!(
                Followed::of(OperationKind::Exists, &metadata),
                Followed::ExistsDirectory(expected)
            );
            assert!(
                matches!(
                    operation_leaf(&link, OperationKind::Exists),
                    Leaf::Present(_)
                ),
                "symlink leaf must retain exact stamp"
            );
            let clock = deadline();
            let mut observed = owner(generation, &clock, home);
            capture(&mut observed, OperationKind::Exists, &link);
            let receipt = observed.seal(|| Ok(())).unwrap();
            fs::create_dir(target.join("bootstrap-child")).unwrap();
            let effects = Cell::new(0);
            effect_after_revalidation(&receipt, &effects).unwrap();
            assert_eq!(effects.get(), 1);
            fs::rename(&target, home.join("retained-target")).unwrap();
            fs::create_dir(&target).unwrap();
            let result = effect_after_revalidation(&receipt, &effects);
            retain(
                home,
                "exists-directory-symlink-target",
                json!({"error":result.as_ref().err(),"effectCount":effects.get(),
                "target":exists_directory_metadata(&target),"nativeEvidence":format!("{:?}",receipt.owner.records[0].evidence)}),
            );
            assert!(result.is_err());
            assert_eq!(effects.get(), 1);
        });
    }

    #[test]
    fn exists_directory_does_not_relax_explicit_metadata_inventory_policy_or_negative_children() {
        for change in [
            "stat",
            "lstat",
            "list",
            "policy",
            "negative-child",
            "file-exists",
        ] {
            fixture(|generation, home, _| {
                let directory = home.join("exists-strict-directory");
                fs::create_dir(&directory).unwrap();
                let policy = directory.join("policy.yaml");
                fs::write(&policy, b"original policy").unwrap();
                let candidate = directory.join("higher-priority.json");
                let clock = deadline();
                let mut observed = owner(generation, &clock, home);
                capture(&mut observed, OperationKind::Exists, &directory);
                match change {
                    "stat" => {
                        capture(&mut observed, OperationKind::Stat, &directory);
                    }
                    "lstat" => {
                        capture(&mut observed, OperationKind::Lstat, &directory);
                    }
                    "list" => {
                        capture(&mut observed, OperationKind::List, &directory);
                    }
                    "policy" => {
                        capture(&mut observed, OperationKind::Read, &policy);
                    }
                    "negative-child" => {
                        capture(&mut observed, OperationKind::Exists, &candidate);
                    }
                    "file-exists" => {
                        capture(&mut observed, OperationKind::Exists, &policy);
                    }
                    _ => unreachable!(),
                }
                let receipt = observed.seal(|| Ok(())).unwrap();
                match change {
                    "policy" | "file-exists" => {
                        fs::write(&policy, b"changed policy with a different size").unwrap()
                    }
                    "negative-child" => fs::write(&candidate, b"new candidate").unwrap(),
                    _ => fs::create_dir(directory.join("bootstrap-child")).unwrap(),
                }
                let effects = Cell::new(0);
                let result = effect_after_revalidation(&receipt, &effects);
                retain(
                    home,
                    &format!("exists-directory-strict-{change}"),
                    json!({"change":change,"error":result.as_ref().err(),"effectCount":effects.get(),
                    "directory":exists_directory_metadata(&directory),"observations":receipt.observations().collect::<Vec<_>>() }),
                );
                assert!(result.is_err(), "{change}");
                assert_eq!(effects.get(), 0, "{change}");
            });
        }
    }
}
