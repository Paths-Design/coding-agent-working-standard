# Sterling Hook Port-Decision Audit

**Date**: 2026-05-27
**Repo**: caws upstream
**Spec**: follow-up to CAWS-FIRST-CONTACT-UX-001; replaces unspec'd task #23
**Scope**: 13 hooks in Sterling but not in v11 caws hook pack

## Executive summary

Of the 13 hooks audited: **7 are PORT** (after maintainer correction below), **4 are STERLING-LOCAL**, and **2 are RETIRE**. The 7 PORT candidates are the most significant finding: `cwd-guard.sh`, `quiet-merge.sh`, `protected-paths.sh`, `scan-secrets.sh`, `plan-transcript-snapshot.sh`, `plan-transcript-finalize.sh`, and `naming-check.sh` address governance gaps that would affect any CAWS consumer running multi-agent worktree workflows. A separately-tracked bug discovery — `session_log_renderer.py` is referenced by the pack's `session-log.sh` but is NOT bundled in the pack — argues for a hotfix-sized spec ahead of the broader promotion work. The 4 STERLING-LOCAL hooks all reference Sterling-specific paths or Sterling's document governance system. The 2 RETIRE candidates (`stop-worktree-check.sh` and `validate-spec.sh`) still function but carry logic that is now partially subsumed by v11 mechanisms or emit confusingly mixed v10/v11 advisory messages. Two follow-up specs are recommended: a hotfix to ship the missing renderer (`CAWS-HOOK-PACK-RENDERER-MISSING-001`), then promotion of the 7 PORT hooks (`CAWS-HOOK-PACK-PROMOTE-001`).

---

## Per-hook decisions

### `cwd-guard.sh`

- **Classification**: PORT
- **Fires on**: PreToolUse (matcher: `Bash|Read|Write|Edit|Glob|Grep|NotebookEdit`) — position 2 in Sterling's `pre_tool_use.sh` dispatch list, directly after `agent-heartbeat.sh`
- **What it does**: Checks whether the process's current working directory still exists on disk (via `[ ! -d "$(pwd 2>/dev/null)" ]`). If the CWD has been deleted — the primary case being a worktree directory removed while the agent was inside it — it blocks with exit code 2 and surfaces a recovery message pointing the agent back to the repo root via `git rev-parse --show-toplevel`.
- **Subsumed by v11?**: No. The v11 `audit.sh` (lines 22-25) has a CWD-resilience guard that redirects to a safe directory after a PostToolUse hook fires in a deleted CWD. However, that guard is PostToolUse-only and is defensive infrastructure for the hook itself, not an agent-facing block. No v11 PreToolUse hook proactively detects and blocks on a missing CWD before a tool call is attempted.
- **Sterling-specific references**: None. Line 13 references `git rev-parse --show-toplevel` and `$HOME` — generic paths.
- **Justification**: The hook header cites a real upstream Claude Code issue (`https://github.com/anthropics/claude-code/issues/34344`) where a removed-worktree CWD causes session crashes. This is a platform-level problem that affects any multi-worktree CAWS consumer, not a Sterling peculiarity. The fix (line 11: `[ ! -d "$(pwd 2>/dev/null)" ]`) is 9 lines of pure defensive bash with no project-specific dependencies. The v11 pack currently has no equivalent PreToolUse guard. Promoting it into the pack directly addresses the failure class at the agent boundary rather than after the crash.

---

### `doc-ephemeral-create-advisory.sh`

