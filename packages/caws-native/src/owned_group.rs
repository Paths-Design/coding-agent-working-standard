//! Stop a private process group while its actual direct Child still pins identity.
//! No function here reaps. Callers retain Child/custody and retry any refusal.
//! The caller must have created this child's private group before exec and must
//! exclude concurrent wait/reap operations (including other SIGCHLD handlers).
use std::{fmt, io, process::Child};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GroupStop {
    Signalled,
    Absent,
    /// Darwin refused the signal, but a complete SDK snapshot proved that the
    /// retained leader and every returned member were zombies. No signal accepted.
    ExitedOnly {
        observation: GroupObservation,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum StopStage {
    InvalidPid,
    Ownership,
    Signal,
    ExitedGroup,
}

/// Primitive SDK bridge observation; no kinfo_proc layout crosses the FFI.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupObservation {
    /// 0 complete/all zombies; 1 invalid input; 2 allocation; 3 sysctl;
    /// 4 incomplete/full buffer; 5 empty; 6 membership; 7 credentials;
    /// 8 live member; 9 missing/duplicate/non-owned leader.
    pub reason: i32,
    pub query_errno: i32,
    pub bytes: u64,
    pub capacity: u64,
    pub members: u32,
    pub zombies: u32,
    pub leaders: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GroupSettlement {
    LeaderRunning,
    /// The SDK observed a live member before finishing validation of its fetched
    /// snapshot. This is positive live-member evidence, not a complete census
    /// and never permission to reap the identity anchor.
    GroupLive {
        observation: GroupObservation,
    },
    /// Fresh exited-child observations bracket a complete, validated snapshot
    /// containing only zombies. This does not assert pipe EOF or reap the child.
    Exited {
        observation: GroupObservation,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SettlementStage {
    InvalidPid,
    BeforeOwnership,
    UnsupportedPlatform,
    AfterOwnership,
    Snapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SettlementLeader {
    pub pid: i32,
    pub code: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SettlementError {
    pub stage: SettlementStage,
    pub raw_errno: Option<i32>,
    /// The failing observation boundary, when waitid returned a witness.
    pub observed_pid: Option<i32>,
    pub observed_code: Option<i32>,
    pub before: Option<SettlementLeader>,
    pub after: Option<SettlementLeader>,
    pub group: Option<GroupObservation>,
}
impl fmt::Display for SettlementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "owned group settlement: {self:?}")
    }
}
impl std::error::Error for SettlementError {}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StopError {
    pub stage: StopStage,
    /// The operation that failed (including the original kill EPERM).
    pub raw_errno: Option<i32>,
    /// Original kill errno, retained when a later ownership/query check refuses.
    pub signal_errno: Option<i32>,
    pub observed_pid: Option<i32>,
    pub observed_code: Option<i32>,
    pub group: Option<GroupObservation>,
}
impl fmt::Display for StopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "owned group stop: {self:?}")
    }
}
impl std::error::Error for StopError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OwnedObservation {
    pid: i32,
    code: i32,
}
impl OwnedObservation {
    fn exited(self, pid: i32) -> bool {
        self.pid == pid
            && matches!(
                self.code,
                libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED
            )
    }

    fn witness(self) -> SettlementLeader {
        SettlementLeader {
            pid: self.pid,
            code: self.code,
        }
    }
}

// Shared with the EPERM stop path: settlement must not weaken that profile.
fn complete_exited_snapshot(group: GroupObservation) -> bool {
    group.reason == 0
        && group.query_errno == 0
        && group.members > 0
        && group.members == group.zombies
        && group.leaders == 1
        && group.bytes > 0
        && group.bytes < group.capacity
}

fn observed_live_member(group: GroupObservation) -> bool {
    group.reason == 8
        && group.query_errno == 0
        && group.members > 0
        && group.zombies < group.members
        && group.leaders <= 1
        && group.bytes > 0
        && group.bytes < group.capacity
}

fn error(stage: StopStage, errno: Option<i32>) -> StopError {
    StopError {
        stage,
        raw_errno: errno,
        signal_errno: None,
        observed_pid: None,
        observed_code: None,
        group: None,
    }
}

