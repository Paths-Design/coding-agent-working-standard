# Migrating from CAWS v10.2 to v11.1

**v11.1 is the canonical CAWS line for new work. It is not a drop-in replacement for every v10.2 workflow.**

If you are starting a new project, use v11.1.x. If you are running a stateful v10.2 repo today, read this guide before upgrading — some commands you depend on have been removed, some renamed, and some are deferred to a later release.

This guide does not promise compatibility. It documents the gap, the workarounds, and the rollback path.

---

## What v11 is and is not

**v11.1 is** a complete rewrite of the CAWS governance core onto the kernel/store/shell architecture. The 10 governed-core command groups (`init`, `doctor`, `status`, `scope`, `claim`, `gates`, `evidence`, `waiver`, `specs`, `worktree`) are stable, hardened with lifecycle-transaction discipline, and operationally proven on the project's own self-hosted use.

**v11.1 is not** a compatibility shim over v10.2. A meaningful fraction of the v10.2 surface has been removed without replacement; another fraction is deferred to v11.2 or v11.3+. If your team relies daily on the removed surfaces, this upgrade is operational work, not a version bump.

This guide is the operational doctrine for traversing that gap.

---

## Bucket map: what happened to every v10.2 command

Every v10.2 command falls into exactly one of four buckets.

### Replaced (different name, equivalent or stronger capability)

| v10.2 command | v11.1 replacement | Notes |
|---|---|---|
| `caws validate` / `caws verify` | `caws doctor && caws gates run --spec <id>` | `doctor` does drift detection over `.caws/` state; `gates run` does policy-driven quality gates. The v10.2 conflation of both into one command is gone. |
| `caws diagnose` | `caws doctor` | Direct rename; same drift-detection responsibility. Exit codes: 0 clean, 1 findings, 2 composition failure. |
| `caws hooks install` | `caws init --agent-surface claude-code` | Hook-pack adoption is now an init concern, not a separate command. The hook pack is the install surface; mid-session install requires a session restart to activate. |
| `caws provenance` | `caws evidence record --type <test\|gate\|ac> --spec <id> --data <json>` + the hash-chained `.caws/events.jsonl` | The provenance shape changed. v10.2 scripts that read provenance command output will fail; the new audit surface is the events.jsonl chain. |
| `caws scaffold` | `caws init` | Folded into `caws init`'s idempotent re-init flow. Previously misclassified under "Removed without replacement" — corrected by `CAWS-REMOVED-COMMAND-DIAGNOSTICS-001`. The matrix at `docs/v11-surface-matrix.yaml` always classified `scaffold` as `replaced`; this row reconciles the doc to the matrix. |

### Renamed (cosmetic; scripts will break on the old name)

| v10.2 command | v11.1 name |
|---|---|
| `caws archive <id>` | `caws specs archive <id>` |
| `caws waivers` (plural) | `caws waiver` (singular) |

CI pipelines or scripts invoking the old names will fail with "unknown command." Update the call sites.

### Removed without replacement (genuine capability loss in v11.1)

The following v10.2 commands are **not present in v11.1 and have no v11.1 replacement**. v11.1 intentionally prioritizes governed lifecycle and release safety over advisory-report parity. Teams depending on these commands daily should either stay on v10.2.x, or treat replacement design as separate adoption work.

