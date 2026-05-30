# CLAUDE.md

Project-specific guidance for Claude Code agents working on the CAWS repository.

## This repo self-hosts

CAWS (Coding Agent Working Standard) is both the framework and a live user of it. The `.caws/` directory drives real quality gates on this codebase.

The v11 cutover is complete. `main` runs the v11.1 surface, published to npm as `@paths.design/caws-cli` on the `latest` dist-tag. **Doctrine source:** `docs/architecture/caws-vnext-command-surface.md`. Read §1 (cutover posture) and §6 (architectural invariants) before making decisions.

**For teams migrating from v10.2:** read [`docs/migration-v10-to-v11.md`](docs/migration-v10-to-v11.md) first. v11.1 is the canonical line for new work but is **not a drop-in replacement** for every v10.2 workflow — some commands (`sidecar`, `burnup`, `verify-acs`, `evaluate`, `test-analysis`) are removed without v11.1 replacements, while `agents list/show` now ships in the v11.1 surface. The migration guide classifies every v10.2 command into one of four buckets (Replaced / Renamed / Removed-no-replacement / Deferred), documents the rollback one-liner, and includes CI migration recipes.

## v11.1 ships thirteen command groups

```
init  doctor  status  scope  claim  gates  evidence  events  waiver  specs  worktree  agents  prepush
```

(The governed-core groups plus lifecycle, event-maintenance, agent-liveness, and the `prepush` governed pre-push range check. `prepush` (MULTI-AGENT-PUSH-RANGE-GUARD-001) classifies the outgoing commit range and refuses commits not attributable to the current slice — it does NOT run `git push` itself.)

Removed in v11.0 and not planned to return: `scaffold`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `archive`, `provenance`, `sidecar`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `templates`, legacy `hooks install`. The hash-chained `.caws/events.jsonl` is the audit surface; users wire their own hooks against `caws gates run`.

Currently absent: `caws claim --spec <id>` (bridge claims for non-worktree contexts) and `caws worktree prune/reconcile`. `caws agents list/show` ships in v11.1 for read-only agent lease inspection.

**Deferred to v11.3+**: `caws session` and `caws parallel`. The `caws worktree create` loop replaces `parallel` for multi-agent setup.

## Before you start

1. Run `caws status` and `caws doctor`. The `claim` panel surfaces worktree ownership; doctor surfaces drift.
2. For multi-agent work: create your worktree with `caws worktree create <name> --spec <id>`. The command writes the bidirectional worktree↔spec binding, registers ownership, and emits the `worktree_created` + `worktree_bound` events. There is no `caws parallel setup` — loop `caws worktree create` per spec.
3. `caws claim` surfaces or takes worktree ownership. `caws claim --takeover` acquires from a foreign session and writes a `prior_owners` audit entry.
4. When you create or update your CAWS spec, ensure that it is committed after changes to avoid multi-agent confusion.

## v11 spec workflow

- Specs live at `.caws/specs/<id>.yaml`. There is no project-level working spec.
- v11.1 ships `caws specs create/list/show/close/archive/retire-draft`. Author specs via the CLI; `caws doctor` and `caws gates run --spec <id>` validate.
- Acceptance criteria use Given/When/Then format (see existing specs in `.caws/specs/` for the shape).
- **Lifecycle exits by current state:** active → `caws specs close`; closed → `caws specs archive`; **never-activated draft → `caws specs retire-draft <id>`**. retire-draft is the governed exit for a draft that should never have existed — it deletes the draft via tombstone and appends a recoverable `spec_retired` event (recover with `caws specs show <id> --archived`). **Do NOT `git rm .caws/specs/<id>.yaml`** to retire a draft: raw deletion bypasses the YAML-state audit, the hash-chained event, and the recovery path. `caws specs create` always makes *active* specs, so a `draft` on disk is either hand-authored or pre-existing residue — retire-draft is its sanctioned removal.

## Governed paths (require special handling)

- `.caws/policy.yaml` — owns gate `mode` (block/warn/skip). Waivers filter violations; they do not change gate mode.
- `CODEOWNERS` — reviewer routing.
- `change_budget` keys in any spec YAML — use waivers, not edits.
- Pre-commit hooks — do not bypass with `--no-verify`.

