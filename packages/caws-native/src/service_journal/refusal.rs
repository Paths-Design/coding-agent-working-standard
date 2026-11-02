use super::*;

impl Journal {
    #[cfg(all(test, feature = "sqlite-store"))]
    pub(crate) fn inject_refusal_sync_failure(&mut self, offset: usize) {
        self.fail_sync = Some(self.sync_count + offset);
    }
    /// Record only a caller-established refusal before reservation starts.
    /// Never reinterpret an existing operation, including a partially published
    /// reservation. A failed atomic write poisons this handle and grants no
    /// release permission, even when durable bytes may already exist.
    pub(crate) fn refuse_before_reservation(
        &mut self,
        identity: Identity,
        original_digest: &str,
        reason: PreReservationRefusalReason,
        expires: Instant,
    ) -> Result<Operation> {
        self.current(expires)?;
        if !identity.valid()
            || identity.project_service_key != self.key
            || !digest(original_digest)
            || identity.argument_digest != original_digest
        {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "invalid refusal identity",
            ));
        }
        if self.lookup(&identity.request_id, expires)?.is_some() {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "refusal cannot replace an existing original",
            ));
        }
        let sequence = self
            .entries
            .last()
            .map_or(Some(1), |entry| entry.operation.sequence.checked_add(1))
            .ok_or_else(|| JournalError::new(ErrorKind::Invalid, "operation sequence exhausted"))?;
        let operation = Operation {
            identity,
            sequence,
            verified_request_base64: STANDARD.encode(original_digest.as_bytes()),
            verified_request_sha256: hash(original_digest.as_bytes()),
            outcome: AcceptedOutcome::RefusedBeforeReservation {
                admission: Accepted::Value,
                reason,
            },
        };
        let bytes = encode(&operation)?;
        let (count, retained_bytes) = self.history_size()?;
        if count >= MAX_CONSUMED_RECORDS || bytes.len() > MAX_CONSUMED_BYTES - retained_bytes {
            return Err(JournalError::new(
                ErrorKind::Invalid,
                "terminal history exhausted; refused original retained",
            ));
        }
        let stamp = self.atomic_checked(
            &record_name(&operation.identity.request_id),
            &bytes,
            None,
            expires,
            &|_| Ok(()),
        )?;
        self.entries.push(Entry {
            operation: operation.clone(),
            stamp,
        });
        Ok(operation)
    }
}
