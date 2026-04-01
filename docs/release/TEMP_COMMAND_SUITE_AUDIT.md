# Temporary Command Suite Audit

Purpose: track release-candidate audit findings for `caws-cli` command behavior, with emphasis on how commands should behave together as one coherent suite.

Status: working document, now mostly in remediation tracking mode rather than initial discovery.

## Recently Resolved

- `status`, `diagnose`, and `evaluate` now resolve spec targets through the shared resolver path.
- `validate` scope-conflict plumbing was corrected to use real multi-spec state and rooted paths.
- `gates` / `spec_completeness` now operate on resolved spec input rather than hard-coded legacy discovery.
- `specs update` is rollback-safe instead of leaving bad partial writes behind.
- `test-analysis` now honors `--spec-id`.
- `quality-monitor` can derive advice from a resolved feature spec.
- `archive`, `verify-acs`, and `provenance` now have explicit single-spec resolver behavior aligned with feature-spec workflows.
- `init` now bootstraps a canonical initial feature spec plus registry entry, while retaining `working-spec.yaml` as a compatibility mirror.
- `worktree` and `parallel` now propagate canonical feature-spec content into isolated worktrees when a real `specId` exists, instead of always synthesizing generic working specs.

## Audit Frame

Primary question:
Do CAWS CLI commands resolve, validate, display, and enforce spec state consistently across legacy single-spec and multi-spec workflows?

Working rule:
- `resolveSpec()` should be the default entry point for any command that operates on a spec.
- Commands that advertise `--spec-id` should actually honor it.
- Commands that report status, validation, diagnostics, evaluation, or gates should agree on which spec is being discussed.
- Multi-spec projects should not silently degrade into legacy `.caws/working-spec.yaml` behavior.

## Expected Suite Contract

These commands should act like one system, not separate implementations:

1. `caws specs *`
   Creates, updates, lists, and migrates spec files and registry metadata.

2. `caws validate`
   Canonical structural/spec validation entry point.

3. `caws status`
   Read-only project and spec overview. Should surface the same target spec a user would validate.

4. `caws diagnose`
   Health-check layer. Should diagnose the currently targeted spec workflow, not only the legacy file.

5. `caws evaluate`
   Quality/readiness scoring. Should evaluate the same resolved spec the user is working on.

6. `caws gates`
   Enforcement layer. Should run against the same resolved spec used by validation.

7. `caws iterate`
   Guidance layer. Should consume the same resolved spec and current progress model.

8. `caws verify-acs`
   Acceptance-criteria evidence layer. Should discover specs consistently and avoid hidden legacy-only assumptions.

9. `caws archive`
   Finalization layer. Should archive against the spec that passed validation and gates.

## Current Findings

### 1. `specs.js` was the source of registry drift

Summary:
- Registry entries were being built from command assumptions instead of the YAML actually written to disk.
- Update behavior only partially synchronized registry metadata.

Current status:
- Patched locally.

Desired suite behavior:
- Registry metadata should always be derived from the parsed, validated spec file that exists on disk.
- Failed writes should not leave registry and file state disagreeing.

Relevant files:
- `packages/caws-cli/src/commands/specs.js`
- `packages/caws-cli/src/utils/spec-resolver.js`

### 2. Invalid YAML failure mode is now clearer, but not yet suite-wide

Summary:
- `loadSpec()` now throws on invalid YAML instead of silently returning `null`.
- Resolver sanitization now ignores stale registry entries for missing spec files.

Desired suite behavior:
- Commands should fail loudly and consistently on invalid YAML.
- Invalid YAML should not be silently treated as “spec not found” or “no spec”.

Open follow-up:
- Audit all callers that still swallow YAML parse failures and degrade to empty output.

### 3. `status` is still not suite-consistent

Observed behavior:
- Advertises `--spec-id`.
- Does not use `resolveSpec()`.
- Loads legacy `.caws/working-spec.yaml` directly.
- Separately loads multi-spec listings without selecting a target spec.
- Returns `null` on YAML parse failure instead of surfacing an error.

Impact:
- A multi-spec project can validate one spec and then get unrelated or misleading `status` output.
- Broken YAML may disappear from status instead of being reported.

Relevant file:
- `packages/caws-cli/src/commands/status.js`

Desired behavior:
- If `--spec-id` is provided, resolve and display that exact spec.
- If multiple specs exist and no `--spec-id` is provided, use the same selection rules as `validate`.
- Distinguish “no spec”, “invalid spec”, and “legacy fallback”.

