---
doc_id: release-readiness
authority: canonical
status: active
title: Release readiness acceptance
owner: CAWS release maintainers
updated: 2026-11-08
audience: maintainer
---

# Release readiness acceptance

This contract defines functional completion for the integrated release and
native cutover. The repair criteria below also govern
`CAWS-RELEASE-AUDIT-REPAIRS-003`. Criterion verdicts and artifact references
belong in canonical spec evidence; a requirement stated here does not assert a
passing result. Release tagging and npm publication require separate explicit
user authorization, including after qualification and machine cutover.

| Criterion             | Required observation                                                                                                                                  | Counterexample that must fail                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A1 Qualification      | Actual workflow audit invokes the root script; fresh tests generate their documentation inputs; mutation inventory accounts for every source          | Workspace script shadowing, missing generated docs, unclassified source, nonzero audit exit                |
| A2 Change basis       | Gate output and events identify caller checkout, base and head; committed lane changes and staged changes are evaluated                               | Empty canonical index hiding lane edits, failed Git reads, rename hiding a forbidden path                  |
| A3 Merge preflight    | Real conflicting branches report not ready; clean branches report ready; refs, index and files remain unchanged                                       | Conflict reported as ready; preview modifies a working tree or branch                                      |
| A4 Adapter contract   | Installed bootstrap and selected driver reject invalid invocation, including with a missing runtime pointer, and preserve valid lifecycle degradation | Unknown event exits zero before the driver loads; valid Stop configuration fault traps the session         |
| A5 Injection oracle   | Real runner preserves a fixture-owned sentinel; deliberate unsafe control changes it and is detected                                                  | Test passes because a deleted sentinel is absent; unrelated `/tmp` state decides outcome                   |
| A6 Artifact contracts | Packed candidate excludes bytecode even after Python use; actual renderer output validates, malformed output fails                                    | Cached machine files leak into tarball; hand-authored fixture passes while producer output fails           |
| A7 Dependencies       | Workspace lockfile and detached installed consumer audits have zero findings                                                                          | Root overrides conceal consumer vulnerabilities; unsupported downgrade manufactures a clean audit          |
| A8 Operator claims    | Commands, bounded goal behavior and post-RC notes match executable behavior; registry observations identify exact version                             | GitHub release mistaken for current npm availability; local tests mistaken for remote/native qualification |

## Failure modes, ordered by impact

| Failure                            | Trigger and cost                                                                                                                                                | Disposition                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| False scope pass                   | Committed/worktree changes or a failed Git read look empty; unintended paths can be accepted under a clean signal                                               | Fix now; retain basis in the event so downstream consumers cannot lose its meaning                                                 |
| Unsafe release or runtime adoption | Publish or install an unqualified candidate; registry versions and adopted machine behavior are costly to reverse                                               | Gate publication and adoption on exact artifact identity and native traces                                                         |
| False injection proof              | Assert absence after a deletion payload; a broken executor can pass                                                                                             | Fix now with a preserved sentinel and a negative control                                                                           |
| False process-enforcement proof    | A sacrificial wrapper exits naturally and an escalation stamp substitutes for signal delivery; broken enforcement appears tested                                | Fix now; require a SIGTERM-handler receipt, dry-run survival, and a suppressed-signal control                                      |
| Hidden dependency exposure         | Workspace-only overrides or forced downgrades make an audit green while consumers remain affected                                                               | Fix now; audit detached consumer without workspace overrides                                                                       |
| False merge readiness              | Conflicting branches pass preview; operator follows a promise that execution cannot honor                                                                       | Fix now; conflict preflight must remain read-only                                                                                  |
| Adapter error conflation           | Invalid event is treated as legitimate lifecycle degradation, or degradation blocks exit forever                                                                | Fix invocation classification now; preserve refusal versus configuration-failure distinction                                       |
| Nonreproducible qualification      | Ambient docs, caches or temporary paths determine outcome                                                                                                       | Fix now in setup and packaging contracts                                                                                           |
| Schema/producer drift              | Renderer adds lineage or emits null summary; consumers reject valid telemetry                                                                                   | Fix now; validate actual emitted bytes                                                                                             |
| Guard copy-path false positives    | Whole-command `cp`/`mv` heuristics mistake a canonical source plus an owned-lane destination for worktree-to-main copying; routine artifact transfer is blocked | Investigate in an isolated fixture before native adoption; parse normalized destinations without weakening canonical-write refusal |
| Historical housekeeping            | Orphan worktree receipts, stale leases, old messages                                                                                                            | Defer ownership-sensitive cleanup; it does not qualify package behavior                                                            |

