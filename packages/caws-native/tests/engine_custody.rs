#![cfg(target_os = "macos")]
//! Explicit single-scenario external observation. Only the retained original
//! frontend Child authorizes a signal; observed PIDs never do.
use caws_native::owned_group::stop_before_reap;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::{
        fs::{FileExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        process::{CommandExt, ExitStatusExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
type Check<T> = Result<T, String>;
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRODUCED: &[u8] = b"custody fixture waiting before Ready\n";
fn io<T>(value: io::Result<T>) -> Check<T> {
    value.map_err(|e| e.to_string())
}
fn require(ok: bool, message: &str) -> Check<()> {
    if ok { Ok(()) } else { Err(message.into()) }
}
fn save(root: &Path, name: &str, value: &Value) -> Check<()> {
    io(fs::write(
        root.join(name),
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    ))
}
fn hash(path: &Path) -> Check<String> {
    Ok(format!("{:x}", Sha256::digest(io(fs::read(path))?)))
}
fn source_image(manifest: &Path) -> Check<Value> {
    let mut paths = vec![manifest.join("Cargo.toml"), manifest.join("build.rs")];
    if manifest.join("Cargo.lock").is_file() {
        paths.push(manifest.join("Cargo.lock"));
    }
    let mut pending = vec![manifest.join("src"), manifest.join("tests")];
    while let Some(dir) = pending.pop() {
        for entry in io(fs::read_dir(dir))? {
            let entry = io(entry)?;
            let kind = io(entry.file_type())?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                paths.push(entry.path());
            } else {
                return Err("non-regular native source entry".into());
            }
        }
    }
    paths.sort();
    let mut image = Vec::new();
    for path in paths {
        image.push(json!({"path":path.strip_prefix(manifest).map_err(|e|e.to_string())?, "sha256":hash(&path)?}));
    }
    Ok(json!(image))
}
fn node_path() -> Check<PathBuf> {
    if let Some(path) = std::env::var_os("CAWS_NATIVE_CUSTODY_NODE_PATH") {
        let path = PathBuf::from(path);
        require(path.is_absolute(), "Node path must be absolute")?;
        return io(path.canonicalize());
    }
    for parent in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if parent.join("node").is_file() {
            return io(parent.join("node").canonicalize());
        }
    }
    Err("actual Node executable unavailable".into())
}
fn private_directory(path: &Path) -> Check<()> {
    io(fs::create_dir(path))?;
    io(fs::set_permissions(path, fs::Permissions::from_mode(0o700)))
}
fn run_root(manifest: &Path) -> Check<PathBuf> {
    let base = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/qualification/engine-custody-live"));
    require(base.is_absolute(), "artifact root must be absolute")?;
    io(fs::create_dir_all(&base))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let root = base.join(format!("engine-custody-{}-{nonce}", std::process::id()));
    private_directory(&root)?;
    io(root.canonicalize())
}
#[derive(Debug)]
struct Process {
    pid: u32,
    ppid: u32,
    pgid: u32,
    state: String,
}
fn query(root: &Path, name: &str) -> Check<Vec<Process>> {
    let output = io(Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,pgid=,stat=,comm="])
        .output())?;
    io(fs::write(
        root.join(format!("{name}.stdout")),
        &output.stdout,
    ))?;
    io(fs::write(
        root.join(format!("{name}.stderr")),
        &output.stderr,
    ))?;
    save(
        root,
        &format!("{name}.status.json"),
        &json!({"command":["/bin/ps","-axo","pid=,ppid=,pgid=,stat=,comm="],"raw_status":output.status.into_raw(),"code":output.status.code()}),
    )?;
    require(output.status.success(), "ps failed; absence unknown")?;
    let text = std::str::from_utf8(&output.stdout).map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    let mut pids = BTreeSet::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split_whitespace().collect();
        require(fields.len() >= 5, "invalid ps row; absence unknown")?;
        let number = |i: usize| fields[i].parse::<u32>().map_err(|e| e.to_string());
        let row = Process {
            pid: number(0)?,
            ppid: number(1)?,
            pgid: number(2)?,
            state: fields[3].into(),
        };
        require(pids.insert(row.pid), "duplicate ps identity")?;
        rows.push(row);
    }
    Ok(rows)
}
fn live(row: &Process) -> bool {
    !row.state.starts_with('Z')
}
fn atomic_record(path: &Path) -> Check<Value> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match fs::read(path) {
            Ok(bytes) => return serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == io::ErrorKind::NotFound && Instant::now() < deadline => (),
            Err(e) => return Err(format!("atomic Node record unavailable: {e}")),
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn open_private(path: &Path) -> Check<File> {
    let file = io(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path))?;
    let meta = io(file.metadata())?;
    require(
        meta.is_file() && meta.uid() == unsafe { libc::geteuid() } && meta.nlink() == 1,
        "custody file ownership/type differs",
    )?;
    Ok(file)
}
struct Journal {
    file: File,
    prefix: Vec<u8>,
}
impl Journal {
    fn read(&mut self, root: &Path, id: &str, custodian: u32, node: u32) -> Check<Vec<Value>> {
        let length = io(self.file.metadata())?.len();
        require(length <= 1_048_576, "journal exceeds bound")?;
        let mut bytes = vec![0; length as usize];
        io(self.file.read_exact_at(&mut bytes, 0))?;
        require(bytes.starts_with(&self.prefix), "journal prefix changed")?;
        self.prefix = bytes;
        io(fs::write(root.join("cleanup.jsonl"), &self.prefix))?;
        let mut rows: Vec<Value> = Vec::new();
        for line in self.prefix.split_inclusive(|b| *b == b'\n') {
            if !line.ends_with(b"\n") {
                break;
            }
            let row: Value = serde_json::from_slice(line).map_err(|e| e.to_string())?;
            require(
                matches!(
                    row["state"].as_str(),
                    Some("started" | "pending" | "complete")
                ),
                "unknown custody state; stop scenario chain",
            )?;
            require(
                row["stdout_bytes"].as_u64().is_some()
                    && row["stderr_bytes"].as_u64().is_some()
                    && row["stdout_eof"].is_boolean()
                    && row["stderr_eof"].is_boolean()
                    && row["output_discarded"].is_boolean(),
                "invalid custody counters/EOF",
            )?;
            require(
                row["schema"] == "caws.engine.custody.receipt.v1"
                    && row["invocation_id"] == id
                    && row["runtime_digest"] == DIGEST
                    && row["custodian_pid"] == custodian
                    && row["node_pid"] == node
                    && row["sequence"] == rows.len() as u64 + 1,
                "journal identity/sequence differs",
            )?;
            require(
                row["error"].is_null()
                    && row["stop"].get("Err").is_none()
                    && row["settlement"].get("Err").is_none(),
                "cleanup failed/unknown; stop scenario chain",
            )?;
            if let Some(old) = rows.last() {
                require(old["state"] != "complete", "row after terminal receipt")?;
                require(
                    row["stdout_bytes"].as_u64() >= old["stdout_bytes"].as_u64()
                        && row["stderr_bytes"].as_u64() >= old["stderr_bytes"].as_u64()
                        && (old["stdout_eof"] != true || row["stdout_eof"] == true)
                        && (old["stderr_eof"] != true || row["stderr_eof"] == true)
                        && (old["output_discarded"] != true || row["output_discarded"] == true)
                        && (old["child_exit_raw"].is_null()
                            || old["child_exit_raw"] == row["child_exit_raw"]),
                    "custody state regressed",
                )?;
            }
            rows.push(row);
        }
        Ok(rows)
    }
}
fn discover(
    root: &Path,
    temp: &Path,
    frontend: u32,
    id: &str,
    node: &Path,
    engine: &Path,
) -> Check<Journal> {
    let mut seen = Vec::new();
    let mut found = Vec::new();
    for entry in io(fs::read_dir(temp))? {
        let path = io(entry)?.path();
        seen.push(path.clone());
        if !path.file_name().is_some_and(|n| {
            n.to_string_lossy()
                .starts_with(&format!("caws-engine-invocation-{frontend}-"))
        }) {
            continue;
        }
        let file = open_private(&path.join("configuration.json"))?;
        let meta = io(file.metadata())?;
        require(
            meta.mode() & 0o7777 == 0o400 && meta.len() <= 65_536,
            "unsafe configuration metadata",
        )?;
        let mut bytes = vec![0; meta.len() as usize];
        io(file.read_exact_at(&mut bytes, 0))?;
        let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if config["schema"] == "caws.engine.custody.configuration.v1"
            && config["invocation_id"] == id
            && config["runtime_digest"] == DIGEST
            && config["node"] == node.to_string_lossy().as_ref()
            && config["engine"] == engine.to_string_lossy().as_ref()
        {
            found.push((path, bytes));
        }
    }
    save(
        root,
        "directory-scan-diagnostic.json",
        &json!({"paths":seen,"signal_authority":false}),
    )?;
    require(
        found.len() == 1,
        "configuration correlation absent/ambiguous",
    )?;
    let (path, bytes) = found.remove(0);
    io(fs::write(root.join("configuration.json"), bytes))?;
    save(
        root,
        "custody-location-diagnostic.json",
        &json!({"path":path,"signal_authority":false}),
    )?;
    let file = open_private(&path.join("cleanup.jsonl"))?;
    require(
        io(file.metadata())?.mode() & 0o7777 == 0o600,
        "unsafe journal mode",
    )?;
    Ok(Journal {
        file,
        prefix: Vec::new(),
    })
}
struct Frontend {
    child: Child,
    root: PathBuf,
    attempted: bool,
    reaped: bool,
}
impl Frontend {
    fn stop(&mut self) -> Check<()> {
        require(
            !self.attempted && !self.reaped,
            "frontend stop already attempted",
        )?;
        self.attempted = true;
        let stopped = stop_before_reap(&self.child);
        let receipt = save(&self.root, "frontend-stop.json", &json!({"result":stopped}));
        stopped.map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = io(self.child.try_wait())? {
                self.reaped = true;
                save(
                    &self.root,
                    "frontend-exit.json",
                    &json!({"original_pid":self.child.id(),"raw_status":status.into_raw(),"signal":status.signal(),"code":status.code()}),
                )?;
                receipt?;
                return require(
                    status.signal() == Some(libc::SIGKILL),
                    "frontend death status differs",
                );
            }
            require(Instant::now() < deadline, "original frontend reap pending")?;
            thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Frontend {
    fn drop(&mut self) {
        if !self.reaped {
            let result = if self.attempted {
                Err("failed stop remains unresolved; no borrowed signal".to_string())
            } else {
                self.stop()
            };
            let _ = save(
                &self.root,
                "failure-teardown.json",
                &json!({"result":result,"proof":false,"cleanup_pending":!self.reaped}),
            );
        }
    }
}
#[test]
#[ignore = "deliberate actual-binary qualification; inspect candidate before execution"]
fn original_frontend_death_before_ready_settles_same_engine() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = run_root(&manifest).expect("private qualification root");
    eprintln!("engine custody qualification retained: {}", root.display());
    let result = (|| -> Check<()> {
        let binary = io(PathBuf::from(env!("CARGO_BIN_EXE_caws-native")).canonicalize())?;
        let engine = io(manifest
            .join("tests/fixtures/custody-engine.cjs")
            .canonicalize())?;
        let node = node_path()?;
        let image = source_image(&manifest)?;
        let binary_hash = hash(&binary)?;
        save(&root, "source-before.json", &image)?;
        save(
            &root,
            "executables.json",
            &json!({"frontend":{"path":binary,"sha256":binary_hash},"node":{"path":node,"sha256":hash(&node)?},"fixture":{"path":engine,"sha256":hash(&engine)?},"test":{"path":io(std::env::current_exe())?,"sha256":hash(&io(std::env::current_exe())?)?}}),
        )?;
        let temp = root.join("tmp");
        private_directory(&temp)?;
        io(fs::write(root.join("input.bin"), b"{}"))?;
        let mut command = Command::new(&binary);
        command
            .args(["invoke", "--engine"])
            .arg(&engine)
            .arg("--node")
            .arg(&node)
            .args([
                "--surface",
                "codex",
                "--event",
                "session_start",
                "--runtime-digest",
                DIGEST,
                "--timeout-ms",
                "120000",
                "--configuration",
                "system",
            ])
            .env_clear()
            .env("PATH", "")
            .env("TMPDIR", &temp)
            .env("CAWS_NATIVE_CUSTODY_RECORD", root.join("node-ready.json"))
            .stdin(Stdio::piped())
            .stdout(Stdio::from(io(File::create(root.join("frontend.stdout")))?))
            .stderr(Stdio::from(io(File::create(root.join("frontend.stderr")))?))
            .process_group(0);
        save(
            &root,
            "command.json",
            &json!({"program":binary,"args":command.get_args().map(|a|a.to_string_lossy().into_owned()).collect::<Vec<_>>(),"environment":command.get_envs().map(|(k,v)|(k.to_string_lossy().into_owned(),v.map(|v|v.to_string_lossy().into_owned()))).collect::<Vec<_>>(),"cwd":io(std::env::current_dir())?}),
        )?;
        let child = io(command.spawn())?;
        let mut frontend = Frontend {
            child,
            root: root.clone(),
            attempted: false,
            reaped: false,
        };
        let original = frontend.child.id();
        save(
            &root,
            "original-child.json",
            &json!({"pid":original,"signal_source":"retained original Child"}),
        )?;
        let mut stdin = frontend
            .child
            .stdin
            .take()
            .ok_or("missing frontend stdin")?;
        io(stdin.write_all(b"{}"))?;
        drop(stdin);
        io(fs::write(
            root.join("original-input-eof.marker"),
            b"original hook input closed before live observation\n",
        ))?;
        let record = atomic_record(&root.join("node-ready.json"))?;
        let pid = |key: &str| {
            record[key]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 1)
                .ok_or_else(|| format!("invalid {key}"))
        };
        let actual_node = pid("nodePid")?;
        let custodian = pid("parentPid")?;
        require(
            record["schema"] == "caws.custody.fixture.ready.v1"
                && pid("frontendPid")? == original
                && actual_node != custodian
                && custodian != original,
            "record topology differs",
        )?;
        let raw = record["rawRequest"].as_str().ok_or("missing raw request")?;
        io(fs::write(root.join("request.bin"), raw))?;
        let request: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let id = request["id"].as_str().ok_or("missing invocation id")?;
        require(
            request["caller"]["processId"] == original
                && request["runtimeDigest"] == DIGEST
                && id.starts_with(&format!("{original}-")),
            "request lost original caller",
        )?;
        let mut journal = discover(&root, &temp, original, id, &node, &engine)?;
        let before = query(&root, "before")?;
        for (pid, ppid, pgid) in [
            (original, std::process::id(), original),
            (custodian, original, custodian),
            (actual_node, custodian, actual_node),
        ] {
            require(
                before
                    .iter()
                    .any(|r| r.pid == pid && r.ppid == ppid && r.pgid == pgid && live(r)),
                "pre-stop live topology differs",
            )?;
        }
        let rows = journal.read(&root, id, custodian, actual_node)?;
        require(
            !rows.is_empty()
                && rows.iter().all(|r| {
                    r["state"] == "started"
                        && r["child_exit_raw"].is_null()
                        && r["stdout_eof"] == false
                        && r["stderr_eof"] == false
                }),
            "custody not alive before stop",
        )?;
        save(
            &root,
            "before.json",
            &json!({"frontend_pid":original,"custodian_pid":custodian,"node_pid":actual_node,"invocation_id":id,"runtime_digest":DIGEST}),
        )?;
        frontend.stop()?;
        let deadline = Instant::now() + Duration::from_secs(8);
        let terminal = loop {
            let rows = journal.read(&root, id, custodian, actual_node)?;
            if let Some(row) = rows.last().filter(|r| r["state"] == "complete") {
                break row.clone();
            }
            require(
                Instant::now() < deadline,
                "custody cleanup pending/unknown; stop scenario chain",
            )?;
            thread::sleep(Duration::from_millis(10));
        };
        let group = &terminal["settlement"]["Ok"]["Exited"]["observation"];
        require(
            terminal["reason"] == "frontend_gone"
                && terminal["stdout_eof"] == true
                && terminal["stderr_eof"] == true
                && terminal["stdout_bytes"] == 0
                && terminal["stderr_bytes"] == PRODUCED.len() as u64
                && terminal["stop"] == json!({"Ok":"Signalled"}),
            "terminal cleanup/EOF receipt differs",
        )?;
        let raw = terminal["child_exit_raw"]
            .as_i64()
            .and_then(|v| i32::try_from(v).ok())
            .ok_or("missing actual Node exit")?;
        require(
            std::process::ExitStatus::from_raw(raw).signal() == Some(libc::SIGKILL),
            "Node did not exit from owned SIGKILL",
        )?;
        require(
            group["reason"] == 0
                && group["query_errno"] == 0
                && group["members"].as_u64().is_some_and(|n| n > 0)
                && group["members"] == group["zombies"]
                && group["leaders"] == 1
                && group["bytes"]
                    .as_u64()
                    .is_some_and(|n| n > 0 && group["capacity"].as_u64().is_some_and(|c| n < c)),
            "strict complete SDK settlement absent",
        )?;
        require(journal.prefix.ends_with(b"\n"), "torn terminal record")?;
        require(
            io(fs::read(root.join("node-stderr-produced.bin")))? == PRODUCED
                && io(fs::read(root.join("node-stdout-produced.bin")))?.is_empty(),
            "producer mirror differs",
        )?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut sample = 0;
        loop {
            let rows = query(&root, &format!("after-{sample:03}"))?;
            if rows.iter().all(|r| {
                !(r.pid == custodian
                    || r.pid == actual_node
                    || [original, custodian, actual_node].contains(&r.pgid))
                    || !live(r)
            }) {
                save(
                    &root,
                    "observer-complete.json",
                    &json!({"group_no_running_members":true,"custodian_absent":!rows.iter().any(|r|r.pid==custodian),"node_absent":!rows.iter().any(|r|r.pid==actual_node),"terminal_output_discarded":terminal["output_discarded"],"custodian_exit_status":"unobserved_after_frontend_death","terminal_fsync":"not_independently_observed","ps_sample":sample}),
                )?;
                break;
            }
            require(
                Instant::now() < deadline,
                "terminal exists but independent processes remain live",
            )?;
            sample += 1;
            thread::sleep(Duration::from_millis(30));
        }
        let after = source_image(&manifest)?;
        save(&root, "source-after.json", &after)?;
        require(
            image == after && hash(&binary)? == binary_hash,
            "source/binary changed during qualification",
        )?;
        save(
            &root,
            "complete.json",
            &json!({"status":"bounded_custody_observed","frontend_original_child_reaped":frontend.reaped,"nonclaims":["custodian raw exit status/fsync completion after frontend death","custodian SIGKILL","escaped groups","renderer and descriptor leakage","exact proxy/consumer delivery from counts","source hashes as build attestation","runtime parity"],"ps_watchdog":"no hard subprocess timeout; query failure/hang cannot establish absence"}),
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = save(
            &root,
            "pending.json",
            &json!({"status":"failed_or_cleanup_unknown","error":error,"stop_scenario_chain":true}),
        );
        panic!(
            "custody qualification failed; retained {}: {error}",
            root.display()
        );
    }
}
