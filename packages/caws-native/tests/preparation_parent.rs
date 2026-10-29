//! Real fixed-entry channel controls. They authorize no export or installation.
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
};

#[test]
fn cli_rejects_runtime_bootstrap_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_caws-prepare-source"))
        .args(["--pins", "/unadmitted/bootstrap.json"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}

#[test]
fn unconfigured_cli_refuses_without_reading_a_held_stdin() {
    assert!(
        option_env!("CAWS_PREPARATION_BOOTSTRAP_V1").is_none(),
        "Unconfigured control requires build without a bootstrap record"
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_caws-prepare-source"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let held = child.stdin.take().unwrap();
    let expires = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= expires {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("Unconfigured binary waited for stdin");
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    };
    drop(held);
    assert_eq!(status.code(), Some(2));
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    assert!(stdout.is_empty());
    let mut stderr = Vec::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_end(&mut stderr)
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&stderr).unwrap();
    assert_eq!(value["result"]["adoption"], "NOT_ADOPTED");
    assert_eq!(value["result"]["writerState"], "NOT_STARTED");
    assert_eq!(value["terminal"]["nodeStarted"], false);
    assert!(
        value["result"]["reason"]
            .as_str()
            .unwrap()
            .contains("Unconfigured")
    );
}

#[cfg(target_os = "macos")]
mod real_entry {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use caws_native::owned_group::{self, GroupSettlement};
    use serde_json::{Value, json};
    use std::{
        env, fs, io,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::{net::UnixStream, process::CommandExt},
        },
        path::PathBuf,
        process::{Child, ChildStderr, ChildStdout},
        time::{Duration, Instant},
    };
    struct Entry {
        child: Option<Child>,
        socket: UnixStream,
        stdout: ChildStdout,
        stderr: ChildStderr,
        out: Vec<u8>,
        err: Vec<u8>,
        out_eof: bool,
        err_eof: bool,
        expires: Instant,
    }
    fn nonblocking(fd: i32) {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
            0
        );
    }
    fn drain(reader: &mut impl Read, bytes: &mut Vec<u8>) -> bool {
        for _ in 0..8 {
            let mut block = [0; 8192];
            match reader.read(&mut block) {
                Ok(0) => return true,
                Ok(n) => {
                    bytes.extend_from_slice(&block[..n]);
                    assert!(bytes.len() <= 1024 * 1024);
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return false,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => panic!("{e}"),
            }
        }
        false
    }
    impl Entry {
        fn start() -> Self {
            let node = PathBuf::from(
                env::var_os("CAWS_PREPARATION_TEST_NODE")
                    .expect("select reviewed Node fixture explicitly"),
            );
            let entry = PathBuf::from(
                env::var_os("CAWS_PREPARATION_TEST_ENTRY")
                    .expect("select built fixed entry explicitly"),
            );
            assert_eq!(fs::canonicalize(&node).unwrap(), node);
            assert!(node.is_file());
            assert_eq!(fs::canonicalize(&entry).unwrap(), entry);
            assert!(entry.is_file());
            assert_eq!(
                entry.file_name().unwrap(),
                "native-qualification-prepare-entry.js"
            );
            let (parent, child_socket) = UnixStream::pair().unwrap();
            let fd = unsafe { libc::fcntl(child_socket.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
            assert!((64..=1048575).contains(&fd));
            let inherited = unsafe { OwnedFd::from_raw_fd(fd) };
            let mut command = Command::new(node);
            command
                .arg(entry)
                .args(["--parent-fd", &fd.to_string()])
                .env_clear()
                .env("LANG", "C")
                .env("LC_ALL", "C")
                .env("TZ", "UTC")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            unsafe {
                command.pre_exec(move || {
                    if libc::setpgid(0, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command.spawn().unwrap();
            drop(inherited);
            drop(child_socket);
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            parent.set_nonblocking(true).unwrap();
            nonblocking(stdout.as_raw_fd());
            nonblocking(stderr.as_raw_fd());
            Self {
                child: Some(child),
                socket: parent,
                stdout,
                stderr,
                out: vec![],
                err: vec![],
                out_eof: false,
                err_eof: false,
                expires: Instant::now() + Duration::from_secs(6),
            }
        }
        fn left(&self) -> Duration {
            let left = self.expires.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "fixture interval expired");
            left
        }
        fn send(&mut self, value: Value) {
            let bytes = serde_json::to_vec(&value).unwrap();
            assert!(bytes.len() <= 16 * 1024 * 1024);
            self.send_bytes(&(bytes.len() as u32).to_be_bytes());
            self.send_bytes(&bytes);
        }
        fn pump(&mut self) {
            self.left();
            if !self.out_eof {
                self.out_eof = drain(&mut self.stdout, &mut self.out);
            }
            if !self.err_eof {
                self.err_eof = drain(&mut self.stderr, &mut self.err);
            }
        }
        fn send_bytes(&mut self, bytes: &[u8]) {
            let mut offset = 0;
            while offset < bytes.len() {
                self.pump();
                match self
                    .socket
                    .write(&bytes[offset..(offset + 8192).min(bytes.len())])
                {
                    Ok(0) => panic!("fixture channel made no write progress"),
                    Ok(n) => offset += n,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => panic!("fixture channel write: {e}"),
                }
            }
            self.left();
        }
        fn receive_bytes(&mut self, size: usize) -> Vec<u8> {
            let mut bytes = vec![0; size];
            let mut offset = 0;
            while offset < size {
                self.pump();
                match self.socket.read(&mut bytes[offset..]) {
                    Ok(0) => panic!(
                        "fixture channel EOF before complete frame; stderr={}",
                        String::from_utf8_lossy(&self.err)
                    ),
                    Ok(n) => offset += n,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => panic!("fixture channel read: {e}"),
                }
            }
            self.left();
            bytes
        }
        fn receive(&mut self) -> Value {
            let header: [u8; 4] = self.receive_bytes(4).try_into().unwrap();
            let length = u32::from_be_bytes(header) as usize;
            assert!((1..=16 * 1024 * 1024).contains(&length));
            serde_json::from_slice(&self.receive_bytes(length)).unwrap()
        }
        fn start_frame(&self, request: Value, parent_pid: u32, remaining_ms: u64) -> Value {
            json!({"kind":"start","request":B64.encode(serde_json::to_vec(&request).unwrap()),
                "cwd":fs::canonicalize(env::current_dir().unwrap()).unwrap(),"parentPid":parent_pid,"environment":{},"remainingMs":remaining_ms})
        }
        fn finish(mut self) -> (i32, Vec<u8>, Vec<u8>) {
            loop {
                assert!(
                    Instant::now() < self.expires,
                    "fixed entry failed to finish"
                );
                if !self.out_eof {
                    self.out_eof = drain(&mut self.stdout, &mut self.out);
                }
                if !self.err_eof {
                    self.err_eof = drain(&mut self.stderr, &mut self.err);
                }
                let settled =
                    owned_group::settlement_before_reap(self.child.as_ref().unwrap()).unwrap();
                if matches!(settled, GroupSettlement::Exited { .. }) && self.out_eof && self.err_eof
                {
                    let pid = self.child.as_ref().unwrap().id();
                    let status = self.child.as_mut().unwrap().wait().unwrap();
                    self.child = None;
                    self.left();
                    let mut observed = 0;
                    assert_eq!(
                        unsafe { libc::waitpid(pid as i32, &mut observed, libc::WNOHANG) },
                        -1
                    );
                    assert_eq!(
                        io::Error::last_os_error().raw_os_error(),
                        Some(libc::ECHILD)
                    );
                    let mut trailing = [0];
                    assert_eq!(
                        self.socket.read(&mut trailing).unwrap(),
                        0,
                        "trailing private-channel bytes after result"
                    );
                    return (
                        status.code().unwrap_or(-1),
                        std::mem::take(&mut self.out),
                        std::mem::take(&mut self.err),
                    );
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    impl Drop for Entry {
        fn drop(&mut self) {
            let _ = self.socket.shutdown(std::net::Shutdown::Both);
            if let Some(child) = self.child.as_ref() {
                let _ = owned_group::stop_before_reap(child);
            }
            let expires = Instant::now() + Duration::from_secs(2);
            while let Some(child) = self.child.as_ref() {
                if matches!(
                    owned_group::settlement_before_reap(child),
                    Ok(GroupSettlement::Exited { .. })
                ) {
                    let _ = self.child.as_mut().unwrap().wait();
                    self.child = None;
                    break;
                }
                if Instant::now() >= expires {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    const NEEDS_ENTRY: &str =
        "requires explicitly selected built fixed Node entry; no export authorized";
    #[test]
    #[ignore = "requires explicitly selected built fixed Node entry; no export authorized"]
    fn actual_high_fd_entry_preserves_failed_authority_result_and_reaps() {
        let _ = NEEDS_ENTRY;
        let mut entry = Entry::start();
        let root = fs::canonicalize(env::temp_dir())
            .unwrap()
            .join(format!("caws-fixed-entry-no-export-{}", std::process::id()));
        assert!(!root.exists());
        let request = json!({"schema":"caws.frozen_source_preparation.v1","source":{"sourceRoot":"/unadmitted-source","commit":"a".repeat(40),"tree":"b".repeat(40),"objectFormat":"sha1"},"outputRoot":root,"futureBuildRoot":root.with_extension("build")});
        entry.send(entry.start_frame(request, std::process::id(), 5000));
        let mut expected = 1u64;
        let mut metadata = 0;
        let result = loop {
            let frame = entry.receive();
            assert_eq!(frame["seq"], expected);
            expected += 1;
            assert!(expected < 32);
            match frame["kind"].as_str().unwrap(){
                "checkpoint"=>entry.send(json!({"kind":"ok","seq":frame["seq"],"remainingMs":entry.left().as_millis().min(5000)as u64})),
                "metadata"=>{metadata+=1;assert_eq!(frame["operation"],"commonDir");entry.send(json!({"kind":"gitResult","seq":frame["seq"],"exitCode":128,"stdout":"","stderr":B64.encode(b"fixture authority refusal")}));},
                "result"=>break frame["result"].clone(),other=>panic!("unadmitted operation {other}"),
            }
        };
        assert_eq!(metadata, 1);
        assert_eq!(result["status"], "failed");
        assert_eq!(result["adoption"], "NOT_ADOPTED");
        assert_eq!(result["writerState"], "NOT_STARTED");
        assert_eq!(result["phase"], "authority");
        assert!(!root.exists());
        let (code, out, err) = entry.finish();
        assert_eq!(code, 2);
        assert!(out.is_empty());
        assert!(err.is_empty());
    }
    #[test]
    #[ignore = "requires explicitly selected built fixed Node entry; no export authorized"]
    fn actual_entry_refuses_truncated_frame_and_reaps() {
        let mut entry = Entry::start();
        entry.send_bytes(&100u32.to_be_bytes());
        entry.send_bytes(b"{}");
        entry.socket.shutdown(std::net::Shutdown::Write).unwrap();
        let (code, out, err) = entry.finish();
        assert_eq!(code, 2);
        assert!(out.is_empty());
        assert!(
            String::from_utf8(err)
                .unwrap()
                .contains("Preparation parent channel closed")
        );
    }
    #[test]
    #[ignore = "requires explicitly selected built fixed Node entry; no export authorized"]
    fn actual_entry_refuses_wrong_parent_pid_before_requests() {
        let mut entry = Entry::start();
        entry.send(entry.start_frame(json!({}), std::process::id() + 1000, 5000));
        let (code, out, err) = entry.finish();
        assert_eq!(code, 2);
        assert!(out.is_empty());
        assert!(
            String::from_utf8(err)
                .unwrap()
                .contains("Preparation parent process correspondence failed")
        );
    }
    #[test]
    #[ignore = "requires explicitly selected built fixed Node entry; no export authorized"]
    fn actual_entry_cannot_advance_after_parent_revokes_expired_checkpoint() {
        let mut entry = Entry::start();
        let root = fs::canonicalize(env::temp_dir())
            .unwrap()
            .join(format!("caws-fixed-entry-expired-{}", std::process::id()));
        assert!(!root.exists());
        let request = json!({"schema":"caws.frozen_source_preparation.v1","source":{"sourceRoot":"/unadmitted-source","commit":"a".repeat(40),"tree":"b".repeat(40),"objectFormat":"sha1"},"outputRoot":root,"futureBuildRoot":root.with_extension("build")});
        entry.send(entry.start_frame(request, std::process::id(), 30));
        let frame = entry.receive();
        assert_eq!(frame, json!({"kind":"checkpoint","seq":1}));
        std::thread::sleep(Duration::from_millis(50));
        // Revoke replies while retaining the read side to observe the child's
        // semantic refusal. A valid request would otherwise advance to metadata.
        entry.socket.shutdown(std::net::Shutdown::Write).unwrap();
        let refusal = entry.receive();
        assert_eq!(refusal["kind"], "result");
        assert_eq!(refusal["seq"], 2);
        assert_eq!(refusal["result"]["status"], "failed");
        assert_eq!(refusal["result"]["adoption"], "NOT_ADOPTED");
        assert_eq!(refusal["result"]["writerState"], "NOT_STARTED");
        assert_eq!(refusal["result"]["phase"], "request");
        assert!(
            refusal["result"]["reason"]
                .as_str()
                .unwrap()
                .contains("Preparation parent channel closed")
        );
        assert!(!root.exists());
        assert!(!root.with_extension("build").exists());
        let (code, out, err) = entry.finish();
        assert_eq!(code, 2);
        assert!(out.is_empty());
        assert!(err.is_empty());
    }
}
