use super::*;
use caws_native::owned_group::{GroupObservation, SettlementStage, StopStage};

fn configuration() -> Configuration {
    Configuration {
        schema: CONFIG_SCHEMA.into(),
        invocation_id: "pure-worker-1".into(),
        runtime_digest: "a".repeat(64),
        deadline: MonotonicDeadline::capture(Duration::from_secs(10))
            .unwrap()
            .envelope(),
        node: "/node".into(),
        engine: "/engine.js".into(),
        control_fd: 32,
        receipt_fd: 33,
        render_fds: None,
    }
}
fn exited_group() -> GroupSettlement {
    GroupSettlement::Exited {
        observation: GroupObservation {
            bytes: 600,
            capacity: 4096,
            members: 2,
            zombies: 2,
            leaders: 1,
            ..GroupObservation::default()
        },
    }
}
fn stop_error() -> StopError {
    StopError {
        stage: StopStage::Ownership,
        raw_errno: Some(libc::ECHILD),
        signal_errno: Some(libc::EPERM),
        observed_pid: Some(91),
        observed_code: Some(libc::CLD_EXITED),
        group: Some(GroupObservation {
            reason: 4,
            query_errno: libc::ENOMEM,
            ..GroupObservation::default()
        }),
    }
}
fn observation_error() -> SettlementError {
    SettlementError {
        stage: SettlementStage::AfterOwnership,
        raw_errno: Some(libc::ECHILD),
        observed_pid: None,
        observed_code: None,
        before: Some(caws_native::owned_group::SettlementLeader {
            pid: 91,
            code: libc::CLD_EXITED,
        }),
        after: None,
        group: Some(GroupObservation {
            reason: 3,
            query_errno: libc::EACCES,
            ..GroupObservation::default()
        }),
    }
}
struct Ops {
    stops: VecDeque<Result<GroupStop, StopError>>,
    settlements: VecDeque<Result<GroupSettlement, SettlementError>>,
    reaps: VecDeque<io::Result<Option<ExitStatus>>>,
    calls: Vec<&'static str>,
}
impl Ops {
    fn new() -> Self {
        Self {
            stops: VecDeque::new(),
            settlements: VecDeque::new(),
            reaps: VecDeque::new(),
            calls: Vec::new(),
        }
    }
}
impl CleanupOps for Ops {
    fn stop(&mut self) -> Result<GroupStop, StopError> {
        self.calls.push("stop");
        self.stops.pop_front().expect("unexpected stop")
    }
    fn settlement(&mut self) -> Result<GroupSettlement, SettlementError> {
        self.calls.push("settlement");
        self.settlements.pop_front().expect("unexpected settlement")
    }
    fn reap(&mut self) -> io::Result<Option<ExitStatus>> {
        self.calls.push("reap");
        self.reaps.pop_front().expect("unexpected reap")
    }
}

#[test]
fn stop_refusal_preserves_results_and_never_observes_or_reaps() {
    let mut ops = Ops::new();
    let error = stop_error();
    ops.stops.push_back(Err(error.clone()));
    let mut cleanup = Cleanup::default();
    cleanup.step(&mut ops);
    assert_eq!(cleanup.stop, Some(Err(error.clone())));
    assert_eq!(cleanup.error, Some(error.to_string()));
    assert!(cleanup.exit.is_none());
    assert_eq!(ops.calls, ["stop"]);
    cleanup.retry();
    assert_eq!(
        cleanup.stop,
        Some(Err(error)),
        "retry must not erase unpublished failure"
    );
}

#[test]
fn running_live_and_unknown_settlement_never_reap_even_if_outputs_closed() {
    for result in [
        Ok(GroupSettlement::LeaderRunning),
        Ok(GroupSettlement::GroupLive {
            observation: GroupObservation {
                reason: 8,
                members: 2,
                zombies: 1,
                ..GroupObservation::default()
            },
        }),
        Err(observation_error()),
    ] {
        let mut ops = Ops::new();
        ops.stops.push_back(Ok(GroupStop::Signalled));
        ops.settlements.push_back(result.clone());
        let mut cleanup = Cleanup::default();
        cleanup.step(&mut ops);
        assert_eq!(cleanup.settlement, Some(result));
        assert_eq!(ops.calls, ["stop", "settlement"]);
        let mut row = receipt(&configuration(), ReceiptState::Pending, Some(91));
        row.stdout_eof = true;
        row.stderr_eof = true;
        assert!(!cleanup_complete(
            &cleanup,
            &row,
            &Queue::default(),
            &Queue::default(),
            &Queue::default()
        ));
    }
}

