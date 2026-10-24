//! Native-owned Stop eligibility retained across dispatch, prefix and queueing.
//! The serialized grant routes the selected engine; it cannot construct this
//! owner or a completed prefix. Unsupported domains retain compatibility only
//! before any native Stop effects have been attempted.
use crate::{
    native_generation::GenerationReceipt,
    protocol::{Ready, Request},
    stop_admission::StockStopSelection,
    stop_profile::StopProfileReceipt,
};
use std::{collections::BTreeMap, path::Path};

pub(crate) struct EligibleStop<'selection, 'owners, 'native> {
    selection: &'selection StockStopSelection<'owners, 'native>,
    profile: StopProfileReceipt<'selection>,
}

/// Match the ordinary engine's inherited-startup calculation. The selected
/// stock handler-env is infrastructure; any nonempty prior startup is outside
/// this native domain and must retain its compatibility execution.
fn ambient_startup(environment: &BTreeMap<String, String>, startup: &Path) -> bool {
    if environment
        .get("CAWS_PRIOR_BASH_ENV")
        .is_some_and(|v| !v.is_empty())
    {
        return true;
    }
    environment
        .get("BASH_ENV")
        .is_some_and(|value| !value.is_empty() && startup.to_str() != Some(value.as_str()))
}

fn supported_session_id(sid: &str) -> bool {
    !sid.is_empty()
        && !matches!(sid, "unknown" | "." | "..")
        && sid.len() <= 128
        && sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

impl<'selection, 'owners: 'selection, 'native: 'selection>
    EligibleStop<'selection, 'owners, 'native>
{
    pub(crate) fn admit(
        selection: &'selection StockStopSelection<'owners, 'native>,
        generation: &'selection GenerationReceipt,
        ready: &Ready,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<Option<Self>, String> {
        selection
            .revalidate(&mut cancel)
            .map_err(|e| e.to_string())?;
        let original = selection.original();
        let environment = original.caller_environment();
        let root = generation.root();
        if !ready.active
            || ready.service_offer.is_some()
            || ambient_startup(environment, &root.join("handler-env.sh"))
        {
            return Ok(None);
        }
        // Refuse unsupported cwd/session spellings before the mandatory prefix
        // can publish anything. Registration independently checks them again.
        let cwd =
            caws_native::invocation_project::payload_string(original.original_payload(), "cwd")?;
        let sid = caws_native::invocation_project::payload_string(
            original.original_payload(),
            "session_id",
        )?;
        if !cwd.as_deref().is_some_and(|cwd| {
            Path::new(cwd).is_absolute() && Path::new(cwd) == original.query_cwds()[0]
        }) || !sid.as_deref().is_some_and(|sid| {
            supported_session_id(sid) && ready.session_id.as_deref() == Some(sid)
        }) {
            return Ok(None);
        }
        use sha2::{Digest, Sha256};
        let canonical = original
            .observed_project()
            .canonical_root
            .to_str()
            .ok_or("native Stop original root is not UTF-8")?;
        if ready.project_digest.as_deref()
            != Some(format!("{:x}", Sha256::digest(canonical.as_bytes())).as_str())
        {
            return Err("native Stop Ready project differs from original capture".into());
        }
        let profile = match StopProfileReceipt::capture(generation, original, &mut cancel) {
            Ok(profile) => profile,
            Err(_) => {
                // Missing/unsupported semantic data is compatibility, but an
                // invalidated source, cancellation or expired clock is not.
                selection
                    .revalidate(&mut cancel)
                    .map_err(|e| e.to_string())?;
                generation.revalidate(original.deadline().expires(), &mut cancel)?;
                cancel()?;
                original.deadline().check().map_err(|e| e.to_string())?;
                return Ok(None);
            }
        };
        let eligible = Self { selection, profile };
        eligible.revalidate(&mut cancel)?;
        Ok(Some(eligible))
    }

    pub(crate) fn revalidate(
        &self,
        mut cancel: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self.selection
            .revalidate(&mut cancel)
            .map_err(|e| e.to_string())?;
        self.profile.revalidate(&mut cancel)?;
        self.selection
            .revalidate(&mut cancel)
            .map_err(|e| e.to_string())
    }

    pub(crate) fn dispatch(&self, request: &Request) -> Result<Vec<u8>, String> {
        if request.id != self.selection.original().id()
            || request.runtime_digest != self.profile.runtime_digest()
        {
            return Err("native Stop dispatch differs from qualified original".into());
        }
        let (renderer, digits) = self.profile.renderer_selector();
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "schema":"caws.runtime.dispatch.v3", "id":request.id,
            "runtimeDigest":request.runtime_digest,
            "nativeStop": {"schema":"caws.runtime.stop-admission.v1",
                "loggerIndex":self.selection.logger_index(),
                "sqlProfile":self.profile.sql_selector(),
                "rendererProfile":renderer,"rendererIntegerMaxDigits":digits}
        }))
        .map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skipped_or_unsafe_session_ids_remain_unsupported_before_prefix_effects() {
        for sid in [
            "",
            "unknown",
            ".",
            "..",
            "../neighbor",
            "雪",
            "session:other",
            "sid\0",
        ] {
            assert!(!supported_session_id(sid), "{sid:?}");
        }
        for sid in ["session-1", "session_2.3", &"x".repeat(128)] {
            assert!(supported_session_id(sid), "{sid:?}");
        }
        assert!(!supported_session_id(&"x".repeat(129)));
    }

    #[test]
    fn foreign_or_prior_startup_cannot_be_removed_by_native_dispatch() {
        let startup = Path::new("/reviewed/runtime/handler-env.sh");
        for (bash, prior, expected) in [
            (None, None, false),
            (Some(""), Some(""), false),
            (Some("/reviewed/runtime/handler-env.sh"), None, false),
            (Some("/reviewed/runtime/handler-env.sh"), Some(""), false),
            (
                Some("/reviewed/runtime/handler-env.sh"),
                Some("/user/startup"),
                true,
            ),
            (Some("/user/startup"), None, true),
            (Some("/user/startup"), Some(""), true),
            (None, Some("/user/startup"), true),
        ] {
            let mut env = BTreeMap::new();
            if let Some(value) = bash {
                env.insert("BASH_ENV".into(), value.into());
            }
            if let Some(value) = prior {
                env.insert("CAWS_PRIOR_BASH_ENV".into(), value.into());
            }
            assert_eq!(ambient_startup(&env, startup), expected, "{env:?}");
        }
    }
}
