## Plan: Fix the three open CAWS CLI defects (N5 → N3 → N4)

Three independent specs, each in its own worktree, landed in that order (cheapest/cleanest first; N4 last because it touches an authority boundary). All work follows the AGENTS.md contract: author spec → `caws scope check` → implement → `npm run build` → jest → `caws doctor` → `caws gates run --spec <id>` → `caws worktree merge`.

Repo state: `caws-cli@11.8.0`, branch `main`, HEAD `01ab1a96`. Build = `node scripts/build-cli.js` (run via `npm run build` in `packages/caws-cli`); tests are **compiled-surface jest** (`.test.js` under `tests/`, import from `../../dist/...`), so build before every test run. typecheck = `npm run typecheck`.

---

### Fix 1 — N5: `worktree merge` false `partial_failure` on a pre-closed spec

**Spec:** `CAWS-FIX-N5-MERGE-IDEMPOTENT-CLOSE-001` (mode: fix, risk-tier 2)

**Root cause:** `mergeWorktree` (`packages/caws-cli/src/store/worktrees-writer.ts`) calls `closeSpec` unconditionally at ~line 1733. When the bound spec is already `lifecycle_state: closed`, `closeSpec` returns `nonActiveCloseSpecError` → `LIFECYCLE_PLAN_REJECTED` (`specs-writer.ts:1171`, no write occurs — guard is before any mutation). `mergeWorktree`'s `!isOk(closeResult)` guard (~line 1747) turns that into `LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED` with the false message "the bound spec remains active."

**Fix (idempotent close step):**
1. In `mergeWorktree`, just before the `closeSpec` call (~line 1733), call the existing **private** `loadSpecOrError` (same file, lines 421–462) which already returns `lifecycleState`.
2. If `lifecycleState === 'closed'`: skip `closeSpec` entirely; set a local `specWasAlreadyClosed = true`; fall through to the existing `worktree_merged` append + `destroyWorktree` + branch-delete. Do **not** append a second `spec_closed` (the pre-close already appended one).
3. Reflect reality in the event + outcome: add a `spec_already_closed` boolean to the `worktree_merged` event `data` (lines 1792–1803) and to the success `outcome.data` (lines 1886–1903), keeping `auto_closed_spec: true` semantics = "spec is closed as of this merge." (No schema change — `auto_closed_spec` is an optional boolean per `worktree_merged.v1.json`.)
4. Leave both error branches (1747, 1771) intact for genuine close failures.

**Test:** new `packages/caws-cli/tests/store/worktree-merge-already-closed-spec.test.js`. Reuse the `worktree-merge-branch-delete.test.js` harness (`mkRepo`/`setupCaws`/`commitCaws`/`seedBoundableSpec` + `createAndMerge`). Seed a bound spec, pre-close it via `closeSpec` directly, then call `mergeWorktree` and assert `result.ok === true`, `result.value.kind === 'success'`, `data.spec_already_closed === true`, and that the worktree is destroyed + branch deleted. Mirror the `writeSpec` helper from `specs-close-handoff.test.js:21-49` if seeding inline.

**scope.in:** `packages/caws-cli/src/store/worktrees-writer.ts`, `packages/caws-cli/tests/store/worktree-merge-already-closed-spec.test.js`, `.caws/specs/CAWS-FIX-N5-MERGE-IDEMPOTENT-CLOSE-001.yaml`

---

### Fix 2 — N3: `worktree create` strands the bind commit on a concurrent `index.lock`

**Spec:** `CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001` (mode: fix, risk-tier 2)

**Root cause:** `autoCommit` (`packages/caws-cli/src/store/git-autocommit.ts`) runs `git add` (line ~156) then `git commit` (line ~191) as two single-shot `runGit` calls with no retry. An `index.lock` held by a concurrent git process fails the commit and strands the staged spec change. Both `add` and `commit` emit the same stderr under a held lock.