- **Classification**: STERLING-LOCAL
- **Fires on**: PostToolUse (matcher: `Write|Edit|Bash|ExitPlanMode`) — position 5 in Sterling's `post_tool_use.sh` dispatch list
- **What it does**: Advisory-only (always exits 0). Fires on `Write` of any `.md` file whose path or filename matches a temporal/status keyword pattern (`status|roadmap|milestone|plan|tracker|progress|ledger|snapshot|recon|audit|current`) via word-boundary regex (line 92). Emits a structured `hookSpecificOutput` JSON block warning the agent about Sterling's ephemeral doc lifecycle policy and directing it to classify the doc before committing. Exempts baseline files like `README.md`, `CLAUDE.md`, `.claude/rules/*.md`, and anything already under `.archive/` paths.
- **Subsumed by v11?**: No.
- **Sterling-specific references**: Lines 7-17 cite Sterling's bulk-archive event ("~1,611 .md/.yaml files") and 2026-05-21 empirical baseline. Line 105 references `docs/DOCUMENTATION_STANDARDS.md` and `.claude/rules/doc-authority-boundary.md`. The advisory text directs agents to Sterling's specific lifecycle path taxonomy (`docs/ephemeral/`, `docs/working/`, `docs/reference/historical/`). The pre-commit hook reference (line 19-20) points to Sterling's own `.githooks/` history.
- **Justification**: The core idea of "warn at create time when an agent creates a status/planning doc" is transferable in principle, but the advisory message on line 105 is tightly woven into Sterling's documentation governance taxonomy — it cites specific Sterling paths, Sterling's doc lifecycle states (`closure_path: delete|archive|supersede|promote`), and Sterling's DOCUMENTATION_STANDARDS.md. Porting this would require either stripping it to a generic token-cost warning (losing the actionable guidance) or importing Sterling's entire doc governance vocabulary into the upstream pack. Neither is appropriate for a generic pack. The hook earns its STERLING-LOCAL designation by being the enforcement complement to a Sterling-specific document authority regime that the upstream pack does not define.

---

### `doc-frontmatter-check.sh`

- **Classification**: STERLING-LOCAL
- **Fires on**: PostToolUse (matcher: `Write|Edit|Bash|ExitPlanMode`) — position 4 in Sterling's `post_tool_use.sh` dispatch list
- **What it does**: Advisory-only (always exits 0). Fires on `Write` or `Edit` of any `.md` file under `docs/`. Validates a multi-version frontmatter schema (V1 through V6) against Sterling's document governance standard. Checks for: YAML delimiter presence (V1), required fields `doc_id authority status title owner updated` (V2), valid `authority` enum values (`canonical|policy|architecture|adr|spec|roadmap|reference|working|ephemeral`) (V2), valid `status` enum values (`draft|active|implemented|proven|superseded|archived`) (V2), required `governs` for high-authority docs (V3), required `verified_at_commit` for implementation-state claims (V4), `superseded_by` for superseded docs (V5), and `caws_specs` for roadmap docs (V6).
- **Subsumed by v11?**: No.
- **Sterling-specific references**: Line 30 scopes exclusively to `docs/.*\.md$`. Line 57 cites `docs/specifications/document_governance.md`. The authority enum (line 97) and the `governs`/`verified_at_commit`/`caws_specs` fields (lines 129, 144, 171) are Sterling-defined schema requirements. The entire V1–V6 versioned check structure reflects Sterling's specific evolving governance spec.
- **Justification**: The frontmatter schema checked here is Sterling's proprietary document governance schema — fields like `authority`, `verified_at_commit`, `caws_specs`, and `closure_path` have no definition in upstream CAWS. The upstream pack ships no document governance standard and does not define a `docs/` schema. Porting this hook into upstream would either require defining a document governance schema in the pack (a significant design decision) or shipping a dead/always-passing hook. Neither is appropriate. This hook is useful only in a Sterling context where these schemas exist.

---

### `naming-check.sh`

