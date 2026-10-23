//! Actual Git/native process observations. No production Render activation.
#![cfg(target_os = "macos")]
use base64::{Engine, engine::general_purpose::STANDARD};
use caws_native::{
    invocation_project::ProjectPhase,
    render_context::{Invocation, RenderContextOwner},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().canonicalize().unwrap();
        let root = base.join(format!(
            "render-context-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn env(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), self.root.to_str().unwrap().into()),
            ("LC_ALL".into(), "C".into()),
        ])
    }
    fn invocation(&self, cwd: &Path) -> Invocation {
        Invocation {
            id: "actual-render-context".into(),
            runtime_digest: "a".repeat(64),
            token: "8c766a03-c6a7-42d0-bff5-78c88fab32a1".into(),
            caller_cwd: self.root.to_str().unwrap().into(),
            cwd: cwd.to_str().unwrap().into(),
            environment: self.env(),
        }
    }
    fn wrapper(&self, body: &str) -> Invocation {
        let bin = self.root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let file = bin.join("git");
        fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
        let mut invocation = self.invocation(&self.root);
        invocation
            .environment
            .insert("PATH".into(), format!("{}:/usr/bin:/bin", bin.display()));
        invocation
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("/usr/bin/git")
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", cwd)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn repository(fixture: &Fixture, name: &str, commit: bool) -> PathBuf {
    let path = fixture.root.join(name);
    fs::create_dir(&path).unwrap();
    git(&path, &["init", "-q"]);
    git(&path, &["config", "user.name", "Context Fixture"]);
    git(&path, &["config", "user.email", "context@example.invalid"]);
    if commit {
        fs::write(path.join("tracked"), "original\n").unwrap();
        git(&path, &["add", "tracked"]);
        git(&path, &["commit", "-qm", "initial"]);
    }
    path
}
// Exact reviewed session-log.sh query/fallback pipeline, independent of native
// derivation. No fake context values or Python-calendar callback is supplied.
const ORACLE: &str = r#"set -euo pipefail
CWD="$1"
if cd "$CWD" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
 branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || branch="detached"
 head_sha=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
 dirty_count=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
else
 branch="unknown"; head_sha="unknown"; dirty_count="0"
