//! Real renderer-host idle/restart lifecycle over an already durable Unknown.
//! No renderer, SQL consumer, native Stop admission or operation recovery is claimed.
#![cfg(target_os = "macos")]
use caws_native::{render_owner, service_journal as journal};
use sha2::{Digest, Sha256};
use std::os::unix::net::UnixStream;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        // This owned host receives no requests and can create no workers.
        if self.0.try_wait().unwrap().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn until() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
#[test]
fn real_host_idle_restart_preserves_unknown_and_generation_fence() {
    let retain = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT");
    let parent = retain
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .canonicalize()
        .unwrap();
    let root = parent.join(format!(
        "idle-unknown-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let home = root.join("home");
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(home.join("state")).unwrap();
    fs::set_permissions(home.join("state"), fs::Permissions::from_mode(0o700)).unwrap();
    let native = PathBuf::from(env!("CARGO_BIN_EXE_caws-native"))
        .canonicalize()
        .unwrap();
    let config: render_owner::OwnerConfig = serde_json::from_value(serde_json::json!({
        "schema":"caws.render.owner.config.v1", "home":home, "clientRoot":root, "templateRoot":root,
        "clientShellSource":native, "nativeExecutable":native,
        "limits":{"maxConnections":4,"maxProjects":2,"maxBackends":1,"maxQueuePerProject":2,
            "maxFrameBytes":1048576,"maxRetainedRecords":2,"firstFrameMs":1000,"requestMs":1000,
            "startupMs":1000,"idleMs":100,"backendIdleSeconds":1,"cacheMegabytes":1,
            "worker":{"startupMs":1000,"connectMs":1000,"writeMs":1000,"renderMs":1000,"readMs":1000,"cleanupMs":1000}}
    })).unwrap();
    render_owner::provision(&config, until()).unwrap();
    let custody_path = home.join("state/render-service/custody");
    let key = "a".repeat(64);
    let identity = journal::Identity {
        request_id: "b".repeat(64),
        argument_digest: "c".repeat(64),
        project_service_key: key.clone(),
        source_generation: "d".repeat(64),
        execution_image_digest: "d".repeat(64),
    };
    let operation;
    {
        let custody = journal::Custody::acquire(&custody_path, until()).unwrap();
        let mut j = journal::Journal::open(custody, &key, 2, until()).unwrap();
        j.admit(identity.clone(), b"preserved request", until())
            .unwrap();
        let dispatch = j
            .begin_next(
                &identity.source_generation,
                &identity.execution_image_digest,
                until(),
            )
            .unwrap()
            .unwrap();
        operation = j.unknown(&dispatch, until()).unwrap();
    }
    let record = custody_path
        .join("operations/services")
        .join(&key)
        .join(format!("{}.json", identity.request_id));
    let before = fs::read(&record).unwrap();
    fs::write(root.join("unknown-before.json"), &before).unwrap();
    for attempt in 0..2 {
        let output = fs::File::create(root.join(format!("host-{attempt}.stdout"))).unwrap();
        let error = fs::File::create(root.join(format!("host-{attempt}.stderr"))).unwrap();
        let started = Instant::now();
        let mut host = Process(
            Command::new(&native)
                .arg("renderer-host")
                .arg("--config")
                .arg(render_owner::config_path(&config))
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("HOME", &home)
                .stdin(Stdio::null())
                .stdout(output)
                .stderr(error)
                .spawn()
                .unwrap(),
        );
        let pid = host.0.id();
        let socket = PathBuf::from("/private/tmp")
            .join(format!(
                "caws-render-{}-{}",
                unsafe { libc::geteuid() },
                &format!("{:x}", Sha256::digest(home.as_os_str().as_encoded_bytes()))[..24]
            ))
            .join("owner.sock");
        if attempt == 0 {
            let expires = until();
            while !socket.exists() {
                assert!(
                    host.0.try_wait().unwrap().is_none(),
                    "host exited before rendezvous"
                );
                assert!(Instant::now() < expires, "host did not publish rendezvous");
                thread::sleep(Duration::from_millis(2));
            }
            let connection = UnixStream::connect(&socket).unwrap();
            // A real admitted connection suppresses idle exit. It sends no frame
            // and performs no journal/operation mutation; close releases demand.
            thread::sleep(Duration::from_millis(300));
            assert!(
                host.0.try_wait().unwrap().is_none(),
                "idle exit lost an active connection"
            );
            assert_eq!(fs::read(&record).unwrap(), before);
            drop(connection);
        }
        let expiry = until();
        let status = loop {
            if let Some(status) = host.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < expiry,
                "actual host failed bounded idle exit; pid={pid}"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(status.success(), "actual host exit={status}");
        assert!(
            !socket.exists(),
            "owned rendezvous must be removed on idle exit"
        );
        assert_eq!(
            fs::read(&record).unwrap(),
            before,
            "idle must not settle or rewrite Unknown"
        );
        fs::write(root.join(format!("host-{attempt}-terminal.json")),serde_json::to_vec_pretty(&serde_json::json!({
            "pid":pid,"exitCode":status.code(),"elapsedMs":started.elapsed().as_millis(),"signalsSent":[],"operationRecovery":false
        })).unwrap()).unwrap();
        let custody = journal::Custody::acquire(&custody_path, until()).unwrap();
        let mut j = journal::Journal::open(Arc::clone(&custody), &key, 2, until()).unwrap();
        assert_eq!(
            j.lookup(&identity.request_id, until()).unwrap(),
            Some(operation.clone())
        );
        assert!(matches!(
            j.admit(identity.clone(), b"preserved request", until())
                .unwrap(),
            journal::Admission::Accepted {
                duplicate: true,
                ..
            }
        ));
        assert!(
            j.begin_next(&"e".repeat(64), &"e".repeat(64), until())
                .is_err(),
            "generation change cannot dispatch through Unknown"
        );
        drop(j);
        drop(custody);
    }
    let observations =
        fs::read_to_string(home.join("state/render-service/observations.jsonl")).unwrap();
    let rows: Vec<serde_json::Value> = observations
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        rows.iter()
            .filter(|row| row["observation"]["event"] == "host_idle_exit")
            .count(),
        2
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["observation"]["event"] == "journal_recovered"
                && row["observation"]["unknown"] == true)
            .count(),
        2
    );
    assert_eq!(fs::read(&record).unwrap(), before);
    if retain.is_none() {
        fs::remove_dir_all(&root).unwrap();
    } else {
        eprintln!("idle/restart raw fixture retained: {}", root.display());
    }
}