Current status:
- Resolved locally.

### 4. `diagnose` is still legacy-only

Observed behavior:
- Only checks `.caws/working-spec.yaml`.
- Ignores the `--spec-id` flag exposed by the CLI.

Impact:
- Multi-spec projects get false negatives such as “Working spec not found”.

Relevant files:
- `packages/caws-cli/src/commands/diagnose.js`
- `packages/caws-cli/src/index.js`

Desired behavior:
- Diagnose should resolve the same spec selection as `validate`.
- Health checks should report whether they are evaluating a feature spec or the legacy working spec.

Current status:
- Resolved locally.

### 5. `evaluate` is still legacy/path-only

Observed behavior:
- Accepts `--spec-id` at the CLI level.
- Reads only the positional `spec-file` or default `.caws/working-spec.yaml`.
- Does not use `resolveSpec()`.

Impact:
- Evaluation can disagree with validation in multi-spec workflows.

Relevant files:
- `packages/caws-cli/src/commands/evaluate.js`
- `packages/caws-cli/src/index.js`

Desired behavior:
- Use `resolveSpec()` first.
- Report the resolved spec path/type in output.

Current status:
- Resolved locally.

### 6. `gates` entry point is partially aligned, but `spec_completeness` is not

Observed behavior:
- `caws gates` resolves a spec through `resolveSpec()`.
- `spec_completeness` still directly opens `.caws/working-spec.yaml`.

Impact:
- Gate execution can fail in a valid multi-spec project even when command-level resolution succeeded.

Relevant files:
- `packages/caws-cli/src/commands/gates.js`
- `packages/caws-cli/src/gates/spec-completeness.js`

Desired behavior:
- Gate runners should receive the resolved spec object and path from the command layer, or share a common spec-loading abstraction.
- Individual gates should not re-implement legacy-only spec discovery unless explicitly intended.

Current status:
- Resolved locally.

### 7. `validate` has a broken scope-conflict integration

Observed behavior:
- `validate` tries to check multi-spec conflicts.
- It reads `multiSpecStatus.registry?.specs`, but `checkMultiSpecStatus()` does not return a registry object.
- `checkScopeConflicts()` also builds relative spec paths that are not anchored to project root.

Impact:
- Conflict warnings are likely never emitted in real multi-spec usage.

Relevant files:
- `packages/caws-cli/src/commands/validate.js`
- `packages/caws-cli/src/utils/spec-resolver.js`

Desired behavior:
- `validate` should ask the resolver for the actual active spec IDs.
- Conflict checks should be rooted at project root and should not silently skip broken specs.

Current status:
- Resolved locally.

### 8. `specs update` still risks partial-write corruption

Observed behavior:
- Writes YAML to disk first.
- Validates after the write.
- Does not restore the previous file contents on validation failure.

Impact:
- Registry sync may stop, but the spec file can still be left invalid on disk.

Relevant file:
- `packages/caws-cli/src/commands/specs.js`

Desired behavior:
- Use write-then-rename with validation before commit, or backup-and-restore on failure.

Current status:
- Resolved locally.

### 9. `verify-acs` still mixes legacy and multi-spec discovery manually

Observed behavior:
- Loads `working-spec.yaml` directly.
- Scans `.caws/specs/` directly.
- Ignores the newer resolver/registry path for general discovery.

Impact:
- Another place where suite behavior can drift from `validate`, `status`, and `gates`.

Relevant file:
- `packages/caws-cli/src/commands/verify-acs.js`

Desired behavior:
- Reuse shared spec discovery/resolution rules.
- Decide explicitly whether legacy + feature specs should be combined or selected.

Current status:
- Resolved locally.
- Current contract is single resolved spec by default, with `--spec-id` for explicit targeting.

### 10. `archive` is only partially aligned with the suite

Observed behavior:
- Loads archived change state from `.caws/changes/<id>/working-spec.yaml`.
- Only calls `resolveSpec()` if the change folder does not already contain a working spec and `--spec-id` is provided.
- Validates acceptance criteria against the loaded change spec, but quality gates are run separately against the current workspace rather than an explicitly resolved spec.
- `displayArchiveResults()` and summary generation use `change.workingSpec`, not the fallback-resolved `workingSpec` local variable.
- YAML/read errors in `loadChange()` are swallowed and returned as `null`.

Impact:
- Archive may validate one spec snapshot, display another, and run gates against a third implicit context.
- If a change folder has stale or invalid embedded spec data, `--spec-id` does not override it.
- Broken archive metadata can degrade into “change not found” behavior.

