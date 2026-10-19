---
doc_id: caws-runtime-modernization
authority: working
status: active
title: CAWS native runtime migration tracker
owner: CAWS runtime maintainers
updated: 2026-10-19
audience: maintainer
---

# CAWS native runtime migration tracker

This tracker carries the user's authorized replacement of Python implementations
with native Rust and typed TypeScript/Node across CAWS. It tracks feature progress
separately from the [architecture contract](../architecture/caws-native-runtime.md)
and canonical acceptance in `CAWS-NATIVE-RUNTIME-001`. Update the relevant row and
evidence in every logical replacement commit. Do not infer migration from a new
module, passing unit tests, or the existence of this document.

## Ownership and execution

- Goal owner: Codex chat `01a15107-5fd0-7872-8f9a-0bb7eb5f26ce`.
- Spec: `CAWS-NATIVE-RUNTIME-001`, active and bound to
  `native-runtime-modernization`.
- Source inspection baseline: `fb788cd241424ed3977081c9ad458b6c1fec7c59`.
- Lane fork/source baseline: `214ae6e01ccf7d44579a5cf9b07b13cb9b42890c`.
- Release lane `release-12-2-rc3` and other sessions' work are foreign; preserve
  their changes and reconcile shared build/package interfaces before landing.
- The migration goal remains open until replacement, integration, adoption and
  acceptance obligations are met. A completed component does not close the goal.
- Machine installation replaces the old runtime only after full parity with the
  previous selected version is established. Isolated package/harness qualification
  precedes that cutover; after cutover, verify actual selected execution here.

## Re-entry and next-work reconciliation

Before starting work after compaction, handoff or user direction, reconcile the
conversation's original objective and later corrections against this tracker's
feature, evidence, acceptance and ordered-work ledgers. Verify the current
revision, dirty state and CAWS ownership; summaries and tracker entries are
context, not proof of current behavior. Preserve outstanding obligations unless
the user supersedes them. Distinguish committed, reviewed, landed, accepted and
installed work, and correct stale next steps before choosing another task.

The terminal bridge at `e01a1b00` has completed committed-candidate review; E56
retains its clean committed replay. Neither observation closes R32 or earns
whole-runtime acceptance. E57 reproduces R33's cold-start service failure through
the actual native/typed path. The next boundary is explicit service ownership
and client integration, alongside the remaining R32 process-domain and identity
contracts. E61 exercises the R07 payload-cwd repair through the isolated native
consumer with refusal and ordinary-file controls. No machine replacement follows
from these bounded results.

Statuses: **unreplaced**, **implementing**, **implemented**, **tested**,
**packaged**, **installed**, **native-observed**, **retired**. Record exactly the
established boundary. Existing Python consumers remain obligations until removed
or explicitly classified as foreign/historical test material.

## Feature ledger

Paths beginning `runtime/`, `shared/`, or `codex/` refer to
`packages/caws-cli/templates/hook-packs/`. All features remain parent-owned;
bounded assignments transfer execution only, not acceptance ownership.

| ID | Feature / authoritative source | Destination | State | Dependency / acceptance evidence |
| --- | --- | --- | --- | --- |
| R01 | `runtime/bootstrap.py`: immutable generation bootstrap | Rust client + TS generation resolver | unreplaced | Identity tamper, upgrade, absent runtime, native error tests; package targets unproven |
| R02 | `runtime/caws-hook.py`: configuration, selection, overrides | TS invocation engine and existing authority adapters | isolated one-shot selection exercised; complete enforcement open | Shared validators and freshness/override fixtures plus E33 selected stock path; full authority and override execution require qualification |
| R03 | `runtime/caws-hook.py` and `shared/lib/run-handlers.sh`: invocation scheduling, provenance, composition and handoff | TS supervisor/journal/composer | one-shot journal/composer/local ACK integrated; resident open | E33 retains actual input/handler/index/native-output artifacts; crash persistence, production message settlement and resident admission remain open |
| R04 | `runtime/caws-hook.py`: native output and phase/event error policy | TS native-response adapter, Rust exact delivery | selected production refusal and native Stop fixture exercised | E33 nonlatching refusal; E34 real native budget with fixture context. Complete event/harness/Stop producer behavior remains unqualified |
| R05 | `shared/classify_command.py`: shell syntax and mutation classification | Typed TS classifier | component and bounded native consumer exercised | E33 bare staged-deletion refusal and explicit-path/unstaged-deletion controls; full classifier corpus, stateful consumer and harness parity remain open |
| R06 | `shared/lib/guard-config.py`: consumer policy configuration | TS configuration module | component tested; not integrated | Owning validator reused; inherited guard/threshold names rejected and Unicode code-point boundaries repaired at the shared owner |
| R07 | `shared/lib/hook-utilities.py`: rg replacement, ignored staging, focused-test and document-metadata policies | Typed TS guard utilities + bounded Git port | component and isolated native cwd repair exercised, E61; full consumer retirement open | Actual shell consumer is `shared/hook-utilities.sh`; the typed bridge preserves supplied cwd, filesystem symlink/parent traversal and absent/empty fallback. Real Git index and heredoc/routing controls are separate from installed parity; lockfile restore belongs to the classifier |
| R08 | `shared/advisory_truncate.py`: UTF-8 byte budget | TS byte truncation module | component tested; not integrated | Uncut opaque bytes and truncated invalid-byte ignore preserved; no consumer switched |
| R09 | `shared/lib/transcript-store.py`: transcript/cache persistence | TS transcript store | unreplaced | Atomic replacement, identity, replay custody, malformed and concurrent inputs |
| R10 | `shared/lib/harness_common.py`: shared transcript normalization | TS normalization interfaces/common implementation | unreplaced | Lossless occurrence/provenance and explicit unavailable fields |
| R11 | `shared/lib/harness_claude.py` | TS Claude adapter | unreplaced | Harness-specific transcript fixtures and installed render evidence |
| R12 | `shared/lib/harness_codex.py` and `codex/hooks/lib/session-transcript.py` | TS Codex adapter | unreplaced | Compaction, tool/agent identities, raw occurrence and native lifecycle fixtures |
| R13 | `shared/lib/harness_qwen.py` | TS Qwen adapter | unreplaced | Surface-specific transcript and native registration fixtures |
| R14 | `shared/lib/harness_kimi.py` | TS Kimi adapter | unreplaced | Surface-specific transcript and native registration fixtures |
| R15 | `shared/lib/harness_opencode.py` | TS OpenCode adapter | unreplaced | Surface-specific transcript and native registration fixtures |
| R16 | `shared/lib/harness_zcode.py` | TS Zcode adapter | unreplaced | Surface-specific transcript and native registration fixtures |
| R17 | `shared/lib/harness_dsh.py` | TS DSH adapter | unreplaced | Surface-specific transcript and native registration fixtures |
| R18 | `shared/session_log_renderer.py`: normalized turn rendering | TS renderer + recoverable worker | unreplaced | Complete semantic transcript fixtures, cache freshness and installed rendering |
| R19 | Python embedded in shell helpers/dispatchers | TS modules or bounded native operations | inventoried; unreplaced | 15 executable shell consumers, 19 inline bodies and seven external callsites; groups below distinguish textual interpreter mentions |
| R20 | Python developer/harvest/qualification scripts | Typed TS tooling | inventoried; unreplaced | Nine tracked script/experiment paths listed below; output/consumer equivalence remains unproven |
| R21 | Python-owned regression tests | TS/native behavioral tests | unreplaced | Thirteen test modules plus conftest (14 tracked pytest files); preserve independent hostile oracles and checked failure causes |
| R22 | Tracked installed `.caws/hooks` Python copies | Governed self-host/runtime adoption | unreplaced | Fourteen copies identified; do not edit generated/governed installation by hand |
| R23 | Rust client / versioned local protocol | `packages/caws-native` + TS protocol | POSIX one-shot transport and cancellation component tested | Signal/parent/output cancellation and bounded cleanup/delivery checked; actual typed-engine integration, resident IPC, bounded Stop recovery and installed parity remain open |
| R24 | One-shot typed engine | `packages/caws-cli/src/runtime` | opt-in prototype; isolated nonlatching Codex branch exercised | Native client runs the actual typed engine and a production-selected stock guard in E33; full chain, stateful containment, other harnesses and installation remain unqualified |
| R25 | Demand-start, warm residency and idle exit | Rust startup + TS resident host | unreplaced | Machine-wide bounded capacity, fair project/session admission, owner-specific serialization, single starter, no heartbeat authority, no active-request eviction, drain/version tests |
| R26 | Persistent request outcomes / deferred queue | TS journal/spool and bounded scheduler | unreplaced | Crash/reconnect/unknown outcomes, no blind mutation replay, isolation and bounded disk/queue |
| R27 | Package/install/upgrade/rollback and trust | Existing TS init/store adapters + native artifact distribution | unreplaced | Node >=18 compatibility, supported target builds, clean unpacked no-Python execution, rollback and native trust |
| R28 | Performance and load qualification | Replayable TS/native workload | unreplaced | Thirteen simultaneous sessions across four repositories; per-project/session distributions, stage cost, RSS, process count, fairness and bounded overload; 100 ms warm is a target |
| R29 | SOLID boundaries and existing CLI integration | Shared typed kernel/store adapters | implementing | No duplicate Rust authority engine; explicit per-request dependencies; strict compilation and consumer tests |
| R30 | Stop infrastructure budget persistence | Rust project/session budget library | library and native protocol-fixture consumption exercised | E34 persists actual native charge/refusal/release/reset snapshots; production-engine Stop, full identity and harness recovery remain unqualified |
| R31 | Machine-wide fair admission and owner-specific ordering | TS bounded scheduler | component tested; not integrated | Global/project/session queue caps, required capacity reservations, resource-domain ordering and thirteen-session/four-project controlled-worker tests; native workload proof remains open |
| R32 | Danger-latch containment across session resolution, latch state, agent PID/start verification and tool escalation | Typed containment boundary plus native process operations | blocking; terminal bridge exercises selected explicit-session Codex Bash path and larger/escaped latch state, E51–E56; complete containment parity open | Preserve the actual latch → prohibited subsequent tool → verified caller process → termination chain, exceptions/reset, native refusal and observed nonexecution. Missing-session behavior, exclusive logical-session process ownership, reset races and unqualified compatibility paths remain obligations; no installed replacement |
| R33 | Persistent extension-service lifetime, including Sterling's renderer override | Explicit service ownership and startup coordination | blocking runtime-reproduced compatibility gap, E57; unreplaced | Legacy cold start survives and serves the next request; native calls return 0 and retain expected user-turn strings while both daemon attempts disappear and the second render falls back inline. Explicit service binding/client integration, source retirement, startup races and cancellation outcomes remain open |
| R34 | Exact extension payload values across native wire, event enrichment and selected consumer | Rust raw JSON transport + typed source-span forwarding/comparison | integer regression repaired in isolated producer/consumer scenarios | E35 demonstrates old candidate rounding despite exit 0; E37 retains exact nested integers, consumer context and native refusal/control outputs. Decimal/exponent/Python normalization and all-harness parity remain unqualified |
| R35 | Complete input normalization for project policy/override handlers | Selected full compatibility dispatcher until typed normalization qualifies | conservative routing implemented; Python dispatcher retained | E37 observes Codex original tool name, file-path list, integer custody and refusal channels at the actual selected extension. R19 remains a prerequisite to replacing this compatibility path |
| R36 | Native wire control-field representation | Typed source-token validation plus decoded numeric bounds | fractional-token decoder gap repaired; IPC authentication remains separate | E40 rejects rounded fractional PID/deadline tokens and retains canonical bounds; this does not establish the agent termination target |

