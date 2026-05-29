# Hook packs: the edit-time advisory quality plane

CAWS ships a Claude Code hook pack (installed via `caws init --agent-surface claude-code`) that interposes governance between the agent and its Edit/Write/Bash tools. Most of the pack is hard governance — scope guards, worktree guards, dangerous-command blocking. This guide documents one slice of it: the **advisory quality plane** added by `QG-HOOKS-EXTRACT-001`.

These four hooks are *advisory* edit-time signals. They reimplement the intent of the load-bearing `caws gates run` quality gates (`god_object`, `todo_detection`, functional-duplication, change-budget) so the agent gets feedback *in the loop where it is editing*, instead of only when an operator later runs `caws gates run`.

## The doctrine boundary (option C)

These hooks are an **edit-time advisory plane**, not a replacement for `caws gates run`:

- `caws gates run` is the **governed policy-gate runner**. It reads `.caws/policy.yaml`, evaluates gates in `block`/`warn`/`skip` mode, and appends a `gate_evaluated` event per gate. It is the canonical disposition surface.
- The four hooks below are **installed hook-pack utilities** that the repo tunes locally (via env vars). They never write events, never block a gate, and have **no runtime coupling** to `packages/quality-gates` — they reimplement detection intent in self-contained bash.

This is deliberate: the canonical gate evaluators evolve centrally, but the edit-time hooks start from the governance floor and are shaped per-repo. Installing the pack does not change `caws gates run` behavior in any way.

## The four hooks

All four are registered as `PostToolUse` handlers in `dispatch/post_tool_use.sh`. They skip generated/vendored paths (`node_modules`, `dist`, `build`, `coverage`, `.next`, `out`, `vendor`) and minified/lock artifacts at the top of the script — they only act on real source files the agent authored.

### `god-object-check.sh` — large-module advisory

- **Trigger:** Write or Edit.
- **Mode:** advisory (always exits 0; never blocks).
- **What it flags:** a touched file whose source-lines-of-code (blank and whole-line `//`/`#`/`*` comments stripped) meets or exceeds the threshold.
- **Threshold env:** `CAWS_GOD_OBJECT_LOC` (default `2000`).
- **Edit-time analogue of:** the `god_object` gate (`check-god-objects.mjs`, which tiers at 1750/2000/3000).
- **Output:** a `hookSpecificOutput.additionalContext` warning naming the file, its SLOC, and the threshold.

### `shortcut-language-check.sh` — placeholder/stub advisory (progressive)

- **Trigger:** Write or Edit, on NON-test source (`*.test.*`, `*.spec.*`, `tests/`, `__tests__/`, and markdown/docs are exempt — placeholder language there is routine).
- **Mode:** **progressive** — the only one of the four that can block. It escalates through the shared guard-strikes mechanism: **strike 1 → warn**, **strike 2 → ask** (permission prompt), **strike 3 → block**. Strikes are per-session.
- **What it flags:** incomplete-work markers (`TODO`, `FIXME`, `XXX`, `HACK`, `TBD`), placeholder/not-implemented phrases (`not implemented`, `implement later`, `coming soon`, `placeholder`), and explicit `throw new Error("not implemented")` stub shapes.
- **Edit-time analogue of:** the `todo_detection` gate (`todo-analyzer.mjs`). The hook ships the high-signal subset of that analyzer's vocabulary to stay single-file and fast.
- **Doctrine:** enforces the CAWS key rule "No fake implementations — no placeholder stubs, no TODO in committed code."

### `duplicate-export-check.sh` — shadow-export advisory

- **Trigger:** Write only (new-file creation — the common shadow-export incident). An Edit that adds a colliding export to an existing file is a documented v1 limitation.
- **Mode:** advisory (always exits 0).
- **What it flags:** a newly-written JS/TS file that exports a symbol whose **exact** name already exists as an export elsewhere in the enclosing package's `src` tree. Generic names are allowlisted (`main`, `init`, `setup`, `run`, `handle`, `render`, `index`, `default`). Matching is exact, not heuristic similarity.
- **Lookup:** bounded to the enclosing `packages/<pkg>/src` (or repo-root `src`); uses ripgrep when available, `grep -r` fallback; never scans `node_modules`.
- **Edit-time analogue of:** the functional-duplication gate's name/shape collision check (`check-functional-duplication.mjs`).
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

The hook scripts themselves are **managed pack files** — they carry a `CAWS-MANAGED-HOOK` header and are updated by `caws init --agent-surface claude-code`, not hand-edited. Tune behavior through env, not by editing the scripts.

## Lineage

Each hook traces to a `docs/failure-lineage.md` entry documenting the gap it closes: `god-object-check.sh` → Entry 28, `shortcut-language-check.sh` → Entry 29, `duplicate-export-check.sh` → Entry 30, `loc-delta-check.sh` → Entry 31. The per-pack lineage map lives in `.claude/hooks/CLAUDE.md` after install (sourced from `packages/caws-cli/templates/hook-packs/claude-code/CLAUDE.md`).
