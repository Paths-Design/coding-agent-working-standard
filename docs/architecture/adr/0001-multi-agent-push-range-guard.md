# ADR 0001 — Multi-Agent Push-Range Guard

- **Status:** Proposed (activation gate for `MULTI-AGENT-PUSH-RANGE-GUARD-001`)
- **Date:** 2026-05-28
- **Spec:** `MULTI-AGENT-PUSH-RANGE-GUARD-001`
- **Decision class:** Authority Decision Record (ADR). Satisfies the spec's `A0` activation prerequisite: the spec is REJECTED for activation until this ADR exists and answers Q1–Q6.

This is the first ADR in the repository; it establishes the `docs/architecture/adr/NNNN-slug.md` convention. ADRs record load-bearing design decisions whose answers must be settled *before* implementation so the work cannot silently bake in a wrong choice. An ADR is doctrine: later slices cite it, and a change to an answer is itself an ADR amendment, not a quiet code edit.

---

## Context

CAWS is multi-agent: several Claude Code sessions operate on one repository, each in its own git worktree, all sharing a single local `main`. Local `main` is therefore a **shared staging surface** — commits from different sessions land on it before any push.

In session 13 (the motivating incident), an operator pushing two authority commits (`96db0d1`, `23eaed7`) **silently carried a third commit, `dd8841a`** — a parallel session's `CAWS-MIGRATE-V10-EVENTS-001` draft that had landed on local `main` from a foreign worktree. The push succeeded with no signal that an unrelated session's work had been published. The only "guard" was documentation ("agents should inspect `git log origin/main..HEAD`"), and documentation-only safety has repeatedly failed under concurrency.

The summary `git rev-list --count origin/main..HEAD` ("2 commits ahead") is precisely the failure mode: it counts but does not enumerate, so the foreign commit is invisible.

The guard converts this coordination failure into a mechanical gate: enumerate the outgoing commit range, classify each commit's spec provenance, escalate foreign-worktree presence during active slices, and refuse (or require per-SHA acknowledgement) before a push that carries commits outside the current slice.

### Non-negotiable framing (from the spec's locked invariants)

- **Diagnose/decide, not repair.** The guard reports and refuses; it never rewrites, drops, reorders, or amends commits. Repair is the operator's job with normal git tools.
- **Opt-in command at v1.** The operator invokes `caws push` / `caws prepush` explicitly. No `git pre-push` hook interception in v1 (named as a stronger follow-up).
- **Repo-local CLI only.** Classification runs via the repo-local v11 CLI, never whichever global `caws` is on `$PATH`.
- **No event schema change in v1.** No `push_guard_evaluated` event yet (follow-up if audit value surfaces).
- **Enumerate, never summarize.** The report lists each commit with SHA, subject, touched files, inferred spec ids, and an explicit `current-slice-match` boolean.

---

## Decisions (Q1–Q6)

### Q1 — Provenance inference algorithm

**Decision.** A commit is attributed to **every** active or recently-closed spec whose `scope.in` prefix-matches any file the commit touches — multi-match is allowed and reported, never collapsed to a single "winner." Commit-subject `SPEC-ID` pattern matching is a **secondary, additive** signal: it can add an inferred spec to a commit's match set, but it can never remove a file-touch match (prose is not trusted to override mechanical evidence). `current-slice-match` is `true` for a commit iff the **current session's active spec** is in that commit's match set. A commit that touches files in no active/recently-closed spec's `scope.in` **and** whose subject names no known spec is classified `current-slice-match: false` and flagged `provenance: ambiguous` for operator review.

**Rationale.** Matches the invariant "spec provenance is mechanically derivable, not prose-trusted." "Closest-active-spec match" or "first-match-wins" tie-breaking manufactures false confidence by hiding the multi-match reality; reporting all matches lets the operator see exactly why a commit is or isn't theirs.

**Alternatives considered.** (a) *Closest-match wins* — rejected: invents a ranking the data doesn't support. (b) *Subject-line authoritative* — rejected: prose lies; `chore(caws): activate FOO` can touch files outside FOO's scope. (c) *Session ledger (commit→spec at commit time)* — stronger and named as a forward-looking option, but deferred (not a v1 deliverable per the spec).

### Q2 — Slice-base SHA storage shape

**Decision.** Store `slice_base_sha` (and the spec id it pertains to) in the **existing per-session capsule, `.caws/sessions/<id>.json`**, stamped at slice activation OR commit 1 of an implementation pass. The push guard reads it to compute and report `<slice_base>..HEAD`.

**Rationale.** The session capsule already exists as the per-session record; extending it avoids inventing another shared-mutable file. A new top-level `.caws/slice-base.json` would be exactly the shared-mutable-state hazard class this project keeps hitting (cf. the `worktrees.json` churn that drove its untracking). Attaching slice-base to the spec YAML couples **ephemeral session state to durable cross-machine spec authority** — the wrong tier, the same lesson as the `worktrees.json` untrack: ephemeral, machine-local runtime state does not belong in tracked authority files.

**Migration/audit note.** `.caws/sessions/` is machine-local runtime state (gitignored, like `agents.json`); the slice-base is therefore not pushed and not cross-machine — which is correct, because the outgoing-range computation is inherently local to the pushing machine.

**Alternatives considered.** (a) *`.caws/slice-base.json`* — rejected: new shared-mutable file. (b) *Spec YAML field* — rejected: tier mismatch (durable authority vs ephemeral session state).

### Q3 — Acknowledgement mechanism for unexpected commits

**Decision.** **Repeatable `--ack <sha>` flag, per-SHA, non-persistent in v1.** Each unexpected commit must be acknowledged by its specific SHA; there is no blanket "yes, proceed." Acks do **not** persist across invocations in v1 — the operator re-acks on each run. The refuse path exits non-zero; a fully-acked push proceeds and exits 0.

