# Investigation 01: Hook Surfaces — Pre-Rewrite Map

**Status:** delivered 2026-05-07
**Blocks:** Slice 0b (corpus capture), Slice 5b (hook integration)
**Source:** Explore agent audit of `.claude/`, `.git/hooks/`, `templates/`, `packages/caws-cli/src/scaffold/`

---

## Summary

### Where does CAWS intercept agent file mutation today?

CAWS intercepts agent file mutation at two distinct points in the Claude Code harness via PreToolUse and PostToolUse. The PreToolUse intercepts happen *before* the Write or Edit tool is executed — that is, before bytes land on disk. The blocking guards (`worktree-write-guard.sh`, `protected-paths.sh`, `scope-guard.sh`) all fire in this pre-write window and can refuse the write by returning exit 2. PostToolUse handlers (`quality-check.sh`, `validate-spec.sh`, `naming-check.sh`, `doc-frontmatter-check.sh`) run *after* the file has been written to disk; they can emit advisory `hookSpecificOutput` or attempt a `decision: block` (which suspends the agent turn but cannot undo the disk write that already happened).

At commit time, git hooks (`pre-commit`, `commit-msg`) form a second enforcement layer that blocks `git commit` if worktrees are active without the correct message format, CAWS validation fails, or quality gates fail. A third layer at `pre-push` runs the full test suite and CAWS validation before any remote push.

There is no interception at the OS or filesystem level; all guards depend on the agent using the Write/Edit tools rather than Bash redirects — though `block-dangerous.sh` partially covers the Bash-redirect case for the `worktree-write-guard.sh` file only.

### Which hooks are blocking vs advisory?

**Blocking** (exit 2 / `decision: block`):
- `cwd-guard.sh` (PreToolUse, Bash — blocks when CWD is gone)
- `block-dangerous.sh` (PreToolUse, Bash — blocks dangerous patterns and shell writes to the protected guard file)
- `worktree-write-guard.sh` (PreToolUse, Write|Edit — hard-blocks writes on base branch when worktrees are active)
- `protected-paths.sh` (PreToolUse, Write|Edit — exit 1 for hook files, exit 2 for strike-state files)
- `validate-spec.sh` (PostToolUse, Write|Edit on `.caws/**/*.yaml` — `decision: block` on YAML syntax errors)
- `quality-check.sh` (PostToolUse, Write|Edit on source files — `decision: block` on quality gate failures)
- `git pre-commit` (blocks commit when worktrees active without approved message format)
- `git commit-msg` (blocks non-conforming message format on base branch)
- `git pre-push` (blocks push when linting/tests/CAWS validation fail)

**Advisory / progressive**:
- `scope-guard.sh` uses a *progressive strike* model — strike 1 is a warning (allows write), strike 2 is `permissionDecision: ask`, strike 3+ is `decision: block`. **This is fail-open at strikes 1–2**, which contradicts the vNext fail-closed contract.
- `scan-secrets.sh` (PreToolUse, Read — advisory only)
- `worktree-guard.sh` (PreToolUse, Bash — blocks specific git commands when worktrees active)
- `naming-check.sh` / `doc-frontmatter-check.sh` (PostToolUse — advisory `hookSpecificOutput` only)

**Observational** (never block):
- Session/stop handlers: `audit.sh`, `session-log.sh`, `session-caws-status.sh`, `stop-worktree-check.sh`, `plan-transcript-snapshot.sh`, `plan-transcript-finalize.sh`

### Drift between hook surfaces

**Critical structural drift**: the live repo's `.claude/settings.json` has **no `hooks` key at all** — the dispatcher scripts exist in `.claude/hooks/dispatch/` but are not wired into any hook event. The harness is not calling any of them. By contrast, the template at `packages/caws-cli/templates/.claude/settings.json` has a full hooks configuration registering individual handler scripts directly (not via the dispatchers).

The live repo's dispatch architecture (`pre_tool_use.sh`, `post_tool_use.sh`, `session_start.sh`, `stop.sh`) represents a newer, consolidated approach that is not yet active.

