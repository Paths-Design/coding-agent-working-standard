//! Native generation/original binding for maintained Git. Only the parent Stop
//! owner can join this receipt to selection, prefix, publication and a consumer.
use crate::{
    native_generation::GenerationReceipt, selection_observation::GenerationValidationScope,
};
use caws_native::monotonic_deadline::MonotonicDeadline;
use caws_native::{context_git::stop as git, session_cache_wire::OriginalStopCapture};
use std::{cell::RefCell, time::Instant};
#[must_use = "retained Stop Git custody must reach the root cleanup owner"]
#[derive(Debug)]
pub(crate) enum Failure {
    Invalidated(String),
    Retained(git::Failure),
}
impl From<String> for Failure {
    fn from(value: String) -> Self {
        Self::Invalidated(value)
    }
}
fn interrupted_failure(mut failure: git::Failure, reason: &RefCell<Option<String>>) -> Failure {
    if matches!(
        failure.diagnostic.as_str(),
        "original Stop Git cancelled" | "original Stop Git deadline"
    ) {
        if let Some(original) = reason.borrow_mut().take() {
            failure.diagnostic = original;
        }
    }
    Failure::Retained(failure)
}
impl Failure {
    pub(crate) fn diagnostic(&self) -> &str {
        match self {
            Self::Invalidated(e) => e,
            Self::Retained(e) => &e.diagnostic,
        }
    }
    pub(crate) fn cleanup_settled(&self) -> bool {
        match self {
            Self::Invalidated(_) => true,
            Self::Retained(e) => e.cleanup_settled(),
        }
    }
    pub(crate) fn custodian_retained(&self) -> bool {
        match self {
            Self::Invalidated(_) => false,
            Self::Retained(e) => e.custodian_retained(),
        }
    }
    pub(crate) fn retry_cleanup_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        match self {
            Self::Invalidated(_) => Ok(()),
            Self::Retained(failure) => failure.retry_cleanup_until(original, until),
        }
    }
    #[cfg(test)]
    pub(crate) fn retry_cleanup(&mut self) -> Result<(), String> {
        match self {
            Self::Invalidated(_) => Ok(()),
            Self::Retained(e) => e.retry_cleanup(),
        }
    }
}
// The parent creates this slot outside every generation/readset bracket and
// transports it into terminal failure. A closing String error may replace a
// callback result, so the actual Failure must move here before conversion.
// Generic storage supplies a cleanup test seam, never a receipt or permission.
pub(crate) trait CustodiedFailure {
    fn diagnostic(&self) -> &str;
    fn custodian_retained(&self) -> bool;
    fn cleanup_settled(&self) -> bool;
    #[cfg(test)]
    fn retry_cleanup(&mut self) -> Result<(), String>;
}
/// The callback root can wait only on owners with an explicit bounded implementation.
pub(crate) trait BoundedCustodiedFailure: CustodiedFailure {
    fn retry_cleanup_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String>;
}
impl CustodiedFailure for Failure {
    fn diagnostic(&self) -> &str {
        Failure::diagnostic(self)
    }
    fn custodian_retained(&self) -> bool {
        Failure::custodian_retained(self)
    }
    fn cleanup_settled(&self) -> bool {
        Failure::cleanup_settled(self)
    }
    #[cfg(test)]
    fn retry_cleanup(&mut self) -> Result<(), String> {
        Failure::retry_cleanup(self)
    }
}
impl BoundedCustodiedFailure for Failure {
    fn retry_cleanup_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Result<(), String> {
        Failure::retry_cleanup_until(self, original, until)
    }
}
pub(crate) struct RetainedFailures<F: CustodiedFailure> {
    failures: Vec<F>,
    diagnostics: Vec<String>,
}
impl<F: CustodiedFailure> Default for RetainedFailures<F> {
    fn default() -> Self {
        Self {
            failures: Vec::new(),
            diagnostics: Vec::new(),
        }
    }
}
pub(crate) type FailureCustody = RetainedFailures<Failure>;
impl<F: CustodiedFailure> RetainedFailures<F> {
    fn diagnostic(&self) -> Option<String> {
        (!self.diagnostics.is_empty())
            .then(|| self.diagnostics.join("; subsequent validation failure: "))
    }
    fn remember(&mut self, mut message: String) {
        // Strip a propagated aggregate before adding new closing/cleanup
        // detail; recursive String callbacks cannot duplicate the first error.
        if let Some(current) = self.diagnostic() {
            if message == current {
                return;
            }
            if let Some(suffix) = message.strip_prefix(&format!("{current}; ")) {
                message = suffix.to_owned();
            }
        }
        if !self.diagnostics.contains(&message) {
            self.diagnostics.push(message);
        }
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        match self.diagnostic() {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }
    pub(crate) fn retain<T>(&mut self, result: Result<T, F>) -> Result<T, String> {
        let result = match result {
            Ok(value) => Ok(value),
            Err(failure) => {
                let message = failure.diagnostic().to_owned();
                self.failures.push(failure); // custody precedes String conversion
                Err(message)
            }
        };
        self.preserve(result)
    }
    pub(crate) fn preserve<T>(&mut self, result: Result<T, String>) -> Result<T, String> {
        match result {
            Err(message) => {
                self.remember(message);
                Err(self.diagnostic().expect("recorded failure"))
            }
            Ok(value) => self.check().map(|()| value),
        }
    }
    #[cfg(test)]
    pub(crate) fn settle_cleanup(&mut self) -> Option<String> {
        let mut unproven = Vec::new();
        for failure in &mut self.failures {
            // Only actual retained custody permits another cleanup attempt.
            // This never renews operation/authentication/query time.
            while failure.custodian_retained() {
                let _ = failure.retry_cleanup();
                if failure.custodian_retained() {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
            if !failure.cleanup_settled() {
                unproven.push(failure.diagnostic().to_owned());
            }
        }
        (!unproven.is_empty()).then(|| {
            format!(
                "Stop Git terminal cleanup remains unproven: {}; no observation or operation retry",
                unproven.join("; ")
            )
        })
    }
}

impl<F: BoundedCustodiedFailure> RetainedFailures<F> {
    pub(crate) fn settle_cleanup_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Option<String> {
        let until = until.min(original.expires());
        let mut unproven = Vec::new();
        for failure in &mut self.failures {
            // One best-effort owned cancellation is permitted even after
            // expiry; the bounded implementation must not wait in that case.
            if failure.custodian_retained() {
                let _ = failure.retry_cleanup_until(original, until);
            }
            while failure.custodian_retained() && original.check().is_ok() && Instant::now() < until
            {
                let remaining = until.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                if original.check().is_err() {
                    break;
                }
                std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
                if original.check().is_err() || Instant::now() >= until {
                    break;
                }
                let _ = failure.retry_cleanup_until(original, until);
            }
            if !failure.cleanup_settled() {
                unproven.push(failure.diagnostic().to_owned());
            }
        }
        (!unproven.is_empty()).then(|| {
            format!(
                "Stop Git terminal cleanup remains unproven: {}; no observation or operation retry",
                unproven.join("; ")
            )
        })
    }
}

pub(crate) struct StopGitAdmissionReceipt<'owners, 'native> {
    generation: &'owners GenerationReceipt,
    original: &'owners OriginalStopCapture<'native>,
    distribution: git::DistributionReceipt<'owners, 'native>,
}
impl<'owners, 'native: 'owners> StopGitAdmissionReceipt<'owners, 'native> {
    pub(crate) fn capture_in_scope(
        scope: &GenerationValidationScope<'_, 'native>,
        generation: &'owners GenerationReceipt,
        original: &'owners OriginalStopCapture<'native>,
        expected: &git::Observation,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Option<Self>, Failure> {
        scope.check_binding(generation, original.deadline(), &mut cancel)?;
        if generation.digest() != original.runtime_digest() {
            return Err(Failure::Invalidated(
                "Stop Git generation differs from original".into(),
            ));
        }
        let executor =
            generation.selected_native_executor(original.deadline().expires(), &mut cancel)?;
        let interruption = RefCell::new(None);
        let result = {
            let callback = RefCell::new(&mut cancel);
            git::DistributionReceipt::admit(original, &executor, expected, &|| match callback
                .borrow_mut()(
            )
            .and_then(|()| original.deadline().check().map_err(|e| e.to_string()))
            {
                Ok(()) => false,
                Err(e) => {
                    interruption.borrow_mut().get_or_insert(e);
                    true
                }
            })
        };
        let distribution = match result {
            Ok(r) => r,
            Err(git::AdmissionFailure::Unsupported(_reason)) => {
                scope.check_binding(generation, original.deadline(), &mut cancel)?;
                return Ok(None);
            }
            Err(git::AdmissionFailure::Invocation(e)) => {
                return Err(interrupted_failure(e, &interruption));
            }
        };
        scope.check_binding(generation, original.deadline(), &mut cancel)?;
        Ok(Some(Self {
            generation,
            original,
            distribution,
        }))
    }
    pub(crate) fn revalidate_in_scope(
        &self,
        scope: &GenerationValidationScope<'_, 'native>,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), Failure> {
        scope.check_binding(self.generation, self.original.deadline(), &mut cancel)?;
        let interruption = RefCell::new(None);
        {
            let callback = RefCell::new(&mut cancel);
            self.distribution
                .revalidate(&|| match callback.borrow_mut()()
                    .and_then(|()| self.original.deadline().check().map_err(|e| e.to_string()))
                {
                    Ok(()) => false,
                    Err(e) => {
                        interruption.borrow_mut().get_or_insert(e);
                        true
                    }
                })
                .map_err(|e| interrupted_failure(e, &interruption))?;
        }
        scope.check_binding(self.generation, self.original.deadline(), &mut cancel)?;
        Ok(())
    }
    pub(crate) fn observe_common_dir(
        self,
        scope: &GenerationValidationScope<'_, 'native>,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<git::SettledCommonDir, Failure> {
        scope.check_binding(self.generation, self.original.deadline(), &mut cancel)?;
        let interruption = RefCell::new(None);
        let result = {
            let callback = RefCell::new(&mut cancel);
            self.distribution
                .observe_common_dir(&|| match callback.borrow_mut()()
                    .and_then(|()| self.original.deadline().check().map_err(|e| e.to_string()))
                {
                    Ok(()) => false,
                    Err(e) => {
                        interruption.borrow_mut().get_or_insert(e);
                        true
                    }
                })
                .map_err(|e| interrupted_failure(e, &interruption))?
        };
        scope.check_binding(self.generation, self.original.deadline(), &mut cancel)?;
        Ok(result)
    }
}
/// Evidence command only. Keep terminal custody even after the operation's 5s
/// bound: retry uses cleanup allowance, never renews authentication/query time.
pub(crate) fn inspect_command() -> Result<(), String> {
    match git::inspect_current() {
        Ok(observation) => {
            println!(
                "{}",
                serde_json::to_string(&observation).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Err(mut failure) => {
            let diagnostic = failure.diagnostic.clone();
            eprintln!("CAWS Stop Git inspection failed: {diagnostic}");
            while failure.custodian_retained() {
                let _ = failure.retry_cleanup();
                if failure.custodian_retained() {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
            if !failure.cleanup_settled() {
                eprintln!(
                    "CAWS Stop Git inspection terminal cleanup remains unproven; no observation emitted"
                );
            }
            Err(diagnostic)
        }
    }
}

#[cfg(test)]
mod custody_tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};

    struct OwnedFailure {
        diagnostic: &'static str,
        retained: bool,
        settled_after_retry: bool,
        keep_retained: bool,
        attempts: Rc<Cell<usize>>,
        drops: Rc<Cell<usize>>,
    }
    impl Drop for OwnedFailure {
        fn drop(&mut self) {
            self.drops.set(self.drops.get() + 1);
        }
    }
    impl CustodiedFailure for OwnedFailure {
        fn diagnostic(&self) -> &str {
            self.diagnostic
        }
        fn custodian_retained(&self) -> bool {
            self.retained
        }
        fn cleanup_settled(&self) -> bool {
            !self.retained && self.settled_after_retry
        }
        fn retry_cleanup(&mut self) -> Result<(), String> {
            assert!(self.retained, "must not retry terminal unproven failure");
            self.attempts.set(self.attempts.get() + 1);
            if self.keep_retained {
                assert!(
                    self.attempts.get() <= 32,
                    "retained cleanup retry exceeded finite regression guard"
                );
                return Err("still retained after retry".into());
            }
            self.retained = false;
            if self.settled_after_retry {
                Ok(())
            } else {
                Err("terminal unproven".into())
            }
        }
    }
    impl BoundedCustodiedFailure for OwnedFailure {
        fn retry_cleanup_until(
            &mut self,
            original: &MonotonicDeadline,
            until: Instant,
        ) -> Result<(), String> {
            original.check().map_err(|error| error.to_string())?;
            if Instant::now() >= until.min(original.expires()) {
                return Err("frontend cleanup deadline expired".into());
            }
            self.retry_cleanup()
        }
    }
    fn owned(
        diagnostic: &'static str,
        retained: bool,
        settled: bool,
        attempts: &Rc<Cell<usize>>,
        drops: &Rc<Cell<usize>>,
    ) -> OwnedFailure {
        OwnedFailure {
            diagnostic,
            retained,
            settled_after_retry: settled,
            keep_retained: false,
            attempts: attempts.clone(),
            drops: drops.clone(),
        }
    }

    #[test]
    fn retained_retry_exhausts_only_the_original_frontend_bound_without_dropping_owner() {
        let attempts = Rc::new(Cell::new(0));
        let drops = Rc::new(Cell::new(0));
        let mut failure = owned("permanently retained", true, false, &attempts, &drops);
        failure.keep_retained = true;
        let mut custody = RetainedFailures::default();
        let _: Result<(), String> = custody.retain(Err(failure));
        let original = MonotonicDeadline::capture(std::time::Duration::from_secs(1)).unwrap();
        let until = Instant::now() + std::time::Duration::from_millis(10);
        let message = custody.settle_cleanup_until(&original, until).unwrap();
        assert!(
            original.check().is_ok(),
            "caller reserve expires before original budget"
        );
        assert!(message.contains("permanently retained"));
        assert!(message.contains("terminal cleanup remains unproven"));
        assert!(attempts.get() > 0);
        assert!(custody.failures[0].custodian_retained());
        assert!(!custody.failures[0].cleanup_settled());
        assert_eq!(
            drops.get(),
            0,
            "bounded frontend return cannot discard its owner"
        );
        let before = attempts.get();
        assert!(custody.settle_cleanup_until(&original, until).is_some());
        assert_eq!(
            attempts.get(),
            before,
            "an expired bound cannot renew a cleanup attempt"
        );
        assert_eq!(drops.get(), 0);
        drop(custody);
        assert_eq!(drops.get(), 1);
    }

    #[test]
    fn callback_custody_survives_both_closing_brackets_replacing_its_error() {
        let attempts = Rc::new(Cell::new(0));
        let drops = Rc::new(Cell::new(0));
        let mut custody = RetainedFailures::default();
        // Cleanup owners exercise retain-before-String without forging any
        // Git/Stop receipt. The bracket-error replacements are deliberate.
        let callback: Result<(), String> = custody.retain(Err(owned(
            "first Git failure",
            true,
            true,
            &attempts,
            &drops,
        )));
        assert_eq!(callback.unwrap_err(), "first Git failure");
        assert_eq!(drops.get(), 0);
        let closing_scope: Result<(), String> =
            custody.preserve(Err("closing readset changed".into()));
        let closing_generation: Result<(), String> =
            custody.preserve(Err("closing generation changed".into()));
        assert_eq!(
            closing_scope.unwrap_err(),
            "first Git failure; subsequent validation failure: closing readset changed"
        );
        assert_eq!(
            closing_generation.unwrap_err(),
            "first Git failure; subsequent validation failure: closing readset changed; subsequent validation failure: closing generation changed"
        );
        assert_eq!(drops.get(), 0, "closing errors cannot drop the owner");
        assert!(custody.settle_cleanup().is_none());
        assert_eq!(attempts.get(), 1);
        assert_eq!(drops.get(), 0, "root retains settled record through output");
        drop(custody);
        assert_eq!(drops.get(), 1);
    }

    #[test]
    fn later_failure_preserves_first_and_second_custodian() {
        let attempts = Rc::new(Cell::new(0));
        let drops = Rc::new(Cell::new(0));
        let mut custody = RetainedFailures::default();
        let _: Result<(), String> =
            custody.retain(Err(owned("first", true, true, &attempts, &drops)));
        let later: Result<(), String> =
            custody.retain(Err(owned("second", true, true, &attempts, &drops)));
        assert_eq!(
            later.unwrap_err(),
            "first; subsequent validation failure: second"
        );
        assert_eq!(
            custody.preserve(Ok(17)).unwrap_err(),
            "first; subsequent validation failure: second"
        );
        assert_eq!(drops.get(), 0);
        assert!(custody.settle_cleanup().is_none());
        assert_eq!(attempts.get(), 2);
        drop(custody);
        assert_eq!(drops.get(), 2);
    }

    #[test]
    fn root_cleanup_stops_at_terminal_unproven_without_retrying_absent_custody() {
        let attempts = Rc::new(Cell::new(0));
        let drops = Rc::new(Cell::new(0));
        let mut custody = RetainedFailures::default();
        let _: Result<(), String> =
            custody.retain(Err(owned("retained", true, false, &attempts, &drops)));
        let _: Result<(), String> = custody.retain(Err(owned(
            "already terminal",
            false,
            false,
            &attempts,
            &drops,
        )));
        let diagnostic = custody.settle_cleanup().unwrap();
        assert_eq!(attempts.get(), 1);
        assert!(diagnostic.contains("terminal cleanup remains unproven"));
        assert!(diagnostic.contains("retained; already terminal"));
        assert!(custody.settle_cleanup().is_some());
        assert_eq!(
            attempts.get(),
            1,
            "terminal failure cannot start another loop"
        );
        assert_eq!(drops.get(), 0);
        drop(custody);
        assert_eq!(drops.get(), 2);
    }
}