## Machine-wide workload and representation boundary

The user requires at least thirteen simultaneous sessions across at least four
repositories. This is a qualification workload, not a fixed maximum. Bound worker
and cache capacity across the machine, and admit work fairly across projects and
sessions. Serialize operations by their actual owning state, including canonical
project plus session for session state; retain project-store transactions for
cross-session mutations. Rendering cannot monopolize required enforcement.
Heartbeat expiry never evicts an active request or discards recoverable work.
Qualify mixed harnesses, repeated session IDs across projects, slow extensions,
large transcripts, bursts, overload and generation upgrades. Report per-project
and per-session distributions so aggregate performance cannot hide starvation.

The response protocol carries canonical base64 channels, decoded to native byte
buffers. Component fixtures preserve stdout `ff 00 61`, NUL and every byte value;
Codex JSON interpretation and generated text have explicit UTF-8 boundaries.
Composition retains its defined LF framing and raw journal captures. These
checks do not establish integration with an actual typed engine or installation.
The Stop budget also needs
project-scoped identity: a machine-global session ID cannot isolate cross-project
work. Ambiguous legacy counters remain untouched instead of acquiring a project.

## Review findings carried into implementation

The architecture document contains the grounded assumptions, severity-ranked
failure modes and proof requirements. Resolve before resident enforcement:
request-local state; request-time authority freshness; event/phase-specific error
behavior; native refusal channels; cancellation and uncertain delivery; preserved
override/library semantics; bounded scheduling; versioned persistence and runtime
identity. Heartbeats govern warm retention only.

The zero-child claim is withdrawn for arbitrary Git/CLI consumers and custom
extensions. The measurable objective removes first-party orchestration fan-out;
each remaining subprocess has a declared purpose and separately measured cost.

## Evidence ledger

