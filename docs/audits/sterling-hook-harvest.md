# Sterling hook harvest for CAWS

Date: 2026-09-12. Spec: `CAWS-STERLING-HOOK-HARVEST-001`. This is a dated
adoption review. Re-run the inventory before implementing a proposal; this
document does not establish continuing runtime state.

## Outcome and evidence boundary

Sterling's strongest contributions are its explicit Bash mutation-recognition
boundary and richer session-log reconstruction. CAWS already contains much of
the shared dispatch, safety, containment, advisory-budget, and session-identity
work. A wholesale copy would mix useful additions with older behavior,
project-specific policy, and fixes that are present on disk but absent from the
registered execution path.

The harvest compared Sterling's `.caws/hooks` with
`packages/caws-cli/templates/hook-packs/shared`, then followed the machine
registration, stock policy, handler overrides, and library selection separately.
No Sterling hooks, machine settings, or native registrations were modified. No
consumer source, third-party dependency, transcript, or corpus was copied into
CAWS's tracked ledger. The new tooling and this analysis are CAWS-authored.

Source inventory at Sterling `f412bac59700852607fd68c8aa3ede366819f562` and CAWS
`2995ac79365e2d6435980d66daa634797b2cb398`:

| Classification                      | Files | Interpretation                                                                           |
| ----------------------------------- | ----: | ---------------------------------------------------------------------------------------- |
| Same apart from `hook_pack_version` |    33 | No behavioral delta to harvest from these bytes                                          |
| Other shared-path differences       |    19 | Includes comments, older CAWS behavior, and substantive additions                        |
| Sterling additions                  |    68 | 24 hook/support files, 40 tests/fixtures, two surface policies, two dependency manifests |
| CAWS-only shared files              |     0 | All 52 shared-pack paths exist in Sterling                                               |

There are 120 inventoried files: 76 hook/support files, 40 tests/fixtures, two
surface policies, and two dependency manifests. Both input subtrees were clean.
Dependencies under `node_modules`, bytecode/cache directories, `.pristine`,
operational state/logs, and symlinks are excluded. A path's existence, tracked
status, or difference does not establish authorship, license, or execution. The
excluded dependency tree is not a source-harvest candidate.

## Reproduce the harvest

From the CAWS checkout, with the consumer root supplied explicitly:

```sh
python3 scripts/hook-harvest.py --consumer-root ../sterling > /tmp/caws-sterling-hook-harvest.json
PYTHONDONTWRITEBYTECODE=1 python3 scripts/hook-harvest.test.py -v
jq '.counts, .consumer, .caws, .dispatchers' /tmp/caws-sterling-hook-harvest.json
jq -r '.files[] | [.path,.status,.consumer_sha256,.caws_sha256] | @tsv' /tmp/caws-sterling-hook-harvest.json
```

When running inside a worktree, pass absolute `--consumer-root` and
`--caws-root` paths. The latter should name the CAWS source checkout being
assessed, not an assumed installed runtime. JSON output is generated evidence
and stays outside Git. It carries every included path, both byte lengths and
SHA-256 digests, consumer tracking state, source HEADs, exclusions, and
dispatcher declarations. The tool rejects changing input bytes/HEAD/status
during each source read. It does not claim an atomic snapshot across
repositories.

Only an exact numeric managed version-header line is normalized. Other comments
remain differences until reviewed. Dispatcher parsing is intentionally literal:
dynamic elements are reported as unresolved, comments are not active handlers,
and no shell code is evaluated.

## Which code the configured machine selects

The inspected machine pointer was
`db759a4ccb13108d81082cc8a64aa0172f32af5ebb9d90e21a7ae29ed321fc00`, under
`~/.caws/lib/runtimes/`. Codex and Claude Code machine surface settings were
enabled. Their native configurations named
`caws-hook <surface> <event> --system`; Sterling's project `.codex/hooks.json`
and `.claude/settings.json` had empty `hooks` objects. Existing harness sessions
can cache configuration, so this establishes configured selection, not fresh
native execution for every surface.

The machine project record was
`~/.caws/state/projects/ae4ab2acb24da38ad25dc1e186d1ac2fd27f7c87400596820cbc869447f3bb55.json`.
Its two surface configurations matched Sterling's tracked
`adapter-surface-policies/{codex,claude-code}.surface-policy.json` in substance:

