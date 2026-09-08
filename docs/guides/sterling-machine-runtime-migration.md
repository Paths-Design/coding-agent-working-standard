---
doc_id: sterling-machine-runtime-migration
authority: reference
status: active
title: Sterling machine runtime migration handoff
owner: CAWS maintainers
updated: 2026-09-07
audience: contributor
---

# Sterling machine runtime migration handoff

Finish Sterling's adoption so one machine update supplies stock guards and
session rendering, while Sterling retains its project-specific behavior.
This guide does not certify or perform Sterling's migration. Recheck all dated
observations before acting, and obtain authorization for the implementation
scope in the receiving session.

## Verified handoff baseline

On September 7, 2026, the operator authorized activation of the current global
runtime. `caws init adapters install --json` activated:

```text
home:     /Users/darianrosebrook/.caws
active:   d2ee8afcb862a037352863f7c47d877b31223b1c21c2e94bd97cb461e2654814
previous: b0b02ea0c52e2c2415aa44292bc2cc06858a139e8ce112793425561374c2ad12
CLI:      12.1.0, independent installed package snapshot
```

The manifest hash and all 91 payload hashes verified. A repeated install
preview returned `changed: false`. Codex and Claude configuration previews
also returned `changed: false`. These are installation and configuration
checks, not fresh native enforcement or rendering probes.

CAWS itself has system policy for both surfaces with no explicit overrides.
Sterling has only Codex system policy. Its `.codex/hooks.json` has no remaining
local hook registrations; `.claude/settings.json` still invokes local dispatch.
The Claude migration preview reports:

```text
Custom dispatcher logic requires review; use --from with an explicit surface policy
```

Sterling's Codex policy still overrides `block-dangerous.sh`,
`bash-write-guard.sh`, `worktree-guard.sh`, and `session-log.sh`. The local
logger loads its adjacent `session_log_renderer.py` and daemon client directly.
Consequently, global renderer replacement alone does not update that path.
Local copies being present is not itself a defect; remaining execution edges
to stock copies are what prevent centralized updates.

## 1. Establish authority and capture the actual starting state

Work from Sterling's canonical repository for observation:

```bash
cd /Users/darianrosebrook/Desktop/Projects/sterling
git status --short
caws --version
caws status --data
caws worktree list --data
caws agents list
caws doctor
caws init adapters install --plan --json
caws init adapters configure --agent-surface codex --plan --json
caws init adapters configure --agent-surface claude-code --plan --json
caws init adapters migrate --agent-surface codex --plan --json
caws init adapters migrate --agent-surface claude-code --plan --json
```

At handoff Sterling contained unrelated untracked languagepack admission
artifacts and a ghost/one-sided `ar-nfc-source` binding. Preserve foreign work;
reconcile those findings under their own ownership and scope. A stale lease
does not authorize takeover. Do not use a migration to repair governance.

Create an appropriately scoped Sterling spec and bound worktree before editing
source, tests, native settings, or a reviewed policy. Inspect Sterling's own
instructions and use `caws claim` and `caws scope check` there. Include every
helper reached by a retained local handler in the review scope. If a worktree
needs canonical resources, use the repository-defined root environment
variable; do not symlink languagepack components into the lane.

Capture before-bytes of native registrations, effective project policy, runtime
pointer, relevant local handlers/helpers and their Git revisions in an ignored
evidence directory. Project policy lives at
`~/.caws/state/projects/<sha256(canonical-realpath)>.json` unless `CAWS_HOME`
selects another absolute machine home. Read it; update it only through the CLI.
Inspect user-level library overrides under `surfaces/<surface>/lib` as well.

## 2. Reconcile behavior before removing core overrides

Compare three sources: Sterling's installed pristine baseline when available,
its current local implementation, and the current CAWS source/active snapshot.
Do not treat an old pack stamp as proof a file is obsolete. Check these known
differences and the tests/specs documenting them:

| Surface | Behavior to preserve or reconcile | Intended destination |
| --- | --- | --- |
| Danger guard | Sterling's reset-command boundary checks; current machine recovery command and HOME handling | Shared guard after adversarial regression checks |
| Bash write guard | Quoted arguments, chain separators, heredoc handling and foreign-repository containment | Shared guard/helpers where reusable |
| Worktree guard | Quoted text versus commands, heredoc bodies, and copy/move name false positives | Shared guard/helpers where reusable |
| Session logger/renderer | Warm daemon with fallback, transcript source precedence, user/interjection provenance, tool outcomes and denial attribution | Shared rendering or explicit harness adapter, with project extensions only where necessary |
| CASR and repository checks | `casr-context.sh`, rg/test/gitignore guards, documentation checks | Explicit Sterling extensions |
| Helpers | `lib/heredoc.sh`, daemon client, transcript converters, renderer dependencies | Review every actual load path before dropping a pin |

The local logger currently names a vendor-local audit log while machine audit
output lives under the machine project's log directory. Verify the effective
input to outcome attribution; file existence is not proof the correct log is
being consumed. Test any repaired path against actual native tool outcomes.

Search from the canonical roots without confusing local copies with templates:

```bash
rg -n 'local_override|STERLING-|CAWS-|SCRIPT_DIR|RENDERER|AUDIT_LOG|HOOK_OUTCOME|caws_source_lib' .caws/hooks/session-log.sh .caws/hooks/block-dangerous.sh .caws/hooks/bash-write-guard.sh .caws/hooks/worktree-guard.sh
rg -n 'session-log|heredoc|transcript|casr-context|quiet-merge' .caws/hooks/dispatch .caws/hooks/lib
```