| v10.2 command | What it did | Recommendation |
|---|---|---|
| `caws sidecar drift` | Compared spec intent vs. current implementation | Stay on v10.2 OR rebuild as an external tool over the v11 events.jsonl |
| `caws sidecar gaps` | Diagnosed quality gaps blocking gate passage | Use `caws gates run` output and trace the failed gate manually |
| `caws sidecar provenance` | Summarized work history for merge readiness | Read `.caws/events.jsonl` directly (it is hash-chained and human-readable) |
| `caws sidecar waiver-draft` | Generated pre-filled waiver template | `caws waiver create --help` provides the flag surface; no template generator |
| `caws burnup` | Budget burn-up reports for scope visibility | Stay on v10.2 OR derive from `caws status` + spec `change_budget` manually |
| `caws verify-acs` | Verified acceptance criteria have test evidence | Stay on v10.2 OR encode AC-evidence assertions in your test suite directly |
| `caws evaluate` | Evaluated work against quality standards | `caws gates run` covers policy gates; quality-evaluation reports are not reproduced |
| `caws iterate` | Iterative development guidance | Advisory-only; no v11 equivalent. Use the spec's acceptance criteria as guidance |
| `caws workflow <type>` | Workflow-specific guidance | Documentation-driven now; no command surface |
| `caws quality-monitor` | Real-time quality impact monitoring | Not present in v11.1 |
| `caws test-analysis` | Statistical analysis for budget prediction | Not present in v11.1 |
| `caws tool <id>` | Generic tool runner | Niche utility; not present in v11.1 |
| `caws templates discover/manage` | Template discovery | Hook-pack install is now the only template surface |
| `caws mode` | Complexity-tier management | Not present in v11.1 |
| `caws tutorial` | Interactive guided learning | Doc-driven now |
| `caws plan` | Implementation-plan generation | Not present in v11.1 |

**Policy statement:** v11.1 intentionally prioritizes governed lifecycle and release safety over advisory-report parity. Advisory tools removed from v10.2 are not compatibility shims in v11.1. Teams depending on them should either stay on v10.2.x or treat replacement design as separate adoption work.

If the long-term decision is to rebuild any of these surfaces in v11.x, that work belongs in a separate spec (see `CAWS-ADVISORY-SURFACE-POLICY-001` if it is filed in the future). The migration guide does not resolve that decision.

### Deferred (planned for v11.2 or v11.3+)

| v10.2 command | Status in v11.1 | Workaround |
|---|---|---|
| `caws session` | Deferred to v11.3+ | Multi-agent session capsules are deferred; per-worktree binding remains the v11 isolation primitive |
| `caws parallel setup` | Deferred to v11.3+ | Loop `caws worktree create <name> --spec <id>` per spec; there is no orchestration command in v11.1 |
| `caws worktree prune` / `caws worktree repair` / `caws worktree reconcile` | Planned for v11.2 | `caws status` shows worktree state; manual cleanup via `git worktree` directly |

> **Note:** `caws agents list` and `caws agents show` are **shipped in v11.1.x**, not deferred — they were earlier planned for v11.2 but landed ahead of schedule. See the "Shipped ahead of plan" note below. The broader v11.2 multi-agent line (lease-backed ownership, the `claim_taken_over.v1` event) is still forthcoming.

**Multi-agent operators**: if you rely daily on `caws session` or `caws parallel`, defer the upgrade until those land (v11.3+). `caws agents list/show` already ship in v11.1.x, so they are not a reason to defer. Single-agent users are unaffected.

---

## CI migration recipes

Concrete before/after for the v10.2 commands most commonly invoked from CI pipelines.

### Replacing `caws validate`

```yaml
# Before (v10.2):
- name: Validate spec
  run: caws validate --spec-id MY-FEATURE-001

# After (v11.1):
- name: Drift check
  run: caws doctor
- name: Quality gates
  run: caws gates run --spec MY-FEATURE-001
```

Notes:
- `caws doctor` exits 0 on clean, 1 on findings, 2 on composition failure.
- `caws gates run` appends one `gate_evaluated` event per declared gate to `.caws/events.jsonl`.
- Wire each as a separate step so failures are localized.

### Replacing `caws waivers list`

```yaml
# Before:
- run: caws waivers list

# After:
- run: caws waiver list
```

Same applies to `caws waivers create/show/revoke`.

### Replacing `caws archive <id>`

```yaml
# Before:
- run: caws archive MY-FEATURE-001

# After:
- run: caws specs archive MY-FEATURE-001
```

The v11 `caws specs archive` moves the spec file to `.caws/specs/.archive/`, flips `status: archived`, bumps `updated_at`, updates the registry, and emits a hash-chained `spec_archived` event.

