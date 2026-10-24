---
doc_id: caws-runtime-modernization
authority: working
status: active
title: CAWS native runtime migration tracker
owner: CAWS runtime maintainers
updated: 2026-10-21
audience: maintainer
---

# CAWS native runtime migration tracker

Replace CAWS's first-party Python, including embedded programs, developer tools
and tests, with Rust and typed TypeScript/Node. Preserve guard strength, project
and session authority, selected overrides, input/output semantics, lifecycle and
audit custody. Deliver a durable demand-start runtime with bounded, fair
capacity for at least thirteen concurrent sessions across four repositories,
serialization by owning state, and heartbeat-driven retention without heartbeat
authority. Review and land coherent governed slices with concrete runtime
evidence; retain the complete acceptance obligation through every slice.
Complete documentation updates after source landing. Replace this machine's
runtime only after full parity, then verify selected execution and rollback.

This tracker records the goal's feature progress separately from the
[architecture contract](../architecture/caws-native-runtime.md) and canonical
acceptance in `CAWS-NATIVE-RUNTIME-001`. Update the relevant row and evidence in
every logical replacement commit. Do not infer migration from a new module,
passing unit tests, or the existence of this document.

## Source location and progress

The matched native runtime source includes main merge
`1c39bd3cd708076d54a34bfec10d8992de8f3286`, reconciled candidate
`c9b919e64f9149a09e2e9fff62f40cfdf141d1a8`, shared pack v105 and F3 cleanup.
Local main merge `6defc8aa44d296cda598a97cd7eee2f16a8a54d2` adds the native
SessionEnd publication chain. E270/E271 distinguish that source landing from
remote publication, package qualification and runtime acceptance. Local main
merge `267f85832ea64089adb51c6355a48cf920728608` contains the E334–E340 native
selection transport, bounded generation discovery and explicit path identity
slice. `CAWS-NATIVE-SELECTION-LANDING-001` closes with A1–A3 recorded; the full
parent spec and selected machine runtime remain unchanged. Local main merge
`56f917d8af052dbc7f473a04c26a9080ff18c5eb` contains the E341/E342 stock
admission and direct invalidation falsifier. The five landed paths equal
reviewed candidate `5837aa104633640ce593a2ead8ea2198d46b7812`.
`CAWS-NATIVE-STOCK-ADMISSION-LANDING-001` closes with A1–A3 recorded; its
component acceptance does not qualify the production publication chain. Local
main merge `bbe4b3895c53348da4d2703a486b8cabe79cb7d8` contains the E343 source
catalog and typed consumer. Its bounded landing spec closes with A1–A3 recorded;
E348 retains the exact composition and postmerge observations. Local main merge
`89946c2d8d71f00d35828a91c620a3ec9d78e130` contains the reviewed Stop
integration checkpoint with implementation bytes equal to `ec496156`; E367
records its bounded acceptance and preserved dependent lanes. It does not
qualify the failed E366 production invocation. `native-runtime-modernization`
remains the integration branch for owed work. Evidence entries identify their
actual component branch or historical revision; ledger-only commits do not
qualify different runtime bytes. The relative architecture link follows this
document's branch. Source publication, fresh package qualification, actual
native execution and cutover acceptance remain separate obligations; E262
records the landing and its bounded checks.

The coverage measure is 33/37 rows with qualifying partial implementation
(89.2%). It is not an overall completion percentage. Parent acceptance is 0/8;
zero complete production Python rows are retired. The selected machine runtime
is `408c06a7cbdb1950e24f53a7486428c3a51e45bbeb86292cb9b2dec30177baa0`. Component
acceptance, integration-branch landing, delivery on `main`, package
qualification and selected-machine adoption are separate states.

## Ownership and execution

- Bound lane owner and cutover coordinator: Codex chat
  `01a164bc-7a2b-75e2-be81-5da9d0a29252`, following the user's lead transfer.
- Prior coordinator: Codex chat `01a15a2a-5057-75d0-a7e5-69d676673add`. The live
  worktree registry and `caws claim` identify the current owner; this tracker
  grants no authority.
- Original coordinator: Codex chat `01a15107-5fd0-7872-8f9a-0bb7eb5f26ce`. The
  clean `2489f014` checkpoint and all remaining obligations transfer through the
  user-authorized claim takeover, event9542. The registry records both the
  current owner and prior-owner audit; this annotation grants no authority.
- Spec: `CAWS-NATIVE-RUNTIME-001`, active and bound to
  `native-runtime-modernization`.
- Source inspection baseline: `fb788cd241424ed3977081c9ad458b6c1fec7c59`.
- Lane fork/source baseline: `214ae6e01ccf7d44579a5cf9b07b13cb9b42890c`.
- Release lane `release-12-2-rc3` and other sessions' work are foreign; preserve
  their changes and reconcile shared build/package interfaces before landing.
- The migration goal remains open until replacement, integration, adoption and
  acceptance obligations are met. A completed component does not close the goal.
- Machine installation replaces the old runtime only after full parity with the
  previous selected version is established. Isolated package/harness
  qualification precedes that cutover; after cutover, verify actual selected
  execution here.

## Re-entry and next-work reconciliation

Before starting work after compaction, handoff or user direction, reconcile the
conversation's original objective and later corrections against this tracker's
feature, evidence, acceptance and ordered-work ledgers. Verify the current
revision, dirty state and CAWS ownership; summaries and tracker entries are
context, not proof of current behavior. Preserve outstanding obligations unless
the user supersedes them. Distinguish committed, reviewed, landed, accepted and
installed work, and correct stale next steps before choosing another task.

Use the [ordered next work](#ordered-next-work) for execution and the
[feature ledger](#feature-ledger) for current replacement state. The retained
checkpoint context records the scope and limits of earlier observations.

## Retained checkpoint context

The macOS invocation path includes a separate native custodian that creates the
Node engine before readiness. E145 observes the original frontend's death,
same-Node cleanup, actual reap, both EOFs and external process absence through
that entry path. E149 observes the repaired ordinary protocol fixture with an
independent topology observation and the original caller PID. E152/E155
establish request-local renderer coverage and custody correlation; E153
exercises the terminal fixture, and E156 observes the actual
typed-engine/selected-renderer consumer. E162 observes one actual frontend loss
after Ready/dispatch, separate native and renderer cleanup, a fresh
unknown-fence refusal and cooperative-writer recovery. Other frontend-death
phases and surfaces, complete consumer migration and resident execution remain
open. E135 closes the raw patch-alias admission gap; E136 closes false
completion after a failed cleanup attempt. Neither closes all frontend-death
phases, complete group settlement, missing-session identity or the unchanged
thirteen-session/four-repository fairness requirement. A post-Ready registration
cannot transfer parent wait authority or protect the pre-Ready interval.
Per-invocation custody can establish that narrower boundary before reuse by a
resident host; it does not establish warm execution or speed.

The terminal bridge at `e01a1b00` has completed committed-candidate review; E56
retains its clean committed replay. Neither observation closes R32 or earns
whole-runtime acceptance. E57 reproduces R33's cold-start service failure
through the actual native/typed path. The next boundary is explicit service
ownership and client integration, alongside the remaining R32 process-domain and
identity contracts. E61 exercises the R07 payload-cwd repair through the
isolated native consumer with refusal and ordinary-file controls. E62 exposes an
R05 guard-strength regression: an earlier advisory masks a later
confirmation-class command substitution. E63 restores substitution precedence
with statement-specific proof; E65 observes its typed execution, selected-shell
warning/latch effects and native handoff in a private installation. E64's
complete native suite passes without attributing the earlier backpressure
timeout. E66 repairs an ambient containment handoff in independently adopted
shared guards; E67 exercises its committed native effect path. E68 records the
opt-in foundation's source landing and retained full migration obligation. E69
adds externally owned post-effect cleanup qualification and capture diagnostics,
and retains a failed replay: ancestor capture expires above the intended target
and containment is held. R32 reliability and R33's selected-client/service
ownership remain open. E70 records typed render requests and a Rust
durable-outcome journal exercised across separate processes. It does not
establish a running renderer owner or request-time grant revalidation. E71
replaces the opt-in Darwin observer's per-lookup process with SDK reads after
formatter/process comparisons, and observes terminal containment and strict
cleanup checks in private protocol fixtures. E69's historical expiry remains
unattributed; complete process ownership and containment parity remain open. E72
exercises a descriptor-bound renderer client through an actual sourced shell and
compiled Node with a fixture owner. The client cannot activate itself: native
grant issuance, source/image admission and the real service owner remain the
next R33 integration boundary. E73 retains one own-ancestor comparison under the
native capture budget. It qualifies that sampled context; it does not establish
protected-target access, logical-session ownership or a latency distribution.
E74 adds native decoding of the typed service wire and exact-request
correlation. E75 retains a reproduced whole-root substitution counterexample and
a custody repair exercised across processes. Neither component admits an actual
service. The subsequent complete Cargo run passes library/binary checks but
fails a terminal cleanup observation on an unretained process-status token;
preserve that failure and collect raw observations before changing its oracle
(E76). E77 adds raw-query retention without changing the strict oracle, then
observes a successful targeted replay and complete Cargo run. The earlier
missing token and the cause of that observation failure remain unknown. E78
reproduces a macOS cleanup stall and a separate early custody release, then
retains actual repaired child/group/pipe observations. E79 exercises the
reviewed source image and typed offer/dispatch boundary, including its original
tool-order failure. The renderer owner, native descriptor bridge and complete
selected Stop route are connected. E80 retains the actual admission/deadline
failures; E81 observes the full selected cold/warm path, exact foreign-renderer
output and owned idle retirement in an isolated repository. Independent
inspection exposes queued expiry and delayed-surplus framing defects; E82
retains their integrated checks and committed-candidate replay. Wider
compatibility, legacy writer exclusion, uncertain-outcome recovery and
multi-project workload remain open. No machine replacement follows from these
bounded results.

The root owns parent integration, Git and acceptance under the existing spec and
lane. GPT-6.1 Sol assignments produce bounded drafts or read-only findings; only
separately bound peer lanes own their declared source. These assignments do not
confer authority or acceptance.

| Outcome                                        | Owner and boundary                                                                                                                 | Observable acceptance / falsifier                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle, custody and legacy writer exclusion | Root; retain the finite E156/E162 observations and unresolved phases                                                               | Actual owned cleanup, correlated uncertain-outcome recovery and prior-writer adoption/drain; sampled lifecycle success cannot establish every phase or surface                                                                                                                                                 |
| Complete heartbeat consumer                    | Root integrates typed application, native cache exchange and precomposition binding; root owns complete-chain qualification        | E172/E173 retain prior application/runtime checks; E177 resolves retained missing-SID cleanup. E182/E186 exercise cache publication and downstream attribution/authority. Fresh full-stock heartbeat replay and complete dependency/profile closure remain open.                                               |
| Thirteen sessions / four repositories          | Root after a measured complete-consumer change                                                                                     | Thirteen overlapping native clients, isolated semantic output, durable cross-project Running overlap, owner-specific ordering, independent enforcement and bounded overload; retain the original fixture and budgets                                                                                           |
| Python pytest entrypoint retirement            | Root integration E170; separately closed `CAWS-NATIVE-PYTEST-ENTRYPOINT-001`, chat `01a15984-840d-7301-a25a-7e681fd83b29`          | Original cold baseline and fresh combined-parent lifecycle, missing-pretest rejection and owned cleanup are observed; the other12 pytest modules plus conftest remain parent obligations                                                                                                                       |
| Transcript adapters and interpretation         | Root integrates closed Claude/Qwen/Kimi/DSH/OpenCode/Zcode and numeric-token components; peers own only separately assigned slices | Claude and token imports are observed in E168/E179. E190 imports the five closed Qwen/Kimi/DSH/OpenCode/Zcode components; E192 imports their ordered registry and exercises combined parent transcript contracts. Acquisition, cache, writer, profile selection and installed consumption remain parent-owned. |

The closed `CAWS-SQLITE-STATIC-BUILD-001` component is imported in E198. Parent
ownership covers its helper, hostile tests and
`packages/caws-cli/tsconfig.vnext.json`; the temporary configuration support
partition is discharged. Root retains Cargo/native admission, raw SQL
acquisition, projection and consumer integration.
`CAWS-NATIVE-AR-INSPECTION-001` is superseded without source changes after
guarded worker writes refused despite its CLI claim. Root accepts the complete
inspector contract. E199 implements its bounded framing and builder consumer;
the disposition does not resolve the effective hook/session identity mismatch.
The closed/completed `CAWS-STORE-JSON-001` component is imported in E202,
restricted to the decoder and its tests. E200 supplies SQL-cell reference
evidence; root retains profile selection, SQL acquisition, explicit store-AST
projection and publication integration.

`CAWS-TRANSCRIPT-NODE-FLOOR-001` qualifies emitted transcript preparation on the
declared Node 18.0.0 floor for R18 and is integrated at `505ec19f`; E228 records
its bounded package evidence and partial lifecycle failure.
`CAWS-STORE-TIMESTAMP-SENSITIVITY-001` (worktree `timestamp-sensitivity`)
retains the five R09 regression controls E226 lists as gaps. Its source and
tests remain unchanged while execution and edit refusals are unresolved; E229
records the accepted parent qualification dependency. `caws worktree list`
reports current bindings and owners. Component closure is not parent acceptance.

The reviewed legacy client falls back inline on every non-success response, and
its unchanged daemon/renderer do not acquire the native owner lock.
Shared-output adoption therefore requires all legitimate writer paths to
cooperate and a positively established transition from any prior uncooperative
writer. A fence implemented only in the new service does not establish that
transition. Private fixtures and cooperative successor evidence cannot imply
deployed Sterling exclusion, full A3/A8 acceptance or machine installation.

The State cells describe the established implementation boundary and remaining
consumer work; they are not a fixed lifecycle vocabulary. Keep committed,
tested, packaged, installed, native-observed and retired claims separate.
Existing Python consumers remain obligations until removed or explicitly
classified as foreign/historical test material.

The following coverage index defines which feature rows contribute to the
partial-implementation numerator. Each range is inclusive; the feature table
below supplies the row's source, boundary and acceptance evidence.

| Feature rows | Qualifying committed replacement slice | Row count |
| ------------ | -------------------------------------- | --------- |
| R01          | no                                     | 1         |
| R02–R18      | yes                                    | 17        |
| R19          | no                                     | 1         |
| R20–R21      | yes                                    | 2         |
| R22          | no                                     | 1         |
| R23–R26      | yes                                    | 4         |
| R27          | no                                     | 1         |
| R28–R37      | yes                                    | 10        |

Committed qualifying replacement implementation slices cover **33/37 feature
rows (89.2%)**. R01/R19/R22/R27 lack that coverage, and no complete row has
retired its Python production path. Investigations, reference evidence and
support tooling alone do not qualify. This count includes standalone components
awaiting parent integration; it measures feature coverage, not cutover effort or
readiness. Uncommitted drafts do not advance this count. Parent acceptance is
**0/8**. Recompute coverage when a row changes and use the acceptance ledger,
parity evidence and selected installation state to determine cutover readiness.
E174 and E178 ground the Kimi and DSH row corrections; E184 grounds OpenCode and
Zcode. E225's accepted and landed preparation component qualifies R18 as a
partial implementation; its production renderer remains unreplaced.

## Feature ledger

Paths beginning `runtime/`, `shared/`, or `codex/` refer to
`packages/caws-cli/templates/hook-packs/`. All features remain parent-owned;
bounded assignments transfer execution only, not acceptance ownership.

| ID  | Feature / authoritative source                                                                                      | Destination                                                                | State                                                                                                                                                       | Dependency / acceptance evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | `runtime/bootstrap.py`: immutable generation bootstrap                                                              | Rust client + TS generation resolver                                       | unreplaced                                                                                                                                                  | Identity tamper, upgrade, absent runtime, native error tests; package targets unproven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R02 | `runtime/caws-hook.py`: configuration, selection, overrides                                                         | TS invocation engine and existing authority adapters                       | isolated one-shot selection and finite native cache prefix/consumer exercised, E186; complete enforcement open                                              | Shared validators and freshness/override fixtures; full authority, override execution, complete dependency/profile closure and full-stock replay require qualification.                                                                                                                                                                                                                                                                                                                                                                                                   |
| R03 | `runtime/caws-hook.py` and `shared/lib/run-handlers.sh`: invocation scheduling, provenance, composition and handoff | TS supervisor/journal/composer                                             | one-shot journal/composer/local ACK integrated; resident open                                                                                               | E33 retains actual input/handler/index/native-output artifacts; crash persistence, production message settlement and resident admission remain open                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R04 | `runtime/caws-hook.py`: native output and phase/event error policy                                                  | TS native-response adapter, Rust exact delivery                            | selected production refusal and native Stop fixture exercised                                                                                               | E33 nonlatching refusal; E34 real native budget with fixture context. Complete event/harness/Stop producer behavior remains unqualified                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R05 | `shared/classify_command.py`: shell syntax and mutation classification                                              | Typed TS classifier                                                        | substitution precedence repaired; typed execution, selected-shell state and native handoff exercised, E63/E65                                               | E62 reproduces advisory masking. The proof-aware two-pass classifier preserves baseline substitution precedence and statement-specific context; full classifier corpus, stateful consumer and harness parity remain open                                                                                                                                                                                                                                                                                                                                                  |
| R06 | `shared/lib/guard-config.py`: consumer policy configuration                                                         | TS configuration module                                                    | selected-stock root integration and public-control repair exercised, E119                                                                                   | Fresh typed assignments reach four actual shell consumers; custom/parser compatibility remains. The original merge removed public NO_ASK and was unsafe; `900f0516` repairs it with retained negative and actual-guard controls. No Python retirement or harness refusal-propagation claim                                                                                                                                                                                                                                                                                |
| R07 | `shared/lib/hook-utilities.py`: rg replacement, ignored staging, focused-test and document-metadata policies        | Typed TS guard utilities + bounded Git port                                | component and isolated native cwd repair exercised, E61; full consumer retirement open                                                                      | Actual shell consumer is `shared/hook-utilities.sh`; the typed bridge preserves supplied cwd, filesystem symlink/parent traversal and absent/empty fallback. Real Git index and heredoc/routing controls are separate from installed parity; lockfile restore belongs to the classifier                                                                                                                                                                                                                                                                                   |
| R08 | `shared/advisory_truncate.py`: UTF-8 byte budget                                                                    | TS byte truncation module                                                  | stock Bash/image and actual local native UTF-8 boundary cases exercised, E124/E127                                                                          | E126 retains the failed producer/composition baseline; `39c76f51` repairs the stop receipt boundary. Native `43e4b131` delivers exact natural partial/complete bullet cuts and a complete required-goal refusal. The Stop extension emits a PreToolUse envelope, so local output does not establish platform consumption. Optional-tool absence, selected custom Python compatibility and retirement remain separate                                                                                                                                                      |
| R09 | `shared/lib/transcript-store.py`: transcript/cache persistence                                                      | Native read-only SQLite acquisition + typed projection                     | Bounded native acquisition/reconstruction E211/E212, original-invocation binding E216 and resident acquisition/settlement E240; production store unreplaced | E240 retains actual acquisition beyond frontend loss and exercises the real Actor mailbox across prepared renderer withdrawals. E307/E310 establish finite SQL numeric-profile parity and explicit-selector refusal before adapter effects. Root owns native admission, single-use publication under continuous writer custody, record release, receipt/delivery and ordinary renderer consumption. Complete path/calendar/profile/WAL/cleanup, sustained capacity and adoption remain open.                                                                              |
| R10 | `shared/lib/harness_common.py`: shared transcript normalization                                                     | TS normalization interfaces/common implementation                          | lossless/common foundation and ordered registry imported and exercised, E157/E192; production consumer unreplaced                                           | Occurrence custody, normalization and the pinned CPython3.11.13/Unicode14 profile have bounded evidence, E157/E163; complete historical projections and production renderer/cache integration remain open                                                                                                                                                                                                                                                                                                                                                                 |
| R11 | `shared/lib/harness_claude.py`                                                                                      | TS Claude adapter                                                          | standalone component integrated, E168; production consumer unreplaced                                                                                       | Harness-specific transcript fixtures and installed render evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R12 | `shared/lib/harness_codex.py` and `codex/hooks/lib/session-transcript.py`                                           | TS Codex adapter                                                           | bounded Codex occurrence adapter landed and integrated, E157; production consumer unreplaced                                                                | Explicit occurrence context, transaction refusal and CodepointText literal/index projections are exercised, E157/E163; complete compaction, native lifecycle, renderer/cache consumption and Python retirement remain open                                                                                                                                                                                                                                                                                                                                                |
| R13 | `shared/lib/harness_qwen.py`                                                                                        | TS Qwen adapter                                                            | closed component imported and parent transcript checks exercised, E190; production replacement open                                                         | Surface-specific transcript and native registration fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R14 | `shared/lib/harness_kimi.py`                                                                                        | TS Kimi adapter                                                            | closed component imported and parent transcript checks exercised, E190; production replacement open                                                         | Surface-specific transcript and native registration fixtures; Parent first-matched-empty registry behavior is exercised in E192; ordinary production consumption remains open. `main` `8a758936` adds deferred annotations to `harness_kimi.py` so stock `/usr/bin/python3` 3.9.6 imports it; R01 candidate `bfb548e6` ports that exact fix and AST test, with the two affected legacy SessionStart consumers passing; normal merge `aea8dcda` integrates this source into parent `1169f7df`, with matching blob `8c099e77`; ordinary production consumption remains open |
| R15 | `shared/lib/harness_opencode.py`                                                                                    | TS OpenCode translation and noise declarations; zero row adapters          | closed declarations imported and parent transcript checks exercised, E190; production consumption open                                                      | Actual R09 DB acquisition/reconstruction owns mapper consumption and fallback; renderer owns noise filtering. Declarations do not implement those consumers or installed behavior                                                                                                                                                                                                                                                                                                                                                                                         |
| R16 | `shared/lib/harness_zcode.py`                                                                                       | TS Zcode adapter                                                           | closed component imported and parent transcript checks exercised, E190; production replacement open                                                         | Stateful model_io component evidence; DB-to-Claude-shaped acquisition, reader/cache/writer, registry, native and installed consumption remain parent obligations                                                                                                                                                                                                                                                                                                                                                                                                          |
| R17 | `shared/lib/harness_dsh.py`                                                                                         | TS DSH adapter                                                             | closed component imported and parent transcript checks exercised, E190; production replacement open                                                         | Surface-specific transcript and native registration fixtures; root owns selected interpretation, registry, reader/cache/writer and native consumption                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R18 | `shared/session_log_renderer.py`: normalized turn rendering                                                         | TS renderer + recoverable worker                                           | bounded preparation accepted and landed, E225; frontend settlement retained, E231; production renderer unreplaced                                           | Selected numeric/catch/spill and output boundaries exercised at199fa5e. Native publication/current-attempt admission, real SessionEnd consumption, production calendar, context-bound freshness, packaging and installed rendering remain open; E147/E165 partial-publication counterexamples are not closed by preparation.                                                                                                                                                                                                                                              |
| R19 | Python embedded in shell helpers/dispatchers                                                                        | TS modules or bounded native operations                                    | inventoried; unreplaced                                                                                                                                     | 15 executable shell consumers, 19 inline bodies and seven external callsites; the [embedded inventory](#embedded-and-developer-implementation-coverage) groups them and excludes textual interpreter mentions                                                                                                                                                                                                                                                                                                                                                             |
| R20 | Python developer/harvest/qualification scripts                                                                      | Typed TS tooling                                                           | rule-token, sensitivity, hook-harvest and replay leaves accepted, landed and integrated; three original paths unreplaced                                    | E134/E144/E148/E163 retain bounded reference profiles, deliberate repairs and raw failed/successful artifacts. E151/E163 integrate the exact source and Python deletions; qualify-render-daemon.py, qualify-transcript-cache.py and source_freshness.py remain; component progress is not parent acceptance                                                                                                                                                                                                                                                               |
| R21 | Python-owned regression tests                                                                                       | TS/native behavioral tests                                                 | two test-module retirements integrated, E170/E236; remaining corpus unreplaced                                                                              | Integration source `cc95efeb`: eleven test modules plus conftest (12 tracked pytest files). Main has twelve modules plus conftest because `test_template_annotation_compat.py` remains main-only. Preserve independent hostile oracles and checked failure causes; production guard dependencies remain Python.                                                                                                                                                                                                                                                           |
| R22 | Tracked installed `.caws/hooks` Python copies                                                                       | Governed self-host/runtime adoption                                        | unreplaced                                                                                                                                                  | Fourteen copies identified; do not edit generated/governed installation by hand                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R23 | Rust client / versioned local protocol                                                                              | `packages/caws-native` + TS protocol                                       | POSIX one-shot transport/cancellation and bounded actual-engine replay tested; macOS pre-Ready frontend-death custody observed, E145                        | E156 observes ordinary typed-engine/renderer replay and E162 one after-Ready/dispatch frontend loss; closed-pipe nonleader settlement, other loss phases/surfaces, descriptor leakage, resident IPC, bounded Stop recovery and installed parity remain open                                                                                                                                                                                                                                                                                                               |
| R24 | One-shot typed engine                                                                                               | `packages/caws-cli/src/runtime`                                            | opt-in prototype; isolated nonlatching Codex branch exercised                                                                                               | Native client runs the actual typed engine and a production-selected stock guard in E33; full chain, stateful containment, other harnesses and installation remain unqualified                                                                                                                                                                                                                                                                                                                                                                                            |
| R25 | Demand-start, warm residency and idle exit                                                                          | Rust service owner/retained workers + typed engine                         | Isolated renderer profile E81 and bounded resident store acquisition E240; complete resident engine unreplaced                                              | E240 observes the original owner and retained store record beyond frontend death and idle eligibility. Unreleased finite records pin that owner; explicit release and sustained capacity, machine-wide fair admission, heartbeat retention, drain/version and the thirteen-session workload remain open.                                                                                                                                                                                                                                                                  |
| R26 | Persistent request outcomes / deferred queue                                                                        | Rust durable journal + typed TS outcomes and bounded scheduler             | normal/queued/dispatched cancellation and host-crash restart observed on native43, E128/E130                                                                | Runtime build39 and qualifier266 retain actual partial writes, accepted Unknown, correlated retry/capacity denials and reap/EOF/absence receipts. Fatal worker loss, generation replacement, autonomous drain and production retention remain unqualified                                                                                                                                                                                                                                                                                                                 |
| R27 | Package/install/upgrade/rollback and trust                                                                          | Existing TS init/store adapters + native artifact distribution             | Unreplaced; bounded rollback-history E237 and license transport E239 prerequisites land                                                                     | E239 verifies actual ordinary/private-snapshot license bytes and CLI activation, not a native image. R01's staged native entry requires combined-source package qualification, real native dispatch, upgrade/rollback, native trust and supported harness observations. Clean unpacked no-Python execution remains open.                                                                                                                                                                                                                                                  |
| R28 | Performance and load qualification                                                                                  | Replayable TS/native workload                                              | workload and exact semantic/ordering hostile controls tested, E91/E94; runtime unqualified                                                                  | Thirteen simultaneous sessions across four repositories; per-project/session distributions, stage cost, RSS, process count, fairness and bounded overload; 100 ms warm is a target                                                                                                                                                                                                                                                                                                                                                                                        |
| R29 | SOLID boundaries and existing CLI integration                                                                       | Shared typed kernel/store adapters                                         | shared heartbeat/message operations reused by CLI and typed stock consumer, E172 (`ad3a6d24`); complete boundary qualification open                         | Explicit canonical directory, identity, context, clock and store ports reuse existing lease kernel/store and message queue. Application and consumer semantic checks support this bounded slice; full dependency closure, installed parity and cutover remain open.                                                                                                                                                                                                                                                                                                       |
| R30 | Stop infrastructure budget persistence                                                                              | Rust project/session budget library                                        | library and native protocol-fixture consumption exercised                                                                                                   | E34 persists actual native charge/refusal/release/reset snapshots; production-engine Stop, full identity and harness recovery remain unqualified                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R31 | Machine-wide fair admission and owner-specific ordering                                                             | TS bounded scheduler                                                       | component tested; not integrated                                                                                                                            | Global/project/session queue caps, required capacity reservations, resource-domain ordering and thirteen-session/four-project controlled-worker tests; native workload proof remains open                                                                                                                                                                                                                                                                                                                                                                                 |
| R32 | Danger-latch containment across session resolution, latch state, agent PID/start verification and tool escalation   | Typed containment boundary plus native process operations                  | blocking; selected explicit-session path exercised, E51–E56; native Darwin lookup and strict cleanup oracle exercised in protocol fixtures, E71             | Preserve the actual latch → prohibited subsequent tool → verified caller process → termination chain, exceptions/reset, native refusal and observed nonexecution. Missing-session behavior, exclusive logical-session process ownership, reset races, different-credential lookup and compatibility paths remain obligations; no installed replacement                                                                                                                                                                                                                    |
| R33 | Persistent extension-service lifetime, including Sterling's renderer override                                       | Explicit service ownership and startup coordination                        | actual renderer cold/append/unchanged with per-request native custody and cleanup observed, E156                                                            | Selected copied Python renderer remains in use. Unchanged legacy writers demonstrably ignore custody; adoption and positively established drain remain prerequisites to shared-output cutover. E162 observes one dispatched frontend loss with recovery/refusal; full fallback/input compatibility, source retirement, final-candidate lifecycle replay and multi-project behavior remain unqualified; no machine replacement                                                                                                                                             |
| R34 | Exact extension payload values across native wire, event enrichment and selected consumer                           | Rust raw JSON transport + typed source-span forwarding/comparison          | integer regression repaired in isolated producer/consumer scenarios                                                                                         | E35 demonstrates old candidate rounding despite exit 0; E37 retains exact nested integers, consumer context and native refusal/control outputs. Decimal/exponent/Python normalization and all-harness parity remain unqualified                                                                                                                                                                                                                                                                                                                                           |
| R35 | Complete input normalization for project policy/override handlers                                                   | Selected full compatibility dispatcher until typed normalization qualifies | conservative routing implemented; Python dispatcher retained                                                                                                | E37 observes Codex original tool name, file-path list, integer custody and refusal channels at the actual selected extension. R19 remains a prerequisite to replacing this compatibility path                                                                                                                                                                                                                                                                                                                                                                             |
| R36 | Native wire control-field representation                                                                            | Typed source-token validation plus decoded numeric bounds                  | fractional-token decoder gap repaired; IPC authentication remains separate                                                                                  | E40 rejects rounded fractional PID/deadline tokens and retains canonical bounds; this does not establish the agent termination target                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R37 | Plan snapshot producer/carrier/finalizer ownership                                                                  | Native target locks and owner-partitioned tickets                          | native producer and actual selected sealed Stop observed, E105                                                                                              | Destination-side custody crosses configured homes; exact bytes, owner-specific acknowledgement and rendered turns reach the consumer. Shared producers, ownerless migration, Unicode plan names and foreign-owner target reuse remain open                                                                                                                                                                                                                                                                                                                                |

## Machine-wide workload and representation boundary

The user requires at least thirteen simultaneous sessions across at least four
repositories. This is a qualification workload, not a fixed maximum. Bound
worker and cache capacity across the machine, and admit work fairly across
projects and sessions. Serialize operations by their actual owning state,
including canonical project plus session for session state; retain project-store
transactions for cross-session mutations. Rendering cannot monopolize required
enforcement. Heartbeat expiry never evicts an active request or discards
recoverable work. Qualify mixed harnesses, repeated session IDs across projects,
slow extensions, large transcripts, bursts, overload and generation upgrades.
Report per-project and per-session distributions so aggregate performance cannot
hide starvation.

The response protocol carries canonical base64 channels, decoded to native byte
buffers. Component fixtures preserve stdout `ff 00 61`, NUL and every byte
value; Codex JSON interpretation and generated text have explicit UTF-8
boundaries. Composition retains its defined LF framing and raw journal captures.
These checks do not establish integration with an actual typed engine or
installation. The Stop budget also needs project-scoped identity: a
machine-global session ID cannot isolate cross-project work. Ambiguous legacy
counters remain untouched instead of acquiring a project.

## Review findings carried into implementation

The architecture document contains the grounded assumptions, severity-ranked
failure modes and proof requirements. Resolve before resident enforcement:
request-local state; request-time authority freshness; event/phase-specific
error behavior; native refusal channels; cancellation and uncertain delivery;
preserved override/library semantics; bounded scheduling; versioned persistence
and runtime identity. Heartbeats govern warm retention only.

The zero-child claim is withdrawn for arbitrary Git/CLI consumers and custom
extensions. The measurable objective removes first-party orchestration fan-out;
each remaining subprocess has a declared purpose and separately measured cost.

## Evidence ledger

| Evidence | Revision / command / observation                                                                                                                                                                                                                        | Scope and remaining gap                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01      | Baseline `fb788cd2`: `caws status`, clean canonical checkout; doctor reports 0 errors / 3 warnings                                                                                                                                                      | Registry and hook-maintenance warnings predate migration; no native migration proof                                                                                                                                                                                                                                                    |
| E02      | Lane `214ae6e0`: `node packages/caws-cli/scripts/build-cli.js`, exit 0                                                                                                                                                                                  | Strict existing TS layer emitted; no hook semantics or daemon execution exercised                                                                                                                                                                                                                                                      |
| E03      | Source inventory: 17 canonical runtime Python files, 16 excluding Codex shim total 8,936 lines; 14 tracked installed copies, 14 pytest files, 9 dev/experiment scripts                                                                                  | Embedded program inventory and full consumer mapping remain open; counts alone do not establish equivalent behavior                                                                                                                                                                                                                    |
| E04      | Incident session `01a14bde-75be-7f21-b95c-2c422dd3485d`, runtime digest `408c06a7cbdb1950e24f53a7486428c3a51e45bbeb86292cb9b2dec30177baa0`: pre at 42.379 s only starting fourth handler; post at 58.102 s starting audit after ten successful handlers | Existing interrupted journals demonstrate accumulated delay; isolated journaling cost and native delivery were not measured                                                                                                                                                                                                            |
| E05      | Lane base `214ae6e0`, unchanged baseline runtime: focused `tests/adapter/runtime-bootstrap.test.js`, exit 0, eight fixtures                                                                                                                             | Registry ordering, strict mode and Git/non-Git context resolution exercised; no daemon or native refusal proof                                                                                                                                                                                                                         |
| E06      | Native worker: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test -- --test-threads=1`, exit 0; one unit and ten executable groups                                                                                                   | Real Node fixture with empty PATH, raw input custody, malformed/oversized replies, identity mismatch, deadlines and owned process-group cleanup; production TS engine and external termination unproven                                                                                                                                |
| E07      | Lane uncommitted candidate: `node scripts/build-cli.js`, then focused Jest for `tests/runtime/{native-response,guard-config,utf8,protocol}.test.js`, exit 0; 148 checks                                                                                 | Native/error/context and protocol custody, configuration all-or-nothing/hostile paths, byte semantics exercised; precedes E09 selection and additional protocol boundary checks                                                                                                                                                        |
| E08      | Combined build after adding selection, exit 2: `src/runtime/selection.ts(184,37): TS2322 unknown is not assignable to string[]`                                                                                                                         | Jest did not execute in this attempt; fixed by validating the selected stock chain before passing it to the authority resolver                                                                                                                                                                                                         |
| E09      | Lane uncommitted candidate: `node scripts/build-cli.js`, then focused Jest for `tests/runtime/{native-response,guard-config,utf8,protocol,selection}.test.js`, exit 0; 166 checks in five suites                                                        | Adds real FS selection freshness, order, adoption/tamper/override cases and protocol identity/UTF8 boundaries. Still no production engine, daemon, installation, native harness or performance proof                                                                                                                                   |
| E10      | `git diff --check` exit 0; `node packages/caws-cli/scripts/validate-docs.mjs` exit 0                                                                                                                                                                    | Five strict-set documents valid; 30 warnings on unchanged legacy documents. Migration docs have valid front matter; this is not acceptance of their target implementation                                                                                                                                                              |
| E11      | Uncommitted candidate: build and six focused Jest suites (runtime modules plus owning repo-hook-policy validator), exit 0; 308 checks                                                                                                                   | Adds inherited guard/threshold rejection and Unicode prefix/reason boundary assertions at the authority owner. No consumer adoption or resident/native delivery proof                                                                                                                                                                  |
| E12      | Initial ESLint call from the repo root found ignored paths; package-local executable path was absent; resolved root executable from package cwd found one `no-unexpected-multiline` in guard-config tests                                               | Earlier attempts did not establish lint success. Call formatting repaired; final lint/typecheck outcome is recorded with the foundation candidate                                                                                                                                                                                      |
| E13      | Package cwd: root ESLint executable against six runtime sources, five runtime tests and owning policy tests, exit 0; `tsc -p tsconfig.vnext.test.json --pretty false`, exit 0; guard-config Jest recheck, 41 checks, exit 0                             | Runtime strict typing and lint established for this component candidate. Separate `tsc -p tsconfig.kernel-test.json` exits 2 at untouched `telemetry-turn-log-schema.test.ts:237` (`usage.required` absent from inferred JSON schema type); it is not a runtime-module failure and remains unmodified                                  |
| E14      | Foundation committed as `89fcc39f`; subsequent build passed and integrated ten-suite Jest run produced 440 pass / 2 fail                                                                                                                                | Classifier missed protected home when the platform resolves `/home` through a symlink; a kubectl read-effect oracle expected an undeclared builtin capability. Source and oracle repairs require a fresh run; passing neighboring suites are not classifier equivalence                                                                |
| E15      | Native cancellation failed attempts: Darwin empty-mask pipe polling missed a closed reader; `/dev/null` produced `POLLNVAL` and a false cancellation                                                                                                    | Corrected by polling `POLLOUT` and restricting closed-reader inference to FIFO/socket descriptors; added real-pipe and regular-file/null-device controls. A watchdog-owned orphan was identified and its owned group terminated                                                                                                        |
| E16      | Native worker: format, strict all-target Clippy and serial Cargo tests exited 0; three unit checks and fifteen executable groups                                                                                                                        | Nine TERM/INT/HUP phase cases, parent death, closed output, output backpressure and unrelated-process preservation exercised. A 1s request plus cleanup/delivery/diagnostic budgets finished below 2.1s in the fixture; reserve up to 1.1s overhead in integration. No SIGKILL/escaped-group, Stop recovery, harness or resident proof |

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
- E20: `caws specs amend` added A8 and a machine-wide isolation invariant for
  the user's thirteen-session/four-repository workload. No acceptance was
  recorded. Native Stop-budget library checks passed sixteen module cases,
  including same session IDs across projects. Initial mutation baseline failed
  before testing mutants because its copied crate lacked the sibling registry
  fixture. The library-only run tested 184 mutants: 112 caught, 55 missed, 12
  unviable and five timeouts, exit 3. Artifacts are in
  `packages/caws-native/target/stop-budget-mutation-lib/mutants.out`; the missed
  directory/lock/read checks expose weak hostile-path fixtures and require
  repair. A delegated redirected mutation command was refused by the installed
  write guard; the owning parent verified scope and started the explicit scoped
  command.
- E21: The strict CLI build and targeted ESLint passed. Four focused suites
  (scheduler, composer, protocol and native-response) passed 210 checks.
  Scheduler coverage independently observes actual unresolved executors for
  thirteen sessions across four projects, machine/project peaks, exact
  state-owner overlap, rendering/required reservations, queue quotas, drain, and
  cancellation that retains capacity until execution settles. This is
  controlled-worker component evidence, not native-client fan-out or daemon
  recovery. The runtime test TypeScript configuration also compiled
  successfully.
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
  the strict CLI build passed. Eleven combined runtime/shared-owner suites
  passed 556 checks. Real Git fixtures invert canonical versus linked-checkout
  HEADs and stage a deletion in a foreign index; joined/repeated `-C` observes
  the actual checkout, while unmodeled directory/config/environment routing
  grants no exemption. Wrapped recursive deletion, inert command arguments,
  read-only find and allowed scratch-child controls distinguish the intended
  behavior. These are classifier decisions; no destructive classified operation
  was executed.
- E24: Stop library repairs passed twenty-seven cases. The repaired full
  per-file mutation run tested 178 changes: 139 caught, twenty missed, fifteen
  unviable, four timeouts, exit 3. Nineteen misses have narrowly inspected
  Darwin equivalents (eighteen disjoint-flag OR/XOR, one redundant directory
  flag when opening literal `/`). The remaining fd0/stale-EEXIST test gap was
  repaired without changing production logic; its focused test passed and a
  targeted mutation rerun caught that one change, exit 0. Raw full-run score is
  unchanged. Artifacts remain under
  `target/stop-budget-mutation-repaired/mutants.out` and
  `target/stop-budget-mutation-fd-zero/mutants.out` in the native crate. This
  does not establish other-target equivalence, power-loss durability or native
  Stop integration. Unavailable-after-commit outcomes must not be retried.
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
  routing and deep nesting; utility controls include real Git index
  immutability, inert heredocs and executing substitutions. These checks do not
  establish native engine integration, installed behavior or complete shell
  soundness.

## Evidence ledger (continued)

Additional bounded evidence and unresolved dependencies:

- E27: The Stop-budget session key previously aliased `CaseA` and `casea` on
  case-insensitive filesystems. The exact-byte key uses lowercase unpadded
  base32, at most 209 bytes for the admitted 128-byte ID. The mixed-case test
  failed on the old key, then all 29 library cases passed (exit 0). Targeted
  `cargo mutants --file src/stop_budget.rs --re session_directory --cargo-arg=--lib --output target/stop-budget-mutation-session-key`
  exited 2: 21 tested, 20 caught, one missed. The missed OR→XOR mutation
  combines disjoint bit ranges and is equivalent; the raw result remains
  retained under that target path. This does not establish native-wire use,
  process-crash or power-loss recovery.
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
  binary units passed; 17 executable groups passed and two failed. The late 1 MB
  proposal did not reach the expected native-delivery failure path; stderr
  instead reported an execution deadline. The 250 ms timeout fixture also
  assumed dispatch before observing its grant. Its old failure artifacts were
  removed by teardown, so cold-start delay remains an inference. Corrected
  scenarios distinguish an observed grant from startup, early large output from
  a small late proposal, and exact partial bytes from infrastructure JSON. The
  subsequent executable run passed 20 groups in 22.98 s, exit 0; strict Clippy
  exited 0. Failed fixtures are retained, and explicit artifact-root selection
  retains successful fixtures. These are transport-fixture checks, not
  production containment or native-harness acceptance.
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
  request-ingress target observations, complete identity/reuse controls, actual
  disposable-target exit and surviving-sibling evidence; a signal stamp alone is
  insufficient.
- E33:
  `node packages/caws-native/target/qualification/engine-wire-2026-10-19T04-02-55-400Z/run.cjs`
  (invoked from the native crate via its absolute path) exited 0. An isolated
  machine home installed the production template snapshot, then production
  selection admitted only stock `block-dangerous.sh`. The compiled Rust client
  invoked the actual built engine. Native exits were 2 for a bare commit with a
  staged tracked deletion, 0 for the explicit-path control, and 0 for the same
  bare command after removing the staged deletion. Raw stdout/stderr, status,
  input, index bytes, selected-source identity and invocation journals are
  retained in that probe directory. Each index remained byte-identical during
  its invocation; journals include matching input SHA256, handler completion,
  local native handoff and adapter finish. No PATH `python3` trap fired.
  Termination was explicitly disabled in this isolated fixture, so it earns no
  containment, full-chain, harness-withholding or installation claim.
- E34: Native Stop-wire scenario artifacts are retained under
  `packages/caws-native/target/qualification/stop-wire-2026-10-19T03-55-40-878Z/`.
  Its manifest records actual native exits 2/2/2/2/0/2/0/2 and counter snapshots
  1/2/3/3/0/1/0/1. The valid refusal leaves count 3 intact, the fourth
  infrastructure failure releases explicitly, and a successful nonblocking Stop
  resets the counter. Exact output and per-call status files are printed by the
  runner and retained. Its engine is a protocol fixture; it cannot establish
  production selection/context, containment, harness action, resident operation
  or crash/power-loss durability.
- E35: The counterexample is retained under
  `packages/caws-native/target/qualification/numeric-custody-red-2026-10-19T04-36-05-075Z/`.
  Its runner exits 1 because the actual Rust → typed engine → selected project
  override path delivers 9007199254740993 as 9007199254740992 and
  18446744073709551617 as 18446744073709552000. The source Python adapter
  delivers both integers exactly through the same selected snapshot. All six
  individual adapter calls exit 0. Consumed stdin, raw outputs, statuses,
  commands, source/build identities and journals retain the distinction. Two
  preceding attempts used an incorrect Python script path; their failed
  artifacts remain in the qualification directory and establish no baseline
  behavior.
- E36: The expanded probe `numeric-custody-green-2026-10-19T04-51-04-316Z/`
  retains an incorrect oracle: it expects exported full JSON where the selected
  parser keeps `HOOK_INPUT_JSON` local. Source inspection of shared and Codex
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
  input/response projections, absence of exported full JSON, original tool name,
  file path/list, stdout, stderr, status and invocation journals. Every
  candidate case records `compatibility_dispatch_completed`. This is an isolated
  custom guard with termination explicitly disabled; it proves neither real
  harness withholding nor containment, Python retirement, all extension
  contracts or complete guard parity. E37 does not observe the startup marker;
  E41 adds that observation.
- E38: The stock-route control is retained under
  `packages/caws-native/target/qualification/stock-route-2026-10-19T05-08-12-811Z/`.
  Its actual native/typed-engine scenario exits 0, with stock selected-handler
  stages, the staged-deletion refusal at exit 2, and explicit-path/unstaged
  controls at exit 0. Index hashes remain unchanged and no PATH Python trap
  fires. These commands are evaluated rather than executed; unchanged indexes do
  not establish harness withholding. Termination is disabled in this nonlatching
  fixture.
- E39: Current Rust checks include raw wire-token custody and invalid-number
  rejection before engine startup, alongside the existing cancellation, output,
  protocol and Stop-library checks: `cargo clippy --all-targets -- -D warnings`
  and `cargo test --all-targets -- --test-threads=1 --nocapture` exit 0. The six
  focused CLI suites exit 0 with 144 cases; the actual routing test pins
  consumer fields, refusal and the compatibility journal stage. The initial
  full-file source mutation report is
  `packages/caws-cli/reports/mutation-runtime-json/mutation-report.json`: 181
  killed, 10 timeout, 24 survived, one uncovered, raw score 88.43%. Exact budget
  and negative-number controls were missing; strengthened tests exercise those
  counterexamples. A separate selected-range report at
  `reports/mutation-runtime-json-boundaries/mutation-report.json` records 32
  killed, three timeout and two survived of 37 (94.59%). That is not a
  recomputed full-file score. The remaining selected-range survivors alter a
  redundant defined-character check and a root-token endpoint beyond EOF, whose
  slice clamps to the same text after grammar validation; this does not
  adjudicate every survivor in the full report. Passing tests and these bounded
  observations confer no A2–A8 acceptance.
- E40: A direct decoder counterexample exits 1 when wire process ID
  `123.00000000000000001` is accepted as 123. Source-span validation rejects
  that spelling before decoded numeric bounds; the same check then exits 0 with
  `RuntimeProtocolError: Invalid native caller snapshot`. Raw fractional,
  exponent and negative-zero controls and exact boundary positives are in
  `tests/runtime/protocol.test.js`. The current Rust producer emits canonical
  integer controls, so this is a decoder-contract repair before independent IPC
  admission, not an observed native targeting bypass or caller authentication
  proof.
- E41: Startup-marker and extension artifacts are retained under
  `packages/caws-native/target/qualification/native-wire-controls-2026-10-19T05-22-52-884Z/`
  and the final representation-only helper revision under
  `native-wire-controls-2026-10-19T05-38-00Z/`. Both scenario commands exit 0.
  Each has 12 actual baseline/candidate calls with exact integer and context
  observations, even-value allow and odd-value refusal controls. The consumer
  writes `startup-observation.json`: null in plain cases and `selected` when the
  supplied startup executes. `readback.cjs` recomputes every case's journal
  input hash and runtime digest and compares all six pairs of raw stdout/stderr
  bytes. Both readbacks exit 0; committed-build identity must be checked
  separately. All cases explicitly disable termination and do not execute
  proposed tools. At committed revision
  `8acc4b7675e8d1de78d2e12854b322555be0946b`, `check-committed-build.cjs`
  exits 0. Its raw build record and comparison match all 21 runtime modules and
  the native binary to the final scenario; the canonical-control mutation report
  also matches the committed source.
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
  and ESLint checks exit 0. These checks exercise control representation, bounds
  and payload custody, not process ownership or termination.
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
  parity or a demonstrated native-only regression. Kill mode is explicitly 0; no
  signal, actual harness withholding or agent termination is established. The
  selected parser is the Codex surface file (`04a21ee0…0a73c61`), which writes a
  durable envelope but no PID record. The shared parser's PID writer is not that
  selected producer; a prior source prediction using it is withdrawn. Neither
  mode produces a PID record here. The baseline creates the durable envelope
  while the direct candidate path omits it; downstream legacy attribution
  effects require a separate consumer probe and confer no ownership authority.
  Preseeded-cache, actual ingress, process-exit and surviving-sibling controls
  remain required. Earlier attempts remain at `latch-identity-red-2026-10-19/`
  (copied launcher SIGKILL before ancestry observation) and
  `latch-identity-retry-2026-10-19/` (incorrect basename-only comm oracle);
  neither is counted as a completed differential.
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
  observations under
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T06-38-48-060Z/`.
  The command
  `node packages/caws-native/target/qualification-tools/qualify-native-containment.js <absolute-cli-directory>`
  exits 1 against the original selected template digest `408c06a7…77baa0`. Both
  frontends select only stock Codex `block-dangerous.sh`; no input command
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
  agreement before any dry-run or signal. Refusal and strikes remain active when
  signaling is held. The 22-case effect run retained at
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
  `node …/bats` invocation exits 1 with SyntaxError before any test; the
  corrected invocation uses `bash …/bats`. Strict runner compilation, actual
  script ESLint, Rust formatting and shell syntax checks exit 0. Initial ESLint
  attempts ignored the TS script; `scripts/**/*.ts` is explicitly included in
  the package lint configuration. The Rust watchdog's independent
  `/bin/sleep 30` control records owned-hook wait signal 15, caller exit 21 and
  no admitted-action marker. Pipe EOF gates complete output capture; timeout
  aborts only owned capture streams and records incompleteness, never an
  inferred successful receipt.
- E48: Committed candidate `cea1ad2e` reproduces the failure through
  `npm run qualify:native:containment` from `packages/caws-cli`, exit 1 after
  successful CLI/Cargo builds and strict runner compilation. Artifacts at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T06-53-47-395Z/`
  record 22 completed observations and sole native enabled failure. Caller 89105
  exits via SIGTERM; stdout is empty, stderr reports original-caller
  cancellation, escalation is absent and the sibling heartbeat advances 147→219
  bytes. Legacy caller 62289 exits via SIGTERM with quarantine block and
  escalation intact. The generated repaired snapshot is `a822893a…7224c2`,
  selected guard SHA256 `39e99cf8…57ffdc`; it differs from the installed
  `408c06a7…77baa0` generation. The 46 checks in three focused
  routing/executor/engine suites and strict runner/source lint pass; doctor
  exits 0 with inherited 0E/3W/4I and five scope/structural gates pass. These
  checks do not exercise the demonstrated containment transport failure.
- E49: The qualification oracle checks one exact per-case audit record's
  session, command, verdict, action and reason, plus strike count/command and
  the enabled target stamp or absence of escalation on held paths. An existing
  or nonempty log alone does not pass. The stricter run at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T06-59-17-790Z/`
  exits 1 for native enabled refusal loss; all 22 audit checks pass in this run.
  Native caller 63806 exits via SIGTERM with empty stdout, while its escalation
  completes: audit interruption is timing-sensitive, refusal loss persists.
  `audit-oracle-controls.json` records seven rejected corruptions of the actual
  positive observation: empty/malformed log, foreign session, no-kill action,
  foreign target, missing strike and foreign strike command. Strict runner
  TypeScript and ESLint exit 0. The run records its source hash to distinguish
  this oracle from the earlier committed version.
- E50: Held-path validation rejects either escalation PID or timestamp,
  including a timestamp-only stamp. The nine-control run at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T07-06-21-222Z/`
  exits 1 solely for native enabled refusal loss after strict runner compilation
  and ESLint pass. All 22 audit observations pass; the original seven
  corruptions and separate held PID-only/timestamp-only corruptions are
  rejected. Native caller 10303 exits via SIGTERM, quarantine stdout is empty,
  the forbidden action marker is absent and sibling heartbeat advances 210→316
  bytes. This strengthens the evidence oracle; it does not fix the native
  effect/transport ownership conflict or establish cleanup after caller death.
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
  surviving sibling progress. The fixture uses a separately pinned owned cleanup
  group; it establishes transport/effect behavior, not selected-guard authority
  or actual harness isolation. The first attempt used a relative artifact root
  and failed configuration (`invalid ready budget home`, caller exit 42); its
  artifacts remain under `caws-native-26193-0/`. The successful rerun uses an
  absolute root and does not erase that failed attempt.
- E54: Source inspection identifies a guard-strength gap in the first bridge's
  64 KiB latch snapshot limit: the selected producer can retain a larger valid
  command/reason, causing TypeScript to discard an otherwise valid intent. The
  22 effect cases do not cover this boundary. E55 records the producer
  counterexample and repaired bound/escaping scenarios. Global hook dry-run also
  rejects bridge eligibility while the fallback guard can signal inline; the
  legacy dispatcher explicitly invokes handlers during dry-run. This is an
  inherited unqualified path, not a no-signal control. Mixed overrides, file
  tools, prior latch generations and reset/rearm coordination are outside the
  qualified route. Full parity remains blocked.
- E55: The producer counterexample at
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T08-07-07-585Z/`
  retains a 72,313-byte latch. The first bridge's caller 25002 survives with
  exit 0, block stdout and an operational-file-envelope diagnostic; no native
  settlement exists. Legacy caller 19399 exits via SIGTERM. The run also exposes
  a fixture-oracle defect: one `identitySafe` branch omitted the newly added
  signal-enabled case. All effect expectations use the same classification. The
  repaired reader derives its bound from successful producer argv admission: six
  times observed ARG_MAX plus 32 KiB for fixed/bounded metadata. Absolute
  `/usr/bin/getconf ARG_MAX` returns 1,048,576 here, yielding 6,324,224 bytes.
  Sidecar-derived reason text prevents deriving this bound from hook input
  alone. Small records allocate by observed size; final no-follow, type, owner
  and size checks remain enforced. Other hosts/resource-limit histories are
  unqualified. The first repaired comparison at
  `containment-effect-2026-10-19T08-11-49-418Z/` fails overall: a 15s observer
  aborts legacy arming before its two serial 35s watchdog bounds. Candidate
  caller 7677 terminates with retained refusal and finalized receipt. The
  observer follows those call bounds; hook deadlines do not change. The failed
  attempt remains retained. Both final boundary commands exit 0:
  `qualify-native-containment.js . escaped-latch` at
  `containment-effect-2026-10-19T08-16-46-493Z/` produces 74,361 bytes; caller
  73702 exits via SIGTERM, sibling 708→1216.
  `qualify-native-containment.js . large-latch` at
  `containment-effect-2026-10-19T08-17-24-264Z/` produces 72,313 bytes; caller
  97668 exits via SIGTERM, sibling 776→1164. Both retain block stdout,
  correlated signal receipts, adapter finish and no forbidden-action marker. All
  recorded runtime-module hashes match the inspected built files. The final six
  focused suites pass 121 checks; strict runtime/store/shell TypeScript, scoped
  lint and all-target strict Clippy exit 0. This closes the demonstrated size
  gap on this host, not complete containment, installed behavior or
  multi-project parity.
- E56: A clean `npm run build` followed by
  `node ../caws-native/target/qualification-tools/qualify-native-containment.js . large-latch`
  from `packages/caws-cli` exits 0 at committed source
  `e01a1b00bbc55902bf0744d878f29f173fb86537`.
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T08-40-58-519Z/manifest.json`
  names that revision rather than the earlier dirty-source baseline. Candidate
  caller 196 exits via parent-observed SIGTERM, retains the block and correlated
  receipt with adapter finish; sibling activity advances 1120→1564 bytes and the
  forbidden-action marker is absent. Recorded root runtime-module hashes match
  the inspected build; this is not a recursive dependency-closure hash. Direct
  committed-candidate doctor and five policy gates exit 0 (0E/3W/4I inherited
  doctor findings). A separate attempt to save their output with relative Bash
  tee paths is refused by the active write-target hook; no log file is produced
  by that command. The owned relative path is admitted by `caws scope show`;
  direct CLI checks complete without that filesystem write. The scope decision
  and refusal are distinct observations, not permission to disable the guard.
  The broader telemetry test type error and all unearned acceptance obligations
  remain open. This slice is committed, not installed or landed on main.
- E57:
  `npm run qualify:native:services -- /Users/darianrosebrook/Desktop/Projects/sterling /usr/bin/python3 /usr/bin/jq`
  from `packages/caws-cli` exits 1 after successful CLI/native builds and strict
  runner compilation. The retained scenario is
  `packages/caws-native/target/qualification/service-lifetime-2026-10-19T09-11-01-787Z/`.
  Its isolated homes select only a copied Sterling session-log override; custody
  records match all 28 copied source files. Neither real Sterling service state
  nor installed machine selection is used. Both frontends use generated runtime
  `3693319d…f70551`, not the installed generation. Legacy requests exit 0,
  render users 1–2 then 1–3, and retain precise daemon instance 68466 across
  requests. Its lease advances served 0→1; the second request executes no
  one-shot renderer. The daemon log records listening and idle exit; final
  observation is ESRCH and the private lease is absent. Native requests also
  exit 0 and render those users, but witnesses 1158/group 97053 and 8359/group
  3273 are absent after request completion. Neither publishes a live lease, the
  daemon log is empty, and both requests execute the inline renderer. Their
  input-bound journals record compatibility dispatch, native handoff and adapter
  finish. This demonstrates failed service reuse despite successful rendering;
  no daemon wait status independently identifies its terminating signal.
  Request-group cleanup is the source-supported cause, not an externally
  observed signal receipt. `build-identities.json` records revision `36a110cc`
  plus working probe source and emitted hashes. Independent readback matches the
  recorded native, engine, interpreter/executable and recursive dist-module
  hashes and copied sources. It does not establish a recursive dependency
  closure or a committed final qualifier snapshot. The initial runner preflight
  exits 2 on an invalid line-broken TypeScript assertion before execution; the
  corrected runner compiles. Subsequent strict runner compilation, scoped
  ESLint, Rust formatting and all-target strict Clippy exit 0. Final formatting
  changes probe bytes; retained runtime artifacts remain the evidence for this
  run. Cleanup observes only witnessed instances; all are absent and both leases
  are absent. It does not prove reclamation of every descendant or a wedged
  orphan. Unavailable/unwitnessed startup stops the probe rather than passing an
  empty set. No daemon PID/group is signaled by this runner. The private daemon
  uses a configured 60s idle window, with 68s observation; this keeps a fresh
  lease outside the foreign PID-only reaper threshold during a bounded 35s hook
  call. Concurrent starters, cancellation, generation retirement, all-harness
  behavior and service lifetime repair remain unqualified. Render completeness
  checks only user strings; retained tool/assistant/timeline projections are not
  semantic assertions. A read-only control removes the first legacy turn's
  timeline entries while its user check remains true. Broader rendering parity
  needs assertions over those retained fields. Service survival also needs a
  removed-ordinary-request-child control before it can justify an ownership
  change; a blanket cleanup exemption could pass reuse while leaking request
  descendants.
- E58: The same service qualification command exits 1 from clean committed
  revision `310371d0a091f5bb74f43cad765fcb8447d180fb`, retaining the same four
  native service-reuse failures at
  `packages/caws-native/target/qualification/service-lifetime-2026-10-19T09-45-47-273Z/`.
  All four hook calls exit 0 and retain the expected two then three user
  strings. Legacy daemon 48005/start `1792403153.669989` survives both requests;
  served advances 0→1 and the second inline-renderer execution list is empty.
  Native witnesses 77406/group 74268 and 82553/group 79646 are absent after
  completion; neither has a live lease, and each request executes an inline
  renderer. Final cleanup observes all witnessed instances absent and both
  private leases absent. No daemon wait status supplies its terminating signal.
  Readback compares `build-identities.json` with SHA256 of the committed probe,
  Rust observer source, emitted runner, native binary, observer binary and typed
  engine entry; all six match. This closes the final formatted-probe identity
  gap for this replay, not dependency closure or broader runtime acceptance. The
  probe's semantic-rendering nonclaim is present in its retained manifest.
  Service ownership, surviving-service/removed-request-child behavior, startup
  races, cancellation, source retirement, native workload and installation
  remain open; this is a reproduced defect, not its repair.
- E59: Read-only branch review at clean `0ea4a4ad`, against merge base
  `a9834f93`, finds a configured utility-policy bypass at
  `src/runtime/stock-handlers.ts`: the typed bridge uses checkout root while the
  Python helper resolves `HOOK_CWD` from the hook payload. The retained
  `/tmp/caws-review-0ea4a4ad-utility-cwd.json` records absolute/relative nested
  cwd cases returning typed 0/empty versus Python 2/block, absent/empty
  controls, unchanged sentinel content and no Git index creation. Fresh CLI
  build and 18 focused Jest suites pass 747 checks; Cargo library/binary units
  pass 29/13. Those checks miss the cross-directory consumer mismatch. Eight
  targeted selected-handler controls cover nested ignore/refusal, root-only
  ignore/allow, absent/empty fallback and filesystem symlink-before-parent
  traversal. Before the repair, the first six controls produce four failures and
  two passes; `/tmp/caws-utility-cwd-red.json` retains the incorrect allow/block
  values. This is evidence of test sensitivity, not complete utility parity.
- E60: R33 source investigation confirms that startup interception alone is
  insufficient. Sterling's `session-log.sh:90` directly sources its client;
  `lib/session-log-daemon-client.sh:107-108` launches the daemon through literal
  `python3`, but `:84-95` sends render requests through `/dev/tcp` and permits
  inline fallback after an unrecognized/timed-out response. The daemon writes
  through `render_session` at `session_log_daemon.py:288-296` before responding
  at `:311`; its wire carries no request ID or outcome lookup. This is inspected
  source, not a new runtime scenario. A typed policy declaration and
  source-bound native startup owner must reach the actual selected client and
  correlate admission/fallback outcomes. R33 remains open until that integration
  exists; a service-host library or relay alone cannot close it. Normal request
  cleanup, unknown partial effects and independently surviving host-crash
  cleanup remain separate obligations.
- E61:
  `node /tmp/caws-native-utility-cwd-probe.cjs /Users/darianrosebrook/Desktop/Projects/caws/.caws/worktrees/native-runtime-modernization`
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
  input SHA256 `7c88c014…b39f` matches every stage's input custody, and its
  index remains `d5838795…9a6f`. Independent jq readback requires exact block
  decisions and reason, empty allow stdout and unchanged target hashes in every
  case. `manifest.json` records base `0ea4a4ad` plus the uncommitted diff SHA256
  `cb52fdd9…3a66`, retained as `source.diff`; this is not a clean-commit replay.
  The recorded stock-handler JS SHA256 `b6bd34c7…624f` matches the inspected
  build. Recursive runtime-module hashes, selected source hashes, raw channels,
  commands/status, journals and copied review/red/green receipts are retained;
  no dependency-closure or OS subprocess trace is claimed. The final focused
  suites pass 107 checks, including an unresolvable-cwd shell-fallback control;
  a subsequent configured-policy refinement of that fallback control passes its
  one selected recheck (31 unrelated cases unselected), retained in
  `/tmp/caws-utility-cwd-fallback-final.json`. Scoped ESLint and strict runtime
  test TypeScript exit 0. Doctor reports the inherited 0E/3W/4I and five policy
  gates pass over branch plus staged changes. Two runner-creation attempts are
  refused before execution: an external tool symlink and then a foreign-path
  literal in unrelated historical prose. The successful runner uses the fixed
  system PATH and omits that prose; it does not create tool aliases or weaken a
  guard. A later read-only summary is refused for unsupported nesting. Attempts
  to copy the runner into the artifact tree are also refused (relative
  claimed-path coordinate, then the worktree-copy guard); no copied runner is
  produced. Its original `/tmp` file remains with recorded SHA256
  `76207214…78d4b`, a retention gap to resolve before scratch cleanup. No
  installed runtime, whole-runtime parity or acceptance is earned.
- E62: At source revision `f9426272`, run
  `node packages/caws-native/target/qualification/code-review-f942-substitution/probe.cjs`
  from the lane root, exit 0. The retained `probe.cjs` and `probe.json` compare
  the immutable selected Python classifier with the built TypeScript classifier
  and direct stock consumer. Input `git init; echo "$(kubectl delete pod demo)"`
  yields baseline `ask/capability/confirm`, candidate
  `ask/legacy_family/advisory`, and two stock-consumer calls with exit 0, empty
  stdout and a nonblocking git-init advisory. Reversing the segments preserves
  confirm and returns selected-shell fallback; the root-delete substitution
  control preserves deny/block and selected-shell fallback. The proposed shell
  commands are classifier input only. Source at `classifier/index.ts:174-179`
  processes substitutions after earlier segments; its equal-decision tie at
  `:98` discards their stronger enforcement. The baseline handler's capability
  branch writes a first warning and arms/refuses after an existing warning;
  these actual shell state transitions and native harness withholding were not
  executed by this probe. The initial inline probe was refused as opaque; the
  installed guard explicitly directed the inspectable script-file form used
  here. Fresh build plus sixteen runtime Jest suites exit 0, 603 checks, with
  raw results at `/tmp/caws-code-review-f942-runtime.json`; they miss this
  regression. Serial Cargo exits 101: 29 library, 13 binary and 23 executable
  checks pass; the backpressure case fails before proposal acceptance. Its
  retained
  `/var/folders/2y/lzlll42d12g1gz6l_chkd9500000gn/T/caws-native-39169-127/`
  contains only a 192-byte infrastructure-block stdout, deadline stderr and a
  dispatch event. The exact focused rerun exits 0 and retains 65,536 `x` stdout
  bytes plus handoff `success:false` under
  `/tmp/caws-code-review-f942-backpressure/caws-native-22901-2/`. The original
  timeout cause is unverified; phase timing is required to attribute it. Neither
  a passing rerun nor these classifier observations earn acceptance or cutover.

- E63: The substitution repair receives bounded implementation patches from
  GPT-6.1 Sol workers; the root inspects and applies them under the original
  owned lane. Child CLI claims admit their scopes, but their first source writes
  are refused by the effective worktree hook as foreign. No takeover, identity
  override or alternate write retry occurs. The parent accepts their
  obligations; child specs `CAWS-NATIVE-SUBSTITUTION-PRECEDENCE-001`,
  `CAWS-NATIVE-SUBSTITUTION-QUALIFICATION-001` and `CAWS-NATIVE-FRAME-SCAN-001`
  close as superseded by the original spec, with events 9134/9135/9138 and
  worktree destruction 9136/9137/9139. Canonical tracked status is clean after
  their concurrent audit writes. No child AC pass is claimed. The typed
  classifier computes each statement's proof once, evaluates executing
  substitutions first, then applies ordinary findings. This preserves the
  selected Python precedence without undoing cwd/Git uncertainty checks.
  Ordinary first-equal findings and Python fallback remain unchanged; inherited
  masking across ordinary direct/nested-shell segments is not repaired by this
  slice. Before repair, focused consumer tests fail twice and pass the inverse
  control (`/tmp/caws-substitution-consumer-red.json`); classifier controls fail
  five and pass five (`/tmp/caws-substitution-classifier-red.json`). CLI build
  plus the complete classifier/stock-handler suites then exit 0 with 173 checks,
  retained in `/tmp/caws-substitution-green.json`. The selected real shell
  writes the first capability warning, emits a protective block and matching
  latch on repetition, and preserves a fresh ordinary sibling session. These are
  executor observations, not native-client or actual-harness withholding. The
  typed opt-in runner `scripts/qualify-native-substitution.ts` retains private
  input, commands, channels, state, journals, hashes and hostile oracle
  controls; its native replay is exercised in E65. Inert text and the three
  first-warning forms precede any latch, so another session's sentinel cannot
  force fallback and mask their typed admission behavior. Strict runner
  compilation and scoped ESLint exit 0.

- E64: The native frame reader retains a delimiter-search cursor instead of
  searching its previously checked prefix again. Instrumenting the original scan
  and polling twice without new input fails the new complexity assertion: two
  byte comparisons versus one expected, Cargo exit 101. The cursor repair passes
  eight focused runner tests, exit 0, including real pipe framing, opaque bytes,
  queued-frame tails, empty/unfinished frames, the existing byte boundary and
  deadline refusal. Its concrete output is
  `scan evidence: received=24, examined=24`. Strict all-target Clippy exits 0.
  This measures delimiter comparisons, not complete parsing/copy cost or a
  latency improvement. The E62 pre-proposal timeout's cause remains unverified;
  neither this repair nor a passing rerun attributes it. Serial full Cargo on
  clean `6b842b69` exits 0: 29 library, 21 binary and 24 executable checks,
  including cancellation, foreign-process preservation and output backpressure.
  Raw output is retained at
  `packages/caws-native/target/qualification/integration-checks-2026-10-19T11-58-57-433Z/cargo.log`.
  E65 changes only the qualification runner after that Rust check.

- E65: From clean `8e9fcc079e07309ac6bf5eb91ab62c056bf9a7aa`, package command
  `npm run qualify:native:substitution -- <CLI> <native> <Node> /usr/bin/python3 /usr/bin/jq <new-artifacts>`
  exits 0; the exact six absolute arguments and build output are retained in
  `packages/caws-native/target/qualification/substitution-native-2026-10-19T12-09-23-816Z.log`.
  Its sibling artifact directory retains `manifest.json` with that revision,
  empty `sourceStatus`, selected runtime digest
  `3693319d0858383518063676ad3b91adb31da0437b687009d3236e3f25f70551`, ten
  observations and no reported problems. Literal single-quoted input remains
  advisory twice with no warning/latch. Dollar substitution, backticks and the
  inverse segment order each produce a first warning with exit 0/no latch and a
  repeated-risk block with native exit 2/matching command, reason and
  generation. `regression-first/stderr.bin` contains
  `WARN, first capability ask — not blocked`; its `warn.json` names
  `command substitution: destructive operation (K8S_DELETE)`.
  `regression-repeat/stdout.bin` contains `decision: block`, and its
  `latch.json` retains generation `9386ca1d1d4e2df23323e3baa0a8f203`. The
  ordinary sibling has empty output and no session warning/latch; the fresh
  session receives its own warning without borrowing a latch. State snapshots
  preserve existing files. Per-case journals pin original-input SHA, selected
  handler path/SHA and session, completed execution, local stdout handoff and
  adapter finish. These are local delivery observations, not actual-harness
  withholding. Private V8 files and `typed-execution.json` observe
  `classifyCommand: 1` and `tryExecuteStockHandler: 1` in all three pre-latch
  first-warning cases and both literal controls. Exact module URLs, source
  ranges and recomputed compiled module hashes bind these witnesses; the
  classifier module SHA is
  `d3e046dd12c7c69c444b130f21c3436a8596c8b3ee8e8909c982511dea1d1bf4`.
  Fresh-session classification count is 0 because existing foreign sentinels
  select shell fallback; this control establishes state isolation, not fresh
  typed admission. Six corruptions of state/output/finalization and two omitted
  execution witnesses are rejected in the retained oracle-control files.
  Before/after source, build, immutable-runtime and executable hash assertions
  pass. Hash identity does not prove build derivation, and observing a function
  call alone does not prove its result governs output; E63's failing-before and
  repaired consumer controls provide separate sensitivity evidence. The complete
  runtime Jest directory exits 0 with 616 checks in sixteen suites;
  `runtime-jest.json` and `runtime-jest.log` in this directory retain the raw
  result. `tsc -p tsconfig.vnext.test.json --pretty false` exits 0. These checks
  exercise typed module contracts, not installed native harness execution.
  Killing is disabled and Python remains selected for stateful confirmation.
  This replay does not establish PID termination, exclusive process ownership,
  complete guard/harness parity, thirteen-session workload, installation or
  retirement. EOF does not establish descendant cleanup. R32/R33 remain open.

- E66: Source review at `7447c68e` traces an ambient
  `CAWS_NATIVE_CONTAINMENT_FILE` through the legacy Python and shared
  dispatchers into `block-dangerous.sh`. The guard writes an intent and returns
  before SIGTERM despite the absence of a native receiver. The E51 direct
  producer fixture already observes that no-owner behavior; this does not
  establish an untrusted live-harness environment exploit. Root-applied GPT-6.1
  Sol patches replace that ambient delegation with an exact private argument and
  inherited regular descriptor 3, opened from the typed executor's existing
  owned receipt capability. Only eligible direct stock calls receive the
  argument/descriptor; parent descriptors close after spawn and on setup
  failure. The shared guard ignores ambient filenames on every entry route.
  Missing, closed, read-only or unsuccessfully written channels retain verified
  legacy SIGTERM instead of silently deferring. This descriptor transports a
  receipt, not signal authority. Native intent, latch and process-instance
  verification remain required. Before repair, four focused Bats controls exit
  1: ambient/closed/read-only cases reach `complete.json` without SIGTERM; the
  explicit-descriptor case instead receives signal 15. Raw receipts are retained
  in
  `packages/caws-native/target/qualification/containment-fd-red-2026-10-19T12-39-25-544Z/`.
  The first repaired run exits 0 for five controls. Its sibling
  `containment-fd-green-2026-10-19T12-42-11-811Z/` retains actual signal-15
  receipts for owned PIDs 89049/89901/90864 and a completed, unsignaled
  explicit-descriptor producer 91917 with matching intent/latch. The
  suppressed-signal mutation is rejected despite successful escalation stamps.
  Controls for a writable descriptor without the argument and an extra argument
  extend this boundary. CLI build, strict runtime TypeScript and scoped ESLint
  exit 0. The complete focused run exits 0 for seven Bats controls and 82 checks
  in four runtime Jest suites; `bats-complete.log`, `final/` receipts and
  `runtime-jest.json` in the green directory retain those results. E67 supplies
  clean committed native effect replay; producer receipts alone do not establish
  the native terminal owner or all legacy dispatcher selection. R32 remains open
  for its broader identity/process-domain and reset/rearm obligations.

- E67: On clean `bd31d19db2838f5db242da76186dfb9a51ecfeae`, package command
  `npm run qualify:native:containment` exits 0. Its exact build, strict runner
  compile and all 26 legacy/native observations are retained at
  `packages/caws-native/target/qualification/containment-fd-green-2026-10-19T12-42-11-811Z/native-effect-replay.log`.
  The runner's self-identified artifact directory is
  `packages/caws-native/target/qualification/containment-effect-2026-10-19T12-56-31-101Z/`.
  Its manifest pins that revision, selected guard SHA
  `06a7b16227f9c82bd99067e1c295eb9fde7895d6e2fed1f74ede85aa439b5c4c` and runtime
  digest `9a07585a776c8d8f5f4ae195737fadf2a137b1e5229859fb2327b01a1e3e9b26`.
  Enabled, large-latch and escaped-latch cases in both modes terminate the
  dedicated caller via SIGTERM; the ten disabled/identity controls retain their
  specified refusal/held outcomes. Every case records no forbidden action,
  advancing sibling heartbeats and no audit errors. Nine corruptions of
  audit/strike/target observations are rejected. In `candidate-native/enabled`,
  `caller-wait-status.json` independently reports SIGTERM for observed PID
  88251; `probe/stdout.bin` contains `decision: block`. The raw invocation
  journal pins the selected guard SHA, completes the handler, proposes dispatch
  exit 2, retains `containment_settled` with `native_output_accepted: true` and
  a matching `signal-accepted` receipt for PID 88251/generation
  `a9c29ff4ac327511a1cd6dca48716023`, then records stdout handoff and adapter
  finish with exit 2. Native settlement truthfully says
  `process_exit_observed: false`; external caller wait supplies the separate
  termination observation. The latch remains unchanged, no legacy escalation
  stamp is written, the forbidden marker is absent, sibling heartbeat bytes
  advance 264→472, and the sibling's own wait status is 0. These artifacts
  establish this selected disposable caller's native receipt/refusal/effect
  chain, not merely an intent or stamp. Parent descriptor cleanup is supported
  by source inspection; no injected close/spawn-failure descriptor census is
  performed. Fixture callers are exclusive test-owned processes; actual harness
  ingress, exclusive logical session ownership on a shared backend, reset/rearm
  races and external cleanup after caller death remain unverified. Both modes
  use the generated template snapshot, not the installed release. No resident
  service, thirteen-session workload, installation, Python retirement or full
  R32 acceptance follows.

- E68: Component `CAWS-NATIVE-FOUNDATION-001` imports the unchanged 81 source
  paths from `8c1adc8a` into clean integration
  `aafa1920378c20273ed8061251a67a7f049cab5e`. Its ordinary merge retains current
  main's governance. Fresh checks are retained under
  `packages/caws-native/target/qualification/foundation-integration-2026-10-19T13-32-19-882Z/`:
  `manifest.json` records CLI build, strict runtime typing, 175 shared
  policy/Git/context checks, two selected normal Python-launcher checks (20
  unselected), 616 runtime checks in 16 suites, Rust format, strict all-target
  Clippy and serial Cargo (29 library, 21 binary, 24 executable checks), all
  exit 0. The included `substitution-replay-command.json`, log and
  `substitution-replay/` retain ten current-guard native cases, actual typed
  classifier coverage, warning/latch state and hostile evidence controls.
  `source-and-state.json` records all imported source hashes, source comparison
  exit 0, unchanged actual `src/index.js`/installer/registration/store barrel,
  retained parent artifacts and installed pointer `408c06a7…77baa0`. Independent
  integration review identifies a mistaken receipt coordinate (`src/index.ts`);
  the corrected receipt checks existing `src/index.js` and exits 0. No
  integration-induced default-selection defect is established. E66/E67 supply
  the matching shared-guard descriptor and actual signal evidence; their
  complete source bytes remain identical in this integration. Component A1–A3
  are recorded through the single writer and read back with `ac_recorded` events
  9205–9207. The writer checks commit reachability; ignored raw runtime
  artifacts are inspected by the verifier, not mechanically rederived. An
  initial absolute artifact citation is refused before any write; generated
  evidence remains uncommitted. The governed merge exits 0 at
  `6da6548c9842549b6bd8b5307defb52c2ea083c2`, closes only the component and
  removes its lane. The original lane fast-forwards to main, retaining the
  active `CAWS-NATIVE-RUNTIME-001`, all eight acceptance obligations and ignored
  qualification artifacts. Native remains explicitly invoked; normal bootstrap
  stays Python. Source landing does not establish R32/R33 repair, resident
  operation, thirteen sessions across four projects, installed/harness parity,
  Python retirement or performance. No machine installation occurs.

- E69: Candidate based on `cbfecec555d4fa980a6a8aff6bd6ade50b958738` adds a
  disposable caller with an independently surviving native-child owner, an
  engine/pipe-holder stall after handoff, complete refusal-byte assertions, and
  bounded typed ancestor-capture diagnostics. Guard eligibility and the existing
  fail-closed capture policy are unchanged. Evidence lives under
  `packages/caws-native/target/qualification/cleanup-post-effect-2026-10-19T14-21-50-008Z/`.
  The initial retained success observes caller 74356 receiving SIGTERM, native
  74363 reaped with exit 2 and 1,000,033 captured stdout bytes, engine 74452 and
  holder 74483 absent from the selected process snapshot, and sibling heartbeat
  1→69. `initial-success/post-effect-stall/native-owner-wait.json` and
  `post-effect-cleanup-observation.json` retain those observations. The receipt
  uses filesystem/SystemTime for the cross-process handoff interval; production
  deadlines remain monotonic. It observes known members, not universal
  descendant reap, installed execution or the production typed dispatcher.
  `mutation.json` retains suppression of `OwnedGroup::finish`'s group SIGKILL
  and exact source restoration. The mutant exits 101 with a runnable engine;
  failure cleanup subsequently writes an abort marker and cannot earn cleanup
  credit. An immediate restored replay also exits 101 before signaling, with
  insufficient diagnostics to attribute that historical failure. After
  instrumentation, `capture-full-native.log` records serial
  `cargo test --all-targets -- --test-threads=1` exit 0: 29 library, 26 binary
  and 25 executable checks. `capture-clippy.log` records strict all-target
  Clippy exit 0. These green checks do not establish reliability: the subsequent
  retained focused replay in `capture-terminal-retained.log` exits 101. Its
  first two output-loss modes observe SIGTERM;
  `caws-native-1984-0/post-effect-stall/` records `CaptureUnavailable`, lookup
  `DeadlineExpired` at PID 98766/depth 3, recorded PIDs `[5005,4993,1984]`, six
  attempts and 289286µs elapsed against 249999µs budget. `handoff.json` reports
  output success with containment held; `caller-wait-status.json` records caller
  4993 exit 42 with no signal and `forbidden-next-action.marker` records its
  continuation. This establishes the observed expiry above an already captured
  target, not the consuming substage or the earlier failure's cause. It does not
  demonstrate a group-cleanup regression. Per-observation/substage cost and the
  required capture/target policy need investigation before claiming R32
  reliability. No acceptance or installation follows from this slice.

- E70: Typed render request/outcome schemas and the Rust private durable journal
  are component implementations; they do not activate a service. Evidence lives
  under
  `packages/caws-native/target/qualification/service-primitives-2026-10-19/`.
  `cancellation-journal-tests.log` records 26 selected journal cases and
  `cancellation-protocol-tests.log` records 100 typed protocol cases, exit 0.
  CLI build, strict runtime test typing and repaired all-target Clippy exit 0.
  The initial Clippy attempt exits 101 for an unnecessary unit expression and an
  oversized admission enum; the repair boxes accepted operations without
  changing their wire bytes. The journal persists
  queued/running/returned/unknown outcomes before releasing the corresponding
  operation, refuses conflicting duplicates, and retains uncertain work as a
  fence across source generations. Queued source retirement or grant withdrawal
  publishes an explicit cancellation tombstone; it cannot relabel running,
  unknown or returned work. `cross-process-WLGXfH/observation.json` retains
  actual separate processes: `service-journal-observer seed-abort` exits 73
  without Rust Drop; disk contains running/queued records. `recover` exits 0
  after retaining unknown/queued, both generation dispatch attempts are fenced,
  and an exact duplicate returns the old unknown outcome. A fresh
  `returned-child` process exits 0 after reaping its owned child with code 7/no
  signal and storing that observed result. Independent Node reads verify private
  modes, body checksums, exact producer request bytes and typed
  originating-request outcome correlation. The inline heredoc harness is refused
  by the shell recognizer before execution; the retained runner is invoked as a
  plain command and exits 0. This does not simulate a physical power cut,
  interrupt a stalled kernel call, independently validate native request
  authority, dispatch a daemon, or establish production admission/retention
  policy. Capacity is an explicit bounded constructor parameter, not a
  production default. The actual owner must revalidate queued grants before
  dispatch and preserve uncertain outcomes; these source primitives do not
  repair R33 by themselves.

- E71: The opt-in Darwin observer reads the existing C-locale `ps comm`
  representation through native SDK APIs, retaining complete ancestor capture,
  parent/microsecond-birth rechecks, target selection, cancellation and the
  250ms capture cap. Unavailable native reads remain unavailable; they do not
  trigger subprocess retries or authorize a captured prefix. Rust owns parsing
  and formatting; a small C bridge supplies SDK-owned `kinfo_proc` fields
  without copied Rust structure offsets or policy/signal code.
  `target/qualification/native-comm-owned-2026-10-19T17-47-08.369Z/` retains an
  initial exit-1 comparison: actual System `strvis` matches all 283 cases and
  nine live-process cases match, but the qualifier's libproc birth query is
  unavailable for its deliberately unreaped zombie. No zombie text comparison or
  later interpreter proof follows from that attempt. The repair uses
  qualification-only SDK zombie identity, preserves all four fresh parent/birth
  observations and leaves the production metadata bridge unchanged.
  `target/qualification/native-comm-zombie-2026-10-19T17-58-30.663Z/` records
  comparison exit 0: all 283 formatter cases and 14 owned process cases match,
  including custom/empty/oversized argv0, whitespace/control/high bytes, deleted
  executable, zombie, shell, Node title and Python interpreter controls. The
  generated Python body is an external-interpreter representation fixture, not a
  replacement implementation or an exemption for first-party Python. Under
  `target/qualification/service-primitives-2026-10-19/`, `ps-oracle-mutant.log`
  exits 101 when empty-output-as-absence is reintroduced: a still-live child
  15652 is falsely accepted. Exact restoration removes that mutant;
  `ps-oracle-restored.log` records both strict observation checks passing. Only
  exit 1 with exactly empty stdout/stderr establishes absence;
  invalid/failed/omitted observations cannot certify cleanup.
  `legacy-comm-instrumented-terminal.log` records a passing instrumented replay
  before the native route, without explaining E69's earlier failure.
  `native-comm-integrated-tests.log` records full serial Cargo exit 0: 63
  library, 34 binary and 27 executable checks; strict all-target Clippy also
  exits 0 after removing two unnecessary unit expressions in the qualifier.
  `caws-native-47756-133/post-effect-stall/` retains caller 53180 SIGTERM 15,
  native 53182 reaped with code 2, complete 1,000,033-byte output, strictly
  absent engine 53198/holder 53210, sibling heartbeat 1→38 and no continuation
  marker. Its receipt explicitly limits observations to known members and uses
  filesystem/SystemTime for the cross-process handoff interval. This is not
  actual typed-dispatcher requalification, universal descendant reap,
  different-credential/protected-process entitlement equivalence, deadline
  interruption of a stalled kernel, a performance distribution or installed
  behavior. R32 remains open; no full acceptance or installation is inferred.

- E72: A named renderer client reads a positioned grant from FD4, sends one
  canonical correlated request over per-offer duplex FD3 and publishes an FD5
  receipt. Both transport directions require a single frame and write-half EOF.
  Original source paths/hashes remain separate from execution-image routing. The
  shell library uses pinned quoted Node/entry literals; a single replacement
  pass preserves marker-like text inside those literals. Any helper failure
  exits the whole selected shell with 75 instead of returning to Sterling's
  inline fallback. Neither local nonexecution nor an owner rejection grants
  caller-side fallback. After a write attempt, transport loss is a local unknown
  observation, not fabricated durable admission. Source review repairs an
  overrestriction inherited from the proposed daemon wire contract: inspected
  Sterling parse-input, metadata, quoted fallback argv and renderer model
  consumers preserve CR/LF/US. CR is not a legacy delimiter; LF/US need an
  exclusive owner-selected direct backend or explicit unavailable outcome. JSON
  request fields preserve these values; NUL remains unrepresentable in actual
  POSIX argv. The owner must not equate daemon wire suitability with the
  selected handler's accepted input. Branch-control realizability and every
  installed parser/harness are not established by this source inspection. Under
  `target/qualification/service-primitives-2026-10-19/`, `control-build.log`,
  `control-types.log`, `control-eslint.log` and `control-tests.log` record
  build/strict runtime typing/lint and 164 protocol/ client checks, exit 0. The
  earlier final pipeline stops at lint before tests: a cleanup throw in
  `finally` could override the primary result. The repair propagates
  primary/cleanup failures after teardown; the NUL spawn-failure control retains
  that primary error and closed channels. Thirteen retained sequential fixture
  attempts include twelve actual shell/compiled-Node children and one rejected
  NUL spawn. They retain grants, actual request/receipt bytes and `status.json`.
  `client-1Rw7e7/` observes 1,192 request bytes, no reply, local
  may-have-been-delivered/unknown, shell 75 and empty stdout. `client-RaMYSD/`
  receives the fixture response but cannot write its receipt and exits 75
  without inline output. `client-VkU33t/`, `client-2a3Px5/` and `client-6PyIRh/`
  retain exact CR/LF/US model values through Bash argv, compiled Node and actual
  FD3 bytes; JSON framing contains escaped data and one terminal LF. Independent
  artifact reads verify mode 0700/0600, decoded original values, cleanup and the
  absence of fabricated admission on timeout. Every retained status explicitly
  declares fixture ownership and no actual daemon dispatch. The native boundary
  must issue fresh grants, pin the complete effective source closure/image,
  supply correct descriptor rights and a monotonic hard deadline, scrub
  undeclared interpreter preloads and close capabilities in unrelated handlers.
  This component does not provide those operations, start an owner, claim
  authority from hashes/leases, dispatch an actual renderer or establish R33,
  installed selection or thirteen-session operation. No services policy knob is
  activated by these source files.

- E73: `examples/process-comm-ancestor-compare.rs` reads only its own parent
  chain with the production lookup/edge-recheck ordering and 16-depth/
  31-observation limits. It has no arbitrary PID selector and never signals
  ancestors. A separate phase compares the captured set against `/bin/ps`,
  retaining four fresh parent/microsecond-birth snapshots, raw comm bytes, typed
  results and monotonic phase/stage timing. Private artifact IO follows both
  timed phases. The mirror does not invoke private NativeObserver or its
  complete signal/output cancellation behavior.
  `target/qualification/service-primitives-2026-10-19/ancestor-clippy.log`
  retains an initial unused-unit error; after removal,
  `ancestor-repaired-clippy.log`, `ancestor-tests.log` (three qualifier unit
  cases), `ancestor-build.log` and `ancestor-compare.log` all exit 0.
  `target/qualification/native-comm-ancestors-2026-10-19T18-27-41.189Z/receipt.json`
  records native capture 19,592µs under 250,000µs and a separate legacy
  comparison phase of 14,297µs under its qualification-only 3,000,000µs budget.
  All three observations (two distinct ancestor PIDs plus one recheck) reach
  PID1's boundary with matching bytes and stable identity snapshots. Each owned
  comparison helper is reaped with code 0/no signal and no forced cleanup. These
  differently scoped phase times are one sample, not evidence of speedup or a
  cold/warm distribution. They do not establish complete production
  cancellation, protected/different-credential targets, physical kernel
  deadlines, containment effects or exclusive logical-session process ownership.

- E74: `service_protocol.rs` independently decodes the existing typed service
  request/grant/bridge/outcome/receipt wire, checks canonical UTF-8 JSON and
  recomputes request, project and argument identities. The externally produced
  fixture corpus has 64 accepted and 65 rejected cases; Rust's four focused
  checks exit 0 (`service_protocol::tests`). CR/LF/US and non-ASCII values
  remain data. Public hashes do not replace a retained issued grant and full
  expected request: changing the exact-request comparison to unconditional
  success makes the hostile check exit 101
  (`service-primitives-2026-10-19/wire-equality-mutant.log`); the restored
  four-check run exits 0 (`wire-restored-tests.log`). The updated journal
  observer uses native decoding instead of copying fixture identities. Its
  separate-process runner exits 0 and retains
  `service-primitives-2026-10-19/cross-process-BINda3/observation.json`: seed
  exits 73 with running/queued records; recovery exits 0 with unknown/queued and
  both generations fenced; a directly reaped child PID75371 exits 7 and its
  exact result is stored. Checksums, original request bytes and TypeScript
  outcome correlation are inspected independently. No native bridge listener,
  grant issuer, authority revalidation or real renderer is exercised.
- E75: Before repair,
  `cargo run --example service-journal-root-replacement -- <artifact-root>`
  exits 1. Both `journal-root-replacement-red-2026-10-19/` observation files
  show a replacement operational root accepting and dispatching work while its
  unchanged prior running/unknown record is invisible. The historical probe
  patch is retained beside those observations. The public journal API requires
  an `Arc<Custody>` acquired from a dedicated stable private home outside the
  operational tree. An immutable bounded registry pins root and machine-lock
  device/inode; normal acquisition creates nothing. Explicit first
  initialization refuses nonempty/partial state. Journals and issued permits
  retain the lifetime machine-owner lock, shared across project keys. The 36
  journal checks exit 0 (`custody-tests-initial.log`); strict all-target Clippy
  and example builds exit 0 (`custody-wire-clippy.log`,
  `custody-wire-examples-build.log`). The repaired standalone qualifier exits 0:
  `journal-root-custody-2026-10-19/outstanding/observation.json` records a
  separate process PID66219 observing Busy while only the permit retains
  custody, then PID66227 observing UnsafePath after root replacement and permit
  drop. `restart/observation.json` records PID66228 observing UnsafePath for a
  replaced recovered-unknown root after all owners drop. All three observers
  exit 0, without signal, and are directly reaped; neither replacement accepts
  or dispatches, and original record bytes remain unchanged. Stable custody-home
  identity and cooperative preservation of journal subdirectories/records are
  explicit prerequisites. Arbitrary record/subtree deletion, replacement of the
  entire custody home, production handover, retention policy and resident-owner
  integration are not established. The future owner must select one canonical,
  generation-independent custody home and must not initialize on acquire errors.
- E76: `cargo test --all-targets -- --nocapture --test-threads=1` exits 101
  (`service-primitives-2026-10-19/custody-wire-all-tests.log`): 77 library and
  34 binary checks pass; 26 integration checks pass and the terminal-output
  scenario fails at the strict process-state parser. Retained
  `caws-native-45077-133/close-after-prefix/caller-wait-status.json` records
  caller PID46036 actually terminated by signal15 after 424ms, with a separate
  Broken pipe diagnostic. The rejected process-status token/raw query was not
  retained; cleanup for that attempt is unproven. Source review alone
  establishes no missing documented status flag. Instrument the native/engine
  query paths to retain exit status and exact stdout/stderr before assertion; do
  not loosen the parser or attribute the failure without that evidence. Prior
  green containment artifacts and the historical E69 failure remain separate
  observations.
- E77: The terminal fixture's per-PID native/engine observations are retained as
  private bounded JSONL before the existing assertion can fail. Each row
  includes exact stdout/stderr byte arrays, exit code/signal, query errors and
  the strict parsed result/error. The injected unavailable-status, invalid-byte
  and query-execution controls fail their assertions only after writing the
  expected receipt (`ps-retention-tests.log`, one selected check, exit 0).
  Parser grammar, the two-second observation budget and absence classification
  are unchanged. `terminal-ps-retained-replay.log` exits 0 across all three
  output-loss modes. In `caws-native-54305-0/close-after-prefix/`, the native
  and engine JSONL rows independently record exit1 with exact-empty
  stdout/stderr for PIDs54387/54421. The stalled-settlement receipt records
  caller PID54884 terminated by signal15 after 175ms; native PID54886 is
  directly reaped with code2, complete 1,000,033-byte output, and known
  engine/holder PIDs54892/54897 are absent. Sibling heartbeat advances 1→35. Its
  explicit nonclaims include all-descendant reaping and actual typed-dispatcher
  execution. Strict Clippy exits 0 (`ps-retention-clippy.log`); the complete
  subsequent Cargo run exits 0 with 77 library, 34 binary, 28 integration and
  three ancestor-example checks (`ps-retention-all-tests.log`). This replay does
  not identify E76's lost raw token or attribute its failure; future unknown
  formats remain unavailable.
- E78: The macOS Git-capture replay stalls while cleanup retains an exited
  unreaped direct child. `renderer-backend-2026-10-19/git-view-stall-sample.txt`
  retains the stack; the old child/query group is absent on re-entry after the
  user's latch reset. The repair uses the SDK `KERN_PROC_PGRP` layout, brackets
  its complete bounded query with fresh `WNOWAIT` observations of the actual
  retained Child, and permits reap after `EPERM` only for a complete all-zombie
  group with its owned leader. It does not label that refusal signal acceptance.
  `owned-group-tests.log` exits 0 for nine hostile decision checks. The actual
  `renderer-backend-16408-1/reply-after-exit-observation.json` records one
  member, one zombie, one leader, 648 returned bytes below the 2,654,208-byte
  capacity, `groupSignalErrno: 1`, `groupSignalAccepted: false`, direct-child
  reap and both EOF flags true. A different hostile check exposes a second
  defect: `cleanup-sdk-backend-tests.log` exits 101 and
  `renderer-backend-16408-0/cleanup-fault-observation.json` has both EOF flags
  false after custody release. Removing the post-deadline early return retains
  custody through pipe EOF. `cleanup-sdk-backend-replay.log` exits 0 across 12
  backend checks; `renderer-backend-83191-0/cleanup-fault-observation.json`
  records custody busy at reap, zero early reaps, one final reap and both EOF
  flags true before return. `git-view-cleanup-repaired.log` exits 0 across four
  checks; `git-view-81680-0/observation.json` contains identical expected/actual
  modified file status bytes, no helper execution and an explicit fresh-capture
  refusal after `core.fsmonitor` is introduced.
  `git-view-81680-1/linked-observation.json` retains distinct
  original/common/private Git directories. These observations exclude malicious
  same-UID interference, escaped descendants and hard kernel stalls; they do not
  establish an atomic repository snapshot or LFS support.
- E79: `reviewed-image-tests.log` exits 1: seven builder checks stop at
  `incomplete toolchain`, because the validator sorts names while the declared
  table places `bash` before lexical predecessor `basename`. Matching TS/native
  declarations are repaired without relaxing the equality check. The actual
  reviewed 28-file Sterling source profile is copied into private fixtures;
  `typed-render-integration-replay.log` exits 0 across seven suites/209 checks.
  The source-image tests exercise the complete four-entry default Stop chain,
  original handler provenance, unchanged foreign handler bytes, immutable image
  cache identity and an actual shell missing-grant refusal. Typed offer tests
  require explicit private operator policy, independent selection derivation and
  native v2 correlation; wrong image/FD/session context, extra members and
  duplicate JSON members refuse. Engine tests cover matching admission and
  descriptor disposal. The initial combined command names two nonexistent suite
  paths and exits 1 (`typed-render-integration-tests.log`); its two real suites
  pass, and the corrected command above exercises the actual suite names.
  `npm run build` and the focused vNext TypeScript check exit 0
  (`typed-build-replay.log`, `typed-check-replay.log`). The first direct local
  compiler path is absent and exits 127 (`typed-check.log`); the replay resolves
  the installed compiler through Node. No broker success, actual native image
  publication, whole-runtime parity or installed behavior follows from these
  typed/fixture checks. Evidence paths in E78/E79 are relative to
  `packages/caws-native/target/qualification/renderer-backend-2026-10-19/`.
- E80: The actual owner qualifier preserves failed attempts instead of treating
  native exit zero as success. `render-owner-2026-10-19T22-54-28-767Z` fails
  before service creation because tool discovery incorrectly requires nlink=1;
  this machine's `/usr/bin/grep` has six links and `/usr/bin/stat` has two. Tool
  reads retain byte/identity pinning while permitting aliases; private operator
  policy retains the single-link requirement and a focused hostile test. The
  next attempt (`22-56-59-311Z`) correctly refuses CLI initialization nested
  inside a CAWS worktree. The qualifier uses an independent private repository
  and keeps evidence in the owned ignored qualification directory. The
  independent run (`22-58-13-943Z`) and instrumented replay (`23-02-08-111Z`)
  fail native image admission. `owner-observations-final.json` identifies
  `unsupported_profile` / `runtime lacks required image source`: an unused
  duplicate runtime client is required even though execution consumes the
  separately pinned package client. Removing that duplicate requirement retains
  full runtime membership and exact package-client validation. The next debug
  run (`23-05-22-273Z`) creates actual worker41518/backend41524 but expires at
  prepared revalidation before grant; served remains zero. Budgets are
  unchanged. The release qualifier builds an optimized candidate, records
  monotonic owner phases and keeps the same 30s request budget. Its first run
  (`23-12-15-509Z`) serves one render but exposes a qualification-oracle defect:
  native argv contains `--engine`, so substring matching includes the
  qualifier's inherited process group. The correction requires the actual direct
  engine child to lead its own group, and writes observations before assertions.
  Every attempt records confirmed inactive cleanup; no service PID is adopted or
  signalled by the qualifier. These paths are under
  `packages/caws-native/target/qualification/`; raw command logs are under
  E78/E79's `renderer-backend-2026-10-19/` directory.
- E81:
  `node ../caws-native/target/qualification-tools/qualify-render-owner.js . /Users/darianrosebrook/Desktop/Projects/sterling release`
  exits 0 (`owner-scenario-process-oracle-repair.log`). Its actual artifacts
  live in
  `packages/caws-native/target/qualification/render-owner-2026-10-19T23-14-32-633Z/`.
  Three native calls execute the complete four-entry default Stop chain with
  unchanged copied reviewed foreign sources. `request-1..3/result.json` and the
  source/selection/journal snapshots retain original execution coordinates,
  actual lease transitions and semantic user/tool/result/assistant timelines.
  Backend95100 has one kernel birth identity across served1/2/3; its cache full
  count stays one, tail advances 0→1→1, and the third owner outcome is cached.
  Three retained journal operations are returned, with no duplicate dispatch.
  Request groups95008/96854/97447 contain zero live members after their native
  calls; the final observation has 99 witnessed request processes absent or
  replaced. Sampling does not establish custody of every transient descendant.
  `foreign-byte-baseline/result.json` retains a separate unchanged renderer run
  using the final durable argv except output directory: both turn files are
  exactly 1764 bytes and byte-identical. Their respective SHA256 values are
  `cd8f74b718054550235fef386f8ffef263e08c09a1b2cc717ce22b52fa4d5e9c` and
  `5e8ee3b7d70a51e745906350668c45107ef7b518b54d1cd7f138597b1378ef0a`.
  `owner-observations-final.jsonl` records actual backend reap, both pipe EOFs,
  12ms cleanup without deadline excess, worker95099 exit0 and host95021 idle
  exit. The final custody observer acquires/releases the actual anchored lock;
  the socket and worker namespaces are absent. This is a successful isolated
  compatibility slice, not deployed Sterling parity, first-party Python
  retirement, thirteen-session/four-project behavior, fault recovery or a speed
  distribution. Effective executable Git helpers including LFS remain refused;
  the Git worktree/object database remain live data. The final integrated replay
  must exercise the subsequent strict owner EOF check and retained cancellation
  repairs before presenting the committed candidate; E82 retains that replay.
- E82: Candidate `605d11bf21fb52db35af36d1e2a6af176e118cb8` connects the actual
  owner route and retains the complete migration obligations. The owner waits
  for exactly one bridge LF frame plus EOF before decode/journal/dispatch;
  delayed surplus and missing EOF refuse under the original deadline. Expiry
  after queued admission retains a queued-only cancellation using an independent
  bounded record attempt; uncertain publication quarantines that actor rather
  than dispatching a stale ID or falsely labelling known nonexecution unknown.
  `final-native-boxed-tests.log` exits 0 with 130 library, 40 binary, 28
  executable integration and three ancestor-example checks. The new
  queue/framing controls use actual journal reopen and sockets; this does not
  establish live host crash recovery or cancellation during an actual render.
  The seven typed suites exit 0 with 210 checks (`final-typed-tests.log`).
  Focused vNext typechecking, CLI build and scoped ESLint exit 0
  (`final-vnext-typecheck.log`, `final-typed-build.log`,
  `final-scoped-lint-replay.log`). The first lint/Clippy attempts are retained:
  missing test-global declaration, collapsible branches and oversized
  command/offer variants. Explicit heap indirection preserves the wire, and
  strict Clippy exits 0 without lowering its floor (`final-clippy-boxed.log`).
  CAWS gates and doctor exit 0 (`renderer-gates.log`, `renderer-doctor.log`);
  doctor retains three unrelated warnings. Git's lint-staged hook emits an
  ignored-directory warning for the already tracked internal tracker, but commit
  and standalone checks succeed; the committed checkout is clean. The committed
  command
  `npm run qualify:native:render-owner -- /Users/darianrosebrook/Desktop/Projects/sterling`
  exits 0 (`committed-owner-scenario.log`). Its
  source/manifest/arguments/outputs/state live in
  `packages/caws-native/target/qualification/render-owner-2026-10-19T23-25-40-047Z/`.
  The executable SHA256 is
  `c404cd37110a6a27c82082ad0de96125741bc03fece249863a33b44134475088`; the
  manifest also hashes the observer, custody observer, engine entry, CLI entry
  and qualifier source. Actual backend55714 has birth1792452345.250838 across
  all three requests: served1/2/3, full parse1, tail0→1→1 and the final cached
  response. All four original handler coordinates complete with exit0, and each
  actual registered lease transitions active→stopped. The final witness covers
  101 request processes and groups55191/59033/60336 with no live members after
  return. Sampling can miss transient/escaped descendants. Both final 1764-byte
  turn files byte-match the independent unchanged renderer: SHA256
  `4f6d70e9e450bdc5114bba45946f61c0f2f999c0c2a01a5c3933f97727fb5900` and
  `c7c854b1714c23733354038222ff779c84f4f5b940f7a86d356c206fc798dcd9`. Actual
  backend cleanup takes 12ms, reaps the child and observes both EOFs before
  releasing custody; worker55712 exits0 and host55204 idles out. The private
  socket/workers are absent and anchored custody is independently acquired/free.
  These facts support this opt-in isolated profile. Successful entry execution
  does not qualify the active-goal refusal branch, missing-session/PID/reset
  safety parity, legacy writer exclusion, source mutation while rendering,
  unknown outcomes after transport loss, crash recovery, production retention,
  thirteen sessions/four repositories or installed package selection. The
  baseline shares the reviewed foreign parser, so identical bytes can preserve
  an inherited parser defect; semantic timeline assertions cover only the
  retained two-turn transcript. No installation or parent A1–A8 acceptance is
  inferred. Log paths above without the scenario prefix refer to
  `packages/caws-native/target/qualification/renderer-backend-2026-10-19/`.
  Committed-candidate independent inspection is complete; relied-on source and
  runtime observations were checked directly. This records review progress, not
  an acceptance verdict. `committed-offer-tests.log` additionally replays the
  final test-global binding on candidate605d11bf and exits 0 across 49 checks.

- E83: The next owned dirty slice starts at `5d72cfe8` with the existing
  `CAWS-NATIVE-RUNTIME-001` binding and three explicitly selected GPT-6.1 Sol
  implementation workers. The actual unchanged cold/warm qualifier exits 0
  against the first integrated release build: artifact
  `target/qualification/render-owner-2026-10-20T00-43-16-195Z/manifest.json`
  records `verified_slice`, no failures/gaps, backend18718 served1/2/3 and
  confirmed inactive cleanup. This is an independently retained control, not
  cancellation, adoption or load qualification. The first actual lifecycle
  normal control fails despite native exit0:
  `render-lifecycle-normal-2026-10-20T00-40-57-619Z/scenario.json` records no
  worker/output, `git_capture` refusal and independently confirmed inactive
  cleanup. No subsequent scenario runs. A later direct capture probe succeeds;
  it does not attribute the original failure. The source investigation finds an
  independent reproducible race: query pipe EOF triggers unconditional group
  SIGKILL before observing child exit. A real helper closes its pipes, delays
  and exits0; the original query instead reports signal9 and exits101
  (`render-lifecycle-source-2026-10-19/git-query-pipe-eof-red.log`). The
  repaired query waits for WNOWAIT exit under the original deadline before
  cleanup; six selected Git checks including exit7/deadline controls and strict
  Clippy exit0 in the adjacent green/Clippy logs. Actual hostile replay remains
  a separate obligation. Early independent read-only inspection also identifies
  a known-no-child spawn failure being recorded as permanent unknown. The
  internal writer result is being extended to distinguish positively established
  nonexecution; no process exit may be fabricated and post-spawn/transport loss
  remains uncertain. Project writer custody is being moved outside disposable
  session history with a durable provisioning identity; source generation,
  machine home, absent leases and cache recreation cannot authorize a second
  writer domain. E84 retains the subsequent actual legacy workload; the
  thirteen-session/four-repository workload remains unqualified. The proposed
  mixed-harness guard load exercises the compatibility chains; it does not
  establish typed guard/PID parity or remove Python fan-out.

- E84: The cooperative writer qualifier exits0 against native SHA256
  `4a537674d19cd30c66ee90730c8160a45d616b822be25b63af9dd304fcffb4a1`.
  `target/qualification/render-legacy-2026-10-20T01-22-41-463Z/manifest.json`
  retains the actual unchanged one-shot writer under held custody, an actual
  daemon reply `ok 1 15` suppressed after writing, and the actual client's
  `actual-inline-fallback`. These are counterexamples to unchanged legacy
  exclusion. Cooperative contenders across homes/generations refuse75; missing
  registered custody refuses without creating a replacement, and session-cache
  replacement preserves exclusion and the original lock inode751591069. The
  linked `render-legacy-managed-owner-2026-10-20T01-22-49-848Z/race-result.json`
  observes live native worker2134/backend2156, installed helper refusal75 and
  identical before/after artifact digest
  `9bfc8d63d195c0a8ecbc94aa919839f52cadb01ab7b9d9b2f7b73041e1089aa0`. Its
  cleanup observes host99365/worker/backend absent, custody free and no
  socket/workers; a later actual cooperative render exits0. All-writer Sterling
  source adoption and positively established prior-writer drain remain external
  dependencies. No machine installation or unchanged-writer exclusion is
  claimed. The durable project anchor is outside disposable sessions; a
  provisioning tombstone binds its device/inode. Its journal fails closed at256
  retained lifetimes; unbounded deployment and maintenance are not established.
  Typed `not_started` records distinguish observed no-child spawn failure from
  post-spawn uncertainty. Complete native checks at this binary's source exit0
  (150 library,40 binary,28 integration,3 ancestor-example checks), retained in
  `renderer-hostile-2026-10-19/native-all-tests.log`; they do not qualify live
  cancellation or restart.

- E85: The second normal lifecycle attempt reaches worker39024/backend39025,
  then expires before render dispatch. Native exit2 and confirmed inactive
  cleanup are retained in
  `render-lifecycle-normal-2026-10-20T01-19-16-729Z/scenario.json`. Owner
  Prepared occurs at14802ms; source admission/pre-spawn/prepared checks
  consume5167/2816/2852ms. The handler execution journal records successful
  goal/plan handlers and an incomplete selected session-log handler; no evidence
  attributes the failure to missing leases. The separate E84 managed request
  succeeds without an explicit lease in25845ms, limiting that hypothesis. Source
  inspection finds consecutive full bridge validation with no intervening work,
  and complete rereading of the110712624-byte Node executable per pass. The
  candidate removes only the duplicate bridge pass and enables sha2's ARM
  hardware backend with its software fallback; complete source/tool hashing and
  owner spawn/queue/dispatch revalidation remain. Live latency improvement and
  hostile behavior require replay under the original30000ms request budget. A
  separate focused shell replay has13 passes and one cold recorder timeout
  (status null at3000ms), retained in
  `renderer-hostile-2026-10-19/final-runtime-jest.log`; the earlier14-pass run
  is not an explanation for that timeout. The load oracle also rejects reversed
  served counters against durable journal sequence, rather than sorting away the
  ordering relationship. Strict compile and its hostile self-test exit0 in
  `render-load-source-2026-10-19/sequence-order-*`; no actual load follows from
  those source checks.

- E86: The ARM candidate reaches Prepared at4096ms and returns actual rendering
  at12370ms in
  `render-lifecycle-normal-2026-10-20T01-46-51-700Z/owner-observations-final.jsonl`.
  That attempt fails a premature oracle: `worker_cleanup` precedes worker wait
  and Actor intent settlement. The final durable intent is returned, and cleanup
  is confirmed inactive. The corrected oracle uses one absolute retirement
  observation deadline for cleanup, durable Returned and independent
  worker/backend absence; the peer wait observes its retained Child's
  original30000ms request bound plus the existing caller-cleanup grace. It does
  not extend execution. The replay
  `render-lifecycle-normal-2026-10-20T01-52-05-393Z/scenario.json` exits0:
  actual `turn-001.json` is1793 bytes, SHA256
  `692aa424ab5a78e60ddbd6bdbff1d6096e6ef8abc52eb733226f93a69c4692ae`;
  first-project intent settles, worker80231/backend80248 are absent, and
  `LEGACY-KNOWN-IDLE-CONTROL` is created while peer activity retains host77642.
  Final host/worker/backend observations are absent, custody is free and socket/
  workers are absent. This is a sample, not a latency distribution or
  attribution of improvement to one of the two candidate changes independently.
  `render-lifecycle-queued-cancel-2026-10-20T01-54-40-784Z/scenario.json`
  exits0: invocation22991 is ActorQueued behind22100, then cancelled; the first
  render returns normally, the cancelled caller has no dispatch/output, and no
  unknown fence masks the negative result. Host22099/worker22799/backend22800
  are absent with free custody and no socket/workers. These runs retain
  executable and compiled driver hashes; final formatted-candidate identity is
  reconciled before relying on them for stronger claims. Live post-dispatch
  cancellation, host crash/ restart and thirteen-session/four-repository
  execution remain obligations.

- E87: Final formatted production binary SHA256 is
  `7ffa7a07c3e7dcdbebf99a840c954e0a4e70efd369edd8bbde17559e5237458e`; the four
  qualification drivers compile with strict TypeScript and scoped ESLint exits0
  (`renderer-hostile-2026-10-19/final-formatted-{typecheck,eslint}.log`). The
  complete native ARM check exits101:150 library and40 binary checks pass, while
  one of28 integration checks fails because the fixture publishes an empty PID
  file before writing its bytes (`final-arm-native-tests.log`, invoke.rs920).
  Recorded engine83234/descendant83285 are independently observed absent. The
  producer repair uses exclusive0600 same-directory pending files and rename; a
  forced partial-write probe rejects direct publication and accepts the repair
  (`atomic-pid-producer-probe.log`). It leaves cleanup assertions and budgets
  intact. A worker's focused retry mistakenly supplies a relative artifact root,
  so its budget home is refused and setup fails
  (`atomic-pid-external-signals.log`). That panic loses the control Child handle
  and leaves Node22917 live, parent1, group22771, native birth1792461887.982661,
  with the interval-control command. Runtime scenarios are held pending
  authorized cleanup and independently confirmed absence. Reconfirm the process
  instance before any cleanup decision; this historical PID is not authority.
  The root asks the user for verified cleanup or user-managed cleanup because
  the retained Child handle is lost. Panic-safe fixture cleanup is a separate
  repair, not a production-signal claim. The shell argv recorder uses a
  NUL-delimited shell builtin instead of Node cold startup; unchanged3s limits
  and exact semantic assertions pass14 checks in
  `render-writer-shell-recorder-jest.log`. The prior timeout remains retained.
  Live post-dispatch cancellation/restart and actual13-session/four-repository
  qualification are not established. No machine state is installed or upgraded.

- E88: Source checkpoint `728793c41b988de3bc3d8a7e377d1d3327c2d191` is committed
  with a clean worktree; its release rebuild exits0 and reproduces E87's binary
  SHA256. Independent source inspection exposes a causal oracle gap: unchanged
  journals/no outputs could pass when retry or capacity probes failed before
  owner contact, and any nonzero legacy exit could masquerade as unknown
  fencing. The repair records typed invocation-correlated denials at the actual
  unknown/capacity branches. The qualifier requires that denial, the original
  journal/input/cwd/runtime identity and the native Stop refusal contract;
  cooperative legacy refusal must match the unresolved-execution diagnostic. Ten
  hostile pure controls reject unrelated failures and three valid controls pass
  in `lifecycle-denial-oracle-self-test.log`. The same parser also matches
  retained actual normal caller77648 to its original invocation
  `77648-1792461128379730000`, input digest and receipt timestamps. Compile,
  all-target Clippy and scoped lint pass. The exact process-free Rust unit
  exits0 in `lifecycle-denial-owner-unit.log`, checking capacity/flag/journal
  branches and excluding an expired read as an unknown denial; live denial
  behavior is unqualified. A pure fixture-root resolver rejects relative roots
  before file creation or Node execution; its exact selected test exits0 in
  `absolute-artifact-root-pure-test.log`. The panic-unwind cleanup regression
  and the repaired external-signal scenario remain unexecuted during the hold.
  These source/proof repairs do not establish post-dispatch cleanup, restart,
  final-candidate legacy execution or thirteen-session capacity.

- E89: The refusal/root-setup repairs are committed at
  `3c8709bd0cca5da8d2c1c1b1aa15e761b49f5a2b`. Its release build exits0 and
  produces native SHA256
  `afce042a3224e5f35bd0c37c585dc0ef162527905430a56c65bcc48b0ec0383b`;
  `renderer-hostile-2026-10-19/refusal-proof-committed-release.log` retains the
  build output. `candidate-source-and-hold.json` captures the source revision,
  clean worktree, executable hash and a fresh native observation of the same
  live orphan birth1792461887.982661. Cleanup authorization remains pending.
  Both staged source evaluations pass the five declared CAWS gates; doctor
  exits0 with0 errors/3 warnings. These are source/governance checks, not AC
  acceptance or runtime qualification. Normal/queued E86 and cooperative E84
  receipts retain their earlier executable identities; none is relabelled as an
  execution of this final binary. The complete native suite, panic-unwind
  regression, dispatched cancellation/restart, final cooperative legacy replay
  and all three thirteen-session load modes require execution after the hold. No
  AC pass, merge or machine installation is recorded for this slice.

- E90: Independent native observation of E87's fixture orphan returns
  `{"errno":3,"reason":"No such process (os error 3)","state":"absent"}` with
  exit0; `renderer-hostile-2026-10-19/orphan-absence-continuation.json` retains
  the command, source revision and observation. The root sends no cleanup signal
  and makes no claim about how it exited. This clears the execution hold without
  treating the historical PID as signal authority. The exact panic-unwind
  regression exits0 and independently observes its deliberately unwound child
  absent. The external-signal regression exits101 at invoke.rs1338: its first
  input/SIGTERM case observes signal termination (`status.code() == None`)
  instead of the asserted cancellation exit2.
  `lifecycle-continuation-20261019-01/` retains these attempts. The scenario
  chain stops for cleanup verification and readiness/handler diagnosis; complete
  native, lifecycle, legacy and load qualification are not inferred.

- E91: The signal test's fixed100ms input delay is replaced with a pipe filled
  before the native reader exists. A one-byte write must remain blocked until
  consumption; the negative control rejects no-reader readiness and accepts
  readiness after an asserted4096-byte read. Source order installs cancellation
  before `runner::read_payload`; this witnesses handler readiness without a
  startup-delay assumption. The repaired nine signal/mode cases exit0 with
  cancellation exit2 and5–13ms observed cancellation. Each retains case
  identity, raw status/stdout/stderr and cleanup queries; independent native SDK
  checks observe all27 recorded processes absent with `ESRCH` in
  `lifecycle-continuation-20261019-01/external-signals-repaired-sdk-cleanup.json`.
  The unrelated controls remain live until explicitly stopped through their
  retained Child handles. The first failed case lacks retained PIDs; its exact
  independent absence cannot be reconstructed, although the source's retained
  Child unwind cleanup and exited test support that cleanup path. Final fixture
  CLOEXEC changes and the complete native suite require their own replay. Load
  oracle source at `9e3f24d6` sorts numeric turn indices and checks exact
  contiguous output; lexical order incorrectly places turn1000 before turn101.
  `render-load-source-2026-10-19/numeric-turn-order-2026-10-20T05-15-00.493702+00-00/`
  retains strict compile/lint/pure-check exits0 and two compiled mutations
  exiting1 for lexical order and an ignored user-content assertion. This is
  oracle evidence, not execution of the thirteen-session workload.

- E92: The final fixture at `01d4726d` is exercised by
  `cargo test --all-targets -- --nocapture --test-threads=1`, exit0: 151
  library/40 binary/31 invoke/3 ancestor-example checks. The retained returned
  log is explicitly truncated; per-target summaries and exit metadata remain in
  `lifecycle-continuation-20261019-01/full-native-{returned-output.log,exit.json}`.
  The final nine-case signal SDK artifact again observes27 processes absent.
  All-target Clippy and `npm run qualify:native:render-build` exit0; the release
  rebuild reproduces E89's `afce042a…0383b` binary. The failure-retaining legacy
  helper is committed at `dec55fdd`; its actual-source pure checks preserve the
  original error through unknown/rejected cleanup and memoize one nominal
  cleanup observation. That window is not a strict wall-clock bound because
  individual observer commands have their own bounds. The direct default-all
  lifecycle command exits0 at `dec55fdd`:
  `render-lifecycle-normal-2026-10-20T05-25-19-064Z/`,
  `render-lifecycle-queued-cancel-2026-10-20T05-25-49-768Z/`,
  `render-lifecycle-cancel-2026-10-20T05-26-07-814Z/`, and
  `render-lifecycle-host-crash-restart-2026-10-20T05-26-26-284Z/` retain
  scenario/command/cleanup records. Cancel invocation
  `77400-1792473980631460000` receives the actual `unknown_fence` denial;
  restart's distinct-project invocation `91114-1792473999171770000` receives
  `backend_capacity_exhausted` with used1/maximum1. Both retain exact original
  invocation identity, empty stdout and the expected pre-dispatch diagnostic;
  unrelated timeouts cannot qualify these observations. Actual writes precede
  interruption: cancel31→1353 turns and crash45→101 turns are retained under
  each scenario's `retained-turn-bytes/` with original hash/size mappings. All
  four record `confirmed_inactive`, free custody and absent sockets with
  independent host/worker/backend observations. Crash retains one historical
  worker directory with a complete reap/EOF receipt; directory retention is not
  a live worker. No fatal-worker-loss, generation-replacement, power-cut,
  deployed Sterling adoption or complete A3/A8 claim follows. The separate
  legacy replay and thirteen-session modes require execution.

- E93: The direct cooperative legacy replay exits0 against the same
  `afce042a…0383b` executable and compiled driver `8f264177…afec`:
  `render-legacy-2026-10-20T05-30-35-135Z/manifest.json`. Actual unchanged
  one-shot and daemon writers bypass held native custody; the real response-loss
  client prints `actual-inline-fallback`. These are retained counterexamples,
  not evidence of unchanged-writer exclusion.
  `render-legacy-managed-owner-2026-10-20T05-30-41-910Z/race-result.json`
  observes native worker33600/backend33616 live, then the installed cooperative
  helper refuses75 across another home/generation. Refused output SHA256 is
  unchanged before/after:
  `1b76c440f32a57201d7af9da6278ac281cd3035a3b4c0009fdf9abe26bb00c0b`.
  Independent cleanup observes host31532/worker33600/backend33616 absent, free
  custody and no socket/workers; the same helper subsequently exits0 and prints
  `cooperative-rendered`. No all-writer Sterling adoption or positively
  established prior-writer drain follows. Independent review finds a separate
  load-oracle false positive: substring-matching tool-result text admits
  turn10's output as turn1 or matching text in unrelated metadata. Exact result
  and project/session context assertions are required before the actual
  thirteen-session run.

- E94: Exact tool-result and turn/context isolation assertions are committed at
  `29701e0`; strict compile, scoped lint, pure hostile controls and retained
  normal-output replay exit0. Six isolated mutations fail for the expected
  omitted assertion in
  `render-load-source-2026-10-19/semantic-isolation-2026-10-20T05-33-27.818709+00-00/`.
  Lifecycle's durable byte-copy and exact semantic assertions are committed at
  `c5fca80a`; strict compile/lint and1 valid/8 corrupt turn controls pass. This
  new helper's compiled identity is distinct from E92's actual run. E92's
  separately retained1532 snapshot members (overlapping before/after copies,
  not1532 distinct turns) all match source-transcript semantics and recorded
  hash/size; `lifecycle-all-turn-semantics.json` retains the six snapshot
  verdicts and each snapshot retains per-file checks. A separate lane's
  nested-base registration blocks one root commit; supported untrack/rebinding
  resolves that refusal without a hook bypass. A separate fixture recursion
  incident holds the load launch before execution. The root's independent
  successful process-table collection inspects900 rows and finds0 matching
  original fixture-namespace processes, retained in
  `lifecycle-continuation-20261019-01/pre-load-resource-observation.json`. This
  is current namespace absence, not historical process-instance proof or an
  uncontended-machine claim. The root sends no cleanup signal.

- E95: Actual `baseline` exits1 at
  `render-load-baseline-2026-10-20T05-44-21-134Z/manifest.json`, using E94's
  load source/compiled driver and E89's binary. Thirteen live native clients
  overlap across four private independent repositories. Seven requests produce
  actual daemon responses and seven retained turn files; five callers return
  advisory0 with owner EOF and no output, and one exits2 at the original
  deadline. PID94624's receipt spans30021ms; its owner queue interval is24311ms.
  It reaches Prepared at26385ms and fails source revalidation before renderer
  journal admission/Dispatch. The native fallback's uncertain message covers
  possible compatibility-prefix effects; it does not establish a renderer
  `Unknown` outcome for this caller. Cleanup is `confirmed_inactive`, all
  recorded host/worker/backend observations absent, custody free and no socket.
  `render-load-baseline-2026-10-20T05-44-21-134Z-timing-investigation.json`
  retains all13 receipts, line-indexed journals/stages, seven output identities,
  resource samples and original artifact rehashes (0 mismatches). Recorded
  daemon work is1–49ms; preceding complete compatibility dispatches
  are11520/6277ms. These distinguish the long queue/admission/prefix path from
  short renderer work without attributing CPU/disk contention. Five uncorrelated
  owner events report `named image custody changed`; no exact caller/event
  bijection exists. Source inspection finds mutable service-images parent
  namespace timestamps/ size/link count compared as immutable custody while
  sibling staging/publication legitimately changes them. A typed parent-identity
  repair preserves device/ inode/owner/private mode and nofollow checks;
  immutable image/source/tool checks remain strict. A safe reuse optimization
  retains full stage validation and full final validation while avoiding unused
  staged-tree fsync/rename. Both require focused controls and actual replay
  before efficacy is claimed. Invocation-correlated failure/stage observations
  are a separate assigned repair. No workload or deadline is relaxed;
  concurrent/overload modes are unexecuted. Load's exact two-entry timeline,
  tool ID/input/output and foreign-entry controls are committed at `b97772fa`;
  strict compile/lint/self-check exit0 in
  `render-load-source-2026-10-19/exact-timeline/checks.json`. The failed
  baseline retains its earlier oracle identity and is not relabelled by this
  strengthening.

- E96: Parent-custody/reuse repair `bed92155` and correlated observations
  `9252b617` retain the full stage/final validators, exact manifest equality,
  immutable pins and immediate source checks. The private parent uses device/
  inode/owner/exact0700 identity; sibling namespace fields may change. Reuse
  rechecks the retained stage's named root and parent before returning its
  informational path. That path is not durable deletion authority. Root-run21
  image controls and5 owner/framing checks exit0, including actual sibling
  publication, unsafe/replaced parent/stage refusal and immutable-pin mutation.
  Full native158 library/40 binary/31 invoke/3 example checks and all-target
  Clippy exit0 with untruncated logs in `image-custody-repair-2026-10-20/`.
  Independent native observations record all27 retained signal-case PIDs absent;
  the root signals none during this probe. Release/strict-qualification build
  exits0 and produces native SHA256
  `78f05998ed9709b26272da422d969abcb3eaaef5f829a493a35b2cb34c5d4f3d`. The actual
  replay `render-load-baseline-2026-10-20T06-11-05-150Z/` exits1:13 queued,12
  Prepared,8 daemon responses and8 retained1814-byte turns, with5 deadline
  failures. No image-admission refusal or EOF diagnostic recurs in this sample;
  removal of the earlier custody refusals does not establish
  successful13-session qualification. Cleanup is confirmed inactive/free with no
  socket. The adjacent `-timing-investigation.json` binds13 receipts and
  journals to owner stages and8 output hashes, with0 original-artifact
  mismatches. First-cohort Prepared→bridge arrival spans10820–11129ms;
  second-cohort spans 4344–4650ms. Late callers reach Prepared at26.3–27.3s and
  then expire waiting for the bridge; one expires queued. No concurrent/overload
  mode is run.

- E97: Source-grounded scheduling dependency: `Actor::serve` retains project
  serialization while compatibility dispatch runs before the selected render
  bridge. Splitting that wait requires a FIFO pending queue, one compatible
  backend-generation cohort, a same-session/incompatible-offer barrier, shared
  admission permits held by actor and reader until both finish, and pending
  demand preventing idle retirement. Preserve the literal existing project bound
  of one active plus `max_queue_per_project` waiting and the existing
  connection-reader threads; no additional per-request thread or unbounded
  completion map. Journal acceptance remains after complete argument-bearing
  bridge bytes; FIFO bridge arrivals cannot reorder effects. Cancellation before
  those bytes proves no render Dispatch, not zero compatibility-prefix writes.
  Before enabling prefix overlap, resolve actual prefix ownership. The stock
  plan snapshot producer appends only destination paths to one HOME/vendor
  `.pending-plan-snapshots` list; finalization copies the current transcript to
  all destinations and unlinks the list. Serial execution alone cannot assign
  those ownerless entries to the current session. Codex's stock PostToolUse
  matcher does not reach the producer's exact ExitPlanMode gate, but the
  selected Stop consumer can encounter a preexisting list. Preserve/diagnose
  unowned legacy records rather than guessing provenance. Other prefix state
  ownership and native-derived overlap eligibility require inspection.
  Implementation and acceptance of this split are not inferred from these design
  constraints.

- E98: Native plan snapshot transactions are committed at `8c492aa0` with a
  typed standalone CLI qualifier. Explicit project/surface/session ownership,
  transcript inode/prefix provenance, independent tickets and stable kernel
  target locks replace the ownerless carrier for this helper. Independent source
  inspection identifies source/destination aliasing and first-use overwrite of
  an ownerless snapshot; both refuse before claiming or publishing a ticket.
  Sixteen focused controls exit0, including exact bytes, preserved legacy state,
  concurrent ticket arrival and a created lock child reaped with raw status0.
  The first full library run exits101 because two clock-only fixture names
  collide; an atomic fixture sequence repairs that test isolation failure.
  Preserve
  `prefix-cohort-2026-10-20/{first-compile,full-lib-first,snapshot-unit}.*`. The
  helper permits bounded ASCII plan basenames and refuses permanent target owner
  conflicts. Those restrictions, shared-producer adoption and migration of
  ownerless legacy records require explicit disposition before full parity. The
  sealed Codex Stop consumer uses a native-owned adapter and configured,
  byte-pinned native helper. Stock Codex does not reach the ExitPlanMode
  producer; direct helper qualification cannot establish that producer or other
  surfaces.

- E99: The connected pending-cohort source preserves existing connection
  threads, shared global/project permits, FIFO effects,
  same-session/incompatible-view barriers and pending-demand residency.
  `prefix_disposition` records native session/serial eligibility independently
  of caller declarations. Eligibility uses42 explicit reviewed fingerprints in
  `service_image/prefix-profile.json`; recompiling changed stock files does not
  automatically bless their mutation domains. Valid unknown/legacy sources
  remain serial. The first successful full native run exits0 with186 library/40
  binary/31 invocation/3 example checks; it precedes replacing automatic source
  embedding with that explicit policy. The explicit-policy image suite then
  exits0 with26 checks; all-target Clippy and strict compilation of all six
  qualifiers exit0. CLI image/offer suites pass84 checks with two
  reviewed-profile integration checks skipped. Raw commands, exits and
  untruncated output live in `prefix-cohort-2026-10-20/`. These source checks do
  not qualify actual prefix overlap or thirteen successful callers. The first
  successful run deleted invocation fixture directories. A committed candidate
  replay retains them and independently queries their PIDs in E101. The
  post-Dispatch publication fault control distinguishes a durable Running fence
  from successful Unknown publication, poisoned handles and recovered settled
  results; no replay authority comes from the local flag. The six-case
  actual-owner qualifier and six-case direct snapshot qualifier compile but have
  not executed at this checkpoint.

- E100: The separate R06 owner reports selected-stock invocation qualification,
  its own spec closure and source consolidation at `4f1e40f2`, with retained
  evidence under
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/native-guard-config/`.
  Root inspection confirms its four source paths; parent integration and
  independent behavioral adjudication remain pending. It does not retire Python
  compatibility or establish native harness delivery/PID containment. Root
  source inspection corrects R08's stale consumer label: the typed composer
  already imports/calls the TS truncator; the shared shell runner uses Python.
  The separate R08 owner implements typed asset packaging and the installed
  shell consumer under its own bound lane. Its source/report is not parent
  acceptance, and its verification shares a scheduled machine resource slot with
  this lane.

- E101: Committed `7aa97f6b` all-target native checks exit0 with retained
  fixtures under `prefix-cohort-2026-10-20/native-fixtures/`. The returned
  console output is truncated, explicitly recorded in `candidate-native.json`;
  it is not an unabridged transcript. The nine retained signal cases identify27
  exact created PIDs. Separate read-only macOS
  `service-observer --observe <pid>` commands each exit0 and report
  `state: absent`, errno3. `candidate-signal-absence.json` retains commands, raw
  results, observer SHA and fixture bindings. Root sends no signals. This
  establishes later absence for these retained cases, not complete PID safety
  parity or historical cleanup for unretained fixtures.

- E102: Source `22d2e007` builds the CLI, release native executable and seven
  strict qualifiers with exit0 (`prefix-cohort-2026-10-20/release-build.*`).
  Native SHA is
  `a94eb10871aedfcf19127ef213022235a30024307d9bddd6c089d2a11fca5766`. Direct
  `qualify-plan-snapshots.js` exits0 with six scenarios and13 retained direct
  child closes, including refusals75 for source/destination alias and
  preexisting ownerless snapshot. Raw initial/final bytes, ownership/tickets and
  command streams live in `plan-snapshots-2026-10-20T07-41-57-641Z/`. Finalize
  stdout is `{"produced":0,"finalized":1,"diagnostics":[]}`. These cases do not
  exercise alternate configured homes, actual Stop delivery, shared producer
  adoption or deployed writer exclusion.

- E103: Actual selected Stop qualification on that executable exits1 in
  `render-plan-snapshots-2026-10-20T07-43-34-325Z/`: the qualifier incorrectly
  expects a top-level `handler_completed` journal record. The actual
  compatibility path emits
  `compatibility_dispatch_completed.execution_records_base64`, which decodes to
  the four completed handlers, including native snapshot diagnostic. Exact
  finalized snapshot, own-ticket acknowledgement, other-repository same-ID
  preservation, legacy preservation and two semantic turn checks precede the
  failed assertion. Root verifies169 original artifact hashes and retains21
  additional failure-state observations, including the6191-byte invocation
  journal and two1835-byte turn files. `failure-observation.json` records them;
  cleanup is confirmed inactive, custody free and socket absent. Preserve this
  failure; repair the oracle against the actual producer and replay before
  claiming the complete selected path.

- E104: Independent Sol source review identifies two isolation counterexamples.
  Raw case-distinct session IDs can name one directory on macOS; root `stat`
  confirms canonical `caws`/`CAWS` device16777231/inode215766425. Commit
  `d9d2133d` conservatively serializes ASCII case aliases without changing
  caller identity; unit and actual-owner case-alias controls require execution.
  Target locks under configurable machine homes can also be distinct for one
  destination. A bounded worker moves target custody beside the destination and
  adds distinct-home producer controls; its source and execution remain pending.
  Target-side cache ignore/distribution policy must be resolved before producer
  adoption. A stale ticket can stop other tickets in its namespace; mixed
  stale/current progress, legacy adoption and permanent foreign-owner reuse
  remain explicit obligations. The review supplies counterexamples, not an
  acceptance verdict.

- E105: Destination custody repair `5e0f687a` and case-domain repair `d9d2133d`
  pass17 snapshot controls and the focused session-domain control; strict native
  Clippy exits0. Seven direct CLI scenarios on native SHA
  `d4644326955132c471099079c12192091e070ead1567096e326db7593b19dfab` exit0 in
  `plan-snapshots-2026-10-20T07-58-11-419Z/`, retaining16 direct child closes.
  Concurrent different-home producers return0/75; retry returns75 with
  `snapshot destination has another owner`, preserving winner bytes/inode.
  Actual `qualify-render-plan-snapshots.js` exits0 in
  `render-plan-snapshots-2026-10-20T07-58-35-681Z/`. Its selected Stop uses the
  original30s budget, finalizes and acknowledges only the owned ticket,
  preserves the other repository's same-ID ticket and legacy bytes/inodes, and
  renders both exact semantic turns. Root independently verifies190 retained
  artifact hashes. Snapshot and transcript copies are2040 bytes with equal SHA
  `0c80240abb93494bf51f44b6062bfba7297a2a809f98a3b890df87b73aa9f0fe`.
  `actual-execution-records.jsonl` records completed finalizer exit0 with native
  preservation diagnostic, correlated to invocation `95086-1792483117563286000`
  and native session prefix proof. All four direct children close0 without a
  signal; cleanup is confirmed inactive, custody free and socket absent. These
  artifacts establish this selected path, not stock shared producer adoption,
  mixed stale-ticket recovery, deployed legacy exclusion or load qualification.

- E106: Destination custody receives precise managed-ignore coverage at
  `e6cfd05a`; its first focused Jest run fails two inherited cardinality
  assertions. Inspection additionally exposes literal-glob probes and omission
  of nested indexed custody in the drift observer. Repair `4b4f265a` uses
  concrete root/nested probes and a bounded recursive Git query. CLI build and
  eight focused checks exit0, including nested negation, root-only false
  coverage, actual force-staged custody and trackable authority/source controls.
  Preserve `prefix-cohort-2026-10-20/snapshot-ignore-{first,repair}-test.*`. The
  first actual pending FIFO qualifier exits1 because its oracle reads the
  outcome envelope at the wrong depth. Two Prepared callers share backend9319;
  only the first operation is retained returned/served1, so two completed FIFO
  effects are not established. Preserve
  `render-pending-fifo-2026-10-20T07-59-31-584Z/`. Cleanup is confirmed
  inactive/free/socket absent. Commit `15507bee` retains the typed
  `reply.outcome.outcome` discriminants and records raw/decoded replies and
  operations before assertions; strict compilation exits0. Actual replay remains
  required; no failed attempt is reclassified as success.

- E107: Typed-driver replay on unchanged native `d4644326` passes actual FIFO,
  case-alias and same-session controls. Roots are respectively
  `render-pending-fifo-2026-10-20T08-04-19-941Z/`,
  `render-pending-case-alias-2026-10-20T08-05-40-740Z/` and
  `render-pending-same-session-2026-10-20T08-06-50-253Z/`. FIFO retains two
  Prepared callers on backend85013 and returned sequence/served pairs1/1 and2/2.
  Root verifies162 FIFO artifact hashes. Case aliases `shared-id` and
  `SHARED-ID` share device16777231/inode752599413; the owner records a prefix
  barrier, first-caller withdrawal, then second Prepared and one returned effect
  with exact uppercase identity. Root verifies153 case-alias artifact hashes.
  Each cleanup is confirmed inactive/free/socket absent. These controls enter
  the actual owner directly and do not execute thirteen compatibility prefixes.
  Generation, framing, reader expiry and valid-unreviewed serial controls remain
  unexecuted. Separate inspection finds the drift check's three representative
  probes cannot establish coverage of actual untracked custody under another
  accepted plan directory; bounded discovery of existing unignored custody and a
  `plans/team` negation control require implementation/execution.

- E108: Existing-untracked custody discovery `ad993637` passes10 focused checks.
  Retained compiled-SUT probe
  `drift-existing-custody-2026-10-20/run-2026-10-20T08-17-50-534Z/` returns no
  findings for protected owner/lock files, then exactly those two
  `plans/team/.caws-plan-snapshot-custody/v1/` files uncovered by the deeper
  `.gitignore` line2 negation. All three representative probes remain protected;
  adjacent source and near-miss paths remain ordinary untracked files. Fourteen
  external Git children close with expected0/1 and no signal. Preserve the first
  probe's exit128 from invalid multi-path `check-ignore --quiet`; no SUT result
  is inferred from that failure. Native `d4644326` also passes generation,
  framing, reader-expiry and valid-unreviewed serial controls in roots ending
  `08-12-06-360Z`, `08-18-42-073Z`, `08-19-11-905Z`, `08-20-19-636Z`. Root
  verifies158/155/154/154 artifact hashes respectively. Generation retains its
  old child/private Git view until withdrawal and cleanup before replacement;
  surplus framing withdraws without an effect; reader expiry retains demand
  beyond idle eligibility and reports `deadline_expired`; valid changed stock
  prefix images receive `serial/unreviewed_prefix`, not rejection or overlap.
  All four cleanup receipts are confirmed inactive/free/socket absent.

- E109: Actual thirteen-native-client/four-repository baseline on that
  executable exits1 in `render-load-baseline-2026-10-20T08-21-28-290Z/`. All13
  clients exit0, all13 retained1814-byte turns have isolated expected values,
  all13 durable operations return and project-local sequence equals daemon
  served count. Thirteen live client birth identities and maximum overlap13 are
  observed; latency ranges17439–19484ms under the unchanged30000ms budget. These
  bounded results do not make the qualifier pass: its cross-project
  Running-overlap assertion fails.695 samples observe at most one Running
  project. Independent source/event-order inspection establishes genuinely
  disjoint Running windows in this trace, not merely missed sub-millisecond
  samples. Actual daemon work reports1–5ms. Independent actor threads exist;
  revalidation and synchronous host-wide diagnostic writes stagger transitions,
  without establishing a structural global serialization defect. Four expected
  idle retirements also emit `worker_failure/host_stopped`, which would fail the
  next lifecycle gate. Fix that producer taxonomy without filtering failures.
  Preserve baseline FAIL; expose the already-planned unchanged1000-turn
  slow/fairness phase separately to require other-repository and guard
  completion before a later hot Running witness. No workload inflation,
  artificial delay or blind baseline retry. Cleanup is confirmed
  inactive/free/socket absent. Concurrent/overload modes and final-executable
  lifecycle replay remain unexecuted.

- E110: Independent R08 owner reports component closure and retained clean
  candidate `6d44dc9f77a5bda3be81a9504b0397514af0464c`, based on R06 `4f1e40f2`.
  Its private npm-package/installed Bash cases, selected custom compatibility,
  synthetic installer and bounded BATS outputs live under the E100 external
  artifact root's `native-advisory-truncation/`. Production bytes match its
  tested `5f55cba3`; later commits change retention/instrumentation only. Root
  receives these as attributed reports; parent integration/acceptance remains
  separate. Native-image integration requires independent review of the stock
  runner/helper prefix fingerprints and pinned validation tools: source review
  identifies `cmp` absent from the sealed image's PATH/tool set although the
  switched runner requires it for literal-prefix validation. Installed Bash
  evidence does not qualify that image. Python custom compatibility, native
  harness/PID parity, Node18 execution, arbitrary custom consumers, first-party
  Python retirement and full A1–A8 remain open. No machine activation occurs.

- E111: Explicit idle Stop exits cleanly at `da0bab98`; active-render Stop keeps
  its failure/uncertainty boundary. The first full Cargo attempt exits101
  because the supplied retained-fixture parent does not exist (50 constructor
  failures), preserved in `prefix-cohort-2026-10-20/idle-stop-all-native.log`. A
  distinct replay with that parent created exits0:190 library,40 binary,31
  invocation and 3 example checks; the untruncated replay log SHA-256 is
  `453086d9cf2df835ced2836d0890849ccc1272aecbc689ac42553b374589c2a4`. Test-only
  `a0665f21` adds prelaunch case identity, actual Stop bytes/PID and settlement
  after raw WorkerExit equality. Its focused three-case command exits0;
  `idle-stop-bound-tests.log` SHA-256 is
  `64ad7a3a685ceee934d2bdcc99c046a1f77f87936cd917f1c69e727fcf150837`. Under
  `idle-stop-bound-fixtures/renderer-backend-13861-{0,1,2}`, raw exits retain
  respectively Returned/clean, no-render/clean and Unknown/HostStopped. Created
  children13862/13864/13866 are reaped with both pipes EOF; separate SDK queries
  return absent/errno3 for each in `idle-stop-bound-sdk-absence.json`.
  Independent read-only inspection finds no settlement-before-assertions or
  Unknown-erasure counterexample. These are fixture observations; final native
  lifecycle replay and whole-session/PID containment parity remain owed.

- E112: `9de47e53` exposes the original fairness phase separately without
  relaxing baseline/concurrent gates. Actual `fairness` on native SHA-256
  `85ccd528d2798394e90270b4dd235d4ff7ca536278fd514500eada8825390d86` and driver
  `764c78e0de3c443ab9de0374d4c45bede124f9ebb8eb5998e84070f39eaaf620` exits1 at
  the peer-before-later-hot-Running assertion. Raw evidence is
  `render-load-fairness-2026-10-20T08-42-11-817Z/`; the command/exit are
  retained separately in
  `prefix-cohort-2026-10-20/fairness-actual-command.{json,log}`. Root rehashes
  all1379 artifact-manifest members with zero mismatches. The hot backend
  returns1000 turns in759ms; stable Running ends08:42:26.463UTC, guards
  close08:42:31.301–32.769 and peers08:42:39.108–39.737. All finish after hot;
  neither independent enforcement capacity nor cross-project Running overlap
  qualifies. The Sol investigator independently validates1003 semantic outputs,
  four uncached Returned operations and13 scoped block responses with exit2.
  Those semantic checks occur after the failing assertion in the driver, so this
  separate artifact inspection does not change the scenario verdict. The
  retained last hot turn is1812B, SHA-256
  `479fba618a465b466e92df6d15c42f70953d8d4b16aa3b8e11c0fce792eac8c8`; three1798B
  peer turn files and raw guard stdout/receipts are retained too. Cleanup is
  confirmed inactive/free, socket absent, original instances absent; no worker
  failure/actor error/cleanup deadline appears after the idle repair. Native
  image admission consumes3333–3695ms; peer Prepared-to-bridge consumes
  5934–6332ms. Codex heartbeat consumes2302–2521ms, cwd634–889ms and danger
  1982–2100ms. These are distinct measured buckets, not additive attribution of
  every nested stage. Cold publication includes source/tool checks and tree
  syncing; internal costs are unmeasured. Process samples show31 library-map
  Python children despite all four selected override maps being empty. Guard
  heartbeats also invoke PATH-resolved host `caws`; its bytes are not retained,
  so whole-guard timings cannot qualify the candidate CLI identity. Exact-empty
  lookup removal, explicit fixture CLI selection and publication phase timings
  are the next bounded changes. No budget, transcript size or workload count
  changes, caching, guard relaxation or machine activation follows.

- E113: `f7a5af50` skips only the Python map lookup for literal
  `CAWS_MACHINE_LIBRARIES='{}'`. Other values retain the parser and all existing
  policy/user/adapter/shared resolution tiers. Six source-unit Bats controls
  exit0; malformed/nonobject and missing-Python refusals, quoted overrides and
  per-call freshness are observed. The installed-pack-in-source-mode control
  exits1 deliberately. Raw output, statuses, parser witnesses and177 hashed
  fixture files live in `prefix-cohort-2026-10-20/agent-surface-source-unit*`.
  The committed test differs from the executed test only by its retention
  comment; the production template and manually reviewed prefix entry both hash
  `9fb104eab8cc5955157dd2da7dc25c19a4bfcd008aa148cfacfba842c9310c32`. `49dbef03`
  adds typed publication phase diagnostics without caching or removed checks;
  three focused early-refusal/real-rename/error-preservation controls exit0.
  `image-publication-phases.log` SHA-256 is
  `92d7cf80dfb3be9ae33b37eaa07f57fe71b24fbb006e8eba7d0e82daea70625f`. Successful
  full-image publication/reuse phases require actual replay. Callback logging
  adds synchronous I/O; operation durations exclude it while the overall
  admission deadline includes it. `0ca4df4f` selects the candidate CLI through
  an artifact-retained POSIX-sh PATH wrapper and records Node/entry hashes.
  Sealed dispatch uses its own pinned image adapter. This establishes default
  fixture selection in source, not observed exec for arbitrary override
  environments. Semantic diagnostics precede the unchanged fairness gates.
  Independent read-only reviews inspect the committed Bash/TS and native changes
  and find no applicable counterexample; their source conclusions do not
  establish runtime execution or performance.

- E114: Candidate `0ca4df4f` CLI/release/seven strict qualifier build exits0;
  native SHA-256 is
  `b53d72c5208ff1fa6c75fd122b3393c81dfa449c44c08c2f7d8e0bec74459ce0`, load
  driver `1a82043e7d7ef18db6e411ef306d6f5e0da75c93e07f9979b73d1f54e6c391e2`.
  Full `cargo test --all-targets -- --nocapture` exits101:192 library checks
  pass and
  `render_writer::tests::disposable_session_cache_replacement_cannot_partition_live_writer_custody`
  fails because its5ms acquisition refusal lacks the asserted owner text. The
  original assertion discards actual error text; the original cause is unknown.
  Binary/invocation/example groups do not execute in this attempt. Preserve
  `cold-pipeline-all-native.{log,json}` and its full log SHA-256
  `041e37a4c9f90a73111d9fb9461e2629196d6376da558c670d51e90685c72158`. Strict
  all-target Clippy exits0. Doctor exits0 with inherited0E/3W/4I; five policy
  gates exit0 on the92 committed/staged paths against the declared Git branch
  basis. Their raw logs/receipts share the `cold-pipeline-` prefix. Policy
  success does not erase the native failure. Hold actual workload replay for a
  test-only actual-refusal/custody-state probe with unchanged deadline and
  strict oracle; a later observation cannot retroactively identify that lost
  original error. No final-executable lifecycle, fairness, overload or installed
  parity result follows from this build.

- E115: Source tracing at `0ca4df4f` establishes a larger open dependency:
  `runner.rs:178–228` starts Node for each request; `engine-entry.ts` prepares
  one invocation before Ready and destroys its input at settlement. Render
  offers resolve/hash tools and prepare images before owner contact
  (`service-offer.ts:196–208`). `FairWorkScheduler` appears only at its class
  definition in production source; its required/render reservations have no
  consumer. Renderer owner capacity therefore does not establish R25/R31's
  complete resident engine or required enforcement lane. The fairness gate
  launches peers/guards after the same hot operation becomes Running and
  requires completion before its later Running sample. Cold consumer cost
  exceeding that remaining interval can fail this gate without a renderer queue
  starving guards; guards do not enter that owner. Preserve the gate's failure
  and workload. Join complete caller/engine/handler latency with the measured
  publication phases before selecting the next implementation. A resident pool
  must retain code loading and owned workers, not cached authority or shared
  caller identity. Per-request project/selection/source freshness, caller
  environment, native ancestor/process-instance capture, cancellation,
  containment handoff and unknown outcomes remain requirements. Killing a shared
  engine group for one request must not interrupt another request; a
  renderer-only or generic shared-Node change cannot earn that claim.

- E116: Test-only `a6a78a3b` replaces the writer test's timing-dependent text
  inference with direct kernel evidence. The5ms full-path acquisition still
  refuses, accepting only exact Busy or typed-derived Deadline; independent
  existing-only/nofollow descriptors must receive EWOULDBLOCK on the actual
  lifetime-flock inode before release and while full-path500ms readmission holds
  custody. Wrong-inode rejection, unchanged custody/registry/journal identities
  and bytes, replaced session-cache inode and usable original owner are
  asserted. Targeted execution exits0; `writer-cache-stable-lock-targeted`
  log/receipt and fixture `caws-render-writer-19542-1792488478093653000` retain
  both syscall results-1/errno35 on dev16777231/inode752726621; the wrong inode
  is752726632. Every probe/duplicate/owner descriptor closes before completion;
  no child is created. Independent inspection confirms the second probe would
  reject returning the correct inode without acquiring its flock. This is not an
  executed mutation campaign or recovery of E114's lost original refusal.

- E117: The next parallel full run at `a6a78a3b` exits101 at a different test,
  `stop_budget::tests::held_lock_deadline_does_not_consume_a_charge`: first
  nonblocking flock returns-1 instead of0 after a completed charge. Its errno is
  absent. Preserve `cold-pipeline-all-native-replay.{log,json}`, log hash
  `ff1f78447e0a0e5f38085bb4aaef0e566707dff7df3fd42eaff5dcfcbb7089e9`. Test-only
  `8a08d57b` retains immediate errno/FD flags/identities, raw budget bytes and
  elapsed time before diagnostic writes; the strict flock0 and
  original60ms/50–300ms timing/counter assertions remain. Its targeted probe
  exits0: flock0,60.5ms Deadline, counter1 unchanged then2 after release. The
  full instrumented replay exits0:193 library,40 binary,31 invocation and 3
  example checks. Raw log `cold-pipeline-all-native-diagnostic.log` hashes
  `29043fe6837a1b35cc1d5912ab945f4b870d942055d26d0e056970380e9aa69b`; retained
  fixture `caws-stop-budget-21353-1792488965849343000` records flock0, errno
  null,60,334,292ns Deadline and exact counter bytes. Final all-target Clippy
  exits0. Independent source/artifact inspection confirms diagnostic ordering;
  added I/O can change scheduling, so neither later pass identifies either
  earlier full-run failure. Source review also identifies an intentional
  non-exec fork inside shared libtest at `plan_snapshots/tests.rs:536`, which
  can retain unrelated inherited CLOEXEC flock references. Its occurrence in
  either failure is unproven. A deterministic inheritance control/isolation
  remains an explicit test obligation, not a reason to attribute or erase the
  failures. All these logs/receipts live under `prefix-cohort-2026-10-20/`.

- E118: Actual unchanged fairness replay on native `b53d72c5`/driver `1a82043e`
  exits1 at the same peer-before-later-hot-Running assertion. Artifacts are
  `render-load-fairness-2026-10-20T09-37-00-274Z/`; command/exit/hash identity
  are retained in `prefix-cohort-2026-10-20/cold-pipeline-fairness-command`. The
  driver checks semantic output before timing:1000 hot turns and three peer
  turns match, four operations return uncached, all13 compatibility guard
  responses carry structured block and native exit2. These are stock guard
  executions, not typed-classifier execution. Authorized independent readback
  compares all1003 complete turn JSON objects and request context, all17 input/
  journal/terminal correlations and13 refusal identities; rehashes1384 retained
  artifacts/5,344,931B with zero mismatches. Last hot turn is1812B/SHA-256
  `c95030b964380820c31759faf8e8057dc6d4561e3f5ca5870578f96e90674435`; three1798B
  peer outputs, raw block stdout and per-command receipts are retained. All17
  delivery fields remain `not_observed`: native stdout inspection does not prove
  platform harness consumption. Resource samples observe26 distinct candidate
  CLI Node PIDs, no sampled host CLI or library-map parser, but35 Python PIDs
  including handler-map parsing/classification. Polling absence is not universal
  absence; no Python retirement or controlled speedup follows. All four
  installed agent-surface copies match9fb104ea;224 current-original/ fixture
  foreign-source custody comparisons match. The206B CLI wrapper is retained at
  `hook-cli/caws`, SHA-256
  `855576359bca196e557c2f259b1aaef9e12382aed88e5daf8dc5be7dbca7acc4`. Cleanup is
  confirmed inactive/free, socket absent, no retained worker, original host29784
  absent/errno3. No further scenario runs after this failure. The single owner
  clock places hot outcome8751ms before peer queue arrivals 8982/9039/9170ms: no
  peer offer contends with an active hot effect in this run. Hot daemon720ms,
  stable Running746ms; peers report3/1/1ms. Whole peer calls take15.146–15.574s;
  image admission3.583–3.736s, of which SyncStage takes 2.687–2.887s; bridge
  wait7.877–8.405s. SyncStage includes confinement and syncing179 files,19
  nested directories and root, excluding callbacks; it is not isolated fsync CPU
  attribution. Guard calls take4.077–4.644s without renderer admission.
  Start-to-dispatch timing includes Prepared wait, so accounting must not
  double-count image admission as independent Node work. Even eliminating
  syncing would leave the guard and prefix witness unmet. The next cohesive
  dependency is an actual required-lane executor covering the complete
  heartbeat/guard/Stop-prefix consumer path with fresh authority, bounded
  capacity and request-owned cleanup. A resident Node launcher alone leaves
  measured shell/CLI/Python work. No cache, durability-check removal, workload
  inflation or weakened gate is authorized by this diagnosis.

- E119: Ordinary merge `9051cfc4` integrates R06's `4f1e40f2` component. Build
  exits0 and four focused suites pass90 checks with one native skip;
  `prefix-cohort-2026-10-20/r06-parent-{build,focused}.log` retain raw output.
  The first native qualifier compile command exits127 because a worktree-local
  TypeScript executable is absent; no scenario starts. The corrected dependency
  path runs the actual native client `b53d72c5` and passes the four-consumer
  case in `r06-parent-native-2026-10-20/`. These checks miss a public-control
  defect: independent review identifies clearing of `CAWS_GUARD_NO_ASK`
  alongside private assignments. The retained unit negative exits1; the actual
  Claude/shared-emitter worktree guard also returns0/ask with NO_ASK=1 in
  `r06-no-ask-shared-emitter-baseline-2026-10-20/`. Earlier fixture attempts
  incorrectly assumed an unborn branch was a resolved HEAD or that Codex's
  emitter returned ask; their failed controls remain preserved and do not
  establish this regression. Repair `900f0516` clears only status and indexed
  zone/prefix/threshold transport. Repaired build exits0; four suites pass92
  checks with one native skip (`r06-no-ask-repaired-focused.log`). The compiled
  native replay passes two cases and retains command, source/module hashes,
  stdout/stderr and fixture state in `r06-public-controls-native-2026-10-20/`.
  Its `guard-config-a1Rjtj/ask-incapable-result.json` records actual guard
  status2, empty stdout, explicit hard-block stderr and retained NO_ASK=1;
  forged zone authority is absent. The ask-capable control returns0/ask, so an
  unrelated infrastructure block cannot satisfy the oracle. Both fixture process
  snapshots have no matching processes. The wrapper captures guard disposition
  and finishes successfully: this proves transport and the actual consumer, not
  native refusal propagation, real kernel scope authority or platform
  consumption. Selected custom parsers, other Python consumers, machine
  installation and parent acceptance remain separate. Review feedback is
  independently grounded at the actual public-control and consumer coordinates.

- E120: Test-only `29844146` isolates the intentional raw fork behind an exact
  `current_exe` exec before fixture creation. The initial compile fails for a
  missing RawFd import; `fork-isolation-focused.*` preserves it without claiming
  test execution. The corrected focused command exits0 and retains the complete
  fixture plus file hashes in `fork-isolation-corrected-focused.{json,log}`.
  Outer39174 retains CLOEXEC FD200/dev16777231/inode752781159; helper39428
  observes both fcntl and fstat EBADF before fixture/fork. Inner fork39478
  exits0 after the original30ms contention denial,2s pipe/poll and post-exit
  reacquisition controls. Original helper cleanup records ExitedOnly followed by
  reap/exit0. This proves the fixture's exec boundary, not the cause of any
  earlier lock failure or complete suite isolation. Unavailable cleanup retains
  the original Child and an unknown receipt; the5s observation is not an
  unconditional cleanup wall-clock bound.

- E121: The parallel full replay after isolation exits101 with191 library passes
  and two failures (`fork-isolated-all-native.log`, SHA-256
  `353e9a1867fe6e88187c770e751c64188a232299a33903b138d396b1a4cea4b2`). A second
  cross-home5ms writer attempt loses its expected Busy text, and the owner-EOF
  test's first post-join flock returns-1. Neither original actual error/errno is
  retained. The backend's raw worker receipt nevertheless records original
  child7915 identity-verified group SIGKILL, reap, both pipe EOF and persisted
  logs. Independent current observation reports PID7915 absent and a fresh
  nofollow lock probe succeeds on the original retained inode752786754
  (`renderer-eof-current-cleanup.json`); it cannot recover historical errno or
  prove universal descendant absence. Test-only `c63647cd` preserves both5ms
  outcomes, exact Busy/typed Deadline matching, immutable custody records and
  fresh independent kernel exclusion on the held inode before release and during
  full alternate-home readmission. EOF instrumentation captures the unchanged
  first post-join syscall/errno, FD/name identity and actual WorkerExit before
  its strict0 assertion. A first writer-only focused run passes but omits the
  artifact-root environment and deletes its fixture; its log is evidence only of
  that execution. The corrected retained two-case command exits0
  (`lock-diagnostics-retained-focused.log`): kernel probes return-1/errno35 on
  inode752809557 before release and while readmitted; EOF child43209 is
  verified/reaped and its first post-join probe returns0. The subsequent full
  diagnostic replay exits101 with192 passes at a different fixture defect:
  cleanup-fault readiness reads an existing but empty holder JSON file at
  `renderer_backend/tests.rs:529`. The producer writes that public path
  directly; file existence is not complete publication. Its retained worker
  receipt records original child58290 verified/reaped and both EOF after unwind;
  the injected cleanup deadline is exceeded. Keep this failure and repair atomic
  fixture publication before another suite replay. No original lock failure is
  attributed or erased, and no post-failure load scenario executes.

- E122: Required-path source inspection rejects a general pre-Node capacity
  queue on the present contract. `main.rs` captures ancestry then starts Node;
  fresh latch/strike/escalation occurs only after dispatch through selected
  `block-dangerous.sh`. `stock-handlers.ts` deliberately falls back for latches
  and catastrophic deny. A pre-start Busy/expiry would emit a PreToolUse block
  without the required containment effect, or release an undispatched Stop
  without its goal guard. Reserved capacity alone cannot prove safety under
  saturation. R06 does not replace that consumer: E118 positively observes
  Python command classification, while the typed dangerous core supports only
  bounded allow/advisory cases; Claude retains full compatibility normalization.
  Retained modules must remain distinct from invocation-owned process groups. A
  future warm worker must consume fresh authority through the canonical TS
  implementation while a fresh native frontend retains actual caller ancestry,
  executor Child/group, output/effects and settlement. Every subprocess port,
  including Git/context/classifier/utilities/containment lookup, needs that
  ownership boundary. Opportunistic warm reuse with unchanged one-shot fallback
  only before any request delivery is an intermediate route, not a global cold
  fan-out cap. Stop reuse additionally requires a real per-request FD3/4/5
  carrier. Cancellation, late frames, uncertain delivery, saturation with a
  sacrificial latched caller and a surviving sibling must falsify this design
  before residency or fair-capacity claims. This is a verified source dependency
  and proposed implementation contract, not executed residency evidence.

- E123: Test-only `963279f9` repairs the witnessed holder-ready publication
  race. The fixture producer exposes a private staging inode containing only
  `{`, waits for an explicit bounded handshake, then completes/closes and
  atomically renames it. The consumer preserves its first final read before
  parsing, without tolerating malformed public JSON or extending its5s window.
  `holder-atomic-focused.log` exits0; retained fixture
  `holder-atomic-focused-fixtures/renderer-backend-44599-0` records final ENOENT
  while staging is incomplete, then complete JSON on the same inode752825676.
  The original two observation faults, two signal faults, quarantine, custody
  through reap, zero pre-release reaps, one final reap and both EOF remain
  exercised. Child44600/holder44632 are fixture-created; owned cleanup settles
  before custody releases. The test also retains its actual worker JoinHandle
  and control socket across unwind. Successful execution consumes that join
  before Drop, so these artifacts do not exercise Drop's retained-join branch;
  intentional-unwind qualification remains separate. No historical failed
  ready-file bytes are reconstructed from the later complete file. The full
  replay at `184f4cc7` exits0:198 library,40 binary,31 invocation and 3 example
  checks. `holder-atomic-all-native.log` SHA-256 is
  `69829c863c7e656e2b32af2df435d590c9d52a91eec9cdbca1bc3ff1e40b8001`. Its
  retained EOF child74699 is verified/reaped with both EOF and first post-join
  flock0; independent writer probes retain-1/errno35 on the same inode752839247
  before release and during alternate-home readmission. Clippy all-targets with
  denied warnings exits0. These are observations on this candidate;
  E116/E117/E121's original unexplained lock failures remain open.

- E124: Ordinary merge `a92ce197` integrates R08's `6d44dc9f`. The generated
  asset check exits0 without regeneration. Shared manifest version100 and
  combined fingerprint
  `d83adae9f045c6032cebcf41604ac5f6093f10a88322468a25f5178574b18109` cover75
  actual files, preserving parent agent-surface `9fb104ea`; copying the
  component fingerprint would describe different bytes. A scope refusal blocks
  the first fingerprint edit; the CLI adds the exact missing path, and all15
  merge paths subsequently admit. Integration `184f4cc7` keeps30 mandatory tools
  and permits only explicitly pinned optional cmp/iconv, plus the existing
  owner-configured native helper. Declared optional failures retain full path,
  hash, executable, custody and reconstruction checks. Missing optional tools do
  not become ambient fallback. The fixed reviewed prefix has43 source hashes:
  CJS `73e7e891` and stock runner `8f9fff88` participate explicitly; unreviewed
  or missing CJS makes a valid image serial, while advertised tampering refuses
  admission. Optional tool presence does not itself confer concurrency. Build
  exits0,34 native image controls pass, and five focused Jest suites pass152
  checks with the actual reviewed foreign source fixture enabled. The initial
  asset-suite fixtures were deleted after success; a distinct two-suite10-check
  replay enables existing retention rather than claiming deleted bytes remain
  inspectable. Its fixtures live under `r08-parent-runtime-assets-2026-10-20/`
  with executed-to-retained mappings. Actual private installed Bash receipt
  `caws-runtime-assets-giFjzm/receipts/0005` exits0 and retains245 stdout
  bytes/SHA `aa5867880cbdb656beb8743cb46664ebf9cbb14037cb79efb51ce5334e381b19`:
  29 emoji/116 prefix bytes,1484 bytes elided and a later advisory. Receipt0006
  exits2 with the complete1544-byte protective JSON/SHA
  `57f02545cd3d585cb23691810f9bf9688debc16bc354b6ac3079d4a887221dc0`. Selected
  custom-runner Python compatibility remains exercised separately.
  Snapshot-installer tests pass2 controls; they use synthetic private installs,
  not this machine's selected runtime. Doctor exits0 with inherited0E/3W/4I;
  gates exit0 over110 committed/staged paths at `184f4cc7`, excluding the dirty
  qualifier work. No acceptance is recorded from those gates or peer feedback. A
  release build exits0 with native SHA
  `bceb6d6f5e0305c3350e6bb750a250448708651d85bce11f1cf09be2e942d9e9`. Actual
  sealed consumer, required-goal refusal, optional-tool absence branches,
  retained old full-image admission, final-binary lifecycle/legacy replay,
  installed harnesses, Python retirement and13-session fairness remain owed.
  Independent inspection finds no concrete counterexample within this source
  slice; direct checks support only the boundaries described here.

- E125: Test-only `b391829f` adds the separate intentional-unwind control.
  `unwind-focused.log` exits0 after the exact expected panic is caught; no
  synthetic cleanup receipt substitutes for execution. The retained fixture
  `unwind-focused-fixtures/renderer-backend-17660-0` records ReleaseProbe owning
  its actual worker JoinHandle before unwind, original child17707, the actual
  Drop-joined exit and worker exit with identical SHA-256
  `3dbde8b40d818115ced8867881e05f1731e502b753ed903c4c1f48fa9534e915`. Both reap
  observations retain custody, verified owned SIGKILL/reap completes, both pipes
  reach EOF, logs persist and the first fresh nofollow lock probe after catch
  succeeds with no errno. Settled evidence follows all assertions. Independent
  inspection grounds the exact previously unexercised Drop branch. This covers
  readiness-before-render unwind, not unwind during injected quarantine failure
  or installed renderer parity. A separate actual R06 replay on release native
  `bceb6d6f` passes both selected-consumer cases, retaining command/module
  identities and raw private fixtures in `r06-r08-image-native-2026-10-20/`; it
  does not promote the earlier source-bounded guard-disposition claim into
  platform refusal propagation.

- E126: Qualifier `a95004ff` strict-compiles after preserving its initial
  nullable-string compilation failure. The actual four-handler control exits0 on
  native `bceb6d6f`, with one captured caller-private grant, the reviewed
  Session prefix, one exact1883-byte turn JSON and known cleanup. Its retained
  root is `render-advisory-control-2026-10-20T10-53-59-696Z/` beneath
  `packages/caws-native/target/qualification/`. Independent readback rehashes
  all177 files/415485 bytes without mismatch, rederives the complete turn object
  from the transcript/request and correlates the grant, journal and owned
  cleanup. Actual stdout is the no-prior-lease systemMessage; this control does
  not exercise truncation or a real active-to-stopped lease transition. The
  subsequent `cut` scenario exits1 at its baseline, before any cut or goal-block
  invocation. Preserve `render-advisory-cut-2026-10-20T10-55-46-635Z/`: readback
  rehashes all193 files/444071 bytes without mismatch. Actual native child39956
  exits0; all five selected handlers complete0 and a real heartbeat emits the
  peer notice, but agent-stop emits plain `stopped advisory-self`. Final native
  stdout is exactly `{"systemMessage":"stopped advisory-self"}` plus LF; stderr
  explicitly reports that the selected control envelope cannot carry
  additionalContext. The qualifier first fails by parsing legitimate plaintext
  as JSON. Its later expectation of delivered advice is also unsupported by the
  existing Bash/typed composition and native-text contracts. Cleanup is
  confirmed inactive, custody free, socket absent and every direct child closed;
  sampled owner40013/worker40322/backend40323 are absent. No cause is attributed
  to R08's truncator or native transport. Source review locates an inherited
  producer boundary defect: agent-stop's documented lease mutation forwards a
  human CLI receipt into hook output. The next repair redirects only that
  receipt to diagnostics while retaining the actual lease operation, direct CLI
  output, incompatible-base precedence and protective decisions. New stock bytes
  require an explicit prefix-source review, pack identity and rebuilt native
  candidate. Delivered natural UTF-8 boundary cases, required-goal refusal,
  final-candidate lifecycle/legacy replay and the unchanged13-session fairness
  bar remain open.

- E127: `56a92d25` preserves the positive-delivery requirement while correcting
  plaintext extraction; its compiled extractor rejects nine malformed controls
  and still identifies E126's missing final context. The initial VM probe fails
  on a missing CommonJS binding; its correction is retained separately in
  `r08-qualifier-context-{regression,corrected-regression}.log`. Producer repair
  `39c76f51` changes only agent-stop's receipt channel, preserving its real CLI
  call, error suppression and best-effort behavior. Direct CLI human/JSON output
  and incompatible-base precedence remain unchanged. Shared pack101 has75-file
  fingerprint
  `f363028001052353a5d27dca57417f4fa637f084c742dffda95132cfab4c3344`. Explicit
  review updates only agent-stop in the fixed prefix table to source
  `c94358159f8fd77585bcb8c3679cd81c8d3d5dba0ff0970c50bf91a0f5f5eaa5`; it does
  not infer concurrency permission from a new package hash. The private
  old-source component control exits1 on the intended nonempty-stdout assertion,
  retaining actual source/receipts in `stop-producer-negative-2026-10-20/`. The
  repaired four focused suites exit0 and retain four real-CLI fixtures in
  `stop-producer-components-2026-10-20/`: self stopped, peers unchanged, receipt
  diagnostics, unchanged direct CLI output, missing/error best effort, exact
  natural advice and earlier real goal refusal. Native image checks34 and CLI
  and release builds exit0. These logs live in the E118 prefix-cohort directory.
  Release native SHA-256 is
  `43e4b13161c63c5751303783a3e564f7d8dd8171ce19b7305344169d3f0acb44`. Actual
  native control root `render-advisory-control-2026-10-20T11-18-01-578Z/` passes
  with empty stdout, receipt stderr and Session proof. Actual cut root
  `render-advisory-cut-2026-10-20T11-19-27-611Z/` passes three native
  invocations: whole natural card, budget608 with116 bytes retained/1738 elided,
  and adjacent budget616 with120 retained/1634 elided including the complete
  three-byte bullet. Each captures one actual grant, completes all five selected
  handlers, stops its real lease and renders the expected turn. The five-handler
  extension stays serial. Root and independent readback rehash the control177
  files/415931 bytes and cut334 files/782538 bytes without mismatch.
  Required-goal root `render-advisory-goal-block-2026-10-20T11-20-38-698Z/`
  passes: native28139 exits2, only the goal guard runs, full protective output
  survives budget1 and no render dispatch/outcome/turn appears. Its211
  files/416336 bytes rehash without mismatch. All three roots report known
  inactive cleanup, free custody and absent sockets. Goal refusal also emits an
  unused-relay EOF diagnostic; its broader lifecycle cause remains unqualified.
  Independent review grounds the producer boundary and raw outputs; neither
  review nor these local native outputs establish platform delivery. In
  particular, the heartbeat's PreToolUse envelope in this Stop extension may be
  unsupported by a real Stop consumer. Missing optional tools, old full-image
  admission, Python retirement, installation and fairness remain separate
  obligations. No acceptance is recorded.

- E128: Strict compilation of the lifecycle/legacy drivers exits0. On E127's
  native43e4b131, separate `normal`, `queued-cancel` and `cancel` runs exit0.
  Roots are `render-lifecycle-normal-2026-10-20T11-23-27-376Z/`,
  `render-lifecycle-queued-cancel-2026-10-20T11-25-40-365Z/` and
  `render-lifecycle-cancel-2026-10-20T11-26-47-499Z/`. Normal caller63282 writes
  the expected turn; idle project custody releases while a peer keeps host63281
  active. Queued caller81644 is actor-admitted while81471 is occupied, then
  cancels without dispatch or an Unknown fence. Dispatched caller88434 exits2
  after actual turn publication; request
  `e7a114e06cccfc4db589797ee1a8d9e6bbb9d933465d4331ea130f0bacc92a81` retains an
  accepted Unknown outcome. Its cooperative legacy probe exits75 and
  `MUST-NOT-REPLAY` remains absent. Owned cleanup records known inactivity in
  each case. These are isolated runtime observations, not deployed exclusion or
  lifecycle closure. The first restart attempt exits1 before deliberate host
  crash: the generic recursive collector stats transient
  `turn-039.json.tmp.94517` after rename and receives ENOENT. Preserve
  `render-lifecycle-host-crash-restart-2026-10-20T11-28-01-779Z/` and
  `stop-producer-lifecycle-restart-command.log`. Cleanup confirms host94210,
  worker94510 and backend94517 absent, free custody and no socket; no legacy
  replay follows the failure. Repair committed-turn collection before its next
  replay; stable artifact catalogs must retain strict failure behavior. A
  separate source audit identifies the connected missing-identity latch gap:
  with payload/environment SID absent and no own PID-cache record, the selected
  Write/Edit guard resolves unknown and skips latch lookup/strike/escalation at
  `shared/block-dangerous.sh:561`. No fresh runtime counterexample has executed.
  Current stock surface source9fb104ea also differs from the typed stock
  profile's f8d154f1, so native containment cannot be inferred from shell
  termination. Preserve real caller/PID safety; do not refresh that profile
  without its own source review and original-caller/foreign-cache/sibling tests.
  Parent scope releases broad root `scripts/` and retains its two installer
  files through CLI amendment. The separately owned rule-token lane carries one
  R20 leaf plus its exact source/test/config/dependency paths; parent retains
  the remaining R20 inventory and full migration acceptance.

- E129: `266b7476` separates flat committed-turn observation from strict
  artifact enumeration and retains registered session files only after confirmed
  inactive cleanup. Temporary renderer names are filtered before probing;
  matching-file disappearance, replacement, mutation, malformed data and capture
  overflow fail. Retention copies complete journals, envelopes and marker
  inventories with source/copy hashes and identities, refuses overwrite or
  unstable sources, and preserves an original scenario error when finalization
  also fails. Strict compile exits0. Independent review finds two ineffective
  negative controls: lone invalid UTF-8 and spaces can fail JSON parsing without
  testing their named protections. `5bb87f99` uses otherwise valid JSON,
  specific errors and an exact 1024-byte positive/1023-byte negative boundary.
  Actual compiled-helper suites exit0 with19 controls in
  `prefix-cohort-2026-10-20/collector-corrected-focused.log`; retained fixtures
  bind the helper bytes. A private copied-helper mutant changes only
  `fatal: true` to false; the UTF-8 control fails with exit1 and
  `Received function did not throw` in `collector-decoder-mutant-command.log`.
  The real helper remains unchanged. These are filesystem/collector
  observations, not native cleanup proof. E128's original four roots also retain
  complete post-cleanup session copies and expanded catalogs; initial catalogs
  remain under `catalogs/pre-session-retention.json`. Later custody does not
  recreate the failed restart's lost transient bytes or make it a host-crash
  observation.

- E130: With native43e4b131 and runtime build39c76f51 unchanged,
  qualifier266b7476 replays host-crash restart with exit0 at
  `render-lifecycle-host-crash-restart-2026-10-20T12-03-25-341Z/`. Original
  host39035 has an actual SIGKILL exit receipt; caller39037 exits75. Request
  `75f197c8e5411ffee04b5299ecf7f568fb44a9b92d75fbdf6e3fa53e9abb45fa` remains
  accepted Unknown across replacement host42537, with one dispatch and one
  worker. Fresh caller42541 has a correlated `unknown_fence` denial; separate
  caller42635 has a correlated `backend_capacity_exhausted` denial with1/1 used.
  Exit0 or absent output alone is not either denial witness. Final retained
  session inventory has133 files/236357 bytes across three sessions, including
  126 complete partial-render turns and actual journals. The first observed
  count is30; neither count fixes the exact number at signal acceptance.
  Cooperative legacy exits75 and `MUST-NOT-REPLAY` is absent in the final
  inventory. Backend39360 has direct-child reap, both pipe EOFs and no exceeded
  cleanup deadline; worker39358, backend and both hosts have separate absence
  observations, free custody and no socket. Root and independent readback
  rehash371 cataloged files/11345519 bytes without mismatch; catalog SHA is
  `b304c61a2a271937a091e05ca93564c7116fb6704f853012d2cba223afee280f`. Host crash
  does not replace E128's separate caller/queued cancellation cases.
  Native-worker fatal loss, generation replacement, power loss, platform
  delivery and installed parity remain unqualified.

- E131: Actual legacy replay exits0 on the same native/runtime build at
  `render-legacy-2026-10-20T12-05-33-405Z/`. Ten retained command exits are
  `0/75/75/75/75/0/0/0/75/0`. Twenty-eight reviewed-source comparisons match;
  actual daemon63170 matches the created Child, lease and request wire. Its
  response is deliberately withheld after a DAEMON turn exists; the actual
  client reaches inline fallback. Identical final turn hashes do not prove two
  physical writes. Unchanged inline and daemon writers demonstrably ignore
  native custody. Cooperative clients refuse under the held fence and succeed
  after release, including different-generation/home and cache-replacement
  controls. The managed-owner dependent root
  `render-legacy-managed-owner-2026-10-20T12-05-39-380Z/` retains backend63282
  alive before cooperative refusal75, unchanged artifact identity, then cleanup
  reap/EOF/absence/free custody and a successful post-cleanup attempt0. That
  dependent root is outside the two main catalogs. Root and independent readback
  rehash the legacy catalog's53 files/128698 bytes without mismatch, SHA
  `08eec037bd037cc74488ab9195299f7557b01ce5d5d5be922df9abbb97d038ce`. Historical
  legacy turn snapshots retain parsed payload plus hashes; their serialization
  check is source-derived, not independent historical raw-byte custody.
  Unmanaged daemon close is not a separate kernel/group absence receipt.
  All-writer adoption and positively established drain remain cutover
  dependencies. No deployed Sterling exclusion or full A3/A8 acceptance follows.
  The45-file pre/post identity receipts in `prefix-cohort-2026-10-20/` match
  before the separate stock-profile rebuild; they bind runtime build39, not
  later bytes.

- E132: `3862f225` restores typed stock admission for the explicitly reviewed
  agent-surface9fb104ea closure alongside f8d154f1. Its source diff at f7a5af50
  bypasses only the literal-empty override-map Python lookup; ordered source
  resolution and all other inputs retain their prior parser. The old compiled
  profile rejects current source and the focused baseline exits1 on expected
  zero executor children versus actual one. Build exits0. The first instrumented
  suite aborts134 in Node's native recursive copier on an intentional symlink
  loop; preserve `current-stock-profile-focused.log`, its exit receipt and
  `current-stock-profile-aborted-source/`. The test retention repair uses lstat
  and readlink without resolving links. The corrected suite exits0 with39 checks
  and39 retained fixtures. `current-stock-profile-artifact-readback.json`
  records both reviewed profiles' actual protective blocks, identical
  before/after Git index bytes and absent latch directories. Fresh metadata for
  modified library bytes does not grant trust: the actual executor moves from
  zero children to one shell fallback. Both profiles' containment-eligibility
  controls reject source/startup/override/event/generation/effect mismatches.
  Independent read-only Sol review finds no defect in that bounded admission
  change; source closure is also rechecked by the effect consumer. Component
  eligibility is not signal execution, fresh session binding or exclusive PID
  ownership. R32 remains blocking. A separately scheduled original-caller
  identity probe must retain actual arming, own-cache loss/contradiction,
  protective output, external Child exit, forbidden-marker absence,
  foreign-latch identity and a surviving sibling. No identity cache may choose a
  foreign session or authorize killing a shared backend. No acceptance,
  installation or fairness is recorded.

- E133: On committed candidate `a8ca545e`, `caws doctor` exits0 with inherited
  0E/3W/4I; `caws gates run --spec CAWS-NATIVE-RUNTIME-001` exits0 with all five
  policy dispositions pass over118 committed/staged paths. Canonical events
  9384–9388 bind that exact revision. Unstaged probe work is excluded; policy
  results do not establish runtime acceptance. A Sol implementation turn stops
  on an automated risk flag while preparing the R32 identity probe. The partial
  source strictly compiles in TypeScript, passes rustfmt check and compiles as a
  standalone Rust fixture, all exit0; no probe or signal executes. Independent
  source inspection identifies a real technical hold: the fixture can reap its
  native group leader before settling descendants, and its Drop treats an
  unknown wait error as an exit. PID absence and pipe EOF cannot prove engine/
  group cleanup. Consumed latch/session/generation and target correlation also
  need stronger observations; a generic QUARANTINED reason is insufficient. The
  case loop must stop on its first failed scenario. Preserve all three full
  source files, exact hashes, tracked patch, baseline and compile coordinates at
  `prefix-cohort-2026-10-20/identity-probe-held/manifest.json`. Root restores
  only this owned uncommitted prototype byte-exact to the committed baseline; no
  unqualified identity entrypoint is shipped. Before execution, retain a
  non-reaped ownership anchor through group settlement and qualify a
  leader-exit/ pipe-closing-survivor negative control. Then qualify
  original-caller arming, cache loss/contradiction, exact protective/target
  correlation, foreign-state isolation and external waits. Missing-identity
  runtime reachability and termination remain unverified; the source gap at E128
  is not a new runtime bypass demonstration. Compilation and the model's risk
  flag establish neither safety nor a safety defect by themselves.

- E134: The separately owned `native-rule-tokens` component retains one R20
  utility candidate and its Python reference at
  `~/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/native-rule-tokens/`.
  Parent reads the two37-case Node18/22 summaries and the15690-vector
  comparison; these qualify their finite Python3.11/Unicode14 reference, not
  every unpinned prior interpreter. The original Unicode-field mismatch and
  executable-symlink no-op remain retained failures. Parent inspects the
  corrected symlink and Darwin offline/no-interpreter observation records and
  exact committed bytes. Qualified candidate
  `58a65d5defac4d53410b60502f26ff114d031cb8` lands through merge
  `7ad9e509d1c0640ba667697e48d60c8e1e705f34` and closure
  `801f817cd7dfad0a674772db9f0b57258610250b`. Parent reads the closed
  component's A1/A2/A3 evidence and matching `ac_recorded` events 9400–9402,
  checks candidate ancestry and all five surviving files against main, and
  observes old Python absent on main but present in this parent lane. Exact
  readback is `prefix-cohort-2026-10-20/r20-main-landing-readback.json` under
  the native qualification root. Source landing and component acceptance do not
  establish parent integration, A4, installed behavior or retirement of the
  other eight inventoried paths. Preserve the two declared
  zero-total/update-count repairs and explicit interpreter-profile limits. The
  independent `CAWS-NATIVE-HOOK-HARVEST-001` lane owns only its original pair,
  replacement pair, strict checkJs config and maintained audit reproduction;
  parent does not edit those six paths. Its original four Python checks pass,
  while replacement qualification and committed-candidate review remain separate
  obligations.

- E135: The actual Codex parser normalizes raw `apply_patch` to Write/Edit while
  forwarding the original payload to the selected guard. On the unchanged guard,
  a private armed latch allows the raw alias silently with zero strikes. The
  repaired guard recognizes the alias from the payload; actual Add/Delete/Update
  replays emit `decision: block` and each fresh latch changes strikes 0→1.
  Inputs, stdout/stderr, before/after latch bytes and command metadata reside at
  `target/qualification/file-tool-admission-78f37cc9a4d54a5484af375613cbc23e/`
  beneath `packages/caws-native/`; the incomplete initial fixture remains at
  `file-tool-admission-385022ffd5134c11869f1a4ec5f557cb/`. All probes explicitly
  disable signals and exclude live process names. Four new Bats controls cover
  patch variants, forged Read metadata, unlatched silence and read/reset-command
  admission; four existing preservation checks pass. Reset admission does not
  execute the reset. The reviewed guard hash is
  `636f16dba6556cca02782e1df88864dafa920a35c38424afc88457a90cf57bb5`; typed
  stock admission pins those bytes. Shared pack102 and its deliberately
  recomputed fingerprint carry the template repair. The stale fingerprint
  control exits1 before the baseline update; CLI build and 39 stock plus14
  fingerprint checks exit0. Raw commands/exits and 39 retained stock fixtures
  reside under `prefix-cohort-2026-10-20/file-tool-integration-*.json` and
  `file-tool-stock-fixtures/`; an earlier green run omitted fixture retention
  and remains separately recorded as unretained. These observations establish
  protective file-tool admission in copied fixtures, not original-caller
  termination, missing-session identity, complete group cleanup, installed
  harness execution or full R32 parity. R32 remains blocking.

- E136: Production runner cleanup records actual child reap status instead of
  marking an attempt complete before stopping or reaping. The mechanically
  extracted original state reproduces false success on its second call after
  `injected cleanup refusal`; the exact regression exits101. Both failures
  remain errors with the repaired state and that exact check exits0. Six pure
  controls exercise stop refusal without reap, preserved stop/io error fields,
  retry, cached nonzero exit42 without another stop/reap, unchanged virtual500ms
  timeout and pending Absent/ExitedOnly observations. The actual Child adapter
  calls `stop_before_reap(&Child)`; successful status alone is cached. Drop
  contains one bounded best-effort pending attempt and reports unresolved
  errors. Raw commands, stdout/stderr and exits live at
  `prefix-cohort-2026-10-20/runner-cleanup-{baseline,fixed-exact,fixed-suite}.json`
  beneath the native qualification root; `runner-cleanup-baseline-source.rs`
  retains the tested original state. Fixed source hash is
  `ed03f817b929f8425e5de3a916232102a2b5e984bc1d1a42ecd4b0fda1e7ddf5`. Pure
  injected operations exercise the actual state/attempt seam, without creating
  children or sending signals. They do not demonstrate kernel refusal, real Drop
  retry, complete nonleader settlement, hard syscall deadlines or custody after
  frontend exit. A durable surviving owner and correlated engine cleanup receipt
  remain required before R32 effects or throughput scenarios; accepted SIGKILL
  plus leader reap does not establish full group cleanup.

- E137: Candidate `d69f49561f647e58cb49450c0a770bbaf6dc50a0` contains the
  separate guard (`3352b9a4`) and retryable cleanup (`d69f4956`) commits.
  Installed CLI12.2.0-rc.2 runs `caws doctor` and the five declared gates with
  exit0 on the exact candidate; doctor retains inherited 0E/3W/4I and gates
  evaluate120 committed/staged paths. Full command/output and basis identity
  reside at `prefix-cohort-2026-10-20/cohort-candidate-checks-d69f4956.json`.
  Commit commands exit0 while lint-staged emits its existing ignored
  `docs/internal` restaging failure; this is not an all-hook-tasks-green claim.
  No parent acceptance is recorded and the machine runtime remains unchanged.
  Independent source inspection locates Node creation in
  `runner::Session::start`, before `main::execute` admits a render offer after
  Ready. The new custodian must create and retain the original Child;
  registering its PID or passing descriptors later cannot transfer parent wait
  authority. Existing renderer ownership is reusable prior art, not a
  prerequisite to private per-invocation custody.

- E138: The non-reaping `owned_group::settlement_before_reap(&Child)` primitive
  distinguishes a running leader, positive live-member observation and a
  complete all-zombie group. Fresh exited WNOWAIT observations bracket the
  strict Darwin SDK query; the shared complete-snapshot predicate preserves the
  existing EPERM stop conditions. Unsupported platforms,
  query/credential/incomplete snapshots and lost ownership stay unknown with
  original observations and errors retained. All18 injected module checks pass,
  including nine existing stop controls; `owned-group-settlement-pure.json`
  retains the actual command, raw output and source identities under
  `prefix-cohort-2026-10-20/`. Root inspects the production seam, hostile
  controls and raw output; strict library/binary Clippy exits0
  (`owned-group-settlement-clippy.json`). No actual Child, SDK query, signal or
  reap executes in these checks. The primitive has no production consumer yet
  and does not establish full engine cleanup or custody; connecting it to the
  custodian is the next required consumer boundary.

- E139: Reorientation reads all96 retained CAWS turn records and the exact
  current-session transcript's64 user-message records, including later latch
  reset, cancellation/restart/legacy-writer requests and goal edits. The CAWS
  helper elides long user text and misses later modern records; direct retained
  transcript inspection supplies those original messages, rather than treating
  the digest as complete. The image-fragment/null turns retain the thirteen-
  session/four-repository obligation; they do not cancel it. The original full
  replacement, documentation after source landing, guard strength, artifact
  proof and cutover-after-parity requirements remain unchanged. Source artifacts
  are `reorient-all-caws-records.txt` and `reorient-user-messages.jsonl` under
  the same qualification root. An initial event-type filter returned no messages
  (`reorient-user-events.jsonl`); correcting the filter to actual user
  `response_item` records finds64, without changing the skill or transcript. The
  user adds peer `01a15984-840d-7301-a25a-7e681fd83b29`; root verifies that
  peer's initial human coordination instruction and retains parent single-writer
  integration/acceptance. Its source investigation identifies process-global
  entry streams/signals/exit state, fixed FD3/4/5 and existing direct-child
  cancellation as barriers to concurrent warm reuse. `prepareRuntimeInvocation`
  already constructs fresh request state; an extracted entry function or idle
  daemon alone does not close the complete consumer/cleanup boundary. No shared
  engine edit or new runtime scenario follows from those source observations.

- E140: Additional peer `01a15984-840d-7301-a25a-7e681fd83b29` binds the
  independent `native-sensitivity` lane to `CAWS-NATIVE-SENSITIVITY-001` after
  root verifies no parent scope match for its original script. Its five paths
  cover the Python orchestrator, typed replacement/test/config and maintained
  audit caller; Python production regression executables remain R21 obligations.
  Its first synthetic check fails because the fixture detects a mutant substring
  inside the unchanged control; execution stops before typing/differentials.
  That fixture failure is not a production mutant kill. Root grounds the peer's
  separate residency findings in the actual fixed descriptor admission, WeakMap
  consumption/disposal and `detached:false` direct-child kill path. Sequential
  reuse also needs fresh capabilities and settled descendants; process-global
  descriptors cannot be renewed merely by sending fresh JSON. An uncertain
  worker rejects new work while its native custodian retains actual
  Child/custody; retirement must not discard unresolved ownership. Parent also
  reads the hook-harvest candidate's actual Node18/22 report bytes,
  original/reference command records, executable-link output, unchanged source
  state and excluded-payload read observer. Source merge remains held on a
  concrete inherited question: `git -C` status reads consumer configuration,
  potentially executing a configured fsmonitor helper despite the report's
  no-hook-execution claim. A private harmless sentinel probe is authorized; no
  production execution or resolution follows from source suspicion alone.

- E141: Reorientation against the retained user messages, tracker and live
  `CAWS-NATIVE-RUNTIME-001` binding preserves the full Rust/typed Node
  replacement, thirteen sessions/four repositories, PID safety, documentation
  after source landing and installation after full parity. The active parent
  lane is owned; untracked custody sources are implementation work, not
  inherited completion. Root reads the hook-harvest fsmonitor observation
  directly: direct Git exits0 and writes one sentinel line; both original Python
  and candidate Node exit0 and write three. `core.hooksPath=/dev/null` does not
  suppress this configured monitor. The raw observation is under peer
  `01a157bd`'s `native-hook-harvest/fsmonitor-contract-probe/observation.json`;
  component A1 is failed and source integration held while its owner hardens Git
  admission. Root also reads sensitivity's
  `018-review-counterexamples-driver-repair/` stdout and command record: both
  output directories exist under different symlink/parent resolutions, and
  unrelated setup AssertionError plus echoed expected source is counted as a
  kill by both predicates. The bounded driver exits0 to report those
  counterexamples, not successful component behavior. Peer repairs require exact
  candidate/source/raw-output readback before acceptance or integration. Neither
  tooling component supplies native proof.

- E142: The macOS binary dispatches a private inherited-descriptor custodian
  before frontend cancellation setup. The custodian creates Node in a private
  group and retains that original Child independently of frontend lifetime;
  original caller capture, request PID and native effects remain in the
  frontend. Node receives the existing optional FD3/4/5 render capabilities;
  private configuration, journal and liveness descriptors are close-on-exec. The
  parent correlates an append-only bounded journal to its actual custodian
  Child, rejects changed prefixes, invalid terminal rows and abnormal cached
  custodian exits, and requires successful custodian exit after publication.
  Normal stdin EOF is separate from private liveness EOF. Bounded queues retain
  opaque bytes; cleanup keeps stop, complete group settlement, actual reap and
  both EOF separate. Failed attempts retain ownership with explicit retry;
  cached reap forbids later signals. Persistent HUP is removed from poll
  sources. Pure checks exit0 and strict Clippy with binary/tests exits0. Raw
  output is in `engine-custody-{pure-initial,checks}.json` under the E118
  qualification root; initial Clippy failures are separately retained.
  Successful pure fixture files are removed by their normal Drop, not
  represented as retained runtime state. The original relative artifact
  redirection is refused by the installed guard; no test runs from that command.
  Absolute source/target invocation subsequently executes; relative scope check
  admits the owned artifact path. These checks use fake cleanup operations and
  local files/socket descriptors; no Node, actual Child, SDK settlement, signal
  or reap runs in them. The old invocation fixture assumes a direct
  Node/frontend parent relationship and requires independent topology
  qualification before reuse with this path. Actual frontend-death survival,
  descriptor leak observations, renderer replay, performance and full migration
  acceptance remain open. Custodian SIGKILL, escaped groups and other platforms
  are not qualified. A terminal fsync failure resumes the same record until
  durable; its transient failure cannot be written behind that terminal line, so
  complete failure-history instrumentation remains a gap. Private temporary
  receipts are diagnostic cache, not crash recovery or authority. No machine
  installation or parent AC is recorded.

- E143: Custody source candidate `73c1dada` is committed; doctor exits0 with
  inherited0E/3W/4I and five policy gates pass over124 named committed/staged
  paths (`engine-custody-candidate-gates.json`). A fresh read-only Sol inspects
  the committed producer, worker, frontend consumer and raw pure checks. Its
  socket-alias question is bounded by the actual producer: Owner creates
  separate control and render-bank socket pairs. Numeric-slot validation does
  not independently prove distinct socket descriptions; actual descriptor-leak
  qualification remains owed. The qualifier adds one explicitly invoked
  pre-Ready frontend-death scenario and a Node fixture that stays alive after
  original hook-input EOF. Its surviving external driver retains the original
  frontend Child; only that Child authorizes its stop. File-discovered PIDs
  authorize observations only. The observer preserves raw topology, private
  configuration/journal copies, produced-byte mirrors and executable/source
  identities, with separate EOF, actual Node exit and strict SDK settlement
  expectations. Unknown receipt states and failed observations stop the chain.
  Compilation without execution, strict qualifier Clippy and JS syntax checks
  exit0. These are source/check observations, not frontend-death proof.
  Custodian raw exit status and post-death fsync completion are unavailable to
  this observer; no-running process observations cannot establish either one.
  The test also excludes descriptor leakage, renderer behavior, escaped groups,
  exact proxy delivery and complete parity. It does not replace the old
  invocation fixture or silently relax its direct-parent assertion. Parent
  directly reads sensitivity candidate `70f1f496`, matches its clean
  source/test/config hashes to executed030/031 bytes and inspects the actual
  CPython3.9/3.11 and Node18/22 fixture matrices plus raw selected/subtest and
  hostile setUp tracebacks. The bounded orchestrator qualifies; six production
  mutation tests and R21 do not. Component evidence/ordinary merge are released
  to that lane's owner, pending canonical readback; no parent AC or installation
  follows. The hook-harvest parser's later argv discrepancies remain held in its
  separate component, alongside its intentional Git-admission repair.

- E144: The committed qualifier review identifies an output-close race before
  any live probe: frontend death between a control read and queued stderr write
  can produce EPIPE before liveness EOF. Requiring only `frontend_gone` and
  rejecting that expected transport error would fail legitimate cleanup.
  Receipts retain raw `frontend_output_errno`; the oracle admits only the
  corresponding frontend-output EPIPE and separately rejects stop/settlement
  errors, malformed result encodings, unknown states and state regression. Other
  transport errors and reap failures remain failures. The pure race control,28
  custody controls and strict binary/test Clippy exit0; raw command output is
  `engine-custody-output-close-checks.json`. These checks do not observe the
  live race or execute Node/kernel cleanup. Root reads the closed sensitivity
  spec and matching `ac_recorded` events 9464/9465/9467, source merge `922fec1b`
  and closure `204a5796`. Main's four surviving file hashes match candidate
  `70f1f496`; `git ls-tree` contains its Node executable and omits the original
  Python script. This discharges the bounded component's source landing, not
  parent branch integration, R21 or runtime acceptance. Full raw postmerge
  custody remains under that peer's
  `native-sensitivity/postmerge-readback.json`. The inherited ignored-tracker
  precommit restaging failure reaches these commits' verification path and is
  under source/effective-hook investigation; prior occurrence does not resolve
  it. Explicit formatter, compiler and policy checks remain separately cited.

- E145: Explicit Cargo execution of
  `original_frontend_death_before_ready_settles_same_engine --ignored --exact --nocapture`
  exits0 on candidate `e1fc9811`. Full command/output is retained in
  `prefix-cohort-2026-10-20/engine-custody-live-command.json`; the scenario root
  is
  `target/qualification/engine-custody-live/engine-custody-49456-1792509980133139000/`
  under `packages/caws-native/`. The external driver retains the original
  frontend Child50204 and observes its SIGKILL/reap. Before-death observations
  identify custodian50799 as its child and Node50802 as the custodian's child,
  with separate groups. Correlated `cleanup.jsonl` rows progress from started
  through pending `LeaderRunning` to complete `Exited`: SDK reason0/errno0, one
  zombie leader, actual Node raw exit9, both EOFs true, stdout0/stderr37, no
  cleanup error. Final `after-001.status.json` records `/bin/ps` exit0;
  `after-001.stdout` has no frontend/custodian/Node PID or Node-group member.
  `observer-complete.json` separately records that absence. Produced stderr
  mirror contains `custody fixture waiting before Ready\n`; frontend stdout and
  stderr files are empty, so produced bytes do not establish proxy delivery.
  Actual native debug SHA256 is `0107f86d…295d`; historical native43 is
  unchanged. This is one deliberately non-Ready protocol fixture, not production
  renderer execution or complete PID-guard parity. It does not establish
  custodian exit status after reparenting, post-death fsync completion,
  descriptor leak exclusion, nonleader/closed-pipe settlement,
  after-Ready/dispatch cancellation, escaped groups, other platforms, warm
  speed, fairness, installation or parent ACs. No automatic scenario chain
  follows this result.

- E146: The tracker formatting failure reaches the actual commit verification
  path. Baseline complete-hook fixture exits0 while leaving the staged and
  worktree table unformatted; its retained hook output records ignored-path
  restaging failure. The new semantic assertion fails with Jest exit1, rather
  than accepting the hook's exit0. `.gitignore` admits exactly this
  authoritative tracker while neighboring internal scratch remains excluded.
  Repaired full focused execution exits0:
  `formatting-internal-tracker/report.json` retains identical formatted
  worktree/index bytes, and scratch remains unformatted, ignored and absent from
  the index. `formatting-invalid-json-control/report.json` records complete-hook
  exit1, SyntaxError and BLOCKED output with the malformed index/worktree bytes
  preserved. Raw artifacts are under
  `prefix-cohort-2026-10-20/tracker-format-{baseline,repaired}/`. The real JSON
  fence is explicitly lifted for that disposable negative control so skipping
  cannot masquerade as refusal. The observed dependency is installed lint-staged
  15.5.2/Node22, not the package's pinned16.4.0; no pinned-version qualification
  or generic restaging-error repair follows. Current tracked ignored paths are
  `package-lock.json` and archived legacy registry bytes; neither is part of
  this owned change. The remaining generic false-success risk remains an
  installation and candidate-verification obligation, not dismissed by baseline
  attribution. The first transcript-cache wrapper is refused before execution:
  the installed shell guard attributes an interpreter read/exec path to writes
  into Homebrew. Raw refusal is peer `01a15984`'s
  `native-transcript-cache/blocked-launch.json`. Root retains that R19
  recognizer dependency; no guard bypass, reprieve or installed-runtime edit is
  authorized by that diagnostic. E147 retains the separately adjudicated direct
  launch and its bounded counterexample.

- E147: Reorientation reads the complete available CAWS history and the actual
  Codex user messages omitted by its narrow turn digest, including the reset,
  renderer, live cancellation/restart, legacy-writer
  and13-session/four-repository instructions. None is canceled by later peer
  coordination. Fresh CAWS reads retain the active parent binding and original
  lane owner. Source inspection identifies stale ordinary engine, terminal
  fixture and renderer qualifier topology assumptions (`engine.cjs:111/129`,
  `terminal-engine.cjs:22`, `qualify-render-owner.ts:328–330`). Node's parent is
  the custodian, while the request's caller remains the original frontend. One
  proposal fixture would select the custodian as the protected native self if
  only the first assertion were relaxed. The required correction is an
  independent original-Child PID observation plus the precise named
  frontend/custodian/Node chain; retain existing refusal, ancestry and
  group-witness assertions. Two bounded Sol assignments return patches for the
  ordinary fixture/invoke evidence and renderer qualifier respectively; root
  owns application, checks and Git. Terminal-fixture follow-through remains a
  separate named dependency. The revised cache diagnostic uses the original
  explicitly named interpreter, `-I -B -S`, a stripped environment/private Git
  configuration, trace suppression and private output destinations through the
  normal guard. It exits0 with `counterexample_observed: true`. Root reads the
  complete `native-transcript-cache/001-surface-context/observation.json` under
  peer `01a15984`'s retained artifact root: identical185-byte transcript/hash,
  unchanged renderer/harness snapshots and eight loaded snapshot origins; all
  seven controls pass. Cached/fresh events match on cold and repeated Claude
  parses. After the surface changes to OpenCode, cached `source_harness` remains
  `claude` while fresh is `opencode`, with all other event fields equal; a fresh
  cache fixes that divergence. This is an R18 renderer interpretation-context
  defect with normalization dependencies, not R08 truncation or proof that the
  installed daemon actually shares caches across surfaces. The observer's exit0
  reports the counterexample, not migration success. R18's replacement must bind
  every interpretation input or partition owners positively. No native render,
  installed cross-surface reach, concurrent mutation or repair is established.

- E148: Root verifies hook-harvest candidate `9b2f05a9` against raw Node18/22
  argument and Git-effect controls, including actual positive sentinel/trace
  bytes followed by absent effects or pre-effect refusals. It independently
  compares every semantic differential report's full JSON after removing exactly
  the two declared limit additions; all compared values match retained Python.
  Latest component A1/A2/A3 match `ac_recorded`9498/9499/9500. Ordinary governed
  merge `ddab8705` and closure `b84a595d` are on main; the canonical spec is
  closed completed, with `spec_closed`9515 naming that merge. Root compares all
  four surviving main files byte-for-byte with the candidate and confirms both
  original Python paths absent in `git ls-tree`. Raw postmerge custody is peer
  `01a157bd`'s `native-hook-harvest/postmerge-readback.json`. This is the third
  landed R20 leaf; five of the nine original developer-tool paths remain. Parent
  branch integration is not performed by source landing. Stable trusted
  Git>=2.45 inputs, finite argv coverage and the explicit admission/exclusion
  limits remain; no sandbox, atomicity, transient-write, native or installation
  claim follows. Root also reads the closed documentation component, matching
  event9497 and closure9501/merge `d0e5647a`; main audit SHA256 `86594bf5…beef8`
  matches its source-bound candidate. Projection replacement, separate receipt
  publication and unobserved WAL/SHM/crash durability remain distinct. Tracker
  repair candidate `75888f38` receives fresh read-only Sol inspection against
  the actual retained bytes; no coordinate-bound concern changes the bounded
  repair. Its real commit hook completes modification application; all three
  committed/index/worktree byte identities match, focused checks exit0, and five
  policy gates pass over128 named committed paths. Doctor retains 0E/3W/4I. Full
  raw candidate/commit output is
  `prefix-cohort-2026-10-20/tracker-format-committed-candidate.json`.

- E149: The in-flight topology patches preserve the original frontend's request
  PID and record the actual retained frontend Child before input delivery. The
  ordinary fixture requires the named macOS custodian and selected Node in
  distinct groups from one bounded `/bin/ps` snapshot. Canonical descriptor
  range32..1048576 mirrors native admission. Its native-self proposal uses the
  original caller PID. Two initial boundary controls compare a command field to
  a complete ps row and fail; root corrects that oracle to compare command bytes
  and separately retain the complete row. All32 pure controls then exit0. The
  initial explicit rustfmt edition2021 is rejected on existing2024 let chains;
  package edition2024 formatting/check exits0. Failures remain in
  `prefix-cohort-2026-10-20/topology-checkpoint-command.json`. Actual ordinary
  invocation exits0 at the test runner, without changing its 2000ms budget.
  Retained scenario
  `target/qualification/topology-ordinary-live/caws-native-99644-0/` under
  `packages/caws-native` contains `call-1/original-child.json` PID99814,
  `topology.jsonl` frontend99814→custodian138→Node143 and groups98373/138/143.
  Snapshot query exits0 without diagnostics. Native output is the expected exit7
  with stdout hex `6e61746976650ae99baa006578616374` and stderr
  `diagnostic\nexact\n`, retained in `call-1/`; elapsed604ms. Subsequent
  `after-exact.stdout` is a successful raw `/bin/ps` query with no matching PID
  or Node-group member. Actual native debug hash remains `0107f86d…295d`. Root's
  first readback assumes `call-0` and fails ENOENT; discovery of the actual sole
  call directory supplies the cited readback rather than repeating runtime. The
  renderer qualifier selects a named chain from one inventory, reobserves
  precise birth/ancestry/group values before and after, and retains the witness
  and original frontend observation. Strict TypeScript compile exits0 and39 pure
  topology controls exit0. These are trusted-fixture ps argv observations, not
  kernel executable identity or argv-spoof defense. The group-witness set
  remains cumulative. Independent source inspection identifies a consequential
  gap: a prior request's confirmed group can satisfy the nonempty-set check
  while a later request never confirms its chain, leaving that later group's
  cleanup unobserved. Incoming coordinator explicitly accepts the request-local
  witness repair and two-invocation missing-chain/live-group falsifier before
  any renderer scenario. Source chain evidence is not independently correlated
  with the original custodian Child receipt's Node PID. No actual renderer
  qualifier executes on this patch. Ordinary protocol-fixture success does not
  establish production typed-engine or renderer parity. Live
  held-self/hostile/terminal replay, bounded pipe-join watchdog qualification
  and committed-candidate topology review remain accepted work of incoming
  coordinator `01a15a2a`, alongside full parent obligations.

- E150: Root inspects the completed harmless replay diagnostic under peer
  `01a15984`'s `native-replay-boundary/001-import-observation/`. Worker/outer
  exit0 records a counterexample: `import-effect.txt` contains
  `import executed\n`, while later invocation and captured-command sentinels
  remain absent and the worker row reports `execution_attempt_refused`,
  operation `file write`. Original and executed replay snapshot hashes match
  `6a62c0fc…60d0`; metadata Git observation exits0 with bounded timing and
  retained raw streams. The initialized classifier executes before the existing
  audit boundary. This is one controlled private initialization effect, not
  historical command execution, an arbitrary-module sandbox audit or R21
  replacement. Stock fresh-process parsing and the selected fixed Codex renderer
  profile do not establish the cross-surface reuse needed to reach E147's cache
  defect in ordinary execution. Both observations remain requirements for
  explicit typed interpretation and selected-classifier custody contracts.
  Incoming coordinator accepts the full remaining goal and the named unfinished
  topology checks. The bound owner freezes after the source checkpoint, retains
  raw artifacts and does not start another lane or scenario. Supported registry
  ownership transfer, parent/main integration, independent review and all A1–A8
  acceptance remain separate.

- E151: User-authorized takeover records the receiving session `01a15a2a` as
  owner of the active parent lane in `claim_taken_over`9542; root reads the
  registry, prior-owner audit and scope admission before writing. The outgoing
  owner freezes clean `2489f014` with no owned runtime handle outstanding. Three
  read-only Sol investigations trace remaining residency, packaging and Python
  consumer boundaries. The resident renderer host does not execute the typed
  hook engine; request-owned subprocess ports, fresh Stop descriptors, policy
  reselection and mandatory-prefix admission remain prerequisites. Installation
  selects Python, and no typed transcript renderer or harness adapters exist in
  this candidate. Those observations establish dependencies, not acceptance.
  Ordinary merge `6b2bb962` incorporates main `7c6d1b00` without conflicts or
  dirty source, including the three accepted R20 leaves and publication audit.
  Raw command, before/after revisions and status are retained in
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/parent-integration/merge-main.json`.
  Parent integration preserves original leaf evidence and does not repeat or
  enlarge its runtime conclusions.

  The required strict-kernel compilation is independently reproduced at exit2
  with TS2339 on the absent `usage.required` schema property. Component
  `CAWS-RUNTIME-TYPECHECK-001` changes only its absence assertion, candidate
  `69e54a53`, source merge `7a45dfe6`. Strict kernel and CLI compilation exit0;
  the focused schema suite executes39 checks at exit0. The actual transpiled
  assertion passes the original schema and fails after an in-memory
  `required=[input_tokens]` mutation. Committed test/schema hashes match the
  inspected artifacts; production schema bytes are unchanged. Raw commands,
  outputs, initial Jest working-directory failure and mutation results remain
  under that session's `kernel-typecheck/` artifact directory. The component is
  reopened after rejected absolute/untracked artifact citations; A1/A2 pass are
  read back on the spec and `ac_recorded`9538/9539 before reclosure. Citation
  verification establishes commit reachability only; behavioral adjudication
  uses the inspected outputs. Generated receipts remain untracked. The source
  repair and closed component are integrated here; package-wide migration
  checks, native parity and machine cutover remain separate.

- E152: A bounded Sol implementation replaces cumulative renderer-qualifier
  group coverage with one record per actual frontend invocation. Original
  frontend birth, confirmed chains and observed descendants stay with that
  request; global process discovery cannot supply another request's coverage.
  Both per-request continuation and final cleanup require complete current
  coverage. Strict TypeScript compilation exits0 and43 pure checks exit0. Root
  inspects the exact source, source hashes and raw outputs under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/request-coverage/`.
  The actual emitted cleanup predicate returns `confirmed_inactive` for the
  first confirmed/absent request, then `unknown` with `coverageComplete:false`
  for a later unconfirmed request, both with a live unknown group and with an
  empty inventory. Concrete outputs are retained in
  `two-request-counterexample.json`; these inputs and observations are pure
  fixtures, not OS cleanup. The original pre-execution nested-runner refusal is
  retained; directly inspectable compiler/test commands execute through normal
  guards. No runtime scenario or signal is issued by this repair. Independent
  custody-receipt correlation and actual selected-renderer execution remain
  obligations; source-chain coverage alone does not establish the original Node
  Child's identity.

- E153: The terminal protocol fixture reads the original frontend PID written by
  the actual retained native Child's owner before input delivery; Node's parent
  remains an observation, not caller identity. A Sol patch also replaces
  `execute()`'s unbounded writer/output thread joins with nonblocking collection
  and a bounded original-Child watchdog. Child status, stdin terminal state,
  both EOFs and partial bytes are separate observations, published before
  failure. The bounded collector lives in `tests/invoke/collector.rs` rather
  than expanding the invocation fixture's responsibilities. A dynamically
  unconfined shell write is refused before execution; root applies the reviewed
  patch through explicit scoped file edits. No guard, reprieve or installed
  runtime changes are made.

  Two selected Cargo collector controls exit0. Actual retained bytes
  `raw\0partial` have EOF false and deadline outcome unknown while either pipe
  is held; after closure the same bytes have EOF true and the collection
  predicate accepts. Injected read failure preserves its prefix and error;
  continuous output yields after16 reads and cannot mask an unsettled deadline.
  The actual ordinary native fixture and native-self refusal/control replay each
  exit0 at their test runners. Raw per-call `status.json` records native exit7
  or2, child reaped, both EOFs and no collector failure. The unsafe-self handoff
  retains `held / unsafe-target`, exact refusal output and successful local
  handoff with no signal. These are protocol fixtures, not selected guard
  policy.

  The terminal effect test exits0 in5.59s across close-after-prefix, full-unread
  and post-effect-stall. Original frontend/caller PIDs1348/2538/3803 differ from
  observed Node parents1682/2613/3875. Intended sacrificial callers
  616/2534/3796 have actual wait signal15; matching handoff receipts record
  `signal-accepted`. Local output success is false/false/true independently.
  Sibling heartbeat lengths advance1→53,1→40 and1→17 before external fixture
  cleanup. Exact command/output and the unchanged native debug SHA256
  `0107f86dd924bc97806924916375cee1e1530bd78b7728472dede790c23f295d` are
  retained under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/native-collector/`.
  `terminal-effect-replay.json` names the scenario root and all three modes;
  each retains wire identity, caller status, sibling progress and cleanup
  observations. This closes the stale terminal-parent oracle and the identified
  `execute()` join gap within these controls. It does not qualify every harness
  helper, full production latch/PID policy, missing-session/reset behavior,
  renderer custody correlation, residency, fairness or installation.

- E154: Committed parent `36c1cd1bca6321e0ec3593a17e73172a2cb4844b` passes
  strict CLI/runtime and kernel-test compilation through the workspace
  TypeScript installation. Each compiler exits0 without diagnostics. Initial
  attempts use the nonexistent package-local compiler path and exit1 before
  compilation; those launch failures are retained separately. Compilation
  establishes type compatibility after integration of E151's schema assertion
  repair, not runtime behavior. Doctor exits0 with0E/3W/4I; its installed-pack
  lag and ambiguous body-drift findings remain dependencies of the eventual
  selected baseline review and adoption. The five policy gates pass against134
  committed branch paths, with merge base `7c6d1b00` and observed main
  `c6791c70`. Exact commands, revisions, raw stdout/stderr, statuses and gate
  change basis live under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/parent-integrated-checks/`.

  Direct source inspection confirms that continuation and final cleanup both
  consume request-local coverage. The collector controls do not execute the
  complete watchdog failure-to-cleanup branch. Original-Child receipt
  correlation remains required before using the topology qualifier as integrated
  renderer-cleanup evidence. The installed Codex registration selects Python
  `caws-hook`, with45s pre-tool and60s post-tool limits. No installation,
  complete parity, production latch, renderer, fairness or speed result follows
  from these checks; parent A1–A8 acceptance remains open.

- E155: The renderer qualifier joins its current birth-confirmed frontend,
  custodian and Node chain with native configuration and custody receipts. Each
  invocation receives a dedicated retained private TMPDIR. Its independent typed
  journal binds invocation ID, runtime digest and exact input digest; matching
  configuration binds selected Node/engine paths. Native receipt PIDs, monotonic
  journal state, actual reap, both EOFs and strict SDK terminal settlement must
  agree. Request-local process/group absence remains a separate required
  observation. Discovery names and mtimes confer no ownership, and no PID
  discovered by the qualifier gains signal authority.

  Strict compilation and56 focused parser/file cases exit0. Controls reject a
  prior invocation, mismatched identity/selection/PIDs, missing chain, partial
  or rewritten journals, regressing counters/EOF, post-terminal records, missing
  reap and incomplete/live SDK settlement. Actual private-file controls inspect
  snapshot bytes/hash/inode and reject links, wrong modes, replacement inodes
  and oversized files. Leading UTF-8 BOM refusal is aligned with native JSON
  decoding; the preceding55-case pass is retained separately. Raw commands,
  source hashes, compiler output and final `helper-tests-bom.stdout` live under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/request-custody/`.

  Reusing the runtime JSON parser changes TypeScript's emitted directory root.
  The render-build command declares that root and its four consumers select
  `qualification-tools/scripts/qualify-render-*.js`; compilation and actual
  emitted entrypoint identities are checked. The CLI and native debug build
  exit0. Native SHA256
  `0bf590321e05f26d339e756ab711bbeb13f8f10b25766c09370f62cca3b7fd0f` differs
  from E153's build artifact. Its ordinary protocol control exits0: original
  Child1442 exits7, both EOFs are true, all73 input bytes are written, and
  exact16-byte Unicode/NUL stdout is retained. Preparation commands, executable
  hashes and raw scenario files live under the external
  `selected-renderer-preparation/` directory adjacent to `request-custody/`. A
  combined sibling-read/external-receipt-write command is refused before
  execution; no Sterling file changes. The earlier read-only comparison matches
  all28 reviewed source pins. These controls qualify observation mechanics and
  preparation, not an actual selected-renderer run, installation, complete
  runtime parity, production containment or resident fairness.

- E156: Committed candidate `bc9f86997520c53997440c1f6499e0bcaa3393d1` executes
  the actual typed engine and selected copied Sterling renderer through the full
  ordered Stop dispatcher. Command:
  `node packages/caws-native/target/qualification-tools/scripts/qualify-render-owner.js packages/caws-cli /Users/darianrosebrook/Desktop/Projects/sterling debug`
  exits0. Cold, appended and unchanged requests all exit0. Their retained
  frontend/custodian/Node chains are2359→2730→2737, 19139→19209→19217
  and31841→31871→31876. Each independent typed journal, configuration and native
  receipt agrees on current request identity and selection. All three receipts
  record actual child exit0, both EOFs, successful exited-group settlement and
  no error; independent current-instance/group observations confirm absence
  before continuation.

  One renderer backend, PID7092 with the same observed birth, serves1/2/3;
  returned cache flags are false/false/true. Produced turns contain exact
  user/tool/assistant timelines, and each stock lease finishes stopped. The two
  final turn files each have1764 bytes and match the unchanged copied renderer's
  baseline byte for byte. Final cleanup records no active processes/workers, no
  socket and a free custody lock. The run reports no failures or evidence gaps.
  All277 files,3968401 bytes, are copied with matching per-file hashes to
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/selected-renderer-run/`;
  adjacent `selected-renderer-transfer.json` retains the source/destination map
  and manifest hash. Sandbox and original artifacts remain retained.

  A source-grounded counterexample separately demonstrates that the qualifier
  accepts SDK member/zombie counts of4294967296, which Rust's u32 fields cannot
  deserialize. The decoder bounds member/zombie/leader counts to u32. Strict
  compilation and57 focused controls exit0, including maximum-valid and
  oversized SDK counters. Offline replay of all three actual receipts accepts
  each original and refuses its oversized-count mutation. This is corrected
  decoder replay of the `bc9f8699` runtime evidence, not a rerun of the
  scenario. Raw before/after observations and checks live under external
  `request-custody/u32-correction/` and `u32-counterexample-before.json`.

  This establishes the isolated ordinary renderer/custody chain for the named
  source profile and candidate, while retaining the selected Python renderer. It
  does not establish full Python retirement, production latch parity,
  frontend-death phases, cancellation/restart, legacy-writer exclusion, complete
  resident-engine integration, fairness, latency improvement or machine cutover.

- E157: Parent merge `3b2f22ca99bd5cd2dd594d187d4903b706f476ec` integrates the
  twelve transcript-foundation source/test files from component candidate
  `cdd74dcd7d2c3d4cd3784e18460244ac190a7145`, landed through `e180a1bd`. The
  bounded API retains lossless numeric lexemes, ordered source occurrences,
  explicit interpretation context and clone-owned tentative transactions. Its
  standalone strict compilation and52 Node cases exit0 on Node18.0 and22.19.
  This is foundation evidence, not a production renderer/cache consumer.

  Ordinary package Jest selection reaches a new bridge that compiles into a
  unique temporary directory, discovers compiled test files, and requires both a
  positive test count and positive passed count. Compiler/test children have
  separate30s deadlines with direct-child SIGKILL; error, signal, null/nonzero
  status and cleanup failure remain failures.
  `npm test -- --runInBand --runTestsByPath tests/transcripts/foundation.test.js`
  exits0 through build, selected Jest and package cleanup on Node22.19. Package
  `npm run typecheck` includes the standalone strict config with `--noEmit` and
  exits0; scoped ESLint exits0. The Node child cases are not additional Jest
  coverage.

  External controls execute the actual bridge callback and loader against real
  compiled fixtures. Fifteen controls exit0: semantic success, compiler and
  assertion failure, later-load failure, future-file discovery, no compiled
  tests, zero tests, all skipped, injected signal/spawn/null/nonzero results,
  cleanup-only and combined failures, and an actual hung child killed at30s.
  Recorded temporary outputs are absent afterward. The first driver attempt
  fails because its fixture omits `esModuleInterop`; its raw failure is retained
  separately. Node18.0 directly executes the actual bridge callback, compiler
  and52 cases successfully. Its ordinary Jest launch fails during configuration
  loading before the bridge; installed Jest dependencies declare Node>=18.14.
  This does not establish ordinary Jest compatibility on18.0.

  Raw commands, stdout/stderr, controls, source hashes and execution metadata
  live under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/transcript-integration/`.
  The foundation retains five explicitly incomplete reference cases across four
  Unicode classes: non-Latin1 Python repr, named Unicode literal escapes,
  non-ASCII code identifiers and adjacent Python surrogate codepoints. Those
  cases, other harness adapters, persistence, complete rendering and installed
  Python retirement remain open. No parent AC is earned by test admission.

- E158: Read-only investigation after `8fdfa9e1` reopens E118's retained
  `workload.json` and `owner-stage-timing-observations.json`. Root readback
  confirms that peer queue arrivals occur at owner elapsed8982/9039/9170ms,
  after the hot outcome recorded by E118. Peer bridge-read intervals are
  7877/8004/8405ms; their whole calls take15146–15574ms. The retained failed
  workload does not demonstrate contention between peer offers and the hot
  renderer effect, nor isolate CPU/import/Git/filesystem costs within the
  compatibility prefix. It cannot establish that a resident launcher alone is
  necessary or sufficient for the unchanged fairness oracle.

  Current `stock-handlers.ts` admits only dangerous-command and utility stock
  consumers; `agent-heartbeat.sh` falls through to compatibility execution. Its
  complete406-line consumer includes leases, peer change/rate state,
  critical-message polling, drain-five offers, dead-letter telemetry and one
  merged context. A typed consumer can reuse canonical application operations
  through the existing selected-handler dispatch. Importing the CLI command
  unchanged would retain process/global assumptions, including
  `buildLeaseContext` assigning `hook_pid: process.pid`. Any shared application
  extraction needs explicit request context and exact offer settlement at output
  handoff. This is a concrete production integration candidate, not an
  implemented consumer or an attributed fairness repair.

  One-shot custody permits bounded consumer replacements before shared-module
  reuse. Reuse additionally requires request-owned ports for context Git,
  classifier Git, utilities, compatibility handlers and containment lookup,
  including each Stop request's actual descriptors. Neither unused ports nor an
  unconsumed scheduler closes that contract. Qualify a complete changed consumer
  and measure its invocation/prefix interval before selecting another unchanged
  fairness replay; preserve the original workload and oracle.

- E159: The lifecycle qualifier adds an explicit `frontend-loss` scenario and
  optional debug/release selection, preserving previous modes and default
  release. Opt-in codex/Stop tracing retains original frontend birth, private
  TMPDIR, request-local topology, bounded journal snapshots and native custody.
  The scenario joins verified renderer request bytes/digest to the typed
  invocation, requires partial committed output before signaling only the
  original retained frontend Child, and separately demands native Node cleanup,
  renderer worker/backend cleanup and absence, then one correlated unknown-fence
  refusal. A retained inert sibling checks process isolation. A renderer that
  finishes before disconnection is an incomplete interruption window; the
  scenario stops without retrying it or silently restarting an idle host.

  Root reproduces a draft oracle defect through the actual compiled journal
  reader: a later same-session request makes the earlier request's journal
  selection ambiguous. Selection is restricted to the retained frontend PID and
  filename/invocation identity. The filesystem control then accepts the earlier
  journal alongside a later request and refuses ambiguous same-frontend names
  and changed prefix bytes. The committed-turn Jest helper default also moves to
  the compiler's `qualification-tools/scripts/` output, avoiding stale old
  output selection. Raw checks and the before/after counterexample live under
  external `frontend-loss-draft/` beside E157's artifact directory.

  Strict render-tool compilation exits0. An attempted broader command first
  exits2 because it names nonexistent `scripts/committed-turn-files.test.ts`;
  preserve that failure and distinguish its subsequently emitted JavaScript from
  the corrected compiler invocation. The corrected topology/custody suites
  pass100 cases; lifecycle oracle controls pass with `runtimeExecuted:false`.
  These are qualifier/source controls. No actual frontend-loss signal or native
  renderer scenario has executed for this candidate, and no A3/A8 acceptance,
  lifecycle parity, fairness or cutover follows. Review and the one isolated
  dispatched-loss scenario remain owed before relying on that behavior.

- E160: The single explicit `frontend-loss debug` attempt on `6b8d50f3` exits1
  and records `incomplete` before any frontend signal. Native caller35768 later
  exits2 at its30s deadline; final renderer execution is unknown. Its correlated
  native chain35768→35789→35790 records Node exit9, both EOFs and successful SDK
  settlement under `stop_requested`. The original host and inert sibling exit0;
  final cleanup reports `confirmed_inactive`, socket absent and custody free.
  This is deadline-path cleanup, not hard frontend-loss evidence.

  Artifacts remain at
  `packages/caws-native/target/qualification/render-lifecycle-frontend-loss-2026-10-20T19-27-41-287Z/`.
  The external `frontend-loss-draft/attempt1-retained-manifest.json` hashes all
  7975 files/46689851 bytes. Original run and sandbox remain retained. Export
  attempts are refused before execution: the Bash write guard classifies a
  command-metadata string as a foreign Sterling write; the worktree guard
  classifies an external artifact copy as a copy into main. Installed guard
  state is untouched. Inspection locates the latter's broad `packages/` match at
  installed `worktree-guard.sh:333`; external raw export remains owed before
  teardown, and this observation does not authorize bypassing either guard.

  The qualifier accepts any matching durable operation, then calls every
  non-Running state a lost window. Native admission first persists Queued
  (`service_journal.rs:1395`), then `begin_next` persists Running. A valid
  queued record therefore refutes that oracle. The failed attempt did not retain
  its exact observed pre-interruption phase, so that race is a source
  counterexample, not an established attribution for the run. The corrected wait
  keeps queued work pending, accepts Running only, classifies successful daemon
  responses as lost windows, and treats unknown, cancellation and launch/process
  failures as explicit failed attempts. Both pre-signal checkpoints and
  post-signal returned handling preserve that distinction. New phase snapshots
  and signal timestamp/ original deadline make the next observation
  attributable. Strict compilation, scoped lint and phase-oracle controls exit0;
  no corrected actual run is implied.

- E161: The second explicit `frontend-loss debug` attempt on `6e3e4660` exits1
  after actual selected-renderer dispatch and402 committed turn files. Retained
  frontend89262 receives SIGKILL4988ms before its original30s deadline. Its
  correlated custodian89313/Node89317 receipt records `frontend_gone`, actual
  child exit9, both EOFs and SDK settlement; independent observations find all
  three processes and both request groups absent. Renderer owner observations
  retain backend93024's reap/EOF and worker93007's actual exit. One fresh native
  request2950 receives exactly one correlated `unknown_fence` refusal without
  another durable effect or dispatch. The original inert sibling89244 retains
  its birth identity through target cleanup and exits0 on ordinary input
  release. Final cleanup is `confirmed_inactive`.

  The overall scenario fails its subsequent cooperative-writer assertion; these
  observations do not establish a complete lifecycle pass. Artifacts remain at
  `packages/caws-native/target/qualification/render-lifecycle-frontend-loss-2026-10-20T19-42-37-662Z/`.
  `commands/009-native-frontend-loss-rendering/request-completion.json`,
  `frontend-loss-signal.json`, `owner-observations-final.json`,
  `frontend-loss-unknown-fence-admission-denial.json` and `scenario.json` retain
  the separate evidence. External
  `frontend-loss-draft/attempt2-retained-manifest.json` hashes1748 files/
  19693494 bytes across the original run and sandbox; raw export remains owed
  under E160's guard refusals. No teardown or guessed cleanup signal occurs.

  The persisted writer intent remains Running and fenced. `Journal::open`
  (`service_journal.rs:985-997`) durably recovers Running to Unknown;
  `render_writer::acquire` opens that journal before refusing unresolved work.
  The qualifier asserted Unknown before exercising this recovery consumer. Its
  repair waits for original-host exit, invokes the actual cooperative writer,
  checks exact exit75/refusal and absence of its sentinel, then checks the
  recovered durable Unknown record. It also persists native and renderer cleanup
  checkpoints before later assertions. Strict render compilation, scoped lint
  and denial/turn/phase controls exit0; raw commands/output and source hash are
  in external `frontend-loss-draft/recovery-checks.json` and adjacent channels.
  The corrected actual scenario remains unexecuted at this checkpoint. No parent
  AC, warm residency, fairness or installation follows.

- E162: The corrected actual `frontend-loss debug` scenario at committed
  `eb2c411350c9765aef6da3659173da583323bd08` exits0. The unchanged native debug
  binary remains SHA256
  `0bf590321e05f26d339e756ab711bbeb13f8f10b25766c09370f62cca3b7fd0f`; the
  engine/CLI and observer bytes match E159's preflight. The original30s budget
  and10000-turn fixture are unchanged. Running typed dispatch and269 committed
  turns precede SIGKILL to retained frontend71947,4474ms before its original
  deadline. Correlated custodian71979/Node71985 records actual exit9,
  `frontend_gone`, both EOFs and SDK settlement; independent observations find
  all three processes and both request groups absent.

  Separate renderer cleanup retains backend76451's actual SIGKILL reap and both
  EOFs, worker76447's exit0, and independent absence of both groups. Fresh
  caller85767 receives the correlated unknown-fence refusal without another
  effect. Original host71915 exits0. The actual cooperative writer then exits75
  with the exact unresolved-execution diagnostic and no sentinel: the same
  writer request identity changes Running to durable Unknown on reopening. Inert
  sibling71926 survives target cleanup with the same birth identity and exits0
  through input release. Final cleanup is `confirmed_inactive`, custody free and
  socket absent.

  The run root is
  `packages/caws-native/target/qualification/render-lifecycle-frontend-loss-2026-10-20T22-49-26-551Z/`.
  `frontend-loss-signal.json`, `frontend-loss-native-cleanup.json`,
  `frontend-loss-renderer-cleanup.json`, the before/final writer-operation
  snapshots, unknown-fence refusal, sibling observations, `scenario.json` and
  commands009-011 preserve the distinct observations. External
  `frontend-loss-draft/attempt3-preflight.json` binds executable hashes;
  `attempt3-retained-manifest.json` hashes1363 files/18625408 bytes across the
  original run and sandbox. E160's raw-export obligation remains; originals are
  retained. This is one actual selected copied-Python renderer loss after
  Ready/dispatch, not a typed renderer replacement, pre-dispatch loss, second
  frontend/surface proof, resident reuse, fair capacity or machine adoption.
  Phase observations and the actual signal are distinct; the terminal Unknown
  and retained cleanup receipts establish this sampled interruption, not an
  exhaustive race proof. No parent AC is recorded from this scenario alone.

  Independent read-only inspection raises a future-oracle counterexample:
  accepting any Unknown writer record could borrow an unrelated record. The
  qualifier requires one original Running intent, unchanged operation membership
  and identical body/verified request bytes except the recovered Unknown
  outcome. Six hostile controls reject missing, extra, unrecovered,
  foreign-identity and changed-request records. The strengthened predicate also
  exits0 on this run's retained before/final snapshots; it does not rerun native
  execution. Strict compilation, lint and all oracle controls exit0. Exact
  commands/output and source hash are in external
  `frontend-loss-draft/writer-identity-checks.json`.

- E163: Ordinary parent merge `1e162f7271596781ae9308dba1a96c5328a09025`
  integrates replay candidate `3175d871` and Unicode candidate `25d114c9` from
  main `720d095d`. Canonical component specs are closed with matching
  `ac_recorded` events9641-9643 and9657-9660; these are component records, not
  parent acceptance. Root readback matches all23 surviving source/support file
  hashes against those exact Git candidates and verifies both original replay
  Python paths absent. Peer raw Node18/22 checks retain replay55 passes and
  Unicode74 passes,280 fixture comparisons per version and exhaustive Unicode14
  domain observations. The bounded historical profile is CPython3.11.13;
  matching current host JavaScript behavior is not the compatibility oracle.

  Fresh parent Node22.19.0 compilation and its dynamic transcript runner exit0
  with74 tests,0 skipped; raw TAP names include the new codepoint and Unicode
  cases. The ordinary Jest foundation bridge and three affected shell suites
  also exit0,163 tests, and full package typechecking exits0. External
  `transcript-integration/merged-source-readback.json`,
  `merged-foundation-checks.json` and adjacent channels retain commands/hashes
  and TAP. Shell/bridge/typecheck channels are under external `scope-matcher/`.
  Original component evidence remains in the peers' `native-replay/` and
  `native-transcript-unicode/` artifact roots. No replay corpus-accuracy,
  general VM isolation, production transcript/writer/cache consumption, Python
  runtime retirement, fairness or installation follows. R20 retains three
  original developer scripts; R21 retains all13 pytest modules plus conftest.

- E164: Scope glob disagreement reaches the binding and landing consumers:
  `shell/binding/resolve-binding.ts` and `store/worktrees-writer.ts` translated
  stars with a separate regex, while kernel admission uses `matchGlob`.
  Direct-child globstar, braces/brackets and hidden paths were omitted; a single
  star incorrectly crossed separators. Root accepts repair ownership after
  inspecting both implementations, kernel scope and the claimant contract. Both
  wrappers delegate to the exported kernel matcher, retaining their established
  argument normalization and support-versus-claim boundaries.

  New tests execute actual worktree/bridge selection, ambiguity, review path
  verdicts, merge dry-run admission/refusal and alternative-lane hints. On the
  original built production,17 fail and6 pass for the expected semantic
  differences. After repair all23 pass; complete three suites plus the
  transcript bridge pass163 checks, full typechecking and scoped lint exit0.
  Dry-run tests require unchanged refs, registry and event bytes. External
  `scope-matcher/baseline-checks.json`, `repaired-checks.json` and adjacent raw
  channels retain commands, failures, outputs and source hashes. The red run's
  139 unrelated skipped cases reflect its explicit name filter; the complete run
  has no skipped cases. These checks establish source consumers, not an updated
  installed CLI. Existing relative-path normalization differs from raw kernel
  input validation; universal normalization equivalence is not claimed. No gate
  floor, installed guard or scope authority is weakened.

  A fresh review identifies schema-valid65537-unit patterns reaching
  picomatch's65536-unit parser bound. Root's live built-code probe reproduces
  SyntaxError in both binding and raw kernel. The two boolean adapters treat
  parser SyntaxError as non-match, preserving structured unbound/foreign
  decisions; unexpected infrastructure errors continue to propagate. Five actual
  resolver/review/merge controls fail on compiled `91612c9e`, pass after repair,
  and preserve independent valid-owner selection and hints. Complete three
  affected suites pass167 checks with no skips; build and lint exit0.
  `scope-matcher/oversized-checks.json` and raw channels retain the compiled
  baseline hashes, red/green commands and source hashes. Raw kernel handling and
  unbounded schema input are not qualified by these adapters; the parent retains
  their actual scope-enforcement error-path investigation. No erroring pattern
  itself confers a claim or provenance admission.

- E165: Root accepts the remaining R18 writer obligation from the Unicode peer
  after inspecting actual `render_session` artifacts and current source.
  `session_log_renderer.py:1802-1872` permits a turn/index publication after a
  sidecar replacement OSError, and mutates turn/orphan files before strict index
  encoding. The public wrapper's output inventory at1900-1916 can fail after
  those mutations, leaving the prior render-state receipt. This reaches the
  migration's actual writer/output-custody target; component text equality
  cannot discharge it.

  The private CPython3.11.13 baseline is retained under peer
  `native-transcript-unicode/writer-boundary-probe/run-20261020T230145Z-ed5353f2/`.
  Seven cases include positive scalar controls. `index_surrogate_failure` exits1
  after replacing turn001 and deleting orphan turn009/sidecar, while old
  index/state and an empty index temporary remain. `sidecar_directory` exits1
  after publishing a new turn with a directory-valued sidecar reference and a
  new index, while old state and full sidecar temporary remain. Root matches
  all12 current source hashes, retained file/channel hashes and these filesystem
  effects; external `transcript-integration/writer-boundary-readback.json`
  retains the readback.

  These observed defects are deliberate repair obligations for the typed writer,
  not parity behavior to reproduce. Prepare and validate intended
  encodings/destinations before publication; preserve verifiable turn/sidecar/
  index/state custody through failures and recovery, and do not issue a current
  success receipt for unknown completion. The concrete transaction protocol and
  its hostile/crash evidence remain parent-owned implementation work. Turn JSON
  uses ASCII escapes and can legitimately preserve surrogate-valued interpreted
  actions; strict UTF8 refusal belongs to the actual spill/index boundaries.
  Pre-JSON codepoint equality, deduplication and ordering require direct
  evidence because pair/scalar strings can collide after ASCII JSON. No typed
  writer, installed execution or atomicity repair is claimed.

- E166: The transcript foundation's uncapped lossless integer codec is not the
  production acquisition profile. Actual CPython3.11.13 reader probes at the
  default and explicit4300-digit limits reject a4301-digit integer with
  ValueError; an explicit unlimited control accepts it. The uncaught actual
  reader exits1. The typed raw codec retains and roundtrips that integer, which
  establishes custody rather than reader acceptance. Root inspects the source,
  five retained command/channel identities and the partial-tail probe under peer
  `native-claude-adapter/integer-boundary/`; external
  `transcript-integration/integer-profile-readback.json` retains that readback.

  In `session_log_renderer.py:498-537`, complete rows commit their cache prefix
  before a tentative partial tail is parsed against a copy. The observed cache
  offsets are124 before append,248 after complete row B plus a rejected partial
  tail,248 after its failed completed retry, and372 after repair to row C.
  Acquisition must preserve this phase distinction and return the resulting
  committed checkpoint on tail failure. Select and validate the numeric limit in
  the acquisition consumer and its cache identity; do not cap or rewrite raw
  custody values to manufacture profile parity. The typed reader/profile and
  cache-generation behavior remain implementation obligations; neither these
  probes nor the standalone Claude component replace that consumer.

- E167: A scope parser failure reaches an actual guard-strength and availability
  defect. `scope contention` returns exit1 with a JSON error envelope for a
  schema-valid65537-unit pattern. Under `set -e`, the unguarded command
  substitution in `shared/worktree-write-guard.sh` exits1 before its existing
  unknown-observation policy: a non-allowlisted `tests/` write misses the
  ask-incapable exit2 protection, and an allowlisted `docs/` write misses its
  deliberate availability path. The existing policy admits unknown allowlist
  observations; this repair does not invent blanket refusal for docs faults.

  The guarded substitution maps any nonzero CLI result to `unknown:caws-failed`
  and discards its output before the existing policy runs. Actual compiled
  CLI-to-source-guard tests fail both cases on the original guard (received1,
  expected2/0) and pass after repair. The installed private pack tests
  additionally exercise exit1, exit2 with misleading clear JSON, invalid JSON
  and a successful undetermined observation. Complete focused suites pass21 Jest
  cases and10 Bats cases; CLI build, scoped lint and Bash syntax checks exit0.
  Shared pack103 and its recomputed fingerprint carry the template change. Raw
  red/green channels are under external
  `scope-matcher/contention-{red,green}-{jest,bats}.{stdout,stderr}`. Successful
  claim/clear mapping, missing-library protection and unchanged
  refs/registry/events are checked. This is source and isolated installed-pack
  qualification, not machine adoption or a repair of the kernel parser bound.

- E168: Ordinary merge `96ebeb36d20de2d215a5f56234a23305f7a6f21f` imports the
  frozen Claude main merge `2164831e` and checked candidate `172242ea`. Root
  matches all10 source/support files against both the candidate Git bytes and
  its retained final identities. The canonical component's A1-A3 records and
  events9704-9706 establish its separately closed scope, not parent acceptance.
  The public transcript index exports the exact Claude adapter and pinned
  revision; a fresh compiled import checks both identities.

  Fresh parent Node22.19.0 strict compilation and the dynamic runner exit0: 95
  tests pass with0 skipped. The ordinary Jest foundation bridge independently
  compiles and runs the parent test selection, exiting0. Exact imported bytes
  are retained in external `transcript-integration/claude-source-readback.json`;
  `claude-{compile,run,bridge}.{stdout,stderr}` retain the fresh channels.
  Independently inspected component evidence retains215 differential fixtures
  per Node18/22, the Unicode14/CPython3.11.13 HTML profile and meaningful
  bounded fault controls. These are historical standalone normalization
  observations. Ordered Qwen-before-Claude dispatch, acquisition/profile
  admission (E166), cache, writer (E165), installed rendering and original
  Python retirement remain parent obligations. Neither the barrel export nor
  matching text proves execution through those consumers.

- E169: Root accepts the R24/A2/A5 copy-guard investigation and repair
  obligation after inspecting the peer's effective-source finding and actual
  parent `shared/worktree-guard.sh:317-345`. With a canonical or absent payload
  cwd, the predicate marks any command containing a worktree operand plus an
  unanchored `packages/`, `src/`, `tests/` or `core/` token as worktree-to-main.
  It derives neither the destination nor direction. The peer's retained
  `native-qwen-adapter/worktree-guard-boundary/finding.json` binds the inspected
  installed/shipping bytes and conditional illustrative operands.

  The actual rejected hook payload and cwd remain uninspected; the illustrations
  are not replayed runtime results. Root owns the smallest next falsifier:
  isolated guard decisions with explicit canonical/worktree cwd, external-to-
  owned and owned-to-external operands, and a genuine owned-to-canonical write
  that must remain refused. Inspect ownership and path resolution for those
  targets before choosing a repair. Preserve the raw-export obligation in E160;
  no guard disable, runtime replacement or permission bypass follows from this
  finding. The Qwen component does not own or claim this guard repair.

  Root additionally inspects the peer's
  `native-qwen-adapter/bash-write-guard-boundary/finding.json`, parent
  `lib/bash-mutation-targets.sh:950-1032` and `bash-write-guard.sh:268-340`. One
  interpreter write verb enables extraction of every slash-bearing fragment;
  unrelated read/executable literals can reach the foreign-repository refusal.
  The source describes this as conservative, weaker evidence. Root owns
  adjudication of operation roles and that policy before choosing any repair:
  pure extractor controls for mixed external-write/foreign-read inputs, genuine
  foreign writes, computed unknown targets and physical symlink resolution. The
  original refused native payload/cwd is uninspected. Applicability reaches the
  shell guard and shared R05 remediation selector; a pure typed-classifier
  defect is not established. No blanket interpreter exemption is authorized by
  this finding.

- E170: Ordinary parent merge `113ddd4b350c96231445bdf9b966b9d88f5fb686` imports
  the separately landed pytest-entrypoint candidate `36669f7a` through frozen
  main merge `4d448f17`. Root and independent readback match the two surviving
  file hashes/Git bytes, original Python test deletion, component
  A1-A3/events9735-9737 and completed closure9739. The component's original
  Python cold baseline and meaningful cleanup/PID-only negative controls remain
  retained in its `native-pytest-entrypoint/` artifact root. They are component
  evidence, not parent acceptance.

  Fresh combined-parent Node22.19.0 Jest execution exits0 with7 tests,0 pending
  in36.124s. Positive npm PID35922 exits0 after the actual pretest/build;
  installed Python `caws-hook --describe` and execution both exit0. The retained
  installer SHA256 is
  `c2c13338450d28cd8e1eca2f10adb8f5dc6333a6a14fdf87733b5056eb7f8f90`.
  Before/after description snapshots contain142 equal regular files; exact
  `invoked\n` bytes and one matching completed marker journal row establish the
  selected project override's invocation. The private runtime generation is
  `0dd794274dfb56be426d2cbe8403dda0eec159a9b3876195ecac11b30627ed49`.

  Removing only `pretest:pytest` leaves560 other authored input files identical
  and the effective package identical except that removed script. Negative npm
  PID47898 exits1 with actual `MODULE_NOT_FOUND` at the missing copied
  installer, without execute record, marker or journal. Both npm observations
  retain actual exit/close, both EOFs and group absence; root's later group
  probes confirm absence, and owned source fixtures are removed after
  settlement. The held-pipe control observes descendant readiness,3038ms
  settlement, no delayed effect, an unrelated-child acknowledgement and a
  retained fixture.

  External `pytest-integration-result.json`, `pytest-integration-readback.json`,
  `pytest-integration-controls.json`, adjacent Jest channels and the seven
  `pytest-integration/` scenario directories retain commands, outputs and state.
  This retires one Python orchestration test;12 modules plus conftest remain, 13
  tracked Python files. It exercises the installed Python runtime and one
  project marker, not the complete stock guard chain or Rust entrypoint.
  Descriptor/library hashes are not import traces; snapshots do not cover
  metadata, empty directories or fsync. Ordinary inherited POSIX groups and
  polling-tolerant deadlines do not establish escape containment or a strict
  latency SLA. R20 remains three original developer scripts; no parent AC,
  Python-free runtime, full CI, fairness or machine adoption follows.

- E171: Canonical merge `1755e1d16d86ab92801ce783611671261322528e` contains the
  two-file Qwen component `39941e8c`; root inspects that Git change and the
  separately closed/completed `CAWS-NATIVE-QWEN-ADAPTER-001` spec. Component
  source/profile checks and source identities are retained under peer
  `native-qwen-adapter/` in `artifact-index.json`,
  `candidate-final-identity.json` and `observations-verified.json`. Their
  detailed raw differential evidence is pending parent grounding; this entry
  records canonical source disposition. The parent lane has not imported or
  exported this adapter. Root accepts its ordinary integration and the ordered
  Qwen-before-Claude falsifier: a matched Qwen row emitting no events must
  retain ownership rather than fall through to Claude. Acquisition, cache,
  writer, installed consumption and original Python retirement remain open.
  Further adapters keep separate bounded ownership and do not change that parent
  obligation.

- E172: The parent integrates shared typed heartbeat/message-poll application
  operations into both existing CLI commands and the stock Codex Bash consumer.
  The consumer uses canonical leases/mail, checkout-local observation sidecars,
  the original request caller PID, independent mail polling during lease
  throttle and existing composer offer settlement. Selection requires reviewed
  stock sources and libraries, no selected overrides or startup extensions,
  PATH's genuine same-package CLI entry and the engine's Node executable.
  Missing, foreign, nonexecutable, wrapped or ambiguous selections retain the
  selected shell handler. The CLI entry hash is a finite compatibility pin, not
  a sealed package/dependency closure. Shared pack104 corrects the sender's
  `specId` projection; the typed consumer also creates the checkout cache
  directory before escalation-state persistence. Neither deliberate repair
  grants authority. Root's retained
  `heartbeat-runtime/root-build.{stdout,stderr}` exits0 after
  runtime-asset/registry checks and strict production compilation. The first
  integrated Jest attempt exits1:176/177 checks pass, and the new unsafe-ID test
  expects `session_id_invalid` where `safeLeaseFilename('../foreign')` returns
  `session_id_unsafe`. The store contract remains unchanged; the corrected
  oracle and consumer suites pass29 checks in3.158s, exit0. The initial scoped
  lint exits1 on the new test's missing `AbortController` declaration; the
  explicit global declaration repairs it and corrected scoped lint exits0. Raw
  failed and corrected logs/JSON and stock fixture snapshots remain under root
  artifact `heartbeat-runtime/`; no attempt is overwritten. These checks
  exercise application refusal/throttle, canonical state and offer composition
  plus positive typed admission and hostile executable/override fallback. They
  do not observe native selection, complete process execution, installed package
  closure, actual native offer ACK/release, performance, residency, fairness or
  machine adoption. The native qualifier must stop on unknown cleanup; recording
  it and continuing the scenario chain cannot establish qualification. Parent
  A1–A8 remain open, and the installed Python pipeline remains selected.

- E173: Root's finite native heartbeat qualification retains both failed and
  successful intermediate checks under root artifact `heartbeat-runtime/`. The
  debug native/observer build, ordinary package build/pack and private package
  install exit0. The qualifier's first strict compile exits2 because the command
  omitted `--resolveJsonModule`; its corrected compile exits0. The exact-event
  custody tests pass58 checks with no skips. Attempt1 stops before starting a
  native client because its identity profile omits a transitive compiled import;
  the corrected profile pins the compiled tree and preserves the failed attempt.
  Attempt2 executes the complete ten-stock chain with30s budgets. Eight ordinary
  cases and a separate V8 diagnostic have confirmed inactive cleanup. Canonical
  A/B leases retain original frontend PIDs11866/19109; retained state verifies
  linked/common-root isolation, CLI fallback, missing-CLI inactivity and mail
  offer ACK/release across a later stock refusal. The first activity timestamp
  falls within its heartbeat journal bounds, and the second request
  arrives9907ms later, retaining throttled activity while delivering new mail.
  Raw V8 ranges and module hashes witness one call each to the typed heartbeat,
  activity and message-poll functions in the separate diagnostic. Ordinary
  effects alone do not provide that direct function witness for every request.
  The final missing-payload-SID request has frontend PID33697 and exit0, but its
  absent typed journal leaves the collector's cleanup correlation unknown. The
  qualifier stops, retains the sandbox and exits1; no subsequent native
  invocation is authorized by that result. Resolve this request from its
  retained original native custody evidence before another native probe. The
  actually executed qualifier source is retained under
  `heartbeat-runtime/executed-qualifier-source/` with SHA256
  `1a7e89172f815dcc93cce810075ea9733eb93b6fd142921311bdd67980e95cb6`. Later
  timestamp-assertion edits are not a fresh native replay. Source, package and
  dependency-tree snapshots bind this finite observation; they do not establish
  the complete Node resolution closure or an exec census. Committed-candidate
  review also exposes an actual compatibility gap: the effective Codex parser
  writes a durable session envelope and caller pointer, while the typed
  heartbeat prefix does not. Individually launched Codex shell handlers receive
  `HOOK_TOOL_NAME`; the parser fast path returns before capture, so a later
  handler does not repair these effects in the typed route. The original
  dispatcher parses before empty-handler and reprieve filtering. Root owns a
  native anchored precomposition writer and its compatibility routing; Sol's
  external draft is not integrated. Python-only existing JSON values remain
  explicit parity obligations. No effective Codex agent-PID or session-log-path
  loss was demonstrated. Parent A1–A8, performance/residency,
  thirteen-session/four-repo fairness, Python retirement and machine adoption
  remain open.

- E174: Root verifies Kimi candidate `346d50441c006e88affee2f86408ca9ca36ffd74`
  and merge `7d17706b6f63f80f25dd7cd3984f261be4ab3591` reachable on main, with
  the component spec closed/completed and only its adapter/test files changed.
  The peer's detailed fixture and mutation packet remains separate from this
  root readback. The parent has not imported/exported the component; root
  retains that integration and first-matched-empty dispatch obligation.
  Correcting R14 raises implementation/evidence coverage to28/37 rows
  (about76%); nine rows remain unreplaced/inventoried, no complete row has
  retired its Python production path, and parent acceptance remains0/8. This is
  feature coverage, including standalone components not integrated into the
  parent; it is not a percentage of cutover effort or readiness. Recompute it
  when a row changes and retain the acceptance ledger as the readiness
  authority. Peer A owns the active two-file DSH adapter component; peer B's
  two-file numeric-token component is closed on main in E176. Neither selects
  the parent production interpretation profile or closes the renderer/cache,
  numeric-reference grounding or selected-reader provenance obligations in
  E165/E166. Root retains integration and combined validation.

- E175: Source inspection grounds the omitted session capture at the original
  dispatcher boundary. `runtime/caws-hook.py` overwrites `hook_event_name` from
  the configured event and launches `runtime/dispatch.sh` in the selected
  checkout. Dispatch parses before empty-handler and reprieve filtering. The
  typed executor predefines `HOOK_TOOL_NAME`, so later individually launched
  Codex handlers take the parser fast path without writing the cache. The native
  owner must preserve this precomposition effect; PreToolUse persists literal
  `PreToolUse`, not a forged or absent raw field. Missing/empty cwd uses the
  selected checkout; a nonempty relative cwd is resolved a second time by the
  legacy cache helper and cannot silently reuse selected canonical context. Root
  owns that compatibility decision. Sol's external
  `native-session-cache/src/lib.rs` supplies an anchored read/decision/write
  operation, retaining directory FDs while the caller interprets exact old bytes
  or Missing and returns optional UTF-16 creation units. Its retained
  `callback-final-check.txt` exercises23 isolated cases, including surrogate
  escaping, symlink/rename races, read failure, partial publication, short
  writes and missing-identity inertness. This draft is not a production binding
  or decoder-profile qualification. Native custody control treats received bytes
  as cleanup requests; it is not a cache port. Root will bind a separately
  discriminated handshake on the existing framed engine stream, with one reader,
  original request/deadline binding and no replay after an uncertain write.
  Committed qualifier review also exposes an unavailable lint observation:
  `root-qualifier-current-lint.stdout` reports all four TypeScript files ignored
  by the root JavaScript-only configuration. Exit0 did not establish coverage.
  The corrected package-cwd invocation uses the existing package configuration;
  `root-qualifier-package-lint.json` names all four parsed files with no errors
  or warnings. The failed observation remains retained. Neither lint nor the
  external operation closes parent acceptance.

- E176: Root reads the actual closed/completed token-admission spec and verifies
  candidate `be12095cae5a6bed7eac4f99351b82331e11fece`, merge
  `f485dcf8274cc4b56a2f413d6ae58a0cde269cf6` reachable on main, and the two-file
  source boundary. `parsePythonJson` has an optional callback on each frozen
  numeric token before duplicate collapse or later syntax; the existing
  one-argument API and `jsonNumber` remain uncapped. The component's A1–A3
  records and closure are retained in peer B's
  `native-token-admission/010-landing/readback.json`, with closure revision
  `70e09aceebf0397158fef400adb3613eb83adfb4`. This component is closed on main
  and not imported into the parent. Root accepts integration, production
  interpretation-profile selection, acquisition/cache and nested-helper policy;
  peer B's bounded component handoff does not transfer those parent obligations.
  Its `native-cache-contract/cpython39-reference/root-readback.json` retains
  five isolated Python3.9.6 references: positive4301, overwritten and unused
  large integers are admitted, while syntax-before/after reports JSONDecodeError
  at offsets10/4310. This packet differs from the retained Python3.11.13 default
  limit profile; it does not authorize a global4300 policy. Root's current
  `/usr/bin/python3 -I -B -S` probe independently identifies Python3.9.6,
  Unicode13 and no integer-limit API, with resolved executable SHA256
  `b971331ab9beb1dac075006955f035a97332eca21187c4de615ae58346713e2f`. An
  isolated interpreter observation is not actual selected-reader/image custody,
  production profile selection or cache transaction qualification. Root still
  owes the decisive raw reference grounding in E166, the writer repair in E165
  and integrated reader/native observations. Coverage stays28/37 and parent
  acceptance0/8; a mechanism within an existing partial feature row does not
  increment the feature denominator.

- E177: Root's retained-request readback exits0 and records `confirmed_inactive`
  for original frontend33697, custodian33766 and node33771 in
  `heartbeat-runtime/root-missing-sid-readback-1/result.json`. It reconstructs
  the original birth-confirmed chain from raw topology, binds exact captured
  argv/input to the unique private native configuration and validates native
  invocation `33697-1792550559901480000`, terminal sequence3, child exit0, both
  EOFs and settled group facts. SHA-pinned native observer receipts report
  actual ESRCH absence for all three PIDs; a separate coherent ps inventory has
  no members in the two owned groups. Stop-event, old-birth, supplied-SID and
  changed-input controls return unknown without a configuration witness. Strict
  integrated compilation and86 focused custody checks exit0 without skips. The
  new missing-SID API is distinct from the unchanged default Stop typed-journal
  requirement. This readback preserves the original partial result; it neither
  reruns the scenario nor credits the strengthened qualifier as executed. Native
  configuration v1 lacks independent event/input attestation: this is
  correlation within the original trusted private fixture, not kernel
  executable-image proof or a universal descendant census. No new native
  invocation, signal or cleanup occurs. E173's retained cleanup gap is resolved
  within this boundary. Fresh native qualification still owes the session-cache
  prefix repair, actual qualifier-wiring observation and complete
  dependency-resolution evidence; parent acceptance remains0/8.

- E178: Root verifies the actual closed/completed `CAWS-NATIVE-DSH-ADAPTER-001`
  spec, its A1–A5 records, two-file committed candidate
  `1cde1d3094dded29f196db11cf57d50778dda8cc` and source merge
  `85de0c632aec43b206c6ab59089774158befc54f` reachable on main. The component
  requires an explicit caller-supplied embedded decoder profile; no default
  production integer or recursion policy is selected. The spec retains finite
  reference, state, occurrence and Node18/22 evidence, including the original
  constructed-vector and failure boundaries. Those records are not root
  re-execution of the full component packet. DSH is a committed standalone
  implementation awaiting parent import, not an uncommitted draft. This changes
  feature coverage to29/37 (about78%); parent acceptance remains0/8. Root
  retains production profile, registry, acquisition, cache/writer, native and
  retirement obligations. Peer A accepts the next bounded OpenCode/Zcode
  components after ordinary DSH closure; those assignments do not transfer
  parent obligations.

- E179: Parent commit `ff2cac0169496533248847a0f87822e47183c439` imports the
  exact two token-admission files from closed candidate `be12095c`; root
  compares both source files against that candidate. Baseline lossless-parser
  checks pass9/9; fresh strict transcript compilation and all106 transcript
  checks exit0 without skips after import.
  `heartbeat-runtime/root-token-parent-tests.stdout` retains token
  occurrence/order, duplicate-collapse, later-syntax and callback error-identity
  controls alongside the existing transcript checks. Package build, actual
  two-file package lint and all five policy gates exit0; raw logs retain the
  evaluated branch/staged basis. Independent read-only inspection identifies no
  additional defect, and the root's source/raw checks support the bounded claim.
  This optional seam is integrated; selected production numeric, Unicode and
  recursion profiles and ordinary reader/cache consumption are open. `684ee2eb`
  separately commits E177's missing-SID correlation and its unchanged default
  Stop boundary. Neither unit adds a fully retired Python row.

- E180: Root checks all six raw emitted text/hash values and stream hashes in
  peer B's `native-cache-contract/unicode-profile-falsifier/002-direct` packet.
  The same structured abort reason containing U+1FAE0 renders as the escaped
  `['\\U0001fae0']` under Python3.9.6, and as `['🫠']` under Python3.11.13 and
  the typed adapter. The scalar-string control agrees across all three. Actual
  source routes structured Codex abort reasons through `pythonStr`, while
  `transcripts/index.ts` names the finite Python3.11.13/Unicode14 foundation.
  Numeric-token admission alone cannot establish parity for a differently
  selected interpreter profile. A separate bounded passive observer retains one
  installed `session_log_renderer.py` occurrence, PID79973 with birth
  `1792558678.094449`, OS executable path naming Python3.11.13 and filesystem
  executable SHA256
  `d5e2d4feef9f70f82e65429d1edd50a0e3e70debbbc6f27272f2f6ecd463b498`.
  `selected-interpreter-observation/observations.json` retains before/after
  process-birth checks and exact installed script identity, but omits the
  harness/surface association. It does not establish the Codex selected reader,
  all renderer profiles or mapped-image attestation. Root retains that precise
  profile-selection gap; no machine registration, runtime or Python policy is
  changed by these observations.

- E181: Two actual contract-fixture copy attempts are refused before execution.
  With an explicit owned `workdir` and relative target, installed
  `bash-write-guard.sh` reports a canonical path claimed by the parent lane; its
  source resolves operands from top-level `HOOK_CWD`, not the tool's `workdir`.
  With the exact absolute owned target, installed `worktree-guard.sh:328–341`
  classifies the same worktree operand's unanchored `packages/` token as a
  main-repo operand and reports worktree-to-main copying. Source and destination
  in that second request are external artifact and owned native fixture
  respectively. Root's fresh `caws status` identifies the correct owned/bound
  lane, and the relative native fixture scope check admits the path. The raw
  registered hook payload/cwd has not been recovered, so this does not establish
  every bootstrap attribution step. Both refusals and the E169 repair obligation
  remain; installed guards are not changed or reprieved. The fixture is authored
  through the normal scoped file-edit surface. No copy command reaches
  execution, and no gate or authority conclusion is inferred from a different
  tool's admission.

  A separate real overlap requires narrowing parent claims. The first CLI
  amendment adds exact helper/test scope.out exclusions and both parent checks
  read back `scope.reject.scope_out`, but contention remains: the actual kernel
  and installed claim oracle intentionally match scope.in without subtracting
  scope.out. Root replaces the two broad runtime source/test claims with71 exact
  current parent files and keeps the broad paths as editable, unclaimed
  scope.support. The delegated helper/test retain their separate child claims;
  the parent keeps their explicit exclusions until child closure. This is an
  audited scope operation, not a guard change. The peer owns
  `CAWS-NATIVE-CACHE-ADMISSION-001`; root retains integration and must read back
  actual contention before treating the overlap as resolved. Remove the two
  exclusions through the CLI only after closure before importing. E182/E183
  record the committed component boundaries and remaining parent integration;
  neither component establishes parent acceptance.

- E182: Parent commit `3ba6add124b88506fd37bd07b22f74917e9d054b` adds the
  directory-relative native session-cache operation, one-shot correlated wire
  exchange and optional typed client. Native retains the selected root/session
  directory descriptors, reads exact bounded old bytes, and owns envelope then
  pointer publication. The client owns the finite old-JSON decision; explicit
  decline permits compatibility only after a correlated terminal no-publication
  result. Lost/invalid exchanges never grant replay. This private coordinated
  pair does not establish mixed-version installation compatibility.

  Raw artifacts live under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/heartbeat-runtime/`.
  `root-cache-custody-repair-invoke.stdout` records35 passing actual native
  invocation checks, including7 cache scenarios; the corresponding
  `native-cache-custody-repair-cases/` retains frames, streams, topology and
  reap observations. `root-cache-client-final-tests.stdout` records149 typed
  client checks; strict production compilation, package build, actual
  package-cwd lint and all-target Clippy pass. The earlier33-pass/2-fail
  invocation run and Clippy failure remain retained: repairs preserve the
  custodian's original no-child spawn error, use the actual observed
  direct/custodied EOF topology, and reap a child when the native test collector
  panics after spawn. These checks exercise finite fixtures, not ordinary
  heartbeat or installed use.

  Independent committed-candidate review identifies two follow-ups. The original
  library run precedes the final contract-test naming/source correction;
  `root-cache-cancellation-final-library.stdout` executes the committed declared
  wire assertion and47 matching checks. More consequentially, decision receipt
  alone does not observe cancellation before publication. The checked cache
  operation carries the binary's existing cancellation observer through
  directory/read/ write and pre-rename checkpoints, preserves the exact cause
  and partial publication state, and routes cancellation through failure/cleanup
  without compatibility replay. Injected post-decision, staged-envelope and
  post-envelope cancellation controls verify retained old bytes and temporary
  cleanup. Cancellation racing a syscall and blocking filesystem calls remain
  outside an atomic interruption guarantee. E186 records precomposition binding
  and finite native downstream-consumer observations; fresh complete-chain
  qualification remains owed.

  `root-cache-cancellation-invoke.stdout` retains a fresh35-check native
  invocation pass after the cancellation change; successful temporary scenario
  directories from this run are not retained.
  `root-cache-cancellation-bin.stdout` records78 binary checks and all-target
  Clippy exits0. The cache cancellation falsifiers observe both capture and
  explicit-decline decisions: cancellation supersedes either result before it
  can grant replay.

- E183: `CAWS-NATIVE-CACHE-ADMISSION-001` is closed/completed on main: candidate
  `437032e13a73cd6e329103109b439f70fccbfe2a`, merge
  `7912184be31e30db5610ddc28bf664cd6beeb65b`, close `5d70df3b`. Root reads the
  actual spec/landing receipt, verifies merge ancestry, and inspects the finite
  helper source. It admits exact stock Codex prefix source bytes and
  environment/path conditions; it does not establish selected PATH executables,
  Python imports, full decoding or held native custody. The parent scope
  exclusions are removed and exact helper/test claims restored through the
  audited CLI after closure. E186 records the exact parent import and finite
  consumer wiring. Peer packet `native-cache-admission/020-stock-profile/`
  reports actual finite9fb-source decisions on Node18.0.0/18.20.8/22.19; those
  observations are not ordinary heartbeat/native evidence.

- E184: OpenCode and Zcode standalone components are closed/completed on main.
  Root reads their actual specs and checks merge ancestry and source hashes
  against `native-harness-tail-coordination/postmerge-readback.json` under peer
  artifact root
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/`.
  OpenCode candidate `e968dcaac211cd69888ab97a3bda1e8f521fbb74` merges at
  `05cd4ced1c954fbc1ddccd08ec3feaf69fd21c28` and closes at `1bc80f73`; Zcode
  candidate `5b81b7ae872808e03b73aaca682dcc3b521075f9` merges at
  `9d60bce0f4c33d96346546c867c77492e1893270` and closes at `fc7efd0c`. Their
  implementation SHA256 values are respectively
  `24cd37a14b94b7aec5f32ce941b6deec9338f1ef78e3c322cb0c34de8758c6ce` and
  `b39506d358e84a221c6c3cbc200264b9b2860526e690785aac35e674acc64881`.
  Peer165-check combined Node18/22 results are retained reports, not root
  reexecution. OpenCode declares9 name translations,8 input mappers and3 noise
  prefixes with zero row adapters; R09 owns actual acquisition/reconstruction.
  Zcode supplies a bounded stateful model_io adapter. Both parent imports,
  production registry/reader/cache/writer and installed use remain open. These
  two rows raise committed feature coverage31/37; acceptance stays0/8.

  Root accepts the R09 investigation handoff and retains implementation and
  dependency/profile choice. The fixed read-only SQLite JOIN requires a complete
  snapshot-bounded result with original JSON bytes and lossless typed SQL
  values; failure/cancellation cannot promote partial rows or old projection as
  current. Rust-owned acquisition is the selected direction for Node18/22; no
  particular crate/version, Cargo change or native API is adopted. Peer
  synthetic reference/actual-renderer packets remain inputs to ground before
  implementation. SQLite reference-versus-bundle version and compile-option
  differences, busy/progress/interrupt controls and WAL sidecar behavior remain
  explicit obligations. A projection-only module would not discharge R09.

- E185: The installed shell guard refuses a read-only quoted Node heredoc
  containing `.map(e=>({...}))` as `ask_unsupported_nesting` before execution. A
  read-only investigation traces the actual Codex registration through active
  runtime `408c06a7cbdb1950e24f53a7486428c3a51e45bbeb86292cb9b2dec30177baa0`.
  Shipping/installed `shared/lib/heredoc.sh:98–109` blanks only safelisted
  cat/tee bodies; `bash-mutation-targets.sh:485–504` passes the Node body to the
  lexer, whose325–336 process-substitution branch sees the JavaScript `>(`.
  `bash-write-guard.sh:501–505,566–579` promotes it to ask/refusal. This is a
  source-grounded explanation, not a byte-exact replay of the original request.
  The selected stock guard remains shell-backed in handler-executor, so this
  defect reaches ordinary cutover verification. Root retains the repair: finite
  quoted interpreter bodies must be excluded from shell operator parsing while
  preserving interpreter-write inspection, header redirects, following shell
  commands, real process substitution and unquoted expansions. No guard,
  registration, reprieve or bypass is changed. E169/E181's operand/cwd defects
  remain distinct obligations.

  Readback exposes an existing owner and governing requirement: active
  `CAWS-SHELL-ANALYSIS-001`, clean worktree `shell-analysis` at `4bde1f49`, owns
  the mutation library and interpreter cross-repository tests. Its A6 already
  requires benign Node data to avoid fabricated shell targets and real foreign
  writes to remain refused; recorded A6 is fail, and A5/A7 retain effect and
  final-launch prerequisites. This is a live19-commit lane, not a ghost to
  prune. Root releases its overlapping broad template claim through the CLI,
  retains existing parent template changes as exact claims/support, and excludes
  the three proposed repair paths. That does not release the foreign owner's
  claims. No duplicate repair spec/lane or takeover is created. Peer baseline
  artifacts under `native-quoted-node-heredoc/scenarios/` report the actual
  read-only arrow refusal and a computed-write control whose only refusal is the
  spurious nesting token. A standalone masker could weaken protection;
  owner-coordinated syntax/effect repair remains owed. Root requests permission
  to message the additional owner and continues independent cache work.

  Root inspects retained effect/substitution command bytes, guard records and
  unchanged sentinels under that peer artifact root. Same-project foreign-lane
  Node write source returns0 with empty streams, while a shell redirect to the
  identical target returns2 naming the different session. An unquoted Node
  heredoc containing a shell touch substitution also returns0 once the unrelated
  JavaScript arrow is removed; quoted and unquoted bodies cannot share the same
  expansion rule. Submitted bodies are not executed. A computed-write fixture
  using process.argv[1] supplies no argument in its header, so its empty guard
  result does not establish a concrete foreign target. Separate retained
  finite-target-controls/finite-computed-write-{plain,arrow} witnesses supply
  that target: root independently decodes the fixed ASCII list as data and
  matches the sibling sentinel path. The plain guard returns0; adding the arrow
  returns2 solely for fabricated nesting. No submitted body executes and the
  sentinel stays unchanged. The original missing-argument limitation remains.
  Peer artifact-verification-finite-target-controls.json records15 checked guard
  invocations; root inspects the two corrected commands, raw scan/guard results
  and target identity. These observations retain the A6 effect/expansion
  obligation and A5/A7 native-context limits; they do not advance coverage or
  acceptance.

- E186: The parent imports the exact two helper/test files from closed
  `437032e13a73cd6e329103109b439f70fccbfe2a`; SHA256 values are
  `f9eb668efbf07558c62b20860eba6ee3b932d0a7986c44a2bef684ebf632ada5` and
  `04d1627c412c348c5677dbb9f980760ec64ed1f869e08ce02c06f472ade7ef7b`. Engine
  entry supplies the optional cache port with its existing single frame
  reader/writer. Dispatch awaits finite source/input/identity admission and
  capture after Ready/grant and before compatibility/composition. Unsupported
  profiles or a received no-publication decline use full compatibility once;
  unavailable capture remains diagnostic and guards continue; a lost exchange
  fails without replay. Empty and fully reprieved selections retain the prefix.
  Missing/unsafe supplied identity never becomes resolved fallback identity for
  native publication; unsafe input retains the full parser's diagnostic path.

  `root-cache-engine-final-tests.stderr` records354 checks across7 suites,
  including17 routing checks, with strict production compilation. The final
  package build checks runtime assets/surface registry and completes. Actual
  package-cwd lint parses all5 changed JavaScript/TypeScript files with0 errors,
  warnings or ignored-file results. The first lint's missing timer globals and
  wrong initial TypeScript config attempt are retained; explicit Node timer
  imports and the owning `tsconfig.vnext.json` resolve them. Earlier routing
  failures remain: a first refusal legitimately arms the latch, so independent
  fresh-state fixtures and normalization of their absolute diagnostic paths
  replace a false byte-equality assumption; the framed test reads the actual
  response.result field. Production behavior is not changed for those oracles.

  `root-cache-engine-final-native.stderr` records5 actual native scenarios after
  the package build, with12 unselected checks explicitly skipped by the focused
  command. Their artifacts live in `cache-engine-final-cases/` under the E182
  root. Each retains `native-receipt.json`, original input, stdout, stderr,
  private runtime, resulting cache/journal files and native cleanup receipts.
  Executable SHA256 is
  `9f74887819973cf5ee23612ea16e488b39b8ee554701f612bf0488df355c1cf1`;
  engine-entry SHA256 is
  `6d19dcc91764e6dfcbe0ec583c9a5d6447e3eaac833c1ab7a4f3c16365115984`. Selected
  private runtime is
  `ef2d1eb1b2f0cc4d9528a158fa32eb75ecd2e06286ab955fc83ae8440dcdef40`.
  - `cache-engine-Wmrr28`: empty-chain capture exits0. The native envelope and
    pointer retain only supplied `cache-fixture`, canonical fixture root and
    configured PreToolUse despite a forged payload event. The retained original
    observation hashes envelope
    `6cb20da7aed8a6d9723f1fad55275a4139c65d5abfec4e41e088d978e24246f1` and
    pointer `15c2b3b7a0da53e524504443167d4ff8a1ac572c43e5dfcfe46eb5a36a4321d7`.
    An actual compiled CLI `message status --mine --queued --json` with no SID
    environment exits0 and reports read_only/me=cache-fixture. Direct resolver
    observation identifies durable_hook_envelope attribution, but caller
    resolution fails and ownership candidates reject the uncorroborated cache. A
    separately seeded foreign envelope/pointer control cannot displace an
    explicitly pinned caller. `native-cache-observation.json`,
    `downstream-cli.stdout` and `downstream-resolver.json` retain these
    boundaries; the pointer is deliberately changed only after its original
    observation.
  - `cache-engine-osZ6fF`: capture precedes a real stock guard refusal, exit2;
    the supplied destructive command is hook input and is never executed.
  - `cache-engine-Wxf4Sk`: the native old-envelope profile declines an unused
    numeric member; full compatibility exits0 and preserves created_at
    `2000-01-02T03:04:05Z`, with one compatibility completion.
  - `cache-engine-iLM1Gv`: missing supplied SID exits0 without envelope, pointer
    or a directory for inherited foreign-cache identity.
  - `cache-engine-rC0A1S`: a real pointer-directory rename failure retains the
    published envelope and pointer directory, reports partial publication in
    stderr, and still delivers the stock guard refusal, exit2.

  The five custody journals retain monotonic started/pending/complete records;
  the empty-chain terminal records child exit0, both EOFs and successful
  settlement. These are source-bound private fixtures, not independent live
  process-absence observations, complete import/PATH/Python-profile closure,
  full stock heartbeat replay, installation, thirteen-session/four-repository
  load or parent acceptance. Root retains those obligations. Feature coverage
  stays31/37 and acceptance0/8.

  A separate final numeric-occurrence control corrects the direct engine
  fixture's decoded unused field to match its last JSON occurrence, then sends
  the duplicate-member bytes through the actual native/compiled-entry path.
  `root-cache-duplicate-control.stderr` records2 selected passes and16
  explicitly unselected checks. Under
  `cache-engine-duplicate-control/cache-engine-lApwLu/`, original input SHA256
  `e0599a25893e66e434b835d21b33f7055181bc35b91a6387c868121915310388` contains an
  earlier numeric member overwritten by a string. Native exits0, no
  session_cache_completed record exists, full compatibility completes once, and
  the actual parser writes the session envelope. This earns the original
  token-admission route without relying on an inconsistent injected request.
  Runtime source is unchanged; final test-file lint parses with0 diagnostics.

- E187: A read-only peer inventory of the compiled E186 entry reports165
  first-party modules/assets and165 corresponding sources,290 visited modules or
  assets,776 resolved static edges and7 external package roots. Packet
  `/Users/darianrosebrook/.codex/artifacts/01a15984-840d-7301-a25a-7e681fd83b29/native-application-closure-001/`
  retains inventory SHA256
  `9bdc494139db32bc6e3fce303476cadd0a2043b2f7a44324f4f53661e05d3be7`,
  command/raw streams, resolver methods and source/boundary readback. Root
  inspects entry/method/summary and structured readback: Node22.19 resolves
  without loading the application; reported source identities match55a6b96a.
  Forty emitted JSON assets differ in bytes but retain selected Node values/key
  order. Participating package trees cover594 regular files/2,395,659 bytes with
  no reported tree gaps. These are observed inventory facts and peer
  comparisons, not adopted expected identities or root reexecution of every
  comparison.

  Zero unresolved literal imports are distinct from42 filesystem/codegen inputs
  and one Ajv generated-function site. Root must classify those boundaries from
  owning source; a separate read-only peer traces Ajv schema/options/code
  inputs. Only5 transcript code modules are reached, not the unintegrated
  adapters. The qualifier's verifyTree requires complete recursive
  source/dist/dependency trees, so reachable subsets cannot replace them. Root
  owns complete-tree reviewed identities, dynamic/import policy,
  PATH/Python/native image closure and fresh full-stock heartbeat replay. No
  application/handler execution, held custody, installed activation or ordinary
  workload follows from this inventory; sealedClosure is explicitly false.

  The next separately scoped adapter-registry proposal preserves historical
  first-match-even-empty, source_harness and per-harness state/context failure
  boundaries, with explicit DSH decoding/profile inputs. It is a composition
  prerequisite within covered adapter rows, not renderer/R09 production parity
  or additional coverage. Admission/binding precede writes; root retains parent
  import and actual renderer/cache/writer obligations. Coverage stays31/37 and
  acceptance0/8.

- E188: The Ajv input-boundary trace identifies a concrete dependency defect,
  not caller-supplied schema/code injection. Root inspects
  `src/kernel/evidence/validate.ts`: read-side envelope errors do not stop the
  later payload lookup, and its ordinary object admits inherited event-name
  properties. Actual compiled baseline `root-ajv-inherited-key-baseline.jsonl`
  records constructor/toString throwing `schema must be object or boolean`;
  `__proto__` remains rejected as an unknown event, so this does not establish
  an admission bypass. Both exact source/test paths have clear contention and
  are admitted through the parent scope CLI.

  Own-property schema selection confines code generation to declared release
  schemas. The new focused kernel test first fails6 inherited-key cases while
  its declared-payload control passes; the red output remains in
  `root-evidence-schema-red.stderr`. It checks the actual compiler boundary for
  `__proto__` as well as typed errors for inherited functions, repeats lookups,
  and retains valid/invalid declared payload controls. The repaired full kernel
  run records808 checks/35 suites in `root-evidence-schema-kernel.stderr`.
  Package rebuild and kernel typecheck exit0; actual2-file lint has0
  diagnostics. `root-ajv-inherited-key-repaired.jsonl` records typed
  unknown-event results without exceptions and preserved declared-payload
  rejection.

  `root-evidence-schema-consumers.stderr` records87 compiled event-store and
  engine checks, including18 routing checks and6 actual native cache scenarios.
  Fresh native files/receipts remain under `cache-engine-schema-repair-cases/`.
  This exercises the repaired dependency with the current application; it does
  not qualify installed behavior, hostile-schema execution, every codegen/
  filesystem boundary or full-stock/load/cutover parity. The E187 inventory and
  peer Ajv source trace retain their earlier identities; root must refresh the
  changed application identities before the next reviewed-profile qualification.
  Coverage stays31/37, acceptance0/8, and the full goal remains active.

- E189: Root checks the qualifier's required executable/file list against
  `dist/index.js`: selected CLI execution adds commander/chalk beyond E187's
  engine graph. Neither a refreshed CLI graph nor a combined reviewed profile
  exists. The peer's proposed CLI inventory is refused before execution;
  `/Users/darianrosebrook/.codex/artifacts/01a15984-840d-7301-a25a-7e681fd83b29/native-cli-entry-refusal-001.json`
  retains the transcribed hook diagnostic and its provenance rather than child
  stderr. Root inspects the retained runner: it names a Node executable and
  reads its bytes for identity, while its write calls target external artifacts.
  Installed recognizer source scans a named interpreter script for any write
  verb and emits every path fragment; the guard treats a foreign-repository
  literal as a refusal without argument-level read/write attribution. This
  establishes the conservative source mechanism, not a byte-exact replay or an
  attempted foreign write. The runner remains unexecuted; no alternate command,
  reprieve or installed modification substitutes for resolving the guard
  boundary. Read-only source classification can continue. Root retains the
  combined qualification outcome and reserved-owner coordination obligation;
  coverage and acceptance do not advance.

- E190: Root imports exact committed source/test bytes for Qwen39941e8c,
  Kimi346d5044, DSH1cde1d30, OpenCodee968dcaa and Zcode5b81b7ae after all ten
  exact paths report clear contention and audited parent scope admission.
  `transcript-parent-adapters/import-readback.json` under the root artifact
  directory records each full source commit and SHA256, equality with main,
  parent-before697b9719 and the absence of renderer integration/AC recording. No
  branch-history replay or foreign lane mutation occurs.

  Before import, the parent's strict transcript compilation and106 existing
  checks pass. The imported combined source compiles with the parent's current
  helpers and passes165 checks on actual Node22.19 and18.0. Raw compile,
  baseline, per-version test and build streams plus ten-file zero-diagnostic
  `lint.json` remain in the same artifact directory. The package rebuild exits0.
  Controls exercise lossless scalar/null and Unicode distinctions, stateful
  matched-empty rows, source/context custody, partial tentative projection and
  failed-projection rollback. These are compiled component checks against
  synthetic inputs, not a fresh root Python differential, acquisition/registry
  consumer, rendered output or installed/native harness observation. OpenCode
  supplies declarations and zero row adapters. R09/R18, selected interpretation,
  registry/acquisition/cache/writer integration and complete qualification
  remain owed. Parent source import advances integration within already covered
  rows; coverage remains31/37 and acceptance0/8.

- E191: The peer's `native-application-boundaries-001.json` classifies all42
  recorded filesystem/codegen input sites:11 mutable operational data,9 mutable
  policy/repository data,15 executable-selection/installed-identity sites,5
  release-schema compilation sites and2 generic Ajv compilation capabilities.
  The separate generated-function site remains explicit. Two js-yaml load calls
  are parsers, not module imports. Root verifies packet SHA256
  `985f2ee1ad94cb7371312bcff65d86722d53a7739b16209677e7a094d65b5497` and exact
  one-to-one inventory coverage in
  `transcript-parent-adapters/boundary-classification-readback.json`; it does
  not independently reexecute all peer source comparisons.

  Root inspects the selected CLI chain: index imports config, config eagerly
  imports detection and detection imports fs-extra. Config also exports two lazy
  loaders that require project/legacy/template-derived paths. The named
  functions have no other named source caller in the inspected tree; this does
  not exclude computed/aliased or later consumers. Engine-only package trees
  therefore cannot identify the selected CLI, and static capability is distinct
  from observed execution. Complete engine/CLI union, loader-policy
  reachability, held executable/import custody, mutable-state authority and
  fresh post-import whole-tree identities remain owed. The classification
  neither executes the refused inventory nor adopts a profile or proves
  native/installed closure.

- E192: The closed registry component c69fdfcc is merged as1b264b3f and its spec
  CAWS-NATIVE-TRANSCRIPT-REGISTRY-001 resolves completed. Root reads the
  canonical closed spec, confirms candidate ancestry on main and both exact
  paths clear contention, admits them through the parent scope CLI and imports
  identical source/test bytes. `transcript-parent-registry/import-readback.json`
  records source SHA256
  `fc9e77d35b4b163e7372d2dca09dc5812d6bebf82651e309c8976bdc23c1b7fa` and test
  SHA256 `ed83e1ab4a2c878fadfc241175edf60bfb6ded1a00f286cf0bdd79e5f7cac0e7`.

  Strict parent transcript compilation and186 combined checks pass on actual
  Node22.19 and18.0; two-file lint and package build exit0. Raw streams remain
  in the same root artifact directory. Actual compiled output controls retain
  complete JSON in `compiled-output-controls.json`: matched-empty Qwen wins over
  overlapping Claude text with0 events/commitAllowed true; partial input stays
  tentative/commitAllowed false with unchanged checkpoint; foreign-source input
  refuses source_mismatch; a real tool projection retains integer lexemes
  9007199254740993 and -9007199254740995, original bytes/hash, member path and
  adapter revision. DSH uses an explicitly labeled fixture decoder. These are
  finite compiled registry observations, not ordinary transcript acquisition,
  production interpretation selection, cache/publication, rendering or native/
  installed execution. The peer's51-step Python comparisons and selected mutant
  evidence remain separately identified component evidence, not root reruns.
  R09/R18 and production consumer integration remain open; coverage stays31/37,
  parent acceptance0/8 and the full goal remains active.

- E193: Root retains the remaining R09 work after inspecting peer packet
  `native-sqlite-dependency-choice/dependency-choice.json`, SHA256
  `46cc71688b6a3ec2dc4c3083c95b80eb2471539d009e2d3e9b8fe64ad18d16e0`, and its
  corrected static-build/source excerpts. Root independently reads the
  [immutable upstream sys build](https://github.com/rusqlite/rusqlite/blob/e88f112bef7899234a497baed5cc3c3d553deeb8/libsqlite3-sys/build.rs)
  and [SQLite release metadata](https://sqlite.org/releaselog/3_53_4.html).
  Explicit LIB_DIR still probes pkg-config; prefix selection alone does not
  establish archive custody. Root chooses separately pinned static SQLite3.53.4
  with nonbundled rusqlite0.40.2/libsqlite3-sys0.38.2 and their stable ABI
  subset for a bounded macOS arm64 investigation. Rust dependencies/features and
  Cargo linkage remain unchanged.

  Root acquires the official HTTPS amalgamation archive once (HTTP200, 2,946,650
  bytes). `native-sqlite-source/source-readback.json` records archive SHA256
  `1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d`; the
  actual9,515,341-byte C file matches the official SHA3-256
  `67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16`. Header
  SHA256 is pinned from that archive; it is not byte-identical to the embedded
  header, and `embedded-header.diff` retains the differences. The initial
  wrong-delimiter probe failure remains separately retained; neither source nor
  expected C hash changes to obtain success.

  `native-sqlite-source/static-probe/commands.json` retains11 successful
  commands, minimal child environment and raw streams. Actual Clang21/SDK27
  compilation targets arm64-apple-macos11.0 with thread safety and API armor
  enabled and extension loading omitted. The1,541,032-byte archive SHA256 is
  `5b6d8787f9ae2e1db478d4a67f18a7efda17f340ce197d8e39cac84666241693`. The
  private identity executable reports3.53.4, source ID hash
  bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc and
  threadsafe1. Otool lists only libSystem; nm defines sqlite3_sourceid in the
  executable. Its build metadata records minos11/sdk27. `manifest.json` pins
  observed tools, SDK settings, flags and resulting files; it does not close the
  complete SDK/toolchain image or prove execution on older/other targets.

  This is actual C static-link feasibility, not Rust wrapper/native acquisition,
  SQL execution, snapshot/cancellation, projection, cache/writer/renderer or
  installed parity. The reference Python version-only SQLite observation lacks
  source ID/options/image custody and concurrent-writer evidence. A separately
  labeled disposable reference probe is assigned; a durable typed builder
  proposal must bind reviewed inputs and refuse ambient fallback before parent
  Cargo integration. Root retains those outcomes, R09/R18 remain unreplaced,
  coverage stays31/37 and parent acceptance0/8.

- E194: The assigned disposable reference WAL probe retains successful runs and
  one expected injected reader failure under peer artifact root
  `native-sqlite-wal-snapshot/`. Root inspects the producer's actual connection/
  cursor proxies, writer transaction and ordinary CLI calls, verifies165
  artifact hashes and all3 frozen/current source identities, and checks the
  retained traces/outputs without rerunning the producer. Root readback is
  `native-sqlite-source/reference-snapshot-readback.json`.

  In run20261021T093309Z-0685c526, reader90868 pauses after its first yielded
  row with in_transaction true. Independent writer90901 commits3 mutations
  between the recorded pause/resume. A separate ordinary CLI read while that
  reader is paused sees old-A,old-B,new-C,new-D; original reconstruct then
  returns old-A,old-B,old-C, and ordinary after agrees with the new state. SQL
  trace retains query_only,BEGIN and the parameterized session JOIN. All normal
  child commands exit0; the injected before-pause RuntimeError retains stderr
  and exit1 in run20261021T093300Z-2d0a987c. Eight DB/WAL/SHM snapshots retain
  physical changes, including bookkeeping sidefiles; this is not a zero-write
  claim. Closed-handle refusal and direct child waits do not establish global
  descendant/FD cleanup.

  The separately labeled runtime profile records SQLite3.53.4/source ID, compile
  options, Python/module and readable Homebrew SQLite image hashes; the
  older54-case runtime record remains unchanged. Multiple SQLite-related images
  and unreadable shared-cache paths leave complete active-symbol binding
  unverified. One synthetic, instrumented cursor interleaving demonstrates this
  finite snapshot observation; a single SELECT can materialize rows, so it does
  not prove BEGIN's unique causality. Ordinary concurrent paused-reader,
  malformed SQL/WAL/index, crash/cancellation, native/static Rust acquisition
  and whole publication remain open. This refines reference evidence without
  implementing R09/R18 or advancing31/37 coverage or0/8 parent acceptance.

- E195: Root qualifies the exact nonbundled rusqlite 0.40.2/libsqlite3-sys
  0.38.2 wrappers against E193's observed static archive in the external
  `native-sqlite-source/rust-wrapper-probe/`. `readback.json` retains actual
  command/status and artifact identities. Cargo resolution/fetch/metadata/tree,
  offline single-job build and executable run exit0. All 8 compressed registry
  packages match their resolved lock checksums; 1039 regular tar-member bytes
  match extracted source before and after build. The two wrapper checksums also
  match the independently inspected E193 upstream metadata. The first input
  inspector incorrectly assumed a `.cargo-checksum.json` file; its pre-build
  failure and correction to compressed-archive/member verification are retained.

  The actual feature tree transitively enables sys defaults/pkg-config/vcpkg
  through rusqlite despite both direct dependencies disabling defaults. The
  inspected pkg-config 0.3.34 gate returns before process execution when
  SQLITE3_NO_PKG_CONFIG is set. The explicit library directory, STATIC=1 and
  NO_PKG_CONFIG=1 produce actual build directives `static=sqlite3` and the
  identified E193 archive search path. The resulting executable imports only
  libSystem according to otool and defines sqlite3_libversion/sqlite3_open_v2
  according to nm. Runtime output gives the exact 3.53.4/source ID and verifies
  raw BLOB `00ff`, malformed-UTF8 TEXT `80ff`, INTEGER `9007199254740993`, REAL
  negative-zero bits `8000000000000000` and NULL through ValueRef on one
  in-memory SELECT. A separately compiled empty-prefix control exits101 with
  `could not find native static library sqlite3` and publishes no executable.
  These observations support finite linkage/raw-value feasibility, not a general
  discovery or changed-archive guard.

  Parent Cargo/source and machine selection remain unchanged. Point-in-time
  source/tool/archive checks do not establish immutable compiler, linker, SDK or
  executable-image custody. A durable reviewed-prefix/Cargo guard, actual fixed
  file JOIN, real-product schema admission, row/byte limits, concurrent WAL
  snapshot, cancellation, publication and renderer consumption remain
  root-owned. R09/R18 stay unreplaced; coverage31/37 and parent acceptance0/8 do
  not advance for this private probe.

- E196: A bounded Sol assignment freezes the three actual transcript-store
  owner/module files and retains separate CPython 3.9.6 and 3.11.13 decoding/
  timestamp observations under `sqlite-store-decoding-reference/`. Root inspects
  producer/import/runner source and raw outputs, verifies all 26 artifacts in
  the original and additive manifests, compares frozen files with the parent,
  and checks both interpreter-image hashes. Root's retained readback is
  `native-sqlite-source/reference-decoding-readback.json`; root does not rerun
  the producers. All five bounded probe processes exit0 with empty stderr.

  The 66 common cases agree across both interpreters. Direct BLOB-like JSON byte
  decoding admits UTF-8/16/32 with the observed BOM/detection rules; a supplied
  string with a leading BOM refuses. Non-JSON outer whitespace refuses.
  Surrogate-pass decoding and strict final encoding are separate outcomes. The
  store's millisecond timestamp accepts zero, uses optional microseconds and
  `+00:00`, and preserves binary64 division/rounding: integer `253402300799999`
  yields `9999-12-31T23:59:59.998993+00:00`. The default probe's 3.9 interpreter
  has no digit-limit API and accepts all three 4299/4300/4301-digit controls.
  Explicit 3.11 reports 4300, accepts 4299/4300 and refuses 4301. These are
  labeled probe profiles, not claims about the interpreter selected by installed
  hooks.

  Six additive cases per interpreter preserve actual ord() arrays. Literal
  paired surrogate codepoints in UTF-8/32 BLOB-like inputs remain D83D,DE00 and
  fail strict final UTF-8 encoding; UTF-16 pairs, ordinary astral UTF-8 and
  escaped JSON pairs become 1F600 and encode. A bookkeeping-field control fails
  whole-object encoding while its selected ordinary text encodes. Rejecting all
  such input objects would therefore change ignored-field handling; this
  implication is grounded in the owner's field selection, not an executed
  reconstruct run.

  Existing `parseTimestamp` has different units/zero/output/failure semantics.
  Existing `decodeOccurrence` strips before parsing and uses strict UTF-8;
  existing `JsonValue` strings and JSON.parse string-token handling cannot keep
  two adjacent literal surrogate codepoints distinct from one astral character.
  Preserve raw cells and choose an explicit integer interpretation profile and
  codepoint-capable projection representation before reusing those components.
  The observations exercise actual frozen timestamp and direct JSON operations,
  not SQLite cell conversion, reconstruct, native acquisition, publication or
  renderer behavior. R09/R18, coverage31/37 and parent acceptance0/8 retain
  their previously stated boundaries.

- E197: Root retains a direct Cargo cache counterexample under
  `native-sqlite-source/rust-cache-control/`, with independently checked raw
  results in `native-sqlite-source/cache-control-readback.json`. A new private
  prefix copies E193's authenticated archive. The initial offline single-job
  Rust build and in-memory raw-value executable exit0. The sys rlib's extracted
  sqlite3.o hashes `4f1b3c6b…4873bad`, matching the retained C object.

  After every initial child completes, root empties only that disposable archive
  copy. Rebuilding the unchanged target still exits0, reports
  `Fresh libsqlite3-sys v0.38.2`, retains executable SHA256 `c4d33238…827376f`,
  and runs with identical SQLite/raw-value output. The same corrupted prefix
  with a new target exits101: `failed to add native library` /
  `memory map must have a non-zero length`; no executable exists there. Original
  E193 source/archive bytes remain unchanged. These controls ground the
  cached-byte distinction; a parent build.rs hash of a present archive does not
  identify already embedded sys rlib bytes.

  The parent build coordinator must stage an explicit reviewed prefix before
  Cargo, require an exclusive fresh target, and verify the actual embedded C
  member inventory after building. The selected sys path copies prebuilt
  bindgen_3.34.1.rs; INCLUDE_DIR does not generate Rust bindings, so bind the
  actual prebuilt bytes/features separately from the C recipe's header. Current
  package qualification scripts invoke raw Cargo and render-owner derives
  crate/target paths; route actual callers through the coordinator's returned
  artifacts. Framing inspection and explicit accounting for extra Rust members
  remain owed. No cache bypass, native consumption, immutable compiler/SDK
  custody or parent acceptance is inferred from this private probe.

- E198: Root imports the exact three closed component files from
  `91a64e8bc358f36f57c5daa8df52cfe67ffefb77`, landed by merge `b7319605` and
  close `8bb5e019`. Root reads the closed/completed spec, A1–A4 records and
  matching events10063–10066 plus lifecycle10067–10069; the source lane is
  absent and all three paths have clear contention. Audited parent scope
  admission restores configuration ownership from support to scope.in. The new
  inspector child is separately closed superseded by the parent at10075 and
  ordinarily destroyed at10076, with no source writes or acceptance passes. Root
  inspects that actual spec/disposition and accepts the remaining work; exact
  guard/claim evidence is retained under `native-ar-inspection-disposition/`.
  The effective rejected hook actor is not exposed, so parent-session
  attribution remains unverified.

  `sqlite-static-build-parent/import-readback.json` verifies candidate/main/
  imported bytes. The ordinary parent package build exits0 and emits the helper
  plus all 22 transcript modules; focused Jest55 checks each on actual
  Node18.20.8/22.19.0 and scoped lint exit0. Tests exercise request/file
  refusals and real process failure/abort/deadline/output boundaries, without
  substituting tiny fixtures for authenticated SQLite. A fresh explicit parent
  compiled-helper call executes all six actual steps exit0/direct-child-reaped
  and produces archive1541032 bytes SHA256 `5b6d8787…6241693`, matching E193 and
  both final child host roots. Root verifies every returned artifact size/hash.
  Raw argv, channels, versions, compiled-module hashes and host receipts are
  retained in `sqlite-static-build-parent/checks-readback.json` and its cited
  files.

  Child review's final-directory-await cancellation counterexample is retained;
  root inspects the repaired cancellation/deadline check immediately before
  completion-link dispatch. After-dispatch cancellation, hard OS I/O deadlines,
  immutable tool/SDK images and descendant quiescence are outside this claim.
  Node18.0 actual helper execution is historical child evidence; its Jest
  precollection failure remains retained, and parent Jest validation uses
  18.20.8. Every helper result remains NOT_ADOPTED, including reviewed-pin
  match. Tooling/package emission does not replace native acquisition, renderer
  consumption, installed selection or a Python production path. R09/R18 remain
  unreplaced; coverage31/37 and parent acceptance0/8 do not advance.

- E199: Root implements `tooling/ar-archive.ts` and hostile checks, and replaces
  the imported builder's private archive parser with that inspector. The pure,
  bounded API supports regular BSD extended-name framing only. It validates raw
  ASCII before decoding, complete headers and stored bounds, names/padding,
  duplicate names, alignment and exact consumption. Frozen ordered inventories
  retain all member/range hashes, including ordinary metadata; no suffix or
  Mach-O magic grants a member role or native admission. Shared backing is
  refused through intrinsic view coordinates. Private snapshot allocation and
  independently allocated returned bytes prevent backing-store aliasing.

  The retained red control mutates a returned ArrayBuffer and changes retained
  `PAYLOAD` to seven zero bytes in the initial pooled-copy proposal. Unpooled
  private allocation and independent return allocation repair that defect.
  Ordinary package emission, scoped lint and121 focused checks on each actual
  Node18.20.8/22.19.0 exit0 on source52a5ec67/helper1855b175/test515532ac.
  `ar-inspection-parent/` retains every red/green/candidate command, raw
  channels and source hashes. Actual Node18.0 inspection and candidate Node22
  inspection inventory the retained C archive's2 and Rust sys archive's4
  members. Both C payloads are1532664 bytes SHA256 `4f1b3c6b…873bad`; the76-byte
  Rust member name has no terminating NUL. Other Rust metadata and codegen
  members remain unadmitted. The current source/compiled hashes match the
  repaired full-helper packet; candidate-readback verifies returned host
  artifacts and channels. The positive strict-builder host call retains all six
  real steps exit0/direct-child-reaped and archive SHA256 `5b6d8787…6241693`,
  always NOT_ADOPTED.

  Peer A's one old-helper control changes only raw member-name byte8348 from
  0x73 to0xf3. The object and index remain identical; the old helper wrongly
  completes all six steps and publishes completion. One authorized repaired
  repeat produces byte-identical before/after archives but refuses
  `invalid_name` at8348 after compile/archive exit0. Completed and pending
  markers are absent; failure retains uncertain writer state. Root executes the
  inspected read/hash/assert portions of both packet verifiers without writing
  peer artifacts or rerunning producers:37 old and28 repaired files verify. Root
  readbacks are in `ar-inspection-parent/`; peer packets are
  `native-sqlite-ar-name-control/` and its `-repaired` sibling under chat
  `01a157bd-8bb6-7fc1-9322-6120a73b5a72`'s external artifact root. A retained
  verifier attempt incorrectly expected the persisted failure receipt to include
  its own returned path; the corrected comparison checks the exact null/path
  difference, without repeating the helper invocation.

  This repairs observed framing and memory custody, not compiler provenance,
  complete tool/SDK identity, Cargo admission, descendant quiescence, native
  acquisition or installed behavior. R09/R18 remain unreplaced;31/37 qualifying
  replacement coverage and0/8 parent acceptance do not advance.

- E200: Root grounds peer A's actual SQL-cell reference packet
  `native-sqlite-cell-reference/runs/20261021T105551Z-cc25e5a0` by inspecting
  producer/verifier and executing its read/hash/assert body without peer writes
  or producer replay. Root
  `native-sqlite-source/reference-sql-cell-readback.json` retains426 file/hash
  checks. The304-file manifest is SHA256 `2ce53ac2…6ba44`; the pinned producer
  is490cf2c0. Actual CPython3.11.13, integer limit4300, Unicode14 and
  SQLite3.53.4 execute18 cases:9 payloads in each TEXT/BLOB storage class,
  through frozen ordinary `transcript-store.py`. Synthetic TEXT-affinity DDL
  uses explicit TEXT casts or BLOB bindings; the diagnostic raw-byte connection
  is separate and closed before owner execution.

  Eight cases project and replace prior output; ten fail and preserve it. Each
  database's physical/logical bytes remain unchanged and projection temp files
  are absent. TEXT strictly decodes UTF8 before JSON; BLOB permits Python's BOM
  encoding detection. A UTF8 BOM fails TEXT JSON but succeeds as BLOB; UTF16/32
  BOMs fail TEXT SQL decoding but succeed as BLOB. Literal surrogate bytes fail
  TEXT decoding; a visible BLOB surrogate pair fails final UTF8 publication,
  while the same pair in ignored bookkeeping permits ordinary visible output.
  Invalid UTF8 and array roots refuse at their respective owning layers. The
  earlier incomplete105340Z packet and image-closure limitation are preserved;
  readable-image observations do not authenticate every CLI child's symbol
  binding. These synthetic cells do not establish product DDL, malformed
  ID/time/message-data behavior, the3.9 profile or native acquisition.

  The approved `CAWS-STORE-JSON-001` component is active and bound to peer A's
  `store-json` lane, with exactly decoder/test paths. It must require explicit
  CPython3.11.13/4300 selection and caller bounds, preserve SQL class, codepoint
  strings/keys and numeric tokens, and distinguish resource/encoding/syntax/
  integer-limit failures. This assignment confers no installed profile choice,
  generic AST change or projection/publication authority. Root retains semantic
  numeric operations, store timestamps, both-cell decoding order, visible UTF8
  publication, native acquisition and consumer integration. The component is
  unfinished;31/37 coverage and0/8 parent acceptance remain unchanged.

- E201: The next coordinator boundary is grounded against parent source at
  `2c10ed5b`. `packages/caws-native/Cargo.toml` has no SQLite dependency;
  `build.rs` compiles only the existing process-group/comm/oracle C helpers.
  Neither the external wrapper probe nor the tooling import integrates SQLite
  into that crate. `packages/caws-cli/package.json` has four direct Cargo build
  commands: containment, services, render-build and substitution. Render-load
  inherits render-build. Ordinary CLI compilation emits tooling without
  compiling native code.

  Root owns the next finite implementation across a pre-Cargo coordinator,
  entry/tests, pinned crate dependencies and defensive build check, those four
  package callers and actual artifact consumers. Render owner, legacy renderer,
  services and containment derive conventional target paths; the ordinary
  `render-qualification-harness.ts` branch does too. Its capture-only explicit
  paths do not cover ordinary rendering. Substitution already accepts an
  absolute native path. All must consume verified coordinator-result paths;
  copying a candidate into the shared conventional target would restore the
  bypass.

  The coordinator must admit an explicit reviewed archive/header/target/recipe
  and Cargo lock/features/pregenerated bindings profile before launching Cargo,
  copy and verify the prefix into a newly owned root, and require an absent,
  exclusive target directory. The parent build script can defend its own
  execution but cannot guard dependency compilation or an entirely cached
  invocation. Controlled static-library environment, bounded child handling,
  post-build sys-rlib C-payload verification and input rechecks must bind exact
  returned artifacts. E199 supplies framing, not that profile or admission.
  Source review identifies this contract; no new build or runtime probe is
  inferred. The coordinator, native integration and consumer changes remain
  unfinished; coverage31/37 and acceptance0/8 retain their bounds.

- E202: Root imports exactly the two closed/completed store-JSON files from
  `a9420ad8bac757a55a93a61ace022af4b5621375`, merged by `e0251713` and closed at
  `a4d1e1e2`. Actual spec A1–A4 pass records and matching events10107–10110 plus
  closure/merge/destruction10111–10113 are inspected. Source paths have clear
  contention and audited parent scope admission. Both imported file hashes and
  unchanged CodepointText/JsonNumber dependencies match the candidate and
  canonical source; `store-json-parent/import-readback.json` retains them. The
  opt-in decoder replaces a bounded part of the original store's two
  `json.loads` operations at lines56–57, while their production callers remain
  unchanged. This qualifies R09 as a partial replacement slice and raises
  coverage32/37 (86.5%); parent A1–A8 remain open at0/8.

  Root inspects the frozen differential producer and executes the inspected
  portable verifier's read/hash/assert body, omitting its peer-output writes.
  `store-json-parent/reference-readback.json` verifies77 file references,
  source/producers/profile/input/outcomes and actual lifecycle events. The
  retained794 cases include244 semantic carriers and550 error categories,
  agreeing with the pinned CPython3.11.13/Unicode14/int4300 reference on actual
  Node18.0/18.20.8/22. Four selected mutants are detected by13/22/10/6
  differences; this is finite negative-control evidence, not a mutation score.
  Initial assertion/lint and incomplete wrong-executable-path attempts remain
  retained. Original child compiled modules were not frozen before teardown;
  isolated compilation reconstructs byte-identical modules matching executed
  provenance. That reconstruction is explicit and does not establish original
  process-image custody.

  The ordinary parent package build exits0 and emits the imported module; parent
  compiled-module/dependency hashes match the executed child pins. Parent70
  focused tests on each Node18.20.8/22 and scoped lint exit0. A fresh
  parent-compiled Node18.0 replay of the same794 retained cases has zero
  differences; it does not claim Node18.0 Jest execution. Exact commands,
  source/module pins and raw channels are in `store-json-parent/`; the build
  command/output is retained in this chat's execution transcript. These checks
  exercise strict TEXT versus BLOB encoding, complete decoding before JSON,
  codepoint string/key distinctions, numeric tokens, duplicate-key semantics,
  integer admission and caller resource bounds. They do not establish ordinary
  SQL acquisition, host-stack/allocator equivalence or exact error messages and
  offsets.

  Source inspection identifies a concrete projection boundary: StoreJsonObject
  has CodepointText keys but the same object tag as generic JSON. Generic
  `isJsonObject` accepts that tag while `getMember` compares JS strings and
  misses these keys. No production consumer imports the new decoder. Root
  therefore owes an explicit store-AST access/schema/projection contract; a cast
  to generic JsonValue or unchecked JS-string conversion cannot supply it.
  Installed profile choice, both-cell decode/admission order, timestamps,
  visible UTF8 publication and native/renderer consumption remain open.

- E203: Root grounds the actual SQL timestamp reference packet
  `native-sqlite-timestamp-reference/runs/20261021T120628Z-d8b90120` under peer
  A's external artifact root. The full producer, verifier and separate
  post-observation datetime capture are inspected. Root executes the inspected
  verifier's read/hash/assert body with explicit CPython3.11 `-I -B`, omitting
  peer-output writes. Root `store-timestamp-parent/reference-readback.json`
  retains497 manifest-file/507 reference checks, including30 independent
  read-only source-cell queries. Producer SHA256 is `ba6b3e02…1c6990`; manifest
  SHA256 is `a77b0691…0e8193`.

  Thirty synthetic no-affinity timestamp bindings reach the frozen ordinary
  fixed-query CLI. Seventeen cases project output, seven return caught
  ValueError/OSError JSON receipts, and six escape as OverflowError tracebacks
  with empty stdout. All13 failures preserve prior output; all30 databases
  retain physical/logical bytes and no projection temporary entries remain.
  TEXT/BLOB/NULL timestamps produce null; bound NaN is retrieved as SQL NULL.
  REAL negative zero retains its binary64 sign in the retrieved cell. Half a
  microsecond rounds to zero while the next higher input rounds to one
  microsecond. Integer max-calendar milliseconds produce `.998993`, whereas
  nearby REAL milliseconds produce `.999969`. Those inputs differ; this pair
  does not falsify premature integer conversion. The exact-division requirement
  is separately source-grounded in E204, and its check must compare quotient
  bits beyond2^53 rather than only calendar-error categories. i64 extrema return
  ValueError; the observed finite/time_t cases distinguish caught OSError from
  escaping OverflowError. These are concrete cases, not a derived full-range
  classifier.

  The batch pins Python/SQLite and frozen source but omits pre-execution
  `datetime.py`, `_datetime` and OS identity. The separate
  `post-observation-20261021-datetime` capture matches current module/executable
  bytes and E196 identities on macOS26.6.2 arm64. Root verifies those files;
  POST-OBSERVATION-ONLY remains explicit and does not attest prior children or
  their active libc/datetime images. No ordinary CLI replay or producer rerun is
  inferred from readback.

  Root retains the store-timestamp contract decision. The proposed two-path leaf
  must preserve SQL-class dispatch, explicit opt-in profile, i64 true division,
  REAL binary64 rounding and distinct ValueError/OSError/OverflowError outcomes.
  Governing conversion/platform range behavior must be grounded before
  implementation; finite outputs cannot supply arbitrary error thresholds.
  Subsequent component qualification must pin datetime/platform identities
  before execution. No new source/spec is authorized by this reference entry,
  and no installed profile, native acquisition, product DDL, renderer or full
  cleanup claim is earned. Coverage32/37 and parent0/8 do not advance.

- E204: Root adjudicates the timestamp leaf as two pure stages: prepare tagged
  SQL cells under an explicit opt-in numeric/profile contract, then finish a
  supplied typed UTC-calendar result. Message
  `30c358c1-06f8-4923-b826-69cf9428ab77` authorizes peer A to create/claim a
  bounded component in exactly `src/transcripts/store-timestamp.ts` and
  `tests/transcripts/store-timestamp.test.js`, both under `packages/caws-cli/`.
  Both paths are contention-clear at approval; creation must recheck ownership.
  No default selection, generic AST/config, Cargo or native change is assigned.

  Root inspects tagged CPython3.11.13 source: integer division rounds the exact
  rational once
  ([long_true_divide](https://github.com/python/cpython/blob/v3.11.13/Objects/longobject.c#L3742));
  REAL division uses binary64
  ([float_div](https://github.com/python/cpython/blob/v3.11.13/Objects/floatobject.c#L599)).
  Preparation preserves i64 input and produces exact signed64 seconds plus
  normalized microseconds. Fraction rounding and range-error ordering follow
  [PyTime](https://github.com/python/cpython/blob/v3.11.13/Python/pytime.c#L224).
  Nonnumeric SQL classes return null without coercion. Qualification must
  compare intermediate quotient bits for i64 values beyond2^53, rounding ties
  and carry/ borrow, as well as final results.

  A required future native calendar port supplies UTC fields or a typed OS
  failure; there is no guessed Darwin range model or default JS Date. The leaf
  keeps OS failure precedence, leap-second clamping, date validation and UTC
  formatting aligned with
  [datetime construction](https://github.com/python/cpython/blob/v3.11.13/Modules/_datetimemodule.c#L4701).
  Separate stages leave asynchronous I/O and cancellation with the caller.
  Contract/transport failures must remain distinct from reference
  ValueError/OSError/OverflowError. Prepared values grant no source authority.

  Root retains actual gmtime/errno/locale and native-image qualification, SQL
  acquisition, async/cancellation integration, projection/publication and
  installed-profile choice. The C-int extreme-year addition/error-text band is
  unqualified; neither source review nor E203 establishes every Darwin result.
  Subsequent differential qualification must capture datetime/platform
  identities before and after execution. Component commit, fresh read-only
  review, normal emission, Node18 floor/22 checks, negative controls, gates and
  dual acceptance readback precede import. This decision does not establish
  implementation or alter32/37 partial coverage or0/8 parent acceptance.

- E205: Root verifies timestamp component candidate
  `3405ada0fce0ff86ba28d7239077be789cb99e49` is an ancestor of `main` and reads
  closed/completed `CAWS-STORE-TIMESTAMP-001`. The candidate contains exactly
  the two E204-approved paths. Its source SHA256 is
  `a188a54d56e9213a67a6f506e5c5501109eb636194eb72ea5f6847f722abe262`; its test
  SHA256 is `69d7c05f06072bd1bd08348757a0d813bb96615c519c1cfb3837a3988241b65a`.
  Component acceptance A1–A4 records cite that exact candidate; component
  closure does not discharge parent acceptance. Qualification excludes the C-int
  extreme month-addition mechanism; the helper explicitly refuses the upper
  year-addition band. Finite arithmetic qualification limits remain.

  This checkpoint establishes component source landing on `main`, not parent
  import. Parent artifact verification, source import and integrated checks are
  pending. Root owns the actual native UTC-calendar/errno port, asynchronous
  transport and cancellation, SQL acquisition, explicit profile selection,
  store-AST/schema projection, publication and renderer integration. The native
  SQLite build coordinator is in progress and has no completed candidate-build
  observation. Coverage remains32/37 qualifying partial slices (86.5%), parent
  acceptance0/8; no production Python row is retired or machine runtime adopted.

- E206: Root imports exactly the two timestamp component files from E205's
  `3405ada0` candidate after audited scope admission and clear contention.
  Imported source/test hashes match E205. Root inspects and executes the
  retained `native-store-timestamp/verify-artifacts.py`: exit0 re-derives313
  retained hashes, three3673-case comparisons, two84-case synthetic comparisons,
  six semantic controls and the four component AC records. This reads retained
  observations; it does not rerun CPython or native gmtime.

  Parent normal emission produces the retained JS SHA256
  `f0e161b42e3e5ce83a6002b268436a6b6c578e26ca4e152a2735248219197885`. Parent
  build,51 compiled Jest checks and scoped lint exit0. The retained producer
  compares3673 cases against this parent module on actual Node18.0.0 and22.19.0
  with zero differences, including intermediate quotient bits and normalized
  seconds/microseconds;25 upper-year cases explicitly refuse. Root artifacts and
  separate command streams are under
  `native-sqlite-coordinator-parent/timestamp-parent-*` in its artifact root.
  The read-only component source inspection finds no demonstrated import defect
  and preserves the unqualified extreme C-month mechanism.

  This discharges E205's source import and bounded parent checks. Native UTC
  calendar/errno identity, asynchronous order/cancellation, SQL acquisition,
  actual store projection, publication, renderer consumption and profile
  adoption remain root-owned. There is no default calendar callback or JS Date
  fallback. Coverage32/37 qualifying partial slices and parent acceptance0/8 do
  not advance; no first-party Python production row is retired.

- E207: Root implements the reviewed-input native SQLite build coordinator,
  explicit entry and receipt loader. It owns fresh private source/vendor/Cargo
  home/target snapshots, validates input pins before Cargo and around each tool,
  selects actual Cargo JSON artifacts, checks generated binding bytes and the
  embedded C member, and verifies actual SQLite identity and static linkage. The
  optional native feature adds the eight E195-qualified lock packages; existing
  nonparent lock records are unchanged. The private exact identity command
  refuses feature-off or extra arguments without success output. The secondary
  Rust build guard checks the prefix manifest when it runs; E197's cache
  falsifier remains the reason the external fresh target is required.

  Root validates34 cached crate archives against lock checksums and2242 regular
  file bytes. Cargo's vendor view omits22 archive files; the retained before
  report records those omissions and original checksum metadata before root
  restores an archive-exact generated input view. This is byte consistency, not
  upstream authentication. The first actual fresh build exits101 at12 missing
  sibling `include_str!` inputs. Root adds the pinned client and complete11-file
  service-image tree; a source trace finds no additional production sibling
  embed. The Cargo-test input closure has additional siblings and is not
  claimed. The second build reaches actual SQLite identity but refuses
  overflowing1MiB symbol output. Root measures1729611 symbol bytes and selects
  a2MiB request limit within the unchanged4MiB combined retained-output ceiling.

  `host-build-03` completes in72.21s with six actual tools exiting0 and their
  direct children reaped. The loader succeeds on actual Node18.0.0 and22.19.0.
  Native SHA256 is
  `c940b691833d9489dd0ae6b18e1526c05179db5383a54546954a6f24554ef34e`; SQLite
  reports3.53.4, the E193 source ID, THREADSAFE=1, OMIT_LOAD_EXTENSION and
  ENABLE_API_ARMOR. The sys rlib has four strict-BSD members: its exact reviewed
  SQLite object plus three retained UNADMITTED extras. Generated binding SHA256
  is `4f94d0192ec890b62773368cb026daf219f5182094952c007d28ed6d3812fd68`.
  Completed receipt SHA256 is
  `4be1f6019d5af919821b9f22ec2a3e6b917b8fbe2a37e5fa196a3b0ee98b6f63`. Root
  retains121 physical files/29728847 bytes, including staged native source,
  embedded templates, artifacts and executed tooling modules. These are
  post-observation copies; original paths are preserved and no prior immutable
  execution-image attestation is inferred.

  Actual controls preserve an existing completed root with zero child launches
  and reject a changed archive pin before Cargo. A separate real build mutates
  caller metadata after Cargo returns, then aborts after the sixth tool exits:
  the captured request digest survives, all six direct children are reaped and
  no completed or pending marker is published. Failed roots remain uncertain;
  descendant quiescence, cleanup and reuse are not established. The50 compiled
  refusal tests, normal CLI build, scoped lint, feature-off identity test,
  existing invoke-grammar test and feature-off strict Clippy exit0.

  All four direct Cargo package callers invoke this coordinator. Their ordinary
  qualifier consumers load explicit verified native/observer paths, preserve
  receipt identity and enforce profile agreement; capture-only heartbeat input
  selection stays separate. Four existing qualifier compilation paths exit0; ten
  actual missing-request/profile controls refuse before fixture creation. The
  first compile attempt used an absent local TypeScript path; the installed
  workspace compiler succeeds, and both attempts are retained. A combined
  interpreter command is refused by the shell guard as a cross-repo mutation; it
  never executes. Read-only input inspection plus exact file-tool writes
  complete the owned request preparation without changing guard state or the
  existing foreign-owner hold.

  Raw requests, separate command streams, failed receipts, real-child controls,
  vendor readbacks and retained source bytes live under root artifact
  `native-sqlite-coordinator-parent/`; original private build roots remain
  retained. Final source review and committed-candidate checks remain distinct
  from these observations. Fixed-query native acquisition, SQL row conversion
  and failure order, calendar transport, store projection, production consumers,
  release qualification, full toolchain/SDK custody and adoption remain owed.
  Coverage32/37 partial and parent acceptance0/8 do not advance.

- E208: Root reads the frozen ordinary store-reference producer, indices and
  verifier, then reruns its readback: exit0,651 manifest references and39 actual
  CLI observations (12 projected,1 empty,20 caught error receipts,6 escaping
  exceptions). The packet is retained under peer artifact
  `native-store-projection-reference/`; its main and supplemental index SHA256s
  are `9eb6487b462ce03e0eef1bd0a6d2ae21240565274d9ec2ae979134ee612565df` and
  `fb807135eb5057ee9e369cd3edf9bee8ff2aaf153f02da07d36f46f05f1f456d`. Actual
  rivals distinguish earlier timestamp failure from later JSON failure, deferred
  surrogate serialization from reconstruction, later-row TEXT conversion from
  earlier JSON, and same-row TEXT admission from JSON order. Source and
  before/after primary profile pins agree; this is synthetic no-affinity DDL,
  not product schema, concurrent-writer, active-image binding, cancellation or
  universal publication qualification.

  The tagged CPython3.11.13 SQLite cursor source converts all current columns,
  advances the VM once, then yields the current row. Current-row TEXT failure
  precedes its JSON; a next VM-step failure can discard the current row before
  its JSON, whereas next-row TEXT conversion does not. Native acquisition must
  preserve these distinct frontiers. The Python store closes its connection
  before event serialization and publishes before receipt serialization.
  Metadata BLOB receipt failures and invalid TEXT in the remaining metadata/time
  columns are assigned five bounded ordinary-reference controls; they are not
  established by the39-case packet. SQLite readonly WAL may create sidecars;
  readonly base access does not imply untouched WAL/SHM. Native SQL acquisition,
  calendar transport, AST projection and publication remain root-owned and open.

- E209: Root independently inspects and reruns the frozen release packet
  verifier against the E207 candidate `16659cad`, with the E207 source and
  embedded inputs re-rooted to retained copies. The first verifier invocation
  supplies relative paths and refuses its literal marker-path check; the
  absolute-path invocation exits0. This is a verifier invocation error, not a
  candidate build failure. The actual cold release coordinator and loader exit0
  in87.90s and347ms; Cargo uses offline/frozen/locked, jobs1 and a fresh target.
  Actual Cargo JSON reports optimization3 and no fresh cached artifacts. All six
  tool steps exit0 with direct children reaped. Root checks81 source/embed
  files,7 selected artifacts and3026 physical references/188047893 bytes;
  pre/post reviewed input and producer profiles agree.

  Release native SHA256 is
  `aec30179f8c4e3e38bad64fa38d2f5529c1522a7842402b136c797ca29c19438`; completion
  SHA256 is `f557f6fe9bb6ec38e92bfdb05cf36c4a0b92ac5faabd5acd93958a924a99b944`.
  Actual SQLite3.53.4/source ID, THREADSAFE=1, required options, generated
  binding, exact embedded C payload, defined native symbol and all three otool
  outputs agree with the reviewed inputs. Three Rust rlib extras remain
  UNADMITTED. Raw failed driver attempts, commands, streams, physical manifest
  and readback live under peer artifact `native-sqlite-release-qualification/`,
  successful run `runs/release-02/`. This discharges one current-host release
  build observation only. It does not qualify ordinary query/render/publication
  workloads, later source changes, full toolchain/SDK/image custody, descendant
  cleanup, reproducible builds, installed execution or cutover. Coverage32/37
  qualifying partial slices and parent acceptance0/8 do not advance.

- E210: Root inspects and reruns the five-case metadata-reference readback:
  exit0,107 manifest references, exact source/profile pins and ordinary CLI
  streams. Two BLOB-ID cases publish141 event bytes with SHA256
  `d7f683fdbd0b1fa326e61e3d84541c591edb0b069ab18a68243026a0eb914276`, then
  receipt serialization raises TypeError with empty stdout and exit1. The three
  invalid TEXT metadata/time cases refuse before message JSON and retain their
  prior projections. The selected shell source rejects a failed store invocation
  without emitting a projection path or falling back to an old tail; published
  bytes do not establish consumer reuse. Raw controls and verifier live under
  peer artifact `native-store-metadata-reference/`. Root's first verifier
  command used the worktree cwd and could not find the script; the artifact-root
  invocation succeeds. No reference execution was repeated. Publication, receipt
  serialization and delivery require distinct outcomes. Native
  acquisition/projection/transport implementation is in progress;
  product-schema, renderer and publication parity remain open. Coverage32/37
  qualifying partial slices and parent acceptance0/8 do not advance.

- E211: Root implements fixed-query native acquisition, row/UTC transport,
  store-AST reconstruction and strict event encoding in the default-off SQLite
  feature. One connection/cursor survives row callbacks; current TEXT admission
  precedes next VM step, which precedes current-row delivery. i64, binary64,
  TEXT and BLOB custody remain distinct. Progress/busy callbacks check the
  original cooperative deadline, with a1s busy ceiling. First operation,
  finalize, rollback and close outcomes remain separate; failed close retains an
  opaque cleanup owner. This does not bound OS I/O or all SQLite VM memory.
  Native admission is one active dispatched system OpenCode/ZCode Stop attempt,
  original safe session matching Ready, captured database/cwd and correlated
  root/token. It accepts neither supplied SQL nor a database override, borrows
  no cache/render grant and uses the original single reader. The finite
  development profile caps4096 rows,256KiB/cell,16MiB total cells and separate
  8MiB engine control credit; ordinary proposal bounds remain unchanged.

  Typed projection snapshots cells before awaiting, preserves both-cell JSON
  order, timestamp-before-filter, grouping, arbitrary values and codepoints, and
  projects OpenCode fields directly on the store AST. Event encoding follows
  reconstruction and uses Python separators/number formatting with whole-stream
  strict UTF-8. Root repairs a getter/data-property composition mismatch and
  retains exact transport causes, independent failed cleanup phases and
  confirmed-close state across IteratorClose. Hostile composed controls assert
  both causes and their concrete sentinel identities; cleanup disagreement
  cannot produce a successful reconstructed result.

  Fourteen real SQLite library controls pass, including next-step integer
  overflow before visitor delivery, all five storage classes, TEXT order, VM
  interruption, busy release/deadline/cancel and panic/cleanup behavior.
  Feature-on strict Clippy, four binary protocol controls, feature-off identity
  refusal, CLI build,171 focused TS checks and scoped lint pass. The first TS
  compile's narrowing error, an incorrectly escaped surrogate-pair test, missing
  Clippy plugin PATH and three repaired style warnings remain retained. No
  parser change or warning suppression manufactures those results. The first
  source commit is refused by test lint: an explicit AbortController binding, a
  consumed-row assertion and an awaited finalizer rejection repair the affected
  controls without lint suppression or changing their oracle.

  Fresh coordinator `build-03` completes all six tools with direct children
  reaped. Native SHA256 is
  `f3faa7fd32e2eb7902db65d7732e13d98027262bdefd7ba363b7a37b6289e541`; completion
  SHA256 is `265a60894df886dedc05a4dba40afa80ac051c86b2287f2c97b00879c99b54a4`.
  The separate manual test workspaces do not claim coordinator admission. Raw
  checks, input snapshots, requests and failed attempts live under root
  `native-store-acquisition-draft/`.

  The repaired native-entry fixture replay `store-replay-02` has44 cases: 13
  ordinary success/empty event streams match exactly,29 expected failures remain
  failures, and two BLOB metadata streams match event bytes while their later
  receipt stage remains unimplemented. It retains265 known loaded-module images
  before execution and701 directional wire records; every case contains a native
  CLOSED frame, and child-reported loaded modules match retained pins. Input
  pins and all synthetic DB bytes agree before/after; no sidecars appear.
  Summary SHA256 is
  `89eb156e046d0721575acf8280b6ef9147ed4dcbeeee38335f5c742b9e73e313`. The
  original `store-replay-01` and its offline29-case reference-frontier audit
  remain historical evidence. Cleanup repair changes its selected JS pin; the
  failed custody readback and incomplete original image retention are retained,
  not relabeled as the repaired candidate. A repeated verifier refuses its
  existing output without overwriting it. Raw ACKs do not independently attest
  every SQL handle or process descriptor. Neither replay establishes complete
  exception diagnostic parity, ordinary stock selection, publication, renderer
  consumption, live WAL, async/global cleanup, full toolchain/SDK custody,
  release qualification of changed source or installation. Production R09/R18,
  32/37 qualifying partial coverage and0/8 parent acceptance remain open.

- E212: Native post-acquisition errors preserve their owned settlement through
  frontend error delivery. The row-exchange branch previously returned only its
  transport string after acquisition had independently observed SQL cleanup;
  failed CLOSED encoding/delivery had the same ownership-loss boundary. A typed
  phase/message plus boxed acquisition retains the first operation failure, each
  cleanup observation and any opaque uncertain connection owner. SQL closure is
  derived separately from delivery and requires successful close, no retained
  uncertainty and no retained owner. The frontend's failure owns this error
  through its final output attempt. This does not establish an OS close
  succeeded when the retained observation says otherwise.

  Sixteen focused SQLite/wire controls pass in fresh `manual-test-06`, including
  real row-control failures, failed CLOSED delivery after successful SQL close,
  and exact independent transport/rollback sentinels across the typed boundary.
  An injected uncertain settlement retains a real private in-memory connection
  and its cleanup-only retry. That control tests ownership transfer, not an
  actual OS close failure. Strict feature-on Clippy, four binary protocol
  controls and feature-off identity refusal pass. The preceding Clippy attempts
  at160 and128-byte frontend errors remain retained; boxing readiness and the
  settlement repairs the representation without suppressing the warning.

  Final coordinator `build-06` completes all six tools. Native SHA256 is
  `ff1e92297d308950c4f9b79ea9ccddb0ea9b3e5d88bdb7683ce5ea016e15fa89`; completion
  SHA256 is `4f5d0a7e28c80f9388a5c9f65c0d1002b87428d9cdad52279ec38dc9441dc16b`.
  Its `store-replay-04` repeats the44 retained cases against this candidate: 13
  exact ordinary event streams,29 expected failures and two BLOB event-only
  comparisons pass within E211's limits. Summary SHA256 is
  `26cb54be4925d9bf0e2ee38ef341b22e25cee139a2676ef20e135f148be05998`. Earlier
  builds04/05 and replay03 remain historical attempts, not final-source
  qualification. Raw commands, snapshots, channels and checks are retained under
  root `native-store-acquisition-draft/`. No publication, stock renderer,
  OS-fault, release/adoption or whole-runtime claim follows. Coverage32/37 and
  parent acceptance0/8 do not advance.

- E213: Human-authorized coordination reaches the existing shell-analysis owner,
  chat `01a151c0-4722-76a0-9814-eb680a4be9b2`; its archived chat is restored to
  deliver the request. The owner explicitly accepts E185's guard concern under
  `CAWS-SHELL-ANALYSIS-001/A6`, preserving its clean4bde1f49 lane. Root reads
  the retained probe source and concrete deployed/parent/held observations:
  benign quoted Node arrow2/2/0, same-project foreign Node write0/0/0,
  equivalent shell write2/2/2. The guard invocations consume inert command text
  under synthetic Bash context; submitted programs are not executed. The initial
  missing-parser attempt is separate. The report at the owner's
  `guard-coordination-20261021/packaged-observations.json` hashes to
  `65bd35f940ff1654866b23992c375d02cf6fd8940e8509f3f79fce6672466017`. Root reads
  back A6 FAIL in both the spec and `ac_recorded` event10189. Accepted remaining
  work is a bounded interpreter effect contract/profile, preserving real write
  ownership checks and distinguishing read operands; body masking or all-path
  hints cannot establish that result. Trusted final launch, effective identity
  and complete routing remain separate adoption prerequisites. This is accepted
  unfinished work, not cutover clearance.

  Publication preflight grounds two additional integration obligations in
  source. `protocol::Request` captures caller cwd/environment/payload, whereas
  the store's root/digest agreement is between engine statements;
  `session_cache` explicitly disclaims independent Git/root resolution. A store
  publication owner must bind its fixed session leaf to an original project
  observation, preserving the selected Git/common-directory mapping.
  `render_owner::Actor` holds writer custody across backend reuse until actual
  retirement/settlement. A separate publisher cannot acquire that lock and
  invoke the actor recursively, or release it before the renderer opens the
  shared projection. Publication therefore needs a separate store permit under
  the compatible existing owner, or truly retained immutable input with
  path-derived renderer behavior preserved. Exhausted success, stopped/failed
  but closed, publication, later receipt encoding and delivery are distinct
  states. These are inspected prerequisites, not implemented publication.
  R09/R18, coverage32/37 and parent acceptance0/8 remain open.

- E214: Root inspects the retained ten-case ordinary publication reference,
  offline verifier, raw closed-output command/stderr and published bytes.
  `native-store-publication-reference/summary.json` remains `incomplete`: exact
  pre/post producer profile equality is unmet. The collector enumerates images
  before calling `platform.platform()`; the later observation adds pyexpat
  without a before identity. Common-image equality and the inferred collector
  side effect do not retrospectively attest that image. No ordinary case is
  retried. The independent audit reports341 consistent references and exits1 for
  the retained unmet requirement; audit SHA256 is
  `9dbf58a47fd397629ac941b76b9cb56b0374a55064c09ea55c9c5338f0856660`.

  Case10 records a pipe reader closed before spawn and exit120 with
  BrokenPipeError after replacement. Root rehashes its121 published bytes as
  `95011de1a155c684f2a5097ba8dae5447d58b0312a253e86672508764bbe8a2a`. Its
  zero-byte stdout artifact means unavailable capture, not an observed empty
  emitted stream. Publication and receipt delivery remain separate facts. Other
  retained cases cover replacement/empty/leaf-link and parent/type/
  permission/name frontiers. Absent or directory prior states must not be called
  preserved prior regular-file bytes; permission restoration is harness cleanup.
  These finite observations inform the publisher contract without earning a
  frozen-profile pass, native parity, crash/concurrency or renderer acceptance.

- E215: Chat `01a157bd-8bb6-7fc1-9322-6120a73b5a72` explicitly accepts the
  coherent R18 preparation outcome. Root reads back active spec
  `CAWS-RENDER-PREPARE-001` and its owned `render-prepare` worktree on
  `caws/render-prepare`, based on parent candidate ecee3218. Actual CLI scope
  and binding remain authority; no prepared implementation is accepted here.
  `prepareSessionArtifacts` must consume actual owned source bytes/read
  observations through selected-profile decoding, registry normalization,
  auxiliary merge, accumulation and complete turn/spill/index encoding.
  Source-occurrence/index/shared-codec changes require verified ownership, not
  an assumption that imported foundations are free to edit.

  The actual reader skips JSON syntax/nonobject rows while strict UTF-8 and
  selected integer-profile errors remain fatal. Generic `decodeOccurrence`
  catches all parser errors and cannot supply that policy unchanged. Complete
  prefix checkpoint mutation precedes tentative-tail parsing; failure retains
  the correct checkpoint. Codepoint/lossless-number values, exact Codex inner
  source, metadata lookup including negative candidates and selected TZ/calendar
  behavior remain dependencies. Ready owns immutable artifact bytes, internal
  spill closure, input observations and proposed removals; it supplies neither
  publication authority nor currentness. Root retains native admission,
  publication, actual-consumer integration and final render-state settlement.

  Source inspection grounds a separate publication consequence: sidecar-first
  replacement can leave an old turn naming H1 beside a new sidecar containing
  only H2 if turn replacement fails. Writer exclusion does not exclude readers;
  SessionEnd reads flat turn files without generation/closure admission. Native
  custody or a prepared artifact list alone cannot establish coherent current
  output. Parent integration must admit captured complete generation inventory,
  including index/spills, or refuse mixed/failed state. An old successful
  receipt cannot make a failed newer invocation current. The
  old-turn/new-spill/failure control must reach the actual reader. This
  obligation remains open alongside selected overrides and output ownership. R18
  is unreplaced; coverage32/37 and parent0/8 do not advance.

- E216: The owned `CAWS-NATIVE-PROJECT-BINDING-001` child implements the
  original-invocation project observer and consumes it in the native store
  exchange before database path resolution, transport credit or acquisition.
  Original raw owned members use last-key semantics without decoding unrelated
  huge numbers or lone-surrogate keys/values. Payload cwd precedes captured
  `CAWS_PROJECT_DIR`, then caller cwd. Caller-selected Git runs with inherited
  `GIT_*`/`HOOK_*` entries removed. Its two queries preserve checkout/common-dir
  mapping, including a real linked worktree. The engine's matching root/digest
  pair must agree with the independently observed physical root.

  Query ownership carries first failure, stop, group settlement, reap and pipe
  outcomes independently of the engine. Source inspection adds actual private
  group settlement before reap; an accepted signal or pipe EOF is insufficient.
  Bounded cleanup refusal retains the actual child for a separate retry and
  final frontend error delivery. The injected stop-refusal control is not an
  observed OS permission failure. Path/hash checks around Git launch do not
  attest an atomic executing image; physical strings do not anchor directories
  against replacement. Kernel stalls, escaped descendants, all lexical aliases,
  complete toolchain/import closure and durable post-owner custody are not
  qualified by this finite development profile.

  Artifacts live under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/native-project-binding/`.
  `check-01` retains21 store and10 query passes followed by strict Clippy101 for
  a224-byte retained error. Boxing ownership/cleanup records preserves custody
  without suppressing the warning. `check-02` retains21 store and13 query
  passes, strict Clippy0, four binary protocol tests0, frontend build0 and the
  feature-off identity-refusal test0. Every selected command reports unchanged
  pinned source/dependency inputs. `project.stdout` records early EOF waiting
  for exit, a pipe-independent descendant's private-group settlement, and the
  actual child retained across an injected stop refusal then reaped on retry.
  `store.stdout` records raw row/UTC/CLOSED values, source SHA equality and
  exclusive-lock reacquisition. These are debug checks, not release receipts.

  `frontend-01` explicitly rebuilds the feature-on frontend after the
  feature-off test can replace the shared debug executable. The executed image
  SHA256 is `1899b66e551300666a8db72429118fcbc2f8ed00b44fcb36fa560d5e004f55e6`;
  the earlier `check-02` summary's feature-off image pin is historical, not the
  selected frontend image. The13-case command exits0 and its summary SHA256 is
  `8f42674299621ded592b82fc69cb93849020540e68ba19d39d03368f642097cf`. Real
  OpenCode/ZCode, linked checkout, poisoned routing, precedence/fallback,
  relative cwd and opaque-extension successes preserve the reference event bytes
  and report exhausted/closed source. Both matching foreign Ready/root cases
  exit2 with zero delivered rows and the exact original-project mismatch; their
  nonexistent database path is never resolved. Invalid owned cwd also refuses
  before row delivery. Raw command/stdout/stderr, SQLite identity, directional
  wire frames, original request, engine Ready/root, close records and database
  pins remain beside each result. No database sidecar appears and the
  source/dependency pins are unchanged. The retained summary includes an
  intentional lone surrogate; Node parses it while jq rejects that profile.

  CLI readback exposes an ownership distinction: `scope.out` rejects edits but
  does not subtract a broad `scope.in` contention claim. Parent native source
  moves to support and the child owns exact source paths through audited CLI
  amendments. The installed copy guard also mistakes an external-proposal to
  child destination for a worktree-to-main copy at its318–337 substring check;
  the canonical checkout is not a destination. Normal admitted file edits stay
  inside the child; no handler, trust state or reprieve is changed. Root retains
  this guard applicability defect alongside the separate E185 owner repair. R09
  remains a production-consumer obligation; coverage32/37, parent0/8,
  publication/receipt/renderer integration and machine selection do not advance.

- E217: Inspecting E216's actual artifacts exposes a missed native consumer
  effect despite its13 frontend scenario passes. The matching foreign root
  refuses acquisition, but fallback uses the rejected Ready digest to create
  `frontend-01/agreeing-foreign-root/budget/state/projects/973a92b76e1e34ed6a07e92973028ec9341f45205a7a3c2385fce1f49fe0a4b2/sessions/sid-on4w45dimv2gsyznonswyzldorswilltmvzxg2lpny/stop-undeliverable.json`
  under the E216 artifact root. Its bytes are `{"consecutive_undeliverable":1}`.
  Root directly inspects that state and the
  `main::fallback -> charge -> BudgetIdentity/StopBudget` consumer; independent
  committed-candidate inspection corroborates the mechanism. Operational
  namespacing is not authority, but a foreign namespace mutation changes later
  Stop release behavior. The original zero-row assertions did not test it.

  The child repair retains native-established project agreement in typed errors,
  including DB resolution/version/credit errors before acquisition. Unbound
  store failures cannot charge the engine-selected Ready namespace. They use the
  existing no-context diagnostic Stop-release policy; exit0 here is not a
  successful store operation, projection, retry or fallback consumer.
  Established-bound failures preserve ordinary budgeting. E216's earlier exit2
  observations remain historical; fresh controls must inspect counter state,
  exact diagnostic release, source rows and the bound-failure rival together.

  `native-project-binding/check-03` retains22 store and13 query tests, four
  binary protocol tests and one feature-off refusal, strict Clippy and frontend
  build; every selected command exits0 with unchanged pinned inputs.
  `frontend-02` runs14 actual frontend scenarios and exits0. Summary SHA256 is
  `4092dd3cc35532992f81740225eee36cea9796c08bf702133c74ce6d5448e5ba`; executed
  feature-on debug image SHA256 is
  `2506126bd8b2279847c8bb8df9a0c28f6622d6fc4aa4413477c00365a4ccd00b`. Matching
  foreign roots and invalid owned cwd deliver zero rows, produce no project
  budget directories/files and emit `systemMessage` with the explicit no-context
  infrastructure Stop release. The valid-project/missing-database rival exits2
  with a block and counter1 under original project digest
  `bbc773889ed6d43b4285408aa1a3254a3028974324557099791693a44632f063`. Each
  result retains its actual budget namespace and counter bytes/hash beside
  command, output, wire and DB observations. Ten ordinary successes preserve
  their reference event bytes and exhausted/closed source. No DB sidecars or
  changed pinned inputs are observed. These controls qualify this store-error
  consumer, not every Ready consumer, all failure phases or full native context
  authority. E216's execution-image/directory/profile limits, production
  publication and renderer consumption, parent0/8 and machine cutover remain
  open.

- E218: Follow-up source inspection of d533d064 identifies a pre-owner route
  around E217's filter: protocol classification rejects a recognized store frame
  above8192 bytes before `serve`, leaving no typed store failure for fallback.
  This is a source-grounded control-flow finding; no old-image oversized-counter
  execution is claimed. Classification forwards recognized frames to the
  single-use owner's existing size refusal. A native-owned `StoreProjectBinding`
  also starts unbound for the original eligible OpenCode/ZCode system Stop
  before frame acquisition. Framing/EOF failures therefore cannot borrow Ready
  state by arriving before the store owner. Actual matching-root observation or
  a typed established-bound failure changes that state; other Ready consumers
  remain parent obligations.

  `native-project-binding/check-04` retains22 store,13 query, five protocol and
  one feature-off test, strict Clippy and frontend build, all selected commands
  exit0 with unchanged pinned inputs. `frontend-03` exits0 over16 scenarios;
  summary SHA256 is
  `1403d82e3721df7b1f4296a46a8f726314ef8cb013aaabcde4d257fd097435ad`, executed
  debug image SHA256 is
  `58de5db0da52f26dc5d71c88d3c7978b7fc96823e233b5422fe84e9ea30ce569`. Its
  matching foreign Ready/root sends an actual8629-byte store body and receives
  diagnostic release with zero rows and no budget directories/files. A foreign
  Ready followed by EOF before any store frame has the same bounded disposition.
  The valid-project/missing-DB rival retains block/counter1 under original
  digest7468a5a0d26350187ff083bcd7b4386b4c3f45510213a6d42523ce7c243af6d7. Raw
  command/output/wire/body-length/budget observations remain beside each result;
  reference event bytes, source closure and DB pins remain stable on the ten
  ordinary successes. E217's14-case pass is historical, not coverage of these
  new routes. Debug source qualification does not establish release, atomic
  path/image custody, complete Ready consumers, publication, installed selection
  or cutover. Coverage32/37 and parent0/8 remain unchanged.

- E219: Read-only inspection maps the committed R18 content API at d12d74a to
  its missing production connections. Engine entry constructs only the cache
  port; the store client has no production caller. Stop/SessionEnd retain
  compatibility selection, stock handlers do not admit session-log, and the
  native render offer covers a selected Codex project override rather than typed
  stock preparation. The actor records no complete artifact manifest.
  Preparation identity/owned bytes are content observations, not an original
  invocation, writer grant or publication permit; its WeakMap checkpoint is
  process-local. Root retains selected-handler wiring, a native publication
  frame under existing continuous custody, single-use exhausted/settled store
  permission, latest-attempt invalidation and complete actual-reader snapshot
  admission including spill/index/removal checks.

  The R18 owner retains an actual4418-byte Codex source counterexample:
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/render-prepare/review-numeric/result.json`
  admits an embedded4301-digit integer under selected4300 and unlimited
  profiles. Root inspects those values and the
  outer-reader/unprofiled-embedded-decoder path. Actual spec/event10265 record
  A1 FAIL; no component acceptance follows from239 earlier checks. Parent
  registry/DSH exact claims move to support by CLI for the owner's scoped
  profile repair. Immutable per-normalization numeric data must reach embedded
  decoders and accumulator/lineage, with each reference consumer's
  catch/propagate behavior preserved; this is not a blanket fatal-conversion
  rule. Arbitrary user `*_ref` fields must not become renderer-owned spill
  authority. The owner retains those repairs and evidence; native integration
  and parent acceptance remain root-owned. No row count or installed behavior
  advances from the investigation.

- E220: The shell-analysis owner records scoped private-installed-package A6
  PASS at56ec137241f15ea8bc649b0dbc95e8a299b6a753. Root reads actual
  spec/event10273 and its selected coverage-rebinding test's `test_verified_at`;
  this does not independently re-execute or establish the
  entire1889-check/package narrative. Native producer/launch/routing,
  whole-chain canary and rollback remain A5/A7 obligations. The deployed machine
  pointer reads408c06a7; no adoption follows.

  Root explicitly accepts the finite pending policies mutation-report inspection
  within the combined integration hold. Source repair stays with chat
  `01a151c0-4722-76a0-9814-eb680a4be9b2` and its owned shell-analysis lane; no
  claim takeover, source authority transfer or closure occurs. Direct process
  observation finds PID19693 live as stryker. The inspected config selects the
  full `src/shell/analysis/policies.ts`; its log records436/1432 tested, 130
  survived and0 timed out when inspected. This is an unfinished run, not a final
  score or quality verdict. Exact config/log/report paths are under
  `/Users/darianrosebrook/.codex/artifacts/01a151c0-4722-76a0-9814-eb680a4be9b2/guard-coordination-20261021/startup-env-mutation/policies/`.
  On terminal process/report evidence, root must inspect the full-file score
  against the unchanged80 floor, embedded source equality with56ec1372 and
  meaningful survivor applicability. Consequential gaps or floor failures return
  to the source owner for repair; root retains integration and acceptance until
  resolved. Do not restart from an observation timeout or infer completion from
  owner silence. E185's refused inventory remains unexecuted and the complete
  guard/native boundary stays open.

- E221: The native original-project binding component lands on the integration
  branch in merge `ac0169989488557c53731b01e97e11431800f6e4`, containing
  `e03fd7d0`, `d533d064` and `e31d09ae`. Its spec
  `CAWS-NATIVE-PROJECT-BINDING-001` closes with four scoped PASS records, read
  back from both spec and `ac_recorded` events10301–10304. CLI re-derivation
  checks the cited commit only; external artifacts were inspected directly. The
  rejected absolute-artifact citation writes no AC record. Final test
  events10298/10299 retain41 selected checks and16 native scenarios; the prior
  data-schema refusal writes no event. Source-byte evidence retains all73 native
  files matching `e31d09ae` and executable SHA
  `58de5db0da52f26dc5d71c88d3c7978b7fc96823e233b5422fe84e9ea30ce569`. Raw
  artifacts remain under the E218 native-project-binding root. Foreign
  agreement, oversized frame and pre-store EOF yield no rows or budget files;
  established-binding missing-database failure retains the original-project
  counter1. Independent committed review's two fallback findings are repaired
  and grounded against those controls. Publication, receipts, actual renderer
  admission and parent acceptance remain open.

  The merge advances the checked-out integration ref without refreshing that
  linked checkout. Root verifies its index equals `f0ab6fc4` and no worktree
  delta exists, then uses the source-documented safe before/after
  `git read-tree -u -m f0ab6fc49f1804653097eda19c243b25b4a4e787 ac0169989488557c53731b01e97e11431800f6e4`
  transition; status is clean. A path restore is refused before execution and is
  not retried. The pending scope audit commit caused by a concurrent index lock
  is recovered through `caws specs commit`, commit `7e697074`. The source branch
  is retained because it is not merged into `main`; no force deletion or
  installed-runtime change occurs.

- E222: Canonical tracking reconciliation uses the existing ledger and README,
  under `CAWS-CUTOVER-LEDGER-PUBLISH-001`. The canonical ledger's E67 endpoint
  omitted durable candidate progress; inspection finds no main-only ledger
  commit absent from the integration source. The reconciled text retains
  historical failures, current owner, open parent criteria and explicit branch
  provenance. README doctor exit wording is checked against canonical
  `doctor.ts`'s error-severity test and observed exit0 with0E/3W/4I. Warning
  findings do not imply exit1. This is documentation publication, not candidate
  code delivery. Root remains the sole ledger writer and carries the accepted
  shell-analysis documentation integration tax: decoded execution context,
  reduced-Codex hold, mandatory write guard, exact startup controls and complete
  verification recipe. Those candidate-specific guide/architecture changes
  follow coherent source landing; changing counts and AC state stay here.

  The installed408c guard rejects a read-only inline Node heredoc's arrow as
  unsupported nesting before execution. It also resolves a relative Bash ledger
  destination against the canonical context despite the owned tool workdir.
  Direct reads and the ordinary file-edit tool with the admitted absolute path
  preserve these refusals without changing hooks, trust or guard state. These
  observations add no native producer qualification.

- E223: The user authorizes bounded timestamp coordination with chat
  `01a15984-840d-7301-a25a-7e681fd83b29`. It accepts only
  `src/transcripts/store-timestamp.ts` and its package-scoped focused test.
  Parent exclusive claims move to supporting scope plus exclusions, and both
  exact paths report CLEAR before the owner creates and claims
  `native-timestamp-year`, spec `CAWS-STORE-TIMESTAMP-YEAR-001`, from
  `ac016998`. The owner reports the two files unchanged across the intervening
  native merge; root reads the actual bound spec and start revision. Root
  retains native REAL acquisition, publication/receipt/reader integration,
  parent acceptance and ledger ownership. The finite slot permits sequential
  pinned compilation, focused tests and retained-reference comparison; new
  mutation execution waits for the live policies run. Original E204–E206
  exclusions remain historical evidence. No timestamp parity, integration or
  adoption is inferred from this assignment.

- E224: Root completes the accepted policies-report inspection. The actual
  Stryker process has exited; its owner polls the original tool session and
  reports command exit0. The completed report contains1432 mutants: 1112
  killed,320 survived,zero timeout/no-coverage/error verdicts. The per-file
  score77.65% is below the declared80 floor. `break: null` makes process success
  distinct from the report assertion's policy result. Root reads the configured
  analysis threshold and per-file assertion formula; it does not infer quality
  from exit0.

  Retained report SHA is
  `4c876050be61045f143079794cadd3de1ba576e5b253aa2e087dfe379be55221` at E220's
  exact policies artifact root. Its embedded source SHA
  `96ef2d6744838f316bca1442fa14b75d0c73fcefb933010e9308c26ee3bbe70e` equals
  `git show 56ec1372:packages/caws-cli/src/shell/analysis/policies.ts`. The
  completed config selects only `command-analysis.test.js`, whereas
  `mutation-policy.json` declares that suite plus `interpreter-effects.test.js`
  and `mutation-view.test.js`. This is a completed subset result, not the
  declared full-topology gate or proof of a production defect. The owner
  identifies the omitted consumer-observer coverage and accepts validation and
  consequential source-quality repair, preserving the report and original
  successful process status without exclusions or floor reduction. Establish
  representative survivor behavior with declared consumer tests before changing
  production or rerunning the complete topology. Survivor1431 changes
  `filesystemChanged` after an unsupported utility; the accompanying reason
  already holds analysis, so a claimed admission escape requires a consumer
  trace or targeted falsifier. Meaningful survivor analysis and repairs remain
  owed. Root retains the combined integration hold; A6's scoped private-package
  functionality is not whole-source quality or native adoption.

- E225: The existing preparation owner normally merges `199fa5e` through CAWS
  into the integration branch at `20ca11b4b16a65cdacea4c3d5f890a941df705fe`.
  Root reads the closed spec and current six PASS records with matching
  events10321/10322/10323/10324/10326/10327; historical input/output FAIL
  events10265/10291 remain. Root grounds selected numeric/catch/spill repairs
  against source and actual final numeric/output artifacts. The8945B/9032B
  sources refuse encoding under4300 with no generation and full committed
  checkpoints; unlimited outputs retain exact4301-digit sums. The four-artifact
  scenario has two turns and a21001-character sibling spill. The actual full
  runner log retains282 passed,zero failed/skipped/cancelled. Artifacts live
  under
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/render-prepare/`.

  Independent read-only inspection matches54 compiler inputs to committed Git
  blobs and52 compiled images across both retained trees, manifest SHA
  `178b95266e33c5bac7b5ecdbd531797dba57f1ab559682e13c902d91a6fb4e26`. Raw R6/R7
  baseline and mutant logs contain actual selected semantic failures; initial
  classifier failures are retained and adjudicated, not rewritten. Historical
  argv/exits remain recorded subprocess evidence; compiler closure, Node
  bytes/environment and installed execution are not attested. This is scoped
  content preparation, not native publication/currentness or full R18. Root
  accepts the parent integration obligation. A direct root merge is refused for
  foreign ownership before mutation; the existing owner performs the normal
  merge without takeover. Root verifies and safely refreshes the previously
  clean checked-out integration transition from `ac016998` to `20ca11b4`; no
  path restore, forced history or installed change occurs.

  Root also accepts and grounds the concrete SessionEnd consumer debt. Its
  actual extracted jq filter expects `usage.models` and renamed token totals;
  actual renderer output uses top-level `models` and provider usage keys. The
  retained5359-byte prepared turn makes that filter exit5, cannot iterate over
  null. A single-number-to3 derived control produces the same failure; adding
  only an empty nested model list exposes null totals. The old-shaped synthetic
  control exits0. Source `session-log.sh`292–310 and renderer1456–1465 confirm
  the mismatch; the whole hook was not executed. Exact commands,
  source/filter/image/input hashes, stdout and stderr are retained under
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/session-end-consumer-contract/`.
  This is an ordinary-consumer obligation alongside manifest/current-attempt
  admission, not a reason to alter the producer to satisfy a synthetic test.
  Derive the sealer's actual schema/consumers before repairing its mapping. Root
  retains that outcome. This accepted, landed implementation qualifies R18 under
  the stated partial-coverage rule, advancing coverage to33/37 (89.2%). Full R18
  replacement and parent acceptance0/8 remain open.

- E226: The timestamp owner normally merges unchanged candidate
  `41999be7615850221719a93f39e67486b68a12a6` into the integration branch at
  `10690d4bc1937a1a28fcf37e5ab3aed1f3e6ccd5`. Root reads the closed
  `CAWS-STORE-TIMESTAMP-YEAR-001` spec, four PASS records and matching
  events10395/10396/10398/10401, then closure/merge/removal events10413–10415.
  Source ancestry and the clean checked-out base transition from `10bb60e2` are
  verified without discarding work. The native source tree is unchanged from
  `e31d09ae`.

  The bounded repair models signed32 `tm_year + 1900` in the pinned ARM64
  CPython3.11.13 profile after validating all six raw calendar fields. Both
  retained Node18/22 comparisons cover all3673 cases, including all25 former
  exclusions, with zero differences. Historical E204–E206 exclusions remain
  historical. Focused Jest records68 passed; final whole-file mutation records
  391Killed/36Survived/2NoCoverage,91.14percent at the unchanged80percent floor,
  no invalid verdicts. Source/test/report correspondence and meaningful kills
  receive independent read-only inspection; raw mutation01 initialization
  failure and passing02/03 attempts remain retained. Artifacts and exact command
  statuses live under
  `/Users/darianrosebrook/.codex/artifacts/01a15984-840d-7301-a25a-7e681fd83b29/timestamp-year/`.

  This whole-file report uses a retained external finite configuration.
  Integration `mutation-policy.json` does not register the timestamp source or
  focused suite in its store surface; the report does not establish durable CI
  coverage. Root retains that registration obligation and must coordinate any
  shared policy edit after the guard owner's pinned mutation inputs are settled.

  Remaining regression gaps include malformed callback message42, a tagged array
  with calendar fields, valid1904/rejected2100 leap days and minute59. Inspected
  production source enforces these conditions; this is not a complete
  test-sensitivity claim. CLI commit verification establishes commit existence,
  not semantic execution. No fresh Python oracle, live native REAL boundary,
  publication, ordinary reader, package/adoption or parent acceptance follows
  this component closure. Coverage remains33/37 and parent0/8.

- E227: Root prepares a coherent consumer build from integrated `10690d4b` and
  an actual native REAL boundary probe using retained image SHA
  `58de5db0da52f26dc5d71c88d3c7978b7fc96823e233b5422fe84e9ea30ce569`. PreToolUse
  blocks the build-helper command before execution, naming a foreign write under
  `.nvm`. There is no compiler status or native probe result. Exact
  command/refusal and prepared helpers are retained under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/native-timestamp-boundary/`.

  Installed408 `lib/bash-mutation-targets.sh`'s `_caws_interp_payload_literals`
  accepts any write-verb co-occurrence and emits every slash-bearing fragment.
  The helper's `.nvm` path names the Node executable and read-only hash input;
  its explicit writes target the absent artifact output directory. This grounds
  the false mutation attribution, without certifying transitive execution or
  explaining the interrupted `printf`. Guard-owner diagnosis and direct guide
  inspection distinguish candidate v2's removal of weak-literal authority from
  its deliberate unresolved file-entry boundary: reading a mutable script does
  not bind its final launch. The candidate is not an execution remedy or
  adoption proof. Root preserves the refusal, performs no retry or alternative
  execution, and retains native REAL row/calendar/error/cleanup qualification.
  The selected runtime, trust and parent acceptance remain unchanged. The four
  accepted guard documentation updates remain landing obligations under root
  ownership, with implemented analysis, proposed execution custody and native
  adoption stated separately.

- E228: The Node-floor component candidate `41a39f66` is integrated into the
  source branch at `505ec19f` (parents `5446010b` and `41a39f66`). Normal build
  and ten focused tests exit 0. Actual Node 18.0.0 executes the unpacked private
  package and prepares four files byte-identical to the retained R18 scenario.
  Root and an independent read-only peer verify the package SHA
  `f5139faad5a873316e12aeb1509fa50b754bc10718ddb2aa2344c8c631aa2eac`, 1,258
  entries, all 33 recursive JavaScript images and the 29-module literal require
  closure. Wrong-runtime, missing-module and corrupt-spill controls exit 1 for
  their intended reasons. The actual Node 18 pending-write fault harness exits 0
  after one injected failure, verifies retained prepared bytes, leaves no final
  receipt and refuses overwrite retry. Original command and terminal output
  records in the owner's transcript independently corroborate the retained
  diagnostics; these are not reruns inferred from a summary.

  A1–A3 PASS records match events 10478–10480. The normal owner merge commits
  and closes the spec (event 10499), then fails to append `worktree_merged`.
  This is a partial lifecycle failure, not an ordinary successful merge. Owner
  destroy exits 0; root verifies terminal event 10504, absent registry/directory
  and Git worktree listing, then safely refreshes the clean parent checkout to
  `505ec19f`. The missing merge event remains an accepted root audit concern;
  recovery does not fabricate that event or erase the failed command. Artifact
  relations, command identities and failed attempts are retained under
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/transcript-node-floor/candidate-02/`.
  This qualifies a bounded R18 support component. It does not qualify the
  packaged CLI, production caller, publication, rename/crash durability,
  calendar, installation or full R27. Coverage remains 33/37; parent acceptance
  remains 0/8.

- E229: Root accepts the unresolved child-actor qualification dependency into
  parent A5, recorded unchecked in event 10495. The sensitivity lane's CLI owner
  is the child session, while its refused edit has parent-session hook context.
  The documented host contract uses the parent session ID for subagent hooks.
  Source inspection distinguishes the CLI's surface/environment selection from
  payload-first hook selection and exact scalar worktree-owner comparison; fork
  telemetry grants no ownership equivalence. This does not establish an
  incorrect historical guard verdict or malformed host input. Retained journals
  do not establish the actual oracle-winning identity and owner snapshot at
  decision. Raw refusals and the bounded host observation remain under
  `/Users/darianrosebrook/.codex/artifacts/01a15984-840d-7301-a25a-7e681fd83b29/timestamp-sensitivity/`.
  Root owns the parent consequence. The clean bound sensitivity component and
  all five controls remain on hold. Resume requires trusted actor semantics,
  same-invocation decision provenance, an admitted owner edit and an
  independently identified foreign edit refused with bytes preserved. No
  takeover, inferred parent/child authority, writer substitution or rerouted
  execution follows.

- E230: All four existing guard documents are committed in root's
  `guard-contract-docs` lane at `063991aa`. Root grounds independent committed
  review and the source owner's startup-binding correction against source.
  Formatter, diff checks and scoped gates exit 0; doctor exits 0 with three
  warnings and four informational findings. Spec A1/A2 PASS and A3 unchecked
  match events 10496–10498. Commit verification establishes reachability, not
  native execution. Coherent source landing remains open: the documents must
  land with the held analysis source, whose full-topology policies mutation
  attempt is running. The earlier incomplete and narrowed failed attempts are
  retained. Root owns documentation and integration; installed runtime,
  final-launch custody, native canary and rollback remain unqualified.

- E231: Native frontend settlement is accepted and integrated at `87b70fcc`,
  parents `59b381be` and candidate `71eca81c`; its native source is unchanged
  from `ddd39d26`. The completed wire exchange returns the owned acquisition,
  preserving exhausted, stopped and failed-but-closed outcomes through a later
  engine failure. The reviewed-prefix private debug build exits 0; 24 selected
  acquisition/wire tests, one native binding test and six actual store-profile
  cases pass. Root inspects the six CLOSED traces, cleanup, semantic metrics and
  typed observations. Tested image SHA
  `5ad1a1776339dc3323bd5fe75105ee9b2eca88f713a6af07cb7fc362a211b893` matches the
  build receipt. A separate source snapshot changes only retention from
  `Some(owned)` to `None`: build exits 0 and the same invoke test exits 101 at
  its missing-metadata assertion after a genuine exhausted CLOSED with one
  delivered row. Earlier missing-registry compilation and missing-artifact-root
  setup failures remain retained. Independent committed review, five scoped
  gates and doctor exit 0 (0E/3W/4I); component A1–A3 PASS match events
  10569–10571. Closure, merge and destruction are events 10572–10574; the branch
  remains retained and the parent checkout is reconciled without discarding
  edits. Raw commands, results, traces and build identities are under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/native-store-settlement/`.
  This establishes frontend-local retention and its bounded falsifier. Root
  retains surviving-actor acquisition, publication permits, actual-reader
  integration, release qualification and adoption; parent acceptance stays 0/8.

- E232: The diagnostic-preservation component `642b66a6` integrates through
  normal owner merge `59b381be`, with closure/merge/destruction events
  10560–10562. Its one production assignment retains `mergedTxn.errors` as
  `merged_cause`; it does not retry, backfill, change lifecycle recovery or
  alter default diagnostic rendering. A private normal build and seven focused
  checks exit 0. Removing only that assignment in a copied emitted writer makes
  both new cause assertions fail, exit 1. Root inspects actual store/CLI
  outcomes, closed specs, absent merge events, retained payload/registry state
  and two-parent Git graphs. Both AC PASS records match events 10554–10555. Raw
  artifacts are under
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/merge-diagnostic-cause/642b66a609c10782fc95f9f7fd9c38fbacefdd9f/`.
  Dependency identities describe the actual private check, not a candidate-lock
  installation or complete loaded Jest closure. Parent support admission for the
  three floor paths (event10553) and two diagnostic paths (event10563) repairs
  their scope provenance; the floor commits' inspected review rows admit every
  path. The missing historical floor `worktree_merged` remains an audit gap. It
  is not consulted by that scope gate, and these repairs neither reconstruct it
  nor establish its historical lock cause.

- E233: The complete 1432-mutant `policies.ts` attempt finishes with both
  Stryker and shell exit 0: 1206 killed, 226 survived, zero timeout, no-coverage
  or errors, score84.22 above the unchanged80 floor. Root inspects the report,
  terminal receipts and absent PID; the source owner verifies all seven
  before/after pin groups equal at complete digest `40fab4fe…`. Report SHA is
  `41de02e2c92ca4a6e8bd9fc4842b7c953590e8256f7b2c4f134a651e3070b5da`. Artifacts
  remain under
  `/Users/darianrosebrook/.codex/artifacts/01a151c0-4722-76a0-9814-eb680a4be9b2/guard-coordination-20261021/policies-declared-topology-attempt-2/`.
  This result uses the retained three-file test configuration. Its name filter
  unintentionally excludes a multiline interpreter-effects case; the owner
  retains the filter correction and a missing metadata-coordinate consumer
  oracle. Five other analysis files lack current declared-topology results;
  incompatible historical reports do not combine into a fresh six-file gate.
  Root retains coherent guard source/docs landing, final-launch custody and
  native canary/rollback obligations. The source owner holds further heavy
  qualification until the corrected tests and R19 interface settle.

- E234: A private replay of selected408 guard bytes demonstrates a bounded
  normalization defect. A foreign worktree payload gets refusal2 with Python
  available, but success0 with empty output when Python is absent or exits 1;
  the target-owner control succeeds. Six Bats assertions pass, including real
  linked/common-directory and Python-free tool-farm preconditions. Every verdict
  leaves the target file and directory absent; no unauthorized write is
  executed. Root and an independent peer inspect retained TAP, fixture and
  source: `_realpath` returns unresolved input on failure, causing textual
  authority checks to miss before the registered-branch allow. Intermediate
  branch values are source-derived, not traced. Artifacts are under
  `/Users/darianrosebrook/.claude/artifacts/c4c0f2e0-cb0c-4380-a9c4-7daeb8f35885/realpath-v2/`.
  The original top-level command is transcript-derived; concrete temporary paths
  and process environment receipts are missing. This is direct guard behavior,
  not installed-dispatcher, native-harness or Bash-consumer proof. Root owns
  A4/A5/A7 consequences and a checked-normalization repair preserving
  Python-success behavior, with explicit caller refusal2 on unavailable or
  failed normalization. The normally bound child
  `CAWS-DEFECT-REALPATH-PYTHON-ABSENT-FAIL-OPEN-01` carries committed candidate
  `73166c16`; source-owner integration, late-path evidence inspection, pack
  fingerprints, native library pins and the combined guard/docs qualification
  remain open. A child's recorded acceptance does not establish that
  integration. Source-owner inspection and root's direct helper probe find
  successful LF-only output becomes an empty caller value; raw nonempty-output
  checking does not establish normalization. Repair and selective empty-output
  refusal controls precede child landing. Dynamic-prefix normalization is
  unreachable because required AST projection supplies no proven prefix; source
  and a conservative ask falsifier establish that applicability boundary. The
  Python-dependent payload-parser sibling remains unexecuted, and complete
  no-Python refusal parity is open. The selected408 runtime is unchanged.

- E235: Canonical transcript mutation registration and finite public export
  consumers integrate at `ff3c6180` from `90553b82`, with child acceptance A1–A3
  and close/merge/destroy events10666–10671 read back. Root verifies the clean
  linked parent index/worktree against its old `5990334c` preimage, then safely
  synchronizes both to the new ref; all three candidate blobs match. Source
  count192, targets21 and surfaces3 include the timestamp in the ordinary store
  profile: six sources, nine selected tests, unchanged80 per-file floor, no
  incremental evidence. The original private `49329541` commands record build0,
  validator0,93 focused CI/timestamp checks0 and286 strict transcript checks0.
  Four isolated omission/export controls fail at their intended assertions;
  actual public consumers retain the9007199254740993 lexeme, raw bytes,
  caller-asserted coordinates, forged-row refusal,4300/4301 digit boundary and
  Unicode near misses. A later two-line count-oracle repair has fresh25 CI
  checks0: a valid192/121/3 policy passes the validator and falsely passes the
  old topology assertion, but fails the repaired exact21 assertion. Root reads
  both raw phases and the committed delta; unchanged runtime/export evidence
  remains explicitly attributed to493, not fresh905 execution. Artifacts:
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/transcript-mutation-policy/`.
  The registration is complete; full canonical six-source mutation execution,
  per-file quality, CI, complete generator correctness and installed/native
  qualification remain parent obligations. This unit changes neither33/37
  partial coverage nor0/8 parent acceptance.

- E236: The R21 claim-oracle regression replacement `c66730a3` lands on main at
  `5af9757e`; close/merge/destroy events10663–10665 and exact test blob
  `795947e87b48ad595321aeaa24a200af48731f19` are independently read back.
  Integration commit `cc95efeb` imports exactly that Jest file and deletes its
  pytest predecessor. The integrated-source Jest command exits0 with15 checks,
  including actual shipped Bash-guard refusal2 naming the foreign claimant and
  sibling admission0 with empty stdout, excluding an approval request. Raw
  output and JSON are retained under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/cutover-progress-235/`.
  Independent source/raw inspection preserves all ten original cases and the
  exact444→434 collection delta. Earlier Git fixture escape and false admission
  oracles are reproduced before their repairs; committed fixtures strip
  inherited Git overrides and isolate Git configuration. Four controls
  respectively break containment/consumer refusal, degradation, segment matching
  and ask-versus-pass admission. Original artifacts and transcript-derived
  command/exit receipts:
  `/Users/darianrosebrook/.claude/artifacts/dd67d988-8ccc-438d-a559-ccd670a03a98/r21-claim-oracle/`.
  Those receipts are not complete process-environment capture or npx dependency
  identity. Matching finite pattern samples do not prove all-string equivalence;
  a guarded command is adjudicated without executing its mutation. Remaining
  pytest modules and the tested guard's Python dependencies remain obligations.
  No production Python row, installed/native result or parent criterion closes.

- E237: Same-target runtime entry repair preserves rollback history. Candidate
  `1bb584a8` lands on main at `a451ba15`; close event10724 and merge event10725
  identify the actual candidate and target. Source integration `1a023e33`
  carries exactly the two reviewed blobs: `machine-adapters.ts` is
  `e7cf08e265a4d0e6ca20f53fafbf73748caadc62` and its regression test is
  `74df1748a3ea7c97596a84f0547e67696e3cce83`. Entry-only repair leaves pointer
  bytes and the previous generation unchanged; a self-predecessor rollback is
  explicitly refused. Root reads the full55-case raw run, terminal0, and the
  same-target assignment mutant's two intended failures. The retained real
  older-CLI sequence is supplemented by an actual invocation of its restored
  stable entry: selected generation `5ec11024`, generation-owned library path
  and `run-handlers.sh` hash `9d7c5fea` agree; allowed input exits0 and the
  protected control exits2 with `WITNESS-GUARD-BLOCK`. Raw files:
  `/Users/darianrosebrook/.claude/artifacts/c843b9aa-c831-40ce-ac99-cae38f061436/rollback-probe/`.
  `witness.log` hashes
  `03dada81a27a9c07daed15283796190113379e1d6a462c1724e6e7844ff997a4`; the
  witness includes a temporary test delta, separate from the committed55 cases.
  This establishes bounded Python-entry rollback behavior, not complete native
  entry compatibility, installation qualification or parent A7. The R01 owner
  `01a15984-840d-7301-a25a-7e681fd83b29` implements the staged replacement under
  `CAWS-NATIVE-INSTALLED-ENTRY-001`: separate native entry, manifest-owned
  relative image metadata, explicit install/configure opt-in, honest later
  legacy selection and no fallback after native dispatch.

- E238: Parent evidence A1/A4/A5 is refreshed unchecked, events10728–10730;
  coverage remains33/37 partial and parent acceptance0/8. Concrete current gaps
  remain assigned rather than transferred by a message:
  - The R19 child's exact-byte fixtures demonstrate successful normalization
    losing a valid trailing line-feed path byte, then five foreign Write/Bash
    guard admissions0 with empty output while ordinary-root controls refuse2.
    Root reads `realpath-v2/run-09/bats.tap`; the linked Bash case's refusal2 is
    an invalid analysis contract, not an ownership verdict. Owner c4's test-only
    `9fc50375` and proposed byte-preserving output-variable helpers retain the
    red evidence. Explicit unsupported-path diagnostics, apostrophe
    interpolation and quoted-prefix repairs are part of that four-file child;
    the shell owner retains reached sibling-repository normalization and final
    combined source/four-document qualification. No repaired child is accepted.
  - Installed invocation `de5bece4` and the actual Claude subagent transcript
    show parent-directed message `3d74b7f0` offered and adapter-settled into a
    child's hook context. Root accepts the custody defect. Owner dd67's
    `CAWS-SUBAGENT-MAIL-CUSTODY-001` derives tri-state actor context from actual
    payload bytes and withholds auto-polling for subagent or uncertain context;
    implementation and sequential real-mail falsifiers remain unqualified.
    Project fast-path inherited payload provenance remains root owed. Sterling's
    reviewed project parser pin stays frozen: it is a distinct producer from the
    shared template, and changing that pin would require new qualification.
  - Resident candidate `56026c56` builds through the ordinary typed SQLite
    coordinator, terminal0, request digest `039bd22b`, `NOT_ADOPTED`. Its
    native-only snapshot cannot compile tests with undeclared sibling inputs;
    that attempt exits101 with zero tests. A direct owned-source test using
    fresh external Cargo state and the verified prefix runs34 owner tests: 32
    pass, two new oracles fail. Existing SQL metrics count native visitor calls
    before transport success, and cancellation after the only row need not
    prevent exhaustion. Test corrections must preserve those contracts and
    independently assert write failure and cancellation before a second row.
    Correction `e46880b5` changes those oracles and documents visitor metrics;
    it does not change SQL ordering. Its behavioral run is separate from the
    failed baseline and the historical560 coordinator build. Raw commands,
    streams and inventories:
    `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/resident-store-acquisition/`.
    Surviving-actor acceptance, publication, ordinary reader use and adoption
    remain open. Refused bulk-edit and fixture-copy commands remain unexecuted.
  - Canonical store mutation preparation retains its frozen refused bulk
    program. Separately guarded ordinary preparation completes a private
    dependency install with source/lock hashes unchanged. Stryker's eager
    dependency requires a supported Node image; private official Node22.22.2 is
    verified against signed release checksums and the official GitHub-pinned
    release-key fingerprint over HTTPS. This trust basis is not preexisting
    offline ownertrust. Startup prints9.6.1 and loads the actual nested
    dependency; an overstrict environment-key assertion fails and is retained.
    No inherited Node/npm execution overrides are observed. Terminal readiness
    checks exit0: esbuild reports0.25.10, Parcel and unrs load their actual
    ARM64 native bindings, and unrs selects the native exports. A minimal clean
    environment comparison observes the added CF key without attributing its
    exact current setter or claiming hermetic execution. Raw commands and
    outputs are retained under
    `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/store-qualification/`.
    No watcher subscription, resolver operation or esbuild transformation ran.
    Full six-source/nine-test mutation execution and per-file floors remain
    unqualified; preparation is not a mutation result. Rehash the complete
    private source/dependency/tool trees before an allocated quality run.

- E239: Exact source-license transport lands through the normal owner merge
  `1d00482f` from reviewed candidate `29291227`. The closed component
  `CAWS-PACKAGE-LICENSE-TRANSPORT-001` has four PASS records, events10827–10830;
  closure/merge/destruction are10832–10834. Root verifies all six imported blobs
  and safely refreshes the linked parent's old index/worktree without discarding
  edits. Twenty-four filesystem cases and nine snapshot-mechanics scenarios
  exit0; the ordinary build, actual npm pack and private standalone snapshot
  install exit0. Both packing paths produce tar SHA
  `3f17f60ee9ee458816d24199c1e7fd112248a2c21998f31ac2d58838c34fb520`. Root opens
  that tar and the installed files: root MIT1069, Unicode1995 and HTML13936
  bytes exactly match their authoritative sources. The installed CLI
  reports12.2.0-rc.2; the retained inventory compares all1261 package members,
  excluding transitive dependencies. Owned transports, marker, locks and staged
  docs are absent after cleanup. Foreign equal-byte replacements retain their
  distinct inode and are refused rather than deleted. Fault artifacts preserve
  the original failure, cleanup failures and previous activation. Independent
  review finds an escaped-path cleaner returning0 without running cleanup. The
  exact old/new CLI differential retains three files and marker under
  `5ee03de6`, then removes them under292 with sources unchanged. Root grounds
  that repair in source and actual state. Raw commands, environment, exits and
  observations are under
  `/Users/darianrosebrook/.codex/artifacts/01a157bd-8bb6-7fc1-9322-6120a73b5a72/license-transport/attempt-01/`.
  The strict dependency no-mutation check exits1: two new empty
  `node_modules/.cache[/prettier]` directories appear. All21632 existing files,
  their modes,40 links and the5866-entry Node image match their before images.
  `post-use/result.json` and `adjudication.json` retain the failed assertion; no
  baseline is overwritten or directory deleted. Prettier source explains
  cache-directory creation before its cache flag, without a syscall writer
  trace. Root retains complete-store preflight and private cache placement. This
  is serialized filesystem artifact custody, not active namespace-race,
  power-loss, strict immutability, legal-compliance or native-adoption proof.
  Combined R01 source requires a fresh package; this tar predates that
  candidate.

- E240: Resident acquisition lands at `bb3a8b99`, tested tip `aa53f0b1`, through
  seven in-scope commits. `CAWS-RESIDENT-STORE-ACQUISITION-001` closes with
  A1–A3 PASS events10826/10831/10835, closure10836 and merge10837. Root reads
  both spec and events, safely refreshes the linked parent and verifies all14
  candidate blobs. Separate StoreAcquire/StoreStatus frames preserve renderer v1
  framing and eligibility. Original native project binding precedes
  route/journal/SQL; strong Actor records retain full acquisition and cleanup
  while a bounded weak registry supplies correlated status without replay,
  eviction or authority. Unreleased records pin the host until an explicit
  release lifecycle exists. Owner34, SQL/wire24, cancellation2 and metadata1
  focused checks exit0. The actual invoke filter exits0 with two tests: frontend
  SIGKILL leaves one bound retained Failed/transport settlement in the original
  owned host264ms after the startup guardian closes, beyond idle100; six
  OpenCode/ZCode format cases establish their own CLOSED/status results. The
  beyond-idle observation is specific to the death scenario. Earlier
  compile101/zero-test, owner32/34, invoke0/2 and typed fixture-pin failures
  remain retained. Repairs preserve visitor-count and cancellation semantics
  rather than change production SQL. The exact external-fixture FIFO test runs
  production Actor.run and exits0, one selected case17.07s. Actual event order
  is A prepared29, S cohort-wait31, A EOF withdrawal32/finish34, S
  acquisition35/retention36, B admission37, preparation55/withdrawal57.
  Requiring the real waiting branch closes the unscheduled-Actor
  false-confidence condition found by independent review. SQL returns m/p and
  CLOSED exhausted; direct worker reap, stdout/stderr EOF, zero
  connection/project/backend capacity, writer reacquisition, unchanged database
  bytes and an exclusive-lock check execute. Worker75832/backend75833 are absent
  afterward. A/B withdraw without renderer execution; S uses internal
  acknowledgements, while separate invoke tests cover frontend relay. The
  fixture uses aa53's Actor library and pinned6c worker; only two observation
  functions differ in production source. Final aa53 all-targets feature-off
  check exits0. The normal typed build and loader verification exit0 with
  request digest
  `8e337dc464aeafbbacd48c225dec4282c92c893348eda7c3933de146c171afcb` and native
  SHA `52e6127d6d7b86e6ef7b452feedcaa4305500bb85696868230b79dbc34fa1d0a`;
  compilation does not rerun that FIFO. Raw commands, sources, tools, exits,
  failed controls and observations are under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/resident-store-acquisition/`.
  Original order artifact SHA
  `80ae5bd30faa289455e0b3a8a6014bced54b49f86a487740c0ffb73060551ca0` remains
  under the preserved parent
  `packages/caws-native/target/qualification/render-owner-2026-10-22T03-05-28-027Z/`.
  Its attempted archive copy is refused before execution; it is not retried
  through another carrier. The single-use fixture is consumed and retained.
  Source gates pass all five checks over14 paths; doctor exits0 with0E/3W/4I.
  Architecture wording lands with this component. Publication permits, atomic
  projection, actual reader consumption, record release, sustained13-session
  capacity, owner-crash recovery, no-Python packaging and adoption remain open.

- E241: Root retains integration consequences after E239/E240 without advancing
  33/37 partial coverage,0/8 parent acceptance or any complete production Python
  retirement. The selected machine pointer stays408c06a7. R01's committed
  `ace175b6` defines a separate opt-in native entry, complete prefix/mode/notice
  carrier and pre-pointer protective rollback refusals. Strict private TS
  exits0; the direct five-suite Jest run executes172 tests,148 pass and24 fail.
  Three complete new/selection suites account for101 passes;47 machine-runtime
  cases also pass. Nineteen failures explicitly name missing private templates;
  five child-status failures omit child stderr. Missing normal subprocess entry
  paths are a plausible contributor to those five, not established causation.
  The normal package build and the same five suites then exit0 with172 passes at
  both `ace175b6` and combined candidate `29339d97`; assertions are unchanged.
  Raw combined commands, logs, report and inventory are retained under
  peer15984's `r01-installed-entry/combined-exit-result.json`. This resolves the
  qualification layout failure without establishing the individual cause of all
  five child statuses. Registration artifacts use the legacy default entry and
  producer fixtures use a shell sentinel; they are not native callback evidence.
  Two opaque orchestration wrappers are refused before execution and retained;
  the separately inspected transparent normal test entry runs under fresh guard
  admission. Source hashes, modes and unit fixtures do not establish actual
  installed native dispatch or rollback. R19 `4ac64fbf` has47 focused cases
  and15 identity mutants, with bounded alias transport holds and helper-only
  Git-path controls explicitly distinguished. Missing-Git canonical discovery
  and relative foreign-worktree paths remain consequential source/probe findings
  under owner c4; repair and fresh evidence precede merge. Missing-Python parser
  ingress and the LF sibling walker remain parent/source-owner obligations.
  Candidate `8dbe29c1` remains held: a retained actual guard probe observes both
  guards refuse a foreign write with healthy Git, but allow with empty output
  when Git is present and fails or linked-worktree administration is missing.
  Root inspects the probe and discovery fallback; c4 owns the bounded repair.
  Source inspection also establishes incomplete multi-target and Move endpoint
  propagation: the Codex parser extracts only Add/Update/Delete headers, and
  scope, protected-paths and worktree guards consume its first path. Root owns
  the complete endpoint carrier, consumer integration and actual patch/guard
  falsifiers. This source finding does not establish an executed harness write.
  The shell lane's account/system error grants no takeover; coherent
  source/four-document landing and final six-file quality remain held.
  Mail-custody owner dd67's `83b6cdba` adds strict original-text and fatal UTF8
  classification plus cleanup controls. Its six-suite251-case run exits0 and
  five matched falsifiers fail; fingerprint check1 is retained. Test-only
  candidate `1f0fcb83` adds protocol-valid empty-input pairs; the focused run
  exits0 with60 passes after two assertions are corrected to the actual silent
  result. Both earlier oracle failures are retained. Root consumer inspection,
  committed-candidate review and integration remain owed; subsequent dirty
  cleanup edits are outside that qualification. Source inspection of committed
  `1f0fcb83` confirms that parser spill replaces the original capture's EXIT
  trap before the later unlink. Interruption in that window can retain the raw
  payload; the existing whole-handler deadline test does not establish that it
  reaches the window. The owner carries repair and a targeted interruption
  falsifier before acceptance. Deliberately inconsistent unit requests exercise
  defense in depth, not a protocol-reachable empty-input misdelivery.
  Older8afd's237 passing checks do not qualify83b. Root source inspection
  confirms project dispatchers can repair original invalid bytes before
  heartbeat classification. A separate original-byte carrier and
  inherited-marker scrubbing require implementation and actual dispatcher
  falsifiers; the normal payload channel cannot prove its own original bytes.
  Empty original text defaults to an object upstream, but the inspected typed
  heartbeat also requires a session id: its empty-input delivery seam is latent,
  not an observed live misdelivery. Refused artifact export remains a retained
  guard prerequisite, without installed guard changes or a bypass claim.

- E242: The existing machine migration guide is qualified on main at `84079dfb`,
  merged there at `2d1a69c8`, and imported through an owned source lane at
  `dbd8891d` with normal source merge `16981627`. Actual source/main comparison
  exits0; both guide copies have SHA256
  `1d5041f4b228d40e26fb0961d1a03aa809d51b09a4b4eaddae03cf3e577cc74e`. The guide
  includes `session_end` and the ordered CLI snapshot, runtime install and
  native configuration preview/apply sequence. Independent source review,
  formatting and five scoped gates support the documentation change. Component
  A1 is recorded in event10947 and read back; its spec closes completed. Parent
  remains active and the selected machine digest stays408c06a7. A direct
  integration-base commit and a later restore attempt are refused; neither
  executes. The normal owned-lane merge retains the wanted guide bytes and
  leaves the source checkout clean. Safe branch deletion is refused because main
  does not contain this source-lane history; no forced deletion follows.

- E243: R01 candidate `b71dd82f` retains a locked/offline native entry run: ten
  tests,21 observations, exit0, including unknown-event usage exit2 with empty
  stdout. Ordinary pack and production-prefix install exit0. Tar SHA256
  `b7de5a052127d66443ada73c040743dada914fce371b292eff6e21418f394c01`
  identifies1,269 regular files. One shared installed prefix contains5,704 files
  and65 packages; inspection under Node18.0.0 and22.19.0 checks80 dependency
  edges and36 declared engine ranges each. This is one installation inspected
  twice, with the npm10/Node18 tooling warning retained. Six separately
  adjudicated ordinary hash/stat/jq commands exit0 and produce descriptors
  SHA256 `4580cf4295fa00bc3980887aa93cc7c0bfac5af4578ef654abaedbf933ef53fc` and
  `b70c1eeb9006b4d0e82f7c0bc5af8ea9f7516dea50d16ac24a234cbc98c6c4a2`. Root
  inspects the scalar comparison and hashes both files:11 checks are true, 55
  native notice carriers are pinned, and both JSON files end with LF. Raw
  commands/results remain under peer15984's
  `r01-installed-entry/package-b71dd82f/`, including
  `data-stage-execution.json`, `data-stage-verification.json` and
  `descriptor-comparison.json`. Refused Python and process-substitution programs
  remain unexecuted; mistaken self-matching and cross-run cell captures are
  corrected with failed captures preserved. Package/data consistency does not
  establish production-reader acceptance, actual native dispatch, notice
  completeness, launch custody, trust or rollback consumption. Peer15984 retains
  the entry spec; root retains combined-source package, supported harness,
  no-Python execution and machine cutover qualification.

- E244: The actual SessionEnd consumer contradicts the usage-preservation
  requirement. PeerA's `session-end-consumer-contract/whole-hook/attempt-02/`
  retains the75-file source image, invocation, stdout/stderr and before/after
  metadata. The real handler exits0 with empty output in0.436s. Its actual
  prepared turn carries a4,300-digit `input_tokens` value; the resulting
  metadata gains `ended` but has no `usage`. Root reads the invocation and
  resulting metadata. Schema `turn-log.v2` carries seven independent provider
  counts and top-level models; `session-log.sh` instead aggregates legacy
  aliases and `usage.models`. Exit0 therefore does not prove preserved usage.
  The missing-dependency first attempt and filter failure are retained. Root
  owns repair through the typed ordinary metadata consumer, exact integer
  preservation and separately exercised model ordering; installed/native
  consumer integration remains open.

- E245: An actual patch-tool counterexample grounds the endpoint obligation in
  E241. Root's `patch-endpoint-contract/actual-tool-01/` retains the real
  Update/Move/Delete effect, reconstructed patch, expected roles and execution
  record. The moved file preserves a context line literally containing
  `*** Add File: fake-path`; source and deleted files disappear. The shipped
  scalar extractor exits0 but reports the update source, literal `fake-path` and
  deletion path, omitting the move destination and inventing a context endpoint.
  Parser SHA256 is
  `04a21ee0cd24d917bbee4c63f9285a2a867f2f9a08a9cdf2f9a78d3400a73c61`. The
  reconstructed fixture adds a final LF relative to the original tool argument;
  exact input-byte equivalence is not claimed. A tab-bearing header becomes an
  actual filename without a tab, so arbitrary control-character transport
  fidelity remains unproven. This exercises the real tool and extractor, not a
  complete guarded harness write. Root owns grammar-aware ordered role/path
  extraction, complete structured carriage and every-endpoint
  scope/protected/worktree consumption, including worst-verdict ordering and
  once-per-invocation side effects. No isolated first-path loop closes it.

- E246: Mail-custody candidate `9aabcae9` repairs raw-capture interruption
  cleanup and bounds the test's first TERM wait. The prior real red and
  held-link mutant retain a capture after SIGTERM; the repaired full93-case
  custody run at `20eaa26d` and targeted9aab run observe cleanup. Production
  bytes are unchanged across those candidates. A TERM-resistant test copy hits
  the explicit10s failure and bounded KILL cleanup; the earlier wrong143 oracle
  remains retained. Final9aab typed checks execute60 cases and pass; four
  hostile copies fail with52/93,37/93,8/31 and27/60 failures. Raw evidence
  remains under dd67's `subagent-mail-custody/`. Five gates pass over eight
  owned files; doctor reports0E/3W/4I. Root reads corrected A5 original-input
  authority and A1–A7 spec/event records10936–10945, then authorizes the normal
  source merge. Final candidate `57056cb5` includes the qualified operating
  guidance and failure-lineage entry; all five gates pass over its ten files.
  Normal source merge `f419e392` has parents `2245d59d` and `57056cb5`. Root
  verifies all ten integrated files equal the candidate; the component closes
  with A1–A7 retained and its lane removed. The source checkout is refreshed
  without discarding changes. Project dispatcher inherited-marker
  scrubbing/original-byte carriage, installed runtime/native harness and actual
  Codex subagent shape remain parent A5 obligations. A3 withholds uncertain
  empty handler ingress; it does not establish that the dispatcher preserved
  original bytes.

- E247: Ordinary store qualification requires a stronger provenance contract.
  Root inspects peerA's
  `store-qualification/contract-counterexamples/attempt-01/` execution record:
  the actual report assertion accepts four synthetic reports with a false
  supplied SHA, mismatched source, mismatched test source or empty test
  discovery, each printing six100% rows and exiting0. These are assertion
  counterexamples, not Stryker output or an executed mutation score. The copied
  license-marker primitive in `sandbox-marker/attempt-02/` executes actual
  staging: original fixture0, copied package1 with an ownership-identity error;
  marker bytes match but inodes differ. This models inspected sandbox layout,
  not an observed whole Stryker failure. Root retains current-source build,
  actual sandbox/output/test-consumption binding and full six-source/nine-test
  floor80 execution. PeerA owns a bounded runner/report/config repair. It
  preserves explicitly offline scoring while requiring bound input/build/report
  checks in the ordinary runner; the SHA is a supplied label. Actual loaded
  module/content identity and a distinguishing perturbation remain stronger
  qualification obligations. Ownership validation and declared floors remain
  intact. Neither frozen source freshness nor a supplied SHA qualifies a later
  build.

- E248: Checked-normalization owner c4 retains candidate `7d49da1d`, its54-case
  focused run and four ancestry/refusal mutants. Git failure with surviving
  physical `.git` evidence refuses instead of treating the path as ungoverned;
  missing-Git, relative foreign paths and missing cwd have separate controls.
  Root identifies a reached worktree guard early exit when Node is absent; c4
  owns its red/repair/hostile controls before merge. Git hangs and
  safe-directory failures are not qualified. The legacy normalization helper
  remains: candidate `7d49da1d` shared templates have no stock authority calls
  to it, while selected and project-installed guards retain callers. External
  custom consumers are not fully inventoried. Once integrated, this helper plus
  the checked implementation increase the embedded count from19 to20 bodies;
  that is not Python retirement. The shell owner retains its lane and reached LF
  identity callers; coherent source/four-document landing and final six-file
  quality remain owed. Root also retains the execution-directory producer
  defect: the inspected Codex Bash payload carries session cwd but omits
  exec_command's per-call workdir. A real relative-output command is refused at
  the wrong coordinate; the same explicit absolute output is admitted. This does
  not establish an unauthorized write. The ambiguity is scoped to
  Bash/exec_command; apply_patch has no per-call workdir argument and its
  resolution base needs separate qualification. Claude peers receive bounded
  directions through caws-aim; replies do not establish acceptance.

- E249: The actual packaged public production-reader plans execute under both
  Node18.0.0 and22.19.0 with
  `init adapters install --plan --json --native-image`. Both exit0 with empty
  stderr and5,880 planned members. Planned digests are
  `7fccdee87a4a24328e8c608cd11fdea470263d9fe6cadafafcd58aacfbdb4d26` and
  `cab8f519073d97b62a0652dd7b400146bb40e0ead304af09584a53e2ffa4f18a`. Root
  inspects `production-reader-execution.json` and semantic member assertions
  under E243's artifact root. The private CAWS_HOME stays absent before, between
  and after; real pointer comparison exits0 with408c06a7 unchanged. These actual
  readers accept the precise descriptors; they do not publish a runtime,
  configure a harness or execute a native callback. Peer15984 receives the next
  bounded private legacy/native installation allocation; callback,
  upgrade/rollback, trust and machine adoption remain unverified.

- E250: R01's packaged `b71dd82f` CLI performs the private legacy A installation
  and native Node18 B installation, both exit0. A selects `ef2d1eb1` with115
  members and no predecessor; B selects E249's `7fccdee8` with5,880 members and
  A as predecessor. Root inspects `publication-execution.json`, the pointer and
  supplemental notice/schema/mode comparisons under E243's artifact root, and
  independently hashes the published stable entry, native binary and Node18.
  Private native configuration preview and apply exit0; the two written files
  match the preview and contain six native event commands. The real machine
  pointer and registration bytes remain unchanged. Ordinary fixture init and
  corrected `IMAGE-OWNED-001` creation/binding use peer15984's genuine identity;
  the rejected initial spec ID and its no-mutation outcome remain retained.
  Fixture doctor exits1 with
  `doctor.hooks.system_runtime_invalid: System native registration missing or customized for codex/PreToolUse`.
  Root inspects the observer: its default legacy command comparison rejects
  native registration. Peer15984 accepts the exact observer-path allocation and
  normal scope amendment for a shared read-only registration-validator repair
  with hostile controls. The b71 package receipts retain their original
  identity; a repaired candidate requires fresh build/package/image and private
  qualification. No callback executes. Native startup verification precedes the
  frontend timer, and the45s inner budget leaves no demonstrated reserve before
  the45s outer hook timeout. Root retains that deadline/delivery contract,
  Node22 upgrade, rollback, actual harness refusal and machine cutover.

- E251: Checked-normalization final candidate `0a4cbe79` repairs two reached
  refusal gaps: Node absence after registry detection, and failed or unenterable
  Git common-directory resolution. The owner retains red-before-fix traces,
  killed fallback/refusal mutants and terminal60/60 template plus60/60 installed
  pack runs under c4's `realpath-v2/`. Root inspects the actual patch, raw
  terminal evidence and A1–A11 records/events11012–11022. Independent committed
  review finds the earlier common-directory counterexample; root grounds its
  final repair in source and retained controls. Merge remains held because the
  shell owner's latest continuation fails at the account/security boundary; its
  lane and dirty LF probe retain that owner's authority. No takeover occurs.
  Seven broader red expectations reach the source's deliberate native-Codex
  execution-contract refusal, missing-cwd handling or malformed metadata refusal
  before normalization. This explains their relationship to the bounded repair;
  it does not qualify the full producer/guard chain. Root and the shell owner
  retain those fixture contracts, Write/Bash cwd consistency, reached LF
  callers, coherent four-document landing and final six-file qualification.
  Python normalization remains in production.

- E252: An actual Claude Code2.1.308 timeout falsifier distinguishes hook
  completion from required enforcement. Two fresh non-repository fixtures retain
  normal global/user hooks and identical Write handlers that sleep5s with a1s
  timeout. Their only settings difference is `onFailure: "block"`. Both CLI
  children exit0. With the field unset, the raw stream records the cancelled
  hook and a successful Write; `probe.txt` contains `x`, SHA256
  `2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881`. With
  block, both Write attempts return `is_error: true` with the timeout refusal
  and the target is absent. Root reads pre/post receipts, settings and raw
  streams and rehashes the streams: unset
  `febc1bbe3163907b4587bfec6d882e72c0ef9d3b6eb7f0850d79cb3f34d960fb`, block
  `e64688f4331fc088ce2f676ed4737b0d8e98312f5128cb586be49f1b413b0faa`. Artifacts
  remain under c4's `realpath-v2/harness-onfailure/`; the read-only
  `proposal-onfailure-registration.md` maps source and rollout obligations. The
  machine CAWS hook succeeds in both non-repository fixtures, so this does not
  execute a CAWS-owned timeout refusal. Root inspects the generator's missing
  field and existing-entry preservation, coordinates a Claude-only PreToolUse
  source repair with R01's owner, and retains minimum-version, legacy
  registration and migration documentation obligations. No installed settings
  change. Can't-start, other exit/JSON failure classes, Codex behavior and
  actual CAWS registration under timeout remain unexecuted.

- E253: Mutation-binding candidate `caa655a3` commits six scoped runner, scorer,
  sandbox-configuration, input-identity and focused-test paths. Root reads the
  committed runner, actual `candidate-02.json` and read-only integration
  preflight under peerA's `mutation-qualification-binding/attempt-01/`. The
  serial66-case mechanics run exits0 with identical source hashes before and
  after; normal build/core children in these tests are fixtures. The earlier
  one-failure candidate and hostile child outcomes remain retained. Five scoped
  gates pass; independent committed-candidate feedback supplies no acceptance by
  itself. All four component ACs remain unchecked and the lane remains active.
  Root allocates one real ordinary store `--dry-run-only` invocation with the
  existing concurrency2 and build-slot coordination with R01. That actual
  invocation exits1 before build/Stryker: dependency capture cannot resolve
  declared npm dependency `buffer` from `bl/package.json`. Root reads
  `real-dryrun-01/execution.json`, stdout/stderr and the actual
  metadata-resolution counterexample: bare `buffer` resolves as a Node builtin
  with no package search paths, while the metadata lookup finds installed npm
  `buffer`5.7.1. The owner retains the failed run, released writer lock, absent
  sandbox and unchanged dependencies, and accepts a scoped resolver repair plus
  one coordinated retry. Production build/Stryker composition, actual
  selected-test consumption, loaded candidate bytes and distinguishing
  perturbation remain qualification obligations until their artifacts are
  inspected. No full mutation campaign or score is inferred from66 fixture
  checks; floors and license ownership validation remain unchanged.

- E254: Mutation-binding repair `d5fe5c85` resolves declared physical npm
  packages named like Node builtins without weakening missing-dependency
  refusal. The ordinary store
  `mutation:dry-run -- --surface store --sha d5fe5c8579562f5d2fcfaf96e94b361396e66440`
  exits0: outer build, real Stryker and relocated sandbox build succeed. Run
  `40da60d3` selects9 test files, passes385 initial tests and discovers2,678
  mutants across6 sources. It executes zero mutants and produces no mutation
  score. Root reads actual execution, stdout, run receipt and artifact
  inspection under peerA's `mutation-qualification-binding/real-dryrun-02/`; the
  receipt hashes to
  `6d513f68aca13c2d96e850b8f2e5a231599f34d34f24079bc696916cd6d37b64`. Retained
  receipts associate23,153 inputs with1,149 outer and1,149 sandbox outputs;
  instrumented output samples and distinct license-marker identities remain
  available. Successful sandbox stdout/stderr are not retained separately. The
  original `real-dryrun-01` dependency-resolution failure remains preserved.
  Component A1–A4 are recorded pass and
  `CAWS-MUTATION-QUALIFICATION-BINDING-001` closes completed; normal merge
  `03d663b6` lands the six candidate paths with identical integrated blobs. This
  earns the bounded binding component, not parent acceptance. Actual Jest-loaded
  candidate bodies, a distinguishing perturbation, the full campaign and
  unchanged per-file floors remain owed, together with later integrated-parent
  qualification. Root retains these obligations.

- E255: The allocated Node22 VM primitive probe exits0 with42 retained events
  and exact submitted UTF16 code files under peerA's
  `mutation-qualification-binding/vm-primitive-01/`. Root reads the actual
  execution and result: compilation alone refuses qualification; actual body
  invocation records entry/return; foreign context/filename controls produce no
  eligible observations; receiver, arguments, returned Promise and three thrown
  values retain their identities. Sink failure refuses qualification while
  preserving the subject outcome, and foreign hook replacement is not
  overwritten. Distinct lone-surrogate source strings collide under UTF8 hashing
  but remain distinct under exact UTF16 hashing. The prototype's post-detach
  proxies and retained history do not establish fresh observer lifetime or
  generation custody. No actual Jest environment, six-target candidate
  consumption, exported-function behavior, semantic perturbation or mutation
  score is demonstrated. Root allocates a separate bounded observer component
  with actual baseline-phase provenance, per-suite/context observations,
  six-target union, fresh lifetimes and finite retention; source reachability
  alone cannot establish runtime consumption. The full mutation campaign remains
  unexecuted. The actual concurrency tests in
  `tests/store/messages-store.test.js:729–780` spawn Node children requiring
  sandbox `dist/store/messages-store.js`; an in-process Jest VM observer cannot
  attest those child loads. Root explicitly accepts this remaining consumption
  obligation under parent A3/A4. The observer component does not qualify every
  candidate consumer or process.

  The active observer unit `CAWS-STORE-BASELINE-CONSUMPTION-001` retains an
  additional A5 obligation: await the actual supported Stryker API and bind
  terminal completion rather than accepting CLI exit0 or a surviving closed JSON
  file alone. Its fixture mechanics do not qualify that production consumer. The
  ordinary positive/negative/restored sequence is tracked below; no full
  mutation campaign or score is established.

  The captured VM boundary does not establish intrinsic compiler identity. A
  retained `foreign-before-core-01` control installs a compiler wrapper before
  core load: the record contains `return 1;`, the lower compiler receives
  `return 2;`, and the actual result is2 while the record closes without a
  failure. The component retains exact UTF16 submitted to its captured reference
  and invocation of the returned body under a bounded trusted
  Node/startup/dependency contract. Root retains broader compiled-byte and
  child-process consumption obligations.

  Bootstrap qualification remains separate from ordinary consumption. The
  four-suite `focused-04` run at `491bea05` exits1 with247 passing and28 failing
  checks; raw failures include a bootstrap tool detached from captured inputs.
  Its execution receipt hashes to
  `85fa5f17ebd3d535912e16234e23201636bf5cc7e0fc22a97b0825569a68d6a6`. Candidate
  `97f7dca9` corrects the public ESM entry versus CommonJS mixin distinction and
  duplicate physical fixture inputs. `focused-05` then exits0 with277 passing
  checks in four suites, stable11 source hashes and execution receipt SHA256
  `62222353a12cc6dcdac1b379203155c522da6910d029ad8f3ee5d8d88593a84b`. These
  receipts live under `store-baseline-consumption/attempt-01/` and retain the
  failed attempt. Candidate `547d4f96` tightens the audited two-key conditional
  export shape after review finds that an earlier Node/default branch can
  precede the expected import branch. The two-suite `focused-06` run on
  `547d4f96` exits0 with159 passing checks and stable11 source hashes; its
  execution receipt hashes to
  `e3008b3180e1863b462a5234ee9004d8d47c1053244c7e4cca288a53687b9cc9`. Actual
  private imports select the Node/default branches and write their distinct
  markers; inspection then refuses the unsupported export shape. These VM
  controls are separate from the preceding four-suite run and do not establish
  ordinary Stryker consumption or the semantic negative/restored sequence. Full
  mutation quality remains open. CI retention is also owed:
  `.github/workflows/mutation.yml` uploads report/index files but omits run
  receipts and `runs/**`. The foreign shell lane owns that path; coordination
  refuses its stale lease, so root retains the repair and no handoff is
  accepted.

  The first ordinary positive attempt at `547d4f96` fails with outer exit1. Run
  `89dd3c16-c3f4-4a80-b024-d6095590c6ad` discovers2678 mutants across the six
  sources and nine suites, and its385 initial tests succeed. The supported
  Stryker API and child completion each return0, but the outer validator refuses
  differing generation tool identities. Its failed execution receipt remains
  `d81cb0db6533497ad377859e9a249fafaef7b70bf1509e6a7a6015070108c412`. Root
  inspects capture and observer source: all nine generation identity maps agree
  by role, while their `node` and `jest-runtime` array positions differ.
  Candidate `f07d6b1d` compares the closed inventory by unique role while
  retaining exact fields, count, path, hash and size checks. The one-suite
  `focused-07` run exits0 with113 passing checks and stable11 source hashes; its
  execution receipt hashes to
  `92d40dc14577810e3ca24f5799926c76b29b34b37bfeb954aad7b82e1abaa232`. Raw
  controls exercise the actual capture/verification helpers with differing role
  orders and independently permuted inventories. Eight malformed inventories
  refuse for the intended role, field or identity mismatch. The post-run
  frozen-prefix/Node custody audit retains empty failure lists and the two
  explicitly admitted cache directories; it does not attest lane build output or
  continuous custody. These artifacts remain under the same `attempt-01/` root.
  They do not rescue the failed ordinary receipt.

  The fresh ordinary positive at `f07d6b1d` exits0 under pinned Node22. Run
  `fdae161a-7a08-4acc-837e-8f6088c7afd3` completes both normal builds,
  discovers2678 mutants across six sources and nine suites, and passes385
  initial tests. It executes zero mutants. Root reads the current run's
  source/build context, nine closed baseline generations, submitted UTF16 and
  returned-body records; the awaited supported API, actual child and outer
  receipt each return0. `ordinary-positive-02/execution.json` hashes to
  `db1d7142162b81c5a8918b809df6c308d1b6f8dd38f1463ea583083038992514`. Component
  A3 records this bounded in-process proof as pass; parent acceptance remains
  unchecked. The controller observes npm and retained child completion, not
  universal descendant absence or native custody.

  A separately allocated semantic negative changes only the exact-content write
  in `src/store/atomic-write.ts`, through the existing owner's normally guarded
  patch. Temporary scope amendments11432/11433 admit that exact path to the
  child while excluding it from the parent's claim. Run
  `53205c68-294b-4f22-9508-e2709743f05b` completes both builds with exit0 and
  reaches the unchanged exact-byte assertion at `atomic-write.test.js:40`:
  expected `hello world`, received `CAWS_BASELINE_CONTROL_WRONG_BYTES`. Its nine
  generations retain385 test outcomes, with that sole failure,85 compilations
  and85 returned-body invocations. Root rehashes45 retained artifact pins and
  reads the atomic generation, effective submitted conditional and raw
  API/child/outer results: rejection1, child1 and outer failed1. The negative
  receipt remains explicitly unqualified. Its facts manifest is
  `ordinary-negative-01/inspected-artifacts.json`, SHA256
  `6d7f51ba058ed60a2aba9d2b1997063c89aabde2bbf5abe54993675ad8f619f3`.

  After the leader terminates, the controller observes its actual owned process
  group absent without sending signals. The owner restores the exact original
  source through a guarded patch; root verifies source SHA256 `432dc551`,
  unchanged test SHA256 `d850a0e6`, unchanged `f07d6b1d` HEAD and clean Git.
  Scope reversals11435/11436 restore the declared memberships: child12 inputs,
  parent110 inputs/3 exclusions/116 supporting paths. The parent's disjoint
  plain `store/` prefix appends after the other109 entries, preserving admission
  and matching-pattern behavior. Source restoration leaves generated outer
  `dist/store/atomic-write.js` containing the marker. That output is quarantined
  until the separately allocated fresh `ordinary-restored-01` build replaces it;
  source-clean state alone does not establish restored runtime bytes.

  Restored run `517fadc6-4e5b-4fc2-b23b-05924a94ba1a` then exits0 with both
  builds successful and385 passing initial tests in nine closed baseline
  generations. The named exact-content assertion passes, and root verifies the
  control marker absent from its submitted UTF16 and current generated atomic
  module. The latter returns to SHA256 `11e6c828`. The awaited API, actual child
  and outer runner each return0; root rehashes24 current observation artifacts.
  `ordinary-restored-01/execution.json` hashes to
  `65e65574e6b67527ea9bfc95aa09c81e16011a68bd45c6dc8648c2a095f5c4bd`. Its
  observations remain explicitly unqualified for a full mutation campaign. The
  owned process group is observed absent without signals. The after-run custody
  audit `03cf9ced` retains status pass and empty failure lists; it covers the
  declared frozen dependency/Node and retained-evidence boundary. No mutant
  executes. Child-process consumption, full mutation quality and later
  integrated-parent qualification remain owed. Neither endpoint custody audits
  nor observed group absence establish continuous custody or escaped-descendant
  exclusion.

  Component A4 records the bounded semantic contrast as pass at event11448. A2
  records the scoped lifetime/refusal proof as pass at event11459. Its
  `a2-current-artifact-inspection.json` manifest hashes to
  `d689de52b9b5d1db60927ab325c6edbe7316760e7421d5be5d8eb6dceda06f82`. Root
  rehashes59 referenced files and reads ten actual observer scenarios, four
  producer-finalization faults and the validator refusal inventory. Finalization
  faults retain closed-looking disk records while the actual producer refuses
  with `record-sink`; file presence does not establish closure. Current per-file
  source pins support the older focused controls without promoting their entire
  suites to current-candidate proof. The component has A2/A3/A4 pass and A1/A5
  unchecked; it remains active and unmerged. Actual mutant context/body
  isolation and the ordinary cleanup-failure/resolved-nonzero API matrix remain
  owed alongside the parent obligations.

- E256: Review of R01 candidate `f9a90160` reaches executable-position ownership
  and managed-header boundaries that its237 passing checks miss. The owner
  retains failing canonical and producer controls and repairs classification
  across merge, adoption, system configuration, selection and health
  observation. Root directs active Claude peer c4 through CAWS AIM for read-only
  inspection. Its source-derived `command: python3` plus `args` containing the
  CAWS entry counterexample reaches discovery gates that inspect only
  `hook.command`; the documented Claude exec form passes this argument vector
  without a shell. Root grounds the source coordinates and official contract,
  and the owning R01 peer accepts whole-hook discovery and no-write
  reconciliation controls. Repaired candidate `43f560a7` commits the bounded
  producer, observer, failure-policy and rollback-selection repairs. Root reads
  `claude-failure-policy/exec-qualified-execution.json` and the raw seven-suite
  result:307 checks pass, exit0; its JSON hashes to
  `35a484638d6e4ddcf86096fa7fd6dcc1274410e500dab6ce4d5899bab84e5dd3`. Normal
  build and scoped lint exit0. These configuration/selection API checks use
  inert images and do not execute native hooks or harness callbacks. Recognized
  exec-form CAWS cases require reconciliation; supported exec-form migration or
  Codex argument semantics are not inferred. Review finds that `43f560a7` misses
  bare PATH names; repair `a6f690a5` passes343 API checks in seven suites,
  exit0, recorded in `path-qualified-jest.stderr.log`. Its candidate hint
  recognizes the covered bare-name spelling without resolving PATH or granting
  ownership. Literal paths and decoded spellings produce72 failing controls;
  `1f3a3a13` repairs that bounded class. A further12 failing controls expose a
  decoded name lost when a later compound suffix prevents a complete parse.
  Candidate `dd27eca0` retains known basenames emitted by the existing lazy
  tokenizer before later unsupported syntax. Full-parse ownership and migration
  admission remain unchanged. Root checks the committed four-path diff and the
  tested/committed patch hash
  `d38d6ff599746009a0ad2b39e7779d64c1f0847fa533a34b669d84ff1e721a22`. Seven
  focused suites pass427 checks; the retained Jest JSON hashes to
  `f3be7432daad9a8c8bba639890afc13f2d34fc67678817ed2b9e4cb6edc7da55`.
  `compound-cli-valid-before-plan.stdout.json` retains the pre-repair preview of
  a second CAWS handler. After repair, actual `configure --plan` and apply each
  exit1 with the reconciliation diagnostic; `compound-cli-before.json` and
  `compound-cli-after.json` retain identical16 file hashes and modes. These
  artifacts live under the existing `claude-failure-policy/compound-*` paths.
  Node18.0 and22.19 each record22 built-helper decisions; neither executes the
  complete package or a native callback. The committed review and root
  inspection support this bounded repair, not complete discovery. Syntax before
  the encoded name, aliases and indirect foreign invocation remain unqualified.
  The retained `preceding-syntax-plan.stdout.json` plans another CAWS handler
  for the earlier unsupported-syntax case; a preview does not establish
  duplicate execution. Root retains the actual one-event
  invocation/guard-journal obligation under parent A5, while R01 A4/A5 remain
  recorded unchecked. Source integration is held; the owner prepares fresh
  private package qualification from the owned candidate without depending on a
  source merge. The first invalid-Git run retains complete JSON failure
  diagnostics, but its separate stdout/stderr were overwritten by the corrected
  run; `exec-red-log-custody.json` identifies the preserved and replaced
  streams. Combined-source qualification, fresh package images, native callbacks
  and rollback qualification remain owed. No new R01 landing or actual-machine
  registration/selection change is inferred. AIM delivery to c4 is confirmed;
  current sends to dd67 and c843 are refused for stale leases, and dd67's
  earlier raw-carrier follow-up remains queued. Those peers have not accepted
  these new handoffs.

  The historical `dd27eca0` package/readers checkpoint has independent raw
  evidence:1269 tar members match installed CLI bytes/modes,5704 physical prefix
  files match both retained reports, and Node18/22 ordinary packaged
  `install --plan --json --native-image` commands each exit0 with5880 unique
  members and83 executables. Actual before/after observations retain an absent
  private install target and unchanged real pointer/Codex-hook hashes, modes and
  link counts. This is read-only preparation with retained feature-off native
  inputs, not native execution, publication or adoption. Expected-image checks
  share shipped helpers and prove consistency; source/dist/package/descriptor
  changes require a new coherent checkpoint.

  An inert API probe exposes a recovery mismatch: rollback selects valid legacy
  A after an unused payload in native B changes, but configuration/observation
  reject the retained transport. Tests-first controls expose15 semantic failures
  among34 selected checks, followed by two dangling-native-marker failures.
  Candidate `bfb548e6` shares safe retained manifest-bound entry identity under
  machine-home custody between installer and observer. Metadata and entry
  identity checks do not authenticate publisher history or qualify unused B;
  selected native images, fresh opt-in and rollback into B retain full image
  verification. Strict read-only mode checks remain separate from explicit
  known-byte mode or missing-entry repair, and native failures gain no legacy
  fallback.

  The first ten-suite run passes561 checks but exits1 on two legacy SessionStart
  consumers. Retained child diagnostics trace Python3.9's Kimi annotation import
  failure. R01 ports the existing `main` `8a758936` fix and portable AST test;
  both blobs match that source. The AST control changes from one failure to four
  passes, and both corrected private legacy consumers exit0. The complete
  ten-suite rerun on committed `bfb548e6` then exits0 with563 passing checks,
  zero failures and no pending tests. `final-qualified-jest.json` hashes to
  `4dd6bb32a5e81fa518afbbb05b886620b7760d855ba610cf13b1dca859bf8f85`; root
  checks the actual exit0 terminal as well as that retained JSON. Read-only
  built-API observations under Node18/22 retain identical343-entry before/after
  filesystem maps. Selected legacy A verifies, unused native B fails full
  verification, retained entry identity verifies, and existing configuration and
  observation agree without changes. Explicit fresh native opt-in refuses. These
  source-API observations use repository dependencies and inert entry bytes;
  they are not a fresh packaged image or native dispatch. Raw attempts and
  source/build identities live under `r01-installed-entry/rollback-identity/`.
  The existing four-guide unit commits the bounded recovery wording at
  `3f6f234c`, with independent source review; coherent source/guide landing
  remains held.

  The repaired candidate has a separate fresh package checkpoint under
  `r01-installed-entry/package-bfb548e6/`. Root reviews corrected plan
  `e7910121`, including explicit physical npm installation and private log
  paths. Normal prepack/postpack, fresh private installation, the supported
  Node22 physical npm graph and Node18/22 prefix inspectors each exit0. Tarball
  SHA256 `1c11e27ea6d8e57bfb5b0f035a5073a3ebb452c5eeebe18115957f5a1b16c82e`
  retains1269 CLI files with matching installed bytes and modes. Both prefix
  maps agree on5704 files and65 packages, with36 engine and80 dependency checks
  each. All eight declared CLI dependencies resolve, including `inquirer`8.2.7;
  the source workspace's missing `inquirer` remains explicit. The only reported
  omission is the declared optional `@types/node` peer of
  `@inquirer/external-editor`. Final source/tool/binary verification records1577
  captures and1254 remaining build files, with only the two expected
  marker-owned license removals after lifecycle cleanup; tracked `bfb548e6`
  remains clean. `qualification-checkpoint.json` retains raw artifact hashes,
  exact commands and terminal statuses. These are payload, physical dependency
  and declared-range/engine checks, not dynamic-import or native behavior
  qualification.

  Fresh Node18/22 descriptors construct successfully, with exact5704-file and
  65-package inventories,55 native notices and one Node notice. Their45000ms
  value is an inert preparation parameter, not an operational deadline. The
  first reader attempt stops before either CLI command: observer `202e65d5`
  assumes the nominal Codex hooks path is regular, while the agent-config
  installer and validator require the observed managed symlink. Its failed exit1
  and recovered raw diagnostic remain retained, with provenance in receipt
  `3ffb00ed`. Repaired stdout-only observer `d2a52041` checks the exact known
  link, target bytes and final ancestry without changing global configuration.

  The separately reviewed retry executes the fresh private package's public
  `init adapters install --plan --json --native-image` command under Node18 and
  Node22. Both exit0 with empty stderr,5880 unique image members and83
  executable members. Image digests are
  `44b495bf1f89e5cb12501f5eb8d4dd488c4c08821ca76bd08c7fa909b1b6b017` and
  `8198d52c21b368acf8c90f80cd06bd1ff75c9f2da6eab3cb7a2003881cd6821e`. Root reads
  the command receipts and exact-image comparisons. Private install homes remain
  absent; before/after source1577/build1254 and full-prefix5704 checks exit0,
  and tracked `bfb548e6` stays clean. Raw global pointer/link/target endpoint
  observations are identical, including hashes, modes, link counts, inodes and
  timestamps. They do not prove continuous custody or effective
  registration/trust. Expected-image comparisons share shipped helpers and
  establish consistency, not independent policy correctness. Artifacts remain
  under `package-bfb548e6/`; retained native inputs are feature-off binaries.

  Normal `--no-close` merge `aea8dcda` integrates the14 R01 commits at
  `bfb548e6` into parent `18b9d699`. Events11450/11451 retain the merge and
  physical lane teardown while the R01 spec stays active. Root verifies the
  parent index and files unchanged at the old base, refreshes them through the
  guarded two-tree transition, and verifies a clean parent with `bfb548e6`
  ancestry. Recreating the owned verification lane and fresh combined checks
  precede coherent guide/handler/fingerprint packaging. This is source landing,
  not runtime acceptance. The SQLite build receipt's exact v1 artifact inventory
  omits the stable `caws-hook-native` entry. A fresh build must bind that target
  and its bytes in an explicit version/capability contract while preserving
  bounded v1 consumers and both build profiles. The separate native-image input
  accepts a stable-entry pin without reading this receipt; its producer must
  derive that pin from the verified build. Extending the receipt alone cannot
  qualify the installed image. Borrowing retained feature-off entry bytes cannot
  establish this source chain. A source-confirmed discovery gap also remains: an
  earlier shell operator stops tokenization before an escaped or concatenated
  CAWS basename, allowing the candidate gate to miss a possible producer. Strict
  ownership parsing remains separate; a read-only finding does not prove actual
  duplicate callbacks. Actual native callbacks, upgrade/rollback,
  effective-event precedence, combined-source packaging and machine adoption
  remain open. AIM attempts to c4, dd67 and c843 retain their stale-heartbeat
  refusals. Later sends reach c4 and c843. Root receives their read-only status
  and registration-review replies; neither accepts an implementation handoff.
  Reported findings require source/runtime grounding before reliance. Earlier
  queued assignments remain unfinished under root ownership.

- E257: Root owns `CAWS-NATIVE-SESSION-PUBLICATION-001` in
  `native-session-publication`, based on `03d663b6`, for the continuous original
  store acquisition through native publication and independent SessionEnd
  sealing. Its typed wire/client is staged ahead of production dispatch.
  Controlled transport checks reproduce aborted-preparation acceptance and
  related terminal-inventory and resource-bound defects; repairs require a
  definite refusal after abort, exact status types, complete retained/output
  inventory and bounds before output copies. Existing protocol/store and new
  client checks exercise framed bytes and consumption; they do not execute
  native publication or the ordinary renderer/sealer. The bounded client
  component lands at `09a288b1` in the integration lane and closes with3 pass
  records. Committed review exposes an unknown preparation discriminator; four
  executed negative controls reach an invalid output copy. Exact
  ready-or-aborted validation repairs that transition before copying or writing.
  The complete focused client/store/protocol run passes177 checks, exit0, in
  `native-session-publication/client-red/jest-disposition-green.json`; strict
  compilation, scoped lint and five-path gates exit0. Root checks the integrated
  five blobs against tested `2a9f2093` and the clean linked checkout. This earns
  the unused client component; actual native effect and ordinary consumer
  criteria remain unchecked. The separate native boundary lane passes37
  feature-off custody tests, not SQLite/publication qualification. Its write is
  refused by hook identity despite its CLI claim; the preparation lane has the
  same identity disagreement and a separately refused baseline recorder. The
  human authorizes both clean component-lane ownership transfers. Normal
  `claim --takeover` events11486/11487 retain the prior owners and establish
  root ownership without changing guard or identity configuration. Prior worker
  notices are unavailable through the app and AIM reports no leases; no worker
  is started and no directive delivery is inferred. Both original refusals
  remain retained.

  Root implements pure bounded SessionEnd preparation in `42e2fa50`. Seven
  independent mathematical integer counts remain exact, absent counts stay
  absent, and top-level models retain first-use order. Unrelated metadata value
  tokens pass through exactly; no-contribution summaries retain their historical
  values with explicit provenance. The string API bounds UTF16 input, parser
  structure, arithmetic, model and output work and returns no partial output on
  refusal. These bounds confer no input-capture or filesystem authority.
  Independent committed review exposes historical-fraction schema rejection and
  rejection of mathematical version2 spellings. Root grounds both findings and
  repairs schema compatibility and version admission before acceptance. Strict
  compilation, scoped lint and five three-path gates exit0. The actual focused
  Node22.22.2 run passes42 checks with0 skips, including the retained real
  4300-digit turn. Ajv schema controls preserve historical fractional summaries
  while refusing fractional recomputed counts. An isolated compiled
  Number-coercion fault causes the exact large-addition test to fail; this is a
  targeted sensitivity control, not a full mutation score. Raw outputs remain
  outside source under root artifacts `session-seal-preparation/check-03/` and
  `number-coercion-01/`.

  Normal `--no-close` merge `abdb0338` lands the three identical helper/schema/
  test blobs into the publication integration lane. Events11512/11513 retain
  source integration and physical teardown; supported recreation binds the
  preparation verification lane at that revision. Child A1/A2/A3 have pass
  records11509/11510/11511 with spec/event readback. Child A4 remains unchecked
  in11516: independently captured original SessionEnd binding, writer barrier,
  anchored metadata replacement and ordinary reader consumption remain owed. The
  root-owned native boundary lane remains clean at `03d663b6`. Native
  implementation, ordinary dispatch, current-reader artifacts and actual
  terminal consumption remain open; source integration does not qualify them.

- E258: The baseline observer's new both-phase candidate `97967861` is
  source-only. All five current child criteria are unchecked; the earlier
  `f07d6b1d` positive/negative/restored evidence retains its historical
  revision. Root inspects a completeness gap: generation-directory enumeration
  plus a report-to-mutant-ID set cannot detect loss of one whole generation when
  another generation retains the same mutant ID. Independent start inventory and
  terminal receipt binding remain owed before fresh qualification. R01's later
  discovery candidate also remains unqualified: source inspection finds opaque
  substitution can stop discovery before an encoded basename, while a trailing
  plain name can make a test pass without exercising that discovery. Observer
  successor `39ba26f3` adds separate start markers and terminal inventory, but
  coordinated marker/generation loss before the snapshot remains an open
  completeness defect. Parent-memory admission and response custody require a
  derived contract before implementation. Stable-entry receipt source `3e4fb235`
  introduces explicit opt-in request/receipt v2 and retains strict legacy v1
  shapes. Its selector and filesystem checks are synthetic component controls;
  actual fresh debug/release builds, complete v2 loading and image production
  remain owed. Subsequent source checkpoint `431d1549` incorporates the R01
  four-path repair `255b4b39` through normal merge `2b1325b4` and the receipt
  two-path candidate `3a2422fc` through normal merge `431d1549`. Exact candidate
  blobs match the integrated files. R01's actual ten-suite run passes 681 checks
  with no failures or pending cases; 62 Node 18/22 helper cases and 40 private
  public-CLI cases exercise preservation and reconciliation. The receipt suite
  passes 79 executed cases with no failures or pending cases. These are bounded
  source and private-fixture results, not native dispatch or machine adoption.
  Both owners retain active, owned lanes for remaining qualification. The
  observer's allocated two-case probe at `b77e032d` exits 1: the healthy two-VM
  control passes, while coordinated generation/marker deletion fails the exact
  two-generation inventory assertion. Retained worker completion and raw UTF-16
  code establish both closed lifetimes returning 41 and 42 for mutant 0; the
  resolved fixture API and terminal inventory silently retain only the survivor.
  Child A2 is recorded FAIL in event 11661. This demonstrates bounded retention
  incompleteness; ordinary Stryker and full outer validation were not executed.
  Original-parent membership and independent failure state must survive through
  outer qualification before a replacement collector can qualify. Claude's owned
  `handler-stdin-stage` lane carries the staging-file lifetime repair. Its first
  six-case interval is allocated and acknowledged by the main session; results
  and integrated dispatcher behavior remain open. Root retains raw ingress
  classification, inherited-environment custody, native publication, fresh v2
  build/load/image production and all cutover acceptance. Four existing guard
  guides remain committed in `guard-contract-docs` pending coherent source
  landing; this ledger publication does not discharge them. No candidate borrows
  earlier package or runtime proof.

- E259: The `handler-stdin-stage` lane (`CAWS-HANDLER-STDIN-STAGE-LIFETIME-001`,
  owner dd67d988) closes the staging-file lifetime defect in
  `shared/lib/run-handlers.sh` at candidate `ce5ced6c` over base `1169f7df`.
  Defect: an inline payload over 32768 characters was staged to one
  dispatch-scoped `caws-handler-stdin-*` file and appended to `CAWS_TEMP_FILES`,
  which no shipped dispatcher consumes (`git grep` at `1169f7df` over
  `templates/` and `src/`), so every large dispatch left a full tool payload in
  TMPDIR on normal exit, TERM and KILL; the machine held 2,018 such files
  (109,029,350 bytes, 2026-10-19 to 10-22) under installed runtime `408c06a7`.
  Repair: each handler's command-substitution subshell creates a private
  `mktemp -d` directory (mode 0700), writes the payload inside, opens it as
  stdin, verifies the unlink before clearing its trap, and execs the handler;
  only its own directory and payload are ever removed. Completion review (Codex,
  read-only) found that the prior candidate `a5b4baee` left the payload named
  when the parent TMPDIR stopped accepting removals; the reviewer's falsifier
  reproduced it (status 0, payload present during and after the handler, no
  diagnostic), and that FAIL is retained on record. Under `ce5ced6c` the unlink
  depends only on the private directory, and a directory that cannot be removed
  is named on stderr. Evidence (all under
  `~/.claude/artifacts/dd67d988-8ccc-438d-a559-ccd670a03a98/`): the
  self-contained `handler-stdin-stage-lifetime.bats` (8 cases, bats-core 1.13.0,
  `/bin/bash` 3.2.57, no CLI build or installed pack) run serially against
  pinned copies from git objects, `f3-runs/series-20261022T193541Z.json`, 11
  attempts, 55.2 s, zero surviving processes: candidate 8/8; baseline `1169f7df`
  fails 1,2,3,4,6,7,8; prior `a5b4baee` fails 7,8; mutants dropping the pre-exec
  unlink (fails 2,3,7,8), appending a newline (1,6,7,8), removing caller
  `CAWS_TEMP_FILES` entries (4), never staging (1,6,7,8), dropping the pipe
  fallback (5), staging at `>= 32768` (6), skipping the presence check (8) and
  silencing the directory report (7) each fail only the named cases. The 17-case
  real-dispatcher probe (`f3-dispatcher/attempts/20261022T193700Z-ce5ced6c`,
  `git archive ce5ced6c` of the shared tree, 43.8 s, exit 0) matches the
  retained `1169f7df` rows except that c11/c12/c13 no longer leave stage
  residue, with identical handler stdin digests in every case; the raw-byte
  custody rows (c3/c5 uncertain-to-main, c9 preset `HOOK_INPUT_JSON`) and the
  c17 spill-file KILL residue are unchanged and remain root-owned. A1–A7 are
  recorded pass at `ce5ced6c` (events through spec commit `0a6e9704`). Not
  claimed: a signal while `mktemp -d` runs (one empty directory), a KILL between
  the payload write and its unlink (the payload file), Linux bash 5, the
  installed pack copy, and machine adoption. Still owed before this lane is
  complete on `main`: the single `SHARED_PACK_VERSION` bump with its fingerprint
  entry (`manifest-shared.ts` and `pack-fingerprints.json` are claimed by the
  `shell-analysis` lane, owner `01a151c0`, last active 2026-10-21), and root's
  integration merge.

- E260: F3 successor `c6164df3` is integrated through owner merge `a0ddd5b2`;
  root verifies its five first-parent paths and exact candidate blobs. Component
  closure and teardown are recorded in events 11766–11768. E259's `ce5ced6c`
  evidence is historical: review reproduces deletion of a foreign payload
  through a replaced stage-directory link, and its old reporting test cannot
  establish post-handler retry order. Helper `90945b5d` refuses observed
  replacement links; the revised tests establish transient retry and persistent
  failure reporting. The 14-attempt nine-case series
  `f3-runs/series-20261022T201036Z.json` retains expected baseline,
  prior-candidate and ten mutant failures. The additional persistent-failure
  control and full ten-case candidate pass; suppressing the post-handler retry
  fails the after-handler assertion. Raw checks and pins are under Claude's
  existing `f3-runs/a7-20261022T202124Z` artifact directory. The 17-case
  dispatcher rerun on the same helper exits 0: c11–c13 lose handler stage
  residue; the other rows and handler stdin hashes are preserved. Raw NUL,
  invalid UTF-8, inherited-input spoofing, zero-byte error paths and KILL during
  parser spill remain open. Signal-during-creation and check/removal races,
  installed copies and Linux Bash are outside this component proof. Bash 3.2
  pattern assertions in 19 other Bats files require an applicability audit
  before their results support broader parity; they receive no blanket pass.

  Receipt-selected image producer source is integrated at `fbb38781`; its
  80-case component suite uses a mocked loader and does not establish the actual
  image chain. Fresh debug and release v2 native builds and complete
  stable-entry reconstruction now execute successfully. Root retains exact
  requests, the 79-file native inventory, compiler/tool pins, actual process
  terminals and full loaded receipts under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/native-stable-entry-v2-preflight/`.
  Debug build/load PIDs 17230/40589 and release 9687/69334 exit 0.
  Actual-artifact controls PID 2777 exits 0 with 30 intended
  schema/Cargo/pin/mode refusals and four positive/restored loads; its group is
  absent and input/tool pins and restored executable modes match. Parent A7
  remains unchecked in event 11729: these are builds and point-in-time
  reconstruction, not image production, native invocation, installation,
  upgrade, rollback or machine adoption. The CLI refuses the external absolute
  artifact citation as mechanically re-derivable; root's claim rests on
  inspected raw artifacts, not that check.

  Observer evidence also advances without qualifying admission. Kernel probe
  event 11702/result `4b7769d7` observes EADDRINUSE while the listener is held
  or unreferenced, and a foreign listener after close; it establishes no client
  or VM authenticity. Retention event 11730/commit `408c0ad6` records five
  passing filesystem controls, including preserved original bytes after
  copy/index failure. Parent-witness candidate `ea33c0f6` executes 18 component
  cases and 22 retained TCP probes, with actual exit 0, stable pins and owned
  group absent (`parent-witness-controls-01/execution.json`, SHA `ca9926d6`,
  under the observer's existing `store-baseline-consumption/attempt-01` artifact
  root). These exercise synthetic producer membership and hostile protocol
  boundaries, not the genuine six-target/nine-suite outer run. Child A2 remains
  FAIL in event 11805 until that healthy run and a consequential forged-client
  refusal traverse both outer branches and publication. Capability deletion does
  not establish isolation from arbitrary VM host-builtin interception or
  same-uid processes. The observer owns this bounded implementation; root
  retains integration and acceptance.

  The existing worktree guide correction `c58d6f8f` is committed and reviewed;
  source and event 11760 support preview/default-apply/no-close teardown
  wording. Four-guide coherent guarded-source landing remains open. Help
  candidate `d80d3996` describes v1 compatibility and receipt-selected v2 input;
  its focused Node 18/22 help/generator checks do not replace the fresh physical
  prefix. The prepared shared v105 fingerprint is `b706339e` over 75 files; all
  seven other pack fingerprints match. The human-authorized two-path claim
  partition retains those paths as support in archived `shell-analysis`; its
  head, dirty file list, pack bytes and tracked diff hashes are unchanged.
  Root's `shared-pack-105` lane holds the exclusive claims and source patch; the
  parent checkout is clean. The installed guard resolves relative targets
  against the hook cwd, so normal guarded cleanup uses explicit absolute
  owned-worktree coordinates. No guard, identity or foreign source changes are
  made. The earlier full-basis scope failure (event 11772) is retained; 30 exact
  imported paths are reconciled through the CLI and all five gates pass against
  the same 288-file input and index. Neither commit-prefix substitution nor a
  guard bypass is used.

  Execution converges on three owned outcomes: root and the installer peer
  complete coherent package → actual v2 image → isolated native invocation,
  refusal and rollback; root completes native acquisition → continuous-custody
  publication → ordinary reader consumption/release, including both 256-entry
  capacity limits; root connects resident admission to the actual engine and
  exercises thirteen sessions across four repositories. The installer retains
  its clean help candidate for reserved source integration. No machine install
  or whole-migration acceptance is inferred from these source units.

- E261: Shared pack v105 is integrated at `c5b3b360`, and the installer help
  merge produces frozen package candidate `7195f14f`. The authorized transfer
  moves only `manifest-shared.ts` and `tests/init/pack-fingerprints.json` from
  the archived shell-analysis spec's claims to its supporting scope (event
  11806); its branch, files and unrelated dirty test remain preserved. The
  shared-pack child closes with A1/A2 pass in events 11814/11815 and normal
  merge/teardown in 11816–11818. Fresh normal Node 22 build PID 97390 exits 0;
  compiled pack-fingerprint PID 11028 exits 0 with all 14 checks, including all
  eight pack baselines and real-byte, exclusion and coverage controls. These
  checks qualify the pack metadata against these bytes, not cutover.

  The normal npm tarball is 2,580,764 bytes, SHA256
  `5c83b318afbcf945e4dee40b546083b714083396bf2e62410939adc31be7667c`. Root
  independently compares all 1,273 regular tar members and 1,260 captured build
  members. Actual private installation PID 78216 exits 0; Node 18 and Node 22
  inspectors exit 0 over the same 5,708-file, 65-package production prefix. The
  omitted optional `@types/node` peer remains explicit. This is observed
  package/dependency consistency, not compiler provenance, dependency semantic
  trust or general Node-version qualification.

  Corrected receipt-selected v2 descriptors retain exactly 71 native notices and
  one Node notice. The first descriptors duplicated Node's LICENSE; their
  completed first attempts remain retained and do not qualify the agreed notice
  layout. Root verifies that the correction removes only that duplicate. Fresh
  corrected public CLI sequences, negative inputs and tampered recovery complete
  under both Node versions: 68 actual child commands, including 28 intended
  exit-1 refusals with empty success output and unchanged target maps. Root
  reads every terminal/refusal and checks owned-group absence. Both sequences
  select the same legacy A, release B and debug C digests; B is
  `fd38244eedb6ef30e782c5be92002dbda2ac5508ab53ce79ce9a2431dc2b4e74`. Retained
  evidence is under R01's
  `r01-installed-entry/actual-v2-package/7195f14f736e0784b5f0aca0220a6c76c25d9c9c/`,
  including `descriptor-attempt-02` and the six `cases-*-attempt02` directories.
  These are actual installer/state observations; selected stable-entry native
  dispatch, ordinary guard effects, session rendering and harness adoption
  remain separate owed checks. The six qualification homes remain unchanged.

  The assertion-only successor `fb1ba781` changes 61 statements in nine Bats
  suites. Root compares retained source bytes with the commit, reads identical
  179-test baseline/candidate TAP vectors and all 33 intended predicate-failure
  controls, and grounds independent review feedback. Child A1–A3 pass records
  are 11838/11839/11847. The unallocated runs, unpinned live compiled fixture,
  failed temporary-root attempts and unattributable global process count remain
  explicit limits; they do not establish exact installed behavior or timing. The
  separate F1/F2 successor `499ca369` has additional source-review repairs and
  unexecuted changed tests; the earlier `cb43a2c5` probe does not qualify it.

  Root prepares the matched source landing in its owned `native-source-landing`
  lane without moving frozen `7195f14f` or taking peer claims. The ten merge
  conflicts preserve the candidate's coupled native/TS/tooling contracts and
  main's fixes, including Handlebars 4.7.10 and two existing test repairs.
  Canonical governance is unchanged by the staged source merge. This merged
  source needs its own dependency/build/interface checks and committed review;
  the frozen candidate's package observations cannot qualify different bytes.
  Root retains both native publication and TS ordinary consumption/release,
  durable original IDs, both 256-entry capacity traps and actual resident-engine
  execution through the thirteen-session/four-repository workload. Main landing,
  the existing guide updates, full observer qualification and machine cutover
  remain open. Parent evidence 11841 retains the detailed ownership/nonclaims.

- E262: Normal source merge `1c39bd3cd708076d54a34bfec10d8992de8f3286` lands
  `c9b919e6`, frozen `7195f14f`, shared pack v105 and the F3 cleanup on main.
  Root verifies ancestry, clean canonical checkout and the merged event's
  `canonical_checkout_state: in_sync`. Event 11869 leaves the source-landing
  spec active; 11870 removes the lane; 11871 explicitly binds the remaining work
  to root through its active bridge. Source A1 passes; A2/A3 and every parent
  criterion remain unchecked. This is source publication, not machine
  installation, native callback proof or cutover acceptance.

  Exact-candidate isolated dependency installation PID 31860 exits 0 and selects
  Handlebars 4.7.10 without changing shared caches. Fresh normal build PID 61189
  exits 0. Focused PID 90661 exits 1 solely because root supplied the
  nonexistent plural fingerprint filename: seven executed suites pass all 648
  assertions. The failed attempt remains retained. Correct singular fingerprint
  PID 98328 exits 0 with all 14 checks. Full-basis gates evaluate all 261
  changed files; all five pass, including the run after admitting 26 exact
  historical support paths whose final bytes equal main. Independent committed
  source review and raw-check followup find no consequential merge-loss
  counterexample.

  Normal package PID 94849 exits 0, retaining 1,273 regular members in the
  2,580,893-byte archive, SHA256
  `7b69981d6d29a351878d31f30d537da8fb6bd3c68fb1a0ca7bed073b26a7b445`, under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/source-landing-c9b919e6/`.
  Native source equals frozen `7195f14f`; 1,257 of 1,260 inspected fresh build
  members match, with only the shared-manifest history comments and two maps
  differing. The earlier frozen-candidate image proof does not qualify the
  changed package. Its fresh installed prefix and actual native consumer checks
  remain owed. The R01 chat is archived; its fixture and six retained homes are
  preserved. Root retains execution and acceptance, publication/CONSUMED and
  both capacity boundaries, resident execution, thirteen-session/four-repository
  qualification, existing guide reconciliation and machine cutover.

- E263: The matched package reaches the actual private installed native entry.
  The seven loader controls under
  `/Users/darianrosebrook/.codex/artifacts/01a164bc-7a2b-75e2-be81-5da9d0a29252/main-prefix-c9b919e6/`
  accept the original, copied and restored image and reject missing, extra,
  changed-engine and receipt-identity variants. The independent 5,786-member
  prepared-image join establishes the selected package boundary; it does not
  establish execution. The first real native invocation fails before its first
  frame because multiline RawValue JSON splits the LF transport. That failure
  remains retained rather than being counted as a guard refusal.

  Two-file framing repair `85d301ad` lands on main in `c81dcedb`. Its actual
  fresh release build exits 0; the independent installed-image join covers 5,901
  files in generation `1da4f1a8…11df0`. Direct installed-entry controls produce
  benign multiline Read exit 0 (PID 6040), foreign-worktree Bash exit 2 with the
  specific ownership refusal (75243), CRLF/large-numeral Read exit 0 (74877),
  malformed UTF-8 exit 2 (50520) and malformed JSON exit 2 (92623). The image
  and input pins remain unchanged and the recorded groups settle. Raw commands,
  outputs, terminal observations and joins are retained under
  `/Users/darianrosebrook/.codex/artifacts/01a15a2a-5057-75d0-a7e5-69d676673add/native-image-invocation/`.
  Framing A1–A3 have paired spec/event records 12070, 12071 and 12089; the
  bounded framing spec is closed. The observed guard route is the compatibility
  dispatcher. Native vendor callbacks, complete handler replacement,
  publication, no-Python packaging, rollback and machine adoption remain
  unqualified.

  The user-appointed integration lead is session `01a164bc`. Audited claims
  transfer the parent, publication boundary, session publication, seal
  preparation and guard-documentation lanes to that lead. The former lead
  completes and releases the framing slice. Existing source-landing obligations
  remain under the new lead's accepted active bridge. The next source unit
  connects native Git custody to the actual typed engine; separate publication
  work retains original-ID durability, continuous writer custody,
  ordinary-reader validation, exact CONSUMED and both 256-live-record limits.
  Resident engine reuse and the thirteen-session/four-repository workload remain
  integration obligations. No component checks or ownership transfer lower
  parent acceptance.

- E264: Explicit license-transport recovery unblocks the normal package build
  without adopting or deleting retained license leaves. Candidate `4cec500a`
  lands in `b5853bff`; A1/A2 have paired evidence events 12117/12118 and the
  bounded recovery spec is closed. The 45-case suite exercises strict ordinary
  refusal, changed marker identity/bytes, symlinks, locks and retention/close
  failures. Actual stale marker `44f6240e…56b7d5` is retained byte-for-byte;
  before/after observations preserve the existing LICENSE identity and bytes.
  Normal build, cleanup and restaging exit 0. Raw evidence resides under
  `/Users/darianrosebrook/.codex/artifacts/01a164bc-7a2b-75e2-be81-5da9d0a29252/license-transport-recovery/`.
  This relinquishes obsolete deletion authority; it does not prove reboot
  causation, concurrent atomic-replacement safety or runtime cutover.

- E265: Request-owned context Git reaches the actual typed one-shot engine. The
  macOS candidate advertises its capability, performs the two fixed Git queries
  through native custody before Ready, and preserves the absent- capability
  legacy path elsewhere. Normal build, six actual-entry controls, 16 native
  custody/frame-pump controls, seven protocol controls and 17 runner controls
  execute with retained raw outputs. The initial entry fixture failure names its
  missing runtime manifest; installing a real private runtime repairs the
  fixture without changing the Ready/dispatch/handoff requirements.

  `scripts/qualify-context-git.cjs` exercises ordinary and linked checkouts,
  then four same/cross-repository SIGTERM/SIGKILL controls. The actual guarded
  command refuses the one staged tracked-file deletion without arming the danger
  latch. Each cancellation records the original native custodian, Git group and
  pipe-holding descendant, observes all three processes disappear, and observes
  B remain live before releasing it to its own guard and journal.
  `integrated-main-02` exits 0 in 11.913 seconds with unchanged source/image
  pins and no supervisor-group residue. Its native binary SHA is
  `bea9e86db359cac4e331fb2bd0ef3beeef3515b9a6eba6f1c89bd410cff8ee9a`. Commands,
  original failures, input/output bytes, per-client terminals, process
  observations and journals reside under
  `/Users/darianrosebrook/.codex/artifacts/01a164bc-7a2b-75e2-be81-5da9d0a29252/context-git-custody/`;
  the integrated fixtures are in `ordinary-consumers-main-02/`. This qualifies
  the bounded project-resolution path, not every classifier Git subprocess,
  Linux custody, immutable executable launch, resident reuse, vendor callbacks,
  full guard parity, no-Python packaging or the required
  thirteen-session/four-repository workload. Source acceptance and landing
  remain separate from these execution observations.

- E266: Context-Git candidate `7db95f44`, integrated with main at `b18195ea`,
  retains a normal build exit 0, the combined four-suite exit 0 with 193 checks,
  and actual native ordinary/linked/cancellation controls in
  `context-git-custody/{ts-committed-build-01,ts-committed-combined-01,integrated-committed-01}/`.
  The two lint repairs reconstruct the prior checked test hashes exactly when
  reversing only `globalThis.AbortController` and the `node:timers` import.
  These checks preserve the six Ready/dispatch/handoff assertions, including
  fatal cleanup uncertainty and the absent-capability legacy control.

  `integrated-pending-02` adds a real escaped-group descendant holding both Git
  pipes beyond the cleanup budget. The actual frontend exits 2 with protective
  block JSON and the cleanup-pending diagnostic, without a pre-Ready invocation
  journal.
  `ordinary-consumers-pending-02/pending-pipe/retained-after-frontend.json`
  records original Git PID 11428 unreaped, its pipe holder 11540 live, and
  native custodian 11427 live after frontend 11365 exits. Only the fixture's
  explicit pipe-release permits all three to disappear in the retained
  settlement observations. The first probe's empty-output assertion was
  incorrect: the existing native PreToolUse failure contract emits protective
  JSON. Its failed output is retained in `integrated-pending-01/`; the repaired
  oracle requires the exact block/diagnostic relation rather than accepting
  arbitrary output. Both runs use the E265 native image and compiled ordinary
  engine, with no production change. Artifact paths are relative to the E265
  artifact root. This demonstrates retained custody through a concrete
  unsettled-pipe case; it does not establish killing escaped groups, recovery
  from kernel failure, immutable executable launch, residency or full cutover
  acceptance.

- E267: Ordinary test preparation lands on main in `4a584028` from candidate
  `74e174a5`. The package test command builds the CLI, both qualification helper
  entrypoints and the feature-off host native binary before Jest. Retained
  fresh-output execution exits 0 with 37 consumer/routing checks, and the Rust
  1.90 context-custody suite executes 16 cases without skips. The committed
  preparation/failure-path replay exits 0 with 33 checks. A real Turbo probe
  changes only Rust source in a finite fixture: the CLI test hash changes while
  CLI-local inputs remain identical. The separate full-repository dry run
  records native source among global cache inputs.

  Evidence resides in
  `/Users/darianrosebrook/.codex/artifacts/01a164bc-7a2b-75e2-be81-5da9d0a29252/native-test-preparation/`,
  including `testprep-ordinary-01`, `testprep-context-01`,
  `testprep-committed-js-01` and `turbo-rust-invalidation-04`. Independent
  review questions were grounded against workflow triggers, macOS-only C build
  selection, the artifact linker's single target-directory symlink and actual
  Turbo invalidation. These observations do not qualify Linux execution, Windows
  native support or hosted CI. A1/A2 are recorded pass; A3 remains unchecked in
  events 12164–12166. The source lane is removed by the governed merge with
  `--no-close`; lead session `01a164bc-7a2b-75e2-be81-5da9d0a29252` retains the
  active spec bridge and hosted clean-checkout qualification.

- E268: Publication component `2fa83e17`, integrated with main at `f2ca021e`,
  has bounded native journal, Actor, writer, prefix and relay checks. Additional
  probes reject byte-identical artifact replacement before CONSUMED and retain
  journal uncertainty after reported file/directory sync failure. The latter
  injects an error after real sync; it does not simulate power loss. The
  TypeScript callback repair bounds preparation and semantic-consumer waits,
  closes held reader descriptors, observes late rejection and forbids subsequent
  publication output after abort/deadline. A normal build and 14 focused suites
  exit 0 with 594 checks and unchanged source/native-image pins.

  Actual frontend qualification contradicts an integrated success claim:
  `actual-session-publication-fixture-01` records native prefix completion,
  original reservation and writer retention, followed by the ordinary handler's
  `Invalid native publication chunk` error. The frontend exits 2 and the Actor
  records `session_retained`; cleanup observations contain no remaining
  processes. No semantic-consumer completion or durable CONSUMED is established.
  Source-progress owns the Rust/TypeScript wire-contract investigation and
  client repair; root owns the qualifier, native integration, evidence and
  landing. Publication-integration owns the read-only next-slice investigation
  for SQL publication and actual warm-renderer residency. Artifacts are under
  `/Users/darianrosebrook/.codex/artifacts/01a164bc-7a2b-75e2-be81-5da9d0a29252/publication-integration/`.
  The next decisive check reruns the real frontend through semantic readback,
  durable consumption and writer release, then exercises changed input and lost
  acknowledgment. These checks leave full Render discovery, SQL publication,
  residency, package adoption and complete cutover acceptance open.

- E269: The E268 failure exposes a real direction-schema mismatch: native
  captured inputs used the prepared-output `chunk.v1` schema while the ordinary
  TypeScript client required `inputs.v1`. The native emitter uses the declared
  input schema; strict TypeScript refusal is preserved. Six native publication
  tests include exact multi-chunk emitted bytes and correlation. Literal wire
  controls and actual compiled-entry refusal execute in 95 checks across two
  suites. No decoder relaxation or failure-to-success fallback is introduced.

  `publication-integration/actual-session-publication-03` exits 0 in 20.732
  seconds against the rebuilt feature-off binary and compiled ordinary engine.
  `actual-session-publication-fixture-03` retains five cases and same-host
  subsequent invocations. Codex and Claude publish exact seven-field 4301-digit
  sums, ordered independent models and the unrelated 9007199254740993 token;
  marker, final metadata, invocation journal and durable operation agree on the
  terminal digest. Missing metadata is explicitly not published and exits
  silently. Each successful case records durable CONSUMED before heavy release,
  admits a writer probe while the host remains live, and admits another original
  with the configured one-record live capacity.

  A byte-identical turn-file replacement after ordinary semantic observation
  causes frontend exit 2; killing the original frontend in the same window
  preserves its SIGKILL terminal. Both cases retain the returned publication,
  refuse writer reacquisition with exit 75 and refuse later original admission
  on the same host. Neither records CONSUMED. Final process observations are
  empty and all input/source/tool pins are unchanged. Probe 02 retains the
  successful normal cases and the first hostile result, but fails because its
  writer-refusal oracle expected a different diagnostic. Probe 03 requires the
  actual source-defined custody diagnostic exactly. These are single observed
  hostile windows, not repeatability or timing-distribution claims.

  This establishes the bounded direct-native SessionEnd chain. Vendor harness
  delivery, SQL publication, full Render inputs, warm renderer retirement and
  more than 256 actual original operations remain separate obligations. The next
  coherent integration is actual warm Codex Render A, Claude SessionEnd seal and
  actual Codex Render B under one project owner, followed by SQL
  acquisition-to-publication wiring. Switching `capture_publication` alone is
  insufficient: the compiled engine also needs the selected store port,
  Projection/Render preparation and complete native renderer observations.

- E270: Review of committed integration `fbfdc316` identified a received-prefix
  observation lost when cancellation arrives before journal append. The engine
  records the received fields before refusing cancellation; this diagnostic
  record does not grant publication authority. Completed and unavailable-prefix
  cancellation controls assert recorded effects, no seal and no compatibility
  replay. The missing-session concern is excluded by the separate SessionEnd
  admission's exact nonempty original/resolved identity comparison; the
  identity-free test cited by review exercises the other cache profile.

  A normal build and 339 checks across four suites exit 0. Actual frontend
  `actual-session-publication-04` exits 0 in 21.074 seconds, with source/tool
  pins unchanged and no process residue. Its hostile cases retry the same
  session with two live-record slots. Native admission records `unknown_fence`
  while one slot remains available, and retained metadata/marker hashes remain
  unchanged with no second ordinary-consumer completion. This distinguishes
  truthful unknown-effect refusal from the earlier full-capacity refusal. The
  failed wire exchange in probe 01 is explained by the E269 native schema
  repair; probe 02's diagnostic-oracle correction changes no production code.
  The earlier 95-test machine-readable Jest result was overwritten by reuse of
  its output argument during the later 339-test run. Its original raw logs and
  execution receipt remain intact; `result-overwrite-observation.json` records
  the mistake and the later result's relocation. No lost JSON is reconstructed.

  The normal main push at `d4f2be80` exits 1: typecheck, dependency audit and
  6,454 tests pass, but qualifier timer imports fail lint and the first build
  refuses changed license-marker custody. A later sequential preparation build
  passes; it does not erase the earlier failure. Remote main remains `da876692`.
  Twenty private stage/dist-removal/restage/cleanup cycles across Node 22.19 and
  22.22.2 do not reproduce the custody failure. Root retains its cause as
  unresolved and owns precise refusal diagnostics and one observed normal build
  before retrying publication. No deletion-authority checks are weakened.
  Evidence resides beside E269 under `main-push-01` and
  `license-staging-probe-01`, with publication checks under
  `publication-integration/ts-prefix-observation-*` and
  `publication-integration/actual-session-publication-fixture-04`.

- E271: The native publication source lands on local `main` at `6defc8aa`
  through child merge `1e88c3c9` and publication-parent merge `65a9c686`. The
  final gates evaluate 50 changed paths and pass after admitting the exact typed
  SessionEnd preparation and its tests. Runtime source blobs match the actual
  frontend 04 candidate; inherited test-preparation package scripts and one test
  configuration are the only changed pins in that check's TS inventory. Child
  evidence 12189–12191 remains unchecked, and its superseded disposition
  transfers the unfinished integration to the active publication parent rather
  than claiming completion. Parent records 12200 and 12225 retain root
  ownership.

  The next decisive runtime scenario is actual warm Render A → native SessionEnd
  → Render B, with each original request bound to its exact Prepared/backend and
  the original native worker's observed kernel birth. Event order without a
  synchronized contender cannot independently prove uninterrupted writer
  custody; B's ordinary current-generation publication remains a separate check.
  SQL CLOSED-to-publication, more than 256 real original operations, the full
  residency workload, package adoption and rollback remain required. The landed
  slice does not change the selected machine runtime.

- E272: Normal push `main-push-02` at `51411cbf` exits 1 in 342.002 seconds,
  with source pins unchanged, no cleanup signals and no remaining process group.
  Typecheck, lint, audit and build pass. The complete test run exposes missing
  quality-inventory classification for `session-seal-prepare.ts`, two positive
  merge-hook fixtures without the staged runner dependency, and the shared-pack
  fingerprint/version missing the changed session schema. The sparse runner spec
  is reopened for its fixture repair; classification must preserve existing
  mutation targets and floors. The earlier license-marker failure remains
  unexplained despite this successful build.

  Publication candidate `42fbeb0c` passes both 64-MiB inventory-order controls
  from a fresh committed-source export. An isolated mutant restores alphabetical
  writes before removals and removes the shrink-first ordering; both unchanged
  tests then fail specifically at `session inventory byte bound`. Control and
  mutant retain separate targets, identical tests and constants, unchanged input
  pins and empty final process groups. Evidence is under
  `publication-integration/inventory-order-mutation-01/{control-01,mutant-01}`.
  This establishes sensitivity to intermediate named-inventory growth, not a
  total disk-space quota. Source inspection finds missing selected leaves
  refused by the ordinary reader and Running→Unknown recovery before fresh host
  admission. Composed crash-after-unlink → host restart → frontend refusal and
  actual directory-sync/Nth-removal fault injection remain unexercised.

- E273: Candidate `0699c408` contains the strict TypeScript/Rust staged-image
  transformation repair and typed known-not-executed replay-capacity refund. The
  image checks execute file, pipe, large-input staging and staging-failure paths
  with exact arguments, stdin, exit status and selected-only descriptors; the
  TypeScript suite passes 73 checks with ten existing profile skips and Rust
  passes three focused controls. The replay control first fails with
  `retained: true` and exhausted fresh-original capacity, then passes after the
  repair while preserving the durable consumed tombstone and session files. Nine
  focused session controls retain wrong-ACK and uncertain-effect records.
  Evidence is under `publication-integration/runner-transform-*` and
  `publication-integration/session-consumed-replay-*`. Strict compilation,
  normal CLI build, the pinned release-native build, scoped doctor and five
  ten-path gates exit 0; independent committed feedback is source-grounded.
  These finite checks do not establish sustained capacity or machine adoption.

  `warm-render-execution-02` exits 1 in 28.079 seconds with unchanged source
  pins and no remaining supervisor process group. Actual Render A traverses the
  repaired image successfully. SessionEnd exits 0 through compatibility dispatch
  without a native-prefix completion record, so Render B is not attempted. The
  fixture's project `runtime-paths.sh` makes native SessionEnd admission
  ineligible; a selected stock handler alone is insufficient. The original
  failed manifest also records unknown cleanup because identity assignment
  followed the failed semantic assertion, and expects two worker cleanups
  despite creating only A. Preserve that manifest and reconcile custody from
  request 009's retained original identity and terminal witness separately. The
  next fixture uses one supported alternate Render-source root throughout A,
  SessionEnd and B, with the native-prefix admission predicate checked before
  execution. No production admission relaxation or between-phase source change
  is authorized. Warm continuation and continuous publication remain unchecked.

- E274: Normal push `main-push-03` at `06ed2a1b` exits 1 in 357.575 seconds with
  unchanged source pins, no signals and no remaining process group. Its
  typecheck, lint, audit and build pass. The complete Jest run has one failed
  assertion: the shared pack fingerprint. The repaired inventory and merge-hook
  fixtures pass. The full prior push-02 log contains that fingerprint failure
  too; E272's earlier two-category account omitted it. Neither failed push
  advances the remote.

  Comparing all 75 tracked shared-pack files against baseline `bd4a2c75`
  isolates `lib/session-log.schema.json`; live and committed trees both hash to
  `cc16fd46cc2fbd646eadb6063a12db1d432df78d0e48ff9ab45adb427c4af157`. Shared
  pack version 106 and its paired fingerprint describe that schema change. No
  template, guard, mutation floor or selected installation is altered by the
  version repair. The raw comparison is
  `publication-integration/pack-fingerprint-diagnosis-01/tracked-pack-comparison.json`.
  The normal CLI build exits 0 in 5.894 seconds. The unchanged fingerprint and
  installation-rendering suites exit 0 in 2.584 seconds: all eight pack
  identities, real-file-change and missing-surface controls, and managed
  shared-hook version headers are exercised. Both runs retain unchanged input
  pins and empty final process groups under
  `publication-integration/pack-version-{build,tests}-01`. Full push, hosted
  qualification and adoption remain separate obligations.

  The failed warm-02 manifest remains unchanged. Separate retained request-009
  configuration, original-input hash, Claude journal and native terminal witness
  correlate to `confirmed_settled`; root independently re-executes the existing
  pure correlator in
  `publication-integration/warm-render-actual-02-reconciliation-01/root-correlation.json`.
  Additive birth observations report all 61 retained PIDs absent; the corrected
  actual rendezvous-socket observation is separate from the initially mistaken
  path observation. This resolves the bounded cleanup inquiry, not native
  SessionEnd publication or Render B. Compatibility dispatch did change
  metadata; silent exit zero is not native publication evidence.

- E275: Normal push `main-push-04` publishes `03997170` to remote `main` with
  unchanged hooks and source pins, exit 0 in 326.763 seconds and no remaining
  process group. Typecheck, lint, audit and build pass; the full Jest run passes
  347 suites with 6685 passing and 13 skipped checks. The retained execution,
  stdout, stderr and process observations live under `main-push-04`. Remote ref
  readback matches the pushed revision. This completes that source-delivery
  attempt, not hosted qualification.

  Hosted Release Qualification run `39946247481` on that exact revision passes
  native context Git custody but fails candidate tests/contracts and all six
  packaged-upgrade jobs. Inspected macOS/Node22 and Ubuntu/Node22 logs fail at
  `runtime-upgrade-smoke.mjs:241`: the freshness generator writes a diagnostic
  before `npm pack --json` output, so JSON parsing fails. The candidate-test
  failure is a separate investigation. Neither hosted failure grants adoption.

- E276: A real npm lifecycle fixture reproduces the package JSON failure in
  `pack-json-baseline-01`, exit 1. The generator's success diagnostics move to
  stderr. Regenerating the owned projection changes only its generator-source
  digest; shared pack version 107 and fingerprint
  `027a5417546af3c7b4056c7f20aeb7d73eec8ef40db95458138c905fb9f49f64` cover all
  75 tracked files. The initial repair check correctly refuses the stale
  generated header; `pack-json-repair-01` retains that failure.

  The fresh build exits 0 in 6.029 seconds. The generated-asset, fingerprint and
  installation-rendering suites exit 0 in 5.563 seconds with 89 checks. These
  exercise actual npm JSON output, stderr diagnostics, stale/missing/mutated
  assets, detached binary behavior, pack identity and installed version headers.
  `pack-json-actual-execution-01` runs the candidate's actual prepack/postpack
  lifecycle and exits 0 in 3.314 seconds; its stdout parses as one JSON result.
  `pack-json-actual-01/inspection.json` identifies the 1305-file tarball with
  SHA `4c41479d4fe41fd12c3afb22767aa8b2f310825c3edc0c0f0418171bad716d7c`. Each
  execution retains unchanged source pins and no remaining process group. These
  artifacts live under `publication-integration/`. They establish the repaired
  output contract, not the full upgrade matrix, package installation, native
  activation or rollback.

- E277: SQL adapter `2002df5d` connects the original port's actually exhausted
  CLOSED acquisition to Projection, exact captured projection bytes, supplied
  Render preparation and the ordinary current-generation consumer before ACK.
  Review-response tests `09a06eac` require exact failure causes and callback
  identity, distinguish EOF from the intended rejection, and reject wrong Render
  names, roles, duplicate outputs and renderer exceptions before PREPARED/ACK.
  `publication-integration/ts-store-adapter-focused-03` retains exit 0 in 1.671
  seconds, 65 focused checks, unchanged source/dist pins, empty final process
  group and a committed-blob comparison. The production route is unselected;
  real Render context/calendar observations and matched native/TS activation
  remain required. Mock transport composition does not establish native custody.

  Warm qualifier `cf958215` requires seven positive usage values from recognized
  Codex input records and exact rendered values, and describes its ancestor as a
  Claude-named pinned Node fixture. Actual `warm-render-execution-03` exits 1 in
  18.105 seconds at the seal inventory assertion: the marker includes
  `session-index.json` in addition to metadata and the retained A turn. B is not
  attempted. `warm-render-actual-03/manifest.json` retains the failure, both
  exactly correlated settled native requests, confirmed inactive cleanup and the
  one actual worker birth/cleanup/exit tuple. Root preserves that failure while
  the qualifier owner compares the inventory oracle to producer and reader
  contracts. No completed warm continuation is inferred.

- E278: Hosted candidate job `120389516965` retains 22 Jest failures in
  `publication-integration/hosted-candidate-03997170/candidate-job-120389516965.log`:
  17 service-image cases reject Linux `/bin` symlink traversal, two
  legacy-profile cases depend on an unavailable historical Git object in a
  shallow checkout, and three heartbeat cases inherit Python setup's
  `LD_LIBRARY_PATH` and reach the intended production refusal. The job passes
  build, typecheck and lint; contracts, docs and Bats are skipped after Jest
  fails. These are separate from E276's package JSON defect. Fixture isolation
  must preserve the loader refusal controls. Image admission must independently
  derive the physical target of fixed system shell paths while retaining
  no-follow candidate checks.

  The hook artifact uploader also encounters an intentional self-referential
  fixture symlink. The workflow archives the retained roots without following
  symlinks and uploads the archive, preserving hidden `.caws` evidence too.
  `publication-integration/ci-artifact-archive-01` executes the exact workflow
  shell block in a private fixture, exit 0, and inspects the archive: the link
  remains a link, the hidden failure receipt remains exact and binary output
  retains NUL and invalid-UTF8 bytes. This local BSD tar observation does not
  qualify Ubuntu tar or GitHub upload; those remain hosted checks.

  Committed package repair `59c574a8` receives a focused exact-commit replay
  after hook formatting: eight generated-asset checks pass in 3.710 seconds.
  `publication-integration/pack-json-committed-source-01.json` joins the earlier
  build/check/pack working-tree pins to the committed production blobs, and
  compares the packaged generated asset bytes directly to the committed asset.
  The tarball's compiled manifest declares shared version 107. The supplied
  earlier HEAD values identify dirty-checkout bases, not different production
  candidates; retained byte identities establish the connection. Full package
  upgrade and selected installation remain unverified.

- E279: Hosted fixture repair `c01450eb` carries the exact reviewed historical
  agent-surface bytes in a hash-checked fixture; a historical Git object is no
  longer an execution dependency. Ordinary heartbeat setup removes inherited
  loader variables while hostile cases explicitly restore them. The whole stock
  handler file passes 81 checks; an explicit ambient `LD_LIBRARY_PATH` run
  passes the three positive and four loader-refusal cases. Raw execution and
  committed byte joins live under
  `publication-integration/hosted-stock-fixture-*`.

  Image repair `3c4c9fa0` independently resolves fixed `/bin/bash` and `/bin/sh`
  system aliases in TypeScript and Rust. Candidate paths must equal the physical
  targets and retain existing no-follow, hash, executable and identity checks;
  arbitrary aliases and copied binaries remain refused. The ordinary CLI build
  exits 0; focused image/offer checks pass 143 cases with ten existing reviewed
  profile skips. Native feature-off image checks pass 31 cases. The initial
  missing-import compilation failure is retained separately; no tests ran in
  that failed attempt. `publication-integration/source-shell-target-native-02/`
  joins the passing raw checks and committed four-file blobs. This is current
  macOS evidence; the workflow adds the same focused native admission check to
  its Ubuntu candidate job for decisive Linux execution.

- E280: Warm attempt 04 reaches B but fails the tool/assistant order assertion.
  Its input gives all events in each turn the same timestamp. SessionEnd's two
  legitimate hook records activate the reviewed renderer's chronological merge;
  its equal-time priority places assistant text before tool use. The unchanged
  raw attempt and additive source-derived diagnosis are retained under
  `publication-integration/warm-render-actual-04{,-diagnosis-01}`. The qualifier
  preserves its semantic order assertion and gives warm input distinct monotone
  timestamps in `f20e85ae`; the default fixture grammar remains unchanged.

  `warm-render-execution-05` runs tools05 against the pinned build02 native
  image and current compiled CLI, exit 0 in 22.159 seconds, unchanged source
  pins, no signals and no remaining process group. Under
  `warm-render-actual-05`, `request-{1,2}/semantic-turns.json` retains actual
  user text, correlated tool calls/results, assistant text, exact env model and
  all seven positive usage fields. `session-end/metadata.bin` carries exact
  counts 100/30/7/5/20/11/130; `marker.bin` binds metadata, retained index and A
  turn. The ordinary consumer journal and compact durable CONSUMED record share
  terminal digest
  `536c5f37987cf1f92bb50e36b3f75b89bd225692629dea38f29ee65f84a2a2d9`. A's
  worker/backend tuple 19726/19729 is reaped with both EOFs and its birth is
  absent before B's new tuple 22898/22901. All three original native requests
  have settled custody; final cleanup is confirmed inactive with two exact
  worker creation/cleanup/exit tuples, absent socket and free custody.

  This completes the bounded warm continuation probe through the reviewed copied
  Render profile and sole stock SessionEnd handler. It does not qualify deployed
  harness callbacks, SQL Render activation, B's current publication marker, a
  nonempty Codex model union, continuous exclusion under a competing writer,
  concurrent fairness, legacy Render compaction or machine adoption.

- E281: Normal no-close merge `990e9b5a` lands the E276-E280 source, fixture,
  physical-shell and archive repairs. The unchanged-hook normal push at
  `4c5a894d` fails in 340.644 seconds: 6,693 Jest tests pass, thirteen remain
  skipped and one CI contract test fails. That test expects the former raw
  `release-scenarios/` upload path, while the workflow uploads
  `hook-byte-artifacts.tgz`. Root retains the failed raw output, stable tracked
  source pins and empty final process group under `main-push-05/`; remote main
  has not received this candidate. The replacement oracle must execute the
  archive step and inspect hostile symlink, hidden receipt and binary bytes,
  preserving failure propagation and independent pytest execution.

  Test repair `db48421f` executes the extracted workflow Bash block and real tar
  listing/extraction. `publication-integration/release-workflow-tests-01/` exits
  0 in 2.734 seconds with all four focused tests passing. The retained fixture
  keeps `loop -> loop`, hidden receipt bytes `00fffe800a7f`, release bytes
  `0100c3280d0a` and the successful archive. An output-directory conflict makes
  the unchanged archive command fail nonzero. Supplemental input and commit
  records bind the tested file, workflow and imported scripts; the physically
  copied ignored CLI build matches canonical push05 sources and is explicitly
  borrowed, not a new build. Hosted GNU tar/upload and the next full push remain
  unverified.

  Independent review identifies missing one-directory/empty-input coverage.
  `release-workflow-tests-02` adds real hook-only, release-only and neither
  cases; all four focused tests pass, exit 0 in 2.767 seconds, with unchanged
  source/dependency pins and no remaining group. Directory-only cases retain
  exact bytes; the empty case creates no archive. Listing checks permit benign
  tar metadata while exact extracted bytes and symlink targets remain required.
  The output-conflict refusal does not depend on platform-specific error text.
  Retained fixtures deliberately remain in a distinct test directory for
  inspection, including their archive and extracted hostile link.

  Capacity qualifier `f31e8401` removes the derived admission-count field and
  requires each original's actual owner observations in order: reservation,
  writer retention, durable consumption and heavy release. The reservation
  follows actual capacity acquisition; consumption precedes record removal and
  writer release. `publication-integration/capacity-lifecycle-controls-01/`
  retains 22 actual-source pure controls, including rejection of missing,
  reordered, duplicate, wrong-original and spoofed lifecycle events. The
  selected typed SessionEnd path spawns no shell helper; cleanup observations do
  not claim arbitrary detached-descendant coverage. All 28 inspected prior
  invocation directories retain terminal cleanup receipts, including killed
  frontend cases. These observations do not establish the new sampler's timing
  or 258-original completion. The first actual run retains the original
  per-request and aggregate budgets, and partial completion cannot pass.

- E282: `publication-integration/capacity-actual-01/` executes the reviewed
  `f31e8401` qualifier with pinned native build02, current compiled CLI, tools05
  and the native process observer. The supervisor exits 0 in 209.873 seconds;
  source pins remain unchanged, all 258 originals complete, every strict
  request-custody/cleanup result is settled/inactive, and the final observed
  census is empty. No supervisor cleanup signal is needed. The qualifier
  intentionally stops its original owner Child after the workload.

  `fixture/result.json`, SHA
  `172380268f12f80cafeac339525ddaa613cdd56e1798c5f32b6a321f1fce80da`, retains
  258 distinct originals on owner PID 98305, with original birth
  seconds/microseconds `1792759602/231522` and `maxRetainedRecords: 1`. Every
  original has the four ordered lifecycle observations; root inspection confirms
  each release precedes the next reservation. There are 268 discovered native
  invocation directories, including the five default cases and their followups.
  Every capacity ID joins a terminal cleanup receipt. Original 258,
  `52826-1792759792120534000`, has exact ordinary-consumer counts/models,
  terminal digest
  `4cd3bae1a6eb298c6f49c7a5bf32601fe835730f5062ef9912c81437d48552d7`, an empty
  heavy request in its durable consumed record, a current marker and a
  successful writer-release probe. Earlier marker/tombstone bytes remain
  unchanged after the last admission.

  This establishes sequential successful-operation capacity reuse beyond 256
  originals. It does not establish concurrent fairness, thirteen-session/four-
  repository load, uninterrupted warm-writer exclusion under a contender,
  restart/upgrade behavior at this scale, SQL Render activation, the eventual
  combined package or machine adoption. Scanner observations cost 83.327 seconds
  in aggregate, with a maximum sample of 0.337 seconds; this instrumented run is
  not a production latency benchmark. A5 remains unchecked with this bounded
  evidence recorded through the authoritative CLI.

- E283: Dormant Git-context component `848056e9` lands through governed merge
  `b607d88a`; its three bounded criteria are recorded and read back in events
  12362–12364 before closure. `publication-integration/render-context-build-03`
  exits 0 in 6.432s, project regression02 executes 15 checks in 5.298s, native05
  executes six integration cases in 6.568s, and JS03 executes 57 checks in
  0.964s with 14 actual native captures and zero skips. All six committed source
  blobs join the before/after pins in
  `render-context-review-repair-committed-source-join.json`.

  Actual shell/native controls retain linked/subdirectory/lexical-CWD, detached,
  dirty, unborn and outside behavior. The review exposes an over-strict UTF-8
  check on ignored stderr/probe/status bytes; the repair decodes only consumed
  text and counts status LF bytes. A bare repository's successful false-valued
  probe still reaches the failing status command, matching the shell's exit128
  and absent context. Timeout, cancellation, held pipes and output exhaustion
  retain raw failures and independently settled final custody. Three injected
  persistent stop refusals retain one actual Child; only independent teardown
  establishes settlement. Historical native02 cleanup remains unknown. The
  component does not activate a caller; the parent owns pre-Node capture,
  one-time publication-token binding, finite cleanup with retained uncertainty,
  calendar transport and actual Render consumption.

- E284: Local source merge `821afd74` integrates the publication adapter and
  qualifiers without closing the combined-image obligation. The unchanged
  `main-push-06` hook run at `98003636` exits 1 in 341.870s. All 349 suites pass
  (6779 tests, 13 skipped); lint reports five undefined interval-timer names in
  `qualify-session-publication.cjs`. Commit `60207241` imports those existing
  Node timer functions explicitly. Focused ESLint in
  `publication-integration/source-publication-lint-03` exits 0 in 0.983s with
  stable source pins and no residue. Attempts01/02 fail during tool-path setup
  and establish no lint result. Remote publication remains pending a successful
  unchanged full push. No hook floor or runtime timing behavior is changed.

- E285: The unchanged full `git push origin main` at `5bf613cb` exits 0 in
  350.058s. `main-push-07` retains raw hook output, before/after source pins,
  process observations and the remote update from `03997170` to `5bf613cb`; an
  independent `git ls-remote` confirms that exact main revision. The gate
  reports 6835 passing tests and 14 skipped, with no timeout, cleanup signals or
  remaining process group. This publishes the SQL publication adapter,
  Git-context component and timer-import repair. Hosted admission, the combined
  installed image, ordinary Render activation and rollback remain unverified.

- E286: Calendar review of `9b55f9d1` identifies finite tests to strengthen
  before component acceptance. Repaired native source initializes libc timezone
  state during original capture before engine launch; it never changes TZ or
  TZDIR. This matches the initialization boundary in CPython 3.11.13
  `Modules/timemodule.c:1626,1824`; `Python/pytime.c:1223` separately
  establishes unset-errno mapping to EINVAL. Native checks under
  `publication-integration/` (`calendar-native-integration-05`,
  `calendar-native-unit-03`, `calendar-native-doc-02`) exit 0 in 3.416s, 2.919s
  and 0.589s: six integration tests exercise twelve separate-process profiles,
  six unit tests pin identity refusal and literal errno mapping, and two
  compiler refusals prevent unbound observation and token rebinding. Source/tool
  pins are stable with no residue. Named-zone and TZDIR observations are
  retained; they do not establish Linux behavior or parity with Python for every
  added profile. Typed calendar mutation, exhaustive decimal-digit comparison
  and integrated carrier checks remain open. The carrier build succeeds; its
  first focused Jest run fails on a deferred test promise rejected before the
  production reader adopts it. The fixture must observe actual read start before
  testing late rejection.

- E287: Hosted Release Qualification run `39969630432` on `5bf613cb` fails
  native image admission: 38 checks pass and two prefix-eligibility checks fail.
  Raw logs are retained in
  `main-push-07/hosted-release-qualification-failed.log`. Direct comparison with
  reviewed source `39c76f51` identifies two relevant stale pins: the advisory
  helper changes only its generated provenance comment; the dispatcher uses
  private per-handler stdin stages instead of a shared dispatch stage. Its
  subshell-local paths, unlink-before-exec and link-refusal behavior preserve
  the prefix mutation domains. Root owns the two-pin repair and fresh
  local/hosted checks; unrelated profile entries are not refreshed. The local
  full push exercises the staged/direct service-image transformation and hostile
  call-shape controls. That does not establish native prefix eligibility or
  hosted success. The two-pin repair's
  `publication-integration/source-prefix-image-01` executes all forty native
  `service_image` checks with locked, offline Rust 1.90 and two workers: exit 0
  in 13.303s, stable source/tool pins and no remaining process group. The checks
  include both previously failing positive cases and changed-source refusals.
  This macOS observation does not replace a fresh hosted Linux run.

  Calendar's first actual per-file mutation run detects 1000 of 1344 valid
  mutants (74.40%), below its unchanged 80% floor. Publication-integration owns
  semantic test repairs and a fresh score; passing parser comparisons do not
  discharge that gap. Root also retains the activation blocker found during
  carrier integration: Render Git children need launch-time custodian ownership
  through frontend death. Native-context-git owns the bounded existing-custodian
  extension after the carrier/permit-repair checkpoint; retaining a local
  failure value or relying on Drop cannot establish durable process custody.

- E288: Publication candidate `bb07099a` adds the original-bound Git/calendar
  observation carrier; `9f10102a` separately refunds a fresh request's transient
  permit at an established unknown fence only after durable lookup proves its
  identity absent. `publication-integration/render-observation-js-03` exits 0 in
  2.701s across 205 selected checks. The retained committed-source join maps all
  six TypeScript/JavaScript files to the exact Jest and scoped-lint inputs, and
  the four production TypeScript files to the normal build. Native
  `native-render-observation-01` and `native-session-fence-02` exit 0 in 3.584s
  and 13.371s, exercising eight carrier and nine actual Actor checks. Their
  fixture teardown removes generated runtime directories; retained logs and
  source pins do not establish installed execution or the complete native/TS
  consumer chain. The carrier remains dormant pending launch-time Git custody,
  native source acquisition and the actual renderer callback.

  Inspection of the retained E280 warm scenario distinguishes rendering from
  current publication admission: its final marker describes the seal's
  generation, while Render B leaves `session-index.json` at 546 bytes instead of
  the marker's 544 and adds an unlisted `turn-002.json`. The actual marker and
  files remain under `publication-integration/warm-render-execution-05/tmp/`.
  This is not evidence of B's current-generation ordinary consumption. Root owns
  that integrated qualifier, including retained output inventory, semantic
  consumer receipt and continuous writer custody through overlapping requests.

  The calendar worker's stronger malformed-record control exposes a raw
  TypeError from Array.isArray on a revoked Proxy. Scoped repair moves that
  inspection inside the typed error boundary; strict compilation, 23 semantic
  groups, the normal build and 32 direct Jest groups pass. The earlier failure
  remains retained. `renderer-calendar/mutation-02` exits 0 in 264.747s: 1160 of
  1348 valid mutants are detected (86.05%), above the unchanged 80% floor. Its
  assertion reports no errors; 170 survived and eighteen lack coverage. A
  passing floor does not make all survivors equivalent. Final source joining,
  independent review and integration of the repaired calendar remain open.

- E289: Review of the prefix pin repair distinguishes hash admission from
  dispatcher execution. `publication-integration/prefix-staging-bats-02`
  executes twelve Bats cases against the committed dispatcher, exit 0 in 6.962s,
  with stable source/test/tool pins and no remaining process group. Retained
  `tmp/bats-run-OWnEBu/test/11/stage-out/` files contain identical 57681-byte
  handler input and the recorded `23` / `handler-output` result through exec,
  child-after-unlink-refusal and pipe-after-creation-refusal.
  `test/12/stage-out/` retains two distinct stage paths, different expected and
  received 57682-byte payloads for A and B, and both overlap witnesses. Both
  paths are removed from their shared TMPDIR. Earlier cases retain TERM/KILL,
  persistent unlink refusal, non-writable-parent and link-replacement
  observations. Source inspection finds CAWS_TEMP_FILES producers but no cleanup
  consumer in the shipping hook pack; removing its former stage entry loses no
  cleanup. Trusted mktemp exclusive creation and invocation-local subshell state
  separate stage ownership. These observations do not exclude hostile same-UID
  path replacement between check and removal, prove every signal window, or
  establish full four-handler multi-project residency. Hosted Linux
  qualification of the repaired source remains required.

- E290: Source commits `7ac28c52` and `ff10e085` land through governed merge
  `c8f86504`. `/usr/bin/git push origin main` publishes `5a95747f`, exit 0 in
  348.242s, with unchanged hook and source pins; its raw output records 350
  suites, 6835 passing checks and fourteen skips. Receipts and logs are retained
  under `main-push-08/`. Hosted run `39980339378` passes Linux native image
  admission, macOS context-Git custody and all six packaged-upgrade jobs, but
  fails the required Bats step. Its retained failed log identifies an actual
  audit E2BIG error, a fixture that passes a 200KiB environment argument before
  dispatch, a Linux `/bin/bash` assertion that requires macOS's major version,
  and a stage assertion that counts GNU mktemp's dispatcher stderr file as a
  payload. Root owns the audit transport repair and discriminating fixture
  corrections; no package qualification or installed adoption follows from the
  successful push.

- E291: Publication-lane candidate `d0d24f78` moves the four fixed Render Git
  queries into the existing actual-Child custodian. Retained native
  `native-render-custodied-context-02` fails with a truncated final receipt;
  incremental delimiter tracking removes repeated scans without extending the
  reply budget. `native-render-custodied-context-03` exits 0 in 18.953s. Its
  physical fixtures retain original frontend, custodian, Git and descendant
  identities, TERM/KILL observations and absence after settlement. Carrier
  `native-render-custodied-observation-02` exits 0 in 18.905s, and the two named
  journal unknown/recovery controls each execute successfully. Earlier compile
  and short-budget fixture failures remain retained. These feature-off checks do
  not establish SQLite-enabled transport, production selection or complete
  process-custody acceptance; independent review questions remain root-owned.

  Reader repair `baabc30c` captures source identities once, checks copied byte
  lengths and prevents failed admission from exposing a prior checkpoint.
  `publication-buffer-{build-04,compile-02,test-02,eslint-02}` all exit 0; the
  focused run exercises 48 cases, including actual resizable buffers, changing
  getters and a stateful cross-kind collision control. The retained
  `publication-buffer-review-check-join.json` joins four source files and 58
  emitted modules to the executed checks. This completes those bounded repair
  controls, not native source acquisition or the renderer callback.

  Calendar repair `2f870ef7` refuses revoked arrays through typed request/reply
  errors. Pinned CPython supplies short-fraction and after-transition DST
  expectations. Strict compilation, 26 TypeScript cases, the normal build, 35
  direct Jest cases and scoped lint exit 0. `renderer-calendar/mutation-03`
  exits 0 in 285.200s, detecting 1172 of 1354 valid mutants (86.56%) against the
  unchanged 80% floor. The new controls kill the fraction-padding and DST
  inverse mutants; 165 survivors and seventeen uncovered mutants remain
  explicitly counted. Source and emitted-consumer pins are retained. Calendar
  integration and original-process observation consumption remain open.

- E292: The hosted Bats repair sends audit tool-use fields through stdin using
  NUL-separated shell values, avoiding Linux's per-argument exec ceiling while
  preserving complete JSON objects. Shared pack v108 and its fingerprint carry
  that executable change. The audit control refuses oversized jq arguments on
  every host and compares complete expected/observed input and response JSON.
  The direct dispatcher fixture uses a shell-local payload instead of an
  oversized environment argument; installed dispatch controls retain actual file
  transport. The system-shell control keeps macOS's Bash 3 requirement while
  exercising Linux's actual `/bin/bash`. The hostile TMPDIR control explicitly
  creates GNU-style dispatcher stderr files and distinguishes those from
  payloads inside the private stage; it retains the payload absence and
  empty-directory refusal assertions.

  `publication-integration/hosted-bats-repair-build-01` exits 0 in 6.616s.
  `hosted-bats-repair-cases-01` exits 0 in 23.864s across 47 Bats cases, with
  stable source pins and no remaining group. Its retained
  `tmp/bats-run-9QcwKk/test/5/{expected,observed}-payload.jsonl` files are each
  140089 bytes with SHA256
  `8f069edc265ec6f5b5a3e3b9d2a4384f54ec1378f272778d883cb04c3c71fb66`. Test42's
  reader listing contains both a private stage and a dispatcher file, while its
  payload-file inventory is empty. The fourteen fingerprint/version checks exit
  0 in `hosted-bats-repair-fingerprint-02`; attempt01 retains a
  command-selection failure for a nonexistent second test path. These local
  observations do not replace fresh hosted Linux qualification or machine
  adoption. Root owns committed review and the next coherent source landing.

- E293: Source review repairs retain the audit record's field order and make the
  inherited-file and hostile-TMPDIR controls discriminating. The inherited JSON
  file differs from the inline value and exceeds Linux's per-entry exec limit;
  the handler must deliver its exact bytes. The TMPDIR control inventories every
  regular file and exempts only the exact dispatcher stderr path recorded by the
  observed zero-argument mktemp call, rather than excluding files by name.
  Shared pack v108 fingerprint is
  `ad0c921961b509f93a09109b478eae4c5b1a523b393a1489006bce17a9d558c9`.

  `publication-integration/hosted-bats-review-cases-01` retains a 120-second
  timeout after three cases; it is not a passing run. Attempt02 exits 0 in
  24.581s with all 47 cases, unchanged source pins and no remaining group. Its
  test42 expected, observed and remaining file inventories contain exactly the
  same dispatcher capture; its expected and delivered payloads match.
  `hosted-bats-review-fingerprint-01` exits 0 in 1.160s with fourteen checks. A
  follow-up preserves the inherited reader output before the inline subcase:
  `hosted-bats-review-retained-file-01` exits 0 in 1.555s, and its retained
  `tmp/bats-run-EUAzMG/test/1/foreign-payload.json` and
  `stage-out/inherited-reader.bytes` each contain 172882 bytes with SHA256
  `f69f95ad41653b0770ba725d1fb63bebe6e9ca928e14cd1edfadae40dffb0dd2`. These
  complete the bounded review controls. Exported oversized scalar fields such as
  HOOK_COMMAND, fresh hosted Linux qualification and installed hook adoption
  remain root-owned obligations; large object content does not prove those
  launch boundaries.

- E294: Native custody review control04 exits 0 in 24.742s with fourteen cases,
  stable source/tool pins and no remaining process group. Its retained
  `native-render-custody-review-context-04/fixtures/custodied-retained-test-pipe.json`
  captures live Git82198 under custodian82128 before acknowledgment, then the
  same PID/parent/group as a zombie while a test-owned stdout descriptor is
  held. The initial receipt is absent and cleanup unsettled. After descriptor
  release, the final receipt joins PID82198 to exit7, deadline status, both
  EOFs, reap and group settlement; both processes are absent. The separate
  `local-admission-before-deadline.json` retains exactly eight admitted bytes
  (`admitted`) before the original deadline. Earlier control02/03 failures
  remain evidence of inadequate observation/oracles, not successful
  qualification. This establishes those component controls, not
  escaped-descendant termination or ordinary publication. The root retains
  committed integration and acceptance.

  Publication admission follows the architecture's existing authority split:
  Rust captures and revalidates policy/candidate observations; the trusted,
  pinned TypeScript engine performs policy selection. A second Rust policy
  interpreter would violate that split. Adapter absence must include higher
  priority candidate observations; numeric policy requires qualified provenance,
  not an inferred 4300-digit default. The selected profile must also reach HTML
  decimal-entity decoding. Root owns this integration, with bounded HTML profile
  propagation assigned to the source worker. Native source capture, ordinary
  consumption, concurrent residency and local cutover remain unaccepted.

- E295: Native custody repair `60810d47` commits the E294 classification and
  process-observation controls. HTML profile propagation commits as `0006f5df`;
  preparation observation-order and numeric-getter ownership repairs commit as
  `59d24e6a`. The pre-commit `html-profile-test-02` execution exits 0 with 132
  cases, including missing/empty history with poisoned noise declarations,
  one-read numeric getter ownership and simultaneous calendar/noise failures.
  `html-profile-semantic-02/results.json` retains twenty-four actual registry
  records: eighteen exact `A` shell-field outputs and six decimal-limit refusals
  with limit640/digits641. Unlimited decimal4301 and hexadecimal10002 controls
  distinguish the selected profile from the qualified4300 default. Build03,
  compile02 and explicit seven-file lint02 exit 0. Normal commit-hook formatting
  changes six source/test hashes; these pre-commit receipts alone do not qualify
  the committed bytes. Committed replay build04/compile03/
  test03/lint03/semantic03 exits 0 at `59d24e6a`, with identical source pins
  across all five commands, seven source/test blobs matching that commit and
  fifty-eight stable emitted files. The132 cases and twenty-four semantic
  records repeat on those bytes; `html-profile-semantic-03/results.json` has
  SHA256 `4d7bec111c17b6509500293fac14fcee23585f42e3f24666c217123c87d57f44`.
  Root independently joins the seven committed blobs and retains integration and
  native admission obligations. These bounded propagation/preparation controls
  are complete; ordinary publication and local cutover are not.

  Adapter revision names the HTML reference separately from the selected numeric
  policy. Registry checkpoints compare the full frozen normalization context,
  including numeric profile id/limit, and private owner identity; renderer
  prefix reuse additionally requires the same registry object and complete
  interpretation context. An adapter revision alone is not a reusable
  interpretation identity. Factory registries freeze their context and capture
  it in normalization closures. Arbitrary replacement registry callbacks or
  accessor wrappers are not authenticated by the preparation interface; native
  integration must construct the trusted factory registry from admitted profile
  observations rather than accept caller-supplied behavior. Existing context
  spreading and string-field assumptions precede this candidate; native source
  admission and ordinary construction remain root-owned, unaccepted work.

- E296: Normal main publication attempt `main-push-10` completes all five
  unchanged pre-push stages, including350 suites/6835 passed/14 skipped, but Git
  terminates with signal13 after the remote closes the SSH connection. The
  supervisor retains exit-13,392.637s, stable source pins, no cleanup signals
  and no remaining process group. `git ls-remote` observes main at `5a95747f`,
  so the gate success does not establish publication. Attempt09's license-marker
  refusal and supported exact-byte recovery remain retained. Root owns a
  normal-hook retry with SSH keepalives and fresh hosted evidence.

- E297: `NATIVE-SELECTION-READ-IO-001` is bound to root-owned
  `caws/native-selection-observations` from publication candidate `59d24e6a`.
  The worker's CLI identity and inherited hook identity disagreed; supported
  untracking released its clean original lane before root created the
  replacement binding. The untracked original checkout retains no unique
  authored changes. The slice preserves the existing TypeScript policy
  interpreter while replacing ambient reads with live or immutable observed
  reads. Root owns the ten declared source/test paths and integrates worker
  proposals, ledger, native receipt, qualified profiles and ordinary consumer
  integration. Missing-observation discovery must survive the retained-manifest
  catch-all, and successful runtime verification may be memoized only against a
  complete immutable runtime sub-snapshot. Positive bytes alone do not cover
  higher-priority absence, directory inventory or ancestry changes. This
  assignment grants no native admission or activation; its A1-A8 require
  executed parity/refusal evidence.

- E298: `main-push-11` publishes canonical `c62f5491` with the unchanged
  pre-push hook and per-command SSH keepalives. The command exits 0 in 377.972
  seconds; all five pre-push stages pass, including 350 suites, 6835 passing
  checks and 14 skips. Before/after source pins agree and no process-group
  residue remains. `git ls-remote origin refs/heads/main` returns the same full
  revision. Hosted Release Qualification run `40018975364` completes
  successfully on that SHA: candidate tests/contracts, six macOS/Linux
  Node18/20/22 packaged-upgrade jobs, and macOS native Git custody. The raw
  status is retained at
  `~/.codex/artifacts/01a164bc-7a2b-75e2-be81-5da9d0a29252/hosted-main-c62f5491/status.json`.
  The separate publication and selection branch commits are not qualified by
  this hosted result; combined-image and installed-consumer proofs remain open.

- E299: `publication-integration/command-environment-probe-01` confirms that
  file payload transport leaves an unbounded command in the child environment. A
  2000000-byte command parses in file mode with empty inline JSON, but the
  subsequent `/usr/bin/true` exits126 with `Argument list too long`. Removing
  only its export attribute in the isolated diagnostic permits exit0 while
  preserving all command bytes, SHA256
  `f95661673d1732b528bf6cc6575f3d25d37518d3ef15368ffd7239c0b9273ac4`. The
  equally large response/short-command control launches successfully. Shared
  parser238, Codex parser264 and native handler-executor208 retain the offending
  export/construction on `c62f5491`. This is isolated launch evidence, not an
  ordinary native guard/audit result. Root accepts the complete repair: exact
  local materialization, inherited preloads, protective lost-carrier refusal,
  streamed command-derived serialization and late-tail guard/audit controls. The
  external13-file proposal has syntax checks only. Both parser paths overlap the
  foreign `f1f2-ingress-custody` lane; the attempted owner message was
  explicitly not sent because its heartbeat was stale. No ownership transfer or
  write authority is inferred; root retains coordination and repair.

- E300: Selection candidate `3c92f891` preserves the existing policy owner and
  introduces live/captured reads with immutable observation records. The first
  run retains22 failures caused by cross-realm filesystem errors escaping an
  `instanceof Error` check; `util.types.isNativeError` restores error capture.
  Two additional executed falsifiers expose writable snapshot IO/identity and
  unrelated-verifier memo poisoning: the latter accepts a modified stock file.
  JavaScript-private state, a frozen public snapshot and verifier-identity cache
  ownership repair those mechanisms. `selection-committed-test-01` executes56
  checks against clean `3c92f891`, exit0, with source and emitted-file pins and
  no residue. Normal build, strict compilation and explicit ten-file lint pass.
  The commit-hook ignored-file warnings do not supply that lint evidence.
  `selection-scenario-02` retains65 before/66 after observations, seventeen
  recorded absence errors, the changed user-adapter selection, original sealed
  replay and exact `Machine runtime file modified: first.sh` refusal. Its first
  attempt lacked fixture executable mode and correctly refused EACCES; retain
  that failed attempt. The broader four-suite consumer batch reached its120s
  aggregate deadline and was killed without residue. The native-image partition
  executes three installer mode/refusal controls, exit0, retaining fixtures;
  its77 filtered cases are not passing evidence. Independent committed review
  exposes another cache defect: a verifier can swallow a missing-read signal and
  return a partial result. The executed `selection-swallowed-falsifier-01` fails
  for that reason. Commit `a0d30c27` tracks requested dependencies before
  discovery and refuses incomplete verification. `selection-committed-test-02`
  executes59 checks against that clean commit, exit0 in2.863s. Explicit scoped
  lint exits0; `selection-scenario-03` exits0 in0.162s and retains the same
  65/66-observation, adapter-selection, sealed-replay and fresh-refusal behavior
  with source/emitted-file pins. This computation grants no atomic snapshot,
  native admission or publication authority. `selection-consumer-partition-02`
  executes all338 registration, session-origin and machine-recovery checks,
  exit0 in17.229s, with unchanged source/emitted pins and no process residue.
  Final five policy gates pass against all ten changed paths. The full80-case
  native-image suite and component acceptance recording remain open. No
  installed activation follows. Whole-file base64 observations would encode the
  qualification Node binary as150652248 bytes before JSON overhead; native
  capture must retain binary custody and supply authenticated bounded digests
  without moving manifest interpretation out of TypeScript.

- E301: Source inspection of publication candidate `59d24e6a` finds the ordinary
  SQL Stop join disconnected: `engine-entry.ts:65-120` constructs no transcript
  store port; `engine.ts:136-137` retains OpenCode/Zcode Stop compatibility;
  `main.rs:185` calls `StoreAcquire::capture`, which sets `publication:false`.
  `capture_publication` and `publishNativeTranscriptStore` have no production
  callers. Enabling publication requires effective adapter/profile admission at
  the native owner, not only changing that boolean. The next proof is one
  packaged ordinary Stop invocation joining original identity, admitted profile,
  exhausted SQL and confirmed CLOSED, committed projection/render generation,
  expected ordinary-reader content and durable consumed acknowledgement. A
  higher-priority adapter or queued policy change must refuse or reselect before
  publication. The separate SessionEnd qualifier cannot establish this route.

- E302: Selection component `a0d30c27` completes its bounded acceptance through
  `caws specs evidence`, with A1-A8 and matching events read back. Governed
  merge `10613615` integrates it into the publication lane and closes
  `NATIVE-SELECTION-READ-IO-001`; it does not land the combined candidate on
  main. `selection-native-image-v2-01` executes30 checks, exit0/66.196s, and
  `selection-native-image-legacy-01` executes50 checks, exit0/70.232s. Their
  complementary filters cover all80 cases against unchanged source/emitted pins.
  These are component tests with synthetic executables and mocked receipt
  loading: `native-runtime-entry.test.js:53-78` writes shell executables that
  exit0. They do not qualify actual installed native-image execution. The
  preceding full-suite120s timeout remains a failed execution, not a passing
  batch. `selection-scenario-03/result.json` retains65/66 observations, changed
  stock-to-user adapter paths/hashes, original-snapshot replay and fresh
  runtime-mutation refusal. This completes the selection read abstraction only;
  ordered observations confer no atomic capture, execution-time freshness,
  native admission or production publication authority.

- E303: The governed native build at publication source `4db63982` produces
  `publication-integration/warm-render-native-build-03/native-completed.json`,
  status `completed`, adoption `NOT_ADOPTED`. The loader verifies the request
  and returns nativeSHA
  `716d8b1473e0ed7f53357da856138c35a015f662eae0999705c2a004d4c4be46`,
  observerSHA `105dcd51ded223ad8bde6e68dca1a9fca9ecf3542c05217194de11ee452d6933`
  and stable-entrySHA
  `f3adbdbcd3122c129e463d02802c8233cf5b196745c22b5232b9de8c1a78206b`.
  Qualifier-only commits preserve that native source. Actual uncertain-progress
  attempts01/02 exit1 before mutation because A is already consumed. Attempt03,
  at `b98e507d`, applies the correlated same-byte/different-inode mutation and
  retains A, but exits1 because its assertion reads forwarded stderr before
  ancestor pipe settlement. Its retained stderr contains the exact native
  generation-change refusal. Commit `e27421ab` waits for original ancestor and
  pipe settlement, then compares stderr with the native terminal digest. No
  native delay, fabricated result or repeated hostile action is introduced.

- E304: `run-capacity-qualification.py --scenario uncertain-project-progress` at
  clean `e27421ab`, exact E303 native image and pinned Node22.22.2 exits0 in
  8.760s. Artifacts remain under
  `publication-integration/uncertain-progress-actual-04/`: `execution.json`,
  `fixture/result.json`, original invocation journals, `hostile-action.json`,
  operation records, metadata/marker bytes, owner observations, writer probes,
  retained-file identity witnesses and per-request custody/cleanup receipts. The
  one owner has `maxRetainedRecords:2`. A's inode changes776637831→776637937
  while SHA remains
  `769204465ad96be1f4148c204362570a797562593f8b66f3783c336b7c755932`; native
  exits2 with `published generation bytes or inventory changed`, its durable
  operation remains `returned`, and its writer remains unavailable. A2 exits2
  with `unknown_fence`, reaches `session_rejected_before_effects`, creates no
  durable operation and never reserves an original. B exits0 in a distinct
  project under the same owner, reaches durable `consumed`, then
  `session_heavy_released`, and permits its writer probe. A's retained
  operation, metadata, publication marker, policy and settings identities remain
  unchanged after A2, B and writer probes. All three original requests have
  `confirmed_settled` custody and `confirmed_inactive` cleanup with complete
  witnessed coverage; the supervisor observes no remaining original processes.
  This completes the bounded uncertain-project progress probe. It does not
  establish arbitrary descendant cleanup, direct permit-count telemetry, general
  fairness, mandatory-guard capacity, the thirteen-session/four-repository
  workload, ordinary SQL Stop publication or installed adoption. Parent A3/A8
  remain open. E305 records the qualifier review discharge; combined landing
  remains a root-owned obligation.

- E305: Qualifier candidate `d3e994f7` reports receipt-write failures through
  IPC, independently checks the changed inode and unchanged bytes, and requires
  native exit2 for the uncertain publication. Independent feedback on the
  committed predecessor exposed the receipt-write gap; source inspection and the
  following executions discharge that bounded finding. The E304 command, using
  the unchanged E303 native image, exits0 in9.297s under
  `publication-integration/uncertain-progress-actual-05/`. `execution.json`
  retains exact argv; `fixture/result.json` identifies A=41449, A2=43900 and
  B=44031, native exits2/2/0, and custody/cleanup receipts. Direct inspection of
  their durable operations gives `returned`/absent/`consumed`. The retained
  `hostile-action.json` records inode776650809→776650918 with identical E304
  SHA; native stderr reports `published generation bytes or inventory changed`.
  All three retained-A identity snapshots equal the before snapshot, including
  the snapshot after B and writer probes. This supports the bounded E304 claim,
  with the same nonclaims; it is not ordinary SQL Stop or installed-harness
  proof. `hostile-watcher-controls-run-03` exits0 in1.301s: six synthetic
  controls exercise one-shot mutation, consumed and mismatched-input refusal,
  preexisting receipt failure delivery, early native exit and parent disconnect.
  Its `fixtures/result.json` retains original-child exit, output EOF, pipe
  closure, IPC disconnection and process absence. Failed runs01/02 remain
  retained: their driver incorrectly required Node's `close` event after a
  parent-initiated IPC disconnect. `node-disconnect-settlement-01` compares
  parent/child disconnect on pinned Node22.22.2 and retains its embedded child
  process source; parent disconnect produces exit/EOF/disconnection without
  `close`. Only that synthetic control uses the explicit settlement
  observations; production qualifier custody is unchanged. Synthetic executables
  and fabricated journal rows establish watcher behavior only, not native
  publication or fairness.

- E306: SQL numeric-profile parity remains an activation dependency. In
  publication candidate `d3e994f7`, `store-json.ts:6,346-347` declares and
  enforces a 4300-digit integer limit; `store-projection.ts:231-234` always
  supplies that profile. Stock `shared/session-log.sh:91-95` invokes ambient
  `python3` for SQL projection, independently of its renderer invocation or
  optional writer interpreter. `shared/lib/transcript-store.py:56-57` parses
  entire message and part JSON, so oversized integers in otherwise ignored
  members can affect the old result. The effective installed hook interpreter
  and startup numeric limit have not been qualified. Renderer profile support
  alone cannot establish SQL equivalence. Root owns capturing each stage's
  executable/source identity, startup arguments and effective limit, then
  carrying the qualified SQL profile through admission and projection. Boundary,
  signed-integer, ignored-member, string and float controls must retain
  projection bytes or failure stage and actual renderer artifacts;
  changed-profile controls must reject or select a qualified alternative. No
  global relaxation or ambient-interpreter assumption discharges this
  requirement.

- E307: SQL profile implementation `09a7ae8d` carries explicit finite
  `cpython-3.11.13-unicode14-int4300` and `cpython-3.11.13-unicode14-int0`
  selectors through parsing, projection, serialization and publication. Actual
  stock `transcript-store.py` executions under the same CPython3.11.13 binary
  with `-B -S -X int_max_str_digits=4300` and `=0` distinguish ignored message
  and part integers, signed integers, strings and floats. The4300 profile
  refuses4301-digit integers with exit1 and no projection; int0 produces the
  visible `qualified-visible` event with exit0. Projection bytes have SHA
  `0b3ab538fae18f30cd84072d408ccbe457181d39f9476c0f413bae55a35fc102`.
  `sql-profile-qualification-01` retains23 stock cases and three interpreter
  probes; `sql-profile-zcode-baseline-01` adds12 actual Zcode cases. Under the
  root external `publication-integration/` artifact directory, each case
  preserves SQLite inputs, argv, stdout/stderr, exit and projection/error state.
  Pinned Node22.22.2 `replay-candidate.cjs` exits0 in0.486s under
  `sql-profile-semantic-01`:28/28 same-surface/profile comparisons match,
  comprising22 byte-equal projections and six integer-limit refusals. Copied
  emitted-module controls that always choose4300 or always choose unlimited each
  produce six mismatches. `semantic-summary.json`, per-case
  `projection.jsonl`/`error.json`, source/dist pins and `execution.json` retain
  the distinction. The five focused Jest suites exit0 with204 checks under
  `sql-profile-tests-01`; build and explicit package-cwd lint exit0 under
  `sql-profile-build-01` and `sql-profile-lint-01`. These establish finite SQL
  reconstruction parity, not the effective installed interpreter profile, native
  acquisition/calendar, ordinary Stop rendering or full mutation quality.
  Explicit selector support alone does not establish production qualification.

- E308: Native foundation `9272df9a` retains a private request-owned generation
  receipt and bounded verification using the original expiry and cancellation
  callback. Reads retain one64KiB chunk and stop at the observed original size;
  pre/open/post descriptor and path metadata detect replacement, growth and
  truncation. Manifest-derived directory traversal refuses undeclared trees
  before descent. `native-generation-check-01` exits0 with17 selected tests;
  `generation-installed-entry-01` exits0 with10 installed-entry controls.
  Retained `chunk-cancellation.json` and `chunk-deadline.json` observe65536 of
  131089 bytes; `during-read-refusal.json` records growth/same-byte replacement
  refusal after at most131089 bytes and truncation after65536. The
  `retained-expiry.json` control refuses lookup/revalidation despite a later
  caller expiry. Root rehashes110 native inputs and1049 TypeScript/build inputs
  against their execution receipts with no differences. The module split
  `3612a2cd` places reusable verification in `installed_generation.rs` and keeps
  pointer/argv/launch policy in `installed_entry.rs`.
  `native-generation-split-01` and `generation-split-installed-entry-01` repeat
  the17/10 selected controls with exit0 in3.883s/4.238s, unchanged source/tool
  pins and empty observed groups. Fixture images and cooperative on-disk
  identity checks do not seal running code, prove launcher provenance, prevent
  mutation after the final observation or interrupt stalled kernel syscalls. The
  receipt has no ordinary production caller; strict Clippy and complete
  installed-image qualification remain open.

- E309: Source inspection of `9272df9a` identifies the next activation boundary.
  `main.rs:187` uses non-publication `StoreAcquire::capture`; the typed engine
  entry injects no ordinary SQL port. `render_owner/store.rs:1006-1013` reserves
  the journal and retains a writer before SQL, so selection revalidation after
  queueing must precede reservation, not merely precede SQLite open. The
  receiver's `received + remaining_budget_ms` at1234-1236 renews transit time;
  the publication carrier must preserve the original native monotonic deadline.
  Native constructs the carrier from retained observations, never from an
  engine-supplied claim. The receiver independently validates generation,
  positive/negative readset, roots, profiles and deadline before effects. Peer
  admission authenticates UID, not executable identity; the cooperative runtime
  TCB remains explicit. Root owns this join and the actual ordinary Stop proof.
  Its decisive negative control creates a higher-priority adapter while queued
  and must observe zero reservation/writer/SQLite-open/publication/compatibility
  effects. Instrument the actual SQLite-open seam; unchanged database bytes
  cannot prove no open. The valid control must retain rows, exhausted/CLOSED,
  projection, real consumer result and resource release under one invocation.

- E310: Publication boundary `b34f2992` requires an explicit supported SQL
  profile and validates it before observing the port or consumer. Lower-level
  reconstruction defaults remain separate from publication admission.
  `sql-profile-required-build-01`, `sql-profile-required-tests-01` and
  `sql-profile-required-lint-01` exit0; the five focused suites execute207
  checks. The emitted-adapter observer `observe-sql-profile-refusal.cjs` exits0
  in0.156s under `sql-profile-refusal-observation-01`. Its four case JSON files
  retain actual absent/undefined/null/unsupported selectors, exact
  `StoreJsonError` category `request`, code `unsupported_profile`, and message
  `request:unsupported_profile at request 0`. Port/consumer getter counts and
  renderer callback counts are all0. `fixtures/result.json` and `execution.json`
  retain module/driver/source/dist identities, process exit0 and an empty
  observed process group. This establishes early adapter refusal, not native SQL
  no-effects: the observer deliberately supplies no native port. Earned profile
  qualification, binding to native admission and the ordinary consumer join
  remain root-owned under E309. Commit formatting collapses an import; it does
  not change the exercised statements or emitted implementation.

- E311: Independent Rust inspection of `3612a2cd` identifies a metadata
  hash/parse gap: shared verification hashes native entry and mode files, then
  parses later reads without binding those buffers to the manifest. Root applies
  only the hostile tests first. `metadata-parse-baseline-01` exits101 with18
  passing and two failing controls. Its retained `native-entry.json.json`
  observes different first/second-read digests, `admitted:true`, selected
  timeout1001 instead of1000, and `restoredRevalidationOk:true` after original
  bytes are restored. `native-modes.json.json` likewise admits engine mode0755
  instead of0644 and passes restored revalidation. The controls mutate a
  different member through the existing test-only chunk observer; no timing loop
  or timestamp spoof supplies the result. Repair `65b1b065` hashes the exact
  bounded buffers passed to both parsers. `metadata-parse-repaired-01` exits0
  with20 selected controls in1.757s; both hostile artifacts report
  `admitted:false` and the member-specific `Runtime member integrity failure`.
  The unchanged-metadata control retains successful admission/revalidation.
  `metadata-parse-installed-entry-01` exits0 with10 controls in3.242s. Its
  runner enables the suite's actual artifact variable; retained per-invocation
  `result.json`, `stdout.bin` and `stderr.bin` include native exit37 with
  `NATIVE_DISPATCHED` and no legacy retry, pointer advancement yielding
  `SELECTED_A`, and engine corruption yielding exit2 with its specific integrity
  refusal. Earlier installed-entry runs retained process logs but did not enable
  these per-invocation files. All three runs retain unchanged source/tool pins
  and empty observed groups. These are shared-verifier and fixture-entry
  observations, not installed production admission. Metadata immutability,
  largest-image verification cost, real current-executable path matching and
  ordinary receipt enforcement remain explicit qualification obligations. Root
  carries the same separate-read concern through the actual TypeScript
  `verifyRuntime`/`verifyNativeLayout` consumer in E312.

- E312: TypeScript repair `78b5475c`, integrated into source candidate
  `95a15927`, binds the exact parsed metadata buffers to the manifest and
  rejects undeclared directory trees before descent. The tests-only
  `ts-metadata-baseline-01` exits1: both changed captures receive active
  selections, and restoring the original bytes makes later verification pass.
  `ts-directory-baseline-01` exits1 with an admitted three-level undeclared
  tree. `ts-metadata-committed-selection-01` executes the emitted candidate at
  `78b5475c`, exits0 in1.560s and retains26 controls. Its `fixtures/`
  observation JSON records member-specific modification refusals, unchanged
  live/snapshot admission, and `admitted:false, descended:[]` for the undeclared
  tree. `ts-metadata-final-build-01` and `ts-metadata-final-lint-01` exit0.
  Direct comparison against the committed candidate finds no mismatches among422
  build source pins,1049 committed-selection source/dist pins or111 retained
  native repair source pins. These establish candidate identity and bounded
  behavior, not ordinary native admission. The combined three-suite attempt
  times out after120s with empty output; a60s image-only attempt and30s
  diagnostic attempt also time out. Their groups are killed and observed empty.
  The diagnostic's `test-events.jsonl` shows completed rollback cases taking
  several seconds. At the committed candidate,
  `ts-metadata-registration-suite-01` exits0 with262 controls in7.440s. Three
  disjoint image partitions (`ts-metadata-image-rollback-01`,
  `ts-metadata-image-install-01`, `ts-metadata-image-remainder-01`) exit0 in
  64.883s,1.683s and61.238s. Their event records account for all80 distinct
  cases with no duplicated case names; the retained partition observation
  records those exact selections. Fixture images retain pointers, manifests,
  modes and per-case observations, including rollback to the legacy digest while
  retaining a corrupt unused native generation. Their native executable is a
  shell fixture; no real installed engine execution is inferred. Independent
  feedback on the committed repair raises candidate/check identity and the
  timeout; source-pin comparison, committed selector/registration runs and the
  complete image partitions ground those questions. The peer's source inspection
  is limited and supplies no acceptance verdict. No parent criterion changes.

- E313: Reinspection of the combined source identifies absent production joins,
  rather than merely missing tests: `engine-entry.ts:113` supplies no store
  port; `engine.ts:245` uses live selection and its compatibility branch handles
  ordinary SQL Stop; `publishNativeTranscriptStore` has no production caller.
  `GenerationReceipt` has test callers only, and `capture_publication` accepts
  no receipt. The actor's journal reservation and writer acquisition precede
  SQL. Its receiver reconstructs expiry from receipt time plus remaining
  milliseconds. Root owns the next coherent production slice: one ordinary
  finite Stop through observed selection/profile qualification, native admission
  and the original deadline, queue revalidation before effects, SQL exhaustion
  and CLOSED, publication, actual consumer readback and release. Root retains
  exact-image qualification and the dependent residency workload. Component
  landings remain incremental; none authorizes machine adoption or legacy
  retirement before that combined result.

- E314: Combined source `c61ad087` executes a fresh matched native build and CLI
  package build/pack in
  `publication-integration/combined-native-coordinator-01`,
  `combined-package-build-01` and `combined-package-01`. The native binary
  SHA256 is `8619a3670ed611dd95c51b3d286031d7ca4f0510b9ff4fbfc86b51a996dd4793`;
  the package tar SHA256 is
  `c0bbdf4b1023163e68d201059f681350f377b84902ddcf2bf7505a78c95fdc2c`. Exact
  descriptor preparation compares the package, installed prefix and staged
  consumer documents; earlier prefix-identity and staging failures remain
  retained. `combined-installed-image-01` contains the actual private install,
  configure, project initialization, direct native invocation, corruption and
  rollback cases. The native generation is
  `c788f1722ce38d728da408888c3af1722e4f199234b760ade3345002c17ace93`.
  `native-bash-read-01` exits0 and `native-bash-force-push-01` exits2 with the
  specific command-safety block; their journals record native cache capture and
  envelope publication, without compatibility-dispatch completion. These cases
  use a clean child environment and exact generation executable aliases. Read
  payload and ambient-environment attempts retain their compatibility evidence;
  unsupported stock handlers continue using child execution. The inert
  force-push payload does not execute a Git push. Journal delivery remains
  `not_observed`: direct launcher execution does not prove editor enforcement.
  `native-corrupt-01` exits2 with
  `Runtime member integrity failure: native-entry.json`; the private fixture
  restores the original metadata bytes. `rollback-apply` exits0 and restores
  baseline digest
  `0c5bf4bebaf720b6e48972bdec14cf277de51aaa0216094474781677c2795137`;
  `rollback-read-01` invokes the same stable launcher and exits0. This proves
  the private native-to-legacy recovery scenario, not active-owner native
  upgrades. Each case retains command, exit, stdout/stderr and state snapshots;
  invocation verification retains image/input hashes. No machine adoption,
  ordinary SQL Stop, full in-process chain, no-Python execution, residency or
  fairness is inferred. The later deadline candidate `3bc555cb` requires
  separate integrated-image proof.

- E315: Store acquisition carries one original native monotonic expiry through
  `store-acquire.v2`. Capture begins before payload reading; receiver policy can
  shorten the deadline, and checks inside the registry lock and after actor
  queueing precede reservation and publication effects. SessionEnd and renderer
  Offer carriers remain separate relative-budget obligations. This change does
  not admit a selection/profile or connect ordinary SQL Stop publication. The
  external `publication-integration/store-deadline-baseline-01` execution
  exits101 on the original v1 carrier. `store-deadline-repaired-01` retains an
  old-owner fixture failure before socket binding; the fixture creates and
  removes its own rendezvous directory in the repair. The restored store suite
  `store-deadline-restored-03` exits0 with18 executed cases and the existing
  prepared-image case ignored. `monotonic-deadline-unit-01` exits0 with12 clock,
  conversion, overflow and nonrenewal controls; these are component
  observations. `store-deadline-contention-negative-01` removes only the two
  under-lock checks and exits101 with `expired waiter reserved a record`; its
  retained observation has `registryEmpty:false`. The restored registry-original
  and registry-cap observations have `registryEmpty:true`, `actorCount:0` and
  expired effective deadlines. Delayed capture retains the original envelope and
  yields `Original monotonic deadline expired`, null registration and null
  acquisition. Queued raw/publication observations retain absent
  writer/publication custody and matching before/after hashes for all25 fixture
  files. The existing queued record remains truthfully retained; this is not a
  zero-record claim after previously valid admission. Exact commands,
  source/tool pins, outputs and empty owned process groups are in each
  `execution.json`. `store-deadline-native-check-01` and
  `store-deadline-feature-off-check-01` compile-check the native binary with
  sqlite-store enabled and default features disabled, respectively; both exit0.
  These compilation checks do not execute either installed binary. Actual
  installed store dispatch, selection/readset qualification, mixed-generation
  resident adoption and parent A1–A8 remain open. Independent review grounds a
  remaining propagation gap: writer custody and publication helpers receive only
  the local Instant bound after the actor native check. Expiry or clock failure
  inside those helpers is not covered by the queue controls. Root owns
  request-scoped checks at logical mutation/retry boundaries and deterministic
  deep-effect controls before accepting this deadline contract.

- E316: Coherent source candidate `c41ee44b` lands through governed merge
  `70ecc61d`; its executable source remains `c61ad087`. Source A2 and A3 records
  are read back with events12576 and12582; all three bounded source criteria are
  pass and the source spec closes completed. Main ancestry, worktree removal and
  unchanged actual machine runtime pointer are independently inspected. This
  source landing does not accept parent A1–A8 or adopt the private native image.
  The OpenCode ingress investigation grounds SDK1.17.11 created identity at
  `properties.info.id`, and idle/compacted identity at `properties.sessionID`.
  Module-global plugin state permits cross-project routing/context
  contamination; missing lifecycle identity can reuse an earlier session. Root
  accepts the clean child identity slice into publication A7 when native tool
  context cannot enter its worker-owned lane; the child closes superseded,
  without completed acceptance.
  `publication-integration/opencode-identity-baseline-01` executes the new
  controls against old source and exits1 with7 failures, including prior-session
  dispatch, missing created identity and leaked context.
  `opencode-identity-repaired-01` exits0 with18 cases after event-specific
  identity and instance-state repair. Retained
  `opencode-identity-repaired-fixtures` include the transpiled plugin, actual
  recording-dispatcher payload JSON, NUL-delimited argv/cwd/project/surface
  records and call lists. Interleaved idle events dispatch session-a/session-b
  exactly once each; missing identity dispatches neither; separate plugin
  instances retain their own roots and context. Pack version9 and its computed
  fingerprint identify the changed template. `opencode-identity-build-01` exits0
  with unchanged source pins and no owned process residue. These are
  callback/transport fixtures, not actual OpenCode activation, Stop-veto
  delivery or native SQL publication.

- E317: OpenCode callback parity closes two source-grounded holes left by E316.
  Supplied project context cannot fall through to another host project's cwd; a
  context-free instance retains the existing cwd fallback. Tool-after uses its
  own SDK input sessionID and argument object, preserving normalization and
  rejecting missing identity or ambiguous carriers. Unambiguous legacy
  output.args remains supported without borrowing cached identity. The
  `opencode-corrective-baseline-01` tests-only execution exits1 with5 failures:
  interleaved SDK after records session-b and empty arguments for session-a,
  missing identity borrows a prior session, and a decoy output argument wins.
  `opencode-corrective-repaired-01` exits0 with28 cases, but its first root
  controls were insufficient: their outside fixtures had HOME/.caws ancestry.
  The corrected fixtures use /private/tmp and retain every ancestor's marker
  absence in root-selection-evidence.json. `opencode-root-negative-01` restores
  unconditional cwd fallback only in the transpiled fixture and exits1 with all3
  selected controls failing; host Stop records contain both host-session and
  outside-session. `opencode-corrective-final-01` exits0 with28 cases: host
  routing records contain only host-session, no outside pre/post calls, and SDK
  after retains session-a, actual arguments and resolved workdir. Raw invocation
  records, input payloads, transpiled plugin and source pins are retained under
  publication-integration/opencode-corrective-final-fixtures; each
  root-selection record maps its retained ungoverned fixture explicitly.
  `opencode-corrective-build-01` and `opencode-corrective-fingerprint-01` exit0.
  Pack9 remains the unreleased candidate, with fingerprint
  e55fcc4a30f2338ee7700dae03cf2aad4a9caa725016092fff997465ccd7ef51. These
  recording-dispatcher observations do not establish actual OpenCode activation,
  native Stop qualification, editor delivery or parent acceptance.

- E318: The original native store deadline reaches writer provisioning, custody
  initialization/acquisition, journal open/recovery and the store publication
  admit/begin-next/returned/consume transitions, plus publication directory
  creation, replacement, removal and synchronization. Request-scoped checked
  APIs retain the original MonotonicDeadline and earlier local bound; legacy
  callers preserve their existing Instant-only contracts. Cleanup and
  uncertainty settlement do not renew invocation authority. The first new
  publication controls fail before effects because metadata was incorrectly
  prepared as Render output. The corrected tests use the existing Seal exchange
  and assert its descriptor/bytes before injecting expiry or clock failure.
  `effect-deadline-publication-repaired-01` retains that failed attempt. Final
  `effect-deadline-{writer,journal,publication,store}-host-clock-01` executions
  exit0 with13/43/12/18 exercised cases; the store suite retains its one
  prepared-image case as ignored. Positive controls use the actual host
  monotonic checker; hostile controls inject the native observation only at
  selected deep stages while the captured local Instant remains live. Actual
  fixture files, scenario/result JSON, journal records and raw
  CAWS_DEADLINE_EFFECT rows are retained alongside source/tool pins and empty
  owned process groups. Pre-rename failure retains old metadata and no terminal
  marker; failure after actual rename retains changed metadata, absent marker
  and uncertainty. Journal pre-rename failures leave prior bytes intact;
  post-publication failures retain changed records,
  publication-may-have-happened and poisoned handles without acknowledging a
  transition in memory. The positive publication retains exact metadata and
  .session-publication.json. Eight one-at-a-time `effect-negative-*-02` controls
  remove custody, journal, capture, rename or transition propagation. Each
  executes its selected test and exits101 for the missing behavior, including an
  expired directory creation, changed metadata before permitted rename, and
  falsely successful journal transitions. Restoration records verify exact
  source bytes after every control. Native-enabled and feature-off compile
  checks are retained separately; compilation does not establish installed
  execution. These are cooperative logical-boundary guarantees, not atomic
  exclusion of expiry between a check and syscall, syscall interruption,
  ordinary Stop admission, full lifecycle deadline parity or machine cutover.
  Root retains the native producer/prefix/profile/consumer join and final-image
  qualification.

- E319: The bounded ingress/deadline correction lands on main through governed
  merge fec80595; closure commit925b5a59 retains all three recorded component
  criteria and removes only the temporary landing lane. Normal integration
  8cefd13b preserves the publication candidate2448b992 executable bytes and
  canonical governance. The retained ingress-deadline-landing-01 source binding
  compares all99 native source pins across six positive/compile receipts and
  all395 pins from the final OpenCode execution: zero mismatches. Package-source
  diff against2448b992 is empty before and after landing. Full-basis gates
  evaluate15 files with5 PASS; doctor0E/4W/5I retains installed-hook drift.
  Acceptance records12627–12629 are read back from both spec and event history.
  Commit citation verification establishes identity; actual payload, filesystem,
  negative-control and restoration observations remain E317/E318. The active
  publication lane merges main and retains root ownership of ordinary Stop
  producer, native prefix, production profile admission and consumer
  integration. Stop-prefix and OpenCode producer proposals have formatting/apply
  checks only; neither is activated or accepted. Residency/fairness, full Python
  retirement, supported harness delivery and actual machine selection remain
  unqualified.

- E320: Native Stop prefix preparation adds a distinct event/schema path while
  preserving the SessionEnd wrapper. The owner retains original project/query
  settlement, process ancestry and monotonic expiry; completion cannot renew the
  deadline or erase partial effects. stop-prefix-wire-baseline-01 executes the
  existing22 wire controls with exit0. stop-prefix-wire-candidate-01 exits0
  with31 controls; retained actual envelopes carry hook_event Stop and exact
  session/root pointers. Cancellation after the envelope leaves that file, no
  pointer and an incomplete result; delayed consumption refuses a previously
  completed result after its original expiry. These wire fixtures explicitly use
  synthetic original-project witnesses and do not establish original Git
  observation. stop-prefix-pid-candidate-01 exits0 with10 controls, including
  six actual native subprocess cases for Codex, OpenCode and the four shipped
  ZCode process names. Actual PID records preserve created_at and observed
  birth, stale entries are removed according to the existing age/liveness rules,
  and the second reap is rate-limited without replacing its marker. Process-name
  correlation is not executable authenticity. Five stop-prefix-negative-\*-01
  mutants each execute one selected control and exit101 for wrong envelope
  event, renewed expiry, wrong original project, one unsettled query or absent
  query PID. Restoration receipts verify exact candidate source bytes and no
  owned process residue. Both positive receipts match all99 native source pins
  after restoration. This implements a bounded library prerequisite; no
  production Stop capability or caller is activated. Root retains QualifiedStop
  admission and the ordinary producer/prefix/profile/SQL/render/consumer join
  before any parity verdict.

- E321: Linked SQLite identity has a typed exact matcher and receipt borrowing
  the original native generation and MonotonicDeadline. Expected identity data
  construction grants no production qualification; no default policy is
  supplied. sqlite-identity-candidate-01 exits0 with three observation/mismatch
  controls; sqlite-identity-receipt-01 exits0 with seven controls including
  actual generation verification over explicitly synthetic fixture members. The
  retained linked identity is SQLite3.53.4, source
  bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc,
  threading1,39 exact sorted options and compiled
  prefix2034ab7b8e7d48457c74ba4482292d82221270965e813e0e2dc8e9c5c58666c9. Actual
  manifests, changed engine bytes, retained/replaced directories and original
  deadline envelopes accompany refusal diagnostics. Corrupted members, replaced
  original directories and original expiry refuse receipt capture or reuse; an
  unrelated fresh deadline cannot renew the receipt. The actual binary
  --sqlite-build-identity invocation in sqlite-identity-diagnostic-01 exits0 and
  emits the same diagnostic identity. Two sqlite-identity-negative-\*-01
  controls bypass exact matching or the post-introspection checkpoint: both
  execute one test and exit101 for falsely successful results, with exact byte
  restoration and empty owned process groups. All99 source pins match the
  receipt execution. This is identity evidence, not admitted SQL/renderer
  semantics or production activation. Ordinary Stop must not execute Python to
  select a profile. Retained qualification proves explicit CPython3.11.13
  int4300/int0 baselines; the old installed hook's effective ambient interpreter
  remains unknown. Root owns the authenticated generation policy and native
  selection/profile join.

- E322: Root owns the unimplemented ordinary Stop join: a binary-private
  qualification owner alongside GenerationReceipt and activation of the
  library-owned original capture bridge described in E325. The native request
  must supply original cwd/environment/raw payload before Node; capture must
  produce project and ancestry observations itself, not accept an asserted
  project or a TS permission flag. Source inspection identifies two later Git
  observations in render_owner/store.rs ingress and transcript_store_wire.rs
  serve. Both qualified branches must consume the same original native
  observation; changing only ingress leaves recomputation. ProjectFailure
  retains an uncertain Git Child; converting it to a string or dropping it at
  frontend exit loses custody. Root owns retained cleanup or the native
  custodian integration before activation. Exact OpenCode host probe
  opencode-installed-identity-01 exits0 with1.18.27 and executable SHA
  f35111b79296714194653fc8e74f28f6732589bacf0fbf59504c592ef6a727b6. Producer
  qualification must use that loader version, preserve nested caller directory
  discovery, and account for remote/managed producers; matching local plugin
  bytes alone cannot establish the effective loaded producer set. The producer
  worker owns configure/migrate/init and observed local registration; root
  retains actual harness and consumer verification. No parent AC changes.

- E323: OpenCode project-native Stop transport has executable configuration,
  migration and fresh-init paths. The selected runtime inventories generated
  plugin bytes; explicit native opt-in writes machine transport settings, while
  migration preserves reviewed policy and refuses unknown plugin growth. Fresh
  init installs compatibility callbacks and publishes the selected producer
  last. Native Stop retains its own nested plugin directory and never replays
  legacy Stop after a native attempt. Other callbacks remain compatibility work.
  Root executed opencode-producer-baseline-build-01 and baseline-regression-01
  (exit0,99 cases), then candidate-build-01 and candidate-tests-01 (exit0,38
  cases). Candidate-regression-01 exits1 with154 passing and one obsolete
  categorical OpenCode-refusal oracle; the revised explicit-opt-in and legacy
  image refusal check passes in registration-final-01 (exit0,16 cases). Three
  behavioral negative controls exit1: collapsed caller cwd, omitted
  selected-producer equality and overwritten custom plugin. Each exact original
  is restored; process-group residue is empty. Artifacts under
  publication-integration/opencode-producer-candidate-fixtures-01 include actual
  argv.bin/input.json/context.bin, generated producer, selected project policy,
  local-readset.json and transaction backups. Root checks rollback fixture
  ZkIJQg plugin against backup before bytes (equal), with no project policy;
  migration gK9DZi and initialization F3SmRJ match backup after bytes and retain
  project policies. The executable image and producer recording entry are
  synthetic test fixtures. These observations do not establish real harness
  loading/delivery, SQL/profile admission, full Python retirement or cutover.
  Root owns original native Stop joining and actual installed qualification; the
  worker's producer assignment is integrated, not parent-complete.

- E324: Independent review of246254d7 identifies init's other-surface policy
  bypass. Root reproduces it in opencode-other-surface-counterexample-01:
  preview and apply both return0 for legacy OpenCode hooks with only a Codex
  machine policy; both intended refusal assertions fail. Init preflight requires
  and validates the existing OpenCode surface policy before either path can
  proceed. opencode-other-surface-build-01 exits0; fixed-01 exits0 with32 cases,
  including unchanged-tree refusals in both modes and successful repeat init
  after reviewed OpenCode migration. Counterexample and corrected fixtures
  retain status/output and plugin/policy bytes. The same-provider review's
  remaining bounded source observations and transaction evidence are grounded;
  no actual harness or parent acceptance is inferred.

- E325: The library-owned OriginalStopCapture observes actual project and native
  ancestry from captured cwd/environment/raw payload, retains the original
  MonotonicDeadline, and binds one prefix-owner attempt to the original process,
  request, generation digest, surface and payload. Structured project failure
  retains its actual Git child and original interruption cause. Root executes
  original-stop-capture-candidate-01: exit0,37 tests; native-check-01 and
  feature-off-check-01 both exit0. All recorded source/tool inputs remain stable
  and owned process groups are empty. Retained actual-original-project.json
  records two real Git children69474/69477, exit0, both pipe EOFs and reap, with
  nested payload cwd winning over a missing environment project and poisoned
  GIT_DIR. actual-prefix.json and repository session files retain the envelope,
  pointer and PID record with the same original clock. Failure/cancellation
  artifacts retain Git exit128 or SIGKILL9 and structured reasons; these runs
  settle cleanup and do not exercise uncertain custody after frontend death. Six
  original-stop-capture-negative-\*-01 mutations each execute an assertion
  failure and exit101, with exact restoration. The clock mutation establishes
  checkpoint sensitivity, not absence of later effects. Tests use a native
  libtest child with controlled OpenCode argv0, not the installed harness. This
  bridge is not called by main before Node and grants no production
  qualification. Source inspection finds UID-only resident authentication and
  two later project observations. Root owns spawning original Git queries inside
  the durable custodian, protected native registration before Node, and reuse of
  that one observation through prefix and both store stages. A serialized
  asserted project over the current public socket cannot satisfy that authority
  contract. No parent AC or retirement status changes.

- E326: The bounded Stop prerequisite landing preserves candidate0bd415c5
  package bytes: OpenCode transport and reviewed migration, original prefix
  capture, and generation-bound SQLite identity. The separate
  CAWS-NATIVE-STOP-PREREQUISITE-LANDING-001 lane permits source delivery without
  destroying the active publication worktree. stop-prerequisite-build-01 exits0;
  tests-01 exits1 because root supplied a nonexistent fingerprint-test path,
  while its other five suites execute99 passing cases. The corrected tests-02
  exits0 with113 cases across six suites. Source pins remain unchanged and
  process-group residue is empty. The landing's package-source diff from the
  candidate is empty; source-evidence.json compares all99 native source pins
  against capture and both compile receipts without mismatches. Earlier SQLite
  and PID receipts retain their exact unchanged implementation dependencies;
  later additions to separate capture/identity code are listed rather than
  represented as the earlier tested revision. Actual fixture outputs and
  negative-control failures remain E320–E325. The source landing records only
  its bounded criteria; parent acceptance, installed adoption and complete
  Python retirement remain unchanged. Root retains the ordinary Stop join.
  Custodian implementation owns actual Git through frontend loss; native-peer
  admission owns kernel PID/birth and exact-generation executable checks before
  private original transfer; profile qualification owns fixed reference and
  candidate comparisons with observed dependency identities. Root integrates
  these assignments before ordinary consumer and residency qualification.

- E327: Native peer admission retains a private CLOEXEC socket, original
  monotonic deadline, kernel PID/birth/executable and the exact admitted
  generation member identity. native-peer-candidate-04 exits0 with five actual
  native-host/Node controls; all101 source pins and tool inputs remain stable,
  and the supervised process group is empty. Retained peer-observation.json
  files show native admission/revalidation, zero admission callbacks for a
  same-UID Node process forging native claims, refusal after peer exit,
  same-byte member replacement refusal, and original cancellation/expiry. The
  executable, member and process negative controls each exit101 at the
  corresponding refusal assertion after incorrectly admitting the mutation;
  exact source restoration is recorded. Earlier candidate01 compile failure and
  candidate02 missing Node setting remain retained. Socket cleanup runs during
  assertion unwinding. These are actual processes in a synthetic generation, not
  installed Stop delivery, native registration, immutable executable attestation
  or a PID-reuse experiment. The module has no active production caller. Root
  owns authenticated original transfer, custodian execution and the ordinary
  Stop publication/reader/release connection before profile, residency or
  machine acceptance. Parent evidence remains unchanged.

- E328: Original project discovery uses the existing native custodian with
  inherited private configuration, exact original payload/deadline binding and
  two bounded Git operations. RemoteFailure retains the custodian Child and
  control; retry only settles cleanup, and Drop never signals the custodian.
  original-project-custodian-runtime-03 exits0 with six scenarios and103 stable
  source pins. Actual native custodians execute explicitly identified fixture
  Git; original-project-success.json retains both query cwds, filtered
  environment, raw output, exit0, both EOFs and reap. The withheld-pipe artifact
  retains pending stdoutEof=false/reaped=false, then terminal Cleanup failure
  with both EOFs/reap after writer release; no second query or capture success
  follows. Drop retains the same custodian birth until that release. Frontend
  TERM/KILL records retain actual frontend/custodian/Git/descendant ancestry and
  groups, followed by absence of all three survivor instances. Cancellation,
  output-limit, malformed output and changed executable controls retain their
  structured refusals and terminal cleanup. This does not prove physical kernel
  stall recovery, atomic executable pinning or trusted wrapper descendants.
  Initial compile101 exposed a Reply/ResultFrame writer mismatch; runtime01
  exposed quadratic receive scanning exhausting the bounded writer. The repair
  preserves separate frame limits and scans only new bytes without extending the
  writer deadline. Pending-to-success and too-small reply-bound mutants each
  exit101 at behavioral assertions, with restoration retained. Six private wire
  tests,15 existing project tests,10 existing context-Git tests and the
  sqlite-store compile check pass; the first context regression's missing Node
  setting remains recorded. The large-reply unit03 attempt also records a test
  receiver timeout started before serialization; the receiver instead ends at
  explicit writer shutdown under the outer supervisor, retaining the production
  writer's unchanged bounded progress contract. The old cleanup placeholder is
  omitted from wire diagnostic prose because correlated receipt rows own actual
  cleanup facts. Root owns joining this capture to prefix and authenticated
  registration before Node, then the ordinary publication/reader/release path.
  No production Stop activation, parent acceptance, Python retirement or machine
  adoption is earned.

- E329: OriginalStopCapture requires the caller-selected native executor and
  retains the custodian's opaque CapturedProject rather than repeating direct
  project queries. Its typed Project failure owns RemoteFailure, forwards
  cleanup retry/state and preserves the original interruption. Six real-capture
  tests move from libtest to the original_stop_capture integration target so the
  custodian executes CARGO_BIN_EXE_caws-native. Two additional controls cover
  wrong native pins and pending error ownership across retry/Drop.
  original-stop-custodian-integration-01 exits0 with eight cases and104 stable
  source pins; actual-original-project.json retains /usr/bin/git children
  68992/68993, exit0 and both EOFs/reap. actual-prefix.json retains the matching
  original deadline, envelope, pointer and PID record. Pending retry and Drop
  artifacts retain the same custodian births while a test owns stdout, then
  observe both instances absent after release; sessionsExist remains false. The
  error-cause mutation exits101 at the RemoteFailure downcast assertion, with
  exact source restoration. Remaining session_cache_wire tests31, sqlite-store
  check and combined native-peer-candidate-05 tests5 exit0. Controlled OpenCode
  argv0 remains a test frontend, not a loaded vendor callback. Root retains
  main-before-Node capture, native-selected profiles, ordinary SQL/render
  publication, actual reader/release and residency workload. The library join
  earns no installed adoption or parent acceptance.
- E330: The fixed OpenCode component comparator owns its corpus and oracle
  identities; requests cannot substitute command recipes or case inventories. A
  code-owned complete stock-tree inventory also rejects a caller-substituted
  reference implementation; file pins alone did not establish that relation.
  stop-profile-comparison-execution-05 exits0 in4.650s with30 equal comparisons
  across explicit4300/unlimited profiles and31 child executions. The retained
  component-comparison.json pins233 output artifacts, independently rehashed
  without mismatch, plus loaded candidate modules and observed CPython files.
  Earlier attempts fail on caller-supplied subagent layout and an incorrectly
  modeled HTML fixture; corrected inputs follow render-reader's actual layout
  and stock harness-claude's tagged shell-unescape behavior. Ordinary literal
  HTML is a separate positive control; tagged4301-digit HTML refuses at its
  actual second-row byte offset. The frozen Python reference is unchanged. This
  compares controlled component behavior, not ambient Python startup, native
  calendar observations, bundled dispatch, admission or other surfaces. The
  component draft explicitly retains those joins and grants no authority.
- E331: executeNativeStopPublication joins exhausted SQL projection, observed
  Render preparation and the reopened current-generation consumer. It retains
  separate numeric profiles, captured metadata, source-presence inputs and
  original operation/cleanup errors. ordinary-stop-adapter-build-02 exits0;
  ordinary-stop-adapter-tests-03 exits0 with52 cases across three suites.
  Retained scenario.json and actual projection/turn/index/marker files show
  original model/start/SHA and user text before consumption. Same-length user
  substitution produces "Committed session artifact bytes differ" with no
  outcome callback or acknowledgement; metadata substitution, callback failure
  and paired acquisition/cleanup failures also retain explicit refusal state. A
  forged turn with recomputed matching marker/hash passes reader integrity but
  the adapter refuses "Committed Stop artifact differs from preparation",
  retaining the forged file and an unacknowledged terminal outcome. SQL and
  native observations are fixtures; these cases issue zero local-calendar
  queries. The adapter is not routed by the ordinary engine. Root retains the
  native-qualified receipt, authenticated acquire_store transfer before reserve,
  original project/deadline reuse, actual publication/reader/release, residency
  and installed cutover. Capture precedes Node; transfer can use the existing
  store socket after prefix completion without a second registration service.

- E332: Native main captures the optional original OpenCode Stop before Node,
  retains its original deadline and failed-capture cleanup, and replays
  successful ContextGit observations without another Git child. Native-owned
  selection roots feed correlated bounded observation frames on the existing
  sole reader; Ready seals the readset and dispatch revalidates it. Compact
  runtime digests avoid transmitting admitted executable bodies. The readset
  retains negative candidates, lexical and resolved ancestors, and nested
  symlink dependencies. selection-native-transport-check-01 exits0; feature-off
  binary tests in selection-native-transport-unit-01 exit0 with126 cases. Actual
  native main with pinned real Node protocol simulator in
  selection-native-transport-main-positive-01 exits0 in56.699s across four
  cases: successful original replay2→2 Git queries, generation refusal0→2,
  capture refusal1→3 and invalid-root compatibility2→2. selection-observed.json
  retains a150000-byte source in four encoded-observation chunks
  of65536/65536/65536/3822 bytes, a true absent candidate and a760-byte
  runtime-digest observation for the112989184-byte Node member. The six hostile
  cases in selection-native-transport-main-hostile-01 exit0 in74.566s, retaining
  exact identity/snapshot/duplicate/overlap/stale/after-Ready refusal
  diagnostics and no session output. Stop's infrastructure exit semantics are
  preserved; exit0 alone does not mean the guarded operation completed. The
  resolved-parent replacement artifact retains identical leaf
  inode/timestamps/bytes, different parent identities and refusal. Its
  zero-effect counter is a test callback, not evidence of zero actual store
  reservations or SQLite opens. Source/input pins remain unchanged during these
  runs and supervisor residue is empty.
- E333: The typed engine uses the same native observation transport before
  Ready. selection-transport-build-01 exits0; selection-transport-tests-01
  exits0 with178 cases across selection I/O, observation, protocol and compiled
  engine-entry suites. Actual compiled entry controls consume serial
  native-shaped replies and reject malformed chunks without ambient-read
  fallback. The earlier selection-runtime-digest-tests-01 fails because its
  replay test asks for full bytes after capturing only a digest; the corrected
  oracle requires the digest and refusal of the uncaptured byte read, retaining
  a separate explicit byte capture positive. Native and compiled-engine fixtures
  are separate evidence; their combination, full stock-selection admission,
  profile qualification, authenticated store transfer and ordinary publication
  remain root-owned. The finite StockStopSelection predicate has six focused
  filesystem/readset controls within the126 native cases, but no actual-stock
  positive admission or production caller. Neither its existence nor those
  controls grants a native Stop publication capability. All run artifacts reside
  under the root session's publication-integration directory outside the source
  ledger.

- E334: Actual native main and the unchanged maintained engine are composed with
  a fresh 5779-member debug v1 package and the original30s deadline in
  maintained-selection-execution-01. The probe exits1; native exits0
  after30572ms but explicitly reports request-deadline expiry and incomplete
  checks. Only seeded session metadata exists: no invocation journal, turn or
  index; the pending plan remains and its output contains the original
  placeholder. Exit0 is therefore not a completion observation. Source
  inspection finds that per-member lstat/digest discovery cannot fit4096
  observations. The bounded phase diagnostic in
  maintained-selection-phase-execution-01 retains a second failure: generation
  capture7068ms, executor/context through8080ms, owner verification
  through11467ms and discovery expiry at30032ms after1093 completed native
  exchanges, last runtime-digest. This locates the failure in discovery, not a
  measured cap refusal. Phase means last entered phase; completion means native
  chunk writes, not engine consumption; elapsedLocalMs uses the original
  conservative local expiry. Diagnostics retain no new payload/path data.
  selection-phase-hostile-01 exposes an incorrect added assertion expecting one
  exchange where the simulator performs three; source and retained stderr
  establish the three-exchange sequence. The corrected hostile replay exits0
  in71.601s, including refusal at sealing and after Ready. No deadline, resource
  ceiling, package inventory or protective behavior is relaxed.
- E335: Native runtime-generation observations reuse only the original
  GenerationReceipt's verified manifest, exact root spelling and original
  expiry. Summary reads check ancestor/root/manifest identities; construction,
  sealing and predispatch full-generation validation remain required.
  generation-summary-native-unit-01 exits0 with134 cases in8.015s. The actual
  4108-member fixture produces one394858-byte observation in seven chunks and
  revalidates. Member, inventory and mode changes refuse before a test callback;
  its zero-effect counter does not prove zero real store reservations or SQL
  opens. Foreign roots, aliases, present singleLink, cancellation and expired
  original receipts refuse. Native feature-off build and default-feature compile
  checks exit0; default features are empty, so these do not compile or execute
  SQLite behavior. This manifest data is not stock selection, semantic profile
  or publication authority. Actual maintained-engine consumption and
  full-package completion remain required.
- E336: installed-startup-probe-execution-01 exits0 in4.350s, executing exact
  private copies of the selected runtime's SQL and renderer entrypoints under
  captured current-process startup. Seven SQL and eight renderer cases match
  separate4300-digit profiles. Actual4301-digit numeric/HTML-decimal inputs
  refuse with the4300-digit ValueError and no corresponding projection/turn; the
  plain renderer writes user qualified-visible and index turn_count1. Root
  rechecks232 artifact hashes and identical before/after original-runtime
  inventories, excluding read atime. The SQL and renderer source hashes equal
  E330's references; the session-log.sh wrapper differs. This supports separate
  numeric profile data, not full installed-path/vendor-callback equivalence,
  ambient module closure, native calendar admission or production Stop policy.
  Artifacts reside in copied-startup-probe-observation-01 under the root
  session's publication-integration directory; original installed bytes remain
  unchanged.

- E337: The typed canonical verifier consumes one native generation observation
  while public snapshots/tooling retain complete filesystem verification.
  Callback identity isolates the cache; independent policy/registration/byte
  reads remain required. The pure validator preserves the TS lexical rejection
  of a root member named ..fixture, which native path validation alone permits.
  generation-summary-build-01 exits0 in6.794s. The first focused run rejects two
  native-layout fixtures that inherited legacy read-only modes; fixture creation
  is corrected to the native0644/0755 contract without weakening verification.
  generation-summary-tests-02 exits0 with193 cases in8.937s,
  including4200-member discovery, malformed/cross-generation results, uncaptured
  byte reads and callback-cache isolation. The actual5779-member
  native/maintained-engine image in maintained-selection-summary-execution-01
  reaches Ready after364 observations at16694ms, then refuses during sealing
  at20000ms because an lstat dependency on /Users/darianrosebrook/.codex
  changed. Native exits0 but the scenario correctly exits1. An invocation
  journal exists, but no dispatch/turn completion is established. This
  demonstrates progress beyond the discovery timeout, not successful
  composition. Path-confinement consumers inspect kind rather than directory
  inventory timestamps; an explicit identity observation must separate those
  dependencies while generic metadata/list checks stay strict. Root retains this
  repair and the ordinary publication obligation.

- E338: Path confinement uses an explicit path-identity observation rather than
  generic lstat. Native evidence retains kind/device/inode/mode/ownership and
  traversal anchors; path identity excludes contents, timestamps and link count.
  E365 applies the corresponding identity projection to present-directory
  Exists. Generic metadata, bytes and inventory operations retain their strict
  dependencies. Stock selection requires the explicit observation without a
  missing-row fallback. path-identity-native-unit-01 exits0 with142 cases,
  including sibling-change acceptance and inode/mode/symlink/absence and
  resolved ancestor replacement refusals; effect counters are test callbacks,
  not real SQLite-open observations. path-identity-build-01 and
  path-identity-tests-01 exit0 with208 focused TS cases. The same5779-member
  debug image in maintained-selection-identity-execution-01 passes sealing
  at23571ms, then expires during predispatch revalidation at30026ms. Native
  exits0 while the scenario exits1, with no dispatch grant. This resolves the
  observed sealing obstruction in that replay but does not establish successful
  composition or identify the exact metadata field changed in E337. Root next
  compares the optimized binary with the same source, inventory and original30s
  deadline; repeated full-generation validation remains intact. Source landing,
  actual stock admission, profile-bound acquisition/publication, residency and
  machine cutover remain separate obligations.
- E339: The same source and5779-member package completes the actual maintained
  invocation with optimized native binaries. path-identity-native-release-01
  builds both entrypoints exit0 in43.880s with unchanged source/input pins.
  maintained-selection-optimized-execution-01 exits0 in20.773s overall; native
  exits0 after13628ms under the unchanged30000ms invocation deadline. The fresh
  v1 image retains65 packages and4435 unchanged dependency/root members; no
  verification pass or resource ceiling is removed. The actual journal contains
  invocation_started, dispatch_started, compatibility_dispatch_completed,
  dispatch_completed, adapter_stdout_handoff and adapter_finished exactly once.
  All four selected stock handlers complete exit0. turn-001.json contains user
  maintained engine visible user, reply maintained engine visible reply and the
  original start/model/SHA/nested cwd; session-index.json has turn_count1. The
  final plan snapshot equals the input transcript and its pending-list file is
  absent. Root independently rehashes nine output pins. Raw commands, terminal
  state, journal, turn/index and plan files are retained under
  publication-integration/maintained-selection-optimized-observation-01 in the
  root session artifact directory. This is one optimized compatibility-path
  observation, not a latency distribution, governed release-build receipt,
  native SQL/publication admission, vendor delivery, Python retirement or
  machine adoption. The journal correctly retains delivery:not_observed. Debug
  expiry in E338 remains a real failure; further native admission adds
  verification work and requires another full-image timing check.
  path-identity-main-hostile-01 exits0 in67.731s across six actual-main
  simulator scenarios: wrong request/snapshot identity, duplicate/overlapping
  reads, stale dependencies and a read after Ready refuse without retry. The
  late-read case has a dispatch observation and proves post-dispatch refusal,
  not absence of every effect. path-identity-sqlite-compile-01 explicitly
  enables sqlite-store and exits0; it compiles the feature and tests without
  executing SQLite. Focused lint exits0. Full-basis publication gates
  evaluate131 paths with five PASS dispositions; doctor reports0E/4W/5I. These
  checks do not extend the compatibility-path observation to native publication
  or machine adoption.
- E340: E339's downstream output alone cannot distinguish native selection
  transport from compatibility fallback: main permits an absent selection owner.
  Opt-in CAWS_NATIVE_TRACE_PROGRESS=1 emits one bounded native-owned success
  snapshot after completion. Advertised, sealed, predispatch-revalidated and
  dispatch-written flags are set only after their corresponding native action;
  the diagnostic grants no authority and carries no paths or payloads.
  selection-progress-release-01 builds both optimized entrypoints exit0 in
  10.051s. selection-progress-main-controls-01 exits0 in10.489s: captured
  selection reports three observations and all selection flags true; refused
  generation/capture controls report zero observations and false selection flags
  despite successful compatibility dispatch; disabled tracing is silent. Both
  executions retain107 unchanged native source pins and no group residue. The
  fresh full5779-member image uses native SHA256
  a570dec06069e7b4cf59552ea2de761c9f22bd1835ddb6f81d72b47da344e59b.
  maintained-selection-progress-execution-01 exits0 in21.110s overall with436
  unchanged TypeScript source pins and no group residue. Its actual native
  invocation exits0 in13232ms under the original30000ms deadline.
  maintained-selection-progress-observation-01/native-progress.json records
  completedSelectionSequence364, all four native flags true and phase completed;
  the probe requires those values before accepting downstream output. The
  journal's six stages complete once, all four stock handlers exit0, the turn
  preserves the expected user/reply and original model/start/SHA/nested cwd, the
  index contains one turn, and the final plan snapshot equals the source
  transcript with no pending-list file. Root independently rehashes six
  selected/output pins and seven session-file pins and compares embedded journal
  executions with the retained raw records. Commands, logs, source pins and
  semantic artifacts remain under publication-integration in the root session
  artifact directory. This establishes native selection traversal plus
  compatibility completion for this isolated invocation. It does not establish
  native stock admission, SQL/publication/reader/release integration, Python
  retirement, vendor delivery, latency distributions, residency or cutover. The
  journal retains delivery:not_observed; E338's debug deadline failure remains
  evidence, and further admission must fit the same original budget. Reviewed
  source candidate aab7c78a24cb3efc9930399f6755104de91688b0 lands on local main
  through267f85832ea64089adb51c6355a48cf920728608. Root verifies ancestry and
  exact packages/docs equality; events12776/12777/12781 record bounded A1/A2/A3
  evidence and event12782 closes the temporary selection spec. Parent spec
  SHA256 0c11d997c2dfbc9187a21c19d85267525b7632dc344d77269e6ecf7cb51f719f and
  selected machine pointer SHA256
  f8a3627299bc8c3d325eb42472f889b43e7c26c8a4e4c02996091867cb9f4f7e remain
  unchanged across landing. No remote push or machine installation is claimed.

- E341: The maintained native entry calls StockStopSelection::admit after Ready
  and successful sealing. The selection borrows the original capture and sealed
  receipt; Unsupported retains compatibility's predispatch freshness check,
  while Invalidated terminates the invocation. The bounded native diagnostic
  distinguishes not_attempted, unsupported, admitted and invalidated without
  granting prefix, profile, SQL or publication authority. The release build in
  stock-admission-release-01 exits0 in10.710s. The fresh maintained full-image
  invocation in maintained-stock-admission-execution-01 exits0 in23.399s
  overall; its native terminal exits0 in16267ms under the original30000ms
  deadline. maintained-stock-admission-observation-01/native-progress.json
  records364 observations, stockSelection:admitted, successful sealing and
  predispatch revalidation, and one dispatch. Native SHA256 is
  704c474d46dedf1defa8bef79f3433af6a2925332dc9e13f09e88220c4e127cb. All four
  handlers execute through compatibility; the turn preserves the expected
  user/reply and original metadata, the index has one turn, and the final plan
  snapshot equals the source transcript byte-for-byte. Root rehashes 107 native
  and436 TypeScript source pins, six selected/output pins and seven session
  files. reorient-stock-admission-controls-01 exits0 in12.603s: sparse and empty
  readsets remain unsupported with freshness checking; absent capture does not
  attempt admission. reorient-stock-admission-hostile-01 exits0 in 12.538s: five
  protocol/stale cases refuse before dispatch; the late request refuses after
  dispatch without retry, which does not establish zero effects.
  stock-admission-unit-baseline-01 exits0 in24.019s with142 binary-unit checks,
  unchanged inputs/source and no group residue. These controls use a simulated
  engine; the retained maintained-engine positive uses actual compiled entry
  code. The stale simulator case fails during sealing and does not exercise
  admission's Invalidated branch. These artifacts remain under the root
  session's publication-integration directory. No production Stop store port,
  semantic profile qualification, native publication/consumer/release, Python
  retirement, vendor delivery, resident fairness or selected-machine cutover is
  established. Root owns those integrations; E342 exercises direct admission
  invalidation separately from main's protocol routing.
- E342: tests/stock_stop_admission.rs calls the production admission constructor
  with a genuine OriginalStopCapture, Cargo-built custodian and two settled Git
  queries. The synthetic generation supplies no stock-positive or installed
  execution claim. stock-admission-direct-01 exits0 in25.401s: the retained
  direct-stock-admit.json records Unsupported for a fresh sparse readset,
  Invalidated for a dependency changed after sealing, and Invalidated preserving
  the cancellation sentinel with exactly one callback. The session directory
  remains absent. Removing only admission's initial readset revalidation in an
  isolated source copy makes stock-admission-mutant-01 exit101 in25.600s at the
  exact wrong-variant assertion: Unsupported instead of Invalidated. No live
  source is mutated. The first restored run, stock-admission-direct-restored-01,
  also exits101 because a shared Cargo target reuses the mutant test executable
  despite unchanged original source pins; that failed attempt remains evidence
  against treating source pins alone as executable identity. A distinct fresh
  target in stock-admission-direct-fresh-01 rebuilds the original source and
  exits0 in59.737s with unchanged108 source pins, input pins and no group
  residue. Its binary identities and constructor artifacts are retained beside
  the raw logs. Subsequent checks must use this fresh target rather than the
  contaminated target-feature-off cache. stock-admission-sqlite-compile-01
  exits0 with the explicit sqlite-store feature before the test-only addition;
  compilation is not SQL execution. The direct constructor and one revalidation
  mutant are exercised, not a complete mutation score or deterministic
  main-level post-seal invalidation. The ordinary native publication chain
  remains owed. Local main merge56f917d8 lands the reviewed five-path slice.
  stock-admission-landing-01 retains scoped gates exit0, doctor exit0 with
  0E/4W/5I, the merge and postmerge path/ancestry checks. A1/A2 recording is
  read back in events12803/12804; A3 records the postmerge observation before
  the bounded landing spec closes. Parent acceptance and selected-machine state
  hashes remain unchanged; the temporary landing lane is removed.

- E343: Native Stop publication captures an explicit source catalog for audit,
  hook outcomes and both stock subagent directory candidates. Captured bytes,
  absence, directory dispositions and complete bounded names enter the Render
  prepare.v2 input digest and binding.v2 observation lease. The ordinary Stop
  adapter consumes the lease's descriptor-bound source buffers; caller-supplied
  source assertions are removed. Generic prepare.v1/binding.v1 remain separate.
  stop-source-catalog-native-02 exits0 in43.635s with six capture/refusal
  controls and retained captured-catalog.json/captured-inputs.json. Appearance
  after absence, changed metadata, cancellation and expired deadlines refuse;
  listing failure uses a real regular-file read_dir error, not an
  EACCES-directory proof. stop-source-catalog-wire-01 exits0 in43.823s with ten
  native wire/Git/calendar controls, including catalog-digest mutation refusing
  before Git. The CLI build exits0 in6.300s; stop-source-catalog-ts-01 exits0
  in3.348s with187 cases in four suites, including generic v1, catalog
  correlation, ordinary-reader corruption and caller-source rejection.
  stop-source-catalog-cross-runtime-02 consumes five actual retained Rust
  captures with compiled TypeScript: input digests agree, tool-one maps to
  agent-one.jsonl and agent_type review, and substituted bytes refuse. Attempt01
  fails because the external replay driver used original instead of the declared
  attempt binding field; its driver and failure remain retained, and production
  code is unchanged by that correction. Scoped lint exits0; explicit
  sqlite-store compilation exits0 in17.924s. Compilation does not execute the
  SQLite publication branch. Artifacts reside under the root session's
  publication-integration directory. Relative CAWS_LOG_DIR explicitly refuses
  until the original render-cwd registration resolves it. Root owns that parity
  repair, native entry integration and actual publication/release. The bounded
  CAWS-NATIVE-STOP-CATALOG-LANDING-001 delivery uses the ten source/test blobs
  from d66b99e5; its store actor excludes the registration changes described in
  E344. E344-E366 carry the separate integration and execution evidence. No
  production activation, full Python retirement or cutover follows.

- E344: The resident store has a distinct native Stop registration entry that
  borrows the actual original capture and completed prefix. NativePeer retains
  the same monotonic clock and kernel connection through queueing. Native-only
  challenges correlate identity, generation, binding digest, registration,
  deadline, sequence and phase; they never enter the Node relay. The actor
  revalidates after its earlier cohort before durable original reservation,
  before writer admission, after lock acquisition/retirement, before SQL and
  before publication. The admitted SQL entry consumes the captured project
  instead of running another Git observation; the development route retains its
  independent observation. Relative audit roots resolve against the native
  registration's original absolute render cwd. Relative payload cwd remains
  outside this registration's qualified domain, not full parity. Root applied
  the external proposal after the worker's model-capacity failure, added
  retained challenge/phase/refusal artifacts and executed the checks serially.
  native-stop-registration-check-01 exits0 in6.241s with sqlite-store
  compilation. native-stop-registration-tests-01 exits0 in67.771s:22 store cases
  execute and the prepared-image actor-ordering case remains explicitly ignored.
  Its native-registration-phase-sequences.json records six cold-writer and five
  retained-writer checks with terminal replay refusal;
  native-registration-foreign-challenges.json retains all eight rejected wire
  mutations. native-registration-unauthenticated.json retains the actual binding
  refusal, zero actor/registry entries and equal before/after file hashes.
  Independent review exposes a missing payload cwd in that fixture: the test
  refuses before authentication, so removing authentication could leave it
  green. The repaired control supplies matching cwd, asserts binding validation
  succeeds and selects an actual invalid generation manifest.
  native-stop-registration-repair-01 exits0 but selects zero tests because the
  exact filter omits the module path; it earns no behavioral evidence.
  native-stop-registration-repair-02 executes the fully qualified test and
  exits0 in0.294s. Its retained native-registration-unauthenticated.json records
  Runtime manifest integrity failure, null registration/acquisition, zero
  actors, an empty registry and24 unchanged file hashes. This establishes
  generation refusal before reservation; it neither authenticates a valid native
  caller nor counts actual SQLite opens. native-stop-registration-peer-01 exits0
  in44.973s with six actual native/Node peer controls, including original-clock
  ownership, process death, same-byte executable replacement and expiry.
  native-stop-registration-original-01 exits0 in4.301s and retains actual
  original Git/prefix outputs plus matching registration acceptance and foreign
  identity/root refusals. Artifacts reside under the root session's
  publication-integration directory. The feature-off compilation exits0
  in15.648s; it does not execute native Stop. These separate observations do not
  establish the combined authenticated queue/SQL/publication path. Root owns the
  actual queued-selection-mutation falsifier with direct SQL-open observation,
  semantic-profile/current-image qualification, main/engine connection and
  ordinary reader/CONSUMED/release. No production activation, complete Python
  retirement, fairness or machine adoption is inferred.

- E345: The maintained Stop qualifier can emit native-stop-profile.json after
  its fixed30 SQL/renderer comparisons and exact pre-profile image checks.
  Reviewed v2 image preparation binds that member to the native executables,
  complete prefix and build provenance without a final-generation digest cycle.
  The native StopProfileReceipt loader retains the original capture, deadline,
  generation and independently selected SQL/renderer profiles. These are
  implementation boundaries, not an executed fresh producer/consumer chain.
  native-stop-profile-build-01 exits0 in6.308s; tooling-02 exits0 with six
  qualifier refusal controls. The combined ts-01 attempt times out at110s and
  adapter-02 at50s, with no terminal suite result. Retained fixture timestamps
  show completed installation cases consuming the second budget; its CPU sample
  is inside a case that subsequently completes, not evidence of an infinite
  loop. semantic-03 exits0 in3.147s with eight new semantic-data controls and
  the isolated existing symlink refusal. adapter-v2-03 executes the
  complete38-case v2 group and exits0 in58.243s;50 other file cases are filtered
  out. The retained fixture observations and prepared-image members use a mocked
  build-receipt loader and fake executables; they do not execute a production
  native image. native-stop-profile-rust-01 exits0 in23.323s with four synthetic
  validation/environment/deadline controls. Feature-off check exits0 in7.882s
  without runtime execution. Source/input pins remain unchanged during these
  checks and observed process groups are empty afterward. Artifacts reside under
  publication-integration in the root session directory. The native profile
  domain requires original TZ=UTC0, absent TZDIR and the reviewed integer
  limits; it does not establish other host environments. Root owns
  fresh30-comparison profile emission against the exact candidate, actual native
  receipt capture, original-calendar and engine equivalence, production
  eligibility/main wiring and integrated publication/reader/release. Authentic
  generation bytes cannot alone prove the historical comparisons executed. No
  parent acceptance, selected-machine adoption or Python retirement follows from
  these component checks. native-stop-profile-member-01 executes the existing
  authenticated member-read control excluded by rust-01 and exits0 in0.237s,
  retaining its generation fixture. Explicit package-cwd lint01 exits1 for a
  bare AbortController reference also present in the prior qualifier. Naming
  globalThis.AbortController preserves the Node runtime operation; four-path
  lint02 exits0 and tooling03 repeats the six refusal controls exit0. The commit
  hook ignored the TypeScript path because its invocation found no matching
  configuration; that hook is not lint evidence.

- E346: The source connects retained native Stop selection/profile owners to
  dispatch.v3, the separate Stop prefix exchange and native resident
  registration. The typed entry uses its existing framed transport and deadline;
  the ordinary executor verifies the selected logger before replacing index2
  with the existing store/publication consumer. Reprieve and ordered composition
  remain ordinary decisions. Unsupported startup and skipped/unsafe supplied
  identities are excluded before the grant; partial prefix effects, uncertain
  delivery and post-grant failures cannot authorize compatibility replay.
  Original selection and profile owners revalidate across the queued
  registration checkpoints. These source connections await execution through a
  fresh production image. native-stop-engine-join-build-02 exits0 in6.248s.
  tests-01 exits1: one supplied test path does not exist and a routing oracle
  compares two distinct fixture runtime digests. Each fixture home is embedded
  in the OpenCode plugin and therefore changes its manifest digest. The repaired
  oracle verifies each selected generation and exact reset-script member before
  normalizing only that path. tests-02 exits0 in27.946s with244 checks across
  six existing/new suites. Its14 retained fixtures include actual composer
  journals; the positive trace is prefix/first/second/publication/last, the
  reprieved logger has zero publication calls, and post-prefix logger mutation
  has zero publication and compatibility calls. Native prefix/publication are
  mocked in these new controls; they cannot prove SQL closure, filesystem
  publication or consumption. Raw logs and fixtures live under
  publication-integration/native-stop-engine-join-tests-02 in the root artifact
  directory. lint01 exits1 for two bare AbortController references; explicit
  globalThis preserves the runtime binding and lint02 exits0. Native
  main-join-tests-01 executes the distinct operation/duplicate/size control
  exit0; main-join-tests-02 executes startup and supplied-identity controls
  exit0. open-observation-tests-01 and open-observation-status-01 execute one
  control each, exit0: a saturating process counter at the actual
  transcript-database open call and owner/count status across
  missing/registered/released records. These units do not prove zero opens for
  an actual queued invocation. The observation means transcript-database opens,
  excluding profile identity's in-memory SQLite connection; saturation
  invalidates a zero-delta claim. Source/input pins remain unchanged during
  checks and observed child groups settle. Root owns the fresh-image recipe,
  fixed30 comparison execution, actual original native invocation through
  ordinary reader/CONSUMED/heavy release and the paired queued-mutation refusal
  with zero database-open attempts on the same isolated owner. The finite
  UTC0/OpenCode profile and resource ceilings do not establish
  ambient/all-surface or above-limit legacy parity. Full Python retirement,
  unchanged1000hotturns, thirteen-session/four-repository fairness, coherent
  main delivery, installed execution and rollback remain open.

- E347: Candidate3e99f570 commits the E346 connection with a clean owned lane.
  Independent same-provider source review finds no actionable defect in its
  inspected connection; root grounds the retained owner, completed-prefix,
  handler-verification and observation-call coordinates directly. Review does
  not establish integrated behavior. Explicit package lint02 exits0; the commit
  hook ignores seven TypeScript files and supplies no substitute lint evidence.
  Feature-off check02 exits0 in1.479s without executing the runtime. Doctor
  exits0 with0E/4W/5I; policy gates pass over145 branch/staged paths without
  parent AC writes. The fresh-stop-profile-production-01 preparation exports
  this exact committed source, including110 native files, and exits0 in3.544s.
  Its exported CLI build exits0 in7.351s. The native-build-01 outer supervisor
  times out at120s, kills its group and observes no remaining group processes.
  Cargo's retained step exits0 in98.565s; the actual new binary's SQLite
  identity step exits0 and reports3.53.4, threadSafe1 and compiledPrefixSha256
  7e9e3380222ac021ed815e49b2b0be31839af540a8954a80db00e523d08c5e98. nm-native
  and otool-native also exit0. Neither native-completed.json nor a terminal
  builder failure receipt exists: compiler/identity success cannot replace the
  interrupted producer's remaining inspections/publication. Raw artifacts remain
  under fresh-stop-profile-native-build-01 and
  fresh-stop-profile-production-01/run/native-build in the root artifact
  directory. Root owns a fresh attempt with outer supervision that permits
  terminal receipt/settlement while retaining the builder's original deadline;
  no success may be synthesized from this interrupted output. Fixed30 profile
  execution, integrated native publication/refusal, coherent main delivery and
  selected-machine cutover remain unverified. The selected runtime remains
  408c06a7cbdb1950e24f53a7486428c3a51e45bbeb86292cb9b2dec30177baa0.

- E348: Reorientation preserves the lead transfer and full local-cutover goal;
  component verification does not discharge the three integrated outcomes. Local
  main merge bbe4b3895c53348da4d2703a486b8cabe79cb7d8 lands E343's ten
  source/test blobs from d66b99e5 through candidate6c3a71bf. Root checks all436
  retained TypeScript inputs and108 native inputs against the extracted lane,
  the five actual captured-input hashes, subagent mapping and both byte-bearing
  substitution refusals. These are retained executed checks, not fresh tests.
  Same-provider read-only composition review identifies no actionable defect;
  source inspection confirms production Stop remains inactive in this slice.
  Doctor exits0 with0E/4W/5I and scoped gates pass over11 paths. Commit-hook
  TypeScript lint is ignored; matching package-scoped retained lint supplies
  lint evidence. The first postmerge inspector wrongly requires HEAD to equal
  the merge commit; governed teardown adds a binding-only commit. Corrected
  ancestry and exact-blob checks establish the landing, removed temporary lane
  and unchanged parent spec/selected runtime hashes. A1/A2/A3 evidence and
  closure are read back through events12864/12865/12868/12869.
  CAWS-NATIVE-STOP-CATALOG-LANDING-001 closes only this source increment;
  publication-integration/stop-source-catalog-landing-01 retains raw governance,
  composition and postmerge artifacts.

  Fresh production-source attempt02 retains the original120000ms builder
  deadline with a180s outer watchdog. Preparation and CLI build exit0; native
  build exits1 in120.481s without outer timeout or group residue. Its genuine
  native-failed.json names otool-stable-entry and Native build timeout; Cargo
  exits0 in97.650s. Attempt03 keeps the runtime30s and comparison60s deadlines
  but declares a180000ms development-build allowance with240s outer custody,
  within the existing builder schema. Its exact exported candidate57f79fb9
  includes110 native files. Preparation, CLI build, native build and normal
  package creation exit0. Native build completes in119.218s with seven recorded
  steps exit0, reaped children and no observed group residue. The maintained
  native-completed.json remains NOT_ADOPTED, requestDigest
  ce3a23cf6915aa04c038f8519690e35bf63a915f5a9fcf51c9813ef4c4516907. Actual
  caws-native SHA256 is
  a3534817ce4390af4593ede53d9b4f15a441d7d3cf8ef20ffdc30700082fded3; the
  fresh2710444-byte tarball has1341 members and SHA256
  8ea3ecd342ef3226808b1354114c486cfb2d4684d96817f92349c0aeeb8d5865.
  prefix-install03 exits1 EINTEGRITY because inherited root/hidden lock data
  associates the old same-version tarball checksum with the relocated new path.
  The failed prefix is preserved. A new isolated recovery preparation exits0;
  its normal explicit offline npm install exits1 ENOTCACHED for the locked
  js-yaml4.3.2 archive. No network fallback or integrity relaxation occurs. Root
  owns recovery and fixed30 comparisons; html_profile accepts bounded external
  packaging/cache repair. Completed build artifacts are reused only with their
  retained exact source/request identities, not inferred adoption.

  Root observes TZ, TZDIR and PYTHONINTMAXSTRDIGITS absent in this session's
  shell tool environment. stop_profile.rs requires original TZ=UTC0 and absent
  TZDIR; stop_execution.rs returns compatibility for unsupported profiles only
  after revalidation. This source/environment observation does not inspect an
  actual vendor application's environment. A successful controlled UTC0 probe
  cannot establish real launch-calendar parity; silently forcing UTC would
  change the contract. The positive/queued-mutation external probe is authored
  and passes Node syntax checking, but has not executed. Source inspection of
  render_owner/store.rs's BeforeReservation/error paths and render_owner.rs's
  idle predicate finds that a pre-reservation rejection retains its registry
  record; indefinite retention is an inference awaiting the real negative
  scenario. Root retains this residency obligation, with stop_engine_join
  assigned a bounded rejection/replay/custody design investigation. Releasing a
  record without a durable rejected-original outcome could erase no-replay
  protection. No repair, actual queued zero-open result, SQL CLOSED/publication/
  ordinary reader/CONSUMED/release result, thirteen-session/four-repository run,
  Python retirement, machine adoption or rollback is claimed by this entry. Raw
  attempts live under fresh-stop-profile-production-02/03,
  fresh-stop-profile-prefix-recovery-01 and their corresponding supervisor
  directories; reorientation-ambient-observation-01.json binds the shell-only
  observation. Root owns the integrated execution and continuing cutover goal.

- E349: Reorientation reads all164 available CAWS turn records for root session
  01a164bc-7a2b-75e2-be81-5da9d0a29252. The user's lead transfer supersedes
  coordination-only ownership; full parity and actual local cutover remain the
  outcome. Main120cab3d contains the E348 catalog merge; the owned publication
  lane17733de5 is clean before this documentation edit. Selected machine digest
  remains408c06a7cbdb1950e24f53a7486428c3a51e45bbeb86292cb9b2dec30177baa0.

  Recovery02 verifies and seeds64 lock-selected archive bodies into a private
  offline npm cache. Preparation, normal offline installation, prefix
  verification and maintained image preparation exit0 in2.917s/1.369s/1.602s/
  3.860s. verified-prefix.json records5776 prefix members,64 third-party
  packages, the exact fresh8ea3ecd3 tarball and unchanged failed03 prefix.
  prepared-image.json records5854 prepared image members and state
  prepared_not_compared. These artifacts reuse the genuine03 native completion
  for exported candidate57f79fb9; neither live lane HEAD nor successful
  packaging grants runtime acceptance. fresh-stop-profile-recovered-qualifier-02
  exits1 in2.114s without timeout or observed group residue. Its stderr reports
  an unqualified Python dependency for the exported session_log_renderer.py:
  expected e45f7ec6, absent path key. The relocated sharedRoot retained
  lane-absolute Python dependency keys. Root owns execution; html_profile
  accepts a bounded fresh-request repair preserving reviewed dependency hashes,
  failed output and all qualification checks.

  Root grounds an integration defect beyond the absent-TZ domain: main.rs passes
  the raw Session into acquire_native_stop_store, while the typed production
  adapter requires renderObservations and session-publication-client waits for
  openNativeRenderObservations immediately after Render INPUTS READY. Only
  render_observation::ObservationTransport emits that original binding; source
  search finds no production ObservationOwner construction. The missing producer
  is established from source. A mutual wait until deadline is inferred, not an
  executed timeout: the ordinary consumer waits for the binding while the raw
  publication relay waits for its PREPARED frame. This affects controlled UTC
  positive publication before any naive-calendar query. Component comparisons
  cannot establish this connection. Root owns original-process Git/calendar
  capture, transport connection, retained cleanup custody and the real positive
  invocation; ambient_stop_domain accepts the bounded source-design question.

  The following increment must establish original capture through completed
  prefix, SQL CLOSED, Render binding, ordinary semantic consumption, durable
  CONSUMED and release, then land that coherent owned slice. The absent-TZ host
  calendar domain remains separate and required for actual local use. The
  pre-reservation rejection design remains unimplemented: durable rejected-ID
  history must precede heavy release; dispatch absence cannot establish safety,
  and existing CancelledBeforeDispatch records do not reclaim persisted live
  capacity. Root retains both obligations. No production positive/refusal run,
  thirteen-session/four-repository workload, Python retirement, machine adoption
  or rollback is established by this entry. Raw recovery and qualifier artifacts
  remain under publication-integration/fresh-stop-profile-prefix-recovery-02 and
  the corresponding supervisor directories.

- E350: Reorientation reconciles all 168 available CAWS turn records with the
  original Codex user messages, current source and retained runtime artifacts.
  Lead ownership, full parity, incremental coherent landings and actual local
  cutover remain required. Main 120cab3d contains catalog merge bbe4b389; the
  selected machine digest remains
  408c06a7cbdb1950e24f53a7486428c3a51e45bbeb86292cb9b2dec30177baa0.

  Qualifier repair a6fd9b7c hashes independently canonicalized wrapper objects
  after deep equality, preserving payload bytes, array order and negative zero;
  unsupported values and sparse arrays refuse. The preceding relocated run
  failed after all 30 parsed comparison values matched because wrapper key order
  changed the hashes. That failure remains retained. Seven focused qualifier
  checks and scoped lint exit 0. The maintained qualifier then exits0 in 6.371s;
  its 31 child executions exit 0 and 30 comparisons produce profile aa600524.
  Finalization exits0 in 6.907s, producing 5855 image members and descriptor
  de51c847. Raw commands, outputs and result.json live under
  publication-integration/ fresh-stop-profile-maintained-execution-01,
  fresh-stop-profile-maintained-finalize-01 and
  fresh-stop-profile-maintained-qualifier-01/run. The image contains frozen
  candidate 57f79fb9, predating the original Render connection. Its result
  records controlled-components and NOT_ADOPTED; it does not prove production
  dispatch.

  Candidate c1f20476 connects original-process Git/calendar capture to the late
  Render transport and retains cleanup ownership outside the temporary wrapper.
  Native Stop eligibility requires that owner. The four focused owner checks
  exit 0 in 1.779s; real native-main positive and hostile protocol-fixture
  checks exit 0 in 94.958s and 73.815s. Feature-disabled compilation exits0 in
  1.340s. Each supervisor records unchanged source/input pins and no observed
  group residue. The positive fixture emits original-context-complete, records
  originalRenderCaptured=true before request encoding, and retains exactly two
  original-context Git queries before and after Node execution. Its dispatch is
  v1 with nativeStop unsupported: these artifacts establish early capture and
  context replay, not SQL/publication. Hostile artifacts retain identity,
  correlation, overlap, freshness and post-Ready refusals without retry. Earlier
  LF-fixture and obsolete transport-advertisement assertion failures remain
  retained; neither fix relaxes production validation. Raw artifacts live under
  publication-integration/original-render-join-{unit-01,unit-02,main-01,
  main-positive-02,main-hostile-02,feature-off-01}.

  Root owns the fresh committed-image execution and coherent landing.
  html_profile owns the external fresh04 recipe; ambient_stop_domain supplies
  probe02 with explicit source-revision provenance and originalRenderCaptured
  assertion. Neither recipe has executed the production scenario. The next
  decisive check remains original capture through prefix, SQL CLOSED, Render
  binding, semantic reader, durable CONSUMED and release, followed by queued
  selection rejection. Ambient absent-TZ qualification, pre-reservation
  rejection reclamation, actual cleanup/no-replay,
  thirteen-session/four-repository load, Python retirement, supported harness
  adoption and rollback remain open. No parent AC is advanced.

- E351: Reorientation reads all 172 available CAWS turn records for the same
  coordinator and verifies main 120cab3d, clean publication lane 91fc7de9 and
  catalog-merge ancestry. The user's lead transfer supersedes coordination with
  the previous lead; full parity, incremental landings and actual local cutover
  remain the objective. Parent acceptance remains 0/8.

  Fresh production04 exports candidate 91fc7de9 and completes all eleven
  separately supervised preparation, build, package, private installation and
  profile-image stages with exit 0, unchanged source pins and no observed group
  residue. The native build takes 122.807s and produces executable SHA256
  ad8066103e1eac65a0fbd4ee9ee5160ccfc5e00cf81b46fd5f3da81bfbeb679d. Controlled
  qualification compares 30 semantic pairs; the final image contains 5855
  members. Its result remains controlled-components and NOT_ADOPTED. Artifacts
  live under publication-integration/fresh-stop-profile-production-04 and the
  corresponding fresh-stop-profile-04-\*-01 execution directories.

  The actual positive production Stop invocation then FAILS. Probe02 runs with
  --source-revision 91fc7de97f02e820f0ea22b0b61a48f6b6e3e29d, the fresh private
  CLI/image and --mode positive;
  production-stop-04-positive-execution-01/execution.json retains its complete
  argv, exit 1, 48.146s, unchanged source pins and empty observed group residue.
  The native child exits 0 after 30030.857ms, but its output explicitly reports
  Original monotonic deadline expired, prefixComplete=false,
  envelopePublished=false, pointerPublished=false, agentPid=not_run and
  reap=not_run. Exit 0 releases an infrastructure Stop; it is not successful
  publication. The probe rejects that diagnostic. The session contains only
  metadata and the invocation journal; no turn or publication marker exists.
  Source database bytes remain unchanged. cleanup.json observes owner exit 0,
  absent socket, no outstanding originals and no service signals. Raw failure,
  native output and cleanup live in production-stop-04-positive-01; the retained
  production-stop-04-positive-root-inspection-01.json joins these observations.

  Progress records originalRenderCaptured=true, qualified native Stop and an
  actual dispatch grant, but no completed prefix. The dispatch-grant mark at
  20556ms precedes another eligibility validation; it is not the grant-write
  timestamp. Source inspection finds nested full-generation validations in
  selection, profile and SQLite identity checks, with the complete eligibility
  check also used as a repeated prefix checkpoint. This is a source-grounded
  performance hypothesis; individual validation timings remain unmeasured. Root
  owns the next exact-image replay. ambient_stop_domain owns a bounded
  diagnostic proposal; html_profile owns scoped verification consolidation;
  stop_engine_join owns acknowledged cancellation/reclamation using the existing
  journal encoding. These proposals are unexecuted and confer no acceptance.
  Preserve the 30s deadline, full hashes/inventory, selected readsets,
  effect-boundary and postqueue freshness checks. Disconnected negative
  acknowledgements retain their cancellation fence and heavy record; recovery
  remains an obligation.

  The production consumer, queued mutation refusal, ambient environment,
  residency/fairness, Python retirement, supported harnesses and rollback remain
  unverified. The selected machine generation remains 408c06a7…77baa0. No parent
  criterion advances from this failed scenario.

- E352: Request-owned diagnostics count and time completed generation-receipt
  revalidations and Stop-prefix authority callbacks, including refusals. The
  original invocation owns the counters before capture, so a refused capture
  does not discard its measurement. Existing progress emission carries count and
  elapsedMicros only; no payload paths or authority state are added. The initial
  generation load is excluded. Prefix time includes nested generation time, so
  the totals must not be summed. Deadlines, verification predicates and effect
  ordering are unchanged; the instrumentation is not an optimization.

  The first diagnostic filter exits 0 but omits sqlite-store, exercising nine
  selected checks without the production eligibility path. The corrected
  --features sqlite-store diagnostic filter exits 0 in 4.649s with ten selected
  checks, including the four new timing checks and actual linked SQLite
  identity. The generation suite exits 0 in 0.584s with 28 checks covering
  replacement, inventory, modes, original expiry and chunk cancellation.
  Feature-disabled compilation exits 0 in 1.094s. Existing warnings remain in
  stderr; these are not strict-Clippy observations. All supervisors retain
  unchanged source/input pins and no observed group residue. Raw commands and
  logs live under publication-integration/stop-validation-diagnostics-01,
  stop-validation-diagnostics-sqlite-01, stop-validation-generation-01 and
  stop-validation-feature-off-01.

  The retained failed-capture fixture reports engineReads=2,
  receiptRevalidations={count:1,elapsedMicros:186},
  initialSelectionReadExcluded=true and the exact original error "capture
  receipt revalidation refused". Its artifact is
  stop-validation-diagnostics-sqlite-01/generation-artifacts/
  caws-generation-receipt-26245-0/failed-capture-revalidation-diagnostics.json.
  This demonstrates counter retention after a refused receipt in that fixture;
  it does not measure production cost. Root owns a fresh committed-image replay
  under the unchanged 30s deadline. No publication, speedup, residency or parent
  acceptance follows from these diagnostics or checks.

- E353: Fresh production05 builds committed diagnostic candidate 16869077. All
  eleven stages exit 0 with unchanged source pins and no observed group residue;
  native build takes 122.425s. The executable is 7461248 bytes with SHA256
  1c6b80c96387a5af93f99071611100c4a060cc81fa9fe10c42cd2a2921488ce2. Component
  comparison retains 30 equal rows and 31 child exits 0; the final descriptor
  SHA256 is e646455dbf0b106c1bd19e3f1b9ff14b22105d6331b4082cd5619167bc647adc.
  Recipe helpers, tool/reference pins and the positive fixture match
  production04. Source provenance, candidate image and artifact locations
  change; the native deadline remains 30000ms. Artifacts live under
  publication-integration/fresh-stop-profile-production-05 and the eleven
  fresh-stop-profile-05-\*-01 execution directories. This remains a private
  image, not machine adoption.

  The actual positive scenario exits 1 in 47.951s; the native child exits 0 in
  30031.216ms with Original monotonic deadline expired. Its raw progress records
  generationReceiptRevalidations={count:32,elapsedMicros:23325772} and
  stopPrefixAuthorityCallbacks={count:0,elapsedMicros:0}. The generation counter
  includes refused completed calls and excludes initial loading. It measures
  23.326s of receipt revalidation in this invocation, not 32 successful full
  passes or an independent timing distribution. The prefix callback is not
  observed executing; its zero count cannot establish absence of a prefix
  attempt because the wrapper checks the original deadline first. This run has
  no retained prefix-result object. Original Render capture, native eligibility
  and dispatch-written flags are true. The invocation journal contains only
  invocation_started and dispatch_started; no turn or publication marker exists.
  Database bytes remain unchanged. The owner exits 0 naturally, with absent
  socket, empty outstanding originals and no service signals. The outer
  supervisor observes no group residue and unchanged source pins.

  Raw stdout/stderr, terminal and cleanup records live in
  production-stop-05-positive-01; exact argv and exit evidence live in
  production-stop-05-positive-execution-01/execution.json. Root inspection is
  retained in production-stop-05-positive-root-inspection-01.json. The
  production trace establishes generation-timer wiring and the immediate cost,
  but not prefix-timer wiring or successful publication. The initial E352
  nine-test run also predates the final capture-wrapper cleanup; only its
  corrected three checks match all 110 crate source pins to 16869077. The
  selected machine remains 408c06a7…77baa0; parent acceptance remains 0/8.

- E354: Native validation scopes consolidate nested generation scans around
  stock admission, eligibility construction and eligibility revalidation. Full
  hashes, inventory and identity checks bracket two selected-readset sweeps and
  actual profile/linked-SQLite checks. A private borrowed token binds the exact
  generation and original clock; nested validation refuses. No result, including
  Unsupported, returns before closing freshness checks. Standalone
  profile/SQLite APIs preserve their prior full-check behavior. The production
  verifier itself, deadlines, main dispatch checks and prefix effect APIs are
  unchanged.

  The sqlite-store coalesced\_ filter exits 0 in 7.367s with five controls.
  Actual verify_files instrumentation records two full checks around one inner
  call. Retained artifacts reject a late readset change, same-byte inode
  replacement, foreign generation/clock, cancellation, nesting and a mismatched
  expected SQLite sourceId; the linked SQLite observation is retained. Existing
  selection, stock admission, eligibility, profile and SQLite suites exit 0 with
  28/7/2/4/7 checks in 2.962/0.296/0.200/0.205/1.321s. Feature-disabled
  compilation exits 0 in 2.266s. Each supervisor records unchanged source/input
  pins and no observed group residue; compiler warnings remain explicit in
  stderr. Logs and commands live under
  publication-integration/stop-validation-coalesced-01 and
  stop-validation-coalesced-{selection,admission,eligibility,profile,sqlite,
  feature-off}-01. The five selection-coalesced-\*.json files under the first
  run's generation-artifacts retain the actual count and refusal observations.

  These synthetic-generation and linked-library checks do not establish a
  production speedup, complete stock eligibility, late queued freshness or
  publication. Root owns the combined exact-image replay. Prefix callback
  separation must preserve checks before persistent/destructive effects and
  post-engine decisions while keeping cheap cancellation throughout read/write
  loops. Cancellation/reclamation, full residency/fairness, Python retirement,
  harness adoption and rollback remain open. No parent criterion advances.

- E355: Stop prefix execution separates cheap cancellation/original-clock
  checkpoints from full eligible-generation checks. Native main selects the
  explicit dual-callback API. Full authority runs after engine decisions and
  before missing-directory creation, each staging creation, final publication
  rename and each candidate quarantine creation/move/unlink. Held directories
  and owned temporary-FD writes retain cheap checks. Destructive authority runs
  before the existing moved-instance validation. Refusal permits owned temporary
  cleanup, no-replace restoration and empty-quarantine removal; completed
  effects remain facts and cannot authorize replay. Compatibility entrypoints
  retain their original callback points.

  The explicit sqlite-store split_authority run exits 0 in 12.563s with eleven
  controls. Its retained test-artifacts under
  publication-integration/stop-prefix-authority-split-01 include the old target
  bytes after staging refusal, an old pointer beside a completed Stop envelope,
  the restored original PID entry, and a newer shared PID entry beside its
  quarantined original when restoration refuses. Wire split-authority.json
  records show seven full checks and seventeen cheap checks with completed
  envelope/pointer publication; after-envelope refusal reports
  envelopePublished:true, pointerPublished:false, prefixComplete:false and
  fallbackSafe:false. Expiry inside full authority reports the original deadline
  error without creating session files. Fixture result.json identifies the test;
  synthetic original/project authority remains explicit.

  Existing wire/cache/PID filters exit 0 with 36/36/13 tests in
  0.818/0.298/0.343s. Feature-disabled and sqlite-store compilation exit 0 in
  1.626/2.904s. Raw commands, source/input pins, stdout/stderr and empty
  observed group residue are retained in stop-prefix-authority-{wire,cache,pid,
  feature-off,binary}-01. Compiler warnings remain in the raw logs. These checks
  do not establish production callback execution, latency savings, real profile
  admission, SQL acquisition or ordinary publication. Root owns the combined
  exact-image positive and queued/profile mutation controls, followed by
  coherent source landing. Cancellation reclamation, residency, Python
  retirement, harness adoption and rollback remain parent obligations; no AC
  advances.

- E356: The coalesced validation expiry control reaches an inner Ok(None),
  consumes the unchanged original one-second deadline, and observes the exact
  Original monotonic deadline expired refusal instead of compatibility success.
  A fresh control invocation confirms the thread-local guard releases. The
  sqlite-store binary test exits 0 in 6.846s; the retained
  selection-coalesced-expired-inner-none.json records innerCalls:2,
  originalDeadlineUnchanged:true and actualEligibilityConstructed:false.
  Command, raw logs, unchanged source/input pins and empty observed group
  residue live under publication-integration/stop-validation-expired-inner-01.
  This closes the generic scope-expiry question; actual profile/EligibleStop
  construction and production effect timing require the root-owned exact image.

- E357: Fresh production06 builds clean candidate aa2b32f0 with the E354/E355
  optimizations and E356 test. All eleven stages exit 0 with unchanged source
  pins and empty observed group residue; native build takes 121.229s under its
  existing build allowance. The original invocation budget remains 30000ms.
  Frozen manifest SHA256 is
  28ca77f22b6011cb94dfe750b5a9d51ef8c8833549dba87725cac470bf79332d; the
  1222-source pin document is
  c84d1dda2a698957dcaf9f4cc2370c6476e04d3cc5731f62cd0b4977626fbae0. Native
  executable SHA256 is
  64d638e3d046e5f4c0baec61063027de598415423abf2b077454d8c664b3f5b0, completion
  receipt is 7c548a05f356b5b6e869eecafd7c7d95b68aa67dec204623fee881b5e1e12aca,
  profile is 01e259ef99c753dbbabcd6586e5f5fb71395bfb257833c348767ec644adca477,
  and final descriptor is
  afaa7f00fb13482c2b4961492a02b61b396f4b2f437d6b015523fddc0347f1ae. Root reads
  thirty equal component comparisons and thirty-one terminal-zero executions,
  without promoting component scope to whole-runtime acceptance.

  The unchanged positive probe exits 1 in 47.908s. Its actual installed native
  bytes match that build; native exits 2 at 30031.245ms with renderer owner
  deadline expired. Generation receipt revalidation records 29 completed calls
  taking 20972997us; five prefix authority callbacks take 7771723us. These
  totals overlap. The invocation journal records completed prefix, envelope and
  pointer, then completed goal-ac-gate and plan-transcript-finalize handlers;
  session-log reports reconstruction/native-cleanup failure. Owner observations
  record native_stop_postqueue_validated, publication_original_reserved and
  publication_retained, without publication_writer_retained. Failure lies after
  reservation and before writer acquisition returns; the observation cannot
  distinguish immediate deadline refusal, BeforeWriter authority or incomplete
  acquisition. No turn or publication marker exists. The source SQLite bytes
  retain eff667b1cbe750018030f79e81869928011a8265d26b65387eb78aa4d7f0749f.

  This run leaves owner87541 live and its socket present. A read-only correlated
  status request returns transcriptDatabaseOpenAttempts:0, present:true,
  phase:acquiring, retained:true and resident store relay reader closed. The
  durable original operation is unknown after accepted reservation; this is not
  the pre-reservation cancellation case. Root retains its recovery obligation
  and has sent no service signal or journal mutation. Concrete artifacts live in
  production-stop-06-positive-01, production-stop-06-positive-execution-01,
  production-stop-06-retained-status-01.json and
  production-stop-06-positive-root-inspection-01.json. The latter joins
  installed bytes, original deadline, raw diagnostic, actual session files and
  owner state. Prefix callback execution is observed for this exact private
  image. Ordinary consumption, release, production deadline compliance and
  machine adoption fail or remain unverified. Parent acceptance and selected
  machine remain unchanged.

- E358: Main consolidates adjacent predispatch selected-readset and eligible
  checks. EligibleStop already owns that same immutable selected readset and
  brackets profile validation with full generation/local-readset checks; pure
  dispatch encoding follows without an intervening exchange or effect. The
  unsupported stock and custom/inactive paths retain their standalone checks.
  The first combined original_stop_main command exceeds its 110s supervisor
  allowance after the six-case hostile test reports ok and during the positive
  test. Preserve that exit -15, timeout and empty observed residue in
  stop-predispatch-original-01. The separately selected positive test exits 0 in
  94.044s, with six original-capture/compatibility cases, unchanged source/input
  pins and empty observed residue, under stop-predispatch-original-positive-01.
  These fixtures do not construct successful native Stop eligibility; they
  establish the retained fallback behavior only. Root owns fresh exact-image
  execution of the consolidated eligible branch and cannot claim a speedup from
  these tests. Read-only verifier inspection finds hardware SHA256 already
  selected in the fresh06 AArch64 binary; no compiler feature change is
  justified by that evidence. Verification phase costs and retained-operation
  recovery remain root-owned work before another cutover claim.

- E359: Request-owned generation diagnostics separate opening identities, full
  selection verification, closing identities, member hashing and
  inventory/modes. Fixed-size counters retain completed and failed phase calls,
  elapsed time, actual path/FD metadata attempts, hash attempts and bytes
  supplied to SHA256. Initial generation loading, ordinary member lookups and
  resident-owner NativePeer scans remain excluded: these are frontend receipt
  totals. Phase times are inclusive; member hashing includes confinement and
  authenticated reads, so it is not a measurement of compression alone. No
  authority check, cancellation checkpoint, deadline, hash or inventory
  requirement is removed.

  Supervised verification-phase-native-01 executes all31 native_generation
  tests, exit0 in11.321s. Actual success artifact records two passes,2566 hashed
  bytes against1283 expected per pass,20 hash calls,162 path metadata calls
  and40 FD metadata calls. The entry-refusal artifact records one failed opening
  identity phase and unchanged later phases; its metadata control counts two
  actual syscall attempts and excludes pre-call cancellation. The inventory
  mutation records Native runtime mode mismatch: launcher.py after1283 newly
  hashed bytes, with failed inventory and selection phases and no closing sweep.
  Failed-capture diagnostics retain three hash attempts but only687 hashed
  bytes, excluding the engine chunk refused before compression. These synthetic
  artifacts are under verification-phase-native-01/generation-artifacts.
  verification-phase-progress-01 executes the one bounded progress-output test,
  exit0 in0.237s. verification-phase-feature-off-01 checks the feature-disabled
  build, exit0 in3.454s. All source/tool pins remain unchanged and observed
  groups are empty. verification-phase-installed-01 exits0 but selects zero
  tests; it supplies no behavioral coverage. Compiler warnings remain visible in
  raw logs.

  The diagnostics do not establish production cost, a speedup, successful native
  eligibility or publication. Fresh06's live retained owner and durable Unknown
  remain root-owned; process containment must not be described as operation
  recovery. Root must inspect real-image phase measurements before attributing
  the remaining deadline failure and preserve the original30000ms request bound.

- E360: Root contains the owned fresh06 fixture process without settling its
  operation. Live libproc identity matches PID87541, UID501, original start
  1792847592.342745 and the pinned private executable64d638e3; lsof names the
  same executable, fixture outputs, socket and custody locks. A fresh process
  tree/group observation contains only that owner. Root registers a kqueue exit
  observation, rechecks identity and sends SIGTERM to that PID only. The bounded
  script exits0 and observes NOTE_EXIT, absent process identity, no related
  processes, socket connection refused errno61 and an acquirable owner lock.
  Every retained custody file and source SQLite hash remains unchanged. The
  socket pathname and fixture stay preserved; the operation remains accepted /
  Unknown. No journal mutation, consumption acknowledgement or replay occurs.

  production-stop-06-containment-01/execution.json retains before/after
  identity, hashes and observations; before-lsof.txt retains descriptors.
  attempt-01.json preserves the first script's exit1 before signaling: Python
  kqueue lacks the attempted context-manager API. The corrected script closes
  the queue explicitly. Rechecked process identity and kqueue observation bound
  this owned cleanup; they are not an atomic PID-addressed signal primitive or
  proof about arbitrary escaped processes. Process containment removes this
  fixture's live-process hold, not the durable Unknown recovery obligation or
  production failure. A fresh isolated scenario may exercise the changed
  candidate; this retained operation must not be replayed. Root retains the
  missing cooperative quiescence and applicable unknown-write recovery evidence
  through cutover acceptance. E361 clarifies that durable fenced Unknown does
  not require an invented terminal or automatic settlement.

- E361: Fresh07 executes clean57ad2b70 with diagnostics820b8c8f and consolidated
  predispatchb2128e50. Frozen manifest074e8aba and1222-source pins3bbb52f6
  retain the same helpers, tools and unchanged probe02. All11 stages exit0 with
  unchanged TypeScript/native pins and empty observed groups; native build takes
  121.363s under its existing allowance. Native executable is7469328 bytes,
  SHA25614b79473c2c049c7e6c1f69ec0a6fae9a63b1011eef2c281717fbbe463f5e5f0.
  Completion receipt
  isbf325bfa5d4011bf717c7f940721ab9585a3d67144c9b09f1aa5c829e4e1f836; descriptor
  ise935e878b6953df005ef074bfe599928881f5992a3fbd12e7758c19bede16806. Root
  checks30 equal component rows with matching hashes and31 executions with
  exit0, null signal/error. These component observations remain controlled
  scope.

  The unchanged positive probe exits1 in48.459s; original native exits2 at
  30034.183ms without signal/watchdog. Prefix, envelope and pointer complete;
  reservation occurs at27949ms, versus29264ms in fresh06. Neither observation is
  a latency distribution. No turn or publication marker exists. Frontend receipt
  diagnostics record29 calls/20.785528s,29 opening identity phases/0.881139s, 28
  closing phases/0.844515s,29 selection phases/19.059843s,29 member phases/
  15.405265s and28 inventory phases/1.844702s. One member/selection phase fails.
  There are2191685 path metadata attempts,343876 FD metadata attempts,171938
  hash attempts and4566595342 hashed bytes. Times overlap; member time includes
  confinement, metadata and reads, and owner scans are excluded. The result
  prioritizes repeated member verification cost, not a proved SHA bottleneck.

  Correlated status retains original80224-1792850127351838000, zero transcript
  database open attempts, phaseacquiring and a relay/deadline error. Actual
  durable operation01103126 remains accepted/unknown with a matching body
  checksum. The source database remains
  eff667b1cbe750018030f79e81869928011a8265d26b65387eb78aa4d7f0749f. Root
  contains owner80220 using the E360 procedure: exact start1792850127.323678,
  executable/home/descriptor checks, single-PID SIGTERM and kqueue exit; script
  exits0, process/group absent, socket refused61, owner lock acquirable, custody
  and database hashes unchanged. Socket pathname and durable Unknown remain.
  Artifacts: fresh-stop-profile-production-07/root-stage-execution.json,
  production-stop-07-positive-execution-01, production-stop-07-positive-01,
  production-stop-07-retained-status-01.json, production-stop-07-containment-01
  and production-stop-07-positive-root-inspection-01.json.

  Architecture193–207 and277–288 permit durable fenced Unknown across idle exit
  or crash; automatic settlement of every Unknown is not required. Quiescence
  must preserve durable fences and lose no live work. Unknown partial-write
  recovery requires its own evidence only where that recovery is claimed; do not
  invent a terminal to release capacity. Root owns conservative idle retirement
  of resource-free durable Unknown and a measured member-verification repair.
  E359 review checks all110 crate pins and raw artifacts without demonstrating a
  semantic regression; it supplies no acceptance. No production completion,
  native workload fairness, Python retirement or machine adoption is earned.

- E362: Member verification shares one no-follow parent descriptor per
  consecutive native-manifest parent group and one lazy64KiB read buffer. Exact
  patch285ff438 applies to clean4b90c110. Every member retains full hashing,
  named-before/opened-FD/post-read-FD/named-after comparisons and the original
  deadline; each group closes with held-parent and complete root-to-parent
  metadata comparisons before switching groups or returning success. Legacy
  manifests retain their prior traversal. No persistent cache, omitted
  inventory, expanded deadline or parent-descriptor array is introduced.

  Pinned Cargo execution member-reader-native-01 exits0 in12.869s with36 native
  generation checks. member-reader-consumers-01 exits0 in6.897s with180 binary
  checks, including those36 and selection/Stop/SQLite admission consumers.
  member-reader-feature-off-01 compiles without default features, exit0
  in3.308s; it executes no tests. All three retain unchanged source/tool pins
  and empty observed groups. Compiler warnings remain; these are not strict
  Clippy results. Raw commands, logs and fixture trees live under
  publication-integration with those labels. Standalone fixture77362-23 hashes
  exactly131872 expected bytes across10 calls, allocates one scratch buffer and
  closes the parent FD. Fixture18 completes all8 member hashes then rejects a
  replaced/restored ancestor before inventory, with the leaf unchanged and no
  outer GenerationReceipt. Fixture24 refuses before reading the next group;
  fixtures19/20 retain cancellation and original-expiry refusals with closed
  FDs; fixtures21/22 reject parent symlink and file replacement. These are
  synthetic filesystem controls, not installed performance or publication proof.
  The fresh07 inventory predicts38991 fewer metadata operations per successful
  pass; elapsed benefit remains unmeasured.

  The separate idle-retirement proposal remains unapplied: source review finds
  repeated non-demand probes can reset the actor's relative idle wait and starve
  warm-backend retirement. Root owns the correction, repeated-probe and
  multi-actor-abort checks, committed-candidate review and fresh-image
  execution. The baseline owner suite exits0 with27 checks in1.113s under
  idle-retirement-owner-baseline-01; it does not exercise the proposed barrier.
  Parent acceptance, production completion and machine selection are unchanged.

- E363: Resource-free idle retirement uses one serialized actor/registry
  barrier. Actors refuse pending work, live backend/writer custody, queued
  effects and any fence other than exact durable Unknown. Retained native
  originals must match their anchored request bytes, identity and registration;
  actor and registry record sets agree before commit. Committed actors exit
  without settling Unknown; the listener drains finished actors before releasing
  owner custody. Absolute actor idle expiry prevents non-demand probes from
  postponing ordinary warm-backend cleanup. Unsupported retained SQL/project
  resources remain quarantined; this change grants no automatic recovery.

  Pinned Cargo idle-retirement-coordinator-01 exits0 in5.794s. Its actual
  coordinator first refuses a held writer FD, then commits after the test
  releases that resource. The actor drops its heavy record and shared operation
  permit. unknown-before.json and unknown-after.json are byte-identical,
  SHAb5adbeab2c544206056fca3b4329c72ee2820f4cf46df14507f75dc5cecf6069; source
  database bytes are unchanged. coordinator-stages.jsonl records refusal, commit
  and actor completion. This controlled native-shaped original does not execute
  actual native admission or reproduce the production timeout producer.

  idle-retirement-warm-native-01 explicitly runs the ignored warm control, exit0
  in4.226s. A standalone Rust test child occupies the worker's existing
  compatibility launch seam; .py-named files are inert markers, no interpreter
  executes. Real worker34758/backend34759 produce cleanup with direct-child
  reap, both output EOFs and worker exit0. Eleven probes include ten resource
  refusals; budget0 and writer-lock reacquisition precede mailbox closure at
  about1.09s. Temporary probe-triggered timer renewal makes the same check fail:
  idle-retirement-warm-timer-mutant-01 Cargo101/10.028s retains38 refusals
  through 4.04s and the specific starvation assertion, followed by owned
  cleanup. Exact candidate bytes are restored; idle-retirement-warm-restored-01
  exits0 in6.859s with worker44226/backend44227 cleanup and eleven probes. These
  controls exercise lifecycle, not renderer semantics or full image admission.

  idle-retirement-store-final-01 exits0 in5.440s with25 executed checks and two
  ignored cases; the warm case's explicit executions above are separate.
  idle-retirement-host-final-01 exits0 in4.266s and records two natural host
  exits, unchanged Unknown and restart fencing. It seeds the journal without a
  heavy StoreRecord and cannot alone qualify E361's failure path. Earlier
  idle-retirement-owner-regression-01 and idle-retirement-journal-01 exit0 with
  30 actor/coordinator and42 journal checks. Feature-off compilation exits0 in
  idle-retirement-feature-off-01; compiler warnings remain. Retained execution
  receipts and stdout/stderr under publication-integration establish commands,
  before/after source/tool pins and empty observed groups for these runs.

  The superseded Python-bearing warm command was refused before execution by the
  installed foreign-repository write guard. No runtime/guard override or
  alternate execution of that command occurred. The native-only fixture is a
  changed test dependency. Root owns committed-candidate review, fresh08 exact
  image execution and the original30s publication/ordinary-consumption/release
  chain. No parent criterion or production Python row is completed by E363.

- E364: Fresh08 freezes clean106c94f9583317d652801c2e131fbc48a86ad041, including
  E362 traversal reuse and E363 idle retirement. Independent read-only review
  finds no demonstrated idle regression; root grounds listener admission,
  connection-permit lifetime and one-way barrier decisions against source. Final
  coordinator/warm/restored/store/host receipts match all112 crate files;
  earlier regression receipts differ only in subsequent test changes. Gates pass
  all five configured checks over151 branch/staged paths; doctor reports
  0E/4W/5I. These do not supply parent acceptance.

  fresh-stop-profile-production-08 retains1224 source blobs/modes, manifest
  SHAbf6df2be52b86e3a0a5aaf774c051d6c755fa7552fbcfe4c5b5d550abd2bc4c8 and
  archiveSHA25cb70fdff1bb5e80784525a16f5f96bcfe6a08ce616f7b2261e2fe727102da1.
  All eleven stages exit0 with unchanged TypeScript/native pins and empty
  observed groups. Native build takes121.611s. Qualification retains30 equal
  reference/candidate comparisons and31 execution receipts with exit0. The final
  profile-bearing
  descriptorSHA98a9fe0a6afeaea9795ca6c338a902591d696cca2ac230ce235c212335ffe72c
  retains timeout30000ms. A root receipt-printing attempt used the wrong
  completion-reference key and failed before inspection; corrected read verifies
  the actual path/size/SHA. No runtime retry follows that reporting error.

  The unchanged probe02 positive scenario exits1 in43.230s under
  production-stop-08-positive-execution-01. Actual native47657 exits2
  in25154.698ms, without watchdog or signal, at
  `Selection dependency changed: exists` for the fixture project/.caws. All29
  frontend generation verifications complete; their aggregate time is16.432s,
  member phase10.956s and path metadata count 1056615. These are one failed
  run's overlapping phase observations, not a workload speedup distribution or
  complete end-to-end result.

  Owner47656 records postqueue validation23295ms, original reservation23308ms
  and retained uncertainty25145ms. Writer bootstrap creates the zero-byte
  .render-writer-provisioned marker and .render-writer-custody directory; their
  timestamps coincide with changed .caws directory metadata. Native Exists
  retains full leaf/followed stamps although the typed selector consumes boolean
  presence plus separate confinement identity. Root owns a bounded
  present-directory Exists projection repair and paired authority falsifiers;
  explicit stat/list/content, absence and identity checks must remain strict.

  The actual failure path naturally exits the owner at26188ms, exit0, with no
  service signals; socket is absent, ps-p47656 returns1/no row and the custody
  lock is acquirable. The accepted Unknown checksum verifies and remains fenced.
  No turn-001.json or publication marker exists. Source database hash remains
  eff667b1cbe750018030f79e81869928011a8265d26b65387eb78aa4d7f0749f; unchanged
  bytes do not prove no reads, and no post-exit owner RPC counter was collected.
  Root inspection is production-stop-08-positive-root-inspection-01.json,
  SHAe6b0ebda97c4abf33ef5b5f0bf122929b6bbb51026519c586530999e9514a753. Preserve
  this fixture's partial writer provisioning and Unknown; do not replay or reset
  it. Successful publication, ordinary consumption, fairness and
  selected-machine adoption remain open.

- E365: Present-directory Exists retains explicit native device/inode/type/mode/
  uid/gid in both lexical and followed evidence. Directory child
  size/timestamps/ link count are not existence dependencies. Symlink leaves
  retain full stamps, followed directory identity and resolved/lexical anchors.
  File Exists, absence/errors, explicit stat/lstat/list/read and generation
  verification keep their prior dependencies. The wire reply remains boolean; no
  receipt refresh, callback removal, deadline extension or path-specific
  exception is introduced.

  The tests-first exists-writer-baseline-01 command executes actual public
  writer acquisition against the original native receipt and exits101 in5.806s:
  `Selection dependency changed: exists`, effectCount0. Its retained
  selection-exists-directory-writer-bootstrap.json shows identical parent
  identity, changed full metadata and actual writer marker/custody files.
  exists-directory-final-01 exits0 with33 selection cases in8.946s; fixture23's
  artifact records sameParentIdentity:true, fullMetadataChanged:true,
  error:null, effectCount1 and a caws.render.writer.provisioned.v1 marker.
  Twelve hostile artifacts retain effectCount0 for replacement, disappearance,
  POSIX mode, symlink/file substitution, absence appearance, strict
  metadata/inventory, changed policy, negative child and regular-file Exists.
  The symlink-target artifact retains one earlier child-churn effect and no
  second effect after target replacement.

  exists-directory-identity-mutant-01 replaces followed directory UID with0 and
  exits101 in3.870s at the exact identity assertion (actual0, expected501), not
  compilation. The original file
  SHA6d54917f3932cb0d881607ae3089813f484b9c3058035c034c4f1d87e4bfa5b5 is
  restored exactly. exists-directory-bin-restored-01 exits0 with184 binary cases
  in8.302s; exists-directory-feature-off-01 exits0 in1.929s and executes no
  tests. Both final receipts match all112 current crate files; every attempt
  retains unchanged source/tool pins and empty observed process groups. Raw
  execution.json, stdout/stderr and generation-artifacts remain under the named
  publication-integration directories. Compiler dead-code warnings remain.

  Public writer acquisition followed by original-receipt validation is a bounded
  component seam, not the installed WriterLocked callback join. Fresh09 must
  qualify the clean combined candidate and exercise the unchanged probe02 with
  its original30000ms deadline in a new fixture. Preserve fresh08's partial
  provisioning and fenced Unknown. Publication, ordinary consumption/release,
  resident fairness and selected-machine adoption remain unverified; no parent
  criterion or Python-retirement row is completed by this repair.

- E366: Fresh09 freezes clean ec496156f2f93c4ee6be97d5fdbcb0b80e712fb5.
  Same-provider committed review finds no demonstrated directory-identity
  defect; root grounds the operation dispatch and consumer requirements.
  Identity claims cover mode/uid/gid, not untested ACL behavior. The broader
  exists-directory-landing-lib-01 run exits0 with443 cases and2 ignored
  in55.840s; ignored cases require explicit warm-backend and prepared-image
  environments. This is not an executed fairness or installed-upgrade check.

  Manifest SHA78ff5d8298834ce02a0b004e919d45131ed1f67d8dcdb1ba1795a7da9544dcda
  binds1224 source blobs/modes. All eleven image stages exit0 with unchanged
  TypeScript/native pins and empty observed process groups. Native build takes
  123.769s. Root compares all30 actual reference/candidate documents; the
  profile remains controlled-components with explicit remaining joins.
  Descriptor SHA59a6da2bef8ab3261ba2c6524f03b3979db119073cd4a5b5cbd0195e991629f6
  retains timeout30000ms; build completion
  SHAffcebf443d2d249339921d68ceec36596832000d54642553dcc7d644dcebf5de is
  verified. No machine adoption follows these checks.

  production-stop-09-positive-execution-01 exits1 in48.238s. Native12093 exits2
  in30043.687ms at the original owner deadline, without watchdog or signal.
  All36 frontend generation verifications complete in20.297s cumulatively and
  hash5843839932 bytes. Member verification takes13.562s inclusively; it
  includes confinement/metadata/reads and does not measure hashing alone.
  Owner-side verification is outside these counters. No performance distribution
  is claimed.

  Actual owner12092 observes postqueue validation23396ms, original reservation
  23409ms, writer retention27178ms and SQL CLOSED28480ms. Artifact writes
  produce session-index.json, store-projection.jsonl and turn-001.json,
  including the expected user/reply and original retained context. No
  .session-publication.json exists; no marker-committed, consumed-durable or
  heavy-release stage exists. These are uncertain partial outputs, not a
  committed publication. The actual installed writer boundary passes E364's
  self-invalidation point.

  One bounded observational status request, with unchanged before/after process
  identity, returns openAttempts1 from baseline0, two copied/delivered rows,
  exhausted acquisition and successful unregister/finalize/rollback/close. It
  retains the publication with Original monotonic deadline expired. The status
  phase named settled refers to acquisition; it does not establish publication
  release. The query briefly contributes active demand and is not polled.
  production-stop-09-status-01.json retains the raw frame and response. Root
  inspection production-stop-09-positive-root-inspection-01.json,
  SHA889f9ea52560bbc3aa4023aeeba6803d364391500de376f51e108bdb88f4fb5c, confirms
  both custody locks held and the accepted Unknown body checksum
  2b8a6f0c4801b08828806d22c7805f666cb0b198660351c399fb699fd4d6179b. Database
  bytes retain
  SHAeff667b1cbe750018030f79e81869928011a8265d26b65387eb78aa4d7f0749f.

  External exact-instance containment executes once in0.278s, exit0. libproc
  captures birth1792857014.445430, uid501, pgid11544 and the exact image; lsof
  verifies both held custody locks, and kqueue subscribes before the sole
  SIGTERM to12092. The exit event, libproc absence, empty related census,
  refused socket and reacquirable machine/writer locks are retained under
  production-stop-09-containment-proposal-01/run. All31 inventory entries remain
  equal, including both custody trees, partial session files, provisioning
  marker, policy, config, pointer and database. Publication marker remains
  absent; the stale refused socket path is preserved. Receipt
  SHAaf4cad984a2e9d715ef0547fed794225e41682bbe6e304946b152667e3911f3e and fresh
  ps exit1/no row corroborate absence. This is external containment, not
  production cleanup, parent-wait reaping, recovery, settlement or replay proof.
  A worker's shell authoring attempt was refused before execution because its
  interpreter-path text was classified as a foreign-repository write. Root used
  a direct file edit confined to the external artifact directory; no guard,
  identity or interpreter file was changed. The rejected attempt is not a run.

  The bounded source delivery uses a separate main-based lane under
  CAWS-NATIVE-STOP-SOURCE-LANDING-001. Direct teardown of
  native-runtime-modernization would delete a base ref used by five foreign
  lanes: --no-close preserves its spec, not its branch. E367 records the
  separate landing while preserving those lanes, source references and selected
  machine pointer. Source acceptance does not satisfy the failed production
  outcome or either active parent obligation.

- E367: Local main merge89946c2d lands reviewed source checkpoint4909cdc4.
  Direct Git comparison establishes identical implementation/test blobs to
  ec496156/c04dee5b; only governance and the reconciled tracker differ. All112
  native source pins match the retained bin184pass/lib443pass2ignored and
  feature-off compilation receipts. Of1224 packaged source pins, only the
  tracker differs. These are exact-source retained checks, not fresh execution
  on main. Fresh09 remains failed with partial publication and no marker.
  source-landing-composition-01 retains the full30-commit, nontruncated scope
  review, dry-run, actual merge, identity comparisons and postmerge state.
  Scoped gates pass allfive checks over46paths; doctor exits0 with0E/4W/5I. The
  commit hook ignores TypeScript ESLint for lack of matching configuration; its
  successful exit is not lint proof. Same-provider committed composition review
  finds no demonstrated implementation divergence within its read-only scope.
  Root verifies the original effect deadline/cancellation handles before relying
  on that observation.

  Postmerge comparison retains all11 pre-existing registry entries, physical
  lanes and their branch tips; non-main dependent base refs, parent/publication
  spec bytes and selected machine pointer remain unchanged. Only the disposable
  landing lane is removed. A1-A3 are recorded and read back in
  events12982-12984; event12985 closes only CAWS-NATIVE-STOP-SOURCE-LANDING-001
  and12986 releases its temporary bridge. The first absolute artifact-path
  citation is refused without a write. Supported citations verify commit
  reachability and explicitly retain direct inspection of external artifacts;
  CLI verification does not execute the cited historical tests. Canonical
  closure commitc93082ee is integrated into the continuing root-owned
  publication lane by fast-forward. Full publication, consumption/release,
  residency, first-party Python retirement, harness adoption and rollback remain
  open.

- E368: Two fixed diagnostic phases distinguish manifest authentication from
  allowed-directory derivation in installed-generation verification. Phase
  wrappers preserve the existing verification call order and checkpoints; their
  counters do not authorize effects. manifest-plan-phases-01 exits0 after a
  fresh130.365s release build and executes three focused controls. Actual
  synthetic artifacts record270 checkpoints with and without diagnostics,
  authentication cancellation before any hashed bytes, and plan cancellation
  after three plan checkpoints with678 manifest bytes hashed and no member or
  inventory phase entered. Initial-load and member-lookup accounting remains
  excluded from receipt revalidation diagnostics.

  manifest-plan-actual-image-01 exits0 and reads the actual5971-member fresh09
  image; three passes each perform5973 hashes over162328887 bytes. Its no-op
  callback and regular stdout omit production's original-clock, parent and
  pipe-liveness checks, so its15.894-16.285ms plan measurements cannot choose a
  production optimization. The raw deficient probe and exact supervisor source
  remain retained. Source inspection identifies the actual callback sequence:
  original monotonic deadline check, cancellation signal/parent/stdout check,
  original deadline check, followed by the verifier's local expiry check.

  manifest-plan-actual-image-02 installs the actual cancellation handlers in an
  isolated ignored test, requires pipe stdout and uses that callback sequence
  under one captured30s original deadline for the initial load and three passes.
  It exits0 in58.564s including incremental release compilation. Per-pass total
  Selection times are556328/559120/558215us; directory derivation is
  71791/72846/72573us, manifest authentication628/565/594us, member verification
  411473/412425/411758us and inventory72414/73258/73265us. Every pass retains
  5973hashes/162328887bytes and the same original expiry. Before/after full
  image hashes/modes, native source and pinned build inputs agree; the
  supervisor reports no remaining process group members. Its artifacts are
  actual-image-plan-initial.json, three pass JSONs, summary and execution
  receipt in the root's publication-integration directory.

  These warmed, standalone Selection samples include libtest representation and
  a source-matched callback chain. They do not measure receipt identity sweeps,
  owner-side scans, complete publication latency or a cold/concurrent
  distribution. Root owns a bounded reuse of immutable manifest-derived
  directory data, contingent on preserving fresh manifest authentication, all
  member hashes/identity checks and complete live inventory/mode verification.
  No successful filesystem observation becomes cached authority; no runtime
  speedup or production completion is claimed by the probe. The complete native
  binary suite in manifest-plan-bin-01 exits0 in5.705s with187pass/1ignored; the
  ignored actual-image probe has its separate explicit execution above. This
  includes the fixed diagnostic serialization and existing integrity/refusal
  controls, not library/integration suites or an installed invocation.

- E369: Selection retains only the allowed-directory set derived from its
  authenticated immutable manifest. Initial construction remains under the
  original expiry and cancellation callback, before full member verification.
  Revalidation authenticates the live manifest and repeats every member hash,
  traversal/identity check and actual inventory/mode walk. No successful
  filesystem observation becomes cached authority. Reused passes remove the
  obsolete derivation loop and its checkpoints, not the surrounding authority
  boundaries or actual I/O checkpoints; directory-plan diagnostics report zero.

  manifest-plan-cache-bin-01 exits0 with187pass/1ignored in112.957s including
  release compilation. The first formatting invocation used edition2021; the
  crate declares2024. Final formatting restores unrelated layout before the
  subsequent actual-image and mutation checks. Initial-construction cancellation
  records no returned Selection, one failed plan phase, no member/inventory
  entry and unchanged expiry. Direct retained-Selection controls reject a
  changed live manifest before member hashing and reject an undeclared empty
  directory after all10 fixture hashes over1283 bytes. These direct controls
  cannot pass solely through an outer receipt identity sweep.

  manifest-plan-actual-image-03 exits0 in58.887s including release compilation.
  The unchanged actual5971-member image and callback/pipe probe retain5973
  hashes over162328887 bytes in each pass. Selection elapsed times are
  467261/468819/470795us, versus E368's556328/559120/558215us. Every reused
  directory-plan phase is zero; member and inventory phases still execute. Full
  image hashes/modes and source/tool pins agree before/after. This is a warmed
  standalone comparison, not a production latency distribution or proof that
  publication fits the original30s deadline.

  manifest-plan-empty-directory-mutant-01 disables the actual inventory
  membership predicate and exits101 after105.720s: the direct revalidation
  returns Ok instead of the required undeclared-directory error. Its retained
  fixture and logs establish sensitivity to this specific fault, not a mutation
  score. The original installed_generation.rs SHA
  db9f65d0a2fb073c2cbc93c67f62393af987c81a274b3364030af8cce0b5abcf is restored
  exactly. manifest-plan-cache-restored-bin-01 exits0 in112.569s including
  compilation with187pass/1ignored, unchanged source/tool pins and empty
  observed process group. The explicit image probe above covers the ignored
  test. Doctor exits0 with0E/4W/5I; these checks do not execute library or
  installed integration suites. Root owns committed-candidate review and fresh10
  package execution through publication, ordinary CONSUMED and heavy release. No
  parent criterion or production Python row is completed.

These additions retain33/37 qualifying partial rows,0/8 parent acceptance and
zero complete production Python retirements. Root owns ledger publication to
main, parent evidence updates and integration of each remaining consumer.

The terminal bridge's CLI build, six focused suites (118 checks), Rust library,
binary and executable suites (29/13/23 checks), strict Clippy and scoped lint
exit 0. Raw logs and retained native fixtures live under
`packages/caws-native/target/qualification/terminal-bridge-2026-10-19/`. The
historical broader `npm run typecheck` exits 2 at the unchanged
`tests/kernel/telemetry-turn-log-schema.test.ts:237` access to `usage.required`;
neither that test nor its imported schema differs from `90fac044`. This is not a
green package-wide check. E151 reproduces and repairs that exact test defect;
E154 observes fresh parent compilation. E55 carries the separate large-latch
producer/consumer evidence.

Reorientation against all available session turn records retains the original
whole-application scope, the thirteen-session/four-repository requirement and
the user's containment and Sterling-inversions corrections. Image-only/null turn
fragments did not cancel those obligations; A8 and R28/R31 carry them. Reachable
lane commits establish committed work, not delivery on main. Demand-start
residency, native workload/performance qualification, renderer migration,
first-party Python retirement, packaged adoption and rollback remain open. The
machine pointer remains on `408c06a7…77baa0`; no speedup or replacement of the
active hook pipeline has been demonstrated.

E69 qualifies known engine/pipe-holder cleanup after intentional caller death in
a disposable protocol fixture with an independently surviving native-child
owner. Its retained success and cleanup-suppression failure support that bounded
claim; they do not establish production-dispatcher cleanup or universal
descendant reap. A later replay holds containment after ancestor-capture expiry,
so reliability remains unresolved despite a green complete native run. The
native terminal-effect owner must preserve ordinary cancellation, output/audit
custody and bounded finalization together. A signal-accepted record alone cannot
claim termination, and the legacy refusal's unconditional process-end wording is
not an observation that the target exited.

## Embedded and developer implementation coverage

The executable embedded-Python surface is 15 shell files, 19 inline bodies and
seven external callsites. A textual `python` hit is not sufficient: seven
broader search matches contain only comments or interpreter-recognition data.
Line anchors below refer to the integration source tree `10690d4b`.

| Group / source sites                                                                                                                                           | Destination and decisive proof                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/runtime-paths.sh:58`; shared/Codex/Kimi `lib/parse-input.sh`                                                                                           | Typed input normalization: raw controls/NUL/surrogate handling, shell-safe assignments, Codex multi-file patch first-action mode, Kimi fallback precedence and large-input transport                            |
| `shared/lib/caws-state.sh:211`                                                                                                                                 | Checked path normalization/refusal contract: existing symlink ancestor with missing leaf and `/tmp` alias; retained legacy helper removal and final native port require consumer qualification                  |
| `shared/lib/agent-surface.sh:520`, `shared/lib/run-handlers.sh:598`                                                                                            | Typed selection: malformed/absent override maps, custom paths and concurrent request environment isolation                                                                                                      |
| `shared/lib/parse-input.sh:355,372,449`, `shared/lib/agent-pid.sh:162`, `shared/lib/session-cache.sh:29`                                                       | Native anchored filesystem + typed identity/cache: dir-relative no-follow writes, exclusive temp0600/rename, symlink races, unsafe IDs, original created_at, partial writes, PID reuse and retention boundaries |
| `shared/lib/reprieve.sh:194`                                                                                                                                   | Owning reprieve reader: handler/session/repo scope, legacy null repo reach, revoke-key presence, naive-UTC/offset/equal-expiry and symlink ancestry                                                             |
| `shared/goal-ac-gate.sh:192,209,244`                                                                                                                           | Typed verify-acs consumer: no binding, malformed/empty report, all verified, not-rederived, non-dict criteria and bounded infrastructure release; do not rederive authority                                     |
| `shared/lib/run-handlers.sh:94,371`                                                                                                                            | Typed journal/supervisor: selected identity, start/result, short append/symlink failures, failed provenance independent of guard outcome                                                                        |
| External calls in `shared/block-dangerous.sh`, `shared/session-log.sh`, `shared/hook-utilities.sh`, `shared/lib/guard-config.sh`, `shared/lib/run-handlers.sh` | Classifier, renderer/store, utility, config and truncation modules tracked separately in R05-R18; consumers must migrate with tests                                                                             |

Remaining developer paths: `scripts/hook-experiments/` files
`qualify-render-daemon.py`, `qualify-transcript-cache.py` and
`source_freshness.py`. Retained qualification tools remain obligations, not
historical exemptions inferred from their directory name. The other original
developer paths are absent from `main` and the integration source: `8e56cee2`
removes `scripts/calculate-rule-tokens.py`; `8ce627ca` removes
`scripts/hook-harvest.py` and `scripts/hook-harvest.test.py`; `098dc1f4` removes
`scripts/hook-experiments/sensitivity.py`; and `d147dd3e` removes
`scripts/hook-experiments/replay-terminal-corpus.py` and
`scripts/hook-experiments/test_replay_boundary.py`.

The native component's post-start transport failure is conservatively uncertain
and refuses; bounded Stop transport recovery is unresolved. It must not become
the installed hook entry before that obligation is resolved. Its handled timeout
cleanup does not establish cleanup after SIGKILL or abrupt client termination.

Sterling has a project-owned Python renderer daemon selected through the machine
project handler override, independent of the stock shared runtime. Its warm
renderer, per-transcript verified-prefix parse checkpoints, unchanged-request
shortcut, synchronous fallback and idle exit are compatibility observations for
R18/R25, not proof that the stock runtime has those features. The observed
daemon lease recorded active use; current speedup was not benchmarked. Preserve
its override boundary and incremental parsing semantics during stock
replacement; do not claim first-party retirement removes foreign project
implementations.

Generated benchmark logs and raw test artifacts belong in ignored storage.
Source commits and spec evidence refer to their actual checked revision and
command.

## Acceptance ledger

| Spec criterion | State       | Required proof                                                                                                                                                                        |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1             | in progress | Complete source/embedded/tooling feature inventory with destination, dependency, status and maintained evidence                                                                       |
| A2             | fail        | Canonical evidence retains the failed installed invocation; fresh compiled native client through actual typed engine must establish decisions and refusal/context/provenance parity   |
| A3             | unchecked   | Lifecycle, isolation, freshness, concurrent start, cancellation, restart and uncertain-outcome hostile tests                                                                          |
| A4             | unchecked   | Production/dev Python consumers replaced; package/source scans plus no-Python execution; classified foreign/historical material                                                       |
| A5             | unchecked   | Supported harness and extension behavior through installed/native acceptance observations                                                                                             |
| A6             | unchecked   | Declared reproducible baseline/candidate workload with distributions, process counts and overload correctness                                                                         |
| A7             | unchecked   | Artifact target identity, clean install, trust, upgrade, rollback and documentation proofs                                                                                            |
| A8             | unchecked   | Thirteen sessions across four repositories; fair admission, cross-project/session isolation, owner-specific ordering, independent enforcement capacity, overload and upgrade behavior |

Only `caws specs evidence` records authoritative verdicts. This ledger explains
progress and does not replace that transaction or its event readback.

## Ordered next work

The lead integrates three outcomes. The immediate assignments below precede the
detailed retained dependency list; completing a bounded assignment does not
complete its parent outcome.

E357 establishes actual prefix completion followed by expiry after original
reservation. Root owns verification-cost reduction, the retained owner's
recovery and another unchanged positive scenario before queued
mutation/reclamation and residency work. E358 consolidates adjacent predispatch
checks; E366 retains the later production execution and its failed deadline. The
coherent source checkpoint can land with its hostile controls and explicit
failed-runtime evidence. Build/profile success cannot qualify it as a usable
runtime replacement. E359 supplies tested frontend phase instrumentation.
E360/E361 contain both retained fixture processes while preserving Unknown.
Fresh07 measures repeated member verification as the largest observed frontend
phase and fails the original deadline. Root owns that cost repair and
conservative idle retirement of resource-free durable Unknown. Preserve fenced
uncertainty; automatic settlement of every Unknown is not a requirement.

E362 implements bounded member traversal reuse with hostile filesystem and
consumer checks; committed-candidate review finds no demonstrated regression
within that inspected scope. E363 integrates resource-free Unknown retirement
and tests probe starvation with a failing mutation and restored positive
control. E364's fresh08 producer reaches natural resource-free owner exit while
preserving Unknown, but first writer provisioning invalidates the .caws
directory Exists dependency before publication. Root owns an operation-specific
native directory existence repair, strict authority falsifiers and a new
exact-image replay. E365 supplies the repair, failing baseline, ownership-loss
mutation and restored controls. E366's fresh09 passes actual writer retention
and SQL close but expires during publication with partial files and no marker.
Its private owner is externally contained while uncertainty remains intact. Root
owns the deadline cost repair; E367 lands the coherent source checkpoint. E368
measures manifest-plan construction with the production callback chain, and E369
reuses only immutable manifest-derived directories with direct hostile controls.
Root owns final review and fresh10 exact-image execution; do not cache
successful filesystem/hash observations or remove authority and durability
checks. The successful path must establish publication, ordinary consumption and
release within30s; neither natural failure cleanup nor build/profile success
supplies it.

| Integrated outcome                                                                   | Execution owner                                                                                                                                                                                                                                                                          | Next decisive check                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coherent source and package delivery, isolated invocation and rollback               | Root owns combined landing, package qualification and installed-image join; E298 records hosted main success                                                                                                                                                                             | E341/E342 stock admission is on local main56f917d8. Next qualify the production-connected image, actual harness delivery and rollback; the maintained entry observation establishes stock admission plus compatibility completion.                  |
| Native acquisition, continuous-custody publication, ordinary consumption and release | Root owns ordinary Stop integration and acceptance; E343 connects the native source catalog to its consumer; E344 adds original/queue registration; E345 adds the profile producer/loader component; E346 connects native and engine production sources; root owns fresh-image execution | Execute the fresh exact image through original capture, completed prefix, SQL CLOSED, publication, ordinary reader, CONSUMED and release; pair with queued selection mutation and zero transcript-database open attempts on the same isolated owner |
| Resident operation with fair, bounded capacity                                       | Root owns integration and execution; html-profile's timing investigation feeds E304; uncertain-A/A2/B bounded progress is executed in the publication lane                                                                                                                               | Qualify the exact combined image and ordinary consumer; E305 retains bounded uncertain-A/A2/B evidence; then mandatory-guard capacity and unchanged thirteen-session/four-repository fairness, overload, restart and upgrade workload               |

The E273 image and rejected-replay repairs have finite executed controls. E275
publishes the coherent source slice; E276 repairs a hosted packaging defect. The
E280 bounded fifth warm probe completes, retaining earlier failed attempts and
source-grounded oracle/input corrections. E282 demonstrates sequential
reclamation across 258 originals on one owner; it does not establish concurrent
admission or fairness. E346 connects the SQL adapter to native observation
inputs and profile selectors in the owned source candidate. E366 records actual
combined-image execution through partial publication, with successful ordinary
consumption and release unverified. Candidate `29555bc8` builds successfully in
`publication-integration/source-publication-build-01` (exit 0, 6.660s);
`source-publication-tests-01` executes 113 checks across the publication
adapter, store client, warm-owner qualifier and CI archive contract (exit 0,
3.789s). Raw logs and stable before/after source pins are retained;
`source-publication-inputs-01/execution.json` additionally pins the fresh
compiled distribution, workflow and archive test. These checks do not qualify a
combined native image or deployed callbacks. Package adoption, Python retirement
and machine cutover acceptance remain open.

1. Refresh complete source/build/dependency identities after E188, including
   both the engine and the selected CLI entry. The CLI entry imports commander
   and chalk outside E187's seven engine package roots; the qualifier requires
   it separately. Classify filesystem/codegen/import and
   PATH/Python/native-image boundaries before adopting expected identities. A
   reachable graph or runtime digest cannot replace complete recursive trees.
2. Qualify the implemented E186 anchored cache prefix and downstream consumer
   under the complete stock chain, including early protective return,
   cancellation and independently observed cleanup. The finite native cases and
   E177's earlier cleanup do not establish this combined result. Preserve
   original supplied-session identity without borrowing later parser effects.
3. Resolve the E185 guard/effect boundary with the existing shell-analysis
   owner, which explicitly accepts the unfinished repair in E213. E220 replaces
   the earlier A6 FAIL with scoped private-package PASS; E224's completed
   subset-quality failure and missing full-topology result, reserved source and
   trusted-launch dependencies remain obligations. Acceptance of the handoff
   does not close the hold. Keep the refused CLI inventory unexecuted pending a
   supported resolution; do not infer an attempted foreign write from the
   refusal alone. E224 discharges root's finite report inspection and records
   accepted source-owner repair; native A5/A7 integration obligations remain
   open. Include the four accepted documentation surfaces in that landing:
   `hook-pack-shared-core.md`, `hook-packs.md`, `README.md` and the existing
   guard-lineage `command-analysis.md`. E230 records the committed and reviewed
   four-file candidate; coherent source landing remains required. Their contract
   must distinguish actual execution metadata, mandatory write guard versus
   optional pin guard, command-specific exits, the full three-suite/six-file
   verification scope, proposed executor custody and unqualified native
   adoption.
4. E207 implements the reviewed-prefix coordinator, exclusive fresh Cargo
   target, embedded-member checks and four direct build/consumer integrations.
   E209 qualifies one frozen current-host release build; ordinary consumer
   workloads and later source changes remain unqualified. Retain UNADMITTED
   Rust-extra provenance and the open full toolchain/SDK boundary. E211
   implements bounded native fixed-query acquisition, row/UTC transport,
   store-AST reconstruction and event encoding through a native entry fixture.
   E212 repairs the source-grounded error/cleanup custody gap from candidate
   inspection and retains exact candidate checks. E216 binds store operations to
   original invocation observations and exercises actual foreign root/digest
   agreement refusal. Complete anchored root custody and path-profile
   qualification remain open. E217 prevents its unbound store failures from
   charging engine-selected project budget state while retaining established
   context on bound failures. Other Ready consumers need complete original
   context qualification. E218 carries recognized oversize and early transport
   refusals without a budget namespace bypass. E226 lands the pinned-profile
   year-addition extension and compares all25 former exclusions without
   rewriting historical observations. E235 integrates the canonical timestamp
   mutation registration and finite public export consumers at `ff3c6180`; full
   six-source/nine-test store mutation execution and per-file quality remain
   open. Chat `01a157bd-8bb6-7fc1-9322-6120a73b5a72` prepares that private
   qualification from the ordinary package runner; root allocates two stable
   workers under the shared ceiling and retains acceptance. Classification of
   the 31 additional sources retains finite consumer evidence; validator
   success, dry-run selection and generated-table consumer checks do not prove
   executed mutation quality or full regeneration integrity. E227 retains the
   build refusal before execution; resolve final-launch custody through a
   supported contract before root executes the stable native REAL boundary.
   Preserve the prepared fixture and exact expected error rather than infer live
   parity from pure arithmetic. E231 preserves the complete acquisition through
   later frontend failure and documents that bounded lifetime; its component is
   accepted and integrated. E240 closes the bounded surviving-actor acquisition
   component: original native registration, row/control relay and retained
   settlement execute in the resident Actor. Refused bulk wrappers remain
   unexecuted. Follow that slice with single-use exhausted-and-settled
   publication and explicit record release. A local return object or generic
   confirmed close cannot grant authority across processes. Derive the
   publication permit from that Actor's actual acquisition and preserve
   compatible continuous writer custody. Integrate atomic projection publication
   under compatible continuous writer custody before the actual renderer opens
   its source, followed by receipt serialization/delivery as distinct outcomes.
   E213 records why a separate recursively acquired publisher lock or an early
   unlock is insufficient. E210 requires retaining publication truth even when
   later receipt encoding fails; no failed invocation may select an old
   projection. Connect this owner to the actual session-log renderer consumer
   while preserving normalization, selected overrides and E165/E166
   source/profile controls. E202/E206 component imports and E208–E215 finite
   observations do not close complete native calendar/error/path/profile
   behavior, WAL, asynchronous cleanup, release packaging or ordinary consumer
   parity. R09's production consumer and R18 remain unreplaced. E214 retains the
   incomplete-profile publication reference. E215 assigns coherent typed
   preparation and preserves the actual-reader generation/closure obligation; a
   prepared result cannot stand in for that integration. E219 grounds the exact
   missing entry/selection/actor/reader connections. E225 lands the bounded
   embedded-profile, owned-spill and output-conversion repairs; connect that
   prepared API to native publication and the actual reader. Repair the
   source-grounded SessionEnd usage-schema mismatch through its real metadata
   consumer, preserving provider counts and top-level model ordering.
5. Resume the unchanged13-session/four-repository/1000-hot-turn fairness
   workload only after the owning consumer change and cleanup evidence justify
   it. Complete lifecycle, legacy-writer drain, packaging, upgrade/rollback and
   machine adoption remain required before parent acceptance and retirement.

E167–E238 retain the historical candidates, failures and bounded observations;
the ordered work above governs the next execution. Coverage is33/37 and parent
acceptance0/8. Root updates row state and this order with each durable change;
component closure alone does not establish integration or installation.

E105/E107/E108 establish the repaired selected Stop path, seven actual owner
controls and existing-untracked-custody observation on executable `d4644326`.
E109 retains the failed real Running-overlap baseline alongside13 completed
native clients. E111 repairs idle Stop and E112 retains a separate failed
fairness run with correct semantic output but no required overlap. E113 removes
the demonstrably redundant exact-empty library-map subprocess lookup, pins the
qualification fixture's unsealed CLI identity and measures publication phases.
Changed prefix source requires explicit review; candidate-derived identities do
not establish independent review. E116/E117 retain stronger kernel/state
diagnostics and a complete instrumented pass without erasing two unexplained
earlier failures. E118's actual replay fails fairness and locates both
publication cost and the larger required-lane/consumer-path dependency. Define
the complete executor, native request ownership, fresh authority and
cancellation boundaries before claiming residency or integrating scheduler
capacity; preserve the caller's PID safety contract and sibling isolation.
R06/R08 source integration retains per-consumer proof obligations. E119
integrates R06 and repairs its demonstrated public NO_ASK regression; E124
integrates R08 components and E127 exercises their actual local native consumer
after repairing stop-receipt displacement. E120 isolates the intentional fork;
E121 retains further full-suite failures and stronger diagnostics without
attributing their causes. E123 repairs partial holder publication and retains
actual cleanup plus a full pass. E125 exercises the separate retained-join
unwind branch; injected-quarantine unwind remains unqualified. E126 preserves
the failed advisory baseline; E127 observes exact local native boundary cuts and
required-goal output, with platform consumption explicitly unverified. E128
replays three lifecycle modes on native43 and preserves a pre-crash collector
failure. E129 qualifies committed-turn collection and stable session retention;
E130 replays restart and E131 replays the cooperative legacy boundary on the
same frozen native/runtime bytes. The unchanged legacy counterexample remains an
adoption/drain obligation. E132 restores the reviewed typed stock profile
without changing its authority predicates. E135 repairs raw patch-alias
protective admission and E136 keeps failed cleanup pending. E142 wires that
custodian and exercises pure contracts; E145 observes one pre-Ready
frontend-death boundary with strict settlement, actual reap, both EOFs and
correlated receipts. E149 exercises the corrected ordinary fixture with
independently observed frontend/custodian/Node topology. E152 repairs
request-local renderer coverage with pure counterexamples. E153 exercises the
corrected terminal fixture and bounded pipe collector on the same native
executable. E155 adds custody-receipt correlation and focused hostile controls;
E156 exercises the actual typed engine and selected copied renderer with
matching per-request custody and cleanup. A previous request's group cannot
qualify a later request with missing chain evidence. E162 observes one frontend
loss after Ready and dispatch; closed-pipe nonleaders and other loss phases and
surfaces require separately retained scenarios. Keep original caller capture and
native effects in the frontend; preserve Node FD3/4/5 and exclude every
liveness/control descriptor from Node. Normal request stdin EOF is not frontend
death. Unknown cleanup must retain custody and stop the scenario chain. This
private per-invocation boundary does not require a public pre-Ready spawn
service and does not earn warm residency. Missing-SID/cache branches
additionally need a fresh logical-session binding or protective refusal without
foreign strikes; process identity alone does not establish exclusive session
ownership. The held E133 probe cannot supply that proof. E158 distinguishes
one-shot consumer integration from later shared-module ownership. A changed
complete consumer and measured invocation/prefix costs are needed before another
unchanged fairness replay; a resident launcher alone does not establish that
change. E122 forbids a pre-Node queue which skips required latch/Stop semantics.
Keep the original 1000-turn hot transcript, counts,30s request budgets and later
hot Running witness requirements. Correct output and source-level capacity are
not fairness proof. No blind workload repetition: the next run needs an
identified owning implementation change and known cleanup. Overload and
final-executable lifecycle/legacy replay require separate retained runs.

E90 independently confirms E87's orphan absent without a root cleanup signal.
E91/E92 retain repaired signal readiness, the complete native suite and all four
lifecycle modes against the reproduced binary. Preserve those identities and
their explicit nonclaims. E93 observes cooperative legacy replay. E94
strengthens the load oracles and releases the resource hold. E96 tests the
custody/reuse repair but its actual baseline fails5 deadlines. E97 records the
next dependency: establish prefix-state ownership and native-derived eligibility
before overlapping Prepared callers, implement the bounded cohort/permit split,
verify hostile paths, and replay `baseline` before authorizing `concurrent` and
`overload` in separate retained runs. Replay lifecycle/legacy on the final
frozen binary; E92/E93 remain evidence for their original executable identity.
Stop on a failed scenario or live/ambiguous cleanup, inspect its artifacts, and
preserve the original request budgets. Correlated denial witnesses are required;
an unrelated timeout, exit0, empty output or absent turn file cannot qualify an
unknown fence or capacity reservation. A successful isolated workload does not
establish Sterling adoption/drain, Python retirement, heartbeat/upgrades or
machine cutover.

E68 lands the additive opt-in one-shot foundation and its identified shared
safety/validation repairs through a separately accepted component. The original
lane, evidence and all A1–A8 obligations remain active. Native installation is
separate. The normal machine bootstrap remains Python, but a future legacy
adapters installation receives changed shared guard bytes, so source landing is
not a behavior-inert claim. Keep the failed backpressure witness; instrument
startup, ancestor capture, proposal arrival and output delivery before
attributing its timeout or claiming concurrent performance. E69 adds a separate
reproduced ancestor-capture deadline failure; inspect its typed stage and
per-observation/substage timing before changing capture policy or budgets.

### Remaining parent obligations

The numbered list at the start of this section governs the next execution. The
items below keep the remaining parent obligations in their dependency order.
Their position does not discharge them, and they do not override that list.

1. Qualify R33's integrated hostile paths after the complete selected-source
   cold/warm observation in E81. E70's journal, E74's codec, E75's custody and
   E72's descriptor client reach an actual native owner through the admitted
   immutable image. E82 retains committed-candidate replay and independent
   inspection. Exercise concurrent cold startup, cancellation, lost response,
   unknown reservations across restart and generation replacement. Issue grants
   and descriptor rights only after validating the original selection, keep
   original authority paths separate from image routing, and revalidate queued
   grants before dispatch. Qualify exclusive writer custody against legacy
   clients, complete input snapshot/retention semantics and owned fallback for
   LF/US data. E57 remains the original failing consumer scenario; E81 adds
   successful cold/warm rendering through the replacement owner without erasing
   that failure. Define the actual selected client's broker seam and
   request/fallback outcome contract before implementing a startup-only relay or
   host. A lost response after dispatch stays unknown; only known nonexecution
   permits immediate inline fallback, which also requires an exclusive
   owner-held fence. Queue rejection while an existing writer remains active
   cannot authorize an unfenced inline render. Prefer owner-managed fallback
   under the same request ID and serialization key. A daemon error response also
   does not attest nonexecution: the exception handler covers rendering and
   response delivery. E60 grounds this dependency in the directly sourced client
   and write-before-response daemon. E57 is the failing cold-start/reuse
   regression; preserve its native failure until the owning implementation
   changes. `SystemSurfacePolicy` has no service lifetime declaration, and
   Sterling directly sources its client rather than using library-selection
   indirection. Prewarming cannot cover restart or stale-code fallback. Define a
   selected-source-bound service capability that reaches the actual
   compatibility dispatcher/client and a Rust owner that retains its own
   child/group from creation; PID/token leases and heartbeats confer no
   ownership. Keep ordinary request-group cleanup unchanged. Qualify serialized
   cold startup, ready/uncertain outcomes, source retirement, cancellation and a
   surviving-service/removed-request-child control. The foreign renderer can
   write after a client disconnects: owner creation alone does not resolve that
   outcome, and retry must not blindly replay it. Observe only owned private
   service retirement during qualification; if cleanup stays live or ambiguous
   at its bounded deadline, retain the sandbox and stop further scenarios. No
   arbitrary descendant receives a cleanup exemption.
   `executeCompatibilityDispatch` and the actual `run-handlers.sh` execution
   route must receive a native-admitted image/offer; a standalone source plan or
   startup relay cannot activate it. Keep original-path provenance when routing
   execution to an image. `caws_source_lib` probes live
   project/user/surface/shared tiers, `handler-env.sh` sources prior Bash
   startup, the parser directly sources `session-cache.sh`, and
   `CAWS_GUARD_CONFIG_PY` can select another program. Capture or explicitly
   reject these inputs and use a closed resolved library table. Any interim
   Python compatibility profile must name its pinned isolated
   interpreter/stdlib/system-toolchain trust boundary; it does not earn Python
   retirement. Tool wrappers must avoid Bash startup recursion. The native owner
   must select one stable custody home across generations and never turn an
   acquire failure into fresh initialization. No unused active declaration or
   unadmitted standalone-plan implementation substitutes for this integration.
2. Investigate the remaining R32 identity/process-domain dependencies.
   E52/E53/E55/E56 observe the selected caller/refusal/effect/finalization chain
   and hostile output failure, but do not discharge missing-session identity,
   exclusive process ownership, reset/rearm coordination or compatibility-path
   containment. Retain ordinary caller-death cancellation; neither a generic
   grace period nor silently disabling killing qualifies. A private intent
   record grants no authority by itself. Record the original failing and
   repaired boundary artifacts. Trace effective installed handlers/libraries and
   defaults, distinguish logical identity from target process instance, and
   retain isolated termination/refusal/state and surviving-sibling artifacts.
   Process-instance verification does not establish exclusive logical-session
   ownership; generation correlation does not revoke an in-flight effect after
   reset/rearm. Qualify signal-resistant targets and external cleanup after
   intentional caller death. Do not remove PID-linked containment or expand
   horizontal porting before these contracts are settled.
3. Integrate native client → actual typed one-shot engine → selected production
   guards → native result. Verify current authority, refusal channels, selected
   overrides, journal custody and Stop/handoff behavior through that path.
4. Qualify the candidate package, isolated adoption and rollback in private
   installations. Identify which legacy consumers each slice retains; a partial
   landing does not earn A4 or full migration acceptance. This step does not
   replace the machine's selected runtime.
5. Reuse the verified engine in the resident host. Exercise thirteen real native
   clients across four repositories, including warm policy changes, repeated
   IDs, slow/reentrant extensions, overload, generation overlap and host
   replacement.
6. Replace remaining implementations together with their consumers, qualify
   supported harnesses and no-Python packaging, and record earned acceptance.
7. After full parity, complete-consumer workload, no-Python package and isolated
   rollback qualification, cut over this machine from the identified previous
   selected version. Observe the selected native harness, guarded-write refusal,
   session rendering and rollback behavior through the actual registration;
   private package observations do not substitute for selected execution.

### Documentation obligations

Root owns the documentation tax in existing surfaces. A committed document,
component test or accepted handoff does not establish coherent source landing,
operational correctness or selected execution.

| Existing surface                                                                | Completed work                                                                                                                            | Remaining closure condition                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`, `hook-pack-shared-core.md`, `hook-packs.md`, `command-analysis.md` | Four-file candidate `063991aa` is committed and reviewed, E230.                                                                           | Land coherently with qualified guard source; reconcile the checked-normalization interface and command-specific failure exits before final checks.                                                                                                 |
| `docs/architecture/caws-native-runtime.md`                                      | Frontend settlement lands in87b70fcc; resident acquisition, cancellation, bounded retention and status contract land with bb3a8b99, E240. | Update publication permit, record release and actual-reader contracts with their implementations and consumer evidence.                                                                                                                            |
| Existing README, command-surface and hook-pack operating references             | The ordered CLI-package → shared-runtime → native-harness setup contract remains authoritative.                                           | Check native installation, upgrade, operation, registration/trust and rollback instructions against the qualified candidate and isolated runtime before machine cutover. Plans and infrastructure failures do not prove guarded-write enforcement. |
| `docs/guides/sterling-machine-runtime-migration.md`                             | Qualified main84079dfb and source16981627 match actual SHA1d5041f4, E242.                                                                 | Recheck operations against the eventual combined package and isolated native/harness execution before machine cutover.                                                                                                                             |
| This tracker and canonical parent acceptance                                    | E231–E262 retain bounded progress, failed attempts, owners and open consequences.                                                         | Synchronize main/source bytes after durable changes; keep33/37 partial coverage separate from0/8 parent acceptance, complete Python retirement and installed adoption.                                                                             |

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
checks current component scope, not the original commit's spec assignment. CAWS
create uses the same base to start a branch and select its merge target; it has
no independent start-ref. A component created against main therefore needs a
separately admitted ordinary Git integration of the committed candidate, with
main as an ancestor for a fast-forward. E68 records admitted integration,
checks, component acceptance and source landing. The original scope retains the
remaining implementation obligation; narrow a future responsibility only when a
separately admitted owner actually carries that work. Source landing does not
close the full acceptance criteria.

| Milestone                        | Observed state                                                                                    | Proof required to advance                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component foundations            | Opt-in source landed at `6da6548c`; installed hooks use the original runtime                      | E68 retains integrated checks and component evidence; claims remain scoped to what actually ran                                                                                                                                                |
| Executable replacement spine     | Isolated nonlatching Codex branch exercised; full replacement open                                | E33 preserves raw selected-guard/index/journal/native-output evidence. Full required chain, identity/containment, overrides and event/harness behavior require their own causal observations                                                   |
| Packaged selection and rollback  | Unproven                                                                                          | Clean candidate package selects the replacement in an isolated home/harness; native guarded write is withheld; rollback restores the prior selected generation without losing governed state; actual machine replacement waits for full parity |
| Resident multi-project operation | Isolated renderer owner observed, E82; complete resident engine and required workload unqualified | Same engine serves the required native workload with fresh authority, bounded fair capacity, owner-specific ordering, explicit uncertain outcomes and safe upgrades                                                                            |
| Complete migration               | Open                                                                                              | Every first-party Python implementation and consumer has an earned replacement; supported native observations and authoritative A1–A8 evidence exist                                                                                           |

Parity qualification identifies the previous selected CLI/runtime manifest and
native registrations, and reconciles changes to that baseline before machine
cutover. Intentional repairs to demonstrated inherited defects remain explicit;
silently preserving or changing a bug cannot substitute for a behavior contract.
