# USER-E2E-SETUP-REHEARSAL-001 — Final Report

## 0. Executive verdict

**Overall readiness: NOT-READY for first-contact external users.**

Reason: two surfaces were exercised, and the readiness blocker is the gap between them, not either one in isolation.

- **v11.6 development surface** (the one the host CAWS repo currently builds): `READY-WITH-DOC-GAPS`, bounded by two P0 code defects (`caws status` / `caws agents list` crash; `caws claim` prints actively-misleading downgrade advice). The core lifecycle (init → spec → worktree → governed change → merge → auto-close) works end-to-end and is well-instrumented.
- **v10.2 published/global npm surface** (the one a first-contact user actually obtains from `npm install -g @paths.design/caws-cli`): `NOT-READY`. The published CLI is a full major version behind the kit/docs/dev workflow. `caws init` destructively overwrites customized `.claude/` files without warning. `caws diagnose` is broken on healthy monorepos. `caws status` contradicts `caws scope show` from the same cwd. The worktree/sparse doctrine the kit and v11 docs assert is not enforced by the v10.2 binary.

**The governing readiness blocker is published-surface skew.** What a user installs is not what the maintainer's kit, docs, and dev workflow describe. Until distribution is reconciled, every downstream readiness claim is unstable.

**Evidence model and provenance:**

| Surface | Primary evidence | Provenance | Completeness |
|---|---|---|---|
| v11.6 | `/tmp/fsds-caws-rehearsal/transcript/FINAL-REPORT.md` + 9 per-phase files + 50 raw command outputs | Live on disk post-rehearsal | Full |
| v10.2 | `docs/reports/turn.10.2.json` (Claude Code turn log, ~370 KB) — HANDOFF summary recovered from `timeline` and `turn_summary` fields | The 10.2 on-disk `FINAL-REPORT.md` and per-phase files were overwritten when the 11.6 run started in the same `/tmp/fsds-caws-rehearsal/` workspace | Summary-only; per-phase detail is **not recoverable** |

The v10.2 observation is therefore reported in §11 (appendix) as a recovered HANDOFF, quoted verbatim from the JSON turn log. It does NOT claim the same evidence completeness as the 11.6 body. It is, however, the more important first-contact-user observation, because the published surface is what real users encounter.

---

## 1. Repo chosen and why

- **Target**: `full-stack-ds` at SHA `a57ec2d2844a2f6cfa40e54f8fefd6b8d7c71f1e` (HEAD of main at rehearsal start, 2026-05-26).
- **Clone path**: `/tmp/fsds-caws-rehearsal/target` (cloned from the live working tree at the path above to avoid disturbing in-progress changes).
- **Pre-rehearsal state of clone**: clean working tree at `a57ec2d`, detached HEAD post-checkout (later branched to `rehearsal-base` for worktree base support).
- **Limitations of the clone-vs-live posture**: a live-repo rehearsal would also exercise dirty-working-tree friction (the live full-stack-ds has 30+ untracked generated `.tsx` files under `packages/ds-figma-plugin/src/generated/components/`, plus a modified `.claude/settings.json`). The kit explicitly excluded this for safety; the absence of that test is logged in §10.
- **Why this repo**: a non-trivial pnpm-based monorepo with TypeScript, Turbo, Vitest, ESLint, Vite, and pre-existing `.claude/hooks/` infrastructure — exactly the kind of "real existing project" that the rehearsal is designed to observe a first-contact user adopting CAWS into.

## 2. Starting state

| Property | Value |
|---|---|
| Clone HEAD | `a57ec2d2844a2f6cfa40e54f8fefd6b8d7c71f1e` |
| Branch | detached → `rehearsal-base` |
| Toolchain detected | Node 22.19.0 (via nvm), pnpm 10.14.0, npm, git |
| CAWS binary identity | `/Users/darianrosebrook/.nvm/versions/node/v22.19.0/bin/caws` → `…/lib/node_modules/@paths.design/caws-cli/dist/index.js` |
| CAWS binary install source | Global npm install of `@paths.design/caws-cli` |
| CAWS binary version | `11.1.6` |
| CAWS host repo version | `11.1.6` (per kit §5.10) |
| Version skew | **none** (for this rehearsal run; see §11 for the v10.2 published-surface observation) |

**Structural finding (S0-1)**: the target repo is **not CAWS-naive**. While `.caws/` is absent, the repo has a committed `.claude/hooks/` directory (from commit `27b98ad chore(claude): seed project hooks + settings`) containing the full CAWS Claude-Code hook surface (`scope-guard.sh`, `worktree-guard.sh`, `block-dangerous.sh`, etc., plus `dispatch/`, `lib/`, and a `session_log_renderer.py`). This is the agent-surface that `caws init --agent-surface claude-code` is supposed to install. The kit's "first-contact" framing is therefore subtly off for this target; a strictly-naive repo would behave differently.

## 3. Command transcript, grouped by phase

Full per-phase markdown files at `/tmp/fsds-caws-rehearsal/transcript/p{0..8}-*.md`. Raw output captures at `/tmp/fsds-caws-rehearsal/transcript/raw/` (50 files, ~256 KB total).

### P0 — Setup
Clone full-stack-ds; verified `.caws/` absent; pnpm install completed in 3.5s. **Finding**: `.claude/hooks/` already committed — partial-CAWS state.

### P1 — Install / source check
`caws --version` → `11.1.6`. `which caws` → `~/.nvm/.../bin/caws`. `caws --help` lists all 11 v11.1 command groups (init/doctor/scope/status/claim/gates/evidence/waiver/specs/worktree/agents). Zero version skew.

### P2 — First init
`caws init` exit 0. Created `.caws/` (12 KB: `policy.yaml`, empty `worktrees.json`, empty `agents.json`, empty `specs/`, `waivers/`). Created 6 new `.claude/hooks/` files (notably 52 KB `classify_command.py`). **Refused 16 existing hook files** with `unmanaged_collision`; provided a clear recovery menu (`--overwrite | --adopt | rename/remove`). Settings.json wiring detected as already-correct. Explicitly told user to restart the Claude Code session (kit §5.5 doctrine confirmed).

### P3 — Doctor comprehension
`caws doctor` exit 0, `0E/0W/0I`. **`caws status` crashes** with `(0 , caws_kernel_1.summarizeActiveAgents) is not a function` and exit 0 — major defect.

### P4 — First spec
Bare `caws specs create` rejected for missing `--title` (clear error, exit 0 — should be non-zero). Full-flag create succeeded; `list` and `show` both worked immediately. `kit-flagged "show returns not-found right after create"` did NOT reproduce. Tier-2 create rejected with `Tier 2 specs require at least one contract` — accurate but no workaround hint provided.

### P5 — First worktree
`caws worktree create first-slice --spec FIRST-SLICE-001` exit 0; created at `.caws/worktrees/first-slice` with sparse-checkout active (`/* + !/.caws/specs/`), registry populated, bidirectional spec binding written (spec now has `worktree: first-slice` field). **`node_modules/` absent in worktree** — kit-anticipated friction reproduced. **`caws agents list` also crashes** with the same `summarizeActiveAgents` error. **`caws claim` from canonical root prints actively-wrong advice**: "v11.0.0 does not ship worktree lifecycle commands; pin to caws-cli@^10.2.x" — a stale string that would mislead users into downgrading.

### P6 — First governed change
`caws scope show README.md` (post-amendment) → `ADMIT`. Edited `README.md` (whitespace + comment). `pnpm test` failed because `node_modules/` absent in worktree (kit §6 expected). Hook activity: zero — kit §5.5 doctrine confirmed (hooks installed at P2 not active in pre-existing session). `.caws/events.jsonl` hash-chain audit log working correctly (3 events after P5).

### P7 — First merge / close
`caws worktree merge first-slice --dry-run` → one-line `ready to merge.` (unhelpfully terse, even with `--data`). Actual merge → exit 0, one-line success with merge commit SHA and auto-closed spec id. Spec auto-closed (`lifecycle_state: closed`, `resolution: completed`, `closure_notes: Auto-closed by caws worktree merge first-slice at <sha>`). Worktree directory removed; git worktree de-registered; `.caws/worktrees.json` back to `{}`; 3 new audit events (spec_closed, worktree_merged, worktree_destroyed) chained correctly. **This phase exhibited the strongest positive behavior in the rehearsal.**