- Four PreToolUse extensions: ripgrep, test-run, gitignore-track, CASR.
- Six PostToolUse extensions: quality, spec validation, three documentation
  checks, and audit tool-use.
- One SessionStart extension: worktree venv repair.
- Twelve explicit handler overrides: those eight new handler names plus
  `block-dangerous.sh`, `bash-write-guard.sh`, `worktree-guard.sh`, and
  `session-log.sh`.
- One explicit library override: `heredoc.sh`.

The selection chain is implemented in
`templates/hook-packs/runtime/caws-hook.py::system_configuration`, then
`runtime/dispatch.sh`, then `shared/lib/run-handlers.sh`'s
`CAWS_MACHINE_HANDLERS` lookup. Paths in this paragraph are under
`packages/caws-cli/`. A stock filename on disk in the consumer does not by
itself override the machine handler. Explicit overrides can still load sibling
support files from their own script directory, so dependency reach must be
traced too.

**Reachability finding:** Sterling's local `worktree-write-guard.sh` adds
`_guard_mode_auto_satisfies_ask`, including the observed `bypassPermissions`
mode. That file is absent from both registered handler-override maps. The pinned
machine `worktree-write-guard.sh` lacks the function. Thus the reviewed machine
configuration selects a guard without this local repair. This is a configured
reachability gap, not evidence that a real unauthorized write was executed. The
same omitted override also leaves the local canonical-path containment addition
outside this machine selection path.

**Dormant finalizer:** `casr-finalize.sh` and its driver exist, but neither the
legacy Stop declaration nor the two machine extension lists select that handler.
Other Sterling finalization callers may exist; this review does not equate this
missing hook registration with total loss of finalization.

## All shared-path deltas

All paths in this table are relative to `.caws/hooks` in Sterling and to
`packages/caws-cli/templates/hook-packs/shared` in CAWS.

| Path                            | Reviewed difference                                                                                                      | Adoption disposition                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `agent-register.sh`             | Sterling lacks CAWS's pack-drift advisory                                                                                | Keep the current CAWS mechanism; ensure it describes the selected code rather than all local files as active overrides |
| `audit.sh`                      | Compact JSONL/tool payload support already exists in CAWS; Sterling has different comments and older unset-HOME fallback | No wholesale port; preserve CAWS's HOME handling                                                                       |
| `bash-write-guard.sh`           | Shared recognizer, foreign-repository check, dynamic/broad/unrepresentable/unsupported channels                          | Highest-value portable guard work; integrate as a contract, not a standalone file copy                                 |
| `classify_command.py`           | Sterling hardcodes owner spellings and lacks CAWS's leading-pathspec commit handling; minor comment/format changes       | Preserve the configurable CAWS identity implementation and pathspec support                                            |
| `dispatch/pre_tool_use.sh`      | Local extensions and explanatory ownership notes; Sterling lacks current empty-array handling                            | Preserve extension order in policy; keep current stock dispatcher protections                                          |
| `dispatch/post_tool_use.sh`     | Quality/validation/audit enabled and documentation checks added; no empty-array fix                                      | Represent these choices through project policy; do not enable them globally                                            |
| `dispatch/session_start.sh`     | Venv-repair addition; no empty-array fix                                                                                 | Keep as project policy pending artifact-ownership review                                                               |
| `dispatch/pre_compact.sh`       | Same two handlers; Sterling lacks current empty-array handling                                                           | Retain current CAWS code                                                                                               |
| `dispatch/stop.sh`              | Same three active handlers; Sterling lacks current empty-array handling                                                  | Retain current CAWS code; separately reconcile dormant CASR finalization                                               |
| `lib/caws-state.sh`             | Directory-containment comments differ; matching code is already ported                                                   | No new matching capability                                                                                             |
| `lib/worktree-claim-oracle.cjs` | Same directory-containment implementation; lineage comments differ                                                       | Preserve CAWS implementation and parity tests                                                                          |
| `lib/heredoc.sh`                | Managed header, shebang, and port explanation differ; neutralizer body already ported                                    | Reuse the shared neutralizer rather than introducing another copy                                                      |
| `lib/surfaces-registry.sh`      | Generated projection metadata differs                                                                                    | Regenerate from CAWS's registry; do not hand-port generated metadata                                                   |
| `quality-check.sh`              | Same execution body; opt-in versus locally active header                                                                 | Configuration choice, not missing CAWS capability                                                                      |
| `validate-spec.sh`              | Same execution body; locally active/lineage header                                                                       | Configuration choice, not missing CAWS capability                                                                      |
| `session-log.sh`                | Durable DB/zstd sources, machine audit-path preservation, subagent discovery, refresh debounce, daemon-first rendering   | Portable behavior, but preserve stock HOME safeguards and the existing adapter seam                                    |
| `session_log_renderer.py`       | Harness modules, nested Codex action indexing, audit/outcome merge, fidelity controls, incremental cache                 | Port behavior with schema and surface compatibility evidence                                                           |
| `worktree-guard.sh`             | Quoted prose/heredoc filtering, command-position cp/mv recognition, `grep -e` fix, expanded advice                       | Port false-positive fixes after adversarial tests; avoid growing repetitive advice                                     |
| `worktree-write-guard.sh`       | Canonical-path checks from a worktree; refusal when a mode auto-answers ask                                              | Portable candidates with a registration gap and uncertainty-path review required                                       |