trait Operations {
    fn observe(&mut self, pid: i32) -> Result<OwnedObservation, i32>;
    fn signal(&mut self, pid: i32) -> Result<(), i32>;
    fn group(&mut self, pid: i32) -> GroupObservation;
}

fn ownership(ops: &mut impl Operations, pid: i32) -> Result<OwnedObservation, StopError> {
    let observed = ops
        .observe(pid)
        .map_err(|e| error(StopStage::Ownership, Some(e)))?;
    if (observed.pid == 0 && observed.code == 0) || observed.exited(pid) {
        Ok(observed)
    } else {
        let mut e = error(StopStage::Ownership, None);
        e.observed_pid = Some(observed.pid);
        e.observed_code = Some(observed.code);
        Err(e)
    }
}

fn stop(
    ops: &mut impl Operations,
    pid: u32,
    own_pid: i32,
    own_group: i32,
    darwin: bool,
) -> Result<GroupStop, StopError> {
    if pid <= 1 || pid > i32::MAX as u32 || pid as i32 == own_pid || pid as i32 == own_group {
        return Err(error(StopStage::InvalidPid, None));
    }
    let pid = pid as i32;
    ownership(ops, pid)?;
    let signal_errno = match ops.signal(pid) {
        Ok(()) => return Ok(GroupStop::Signalled),
        Err(e) => e,
    };
    if signal_errno == libc::ESRCH {
        // Recheck retained identity even for absence; ECHILD never means absent.
        ownership(ops, pid).map_err(|mut e| {
            e.signal_errno = Some(signal_errno);
            e
        })?;
        return Ok(GroupStop::Absent);
    }
    if signal_errno != libc::EPERM || !darwin {
        let mut e = error(StopStage::Signal, Some(signal_errno));
        e.signal_errno = Some(signal_errno);
        return Err(e);
    }
    let before = ownership(ops, pid).map_err(|mut e| {
        e.signal_errno = Some(signal_errno);
        e
    })?;
    if !before.exited(pid) {
        let mut e = error(StopStage::ExitedGroup, Some(signal_errno));
        e.signal_errno = Some(signal_errno);
        e.observed_pid = Some(before.pid);
        e.observed_code = Some(before.code);
        return Err(e);
    }
    let group = ops.group(pid);
    // The complete independent query is bracketed by fresh WNOWAIT checks.
    // An ownership failure after the query must retain both query and kill errno.
    let after = ownership(ops, pid).map_err(|mut e| {
        e.group = Some(group);
        e.signal_errno = Some(signal_errno);
        e
    })?;
    if !after.exited(pid) || !complete_exited_snapshot(group) {
        let mut e = error(StopStage::ExitedGroup, Some(signal_errno));
        e.signal_errno = Some(signal_errno);
        e.observed_pid = Some(after.pid);
        e.observed_code = Some(after.code);
        e.group = Some(group);
        return Err(e);
    }
    Ok(GroupStop::ExitedOnly { observation: group })
}

fn settlement_error(
    stage: SettlementStage,
    before: Option<OwnedObservation>,
    group: Option<GroupObservation>,
) -> SettlementError {
    SettlementError {
        stage,
        raw_errno: None,
        observed_pid: None,
        observed_code: None,
        before: before.map(OwnedObservation::witness),
        after: None,
        group,
    }
}

fn settlement_observe(
    ops: &mut impl Operations,
    pid: i32,
    stage: SettlementStage,
    before: Option<OwnedObservation>,
    group: Option<GroupObservation>,
) -> Result<OwnedObservation, SettlementError> {
    let mut failure = settlement_error(stage, before, group);
    let observed = ops.observe(pid).map_err(|errno| {
        failure.raw_errno = Some(errno);
        failure.clone()
    })?;
    if (observed.pid == 0 && observed.code == 0) || observed.exited(pid) {
        return Ok(observed);
    }
    failure.observed_pid = Some(observed.pid);
    failure.observed_code = Some(observed.code);
    match stage {
        SettlementStage::BeforeOwnership => failure.before = Some(observed.witness()),
        SettlementStage::AfterOwnership => failure.after = Some(observed.witness()),
        _ => unreachable!("only ownership stages observe children"),
    }
    Err(failure)
}

