# CLAUDE.md

Project-specific guidance for Claude Code agents working on the CAWS repository.

## This repo self-hosts

CAWS (Coding Agent Working Standard) is both the framework and a live user of it. The `.caws/` directory drives real quality gates on this codebase.

The v11 cutover is complete. `main` runs the v11 surface (currently published as `@paths.design/caws-cli@11.1.2`). v11.2 is in planning — see `docs/architecture/caws-vnext-command-surface.md` §1 ("v11.2 plan") for the multi-agent authority and observability work. **Doctrine source:** `docs/architecture/caws-vnext-command-surface.md`. Read §1 (cutover posture and v11.2 plan) and §6 (architectural invariants — invariants 1–7 are v11 core; 8–13 are v11.2 additions) before making decisions.

## v11.1 ships eleven command groups

```
init  doctor  status  scope  claim  gates  evidence  waiver  specs  worktree
```

(The eight v11.0 governed-core groups, plus `specs` and `worktree` restored in v11.1.)

Removed in v11.0 and not planned to return: `scaffold`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `archive`, `provenance`, `sidecar`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `templates`, legacy `hooks install`. The hash-chained `.caws/events.jsonl` is the audit surface; users wire their own hooks against `caws gates run`.

Currently absent and **planned for v11.2**: `caws agents list/show`, `caws claim --spec <id>` (bridge claims for non-worktree contexts), `caws worktree prune/repair/reconcile`. Until v11.2 ships, `caws status` + direct reads of `.caws/worktrees.json` and `.caws/agents.json` cover the agent-inspection use case.

**Deferred to v11.3+**: `caws session` and `caws parallel`. The `caws worktree create` loop replaces `parallel` for multi-agent setup.

## Before you start

1. Run `caws status` and `caws doctor`. The `claim` panel surfaces worktree ownership; doctor surfaces drift.
2. For multi-agent work: create your worktree with `caws worktree create <name> --spec <id>`. The command writes the bidirectional worktree↔spec binding, registers ownership, and emits the `worktree_created` + `worktree_bound` events. There is no `caws parallel setup` — loop `caws worktree create` per spec.
3. `caws claim` surfaces or takes worktree ownership. `caws claim --takeover` acquires from a foreign session and writes a `prior_owners` audit entry. In v11.2, `--takeover` will additionally emit a `claim_taken_over.v1` event (currently missing — known audit gap).

## v11 spec workflow

- Specs live at `.caws/specs/<id>.yaml`. There is no project-level working spec.
- v11.1 ships `caws specs create/list/show/close/archive`. Author specs via the CLI; `caws doctor` and `caws gates run --spec <id>` validate.
- Acceptance criteria use Given/When/Then format (see existing specs in `.caws/specs/` for the shape).

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

## Scope-guard strike state (avoid stale lockouts)

The scope-guard strike counter is **session-global and accumulative**, not per-file or per-spec. Two important behaviors:

1. **A file that earned strikes earlier in the session stays "hot."** Even after you correct the underlying scope (e.g., add the file to a spec's `scope.in`), the guard does NOT re-evaluate prior strikes — it adds the next strike on top of the cumulative count. If you've already burned strikes 1 and 2 on `path/X`, the next edit will hard-block at strike 3 regardless of whether the scope is now correct.

2. **The recovery path is the strike-reset script, not the scope edit alone.** When the guard says "ask the user to run: `bash .claude/hooks/reset-strikes.sh --current`" — that's not optional. After correcting the scope cause, you still need to clear the accumulated strike state for the file.

The right discipline: don't speculatively edit a file before verifying it's in scope. Use `caws scope show <path>` first if uncertain. The check costs nothing and avoids burning a strike on a file you'll have to revisit.

## Worktree discipline

When git worktrees are active for parallel agent work:

- Work only in your assigned worktree.
- Use the main repo's venv (`source <main-repo>/.venv/bin/activate`), not a per-worktree one.
- Commits to the base branch during active worktrees should use the `merge(worktree):` format.
- `caws claim` shows worktree ownership; `caws claim --takeover` acquires it from a foreign session and writes a durable `prior_owners` audit.
- v11 does not ship orchestration commands for worktree create/destroy/merge — use `git worktree` directly. Lifecycle helpers return in v11.1.

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
