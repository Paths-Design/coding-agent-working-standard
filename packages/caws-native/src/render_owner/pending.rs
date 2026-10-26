//! Bounded connection lifetime, prefix identity and backend cohort contracts.
use super::*;

impl Actor {
    pub(super) fn run(mut self, rx: mpsc::Receiver<Mailbox>) {
        let mut pending: VecDeque<PendingJob> = VecDeque::new();
        let mut waiting: Option<Job> = None;
        let mut exclusive_waiting: Option<ExclusiveJob> = None;
        let mut exclusive_waiting_observed = false;
        let mut barrier = false;
        let idle_duration = Duration::from_millis(self.config.limits.idle_ms as u64);
        let mut idle_expires = Instant::now() + idle_duration;
        loop {
            if let Some(arrival) = bridge_head(pending.iter().map(|entry| &entry.job)) {
                let entry = pending.pop_front().expect("observed FIFO head");
                let invocation = entry.job.offer.invocation_id.clone();
                let result = match arrival {
                    Ok(incoming) => self.finish_prepared(&entry, incoming),
                    Err(reason) => {
                        self.phase = "bridge_read";
                        self.observations.emit(Observation::PreparedWithdrawn {
                            invocation_id: &invocation,
                            reason: observation_reason(&reason),
                        });
                        Err(reason)
                    }
                };
                if let Err(reason) = result {
                    self.observations.emit(Observation::ActorError {
                        stage: self.phase,
                        reason: observation_reason(&reason),
                    });
                }
                self.stage("finish", &invocation);
                drop(entry);
                idle_expires = Instant::now() + idle_duration;
                if self.unknown {
                    // Dispatch retained Running before any backend command.
                    // Local quarantine also covers failed outcome publication.
                    // Withdraw grants before retiring their private Git view.
                    self.withdraw_for_unknown(&mut pending, &mut waiting, &rx);
                    self.retire();
                }
                if pending.is_empty() {
                    barrier = false;
                }
                continue;
            }
            if exclusive_waiting.is_some() {
                if pending.is_empty() {
                    match exclusive_waiting.take().expect("exclusive waiting job") {
                        ExclusiveJob::Session(job) => self.acquire_session_job(job),
                        #[cfg(feature = "sqlite-store")]
                        ExclusiveJob::Store(job) => self.acquire_store_job(job),
                    }
                    exclusive_waiting_observed = false;
                    barrier = false;
                    idle_expires = Instant::now() + idle_duration;
                } else {
                    if !exclusive_waiting_observed {
                        match exclusive_waiting.as_ref().expect("exclusive waiting job") {
                            ExclusiveJob::Session(job) => {
                                self.stage("session_cohort_waiting", &job.invocation_id())
                            }
                            #[cfg(feature = "sqlite-store")]
                            ExclusiveJob::Store(job) => {
                                self.stage("store_cohort_waiting", &job.invocation_id())
                            }
                        }
                        exclusive_waiting_observed = true;
                    }
                    thread::sleep(TICK);
                }
                continue;
            }
            if waiting.is_none() {
                let timeout = if pending.is_empty() {
                    idle_expires.saturating_duration_since(Instant::now())
                } else {
                    TICK
                };
                match rx.recv_timeout(timeout) {
                    Ok(Mailbox::Idle(probe)) => {
                        let proof = if pending.is_empty()
                            && waiting.is_none()
                            && exclusive_waiting.is_none()
                        {
                            self.idle_proof(probe.barrier.expires)
                        } else {
                            Err("idle actor retains pending work".into())
                        };
                        let ready = proof.is_ok();
                        // Publish a refusal only after aborting the common
                        // decision, so a ready peer cannot commit through it.
                        if !ready {
                            probe.barrier.finish(false);
                        }
                        if probe.reply.try_send(proof).is_err() {
                            probe.barrier.finish(false);
                        }
                        if ready && probe.barrier.parked() {
                            // The proof excludes every live worker/writer/cleanup
                            // object. Preserve durable outcomes; no retire/settle.
                            return;
                        }
                        // Idle probes are not demand and cannot renew the actor's
                        // ordinary retirement clock. Even a continuously nonempty
                        // probe mailbox must not starve the already-due timeout.
                        if pending.is_empty() && Instant::now() >= idle_expires {
                            self.retire();
                            idle_expires = Instant::now() + idle_duration;
                        }
                        continue;
                    }
                    Ok(Mailbox::Render(job)) => {
                        idle_expires = Instant::now() + idle_duration;
                        waiting = Some(job);
                    }
                    Ok(Mailbox::Session(job)) => {
                        idle_expires = Instant::now() + idle_duration;
                        exclusive_waiting = Some(ExclusiveJob::Session(job));
                        exclusive_waiting_observed = false;
                        barrier = true;
                        continue;
                    }
                    #[cfg(feature = "sqlite-store")]
                    Ok(Mailbox::Store(job)) => {
                        idle_expires = Instant::now() + idle_duration;
                        exclusive_waiting = Some(ExclusiveJob::Store(job));
                        exclusive_waiting_observed = false;
                        barrier = true;
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if pending.is_empty() {
                            self.retire();
                            idle_expires = Instant::now() + idle_duration;
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        self.withdraw_pending(&mut pending, "owner_stopped");
                        self.retire();
                        return;
                    }
                }
            }
            let job = waiting.as_mut().expect("one bounded waiting offer");
            if !pending.is_empty()
                && (barrier
                    || pending
                        .iter()
                        .any(|entry| !entry.permits_prefix(&job.offer)))
            {
                if !barrier {
                    self.stage("prefix_barrier", &job.offer.invocation_id);
                    barrier = true;
                }
                thread::sleep(TICK);
                continue;
            }
            match self.prepare_job(job, pending.front().map(|entry| &entry.state)) {
                Ok(Some(state)) => {
                    pending.push_back(PendingJob {
                        job: waiting.take().expect("prepared waiting offer"),
                        state,
                    });
                    barrier = false;
                }
                Ok(None) => {
                    // The first incompatible or serial offer is a FIFO barrier;
                    // do not repeat its admission work while the cohort drains.
                    self.stage("generation_barrier", &job.offer.invocation_id);
                    barrier = true;
                }
                Err(reason) => {
                    self.observations.emit(Observation::ActorError {
                        stage: self.phase,
                        reason: observation_reason(&reason),
                    });
                    self.stage("finish", &job.offer.invocation_id);
                    waiting.take();
                    idle_expires = Instant::now() + idle_duration;
                    if self.unknown {
                        self.withdraw_for_unknown(&mut pending, &mut waiting, &rx);
                        self.retire();
                    }
                    barrier = false;
                }
            }
        }
    }
    fn withdraw_pending(&self, pending: &mut VecDeque<PendingJob>, reason: &'static str) {
        for entry in pending.drain(..) {
            self.observations.emit(Observation::PreparedWithdrawn {
                invocation_id: &entry.job.offer.invocation_id,
                reason,
            });
            // Dropping each Job shuts down its transport, revoking the grant.
        }
    }
    pub(super) fn withdraw_for_unknown(
        &self,
        pending: &mut VecDeque<PendingJob>,
        waiting: &mut Option<Job>,
        inbox: &mpsc::Receiver<Mailbox>,
    ) {
        self.withdraw_pending(pending, "unknown_fence");
        if let Some(job) = waiting.take() {
            self.observations.emit(Observation::QueuedOfferWithdrawn {
                invocation_id: &job.offer.invocation_id,
                reason: "unknown_fence",
            });
        }
        // Drain at most the declared inbox capacity. Later arrivals encounter
        // the existing unknown fence; quarantine never spins awaiting arrivals.
        for _ in 0..self.config.limits.max_queue_per_project {
            let Ok(job) = inbox.try_recv() else { break };
            match job {
                Mailbox::Idle(probe) => {
                    probe.barrier.finish(false);
                }
                Mailbox::Render(job) => self.observations.emit(Observation::QueuedOfferWithdrawn {
                    invocation_id: &job.offer.invocation_id,
                    reason: "unknown_fence",
                }),
                Mailbox::Session(job) => job.refuse("renderer unknown fence"),
                #[cfg(feature = "sqlite-store")]
                Mailbox::Store(job) => job.refuse("renderer unknown fence"),
            }
        }
        // No backend reservation, writer intent, or durable Unknown is released.
    }
}

pub(super) struct ConnectionPermit(pub(super) Arc<AtomicUsize>);
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(super) struct ProjectCapacity {
    pub(super) used: AtomicUsize,
    pub(super) maximum: usize,
}
#[derive(Clone)]
pub(super) struct ProjectRoute {
    pub(super) sender: SyncSender<Mailbox>,
    pub(super) capacity: Arc<ProjectCapacity>,
}
impl ProjectCapacity {
    pub(super) fn acquire(self: &Arc<Self>) -> Result<Arc<ProjectPermit>> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                (used < self.maximum).then_some(used + 1)
            })
            .map_err(|_| "renderer project queue full".to_owned())?;
        Ok(Arc::new(ProjectPermit(Arc::clone(self))))
    }
}
pub(super) struct ProjectPermit(pub(super) Arc<ProjectCapacity>);
impl Drop for ProjectPermit {
    fn drop(&mut self) {
        self.0.used.fetch_sub(1, Ordering::AcqRel);
    }
}
enum ExclusiveJob {
    Session(session::SessionJob),
    #[cfg(feature = "sqlite-store")]
    Store(store::StoreJob),
}
pub(super) enum Mailbox {
    Idle(IdleProbe),
    Render(Job),
    Session(session::SessionJob),
    #[cfg(feature = "sqlite-store")]
    Store(store::StoreJob),
}
pub(super) struct Job {
    pub(super) stream: UnixStream,
    pub(super) offer: Offer,
    pub(super) expires: Instant,
    pub(super) reader_start: Option<SyncSender<()>>,
    pub(super) bridge: mpsc::Receiver<Result<Vec<u8>>>,
    pub(super) _permit: Arc<ConnectionPermit>,
    pub(super) _project_permit: Arc<ProjectPermit>,
}
impl Drop for Job {
    fn drop(&mut self) {
        // Withdraw the grant and wake its existing connection reader before
        // releasing either shared admission permit or a backend cohort.
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}
pub(super) fn read_prepared_bridge(
    stream: &mut UnixStream,
    start: mpsc::Receiver<()>,
    result: SyncSender<Result<Vec<u8>>>,
    expires: Instant,
    observations: &ObservationLog,
    invocation_id: &str,
) {
    let incoming = match start.recv_timeout(expires.saturating_duration_since(Instant::now())) {
        Ok(()) => bridge_frame_eof(stream, wire::MAX_SERVICE_BRIDGE_REQUEST_BYTES, expires),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("renderer prepared reader deadline expired".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("renderer prepared grant withdrawn".into())
        }
    };
    if incoming.is_ok() {
        observations.emit(Observation::ActorStage {
            stage: "bridge_received",
            invocation_id,
        });
    }
    // One reader produces one bounded result. Completion never waits for space
    // in the offer mailbox and cannot reorder or dispatch the request.
    let _ = result.try_send(incoming);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PrefixIdentity {
    pub(super) canonical_project: String,
    pub(super) source_generation: String,
    pub(super) image_digest: String,
    pub(super) proof_profile: String,
}
impl PrefixIdentity {
    pub(super) fn from_concurrency(disposition: image::PrefixConcurrency) -> Option<Self> {
        match disposition {
            image::PrefixConcurrency::Serial(_) => None,
            image::PrefixConcurrency::Session(proof) => Some(Self {
                canonical_project: proof.canonical_project().to_owned(),
                source_generation: proof.source_generation().to_owned(),
                image_digest: proof.image_digest().to_owned(),
                proof_profile: proof.proof_profile().to_owned(),
            }),
        }
    }
    pub(super) fn binds(&self, offer: &Offer) -> bool {
        self.canonical_project == offer.expected_selection.canonical_project
            && self.source_generation == offer.prepared.manifest.source_generation
            && self.image_digest == offer.prepared.image_digest
    }
    pub(super) fn permits_session(&self, current_session: &str, offer: &Offer) -> bool {
        // Admitted session IDs are ASCII, and their directories may alias on a
        // case-insensitive filesystem. Preserve caller spelling but serialize
        // every case-only alias of the same session domain.
        !current_session.eq_ignore_ascii_case(&offer.session_id) && self.binds(offer)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct BackendCohort {
    pub(super) directory: PathBuf,
    pub(super) backend_pid: u32,
    pub(super) image_digest: String,
    pub(super) git_directory: PathBuf,
    pub(super) git_work_tree: PathBuf,
    pub(super) git_original_directory: PathBuf,
    pub(super) git_common_directory: PathBuf,
    pub(super) metadata_digest: String,
    pub(super) metadata_files: usize,
    pub(super) metadata_bytes: u64,
}
impl BackendCohort {
    pub(super) fn of(process: &BackendProcess) -> Self {
        Self {
            directory: process.directory.clone(),
            backend_pid: process.backend_pid,
            image_digest: process.image_digest.clone(),
            git_directory: process.view.git_directory.clone(),
            git_work_tree: process.view.git_work_tree.clone(),
            git_original_directory: process.view.git_original_directory.clone(),
            git_common_directory: process.view.git_common_directory.clone(),
            metadata_digest: process.view.metadata_digest.clone(),
            metadata_files: process.view.metadata_files,
            metadata_bytes: process.view.metadata_bytes,
        }
    }
    pub(super) fn compatible(&self, image_digest: &str, view: &git::GitView) -> bool {
        self.image_digest == image_digest
            && self.metadata_digest == view.metadata_digest
            && self.git_work_tree == view.git_work_tree
            && self.git_original_directory == view.git_original_directory
            && self.git_common_directory == view.git_common_directory
            && self.metadata_files == view.metadata_files
            && self.metadata_bytes == view.metadata_bytes
    }
}
pub(super) struct PreparedState {
    pub(super) admitted: image::ValidatedImage,
    pub(super) context: image::AdmissionContext,
    pub(super) issued: wire::ServiceRenderGrant,
    pub(super) cohort: BackendCohort,
    pub(super) isolation: Option<PrefixIdentity>,
}
pub(super) struct PendingJob {
    pub(super) job: Job,
    pub(super) state: PreparedState,
}
impl PendingJob {
    pub(super) fn permits_prefix(&self, offer: &Offer) -> bool {
        self.state
            .isolation
            .as_ref()
            .is_some_and(|proof| proof.permits_session(&self.job.offer.session_id, offer))
    }
}
pub(super) fn bridge_arrival(job: &Job) -> Option<Result<Vec<u8>>> {
    if let Err(reason) = check(job.expires).and_then(|()| response_channel(&job.stream)) {
        return Some(Err(reason));
    }
    match job.bridge.try_recv() {
        Ok(result) => Some(result),
        Err(mpsc::TryRecvError::Empty) => None,
        Err(mpsc::TryRecvError::Disconnected) => {
            Some(Err("renderer prepared reader closed".into()))
        }
    }
}
pub(super) fn bridge_head<'a>(mut jobs: impl Iterator<Item = &'a Job>) -> Option<Result<Vec<u8>>> {
    jobs.next().and_then(bridge_arrival)
}
