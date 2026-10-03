---
doc_id: doctor-current-state
authority: reference
status: active
title: Current state and logged reconciliation
owner: CAWS maintainers
updated: 2026-10-03
audience: contributor
---

# Current state and logged reconciliation

`caws status` and default `caws doctor` report current repair obligations.
Configured runtimes, recognized legacy logs and deliberate local hook growth are
inventory. Owner availability is activity, not permission to take over or an
obligation to delete a lane. Inspect these through `caws status --doctor --json`
(`inventory` and `activity`) or `caws doctor --data`. Unknown rules and errors
stay visible. Missing observations never establish absence.

Worktree history is replayed in event order. A later `worktree_untracked` or
`worktree_destroyed` discharges the preceding creation. Untracking explicitly
retains a physical checkout outside CAWS ownership; it does not prove a failed
creation. A subsequent creation of the same name starts a new lifecycle.
Ghost-registry pruning accounts for its preceding creation too.

Older creations without terminal events can be reconciled only when the registry
entry, spec binding, branch, directory and linked Git worktree are all observed
absent:

```sh
caws worktree prune --state verified-dead-creation --include lane-name --json
caws worktree prune --state verified-dead-creation --include lane-name --apply --json
```

The first command is read-only. The second revalidates under the lifecycle lock
and appends `worktree_pruned` with `h_class: verified_dead_creation`, the exact
creation sequence/hash, and observed branch/path. It does not delete files,
change bindings, rewrite prior events or claim the spec completed. Changed or
incomplete observations refuse the receipt. Repeating the plan after success has
no candidate; an old receipt cannot clear a later creation.

Waiver-use findings evaluate every cited gate event against recorded creation,
expiry, revocation, gate and spec bounds. Valid use followed by revocation is
ordinary history and generates no repair obligation. Invalid or unknown use
remains visible with the exact event and classification. This checks recorded
bounds; it does not independently authenticate the approver field.

Repair-plan items separate the action (`repair_available`, `decision_required`
or `investigation_required`), explanation, and executable `next_command`. The
command is null when no concrete command is supplied. Inventory and activity are
returned separately from repair items in JSON. No generic acknowledgment or
reviewed flag suppresses an unresolved finding.

For hook reconciliation, begin with `caws hooks list --surface codex --json` and
the corresponding command for every configured surface. Selection is not proof
of native execution. `caws hooks import --from-machine --plan --json`
inventories overrides and includes a reconciliation plan even when whole-import
is refused. Selective plans retain protected floor overrides and unresolved
helper dependencies. Moving a policy entry preserves its behavior; deciding that
behavior is superseded requires source and behavioral comparison first. See
[the Sterling investigation](sterling-machine-runtime-migration.md).