- **Classification**: PORT
- **Fires on**: PostToolUse (matcher: `Write|Edit|Bash|ExitPlanMode`) — position 3 in Sterling's `post_tool_use.sh` dispatch list
- **What it does**: Advisory-only (always exits 0). Fires on `Write` (new file creation only — line 17 gates on `Write` only). Checks the new file's basename for: banned modifier suffixes (lines 29-50: `enhanced`, `unified`, `simplified`, `better`, `new`, `next`, `final`, `copy`, `revamp`, `improved`, `alt`, `tmp`, `scratch`, `wip`, `temp`, `old`, `backup`, and test-variant equivalents), version suffixes like `-v2.` (lines 79-87), and date stamps in `YYYY-MM-DD` format (lines 90-98). Emits a `hookSpecificOutput` JSON advisory for each violation. Test files with canonical extensions (`.test.js`, `.test.ts`, etc.) are explicitly exempted from the test-related modifier check (lines 62-65).
- **Subsumed by v11?**: No. The CAWS CLAUDE.md rule "No shadow files — never create `*-enhanced.*`, `*-new.*`, `*-v2.*`" exists as doctrine but has no hook enforcement.
- **Sterling-specific references**: Line 71 references `caws naming-check` CLI command — but this is a removed v10 command (not a v11 surface), so the reference is stale. Line 71 also references `.caws/canonical-map.yaml` — a v10 artifact not present in v11. These are cosmetic stale references in the advisory message text, not functional dependencies.
- **Justification**: The banned-modifier list (lines 29-50) precisely matches the "No shadow files" quality rule stated in both Sterling's and the upstream caws CLAUDE.md. The hook implements what the doctrine text says but which no hook enforces. The logic is entirely generic — it operates only on `basename "$FILE_PATH"` (line 26) with no path-specific or project-specific logic. The stale CLI references in the advisory message text (line 71) should be cleaned up before porting (remove the `caws naming check` reference since v11 has no such command), but the detection logic is sound and universally applicable.

---

### `plan-transcript-finalize.sh`

- **Classification**: PORT
- **Fires on**: Stop — position 3 in Sterling's `stop.sh` dispatch list
- **What it does**: On session stop, reads a pending-snapshots registry at `$HOME/.claude/.pending-plan-snapshots` (a newline-delimited list of transcript snapshot paths registered by `plan-transcript-snapshot.sh` during the same session). For each pending path, overwrites the snapshot with the final session transcript, then drains the pending list. Idempotent: no-op when the pending list is empty or absent.
- **Subsumed by v11?**: No. The v11 `session-log.sh` (which IS in the pack) generates session artifacts under `./tmp/<session-id>/` but does not produce plan-co-located transcript snapshots. These are complementary systems: `session-log.sh` produces per-session aggregate artifacts; the plan transcript pair produces plan-co-located snapshots.
- **Sterling-specific references**: None. Uses only `$HOOK_TRANSCRIPT_PATH` (generic hook environment), `$HOME/.claude/.pending-plan-snapshots` (generic home-relative state), and `cp` to write files. No Sterling-specific paths.
- **Justification**: This hook is the Stop-side half of a two-hook system with `plan-transcript-snapshot.sh`. The mechanism — capturing the full session transcript co-located with the plan file that triggered an `ExitPlanMode` call — is generically useful for any CAWS consumer that uses plan mode and wants artifact provenance. Lines 31-47 are pure filesystem operations with no project-specific dependencies. The companion hook `plan-transcript-snapshot.sh` (line 50 in that hook) uses `grep` against the transcript to find `.claude/plans/` paths, which is the generic Claude Code plan location. Both hooks should be promoted together as a unit.

---

### `plan-transcript-snapshot.sh`

- **Classification**: PORT
- **Fires on**: PostToolUse (matcher: `Write|Edit|Bash|ExitPlanMode`) — position 7 in Sterling's `post_tool_use.sh` dispatch list; self-filters at line 38 to `ExitPlanMode` only
- **What it does**: Fires after `ExitPlanMode` tool calls. Searches the current session transcript for the most recent Write call targeting a `.claude/plans/*.md` path (line 50-53 using `grep -oE`). If found, copies the current transcript to a co-located `.transcript.jsonl` file (line 59) and registers that path in `$HOME/.claude/.pending-plan-snapshots` (lines 64-71) for Stop-hook finalization. Idempotent: deduplicates registrations for the same plan file within a session (lines 70-71).
- **Subsumed by v11?**: No. The v11 `session-log.sh` handles `ExitPlanMode` events (lines 158-167 in that file) to trigger a session render, but does not produce plan-co-located transcript snapshots.
- **Sterling-specific references**: None. The `.claude/plans/*.md` pattern (line 50) is the generic Claude Code plan file location, not a Sterling-specific path. All state is written to generic locations (`$HOOK_TRANSCRIPT_PATH`, `$HOME/.claude/.pending-plan-snapshots`).
- **Justification**: Together with `plan-transcript-finalize.sh`, this hook implements plan provenance capture: the transcript at the moment of plan presentation is co-located with the plan file. This is generically valuable for any CAWS consumer using plan mode — it lets post-session analysis understand what context led to a given plan without requiring access to the session log directory. The detection logic (line 50: `grep -oE '"file_path":"[^"]*/\.claude/plans/[^"]*\.md"'`) is robust and version-agnostic. No Sterling-specific references exist in the file.

