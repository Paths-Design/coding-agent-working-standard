//! Native generation/original binding for maintained Git. Only the parent Stop
//! owner can join this receipt to selection, prefix, publication and a consumer.
use crate::{
    native_generation::GenerationReceipt, selection_observation::GenerationValidationScope,
};
use caws_native::{context_git::stop as git, session_cache_wire::OriginalStopCapture};
use std::cell::RefCell;
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
    pub(crate) fn retry_cleanup(&mut self) -> Result<(), String> {
        match self {
            Self::Invalidated(_) => Ok(()),
            Self::Retained(e) => e.retry_cleanup(),
        }
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
