# Hook packs: the edit-time advisory quality plane

CAWS distributes guards, dispatchers and session renderers through a user-level runtime in `~/.caws`. Configure the native harness once and migrate existing project registrations once; subsequent runtime updates serve every adopted project. See [Machine adapter installation](#machine-adapter-installation). Legacy project packs remain supported during migration. The first part of this guide documents the **advisory quality plane** added by `QG-HOOKS-EXTRACT-001`.

These four hooks are *advisory* edit-time signals. They implement the load-bearing edit-time quality checks (`god_object`, `todo_detection`, functional-duplication, change-budget) so the agent gets feedback *in the loop where it is editing*, instead of only when an operator later runs `caws gates run`.

## The doctrine boundary (option C)

These hooks are an **edit-time advisory plane**, not a replacement for `caws gates run`:

- `caws gates run` is the **governed policy-gate runner**. It reads `.caws/policy.yaml`, evaluates gates in `block`/`warn`/`skip` mode, and appends a `gate_evaluated` event per gate. It is the canonical disposition surface.
- The four hooks below are **installed hook-pack utilities** that the repo tunes locally (via env vars). They never write events, never block a gate, and have **no runtime coupling** to an external quality package. They implement the edit-time checks in self-contained bash.

This is deliberate: `caws gates run` owns governed policy/event disposition, while the edit-time hooks start from the governance floor and are shaped per-repo. Installing the pack does not change `caws gates run` behavior in any way.

## The four hooks

All four are registered as `PostToolUse` handlers in `dispatch/post_tool_use.sh`. They skip generated/vendored paths (`node_modules`, `dist`, `build`, `coverage`, `.next`, `out`, `vendor`) and minified/lock artifacts at the top of the script — they only act on real source files the agent authored.

### `god-object-check.sh` — large-module advisory

- **Trigger:** Write or Edit.
- **Mode:** advisory (always exits 0; never blocks).
- **What it flags:** a touched file whose source-lines-of-code (blank and whole-line `//`/`#`/`*` comments stripped) meets or exceeds the threshold.
- **Threshold env:** `CAWS_GOD_OBJECT_LOC` (default `2000`).
- **Policy counterpart:** the `god_object` gate.
- **Output:** a `hookSpecificOutput.additionalContext` warning naming the file, its SLOC, and the threshold.

### `shortcut-language-check.sh` — placeholder/stub advisory (progressive)

- **Trigger:** Write or Edit, on NON-test source (`*.test.*`, `*.spec.*`, `tests/`, `__tests__/`, and markdown/docs are exempt — placeholder language there is routine).
- **Mode:** **progressive** — the only one of the four that can block. It escalates through the shared guard-strikes mechanism: **strike 1 → warn**, **strike 2 → ask** (permission prompt), **strike 3 → block**. Strikes are per-session.
- **What it flags:** incomplete-work markers (`TODO`, `FIXME`, `XXX`, `HACK`, `TBD`), placeholder/not-implemented phrases (`not implemented`, `implement later`, `coming soon`, `placeholder`), and explicit `throw new Error("not implemented")` stub shapes.
- **Policy counterpart:** the `todo_detection` gate. The hook ships the high-signal subset of that vocabulary to stay single-file and fast.
- **Doctrine:** enforces the CAWS key rule "No fake implementations — no placeholder stubs, no TODO in committed code."

### `duplicate-export-check.sh` — shadow-export advisory

- **Trigger:** Write only (new-file creation — the common shadow-export incident). An Edit that adds a colliding export to an existing file is a documented v1 limitation.
- **Mode:** advisory (always exits 0).
- **What it flags:** a newly-written JS/TS file that exports a symbol whose **exact** name already exists as an export elsewhere in the enclosing package's `src` tree. Generic names are allowlisted (`main`, `init`, `setup`, `run`, `handle`, `render`, `index`, `default`). Matching is exact, not heuristic similarity.
- **Lookup:** bounded to the enclosing `packages/<pkg>/src` (or repo-root `src`); uses ripgrep when available, `grep -r` fallback; never scans `node_modules`.
- **Policy counterpart:** the functional-duplication name/shape collision check.
- **Doctrine:** the symbol-level companion to `naming-check.sh`'s filename-level "No shadow files" enforcement.

### `loc-delta-check.sh` — oversized-edit advisory

- **Trigger:** Edit only (the "grow an existing file" case).
- **Mode:** advisory (always exits 0; never blocks).
- **What it flags:** a single Edit whose added-line delta (computed from the `new_string` vs `old_string` payload newline counts) exceeds the threshold. If the payload lacks `old_string`/`new_string`, the hook exits 0 silently — it never false-positives from missing data.
- **Threshold env:** `CAWS_LOC_DELTA_WARN_THRESHOLD` (default `300`).
- **Doctrine:** the CAWS key rule "Ask first for risky changes — changes ... >300 LOC ... require discussion first."

## Tuning

Per-repo thresholds are environment variables read at hook runtime, so they can be set in `.claude/settings.json`'s `env` block (or the shell that launches the agent) without editing the managed hook scripts:

```jsonc
{
  "env": {
    "CAWS_GOD_OBJECT_LOC": "2500",
    "CAWS_LOC_DELTA_WARN_THRESHOLD": "400"
  }
}
```

System hook scripts live in verified snapshots and are updated once with `caws init adapters install`. Tune thresholds through environment variables; preserve custom behavior through explicit extensions or overrides. Legacy project copies still use the pack retrofit commands until their native registration is migrated.

System Codex registration lives in `~/.codex/hooks.json`. Native hook trust must be reviewed when definitions change. Legacy project hooks remain additive until retired; their presence is not evidence that the global runtime is executing for that project.

## Lineage

Each hook traces to a `docs/failure-lineage.md` entry documenting the gap it closes: `god-object-check.sh` → Entry 28, `shortcut-language-check.sh` → Entry 29, `duplicate-export-check.sh` → Entry 30, `loc-delta-check.sh` → Entry 31. The per-pack lineage map lives in `.claude/hooks/CLAUDE.md` after install (sourced from `packages/caws-cli/templates/hook-packs/claude-code/CLAUDE.md`).


## Machine adapter installation

Install and configure CAWS once at user scope:

```bash
caws init adapters install --plan --json
caws init adapters install
caws init adapters configure --agent-surface codex --plan
caws init adapters configure --agent-surface codex
```

`CAWS_HOME` selects an absolute machine home (default `~/.caws`). The snapshot
contains stock guards, helpers, dispatchers and session renderers, plus harness
adapter libraries. Configure writes `~/.codex/hooks.json` for Codex. Review its
native trust and restart the harness before claiming activation. Claude Code and
Qwen Code have JSON registration helpers, but their native execution must be
verified by an agent in that harness; library installation alone proves no parity.

If the user hook file is managed through a symlink, inspect its actual target and
pass `configure --native-config-target /absolute/resolved/target`. CAWS preserves
the link, backs up and updates that exact target inside the user home, and records
the selection. A subsequent redirect is refused. Without this explicit selection,
symlinked configuration is refused. If the target belongs to a configuration Git
repository, its source change still needs the normal review and commit there.

Retire old project registrations once from a central directory:

```bash
caws init adapters migrate --agent-surface codex --projects-root ~/Desktop/Projects --plan --json
caws init adapters migrate --agent-surface codex --projects-root ~/Desktop/Projects
```

This examines direct Git project children. Each project is an independent
transaction: successful migrations are retained while review-required projects
are reported. It does not migrate legacy governance, claim worktrees or modify
project source hooks. Run without `--projects-root` to migrate the current canonical
checkout. Plans contain complete proposed configuration bytes. Apply requires the
system registration to exist first. Native project and user hooks are additive;
verify one effective CAWS transport per event after migration.

During rollout the explicit system transport defers to an existing project CAWS
registration, preventing duplicate handler execution. Unmigrated projects keep
their old behavior until reviewed; doctor continues to identify their legacy
registration. Cached adapter-only entries remain functional across this transition.

New projects subsequently use normal `caws init --agent-surface codex` and inherit
the configured system runtime without receiving local hook copies. Future updates
for every migrated project need only:

```bash
caws init adapters install
```

Stock handler order comes from the new snapshot on each invocation. Projects do
not pin a pack version or a full stock handler list. Explicit customizations live
in machine `state/projects/<canonical-path-hash>.json`. The migration preserves
unrelated hooks, backs up exact native bytes under `state/adoption-backups/`, and
leaves old executable copies intact. It refuses unknown shell wrappers, reordered
stock guards and unclassified helper growth rather than assuming they are stock.

For a project requiring reconciliation, inspect its actual custom behavior and
pass a reviewed surface policy with `--from <file>` (single project only):

```json
{
  "disabled": {},
  "extensions": {
    "pre_tool_use": [{ "handler": "custom-guard.sh", "before": "scope-guard.sh" }]
  },
  "handlers": { "custom-guard.sh": ".caws/hooks/custom-guard.sh" },
  "libraries": {}
}
```

`--from` explicitly defines the behavior retained when retiring the old native
transport, including any custom wrapper behavior. Do not supply an empty policy
without reviewing what it retires. Extensions are inserted before named stock
handlers; `null` appends. An absent anchor fails visibly. `disabled` names deliberate
stock exclusions by event. Handler/library paths are canonical-project-relative
and confined; handler files must be executable. These overrides stay locally
maintained. Adapter libraries resolved through `caws_source_lib` can be declared
in `libraries`; bootstrap `agent-surface.sh` and `runtime-paths.sh` are prohibited.
Directly sourced helper growth requires a reviewed handler override or an upstream
fix. User adapter libraries live in `~/.caws/surfaces/<surface>/lib/`; declared
project adapters win, then user overrides, then packaged surface/shared code.

Harness agents maintain their native adapters at this machine layer. Codex's
`session-transcript.py` turns visible rollout response items into the shared
renderer's events. Shared rendering and guard fixes ship once. See the
[adapter authoring and proof contract](../architecture/hook-pack-shared-core.md#system-runtime)
for required native evidence and the separation from fixture tests.

Doctor reports effective runtime integrity and residual local registration rather
than asking each system project to refresh copied packs. Filesystem configuration
is not evidence that an already-running harness switched snapshots or trusted a
new native registration. Verify fresh SessionStart, denied-write and Stop events.

`caws init adapters rollback --plan` previews the previous verified snapshot;
`rollback` applies it. The pointer swap is atomic and the bootstrap stays stable.
Rolling back to the earlier adapter-only generation also restores that generation's
project-policy requirements, so inspect compatibility before rollback. Never edit
snapshot bytes. An interrupted install leaves `state/adapter-install.lock`; a
configuration transaction leaves `state/system-configuration.lock` plus exact
before/after backups. Inspect the owning process and partial bytes before removing
a stale lock and retrying. Rollback refuses to overwrite a concurrent edit.

The old `adapters adopt` operation remains available for adapter-only project
policies. It does not globalize stock guards/renderers; prefer configure/migrate.

Reprieve grants now belong to the machine session store, across adopted projects.
`--surface` identifies the target harness for operator provenance and legacy
lookup; it does not partition new grants into vendor directories. Granting still
requires a human shell, a target session, named handlers, reason, approver and
expiry. Human `show`/`list` calls without a surface hint discover unambiguous
legacy records across vendor directories. Conflicting copies for the same
session require `--surface` for inspection; a global record always wins over
them. `show`/`list` never create directories, and `revoke` retains an inactive
record to suppress all legacy copies, including conflicting copies. `--json`
emits one JSON value even when no earlier grant exists. Old, unadopted dispatchers
may not read new machine records. Verify a grant through the actual target
dispatcher before claiming it took effect.
