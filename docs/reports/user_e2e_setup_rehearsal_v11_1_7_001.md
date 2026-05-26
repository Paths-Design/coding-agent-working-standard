# USER-E2E-SETUP-REHEARSAL-001 — Final Report

## 1. Repo chosen and why

- **Target**: `full-stack-design-system` (full-stack-ds) at SHA `c604fb032eecd3d9c2b18531f05310e42a5d375e` (live branch `main` head as of rehearsal start, 2026-05-26 21:30 UTC)
- **Clone path**: `/tmp/fsds-caws-rehearsal/target`
- **Pre-rehearsal state of clone**:
  - `git status --short` empty (clean clone at LIVE_HEAD)
  - `.caws/` ABSENT (good: greenfield CAWS premise satisfied)
  - `.claude/` PRESENT in the clone — the target repo previously installed `.claude/hooks/` for Claude Code agent integration. This is the in-repo committed state; the rehearsal is "first-contact with CAWS" not "first-contact with any agent". Noted explicitly because it changed P2's outcome.
- **Limitations from clone-vs-live**: This rehearsal does not exercise dirty-working-tree friction — the live repo at the time of the kit's writing had 49 untracked items (auto-generated Figma plugin components) that a hypothetical live-repo rehearsal would have to navigate (or have CAWS navigate). The clone began clean.

## 2. Starting state

- **Clone HEAD**: `c604fb0` (`feat(contracts): migrate Calendar to iter:index (V2 explicit witness)`)
- **Branch**: detached HEAD on `c604fb0` (intentional — clone via `git checkout <sha>`)
- **Toolchain detected**: pnpm 10.14.0, node v22.19.0 (via nvm), git (system), turbo 2.9.14 (devDep)
- **CAWS binary identity AT START**: `/Users/darianrosebrook/.nvm/versions/node/v22.19.0/bin/caws` → `../lib/node_modules/@paths.design/caws-cli/dist/index.js`, **version 10.2.0** (stale, pre-existing global install)
- **CAWS binary AFTER upgrade**: same path, **version 11.1.7** (current npm `latest`)
- **CAWS host repo version (for skew comparison)**: 11.1.6 (`packages/caws-cli/package.json`)

## 3. Command transcript, grouped by phase

Per-phase markdown files are at `/tmp/fsds-caws-rehearsal/transcript/p{1..8}-*.md`; raw command outputs (verbatim stdout/stderr) are at `transcript/raw/p{N}-*.txt`. Summary:

**P1 (install)**: `which caws`, `caws --version` (got 10.2.0), `npm view @paths.design/caws-cli version` (got 11.1.7), `npm install -g @paths.design/caws-cli@latest` (upgraded successfully), re-verified `caws --version 11.1.7`. All exit 0 after the upgrade.

**P2 (init)**: `caws init` exited **1** on first run due to `unmanaged_collision` on 16 pre-existing files in `.claude/hooks/`. Diagnostic was clear with three resolution paths. Re-ran `caws init --adopt` → exit 0; idempotent ("project already initialized; no changes."). `.caws/` populated with `policy.yaml`, empty `worktrees.json`, empty `agents.json`, empty `specs/`, empty `waivers/`. 5 new hook files added to `.claude/hooks/`. No production-source modifications.

**P3 (doctor)**: `caws doctor` → exit 0, zero findings, zero load errors.

**P4 (spec)**: Three sequential `error: required option '--<flag>' not specified` errors discovered the minimum invocation (`--title`, `--mode`, `--risk-tier` all required). `caws specs create FIRST-SLICE-001 --title "..." --mode chore --risk-tier 3` → exit 0, file created at `.caws/specs/FIRST-SLICE-001.yaml`. `caws specs list` and `caws specs show` agreed perfectly. Generated spec body had 5 TODO placeholders that the user must fill before scope.in admits any path.

