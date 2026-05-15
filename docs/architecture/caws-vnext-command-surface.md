---
doc_id: caws-vnext-command-surface
authority: architecture
status: draft
title: CAWS vNext command surface (v11.0.0)
owner: vNext rewrite team
updated: 2026-05-15
governs:
  modules:
    - packages/caws-cli/src/index.js
    - packages/caws-cli/src/shell/
    - packages/caws-cli/src/store/
    - packages/caws-cli/src/commands/
    - packages/caws-kernel/src/
  schemas:
    - packages/caws-kernel/src/schemas/events/
---

# CAWS vNext command surface (v11.0.0)

**Status:** active (Slice 8a3 removals complete; awaiting 8a4 audit)
**Branch:** `caws-next` (post-8a3.5)
**Authors:** vNext rewrite team
**Last updated:** 2026-05-15

This document is the doctrine source for the v11.0.0 cutover. It captures
the cutover posture, the command surface that ships in v11, the legacy
commands that are removed, and the architectural invariants the rewrite
established.

If a future change conflicts with anything below, fix the change or revise
this doc — do not silently regress an invariant.

---

## 1. Cutover posture

**A1 chosen.**

> v11.0.0 is the governed core.
> v11.0.0 deliberately excludes spec/worktree lifecycle.
> Projects needing legacy lifecycle pin to `caws-cli@^10.2.x`.
> vNext lifecycle returns in v11.1.

### Why A1

The vNext rewrite established a coherent kernel/store/shell substrate
across slices 1–7c, including:

- pure kernel (no fs/path/env/clock) for spec/policy/doctor/waiver logic
- store layer that owns all I/O, atomic writes, hash-chained event log
- shell commands that compose store snapshots into observability and
  governance surfaces (`init`, `doctor`, `status`, `scope`, `claim`,
  `gates`, `waiver`, `evidence`)

It did **not** rewrite the legacy spec or worktree lifecycle commands
(`specs create/close/archive/migrate`, `worktree create/destroy/merge`).
Those remain on the legacy code path.

The two viable cutover postures were:

- **A1** — ship the governed core as v11.0.0; defer lifecycle to v11.1.
- **A2** — block cutover until vNext spec/worktree lifecycle exists.
- **C** — keep legacy lifecycle alongside vNext (mixed-regime).

A1 is chosen because:

- A2 indefinitely delays cutover and lets `caws-next` rot
- C re-introduces the exact mixed-regime hazard the rewrite was meant to
  eliminate (two authority paths writing to overlapping state files)
- A1 is honest about the scope of v11.0.0: it is a strong governance
  core, not yet a complete lifecycle replacement

### v11.1 plan (out of scope for v11.0.0)

vNext spec lifecycle (`spec create/close/archive`) and worktree lifecycle
(`worktree create/destroy/merge`) will be reintroduced as vNext shell
commands in v11.1. Until then, projects that need those commands should
pin to `caws-cli@^10.2.x`.

---

## 2. v11.0.0 command surface (kept)

These eight command groups are the canonical authority surface for
v11.0.0. Every one is implemented in `packages/caws-cli/src/shell/`,
composed atop `packages/caws-cli/src/store/` and
`packages/caws-kernel/`.

| Command | Purpose |
|---|---|
| `caws init` | Bootstrap canonical vNext `.caws/` state. Idempotent. Refuses legacy residue. No `--force`. |
| `caws doctor` | Drift detection over `.caws/` state; exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure). |
| `caws status` | Read-only dashboard: project, current context, claim, doctor findings. Always observability — never mutates. |
| `caws scope show <path>` | Explain the scope decision for `<path>`; always exits 0. |
| `caws scope check <path>` | Enforce the scope decision for `<path>`; exits 0 on admit, 1 otherwise. |
| `caws claim [--takeover]` | Surface or take ownership of the current worktree; writes `prior_owners` audit on takeover. |
| `caws gates run --spec <id>` | Run quality gates against current changes; policy decides block/warn/skip; appends one `gate_evaluated` event per policy-declared gate. |
| `caws evidence record` | Append a typed evidence event (`test`/`gate`/`ac`) to `.caws/events.jsonl`. |
| `caws waiver create/list/show/revoke` | Manage waiver records that filter matching gate violations. Singular surface — no plural alias. |

