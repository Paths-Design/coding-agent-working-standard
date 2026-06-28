---
doc_id: quality-gates-deprecation
authority: architecture
status: active
title: Quality-gates package removal
owner: vNext rewrite team
updated: 2026-06-28
---

# Quality-gates package removal

`@paths.design/quality-gates` has been removed as a standalone CAWS package.
Safety work now lands in the hook-pack surface or the governed CAWS CLI
surfaces.

## Why it was retired

The standalone batch-scanner was retired for a **timing** reason, not a
capability reason. Its checks only ran when an operator invoked
`caws gates run`, so an agent writing or growing a module received no
feedback in the loop where the decision was being made — the signal
existed, but its timing was wrong for agent-driven workflows. The
god-object and todo-detection gates both taught this lesson (recorded in
`docs/failure-lineage.md`).

The hook-pack surface replaced it by firing checks where agent harnesses
actually operate: **PostToolUse on Write/Edit**. The four
`QG-HOOKS-EXTRACT-001` advisory hooks reimplement the load-bearing
detection intent of the old gates at edit time, with no runtime coupling
to any external quality package:

| Hook | Replaces (old gate intent) |
|---|---|
| `god-object-check.sh` | `god_object` — SLOC against warning/critical thresholds |
| `shortcut-language-check.sh` | `todo_detection` — TODO/FIXME/placeholder/"not implemented" stubs |
| `duplicate-export-check.sh` | shadowed-export detection on new-file Write |
| `loc-delta-check.sh` | large per-edit growth (advisory; never blocks) |

Install them with `caws init --agent-surface claude-code|codex`. Governed
policy/evidence still runs out-of-band via `caws gates run --spec <id>`.

The replacement posture is:

- Edit-time feedback lives in hook packs installed by
  `caws init --agent-surface claude-code`.
- Governed project state remains in `caws doctor`, `caws gates run`, and
  `caws evidence`.
- Hook-pack checks implement the load-bearing edit-time quality checks without
  importing, requiring, or shelling out to an external quality package.
- Registry-side npm deprecation is not part of this change. Existing
  published versions remain installable.

## Incident Record

On 2026-05-18, a `fix(quality-gates): ...` commit triggered an unintended
`@paths.design/caws-cli@11.1.2` publish through the branch-push
semantic-release path. The problem was release governance, not a runtime
need to republish the CLI. The version is not unpublished or reused; it is
left as a known historical artifact because npm version reuse is forbidden
and unpublishing would create more ambiguity than it removes.

The repository has since moved to tag-driven `caws-cli` publishing. The
legacy multi-package release script now contains only
`@paths.design/caws-cli` in its package list, and it explicitly denies
`quality-gates` as a non-owned release scope.

## Current State

The repository no longer contains `packages/quality-gates/`, no root script
invokes it, and `@paths.design/caws-cli` no longer depends on it.

`caws gates run` still exists in the v11 command surface. Its long-term
contract after quality-gates removal is the governed policy/evidence runner:
local evaluators produce CAWS policy violations, policy decides disposition,
and the command appends `gate_evaluated` evidence.
