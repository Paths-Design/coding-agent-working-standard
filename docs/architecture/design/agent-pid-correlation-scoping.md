# Scoping: Agent-PID session correlation for canonical-checkout callers

Status: **scoping draft** (not a spec yet). Author: sess_acb0b8de.
Motivating defect: the canonical-checkout case that
CAWS-RESOLVER-CWD-OWNERSHIP-CORROBORATION-001 (1aa014c3) deliberately did
NOT close, and a latent silent-misattribution in the shell-side resolver.

## The gap (verified live)

ZCode exports no session-id env var to tool subprocesses (confirmed: `env`
shows only `ZCODE_APP_VERSION` / `ZCODE_BASE_URL` / etc., no id). Both
resolvers therefore fall past their env tiers:

- **TS resolver** (`resolve-session.ts`): falls to the durable-envelope scan,
  which REFUSES on ≥2 fresh envelopes (`SESSION_DURABLE_ENVELOPE_AMBIGUOUS`).
  The cwd-ownership fix only helps callers inside a bound worktree; a
  canonical-checkout cwd matches no worktree, so it still refuses (A3b-3).
  This blocks `caws worktree merge` (which must run from canonical).
- **Shell resolver** (`session-id.sh:119-156`, the capsule tier): reached
  when the env chain misses. Its capsule fallback is
  `ls .../caws-*.json | head -1` — **first-match-wins, no freshness/repo/
  cwd filter.** Sterling has zero capsules today (so it returned `unknown`),
  but the moment ANY `caws worktree create` mints one, this resolver would
  silently attribute every canonical-checkout session to that stale capsule
  — a silent misattribution, worse than the TS side's loud refusal. This is
  what the write guards (`bash-write-guard.sh`, `worktree-write-guard.sh`)
  run on, via `CAWS_ORACLE_SESSION_ID`.

The constraint: N concurrent agent sessions share one `repoRoot` at canonical.
Any repoRoot-keyed record is ambiguous there. The env vars that would
disambiguate don't survive the tool boundary (env flows parent→child, never
child→parent; a hook cannot inject `HOOK_SESSION_ID` into the agent's Bash).

## The signal that DOES cross the boundary (verified)

The agent process is a stable, findable ancestor of BOTH the PreToolUse hook
subprocess AND the agent's `caws`/Bash command. For ZCode the chain is:

    ZCode (app) → zcode-host-local-N → zcode-cli (the agent) → /bin/zsh → caws|hook

Verified live from this session:
- `zcode-cli` (PID 26098) is **stable** for the whole session (started at
  session start; same PID throughout).
- **Distinct per concurrent session** (two agents = two `zcode-cli`).
- Both the hook and a fresh subshell reach it by walking the PID tree with
  `ps -o ppid=` (confirmed: a `zsh -c` simulating `caws` lands on 26098).
- The hook payload reliably carries `session_id` (sterling's 28 fresh
  envelopes prove `HOOK_SESSION_ID` is set inside the hook shell).

So the **agent PID** is a per-call-stable, per-session-unique key that
identifies the caller at canonical, without an env var — exactly the signal
both resolvers are missing.

## The mechanism (proposed)

Mirror the durable-envelope bridge (hook writes a record, resolver reads it),
but key it by agent PID. Persists in `.caws/sessions/` the same way the
session logs and envelopes do.

### Write side (hook — `parse-input.sh`, after `HOOK_SESSION_ID` is set)

Walk up the PID tree to find the agent process (match against a per-surface
process-name set — see open question 1), then write/refresh:

    <repoRoot>/.caws/sessions/agent-pid-<agentPid>.json
    {
      "agent_pid": <pid>,
      "session_id": "<HOOK_SESSION_ID>",
      "surface": "<CAWS_AGENT_SURFACE>",
      "repo_root": "<canonical repoRoot>",
      "started_at": "<agent process start time — for PID-reuse guard>",
      "last_seen_at": "<now>"
    }

Same atomic-write + 24h-freshness discipline as the durable envelope.
Non-fatal on any error. The `agent-pid-` prefix avoids the `caws-*.json`
capsule glob (line 139 of session-id.sh) and the per-session `<sid>/` subdirs.