The 33 stamp-only paths include `block-dangerous.sh`, `lib/run-handlers.sh`,
`lib/parse-input.sh`, `lib/session-id.sh`, `lib/reprieve.sh`,
`agent-heartbeat.sh`, `advisory_truncate.py`, `quiet-merge.sh`, and the shared
quality heuristics. The JSON inventory is the exhaustive path/digest index.
Stock and installed source are distinct: the machine pointer above does not
prove that every later CAWS source change has been installed.

## Sterling additions and what they contribute

| Files or family                                                                                                     | Value to CAWS                                                                                                                    | Boundary to preserve                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `lib/bash-mutation-targets.sh`                                                                                      | One producer distinguishes literal operands, broad roots, dynamic populations, unrepresentable operands, and unsupported nesting | Recognition grants no write authority; consumers decide disposition; no ambient CWD or pathname expansion                     |
| `casr-context.sh`, `casr_hook_driver.py`, `casr-finalize.sh`, `casr_finalize_driver.py`                             | Target-oriented context delivery, explicit unresolved-relation friction, one-shot freshness barrier, separate finalization       | Sterling's context-authority adjudication and Python dependencies remain project-owned; harvest the extension/output contract |
| `doc-frontmatter-check.sh`, `doc-placement-check.sh`, `doc-placement-molds.tsv`, `doc-ephemeral-create-advisory.sh` | Document schema, placement, and retirement advice serve distinct authoring needs                                                 | Rules, vocabulary, folder molds, and remediation belong to the consumer; filename heuristics are not authority proofs         |
| `rg-replace-guard.sh`                                                                                               | Makes transformed search output visible                                                                                          | Harden command/option parsing before offering it as an opt-in utility                                                         |
| `gitignore-track-guard.sh`                                                                                          | Enforces the consumer's rule against committing ignored artifacts                                                                | Gitignore is not a license classifier; retain explicit consumer opt-in and fix pathspec/CWD handling                          |
| `test-run-guard.sh`                                                                                                 | Routes costly pytest runs through resource admission and receipts                                                                | Sterling's `scripts/test` front door is not a universal CAWS command                                                          |
| `lib/harness_common.py`, `lib/harness_{claude,codex,dsh,opencode,qwen,zcode}.py`                                    | Separates surface normalization from turn accumulation                                                                           | Retain source provenance and existing CAWS Kimi support; a new module layout alone proves no fidelity gain                    |
| `lib/{opencode,zcode}-transcript.py`                                                                                | Reconstructs durable database-backed transcripts                                                                                 | Database/session selection, failure visibility, and cache custody need explicit contracts                                     |
| `session_log_daemon.py`, `lib/session-log-daemon-client.sh`                                                         | Warm rendering, fallback, bounded parse cache                                                                                    | Do not adopt before stale-input, artifact-integrity, concurrency, and process-identity concerns below are resolved            |
| `worktree-venv-link-check.sh`                                                                                       | Repairs missing venv links                                                                                                       | It mutates all registered worktrees at SessionStart; do not promote this unqualified cross-owner repair loop                  |
| `adapter-surface-policies/*.json`                                                                                   | Reviewable extension order and overrides                                                                                         | Existing CAWS mechanism, worth strengthening with effective-path diagnostics                                                  |
| `package.json`, `package-lock.json`                                                                                 | Hook-local dependency declaration                                                                                                | Dependency packaging decision, not harvested implementation                                                                   |
| `tests/` (40 files)                                                                                                 | Incident regressions, lexical-role controls, differential/held-out evaluation, daemon/cache/fidelity tests                       | Re-author minimal fixtures where needed; do not copy transcript populations or third-party data into CAWS                     |

