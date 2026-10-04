# Release readiness acceptance

This checklist governs the repairs in `CAWS-RELEASE-AUDIT-REPAIRS-003`. It is a
testable release bar, not a record that the candidate passed. Criterion verdicts
and artifact references belong in the canonical spec evidence.

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

## Execution and remaining release decisions

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
