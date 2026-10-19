//! Component qualifier for TypeScript render-request fixture bytes. The native
//! codec independently verifies the exact protocol, derived IDs and argument hash;
//! source authority, image admission and service ownership are not verified.
//! No renderer, daemon, protocol fallback, or production service owner is invoked.

use caws_native::service_journal::{
    AcceptedOutcome, Admission, Custody, Dispatch, ErrorKind, Identity, Journal,
    MAX_VERIFIED_REQUEST_BYTES, Operation, ReturnedResult,
};
use caws_native::service_protocol::decode_render_request;
use serde_json::{Value, json};
use std::{
    env,
    error::Error,
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::{fs::OpenOptionsExt, process::ExitStatusExt},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

type ProbeResult<T> = Result<T, Box<dyn Error>>;

struct Fixture {
    identity: Identity,
    bytes: Vec<u8>,
}

fn require(condition: bool, message: &'static str) -> ProbeResult<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn expires() -> Instant {
    // Qualification-only per-call budget, not a production runtime default.
    Instant::now() + Duration::from_secs(3)
}
fn read_fixture(path: &Path) -> ProbeResult<Fixture> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    require(
        metadata.file_type().is_file(),
        "request fixture must be an ordinary file",
    )?;
    require(
        metadata.len() <= MAX_VERIFIED_REQUEST_BYTES as u64,
        "request fixture exceeds the journal byte bound",
    )?;
    let mut bytes = Vec::new();
    file.take(MAX_VERIFIED_REQUEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    require(
        bytes.len() <= MAX_VERIFIED_REQUEST_BYTES,
        "request fixture grew beyond the byte bound",
    )?;
    let fields = decode_render_request(&bytes)?;
    Ok(Fixture {
        identity: Identity {
            request_id: fields.request_id,
            argument_digest: fields.argument_digest,
            project_service_key: fields.project_service_key,
            source_generation: fields.source_generation,
            execution_image_digest: fields.execution_image.image_digest,
        },
        bytes,
    })
}
fn custody(operation: &Operation, fixture: &Fixture) -> ProbeResult<()> {
    require(
        operation.identity() == &fixture.identity,
        "stored identity differs from producer fixture",
    )?;
    require(
        operation.verified_request()? == fixture.bytes,
        "stored request bytes differ from producer fixture",
    )
}
fn emit(stage: &'static str, mut fields: Value) -> ProbeResult<()> {
    let frame = fields
        .as_object_mut()
        .ok_or("stage fields must be an object")?;
    frame.insert("stage".into(), json!(stage));
    frame.insert("componentOnly".into(), json!(true));
    frame.insert("daemonDispatched".into(), json!(false));
    frame.insert("prevalidatedProducerFixture".into(), json!(true));
    frame.insert("independentProtocolValidation".into(), json!(true));
    frame.insert("authorityVerified".into(), json!(false));
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &fields)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
fn admit_new(journal: &mut Journal, fixture: &Fixture, sequence: u64) -> ProbeResult<Operation> {
    match journal.admit(fixture.identity.clone(), &fixture.bytes, expires())? {
        Admission::Accepted {
            operation,
            duplicate: false,
        } => {
            let operation = *operation;
            require(
                matches!(operation.outcome(), AcceptedOutcome::Queued { .. }),
                "new admission is not queued",
            )?;
            require(
                operation.sequence() == sequence,
                "qualification requires a fresh journal sequence",
            )?;
            custody(&operation, fixture)?;
            Ok(operation)
        }
        _ => Err("expected a new queued admission, not a duplicate or rejection".into()),
    }
}
fn lookup(journal: &Journal, fixture: &Fixture) -> ProbeResult<Operation> {
    let operation = journal
        .lookup(&fixture.identity.request_id, expires())?
        .ok_or("expected retained operation")?;
    custody(&operation, fixture)?;
    Ok(operation)
}
fn begin_first(journal: &mut Journal, first: &Fixture) -> ProbeResult<Dispatch> {
    let dispatch = journal
        .begin_next(
            &first.identity.source_generation,
            &first.identity.execution_image_digest,
            expires(),
        )?
        .ok_or("expected the first queued operation")?;
    custody(dispatch.operation(), first)?;
    require(
        matches!(
            dispatch.operation().outcome(),
            AcceptedOutcome::Running { .. }
        ),
        "dispatch is not running",
    )?;
    require(
        lookup(journal, first)? == *dispatch.operation(),
        "running operation was not retained exactly",
    )?;
    Ok(dispatch)
}
fn seed_abort(journal: &mut Journal, first: &Fixture, second: &Fixture) -> ProbeResult<()> {
    let queued_first = admit_new(journal, first, 1)?;
    let queued_second = admit_new(journal, second, 2)?;
    emit(
        "queued",
        json!({"requestIndex":1,"duplicate":false,"operation":queued_first}),
    )?;
    emit(
        "queued",
        json!({"requestIndex":2,"duplicate":false,"operation":queued_second}),
    )?;
    let dispatch = begin_first(journal, first)?;
    require(
        lookup(journal, second)? == queued_second,
        "begin changed the second queued operation",
    )?;
    emit(
        "running",
        json!({"requestIndex":1,"operation":dispatch.operation()}),
    )?;
    // Intentionally bypass every Rust Drop. The parent must observe exit 73
    // and reopen in another process; this is not a power-cut durability test.
    std::process::exit(73);
}
fn recover(journal: &mut Journal, first: &Fixture, second: &Fixture) -> ProbeResult<()> {
    let unknown = lookup(journal, first)?;
    let queued = lookup(journal, second)?;
    require(
        unknown.sequence() == 1 && queued.sequence() == 2,
        "unexpected retained ordering",
    )?;
    require(
        matches!(unknown.outcome(), AcceptedOutcome::Unknown { .. }),
        "first operation did not recover to unknown",
    )?;
    require(
        matches!(queued.outcome(), AcceptedOutcome::Queued { .. }),
        "second operation did not remain queued",
    )?;
    emit("recovered", json!({"requestIndex":1,"operation":unknown}))?;
    emit("recovered", json!({"requestIndex":2,"operation":queued}))?;
    for (index, fixture) in [(1, first), (2, second)] {
        match journal.begin_next(
            &fixture.identity.source_generation,
            &fixture.identity.execution_image_digest,
            expires(),
        ) {
            Err(error) if error.kind == ErrorKind::Fenced => {
                emit(
                    "begin-fenced",
                    json!({
                        "requestIndex":index,
                        "sourceGeneration":fixture.identity.source_generation,
                        "executionImageDigest":fixture.identity.execution_image_digest,
                        "fenced":true
                    }),
                )?;
            }
            _ => return Err("unknown operation did not fence this execution identity".into()),
        }
    }
    require(
        lookup(journal, first)? == unknown && lookup(journal, second)? == queued,
        "fenced begin changed retained state",
    )?;
    match journal.admit(first.identity.clone(), &first.bytes, expires())? {
        Admission::Accepted {
            operation,
            duplicate,
        } => {
            let operation = *operation;
            require(
                duplicate && operation == unknown,
                "duplicate did not return the exact old unknown operation",
            )?;
            emit(
                "duplicate",
                json!({"requestIndex":1,"duplicate":duplicate,"operation":operation}),
            )?;
        }
        Admission::Rejected(_) => return Err("exact duplicate was rejected".into()),
    }
    require(
        lookup(journal, second)? == queued,
        "duplicate changed the second queued operation",
    )
}
fn returned_child(journal: &mut Journal, first: &Fixture) -> ProbeResult<()> {
    let queued = admit_new(journal, first, 1)?;
    emit(
        "queued",
        json!({"requestIndex":1,"duplicate":false,"operation":queued}),
    )?;
    let dispatch = begin_first(journal, first)?;
    emit(
        "running",
        json!({"requestIndex":1,"operation":dispatch.operation()}),
    )?;
    // This exact executable's private mode exits immediately without reading
    // fixture files, opening a journal, or dispatching render work.
    let mut child = Command::new(env::current_exe()?)
        .arg("--exit-seven")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let pid = child.id();
    let status = child.wait()?;
    emit(
        "child-wait",
        json!({"pid":pid,"code":status.code(),"signal":status.signal(),"directChildReaped":true}),
    )?;
    require(
        status.code() == Some(7) && status.signal().is_none(),
        "private child did not exit seven without signal",
    )?;
    let result = ReturnedResult::ProcessExit {
        code: status.code().and_then(|code| u8::try_from(code).ok()),
        signal: status.signal().and_then(|signal| u8::try_from(signal).ok()),
    };
    let returned = journal.returned(&dispatch, result, None, expires())?;
    custody(&returned, first)?;
    require(
        matches!(
            returned.outcome(),
            AcceptedOutcome::Returned {
                result: ReturnedResult::ProcessExit {
                    code: Some(7),
                    signal: None
                },
                artifact_manifest_digest: None,
                ..
            }
        ),
        "stored returned result differs from actual child wait",
    )?;
    require(
        lookup(journal, first)? == returned,
        "returned operation was not retained exactly",
    )?;
    emit("returned", json!({"requestIndex":1,"operation":returned}))
}
fn run() -> ProbeResult<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--exit-seven" {
        std::process::exit(7);
    }
    require(
        args.len() == 4,
        "usage: <seed-abort|recover|returned-child> <dedicated-private-custody-home> <request1.json> <request2.json>",
    )?;
    let mode = args[0].to_str().ok_or("mode must be UTF-8")?;
    require(
        matches!(mode, "seed-abort" | "recover" | "returned-child"),
        "unknown qualifier mode",
    )?;
    let first = read_fixture(Path::new(&args[2]))?;
    let second = read_fixture(Path::new(&args[3]))?;
    require(
        first.identity.project_service_key == second.identity.project_service_key,
        "fixtures must have the same project/service key",
    )?;
    require(
        first.identity.request_id != second.identity.request_id,
        "fixtures must have different request IDs",
    )?;
    // This explicit qualifier mode requires pristine first-install state;
    // ordinary recovery never initializes custody on an acquire error.
    let owner = if mode == "recover" {
        Custody::acquire(Path::new(&args[1]), expires())?
    } else {
        Custody::initialize(Path::new(&args[1]), expires())?
    };
    let mut journal = Journal::open(owner, &first.identity.project_service_key, 2, expires())?;
    match mode {
        "seed-abort" => seed_abort(&mut journal, &first, &second),
        "recover" => recover(&mut journal, &first, &second),
        "returned-child" => returned_child(&mut journal, &first),
        _ => unreachable!("checked qualifier mode"),
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("service-journal-observer: {error}");
        std::process::exit(1);
    }
}
