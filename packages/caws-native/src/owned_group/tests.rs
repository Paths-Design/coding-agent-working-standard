use super::*;
use std::collections::VecDeque;

const PID: u32 = 12345;
fn exited() -> Result<OwnedObservation, i32> {
    Ok(OwnedObservation {
        pid: PID as i32,
        code: libc::CLD_EXITED,
    })
}
fn live() -> Result<OwnedObservation, i32> {
    Ok(OwnedObservation { pid: 0, code: 0 })
}
fn all_zombies() -> GroupObservation {
    GroupObservation {
        bytes: 600,
        capacity: 4096,
        members: 1,
        zombies: 1,
        leaders: 1,
        ..GroupObservation::default()
    }
}
struct Fake {
    observations: VecDeque<Result<OwnedObservation, i32>>,
    signal_result: Result<(), i32>,
    snapshot: GroupObservation,
    calls: Vec<&'static str>,
    signal_forbidden: bool,
}
impl Fake {
    fn new(signal_result: Result<(), i32>) -> Self {
        Self {
            observations: [exited(), exited(), exited()].into(),
            signal_result,
            snapshot: all_zombies(),
            calls: Vec::new(),
            signal_forbidden: false,
        }
    }
    fn stop(&mut self, darwin: bool) -> Result<GroupStop, StopError> {
        stop(self, PID, 300, 300, darwin)
    }
    fn settlement(&mut self, darwin: bool) -> Result<GroupSettlement, SettlementError> {
        self.signal_forbidden = true;
        settlement(self, PID, 300, 300, darwin)
    }
}
impl Operations for Fake {
    fn observe(&mut self, pid: i32) -> Result<OwnedObservation, i32> {
        assert_eq!(pid, PID as i32);
        self.calls.push("observe");
        self.observations
            .pop_front()
            .expect("unexpected ownership operation")
    }
    fn signal(&mut self, pid: i32) -> Result<(), i32> {
        assert!(!self.signal_forbidden, "settlement must never signal");
        assert_eq!(pid, PID as i32);
        self.calls.push("signal");
        self.signal_result
    }
    fn group(&mut self, pid: i32) -> GroupObservation {
        assert_eq!(pid, PID as i32);
        self.calls.push("group");
        self.snapshot
    }
}

#[test]
fn exited_only_requires_signal_refusal_fresh_owned_exit_and_complete_snapshot() {
    let mut ops = Fake::new(Err(libc::EPERM));
    assert_eq!(
        ops.stop(true),
        Ok(GroupStop::ExitedOnly {
            observation: all_zombies()
        })
    );
    assert_eq!(
        ops.calls,
        ["observe", "signal", "observe", "group", "observe"]
    );
    // ExitedOnly is distinct from accepted signaling in every caller receipt.
    assert_ne!(
        GroupStop::ExitedOnly {
            observation: all_zombies()
        },
        GroupStop::Signalled
    );
}

#[test]
fn exited_leader_with_live_holder_never_permits_reap() {
    let mut ops = Fake::new(Err(libc::EPERM));
    ops.snapshot = GroupObservation {
        reason: 8,
        members: 2,
        ..all_zombies()
    };
    let failure = ops.stop(true).unwrap_err();
    assert_eq!(failure.stage, StopStage::ExitedGroup);
    assert_eq!(failure.signal_errno, Some(libc::EPERM));
    assert_eq!(failure.group.unwrap().members, 2);
}

#[test]
fn every_sdk_uncertainty_retains_original_signal_errno_and_observation() {
    for reason in 1..=9 {
        let mut ops = Fake::new(Err(libc::EPERM));
        ops.snapshot.reason = reason;
        if reason == 3 {
            ops.snapshot.query_errno = libc::EACCES;
        }
        let failure = ops.stop(true).unwrap_err();
        assert_eq!(failure.raw_errno, Some(libc::EPERM));
        assert_eq!(failure.signal_errno, Some(libc::EPERM));
        assert_eq!(failure.group, Some(ops.snapshot));
    }
}

