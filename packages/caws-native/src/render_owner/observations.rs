//! Bounded diagnostic observations; never service authority or a gate.
use super::*;

pub(super) const OBSERVATION_MAX_BYTES: u64 = 1_048_576;
pub(super) const OBSERVATION_MAX_RECORD: usize = 8192;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum AdmissionDenial {
    UnknownFence,
    BackendCapacityExhausted,
}

/// Diagnostic observations only: never admission, authority, custody, replay or
/// capacity decisions. Append refusal cannot change a service decision. Sync is
/// bounded in bytes, not in kernel syscall latency. No rotation/reset is implicit.
#[derive(Serialize)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(super) enum Observation<'a> {
    #[cfg(feature = "sqlite-store")]
    StoreRegistered {
        invocation_id: &'a str,
        runtime_digest: &'a str,
        registration: &'a str,
    },
    HostStarted {
        host_pid: u32,
    },
    ImageAdmissionRefused {
        invocation_id: &'a str,
        canonical_project: &'a str,
        image_key: &'a str,
        operation: &'static str,
        kind: &'static str,
    },
    ImagePublicationPhase {
        invocation_id: &'a str,
        #[serde(flatten)]
        publication: image::PublicationEvent,
    },
    PrefixDisposition {
        invocation_id: &'a str,
        mode: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        proof_profile: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    GitCaptureRefused {
        reason: &'static str,
        query_exit_code: Option<i32>,
        query_signal: Option<i32>,
        stderr_bytes: Option<u64>,
    },
    ActorStage {
        stage: &'static str,
        invocation_id: &'a str,
    },
    ActorQueued {
        invocation_id: &'a str,
    },
    ActorQueueRefused {
        invocation_id: &'a str,
        reason: &'static str,
    },
    AdmissionDenied {
        invocation_id: &'a str,
        reason: AdmissionDenial,
        backend_used: usize,
        backend_maximum: usize,
    },
    JournalRecovered {
        project_service_key: &'a str,
        unknown: bool,
    },
    WorkerSpawned {
        native_worker_pid: u32,
        image_digest: &'a str,
        git_metadata_digest: &'a str,
    },
    WorkerCreated {
        native_worker_pid: u32,
        backend_pid: u32,
        image_digest: &'a str,
        git_metadata_digest: &'a str,
    },
    BackendReused {
        native_worker_pid: u32,
        backend_pid: u32,
        image_digest: &'a str,
        git_metadata_digest: &'a str,
    },
    Prepared {
        invocation_id: &'a str,
        session_id: &'a str,
        selected_index: u16,
        backend_pid: u32,
    },
    PreparedWithdrawn {
        invocation_id: &'a str,
        reason: &'static str,
    },
    QueuedOfferWithdrawn {
        invocation_id: &'a str,
        reason: &'static str,
    },
    JournalDispatch {
        request_id: &'a str,
        native_worker_pid: Option<u32>,
        backend_pid: Option<u32>,
    },
    QueuedCancelled {
        request_id: &'a str,
        reason: journal::CancelReason,
    },
    RenderOutcome {
        request_id: &'a str,
        execution: &'static str,
        served: Option<u64>,
        cached: Option<bool>,
    },
    WorkerFailure {
        native_worker_pid: Option<u32>,
        failure: backend::Failure,
    },
    WorkerCleanupDeadline {
        native_worker_pid: Option<u32>,
        backend_pid: u32,
    },
    WorkerCleanup {
        native_worker_pid: Option<u32>,
        backend_pid: u32,
        receipt: &'a backend::CleanupReceipt,
        stdout_prefix_base64: Option<String>,
        stderr_prefix_base64: Option<String>,
        worker_stderr_prefix_base64: String,
    },
    WorkerExit {
        native_worker_pid: u32,
        backend_pid: u32,
        code: Option<i32>,
        signal: Option<i32>,
        worker_stderr_prefix_base64: String,
    },
    WorkerControlUnavailable {
        native_worker_pid: Option<u32>,
        backend_pid: u32,
        worker_stderr_prefix_base64: String,
    },
    WorkerRetainedExit {
        native_worker_pid: u32,
        backend_pid: u32,
        observed_pid: i32,
        waitid_code: i32,
        worker_stderr_prefix_base64: String,
    },
    ActorError {
        stage: &'static str,
        reason: &'static str,
    },
    HostIdleExit {
        host_pid: u32,
    },
}
struct ObservationFile {
    directory: File,
    file: File,
    parent: PathBuf,
    identity: (u64, u64),
    bytes: u64,
}
pub(super) struct ObservationLog {
    file: Mutex<Option<ObservationFile>>,
    notified: std::sync::atomic::AtomicBool,
    started: Instant,
}
impl ObservationLog {
    pub(super) fn open(c: &OwnerConfig, started: Instant) -> Result<Self> {
        private_dir(&base(c), false)?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(base(c))
            .map_err(err)?;
        let raw = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                c"observations.jsonl".as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_APPEND
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if raw < 0 {
            return Err("observation log open refused".into());
        }
        let file = unsafe { File::from_raw_fd(raw) };
        let m = file.metadata().map_err(err)?;
        if !m.is_file()
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o7777 != 0o600
            || m.nlink() != 1
            || m.len() > OBSERVATION_MAX_BYTES
        {
            return Err("observation log shape refused".into());
        }
        if m.len() > 0 {
            let mut tail = 0u8;
            if unsafe {
                libc::pread(
                    file.as_raw_fd(),
                    (&mut tail as *mut u8).cast(),
                    1,
                    (m.len() - 1) as libc::off_t,
                )
            } != 1
                || tail != b'\n'
            {
                return Err("observation log incomplete append retained".into());
            }
        }
        let log = Self {
            file: Mutex::new(Some(ObservationFile {
                directory,
                file,
                parent: base(c),
                identity: (m.dev(), m.ino()),
                bytes: m.len(),
            })),
            notified: std::sync::atomic::AtomicBool::new(false),
            started,
        };
        log.current()?;
        Ok(log)
    }
    pub(super) fn unavailable(started: Instant) -> Self {
        Self {
            file: Mutex::new(None),
            notified: std::sync::atomic::AtomicBool::new(false),
            started,
        }
    }
    fn validate(file: &ObservationFile) -> Result<()> {
        let parent = fs::symlink_metadata(&file.parent).map_err(err)?;
        let anchored = file.directory.metadata().map_err(err)?;
        let named = fs::symlink_metadata(file.parent.join("observations.jsonl")).map_err(err)?;
        let held = file.file.metadata().map_err(err)?;
        if !parent.is_dir()
            || parent.uid() != unsafe { libc::geteuid() }
            || parent.mode() & 0o7777 != 0o700
            || (parent.dev(), parent.ino()) != (anchored.dev(), anchored.ino())
            || !named.is_file()
            || !held.is_file()
            || named.nlink() != 1
            || held.nlink() != 1
            || named.uid() != unsafe { libc::geteuid() }
            || held.uid() != unsafe { libc::geteuid() }
            || named.mode() & 0o7777 != 0o600
            || held.mode() & 0o7777 != 0o600
            || (named.dev(), named.ino()) != file.identity
            || (held.dev(), held.ino()) != file.identity
            || held.len() != file.bytes
            || named.len() != file.bytes
            || file.bytes > OBSERVATION_MAX_BYTES
        {
            return Err("observation log identity refused".into());
        }
        Ok(())
    }
    fn current(&self) -> Result<()> {
        let guard = self.file.lock().map_err(|_| "observation log poisoned")?;
        Self::validate(guard.as_ref().ok_or("observation log unavailable")?)
    }
    pub(super) fn append(&self, observation: &Observation<'_>) -> Result<()> {
        let mut guard = self.file.lock().map_err(|_| "observation log poisoned")?;
        let file = guard.as_mut().ok_or("observation log unavailable")?;
        Self::validate(file)?;
        // Sample under the append lock: cross-actor scheduling cannot reorder
        // timestamps within this host generation's append sequence.
        let elapsed_ms = u64::try_from(self.started.elapsed().as_millis())
            .map_err(|_| "observation clock range")?;
        let bytes = encoded(
            &serde_json::json!({"schema":"caws.render.owner.observation.v1","elapsedMs":elapsed_ms,"observation":observation}),
            OBSERVATION_MAX_RECORD,
        )?;
        if file.bytes + bytes.len() as u64 > OBSERVATION_MAX_BYTES {
            return Err("observation log capacity exhausted".into());
        }
        // A partial/failed append disables future appends instead of appending a
        // valid JSON record onto an uncertain partial record. No source is reset.
        if file
            .file
            .write_all(&bytes)
            .and_then(|_| file.file.sync_data())
            .is_err()
        {
            *guard = None;
            return Err("observation log append unavailable".into());
        }
        file.bytes += bytes.len() as u64;
        Self::validate(file)
    }
    pub(super) fn emit(&self, observation: Observation<'_>) {
        if self.append(&observation).is_err() && !self.notified.swap(true, Ordering::AcqRel) {
            eprintln!("renderer owner diagnostic log unavailable; service decisions unchanged");
        }
    }
}
pub(super) fn observation_reason(reason: &str) -> &'static str {
    // Never reflect raw error text: Git/tool/serde errors can contain caller data.
    if reason.contains("deadline") {
        "deadline_expired"
    } else if reason.contains("EOF") || reason.contains("closed") {
        "peer_closed"
    } else if reason.contains("capacity") {
        "capacity_exhausted"
    } else if reason.contains("unknown") || reason.contains("fence") {
        "unknown_fence"
    } else if reason.contains("differ") || reason.contains("mismatch") || reason.contains("changed")
    {
        "identity_or_source_changed"
    } else if reason.contains("private")
        || reason.contains("unsafe")
        || reason.contains("canonical")
    {
        "private_path_refused"
    } else if reason.contains("too large") || reason.contains("bound") || reason.contains("limit") {
        "bound_refused"
    } else {
        "operation_refused"
    }
}
pub(super) fn git_capture_failure(log: &ObservationLog, diagnostic: &str) {
    let reason = if diagnostic.starts_with("Git metadata query unavailable") {
        "metadata_query_unavailable"
    } else if diagnostic.starts_with("Git configuration changed") {
        "configuration_changed"
    } else if diagnostic.starts_with("Git metadata changed") {
        "metadata_changed"
    } else if diagnostic.starts_with("Git compatibility profile does not support") {
        "executable_configuration_refused"
    } else if diagnostic.contains("canonical") || diagnostic.contains("directory unavailable") {
        "path_refused"
    } else if diagnostic.contains("identity changed") {
        "tool_identity_changed"
    } else if diagnostic.contains("deadline") {
        "deadline_expired"
    } else if diagnostic.contains("limit")
        || diagnostic.contains("bounded")
        || diagnostic.contains("exceed")
    {
        "capture_bound_refused"
    } else if diagnostic.contains("symlink") || diagnostic.contains("special file") {
        "metadata_type_refused"
    } else if diagnostic.contains("(os error 2)") {
        "path_missing"
    } else if diagnostic.contains("(os error 13)") || diagnostic.contains("(os error 1)") {
        "path_permission_refused"
    } else if diagnostic.contains("encoding")
        || diagnostic.contains("framing")
        || diagnostic.contains("representation")
    {
        "representation_refused"
    } else if diagnostic.contains("already exists") {
        "destination_exists"
    } else {
        "capture_io_or_operation_unavailable"
    };
    let query = diagnostic.strip_prefix("Git metadata query unavailable (status ");
    let number = |prefix: &str| -> Option<i32> {
        let text = query?.strip_prefix(prefix)?;
        let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    let stderr_bytes = query
        .and_then(|text| text.split_once(", stderr bytes "))
        .and_then(|(_, text)| text.strip_suffix(')'))
        .and_then(|text| text.parse().ok());
    log.emit(Observation::GitCaptureRefused {
        reason,
        query_exit_code: number("exit status: "),
        query_signal: number("signal: "),
        stderr_bytes,
    });
}
pub(super) fn image_admission_failure(
    log: &ObservationLog,
    offer: &Offer,
    failure: &image::AdmissionError,
) {
    let kind = match failure.kind {
        image::ErrorKind::Invalid => "invalid",
        image::ErrorKind::UnsupportedProfile => "unsupported_profile",
        image::ErrorKind::UnsafePath => "unsafe_path",
        image::ErrorKind::Changed => "changed",
        image::ErrorKind::Deadline => "deadline",
        image::ErrorKind::Io => "io",
    };
    log.emit(Observation::ImageAdmissionRefused {
        invocation_id: &offer.invocation_id,
        canonical_project: &offer.expected_selection.canonical_project,
        image_key: &offer.prepared.image_key,
        operation: failure.operation(),
        kind,
    });
}
pub(super) fn prefix_disposition(
    log: &ObservationLog,
    offer: &Offer,
    disposition: &image::PrefixConcurrency,
) {
    let (mode, proof_profile, reason) = match disposition {
        image::PrefixConcurrency::Session(proof) => ("session", Some(proof.proof_profile()), None),
        image::PrefixConcurrency::Serial(reason) => (
            "serial",
            None,
            Some(match reason {
                image::SerialPrefixReason::LegacyHelper => "legacy_helper",
                image::SerialPrefixReason::UnreviewedPrefix => "unreviewed_prefix",
            }),
        ),
    };
    log.emit(Observation::PrefixDisposition {
        invocation_id: &offer.invocation_id,
        mode,
        proof_profile,
        reason,
    });
}
pub(super) fn prefix_file(path: &Path) -> Option<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
        || meta.len() > 65_536
    {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(512).read_to_end(&mut bytes).ok()?;
    Some(STANDARD.encode(bytes))
}