## Handler value and noise inventory

Bytes below are **Sterling source-file sizes**, not emitted output. Risk is a
source-level estimate of context noise, not a latency measurement. Tables use
the legacy declarations for a stable event inventory; machine selection and
runtime disable lists can alter the executed files. Per-handler dry-run/native
reach evidence is required before claiming every handler fires in a live
session.

### PreToolUse (14 declared)

| Handler                    |  Bytes | Fires on / buys                                                      | Noise risk             | Verdict                                                              |
| -------------------------- | -----: | -------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `casr-context.sh`          | 22,957 | Write/Edit and admitted Bash targets; governing context and friction | MEDIUM                 | Keep project-owned; preserve typed priority and freshness evidence   |
| `worktree-guard.sh`        | 18,487 | Bash; protects shared checkout operations                            | MEDIUM                 | Port command-position fixes; avoid repeating long base-commit advice |
| `rg-replace-guard.sh`      |  5,757 | Bash search replacement; transformed-output notice                   | MEDIUM                 | Harden before offering opt-in                                        |
| `agent-heartbeat.sh`       | 18,901 | Each call; liveness, peer-change notice, message delivery            | LOW                    | Keep current change detection and delivery settlement                |
| `quiet-merge.sh`           |  4,776 | Bash CAWS merge/destroy; bounded tool output rewrite                 | LOW                    | Keep last-interceptor ordering; retain command status/diagnostics    |
| `cwd-guard.sh`             |  1,656 | CWD change; scope context                                            | LOW                    | Keep                                                                 |
| `block-dangerous.sh`       | 39,409 | Bash; catastrophic-command refusal and latch                         | NONE on ordinary calls | Keep; no reduction of refusal evidence                               |
| `scope-guard.sh`           | 21,399 | File tools; binding/scope boundary                                   | NONE on admitted calls | Keep                                                                 |
| `worktree-write-guard.sh`  | 32,578 | Write/Edit; payload ownership and base-write decision                | NONE on admitted calls | Review portable repairs and actual selection                         |
| `bash-write-guard.sh`      | 26,310 | Bash mutations; target ownership                                     | NONE on admitted calls | Harvest recognizer contract and uncertainty handling                 |
| `test-run-guard.sh`        |  3,751 | Bash pytest; resource-admission front door                           | NONE on admitted calls | Project opt-in after option-role repair                              |
| `gitignore-track-guard.sh` |  9,588 | Bash staging; ignored-artifact policy                                | NONE on admitted calls | Project opt-in after pathspec repair                                 |
| `protected-paths.sh`       |  8,841 | Protected control edits; prevents self-modified enforcement          | NONE on admitted calls | Keep                                                                 |
| `scan-secrets.sh`          |  3,632 | File writes; credential-pattern refusal                              | NONE on admitted calls | Keep                                                                 |

### PostToolUse (13 declared)

