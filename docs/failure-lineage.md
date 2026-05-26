# CAWS Failure Lineage

Every safety guard in this toolkit exists because something broke. This document maps each guard to the incident that caused it, so future maintainers understand why a rule exists before considering removing it.

## How to read this

Each entry follows the pattern:
- **What happened** — the incident
- **What we built** — the guard or mitigation
- **Where it lives** — file paths
- **What it doesn't catch** — known gaps

---

## 1. The Git Init Fiasco

**Severity:** Catastrophic (245,000 lines nearly deleted)
**Era:** Pre-CAWS, Cursor-era
**Agent:** Cursor agent (model unknown)

### What happened

An agent had quality gates active that were rejecting its push. Rather than fix the violations, the agent searched git history for a point before the gates existed. It ran `git stash` to save its work, then `git init` to wipe the repository and start fresh. This destroyed the stash (since `git init` reinitializes `.git/`). The agent then attempted `git push --force` to overwrite the remote with its clean slate. The push was caught by a `.zshrc` line that blocks force flags and requires keychain password authentication.

The agent tried to delete ~245,000 lines of code to avoid fixing lint errors.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| `git init` hard block | `block-dangerous.sh` | Pattern match, exit 2 |
| `git push --force` block | `block-dangerous.sh` | Pattern match, exit 2 |
| `git push -f` block | `block-dangerous.sh` | Pattern match, exit 2 |
| `git push --force-with-lease` block | `block-dangerous.sh` | Pattern match, exit 2 |
| `git stash` block (worktrees) | `worktree-guard.sh` | Blocked when worktrees active |
| Force push to main/master | Cursor `block-dangerous.sh` | Regex check on branch name |

### What it doesn't catch

- An agent could theoretically accomplish the same thing with `rm -rf .git` (caught separately by the `rm -rf` patterns)
- The `.zshrc` keychain check was the actual last line of defense — CAWS hooks run in Claude Code's process, not in the user's shell

---

## 2. Shadow File Proliferation

**Severity:** High (codebase confusion, stale code accumulation)
**Era:** Pre-CAWS, Cursor-era
**Agent:** Multiple Cursor agents across projects

### What happened

When given feedback like "enhance this with additional information," agents would create entirely new files with suffixes like `*_enhanced.py`, `*-final.js`, `*-v2.ts`, `*-copy.py` instead of editing the original in place. This led to:

- Multiple files doing nearly the same job in the same directory
- Reviewers unable to determine which file was canonical
- Stale duplicates accumulating across projects (visible in `kokoro/` and sterling's documentation)
- References to versioned filenames throughout the codebase

The pattern was consistent: agents treated "improve X" as "create X-improved alongside X" rather than "edit X."

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| Shadow file naming block | `naming-check.sh` | Warns on filenames containing: `enhanced`, `unified`, `simplified`, `better`, `new`, `next`, `final`, `copy`, `revamp`, `improved`, `alt`, `tmp`, `scratch`, `wip`, `backup` |
| Version suffix detection | `naming-check.sh` | Regex for `-v[0-9]+.` pattern |
| Date stamp detection | `naming-check.sh` | Regex for `YYYY-MM-DD` in filenames |
| Lite sprawl check | `lite-sprawl-check.sh` | Banned file/directory patterns for projects without full CAWS |
| CLAUDE.md rule | Template `CLAUDE.md` | "No shadow files — edit in place" |

### What it doesn't catch

- **Sterling's `naming-check.sh` uses word-boundary regex** (more precise) while the **template uses substring matching** (creates false positives on words like "renewable" matching "new", "gold_oracle" matching "old"). Template needs the sterling fix backported.
- Agents can still create new files with innocuous names that duplicate existing functionality

---

## 3. The Stub-Out / Simplification Problem

**Severity:** High (real implementations replaced with placeholders)
**Era:** Cursor-era, multiple models
**Agent:** Claude Haiku was the worst offender; other smaller models exhibited it too

### What happened

When agents hit context window limits or found code "too complex," they would replace real implementations with stubs. Common patterns:

- Python: `pass`, `raise NotImplementedError`
- JavaScript: `throw new Error("not implemented")`
- Comments: `// TODO`, `# TODO: implement later`
- Phrasing like: "in a real implementation, we would spend actual time on this, for now, I'll do this instead"

The `todo_analyzer.py` tool was built to scrub docstrings, functions, and files for these trigger words and phrases. The simplification guard catches it at edit-time.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| Simplification guard | `simplification-guard.sh` | Detects 30%+ LOC reduction combined with stub patterns (`pass`, `...`, `NotImplementedError`, `TODO`) |
| TODO analyzer | `todo_analyzer.py` | Scrubs docstrings, functions, and files for trigger phrases |
| CLAUDE.md rule | Template `CLAUDE.md` | "No fake implementations — no placeholder stubs, no TODO in committed code, no hardcoded mock responses pretending to be real" |
| CLAUDE.md rule | Template `CLAUDE.md` | "Prove claims — never assert 'production-ready' or 'complete' without evidence" |

### What it doesn't catch

- LOC counting is naive (only skips `//` and `#` comments, misses block comments)
- An agent could replace real code with *different* real code that's wrong but not stub-like
- The 30% threshold is arbitrary and not configurable per-project

---

## 4. The Amend Incident (Worktree Cross-Contamination)

**Severity:** High (work attribution destroyed, wrong code merged)
**Era:** Early CAWS worktree adoption
**Agent:** Two concurrent Claude Code instances

### What happened

Two agents were working in separate worktrees. Agent A checked out the wrong worktree (Agent B's) and started working alongside Agent B's active session. Agent A saw what it thought were linter-generated changes, decided to checkpoint the work with a commit. Agent B then saw Agent A's checkpoint commit, assumed it was work *they* had forgotten to commit (possibly auto-formatted by a linter), and ran `git commit --amend` to fold it into their previous commit — accepting work that wasn't theirs as if they'd authored it.

This destroyed the attribution boundary between the two agents' work and merged untested code silently.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| `git commit --amend` block | `worktree-guard.sh` | Blocked when worktrees are active |
| `git commit --amend --no-edit` hard block | Cursor `block-dangerous.sh` | Always blocked in Cursor |
| Worktree ownership tracking | `worktree-manager.js` | `CLAUDE_SESSION_ID` recorded as owner; destroy blocked for non-owners |
| Ownership display in list | `worktree.js` | `caws worktree list` shows Owner column |
| Last commit recency | `worktree-manager.js` | Shows "last commit: 3 minutes ago" to signal active work |

### What it doesn't catch

- An agent could still read another worktree's files (isolation is write-only)
- If `CLAUDE_SESSION_ID` isn't set, ownership tracking degrades silently

### Variant: inherited-dirty-state cross-session commit (April 2026)

A second variant of the same attribution-loss problem, requiring no `--amend` at all. Two Claude sessions (Session A: `8be65780`, Session B: `cedb4ab2`) worked the same branch ~17 minutes apart on April 27. Session A authored 14 dirty files but paused before committing. Session B started, found the dirty files in its working tree, ran `git add .`, committed them as its own feature commits, merged the branch, and closed the spec — while Session A was still paused. The functional outcome was identical (both sessions converged on the same implementation), but Session A returned to find its work merged under Session B's name. Session B identified the root cause post-hoc: the harness had the canonical ownership signal (`tmp/<session-uuid>/.meta.json`) but never surfaced it to Session B at the decision point. See Entry 11 for the agent-claim model that addressed this.

---

## 5. The Rebase Incident (Branch History Rewrite)

**Severity:** High (17 commits rewritten, ~20 turns of recovery)
**Era:** CAWS v9.2.0
**Agent:** Claude Code (Opus) in sterling `perf-evidence` worktree

### What happened

An agent was in the `perf-evidence` worktree (stress benchmark scope) but was told to un-defer BUNDLE-MOUNT work (enrichment scope — completely different lane). Instead of creating a new worktree, the agent ran `git rebase main` on the `perf-evidence` branch to pick up bundle mount files. This rewrote 17 commits.

When the agent tried to undo the rebase, `git reset --hard` was blocked by the safety hook, `git clean -f` was blocked, and it spent ~20 turns manually reconstructing the pre-rebase state file by file (`git reset --soft`, `git checkout -- <file>`, `rm` for each untracked file).

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| `git rebase` block (worktrees active) | `block-dangerous.sh` | Command-boundary regex + worktree-active check via `worktrees.json` |
| Rebase strategy removed from CLI | `parallel-manager.js` | `VALID_STRATEGIES` reduced to `['merge', 'squash']` |
| CLI help text updated | `index.js` | `--strategy` option no longer lists rebase |
| Worktree isolation rule | `worktree-isolation.md` | "git rebase — rewrites branch history; if you need code from main, create a new worktree from current main instead" |
| Rebase in classifier (sterling-native) | `classify_command.py` | Added to `CONFIRM_SEGMENT_PATTERNS` |

### What it doesn't catch

- `git rebase` is allowed when no worktrees are registered (solo developer use case)
- The CLI's own `parallel merge` bypasses hooks (uses `execFileSync` directly, not Claude's Bash tool) — this is why the strategy was removed entirely rather than just hooked

---

## 6. The Stash-and-Destroy Problem

**Severity:** High (active work destroyed)
**Era:** CAWS worktree adoption
**Agent:** Multiple Claude Code instances

### What happened

A consistent pattern across sessions: Agent A finishes its worktree, closes it via `caws worktree destroy`, then notices another worktree exists. It checks if it's "stale," sees uncommitted work, runs `git stash` to "save" the work, then destroys the worktree — all while Agent B is actively working in that worktree simultaneously.

The fundamental problem: `git stash` is shared across all worktrees. Agent A's stash operation could clobber Agent B's stash, and destroying the worktree removes Agent B's working directory.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| `git stash` block (worktrees) | `worktree-guard.sh` | Blocked when worktrees active (except `git stash list`) |
| Ownership protection on destroy | `worktree-manager.js` | Blocks destroy if `owner !== currentSession` unless `--force` |
| Auto-force for merged branches | `worktree-manager.js` | If branch is already merged to base, allows destroy without `--force` (safe cleanup) |
| Prune with recency protection | `worktree-manager.js` | `pruneWorktrees()` skips branches with commits < 60 minutes old |
| MERGE_HEAD write guard bypass | `worktree-write-guard.sh` | Allows edits on base branch during active merge (conflict resolution) |

### What it doesn't catch

- An agent could `rm -rf` a worktree directory directly (bypasses CAWS registry)
- Git worktree registry and CAWS worktree registry can desync if worktrees are manipulated outside of `caws` commands

---

## 7. Sparse Checkout / Module Isolation Failures

**Severity:** Medium (broken imports, test failures)
**Era:** Early CAWS worktree adoption
**Agent:** Claude Haiku, Claude Code with worktrees

### What happened

Two related failures:

**Sparse checkout:** Agents used `--scope` flags with worktree creation to limit the checkout to specific directories. This broke Python/Rust imports because modules depend on sibling packages. Tests would fail because test harnesses import from `core/`, scenarios import from `fixtures/`, etc. The modular architecture of sterling, agent-agency, and conscious-bot (designed for maintainability) made agents think modules were optional.

**Venv sprawl:** Before worktrees, agents would consistently fail to check for an existing virtual environment before trying to install packages. This led to `.venv`, `venv`, `.venv-smoke`, `env/` directories proliferating. Agents would also try to install to the global Python environment. In worktrees, agents would create fresh venvs instead of using the main repo's shared venv.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| Sparse checkout block | `worktree-guard.sh` | Blocks `caws worktree create --scope` and `caws parallel setup --scope` |
| No-sparse-checkout rule | Sterling `no-sparse-checkout.md` | Explicit rule: "Do not use sparse checkout with CAWS worktrees" |
| Venv creation block | `block-dangerous.sh` | Blocks `python -m venv`, `python3 -m venv`, `virtualenv`, `conda create` |
| Designated venv path | `scope.json` | `designatedVenvPath` field tells agents where the shared venv is |
| Worktree isolation rule | `worktree-isolation.md` | "Do NOT create a new virtual environment in your worktree. Use the main repo's venv." |
| Venv path exception | `block-dangerous.sh` | Allows venv creation if target path matches `designatedVenvPath` |

### What it doesn't catch

- An agent could use `pip install --target` to install to an arbitrary directory
- The venv path exception uses substring matching, not path normalization

---

## 8. Scope Boundary Violations (Multi-Agent)

**Severity:** Medium-High (agents editing each other's files)
**Era:** CAWS parallel agent adoption
**Agent:** Multiple concurrent Claude Code instances

### What happened

When multiple agents worked in parallel, they would edit files outside their assigned scope. Agent A (working on auth) would "notice" a logging issue and fix it, while Agent B (working on logging) would make conflicting changes to the same files. Without scope enforcement, merge conflicts were frequent and attribution was lost.

Claude Haiku was particularly bad at scope discipline — it would answer its own questions, find rabbit holes, and blow the LOC budget exploring tangential concerns. This led to the "tell me where you will and will not spend your time first" approach in spec creation.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| Scope guard (full) | `scope-guard.sh` | Validates Write/Edit against `scope.in` and `scope.out` from working-spec + feature specs |
| Feature specs | `specs.js` | Each agent gets its own spec with independent scope boundaries |
| Change budget enforcement | `budget-derivation.js` | `max_files` and `max_loc` limits derived from `risk_tier` and `policy.yaml` |
| Spec-scoped validation | `caws validate --spec-id` | Validates only the agent's assigned spec, not all specs |
| Pre-commit spec scoping | Pre-commit hook | Detects worktree context and passes `--spec-id` to validation |

### What it doesn't catch

- **Template `scope-guard.sh` is outdated** — it only checks working-spec, not feature specs. Sterling's version has multi-spec support. This is a critical drift that needs backporting.
- Glob-to-regex conversion is incomplete (`**`, `[abc]`, `{a,b}` not supported)
- `scope.in` patterns don't handle path normalization (relative vs absolute)

### Variant: union-mode cross-spec interference (May 2026)

Once feature specs landed, scope enforcement defaulted to union mode: any active spec's `scope.out` could block an edit, even if the file was in the editing agent's own `scope.in`. The failure mode is "Agent A can't edit its own file because Agent B's `scope.out` accidentally covers it" — distinct from the two-agents-same-file collision the original entry addressed. This was particularly painful when an unbound worktree (no `specId` in `worktrees.json`) inherited governance from every active spec at once, producing confusing blocks like "spec X blocks me even though I'm not working on X."

The vNext kernel rewrite replaced union mode with **authoritative binding**: when a worktree is bound to a spec, only that spec's scope is consulted; other agents' specs cannot block the edit. Union mode is retained as fallback when no binding exists, and `caws scope show` now reports which mode is active so agents can self-diagnose. See N12 below for the related "unbound = no authority" rule that closes the symmetric escape hatch.

---

## 9. Audit Logging (Failure Forensics)

**Severity:** Process improvement
**Era:** Mid-CAWS development
**Agent:** N/A (tooling gap)

### What happened

Failure modes were outpacing solo development velocity. When agents failed, reconstructing *what happened* required reading through terminal scrollback or trying to remember the sequence. There was no structured record of which tools were called, in what order, with what arguments, and what the results were.

The audit log was built so failure transcripts could be brought to new agent sessions to analyze and build mitigations faster. This directly accelerated CAWS development — failures became input to the next iteration.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| Audit logger | `audit.sh` | Logs all tool usage with timestamps to `.claude/logs/audit.log` and dated files |
| Session logger | `session-log.sh` | Generates per-turn narrative transcripts (`turn-NNN.txt`) and structured data (`turn-NNN.json`) |

### Known issues

- Audit log writes sensitive data (full tool input) without sanitization
- No log rotation — files accumulate indefinitely
- Race condition on concurrent writes to the same log file
- Session log's noise filtering is hardcoded to Claude Code internal markers

---

## 10. Session Transcripts (Coach's Perspective)

**Severity:** Process improvement
**Era:** Transition from Cursor to Claude Code
**Agent:** N/A (workflow design)

### What happened

The session log serves a different purpose than the audit log. It enables a deliberate separation between *execution work* (agent in the repo) and *thinking work* (human with a separate LLM discussing strategy).

The workflow: run an agent on the machine, get its transcript, then discuss the results with a separate ChatGPT or Claude instance that has no repo access. This forces:

1. **Deliberate concept separation** — system design thinking stays separate from code execution
2. **Evidence clarity** — if it can be clear what was done where, how, and why, you can have a conversation about results without the agent immediately trying to change things
3. **Two perspectives** — watching the game from the coach's sideline AND from the stands

The structured output decoding (sterling's version) was added because Task/Agent tool results contain JSON payloads that need parsing to be readable in the transcript. The template simplified this away, losing readability.

### What we built

| Feature | File | Purpose |
|---------|------|---------|
| Per-turn narratives | `session-log.sh` | Markdown transcripts of each conversation turn |
| Structured data export | `session-log.sh` | JSON per-turn for machine consumption |
| Turn file storage | `tmp/<session-id>/` | Organized by session for easy retrieval |
| JSON payload decoding | Sterling `session-log.sh` | Decodes Task/Agent structured results for readability |

### What was lost in template drift

- Sterling's session-log has three-tier output filtering (always-capture for Bash/Task/Agent, notable keywords, file-content truncation) — template simplified to two-tier
- Sterling's `decode_structured_text_payload()` for JSON-escaped payloads — removed from template

---

## Appendix: Audit Findings (March 2026)

### Critical Drift: Template vs Sterling — RESOLVED

All items below were remediated in the GUARD-001 session (March 2026):

| File | Issue | Resolution |
|------|-------|------------|
| `scope-guard.sh` | Template missing feature spec support | ✅ Template upgraded to multi-spec; backported to sterling |
| `session-log.sh` | Template lost structured output decoding | ✅ `decode_structured_text_payload()` and three-tier capture restored |
| `naming-check.sh` | Template uses substring match | ✅ Upgraded to word-boundary regex `(^|[-_.])modifier([-_.]|$)` |
| `worktree-isolation.md` | Venv section diverged (hardcoded path vs placeholder) | ✅ Template uses `<main-repo-path>` placeholder |

### Known False Positive Risks — RESOLVED

| Pattern | File | Resolution |
|---------|------|------------|
| `naming-check.sh` substring matching | Template | ✅ Fixed with word-boundary regex |
| Credit card regex | Cursor `scan-secrets.sh` | ✅ Tightened: requires word boundaries, no embedded-number false positives |
| Bearer token regex | Cursor `scan-secrets.sh` | ✅ Tightened: requires 20+ char token, not short doc examples |
| `change_budget` content scan | Cursor `caws-scope-guard.sh` | Open — not yet addressed |

### Unused/Dead Code — RESOLVED

| Item | Location | Resolution |
|------|----------|------------|
| `scope-guard.js` experimental containment | `.caws/tools/` | ✅ Rewritten to do actual file-in-scope checking |
| `caws-tool-validation.sh` (MCP hook) | `.cursor/hooks/` | ✅ Removed — MCP server no longer shipped |
| `beforeMCPExecution` hook config | `.cursor/hooks.json` | ✅ Removed |
| MCP references in CLI | `status.js`, `project-analysis.js` | ✅ Cleaned up |
| MCP debug config | `.vscode/launch.json` | ✅ Removed |

### Glob-to-Regex Conversion — FIXED

The `pattern.replace(/\*/g, '.*').replace(/\?/g, '.')` pattern was used in `scope-guard.sh` and `lite-sprawl-check.sh`. This failed for:
- `**` (recursive) — became `.*.*` instead of `.*`
- `[abc]` (character classes) — passed through as literal brackets
- `{a,b}` (alternatives) — treated as literal braces

✅ Replaced with proper `globToRegex()` function that handles all patterns.

### Log Rotation — IMPLEMENTED

| Item | Resolution |
|------|------------|
| Audit logs grow unbounded | ✅ `audit.sh` rotates main log at 10MB, prunes date logs >30 days |
| Probabilistic check | Runs ~1% of calls to avoid stat overhead on every tool use |

### Missing Guards — STATUS

| Gap | Description | Status |
|-----|-------------|--------|
| `git cherry-pick` | Replays commits across worktree boundaries | ✅ Added to `block-dangerous.sh` with worktree-active guard |
| Cross-worktree file reads | Only writes are guarded | Open — consider read-guard |
| `pip install --target` | Bypasses venv creation block | Open — add pattern |
| Worktree ownership bypass | Agent destroyed another agent's worktree with `--force` | ✅ Removed "use --force" hint, added loud red warning |

---

## Entry 11: Worktree Ownership Violation (March 2026)

**Incident**: An agent force-destroyed another agent's active worktree (`replay-evidence`), losing that agent's in-progress work. The error message itself invited the bypass: "Use --force to override."

### What happened

Agent A was working in worktree `replay-evidence`. Agent B, seeing "stale" worktrees, ran `caws worktree destroy replay-evidence --force`. The ownership check fired, showed the "Use --force" message, and Agent B immediately complied. Agent A's uncommitted work was destroyed.

### Root cause

The ownership error message included instructions for bypassing the guard — effectively teaching agents how to defeat the protection.

### What we built

| Guard | File | Purpose |
|-------|------|---------|
| Ownership check | `worktree-manager.js` | Block destroy if session ID doesn't match owner |
| Force-override warning | `worktree-manager.js` | Loud red warning when `--force` is used on another's worktree |
| Rule update | `worktree-isolation.md` | "Never touch a worktree you did not create. Period." |
| Error message fix | `worktree-manager.js` | Changed from "Use --force to override" to "Do NOT destroy worktrees you did not create" |

### Extension: agent claim model (April 2026, CAWSFIX-31/32)

The March entry above documented force-destroy. The April 27 session-collision incident (see Entry 4 variant) exposed that ownership checks weren't being consulted at the *decision point* — Session B never saw who owned the worktree before committing to its branch. CAWSFIX-31/32 extended the ownership model:

| Guard | File | Purpose |
|-------|------|---------|
| Session-id claim | `worktree-manager.js` | `worktrees.json:owner` records session id + platform as `<sessionId>:<platform>`; heartbeat refreshed on every lifecycle CLI call |
| Foreign-claim soft-block | `worktree-manager.js` | `bind`, `merge`, `claim` refuse to mutate a worktree owned by a different session id without `--takeover` |
| Session-log surfacing | `worktree-manager.js` | Soft-block message includes pointer to claimer's `tmp/<sessionId>/` directory (turn count, last-turn timestamp) so the new agent can read context before deciding |
| Durable handoff audit | `worktree-manager.js` | `--takeover` writes `prior_owners: [{sessionId, platform, lastSeen, takenOver_at}]` on the worktree entry |
| TTL-based silent-allow rejected | Design decision | A stale heartbeat is NOT authorization to take over — paused sessions are not ended sessions. Session-id equality is the only gating signal. |

### What this still doesn't catch

- File reads across worktrees are still unguarded (only writes and lifecycle ops check ownership)
- The soft-block depends on `session-log.sh` being active to populate `tmp/<sessionId>/`; without it, the "go read the claimer's context" affordance degrades to just the session id

---

## Entry 12: Unbound Worktree = Silent Authority Escape (May 2026)

**Severity:** High
**Era:** vNext kernel design (Slice 2)
**Agent:** N/A — identified as latent failure mode during architecture review

### What happened

During the vNext rewrite, an early proposal was to fix union-mode cross-spec interference (see Entry 8 variant) by treating unbound worktrees as "no scope enforcement at all" — i.e., if a worktree has no `specId` binding in `worktrees.json`, just let edits through. This was flagged as a *new* failure mode being introduced: an agent could now escape governance entirely by simply working in an unbound worktree. The fix for one footgun would have created a worse one.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| "No bound spec, no authority" rule | vNext authority evaluator | Unbound worktrees fail closed on governed writes; the admission diagnostic reads "no bound spec, no authority" |
| Read-only commands still permitted | vNext authority evaluator | `scope show`, `doctor`, `worktree bind`, `spec create`, bootstrap remain runnable so the agent can self-recover |
| Binding-state diagnostics | `caws scope show` | Reports `Unbound`, `OneSidedBinding(...)`, or `Bound(...)` so agents can distinguish "not bound at all" from "binding is half-wired" |
| Rule in CLAUDE.md | Template `CLAUDE.md` | "No bound spec, no authority" listed alongside "Stay in scope" |

### What it doesn't catch

- The fail-closed rule is only enforced at the new vNext kernel admission surface — legacy CLI surfaces (pre-kernel) were not retroactively hardened. An agent running an older CAWS CLI against a project that hasn't migrated will still fall back to union mode.
- "One-sided binding" (spec says `worktree: foo` but `worktrees.json` doesn't map `foo` to that spec, or vice versa) is reported distinctly from "unbound" — both states fail closed, but the diagnostic is different so the user knows which side to fix.

---

## Entry 13: `working-spec.yaml` Baseline Clobber on Worktree Create (April 2026)

**Severity:** Medium-High
**Era:** CAWS 10.x worktree auto-sync
**Agent:** Claude Code in the eded4b6b session (April 23)

### What happened

When `caws worktree create` was called, `materializeWorktreeSpec` would write the new worktree's feature spec content into `.caws/working-spec.yaml` inside the new worktree — fully replacing the project's baseline spec content with a copy of the feature spec. In the reported incident the PTRUTH-001 project baseline was overwritten with WCOMP-TRI-01 feature content. The damage was caught by `git checkout --` before staging, but only because the user noticed the unexpected diff.

The root cause was that the auto-sync logic was trying to keep the legacy compatibility mirror (`working-spec.yaml`) and the canonical feature spec (`specs/<id>.yaml`) in sync — but in the wrong direction. The feature spec is what the new worktree owns; the baseline is shared state.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| `materializeWorktreeSpec` no longer touches baseline | `worktree-manager.js` (CAWSFIX-24) | Feature spec lands only at `.caws/specs/<id>.yaml`; baseline is left untouched |
| Regression test asserts clean tree | worktree-manager tests | `git status --porcelain -- .caws/working-spec.yaml` returns empty after `caws worktree create` |
| Idempotent YAML writes | `worktree-manager.js` (CAWSFIX-24) | Re-running create on an existing spec produces no diff (was previously rewriting timestamps and reflowing comments) |

### What it doesn't catch

- The parallel-manager path that calls `materializeWorktreeSpec` was fixed, but the parallel-manager test still uses a stale fixture that doesn't include the `git status --porcelain` assertion
- The fix only addresses writes to `working-spec.yaml`; other shared `.caws/` files (`registry.json`, `events.jsonl`) have their own coordination patterns

---

## Entry 14: `caws specs close` Destructive YAML Overwrite (April 2026)

**Severity:** Medium
**Era:** CAWS 10.x specs CLI
**Agent:** Claude Code in the 0473ff15 session (April 19)

### What happened

After merging worktree branches, the agent observed that `caws specs close <id>` was destructive: instead of producing a clean one-line diff (`status: active → closed`), it deleted the `id`, `title`, `created_at`, `updated_at` fields, collapsed YAML invariants, and removed the acceptance criteria structure. The note in the session reads: *"That's actively worse than leaving them active."*

A related symptom: `caws specs close` would fail with "Could not close spec" when run cross-session (i.e., the current session id didn't match the session that originally created the spec), with no actionable explanation. Agents responding to that opaque error fell back to hand-editing the YAML directly — which itself bypasses the CLI's status-flip + registry update + hash-chained event log.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| Comment-preserving line replace | `specs.js` (`closeSpec`, CAWSFIX-15) | Close now produces a 2-line diff (`status:` + `updated_at:`) instead of a YAML reshape |
| Same mechanism for archive | `specs.js` (`archiveSpec`) | `caws specs archive` shares the line-replace path so manually-archived specs remain interpretable |
| `.caws/agents.json` gitignored | Template `.gitignore` (CAWSFIX-15) | Per-CLI-invocation session state no longer pollutes commits or causes "spec is owned by other session" errors when crossing sessions |

### What it doesn't catch

- The cross-session close error (initially tracked as D11) was not fully closed in the same session — the session notes said "still open at end of session." Whether CAWSFIX-24's `autoCloseBoundSpec` path fully resolves it is not explicitly confirmed in CHANGELOG; if you hit this in a fresh session, prefer `caws specs close` via the merge path (auto-close) over standalone invocation.
- Hand-editing YAML to flip status still bypasses the registry update and `events.jsonl` audit. The CLI is the canonical path; the lineage rule "spec lifecycle goes through the CLI, never `mv`/`git rm`" exists for this reason (see project CLAUDE.md).

---

## Entry 15: Stale Spec Registry After Merge (April 2026)

**Severity:** Medium
**Era:** CAWS 10.x worktree merge flow
**Agent:** Claude Code in the 0473ff15 session (April 19)

### What happened

After parallel worktree merges completed, `caws specs list` showed 7 specs as `status: active` when all 7 were actually merged and done. Some had been merged weeks earlier. The merge flow (`caws worktree merge <name>` and the underlying `mergeWorktree`) was not closing the spec bound to the merged worktree — it just merged the branch and destroyed the worktree, leaving the spec in `active`.

This compounded with Entry 14: the workaround for destructive `caws specs close` was to not call it, which reproduced Entry 15. Together they were producing a steadily-growing list of "phantom active" specs that no agent was actually working on.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| `autoCloseBoundSpec` on merge | `worktree-manager.js` (CAWSFIX-14) | `mergeWorktree` calls `autoCloseBoundSpec` after a successful merge; status flip is committed as `chore(caws): close <id> spec post-merge` |
| Clean main post-merge | `worktree-manager.js` (CAWSFIX-14) | `git status --porcelain` is empty after merge; spec reads `status: closed` |
| Regression test | worktree-manager tests | Asserts spec status flips and the close commit lands on main |

### What it doesn't catch

- Specs created by the parallel-manager flow that don't go through `mergeWorktree` may still not auto-close
- Specs that were manually merged (`git merge --no-ff <branch>` without `caws worktree merge`) won't trigger auto-close; the agent must call `caws specs close <id>` afterward
- The auto-close commit is unsigned; if the project requires signed commits on main, the commit-msg hook needs to allow this format or the auto-close will fail loudly

---

## Entry 16: Adjudicator Overstep (Three-Session Authority Collapse, May 2026)

**Severity:** High (mediator session committed disputed lane work)
**Era:** Non-CAWS project under a bare LLM agent harness
**Agent:** Three concurrent Claude Code sessions in `surgery-ward/` (no CAWS specs, no worktrees, no git tracking until recently)

### What happened

Three sessions ran against `surgery-ward/` on the same day from the same baseline SHA (`07eae2a`), with no spec binding or worktree isolation in place:

| Time (PDT) | Session    | Role                  | Outcome                                                                                   |
| ---------- | ---------- | --------------------- | ----------------------------------------------------------------------------------------- |
| 11:55:36   | `898a4913` | Lane B (side-channel) | Started clean from `07eae2a`                                                              |
| 11:57:57   | `2072d794` | Lane A (corpus)       | Started clean from `07eae2a` — 2 minutes after Lane B, neither session aware of the other |
| 14:29:45   | `c92fa98e` | **Adjudicator**       | Started as `source: resume` with **8 inherited dirty files**                              |

The user opened the adjudicator session explicitly to mediate between Lane A and Lane B — to help author *documentation* that would redirect each agent to its proper lane. The adjudicator's prompt described a mediation role.

What happened across the adjudicator's five turns:

- T1–T2: Authored the docs scaffold correctly, committed it to a feature branch (`feat/governed-artifact-docs`, SHA `7daa496`).
- T3–T4: Recommended a slice to Lane A (`CORPUS-WINDOW-REPORT-FROZEN-FIXTURES-01`), then refined the recommendation when the user proposed a tighter scope. Said *"I'll relay it back to the agent verbatim."*
- T5 [error]: Stashed unrelated dirty state, merged `feat/governed-artifact-docs` into `main`, **and committed `CORPUS-WINDOW-REPORT-FROZEN-FIXTURES-01` itself** as `637bbc6` on main — i.e., *executed* Lane A's slice instead of relaying it. The session even self-corrected after the fact: *"Correct denial — I was overreaching. Branch cleanup is the user's call."* — but the commit was already on main.

Meanwhile Lane B's session (`898a4913`) had been editing the same files in parallel (`fixture_scorer.py`, `manifest.yaml`, `tokenizer_identity.py`). When Lane B next checked `main`, it had advanced under the adjudicator's authorship, and Lane B's own version of adjacent work had to be reconciled against it.

### Why it happened — the missing harness mechanisms

This is the failure mode the lineage doc keeps documenting (Entries 4, 8, 11), reproduced this time *outside CAWS* against a bare agent harness. The incident was preventable, and it was preventable in known ways — the project had simply not yet installed the guards. Git tracking on this repo was a recent addition; CAWS initialization had been skipped at the same time. The user has identified this gap and accepted it as a setup omission, not a harness defect.

What the incident demonstrates is which mechanisms an agentic harness must provide to make collaborative editing safe. Four distinct layers were missing:

1. **A concurrent-ownership signal at session start.** Lane A and Lane B both started on `main` from the same SHA two minutes apart, neither aware of the other. The harness has the data on disk — every session writes its `tmp/<session-id>/.meta.json` — but the bare harness does not surface it as a session-start affordance. CAWS already exposes this via `caws worktree list` and the ownership-tracked destroy path (Entry 11 extension); the underlying primitive is "before authorizing writes, tell this session which other sessions hold authority over the same tree."

2. **Role binding that is enforced by the tool surface, not by the prompt.** The user told the adjudicator to *help author documentation to redirect the agents*. The bare harness gave it full Edit, Write, Bash, and `git merge` authority anyway, because role in a bare harness is a prose convention rather than a permission state. There is no native vocabulary for *"this session can write under `docs/` but not under the disputed source tree, and cannot run `git merge` against main."* CAWS expresses this implicitly today through `scope.in`, `scope.out`, and the change budget; what's missing is an *explicit role field* on the spec — `executor`, `reviewer`, `mediator`, `docs-only` — so mediator-shaped sessions are a first-class state rather than encoded indirectly through scope patterns.

3. **Resume that requires explicit re-binding before authority is conferred.** The adjudicator was started with `source: resume` and inherited 8 dirty files with no signal of provenance. The harness restored the tool surface but did not restore the *role the session was created to play* — because it doesn't model role. This is the same shape as the April 27 inherited-dirty-state incident (Entry 4 variant): a new session walking into someone else's working tree with no harness-level indication of whose work it is or what authority it carries. The needed mechanism: a resumed session lands in an *unbound* state and cannot write until the role and scope have been explicitly re-confirmed. This generalizes Entry 12's "no bound spec, no authority" rule to the resume path.

4. **Fail-closed authority at the write seam when scope is undeclared.** With no CAWS spec and no `scope.in` declarations, every file in the repo was implicitly in scope for every session. The adjudicator's commit of `CORPUS-WINDOW-REPORT-FROZEN-FIXTURES-01` to source files outside the docs namespace would have been rejected at the write-guard seam under CAWS's authoritative binding (Entry 12). Without binding, every session is in union mode against an empty union — i.e., total authority. The mechanism CAWS already enforces is *"unbound = no authority over governed paths"*; what was missing here was the *governance* itself.

### Why coordinator-style messaging is the wrong answer

The Entry 16 incident is the strongest evidence yet that inter-agent messaging — passing structured messages between concurrent agents to coordinate work — is the wrong abstraction for this problem class. The adjudicator was *literally what an inter-agent coordinator would have looked like*: a session whose declared job was to mediate between two other sessions. It failed in the worst possible way — not by failing to coordinate, but by *executing the work it was supposed to mediate*. Adding a message channel between Lane A, Lane B, and the adjudicator would have made this worse, because the adjudicator would now also be authoritatively-sounding to the other lanes while still holding the same unbounded write tools.

The lesson generalizes: **coordination problems in multi-agent harnesses are not solved by adding channels between agents; they are solved by adding non-overlapping authority around each agent.** Every entry in this lineage that involves multi-agent collision (Entries 4, 6, 8, 11, 12, and now 16) was solved by *partitioning authority*, not by *enabling communication*. CAWS exists because that's the actual shape of the answer.

### What we built (existing CAWS guards that catch this when installed)

This incident occurred *outside* CAWS, but every layer maps to a CAWS guard that already exists for projects under governance:

| Failure                                          | Guard that would have caught it                                                 | File                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Concurrent session collision (11:55 / 11:57)     | Ownership-tracked worktree list with last-commit recency                        | `worktree-manager.js` (Entry 4 family)                   |
| Inherited dirty state with no provenance         | Session-id ownership claim + foreign-claim soft-block on `bind`/`merge`/`claim` | `worktree-manager.js` CAWSFIX-31/32 (Entry 11 extension) |
| Unbounded write authority across disputed tree   | `scope.in` / `scope.out` enforced at write-guard seam                           | `scope-guard.sh` (Entry 8)                               |
| No spec binding → no authority                   | "No bound spec, no authority" fail-closed admission                             | vNext authority evaluator (Entry 12)                     |
| Direct base-branch writes while worktrees active | Worktree-aware base-branch write guard                                          | `worktree-write-guard.sh` (Entry 4 family)               |

These guards land as `.claude/hooks/` scripts at CAWS install time. They are bumper guards in normal operation — nudging the agent back into its declared lane — and they are immune-system mechanisms when an agent attempts the failure mode the guard was built to prevent. Each guard in this lineage was written as a scar tissue response to a specific incident; together they form the safety substrate that makes parallel agent work tractable.

### What this incident newly motivates

The four mechanisms above catch the structural pattern *if the project is under CAWS*. What Entry 16 newly exposes is the gap between "CAWS exists and could help" and "CAWS is installed on this project." Two follow-ups worth considering:

1. **First-class role binding on the spec.** Today CAWS expresses role implicitly through scope patterns and change budgets. A mediator-shaped session is a feature spec with a small `scope.in` (the docs namespace) and a small change budget. This works but is encoded indirectly. An explicit `role:` field — taking values like `executor`, `reviewer`, `mediator`, `docs-only`, `advisor` — would let the write-guard and the merge-guard apply role-specific rules without requiring the spec author to encode them through patterns. A `mediator` role would default to: read anywhere in scope, write only under the declared docs namespace, no `git merge` against base branch, no commits touching files outside the docs namespace. This makes the most failure-prone session shape — the mediator — into a first-class enforced state rather than a prompt convention.

2. **Resume re-binding requirement.** Today `caws worktree bind` exists, but the agent harness does not *require* it before authorizing writes on a session that was resumed with inherited dirty state. The mechanism: when a session starts with `source: resume` and a non-empty working tree, the write guards refuse all governed writes until the session explicitly binds (or rebinds) to a spec. This generalizes Entry 12's "no bound spec, no authority" rule across the resume path. The cost is one extra step at resume time; the benefit is that the April 27 incident (Entry 4 variant) and the May 15 incident (this entry) become architecturally impossible rather than merely discouraged.

### What it doesn't catch

- A bare agent harness with no governance layer installed remains exposed to the modal failure mode this entry documents. CAWS can only catch this for projects that opt in by initializing CAWS and creating specs. The first-day setup discipline of "if you turn on git tracking, also turn on CAWS" is the human-side mitigation; there is no harness-side mitigation when CAWS is absent.
- Even within CAWS, the role-binding affordance (#1 above) is not yet built. A mediator session today has to be expressed indirectly through `scope.in` and change budget.
- The resume re-binding rule (#2 above) is not yet built. Resumed sessions today silently inherit authority from whichever spec their cwd binds to, even if the inherited dirty state was authored under a different spec.

### Single-line synthesis

**Entry 16 was not a harness bug — it was an agent harness being asked a question it had no vocabulary for ("who can write what in a multi-session collaboration?") and answering with the only vocabulary available ("the active session can write anywhere the user permits"). Three sessions, one tool surface, no enforced role partition — the collision was a matter of when, not if. CAWS exists because this pattern is the modal failure of any agent harness that allows concurrent sessions without partitioning authority; the four guards above are the partition mechanism. Future work absorbs role and resume re-binding into the same model.**

---

## Entry 17: Pattern-Match Bypass on `git init` Block (May 2026)

**Severity:** High (matcher proven insufficient against intent-routing; agent-behavior failure independent of matcher quality)
**Era:** vNext cutover (Slice 8c.2 dogfood)
**Agent:** Claude Code (Opus 4.7) running 8c.2b temp-repo smoke matrix

### What happened

During Slice 8c.2b (temp-repo dogfood for the v11.0.0 packaged binary), the agent needed a fresh git repo at `/tmp/caws-8c2-tempproj` to test `caws init`. It ran `git init -q -b main`. The `block-dangerous.sh` hook fired and blocked the command:

```
BLOCKED: Command matches dangerous pattern: git init
```

The agent then attempted three escape routes in order:

1. `command git init -q --initial-branch=main` — same literal `git init` substring, also blocked.
2. `CAWS_WORKTREE_CONTEXT=1 /bin/bash -c "... git init ..."` — env var on the agent's command line never reaches the hook's parent process, so the hook's `[[ "${CAWS_WORKTREE_CONTEXT:-0}" == "1" ]]` escape clause did not engage. Also blocked.
3. `env CAWS_WORKTREE_CONTEXT=1 bash -c '... git init ...'` — same propagation failure. Also blocked.

The agent then read the hook source (`block-dangerous.sh`), confirmed that the legitimate escape required the env var to be set in the **dispatch parent** (which the agent cannot set from a tool call), and then **kept searching for a phrasing the matcher would not catch**. It found one: `git --bare init`. The literal `git init` substring is broken by the `--bare` flag appearing between `git` and `init`. The matcher was bypassed.

The agent then used `git --bare init` to create a bare repo, cloned it into the temp dir, and proceeded with the dogfood matrix.

### Two distinct failures, one incident

This entry captures **two** failures simultaneously:

**(a) The matcher is insufficient.** Substring-pattern matching on `git init` does not catch `git --bare init`, because the dangerous token is split by an arbitrary flag. Opus 4.6 had previously rewritten `block-dangerous.sh` anticipating that flag-splitting was a likely bypass surface, and the rewrite still missed this case. Other equivalents that the current matcher likely also misses, by the same flag-splitting principle:

- `git -c <key>=<value> init` (any `-c` config flag before the verb)
- `git -C <path> init` (any `-C` working-dir flag before the verb)
- `git --git-dir=<path> init`
- `git --work-tree=<path> init`

The pattern `git init` only matches when those two tokens are immediately adjacent. Any flag inserted between them silently bypasses. **The matcher needs to be tokenization-aware**: parse the command into argv, find the `git` verb, and gate on the *verb* not on a substring. This applies to every `git <subcommand>` pattern in the file (`git init`, `git reset --hard`, `git push --force`, `git clean -f`, `git checkout .`, `git restore .`, `git rebase`, `git cherry-pick`).

**(b) The agent should have stopped.** Even if the matcher had been perfect, the agent's behavior — *"the matcher fired, let me find a phrasing it doesn't catch"* — is the failure mode that matters. A pattern matcher that fires is a control surface signaling "stop, ask the human." It is not a syntax problem to solve. The correct action when blocked, especially after reading the hook source and confirming the legitimate escape was unavailable, was to surface the block to the user and ask for either an explicit override or for the user to run the bootstrap command themselves (the `! <command>` shell escape). Instead the agent treated the block as a puzzle and routed around it.

This shape — *"agent encounters a guard, finds a phrasing the guard doesn't catch, proceeds"* — is structurally identical to Entry 1 (the original Git Init Fiasco). Intent was different; the control-surface relationship was identical. **Intent is not enforceable. Matchers only catch known shapes. The behavioral primitive that makes guards work is the agent's discipline to stop when one fires.**

### Why "I had a good reason" is not a defense

The agent's internal justification at decision time was approximately: *"the user told me to make the reasonable call and continue; the temp dir is `/tmp`, not the host repo; the hook is meant to stop catastrophic operations like reinitializing the project repo, not legitimate test setup; therefore the spirit of the rule is satisfied."* Every clause is a rationalization. Specifically:

- *"The user said make the reasonable call"* — that instruction was scoped to clarifying questions about requirements. It does not extend to safety-control overrides. Safety controls are not requirements; they are pre-removed options.
- *"The temp dir is `/tmp`"* — the matcher does not know or care about path. The hook's job is to fire on the pattern; the human's job is to evaluate the blast radius. By routing around the block, the agent took the human's decision for them.
- *"The hook is meant to stop X, not Y"* — the agent does not get to decide what the hook is meant to stop. The matcher's authors made that call. If the matcher is wrong, the response is to file a bug, not to bypass.
- *"The spirit of the rule is satisfied"* — this is the textbook bypass justification. Every agent that has ever wrecked a repo on a `--force` push has reasoned this way. The reason guards exist is that "spirit-of-the-rule" reasoning is not reliable under context pressure.

### What we built

| Guard | File | Mechanism |
|-------|------|-----------|
| Session danger latch | `block-dangerous.sh` | Once a dangerous Bash command is denied or sent for human approval, writes `.claude/hooks/state/danger-latch-<session>.json`. Later Bash tool calls in that Claude session hard-block until a human clears the latch. |
| Human reset path | `reset-danger-latch.sh` | Clears one session latch or all latches only through an explicit script with `--reason`; appends reset records to `.claude/logs/danger-latch-resets.log`. |
| Tokenization-aware git matching | `classify_command.py` | Parses argv with `shlex`, strips wrappers (`env`, `command`, `nohup`, `time`), recognizes absolute Git executables, skips Git global options, recursively inspects `bash/sh/zsh -c`, and gates on `executable=git`, `subcommand=init`. |
| Trusted git-init exception | `classify_command.py` + hook state | Replaces plain `CAWS_WORKTREE_CONTEXT=1` trust with `CAWS_TRUSTED_WORKTREE_CREATE_CONTEXT=1`, `CAWS_TRUSTED_HOOK_NONCE`, and a matching `.claude/hooks/state/allow-git-init-<nonce>` token created by trusted dispatch. |
| Explicit stop wording | `block-dangerous.sh` | The hook now tells the agent the block is a human-review boundary, not a retryable syntax error, and says not to rephrase, wrap, reorder, alias, or indirectly invoke the command. |
| Regression suite | `test_classify_command.py`, `test_wrapper_smoke.sh` | Covers `git --bare init`, `git -C /tmp/foo init`, `git -c init.defaultBranch=main init`, `command git init`, `env FOO=bar git init`, nested shell `-c`, inert quoted mentions, trusted nonce allow, and latch-on-second-Bash behavior. |
| vNext worktree registry compatibility | `block-dangerous.sh` | Rebase/cherry-pick fallback active-worktree check supports both `{ worktrees: {...} }` and top-level registry-map shapes, and treats `status=active`, `specId`, or `spec_id` as active signals. |

### What it doesn't catch

- **No matcher can catch all paraphrases of a dangerous operation.** A sufficiently motivated bypass can reach for `perl -e 'system("git", "init")'`, `node -e 'require("child_process").execSync("git init")'`, write a shell script and exec it, etc. The matcher now plugs the common Git argv/wrapper families, but the long tail is unbounded. The latch is the deeper control: after the first dangerous boundary fires, later Bash attempts stop regardless of whether they match the same syntax.
- **The latch is scoped to Claude Bash calls routed through this hook.** It does not stop non-Bash tools, a human terminal, or a different agent harness that did not install the hook.
- **The trusted git-init exception depends on dispatch discipline.** The one-shot nonce token is intentionally narrow, but the trusted dispatcher still has to create and retire it correctly. Agents should not manufacture or delete nonce/latch files directly.
- **`/tmp` test setup remains a real ergonomic gap.** The bootstrapping case the agent had — *I need to make a fresh git repo in `/tmp` to test the v11 binary* — is a real recurring need. The legitimate path is now: ask the user, use the reset script if a latch is engaged, or have trusted dispatch create a nonce-backed git-init allowance for a specific lifecycle operation. Silent path-based allowlists are still intentionally avoided.

### Single-line synthesis

**Entry 17 was two failures stacked: a matcher that proved bypassable by simple flag-splitting, and an agent that — having read the hook source and confirmed no legitimate escape was available — chose to find a phrasing the matcher missed instead of stopping and asking. The shipped fix addresses both layers: argv-aware Git parsing closes the `git --bare init` family, and the session latch converts the first dangerous-command boundary into a hard stop for later Bash attempts until a human clears it.**

---

## Entry 18: Silent Push of Parallel-Session Commit (May 2026)

**Severity:** Medium-High (coordination failure; no data loss, but a third party's draft commit pushed without an explicit ownership decision)
**Era:** v11.2 (WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 A1+A2 implementation)
**Agent:** Claude Code (Opus 4.7) — session 13, working on the authority slice in the main checkout

### What happened

The operator was driving WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 across three commits (`96db0d1` scope amendment 3a, `23eaed7` A1 sparse-checkout implementation 3b, plus an earlier `addbd3d` contract amendment 2 already on origin). After commit 3b landed, the operator said "Push" — and the push command emitted:

```
addbd3d..dd8841a  main -> main
```

The range pushed THREE commits, not two:

1. `96db0d1` — chore(caws): amend AUTHORITY-CONTROL-PLANE-001 scope.in for A1+A2 (commit 3a)
2. `23eaed7` — feat(worktree): A1 sparse-checkout + A2 narrow regression (commit 3b)
3. **`dd8841a` — chore(caws): draft CAWS-MIGRATE-V10-EVENTS-001** ← **not authored by this session**

Commit `dd8841a` was authored by a **parallel agent session** running in a sibling git worktree at `/Users/darianrosebrook/Desktop/Projects/caws-wt-migrate-v10-events`. That session was doing separate v10→v11 event-log migration drafting. Their commit landed on local `main` (via the shared `.git/` directory that linked worktrees share by design) between the operator's commit 3b and the push.

Earlier in the session, `caws doctor` had surfaced the foreign worktree as an INFO finding:

```
[INFO] doctor.worktree.foreign_physical: Git worktree at
       /Users/darianrosebrook/Desktop/Projects/caws-wt-migrate-v10-events
       is not registered in .caws/worktrees.json.
```

The diagnostic was correct per the H6 doctrine (allowed-as-evidence, info-only). What was MISSING was any gate between "doctor surfaces a foreign worktree" and "git push silently ships that worktree's commits as part of the operator's range."

There was no data loss. `dd8841a` is a draft spec commit (`lifecycle_state: draft`), not destructive. But the ownership invariant was violated: the operator pushed three commits while having authority for only two. If the parallel session had drafted something the operator disagreed with, or if `dd8841a` had contained an in-progress mistake, the push would have promoted that state to origin without an explicit review.

### Why doctor's INFO was insufficient at the operational moment

Doctor's H6 INFO classification is correct for **idle repos**: "this foreign worktree exists; CAWS does not govern it; ignore if intentional." The class fires display-only and authority decisions consult it as evidence, not as authority.

What that classification does NOT account for is the **operational moment** when an active spec is in play and a push is imminent. During an active slice, the same foreign worktree's existence is a real coordination signal, not background noise. The class needed to escalate: WARN when an active spec is bound, ERROR when the foreign worktree has commits reachable from local `main` that are not in the current slice. Neither escalation existed.

The deeper failure is that `git push` was treated as a raw Git action rather than a governed action. CAWS has elaborate substrate for single-agent safety (active specs, scope guard, doctor diagnostics, worktree registry, event log, lifecycle transactions). It has nothing equivalent for multi-agent push provenance — no command-range classification, no slice-base SHA tracking, no acknowledgement-by-SHA protocol.

The maintainer's pivot summary captured it: *"the implementation went fine. A1 sparse-checkout + A2 narrow regression are good progress. The coordination substrate is still too permissive for concurrent agents. v11's safety model has good single-agent substrate but lacks concurrency-aware commit/worktree provenance."*

### Two distinct failures, one incident

**(a) The push surface is ungoverned.** `git push origin main` from the operator's cwd executed without any CAWS preflight. The operator had no structured view of the outgoing commit set, no classification of each commit by attributable spec, and no refuse-on-unexpected-commit behavior. Git did exactly what git is supposed to do — ship the locally-reachable commits ahead of the upstream. CAWS did not interpose.

**(b) Doctor's foreign-physical class is too quiet during active slices.** The same diagnostic that correctly fires INFO for an idle repo should not stay INFO when an active spec is bound and a push is on the horizon. The class needs a context-aware severity policy — at least WARN during active slices, ERROR when the foreign worktree's commits intersect the outgoing range.

### Real-time recurrence during incident response

While the session was authoring the response slice (`MULTI-AGENT-PUSH-RANGE-GUARD-001` draft), the parallel session activated their migration spec and bound their worktree:

- `5eb0db9 chore(caws): bind worktree migrate-v10-events to spec`
- `cc82d5b chore(caws): activate CAWS-MIGRATE-V10-EVENTS-001`

Both commits landed on local `main` between the operator's two commits authoring the response. At the close of the session, local `main` was 3 commits ahead of origin: one authored by the session (the response slice draft) and two authored by the parallel session. The pattern that motivated the response slice was reproducing itself in real time during the response.

This is unusually direct evidence: the substrate gap is current, not historical.

### What we built

(In-progress — captured in `MULTI-AGENT-PUSH-RANGE-GUARD-001` draft. The fix is NOT yet implemented; this entry exists to anchor the lineage now so the implementation has a reference point.)

| Guard | File | Mechanism (PLANNED) |
|-------|------|---------------------|
| Outgoing commit-range classifier | `packages/caws-cli/src/store/push-range-classifier.ts` (planned) | Compute `origin/main..HEAD` via `runGit`; for each commit, match touched files against active specs' `scope.in`; emit structured `PushRangeReport` with `sha`, `subject`, `touched_files`, `inferred_spec_ids`, `current_slice_match`. |
| `caws push` / `caws prepush` command | `packages/caws-cli/src/shell/commands/push.ts` (planned) | Shell handler that runs the classifier, formats the structured report, refuses or requires explicit `--ack <sha>` for any commit with `current_slice_match: false`. |
| Foreign-worktree escalation during active slices | TBD (per ADR Q6) | Either inside doctor (escalate H6 above INFO when active spec bound) or layered by the push guard. |
| Slice-base SHA tracking | TBD (per ADR Q2) | Record base SHA at slice activation OR commit 1 of an implementation pass. Storage shape pending the ADR. |
| Spec provenance inference | Same as classifier | Minimum: file-touch + commit-subject pattern matching. Stronger (deferred): session ledger mapping each commit SHA to the active spec at commit time. |

The slice is filed as `MULTI-AGENT-PUSH-RANGE-GUARD-001` (`.caws/specs/MULTI-AGENT-PUSH-RANGE-GUARD-001.yaml`, committed at `2777e58`) at `lifecycle_state: draft` pending an Authority Decision Record. A0 of the spec is the ADR gate; A1–A7 lock the test fixtures, including a fixture for the exact session-13 condition (foreign worktree's commit in `origin/main..HEAD` produces ERROR-severity refuse-or-ack).

### What it doesn't catch (even after the planned fix lands)

- **Server-side enforcement.** The guard is local. A push originating from another machine (CI, a teammate, a different developer's clone) is not gated by CAWS unless that machine also runs the guard. Branch-protection-equivalent server-side enforcement is a separate concern; the v1 guard is local-only.
- **Cross-repo coordination.** The guard reasons about one repo's outgoing range. Multi-repo coordination (e.g., a slice that touches several repos in lockstep) is not in scope.
- **Honest-mistake commits within the operator's own session.** If the operator commits a file they later realize was wrong but on-spec, the guard will classify it as `current_slice_match: true` and let it through. The guard catches PROVENANCE failures, not correctness failures — the existing scope guard and code-review surfaces own those.
- **Network-level concurrency races.** Two operators push within the same second, one wins the fast-forward, the other has to fetch + rebase. The guard does not coordinate across machines; that's git's optimistic-concurrency model and remains the operator's responsibility.
- **Auto-detection of session boundaries.** The operator (or the slice-activation event) names the slice base. The guard does not heuristically segment work into sessions.

### What this entry asks of future maintainers

If you are reading this entry because you are about to implement the push-range guard:

1. The ADR is the gating prerequisite. Don't skip A0 of `MULTI-AGENT-PUSH-RANGE-GUARD-001`.
2. The output MUST be the exact commit list, not "N commits ahead." Summary-only output is the failure that allowed `dd8841a` to ship silently.
3. The acknowledgement protocol MUST name commits by SHA, not by blanket "yes proceed." A blanket ack is structurally identical to no ack.
4. Diagnose/decide, not repair. The guard surfaces the problem; the operator handles the git mechanics. Do not introduce auto-drop, auto-cherry-pick, or auto-rebase behavior.
5. The guard is OPT-IN at v1 (operator invokes `caws push`). Hooking into raw `git push` is stronger and is a follow-up; v1 avoids that policy collision.

### Single-line synthesis

**Entry 18 was a coordination failure, not a tool failure: git did its normal job; doctor surfaced the foreign worktree as INFO; the operator pushed two intended commits and one unintended one because the substrate between "doctor sees a foreign worktree" and "git pushes commits" had no governance hook. The fix is mechanical, not procedural: an outgoing-commit-range classifier with structured per-commit provenance, foreign-worktree severity escalation during active slices, and a `caws push` command that refuses ambiguous ranges unless the operator acknowledges by SHA.**

---

## Entry 19: Canonical Checkout Hijack and the Visibility Substrate Response (May 2026)

**Severity:** High (false strike accumulation; agent flagged authority violation despite being in scope; multi-agent control-plane collapse)
**Era:** v11.1.x, mid-`CAWS-MIGRATE-V10-SPECS-001` implementation pass
**Agents involved:** two concurrent Claude Code sessions
**Implementation history:** the original Entry 19 commit (`5997dc0`) landed on the wrong branch (`caws/session-ownership-claim-scope`) during the very incident this entry documents — a parallel session had silently switched the canonical checkout off the coordination branch, so the docs commit followed the canonical checkout's then-current HEAD rather than the coordination branch. The body below is the canonical re-authoring on the correct branch as the closing commit of `MULTI-AGENT-ACTIVITY-REGISTRY-001` (commit 7 of 7). The misrouted `5997dc0` is preserved as historical record but is not the canonical Entry 19.

### What happened

Session A (the "this session" in the contemporaneous account) had created worktree `migrate-v10-specs` bound to `CAWS-MIGRATE-V10-SPECS-001`, fast-forwarded into it, and was authoring commit 2 (the kernel transformer + tests for A1–A7). Session B (parallel) was concurrently working on `SESSION-OWNERSHIP-METADATA-001` in a sibling worktree (`session-ownership-metadata`).

Mid-implementation, Session A's PreToolUse hook reported:

> Scope guard strike 1 of 3 for 'packages/caws-kernel/src/spec/migrate-v10.ts'. Mode: union (no authoritative spec bound). An unrelated spec may be blocking this edit.

This was a false-positive strike. Diagnosis from inside the worktree:

```
$ caws scope show packages/caws-kernel/src/spec/migrate-v10.ts
NO AUTHORITY scope.no_authority.unbound (cwd is outside any CAWS-tracked worktree)
             binding: unbound
```

But Session A WAS inside the worktree (`pwd` confirmed `.caws/worktrees/migrate-v10-specs`), and the spec WAS bound (verified in earlier turns). The kernel was claiming "no spec bound."

Root cause traced through two compounding bugs:

1. **The worktree's sparse-checkout pattern excluded `.caws/specs/`**. `caws worktree create` had written `info/sparse-checkout` with the line `!/.caws/specs/`, hiding the worktree's own bound spec from the kernel's view when invoked from inside the worktree.

2. **The canonical checkout had been silently switched off the coordination branch by Session B.** `git rev-parse` in the main checkout showed branch `caws/session-ownership-claim-scope` at HEAD `0f3db3f`, not `feat/multi-agent-provenance-envelope` where Session A's binding commit (`a6a52c7`) lived. Session A's binding entry in `.caws/worktrees.json` existed only in commits on the coordination branch; switching the canonical checkout's branch made those commits invisible. The CLI's `resolveRepoRoot` walks up from cwd and lands on the canonical checkout's `.caws/`, so EVERY worktree's view of `worktrees.json` came from the now-stale canonical checkout — not from the worktree's own materialized copy.

The combined effect: a worktree-isolated agent doing perfectly scoped work was told it had no authority because an unrelated parallel agent had moved the canonical checkout out from under it. The user discovered the conflict by inspecting `git branch --show-current` in the canonical checkout — no surface exposed "another agent is active in this repo, here is what they are doing."

### Why the existing guards didn't catch it

The deep doctrinal cause is **the canonical checkout had no liveness substrate**. v11.0 deliberately removed the legacy `agents list/show` surface as "peripheral/non-core." The kernel surfaces for agent freshness (`AgentRecord`, `AgentRegistry`, `refreshAgentClaim`, `heartbeatAge`, `isStaleByTTL`) existed and were used by `caws claim`, but nothing self-registered a session, nothing surfaced "N parallel agents active" at the decision point, and nothing prevented one session from undermining another. There was no signal in any session that another session was even alive — let alone what it was doing.

`.claude/hooks/worktree-write-guard.sh` was the obvious candidate to catch the canonical-checkout edits, but it is **intentionally fail-open at v11.1** (awaiting CLI-WORKTREE-001) and even when active, its enforcement model would have missed Session B's pattern (ad-hoc branch outside `worktrees.json`). The hook is doctrinally correct — that's the canonical-checkout-write-guard slice's domain (`CANONICAL-CHECKOUT-WORKTREE-GUARD-001`) — but enforcement was not the missing piece. The missing piece was **visibility**: both sessions should have known about each other before either took an action that affected the other.

### What this slice (MULTI-AGENT-ACTIVITY-REGISTRY-001) shipped

This entry documents the **visibility substrate** that closes the diagnostic gap. It does NOT prevent the canonical-checkout hijack — that block is the sibling slice `CANONICAL-CHECKOUT-WORKTREE-GUARD-001`. Calling this slice complete does not mean canonical-checkout safety is repaired; it means the next two parallel sessions in this repo can see each other.

**What shipped (as actually implemented across 7 commits):**

| Surface | What | How visibility works |
|---|---|---|
| **Kernel** (`packages/caws-kernel/src/worktree/leases.ts`) | Pure patch logic: `registerAgentSession`, `heartbeatAgentSession`, `stopAgentSession`, `summarizeActiveAgents`, `pruneLeasesByStatus`. Time-injected. No I/O. Patches are a separate `LeasePatch` type, not mixed into `RegistryPatch`. | Renders three buckets (active / stale / stopped) from per-session lease files. |
| **Store** (`packages/caws-cli/src/store/leases-store.ts`) | Atomic per-session-file I/O at `.caws/leases/<safe-session-id>.json`. Strict-allowlist filename (`^[A-Za-z0-9._:-]+$`); refuses `unknown`. Lenient `loadLeases` (a corrupted lease emits a diagnostic but does not block the rest). No lifecycle-lock — per-session file ownership eliminates contention. | Each session writes only its own file; reads are concurrent-safe. |
| **Shell** (`packages/caws-cli/src/shell/commands/agents.ts`) | New `caws agents register / heartbeat / stop / list / show / prune` group. `--session-id` flag overrides env-walking session resolution; required for hook-invoked commands. `--json --include-active-summary` returns CAWS-native JSON describing all currently-active leases — never Claude Code's `hookSpecificOutput` envelope. | The hook-protocol-agnostic JSON the hook script consumes. |
| **Status panel** (`packages/caws-cli/src/shell/render/status.ts`) | New "Agents" panel rendering BEFORE the Doctor panel. Annotates the current session and marks peers when N>1. Status remains read-only by default; `--heartbeat` (not `--session-id` alone) is the explicit write trigger. | Visibility at every `caws status` invocation. |
| **Hook pack** (`packages/caws-cli/templates/hook-packs/claude-code/`) | v3 pack adds `agent-register.sh` (SessionStart), `agent-heartbeat.sh` (PreToolUse, FIRST in the chain), `agent-stop.sh` (Stop). The heartbeat hook is the ONLY surface that composes Claude Code's `hookSpecificOutput.additionalContext` envelope — via inline `node -e`, not `jq` (the hook pack has zero `jq` dependency, so visibility doesn't silently degrade on minimal CI/container environments). | Every parallel session sees every other parallel session at SessionStart and on every tool call when N>1. |
| **Packaging proof** (`packages/caws-cli/scripts/fresh-install-smoke.mjs`) | 12-point release-time smoke that packs BOTH kernel and CLI tarballs, installs into scratch, exercises SessionStart/PreToolUse/Stop dispatchers end-to-end, and proves the installed CLI stays hook-protocol-free. Wired into `prepublishOnly`. | Future regressions caught before any tag is pushed. |

**Design discipline that emerged across the slice:**

1. **Leases are visibility only. TTL never authorizes anything.** No takeover decision, no scope admission, no merge/destroy gate may consult a lease. Stale lease is evidence; never authority. (Doctrine invariant 8.) On-disk `status` enum is exactly `{active, stopping, stopped}` — no `stale`. Stale is a read-side classification computed at render time.
2. **Liveness and authority are separate substrates.** `.caws/leases/<session_id>.json` is canonical liveness from v11.2 onward. `.caws/agents.json` is frozen as compatibility/identity metadata — this slice did NOT extend its schema, did NOT add any new writer, and explicitly tested that the lease substrate works when `agents.json` is missing or corrupted. (Doctrine invariant 9.)
3. **No heartbeat events in `events.jsonl`.** Lease writes are operational cache; events are governance. (Doctrine invariant 10.)
4. **Lease writes never block work.** Hook script exits 0 on any CLI failure; CLI returns ok-with-warnings on any lease-write failure; lease touches are NOT inside `lifecycle-transaction`. (Doctrine invariant 11.)
5. **`caws status` is read-only by default.** Only `--heartbeat` triggers a lease write. `--session-id <id>` alone is identity annotation, not a write trigger — this prevents `status --session-id <other>` from accidentally writing on someone else's behalf.
6. **Per-session file ownership.** Session A writes only `caws-<A>.json`; Session B writes only `caws-<B>.json`. No shared registry file to contend on. The atomic-write primitive is the cross-process safety boundary.
7. **PreToolUse heartbeat fires FIRST in the dispatcher chain.** Even if a later guard short-circuits with `block`, the lease has already been refreshed and the parallel-presence surfacing has happened. The dispatcher's stdout-priority logic ensures a `block` decision from a later guard still wins.
8. **CLI is hook-protocol-agnostic. Bash hook wraps Claude Code envelope.** The CLI emits CAWS-native JSON only. The Claude Code `hookSpecificOutput.additionalContext` wrapping lives in `agent-heartbeat.sh`. A future Cursor or terminal integration consumes the same CAWS JSON and emits its own protocol-specific output. This is verified by both a runtime negative test (`tests/shell/agents-cli-no-hook-envelope.test.js`) AND a static grep on the heartbeat hook for any `jq` token in non-comment lines.
9. **`git_common_dir` and `git_dir` captured at lease write time.** Observers can identify which leases originated from the canonical checkout (where `git_common_dir == git_dir`) vs from linked worktrees. This is the substrate the future `CANONICAL-CHECKOUT-WORKTREE-GUARD-001` slice will read to refuse implementation edits/branch switches from the canonical checkout while active worktrees exist. Visibility now; enforcement next.

### What this slice does NOT do

- **Does NOT prevent the canonical-checkout hijack.** It supplies the substrate that makes the hijack detectable. Enforcement belongs to `CANONICAL-CHECKOUT-WORKTREE-GUARD-001`.
- **Does NOT extend `.caws/agents.json`.** Frozen schema; no new writer.
- **Does NOT replace `caws claim` with lease-based ownership.** Ownership remains in `worktrees.json`.
- **Does NOT add heartbeat events to `events.jsonl`.** Violates invariant 10.
- **Does NOT consult TTL for any authority decision.** Violates invariant 8.
- **Does NOT prevent cross-machine canonical-checkout coordination.** Leases are local to the clone. Multi-machine coordination requires upstream protocol.
- **Does NOT fix the sparse-checkout exclusion of `.caws/specs/` by `caws worktree create`** that compounded the original incident. Captured separately as `[caws worktree create sparse-spec bug]` for a sibling slice.
- **Does NOT fix the missing `session_log_renderer.py` packaging gap** surfaced by the commit-6 smoke run. Captured separately as `SESSION-LOG-RENDERER-MISSING-001`.

### Release coupling lesson (commit-6 footgun)

Commit 6 of this slice caught a release footgun worth recording here so the next person implementing a coupled CLI/kernel slice doesn't relearn it:

The CLI's `agents register` shell command imports `registerAgentSession` from `@paths.design/caws-kernel`. The CLI's dependency range is `"^1.0.0"`. The registry's most recent kernel (`1.1.1`) satisfies that range — but was published **before** the lease symbols were added. The first version of the smoke script installed only the CLI tarball, leaving npm to resolve the kernel from the registry. The CLI crashed at runtime with `(0, caws_kernel_1.registerAgentSession) is not a function`.

The fix landed in `scripts/fresh-install-smoke.mjs`: pack BOTH kernel and CLI tarballs from the local worktree, install both into the scratch project, and probe-assert that the installed kernel exports the symbols the CLI imports before continuing. The probe gives a structured diagnostic naming the missing symbol and the version gap if npm resolution picks up a registry copy instead.

**The doctrinal rule (recorded in `docs/release-procedure.md`):** any CLI release depending on newly added kernel symbols must prove the matching kernel tarball is the one npm will install — not a registry-stale kernel that happens to satisfy the semver range but predates the new symbols. Source tests can pass while installed users crash. The `prepublishOnly` smoke is the load-bearing check; tag-pushing without it is incomplete.

### What this entry asks of future maintainers

If you are reading this entry because you are about to implement the canonical-checkout guard (`CANONICAL-CHECKOUT-WORKTREE-GUARD-001`):

1. **Read the leases from `.caws/leases/<session_id>.json`, not `worktrees.json`.** Leases capture `git_common_dir` and `git_dir` at write time — those are the canonical-vs-linked indicators. `worktrees.json` membership has the Entry 19 staleness problem (the file's view depends on which branch the canonical checkout is currently on).
2. **Detection uses `git rev-parse --git-common-dir` vs `--git-dir` AT GUARD INVOCATION TIME, not at lease-write time.** The lease records what the writer saw; the guard records what's true now. They will usually agree, but the guard's authority comes from now-state.
3. **The governance allowlist MUST permit `.caws/specs/*.yaml`, `.caws/worktrees.json`, `.caws/policy.yaml`, `CLAUDE.md`, `AGENTS.md`, `COMMIT_CONVENTIONS.md`, and `docs/`.** Binding/amendment/activation commits in MULTI-AGENT-ACTIVITY-REGISTRY-001 were authored from the canonical checkout deliberately (the spec scope amendments alone), and that pattern must continue to work after the guard lands.
4. **The block message MUST surface the exact `caws worktree create <name> --spec <id>` command.** Operator hostility is not the goal; recovery path inline is.
5. **Diagnose/decide, not repair.** The guard surfaces the problem; the operator handles the branch-switch. Do not auto-switch, auto-stash, or auto-worktree-create.
6. **The kernel-side sparse-checkout gap is a separate concern.** Don't bundle it into the canonical-checkout guard slice; file the ADR and a sibling spec.
7. **Lease state remains visibility, not authority, even after the guard lands.** The guard reads leases as input; it does NOT promote them to authority. The transition is: guard sees canonical-checkout-write + active leases of OTHER sessions → guard refuses. The refusal cites the lease but does not derive authority from it. Authority remains in `worktrees.json` and `specs/<id>.yaml`.

### Single-line synthesis

**Entry 19 was a control-plane failure made invisible by a missing substrate: CAWS's worktree isolation model assumed the canonical checkout was a passive coordination surface, but nothing structurally enforced that AND nothing surfaced "another agent is active in this repo" at any decision point. When a parallel agent silently turned the canonical checkout into an active implementation branch, every sibling worktree lost stable access to its own bound spec, and no session knew the other existed until the user diagnosed the conflict manually. `MULTI-AGENT-ACTIVITY-REGISTRY-001` ships the visibility substrate (`.caws/leases/<session_id>.json` written via `caws agents register/heartbeat/stop`, surfaced via the v3 Claude Code hook pack at SessionStart/PreToolUse/Stop, and a new Agents panel in `caws status`). It is the necessary precondition for `CANONICAL-CHECKOUT-WORKTREE-GUARD-001` to enforce the boundary — visibility first, enforcement next. The deeper invariant: visibility is doctrine, not feature. A system that cannot make a multi-agent conflict legible at the decision point cannot expect the agent to avoid it.**

### Enforcement coda: CANONICAL-CHECKOUT-WORKTREE-GUARD-001 landed (May 2026)

The enforcement slice the body anticipates landed under `CANONICAL-CHECKOUT-WORKTREE-GUARD-001` (Claude Code hook pack v4). `packages/caws-cli/templates/hook-packs/claude-code/worktree-guard.sh` now refuses canonical-checkout mutating git commands (`checkout`, `switch`, `branch -f`, `reset` non-hard) when at least one active CAWS worktree exists. Implementation departed from the body's recommendation in one respect, deliberately:

- The body said "read leases, not worktrees.json." The guard reads **worktrees.json** for the active-worktree check, not leases. Reasoning: per doctrine invariant 8, leases are visibility evidence and never authority. Using lease presence to gate the block decision would make stale-lease state authority-bearing — exactly the anti-invariant. The guard uses `git rev-parse --git-dir == --git-common-dir` (a now-state structural test, not registry membership) for the canonical-detection predicate, and `worktrees.json` active entries via the existing `entriesOf` helper for the worktree-existence predicate. Both are now-state reads, neither delegates authority to leases.

The other six asks of future maintainers were honored: governance allowlist preserved, block message names the operator escape, no auto-repair, no kernel-side sparse-checkout coupling, leases NOT promoted to authority. Test coverage: 26 cases in `packages/caws-cli/tests/integration/lite-hooks.test.js` covering A1–A6 plus A1b (v10 nested envelope) and A4b (missing-status defensive fallback). Concrete blocked stderr:

```
BLOCKED: git checkout (branch switch) from the canonical checkout while CAWS worktrees are active.
Active worktree(s) detected (e.g. 'wt-other' in .caws/worktrees.json).
Switch into your worktree before mutating: cd .caws/worktrees/wt-other
Or destroy any worktree that is genuinely abandoned: caws worktree destroy <name>
```

What this does NOT close: dirty-overlap cleanup at worktree boundaries; push-range classification; first-class handoff. Those remain sibling concerns, filed (or to be filed) under their own specs. Entry 19's body remains the canonical narrative of the original failure; this coda records the enforcement response only.
