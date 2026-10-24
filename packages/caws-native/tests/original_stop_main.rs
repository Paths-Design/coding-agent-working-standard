//! Actual native CLI + real Node with a deliberately small protocol simulator.
//! This checks optional pre-Node discovery/replay, not maintained-engine policy,
//! OpenCode delivery, native prefix eligibility, SQL or ordinary publication.
#![cfg(target_os = "macos")]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
struct Fixture {
    base: PathBuf,
    home: PathBuf,
    root: PathBuf,
    runtime: PathBuf,
    digest: String,
    git: PathBuf,
    retain: bool,
}
impl Fixture {
    fn new(case: &str, node: &Path) -> Self {
        let retain = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT").is_some();
        let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&parent).unwrap();
        let base = parent.canonicalize().unwrap().join(format!(
            "original-stop-main-{case}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = base.join("home");
        let root = base.join("repo");
        let stage = home.join("lib/runtimes/stage");
        fs::create_dir_all(stage.join("native")).unwrap();
        fs::create_dir_all(home.join("state")).unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        // A body large enough to require multiple native-to-engine chunks.
        fs::write(root.join("selection-source"), vec![b'q'; 150_000]).unwrap();
        let native = PathBuf::from(env!("CARGO_BIN_EXE_caws-native"));
        let entry = json!({"schema":"caws.runtime.native-entry.v1","nativeExecutable":"native/caws-native","nodeExecutable":"native/node","engineEntry":"engine.js","describeEntry":"describe.js","timeoutMs":30000});
        let mut bodies = BTreeMap::from([
            ("native/caws-native".to_owned(), fs::read(&native).unwrap()),
            (
                "native/caws-hook-native".to_owned(),
                b"fixture stable-entry identity\n".to_vec(),
            ),
            ("native/node".to_owned(), fs::read(node).unwrap()),
            (
                "launcher.py".to_owned(),
                b"fixture legacy identity; never executed\n".to_vec(),
            ),
            ("engine.js".to_owned(), ENGINE.as_bytes().to_vec()),
            ("describe.js".to_owned(), b"fixture describe\n".to_vec()),
            (
                "native-entry.json".to_owned(),
                serde_json::to_vec(&entry).unwrap(),
            ),
        ]);
        let mut modes: BTreeMap<String, u32> = bodies
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    if name.starts_with("native/") {
                        0o755
                    } else {
                        0o644
                    },
                )
            })
            .collect();
        modes.insert("native-modes.json".into(), 0o644);
        bodies.insert(
            "native-modes.json".into(),
            serde_json::to_vec(&modes).unwrap(),
        );
        let mut manifest = BTreeMap::new();
        for (name, bytes) in &bodies {
            fs::write(stage.join(name), bytes).unwrap();
            fs::set_permissions(stage.join(name), fs::Permissions::from_mode(modes[name])).unwrap();
            manifest.insert(name.clone(), hash(bytes));
        }
        // The invalid-generation case deliberately prevents the optional native
        // offer, while the preexisting compatibility engine still runs.
        if case == "generation-refused" {
            manifest.insert("native/caws-native".into(), "0".repeat(64));
        }
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = hash(&bytes);
        fs::write(stage.join("manifest.json"), bytes).unwrap();
        let runtime = home.join("lib/runtimes").join(&digest);
        fs::rename(stage, &runtime).unwrap();
        fs::write(
            home.join("state/adapter-runtime.json"),
            serde_json::to_vec(&json!({"version":1,"digest":digest})).unwrap(),
        )
        .unwrap();
        let git = base.join("git-witness.sh");
        let leading = if case == "capture-refused" { "  " } else { "" };
        fs::write(&git,format!("#!/bin/sh\nprintf '%s|%s\\n' \"$PWD\" \"$*\" >> '{}'\ncase \"$*\" in\n'rev-parse --show-toplevel') printf '{leading}%s\\n' '{}' ;;\n'rev-parse --path-format=absolute --git-common-dir') printf '%s/.git\\n' '{}' ;;\n*) exit 91 ;;\nesac\n",base.join("git-queries").display(),root.display(),root.display())).unwrap();
        fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            base,
            home,
            root,
            runtime,
            digest,
            git,
            retain,
        }
    }
    fn record(&self, name: &str, value: Value) {
        fs::write(
            self.base.join(name),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.retain {
            self.record("fixture-result.json",json!({"synthetic":true,"completedWithoutPanic":!std::thread::panicking(),"root":self.root,"runtime":self.runtime}));
        } else {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
}
const ENGINE: &str = r#"
const fs=require('node:fs'),readline=require('node:readline'),crypto=require('node:crypto');
const base=process.env.CAWS_MAIN_TEST_ROOT;
const count=()=>{try{return fs.readFileSync(base+'/git-queries','utf8').trim().split('\n').filter(Boolean).length}catch{return 0}};
const initial=count();fs.writeFileSync(base+'/node-started.json',JSON.stringify({queryCount:initial,pid:process.pid}));
const input=readline.createInterface({input:process.stdin});const frames=input[Symbol.asyncIterator]();
const receive=async()=>{const row=await frames.next();if(row.done)throw Error('native EOF');return JSON.parse(row.value)};
const send=row=>process.stdout.write(JSON.stringify(row)+'\n');
(async()=>{
 const request=await receive();const token='b'.repeat(64);const rows=[];
 const mode=process.env.CAWS_MAIN_TEST_CASE||'captured';
 const capability=request.selectionObservation;
 const expectedAdvertisement=!['generation-refused','capture-refused','selection-invalid-root'].includes(mode);
 if(Boolean(capability)!==expectedAdvertisement)throw Error('selection advertisement mismatch');
 const selectionRows=[];
 let sequence=0;
 const selectionRequest=operation=>({schema:'caws.runtime.selection-observation.request.v1',id:request.id,runtimeDigest:request.runtimeDigest,snapshotId:capability.snapshotId,sequence:++sequence,operation});
 const readSelection=async operation=>{
  const control=selectionRequest(operation);send(control);
  const header=await receive();
  if(header.schema!=='caws.runtime.selection-observation.result.v1'||header.id!==request.id||header.runtimeDigest!==request.runtimeDigest||header.snapshotId!==capability.snapshotId||header.sequence!==sequence||!Number.isSafeInteger(header.byteLength)||header.byteLength<=0||header.byteLength>capability.limits.maximumBytes||!/^[a-f0-9]{64}$/.test(header.sha256))throw Error('selection header mismatch');
  let offset=0;const chunks=[];const lengths=[];
  while(offset<header.byteLength){
   const chunk=await receive();const bytes=Buffer.from(chunk.base64||'','base64');
   if(chunk.schema!=='caws.runtime.selection-observation.chunk.v1'||chunk.id!==request.id||chunk.runtimeDigest!==request.runtimeDigest||chunk.snapshotId!==capability.snapshotId||chunk.sequence!==sequence||chunk.offset!==offset||bytes.length<1||bytes.length>65536||bytes.toString('base64')!==chunk.base64||offset+bytes.length>header.byteLength)throw Error('selection chunk mismatch');
   chunks.push(bytes);lengths.push(bytes.length);offset+=bytes.length;
  }
  const bytes=Buffer.concat(chunks);if(crypto.createHash('sha256').update(bytes).digest('hex')!==header.sha256)throw Error('selection digest mismatch');
  const value=JSON.parse(bytes.toString('utf8'));
  if(value.snapshotId!==control.snapshotId||value.sequence!==control.sequence||JSON.stringify(value.operation)!==JSON.stringify(control.operation)){
   // Rust's field order differs; compare each explicit operation field instead.
   if(value.snapshotId!==control.snapshotId||value.sequence!==control.sequence||value.operation.kind!==operation.kind||value.operation.path!==operation.path)throw Error('inner selection mismatch');
  }
  selectionRows.push({header,chunkLengths:lengths,observation:value});return value;
 };
 if(capability){
  if(capability.schema!=='caws.runtime.selection-observation.v1'||typeof capability.snapshotId!=='string'||capability.limits.maximumObservations!==4096||capability.limits.maximumBytes!==67108864||capability.limits.maximumPathBytes!==16384)throw Error('native selection limits mismatch');
  const source=base+'/repo/selection-source';
  if(mode==='selection-bad-id'||mode==='selection-bad-snapshot'){
   const bad=selectionRequest({kind:'read',path:source});
   if(mode==='selection-bad-id')bad.id='different-original';else bad.snapshotId='engine-selected';
   send(bad);await receive();throw Error('invalid selection received a result');
  }
  if(mode==='selection-overlap'){
   const first=selectionRequest({kind:'read',path:source});
   process.stdout.write(JSON.stringify(first)+'\n'+JSON.stringify(first)+'\n');
   await receive();throw Error('overlapped selection received a result');
  }
  const observed=await readSelection({kind:'read',path:source});
  if(observed.result.kind!=='bytes'||!Buffer.from(observed.result.base64,'base64').equals(Buffer.alloc(150000,'q'))||selectionRows[0].chunkLengths.length<2)throw Error('selection body changed');
  if(mode==='selection-duplicate'){
   send({...selectionRequest({kind:'read',path:source}),sequence:1});await receive();throw Error('duplicate selection received a result');
  }
  if(mode==='selection-stale')fs.writeFileSync(source,'mutated-after-native-observation');
  const absent=await readSelection({kind:'exists',path:base+'/repo/absent-higher-priority'});
  if(absent.result.kind!=='exists'||absent.result.value!==false)throw Error('selection absence changed');
  const nativeNode=request.caller.environment.CAWS_MAIN_TEST_NODE;
  const digest=await readSelection({kind:'runtime-digest',path:nativeNode,singleLink:false});
  const actualNode=fs.readFileSync(nativeNode);
  if(digest.result.kind!=='runtime-digest'||digest.result.sha256!==crypto.createHash('sha256').update(actualNode).digest('hex')||digest.result.stat.size!==actualNode.length||Object.hasOwn(digest.result,'base64'))throw Error('native runtime digest mismatch');
  fs.writeFileSync(base+'/selection-observed.json',JSON.stringify({advertised:capability,rows:selectionRows}));
 }

 if(request.stopPrefix!==undefined)throw Error('unqualified Stop capability advertised');
 let cwd=JSON.parse(request.inputJson).cwd;
 for(let ordinal=1;ordinal<=2;ordinal++){
  send({schema:'caws.runtime.context-git.request.v1',id:request.id,runtimeDigest:request.runtimeDigest,token,ordinal,operation:ordinal===1?'checkout':'commonDir',executable:process.env.CAWS_GIT_BINARY,cwd});
  const result=await receive();rows.push(result);
  if(result.schema!=='caws.runtime.context-git.result.v1'||result.id!==request.id||result.token!==token||result.ordinal!==ordinal||result.status!=='exited'||result.exitCode!==0)throw Error('context result mismatch');
  cwd=Buffer.from(result.stdout,'base64').toString('utf8').trim();
 }
 fs.writeFileSync(base+'/context-observed.json',JSON.stringify({initialQueries:initial,finalQueries:count(),rows}));
 send({schema:'caws.runtime.ready.v1',id:request.id,runtimeDigest:request.runtimeDigest,active:false,budgetHome:request.caller.environment.CAWS_HOME,projectDigest:null,sessionId:null});
 const dispatch=await receive();if(dispatch.schema!=='caws.runtime.dispatch.v1')throw Error('dispatch mismatch');
 fs.writeFileSync(base+'/dispatch-observed.json',JSON.stringify(dispatch));
 if(mode==='selection-after-ready'){
  send(selectionRequest({kind:'exists',path:base+'/repo/absent-after-ready'}));await receive();throw Error('late selection received a result');
 }

 send({schema:'caws.runtime.proposal.v2',id:request.id,runtimeDigest:request.runtimeDigest,token:'fixture-token',containment:null,response:{schema:'caws.runtime.response.v1',id:request.id,runtimeDigest:request.runtimeDigest,result:{exitCode:0,stdoutBase64:Buffer.from('original-context-complete\n').toString('base64'),stderrBase64:''}}});
 const handoff=await receive();if(handoff.schema!=='caws.runtime.handoff.v2'||!handoff.success)throw Error('handoff mismatch');input.close();process.exit(0);
})().catch(error=>{fs.writeFileSync(base+'/engine-error.txt',String(error));process.stderr.write(String(error));process.exit(7)});
"#;
#[test]
fn original_capture_is_before_node_and_success_replays_without_another_git_child() {
    let node=PathBuf::from(std::env::var_os("CAWS_NATIVE_STOP_NODE").expect("serial supervisor must supply its pinned real Node executable through CAWS_NATIVE_STOP_NODE"));
    assert!(node.is_absolute());
    let mut results = Vec::new();
    for (case, initial, final_count) in [
        ("captured", 2, 2),
        ("generation-refused", 0, 2),
        ("capture-refused", 1, 3),
        ("selection-invalid-root", 2, 2),
    ] {
        let f = Fixture::new(case, &node);
        let stdout = fs::File::create(f.base.join("native.stdout")).unwrap();
        let stderr = fs::File::create(f.base.join("native.stderr")).unwrap();
        let mut child = Command::new(f.runtime.join("native/caws-native"))
            .args(["invoke", "--engine"])
            .arg(f.runtime.join("engine.js"))
            .arg("--node")
            .arg(f.runtime.join("native/node"))
            .args([
                "--surface",
                "opencode",
                "--event",
                "stop",
                "--runtime-digest",
            ])
            .arg(&f.digest)
            .args(["--timeout-ms", "30000", "--configuration", "system"])
            .current_dir(&f.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env(
                "HOME",
                if case == "selection-invalid-root" {
                    Path::new("relative-original-home")
                } else {
                    &f.base
                },
            )
            .env("CAWS_HOME", &f.home)
            .env("CAWS_PROJECT_DIR", &f.root)
            .env("CAWS_GIT_BINARY", &f.git)
            .env("CAWS_MAIN_TEST_ROOT", &f.base)
            .env("CAWS_MAIN_TEST_CASE", case)
            .env("CAWS_MAIN_TEST_NODE", f.runtime.join("native/node"))
            .stdin(Stdio::piped())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                serde_json::to_string(&json!({"session_id":"s","cwd":f.root.join("nested")}))
                    .unwrap()
                    .as_bytes(),
            )
            .unwrap();
        let until = Instant::now() + Duration::from_secs(40);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                panic!("actual native fixture exceeded bound: {}", f.base.display())
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let output = fs::read(f.base.join("native.stdout")).unwrap();
        let diagnostics = fs::read(f.base.join("native.stderr")).unwrap();
        assert!(
            status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&diagnostics)
        );
        assert_eq!(
            output,
            b"original-context-complete\n",
            "{case}: {}",
            String::from_utf8_lossy(&diagnostics)
        );
        let observed: Value =
            serde_json::from_slice(&fs::read(f.base.join("context-observed.json")).unwrap())
                .unwrap();
        assert_eq!(observed["initialQueries"], initial, "{case}");
        assert_eq!(observed["finalQueries"], final_count, "{case}");
        assert_eq!(observed["rows"].as_array().unwrap().len(), 2);
        for row in observed["rows"].as_array().unwrap() {
            for key in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
                assert_eq!(row["cleanup"][key], true, "{case}:{key}")
            }
        }
        if case == "captured" {
            let selection: Value =
                serde_json::from_slice(&fs::read(f.base.join("selection-observed.json")).unwrap())
                    .unwrap();
            assert_eq!(selection["rows"].as_array().unwrap().len(), 3);
            assert!(
                selection["rows"][0]["chunkLengths"]
                    .as_array()
                    .unwrap()
                    .len()
                    >= 2
            );
            assert_eq!(
                selection["rows"][1]["observation"]["result"],
                json!({"kind":"exists","value":false})
            );
            assert_eq!(
                selection["rows"][2]["observation"]["result"]["kind"],
                "runtime-digest"
            );
        } else {
            assert!(!f.base.join("selection-observed.json").exists());
        }
        assert!(!f.root.join(".caws/sessions").exists());
        f.record("main-observation.json",json!({"scope":"actual native CLI and real Node protocol simulator; no ordinary engine/publication claim","case":case,"exitCode":status.code(),"initialQueries":initial,"finalQueries":final_count,"observed":observed,"nativeSha256":hash(&fs::read(f.runtime.join("native/caws-native")).unwrap()),"nodeSha256":hash(&fs::read(f.runtime.join("native/node")).unwrap()),"generation":f.digest,"stdout":String::from_utf8_lossy(&output),"stderr":String::from_utf8_lossy(&diagnostics),"sessionsExist":false}));
        results.push(json!({"case":case,"root":f.base,"initialQueries":initial,"finalQueries":final_count,"exitCode":status.code()}));
    }
    println!(
        "ordinary original main capture controls: {}",
        json!(results)
    );
}

