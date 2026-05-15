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