### Replacing `caws diagnose`

```yaml
# Before:
- run: caws diagnose

# After:
- run: caws doctor
```

`caws doctor` is the v11 drift-detection surface. Same exit semantics as v10.2's `diagnose` (0 clean, 1 findings).

### Replacing `caws provenance`

There is no direct command replacement. The v11 audit surface is `.caws/events.jsonl` (hash-chained). If your CI parsed `caws provenance` output:

```yaml
# Before:
- run: caws provenance --since-tag v1.0.0

# After (read the events log directly):
- run: |
    jq -r '. | select(.type == "spec_closed" or .type == "worktree_merged") | "\(.timestamp) \(.type) \(.data)"' \
      .caws/events.jsonl
```

The events.jsonl chain is the canonical provenance surface in v11. Each event has a hash linking to the previous event; tampering with prior events breaks the chain.

### Replacing `caws hooks install`

```yaml
# Before:
- run: caws hooks install

# After:
- run: caws init --agent-surface claude-code
```

Note: v11's hook-pack install requires a session restart to activate. The pack is not loaded mid-session.

---

## Legacy state migration

### The `.caws/working-spec.yaml` singleton

v10.2 supported a single project-level working spec at `.caws/working-spec.yaml`. v11 does not. Every spec is per-feature at `.caws/specs/<id>.yaml`.

If your project has a singleton:

```bash
# 1. Decide what the singleton represents:
#    - Active work? Convert it to a feature spec.
#    - Historical baseline? Archive it.
#    - Defunct? Delete it.

# 2a. If it's active work — extract its content into a new feature spec:
caws specs create MY-CURRENT-WORK-001 --type feature --title "..." 
# Then copy scope.in / scope.out / acceptance from .caws/working-spec.yaml
# into the new file, adjust to v11 schema (no scope.out globs, contracts
# required for tier 2, etc. — see CLAUDE.md authoring traps).

# 2b. If it's historical:
#    Delete .caws/working-spec.yaml manually. There is no convert command.

# 3. Run caws init:
caws init
# It is idempotent for canonical v11 state. It will refuse to run while
# the legacy singleton is still in place — that refusal is by design,
# not a bug.
```

### `.caws/worktrees.json` shape

