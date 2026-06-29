# Hook Pack: Shared Core + Per-Vendor Adapters

This document records the layout and contracts for CAWS hook packs after
`CAWS-HOOK-PACK-SHARED-CORE-001`: a single shared hook core consumed by thin
per-vendor adapters, replacing the prior per-agent-surface duplication.

## Why

Hook logic was physically duplicated per agent surface
(`templates/hook-packs/claude-code/` and `templates/hook-packs/codex/`). The two
trees differed, for the large majority of files, only in cosmetic ways: the
managed header, the agent name in comments, the harness env-var name
(`CLAUDE_PROJECT_DIR` vs `CODEX_PROJECT_DIR`), and the vendor directory in paths
(`.claude/` vs `.codex/`).

Consequences of the duplication:

- A one-line fix to shared logic had to be applied to every tree, and the
  version-fingerprint propagation guard forced a managed-header bump on *every*
  file in *both* trees — a single logic change touching ~90 files.
- The two surfaces drifted: the codex pack ran many revisions behind the
  claude-code pack, so fixes that landed on one surface silently did not reach
  the other. Stale-copy rot accumulated (e.g. a legacy pre-managed-header
  variant of a hook surviving only in one tree).

The cost scales with the number of supported surfaces, and CAWS intends to
support more (`cursor`, `windsurf`, `vscode`, `idea`, ...). Duplication-per-
surface is the wrong axis.

## Layout

```
templates/hook-packs/
  shared/                     # the shared core — exactly one copy
    dispatch/
      pre_tool_use.sh         # event dispatchers (resolve lib/handlers locally)
      post_tool_use.sh
      session_start.sh
      stop.sh
      pre_compact.sh
    lib/                      # shared input parse / handler runner / state / oracle
      parse-input.sh
      run-handlers.sh
      caws-state.sh
      guard-message.sh
      worktree-claim-oracle.cjs
    <shared hooks>.sh         # scope-guard, worktree-guard, block-dangerous,
                              # the *-check.sh quality plane, etc. — once
    classify_command.py
    session_log_renderer.py

  claude-code/                # vendor adapter — harness-specific ONLY
    settings.json.example     # the wiring Claude Code reads
    CLAUDE.md                 # surface doc
    overrides/                # named override files (see Override set)

  codex/                      # vendor adapter — harness-specific ONLY
    hooks.json                # the wiring Codex reads
    AGENTS.md                 # surface doc
    overrides/                # named override files
```

Installed layout in a consumer repo:

```
.caws/hooks/                  # shared core, installed once
  dispatch/<event>.sh
  lib/*
  <shared hooks>

.claude/                      # claude-code adapter
  settings.json               # wiring -> .caws/hooks/dispatch/<event>.sh
  hooks/<override files>       # only the claude-code overrides, if any

.codex/                       # codex adapter
  hooks.json                  # wiring -> .caws/hooks/dispatch/<event>.sh
  hooks/<override files>       # only the codex overrides
```

## Dependency-injection environment contract

Shared scripts MUST NOT branch on a hardcoded harness name or read a
harness-specific env var directly. Harness specifics reach the shared core
through an injected environment set by the vendor wiring at hook-invocation
time:

| Variable | Set by | Meaning |
|----------|--------|---------|
| `CAWS_PROJECT_DIR` | vendor wiring | absolute repo root (replaces `CLAUDE_PROJECT_DIR` / `CODEX_PROJECT_DIR` reads inside shared scripts) |
| `CAWS_AGENT_SURFACE` | vendor wiring | the surface identity: `claude-code` \| `codex` \| ... |

The shared core derives every other harness-dependent value from
`CAWS_AGENT_SURFACE` via a single resolver in `lib/caws-state.sh` (or a small
dedicated `lib/agent-surface.sh`):

| Derived value | claude-code | codex |
|---------------|-------------|-------|
| vendor dir | `.claude` | `.codex` |
| log dir | `$CAWS_PROJECT_DIR/.claude/logs` | `$CAWS_PROJECT_DIR/.codex/logs` |
| `--platform` flag | `claude-code` | `codex` |
| permission-decision vocab | `ask` supported | `ask` → `deny` (Codex has no PreToolUse `ask`) |

Backward-compatibility: the resolver falls back to the legacy env var
(`CLAUDE_PROJECT_DIR` / `CODEX_PROJECT_DIR`) when `CAWS_PROJECT_DIR` is unset, so
a not-yet-migrated wiring keeps working during the transition.

## Dispatcher resolution

Vendor wiring points harness commands at the shared
`.caws/hooks/dispatch/<event>.sh`, passing the injected env. Older installs
used `<vendor>/hooks/caws_dispatch/<event>.sh`; current Codex wiring must not
materialize that per-vendor dispatcher copy.

claude-code `settings.json` (env-expansion form):

```jsonc
{ "type": "command",
  "command": "CAWS_AGENT_SURFACE=claude-code CAWS_PROJECT_DIR=\"$CLAUDE_PROJECT_DIR\" \"$CLAUDE_PROJECT_DIR\"/.caws/hooks/dispatch/pre_tool_use.sh" }
```