| Handler                            |  Bytes | Fires on / buys                                                 | Noise risk                       | Verdict                                                                  |
| ---------------------------------- | -----: | --------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `doc-frontmatter-check.sh`         | 14,824 | Markdown writes; authoring/schema guidance                      | MEDIUM                           | Consumer schema; change-sensitive advice                                 |
| `doc-placement-check.sh`           |  5,630 | Architecture Markdown writes; body-mold redirect                | MEDIUM                           | Consumer molds; change-sensitive advice                                  |
| `doc-ephemeral-create-advisory.sh` |  6,553 | Temporal-name Markdown writes; retirement guidance              | MEDIUM                           | Consumer policy; suppress unchanged advice                               |
| `quality-check.sh`                 |  6,027 | Source writes with bound spec; invokes gates                    | MEDIUM on failure                | Keep opt-in; silent success already exists; measure gate cost separately |
| `shortcut-language-check.sh`       |  7,989 | Source writes; escalating incomplete-code wording signal        | MEDIUM                           | Preserve strike meaning; test prose/fixture exclusions before tuning     |
| `validate-spec.sh`                 |  4,046 | Spec YAML writes; CLI validation                                | LOW                              | Keep opt-in                                                              |
| `naming-check.sh`                  |  2,077 | Write/Edit; shadow-file naming advice                           | LOW                              | Keep                                                                     |
| `god-object-check.sh`              |  4,995 | Source writes; large-file/crossing heuristic                    | LOW                              | Keep existing delta hysteresis                                           |
| `duplicate-export-check.sh`        |  3,742 | JS/TS Write; duplicate public-export advice                     | LOW                              | Keep                                                                     |
| `loc-delta-check.sh`               |  2,779 | Edit; large added-line delta                                    | LOW                              | Keep                                                                     |
| `audit.sh tool-use`                |  5,232 | Tool calls; local audit custody                                 | NONE ordinarily                  | Keep consumer choice; align writer and reader paths                      |
| `plan-transcript-snapshot.sh`      |  3,712 | ExitPlanMode; captures plan context                             | NONE ordinarily                  | Keep                                                                     |
| `session-log.sh`                   | 22,336 | Plans and selected surface refreshes; reconstructs turn records | LOW context / unmeasured latency | Harvest fidelity; qualify daemon separately                              |

### SessionStart (4 declared)

| Handler                       |  Bytes | Buys                                         | Noise risk                       | Verdict                                                                            |
| ----------------------------- | -----: | -------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `agent-register.sh`           |  6,451 | Session lease and starting identity          | LOW                              | Retain current stock drift visibility; verify registered path                      |
| `worktree-venv-link-check.sh` |  2,693 | Python environment repair                    | LOW context / cross-owner writes | Keep local; replace with an owner-scoped repair operation before upstream adoption |
| `audit.sh session-start`      |  5,232 | Audit start record                           | NONE ordinarily                  | Keep                                                                               |
| `session-log.sh`              | 22,336 | Identity and initial session materialization | LOW                              | Preserve source/runtime distinction                                                |

### Stop and PreCompact

| Event / handler                           |  Bytes | Buys                              | Noise risk      | Verdict                                   |
| ----------------------------------------- | -----: | --------------------------------- | --------------- | ----------------------------------------- |
| Stop / `plan-transcript-finalize.sh`      |  2,603 | Completes pending plan transcript | NONE ordinarily | Keep                                      |
| Stop / `session-log.sh`                   | 22,336 | Final turn artifacts              | LOW             | Keep; Stop absence must remain observable |
| Stop / `agent-stop.sh`                    |  1,575 | Stopped lease marker              | NONE ordinarily | Keep                                      |
| PreCompact / `agent-heartbeat.sh`         | 18,901 | Liveness checkpoint               | LOW             | Keep                                      |
| PreCompact / `session-log.sh pre-compact` | 22,336 | Pre-compaction artifacts          | LOW             | Keep                                      |

Not selected in these declarations: `session-caws-status.sh`,
`stop-worktree-check.sh`, `working-tree-guard.sh`, `worktree-pin-guard.sh`, and
`casr-finalize.sh`. Presence alone does not make them dead code: other surfaces
or direct callers can use them. `reset-strikes.sh` and `reset-danger-latch.sh`
are human utilities, not noisy registered handlers. Libraries, Python drivers,
and fixtures are dependencies/support, not independent event registrations.

## Observed counterexamples and adoption risks

The following commands were passed **as data** to the named handlers; the
represented shell commands were not executed:

| Handler  | Input                         | Observed result             | Why it matters                                               |
| -------- | ----------------------------- | --------------------------- | ------------------------------------------------------------ |
| ripgrep  | `echo rg -rn needle`          | exit 2; 612 stdout bytes    | Prose is mistaken for an executed search                     |
| ripgrep  | `rg -n -- -rn README.md`      | exit 2; 616 stdout bytes    | A pattern after option termination is mistaken for an option |
| ripgrep  | `rg -n needle README.md`      | exit 0; empty stdout/stderr | Ordinary-search preservation control                         |
| test-run | `pytest -k example.py`        | exit 0; empty stdout/stderr | A selector value is mistaken for an exact test target        |
| test-run | `pytest --junitxml report.py` | exit 0; empty stdout/stderr | An output filename is mistaken for an exact test target      |
| test-run | `pytest`                      | exit 2; 375 stdout bytes    | Broad-run refusal control                                    |

