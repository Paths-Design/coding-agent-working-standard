# Hook port qualification

Spec: `CAWS-HOOK-PORT-QUALIFICATION-001`. Started 2026-09-12.
The harvest decisions were approved by the user in the conversation and in
`sterling-hook-harvest.md`. This is local source and isolated installed-runtime
qualification. Global installation and fresh native harness adoption are separate
follow-on work, not established by this report.

## Contract

- Hook selection, handler return, adapter delivery, and native tool execution
  are separate observations. A handler's output is not automatically delivered.
- Lease freshness, transcript parentage, and session logs confer no ownership.
  Foreign lane authority survives paused or missing leases.
- Refusals survive optional logging failures. Ordinary allowed operations and
  existing surface-specific exit semantics are preservation controls.
- Corpus commands are data only. Historical outcomes are observations, not
  correctness labels. Corpus payloads and generated artifacts stay outside Git.
- Acceleration is qualified after fidelity, including sidecar-only changes and
  output corruption. A warm cache never supplies missing evidence of freshness.

## Runtime selection and session custody

`caws-hook <surface> <event> --system --describe` reports the installed runtime
digest, ordered executable paths/hashes, explicit library resolution, transcript
adapter, and differing local files that are not selected. It uses execution's
validated selection path and does not invoke handlers or write session state.
Inactive configurations return a reason instead of an empty success.

Machine dispatch retains `.caws/sessions/<resolved-session>/hook-events.jsonl`.
Each record names the invocation, handler, source digest at the before-dispatch
boundary, raw handler exit, adapter exit, and handler stdout/stderr. The
`observation_boundary: handler_return` and `delivery: not_observed` fields prevent
these observations from claiming recipient visibility. Shell command substitution
normalizes trailing stdout newlines, so this is the dispatcher's captured output,
not a byte-identical copy of an arbitrary child's original output stream.

The first installed experiment produced no records despite executing the marker:
Codex selected a duplicated surface runner. Codex and Kimi now delegate the loop
to shared code; deny priority, Codex diagnostic aliases, and Kimi's exit-1-to-2
promotion remain explicit. A second counterexample found the Codex envelope
writer following a session-directory symlink. Shared and Codex parsers now use
one envelope writer with directory-relative, no-follow opens and atomic JSON
replacement. Logging failures emit diagnostics and retain the tool decision.

### Evidence collected for this chunk

Scratch root: `/private/tmp/caws-hook-qualification-20260912/`.
The `selection-core/selection-*/` directories retain installer output,
per-scenario command/exit JSON, stdout/stderr, marker files, machine manifests,
project settings, session envelopes, and execution records.

| Command (from repository or package root as appropriate) | Exit | Observation |
|---|---:|---|
| `CAWS_EXPERIMENT_ARTIFACTS=/tmp/caws-hook-qualification-20260912/selection-core PYTHONDONTWRITEBYTECODE=1 python3 packages/caws-cli/tests/hooks/pytest/test_machine_hook_selection.py -v` | 0 | 11 tests; seven surface runners; blocked output retained; different sessions and concurrent invocations retain separate, complete records; symlink target remains empty |
| `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/adapter/machine-runtime.test.js tests/adapter/system-runtime.test.js` | 0 | 39 existing adapter cases, including offer retry/settlement, native output contracts, activation races, rollback, and canonical settings from worktrees |
| `../../node_modules/.bin/bats tests/hooks/bats/parse-input.bats tests/hooks/bats/parse-input-payload-transport.bats tests/hooks/bats/run-handlers-advisory-budget.bats tests/hooks/bats/run-handlers-advisory-dedup.bats` | 0 | 33 parser, large-payload, budget, and per-session advisory preservation cases |
| `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/init/pack-fingerprint.test.js` | 0 | 14 integrity checks; shared 69, Codex 23, Kimi 8 |
| `PYTHONDONTWRITEBYTECODE=1 python3 scripts/hook-experiments/sensitivity.py --output /tmp/caws-hook-qualification-20260912/sensitivity-core` | 0 | All three controls exit 0; corrupt recorded source digest, dropped deny priority, and removed no-follow directory opens each cause assertion failure (exit 1) |

The sensitivity summary is `sensitivity-core/summary.json`; each case retains
control/mutant stderr, command receipts, source hashes, and installed artifacts.
This is a three-defect sensitivity check, not an exhaustive mutation score.

### Limits and required further evidence

These artifacts establish installed-bootstrap behavior under synthetic native
payloads. They do not establish a fresh invocation by each real harness, recipient
visibility, or behavior under a hostile process rewriting executable bytes during
dispatch. Digests are explicitly before-dispatch observations. Fresh native
SessionStart/guard-refusal/Stop artifacts and selected installed hashes must be
examined before claiming machine-wide native adoption.

The runtime captures the returning handler's output before composition. A log
consumer must not label a budget-omitted or deduplicated advisory as delivered.
Stop's own execution record is appended after its renderer returns; it cannot
appear in that same render. Subsequent reconstruction must include it.

## Port decisions

Selected-code diagnostics, shared command recognition, tenure/permission repairs,
transcript fidelity, and optional consumer utilities were ported and exercised.
The daemon was qualified and rejected on concrete counterexamples; its code is
not shipped. The in-process parser cache remains bounded by content validation.
Corpus replay does not establish classifier accuracy or historical enforcement.

## Governance boundary port

The shared lexer keeps literal targets, dynamic populations, broad operations,
unrepresentable operands, and unsupported coordinate/nesting facts separate.
It recognizes executable argv positions and nested substitutions without running
command text. Option values and copy sources are excluded from mutation targets.
Worktree-operation policy consumes command positions, including nested commands;
quoted prose and file-sink heredocs do not introduce operations. No message-command
exemption remains: a sibling mutation after `caws message poll;` is checked.

Both write guards use the same early ask-capability check. `bypassPermissions`
turns unresolved-write approval requests into refusals; a benign read still
passes. Other permission mode names are not inferred to auto-approve. A linked
worktree cwd no longer bypasses foreign canonical claims; ignoring its own claim
requires a matching stamped owner. Lease absence does not release that authority.
Physical path normalization occurs before the Bash cross-repository check.

### Concrete scenario artifacts

All paths below are under `/private/tmp/caws-hook-qualification-20260912/`.
`governance/selection-goybjg2s/foreign-0.command.json` records exit 2 and
`foreign-0.stderr` names foreign worktree ownership. `preserved-1.command.json`
records exit 0 for copying the same foreign source to an owned destination.
Both receipts name the sentinel whose SHA256 remains
`53a30500b1a4c0c8193248339fc32c73b626a7a2a1ac5fea50dfa86f45882cd5`.
The sentinel was never submitted to a native tool: this is evidence of hook
classification and no side effects in the experiment, not tool prevention proof.

`governance/selection-_p884q9a/interactive-ask.stdout` contains
`permissionDecision: ask`; `automatic-block.command.json` records exit 2 and
its stderr names `mode=bypassPermissions` and `ask_dynamic_unconfined`.
`governance/selection-hgneivqg/canonical-foreign.stderr` names
`claimed:foreign:src/foreign/`. The paired own-session receipt exits 0;
the impostor-session receipt exits 2 for `claimed:mine:src/mine/`.

The installed command-position experiment is retained in
`governance-operations/selection-*/operation-*.{input.json,command.json,stdout,stderr}`.
It preserves three prose/heredoc examples and refuses three executable forms,
including `echo "$(git sparse-checkout disable)"`.
The cross-repository experiment under `governance-projections-before` exposed
an exit-0 dot-segment bypass despite a passing direct-path control. After path
normalization, `governance-projections-after` retains exit-2 refusals for direct,
`..`, and symlink projections, with the sibling sentinel unchanged.

Commands run from the lane (or package root for Bats):

- `python3 packages/caws-cli/tests/hooks/pytest/test_bash_mutation_boundary.py -v`:
  exit 0, 10 semantic tests, including multiple operands and preservation cases.
- `CAWS_EXPERIMENT_ARTIFACTS=/tmp/caws-hook-qualification-20260912/governance
  PYTHONDONTWRITEBYTECODE=1 python3 packages/caws-cli/tests/hooks/pytest/test_installed_governance_boundary.py
  InstalledGovernanceBoundary -v`: exit 0, initial three installed scenarios.
  The separately added operation and path-projection tests each subsequently
  exited 0; their retained directories above distinguish those executions.
