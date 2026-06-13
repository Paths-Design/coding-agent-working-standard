---
doc_id: quality-gates-guide
authority: guide
status: active
title: Quality gates in v11
owner: vNext rewrite team
updated: 2026-05-29
audience: consumer
---

# Quality gates in v11

`@paths.design/quality-gates` has been removed from the repository package
graph. Do not build workflows around the former standalone batch-scanner
package.

Use the v11 surfaces instead:

- `caws init --agent-surface claude-code` or
  `caws init --agent-surface codex` installs advisory hook-pack checks for
  edit-time feedback.
- `caws gates run --spec <id>` remains the governed policy/evidence runner.
- `caws doctor` reports CAWS state drift and structure findings.
- `caws evidence record` captures typed evidence for tests, gates, and
  acceptance criteria.

The removal rationale and release incident record live in
`docs/architecture/quality-gates-deprecation.md`.