### P8 — Cleanup
`caws doctor` 0/0/0 (unchanged from P3). `caws specs list` shows the closed spec. Worktrees dir empty. Final `git status --short` still has `.caws/` and 5 hook files untracked — the lifecycle never told the user to commit them.

## 4. Files changed by each phase

| Phase | Added | Modified | Deleted | Notes |
|---|---|---|---|---|
| P0 (clone+install) | `node_modules/`, lockfile updates | — | — | Per pnpm. No source changes. |
| P1 (install check) | — | — | — | Read-only. |
| P2 (caws init) | `.caws/` (5 paths, 12 KB), `.claude/hooks/{classify_command.py, reset-danger-latch.sh, agent-register.sh, agent-heartbeat.sh, agent-stop.sh, CLAUDE.md}` (~68 KB) | — | — | Zero changes to package.json, pnpm-lock.yaml, turbo.json, .gitignore. |
| P3 (doctor) | — | — | — | Read-only (`caws status` also did not mutate state). |
| P4 (specs create) | `.caws/specs/FIRST-SLICE-001.yaml` (594 B), `.caws/events.jsonl` (seq 1) | — | — | |
| P5 (worktree create) | `.caws/worktrees/first-slice/` (sparse), git branch `first-slice`, `.caws/events.jsonl` seq 2,3 | `.caws/worktrees.json` (`{}` → bound entry), `.caws/specs/FIRST-SLICE-001.yaml` (added `worktree: first-slice`) | — | |
| P6 (edit) | — | `.caws/specs/FIRST-SLICE-001.yaml` (scope.in amended, manual YAML edit), `README.md` (in worktree, 2-line append) | — | Spec amendment NOT recorded in `events.jsonl` — finding. |
| P7 (merge) | merge commit `7e3e9f2`, `.caws/events.jsonl` seq 4,5,6 | `.caws/specs/FIRST-SLICE-001.yaml` (closed), `.caws/worktrees.json` (entry removed) | `.caws/worktrees/first-slice/` (removed) | |
| P8 (verify) | — | — | — | Read-only. |

## 5. Diagnostics encountered

| Phase | Source command | Diagnostic (text/summary) | Classification | Actionable by new user? |
|---|---|---|---|---|
| P2 | `caws init` | `unmanaged_collision` (16 hooks) with `--overwrite | --adopt | rename/remove` repair menu | clear | yes |
| P2 | `caws init` | "Restart the Claude Code session so the updated hooks load." | clear (kit §5.5 doctrine) | yes (mechanism implicit) |
| P3 | `caws doctor` | `findings 0E/0W/0I` despite 16 collisions from P2 | technically-correct-but-confusing | maybe |
| P3 | `caws status` | `(0 , caws_kernel_1.summarizeActiveAgents) is not a function` | **wrong (runtime defect)** | **no** |
| P4 | `caws specs create` (bare) | `error: required option '--title <title>' not specified` (doubled prefix) | clear (cosmetic noise) | yes |
| P4 | `caws specs create` (tier 2) | `Tier 2 specs require at least one contract.` | technically correct, no workaround hint | no |
| P5 | `caws worktree create` (success) | `created first-slice at .caws/worktrees/first-slice (spec: FIRST-SLICE-001)` (no next-step guidance) | clear-but-thin | partial |
| P5 | `caws agents list` | Same `summarizeActiveAgents` crash | **wrong (runtime defect)** | **no** |
| P5 | `caws claim` (outside worktree) | `v11.0.0 does not ship worktree lifecycle commands... pin to caws-cli@^10.2.x` | **wrong (stale string, actively misleading)** | **no — would cause user to downgrade and break their setup** |
| P5 | `caws claim` (inside worktree) | `worktree.ownership.foreign_owner_blocked` with `--takeover` hint | clear | yes |
| P5 | `caws scope show README.md` (pre-amend) | `REJECT scope.reject.root_not_allowed`, repair: "Add to scope.in or policy.root_passthrough" | clear and actionable | yes |
| P6 | `caws scope show README.md` (post-amend) | `ADMIT scope.admit.scope_in`, message quotes matching entry | clear | yes |
| P6 | `pnpm test` (in worktree) | `vitest: command not found; node_modules missing` | clear (kit §3.5 expected) | yes (but requires CAWS-specific knowledge) |
| P7 | `caws worktree merge first-slice --dry-run` | `ready to merge.` (single line, no detail) | unactionable | partial |
| P7 | `caws worktree merge first-slice` (success) | `merged first-slice (merge_commit: ...; auto_closed_spec: ...)` | clear | yes |
| P8 | `caws doctor` (final) | unchanged from P3 (0/0/0) | clear (silent) | partial (no signal that lifecycle completed) |

## 6. Places where the user would likely stop or ask for help

Ordered most-likely-to-stop first:

1. **P3 — `caws status` crash**: a new user runs the second-most-prominent command in the help output and gets a TypeError-like message about an internal symbol they've never heard of. The fallback "see docs" suggestion does not explain what happened. **A first-contact user would conclude "CAWS is broken" and probably abandon.** Recovery requires knowing that `caws doctor` and `caws specs list` work — which the user has no reason to try.

2. **P5 — `caws claim` outside worktree, version-history error string**: "v11.0.0 does not ship worktree lifecycle commands... pin to caws-cli@^10.2.x" reads as authoritative installation advice. A diligent user would attempt `npm install -g @paths.design/caws-cli@^10.2.x` to comply — **breaking their working setup**. **This is the most actively-harmful diagnostic in the rehearsal.**

3. **P5 — node_modules absent in worktree**: a user trying to run their normal `pnpm test` (or any node-based check) inside the worktree will get "command not found" for whatever dev dependency they were calling. The CAWS-side workflow does not explain that the worktree is sparse + dependency-bare. A user without monorepo/sparse-checkout knowledge would be puzzled.

4. **P4 — Tier-2 contract requirement with no workaround hint**: a user asking for the rigor of tier 2 will be told "needs a contract" with no instructions on how to provide one. They will likely silently downgrade to tier 3, missing the gate they were trying to opt into.

5. **P6 — first edit being rejected by scope-guard**: even though the diagnostic is clear and provides two repair paths, a first-contact user who didn't think to pre-check with `caws scope show` will see their first edit attempt fail, then need to leave the worktree, edit `.caws/specs/<id>.yaml` in the canonical root, and return. The choreography is unobvious from CLI surface; only via reading the documentation does it become natural.

6. **P5 — cross-shell foreign-owner block**: every new shell session gets a new `caws-<id>` identity. Users switching between iTerm/tmux/Cursor will see "foreign owner; takeover not authorized" repeatedly. The fix (`--takeover`) is correct but unobvious.

7. **P7 — dry-run unhelpfulness**: a careful user running `--dry-run` learns nothing about what will happen. They cannot use dry-run to build confidence; the choice is "trust the binary or don't run merge."

A real user could plausibly complete P1–P2 unaided. P3 alone is enough to abandon. P5's claim diagnostic could cause active harm (downgrade).

## 7. Evidence table

| Acceptance criterion | Evidence | Pass/Fail |
|---|---|---|
| A1 (transcript complete) | 9 phase files + 50 raw files in `/tmp/fsds-caws-rehearsal/transcript/` (~256 KB) for the 11.6 run; recovered HANDOFF summary in `docs/reports/turn.10.2.json` for the 10.2 run | PASS (11.6); PARTIAL (10.2 — see §0 evidence model) |
| A2 (10-section report) | this document, all 10 sections present, plus §0 executive verdict and §11 appendix | PASS |
| A3 (kit reproducible) | The kit's 7-phase structure was executable verbatim across both runs. Only deviation: phases extended where commands surfaced unexpected behavior (status crash, claim-version-error in 11.6; init-overwrite, diagnose-broken in 10.2). Decision table §6 covered most cases; no mid-run kit revision was needed. | PASS |
| A4 (cleanup) | 11.6 P8 verified: `.caws/worktrees/` empty, registry `{}`, spec `closed`, audit log intact at 6 events. The 10.2 run cleanup status is recovered HANDOFF; clone still present at `/tmp/fsds-caws-rehearsal/` (which was overwritten by the 11.6 run anyway) | PASS (11.6); RECOVERED-ONLY (10.2) |
| A5 (fixes traceable) | §9 below; each finding cites the transcript file (`pN-*.md`) or, for the 10.2 observation, the JSON turn log + appendix §11 | PASS |
| A6 (escalation handled) | Zero HANDOFFs emitted in either run; all friction was recordable, the kit's §6 decision table covered every case | PASS |