Additional drift:
- The live `.claude/hooks/` directory contains handlers not present in the template (`cwd-guard.sh`, `quiet-merge.sh`, `guard-strikes.sh`, `plan-transcript-snapshot.sh`, `plan-transcript-finalize.sh`, `worktree-write-guard.sh` — the live version is substantially more complex than the template version).
- The Cursor template `scope-guard.sh` is advisory-only (warns, never blocks) while the Claude template version is capable of blocking.
- The template `settings.json` registers handlers individually without the dispatch layer; the live dispatch layer adds short-circuit-on-block semantics and the `run-handlers.sh` stdout "last wins" contract, which the individual-handler model lacks.

---

## Hook Surface Table

| Hook surface | File path | Trigger event | When it fires | Command invoked | Blocks or reports? | Source of origin | Notes |
|---|---|---|---|---|---|---|---|
| Claude harness settings (live) | `.claude/settings.json` | — | — | No hooks key | N/A — unwired | Repo | `permissions` and display settings only; hooks dispatch is NOT active in this file |
| Claude harness settings (template) | `packages/caws-cli/templates/.claude/settings.json` | PreToolUse/PostToolUse/SessionStart/Stop/PreCompact | Per event | Individual handler scripts | Varies per handler | CAWS init (scaffold) | Wires handlers directly; no dispatch layer |
| PreToolUse dispatcher | `.claude/hooks/dispatch/pre_tool_use.sh` | PreToolUse | Pre-write | Calls `run_handlers` with 8 handlers | Short-circuits on exit 2 | Repo | Not currently wired; would replace individual handler wiring |
| PostToolUse dispatcher | `.claude/hooks/dispatch/post_tool_use.sh` | PostToolUse | Post-write | Calls `run_handlers` with 7 handlers | No short-circuit (post-write semantic) | Repo | Not wired; `quiet-merge.sh` absent here — only PreToolUse |
| SessionStart dispatcher | `.claude/hooks/dispatch/session_start.sh` | SessionStart | Session open | `audit.sh session-start`, `session-caws-status.sh session-start`, `session-log.sh` | Never blocks | Repo | Not wired |
| Stop dispatcher | `.claude/hooks/dispatch/stop.sh` | Stop | Session close | `audit.sh stop`, `stop-worktree-check.sh`, `plan-transcript-finalize.sh`, `session-log.sh` | Never blocks | Repo | Not wired |
| CWD guard | `.claude/hooks/cwd-guard.sh` | PreToolUse (any) | Pre-any-tool | Check `pwd -P` existence | Blocks (exit 2) | Repo | Mitigates Claude Code issue #34344; no CAWS CLI call |
| Block-dangerous | `.claude/hooks/block-dangerous.sh` | PreToolUse (Bash) | Pre-Bash | Pattern match on `$COMMAND` | Blocks (exit 2) | Repo | Also guards `worktree-write-guard.sh` from shell-based self-modification (lines 27–50) |
| Worktree guard | `.claude/hooks/worktree-guard.sh` | PreToolUse (Bash) | Pre-Bash | Check `.caws/worktrees.json` / `.caws/parallel.json` via `node` | Blocks (exit 2) on git amend/stash/reset/push-force/rebase/cherry-pick when worktrees active | Repo | Also rewrites `caws worktree merge/destroy` commands via `quiet-merge.sh` contract |
| Quiet merge | `.claude/hooks/quiet-merge.sh` | PreToolUse (Bash) | Pre-Bash | Rewrites `caws worktree merge\|destroy` commands | Emits `updatedInput` (modifies command, does not block) | Repo | Must be last in PreToolUse chain; not in template |
| Protected paths | `.claude/hooks/protected-paths.sh` | PreToolUse (Write\|Edit) | Pre-write | Check `$HOOK_FILE_PATH` patterns | exit 1 for `.claude/hooks/**`; exit 2 for `guard-strikes-*.json` | Repo (live) + template | Template version differs slightly |
| Scope guard (live) | `.claude/hooks/scope-guard.sh` | PreToolUse (Write\|Edit) | Pre-write | `js-yaml` node inline; reads `.caws/working-spec.yaml` and `.caws/specs/*.yaml`; calls `guard_enforce_progressive_strikes` | Progressive: warn → ask-permission → block | Repo | Lines 31–41: 3-strike progressive model; reads `.caws/policy.yaml` non_governed_zones (lines 84–105) |
| Scope guard (template) | `packages/caws-cli/templates/.claude/hooks/scope-guard.sh` | PreToolUse (Write\|Edit) | Pre-write | `js-yaml` node inline; single working-spec only (no multi-spec) | Progressive warn/block | CAWS init | Older version: no worktree-binding awareness, no `policy.yaml` non_governed_zones, no `ALLOW_PREFIXES` |
| Worktree write guard (live) | `.claude/hooks/worktree-write-guard.sh` | PreToolUse (Write\|Edit) | Pre-write | Reads `.caws/worktrees.json`; runs `node` to check branch/worktree status | Blocks (exit 2) when on base branch with active worktrees | Repo | Lines 260–329: hard-blocks writes; also checks spec contention via inline node |
| Worktree write guard (template) | `packages/caws-cli/templates/.claude/hooks/worktree-write-guard.sh` | PreToolUse (Write\|Edit) | Pre-write | Same logic, older variant | Blocks (exit 2) | CAWS init | No `SPEC_CONTENTION_CHECK` logic present |
| Scan secrets | `.claude/hooks/scan-secrets.sh` | PreToolUse (Read) | Pre-read | Pattern match on filename/directory | Advisory only (exit 0 + `hookSpecificOutput`) | Repo + template | Never blocks; warns on secret-looking files |
| Quality check | `.claude/hooks/quality-check.sh` | PostToolUse (Write\|Edit) | Post-write | `caws quality-gates --context=commit --quiet` | Blocks (`decision: block`) on gate failure | Repo + template | Line 50: calls `caws quality-gates`; falls back to advisory if CAWS CLI absent |
| Validate spec | `.claude/hooks/validate-spec.sh` | PostToolUse (Write\|Edit on `.caws/**/*.yaml`) | Post-write | YAML syntax via node inline; `caws validate`; test_nodeids check | Blocks (`decision: block`) on YAML syntax error or `caws validate` failure | Repo + template | Lines 40–47: YAML parse block; lines 82–98: `caws validate` block |
| Naming check | `.claude/hooks/naming-check.sh` | PostToolUse (Write) | Post-write | Regex on `FILENAME_LOWER` | Advisory only (`hookSpecificOutput`) | Repo + template | Checks banned modifiers, version suffixes, datestamps |
| Doc frontmatter check | `.claude/hooks/doc-frontmatter-check.sh` | PostToolUse (Write\|Edit on `docs/**/*.md`) | Post-write | `head -1` + awk frontmatter parse | Advisory only (`hookSpecificOutput`) | Repo | Checks V1–V6 doc governance fields |
| Audit logger | `.claude/hooks/audit.sh` | PostToolUse / SessionStart / Stop | All events | `jq` JSONL append to `.claude/logs/audit.log` | Never blocks (exit 0) | Repo + template | Writes `audit-YYYY-MM-DD.log` and rolling `audit.log` |
| Plan transcript snapshot | `.claude/hooks/plan-transcript-snapshot.sh` | PostToolUse (ExitPlanMode) | Post-ExitPlanMode | `cp $TRANSCRIPT_PATH <plan>.transcript.jsonl` | Never blocks | Repo | Not in template; writes `$HOME/.claude/.pending-plan-snapshots` |
| Plan transcript finalize | `.claude/hooks/plan-transcript-finalize.sh` | Stop | Session close | Overwrites pending snapshots with final transcript | Never blocks | Repo | Not in template |
| Session log | `.claude/hooks/session-log.sh` | PostToolUse / SessionStart / Stop / PreCompact | All events | `python3 session_log_renderer.py` | Never blocks | Repo + template | Writes `tmp/<session-id>/` artifacts |
| Session CAWS status | `.claude/hooks/session-caws-status.sh` | SessionStart | Session open | `caws session briefing`; reads `.caws/worktrees.json` for active worktree warning | Never blocks (advisory stdout) | Repo + template | Lines 68–104: prominent warning if agent is on base branch while worktrees active |
| Stop worktree check | `.claude/hooks/stop-worktree-check.sh` | Stop | Session close | Reads `.caws/worktrees.json` | Advisory (stderr reminder) | Repo + template | Lines 43–44: if no worktrees exist, prints "Working on Main without a worktree is forbidden" |
| Guard strikes lib | `.claude/hooks/guard-strikes.sh` | (library, not a hook) | — | Provides `guard_enforce_progressive_strikes` to scope-guard.sh | N/A | Repo | Writes `.claude/logs/guard-strikes-<session>.json` |
| Git pre-commit (live) | `.git/hooks/pre-commit` | pre-commit | Pre-commit | `caws validate`, `caws gates run`, multi-agent guards, secret scan of staged files | Blocks (exit 1) | Repo (installed, tracked via scaffold) | Lines 166–267: `caws validate` + `caws gates run`; blocks base-branch commits when worktrees active |
| Git commit-msg (live) | `.git/hooks/commit-msg` | commit-msg | Commit message write | Reads `.caws/worktrees.json`; enforces `merge(worktree):` / `wip(checkpoint):` on base branch | Blocks (exit 1) | Repo | Lines 48–70 |
| Git post-commit (live) | `.git/hooks/post-commit` | post-commit | Post-commit | `caws provenance update --commit ... --quiet` | Never blocks (exit 0, runs quietly) | Repo | Lines 9–26; skips during MERGE_HEAD |
| Git pre-push (live) | `.git/hooks/pre-push` | pre-push | Pre-push | `npx turbo run lint`, `npm audit`, `npm test`, `caws validate` | Blocks (exit 1) on lint/test/validation failure | Repo-specific | Lines 59–65: blocks `--no-verify`; 15-min timeout on test suite |
| Git hooks (template/scaffold generated) | Generated by `src/scaffold/git-hooks.js` → `.git/hooks/pre-commit`, `post-commit`, `pre-push`, `commit-msg` | per above | per above | `caws gates run` / `caws provenance update` / `caws validate` / worktree guards | Blocks on gate/validation failure | CAWS init | Generated content differs from live repo versions; template pre-commit lacks the `--budget-check` path (line 258 of live version) |
| Cursor scope-guard | `packages/caws-cli/templates/.cursor/hooks/scope-guard.sh` | beforeSubmitPrompt (Cursor) | Pre-prompt-submit | `node .caws/tools/scope-guard.js check` | Advisory only (`continue: true` with warning) | Cursor template | Not active in this repo (no Cursor); scope check fires before prompt, not before file write |
| `caws-scope-guard.sh` (Cursor) | `packages/caws-cli/templates/.cursor/hooks/caws-scope-guard.sh` | Cursor | Pre-submit | `caws scope check` | Advisory | Cursor template | Calls `caws scope check` — the only place this command is referenced as a hook; Claude hooks call `caws scope show` instead |
| Scaffold: `src/scaffold/git-hooks.js` | `packages/caws-cli/src/scaffold/git-hooks.js` | — | — | Writes `.git/hooks/pre-commit`, `post-commit`, `pre-push`, `commit-msg` | N/A (installer) | CAWS CLI source | `generatePreCommitHook` at line 123; `scaffoldGitHooks` writes to `path.join(gitDir, 'hooks')` line 22 |
| Scaffold: `src/scaffold/claude-hooks.js` | `packages/caws-cli/src/scaffold/claude-hooks.js` | — | — | Copies template handlers + writes `.claude/settings.json` | N/A (installer) | CAWS CLI source | `generateClaudeSettings` at line 183; does not generate the dispatch layer |