| Evidence | Revision / command / observation | Scope and remaining gap |
| --- | --- | --- |
| E01 | Baseline `fb788cd2`: `caws status`, clean canonical checkout; doctor reports 0 errors / 3 warnings | Registry and hook-maintenance warnings predate migration; no native migration proof |
| E02 | Lane `214ae6e0`: `node packages/caws-cli/scripts/build-cli.js`, exit 0 | Strict existing TS layer emitted; no hook semantics or daemon execution exercised |
| E03 | Source inventory: 17 canonical runtime Python files, 16 excluding Codex shim total 8,936 lines; 14 tracked installed copies, 14 pytest files, 9 dev/experiment scripts | Embedded program inventory and full consumer mapping remain open; counts alone do not establish equivalent behavior |
| E04 | Incident session `01a14bde-75be-7f21-b95c-2c422dd3485d`, runtime digest `408c06a7cbdb1950e24f53a7486428c3a51e45bbeb86292cb9b2dec30177baa0`: pre at 42.379 s only starting fourth handler; post at 58.102 s starting audit after ten successful handlers | Existing interrupted journals demonstrate accumulated delay; isolated journaling cost and native delivery were not measured |
| E05 | Lane base `214ae6e0`, unchanged baseline runtime: focused `tests/adapter/runtime-bootstrap.test.js`, exit 0, eight fixtures | Registry ordering, strict mode and Git/non-Git context resolution exercised; no daemon or native refusal proof |
| E06 | Native worker: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test -- --test-threads=1`, exit 0; one unit and ten executable groups | Real Node fixture with empty PATH, raw input custody, malformed/oversized replies, identity mismatch, deadlines and owned process-group cleanup; production TS engine and external termination unproven |
| E07 | Lane uncommitted candidate: `node scripts/build-cli.js`, then focused Jest for `tests/runtime/{native-response,guard-config,utf8,protocol}.test.js`, exit 0; 148 checks | Native/error/context and protocol custody, configuration all-or-nothing/hostile paths, byte semantics exercised; precedes E09 selection and additional protocol boundary checks |
| E08 | Combined build after adding selection, exit 2: `src/runtime/selection.ts(184,37): TS2322 unknown is not assignable to string[]` | Jest did not execute in this attempt; fixed by validating the selected stock chain before passing it to the authority resolver |
| E09 | Lane uncommitted candidate: `node scripts/build-cli.js`, then focused Jest for `tests/runtime/{native-response,guard-config,utf8,protocol,selection}.test.js`, exit 0; 166 checks in five suites | Adds real FS selection freshness, order, adoption/tamper/override cases and protocol identity/UTF8 boundaries. Still no production engine, daemon, installation, native harness or performance proof |
| E10 | `git diff --check` exit 0; `node packages/caws-cli/scripts/validate-docs.mjs` exit 0 | Five strict-set documents valid; 30 warnings on unchanged legacy documents. Migration docs have valid front matter; this is not acceptance of their target implementation |
| E11 | Uncommitted candidate: build and six focused Jest suites (runtime modules plus owning repo-hook-policy validator), exit 0; 308 checks | Adds inherited guard/threshold rejection and Unicode prefix/reason boundary assertions at the authority owner. No consumer adoption or resident/native delivery proof |
| E12 | Initial ESLint call from the repo root found ignored paths; package-local executable path was absent; resolved root executable from package cwd found one `no-unexpected-multiline` in guard-config tests | Earlier attempts did not establish lint success. Call formatting repaired; final lint/typecheck outcome is recorded with the foundation candidate |
| E13 | Package cwd: root ESLint executable against six runtime sources, five runtime tests and owning policy tests, exit 0; `tsc -p tsconfig.vnext.test.json --pretty false`, exit 0; guard-config Jest recheck, 41 checks, exit 0 | Runtime strict typing and lint established for this component candidate. Separate `tsc -p tsconfig.kernel-test.json` exits 2 at untouched `telemetry-turn-log-schema.test.ts:237` (`usage.required` absent from inferred JSON schema type); it is not a runtime-module failure and remains unmodified |
| E14 | Foundation committed as `89fcc39f`; subsequent build passed and integrated ten-suite Jest run produced 440 pass / 2 fail | Classifier missed protected home when the platform resolves `/home` through a symlink; a kubectl read-effect oracle expected an undeclared builtin capability. Source and oracle repairs require a fresh run; passing neighboring suites are not classifier equivalence |
| E15 | Native cancellation failed attempts: Darwin empty-mask pipe polling missed a closed reader; `/dev/null` produced `POLLNVAL` and a false cancellation | Corrected by polling `POLLOUT` and restricting closed-reader inference to FIFO/socket descriptors; added real-pipe and regular-file/null-device controls. A watchdog-owned orphan was identified and its owned group terminated |
| E16 | Native worker: format, strict all-target Clippy and serial Cargo tests exited 0; three unit checks and fifteen executable groups | Nine TERM/INT/HUP phase cases, parent death, closed output, output backpressure and unrelated-process preservation exercised. A 1s request plus cleanup/delivery/diagnostic budgets finished below 2.1s in the fixture; reserve up to 1.1s overhead in integration. No SIGKILL/escaped-group, Stop recovery, harness or resident proof |

Additional component evidence:

- E17: Rebuilt classifier, composer, context and shared Git-binary suites passed
  143 checks in four suites. Real linked-checkout/canonical identity, request
  environment isolation, ordered composition and classifier repairs exercised.
  Subsequent strict sidecar byte-read correction requires another run.
- E18: Baseline Python and root-observed compiled classifier allowed
  `/bin/rm -rf /` and `/usr/bin/find . -delete` while literal controls denied or
  asked. Classification only; no destructive operation executed. Candidate
  executable-name recognition repairs this inherited hole, with read-only and
  scratch-child controls; it is an intentional repair rather than source parity.
- E19: Build and ten suites passed 456 checks, including eighty classifier cases
  with strict sidecar reads. Then the Git context reader was changed to reject
  malformed UTF8 rather than replace authority-path bytes: focused context suite
  passed nineteen checks. The quoted-token fixture passed its filtered recheck
  (one selected, seventy-nine intentionally skipped); targeted ESLint passed.
- E20: `caws specs amend` added A8 and a machine-wide isolation invariant for the
  user's thirteen-session/four-repository workload. No acceptance was recorded.
  Native Stop-budget library checks passed sixteen module cases, including same
  session IDs across projects. Initial mutation baseline failed before testing
  mutants because its copied crate lacked the sibling registry fixture. The
  library-only run tested 184 mutants: 112 caught, 55 missed, 12 unviable and five
  timeouts, exit 3. Artifacts are in
  `packages/caws-native/target/stop-budget-mutation-lib/mutants.out`; the missed
  directory/lock/read checks expose weak hostile-path fixtures and require repair.
  A delegated redirected mutation command was refused by the installed write
  guard; the owning parent verified scope and started the explicit scoped command.
- E21: The strict CLI build and targeted ESLint passed. Four focused suites
  (scheduler, composer, protocol and native-response) passed 210 checks. Scheduler
  coverage independently observes actual unresolved executors for thirteen
  sessions across four projects, machine/project peaks, exact state-owner overlap,
  rendering/required reservations, queue quotas, drain, and cancellation that
  retains capacity until execution settles. This is controlled-worker component
  evidence, not native-client fan-out or daemon recovery. The runtime test
  TypeScript configuration also compiled successfully.
- E22: Byte-based composer, response normalization and canonical binary protocol
  checks passed in the E21 run. Cancellation during awaited eligibility or start
  recording prevents handler execution; known refusals remain preserved. Rust
  formatting, all-target strict Clippy, and the full serial Cargo suite passed:
  five binary unit checks, sixteen executable groups, and twenty-seven Stop
  library checks. Executable fixtures delivered `ff 00 61` and all 256 stderr
  byte values exactly, rejected malformed/pad-bit/legacy text replies, and
  retained cancellation/backpressure bounds. This is native fixture transport,
  not an actual typed enforcement engine, native harness or installed runtime.
- E23: Following wrapper and effective-Git-context repairs, targeted ESLint and
  the strict CLI build passed. Eleven combined runtime/shared-owner suites passed
  556 checks. Real Git fixtures invert canonical versus linked-checkout HEADs and
  stage a deletion in a foreign index; joined/repeated `-C` observes the actual
  checkout, while unmodeled directory/config/environment routing grants no
  exemption. Wrapped recursive deletion, inert command arguments, read-only find
  and allowed scratch-child controls distinguish the intended behavior. These
  are classifier decisions; no destructive classified operation was executed.
- E24: Stop library repairs passed twenty-seven cases. The repaired full per-file
  mutation run tested 178 changes: 139 caught, twenty missed, fifteen unviable,
  four timeouts, exit 3. Nineteen misses have narrowly inspected Darwin
  equivalents (eighteen disjoint-flag OR/XOR, one redundant directory flag when
  opening literal `/`). The remaining fd0/stale-EEXIST test gap was repaired
  without changing production logic; its focused test passed and a targeted
  mutation rerun caught that one change, exit 0. Raw full-run score is unchanged.
  Artifacts remain under `target/stop-budget-mutation-repaired/mutants.out` and
  `target/stop-budget-mutation-fd-zero/mutants.out` in the native crate. This does
  not establish other-target equivalence, power-loss durability or native Stop
  integration. Unavailable-after-commit outcomes must not be retried.
- E25: Caller-wire native all-target Clippy passed. The full serial Cargo run
  exited 101: twenty-seven library cases and five binary units passed, with
  sixteen of eighteen executable groups passing. The new concurrent-caller case
  preserved independent cwd/environment/entry mode. One failed fixture attempted
  a non-UTF8 filename that this Darwin filesystem rejects at `mkdir`; executable
  rejection now covers native environment bytes and does not claim that path
  case. The held-pipe fixture lacked its child marker under a 350 ms cold-start
  allowance; its request budget is two seconds with an asserted 3.5-second total
  ceiling and mandatory child/foreign-process checks. Both corrected focused
  executable tests passed. This is not a fresh all-suite pass or typed-engine
  integration proof.

- E26: Strict CLI build and runtime TypeScript check passed. Ten combined suites
  passed 647 checks in 82.779 seconds, including classifier, guard utilities,
  caller context, protocol, composer, scheduler, selection, native response,
  guard configuration and shared policy validation. Classifier controls cover
  `env -S` option/argument custody, substitution-local directories, unsupported
  routing and deep nesting; utility controls include real Git index immutability,
  inert heredocs and executing substitutions. These checks do not establish
  native engine integration, installed behavior or complete shell soundness.

## Embedded and developer implementation coverage

Additional bounded evidence and unresolved dependencies:

- E27: The Stop-budget session key previously aliased `CaseA` and `casea` on
  case-insensitive filesystems. The exact-byte key uses lowercase unpadded
  base32, at most 209 bytes for the admitted 128-byte ID. The mixed-case test
  failed on the old key, then all 29 library cases passed (exit 0). Targeted
  `cargo mutants --file src/stop_budget.rs --re session_directory --cargo-arg=--lib
  --output target/stop-budget-mutation-session-key` exited 2: 21 tested, 20
  caught, one missed. The missed OR→XOR mutation combines disjoint bit ranges
  and is equivalent; the raw result remains retained under that target path.
  This does not establish native-wire use, process-crash or power-loss recovery.
- E28: Strict CLI build exited 0. Rust formatting and
  `cargo clippy --all-targets -- -D warnings` exited 0 (2.77 s). Four runtime
  suites (`engine-core`, `handler-executor`, `stock-handlers`, `protocol`)
  passed 137 checks in 51.324 s, exit 0, after the rebuilt source. They exercise
  completed-exit-2 capture after malformed receipts, replacement-decoded denial
  custody, cancelled frame reads, journal collision refusal, mixed-case journal
  protection, argument-bearing dedup and canonical-latch fallback admission.
  Their temporary fixture artifacts were removed by teardown. They do not
  establish actual Native→typed-engine execution, installed behavior, full
  stateful latch/PID termination, or resident concurrency. In particular these
  tests can pass while the containment dependency is wrong.
- E29: Source investigation found the PID-correlation producer serializes
  `started_at` as a string while the new strict ownership reader requires a
  number. Separately, root `01a15107…` and its review subagent `01a15174…` were
  observed under Codex PID 66070, start 2026-10-18T20:38:27Z. No cache overwrite
  incident was observed; this is not evidence that the other twelve user chats
  share that PID. The new hook identity prototype excludes PID-cache recovery,
  but this change is not parity-qualified. The user's containment correction
  makes R32 a blocking obligation: cache attribution and agent PID termination
  must be traced separately, including their identity dependencies, before
  accepting the change. Existing CLI identity recovery is not modified.
- E30: Sterling's renderer client starts the daemon in the request's process
  group without detachment. Native owned-group cleanup would kill a newly
  started service. This is a source-established compatibility gap in the
  prototype, not an observed active-runtime regression. No machine replacement
  or resident admission follows from the current component results.
- E31: The first combined native run exited 101: 29 library cases and five
  binary units passed; 17 executable groups passed and two failed. The late
  1 MB proposal did not reach the expected native-delivery failure path; stderr
  instead reported an execution deadline. The 250 ms timeout fixture also
  assumed dispatch before observing its grant. Its old failure artifacts were
  removed by teardown, so cold-start delay remains an inference. Corrected
  scenarios distinguish an observed grant from startup, early large output
  from a small late proposal, and exact partial bytes from infrastructure JSON.
  The subsequent executable run passed 20 groups in 22.98 s, exit 0; strict
  Clippy exited 0. Failed fixtures are retained, and explicit artifact-root
  selection retains successful fixtures. These are transport-fixture checks,
  not production containment or native-harness acceptance.
- E32: The selected installed snapshot remains `408c06a7…77baa0`. Read-only
  selection inspection found stock CAWS `block-dangerous.sh` (`eef8c81c…`) and
  Sterling's project override (`454dd1fc…`), with the selected Codex emitter.
  The stock latch stores a fresh PID/start/comm tuple independently of the
  session-correlation cache, and the first subsequent prohibited attempt can
  reach SIGTERM. Fixed read-only/reset exceptions and earlier-handler/reprieve
  selection matter. Current source logs a successful signal as termination
  without waiting for exit; missing stamped identity fields also do not all
  force no-signal. No live backend was signaled and actual PreToolUse target
  ancestry has not been observed. R32 remains blocking. Qualification needs
  request-ingress target observations, complete identity/reuse controls,
  actual disposable-target exit and surviving-sibling evidence; a signal stamp
  alone is insufficient.
- E33: `node packages/caws-native/target/qualification/engine-wire-2026-10-19T04-02-55-400Z/run.cjs`
  (invoked from the native crate via its absolute path) exited 0. An isolated
  machine home installed the production template snapshot, then production
  selection admitted only stock `block-dangerous.sh`. The compiled Rust client
  invoked the actual built engine. Native exits were 2 for a bare commit with
  a staged tracked deletion, 0 for the explicit-path control, and 0 for the
  same bare command after removing the staged deletion. Raw stdout/stderr,
  status, input, index bytes, selected-source identity and invocation journals
  are retained in that probe directory. Each index remained byte-identical
  during its invocation; journals include matching input SHA256, handler
  completion, local native handoff and adapter finish. No PATH `python3` trap
  fired. Termination was explicitly disabled in this isolated fixture, so it
  earns no containment, full-chain, harness-withholding or installation claim.
- E34: Native Stop-wire scenario artifacts are retained under
  `packages/caws-native/target/qualification/stop-wire-2026-10-19T03-55-40-878Z/`.
  Its manifest records actual native exits 2/2/2/2/0/2/0/2 and counter snapshots
  1/2/3/3/0/1/0/1. The valid refusal leaves count 3 intact, the fourth
  infrastructure failure releases explicitly, and a successful nonblocking
  Stop resets the counter. Exact output and per-call status files are printed
  by the runner and retained. Its engine is a protocol fixture; it cannot
  establish production selection/context, containment, harness action,
  resident operation or crash/power-loss durability.
- E35: The counterexample is retained under
  `packages/caws-native/target/qualification/numeric-custody-red-2026-10-19T04-36-05-075Z/`.
  Its runner exits 1 because the actual Rust → typed engine → selected project
  override path delivers 9007199254740993 as 9007199254740992 and
  18446744073709551617 as 18446744073709552000. The source Python adapter
  delivers both integers exactly through the same selected snapshot. All six
  individual adapter calls exit 0. Consumed stdin, raw outputs, statuses,
  commands, source/build identities and journals retain the distinction.
  Two preceding attempts used an incorrect Python script path; their failed
  artifacts remain in the qualification directory and establish no baseline
  behavior.
- E36: The expanded probe
  `numeric-custody-green-2026-10-19T04-51-04-316Z/` retains an incorrect oracle:
  it expects exported full JSON where the selected parser keeps
  `HOOK_INPUT_JSON` local. Source inspection of shared and Codex
  `parse_hook_input` establishes that contract. The corrected guarded probe
  `numeric-custody-guarded-integer-2026-10-19T04-57-20-643Z/` passes integer,
  nested projection, absence and 0/2 refusal controls, but precedes the R35
  routing correction. Neither failed oracle nor predecessor is relabeled as
  final-candidate evidence.
- E37: The corrected extension scenario is retained under
  `packages/caws-native/target/qualification/numeric-custody-extension-parity-2026-10-19T05-06-21-524Z/`.
  `node <scenario>/run.cjs` exits 0. For plain and supplied-`BASH_ENV` contexts,
  Python and the actual Rust → typed engine → selected dispatcher → extension
  path each allow 9007199254740992 and refuse the two odd large revisions with
  exit 2 and matching exact reasons. The 12 cases retain consumed stdin, nested
  input/response projections, absence of exported full JSON, original tool
  name, file path/list, stdout, stderr, status and invocation journals.
  Every candidate case records `compatibility_dispatch_completed`.
  This is an isolated custom guard with termination explicitly disabled; it
  proves neither real harness withholding nor containment, Python retirement,
  all extension contracts or complete guard parity.
  E37 does not observe the startup marker; E41 adds that observation.
- E38: The stock-route control is retained under
  `packages/caws-native/target/qualification/stock-route-2026-10-19T05-08-12-811Z/`.
  Its actual native/typed-engine scenario exits 0, with stock selected-handler
  stages, the staged-deletion refusal at exit 2, and explicit-path/unstaged
  controls at exit 0. Index hashes remain unchanged and no PATH Python trap
  fires. These commands are evaluated rather than executed; unchanged indexes
  do not establish harness withholding. Termination is disabled in this
  nonlatching fixture.
- E39: Current Rust checks include raw wire-token custody and invalid-number
  rejection before engine startup, alongside the existing cancellation,
  output, protocol and Stop-library checks: `cargo clippy --all-targets -- -D
  warnings` and `cargo test --all-targets -- --test-threads=1 --nocapture` exit
  0. The six focused CLI suites exit 0 with 144 cases; the actual routing test
  pins consumer fields, refusal and the compatibility journal stage. The
  initial full-file source mutation report is
  `packages/caws-cli/reports/mutation-runtime-json/mutation-report.json`:
  181 killed, 10 timeout, 24 survived, one uncovered, raw score 88.43%.
  Exact budget and negative-number controls were missing; strengthened tests
  exercise those counterexamples. A separate selected-range report at
  `reports/mutation-runtime-json-boundaries/mutation-report.json` records
  32 killed, three timeout and two survived of 37 (94.59%). That is not a
  recomputed full-file score. The remaining selected-range survivors alter a
  redundant defined-character check and a root-token endpoint beyond EOF,
  whose slice clamps to the same text after grammar validation; this does not
  adjudicate every survivor in the full report. Passing tests and these
  bounded observations confer no A2–A8 acceptance.
- E40: A direct decoder counterexample exits 1 when wire process ID
  `123.00000000000000001` is accepted as 123. Source-span validation rejects
  that spelling before decoded numeric bounds; the same check then exits 0
  with `RuntimeProtocolError: Invalid native caller snapshot`. Raw fractional,
  exponent and negative-zero controls and exact boundary positives are in
  `tests/runtime/protocol.test.js`. The current Rust producer emits canonical
  integer controls, so this is a decoder-contract repair before independent
  IPC admission, not an observed native targeting bypass or caller
  authentication proof.
- E41: Startup-marker and extension artifacts are retained under
  `packages/caws-native/target/qualification/native-wire-controls-2026-10-19T05-22-52-884Z/`
  and the final representation-only helper revision under
  `native-wire-controls-2026-10-19T05-38-00Z/`. Both scenario commands exit 0.
  Each has 12 actual baseline/candidate calls with exact integer and context
  observations, even-value allow and odd-value refusal controls. The consumer
  writes `startup-observation.json`: null in plain cases and `selected` when
  the supplied startup executes. `readback.cjs` recomputes every case's
  journal input hash and runtime digest and compares all six pairs of raw
  stdout/stderr bytes. Both readbacks exit 0; committed-build identity must
  be checked separately. All cases
  explicitly disable termination and do not execute proposed tools.
  At committed revision `8acc4b7675e8d1de78d2e12854b322555be0946b`,
  `check-committed-build.cjs` exits 0. Its raw build record and comparison
  match all 21 runtime modules and the native binary to the final scenario;
  the canonical-control mutation report also matches the committed source.
- E42: The initial control-helper mutation probe is retained at
  `reports/mutation-runtime-controls/mutation-report.json`: 23 killed and six
  survived of 29, score 79.31%, exit 1 against the unchanged 80% floor.
  Redundant decoded-value bounds were removed from the raw spelling helper;
  field bounds remain in the decoder. The separate selected helper range at
  `reports/mutation-runtime-controls-canonical/mutation-report.json` records
  nine killed, one survived and one uncovered of 11, score 81.82%, exit 0.
  Missing source is rejected by preceding envelope/caller-key validation,
  explaining the helper's unreachable missing-source branch; the surviving
  mutation removes that redundant branch. This is not a full-file protocol
  mutation score. Two focused suites pass 99 checks, and strict test TypeScript
  and ESLint checks exit 0. These checks exercise control representation,
  bounds and payload custody, not process ownership or termination.
- E43: The selected-Codex latch sequence is retained under
  `packages/caws-native/target/qualification/latch-identity-selected-codex-2026-10-19/`.
  A compiled disposable ancestor is observed and stamped with the same
  PID/start/full-comm tuple in both isolated modes. Each actual adapter
  evaluates five input texts without executing them: unlatched allow (0),
  catastrophic arm (2), subsequent missing-session request (0), explicit
  latched-session control (2, one strike), and unlatched sibling ID (0).
  `run.cjs` exits 0 because the baseline and candidate agree.
  `evaluate-safety.cjs` exits 1 and writes `safety-evaluation.json` with
  `baselineAgreement: true` and `safetySatisfied: false`: the missing-session
  request misses latch A and records no strike in either mode. This isolated
  guard result is an inherited safety gap, not evidence of complete behavioral
  parity or a demonstrated native-only regression. Kill mode is explicitly 0;
  no signal, actual harness withholding or agent termination is established.
  The selected parser is the Codex surface file (`04a21ee0…0a73c61`), which
  writes a durable envelope but no PID record. The shared parser's PID writer
  is not that selected producer; a prior source prediction using it is
  withdrawn. Neither mode produces a PID record here. The baseline creates
  the durable envelope while the direct candidate path omits it; downstream
  legacy attribution effects require a separate consumer probe and confer no
  ownership authority. Preseeded-cache, actual ingress, process-exit and
  surviving-sibling controls remain required. Earlier attempts remain at
  `latch-identity-red-2026-10-19/` (copied launcher SIGKILL before ancestry
  observation) and `latch-identity-retry-2026-10-19/` (incorrect basename-only
  comm oracle); neither is counted as a completed differential.
- E44: R33 source inspection confirms native `OwnedGroup::finish` signals the
  engine group after normal settlement as well as failure, the selected shell
  inherits that group, and Sterling's `slrd_spawn` redirects stdio without
  transferring group ownership. Its daemon also checks a live lease before
  binding/publishing without an exclusive startup lock. Concurrent requests
  against a warm daemon do not test concurrent starters. A declared service
  lifetime owner, startup coordination, process-instance identity and readiness
  are required; a blanket child exemption or bare detachment does not discharge
  them. Cold-start survival, ordinary-child cleanup, interrupted ownership
  transfer and generation retirement have not been executed in the prototype.
- E45: The repeatable typed runner `scripts/qualify-native-containment.ts` and
  disposable Rust caller `tests/fixtures/containment-agent.rs` retain effect
  observations under `packages/caws-native/target/qualification/containment-effect-2026-10-19T06-38-48-060Z/`.
  The command `node packages/caws-native/target/qualification-tools/qualify-native-containment.js <absolute-cli-directory>`
  exits 1 against the original selected template digest `408c06a7…77baa0`.
  Both frontends select only stock Codex `block-dangerous.sh`; no input command
  executes. The legacy enabled caller's parent wait records SIGTERM, raw stdout
  contains the quarantine block, the forbidden marker is absent and a sibling
  heartbeat advances. Native enabled also records SIGTERM, but raw stdout is
  empty and stderr reports original-caller cancellation. Its escalation log is
  absent; `scenario-incomplete.json` preserves that failed assertion rather than
  treating it as a completed case. Native missing-stamp separately records
  SIGTERM, empty stdout and a completed escalation line. Source inspection
  locates the conflict: the shell signals before dispatcher output reaches the
  proposal; Rust treats the caller exit as cancellation and kills the engine
  group, potentially interrupting audit. Neither signal success nor baseline
  agreement satisfies refusal/audit custody. Both frontends also signal after
  deleting all arm-time identity fields: an inherited safety defect.
- E46: Source repair requires complete positive-decimal PID/start fields and
  nonempty comm in both fresh and arm-time identities, then exact tuple
  agreement before any dry-run or signal. Refusal and strikes remain active
  when signaling is held. The 22-case effect run retained at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T06-44-00-583Z/`
  exits 1 solely for native enabled refusal loss. Both frontends preserve block,
  caller survival and advancing sibling heartbeat for disabled killing, wrong
  PID/start/comm, all missing stamps, each missing stamp member and malformed
  PID/start. The valid legacy target still exits via SIGTERM; the valid native
  target exits via SIGTERM but has empty quarantine stdout. These frontends
  share the repaired template snapshot; this is an intentional inherited safety
  repair, not agreement with the previous installed guard. Actual harness
  ingress, exclusive session target ownership, live partial-observation failure,
  signal-ignore behavior and race-free process binding remain unverified.
