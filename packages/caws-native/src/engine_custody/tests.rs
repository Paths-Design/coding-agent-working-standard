use super::*;
use caws_native::owned_group::{GroupObservation, SettlementStage, StopStage};
use std::os::fd::IntoRawFd;
use std::os::unix::fs::DirBuilderExt;

const CUSTODIAN: u32 = 424_242;
const NODE: u32 = 424_243;
const INVOCATION: &str = "private-custody-contract";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
type ReceiptChange = (&'static str, fn(&mut Receipt));
type ObservationChange = (&'static str, fn(&mut GroupObservation));

fn complete_snapshot() -> GroupObservation {
    GroupObservation {
        reason: 0,
        query_errno: 0,
        bytes: 128,
        capacity: 256,
        members: 2,
        zombies: 2,
        leaders: 1,
    }
}

fn complete_receipt(sequence: u64) -> Receipt {
    Receipt {
        schema: RECEIPT_SCHEMA.into(),
        invocation_id: INVOCATION.into(),
        runtime_digest: DIGEST.into(),
        sequence,
        custodian_pid: CUSTODIAN,
        node_pid: Some(NODE),
        state: ReceiptState::Complete,
        reason: Some("private contract fixture".into()),
        stop: Some(Ok(GroupStop::Signalled)),
        settlement: Some(Ok(GroupSettlement::Exited {
            observation: complete_snapshot(),
        })),
        child_exit_raw: Some(0),
        stdout_eof: true,
        stderr_eof: true,
        stdout_bytes: 17,
        stderr_bytes: 3,
        output_discarded: false,
        frontend_output_errno: None,
        error: None,
    }
}

fn started_receipt(sequence: u64) -> Receipt {
    let mut receipt = complete_receipt(sequence);
    receipt.state = ReceiptState::Started;
    receipt.stop = None;
    receipt.settlement = None;
    receipt.child_exit_raw = None;
    receipt.stdout_eof = false;
    receipt.stderr_eof = false;
    receipt
}

fn no_child_receipt(sequence: u64) -> Receipt {
    let mut receipt = complete_receipt(sequence);
    receipt.state = ReceiptState::NoChild;
    receipt.node_pid = None;
    receipt.child_exit_raw = None;
    receipt.stop = None;
    receipt.settlement = None;
    receipt.stdout_bytes = 0;
    receipt.stderr_bytes = 0;
    receipt.error = Some("node spawn refused".into());
    receipt
}

#[test]
fn terminal_receipt_requires_exit_stop_settlement_and_both_eofs() {
    assert!(complete_receipt(2).terminal());
    let changes: [ReceiptChange; 10] = [
        ("started", |r| r.state = ReceiptState::Started),
        ("pending", |r| r.state = ReceiptState::Pending),
        ("missing node", |r| r.node_pid = None),
        ("invalid node", |r| r.node_pid = Some(1)),
        ("missing exit", |r| r.child_exit_raw = None),
        ("missing stop", |r| r.stop = None),
        ("missing settlement", |r| r.settlement = None),
        ("stdout not drained", |r| r.stdout_eof = false),
        ("stderr not drained", |r| r.stderr_eof = false),
        ("worker error", |r| r.error = Some("drain failed".into())),
    ];
    for (name, change) in changes {
        let mut receipt = complete_receipt(2);
        change(&mut receipt);
        assert!(!receipt.terminal(), "incomplete receipt accepted: {name}");
    }
    let mut receipt = complete_receipt(2);
    receipt.stop = Some(Err(StopError {
        stage: StopStage::Signal,
        raw_errno: Some(libc::EPERM),
        signal_errno: Some(libc::EPERM),
        observed_pid: None,
        observed_code: None,
        group: None,
    }));
    assert!(
        !receipt.terminal(),
        "a refused stop cannot establish completion"
    );
    receipt = complete_receipt(2);
    receipt.settlement = Some(Err(SettlementError {
        stage: SettlementStage::Snapshot,
        raw_errno: Some(libc::EPERM),
        observed_pid: None,
        observed_code: None,
        before: None,
        after: None,
        group: None,
    }));
    assert!(
        !receipt.terminal(),
        "an unknown settlement cannot establish completion"
    );
}

#[test]
fn terminal_receipt_rejects_live_or_malformed_group_observations() {
    let mut receipt = complete_receipt(2);
    receipt.settlement = Some(Ok(GroupSettlement::LeaderRunning));
    assert!(!receipt.terminal());
    receipt.settlement = Some(Ok(GroupSettlement::GroupLive {
        observation: GroupObservation {
            reason: 8,
            zombies: 1,
            ..complete_snapshot()
        },
    }));
    assert!(!receipt.terminal());
    let changes: [ObservationChange; 8] = [
        ("query rejected", |g| g.reason = 3),
        ("query errno", |g| g.query_errno = libc::EPERM),
        ("empty group", |g| {
            g.members = 0;
            g.zombies = 0;
        }),
        ("live member", |g| g.zombies = 1),
        ("missing leader", |g| g.leaders = 0),
        ("duplicate leader", |g| g.leaders = 2),
        ("no snapshot bytes", |g| g.bytes = 0),
        ("full snapshot buffer", |g| g.bytes = g.capacity),
    ];
    for (name, change) in changes {
        let mut group = complete_snapshot();
        change(&mut group);
        receipt.settlement = Some(Ok(GroupSettlement::Exited { observation: group }));
        assert!(
            !receipt.terminal(),
            "malformed exited census accepted: {name}"
        );
    }
}

#[test]
fn no_child_receipt_cannot_claim_an_actual_node_or_exit() {
    let mut receipt = no_child_receipt(1);
    assert!(
        receipt.terminal(),
        "a failed spawn has no owned node to settle"
    );
    receipt.node_pid = Some(NODE);
    assert!(!receipt.terminal());
    receipt.node_pid = None;
    receipt.child_exit_raw = Some(0);
    assert!(!receipt.terminal());
    receipt.child_exit_raw = None;
    let changes: [ReceiptChange; 6] = [
        ("stop claimed", |r| r.stop = Some(Ok(GroupStop::Absent))),
        ("settlement claimed", |r| {
            r.settlement = Some(Ok(GroupSettlement::LeaderRunning))
        }),
        ("stdout open", |r| r.stdout_eof = false),
        ("stderr open", |r| r.stderr_eof = false),
        ("stdout produced", |r| r.stdout_bytes = 1),
        ("stderr produced", |r| r.stderr_bytes = 1),
    ];
    for (name, change) in changes {
        let mut invalid = receipt.clone();
        change(&mut invalid);
        assert!(!invalid.terminal(), "NoChild is inconsistent: {name}");
    }
}

struct PrivateDirectory(PathBuf);
impl PrivateDirectory {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/qualification/engine-custody-contracts")
            .join(format!(
                "{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }
}
impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

struct JournalFixture {
    owner: Owner,
    writer: File,
    _directory: PrivateDirectory,
}
impl JournalFixture {
    fn new() -> Self {
        let directory = PrivateDirectory::new();
        let path = directory.0.join("cleanup.jsonl");
        let writer = OpenOptions::new()
            .append(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        let receipt = OpenOptions::new().read(true).open(&path).unwrap();
        let owner = Owner {
            child: None,
            control: None,
            receipt,
            root: directory.0.clone(),
            invocation_id: INVOCATION.into(),
            runtime_digest: DIGEST.into(),
            custodian_pid: CUSTODIAN,
            custodian_exit: None,
            observed_length: 0,
            observed_prefix: Vec::new(),
            latest: None,
        };
        Self {
            owner,
            writer,
            _directory: directory,
        }
    }
    fn append(&mut self, receipt: &Receipt) {
        serde_json::to_writer(&mut self.writer, receipt).unwrap();
        self.writer.write_all(b"\n").unwrap();
        self.writer.flush().unwrap();
    }
}

#[test]
fn cached_abnormal_custodian_exit_cannot_turn_into_success_on_a_second_join() {
    // These are synthetic Unix wait statuses, not process IDs or signal calls.
    for raw_status in [libc::SIGTERM, 75 << 8] {
        let mut fixture = JournalFixture::new();
        fixture.append(&complete_receipt(2));
        fixture.owner.custodian_exit = Some(ExitStatus::from_raw(raw_status));
        let first = fixture.owner.cleanup().expect_err(
            "complete engine journal does not prove an abnormal custodian published cleanup",
        );
        assert!(first.contains("custodian exited abnormally"), "{first}");
        let second = fixture
            .owner
            .join_terminal(Instant::now())
            .expect_err("a repeated join must retain the original abnormal-exit refusal");
        assert_eq!(second, first);
        assert_eq!(fixture.owner.custodian_exit.unwrap().into_raw(), raw_status);
        assert!(fixture.owner.child.is_none());
        assert!(fixture.owner.control.is_none());
    }
}

#[test]
fn successful_no_child_cleanup_does_not_claim_an_engine_exit() {
    let mut fixture = JournalFixture::new();
    fixture.append(&no_child_receipt(1));
    fixture.owner.custodian_exit = Some(ExitStatus::from_raw(0));
    fixture
        .owner
        .cleanup()
        .expect("a successful no-child custodian has nothing left to clean up");
    let error = fixture
        .owner
        .finish(Instant::now())
        .expect_err("cleanup success cannot invent an engine that never spawned");
    assert!(error.starts_with("engine not spawned:"), "{error}");
    fixture
        .owner
        .cleanup()
        .expect("no-child cleanup stays idempotent after finish refuses");
    assert_eq!(fixture.owner.custodian_exit.unwrap().into_raw(), 0);
    assert!(fixture.owner.child.is_none());
    assert!(fixture.owner.control.is_none());
}

#[test]
fn refresh_accepts_correlated_monotonic_records_from_readonly_journal() {
    let mut fixture = JournalFixture::new();
    assert_eq!(
        unsafe { libc::fcntl(fixture.owner.receipt.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE,
        libc::O_RDONLY
    );
    fixture.append(&started_receipt(1));
    fixture.owner.refresh().unwrap();
    assert_eq!(fixture.owner.latest, Some(started_receipt(1)));
    fixture.append(&complete_receipt(2));
    fixture.owner.refresh().unwrap();
    assert_eq!(fixture.owner.latest, Some(complete_receipt(2)));
    fixture.owner.refresh().unwrap();
    assert_eq!(
        fixture.owner.latest,
        Some(complete_receipt(2)),
        "re-reading an unchanged journal is idempotent"
    );
}

#[test]
fn pre_creation_diagnostic_requires_complete_correlated_no_child_receipt() {
    let mut fixture = JournalFixture::new();
    assert_eq!(fixture.owner.pre_creation_failure().unwrap(), None);
    fixture.append(&no_child_receipt(1));
    assert_eq!(
        fixture.owner.pre_creation_failure().unwrap(),
        Some("node spawn refused".into())
    );
    let mut pending = JournalFixture::new();
    let mut row = started_receipt(1);
    row.error = Some("not a no-child failure".into());
    pending.append(&row);
    assert_eq!(pending.owner.pre_creation_failure().unwrap(), None);
    let mut foreign = JournalFixture::new();
    let mut row = no_child_receipt(1);
    row.invocation_id = "foreign".into();
    foreign.append(&row);
    assert!(foreign.owner.pre_creation_failure().is_err());
    let mut torn = JournalFixture::new();
    torn.writer
        .write_all(&serde_json::to_vec(&no_child_receipt(1)).unwrap())
        .unwrap();
    assert_eq!(torn.owner.pre_creation_failure().unwrap(), None);
    torn.writer.write_all(b"\n").unwrap();
    assert_eq!(
        torn.owner.pre_creation_failure().unwrap(),
        Some("node spawn refused".into())
    );
}

#[test]
fn refresh_does_not_accept_a_torn_final_complete_record() {
    let mut fixture = JournalFixture::new();
    fixture.append(&started_receipt(1));
    let final_bytes = serde_json::to_vec(&complete_receipt(2)).unwrap();
    fixture.writer.write_all(&final_bytes).unwrap();
    fixture.owner.refresh().unwrap();
    assert_eq!(fixture.owner.latest, Some(started_receipt(1)));
    assert!(!fixture.owner.latest.as_ref().unwrap().terminal());
    fixture.writer.write_all(b"\n").unwrap();
    fixture.owner.refresh().unwrap();
    assert_eq!(fixture.owner.latest, Some(complete_receipt(2)));
}

#[test]
fn refresh_refuses_invalid_complete_records_instead_of_exposing_them_as_complete() {
    let mut fixture = JournalFixture::new();
    fixture.append(&started_receipt(1));
    fixture.owner.refresh().unwrap();
    let mut invalid = complete_receipt(2);
    invalid.stderr_eof = false;
    fixture.append(&invalid);
    fixture
        .owner
        .refresh()
        .expect_err("Complete without stderr EOF must fail journal validation");
    assert_eq!(fixture.owner.latest, Some(started_receipt(1)));
}

#[test]
fn refresh_refuses_original_correlation_changes_even_without_a_child_handle() {
    let changes: [ReceiptChange; 4] = [
        ("schema", |r| {
            r.schema = "caws.engine.custody.receipt.foreign".into()
        }),
        ("invocation", |r| {
            r.invocation_id = "another-invocation".into()
        }),
        ("runtime", |r| {
            r.runtime_digest =
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()
        }),
        ("custodian", |r| r.custodian_pid = CUSTODIAN + 1),
    ];
    for (name, change) in changes {
        let mut fixture = JournalFixture::new();
        fixture.append(&started_receipt(1));
        fixture.owner.refresh().unwrap();
        let mut foreign = complete_receipt(2);
        change(&mut foreign);
        fixture.append(&foreign);
        fixture.owner.refresh().expect_err(name);
        assert_eq!(
            fixture.owner.latest,
            Some(started_receipt(1)),
            "foreign {name} must not replace the last valid receipt"
        );
    }
}

#[test]
fn refresh_refuses_duplicate_and_backwards_sequences() {
    for sequence in [1, 0] {
        let mut fixture = JournalFixture::new();
        fixture.append(&started_receipt(1));
        fixture.owner.refresh().unwrap();
        fixture.append(&complete_receipt(sequence));
        fixture
            .owner
            .refresh()
            .expect_err("journal sequence must increase strictly");
        assert_eq!(fixture.owner.latest, Some(started_receipt(1)));
    }
}

#[test]
fn refresh_refuses_nonempty_journal_shrink() {
    let mut fixture = JournalFixture::new();
    fixture.append(&complete_receipt(2));
    fixture.owner.refresh().unwrap();
    fixture.writer.set_len(0).unwrap();
    fixture
        .owner
        .refresh()
        .expect_err("a truncated journal cannot retain completion authority");
}

#[test]
fn refresh_refuses_same_length_rewrite_of_an_already_observed_prefix() {
    let mut fixture = JournalFixture::new();
    let original = started_receipt(1);
    fixture.append(&original);
    fixture.append(&complete_receipt(2));
    fixture.owner.refresh().unwrap();
    let old_length = fixture.owner.receipt.metadata().unwrap().len();
    let mut rewritten = original.clone();
    rewritten.reason = Some("altered contract fixture".into());
    let mut bytes = serde_json::to_vec(&rewritten).unwrap();
    bytes.push(b'\n');
    serde_json::to_writer(&mut bytes, &complete_receipt(2)).unwrap();
    bytes.push(b'\n');
    assert_eq!(bytes.len() as u64, old_length);
    let mut rewrite = OpenOptions::new()
        .write(true)
        .open(fixture.owner.root.join("cleanup.jsonl"))
        .unwrap();
    rewrite.write_all(&bytes).unwrap();
    rewrite.flush().unwrap();
    assert_eq!(fixture.owner.receipt.metadata().unwrap().len(), old_length);
    fixture.owner.refresh().expect_err(
        "changing an observed earlier record must fail even when length and latest receipt match",
    );
    assert_eq!(fixture.owner.latest, Some(complete_receipt(2)));
}

struct DescriptorFixture {
    directory: PrivateDirectory,
    control: OwnedFd,
    _peer: UnixStream,
    receipt: OwnedFd,
    configuration: Configuration,
}
impl DescriptorFixture {
    fn new() -> Self {
        let directory = PrivateDirectory::new();
        let (control, peer) = UnixStream::pair().unwrap();
        let control = high(control.as_raw_fd()).unwrap();
        let writer = OpenOptions::new()
            .append(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.0.join("receipt.jsonl"))
            .unwrap();
        writer
            .set_permissions(fs::Permissions::from_mode(0o600))
            .unwrap();
        let receipt = high(writer.as_raw_fd()).unwrap();
        let configuration = Configuration {
            schema: CONFIG_SCHEMA.into(),
            invocation_id: INVOCATION.into(),
            runtime_digest: DIGEST.into(),
            node: directory.0.join("private-node"),
            engine: directory.0.join("private-engine"),
            control_fd: control.as_raw_fd(),
            receipt_fd: receipt.as_raw_fd(),
            render_fds: None,
        };
        Self {
            directory,
            control,
            _peer: peer,
            receipt,
            configuration,
        }
    }
    fn invoke(&self) -> Result<WorkerInput, String> {
        let path = self.directory.0.join("configuration.json");
        let mut writer = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        serde_json::to_writer(&mut writer, &self.configuration).unwrap();
        writer.flush().unwrap();
        writer
            .set_permissions(fs::Permissions::from_mode(0o400))
            .unwrap();
        drop(writer);
        let file = OpenOptions::new().read(true).open(path).unwrap();
        let configuration = high(file.as_raw_fd()).unwrap();
        // Valid readonly private configuration transfers exactly once. All
        // rejection controls run after worker_input owns this descriptor.
        worker_input(configuration.into_raw_fd())
    }
    fn rejection(&self) -> String {
        match self.invoke() {
            Err(error) => error,
            Ok(input) => {
                // Donors still own the control/receipt descriptor numbers. An
                // unexpected admission must not introduce duplicate closes.
                std::mem::forget(input);
                panic!("unsafe custody descriptors unexpectedly admitted");
            }
        }
    }
}

#[test]
fn worker_input_accepts_private_append_receipt_and_connected_control_descriptors() {
    let fixture = DescriptorFixture::new();
    let mut input = fixture
        .invoke()
        .expect("valid private descriptors must admit");
    let DescriptorFixture {
        directory,
        control,
        mut _peer,
        receipt,
        ..
    } = fixture;
    // Transfer the donors immediately, before any assertion can unwind. The
    // admitted WorkerInput is the sole closer of these descriptor numbers.
    let _ = control.into_raw_fd();
    let _ = receipt.into_raw_fd();
    assert_eq!(input.configuration.invocation_id, INVOCATION);
    input.control.write_all(b"private control").unwrap();
    let mut bytes = [0; 15];
    _peer.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"private control");
    input.receipt.write_all(b"private journal\n").unwrap();
    assert_eq!(
        fs::read(directory.0.join("receipt.jsonl")).unwrap(),
        b"private journal\n"
    );
}

#[test]
fn descriptor_metadata_rejects_wrong_rights_and_file_type() {
    let fixture = DescriptorFixture::new();
    assert_eq!(
        metadata(fixture.receipt.as_raw_fd(), libc::O_RDONLY, false).unwrap_err(),
        "invalid custody descriptor rights"
    );
    assert_eq!(
        metadata(fixture.control.as_raw_fd(), libc::O_RDWR, false).unwrap_err(),
        "invalid custody descriptor type"
    );
}

#[test]
fn worker_input_refuses_aliased_descriptor_slots() {
    let mut fixture = DescriptorFixture::new();
    fixture.configuration.receipt_fd = fixture.configuration.control_fd;
    assert_eq!(fixture.rejection(), "aliased custody descriptor slots");
}

#[test]
fn worker_input_refuses_render_receipt_aliasing_cleanup_journal_inode() {
    let mut fixture = DescriptorFixture::new();
    let (transport, _peer) = UnixStream::pair().unwrap();
    let transport = high(transport.as_raw_fd()).unwrap();
    let grant_path = fixture.directory.0.join("render-grant.json");
    fs::write(&grant_path, b"private render grant").unwrap();
    fs::set_permissions(&grant_path, fs::Permissions::from_mode(0o400)).unwrap();
    let grant_file = File::open(grant_path).unwrap();
    let grant = high(grant_file.as_raw_fd()).unwrap();
    let render_receipt = high(fixture.receipt.as_raw_fd()).unwrap();
    assert_ne!(render_receipt.as_raw_fd(), fixture.receipt.as_raw_fd());
    let cleanup = metadata(fixture.receipt.as_raw_fd(), libc::O_WRONLY, false).unwrap();
    let render = metadata(render_receipt.as_raw_fd(), libc::O_WRONLY, false).unwrap();
    assert_eq!((cleanup.dev(), cleanup.ino()), (render.dev(), render.ino()));
    fixture.configuration.render_fds = Some([
        transport.as_raw_fd(),
        grant.as_raw_fd(),
        render_receipt.as_raw_fd(),
    ]);
    assert_eq!(fixture.rejection(), "aliased custody descriptors");
}

#[test]
fn worker_input_refuses_receipt_files_with_wrong_mode() {
    let fixture = DescriptorFixture::new();
    fs::set_permissions(
        fixture.directory.0.join("receipt.jsonl"),
        fs::Permissions::from_mode(0o400),
    )
    .unwrap();
    assert_eq!(fixture.rejection(), "unsafe custody receipt file");
}

#[test]
fn worker_input_requires_append_only_receipt_descriptor() {
    let fixture = DescriptorFixture::new();
    let flags = unsafe { libc::fcntl(fixture.receipt.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0);
    assert_eq!(
        unsafe {
            libc::fcntl(
                fixture.receipt.as_raw_fd(),
                libc::F_SETFL,
                flags & !libc::O_APPEND,
            )
        },
        0
    );
    assert_eq!(fixture.rejection(), "unsafe custody receipt file");
}
