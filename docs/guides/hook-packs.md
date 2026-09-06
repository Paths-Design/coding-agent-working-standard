# Hook packs: the edit-time advisory quality plane

CAWS ships Claude Code and Codex hook packs (installed via `caws init --agent-surface claude-code` or `caws init --agent-surface codex`) that interpose governance between the agent and its edit/write/Bash tools. Most of each pack is hard governance — scope guards, worktree guards, dangerous-command blocking. This guide documents one slice of it: the **advisory quality plane** added by `QG-HOOKS-EXTRACT-001`.

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

The hook scripts themselves are **managed pack files** — they carry CAWS managed-hook metadata and are updated by `caws init --agent-surface <claude-code|codex>`, not hand-edited. Tune behavior through env, not by editing the scripts.

Codex installs project-local `.codex/hooks.json` plus `.codex/hooks/*`. Codex loads project hooks only after the project layer is trusted, and new or changed non-managed hook definitions must be reviewed through `/hooks`.

## Lineage

Each hook traces to a `docs/failure-lineage.md` entry documenting the gap it closes: `god-object-check.sh` → Entry 28, `shortcut-language-check.sh` → Entry 29, `duplicate-export-check.sh` → Entry 30, `loc-delta-check.sh` → Entry 31. The per-pack lineage map lives in `.claude/hooks/CLAUDE.md` after install (sourced from `packages/caws-cli/templates/hook-packs/claude-code/CLAUDE.md`).


## Machine adapter installation

For machine-wide adapter updates, install the runtime once:

```bash
caws init adapters install --plan --json
caws init adapters install
```

`CAWS_HOME` selects an absolute machine home (default `~/.caws`). The plan lists
the runtime digest and installed paths. Runtime snapshots are integrity checked;
manual changes there are refused on update. Intentional user adapter overrides
belong in `surfaces/<surface>/lib/` under the machine home. They are executable
customizations and are outside the snapshot's digest. Project overrides declared
in policy take precedence, followed by user overrides, the surface snapshot,
and the shared snapshot. Symlinked override files are refused.

From each canonical project root, preview and apply its one-time adoption:

```bash
caws init adapters adopt --agent-surface codex --plan
caws init adapters adopt --agent-surface codex
```

Use `claude-code` or `qwen-code` for the other supported automatic registrations.
The plan displays complete proposed policy and native configuration bytes. It
preserves literal handler order and unrelated native hooks. The applied migration
backs up exact old bytes in the machine home's `state/adoption-backups/` and
rolls back its writes if application fails. It never sources shell while planning.
Unknown dispatcher logic, conflicting roots, duplicate CAWS wiring, and
unresolved library growth require reconciliation before adoption.

For reviewed custom dispatch logic, `--from <surface-policy.json>` accepts:

```json
{
  "events": {
    "pre_tool_use": {
      "hooks_dir": ".caws/hooks",
      "handlers": ["worktree-write-guard.sh", "custom-guard.sh"]
    }
  },
  "libraries": {}
}
```

Include every existing lifecycle registration; an omitted event with existing
CAWS wiring is refused. Paths must be project-relative and executable handlers
must exist. A policy can explicitly retain a local library through a
`libraries` entry such as `"emit.sh": ".codex/hooks/lib/emit.sh"`. That library
then remains locally maintained. Bootstrap-library changes need reconciliation.

After applying, restart the harness and review changed hook definitions. For
Codex, global and project hooks are additive: adoption checks for other CAWS
registrations and refuses ambiguous duplicates. Native trust and actual hook
execution must be verified in a fresh invocation. Installation and a passing
shell replay do not establish that an already-running harness has switched.

Update all adopted projects with another `caws init adapters install`. To
restore the prior snapshot:

```bash
caws init adapters rollback --plan
caws init adapters rollback
```

An interrupted install leaves a visible `state/adapter-install.lock`; inspect it
and the active pointer before removing a stale lock. Do not edit snapshot bytes.
A missing or corrupted runtime is an explicit hook failure. Calls outside Git
and outside CAWS projects are quiet.

Reprieve grants now belong to the machine session store, across adopted projects.
`--surface` identifies the target harness for operator provenance and legacy
lookup; it does not partition new grants into vendor directories. Granting still
requires a human shell, a target session, named handlers, reason, approver and
expiry. `show`/`list` never create directories, and `revoke` retains an inactive
record to suppress legacy copies. Old, unadopted dispatchers may not read new
machine records. Verify a grant through the actual target dispatcher before
claiming it took effect.