#[test]
fn reap_failure_keeps_anchor_then_retry_caches_actual_nonzero_exit() {
    let mut ops = Ops::new();
    ops.stops
        .extend([Ok(GroupStop::Signalled), Ok(GroupStop::Absent)]);
    ops.settlements
        .extend([Ok(exited_group()), Ok(exited_group())]);
    ops.reaps.extend([
        Err(io::Error::from_raw_os_error(libc::EIO)),
        Ok(Some(ExitStatus::from_raw(42 << 8))),
    ]);
    let mut cleanup = Cleanup::default();
    cleanup.step(&mut ops);
    assert!(cleanup.exit.is_none());
    assert!(cleanup.error.as_ref().unwrap().contains("code: 5"));
    cleanup.retry();
    cleanup.step(&mut ops);
    assert_eq!(cleanup.exit, Some(42 << 8));
    assert_eq!(cleanup.error, None);
    cleanup.retry();
    cleanup.step(&mut ops);
    assert_eq!(
        ops.calls,
        ["stop", "settlement", "reap", "stop", "settlement", "reap"]
    );
    assert!(ops.stops.is_empty() && ops.settlements.is_empty() && ops.reaps.is_empty());
    assert_eq!(CLEANUP_ATTEMPT, Duration::from_millis(500));
}

#[test]
fn leader_reap_eofs_and_each_proxy_queue_are_independent_completion_gates() {
    let mut ops = Ops::new();
    ops.stops.push_back(Ok(GroupStop::Signalled));
    ops.settlements.push_back(Ok(exited_group()));
    ops.reaps.push_back(Ok(Some(ExitStatus::from_raw(0))));
    let mut cleanup = Cleanup::default();
    cleanup.step(&mut ops);
    let mut row = receipt(&configuration(), ReceiptState::Pending, Some(91));
    let mut input = Queue::default();
    let mut out = Queue::default();
    let mut err = Queue::default();
    assert!(!cleanup_complete(&cleanup, &row, &input, &out, &err));
    row.stdout_eof = true;
    assert!(!cleanup_complete(&cleanup, &row, &input, &out, &err));
    row.stderr_eof = true;
    for which in 0..3 {
        let queue = match which {
            0 => &mut input,
            1 => &mut out,
            _ => &mut err,
        };
        queue.push(b"\x00\xffopaque\n");
        assert!(!cleanup_complete(&cleanup, &row, &input, &out, &err));
        let queue = match which {
            0 => &mut input,
            1 => &mut out,
            _ => &mut err,
        };
        queue.discard();
        assert!(cleanup_complete(&cleanup, &row, &input, &out, &err));
    }
    assert_eq!(out.discarded, 9);
    out.accepted += 1;
    assert!(
        !cleanup_complete(&cleanup, &row, &input, &out, &err),
        "unaccounted bytes must hold completion"
    );
}

#[test]
fn opaque_queue_bound_and_stdin_eof_do_not_mean_frontend_death() {
    let bytes: Vec<_> = (0..CHANNEL_LIMIT).map(|n| (n % 256) as u8).collect();
    let mut queue = Queue::default();
    queue.push(&bytes);
    assert_eq!(queue.capacity(), 0);
    assert_eq!(queue.bytes.iter().copied().collect::<Vec<_>>(), bytes);
    assert!(!input_drained(true, &queue));
    queue.consume(257);
    assert_eq!(
        queue.bytes.iter().copied().collect::<Vec<_>>(),
        bytes[257..]
    );
    queue.discard();
    assert!(queue.accounted());
    assert!(input_drained(true, &queue));
    assert!(!input_drained(false, &queue));
    assert_eq!(control_reason(b""), "frontend_gone");
    assert_eq!(control_reason(b"S"), "stop_requested");
    assert_eq!(control_reason(b"SS"), "stop_requested");
    assert_eq!(control_reason(b"X"), "invalid_control");
}