fi
printf '%s\0%s\0%s\0%s\0' "$CWD" "$branch" "$head_sha" "$dirty_count"
"#;
fn oracle_output(invocation: &Invocation) -> std::process::Output {
    Command::new("/bin/bash")
        .args(["-c", ORACLE, "render-context-oracle", &invocation.cwd])
        .env_clear()
        .envs(&invocation.environment)
        .output()
        .unwrap()
}
fn oracle(invocation: &Invocation) -> Value {
    let output = oracle_output(invocation);
    assert!(output.status.success(), "shell oracle: {:?}", output);
    let fields: Vec<_> = output.stdout.split(|v| *v == 0).collect();
    assert_eq!(fields.len(), 5);
    json!({"cwd":std::str::from_utf8(fields[0]).unwrap(),"branch":std::str::from_utf8(fields[1]).unwrap(),"headSha":std::str::from_utf8(fields[2]).unwrap(),"dirtyFiles":std::str::from_utf8(fields[3]).unwrap()})
}
fn capture(invocation: Invocation) -> (Value, String) {
    let expires = Instant::now() + Duration::from_secs(10);
    let mut owner = RenderContextOwner::capture(invocation, expires, &|| false).unwrap();
    let observed = owner.observe(expires, &|| false).unwrap();
    assert_eq!(
        owner.observe(expires, &|| false).unwrap_err().category,
        "consumed"
    );
    for row in &observed.queries {
        assert!(
            row.cleanup.exit_observed
                && row.cleanup.group_settled
                && row.cleanup.stdout_eof
                && row.cleanup.stderr_eof
                && row.cleanup.reaped
                && !row.cleanup.ownership_retained
        );
    }
    let bytes = observed.bytes().unwrap();
    (
        serde_json::from_slice(&bytes).unwrap(),
        String::from_utf8(bytes).unwrap(),
    )
}
fn identity(invocation: &Invocation) -> Value {
    // Fixture inputs are fixed absolute PATHs; derive this before invoking the
    // producer so the TS cross-language check does not trust frame identity.
    let path = invocation.environment["PATH"]
        .split(':')
        .map(|entry| Path::new(entry).join("git"))
        .find(|path| path.is_file())
        .unwrap();
    json!({"id":invocation.id,"runtimeDigest":invocation.runtime_digest,"token":invocation.token,"cwd":invocation.cwd,"executable":{"path":path.to_str().unwrap(),"physicalPath":fs::canonicalize(&path).unwrap().to_str().unwrap(),"sha256":format!("{:x}",Sha256::digest(fs::read(&path).unwrap()))}})
}
fn compare_shell(observed: &Value, expected: &Value) {
    let queries = observed["queries"].as_array().unwrap();
    let code = |index: usize| queries[index]["exitCode"].as_i64().unwrap();
    let stdout = |index: usize| {
        STANDARD
            .decode(queries[index]["stdout"].as_str().unwrap())
            .unwrap()
    };
    let (branch, head, dirty) = if code(0) != 0 {
        assert_eq!(queries.len(), 1);
        ("unknown".into(), "unknown".into(), "0".into())
    } else {
        assert_eq!(queries.len(), 4);
        let branch = if code(1) == 0 {
            String::from_utf8(stdout(1))
                .unwrap()
                .trim_end_matches('\n')
                .to_owned()
        } else {
            "detached".into()
        };
        let mut head = stdout(2);
        if code(2) != 0 {
            head.extend_from_slice(b"unknown\n");
        }
        let head = String::from_utf8(head)
            .unwrap()
            .trim_end_matches('\n')
            .to_owned();
        assert_eq!(code(3), 0);
        (
            branch,
            head,
            stdout(3)
                .iter()
                .filter(|v| **v == b'\n')
                .count()
                .to_string(),
        )
    };
    assert_eq!(
        json!({"cwd":observed["cwd"],"branch":branch,"headSha":head,"dirtyFiles":dirty}),
        *expected
    );
}
fn retain(name: &str, rows: &[Value]) {
    if let Some(root) = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT") {
        let root = PathBuf::from(root);
        assert!(root.is_absolute() && root.is_dir());
        fs::write(
            root.join(name),
            serde_json::to_vec(
                &json!({"schema":"caws.render.context.test-captures.v1","rows":rows}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn real_normal_linked_subdirectory_detached_unborn_and_dirty_match_shell_oracle() {
    let fixture = Fixture::new();
    let main = repository(&fixture, "project", true);
    let mut rows = Vec::new();
    let mut check = |name: &str, cwd: &Path| {
        let invocation = fixture.invocation(cwd);
        let expected = oracle(&invocation);
        let identity = identity(&invocation);
        let (observation, wire) = capture(invocation);
        assert_eq!(observation["cwd"], expected["cwd"]);
        compare_shell(&observation, &expected);
        rows.push(json!({"name":name,"observation":observation,"wire":wire,"expected":expected,"identity":identity}));
    };
    check("normal", &main);
    let sub = main.join("nested");
    fs::create_dir(&sub).unwrap();
    check("subdirectory", &sub);
    let spelling = sub.join("..").join("nested");
    check("cwd-spelling", &spelling);
    let linked = fixture.root.join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-qb",
            "linked-branch",
            linked.to_str().unwrap(),
        ],
    );
    check("linked", &linked);
    git(&main, &["checkout", "--detach", "-q"]);
    check("detached", &main);
    fs::write(main.join("tracked"), "changed\n").unwrap();
    fs::write(main.join("untracked\nline"), "new").unwrap();
    check("dirty", &main);
    let unborn = repository(&fixture, "unborn", false);
    check("unborn", &unborn);
    check("outside-project", &fixture.root);
    retain("render-context-captures.json", &rows);
}

const PARTIAL: &str = r#"case "$1 $2" in
 'rev-parse --is-inside-work-tree') printf 'true\n';;
 'symbolic-ref --quiet') printf ' \tbranch \t\n\n';;
 'rev-parse --short') printf 'partial-head'; printf warning >&2; exit 7;;
 'status --porcelain') printf ' M one\n?? two\nunterminated';;
 *) exit 99;; esac"#;
