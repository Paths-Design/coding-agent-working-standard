---
doc_id: quality-gates-deprecation
authority: architecture
status: active
title: Quality-gates package removal
owner: vNext rewrite team
updated: 2026-06-12
---

# Quality-gates package removal

`@paths.design/quality-gates` has been removed as a standalone CAWS package.
Safety work now lands in the hook-pack surface or the governed CAWS CLI
surfaces.

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
