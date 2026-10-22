use super::*;
use caws_native::render_owner::{self, OwnerConfig, OwnerLimits, StoreStatusQuery};
use std::process::Child;

struct ResidentOwner {
    config: OwnerConfig,
    engine: PathBuf,
    child: Child,
}
impl ResidentOwner {
    fn start(fixture: &Fixture) -> Self {
        let home = fixture.dir.join("budget-home").canonicalize().unwrap();
        fs::create_dir(home.join("state")).unwrap();
        let package = fixture.dir.join("runtime-package");
        let client_root = package.join("dist/runtime");
        let template_root = package.join("templates/hook-packs/runtime/service-image");
        let client_shell_source =
            package.join("templates/hook-packs/shared/lib/session-render-service-client.sh");
        fs::create_dir_all(&client_root).unwrap();
        fs::create_dir_all(&template_root).unwrap();
        fs::create_dir_all(client_shell_source.parent().unwrap()).unwrap();
        fs::write(&client_shell_source, b"# isolated store fixture source\n").unwrap();
        let engine = client_root.join("store-engine.cjs");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/store-engine.cjs"
            ),
            &engine,
        )
        .unwrap();
        let config = OwnerConfig {
            schema: "caws.render.owner.config.v1".into(),
            home,
            client_root: client_root.canonicalize().unwrap(),
            template_root: template_root.canonicalize().unwrap(),
            client_shell_source: client_shell_source.canonicalize().unwrap(),
            native_executable: PathBuf::from(env!("CARGO_BIN_EXE_caws-native"))
                .canonicalize()
                .unwrap(),
            limits: OwnerLimits {
                max_connections: 4,
                max_projects: 2,
                max_backends: 1,
                max_queue_per_project: 2,
                max_frame_bytes: 2_097_152,
                max_retained_records: 2,
                first_frame_ms: 1000,
                request_ms: 5000,
                startup_ms: 1000,
                idle_ms: 100,
                backend_idle_seconds: 30,
                cache_megabytes: 1,
                worker: caws_native::renderer_backend::WorkerLimits {
                    startup_ms: 1000,
                    connect_ms: 1000,
                    write_ms: 1000,
                    render_ms: 1000,
                    read_ms: 1000,
                    cleanup_ms: 1000,
                },
            },
        };
        render_owner::provision(&config, Instant::now() + Duration::from_secs(3)).unwrap();
        let stderr = fs::File::create(fixture.dir.join("resident-owner.stderr")).unwrap();
        let child = Command::new(&config.native_executable)
            .arg("renderer-host")
            .arg("--config")
            .arg(render_owner::config_path(&config))
            .env_clear()
            .env("HOME", &config.home)
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .unwrap();
        let mut owner = Self {
            config,
            engine,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let query = StoreStatusQuery::new("absent".into(), "a".repeat(64), "0".repeat(64));
            if let Ok(status) = render_owner::store_status(
                &owner.config,
                &query,
                Instant::now() + Duration::from_millis(100),
            ) {
                assert!(!status.present);
                break;
            }
            assert!(Instant::now() < deadline, "owner startup deadline");
            assert!(owner.child.try_wait().unwrap().is_none(), "owner exited");
            thread::sleep(Duration::from_millis(5));
        }
        owner
    }
    fn registrations(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(
            self.config
                .home
                .join("state/render-service/observations.jsonl"),
        )
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| value["event"] == "store_registered")
        .collect()
    }
}
impl Drop for ResidentOwner {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn store_actor_survives_frontend_death_and_reports_actual_retained_sql_settlement() {
    use base64::Engine as _;
    let cli = std::env::var_os("CAWS_NATIVE_STORE_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../caws-cli")));
    assert!(
        cli.join("dist/runtime/transcript-store-client.js")
            .is_file()
    );
    let fixture = Fixture::new();
    let initialized = Command::new("/usr/bin/git")
        .args(["init", "--quiet"])
        .arg(&fixture.dir)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap();
    assert!(initialized.status.success(), "{initialized:?}");
    let root = fixture.dir.canonicalize().unwrap();
    let database = root.join("source.sqlite");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TABLE message(id,session_id,time_created,data);CREATE TABLE part(id,message_id,time_created,data);INSERT INTO message VALUES('m','s',0,'{}');INSERT INTO part VALUES('p','m',0,'{}');").unwrap();
    connection.close().unwrap();
    let before = fs::read(&database).unwrap();
    let mut owner = ResidentOwner::start(&fixture);
    let trace = root.join("store-trace.jsonl");
    let mut frontend = Command::new(env!("CARGO_BIN_EXE_caws-native"))
        .args([
            "invoke",
            "--engine",
            owner.engine.to_str().unwrap(),
            "--node",
            &fixture.node,
            "--surface",
            "opencode",
            "--event",
            "stop",
            "--runtime-digest",
            &"a".repeat(64),
            "--timeout-ms",
            "5000",
            "--configuration",
            "system",
        ])
        .current_dir(&root)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("CAWS_HOME", &owner.config.home)
        .env("CAWS_TRANSCRIPT_DATABASE", &database)
        .env("CAWS_NATIVE_STORE_CLI", &cli)
        .env("CAWS_NATIVE_STORE_ROOT", &root)
        .env("CAWS_NATIVE_STORE_BUDGET", &owner.config.home)
        .env("CAWS_NATIVE_STORE_TRACE", &trace)
        .env("CAWS_NATIVE_STORE_HOLD_ROW_MS", "2000")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    frontend
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&serde_json::json!({"session_id":"s","cwd":root})).unwrap())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let rows = fs::read_to_string(&trace)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|v| v["direction"] == "native_to_engine")
            .filter_map(|v| {
                base64::engine::general_purpose::STANDARD
                    .decode(v["base64"].as_str()?)
                    .ok()
            })
            .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .filter(|v| v["schema"] == caws_native::transcript_store_wire::ROW_SCHEMA)
            .count();
        if rows == 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "real SQL row did not reach frontend/engine"
        );
        assert!(
            frontend.try_wait().unwrap().is_none(),
            "frontend exited before row"
        );
        thread::sleep(Duration::from_millis(5));
    }
    frontend.kill().unwrap();
    let output = frontend.wait_with_output().unwrap();
    assert_eq!(output.status.signal(), Some(libc::SIGKILL));
    let registrations = owner.registrations();
    assert_eq!(registrations.len(), 1);
    let registration = &registrations[0];
    let query = StoreStatusQuery::new(
        registration["invocationId"].as_str().unwrap().into(),
        "a".repeat(64),
        registration["registration"].as_str().unwrap().into(),
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    let retained = loop {
        let status = render_owner::store_status(
            &owner.config,
            &query,
            Instant::now() + Duration::from_millis(500),
        )
        .unwrap();
        assert!(
            status.present,
            "actual Actor record missing after frontend death"
        );
        if status.phase == "settled" {
            break status.completion.unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "request-owned disconnect failed to settle SQL"
        );
        thread::sleep(Duration::from_millis(5));
    };
    assert!(retained.original_project_bound);
    assert_eq!(retained.error.as_deref(), Some("Exchange"));
    let acquisition = retained.acquisition.as_ref().unwrap();
    assert_eq!(acquisition.rows_copied, 1);
    assert_eq!(acquisition.rows_delivered, 0);
    assert_eq!(acquisition.first_failure.as_deref(), Some("transport"));
    assert_eq!(acquisition.close, "succeeded");
    assert!(!acquisition.retained_handle);
    assert!(!acquisition.retained_uncertain);
    thread::sleep(Duration::from_millis(250));
    assert!(
        owner.child.try_wait().unwrap().is_none(),
        "retained records must pin owner beyond idle limit"
    );
    assert!(
        render_owner::store_status(
            &owner.config,
            &query,
            Instant::now() + Duration::from_secs(1)
        )
        .unwrap()
        .present
    );
    let records: Vec<serde_json::Value> = fs::read_to_string(
        owner
            .config
            .home
            .join("state/render-service/observations.jsonl"),
    )
    .unwrap()
    .lines()
    .map(|line| serde_json::from_str(line).unwrap())
    .collect();
    assert_eq!(
        records
            .iter()
            .filter(|v| v["event"] == "actor_stage" && v["stage"] == "store_acquisition_start")
            .count(),
        1,
        "no SQL replay"
    );
    assert_eq!(
        records
            .iter()
            .filter(|v| v["event"] == "actor_stage" && v["stage"] == "store_settlement_retained")
            .count(),
        1
    );
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch("BEGIN EXCLUSIVE;ROLLBACK")
        .unwrap();
    connection.close().unwrap();
    assert_eq!(fs::read(&database).unwrap(), before);
    println!(
        "frontend killed; resident pid={}; actual retained status={retained:?}; source bytes unchanged",
        owner.child.id()
    );
}

