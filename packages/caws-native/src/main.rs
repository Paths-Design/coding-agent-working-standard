#[cfg(not(unix))]
compile_error!("caws-native currently requires POSIX process groups");
mod cancellation;
mod cli;
#[cfg(any(target_os = "macos", test))]
mod engine_custody;
mod installed_generation;
mod native_generation;
mod process_effect;
mod protocol;
mod render_bridge;
mod runner;
mod selection_observation;
mod stop_admission;
mod stop_execution;
mod stop_profile;

use caws_native::monotonic_deadline::MonotonicDeadline;
use caws_native::stop_budget::{BudgetIdentity, Charge, StopBudget};
use std::time::{Duration, Instant};

#[cfg(feature = "sqlite-store")]
#[derive(Clone, Copy)]
enum StoreProjectBinding {
    NotApplicable,
    Unbound,
    Bound,
}

// Only finite correlation/settlement metadata crosses back from the resident
// owner. The original acquisition and uncertain cleanup handles stay there.
#[cfg(feature = "sqlite-store")]
type StoreSettlement = caws_native::render_owner::StoreCompletion;

#[cfg(feature = "sqlite-store")]
fn retain_store_result(
    result: StoreSettlement,
    settlement: &mut Option<StoreSettlement>,
) -> (StoreProjectBinding, Result<(), String>) {
    let binding = if result.original_project_bound {
        StoreProjectBinding::Bound
    } else {
        StoreProjectBinding::Unbound
    };
    let status = result.status();
    *settlement = Some(result);
    (binding, status)
}