Reusable fixes require a separately authorized CAWS spec/worktree, source
changes, meaningful regression tests and governed landing. Do not edit
`~/.caws/lib/runtimes/<digest>`: snapshots are integrity checked. Install the
updated standalone CLI and then the runtime through supported commands after
upstream work lands. A Sterling-only agent must hand off that upstream work
if it lacks authority in CAWS.

Keep a core override until the replacement proves its required behavior.
Record each retained override's reason, regression evidence and removal
condition. This makes partial adoption explicit instead of declaring it done.

## 3. Author separate reviewed surface policies

`migrate --from` accepts one **surface policy**, not the outer project record.
It must contain exactly these object-valued keys:

```json
{
  "disabled": {},
  "extensions": {},
  "handlers": {},
  "libraries": {}
}
```

This shape is explanatory, not a ready-to-apply Sterling policy. Start Codex
from its existing effective policy; derive Claude independently from its native
wrappers, dispatchers, helper loads and event behavior. Do not copy Codex's
policy onto Claude without comparing both chains.

Event keys are `pre_tool_use`, `post_tool_use`, `session_start`, `stop`, and
`pre_compact`. Extensions are ordered entries such as
`{"handler":"casr-context.sh","before":"quiet-merge.sh"}`. Handler and
library maps use canonical-project-relative paths. Handlers must exist and be
executable. Bootstrap libraries `agent-surface.sh` and `runtime-paths.sh`
cannot be overridden. An extension's anchor must survive the effective policy;
do not duplicate an existing stock handler.

Review custom wrapper behavior too: environment setup, fallback cwd resolution,
failure semantics, matchers, timeouts and ordering. `--from` is an explicit
classification decision, not an automatic translation of arbitrary wrapper
code. Preserve CASR's placement and keep `quiet-merge.sh` last where it emits
updated input. Do not disable guards to make a migration or test pass.

There is no guarantee that putting an arbitrary filename in `libraries` changes
a consumer that directly opens a sibling file. In particular, check the logger's
renderer selection in code; migrate its load path before dropping its override.

## 4. Preview and apply from the canonical checkout

Land required source changes through governed worktrees first, so every policy
path resolves from canonical Sterling. Save the reviewed Codex and Claude
surface JSON files at deliberate paths covered by the receiving spec. Preview
each independently (replace the example absolute policy paths):

```bash
caws init adapters migrate --agent-surface codex --from /absolute/path/codex-policy.json --plan --json
caws init adapters migrate --agent-surface claude-code --from /absolute/path/claude-policy.json --plan --json
```

Review exact before/after changes. The intended transaction changes the selected
surface policy and retires recognized CAWS project registrations while retaining
unrelated configuration. It must not alter governance, erase custom executable
behavior, or rewrite another surface's policy. A prior successful Codex migration
can legitimately need a new policy now to remove reconciled overrides.

Once the concrete migration is authorized, run the same command without
`--plan`, one surface at a time. It must run at the canonical root; the CLI
refuses linked-worktree migration. Coordinate this canonical mutation with live
owners and record/commit only the intended repo-owned configuration changes.
Do not blanket-stage existing dirt or commit generated evidence artifacts.

Repeat each preview and require `changed: false`. Inspect exact transaction
backups under the selected machine home's `state/adoption-backups`. Old local
files may remain for compatibility; do not delete them until their remaining
consumers have been checked, including unmigrated harnesses.

## 5. Prove native delivery and close only the measured scope

Restart/reopen each harness as needed to discard cached project registrations.
Review native hook trust when definitions change. For fresh Sterling Codex and
Claude sessions, retain native output plus the rendered turn and verify:

1. The selected runtime digest and canonical repository are correct, including
   a linked-worktree case. Exactly one intended CAWS chain handles each event.
2. SessionStart and Stop execute; observe successful PostToolUse and PreCompact
   separately if claiming those events. Registration alone proves neither.
3. One explicitly authorized controlled protected-write attempt is denied by
   the native hook, with no target file created. Do not use a dangerous command
   as the probe or clear a human danger latch from an agent.
4. The renderer retains the actual user request/interjection, real tool call,
   refusal and outcome once, excluding injected harness context as user speech.
   Establish which renderer/helper bytes actually executed.
5. CASR and custom checks appear in their intended order and their final
   agent-visible output survives dispatcher combination. Guards still reject
   adverse cases and admit benign near misses.
6. In disposable governed fixtures, one machine update reaches both guard and
   renderer consumers across two projects without project-byte changes. Do not
   mutate the live machine snapshot to manufacture this control.

Run meaningful affected tests, `caws gates run --spec <receiving-spec-id>` and
`caws doctor`; record AC evidence through `caws specs evidence`. Separate
pre-existing governance errors from migration findings. Report remaining pins
and unmeasured harnesses explicitly. Global JSON registration currently supports
Codex, Claude and Qwen; it refuses ZCode, DSH, Kimi and OpenCode pending native
adapter work. Keep their existing working integrations until separately proven.

## Recovery and completion boundary

`caws init adapters rollback --plan --json` previews the previous machine
snapshot; applying rollback changes the shared runtime for all adopters. It
does not undo CLI installation, native configuration or project policies. Do
not use it to repair a Sterling-only policy problem. Restore reviewed policy
through `migrate --from`; restore native registration only through an explicitly
reviewed recovery using exact transaction backups and current ownership.

Completion means the selected Sterling surfaces receive stock runtime updates,
project-specific behavior has independent evidence, and no unexplained core
logger/guard pins remain. If a pin is still required, report partial adoption
with its reason rather than treating clean configuration as full transition.

References: [runtime setup](hook-packs.md),
[adapter architecture](../architecture/hook-pack-shared-core.md), and
[command doctrine](../architecture/caws-vnext-command-surface.md).