#[test]
fn store_settlement_survives_late_engine_failure_on_both_store_profiles() {
    use base64::Engine as _;
    let cli = std::env::var_os("CAWS_NATIVE_STORE_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../caws-cli")));
    assert!(
        cli.join("dist/runtime/transcript-store-client.js")
            .is_file(),
        "build the actual typed store consumer or set CAWS_NATIVE_STORE_CLI"
    );
    for surface in ["opencode", "zcode"] {
        for (kind, end, failed, delivered) in [
            ("valid", "Exhausted", false, 1),
            ("invalid-json", "Stopped", false, 1),
            ("invalid-utf8", "Failed", true, 0),
        ] {
            let fixture = Fixture::new();
            let initialized = Command::new("/usr/bin/git")
                .args(["init", "--quiet"])
                .arg(&fixture.dir)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .output()
                .unwrap();
            assert!(initialized.status.success(), "{initialized:?}");
            let root = fixture.dir.canonicalize().unwrap();
            let database = root.join("source.sqlite");
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection.execute_batch("CREATE TABLE message(id,session_id,time_created,data);CREATE TABLE part(id,message_id,time_created,data);INSERT INTO message VALUES('m','s',0,'{}');INSERT INTO part VALUES('p','m',0,'{}');").unwrap();
            match kind {
                "invalid-json" => {
                    connection
                        .execute("UPDATE part SET data=?1", ["{"])
                        .unwrap();
                }
                "invalid-utf8" => {
                    connection
                        .execute_batch("UPDATE part SET data=CAST(X'80' AS TEXT)")
                        .unwrap();
                }
                _ => {}
            }
            connection.close().unwrap();
            let before = fs::read(&database).unwrap();
            let owner = ResidentOwner::start(&fixture);
            let observation = root.join("store-observation.json");
            let trace = root.join("store-trace.jsonl");
            let mut command = Command::new(env!("CARGO_BIN_EXE_caws-native"));
            command
                .args([
                    "invoke",
                    "--engine",
                    owner.engine.to_str().unwrap(),
                    "--node",
                    &fixture.node,
                    "--surface",
                    surface,
                    "--event",
                    "stop",
                    "--runtime-digest",
                    &"a".repeat(64),
                    "--timeout-ms",
                    "5000",
                    "--configuration",
                    "system",
                ])
                .current_dir(&root)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("CAWS_HOME", &owner.config.home)
                .env("CAWS_TRANSCRIPT_DATABASE", &database)
                .env("CAWS_NATIVE_STORE_CLI", &cli)
                .env("CAWS_NATIVE_STORE_ROOT", &root)
                .env("CAWS_NATIVE_STORE_BUDGET", root.join("budget-home"))
                .env("CAWS_NATIVE_STORE_OBSERVATION", &observation)
                .env("CAWS_NATIVE_STORE_TRACE", &trace)
                .env("CAWS_NATIVE_STORE_REQUEST_MODE", "fail-after-store")
                .env("CAWS_NATIVE_TEST_RECEIPT", root.join("requests.jsonl"));
            let output = execute(
                command,
                serde_json::to_vec(&serde_json::json!({
                    "session_id":"s", "cwd":root,
                }))
                .unwrap(),
            );
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert_eq!(output.status.code(), Some(2), "{surface}/{kind}: {stderr}");
            let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                response["decision"], "block",
                "{surface}/{kind}: {response}"
            );
            let expected = format!(
                "Completed store exchange retained: end={end}; acquisitionFailed={failed}; rowsDelivered={delivered}."
            );
            assert!(
                response["reason"].as_str().unwrap().contains(&expected),
                "{surface}/{kind}: {response}; {stderr}"
            );
            let observed: serde_json::Value =
                serde_json::from_slice(&fs::read(&observation).unwrap()).unwrap();
            assert_eq!(
                observed["status"],
                if kind == "valid" {
                    "encoded_after_native_close"
                } else {
                    "failed"
                }
            );
            if kind == "valid" {
                assert_eq!(observed["rows"], 1);
            } else {
                assert_eq!(observed["cleanupClosed"], true);
            }
            let closed: Vec<serde_json::Value> = fs::read_to_string(&trace)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
                .filter(|record| record["direction"] == "native_to_engine")
                .map(|record| {
                    serde_json::from_slice::<serde_json::Value>(
                        &base64::engine::general_purpose::STANDARD
                            .decode(record["base64"].as_str().unwrap())
                            .unwrap(),
                    )
                    .unwrap()
                })
                .filter(|frame| {
                    frame["schema"] == caws_native::transcript_store_wire::CLOSED_SCHEMA
                })
                .collect();
            assert_eq!(closed.len(), 1, "{surface}/{kind}");
            assert_eq!(closed[0]["end"], end.to_lowercase());
            assert_eq!(closed[0]["closed"], true);
            assert_eq!(!closed[0]["failure"].is_null(), failed);
            assert_eq!(closed[0]["metrics"]["rowsDelivered"], delivered);
            assert_eq!(fs::read(&database).unwrap(), before);
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection
                .execute_batch("BEGIN EXCLUSIVE;ROLLBACK")
                .unwrap();
            connection.close().unwrap();
            let registrations = owner.registrations();
            assert_eq!(registrations.len(), 1);
            let registration = &registrations[0];
            let status = render_owner::store_status(
                &owner.config,
                &StoreStatusQuery::new(
                    registration["invocationId"].as_str().unwrap().into(),
                    "a".repeat(64),
                    registration["registration"].as_str().unwrap().into(),
                ),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
            assert!(
                status.present,
                "actual retained actor record missing after frontend exit"
            );
            assert_eq!(status.phase, "settled");
            let retained = status.completion.unwrap();
            assert!(retained.retained);
            assert!(retained.original_project_bound);
            let acquisition = retained.acquisition.unwrap();
            assert_eq!(acquisition.end, end);
            assert_eq!(acquisition.rows_delivered, delivered);
            assert_eq!(acquisition.first_failure.is_some(), failed);
            assert_eq!(acquisition.close, "succeeded");
        }
    }
}
