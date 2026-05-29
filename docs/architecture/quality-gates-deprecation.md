---
doc_id: quality-gates-deprecation
authority: architecture
status: active
title: Quality-gates package deprecation
owner: vNext rewrite team
updated: 2026-05-29
---

# Quality-gates package deprecation

`@paths.design/quality-gates` is deprecated as a standalone CAWS package.
It remains in the repository for compatibility while the command-surface
decision for `caws gates run` is completed, but new safety work should land
in the hook-pack surface or the governed CAWS CLI surfaces.

The replacement posture is:

- Edit-time feedback lives in hook packs installed by
  `caws init --agent-surface claude-code`.
- Governed project state remains in `caws doctor`, `caws gates run`, and
  `caws evidence`.
- Hook-pack checks reimplement the load-bearing detection intent without
  importing, requiring, or shelling out to `packages/quality-gates`.
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
`quality-gates` as a non-owned release scope. A commit that only touches
`packages/quality-gates/` therefore does not publish `caws-cli`, and it
does not publish `quality-gates` without a future explicit release lane.

## Current State

`packages/quality-gates/README.md` and `package.json` carry source-level
deprecation notices. This is repo metadata only; it does not mutate npm
registry state for already-published versions.

`caws gates run` still exists in the v11 command surface. Its long-term
contract after quality-gates deprecation is owned by
`GATES-RUN-POST-QG-DOCTRINE-001`.