Relevant files:
- `packages/caws-cli/src/commands/archive.js`

Desired behavior:
- Make the spec source explicit: archived snapshot, current resolved spec, or both with a clear comparison.
- If `--spec-id` is supplied, define whether it overrides or supplements the embedded change spec.
- Surface malformed archive metadata as an error, not a null change.

Current status:
- Resolved locally.
- Current contract is:
  explicit `--spec-id` / `--spec` wins;
  otherwise embedded archived snapshot is used if present;
  otherwise the command falls back to shared spec resolution.

### 11. `plan` is closer to suite behavior, but its auto-detect path is still broken

Observed behavior:
- Uses `resolveSpec()` when a `--spec-id` is supplied.
- If no spec is supplied, it tries to auto-detect a single spec from registry state.
- The multi-spec error path references `status.registry?.specs`, but `checkMultiSpecStatus()` does not return a registry object.
- `loadSpecForPlanning()` swallows resolver errors and returns `null`, which loses the distinction between “not found”, “invalid YAML”, and “schema invalid”.
- Planning uses only `acceptance_criteria`, not the merged `acceptance`/`acceptance_criteria` model used elsewhere.

Impact:
- The command is directionally correct but still gives incomplete guidance when auto-detection or resolver failure occurs.
- Planning can disagree with `verify-acs` and `iterate` on which acceptance data exists.

Relevant files:
- `packages/caws-cli/src/commands/plan.js`
- `packages/caws-cli/src/utils/spec-resolver.js`

Desired behavior:
- Reuse resolver output directly, including better surfaced errors.
- Use a shared acceptance extraction model so planning and verification do not interpret the same spec differently.

Current status:
- Mostly resolved locally for spec targeting and broken registry assumptions.
- Acceptance extraction consistency still needs a follow-up pass if we want full parity with `verify-acs`.

### 12. `provenance` is still fundamentally legacy-scoped

Observed behavior:
- `provenance update` reads only `.caws/working-spec.yaml`.
- `provenance init` also requires `.caws/working-spec.yaml` to exist.
- The CLI does not expose `--spec-id` for provenance commands.
- Quality gate status is read from a single saved report path, not tied to any specific spec.

Impact:
- Multi-spec projects cannot produce spec-specific provenance cleanly.
- Provenance entries may record legacy or unrelated spec metadata even when actual work was performed under a feature spec.
- Provenance and archive can diverge on which spec represents the change.

Relevant files:
- `packages/caws-cli/src/commands/provenance.js`
- `packages/caws-cli/src/index.js`

Desired behavior:
- Add a spec-selection story for provenance: explicit `--spec-id`, resolved spec metadata, or change-linked provenance.
- Include the resolved spec path/type in provenance entries so audit data is reproducible.

Current status:
- Resolved locally for `init` and `update`.
- Those commands now accept explicit spec targeting and persist resolved spec metadata in provenance output.

### 13. `verify-acs` needs a clearer suite contract

Observed behavior:
- With `--spec-id`, it loads that file directly from `.caws/specs/`.
- Without `--spec-id`, it combines active feature specs and the legacy working spec in one run.
- It skips unreadable YAML silently for general discovery.
- It bypasses registry sanitization and resolver logic entirely.

Impact:
- This command may report across more specs than `validate`, `status`, or `evaluate`.
- Invalid YAML can disappear from the output rather than failing verification.
- Stale registry fixes do not help this path because it does not use the registry.

Relevant file:
- `packages/caws-cli/src/commands/verify-acs.js`

Desired behavior:
- Decide whether default behavior is “all active specs” or “resolved current spec”, and make that consistent with the suite.
- Surface parse failures instead of ignoring them.

Current status:
- Resolved locally.
- Default behavior is now “resolved current spec”, matching the rest of the suite.

## Command-by-Command Audit Checklist

Use this section as we continue the review.

For each command, answer:
- Does it honor `--spec-id`?
- Does it use `resolveSpec()` or equivalent shared logic?
- Does it surface YAML/schema errors clearly?
- Does it behave correctly in:
  - legacy-only projects
  - single feature-spec projects
  - multiple feature-spec projects
  - mixed legacy + feature-spec projects
- Does it agree with `validate` on the target spec?
- Does it mutate file/registry state safely?

### Commands to review next

All commands reviewed and resolved. See findings #14-#24 below.

## Additional Findings: Workflow Commands

### 14. `quality-monitor` is now aligned with suite