struct Failure<'deadline> {
    original_stop: Option<runner::OriginalStopPreparation<'deadline>>,
    dispatched: bool,
    ready: Option<Box<protocol::Ready>>,
    message: String,
    session_settlement: Option<caws_native::render_owner::SessionAcquisition>,
    #[cfg(feature = "sqlite-store")]
    store_settlement: Option<StoreSettlement>,
    #[cfg(feature = "sqlite-store")]
    store_project_binding: StoreProjectBinding,
}
impl<'deadline> Failure<'deadline> {
    fn configuration(message: String) -> Self {
        Self {
            original_stop: None,
            dispatched: false,
            ready: None,
            message,
            session_settlement: None,
            #[cfg(feature = "sqlite-store")]
            store_settlement: None,
            #[cfg(feature = "sqlite-store")]
            store_project_binding: StoreProjectBinding::NotApplicable,
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
fn execute<'deadline>(
    config: &cli::Config,
    original_deadline: &'deadline MonotonicDeadline,
) -> Result<u8, Failure<'deadline>> {
    // Bounded diagnostics use the same local clock as the original I/O bound.
    // They never renew that bound, grant admission, or retain payload/path data.
    let mut progress = InvocationProgress {
        started: original_deadline.expires() - config.timeout,
        phase: "payload",
        marks: Vec::new(),
        selection: None,
        completed_selection: 0,
        selection_advertised: false,
        selection_sealed: false,
        selection_revalidated: false,
        stock_selection: "not_attempted",
        native_stop: "not_attempted",
        original_render_captured: false,
        dispatch_written: false,
        generation_receipt_revalidations: native_generation::CheckTimings::default(),
        stop_prefix_authority_callbacks: native_generation::CheckTimings::default(),
    };
    progress.mark("payload");
    let outcome =
        execute_observed(config, original_deadline, &mut progress).map_err(|mut error| {
            error
                .message
                .push_str(&format!("; native progress {}", progress.snapshot()));
            error
        });
    if outcome.is_ok()
        && std::env::var_os("CAWS_NATIVE_TRACE_PROGRESS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
    {
        // Opt-in evidence only. This cannot enable a capability or change the
        // outcome; delivery is best effort under the existing diagnostic bound.
        progress.mark("completed");
        runner::write_diagnostic(
            format!("CAWS native progress {}\n", progress.snapshot()).as_bytes(),
        );
    }
    outcome
}

struct InvocationProgress {
    started: Instant,
    phase: &'static str,
    marks: Vec<(&'static str, u128)>,
    selection: Option<(usize, selection_observation::OperationKind)>,
    completed_selection: usize,
    selection_advertised: bool,
    selection_sealed: bool,
    selection_revalidated: bool,
    // Native-authored finite outcome only: no paths, payloads, engine claims or
    // refusal prose enter the bounded progress record. Admitted is necessary
    // stock selection, not profile/prefix/store/publication authority.
    stock_selection: &'static str,
    native_stop: &'static str,
    original_render_captured: bool,
    dispatch_written: bool,
    generation_receipt_revalidations: native_generation::CheckTimings,
    stop_prefix_authority_callbacks: native_generation::CheckTimings,
}
impl InvocationProgress {
    fn mark(&mut self, phase: &'static str) {
        self.phase = phase;
        // Phases are a fixed native sequence. Discovery requests only update
        // the last operation below, so neither volume nor caller data grows it.
        if self.marks.last().is_none_or(|(last, _)| *last != phase) && self.marks.len() < 32 {
            self.marks.push((phase, self.started.elapsed().as_millis()));
        }
    }
    fn stop_prefix_authority_check<R>(&self, check: impl FnOnce() -> R) -> R {
        self.stop_prefix_authority_callbacks.measure(check)
    }
    fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({"schema":"caws.native.invocation-progress.v1",
            "phase":self.phase,"elapsedLocalMs":self.started.elapsed().as_millis(),
            "marks":self.marks,"lastSelection":self.selection,
            "completedSelectionSequence":self.completed_selection,
            "selectionAdvertised":self.selection_advertised,
            "selectionSealed":self.selection_sealed,
            "selectionPredispatchRevalidated":self.selection_revalidated,
            "stockSelection":self.stock_selection,
            "nativeStop":self.native_stop,
            "originalRenderCaptured":self.original_render_captured,
            "dispatchGrantWritten":self.dispatch_written,
            "generationReceiptRevalidations":self.generation_receipt_revalidations.snapshot(),
            "stopPrefixAuthorityCallbacks":self.stop_prefix_authority_callbacks.snapshot()})
    }
}

fn execute_observed<'deadline>(
    config: &cli::Config,
    original_deadline: &'deadline MonotonicDeadline,
    progress: &mut InvocationProgress,
) -> Result<u8, Failure<'deadline>> {
    let deadline = original_deadline.expires();
    let (payload, input_json) = runner::read_payload(deadline).map_err(Failure::configuration)?;
    original_deadline
        .check()
        .map_err(|error| Failure::configuration(error.to_string()))?;
    let mut request = protocol::Request::new(config, payload, input_json, deadline)
        .map_err(Failure::configuration)?;
    // The optional candidate observes original inputs before Node. It neither
    // selects the native Stop route nor grants any prefix/publication effects.
    let generation_receipt_revalidations = progress.generation_receipt_revalidations.clone();
    let mut original_stop = runner::OriginalStopPreparation::capture_with_diagnostics(
        config,
        &request,
        original_deadline,
        generation_receipt_revalidations,
        |phase| progress.mark(phase),
    );
    progress.original_render_captured = original_stop.render.available();
    let outcome = (|| -> Result<u8, Failure<'deadline>> {
        progress.mark("selection-owner");
        let selection_limits = selection_observation::Limits::default();
        // Discovery cannot upgrade a refused candidate. Invalid original roots
        // disable this optional observation transport; compatibility remains
        // unchanged and successful context capture is still replayed below.
        let mut selection_owner = match (
            original_stop.generation.as_ref(),
            original_stop.original.as_ref(),
        ) {
            (Some(generation), Some(original)) => request
                .original_selection_roots(original)
                .and_then(|roots| {
                    selection_observation::SelectionObservationOwner::new(
                        generation,
                        original_deadline,
                        roots,
                        selection_limits,
                        cancellation::check,
                    )
                })
                .ok(),
            _ => None,
        };
        if let Some(owner) = selection_owner.as_ref() {
            request.advertise_selection_observation(owner.snapshot_id(), selection_limits);
            progress.selection_advertised = true;
        }
        progress.mark("request-encoding");
        // Advertisement is native-derived and precedes the only encoded request.
        let bytes = request
            .encode_frame()
            .map_err(|e| Failure::configuration(format!("request encoding: {e}")))?;
        if bytes.len() - 1 > runner::MAX_REQUEST {
            return Err(Failure::configuration("request exceeds byte limit".into()));
        }
        let mut selection_receipt = None;

        let mut captured_context = original_stop
            .original
            .as_ref()
            .map(protocol::CapturedContext::new);
        let captured = (config.surface == "codex" && config.event == "pre_tool_use")
            .then(|| process_effect::CapturedAncestors::capture(deadline));
        let prefix_ancestry = (cfg!(target_os = "macos")
            && config.configuration == "system"
            && config.event == "session_end"
            && matches!(config.surface.as_str(), "codex" | "claude-code"))
        .then(|| {
            caws_native::agent_pid_cache::OriginalAncestry::capture(
                &config.surface,
                deadline,
                cancellation::check,
            )
        })
        .transpose()
        .map_err(Failure::configuration)?;
        let mut context_git =
            caws_native::context_git::ContextGitOwner::new(caws_native::context_git::Invocation {
                id: request.id.clone(),
                runtime_digest: request.runtime_digest.clone(),
                deadline,
                environment: request
                    .caller_environment()
                    .iter()
                    .map(|(key, value)| (key.into(), value.into()))
                    .collect(),
            })
            .map_err(Failure::configuration)?;
        progress.mark("engine-start");
        let mut session = runner::Session::start(config, &request.id, deadline)
            .map_err(Failure::configuration)?;
        let mut ready = None;
        let mut dispatched = false;
        let mut session_settlement = None;
        #[cfg(feature = "sqlite-store")]
        let mut store_settlement = None;
        #[cfg(feature = "sqlite-store")]
        let mut store_project_binding = if caws_native::transcript_store_wire::supports_invocation(
            &config.surface,
            &config.event,
            &config.configuration,
        ) {
            StoreProjectBinding::Unbound
        } else {
            StoreProjectBinding::NotApplicable
        };
        let proposal = (|| {
            progress.mark("selection-discovery");
            session.send(&bytes, deadline)?;
            ready = Some(loop {
                match protocol::validate_frame(&session.frame(deadline)?, &request)? {
                    protocol::EngineFrame::SelectionObservationRequest(frame) => {
                        let observed = request.selection_request(&frame)?;
                        progress.selection = Some((observed.sequence, observed.operation.kind));
                        let owner = selection_owner
                            .as_mut()
                            .ok_or("selection observation was not advertised")?;
                        session.run_selection_observation(owner, &request, &frame, deadline)?;
                        progress.completed_selection = observed.sequence;
                    }
                    protocol::EngineFrame::ContextGitRequest(frame) => {
                        if let Some(replay) = captured_context.as_mut() {
                            session.replay_context_git(replay, &frame, deadline)?;
                        } else {
                            // No optional native capture is retried or upgraded.
                            // Unsupported/failed candidates keep the existing
                            // compatibility project's own context observation.
                            session.run_context_git(&mut context_git, &frame, deadline)?;
                        }
                    }
                    protocol::EngineFrame::Ready(value) => {
                        progress.mark("ready-received");
                        progress.mark("selection-seal");
                        selection_receipt = selection_owner
                            .take()
                            .map(|owner| owner.seal(cancellation::check))
                            .transpose()?;
                        progress.selection_sealed = selection_receipt.is_some();
                        context_git.mark_ready()?;
                        if let Some(replay) = captured_context.as_mut() {
                            replay.mark_ready();
                        }
                        break value;
                    }
                    protocol::EngineFrame::Failure(message) => return Err(message),
                    _ => return Err("engine proposal before dispatch grant".into()),
                }
            });
            // Ready ends discovery but grants no native Stop effects. Admit
            // exactly once using native original inputs and the sealed readset.
            // Both owners remain external, including on Unsupported, so the
            // existing strict predispatch freshness check cannot disappear.
            progress.mark("stock-selection");
            let stock_selection =
                match (original_stop.original.as_ref(), selection_receipt.as_ref()) {
                    (Some(original), Some(receipt)) => {
                        match stop_admission::StockStopSelection::admit(
                            original,
                            config,
                            receipt,
                            cancellation::check,
                        ) {
                            Ok(selected) => {
                                progress.stock_selection = "admitted";
                                Some(selected)
                            }
                            Err(stop_admission::Refusal::Unsupported(_)) => {
                                progress.stock_selection = "unsupported";
                                None
                            }
                            Err(stop_admission::Refusal::Invalidated(reason)) => {
                                progress.stock_selection = "invalidated";
                                return Err(reason);
                            }
                        }
                    }
                    _ => None,
                };
            progress.mark("stop-qualification");
            let eligible_stop = match (
                stock_selection.as_ref(),
                original_stop.generation.as_ref(),
                original_stop.render.available(),
            ) {
                (Some(selected), Some(generation), true) => stop_execution::EligibleStop::admit(
                    selected,
                    generation,
                    ready.as_ref().ok_or("missing Stop readiness")?,
                    cancellation::check,
                )?,
                _ => None,
            };
            progress.native_stop = if eligible_stop.is_some() {
                "qualified"
            } else {
                "unsupported"
            };
            progress.mark("render-admission");
            let service_dispatch = session.admit_render_offer(
                config,
                &request,
                ready.as_mut().ok_or("missing engine readiness")?,
                deadline,
            )?;
            // A sealed readset is lifecycle evidence, never eligibility. Keep
            // the owner through this execution and refuse stale dependencies
            // before the dispatch attempt, including inactive/custom selection.
            if let Some(receipt) = selection_receipt.as_ref() {
                progress.mark("selection-predispatch-revalidation");
                if let Some(selected) = stock_selection.as_ref() {
                    selected
                        .revalidate(cancellation::check)
                        .map_err(|refusal| {
                            progress.stock_selection = "invalidated";
                            refusal.to_string()
                        })?;
                } else {
                    receipt.revalidate(cancellation::check)?;
                }
                progress.selection_revalidated = true;
            }
            // A failed write may deliver the complete grant. Record the attempt
            // BEFORE writing; creation of the engine alone is not dispatch.
            dispatched = ready.as_ref().is_some_and(|context| context.active);
            progress.mark("dispatch-grant");
            let dispatch = if let Some(eligible) = eligible_stop.as_ref() {
                eligible.revalidate(cancellation::check)?;
                eligible.dispatch(&request)?
            } else {
                service_dispatch.unwrap_or_else(|| protocol::dispatch(&request))
            };
            session.send(&dispatch, deadline)?;
            progress.dispatch_written = true;
            let mut cache_attempted = false;
            let mut prefix_complete = false;
            let mut publication_attempted = false;
            let mut completed_stop_prefix = None;
            #[cfg(feature = "sqlite-store")]
            let mut store_attempted = false;
            loop {
                match protocol::validate_frame(&session.frame(deadline)?, &request)? {
                    protocol::EngineFrame::SelectionObservationRequest(_) => {
                        return Err("selection observation request after Ready".into());
                    }
                    protocol::EngineFrame::ContextGitRequest(_) => {
                        return Err("context Git request after Ready".into());
                    }
                    #[cfg(feature = "sqlite-store")]
                    protocol::EngineFrame::TranscriptStoreRequest(frame) => {
                        if store_attempted || publication_attempted {
                            return Err("transcript store exchange already attempted".into());
                        }
                        store_attempted = true;
                        publication_attempted = true;
                        let context = ready.as_ref().ok_or("missing store readiness")?;
                        let result = match render_bridge::captured_publication_owner_config(
                            config, &request, context,
                        ) {
                            Ok(owner) if eligible_stop.is_some() => {
                                let eligible = eligible_stop
                                    .as_ref()
                                    .ok_or("missing native Stop eligibility")?;
                                let completed = completed_stop_prefix.as_ref().ok_or(
                                    "native Stop store requires completed original prefix",
                                )?;
                                let original = original_stop
                                    .original
                                    .as_ref()
                                    .ok_or("missing native Stop original")?;
                                let registration =
                                    caws_native::render_owner::NativeStopRegistration::capture(
                                        &frame,
                                        request.transcript_store_invocation(context, dispatched),
                                        original,
                                        completed,
                                    )?;
                                let cancelled = || cancellation::check().is_err();
                                original_stop.render.with_transport(
                                    &mut session,
                                    &cancelled,
                                    |transport| {
                                        caws_native::render_owner::acquire_native_stop_store(
                                            &owner,
                                            registration,
                                            deadline,
                                            &cancelled,
                                            |_| eligible.revalidate(cancellation::check),
                                            transport,
                                        )
                                    },
                                )?
                            }
                            Ok(owner) => caws_native::render_owner::acquire_store(
                                &owner,
                                caws_native::render_owner::StoreAcquire::capture(
                                    &frame,
                                    request.transcript_store_invocation(context, dispatched),
                                    &original_deadline,
                                ),
                                deadline,
                                || cancellation::check().is_err(),
                                &mut session,
                            ),
                            Err(error) => caws_native::render_owner::StoreCompletion::unavailable(
                                &request.id,
                                &request.runtime_digest,
                                error,
                            ),
                        };
                        let (binding, status) = retain_store_result(result, &mut store_settlement);
                        store_project_binding = binding;
                        status?;
                    }
                    protocol::EngineFrame::SessionSealRequest(frame) => {
                        if publication_attempted || !prefix_complete {
                            return Err(
                                "session seal requires one completed native SessionEnd prefix"
                                    .into(),
                            );
                        }
                        publication_attempted = true;
                        let context = ready.as_ref().ok_or("missing session readiness")?;
                        let owner = render_bridge::captured_publication_owner_config(
                            config, &request, context,
                        )?;
                        let acquisition = caws_native::render_owner::SessionAcquire::capture(
                            &frame,
                            &request.session_invocation(context, dispatched),
                            deadline,
                        )?;
                        let result = caws_native::render_owner::acquire_session(
                            &owner,
                            acquisition,
                            deadline,
                            || cancellation::check().is_err(),
                            &mut session,
                        );
                        let status = result.status();
                        session_settlement = Some(result);
                        status?;
                    }
                    protocol::EngineFrame::StopPrefixRequest(frame) => {
                        if cache_attempted || publication_attempted {
                            return Err(
                                "Stop prefix exchange already attempted or publication started"
                                    .into(),
                            );
                        }
                        cache_attempted = true;
                        let eligible = eligible_stop
                            .as_ref()
                            .ok_or("Stop prefix lacks native eligibility")?;
                        eligible.revalidate(cancellation::check)?;
                        let context = ready.as_ref().ok_or("missing Stop prefix readiness")?;
                        let original = original_stop
                            .original
                            .as_ref()
                            .ok_or("missing original Stop capture")?;
                        let mut owner = original
                            .prefix_owner(request.stop_prefix_invocation(context, dispatched))?;
                        let admitted = owner.admit(&frame).map_err(|e| e.to_string())?;
                        session.credit_session_cache_control(frame.len() + 1)?;
                        let mut exchange_failure = None;
                        let mut decision_bytes = None;
                        let execution = admitted.execute_checked(
                            || {
                                progress.stop_prefix_authority_check(|| {
                                    eligible.revalidate(cancellation::check)
                                })
                            },
                            |previous| {
                                let exchange = (|| {
                                    session.send(previous, deadline)?;
                                    let decision = session.frame(deadline)?;
                                    decision_bytes = Some(decision.len() + 1);
                                    Ok(decision)
                                })();
                                exchange.map_err(|error| {
                                    exchange_failure = Some(error);
                                    caws_native::session_cache_wire::WireError(
                                        "Stop prefix transport failed",
                                    )
                                })
                            },
                        );
                        let result = execution.result().encode().map_err(|e| e.to_string())?;
                        if let Some(bytes) = decision_bytes {
                            session.credit_session_cache_control(bytes)?;
                        }
                        let failure =
                            execution
                                .cancellation_error()
                                .map(str::to_owned)
                                .or_else(|| {
                                    execution
                                        .exchange_error()
                                        .map(|e| exchange_failure.unwrap_or_else(|| e.to_string()))
                                });
                        if let Some(reason) = failure {
                            return Err(format!(
                                "{reason}; retained Stop prefix {}; no retry",
                                String::from_utf8_lossy(&result)
                            ));
                        }
                        // Deliver the actual observation before checking completion;
                        // TS retains partial-effect results rather than inventing success.
                        session.send(&result, deadline).map_err(|error| {
                            format!(
                                "{error}; retained Stop prefix {}; delivery uncertain; no retry",
                                String::from_utf8_lossy(&result)
                            )
                        })?;
                        completed_stop_prefix =
                            Some(execution.into_completed().map_err(|execution| {
                                format!(
                                    "Stop prefix incomplete; retained result {}; no retry",
                                    String::from_utf8_lossy(
                                        &execution.result().encode().unwrap_or_default()
                                    )
                                )
                            })?);
                    }
                    protocol::EngineFrame::SessionEndPrefixRequest(frame) => {
                        if cache_attempted || publication_attempted {
                            return Err(
                                "session prefix exchange already attempted or publication started"
                                    .into(),
                            );
                        }
                        cache_attempted = true;
                        let context = ready.as_ref().ok_or("missing prefix readiness")?;
                        let original = prefix_ancestry
                            .as_ref()
                            .ok_or("missing original SessionEnd ancestry")?;
                        let mut owner =
                            request.session_prefix_owner(context, dispatched, original)?;
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
                                        "session prefix transport failed",
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
                            session.credit_session_cache_control(bytes)?;
                        }
                        prefix_complete = execution.result.prefix_complete();
                        if !prefix_complete && !execution.result.fallback_safe() {
                            return Err(
                            "session prefix did not complete; effects may be uncertain; no retry"
                                .into(),
                        );
                        }
                        session.send(
                            &execution
                                .result
                                .encode()
                                .map_err(|error| error.to_string())?,
                            deadline,
                        )?;
                    }
                    protocol::EngineFrame::SessionCacheRequest(frame) => {
                        if cache_attempted || publication_attempted {
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
                    original_stop: None,
                    dispatched,
                    ready: ready.map(Box::new),
                    message,
                    session_settlement,
                    #[cfg(feature = "sqlite-store")]
                    store_settlement,
                    #[cfg(feature = "sqlite-store")]
                    store_project_binding,
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
                            post_errors
                                .push(format!("ancestor capture: {}", captured.diagnostic()));
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
        // Keep the resident record correlation through final frontend output.
        #[cfg(feature = "sqlite-store")]
        let _store_settlement = store_settlement.as_ref();
        let _session_settlement = session_settlement.as_ref();
        Ok(code)
    })();
    match outcome {
        Ok(code) => {
            if let Err(error) = original_stop.retry_cleanup() {
                runner::write_diagnostic(format!("CAWS optional original Stop discovery retains native cleanup custody: {error}; no native retry or publication.\n").as_bytes());
            }
            Ok(code)
        }
        Err(mut error) => {
            error.original_stop = Some(original_stop);
            Err(error)
        }
    }
}
fn fallback(mut error: Failure<'_>, pre: bool, stop: bool) -> u8 {
    // Keep the actual optional capture and any RemoteFailure through fallback
    // output. Retry only cleanup; its original request clock is never renewed.
    let original_cleanup = error
        .original_stop
        .as_mut()
        .and_then(|owner| owner.retry_cleanup().err());
    let _session_settlement = error.session_settlement.as_ref();
    // Frontend failure retains finite metadata; the resident owns SQL cleanup.
    #[cfg(feature = "sqlite-store")]
    let _store_settlement = error.store_settlement.as_ref();
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
    if let Some(cleanup) = original_cleanup {
        reason.push_str(&format!(" Original project native custodian retains cleanup: {cleanup}; native candidate was not retried."));
    }
    let mut block = pre || error.dispatched;
    #[cfg(feature = "sqlite-store")]
    if let Some(outcome) = error
        .store_settlement
        .as_ref()
        .filter(|record| record.error.is_none())
        .and_then(|record| record.acquisition.as_ref())
    {
        // Report only finite settlement metadata, never SQL cell/error payloads.
        reason.push_str(&format!(
            " Completed store exchange retained: end={}; acquisitionFailed={}; rowsDelivered={}.",
            outcome.end,
            outcome.first_failure.is_some(),
            outcome.rows_delivered,
        ));
    }
    if error.dispatched && stop {
        let budget_ready = error.ready.as_deref();
        #[cfg(feature = "sqlite-store")]
        let budget_ready = budget_ready
            .filter(|_| !matches!(error.store_project_binding, StoreProjectBinding::Unbound));
        match charge(budget_ready, Instant::now() + Duration::from_millis(100)) {
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
    if args
        .first()
        .is_some_and(|arg| arg == "context-git-custodian")
    {
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
                .filter(|fd| (64..=1_048_576).contains(fd))
                .ok_or("context-git-custodian requires one inherited control descriptor")?;
            caws_native::context_git::run_custodian(fd)
        })();
        if let Err(error) = result {
            eprintln!("CAWS context Git custodian refused: {error}");
            std::process::exit(75);
        }
        return;
    }
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
    let configuration = cancellation::install().and_then(|()| cli::Config::parse(&args));
    let code = match configuration {
        Err(error) => fallback(
            Failure::configuration(error),
            event("pre_tool_use"),
            event("stop"),
        ),
        Ok(config) => {
            // Same original start point: after configuration and before payload.
            // This outer owner outlives execute and failure output, so the opaque
            // capture can retain its original clock without a self-reference.
            match MonotonicDeadline::capture(config.timeout) {
                Err(error) => fallback(
                    Failure::configuration(error.to_string()),
                    event("pre_tool_use"),
                    event("stop"),
                ),
                Ok(original_deadline) => match execute(&config, &original_deadline) {
                    Ok(code) => code,
                    Err(error) => fallback(error, event("pre_tool_use"), event("stop")),
                },
            }
        }
    };
    std::process::exit(code.into());
}

#[cfg(all(test, feature = "sqlite-store"))]
mod store_settlement_tests {
    use super::*;

    #[test]
    fn store_settlement_failure_retention_preserves_native_project_binding() {
        for bound in [false, true] {
            let mut result =
                StoreSettlement::unavailable("invocation", &"a".repeat(64), "sentinel".into());
            result.original_project_bound = bound;
            let mut retained = None;
            let (binding, status) = retain_store_result(result, &mut retained);
            assert_eq!(status, Err("sentinel".into()));
            assert_eq!(matches!(binding, StoreProjectBinding::Bound), bound);
            assert_eq!(matches!(binding, StoreProjectBinding::Unbound), !bound);
            let failure = retained.unwrap();
            assert_eq!(failure.error.as_deref(), Some("sentinel"));
            assert_eq!(failure.original_project_bound, bound);
        }
    }
}

#[cfg(test)]
mod invocation_diagnostic_tests {
    use super::*;
    #[test]
    fn stop_prefix_authority_diagnostics_count_refusals_and_keep_generation_counts_separate() {
        let progress = InvocationProgress {
            started: Instant::now(),
            phase: "test",
            marks: vec![],
            selection: None,
            completed_selection: 0,
            selection_advertised: false,
            selection_sealed: false,
            selection_revalidated: false,
            stock_selection: "not_attempted",
            native_stop: "not_attempted",
            original_render_captured: false,
            dispatch_written: false,
            generation_receipt_revalidations: native_generation::CheckTimings::default(),
            stop_prefix_authority_callbacks: native_generation::CheckTimings::default(),
        };
        assert_eq!(
            progress.stop_prefix_authority_check(|| Ok::<_, String>(7)),
            Ok(7)
        );
        assert_eq!(
            progress.stop_prefix_authority_check(|| Err::<(), _>("unchanged authority refusal")),
            Err("unchanged authority refusal")
        );
        let snapshot = progress.snapshot();
        assert_eq!(snapshot["stopPrefixAuthorityCallbacks"]["count"], 2);
        assert!(snapshot["stopPrefixAuthorityCallbacks"]["elapsedMicros"].is_u64());
        assert_eq!(snapshot["generationReceiptRevalidations"]["count"], 0);
        assert_eq!(
            snapshot["generationReceiptRevalidations"]["elapsedMicros"],
            0
        );
        assert!(
            snapshot["stopPrefixAuthorityCallbacks"]
                .as_object()
                .unwrap()
                .keys()
                .all(|key| matches!(key.as_str(), "count" | "elapsedMicros"))
        );
    }
}