## 8. Readiness verdict

**Overall: NOT-READY for first-contact external users.**

Surface-specific verdicts:

- **v11.6 development surface**: `READY-WITH-DOC-GAPS`, bounded by two P0 code defects.
- **v10.2 published/global surface**: `NOT-READY`.

Interpretation: the v10.2 result is not a historical comparison. It is the **distribution-surface result** — what a user actually obtains today if they run `npm install -g @paths.design/caws-cli` and follow the kit/host doc workflow. That makes published-surface skew a P0 readiness blocker independent of the 11.6 code defects.

**Justification for the v11.6 surface verdict (the rehearsal's strongest evidence):** CAWS v11.1.6 successfully delivered the core spec-lifecycle-worktree-merge workflow end-to-end. The transactional merge behavior is exemplary; the audit log (events.jsonl) is rigorous; scope-guard ADMIT/REJECT messages are exactly the kind a user can act on; the kit doctrine (§5) predicted nearly every behavior correctly. However, two prominent commands in the v11.1 surface — `caws status` and `caws agents list` — emit a TypeScript runtime error instead of working. And `caws claim` from outside a worktree emits actively-harmful version-skew advice. A first-contact user who runs the obvious sequence (`caws --help` → `caws status` → ?) will conclude the tool is broken. Until these are fixed, the v11.6 readiness is bounded; first-contact users will reach for `status` immediately and bounce.

**Justification for the v10.2 surface verdict (recovered, from §11):** the published CLI is one full major version behind. `caws init` overwrites customized `.claude/` files (+1216/-827 lines) without warning or `--force` requirement. `caws diagnose` flags healthy pnpm monorepos as broken and inverts the kit's exit-code semantics. `caws status` inside a worktree contradicts `caws scope show` from the same cwd. The worktree-sparse doctrine the kit and v11 docs assert is not enforced by the v10.2 binary. The one cleanly-working surface in the 10.2 run, per the recovered HANDOFF, was the worktree-merge lifecycle in P7.

## 9. Prioritized fix backlog

### P0 — blocks setup completion

#### P0-0: Published-surface skew — first-contact users get v10.2 while the kit/docs/dev workflow assume v11.6

- **What**: `npm install -g @paths.design/caws-cli` resolves to `@paths.design/caws-cli@10.2.0`. The host CAWS repo and the rehearsal kit assume the v11.1 command surface (init/doctor/scope/status/claim/gates/evidence/waiver/specs/worktree/agents). A first-contact user following any kit-derived or doc-derived workflow immediately hits unknown-command/unknown-option errors. The v11.6 tarball that produced the 11.6 rehearsal evidence is not on the public registry — or if it is, the latest tag observable to `npm install -g` resolves to 10.2.0.
- **Traceability**: `docs/reports/turn.10.2.json` (recovered HANDOFF, §11 of this report); rehearsal kit §5.10 (asserts CAWS host repo at `11.1.6`); §0 evidence model.
- **Why P0**: a user following the published install path receives a command surface materially behind the documented/dev workflow. This makes every downstream readiness claim unstable until distribution is reconciled. A user cannot reasonably be expected to discover they need a local tarball install to get the kit/docs to work. The 10.2 surface itself has additional defects (destructive `init`, broken `diagnose`) that compound the problem.
- **Possible resolutions** (a follow-up slice should decide which):
  - Publish v11.x to npm under the latest tag.
  - Pin the kit, CLAUDE.md, AGENTS.md, and docs/architecture/* to v10.2.0 with full command-surface translation (effectively a rollback of the public-facing doctrine).
  - Introduce explicit "dev vs published" install channels (e.g., a `next` dist-tag for v11 prereleases) with the kit/docs explicitly naming which channel they describe.
- **Candidate follow-up slice**: `RELEASE-DISTRIBUTION-SURFACE-RECON-01`.

#### P0-1: `caws status` and `caws agents list` crash on `summarizeActiveAgents`

- **What**: Both commands fail with `(0 , caws_kernel_1.summarizeActiveAgents) is not a function`. The function `summarizeActiveAgents` is referenced from the kernel but is either not exported or not implemented in caws-cli@11.1.6.
- **Traceability**: `transcript/p3-doctor-comprehension.md` (status), `transcript/p5-first-worktree.md` (agents list), raw files `raw/p3-status-crash.txt`.
- **Why P0**: `caws status` is the second command after `init` that a first-contact user would naturally run (per `--help` ordering, per the kit's session-protocol "check project health" habit, per kit §5 doctrine #6 which calls out `status` as a documented v11.1 command). Receiving an internal stack-trace-like error message is a likely abandonment point. The bug is hit on a fresh CAWS install with no special preconditions. Additionally, the crashed commands exit with status code **0**, defeating any CI or scripted detection.
- **Candidate follow-up slice**: `CAWS-STATUS-AGENTS-SUMMARIZE-ACTIVE-AGENTS-01`.

#### P0-2: Shared stale v11.0.0 / pin-to-10.2.x diagnostic advice in multiple commands

- **What**: A stale lifecycle-gap diagnostic referring to "v11.0.0" and recommending `pin to caws-cli@^10.2.x` is emitted by at least two distinct commands in v11.6:
  - `caws claim` (outside a worktree): `caws claim: cwd is not inside a CAWS-tracked worktree. v11.0.0 does not ship worktree lifecycle commands; create the worktree externally (git worktree add) and register it via a future caws worktree command (planned for v11.1). To use lifecycle commands today, pin to caws-cli@^10.2.x.`
  - `caws scope show <path>` (canonical cwd): the `repair:` line of an unbound-decision diagnostic includes `... (v11.0.0 does not ship caws worktree bind; pin to caws-cli@^10.2.x for the convenience command.)`
  The presence in two commands indicates a shared diagnostic template (or shared copy-pasted text) rather than a single localized bug.
- **Traceability**: `transcript/p5-first-worktree.md` and raw `raw/p5-create.txt` for the `claim` site; live `caws scope show docs/reports/user_e2e_setup_rehearsal_001.md` invocation at amendment time for the `scope` site (the diagnostic was emitted while the maintainer was scope-checking the report itself before commit).
- **Why P0**: this advises downgrading to caws-cli@10.2.x. The installed version is 11.1.6 and *does* ship worktree lifecycle commands (the user just used them). A diligent user who runs `npm install -g @paths.design/caws-cli@^10.2.x` would break their setup. The error string is a stale fragment from an earlier release. Because it appears in multiple commands, the fix must search the codebase for all diagnostics referencing `v11.0.0`, `pin to caws-cli@^10.2.x`, and related lifecycle-gap remnants — not just patch the one observed in `claim`.
- **Candidate follow-up slice**: `CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01` (scope is broad — every diagnostic in the codebase containing those stale phrases — not just `caws claim`).

### P1 — causes likely user abandonment

#### P1-1: Exit code is 0 on user-facing failures across multiple commands

- **What**: `caws status`, `caws agents list`, `caws specs create` (bare), `caws specs create` (tier 2 / contract-required), and `caws worktree merge --dry-run` (success or failure path indistinguishable) all return exit 0 even when they emit error text. Only `caws claim` (from inside worktree, on foreign ownership) returned a non-zero exit (1) in the entire rehearsal.
- **Traceability**: `transcript/p3-doctor-comprehension.md` (status), `transcript/p4-first-spec.md` (specs create failures), `transcript/p5-first-worktree.md` (agents).
- **Why P1**: scripting CAWS in CI or pre-commit hooks will silently pass when commands have failed. The commander.js default behavior is the likely root cause; an explicit `process.exit(1)` on error paths would fix it. A user manually running these will still see the error text, but any automation built around CAWS is unreliable.

#### P1-2: `caws worktree create` provides no post-create guidance

- **What**: Success message is `created first-slice at .caws/worktrees/first-slice (spec: FIRST-SLICE-001)` — one line. Does not say (a) to `cd` into the worktree, (b) that `node_modules/` is absent (must `pnpm install` inside), (c) that `.caws/specs/` is sparse-excluded (use `caws scope show` instead of file ops), (d) that `scope.in` may still be a TODO placeholder that will block edits.
- **Traceability**: `transcript/p5-first-worktree.md`.
- **Why P1**: a user who follows the success message verbatim will (i) try to edit and be blocked by scope-guard, (ii) try `pnpm test` and get "command not found", (iii) try to read the spec from inside and find the file empty. Three friction points stacked at the most critical workflow moment. A multi-line post-create guidance block — even three lines — would close most of the gap.

#### P1-3: `caws worktree merge --dry-run` produces no actionable output

- **What**: Both `--dry-run` and `--dry-run --data` output one line: `ready to merge.` (or the failure equivalent). The user learns nothing about *what* will be merged, *which* branches, *whether* the spec will close, or *which* events will be emitted.
- **Traceability**: `transcript/p7-first-merge-close.md`.
- **Why P1**: dry-run is the user's safety net for an irreversible-looking operation. If dry-run cannot inform the user, it cannot be recommended; if it can't be recommended, users will run live and occasionally regret it. Multi-line dry-run output describing the planned actions would unlock the safety habit.

### P2 — confusing but recoverable

#### P2-1: Tier-2 contract requirement has no workaround hint in the error message

- **What**: `[ERROR] store.lifecycle.plan_rejected: Tier 2 specs require at least one contract.` The user is not told how to provide a contract, or that the kit-recommended workaround is "create at tier 3, amend later."
- **Traceability**: `transcript/p4-first-spec.md`.
- **Why P2**: not a blocker (user can create at tier 3 and discover amendment by reading docs), but the diagnostic itself does not point at the workaround. Add: "Hint: contracts are not accepted at create-time. Create at risk-tier 3 and add a `contracts:` entry to the YAML, or amend later via `caws specs update`."

#### P2-2: Doctor delta between "init refused 16 files" and "doctor 0E/0W/0I" is jarring

- **What**: P2's `caws init` reports 16 hook collisions; the very next `caws doctor` reports zero findings. A user reasonably expects doctor to summarize post-init posture.
- **Traceability**: `transcript/p3-doctor-comprehension.md`.
- **Why P2**: comprehension gap, not defect. Either doctor should add an INFO-level finding for `unmanaged_collision` hooks ("16 hooks are present in `.claude/hooks/` but not pack-managed; CAWS is not enforcing them"), or doctrine should explicitly clarify that doctor's scope is `.caws/` drift only.

#### P2-3: Doctor delta from "clean repo" to "spec closed after merge" is empty

- **What**: P3 and P8 both report `findings 0E/0W/0I` from `caws doctor`. A user who completed a full lifecycle and looks at doctor sees no signal that the lifecycle occurred or completed cleanly.
- **Traceability**: `transcript/p3-doctor-comprehension.md`, `transcript/p8-cleanup.md`.
- **Why P2**: not a blocker — but the audit signal is buried in `events.jsonl` (which the user has no reason to know about). Either doctor should surface the last-merged-spec summary, or the merge command should print a "summary of changes" pointer ("3 events appended to .caws/events.jsonl; spec FIRST-SLICE-001 now lifecycle: closed").

#### P2-4: Manual YAML edits to scope.in have no audit footprint

- **What**: I edited `.caws/specs/FIRST-SLICE-001.yaml` to add `README.md` to `scope.in`. No event was emitted to `.caws/events.jsonl`. The scope-guard immediately respected the change (good ergonomics), but there's no trace of *when* / *who* widened the scope, except `git blame` after the spec is committed.
- **Traceability**: `transcript/p6-first-change.md`.
- **Why P2**: not a defect (the YAML is the source of truth, and git records edits to it). But for auditability, a `spec_amended` event triggered by detected modifications would be valuable. Alternatively, exposing `caws specs update` (the kit references it; it does not appear to be implemented in 11.1.6 — verify) as the documented amendment path would close this.

### P3 — polish / docs

#### P3-1: `error: error:` double prefix on commander.js validation errors
- **What**: `caws specs create` (bare) outputs `error: required option '--title' not specified` followed by `Error: error: required option '--title' not specified`. Two layers wrapping each other.
- **Traceability**: `transcript/p4-first-spec.md`.
- **Why P3**: cosmetic.

#### P3-2: No mention of `policy.root_passthrough` in user-facing CLI help
- **What**: `caws scope show README.md` (rejected) advises "Add … or list it explicitly in spec scope.in." The first path requires the user to discover `policy.root_passthrough` exists in `.caws/policy.yaml`. There is no doc pointer.
- **Traceability**: `transcript/p5-first-worktree.md`.
- **Why P3**: minor doc gap. The pointer could be added inline: "or add to `policy.root_passthrough` in .caws/policy.yaml (the project-wide allow-list)."

#### P3-3: `caws init` doesn't tell the user to commit `.caws/` and the new hook files
- **What**: After init, `.caws/` and 5 hook files are untracked. Lifecycle never auto-stages or auto-suggests commit. P8 still shows them untracked.
- **Traceability**: `transcript/p2-first-init.md`, `transcript/p8-cleanup.md`.
- **Why P3**: minor. Adding "Next: commit .caws/ and the new files in .claude/hooks/ to your repo." to the init success block would close the loop.

#### P3-4: `caws worktree create` could mention how to leave a worktree cleanly
- **What**: After `caws worktree create`, no mention of `caws worktree destroy --abandon-unmerged <name>` as the exit path for cancelled work.
- **Traceability**: `transcript/p5-first-worktree.md`.
- **Why P3**: doc gap; affects users who want to bail.

## 10. Non-claims and limits of rehearsal

- **Rehearsal used a clone, not the live working tree.** A live-repo rehearsal would also exercise dirty-working-tree friction (the live full-stack-ds had 30+ untracked generated `.tsx` files and a modified `.claude/settings.json` at the time of this rehearsal). The kit explicitly excluded this; that scenario is not covered here. In particular, the behavior of `caws init --overwrite` against drifted `.claude/settings.json` is untested.

- **Rehearsal target was not strictly CAWS-naive.** The clone already had a committed `.claude/hooks/` directory (commit `27b98ad`). This exercised the `unmanaged_collision` path of `caws init`. A fully naive repo would see a pure-create path; behavior in that case is inferred-from-output, not measured here.

- **The 11.6 rehearsal CLI was global npm `@paths.design/caws-cli@11.1.6` matching the host repo exactly.** The v10.2 rehearsal (see §11) used `@paths.design/caws-cli@10.2.0` — also global npm, but the older published surface. The v10.2 observation is what reveals the published-surface skew finding (P0-0).

- **The two rehearsals shared the same `/tmp/fsds-caws-rehearsal/` workspace.** The 10.2 run wrote a `FINAL-REPORT.md` and per-phase files to `/tmp/fsds-caws-rehearsal/transcript/`. The 11.6 run, started after the 10.2 run, **overwrote those files** in the same path. The 10.2 evidence as it exists today is therefore the recovered HANDOFF in `docs/reports/turn.10.2.json` (the Claude Code turn log) — there is no on-disk per-phase artifact for the 10.2 run. Future rehearsals should use distinct workspace paths per surface (e.g., `/tmp/fsds-caws-rehearsal-v10/` and `/tmp/fsds-caws-rehearsal-v11/`).

- **Rehearsal did not exercise**: contracts, gates, evidence, waivers, multi-spec scenarios, parallel worktrees, takeover flow, abandon-unmerged worktree destroy, registry migration (`migrate-registry`), sparse-checkout repair (`repair-sparse`), tier-1 or tier-2 specs end-to-end, CI integration, hooks actually firing on tool calls (kit §5.5 — would need a session restart), recovery from a failed/conflicted merge, custom commit messages on merge.

- **Rehearsal tested ONE trivial change in P6**: a whitespace + HTML-comment append to `README.md`. Richer changes (code edits, multi-file changes, changes triggering gates) would exercise scope-guard, hook permission flows, lint integration, gate enforcement, and budget checks that this rehearsal does not.

- **Rehearsal was performed by a Claude Code agent, not a human first-contact user.** A human would stop at different points, ask differently-phrased questions, improvise differently. The "would the user abandon here?" judgments in §6 are agent-inferred from the diagnostic clarity and recovery-affordance, not measured against actual human behavior.

- **Some hook activity was observed by absence**: per kit §5.5, hooks installed at P2 require a session restart. The rehearsal session started before P2, so the post-init hooks (notably the new dispatch handlers wired into PreToolUse/PostToolUse) were not exercised against my tool calls. The 16 *pre-existing* (committed) hooks were also not exercised — they're wired into `.claude/settings.json`, but the agent harness loaded that settings file at session start, which was before this rehearsal began, so any post-session-start mutation would not take effect. **None of the CAWS Claude-Code hook enforcement was tested live**; their presence was confirmed structurally only.

- **The `agents` substrate (referenced in kit §5.1) is partly broken**: both `caws status` and `caws agents list` fail on the same `summarizeActiveAgents` undefined-function defect. The substrate's structural presence (`.caws/agents.json` exists; agents-related events would presumably be appended) was observed at file level only.

---

## 11. Appendix — Published-surface skew observation: v10.2 recovered HANDOFF

### 11.1 Evidence quality

- **Source**: `docs/reports/turn.10.2.json` (Claude Code turn log, ~370 KB)
- **Preserved**: agent's final HANDOFF block (`turn_summary` + `timeline[-1].text`), recovered verbatim
- **Missing**: the on-disk `/tmp/fsds-caws-rehearsal/transcript/FINAL-REPORT.md` and per-phase `pN-*.md` files for the 10.2 run were **overwritten** when the 11.6 run started in the same workspace path
- **Constraint**: the appendix below quotes only what the recovered HANDOFF carries. Per-phase details, exact diagnostic text not captured in the HANDOFF, raw command output, and the 10.2 phase-by-phase transcript are **not recoverable** and are NOT invented here. Recommendations in this appendix are scoped to what the recovered HANDOFF demonstrably observed.

The fact that this evidence had to be recovered from a JSON turn log rather than read from the prescribed on-disk artifact is itself a process finding — captured in §10's "shared workspace" note. Future rehearsals across multiple surfaces should use distinct workspace paths.

### 11.2 Recovered HANDOFF (verbatim from `turn.10.2.json`)

> ```
> === REHEARSAL COMPLETE: USER-E2E-SETUP-REHEARSAL-001 ===
>
> Status: COMPLETE (P0–P8 all executed; no HANDOFFs emitted mid-rehearsal)
>
> Transcript:
>   /tmp/fsds-caws-rehearsal/transcript/
>     FINAL-REPORT.md
>     p0-setup.md
>     p1-install-source.md
>     p2-first-init.md
>     p3-doctor-comprehension.md
>     p4-first-spec.md
>     p5-first-worktree.md
>     p6-first-change.md
>     p7-first-merge-close.md
>     p8-cleanup.md
>     raw/ (53 raw command-output files)
>
>   Tarball: /tmp/fsds-caws-rehearsal/transcript.tar.gz (80 KB)
>   Uncompressed: 424 KB
>
> Final report: lifted into the message above (also at
>   /tmp/fsds-caws-rehearsal/transcript/FINAL-REPORT.md). All 10 sections
>   present.
>
> Readiness verdict: NOT-READY
>
>   Reasoning: the publicly-installed @paths.design/caws-cli@10.2.0 is a
>   major version behind the host repo's 11.1.6 and the kit's assumed
>   surface, so a first-contact user following any kit/host-derived doc
>   immediately hits unknown-command/unknown-option errors. Independent of
>   the version skew, `caws init` silently rewrites customized .claude/
>   files (13 hooks + settings.json + .gitignore, +1216/-827 lines), claims
>   git hooks are active when core.hooksPath redirects them elsewhere, and
>   ships a tier-2 default spec with a broken contracts block. `caws status`
>   inside a worktree contradicts `caws scope show` from the same cwd.
>   `caws diagnose` flags a healthy pnpm monorepo as broken and inverts the
>   kit's exit-code semantics. The worktree-merge lifecycle in P7 (bind →
>   edit → merge → auto-close → registry update) is genuinely good — that's
>   the strongest positive finding — but a user cannot reach it cleanly
>   from P1–P6.
>
> Recommended next steps for the CAWS maintainer:
>
>   1. Decide on the v10.x ↔ v11.x story: publish v11.x to npm, or pin the
>      kit (and CLAUDE.md / docs / templates) to v10.2.0 with full command
>      surface translation. Today's published surface is misaligned with
>      everything internal.
>   2. Make `caws init` safe to run twice. Add overwrite detection,
>      `--force` requirement, or `.caws.new/` staging. Stop wiping
>      `.claude/settings.json`'s `env`/`permissions` blocks.
>   3. Fix `caws init`'s claim about git hooks being active when
>      `core.hooksPath` redirects them — either install correctly or warn.
>   4. Fix `caws status`'s heuristic so worktrees with bindings don't
>      report "uninitialized". Consult the registry.
>   5. Make `caws diagnose`'s `Test files` check monorepo-aware. Auto-fix
>      should not create empty `tests/` on healthy monorepos.
>   6. Fix `caws specs show` to show the spec (not a 6-line summary).
>   7. Document or implement worktree sparse-checkout. Currently the kit
>      claims an invariant the binary doesn't enforce.
>   8. Add a one-line node_modules guidance when `caws worktree create`
>      runs in a workspace-style project.
>   9. Lift /tmp/fsds-caws-rehearsal/transcript/FINAL-REPORT.md into
>      <caws-host>/docs/reports/user_e2e_setup_rehearsal_001.md and commit
>      under the spec's scope (per kit §4.4 Option A, this is the
>      maintainer's job).
>
> Target repo cleanup status: residue present.
>
>   Cleanup recipe (run from outside the clone):
>     rm -rf /tmp/fsds-caws-rehearsal
>
>   Live repo at /Users/darianrosebrook/Desktop/Projects/full-stack-ds is
>   untouched throughout this rehearsal. Its HEAD bf73ca46... and its
>   dirty working tree are preserved as they were at rehearsal start.
>
>   The clone at /tmp/fsds-caws-rehearsal/target has 4 commits since the
>   live HEAD (35b3500 + 3b09482 + 12ec3b6 + 6db366b) — all from the
>   rehearsal, all confined to the clone. The maintainer may also keep the
>   clone around for forensic re-runs; if so, retain
>   /tmp/fsds-caws-rehearsal/ in full.
>
> Time spent: ~18 minutes wall clock (P0 start to FINAL-REPORT.md write).
>
> === END ===
> ```

### 11.3 What the v10.2 observation contributes to the readiness verdict

The recovered HANDOFF establishes several first-contact-user-facing properties of the published v10.2 surface that the 11.6 rehearsal could not test:

1. **Major-version skew is real and immediately user-visible.** A first-contact user running `npm install -g @paths.design/caws-cli` today receives a CLI whose command surface differs materially from what the kit and host repo describe. Unknown-command and unknown-option errors are the user's first experience.

2. **`caws init` on v10.2 is destructive against customized `.claude/` content.** The recovered HANDOFF quantifies this as "+1216/-827 lines" across "13 hooks + settings.json + .gitignore." There is no overwrite detection, no `--force` requirement, no staging. For an existing repo with any prior `.claude/` customization, init is a one-way change.

3. **Several v10.2 commands produce internally-contradictory output.** `caws status` (worktree) vs `caws scope show` (same cwd) disagree. `caws diagnose` flags a healthy pnpm monorepo as broken. These are not "different feature set than 11.x" — they are correctness issues in the published surface itself.

4. **The strongest positive finding from v10.2 is identical to v11.6**: the worktree-merge lifecycle (P7) is "genuinely good" in both runs. The cross-surface consistency of the lifecycle's *post-bind* behavior is real evidence; the cross-surface inconsistency of everything *before* bind is the readiness blocker.

The appendix does not extend, infer, or supplement the recovered HANDOFF. Per §11.1, anything not captured above is unrecoverable from the current `turn.10.2.json` and is not invented here. The follow-up `RELEASE-DISTRIBUTION-SURFACE-RECON-01` slice should re-run the v10.2 rehearsal in a distinct workspace path if more granular evidence is needed for the distribution-channel decision.

---

## 12. Bug ledger

A discrete enumeration of every bug the rehearsal agents directly observed, separated from the priority-ordered fix backlog (§9). Each entry names the bug, identifies the surface that exhibited it, cites the evidence, and proposes a disposition. A bug here is a defect — a behavior that is wrong, misleading, or actively harmful — distinct from "doc gap" or "diagnostic clarity" items in §9's P2/P3 tiers. Some bug ledger entries are also represented in §9 (when they rise to P0/P1); the cross-references are noted.

Conventions:

- **Surface**: `v11.6` (primary on-disk evidence) | `v10.2` (recovered HANDOFF — evidence is summary-only, see §11) | `both`.
- **Severity**: `critical` (data loss, security, breaks setup) | `high` (likely user abandonment or active harm) | `medium` (confusing, recoverable) | `low` (cosmetic).
- **Disposition**: `code-fix` | `doc-fix` | `release-process-fix` | `design-decision-needed` | `investigate-further`.

### Bug-001 — `caws status` crashes on `summarizeActiveAgents` undefined function

- **Surface**: v11.6
- **Severity**: critical
- **Symptom**: `(0 , caws_kernel_1.summarizeActiveAgents) is not a function`, exit code 0
- **When triggered**: any `caws status` invocation in v11.6 after `caws init`
- **Evidence**: `transcript/p3-doctor-comprehension.md`; raw output `transcript/raw/p3-status-crash.txt`
- **Disposition**: `code-fix` — kernel export `summarizeActiveAgents` is missing or not transitively re-exported. Either add the missing export or remove the call site.
- **Cross-reference**: §9 P0-1
- **Notes**: the function exists in kernel source (it's referenced in `MULTI-AGENT-ACTIVITY-REGISTRY-001`'s leases substrate). This is a packaging/re-export bug, not a logic bug. The exit-0-on-crash subordinate behavior is also tracked as Bug-008.

### Bug-002 — `caws agents list` crashes on the same `summarizeActiveAgents` undefined function

- **Surface**: v11.6
- **Severity**: critical
- **Symptom**: identical crash to Bug-001
- **When triggered**: any `caws agents list` invocation in v11.6
- **Evidence**: `transcript/p5-first-worktree.md`
- **Disposition**: `code-fix` — same root cause as Bug-001; likely fixed by the same patch
- **Cross-reference**: §9 P0-1

### Bug-003 — Shared stale v11.0.0 / pin-to-10.2.x diagnostic advice in multiple commands

- **Surface**: v11.6
- **Severity**: critical (actively harmful)
- **Symptom**: a stale lifecycle-gap diagnostic referring to "v11.0.0" and recommending `pin to caws-cli@^10.2.x` is emitted by at least two distinct commands in v11.6:
  - `caws claim` (outside any linked worktree): `caws claim: cwd is not inside a CAWS-tracked worktree. v11.0.0 does not ship worktree lifecycle commands; create the worktree externally (git worktree add) and register it via a future caws worktree command (planned for v11.1). To use lifecycle commands today, pin to caws-cli@^10.2.x.`
  - `caws scope show <path>` (canonical cwd, unbound case): the `repair:` line includes `... (v11.0.0 does not ship caws worktree bind; pin to caws-cli@^10.2.x for the convenience command.)`
- **When triggered**: `caws claim` from a canonical checkout; `caws scope show` against a path when cwd is outside any CAWS-tracked worktree binding. Likely additional sites — the bug ledger names only what the rehearsal directly observed.
- **Evidence**: `transcript/p5-first-worktree.md` and raw `transcript/raw/p5-create.txt` for the `claim` site; live `caws scope show docs/reports/user_e2e_setup_rehearsal_001.md` invocation at amendment time for the `scope` site (the maintainer was scope-checking the report itself before commit and observed the stale string in the `repair:` field).
- **Disposition**: `code-fix` — the diagnostic is stale text from a pre-v11.1 release. The fact that it appears in at least two distinct commands indicates a shared diagnostic template (or shared copy-pasted text), not a single localized bug. The fix must search the codebase for ALL diagnostics referencing `v11.0.0`, `pin to caws-cli@^10.2.x`, and related lifecycle-gap remnants — not just patch the one observed in `claim`. A diligent user following the advice would `npm install -g @paths.design/caws-cli@^10.2.x` and break their working v11 setup, AND lose access to the very lifecycle commands they're trying to use (which v11.1 does ship).
- **Cross-reference**: §9 P0-2
- **Notes**: the v10.2 recovered HANDOFF independently observed surface-skew confusion (P0-0); Bug-003 is the *opposite* failure: a v11 binary advising a v10 downgrade. The two failure modes compound the distribution-channel confusion. The candidate follow-up slice is `CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01` (broadly scoped — every diagnostic in the codebase containing those stale phrases — not just `caws claim`).

### Bug-004 — published `@paths.design/caws-cli` resolves to v10.2.0 while host/kit/docs assume v11.x

- **Surface**: distribution channel
- **Severity**: critical
- **Symptom**: `npm install -g @paths.design/caws-cli` yields v10.2.0; kit, CLAUDE.md, docs/architecture/*, and the rehearsal kit all describe v11.x commands (worktree, agents, repair-sparse, etc.) that do not exist in v10.2.0
- **When triggered**: any first-contact user follows the natural install path
- **Evidence**: §11 (recovered HANDOFF from `turn.10.2.json`); §0 evidence model
- **Disposition**: `release-process-fix` + `design-decision-needed`. Three viable resolutions: (a) publish v11.x as `latest` on npm; (b) pin all kit/docs/templates to v10.2.0 with command-surface translation; (c) introduce a `next` dist-tag and explicitly document which channel each doc describes. This is the headline P0-0 finding.
- **Cross-reference**: §9 P0-0
- **Notes**: the candidate slice is `RELEASE-DISTRIBUTION-SURFACE-RECON-01`. Until resolved, every other finding in this ledger has reduced impact because the published-surface user encounters Bug-004 first.

### Bug-005 — `caws init` (v10.2) destructively overwrites customized `.claude/` content with no warning, no `--force` requirement, no staging

- **Surface**: v10.2 (recovered HANDOFF)
- **Severity**: critical
- **Symptom**: running `caws init` rewrites 13 hooks + settings.json + .gitignore for a net `+1216/-827 lines` change against a target with prior `.claude/` customization. No prompt, no diff preview, no overwrite gate.
- **When triggered**: any `caws init` on a project that already has `.claude/hooks/` or a customized `.claude/settings.json`
- **Evidence**: §11.2 recovered HANDOFF
- **Disposition**: `code-fix` (in v10.2 if that line is supported) OR `release-process-fix` (if v10.2 is being retired). Decision is downstream of Bug-004. If v10.2 stays as the published surface, init needs overwrite detection at minimum.
- **Cross-reference**: §11.3 item 2
- **Notes**: v11.x's `caws init` (per Bug-006 evidence) refuses unmanaged collisions instead of silently overwriting — so this defect is specifically a v10.2 behavior that v11 already fixed. This is direct evidence for resolution path (a) of Bug-004 (publish v11 to npm).

### Bug-006 — `caws init` claims git hooks are active when `core.hooksPath` redirects them elsewhere

- **Surface**: v10.2 (recovered HANDOFF)
- **Severity**: high
- **Symptom**: init reports git hooks as installed/active, but `git config core.hooksPath` may redirect hook resolution elsewhere (e.g., a project using Husky or a custom hooks dir). The reported install state is false.
- **When triggered**: `caws init` on a project with a non-default `core.hooksPath`
- **Evidence**: §11.2 recovered HANDOFF (recommendation #3)
- **Disposition**: `code-fix` — either install correctly via `core.hooksPath` resolution or print a warning that hooks are not actually wired
- **Cross-reference**: §11.3 (implicit)

### Bug-007 — `caws status` inside a worktree contradicts `caws scope show` from the same cwd (v10.2)

- **Surface**: v10.2 (recovered HANDOFF)
- **Severity**: high
- **Symptom**: from the same cwd inside a linked worktree, `caws status` reports "uninitialized" while `caws scope show` correctly resolves the bound spec and admits/rejects paths. Two authority-bearing commands disagree about the same state.
- **When triggered**: any worktree where binding state is correctly recorded in `.caws/worktrees.json`
- **Evidence**: §11.2 recovered HANDOFF
- **Disposition**: `code-fix` — `caws status` heuristic should consult the worktrees registry. Note: in v11.6, `caws status` doesn't even reach this code path because it crashes (Bug-001); the v10.2 evidence here is what `status` *does* when it runs.
- **Cross-reference**: §11.3 item 4
- **Notes**: Bug-001 (v11.6 status crash) and Bug-007 (v10.2 status wrong-answer) are both `status` defects but with different mechanisms. Fixing Bug-001 in v11.6 should include a regression test that exercises the worktree-bound `status` path so v11.6 does not re-introduce Bug-007.

### Bug-008 — Exit code is 0 on user-facing failures across multiple v11.6 commands

- **Surface**: v11.6
- **Severity**: high
- **Symptom**: `caws status` (crash), `caws agents list` (crash), `caws specs create` (bare invocation missing required flags), `caws specs create` (tier 2 contract-required rejection), `caws worktree merge --dry-run` (whether ready or not) all exit 0 despite emitting error text
- **When triggered**: any of the above invocations on v11.6
- **Evidence**: `transcript/p3-doctor-comprehension.md` (status), `transcript/p4-first-spec.md` (specs create paths), `transcript/p5-first-worktree.md` (agents), `transcript/p7-first-merge-close.md` (dry-run)
- **Disposition**: `code-fix` — commander.js default behavior on uncaught throws is exit 0; add explicit `process.exit(1)` on error paths. Likely a single shared error-handler change at the shell-layer entry point.
- **Cross-reference**: §9 P1-1
- **Notes**: this defect prevents CAWS from being scripted in CI or pre-commit hooks reliably. A test of the form "every documented error path produces a non-zero exit" would prevent regression.

### Bug-009 — `caws diagnose` flags a healthy pnpm monorepo as broken; inverts exit-code semantics; auto-fix creates spurious `tests/` directories (v10.2)

- **Surface**: v10.2 (recovered HANDOFF)
- **Severity**: high
- **Symptom**: against a project with a working test setup distributed across `packages/*/tests/`, the `Test files` check reports broken state. The recovered HANDOFF notes auto-fix would create empty `tests/` at the repo root on a healthy monorepo.
- **When triggered**: `caws diagnose` on any pnpm/yarn/npm workspaces project where tests live under `packages/*` rather than a root-level `tests/`
- **Evidence**: §11.2 recovered HANDOFF (recommendation #5)
- **Disposition**: `code-fix` — make the `Test files` check workspace-aware. Treat `packages/*/tests/` and `packages/*/src/**/*.test.{ts,js}` as legitimate test locations.
- **Cross-reference**: §11.3 (implicit)
- **Notes**: `diagnose` does not appear in v11.x's eleven command groups (per the rehearsal kit §5.1), so this is a v10.2-only defect. If v10.2 is retired (per Bug-004 resolution), this bug retires with it; if v10.2 is the maintained line, this needs a fix.

### Bug-010 — `caws specs show` (v10.2) returns a 6-line summary instead of the spec body

- **Surface**: v10.2 (recovered HANDOFF)
- **Severity**: medium
- **Symptom**: a user asking to see a spec gets a brief summary rather than the YAML body
- **When triggered**: any `caws specs show <id>` in v10.2
- **Evidence**: §11.2 recovered HANDOFF (recommendation #6)
- **Disposition**: `code-fix` (v10.2). In v11.6, this defect does NOT reproduce — the rehearsal explicitly observed `caws specs show <id>` returning the full YAML.
- **Cross-reference**: §11.3 item 6
- **Notes**: another v10.2-line-only defect that v11 has already fixed. Direct evidence for Bug-004 resolution path (a).

### Bug-011 — v10.2 worktree-sparse doctrine is documented but not enforced by the binary

- **Surface**: v10.2 (recovered HANDOFF)
- **Severity**: medium
- **Symptom**: the rehearsal kit and v11 doctrine both assert the sparse-checkout invariant (`/* + !/.caws/specs/`). v10.2 either does not configure sparse-checkout on worktree create, or does not configure it as the kit describes.
- **When triggered**: `caws worktree create` on v10.2 (if v10.2 has a `worktree` command at all; the recovered HANDOFF indicates the worktree command surface is partial in v10.2)
- **Evidence**: §11.2 recovered HANDOFF (recommendation #7)
- **Disposition**: `code-fix` (v10.2) OR `doc-fix` (the kit, if v10.2 is the maintained line and the doctrine is a v11-only invariant). Decision is downstream of Bug-004.
- **Cross-reference**: §11.3 item 7

### Bug-012 — `caws worktree merge --dry-run` produces no actionable output beyond a one-line ready/not-ready

- **Surface**: v11.6
- **Severity**: medium
- **Symptom**: `caws worktree merge <name> --dry-run` and `caws worktree merge <name> --dry-run --data` both output a single line (`ready to merge.` or the failure equivalent). The user cannot inspect what *will* be merged, what events *will* be appended, or whether the spec auto-close will succeed.
- **When triggered**: every `caws worktree merge --dry-run` invocation
- **Evidence**: `transcript/p7-first-merge-close.md`
- **Disposition**: `code-fix` — extend `--dry-run` output to enumerate: source branch, target branch, merge commit message that *would* be used, spec id that *will* be auto-closed, list of events that *will* be appended.
- **Cross-reference**: §9 P1-3
- **Notes**: this is a defect because dry-run is meaningless as currently shipped. A user cannot use it to build confidence before a real merge, defeating the purpose.

### Bug-013 — `caws worktree create` success message is one line and gives the user no guidance for the next four likely friction points

- **Surface**: v11.6
- **Severity**: medium
- **Symptom**: after a successful `caws worktree create <name> --spec <id>`, the only output is `created <name> at .caws/worktrees/<name> (spec: <id>)`. The user is not told to `cd` into the worktree, that `node_modules/` is absent in workspace-style projects, that `.caws/specs/` is sparse-excluded, or that the spec's `scope.in` may still be a TODO placeholder that will block their first edit.
- **When triggered**: every successful `caws worktree create`
- **Evidence**: `transcript/p5-first-worktree.md`
- **Disposition**: `doc-fix` (output text only — no logic change required). Add a 3–5 line guidance block to the success path.
- **Cross-reference**: §9 P1-2
- **Notes**: classified as a bug rather than a doc gap because the missing guidance leads to three immediate friction points in the next steps of the lifecycle. It is closer to "incomplete success message" than to "missing tutorial."

### Bug-014 — Tier-2 spec creation diagnostic does not mention the bootstrap workaround

- **Surface**: v11.6
- **Severity**: medium
- **Symptom**: `caws specs create <id> --title "..." --mode feature --risk-tier 2` produces `[ERROR] store.lifecycle.plan_rejected: Tier 2 specs require at least one contract.` The error is technically correct (the spec schema requires a contracts entry at tier 2) but does not tell the user how to provide a contract, that the create command lacks a `--contract` flag, or that the documented workaround is "create at tier 3 then amend the YAML to tier 2 + add a contract."
- **When triggered**: any `caws specs create --risk-tier 2` (and probably tier 1)
- **Evidence**: `transcript/p4-first-spec.md`
- **Disposition**: `doc-fix` (diagnostic text extension) — append `Hint: contracts are not accepted at create-time. Either create at risk-tier 3 and amend the YAML to add a contracts: entry, or use caws specs update <id> --add-contract <spec>.`
- **Cross-reference**: §9 P2-1
- **Notes**: this was bug-for-bug reproduced by the CAWS maintainer during the host repo's own slice authoring (CLAUDE.md trap #3 is the same workaround). The diagnostic should surface the known workaround.

### Bug-015 — `error: error:` double prefix on commander.js validation errors

- **Surface**: v11.6
- **Severity**: low
- **Symptom**: `caws specs create` (with required flags omitted) outputs `error: required option '--title' not specified` followed by `Error: error: required option '--title' not specified.` — two layers wrapping each other.
- **When triggered**: any commander.js validation failure
- **Evidence**: `transcript/p4-first-spec.md`
- **Disposition**: `code-fix` (cosmetic) — adjust the shell-layer error formatter to not re-prefix commander.js errors.
- **Cross-reference**: §9 P3-1

### Bug-016 — `caws init` does not tell the user to commit `.caws/` and the new hook files it created

- **Surface**: v11.6
- **Severity**: low
- **Symptom**: after init, `.caws/` and 5 new `.claude/hooks/*` files are untracked. The init output does not mention staging or committing them. By P8 (cleanup verification) they were still untracked.
- **When triggered**: every fresh `caws init`
- **Evidence**: `transcript/p2-first-init.md`, `transcript/p8-cleanup.md`
- **Disposition**: `doc-fix` (success-message extension) — append `Next: review and commit .caws/ and the new files in .claude/hooks/ to your repository.`
- **Cross-reference**: §9 P3-3

### Bug-017 — Manual YAML edits to `scope.in` are not audited; `caws specs update` is not present in v11.6

- **Surface**: v11.6
- **Severity**: medium
- **Symptom**: amending a spec's `scope.in` requires editing the YAML directly. No `spec_amended` event is appended to `.caws/events.jsonl`. The kit references `caws specs update` as the documented amendment path, but the rehearsal could not locate that command in v11.6's surface.
- **When triggered**: any in-flight scope amendment during normal slice work
- **Evidence**: `transcript/p6-first-change.md`
- **Disposition**: `investigate-further` + `code-fix`. First confirm whether `caws specs update` exists in v11.6 (rehearsal did not exhaustively probe). If absent, add it (and emit an event). If present, document it more prominently.
- **Cross-reference**: §9 P2-4
- **Notes**: the audit gap is mild because git records edits to the YAML, but losing the events.jsonl audit trail for scope amendments breaks the "events.jsonl is the canonical audit surface" invariant.

### Bug-018 — Cross-shell foreign-owner block fires repeatedly without obvious recovery guidance

- **Surface**: v11.6
- **Severity**: medium
- **Symptom**: each new shell session mints a fresh `caws-<id>` session identity. A user moving between iTerm tabs / tmux panes / Cursor / VS Code terminal sees `worktree.ownership.foreign_owner_blocked` on every cross-session command. The recovery (`--takeover`) is correct and produces a durable `prior_owners` audit, but the diagnostic does not emphasize that takeover is the normal path for cross-shell work.
- **When triggered**: any worktree-mutating command from a session different from the original creator
- **Evidence**: `transcript/p5-first-worktree.md`
- **Disposition**: `doc-fix` (diagnostic clarification) — soften the warning's tone for the common single-user multi-shell case, while keeping the foreign-claim language for genuine multi-user scenarios.
- **Cross-reference**: §6 item 6

### Bug-019 — Doctor output is empty before AND after a complete lifecycle run; no signal that anything happened

- **Surface**: v11.6
- **Severity**: low
- **Symptom**: `caws doctor` at P3 (immediately post-init) and at P8 (post-lifecycle, after a complete spec create + worktree + edit + merge + close + destroy) both report `findings 0E/0W/0I`. A user has no way to tell from doctor that any work occurred.
- **When triggered**: doctor after any successful lifecycle that didn't introduce drift
- **Evidence**: `transcript/p3-doctor-comprehension.md`, `transcript/p8-cleanup.md`
- **Disposition**: `code-fix` (doctor enhancement) — add an INFO-level summary line: last spec closed, last worktree merged, current active spec/worktree counts, last `events.jsonl` sequence. Or, less invasively, have `caws worktree merge` print a 1-line audit pointer ("see `.caws/events.jsonl` seq N–M for the merge audit").
- **Cross-reference**: §9 P2-3

### Bug-020 — Two rehearsals sharing one workspace path silently overwrote 10.2 evidence

- **Surface**: process / rehearsal infrastructure
- **Severity**: medium (process bug, not CAWS code)
- **Symptom**: the 10.2 rehearsal wrote to `/tmp/fsds-caws-rehearsal/transcript/`. The 11.6 rehearsal started in the same workspace path and overwrote every file. The 10.2 evidence had to be recovered from the Claude Code turn log (`docs/reports/turn.10.2.json`); per-phase detail is unrecoverable.
- **When triggered**: any multi-surface rehearsal sharing a workspace
- **Evidence**: §0 evidence model, §10 non-claims, §11.1 evidence quality
- **Disposition**: `doc-fix` to the rehearsal kit — update §2.1 to prescribe surface-specific workspace paths (e.g., `/tmp/fsds-caws-rehearsal-v10/` and `/tmp/fsds-caws-rehearsal-v11/`) and add a refusal-to-overwrite guard ("if `<workspace>/transcript/FINAL-REPORT.md` exists, refuse and prompt for a fresh path").
- **Cross-reference**: §10 (last bullet); §11.1
- **Notes**: this is a kit defect surfaced by running the rehearsal, not a CAWS-binary defect. Its inclusion here is so the next slice that updates the kit (or runs another multi-surface rehearsal) closes the gap.

### Summary table

| Bug | Surface | Severity | Disposition | §9 ref |
|---|---|---|---|---|
| Bug-001 | v11.6 | critical | code-fix | P0-1 |
| Bug-002 | v11.6 | critical | code-fix | P0-1 |
| Bug-003 | v11.6 | critical | code-fix | P0-2 |
| Bug-004 | distribution | critical | release-process-fix + design-decision-needed | P0-0 |
| Bug-005 | v10.2 | critical | code-fix or release-process-fix | (downstream of P0-0) |
| Bug-006 | v10.2 | high | code-fix | (downstream of P0-0) |
| Bug-007 | v10.2 | high | code-fix | (downstream of P0-0) |
| Bug-008 | v11.6 | high | code-fix | P1-1 |
| Bug-009 | v10.2 | high | code-fix | (downstream of P0-0) |
| Bug-010 | v10.2 | medium | code-fix | (downstream of P0-0) |
| Bug-011 | v10.2 | medium | code-fix or doc-fix | (downstream of P0-0) |
| Bug-012 | v11.6 | medium | code-fix | P1-3 |
| Bug-013 | v11.6 | medium | doc-fix | P1-2 |
| Bug-014 | v11.6 | medium | doc-fix | P2-1 |
| Bug-015 | v11.6 | low | code-fix | P3-1 |
| Bug-016 | v11.6 | low | doc-fix | P3-3 |
| Bug-017 | v11.6 | medium | investigate-further + code-fix | P2-4 |
| Bug-018 | v11.6 | medium | doc-fix | §6.6 |
| Bug-019 | v11.6 | low | code-fix | P2-3 |
| Bug-020 | process | medium | doc-fix (rehearsal kit) | §10, §11.1 |

**Totals**: 20 bugs observed. 4 critical (Bug-001, Bug-002, Bug-003, Bug-004, Bug-005 — Bug-005 is critical but on a surface gated by Bug-004's release decision). 5 high. 8 medium. 3 low. 1 process bug.

**Counts by surface**: 11 are v11.6 bugs (the surface under development). 7 are v10.2 bugs whose disposition is downstream of the Bug-004 release decision. 1 is a distribution-channel bug (Bug-004). 1 is a rehearsal-process bug (Bug-020).

**Counts by disposition**: 12 `code-fix`, 5 `doc-fix`, 1 `release-process-fix` + `design-decision-needed`, 1 `investigate-further + code-fix`, 1 `code-fix or doc-fix` (downstream of Bug-004 decision).