**Fix (bounded retry around add→diff→commit):**
1. Add module-private constants `INDEX_LOCK_MAX_ATTEMPTS = 5` (matches `MERGE_CAS_MAX_ATTEMPTS`) and `INDEX_LOCK_RETRY_DELAY_MS = 50` (matches `LOCK_RETRY_DELAY_MS`), and a private `sleepSyncMs` busy-wait copied verbatim from `lifecycle-lock.ts:54-60` (the established idiom — there is no shared sleep util; three other files each keep their own copy).
2. Wrap the add→`diff --cached`→commit sequence (lines ~156–203) in a `for (attempt = 1; attempt <= max; attempt++)` loop. On failure, test `reason` against `/index\.lock'?: File exists|Another git process seems to be running/` (verified against git 2.50.1 stderr). If it matches → `sleepSyncMs` + retry. If not (e.g. pre-commit-hook refusal) → break immediately and return the existing `refused_dirty` outcome, preserving the "never `--no-verify`" contract at lines 196–198.
3. Re-run `git add` on each attempt — safe because the commit is path-scoped (`CAWS-AUTOCOMMIT-INTEGRITY-001`, lines 183–190), so re-staging can't sweep foreign staged files into the audit commit.
4. Make the budget overridable via optional `AutoCommitInput` fields (`indexLockMaxAttempts?`, `indexLockRetryDelayMs?`) — mirrors `AcquireLifecycleLockOptions`, lets tests exercise exhaustion deterministically without real timing.

**Test:** new `packages/caws-cli/tests/store/git-autocommit-index-lock.test.js`. Real tmp repo via `tests/helpers/git-repo-factory.js`. Plant `.git/index.lock` via `fs.writeFileSync`, drive a bind-audit commit (e.g. `createWorktree` with `--spec`, like `worktree-draft-bind-handoff.test.js`), and assert: (a) with the lock held and a tiny override budget → `refused_dirty` outcome, spec change not committed; (b) recovery path — lock removed before budget exhaustion → `committed`. No `runGit` mocking (matches the concurrency-test convention).

**scope.in:** `packages/caws-cli/src/store/git-autocommit.ts`, `packages/caws-cli/tests/store/git-autocommit-index-lock.test.js`, `.caws/specs/CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001.yaml`

---

### Fix 3 — N4: `claim --takeover` silently no-ops on a foreign fresh-but-dead envelope

**Spec:** `CAWS-FIX-N4-CLAIM-TAKEOVER-AUTHORITY-001` (mode: fix, risk-tier 1 — crosses an authority boundary)

**Root cause:** `caws claim` calls both `resolveSession()` (single pick, env-first, same as `caws status`) and `resolveSessionCandidates()` (admits ALL fresh durable envelopes, ≤24h `last_seen_at`, no liveness check). It passes the candidate set to `assertOwnership`, whose candidate loop (`packages/caws-kernel/src/worktree/ownership.ts:124-136`) does pure `session_id` equality. A foreign session that is dead but whose envelope is still fresh gets admitted as a candidate, matches `owner.session_id`, and the kernel returns `Ok(null)` → `claim.ts:737` exits 0 with no patch. The foreign owner is then rendered as "you" by the `panelSession` swap (`claim.ts:714-717`). Introduced on purpose by `b9c11ae7` to fix the inverse problem (create-then-enter forcing `--takeover`).

**Fix (Resolved-self-strict — chosen approach):** When `--takeover` is explicitly requested, an explicit takeover must NOT be short-circuited by candidate admission unless the candidate IS the resolved self.

1. In `claim.ts`, at the `assertOwnership` call site (~lines 383–395): when `wantsTakeover` is true, restrict `sessionCandidates` to only those whose `session_id === session.session_id` (the cwd-independent re-discovery of self). Concretely:
   ```ts
   const candidatesForKernel = wantsTakeover
     ? sessionCandidates.candidates.filter(c => c.identity.session_id === session.session_id)
     : sessionCandidates.candidates;
   ```
   Effect under `--takeover`: the kernel's branch (1) `sameSession(owner, me)` still handles "resolved self IS the owner" (the legit no-op); branch (2) candidate admission can no longer fire for a *foreign* owner; branch (4) `Ok(takeover_claim)` now fires for the foreign case → patch applied → `applyRegistryPatch` rewrites `owner`, pushes `prior_owners`, sets `takenOver_at`. Non-takeover `claim` is unchanged, so create-then-enter still surfaces "OWNED (you)" / exit 0.
