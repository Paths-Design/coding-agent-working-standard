---
doc_id: caws-cli-api-reference
authority: reference
status: active
title: CAWS CLI workflows and option semantics
owner: CAWS maintainers
updated: 2026-09-07
audience: consumer
---

# CAWS CLI workflows and option semantics

Install `@paths.design/caws-cli`; its kernel is included. Run `caws --version`
for the installed version. [Command reference](../command-reference.md) and live
`--help` provide the full command/flag catalogue. This page describes task
semantics without maintaining a second copy of every option.

## Machine setup

```bash
caws init adapters install --plan --json
caws init adapters install
caws init adapters configure --agent-surface codex --plan
caws init adapters configure --agent-surface codex
```

`install` selects a verified snapshot under `CAWS_HOME` (default `~/.caws`). It
updates shared executables, dispatch, and renderers; it does not upgrade the CLI
package. `configure` writes the native harness's user configuration. Native trust
and execution require verification inside that harness. `--native-config-target`
explicitly selects the resolved file when user configuration is symlink-managed.

## Existing projects

```bash
caws init adapters migrate --agent-surface codex --plan --json
caws init adapters migrate --agent-surface codex
```

Migration retires recognized project CAWS registrations after user registration
exists. It preserves unrelated hooks and exact before/after backups. Custom
behavior requires a reviewed `--from` surface-policy JSON object with `disabled`,
`extensions`, `handlers`, and `libraries`. `--projects-root <directory>` applies
independent transactions to direct Git project children; it cannot be combined
with a single-project `--from` policy. Foreign worktree ownership is unchanged.

New projects use `caws init --agent-surface codex` after machine setup and inherit
the shared runtime without receiving local hook copies. `caws init --plan` and
its `--dry-run` alias preview project state and ignore rules. Plain init writes
idempotently. Unconfigured surfaces still support legacy pack initialization.

## Legacy governance conversion

```bash
caws init migrate --from reviewed-governance.json
caws init migrate apply --from reviewed-governance.json
```

This `--from` schema is different from adapter policy: `version`, `reason`,
`requirementNotes`, and hash-checked `changes`. The first command is read-only;
only positional `apply` executes. See the [migration guide](../migration-v10-to-v11.md)
for complete shape and preservation rules. No acceptance evidence or completed
work is inferred from importing a legacy spec as a draft.

## Updates, rollback, and legacy maintenance

After upgrading the CLI package, preview and run `caws init adapters install`
once. It updates all adopted projects. `caws init adapters rollback --plan`
previews restoration of the previous verified runtime; omit `--plan` to apply.
It does not restore the CLI package, project policy, or native registrations.

`init diff` and `init port <path> --from <staging-file>` are legacy project-pack
maintenance. `--three-way` belongs to diff; port's `--from` is raw replacement
content, not JSON. `--overwrite` previews legacy replacement and requires
`--force` to apply; `--adopt` deliberately retains local pack drift. The legacy
`adapters adopt` operation installs adapter-only policy and does not globalize
stock hooks or renderers. These are not system-update shortcuts.

## Output, authority, and failures

Flags are scoped to their command; invalid combinations fail before mutation.
Machine adapter operations apply by default and accept `--plan`/`--dry-run`.
Their `--json` renders both previews and apply results. Project init's `--json`
requires a preview. Governance migration always renders JSON and defaults to a
preview. Do not assume one command's defaults apply to another.

Project specs and bindings own authority. Leases and directed messages report
activity, not permission. Record AC closure with `caws specs evidence`; typed
`evidence record` supports tests, gates, and human decisions. Gates use project
policy and waivers. Hook exceptions use human-granted session-global reprieves,
under `~/.caws/state/sessions/<id>/`; `--surface` supplies harness provenance and
legacy lookup, not a new per-vendor grant directory. See `caws reprieve grant --help`
for required identity, handler, reason, approver, and expiry flags.

Most commands use exit 0 for success, 1 for domain failure, and 2 for composition
or usage errors. Some integrity gates have additional codes; consult their help.
A lifecycle state write can succeed while its automatic Git commit fails: inspect
stderr and verify the actual Git state before declaring source landed.