- E47: Seven focused Bats checks exit 0 for actual verified SIGTERM, suppressed
  signal, unresolved identity, disabled killing, PID drift and two dry-run
  controls. Receipts are retained under
  `packages/caws-native/target/qualification/containment-bats-2026-10-19/`:
  `trap-agent-39tte6/signal.json` records PID 31408/signal 15;
  `trap-agent-P70FPk/observation.json` records a surviving PID 32168 with an
  escalation stamp but false signal oracle; `trap-agent-3NyOXm/observation.json`
  records surviving dry-run PID 37762 without a signal receipt. These legacy
  receipts do not repair the native transport failure. An earlier accidental
  `node …/bats` invocation exits 1 with SyntaxError before any test; the corrected
  invocation uses `bash …/bats`. Strict runner compilation, actual script ESLint,
  Rust formatting and shell syntax checks exit 0. Initial ESLint attempts
  ignored the TS script; `scripts/**/*.ts` is explicitly included in the package
  lint configuration. The Rust watchdog's independent `/bin/sleep 30` control
  records owned-hook wait signal 15, caller exit 21 and no admitted-action marker.
  Pipe EOF gates complete output capture; timeout aborts only owned capture
  streams and records incompleteness, never an inferred successful receipt.
- E48: Committed candidate `cea1ad2e` reproduces the failure through
  `npm run qualify:native:containment` from `packages/caws-cli`, exit 1 after
  successful CLI/Cargo builds and strict runner compilation. Artifacts at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T06-53-47-395Z/`
  record 22 completed observations and sole native enabled failure. Caller
  89105 exits via SIGTERM; stdout is empty, stderr reports original-caller
  cancellation, escalation is absent and the sibling heartbeat advances
  147→219 bytes. Legacy caller 62289 exits via SIGTERM with quarantine block
  and escalation intact. The generated repaired snapshot is
  `a822893a…7224c2`, selected guard SHA256 `39e99cf8…57ffdc`; it differs from
  the installed `408c06a7…77baa0` generation. The 46 checks in three focused
  routing/executor/engine suites and strict runner/source lint pass; doctor
  exits 0 with inherited 0E/3W/4I and five scope/structural gates pass. These
  checks do not exercise the demonstrated containment transport failure.
- E49: The qualification oracle checks one exact per-case audit record's
  session, command, verdict, action and reason, plus strike count/command and
  the enabled target stamp or absence of escalation on held paths. An existing
  or nonempty log alone does not pass. The stricter run at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T06-59-17-790Z/`
  exits 1 for native enabled refusal loss; all 22 audit checks pass in this
  run. Native caller 63806 exits via SIGTERM with empty stdout, while its
  escalation completes: audit interruption is timing-sensitive, refusal loss
  persists. `audit-oracle-controls.json` records seven rejected corruptions of
  the actual positive observation: empty/malformed log, foreign session,
  no-kill action, foreign target, missing strike and foreign strike command.
  Strict runner TypeScript and ESLint exit 0. The run records its source hash
  to distinguish this oracle from the earlier committed version.