codex `hooks.json` (runtime-root form):

```jsonc
{ "type": "command",
  "command": "REPO_ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)\"; CAWS_AGENT_SURFACE=codex CAWS_PROJECT_DIR=\"$REPO_ROOT\" CODEX_PROJECT_DIR=\"$REPO_ROOT\" \"$REPO_ROOT/.caws/hooks/dispatch/pre_tool_use.sh\"" }
```

The shared dispatcher resolves its lib/handlers from its own location
(`SCRIPT_DIR` → `.caws/hooks/`), so sibling sourcing works with no per-vendor
lib copy and no extra env var for discovery. (`CAWS_PROJECT_DIR` carries the
repo root for state paths; it is not used to find lib.)

The dispatcher keeps its current contract unchanged: read stdin once, sanitize
via `lib/parse-input.sh`, run the ordered `HANDLERS` chain via
`lib/run-handlers.sh`, aggregate exit codes (first `2` short-circuits and
blocks; non-2 non-zero are warnings; the max non-2 is returned), and fail open
if the dispatcher itself errors before any handler runs.

## Override set

A file belongs in a vendor `overrides/` directory ONLY when its executable
behavior genuinely differs by harness — not when it differs cosmetically. The
genuine-divergence set (from the codex/claude-code comparison) is:

- `lib/emit.sh` — Codex emits the deny-form permission decision (no PreToolUse
  `ask`) and carries `emit_updated_input()` for `apply_patch` rewriting.
- `lib/parse-input.sh` — Codex normalizes `apply_patch` → `Edit`/`Write` and
  exports `HOOK_FILE_PATHS` / `HOOK_ORIGINAL_TOOL_NAME`.
- `lib/run-handlers.sh` — Codex has an extra `deny` exit-code arm.
- `session_log_renderer.py` — Codex transcript JSONL has event types Claude's
  renderer does not (`response_item`, `write_stdin`, `exec_command`, ...).
- `classify_command.py` — minor codex-side refactor + state path (review whether
  this is genuine divergence or can be folded into the shared file via the
  surface resolver; prefer folding).
- `dispatch/post_tool_use.sh` HANDLERS — codex disables `quality-check.sh`;
  model this as a per-surface HANDLERS list, not a forked vendor dispatcher.

Resolution rule at install time: for each shared file, the vendor adapter MAY
provide an override; if present, the override is installed in place of the
shared file (or alongside it, depending on whether it is a `lib/` file the
shared dispatcher sources). The override carries its own managed header and is
fingerprinted as part of the vendor adapter, not the shared core.

The goal is to shrink the override set over time by pushing differences into the
surface resolver (injected context) wherever the difference is mechanical.

## Drift detection and the propagation guard

- The shared core is a managed pack with its own identity (`hook_pack: shared`)
  and version. A change to a shared file requires exactly one version bump (the
  shared core), not a parallel edit + header bump in a second tree.
- Each vendor adapter is a managed pack with its own identity and version,
  covering only its wiring + overrides + surface doc.
- The fingerprint test hashes three trees independently: `shared`, `claude-code`
  adapter, `codex` adapter. A byte change in any tree fails until that tree's
  version is bumped and a history entry appended — same propagation guarantee as
  before, but a shared-logic change touches one tree.

## Install behavior (preserved invariants)

- `caws init --agent-surface <surface>` installs the shared core under
  `.caws/hooks/` plus the requested vendor adapter under `.<surface>/`.
- Idempotent: a byte-identical re-run reports unchanged and writes nothing.
- Non-destructive: the settings.json / hooks.json merge preserves user-authored
  content; managed drift refuses by default (adopt/overwrite to override).
- Fail-open dispatcher: a parser crash or missing lib in the shared core exits 0
  rather than blocking the tool call.
- The hooks.json placeholder substitution (absolute dispatcher command paths)
  continues to run at install for the codex wiring; the substituted command now
  points at `.caws/hooks/dispatch/<event>.sh`.

## Consumer migration

A consumer on the old per-vendor layout (full hook tree under `.claude/hooks/`
and/or `.codex/hooks/`) migrates by re-running `caws init --agent-surface
<surface>`:

- The shared core is written to `.caws/hooks/`.
- The vendor wiring is repointed to the shared dispatcher (non-destructive
  merge; the CAWS-owned hook entries are identified and updated, user entries
  preserved).
- The old per-vendor shared hook files become unmanaged residue. Init reports
  them; a follow-up cleanup (or an explicit `--prune-legacy` affordance) removes
  the now-superseded `<vendor>/hooks/<shared file>` copies. Migration never
  deletes user content silently; it reports and refuses ambiguous cases with a
  typed diagnostic.

The agent-surface identity is what a maintainer/agent tailors when a harness API
changes: the vendor adapter (wiring + overrides) is the open-for-extension
surface, while the shared core stays closed for modification per surface.
