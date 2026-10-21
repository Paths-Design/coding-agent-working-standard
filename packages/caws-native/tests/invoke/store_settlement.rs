use super::*;

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
            let observation = root.join("store-observation.json");
            let trace = root.join("store-trace.jsonl");
            let mut command = Command::new(env!("CARGO_BIN_EXE_caws-native"));
            command
                .args([
                    "invoke",
                    "--engine",
                    concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/tests/fixtures/store-engine.cjs"
                    ),
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
                .env("PATH", "/usr/bin:/bin")
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
        }
    }
}
