//! Whole-root substitution qualification. Starts no renderer and signals no peer.
use caws_native::service_journal::{
    AcceptedOutcome, Admission, Custody, ErrorKind, Identity, Journal,
};
use serde_json::json;
use std::{
    error::Error,
    fs,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        process::ExitStatusExt,
    },
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
fn expiry() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
fn identity(id: u64) -> Identity {
    Identity {
        request_id: format!("{id:064x}"),
        argument_digest: "d".repeat(64),
        project_service_key: "c".repeat(64),
        source_generation: "a".repeat(64),
        execution_image_digest: "b".repeat(64),
    }
}
fn mkdir(path: &Path) -> Result<()> {
    fs::create_dir(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn child_acquire(home: &Path, expected: &str) -> Result<serde_json::Value> {
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--acquire-home")
        .arg(home)
        .arg(expected)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let pid = child.id();
    let deadline = expiry();
    loop {
        if let Some(status) = child.try_wait()? {
            if status.code() != Some(0) || status.signal().is_some() {
                return Err(format!("custody observer failed: {status}").into());
            }
            return Ok(
                json!({"pid":pid,"code":status.code(),"signal":status.signal(),"directChildReaped":true,"expectedAcquireError":expected}),
            );
        }
        if Instant::now() >= deadline {
            // Only this owned direct observer can be signaled. Timeout fails
            // qualification; it never establishes absence or successful refusal.
            child.kill()?;
            let status = child.wait()?;
            return Err(format!("owned custody observer exceeded deadline: {status}").into());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn scenario(base: &Path, recover_unknown: bool) -> Result<()> {
    mkdir(base)?;
    let home = base.join("machine-home");
    mkdir(&home)?;
    let root = home.join("operations");
    let owner = Custody::initialize(&home, expiry())?;
    let first = identity(1);
    let mut old = Journal::open(Arc::clone(&owner), &first.project_service_key, 2, expiry())?;
    assert!(matches!(
        old.admit(first.clone(), b"{}", expiry())?,
        Admission::Accepted {
            duplicate: false,
            ..
        }
    ));
    let permit = old
        .begin_next(
            &first.source_generation,
            &first.execution_image_digest,
            expiry(),
        )?
        .expect("first dispatch");
    let mut retained_permit = Some(permit);
    if recover_unknown {
        drop(retained_permit.take());
        drop(old);
        old = Journal::open(Arc::clone(&owner), &first.project_service_key, 2, expiry())?;
        assert!(matches!(
            old.lookup(&first.request_id, expiry())?
                .expect("retained operation")
                .outcome(),
            AcceptedOutcome::Unknown { .. }
        ));
    }
    let record = Path::new("services")
        .join(&first.project_service_key)
        .join(format!("{}.json", first.request_id));
    let before = fs::read(root.join(&record))?;
    let retired = base.join("retired-operations");
    if recover_unknown {
        drop(old);
        drop(owner);
        fs::rename(&root, &retired)?;
        mkdir(&root)?;
    } else {
        fs::rename(&root, &retired)?;
        mkdir(&root)?;
        assert_eq!(
            old.admit(identity(2), b"{}", expiry()).unwrap_err().kind,
            ErrorKind::UnsafePath
        );
        assert_eq!(
            Journal::open(Arc::clone(&owner), &first.project_service_key, 2, expiry())
                .unwrap_err()
                .kind,
            ErrorKind::UnsafePath
        );
        drop(old);
        drop(owner);
    }
    let held_permit_observation = if let Some(permit) = retained_permit.take() {
        assert_eq!(permit.operation().identity(), &first);
        let observation = child_acquire(&home, "Busy")?;
        drop(permit);
        Some(observation)
    } else {
        None
    };
    let replacement_observation = child_acquire(&home, "UnsafePath")?;
    assert_eq!(
        Custody::acquire(&home, expiry()).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
    assert!(Custody::initialize(&home, expiry()).is_err());
    assert!(!root.join("services").exists());
    assert_eq!(fs::read(retired.join(&record))?, before);
    let old_meta = fs::metadata(&retired)?;
    let new_meta = fs::metadata(&root)?;
    assert_ne!(
        (old_meta.dev(), old_meta.ino()),
        (new_meta.dev(), new_meta.ino())
    );
    let observation = json!({
        "scenario":if recover_unknown {"recovered-unknown"} else {"outstanding-dispatch"},
        "componentOnly":true,"daemonWriteAttempted":false,"authorityVerified":false,
        "originalRoot":{"device":old_meta.dev(),"inode":old_meta.ino()},
        "replacementRoot":{"device":new_meta.dev(),"inode":new_meta.ino()},
        "heldPermitObservation":held_permit_observation,"replacementObservation":replacement_observation,
        "replacementAccepted":false,"replacementDispatch":false,"originalRecordUnchanged":true,
        "originalRecord":retired.join(record),"serializationViolation":false,
        "arbitraryRecordDeletionDetection":false,"stableCustodyHomeRequired":true
    });
    let file = base.join("observation.json");
    fs::write(&file, serde_json::to_vec_pretty(&observation)?)?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
    println!("{}", serde_json::to_string(&observation)?);
    Ok(())
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 3 && args[0] == "--acquire-home" {
        let expected = args[2].to_str().ok_or("expected error must be UTF-8")?;
        let error = Custody::acquire(
            Path::new(&args[1]),
            Instant::now() + Duration::from_millis(100),
        )
        .unwrap_err();
        assert_eq!(format!("{:?}", error.kind), expected);
        return Ok(());
    }
    if args.len() != 1 || !Path::new(&args[0]).is_absolute() {
        return Err("expected one fresh absolute artifact directory".into());
    }
    let base = Path::new(&args[0]);
    mkdir(base)?;
    scenario(&base.join("outstanding"), false)?;
    scenario(&base.join("restart"), true)
}
fn main() {
    if let Err(error) = run() {
        eprintln!("root replacement qualification failed: {error}");
        std::process::exit(2);
    }
}
