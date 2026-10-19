#[cfg(not(unix))]
compile_error!("caws-native currently requires POSIX process groups");
mod cancellation;
mod cli;
mod protocol;
mod runner;

use caws_native::stop_budget::{BudgetIdentity, Charge, StopBudget};
use std::time::{Duration, Instant};

struct Failure {
    dispatched: bool,
    ready: Option<protocol::Ready>,
    message: String,
}
impl Failure {
    fn configuration(message: String) -> Self {
        Self {
            dispatched: false,
            ready: None,
            message,
        }
    }
}
fn budget(ready: &protocol::Ready, expires: Instant) -> Result<StopBudget, String> {
    let identity =
        BudgetIdentity::resolve(ready.session_id.as_deref(), ready.project_digest.as_deref())
            .map_err(|e| e.to_string())?;
    StopBudget::open(&ready.budget_home, identity, expires).map_err(|e| e.to_string())
}
fn charge(ready: Option<&protocol::Ready>, expires: Instant) -> Result<Charge, String> {
    let ready = ready.ok_or("Stop budget unavailable: no validated project context")?;
    budget(ready, expires)?
        .charge(expires)
        .map_err(|e| e.to_string())
}
fn execute(config: &cli::Config) -> Result<u8, Failure> {
    let deadline = Instant::now() + config.timeout;
    let (payload, input_json) = runner::read_payload(deadline).map_err(Failure::configuration)?;
    let request = protocol::Request::new(config, payload, input_json, deadline)
        .map_err(Failure::configuration)?;
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|e| Failure::configuration(format!("request encoding: {e}")))?;
    if bytes.len() > runner::MAX_REQUEST {
        return Err(Failure::configuration("request exceeds byte limit".into()));
    }
    bytes.push(b'\n');
    let mut session = runner::Session::start(config, deadline).map_err(Failure::configuration)?;
    let mut ready = None;
    let mut dispatched = false;
    let proposal = (|| {
        session.send(&bytes, deadline)?;
        ready = Some(
            match protocol::validate_frame(&session.frame(deadline)?, &request)? {
                protocol::EngineFrame::Ready(value) => value,
                protocol::EngineFrame::Failure(message) => return Err(message),
                _ => return Err("engine proposal before dispatch grant".into()),
            },
        );
        // A failed write may deliver the complete grant. Record the attempt
        // BEFORE writing; creation of the engine alone is not dispatch.
        dispatched = ready.as_ref().is_some_and(|context| context.active);
        session.send(&protocol::dispatch(&request), deadline)?;
        match protocol::validate_frame(&session.frame(deadline)?, &request)? {
            protocol::EngineFrame::Proposal { token, result } => Ok((token, result)),
            protocol::EngineFrame::Failure(message) => Err(message),
            protocol::EngineFrame::Ready(_) => Err("unexpected ready after dispatch grant".into()),
        }
    })();
    let (token, result) = match proposal {
        Ok(value) => value,
        Err(mut message) => {
            if let Err(error) = session.cleanup() {
                message.push_str(&format!("; cleanup: {error}"));
            }
            return Err(Failure {
                dispatched,
                ready,
                message,
            });
        }
    };
    // A valid proposal remains known through late engine/cleanup failure. This
    // ACK acknowledges local byte acceptance, not harness or model receipt.
    let delivered = runner::write_native(&result.stdout, &result.stderr);
    let post_deadline = Instant::now() + Duration::from_millis(500);
    let mut post_errors = Vec::new();
    if delivered.is_ok() && dispatched && config.event == "stop" && result.exit_code == 0 {
        // Unavailable may already have committed. Never retry this transaction.
        if let Some(context) = ready.as_ref()
            && let Err(error) = budget(context, post_deadline)
                .and_then(|state| state.reset(post_deadline).map_err(|e| e.to_string()))
        {
            post_errors.push(format!("Stop reset: {error}; not retried"));
        }
    }
    if let Err(error) = session.send(
        &protocol::handoff(&request, &token, delivered.is_ok()),
        post_deadline,
    ) {
        post_errors.push(format!("handoff ACK: {error}; settlement unconfirmed"));
    }
    if let Err(error) = session.settle(post_deadline) {
        post_errors.push(format!(
            "engine settlement: {error}; settlement unconfirmed"
        ));
    }
    if let Err(error) = session.cleanup() {
        post_errors.push(format!("cleanup: {error}"));
    }
    let mut code = result.exit_code;
    if let Err(error) = delivered {
        code = 2;
        let mut note = String::new();
        // A valid refusal never charges/resets the infrastructure counter, even
        // when its native output could not be fully handed off.
        if dispatched && config.event == "stop" && result.exit_code != 2 {
            match charge(ready.as_ref(), Instant::now() + Duration::from_millis(100)) {
                Ok(Charge::Refuse) => {}
                Ok(Charge::Release) => {
                    code = 0;
                    note = " Stop infrastructure budget exhausted; releasing this Stop.".into();
                }
                Err(unavailable) => {
                    code = 0;
                    note = format!(
                        " {unavailable}; releasing this infrastructure Stop; transaction not retried."
                    );
                }
            }
        }
        post_errors.push(format!("output delivery failed: {error}. Output may be partial; consumer receipt is unconfirmed.{note}"));
    }
    if !post_errors.is_empty() {
        runner::write_diagnostic(
            format!(
                "CAWS native post-proposal diagnostic: {}\n",
                post_errors.join("; ")
            )
            .as_bytes(),
        );
    }
    Ok(code)
}
fn fallback(error: Failure, pre: bool, stop: bool) -> u8 {
    let mut reason = format!(
        "CAWS native infrastructure failure ({}): {}. Checks did not complete; request was not retried.{}",
        if error.dispatched {
            "execution"
        } else {
            "configuration"
        },
        error.message,
        if error.dispatched {
            " Execution outcome may be uncertain."
        } else {
            ""
        }
    );
    let mut block = pre || error.dispatched;
    if error.dispatched && stop {
        match charge(
            error.ready.as_ref(),
            Instant::now() + Duration::from_millis(100),
        ) {
            Ok(Charge::Refuse) => {}
            Ok(Charge::Release) => {
                block = false;
                reason.push_str(" Stop infrastructure budget exhausted; releasing this Stop.");
            }
            Err(unavailable) => {
                block = false;
                reason.push_str(&format!(
                    " {unavailable}; releasing this infrastructure Stop; transaction not retried."
                ));
            }
        }
    }
    let stdout = if block {
        format!(
            "{}\n",
            serde_json::json!({"decision":"block","reason":reason})
        )
        .into_bytes()
    } else if error.dispatched && stop {
        format!("{}\n", serde_json::json!({"systemMessage":reason})).into_bytes()
    } else {
        Vec::new()
    };
    if let Err(write) = runner::write_native(&stdout, format!("{reason}\n").as_bytes()) {
        runner::write_diagnostic(format!("{reason}\nCAWS native output delivery failed: {write}. Output may be partial; consumer receipt is unconfirmed.\n").as_bytes());
        return if !block { 0 } else { 2 };
    }
    if block { 2 } else { 0 }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let event = |name| args.windows(2).any(|v| v[0] == "--event" && v[1] == name);
    let result = cancellation::install()
        .and_then(|()| cli::Config::parse(&args))
        .map_err(Failure::configuration)
        .and_then(|config| execute(&config));
    let code = match result {
        Ok(code) => code,
        Err(error) => fallback(error, event("pre_tool_use"), event("stop")),
    };
    std::process::exit(code.into());
}