**Rationale.** `A4` mandates "a record of WHICH commits were acknowledged, not a blanket yes." A flag (vs interactive prompt) keeps the guard usable in CI and non-TTY contexts. Non-persistence avoids a stale-ack hazard (an ack recorded once silently re-authorizing a later, different push) and avoids adding another piece of session state to manage; ack persistence is named as a follow-up if the re-ack friction proves real.

**Alternatives considered.** (a) *Interactive prompt only* — rejected: breaks automation/CI. (b) *Persistent acks* — deferred: stale-ack risk outweighs the convenience at v1. (c) *Blanket `--force`* — rejected outright: it is the exact failure mode (silent inclusion) the guard exists to prevent.

### Q4 — Foreign-worktree escalation thresholds (OR vs AND)

**Decision.** **OR.** A foreign worktree escalates to **ERROR** if **any one** of: (a) it has an unmerged branch, (b) its branch is absent from `.caws/worktrees.json`, or (c) one or more commits in `origin/main..HEAD` originate from it. Absent all three but present during an active slice → **WARN** (escalated from doctor's idle-state INFO). The "operator is legitimately working on another spec too" sub-case is **not** handled by weakening the threshold — it is handled by Q3's per-SHA `--ack`, which lets the operator explicitly authorize the specific foreign commits.

**Rationale.** The session-13 incident was condition (c) **alone** — a foreign worktree's commit reachable from local `main`. AND-ing the conditions would have required (a)+(b)+(c) together and let session 13 through. Each condition independently indicates a coordination boundary the operator should consciously cross. Keeping the "legitimate other spec" escape in the ack mechanism (not the threshold) preserves "any one is enough to stop and look."

**Alternatives considered.** (a) *AND* — rejected: would not have caught the motivating incident. (b) *Threshold sub-case for prose-named other-spec commits* — rejected: re-introduces prose-trust (Q1) and weakens the gate; the ack path is the right operator-judgment surface.

### Q5 — Push-target naming

**Decision.** v1 command shape: `caws push [<remote> <branch>]`, defaulting to `origin main`. The guard computes the outgoing range against the **operator-named upstream** (resolving the tracking ref for the named target). Pushes to a **non-main branch or non-origin remote are NOT refused** — they are reported with a **weakened posture**: the full enumerated range + provenance classification still apply, but the foreign-worktree **ERROR escalation (Q4) fires only for `origin main`**. Feature-branch pushes get WARN-level foreign-worktree reporting, not ERROR.

**Rationale.** Refusing non-main pushes entirely would block legitimate feature-branch workflows the guard has no reason to prohibit; the guard's core value (the enumerated range report) is target-agnostic and should always run. `main` is the shared staging surface where silent-inclusion is most dangerous, so the hard ERROR escalation is reserved for it. Required test coverage (per the spec): `push origin main` (full posture) and `push origin <feature-branch>` (weakened: reported, ERROR escalation suppressed).

**Alternatives considered.** (a) *Refuse all non-main* — rejected: over-broad, blocks normal work. (b) *Identical posture for all targets* — rejected: feature branches are inherently divergent; ERROR there would be noise.

### Q6 — Doctor integration vs separate command

**Decision.** The **push guard layers escalation on top of doctor's INFO output; `caws doctor` itself stays INFO** regardless of active-slice state. The push guard reads slice-base/active-spec state and re-classifies `doctor.worktree.foreign_physical` to WARN/ERROR **within its own report only**. `caws doctor` continues to emit INFO for foreign-physical worktrees in all states, remaining a stable, side-effect-free, session-state-independent dashboard.

**Rationale.** The locked invariant says the doctor rule "remains a separate diagnostic surface." Making `caws doctor` consult slice-base/session state would couple a read-only dashboard to ephemeral session state and introduce active-slice-dependent exit-code churn (doctor exit codes are consumed by CI and other tooling that must not flap based on which session is active). Keeping doctor stable and letting the push guard own escalation respects the v11 separation (doctor = drift dashboard; the push guard = a decision surface).

**Alternatives considered.** (a) *Doctor escalates directly* — rejected: couples the dashboard to session state, risks exit-code flapping. (b) *Duplicate the foreign-physical detection logic in the guard* — partially: the guard reuses doctor's detection output and only re-classifies severity, rather than re-implementing detection, to keep a single detection source.

---

## Consequences

- **Enables activation** of `MULTI-AGENT-PUSH-RANGE-GUARD-001` (clears `A0`). Activation still requires maintainer authorization and a separate decision on `risk_tier`/`contracts` at activation time (per the spec's activation gate and the commit-1-vs-commit-2 pattern from `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001`).
- **Storage choice (Q2)** ties the guard to the session-capsule shape; if that shape changes, the slice-base field travels with it.
- **OR escalation (Q4)** is deliberately conservative — it will WARN/ERROR on foreign worktrees that are in fact benign. The per-SHA ack (Q3) is the pressure-release valve; if WARN noise proves excessive in practice, that is a tuning follow-up, not a reason to switch to AND.
- **Opt-in (v1)** means an operator who never runs `caws push` is unprotected. Closing that gap (a `git pre-push` hook) is the named follow-up and the path to non-opt-in coverage.

## Follow-ups (explicitly out of v1 scope)

- `git pre-push` hook integration (non-opt-in posture).
- Session ledger recording commit→spec at commit time (stronger Q1 provenance).
- Persistent acknowledgements (stronger Q3).
- `push_guard_evaluated` typed event (audit surface).
- `CLI-LOCAL-VERSION-PREFLIGHT-001` as an eventual consumer of the structured report.
