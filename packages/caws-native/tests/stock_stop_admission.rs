//! Direct admission falsifier using Cargo's actual native custodian and Git.
//! The controlled argv0 supplies only the understood ancestry fixture. The
//! generation inventory is synthetic; this does not prove installed stock
//! admission, native executable peer authentication, prefix or publication.
#![cfg(target_os = "macos")]

// Exercise private production constructors with their existing test fixture
// helpers, without a public receipt constructor or production permission seam.
#[allow(dead_code)]
#[path = "../src/cancellation.rs"]
mod cancellation;
#[allow(dead_code)]
#[path = "../src/cli.rs"]
mod cli;
#[allow(dead_code)]
#[path = "../src/installed_generation.rs"]
mod installed_generation;
#[allow(dead_code)]
#[path = "../src/native_generation.rs"]
mod native_generation;
#[allow(dead_code)]
#[path = "../src/process_effect.rs"]
mod process_effect;
#[allow(dead_code)]
#[path = "../src/protocol.rs"]
mod protocol;
#[allow(dead_code)]
#[path = "../src/selection_observation.rs"]
mod selection_observation;
#[allow(dead_code)]
#[path = "../src/sqlite_build_identity.rs"]
mod sqlite_build_identity;
#[allow(dead_code)]
#[path = "../src/stop_admission.rs"]
mod stop_admission;
#[allow(dead_code)]
#[path = "../src/stop_execution.rs"]
mod stop_execution;
#[allow(dead_code)]
#[path = "../src/stop_profile.rs"]
mod stop_profile;

use caws_native::invocation_project::{ExecutableIdentity, SelectedExecutable};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::{fs::MetadataExt, process::CommandExt},
    path::PathBuf,
    process::Command,
};

// Fixture-only executable snapshot, matching original_stop_capture.rs. Cargo
// builds this actual binary for the integration target; no mandatory runtime
// pin, caller-provided permission, PATH lookup or optional skip is introduced.
fn executor() -> SelectedExecutable {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_caws-native"));
    let physical_path = path.canonicalize().unwrap();
    let before = fs::metadata(&path).unwrap();
    let sha256 = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
    let after = fs::metadata(&path).unwrap();
    assert_eq!(
        (
            before.dev(),
            before.ino(),
            before.size(),
            before.mode(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec()
        ),
        (
            after.dev(),
            after.ino(),
            after.size(),
            after.mode(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec()
        ),
        "Cargo native custodian changed while fixture pin was read"
    );
    SelectedExecutable {
        path,
        physical_path,
        sha256,
        identity: ExecutableIdentity {
            device: after.dev(),
            inode: after.ino(),
            bytes: after.len(),
            mode: after.mode(),
            modified_seconds: after.mtime(),
            modified_nanoseconds: after.mtime_nsec(),
            changed_seconds: after.ctime(),
            changed_nanoseconds: after.ctime_nsec(),
        },
    }
}

#[test]
fn direct_admit_rejects_stale_readset_and_preserves_cancellation() {
    const TEST: &str = "direct_admit_rejects_stale_readset_and_preserves_cancellation";
    const CHILD: &str = "CAWS_STOCK_ADMIT_FALSIFIER_CHILD";
    if std::env::var_os(CHILD).is_some() {
        stop_admission::assert_admit_invalidation_with_real_custodian(&executor());
        return;
    }
    let result = Command::new(std::env::current_exe().unwrap())
        .arg0("/controlled-native-frontend/opencode")
        .args(["--exact", TEST, "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .env("COMMAND_MODE", "unix2003")
        .env_remove("CAWS_AGENT_PROCESS_NAMES")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "actual original-capture admission falsifier failed: stdout={} stderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    println!("{}", String::from_utf8_lossy(&result.stdout));
}