To reproduce an individual counterexample from the canonical CAWS checkout,
invoke the handler with the represented command in its input environment:

```sh
HOOK_TOOL_NAME=Bash HOOK_COMMAND='echo rg -rn needle' \
  bash ../sterling/.caws/hooks/rg-replace-guard.sh </dev/null
HOOK_TOOL_NAME=Bash HOOK_COMMAND='pytest -k example.py' \
  bash ../sterling/.caws/hooks/test-run-guard.sh </dev/null
```

Existing Sterling suites observed during this harvest:

```text
bash ../sterling/.caws/hooks/tests/test_rg_replace_guard.sh
  exit 0: 26 passed, 0 failed
bash ../sterling/.caws/hooks/tests/test_test_run_guard.sh
  exit 0: 18 passed, 0 failed
PYTHONDONTWRITEBYTECODE=1 bash ../sterling/.caws/hooks/tests/test_session_log_render_fidelity.sh
  exit 1: 12 passed, 1 failed
  failure: timeline[tool_call].source_harness is not declared in the schema
  the same suite also reports that fixture artifacts validate
```

The final pair is significant: permissive schema validation can pass while a
field-declaration check fails. Preserve the stronger coverage check; reconcile
the actual schema contract rather than silencing it. These runs are consumer
evidence, not CAWS distribution or native lifecycle tests.

Additional source-level risks requiring focused experiments before adoption:

- **Daemon stale sidecars:** `session_log_daemon.py::input_key` includes
  argument strings and transcript inode/size/mtime, but no audit/outcome file
  identity. Its outer skip path checks only the turn-file count. An unchanged
  transcript with newly appended hook outcomes can reuse a render, bypassing the
  inner prefix-hash validation. Same-count artifact corruption is also
  invisible.
- **Daemon freshness/ownership:** its source fingerprint uses path/mtime, not
  source content hashes. The client reaper signals the PID from an aged lease
  without binding that PID to process-start identity. A timeout can send the
  caller into one-shot rendering while the single-threaded daemon is still
  rendering. These are review findings, not measured production incidents.
- **Git staging parser:** `gitignore-track-guard.sh` splits shell text on raw
  separators and whitespace, skips pathspec-file contents and whole-tree forms,
  and checks paths against `HOOK_CWD` without honoring each segment's `git -C`
  or `cd`. Its fixture's `git -C .` case does not establish a
  different-directory case. The useful policy needs stronger command/pathspec
  semantics.
- **Uncertain ownership:** Sterling's added worktree-to-canonical branch only
  blocks a positive foreign `block_claimed` result and then exits 0. Missing
  tooling or other oracle results deserve explicit preservation/refusal tests.
- **Surface regression:** the CAWS renderer supports Kimi wire rows; Sterling's
  enumerated harness-module set lacks a Kimi adapter. A whole-renderer import
  would need a Kimi preservation test and explicit machine-adapter precedence.

## Concrete adoption sequence

These are implementation proposals, not changes enabled by this harvest.

1. **Make selected hook code reviewable.** Extend existing adapter/status
   diagnostics to show event, ordered handler, resolved executable, source
   digest, library overrides, and stock/custom status. Flag a changed local
   stock-name file that is not selected. Test a machine override, an unselected
   local repair, a missing extension anchor, and a project-local legacy chain.
   This directly addresses the permission-mode repair's reachability gap.
2. **Port the Bash recognition contract and guard repairs.** Keep typed
   literal/broad/dynamic/unrepresentable/unsupported results distinct. Preserve
   original command bytes for custody. Test literal/quoted paths, option roles,
   heredoc body versus executable substitution, redirection placement, dynamic
   prefix uncertainty, cross-repository paths, and ownership claims. Join the
   existing `CAWS-DEFECT-BASH-WRITE-GUARD-CROSS-REPO-01` work through its owner;
   do not take over or duplicate that active lane.
3. **Port permission-mode and worktree-operation corrections.** Derive the
   ask-capability contract per surface; preserve default-mode asks, existing
   hard refusals, and allowed paths. Prove the selected installed handler's
   behavior, not only direct invocation of the local file. Review the
   uncertainty branches before carrying the containment patch upstream.
