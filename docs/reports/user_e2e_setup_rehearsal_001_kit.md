# USER-E2E-SETUP-REHEARSAL-001 — Remote Agent Rehearsal Kit

**Spec**: `USER-E2E-SETUP-REHEARSAL-001` (CAWS host repo, `lifecycle_state: active`)
**Target repo**: `/Users/darianrosebrook/Desktop/Projects/full-stack-ds` (or a clean clone thereof)
**Agent host**: a Claude Code session running inside the target repo (NOT inside the CAWS host repo)
**Output**: a complete report at `<caws-host>/docs/reports/user_e2e_setup_rehearsal_001.md`, delivered back to the CAWS maintainer

---

## 0. Brief

You are a Claude Code agent operating from inside an external repository. Your job is to **observe what a first-contact user experiences** when adopting CAWS into a real existing project — not to fix anything, not to make CAWS look good, not to make CAWS look bad. You are running a recon mission.

**Behavioral rules:**

- **Do NOT modify production code in the target repo.** No source files, no test files, no package metadata, no CI config. The only writes you may perform are CAWS-introduced state (`.caws/`, `.claude/`, hook installs) and your own transcript files.
- **Do NOT silently work around blockers.** If a command fails, a diagnostic is unclear, or a step requires private knowledge you don't have, that's a finding. Record it and either continue with the smallest safe recovery (per the decision table in §6) or emit a HANDOFF (per §7).
- **Record successes and friction with equal fidelity.** "Everything worked" is a finding. "I had to guess the right flag" is a finding. "The diagnostic told me exactly what to do" is a finding. Quote command output verbatim where practical.
- **Stay in the target repo's working tree.** Do not cd into the CAWS host repo for any purpose other than reading published docs you happen to need. The CAWS host repo is the source of truth for the kit and spec; your reads of it are fine, but no writes.
- **You may NOT install CAWS via the unpublished local CAWS build path** unless every other path has failed and you've recorded why. Default to the published-npm command surface a real user would actually obtain.

**Anti-narration rule:** If at any point you find yourself wanting to explain or apologize for a CAWS behavior to "help" the reader of the report, stop. Quote the behavior. Let the report show it.

---

## 1. Phase Map (what to run, in order)

You will execute seven phases. Each phase has a fixed shape:

1. **PRECONDITIONS** — what the world must look like before this phase
2. **COMMANDS** — exact commands to run (literal, copy-pasteable)
3. **EVIDENCE TO CAPTURE** — what to log and where
4. **DECISIONS** — what classifications/judgments to record
5. **CONTINUE / STOP rule** — when to proceed vs. emit HANDOFF

Phases:

| # | Name | Purpose |
|---|---|---|
| P1 | Install / source check | Identify which `caws` binary a new user gets, version, command surface |
| P2 | First init | Run `caws init` in a CAWS-naive repo, observe what changes |
| P3 | Doctor comprehension | Run `caws doctor`, classify every diagnostic |
| P4 | First spec | Create the smallest useful spec via the CLI |
| P5 | First worktree | Create a worktree bound to that spec |
| P6 | First governed change | Make a trivial in-scope edit; run the repo's own test command |
| P7 | First merge / close | Merge via CAWS-native flow; verify cleanup |

---

## 2. Target repo selection and setup

The target is `/Users/darianrosebrook/Desktop/Projects/full-stack-ds`. **At the time the kit was authored, the live repo had 8 uncommitted modifications** in `packages/ds-codegen/` and `packages/ds-figma-plugin/`. To avoid contaminating the rehearsal AND to protect that in-progress work, you MUST work from a fresh clone, not the live repo.

### 2.1 Clone the target repo at its current HEAD

From the host system (NOT from inside CAWS):

```bash
# Capture the live repo's current HEAD without touching it
LIVE_HEAD=$(git -C /Users/darianrosebrook/Desktop/Projects/full-stack-ds rev-parse HEAD)
echo "Live HEAD: $LIVE_HEAD"

# Clone to a scratch location
mkdir -p /tmp/fsds-caws-rehearsal
cd /tmp/fsds-caws-rehearsal
git clone /Users/darianrosebrook/Desktop/Projects/full-stack-ds target
cd target
git checkout "$LIVE_HEAD"

# Verify greenfield CAWS state
test ! -e .caws && echo "OK: no .caws/ directory" || echo "FINDING: .caws/ already present in clone (committed state has CAWS — rehearsal premise broken)"
git status --short  # should be empty (fresh clone)
```

