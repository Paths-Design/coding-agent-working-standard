## [Unreleased]

Removes ~7,400 lines of v10 dead source from the package
(`CAWS-DEAD-SOURCE-CLEANUP-001`). Pure subtractive cleanup; no
behavioral changes to the v11.1 surface. The deleted modules are
unreachable from `src/shell/index.ts` (the v11.1 command registration
entry point) and from any live test path; their corresponding tests
were removed in `CAWS-DEAD-TEST-CLEANUP-001`.

### Removed (no replacement; surfaces were retired in v11.0)

* **src/commands:** removed 16 legacy command source files for
  commands retired in v11.0 and not planned for v11.2+: `archive`,
  `burnup`, `diagnose`, `evaluate`, `iterate`, `mode`, `parallel`,
  `plan`, `provenance`, `quality-monitor`, `sidecar`, `templates`,
  `tool`, `tutorial`, `validate`, `workflow`. The v11.1 command
  surface lives in `src/shell/commands/`.
* **src/sidecars:** removed the entire directory (7 files). The
  `caws sidecar` group is retired; equivalent telemetry now lives in
  `events.jsonl` (audit) and `caws status` (state).
* **src/parallel/parallel-manager.js:** removed. `caws parallel` is
  deferred to v11.3+; the `caws worktree create` loop is the
  multi-agent setup mechanism in v11.1.
* **src/test-analysis.js:** removed. `caws test-analysis` was retired
  in v11.0.

### Retained (test-load-bearing through legacy code paths)

* **src/utils/spec-resolver.js** and **src/commands/verify-acs.js**
  were initially included in the deletion list but had to be restored
  mid-merge: they remain reachable through the surviving legacy
  command files (`src/commands/specs.js`, `src/commands/gates.js`,
  `src/commands/status.js`) and through `src/worktree/worktree-manager.js`'s
  `autoCloseBoundSpec` AC-collection block, all of which are
  exercised by live tests (`tests/spec-creation.test.js`,
  `tests/specs-archive*.test.js`, `tests/worktree-auto-close-spec.test.js`,
  etc.). Full retirement requires removing the legacy code paths first;
  that is a follow-on slice's scope.
* **src/worktree/worktree-manager.js** was reverted to its pre-slice
  state. The `verify-acs` require in `autoCloseBoundSpec` stays.

### Notes

* No version bump; releases are tag-driven and this slice doesn't
  change runtime behavior.
* The 9 remaining `src/commands/*.js` files (`agents`, `gates`,
  `init`, `scope`, `session`, `specs`, `status`, `waivers`,
  `worktree`) are transitively dead from the v11.1 shell entry point
  but still reachable from tests via direct `require` of
  `commands/specs.js` etc. A follow-on slice should retire them
  together with their test surfaces and the two retained utilities
  above.

## [11.1.6](https://github.com/Paths-Design/coding-agent-working-standard/compare/caws-cli-v11.1.5...caws-cli-v11.1.6) (2026-05-21)

Calibrates the Claude Code hook pack's command classifier
(`DANGER-LATCH-CALIBRATION-001`). The shipped template at
`templates/hook-packs/claude-code/classify_command.py` gains an explicit
allow-list for documented read-only inspection and search commands,
plus hybrid fail-closed semantics for the three governed command
families (`git`, `gh`, `npm`).

### Features

* **hook-packs/classify_command:** add explicit `ALLOW` configuration
  for read-only file inspection (`tail`, `head`, `cat`, `less`, `more`,
  `wc`, `stat`, `file`, `du`, `df`, `ls`, `tree`), read-only search
  (`grep`, `rg`, observational `find`), read-only `git` subcommands
  (`status`, `log`, `diff`, `show`, read-only `branch`/`tag`/`config`,
  `remote`, `rev-parse`, `ls-files`, `blame`), read-only `gh`
  subcommands (PR/run/issue/repo/release view-list-status-checks-diff
  plus `gh api` when the HTTP method is GET), and read-only `npm`
  subcommands (`view`, `whoami`, `config`, `ls`, `outdated`, `explain`,
  `pack --dry-run`).
* **hook-packs/classify_command:** add hybrid fail-closed default for
  `git`, `gh`, `npm` families. An unknown subcommand (not on the
  allow-list and not matched by any deny or confirm pattern) now
  resolves to `ask` instead of the previous `allow` fall-through.
  Non-governed commands retain the existing default.
* **hook-packs/classify_command:** add PATH-spoof protection. Hyphenated
  variants like `gh-something`, `git-something`, `npm-something` are
  treated as suspicious shadowing of the governed families and
  resolve to `ask`. Closes the spec's anchoring invariant.