---

### `protected-paths.sh`

- **Classification**: PORT
- **Fires on**: PreToolUse (matcher: `Bash|Read|Write|Edit|Glob|Grep|NotebookEdit`) — position 6 in Sterling's `pre_tool_use.sh` dispatch list
- **What it does**: Blocks `Write` or `Edit` operations on two path classes: (1) any file under `*/.claude/hooks/*` exits with code 1 and the message "Ask the user for permission before editing Claude hook scripts"; (2) any file matching `*/.claude/logs/guard-strikes-*.json` exits with code 2 and a longer message explaining that strike counters must not be edited by hand, directing the agent to `reset-strikes.sh` instead. All other paths pass through (exit 0).
- **Subsumed by v11?**: No. The v11 pack has no hook that prevents agents from self-editing hook files or guard state. `scope-guard.sh` might incidentally prevent some of these edits via scope boundaries, but only when a spec's `scope.out` includes these paths. There is no unconditional, spec-agnostic protection for hook files or strike state.
- **Sterling-specific references**: None. References only `.claude/hooks/*` and `.claude/logs/guard-strikes-*.json` — generic Claude Code hook and CAWS guard-state paths present in any v11 pack consumer.
- **Justification**: This hook closes a real governance gap: without it, an agent can edit its own enforcement hooks or manipulate strike counters to bypass guards. The CAWS CLAUDE.md hook pack documentation explicitly states that hooks "may not be removed or weakened by an agent's local judgment," but that doctrine statement has no enforcement mechanism in the current pack. This hook is the enforcement mechanism. The paths it protects (`.claude/hooks/*` and `.claude/logs/guard-strikes-*.json`) are part of the v11 pack's standard layout — every consumer of `caws init --agent-surface claude-code` has these paths. The protection is thus universally applicable. The hook references no Sterling-specific paths, concepts, or files.

---

### `quality-check.sh`

- **Classification**: STERLING-LOCAL
- **Fires on**: PostToolUse (matcher: `Write|Edit|Bash|ExitPlanMode`) — position 1 in Sterling's `post_tool_use.sh` dispatch list
- **What it does**: Fires on `Write` or `Edit` of source files (`.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.go`, `.rs`, `.java`, `.mjs`, `.cjs` — line 22-25). Checks whether the project is a CAWS project (accepts either v10 `working-spec.yaml` or v11 `.caws/specs/` directory — lines 35-38). If the CAWS CLI is available and the agent is operating from a bound worktree, runs `caws gates run --spec "$SPEC_ID" --context commit`. Distinguishes bootstrap failures from real gate violations (lines 120-133) and emits appropriately — non-blocking advisory for bootstrap failures, `decision: block` JSON for real gate violations.
- **Subsumed by v11?**: Partially. The v11 gates system (`caws gates run --spec <id> --context commit`) is the upstream mechanism. However, the upstream pack does NOT ship a per-edit hook that triggers `caws gates run` automatically. This hook brings the gates-run into the PostToolUse event loop automatically, without requiring the user to invoke it manually. The worktree-binding detection (lines 77-96, reading `.caws/worktrees.json`) and the bootstrap-failure vs real-violation classification (lines 120-133) are non-trivial and correct per the v11 invariants documented in the hook comments (A2 and A3 invariants at lines 53-66).
- **Sterling-specific references**: The v11.1.7 comment at line 53 is accurate for Sterling's specific CLI version. The language-extension filter (line 22) excludes `.yaml` and `.md`, which is appropriate for Sterling's Python/Rust/JS codebase. The hook does not reference Sterling-specific paths — but the gate integration is tuned to Sterling's `policy.yaml` gate declarations (budget_limit, spec_completeness, scope_boundary, god_object, todo_detection).
- **Justification**: The hook is technically generic — it reads the generic worktrees.json registry and runs the generic `caws gates run` command. However, the decision to NOT port it rests on a different concern: the hook fires on every PostToolUse Write/Edit of a source file, which makes it expensive at high edit frequency. Whether this is appropriate depends on project-specific gate latency and workflow. A project with fast gates (no test execution) tolerates this; a project with slow gates does not. Putting it in the upstream pack without a latency-appropriate default would be counterproductive. This is borderline: if the caws upstream pack were to add a configurable "gate-on-edit" toggle to the pack, quality-check.sh is the right implementation shape. As a standalone hook in the current pack, it would be a surprise tax on consumers who haven't tuned their gate modes. **Classify STERLING-LOCAL pending an upstream design decision on gate-on-edit frequency.**