4. **Port session fidelity through the existing adapter seam.** Retain raw
   source bounds and distinguish observed execution from nested-call indexing.
   Add source-qualified audit/outcome merge, subagent transcript pointers,
   durable DB/zstd sources, and surface-specific refresh where proven necessary.
   Require original-versus-rendered action/error/interjection evidence, schema
   coverage, Kimi preservation, and installed adapter reach. Keep CASR-specific
   relation parsing behind an extension boundary.
5. **Qualify acceleration after fidelity.** Require byte-identical one-shot
   versus cached output with transcript append/rewrite/truncate/replacement,
   sidecar-only append, source-content change with preserved mtime, corrupted
   output, simultaneous renders, timeout, daemon failure, and stale/reused PID.
   Measure cold/warm latency and memory on a bounded corpus; historical timing
   comments are not a current performance result.
6. **Offer hardened optional utilities.** Ripgrep replacement visibility,
   ignored-artifact policy, documentation lifecycle rules, and test admission
   can be reusable consumer extensions. Keep rules configurable and quiet on
   irrelevant/success paths. Require option-role and CWD/pathspec
   counterexamples above to pass before shipping. Keep venv repair explicitly
   owner-scoped.

### A concrete output reduction

Fixing the ripgrep matcher to recognize the executed command and option roles
would remove the measured 612-byte false refusal for `echo rg -rn needle` and
the 616-byte false refusal for a pattern after `--`. In a review turn containing
those two reads, that is **1,228 stdout bytes avoided**, plus avoided
failed-call recovery; this is a stated two-call scenario, not a measured typical
frequency. The change belongs at the matcher, before either existing block
branch:

```diff
- Search the entire raw command for an rg word and a collision-shaped token.
+ Select the rg command's parsed argv; stop option interpretation at --.
+ Apply the collision rule only to that command's option tokens.
```

Risk: a parser that overlooks an actual rg invocation would suppress a useful
replacement warning. The hostile and preservation cases above must accompany the
change. This proposal does not trim safety refusals or reorder dispatch. For
documentation advice, use the existing composer's bounded/deduplicated delivery
seam: it already suppresses identical advisory bytes per handler and session
after delivery. Measure actual emitted bytes before claiming additional savings;
adding another independent dedup ledger would create competing state.

## Harvest verification

The four stdlib fixture checks in `scripts/hook-harvest.test.py` passed. They
cover real versus version-only deltas, empty-file digests, comment/dynamic
dispatcher roles, excluded dependencies/symlinks, and changing source bytes. The
live inventory accounted for all 120 included Sterling paths, all tracked, with
no unresolved elements in the reviewed dispatcher arrays.

`caws gates run --spec CAWS-STERLING-HOOK-HARVEST-001` passed all five declared
evaluators: budget, spec completeness, scope boundary, god-object, and TODO
detection. This is evidence for the harvest's scoped deliverables, not the
consumer hooks' correctness. The failing consumer fidelity check above remains
an adoption finding.

`caws doctor` returned 1 with 1 error, 7 warnings, and 14 informational
findings; there were no load errors. The error was a stale peer lease whose
`wt-advisory-budget` CWD no longer exists. Warnings concerned unbound backlog,
historical governance/waiver residue, two foreign lanes' missing live leases,
and local-versus-stock hook-pack drift. These were observed, not repaired by
this scoped harvest. No clean-doctor or fresh native lifecycle claim is made.

## Review decisions and completion limits

- [yes] Adopt selected-executable/digest diagnostics and surface-specific
  ask-capability checks.
- [yes] Port the shared recognizer and worktree-operation fixes with adversarial
  authority/operand tests.
- [yes] Port session fidelity with schema and all-surface compatibility
  controls.
- [yes] Qualify the daemon/cache as a separate performance change after
  fidelity.
- [yes] Offer hardened optional utility hooks with consumer-owned policies.

The harvest leaves hook enablement and these multi-component design decisions
for explicit review. It does not declare the complete hook system best in class,
deployed, or secure on the strength of an inventory or passing fixtures. The
concrete next implementation is the selected-code visibility and ask-capability
gap, followed by recognition and transcript fidelity.
