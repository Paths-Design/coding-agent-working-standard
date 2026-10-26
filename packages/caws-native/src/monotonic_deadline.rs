//! Non-renewing deadlines for a live invocation crossing same-host IPC.
//!
//! CLOCK_MONOTONIC nanoseconds are the authoritative clock domain. The receiver
//! samples Instant before that clock to derive a conservative local I/O bound.
//! Check the retained deadline before effects and while servicing an operation;
//! an Instant bound alone does not replace the authoritative monotonic check.
//! This is cooperative same-host evidence, not sender/process attestation. The
//! enclosing native owner must bind and forward the exact envelope with its
//! original invocation receipt. Never restore it from TS-selected fields or
//! reuse it as a durable/reboot-portable capability.
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    time::{Duration, Instant},
};

/// Request-scoped effect check. Stage names identify logical boundaries for
/// diagnostics and tests; this callback grants no admission authority. Native
/// store callers close over the already retained MonotonicDeadline. Legacy
/// callers retain their existing Instant-only contract through checked wrappers.
pub(crate) type EffectCheck<'a> = dyn Fn(&'static str) -> Result<(), String> + 'a;

/// Existing native invocation maximum, not a new service-specific quota.
pub const MAX_TIMEOUT: Duration = Duration::from_millis(120_000);
const MAX_TIMEOUT_NS: u64 = 120_000 * 1_000_000;
const NS_PER_SECOND: u64 = 1_000_000_000;

/// Unvalidated transport data. Deserialization does not create a live deadline;
/// every receiver must call MonotonicDeadline::receive before using these fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeadlineEnvelope {
    pub started_ns: u64,
    pub expires_ns: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeadlineError {
    Clock(i32),
    InvalidClock,
    Overflow,
    InvalidTimeout,
    InvalidInterval,
    OutOfBounds,
    FutureStart,
    Expired,
}
impl fmt::Display for DeadlineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Clock(errno) => write!(f, "CLOCK_MONOTONIC unavailable: errno {errno}"),
            Self::InvalidClock => f.write_str("CLOCK_MONOTONIC returned invalid time"),
            Self::Overflow => f.write_str("Monotonic deadline arithmetic overflow"),
            Self::InvalidTimeout => {
                f.write_str("Invocation timeout must be positive and at most 120000ms")
            }
            Self::InvalidInterval => f.write_str("Monotonic deadline interval must be positive"),
            Self::OutOfBounds => f.write_str("Monotonic deadline exceeds 120000ms"),
            Self::FutureStart => f.write_str("Monotonic deadline starts after native now"),
            Self::Expired => f.write_str("Original monotonic deadline expired"),
        }
    }
}
impl std::error::Error for DeadlineError {}

trait Clock {
    fn instant(&mut self) -> Instant;
    fn monotonic_ns(&mut self) -> Result<u64, DeadlineError>;
}
struct HostClock;
impl Clock for HostClock {
    fn instant(&mut self) -> Instant {
        Instant::now()
    }
    fn monotonic_ns(&mut self) -> Result<u64, DeadlineError> {
        let mut raw = std::mem::MaybeUninit::<libc::timespec>::uninit();
        // SAFETY: raw is writable timespec storage. It is read only on success.
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, raw.as_mut_ptr()) } != 0 {
            return Err(DeadlineError::Clock(
                std::io::Error::last_os_error().raw_os_error().unwrap_or(0),
            ));
        }
        // SAFETY: successful clock_gettime initializes the complete timespec.
        let raw = unsafe { raw.assume_init() };
        timespec_ns(raw.tv_sec, raw.tv_nsec)
    }
}
fn timespec_ns(seconds: libc::time_t, nanos: libc::c_long) -> Result<u64, DeadlineError> {
    let seconds = u64::try_from(seconds).map_err(|_| DeadlineError::InvalidClock)?;
    let nanos = u64::try_from(nanos).map_err(|_| DeadlineError::InvalidClock)?;
    if nanos >= NS_PER_SECOND {
        return Err(DeadlineError::InvalidClock);
    }
    seconds
        .checked_mul(NS_PER_SECOND)
        .and_then(|whole| whole.checked_add(nanos))
        .ok_or(DeadlineError::Overflow)
}
fn validate_interval(envelope: DeadlineEnvelope) -> Result<(), DeadlineError> {
    let interval = envelope
        .expires_ns
        .checked_sub(envelope.started_ns)
        .filter(|duration| *duration > 0)
        .ok_or(DeadlineError::InvalidInterval)?;
    if interval > MAX_TIMEOUT_NS {
        return Err(DeadlineError::OutOfBounds);
    }
    Ok(())
}
fn check_native_now(envelope: DeadlineEnvelope, now: u64) -> Result<u64, DeadlineError> {
    if now < envelope.started_ns {
        return Err(DeadlineError::FutureStart);
    }
    let remaining = envelope
        .expires_ns
        .checked_sub(now)
        .filter(|duration| *duration > 0)
        .ok_or(DeadlineError::Expired)?;
    Ok(remaining)
}

