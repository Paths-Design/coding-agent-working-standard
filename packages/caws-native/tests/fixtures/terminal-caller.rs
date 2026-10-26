//! Sacrificial caller for terminal transport tests. It never signals a target.
//! Its native child joins a separately pinned, test-owned cleanup group.
use std::{
    env, fs,
    io::{Read, Write},
    os::unix::process::{CommandExt, ExitStatusExt},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// Qualification-only owner. It survives the disposable caller's SIGTERM and
// retains the native Child handle. Production engine-group cleanup remains
// the native client's responsibility.
fn cleanup_owner(root: &PathBuf) {
    let started = Instant::now();
    let mut child = Command::new(env::var_os("TERMINAL_NATIVE").unwrap())
        .args(env::args_os().skip(2))
        .env("TERMINAL_OWNER_PID", std::process::id().to_string())
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn owned native client");
    let native_pid = child.id();
    fs::write(root.join("native-pid.txt"), native_pid.to_string()).unwrap();

    // This reader survives the target caller. Native stdout acceptance cannot
    // establish that a subsequently killed caller flushed its own capture.
    let mut stdout = child.stdout.take().unwrap();
    let stdout_file = root.join("native-stdout.bin");
    let (capture_tx, capture_rx) = std::sync::mpsc::channel();
    let capture = thread::spawn(move || {
        let result = (|| -> std::io::Result<u64> {
            let mut file = fs::File::create(stdout_file)?;
            let bytes = std::io::copy(&mut stdout, &mut file)?;
            file.flush()?;
            Ok(bytes)
        })();
        let _ = capture_tx.send(result);
    });

    // Filesystem modification time supplies a cross-process observation
    // anchor. Clock uncertainty fails this qualification; it is not the
    // production clock or deadline contract.
    let mut handoff_written: Option<std::time::SystemTime> = None;
    loop {
        if handoff_written.is_none()
            && let Ok(metadata) = fs::metadata(root.join("handoff.json"))
        {
            handoff_written = Some(metadata.modified().expect("handoff modification time"));
        }
        if let Some(status) = child.try_wait().expect("reap owned native client") {
            let post_handoff = handoff_written
                .and_then(|written| written.elapsed().ok())
                .map(|elapsed| elapsed.as_millis().to_string())
                .unwrap_or_else(|| "null".into());
            let capture_started = Instant::now();
            let stdout_bytes = match capture_rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(bytes)) => bytes,
                outcome => {
                    fs::write(
                        root.join("owner-capture-incomplete.marker"),
                        format!("{outcome:?}"),
                    )
                    .unwrap();
                    return;
                }
            };
            capture.join().expect("native stdout capture thread");
            let code = status
                .code()
                .map_or("null".into(), |value| value.to_string());
            let signal = status
                .signal()
                .map_or("null".into(), |value| value.to_string());
            let pending = root.join("native-owner-wait.pending");
            fs::write(
                &pending,
                format!(
                    "{{\"ownerPid\":{},\"nativePid\":{native_pid},\"code\":{code},\
                     \"signal\":{signal},\"elapsedMs\":{},\"postHandoffMs\":{post_handoff},\
                     \"directChildReaped\":true,\"outputCaptureComplete\":true,\
                     \"stdoutBytes\":{stdout_bytes},\"captureAfterReapMs\":{},\
                     \"postHandoffUsesFilesystemSystemTime\":true}}\n",
                    std::process::id(),
                    started.elapsed().as_millis(),
                    capture_started.elapsed().as_millis()
                ),
            )
            .unwrap();
            fs::rename(pending, root.join("native-owner-wait.json")).unwrap();
            return;
        }
        if started.elapsed() > Duration::from_secs(8)
            || handoff_written.is_some_and(|written| {
                written
                    .elapsed()
                    .map_or(true, |elapsed| elapsed > Duration::from_secs(2))
            })
        {
            fs::write(
                root.join("owner-watchdog-fired.marker"),
                b"native did not retire",
            )
            .unwrap();
            fs::write(
                root.join("abort-stalled-engine"),
                b"failed scenario cleanup",
            )
            .unwrap();
            let _ = child.kill();
            let until = Instant::now() + Duration::from_millis(500);
            while Instant::now() < until {
                if child.try_wait().is_ok_and(|status| status.is_some()) {
                    return;
                }
                thread::sleep(Duration::from_millis(5));
            }
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn main() {
    let root = PathBuf::from(env::var_os("TERMINAL_CASE_ROOT").expect("private case root"));
    if env::args().nth(1).as_deref() == Some("--cleanup-owner") {
        cleanup_owner(&root);
        return;
    }
    let mode = env::var("TERMINAL_OUTPUT_MODE").expect("output mode");
    assert!(matches!(
        mode.as_str(),
        "close-after-prefix" | "full-unread" | "post-effect-stall"
    ));
    let anchor = env::var("TERMINAL_GROUP_ANCHOR")
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert!(anchor > 1);
    fs::write(root.join("caller-pid.txt"), std::process::id().to_string()).unwrap();
    let native = env::var_os("TERMINAL_NATIVE").unwrap();
    let engine = env::var_os("TERMINAL_ENGINE").unwrap();
    let node = env::var_os("TERMINAL_NODE").unwrap();
    let mut command = if mode == "post-effect-stall" {
        let mut command = Command::new(env::current_exe().unwrap());
        command.arg("--cleanup-owner");
        command
    } else {
        Command::new(native)
    };
    command
        .args(["invoke", "--engine"])
        .arg(engine)
        .args(["--node"])
        .arg(node)
        .args([
            "--surface",
            "codex",
            "--event",
            "pre_tool_use",
            "--runtime-digest",
            &"a".repeat(64),
            "--timeout-ms",
            "6000",
            "--configuration",
            "system",
        ])
        .env("TERMINAL_CALLER_PID", std::process::id().to_string())
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .env("PATH", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(
            fs::File::create(root.join("native-stderr.bin")).unwrap(),
        ))
        .process_group(anchor);
    let mut child = command.spawn().expect("spawn owned native client");
    if mode == "post-effect-stall" {
        fs::write(root.join("cleanup-owner-pid.txt"), child.id().to_string()).unwrap();
    } else {
        fs::write(root.join("native-pid.txt"), child.id().to_string()).unwrap();
    }
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(b"{\"session_id\":\"terminal-fixture\"}")
        .unwrap();
    drop(input);
    let mut output = child.stdout.take().unwrap();
    if mode == "post-effect-stall" {
        // Native stdout belongs to the surviving owner's drain thread.
        drop(output);
    } else if mode == "close-after-prefix" {
        let mut prefix = [0u8; 1];
        match output.read_exact(&mut prefix) {
            Ok(()) => fs::write(root.join("accepted-prefix.bin"), prefix).unwrap(),
            Err(error) => {
                fs::write(root.join("prefix-read-error.txt"), error.to_string()).unwrap();
                std::process::exit(43);
            }
        }
        // The first native byte proves proposal validation and terminal output
        // began. Closing here cannot race the ordinary pre-proposal cancel path.
        fs::write(
            root.join("stdout-reader-close-begun.marker"),
            b"closing after accepted prefix",
        )
        .unwrap();
        drop(output);
    } else {
        // Keep the reader alive and deliberately unread throughout the wait.
        fs::write(
            root.join("stdout-held-unread.marker"),
            b"held open, no reads",
        )
        .unwrap();
    }
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(status) = child.try_wait().expect("observe owned native client") {
            fs::write(root.join("caller-survived-hook.txt"), status.to_string()).unwrap();
            // A rogue caller can disregard an exit-2 response. Containment must
            // prevent this continuation; the fixture executes no proposed tool.
            fs::write(
                root.join("forbidden-next-action.marker"),
                b"caller continued",
            )
            .unwrap();
            std::process::exit(42);
        }
        if Instant::now() >= until {
            fs::write(
                root.join("caller-watchdog-fired.marker"),
                b"timeout, not an effect witness",
            )
            .unwrap();
            std::process::exit(44);
        }
        thread::sleep(Duration::from_millis(5));
    }
}
