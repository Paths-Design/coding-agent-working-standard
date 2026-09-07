# CAWS CLI

CAWS provides project governance and a shared machine runtime for coding agents.
The published `@paths.design/caws-cli` package includes its kernel; there is no
separately installed kernel package. Requires Node.js 18 or newer and Git. Native
hook execution also needs Python 3 and Bash.

## Install and activate

```bash
npm install -g @paths.design/caws-cli
caws --version
```

The CLI installation, shared runtime installation, native registration, and
project governance are distinct. Installing a package does not prove that a
running harness executes its hooks.

<!-- agent-surfaces-install:start -->
```bash
# Once per machine: install the shared runtime.
caws init adapters install --plan
caws init adapters install
# Configure the harness you are using (Codex shown here).
caws init adapters configure --agent-surface codex --plan
caws init adapters configure --agent-surface codex
# Once per existing project: retire reviewed local registration.
caws init adapters migrate --agent-surface codex --plan
caws init adapters migrate --agent-surface codex
# New projects inherit the configured runtime.
caws init --agent-surface codex
```

Pack templates exist for `claude-code`, `codex`, `opencode`, `zcode`, `kimi-code`, `qwen-code`, `dsh`. Template availability does not establish native activation; verify in the target harness.
<!-- agent-surfaces-install:end -->

Run setup in the native harness you are adopting. Review its hook trust, then
verify a fresh SessionStart, a protected-write refusal, Stop, and session
rendering. User and project hook registrations are additive: migrate existing
project registrations once, preserving reviewed custom behavior.

## Daily project workflow

```bash
caws doctor
caws status
caws specs create FEAT-001 --title "Implement the selected feature" --mode feature --risk-tier 3 --scope-in src/
caws worktree create wt-feature --spec FEAT-001
```

Work in the created worktree, surface ownership with `caws claim`, and use
`caws scope check <path>` before edits. Run the project's tests and
`caws gates run --spec FEAT-001`. Record acceptance evidence through
`caws specs evidence`; tests and lease visibility never substitute for authority.
From the canonical checkout, review and merge the finished lane through
`caws worktree review` and `caws worktree merge`.

## Maintenance

| Operation | Command | Boundary |
|---|---|---|
| Update CLI | `npm install -g @paths.design/caws-cli` | Package installation |
| Update shared hooks/renderers | `caws init adapters install --plan`, then without `--plan` | One machine runtime |
| Configure native transport | `caws init adapters configure --agent-surface codex --plan` | Harness user configuration; remove `--plan` after review |
| Retire project registration | `caws init adapters migrate --agent-surface codex --plan` | One-time adoption; remove `--plan` after review |
| Roll back shared runtime | `caws init adapters rollback --plan`, then without `--plan` | Previous verified snapshot; not CLI or project rollback |
| Convert old governance | `caws init migrate --from reviewed.json`, then `caws init migrate apply --from reviewed.json` | Hash-checked, explicit source-preserving conversion |

`CAWS_HOME` defaults to `~/.caws`. Machine snapshots are immutable. Put intentional
harness adapters under `surfaces/<surface>/lib/`; preserve project extensions
through reviewed machine policy. Specs, project policy, scope, claims and audit
history remain in the canonical project's `.caws/` directory.

A reprieve is a human-granted, expiring, session-global hook exception. New grants
live under `~/.caws/state/sessions/<session>/`; `--surface` identifies the harness
and legacy lookup context, not a separate grant store. A waiver affects policy
quality gates and never lifts a hook guard.

Legacy `init diff`, `init port`, `--overwrite`, and `--adopt` remain available for
unmigrated project packs. They are not the update workflow for system projects.

## Help and documentation

Use `caws --help` and dedicated help such as `caws init adapters configure --help`
or `caws init migrate apply --help`. The installed package's
[command reference](docs/command-reference.md) is generated from the same command
tree during packaging. [CLI workflows](docs/api/cli.md) explain setup and option
semantics; [runtime adoption](docs/guides/hook-packs.md) covers customization and
verification. Generated references are transport artifacts, not tracked source.

For CAWS development, use the repository's `scripts/install-cli-snapshot.mjs`
installer after building. It checks packaged runtime parity before atomically
activating a standalone CLI. A globally shared command must not point into a
checkout's mutable `dist/` directory.
