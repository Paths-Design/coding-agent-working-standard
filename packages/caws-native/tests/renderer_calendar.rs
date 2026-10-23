use caws_native::renderer_calendar::{
    CapturedCalendar, FailureKind, Invocation, MAX_BATCH, MAX_REQUEST_BYTES, MAX_TOTAL_QUERIES,
    OriginalCalendar, OriginalInvocation, PROFILE, REPLY_SCHEMA, REQUEST_SCHEMA,
};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    os::unix::ffi::OsStringExt,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TOKEN: &str = "2b0cc027-897f-47ee-bc02-1849a3c1a1c0";
const ID: &str = "31415-1792757508583891000";
fn original_invocation(max_queries: usize) -> OriginalInvocation {
    OriginalInvocation {
        id: ID.into(),
        runtime_digest: "a".repeat(64),
        deadline: Instant::now() + Duration::from_secs(5),
        max_queries,
    }
}
fn invocation(max_queries: usize) -> Invocation {
    Invocation {
        id: ID.into(),
        runtime_digest: "a".repeat(64),
        token: TOKEN.into(),
        deadline: Instant::now() + Duration::from_secs(5),
        max_queries,
    }
}
fn request(sequence: u32, seconds: &[&str]) -> Value {
    json!({
        "schema": REQUEST_SCHEMA, "profile": PROFILE, "id": ID,
        "runtimeDigest": "a".repeat(64), "token": TOKEN,
        "sequence": sequence, "seconds": seconds
    })
}
fn query(owner: &mut OriginalCalendar, request: &Value) -> Result<Value, FailureKind> {
    owner
        .observe(&serde_json::to_vec(request).unwrap(), &mut || Ok(()))
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        .map_err(|error| error.kind)
}
fn expect_terminal(request: Value, expected: FailureKind) {
    let mut owner = OriginalCalendar::capture(invocation(MAX_TOTAL_QUERIES)).unwrap();
    assert_eq!(query(&mut owner, &request), Err(expected));
    assert_eq!(
        query(&mut owner, &self::request(1, &["0"])),
        Err(FailureKind::Terminal)
    );
}

#[test]
fn delayed_token_binding_preserves_the_captured_original_context() {
    let before: Vec<_> = std::env::vars_os().collect();
    let captured = CapturedCalendar::capture(original_invocation(2)).unwrap();
    let context_before_token = captured.context().clone();
    assert_eq!(context_before_token.original_pid, std::process::id());
    let mut owner = captured.bind(TOKEN.into()).unwrap();
    assert_eq!(owner.context(), &context_before_token);
    let reply = query(&mut owner, &request(1, &["0"])).unwrap();
    assert_eq!(
        reply["context"],
        serde_json::to_value(context_before_token).unwrap()
    );
    assert_eq!(reply["token"], TOKEN);
    assert_eq!(std::env::vars_os().collect::<Vec<_>>(), before);
}

#[test]
fn exact_binding_profile_schema_and_sequence_fail_closed() {
    for key in ["id", "runtimeDigest", "token"] {
        let mut frame = request(1, &["0"]);
        frame[key] = json!("another-original");
        expect_terminal(frame, FailureKind::BindingMismatch);
    }
    let mut frame = request(1, &["0"]);
    frame["profile"] = json!("another-profile");
    expect_terminal(frame, FailureKind::ProfileMismatch);
    let mut frame = request(1, &["0"]);
    frame["schema"] = json!("another-schema");
    expect_terminal(frame, FailureKind::InvalidRequest);
    for key in ["tz", "tzdir", "originalPid", "context", "deadline"] {
        let mut frame = request(1, &["0"]);
        frame[key] = json!("request-selected-context");
        expect_terminal(frame, FailureKind::InvalidRequest);
    }
    for sequence in [0, 2, u32::MAX] {
        expect_terminal(request(sequence, &["0"]), FailureKind::SequenceMismatch);
    }
    let mut owner = OriginalCalendar::capture(invocation(3)).unwrap();
    let first = query(&mut owner, &request(1, &["0"])).unwrap();
    assert_eq!(first["sequence"], 1);
    assert_eq!(
        query(&mut owner, &request(1, &["-1"])),
        Err(FailureKind::SequenceMismatch)
    );
    assert_eq!(
        query(&mut owner, &request(2, &["-1"])),
        Err(FailureKind::Terminal)
    );
}