---

### `quiet-merge.sh`

- **Classification**: PORT
- **Fires on**: PreToolUse (matcher: `Bash|Read|Write|Edit|Glob|Grep|NotebookEdit`) — position 5 in Sterling's `pre_tool_use.sh` dispatch list
- **What it does**: Intercepts `Bash` tool calls containing `caws worktree merge` or `caws worktree destroy` commands (line 47). Rewrites the command via `updatedInput` to: (1) prefix with `cd <repo-root>` to move the CWD to safety before the worktree directory is destroyed, and (2) append `2>/dev/null | tail -3` to suppress verbose merge output. Also appends `git log --oneline -1` for a clean post-merge confirmation signal (line 50). Skips if the command already uses pipes or redirects (line 47: `! echo "$COMMAND" | grep -qE '[|>]'`). Resolves the repo root from `CLAUDE_PROJECT_DIR` with a `git rev-parse --git-common-dir` walk for worktree contexts (lines 36-43).
- **Subsumed by v11?**: No. The v11 pack has no hook that rewrites merge/destroy commands for CWD safety. The `audit.sh` PostToolUse CWD recovery guard (lines 22-25 in audit.sh) provides partial defense but fires after the crash, not before it.
- **Sterling-specific references**: None. References only `caws worktree merge` and `caws worktree destroy` — generic CAWS v11 CLI commands. The repo-root resolution logic (lines 36-43) mirrors the generic pattern used in other v11 hooks (e.g., `worktree-write-guard.sh` line 86-109).
- **Justification**: This hook solves two real problems that affect any multi-worktree CAWS consumer: (1) the CWD-crash-on-worktree-destroy failure mode, which is a posix_spawn ENOENT that breaks subsequent PostToolUse hooks; and (2) verbose merge output overflowing the agent's context window in long sessions. Both problems are documented in the hook header with clear mechanism descriptions. The `updatedInput` rewrite pattern is the correct Claude Code hook API for command interception. The fix is 56 lines, generic, and has no project-specific dependencies. The CLAUDE.md worktree rules for Sterling explicitly warn about this exact context-window issue (see Sterling CLAUDE.md § "Context window warning"), confirming it is a real problem in practice.

---

### `scan-secrets.sh`