- E50: Held-path validation rejects either escalation PID or timestamp, including
  a timestamp-only stamp. The nine-control run at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T07-06-21-222Z/`
  exits 1 solely for native enabled refusal loss after strict runner compilation
  and ESLint pass. All 22 audit observations pass; the original seven corruptions
  and separate held PID-only/timestamp-only corruptions are rejected. Native
  caller 10303 exits via SIGTERM, quarantine stdout is empty, the forbidden
  action marker is absent and sibling heartbeat advances 210→316 bytes. This
  strengthens the evidence oracle; it does not fix the native effect/transport
  ownership conflict or establish cleanup after caller death.
- E51: The terminal bridge producer gives every newly armed latch a random
  generation and can submit the verified tuple through a private per-handler
  intent file instead of signaling inline. Seven selected Bats checks exit 0;
  `packages/caws-native/target/qualification/native-intent-bats-2026-10-19/`
  retains the submitted intent for PID 43513 and an observation that the caller
  remains alive without a signal receipt. Its legacy control records signal 15
  for PID 44159. This is producer evidence, not native consumption or retirement
  of the shell/Python implementation. The bridge candidate is based on
  `90fac044` and requires committed-candidate review.
- E52: `npm run qualify:native:containment` exits 0 with the terminal bridge.
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T07-46-45-168Z/`
  retains all 22 legacy/candidate cases and nine rejected audit corruptions.
  Candidate caller 74133 exits via parent-observed SIGTERM, raw probe stdout
  retains the quarantine block, and the surviving sibling heartbeat advances
  440→696 bytes. Its input-bound invocation journal records one correlated
  `signal-accepted` receipt, local output acceptance, unchanged latch snapshot
  and adapter finish. The latch retains its strike without a legacy escalation
  overwrite. The receipt explicitly does not claim process exit; the external
  parent wait supplies that separate observation. This generated snapshot is
  `3693319d…f70551`, not the installed `408c06a7…77baa0` generation. Only the
  selected stock guard and explicit-session, non-dry-run Codex Bash route ran.
