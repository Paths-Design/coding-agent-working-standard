# CLAUDE.md

This project uses CAWS (Coding Agent Working Standard) for quality-assured AI-assisted development. CAWS v11.1+ ships a small set of governed commands; the per-project doctrine below tracks that surface.

## Build & Test

```bash
# Install dependencies
npm install

# Run tests
npm test

# Lint
npm run lint

# Type check (if TypeScript)
npm run typecheck

# Project-wide drift detection + schema validation
caws doctor

# Per-spec quality gates (modes set in .caws/policy.yaml)
caws gates run --spec <SPEC-ID> --context commit
```

## CAWS Workflow

v11.1+ ships twelve governed command groups:

```
init  doctor  status  scope  claim  gates  evidence  events  waiver  specs  worktree  agents
```

The multi-agent `agents` surface ships in v11.1 for read-only lease inspection (`agents list/show`) plus hook-facing registration/heartbeat/stop/prune operations. Ownership authority still lives in `claim` and `worktree`.

### Per-feature workflow

```bash
# 1. Check project health and binding state (read-only)
caws status

# 2. Create a feature spec (v11 takes --mode from a closed enum, not --type)
caws specs create FEAT-001 --title "description" --mode feature --risk-tier 3

# 3. Edit .caws/specs/FEAT-001.yaml to populate scope.in / scope.out / invariants /
#    acceptance / non_functional / contracts. Commit it before creating the worktree —
#    `caws worktree create` snapshots the repo at creation time; uncommitted specs are not copied.
git add .caws/specs/FEAT-001.yaml && git commit -m "chore(caws): create FEAT-001 spec"

# 4. Create the worktree bound to your spec (atomic bidirectional binding)
caws worktree create wt-feat-001 --spec FEAT-001
cd .caws/worktrees/wt-feat-001

# 5. Verify your binding is authoritative (vs the union-mode fallback)
caws scope show <some-path-you-plan-to-edit>

# 6. Run gates whenever you want a fresh evaluation
caws gates run --spec FEAT-001 --context commit
```

### Removed commands (do not use)

The following v10 commands were removed in v11.0 and are not coming back:

`scaffold`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `archive` (the command — `caws specs archive` is the replacement), `provenance`, `sidecar`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `templates`, legacy `hooks install`.

Their behaviors fold into `doctor`, `gates run`, `status`, `specs`, and `evidence record`. The hash-chained `.caws/events.jsonl` is the audit surface; users wire their own hooks against `caws gates run`.

If you see a `caws validate` or `caws iterate` invocation in any project doctrine or hook, it's stale — the surface no longer accepts those names.

### v11 command reference

- `caws init [--agent-surface <claude-code|cursor|windsurf|none>]` — bootstrap canonical `.caws/`; install a hook pack. Idempotent. Refuses to overwrite legacy v10 single-spec layout.
- `caws doctor` — project-wide drift detection. Exits 0 (clean) / 1 (findings) / 2 (composition failure).
- `caws status` — read-only dashboard. Never mutates.
- `caws scope show <path>` / `caws scope check <path>` — explain (always exit 0) or enforce (exit 0 admit / 1 reject) the scope decision for one path.
- `caws claim [--takeover]` — surface or take worktree ownership. `--takeover` writes a `prior_owners` audit on the registry entry.
- `caws gates run --spec <id> --context commit` — run policy-driven quality gates. Appends one `gate_evaluated` event per declared gate. No `--quiet`, no `--json`; capture combined output and inspect exit code.
- `caws evidence record --type <test|gate|ac> --spec <id> --data <json>` — append a typed evidence event.
- `caws events migrate | rotate | verify-archive` — maintain `.caws/events.jsonl`.
- `caws waiver create | list | show | revoke` — manage waiver records (singular `waiver`, not plural).
- `caws specs create | list | show | close | archive` — full spec lifecycle. `create <id> --title "..." --mode <feature|refactor|fix|doc|chore> --risk-tier <1|2|3>`. There is no `--type` flag.
- `caws worktree create | list | bind | destroy | merge | migrate-registry | repair-sparse` — worktree lifecycle. `create <name> --spec <id>` writes the bidirectional worktree↔spec binding and emits the `worktree_created` + `worktree_bound` events. `destroy <name>` is non-forceful and does NOT auto-delete the branch (run `git branch -d <branch>` manually).
- `caws agents register | heartbeat | stop | list | show | prune` — agent liveness substrate. `list/show` are read-only; ownership decisions still use `claim`/`worktree`.

Run `caws <group> --help` for full options.

### Specs

Specs live exclusively at `.caws/specs/<id>.yaml`. **There is no project-level working spec** — every spec is per-feature. v11 spec shape:

- `id` (matches `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$`)
- `title` (≤200 chars)
- `risk_tier` (integer 1|2|3 — string forms like `"T3"` are rejected)
- `mode` (one of `feature|refactor|fix|doc|chore` — v10 `development` is rejected)
- `lifecycle_state` (one of `draft|active|closed|archived` — replaces v10 `status:`)
- `blast_radius.modules` (non-empty string array)
- `scope.in` (non-empty array; `scope.out` cannot contain glob patterns — directory paths only)
- `invariants` (non-empty array of strings)
- `acceptance` (array of `{id: ^A\d+$, given, when, then}` — v10 `acceptance_criteria:` is rejected)
- `non_functional` (object; only `reliability` and `performance` admitted)
- `contracts` (array of `{name, type: api|schema|contract-test|behavior, path?, description?}`; tier-1/2 require non-empty)

v10 fields **removed** from the schema: `type:`, `description:`, `notes:`, `non_goals:`, `bounded_claim:`, `dependencies:`, `status_rationale:`, `change_budget:`, `created:`. Migrate any v10 spec via the v10→v11 migration recipe (see `docs/migration-v10-to-v11.md` if you're on the upstream caws repo).

Recommended operating rule: one active feature spec, one active worktree. If a task has a worktree, record that ownership in the spec YAML with `worktree: <name>`.

### Scope and Worktree Binding

The scope guard enforces file edit boundaries based on your spec's `scope.in` and `scope.out` patterns. **How it enforces depends on whether your worktree is bound to a spec:**

- **Authoritative mode** (worktree bound to a spec): Only your spec's scope patterns are checked. Other agents' specs cannot block your edits. This is the correct state.
- **Union mode** (no binding): The guard checks ALL active specs. Any `scope.out` from any spec can block you, even unrelated ones. This is the common source of "why is spec X blocking me?" confusion.

**The mutual binding** requires both sides:
1. The worktree registry (`.caws/worktrees.json`) must have `spec_id` (v11) or `specId` (v10 carryover) pointing to your spec
2. Your spec (`.caws/specs/<id>.yaml`) must have `worktree: <name>` pointing to your worktree

`caws worktree create <name> --spec <id>` writes both sides atomically. If either side gets out of sync, repair with `caws worktree bind <name> --spec <id>`.

**Recovery checklist** (when the scope guard blocks you unexpectedly):

1. Run `caws scope show <some-path-you-plan-to-edit>` — the positional `<path>` arg is required in v11. The output reports whether your binding is authoritative or union mode and surfaces the responsible spec.
2. If union mode: bind your spec with `caws worktree bind <name> --spec <id>`
3. If authoritative but still blocked: the file is genuinely outside your spec's scope. Update your spec's `scope.in` if the file should be in scope, or request a waiver via `caws waiver create`
4. Do NOT modify another spec's `scope.out` to unblock yourself — that defeats the isolation

### Multi-Agent Coordination

Each session gets registered in `.caws/agents.json` automatically (via the session-log hook and on every CAWS lifecycle CLI invocation). Per-session lease files land in `.caws/leases/` — operational cache only, never authority. Worktree session ownership is tracked in `.caws/worktrees.json:owner` as a session id.

**Foreign-claim soft-block.** `caws worktree bind`, `merge`, and `claim` refuse to mutate a worktree owned by a different session id without explicit `--takeover`. The refusal prints a structured warning naming the claimer as `<sessionId>:<platform>`, the heartbeat age, and any matching `tmp/<sessionId>/` session-log path so you can read context before deciding.

**Decision-gating uses session-id equality only.** TTL pruning of `agents.json` is registry hygiene; it does NOT authorize takeover. A stale heartbeat doesn't mean the prior session is dead — it may be paused. Stale lease is evidence, never authority.

`--takeover` writes a durable `prior_owners` audit on the worktree entry (sessionId, platform, lastSeen-at-takeover, takenOver_at) so handoffs are traceable in `worktrees.json`, not just in agent memory.

### Spec lifecycle

Use `caws specs close <id>` to close an active spec, then `caws specs archive <id>` to move the YAML file to `.caws/specs/.archive/`. The directory is filesystem-authoritative — `caws specs list` reports any file under `.archive/` as `lifecycle_state: archived` regardless of the YAML literal. Manually-moved legacy specs (no registry entry) are correctly classified.

If you try `caws specs create <id>` for an id that already exists in `.archive/`, the command refuses. Resurrect old ids only when you genuinely intend a continuation, and via spec authoring (not by deleting the archive entry).

> **Budget note**: `change_budget:` is no longer accepted as a top-level spec field in v11.
> Budgets derive from `.caws/policy.yaml` `risk_tiers`. Adjust thresholds via `policy.yaml`,
> not via spec edits.

### Quality Gates

v11 declares gates in `.caws/policy.yaml` as a flat object, each with a `mode` (`block | warn | skip`). The five admissible gate names:

| Gate | Typical mode | Purpose |
|------|--------------|---------|
| `budget_limit` | block | Enforce change_budget limits (max_files, max_loc) per `risk_tiers` |
| `spec_completeness` | block | Refuse load on schema-invalid specs |
| `scope_boundary` | block | Refuse edits outside the bound spec's `scope.in` |
| `god_object` | warn | Flag large/responsibility-overloaded modules (observability) |
| `todo_detection` | warn | Flag TODOs/placeholders/dangling promises in committed code |

Risk tier governs change-budget thresholds (max_files / max_loc) but does not directly set per-gate enforcement levels — the gate `mode` is global. v10's "T1 90% coverage / T2 80% / T3 70%" table is gone. Coverage and mutation gates were not ported into v11's gate vocabulary; if you need them, run them outside CAWS as part of CI.

Run `caws gates run --spec <id> --context commit` to evaluate all declared gates. Each evaluation appends a `gate_evaluated` event to `.caws/events.jsonl`.

### Key Rules

1. **Stay in scope** — only edit files admitted by `scope.in`, never touch `scope.out`
2. **Respect change budgets** — stay within `max_files` and `max_loc` limits derived from `risk_tier`
3. **No shadow files** — edit in place, never create `*-enhanced.*`, `*-new.*`, `*-v2.*`, `*-final.*` copies
4. **Tests first** — write failing tests before implementation
5. **Deterministic code** — inject time, random, and UUID generators for testability
6. **No fake implementations** — no placeholder stubs, no `TODO` in committed code, no in-memory arrays pretending to be persistence, no hardcoded mock responses
7. **Prove claims** — never assert "production-ready", "complete", or "battle-tested" without passing gates. Provide evidence, not assertions.
8. **No marketing language in docs** — avoid "revolutionary", "cutting-edge", "state-of-the-art", "enterprise-grade"
9. **Ask first for risky changes** — changes touching >10 files, >300 LOC, crossing package boundaries, or affecting security/infrastructure require discussion first
10. **Conventional commits** — use `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:` prefixes

### Waivers

v11 waivers live at `.caws/waivers/<WV-NNNN>.yaml`, one file per waiver. (The v10 aggregate `active-waivers.yaml` format is rejected.)

Required fields: `id`, `title` (≥5 chars), `status` (`active|revoked`), `gates` (non-empty array of names from `policy.yaml` gates), `reason`, `approved_by`, `created_at` (ISO datetime with timezone), `expires_at` (same). Revoked waivers also carry a `revocation: {revoked_at, revoked_by?, reason?}` object.

Author via:

```bash
caws waiver create WV-1234 \
  --title "RZPACK-1 budget extension" \
  --gate budget_limit \
  --reason "..." \
  --approved-by "@you" \
  --expires-at 2026-06-30T00:00:00Z
```

Repeat `--gate` for multiple gates. The CLI validates against the kernel before writing.

## Project Structure

```
.caws/
  specs/              # Per-feature specs (canonical; the only spec location)
  specs/.archive/     # Archived specs (filesystem-authoritative)
  policy.yaml         # Gates + risk_tier change budgets
  waivers/            # Per-id waiver files
  agents.json         # Session registry (gitignored runtime cache)
  leases/             # Per-session liveness leases (gitignored)
  worktrees.json      # Worktree registry (gitignored runtime state)
  events.jsonl        # Hash-chained audit log (gitignored)
  state/              # Runtime working state (gitignored, auto-managed)
```

> **Runtime state**: `.caws/state/`, `.caws/agents.json`, `.caws/leases/`,
> `.caws/worktrees.json`, and `.caws/events.jsonl` are operational cache
> written by CAWS commands. They are gitignored by default and should
> stay that way; the canonical doctrine lives in `.caws/specs/`,
> `.caws/policy.yaml`, and `.caws/waivers/` which ARE tracked.

## Hooks

This project has Claude Code hooks configured in `.claude/settings.json`:

- **PreToolUse**: Blocks dangerous commands, scans for secrets, enforces scope, surfaces parallel-agent presence (via `agent-heartbeat.sh`).
- **PostToolUse**: Optional quality and naming checks.
- **SessionStart**: Registers this session into the agent-liveness substrate (`agent-register.sh`) + status briefing.
- **Stop**: Marks the lease as cleanly stopped (`agent-stop.sh`) + plan-transcript finalize.

See `.claude/hooks/CLAUDE.md` for the canonical pack lineage map (which hook covers which incident class) and `.claude/README.md` for project-specific extension wiring.

### Dangerous-command latch

`block-dangerous.sh` is a human-review boundary, not a syntax check. When it returns `block` or `ask`:

1. **Stop.** Do not rephrase, wrap, reorder, or alias the command. Do not retry with `command git ...`, `env ... git ...`, `bash -lc '...'`, or `git --bare init`. The hook recognizes those variants and will block them too.
2. The hook writes a per-session latch at `.claude/hooks/state/danger-latch-<session>.json`. **Every subsequent Bash tool call in this session will block** until a human clears the latch.
3. To clear, ask the user to run:
   ```bash
   bash .claude/hooks/reset-danger-latch.sh --current --reason "<why this is safe>"
   ```
4. If you need a fresh git repo for legitimate test setup, ask the user to do it in their terminal (via `! <command>` in Claude Code) rather than searching for a phrasing that bypasses the matcher.