---

## Disposition for vNext

| Hook | File path | Disposition | Rationale |
|---|---|---|---|
| `pre_tool_use.sh` dispatcher | `.claude/hooks/dispatch/pre_tool_use.sh` | KEEP_AS_IS | Sound architecture; needs to be wired into settings.json |
| `post_tool_use.sh` dispatcher | `.claude/hooks/dispatch/post_tool_use.sh` | KEEP_AS_IS | Same; needs wiring |
| `session_start.sh` dispatcher | `.claude/hooks/dispatch/session_start.sh` | KEEP_AS_IS | Needs wiring |
| `stop.sh` dispatcher | `.claude/hooks/dispatch/stop.sh` | KEEP_AS_IS | Needs wiring |
| `run-handlers.sh` | `.claude/hooks/lib/run-handlers.sh` | KEEP_AS_IS | Core dispatch infrastructure; supports dry-run and timing |
| `parse-input.sh` | `.claude/hooks/lib/parse-input.sh` | KEEP_AS_IS | Single-parse-per-handler is correct; idempotent |
| `runtime-paths.sh` | `.claude/hooks/runtime-paths.sh` | KEEP_AS_IS | Node PATH bootstrapping needed |
| `cwd-guard.sh` | `.claude/hooks/cwd-guard.sh` | KEEP_AS_IS | Addresses real harness bug; no CAWS dependency |
| `block-dangerous.sh` | `.claude/hooks/block-dangerous.sh` | REPLACE | Should be fail-closed: unbound Bash writes to any governed path should be refused, not just the one guard file |
| `worktree-guard.sh` | `.claude/hooks/worktree-guard.sh` | REPLACE | Git-command blocking logic is sound; `quiet-merge.sh` coupling is a side-channel that should be made explicit in vNext |
| `quiet-merge.sh` | `.claude/hooks/quiet-merge.sh` | REPLACE | CWD-safety fix is valid; `updatedInput` rewrite mechanism is a side-effect of being "last in chain" — vNext should make this explicit and test it |
| `protected-paths.sh` | `.claude/hooks/protected-paths.sh` | KEEP_AS_IS | Simple, correct, no CAWS CLI dependency |
| `scope-guard.sh` (live) | `.claude/hooks/scope-guard.sh` | REPLACE | Progressive strike model is fail-open at strike 1 and 2; vNext requires fail-closed for unbound governed writes; node-inline evaluation needs extraction to a proper module |
| `worktree-write-guard.sh` (live) | `.claude/hooks/worktree-write-guard.sh` | REPLACE | Logic is correct but must be fail-closed: current behavior warns when spec contention check fails (lines 309–315); vNext should refuse when check cannot run |
| `scan-secrets.sh` | `.claude/hooks/scan-secrets.sh` | KEEP_AS_IS | Advisory only; no behavioral change needed |
| `quality-check.sh` | `.claude/hooks/quality-check.sh` | REPLACE | Calls `caws quality-gates` (being rewritten); PostToolUse block is post-write and cannot undo disk mutation — vNext should move quality gate enforcement to PreToolUse |
| `validate-spec.sh` | `.claude/hooks/validate-spec.sh` | KEEP_AS_IS | YAML syntax check is valuable; `caws validate` call becomes vNext CLI |
| `naming-check.sh` | `.claude/hooks/naming-check.sh` | KEEP_AS_IS | Advisory; no changes needed |
| `doc-frontmatter-check.sh` | `.claude/hooks/doc-frontmatter-check.sh` | KEEP_AS_IS | Advisory; no changes needed |
| `audit.sh` | `.claude/hooks/audit.sh` | KEEP_AS_IS | Observational |
| `guard-strikes.sh` | `.claude/hooks/guard-strikes.sh` | REPLACE | The 3-strike model is the primary reason scope-guard is fail-open; vNext fail-closed semantics supersede this |
| `plan-transcript-snapshot.sh` | `.claude/hooks/plan-transcript-snapshot.sh` | CAPTURE_AS_FIXTURE | Not in template; organic session-tooling not covered by rewrite plan |
| `plan-transcript-finalize.sh` | `.claude/hooks/plan-transcript-finalize.sh` | CAPTURE_AS_FIXTURE | Same — organic session artifact tooling |
| `session-log.sh` | `.claude/hooks/session-log.sh` | KEEP_AS_IS | Observational; Python renderer is separate concern |
| `session-caws-status.sh` | `.claude/hooks/session-caws-status.sh` | REPLACE | Calls `caws session briefing` — command being rewritten |
| `stop-worktree-check.sh` | `.claude/hooks/stop-worktree-check.sh` | KEEP_AS_IS | Advisory reminder |
| `reset-strikes.sh` | `.claude/hooks/reset-strikes.sh` | DROP | Only needed while strike model exists; vNext fail-closed eliminates the "stale strike" problem |
| `.claude/settings.json` (live) | `.claude/settings.json` | REPLACE | Must wire the dispatch layer (add `hooks` key); current file is effectively a no-op for hook enforcement |
| `packages/caws-cli/templates/.claude/settings.json` | template | REPLACE | Generates individual-handler wiring superseded by live dispatch architecture |
| `packages/caws-cli/src/scaffold/claude-hooks.js` | scaffold source | REPLACE | `generateClaudeSettings` (line 183) generates individual-handler wiring; must generate dispatch-layer wiring |
| `packages/caws-cli/src/scaffold/git-hooks.js` | scaffold source | REPLACE | `generatePreCommitHook` template diverges from live `.git/hooks/pre-commit`; `caws gates run` call needs to match vNext gate API |
| `.git/hooks/pre-commit` (live) | `.git/hooks/pre-commit` | CAPTURE_AS_FIXTURE + REPLACE | Contains bespoke monorepo logic (turbo, eslint) mixed with CAWS guards; capture as fixture, then split |
| `.git/hooks/commit-msg` (live) | `.git/hooks/commit-msg` | KEEP_AS_IS | Worktree merge message enforcement is correct and stable |
| `.git/hooks/post-commit` (live) | `.git/hooks/post-commit` | DROP | Calls `caws provenance update`; provenance is dropped in vNext |
| `.git/hooks/pre-push` (live) | `.git/hooks/pre-push` | KEEP_AS_IS | Repo-specific full-suite enforcement; not generated by scaffold |
| Cursor hooks (all) | `packages/caws-cli/templates/.cursor/hooks/` | CAPTURE_AS_FIXTURE | Cursor integration not in scope for Slice 0b; defer |
| `lite-sprawl-check.sh` (template only) | `packages/caws-cli/templates/.claude/hooks/lite-sprawl-check.sh` | CAPTURE_AS_FIXTURE | Template-only orphaned feature; capture before any template rework |
| `simplification-guard.sh` (template only) | `packages/caws-cli/templates/.claude/hooks/simplification-guard.sh` | CAPTURE_AS_FIXTURE | Same — template-only, no live counterpart |

---

## Implications for Slice 0b corpus capture

Capture verbatim into `docs/rewrite/corpus/hooks/`:
1. `.claude/hooks/scope-guard.sh` (live, 3-strike progressive model)
2. `.claude/hooks/worktree-write-guard.sh` (live, with spec-contention logic)
3. `.git/hooks/pre-commit` (live, bespoke monorepo+CAWS hybrid)
4. `.git/hooks/post-commit` (live, provenance-update — being dropped)
5. `packages/caws-cli/templates/.claude/hooks/lite-sprawl-check.sh` (orphaned feature)
6. `packages/caws-cli/templates/.claude/hooks/simplification-guard.sh` (orphaned feature)
7. `.claude/hooks/plan-transcript-snapshot.sh` + `plan-transcript-finalize.sh` (organic tooling)
8. `packages/caws-cli/templates/.cursor/hooks/` whole directory (Cursor integration deferred)

These captures preserve the discovered semantics that the rewrite plan must honor or explicitly replace.