## Execution order

1. Establish the actual host boundary early. Identify supported harness
   versions, authentic caller and workdir fields, trust requirements and refusal
   callbacks. An unavailable host capability is a named dependency with a
   specific next observation; component tests cannot establish host delivery.
2. Complete one real installed production workflow: normal trust and Start,
   legitimate owned-lane authority, reads and writes through shell and supported
   native file tools, a representative check, a commit through normal gates,
   protected-write refusal, Stop and semantic session rendering. Retain the
   selected package/runtime identities and actual host observations. This is the
   first integration milestone; the complete release bar remains required.
3. Tie each additional prerequisite to the exact failing consumer step it
   repairs, then return to that step. Continue independent CI repairs where
   ownership, interfaces and resources permit. A component pass cannot discharge
   its parent workflow.
4. Extend the demonstrated path to all seven supported harnesses, supported
   extensions, resident concurrency and recovery. Freeze the integrated
   candidate for final qualification. Reuse retained results only where their
   source, dependency, test, build and runtime inputs remain applicable; rerun
   affected checks after changes.
5. Qualify isolated package installation and rollback before broad machine
   adoption. Complete normal review, evidence recording, landing and push, then
   perform the ordered CLI package, shared runtime and harness-registration
   cutover. Verify actual selected execution after adoption. Keep tagging and
   publication withheld until separately authorized.

The immediate workflow uses the intended native implementation and production
governance. A fixture engine or compatibility-only route cannot discharge it.
Required supported behavior and canonical authority are the oracle; reproducing
legacy implementation quirks is not a completion requirement.

## Full functional acceptance