### Help banner (built CLI)

```
$ caws --help
Commands:
  init      Bootstrap the canonical vNext .caws/ project state...
  doctor    Run drift detection against the current .caws/ state
  scope     Evaluate file paths against the bound spec scope
  status    Read-only dashboard...
  claim     Surface ownership of the current worktree...
  gates     Run quality gates against the current changes (policy-driven)
  evidence  Record typed evidence events into .caws/events.jsonl
  waiver    Manage CAWS waivers...
```

Exactly these eight groups, plus the auto-generated `help`.

### Count reconciliation (against `caws-next` @ `52d6165`)

| Source | Count | Notes |
|---|---|---|
| `node dist/index.js --help` rows (excluding Commander's auto-generated `help`) | 32 | 8 vNext + 24 legacy |
| `node dist/index.js --help` rows (including `help`) | 33 | adds Commander's built-in row |
| `VALID_COMMANDS` entries in `src/index.js` | 28 | suggester list for unknown-command fallback |
| `VALID_COMMANDS` entries with no current registration | 1 | `quality-gates` (alias removed in slice 6c, never cleaned from suggester) — **stale** |
| Currently-registered commands missing from `VALID_COMMANDS` | 5 | `agents`, `claim`, `doctor`, `evidence`, `test-analysis` (drift; suggester does not learn them) |

The `VALID_COMMANDS` discrepancy is an existing drift, not a v11 regression.
8a3 will rewrite `VALID_COMMANDS` to match exactly the post-removal v11 surface;
8a4 audit 1 will assert the equality.

---

## 3. Removed in v11

The legacy command surface registered in `packages/caws-cli/src/index.js`
ships in v10.2.x but is **removed in v11.0.0**. This section catalogs
every removed group, the reason category, and what (if anything) replaces
it.

Reason categories:

- **AC** — *authority conflict.* The legacy command writes to overlapping
  state, calls `appendEvent` on a parallel chain, or interprets specs
  through the legacy `spec-resolver` (which falls back to
  `working-spec.yaml`). Mixed-regime hazard.
- **LG** — *unsupported lifecycle gap under A1.* The command is part of
  the spec or worktree lifecycle; v11.0.0 explicitly does not ship a
  vNext replacement. Returns in v11.1.
- **PNC** — *peripheral / non-core.* The command is not part of the v11
  authority surface and is not depended on by the governed core.
- **PE** — *legacy provenance/evidence conflict.* The command writes to
  `.caws/provenance/`, which is superseded by `.caws/events.jsonl`.
- **SH** — *old scaffold/hook risk.* The command installs or generates
  legacy regime artifacts (git hooks that call removed commands, scaffold
  templates that write `working-spec.yaml`, etc.).

| Command | Handler | Mutates? | State touched | Reason | Replacement |
|---|---|---|---|---|---|
| `scaffold` | `src/scaffold/index.js` (793 LOC) | yes | `.caws/`, `.git/hooks/`, IDE configs, gitignore | **SH** | `caws init` (governed core only) |
| `validate \| verify` | `src/commands/validate.js` (357 LOC) | yes (`appendEvent` on legacy log) | `working-spec.yaml` fallback via `spec-resolver`; legacy `events.jsonl` writer | **AC** | `caws doctor` covers spec health; v11.1 will re-add explicit validation |
| `archive <change-id>` | `src/commands/archive.js` (500 LOC) | yes | `.caws/provenance/chain.json`, `working-spec.yaml` | **PE + LG** | (none in v11.0; provenance superseded by events.jsonl) |
| `specs list/create/show/update/delete/close/archive/conflicts/migrate/types` | `src/commands/specs.js` (1656 LOC) | yes (`appendEvent` on legacy log) | `.caws/specs/<id>.yaml`, `.caws/specs/registry.json`, legacy `working-spec.yaml` (migrate) | **LG + AC** | v11.1 vNext spec lifecycle; for v11.0 use direct YAML edits + `caws doctor` |
| `sidecar drift/gaps/waiver-draft/provenance` | `src/commands/sidecar.js` (74 LOC) | no (read + advisory) | reads via `sidecars/` subsystem | **PNC** | (none; advisory only) |
| `mode current/set/compare/recommend/details` | `src/commands/mode.js` (269 LOC) | yes | `.caws/mode.yaml` (separate state file) | **PNC + AC** | (none; complexity tier metadata not in v11) |
| `tutorial [type]` | `src/commands/tutorial.js` (480 LOC) | no | none | **PNC** | (none) |
| `plan <action>` | `src/commands/plan.js` (438 LOC) | yes (writes plan markdown to `--output`) | user-specified path | **PNC** | (none) |
| `worktree create/list/destroy/merge/prune/repair/bind/claim` | `src/commands/worktree.js` (502 LOC) | yes | `.caws/worktrees.json`, git worktrees | **LG** | v11.1 vNext worktree lifecycle; `caws claim` handles ownership |
| `agents list/show <id>` | `src/commands/agents.js` (124 LOC) | no (read-only) | reads `.caws/agents.json` | **PNC** (overlaps with vNext `status`/claim panel) | `caws status` shows partial info; richer inspector deferred to v11.1+ as `status --agents` or `claim show` |
| `session start/checkpoint/end/list/show/briefing` | `src/commands/session.js` (312 LOC) | yes | `.caws/sessions/`, `.caws/sessions.json` (separate state) | **PNC + AC** | v11 doctor does not observe sessions; re-add later if needed |
| `parallel setup/status/merge/teardown` | `src/commands/parallel.js` (242 LOC) | yes | `.caws/parallel/...` (separate state); creates worktrees | **LG** | v11.1 lifecycle work |
| `templates [subcommand]` | `src/commands/templates.js` (237 LOC) | no | reads `templates/` | **PNC** | (none) |
| `diagnose [--fix]` | `src/commands/diagnose.js` (525 LOC) | yes (`--fix`) | various; advertises legacy commands as "core" | **AC** | `caws doctor` is the v11 diagnostic surface |
| `verify-acs` | `src/commands/verify-acs.js` (443 LOC) | yes (`appendEvent` on legacy log) | spec-resolver legacy fallback; legacy `events.jsonl` writer | **AC** | (none in v11.0; planned for v11.1 alongside spec lifecycle) |
| `evaluate [spec-file]` | `src/commands/evaluate.js` (314 LOC) | yes (`appendEvent` on legacy log) | spec-resolver legacy fallback; legacy `events.jsonl` writer | **AC** | (none in v11.0) |
| `iterate [spec-file]` | `src/commands/iterate.js` (417 LOC) | no (read + advisory) | spec-resolver legacy fallback | **AC** | (none in v11.0) |
| `burnup [spec-file]` | `src/commands/burnup.js` (198 LOC) | yes (writes report) | spec-resolver legacy fallback | **AC** | (none in v11.0) |
| `workflow <type>` | `src/commands/workflow.js` (243 LOC) | no (advisory; advertises `caws provenance update`) | spec-resolver | **AC + PNC** | (none) |
| `quality-monitor <action>` | `src/commands/quality-monitor.js` (284 LOC) | varies | spec-resolver | **PNC** | `caws gates run` is the v11 gate surface |
| `tool <tool-id>` | `src/commands/tool.js` (136 LOC) | varies (executes registered tools) | none directly | **PNC** | (none) |
| `test-analysis <subcommand>` | `src/test-analysis.js` (~?) | reads | `working-spec.yaml` ref | **AC + PNC** | (none) |
| `provenance update/show/verify/analyze-ai/init` | `src/commands/provenance.js` (1143 LOC) | yes | `.caws/provenance/chain.json` (separate hash chain), legacy `working-spec.yaml` fallback | **PE + AC** | `.caws/events.jsonl` is the v11 audit chain |
| `hooks install/remove/status` | `src/scaffold/git-hooks.js` (965 LOC) + index.js inline | yes | `.git/hooks/{pre-commit,post-commit,pre-push,commit-msg}` — generated hooks call `caws validate` and `caws provenance update` | **SH** | (none in v11.0; users wire their own hooks against `caws gates run` if desired) |

### 3.5 Non-command shipped code that touches legacy state

These are not command groups but ship in v11 and reach legacy artifacts.
They are tracked here so 8a2 can decide reachability rather than guessing.

| File | Concern | 8a2 audit question |
|---|---|---|
| `src/gates/spec-completeness.js` | Reads `.caws/working-spec.yaml` as the spec source for the `spec_completeness` gate | Is this gate reachable from the v11 surface (`caws gates run`) or only from removed commands like `caws validate` / `caws quality-gates`? |
| `src/cicd-optimizer.js` | Defaults `specPath` to `.caws/working-spec.yaml` | Is this code reachable from any v11-registered command? |
| `src/budget-derivation.js` | Mentions `.caws/working-spec.yaml` in error guidance | Same reachability question. |
| `src/spec/SpecFileManager.js` | Manages `working-spec.yaml` lifecycle | Reachability — likely only used by removed `validate`/`evaluate`/`iterate`/`burnup`. |
| `src/utils/spec-resolver.js` | Defines `LEGACY_SPEC = '.caws/working-spec.yaml'` and falls back to it | Reachable from any v11 surface? Vendored types/utils that the removal pass should orphan. |
| `src/worktree/worktree-manager.js` | Writes/reads `.caws/worktrees.json`; references `working-spec.yaml` | `caws claim` uses parts of this; precise reachability boundary required. |
| `src/utils/event-log.js` | Parallel `appendEvent` writer to `.caws/events.jsonl` (NOT the store) | Reachable only from removed commands? **Invariant 1 violator** if any v11 path reaches it. |
| `src/sidecars/listeners.js` | Registered at startup (`index.js:786-789`) | Side-effect surface; should be removed alongside `sidecar` command. |
| `src/scaffold/git-hooks.js` | Generates hooks calling `caws validate` and `caws provenance update` | Removed in 8a3 alongside `hooks` command. |

8a2 audit 3 (kernel purity) is unaffected by these — the kernel is clean
already. These are CLI-side concerns. The audit will tell us which files
are dead code in v11 (safe to leave dormant; cleaned in 8e) vs which are
still reachable from the v11 surface (must be addressed in 8a3 or
escalated).

### Removal counts

- 24 legacy command groups removed (matches the table above; matches `--help` minus the 8 vNext groups)
- 8 vNext command groups remain
- ~10,650 LOC of legacy handler code (kept on disk for archaeology in v11.0; deleted in v11.1 per Slice 8e)
- `VALID_COMMANDS` rewritten to match the v11 surface exactly (drops 24 legacy entries plus the stale `quality-gates` alias; adds the 5 currently-missing vNext entries `agents`, `claim`, `doctor`, `evidence`, `test-analysis` — minus any of those that are themselves removed; `agents` and `test-analysis` are removed under A1, so the final `VALID_COMMANDS` is exactly the 8 vNext groups)

---

## 4. State files

### Owned by v11

| File | Owner | Notes |
|---|---|---|
| `.caws/specs/<id>.yaml` | store + doctor + scope | Multi-spec authority. No project-level `working-spec.yaml`. |
| `.caws/specs/registry.json` | store | Index over `specs/`. Optional; doctor handles missing/malformed. |
| `.caws/policy.yaml` | store | Single source of truth for gate `mode` (block/warn/skip). |
| `.caws/waivers/<id>.yaml` | store + waiver command | Waivers filter violations; never mutate gate mode. |
| `.caws/worktrees.json` | store + claim | Worktree registry; v11 commands read but do not create new worktrees. |
| `.caws/agents.json` | store | Agent session registry. |
| `.caws/events.jsonl` | **store ONLY** (`appendEvent` in `events-store.ts`) | Hash-chained, append-only. First `appendEvent` creates the file under lock. Never required at rest. |

### Refused by v11 (legacy residue)

| File | Detection | Action |
|---|---|---|
| `.caws/working-spec.yaml` | `init-store.findLegacyResidue` and `doctor-snapshot.observeInitResidue` (both via `fs.statSync().isFile()`) | `caws init` refuses with `INIT_LEGACY_RESIDUE`; `caws doctor` emits `doctor.init.legacy_working_spec_present` (error). |
| `.caws/working-spec.schema.json` | same | `caws doctor` emits `doctor.init.legacy_working_spec_schema_present` (error). |
| `.caws/provenance/` | (not yet a doctor rule) | Superseded by `events.jsonl`. Future: doctor rule to flag presence. |
| `.caws/sessions/`, `.caws/sessions.json` | (no v11 awareness) | Created only by removed `session` command. Inert in v11. |
| `.caws/parallel/...` | (no v11 awareness) | Created only by removed `parallel` command. Inert in v11. |
| `.caws/mode.yaml` | (no v11 awareness) | Created only by removed `mode` command. Inert in v11. |
| `.caws/quality-gates-report.json` | (no v11 awareness) | Cache file; can be deleted manually. |

---

## 5. Exit-code conventions

| Code | Meaning |
|---|---|
| `0` | Success / observation. The command did what was asked, or surfaced state without mutating. |
| `1` | Domain failure. A gate failed, doctor found drift, validation rejected input, scope refused admit. The command worked correctly and reported the failure. |
| `2` | Composition failure. Could not establish preconditions: not in a git repo, cannot read `.caws/`, missing required tooling. |

Doctor specifically: exit 0 when clean, 1 when findings or load errors are
present, 2 on hard composition failure (e.g., not a git repo).

Status specifically: always exits 0. Status is observability — it does
not gate other operations.

Scope: `show` always 0; `check` 0 on admit, 1 on refuse, 2 on composition
failure.

---

## 6. Architectural invariants

These are non-negotiable for v11. A change that violates one of these is
either a regression to fix, or a deliberate doctrine shift requiring an
update to this document.

1. **`events.jsonl` is written ONLY through `appendEvent` in
   `packages/caws-cli/src/store/events-store.ts`.** That function
   acquires `events.jsonl.lock`, computes the hash chain, validates the
   event against its JSON Schema, and writes atomically. No other code
   in v11 writes to that file.

2. **`policy.yaml` owns gate `mode` (`block` / `warn` / `skip`).**
   Waivers filter violations *out of* the disposition calculation; they
   do not change the gate's policy mode. Removing all waiver matches
   does not magically downgrade a `block` gate to `warn`.

3. **Doctor is pure.** `packages/caws-kernel/src/doctor/` has no
   `fs`/`path`/`process.env`/`Date.now()`/`new Date()` access in
   executable code. Time enters via the injected `now: Date` field on
   `DoctorInput`; everything else is constructed by the store.

4. **Missing != malformed.** Registry diagnostics distinguish a missing
   file (no diagnostic, treated as empty) from a malformed file (warning
   or error diagnostic carrying the cause). The same distinction applies
   to specs and waivers.

5. **`events.jsonl` is never required at rest.** The first call to
   `appendEvent` creates it. Doctor and status do not require its
   existence; they only require its hash chain to verify when present.

6. **Init is non-destructive.** `caws init` is idempotent; it never
   overwrites existing files except to add missing canonical layout
   pieces. It never creates `events.jsonl`. It refuses if legacy residue
   is detected.

7. **Status is observability.** `caws status` never mutates. Running it
   any number of times produces no `.caws/` byte changes (mutation-
   negative test in `tests/shell/doctor-status-7c3.test.js`).

---

## 7. Migration guidance for legacy users

Projects upgrading from `caws-cli@10.2.x` to `caws-cli@11.0.0` should:

### Mandatory

1. **Migrate from `working-spec.yaml` to per-feature specs.** Move the
   contents of `.caws/working-spec.yaml` into `.caws/specs/<id>.yaml`
   files. v11's `caws init` and `caws doctor` refuse to run alongside
   `working-spec.yaml`. (The legacy `caws specs migrate` command is
   removed in v11; perform the migration on v10.2.x first, or do it
   manually.)
2. **Delete `.caws/working-spec.schema.json`** if present. Schemas are
   now bundled in the kernel.
3. **Remove `.caws/provenance/`.** The hash-chained audit trail moves to
   `.caws/events.jsonl`. Old provenance data is not migrated; archive it
   if you need historical access.

### Recommended

4. **Replace generated git hooks.** v10.2.x `caws hooks install` wrote
   `.git/hooks/{pre-commit,post-commit,pre-push,commit-msg}` that call
   removed commands (`caws validate`, `caws provenance update`). Either
   remove those hooks or rewrite them to call v11 surfaces (`caws
   doctor`, `caws gates run`, etc.).
5. **Audit `caws scaffold` artifacts.** Templates and IDE integrations
   installed by `caws scaffold` may reference removed commands. Check
   `.cursorrules`, `.claude/`, etc.

### If you need spec or worktree lifecycle commands in v11.0

Pin to `caws-cli@^10.2.x` until v11.1 ships vNext lifecycle commands.
The two CLIs cannot coexist in the same project — they write to
overlapping state.

---

## 9. Slice 8a2 — pre-removal invariant audit (results)

Run as part of Slice 8a2. Stance: a finding is any active shipped path
that can read or write old authority state, or invoke a command marked
for removal. Dormant code (not imported, not registered, not invoked
by hooks/templates, not advertised) is acceptable in v11.0.0 and gets
cleaned in 8e. **Replacement, not continuity.**

### Audit 1 — `events.jsonl` writers outside the event store

The store's `appendEvent` (`packages/caws-cli/src/store/events-store.ts:178`)
is the canonical writer. A second implementation lives in
`packages/caws-cli/src/utils/event-log.js` (`appendEvent` async +
`appendEventSync`). Call sites of the legacy writer:

| Call site | Reachable via v11? | Disposition |
|---|---|---|
| `commands/specs.js:576,866,958,1086` | only via removed `specs` group | orphaned by 8a3 |
| `commands/validate.js:176` | only via removed `validate` | orphaned by 8a3 |
| `commands/verify-acs.js:373` | only via removed `verify-acs` | orphaned by 8a3 |
| `commands/evaluate.js:227` | only via removed `evaluate` | orphaned by 8a3 |
| `commands/gates.js:95` | already dormant (legacy `gates` group unregistered slice 6c) | orphaned by 8a3 file delete |
| `commands/waivers.js:504` | already dormant (legacy plural unregistered slice 7a.4) | orphaned by 8a3 file delete |
| `session/session-manager.js:315,482` | only via removed `session` group | orphaned by 8a3 |

**Result: zero blockers. `utils/event-log.js` is fully orphaned by 8a3.**
Invariant 1 ("events.jsonl ONLY through store appendEvent") will hold
after 8a3 import removal.

### Audit 2 — `working-spec.yaml` active authority paths

Two categories:

**Acceptable refs** (residue detection, refusal, user-facing rule text):
`store/init-store.ts:84` (refused-paths list), `store/specs-store.ts:69`
(loader guard), `store/doctor-snapshot.ts:113` (residue observation),
`kernel/doctor/inspect.ts:636-640` (rule message), `shell/register.ts:76`
(comment), kernel rule constants, generated diagnostic messages.

**Active legacy authority** — every site is reachable only via removed
commands or already-dormant subsystems:

| File | Caller | Disposition |
|---|---|---|
| `gates/spec-completeness.js:25` | only `gates/pipeline.js` → only `commands/gates.js` (already dormant) | orphaned by 8a3 |
| `cicd-optimizer.js:29` | no callers found | already dormant |
| `test-analysis.js:96` | only via removed `test-analysis` group | orphaned by 8a3 |
| `worktree/worktree-manager.js:289` | only via removed `worktree`/`specs`/`scope`(legacy)/`parallel` | orphaned by 8a3 |
| `spec/SpecFileManager.js` | only via removed `validate`/`evaluate`/`iterate`/`burnup` | orphaned by 8a3 |
| `utils/spec-resolver.js:51` (`LEGACY_SPEC` fallback) | reachable from many removed commands | orphaned by 8a3 |
| `utils/quality-gates-utils.js:57` | only via removed `gates`/`quality-monitor` | orphaned by 8a3 |
| `validation/spec-validation.js:584` | only via removed `validate` | orphaned by 8a3 |
| `commands/status.js:26,507` | already dormant (legacy status not imported) | orphaned (file delete in 8e) |
| `commands/init.js:605,746` | already dormant (legacy init not imported) | orphaned (file delete in 8e) |
| `generators/working-spec.js` | imported by `index.js:80` AND **exported via `module.exports` (line 870-871)** as part of caws-cli public API | **8a3 must remove the module.exports block too** (public-surface breaking change consistent with A1) |
| `utils/finalization.js`, `error-handler.js`, `utils/detection.js`, `budget-derivation.js` | text/observation only (no writes) | acceptable |
| `session/session-manager.js:123` | only via removed `session` group | orphaned by 8a3 |

`detectCAWSSetup()` runs at startup (`config/index.js:29` ← `index.js:86`)
and reads `working-spec.yaml` existence as one of many capabilities. It
**does not write**. Acceptable for v11; cleaned by 8a3 import orphaning.

**Result: zero blockers. All active legacy authority paths are reachable
only via 8a3-removed commands.** One 8a3 note: `index.js:80` import +
`module.exports` block at lines 870-871 must be removed (public-API
breaking change for `generateWorkingSpec`/`validateGeneratedSpec`).

### Audit 3 — kernel purity drift

Grep for `fs`/`path`/`process.env`/`Date.now()`/`new Date(` across
`packages/caws-kernel/src/**/*.ts`. Hits classified:

- `evidence/validate.ts:274` — string content of an error message. Not
  executable. Acceptable.
- `doctor/types.ts:10`, `worktree/types.ts:18`, `worktree/index.ts:4` —
  comments. Not executable. Acceptable.
- `policy/derive-budget.ts:152, 160` — `new Date(string)` for ISO
  parsing. Deterministic input conversion, not clock access. Acceptable.
- **`policy/derive-budget.ts:150` — `if (now === undefined) return new Date()`.**
  Wall-clock fallback. **Blocker for invariant 3 ("kernel is pure").**

**Fix landed inline (8a2):**
- Made `DeriveBudgetOptions.now` required (`Date | string`, no `?`).
- Removed the wall-clock fallback in `resolveNow`; throws
  `deriveBudget: \`now\` is required` when called without `now`.
- Tightened the function signature: `options: DeriveBudgetOptions` (no
  default `{}`). Tests and callers already supply `now`; verified no
  call site relied on the implicit fallback.
- Kernel typecheck + 456/456 kernel tests still pass after the change.

### Audit 4 — hook/scaffold templates and other v11-shipped strings invoking removed commands

Two distinct surfaces:

**A. Kernel/shell user-facing repair strings** — these ship in v11 and
are emitted to users by v11 commands. Five strings pointed at removed
commands:

| File | Pre-fix | Post-fix |
|---|---|---|
| `shell/commands/claim.ts:121` | "Run \`caws worktree create <name>\` first." | "v11.0.0 does not ship worktree lifecycle commands; create externally and register, or pin to caws-cli@^10.2.x." |
| `kernel/doctor/inspect.ts:158` | repair points to `caws worktree create` | repair states v11 limitation, points to manual fix or v10 pin |
| `kernel/doctor/inspect.ts:193` | `caws worktree destroy` | edits .caws/worktrees.json directly, or v10 pin |
| `kernel/doctor/inspect.ts:231` | `caws worktree destroy/bind` | manual edit or v10 pin |
| `kernel/worktree/transitions.ts:82` | `caws worktree merge/destroy` | manual edit or v10 pin |
| `kernel/worktree/ownership.ts:76` | `caws worktree bind` | replaced with `caws claim` (which IS in v11) |
| `kernel/scope/evaluate.ts:82,96` | `caws worktree bind` | manual edit or v10 pin |

**Fix landed inline (8a2).** All v11-shipped user-facing strings now
either point to v11 commands or are explicit about v11.0.0 not shipping
the lifecycle command (and direct users to either the manual procedure
or the v10 pin).

**B. Templates shipped via `package.json:files` — `templates/` directory.**
116 invocations of removed commands across 30+ template files
(`.cursor/hooks/*.sh`, `.claude/hooks/*.sh`, `.cursor/rules/*.mdc`,
`.github/copilot-instructions.md`, `templates/CLAUDE.md`,
`templates/agents.md`, etc.). Templates are installed only by `caws
scaffold` (which is removed in 8a3); without a v11 installer, they are
unreachable from the v11 CLI surface. **However**, they still ship in
the npm tarball because `package.json:files` lists `"templates"`.

**Disposition:** flagged for **8b packaging slice** — remove `"templates"`
from `package.json:files` so v11 doesn't ship templates that reference
non-existent commands. Not a v11.0.0 cutover blocker but cosmetic
correctness.

### Audit 5 — docs/help advertising deprecated commands

Top-level docs (`README.md`, `CLAUDE.md`, `AGENTS.md`) and `docs/`
extensively reference the legacy command surface. None gate runtime
behavior; they are doc-rot.

| File | Status | Disposition |
|---|---|---|
| `README.md` | ships in npm tarball; advertises ~15 removed commands | **8b finding** (rewrite for v11 before publish) |
| `CLAUDE.md` | repo-only, agent-facing; references removed commands extensively | **8c finding** (rewrite as part of cutover) |
| `AGENTS.md` | repo-only | 8c finding |
| `docs/agents/full-guide.md`, `docs/agents/TUTORIAL.md`, `docs/agents/EXAMPLES.md` | extensive legacy refs | 8c / 8e |
| `docs/guides/hooks-and-agent-workflows.md`, `docs/guides/quality-gates-staged-files.md` | legacy refs | 8c / 8e |
| `docs/MIGRATION_GUIDE_V3.5.md`, `docs/DEPLOYMENT.md`, `docs/ROLLBACK.md`, `docs/agent-workflow-tools.md` | legacy refs | 8c / 8e |
| `docs/architecture/caws-vnext-command-surface.md` (this doc) | legitimately mentions removed commands in §3 "removed in v11" | acceptable (doctrine ownership) |

**Result: zero blockers; significant doc-rot deferred to 8b (`README.md`)
and 8c (`CLAUDE.md`, `AGENTS.md`, `docs/`).**

### Slice 8a2 summary

| Audit | Findings | Blockers fixed in 8a2 | Orphaned by 8a3 | Deferred to 8b/8c/8e |
|---|---|---|---|---|
| 1 — events.jsonl writers | 7 call sites + 1 dormant impl | 0 | 7 | 1 file (8e delete) |
| 2 — working-spec.yaml authority | 16 active sites | 0 | 16 (incl. public exports) | 0 |
| 3 — kernel purity | 1 wall-clock fallback | **1 (derive-budget.ts)** | 0 | 0 |
| 4 — v11-shipped strings + templates | 8 string sites + ~30 template files | **8 (claim.ts, doctor/inspect.ts ×3, worktree/transitions.ts, worktree/ownership.ts, scope/evaluate.ts ×2)** | 0 | templates → 8b |
| 5 — docs/help | extensive doc-rot | 0 | 0 | README → 8b; CLAUDE/docs → 8c/8e |
| **Total** | | **9 blockers, all fixed** | **23 orphans** | |

Verification after fixes (run from `caws-next` HEAD + 8a2 changes):
- `cd packages/caws-kernel && npx tsc --noEmit` clean
- `cd packages/caws-kernel && npx jest` → 456/456 pass
- `cd packages/caws-cli && npx tsc -p tsconfig.vnext.test.json --noEmit` clean
- `cd packages/caws-cli && npx jest tests/shell tests/store` → 232/232 pass
- `npx eslint 'src/**/*.{js,ts}' 'tests/**/*.{js,ts}'` clean
- `find packages/*/dist -name '*.ts' -not -name '*.d.ts'` empty (no source leak)

8a2 closes with:
- One kernel signature change (deriveBudget purity tightening — public
  API breaking but no internal caller relied on the omission).
- Eight user-facing string updates in v11-shipped repair guidance.
- Doc-only audit report (this section).
- No command registrations changed.
- No command removals.
- No compatibility aliases introduced.

---

## 8. References

- `packages/caws-kernel/` — pure logic
- `packages/caws-cli/src/store/` — I/O and snapshot composition
- `packages/caws-cli/src/shell/` — vNext command surface
- `packages/caws-cli/src/commands/` — legacy handlers (kept on disk for
  v11.0; deleted in v11.1 per Slice 8e)
- `packages/caws-cli/src/index.js` — registration; subject to Slice 8a3
  removals
- `.caws/events.jsonl` schema: `packages/caws-kernel/src/schemas/events/`
- Slice closure notes: see commits `52d6165`, `2ed4a6f`, `4286c20`,
  `157df5a`, `7dfd865`, `8f8ac56`, `2ed7435`, `8f33580`