Legitimate escape: `caws waiver create <id> --gate <gate> --reason "..." --approved-by "..." --expires-at <iso8601>` (singular `waiver`, not plural `waivers`).

## Spec authoring discipline (avoid these specific traps)

These patterns waste scope-strike budget and force unbinds/scope rewrites mid-implementation. Get them right at spec-activation time:

1. **`scope.in` paths must match real file extensions.** Test files are `*.test.js`, not `*.test.ts`, even when the production code is TypeScript. If you list `tests/store/yaml-patch.test.ts` in `scope.in` but the file on disk is `tests/store/yaml-patch.test.js`, the scope guard rejects edits to the real file. Always `ls` the test directory before authoring `scope.in` lines for tests.

2. **`scope.out` cannot contain glob patterns.** `.github/workflows/**` is rejected by `spec.schema.scope.out_glob_forbidden`. Use directory paths only: `.github/workflows` matches the directory; the schema requires nothing more. Same rule applies to any sub-path: `packages/foo/**` → `packages/foo`.

3. **Risk_tier 2 requires `contracts`.** Every spec on `main` currently uses `contracts: []` for compatibility, which is a known schema-vs-practice gap, but it means tier-2 specs need at least one contract entry to load. If your slice is genuinely tier 2 but cross-package work, declare a contract; if it's structurally a chore, set `mode: chore` (which doesn't require contracts) and use a `fix(scope):` commit type for release-guard publishing. **Mode and commit type are separate concerns:** the release guard reads commit-message scope (`fix(cli):` publishes), not spec mode.

4. **`scope.out` is enforcement, not documentation.** Listing a sibling spec's `scope.in` paths in your `scope.out` (e.g., to declare "I won't touch X") makes the scope guard refuse YOUR edits to those paths when both specs are active in union mode. Either omit the entry (the kernel only enforces `scope.in` admittance) or accept that you cannot edit those paths even legitimately.

5. **Kernel-change escape clause must be explicit.** If your spec excludes `packages/caws-kernel/src` and investigation later proves a kernel-side change is necessary (e.g., adding a property to an event schema), the spec must be amended to add the specific kernel file to `scope.in` before the edit. The scope guard treats `packages/caws-kernel/src` as a literal prefix match — adding `packages/caws-kernel/src/schemas/events/spec_closed.v1.json` to `scope.in` admits that file specifically while leaving the rest of the kernel out.

6. **`non_functional` admits exactly four subkeys: `accessibility`, `performance`, `reliability`, `security`.** These are enumerated in `packages/caws-kernel/src/schemas/spec.v1.json` (the `non_functional` object has `additionalProperties: false` and these four `properties`). Adding `observability`, `maintainability`, or any other top-level key under `non_functional:` produces `spec.schema.violation: Unknown field "..." is not permitted`. Observability concerns belong under `reliability`. If you need a distinct surface, file a separate spec for it.

7. **Releases are tag-driven; branch pushes never publish.** As of `CAWS-RELEASE-TAG-DRIVEN-001` v1, the Release workflow triggers only on `caws-cli-v*` tag pushes — never on `push: branches: [main]`. The maintainer manually bumps `packages/caws-cli/package.json`, authors a `packages/caws-cli/CHANGELOG.md` section for the version, commits, then pushes a canonical tag (`caws-cli-vX.Y.Z`). CI publishes that tagged content verbatim. CI never modifies `package.json`, `CHANGELOG.md`, or any branch. See `docs/release-procedure.md` for the full procedure including the asymmetric failure invariant (pre-publish failures delete the tag; post-publish ancillary failures preserve it). Bare `v*` tags and `caws-kernel-v*` tags are explicitly refused in v1 (kernel still publishes manually).

## Scope-guard strike state (avoid stale lockouts)

The scope-guard strike counter is **session-global and accumulative**, not per-file or per-spec. Two important behaviors:

1. **A file that earned strikes earlier in the session stays "hot."** Even after you correct the underlying scope (e.g., add the file to a spec's `scope.in`), the guard does NOT re-evaluate prior strikes — it adds the next strike on top of the cumulative count. If you've already burned strikes 1 and 2 on `path/X`, the next edit will hard-block at strike 3 regardless of whether the scope is now correct.

2. **The recovery path is the strike-reset script, not the scope edit alone.** When the guard says "ask the user to run: `bash .claude/hooks/reset-strikes.sh --current`" — that's not optional. After correcting the scope cause, you still need to clear the accumulated strike state for the file.

The right discipline: don't speculatively edit a file before verifying it's in scope. Use `caws scope show <path>` first if uncertain. The check costs nothing and avoids burning a strike on a file you'll have to revisit.

## Scope authoring discipline (anticipate, don't react)

Scope amendments are normal and welcome — they're git-tracked, attributed to a specific commit, and `caws specs show` will display the updated scope. The maintainer is comfortable with you amending scope when you discover a path you legitimately need to edit. What burns time is NOT amendments — it's discovering the gap one strike at a time during implementation.

Avoid that pattern by planning scope BEFORE you start editing. Three concrete habits:

### 1. Run scope.in through the file-list lens, not the file-pattern lens

When you draft scope.in, mentally walk every file you'll create or modify in this slice:

- For every new `.ts` file you intend to create: is its exact path in scope.in?
- For every `*.test.js` / `*.test.ts` you'll write: does the test path with the correct extension match scope.in? (CLAUDE.md trap #1 — `.test.js` vs `.test.ts` mismatches are a common foot-gun.)
- For every comment-only edit you intend (deprecation markers, doctrine annotations): is the file in scope.in? The invariant body saying "add comment to X" is NOT scope admission.
- For every doctrine doc you'll touch (CLAUDE.md, AGENTS.md, COMMIT_CONVENTIONS.md, docs/architecture/*, docs/failure-lineage.md): is it in scope.in or admitted via `policy.root_passthrough`?
- For every integration test that creates real fixtures (linked worktrees, git repos): is the new test file path in scope.in?

If you're listing one or two paths and the rest are "in this directory," consider whether the directory itself is the right scope.in entry. The scope kernel treats scope.in entries as literal prefix matches (or globs where supported), not as documentation.

### 2. Amend scope BEFORE the speculative edit, not after the strike

When mid-implementation you realize a file isn't in scope:

- **Stop editing that file immediately.** A single edit on an out-of-scope path is strike 1. Three strikes hard-block until reset.
- **Run `caws scope show <path>`** to confirm the refusal and capture the spec id + exact missing entry.
- **Amend the scope with `caws specs amend-scope`** — the sanctioned path (CAWS-SCOPE-AMEND-COMMAND-001). It mutates the spec's `scope.in` on the canonical control plane, bumps `updated_at`, and appends a `spec_scope_amended` audit event — all in one governed transaction:
  ```
  caws specs amend-scope <SPEC-ID> --add path/one --add path/two
  ```
  Because scope resolves through canonical regardless of cwd, `caws scope check <path>` from your worktree ADMITs the added path **immediately** — there is **no `git cherry-pick` to run** (and therefore no danger latch to trip). Use `--remove`, `--add-out`, `--remove-out` as needed. Run it from anywhere (canonical or your linked worktree).
- **Do not chain amendments**. If you need 3 files, `--add` all 3 in one `amend-scope` call, not three.
- **Fallback (rare):** if `amend-scope` cannot cover the change (e.g. a non-scope spec field), hand-edit the canonical spec, commit it as `chore(caws): amend <SPEC-ID> scope for <what>` (bump `updated_at`), then `git cherry-pick` into your worktree branch. ⚠️ **Raw `git cherry-pick` engages the danger latch and requires a human reset** — prefer `amend-scope`, which avoids it entirely. (The classifier admits a cherry-pick that touches ONLY `.caws/specs/*.yaml` without latching, but `amend-scope` is still the first choice.)

### 3. Blast-radius and scope-collision review at draft time

When authoring a new spec, before flipping to `active`:

- **List every package, every directory tree, every test file, every doc, every hook template, every CI surface you might touch.** Put them in scope.in. Easier to over-include and trim than to scramble mid-implementation.
- **Cross-check `scope.out` against sibling specs' `scope.in`**. Per CLAUDE.md trap #4, listing a sibling's `scope.in` paths in your `scope.out` will refuse YOUR edits to those paths even when admitted. Either omit or accept the collision.
- **Cross-check governed paths** (`.caws/policy.yaml`, `CODEOWNERS`, `change_budget` keys) and explicitly list them in `scope.out` so future agents know you intentionally excluded them.
- **Cross-check active sibling worktrees**. If another agent is actively editing files in `packages/foo/`, putting `packages/foo` broadly in your scope.in creates a union-mode collision when both specs are active. Either narrow your scope or coordinate.

### Recovery checklist (when you hit a strike anyway)

If you accumulate strikes during a session:

1. **Stop editing the hot file.** Don't retry on the same path — each retry is another strike.
2. **Diagnose** with `caws scope show <path>` from inside the worktree. Capture the exact refusal message.
3. **Decide**: is the path legitimately in scope (amend needed) or genuinely out (revert your edit, route through a different file)?
4. **For "amend needed":** run `caws specs amend-scope <SPEC-ID> --add <path>` (writes canonical, no cherry-pick), then ask the user to run `bash .claude/hooks/reset-strikes.sh --current`. The reset is required because fixing scope alone does NOT re-evaluate prior strikes — the file stays "hot" at its accumulated count.
5. **For "genuinely out":** revert your edit, route the change through an in-scope file, and document the decision in the next commit message.

### Why this matters

Scope strikes don't just stop edits — they break the trust contract the user has with the slice. Each strike is evidence that the agent didn't think about scope before editing, which is the failure mode CAWS exists to prevent. A well-scoped slice with one or two clear amendments mid-implementation is healthy. A slice that burns three strikes on the same file mid-commit is a planning failure made visible.

The user's stance: amendments are fine because they're auditable. The cost is the strike state, the explanation, the recovery commit chain, and the user's time deciding whether the amendment is legitimate. Plan to avoid that cost, not to pay it three times in a row.

## Pre-edit admission protocol (mandatory)

`caws scope show <path>` is a **pre-edit admission check**, not a post-failure diagnostic. Every commit you author inside a bound worktree begins with an explicit proof block before any file write.

This protocol is non-optional. Strike reset is **not** part of normal workflow — a strike means the procedure failed, and the procedure must be explained and corrected before another reset is requested.

### The preflight proof block

The first thing you produce when starting a new commit is this block (literally — output it as text in your response before any tool call that writes a file):

```text
Commit <N> preflight:

Branch:
- <branch name>

Planned write targets:
- <path> (CREATE | MODIFY)
- <path> (CREATE | MODIFY)
- ...

Scope proof:
- caws scope show <path> => <ADMIT | REFUSE>
- caws scope show <path> => <ADMIT | REFUSE>
- ...

No edits before this proof is complete.
```

Then run the `caws scope show` calls. Then — only if every target returns ADMIT — start editing.

If any target returns REFUSE:

1. Stop. Do not edit anything.
2. Run **one** `caws specs amend-scope <SPEC-ID> --add <path>...` adding all missing paths in a single call (the sanctioned path — CAWS-SCOPE-AMEND-COMMAND-001). It writes canonical, bumps `updated_at`, and appends `spec_scope_amended`. **No `git cherry-pick`** — scope resolves through canonical, so the worktree sees the change immediately.
3. Rerun the scope-proof block. Every target must now return ADMIT.
4. Begin editing.

(Legacy fallback, only if `amend-scope` cannot express the change: hand-edit + commit the canonical spec, then `git cherry-pick` to the worktree — but that cherry-pick engages the danger latch and needs a human reset. Avoid it.)

### Post-edit verification (every commit)

After the edit phase and before `git commit`:

- Run the targeted tests for the surface you touched (`jest <path>`, kernel `npm test`, etc.).
- Run the relevant typecheck/build (`tsc`, turbo build for the package).
- Run `caws scope check <path>` on each written file (admission proof, not just show).
- Run `git status --short` to verify only the planned write targets are dirty.

Commit only when all checks pass or you can explain in the commit message why a check was deliberately skipped or expected to fail.

### Diagnostic files are write targets too

Probe scripts, scratch files, redirected diagnostic outputs, and any other "temporary" file the agent creates ARE subject to the preflight protocol. `/tmp/probe.js`, `scratch.txt`, `debug-output.log`, and anything similar count as writes.

**Concretely:**

- Do NOT write to `/tmp/` from the agent. The scope guard doesn't admit paths under `/tmp/` because they're not in any spec's `scope.in`. Use `node -e '...'` for inline JS, stdout/stderr redirection inside Bash for capture, or in-scope test instrumentation (a temporary `console.log` inside an already-admitted `*.test.js` file, removed before commit).
- Do NOT redirect diagnostic output to a new file unless that file's path is predeclared in the preflight write-target list AND passes `caws scope show`.
- Do NOT use Write tool for ANY purpose without preflight. There is no "but it's just a scratch file" exception. The hook fires on every Write call.

The valid escape hatches for diagnostic work:

- Inline Bash with `node -e`, `python -c`, `jq`, etc. — no file is written, only stdout returned.
- Temporary `console.log` inside an existing in-scope test file. Add, run, capture, remove before commit. The file itself stays scope-admitted.
- Reading existing artifacts (`fs.readFileSync`, `cat`, `jq` against a real on-disk file) — read is never gated, only writes are.

This rule exists because the agent earned a strike on `/tmp/migrator-probe.js` during CAWS-MIGRATE-V10-SPECS-001 commit 3 by treating "it's just a probe" as a license to skip the preflight. The strike system caught it. The protocol must catch it earlier — the agent's reasoning, not the kernel's enforcement.

### Demote intuition; trust proof

If your mental model says "this file is obviously in scope" but you haven't run `caws scope show`, your mental model has no authority. The kernel's scope decision is the only authority. The cost of running four `caws scope show` calls before commit 3 is roughly six seconds; the cost of one strike + amendment + cherry-pick + reset + explanation is several minutes of your turn and several minutes of the user's attention. The asymmetry is severe.

This rule exists because the failure mode it catches — agent edits before authority proof — compounds the exact class of control-plane drift the system is trying to eliminate (half-state worktrees, active specs without clean bindings, stale references, unfiled defects). One agent edit without scope proof creates the same kind of "guard exists but invariant was bypassed" defect that failure-lineage Entry 21 names as a load-bearing v11 lesson.

### Why this is in CLAUDE.md and not just a hook

The hook fires after the edit attempt. By then the strike is already on the counter, the file is hot, and recovery requires user intervention. The preflight protocol is the only mechanism that prevents the strike — it runs **before** the edit, in the agent's reasoning, not after, in the kernel's enforcement.

## Worktree discipline

When git worktrees are active for parallel agent work:

- Work only in your assigned worktree.
- Use the main repo's venv (`source <main-repo>/.venv/bin/activate`), not a per-worktree one.
- Commits to the base branch during active worktrees should use the `merge(worktree):` format.
- `caws claim` shows worktree ownership; `caws claim --takeover` acquires it from a foreign session and writes a durable `prior_owners` audit.
- v11 does not ship orchestration commands for worktree create/destroy/merge — use `git worktree` directly. Lifecycle helpers return in v11.1.

See `.claude/rules/worktree-isolation.md` for the full list.

## Canonical spec authority and sparse-checkout recovery (WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001)

Linked worktrees must NOT use worktree-local `.caws/specs/*` files as authority. The canonical `.caws/specs/` directory at the main checkout is the only authoritative location for spec content. CAWS resolves spec reads through the canonical control plane regardless of cwd — the kernel's `resolveRepoRoot` walks `git rev-parse --git-common-dir` upward from any cwd to find canonical, then reads specs from there. The sparse-checkout invariant on linked worktrees (`/*` + `!/.caws/specs/`) is the mechanical guard that prevents canonical spec bytes from being materialized as a divergent private copy inside the worktree filesystem.

**Do NOT:**

- Run `git sparse-checkout disable` (or any other agent-Bash `git sparse-checkout` subcommand) in a CAWS worktree. The `worktree-guard.sh` hook refuses every agent-issued `git sparse-checkout` invocation. Disabling sparse-checkout would re-open the v10.2 split-brain authority class: an editable spec copy inside a worktree, divergent from canonical, silently consulted by anything that walks cwd upward.
- `Read`, `Write`, or `Edit` files under `<linked-worktree>/.caws/specs/*`. The `worktree-write-guard.sh` hook refuses these tool calls before the broad `.caws/*` allowlist can exit 0. The files may exist via hostile or manual writes; CAWS does not treat them as authority and refuses the tool calls regardless.
- Ask the user to disable sparse-checkout so you can read a spec. That is the wrong recovery path. The sanctioned paths below resolve through canonical authority from any cwd.

**Do use:**

- `caws specs show <id>` — read a spec from any cwd (canonical or linked worktree). Resolves through canonical control plane.
- `caws specs list` — list specs from any cwd. Same resolver behavior.
- `caws scope show <path>` — inspect the scope decision for a path. Reads canonical scope authority.
- `caws scope check <path>` — enforce the scope decision (exit 0 admit, exit 1 reject).
- `caws worktree repair-sparse <name>` — restore the sparse-checkout invariant on a linked worktree (e.g., after a human-authorized sparse-checkout reconfiguration left the tree with materialized `.caws/specs/*` files). **Non-destructive**: refuses dirty or untracked content under `<wt>/.caws/specs/` rather than stashing, cleaning, resetting, or deleting work. If `.caws/specs/` is dirty, the command emits a typed diagnostic and asks for manual commit-or-remove before re-running.

**Doctrine boundary:**

Sparse-checkout in this project is a **materialization/recovery invariant**, NOT the authority model and NOT the scope-enforcement model. Scope is enforced by `scope-guard.sh` reading the spec's `scope.in`/`scope.out` from canonical. The sparse-checkout exclusion of `.caws/specs/` exists to prevent the split-brain class; it does not encode or implement scope.

See `.claude/rules/worktree-isolation.md` for the full list.

## v11 commands you'll use

- `caws init` — bootstrap canonical `.caws/` (idempotent; refuses legacy single-spec residue; no `--force`)
- `caws doctor` — drift detection over `.caws/` state. Exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure)
- `caws status` — read-only dashboard. Always observability — never mutates `.caws/`
- `caws scope show <path>` — explain the scope decision for `<path>`
- `caws scope check <path>` — enforce the scope decision (exits 0 admit / 1 refuse)
- `caws claim [--takeover]` — surface or take ownership of the current worktree
- `caws gates run --spec <id>` — run policy-driven quality gates; appends one `gate_evaluated` event per declared gate
- `caws evidence record --type <test|gate|ac> --spec <id> --data <json>` — append a typed evidence event
- `caws waiver create | list | show | revoke` — manage waiver records (singular, no plural alias)