- E53: The native terminal transport fixture exits 0 for a reader closed after
  accepting a prefix and an open unread/full stdout pipe. Artifacts at
  `packages/caws-native/target/qualification/terminal-bridge-2026-10-19/caws-native-71415-0/`
  retain parent-observed signal 15 for callers 72233 and 73247, ACK
  `success:false` with separate `signal-accepted` receipts, one
  dispatch/proposal/handoff per case, native delivery-failure diagnostics and
  surviving sibling progress. The fixture uses a separately pinned owned
  cleanup group; it establishes transport/effect behavior, not selected-guard
  authority or actual harness isolation. The first attempt used a relative
  artifact root and failed configuration (`invalid ready budget home`, caller
  exit 42); its artifacts remain under `caws-native-26193-0/`. The successful
  rerun uses an absolute root and does not erase that failed attempt.
- E54: Source inspection identifies a guard-strength gap in the first bridge's
  64 KiB latch snapshot limit: the selected producer can retain a larger valid
  command/reason, causing TypeScript to discard an otherwise valid intent.
  The 22 effect cases do not cover this boundary. E55 records the producer
  counterexample and repaired bound/escaping scenarios.
  Global hook dry-run also rejects bridge eligibility while the fallback guard
  can signal inline; the legacy dispatcher explicitly invokes handlers during
  dry-run. This is an inherited unqualified path, not a no-signal control.
  Mixed overrides, file tools, prior latch generations and reset/rearm
  coordination are outside the qualified route. Full parity remains blocked.
- E55: The producer counterexample at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T08-07-07-585Z/`
  retains a 72,313-byte latch. The first bridge's caller 25002 survives with
  exit 0, block stdout and an operational-file-envelope diagnostic; no native
  settlement exists. Legacy caller 19399 exits via SIGTERM. The run also exposes
  a fixture-oracle defect: one `identitySafe` branch omitted the newly added
  signal-enabled case. All effect expectations use the same classification.
  The repaired reader derives its bound from successful producer argv admission:
  six times observed ARG_MAX plus 32 KiB for fixed/bounded metadata. Absolute
  `/usr/bin/getconf ARG_MAX` returns 1,048,576 here, yielding 6,324,224 bytes.
  Sidecar-derived reason text prevents deriving this bound from hook input alone.
  Small records allocate by observed size; final no-follow, type, owner and size
  checks remain enforced. Other hosts/resource-limit histories are unqualified.
  The first repaired comparison at `containment-effect-2026-10-19T08-11-49-418Z/`
  fails overall: a 15s observer aborts legacy arming before its two serial 35s
  watchdog bounds. Candidate caller 7677 terminates with retained refusal and
  finalized receipt. The observer follows those call bounds; hook deadlines do
  not change. The failed attempt remains retained.
  Both final boundary commands exit 0: `qualify-native-containment.js .
  escaped-latch` at `containment-effect-2026-10-19T08-16-46-493Z/` produces
  74,361 bytes; caller 73702 exits via SIGTERM, sibling 708→1216.
  `qualify-native-containment.js . large-latch` at
  `containment-effect-2026-10-19T08-17-24-264Z/` produces 72,313 bytes; caller
  97668 exits via SIGTERM, sibling 776→1164. Both retain block stdout, correlated
  signal receipts, adapter finish and no forbidden-action marker. All recorded
  runtime-module hashes match the inspected built files. The final six focused
  suites pass 121 checks; strict runtime/store/shell TypeScript, scoped lint and
  all-target strict Clippy exit 0. This closes the demonstrated size gap on this
  host, not complete containment, installed behavior or multi-project parity.
- E56: A clean `npm run build` followed by
  `node ../caws-native/target/qualification-tools/qualify-native-containment.js . large-latch`
  from `packages/caws-cli` exits 0 at committed source
  `e01a1b00bbc55902bf0744d878f29f173fb86537`.
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T08-40-58-519Z/manifest.json`
  names that revision rather than the earlier dirty-source baseline. Candidate
  caller 196 exits via parent-observed SIGTERM, retains the block and correlated
  receipt with adapter finish; sibling activity advances 1120→1564 bytes and
  the forbidden-action marker is absent. Recorded root runtime-module hashes
  match the inspected build; this is not a recursive dependency-closure hash.
  Direct committed-candidate doctor and five policy gates exit 0 (0E/3W/4I
  inherited doctor findings). A separate attempt to save their output with
  relative Bash tee paths is refused by the active write-target hook; no log
  file is produced by that command. The owned relative path is admitted by
  `caws scope show`; direct CLI checks complete without that filesystem write.
  The scope decision and refusal are distinct observations, not permission to
  disable the guard. The broader telemetry test type error and all unearned
  acceptance obligations remain open. This slice is committed, not installed
  or landed on main.
- E57: `npm run qualify:native:services --
  /Users/darianrosebrook/Desktop/Projects/sterling /usr/bin/python3 /usr/bin/jq`
  from `packages/caws-cli` exits 1 after successful CLI/native builds and strict
  runner compilation. The retained scenario is
  `packages/caws-native/target/qualification/service-lifetime-2026-10-19T09-11-01-787Z/`.
  Its isolated homes select only a copied Sterling session-log override; custody
  records match all 28 copied source files. Neither real Sterling service state
  nor installed machine selection is used. Both frontends use generated runtime
  `3693319d…f70551`, not the installed generation.
  Legacy requests exit 0, render users 1–2 then 1–3, and retain precise daemon
  instance 68466 across requests. Its lease advances served 0→1; the second
  request executes no one-shot renderer. The daemon log records listening and
  idle exit; final observation is ESRCH and the private lease is absent.
  Native requests also exit 0 and render those users, but witnesses 1158/group
  97053 and 8359/group 3273 are absent after request completion. Neither
  publishes a live lease, the daemon log is empty, and both requests execute
  the inline renderer. Their input-bound journals record compatibility dispatch,
  native handoff and adapter finish. This demonstrates failed service reuse
  despite successful rendering; no daemon wait status independently identifies
  its terminating signal. Request-group cleanup is the source-supported cause,
  not an externally observed signal receipt.
  `build-identities.json` records revision `36a110cc` plus working probe source
  and emitted hashes. Independent readback matches the recorded native, engine,
  interpreter/executable and recursive dist-module hashes and copied sources.
  It does not establish a recursive dependency closure or a committed final
  qualifier snapshot. The initial runner preflight exits 2 on an invalid
  line-broken TypeScript assertion before execution; the corrected runner
  compiles. Subsequent strict runner compilation, scoped ESLint, Rust formatting
  and all-target strict Clippy exit 0. Final formatting changes probe bytes;
  retained runtime artifacts remain the evidence for this run.
  Cleanup observes only witnessed instances; all are absent and both leases
  are absent. It does not prove reclamation of every descendant or a wedged
  orphan. Unavailable/unwitnessed startup stops the probe rather than passing
  an empty set. No daemon PID/group is signaled by this runner. The private
  daemon uses a configured 60s idle window, with 68s observation; this keeps a
  fresh lease outside the foreign PID-only reaper threshold during a bounded
  35s hook call. Concurrent starters, cancellation, generation retirement,
  all-harness behavior and service lifetime repair remain unqualified.
  Render completeness checks only user strings; retained tool/assistant/timeline
  projections are not semantic assertions. A read-only control removes the
  first legacy turn's timeline entries while its user check remains true.
  Broader rendering parity needs assertions over those retained fields. Service
  survival also needs a removed-ordinary-request-child control before it can
  justify an ownership change; a blanket cleanup exemption could pass reuse
  while leaking request descendants.