### Read side — TWO insertion points (the parity point)

**TS resolver** (`resolve-session.ts`): a new tier between the env tiers and
the durable-envelope scan. Walk up the calling `caws` process's own PID tree
→ read `agent-pid-<pid>.json` → if fresh + repo-matched + start-time matches,
resolve to its `session_id`. Fires BEFORE the ≥2-envelope scan, so the
ambiguous canonical-checkout case resolves deterministically and never
reaches the refusal.

**Shell resolver** (`session-id.sh:resolve_caws_session_id`): the SAME tier,
inserted before the capsule fallback (line 119). This is the load-bearing
insertion for the write guards: `bash-write-guard.sh:85-86` and
`worktree-write-guard.sh` both set `CAWS_ORACLE_SESSION_ID` via
`resolve_caws_session_id_with_payload`, and the oracle
(`worktree-claim-oracle.cjs:263,319`) is a pure consumer that compares it
against `worktrees.json`'s `owner.session_id`. So fixing `session-id.sh`
fixes both guards AND the oracle in one edit — no oracle change needed.

The shell side has a stronger reason to land than just parity: its capsule
tier is a silent misattribution risk (first-match-wins), not a refusal.
Adding the agent-PID tier ahead of it turns that latent bug into a
deterministic resolution (and when no agent-PID record exists, the capsule
tier is unchanged — fail-open, no new refusals).

## Why this is safe (preserves the A3 ownership discipline)

- **Not newest-wins.** The agent PID is a property of the *calling process*,
  not a last-writer-wins singleton. Two concurrent sessions have distinct
  agent PIDs; each reads only its own record.
- **Cannot cross ownership.** Session A's PID-walk lands on A's agent
  process, never B's — so A cannot read B's record.
- **No env-var dependency.** Survives the tool boundary by construction
  (PID tree is a kernel property, not an env var).
- **Fails open.** Missing record / unfound agent ancestor / stale / start-time
  mismatch → falls through to the existing env→envelope→capsule chain. No new
  refusal modes; existing A3 behavior preserved when no record matches.

## Open questions to resolve before writing the spec

1. **Per-surface agent-process-name set.** Is `zcode-cli` stable across ZCode
   versions? What are the equivalent names for claude-code / codex / opencode /
   qwen / kimi? Need to probe each live (or accept the surface set
   `agent-surface.sh` documents). An unfound ancestor MUST fail-open, not
   refuse — the tier is a refinement, not a requirement.
2. **PID reuse.** A PID can be reused by the OS after a process exits. The
   24h freshness window bounds it; the `started_at` field + start-time
   validation on read closes the residual gap (a reused PID has a different
   start time). Decide whether to validate start-time (safer, one extra `ps`
   call) or accept the residual risk.
3. **Precedence vs the cwd-ownership fix (1aa014c3).** For worktree-resident
   callers both could fire. Likely: agent-PID tier runs first (it's the
   broader signal), cwd-ownership stays as a corroborator in the ≥2-envelope
   branch. Settle in the spec.
4. **Parity staging.** Ship TS + shell together (both refusals cleared in one
   slice) or stage TS-first (merge command) then shell (commit guard). The
   shell side is where the silent-misattribution lives, so shipping it closes
   a latent bug, not just friction — argues for together.
5. **Test surface.** The TS side has jest coverage patterns
   (`resolver-guard-divergence.test.js`). The shell side needs bats or a
   process-tree fixture — harder to unit-test a PID-walk. May need a
   `CAWS_AGENT_PID_OVERRIDE` test hook so the walk is injectable.

## What this supersedes / leaves alone

- Does NOT remove the cwd-ownership fix (1aa014c3) — it covers worktree
  residents authoritatively and stays as a fallback corroborator.
- Does NOT remove the durable-envelope scan or capsule tier — they remain as
  fail-open fallbacks. The agent-PID tier is inserted AHEAD of them.
- Does NOT require a ZCode-app change (unlike the "export a session env var"
  path, which is outside caws's control). This is fully achievable at the
  caws layer because it uses a signal (PID tree) the kernel already exposes.
