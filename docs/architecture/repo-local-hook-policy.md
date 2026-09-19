# Repo-local hook policy

A repo extends the shipped guard plane from its own `.caws/`, additively,
committed and reviewable, scoped to its git root — without forking a guard.

## The problem this replaces

A consumer that needs one behavior change in a shipped guard has one move
without this mechanism: copy the whole guard into `<repo>/.caws/hooks/`, edit
it, and register a whole-file override. Three things make that worse than it
looks.

- **The fork silences the staleness signal.**
  `doctor.hooks.installed_pack_version_lag` downgrades `warning` → `info` when
  drift is explained as local growth, so forking a guard to customize it
  suppresses the very signal that says the guard is now stale.
- **The override is invisible.** It lives in machine state under
  `~/.caws/state/projects/<sha256>.json` — outside the repo, outside git,
  outside review, absent on a fresh clone and in CI.
- **It reaches only half the surfaces.** Machine state is read by the
  machine-routed launcher (`claude-code`, `codex`). Project-wired surfaces
  (`qwen-code`, `kimi-code`, `opencode`, `zcode`, `dsh`) run a literal
  `HANDLERS=(...)` array baked into `.caws/hooks/dispatch/<event>.sh`.

## Location is the authority argument

The document lives at `.caws/hooks/hook-policy.json`.

`protected-paths.sh` admits only `*.md` under `.caws/hooks/`, so a `.json` there
is agent-write-blocked and human/CLI-writable. **The entity with the incentive
to paper over a block cannot author the paper.** It is not at `.caws/` root,
because that prefix is on `write-allowlist.sh`'s unconditional-allow list.
`.caws/hooks/` is git-tracked (`EPHEMERAL_CAWS_ENTRIES` ignores only
`.caws/hooks/.pristine/`), so the file is committed and scoped to the git root:
a local policy changes nothing for any other project.

## Two tiers

```jsonc
{
  "version": 1,
  "surfaces": {            // TIER 1 — which guards run
    "default": {
      "disabled":   { "<event>": ["handler.sh"] },
      "extensions": { "<event>": [{ "handler": "name.sh", "before": "anchor.sh", "reason": "…" }] },
      "handlers":   { "name.sh": ".caws/hooks/ext/name.sh" },
      "libraries":  { "name.sh": ".caws/hooks/lib-local/name.sh" },
      "forks":      { "scope-guard.sh": { "forked_from": { … }, "reason": "…", "approver": "…" } }
    },
    "claude-code": { /* same shape, merged over "default" per key */ }
  },
  "guards": {              // TIER 2 — what data a running guard uses
    "scope-guard.sh": {
      "additional_allow_prefixes": [
        { "prefix": "native/", "reason": "Rust core lives here; this repo has no src/." }
      ]
    },
    "god-object-check.sh": { "thresholds": { "loc": 2500 } }
  }
}
```

An absent file is `{}`, not an error. A malformed one fails closed.

## Tier 1 — which guards run

Precedence, in order:

```
1. stock chain from the runtime system-policy
2. -= repo.disabled[event]       3. += repo.extensions[event]    (anchors resolve post-2)
4. -= machine.disabled[event]    5. += machine.extensions[event] (anchors resolve post-4)
6. overrides = { ...repo.handlers,  ...machine.handlers  }
7. libraries = { ...repo.libraries, ...machine.libraries }
```

The repo file is the **team's** decision — committed, present in every clone and
in CI — so it runs first and is the shared baseline. Machine state is **this
operator's** decision, applied second. An operator can therefore locally silence
a team extension, while the team file cannot reach into an operator's local
additions. A duplicate handler across tiers fails closed.

### The safety floor

`REPO_POLICY_FLOOR = ['protected-paths.sh', 'block-dangerous.sh', 'agent-register.sh']`.

A handler is on the floor if and only if removing it breaks the mechanism that
makes the policy reviewable or its staleness observable: `protected-paths.sh` (a
policy that can authorize its own amendment is not a policy),
`block-dangerous.sh` (the same circularity via Bash — it can _destroy_ the tree
it cannot _edit_), `agent-register.sh` (carries the drift advisory and the
chain-freshness check).

The floor blocks both `disabled` and `handlers` for those names: replacing one
with a no-op is observationally identical to disabling it. It applies to the
**repo tier only**. Machine state keeps today's unrestricted power, because an
operator affecting only their own box is the existing and correct escape hatch.
`scope-guard.sh` is deliberately not on the floor — it is precisely the guard
consumers have needed to change.

## Tier 2 — what data a running guard uses

The `command-adapters` rule "no key may name a decision" does not transplant
here: adding `.tmp/` to an allow list _is_ a verdict change for `.tmp/`. The
authority boundary is drawn on **direction and floor** instead.

- **R1 — append-only over a floor.** Only `additional_*` keys exist. No key
  removes, replaces or reorders a shipped entry, so `.caws/` can never leave
  `ALLOW_PREFIXES`. The replace-form hits `additionalProperties: false` and the
  document fails closed.
- **R2 — data, never decisions.** A document carrying
  `decision|allow|deny|ask|policy|outcome|severity|override|enforcement|exit_code|verdict`
  at any depth is rejected.
- **R3 — contained and bounded.** Repo-relative, trailing-slash, no `..`, no
  absolute paths, no glob metacharacters, no whitespace. Reserved prefixes are
  rejected: `.caws`, `.git`, `.github/workflows`, every vendor dir. Counts and
  lengths are capped; thresholds are clamped per guard.

**The absolute-path ban is load-bearing, not tidiness.** `scope-guard.sh` honors
_absolute_ allow-prefixes ahead of its foreign-repo containment block, so an
absolute entry would punch a hole straight through cross-repo containment.