- E58: The same service qualification command exits 1 from clean committed
  revision `310371d0a091f5bb74f43cad765fcb8447d180fb`, retaining the same four
  native service-reuse failures at
  `packages/caws-native/target/qualification/service-lifetime-2026-10-19T09-45-47-273Z/`.
  All four hook calls exit 0 and retain the expected two then three user strings.
  Legacy daemon 48005/start `1792403153.669989` survives both requests; served
  advances 0→1 and the second inline-renderer execution list is empty. Native
  witnesses 77406/group 74268 and 82553/group 79646 are absent after completion;
  neither has a live lease, and each request executes an inline renderer.
  Final cleanup observes all witnessed instances absent and both private leases
  absent. No daemon wait status supplies its terminating signal.
  Readback compares `build-identities.json` with SHA256 of the committed probe,
  Rust observer source, emitted runner, native binary, observer binary and typed
  engine entry; all six match. This closes the final formatted-probe identity
  gap for this replay, not dependency closure or broader runtime acceptance.
  The probe's semantic-rendering nonclaim is present in its retained manifest.
  Service ownership, surviving-service/removed-request-child behavior, startup
  races, cancellation, source retirement, native workload and installation remain
  open; this is a reproduced defect, not its repair.
- E59: Read-only branch review at clean `0ea4a4ad`, against merge base
  `a9834f93`, finds a configured utility-policy bypass at
  `src/runtime/stock-handlers.ts`: the typed bridge uses checkout root while the
  Python helper resolves `HOOK_CWD` from the hook payload. The retained
  `/tmp/caws-review-0ea4a4ad-utility-cwd.json` records absolute/relative nested
  cwd cases returning typed 0/empty versus Python 2/block, absent/empty controls,
  unchanged sentinel content and no Git index creation. Fresh CLI build and 18
  focused Jest suites pass 747 checks; Cargo library/binary units pass 29/13.
  Those checks miss the cross-directory consumer mismatch. Eight targeted
  selected-handler controls cover nested ignore/refusal, root-only ignore/allow,
  absent/empty fallback and filesystem symlink-before-parent traversal. Before
  the repair, the first six controls produce four failures and two passes;
  `/tmp/caws-utility-cwd-red.json` retains the incorrect allow/block values.
  This is evidence of test sensitivity, not complete utility parity.
- E60: R33 source investigation confirms that startup interception alone is
  insufficient. Sterling's `session-log.sh:90` directly sources its client;
  `lib/session-log-daemon-client.sh:107-108` launches the daemon through literal
  `python3`, but `:84-95` sends render requests through `/dev/tcp` and permits
  inline fallback after an unrecognized/timed-out response. The daemon writes
  through `render_session` at `session_log_daemon.py:288-296` before responding
  at `:311`; its wire carries no request ID or outcome lookup. This is inspected
  source, not a new runtime scenario. A typed policy declaration and source-bound
  native startup owner must reach the actual selected client and correlate
  admission/fallback outcomes. R33 remains open until that integration exists;
  a service-host library or relay alone cannot close it. Normal request cleanup,
  unknown partial effects and independently surviving host-crash cleanup remain
  separate obligations.
- E61: `node /tmp/caws-native-utility-cwd-probe.cjs
  /Users/darianrosebrook/Desktop/Projects/caws/.caws/worktrees/native-runtime-modernization`
  exits 0. Artifacts live in
  `packages/caws-native/target/qualification/utility-cwd-2026-10-19T10-32-57-367Z/`.
  Twelve executions use the actual Python dispatcher or Rust client plus typed
  engine, with private homes and a selected stock utility extension. Both modes
  return 2/block for absolute/relative nested ignored targets, absent/empty cwd
  root fallback and symlink-before-parent traversal; the root-ignored/nested-
  ordinary control returns 0. All recorded index and target-file hashes remain
  unchanged; the proposed staging command is input data and never executes.
  Native journals record handler completion, output handoff and adapter finish;
  no compatibility-dispatch stage occurs. The inspected absolute-cwd native
  input SHA256 `7c88c014…b39f` matches every stage's input custody, and its index
  remains `d5838795…9a6f`. Independent jq readback requires exact block decisions
  and reason, empty allow stdout and unchanged target hashes in every case.
  `manifest.json` records base `0ea4a4ad` plus the uncommitted diff SHA256
  `cb52fdd9…3a66`, retained as `source.diff`; this is not a clean-commit replay.
  The recorded stock-handler JS SHA256 `b6bd34c7…624f` matches the inspected
  build. Recursive runtime-module hashes, selected source hashes, raw channels,
  commands/status, journals and copied review/red/green receipts are retained;
  no dependency-closure or OS subprocess trace is claimed. The final focused
  suites pass 107 checks, including an unresolvable-cwd shell-fallback control;
  a subsequent configured-policy refinement of that fallback control passes
  its one selected recheck (31 unrelated cases unselected), retained in
  `/tmp/caws-utility-cwd-fallback-final.json`. Scoped ESLint and strict runtime
  test TypeScript exit 0. Doctor reports the
  inherited 0E/3W/4I and five policy gates pass over branch plus staged changes.
  Two runner-creation attempts are refused before execution: an external tool
  symlink and then a foreign-path literal in unrelated historical prose. The
  successful runner uses the fixed system PATH and omits that prose; it does
  not create tool aliases or weaken a guard. A later read-only summary is refused
  for unsupported nesting. Attempts to copy the runner into the artifact tree
  are also refused (relative claimed-path coordinate, then the worktree-copy
  guard); no copied runner is produced. Its original `/tmp` file remains with
  recorded SHA256 `76207214…78d4b`, a retention gap to resolve before scratch
  cleanup. No installed runtime, whole-runtime parity or acceptance is earned.

The terminal bridge's CLI build, six focused suites (118 checks), Rust library,
binary and executable suites (29/13/23 checks), strict Clippy and scoped lint
exit 0. Raw logs and retained native fixtures live under
`packages/caws-native/target/qualification/terminal-bridge-2026-10-19/`.
The broader `npm run typecheck` exits 2 at the unchanged
`tests/kernel/telemetry-turn-log-schema.test.ts:237` access to `usage.required`;
neither that test nor its imported schema differs from `90fac044`. This is not
a green package-wide check or a reproduced baseline typecheck. E55 carries the
separate large-latch producer/consumer evidence.

Reorientation against all available session turn records retains the original
whole-application scope, the thirteen-session/four-repository requirement and
the user's containment and Sterling-inversions corrections. Image-only/null
turn fragments did not cancel those obligations; A8 and R28/R31 carry them.
Reachable lane commits establish committed work, not delivery on main. Demand-start
residency, native workload/performance qualification, renderer migration,
first-party Python retirement, packaged adoption and rollback remain open.
The machine pointer remains on `408c06a7…77baa0`; no speedup or replacement of
the active hook pipeline has been demonstrated.

Containment qualification does not establish cleanup after intentional caller
death. The caller's watchdog dies with it; capture EOF only closes observed
output writers. If the surviving hook/dispatcher stalls, capture cancellation
does not terminate it, and a dead caller cannot consume its abort file. No
current leak was observed, but no post-termination stall control has established
bounded external ownership and reap. That scenario and an independently owned
cleanup receipt are required before asserting cleanup for this path. The native
terminal-effect owner must preserve ordinary cancellation, output/audit custody
and bounded finalization together. A signal-accepted record alone cannot claim
termination, and the legacy refusal's unconditional process-end wording is not
an observation that the target exited.

The executable embedded-Python surface is 15 shell files, 19 inline bodies and
seven external callsites. A textual `python` hit is not sufficient: seven broader
search matches contain only comments or interpreter-recognition data.