The v11 CLI reads both shapes: v10 (`{"worktrees": {"<name>": {...}}}`) and v11 (`{"<name>": {...}}`). All v11 lifecycle commands (`caws worktree create/list/bind/destroy/merge`) write the v11 direct-key shape. The hook-pack helper (`session-caws-status.sh`'s `entriesOf`) also reads both.

#### Asymmetry: v10.2 CANNOT read v11-shaped registries

This is a one-way migration with respect to `caws worktree merge` (and the legacy worktree subcommands). Once a v11 CLI has written `.caws/worktrees.json` in the direct-key shape, the v10.2 CLI's `loadRegistry` will reject it. The failure surfaces as:

```
$ caws worktree merge <name> --dry-run
Worktree registry has schema violations: [
  { path: '', message: "must have required property 'version'", ... },
  { path: '', message: "must have required property 'worktrees'", ... },
  { path: '', message: 'must NOT have additional properties',
    params: { additionalProperty: '<name>' }, ... },
  ...
]
Cannot read properties of undefined (reading '<name>')
```

This is the documented failure mode behind `WORKTREE-MERGE-V11-SHAPE-001` and is a property of the legacy artifact, not the source tree.

**If you see this output, your `which caws` is resolving to a v10.2 install.** The fix is to upgrade:

```bash
npm install -g @paths.design/caws-cli@latest
```

The v11 CLI handles the same registry without error; the regression is locked by `packages/caws-cli/tests/store/worktree-merge-v11-shape.test.js`.

### `.caws/events.jsonl`

v11's hash-chained events.jsonl is forward-compatible with v10.2's append-only log. v11 will read the existing log and continue appending. Pre-v11 events without hash links are tolerated; the chain begins from the first v11-emitted event.

If you want a clean chain start:

```bash
# Optional: archive the pre-v11 log and start fresh
mv .caws/events.jsonl .caws/events-pre-v11.jsonl.bak
```

(Tracked under `EVENTS-LEGACY-ARCHIVE-001` if a programmatic command is desired in the future.)

---

## Lite mode retirement (v11.1 hook pack v8+)

**What lite mode was.** In v10.2, `caws init --mode lite` created a thinner alternative to the full per-feature spec workflow. Instead of `.caws/specs/*.yaml`, lite-mode projects had:

- `.caws/mode.json` — `{ "current": "lite", "initialized": true }`
- `.caws/scope.json` — a single project-wide allowlist/blocklist (`allowedDirectories`, `bannedPatterns.files`, `bannedPatterns.docs`, `maxNewFilesPerCommit`)

The Claude Code hook pack's `scope-guard.sh` had a fallback branch: if no `.caws/specs/` directory existed AND `.caws/scope.json` did, the hook would enforce the lite-mode rules instead.

**Why it was removed.** v11 has one governance model: per-feature specs under `.caws/specs/`. The lite-mode CLI surface (`caws lite`, `caws mode`, `caws scaffold`) was removed in v11.0. But the runtime hook pack kept silently enforcing `.caws/scope.json` rules through pack v7, creating a half-decommissioned state: the CLI couldn't create or manage lite-mode projects, but the hooks would still respect a legacy `.caws/scope.json` if one was on disk. That divergence ("the hook says lite is in effect; `caws doctor` says there are no specs") was the kind of authority-split this whole rewrite exists to prevent.

Pack v8 finishes the retirement. `scope-guard.sh` no longer reads `.caws/scope.json`. Consumers with a legacy file get a doctor finding instead.

**What to do with a legacy `.caws/mode.json`.** Delete it. v11 has no equivalent. The file is operational cache from v10; removing it has no behavioral effect on a v11 project that already has `.caws/specs/`.

```bash
# If you can confirm you no longer rely on lite-mode:
rm .caws/mode.json
```

**What to do with a legacy `.caws/scope.json`.** Assess case by case. Some Sterling-era projects use `.caws/scope.json` as a Python/Rust-friendly scope hint that pre-dates the `.caws/specs/scope.in` mechanism. v11 derives scope from `.caws/specs/<id>.yaml:scope.in` directly. If you have an active v11 project (`.caws/specs/*.yaml` exists), the `scope.json` file is now ignored by both the CLI and the hooks; it can be deleted or kept as historical reference.

```bash
# If .caws/specs/ exists and you are fully on v11 workflows:
rm .caws/scope.json

# If you want to preserve the v10-era intent for reference:
git mv .caws/scope.json docs/historical/v10-scope.json
```

**What is NOT changed by this retirement:**

- v11 per-feature specs under `.caws/specs/` are unaffected.
- `caws gates run`, `caws scope check`, `caws scope show` continue to work as before.
- Existing Sterling-era projects with both `.caws/specs/` AND `.caws/scope.json` were already on the v11 path (the lite branch never fired when specs existed); the only change for them is potentially a doctor finding on `mode.json` if it is present on disk.

**What breaks if you actually depended on lite mode itself:**

If your project relied on the lite-mode hook behavior (you don't have `.caws/specs/`, you only have `.caws/scope.json`), v8 will make scope-guard.sh exit silently. You will lose the lite-mode banned-pattern and allowed-directories enforcement. The migration path is to author per-feature specs:

```bash
caws specs create FEAT-001 --title "Initial v11 spec" --mode chore --risk-tier 3
# Then edit .caws/specs/FEAT-001.yaml to populate scope.in based on
# the directory list that was previously in .caws/scope.json:allowedDirectories.
```

Sterling and full-stack-ds are not in this position; they have specs. A consumer that adopted v10 lite mode and never moved to specs would feel this change. The doctrine on this is intentional: lite mode could not survive into v11 because v11's authority model is per-spec, and the v10 lite shape has no equivalent.

---

## The rollback path

If you upgrade and hit a blocker — a missing command, an unexpected gate failure, multi-agent observability you cannot live without — you can pin back to v10.2 immediately.

```bash
npm install -g @paths.design/caws-cli@^10.2
```

**Committed state survives the round trip.** Specifically:

- `.caws/specs/*.yaml` files: v11 spec format is a superset of v10.2's; v10.2 will read v11-authored specs (with some warnings about unknown fields like the v11 `lifecycle_state` or `contracts` arrays).
- `.caws/events.jsonl`: append-only; v10.2 can read it.
- `.caws/worktrees.json`: the v11 CLI reads both shapes. The v10.2 CLI accepts the v10 nested shape only — see the "Asymmetry" note above. If you have created any worktrees under v11, pin-back will require converting `.caws/worktrees.json` to the v10 nested shape (wrap entries in `{"version": 1, "worktrees": {...}}`) for v10.2 to read it. The forward direction does not require conversion.
- `.caws/policy.yaml`: schema-compatible.
- `.caws/waivers/`: v11 uses singular `waiver`; the v10.2 plural `waivers` directory still works.

What does NOT survive cleanly:

- Specs authored with v11-only fields (e.g., `lifecycle_state: active`, `contracts: [...]`) will load in v10.2 but with field warnings. They remain readable.
- Hash-chained events emitted by v11 are still valid JSONL lines in v10.2; v10.2 just won't verify the chain.

If you pin back, no manual cleanup is required. You can re-upgrade to v11.1 later without data migration work.

---

## Decision flowchart

```
Is your project new (no existing .caws/ state)?
  YES → Use v11.1.x. This is the canonical line. ✓
  NO  → Continue.

Does your team rely DAILY on any of:
  caws sidecar / burnup / verify-acs / evaluate / test-analysis ?
  YES → Stay on v10.2.x for now. There is no v11.1 replacement.
        File a feature request if you want them rebuilt.
  NO  → Continue.

Does your team rely DAILY on multi-agent commands:
  caws session / caws parallel ?
  (caws agents list/show already ship in v11.1.x — not a defer trigger.)
  YES → Defer the upgrade until those land (v11.3+).
        Single-agent or low-frequency multi-agent users can proceed.
  NO  → Continue.

Does your CI invoke any of:
  caws validate / caws diagnose / caws waivers / caws archive /
  caws provenance / caws hooks install ?
  YES → Update CI per the recipes above BEFORE upgrading.
  NO  → Continue.

Do you have a `.caws/working-spec.yaml` singleton?
  YES → Convert or archive it per "Legacy state migration" BEFORE
        running `caws init` on v11.
  NO  → Continue.

Upgrade. If you hit a blocker, pin back to v10.2 with the rollback
one-liner. Committed state survives.
```

---

## Project doctrine drift: CLAUDE.md, agents.md, and hooks

The CLI surface migration is necessary but not sufficient. Two failure
modes show up in projects that initialized on caws-cli 10.x and then
upgraded to 11.x:

1. **Stale doctrine in project root.** `caws init` lays down a
   `CLAUDE.md` and `agents.md` at project root from
   `packages/caws-cli/templates/`. The 10.x templates referenced
   `caws validate`, `caws iterate`, `caws verify-acs`, `caws burnup`,
   `caws specs create --type feature`, and `caws validate --spec-id <id>`
   — all of which are removed or renamed in v11. Upgrading the CLI does
   not rewrite those project files, and CLAUDE.md is exactly the surface
   AI agents read first. Future agents in those projects will keep
   citing v10 commands that no longer exist.

2. **Stale hook copies trapped inside linked worktrees.** v11
   `caws init --agent-surface claude-code` installs the canonical hook
   pack from `packages/caws-cli/templates/hook-packs/claude-code/`. But
   a linked worktree gets a snapshot of `.claude/hooks/` at
   worktree-create time. If the worktree was created before the upstream
   hook fix landed, the worktree's hooks are frozen at the broken
   shape — even after main is fixed. The worktree's session walks
   `git rev-parse --git-common-dir` to find canonical CAWS state, but
   it runs its own `.claude/hooks/*.sh` for tool-call admission, and
   those don't get re-snapshotted.

### Symptom: scope-guard falls into union mode

The most common signal is an agent inside a bound worktree getting
strike-1 / strike-3 blocks against files that `caws scope show <path>`
confirms are admitted. The kernel-side scope-show CLI reports
`binding: bound`, but the bash hook still reports `Mode: union (no
authoritative spec bound)` and applies an unrelated sibling spec's
`scope.out` to the edit.

Root cause: the hook reads `.caws/worktrees.json` under v10 envelope
shape `{worktrees: {<name>: {...}}}` while the registry has already
been migrated to v11 flat-map `{<name>: {...}}` by
`caws worktree migrate-registry`. The envelope lookup returns
undefined, the registry-binding lookup fails silently, and the hook
falls back to union mode.

### Migration recipe for downstream projects

Sterling — the canonical reference downstream — landed this work in
the following commit chain (`/Users/darianrosebrook/Desktop/Projects/sterling`):

| Concern | Sterling commit prefix | What changed |
|---|---|---|
| policy.yaml + per-edit gates run | `chore(caws): land CAWS-1117-COMPAT-BOOTSTRAP-01` | policy.yaml gate-vocabulary; hook switches from removed `caws quality-gates` to v11 `caws gates run --spec <id> --context commit`; bootstrap-failure-vs-violation discipline. |
| events.jsonl rotation | `chore(caws): land CAWS-1117-EVENT-LOG-COMPAT-RECON-01` | Truncate to empty + preserve old log at `.bak` and `.archive-<ts>`. v11's allowed event enum does not include `chain_rotated`; new chain starts at seq:1 with `prev_hash:null` on the next append. |
| worktrees.json registry shape | `chore(caws): land CAWS-1117-WORKTREE-REGISTRY-CLEAN-01` | `caws worktree migrate-registry` from v10 envelope to v11 flat-map + disk cleanup of zombie destroyed-record directories. |
| Waivers schema | `chore(caws): land CAWS-1117-WAIVER-SCHEMA-RECON-01` | Per-file `.caws/waivers/<WV-NNNN>.yaml` shape; expired waivers transitioned to `status: revoked` with `revocation:` records. |
| Hook pack install (v11) | `chore(caws): land CAWS-1117-HOOK-PACK-INSTALL-01` | Removed legacy `.caws/working-spec.yaml`; ran `caws init --agent-surface claude-code --adopt`; patched `--delete-branch` flag refs. |
| Hook dual-shape cascade | `chore(caws): land CAWS-1117-V11-HOOK-DRIFT-MERGE-01` | Repaired 6 `Object.values(reg.worktrees || {})` callsites across 4 hooks that silently went blind after the registry migration. |
| Waiver gate vocabulary | `chore(caws): land CAWS-1117-WAIVER-GATE-VOCAB-RECON-01` | Mapped 10 waivers' 8 v10/Sterling-custom gate names to v11 enum. |
| Spec schema bulk migrate | `chore(caws): land CAWS-1117-SPEC-SCHEMA-MIGRATE-01` | 67 of 68 specs migrated to v11: status→lifecycle_state, type→mode, acceptance_criteria→acceptance, change_budget removed, content preserved into closure_notes. |
| Doctrine rewrite | `docs(caws): rewrite Sterling CAWS doctrine surfaces to v11.1.7` | Sterling's `CLAUDE.md`, `.claude/README.md`, `.claude/rules/worktree-isolation.md` rewritten — removes `--spec-id`, `caws validate`, `caws iterate`, `caws specs conflicts`, `caws parallel setup`, etc. |
| Lib extraction + scope-guard fix | `refactor(hooks): extract dual-shape CAWS state helpers to lib/caws-state.sh` | Factored the dual-shape reader and canonical-dir resolver into `.claude/hooks/lib/caws-state.sh`. Single source of truth for v10/v11 readers eliminates the "missed one of N callsites during a schema migration" bug class. |

Roughly: assume one half-day of work per downstream project for the
full migration. Smaller projects can skip the bulk-spec migration
(specs that never break the v11 schema don't need rewrites).

### What this guide will NOT do for you

The CAWS CLI does not currently rewrite project-level `CLAUDE.md` or
`agents.md` on upgrade. If your project initialized on 10.x:

- Re-running `caws init` will refuse on legacy residue (`.caws/working-spec.yaml`).
- `caws init --agent-surface claude-code --adopt` will preserve your
  existing hook customizations but will not touch root-level docs.
- Manual rewrite is required for `CLAUDE.md`/`agents.md`. Sterling's
  v11.1.7 doctrine commits (above) are a working reference.

A future surface (`caws init --refresh-doctrine` or `caws doctor
--doctrine-drift`) could automate this; it does not exist yet. If you
want it, please file an issue against the upstream caws repo with the
specific stale-command grep patterns your project encountered.

## Open follow-up work

The following are tracked in `.caws/specs/` and may close additional gaps as they ship:

- `CAWS-CLI-BIN-EXECUTABLE-BIT-001` — workspace-install `chmod +x` defect (not user-facing in normal `npm install -g` flow).
- `DANGER-LATCH-CALIBRATION-001` — calibrates the Claude Code hook pack's command classifier (only relevant if you adopted the hook pack via `caws init --agent-surface claude-code`).
- `WORKTREE-MERGE-A2-FAULT-INJECTION-001` — adds an automated regression for the merge → spec-close honest-failure path (closes a manual-proof gap, not a behavior gap).
- `PRUNE-REPAIR-WORKTREE-001` — restores `caws worktree prune/repair/reconcile` ergonomics on the v11 substrate.
- `AUTH-BINDING-BRIDGE-001` — agent-session binding for non-worktree contexts (closes part of the multi-agent observability gap below).

`caws agents list/show` shipped ahead of plan in v11.1.x (alongside the `agents register/heartbeat/stop/prune` operational verbs). The remaining v11.2 surface (planned, not shipped) will add `caws claim --spec`, worktree lifecycle helpers (`prune/repair/reconcile`), and the `claim_taken_over.v1` event. v11.3+ scope includes the deferred `caws session` and `caws parallel` surfaces.

`caws agents list/show` is no longer a reason to wait — it ships in v11.1.x. If `caws session` or `caws parallel` is the blocker for your team, that is the v11.3+ line to wait for.

---

## Reaching this guide from removed-command errors

Currently, running a removed v10.2 command on v11.1 produces a generic "unknown command" error. Improving the error-handler to direct users to this guide is tracked as a separate follow-up (`DOC-REMOVED-COMMAND-ERRORS-001`, not yet filed). Until then, this guide is reachable via:

- The repo's `docs/migration-v10-to-v11.md` (this file).
- The repo's CLAUDE.md (it links here).
- The repo README (it should link here after this slice merges).
- GitHub repo search: `gh search prs --repo Paths-Design/coding-agent-working-standard migration v10-to-v11`.

---

## Provenance

This guide was authored as part of `DOC-MIGRATION-V10-TO-V11-001`, an active tier-2 doc spec landed after `CAWS-RELEASE-TAG-DRIVEN-001` v1 (the tag-driven release rewrite). The readiness review that triggered this guide is recorded in the conversation log preceding the spec's activation.

The four-bucket classification (Replaced / Renamed / Removed-without-replacement / Deferred) is intentional: it forces every v10.2 command into an explicit category, so no surface is unaddressed and no surface is overclaimed.

Last verified against:
- `@paths.design/caws-cli@11.1.7` (current npm latest as of 2026-05-27)
- main branch HEAD `2e4b7ab` (post-release-tag-driven merge + spec closure)
- Downstream reference: Sterling repo's CAWS-1117-* migration commit chain (2026-05-26)
  documented in the "Project doctrine drift" section above.