#[test]
fn seconds_are_distinct_canonical_signed_64_bit_strings_with_finite_queries() {
    for seconds in [
        "",
        "-0",
        "+0",
        "00",
        "-01",
        " 1",
        "1 ",
        "1.0",
        "1e0",
        "０",
        "١",
        "9223372036854775808",
        "-9223372036854775809",
    ] {
        expect_terminal(request(1, &[seconds]), FailureKind::InvalidRequest);
    }
    expect_terminal(request(1, &["0", "0"]), FailureKind::InvalidRequest);
    expect_terminal(request(1, &[]), FailureKind::InvalidRequest);
    for seconds in [json!([0]), json!([null]), json!([true]), json!({"0": "0"})] {
        let mut frame = request(1, &["0"]);
        frame["seconds"] = seconds;
        expect_terminal(frame, FailureKind::InvalidRequest);
    }
    let mut frame = request(1, &["0"]);
    frame["seconds"] = json!(
        (0..=MAX_BATCH)
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
    );
    expect_terminal(frame, FailureKind::InvalidRequest);
    let mut owner = OriginalCalendar::capture(invocation(MAX_BATCH)).unwrap();
    let mut frame = request(1, &["0"]);
    frame["seconds"] = json!(
        (0..MAX_BATCH)
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
    );
    let reply = query(&mut owner, &frame).unwrap();
    assert_eq!(reply["results"].as_array().unwrap().len(), MAX_BATCH);
    assert_eq!(
        query(&mut owner, &request(2, &["-1"])),
        Err(FailureKind::QueryLimit)
    );
    let mut owner = OriginalCalendar::capture(invocation(2)).unwrap();
    assert_eq!(
        query(&mut owner, &request(1, &["0"])).unwrap()["sequence"],
        1
    );
    assert_eq!(
        query(&mut owner, &request(2, &["-1"])).unwrap()["sequence"],
        2
    );
    assert_eq!(
        query(&mut owner, &request(3, &["1"])),
        Err(FailureKind::QueryLimit)
    );
}

#[test]
fn invocation_tokens_keep_the_original_proposal_profile_and_byte_bounds() {
    for token in ["", "bad/token", "bad\0token", "non-ASCII-é", "trailing\n"] {
        let mut input = invocation(1);
        input.token = token.into();
        assert_eq!(
            OriginalCalendar::capture(input).err().unwrap().kind,
            FailureKind::InvalidInvocation
        );
    }
    let mut input = invocation(1);
    input.token = "x".repeat(129);
    assert_eq!(
        OriginalCalendar::capture(input).err().unwrap().kind,
        FailureKind::InvalidInvocation
    );
    let mut input = invocation(1);
    input.token = "._:-Az09".repeat(16);
    let mut owner = OriginalCalendar::capture(input).unwrap();
    let mut frame = request(1, &["0"]);
    frame["token"] = json!("._:-Az09".repeat(16));
    assert_eq!(query(&mut owner, &frame).unwrap()["token"], frame["token"]);
    for maximum in [0, MAX_TOTAL_QUERIES + 1] {
        assert_eq!(
            OriginalCalendar::capture(invocation(maximum))
                .err()
                .unwrap()
                .kind,
            FailureKind::InvalidInvocation
        );
    }
}

