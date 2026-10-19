//! Sacrificial caller for terminal transport tests. It never signals a target.
//! Its native child joins a separately pinned, test-owned cleanup group.
use std::{
    env, fs,
    io::{Read, Write},
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
fn main() {
    let root = PathBuf::from(env::var_os("TERMINAL_CASE_ROOT").expect("private case root"));
    let mode = env::var("TERMINAL_OUTPUT_MODE").expect("output mode");
    assert!(matches!(
        mode.as_str(),
        "close-after-prefix" | "full-unread"
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
    let mut command = Command::new(native);
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
    fs::write(root.join("native-pid.txt"), child.id().to_string()).unwrap();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(b"{\"session_id\":\"terminal-fixture\"}")
        .unwrap();
    drop(input);
    let mut output = child.stdout.take().unwrap();
    if mode == "close-after-prefix" {
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