Record in your transcript:
- `$LIVE_HEAD` value
- Path to the clone
- Result of the greenfield-CAWS check

If `.caws/` exists in the clone, the rehearsal premise is invalid (full-stack-ds already adopted CAWS at some prior commit). Emit HANDOFF and stop.

### 2.2 Install the target repo's normal dependencies (their own toolchain)

```bash
# full-stack-ds uses pnpm
pnpm install
```

Record exit code, time taken, any warnings.

**Why this step:** a real first-contact user has already installed their own toolchain before discovering CAWS. The rehearsal must observe CAWS in the context of an existing working project, not a bare git directory.

---

## 3. Phase-by-phase execution

### P1 — Install / source check

**PRECONDITIONS:** clean clone exists, deps installed.

**COMMANDS:**

```bash
# Where is caws?
which caws || echo "NO CAWS ON PATH"
which -a caws  # all matches

# What version?
caws --version || echo "NO --version FLAG"

# What command surface does this binary expose?
caws --help 2>&1 | head -60

# Identify the install source by inspecting the binary's resolved path
CAWS_BIN=$(which caws 2>/dev/null)
if [ -n "$CAWS_BIN" ]; then
  readlink -f "$CAWS_BIN" 2>/dev/null || ls -la "$CAWS_BIN"
  # Try to find the package.json that owns it
  CAWS_DIR=$(dirname "$(readlink -f "$CAWS_BIN" 2>/dev/null || echo "$CAWS_BIN")")
  cat "$CAWS_DIR/../package.json" 2>/dev/null | head -10 || \
    find "$CAWS_DIR/.." -maxdepth 3 -name package.json 2>/dev/null | head -3
fi
```

**EVIDENCE TO CAPTURE:**
- Which `caws` binary resolves on PATH (full path, install source)
- Its version
- Top of `--help` output (what command groups appear)
- Whether the install source is one of: global npm (`@paths.design/caws-cli`), local node_modules, repo-local build path, or absent

**DECISIONS:**
- Classify the user's likely install experience: "trivial" (npm install -g resolves on PATH), "discoverable" (README says how), "requires private knowledge" (the binary at `/Users/darianrosebrook/.../node_modules/.bin/caws` is the only working one and isn't in the docs), or "broken" (no caws on PATH, no docs).
- Compare `caws --version` against the CAWS host repo's `packages/caws-cli/package.json` version (you can read that from the host repo). Record any skew.