#[test]
fn malformed_frames_cancel_and_partial_batch_never_become_calendar_results() {
    let valid = serde_json::to_vec(&request(1, &["0", "-1"])).unwrap();
    for frame in [
        b"{".to_vec(),
        vec![0xff],
        vec![b' '; MAX_REQUEST_BYTES + 1],
        String::from_utf8(valid.clone())
            .unwrap()
            .replacen("\"sequence\":1", "\"sequence\":1,\"sequence\":1", 1)
            .into_bytes(),
    ] {
        let mut owner = OriginalCalendar::capture(invocation(2)).unwrap();
        assert_eq!(
            owner.observe(&frame, &mut || Ok(())).unwrap_err().kind,
            FailureKind::InvalidRequest
        );
        assert_eq!(
            owner.observe(&valid, &mut || Ok(())).unwrap_err().kind,
            FailureKind::Terminal
        );
    }
    for stop_at in [1, 5] {
        let mut owner = OriginalCalendar::capture(invocation(2)).unwrap();
        let mut checkpoints = 0;
        let failure = owner
            .observe(&valid, &mut || {
                checkpoints += 1;
                if checkpoints == stop_at {
                    Err("original invocation cancelled".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Cancelled);
        assert_eq!(checkpoints, stop_at);
        assert_eq!(
            owner.observe(&valid, &mut || Ok(())).unwrap_err().kind,
            FailureKind::Terminal
        );
    }
    let mut input = invocation(1);
    input.deadline = Instant::now();
    assert_eq!(
        OriginalCalendar::capture(input).err().unwrap().kind,
        FailureKind::Deadline
    );
}

fn fields(value: &Value) -> [i64; 6] {
    ["tmYear", "tmMon", "tmMday", "tmHour", "tmMin", "tmSec"]
        .map(|name| value[name].as_i64().unwrap())
}
fn direct_system_epoch() -> [i64; 6] {
    let epoch: libc::time_t = 0;
    let calendar = unsafe { libc::localtime(&epoch) };
    assert!(!calendar.is_null());
    let calendar = unsafe { &*calendar };
    [
        calendar.tm_year,
        calendar.tm_mon,
        calendar.tm_mday,
        calendar.tm_hour,
        calendar.tm_min,
        calendar.tm_sec,
    ]
    .map(i64::from)
}
fn direct_system_error(seconds: &str) -> Value {
    let native_seconds: libc::time_t = seconds.parse::<i64>().unwrap();
    let mut calendar = std::mem::MaybeUninit::<libc::tm>::uninit();
    #[cfg(target_os = "macos")]
    let errno = unsafe { libc::__error() };
    #[cfg(target_os = "linux")]
    let errno = unsafe { libc::__errno_location() };
    unsafe { *errno = 0 };
    let result = unsafe { libc::localtime_r(&native_seconds, calendar.as_mut_ptr()) };
    let raw_errno = unsafe { *errno };
    assert!(
        result.is_null(),
        "extreme seconds unexpectedly representable"
    );
    // The named CPython profile supplies EINVAL only when the OS left errno
    // unset. This direct OS observation is not Python-profile parity proof.
    json!({
        "seconds": seconds, "result": "null", "rawErrno": raw_errno,
        "profileErrno": if raw_errno == 0 {libc::EINVAL} else {raw_errno}
    })
}
fn child_observations(case: &str) {
    let before: Vec<_> = std::env::vars_os().collect();
    let output = PathBuf::from(std::env::var_os("CAWS_RENDERER_CALENDAR_OUTPUT").unwrap());
    if case == "non_utf8_tz" {
        let failure = CapturedCalendar::capture(original_invocation(1))
            .err()
            .unwrap();
        assert_eq!(failure.kind, FailureKind::UnsupportedEnvironment);
        fs::write(output, serde_json::to_vec(&failure).unwrap()).unwrap();
    } else {
        let seconds = [
            "0",
            "-1",
            "1710053999",
            "1710054000",
            "1730613599",
            "1730613600",
            "2147483647",
            "253402300799",
            "253402300800",
            "-9223372036854775808",
            "9223372036854775807",
            "1710037800",
            "1710055800",
            "1710052200",
            "1730597400",
            "1730611800",
            "1730525400",
        ];
        let captured = CapturedCalendar::capture(original_invocation(seconds.len())).unwrap();
        let context_before_token = captured.context().clone();
        let mut owner = captured.bind(TOKEN.into()).unwrap();
        assert_eq!(owner.context(), &context_before_token);
        assert_eq!(owner.context().original_pid, std::process::id());
        let reply = query(&mut owner, &request(1, &seconds)).unwrap();
        assert_eq!(reply["schema"], REPLY_SCHEMA);
        assert_eq!(reply["profile"], PROFILE);
        assert_eq!(reply["id"], ID);
        assert_eq!(reply["runtimeDigest"], "a".repeat(64));
        assert_eq!(reply["token"], TOKEN);
        assert_eq!(reply["sequence"], 1);
        assert_eq!(reply["context"]["originalPid"], std::process::id());
        for key in ["TZ", "TZDIR"] {
            let expected = match std::env::var_os(key) {
                None => json!({"kind": "absent"}),
                Some(value) => json!({"kind": "present", "value": value.to_str().unwrap()}),
            };
            assert_eq!(
                reply["context"][if key == "TZ" { "tz" } else { "tzdir" }],
                expected
            );
        }
        let results = reply["results"].as_array().unwrap();
        assert_eq!(results.len(), seconds.len());
        for (row, seconds) in results.iter().zip(seconds) {
            assert_eq!(row["seconds"], seconds);
        }
        assert_eq!(fields(&results[0]), direct_system_epoch());
        if case == "new_york" {
            for (index, expected) in [
                (0, [69, 11, 31, 19, 0, 0]),
                (2, [124, 2, 10, 1, 59, 59]),
                (3, [124, 2, 10, 3, 0, 0]),
                (4, [124, 10, 3, 1, 59, 59]),
                (5, [124, 10, 3, 1, 0, 0]),
                (11, [124, 2, 9, 21, 30, 0]),
                (12, [124, 2, 10, 3, 30, 0]),
                (13, [124, 2, 10, 1, 30, 0]),
                (14, [124, 10, 2, 21, 30, 0]),
                (15, [124, 10, 3, 1, 30, 0]),
                (16, [124, 10, 2, 1, 30, 0]),
            ] {
                assert_eq!(fields(&results[index]), expected);
            }
        } else if case != "absent" {
            for (index, expected) in [
                (0, [70, 0, 1, 0, 0, 0]),
                (1, [69, 11, 31, 23, 59, 59]),
                (2, [124, 2, 10, 6, 59, 59]),
                (3, [124, 2, 10, 7, 0, 0]),
                (4, [124, 10, 3, 5, 59, 59]),
                (5, [124, 10, 3, 6, 0, 0]),
                (6, [138, 0, 19, 3, 14, 7]),
                (7, [8099, 11, 31, 23, 59, 59]),
                (8, [8100, 0, 1, 0, 0, 0]),
                (11, [124, 2, 10, 2, 30, 0]),
                (12, [124, 2, 10, 7, 30, 0]),
                (13, [124, 2, 10, 6, 30, 0]),
                (14, [124, 10, 3, 1, 30, 0]),
                (15, [124, 10, 3, 5, 30, 0]),
                (16, [124, 10, 2, 5, 30, 0]),
            ] {
                assert_eq!(fields(&results[index]), expected);
            }
        }
        let error_references: Vec<_> = seconds[9..11]
            .iter()
            .map(|seconds| direct_system_error(seconds))
            .collect();
        fs::write(
            output.with_file_name(format!("{case}-os-errors.json")),
            serde_json::to_vec_pretty(&error_references).unwrap(),
        )
        .unwrap();
        for (row, reference) in results[9..11].iter().zip(&error_references) {
            assert_eq!(row["kind"], "os_error");
            assert_eq!(row["seconds"], reference["seconds"]);
            assert_eq!(row["errno"], reference["profileErrno"]);
            assert!(!row["message"].as_str().unwrap().is_empty());
            assert!(row["message"].as_str().unwrap().len() <= 128);
            assert!(row.get("tmYear").is_none());
        }
        fs::write(output, serde_json::to_vec_pretty(&reply).unwrap()).unwrap();
    }
    assert_eq!(std::env::vars_os().collect::<Vec<_>>(), before);
}

#[test]
fn original_process_timezone_observations() {
    if let Some(case) = std::env::var_os("CAWS_RENDERER_CALENDAR_CASE") {
        child_observations(case.to_str().unwrap());
        return;
    }
    let retained = std::env::var_os("CAWS_TEST_ARTIFACT_DIR");
    let root = retained
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!(
            "renderer-calendar-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&root).unwrap();
    let cases = [
        ("absent", None, None),
        ("empty", Some(""), None),
        ("utc", Some("UTC0"), None),
        ("tzdir_empty", Some("UTC0"), Some("")),
        ("tzdir_explicit", Some("UTC0"), Some("/usr/share/zoneinfo")),
        ("new_york", Some("EST5EDT,M3.2.0/2,M11.1.0/2"), None),
        ("non_utf8_tz", None, None),
    ];
    for (case, tz, tzdir) in cases {
        let output_file = root.join(format!("{case}.json"));
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "original_process_timezone_observations",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_remove("TZ")
            .env_remove("TZDIR")
            .env("CAWS_RENDERER_CALENDAR_CASE", case)
            .env("CAWS_RENDERER_CALENDAR_OUTPUT", &output_file);
        if let Some(value) = tz {
            command.env("TZ", value);
        }
        if let Some(value) = tzdir {
            command.env("TZDIR", value);
        }
        if case == "non_utf8_tz" {
            command.env("TZ", OsString::from_vec(vec![0xff]));
        }
        let output = command.output().unwrap();
        fs::write(root.join(format!("{case}.stdout.log")), &output.stdout).unwrap();
        fs::write(root.join(format!("{case}.stderr.log")), &output.stderr).unwrap();
        assert!(
            output.status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let reply: Value = serde_json::from_slice(&fs::read(output_file).unwrap()).unwrap();
        if case == "non_utf8_tz" {
            assert_eq!(reply["kind"], "unsupported_environment");
        } else {
            assert_eq!(reply["schema"], REPLY_SCHEMA);
            assert_ne!(reply["context"]["originalPid"], std::process::id());
            assert_eq!(reply["token"], TOKEN);
        }
    }
    if retained.is_none() {
        fs::remove_dir_all(root).unwrap();
    }
}
