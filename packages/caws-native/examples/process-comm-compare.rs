//! Signal-free Darwin representation qualification for owned cooperative children.
//! Usage (root exports process_comm_macos before building):
//! cargo run --example process-comm-compare -- --artifacts /absolute/fresh/path \
//!     --node /absolute/node --python /absolute/python3
//! No PID selector exists. Production process_effect selection is unchanged.
#[cfg(target_os = "macos")]
mod comparison {
    use caws_native::process_comm_macos::{self as native, ReadError, Representation, Unavailable};
    use serde::Serialize;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::{
        ffi::{OsStr, OsString},
        fs::{self, DirBuilder, File, OpenOptions},
        io::{self, Read, Write},
        os::{
            fd::AsRawFd,
            unix::{
                ffi::OsStringExt,
                fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
                process::{CommandExt, ExitStatusExt},
            },
        },
        path::{Path, PathBuf},
        process::{Child, Command, ExitStatus, Stdio},
        thread,
        time::{Duration, Instant},
    };
    type Result<T> = std::result::Result<T, &'static str>;
    const WAIT: Duration = Duration::from_secs(3);
    const PS_BYTES: usize = 16_385;

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    enum IdentitySource {
        Libproc,
        KinfoProcZombie,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity {
        source: IdentitySource,
        pid: u32,
        parent: u32,
        start_seconds: u64,
        start_micros: u64,
    }
    fn identity(pid: u32, source: IdentitySource) -> Result<Identity> {
        match source {
            IdentitySource::Libproc => libproc_identity(pid),
            IdentitySource::KinfoProcZombie => zombie_kinfo_identity(pid),
        }
    }
    fn libproc_identity(pid: u32) -> Result<Identity> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        // SAFETY: exact real libc structure and checked successful byte count.
        let count = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as i32,
            )
        };
        if count != size as i32 {
            return Err("birth-observation-unavailable");
        }
        // SAFETY: the successful exact-length call initialized the structure.
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000 {
            return Err("invalid-birth-observation");
        }
        Ok(Identity {
            source: IdentitySource::Libproc,
            pid,
            parent: info.pbi_ppid,
            start_seconds: info.pbi_start_tvsec,
            start_micros: info.pbi_start_tvusec,
        })
    }
    fn zombie_kinfo_identity(pid: u32) -> Result<Identity> {
        let mut observed_pid = 0;
        let mut parent = 0;
        let mut start_seconds = 0;
        let mut start_micros = 0;
        // SAFETY: qualification-only SDK bridge receives writable primitives;
        // it validates exact returned size/PID, actual SZOMB, parent and timeval.
        // It exports no kinfo_proc layout or pointer to Rust.
        let status = unsafe {
            caws_comm_zombie_kinfo_identity(
                pid as libc::pid_t,
                &mut observed_pid,
                &mut parent,
                &mut start_seconds,
                &mut start_micros,
            )
        };
        if status != 0
            || observed_pid != pid
            || parent == 0
            || start_seconds == 0
            || start_micros >= 1_000_000
        {
            return Err("zombie-kinfo-identity-unavailable");
        }
        Ok(Identity {
            source: IdentitySource::KinfoProcZombie,
            pid: observed_pid,
            parent,
            start_seconds,
            start_micros,
        })
    }
    #[derive(Serialize)]
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
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Cleanup {
        direct_child_reaped: bool,
        graceful: bool,
        forced: bool,
        status: Option<Exit>,
    }
    struct Owned {
        child: Child,
        reaped: bool,
        wait_uncertain: bool,
        cleanup_attempted: bool,
    }
    impl Owned {
        fn spawn(command: &mut Command) -> Result<Self> {
            Ok(Self {
                child: command.spawn().map_err(|_| "fixture-spawn-failed")?,
                reaped: false,
                wait_uncertain: false,
                cleanup_attempted: false,
            })
        }
        fn reap_until(&mut self, expires: Instant) -> Result<Option<ExitStatus>> {
            loop {
                match self.child.try_wait() {
                    Ok(Some(status)) => {
                        self.reaped = true;
                        return Ok(Some(status));
                    }
                    Ok(None) => (),
                    Err(_) => {
                        self.wait_uncertain = true;
                        return Err("owned-child-wait-failed");
                    }
                }
                if Instant::now() >= expires {
                    return Ok(None);
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
        fn cleanup(&mut self) -> Cleanup {
            self.cleanup_attempted = true;
            // EOF is the ordinary fixture stop request. Never signal an asserted
            // PID; fallback Child::kill is only for this still-owned direct child
            // and makes the scenario fail even if a subsequent reap succeeds.
            drop(self.child.stdin.take());
            if let Ok(Some(status)) = self.reap_until(Instant::now() + WAIT) {
                return Cleanup {
                    direct_child_reaped: true,
                    graceful: status.success(),
                    forced: false,
                    status: Some(status.into()),
                };
            }
            let forced = !self.wait_uncertain && !self.reaped && self.child.kill().is_ok();
            let status = self.reap_until(Instant::now() + WAIT).ok().flatten();
            Cleanup {
                direct_child_reaped: self.reaped,
                graceful: false,
                forced,
                status: status.map(Into::into),
            }
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.reaped && !self.wait_uncertain && !self.cleanup_attempted {
                let _ = self.cleanup();
            }
        }
    }
    fn nonblocking(file: &impl AsRawFd) -> Result<()> {
        let fd = file.as_raw_fd();
        // SAFETY: fd is borrowed from a live pipe owned by this invocation.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            Err("pipe-configuration-failed")
        } else {
            Ok(())
        }
    }
    fn ready(child: &mut Owned) -> Result<()> {
        let pipe = child
            .child
            .stdout
            .as_mut()
            .ok_or("fixture-ready-pipe-missing")?;
        nonblocking(pipe)?;
        let expires = Instant::now() + WAIT;
        let mut got = Vec::new();
        loop {
            let mut byte = [0u8; 1];
            match pipe.read(&mut byte) {
                Ok(0) => return Err("fixture-exited-before-ready"),
                Ok(_) => {
                    got.push(byte[0]);
                    if got.ends_with(b"\n") {
                        return if got == b"ready\n" {
                            Ok(())
                        } else {
                            Err("invalid-fixture-ready")
                        };
                    }
                    if got.len() >= 16 {
                        return Err("invalid-fixture-ready");
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err("fixture-ready-read-failed"),
            }
            if Instant::now() >= expires {
                return Err("fixture-ready-deadline");
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
    fn private_dir(path: &Path) -> Result<()> {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| "private-directory-create-failed")
    }
    fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| "artifact-create-failed")?;
        out.write_all(bytes).map_err(|_| "artifact-write-failed")?;
        out.sync_all().map_err(|_| "artifact-sync-failed")
    }
    fn receipt(directory: &Path, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "receipt-encoding-failed")?;
        write_new(&directory.join(".receipt.tmp"), &bytes)?;
        fs::rename(
            directory.join(".receipt.tmp"),
            directory.join("receipt.json"),
        )
        .map_err(|_| "receipt-publication-failed")?;
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
    fn copied_fixture(source: &Path, path: &Path) -> Result<()> {
        let input = File::open(source).map_err(|_| "fixture-source-read-failed")?;
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| "fixture-copy-create-failed")?;
        io::copy(&mut input.take(64 * 1024 * 1024 + 1), &mut out)
            .map_err(|_| "fixture-copy-failed")?;
        if out
            .metadata()
            .map_err(|_| "fixture-copy-stat-failed")?
            .len()
            > 64 * 1024 * 1024
        {
            return Err("fixture-size-limit");
        }
        out.sync_all().map_err(|_| "fixture-copy-sync-failed")?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "fixture-permission-failed")
    }
    fn base(command: &mut Command) {
        command
            .env_clear()
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
    }
    fn native_command(executable: &Path, arg0: Option<OsString>, zombie: bool) -> Command {
        let mut command = Command::new(executable);
        if let Some(arg0) = arg0 {
            command.arg0(arg0);
        }
        command.arg(if zombie {
            "--comm-fixture=exit"
        } else {
            "--comm-fixture=wait"
        });
        base(&mut command);
        command
    }
    fn ps(pid: u32, directory: &Path) -> Result<(Vec<u8>, ExitStatus)> {
        let mut command = Command::new("/bin/ps");
        command.args(["-o", "comm=", "-p", &pid.to_string()]);
        base(&mut command);
        let mut owned = Owned::spawn(&mut command)?;
        drop(owned.child.stdin.take());
        let mut pipe = owned.child.stdout.take().ok_or("ps-output-pipe-missing")?;
        nonblocking(&pipe)?;
        let expires = Instant::now() + WAIT;
        let mut raw = Vec::new();
        let mut eof = false;
        let mut status = None;
        let outcome = loop {
            let mut block = [0u8; 4096];
            if !eof {
                match pipe.read(&mut block) {
                    Ok(0) => eof = true,
                    Ok(count) => {
                        raw.extend_from_slice(&block[..count]);
                        if raw.len() > PS_BYTES {
                            break Err("ps-output-size-limit");
                        }
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                        ) => {}
                    Err(_) => break Err("ps-output-read-failed"),
                }
            }
            if status.is_none() {
                match owned.child.try_wait() {
                    Ok(Some(found)) => {
                        status = Some(found);
                        owned.reaped = true;
                    }
                    Ok(None) => (),
                    Err(_) => {
                        owned.wait_uncertain = true;
                        break Err("ps-wait-failed");
                    }
                }
            }
            if eof && let Some(status) = status {
                break Ok(status);
            }
            if Instant::now() >= expires {
                break Err("ps-deadline");
            }
            thread::sleep(Duration::from_millis(1));
        };
        // Retain acquired bytes even when acquisition fails. No environment or
        // argv buffer is retained, only this controlled fixture's ps comm output.
        write_new(&directory.join("ps.raw.bin"), &raw)?;
        match outcome {
            Ok(status) => {
                write_new(
                    &directory.join("ps.status.json"),
                    &serde_json::to_vec(&Exit::from(status))
                        .map_err(|_| "ps-status-encoding-failed")?,
                )?;
                Ok((raw, status))
            }
            Err(error) => {
                let cleanup = owned.cleanup();
                write_new(
                    &directory.join("ps.failed-cleanup.json"),
                    &serde_json::to_vec(&cleanup).map_err(|_| "ps-status-encoding-failed")?,
                )?;
                Err(error)
            }
        }
    }
    fn legacy_value(raw: &[u8], status: ExitStatus) -> Option<&[u8]> {
        if !status.success() || raw.len() > native::COMM_LIMIT + 1 {
            return None;
        }
        let end = raw
            .iter()
            .rposition(|b| *b != b'\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let text = &raw[..end];
        if text.is_empty()
            || text.len() > native::COMM_LIMIT
            || text.contains(&0)
            || std::str::from_utf8(text).is_err()
        {
            None
        } else {
            Some(text)
        }
    }
    #[derive(Clone, Copy)]
    enum Expect {
        Equal,
        Oversize,
        Zombie,
    }
    impl Expect {
        fn name(self) -> &'static str {
            match self {
                Self::Equal => "equal",
                Self::Oversize => "size-rejection",
                Self::Zombie => "zombie",
            }
        }
    }
    fn scenario(
        root: &Path,
        name: &'static str,
        mut command: Command,
        expect: Expect,
        unlink_after_ready: Option<&Path>,
    ) -> Result<bool> {
        let directory = root.join(name);
        private_dir(&directory)?;
        let mut values = serde_json::Map::new();
        values.insert("scenario".into(), json!(name));
        values.insert("expected".into(), json!(expect.name()));
        // Select the identity API from the declared scenario, not from a failed
        // lookup. Live cases retain libproc; only the deliberately unreaped
        // zombie uses the SDK's zombie-capable KERN_PROC_PID representation.
        let identity_source = if matches!(expect, Expect::Zombie) {
            IdentitySource::KinfoProcZombie
        } else {
            IdentitySource::Libproc
        };
        values.insert("identitySource".into(), json!(identity_source));
        let mut owned = Owned::spawn(&mut command)?;
        let pid = owned.child.id();
        values.insert("ownedChildPid".into(), json!(pid));
        let checked = (|| -> Result<bool> {
            ready(&mut owned)?;
            if let Some(path) = unlink_after_ready {
                fs::remove_file(path).map_err(|_| "owned-executable-unlink-failed")?;
                values.insert("ownedExecutableUnlinked".into(), json!(true));
            }
            if matches!(expect, Expect::Zombie) {
                let expires = Instant::now() + WAIT;
                loop {
                    let observed =
                        native::read(pid, expires).map_err(|_| "zombie-observation-unavailable")?;
                    if observed.representation() == Representation::Zombie {
                        break;
                    }
                    if Instant::now() >= expires {
                        return Err("zombie-deadline");
                    }
                    thread::sleep(Duration::from_millis(1));
                }
            }
            let before_native = identity(pid, identity_source)?;
            values.insert("beforeNative".into(), json!(before_native));
            let observed = native::read(pid, Instant::now() + WAIT);
            match &observed {
                Ok(observation) => {
                    write_new(&directory.join("native.comm.bin"), observation.comm_bytes())?;
                    values.insert("nativeStatus".into(), json!("returned"));
                    values.insert(
                        "nativeRepresentation".into(),
                        json!(format!("{:?}", observation.representation())),
                    );
                }
                Err(error) => {
                    values.insert("nativeStatus".into(), json!("unavailable"));
                    values.insert("nativeError".into(), json!(format!("{error:?}")));
                }
            }
            let after_native = identity(pid, identity_source)?;
            values.insert("afterNative".into(), json!(after_native));
            let before_ps = identity(pid, identity_source)?;
            values.insert("beforePs".into(), json!(before_ps));
            let (raw, status) = ps(pid, &directory)?;
            let after_ps = identity(pid, identity_source)?;
            values.insert("afterPs".into(), json!(after_ps));
            if before_native.parent != std::process::id()
                || before_native != after_native
                || before_native != before_ps
                || before_native != after_ps
            {
                return Err("process-instance-or-parent-changed");
            }
            let legacy = legacy_value(&raw, status);
            Ok(match (expect, observed, legacy) {
                (
                    Expect::Oversize,
                    Err(ReadError::Unavailable(Unavailable::RenderedSizeLimit)),
                    None,
                ) => status.success(),
                (Expect::Zombie, Ok(observed), Some(legacy)) => {
                    observed.representation() == Representation::Zombie
                        && observed.comm_bytes() == b"<defunct>"
                        && observed.comm_bytes() == legacy
                }
                (Expect::Equal, Ok(observed), Some(legacy)) => observed.comm_bytes() == legacy,
                _ => false,
            })
        })();
        let cleanup = owned.cleanup();
        let cleanup_good = cleanup.direct_child_reaped && cleanup.graceful && !cleanup.forced;
        values.insert("cleanup".into(), json!(cleanup));
        let matched = checked.as_ref().copied().unwrap_or(false) && cleanup_good;
        values.insert("matched".into(), json!(matched));
        if let Err(error) = checked {
            values.insert("error".into(), json!(error));
        }
        receipt(&directory, &Value::Object(values))?;
        Ok(matched)
    }
    unsafe extern "C" {
        fn caws_comm_zombie_kinfo_identity(
            pid: libc::pid_t,
            observed_pid: *mut u32,
            parent: *mut u32,
            start_seconds: *mut u64,
            start_micros: *mut u64,
        ) -> libc::c_int;
        fn caws_comm_oracle_locale_is_c() -> libc::c_int;
        fn caws_comm_oracle_flags() -> u32;
        fn caws_comm_strvis_oracle(
            input: *const u8,
            input_length: libc::size_t,
            output: *mut u8,
            output_capacity: libc::size_t,
            output_length: *mut libc::size_t,
        ) -> libc::c_int;
    }
    fn formatter_oracle(root: &Path) -> Result<bool> {
        const MAX_INPUT: usize = 4097;
        const OUTPUT: usize = 4 * MAX_INPUT + 1;
        let directory = root.join("formatter-oracle");
        private_dir(&directory)?;
        // SAFETY: these qualification helpers only query locale and SDK flags.
        // Neither setlocale nor uselocale receives a mutating argument.
        let locale_is_c = unsafe { caws_comm_oracle_locale_is_c() } == 1;
        let flags = unsafe { caws_comm_oracle_flags() };
        if !locale_is_c || native::COMM_LIMIT + 1 != MAX_INPUT {
            receipt(
                &directory,
                &json!({"schema":"caws.comm-formatter-oracle.v1", "status":"failed",
                "globalCAndNoThreadOverride":locale_is_c, "sdkFlags":flags,
                "error":"C-locale-or-byte-bound-requirement-unsatisfied", "comparisons":[]}),
            )?;
            return Ok(false);
        }
        let mut cases = Vec::<(String, Vec<u8>)>::new();
        for byte in 1u8..=255 {
            cases.push((format!("byte-{byte:03}"), vec![byte]));
        }
        cases.push(("empty".into(), vec![]));
        cases.push(("all-non-nul-forward".into(), (1u8..=255).collect()));
        cases.push(("all-non-nul-reverse".into(), (1u8..=255).rev().collect()));
        cases.push((
            "mixed-controls".into(),
            b"before\tline\n\\\r\x1b\x7fafter".to_vec(),
        ));
        cases.push((
            "mixed-high-bit".into(),
            b"ascii\x80\x89\xa0\xa1\xc3\xa9\xffend".to_vec(),
        ));
        cases.push((
            "ascii-graphics-repeated".into(),
            (32u8..=126).cycle().take(3800).collect(),
        ));
        for length in [4095, 4096, 4097] {
            cases.push((format!("literal-boundary-{length}"), vec![b'x'; length]));
        }
        for (label, byte) in [("tab", b'\t'), ("newline", b'\n'), ("high-space", 0xa0)] {
            for length in [1023, 1024, 1025] {
                cases.push((format!("{label}-boundary-{length}"), vec![byte; length]));
            }
        }
        let mut state = 0x6d2b_79f5u32;
        for length in [2, 3, 7, 31, 255, 1023, 2047, 4095, 4096, 4097] {
            let bytes = (0..length)
                .map(|_| {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    ((state >> 16) % 255 + 1) as u8
                })
                .collect();
            cases.push((format!("seeded-sequence-{length}"), bytes));
        }
        let expected = 283usize;
        if cases.len() != expected {
            receipt(
                &directory,
                &json!({"schema":"caws.comm-formatter-oracle.v1", "status":"failed",
                "error":"formatter-fixture-case-count-mismatch", "expectedComparisonCount":expected,
                "constructedCaseCount":cases.len(), "comparisons":[]}),
            )?;
            return Ok(false);
        }
        let mut inputs = Vec::new();
        let mut system_bytes = Vec::new();
        let mut rust_bytes = Vec::new();
        let mut comparisons = Vec::new();
        let mut passed = true;
        for (name, input) in cases {
            let input_offset = inputs.len();
            inputs.extend_from_slice(&input);
            let mut output = [0u8; OUTPUT];
            let mut length = 0usize;
            // SAFETY: bounded non-NUL fixture input, fixed documented-maximum
            // destination, primitive checked outputs; oracle checks locale again.
            let status = unsafe {
                caws_comm_strvis_oracle(
                    input.as_ptr(),
                    input.len(),
                    output.as_mut_ptr(),
                    output.len(),
                    &mut length,
                )
            };
            let valid_system = status == 0
                && length < output.len()
                && output[length] == 0
                && !output[..length].contains(&0);
            let system = if valid_system {
                Some(&output[..length])
            } else {
                None
            };
            let rust = native::format_c_locale(&input);
            let matched = match (&rust, system) {
                (Ok(bytes), Some(system)) if system.len() <= native::COMM_LIMIT => bytes == system,
                (Err(ReadError::Unavailable(Unavailable::RenderedSizeLimit)), Some(system)) => {
                    system.len() > native::COMM_LIMIT
                }
                _ => false,
            };
            let system_offset = system_bytes.len();
            if let Some(bytes) = system {
                system_bytes.extend_from_slice(bytes);
            }
            let rust_offset = rust_bytes.len();
            let (rust_length, rust_error) = match &rust {
                Ok(bytes) => {
                    rust_bytes.extend_from_slice(bytes);
                    (bytes.len(), None)
                }
                Err(error) => (0, Some(format!("{error:?}"))),
            };
            comparisons.push(json!({"case":name, "matched":matched,
                "input":{"offset":input_offset,"length":input.len()},
                "system":{"status":status,"valid":valid_system,"offset":system_offset,
                    "length":system.map(|s|s.len()).unwrap_or(0),"reportedLength":length},
                "rust":{"offset":rust_offset,"length":rust_length,"error":rust_error}}));
            if !matched {
                passed = false;
                break;
            }
        }
        write_new(&directory.join("inputs.raw.bin"), &inputs)?;
        write_new(&directory.join("system.raw.bin"), &system_bytes)?;
        write_new(&directory.join("rust.raw.bin"), &rust_bytes)?;
        receipt(
            &directory,
            &json!({"schema":"caws.comm-formatter-oracle.v1",
            "status":if passed {"passed"} else {"failed"},
            "globalCAndNoThreadOverride":true,"sdkFlags":flags,
            "expectedComparisonCount":expected,"observedComparisonCount":comparisons.len(),
            "maxInputBytes":MAX_INPUT,"systemOutputCapacity":OUTPUT,"renderedByteLimit":native::COMM_LIMIT,
            "oracle":"actual-System-strvis-with-SDK-flags", "localeMutation":false,
            "comparisons":comparisons,
            "limits":["does not qualify process argument acquisition or permissions", "no physical/kernel fault simulation"]}),
        )?;
        Ok(passed)
    }
    fn flag(args: &[OsString], at: usize, expected: &str) -> Result<PathBuf> {
        if args.get(at).map(OsString::as_os_str) != Some(OsStr::new(expected)) {
            return Err("expected-artifacts-node-python-flags");
        }
        let path = PathBuf::from(args.get(at + 1).ok_or("missing-absolute-path")?);
        if !path.is_absolute() {
            return Err("absolute-path-required");
        }
        Ok(path)
    }
    pub fn run() -> Result<()> {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        if args.len() != 6 {
            return Err("expected-artifacts-node-python-flags");
        }
        let root = flag(&args, 0, "--artifacts")?;
        let node = flag(&args, 2, "--node")?;
        let python = flag(&args, 4, "--python")?;
        private_dir(&root)?; // Existing roots are refused; artifacts never overwrite.
        let self_exe = std::env::current_exe().map_err(|_| "self-executable-unavailable")?;
        let binary_hash = digest_file(&self_exe)?;
        if !formatter_oracle(&root)? {
            receipt(
                &root,
                &json!({"schema":"caws.process-comm-comparison.v1", "status":"failed",
                "stage":"formatter-oracle", "formatterOracle":"formatter-oracle/receipt.json",
                "exampleBinarySha256":binary_hash, "productionSelectionChanged":false, "scenarios":[]}),
            )?;
            return Err("formatter-oracle-failed");
        }
        let executable = root.join("owned fixture with spaces");
        copied_fixture(&self_exe, &executable)?;
        let deleted = root.join("owned deleted fixture");
        copied_fixture(&self_exe, &deleted)?;
        let mut cases = vec![
            (
                "native-path-spaces",
                native_command(&executable, None, false),
                Expect::Equal,
                false,
            ),
            (
                "native-custom-argv0",
                native_command(&executable, Some("owned-alias".into()), false),
                Expect::Equal,
                false,
            ),
            (
                "native-relative-argv0",
                native_command(&executable, Some("./owned-relative-name".into()), false),
                Expect::Equal,
                false,
            ),
            (
                "native-whitespace",
                native_command(&executable, Some("  owned fixture  ".into()), false),
                Expect::Equal,
                false,
            ),
            (
                "native-byte-escaping",
                native_command(
                    &executable,
                    Some(OsString::from_vec(
                        b"owned\tline\n\\\r\x7f\xc3\xa9\xa0".to_vec(),
                    )),
                    false,
                ),
                Expect::Equal,
                false,
            ),
            (
                "native-empty-argv0",
                native_command(&executable, Some(OsString::new()), false),
                Expect::Equal,
                false,
            ),
            (
                "native-limit",
                native_command(
                    &executable,
                    Some("x".repeat(native::COMM_LIMIT).into()),
                    false,
                ),
                Expect::Equal,
                false,
            ),
            (
                "native-over-limit",
                native_command(
                    &executable,
                    Some("x".repeat(native::COMM_LIMIT + 1).into()),
                    false,
                ),
                Expect::Oversize,
                false,
            ),
            (
                "native-deleted-executable",
                native_command(&deleted, None, false),
                Expect::Equal,
                true,
            ),
            (
                "native-zombie",
                native_command(&executable, None, true),
                Expect::Zombie,
                false,
            ),
        ];
        let mut shell = Command::new("/bin/bash");
        shell.args(["-c", "printf 'ready\\n'; IFS= read -r line; exit 0"]);
        base(&mut shell);
        cases.push(("shell", shell, Expect::Equal, false));
        let node_script = root.join("owned node script.js");
        write_new(&node_script, b"process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n")?;
        let python_script = root.join("owned python script.py");
        write_new(
            &python_script,
            b"import sys; print('ready', flush=True); sys.stdin.buffer.read(1)\n",
        )?;
        let mut node_command = Command::new(&node);
        node_command.arg(&node_script);
        base(&mut node_command);
        cases.push((
            "node-interpreter-script",
            node_command,
            Expect::Equal,
            false,
        ));
        let mut titled_node = Command::new(&node);
        titled_node.args(["-e", "process.title='owned node title'; process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"]);
        base(&mut titled_node);
        cases.push(("node-mutated-title", titled_node, Expect::Equal, false));
        let mut python_command = Command::new(&python);
        python_command.arg(&python_script);
        base(&mut python_command);
        cases.push((
            "python-interpreter-script",
            python_command,
            Expect::Equal,
            false,
        ));
        let expected_scenario_count = cases.len();
        let mut outcomes = Vec::new();
        let mut failed = false;
        for (name, command, expected, unlink) in cases {
            match scenario(
                &root,
                name,
                command,
                expected,
                unlink.then_some(deleted.as_path()),
            ) {
                Ok(matched) => {
                    outcomes.push(json!({"scenario":name,"matched":matched}));
                    if !matched {
                        failed = true;
                        break;
                    }
                }
                Err(error) => {
                    outcomes.push(json!({"scenario":name,"matched":false,"error":error}));
                    failed = true;
                    break;
                }
            }
        }
        receipt(
            &root,
            &json!({
                "schema":"caws.process-comm-comparison.v1", "status":if failed {"failed"} else {"passed"},
                "exampleBinarySha256":binary_hash, "psBinarySha256":digest_file(Path::new("/bin/ps"))?,
                "formatterOracle":"formatter-oracle/receipt.json", "formatterOracleMatched":true,
                "oracleSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("process-comm-vis-oracle.c"))),
                "candidateSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/process_comm_macos.rs"))),
                "bridgeSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/process_comm_macos.c"))),
                "locale":"C", "productionSelectionChanged":false, "controlledOwnedChildrenOnly":true,
                "commLimit":native::COMM_LIMIT,"argumentAllocationLimit":native::MAX_PROCARGS_BYTES,
                "expectedScenarioCount":expected_scenario_count, "scenarios":outcomes,
                "unexercised":["argument-permission denial and different-credential targets", "restricted target entitlement equivalence",
                    "whole ancestor-chain timing and cancellation", "target identity/effect safety", "Linux representation parity"],
                "limits":["ps is a separately entitled executable; parity applies only to exercised owned children",
                    "kernel calls cannot be interrupted by user-space deadlines", "Child cleanup fallback invalidates a scenario"]
            }),
        )?;
        if failed {
            Err("comm-comparison-failed")
        } else {
            Ok(())
        }
    }
}

fn fixture(exit_after_ready: bool) -> std::io::Result<()> {
    use std::io::{Read, Write};
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(b"ready\n")?;
    stdout.flush()?;
    drop(stdout);
    if !exit_after_ready {
        let mut byte = [0u8; 1];
        let _ = std::io::stdin().read(&mut byte)?;
    }
    Ok(())
}
fn main() {
    let mode = std::env::args_os().nth(1);
    if mode.as_deref() == Some(std::ffi::OsStr::new("--comm-fixture=wait"))
        || mode.as_deref() == Some(std::ffi::OsStr::new("--comm-fixture=exit"))
    {
        let exit_after_ready = mode.as_deref() == Some(std::ffi::OsStr::new("--comm-fixture=exit"));
        std::process::exit(if fixture(exit_after_ready).is_ok() {
            0
        } else {
            1
        });
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = comparison::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("macos-comparison-only");
        std::process::exit(2);
    }
}