#[test]
fn malformed_snapshot_cannot_be_accepted_even_with_success_reason() {
    for snapshot in [
        GroupObservation {
            members: 0,
            ..all_zombies()
        },
        GroupObservation {
            zombies: 0,
            ..all_zombies()
        },
        GroupObservation {
            leaders: 0,
            ..all_zombies()
        },
        GroupObservation {
            leaders: 2,
            ..all_zombies()
        },
        GroupObservation {
            bytes: 0,
            ..all_zombies()
        },
        GroupObservation {
            bytes: 4096,
            ..all_zombies()
        },
        GroupObservation {
            bytes: 5000,
            ..all_zombies()
        },
        GroupObservation {
            query_errno: libc::ENOMEM,
            ..all_zombies()
        },
    ] {
        let mut ops = Fake::new(Err(libc::EPERM));
        ops.snapshot = snapshot;
        assert!(
            ops.stop(true).is_err(),
            "accepted malformed snapshot: {snapshot:?}"
        );
    }
}

#[test]
fn initial_ownership_error_or_mismatched_identity_never_signals() {
    for observed in [
        Err(libc::ECHILD),
        Err(libc::EINTR),
        Ok(OwnedObservation {
            pid: PID as i32 + 1,
            code: libc::CLD_EXITED,
        }),
        Ok(OwnedObservation {
            pid: PID as i32,
            code: libc::CLD_STOPPED,
        }),
        Ok(OwnedObservation {
            pid: 0,
            code: libc::CLD_EXITED,
        }),
    ] {
        let mut ops = Fake::new(Ok(()));
        ops.observations = [observed].into();
        assert_eq!(ops.stop(true).unwrap_err().stage, StopStage::Ownership);
        assert_eq!(ops.calls, ["observe"]);
    }
}

#[test]
fn eperm_for_live_leader_or_non_darwin_never_uses_snapshot() {
    let mut ops = Fake::new(Err(libc::EPERM));
    ops.observations = [live(), live()].into();
    assert!(ops.stop(true).is_err());
    assert_eq!(ops.calls, ["observe", "signal", "observe"]);
    let mut ops = Fake::new(Err(libc::EPERM));
    assert!(ops.stop(false).is_err());
    assert_eq!(ops.calls, ["observe", "signal"]);
}

#[test]
fn lost_ownership_after_snapshot_refuses_and_keeps_both_errnos() {
    let mut ops = Fake::new(Err(libc::EPERM));
    ops.observations = [exited(), exited(), Err(libc::ECHILD)].into();
    let failure = ops.stop(true).unwrap_err();
    assert_eq!(failure.raw_errno, Some(libc::ECHILD));
    assert_eq!(failure.signal_errno, Some(libc::EPERM));
    assert_eq!(failure.group, Some(all_zombies()));
}

#[test]
fn esrch_requires_post_signal_retained_identity_and_other_errors_refuse() {
    let mut ops = Fake::new(Err(libc::ESRCH));
    assert_eq!(ops.stop(true), Ok(GroupStop::Absent));
    assert_eq!(ops.calls, ["observe", "signal", "observe"]);
    let mut ops = Fake::new(Err(libc::ESRCH));
    ops.observations = [exited(), Err(libc::ECHILD)].into();
    assert_eq!(ops.stop(true).unwrap_err().signal_errno, Some(libc::ESRCH));
    let mut ops = Fake::new(Err(libc::EACCES));
    assert_eq!(ops.stop(true).unwrap_err().raw_errno, Some(libc::EACCES));
    assert_eq!(ops.calls, ["observe", "signal"]);
}

#[test]
fn unsafe_pids_fail_before_any_operation_and_signal_success_needs_no_scan() {
    for pid in [0, 1, 300, i32::MAX as u32 + 1, u32::MAX] {
        let mut ops = Fake::new(Ok(()));
        assert_eq!(
            stop(&mut ops, pid, 300, 400, true).unwrap_err().stage,
            StopStage::InvalidPid
        );
        assert!(ops.calls.is_empty());
    }
    let mut ops = Fake::new(Ok(()));
    assert_eq!(
        stop(&mut ops, 400, 300, 400, true).unwrap_err().stage,
        StopStage::InvalidPid
    );
    assert!(ops.calls.is_empty());
    let mut ops = Fake::new(Ok(()));
    assert_eq!(ops.stop(true), Ok(GroupStop::Signalled));
    assert_eq!(ops.calls, ["observe", "signal"]);
}