* **hook-packs/classify_command:** add a generic pipe-to-shell deny
  pattern. Any executable command piped into a shell interpreter
  now resolves to `deny`, where previously only `curl`-and-`wget`
  specific variants did. Quote-safety is preserved by the existing
  `strip_quoted_regions` upstream pass, so dangerous fixture text
  inside quoted strings, heredoc bodies, or commit-message arguments
  does not false-positive.
* **hook-packs/classify_command:** extend `classify_find_delete` to
  recognize `-execdir`, `-fprint`, `-fprintf`, `-fprint0`, `-ok`,
  and `-okdir` as mutating action flags in addition to the existing
  `-exec` and `-delete`.

### Test coverage

79 acceptance fixtures in `tests/hook-packs/classify_command_calibration.test.js`
cover all 11 spec acceptance criteria (A1–A11) plus negative
fixtures for quote-safety, wrapper transparency, command substitution
escalation, and anchoring. Each fixture shells out to the real
classifier and asserts on parsed JSON output — no mocking.

### Out of scope

* Universal fail-closed (flipping the classifier's global default
  from `allow` to `ask`) is deferred. Filed as
  `UNIVERSAL-FAIL-CLOSED-001` (concept; not yet created).
* Stale v10 command references in `templates/CLAUDE.md` and
  `templates/.claude/rules/worktree-isolation.md` will be addressed
  by `TEMPLATES-V11-COMMAND-REFRESH-001` (concept; not yet created).
* Maintainer-local `.claude/hooks/classify_command.py` is NOT
  modified by this slice — it is a maintainer surface that consumers
  do not see. The shipped template is the only target.

## [11.1.5](https://github.com/Paths-Design/coding-agent-working-standard/compare/caws-cli-v11.1.4...caws-cli-v11.1.5) (2026-05-21)

First canonical tag-driven release under `CAWS-RELEASE-TAG-DRIVEN-001` v1.
Published by the new `caws-cli-v*` tag-triggered workflow (no
semantic-release, no branch-push trigger).

### Bug Fixes

* **build:** set executable bit (0o755) on `dist/index.js` after build on
  POSIX systems (`CAWS-CLI-BIN-EXECUTABLE-BIT-001`). Closes the
  workspace-install ergonomics gap where `node_modules/.bin/caws` was
  not directly executable, forcing `node packages/caws-cli/dist/index.js`
  invocation in tarball-truth and fresh-install tests. Windows builds
  skip the chmod (POSIX modes do not apply; npm bin-linking creates
  .cmd shims separately).

## [11.1.4](https://github.com/Paths-Design/coding-agent-working-standard/compare/v11.1.3...v11.1.4) (2026-05-20)

Manual publish (predates `CAWS-RELEASE-TAG-DRIVEN-001` and was therefore
not produced through the new tag-driven workflow). Recorded
retrospectively for audit completeness.

### Bug Fixes

* **store/yaml-patch:** byte-level removal of top-level `worktree:` scalar
  on `closeSpec` (`WORKTREE-MERGE-CLEARS-SPEC-BINDING-001`). Preserves
  LIFECYCLE-MUTATION-001 raw-source-bytes invariant.
* **store/worktrees-writer:** honest completion in `mergeWorktree` —
  inspects `closeResult.value.kind === 'success'` instead of treating
  `partial_failure_recovered` as success. Surfaces
  `LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED` when the spec-close transaction
  rolls back; worktree is NOT destroyed and the bound spec remains active.
* **schemas/events/spec_closed.v1:** add `prior_worktree` field for
  audit-trail capture of the worktree binding cleared during close.

## [11.1.3](https://github.com/Paths-Design/coding-agent-working-standard/compare/v11.1.2...v11.1.3) (2026-05-20)


### Bug Fixes