- `../../node_modules/.bin/bats tests/hooks/bats/bash-write-guard.bats
  tests/hooks/bats/bash-write-guard-heredoc.bats tests/hooks/bats/worktree-write-guard.bats
  tests/hooks/bats/worktree-guard-base-push.bats`: exit 0, 28 preservation checks.

### What these checks could miss

This is a bounded recognizer, not a Bash evaluator. Arbitrary programs, shell
functions, aliases, interpreter payloads, and unsupported option combinations
can write files without yielding a recognized path. `cd`/Git coordinate changes
on recognized relative mutations are uncertainty, not guessed destinations.
Directory destinations and broad operations are conservative regions, not an
exact census of future writes. These guards complement the command classifier
and scope guard; these results do not prove the combined system covers every
shell mutation. Corpus replay must report unrecognized forms and latency,
without treating past successful execution as an allow label.

The existing `degraded_no_yaml` allow-with-diagnostic posture is preserved.
Canonical claim protection therefore requires examining the actual installed
oracle's dependency resolution; foreign worktree payload protection is YAML-free.
No fresh native harness approval UI, native tool non-execution, hostile filesystem
race, or global runtime adoption has been verified by this chunk. Before claiming
those, capture the native refusal and absence of its tool-result event, the selected
installed digests, and authority/path state at that same invocation boundary.

## Transcript fidelity and acceleration qualification

The installed renderer now consumes seven surface adapters, including the existing
Kimi wire contract. The Codex adapter still filters injected user-role material
using native content provenance and excludes internal analysis; its selected
machine seam delegates to shared normalization and remains callable directly.
Tool source/output records retain full Codex and Bash payloads, with explicit
length/truncation fields. Inner `functions.exec` calls are an optional source
index: comments/string literals are excluded, runtime template interpolation is
unresolved, and every projected action says `execution: not_observed`. Even an
unexecuted conditional contains syntax; the index does not prove it ran.

Turn context carries source-declared parentage with `authority: none`. Hook
sidecars are session-filtered and carry handler-return/delivery boundaries.
Malformed JSONL is diagnosed; the parser does not salvage an embedded object
from damaged text. The selected machine audit directory feeds the render.
Stop's own hook-return record remains available only to a later reconstruction.

A missing or empty transcript cannot erase existing human history, even when
new hook sidecars exist. `.render-state.json` names `retained_missing_transcript`
or `retained_empty_source`, sets `outputs_current: false`, and lists input/output
hashes. Writers take an OS lock before input reads; each turn replacement is
atomic. This is not a transactional snapshot across all turn files for readers.
An explicitly configured `CAWS_TRANSCRIPT_DATABASE` supports OpenCode/ZCode
SQLite projection in one read transaction, with session-qualified rows and an
atomic JSONL projection/receipt. Empty results replace projected bytes with an
empty file and do not reuse an old projection as a hit. Live database schemas,
compressed transcript discovery, and native subagent-store discovery remain
unverified; parent metadata is not a census of child sessions.

### Observed artifacts

Scratch root remains `/private/tmp/caws-hook-qualification-20260912/`.

- `fidelity-final/selection-3a68y0mo/repo/.caws/sessions/codex/turn-001.json`
  contains the 227-character raw program and 13,027-character error output,
  `is_error: true`, `output_truncated: false`, and parent `parent-session`
  labeled metadata with no authority. `schema-validation.json` is
  `{valid:true,errors:null}` with undeclared contract fields forbidden.
- `fidelity-final/selection-f5tdj6h9/repo/.caws/sessions/codex/turn-001.json` contains the new
  `guard-fixture` sidecar, `status: blocked`, `observation_boundary: handler_return`,
  and `delivery: not_observed`. The foreign-session sidecar is absent.
- `fidelity-surfaces-after/selection-*/surface-*.command.json` retains the six
  other installed surface cases. The first run exposed Kimi's overly broad
  timestamp matcher swallowing DSH rows; the repaired matcher preserves both.
- `fidelity-database-final/selection-kidwngt8/repo/.caws/sessions/{opencode,zcode}/`
  retains projections, receipts, turns and render-state. After source-session
  deletion, the projection is empty and preserved turns are explicitly stale.
  The database byte hash remained unchanged during the read-only render.
- `fidelity-context-final/selection-*/codex-fidelity.command.json` is the final
  Codex check after repairing direct adapter imports and the unborn-branch
  `HEAD\nunknown` capture. The fixture now records branch `main`.

`python3 .../test_installed_session_fidelity.py InstalledSessionFidelity -v`
with the scratch-root environment passed the four initial scenarios (seven
surfaces), followed by passing targeted database and final Codex scenarios.
The existing renderer pytest suite passed all 48 checks using the canonical
`packages/caws-cli/tests/hooks/pytest/.venv/bin/python` (system Python lacks
pytest). The 39-case adapter run passed 38 and exposed a direct-adapter import
regression; after its repair, that exact failed test passed on a targeted rerun.
No claim that the initial full run was green is made.

### Daemon adoption refused by runtime counterexamples

Command: `python3 scripts/hook-experiments/qualify-render-daemon.py
--candidate-hooks ../sterling/.caws/hooks --output <scratch>/daemon-candidate-runtime`
(using the absolute Sterling path in the retained argv). The sandbox denied the
first loopback bind; the isolated rerun with loopback permission exited 0.
That historical exit meant all four predicates matched, not adoption success.
Review subsequently found the source-change predicate insufficient: an `ok`
response and a comment-only edit cannot establish stale execution. The behavioral
replacement and independently executed controls are recorded below.
`daemon-candidate-runtime/qualification.json` reports `adoption: refused`:

- A sidecar append returned `ok 2 0 cached`; output hash stayed
  `e41cdd1fbf01dedd05fad900e2f354df0f3a42c2a5060ff357c5d18acd4cb458` and the new
  outcome was absent.
- A corrupted turn file returned `ok 3 0 cached` and retained the corruption.
- Changed source bytes with preserved mtime returned `ok 4 0 cached`; this original
  observation alone did not establish a source-freshness counterexample.
- An expired lease naming an unrelated experiment-owned child caused that child
  to exit -15. No live agent PID or lease was used.

The daemon/client were not installed or enabled. Before adoption, require code,
sidecar and output content hashes, no unbound PID reaping, and serialized fallback
writers, then replay timeout, concurrent writer and real process-identity cases.
Those latter cases and native latency were not verified. An idle lease alone
never establishes process identity or ownership.

`qualify-transcript-cache.py` separately compared the retained in-process parser
cache against fresh parsing: cold, unchanged, append, same-size/mtime rewrite,
truncate, inode replacement, partial line, completed partial line, and adapter
failure rollback all matched (exit 0). `transcript-cache/qualification.json`
contains event hashes and timings. The unchanged synthetic 1,000-row input took
0.34 ms cached versus 5.24 ms fresh in one measurement; this is neither a native
hook latency result nor a benchmark distribution. No warm daemon was adopted.

## Corpus replay

`replay-terminal-corpus.py` streamed all 265,615 records (1,048,757,243 bytes),
SHA256 `e6331a98ed474acaa5d8ace090366e442b9ea46843a3eab5d18aff03c2cf50b8`.
`corpus-replay-final/replay.json` records the exact command, classifier digest,
census and latency. The deterministic harness/outcome/length sample contains
698 occurrences: 598 allow, 98 ask, 2 deny; all returned, none timed out.
23 attempted context probes were replaced with explicit unavailable context.
Captured cwd, Git index, authority, adapters and environment were not restored.
These are text classifications, not historical enforcement verdicts or labels.
No false-positive/negative rate follows from historical success/denial counts.

The replay uses command text only as function input. Process/write operations
are refused by a worker audit hook; context probes cannot run Git or consume a
trusted-init token. `test_replay_boundary.py -v` exited 0: a synthetic captured
`touch` left its sentinel absent, and an injected classifier attempting a real
file write was observed as `execution_attempt_refused`. Byte offsets/hashes in
`sample.json` permit local review without copying private commands into Git.
The first replay runner used the wrong return shape and produced 698 harness
AttributeErrors; those results are invalid for classifier assessment. The corrected
run above exited 0 and all 698 rows have `status: classified`.


## Optional consumer utilities

`hook-utilities.sh` is shipped as an optional extension and is absent from default
chains. With no `CAWS_OPTIONAL_HOOK_POLICY`, it emits nothing. An explicit consumer
JSON file may contain:

```json
{
  "version": 1,
  "rg_replace": true,
  "ignored_staging": true,
  "focused_tests": {"executables": ["pytest"], "entry_point": "scripts/test"},
  "documents": {"roots": ["docs/"], "required_frontmatter": ["title", "status"]}
}
```

Set `CAWS_OPTIONAL_HOOK_POLICY` to that file's absolute path in the consumer
harness environment. Add `{"handler":"hook-utilities.sh","before":null}` to
its reviewed `extensions.pre_tool_use` policy using the existing
[`init adapters migrate --from` workflow](../guides/hook-packs.md); preserve the
consumer's other reviewed entries. No machine/project policy was globally enabled
in this task. A migrated consumer's configuration update must retain its reviewed
native registration and be checked through `--describe` and a real invocation.

Replacement search is advisory because `-r n` can be intentional. Command
positions, wrappers, option values, literal prose and `--` are distinguished.
Focused-test advice grants no resource admission. Document checks are configurable
frontmatter-key presence notices on Write, not YAML semantic validation, Edit
coverage or repository-wide documentation enforcement.

Forced staging uses fixed read-only Git ignored-path queries and supports literal
cwd, `-C`, whole-tree selection, NUL pathspec files, literal pathspec mode and
tracked-only updates. Only confirmed ignored-file selection blocks. Dynamic or
complex shell coordinates, unsupported options, quoted pathspec decoding and
unavailable pathspecs produce visible unresolved advice. These utilities are not
an exhaustive shell/Git enforcement boundary. File/pathspec races and exotic Git
environment semantics remain outside the verified envelope.

### Installed artifacts and counterexamples

`python3 packages/caws-cli/tests/hooks/pytest/test_installed_hook_utilities.py
InstalledHookUtilities -v` exited 0 (three scenarios, 78.919 s) with
`CAWS_EXPERIMENT_ARTIFACTS=<scratch>/utilities-isolated`. This includes repeated
subcases, not a per-hook latency measurement. Retained receipts contain exact
native payload, argv, runtime digest and exit status:

- `utilities-isolated/selection-i1sse5k9/ignored-0.command.json`: captured
  `git add -f private.generated` returns 2; `ignored-0.stdout` names the file.
- The same directory's `stage-preserved-1.command.json` returns 0 for source
  staging, and `stage-unresolved-0.stdout` explicitly declines a subshell cwd
  guess. Ordinary add, dry-run, tracked-only update and literal wildcard
  preservation cases returned 0.
- `utilities-isolated/selection-yrc7m1tp/replace-0.stdout` says
  `Ripgrep replacement is active`; quoted prose and option-value controls are quiet.
- `utilities-isolated/selection-x46zrfvr/document-large.stdout` contains
  `Consumer document metadata missing: title, status.` for a 125,000-character
  input transported through the payload file.

The first installed run exposed a real no-op: the utility read unavailable
`HOOK_INPUT_JSON` instead of `HOOK_TOOL_INPUT_JSON` for small inputs. All three
scenarios failed until the transport was repaired. Subsequent failures came from
fixture assumptions: repeated same-session notices are deliberately deduplicated,
and Claude block JSON stays on stdout. Independent cases now use separate session
identities and inspect the correct surface output. This does not disable or evade
production deduplication.

## Concurrent rendering sensitivity

The installed renderer's controlled two-process scenario exited 0. In
`fidelity-concurrent/selection-lv8dm0ps/lock-observation.json`, the first process
is inside its adapter, the second has attempted rendering, and
`second_blocked_before_read` is true. Both command exits are 0; final
`repo/.caws/sessions/codex/turn-001.json` contains `second snapshot` and its hash
matches `.render-state.json` with `outputs_current: true`.

`python3 scripts/hook-experiments/sensitivity.py --case renderer-lock --output
<scratch>/sensitivity-renderer-lock` exited 0. The control exits 0; deleting
`fcntl.flock` only in a disposable template copy causes exit 1 at the exact
assertion `second renderer read inputs while first held the lock`. Both installed
runtimes, commands, source hashes and outputs are retained in
`sensitivity-renderer-lock/summary.json` and its referenced directories. This is
one additional defect sensitivity check, not exhaustive race coverage. The test
uses a controlled adapter for scheduling; it does not prove native scheduling,
crash recovery, host-path race safety or a multi-file reader transaction.

## Proof boundaries before broader adoption

A passing suite could still hide unsupported executable wrappers, interpreter
payloads, unmodeled shell/Git options, stale native registrations, missing source
rows, a live database schema mismatch, or lost delivery after handler return.
Syntax-indexed inner actions do not establish execution; parentage and leases do
not establish ownership. A source digest taken before dispatch does not bind an
executable against hostile replacement while running.

Before claiming deployment or native protection, examine a fresh harness sequence:
selected paths/digests, SessionStart envelope, a harmless foreign-owned write
refusal with unchanged sentinel, delivered guard output, and Stop turn artifacts
with matching sidecar/input/output hashes. Verify the consumer's actual YAML/oracle
dependencies and native permission modes. For database discovery, inspect a live
schema and source-row custody receipt. For classifier accuracy, add independently
adjudicated labels and reconstructed authority/context states. Daemon adoption
requires repairing and replaying all four counterexamples plus process-identity,
timeout, concurrent-writer and native-latency experiments.

Not verified: global machine installation, fresh real native harness execution,
recipient-visible delivery, actual tool nonexecution after a native refusal,
live OpenCode/ZCode databases, compressed/native child transcript discovery,
arbitrary shell semantics, hostile filesystem races, or classifier error rates.


The strengthened staging rerun uses an actual prepopulated Git index and retains
`utilities-index-custody/selection-*/preservation.json` with before/after index and
ignored-sentinel SHA256 values. The targeted installed scenario exited 0 (36.820 s);
all captured command strings remained data. Only explicit fixture setup populated
the scratch Git index. The before/after index and sentinel hashes match.

## Final local validation

Shared pack 72, Codex 24 and Kimi 8 are the qualified source distribution. The
shared fingerprint is
`4c0286f98d2c5177d772f3998a34c9d5f774ddb32b910d75b2f769a861178d7a`.
The final fingerprint command exited 0 (14 checks), and the shared command lexer
suite exited 0 (10 checks, 2.468 s). The package build passed after the optional
manifest registration. Generated installed runtimes, corpus replay, mutants and
logs remain under the scratch root, outside the source ledger.

`final-checks/` retains command/exit/stdout/stderr receipts for claim, doctor,
gates and whitespace validation. All five declared gates pass; this does not
establish native behavior or comprehensive semantic correctness. Doctor exits 1
with 1 error, 7 warnings and 14 informational findings: the error is another
session's removed `wt-advisory-budget` cwd, and the warnings include existing
legacy pack drift and missing foreign-owner leases. Those states were not repaired
or taken over. The selected global runtime remains the previously installed
version; source qualification does not silently replace it.

## Review repairs, 2026-09-13

Spec: `CAWS-HOOK-REVIEW-REPAIRS-001`. The seven must-fix findings were handled
before the experiment-verdict repair. Artifacts below are retained under
`/private/tmp/caws-hook-repairs-20260913/`; they are generated local evidence,
not tracked source or a claim of remote CI/native deployment.

| Finding | Repair and regression evidence |
|---|---|
| Mutations hidden by redirections or absolute wrappers | Preserve argv across redirections, including option values and FD prefixes, and recognize absolute `env`. `governance-red.command.json` exits 1; `governance-green.command.json` exits 0 (19 tests). `governance-observations.json` retains installed foreign refusals (2), owned destination/read-source/prose admissions (0), and the unchanged sentinel SHA256. `redirection-fd-red.stderr` records the quoted-numeric-operand counterexample; `mutation-green.command.json` exits 0 after repair (12 tests). |
| Repeat initialization refuses newly managed support files | The earlier header lane supplied the repair. `reinit/summary.json` records two real `node <lane>/packages/caws-cli/dist/index.js init --agent-surface codex` calls, both exit 0. `reinit/second.stdout` reports `Unchanged (73)`; all 144 hashed hook/pristine files retain their bytes. `distribution-jest.command.json` exits 0 (81 installation/header/fingerprint cases). |
| Logical versus physical root causes false refusal | Normalize both sides of the cross-repository comparison. `governance-observations.json` records logical/physical root controls: own writes 0, foreign writes 2. `governance-bats.command.json` exits 0 (24 cases using ordinary macOS TMPDIR). |
| Kimi structured output crashes | Restore the JSON import; exercise string, object, list, null and zero through installed Stop. `logging-red.stderr` contains the prior NameError. Installed fixtures retain each result in `kimi-result-<n>.turn.json`, including Unicode and error status. |
| Every handler blamed for a chain refusal | Derive status from each handler's own exit/envelope and retain adapter exit separately. `attribution-red.stderr` records all three handlers incorrectly blocked. The repaired mixed turn contains `success.sh=completed`, `ask.sh=ask`, `deny.sh=block`, raw exits all 0, adapter exits all 2, and `delivery=not_observed`. |
| Surface defaults lost through shared delegation | Codex supplies its own default without overriding an explicit platform; Kimi retains exit promotion without bootstrap flags. `logging-observations.json` records default `codex`, explicit `dsh`, and Kimi exits `0→0, 1→2, 2→2`. `logging-bats.command.json` exits 0 (35 preservation cases). |
| pytest assumes prebuilt installer | `pretest:pytest` runs the production build. `entrypoint-red.stderr` reproduces `MODULE_NOT_FOUND` in a source-only package. `entrypoint-green.command.json` exits 0; `entrypoint-*/command.json` records dist absent before/build present after, and `selection-*/repo/marker.log` contains `invoked`. The regression narrows the inner test command; build and runtime are real. Pip installation and remote CI are outside this control. |