#[test]
fn settlement_running_leader_never_queries_or_signals_on_any_platform() {
    for darwin in [true, false] {
        let mut ops = Fake::new(Ok(()));
        ops.observations = [live()].into();
        assert_eq!(ops.settlement(darwin), Ok(GroupSettlement::LeaderRunning));
        assert_eq!(ops.calls, ["observe"]);
    }
}

#[test]
fn settlement_complete_group_requires_two_fresh_exited_observations() {
    for code in [libc::CLD_EXITED, libc::CLD_KILLED, libc::CLD_DUMPED] {
        let mut ops = Fake::new(Ok(()));
        let observed = Ok(OwnedObservation {
            pid: PID as i32,
            code,
        });
        ops.observations = [observed, observed].into();
        ops.snapshot.members = 3;
        ops.snapshot.zombies = 3;
        let expected = ops.snapshot;
        assert_eq!(
            ops.settlement(true),
            Ok(GroupSettlement::Exited {
                observation: expected
            })
        );
        assert_eq!(ops.calls, ["observe", "group", "observe"]);
        assert!(ops.observations.is_empty());
    }
}

#[test]
fn settlement_live_member_is_positive_incomplete_evidence_never_exited() {
    for leaders in [0, 1] {
        let mut ops = Fake::new(Ok(()));
        ops.snapshot = GroupObservation {
            reason: 8,
            members: 3,
            zombies: 1,
            leaders,
            ..all_zombies()
        };
        let expected = ops.snapshot;
        // Even hypothetical stdout/stderr EOF is irrelevant: this API accepts
        // no EOF input capable of turning an observed live member into Exited.
        assert_eq!(
            ops.settlement(true),
            Ok(GroupSettlement::GroupLive {
                observation: expected
            })
        );
        assert_eq!(ops.calls, ["observe", "group", "observe"]);
    }
}

#[test]
fn settlement_unknown_sdk_results_keep_full_snapshot_and_witnesses() {
    for reason in [1, 2, 3, 4, 5, 6, 7, 9, 255] {
        let mut ops = Fake::new(Ok(()));
        ops.snapshot.reason = reason;
        if reason == 3 {
            ops.snapshot.query_errno = libc::EACCES;
        }
        let expected = ops.snapshot;
        let error = ops.settlement(true).unwrap_err();
        assert_eq!(error.stage, SettlementStage::Snapshot);
        assert_eq!(
            error.raw_errno,
            (expected.query_errno != 0).then_some(expected.query_errno)
        );
        assert_eq!(error.group, Some(expected));
        assert_eq!(error.before, Some(exited().unwrap().witness()));
        assert_eq!(error.after, Some(exited().unwrap().witness()));
        assert_eq!(ops.calls, ["observe", "group", "observe"]);
        assert_eq!(
            error.to_string(),
            format!("owned group settlement: {error:?}")
        );
    }
}

#[test]
fn settlement_malformed_complete_or_live_snapshots_are_unknown() {
    for malformed in [
        GroupObservation {
            members: 0,
            ..all_zombies()
        },
        GroupObservation {
            zombies: 0,
            ..all_zombies()
        },
        GroupObservation {
            zombies: 2,
            ..all_zombies()
        },
        GroupObservation {
            leaders: 0,
            ..all_zombies()
        },
        GroupObservation {
            leaders: 2,
            ..all_zombies()
        },
        GroupObservation {
            bytes: 0,
            ..all_zombies()
        },
        GroupObservation {
            bytes: 4096,
            ..all_zombies()
        },
        GroupObservation {
            bytes: 5000,
            ..all_zombies()
        },
        GroupObservation {
            capacity: 0,
            ..all_zombies()
        },
        GroupObservation {
            query_errno: libc::ENOMEM,
            ..all_zombies()
        },
        GroupObservation {
            reason: 8,
            ..all_zombies()
        },
        GroupObservation {
            reason: 8,
            members: 0,
            ..all_zombies()
        },
        GroupObservation {
            reason: 8,
            members: 2,
            leaders: 2,
            ..all_zombies()
        },
        GroupObservation {
            reason: 8,
            members: 2,
            bytes: 4096,
            ..all_zombies()
        },
        GroupObservation {
            reason: 8,
            members: 2,
            query_errno: libc::EACCES,
            ..all_zombies()
        },
    ] {
        let mut ops = Fake::new(Ok(()));
        ops.snapshot = malformed;
        let error = ops.settlement(true).unwrap_err();
        assert_eq!(
            error.stage,
            SettlementStage::Snapshot,
            "snapshot {malformed:?}"
        );
        assert_eq!(error.group, Some(malformed));
        assert_eq!(ops.calls, ["observe", "group", "observe"]);
    }
}