| Group / source sites | Destination and decisive proof |
| --- | --- |
| `shared/runtime-paths.sh:58`; shared/Codex/Kimi `lib/parse-input.sh` | Typed input normalization: raw controls/NUL/surrogate handling, shell-safe assignments, Codex multi-file patch first-action mode, Kimi fallback precedence and large-input transport |
| `shared/lib/caws-state.sh:211` | Shared path/native FS port: existing symlink ancestor with missing leaf, `/tmp` alias and unresolved path fallback |
| `shared/lib/agent-surface.sh:516`, `shared/lib/run-handlers.sh:598` | Typed selection: malformed/absent override maps, custom paths and concurrent request environment isolation |
| `shared/lib/parse-input.sh:355,372,449`, `shared/lib/agent-pid.sh:162`, `shared/lib/session-cache.sh:29` | Native anchored filesystem + typed identity/cache: dir-relative no-follow writes, exclusive temp0600/rename, symlink races, unsafe IDs, original created_at, partial writes, PID reuse and retention boundaries |
| `shared/lib/reprieve.sh:194` | Owning reprieve reader: handler/session/repo scope, legacy null repo reach, revoke-key presence, naive-UTC/offset/equal-expiry and symlink ancestry |
| `shared/goal-ac-gate.sh:192,209,244` | Typed verify-acs consumer: no binding, malformed/empty report, all verified, not-rederived, non-dict criteria and bounded infrastructure release; do not rederive authority |
| `shared/lib/run-handlers.sh:94,371` | Typed journal/supervisor: selected identity, start/result, short append/symlink failures, failed provenance independent of guard outcome |
| External calls in `shared/block-dangerous.sh`, `shared/session-log.sh`, `shared/hook-utilities.sh`, `shared/lib/guard-config.sh`, `shared/lib/run-handlers.sh` | Classifier, renderer/store, utility, config and truncation modules tracked separately in R05-R18; consumers must migrate with tests |

Developer paths: `scripts/calculate-rule-tokens.py`, `scripts/hook-harvest.py`,
`scripts/hook-harvest.test.py`, and `scripts/hook-experiments/` files
`qualify-render-daemon.py`, `qualify-transcript-cache.py`,
`replay-terminal-corpus.py`, `sensitivity.py`, `source_freshness.py`,
`test_replay_boundary.py`. Retained qualification tools remain obligations, not
historical exemptions inferred from their directory name.

The native component's post-start transport failure is conservatively uncertain
and refuses; bounded Stop transport recovery is unresolved. It must not become
the installed hook entry before that obligation is resolved. Its handled timeout
cleanup does not establish cleanup after SIGKILL or abrupt client termination.

Sterling has a project-owned Python renderer daemon selected through the machine
project handler override, independent of the stock shared runtime. Its warm
renderer, per-transcript verified-prefix parse checkpoints, unchanged-request
shortcut, synchronous fallback and idle exit are compatibility observations for
R18/R25, not proof that the stock runtime has those features. The observed daemon
lease recorded active use; current speedup was not benchmarked. Preserve its
override boundary and incremental parsing semantics during stock replacement;
do not claim first-party retirement removes foreign project implementations.

Generated benchmark logs and raw test artifacts belong in ignored storage. Source
commits and spec evidence refer to their actual checked revision and command.

## Acceptance ledger

| Spec criterion | State | Required proof |
| --- | --- | --- |
| A1 | in progress | Complete source/embedded/tooling feature inventory with destination, dependency, status and maintained evidence |
| A2 | unchecked | Compiled native client through actual typed engine; native decisions and refusal/context/provenance parity |
| A3 | unchecked | Lifecycle, isolation, freshness, concurrent start, cancellation, restart and uncertain-outcome hostile tests |
| A4 | unchecked | Production/dev Python consumers replaced; package/source scans plus no-Python execution; classified foreign/historical material |
| A5 | unchecked | Supported harness and extension behavior through installed/native acceptance observations |
| A6 | unchecked | Declared reproducible baseline/candidate workload with distributions, process counts and overload correctness |
| A7 | unchecked | Artifact target identity, clean install, trust, upgrade, rollback and documentation proofs |
| A8 | unchecked | Thirteen sessions across four repositories; fair admission, cross-project/session isolation, owner-specific ordering, independent enforcement capacity, overload and upgrade behavior |

Only `caws specs evidence` records authoritative verdicts. This ledger explains
progress and does not replace that transaction or its event readback.

## Ordered next work

1. Resolve R33 through explicit service binding and client integration. Define
   the actual selected client's broker seam and request/fallback outcome
   contract before implementing a startup-only relay or host. A lost response
   after dispatch stays unknown; only known nonexecution permits immediate
   inline fallback. E60 grounds this dependency in the directly sourced client
   and write-before-response daemon. E57 is
   the failing cold-start/reuse regression; preserve its native failure until
   the owning implementation changes. `SystemSurfacePolicy` has no service
   lifetime declaration, and Sterling directly sources its client rather than
   using library-selection indirection. Prewarming cannot cover restart or
   stale-code fallback. Define a selected-source-bound service capability that
   reaches the actual compatibility dispatcher/client and a Rust owner that
   retains its own child/group from creation; PID/token leases and heartbeats
   confer no ownership. Keep ordinary request-group cleanup unchanged.
   Qualify serialized cold startup, ready/uncertain outcomes, source retirement,
   cancellation and a surviving-service/removed-request-child control. The
   foreign renderer can write after a client disconnects: owner creation alone
   does not resolve that outcome, and retry must not blindly replay it. Observe
   only owned private service retirement during qualification; if cleanup stays
   live or ambiguous at its bounded deadline, retain the sandbox and stop
   further scenarios. No arbitrary descendant receives a cleanup exemption.
2. Investigate the remaining R32 identity/process-domain dependencies.
   E52/E53/E55/E56 observe the selected
   caller/refusal/effect/finalization chain and hostile output failure, but do
   not discharge missing-session identity, exclusive process ownership,
   reset/rearm coordination or compatibility-path containment. Retain ordinary
   caller-death cancellation; neither a generic grace period nor silently
   disabling killing qualifies. A private intent record grants no authority
   by itself. Record the original failing and repaired boundary artifacts.
   Trace effective
   installed handlers/libraries and defaults, distinguish logical identity from
   target process instance, and retain isolated termination/refusal/state and
   surviving-sibling artifacts. Process-instance verification does not establish
   exclusive logical-session ownership; generation correlation does not revoke
   an in-flight effect after reset/rearm. Qualify signal-resistant targets and
   external cleanup after intentional caller death. Do not remove PID-linked
   containment or expand horizontal porting before these contracts are settled.
3. Integrate native client → actual typed one-shot engine → selected production
   guards → native result. Verify current authority, refusal channels, selected
   overrides, journal custody and Stop/handoff behavior through that path.
4. Qualify isolated packaged adoption and rollback. Install on this machine only
   after full parity with the previous selected version; verify selected native
   behavior after replacement. Identify which legacy consumers each slice retains; a
   partial landing does not earn A4 or full migration acceptance.
5. Reuse the verified engine in the resident host. Exercise thirteen real native
   clients across four repositories, including warm policy changes, repeated IDs,
   slow/reentrant extensions, overload, generation overlap and host replacement.
6. Replace remaining implementations together with their consumers, qualify
   supported harnesses and no-Python packaging, and record earned acceptance.

## Landing obligations

The migration must preserve CAWS authority, not only familiar filenames and
interfaces. The architecture's reconstruction falsifiers translate the user's
Sterling inversion reference into checks against actual CAWS consumer behavior.
The reference itself grants no implementation or acceptance authority.

The original bound spec retains the complete A1–A8 acceptance obligation.
`worktree merge --no-close` removes its lane and leaves a finished slice for
merged-revision validation, evidence and close; it is not the continuation path
for this unfinished migration. Preserve the original lane and its ignored
qualification artifacts while separately qualifying completed component units.
Each component's scope must cover every imported commit path: merge provenance
checks current component scope, not the original commit's spec assignment.
CAWS create uses the same base to start a branch and select its merge target;
it has no independent start-ref. A component created against main therefore
needs a separately admitted ordinary Git integration of the committed candidate,
with main as an ancestor for a fast-forward. Actual admission, integrated checks
and component acceptance remain unverified. Narrowing the original write scope
to tracker/architecture responsibility follows source landing, not an assertion
that the whole migration is complete; its full acceptance criteria remain.

| Milestone | Observed state | Proof required to advance |
| --- | --- | --- |
| Component foundations | Tested components; installed hooks use the original runtime | Committed source and checks remain scoped to what actually ran |
| Executable replacement spine | Isolated nonlatching Codex branch exercised; full replacement open | E33 preserves raw selected-guard/index/journal/native-output evidence. Full required chain, identity/containment, overrides and event/harness behavior require their own causal observations |
| Packaged selection and rollback | Unproven | Clean candidate package selects the replacement in an isolated home/harness; native guarded write is withheld; rollback restores the prior selected generation without losing governed state; actual machine replacement waits for full parity |
| Resident multi-project operation | Unimplemented | Same engine serves the required native workload with fresh authority, bounded fair capacity, owner-specific ordering, explicit uncertain outcomes and safe upgrades |
| Complete migration | Open | Every first-party Python implementation and consumer has an earned replacement; supported native observations and authoritative A1–A8 evidence exist |

Parity qualification identifies the previous selected CLI/runtime manifest and
native registrations, and reconciles changes to that baseline before machine
cutover. Intentional repairs to demonstrated inherited defects remain explicit;
silently preserving or changing a bug cannot substitute for a behavior contract.