The installed logging run in `logging-green.command.json` exits 0 (52 tests).
`logging-jest.command.json` exits 0 (82 adapter, resolver and fingerprint cases).
The initial mixed-chain fixture incorrectly expected a handler after a deny to
execute; that fixture was corrected before the decision-bearing red run in
`attribution-red`. Later fixtures preserve separate dispatch and render receipts
and each Kimi turn snapshot so successive renders cannot overwrite the evidence.
Shared/Codex/Kimi pack versions are 75/25/9, with updated fingerprint baselines.

### Discriminating daemon qualification

The source probe appends an execution marker to a disposable renderer copy,
changes `source-a` to same-length `source-b`, and preserves mtime. An independent
fresh interpreter must execute `source-b` and produce a parseable turn before the
warm request is judged. Missing or malformed markers are instrumentation failures,
not successful qualification. Exit 0 now means a completed experiment; the report's
adoption field separately remains `refused` or `unproven`.

`daemon-controls.command.json` exits 0 (four controls). Real renderer calls using
cached and freshly loaded modules return identical `ok 2 1 rendered` responses;
`source-control-*/source-freshness.json` distinguishes their markers and verdicts.
These are controlled module-cache tests, not a native daemon transport claim.
Missing cold and missing warm markers each raise instead of producing a verdict.

The real candidate replay is `daemon-candidate-loopback.command.json` (exit 0).
The first sandboxed attempt could not bind loopback; the approved rerun used only
experiment-owned child processes. Its `qualification.json` retains:

- Sidecar append: `ok 2 0 cached`; before and after output SHA256 both
  `6352b2af4181a9c689c88a8c3c02e4a07e14be8a7c74e3acd9caabf182ab139c`;
  `new_observation_present` is false.
- Corrupted output: `ok 3 0 cached`; output remains
  `corrupted same-count artifact`.
- Source change: mtime and size both preserved; fresh process 46295 emits
  `source-b`, while the warm marker remains `source-a` from process 46091.
  `fresh-source.command.json`, `fresh-source-control/turn-001.json` and both
  `.qualification-source-execution.json` files retain independent evidence.
- The reaper exits 0 and the unrelated experiment-owned child 46426 exits -15.
  This is an ownership-binding counterexample, not actual OS PID-reuse proof.

The candidate remains refused and unshipped. Before adopting it, inspect a replay
with code/sidecar/output content validation, process-start identity binding, and
serialized fallback writers; then examine timeout and concurrent-write receipts.

`daemon-reloading-control.command.json` supplies the other direction over real
loopback transport (exit 0). Its disposable daemon reloads the renderer and
bypasses the render-result cache on each request; `reloading-control-input/control.json`
records the exact change and hashes. The warm process 95438 and independent
process 95488 both emit `source-b`; source freshness has `counterexample: false`.
Sidecar inclusion and corruption repair also become observable. The remaining
reaper counterexample keeps adoption refused. This intentionally slow control is
not a proposed production daemon patch or a latency result.

### Test sensitivity and proof limits

`repair-sensitivity/summary.json` records matched green controls (exit 0) and
assertion failures (exit 1) after deliberately restoring chain-wide blame and
Codex's wrong default in disposable template copies. The failures match the
specific attribution/platform assertions. This establishes sensitivity for one
selected defect in each of `session_log_renderer.py` and Codex `parse-input.sh`;
it is not an exhaustive per-file mutation score. Governance and Kimi defects
also have incident-matched red/green fixtures rather than pass counts alone.

Tests could still pass while a harness selects older installed bytes, ignores a
denial, or never delivers an advisory. No global runtime was updated; no fresh
native harness activation, recipient visibility, actual prevented tool write,
remote CI, classifier accuracy, or production latency was verified here. Before
making those claims, inspect native SessionStart/PreToolUse/Stop records, selected
paths/digests, actual refused/allowed tool results, and resulting files. The shell
recognizer remains a bounded parser; these regressions do not establish complete
Bash grammar coverage. Corpus commands were not executed or relabeled.

### Final validation for the repair lane

Every command below has a corresponding `<label>.command.json`, `.stdout` and
`.stderr` under the repair scratch root. These receipts include cwd, argv, exit
and duration; the installed pytest fixtures additionally retain runtime files.

| Label / command | Exit | Observed result |
|---|---:|---|
| `full-pytest`: `<pytest-venv>/bin/python -m pytest -q packages/caws-cli/tests/hooks/pytest` | 0 | 225 passed; 17 pre-existing datetime deprecation warnings. `full-pytest/selection-c329a2_j/kimi-result-1.turn.json` retains `{"text": "résultat", "count": 0}` with `is_error: true`; the other four snapshots retain string, list, null and zero. `selection-iw55i6zy/mixed-handlers.command.json` retains dispatch exit 2 and the deny envelope, separately from the Stop render receipt. |
| `full-jest`: `node <repo>/node_modules/jest/bin/jest.js --runInBand` from the CLI package | 0 | 2,761 passed across 220 suites (1,244.668 seconds). |
| `full-bats`: `node_modules/.bin/bats packages/caws-cli/tests/hooks/bats packages/caws-cli/tests/hooks/bats-macos` | 1 | 275 passed, seven process-identity fixtures failed inside the sandbox. `sandbox-ps.json` records `PermissionError: Operation not permitted` when launching `ps`. |
| `bats-process-controls`: Bats with the seven failed names selected across `block-dangerous.bats`, `session-id-agent-pid.bats`, `session-id-canonical.bats` | 0 | All seven pass unchanged with approved process access. These existing fixtures clean up their sentinel files; their retained evidence is the TAP output, not a preserved native session trace. The full suite was not rerun outside the sandbox. |
| `build-logging`, `final-typecheck`, `final-lint`: package build, typecheck and lint | 0 | TypeScript compilation/checks and ESLint pass; Bash syntax checks pass for 64 scripts. Informational ShellCheck warnings remain in the retained lint output. |
| `entrypoint-artifacts`: source-only entrypoint regression with a previously absent artifact directory | 0 | Real build and installed marker pass; the requested scratch root is created and receipts retained. This is the only test-source adjustment after the full pytest run. |
| `final-gates`: `caws gates run --spec CAWS-HOOK-REVIEW-REPAIRS-001` | 0 | All five declared gates pass, zero violations. |
| `final-doctor`: installed `caws doctor`; `source-doctor`: built CLI `doctor` | 1 | Existing foreign session's missing `wt-advisory-budget` cwd and seven warnings remain. Built CLI reports 1E/7W/15I; installed CLI reports 1E/7W/14I. No foreign ownership or machine configuration was changed. |

The passing rerun closes the process-access explanation for those seven fixture
failures. It does not establish actual OS PID reuse, a global runtime update, or
any native harness delivery claim. The read-only lane review reports every source
commit in scope; acceptance evidence is recorded separately through the CAWS CLI.

## Live machine adoption, 2026-09-13

Spec: `CAWS-HOOK-LIVE-ADOPTION-001`. This section advances the earlier local-only
boundary for the reviewed repairs; it does not adopt the refused daemon. The
installation and check receipts live under
`/private/tmp/caws-hook-live-20260913/`. Generated evidence remains outside the
tracked ledger. The repair source at `4ca79ddd9723cf11c5deb4d292833d577e61dd3a`
is unchanged by this operational slice.

