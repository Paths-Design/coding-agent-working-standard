//! The private tooling command never enters the ordinary invocation fallback.
use std::process::{Command, Stdio};

#[test]
fn sqlite_identity_is_explicit_and_never_falls_back() {
    let binary = env!("CARGO_BIN_EXE_caws-native");
    let exact = Command::new(binary)
        .arg("--sqlite-build-identity")
        .stdin(Stdio::null())
        .output()
        .expect("identity command starts");
    if cfg!(feature = "sqlite-store") {
        assert!(
            exact.status.success(),
            "{}",
            String::from_utf8_lossy(&exact.stderr)
        );
        assert!(exact.stderr.is_empty());
        let value: serde_json::Value =
            serde_json::from_slice(&exact.stdout).expect("identity JSON");
        assert_eq!(value["schema"], "caws.sqlite_build_identity.v1");
        assert_eq!(value["version"], "3.53.4");
        assert_eq!(value["threadSafe"], 1);
        assert!(
            value["compiledPrefixSha256"]
                .as_str()
                .is_some_and(|s| s.len() == 64)
        );
    } else {
        assert_eq!(exact.status.code(), Some(2));
        assert!(exact.stdout.is_empty());
        assert!(String::from_utf8_lossy(&exact.stderr).contains("sqlite-store build feature"));
    }
    for arguments in [
        vec!["--sqlite-build-identity", "extra"],
        vec!["--sqlite-build-identity", "--event", "stop"],
    ] {
        let refused = Command::new(binary)
            .args(arguments)
            .stdin(Stdio::null())
            .output()
            .expect("refusal starts");
        assert_eq!(refused.status.code(), Some(2));
        assert!(refused.stdout.is_empty());
        assert!(String::from_utf8_lossy(&refused.stderr).contains("exactly one argument"));
    }
}
