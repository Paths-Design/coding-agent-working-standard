<!--
# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: 8
# caws_min_major: 11
# lineage_refs: 1,4,6,8,11,12,13,16,17,19,20
# edit_stance: this repo OWNS and may grow this hook. Edits are expected and
#   preserved — `caws init` refuses to overwrite a changed managed hook (re-run
#   with --adopt to keep yours, or --overwrite to pull this upstream template).
#   CAWS owns the failure-class invariant (the why/what you must not silently
#   weaken); you own the how. Do not edit it to BYPASS the guard; do grow it.
-->

# CAWS Codex Hook Pack

This directory is the **codex vendor adapter** for the CAWS hook pack. It contains
only the Codex-specific wiring, surface documentation, and override lib files.
All shared hook logic lives in the CAWS shared core, installed at `.caws/hooks/`
in the consumer repo.

Codex loads this project-local `.codex/hooks.json` only after the project
`.codex/` layer is trusted. New or changed non-managed command hooks must be
reviewed and trusted through `/hooks` before they run.

## Layout (CAWS-HOOK-PACK-SHARED-CORE-001)

```
.caws/hooks/            # shared core — event dispatchers + all guard/check hooks
  dispatch/             # pre_tool_use.sh, post_tool_use.sh, session_start.sh, stop.sh, pre_compact.sh
  lib/                  # parse-input.sh (claude-code baseline), run-handlers.sh, emit.sh, agent-surface.sh, ...
  <shared hooks>.sh     # scope-guard, block-dangerous, worktree-guard, etc.

.codex/                 # codex adapter (this directory when installed)
  hooks.json            # wiring -> .caws/hooks/dispatch/<event>.sh
  AGENTS.md             # this file
  hooks/lib/            # codex override lib files (sourced in preference to shared lib)
    emit.sh             # ask->deny; emit_updated_input for apply_patch rewrites
    parse-input.sh      # apply_patch normalization + HOOK_FILE_PATHS / HOOK_ORIGINAL_TOOL_NAME
    run-handlers.sh     # deny exit-code arm in _rh_stdout_priority + CODEX_HOOK_DRY_RUN
```

The session log renderer is NOT a codex override: `shared/session-log.sh`
resolves it from the shared core (`.caws/hooks/session_log_renderer.py`), so
codex uses the same renderer as every other surface.

The override files are resolved at runtime by `caws_source_lib` (defined in
`shared/lib/agent-surface.sh`): it checks `$CAWS_PROJECT_DIR/$CAWS_VENDOR_DIR/hooks/lib/<name>`
before falling back to the shared default. `CAWS_VENDOR_DIR` is `.codex` for this surface.

## Codex-specific differences from the shared baseline

| Override file | What differs |
|---------------|-------------|
| `hooks/lib/emit.sh` | `emit_ask` emits `deny` (Codex has no PreToolUse `ask`); adds `emit_updated_input` for apply_patch command rewriting |
| `hooks/lib/parse-input.sh` | Normalizes `apply_patch` tool_name → `Edit`/`Write`; exports `HOOK_FILE_PATHS` and `HOOK_ORIGINAL_TOOL_NAME` |
| `hooks/lib/run-handlers.sh` | `_rh_stdout_priority` adds `deny` as priority-3 alongside `block`; uses `CODEX_HOOK_DRY_RUN`/`CODEX_HOOK_TIMING` env vars |

These three lib files are the complete genuine-divergence set. Everything else
codex needs — the dispatchers, every guard/check hook, the input parser's
shared baseline, the session log renderer — is the shared core under
`.caws/hooks/`, identical to every other surface. The PostToolUse handler chain
is the shared default for all surfaces (quality-check.sh ships commented out for
everyone; codex does not disable it via any per-surface mechanism).

## This pack is a starting point, not an end state

CAWS cannot anticipate every situation your repository will run into as it
grows. The shipped hook pack is the **governance floor** — a baseline you start
from and grow as your project matures. The division of authority is deliberate:

- **CAWS owns the WHY and the WHAT** — the hard adjudication and the mechanisms.
  *Why* a guard exists (the failure class it prevents), and *what* invariant it
  enforces, are CAWS's contribution. Those are the load-bearing parts you should
  not silently weaken or delete.
- **Your repo owns the HOW** — the specific behavior, thresholds, and added
  rules. These hooks are installed templates the repo is **meant to shape**:
  tune them via env (`CAWS_GOD_OBJECT_LOC`, `CAWS_LOC_DELTA_WARN_THRESHOLD`, the
  `.caws/command-adapters.json` sidecar), add repo-specific checks, and let the
  governance surface evolve with the shape of your codebase. A consuming repo's
  installed `.caws/hooks/` is expected to drift ahead of the shipped template
  over time — that is the design, not a defect.

This is why the quality plane lives in shapeable hook scripts rather than a
fixed subprocess that must be patched centrally for every repo-specific need.
Equipping your agents with the tools you recommend for effective work is not a
loss of governance — it is governance you can grow.

## These are CAWS-managed files — and you may grow them

The hooks ship as **managed** files. "Managed" means `caws init` recognizes them
(via the `CAWS-MANAGED-HOOK` header) and can offer a baseline update — it does
**not** mean "frozen" or "hands off." Per the section above, this repo owns the
HOW: **editing these hooks to grow your governance is expected and welcome.**

There is exactly **one** edit that is out of bounds: editing a hook to **bypass,
delete, or locally weaken a guard** in order to dodge a block. That crosses into
the WHY/WHAT that CAWS owns (the failure class and the invariant). If a hook
blocks work you believe is legitimate, the answer is to fix the cause or raise it
with the user — not to defang the guard. Growing a hook (tuning thresholds,
adding repo-specific checks, extending coverage) is the opposite of that and
needs no apology. (Any internal CAWS provenance metadata in a file's header is
upstream maintainer context — it is not an authority requirement for this repo.)

**Your edits are preserved — `caws init` will not clobber them.** As long as a
hook keeps its `CAWS-MANAGED-HOOK` header, an edited hook is classified as
*drift* and `caws init` **refuses to overwrite it** (it stays managed; it does
not silently become unmanaged). On a re-init you choose:

- **do nothing / `--adopt`** — keep your grown version (the default-correct
  choice once you have shaped a hook);
- **`--overwrite`** — pull the upstream template, replacing your version (the
  only path that discards your edits — use it when you want the new CAWS
  baseline).

So you do not have to choose between "grow the hook" and "keep getting updates":
edit freely, and decide per file at re-init time whether to keep yours or take
upstream. (Deleting the header is the only thing that makes a file fully
unmanaged — rarely what you want, since it opts the file out of update offers
entirely.)

## What each hook does

