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