#[test]
fn settlement_before_ownership_failures_never_query_and_retain_raw_truth() {
    for observed in [
        Err(libc::ECHILD),
        Err(libc::EINTR),
        Ok(OwnedObservation {
            pid: PID as i32 + 1,
            code: libc::CLD_EXITED,
        }),
        Ok(OwnedObservation {
            pid: PID as i32,
            code: libc::CLD_STOPPED,
        }),
        Ok(OwnedObservation {
            pid: 0,
            code: libc::CLD_EXITED,
        }),
    ] {
        let mut ops = Fake::new(Ok(()));
        ops.observations = [observed].into();
        let error = ops.settlement(true).unwrap_err();
        assert_eq!(error.stage, SettlementStage::BeforeOwnership);
        match observed {
            Err(errno) => {
                assert_eq!(error.raw_errno, Some(errno));
                assert_eq!(error.before, None);
                assert_eq!(error.observed_pid, None);
                assert_eq!(error.observed_code, None);
            }
            Ok(witness) => {
                assert_eq!(error.raw_errno, None);
                assert_eq!(error.before, Some(witness.witness()));
                assert_eq!(error.observed_pid, Some(witness.pid));
                assert_eq!(error.observed_code, Some(witness.code));
            }
        }
        assert_eq!(error.after, None);
        assert_eq!(error.group, None);
        assert_eq!(ops.calls, ["observe"]);
    }
}

#[test]
fn settlement_after_ownership_failure_retains_before_and_sdk_query_error() {
    for observed in [
        Err(libc::ECHILD),
        Err(libc::EINTR),
        live(),
        Ok(OwnedObservation {
            pid: PID as i32 + 1,
            code: libc::CLD_EXITED,
        }),
        Ok(OwnedObservation {
            pid: PID as i32,
            code: libc::CLD_STOPPED,
        }),
    ] {
        let mut ops = Fake::new(Ok(()));
        ops.observations = [exited(), observed].into();
        ops.snapshot.reason = 3;
        ops.snapshot.query_errno = libc::EACCES;
        let expected = ops.snapshot;
        let error = ops.settlement(true).unwrap_err();
        assert_eq!(error.stage, SettlementStage::AfterOwnership);
        assert_eq!(error.before, Some(exited().unwrap().witness()));
        assert_eq!(error.group, Some(expected));
        match observed {
            Err(errno) => {
                assert_eq!(error.raw_errno, Some(errno));
                assert_eq!(error.after, None);
                assert_eq!(error.observed_pid, None);
                assert_eq!(error.observed_code, None);
            }
            Ok(witness) => {
                assert_eq!(error.raw_errno, None);
                assert_eq!(error.after, Some(witness.witness()));
                assert_eq!(error.observed_pid, Some(witness.pid));
                assert_eq!(error.observed_code, Some(witness.code));
            }
        }
        assert_eq!(ops.calls, ["observe", "group", "observe"]);
    }
}

#[test]
fn settlement_non_darwin_exited_leader_is_explicitly_unsupported() {
    let mut ops = Fake::new(Ok(()));
    let error = ops.settlement(false).unwrap_err();
    assert_eq!(error.stage, SettlementStage::UnsupportedPlatform);
    assert_eq!(error.before, Some(exited().unwrap().witness()));
    assert_eq!(error.after, None);
    assert_eq!(error.group, None);
    assert_eq!(error.raw_errno, None);
    assert_eq!(ops.calls, ["observe"]);
}

#[test]
fn settlement_invalid_pids_fail_before_any_kernel_operation() {
    for pid in [0, 1, 300, 400, i32::MAX as u32 + 1, u32::MAX] {
        let mut ops = Fake::new(Ok(()));
        let error = settlement(&mut ops, pid, 300, 400, true).unwrap_err();
        assert_eq!(error.stage, SettlementStage::InvalidPid);
        assert_eq!(error.before, None);
        assert_eq!(error.after, None);
        assert_eq!(error.group, None);
        assert!(ops.calls.is_empty());
    }
}