### Installed bytes and registration

`cli-install.command.json` records exit 0 for
`node scripts/install-cli-snapshot.mjs --package packages/caws-cli --bin /Users/darianrosebrook/.nvm/versions/node/v22.19.0/bin/caws --caws-home /Users/darianrosebrook/.caws`.
The active standalone CLI is `12.2.0-rc.1`, installed under
`~/.caws/lib/cli/56c59c3da31d41fc-oCvYOI/install/node_modules/@paths.design/caws-cli`;
its package SHA256 is
`56c59c3da31d41fc19c5dc6acd5b5c3301d7f87f138ddfde48ceb4bad399b640`.
The version label did not change; the snapshot and bytes identify this update.

`runtime-install.command.json` records `caws init adapters install --json`, exit 0.
The active runtime digest is
`94bff191a0b3a66797d55a9286fb26a71c3d1ecc890d3a91130c0b468ba165f3`.
`live-byte-parity.json` contains eleven source/installed-package/runtime SHA256
triples, all equal, including the lexer, write guard, classifier, renderer, Kimi
reader, session cache, shared dispatcher, Codex parser and Kimi dispatcher.
`live-selection.json` records the actual system launcher's selected paths and
digests. `runtime-recheck.command.json` exits 0 and reports `changed: false`.
The previous CLI snapshot `549db82cc4cbac3d-7xnQet` and runtime
`db759a4ccb13108d81082cc8a64aa0172f32af5ebb9d90e21a7ae29ed321fc00`
remain available for rollback.

`codex-registration` and `claude-code-registration` receipts record
`caws init adapters configure --agent-surface <surface> --plan --json`, both exit 0
with `changed: false`, `changes: []`, `restartRequired: false`. Existing native
registrations already launch the shared machine runtime. Project customizations
were preserved; legacy project hook copies were not overwritten. The unsupported
surface spelling `claude` was refused with exit 1 before the correctly named
`claude-code` preview; no registration was changed by either preview.

### Runtime artifacts and their limits

The live launcher replay is retained at
`.tmp/caws-hook-live-adoption/scenario-hciwz1ed/summary.json`, together with each
command, input, stdout and stderr. Running
`python3 .tmp/caws-hook-live-adoption/live-scenarios.py` exits 0. It calls the
installed `~/.caws/bin/caws-hook codex <event> --system` against an initialized
disposable repository: SessionStart 0, Read 0, top-level-file exemption 0,
foreign-path Write 2, Stop 0. The refusal envelope says `decision: block` and
names the foreign path. Its `repo/.caws/sessions/caws-live-adoption-fixture-20260913/`
directory retains the envelope, lease-related observations, 31 handler records
all naming the active runtime, and `turn-001.json`. The turn preserves user text
`CAWS live runtime lifecycle control.`, command output
`live runtime fixture output`, and `status: blocked`.

This is a synthetic-payload replay of the real installed launcher. Neither the
embedded command nor either proposed write was submitted to an execution tool;
their absent output files alone therefore do not demonstrate prevention.
Separately, `native-refusal.json` records an actual native Write refusal from this
session at `2026-09-13T05:21:27Z`: invocation
`32256c91-065f-4dc2-a296-6bd86fe0e75e`, tool call
`exec-aa2eed67-1ef8-42d9-bbd4-086e910e0c1d`, scope handler exit 2, adapter exit 2,
active runtime digest, and `outside_helper_exists: false`. The native tool returned
the refusal and did not create the helper. Work continued only after adding an
in-repository fixture path through the spec CLI. `native-current-events.json`
retains actual PreToolUse/PostToolUse observations from this session.

Failed setup runs were retained too: a substituted HOME disagreed with the
configured native symlink target; sandbox permissions prevented creating the
fixture's machine audit-cache directory; and an initial relative cwd was repaired.
The absolute-cwd rerun still admitted the proposed top-level file. Source inspection
identified the existing `REL_PATH`-without-slash exemption in `scope-guard.sh`;
the final replay explicitly records that admission and tests foreign containment
separately. This qualification does not assert that every unbound write is refused.

### Checks and remaining non-claims

`build-current` and `root-lint` command receipts exit 0. `dependency-audit-root`
records `npm audit --package-lock-only --audit-level=low --include-workspace-root`;
`consumer-audit` records `npm audit --omit=dev --audit-level=low --workspaces=false`
inside the detached installation. Both exit 0 with `found 0 vulnerabilities`.
The initial audit script lookup was a workspace-resolution failure, not an audit
verdict. `live-gates` exits 0 with all five gates passing. `live-doctor` exits 1
with the existing 1E/7W/15I findings, including another session's missing cwd.
Foreign sessions and claims were left untouched.

The exhaustive repair-suite results above remain the test baseline;
`git diff --exit-code 4ca79ddd -- packages/caws-cli scripts` exits 0. They were not
rerun after documentation and governance-only changes. This checkout's configured
`.husky/_` wrapper files are absent, so check results are from explicit commands,
not a claim that Git automatically ran the hook scripts.

Passing fixtures could still miss a native harness dropping an advisory, a stale
project override, or an unsupported shell form. Handler-return and adapter-handoff
records do not establish recipient visibility. Not verified here: fresh native
SessionStart/Stop across Codex, Claude and Kimi; every legacy project override;
arbitrary shell semantics; classifier error rates; production latency; remote CI;
or an npm release. Those claims require fresh per-harness native lifecycle and
tool-result traces with matched source/input/output hashes, project selection
inventories, and independently adjudicated semantic cases before broader claims.

## RC2 CI repairs and unresolved scope counterexamples — 2026-09-13

Spec: `CAWS-RELEASE-CANDIDATE-REPAIRS-001`. The tested, pushed candidate is
`cd362d7bb71a5475e77df1024bbcb8a66b85ba93` on `wt-release-candidate`:
`4942c6e7` repairs CI/evidence and `cd362d7b` prepares unused version
`12.2.0-rc.2`. This is not tag approval. The scope counterexamples below remain
unfixed at that commit. No RC2 tag or package was published.

Generated artifacts are outside the source ledger at
`/private/tmp/caws-release-candidate-20260913/` (abbreviated `E/` below).
Local command receipts include argv, cwd, exit status and duration; corresponding
`.stdout`/`.stderr` files retain the output. Downloaded CI artifacts are also
available from the linked GitHub runs; the local temporary copies are not a
permanent archive.

### Executed CI and concrete artifacts

`gh workflow run release-qualification.yml --ref wt-release-candidate` dispatched
[Release Qualification 34744744419](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34744744419)
at exactly `cd362d7b`; its conclusion is success. `E/qualification-ci.log` records
2,763 Jest tests in 220 suites, all 277 Bats cases, and 225 pytest cases passing.
The formerly failing Bats case is explicitly `ok 202 advisory budget: the byte
cut is character-aligned and reconstructs the card`. Build, lint, typecheck,
dependency audit, documentation checks and 34 Node contracts also succeeded.
Coverage is retained in `E/ci-coverage/`, including LCOV, the full map and summary;
the total line coverage is 12,709/17,918 (70.92%). These totals do not establish
native child-process coverage or correctness of untested branches.

All six packaged-upgrade jobs (Linux/macOS, Node 18/20/22) succeeded; macOS Node 22
also ran the Bash 3.2 regression suite. Each downloaded
`E/ci-upgrade/upgrade-cd362d7b…-<os>-node<n>/qualification-report.json` identifies:

- Candidate tarball SHA-256:
  `784c4d056ad79e68180b0f6d7d976edfffff035a21895c0915f115a870fe122e`.
- Runtime digest:
  `94bff191a0b3a66797d55a9286fb26a71c3d1ecc890d3a91130c0b468ba165f3`.
- Nine scenario cases and a unique `qualification-report.json.artifacts/run-*/`
  directory with 66 raw command receipts: 57 exit 0 and nine expected exit 2.
- Four before/after governance hash maps with identical contents. The raw
  command receipts include guarded denials, custom-hook marker output, a
  `Runtime modified` refusal after corruption, and successful rollback calls.
- A source transcript, hook-event log and rendered `turn-001.json` preserving
  `Keep the migration evidence and this exact operator request.` The embedded
  `pwd`/`fixture-directory` result is synthetic transcript data, not an assertion
  that a native agent executed that command.

