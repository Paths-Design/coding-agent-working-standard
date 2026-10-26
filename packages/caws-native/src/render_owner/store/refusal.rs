use super::*;

impl StoreRegistry {
    pub(super) fn release_refused(
        &mut self,
        record: &Arc<Mutex<StoreRecord>>,
        held: &mut StoreRecord,
        operation: &journal::Operation,
    ) -> Result<()> {
        let original = &held.original;
        let original_digest = sha(&serde_json::to_vec(original.as_ref()).map_err(err)?);
        let binding = original
            .native_stop
            .as_ref()
            .ok_or("refusal lacks native original")?;
        let identity = operation.identity();
        if held.result.is_some()
            || held.writer.is_some()
            || held.publication.is_some()
            || held.consumed
            || held.refused
            || !held.original_project_bound
            || !original.publication
            || held.publication_error.is_none()
            || !matches!(
                operation.outcome(),
                journal::AcceptedOutcome::RefusedBeforeReservation {
                    reason: journal::PreReservationRefusalReason::NativeQualificationRefused,
                    ..
                }
            )
            || identity.request_id != publication::original_request_id(&original.id)
            || identity.project_service_key
                != wire::project_service_key(&binding.canonical_root).map_err(err)?
            || identity.argument_digest != original_digest
            || identity.source_generation != original.runtime_digest
            || identity.execution_image_digest != original.runtime_digest
            || operation.verified_request().map_err(err)? != original_digest.as_bytes()
        {
            return Err("refusal release lacks exact durable original and resource proof".into());
        }
        match self.records.get(&original.id) {
            Some((runtime, registration, weak))
                if *runtime == original.runtime_digest
                    && *registration == held.registration
                    && weak
                        .upgrade()
                        .is_some_and(|current| Arc::ptr_eq(&current, record)) => {}
            _ => return Err("store refused registration changed".into()),
        }
        self.records.remove(&original.id);
        held.refused = true;
        held.phase = "refused_before_reservation";
        Ok(())
    }
    pub(super) fn release_terminal_replay(
        &mut self,
        record: &Arc<Mutex<StoreRecord>>,
        held: &mut StoreRecord,
        terminal: &journal::Operation,
    ) -> Result<()> {
        if !held.unstarted_publication()
            || held.publication_error.is_none()
            || !matches!(
                terminal.outcome(),
                journal::AcceptedOutcome::Consumed { .. }
                    | journal::AcceptedOutcome::RefusedBeforeReservation { .. }
            )
            || terminal.identity().request_id != publication::original_request_id(&held.original.id)
            || terminal.identity().project_service_key
                != wire::project_service_key(
                    &held
                        .original
                        .native_stop
                        .as_ref()
                        .ok_or("replay lacks native original")?
                        .canonical_root,
                )
                .map_err(err)?
        {
            return Err("replay release lacks durable terminal and no-effect proof".into());
        }
        match self.records.get(&held.original.id) {
            Some((runtime, registration, weak))
                if *runtime == held.original.runtime_digest
                    && *registration == held.registration
                    && weak
                        .upgrade()
                        .is_some_and(|current| Arc::ptr_eq(&current, record)) => {}
            _ => return Err("store replay registration changed".into()),
        }
        self.records.remove(&held.original.id);
        held.refused = true;
        held.phase = "terminal_replay_refused";
        Ok(())
    }
}

impl Actor {
    pub(super) fn reject_terminal_replay(
        &mut self,
        job: &StoreJob,
        original: &StoreAcquire,
    ) -> Result<bool> {
        job.transport.check_deadline()?;
        let Some(terminal) = self
            .journal
            .lookup(
                &publication::original_request_id(&original.id),
                job.transport.expires,
            )
            .map_err(err)?
        else {
            return Ok(false);
        };
        if !matches!(
            terminal.outcome(),
            journal::AcceptedOutcome::Consumed { .. }
                | journal::AcceptedOutcome::RefusedBeforeReservation { .. }
        ) {
            return Ok(false);
        }
        job.record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .publication_error =
            Some("original invocation already terminal; no replay across generations".into());
        // History rejects this new attempted replay, even with different
        // arguments or generation. It does not attribute the old outcome to it.
        {
            let mut registry = job.registry.lock().unwrap_or_else(|e| e.into_inner());
            let mut record = job.record.lock().unwrap_or_else(|e| e.into_inner());
            self.revalidate_release_terminal(&terminal, job.transport.expires)?;
            registry.release_terminal_replay(&job.record, &mut record, &terminal)?;
        }
        self.store_records
            .retain(|record| !Arc::ptr_eq(record, &job.record));
        self.stage("publication_terminal_replay_released", &original.id);
        Ok(true)
    }
    pub(super) fn persist_native_refusal(
        &mut self,
        job: &StoreJob,
        original: &StoreAcquire,
    ) -> Result<()> {
        if !job
            .record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unstarted_publication()
        {
            return Err("refusal persistence lacks no-effect record".into());
        }
        let original_digest = sha(&serde_json::to_vec(original).map_err(err)?);
        let binding = original
            .native_stop
            .as_ref()
            .ok_or("refusal lacks native original")?;
        let operation = self
            .journal
            .refuse_before_reservation(
                journal::Identity {
                    request_id: publication::original_request_id(&original.id),
                    argument_digest: original_digest.clone(),
                    project_service_key: wire::project_service_key(&binding.canonical_root)
                        .map_err(err)?,
                    source_generation: original.runtime_digest.clone(),
                    execution_image_digest: original.runtime_digest.clone(),
                },
                &original_digest,
                journal::PreReservationRefusalReason::NativeQualificationRefused,
                job.transport.expires,
            )
            .map_err(err)?;
        self.stage("publication_refused_durable", &original.id);
        {
            let mut registry = job.registry.lock().unwrap_or_else(|e| e.into_inner());
            let mut record = job.record.lock().unwrap_or_else(|e| e.into_inner());
            self.revalidate_release_terminal(&operation, job.transport.expires)?;
            registry.release_refused(&job.record, &mut record, &operation)?;
        }
        self.store_records
            .retain(|record| !Arc::ptr_eq(record, &job.record));
        self.stage("publication_refused_released", &original.id);
        Ok(())
    }

    fn revalidate_release_terminal(
        &self,
        expected: &journal::Operation,
        expires: Instant,
    ) -> Result<()> {
        // Registry and record acquisition can block. Recheck the selected file
        // identity, journal custody and exact terminal with both locks held.
        match self
            .journal
            .lookup(&expected.identity().request_id, expires)
            .map_err(err)?
        {
            Some(current) if current == *expected => Ok(()),
            _ => Err("durable terminal changed before refusal release".into()),
        }
    }
}