| File | What it prevents / does |
|------|------------------------|
| `block-dangerous.sh` + `classify_command.py` | catastrophic git operations; tokenized-argv bypasses; danger latch |
| `worktree-guard.sh` | amend/stash/reset/force-push during active worktrees; cross-boundary file copies; **canonical-checkout mutating git commands (checkout/switch/branch -f/reset non-hard) blocked when worktrees active**; **agent-Bash `git sparse-checkout` (any subcommand) refused, pointing to `caws worktree repair-sparse <name>`**; **the path-restore family (`git restore <path>` / `git checkout -- <path>` / `git clean`) blocked when worktrees active, worded by the actual op — a path restore is NOT a branch switch** |
| `worktree-write-guard.sh` | base-branch writes when worktrees are active; baseline-clobber; **Read/Write/Edit refusal against `<linked-worktree>/.caws/specs/*` so canonical spec authority is not materialized as a divergent private copy inside a worktree, before the broad `.caws/*` allowlist can exit 0**; **`.caws/worktrees/<name>/<rest>` payload writes routed through `lib/worktree-claim-oracle.cjs` BEFORE the broad `.caws/*` allowlist — a foreign session's write into another worktree's payload hard-blocks instead of being allowlisted** |
| `bash-write-guard.sh` | **Bash mutation-target authority: self-filters to Bash, extracts targets for a narrow mutation-form set (redirection, `tee`, `sed -i`, `perl -pi`, `truncate`, `touch`, `rm`, `mv`, `cp`, `dd of=`, git path-restore), and routes each through the SAME `lib/worktree-claim-oracle.cjs` as Write/Edit — a Bash mutation of a foreign worktree's payload blocks at the same boundary as a foreign Write/Edit** |
| `lib/worktree-claim-oracle.cjs` | **the single worktree-ownership oracle (standalone node helper, NOT an inline `node -e` heredoc) shelled out to by worktree-write-guard (Write/Edit) and bash-write-guard (Bash) so both surfaces return the same owner-vs-session answer; lazy `js-yaml` so the foreign-payload block works without a resolvable `js-yaml`; fails closed. Shipped as `.cjs` so it loads as CommonJS even in a repo whose `package.json` declares `"type":"module"`** |
| `scope-guard.sh` | edits outside the active spec's `scope.in`; cross-spec union interference; unbound → no authority |
| `session-caws-status.sh` | inherited-dirty-state collision; foreign-claim soft-block; version-skew |
| `reset-strikes.sh` | human-authorized strike reset (escape hatch, not auto-resettable) |
| `reset-danger-latch.sh` | human-authorized danger latch reset |
| `guard-strikes.sh` | progressive enforcement (strike 1 warn → strike 3 block) |
| `audit.sh` | per-tool-call audit log |
| `session-log.sh` | per-turn narrative + structured transcripts |
| `.caws/hooks/dispatch/*` | wires Codex's lifecycle to the registered handler list through the shared core |
| `lib/*` | Codex-specific overrides for input parsing, output emission, and handler output aggregation |
| `god-object-check.sh` | advisory: flags a written/edited file whose SLOC exceeds `CAWS_GOD_OBJECT_LOC` (default 2000). Edit-time analogue of the `god_object` gate. Always exit 0. |
| `shortcut-language-check.sh` | progressive: flags TODO/FIXME/XXX/placeholder/"not implemented" stub language in NON-test source; escalates warn→ask→block via guard-strikes. Edit-time analogue of the `todo_detection` gate. |
| `duplicate-export-check.sh` | advisory: on Write of a new JS/TS file, flags an exported symbol whose exact name already exists in the enclosing package src tree (generic-name allowlist). Always exit 0. |
| `loc-delta-check.sh` | advisory: on Edit, flags an added-line delta over `CAWS_LOC_DELTA_WARN_THRESHOLD` (default 300) via the new_string/old_string payload diff. Always exit 0. |

The four `*-check.sh` hooks above are the **edit-time advisory quality plane**. They implement the load-bearing edit-time quality checks in self-contained bash; they do NOT import, shell out to, or runtime-couple with an external quality package, and they do NOT change `caws gates run`. `caws gates run` remains the governed policy/evidence runner; these hooks are installed utilities the repo tunes via env (`CAWS_GOD_OBJECT_LOC`, `CAWS_LOC_DELTA_WARN_THRESHOLD`).

Codex reports file edits through `apply_patch`; the parser maps those payloads
to CAWS-style `Write`/`Edit` variables for guard parity. Codex does not
currently support PreToolUse `ask`; the Codex emitter degrades ask-level
escalations to `permissionDecision: "deny"` so governance never silently allows
an operation because an unsupported ask field was ignored.

## Authoring a spec without getting trapped

A handful of CAWS conventions reject an authored spec in ways that are easy to
hit blind. Each has a concrete fix below. **Validate every authored spec with
`caws specs show <id>` (or `caws doctor`) before you commit it** — those surface
a schema rejection immediately, so you never commit a spec that will not load.

