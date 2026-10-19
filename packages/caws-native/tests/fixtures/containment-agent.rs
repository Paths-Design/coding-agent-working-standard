//! Disposable caller for the explicit containment qualification runner.
//! Input commands are evaluated by hooks only. Permitted fixture actions are
//! marker writes in the supplied private case directory, never shell execution.
use std::{
    env, fs,
    io::Write,
    os::unix::{ffi::OsStringExt, io::FromRawFd, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use std::os::unix::process::ExitStatusExt;

unsafe extern "C" {
    fn setpgid(pid: i32, group: i32) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
}

fn event(root: &Path, stage: &str, step: &str, hook_pid: u32) {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("caller-events.jsonl"))
        .expect("open caller events");
    writeln!(
        file,
        "{{\"stage\":\"{stage}\",\"step\":\"{step}\",\"callerPid\":{},\"hookPid\":{hook_pid}}}",
        std::process::id()
    )
    .expect("write caller event");
}

fn hook(root: &Path, step: &str) -> i32 {
    let arguments = fs::read(root.join("hook-args.bin")).expect("read hook arguments");
    let arguments: Vec<_> = arguments
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| std::ffi::OsString::from_vec(part.to_vec()))
        .collect();
    let directory = root.join(step);
    let (stdout, stderr) = if step == "probe" {
        assert_eq!(env::var("PROBE_CAPTURE_FDS").as_deref(), Ok("1"));
        // SAFETY: the runner supplies private pipe ends at 3 and 4. Each is
        // consumed exactly once; the surviving runner observes their EOF.
        unsafe { (fs::File::from_raw_fd(3), fs::File::from_raw_fd(4)) }
    } else {
        (
            fs::File::create(directory.join("stdout.bin")).unwrap(),
            fs::File::create(directory.join("stderr.bin")).unwrap(),
        )
    };
    let mut command = Command::new(env::var_os("PROBE_HOOK_EXECUTABLE").expect("hook executable"));
    command
        .args(arguments)
        .stdin(Stdio::from(
            fs::File::open(directory.join("input.bin")).unwrap(),
        ))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    // SAFETY: only this newly forked hook becomes the group leader. This
    // preserves ancestry while bounding cleanup to its owned request group.
    unsafe {
        command.pre_exec(|| {
            if setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    let mut child = command.spawn().expect("spawn hook");
    drop(command); // Close caller copies of the probe pipe writers.
    event(root, "hook_started", step, child.id());
    let budget = env::var("PROBE_HOOK_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=60_000).contains(value))
        .unwrap_or(35_000);
    let deadline = Instant::now() + Duration::from_millis(budget);
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll owned hook") {
            break status;
        }
        if root.join("abort-probe").exists() || Instant::now() >= deadline {
            // The direct child is deliberately not reaped before group signals:
            // its live/zombie PID pins ownership even if TERM exits it promptly.
            unsafe {
                kill(-(child.id() as i32), 15);
            }
            thread::sleep(Duration::from_secs(1));
            unsafe {
                kill(-(child.id() as i32), 9);
            }
            let status = child.wait().expect("reap timed out owned hook");
            let code = status
                .code()
                .map_or("null".to_string(), |value| value.to_string());
            let signal = status
                .signal()
                .map_or("null".to_string(), |value| value.to_string());
            fs::write(
                directory.join("watchdog-reaped.json"),
                format!("{{\"code\":{code},\"signal\":{signal}}}\n"),
            )
            .unwrap();
            fs::write(directory.join("watchdog-reaped.txt"), status.to_string()).unwrap();
            event(root, "watchdog_cleanup", step, child.id());
            return 124;
        }
        thread::sleep(Duration::from_millis(5));
    };
    let code = status.code().unwrap_or(125);
    fs::write(directory.join("caller-observed-exit.txt"), code.to_string()).unwrap();
    event(root, "hook_returned", step, child.id());
    code
}

fn main() {
    let root = PathBuf::from(env::var_os("PROBE_CASE_ROOT").expect("private case root"));
    if env::args().any(|arg| arg == "--sibling") {
        let mut heartbeat = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("sibling-heartbeat.txt"))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut sequence = 0_u64;
        while !root.join("stop-sibling").exists() && Instant::now() < deadline {
            sequence += 1;
            writeln!(heartbeat, "{sequence}").unwrap();
            heartbeat.flush().unwrap();
            thread::sleep(Duration::from_millis(25));
        }
        fs::write(root.join("sibling-stopped.txt"), sequence.to_string()).unwrap();
        return;
    }

    fs::write(root.join("caller-pid.txt"), std::process::id().to_string()).unwrap();
    if hook(&root, "unlatched") != 0 {
        std::process::exit(21);
    }
    // Positive action control: an admitted call really reaches fixture work.
    fs::write(root.join("allowed-before-latch.marker"), "executed").unwrap();
    if hook(&root, "arm") != 2 {
        std::process::exit(22);
    }
    event(&root, "armed_and_waiting", "arm", 0);
    fs::write(root.join("ready-for-next-attempt"), b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    while !root.join("release-next-attempt").exists() {
        if root.join("abort-probe").exists() || Instant::now() >= deadline {
            std::process::exit(23);
        }
        thread::sleep(Duration::from_millis(10));
    }

    let result = hook(&root, "probe");
    if result == 0 {
        fs::write(root.join("forbidden-after-latch.marker"), "executed").unwrap();
    }
    fs::write(
        root.join("survived-after-refusal.marker"),
        result.to_string(),
    )
    .unwrap();
    if result != 2 {
        std::process::exit(24);
    }
}