Observed behavior:
- Uses `resolveSpec()` with `specId` parameter.
- Accepts `--spec-id` in CLI registration.
- Applies resolved spec context via `applySpecContext()`.

Current status:
- Resolved locally.

### 15. `burnup` now uses resolver and is registered as a CLI command

Observed behavior:
- Uses `resolveSpec()` with `specId` parameter when no positional spec file is given.
- Accepts `--spec-id` in CLI registration.
- Command is now properly registered in `index.js` (was previously imported but never registered).

Current status:
- Resolved locally.

### 16. `init` still establishes legacy `working-spec.yaml` as the default project contract

Observed behavior:
- Standard interactive and non-interactive init both generate `.caws/working-spec.yaml`.
- Success messaging, getting-started docs, and next-step instructions are all centered on the legacy working spec.
- Lite mode correctly avoids YAML-spec ceremony and writes `.caws/scope.json`, but standard init does not steer new projects toward feature specs.

Impact:
- New projects are still bootstrapped into the legacy path even though the command suite increasingly exposes multi-spec behavior.
- This makes later command consistency harder because the project’s initial mental model is still single-spec.

Relevant file:
- `packages/caws-cli/src/commands/init.js`

Desired behavior:
- Decide whether new standard projects should still default to legacy mode or create an initial feature spec.
- If legacy init remains, the docs and command suite should clearly describe when to migrate.

Current status:
- Mostly resolved locally.
- `init` now writes a canonical initial feature spec under `.caws/specs/<id>.yaml` and a matching `.caws/specs/registry.json`.
- `.caws/working-spec.yaml` is retained as a compatibility mirror of that initial spec rather than the intended long-term source of truth.
- Remaining open question: whether a future release should stop generating `working-spec.yaml` entirely once downstream compatibility paths are retired.

### 17. `worktree` has strong isolation mechanics but still generates legacy per-worktree specs

Observed behavior:
- Worktree creation records `specId` in the registry and enforces ownership/session protections.
- It copies `.caws/` into the worktree but excludes worktree registry internals.
- If `specId` is provided, it generates a fresh `.caws/working-spec.yaml` inside the worktree using `generateWorkingSpec()` rather than resolving/copying the canonical feature spec file.

Impact:
- Worktree isolation is operationally strong, but spec semantics drift:
  the registry says the worktree is associated with a feature spec ID, while the worktree itself gets a synthesized legacy working spec snapshot.
- The generated working spec is not guaranteed to match `.caws/specs/<specId>.yaml`.

Relevant files:
- `packages/caws-cli/src/worktree/worktree-manager.js`
- `packages/caws-cli/src/commands/worktree.js`

Desired behavior:
- Use feature specs as the canonical worktree spec source when `specId` is provided.
- If a compatibility working spec is still needed inside the worktree, generate it from the resolved feature spec rather than from generic defaults.

Current status:
- Resolved locally.
- If a canonical feature spec exists in `.caws/specs/<specId>.yaml|yml`, the worktree now carries that exact content into both `.caws/specs/` and the local compatibility `working-spec.yaml`.
- If no canonical spec file exists, the previous generated fallback still applies for compatibility.

### 18. `parallel` preserves branch/worktree isolation, but not spec-source consistency

Observed behavior:
- Parallel setup reads `spec_id` from the plan and passes it through to `createWorktree()`.
- Status and merge flows are built around worktree/branch state and conflict detection, not spec validation state.
- Because `createWorktree()` currently synthesizes a legacy working spec per worktree, parallel runs inherit that same spec drift behavior.

Impact:
- The multi-agent workspace model is solid for git isolation, but the spec layer underneath is still split between canonical feature specs and generated per-worktree working specs.
- This creates a risk that agents in isolated worktrees operate on different spec content than the main project registry/resolver would return.

Relevant files:
- `packages/caws-cli/src/parallel/parallel-manager.js`
- `packages/caws-cli/src/worktree/worktree-manager.js`
- `packages/caws-cli/src/commands/parallel.js`

Desired behavior:
- Parallel orchestration should either mount/copy the canonical feature spec into each worktree or define a deliberate synchronization model.
- The parallel registry should be auditable against the canonical spec files, not just a `specId` string.

Current status:
- Mostly resolved locally via the `worktree` fix.
- Parallel setup now benefits from canonical feature-spec propagation automatically when `spec_id` points at a real feature spec.
- Registry auditability is still string-based; if we want stronger provenance here, that is a separate enhancement.

