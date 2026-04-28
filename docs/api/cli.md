# CAWS CLI API Reference

## Overview

The CAWS CLI (`@paths.design/caws-cli`) is the primary interface for interacting with the Coding Agent Workflow System. It provides commands for project initialization, spec management, quality gates, multi-agent coordination, and governance.

## Installation

```bash
# Install globally (recommended)
npm install -g @caws/cli

# Or run directly from the monorepo
cd packages/caws-cli
npm run build
npm run start -- init my-project
```

## Global Options

| Flag | Description |
|------|-------------|
| `--version`, `-V` | Show version number |
| `--help`, `-h` | Show help for any command |
| `--json` | Machine-readable JSON output (sets CAWS_QUIET) |
| `--quiet`, `-q` | Suppress non-essential output (sets CAWS_QUIET) |

---

## 1. Project Setup

### `caws init [project-name]`

Initialize a new project with CAWS.

```
caws init [project-name]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-i, --interactive` | boolean | `true` | Run interactive setup wizard |
| `--non-interactive` | boolean | `false` | Skip interactive prompts (use defaults) |
| `--template <template>` | string | | Use specific project template |
| `--mode <mode>` | string | | CAWS mode (lite, simple, standard, enterprise) |
| `--ide <ides>` | string | | IDE integrations (comma-separated: cursor,claude,vscode,intellij,windsurf,copilot,all,none) |

- `project-name`: Name of the project to create. Use `"."` for the current directory.

```bash
caws init user-auth-service
caws init api-gateway --non-interactive
caws init . --mode lite --ide cursor,claude
```

### `caws scaffold`

Add CAWS components to an existing project.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-f, --force` | boolean | `false` | Overwrite existing files |
| `--minimal` | boolean | `false` | Only essential components |
| `--with-codemods` | boolean | `false` | Include codemod scripts |
| `--with-oidc` | boolean | `false` | Include OIDC trusted publisher setup |
| `--with-quality-gates` | boolean | `false` | Install quality gates package and scripts |
| `--ide <ides>` | string | | IDE integrations (comma-separated) |

```bash
caws scaffold
caws scaffold --force --with-quality-gates
```

### `caws templates [subcommand]`

Discover and manage project templates.

| Option | Type | Description |
|--------|------|-------------|
| `-n, --name <template>` | string | Template name (for info subcommand) |

```bash
caws templates list
caws templates info --name python-api
```

---

## 2. Spec Management

### `caws specs <subcommand>`

Manage multiple CAWS spec files.

#### `caws specs list`

List all available specs.

#### `caws specs create <id>`

Create a new spec (with conflict resolution).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-t, --type <type>` | string | `feature` | Spec type (feature, fix, refactor, chore, docs) |
| `--title <title>` | string | | Spec title |
| `--tier <tier>` | string | `T3` | Risk tier (T1, T2, T3) |
| `--mode <mode>` | string | `development` | Development mode |
| `-f, --force` | boolean | `false` | Override existing specs without confirmation. Also resurrects an id that already exists in `.caws/specs/.archive/` (removes the archived YAML and creates a fresh draft) — see `caws specs archive`. |
| `-i, --interactive` | boolean | `false` | Ask for confirmation on conflicts |

```bash
caws specs create user-auth --type feature --title "User Authentication" --tier T2
```

**Archive collision (CAWSFIX-30):** if `<id>.yaml` already exists under `.caws/specs/.archive/`, create refuses without `--force` and prints the archived path. With `--force`, the archived YAML is removed and any stale registry entry is dropped before the new draft is written. Detection is filesystem-driven, so manually-moved legacy specs (no registry entry) are also caught.

#### `caws specs show <id>`

Show detailed spec information.

#### `caws specs update <id>`

Update spec properties.

| Option | Type | Description |
|--------|------|-------------|
| `-s, --status <status>` | string | Spec status (draft, active, in_progress, completed, closed, archived) |
| `--title <title>` | string | Spec title |
| `--description <desc>` | string | Spec description |