Run `caws <group> --help` for full options.

## Implementation hygiene (lessons from prior sessions)

### Outcome inspection is not the same as Result inspection

The store layer's `Result<SpecWriterOutcome>` wraps **both** `{ kind: 'success' }` and `{ kind: 'partial_failure_recovered' }` in `ok()`. A caller that only checks `isOk(result)` will treat a rolled-back transaction as successful and continue. **Always inspect `result.value.kind` for store-layer outcomes**, especially in composed lifecycle commands like `mergeWorktree → closeSpec`. The patterns to look for:

```ts
if (!isOk(closeResult)) return err(...);
// NOT ENOUGH — partial_failure_recovered is wrapped in ok().
if (closeResult.value.kind !== 'success') return err(...);
```

This applies to every site that calls into specs-writer or worktrees-writer.

### Event-data fields must match the kernel schema

Event payloads under `packages/caws-kernel/src/schemas/events/*.v1.json` use `additionalProperties: false`. Adding a new field to a `data` block at the call site (without amending the schema) causes the lifecycle-transaction validator to reject the event, which triggers a rollback, which appears at the caller as `partial_failure_recovered`. If your slice needs a new audit field, the kernel schema must be updated **first** and the change must be in your spec's `scope.in`.

### Don't `git stash` while turbo dist is built