#[test]
fn native_selection_transport_refuses_invalid_overlapping_stale_and_late_requests_without_retry() {
    let node = PathBuf::from(
        std::env::var_os("CAWS_NATIVE_STOP_NODE")
            .expect("serial supervisor must supply its pinned real Node executable"),
    );
    for (case, expected, dispatched) in [
        ("selection-bad-id", "engine frame identity mismatch", false),
        (
            "selection-bad-snapshot",
            "selection observation correlation mismatch",
            false,
        ),
        (
            "selection-duplicate",
            "Selection observation correlation mismatch",
            false,
        ),
        (
            "selection-overlap",
            "engine output overlapped selection observation request",
            false,
        ),
        ("selection-stale", "Selection dependency changed", false),
        (
            "selection-after-ready",
            "selection observation request after Ready",
            true,
        ),
    ] {
        let f = Fixture::new(case, &node);
        let mut child = Command::new(f.runtime.join("native/caws-native"))
            .args(["invoke", "--engine"])
            .arg(f.runtime.join("engine.js"))
            .arg("--node")
            .arg(f.runtime.join("native/node"))
            .args([
                "--surface",
                "opencode",
                "--event",
                "stop",
                "--runtime-digest",
            ])
            .arg(&f.digest)
            .args(["--timeout-ms", "30000", "--configuration", "system"])
            .current_dir(&f.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &f.base)
            .env("CAWS_HOME", &f.home)
            .env("CAWS_PROJECT_DIR", &f.root)
            .env("CAWS_GIT_BINARY", &f.git)
            .env("CAWS_MAIN_TEST_ROOT", &f.base)
            .env("CAWS_MAIN_TEST_CASE", case)
            .env("CAWS_MAIN_TEST_NODE", f.runtime.join("native/node"))
            .stdin(Stdio::piped())
            .stdout(fs::File::create(f.base.join("native.stdout")).unwrap())
            .stderr(fs::File::create(f.base.join("native.stderr")).unwrap())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                serde_json::to_string(&json!({"session_id":"s","cwd":f.root.join("nested")}))
                    .unwrap()
                    .as_bytes(),
            )
            .unwrap();
        let until = Instant::now() + Duration::from_secs(40);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                panic!("selection fixture deadline: {}", f.base.display());
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let diagnostics = fs::read_to_string(f.base.join("native.stderr")).unwrap();
        assert!(diagnostics.contains(expected), "{case}: {diagnostics}");
        assert!(
            diagnostics.contains("request was not retried"),
            "{case}: {diagnostics}"
        );
        assert_eq!(
            fs::read(f.base.join("native.stdout")).unwrap(),
            b"",
            "{case}"
        );
        assert_eq!(
            f.base.join("dispatch-observed.json").exists(),
            dispatched,
            "{case}"
        );
        let queries = fs::read_to_string(f.base.join("git-queries")).unwrap();
        assert_eq!(
            queries.lines().count(),
            2,
            "{case}: original capture was rerun"
        );
        assert!(!f.root.join(".caws/sessions").exists());
        f.record("selection-refusal.json", json!({"scope":"actual native + real Node protocol simulator; no native eligibility/publication","case":case,"expectedDiagnostic":expected,"exitCode":status.code(),"stdout":"","stderr":diagnostics,"gitLaunches":2,"dispatchObserved":dispatched,"sessionsExist":false}));
    }
}