#[test]
fn lost_control_is_latched_and_removed_from_poll_sources() {
    for terminal in [Ok(Some("frontend_gone")), Err("control EIO".into())] {
        let mut liveness = ControlLiveness::default();
        assert_eq!(liveness.poll_descriptor(32).unwrap().fd, 32);
        liveness.observe(&terminal);
        assert!(liveness.lost);
        assert!(liveness.poll_descriptor(32).is_none());
        liveness.observe(&Ok(None));
        assert!(
            liveness.poll_descriptor(32).is_none(),
            "later loop iterations cannot revive a closed endpoint"
        );
    }
    let mut liveness = ControlLiveness::default();
    liveness.observe(&Ok(Some("stop_requested")));
    assert!(
        liveness.poll_descriptor(32).is_some(),
        "stop byte is not endpoint EOF"
    );
}

enum WriteAction {
    Partial(usize),
    Error(i32),
}
#[derive(Default)]
struct Sink {
    bytes: Vec<u8>,
    writes: VecDeque<WriteAction>,
    sync_errors: VecDeque<Option<i32>>,
    calls: Vec<&'static str>,
}
impl ReceiptSink for Sink {
    fn length(&self) -> io::Result<u64> {
        Ok(self.bytes.len() as u64)
    }
    fn append(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.calls.push("append");
        let count = match self.writes.pop_front() {
            Some(WriteAction::Partial(n)) => n.min(bytes.len()),
            Some(WriteAction::Error(errno)) => return Err(io::Error::from_raw_os_error(errno)),
            None => bytes.len(),
        };
        self.bytes.extend_from_slice(&bytes[..count]);
        Ok(count)
    }
    fn sync(&mut self) -> io::Result<()> {
        self.calls.push("sync");
        match self.sync_errors.pop_front().flatten() {
            Some(errno) => Err(io::Error::from_raw_os_error(errno)),
            None => Ok(()),
        }
    }
}
fn rows(bytes: &[u8]) -> Vec<Receipt> {
    bytes
        .split(|&b| b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}
fn complete_row() -> Receipt {
    let mut row = receipt(&configuration(), ReceiptState::Complete, Some(91));
    row.stop = Some(Ok(GroupStop::Signalled));
    row.settlement = Some(Ok(exited_group()));
    row.child_exit_raw = Some(0);
    row.stdout_eof = true;
    row.stderr_eof = true;
    assert!(row.terminal());
    row
}

#[test]
fn partial_record_error_resumes_same_bytes_before_next_record_and_fsyncs_each() {
    let mut sink = Sink::default();
    sink.writes
        .extend([WriteAction::Partial(7), WriteAction::Error(libc::EIO)]);
    let mut journal = Journal::new(sink);
    let started = receipt(&configuration(), ReceiptState::Started, Some(91));
    assert!(
        journal
            .publish(&started)
            .unwrap_err()
            .contains("receipt append")
    );
    assert_eq!(journal.sink.bytes.len(), 7);
    assert!(journal.durable.is_none());
    let mut pending = started.clone();
    pending.state = ReceiptState::Pending;
    pending.error = Some(stop_error().to_string());
    journal.publish(&pending).unwrap();
    let recorded = rows(&journal.sink.bytes);
    assert_eq!(recorded.len(), 2);
    assert!(same_record(&recorded[0], &started));
    assert!(same_record(&recorded[1], &pending));
    assert_eq!((recorded[0].sequence, recorded[1].sequence), (1, 2));
    assert_eq!(
        journal.sink.calls,
        ["append", "append", "append", "sync", "append", "sync"]
    );
}

#[test]
fn terminal_fsync_error_is_sticky_and_never_appends_after_terminal_or_reaps_again() {
    let mut journal = Journal::new(Sink::default());
    journal
        .publish(&receipt(&configuration(), ReceiptState::Started, Some(91)))
        .unwrap();
    journal.sink.sync_errors.push_back(Some(libc::EIO));
    let complete = complete_row();
    assert!(
        journal
            .publish(&complete)
            .unwrap_err()
            .contains("receipt fsync")
    );
    assert_eq!(
        journal.durable.as_ref().unwrap().state,
        ReceiptState::Started
    );
    let length = journal.sink.bytes.len();
    let candidate = journal
        .terminal_candidate()
        .expect("retain terminal candidate across fsync failure");
    let mut cleanup = Cleanup {
        exit: Some(0),
        ..Cleanup::default()
    };
    let mut no_ops = Ops::new();
    cleanup.retry();
    cleanup.step(&mut no_ops);
    assert!(
        no_ops.calls.is_empty(),
        "cached exit forbids recycled-PID operations"
    );
    journal.publish(&candidate).unwrap();
    assert_eq!(journal.sink.bytes.len(), length);
    assert!(journal.durable.as_ref().unwrap().terminal());
    let mut pending = complete.clone();
    pending.state = ReceiptState::Pending;
    pending.error = Some("late failure".into());
    assert!(journal.publish(&pending).is_err());
    journal.publish(&complete).unwrap();
    assert_eq!(rows(&journal.sink.bytes).len(), 2);
    assert_eq!(
        journal.sink.calls,
        ["append", "sync", "append", "sync", "sync"]
    );
}

#[test]
fn journal_cap_or_foreign_append_never_becomes_publication_success() {
    let mut sink = Sink::default();
    sink.bytes.resize(MAX_JOURNAL as usize - 1, b' ');
    let mut journal = Journal::new(sink);
    journal.length = MAX_JOURNAL - 1;
    let started = receipt(&configuration(), ReceiptState::Started, Some(91));
    assert!(journal.publish(&started).unwrap_err().contains("1MiB"));
    assert!(journal.publish(&complete_row()).is_err());
    assert!(journal.sink.calls.is_empty());
    let mut journal = Journal::new(Sink::default());
    journal.sink.bytes.push(b'X');
    assert!(
        journal
            .publish(&started)
            .unwrap_err()
            .contains("sole publisher")
    );
    assert!(journal.durable.is_none());
    assert!(journal.publish(&started).is_err());
}

#[test]
fn no_child_is_terminal_without_fabricated_node_evidence_and_pending_dedup_ignores_counts() {
    let no_child = receipt(&configuration(), ReceiptState::NoChild, None);
    assert!(no_child.terminal());
    assert!(
        no_child.stop.is_none()
            && no_child.settlement.is_none()
            && no_child.child_exit_raw.is_none()
    );
    let pending = receipt(&configuration(), ReceiptState::Pending, Some(91));
    let mut changed = pending.clone();
    changed.stdout_bytes = 12345;
    changed.stderr_bytes = 222;
    assert!(
        same_transition(&pending, &changed),
        "byte-only progress must not exhaust journal"
    );
    changed.stdout_eof = true;
    assert!(!same_transition(&pending, &changed));
}

#[test]
fn original_expiry_latches_delivery_stop_and_preserves_prior_failure() {
    let original = MonotonicDeadline::capture(Duration::from_millis(10)).unwrap();
    let mut failed = false;
    let mut reason = None;
    let mut failure = None;
    let mut discard = false;
    observe_deadline(
        &original,
        &mut failed,
        &mut reason,
        &mut failure,
        &mut discard,
    );
    assert!(!failed && !discard);
    assert_eq!(reason, None);
    assert_eq!(failure, None);
    while original.check().is_ok() {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        original.check(),
        Err(caws_native::monotonic_deadline::DeadlineError::Expired)
    );
    observe_deadline(
        &original,
        &mut failed,
        &mut reason,
        &mut failure,
        &mut discard,
    );
    assert!(failed && discard);
    assert_eq!(reason.as_deref(), Some("original_deadline_expired"));
    assert_eq!(
        failure.as_deref(),
        Some("Original monotonic deadline expired")
    );
    let retained = (reason.clone(), failure.clone());
    observe_deadline(
        &original,
        &mut failed,
        &mut reason,
        &mut failure,
        &mut discard,
    );
    assert_eq!((reason, failure), retained);

    let mut failed = false;
    let mut reason = Some("receipt_publication".to_owned());
    let mut failure = Some("retained publication failure".to_owned());
    let mut discard = false;
    observe_deadline(
        &original,
        &mut failed,
        &mut reason,
        &mut failure,
        &mut discard,
    );
    assert!(failed && discard);
    assert_eq!(reason.as_deref(), Some("receipt_publication"));
    assert_eq!(failure.as_deref(), Some("retained publication failure"));
}