`git stash` will revert your working tree to the last committed state, but turbo's `dist/` cache reflects the pre-stash source. Tests that load `../../dist/store/yaml-patch.js` will run against stale code and produce confusing results. If you must stash:

```bash
git stash
./node_modules/.bin/turbo run build --filter=@paths.design/caws-cli... --force
# ...do whatever you stashed for...
git stash pop
./node_modules/.bin/turbo run build --filter=@paths.design/caws-cli... --force
```

Both rebuilds are required because turbo caches by source-file hash, not by working-tree state.

### Babel parse errors point at the wrong line

A redeclared `const` in a Jest test (`const events = readEvents(cawsDir)` twice in the same scope) produces a multi-page stack trace from `parseExpression`, NOT a clear "duplicate declaration" message. **First debugging step on a Jest parse error**: grep the file for the variable name in the failing test scope:

```bash
grep -n "const events =" path/to/test.js
```

If two declarations land in the same `it()` block, you've found it.

### Bash hook latches

This repo's hook pack includes a "danger latch" that fires on certain Bash patterns (especially `tail` outside a redirect, force-pushes, hard resets, deleted-tag pushes). If a latch fires once, every subsequent Bash call in the session is blocked until the user runs:

```bash
bash .claude/hooks/reset-danger-latch.sh
```