**CONTINUE / STOP rule:**
- If `caws --version` produces output and the binary is on PATH, continue to P2.
- If no `caws` on PATH but a discoverable install command exists (e.g., the target repo's README mentions it, or `pnpm add -D @paths.design/caws-cli` is plausible), record that finding and run the documented install. Continue.
- If no install path is discoverable, emit HANDOFF.

### P2 — First init

**PRECONDITIONS:** P1 complete; clean clone (`git status --short` empty); no `.caws/` directory.

**COMMANDS:**

```bash
# Capture baseline
git status --short > /tmp/p2-baseline-status.txt
ls -la > /tmp/p2-baseline-ls.txt
find . -maxdepth 2 -name .caws -o -name .claude 2>/dev/null > /tmp/p2-baseline-caws.txt

# The actual init. Use whatever the docs/help recommend.
# At minimum, try the bare form and observe what it does.
caws init 2>&1 | tee /tmp/p2-init-output.txt
P2_EXIT=$?
echo "EXIT: $P2_EXIT"

# Post-init state
git status --short > /tmp/p2-post-status.txt
find . -maxdepth 3 -newer /tmp/p2-baseline-ls.txt -type f 2>/dev/null | head -50 > /tmp/p2-new-files.txt
ls -la .caws/ 2>&1 > /tmp/p2-caws-tree.txt
ls -la .claude/ 2>&1 > /tmp/p2-claude-tree.txt
```

**EVIDENCE TO CAPTURE:**
- Exit code
- Full stdout/stderr (in `p2-init-output.txt`)
- What files were created (diff of `p2-baseline-status.txt` vs `p2-post-status.txt`, plus `p2-new-files.txt`)
- What's inside `.caws/` and `.claude/` (the tree listings)
- Whether the command output explains what it did, or just exits silently / prints a wall of text

**DECISIONS:**
- Does `caws init` ask any questions, or run autonomously?
- Does it tell the user what to commit, what to do next, what NOT to do?
- Does it install hooks? If so, does it warn that the session needs to restart for hooks to activate? (This is a known CAWS doctrine point — the agent should check whether the user is told.)
- Does it interfere with the existing pnpm/turbo setup? (Look for any changes to `package.json`, `pnpm-lock.yaml`, `turbo.json` — there should be NONE.)

**CONTINUE / STOP rule:**
- Exit 0 and `.caws/` populated → continue to P3.
- Exit 0 but `.caws/` empty or partial → record as finding, continue to P3.
- Non-zero exit → record full output and EXIT IF the diagnostic is silent about recovery; emit HANDOFF.

### P3 — Doctor comprehension

**PRECONDITIONS:** P2 succeeded; `.caws/` exists.

**COMMANDS:**

```bash
caws doctor 2>&1 | tee /tmp/p3-doctor-output.txt
P3_EXIT=$?
echo "EXIT: $P3_EXIT"
```

**EVIDENCE TO CAPTURE:**
- Exit code
- Full stdout/stderr
- For EACH diagnostic emitted (each `[ERROR]`, `[WARN]`, `[INFO]` line and its associated `subject:` / `repair:` block):
  - The diagnostic text verbatim
  - Your classification: **clear** / **technically correct but confusing** / **unactionable** / **wrong** / **noisy**
  - For "confusing" or "unactionable": what additional information you would have needed
  - For "wrong": what the diagnostic claims vs. what's actually true (cite the actual state on disk)

**DECISIONS:**
- Could a user act on each diagnostic without reading CAWS source code?
- Does doctor surface anything that would alarm a new user (a WARN that looks like an ERROR but isn't, etc.)?
- Does doctor's summary line make sense as a project-health signal?

**CONTINUE / STOP rule:**
- Continue regardless of exit code. Doctor is observational; even non-zero exit (per CAWS doctrine, exit 1 = findings present) is part of what we're measuring.

### P4 — First spec

**PRECONDITIONS:** P3 complete (whether or not doctor was happy).

**COMMANDS:**

Try to create a minimal spec for some genuinely small, plausible piece of work the user might want to do in `full-stack-ds`. **Pick something trivial that already needs doing or could plausibly need doing** — e.g., a docstring tweak in `packages/ds-codegen/`, a README typo fix, a comment update. Don't pick something invasive.

```bash
caws specs create --help 2>&1 | tee /tmp/p4-help.txt
# Then try the minimum-flag form first to see what's required.
caws specs create FIRST-SLICE-001 2>&1 | tee /tmp/p4-bare-attempt.txt
# Then with flags as the help suggests.
# (Adjust based on what --help told you.)
caws specs create FIRST-SLICE-001 --title "Trivial first slice for rehearsal" --mode chore --risk-tier 3 2>&1 | tee /tmp/p4-create-attempt.txt
P4_EXIT=$?

# Verify it's discoverable.
caws specs list 2>&1 | tee /tmp/p4-list.txt
caws specs show FIRST-SLICE-001 2>&1 | tee /tmp/p4-show.txt
```

**EVIDENCE TO CAPTURE:**
- Exit codes from each attempt
- Did the bare-flag form work, or did it require specific flags?
- Were error messages from incomplete invocations clear about what was missing?
- Did `specs show` reproduce what `specs list` displayed? (This is the failure mode the CAWS maintainer just hit; we want to know if a first-contact user would also hit it.)
- The generated spec YAML file (read it, paste excerpt)
- Whether the user could plausibly fill in `blast_radius.modules`, `scope.in`, `scope.out`, `invariants`, `acceptance` without reading CAWS internals

**DECISIONS:**
- Risk-tier 2 spec creation requires contracts (per known CAWS schema gap). Does the CLI surface this? Does the diagnostic explain how to bootstrap (tier 3 then amend)?
- Are acceptance criteria's Given/When/Then format documented anywhere a user would naturally look?
- Does the generated spec have TODO placeholders the user must fill, or is it usable as-is?

**CONTINUE / STOP rule:**
- If `specs show FIRST-SLICE-001` works after creation, continue.
- If create succeeds but show/list disagree, record the inconsistency in detail and continue (it's a finding, not a blocker).
- If create fails and no flags-form path works, HANDOFF.

### P5 — First worktree

**PRECONDITIONS:** P4 created a spec.

**COMMANDS:**

```bash
caws worktree create --help 2>&1 | tee /tmp/p5-help.txt

# Create a worktree bound to the new spec.
caws worktree create first-slice --spec FIRST-SLICE-001 2>&1 | tee /tmp/p5-create.txt
P5_EXIT=$?

# Inspect the result.
ls -la .caws/worktrees/ 2>&1 > /tmp/p5-worktrees-ls.txt
git worktree list > /tmp/p5-git-worktree-list.txt
cat .caws/worktrees.json 2>&1 > /tmp/p5-registry.txt
ls -la .caws/worktrees/first-slice/ 2>&1 > /tmp/p5-wt-tree.txt

# Critical: what does the worktree look like?
# Specifically, is .caws/specs/ visible inside the worktree (sparse-checkout question)?
ls -la .caws/worktrees/first-slice/.caws/specs/ 2>&1 > /tmp/p5-wt-specs-visibility.txt

# Are node_modules / dependencies usable from inside the worktree?
ls -la .caws/worktrees/first-slice/node_modules 2>&1 > /tmp/p5-wt-node-modules.txt
```

**EVIDENCE TO CAPTURE:**
- Exit code
- Full output of create
- Whether the worktree directory was created, the branch was created, the registry was updated
- The sparse-checkout state inside the worktree (is `.caws/specs/` visible? — per CAWS doctrine it should NOT be)
- Whether `node_modules/` is present or absent inside the worktree (this is a known friction point: pnpm/yarn workspaces usually need a per-worktree install OR a symlink to canonical)
- Whether the create command told the user about the sparse-checkout invariant, the dependency question, or the "do not touch other worktrees" rule

**DECISIONS:**
- Is it obvious to the user where to work? (cwd should be the worktree, but did the command say so?)
- Did the user receive any guidance on what to do next?
- For pnpm workspaces specifically: would the user know they need to handle node_modules inside the worktree?

**CONTINUE / STOP rule:**
- Worktree created, registry updated → continue. Record any node_modules-or-similar friction.
- Create failed → record output. HANDOFF if no diagnostic explains the failure.

### P6 — First governed change

**PRECONDITIONS:** P5 succeeded.

**COMMANDS:**

```bash
# Switch into the worktree.
cd .caws/worktrees/first-slice

# Verify cwd and binding.
pwd
git rev-parse --abbrev-ref HEAD
caws status 2>&1 | tee /tmp/p6-status.txt
caws scope show README.md 2>&1 | tee /tmp/p6-scope-readme.txt

# Make a trivial change. Pick something tiny and in scope.
# IMPORTANT: only edit something that the bare spec's default scope.in covers.
# If the default scope.in is "TODO: list the file(s)...", you must amend the
# spec first OR pick a file that the default admits. Try README.md as
# probably-admittable, and adjust if scope guard refuses.
echo "" >> README.md  # trivial whitespace addition
echo "<!-- CAWS E2E rehearsal artifact: harmless trailing newline added by USER-E2E-SETUP-REHEARSAL-001 -->" >> README.md
git diff README.md > /tmp/p6-diff.txt
git status --short > /tmp/p6-status-short.txt

# Run the target repo's own test command.
pnpm test 2>&1 | tail -80 | tee /tmp/p6-test-output.txt
P6_TEST_EXIT=$?

# Did any CAWS hook fire? (look for [scope-guard.sh], [worktree-guard.sh],
# [block-dangerous.sh] markers in any output)
grep -rn "scope-guard\|worktree-guard\|block-dangerous\|guard-strikes" /tmp/p6-*.txt > /tmp/p6-hook-markers.txt 2>/dev/null
```

**EVIDENCE TO CAPTURE:**
- The diff (`p6-diff.txt`)
- Test exit code
- Whether CAWS hooks fired during the edit or test run (if so, quote them)
- Whether `caws status` from inside the worktree showed the binding correctly
- Whether `caws scope show README.md` ADMITTED or REJECTED the path

**DECISIONS:**
- Did CAWS interrupt the user's normal flow (test run, edit, etc.) at any point? If yes, was the interruption useful or noise?
- For a user whose first edit was rejected by scope-guard: would the diagnostic guide them to amend the spec? Or would they give up?
- Does the user understand from `caws status` what mode they're in (authoritative vs. union)?

**CONTINUE / STOP rule:**
- If the edit was blocked by scope-guard: that's a finding. Record it, amend the spec to admit `README.md`, retry once. If still blocked, HANDOFF.
- If pnpm test fails for reasons unrelated to your edit (e.g., it was broken at HEAD), record that and continue. Your edit is whitespace; it cannot cause test failures.
- If pnpm test fails for reasons related to your edit, your "trivial" change wasn't trivial. Revert it and pick something safer.

### P7 — First merge / close

**PRECONDITIONS:** P6 produced an in-scope committed change.

**COMMANDS:**

```bash
# Commit the change inside the worktree.
git add README.md
git commit -m "chore: USER-E2E-SETUP-REHEARSAL-001 rehearsal artifact" 2>&1 | tee /tmp/p7-commit.txt
WORKTREE_SHA=$(git rev-parse HEAD)
echo "Worktree HEAD: $WORKTREE_SHA"

# Go back to the canonical checkout root.
cd ../../..
pwd  # should be the target repo root (not .caws/worktrees/first-slice anymore)

# Try the CAWS-native merge.
caws worktree merge first-slice --dry-run 2>&1 | tee /tmp/p7-merge-dry.txt
caws worktree merge first-slice 2>&1 | tee /tmp/p7-merge.txt
P7_MERGE_EXIT=$?

# Inspect post-merge state.
git log --oneline -5 > /tmp/p7-log.txt
git status --short > /tmp/p7-status.txt
caws specs show FIRST-SLICE-001 2>&1 | head -10 > /tmp/p7-spec-state.txt
caws worktree list 2>&1 > /tmp/p7-wt-list.txt
git worktree list > /tmp/p7-git-wt-list.txt
cat .caws/worktrees.json 2>&1 > /tmp/p7-registry.txt
```

**EVIDENCE TO CAPTURE:**
- Worktree HEAD SHA
- Dry-run output (does it explain what will happen?)
- Merge output (merge commit SHA, auto-close behavior, registry update)
- Post-merge spec state: was it auto-closed? Were closure_notes auto-generated, and are they meaningful?
- Post-merge worktree state: was it auto-destroyed? Was the registry cleaned up?

**DECISIONS:**
- Could the user understand what `merge` was about to do from the dry-run?
- After merge, can the user clearly see what changed (the merge commit, the spec close, the registry update)?
- Is the closure_notes content useful by itself, or does it require external context to interpret?

**CONTINUE / STOP rule:**
- If merge succeeds and post-conditions hold (spec closed, worktree destroyed, registry clean), proceed to cleanup.
- If merge fails, record output and HANDOFF.

### P8 (cleanup) — Final state verification

**COMMANDS:**

```bash
git status --short > /tmp/p8-final-status.txt
git log --oneline -8 > /tmp/p8-final-log.txt
caws doctor 2>&1 | tee /tmp/p8-final-doctor.txt
caws specs list 2>&1 > /tmp/p8-final-specs-list.txt
ls -la .caws/worktrees/ 2>&1 > /tmp/p8-final-wt-ls.txt
```

**EVIDENCE TO CAPTURE:**
- Final `git status` (should be clean)
- Final `git log` (should show your scaffold commits + the merge)
- Final doctor output (compare to P3 — did findings change?)
- Final spec list (FIRST-SLICE-001 should be `closed`)

**DECISIONS:**
- Could the user trace back what they did? (Looking at git log, do the commit messages and merge tell a coherent story?)
- Doctor delta from P3 → P8 is itself a finding.

---

## 4. What to log and how

### 4.1 Directory layout

Maintain a single working directory for all rehearsal artifacts. Recommend:

```
/tmp/fsds-caws-rehearsal/transcript/
  p1-install-source.md
  p2-first-init.md
  p3-doctor-comprehension.md
  p4-first-spec.md
  p5-first-worktree.md
  p6-first-change.md
  p7-first-merge-close.md
  p8-cleanup.md
  raw/
    p2-init-output.txt
    p3-doctor-output.txt
    ...all the /tmp/pN-*.txt files referenced above
```

### 4.2 Per-phase markdown template

For each phase, write a markdown file with EXACTLY these sections:

```markdown
# Phase N — <name>

## Preconditions met
[yes/no/partial; explain]

## Commands run

\`\`\`bash
# Exact commands, copy-paste ready
\`\`\`

## Output (verbatim or quoted)

[Paste relevant stdout/stderr. If output is >50 lines, quote the meaningful
excerpts and reference the raw file under raw/.]

## Files changed

[List of paths. For .caws/ tree, paste the tree or `find .caws -type f` output.]

## Diagnostics encountered

For each non-trivial diagnostic emitted by any command:

- **Diagnostic**: `<verbatim text>`
- **Source**: <which command produced it>
- **Classification**: clear / technically-correct-but-confusing / unactionable / wrong / noisy
- **What I would have needed**: <if confusing or unactionable>
- **What's actually true**: <if wrong; cite filesystem evidence>

## Friction points

[Bulleted list of moments where a first-contact user would likely:
 - stop and re-read,
 - ask for help,
 - guess and proceed,
 - give up.
 Include the specific text or behavior that triggered the friction.]

## Decisions / classifications

[Phase-specific decisions per the kit. Be specific.]

## Continue / Stop verdict

CONTINUE — <why> | STOP-HANDOFF — <why>
```

### 4.3 The final report

After all phases, compose the final report at the path the CAWS spec requires:

```
<caws-host-repo>/docs/reports/user_e2e_setup_rehearsal_001.md
```

You will NOT have write access to the CAWS host repo from inside the target repo. Two delivery options (the maintainer will choose at handoff time):

**Option A (preferred):** at the end of the rehearsal, archive the entire `/tmp/fsds-caws-rehearsal/transcript/` directory as a single tarball and emit a HANDOFF block with the tarball path and a draft of the final report inline. The CAWS maintainer commits it.

**Option B:** if the user has set up a path you can write to that maps into the CAWS host repo (e.g., a mounted directory or a previously-discussed scratch path), write directly. Default to Option A.

### 4.4 Final report structure

Required sections (numbered, in order, all present even if a section is "(none)"):

```markdown
# USER-E2E-SETUP-REHEARSAL-001 — Final Report

## 1. Repo chosen and why

- Target: full-stack-ds at SHA <LIVE_HEAD>
- Clone path: /tmp/fsds-caws-rehearsal/target
- Pre-rehearsal state of clone: [clean | not-clean — details]
- Limitations from clone-vs-live: [note that a live-repo rehearsal would
  also probe dirty-working-tree friction; this rehearsal does not]

## 2. Starting state

- Clone HEAD: <sha>
- Branch: <branch>
- Toolchain detected: <pnpm/npm/yarn>, <node version>, <other>
- CAWS binary identity: <path>, <version>, <install source>
- CAWS host repo version (for skew comparison): <version>

## 3. Command transcript, grouped by phase

[Compress the per-phase markdown files into a single transcript here.
 For each phase, give: phase name, commands run, key output excerpts
 (with raw file references), exit codes.]

## 4. Files changed by each phase

[Table: phase → list of paths added/modified/deleted. Include byte-counts
 where surprising (e.g., "init created 47 files totaling 312 KB").]

## 5. Diagnostics encountered

[Aggregated table of every diagnostic from every phase. Columns:
 phase, source command, diagnostic text, classification,
 actionable-by-new-user (yes/no/maybe).]

## 6. Places where the user would likely stop or ask for help

[Ordered list, most-likely-to-stop first. For each: phase, trigger,
 what a real user would probably do (guess / ask / give up).
 Be honest. If you would not have known what to do without your prior
 knowledge, say so.]

## 7. Evidence table

| Acceptance criterion | Evidence | Pass/Fail |
|---|---|---|
| A1 (transcript complete) | <link to transcript> | |
| A2 (10-section report) | <self-reference> | |
| A3 (kit reproducible) | [your assessment of whether the kit was sufficient] | |
| A4 (cleanup) | <link to P8> | |
| A5 (fixes traceable) | [self-reference to §9] | |
| A6 (escalation handled) | [list HANDOFFs emitted, if any] | |

## 8. Readiness verdict

ONE of: READY | READY-WITH-DOC-GAPS | NOT-READY | BLOCKED

[One paragraph justification. Cite the most important findings.]

## 9. Prioritized fix backlog

For each finding, severity + description + traceability:

### P0 — blocks setup completion
- [item]
  - **What**: <specific command/diagnostic/doc that needs to change>
  - **Traceability**: <transcript line(s) / raw file references>
  - **Why P0**: <a first-contact user cannot complete setup without this>

### P1 — causes likely user abandonment
[same structure]

### P2 — confusing but recoverable
[same structure]

### P3 — polish / docs
[same structure]

## 10. Non-claims and limits of rehearsal

[Honest list. Examples:
 - "Rehearsal used a fresh clone; a live repo with dirty working tree
   may show additional friction not exercised here."
 - "Rehearsal used the `caws` binary at <path>; users installing via
   `npm install -g @paths.design/caws-cli` directly may see different
   behavior depending on registry version skew."
 - "Rehearsal did not exercise multi-agent scenarios, parallel worktrees,
   CI integration, or recovery from a failed merge."
 - "Rehearsal tested ONE trivial change in P6; richer changes might
   exercise scope-guard, hook permission flows, or test-runner
   integration that this kit does not cover."
 - "Rehearsal was performed by a Claude Code agent, not a human. A
   human user may stop, ask, or improvise differently."
]
```

---

## 5. CAWS doctrine the agent should know up-front

These are non-obvious facts that the kit pre-supplies so you don't have to discover them from CAWS internals. They are NOT permission to skip the rehearsal — quite the opposite, they tell you what to expect so you can identify when the documented behavior diverges from doctrine.

1. **v11.1 ships eleven command groups**: `init doctor status scope claim gates evidence waiver specs worktree`. Plus `agents` (register/heartbeat/stop/list/show/prune) shipped ahead of v11.2 for the lease substrate.

2. **Specs live ONLY at `.caws/specs/<id>.yaml`.** There is no project-level working spec. Spec creation goes through `caws specs create <id> --title "..." --mode <m> --risk-tier <n>` then YAML edit for scope/invariants/acceptance.

3. **Tier 2 specs require contracts.** Tier 3 specs do not. The CLI does not accept `--contract` at create time, so bootstrap tier-3 then amend to tier-2 if needed.

4. **Worktrees are sparse-checkout-by-design.** `.caws/specs/` is intentionally absent from a linked worktree. This is the WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 mechanical guard. Trying to disable sparse-checkout is refused by the `worktree-guard.sh` hook. If you find yourself wanting to `ls .caws/specs/` from inside a worktree, run `caws specs show <id>` instead.

5. **Hook installation requires a session restart.** `caws init --agent-surface claude-code` installs hooks but they don't activate until the Claude Code session is restarted. If you `caws init` inside a Claude Code session, the hooks are present on disk but won't actually fire on your tool calls in this session — that's a property worth noting in P2 evidence.

6. **`caws status` is read-only.** Running it should never mutate `.caws/`.

7. **`caws doctor` exit codes**: 0 = clean, 1 = findings present (NOT failure), 2 = composition failure. A doctor exit 1 is normal and means "look at the findings"; it is NOT a setup blocker.

8. **Worktree merge is one-command lifecycle.** `caws worktree merge <name>` performs: branch merge into base, auto-close bound spec, `git worktree remove`, registry cleanup. Expect a single command to do everything; if it doesn't, that's a finding.

9. **There is no `caws worktree destroy` reachable separately from `merge`** in v11.1.x for the merged case — `merge` does destroy as part of its transaction. The standalone `caws worktree destroy <name>` exists for abandoning unmerged worktrees.

10. **The CAWS host repo's `caws-cli` package is at `11.1.6`.** Global npm `@paths.design/caws-cli` may lag if it hasn't been published recently. Note any skew in P1.

---

## 6. Decision table — small recoveries

Use this only for situations the kit explicitly authorizes. Anything else → HANDOFF.

| Situation | Recovery |
|---|---|
| `caws init` exits 0 but `.caws/` is empty | Re-run with `--agent-surface claude-code`; record both attempts |
| `caws specs create` rejects tier 2 with "contracts required" | Bootstrap at tier 3, record finding |
| `caws specs show` returns "not found" right after `create` | This is a known failure mode; record exact reproduction; continue with `caws specs list` for state |
| Scope guard rejects your P6 edit | Amend the spec's `scope.in` to admit the chosen file; record the original rejection diagnostic |
| `pnpm test` fails for unrelated reasons | Note in transcript; continue (your edit is whitespace, can't break tests) |
| `caws doctor` reports findings | EXPECTED. Record and classify; do NOT try to "fix" them |
| Hook says "session restart required" | Note in transcript; the rehearsal CONTINUES (this is observation, not enforcement-testing) |

---

## 7. HANDOFF protocol

If you hit a situation not covered by §6, stop and emit a HANDOFF block in this format:

```
=== HANDOFF: USER-E2E-SETUP-REHEARSAL-001 ===

Phase: P<n> — <name>
Step within phase: <which command or which decision>
Symptom: <what you observed, verbatim>
Why this is a blocker: <one sentence>
What I tried: <smallest safe attempts, if any>
What I need: <specific question / instruction the maintainer can answer>

Current target repo state:
  cwd: <path>
  HEAD: <sha>
  branch: <branch>
  git status --short:
    <output>
  caws status (if available):
    <output>

Transcript so far: /tmp/fsds-caws-rehearsal/transcript/ (phases P1–P<n-1> complete)

=== END HANDOFF ===
```

Then stop. Do not attempt further phases until the maintainer responds.

**Do NOT** emit a HANDOFF for normal findings (a confusing diagnostic, a rough edge, even a serious problem) as long as you can continue the rehearsal. HANDOFF is for blocked-cannot-proceed cases only.

---

## 8. Other things you might need to gather

If during the rehearsal you encounter any of the following, capture them too — they're valuable beyond the prescribed phases:

- **Network calls**: does `caws` make any outbound network requests during init or any other command? (Run `which strace` / `which dtruss`; if available, optionally trace one command. Skip if not available.)
- **Privilege escalation**: did any command require `sudo`? (It shouldn't.)
- **Implicit assumptions**: did any command silently assume `git`, `node`, `python3`, `bash`, or any other tool was present? Record the version of each.
- **Time-to-first-spec**: rough wall-clock from `caws init` to a working `caws specs show`. (Approximation is fine.)
- **Tool-call interference**: if you're running this rehearsal as a Claude Code agent and CAWS installs Claude-Code hooks at P2, those hooks may start firing on YOUR tool calls partway through the rehearsal. Record the moment any hook fires for the first time during your work, and what it said. This is a real first-contact-agent experience and is worth capturing even though it complicates the rehearsal.
- **Anything that surprised you**: a separate "surprises" section in your transcript is welcome.

---

## 9. Final delivery

At the end of the rehearsal, your output is a HANDOFF block with this shape:

```
=== REHEARSAL COMPLETE: USER-E2E-SETUP-REHEARSAL-001 ===

Status: COMPLETE | PARTIAL (phases <list> done) | BLOCKED at P<n>

Transcript: /tmp/fsds-caws-rehearsal/transcript/  (<count> phase files,
            <count> raw files, total ~<size>)

Final report: [paste the full markdown of the final report here, ALL 10
sections, even if some are short]

Readiness verdict: <one of READY | READY-WITH-DOC-GAPS | NOT-READY | BLOCKED>

Recommended next steps for the CAWS maintainer:
- [actionable items]

Target repo cleanup status:
- [either "fully restored; clone deleted" or "residue: <list>; cleanup recipe: <commands>"]

Time spent: ~<wall-clock>
=== END ===
```

The CAWS maintainer will lift the final report into `<caws-host>/docs/reports/user_e2e_setup_rehearsal_001.md` and commit it under the spec's scope. Your job ends with the HANDOFF.

---

## 10. Scope and authority notes for the remote agent

- You are operating under spec `USER-E2E-SETUP-REHEARSAL-001` from a different repository's perspective. The host CAWS repo's scope-guard cannot reach you; you are not bound by its scope.in/scope.out.
- However, you ARE bound by the kit's behavioral rules (§0) and by the recon-only invariant: no production changes to full-stack-ds, no installer behavior changes to CAWS, no fixes during this slice.
- If you discover something that begs for an immediate fix, **add it to §9 of the final report as a P0/P1 item**. Do not implement it.
