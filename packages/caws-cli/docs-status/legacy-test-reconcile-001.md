# LEGACY-TEST-RECONCILE-001 — Per-Suite Triage

**Status:** Approved with modifications. Execution order: investigations first, then rewrites/deletes/splits.
**Baseline:** `npm test` reports `15 failed suites / 72 failed tests / 2 skipped / 1537 passed` on commit `e77628f`
**Source:** `.rehearsal-cli-full.log` + per-suite re-runs captured to `.triage-per-suite.log`
**Reference:** `docs/architecture/caws-vnext-command-surface.md` (v11 A1 posture — 8 kept command groups)

## Standing decisions (apply across all suites)

1. **`iterate`, `sidecar`, `provenance` are removed from v11.1.** No quarantine. Tests asserting them are DELETE unless a named v11.x restoration spec exists; no such spec exists today.
2. **Cursor hooks install policy:** automatic install only when detection is unambiguous and the pack is explicitly supported. For v11.1, only `--agent-surface claude-code` installs a pack on plain `caws init`. Cursor may be detected/modeled but is NOT silently installed. Plain `caws init` MUST NOT create `.cursor/`.
3. **Hook safety assertions are durable.** A failing safety-hook test is presumed a regression until proven a deliberate policy change. Do not weaken or delete safety assertions to make them pass.
4. **No new doctrine docs to satisfy a legacy test.** Prefer linking to existing doctrine (`caws-vnext-command-surface.md`, `event-order.md`, INIT-HOOK-PACKS-001 spec) unless the rewrite requires one or two clarifying sentences.

## Disposition rules (recap)

- **DELETE** — Only asserts removed v10 product surface, no durable invariant remains.
- **REWRITE** — Invariant still matters, but command/state path changed to v11.
- **SPLIT** — File mixes removed-command assertions with assertions about kept commands. Delete the removed parts; rewrite or retain the rest.
- **RETAIN** — Conceptually v11-valid; failing because of harness/config drift (e.g., TS-import via Babel without TS transformer, fixture path).
- **QUARANTINE** — Covers an intentionally deferred v11.2+ surface; requires named follow-up spec AND explicit per-file exclusion (not a wildcard ignore). No suite currently qualifies.

## Salvage guidance

Before any DELETE, list assertions worth porting to a new or adjacent suite. The reviewer should be able to read this doc and confirm that no durable behavior protection is being lost.

---

## Suite-by-suite

### 1. `tests/parallel-command.test.js`

**Failure count:** 14 failed / 2 passed
**Asserts:** `caws parallel` command and its `setup` / `status` / `merge` / `teardown` subcommands exist; their `--help` reports specific flags (`--plan-file`, `--base-branch`, `--strategy`, `--dry-run`, `--force`, `--delete-branches`).

**v11 status:** `parallel` is **removed in v11** (§3 of command-surface doc). Per the doctrine, parallel orchestration may return in v11.2+, but the orchestration surface itself was a v10 design choice.

**Proposed disposition:** `DELETE`

**Rationale:** Every assertion in this file is "does this removed command exist with these specific flags?" No invariant survives the v11 cutover. If parallel returns in v11.2, its tests will be authored against the new surface, not this one.

**Salvage:** None. The flag inventory (`--plan-file`, `--base-branch`, etc.) is a v10 product decision; the v11.2 design may differ.

---

### 2. `tests/index.test.js`

**Failure count:** 9 failed / 11 passed
**Asserts:** `caws init <project-name>` creates a project subdirectory, writes `.caws/working-spec.yaml`, validates the working spec, generates a provenance manifest, handles agents.md/caws.md fallback, scaffolds enhancements.

**v11 status:** `caws init` exists but its **contract changed**: v11 init is in-place (no subdirectory), refuses legacy single-spec residue, and does NOT create `.caws/working-spec.yaml` (specs live at `.caws/specs/<id>.yaml` only). Provenance manifest generation is **out** (it was tied to the v10 working-spec model).

**Proposed disposition:** `REWRITE`