- **Classification**: PORT
- **Fires on**: PreToolUse (matcher: `Bash|Read|Write|Edit|Glob|Grep|NotebookEdit`) — position 9 (last) in Sterling's `pre_tool_use.sh` dispatch list
- **What it does**: Advisory-only (always exits 0). Checks `$HOOK_FILE_PATH` against two lists: a set of filename patterns for files that commonly contain secrets (`SECRET_FILE_PATTERNS`, lines 23-46: `.env*`, `credentials.json`, `service-account.json`, `secrets.yaml`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, etc.) and a set of sensitive directory names (`SECRET_DIRS`, lines 49-56: `.ssh`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.gnupg`). Emits a `hookSpecificOutput` advisory warning the agent not to include sensitive values in its response, directing use of placeholders.
- **Subsumed by v11?**: No. The v11 pack does not ship a secret-file advisory hook.
- **Sterling-specific references**: None. The secret file patterns (`.env`, `credentials.json`, SSH keys, cloud provider configs) are universal. No Sterling-specific paths or concepts appear in the hook.
- **Justification**: The hook implements a basic information-hazard advisory for the most common classes of secret-bearing files and directories. The pattern list (lines 23-46) covers the standard files that security guides recommend excluding from AI context. This is universally applicable to any CAWS consumer and represents a low-cost safety advisory. The implementation is 87 lines, advisory-only (cannot break anything), and has zero project-specific dependencies. The only weakness is the advisory fires on both `Read` and `Write` but the hook does not distinguish the tool name — for a `Write` event, the advisory is less relevant. However, in advisory-only mode this is a minor UX issue rather than a correctness problem.

---

### `session_log_renderer.py`

- **Classification**: PORT (corrected — see note below; the v11 pack ships `session-log.sh` that depends on this file but the file itself is MISSING from the pack)
- **Fires on**: Not wired directly in settings.json. Invoked programmatically by `session-log.sh` (which IS in the v11 pack) at line 35 (`RENDERER="$SCRIPT_DIR/session_log_renderer.py"`) and line 85+ (`python3 "$RENDERER" ...`).
- **What it does**: 933-line Python script that parses a Claude Code transcript JSONL file and produces structured session artifacts: `session.json` (session index), `turn-NNN.json` files (per-turn detail with timeline, tool calls, file refs, commands), `handoff.json` (compact continuation view for follow-on agents), and `session.txt` (human-readable summary). Extracts heuristic fields (decisions, next actions, blocking issues) from assistant reasoning text via regex. Handles all Claude Code tool types: Write, Edit, Read, Grep, Glob, WebSearch, Bash, Agent/Task, Skill, ExitPlanMode.
- **Subsumed by v11?**: No — see correction note. The renderer is NOT shipped in the v11 pack despite `session-log.sh` depending on it.
- **Sterling-specific references**: `MEANINGFUL_COMMAND_KW` includes `"caws "` (generic), `cargo test`, `cargo build` (Rust toolchain), `ruff`, `mypy` (Python toolchain). These string constants affect which Bash commands are highlighted in session.txt output. The Rust+Python keywords are Sterling-specific but easy to genericize (remove or move to a configurable list) before porting.
- **Justification**: The renderer is load-bearing for `session-log.sh` to function. Promoting it into the pack closes the dependency gap; minor genericization of the toolchain keywords is the only adaptation needed.

> **Audit-correction note (added 2026-05-27 by maintainer verification)**: The audit subagent originally classified this file as "already in v11 pack." Verification proved that wrong — the file is absent from `packages/caws-cli/templates/hook-packs/claude-code/`. The pack's `session-log.sh:35` references the renderer by path but the renderer is not bundled, meaning every `caws init --agent-surface claude-code` ships a `session-log.sh` that crashes when invoked. This is a real shipping bug in v11.1.7, not just a porting decision. It is tracked separately as a hotfix candidate (`CAWS-HOOK-PACK-RENDERER-MISSING-001`) and is not covered by the broader `CAWS-HOOK-PACK-PROMOTE-001` spec — the renderer fix should land first because it unbreaks an in-pack hook, whereas the promotion spec adds new optional governance.

---

### `stop-worktree-check.sh`

- **Classification**: RETIRE
- **Fires on**: Stop — position 2 in Sterling's `stop.sh` dispatch list
- **What it does**: On session stop, reads `.caws/worktrees.json` using `$CAWS_NODE_ENTRIES_OF` (from `lib/caws-state.sh`) to find active/fresh worktrees. If zero active worktrees: emits a reminder that "Working on Main without a worktree is now forbidden" (line 47). If more than zero active worktrees: emits a reminder naming the active worktrees and warning that other agents cannot commit to the base branch until all are destroyed (lines 51-53).
- **Subsumed by v11?**: Partially. The "zero worktrees" branch (line 47) enforces a Sterling-specific rule ("Working on Main without a worktree is now forbidden") that is not universal CAWS policy — the upstream v11 pack supports main-branch work without a worktree. The "active worktrees remain" branch (lines 51-53) is useful guidance but is also covered by `session-caws-status.sh` (in the v11 pack) which runs on SessionStart and surfaces worktree state via `caws status`. The Stop hook fires on session end when the information is already too late to act on cleanly.
- **Sterling-specific references**: Line 47's "Working on Main without a worktree is now forbidden" is a Sterling-specific enforcement posture, not a universal CAWS invariant. The warning in line 47 is also misleading — the current hook runs on Stop, which is after the session has already done its work on main, making the warning unactionable.
- **Justification**: The "zero active worktrees" branch encodes Sterling-specific policy. The "non-zero active worktrees" branch emits a useful reminder, but `session-caws-status.sh` on SessionStart is the more appropriate surface for this — it runs before work begins, not after it ends. The hook also has a logic ambiguity: when `$COUNT` is 0, line 46 fires; when `$COUNT` is greater than 0, line 51 fires. But the condition structure (`-eq 0` branch and `-gt 0` branch) means both messages produce an exit 0 result with a stderr reminder, making neither actionable at Stop time. Sterling should redirect the "active worktrees remain" reminder into the SessionStart flow (where `session-caws-status.sh` already runs) and retire this hook.

---

### `validate-spec.sh`

- **Classification**: RETIRE
- **Fires on**: PostToolUse (matcher: `Write|Edit|Bash|ExitPlanMode`) — position 2 in Sterling's `post_tool_use.sh` dispatch list
- **What it does**: Fires on `Write` or `Edit` of any file under `.caws/` with a `.yaml` or `.yml` extension (line 31). Performs two checks: (1) YAML syntax validation via `node -e` using `js-yaml` (lines 38-62); (2) terminal-state test_nodeids coverage check — for specs with `status: proven|complete|completed`, verifies that all acceptance criteria have `test_nodeids` or `evidence` fields (lines 65-93). Includes a large comment block (lines 95-108) explaining that `caws validate <file> --quiet --suggestions` was removed in v11 and that the hook deliberately does NOT call any CLI validation. Exits 0 in all cases; all output is advisory.
- **Subsumed by v11?**: Partially. The YAML syntax check (lines 38-62) is a useful standalone validation. The `test_nodeids` check (lines 65-93) is a v10-era concern — v11 specs use `acceptance` (Given/When/Then format per CLAUDE.md) with no `acceptance_criteria:` field. The terminal states `proven|complete|completed` are not v11 lifecycle states — v11 uses `draft|active|closed|archived` (`lifecycle_state:` field). The terminal-state check would never fire on a v11 spec because no v11 spec has `status: proven`.
- **Sterling-specific references**: Line 95 comment references `caws-1117-COMPAT-BOOTSTRAP-01 A1` and `A3` — Sterling-specific spec IDs from the v10→v11 cutover. The terminal-state vocabulary (`proven|complete|completed`) is v10-era and not present in v11 specs in Sterling's current state.
- **Justification**: The `test_nodeids` check (lines 67-93) operates on v10 spec fields (`status`, `acceptance_criteria`, `test_nodeids`) that do not exist in v11 specs. It will silently never fire on any current spec. The YAML syntax check (lines 38-62) retains value but is a thin wrapper around `js-yaml` with no spec-schema awareness — `caws doctor` covers this more thoroughly. The large comment block (lines 95-108) is itself evidence that the hook's original v10 CLI-delegation path was removed and not replaced, leaving only the two local node-based checks. The more appropriate path for both surviving behaviors: the YAML syntax check should be absorbed into the upstream v11 `caws doctor` call (which already runs project-wide drift detection), and the terminal-state test_nodeids concern is moot in v11. Sterling should retire this hook and rely on `caws doctor` for spec validation.

---

## Suggested follow-up work

**Spec CAWS-HOOK-PACK-PROMOTE-001** should port the 6 PORT-classified hooks into `packages/caws-cli/templates/hook-packs/claude-code/`. The 6 hooks are:

1. `cwd-guard.sh` — promote as-is, no changes needed.
2. `quiet-merge.sh` — promote as-is; CWD-safety rewrite is generic and correct.
3. `protected-paths.sh` — promote as-is; hook-self-editing and strike-state protections are universally applicable.
4. `scan-secrets.sh` — promote as-is; all patterns are generic.
5. `plan-transcript-snapshot.sh` — promote as a unit with `plan-transcript-finalize.sh`; these two hooks form a single system.
6. `plan-transcript-finalize.sh` — promote as a unit with `plan-transcript-snapshot.sh`.
7. `naming-check.sh` — promote after removing the stale `caws naming check` CLI reference from the advisory message (line 71); that command does not exist in v11.

Each promoted hook needs:
- A `# CAWS-MANAGED-HOOK` header with appropriate `hook_pack_version`, `lineage_refs`, and `caws_min_major: 11` fields.
- Registration in the pack's dispatch files (`dispatch/pre_tool_use.sh` for `cwd-guard.sh`, `quiet-merge.sh`, `protected-paths.sh`, `scan-secrets.sh`; `dispatch/post_tool_use.sh` for `naming-check.sh`, `plan-transcript-snapshot.sh`; `dispatch/stop.sh` for `plan-transcript-finalize.sh`).
- A `docs/failure-lineage.md` entry per the pack contract (hook CLAUDE.md: "every script traces to a specific entry").

**Sterling cleanup slice**: Sterling should retire `stop-worktree-check.sh` and `validate-spec.sh`. The recommended approach:
- Remove `stop-worktree-check.sh` from `dispatch/stop.sh`'s HANDLERS array and delete the script. The "active worktrees" reminder is already surfaced by `session-caws-status.sh` on SessionStart.
- Remove `validate-spec.sh` from `dispatch/post_tool_use.sh`'s HANDLERS array and delete the script. The YAML syntax check and spec validation are covered by `caws doctor`.

**Sterling-local hooks** (`doc-ephemeral-create-advisory.sh`, `doc-frontmatter-check.sh`, `quality-check.sh`) require no action — they are correctly scoped to Sterling and should remain in `.claude/hooks/`.

---

## Limits and non-claims

This audit did NOT:
- **Run any hook to verify it works as documented.** Classifications are based on static source reading only. A hook may have runtime bugs that only manifest with specific CAWS CLI versions or transcript shapes.
- **Diff Sterling's `session_log_renderer.py` against the upstream pack's copy.** The file is classified PORT (already upstream) but whether Sterling has locally diverged from the pack's version was not checked. A byte-level diff should precede any portability decision about that specific file.
- **Check whether any other downstream consumer of caws (beyond Sterling) has equivalent hooks.** Sterling may not be representative of what other consumers independently developed.
- **Audit the v11 pack's own hooks for bugs or gaps.** The v11 hooks were consulted only to determine whether they subsume Sterling extensions — their own correctness was not evaluated.
- **Verify the `dispatch/` wiring matches the settings.json configuration.** The dispatch files were read but the full settings.json–to–dispatch–to–handler call chain was not traced end-to-end for each hook.
- **Check the `lib/parse-input.sh` and `lib/run-handlers.sh` files for v10/v11 divergence.** These shared libraries underpin all hooks; their correctness was assumed, not verified.
- **Evaluate whether `quality-check.sh` should eventually be ported** with a configurable gate-frequency option. The STERLING-LOCAL classification is conditional on the upstream pack not providing a gate-on-edit toggle; if such a toggle is added in a future spec, `quality-check.sh` is the right implementation template.