- **Tier 1 / tier 2 specs require at least one contract.** A bare
  `caws specs create <id> --mode feature --risk-tier 2` is rejected
  (`Tier 2 specs require at least one contract`). Author the contract in the same
  command — do not hand-edit the YAML afterward:

  ```bash
  caws specs create FEAT-001 --title "..." --mode feature --risk-tier 2 \
    --contract "core-api:behavior"
  ```

  `--contract` is repeatable and takes `"name:type[:path]"`, where `type` is one
  of `api | schema | contract-test | behavior`. If the slice is a low-blast-radius
  chore, use `--risk-tier 3` (or `--mode chore`) instead — those need no contract.

- **`non_functional.*` values are arrays of strings, not scalars.** The four
  admitted subkeys (`accessibility`, `performance`, `reliability`, `security`)
  each take a list:

  ```yaml
  non_functional:
    reliability:
      - 'the guard must fail closed on a spawn error'
  ```

  A scalar value is rejected with `spec.schema.violation: Expected array`.

- **Quote YAML scalars that start with a backtick or other special character.**
  A `given:` / `when:` / `then:` value beginning with a backtick (or `:` `#` `{`
  `[`) breaks the parse (`bad indentation of a mapping entry`). Quote it, or use a
  block scalar (`>-`) which takes the text verbatim.

- **Scope paths must match real file extensions.** A test file is usually
  `*.test.js` even when the code under test is TypeScript — list the path that
  actually exists on disk in `scope.in`, or the scope guard refuses edits to the
  real file. Widen scope later with `caws specs amend-scope <id> --add <path>`
  (governed; no hand-edit).

## v11 state-model awareness

The v11 pack reads CAWS state under both v10 and v11 shapes during the
transition window:

- **Specs**: `lifecycle_state` is read first; `status` is the v10 fallback.
  Terminal states (closed, archived, completed) are not enforced.
  `draft` does NOT participate in union-wide blocking unless it is the
  authoritative/bound spec.
- **Worktrees registry**: both v11 direct-key
  (`{"<name>": {...}}`) and v10 nested
  (`{"worktrees": {"<name>": {...}}}`) shapes are accepted.
- **Bound spec id**: both `entry.specId` (v10) and `entry.spec_id` (v11)
  are accepted.

## Version-skew warning

`session-caws-status.sh` emits a non-blocking WARNING when the global
`caws` binary's major version differs from the repo's `caws-cli` major
version. Hooks parse local state directly, but any CLI advice in
diagnostics may be invalid. Consider matching major versions:
`npm install -g @paths.design/caws-cli@^<repo-major>`.

## Activation

Codex reads `.codex/hooks.json` from trusted project config layers. Installing
the pack mid-session does NOT activate it until the session is restarted.
`caws init --agent-surface codex` writes `.codex/hooks.json` with one
git-root-resolved CAWS dispatcher command per event. The installed commands
resolve the active Git root at invocation time, bind `CAWS_PROJECT_DIR` and
`CODEX_PROJECT_DIR` to that root, and call `.caws/hooks/dispatch/<event>.sh` so
Codex does not carry a separate dispatcher copy.

Project-local hooks also require Codex trust review. After install or update,
restart/reopen the Codex session and run `/hooks` to inspect and trust the
changed hook definitions before relying on enforcement.

## Managed file headers

Every managed file in this pack carries a header like:

```
# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: <N>
# caws_min_major: 11
# lineage_refs: <comma-separated entries>
# edit_stance: this repo OWNS and may grow this hook. Edits are expected and
#   preserved — `caws init` refuses to overwrite a changed managed hook (re-run
#   with --adopt to keep yours, or --overwrite to pull this upstream template).
#   CAWS owns the failure-class invariant (the why/what you must not silently
#   weaken); you own the how. Do not edit it to BYPASS the guard; do grow it.
```

The header is what `caws init` uses to distinguish managed files (safe to
update on re-install under a documented policy) from local user files
(refused without explicit `--adopt` or `--overwrite`).

Removing or editing the header turns the file into an unmanaged
snowflake. Re-running install will then refuse to touch it — by design.
