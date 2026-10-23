//! Bounded publication exchange. Correlation is not filesystem authority.
use serde::{Deserialize, Serialize};

pub const PREPARE: &str = "caws.runtime.session-publication.prepare.v1";
pub const INPUTS: &str = "caws.runtime.session-publication.inputs.v1";
pub const PREPARED: &str = "caws.runtime.session-publication.prepared.v1";
pub const CHUNK: &str = "caws.runtime.session-publication.chunk.v1";
pub const READY: &str = "caws.runtime.session-publication.ready.v1";
pub const RESULT: &str = "caws.runtime.session-publication.result.v1";
pub const CONSUMED: &str = "caws.runtime.session-publication.consumed.v1";
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_ARTIFACTS: usize = 4096;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
/// Only a publication frame/read reply may use this base64 envelope allowance.
pub const MAX_RELAY_FRAME_BYTES: usize = MAX_FRAME_BYTES.div_ceil(3) * 4 + 4096;
// At most Projection -> Render, or one direct Render/Seal. Every output chunk
// is exactly 64KiB except the artifact tail. The extra 4096 bytes cover the
// bounded escaped correlation/name, JSON fields and LF; arbitrary whitespace
// cannot manufacture more credit. Four overhead bytes per chunk reserve base64
// padding across independently encoded chunks. Credit is accepted raw bytes.
pub const MAX_CHUNK_FRAME_OVERHEAD: usize = 4096;
pub const MAX_EXTRA_PUBLICATION_ENGINE_STDOUT_BYTES: usize = 2
    * (MAX_TOTAL_BYTES.div_ceil(3) * 4
        + (MAX_TOTAL_BYTES.div_ceil(MAX_CHUNK_BYTES) + MAX_ARTIFACTS) * MAX_CHUNK_FRAME_OVERHEAD
        + 2 * MAX_FRAME_BYTES)
    + MAX_FRAME_BYTES;
#[derive(Debug, Default)]
pub struct CreditBudget(usize);
impl CreditBudget {
    pub fn accept(&mut self, bytes: usize) -> Result<(), String> {
        let total = self
            .0
            .checked_add(bytes)
            .ok_or("publication credit overflow")?;
        if bytes == 0 || total > MAX_EXTRA_PUBLICATION_ENGINE_STDOUT_BYTES {
            return Err("publication credit exceeds one finite operation".into());
        }
        self.0 = total;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Projection,
    Render,
    Seal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Correlation {
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub attempt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub name: String,
    pub role: String,
    pub byte_length: usize,
    pub sha256: String,
}
pub fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn leaf(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
}
pub fn role(name: &str) -> Option<&'static str> {
    if name == ".meta.json" {
        return Some("metadata");
    }
    if name == "store-projection.jsonl" {
        return Some("projection");
    }
    if name == "session-index.json" {
        return Some("index");
    }
    let suffix = name.strip_prefix("turn-")?;
    let (number, role) = suffix
        .strip_suffix(".payloads.json")
        .map(|s| (s, "spill"))
        .or_else(|| suffix.strip_suffix(".json").map(|s| (s, "turn")))?;
    (!number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())).then_some(role)
}
pub fn target(kind: Kind, descriptor: &Descriptor) -> bool {
    leaf(&descriptor.name)
        && role(&descriptor.name) == Some(descriptor.role.as_str())
        && match kind {
            Kind::Projection => descriptor.role == "projection",
            Kind::Render => matches!(descriptor.role.as_str(), "turn" | "spill" | "index"),
            Kind::Seal => descriptor.role == "metadata",
        }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepared {
    pub schema: String,
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub attempt: String,
    pub kind: Kind,
    pub observation_id: String,
    pub input_digest: String,
    pub disposition: String,
    pub artifacts: Vec<Descriptor>,
    pub removals: Vec<String>,
    pub diagnostic: Option<String>,
    pub summary_mode: Option<String>,
}
impl Prepared {
    pub(crate) fn correlation(&self) -> Correlation {
        Correlation {
            id: self.id.clone(),
            runtime_digest: self.runtime_digest.clone(),
            token: self.token.clone(),
            attempt: self.attempt.clone(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Chunk {
    pub schema: String,
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub attempt: String,
    pub kind: Kind,
    pub name: String,
    pub offset: usize,
    pub base64: String,
}
impl Chunk {
    pub(crate) fn correlation(&self) -> Correlation {
        Correlation {
            id: self.id.clone(),
            runtime_digest: self.runtime_digest.clone(),
            token: self.token.clone(),
            attempt: self.attempt.clone(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Ready {
    pub schema: String,
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub attempt: String,
    pub kind: Kind,
    pub direction: String,
}
impl Ready {
    pub(crate) fn correlation(&self) -> Correlation {
        Correlation {
            id: self.id.clone(),
            runtime_digest: self.runtime_digest.clone(),
            token: self.token.clone(),
            attempt: self.attempt.clone(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consumed {
    pub schema: String,
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub attempt: String,
    pub terminal_digest: String,
}
impl Consumed {
    pub fn correlation(&self) -> Correlation {
        Correlation {
            id: self.id.clone(),
            runtime_digest: self.runtime_digest.clone(),
            token: self.token.clone(),
            attempt: self.attempt.clone(),
        }
    }
}

#[cfg(test)]
mod credit_tests {
    use super::*;
    #[test]
    fn exact_finite_budget_refuses_overflow_zero_and_does_not_spend_on_refusal() {
        assert_eq!(MAX_EXTRA_PUBLICATION_ENGINE_STDOUT_BYTES, 418_731_352);
        let mut budget = CreditBudget::default();
        assert!(budget.accept(0).is_err());
        assert!(budget.accept(usize::MAX).is_err());
        budget
            .accept(MAX_EXTRA_PUBLICATION_ENGINE_STDOUT_BYTES - 1)
            .unwrap();
        assert!(budget.accept(2).is_err());
        budget.accept(1).unwrap();
        assert!(budget.accept(1).is_err());
    }
}