**P5 (worktree)**: `caws worktree create first-slice --spec FIRST-SLICE-001` → exit 0, one-line success message. `.caws/worktrees/first-slice/` populated with the full source tree minus `.caws/` (sparse-checkout invariant — confirmed working). `node_modules` absent inside the worktree (workspace-deps friction).

**P6 (governed change)**: From inside the worktree, `caws status` showed `bound → FIRST-SLICE-001`; `caws scope show README.md` rejected with `scope.reject.root_not_allowed` (because scope.in was still TODO). Amended the spec from the canonical checkout (replaced TODOs with `scope.in: [README.md]`, plus invariants/acceptance/blast_radius); re-checked → `ADMIT scope.admit.scope_in`. Made the trivial 2-line README edit. `pnpm test` from inside worktree failed (`sh: vitest: command not found` — missing node_modules); `pnpm test` from canonical passed (108 files / 1251 tests / 14.69s). Per kit §6, continued.

**P7 (merge/close)**: Committed the change inside the worktree as `3e73917 chore: USER-E2E-SETUP-REHEARSAL-001 rehearsal artifact`. Ran `caws worktree merge first-slice --dry-run` (output: `ready to merge.` — uninformative). Ran `caws worktree merge first-slice` → exit 0, single-transaction result: `merged first-slice (merge_commit: 1b0f85a; auto_closed_spec: FIRST-SLICE-001)`. Post-conditions verified: merge commit on canonical with `merge(worktree): first-slice` message; spec lifecycle_state flipped to `closed` with auto-generated closure_notes; worktree destroyed from disk and registry; 3 hash-chained events appended (spec_closed, worktree_merged, worktree_destroyed).

**P8 (cleanup)**: Final `caws doctor` → 0/0/0 findings (identical to P3 — no degradation). Final spec list shows `FIRST-SLICE-001 closed`. `.caws/worktrees/` empty. 6 events total in `events.jsonl`.

## 4. Files changed by each phase

| Phase | Added | Modified | Deleted |
|---|---|---|---|
| P0 (clone setup) | (clone the repo + `pnpm install`'s `node_modules`) | `git config core.hooksPath` (via `pnpm install`'s `prepare` script) | — |
| P1 | — | global `@paths.design/caws-cli` (10.2.0 → 11.1.7); no target-repo writes | — |
| P2 | `.caws/{policy.yaml,worktrees.json,agents.json}`, `.caws/{specs,waivers}/`, 5× `.claude/hooks/*.{sh,py}` | — | — |
| P3 | — | — | — |
| P4 | `.caws/specs/FIRST-SLICE-001.yaml` (~26 lines, 5 TODO placeholders) | — | — |
| P5 | `.caws/worktrees/first-slice/` (linked worktree, full source tree minus `.caws/`), `.git/worktrees/first-slice/` (git internals) | `.caws/worktrees.json` (added `first-slice` entry, ~10 lines), `.caws/events.jsonl` (+2 events: `worktree_created`, `worktree_bound`), `.caws/specs/FIRST-SLICE-001.yaml` (added `worktree: first-slice` field) | — |
| P6 | — | `.caws/specs/FIRST-SLICE-001.yaml` (filled in scope.in, blast_radius.modules, invariants, acceptance), `<wt>/README.md` (+2 lines whitespace+comment) | — |
| P7 | git commit `1b0f85a merge(worktree): first-slice` (no-FF merge); 3 events in `events.jsonl` (`spec_closed`, `worktree_merged`, `worktree_destroyed`) | `.caws/specs/FIRST-SLICE-001.yaml` (lifecycle_state: closed, resolution, closure_notes, updated_at), `.caws/worktrees.json` (cleared back to `{}`) | `.caws/worktrees/first-slice/`, `.git/worktrees/first-slice/` |
| P8 | — | — | — |

Production source touched: ONE file, README.md, 2 lines (whitespace + HTML comment). No `package.json`, `pnpm-lock.yaml`, `turbo.json`, `tsconfig.json`, or any code-bearing file was modified.

