//! Darwin own-ancestor representation comparison, not a containment authority.
//! Usage: cargo run --example process-comm-ancestor-compare -- --artifacts /absolute/fresh/root
//! No PID selector exists. Native capture has one 250ms whole-chain budget;
//! legacy comparison has a separate 3s whole-phase budget. No ps or artifact IO
//! is charged to native capture. This is a qualification mirror, not a call into
//! private NativeObserver or a performance distribution/production acceptance.
#[cfg(target_os = "macos")]
mod comparison {
    use caws_native::process_comm_macos::{self as native, ReadError};
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::{
        collections::HashSet,
        ffi::{OsStr, OsString},
        fs::{self, DirBuilder, File, OpenOptions},
        io::{self, Read, Write},
        os::{
            fd::AsRawFd,
            unix::{
                fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
                process::ExitStatusExt,
            },
        },
        path::{Component, Path, PathBuf},
        process::{Child, Command, ExitStatus, Stdio},
        thread,
        time::{Duration, Instant},
    };
    type Result<T> = std::result::Result<T, &'static str>;
    const NATIVE_BUDGET: Duration = Duration::from_millis(250);
    const LEGACY_BUDGET: Duration = Duration::from_secs(3);
    const CLEANUP_GRACE: Duration = Duration::from_millis(50);
    const MAX_DEPTH: usize = 16;
    const MAX_OBSERVATIONS: usize = MAX_DEPTH * 2 - 1;
    const PS_RAW_CAP: usize = native::COMM_LIMIT + 2; // One byte beyond the legacy output limit.