### 19. Positive note: worktree/parallel ownership protections are one of the stronger parts of the suite

Observed behavior:
- Worktree registry entries track owner session IDs.
- Create/destroy/prune flows refuse destructive actions against another session’s active resources without force.
- Parallel merge strategy is restricted to `merge` or `squash`; `rebase` was explicitly removed as unsafe for shared agent workflows.

Impact:
- The workspace-isolation layer is more coherent than the spec-resolution layer.
- This is a good foundation for tightening spec consistency without redesigning multi-agent operations from scratch.

## Additional Findings: Support Commands And Utilities

### 20. `tutorial` now teaches feature-spec-first workflow

Observed behavior:
- Developer setup tutorial now leads with `caws specs create` instead of `caws mode set`.
- Workflow commands section now shows `--spec-id` usage for validate, status, evaluate, and burnup.
- Multi-spec system tutorial step was already current.

Current status:
- Resolved locally.

### 21. `session` now derives project identity from feature specs

Observed behavior:
- `session start` accepts `specId` and passes it to `getProjectName()` and `getSkeinId()`.
- Both functions now check: explicit specId → registry active specs → legacy working spec → directory basename.
- Capsule identity aligns with the session's target spec.

Current status:
- Resolved locally.

### 22. `test-analysis` exposes `--spec-id` in the CLI but ignores it in implementation

Observed behavior:
- The CLI registers `--spec-id` for `caws test-analysis`.
- The implementation parses only a raw `--spec <path>` from the subcommand options array.
- `assess-budget` and `find-similar` default to `.caws/working-spec.yaml`.
- Historical analysis does include both legacy and feature spec paths when mining git history, but current-spec selection is still legacy/path-based.

Impact:
- Users are told the command supports feature-spec targeting, but the implementation does not honor that contract.
- Analytics can be run against the wrong spec even though the project has canonical feature specs available.

Relevant files:
- `packages/caws-cli/src/index.js`
- `packages/caws-cli/src/test-analysis.js`

Desired behavior:
- Either wire `--spec-id` through to resolver-based current-spec loading, or remove the flag until it is supported.

### 23. Utility and helper messaging — partially resolved

Audit of hardcoded `.caws/working-spec.yaml` references:
- `error-handler.js` — reference in error messages only (documentation), not loading. Acceptable.
- `finalization.js` — reference in artifact list and help text. Acceptable.
- `quality-gates-utils.js` — `detectCrisisMode()` now scans `.caws/specs/` first, then legacy. Resolved.
- `detection.js` — checks existence for CAWS detection. Intentional (working-spec presence IS a valid CAWS signal). Acceptable.
- `working-spec.js` — generator for legacy compatibility mirror. Intentional.
- `budget-derivation.js` — no hardcoded references found. Uses PolicyManager.

Current status:
- Actionable references resolved (quality-gates-utils, session-manager, burnup).
- Remaining references are documentation/detection/generation — intentional for legacy compatibility.

### 24. Validation’s fallback “validate all specs” path — already correct

Observed behavior:
- Fallback branch uses `checkMultiSpecStatus()` for spec count, then `loadSpecsRegistry()` for actual spec IDs.
- Does NOT reference the broken `status.registry?.specs` pattern — it loads registry separately.
- Iterates through registry spec IDs correctly.

Current status:
- Resolved locally (was already correct at time of audit verification).

## Short-Term Remediation Direction

Prefer this order:

1. Unify spec resolution for `status`, `diagnose`, and `evaluate`.
2. Fix gate-layer legacy assumptions, starting with `spec_completeness`.
3. Fix `validate` scope-conflict plumbing.
4. Define suite behavior for `archive`, `verify-acs`, and `provenance`.
5. Decide the canonical spec model for `init`, `worktree`, and `parallel`.
6. Make `specs update` rollback-safe.
7. Align support commands and user-facing guidance (`tutorial`, `session`, `test-analysis`, help text).
8. Audit remaining commands for resolver bypasses.

## Quick Wins First (all resolved)

These are the highest-signal, lowest-orchestration fixes from the audit. All have been implemented.

### Quick win 1: make `status`, `diagnose`, and `evaluate` use `resolveSpec()`

Why this is quick:
- These are top-level command handlers.
- The change is mostly local to each command.
- It removes obvious user-facing contradictions immediately.

Expected payoff:
- `--spec-id` starts working consistently in high-visibility commands.
- Multi-spec projects stop getting false legacy-only failures.
- Output becomes easier to trust during release validation.