#### `caws specs delete <id>`

Delete a spec.

#### `caws specs close <id>`

Close a completed spec (removes scope enforcement).

#### `caws specs archive <id>`

Archive a closed/completed spec — move its YAML to the canonical `.caws/specs/.archive/` directory and flip its status to `archived`. Idempotent: re-archiving a spec already under `.archive/` is a successful no-op. The directory is filesystem-authoritative — `caws specs list` reports any file under `.archive/` as `archived` regardless of the YAML's literal `status` field, so manually-moved legacy specs are correctly classified.

```bash
caws specs archive my-feature
```

Refuses to archive when:
- The id does not match a registered spec.
- An active worktree references the spec (destroy the worktree first).
- The spec is owned by a different session (CAWSFIX-31 ownership rule applies).

A `spec_archived` event is appended to the event log with `prior_status` and `prior_path`. Path-traversal ids (`../etc/passwd` etc.) are rejected before any filesystem state is touched.

#### `caws specs conflicts`

Check for scope conflicts between specs.

#### `caws specs migrate`

Migrate from legacy working-spec.yaml to feature-specific specs.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-i, --interactive` | boolean | `false` | Interactive feature selection |
| `-f, --features <features>` | string | | Comma-separated list of features to migrate |

#### `caws specs types`

Show available spec types.

---

## 3. Quality & Validation

### `caws validate [spec-file]`

Validate CAWS spec with suggestions. Alias: `verify`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `-i, --interactive` | boolean | `false` | Interactive spec selection when multiple specs exist |
| `-q, --quiet` | boolean | `false` | Suppress suggestions and warnings |
| `--auto-fix` | boolean | `false` | Automatically fix safe validation issues |
| `--dry-run` | boolean | `false` | Preview auto-fixes without applying them |
| `--format <format>` | string | `text` | Output format (text, json) |

```bash
caws validate
caws validate --spec-id user-auth --auto-fix --dry-run
```

### `caws evaluate [spec-file]`

Evaluate work against CAWS quality standards.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `-v, --verbose` | boolean | `false` | Show detailed error information |

### `caws gates run`

Run quality gate checks (v2 pipeline).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--context <context>` | string | `cli` | Execution context (cli, commit, edit) |
| `--spec-id <id>` | string | | Target spec ID |
| `--file <path>` | string | | Single file to check (for edit context) |
| `--json` | boolean | `false` | Output as JSON |
| `--quiet` | boolean | `false` | Minimal output |

```bash
caws gates run
caws gates run --context commit --spec-id user-auth
```

### `caws quality-gates`

Run quality gates. Legacy alias for `caws gates run`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--ci` | boolean | `false` | CI mode - exit with error code if violations found |
| `--json` | boolean | `false` | Output machine-readable JSON to stdout |
| `--context <context>` | string | `commit` | Execution context: commit, push, ci |
| `--all-files` | boolean | `false` | Check all tracked files (equivalent to --context=ci) |
| `--spec-id <id>` | string | | Target spec ID |
| `--quiet` | boolean | `false` | Minimal output |

### `caws verify-acs`

Verify acceptance criteria in specs are backed by test evidence.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Verify only this spec |
| `--run` | boolean | `false` | Actually run tests (default: collect-only) |
| `--runner <runner>` | string | | Force test runner (pytest, jest, vitest, cargo, go) |
| `--format <format>` | string | `text` | Output format (text, json) |

```bash
caws verify-acs --spec-id user-auth --run
```

### `caws test-analysis <subcommand> [options...]`

Statistical analysis for budget prediction.

| Option | Type | Description |
|--------|------|-------------|
| `--spec-id <id>` | string | Feature-specific spec ID |

---

## 4. Development Workflow

### `caws iterate [spec-file]`

Get iterative development guidance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `--current-state <json>` | string | `{}` | Current implementation state as JSON |
| `-v, --verbose` | boolean | `false` | Show detailed error information |

### `caws status`

Show project health overview.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `-s, --spec <path>` | string | | Path to spec file (explicit override) |
| `--visual` | boolean | `false` | Enhanced visual output with progress bars |
| `--json` | boolean | `false` | Output in JSON format for automation |

```bash
caws status
caws status --spec-id user-auth --visual
```

### `caws burnup [spec-file]`

Generate budget burn-up report for scope visibility.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `-v, --verbose` | boolean | `false` | Show detailed error information |

### `caws diagnose`

Run health checks and suggest fixes.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `--fix` | boolean | `false` | Apply automatic fixes |

```bash
caws diagnose
caws diagnose --fix
```

### `caws mode <subcommand>`

Manage CAWS complexity tiers.

#### `caws mode current`

Show current CAWS mode.

#### `caws mode set <mode>`

Set CAWS complexity tier.

```bash
caws mode set standard
```

#### `caws mode compare`

Compare all available tiers.

#### `caws mode recommend`

Get tier recommendation for your project.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--size <size>` | string | `medium` | Project size (small, medium, large) |
| `--team-size <size>` | string | `1` | Team size (number) |
| `--compliance <required>` | string | `false` | Compliance requirements (true/false) |
| `--audit <required>` | string | `false` | Audit requirements (true/false) |
| `--details` | boolean | `false` | Show detailed recommendation |