Fail-closed is cheap here precisely because append-only makes "apply nothing"
the _stricter_ outcome: a malformed document degrades toward refusal, never
toward permission. One bad entry therefore applies **zero** entries — a
partially-applied document would leave the repo running a configuration nobody
authored. `CAWS_GUARD_CONFIG_STATUS` still reports `invalid` so the state is
observable rather than silent, and `caws doctor` names the offending key.

Every list entry requires a `reason` of 12–280 characters. Because the document
is committed, that turns "the guard is broken" into a reviewable artifact in the
diff instead of a private grievance. `caws hooks list` renders the recorded
reason for a tier-1 `disabled` entry and for a `forks` entry; **it does not yet
render tier-2 `additional_allow_prefixes` reasons**, so today those are read in
review, not from the CLI.

### The configurable surface

`GUARD_CONFIG_SURFACE` is a **closed set**: an unrecognized guard name is
refused rather than ignored, because a silently inert setting is
indistinguishable from one that worked.

| Guard                 | `additional_allow_prefixes` | `thresholds`                            |
| --------------------- | --------------------------- | --------------------------------------- |
| `write-allowlist.sh`  | yes                         | —                                       |
| `scope-guard.sh`      | yes                         | —                                       |
| `god-object-check.sh` | —                           | `loc` (100–100000), `delta` (10–100000) |
| `loc-delta-check.sh`  | —                           | `delta` (10–100000)                     |

`loc-delta-check.sh` spells its key `delta`, not `loc`, even though its filename
contains "loc": the value bounds a per-edit line delta, the same quantity
`god-object-check.sh` calls `delta`. A key meaning one thing in one guard and
something else in another is what consumers misconfigure.

Threshold precedence is **env > config > shipped default**. Env first is the
compatibility guarantee — a repo already tuning a threshold through a
`.claude/settings.json` env block keeps working untouched — and a per-session
override is a narrower, more current statement of intent than a committed file.

### Deliberately not exposed

These tables _are_ the floor: `protected-paths.sh` artifact classes,
`write-allowlist.sh`'s `.caws/worktrees/*` payload exclusion, `scope-guard.sh`
foreign-repo containment, the `guard-strikes.sh` 1/2/3 ramp, `CAWS_TRAP_KILL`.

## One parse per dispatch

`lib/guard-config.py` parses both documents exactly once per dispatch — called
from `lib/run-handlers.sh`, before the handler loop — and prints `NAME=VALUE`
lines that `lib/guard-config.sh` exports. Every adopting guard then reads plain
environment variables and spawns nothing.

**This is a measurement, not a preference.** A `python3` start costs ~31ms on an
M-series mac. The `pre_tool_use` chain already carries a double-digit number of
them, so one more is inside the noise; four adopting guards each parsing for
themselves would add ~124ms to _every_ tool call. The accessors are pure bash
3.2 for the same reason: `${var^^}` is bash 4, macOS ships 3.2, and a `tr`
subshell in an accessor would reintroduce exactly the per-call spawns the shared
parse exists to remove.

The transport is **indexed** (`CAWS_GUARD_ZONE_COUNT` + `CAWS_GUARD_ZONE_0`,
`_1`, …) rather than whitespace-delimited, because `non_governed_zones` is read
line-wise and a zone may legitimately contain a space. A space-delimited
transport would split it silently — a scope change disguised as a refactor. Only
names matching `CAWS_GUARD_[A-Z0-9_]*` are exported, so a corrupted parse cannot
inject `PATH` or `HOME` into the guard chain.

Guards resolve the parser as `lib/guard-config.sh`'s own sibling rather than
through `HOOKS_DIR`, which only `run-handlers.sh` sets. A guard invoked directly
— by a test, by a harness calling one hook, by a human debugging — would
otherwise find nothing and report `unavailable` with the document sitting right
there.

### Degradation

A pack predating the loader has no function to call, and every adopting guard
falls back to its shipped table: **degraded, never disarmed**. Because every key
is append-only, the shipped table is strictly the stricter behavior, so the
degraded path and the safe path are the same path.

The one place that is loud rather than silent: when `lib/guard-config.sh` is
missing _and_ `.caws/policy.yaml` declares `non_governed_zones`,
`scope-guard.sh` says so on stderr. Unhonored zones refuse **more** than the
repo declared — safe, but it reads as a scope bug to whoever hits it, and a
guard that is silently stricter than its own policy file is what pushes a team
to fork it.

## `policy.yaml` `non_governed_zones`: aliased, not migrated

The key keeps its name and its kernel semantics. Only the transport moved: the
inline `awk` that used to live in `scope-guard.sh` now runs inside
`lib/guard-config.py`, so one parse serves every adopter. Quote-stripping, the
`/**` and `/*` suffix trim and the trailing-slash coercion are reproduced
verbatim.

Authoring rule:

- Outside CAWS scope governance entirely → `policy.non_governed_zones`.
- Governed, but one guard's table needs to know → `hook-policy.json`.

## Config or upstream fix?

> **Would this entry be correct in a repo with a different directory layout?**

Specific to _your_ names (`native/`, `workbench/`, `.tmp/`) → configuration.
Correct in _every_ repo ("scope-guard should consult write-allowlist.sh") →
**upstream defect**; a configuration entry there is a workaround that will rot.

## Why `adapter-policy.json` is superseded, not evolved

Its shape is a frozen full copy of the stock chain
(`{events: {<event>: {hooks_dir, handlers[]}}}`). Adding additive keys beside a
key meaning "the whole frozen list wins" re-creates the fork. It also asserts an
exact key set, so adding a key would hard-block every repo on an older pinned
runtime — which is why all three top-level keys are declared in v1 even before
each is consumed.
