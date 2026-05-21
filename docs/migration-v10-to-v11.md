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
| `caws scaffold` | Added CAWS components to existing project | Folded into `caws init`'s idempotent re-init flow |
| `caws mode` | Complexity-tier management | Not present in v11.1 |
| `caws tutorial` | Interactive guided learning | Doc-driven now |
| `caws plan` | Implementation-plan generation | Not present in v11.1 |

**Policy statement:** v11.1 intentionally prioritizes governed lifecycle and release safety over advisory-report parity. Advisory tools removed from v10.2 are not compatibility shims in v11.1. Teams depending on them should either stay on v10.2.x or treat replacement design as separate adoption work.

If the long-term decision is to rebuild any of these surfaces in v11.x, that work belongs in a separate spec (see `CAWS-ADVISORY-SURFACE-POLICY-001` if it is filed in the future). The migration guide does not resolve that decision.

### Deferred (planned for v11.2 or v11.3+)

| v10.2 command | Status in v11.1 | Workaround |
|---|---|---|
| `caws agents list` / `caws agents show` | Planned for v11.2 | Read `.caws/agents.json` and `.caws/worktrees.json` directly |
| `caws session` | Deferred to v11.3+ | Multi-agent session capsules are deferred; per-worktree binding remains the v11 isolation primitive |
| `caws parallel setup` | Deferred to v11.3+ | Loop `caws worktree create <name> --spec <id>` per spec; there is no orchestration command in v11.1 |
| `caws worktree prune` / `caws worktree repair` / `caws worktree reconcile` | Planned for v11.2 | `caws status` shows worktree state; manual cleanup via `git worktree` directly |

**Multi-agent operators**: if you rely daily on `caws agents list/show`, `caws session`, or `caws parallel`, defer the upgrade until v11.2 ships. Single-agent users are unaffected.

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

Both v10 (`{"worktrees": {"<name>": {...}}}`) and v11 (`{"<name>": {...}}`) shapes are accepted by the v11 hook-pack reader. No conversion required.

### `.caws/events.jsonl`

v11's hash-chained events.jsonl is forward-compatible with v10.2's append-only log. v11 will read the existing log and continue appending. Pre-v11 events without hash links are tolerated; the chain begins from the first v11-emitted event.

If you want a clean chain start:

```bash
# Optional: archive the pre-v11 log and start fresh
mv .caws/events.jsonl .caws/events-pre-v11.jsonl.bak
```

(Tracked under `EVENTS-LEGACY-ARCHIVE-001` if a programmatic command is desired in the future.)

---

## The rollback path

If you upgrade and hit a blocker — a missing command, an unexpected gate failure, multi-agent observability you cannot live without — you can pin back to v10.2 immediately.

```bash
npm install -g @paths.design/caws-cli@^10.2
```

**Committed state survives the round trip.** Specifically:

- `.caws/specs/*.yaml` files: v11 spec format is a superset of v10.2's; v10.2 will read v11-authored specs (with some warnings about unknown fields like the v11 `lifecycle_state` or `contracts` arrays).
- `.caws/events.jsonl`: append-only; v10.2 can read it.
- `.caws/worktrees.json`: both shapes accepted by both versions.
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
  caws agents list/show / caws session / caws parallel ?
  YES → Defer the upgrade until v11.2 ships (agents inspection).
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

## Open follow-up work

The following are tracked in `.caws/specs/` and may close additional gaps as they ship:

- `CAWS-CLI-BIN-EXECUTABLE-BIT-001` — workspace-install `chmod +x` defect (not user-facing in normal `npm install -g` flow).
- `DANGER-LATCH-CALIBRATION-001` — calibrates the Claude Code hook pack's command classifier (only relevant if you adopted the hook pack via `caws init --agent-surface claude-code`).
- `WORKTREE-MERGE-A2-FAULT-INJECTION-001` — adds an automated regression for the merge → spec-close honest-failure path (closes a manual-proof gap, not a behavior gap).
- `PRUNE-REPAIR-WORKTREE-001` — restores `caws worktree prune/repair/reconcile` ergonomics on the v11 substrate.
- `AUTH-BINDING-BRIDGE-001` — agent-session binding for non-worktree contexts (closes part of the multi-agent observability gap below).

The v11.2 surface (planned, not shipped) will add `caws agents list/show`, `caws claim --spec`, worktree lifecycle helpers, and the `claim_taken_over.v1` event. v11.3+ scope includes the deferred `caws session` and `caws parallel` surfaces.

If `caws agents list/show` is the blocker for your team, v11.2 is the version to wait for, not v11.1.

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
- `@paths.design/caws-cli@11.1.4` (current npm latest)
- main branch HEAD `2e4b7ab` (post-release-tag-driven merge + spec closure)