#### `caws mode details <mode>`

Show detailed information about a specific tier.

---

## 5. Advisory Analysis (Sidecars)

### `caws sidecar <subcommand>`

Advisory analysis tools (drift, gaps, waivers, provenance). These are non-blocking analysis modules.

#### `caws sidecar drift`

Analyze spec drift vs implementation evidence.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Target spec ID |
| `--json` | boolean | `false` | Output as JSON |

#### `caws sidecar gaps`

Diagnose quality gaps preventing phase advancement.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Target spec ID |
| `--json` | boolean | `false` | Output as JSON |

#### `caws sidecar waiver-draft`

Generate pre-filled waiver templates from gate failures.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Target spec ID |
| `--gate <gate>` | string | | Specific gate to draft waiver for |
| `--json` | boolean | `false` | Output as JSON |

#### `caws sidecar provenance`

Summarize work provenance for merge readiness.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Target spec ID |
| `--json` | boolean | `false` | Output as JSON |

---

## 6. Governance

### `caws waivers <subcommand>`

Manage CAWS quality gate waivers.

#### `caws waivers create`

Create a new quality gate waiver. All options are required.

| Option | Type | Description |
|--------|------|-------------|
| `--title <title>` | string | Waiver title (required) |
| `--reason <reason>` | string | Reason (emergency_hotfix, legacy_integration, etc.) (required) |
| `--description <description>` | string | Detailed description (required) |
| `--gates <gates>` | string | Comma-separated list of gates to waive (required) |
| `--expires-at <date>` | string | Expiration date, ISO 8601 (required) |
| `--approved-by <approver>` | string | Approver name (required) |
| `--impact-level <level>` | string | Impact level: low, medium, high, critical (required) |
| `--mitigation-plan <plan>` | string | Risk mitigation plan (required) |
| `-v, --verbose` | boolean | Show detailed error information |

```bash
caws waivers create \
  --title "Skip scope gate for hotfix" \
  --reason emergency_hotfix \
  --description "Production outage requires out-of-scope fix" \
  --gates scope-guard \
  --expires-at 2026-04-15T00:00:00Z \
  --approved-by "tech-lead" \
  --impact-level high \
  --mitigation-plan "Revert after proper fix lands"
```

#### `caws waivers list`

List all waivers.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-v, --verbose` | boolean | `false` | Show detailed error information |

#### `caws waivers show <id>`

Show waiver details.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-v, --verbose` | boolean | `false` | Show detailed error information |

#### `caws waivers revoke <id>`

Revoke a waiver.

| Option | Type | Description |
|--------|------|-------------|
| `--revoked-by <name>` | string | Person revoking the waiver |
| `--reason <reason>` | string | Revocation reason |
| `-v, --verbose` | boolean | Show detailed error information |

