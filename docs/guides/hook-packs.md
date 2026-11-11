---
doc_id: hook-packs
authority: reference
status: active
title: CAWS shared runtime setup and hook maintenance
owner: CAWS maintainers
updated: 2026-11-11
audience: consumer
---

# Hook packs: the edit-time advisory quality plane

The optional worktree pin guard uses
[bounded command analysis](command-analysis.md) to inspect assignments, finite
loops, argument roles and Git routing without executing submitted source. Its
structured CLI distinguishes policy violations from unresolved syntax or values;
it remains opt-in in the shared dispatcher.

CAWS distributes guards, dispatchers and session renderers through a user-level
runtime in `~/.caws`. Configure the native harness once and migrate existing
project registrations once; subsequent runtime updates serve every adopted
project. See [Machine adapter installation](#machine-adapter-installation).
Legacy project packs remain supported during migration. The first part of this
guide documents the **advisory quality plane** added by `QG-HOOKS-EXTRACT-001`.

The runtime also carries mandatory authority guards. In shared PreToolUse
dispatch, `bash-write-guard.sh` requires the bounded mutation backend and fails
closed without a legacy fallback; `worktree-pin-guard.sh` is opt-in. These are
separate from the four advisory quality hooks below. See
[bounded command analysis](command-analysis.md) for execution context, effect
coverage and verification.

Copy guards share the bounded backend's required `cp`/`mv` operand roles.
Single-link regular-file destinations, destination-directory children and
move-source deletions receive explicit path checks. Effective final symlink
destinations refuse with exit 2 even when approval is available, because a force
copy can replace the link entry. Directory-parent aliases with regular children
remain supported; known referent violations keep their specific refusal. A
source path alone cannot classify an external artifact destination as a
canonical write. Unknown options, incomplete roles and unmodeled filesystem
cases refuse; the
[command analysis guide](command-analysis.md#active-write-guard-integration)
defines this closed profile and its filesystem snapshot limits.

Removal checks distinguish a final link entry from its referent. The modeled
`rm` profile checks an owned deletion entry without borrowing the referent's
ownership; unsupported removal options remain held. Bash and Write/Edit share
registered physical-path ownership checks, including migrated worktree
locations. Metadata and documentation allowlists cannot override foreign payload
ownership or erase unresolved payload identity. A failed role channel cannot
become an empty allow. Malformed, unreadable or non-regular existing registry
entries remain held.

Ordinary runtime installation changes the shared handlers consumed by enabled
registrations. The bounded analyzer and private package observations do not
qualify native adoption. The known reduced Codex producer is held because its
command projection cannot bind the complete final command, shell and startup
context. A validated host execution directory establishes only that coordinate.
The analyzer bridge's inherited `CAWS_BIN` or `PATH` selection also requires
generation-bound Node and CLI identity through launch. The guide's owned
execution boundary is proposed. Retain the deployed runtime until complete
final-launch and rewrite custody, useful benign admission, an isolated native
canary and rollback are demonstrated. A protective refusal is not evidence of a
qualified rollout.

These four hooks are _advisory_ edit-time signals. They implement the
load-bearing edit-time quality checks (`god_object`, `todo_detection`,
functional-duplication, change-budget) so the agent gets feedback _in the loop
where it is editing_, instead of only when an operator later runs
`caws gates run`.

## The doctrine boundary (option C)

These hooks are an **edit-time advisory plane**, not a replacement for
`caws gates run`:

- `caws gates run` is the **governed policy-gate runner**. It reads
  `.caws/policy.yaml`, evaluates gates in `block`/`warn`/`skip` mode, and
  appends a `gate_evaluated` event per gate. It is the canonical disposition
  surface.
- The four hooks below are **installed hook-pack utilities** that the repo tunes
  locally (via env vars or `.caws/hooks/hook-policy.json`). They never write
  events, never block a gate, and have **no runtime coupling** to an external
  quality package. They implement the edit-time checks in self-contained bash.

This is deliberate: `caws gates run` owns governed policy/event disposition,
while the edit-time hooks start from the governance floor and are shaped
per-repo. Installing the pack does not change `caws gates run` behavior in any
way.

## The four hooks

All four are registered as `PostToolUse` handlers in
`dispatch/post_tool_use.sh`. They skip generated/vendored paths (`node_modules`,
`dist`, `build`, `coverage`, `.next`, `out`, `vendor`) and minified/lock
artifacts at the top of the script — they only act on real source files the
agent authored.

### `god-object-check.sh` — large-module advisory

- **Trigger:** Write or Edit.
- **Mode:** advisory (always exits 0; never blocks).
- **What it flags:** a touched file whose source-lines-of-code (blank and
  whole-line `//`/`#`/`*` comments stripped) meets or exceeds the threshold.
- **Threshold:** `CAWS_GOD_OBJECT_LOC` env, or
  `guards.god-object-check.sh.thresholds.loc` in `.caws/hooks/hook-policy.json`
  (default `2000`). See [Tuning](#tuning).
- **Policy counterpart:** the `god_object` gate.
- **Output:** a `hookSpecificOutput.additionalContext` warning naming the file,
  its SLOC, and the threshold.

### `shortcut-language-check.sh` — placeholder/stub advisory (progressive)

- **Trigger:** Write or Edit, on NON-test source (`*.test.*`, `*.spec.*`,
  `tests/`, `__tests__/`, and markdown/docs are exempt — placeholder language
  there is routine).
- **Mode:** **progressive** — the only one of the four that can block. It
  escalates through the shared guard-strikes mechanism: **strike 1 → warn**,
  **strike 2 → ask** (permission prompt), **strike 3 → block**. Strikes are
  per-session.
- **What it flags:** explicit `throw new Error("not implemented")` stub shapes;
  incomplete-work markers (`TODO`, `FIXME`, `XXX`, `HACK`, `TBD`) in comment
  text in any case, and in code only as uppercase `TODO`, `FIXME`, `HACK` or
  `TBD`; the phrases `not implemented`, `implement later` and `coming soon`; and
  `placeholder` in comment text beside a stub cue (`// placeholder`,
  `just a placeholder`, `this is a placeholder`, `placeholder implementation`,
  `placeholder for now`, or a deferral such as `fill in later`).
- **What it leaves alone:** marker words used as vocabulary. `placeholder` in
  code (the input attribute and prop, a `"placeholder"` union member,
  `::placeholder`, `aria-placeholder`) or as a bare doc-comment prop description
  never counts, nor does a descriptive comment such as "the skeleton is a
  placeholder shown while loading". In code, `Todo`/`todo` identifiers and an
  `XXX-XXX-XXXX` input mask never count. The advisory quotes the matched source
  line with its number — counted within the edit for an Edit.
- **Policy counterpart:** the `todo_detection` gate. The hook ships the
  high-signal subset of that vocabulary to stay single-file and fast.
- **Doctrine:** enforces the CAWS key rule "No fake implementations — no
  placeholder stubs, no TODO in committed code."

### `duplicate-export-check.sh` — shadow-export advisory

- **Trigger:** Write only (new-file creation — the common shadow-export
  incident). An Edit that adds a colliding export to an existing file is a
  documented v1 limitation.
- **Mode:** advisory (always exits 0).
- **What it flags:** a newly-written JS/TS file that exports a symbol whose
  **exact** name already exists as an export elsewhere in the enclosing
  package's `src` tree. Generic names are allowlisted (`main`, `init`, `setup`,
  `run`, `handle`, `render`, `index`, `default`). Matching is exact, not
  heuristic similarity.
- **Lookup:** bounded to the enclosing `packages/<pkg>/src` (or repo-root
  `src`); uses ripgrep when available, `grep -r` fallback; never scans
  `node_modules`.
- **Policy counterpart:** the functional-duplication name/shape collision check.
- **Doctrine:** the symbol-level companion to `naming-check.sh`'s filename-level
  "No shadow files" enforcement.

### `loc-delta-check.sh` — oversized-edit advisory

- **Trigger:** Edit only (the "grow an existing file" case).
- **Mode:** advisory (always exits 0; never blocks).
- **What it flags:** a single Edit whose added-line delta (computed from the
  `new_string` vs `old_string` payload newline counts) exceeds the threshold. If
  the payload lacks `old_string`/`new_string`, the hook exits 0 silently — it
  never false-positives from missing data.
- **Threshold:** `CAWS_LOC_DELTA_WARN_THRESHOLD` env, or
  `guards.loc-delta-check.sh.thresholds.delta` in `.caws/hooks/hook-policy.json`
  (default `300`). See [Tuning](#tuning).
- **Doctrine:** the CAWS key rule "Ask first for risky changes — changes
  ... >300 LOC ... require discussion first."

## Tuning

Per-repo thresholds are environment variables read at hook runtime, so they can
be set in `.claude/settings.json`'s `env` block (or the shell that launches the
agent) without editing the managed hook scripts:

```jsonc
{
  "env": {
    "CAWS_GOD_OBJECT_LOC": "2500",
    "CAWS_LOC_DELTA_WARN_THRESHOLD": "400",
  },
}
```

Environment variables are per-session and per-operator. For a threshold the
whole team should share, declare it in `.caws/hooks/hook-policy.json` instead —
it is committed, reviewed, present in every clone and in CI, and checked by
`caws hooks validate`:

```jsonc
{
  "version": 1,
  "surfaces": {},
  "guards": {
    "god-object-check.sh": { "thresholds": { "loc": 2500 } },
    "loc-delta-check.sh": { "thresholds": { "delta": 400 } },
  },
}
```

`loc-delta-check.sh` spells its key `delta`, not `loc`: the value bounds a
per-edit line delta, the same quantity `god-object-check.sh` calls `delta`.

**Precedence is env > config > shipped default.** An existing `env` block keeps
working untouched, and a per-session override stays a narrower, more current
statement of intent than a committed file.

The same document also grants a guard additional allow prefixes — the supported
alternative to forking a guard when your repo's layout does not match the
shipped table:

```jsonc
{
  "guards": {
    "scope-guard.sh": {
      "additional_allow_prefixes": [
        {
          "prefix": "native/",
          "reason": "Rust core lives here; this repo has no src/.",
        },
      ],
    },
  },
}
```

Entries are append-only: no key removes, replaces or reorders a shipped entry,
and a malformed document applies **zero** entries rather than a subset, so a
mistake degrades toward refusal rather than toward permission. Prefixes must be
repo-relative — an absolute one would bypass cross-repo containment and is
refused at authoring time. The full mechanism, the safety floor and the
config-versus-upstream-fix test are in
[`docs/architecture/repo-local-hook-policy.md`](../architecture/repo-local-hook-policy.md).

System hook scripts live in verified snapshots and are updated once with
`caws init adapters install`. Tune thresholds through the policy document or
environment variables; preserve custom behavior through explicit extensions or
overrides. Legacy project copies still use the pack retrofit commands until
their native registration is migrated.

System Codex registration lives in `~/.codex/hooks.json`. Native hook trust must
be reviewed when definitions change. Legacy project hooks remain additive until
retired; their presence is not evidence that the global runtime is executing for
that project.

## Lineage

Each hook traces to a `docs/failure-lineage.md` entry documenting the gap it
closes: `god-object-check.sh` → Entry 28, `shortcut-language-check.sh` → Entry
29, `duplicate-export-check.sh` → Entry 30, `loc-delta-check.sh` → Entry 31. The
per-pack lineage map lives in `.claude/hooks/CLAUDE.md` after install (sourced
from `packages/caws-cli/templates/hook-packs/claude-code/CLAUDE.md`).

## Development CLI installation

A global CLI must not link into a development checkout's `dist/`: builds replace
that directory and can interrupt every project using the command. From a built
CAWS checkout, install a standalone package before activating it:

```bash
node scripts/install-cli-snapshot.mjs --package packages/caws-cli --bin "$(command -v caws)"
```

The installer packs the current build, installs production dependencies under
`~/.caws/lib/cli/`, and checks help, initialization, and doctor in an isolated
project. Only a successful candidate replaces the global symlink, using an
atomic rename. Failed candidates preserve the previous command. Prior
installations remain available for rollback and running processes.
`build:main-dist-link` uses this installer instead of `npm link`; its
`dist/main` links are development-only. The installer needs npm dependency
access and does not run package lifecycle scripts. Build before installation; it
never rebuilds the active checkout itself.

## Machine adapter installation

The CLI package, shared runtime, native registration and project governance have
separate lifecycles, and they upgrade in a fixed order because **each step is
performed by the CLI installed in the step before it**:

1. **CLI package** — `scripts/install-cli-snapshot.mjs` (above), or npm for a
   released install.
2. **Shared runtime** — `caws init adapters install`.
3. **Native registration** —
   `caws init adapters configure --agent-surface <surface>`.
4. **Project governance** — `caws init --agent-surface <surface>` per repo.

Skipping step 1 does not fail loudly. `configure` wires the lifecycle events
_the CLI running it_ knows about, so a stale CLI reports `OK` while writing the
old event set; the newer build then refuses every `init` with
`System surface settings and native registration disagree; run caws init adapters configure`.
That remediation names step 3 when step 1 is what is stale, so following it
verbatim loops. Confirm the active CLI by content rather than by `--version` —
two builds can share a version string and differ.

Each operation has dedicated help (`caws init adapters install --help`,
`configure --help`, `migrate --help`, `rollback --help`). The development CLI
snapshot installer also checks identical development/packaged runtime digests;
dependency or packaging drift refuses activation instead of changing behavior.

Install and configure CAWS once at user scope:

```bash
caws init adapters install --plan --json
caws init adapters install
caws init adapters configure --agent-surface codex --plan
caws init adapters configure --agent-surface codex
```

`CAWS_HOME` selects an absolute machine home (default `~/.caws`). The snapshot
contains stock guards, helpers, dispatchers and session renderers, plus harness
adapter libraries. Configure writes `~/.codex/hooks.json` for Codex. Review its
native trust and restart the harness before claiming activation. Claude Code and
Qwen Code have JSON registration helpers, but their native execution must be
verified by an agent in that harness; library installation alone proves no
parity.

If the user hook file is managed through a symlink, inspect its actual target
and pass `configure --native-config-target /absolute/resolved/target`. CAWS
preserves the link, backs up and updates that exact target inside the user home,
and records the selection. A subsequent redirect is refused. Without this
explicit selection, symlinked configuration is refused. If the target belongs to
a configuration Git repository, its source change still needs the normal review
and commit there.

Retire old project registrations once from a central directory:

```bash
caws init adapters migrate --agent-surface codex --projects-root ~/Desktop/Projects --plan --json
caws init adapters migrate --agent-surface codex --projects-root ~/Desktop/Projects
```

This examines direct Git project children. Each project is an independent
transaction: successful migrations are retained while review-required projects
are reported. It does not migrate legacy governance, claim worktrees or modify
project source hooks. Run without `--projects-root` to migrate the current
canonical checkout. Plans contain complete proposed configuration bytes. Apply
requires the system registration to exist first. Native project and user hooks
are additive; verify one effective CAWS transport per event after migration.

During rollout the explicit system transport defers to an existing project CAWS
registration, preventing duplicate handler execution. Unmigrated projects keep
their old behavior until reviewed; doctor continues to identify their legacy
registration. Cached adapter-only entries remain functional across this
transition.

New projects subsequently use normal `caws init --agent-surface codex` and
inherit the configured system runtime without receiving local hook copies.
Future updates for every migrated project need only:

```bash
caws init adapters install
```

Stock handler order comes from the new snapshot on each invocation. Projects do
not pin a pack version or a full stock handler list. Explicit customizations
live in machine `state/projects/<canonical-path-hash>.json`. The migration
preserves unrelated hooks, backs up exact native bytes under
`state/adoption-backups/`, and leaves old executable copies intact. It refuses
unknown shell wrappers, reordered stock guards and unclassified helper growth
rather than assuming they are stock.

For a project requiring reconciliation, inspect its actual custom behavior and
pass a reviewed surface policy with `--from <file>` (single project only):

```json
{
  "disabled": {},
  "extensions": {
    "pre_tool_use": [
      { "handler": "custom-guard.sh", "before": "scope-guard.sh" }
    ]
  },
  "handlers": { "custom-guard.sh": ".caws/hooks/custom-guard.sh" },
  "libraries": {}
}
```

`--from` explicitly defines the behavior retained when retiring the old native
transport, including any custom wrapper behavior. Do not supply an empty policy
without reviewing what it retires. Extensions are inserted before named stock
handlers; `null` appends. An absent anchor fails visibly. `disabled` names
deliberate stock exclusions by event. Handler/library paths are
canonical-project-relative and confined; handler files must be executable. These
overrides stay locally maintained. Adapter libraries resolved through
`caws_source_lib` can be declared in `libraries`; bootstrap `agent-surface.sh`
and `runtime-paths.sh` are prohibited. Directly sourced helper growth requires a
reviewed handler override or an upstream fix. User adapter libraries live in
`~/.caws/surfaces/<surface>/lib/`; declared project adapters win, then user
overrides, then packaged surface/shared code.

Harness agents maintain their native adapters at this machine layer. Codex's
`session-transcript.py` turns visible rollout response items into the shared
renderer's events. Shared rendering and guard fixes ship once. See the
[adapter authoring and proof contract](../architecture/hook-pack-shared-core.md#system-runtime)
for required native evidence and the separation from fixture tests.

Doctor reports effective runtime integrity and residual local registration
rather than asking each system project to refresh copied packs. Filesystem
configuration is not evidence that an already-running harness switched snapshots
or trusted a new native registration. Verify fresh SessionStart, denied-write
and Stop events.

`caws init adapters rollback --plan` previews the previous verified snapshot;
`rollback` applies it. The pointer swap is atomic and the bootstrap stays
stable. Rolling back to the earlier adapter-only generation also restores that
generation's project-policy requirements, so inspect compatibility before
rollback. Never edit snapshot bytes. An interrupted install leaves
`state/adapter-install.lock`; a configuration transaction leaves
`state/system-configuration.lock` plus exact before/after backups. Inspect the
owning process and partial bytes before removing a stale lock and retrying.
Rollback refuses to overwrite a concurrent edit.

Rollback verifies the selected target generation before changing the pointer. An
existing native registration can continue through a verified legacy generation
when its stable entry matches a retained manifest-bound entry identity. This
compatibility check verifies manifest integrity, supported hashed metadata and
the retained launcher's regular-file, single-link, byte and executable-mode
identity under machine-home custody. It does not qualify unused native image
payloads or authenticate publisher history. Fresh native opt-in, native
selection and rollback into a native generation require full image verification.

Observation requires the matching stable entry to have mode `0755` and never
repairs it. Explicit installation or rollback can restore a missing stable entry
from validated retained bytes or repair the mode of recognized bytes; unknown
bytes, symbolic links and multiple links refuse before pointer publication.
Native dispatch failures never trigger legacy fallback. Filesystem checks and
fixture tests do not establish native harness execution or adoption.

## Guard verdicts and refusals

The PreToolUse chain decides whether a tool call runs. This section states what
each outcome means for the agent, so that a guard author and a blocked agent
read the same contract. The incidents behind it are
[failure-lineage Entry 47](../failure-lineage.md#entry-47-a-guard-that-could-not-run-let-the-call-through-and-a-refusal-that-did-not-name-its-cause-sent-the-agent-searching-november-2026)
and
[Entry 48](../failure-lineage.md#entry-48-calls-queued-in-one-reply-took-a-session-from-its-first-refusal-to-a-kill-before-it-could-read-any-of-them-november-2026).

### A guard that cannot run refuses the call

Only exit 2, or a block decision on stdout, stops a tool call. A guard that is
missing, not executable, or exits with any other non-zero status has reached no
verdict. On the enforcing chain `lib/run-handlers.sh` treats that as a refusal,
because a missing verdict that reads as "no objection" lets an agent remove a
guard by breaking it.

| Fault                                                | Write, Edit, Bash, unknown tools | Read, Glob, Grep    |
| ---------------------------------------------------- | -------------------------------- | ------------------- |
| Guard missing or not executable                      | Refused                          | Reported, call runs |
| Guard exits other than 0 or 2 with no block decision | Refused                          | Reported, call runs |
| Payload carries no tool name                         | Refused                          | Not applicable      |
| Advisory handler missing or crashed                  | Reported, call runs              | Reported, call runs |

The advisory handlers are `agent-heartbeat.sh`, `cwd-guard.sh`,
`scan-secrets.sh` and `quiet-merge.sh`. They warn or rewrite and contain no
refusal path. Every other chain member is a guard, including
`shortcut-language-check.sh`, whose strike ramp can refuse. A handler added to
the advisory list must not be relied on to stop anything. Read-only tools are
not refused because a session that cannot read cannot diagnose the fault.

One fault is outside this contract. The harness applies its own timeout to the
whole PreToolUse hook, and when that expires the tool call runs with no guard
verdict. Nothing inside the chain can refuse on that path. Keep each handler's
cost bounded for that reason; the heartbeat ends each CLI call it makes at a
deadline (see [Session liveness](#session-liveness)).

### A refusal names its cause and what discharges it

A refusal is the only text an agent reads at the moment it is blocked. A refusal
that names a symptom sends the agent to try variations until one passes, which
is the behavior guards exist to prevent. Every refusal states:

- **Which guard refused and what it found**, in terms of the command or payload.
  Where several causes apply, all of them: `worktree-guard` prints every
  analyzer issue behind a refused copy and the copy-role reason.
- **Whether the agent's command caused it.** A guard fault says "Your command
  did not cause this" and tells the agent to stop and report; retrying cannot
  help. A finding about the command says what to change.
- **What it cost.** Whether a strike was recorded, whether the latch was armed,
  and what the next occurrence will do.
- **The missing input, by name.** `scope-guard` refuses a Write or Edit whose
  payload names no target and states the field it looked for; a payload that
  cannot be inventoried is refused with the cause appended.

When adding a refusal, test its remedy as well as its verdict
([Testing a refusal's remedy](#testing-a-refusals-remedy)).

### Block, strike and latch

A refusal is one of three weights. Choose the lightest that holds the boundary.

| Weight | Effect on the session                                                                                                               | Used for                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Block  | This call is refused. Nothing is recorded against the session.                                                                      | Guard faults; a first opaque inline payload; a first unanalyzable command; a bare commit over staged deletions |
| Strike | The finding is counted for the session, across every repo. The first warns and allows, the second asks, the third and later refuse. | Findings a guard wants corrected over repetition: `scope-guard`, `shortcut-language-check`                     |
| Latch  | The session is quarantined until a human resets it. On kill-enabled surfaces the next blocked attempt ends the process.             | Catastrophic or bypass-shaped commands, and a repeat of a blocked classification                               |

Rules that hold across guards:

- **An infrastructure fault never counts.** A missing guard, a classifier that
  is absent or crashed, a classifier sidecar error and an unrecordable strike
  are refused without a strike or a latch. The agent cannot discharge them, so
  counting them only moves the session toward a kill it cannot avoid.
- **A repeat latches only after the first refusal could be read.** A second
  opaque inline payload, or a second command the classifier could not finish
  analyzing, arms the latch when it is sent after the earlier refusal. The first
  refusal says so.
- **Calls queued in one model reply count once.** A harness can issue several
  tool calls from one reply before any result returns. Calls that share a reply
  are one occurrence: the later ones are refused, and they neither escalate nor
  arm the latch, and a kill never fires on a call issued before the latch was
  delivered. `block-dangerous.sh` identifies a reply from the transcript's
  message id for the call's `tool_use_id`. Where no transcript is available it
  treats calls within `CAWS_BATCH_WINDOW_SECONDS` (default 5) as one reply, so a
  retry inside that window is refused and not escalated.
- **Capability-risk commands warn once.** The first such command in a session
  draws a warning; a later one arms the latch. A second one queued with the
  first is refused without a latch.
- **A bare commit over staged deletions never latches**, however often it is
  repeated. The native runtime answers that refusal for Codex without the shell
  guard, and both must agree.

Strike counts live in the machine session store, at
`$CAWS_HOME/state/sessions/<session>/strikes.json`, falling back to
`$HOME/.caws`. The count belongs to the session and not to a repo, so a session
refused in one repo is not cleared by moving to another. When neither is set, or
the record cannot be read or written (`jq` missing, a corrupt record, an
unwritable directory), the finding is refused outright and the message states
that it could not be counted. It is not reported as a third strike.

## Session liveness

A session's lease, `.caws/leases/<session>.json` in the canonical checkout,
records its status and the checkout it works in. Liveness is the later of two
times: the lease's `last_active`, and the modification time of the activity
stamp `.caws/leases/<session>.active`. The lease store applies that rule when it
loads leases, so `caws agents list`, `caws status`, message delivery and the
peer notice all read the same value. Liveness is an observation: it never grants
ownership and a stale session is not an ended one.

The stamp is written without starting the CLI:

- The machine launcher touches it for every hook event it dispatches, so a
  session is seen as active during a long tool run, after a tool returns and at
  a stop.
- `agent-heartbeat.sh` touches it on every PreToolUse call, which covers the
  surfaces that run project dispatchers without the launcher.
- A CLI heartbeat that is throttled touches it instead of rewriting the lease.

A stamp is written only for a session that already has a lease, and never moves
`last_active` backward. A stamp dated in the future is ignored.

`agent-heartbeat.sh` runs first in the PreToolUse chain and is advisory. It
starts the CLI only when work is owed:

| Work                                            | Runs when                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Full heartbeat: rewrite the lease, peer summary | None completed in the last `CAWS_HEARTBEAT_INTERVAL_SECONDS` (default 15), or the lease file was replaced since |
| Mailbox poll                                    | On every full heartbeat, and when `.caws/messages.jsonl` changed since this session's last poll                 |
| Neither                                         | The call stamps activity and exits                                                                              |

Each CLI call the handler makes is ended after
`CAWS_HEARTBEAT_CLI_DEADLINE_SECONDS` (default 3) where `perl` is available. The
CLI runs in its own process group and the whole group is ended, so a launcher
script's child does not outlive the deadline. A full heartbeat that fails or is
ended is still recorded as attempted: the next attempt waits out the interval,
so a slow or broken CLI costs its deadline once per interval and not on every
tool call. The peer notice can trail a change in the peer set by up to the
heartbeat interval. Mail is polled only on a main-thread call; a subagent's call
carries the parent's session id and leaves the mail queued
([failure-lineage Entry 46](../failure-lineage.md#entry-46-mail-addressed-to-a-session-was-settled-delivered-into-its-subagents-contexts-each-repair-stated-the-rule-correctly-and-applied-it-to-bytes-another-layer-had-already-transformed-october-2026)).

The handler and the launcher keep four files beside the lease. All are removed
when the lease is deleted or pruned.

| File                 | Meaning                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<session>.active`   | Activity stamp. Only its modification time is read.                                                                                                        |
| `<session>.hb`       | Epoch second of the last completed full heartbeat.                                                                                                         |
| `<session>.hb.lease` | Hard link to the lease file as of that heartbeat. A lease write replaces the file, so the link no longer names it and the next call runs a full heartbeat. |
| `<session>.mail`     | Written by the main thread before each poll. A mailbox no older than it is polled again.                                                                   |

The reasoning is in
[failure-lineage Entry 50](../failure-lineage.md#entry-50-liveness-was-measured-at-one-hook-event-by-starting-the-cli-on-every-tool-call-november-2026).

## Human latch recovery

From the canonical project checkout, a human can run the reset helper from the
active verified runtime. This is separate from reprieve grants: latches remain
project/harness state, while reprieve records live in the machine session store
and reach one session in one repo (`--all-repos` widens that). Do not edit a
snapshot or infer the project root from its installation directory.

```bash
caws doctor
runtime="$(python3 - <<'PY'
import json, os, pathlib, re
home = pathlib.Path(os.environ.get('CAWS_HOME', '~/.caws')).expanduser()
digest = json.loads((home / 'state/adapter-runtime.json').read_text())['digest']
assert re.fullmatch(r'[a-f0-9]{64}', digest)
print(home / 'lib/runtimes' / digest)
PY
)"
CAWS_MACHINE_RUNTIME=1 CAWS_PROJECT_DIR="$PWD" CAWS_AGENT_SURFACE=claude-code \
  bash "$runtime/reset-danger-latch.sh" --session <session-id> --reason "Reviewed recovery"
```

The helper requires an absolute project root in machine mode, resolves the
canonical Git state without inherited Git overrides, and records recovery in
that project's harness log. Legacy installed helpers retain their existing root
resolution. Recovery does not grant project scope or worktree ownership.

## Compatibility and reprieves

The old `adapters adopt` operation remains available for adapter-only project
policies. It does not globalize stock guards/renderers; prefer
configure/migrate.

Reprieve grants now belong to the machine session store, across adopted
projects. `--surface` identifies the target harness for operator provenance and
legacy lookup; it does not partition new grants into vendor directories.
Granting still requires a human shell, a target session, named handlers, reason,
approver and expiry. Human `show`/`list` calls without a surface hint discover
unambiguous legacy records across vendor directories. Conflicting copies for the
same session require `--surface` for inspection; a global record always wins
over them. `show`/`list` never create directories, and `revoke` retains an
inactive record to suppress all legacy copies, including conflicting copies.
`--json` emits one JSON value even when no earlier grant exists. Old, unadopted
dispatchers may not read new machine records. Verify a grant through the actual
target dispatcher before claiming it took effect.

### Preparing a reprieve for a human

Use a reprieve when a necessary, legitimate action exceeds what CAWS can
currently adjudicate. The agent must first explain the observed refusal and the
missing capability, then show why ordinary routes cannot accomplish the action.
An owned binding, scope amendment or target-repository session that solves the
problem removes the need for an exception.

Before presenting the command, write a self-contained `--reason` naming the
action, repository and paths, owning spec, refusal, alternatives considered and
why each is unavailable, session and handlers, permitted extent and use count,
exclusions, expiry, verification, recovery and revocation. "Unblock work", "the
user requested it" and "safe repair" do not explain necessity or bounds. Keep
the explanation in the record, not only in the surrounding chat. See the
[agent requirements and worked example](../../AGENTS.md#reprieves).

Explain that the actual skip is broader than any path restriction in that prose:
it matches session, repository, handlers and expiry, and can fire on every
matching call until expiry. The CLI does not evaluate the justification or
enforce its path, operation and use-count bounds. The agent remains bound by the
human's narrower grant. A past or peer grant is an example of reasoning, never
standing permission; a new actor, action, extent or repetition needs its own
applicable authorization. Disclose prior refusals and obtain approval before
acting. Agents cannot grant their own reprieves or supply a human's identity as
proof of approval;
[failure-lineage Entry 40](../failure-lineage.md#entry-40-the-agent-signs-the-owners-name-on-a-waiver-it-grants-itself-the-approver-field-is-self-authenticating-and-the-only-detector-is-a-human-reading-the-ledger-august-2026)
records why that separation matters.

## Testing hooks

### Hook-test isolation

A hook test that runs a real guard script can write into the developer's real
checkout. Hooks locate repo-wide state (`.caws/sessions/`, leases) with
`git rev-parse --git-common-dir`, run from `${HOOK_CWD:-$PWD}`.
`lib/parse-input.sh` overwrites `HOOK_CWD` with the payload's `cwd`, and with
empty when the payload has none, so a `HOOK_CWD` the test exports does not
survive. A synthetic payload without `cwd` leaves the test runner's working
directory to decide — and inside this repository, or any of its worktrees, that
resolves to the real canonical `.caws/sessions/`. Fixture session ids then sit
there as candidates the session resolver weighs in real sessions
([failure-lineage Entry 45](../failure-lineage.md#entry-45-a-missing-payload-cwd-was-answered-with-a-guess-that-always-named-the-canonical-checkout-the-first-fail-closed-fix-would-have-refused-every-relative-write-on-a-surface-that-never-sent-one-october-2026)).

In bats, `tests/hooks/bats/helpers.bash` provides the isolation:

```bash
setup() {
  caws_session_isolation_begin   # timestamp marker for this test
  caws_enter_fixture             # cd into $CAWS_TEST_REPO
}

teardown() {
  # fails if any listed id gained state under the REAL .caws/sessions/
  caws_assert_session_state_isolated my-session other-session
}
```

`run_guard` also runs the guard from inside the fixture repo. The real roots the
assertion checks are derived from `BATS_TEST_DIRNAME` — the checkout holding the
suite and the canonical repository behind it — never from the environment, so a
test cannot redirect the check along with the leak. The assertion covers the
session ids it is given and state written after the marker; a suite that writes
an id it does not list is not caught.

Outside bats the same rule holds: a jest or pytest test that executes a hook
script runs it with its working directory inside a temporary fixture repository,
or passes a payload `cwd` naming one.

### Testing a refusal's remedy

A refusal has two parts, the verdict and the remedy, and both are behavior. A
test that asserts the remedy's text pins its wording, not whether it works
([failure-lineage Entry 44](../failure-lineage.md#entry-44-five-refusals-named-a-remedy-that-could-not-complete-the-refused-action-the-tests-pinned-the-refusal-and-never-ran-the-remedy-october-2026)).
For a guard that names a remedy:

- **Run the remedy in the refusing fixture.** Produce the refusal, execute the
  remedy's commands literally in that state, and assert that the refused action
  — or the substitute the remedy names — completes.
- **Run it through the agent's path, not only git's.** An agent following the
  remedy passes through the PreToolUse classifier and the write guards first.
  Assert that each command the remedy names is admitted there; a remedy the
  classifier asks on is a block wherever `ask` cannot be answered.
- **Branch the remedy with the refused set.** When a guard refuses more than one
  kind of case — canonical checkout and lane, inside a merge and outside — test
  the remedy printed for each. A remedy written for the common case and printed
  on the rare one is the usual failure.
- **Name only surfaces that govern the block.** A waiver filters
  `caws gates run` and lifts no hook. A reprieve lifts a hook handler, is
  granted by a human, and does not change merge readiness. A merge-time
  lane-provenance refusal is lifted by
  `caws specs amend-scope <spec> --add-support <path>`.
- **Prove the hook ran.** `tests/helpers/git-repo-factory.js` sets
  `core.hooksPath=/dev/null` on every repository it creates, so a git hook under
  test never fires there unless the test points `core.hooksPath` back at the
  hooks it installs. A refusal test in such a fixture passes vacuously.

### Checks before merging a guard change

A change to any file under `templates/hook-packs/` is pinned from more places
than the hook tests. Run all of these in the worktree, after `npm run build`,
before `caws worktree merge`:

- **The whole jest suite and the whole bats suite**, not the directories that
  look related. `tests/runtime/` and `tests/tooling/` assert guard bytes and
  guard behavior, and a run limited to `tests/init`, `tests/hooks` and
  `tests/adapter` leaves them unrun.
- **The pack version and fingerprint.** Bump the pack's version constant
  (`SHARED_PACK_VERSION` in `src/init/hook-packs/manifest-shared.ts` for the
  shared pack), record why in the comment above it, and update the version and
  fingerprint in `tests/init/pack-fingerprints.json`. The failing fingerprint
  test prints the new value. Without the bump, installed packs are never offered
  the change.
- **The native compatibility identities.** `src/runtime/stock-handlers.ts` holds
  the sha256 of `agent-stop.sh`, `agent-heartbeat.sh`, `block-dangerous.sh` and
  `hook-utilities.sh`. The native runtime answers for one of those handlers only
  while the installed file matches its recorded hash; otherwise the shell
  handler runs. After changing one of them, decide whether the native
  implementation still gives the same answers. If it does, update the hash. If
  it does not, change the native implementation in the same slice or leave the
  hash, so the shell handler stays in charge.
  `tests/runtime/stock-handlers.test.js` runs both and compares them.
- **The dispatcher identities.** `lib/run-handlers.sh` is recorded by hash in
  `src/runtime/session-cache-admission.ts` and by exact lines in
  `src/runtime/service-image.ts`.
- **Not the reference inventory.** `tests/tooling/qualify-stop-profile.test.js`
  lists template hashes as a fixed, reviewed reference that current templates
  are compared against. It is not a pin to update when a template changes.

### Shell and test-harness traps

Each of these has passed a wrong guard or failed a right one.

- **Run bats with stdin closed and a clean environment:**
  `env -u GIT_EDITOR -u BATS_TEST_TIMEOUT npx bats tests/hooks/bats </dev/null`.
  When stdin is a socket, as it is under an agent's shell tool, a fixture's
  `env -i bash -c` sources `~/.bashrc` and its stray stderr line fails cases
  that assert on output.
- **bash 3.2 compares file times in whole seconds.** macOS ships bash 3.2 as
  `/bin/bash`, and its `-nt` and `-ot` ignore the fractional second. Two writes
  in one second compare as equal, so "changed since" is missed exactly when the
  changes are closest together. To detect that a file was replaced, keep a hard
  link and test `-ef`. Where only times are available, write the comparison so
  that a tie takes the safe branch.
- **Under bash 3.2 a false `[[ ... ]]` fails a bats case only as the last
  statement.** Assert with `[ ... ]` or a helper.
- **Run a handler from a directory that resembles a consumer's, not this
  repository's.** A handler that walks upward for `package.json` or `.git` finds
  this repository's when the test runner's working directory is inside it, and a
  fault that needs their absence stays hidden
  ([failure-lineage Entry 49](../failure-lineage.md#entry-49-an-advisory-handler-never-returned-on-a-relative-path-every-test-had-run-it-from-inside-a-package-november-2026)).
  Send relative paths as well as absolute ones; several harnesses do.
- **Bound a case that can hang by its process group.** `alarm` in the outer
  process ends only that process. A looping child keeps the case's output pipe
  open and the suite waits on it. Start the command in its own group and signal
  the group at the limit; `tests/hooks/bats/export-check-relative-target.bats`
  has the pattern.
- **Name a new test file past the shadow-file guard.**
  `tests/ci/release-path-integrity.test.js` rejects any tracked filename that
  matches a shadow or duplicate pattern, including one that only contains the
  word `duplicate`. The commit hook does not run that check; the jest suite
  does.
- **Confirm a new case can fail.** Remove the behavior it pins and run it. A
  case that passes against the unfixed handler is testing the fixture.