    fn micros(duration: Duration) -> u64 {
        duration.as_micros().min(u128::from(u64::MAX)) as u64
    }
    #[derive(Clone, Copy, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Timing {
        stage: &'static str,
        start_offset_us: u64,
        elapsed_us: u64,
        failure: Option<&'static str>,
    }
    fn timed<T>(
        stages: &mut Vec<Timing>,
        phase: Instant,
        stage: &'static str,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let started = Instant::now();
        let result = operation();
        stages.push(Timing {
            stage,
            start_offset_us: micros(started.saturating_duration_since(phase)),
            elapsed_us: micros(started.elapsed()),
            failure: result.as_ref().err().copied(),
        });
        result
    }
    fn checkpoint(expires: Instant, parent: u32) -> Result<()> {
        // Own metadata only. This mirror checks reparenting and deadlines but
        // does not install signal handlers or claim NativeObserver's complete
        // cancellation/output-channel behavior.
        if unsafe { libc::getppid() } as u32 != parent {
            return Err("own-parent-changed");
        }
        if Instant::now() >= expires {
            Err("phase-deadline")
        } else {
            Ok(())
        }
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity {
        pid: u32,
        parent: u32,
        start_seconds: u64,
        start_micros: u64,
    }
    fn identity(pid: u32) -> Result<Identity> {
        if pid <= 1 || pid > i32::MAX as u32 {
            return Err("invalid-chain-pid");
        }
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        // SAFETY: actual libc SDK structure, valid writable buffer and exact size.
        let count = unsafe {
            libc::proc_pidinfo(
                pid as libc::pid_t,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as i32,
            )
        };
        if count != size as i32 {
            return Err("birth-observation-unavailable");
        }
        // SAFETY: exact successful byte count initialized the entire structure.
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000 {
            return Err("invalid-birth-observation");
        }
        Ok(Identity {
            pid,
            parent: info.pbi_ppid,
            start_seconds: info.pbi_start_tvsec,
            start_micros: info.pbi_start_tvusec,
        })
    }
    #[derive(Clone, Copy, Serialize)]
    struct Exit {
        code: Option<i32>,
        signal: Option<i32>,
    }
    impl From<ExitStatus> for Exit {
        fn from(status: ExitStatus) -> Self {
            Self {
                code: status.code(),
                signal: status.signal(),
            }
        }
    }
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Cleanup {
        direct_child_reaped: bool,
        forced_cleanup_attempted: bool,
        kill_accepted: bool,
        wait_uncertain: bool,
        status: Option<Exit>,
        elapsed_us: u64,
    }
    struct OwnedPs {
        child: Child,
        status: Option<ExitStatus>,
        wait_uncertain: bool,
        cleanup_attempted: bool,
    }
    impl OwnedPs {
        fn poll(&mut self) -> Result<Option<ExitStatus>> {
            if self.status.is_some() {
                return Ok(self.status);
            }
            match self.child.try_wait() {
                Ok(status) => {
                    self.status = status;
                    Ok(status)
                }
                Err(_) => {
                    self.wait_uncertain = true;
                    Err("owned-ps-wait-failed")
                }
            }
        }
        fn wait_until(&mut self, expires: Instant) -> Result<Option<ExitStatus>> {
            loop {
                if let Some(status) = self.poll()? {
                    return Ok(Some(status));
                }
                if Instant::now() >= expires {
                    return Ok(None);
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
        fn cleanup(&mut self) -> Cleanup {
            self.cleanup_attempted = true;
            let started = Instant::now();
            let mut forced = false;
            let mut accepted = false;
            if self.status.is_none() && !self.wait_uncertain {
                let _ = self.wait_until(Instant::now() + CLEANUP_GRACE);
            }
            if self.status.is_none() && !self.wait_uncertain {
                // Only this newly spawned, direct, still-unreaped Child is owned.
                // No ancestor PID or process group can reach this branch.
                forced = true;
                accepted = self.child.kill().is_ok();
                let _ = self.wait_until(Instant::now() + CLEANUP_GRACE);
            }
            Cleanup {
                direct_child_reaped: self.status.is_some(),
                forced_cleanup_attempted: forced,
                kill_accepted: accepted,
                wait_uncertain: self.wait_uncertain,
                status: self.status.map(Into::into),
                elapsed_us: micros(started.elapsed()),
            }
        }
    }
    impl Drop for OwnedPs {
        fn drop(&mut self) {
            if !self.cleanup_attempted && self.status.is_none() && !self.wait_uncertain {
                let _ = self.cleanup();
            }
        }
    }
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Legacy {
        before_ps: Option<Identity>,
        after_ps: Option<Identity>,
        ps_status: Option<Exit>,
        ps_failure: Option<&'static str>,
        ps_raw_bytes: usize,
        cleanup: Option<Cleanup>,
        stages: Vec<Timing>,
        matched: bool,
        failure: Option<&'static str>,
        permission_entitlement_parity: &'static str,
        #[serde(skip)]
        raw: Vec<u8>,
    }
    impl Legacy {
        fn new() -> Self {
            Self {
                before_ps: None,
                after_ps: None,
                ps_status: None,
                ps_failure: None,
                ps_raw_bytes: 0,
                cleanup: None,
                stages: Vec::new(),
                matched: false,
                failure: None,
                permission_entitlement_parity: "not-established",
                raw: Vec::new(),
            }
        }
    }
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Observation {
        attempt: usize,
        capture_stage: &'static str,
        depth: usize,
        pid: u32,
        identity_source: &'static str,
        before_native: Option<Identity>,
        after_native: Option<Identity>,
        native_representation: Option<String>,
        native_error: Option<String>,
        native_raw_bytes: Option<usize>,
        stages: Vec<Timing>,
        failure: Option<&'static str>,
        legacy: Option<Legacy>,
        #[serde(skip)]
        raw: Option<Vec<u8>>,
    }
    fn observe(
        pid: u32,
        depth: usize,
        attempt: usize,
        stage: &'static str,
        phase: Instant,
        expires: Instant,
        parent: u32,
    ) -> Observation {
        let mut row = Observation {
            attempt,
            capture_stage: stage,
            depth,
            pid,
            identity_source: "libproc",
            before_native: None,
            after_native: None,
            native_representation: None,
            native_error: None,
            native_raw_bytes: None,
            stages: Vec::new(),
            failure: None,
            legacy: None,
            raw: None,
        };
        let checked = (|| -> Result<()> {
            timed(&mut row.stages, phase, "entry-checkpoint", || {
                checkpoint(expires, parent)
            })?;
            let before = timed(&mut row.stages, phase, "platform-birth", || identity(pid))?;
            row.before_native = Some(before);
            let mut raw = None;
            let mut representation = None;
            let mut native_error = None;
            let comm = timed(&mut row.stages, phase, "comm-lookup", || {
                checkpoint(expires, parent)?;
                let result = native::read(pid, expires);
                // Retain already-acquired bounded data even if the post-read
                // checkpoint withholds the result; it is never chain admission.
                match &result {
                    Ok(observation) => {
                        representation = Some(format!("{:?}", observation.representation()));
                        raw = Some(observation.comm_bytes().to_vec());
                    }
                    Err(error) => native_error = Some(format!("{error:?}")),
                }
                checkpoint(expires, parent)?;
                if let Err(error) = result {
                    return Err(if matches!(error, ReadError::Deadline) {
                        "native-comm-deadline"
                    } else {
                        "native-comm-unavailable"
                    });
                }
                let bytes = raw.as_deref().ok_or("native-comm-missing")?;
                if bytes.is_empty()
                    || bytes.len() > native::COMM_LIMIT
                    || bytes.contains(&0)
                    || std::str::from_utf8(bytes).is_err()
                {
                    return Err("native-comm-invalid");
                }
                Ok(())
            });
            row.native_representation = representation;
            row.native_error = native_error;
            row.native_raw_bytes = raw.as_ref().map(Vec::len);
            row.raw = raw;
            comm?;
            timed(&mut row.stages, phase, "after-comm-checkpoint", || {
                checkpoint(expires, parent)
            })?;
            let after = timed(&mut row.stages, phase, "final-instance-recheck", || {
                let after = identity(pid)?;
                checkpoint(expires, parent)?;
                Ok(after)
            })?;
            row.after_native = Some(after);
            if before != after {
                return Err("instance-changed-during-native-observation");
            }
            Ok(())
        })();
        row.failure = checked.err();
        row
    }
    fn same_observation(left: &Observation, right: &Observation) -> bool {
        left.failure.is_none()
            && right.failure.is_none()
            && left.before_native.is_some()
            && left.before_native == left.after_native
            && right.before_native == right.after_native
            && left.after_native == right.after_native
            && left.raw.is_some()
            && left.raw == right.raw
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NativePhase {
        budget_us: u64,
        start_offset_us: u64,
        elapsed_us: u64,
        native_pid: u32,
        initial_parent: u32,
        reached_pid1: bool,
        success: bool,
        failure: Option<&'static str>,
        observations: Vec<Observation>,
    }
    fn capture(program: Instant) -> NativePhase {
        let phase = Instant::now();
        let expires = phase + NATIVE_BUDGET;
        let native_pid = std::process::id();
        // SAFETY: getppid has no pointer arguments; no supplied PID is trusted.
        let parent = unsafe { libc::getppid() } as u32;
        let mut pid = parent;
        let mut rows = Vec::with_capacity(MAX_OBSERVATIONS);
        let mut accepted = Vec::<usize>::with_capacity(MAX_DEPTH);
        let mut visited = HashSet::with_capacity(MAX_DEPTH);
        let mut failure = None;
        for depth in 0..MAX_DEPTH {
            if pid == 1 {
                break;
            }
            if pid == 0 || pid == native_pid || !visited.insert(pid) {
                failure = Some("invalid-or-cyclic-own-chain");
                break;
            }
            let index = rows.len();
            let row = observe(pid, depth, index, "lookup", phase, expires, parent);
            let failed = row.failure;
            let next = row.after_native.map(|identity| identity.parent);
            rows.push(row);
            if failed.is_some() {
                failure = failed;
                break;
            }
            if let Some(&previous_index) = accepted.last() {
                let previous_pid = rows[previous_index].pid;
                let index = rows.len();
                let check = observe(
                    previous_pid,
                    depth - 1,
                    index,
                    "recheck",
                    phase,
                    expires,
                    parent,
                );
                let failed = check.failure;
                let equal = same_observation(&rows[previous_index], &check);
                rows.push(check);
                if failed.is_some() {
                    failure = failed;
                    break;
                }
                if !equal {
                    failure = Some("previous-edge-or-representation-changed");
                    break;
                }
            }
            accepted.push(index);
            pid = next.unwrap_or(0);
        }
        let reached_pid1 = pid == 1;
        if failure.is_none() && !reached_pid1 {
            failure = Some("own-chain-depth-limit");
        }
        if failure.is_none() && rows.is_empty() {
            failure = Some("no-ancestor-observations");
        }
        if failure.is_none() {
            failure = checkpoint(expires, parent).err();
        }
        let finished = Instant::now();
        if failure.is_none() && finished >= expires {
            failure = Some("phase-deadline");
        }
        NativePhase {
            budget_us: micros(NATIVE_BUDGET),
            start_offset_us: micros(phase.saturating_duration_since(program)),
            elapsed_us: micros(finished.saturating_duration_since(phase)),
            native_pid,
            initial_parent: parent,
            reached_pid1,
            success: failure.is_none(),
            failure,
            observations: rows,
        }
    }
    fn nonblocking(pipe: &impl AsRawFd) -> Result<()> {
        let fd = pipe.as_raw_fd();
        // SAFETY: borrowed live owned pipe descriptor.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            Err("ps-pipe-configuration-failed")
        } else {
            Ok(())
        }
    }
    fn read_ps(
        pid: u32,
        phase: Instant,
        expires: Instant,
        parent: u32,
        legacy: &mut Legacy,
    ) -> Result<()> {
        checkpoint(expires, parent)?;
        let mut command = Command::new("/bin/ps");
        command
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .env_clear()
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let child = timed(&mut legacy.stages, phase, "ps-spawn", || {
            command.spawn().map_err(|_| "ps-spawn-failed")
        })?;
        let mut owner = OwnedPs {
            child,
            status: None,
            wait_uncertain: false,
            cleanup_attempted: false,
        };
        let result = timed(&mut legacy.stages, phase, "ps-read-wait", || {
            checkpoint(expires, parent)?;
            let mut pipe = owner.child.stdout.take().ok_or("ps-output-pipe-missing")?;
            nonblocking(&pipe)?;
            let mut eof = false;
            loop {
                checkpoint(expires, parent)?;
                if !eof {
                    let mut block = [0u8; 4096];
                    let available = block.len().min(PS_RAW_CAP - legacy.raw.len());
                    match pipe.read(&mut block[..available]) {
                        Ok(0) => eof = true,
                        Ok(count) => {
                            legacy.raw.extend_from_slice(&block[..count]);
                            if legacy.raw.len() > native::COMM_LIMIT + 1 {
                                return Err("ps-output-size-limit");
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                            ) => {}
                        Err(_) => return Err("ps-output-read-failed"),
                    }
                }
                let status = owner.poll()?;
                if eof && let Some(status) = status {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err("ps-nonzero-exit")
                    };
                }
                thread::sleep(Duration::from_millis(1));
            }
        });
        let started = Instant::now();
        let cleanup = owner.cleanup();
        legacy.stages.push(Timing {
            stage: "ps-cleanup",
            start_offset_us: micros(started.saturating_duration_since(phase)),
            elapsed_us: micros(started.elapsed()),
            failure: if cleanup.direct_child_reaped
                && !cleanup.forced_cleanup_attempted
                && !cleanup.wait_uncertain
            {
                None
            } else {
                Some("owned-ps-cleanup-unconfirmed-or-forced")
            },
        });
        legacy.ps_status = owner.status.map(Into::into);
        legacy.ps_raw_bytes = legacy.raw.len();
        legacy.ps_failure = result.as_ref().err().copied();
        let cleanup_good = cleanup.direct_child_reaped
            && !cleanup.forced_cleanup_attempted
            && !cleanup.wait_uncertain;
        legacy.cleanup = Some(cleanup);
        if !cleanup_good {
            return Err("owned-ps-cleanup-unconfirmed-or-forced");
        }
        result
    }
    fn legacy_value(raw: &[u8], status: Option<Exit>) -> Result<&[u8]> {
        if !matches!(
            status,
            Some(Exit {
                code: Some(0),
                signal: None
            })
        ) {
            return Err("legacy-status-unavailable");
        }
        if raw.len() > native::COMM_LIMIT + 1 {
            return Err("legacy-output-size-limit");
        }
        let end = raw
            .iter()
            .rposition(|byte| *byte != b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        let bytes = &raw[..end];
        if bytes.is_empty()
            || bytes.len() > native::COMM_LIMIT
            || bytes.contains(&0)
            || std::str::from_utf8(bytes).is_err()
        {
            return Err("legacy-output-unavailable");
        }
        Ok(bytes)
    }
    fn compare(row: &Observation, phase: Instant, expires: Instant, parent: u32) -> Legacy {
        let mut legacy = Legacy::new();
        let checked = (|| -> Result<()> {
            timed(&mut legacy.stages, phase, "legacy-entry-checkpoint", || {
                checkpoint(expires, parent)
            })?;
            let before = timed(&mut legacy.stages, phase, "birth-before-ps", || {
                let before = identity(row.pid)?;
                checkpoint(expires, parent)?;
                Ok(before)
            })?;
            legacy.before_ps = Some(before);
            if Some(before) != row.before_native || row.before_native != row.after_native {
                legacy.permission_entitlement_parity = "not-established-instance-changed";
                return Err("instance-or-parent-changed-before-ps");
            }
            read_ps(row.pid, phase, expires, parent, &mut legacy)?;
            let after = timed(&mut legacy.stages, phase, "birth-after-ps", || {
                checkpoint(expires, parent)?;
                let after = identity(row.pid)?;
                checkpoint(expires, parent)?;
                Ok(after)
            })?;
            legacy.after_ps = Some(after);
            if after != before {
                legacy.permission_entitlement_parity = "not-established-instance-changed";
                return Err("instance-or-parent-changed-after-ps");
            }
            let ps = legacy_value(&legacy.raw, legacy.ps_status)?;
            if Some(ps) != row.raw.as_deref() {
                legacy.permission_entitlement_parity = "unresolved-difference";
                return Err("representation-mismatch-permission-or-mutation-cause-unresolved");
            }
            legacy.permission_entitlement_parity = "equal-for-this-observation";
            legacy.matched = true;
            Ok(())
        })();
        legacy.failure = checked.err();
        if legacy.failure.is_some() && legacy.permission_entitlement_parity == "not-established" {
            legacy.permission_entitlement_parity = "not-established-legacy-unavailable";
        }
        legacy
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyPhase {
        budget_us: u64,
        start_offset_us: Option<u64>,
        elapsed_us: Option<u64>,
        success: bool,
        skipped: bool,
        compared_observations: usize,
        failure: Option<&'static str>,
    }
    fn compare_phase(program: Instant, native: &mut NativePhase) -> LegacyPhase {
        if !native.success {
            return LegacyPhase {
                budget_us: micros(LEGACY_BUDGET),
                start_offset_us: None,
                elapsed_us: None,
                success: false,
                skipped: true,
                compared_observations: 0,
                failure: Some("native-phase-incomplete"),
            };
        }
        let phase = Instant::now();
        let expires = phase + LEGACY_BUDGET;
        let mut count = 0;
        let mut failure = None;
        for row in &mut native.observations {
            let legacy = compare(row, phase, expires, native.initial_parent);
            let matched = legacy.matched;
            let failed = legacy.failure;
            row.legacy = Some(legacy);
            count += 1;
            if !matched {
                failure = failed.or(Some("comparison-not-matched"));
                break;
            }
        }
        if failure.is_none() {
            failure = checkpoint(expires, native.initial_parent).err();
        }
        let finished = Instant::now();
        if failure.is_none() && finished >= expires {
            failure = Some("phase-deadline");
        }
        LegacyPhase {
            budget_us: micros(LEGACY_BUDGET),
            start_offset_us: Some(micros(phase.saturating_duration_since(program))),
            elapsed_us: Some(micros(finished.saturating_duration_since(phase))),
            success: failure.is_none(),
            skipped: false,
            compared_observations: count,
            failure,
        }
    }
    fn artifact_argument(args: &[OsString]) -> Result<PathBuf> {
        if args.len() != 2
            || args.first().map(OsString::as_os_str) != Some(OsStr::new("--artifacts"))
        {
            return Err("only-artifacts-absolute-path-is-supported");
        }
        let path = PathBuf::from(&args[1]);
        if !path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err("fresh-normal-absolute-artifact-path-required");
        }
        Ok(path)
    }
    fn private_dir(path: &Path) -> Result<()> {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| "fresh-private-directory-create-failed")?;
        let metadata = fs::symlink_metadata(path).map_err(|_| "private-directory-stat-failed")?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o700
        {
            return Err("private-directory-shape-unavailable");
        }
        Ok(())
    }
    fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| "artifact-create-failed")?;
        file.write_all(bytes).map_err(|_| "artifact-write-failed")?;
        file.sync_all().map_err(|_| "artifact-sync-failed")
    }
    fn receipt<T: Serialize>(directory: &Path, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "receipt-encoding-failed")?;
        write_new(&directory.join(".receipt.tmp"), &bytes)?;
        fs::rename(
            directory.join(".receipt.tmp"),
            directory.join("receipt.json"),
        )
        .map_err(|_| "receipt-publish-failed")?;
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "receipt-directory-sync-failed")
    }
    fn digest_file(path: &Path) -> Result<String> {
        let mut file = File::open(path).map_err(|_| "binary-read-failed")?;
        let mut hash = Sha256::new();
        let mut count = 0usize;
        loop {
            let mut block = [0u8; 65536];
            let read = file.read(&mut block).map_err(|_| "binary-read-failed")?;
            if read == 0 {
                break;
            }
            count += read;
            if count > 64 * 1024 * 1024 {
                return Err("binary-size-limit");
            }
            hash.update(&block[..read]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    pub fn run() -> Result<()> {
        let program = Instant::now();
        let root = artifact_argument(&std::env::args_os().skip(1).collect::<Vec<_>>())?;
        private_dir(&root)?;
        // All disk reads precede native capture. Source/binary digests bind the
        // qualification artifact; they do not grant project/process authority.
        let executable = std::env::current_exe().map_err(|_| "self-executable-unavailable")?;
        let executable_digest = digest_file(&executable)?;
        let ps_digest = digest_file(Path::new("/bin/ps"))?;
        let mut native = capture(program);
        let legacy = compare_phase(program, &mut native);
        let passed = native.success
            && legacy.success
            && !legacy.skipped
            && native.reached_pid1
            && legacy.compared_observations == native.observations.len();
        // Only bounded in-memory state is retained during both timed phases.
        // Every filesystem write occurs after their elapsed times were captured.
        for row in &native.observations {
            let directory = root.join(format!("observation-{:03}", row.attempt));
            private_dir(&directory)?;
            if let Some(raw) = &row.raw {
                write_new(&directory.join("native.comm.bin"), raw)?;
            }
            if let Some(legacy) = &row.legacy {
                write_new(&directory.join("ps.raw.bin"), &legacy.raw)?;
            }
            receipt(&directory, row)?;
        }
        receipt(
            &root,
            &serde_json::json!({
                "schema":"caws.own-ancestor-comm-comparison.v1", "status":if passed {"passed"} else {"failed"},
                "ownParentChainOnly":true,"arbitraryPidSelector":false,"identitySource":"libproc",
                "exampleBinarySha256":executable_digest,"psBinarySha256":ps_digest,
                "exampleSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("process-comm-ancestor-compare.rs"))),
                "readerSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/process_comm_macos.rs"))),
                "metadataBridgeSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/process_comm_macos.c"))),
                "maxDepth":MAX_DEPTH,"maxObservations":MAX_OBSERVATIONS,"pid1RepresentationRead":false,
                "nativePhase":native,"legacyPhase":legacy,
                "nativeBudgetExcludesPsAndArtifactIo":true,"legacyBudgetIsSeparateComparisonOnly":true,
                "performanceQualification":false,"wholeChainSamples":1,"producerIntegrationInvoked":false,
                "retainedCommByteBound":MAX_OBSERVATIONS*(native::COMM_LIMIT+PS_RAW_CAP),
                "readerArgumentAllocationLimit":native::MAX_PROCARGS_BYTES,
                "stageOffsetOrigins":{"observationStages":"nativePhase","legacyStages":"legacyPhase"},
                "ownedPsCleanupGraceUs":micros(CLEANUP_GRACE),"ownedPsForcedReapAttemptUs":micros(CLEANUP_GRACE),
                "limits":["qualification mirror; production cancellation/output-channel checks and request-quarter budgeting are not exercised",
                    "syscalls/spawn/wait cannot be interrupted or given a kernel-stall bound by these user-space deadlines",
                    "ps cleanup grace/reap attempts can extend beyond comparison expiry and forced cleanup invalidates the comparison",
                    "ps has separate entitlements; equal values do not prove equal permissions or all restricted-user contexts",
                    "fallback differences fail; errno/permission/entitlement versus mutable-argv cause remains unresolved",
                    "birth/edge snapshots do not form an atomic ancestry snapshot or establish logical-session ownership",
                    "one own-chain sample is not a performance distribution, containment effect or full runtime parity"]
            }),
        )?;
        if passed {
            Ok(())
        } else {
            Err("own-ancestor-comm-comparison-failed")
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn only_fresh_absolute_artifact_configuration_is_admitted() {
            let good = vec![
                OsString::from("--artifacts"),
                OsString::from("/owned/fresh"),
            ];
            assert_eq!(artifact_argument(&good), Ok(PathBuf::from("/owned/fresh")));
            for args in [
                vec![],
                vec!["--pid".into(), "44".into()],
                vec!["--artifacts".into(), "relative".into()],
                vec!["--artifacts".into(), "/owned/../other".into()],
                vec![
                    "--artifacts".into(),
                    "/owned/fresh".into(),
                    "--pid".into(),
                    "44".into(),
                ],
            ] {
                assert!(artifact_argument(&args).is_err());
            }
        }
        #[test]
        fn native_edge_recheck_requires_complete_same_instance_and_exact_comm() {
            let birth = Identity {
                pid: 44,
                parent: 55,
                start_seconds: 123,
                start_micros: 456,
            };
            let base = Observation {
                attempt: 0,
                capture_stage: "lookup",
                depth: 0,
                pid: 44,
                identity_source: "libproc",
                before_native: Some(birth),
                after_native: Some(birth),
                native_representation: Some("Argv0".into()),
                native_error: None,
                native_raw_bytes: Some(6),
                stages: Vec::new(),
                failure: None,
                legacy: None,
                raw: Some(b"/owned".to_vec()),
            };
            assert!(same_observation(&base, &base));
            for changed_birth in [
                Identity { pid: 45, ..birth },
                Identity {
                    parent: 56,
                    ..birth
                },
                Identity {
                    start_seconds: 124,
                    ..birth
                },
                Identity {
                    start_micros: 457,
                    ..birth
                },
            ] {
                let mut changed = base.clone();
                changed.before_native = Some(changed_birth);
                changed.after_native = Some(changed_birth);
                assert!(!same_observation(&base, &changed));
            }
            let mut changed = base.clone();
            changed.after_native = Some(Identity {
                parent: 56,
                ..birth
            });
            assert!(!same_observation(&base, &changed));
            let mut changed = base.clone();
            changed.before_native = None;
            assert!(!same_observation(&base, &changed));
            let mut changed = base.clone();
            changed.raw = Some(b"/foreign".to_vec());
            assert!(!same_observation(&base, &changed));
            let mut changed = base.clone();
            changed.raw = None;
            assert!(!same_observation(&base, &changed));
            let mut changed = base.clone();
            changed.failure = Some("native-comm-unavailable");
            assert!(!same_observation(&base, &changed));
        }
        #[test]
        fn legacy_decoder_is_strict_and_preserves_spaces_and_escaped_bytes() {
            let success = Some(Exit {
                code: Some(0),
                signal: None,
            });
            assert_eq!(
                legacy_value(b"/owned name\\011  \n\n", success),
                Ok(b"/owned name\\011  ".as_slice())
            );
            for bytes in [
                vec![],
                b"\n".to_vec(),
                b"x\0y\n".to_vec(),
                vec![0xff],
                vec![b'x'; native::COMM_LIMIT + 2],
            ] {
                assert!(legacy_value(&bytes, success).is_err());
            }
            for status in [
                None,
                Some(Exit {
                    code: Some(1),
                    signal: None,
                }),
                Some(Exit {
                    code: None,
                    signal: Some(15),
                }),
            ] {
                assert!(legacy_value(b"/owned/fixture\n", status).is_err());
            }
        }
    }
}
fn main() {
    #[cfg(target_os = "macos")]
    match comparison::run() {
        Ok(()) => println!("own-ancestor-comm-comparison-passed"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("macos-own-ancestor-comparison-only");
        std::process::exit(2);
    }
}