### `caws archive <change-id>`

Archive completed change.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `-s, --spec <path>` | string | | Path to spec file (explicit override) |
| `-f, --force` | boolean | `false` | Force archive even if criteria not met |
| `--dry-run` | boolean | `false` | Preview archive without performing it |

```bash
caws archive FEAT-1234
caws archive FEAT-1234 --dry-run
```

---

## 7. Multi-Agent Coordination

### `caws worktree <subcommand>`

Manage git worktrees for agent scope isolation.

#### `caws worktree create <name>`

Create a new isolated worktree.

| Option | Type | Description |
|--------|------|-------------|
| `--scope <patterns>` | string | Sparse checkout patterns (comma-separated, e.g., "src/auth/**") |
| `--base-branch <branch>` | string | Base branch to create from |
| `--spec-id <id>` | string | Associated spec ID |

```bash
caws worktree create auth-work --scope "src/auth/**" --spec-id user-auth
```

#### `caws worktree list`

List all managed worktrees.

#### `caws worktree destroy <name>`

Destroy a worktree.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--delete-branch` | boolean | `false` | Also delete the associated branch |
| `--force` | boolean | `false` | Force removal even if worktree is dirty |

#### `caws worktree merge <name>`

Merge a worktree branch back to base (destroy + merge + cleanup).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--dry-run` | boolean | `false` | Preview conflicts without merging |
| `--message <msg>` | string | | Custom merge commit message |
| `--no-delete-branch` | boolean | | Keep the branch after merging |
| `--takeover` | boolean | `false` | Force takeover of a foreign worktree claim before merging (writes prior_owners audit). See `caws worktree claim`. |

#### `caws worktree bind <spec-id>`