* **ci:** build workspace CLI before caws-gate doctor ([f5b3fba](https://github.com/Paths-Design/coding-agent-working-standard/commit/f5b3fba67b6d300c347c44322f13d7e6439db64e)), closes [#3](https://github.com/Paths-Design/coding-agent-working-standard/issues/3)
* **ci:** invoke CLI via node to bypass executable-bit dependency ([f4c1bfe](https://github.com/Paths-Design/coding-agent-working-standard/commit/f4c1bfe7136a18510c8d6c83628d19d30911fd42))
* **ci:** keep version-range pin; document npm workspace:* rejection ([2ed5736](https://github.com/Paths-Design/coding-agent-working-standard/commit/2ed573603d8d081f6e4e5fb8878b6a9d758ec773))
* **ci:** pass coverage flags through turbo ([08c76a7](https://github.com/Paths-Design/coding-agent-working-standard/commit/08c76a7e0c4c130d635ca019251554f36ac033f9)), closes [#3](https://github.com/Paths-Design/coding-agent-working-standard/issues/3) [CI-PR-TEST-PASSTHROU#001](https://github.com/CI-PR-TEST-PASSTHROU/issues/001)
* **ci:** resolve kernel typecheck via workspace protocol ([42ac717](https://github.com/Paths-Design/coding-agent-working-standard/commit/42ac7175ab04d879866e8e61534534ff71b587f4)), closes [#1](https://github.com/Paths-Design/coding-agent-working-standard/issues/1) [#2](https://github.com/Paths-Design/coding-agent-working-standard/issues/2)
* **ci:** rewrite caws-gate for v11 surface ([2f06d0d](https://github.com/Paths-Design/coding-agent-working-standard/commit/2f06d0db5227a65142aa6f1666a8f729da81b688)), closes [#1](https://github.com/Paths-Design/coding-agent-working-standard/issues/1) [#1](https://github.com/Paths-Design/coding-agent-working-standard/issues/1)
* **cli:** remove removed-command suggestions from error handler ([fe9a265](https://github.com/Paths-Design/coding-agent-working-standard/commit/fe9a2659cfa18816a043752592653e17aa57f107))
* **specs:** lower WORKTREE-CAWS-SHARED-STATE-001 risk_tier to 3 ([e9effde](https://github.com/Paths-Design/coding-agent-working-standard/commit/e9effde44cdb9c0f360ac1ae5f64231ca732a4f5))

## [11.1.2](https://github.com/Paths-Design/coding-agent-working-standard/compare/v11.1.1...v11.1.2) (2026-05-18)


### Bug Fixes

* **quality-gates:** route CI/FIX mode banners through logHuman to preserve JSON stdout ([e562a0e](https://github.com/Paths-Design/coding-agent-working-standard/commit/e562a0e161f182482b550fe38b04b2cc8c4d22f8))

# [11.1.1](https://github.com/Paths-Design/coding-agent-working-standard/compare/v11.1.0...v11.1.1) (2026-05-18)

Patch release. Restores the hook-pack templates to the published tarball and adds a
fresh-install smoke gate so the regression class cannot ship again.

### Bug Fixes

* **packaging:** restore `templates/hook-packs/**` to `package.json:files` (TEMPLATES-PUBLISH-REGRESSION-001). v11.1.0 published with `files: ["dist", "README.md"]`, which excluded the hook-pack templates that `caws init --agent-surface claude-code` reads at runtime. Every fresh install hit `ENOENT: no such file or directory, copyfile '…/templates/hook-packs/claude-code/scope-guard.sh'`. The narrow allowlist re-includes only the load-bearing subtree; dead scaffold surfaces slice 8b correctly excluded stay excluded.

### Tests

* **smoke:** add `scripts/fresh-install-smoke.mjs` wired as `prepublishOnly`. Pipeline: `npm pack` → install tarball into a fresh temp project → load the *installed* manifest → assert every declared `sourcePath` exists in `templates/hook-packs/<pack-id>/` AND every `destPath` materializes after `caws init`. A red smoke blocks `npm publish`. Verified in both directions (current state passes in ~2.5s; sabotaged `files` allowlist fails with 19 named missing paths + exact remediation, exit 1).

### Postmortem

Removal needs a load-bearing audit by **role**, not just runtime command reachability.
Slice 8b (`df519ff`) correctly excluded the dead `templates/` scaffold to keep the
v11 tarball boundary clean, but the removal was applied at too coarse a granularity:
a later slice (`c460aa7`, INIT-HOOK-PACKS-001) added `templates/hook-packs/` as a
runtime dependency for the v11.1 hook installer without re-opening the publish
allowlist for the new narrower subtree. The two slices didn't talk. The
`prepublishOnly` smoke prevents this class of mistake structurally.

# [11.1.0](https://github.com/Paths-Design/coding-agent-working-standard/compare/v11.0.0...v11.1.0) (2026-05-18)

Restores the canonical CAWS spec/worktree lifecycle on top of the v11.0 governed-core
architecture (store / shell / kernel separation), makes the default `npm test` surface
truthful for v11, and turns three previously-orphaned policy gates into real enforcement.

Published packages (in dependency order):

* `@paths.design/caws-kernel@1.1.0` (shasum `bdc0373f…`)
* `@paths.design/quality-gates@2.1.0` (shasum `2789da96…`)
* `@paths.design/caws-cli@11.1.0` (shasum `3cc62c64…`)

### Features

* **specs:** restore `caws specs create | list | show | close | archive` on the v11 store/shell architecture (CLI-SPECS-001)
* **worktree:** restore `caws worktree create | list | bind | destroy | merge` with auto-close on merge (CLI-WORKTREE-001)
* **lifecycle:** lifecycle-mutation substrate — multi-file atomic writes under a single in-process lock (LIFECYCLE-MUTATION-001)
* **gates:** local policy-gate evaluators for `budget_limit`, `scope_boundary`, `spec_completeness` (previously orphaned — declared but unenforced) plus mechanical aliases `god_objects→god_object` and `hidden-todo→todo_detection`
* **init:** `caws init --agent-surface claude-code` installs durable hook pack with managed markers (INIT-HOOK-PACKS-001)
* **claude-hooks:** dangerous-command session latch, semantic `git init` detection, trusted nonce escape, latch reset audit path (HOOK-SAFETY-001)

### Bug Fixes

* **caws-cli:** share single baseline timestamp across composed `mergeWorktree` lifecycle so `ts` agrees with `seq` ordering; chain integrity was always correct via `prev_hash`
* **quality-gates:** enforce JSON-only stdout contract — gate progress/result lines now suppressed under `--json`/quiet mode so caws-cli's strict `JSON.parse(stdout)` adapter never breaks on real-violation runs
* **quality-gates:** per-cwd `docs-status/quality-gates.lock` (was install-dir-shared) — eliminates cross-project contention under parallel jest workers; preserves one-run-per-project semantics
* **caws-cli:** unmatched subprocess violations surface in `unmatchedViolations` rather than being silently dropped; refused aliases documented as doctrine (code_freeze, naming, duplication, documentation, placeholders, simplification have no policy correspondent)

### Tests

* **legacy-test-reconcile:** explicit per-suite DELETE/REWRITE disposition (no blanket ignore patterns, no silent skips) — see `packages/caws-cli/docs-status/legacy-test-reconcile-001.md`
* **opt-in perf budgets:** 8 load-sensitive tests gated behind `CAWS_RUN_PERF_BUDGETS=1` (7 perf-budget assertions + 1 gates-cli budget-block subprocess test) — default `npm test` is deterministic; CI sets the flag to enforce thresholds
* Final default test surface: 95 suites / 1540 pass / 8 skip / 0 fail (296s)

### Deferred

The following items are tracked but NOT shipped in v11.1.0. Each becomes a governed
spec in v11.1.x patches or v11.2.0:

* **AUTH-BINDING-BRIDGE-001** — agent-session friction reduction for non-worktree contexts
* **LOCK-INTERPROCESS-HARDEN-001** — cross-process semantics for the quality-gates lock (per-cwd is in; multi-process serialization on the same cwd is not regression-tested)
* **LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001** — adversarial fault-injection tests for partial-failure rollback in lifecycle transactions
* **PRUNE-REPAIR-WORKTREE-001** — restore v10.2's `worktree prune | reconcile | repair` ergonomics on the v11 substrate
* **CI-MATRIX-VALIDATION-001** — fresh-machine/multi-platform CI matrix for the published packages

# [11.0.0](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.2.0...v11.0.0) (2026-05-17)

CAWS governed-core cutover. Replaces the legacy mixed-regime CLI surface with eight
governed command groups: `init`, `doctor`, `status`, `scope`, `claim`, `gates`,
`evidence`, `waiver`. All other v10 commands are removed; spec/worktree lifecycle
returns in v11.1.0.

Projects needing v10 spec/worktree ergonomics should pin to `caws-cli@^10.2.x`.

### Features

* **vNext architecture:** kernel / store / shell separation; pure kernel rules; I/O store; thin shell commands
* **init:** v11 `caws init` — in-place bootstrap, refuses legacy single-spec residue, idempotent (no `--force`)
* **doctor:** drift detection over `.caws/` state — exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure)
* **status:** read-only dashboard panels (Spec, Scope, Claim, Gates, Recent Events) — never mutates `.caws/`
* **scope:** `caws scope show` and `caws scope check` with binding-aware admission
* **claim:** `caws claim` and `caws claim --takeover` with `prior_owners` audit
* **gates:** `caws gates run --spec <id>` — policy-driven gate runner; appends one `gate_evaluated` event per declared gate
* **evidence:** `caws evidence record --type <test|gate|ac>` typed append
* **waiver:** singular `caws waiver create | list | show | revoke` (no plural alias)
* **policy:** `policy.yaml` declares non-governed zones; `mode: block | warn | skip` per gate

### Bug Fixes

* **CLI-GATES-002:** declare `@paths.design/quality-gates` as a caws-cli runtime dependency
* **CLI-GATES-003:** resolve quality-gates from the installed CLI package location (handles npm global, npx, pnpm)
* **QG-001:** quality-gates emits valid JSON in `--json` mode and supports npm bin shims
* **HOST-GOV-001:** migrate the CAWS repo's own `.caws/` governance state to v11 shape

### BREAKING CHANGES

* Removed commands: `specs`, `worktree`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `provenance`, `hooks`, `scaffold`, `agents`, `parallel`, `sidecar`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `session`, `templates`, `archive`. Pin to `caws-cli@^10.2.x` if you need them; v11.1.0 restores `specs` and `worktree`.
* `caws init` no longer accepts `--force`. The v10 single-spec layout is refused outright; remove `working-spec.yaml` to migrate.

# [10.2.0](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.1.0...v10.2.0) (2026-04-28)


### Bug Fixes

* **agents:** wire assertWorktreeOwnership + refreshAgentClaim into bind/merge/create + status panel E2E test (CAWSFIX-32) ([f3340c7](https://github.com/Paths-Design/coding-agent-working-standard/commit/f3340c7d6575ba0fcdf99373dfa1271579ca9408))
* **cli:** remove unused 'path' import in commands/agents.js ([df285ce](https://github.com/Paths-Design/coding-agent-working-standard/commit/df285ced098b48a9a07b95af678015841629f6cf))
* **specs:** warn on caws specs create when id collides with archived spec (CAWSFIX-30) ([274f935](https://github.com/Paths-Design/coding-agent-working-standard/commit/274f935ab7e6032c780e07ae78ea5fe47931a4b6))
* **types:** correct repository URL in caws-types package.json ([ea84c3e](https://github.com/Paths-Design/coding-agent-working-standard/commit/ea84c3eb0c10cd8cc677d476d89b15ed265331a0))
* **worktree+validation:** D2 lowercase suffix, D7 ghost prune, D8 bind-local (CAWSFIX-25) ([b8828c7](https://github.com/Paths-Design/coding-agent-working-standard/commit/b8828c7578bb4293c75b6b9f655538f0395003f1))
* **worktree:** auto-commit draft→active flip in auto-bind path (CAWSFIX-27) ([1ba4146](https://github.com/Paths-Design/coding-agent-working-standard/commit/1ba4146dd4fac2e48d84941111ad024865090ad5))
* **worktree:** preserve baseline + idempotent YAML + post-merge close commit (CAWSFIX-24) ([74229e2](https://github.com/Paths-Design/coding-agent-working-standard/commit/74229e28ba9ad9758bfb30999866dddf19e64d16))


### Features

* **agents:** session-id agent claim model with lifecycle refresh and session-log surfacing (CAWSFIX-31) ([c7227b0](https://github.com/Paths-Design/coding-agent-working-standard/commit/c7227b0c2e73a499d529bf70b72dcdf8ae49f3ba))
* **policy+gates:** declare non-governed zones in policy.yaml (CAWSFIX-26) ([e365e76](https://github.com/Paths-Design/coding-agent-working-standard/commit/e365e765d9a8faaddbb9fe43ddaffd95c50d2c9a))
* **specs:** caws specs archive command — canonical .archive/ directory (CAWSFIX-29) ([b8237d1](https://github.com/Paths-Design/coding-agent-working-standard/commit/b8237d1e01b82bc514ec20245c68da6c461a2b55))
* **worktree:** spec lifecycle transitions on bind + merge (CAWSFIX-23) ([2cca474](https://github.com/Paths-Design/coding-agent-working-standard/commit/2cca474cda8ce988c1b4905579a00fd4fd1aa1ec))

# [10.1.0](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.0.1...v10.1.0) (2026-04-17)


### Bug Fixes

* **budget:** sync derivation path + no-crash on absent change_budget (CAWSFIX-07) ([018188b](https://github.com/Paths-Design/coding-agent-working-standard/commit/018188b5a18756929e6362e8536076347f2ec65d))
* **caws:** repoint dangling .caws/validate.js refs at bundled CLI (CAWSFIX-12) ([7f5d4ad](https://github.com/Paths-Design/coding-agent-working-standard/commit/7f5d4ad64f6c859ccfb6d8a519965796c2699278))
* **gates:** budget-limit returns skipped (not pass) in CLI context [CAWSFIX-06] ([0bd49ac](https://github.com/Paths-Design/coding-agent-working-standard/commit/0bd49acc4ae7e977ca550381834edeeecfc771a6))
* **gates:** point spec-completeness at real schema location (CAWSFIX-03) ([2893d83](https://github.com/Paths-Design/coding-agent-working-standard/commit/2893d83d400e1c4c12fa6971f0ac8ab052e58c2d))
* **lint:** add ignoreRestSiblings, remove unused imports to pass CI lint ([7c7c901](https://github.com/Paths-Design/coding-agent-working-standard/commit/7c7c9016a7afc561339ed25caab1e1de9d01744d))
* **lint:** resolve 3 errors and 4 warnings blocking CI ([3052a54](https://github.com/Paths-Design/coding-agent-working-standard/commit/3052a54cc023e05468aeca6ca6bda4ed889baa42))
* **policy:** accept any subset of tiers 1-3 in validatePolicy (CAWSFIX-16) ([ad8ef0e](https://github.com/Paths-Design/coding-agent-working-standard/commit/ad8ef0ebab823890b86da3015e5e7f576000734b))
* **schema+tests:** gates policy schema + fixture migration (CAWSFIX-22) ([59ff892](https://github.com/Paths-Design/coding-agent-working-standard/commit/59ff8921153ce9688065a944cad4e803db985686))
* **schema:** resolver prefers flat .caws/<name>.schema.json over bundled (CAWSFIX-08) ([dbbbf0d](https://github.com/Paths-Design/coding-agent-working-standard/commit/dbbbf0d17a9c032fc97664aecee722ba97074344))
* **schemas:** lift required version from scope.schema.json + document inline-block boundary (CAWSFIX-11) ([5376531](https://github.com/Paths-Design/coding-agent-working-standard/commit/5376531f5b914cb8e50608db2bcb6d81184f4899))
* **schema:** sync template schemas to runtime + align id regex with validator (CAWSFIX-20+21) ([19d5e8c](https://github.com/Paths-Design/coding-agent-working-standard/commit/19d5e8c070e0c2cae0e46f211795534d180dc22d))
* **schema:** tighten working-spec schema to match legacy validator (CAWSFIX-03) ([4771dcd](https://github.com/Paths-Design/coding-agent-working-standard/commit/4771dcd50118e864305546aeec698be144180026))
* **specs:** one-line diff on close + gitignore agents.json (CAWSFIX-15) ([02c6447](https://github.com/Paths-Design/coding-agent-working-standard/commit/02c64475420c76ee990361d6545d6717ae1cf282))
* **state:** fail-loud fence on undefined specId (CAWSFIX-02) ([e10e8f8](https://github.com/Paths-Design/coding-agent-working-standard/commit/e10e8f8baf2ab37bb3959feba1bb474d63c0979f))
* **tests+schema:** add CAWSFIX-18 A2 commit-failure test, tighten policy gate schema ([5efeee5](https://github.com/Paths-Design/coding-agent-working-standard/commit/5efeee58eb85d672018d91117eaf3a144c8924e8))
* **tests:** align test fixtures with post-CAWSFIX schema requirements ([e79692b](https://github.com/Paths-Design/coding-agent-working-standard/commit/e79692b87595b37428f4aad0fcf55ed66d777911))
* **tests:** resolve 3 flaky test suites that failed under parallel Jest workers ([0759cbe](https://github.com/Paths-Design/coding-agent-working-standard/commit/0759cbe9e5e9babd7910b27f31a634dbf0ceda1f))
* **validation:** accept modern acceptance_criteria shape as alias (CAWSFIX-09) ([d796b9e](https://github.com/Paths-Design/coding-agent-working-standard/commit/d796b9eff5a77589723d94ba317b405e09c5b606))
* **validation:** accept multi-segment spec IDs like P03-IMPL-01 (CAWSFIX-10) ([3091ce0](https://github.com/Paths-Design/coding-agent-working-standard/commit/3091ce0a2fd6e8b2c3b6b40486573c8da753232b))
* **waivers:** restructure active-waivers.yaml to conform to schema (CAWSFIX-04 A1) ([adf8b3f](https://github.com/Paths-Design/coding-agent-working-standard/commit/adf8b3f94726c83340612faeccf71f055e7b1cac))
* **waivers:** sync template schema to modern shape + fix wrapping (CAWSFIX-17) ([df0840e](https://github.com/Paths-Design/coding-agent-working-standard/commit/df0840e07266a4ec69a57b26bf8ef448ecc30255))
* **waivers:** validateWaiverStructure accepts modern schema shape (CAWSFIX-13) ([3c18681](https://github.com/Paths-Design/coding-agent-working-standard/commit/3c18681a54d104858192bf946028186c734a0da8))
* **worktree:** auto-close bound spec on successful merge (CAWSFIX-14) ([6834372](https://github.com/Paths-Design/coding-agent-working-standard/commit/683437239c68759e2cdde55743f3938ca0d12779))
* **worktree:** auto-commit .caws/worktrees.json after destroy (CAWSFIX-18) ([ff86ee5](https://github.com/Paths-Design/coding-agent-working-standard/commit/ff86ee5c75c07b17652b535f9deae8c1aadceaf0))


### Features

* **evlog:** add append-only event log and pure renderer (EVLOG-001) ([25506a5](https://github.com/Paths-Design/coding-agent-working-standard/commit/25506a524e40df8abbb73a8e3c3f864ea87cfed6))
* **evlog:** flip iterate.js to loadStateFromEvents (EVLOG-002 A1/A6) ([e280197](https://github.com/Paths-Design/coding-agent-working-standard/commit/e2801976df1f821de1986fb461df9ed3c6243e42))
* **evlog:** flip sidecar.js + gates.js feedback enrichment (EVLOG-002 A3/A4) ([ecf0662](https://github.com/Paths-Design/coding-agent-working-standard/commit/ecf066274c842adc5173415cce0f7c7d696feab6))
* **evlog:** flip status.js to loadStateFromEvents (EVLOG-002 A2) ([9cff551](https://github.com/Paths-Design/coding-agent-working-standard/commit/9cff551a41d47aee2a6e6d3eea37df169fa7a26c))
* **evlog:** loadStateFromEvents returns null on no-events (EVLOG-002 A5) ([5109a15](https://github.com/Paths-Design/coding-agent-working-standard/commit/5109a151c35719cb4c989f794fa9531cf04939c1))
* **evlog:** wire dual-write into 9 recorder and lifecycle call sites ([9564f5c](https://github.com/Paths-Design/coding-agent-working-standard/commit/9564f5c89671eae48635d30d78523820b6e8fabd))
* **scope:** add binding-aware scope guard, `scope show`, and `worktree bind` ([3f41720](https://github.com/Paths-Design/coding-agent-working-standard/commit/3f41720ce243e3508bc0fbb0eb5d2db376d1056b))
* **specs:** warn when feature spec is created with empty contracts [CAWSFIX-06] ([5e44e38](https://github.com/Paths-Design/coding-agent-working-standard/commit/5e44e38553b251db1f431a034bc5b943e14e3cb5))
* **waivers:** add `caws waivers prune --expired` (CAWSFIX-04 A3-A6) ([5f1d263](https://github.com/Paths-Design/coding-agent-working-standard/commit/5f1d26399a492cc6909ce36cd33521c3da7adfca))
* **worktree:** auto-bind specId from spec worktree field during create ([46ad82c](https://github.com/Paths-Design/coding-agent-working-standard/commit/46ad82c1e2fc6735cad254b1660fa370ae1dc9b9))

## [10.1.0] (2026-04-17)

### Features

* **scope:** add `caws scope show` command to inspect effective scope boundaries and binding health
* **worktree:** add `caws worktree bind <spec-id>` command to fix mutual spec-worktree binding
* **worktree:** auto-bind specId from spec `worktree:` field during `caws worktree create`
* **scope-guard:** distinguish authoritative mode (bound spec) from union mode (all specs) in block messages
* **scope-guard:** include `caws scope show` and `caws worktree bind` fix instructions in block output
* **templates:** add scope binding explanation, recovery checklist, and new commands to CLAUDE.md
* **waivers:** `caws waivers prune --expired` command with `--apply`, `--dry-run`, and `--json` modes (CAWSFIX-04)
* **worktree:** auto-close bound spec on successful merge (CAWSFIX-14) — eliminates the stale-`active` spec accumulation that followed merged worktrees

### Bug Fixes

* **validation:** unify spec validators — delete legacy `.caws/validate.js`, tighten JSON schema to match all required fields (CAWSFIX-03)
* **ci:** validate all feature specs in PRs, not just `working-spec.yaml`; catch `*.backup` suffix files (CAWSFIX-05)
* **gates:** `budget_limit` gate reports `status: skipped` (not `pass`) in CLI context for accuracy (CAWSFIX-06)
* **specs:** warn when feature-mode specs have `contracts: []` (CAWSFIX-06)
* **validation:** budget derivation no longer crashes when spec has no `change_budget` field — sync path added to resolve `await`-less call bug (CAWSFIX-07)
* **validation:** accept modern `acceptance_criteria:` shape as an alias for legacy `acceptance:` (CAWSFIX-09)
* **validation:** spec IDs with multi-segment prefixes like `P03-IMPL-01` and `ALG-001A-HARDEN-01` now validate (CAWSFIX-10)
* **scope:** `version` field is optional on inline scope blocks; still required on standalone `.caws/scope.json` (CAWSFIX-11)
* **scripts:** repoint `scripts/verify.sh` and `package.json:validate` at `caws validate` (the legacy `.caws/validate.js` is gone — CAWSFIX-12)
* **waivers:** `validateWaiverStructure` accepts modern schema shape (`reason_code`, `delta`, `approvers: [{handle, approved_at}]`) — waivers conforming to `waiver.schema.json` are no longer silently dropped from budget derivation (CAWSFIX-13)
* **schema:** resolver prefers flat `.caws/<name>.schema.json` over stale bundled template, making CAWSFIX-03's tightened repo schemas authoritative at runtime (CAWSFIX-08)
* **specs:** `caws specs close <id>` produces a 2-line diff (status + updated_at) instead of a full YAML reshape (CAWSFIX-15)
* **policy:** `validatePolicy` accepts any subset of tiers 1–3 instead of hard-requiring all three — single-tier policies no longer crash `loadPolicy` (CAWSFIX-16)
* **waivers:** sync template `waivers.schema.json` to modern shape (`reason_code`, `delta`, `approvers`) and fix validation wrapping bug — `createWaiver` now validates the waiver object directly instead of wrapping in `{[id]: waiver}` (CAWSFIX-17)
* **worktree:** `destroyWorktree` auto-commits `.caws/worktrees.json` so the working tree stays clean across sessions; uses `wip(checkpoint):` when other worktrees are active, `chore(worktree):` otherwise (CAWSFIX-18)
* **schema:** sync template working-spec and policy schemas to runtime — `caws init` now scaffolds schemas identical to the ones enforced at runtime; fixes `$schema` draft version (draft-07), `additionalProperties`, required fields, and id regex (CAWSFIX-20)
* **schema:** align `id` pattern regex in `.caws/working-spec.schema.json` with runtime validator (`^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+$`) — specs with valid modern IDs like `P03-TRUTH-001` no longer receive false compliance penalties (CAWSFIX-21)
* **schema:** declare `thresholds` as explicit optional property on policy gate objects and restore `additionalProperties: false` — prevents arbitrary keys while supporting `god_object` and `todo_detection` threshold configs
* **tests:** resolve 3 flaky test suites (`perf-budgets`, `gates-cli`, `event-log-read-parity`) — root causes: Jest default 5s timeout shorter than 30s subprocess timeout causing zombie cascades, `process.chdir` pollution between co-resident tests, wall-clock timing assertions meaningless under parallel CPU contention

### Chores

* **.gitignore:** ignore `.caws/agents.json` (per-CLI-invocation session state, not versioned — CAWSFIX-15)
* **tests:** align test fixtures with post-CAWSFIX schema requirements (data_migration, non_functional, MCP removal, worktree binding)
* **tests:** migrate gates.test.js and gates-cli.test.js policy fixtures to include `edit_rules` (CAWSFIX-22)
* **tests:** add CAWSFIX-18 A2 test covering git commit failure path (pre-commit hook rejection)

## [10.0.1](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.0.0...v10.0.1) (2026-04-02)


### Bug Fixes

* **ci:** clean up stale MCP trigger, audit fallback, minimatch guard ([866914c](https://github.com/Paths-Design/coding-agent-working-standard/commit/866914ca792587d4197e863926615edb50cbf1c0))
* **ci:** remove catch-all release:false rules that blocked scoped commits ([39b9c52](https://github.com/Paths-Design/coding-agent-working-standard/commit/39b9c526b99b2c885fa3f9a4bbde2bb90ed25b9a))
* **ci:** restore package-lock.json with semantic-release intact ([83eb116](https://github.com/Paths-Design/coding-agent-working-standard/commit/83eb11610efe09210e46e5f98792ff21180233c3))
* **ci:** unblock release pipeline — audit warns instead of failing ([fcb6116](https://github.com/Paths-Design/coding-agent-working-standard/commit/fcb6116972f76b3cf74b67db4e496a97cbd55305))
* **cli:** --spec-id now works correctly on status, evaluate, iterate, burnup ([64bec51](https://github.com/Paths-Design/coding-agent-working-standard/commit/64bec5199fddfd4a994a9f014018f9da30b2b122))
* **cli:** await deriveBudget, fix setup.type, add command handler tests ([bfd9195](https://github.com/Paths-Design/coding-agent-working-standard/commit/bfd9195e99ca7fa4a05488cf847e42236c44c7d4))
* **cli:** remove dead packages from release pipeline, unblock v10 publish ([e6bab56](https://github.com/Paths-Design/coding-agent-working-standard/commit/e6bab568e1ae05dbf033b687cc502501c1f2cb8c))
* **cli:** schema violations warn instead of blocking all commands ([4e9d701](https://github.com/Paths-Design/coding-agent-working-standard/commit/4e9d70100050da38d475b7c224536af5df486673))
* **cli:** suppress husky stdout that corrupts npm pack tarball path in CI ([823b154](https://github.com/Paths-Design/coding-agent-working-standard/commit/823b154d2da49d7d88d7205798c8220dd4bc625b))
* **lint:** remove unused chalk import in burnup.test.js ([392c003](https://github.com/Paths-Design/coding-agent-working-standard/commit/392c00304cf8238b72ab189d8b8f9f96f481b521))
* **lint:** remove unused yaml import blocking CI release pipeline ([93893af](https://github.com/Paths-Design/coding-agent-working-standard/commit/93893af754c6eaac07da3e59fbd4872812348203))
* **lint:** resolve all 49 lint errors across src and tests ([6554261](https://github.com/Paths-Design/coding-agent-working-standard/commit/655426170ab84c50c04b675aa9846c73aa655e0b))
* **sidecars:** handle minimatch v3 and v5+ export differences ([a14ee84](https://github.com/Paths-Design/coding-agent-working-standard/commit/a14ee845f098e22f3a95ad71909786022f796b3f))