`E/ci-upgrade/inspection.json` records the independent artifact inspection.
The same tarball hash was observed in the local `upgrade-rc2` run (exit 0).
Its detached consumer audit found zero vulnerabilities; the consumer lock SHA-256
was `7307b9a6d1ab848da12c15af21ae7bb8deb748a2804223bd88fccba2e476ce5d`.
The deliberately absent-baseline run, `upgrade-failure-control`, exited 1:
its schema-v2 report has `ok: false`, and its first command receipt retains
npm exit 254 and `ENOENT`. A failure no longer discards all qualification evidence.

`gh workflow run ci-matrix.yml --ref wt-release-candidate -f version=12.2.0-rc.1`
dispatched [CI Matrix 34744746927](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34744746927).
All six Linux/macOS/Windows × Node 20/22 cells succeeded. Each downloaded
`matrix-target.json` and `installed-version.txt` names `12.2.0-rc.1`; npm metadata
names gitHead `6c8770329027061bcb3ca782cee65283106e722c` and the same SHA-512
integrity. `E/ci-consumer/inspection.json` retains the cross-cell comparison.
This tests the corrected consumer workflow with an already published package;
it does not establish post-publication RC2 behavior.

The resolver was also run against the real successful RC1 Release occurrence
34290895543 and live npm metadata (`E/matrix-live/matrix-target.json`). It selected
RC1 and matched that run's commit, although `latest` was still 12.1.0. Disposable
matched mutations in `E/resolver-sensitivity/` kept the same test suite: the
unchanged control exited 0; deleting commit equality exited 1 in the wrong/missing
gitHead cases; substituting `latest` exited 1 in six release identity cases.
The failures were assertions, not syntax/import/setup failures. The automatic
workflow_run path has not yet run after a new release using this workflow.

### Unicode transport diagnosis and sensitivity

The previous failed run 34741052772 reported a surrogate encoding error in the
alignment fixture. `E/unicode-transport-red.*` reproduces it using a wrapping
Base64 encoder. `E/transport-diagnosis.json` distinguishes the valid 150-byte
hook context from the fixture's truncated 57-byte capture ending in an orphan
`0xf0`. The repair reads exact output files rather than extracting only the first
Base64 line; no production truncation behavior was changed to satisfy the fixture.

`E/ci-hook-bytes/` retains JSON, exact context bytes, stderr and assertion receipts
for all 21 budgets from 600 through 620. Sixteen cases retained 116 body bytes;
five retained 120. Budget 605 emitted 150 bytes with SHA-256
`9ae32609ec42a65e82ed29e5a4a20411a66c9f9824e2896571892b1485a318dd`.
The exact Python assertion extracted from the committed Bats fixture was rerun
against those downloaded bytes (`E/unicode-sensitivity/inspection.json`):
unchanged bytes exited 0, deleting one continuation byte exited 1 with
`UnicodeDecodeError`, and changing the elided-byte count exited 1 with
`kept/elided arithmetic lost bytes`. The sweep covers these byte boundaries,
not arbitrary grapheme clusters, arbitrary Unicode or every composer budget.

### Scope defects that green CI still misses

The user selected identical scope rules for root and nested files. Production
`scope-guard.sh` still exits early when `REL_PATH` contains no slash. Added Bats
regressions (`E/root-scope-red.*`, exit 1) distinguish admitted root files from
rejected or unreadable-diagnostic root files; the latter two currently receive
empty output instead of the nested-path scope response. The positive case alone
would pass with the implementation still wrong.

A real CLI fixture in `packages/caws-cli/scripts/scope-runtime-smoke.test.mjs`
creates two active, bound worktrees through CAWS, with deliberately conflicting
canonical and lane answers. The valid completed reproduction exits 1
(`E/scope-runtime-red-complete.*`). Its raw artifact is
`E/scope-runtime-red-complete/scope-runtime-JCm2UW/scope-decisions.json`:

| Target in the owning lane | Canonical answer | Lane answer | Actual installed guard |
| --- | --- | --- | --- |
| `package.json` | no authority | admit | Silent exit 0 (root exemption masks the wrong cwd) |
| `src/owned/ok.ts` | no authority | admit | Exit 0 with an erroneous ambiguous-scope strike |
| `blocked.json` | admit | reject | Silent exit 0 |
| `src/other/no.ts` | admit | reject | Silent exit 0 |

The guard resolves `WORK_DIR` from the target worktree but invokes both CLI scope
commands from its inherited process cwd. Stub CLI tests cannot catch this;
the installed real CLI fixture can. Two earlier fixture setup attempts (invalid
spec ID, then an unbound second spec) are retained and are not defect evidence.

The required repair is to remove the root-file exemption, run both CLI scope
commands in the resolved `WORK_DIR`, preserve fail-closed diagnostic handling,
bump the shared pack version/fingerprint, and require these real CLI regressions
in qualification. The existing progressive-strike policy is a separate contract:
its first scope rejection can admit with an advisory. Equal root/nested treatment
does not mean every unauthorized first attempt is a hard block.

At this checkpoint the native scope guard blocks editing its source because it
evaluates canonical union authority. The session owns `wt-release-candidate`,
and `caws scope check` inside the lane admits the path. No session-reroot tool is
available. The prior protected-paths reprieve expired at 07:09:53 UTC; the requested
human-only, session-scoped `scope-guard.sh,protected-paths.sh` reprieve has not
been granted. No alternate write route was used to bypass the refusal.

### Completion boundaries

The first full [Mutation Gate 34744745702](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34744745702)
at `cd362d7b` failed its store floor. All 19 report source bodies match the
candidate sources (`E/ci-mutation/inspection-initial.json`); this was not stale
report reuse. `messages-store.ts` scored 911/1,208 detected (75.41%): 905 killed,
six timeouts, 182 survivors and 115 without coverage. Kernel and shell met their
per-file floors. Runtime/compile errors are not counted as kills by the gate.

The mutation policy omitted the existing dead-recipient pruning suite, leaving
that selector unexercised in mutation despite its normal Jest coverage. Commit
`714f24c3c2e25e5fa51a78af19c505ec07852633` adds the suite, pins its inclusion in the
mutation configuration test, retains raw pruning artifacts in qualification, and
adds an archive-failure preservation control. The 80% per-file floors and target
inventory remain unchanged. `retention-tests-final` exits 0 with 36 tests in three
suites. `mutation-store-dry-run-permitted` exits 0 and discovers five source files,
eight test files and 2,249 mutants. Its prior sandboxed attempt failed before tests
on the Stryker logging socket (`listen EPERM`), not on a mutant or assertion.

`E/retention-runtime-final/` contains nine invocations with their input, result,
before/after ledger bytes, archive state and lease files. Its `inspection.json`
confirms both negative controls preserve identical ledger bytes:
`dead-recipient-prune-S0ApgU` returns `store.leases.dir_unreadable` with no archive;
`dead-recipient-prune-ru5Wdm` returns `store.messages.archive_append_failed` with
a directory in place of the archive file. Successful apply archives exactly the
selected message `m-pruned`, expired `offer-gone`, and selector-bearing prune
marker, retaining every other ledger line. Live/idle recipients, pending offers,
newer messages and delivered messages are skipped for their respective reasons.
The archive failure is an ordering sensitivity control; final archive contents
alone could still pass if a faulty implementation rewrote the ledger too early.
This does not establish crash durability, fsync guarantees or arbitrary concurrent
filesystem failure behavior.

Full mutation and qualification were dispatched again at `714f24c3`:
[Mutation Gate 34746026634](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34746026634)
and [Release Qualification 34746027714](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34746027714).
Both runs completed successfully, and the reports were downloaded and inspected.
`E/qualification-repair-ci.log` records 2,764 Jest tests, all 277 Bats cases and
225 pytest cases passing. `E/ci-repair-qualified/inspection.json` verifies all six
upgrade tarball identities, 66 command receipts per cell, equal governance hashes,
and the retained archive/lease failure controls with unchanged ledger bytes.

`E/ci-mutation-repaired/inspection.json` records exit 0 from all three local
`assert-mutation-report.mjs` checks against the downloaded reports, exact source
body equality for all 19 targets, and no runtime/compile-error or pending verdicts.
`messages-store.ts` now scores 970/1,208 (80.30%): 964 killed, six poll/wait timeouts,
226 survivors, 12 without coverage. The omitted suite brings 103 formerly
uncovered mutants into execution: 59 are killed and 44 survive. The six timeouts
alter wait bounds or poll-loop termination; two report explicit hit-limit reasons.
Timeouts count as detected under the existing policy; they are not assertion
kills. This meets the 80% floor, not an exhaustive correctness claim. Across all
19 targets, 597 mutants survive and 67 lack coverage; their report locations and
replacements remain available for further focused tests and equivalence review.

