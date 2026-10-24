//! Actual peer-process identity checks in a synthetic installed generation.
//! The positive peer executes the real caws-native renderer-host entry. Other
//! inventoried engine assets are inert fixtures; this is not Stop activation,
//! generation publisher qualification, or an immutable execution-image proof.
#![cfg(target_os = "macos")]

use caws_native::{monotonic_deadline, render_owner, renderer_backend};
use monotonic_deadline::MonotonicDeadline;
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

// Exercise the production private implementation without a public permission
// seam or an additional production binary mode (same pattern as installed_entry).
#[allow(dead_code)]
#[path = "../src/installed_generation.rs"]
mod installed_generation;
#[path = "../src/render_owner/native_peer.rs"]
mod native_peer;
use native_peer::NativePeer;

static SERIAL: AtomicUsize = AtomicUsize::new(0);

struct Process(Child);
struct SocketPath(PathBuf);
impl Drop for SocketPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
impl Process {
    fn stop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
        }
        self.0.wait().unwrap();
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        // This fixture never sends an owner request, so its directly owned host
        // creates no backend descendants. Reap that actual owned child.
        self.stop();
    }
}

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    generation: String,
    native: PathBuf,
    rendezvous: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let parent = std::env::var_os("CAWS_NATIVE_PEER_ARTIFACT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "caws-native-peer-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let home = root.join("home");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(home.join("state")).unwrap();
        fs::set_permissions(home.join("state"), fs::Permissions::from_mode(0o700)).unwrap();
        let native_bytes = fs::read(env!("CARGO_BIN_EXE_caws-native")).unwrap();
        let mut files = BTreeMap::from([
            (
                "launcher.py".to_string(),
                b"raise SystemExit(78)\n".to_vec(),
            ),
            ("native/caws-native".to_string(), native_bytes),
            (
                "native/caws-hook-native".to_string(),
                b"fixture identity; never executed\n".to_vec(),
            ),
            ("native/node".to_string(), b"#!/bin/sh\nexit 78\n".to_vec()),
            (
                "engine.js".to_string(),
                b"throw Error('inert fixture');\n".to_vec(),
            ),
            (
                "describe.js".to_string(),
                b"throw Error('inert fixture');\n".to_vec(),
            ),
        ]);
        files.insert("native-entry.json".into(), serde_json::to_vec(&serde_json::json!({
            "schema":"caws.runtime.native-entry.v1", "nativeExecutable":"native/caws-native",
            "nodeExecutable":"native/node", "engineEntry":"engine.js", "describeEntry":"describe.js", "timeoutMs":1000,
        })).unwrap());
        files.insert("native-modes.json".into(), Vec::new());
        let modes: BTreeMap<_, _> = files
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    if name.starts_with("native/") {
                        0o755
                    } else {
                        0o644
                    },
                )
            })
            .collect();
        files.insert(
            "native-modes.json".into(),
            serde_json::to_vec(&modes).unwrap(),
        );
        let manifest: BTreeMap<_, _> = files
            .iter()
            .map(|(name, bytes)| (name, format!("{:x}", Sha256::digest(bytes))))
            .collect();
        let manifest = serde_json::to_vec(&manifest).unwrap();
        let generation = format!("{:x}", Sha256::digest(&manifest));
        let runtime = home.join("lib/runtimes").join(&generation);
        for (name, bytes) in files {
            let target = runtime.join(&name);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, bytes).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(modes[&name])).unwrap();
        }
        fs::write(runtime.join("manifest.json"), manifest).unwrap();
        fs::set_permissions(
            runtime.join("manifest.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        // The peer boundary must select the exact request generation, never this
        // deliberately unrelated current pointer.
        fs::write(
            home.join("state/adapter-runtime.json"),
            serde_json::to_vec(&serde_json::json!({"version":1,"digest":"f".repeat(64)})).unwrap(),
        )
        .unwrap();
        let hash = format!("{:x}", Sha256::digest(home.as_os_str().as_encoded_bytes()));
        let rendezvous = PathBuf::from("/private/tmp").join(format!(
            "caws-render-{}-{}",
            unsafe { libc::geteuid() },
            &hash[..24]
        ));
        Self {
            root,
            home,
            generation,
            native: runtime.join("native/caws-native"),
            rendezvous,
        }
    }

    fn native_host(&self) -> (Process, UnixStream) {
        let source = self.root.join("trusted-shell-source");
        fs::write(&source, b"inert fixture; never executed\n").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        let c = render_owner::OwnerConfig {
            schema: "caws.render.owner.config.v1".into(),
            home: self.home.clone(),
            client_root: self.root.clone(),
            template_root: self.root.clone(),
            client_shell_source: source,
            native_executable: self.native.clone(),
            limits: render_owner::OwnerLimits {
                max_connections: 4,
                max_projects: 2,
                max_backends: 1,
                max_queue_per_project: 2,
                max_frame_bytes: 1_048_576,
                max_retained_records: 4,
                first_frame_ms: 30_000,
                request_ms: 30_000,
                startup_ms: 10_000,
                idle_ms: 30_000,
                backend_idle_seconds: 30,
                cache_megabytes: 1,
                worker: renderer_backend::WorkerLimits {
                    startup_ms: 1000,
                    connect_ms: 1000,
                    write_ms: 1000,
                    render_ms: 1000,
                    read_ms: 1000,
                    cleanup_ms: 1000,
                },
            },
        };
        render_owner::provision(&c, Instant::now() + Duration::from_secs(10)).unwrap();
        let mut child = Process(
            Command::new(&self.native)
                .args(["renderer-host", "--config"])
                .arg(render_owner::config_path(&c))
                .env_clear()
                .env("HOME", &self.home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::null())
                .stdout(fs::File::create(self.root.join("host.stdout.bin")).unwrap())
                .stderr(fs::File::create(self.root.join("host.stderr.bin")).unwrap())
                .spawn()
                .unwrap(),
        );
        let expires = Instant::now() + Duration::from_secs(10);
        let stream = loop {
            match UnixStream::connect(self.rendezvous.join("owner.sock")) {
                Ok(stream) => break stream,
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(libc::ENOENT | libc::ECONNREFUSED)
                    ) =>
                {
                    assert!(
                        child.0.try_wait().unwrap().is_none(),
                        "real native host exited before listening"
                    );
                    assert!(
                        Instant::now() < expires,
                        "real native host listener deadline"
                    );
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("native host connection: {error}"),
            }
        };
        (child, stream)
    }
    fn retain(&self, value: serde_json::Value) {
        fs::write(
            self.root.join("peer-observation.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Unique fixture rendezvous; all directly owned host children drop first.
        let _ = fs::remove_dir_all(&self.rendezvous);
        if std::env::var_os("CAWS_NATIVE_PEER_ARTIFACT_DIR").is_none() {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
fn clock() -> MonotonicDeadline {
    MonotonicDeadline::capture(Duration::from_secs(20)).unwrap()
}

#[test]
fn actual_native_host_peer_is_admitted_from_exact_generation_and_revalidated() {
    let f = Fixture::new();
    let (_host, stream) = f.native_host();
    let deadline = std::sync::Arc::new(clock());
    let peer = NativePeer::capture(
        &stream,
        &f.home,
        &f.generation,
        std::sync::Arc::clone(&deadline),
        || Ok(()),
    )
    .unwrap();
    let original_envelope = deadline.envelope();
    drop(deadline); // Peer owns the same original clock after the local Arc is released.
    drop(stream); // Revalidation uses the retained connection, not the caller FD.
    peer.revalidate(|| Ok(())).unwrap();
    f.retain(
        serde_json::json!({"native":f.native,"generation":f.generation,
        "capture":"admitted","revalidation":"admitted","currentPointerIgnored":true,
        "originalDeadline":original_envelope,"localDeadlineOwnerDropped":true,
        "scope":"actual renderer-host peer in synthetic generation; no Stop activation"}),
    );
}

#[test]
fn same_uid_node_with_forged_native_claim_is_refused_before_admission_callback() {
    let f = Fixture::new();
    let node = std::env::var_os("CAWS_NATIVE_PEER_NODE")
        .expect("CAWS_NATIVE_PEER_NODE must name the explicit qualified Node executable");
    let node = fs::canonicalize(node).unwrap();
    assert!(node.is_absolute());
    let socket = SocketPath(PathBuf::from("/private/tmp").join(format!(
        "caws-peer-client-{}-{}.sock",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )));
    let listener = UnixListener::bind(&socket.0).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut child = Process(Command::new(&node).args(["-e",
        "const net=require('node:net');const c=net.connect(process.argv[1],()=>c.write(JSON.stringify({pid:process.pid,nativePath:process.argv[2],generation:process.argv[3]})));c.on('error',()=>process.exit(3));"])
        .arg(&socket.0).arg(&f.native).arg(&f.generation)
        .env_clear().env("HOME", &f.root).env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null()).stdout(Stdio::null())
        .stderr(fs::File::create(f.root.join("node.stderr.bin")).unwrap())
        .spawn().unwrap());
    let expires = Instant::now() + Duration::from_secs(10);
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "actual Node client exited"
                );
                assert!(
                    Instant::now() < expires,
                    "actual Node client connection deadline"
                );
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("Node peer accept: {error}"),
        }
    };
    let deadline = std::sync::Arc::new(clock());
    let callbacks = Cell::new(0);
    let result = NativePeer::capture(
        &stream,
        &f.home,
        &f.generation,
        std::sync::Arc::clone(&deadline),
        || Ok(()),
    )
    .map(|_| callbacks.set(callbacks.get() + 1));
    let error = result.unwrap_err();
    assert_eq!(
        error,
        "Native peer executable differs from exact admitted generation"
    );
    assert_eq!(callbacks.get(), 0);
    f.retain(serde_json::json!({"node":node,"nativeClaim":f.native,"error":error,"admissionCallbacks":callbacks.get()}));
    child.stop();
    drop(stream);
    drop(listener);
    fs::remove_file(&socket.0).unwrap();
}

#[test]
fn native_peer_process_exit_invalidates_retained_admission() {
    let f = Fixture::new();
    let (mut host, stream) = f.native_host();
    let deadline = std::sync::Arc::new(clock());
    let peer = NativePeer::capture(
        &stream,
        &f.home,
        &f.generation,
        std::sync::Arc::clone(&deadline),
        || Ok(()),
    )
    .unwrap();
    host.stop();
    let error = peer.revalidate(|| Ok(())).unwrap_err();
    assert!(
        error.starts_with("Native peer"),
        "unexpected rejection: {error}"
    );
    f.retain(serde_json::json!({"afterOriginalExit":"refused","error":error}));
}

#[test]
fn same_bytes_replacement_of_admitted_native_member_refuses_revalidation() {
    let f = Fixture::new();
    let (_host, stream) = f.native_host();
    let deadline = std::sync::Arc::new(clock());
    let peer = NativePeer::capture(
        &stream,
        &f.home,
        &f.generation,
        std::sync::Arc::clone(&deadline),
        || Ok(()),
    )
    .unwrap();
    let replacement = f.root.join("replacement-member");
    fs::copy(&f.native, &replacement).unwrap();
    fs::set_permissions(&replacement, fs::Permissions::from_mode(0o755)).unwrap();
    fs::rename(replacement, &f.native).unwrap();
    let error = peer.revalidate(|| Ok(())).unwrap_err();
    assert!(
        error.starts_with("Native peer"),
        "unexpected rejection: {error}"
    );
    f.retain(serde_json::json!({"sameBytesReplacement":"refused","error":error}));
}

#[test]
fn cancelled_or_expired_original_cannot_admit_even_an_actual_native_peer() {
    let f = Fixture::new();
    let (_host, stream) = f.native_host();
    let deadline = std::sync::Arc::new(clock());
    let cancelled = NativePeer::capture(
        &stream,
        &f.home,
        &f.generation,
        std::sync::Arc::clone(&deadline),
        || Err("original cancelled sentinel".into()),
    );
    let cancellation_error = cancelled.err().unwrap();
    assert_eq!(cancellation_error, "original cancelled sentinel");
    let expired =
        std::sync::Arc::new(MonotonicDeadline::capture(Duration::from_millis(1)).unwrap());
    thread::sleep(Duration::from_millis(3));
    let refused = NativePeer::capture(
        &stream,
        &f.home,
        &f.generation,
        std::sync::Arc::clone(&expired),
        || Ok(()),
    );
    let expiry_error = refused.err().unwrap();
    assert_eq!(expiry_error, "Original monotonic deadline expired");
    f.retain(serde_json::json!({"cancellationError": cancellation_error,
        "expiryError": expiry_error, "originalDeadline": expired.envelope()}));
}

#[test]
fn shared_original_expiry_invalidates_the_actual_retained_native_socket() {
    let f = Fixture::new();
    let (_host, stream) = f.native_host();
    let deadline = std::sync::Arc::new(MonotonicDeadline::capture(Duration::from_secs(2)).unwrap());
    let peer = NativePeer::capture(
        &stream,
        &f.home,
        &f.generation,
        std::sync::Arc::clone(&deadline),
        || Ok(()),
    )
    .unwrap();
    let original = deadline.envelope();
    let until = Instant::now() + Duration::from_secs(3);
    while deadline.check().is_ok() && Instant::now() < until {
        thread::sleep(Duration::from_millis(2));
    }
    assert!(
        deadline.check().is_err(),
        "original native peer clock did not expire"
    );
    drop(deadline);
    assert_eq!(
        peer.check_live(|| Ok(())).unwrap_err(),
        "Original monotonic deadline expired"
    );
    assert_eq!(
        peer.revalidate(|| Ok(())).unwrap_err(),
        "Original monotonic deadline expired"
    );
    f.retain(
        serde_json::json!({"originalDeadline":original,"afterQueue":"expired",
        "scope":"actual retained native peer; no new deadline, registration or SQL grant"}),
    );
}
