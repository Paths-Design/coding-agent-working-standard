//! Original-bound Render Git observations. No stock selection, publication,
//! cache, calendar, or complete Render context is supplied by this component.
use crate::invocation_project::{self as project, ProjectFailure, RenderQuery, SelectedExecutable};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{collections::BTreeMap, marker::PhantomData, path::Path, rc::Rc, time::Instant};

pub const SCHEMA: &str = "caws.render.context.observation.v1";
pub const MAX_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_QUERY_OUTPUT: usize = 1024 * 1024;

/// Construct only from one original native invocation, never from engine argv
/// or a resident process's mutable environment. CWD spelling is retained.
pub struct Invocation {
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub caller_cwd: String,
    pub cwd: String,
    pub environment: BTreeMap<String, String>,
}
/// Captured before the engine exists; the publication token is bound later.
pub struct OriginalInvocation {
    pub id: String,
    pub runtime_digest: String,
    pub caller_cwd: String,
    pub cwd: String,
    pub environment: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Executable {
    pub path: String,
    pub physical_path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    pub exit_observed: bool,
    pub group_settled: bool,
    pub stdout_eof: bool,
    pub stderr_eof: bool,
    pub reaped: bool,
    pub ownership_retained: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub ordinal: u8,
    pub operation: &'static str,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub cleanup: Cleanup,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub schema: &'static str,
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub cwd: String,
    pub executable: Executable,
    pub queries: Vec<Query>,
}
impl Observation {
    pub fn bytes(&self) -> Result<Vec<u8>, Failure> {
        let bytes = serde_json::to_vec(self)
            .map_err(|_| Failure::plain("encoding", "Render context encoding failed"))?;
        if bytes.len() > MAX_BYTES {
            return Err(Failure::plain(
                "output_limit",
                "Render context encoded output exceeded bound",
            ));
        }
        Ok(bytes)
    }
}
/// First failure, completed raw observations and the failed query's admitted
/// partial bytes remain separate. `remote` retains the production custodian;
/// `cause` owns a Child only for the explicitly local component helper.
///
/// The invocation owner MUST retain this value until `cleanup_settled()` is
/// true. `retry_cleanup()` is one bounded attempt, not a guarantee that a refusal
/// will become transient. Exhausting the owner's cleanup allowance requires
/// retaining/transferring this exact value as uncertain custody; it never
/// authorizes replay, success, or destruction as a substitute for settlement.
/// Remote Drop closes frontend liveness while the separate custodian keeps the
/// actual Git Child. Drop itself supplies no settlement observation.
#[must_use = "retain Render context failure custody until cleanup_settled()"]
#[derive(Debug)]
pub struct Failure {
    pub category: &'static str,
    pub diagnostic: String,
    pub completed: Vec<Query>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub cause: Option<ProjectFailure>,
    pub remote: Option<crate::context_git::render::Failure>,
}
impl Failure {
    fn plain(category: &'static str, message: &str) -> Self {
        Self {
            category,
            diagnostic: message.into(),
            completed: Vec::new(),
            stdout: Vec::new(),
            stderr: Vec::new(),
            cause: None,
            remote: None,
        }
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        let local = self
            .cause
            .as_mut()
            .map_or(Ok(()), ProjectFailure::retry_cleanup);
        let remote = self
            .remote
            .as_mut()
            .map_or(Ok(()), crate::context_git::render::Failure::retry_cleanup);
        self.sync_remote();
        local.and(remote)
    }
    pub fn cleanup_settled(&self) -> bool {
        self.cause
            .as_ref()
            .is_none_or(|failure| !failure.retained_uncertain())
            && self
                .remote
                .as_ref()
                .is_none_or(crate::context_git::render::Failure::cleanup_settled)
    }
    fn sync_remote(&mut self) {
        if let Some(remote) = &self.remote {
            self.completed = remote.completed();
            (self.stdout, self.stderr) = remote.partial();
        }
    }
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
// The proposal token is an opaque protocol identity (normally a UUID), not
// a digest. Match protocol.rs proposal admission exactly.
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn native_path(value: &str) -> bool {
    value.len() <= 4096 && value.starts_with('/') && !value.contains(['\0', '\r', '\n'])
}
/// A process-local capability. Selection does not execute a Git query.
pub struct CapturedRenderContext {
    invocation: OriginalInvocation,
    selected: SelectedExecutable,
    expires: Instant,
    original_pid: u32,
    _original_thread: PhantomData<Rc<()>>,
}
impl CapturedRenderContext {
    pub fn capture(
        invocation: OriginalInvocation,
        expires: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Self, Failure> {
        if invocation.id.is_empty()
            || invocation.id.len() > 128
            || invocation.id.contains('\0')
            || !digest(&invocation.runtime_digest)
            || !native_path(&invocation.cwd)
            || !native_path(&invocation.caller_cwd)
        {
            return Err(Failure::plain(
                "unsupported",
                "Invalid original Render context identity or CWD",
            ));
        }
        for (name, value) in &invocation.environment {
            if name.is_empty() || name.contains(['=', '\0']) || value.contains('\0') {
                return Err(Failure::plain(
                    "unsupported",
                    "Invalid captured Render environment",
                ));
            }
            if name.starts_with("BASH_FUNC_")
                || (!value.is_empty()
                    && matches!(
                        name.as_str(),
                        "BASH_ENV" | "ENV" | "CAWS_PRIOR_BASH_ENV" | "SHELLOPTS" | "BASHOPTS"
                    ))
            {
                return Err(Failure::plain(
                    "unsupported",
                    "Imported functions or shell startup are unsupported",
                ));
            }
        }
        if invocation
            .environment
            .get("PATH")
            .is_none_or(|value| value.split(':').any(|part| !native_path(part)))
        {
            return Err(Failure::plain(
                "unsupported",
                "Render PATH requires nonempty absolute entries",
            ));
        }
        let selected = project::select_render_executable(
            &invocation.caller_cwd,
            &invocation.environment,
            expires,
            cancelled,
        )
        .map_err(|cause| Failure {
            category: "selection",
            diagnostic: cause.first_message.clone(),
            cause: Some(cause),
            ..Failure::plain("selection", "")
        })?;
        if selected.path.to_str().is_none() || selected.physical_path.to_str().is_none() {
            return Err(Failure::plain(
                "unsupported",
                "Render Git executable is not native UTF-8",
            ));
        }
        Ok(Self {
            invocation,
            selected,
            expires,
            original_pid: std::process::id(),
            _original_thread: PhantomData,
        })
    }
    pub fn id(&self) -> &str {
        &self.invocation.id
    }
    pub fn runtime_digest(&self) -> &str {
        &self.invocation.runtime_digest
    }
    pub fn cwd(&self) -> &str {
        &self.invocation.cwd
    }
    /// Identity from selection, independent of a query's returned bytes.
    pub fn executable(&self) -> Executable {
        Executable {
            path: self
                .selected
                .path
                .to_str()
                .expect("validated native path")
                .into(),
            physical_path: self
                .selected
                .physical_path
                .to_str()
                .expect("validated native path")
                .into(),
            sha256: self.selected.sha256.clone(),
        }
    }
    /// Pin the original native executable before Node. The sole later query
    /// launches one custodian; that process parents every actual Git Child.
    pub fn custodied(
        self,
        native_executable: &Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<CustodiedRenderContext, Failure> {
        if self.original_pid != std::process::id() || Instant::now() >= self.expires {
            return Err(Failure::plain(
                "binding",
                "Original Render process or deadline changed",
            ));
        }
        if native_executable
            .to_str()
            .is_none_or(|path| !native_path(path))
        {
            return Err(Failure::plain(
                "unsupported",
                "Original native custodian path must be absolute native UTF-8",
            ));
        }
        let executor = project::pin_executable(native_executable, self.expires, cancelled)
            .map_err(|cause| Failure {
                category: "selection",
                diagnostic: cause.first_message.clone(),
                cause: Some(cause),
                ..Failure::plain("selection", "")
            })?;
        Ok(CustodiedRenderContext {
            captured: self,
            executor,
        })
    }
    pub fn bind(self, token_value: String) -> Result<RenderContextOwner, Failure> {
        if !token(&token_value) {
            return Err(Failure::plain(
                "unsupported",
                "Invalid original Render token",
            ));
        }
        if self.original_pid != std::process::id() || Instant::now() >= self.expires {
            return Err(Failure::plain(
                "binding",
                "Original Render process or deadline changed",
            ));
        }
        Ok(RenderContextOwner {
            captured: self,
            token: token_value,
            used: false,
            executor: None,
        })
    }
}
/// The production carrier requires this capability rather than the local-only
/// convenience owner. Original data and the native image are captured once.
pub struct CustodiedRenderContext {
    captured: CapturedRenderContext,
    executor: SelectedExecutable,
}
impl CustodiedRenderContext {
    pub fn id(&self) -> &str {
        self.captured.id()
    }
    pub fn runtime_digest(&self) -> &str {
        self.captured.runtime_digest()
    }
    pub fn cwd(&self) -> &str {
        self.captured.cwd()
    }
    pub fn executable(&self) -> Executable {
        self.captured.executable()
    }
    pub fn bind(self, token: String) -> Result<RenderContextOwner, Failure> {
        let mut owner = self.captured.bind(token)?;
        owner.executor = Some(self.executor);
        Ok(owner)
    }
}
pub struct RenderContextOwner {
    captured: CapturedRenderContext,
    token: String,
    used: bool,
    executor: Option<SelectedExecutable>,
}
impl RenderContextOwner {
    /// Local-only component/reference convenience. Production carriers must
    /// use CapturedRenderContext::custodied before binding.
    pub fn capture(
        invocation: Invocation,
        expires: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Self, Failure> {
        let Invocation {
            id,
            runtime_digest,
            token: token_value,
            caller_cwd,
            cwd,
            environment,
        } = invocation;
        // Preserve rejection before selection for malformed bound callers.
        if !token(&token_value) {
            return Err(Failure::plain(
                "unsupported",
                "Invalid original Render token",
            ));
        }
        CapturedRenderContext::capture(
            OriginalInvocation {
                id,
                runtime_digest,
                caller_cwd,
                cwd,
                environment,
            },
            expires,
            cancelled,
        )?
        .bind(token_value)
    }
    pub fn observe(
        &mut self,
        expires: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Observation, Failure> {
        if self.used {
            return Err(Failure::plain(
                "consumed",
                "Render context observation is single-use",
            ));
        }
        self.used = true;
        let expires = expires.min(self.captured.expires);
        if self.captured.original_pid != std::process::id() {
            return Err(Failure::plain("binding", "Original Render process changed"));
        }
        if let Some(executor) = &self.executor {
            let queries = crate::context_git::render::observe(
                crate::context_git::render::Input {
                    invocation: &self.captured.invocation,
                    git: &self.captured.selected,
                    executor,
                    token: &self.token,
                    expires,
                },
                cancelled,
            )
            .map_err(|remote| {
                let mut failure = Failure {
                    category: "query",
                    diagnostic: remote.diagnostic.clone(),
                    remote: Some(remote),
                    ..Failure::plain("query", "")
                };
                failure.sync_remote();
                failure
            })?;
            return Ok(Observation {
                schema: SCHEMA,
                id: self.captured.invocation.id.clone(),
                runtime_digest: self.captured.invocation.runtime_digest.clone(),
                token: self.token.clone(),
                cwd: self.captured.invocation.cwd.clone(),
                executable: self.captured.executable(),
                queries,
            });
        }
        // Match the direct runtime's inherited routing removal. No process-wide
        // environment or PATH cache can enter this observation.
        let environment = self
            .captured
            .invocation
            .environment
            .iter()
            .filter(|(name, _)| !name.starts_with("GIT_") && !name.starts_with("HOOK_"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut queries = Vec::new();
        for (operation, label) in [
            (RenderQuery::Inside, "inside"),
            (RenderQuery::Branch, "branch"),
            (RenderQuery::Head, "head"),
            (RenderQuery::Status, "status"),
        ] {
            let output = project::query_render_context(
                &self.captured.selected,
                Path::new(&self.captured.invocation.cwd),
                &environment,
                operation,
                expires,
                cancelled,
            )
            .map_err(|error| Failure {
                category: "query",
                diagnostic: error.failure.first_message.clone(),
                completed: queries.clone(),
                stdout: error.stdout,
                stderr: error.stderr,
                cause: Some(error.failure),
                remote: None,
            })?;
            let state = &output.cleanup;
            let status = state.reaped;
            let group_settled = state.attempts.iter().any(|attempt| {
                matches!(
                    &attempt.settlement,
                    Some(Ok(crate::owned_group::GroupSettlement::Exited { .. }))
                )
            });
            queries.push(Query {
                ordinal: queries.len() as u8 + 1,
                operation: label,
                exit_code: status.and_then(|value| value.code),
                signal: status.and_then(|value| value.signal),
                stdout: STANDARD.encode(&output.stdout),
                stderr: STANDARD.encode(&output.stderr),
                cleanup: Cleanup {
                    exit_observed: state.exit_observed,
                    group_settled,
                    stdout_eof: state.pipes.stdout_eof,
                    stderr_eof: state.pipes.stderr_eof,
                    reaped: status.is_some(),
                    ownership_retained: state.ownership_retained,
                },
            });
            if label == "inside" && !status.is_some_and(|value| value.success) {
                break;
            }
        }
        Ok(Observation {
            schema: SCHEMA,
            id: self.captured.invocation.id.clone(),
            runtime_digest: self.captured.invocation.runtime_digest.clone(),
            token: self.token.clone(),
            cwd: self.captured.invocation.cwd.clone(),
            executable: self.captured.executable(),
            queries,
        })
    }
}