The repair criteria and first installed workflow do not by themselves complete
the release. Every criterion below requires an observable result on the
identified candidate. The
[native runtime contract](architecture/caws-native-runtime.md#functional-acceptance-and-proof)
defines the detailed lifecycle, containment, extension and performance
obligations.

| Release criterion                   | Required evidence and falsifier                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary governed work              | The complete installed workflow above succeeds on each of all seven supported harnesses. Retain authentic host events, file changes, command statuses, governed commit and rendered operation records. A missing callback, blocked legitimate operation or absent rendered operation fails the scenario.                                                                                                                                                                                      |
| Fresh authority                     | Canonical, nested and app-managed linked worktrees resolve correctly, including distinct session cwd/tool workdir, relative and absolute targets, symlinks and changes to claims/specs/policy. Owned operations succeed; foreign ownership, released claims and protected writes refuse with protected bytes unchanged. Cross-session context borrowing fails.                                                                                                                                |
| Refusal and containment             | The actual host withholds a prohibited operation before the unchanged deadline. Independently inspect its execution marker, protected bytes, native stdout/stderr/exit and settled children. Test timeout, disconnect, malformed output and defined Stop/configuration failures. Disposable termination targets exit while an unrelated control survives; request-owned mutation cannot continue after completion.                                                                            |
| Selected replacement and extensions | Process/module observations from an unpacked installation without Python identify the intended first-party native/typed implementation, with no stock interpreter or per-handler subprocess fallback. Execute supported extension ordering, overrides, arguments, cwd and environment. A hidden fallback or skipped required behavior fails.                                                                                                                                                  |
| Resident lifecycle and load         | At least thirteen simultaneous sessions across four repositories, with mixed harnesses, retain isolated contexts, bounded shared capacity and fair admission. Observe per-session outcomes, cold/warm latency distributions, queue times, worker counts and memory under slow extensions, repeated session IDs across projects, crashes, overload and generation changes. Leakage, starvation, unsafe replay or exceeded declared bounds fails.                                               |
| Reproducible installed candidate    | Repo-owned sources and declared inputs reconstruct the candidate without disposable private hosts. Each of the six macOS/Linux and Node 18/20/22 cells completes one entire ten-case detached qualification run with exit 0 and unchanged timeouts. Retain package/native identities, raw command streams, raw governance before/after bytes and modes, corruption/interruption/rollback observations and zero-finding detached consumer audits. Partial runs cannot be combined into a pass. |
| Required quality gates              | Current CI, build, typecheck, lint, docs, tests, coverage, zero-finding workspace audit and all five full mutation campaigns pass every declared per-file floor, including all sixteen execution and nine analysis targets. Baseline-only mutation runs, skipped campaigns, exclusions, lowered floors and stale reports fail acceptance.                                                                                                                                                     |
| Integration and adoption            | Ground independent read-only committed-candidate feedback, land and push normally, record criteria through `caws specs evidence` and read back both spec and event. Qualify ordered CLI/runtime/harness cutover and rollback, then repeat actual owned-write/refusal/Stop/render observations with selected-execution readback. Source landing, installed configuration or a component pass alone cannot establish machine adoption.                                                          |
| Publication identity                | Separate user authorization permits tagging/publishing only after required qualification. A fresh npm version and intended channel must identify the exact qualified artifact. Reusing a published version or qualifying different bytes fails the publication bar.                                                                                                                                                                                                                           |

## Evidence custody and decisions

Retain source revision, package hash, platform-specific native image, selected
runtime, exact command/cwd, exit status, raw output and relevant state before
and after for each observation. Preserve failed, skipped and interrupted
attempts. Generated receipts and required build inputs must survive worktree
teardown; scratch-only artifacts cannot support a durable acceptance claim.
Package hash equality does not imply installed runtime-manifest equality:
installation homes and generated dependency content can differ. Join each
installation to its own selected generation and inputs.

The [release procedure](release-procedure.md) defines the executable checks and
publication mechanics. Keep operational guidance aligned with source changes and
recorded observations. Runtime acceptance remains in the existing canonical
spec/evidence records; documentation is not a second progress ledger.

A handler's eventual exit 2 after its adapter timed out is not a delivered
refusal. Preserve timeout status and interrupted execution journals, terminate
owned fixture subprocesses before cleanup, and investigate handler latency
before claiming the scenario passed. Do not increase a timeout merely to obtain
green.

Investigate registry version/channel disagreement using uncached registry
metadata and historical publication receipts. Do not delete tags, republish an
existing version, or move channels based on a single failed lookup.

Implement qualification and runtime repairs in separate reviewable commits. Keep
generated receipts outside worktree teardown, including command, exit status,
stdout/stderr, candidate revision, tarball hash and scenario state.

Change release guidance to distinguish a local candidate, remote CI
qualification, installed-package behavior and native harness observation. Choose
the next version and publish only after those required observations agree. Full
mutation floors remain required; passing focused regressions is not their
substitute.

Retain the candidate tarball with the qualification report. An extracted source
driver is not the installed entry point: bootstrap failure can occur before the
driver ever validates an event. The installed-package scenarios must cover that
boundary and retain the command's actual exit status and output.

Tests can still agree with an incorrect oracle. Close that gap with real CLI
fixtures, before/after state checks, negative controls, packaged installation
and native trust/start/refusal/stop/render traces. Subprocess adapter tests do
not establish execution inside an actual Codex or Claude harness.