Bind a spec to a worktree (fixes the mutual reference between `worktrees.json:specId` and the spec's `worktree:` field). Auto-detects the worktree from the current directory when run from inside one; otherwise pass `--name`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--name <name>` | string | | Worktree name (auto-detected from cwd if omitted) |
| `--takeover` | boolean | `false` | Force takeover of a foreign worktree claim. Without this, bind refuses to mutate a worktree owned by a different session. |

#### `caws worktree claim <name>`

Inspect or claim worktree session ownership. Without `--takeover`: read-only context surface. Prints the current claim (`<sessionId>:<platform>`, last heartbeat, any `tmp/<sessionId>/` session-log pointers) and exits non-zero when the worktree is owned by a different session. Modifies nothing.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--takeover` | boolean | `false` | Rewrite the owner to the current session id and append the prior owner (with `lastSeen` heartbeat) to a `prior_owners` audit array on the worktree entry. |

```bash
# Read-only inspection — exit 1 on foreign claim, with structured warning
caws worktree claim my-worktree

# Take over a paused agent's worktree (records audit)
caws worktree claim my-worktree --takeover
```

The takeover audit on `worktrees.json` is durable and survives across sessions — postmortems can see which session id owned the worktree and how stale the prior owner's heartbeat was at takeover time.

#### `caws worktree prune`

Clean up stale worktree entries.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--max-age <days>` | string | `30` | Remove entries older than N days |
| `--force` | boolean | `false` | Allow pruning entries owned by other sessions |

#### `caws worktree repair`

Reconcile registry with git and filesystem state.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--dry-run` | boolean | `false` | Report only, do not persist changes |
| `--prune` | boolean | `false` | Remove destroyed, stale-merged, and missing entries |
| `--force` | boolean | `false` | Allow pruning entries owned by other sessions |

### `caws agents <subcommand>`

Inspect the agent registry (`.caws/agents.json`) and any session-log pointers under `tmp/<sessionId>/`. Read-only — write paths belong to the session-log hook (`.claude/hooks/session-log.sh`) and to lifecycle ops in `caws specs` and `caws worktree` (which heartbeat on every successful invocation per CAWSFIX-31/32).

#### `caws agents list`

List active CAWS-registered agent sessions across all platforms (claude-code, cursor, unknown). Each entry is rendered in composite `<sessionId>:<platform>` format with worktree, specId, model, and heartbeat age. Sorted by `lastSeen` descending. TTL-pruned entries (default 30 min) are filtered out automatically by the registry loader.

```bash
caws agents list
```

#### `caws agents show <session-id>`

Show full detail for a single session: first/last seen, ttl, worktree, specId, model, plus any matching session-log directory under `tmp/<sessionId>/` (path, turn count, last-turn timestamp).

```bash
caws agents show 8be65780-72e0-4fc7-a989-4ebac148c18d
```

The `<sessionId>:<platform>` format lets readers trace provenance to platform-specific transcript directories — e.g., `~/.claude/projects/<slug>/<id>.jsonl` for `claude-code` sessions. CAWS does not summarize the transcript; the agent reads it and decides whether to take over.

### `caws parallel <subcommand>`

Orchestrate parallel multi-agent workspaces.

#### `caws parallel setup <plan-file>`

Create worktrees and sessions from a plan file.

| Option | Type | Description |
|--------|------|-------------|
| `--base-branch <branch>` | string | Base branch for all worktrees |

```bash
caws parallel setup .caws/parallel-plan.yaml
```

#### `caws parallel status`

Show all active parallel worktrees and sessions.

#### `caws parallel merge`

Merge all parallel branches back to base.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--strategy <strategy>` | string | `merge` | Merge strategy: merge or squash |
| `--dry-run` | boolean | `false` | Preview merge without executing |
| `--force` | boolean | `false` | Force merge even with detected conflicts |

#### `caws parallel teardown`

Destroy all parallel worktrees.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--delete-branches` | boolean | `false` | Also delete associated branches |
| `--force` | boolean | `false` | Force removal even if worktrees are dirty |

### `caws session <subcommand>`

Manage session lifecycle and capsules for multi-agent coordination.

#### `caws session start`

Start a new tracked session with baseline checkpoint.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--role <role>` | string | `worker` | Agent role (worker, integrator, qa) |
| `--spec-id <id>` | string | | Associated feature spec ID |
| `--scope <patterns>` | string | | Allowed file patterns (comma-separated) |
| `--intent <text>` | string | | What this session intends to accomplish |

```bash
caws session start --role worker --spec-id user-auth --intent "Implement login endpoint"
```

#### `caws session checkpoint`

Record a checkpoint in the current session.

| Option | Type | Description |
|--------|------|-------------|
| `--session-id <id>` | string | Specific session ID (uses latest active if omitted) |
| `--intent <text>` | string | Updated intent description |
| `--paths <paths>` | string | Files changed (comma-separated) |
| `--tests <json>` | string | Test results as JSON array `[{name, status, evidence}]` |
| `--issues <json>` | string | Known issues as JSON array `[{type, description}]` |

#### `caws session end`

End the current session with handoff information.

| Option | Type | Description |
|--------|------|-------------|
| `--session-id <id>` | string | Specific session ID (uses latest active if omitted) |
| `--next-actions <actions>` | string | Handoff actions (pipe-separated) |
| `--risk-notes <notes>` | string | Risk notes (pipe-separated) |

#### `caws session list`

List all sessions.

| Option | Type | Description |
|--------|------|-------------|
| `--status <status>` | string | Filter by status (active, completed) |
| `--limit <n>` | string | Max entries to show |

#### `caws session show [id]`

Show session capsule details. Defaults to latest session.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | boolean | `false` | Output as raw JSON |

#### `caws session briefing`

Show session briefing for hooks/startup.

---

## 8. Tooling

### `caws hooks <subcommand>`

Manage CAWS git hooks for provenance tracking.

#### `caws hooks install`

Install CAWS git hooks.

| Option | Type | Description |
|--------|------|-------------|
| `--no-provenance` | boolean | Skip provenance tracking hooks |
| `--no-validation` | boolean | Skip validation hooks |
| `--no-quality-gates` | boolean | Skip quality gate hooks |
| `--force` | boolean | Overwrite existing hooks |
| `--backup` | boolean | Backup existing hooks before replacing |

```bash
caws hooks install
caws hooks install --force --backup
```

#### `caws hooks remove`

Remove CAWS git hooks.

#### `caws hooks status`

Check git hooks status.

### `caws provenance <subcommand>`

Manage CAWS provenance tracking.

#### `caws provenance init`

Initialize provenance tracking for the project.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `-s, --spec <path>` | string | | Path to spec file (explicit override) |
| `-o, --output <path>` | string | `.caws/provenance` | Output path for provenance files |
| `--cursor-api <url>` | string | | Cursor tracking API endpoint |
| `--cursor-key <key>` | string | | Cursor API key |

#### `caws provenance update`

Add new commit to provenance chain.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-c, --commit <hash>` | string | | Git commit hash (required) |
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `-s, --spec <path>` | string | | Path to spec file (explicit override) |
| `-m, --message <msg>` | string | | Commit message |
| `-a, --author <info>` | string | | Author information |
| `-q, --quiet` | boolean | | Suppress output |
| `-o, --output <path>` | string | `.caws/provenance` | Output path for provenance files |

#### `caws provenance show`

Display current provenance history.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-o, --output <path>` | string | `.caws/provenance` | Output path for provenance files |
| `--format <type>` | string | `text` | Output format: text, json, dashboard |

#### `caws provenance verify`

Validate provenance chain integrity.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-o, --output <path>` | string | `.caws/provenance` | Output path for provenance files |

#### `caws provenance analyze-ai`

Analyze AI-assisted development patterns.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-o, --output <path>` | string | `.caws/provenance` | Output path for provenance files |

### `caws plan <action>`

Generate implementation plans.

| Option | Type | Description |
|--------|------|-------------|
| `--spec-id <id>` | string | Spec ID to generate plan for |
| `--spec <id>` | string | Alias for --spec-id |
| `--output <path>` | string | Output file path for the plan |

```bash
caws plan generate --spec-id user-auth --output plan.md
```

### `caws tutorial [type]`

Interactive guided learning for CAWS.

```bash
caws tutorial
caws tutorial quick-start
```

### `caws workflow <type>`

Get workflow-specific guidance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `--step <number>` | string | `1` | Current step in workflow |
| `--current-state <json>` | string | `{}` | Current implementation state as JSON |
| `-v, --verbose` | boolean | `false` | Show detailed error information |

```bash
caws workflow feature --spec-id user-auth --step 3
```

### `caws tool <tool-id>`

Execute CAWS tools programmatically.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-p, --params <json>` | string | `{}` | Parameters as JSON string |
| `-t, --timeout <ms>` | number | `30000` | Execution timeout in milliseconds |

```bash
caws tool scope-guard --params '{"file":"src/auth.js"}'
```

### `caws quality-monitor <action>`

Monitor code quality impact in real-time.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec-id <id>` | string | | Feature-specific spec ID |
| `--files <files>` | string | | Files affected (comma-separated) |
| `--context <json>` | string | `{}` | Additional context as JSON |
| `-v, --verbose` | boolean | `false` | Show detailed error information |

---

## 9. Meta

### `caws version`

Show version and system information.

```bash
caws version
caws --version
```

### `caws --help`

Show help for any command.

```bash
caws --help
caws validate --help
caws specs create --help
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CAWS_DEBUG` | Enable debug logging |
| `CAWS_NO_COLOR` | Disable colored output |
| `CAWS_QUIET` | Suppress non-essential output (set automatically by `--json`/`--quiet`) |
| `CAWS_CONFIG_PATH` | Custom configuration file path |
| `CAWS_TEMPLATE_PATH` | Custom template directory path |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (invalid arguments, validation failure, etc.) |
| `2` | Project directory already exists |
| `3` | Template not found |
| `4` | Git initialization failed |