There's no way to dismiss this from the agent side. If you trip it, stop and ask the user to reset; don't try to re-run the same command in a different shape — the latch is intentional, and "shell trickery to bypass it" is exactly the pattern it's there to catch.

### `npm whoami` vs token-based auth

Interactive `npm login` and `NPM_TOKEN` env-var auth are different identities to the registry. If your account has 2FA enabled, interactive `npm publish` still requires an OTP code (the `--otp=<code>` flag), even after `npm login`. Granular npm tokens can be configured with **"bypass 2FA for write actions"** — those work for `NPM_TOKEN`-based CI publishes but do NOT carry over to `npm whoami` sessions. If you see `EOTP` with a valid `npm whoami`, the token has 2FA-bypass and the session does not — use the token via env, not the interactive session.

## Decision cadence (act from local authority)

Default to making the narrowest reversible decision supported by local repo authority. Do not stop merely because there is ambiguity.

Before asking the maintainer, do one cheap grounding pass against:

1. The active spec: `scope.in`, `scope.out`, invariants, acceptance, closure notes.
2. Repo doctrine: this file, command-surface docs, release docs, and relevant architecture notes.
3. Existing code, tests, scripts, package metadata, and CLI help.
4. Recent commits when they directly govern the current slice.

If one path is locally supported, reversible, and within scope, take it. State the decision briefly and continue.

