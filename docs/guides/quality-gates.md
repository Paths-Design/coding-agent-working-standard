---
doc_id: quality-gates-guide
authority: guide
status: active
title: Quality gates in v11
updated: 2026-05-29
---

# Quality gates in v11

`@paths.design/quality-gates` is deprecated. Do not build new workflows
around the standalone batch-scanner package.

Use the v11 surfaces instead:

- `caws init --agent-surface claude-code` installs advisory hook-pack checks
  for edit-time feedback.
- `caws gates run --spec <id>` remains the governed policy-gate runner until
  `GATES-RUN-POST-QG-DOCTRINE-001` lands.
- `caws doctor` reports CAWS state drift and structure findings.
- `caws evidence record` captures typed evidence for tests, gates, and
  acceptance criteria.

The deprecation rationale and release incident record live in
`docs/architecture/quality-gates-deprecation.md`.