#[test]
fn raw_partial_nonzero_and_invalid_utf8_survive_native_observation() {
    let fixture = Fixture::new();
    let invocation = fixture.wrapper(PARTIAL);
    let expected = oracle(&invocation);
    let original = identity(&invocation);
    let (observed, wire) = capture(invocation);
    compare_shell(&observed, &expected);
    assert_eq!(observed["queries"][2]["exitCode"], 7);
    assert_eq!(
        STANDARD
            .decode(observed["queries"][2]["stdout"].as_str().unwrap())
            .unwrap(),
        b"partial-head"
    );
    assert_eq!(expected["headSha"], "partial-headunknown");
    assert_eq!(expected["dirtyFiles"], "2");
    let mut rows = vec![
        json!({"name":"partial-nonzero","observation":observed,"wire":wire,"expected":expected,"identity":original}),
    ];
    let invalid = PARTIAL.replace(r"printf ' \tbranch \t\n\n'", r"printf '\377'");
    assert_ne!(
        invalid, PARTIAL,
        "invalid UTF-8 control must change the selected wrapper"
    );
    let invocation = fixture.wrapper(&invalid);
    let original = identity(&invocation);
    let (observed, wire) = capture(invocation);
    assert_eq!(
        STANDARD
            .decode(observed["queries"][1]["stdout"].as_str().unwrap())
            .unwrap(),
        vec![255]
    );
    rows.push(json!({"name":"invalid-utf8","observation":observed,"wire":wire,"errorCategory":"utf8","identity":original}));
    let status = PARTIAL.replace(
        r"printf ' M one\n?? two\nunterminated'",
        "printf 'partial-status'; exit 9",
    );
    let invocation = fixture.wrapper(&status);
    assert_ne!(
        status, PARTIAL,
        "status failure control must change the selected wrapper"
    );
    let shell = oracle_output(&invocation);
    assert_eq!(shell.status.code(), Some(9));
    assert!(
        shell.stdout.is_empty(),
        "pipefail must prevent projected context output"
    );
    let shell_outcome = json!({"exitCode":shell.status.code(),"stdout":STANDARD.encode(&shell.stdout),"stderr":STANDARD.encode(&shell.stderr)});
    let original = identity(&invocation);
    let (observed, wire) = capture(invocation);
    assert_eq!(observed["queries"][3]["exitCode"], 9);
    rows.push(json!({"name":"failed-status","observation":observed,"wire":wire,"errorCategory":"git_exit","identity":original,"shellOutcome":shell_outcome}));

    // These bytes never become shell variables: every stderr and probe stdout
    // is redirected away, while porcelain goes directly through wc -l.
    let ignored = format!(
        "printf '\\377\\000' >&2\n{}",
        PARTIAL
            .replace(r"printf 'true\n'", r"printf '\377\000'")
            .replace(
                r"printf ' M one\n?? two\nunterminated'",
                r"printf '\377\000\n\376\n\375'"
            )
    );
    let invocation = fixture.wrapper(&ignored);
    let expected = oracle(&invocation);
    let original = identity(&invocation);
    let (observed, wire) = capture(invocation);
    compare_shell(&observed, &expected);
    for row in observed["queries"].as_array().unwrap() {
        assert!(
            STANDARD
                .decode(row["stderr"].as_str().unwrap())
                .unwrap()
                .starts_with(&[255, 0]),
            "the actual ignored-stderr fixture must retain non-UTF8 bytes"
        );
    }
    assert_eq!(
        STANDARD
            .decode(observed["queries"][0]["stdout"].as_str().unwrap())
            .unwrap(),
        [255, 0]
    );
    assert_eq!(
        STANDARD
            .decode(observed["queries"][3]["stdout"].as_str().unwrap())
            .unwrap(),
        [255, 0, 10, 254, 10, 253]
    );
    assert_eq!(expected["dirtyFiles"], "2");
    rows.push(json!({"name":"ignored-raw-bytes","observation":observed,"wire":wire,"expected":expected,"identity":original}));

    let discarded = PARTIAL.replace(r"printf ' \tbranch \t\n\n'", r"printf '\377'; exit 1");
    assert_ne!(discarded, PARTIAL);
    let invocation = fixture.wrapper(&discarded);
    let expected = oracle(&invocation);
    let original = identity(&invocation);
    let (observed, wire) = capture(invocation);
    compare_shell(&observed, &expected);
    assert_eq!(
        STANDARD
            .decode(observed["queries"][1]["stdout"].as_str().unwrap())
            .unwrap(),
        [255]
    );
    assert_eq!(expected["branch"], "detached");
    rows.push(json!({"name":"discarded-branch-bytes","observation":observed,"wire":wire,"expected":expected,"identity":original}));

    // A successful probe printing "false" still enters the shell's then arm.
    // Bare Git subsequently refuses status; pipeline failure yields no context.
    let bare = fixture.root.join("bare.git");
    git(
        &fixture.root,
        &["init", "--bare", "-q", bare.to_str().unwrap()],
    );
    let invocation = fixture.invocation(&bare);
    let shell = oracle_output(&invocation);
    assert_eq!(shell.status.code(), Some(128));
    assert!(shell.stdout.is_empty());
    let shell_outcome = json!({"exitCode":shell.status.code(),"stdout":STANDARD.encode(&shell.stdout),"stderr":STANDARD.encode(&shell.stderr)});
    let original = identity(&invocation);
    let (observed, wire) = capture(invocation);
    assert_eq!(observed["queries"].as_array().unwrap().len(), 4);
    assert_eq!(observed["queries"][0]["exitCode"], 0);
    assert_eq!(
        STANDARD
            .decode(observed["queries"][0]["stdout"].as_str().unwrap())
            .unwrap(),
        b"false\n"
    );
    assert_eq!(observed["queries"][3]["exitCode"], 128);
    rows.push(json!({"name":"bare-repository","observation":observed,"wire":wire,"errorCategory":"git_exit","identity":original,"shellOutcome":shell_outcome}));
    retain("render-context-hostile-captures.json", &rows);
}