## 5. Diagnostics encountered

| Phase | Command | Diagnostic | Classification | Actionable by new user? |
|---|---|---|---|---|
| P1 | `caws --version` | reports 10.2.0 while npm latest is 11.1.7 | technically-correct-but-confusing | Maybe (no in-band skew warning) |
| P2 | `caws init` | `Refused (16): ... [unmanaged_collision]` w/ 3-way resolution menu (`--overwrite`/`--adopt`/rename) | **clear (model diagnostic)** | Yes |
| P2 | `caws init` | `Restart the Claude Code session so the updated hooks load.` | clear | Yes |
| P2 | `caws init --adopt` | `Unchanged (22): ...` (no distinction between created vs adopted) | technically-correct-but-confusing | Maybe |
| P2 | `caws init` | (silent on whether `.caws/` should be committed or gitignored) | unactionable (silence) | No |
| P3 | `caws doctor` | `findings 0E/0W/0I; load 0E/0W/0I` | clear, but legend undocumented | Yes (with context) |
| P4 | `caws specs create FIRST-SLICE-001` | `error: required option '--title <title>' not specified` (and two more, sequentially) | technically-correct-but-confusing (not batched) | Yes |
| P4 | `caws specs create ... --risk-tier 3` | `created FIRST-SLICE-001 at .caws/specs/FIRST-SLICE-001.yaml (lifecycle_state: active)` | clear but terse (no next-steps) | Yes |
| P4 | (spec body) | 5× `'TODO: list ...'` / `'TODO'` placeholders in scope.in, blast_radius.modules, invariants, acceptance.given/when/then | clear (explicit TODOs) | Maybe (no link to docs explaining what good values look like) |
| P5 | `caws worktree create first-slice --spec FIRST-SLICE-001` | `created first-slice at .caws/worktrees/first-slice (spec: FIRST-SLICE-001)` | clear but terse (silent on cd, sparse-checkout, node_modules) | Maybe |
| P6 | `caws scope show README.md` (pre-amend) | `REJECT scope.reject.root_not_allowed ... repair: Add "README.md" to policy.root_passthrough, or list it explicitly in spec scope.in.` | **clear (textbook)** | Yes |
| P6 | `caws scope show README.md` (post-amend) | `ADMIT scope.admit.scope_in ... admitted by spec FIRST-SLICE-001 scope.in entry "README.md".` | clear | Yes |
| P6 | `pnpm test` (inside worktree) | `sh: vitest: command not found ... WARN Local package.json exists, but node_modules missing` | clear (pnpm-side) but unhelpful in context (CAWS-silent) | No |
| P7 | `caws worktree merge first-slice --dry-run` | `caws worktree merge first-slice --dry-run: ready to merge.` | technically-correct-but-confusing (no preview of effects) | No (can't verify before committing) |
| P7 | `caws worktree merge first-slice` | `merged first-slice (merge_commit: 1b0f85a...; auto_closed_spec: FIRST-SLICE-001)` | **clear (model diagnostic)** | Yes |
| P7 | (spec body, auto) | `closure_notes: 'Auto-closed by caws worktree merge first-slice at <SHA>'` | clear-but-minimal (records mechanism not meaning) | Yes |

## 6. Places where the user would likely stop or ask for help

Ordered most-likely-to-stop first:

1. **P6: `pnpm test` fails inside the worktree because `node_modules` is missing**. This is the single most likely stop-point. A first-contact user's natural impulse — "let me prove my edit didn't break anything" — fails on a CANNOT-FIND-MODULE error with no CAWS guidance. The user will likely either (a) abandon the worktree and edit from canonical, (b) `pnpm install` inside the worktree (slow, may surface lockfile drift), or (c) ask the maintainer. **Without prior knowledge of workspace tooling, a real user is likely to ask or give up here.**

2. **P4: scope.in starting at `'TODO: ...'`**. A user who follows the obvious path will create a spec, create a worktree, start editing — and hit `scope.reject.root_not_allowed` on the very first file edit. The REJECT message is good, but the recovery requires editing YAML by hand to know what to put in `scope.in`. **A user without prior CAWS exposure will likely pause here to read documentation.**

3. **P2: `caws init` exits 1 on a repo with pre-existing `.claude/hooks/`**. The first invocation of `caws init` looks like a failure (non-zero exit, big "Refused (16):" block in output). A user not reading carefully will think "caws is broken on my repo" and stop. The resolution menu is there, but exit-1 is jarring on what users expect to be a setup command.

4. **P1: version skew if user is upgrading**. If the user had `caws-cli@10.2.0` installed from months ago, running `caws init` would land them on the v10 surface (with `scaffold`, `validate`, `verify-acs`, etc. that won't match v11 docs they're reading). They would experience confusing command-not-found errors against any v11 doc. **No in-band signal** that they're on a stale major. A user comparing v11 docs to v10 binary would likely conclude "the docs are wrong."

5. **P4: `caws specs create` requires three positional flags discovered sequentially**. Sequential single-flag errors over three runs is friction; a user might think "this CLI is poorly designed" by the third missing-flag error and either grep documentation or use trial-and-error to discover the rest.

6. **P5: silent absence of `cd` guidance after `caws worktree create`**. A first-contact user may not realize they need to `cd .caws/worktrees/<name>` to start working. They'll keep editing in the canonical checkout, defeating worktree isolation, and only discover the problem later when scope-guard refuses (or worse, doesn't, because they're editing the canonical's untracked state).