/// Last cooperative check before exec, suitable for a Command pre_exec closure.
/// This uses the original envelope and CLOCK_MONOTONIC directly: no allocation,
/// locks, formatting, Instant conversion, capture, or grace interval. It cannot
/// make the clock sample and exec atomic; the caller places it last in pre_exec.
/// Expiry is ETIMEDOUT; malformed intervals/clocks fail closed as EINVAL.
pub fn check_before_exec(envelope: DeadlineEnvelope) -> Result<(), i32> {
    validate_interval(envelope).map_err(|_| libc::EINVAL)?;
    let mut raw = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: writable stack storage, read only after successful clock_gettime.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, raw.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::EIO));
    }
    // SAFETY: clock_gettime initialized the complete timespec.
    let raw = unsafe { raw.assume_init() };
    let now = timespec_ns(raw.tv_sec, raw.tv_nsec).map_err(|_| libc::EINVAL)?;
    check_native_now(envelope, now).map_err(|error| match error {
        DeadlineError::Expired => libc::ETIMEDOUT,
        _ => libc::EINVAL,
    })?;
    Ok(())
}

/// A validated original expiry and one captured local bound. No public Instant
/// constructor, deserializer, or refresh operation can reset its budget.
// Cloning retains both clock coordinates exactly; it never samples a clock or
// restores elapsed time. This lets a live transport retain its caller's bound.
#[derive(Clone, Debug)]
pub struct MonotonicDeadline {
    envelope: DeadlineEnvelope,
    local_expires: Instant,
}
impl MonotonicDeadline {
    /// Mint once at original native invocation start, before payload/engine work.
    pub fn capture(timeout: Duration) -> Result<Self, DeadlineError> {
        Self::capture_with(timeout, &mut HostClock)
    }
    fn capture_with(timeout: Duration, clock: &mut impl Clock) -> Result<Self, DeadlineError> {
        if timeout.is_zero() || timeout > MAX_TIMEOUT {
            return Err(DeadlineError::InvalidTimeout);
        }
        let duration_ns = u64::try_from(timeout.as_nanos()).map_err(|_| DeadlineError::Overflow)?;
        let started_ns = clock.monotonic_ns()?;
        let expires_ns = started_ns
            .checked_add(duration_ns)
            .ok_or(DeadlineError::Overflow)?;
        Self::receive_with(
            DeadlineEnvelope {
                started_ns,
                expires_ns,
            },
            clock,
        )
    }

    /// Validate same-host serialized input and consume transit time. Receiver
    /// policy may impose an additional earlier bound, never a later one.
    pub fn receive(envelope: DeadlineEnvelope) -> Result<Self, DeadlineError> {
        Self::receive_with(envelope, &mut HostClock)
    }
    fn receive_with(
        envelope: DeadlineEnvelope,
        clock: &mut impl Clock,
    ) -> Result<Self, DeadlineError> {
        validate_interval(envelope)?;
        // This ordering is deliberate: time spent reading CLOCK_MONOTONIC must
        // not be added back when its remaining interval is converted to Instant.
        let instant_before = clock.instant();
        let now_after = clock.monotonic_ns()?;
        let remaining = check_native_now(envelope, now_after)?;
        let local_expires = instant_before
            .checked_add(Duration::from_nanos(remaining))
            .ok_or(DeadlineError::Overflow)?;
        Ok(Self {
            envelope,
            local_expires,
        })
    }