#[test]
fn executable_replacement_refuses_before_any_child_or_context_replay() {
    let fixture = Fixture::new();
    let invocation = fixture.wrapper(PARTIAL);
    let expires = Instant::now() + Duration::from_secs(3);
    let mut owner = RenderContextOwner::capture(invocation, expires, &|| false).unwrap();
    fs::write(fixture.root.join("bin/git"), "#!/bin/sh\nexit 99\n").unwrap();
    let mut error = owner.observe(expires, &|| false).unwrap_err();
    assert_eq!(
        error.cause.as_ref().unwrap().first_phase,
        ProjectPhase::BeforeLaunch
    );
    assert!(error.completed.is_empty());
    assert!(error.cause.as_ref().unwrap().cleanup.pid.is_none());
    error.retry_cleanup().unwrap();
    assert_eq!(
        owner.observe(expires, &|| false).unwrap_err().category,
        "consumed"
    );
}

#[test]
fn timeout_cancellation_held_pipes_and_output_exhaustion_retain_failure_and_cleanup() {
    let mut outcomes = Vec::new();
    for (name, body, phase, cancel) in [
        (
            "timeout",
            "printf admitted; /bin/sleep 30",
            ProjectPhase::QueryDeadline,
            false,
        ),
        (
            "cancelled",
            "printf admitted; /bin/sleep 30",
            ProjectPhase::Cancelled,
            true,
        ),
        (
            "held-pipes",
            "(/bin/sleep 30) & printf admitted; exit 0",
            ProjectPhase::QueryDeadline,
            false,
        ),
        (
            "output",
            "exec /usr/bin/yes x",
            ProjectPhase::OutputLimit,
            false,
        ),
    ] {
        let fixture = Fixture::new();
        let invocation = fixture.wrapper(body);
        let original = json!({
            "identity":identity(&invocation),"callerCwd":invocation.caller_cwd,
            "environment":invocation.environment,
            "wrapperPath":fixture.root.join("bin/git"),
            "wrapperBytes":format!("#!/bin/sh\n{body}\n")
        });
        let start = Instant::now();
        let expires = start + Duration::from_millis(if cancel { 2000 } else { 900 });
        let mut owner = RenderContextOwner::capture(invocation, expires, &|| false).unwrap();
        let mut error = owner
            .observe(expires + Duration::from_secs(20), &|| {
                cancel && start.elapsed() >= Duration::from_millis(100)
            })
            .unwrap_err();
        // Preserve the actual Child through retries before any assertion can
        // unwind. Closing pipes may precede its exit; an EPERM refusal is not
        // authority to reap a still-running group.
        let initial_cleanup = format!("{:?}", error.cause.as_ref().unwrap().cleanup);
        while !error.cause.as_ref().unwrap().cleanup.settled() && Instant::now() < expires {
            let _ = error.retry_cleanup();
            if !error.cause.as_ref().unwrap().cleanup.settled() {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        let settled = error.cause.as_ref().unwrap().cleanup.settled();
        outcomes.push(json!({
            "name":name,"original":original,
            "firstPhase":format!("{:?}",error.cause.as_ref().unwrap().first_phase),
            "stdoutBytes":error.stdout.len(),"stderrBytes":error.stderr.len(),
            "stdoutSha256":format!("{:x}",Sha256::digest(&error.stdout)),
            "stderrSha256":format!("{:x}",Sha256::digest(&error.stderr)),
            "initialCleanup":initial_cleanup,
            "finalCleanup":format!("{:?}",error.cause.as_ref().unwrap().cleanup),
            "settled":settled,"elapsedMillis":start.elapsed().as_millis()
        }));
        retain("render-context-lifecycle-captures.json", &outcomes);
        eprintln!("Render context lifecycle: {}", outcomes.last().unwrap());
        assert!(
            settled,
            "{name}: original Child remains uncertain: {error:?}"
        );
        assert_eq!(
            error.cause.as_ref().unwrap().first_phase,
            phase,
            "{name}: {error:?}"
        );
        assert!(error.completed.is_empty());
        assert!(error.stdout.len() + error.stderr.len() <= 1024 * 1024);
        let cleanup = &error.cause.as_ref().unwrap().cleanup;
        assert!(
            cleanup.pid.is_some(),
            "{name} must exercise an actual child"
        );
        assert_eq!(
            error.stdout.len(),
            cleanup.pipes.stdout_bytes,
            "{name} admitted stdout"
        );
        assert_eq!(
            error.stderr.len(),
            cleanup.pipes.stderr_bytes,
            "{name} admitted stderr"
        );
        if name == "cancelled" {
            // Cancellation can win after spawn but before the first read. Only
            // bytes actually admitted by that read belong in failure evidence.
            assert!(b"admitted".starts_with(&error.stdout));
        } else if name != "output" {
            assert_eq!(error.stdout, b"admitted", "{name}: {error:?}");
        }
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "original deadline was extended: {name}"
        );
        assert_eq!(
            owner.observe(expires, &|| false).unwrap_err().category,
            "consumed"
        );
    }
}

#[test]
fn unsupported_environment_never_starts_a_query_or_silently_selects_override() {
    for (key, value) in [
        ("BASH_FUNC_git%%", "() { :; }"),
        ("BASH_ENV", "/startup"),
        ("PATH", "/usr/bin::/bin"),
        ("PATH", "relative:/usr/bin"),
        ("CAWS_GIT_BINARY", "/usr/bin/false"),
    ] {
        let fixture = Fixture::new();
        let mut invocation = fixture.wrapper("printf poison > query-ran; exit 0");
        invocation.environment.insert(key.into(), value.into());
        let error = match RenderContextOwner::capture(
            invocation,
            Instant::now() + Duration::from_secs(2),
            &|| false,
        ) {
            Ok(_) => panic!("unsupported profile admitted {key}"),
            Err(error) => error,
        };
        assert!(
            matches!(error.category, "unsupported" | "selection"),
            "{error:?}"
        );
        assert!(!fixture.root.join("query-ran").exists());
    }
}

#[test]
fn proposal_token_profile_accepts_uuid_and_bound_but_refuses_malformed_before_query() {
    let fixture = Fixture::new();
    let original = fixture.wrapper("printf poison > query-ran; exit 0");
    for token in [
        "".into(),
        "a".repeat(129),
        "bad\0token".into(),
        "é".into(),
        "bad/token".into(),
        "bad\n".into(),
    ] {
        let mut invocation = fixture.invocation(&fixture.root);
        invocation.environment = original.environment.clone();
        invocation.token = token;
        let error = RenderContextOwner::capture(
            invocation,
            Instant::now() + Duration::from_secs(3),
            &|| false,
        )
        .err()
        .expect("malformed proposal token must refuse");
        assert_eq!(error.category, "unsupported");
        assert!(error.cause.is_none());
        assert!(!fixture.root.join("query-ran").exists());
    }
    let mut boundary = original;
    boundary.token = "a".repeat(128);
    assert!(
        RenderContextOwner::capture(boundary, Instant::now() + Duration::from_secs(3), &|| false)
            .is_ok()
    );
    assert!(!fixture.root.join("query-ran").exists());
}