CAWS gates passed all five dispositions. `E/doctor-candidate.command.json` records
doctor exit 1, with the existing 1E/7W/15I findings: another session's missing cwd
and legacy hook-copy drift remain unresolved. Foreign ownership/state was not
changed. The installed runtime remains the digest above; RC2 metadata alone
does not update the machine installation.

Before continuing to tag approval, inspect the repaired scope fixture's complete
decision/command artifacts, root rejection and legitimate-write controls, changed
pack fingerprint and installed runtime digest, then qualify that exact repaired
commit. Fresh native Codex/Claude/Kimi traces must separately show normal trust,
SessionStart, an actual admitted tool write, an actual refused tool write with
unchanged target bytes, and Stop/session rendering. Directly feeding hook payloads
does not demonstrate native tool prevention or recipient visibility.

Not verified here: those fresh native lifecycle sequences, RC2 publication,
post-release RC2 consumer installation, every legacy project override, arbitrary
shell semantics, classifier error rates, production latency, or the unshipped
render daemon. The active spec remains open; green qualification for `cd362d7b`
must not be cited as evidence for the still-pending scope implementation.

The scope counterexamples are retained as a separate failing test checkpoint,
after the `714f24c3` mutation repair. They are now required by qualification:
the Bats root cases fail against the exemption, and the real CLI scope probe
runs even after a Bats failure. This is an intentional failure-control experiment
and a release blocker, not an xfail, skipped test or repaired implementation.
It also permits observing pytest and artifact retention after actual failed steps.
The checkpoint remains unmerged while the human-only reprieve is pending.

The checkpoint is `42e878804a9df4af4517132e24f20b08258f9985`.
[Qualification control 34746411914](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34746411914)
failed as intended: Bats cases 226 and 227 failed, and the installed real CLI scope
probe exited 1. Then pytest completed with 225 passing cases and the hook artifact
upload succeeded. `E/scope-control-ci.log` records the two exit-1 steps followed
by pytest success and artifact ID 10313719435. The downloaded
`E/ci-scope-control/hook-bytes-42e8788…/scope-runtime-9Jg8UP/scope-decisions.json`
reproduces all four rows in the scope table above. `E/ci-scope-control/inspection.json`
retains the independent comparison. Thus the failure-continuation claim is backed
by an actual failed workflow, not only YAML inspection.

The unapplied review artifact is `E/pending-scope-repair.patch`, SHA-256
`cc686a0dbcff83508ef55f0c20a5ed1b303a8d43846bcbc946821af9c9260f90`.
It removes the root exemption, evaluates both scope commands in the target lane,
fails closed on a failed diagnostic invocation, and proposes shared pack 76 with
fingerprint `ecc6770f67c2dff1d9da5e39894ec2f752ef56fcdcc44c43f4d3de2b6e3befba`.
These are proposed bytes, not installed or validated repair behavior. Source
patch application, green regression runs, package/runtime requalification and
fresh native harness evidence remain required before tag approval.

### Approved scope repair and live verification (2026-09-13)

This section supersedes the pending-repair status above. The human granted the
session reprieve at 08:20 UTC. Commit `d24520e6d3a9e4f63999e7df00e4d54f18b8504a`
applies root-file scope parity, evaluates both scope commands in the target
worktree, and emits an explicit block if the diagnostic command fails. Shared
pack 76 has the fingerprint proposed above. Build, lint, 16 scope Bats tests,
14 pack-fingerprint checks, and the real-CLI scope scenario exited 0; receipts
are `E/scope-repair-build.command.json`, `E/scope-repair-lint.command.json`,
`E/scope-bats-green.command.json`, `E/scope-fingerprint-green.command.json`, and
`E/scope-runtime-final.command.json`. Lint still prints existing shell warnings.

[Release Qualification 34747864150](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34747864150)
passed on that commit: 2,764 Jest tests in 220 suites, 281 Bats tests, 225 pytest
tests, release contracts, the real-CLI scope scenario, and six Linux/macOS
package-upgrade jobs on Node 18/20/22. `E/scope-repair-qualification-log.stdout`
retains the commands and output. The downloaded scope artifact is summarized in
`E/ci-scope-repair-hooks/inspection.json`; its actual decisions and strike state are:

| Target | Canonical answer | Bound-lane answer | Guard output | Stored strikes |
| --- | --- | --- | --- | ---: |
| `package.json` | no authority | admit | silent | 0 |
| `src/owned/ok.ts` | no authority | admit | silent | 0 |
| `blocked.json` | admit | reject | advisory; edit proceeds | 1 |
| `src/other/no.ts` | admit | reject | ask | 2 |
| `blocked.json` again | admit | reject | block | 3 |
| `package.json` again | no authority | admit | silent | 3 |

This deliberately conflicting fixture distinguishes correct path resolution
from accidentally consulting the canonical checkout. Scope rejection retains
the existing progressive policy: the first violation proceeds with an advisory.
Root parity does not mean every first out-of-scope attempt is hard-blocked.
Every guard subprocess above exited 0; the response body carries ask/block.

Matched isolated controls in `E/scope-sensitivity/inspection.json` returned
0 for unchanged bytes and 1 for each restored defect. Restoring the root
exemption silently admitted rejected root files; restoring the wrong cwd
struck legitimate paths and silently admitted rejected ones. Both failures were
assertion failures with complete decision artifacts, not setup failures.
`E/scope-diagnostic-sensitivity/inspection.json` separately records baseline 0
and mutant 1 when the diagnostic exit check is removed. That control proves
the explicit block diagnostic is checked; its empty mutant output alone does
not establish that every dispatcher would admit the failed subprocess.

[Full Mutation Gate 34747874070](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34747874070)
also passed on `d24520e6`. The downloaded reports are under
`E/ci-scope-repair-mutation/`; `E/scope-repair-mutation-inspection.stdout`
compares all 19 embedded source bodies with `git show d24520e6:<path>` and
prints the raw mutant status counts. Every unchanged 80% per-file floor passes.
Messages-store remains 964 assertion kills plus 6 timeouts out of 1,208 mutants
(80.298%), with 226 survivors and 12 uncovered mutants. Timeouts are not
assertion kills. This finite inventory does not cover every hook or shell form.

`E/ci-scope-repair-upgrade/inspection.json` independently checks all six upgrade
artifacts: each has 66 command receipts (57 exit 0, nine expected exit 2), four
equal before/after governance snapshots, the exact rendered operator request,
and a detached production audit reporting zero findings. Raw receipts 37/41/
45/49/54 show protected-write refusal; 60/62 show the updated guard in both
projects; 64 reports `Runtime modified: protected-paths.sh`; 65 rolls back and
66 restores the original refusal. These are installed subprocess fixtures,
with synthetic transcript input; they do not demonstrate native tool execution.

All six CI packages and the live installation share tarball SHA-256
`154799547293a85b01bac45c88ea8a49e48c205b46977d3390a46b952a5fa8aa`
and runtime digest
`685aaa1fd2d8f9cceb81b18d5baae95a30d2c730deee59c48f1ab5caaab090b2`.
`scripts/install-cli-snapshot.mjs` and `caws init adapters install --json`
both exited 0 (`E/scope-repair-cli-install.*`, `E/scope-repair-runtime-install.*`).
The selected CLI reports `12.2.0-rc.2`; source and installed scope-guard SHA-256
both equal `affde14eaa2005c905d82518976cd5934a19ba2cd7dc952922a4b3a3c1d36433`
(`E/live-selection.json`). The CLI is a standalone snapshot, not a worktree link.
The temporary reprieve was revoked at 08:42:58 UTC; its tombstone has no handlers.

Native evidence in `E/native-scope-repair/inspection.json` establishes these
specific observations after revocation:

- An actual root `package-lock.json` Edit added one whitespace byte, changing
  SHA-256 `23b710f5…` to `f23598e7…` without changing parsed JSON. A second Edit
  restored the exact original bytes. Both have PostToolUse records, but matching
  PreToolUse records were not found. They demonstrate actual edits, not a
  completely observed successful guard decision.
- Native Write `exec-705d09fd-3ccb-42fb-81a2-5a273abfc678` produced scope
  `decision: block`, handler exit 0 and adapter exit 2. The attempted
  `scope-repair-denied-control.txt` was absent before and after the call.
