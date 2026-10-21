#[cfg(not(unix))]
compile_error!("caws-native currently requires POSIX process groups");
mod cancellation;
mod cli;
#[cfg(any(target_os = "macos", test))]
mod engine_custody;
mod process_effect;
mod protocol;
mod render_bridge;
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
    let captured = (config.surface == "codex" && config.event == "pre_tool_use")
        .then(|| process_effect::CapturedAncestors::capture(deadline));
    let mut session =
        runner::Session::start(config, &request.id, deadline).map_err(Failure::configuration)?;
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
        let service_dispatch = session.admit_render_offer(
            config,
            &request,
            ready.as_mut().ok_or("missing engine readiness")?,
            deadline,
        )?;
        // A failed write may deliver the complete grant. Record the attempt
        // BEFORE writing; creation of the engine alone is not dispatch.
        dispatched = ready.as_ref().is_some_and(|context| context.active);
        session.send(
            &service_dispatch.unwrap_or_else(|| protocol::dispatch(&request)),
            deadline,
        )?;
        let mut cache_attempted = false;
        #[cfg(feature = "sqlite-store")]
        let mut store_attempted = false;
        loop {
            match protocol::validate_frame(&session.frame(deadline)?, &request)? {
                #[cfg(feature = "sqlite-store")]
                protocol::EngineFrame::TranscriptStoreRequest(frame) => {
                    if store_attempted {
                        return Err("transcript store exchange already attempted".into());
                    }
                    store_attempted = true;
                    let context = ready.as_ref().ok_or("missing store readiness")?;
                    caws_native::transcript_store_wire::serve(
                        &frame,
                        request.transcript_store_invocation(context, dispatched),
                        deadline,
                        || cancellation::check().is_err(),
                        &mut session,
                    )?;
                }
                protocol::EngineFrame::SessionCacheRequest(frame) => {
                    if cache_attempted {
                        return Err("session cache exchange already attempted".into());
                    }
                    cache_attempted = true;
                    let context = ready.as_ref().ok_or("missing cache readiness")?;
                    let mut owner = request.session_cache_owner(context, dispatched)?;
                    let admitted = owner.admit(&frame).map_err(|error| error.to_string())?;
                    session.credit_session_cache_control(frame.len() + 1)?;
                    let mut exchange_failure = None;
                    let mut decision_bytes = None;
                    let execution =
                        admitted.execute_checked(deadline, cancellation::check, |previous| {
                            let exchange = (|| {
                                session.send(previous, deadline)?;
                                let decision = session.frame(deadline)?;
                                decision_bytes = Some(decision.len() + 1);
                                Ok(decision)
                            })();
                            exchange.map_err(|error| {
                                exchange_failure = Some(error);
                                caws_native::session_cache_wire::WireError(
                                    "session cache transport failed",
                                )
                            })
                        });
                    if let Some(error) = execution.cancellation_error {
                        return Err(error);
                    }
                    if let Some(error) = execution.exchange_error {
                        return Err(exchange_failure.unwrap_or_else(|| error.to_string()));
                    }
                    if let Some(bytes) = decision_bytes {
                        // The operation accepted the decision schema and correlation.
                        session.credit_session_cache_control(bytes)?;
                    }
                    session.send(
                        &execution
                            .result
                            .encode()
                            .map_err(|error| error.to_string())?,
                        deadline,
                    )?;
                }
                protocol::EngineFrame::Proposal {
                    token,
                    result,
                    containment,
                } => break Ok((token, result, containment)),
                protocol::EngineFrame::Failure(message) => break Err(message),
                protocol::EngineFrame::Ready(_) => {
                    break Err("unexpected ready after dispatch grant".into());
                }
            }
        }
    })();
    let (token, result, containment) = match proposal {
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
    // A valid protective result survives invalid/held effects and late failures.
    // No path through this terminal phase can ask the engine for more work.
    let mut post_errors = Vec::new();
    if let Some(diagnostic) = session.render_diagnostic() {
        post_errors.push(diagnostic);
    }
    let mut receipt = None;
    let target = match containment {
        protocol::ContainmentProposal::None => None,
        protocol::ContainmentProposal::Invalid(error) => {
            post_errors.push(format!("containment intent rejected: {error}; no signal"));
            None
        }
        protocol::ContainmentProposal::Intent(intent) => {
            let context = process_effect::EffectContext {
                surface: &config.surface,
                event: &config.event,
                active: dispatched,
                session_id: ready.as_ref().and_then(|row| row.session_id.as_deref()),
                exit_code: result.exit_code,
                stdout: &result.stdout,
            };
            let validated = if !process_effect::eligible(&intent, &context) {
                Err(process_effect::HeldReason::UnsafeTarget)
            } else if let Some(captured) = captured.as_ref() {
                captured.validate(&intent)
            } else {
                Err(process_effect::HeldReason::CaptureUnavailable)
            };
            match validated {
                Ok(target) => Some(target),
                Err(reason) => {
                    // A closed caller output can also prevent the ACK from
                    // reaching the engine. Retain the bounded mechanical
                    // reason independently; never turn this into signal authority.
                    post_errors.push(format!(
                        "containment held before output: {reason:?}; no signal"
                    ));
                    if reason == process_effect::HeldReason::CaptureUnavailable
                        && let Some(captured) = captured.as_ref()
                    {
                        post_errors.push(format!("ancestor capture: {}", captured.diagnostic()));
                    }
                    receipt = Some(process_effect::ContainmentReceipt::held(&intent, reason));
                    None
                }
            }
        }
    };
    // TS's wire phase has an 1100ms budget. Share one terminal budget across
    // output (<=500ms), reobservation/effect (<=250ms), and receipt settlement.
    let terminal_deadline = Instant::now() + Duration::from_millis(1000);
    let delivered = if let Some(target) = target {
        session.begin_terminal_containment(&target);
        let delivered = runner::write_terminal_native(&result.stdout, &result.stderr, &target);
        receipt = Some(
            target.attempt(terminal_deadline.min(Instant::now() + Duration::from_millis(250))),
        );
        delivered
    } else {
        runner::write_native(&result.stdout, &result.stderr)
    };
    let post_deadline = terminal_deadline.min(Instant::now() + Duration::from_millis(500));
    if delivered.is_ok() && dispatched && config.event == "stop" && result.exit_code == 0 {
        // Unavailable may already have committed. Never retry this transaction.
        if let Some(context) = ready.as_ref()
            && let Err(error) = budget(context, post_deadline)
                .and_then(|state| state.reset(post_deadline).map_err(|e| e.to_string()))
        {
            post_errors.push(format!("Stop reset: {error}; not retried"));
        }
    }
    let ack = protocol::handoff(&request, &token, delivered.is_ok(), receipt.as_ref())
        .and_then(|bytes| session.send(&bytes, post_deadline));
    if let Err(error) = ack {
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
#[cfg(feature = "sqlite-store")]
mod sqlite_build_identity;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Identity is a separate tooling command; failures must not reach the
    // invocation fallback, whose no-event infrastructure policy may exit zero.
    if args
        .first()
        .is_some_and(|arg| arg == "--sqlite-build-identity")
    {
        if args.len() != 1 {
            eprintln!("CAWS SQLite identity requires exactly one argument");
            std::process::exit(2);
        }
        #[cfg(feature = "sqlite-store")]
        {
            if let Err(error) = sqlite_build_identity::run() {
                eprintln!("CAWS SQLite identity refused: {error}");
                std::process::exit(2);
            }
            return;
        }
        #[cfg(not(feature = "sqlite-store"))]
        {
            eprintln!("CAWS SQLite identity requires the qualified sqlite-store build feature");
            std::process::exit(2);
        }
    }
    #[cfg(target_os = "macos")]
    if args.first().is_some_and(|arg| arg == "engine-custodian") {
        let result = (|| {
            let fd = args
                .get(1)
                .filter(|_| args.len() == 2)
                .and_then(|value| {
                    value
                        .parse::<i32>()
                        .ok()
                        .filter(|fd| fd.to_string() == *value)
                })
                .filter(|fd| (32..=1_048_576).contains(fd))
                .ok_or("engine-custodian requires one inherited configuration descriptor")?;
            engine_custody::worker::run(fd)
        })();
        if let Err(error) = result {
            eprintln!("CAWS engine custodian refused: {error}");
            std::process::exit(75);
        }
        return;
    }
    if args.first().is_some_and(|arg| arg == "plan-snapshots") {
        match caws_native::plan_snapshots::run(&args[1..]) {
            Ok(code) => std::process::exit(i32::from(code)),
            Err(error) => {
                eprintln!("CAWS plan snapshot unavailable: {error}");
                std::process::exit(75);
            }
        }
    }
    if args.first().is_some_and(|arg| arg == "render-writer") {
        let code = match caws_native::render_writer::run(&args[1..]) {
            Ok(code) => code,
            Err(error) => {
                eprintln!("CAWS render writer unavailable: {error}");
                75
            }
        };
        std::process::exit(i32::from(code));
    }
    if args.first().is_some_and(|arg| arg == "renderer-host") {
        let result = if args.len() == 3 && args[1] == "--config" {
            caws_native::render_owner::host(std::path::Path::new(&args[2]))
        } else {
            Err("renderer-host requires --config <absolute path>".into())
        };
        if let Err(error) = result {
            eprintln!("CAWS renderer host refused: {error}");
            std::process::exit(2);
        }
        return;
    }
    if args
        .first()
        .is_some_and(|arg| arg == "renderer-service-init")
    {
        let result = (|| -> Result<(), String> {
            if args.len() != 1 {
                return Err("renderer-service-init reads one configuration from stdin".into());
            }
            use std::io::Read;
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(65_537)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 65_536 {
                return Err("renderer owner configuration exceeds bound".into());
            }
            let config = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            caws_native::render_owner::provision(&config, Instant::now() + Duration::from_secs(5))
        })();
        if let Err(error) = result {
            eprintln!("CAWS renderer initialization refused: {error}");
            std::process::exit(2);
        }
        return;
    }
    if args.first().is_some_and(|arg| arg == "renderer-worker") {
        let result = if args.len() == 1 {
            caws_native::renderer_backend::entry::run()
        } else {
            Err(caws_native::renderer_backend::Failure {
                code: caws_native::renderer_backend::FailureCode::InvalidSpec,
                errno: None,
            })
        };
        match result {
            Ok(exit) => std::process::exit(if exit.cleanup.direct_child_reaped {
                0
            } else {
                2
            }),
            Err(failure) => {
                eprintln!("CAWS renderer worker refused: {failure:?}");
                std::process::exit(2);
            }
        }
    }
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