**Rationale:** The intent — "init produces a valid project structure, refuses invalid input, scaffolds correctly" — survives. The specific assertions encode v10 contracts and must be replaced with v11 equivalents:
  - in-place init (no `<project-name>` arg)
  - `.caws/specs/` exists with no `working-spec.yaml`
  - `caws init --agent-surface claude-code` installs the hook pack (INIT-HOOK-PACKS-001)
  - agents.md/caws.md fallback still applies (kept paths)

**Salvage:** Tests that already pass (version info, help info, agents.md guide creation, git repo init, scaffolding) stay as-is.

---

### 3. `tests/validation.test.js`

**Failure count:** Suite failed to run (zero tests executed)
**Failure mode:** `SyntaxError: src/shell/index.ts: Support for the experimental syntax 'flow' isn't currently enabled` — the test imports a TypeScript source file directly, but Babel-Jest has no TS transformer configured.

**v11 status:** Validation logic still exists in v11 (`caws doctor`, scope checks, gate evaluation). The test file *itself* is not asserting any specific v10/v11 contract; it's blocked at import time.

**Proposed disposition:** `RETAIN` (with harness fix)

**Rationale:** This is harness drift, not a contract problem. v11 shipped TS sources in `src/shell/`; the existing Babel config doesn't know to transform them. Two safe fixes:
  1. Update the test to import from `dist/shell/` instead of `src/shell/` (matches every other passing test).
  2. OR: configure Babel-Jest with `@babel/preset-typescript` so `src/*.ts` imports work.

Option 1 is the minimum change and matches existing test patterns. The actual assertions inside the file need separate review once it can run.

**Salvage:** Need to re-read after the harness fix to assess assertion content.

---

### 4. `tests/schema-load-validation.test.js`

**Failure count:** 1 failed / 14 passed
**Failing test:** `resolveSpec with invalid spec includes schema errors in thrown error`
**Other tests:** All passing (working-spec schema validation, AJV catches type errors, semantic pass behavior, CAWSFIX-20 regression coverage).

**v11 status:** `resolveSpec` may have shifted error shape between v10 and v11; the other 14 tests confirm schema validation is broadly intact.

**Proposed disposition:** `REWRITE` (one test only)

**Rationale:** 14 of 15 assertions still pass and cover real v11 invariants (AJV vs semantic-pass distinction, scope.in type validation, fallback behavior). Only the single failing test about `resolveSpec` error shape needs updating to match v11's error shape.

**Salvage:** Almost entirely RETAIN with a one-test surgical rewrite.

---

### 5. `tests/perf-budgets.test.js`

**Failure count:** 4 failed / 5 passed
**Failing tests:** `should initialize project within performance budget`, `should scaffold project within performance budget`, `should not exceed memory usage budget during operations`, `should monitor CPU usage during operations`.
**Passing tests:** startup-time, help-load-time, bundle size, dependency bundle impact, performance regression detection.

**v11 status:** The failing tests invoke `caws init <name>` (v10 contract — see suite 2). The passing tests invoke surface-agnostic measurements.

**Proposed disposition:** `REWRITE`

**Rationale:** Perf budgets are still a valid concern in v11. The failing tests use the v10 init/scaffold contract; they should be rewritten to measure v11 equivalents:
  - `caws init` (in-place) startup + completion budget
  - `caws gates run` budget (the heaviest kept v11 command)
  - `caws specs create` / `caws worktree create` budget

**Salvage:** Keep all 5 currently-passing tests. Rewrite the 4 failing ones to v11 command paths.

---

### 6. `tests/axe/cli-accessibility.test.js`

**Failure count:** 2 failed / 7 passed
**Failing tests:** `should use consistent formatting for better readability` (probably comparing help text shape), `should generate accessible working spec format`.
**Passing tests:** screen-reader-friendly help, error messages, line lengths, visual hierarchy, version info accessibility.