Ask for direction only on true blockers:

- External or irreversible mutation: `npm publish`, `npm dist-tag`, git tag push, force-push, unpublish, destructive deletion.
- Scope conflict that cannot be resolved by using the correct bound worktree or existing CAWS command.
- Direct contradiction between active specs, or between a spec and governed implementation.
- Missing credentials, missing files, or inability to reproduce required evidence.
- Any action that would edit guard state, spoof ownership/session state, bypass safety checks, or rewrite another active spec's contract.
- Broad refactor or policy change outside the current spec.

Do not ask merely because:

- Multiple implementation shapes exist but one is narrowest and evidence-supported.
- A test or CI failure has a clear local root cause.
- A small follow-up/hotfix spec is the obvious governance shape.
- A command failed once and the next diagnostic step is obvious.
- Existing specs or docs already answer the question.

Tool-call discipline:

- Every command must advance the slice.
- Do not repeatedly inspect the same help text, registry state, ownership state, or logs after the blocker is classified.
- Prefer one decisive grounding pass over many intermediate probes.
- Report meaningful work output, not a play-by-play of hesitation.

Failure cadence:

1. Classify the failure.
2. Identify the narrowest admissible fix.
3. If reversible and within scope, do it.
4. If out of scope but small and local, open a focused hotfix spec and proceed under that spec.
5. If external, irreversible, credential-bound, or safety-bound, stop with a precise handoff.

Observed anti-pattern to avoid: turning a stale local assertion into a three-option menu when the active spec, script source, and CI log support a narrow hotfix. Correct cadence: classify, open hotfix spec, fix, test, then stop at the tag-push or publish boundary.

## Test suite

- CLI tests (vNext shell + store): `cd packages/caws-cli && npx jest`
- Kernel tests: `cd packages/caws-kernel && npm test`
- Per `/Users/darianrosebrook/.claude/CLAUDE.md` session protocol: interpret pass counts critically, cite specific assertion evidence, call out false-confidence risks.

## References

- `docs/architecture/caws-vnext-command-surface.md` — **doctrine source**: A1 posture, kept commands, removed commands, invariants
- `AGENTS.md` — full agent quickstart (in-repo)
- `docs/agents/full-guide.md` — comprehensive agent workflow (note: post-8c.1 cleanup may still contain v10 historical context — cross-reference the doctrine doc)
- `.claude/rules/` — git safety + worktree isolation rules (already loaded by Claude Code)
- `docs/internal/claude-code-cross-analysis.md` — how CAWS compares to Claude Code's runtime harness