- Native Write `exec-99ddd2eb-cf13-4877-bbf1-4033e48afc42` produced a completed,
  unreprieved scope-handler record and adapter exit 0, then created the expected
  owned-lane artifact. Its retained bytes hash to
  `a444254b62621a30bd8ce9d1eddc95d1dd27dcb9f874dff9566e7d1e0d4f4192`.
  Both Write records identify the new runtime and the exact source hash above.

**Tag approval remains open.** Green CI could coexist with incorrect native
registration, a skipped or timed-out pre-tool chain, or unsupported shell
syntax. Two actual shell refusals also remain unresolved:
`exec-1bd11859-eed7-450c-bb4b-31a97f68f644` interpreted a relative output path
from the canonical checkout despite the requested workdir;
`exec-94b6664c-238a-4ec1-8a1a-83974cbcc19c` reported the quoted Python comparison
`>=cfg['threshold']` as target `=cfg[threshold],` (`ask_dynamic_unconfined`).
`E/scope-repair-native-bash-findings.stdout` retains both handler records and
input hashes. The scope repair does not fix or explain those classifier cases.

Before tagging, inspect raw native PreToolUse envelopes (including cwd/workdir),
matcher/registration decisions, process start/exit/timeout records, and any
partial execution journals for the two successful Edit call IDs
`exec-fa83ccb4-3d77-440f-b6cd-116b18b2ec12` and
`exec-19109738-df94-4ef0-bd9a-e61eb7f5188c`. Add regressions at the boundary
identified by those records. Replay the two shell counterexamples with their
original envelopes and retain extracted mutation targets. Obtain fresh native
Codex/Claude/Kimi trust, SessionStart, actual admitted/refused writes, and Stop
rendering traces. Existing tests cannot substitute for those observations.

Not verified: those missing native traces and shell repairs, fresh harness
lifecycle sequences, RC2 publication or automatic post-release consumption,
every legacy project override, classifier corpus error rates, production
latency, or crash/fsync durability. Doctor remains nonzero for legacy pack
drift and a foreign session whose cwd no longer exists; no foreign session or
custom project hook was overwritten. These limits prevent a release-ready claim
while allowing the bounded scope and CI repair to be delivered.

### Preserve the newer no-Git fix when restoring scope (2026-09-14)

A fresh check after the renewed human reprieve found runtime `ab5a9b31…`
selected, although the CLI still reported RC2. Its scope-guard hash was the
older `8825241a…`, while its launcher included the newer no-Git fix landed on
`main` as `a0cdf79d` under `FIX-HOOK-NOGIT-001`. The previous live-runtime claim
was therefore no longer current. `E/combined-preinstall-observation.stdout`
retains the runtime pointer, CLI target and both installed file hashes.

The two-file no-Git commit was cherry-picked into the owned candidate lane as
`9328739ea8d1da95f14e8c903ef6739aa861b470`. This preserves both fixes without
replacing the newer launcher with the earlier package. Build exited 0; 43
adapter/fingerprint tests and the six-row real-CLI scope scenario passed
(`E/combined-build.*`, `E/combined-adapter-tests.*`, `E/combined-scope-test.*`).
[Qualification 34799605069](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34799605069)
passed on this exact combined commit: 2,765 Jest tests in 220 suites, 281 Bats
cases, 225 Python tests, and all six packaged upgrades. Its full log is
`E/combined-qualification-log.stdout`; upgrade inspection is
`E/ci-combined-upgrade/inspection.json`.

`E/combined-scope-artifact-inspection.stdout` prints the six retained CI rows:
root/nested admitted paths stay silent at zero strikes despite canonical
ambiguity; root/nested refused paths advance through advisory, ask, and block
at strikes 1/2/3 despite canonical admission; an admitted root path stays silent
even after strike 3. The underlying `scope-decisions.json` and 27 command
receipts retain the actual CLI decisions and hook output. A first scope strike
still permits the edit under the existing progressive policy.

The six upgrade artifacts agree on package SHA-256
`613b66712d139e61c4b356c988585baab93dca52baf90cd80f8a2e2a763ff606`
and runtime digest
`7d5f287eff6968f27031d6fb3e16814d6df4d4af28aa83862f6b210520c73c4f`.
Each retains 66 command receipts, four equal governance snapshots, the exact
rendered user request, and a zero-finding production audit. The snapshot
installer and `caws init adapters install --json` both exited 0 and selected
this same package/runtime (`E/combined-cli-install.*`,
`E/combined-runtime-install.*`). The renewed reprieve was then revoked using
the CLI (`E/combined-reprieve-revoke.*`).

The separate installed-launcher experiment retains its complete raw command
inputs and outputs in `E/combined-launcher-NLBBOh/`. A `.caws` ancestor without
Git and an empty/broken `.git` ancestor each returned 0 with the explicit
`continuing without CAWS governance` diagnostic. A plain directory returned 0
silently. A configured governed repository's cross-repository Write returned
2, named the scope guard, and left the target absent. This confirms the intended
no-Git behavior for those shapes, including the deliberate absence of governance
when Git cannot resolve a root; it does not prove behavior for every Git failure.

The first attempt, `E/combined-launcher-lrUuED/`, correctly failed its refusal
assertion: the fixture had installed legacy project registration, so the system
entry stayed inactive. Configuring the disposable machine adapter before init
fixed the setup. The successful probe also requires a recorded selection of
`scope-guard.sh` before exercising refusal. Merely installing files or observing
a silent exit 0 would have missed this distinction.

After live installation and reprieve revocation, native records in
`E/combined-native/inspection.json` and `hook-events.json` show:

| Native call | Scope handler | Adapter | Observed artifact |
| --- | --- | --- | --- |
| Write `exec-cf8c798a-1362-457d-8b88-e1b0dcdf2a43` | completed, exit 0 | 0 | control file created |
| Edit `exec-98ab0a98-8880-4b90-97f3-eb250ca38361` | completed, exit 0 | 0 | control text changed |
| Write `exec-fcb5ce59-cc95-45e7-a31c-c9fa568f9ae8` | block JSON, exit 0 | 2 | denied root file absent |

All three scope observations name runtime `7d5f287e…` and scope source hash
`affde14e…`, with status `completed`, not `reprieved`. The resulting admitted
text is `Combined runtime native Write and Edit control.` and hashes to
`6039d4be839b6a9e3687d3ee8dc2eba55beeb892ec8dad5a73623755f5967cd6`.
The small Edit has the pre-tool record missing from the earlier large lockfile
Edits. This narrows that gap; it does not identify its cause or prove large
payload handling. The earlier shell counterexamples and fresh native lifecycle
requirements remain open before tagging.

The final installation observation, `E/combined-final-runtime.stdout` (exit 0),
compares installed scope and launcher bytes directly with the candidate source
and asserts runtime `7d5f287e…`. `E/combined-gates.stdout` reports all five gates
passing, and `E/combined-docs-check.stdout` exits 0. `E/combined-doctor.stdout`
exits 1 with 1 error, 7 warnings and 15 informational findings, including legacy
pack 56 versus shipped 76 and the foreign session's missing cwd. These findings
remain open; the machine-runtime comparison does not establish that legacy
project dispatchers use the same code.

[Full Mutation Gate 34799889038](https://github.com/Paths-Design/coding-agent-working-standard/actions/runs/34799889038)
also passed on `9328739e`. Downloaded reports under `E/ci-combined-mutation/`
contain 19 production source bodies and 22 test source bodies; the independent
`E/combined-mutation-inspection.stdout` comparison matches every body to that
commit (exit 0). Re-running `assert-mutation-report.mjs` separately for kernel,
shell and store exited 0 for each (`E/combined-mutation-*-verdict.*`), with all
declared 80% per-file floors unchanged and no invalid or ignored verdicts.

The reports contain 3,622 killed, 19 timed-out, 596 surviving and 67 uncovered
mutants. `messages-store.ts` is 971/1,208 detected (80.38%): 965 killed, six
timeouts, 225 survivors and 12 uncovered. Timeouts count as detected under the
existing policy; this result does not establish assertion-based detection for
those 19 mutants, and the survivors were not individually adjudicated as
equivalent. Claiming complete behavioral coverage would require inspecting the
surviving/timeout locations and killing tests, reaching uncovered paths, and
adding discriminating assertions. The full CI log is
`E/combined-mutation-log.stdout`; the native trace gaps above remain separate
from these mutation floors. No tag, publication or default-branch merge was
performed by this qualification.
