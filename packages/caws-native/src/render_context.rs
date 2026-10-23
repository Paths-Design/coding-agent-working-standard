//! Original-bound Render Git observations. No stock selection, publication,
//! cache, calendar, or complete Render context is supplied by this component.
use crate::invocation_project::{self as project, ProjectFailure, RenderQuery, SelectedExecutable};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path, time::Instant};

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
/// partial bytes remain separate. `cause` owns any uncertain Child until retry.
#[derive(Debug)]
pub struct Failure {
    pub category: &'static str,
    pub diagnostic: String,
    pub completed: Vec<Query>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub cause: Option<ProjectFailure>,
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
        }
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        self.cause
            .as_mut()
            .map_or(Ok(()), ProjectFailure::retry_cleanup)
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
pub struct RenderContextOwner {
    invocation: Invocation,
    selected: SelectedExecutable,
    used: bool,
    expires: Instant,
}
impl RenderContextOwner {
    pub fn capture(
        invocation: Invocation,
        expires: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Self, Failure> {
        if invocation.id.is_empty()
            || invocation.id.len() > 128
            || invocation.id.contains('\0')
            || !digest(&invocation.runtime_digest)
            || !token(&invocation.token)
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
            used: false,
            expires,
        })
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
        let expires = expires.min(self.expires);
        // Match the direct runtime's inherited routing removal. No process-wide
        // environment or PATH cache can enter this observation.
        let environment = self
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
                &self.selected,
                Path::new(&self.invocation.cwd),
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
            id: self.invocation.id.clone(),
            runtime_digest: self.invocation.runtime_digest.clone(),
            token: self.invocation.token.clone(),
            cwd: self.invocation.cwd.clone(),
            executable: Executable {
                path: self.selected.path.to_str().unwrap().into(),
                physical_path: self.selected.physical_path.to_str().unwrap().into(),
                sha256: self.selected.sha256.clone(),
            },
            queries,
        })
    }
}