2. Defense-in-depth (so a future regression in the filter can't re-render a foreign owner as "you"): tighten the `panelSession` swap (lines 714–717) and the exit-0 branch (lines 737–739) to additionally require `session.session_id === renderedRecord.owner?.session_id` — a foreign owner is never labeled "you" even if the kernel returned `Ok(null)`.
3. No kernel change — it stays pure id-equality as its doc contract promises. The filtering decision lives in the shell, where the resolved-self identity and the takeover intent are both in scope.

**Accepted trade-off (per your choice):** an agent who create-then-entered and then runs `claim --takeover` on their own worktree may write a self-takeover `prior_owners` entry (noisy audit, not wrong). The non-takeover `claim` path is unaffected.

**Tests:**
- New `packages/caws-cli/tests/shell/session/claim-takeover-foreign-envelope.test.js` (defect reproducer): write a fresh (≤24h `last_seen_at`) durable envelope for a foreign session under `.caws/sessions/<foreign>/.session-envelope.json`, record `<foreign>` as `worktrees.json[wt].owner`, run `claim --takeover`, assert exit 0 **AND** `owner.session_id` rewritten to self **AND** `prior_owners` grew. Today this fails (no rewrite). Use the capsule-writing helper from `claim-cwd-independent.test.js` as a model, but write an envelope (not a capsule) for the foreign owner.
- Regression test (do not regress the legit case): in the same file, the create-then-enter **non-takeover** claim via capsule still exits 0, "OWNED (you)", no rewrite (mirrors existing A1 in `claim-cwd-independent.test.js:147-164`).
- Optional kernel pin in `packages/caws-kernel/tests/unit/worktree-ownership-candidates.test.ts`: a test documenting that the kernel's candidate path is pure id-equality and that the self-vs-foreign filtering decision belongs to the shell — pins the contract so future kernel changes don't silently absorb it.

**scope.in:** `packages/caws-cli/src/shell/commands/claim.ts`, `packages/caws-cli/tests/shell/session/claim-takeover-foreign-envelope.test.js`, `packages/caws-kernel/tests/unit/worktree-ownership-candidates.test.ts`, `.caws/specs/CAWS-FIX-N4-CLAIM-TAKEOVER-AUTHORITY-001.yaml`

---

### Execution order & workflow (per fix)

For each spec, in order N5 → N3 → N4:
1. `caws specs create <id> --title "..." --mode fix --risk-tier <n>`, then edit the YAML (scope/invariants/acceptance modeled on `AUTH-BINDING-BRIDGE-001.yaml`).
2. `caws doctor` + `caws scope show`/`caws scope check <path>` for every file in `scope.in`.
3. `caws worktree create wt-<short> --spec <id>`; `cd` into it.
4. Implement the change + test.
5. Verify: `npm run build` then targeted jest (e.g. `npx jest tests/store/worktree-merge-already-closed-spec.test.js`); then `npm run typecheck`.
6. `caws evidence record --type test --spec <id> --data '{"command":"npm run build && npx jest <file>","exit_code":0}'`.
7. `caws doctor` + `caws gates run --spec <id>`.
8. `caws worktree merge wt-<short>` (auto-closes the spec; I will NOT pre-close, so N5 won't bite my own workflow).

I'll keep the ledger (`sterling/tmp/caws_cli_defect_ledger.md`) notes in mind and, once a fix lands, summarize the closure at the relevant N-entry — but I will not edit that file unless you want me to (it's Sterling-side scratch).

### Risks / notes
- N4 is T1 (authority boundary). Per AGENTS.md I'll flag for your review before merging that one even if gates pass.
- N3's test cannot easily simulate a "lock removed mid-flight" synchronously (busy-wait); I'll lean on the overridable budget to test exhaustion deterministically, and add a recovery assertion where feasible.
- `caws worktree merge` had the N5 defect — but only when a spec is pre-closed. My workflow auto-closes via merge, so I won't trigger it on my own specs. If any merge misbehaves, I know the recovery (`caws worktree destroy <name>` + `git branch -d`).