7. **P7: `--dry-run` outputs only `ready to merge.`**. A cautious user wanting to preview a destructive operation (merge + worktree-destroy + spec-close) gets no info from dry-run. They may either commit blind (accepting risk) or read source to learn what merge does.

8. **P2: silence on whether `.caws/` should be committed or gitignored**. A user finishes `caws init` and runs `git status` to see `?? .caws/`. They are then on their own to decide. Without doctrine knowledge they may commit `events.jsonl` (runtime state, should probably be ignored) or gitignore the entire `.caws/` (catastrophic — specs are the project's authority).

**Self-honesty caveat**: I, as an agent, had access to the kit's §5 doctrine notes (sparse-checkout, hook-restart, tier-2-contracts, etc.) which a real first-contact user would not have. Several of the items above I would have hit harder without that crib sheet. The friction list above is calibrated to what a user without my crib would likely experience.

## 7. Evidence table

| Acceptance criterion | Evidence | Pass/Fail |
|---|---|---|
| A1 — transcript complete | `/tmp/fsds-caws-rehearsal/transcript/p{1..8}-*.md` (8 files, ~43 KB) + `transcript/raw/p*.txt` (28 files, ~129 KB) | PASS |
| A2 — 10-section report | This document; all 10 sections present | PASS |
| A3 — kit reproducible | The kit's phase-by-phase instructions matched what happened. Two deviations were necessary: (a) `caws init` exited 1 on a real-world repo not anticipated by the kit's "Decisions" rubric (handled by the kit's general "if no diagnostic explains the failure, HANDOFF" rule — but the diagnostic was excellent so I chose `--adopt`); (b) the kit's introduction said the live repo had "8 uncommitted modifications" — the live repo at rehearsal time had 0 tracked-file modifications and 49 untracked items (state had drifted). Neither affected the rehearsal because the clone was clean. | PASS |
| A4 — cleanup | Worktree destroyed, registry cleared, spec closed, doctor 0/0/0. Clone directory remains at `/tmp/fsds-caws-rehearsal/target` and tarball at `/tmp/fsds-caws-rehearsal/transcript.tar.gz`. See §10 for cleanup recipe. | PASS |
| A5 — fixes traceable | §9 below lists every finding with phase reference, raw-file pointer (where applicable), and severity rationale. | PASS |
| A6 — escalation handled | Zero HANDOFFs emitted. All findings were classifiable as "continue" per kit §6 or as ordinary findings, not blockers. | PASS (no escalation needed) |

## 8. Readiness verdict

**READY-WITH-DOC-GAPS**

The CAWS v11.1.7 lifecycle is mechanically sound: `init → specs create → worktree create → scope check → edit → commit → merge` ran end-to-end with zero data loss, zero broken state, zero doctor regressions. The core mechanisms (sparse-checkout invariant, hash-chained event log, atomic merge-close-destroy transaction, scope.reject/admit diagnostics) all behaved as the kit's doctrine described.

The "doc-gaps" qualifier covers three patterns that recur across phases:

1. **Silent successes that need next-steps hints** — `caws init`, `caws specs create`, `caws worktree create`, `caws worktree merge --dry-run` all succeed without telling the user what comes next.
2. **Workspace-monorepo friction** that CAWS does not anticipate — pnpm/yarn/npm workspaces don't get a usable `node_modules` inside a worktree, and the user has to discover the recovery.
3. **Spec scaffold contains TODO placeholders that block first use** — a fresh spec has `scope.in: ['TODO: ...']` and cannot admit any path until the user edits the YAML.

None of these gaps blocks setup completion (the system *works*); all of them slow first-contact users and invite avoidable abandonment.

## 9. Prioritized fix backlog

### P0 — blocks setup completion

(None observed. Every phase completed successfully without requiring the maintainer's intervention.)

### P1 — causes likely user abandonment

- **`caws worktree create` does not warn about workspace-deps absence inside the new worktree**
  - **What**: When a target repo has `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `package.json` with `workspaces`, or other monorepo markers, `caws worktree create` should print a notice like:
    > Note: this worktree does not contain `node_modules`. To run scripts in this worktree, either run `pnpm install` here, symlink to the canonical `node_modules`, or run scripts from the canonical checkout.
  - **Traceability**: P6 transcript, `/tmp/fsds-caws-rehearsal/transcript/raw/p6-test-output.txt` — `sh: vitest: command not found ... WARN Local package.json exists, but node_modules missing, did you mean to install?`
  - **Why P1**: most projects adopting CAWS will be in JS/TS monorepos, and the first thing they'll try is to run tests in their worktree, which will fail with an opaque pnpm error.

- **`caws specs create` does not produce a usable-as-is spec**
  - **What**: The generated YAML has 5 `'TODO: ...'` placeholders that *must* be edited (scope.in, blast_radius.modules, invariants, acceptance.given/when/then) before the spec can do anything. Either: (a) accept additional create-time flags (`--scope-in`, `--invariant`, etc.) to populate them, or (b) prompt interactively for them, or (c) refuse to mark a spec `active` while scope.in is still a TODO placeholder.
  - **Traceability**: P4 transcript, `transcript/raw/p4-list-show.txt`
  - **Why P1**: a user following the obvious path (`caws specs create`, `caws worktree create`, then start editing) will hit `scope.reject.root_not_allowed` on every file they touch until they go back and edit the YAML by hand.

- **`caws init` exits 1 on a repo with pre-existing `.claude/hooks/`**
  - **What**: A non-zero exit on what is fundamentally a successful initialization (.caws/ created, settings.json wired) reads as failure. Consider exiting 0 with a clear "conflict requires resolution" message + reason code, OR distinguishing exit codes: 0 = clean init, 2 = init succeeded but hook-pack needs `--adopt`/`--overwrite` choice.
  - **Traceability**: P2 transcript, `transcript/raw/p2-init-output.txt`
  - **Why P1**: any CI-integrated `caws init` invocation will fail on repos that have any prior Claude Code installation.

### P2 — confusing but recoverable

- **`caws specs create` reports missing required flags one at a time, not batched**
  - **What**: Three sequential exit-1 runs to discover that `--title`, `--mode`, `--risk-tier` are all required. Batch them into a single error message listing all missing required flags.
  - **Traceability**: P4 transcript, `transcript/raw/p4-bare-attempt.txt`, `p4-title-only.txt`, `p4-title-mode.txt`
  - **Why P2**: friction but trivially recoverable.

- **`caws worktree merge --dry-run` is uninformative**
  - **What**: Current output is `ready to merge.` Should preview: target branch, merge commit message, spec that will close, worktree that will destroy, events that will fire.
  - **Traceability**: P7 transcript, `transcript/raw/p7-merge-dryrun.txt`
  - **Why P2**: dry-run is the safety hatch; if it tells the user nothing, it's not useful as a hatch.

- **`caws init` is silent on commit-vs-ignore choice for `.caws/`**
  - **What**: After `caws init`, `git status` shows `?? .caws/`. The CLI does not tell the user which paths inside `.caws/` to commit (specs, policy, waivers, registry) vs gitignore (events.jsonl is debatable, agents.json is local-runtime). Print a recommended `.gitignore` snippet at end of init.
  - **Traceability**: P2 transcript
  - **Why P2**: surfaces an architectural decision the CLI knows the right answer to.

- **`caws worktree create` does not echo `cd` guidance**
  - **What**: Print `Next: cd .caws/worktrees/<name>` at the end of create.
  - **Traceability**: P5 transcript, `transcript/raw/p5-create-and-inspect.txt`
  - **Why P2**: trivial improvement, prevents a class of "I edited the wrong directory" errors.

- **`caws worktree create` does not warn about sparse-checkout silence**
  - **What**: `.caws/` is invisible inside the new worktree. A user trying to `cat .caws/specs/<id>.yaml` from inside gets "No such file or directory" with no explanation. The create-success message should mention `caws specs show <id>` as the canonical way to read a spec from inside a worktree.
  - **Traceability**: P5 transcript, `transcript/raw/p5-create-and-inspect.txt`
  - **Why P2**: doctrine-correct behavior, but the failure mode is opaque.

### P3 — polish / docs

- **`caws doctor` summary uses undocumented E/W/I shorthand**
  - **What**: `findings 0E/0W/0I` — add a legend or use full words for empty output.
  - **Traceability**: P3 transcript

- **`closure_notes` auto-generated text is minimally informative**
  - **What**: `Auto-closed by caws worktree merge first-slice at <SHA>` records HOW the spec closed but not WHAT changed. Either (a) prompt interactively for closure notes, (b) include acceptance outcome flags, or (c) echo the merged commits' messages into the closure_notes.
  - **Traceability**: P7 transcript

- **`caws init --adopt` re-run output does not distinguish adopted from created**
  - **What**: All 22 hook files are marked `=` (unchanged), with no indication of which were just adopted on this run vs already-managed. Use marker like `[a]` for adopted in this run.
  - **Traceability**: P2 transcript, `transcript/raw/p2-init-adopt.txt`

- **No in-band npm version-skew warning**
  - **What**: When the installed `caws-cli` is on an older MAJOR than npm's `latest` dist-tag, `caws --version` (and ideally `caws doctor`) should emit a warning. This rehearsal began with the agent's stale v10.2.0 global on a repo where the kit and docs assume v11.1.x.
  - **Traceability**: P1 transcript, `transcript/raw/p1-version-skew.txt`

- **`caws specs create` success message has no next-steps hint**
  - **What**: After `created FIRST-SLICE-001 at .caws/specs/...`, append: `Next: edit scope.in / blast_radius.modules / invariants / acceptance, then 'caws worktree create <name> --spec FIRST-SLICE-001'`.
  - **Traceability**: P4 transcript

## 10. Non-claims and limits of rehearsal

- Rehearsal used a fresh clone of full-stack-ds at `c604fb0`. A live-repo rehearsal would also probe **dirty-working-tree friction** (49 untracked Figma plugin files at the time of the rehearsal); this rehearsal does not.
- Rehearsal began with the agent's `caws-cli@10.2.0` global already installed; the rehearsal upgraded to `@latest` (11.1.7) per kit §0. A true greenfield user invoking `npm install -g @paths.design/caws-cli` for the first time would land directly on 11.1.7. **The rehearsal does not exercise the pre-install state** (where `which caws` returns nothing and the user must discover the install command — the target repo's README does not mention CAWS as a dependency).
- Rehearsal tested ONE trivial change in P6 (whitespace + HTML comment on README.md). Richer changes would exercise more of scope-guard (multiple-file edits, sub-package edits, governed-path collisions), gate evaluation (`caws gates run --spec <id>`), and CI integration — **none of which this rehearsal touches**.
- The agent running this rehearsal is a Claude Code session that PRE-DATES the `caws init`-installed hooks. Per CAWS doctrine (kit §5.5), the hooks are present on disk but **not active** for this session. The rehearsal therefore **does not exercise the Claude-Code hook layer** (scope-guard.sh, worktree-write-guard.sh, block-dangerous.sh, guard-strikes.sh enforcement on agent tool calls). All scope and worktree enforcement observed in this rehearsal came from explicit CLI invocations (`caws scope show/check`), not from passive hook firing.
- Rehearsal did NOT exercise: multi-agent worktree collisions (foreign-claim soft-block, `--takeover`), `caws gates run`, `caws evidence record`, `caws waiver create`, `caws agents register/heartbeat`, recovery from a failed merge, recovery from a hook-strike accumulation, or any CI-side invocation.
- Rehearsal was performed by a Claude Code agent that had access to the kit's §5 doctrine notes. **A human user without that crib sheet would likely stop or struggle harder** at the friction points described in §6 — especially items 1 (node_modules), 2 (scope.in TODO), and 8 (.caws/ commit decision).
- The kit's introduction described the live repo as having "8 uncommitted modifications"; at rehearsal time the live repo had 0 tracked-file modifications and 49 untracked items. **This drift did not affect the rehearsal** (which used a clean clone), but suggests the kit's pre-flight numbers age quickly.
- `pnpm test` from inside the worktree returned `exit 0` despite the test-script's `ELIFECYCLE` failure (vitest not found). This is a **pnpm-side bug**, not CAWS — but it means any `caws gates run` configuration that delegates to `pnpm test <args>` will falsely conclude success on a missing-deps failure.
- **Network observations**: no `caws` command in this rehearsal produced any visible network activity; commands ran offline-fast (<1s except for init's hook-pack write). I did not formally trace with `dtruss` so this is an observation, not a proof.
- **Privilege observations**: no `sudo` required at any step.
- **Time-to-first-spec (rough wall-clock)**: ~2 minutes from `caws init` to `caws specs show FIRST-SLICE-001`, of which ~1 minute was spent on the multi-round flag-discovery loop in P4.

---

**Transcript bundle**: `/tmp/fsds-caws-rehearsal/transcript.tar.gz` (~28 KB compressed; 8 phase markdowns + 28 raw command-output files).

**Target-repo cleanup status**: not yet performed; clone preserved at `/tmp/fsds-caws-rehearsal/target` until maintainer reviews. Cleanup recipe:

```bash
# Remove clone (keeps tarball for audit)
rm -rf /tmp/fsds-caws-rehearsal/target

# Or remove everything
rm -rf /tmp/fsds-caws-rehearsal
```

**Live repo (`/Users/darianrosebrook/Desktop/Projects/full-stack-ds`) was NOT touched at any point** — confirmed by working exclusively from the `/tmp/...` clone path. The live repo's pre-existing 49 untracked items are still there, unmodified.
