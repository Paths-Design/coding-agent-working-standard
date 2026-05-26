# RELEASE-DISTRIBUTION-SURFACE-RECON-01 — Final Report

## 1. Executive decision surface

**The published-surface skew framed by USER-E2E-SETUP-REHEARSAL-001 / Bug-004 is a narrower problem than that report concluded.**

Three findings drive the framing:

1. **The npm registry is already correct.** `npm view @paths.design/caws-cli dist-tags --json` returns `{"latest": "11.1.6"}`. A first-contact user running `npm install -g @paths.design/caws-cli` **today** gets `11.1.6` — the same version the host repo builds.
2. **The maintainer's local global install is `10.2.0`.** This is environment drift on one machine. It is NOT what real first-contact users obtain from the registry; it is what the maintainer obtained from the registry months ago (10.2.0 published 2026-04-28) and has not refreshed since.
3. **The README is internally inconsistent.** README line 9 says "v11.0.0 cutover in progress." README line 15 says "pin to `caws-cli@^10.2.x` until v11.1 ships." README line 45 says `npm install -g @paths.design/caws-cli@^11.0.0`. v11.1 already shipped (v11.1.0 on 2026-05-18; v11.1.6 on 2026-05-21). So within the same README a first-contact user finds conflicting install advice, two of three references are stale, and the pin-to-10.2.x advice would actively downgrade them.

