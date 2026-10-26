//! Native test child for the existing interpreter-shaped backend launch seam.
//! It implements readiness/listener lifetime only. Required .py names are inert
//! marker data; this is neither a Python runtime nor a renderer implementation.
use std::{
    env, fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
unsafe extern "C" {
    fn geteuid() -> u32;
    fn getpgrp() -> i32;
}
fn quoted(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn publish(path: &Path, body: &str) {
    let temp = path.with_extension("pending");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .unwrap();
    file.write_all(body.as_bytes()).unwrap();
    file.sync_all().unwrap();
    drop(file);
    fs::rename(temp, path).unwrap();
}
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    assert_eq!(
        args.len(),
        10,
        "fixture accepts only exact worker compatibility argv"
    );
    assert_eq!(
        args[..3].iter().map(String::as_str).collect::<Vec<_>>(),
        vec!["-I", "-S", "-B"]
    );
    assert_eq!(args[4], "--hooks-dir");
    assert_eq!(args[6], "--lease-file");
    assert_eq!(args[8], "--idle-s");
    assert_eq!(args[9], "30");
    let hooks = PathBuf::from(&args[5]);
    let lease = PathBuf::from(&args[7]);
    assert!(hooks.is_absolute() && lease.is_absolute());
    assert_eq!(hooks.canonicalize().unwrap(), hooks);
    assert_eq!(Path::new(&args[3]), hooks.join("session_log_daemon.py"));
    for name in ["session_log_daemon.py", "session_log_renderer.py"] {
        assert_eq!(
            fs::read(hooks.join(name)).unwrap(),
            b"native idle fixture marker; never executed\n"
        );
    }
    assert_eq!(fs::read_dir(hooks.join("lib")).unwrap().count(), 0);
    let root = hooks.parent().unwrap();
    assert_eq!(
        PathBuf::from(env::var_os("HOME").unwrap()),
        root.to_path_buf()
    );
    let input = root.join("backend-fingerprint.txt");
    let meta = fs::symlink_metadata(&input).unwrap();
    assert!(
        meta.is_file()
            && meta.uid() == unsafe { geteuid() }
            && meta.mode() & 0o7777 == 0o600
            && meta.nlink() == 1
            && meta.len() == 65
    );
    let mut fingerprint = String::new();
    fs::File::open(input)
        .unwrap()
        .take(66)
        .read_to_string(&mut fingerprint)
        .unwrap();
    assert!(fingerprint.ends_with('\n'));
    fingerprint.pop();
    assert!(
        fingerprint.len() == 64
            && fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let pid = std::process::id();
    let group = unsafe { getpgrp() };
    assert_eq!(group, pid as i32);
    let mut token_bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut token_bytes)
        .unwrap();
    let token = token_bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let argv = args
        .iter()
        .map(|arg| quoted(arg))
        .collect::<Vec<_>>()
        .join(",");
    publish(
        &root.join("backend-instance.json"),
        &format!(
            "{{\"pid\":{pid},\"processGroup\":{group},\"port\":{port},\"fingerprint\":{},\"argv\":[{argv}],\"interpreterExecuted\":false}}\n",
            quoted(&fingerprint)
        ),
    );
    publish(
        &lease,
        &format!(
            "{{\"pid\":{pid},\"port\":{port},\"token\":{},\"fingerprint\":{},\"hooks_dir\":{},\"served\":0}}\n",
            quoted(&token),
            quoted(&fingerprint),
            quoted(hooks.to_str().unwrap())
        ),
    );
    println!("native idle fixture ready pid={pid} group={group} port={port}");
    // Default SIGTERM disposition is intentional. The real native worker owns
    // group termination, actual wait/reap and stdout/stderr EOF observation.
    for stream in listener.incoming() {
        drop(stream.unwrap());
    }
}
