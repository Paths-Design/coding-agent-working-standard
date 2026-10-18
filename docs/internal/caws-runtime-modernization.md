---
doc_id: caws-runtime-modernization
authority: working
status: active
title: CAWS native runtime migration tracker
owner: CAWS runtime maintainers
updated: 2026-10-18
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
| R02 | `runtime/caws-hook.py`: configuration, selection, overrides | TS invocation engine and existing authority adapters | selection component tested; not integrated | Shared authority validators, real filesystem freshness/tamper/override fixtures; Git-root acquisition and enforcement host remain open |
| R03 | `runtime/caws-hook.py` and `shared/lib/run-handlers.sh`: invocation scheduling, provenance, composition and handoff | TS supervisor/journal/composer | unreplaced | No per-stage interpreter startup; ordering, interrupted start, refusal and failed-journal tests |
| R04 | `runtime/caws-hook.py`: native output and phase/event error policy | TS native-response adapter, Rust exact delivery | component tested; not integrated | Explicit context and injected Stop budget; consumer migration and transport-Stop recovery remain open |
| R05 | `shared/classify_command.py`: shell syntax and mutation classification | Typed TS classifier | unreplaced | Preserve hostile command/argument/path fixtures; derive oracle on disagreements |
| R06 | `shared/lib/guard-config.py`: consumer policy configuration | TS configuration module | component tested; not integrated | Owning validator reused; inherited guard/threshold names rejected and Unicode code-point boundaries repaired at the shared owner |
| R07 | `shared/lib/hook-utilities.py`: ripgrep/staging/lockfile utilities | Typed TS guard utilities + bounded Git port | unreplaced | Unknown/dynamic cwd, forced ignored staging, option values, pathspec safety and lockfile fixtures |
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
| R23 | Rust client / versioned local protocol | `packages/caws-native` + TS protocol | implemented POSIX one-shot component; worker-tested | Actual typed-engine integration, resident IPC, signal cancellation, bounded Stop recovery and installed parity remain open |
| R24 | One-shot typed engine | `packages/caws-cli/src/runtime` | implementing protocol and selection; engine not integrated | Request schema retains exact native input alongside parsed payload; no stock enforcement host exists yet |
| R25 | Demand-start, warm residency and idle exit | Rust startup + TS resident host | unreplaced | Single starter, no heartbeat authority, no active-request eviction, drain/version tests |
| R26 | Persistent request outcomes / deferred queue | TS journal/spool and bounded scheduler | unreplaced | Crash/reconnect/unknown outcomes, no blind mutation replay, isolation and bounded disk/queue |
| R27 | Package/install/upgrade/rollback and trust | Existing TS init/store adapters + native artifact distribution | unreplaced | Node >=18 compatibility, supported target builds, clean unpacked no-Python execution, rollback and native trust |
| R28 | Performance and load qualification | Replayable TS/native workload | unreplaced | Cold/warm p50/p95/p99, per-stage cost, RSS, process count and bounded overload; 100 ms warm is a target |
| R29 | SOLID boundaries and existing CLI integration | Shared typed kernel/store adapters | implementing | No duplicate Rust authority engine; explicit per-request dependencies; strict compilation and consumer tests |

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

## Embedded and developer implementation coverage

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

Only `caws specs evidence` records authoritative verdicts. This ledger explains
progress and does not replace that transaction or its event readback.

## Ordered next work

1. Finish executable Python inventory and baseline refusal/bootstrap tests.
2. Implement/test the typed native response and isolated invocation contracts.
3. Implement Rust transport and the shared protocol against the one-shot engine.
4. Replace feature implementations and their consumers, updating each row with
   concrete checks; preserve project overrides and requirement-derived oracles.
5. Add resident lifecycle, recovery and bounded scheduling using the same engine.
6. Qualify package/native adoption, performance, independent committed-candidate
   feedback and recorded acceptance; retire implementations only on earned proof.