fn settlement(
    ops: &mut impl Operations,
    pid: u32,
    own_pid: i32,
    own_group: i32,
    darwin: bool,
) -> Result<GroupSettlement, SettlementError> {
    if pid <= 1 || pid > i32::MAX as u32 || pid as i32 == own_pid || pid as i32 == own_group {
        return Err(settlement_error(SettlementStage::InvalidPid, None, None));
    }
    let pid = pid as i32;
    let before = settlement_observe(ops, pid, SettlementStage::BeforeOwnership, None, None)?;
    if !before.exited(pid) {
        return Ok(GroupSettlement::LeaderRunning);
    }
    if !darwin {
        return Err(settlement_error(
            SettlementStage::UnsupportedPlatform,
            Some(before),
            None,
        ));
    }
    let group = ops.group(pid);
    // Even a failed/partial query is followed by a fresh ownership observation;
    // retain its raw SDK result if ownership was lost at this boundary.
    let after = settlement_observe(
        ops,
        pid,
        SettlementStage::AfterOwnership,
        Some(before),
        Some(group),
    )?;
    if !after.exited(pid) {
        let mut failure =
            settlement_error(SettlementStage::AfterOwnership, Some(before), Some(group));
        failure.observed_pid = Some(after.pid);
        failure.observed_code = Some(after.code);
        failure.after = Some(after.witness());
        return Err(failure);
    }
    if complete_exited_snapshot(group) {
        return Ok(GroupSettlement::Exited { observation: group });
    }
    if observed_live_member(group) {
        return Ok(GroupSettlement::GroupLive { observation: group });
    }
    let mut failure = settlement_error(SettlementStage::Snapshot, Some(before), Some(group));
    failure.after = Some(after.witness());
    failure.raw_errno = (group.query_errno != 0).then_some(group.query_errno);
    Err(failure)
}

struct Native;
impl Operations for Native {
    fn observe(&mut self, pid: i32) -> Result<OwnedObservation, i32> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: exact libc output storage; WNOWAIT never releases identity.
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO));
        }
        let info = unsafe { info.assume_init() };
        Ok(OwnedObservation {
            pid: unsafe { info.si_pid() },
            code: info.si_code,
        })
    }
    fn signal(&mut self, pid: i32) -> Result<(), i32> {
        // SAFETY: validated positive owned PID; negative value selects its group.
        if unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO))
        }
    }
    fn group(&mut self, pid: i32) -> GroupObservation {
        #[cfg(target_os = "macos")]
        {
            unsafe extern "C" {
                fn caws_native_exited_group(pid: libc::pid_t, observation: *mut GroupObservation);
            }
            let mut observation = GroupObservation::default();
            // SAFETY: bridge writes only this repr(C) primitive observation.
            unsafe { caws_native_exited_group(pid, &mut observation) };
            observation
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = pid;
            GroupObservation {
                reason: 1,
                ..GroupObservation::default()
            }
        }
    }
}

/// Only an actual retained Child is accepted. The function never reaps it.
/// Memory/CPU work is bounded; kernel calls have no hard syscall deadline.
pub fn stop_before_reap(child: &Child) -> Result<GroupStop, StopError> {
    // SAFETY: process identity getters have no preconditions.
    stop(
        &mut Native,
        child.id(),
        unsafe { libc::getpid() },
        unsafe { libc::getpgrp() },
        cfg!(target_os = "macos"),
    )
}

/// Observe only the actual retained Child and its private group. Never signals
/// or reaps. Exited is independent of output EOF and preserves the leader anchor
/// for its caller's subsequent reap. Failed/unsupported observations are unknown,
/// never settlement. Callers must exclude concurrent reaping and retain custody.
/// Memory/CPU work is bounded; kernel calls have no hard syscall deadline.
pub fn settlement_before_reap(child: &Child) -> Result<GroupSettlement, SettlementError> {
    // SAFETY: process identity getters have no preconditions.
    settlement(
        &mut Native,
        child.id(),
        unsafe { libc::getpid() },
        unsafe { libc::getpgrp() },
        cfg!(target_os = "macos"),
    )
}

#[cfg(test)]
mod tests;