**v11 status:** Help text shape changed (v11 has 8 command groups vs v10's many). Working-spec accessibility is moot because v11 has no working-spec.yaml.

**Proposed disposition:** `REWRITE`

**Rationale:** Accessibility regression coverage is durable value. The two failing tests need updating:
  - The formatting test should snapshot v11's help, not v10's.
  - The "accessible working spec format" test should be re-pointed at `.caws/specs/<id>.yaml` (v11 spec files) or removed if it's only checking working-spec.yaml shape.

**Salvage:** Keep all 7 passing tests. Update the 2 failing ones to v11 contract.

---

### 7. `tests/contract/cli-contract.test.js`

**Failure count:** 4 failed / 2 passed
**Failing tests:** `init command should create valid project structure` (asserts subdirectory + `.caws/working-spec.yaml`), `CLI should handle invalid arguments gracefully`, `tool configurations should have valid interfaces`, `generated spec should conform to documented schema`.
**Passing tests:** semver compliance, working-spec schema validation against legacy schema (still on disk but unused in v11).

**v11 status:** CLI contract is still a real concern — v11's 8-command surface deserves contract tests. But the *specific* contracts asserted here are v10.

**Proposed disposition:** `REWRITE`

**Rationale:** This file's intent ("v11 CLI must conform to its documented contract") is exactly the kind of test the cutover *needs*. Rewriting to v11:
  - `init` creates in-place; refuses non-empty `.caws/` (idempotency invariant)
  - Invalid argument handling: `caws unknown-cmd` exits non-zero with clear message
  - "tool configurations" → v11 doesn't have an external tools registry; this assertion can be DELETEd
  - Generated spec conforming to documented schema → assert against `.caws/specs/<id>.yaml` shape

**Salvage:** Keep semver test. Rewrite the rest against v11 contract.

---

### 8. `tests/contract/schema-contract.test.js`

**Failure count:** Per-suite run reports **0 explicit failures** in the visible output (`✓` on every printed test); however, the full-suite run flagged it as failing. Likely cause: a flaky setup/teardown or an off-by-one in the global tally, **not** an assertion failure.

**v11 status:** Schemas at `packages/caws-cli/schemas/` (working-spec, worktrees, waivers, scope, policy) all exist and pass JSON validity + title + structural assertions.

**Proposed disposition:** `RETAIN` (verify only)

**Rationale:** Re-run individually until a deterministic failure mode is identified. If it stabilizes as fully green in isolation, it's likely an interaction with another suite's global state. Document the finding; do not edit.

**Salvage:** N/A — this is RETAIN pending confirmation.

---

### 9. `tests/e2e/smoke-workflow.test.js`

**Failure count:** 5 failed / 0 passed
**Asserts:** "should complete full project creation from scratch", "should handle iterative project development", "should add CAWS to existing project", "should recover from broken working spec", "should work across different project types" — all invoking the v10 `caws init <name>` + working-spec workflow.

**v11 status:** The intent (smoke-test the full normal workflow) is exactly what v11.1's new lifecycle commands deliver. The current assertions are all v10-shaped.

**Proposed disposition:** `REWRITE`

**Rationale:** A v11 smoke workflow is high-value (the canonical path is exactly what's being smoke-tested manually in slice rehearsals). Rewrite to:
  - `caws init` in-place
  - `caws specs create FEAT-001` → `caws worktree create wt --spec FEAT-001` → commit on branch → `caws worktree merge wt` → assert auto-close
  - `caws specs archive FEAT-001`
  - "broken working spec" → "spec with bad lifecycle_state" recoverable via `caws doctor`

**Salvage:** Zero passing tests to keep; this is a full rewrite. But the *file* should not be deleted — its name + intent (e2e smoke) is correct.

---

### 10. `tests/integration/cli-workflow.test.js`

**Failure count:** 5 failed / 0 passed
**Asserts:** "complete full project initialization and scaffolding workflow", "handle project modifications and re-validation", "integrate validation and provenance tools", "integrate gates tool with project structure", "handle workflow interruptions gracefully" — all v10 workflow shapes.

**v11 status:** Same story as smoke-workflow (suite 9), but at integration level rather than e2e.

**Proposed disposition:** `REWRITE`

**Rationale:** Integration coverage of the v11 normal flow is durable. Rewrite mirrors suite 9 but with integration-test granularity (per-command assertions rather than end-to-end happy path).

**Salvage:** Zero passing tests; full rewrite.

---

### 11. `tests/integration/cursor-hooks.test.js`

**Failure count:** 3 failed / 13 passed
**Failing tests:** `should create .cursor directory structure on init`, `hooks-and-agent-workflows.md should exist in docs`, `AGENTS.md should mention Cursor hooks`.
**Passing tests:** hook scripts exist (`audit.sh`, `block-dangerous.sh`, `scan-secrets.sh`, etc.), hooks.json structure, relative-path usage, HOOK_STRATEGY.md references.

**v11 status:** Cursor hooks are NOT installed by `caws init` in v11 — only `--agent-surface cursor` would do so (INIT-HOOK-PACKS-001 scope was claude-code, with cursor pack deferred). So `.cursor/` on plain `caws init` is gone. The doc-reference failures are about missing markdown files.

**Proposed disposition:** `RETAIN` (mostly) + 3 small REWRITEs

**Rationale:** Most of this suite already passes — the v10 cursor hook scripts still exist in templates and are still wired correctly. The failing tests need targeted updates:
  - `.cursor directory structure on init` → assert it appears when `--agent-surface cursor` is passed, not on plain init
  - `hooks-and-agent-workflows.md should exist in docs` → either restore the doc or remove the assertion (need to check whether the doc was intentionally removed)
  - `AGENTS.md should mention Cursor hooks` → AGENTS.md is in repo root and references hooks indirectly; need to check whether v11 AGENTS.md still has that section

**Salvage:** 13 passing tests stay. 3 surgical rewrites.

---

### 12. `tests/integration/event-log-read-parity.test.js`

**Failure count:** 7 failed / 1 passed
**Failing tests:** `iterate produces identical output...`, `status (human) produces identical output...`, `status --json produces identical output...`, `sidecar gaps produces identical output...`, `sidecar drift produces identical output...`, `sidecar waiver-draft produces identical output...`, `untouched spec returns null workingState`.
**Passing test:** `pre-condition: dualWrite populates both state and events`.

**v11 status:** `iterate` and `sidecar` are **removed in v11** (§3). `status` and `gates` are **kept v11 commands**. The "workingState" concept is from the v10 dual-write model (state + events); v11 has no working-state separate from events, but the broader parity question "does this command read consistently from events.jsonl" can still apply to kept commands.

**Proposed disposition:** `SPLIT`

**Rationale (revised):** Reviewer-flagged correction. Treating this as straight DELETE risks losing a durable v11 invariant: command output should be deterministic over a stable event log. The split rule:
  - **DELETE** the assertions for `iterate`, `sidecar gaps`, `sidecar drift`, `sidecar waiver-draft`, and the dualWrite pre-condition (all removed-command/removed-mechanism).
  - **EVALUATE** the `status` and `status --json` parity assertions: if they encode a v11-valid invariant (deterministic read from events.jsonl), REWRITE to the v11 status shape. If they only assert the v10 dual-write story, DELETE.
  - **EVALUATE** the `gates` parity assertion (if present in the file body): same rule.

After the split, if the file ends up with no surviving assertions, DELETE the file. Otherwise REWRITE in place around the surviving v11 invariants.

**Salvage:** Per-assertion evaluation needed before any code action. The event-chain epoch boundary (EVENTS-LEGACY-ARCHIVE-001) means any retained assertion must operate on the v11 event log shape, not the legacy one.

---

### 13. `tests/integration/gates-cli.test.js`

**Failure count:** 9 failed / 0 passed
**Failing tests:** Every test (warn-mode pass, budget exceeded, JSON output structure, text output, scope boundary violation, quiet mode).
**Specific assertion:** `runGatesCli(testDir, ['--context=cli', '--json'])` → expected exit 0, received exit 1.

**v11 status:** `caws gates` is a **kept v11 command** (§2). This is a real v11 surface that the test is exercising. The fact that every test fails suggests either:
  (a) `caws gates run --json --context=cli` is broken
  (b) the test fixture doesn't set up a valid v11 project before invoking gates
  (c) the test uses an old gates invocation shape

**Proposed disposition:** `RETAIN` (with investigation) or possibly `REWRITE` if invocation shape changed

**Rationale:** This is the **highest-priority diagnostic finding** of the whole triage. Gates is a v11 product surface. If `caws gates` actually fails in CI conditions, that's a release-blocker for v11.1 independent of test reconciliation. We should:
  1. Manually run the test scenario in a sandbox and see whether gates fails or the test setup is wrong.
  2. If gates works manually: REWRITE the test fixture.
  3. If gates is broken: open a parallel spec (GATES-CLI-REGRESSION-001) and fix it.

**Salvage:** All assertions encode real v11 contracts (exit codes, JSON shape, warn vs block semantics). 100% durable.

---

### 14. `tests/integration/lite-hooks.test.js`

**Failure count:** 5 failed / 19 passed (best-pass ratio of any failing suite)
**Failing tests:** `blocks git push --force`, `blocks git init`, `blocks git reset --hard`, `blocks venv creation`, `blocks dangerous command chained after safe quoted echo`.
**Passing tests:** Allows normal commands, ignores non-Bash tools, scope.in/out enforcement, banned file/doc patterns, scope.json fail-closed, terminal-spec skipping.

**v11 status:** Lite hooks classify shell commands and edits. The failing tests are all about a hooks classifier blocking specific dangerous commands. The hook pack itself shipped in INIT-HOOK-PACKS-001 (Slice 2). The classifier behavior may have shifted between v10 and v11 (the user already noted standing rules about not bypassing hooks).

**Proposed disposition:** `RETAIN` (with investigation)

**Rationale:** These tests encode **incident-derived hook behavior** — the user has explicitly flagged hook discipline as a standing rule. Casual deletion would lose safety assertions. The 19 passing tests confirm the hook substrate broadly works. The 5 failures need per-test diagnosis: is the classifier intentionally less strict in v11 (which would mean the tests need updating), or is the classifier broken (which would mean v11 has a hook-safety regression)?

**Salvage:** All assertions are durable safety invariants. Investigate before any change.

---

### 15. `tests/integration/tools-integration.test.js`

**Failure count:** 2 failed / 0 passed
**Asserts:** `should validate spec and run gates together`, `should generate provenance after successful validation`.

**v11 status:** `caws validate` and `caws provenance` are **both removed in v11**. `caws gates` exists. The integration this tests (validate → gates → provenance) is half-removed.

**Proposed disposition:** `DELETE`

**Rationale:** The integration being asserted no longer exists. Spec validation in v11 is via `caws doctor` and gate evaluation; provenance manifests are removed. A v11 "tools integration" suite would have different commands and shape.

**Salvage:** None — the integration pattern itself was v10. If something like it returns in v11.x, fresh tests will be authored.

---

## Disposition summary

| Suite | Disposition | Tests affected |
|---|---|---|
| 1. `parallel-command.test.js` | DELETE | 16 |
| 2. `index.test.js` | REWRITE | ~9 (keep 11 passing) |
| 3. `validation.test.js` | RETAIN (harness fix: src → dist import) | suite-level |
| 4. `schema-load-validation.test.js` | REWRITE (1 test only) | 1 |
| 5. `perf-budgets.test.js` | REWRITE (4 tests) | 4 (keep 5 passing) |
| 6. `axe/cli-accessibility.test.js` | REWRITE (2 tests) | 2 (keep 7 passing) |
| 7. `contract/cli-contract.test.js` | REWRITE | 4 (keep 2 passing) |
| 8. `contract/schema-contract.test.js` | RETAIN (verify isolation-pass) | 0 |
| 9. `e2e/smoke-workflow.test.js` | REWRITE (full file) | 5 |
| 10. `integration/cli-workflow.test.js` | REWRITE (full file) | 5 |
| 11. `integration/cursor-hooks.test.js` | RETAIN + 3 small REWRITEs | 3 (keep 13 passing) |
| 12. `integration/event-log-read-parity.test.js` | SPLIT (delete iterate/sidecar; evaluate status/gates parity) | 8 |
| 13. `integration/gates-cli.test.js` | RETAIN + investigation | 9 (real v11 surface — possible regression) |
| 14. `integration/lite-hooks.test.js` | RETAIN + investigation | 5 (safety invariants — diagnose, don't delete) |
| 15. `integration/tools-integration.test.js` | DELETE | 2 |

**Totals:**
- DELETE: 2 suites (`parallel-command`, `tools-integration`)
- SPLIT: 1 suite (`event-log-read-parity` — delete removed-command parts; evaluate status/gates parity)
- REWRITE: 7 suites (some full-file, some surgical)
- RETAIN: 4 suites (with diagnostic work, not blind keeping)
- QUARANTINE: 0 suites (none qualified as "deferred future product surface with tracking spec")

## Key risks flagged

1. **`gates-cli.test.js` — possible real v11 regression.** Every test fails on a kept v11 command. Must be diagnosed before reconciliation. If gates actually broken, this becomes its own blocker (parallel slice).
2. **`lite-hooks.test.js` — safety assertions failing.** Five tests about classifier blocking dangerous commands fail. Need diagnosis: is the classifier intentionally relaxed, or is hook safety regressing? The user's standing rule against bypassing hooks makes this high-priority.
3. **`schema-contract.test.js` — flake suspect.** Per-suite run shows green; full-suite run flagged failing. Almost certainly interaction with another suite's global state. Worth identifying the offender.

## Approved execution order

1. **Investigate `gates-cli.test.js`.** Either a real v11 product regression on a kept command, or a fixture mismatch. Resolve before any test reconciliation begins. If a real regression: open GATES-CLI-REGRESSION-001 as a parallel slice. If a fixture mismatch: REWRITE the suite.
2. **Investigate `lite-hooks.test.js`.** Treat force-push, reset-hard, git-init, venv-creation, and chained-dangerous failures as safety regressions unless proven a deliberate policy change in the INIT-HOOK-PACKS-001 v2 pack. Do not weaken assertions to make them pass.
3. **Confirm `schema-contract.test.js` isolation.** Run alone vs in full suite; identify the cross-suite state leak if it exists.
4. **DELETE clearly-removed-only suites** (`parallel-command`, `tools-integration`).
5. **SPLIT `event-log-read-parity.test.js`.** Per-assertion: delete iterate/sidecar/provenance; evaluate status/gates parity for v11 invariant relevance.
6. **RETAIN harness fix** (`validation.test.js`: src → dist import).
7. **REWRITE surgical** (`schema-load-validation`, `axe/cli-accessibility`, `cursor-hooks`).
8. **REWRITE larger** (`index.test.js`, `contract/cli-contract.test.js`, `perf-budgets.test.js`).
9. **REWRITE full-file** (`e2e/smoke-workflow.test.js`, `integration/cli-workflow.test.js`).
10. **Final `npm test` green confirmation.** No blanket ignore patterns. Every disposition recorded in closure notes.
11. **Close LEGACY-TEST-RECONCILE-001** via `caws specs close` with closure notes listing every suite disposition + final test counts.

## Reviewer questions — resolved

1. **`iterate`, `sidecar`, `provenance`** → **Removed from v11.1.** No quarantine. No named restoration spec exists. Tests asserting them are DELETE.
2. **Cursor hooks on plain init** → **No.** Install only via `--agent-surface cursor` (and only when implemented). For v11.1, Claude Code is the implemented pack; Cursor is modeled/deferred. Plain `caws init` MUST NOT create `.cursor/`.
3. **`gates-cli.test.js` existing diagnosis** → **None.** Treat as release-blocking investigation until proven otherwise.
4. **New doctrine docs for legacy-test rewrites** → **Avoid.** Link to existing doctrine (`caws-vnext-command-surface.md`, `event-order.md`, INIT-HOOK-PACKS-001 spec). Add at most one or two clarifying sentences inline if absolutely needed.
