//! Private producer-to-worker startup, before the control byte protocol.
//!
//! The producer must authenticate the retained host stdio/metadata before it
//! creates this socketpair, keep its endpoint private and exclusively owned,
//! and launch the worker through the actual pinned sandbox launcher. The worker
//! independently derives the producer pin from its protected same-binary
//! generation; neither the frame nor model arguments supply that pin.
//! Kernel peer observations prove a cooperative same-host macOS PID/clock
//! domain, not sandbox placement or loaded-memory attestation. Actual placement
//! and protected generation custody remain integration obligations.
use crate::{
    execution_control::ExecutionControl,
    execution_host::ProducerPeer,
    execution_owner::{PinnedAuthorizer, TrustedInvocation},
    execution_prepared::{PreparedRecord, ProgramImage, RECORD_LIMIT},
    monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read},
    os::{
        fd::{AsFd, AsRawFd},
        unix::net::UnixStream,
    },
};

const MAX_FRAME: usize = 3 * 1024 * 1024;
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid private startup")
}
fn live(deadline: &MonotonicDeadline) -> io::Result<()> {
    deadline
        .check()
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "startup deadline expired"))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Trusted {
    invocation_id: String,
    session_id: String,
    thread_id: String,
    call_id: String,
    caller_anchor: String,
    server_environment_id: String,
    project_root: String,
    environment_anchor: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pins {
    node: ProgramImage,
    entry: ProgramImage,
    #[serde(default)]
    writer: Option<ProgramImage>,
    #[serde(default)]
    lifecycle: Option<ProgramImage>,
    #[serde(default)]
    lifecycle_context: Option<crate::execution_owner::RuntimeHomes>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Frame {
    schema: String,
    nonce: String,
    prepared_base64: String,
    prepared_sha256: String,
    trusted: Trusted,
    authorizer: Pins,
    deadline: DeadlineEnvelope,
}
/// Constructed only by the authenticated receiver. Consuming this envelope is
/// reserved for the trusted dedicated worker, which retains its control socket.
pub(crate) struct AuthenticatedStartup {
    record: PreparedRecord,
    trusted: TrustedInvocation,
    pins: PinnedAuthorizer,
    deadline: MonotonicDeadline,
    control: ExecutionControl,
    nonce: String,
}
impl AuthenticatedStartup {
    pub(crate) fn into_parts(
        self,
    ) -> (
        PreparedRecord,
        TrustedInvocation,
        PinnedAuthorizer,
        MonotonicDeadline,
        ExecutionControl,
        String,
    ) {
        (
            self.record,
            self.trusted,
            self.pins,
            self.deadline,
            self.control,
            self.nonce,
        )
    }
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_image(image: &ProgramImage) -> bool {
    std::path::Path::new(&image.path).is_absolute()
        && !image.path.contains('\0')
        && image.path.len() <= 4096
        && hex(&image.sha256, 64)
}
fn decode(bytes: &[u8]) -> io::Result<(Frame, PreparedRecord, MonotonicDeadline)> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(invalid());
    }
    let shape: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    for pointer in [
        "",
        "/trusted",
        "/authorizer",
        "/authorizer/node",
        "/authorizer/entry",
        "/deadline",
    ] {
        if !shape
            .pointer(pointer)
            .is_some_and(serde_json::Value::is_object)
        {
            return Err(invalid());
        }
    }
    // Deserialize the original bytes: typed structures reject duplicate fields.
    let frame: Frame = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if frame.schema != "caws.execution.startup.v1"
        || !hex(&frame.nonce, 32)
        || !hex(&frame.prepared_sha256, 64)
        || !valid_image(&frame.authorizer.node)
        || !valid_image(&frame.authorizer.entry)
        || frame.authorizer.writer.as_ref().is_some_and(|writer| {
            !valid_image(writer)
                || !shape
                    .pointer("/authorizer/writer")
                    .is_some_and(serde_json::Value::is_object)
        })
        || frame.authorizer.lifecycle.as_ref().is_some_and(|image| {
            !valid_image(image)
                || !shape
                    .pointer("/authorizer/lifecycle")
                    .is_some_and(serde_json::Value::is_object)
        })
        || frame
            .authorizer
            .lifecycle_context
            .as_ref()
            .is_some_and(|context| {
                !context.well_formed()
                    || frame.authorizer.lifecycle.is_none()
                    || !shape
                        .pointer("/authorizer/lifecycle_context")
                        .is_some_and(serde_json::Value::is_object)
            })
        || frame.prepared_base64.len() > 4 * RECORD_LIMIT.div_ceil(3)
    {
        return Err(invalid());
    }
    let raw = STANDARD
        .decode(&frame.prepared_base64)
        .map_err(|_| invalid())?;
    if raw.len() > RECORD_LIMIT
        || STANDARD.encode(&raw) != frame.prepared_base64
        || format!("{:x}", Sha256::digest(&raw)) != frame.prepared_sha256
    {
        return Err(invalid());
    }
    let record = PreparedRecord::decode(raw).map_err(|_| invalid())?;
    let p = record.value();
    let a = &p.association;
    let t = &frame.trusted;
    if t.invocation_id != p.invocation_id
        || t.session_id != a.session_id
        || t.thread_id != a.thread_id
        || t.call_id != a.call_id
        || t.caller_anchor != a.caller_anchor
        || t.server_environment_id != a.server_environment_id
        || t.project_root != p.project_root
        || t.environment_anchor != p.sandbox.environment_anchor
    {
        return Err(invalid());
    }
    let span = frame
        .deadline
        .expires_ns
        .checked_sub(frame.deadline.started_ns)
        .ok_or_else(invalid)?;
    if span == 0 || span > 30_000_000_000 {
        return Err(invalid());
    }
    let deadline = MonotonicDeadline::receive(frame.deadline).map_err(|_| invalid())?;
    Ok((frame, record, deadline))
}
/// Encode only a native preparer's retained record and association. The
/// receiver independently authenticates the producer and all coordinates.
pub(crate) fn encode_startup(
    prepared: &crate::execution_prepare::PreparedExecution,
    pins: &PinnedAuthorizer,
    deadline: &MonotonicDeadline,
) -> io::Result<Vec<u8>> {
    use serde_json::json;
    if prepared.sandboxed_launch.is_some()
        || matches!(
            prepared.record.value().profile.kind.as_str(),
            "npm-test-v1" | "cargo-run-v1"
        )
    {
        return Err(invalid());
    }
    let mut random = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let a = &prepared.association;
    let image = |p: &ProgramImage| json!({"path":p.path,"sha256":p.sha256});
    let body = serde_json::to_vec(&json!({
        "schema":"caws.execution.startup.v1", "nonce":nonce,
        "preparedBase64":STANDARD.encode(prepared.record.original()),
        "preparedSha256":format!("{:x}",Sha256::digest(prepared.record.original())),
        "trusted":{"invocationId":a.invocation_id,"sessionId":a.session_id,
            "threadId":a.thread_id,"callId":a.call_id,"callerAnchor":a.caller_anchor,
            "serverEnvironmentId":a.server_environment_id,"projectRoot":a.project_root,
            "environmentAnchor":a.environment_anchor},
        "authorizer":{"node":image(&pins.node),"entry":image(&pins.entry),"writer":pins.writer.as_ref().map(image),"lifecycle":pins.lifecycle.as_ref().map(image),
            "lifecycle_context":pins.lifecycle_context.as_ref().map(|homes| json!({"home":homes.home,"caws_home":homes.caws_home,"codex_home":homes.codex_home}))},
        "deadline":deadline.envelope()
    })).map_err(|_| invalid())?;
    decode(&body)?;
    let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
    bytes.extend(body);
    Ok(bytes)
}
fn read_exact_deadline(
    stream: &mut UnixStream,
    mut bytes: &mut [u8],
    deadline: &MonotonicDeadline,
) -> io::Result<()> {
    while !bytes.is_empty() {
        live(deadline)?;
        match stream.read(bytes) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "startup EOF")),
            Ok(n) => bytes = &mut bytes[n..],
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                let mut poll = libc::pollfd {
                    fd: stream.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let millis = deadline
                    .expires()
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis()
                    .min(20) as i32;
                if unsafe { libc::poll(&mut poll, 1, millis) } < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
            }
            Err(e) => return Err(e),
        }
    }
    live(deadline)
}
/// Consumes exactly one frame, without reading ahead into cancellation bytes.
/// Bootstrap bounds unauthenticated I/O only; the original deadline must remain
/// live after decoding and is never replaced with this local resource limit.
pub(crate) fn receive_startup(
    mut stream: UnixStream,
    pin: &ProgramImage,
    bootstrap: &MonotonicDeadline,
) -> io::Result<AuthenticatedStartup> {
    let envelope = bootstrap.envelope();
    let span = envelope
        .expires_ns
        .checked_sub(envelope.started_ns)
        .ok_or_else(invalid)?;
    if span == 0 || span > 30_000_000_000 {
        return Err(invalid());
    }
    let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFD) };
    if flags < 0
        || unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    let peer = ProducerPeer::capture(stream.as_fd(), pin, bootstrap)?;
    stream.set_nonblocking(true)?;
    let mut header = [0; 4];
    read_exact_deadline(&mut stream, &mut header, bootstrap)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(invalid());
    }
    let mut bytes = vec![0; length];
    read_exact_deadline(&mut stream, &mut bytes, bootstrap)?;
    peer.revalidate(stream.as_fd(), pin, bootstrap)?;
    let (frame, record, deadline) = decode(&bytes)?;
    live(&deadline)?;
    let control = ExecutionControl::new(stream)?;
    control.poll().map_err(|_| invalid())?;
    let t = frame.trusted;
    let trusted = TrustedInvocation {
        invocation_id: t.invocation_id,
        session_id: t.session_id,
        thread_id: t.thread_id,
        call_id: t.call_id,
        caller_anchor: t.caller_anchor,
        server_environment_id: t.server_environment_id,
        project_root: t.project_root,
        environment_anchor: t.environment_anchor,
        same_host_macos_verified: true,
    };
    Ok(AuthenticatedStartup {
        record,
        trusted,
        pins: PinnedAuthorizer {
            node: frame.authorizer.node,
            entry: frame.authorizer.entry,
            writer: frame.authorizer.writer,
            lifecycle: frame.authorizer.lifecycle,
            lifecycle_context: frame.authorizer.lifecycle_context,
        },
        deadline,
        control,
        nonce: frame.nonce,
    })
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{fs, io::Write, net::Shutdown, time::Duration};

    fn fixture() -> (Value, Vec<u8>) {
        let image = json!({"path":"/bin/bash","sha256":"a".repeat(64)});
        let opaque = b"{ \"future\": 1, \"future\": 2 }";
        let record = json!({"schema":"caws.execution.prepared.v1","invocationId":"invocation",
            "association":{"kind":"codex-mcp-v1","sessionId":"lineage","threadId":"thread",
                "callId":"call","callerAnchor":"/project","serverEnvironmentId":"host"},
            "projectRoot":"/project",
            "execution":{"executable":image,"argv":["/bin/bash","--noprofile","--norc","-c","printf ok"],
                "cwd":"/project","environment":[{"name":"PATH","value":"/bin:/usr/bin"}],"stdinBase64":""},
            "profile":{"kind":"bash-clean-v1","source":"printf ok","utilities":[]},
            "sandbox":{"stateBase64":STANDARD.encode(opaque),"stateSha256":format!("{:x}",Sha256::digest(opaque)),
                "launcher":image,"environmentAnchor":"/sandbox"},
            "limits":{"preparationDeadlineUnixMs":1900000000000_u64,"jobTimeoutMs":1000,
                "terminationGraceMs":100,"maxOutputBytes":4096}});
        let original = serde_json::to_vec_pretty(&record).unwrap();
        let deadline = MonotonicDeadline::capture(Duration::from_secs(30)).unwrap();
        (
            json!({"schema":"caws.execution.startup.v1","nonce":"f".repeat(32),
            "preparedBase64":STANDARD.encode(&original),"preparedSha256":format!("{:x}",Sha256::digest(&original)),
            "trusted":{"invocationId":"invocation","sessionId":"lineage","threadId":"thread",
                "callId":"call","callerAnchor":"/project","serverEnvironmentId":"host",
                "projectRoot":"/project","environmentAnchor":"/sandbox"},
            "authorizer":{"node":image,"entry":image},"deadline":deadline.envelope()}),
            original,
        )
    }
    fn own_image() -> ProgramImage {
        let path = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        ProgramImage {
            sha256: format!("{:x}", Sha256::digest(fs::read(&path).unwrap())),
            path: path.to_str().unwrap().to_owned(),
        }
    }
    fn bound() -> MonotonicDeadline {
        MonotonicDeadline::capture(Duration::from_secs(30)).unwrap()
    }
    #[test]
    fn runtime_homes_require_object_shape_complete_tuple_and_pinned_lifecycle() {
        let (mut value, _) = fixture();
        value["authorizer"]["lifecycle"] =
            json!({"path":"/trusted/lifecycle-main.js","sha256":"b".repeat(64)});
        value["authorizer"]["lifecycle_context"] = json!({"home":"/private/runtime-home","caws_home":"/private/runtime-machine","codex_home":"/private/runtime-home/.codex"});
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_ok());
        for context in [
            json!([
                "/private/runtime-home",
                "/private/runtime-machine",
                "/private/runtime-home/.codex"
            ]),
            json!({"home":"relative","caws_home":"/machine","codex_home":"relative/.codex"}),
            json!({"home":"/home","caws_home":"/machine","codex_home":"/other/.codex"}),
            json!({"home":"/home","codex_home":"/home/.codex"}),
            json!({"home":"/home","caws_home":"/machine","codex_home":"/home/.codex","extra":true}),
        ] {
            let mut bad = value.clone();
            bad["authorizer"]["lifecycle_context"] = context;
            assert!(decode(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
        value["authorizer"]["lifecycle"] = Value::Null;
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    fn framed(value: &Value) -> Vec<u8> {
        let body = serde_json::to_vec(value).unwrap();
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend(body);
        frame
    }
    #[test]
    fn producer_frame_preserves_original_bytes_and_refuses_association_disagreement() {
        let (value, original) = fixture();
        let (frame, record, deadline) = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        let t = frame.trusted;
        let mut prepared = crate::execution_prepare::PreparedExecution {
            sandboxed_launch: None,
            record,
            association: crate::execution_prepare::PreparedAssociation {
                invocation_id: t.invocation_id,
                session_id: t.session_id,
                thread_id: t.thread_id,
                call_id: t.call_id,
                caller_anchor: t.caller_anchor,
                server_environment_id: t.server_environment_id,
                project_root: t.project_root,
                environment_anchor: t.environment_anchor,
            },
        };
        let pins = PinnedAuthorizer {
            node: frame.authorizer.node,
            entry: frame.authorizer.entry,
            writer: None,
            lifecycle: None,
            lifecycle_context: None,
        };
        let bytes = encode_startup(&prepared, &pins, &deadline).unwrap();
        assert_eq!(
            u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize,
            bytes.len() - 4
        );
        let (_, decoded, observed) = decode(&bytes[4..]).unwrap();
        assert_eq!(decoded.original(), original);
        assert_eq!(observed.envelope(), deadline.envelope());
        prepared.association.call_id = "changed".into();
        assert!(encode_startup(&prepared, &pins, &deadline).is_err());
    }
    #[test]
    fn strict_startup_preserves_original_and_rejects_association_digest_and_schema_aliases() {
        let (value, original) = fixture();
        let (decoded, record, deadline) = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(record.original(), original);
        assert_eq!(deadline.envelope(), decoded.deadline);
        assert_eq!(record.sandbox_state(), b"{ \"future\": 1, \"future\": 2 }");
        for pointer in [
            "/trusted/invocationId",
            "/trusted/sessionId",
            "/trusted/threadId",
            "/trusted/callId",
            "/trusted/callerAnchor",
            "/trusted/serverEnvironmentId",
            "/trusted/projectRoot",
            "/trusted/environmentAnchor",
        ] {
            let mut bad = value.clone();
            *bad.pointer_mut(pointer).unwrap() = json!("different");
            assert!(
                decode(&serde_json::to_vec(&bad).unwrap()).is_err(),
                "{pointer}"
            );
        }
        for (key, replacement) in [
            ("preparedSha256", json!("0".repeat(64))),
            ("preparedBase64", json!("YQ")),
            ("schema", json!("foreign")),
            ("nonce", json!("f".repeat(31))),
            ("trusted", json!([])),
            ("authorizer", json!([])),
            ("deadline", json!({"startedNs":1,"expiresNs":2})),
        ] {
            let mut bad = value.clone();
            bad[key] = replacement;
            assert!(decode(&serde_json::to_vec(&bad).unwrap()).is_err(), "{key}");
        }
        let text = serde_json::to_string(&value).unwrap();
        let duplicate = format!("{{\"schema\":\"caws.execution.startup.v1\",{}", &text[1..]);
        assert!(decode(duplicate.as_bytes()).is_err());
        let mut unknown = value;
        unknown["sameHostMacosVerified"] = json!(true);
        assert!(decode(&serde_json::to_vec(&unknown).unwrap()).is_err());
    }

    #[test]
    fn lifecycle_startup_pin_preserves_exact_image_and_rejects_positional_aliases() {
        let (mut value, _) = fixture();
        value["authorizer"]["lifecycle"] =
            json!({"path":"/generation/lifecycle-main.js","sha256":"b".repeat(64)});
        let (decoded, _, _) = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        let pin = decoded.authorizer.lifecycle.unwrap();
        assert_eq!(pin.path, "/generation/lifecycle-main.js");
        assert_eq!(pin.sha256, "b".repeat(64));
        for replacement in [
            json!(["/generation/lifecycle-main.js", "b".repeat(64)]),
            json!({"path":"relative.js","sha256":"b".repeat(64)}),
            json!({"path":"/generation/lifecycle-main.js","sha256":"invalid"}),
            json!({"path":"/generation/lifecycle-main.js","sha256":"b".repeat(64),"permit":true}),
        ] {
            let mut wrong = value.clone();
            wrong["authorizer"]["lifecycle"] = replacement;
            assert!(decode(&serde_json::to_vec(&wrong).unwrap()).is_err());
        }
    }
    #[test]
    fn authenticated_socket_preserves_frame_deadline_and_observes_later_cancel() {
        let (value, original) = fixture();
        let (read, mut write) = UnixStream::pair().unwrap();
        write.write_all(&framed(&value)).unwrap();
        let started = receive_startup(read, &own_image(), &bound()).unwrap();
        let (record, trusted, _, deadline, control, nonce) = started.into_parts();
        assert_eq!(record.original(), original);
        assert!(trusted.same_host_macos_verified);
        assert_eq!(trusted.call_id, "call");
        assert_eq!(nonce, "f".repeat(32));
        assert_eq!(
            serde_json::to_value(deadline.envelope()).unwrap(),
            value["deadline"]
        );
        assert_ne!(
            unsafe { libc::fcntl(control.as_fd().as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        assert!(control.poll().is_ok());
        write.write_all(&[1]).unwrap();
        assert_eq!(
            control.poll(),
            Err(crate::execution_control::ControlFailure::Cancelled)
        );
    }
    #[test]
    fn queued_cancel_eof_wrong_pin_and_incomplete_frames_refuse() {
        let (value, _) = fixture();
        let bytes = framed(&value);
        let pin = own_image();
        for bad in [
            vec![0, 0, 0, 0],
            ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec(),
            bytes[..2].to_vec(),
            bytes[..bytes.len() - 1].to_vec(),
        ] {
            let (read, mut write) = UnixStream::pair().unwrap();
            write.write_all(&bad).unwrap();
            write.shutdown(Shutdown::Write).unwrap();
            assert!(receive_startup(read, &pin, &bound()).is_err());
        }
        for suffix in [None, Some(1), Some(7)] {
            let (read, mut write) = UnixStream::pair().unwrap();
            write.write_all(&bytes).unwrap();
            if let Some(byte) = suffix {
                write.write_all(&[byte]).unwrap();
            } else {
                write.shutdown(Shutdown::Write).unwrap();
            }
            assert!(receive_startup(read, &pin, &bound()).is_err());
        }
        let (read, _write) = UnixStream::pair().unwrap();
        let wrong = ProgramImage {
            path: pin.path,
            sha256: "0".repeat(64),
        };
        assert!(receive_startup(read, &wrong, &bound()).is_err());
    }
    #[test]
    fn exact_reads_handle_fragmentation_and_stop_at_original_bound() {
        let (mut read, mut write) = UnixStream::pair().unwrap();
        read.set_nonblocking(true).unwrap();
        let writer = std::thread::spawn(move || {
            for byte in b"frame" {
                write.write_all(&[*byte]).unwrap();
            }
            write
        });
        let mut output = [0; 5];
        read_exact_deadline(&mut read, &mut output, &bound()).unwrap();
        assert_eq!(&output, b"frame");
        let _write = writer.join().unwrap();
        let short = MonotonicDeadline::capture(Duration::from_millis(10)).unwrap();
        assert_eq!(
            read_exact_deadline(&mut read, &mut [0; 1], &short)
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
    }
}