    /// Forward this unchanged value; enclosing owner supplies invocation binding.
    pub fn envelope(&self) -> DeadlineEnvelope {
        self.envelope
    }

    /// Conservative I/O bound, captured once. Combine with any earlier owner
    /// limit and call check at effect boundaries; this accessor never refreshes.
    pub fn expires(&self) -> Instant {
        self.local_expires
    }

    pub fn check(&self) -> Result<(), DeadlineError> {
        self.check_with(&mut HostClock)
    }
    #[cfg(test)]
    pub(crate) fn check_observed_for_test(
        &self,
        native: Result<u64, DeadlineError>,
        local: Instant,
    ) -> Result<(), DeadlineError> {
        struct Observed {
            native: Result<u64, DeadlineError>,
            local: Instant,
        }
        impl Clock for Observed {
            fn instant(&mut self) -> Instant {
                self.local
            }
            fn monotonic_ns(&mut self) -> Result<u64, DeadlineError> {
                self.native
            }
        }
        self.check_with(&mut Observed { native, local })
    }
    fn check_with(&self, clock: &mut impl Clock) -> Result<(), DeadlineError> {
        let now_native = clock.monotonic_ns()?;
        check_native_now(self.envelope, now_native)?;
        // A slow native clock read cannot bypass the earlier local I/O bound.
        if clock.instant() >= self.local_expires {
            return Err(DeadlineError::Expired);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn clone_preserves_original_native_and_local_expiry() {
        let original = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        let retained = original.clone();
        assert_eq!(retained.envelope(), original.envelope());
        assert_eq!(retained.expires(), original.expires());
        assert_eq!(
            retained
                .check_observed_for_test(Ok(original.envelope().expires_ns), original.expires()),
            Err(DeadlineError::Expired)
        );
        assert_eq!(
            retained
                .check_observed_for_test(Ok(original.envelope().started_ns), original.expires()),
            Err(DeadlineError::Expired)
        );
    }

    #[test]
    fn exec_check_preserves_live_expired_and_invalid_semantics() {
        let original = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        assert_eq!(check_before_exec(original.envelope()), Ok(()));
        assert_eq!(
            check_before_exec(DeadlineEnvelope {
                started_ns: 1,
                expires_ns: 2
            }),
            Err(libc::ETIMEDOUT)
        );
        assert_eq!(
            check_before_exec(DeadlineEnvelope {
                started_ns: 2,
                expires_ns: 2
            }),
            Err(libc::EINVAL)
        );
        assert_eq!(
            check_before_exec(DeadlineEnvelope {
                started_ns: u64::MAX - 1,
                expires_ns: u64::MAX
            }),
            Err(libc::EINVAL)
        );
    }
    enum Sample {
        Instant(Instant),
        Native(Result<u64, DeadlineError>),
    }
    struct Script {
        samples: VecDeque<Sample>,
    }
    impl Script {
        fn new(samples: impl IntoIterator<Item = Sample>) -> Self {
            Self {
                samples: samples.into_iter().collect(),
            }
        }
        fn done(&self) {
            assert!(self.samples.is_empty(), "unused clock samples");
        }
    }
    impl Clock for Script {
        fn instant(&mut self) -> Instant {
            match self.samples.pop_front().expect("missing Instant sample") {
                Sample::Instant(now) => now,
                Sample::Native(_) => panic!("Instant must precede the corresponding native sample"),
            }
        }
        fn monotonic_ns(&mut self) -> Result<u64, DeadlineError> {
            match self.samples.pop_front().expect("missing native sample") {
                Sample::Native(now) => now,
                Sample::Instant(_) => panic!("unexpected native-before-Instant sample"),
            }
        }
    }
    fn at(base: Instant, nanos: u64) -> Instant {
        base + Duration::from_nanos(nanos)
    }
    fn receive(
        base: Instant,
        instant_ns: u64,
        native_ns: u64,
        envelope: DeadlineEnvelope,
    ) -> MonotonicDeadline {
        let mut clock = Script::new([
            Sample::Instant(at(base, instant_ns)),
            Sample::Native(Ok(native_ns)),
        ]);
        let value = MonotonicDeadline::receive_with(envelope, &mut clock).unwrap();
        clock.done();
        value
    }

    #[test]
    fn capture_consumes_its_own_clock_sampling_latency() {
        let base = Instant::now();
        let mut clock = Script::new([
            Sample::Native(Ok(100)),
            Sample::Instant(at(base, 120)),
            Sample::Native(Ok(150)),
        ]);
        let deadline =
            MonotonicDeadline::capture_with(Duration::from_nanos(1000), &mut clock).unwrap();
        assert_eq!(
            deadline.envelope(),
            DeadlineEnvelope {
                started_ns: 100,
                expires_ns: 1100
            }
        );
        assert_eq!(deadline.expires(), at(base, 1070));
        clock.done();
    }
    #[test]
    fn receiver_counts_transit_and_sampling_delay_instead_of_renewing_interval() {
        let base = Instant::now();
        let envelope = DeadlineEnvelope {
            started_ns: 100,
            expires_ns: 1100,
        };
        let deadline = receive(base, 600, 650, envelope);
        assert_eq!(deadline.envelope(), envelope);
        assert_eq!(deadline.expires(), at(base, 1050));
        // Renewing the original 1000ns on arrival would incorrectly yield1600ns.
        assert!(deadline.expires() < at(base, 1600));
    }
    #[test]
    fn forwarding_same_expiry_at_later_native_times_never_adds_transit_budget() {
        let base = Instant::now();
        let envelope = DeadlineEnvelope {
            started_ns: 100,
            expires_ns: 1100,
        };
        for arrival in [100, 600, 1099] {
            let restored = receive(base, arrival, arrival, envelope);
            assert_eq!(restored.envelope(), envelope);
            assert_eq!(restored.expires(), at(base, 1100));
        }
        for arrival in [1100, 1101, 2000] {
            let mut clock = Script::new([
                Sample::Instant(at(base, arrival)),
                Sample::Native(Ok(arrival)),
            ]);
            assert_eq!(
                MonotonicDeadline::receive_with(envelope, &mut clock).unwrap_err(),
                DeadlineError::Expired
            );
            clock.done();
        }
    }
    #[test]
    fn checks_do_not_refresh_local_bound_or_original_envelope() {
        let base = Instant::now();
        let envelope = DeadlineEnvelope {
            started_ns: 100,
            expires_ns: 1100,
        };
        let deadline = receive(base, 100, 100, envelope);
        for now in [101, 500, 1099] {
            let mut clock = Script::new([Sample::Native(Ok(now)), Sample::Instant(at(base, now))]);
            assert_eq!(deadline.check_with(&mut clock), Ok(()));
            assert_eq!(deadline.expires(), at(base, 1100));
            assert_eq!(deadline.envelope(), envelope);
            clock.done();
        }
        let mut clock = Script::new([Sample::Native(Ok(1100))]);
        assert_eq!(deadline.check_with(&mut clock), Err(DeadlineError::Expired));
        clock.done();
    }
    #[test]
    fn both_authoritative_and_conservative_local_expiry_are_enforced() {
        let base = Instant::now();
        let deadline = receive(
            base,
            100,
            150,
            DeadlineEnvelope {
                started_ns: 100,
                expires_ns: 1100,
            },
        );
        assert_eq!(deadline.expires(), at(base, 1050));
        let mut local_expired =
            Script::new([Sample::Native(Ok(1099)), Sample::Instant(at(base, 1050))]);
        assert_eq!(
            deadline.check_with(&mut local_expired),
            Err(DeadlineError::Expired)
        );
        local_expired.done();
        // A changed relation between native and local clocks cannot postpone M.
        let mut native_expired = Script::new([Sample::Native(Ok(1100))]);
        assert_eq!(
            deadline.check_with(&mut native_expired),
            Err(DeadlineError::Expired)
        );
        native_expired.done();
    }
    #[test]
    fn expired_during_capture_sampling_is_not_a_fresh_full_timeout() {
        let base = Instant::now();
        let mut clock = Script::new([
            Sample::Native(Ok(100)),
            Sample::Instant(base),
            Sample::Native(Ok(1100)),
        ]);
        assert_eq!(
            MonotonicDeadline::capture_with(Duration::from_nanos(1000), &mut clock).unwrap_err(),
            DeadlineError::Expired
        );
        clock.done();
    }
    #[test]
    fn clock_failure_is_preserved_at_capture_receive_and_check() {
        let base = Instant::now();
        let failure = DeadlineError::Clock(libc::EIO);
        let mut capture = Script::new([Sample::Native(Err(failure))]);
        assert_eq!(
            MonotonicDeadline::capture_with(Duration::from_secs(1), &mut capture).unwrap_err(),
            failure
        );
        capture.done();
        let envelope = DeadlineEnvelope {
            started_ns: 100,
            expires_ns: 1100,
        };
        let mut receiver = Script::new([Sample::Instant(base), Sample::Native(Err(failure))]);
        assert_eq!(
            MonotonicDeadline::receive_with(envelope, &mut receiver).unwrap_err(),
            failure
        );
        receiver.done();
        let deadline = receive(base, 100, 100, envelope);
        let mut checker = Script::new([Sample::Native(Err(failure))]);
        assert_eq!(deadline.check_with(&mut checker), Err(failure));
        checker.done();
    }
    #[test]
    fn invalid_or_over_cap_intervals_are_refused_before_reading_clocks() {
        for envelope in [
            DeadlineEnvelope {
                started_ns: 9,
                expires_ns: 9,
            },
            DeadlineEnvelope {
                started_ns: 9,
                expires_ns: 8,
            },
        ] {
            let mut clock = Script::new([]);
            assert_eq!(
                MonotonicDeadline::receive_with(envelope, &mut clock).unwrap_err(),
                DeadlineError::InvalidInterval
            );
            clock.done();
        }
        let mut clock = Script::new([]);
        assert_eq!(
            MonotonicDeadline::receive_with(
                DeadlineEnvelope {
                    started_ns: 9,
                    expires_ns: 9 + MAX_TIMEOUT_NS + 1
                },
                &mut clock
            )
            .unwrap_err(),
            DeadlineError::OutOfBounds
        );
        clock.done();
        for duration in [Duration::ZERO, MAX_TIMEOUT + Duration::from_nanos(1)] {
            let mut clock = Script::new([]);
            assert_eq!(
                MonotonicDeadline::capture_with(duration, &mut clock).unwrap_err(),
                DeadlineError::InvalidTimeout
            );
            clock.done();
        }
    }
    #[test]
    fn exact_120000ms_cap_and_small_positive_budget_are_admissible() {
        let base = Instant::now();
        for timeout in [MAX_TIMEOUT, Duration::from_nanos(1)] {
            let mut clock = Script::new([
                Sample::Native(Ok(10)),
                Sample::Instant(base),
                Sample::Native(Ok(10)),
            ]);
            let deadline = MonotonicDeadline::capture_with(timeout, &mut clock).unwrap();
            assert_eq!(
                deadline.envelope().expires_ns - deadline.envelope().started_ns,
                timeout.as_nanos() as u64
            );
            assert_eq!(deadline.expires(), base + timeout);
            clock.done();
        }
    }
    #[test]
    fn future_start_including_check_before_original_start_is_refused() {
        let base = Instant::now();
        let envelope = DeadlineEnvelope {
            started_ns: 100,
            expires_ns: 1100,
        };
        let mut receiver = Script::new([Sample::Instant(base), Sample::Native(Ok(99))]);
        assert_eq!(
            MonotonicDeadline::receive_with(envelope, &mut receiver).unwrap_err(),
            DeadlineError::FutureStart
        );
        receiver.done();
        let deadline = receive(base, 100, 100, envelope);
        let mut checker = Script::new([Sample::Native(Ok(99))]);
        assert_eq!(
            deadline.check_with(&mut checker),
            Err(DeadlineError::FutureStart)
        );
        checker.done();
    }
    #[test]
    fn clock_and_deadline_arithmetic_never_wrap_or_saturate() {
        assert_eq!(timespec_ns(1, 999_999_999), Ok(1_999_999_999));
        assert_eq!(
            timespec_ns(1, 1_000_000_000),
            Err(DeadlineError::InvalidClock)
        );
        assert_eq!(timespec_ns(-1, 0), Err(DeadlineError::InvalidClock));
        assert_eq!(timespec_ns(1, -1), Err(DeadlineError::InvalidClock));
        assert_eq!(
            timespec_ns(libc::time_t::MAX, 0),
            Err(DeadlineError::Overflow)
        );
        let mut clock = Script::new([Sample::Native(Ok(u64::MAX - 5))]);
        assert_eq!(
            MonotonicDeadline::capture_with(Duration::from_nanos(6), &mut clock).unwrap_err(),
            DeadlineError::Overflow
        );
        clock.done();
    }
    #[test]
    fn serialized_input_requires_fields_types_and_validation() {
        let envelope = DeadlineEnvelope {
            started_ns: 100,
            expires_ns: 1100,
        };
        assert_eq!(
            serde_json::to_string(&envelope).unwrap(),
            r#"{"startedNs":100,"expiresNs":1100}"#
        );
        for text in [
            r#"{}"#,
            r#"{"startedNs":100}"#,
            r#"{"startedNs":-1,"expiresNs":2}"#,
            r#"{"startedNs":"1","expiresNs":2}"#,
            r#"{"startedNs":1,"expiresNs":2,"budgetMs":1000}"#,
        ] {
            assert!(
                serde_json::from_str::<DeadlineEnvelope>(text).is_err(),
                "{text}"
            );
        }
        let raw: DeadlineEnvelope =
            serde_json::from_str(r#"{"startedNs":1100,"expiresNs":100}"#).unwrap();
        let mut clock = Script::new([]);
        assert_eq!(
            MonotonicDeadline::receive_with(raw, &mut clock).unwrap_err(),
            DeadlineError::InvalidInterval
        );
        clock.done();
    }
}

#[cfg(test)]
pub(crate) mod effect_test_support {
    use super::*;
    use std::cell::{Cell, RefCell};
    pub(crate) struct NativeClock {
        deadline: MonotonicDeadline,
        trigger: &'static str,
        failure: DeadlineError,
        failed: Cell<bool>,
        pub(crate) stages: RefCell<Vec<&'static str>>,
    }
    impl NativeClock {
        pub(crate) fn new(trigger: &'static str, failure: DeadlineError) -> Self {
            Self {
                deadline: MonotonicDeadline::capture(Duration::from_secs(30)).unwrap(),
                trigger,
                failure,
                failed: Cell::new(false),
                stages: RefCell::new(vec![]),
            }
        }
        pub(crate) fn expires(&self) -> Instant {
            self.deadline.expires()
        }
        pub(crate) fn check(&self, stage: &'static str) -> Result<(), String> {
            self.stages.borrow_mut().push(stage);
            if stage == self.trigger {
                self.failed.set(true);
            }
            if !self.failed.get() {
                return self.deadline.check().map_err(|e| e.to_string());
            }
            let native = if self.failure == DeadlineError::Expired {
                Ok(self.deadline.envelope().expires_ns)
            } else {
                Err(self.failure)
            };
            // The adversarial native observation changes while the same local
            // Instant is demonstrably live; no host clock or global switch moves.
            assert!(Instant::now() < self.deadline.expires());
            self.deadline
                .check_observed_for_test(native, Instant::now())
                .map_err(|e| e.to_string())
        }
    }
}