Suggested scope:
- `packages/caws-cli/src/commands/status.js`
- `packages/caws-cli/src/commands/diagnose.js`
- `packages/caws-cli/src/commands/evaluate.js`

### Quick win 2: fix broken registry plumbing in `validate` and `plan`

Why this is quick:
- The bug is concrete and localized: both commands reference registry data that `checkMultiSpecStatus()` does not return.
- This does not require redefining the overall spec model.

Expected payoff:
- Scope-conflict checks in `validate` can actually run.
- `plan generate` auto-detect and multiple-spec guidance stops failing misleadingly.

Suggested scope:
- `packages/caws-cli/src/commands/validate.js`
- `packages/caws-cli/src/commands/plan.js`
- possibly a small resolver helper that returns canonical active spec IDs

### Quick win 3: fix `spec_completeness` to consume resolved spec input, not hard-coded legacy path

Why this is quick:
- This is one gate with one clear legacy assumption.
- Command-level `gates` already resolves a spec.

Expected payoff:
- `caws gates` stops disagreeing with `caws validate` in multi-spec projects.
- CI behavior becomes more predictable without touching the entire gate suite.

Suggested scope:
- `packages/caws-cli/src/gates/spec-completeness.js`
- `packages/caws-cli/src/commands/gates.js`

### Quick win 4: make `specs update` rollback-safe

Why this is quick:
- The failure mode is isolated and already well understood.
- It can be fixed with backup/restore or temp-write-and-rename logic.

Expected payoff:
- Prevents invalid partial writes during spec updates.
- Reduces risk while continuing adjacent spec-command work.

Suggested scope:
- `packages/caws-cli/src/commands/specs.js`

### Quick win 5: either wire or remove fake `--spec-id` support in `test-analysis`

Why this is quick:
- The mismatch is explicit.
- Either fix the flag or temporarily remove/document it.

Expected payoff:
- Reduces misleading CLI surface area.
- Prevents users from assuming support that does not exist.

Suggested scope:
- `packages/caws-cli/src/index.js`
- `packages/caws-cli/src/test-analysis.js`

## Probably Not Quick

These are important, but they cut across multiple systems and should be treated as coordinated changes.

### Coordinated change 1: choose the canonical spec model for multi-agent workspaces

Touches:
- `init`
- `worktree`
- `parallel`
- `provenance`
- session/workflow guidance

Decision needed:
- Is `.caws/specs/<id>.yaml` the canonical source everywhere?
- If yes, when and why do generated `working-spec.yaml` files still exist?

### Coordinated change 2: define default suite behavior when multiple active specs exist

Touches:
- `status`
- `verify-acs`
- `validate`
- `evaluate`
- `archive`
- support docs and tutorial flows

Decision needed:
- Should commands default to:
  - a single resolved current spec
  - all active specs
  - or hard-fail until `--spec-id` is supplied

### Coordinated change 3: make provenance/session/archive all describe the same unit of work

Touches:
- `archive`
- `provenance`
- `session`
- worktree/parallel metadata

Decision needed:
- What object is the audit trail centered on:
  - change folder
  - feature spec
  - legacy working spec
  - or a normalized “work item” abstraction

## Regression Test Ideas

- Multi-spec project with no legacy `working-spec.yaml`:
  `validate`, `status`, `diagnose`, `evaluate`, and `gates` should all operate on the same feature spec.

- Mixed project with both legacy and feature specs:
  commands should either resolve the requested `--spec-id` or clearly warn about fallback behavior.

- Invalid YAML in feature spec:
  commands should fail with actionable parse errors, not return empty/null state.

- Stale registry entry pointing to missing file:
  spec resolution should ignore the stale entry without selecting a non-existent spec.

- Failed `specs update`:
  original spec file should remain intact and registry state should remain consistent.

- Archive with embedded stale change spec plus `--spec-id`:
  command should have deterministic precedence and report which spec it archived against.

- Provenance update in a multi-spec project:
  entry should capture the intended feature spec, not require legacy `working-spec.yaml`.

- Worktree create with `--spec-id foo`:
  the isolated workspace spec should match canonical spec `foo`, not a synthesized generic working spec.

- Parallel setup with multiple `spec_id` values:
  each worktree should be verifiably aligned with its referenced canonical feature spec.

- Session start with `--spec-id foo`:
  session capsule identity, scope, and briefing should all align with feature spec `foo`.

- `test-analysis --spec-id foo`:
  current-spec analytics should run against feature spec `foo`, not silently fall back to `.caws/working-spec.yaml`.