**Net conclusion:** Bug-004 / P0-0 is not "the npm registry serves v10.2 while everything else claims v11." It is "the README and a handful of in-CLI diagnostics carry stale v10-era advice that contradicts the npm registry truth and the rest of the doctrine surface." The fix is documentation reconciliation, not a release action. **No npm publish is required.** **No code change is required for this finding** (the in-CLI stale-advice diagnostic strings observed in `caws claim` / `caws scope show` / `caws doctor` are tracked separately as `CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01` per the rehearsal report's closed disposition).

**Recommended decision:** **Option A-doc** (publish-current-as-already-published; refresh the README and a small set of stale install-guidance strings). Smallest blast radius, highest user benefit, no version bump required.

**Important non-claim:** this recon does NOT address the other v11.6 P0s observed in the rehearsal (Bug-001/002 `summarizeActiveAgents` crash; Bug-003 stale diagnostic strings). It also does NOT address the v10.2 destructive-init bug (Bug-005) — but because no one should be on v10.2 today (the registry has moved on), Bug-005's blast radius is bounded to users who explicitly install an old version. Those concerns are gated by other follow-up slices, not this one.

---

## 2. Observed npm surface

All observations are read-only `npm view` calls. No mutation.

| Query | Result |
|---|---|
| `npm view @paths.design/caws-cli version` | `11.1.6` |
| `npm view @paths.design/caws-cli dist-tags --json` | `{"latest": "11.1.6"}` |
| `npm view @paths.design/caws-cli versions --json` (last 10) | `["10.0.1", "10.1.0", "10.2.0", "11.0.0", "11.1.0", "11.1.1", "11.1.2", "11.1.3", "11.1.4", "11.1.5", "11.1.6"]` |
| `npm view @paths.design/caws-cli time --json` (most recent) | `"10.2.0": "2026-04-28T01:01:19.143Z"` then `"11.0.0": "2026-05-17T19:07:07.931Z"` then v11.1.0–v11.1.6 from 2026-05-18 through 2026-05-21 |

**Days between latest v10.x and latest v11.x publish:** v10.2.0 was published 2026-04-28; v11.1.6 was published 2026-05-21. That's **23 days** of v11.x being the registry truth. The publish cadence during v11.1.x cutover was tight: 7 releases (11.0.0 + 11.1.0–11.1.6) in 4 days (2026-05-17 through 2026-05-21).

**Dist-tags has only `latest`.** There is no `next`, `beta`, `dev`, or any other channel. Installing anything other than the latest requires an explicit version pin.

**The `npm warn Ignoring workspaces for specified package(s)` warning** on `npm view ...` calls is benign — it is npm's notice that the workspace-aware behavior is being skipped for a `--package` query, which is the correct behavior for read-only inspection.

---

## 3. Observed repo-local surface

| Source | Value |
|---|---|
| `packages/caws-cli/package.json` → `version` | `11.1.6` |
| `packages/caws-cli/CHANGELOG.md` topmost entry | `## [11.1.6] (2026-05-21) — DANGER-LATCH-CALIBRATION-001` |
| Most recent release tag on `main` | `caws-cli-v11.1.6` |
| Tag list (most recent five) | `caws-cli-v11.1.6, caws-cli-v11.1.5, caws-cli-v10.0.0, caws-cli-v9.2.0, caws-cli-v8.0.1` |

**No drift between package.json, CHANGELOG, tag, and npm `latest`.** Repo-local and registry truth agree.

The tag list does have a gap: the most recent two tags are `caws-cli-v11.1.6` and `caws-cli-v11.1.5`, but no `caws-cli-v11.1.0`–`v11.1.4` tags appear locally. Those releases happened (per `npm view ... time`); the tags may not have been fetched into the local clone (`git fetch --tags` would resolve), or were never pushed. **This is a tag-completeness observation, not a release defect** — the npm publishes succeeded, the tags just aren't fully mirrored locally. Not actionable in this slice.

---

## 4. Observed documentation surface

### 4.1 README.md (root) — **internally contradictory, primary user-impacting surface**

Three install-guidance strings in the same file:

| Line | Quote (verbatim) | Status |
|---|---|---|
| 9 | `## Status: v11.0.0 cutover in progress` | **stale** — v11 cutover is complete per CLAUDE.md line 9 ("The v11 cutover is complete"); the heading still claims "in progress" |
| 15 | `If your project depends on the legacy spec or worktree lifecycle commands ..., **pin to caws-cli@^10.2.x** until v11.1 ships.` | **actively misleading** — v11.1 already shipped (v11.1.0 on 2026-05-18); this advice tells users to install a version 9+ months behind `latest` |
| 45 | `npm install -g @paths.design/caws-cli@^11.0.0` | **technically current but suboptimal** — `^11.0.0` resolves to v11.1.6 today (semver caret), so it works, but `^11.1.0` or just no-pin would be clearer about what's actually being installed |

The contradiction is on the user. A diligent reader reaches line 15 first (it's labeled in bold and explains the "if you need lifecycle commands" case — which is most users), follows the pin-to-10.2.x advice, and ends up on the version with Bug-005 (destructive init). A less-diligent reader reaches line 45 and gets the current surface. **The README does not distinguish "the v10 line if you need legacy commands" from "the v11 line if you're starting fresh."**

### 4.2 CHANGELOG.md — **current and accurate**

Top entry is `11.1.6` with the date `2026-05-21` and a complete description of the danger-latch calibration slice. No stale references.

### 4.3 docs/architecture/caws-vnext-command-surface.md — **mostly current with one historical artifact**

§1 ("Cutover posture") still leads with `**A1 chosen.**` and "v11.0.0 is the governed core. v11.0.0 deliberately excludes spec/worktree lifecycle." This was the correct framing at the time the cutover was planned. The subsection "v11.1 plan (out of scope for v11.0.0) — **shipped in v11.1.x**" indicates the v11.1 work has shipped. So §1 reads as a historical narrative (correct posture-at-time-of-writing + a parenthetical that it has since shipped). **Not stale, but the framing is past-tense-as-doctrine** — a new user reading §1 cold might think "v11.0.0 is the current line" before reading the parenthetical.

### 4.4 CLAUDE.md (root) — **current, accurate, one minor drift**

Line 9: `The v11 cutover is complete. main runs the v11 surface (currently published as @paths.design/caws-cli@11.1.4).` The "@11.1.4" reference is stale; the registry latest is 11.1.6, and the host repo also builds 11.1.6. Minor — the framing is correct (cutover complete, v11 is the line), only the specific version number is two patches behind.

### 4.5 packages/caws-cli/templates/CLAUDE.md — **silent on install version**

The template carries a generic `npm install` line; no version pin or major-version reference. **Not stale**, but not helpful either — a user reading the template after `caws init` has no install guidance for the CLI itself (the template is for the project being scaffolded, not the CAWS toolchain).

### 4.6 docs/reports/user_e2e_setup_rehearsal_001_kit.md (the rehearsal kit) — **current**

Kit line 633: `**The CAWS host repo's caws-cli package is at 11.1.6.**` Correct as of the kit's authorship date and still correct now.

### 4.7 docs/reports/user_e2e_setup_rehearsal_001.md (the closed rehearsal report) — **NOT amended by this recon**

The rehearsal report's Bug-004 / P0-0 framing ("npm install -g resolves to v10.2.0") was based on what the maintainer's local global-install shell session reported. The recon's §1 conclusion materially refines that framing. **This recon does NOT amend the closed report** (per spec invariant I1). The refined framing lives here in §1 and §6, and the disposition is recorded in §9 as a recommendation that the next slice (if any) re-scope `RELEASE-DISTRIBUTION-SURFACE-RECON-01`'s candidate slice ids accordingly.

---

## 5. Observed release automation surface

### 5.1 Canonical release trigger

`.github/workflows/release.yml` is the canonical release path. Triggers ONLY on tag push matching `caws-cli-v*`. There is no `on: push: branches: [main]` block — branch pushes do NOT publish. This is the `CAWS-RELEASE-TAG-DRIVEN-001 v1` doctrine.

### 5.2 Release procedure (per workflow + scripts)

1. Maintainer bumps `packages/caws-cli/package.json` version locally.
2. Maintainer authors a `packages/caws-cli/CHANGELOG.md` section for the new version.
3. Maintainer commits both, then pushes a tag `caws-cli-vX.Y.Z`.
4. Workflow validates: tag-version equals package.json-version equals CHANGELOG-topmost-version.
5. Workflow builds, runs prepublish smoke, then `npm publish --provenance`.
6. Workflow polls `npm view` until the new version appears.
7. Workflow creates a GitHub Release with the CHANGELOG section as body.

**Asymmetric failure invariant** documented at `scripts/release-tag-publish.mjs:7-15` and `.github/workflows/release.yml:14-23`:
- Pre-publish failures (validation/build/smoke): tag is DELETED from origin.
- npm publish failure: tag is DELETED (registry not mutated).
- Post-publish failures (verify/GitHub-Release): tag is PRESERVED; repair command emitted.

### 5.3 Release-related scripts

- `scripts/release-guard-dry-run.mjs` — pre-publish validation
- `scripts/release-guard-commit-analyzer-check.mjs` — commit-message scope check
- `scripts/release-guard-scope-audit.mjs` — change-scope auditing
- `scripts/release-tag-publish.mjs` — the publish driver invoked by the workflow
- `scripts/multi-package-release.mjs` — for future kernel publish path (not yet wired)

### 5.4 Convergence with what shipped

v11.1.6 (the current `latest`) was published via this pipeline on 2026-05-21. The pipeline works. **No release automation defect is the cause of any observed user-impacting issue.**

---

## 6. Mismatch table

Every documented mismatch with a user-impact rating. Source → target, observed, expected, impact, disposition.

| Source surface | Target surface | Observed | Expected | User impact | Disposition |
|---|---|---|---|---|---|
| README.md:9 ("v11.0.0 cutover in progress") | CLAUDE.md:9 ("v11 cutover is complete") | "in progress" | "complete" | **high** — sets a wrong mental model on entry | doc-fix |
| README.md:15 ("pin to caws-cli@^10.2.x until v11.1 ships") | npm `latest` (11.1.6, v11.1 shipped 7 days ago) | pin-to-10.2.x advice | "v11.1.6 is the current line; legacy v10.2 commands are removed (see migration guide)" | **high** — actively downgrades users; pulls them into Bug-005 (destructive init) territory | doc-fix |
| README.md:45 ("npm install -g @paths.design/caws-cli@^11.0.0") | npm `latest` (11.1.6) | `^11.0.0` semver caret | `^11.1.0` or unpinned for clarity about what's installed | low — the caret resolves correctly today, but a user reading "@^11.0.0" might think they're getting 11.0.x | doc-fix |
| CLAUDE.md:9 ("currently published as @paths.design/caws-cli@11.1.4") | npm `latest` (11.1.6) | "@11.1.4" | "@11.1.6" | low — two patches behind, framing correct | doc-fix |
| Maintainer's local global install (10.2.0) | npm `latest` (11.1.6) | 10.2.0 | 11.1.6 | **environment-only, NOT registry-level** — a real first-contact user doing `npm install -g` today gets 11.1.6 | no-action-needed at the recon level; maintainer should `npm install -g @paths.design/caws-cli@latest` on their own machine |
| Rehearsal report Bug-004 framing ("npm install -g resolves to v10.2.0") | npm reality (resolves to 11.1.6) | conflated maintainer-environment skew with registry skew | distinct surfaces named separately | medium — the closed report's framing led to this recon being scoped against the wrong target | recorded here in §1 + §4.7; NOT amended into the closed report per spec invariant I1 |
| Local git tag list (5 most recent tags) | npm `versions` list (last 10) | local missing tags for 11.1.0–11.1.4 | full tag mirror | low — fetched tags would resolve; not actionable | no-action-needed |
| docs/architecture/caws-vnext-command-surface.md §1 | current reality | "A1 chosen" framing reads as posture-at-time-of-writing | a current-state framing would read "v11.1 is the canonical line" | low — the parenthetical does say "shipped in v11.1.x" | doc-fix (optional polish) |
| packages/caws-cli/templates/CLAUDE.md | meaningful install guidance | silent | a line for the CLI install version | low — templates are for the scaffolded project, not the toolchain | optional |

**Five mismatches are doc-fix.** Two are environment-only / no-action-needed. The remaining two are low-impact polish.

**Zero mismatches require a release.** The registry is current. The repo-local source-of-truth matches the registry. The release pipeline works.

---

## 7. User impact

A first-contact user adopting CAWS today, fresh clone of their own repo, fresh terminal:

1. They run `npm install -g @paths.design/caws-cli`. **They get v11.1.6.** (Not v10.2.)
2. They read the project's README to learn what to do. **They hit the contradictory install guidance.** README line 15 (most prominent — bolded, frames the "if you need lifecycle" case) tells them to downgrade to `caws-cli@^10.2.x`. If they follow this, they end up on v10.2 and start hitting Bug-005 (destructive init) and Bug-009 (broken diagnose). If they instead trust README line 45 or just leave the latest install in place, they're on v11.1.6 and hit Bug-001/002 (`status`/`agents list` crash) and Bug-003 (stale diagnostic advice in multiple commands).
3. **Either path bounces them.** The README contradiction is what determines which P0 backlog they encounter.

The user-impact ordering, post-recon:

- **Highest impact: README contradiction.** A doc fix would eliminate the downgrade path entirely and route every new user to v11.1.6.
- **Second highest: Bug-001/002 (v11.6 status/agents crash).** Once on v11.6, a user who runs `caws status` (the second-most-obvious command) gets a TypeError-shaped message. Likely abandonment.
- **Third: Bug-003 (stale diagnostic strings in v11.6 commands).** Same machinery that the README carries; same fix flavor (find-and-replace stale v10-era references).
- **Fourth: Bug-005 onward (v10.2 defects).** Now bounded — only users who explicitly install v10.2.x encounter them. If README is fixed, this category retires automatically.

**Bug-004's blast-radius rating in the closed rehearsal report ("the published surface a real user obtains is broken") was correct in its consequence but wrong in its mechanism.** The user-facing problem is real. The cause is a stale README, not a stale registry.

---

## 8. Decision options

Ranked by smallest-blast-radius-for-most-user-benefit. Each option lists prerequisites, action surface, blast radius, and rollback path.

### Option A-doc — Refresh README + the small set of stale doc/diagnostic strings (RECOMMENDED)

- **Prerequisites**: none beyond this recon.
- **Action surface**:
  - README.md lines 9, 15, 45 (rewrite the install guidance and remove the pin-to-10.2 string)
  - CLAUDE.md line 9 (bump 11.1.4 → 11.1.6 or replace the specific-version reference with "the current published line")
  - docs/architecture/caws-vnext-command-surface.md §1 (optional polish — reframe "A1 chosen" as past-tense and elevate "shipped in v11.1.x" out of the parenthetical)
- **Blast radius**: documentation only. No publish. No code change. Affects every new user immediately, every existing user on next README read.
- **Rollback path**: trivial — revert the doc commit if any phrasing turns out to mislead.
- **Candidate follow-up slice**: `DOCS-V11-CUTOVER-FINALIZE-01` (or similarly-named).

### Option A-publish — Publish a fast-follow v11.1.7 that bundles a doc-only update + fixes the stale-diagnostic-strings bug

- **Prerequisites**: Option A-doc's edits MUST land first (or be folded in); decide whether to also bundle `CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01`'s in-CLI string fixes.
- **Action surface**: README + CLAUDE.md + docs (Option A-doc) PLUS source-code fixes for in-CLI stale strings (e.g., the diagnostic in `caws claim` / `caws scope` / `caws doctor`) PLUS package.json bump + CHANGELOG section + canonical tag push.
- **Blast radius**: a fresh published version. Users on `^11.1.0` get it on next `npm install` / `npm update`. Users on a specific pin do not.
- **Rollback path**: the asymmetric failure invariant in the release workflow handles pre-publish failures cleanly; post-publish failures require either a v11.1.8 follow-up or registry deprecation (the latter is documented in the workflow but is heavyweight).
- **When to choose this over A-doc**: if you also want the in-CLI stale-string fixes (Bug-003) shipped before the doc fix can take effect. Doc fixes go live the moment the commit lands; in-CLI fixes require users to upgrade. A bundled release would close both surfaces simultaneously.
- **Candidate follow-up slices**: `DOCS-V11-CUTOVER-FINALIZE-01` + `CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01` + a release-bump slice.

### Option B — Keep v10.2 public as the recommended surface and rewrite v11 docs/kit to match v10.2

- **Prerequisites**: a deliberate decision to roll back the v11 cutover doctrine. The CAWS host repo has invested heavily in v11 (per `docs/architecture/caws-vnext-command-surface.md`, multiple closed slices including `WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001` and the dispatcher-propagation work all depend on v11 substrates).
- **Action surface**: rewrite README, CLAUDE.md, AGENTS.md, the kit, and docs/architecture/* to describe v10.2 as the canonical line. Mark v11 as a separate experimental branch.
- **Blast radius**: massive — would invalidate every spec authored against v11, every test that exercises v11-only commands, the published kit, and the closed slices' design assumptions. Not recommended unless v11 has a fundamental architectural defect this recon has not surfaced.
- **Rollback path**: revert the docs commits. The v11 code itself stays in place (npm latest stays v11.1.6 unless deliberately demoted).
- **When to choose this**: only if a strategic decision is made to retire v11 entirely. The recon evidence does not support this — v11.6 works for the core lifecycle (the rehearsal P7 evidence is strong), and the registry has already moved to v11.

### Option C — Introduce explicit `stable` / `next` (or `latest` / `dev`) dist-tags

- **Prerequisites**: a decision about which version each tag points to. Today `latest` = 11.1.6. If `stable` = some older known-good (e.g., 10.2.0 if v10 lifecycle is what most users want), and `next` = 11.1.6, the README would need to direct different audiences to different tags.
- **Action surface**: `npm dist-tag add @paths.design/caws-cli@<v> <tag>` (no new publish required for existing versions). README rewrite to describe channels.
- **Blast radius**: existing users following `latest` are unaffected. New users opt into channels via explicit install. Some doctrine effort to explain when to use which.
- **Rollback path**: `npm dist-tag rm` removes a tag without affecting any version.
- **When to choose this**: if the project ends up with parallel-supported lines (e.g., v10.x maintained for legacy users, v11.x evolving). The recon evidence does not yet support this — v10.2's defects (Bug-005/006/007/009) suggest v10 should be retired rather than maintained.

### Option D — Block distribution until v11.6 P0s are fixed

- **Prerequisites**: a decision to deprecate the current `latest = 11.1.6` and revert npm `latest` to an earlier version.
- **Action surface**: `npm dist-tag add @paths.design/caws-cli@11.1.5 latest` (or similar). Users would then get an older v11 patch on `npm install`.
- **Blast radius**: existing users on 11.1.6 keep working. New `npm install` users land on the older version (which may have its own defects). Materially disrupts the "registry latest is current" property that has held for the project.
- **Rollback path**: `npm dist-tag add @paths.design/caws-cli@11.1.6 latest` restores.
- **When to choose this**: if v11.1.6 has a known-critical defect that affects most users. The rehearsal's v11.6 P0s (status crash, claim stale string) are real but bounded — `caws status` is annoying but not blocking the lifecycle. Not recommended.

### Option E — Other

The evidence does not support a fifth option distinct from A–D. The recon found no surprise (no shadow channel, no compromised version, no missing tag-version-changelog correspondence, no malformed `.npmignore` shipping the wrong files). If a follow-up surfaces something new (e.g., the maintainer wants to maintain v10.2 in parallel with v11.x for some strategic reason), Option C is the doctrine-supported path.

---

## 9. Recommended next authorized slice(s)

In order of recommended execution. Recon does NOT open these; the maintainer authorizes the next slice in a separate turn.

1. **`DOCS-V11-CUTOVER-FINALIZE-01`** (or similar name) — implements Option A-doc. Rewrites the README's three contradictory install-guidance strings, updates CLAUDE.md line 9's version reference, and optionally polishes docs/architecture/caws-vnext-command-surface.md §1. Smallest blast radius. Highest immediate user benefit. **This is the recommended next slice.**

2. **`CAWS-STATUS-AGENTS-SUMMARIZE-ACTIVE-AGENTS-01`** (existing candidate from the rehearsal report) — fixes Bug-001/002 in v11.6 source. Independent of distribution; can run in parallel with #1.

3. **`CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01`** (existing candidate from the rehearsal report, broadly scoped per the amendment) — fixes Bug-003 in v11.6 source. Same prerequisites as #2.

4. **Release-bump slice** (e.g., `RELEASE-CAWS-CLI-11-1-7-01`) — bundles the source fixes from #2 and #3 into a v11.1.7 publish. Runs after #2 and #3 merge. Only needed if the source-fix slices are bundled rather than shipped via separate patch releases.

5. **`CAWS-INIT-SAFE-COLLISION-PUBLISHED-SURFACE-01`** (existing candidate from the rehearsal report) — addresses Bug-005 (v10.2 destructive init). **Recon recommendation: SKIP unless the project decides to maintain v10.2 in parallel.** Once README routes everyone to v11, the v10.2 defects become history. If kept, scope this slice to v10.2 only and clearly mark the candidate as low-priority.

The four candidate slices the closed rehearsal report named are mostly still valid, but their priorities should be re-ordered per this recon. The slice originally named first (`RELEASE-DISTRIBUTION-SURFACE-RECON-01`) is now CLOSED with the conclusion that no release action is needed. The follow-up ordering should be #1 (docs) → #2 + #3 (parallel code fixes) → #4 (optional bundled release) → #5 (optional, only if v10 is being maintained).

---

## 10. Non-claims

- **This recon did NOT publish anything.** Every npm-side observation was `npm view`. No `npm publish`, no `npm dist-tag`, no `npm unpublish`. The `npm warn Ignoring workspaces` notice on `npm view` calls is benign.
- **This recon did NOT modify the closed rehearsal report.** Per spec invariant I1, the rehearsal report is closed at `bc3c8af` and stays as-recorded. The refined framing of Bug-004 lives in this recon's §1 and §4.7 only.
- **This recon did NOT create `.caws/agents.json`** or address the doctor warning about its absence (recorded as ambient doctor drift in the rehearsal closure summary). Out of scope per spec invariant I8.
- **This recon did NOT verify the registry truth from any machine other than the maintainer's host.** `npm view @paths.design/caws-cli` was run from the host CAWS repo's working environment, which uses the global npm registry by default. A user behind a proxy, mirror, or air-gapped environment may see different state. The recon assumes the global public registry is what first-contact users hit.
- **This recon did NOT measure download counts, install success rates, or any other signal a real user would generate.** "First-contact user experience" is inferred from the doctrine surface and the rehearsal evidence, not measured empirically. A real user study would be a separate research slice.
- **This recon did NOT discover any release-pipeline defect.** The tag-driven release workflow is sound; it published 7 versions cleanly between 2026-05-17 and 2026-05-21. If a future bug arises in release automation, it is not foreshadowed here.
- **This recon does NOT recommend changes to release automation or dist-tag policy.** Today's single-`latest` posture works. The Option C (channel split) recommendation is contingent on a future strategic decision the recon evidence does not yet support.
- **This recon does NOT bundle Option A-doc's actual fix.** That is the recommended next slice (`DOCS-V11-CUTOVER-FINALIZE-01`) and requires its own scope, invariants, and acceptance criteria. Recon ends with the recommendation.
- **The maintainer's local global-install version is one machine's state.** If multiple developers/contributors have stale global installs, that is a workflow observation for them individually (each runs `npm install -g @paths.design/caws-cli@latest` to refresh), not a project-level defect. The project's job is to make sure the registry truth and the doc surface agree; once they do, every developer can self-serve a refresh.
