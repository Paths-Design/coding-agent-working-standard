---
doc_id: slice-8c3-closure
authority: closure-record
status: closed
title: Slice 8c.3 — final RC verification closure
slice: 8c.3
branch: caws-next
updated: 2026-05-16
---

# Slice 8c.3 — final RC verification closure

**Status:** verification complete. **8d is READY for ceremony** (publish + tag + merge), subject to the publish-order checklist below.

## Context

Slice 8c.2 closed with three MUST-FIX-BEFORE-8D specs (CLI-GATES-002, QG-001, HOST-GOV-001), all of which landed in their own commits on `caws-next`. 8c.3 is the pure-verification slice that proves the v11.0.0 release boundary is intact end-to-end. It is not a remediation slice — but the first attempt surfaced a fourth real bug (`CLI-GATES-003`) that the prior tests had not exercised, and that bug had to be fixed before 8c.3 could close. The fix landed in a single commit (`27ff6d5`) and the verification was re-run from scratch.

## Six acceptance gates

### Gate 1 — fresh tarballs rebuilt from HEAD

**Status:** ✅ PASS

After `27ff6d5` (HEAD as of 8c.3 closure), rebuilt all three tarballs from a clean `npm pack`:

| Tarball | Version | Size |
|---|---|---|
| `paths.design-caws-kernel-1.0.0.tgz` | 1.0.0 | 118065 B |
| `paths.design-quality-gates-2.0.0.tgz` | 2.0.0 | 112062 B |
| `paths.design-caws-cli-11.0.0.tgz` | 11.0.0 | 120311 B |

Evidence: `tmp/<session>/8c3-final-rc.log` gate-1 section.

### Gate 2 — fresh install proof outside workspace

**Status:** ✅ PASS

```text
rm -rf /tmp/caws-8c2-sandbox
mkdir -p /tmp/caws-8c2-sandbox && cd /tmp/caws-8c2-sandbox
npm init -y
npm install <kernel.tgz> <quality-gates.tgz> <caws-cli.tgz>
```

After install:

- `node_modules/.bin/caws → ../@paths.design/caws-cli/dist/index.js` ✓
- `node_modules/.bin/caws-quality-gates → ../@paths.design/quality-gates/run-quality-gates.mjs` ✓
- All three `@paths.design/*` packages are **real directories**, not workspace symlinks (proves the install actually unpacked the tarball without reaching back into the repo).
- `caws --version` → `11.0.0`
- `caws --help` → shows exactly the 8 v11 command groups (init, doctor, scope, status, claim, gates, evidence, waiver) plus Commander's built-in `help`. No removed v10 commands leaked.

### Gate 3 — temp-project smoke

**Status:** ✅ PASS (after CLI-GATES-003 fix landed)

**First attempt: FAILED.** Initial 8c.3 run discovered that `caws gates run --spec DF-1` in `/tmp/caws-8c2-tempproj` returned `shell.gates.subprocess_not_found: spawnSync ENOENT` even though `caws-quality-gates` did exist in the sandbox's `node_modules/.bin/`. Root cause: the adapter's `defaultRunner` resolved the subprocess only from `<input.cwd>/node_modules/.bin/`, which is empty when the consumer project has no local install. This was a fourth distinct v11 bug, structurally separate from CLI-GATES-002 (which fixed the dep declaration but not the lookup path).

**Resolution: CLI-GATES-003 (`27ff6d5`).** New pure resolver `resolveQualityGatesBin(cliDir, projectCwd, fsCheck?)` walks up from each starting point and picks the first hit; CLI-install-local wins by design. `defaultRunner` uses it with `__dirname` and `input.cwd`. Spawn cwd remains `input.cwd` (A3 invariant preserved). 6/6 unit tests, 32/32 existing gates-command tests still pass.

**Rerun evidence** (`tmp/<session>/8c3-final-rc-rerun.log`):

```text
$ caws gates run --spec DF-1     # in /tmp/caws-8c2-tempproj, using sandbox binary
Gate dispositions (policy-derived):
  PASS     budget_limit (mode=block, 0 violations)
  PASS     spec_completeness (mode=block, 0 violations)
  PASS     scope_boundary (mode=block, 0 violations)
  PASS     god_object (mode=warn, 0 violations)
  PASS     todo_detection (mode=warn, 0 violations)
Overall: OK
-- exit=0

events.jsonl line count: 1 → 6 (5 new gate_evaluated events)
hash chain integrity: PASS across 6 events
events: test_recorded(seq=1), gate_evaluated(seq=2..6)
```

All gate-3 acceptance criteria satisfied: init, doctor, status, evidence record, and gates run all green. Hash chain remains valid after appends.

### Gate 4 — host read-only dogfood

**Status:** ✅ PASS (within governance scope)

Against `/Users/darianrosebrook/Desktop/Projects/caws` using the sandbox binary:

| Command | Standalone exit | Gate criterion | Outcome |
|---|---|---|---|
| `caws status` | 0 | shows `policy: loaded`, not MISSING | ✅ |
| `caws doctor` | 1 | findings section 0E for governance-shape | ✅ findings `0E / 7W / 0I` — zero governance-shape ERRORs. Exit 1 is from 54 load errors that are explicitly out of HOST-GOV-001 scope (see Known non-blockers below). |
| `caws scope show <path>` | 0 | no longer exits 2 from policy load | ✅ (was exit 2 pre-HOST-GOV-001) |
| `caws waiver list --include-revoked` | 0 | clean output, no malformed diagnostics | ✅ — 2 revoked waivers (WV-0001, WV-0002), zero `waiver.schema.*` errors |
| `.caws/events.jsonl` line count | 51 → 51 | unchanged before/after | ✅ (gate 5 invariant: no host event appends during read-only dogfood) |

The seven WARN findings are: 5 unbound-active specs (CLI-GATES-002, CLI-GATES-003, HOOK-SAFETY-001, HOST-GOV-001, QG-001) — every spec authored or migrated in 8c.2/8c.3 trips this WARN because v11.0 does not ship `caws worktree bind`. This is the intentional v11.0 lifecycle gap deferred to v11.1. The other 2 WARNs are `doctor.agent.stale_display_only` (display-only, non-blocking by design).

### Gate 5 — release order checklist

**Status:** ✅ DOCUMENTED (executed at 8d release ceremony)

`@paths.design/caws-cli@11.0.0` declares `@paths.design/quality-gates@^2.0.0` as a runtime dependency (per CLI-GATES-002). The npm registry currently has only `quality-gates@1.0.4` published. Publishing `caws-cli@11.0.0` before `quality-gates@2.0.0` would break every real consumer install with `ERESOLVE`. **Required publish order:**

```text
1. @paths.design/caws-kernel@1.0.0
   (base layer; no external dep on the others)

2. @paths.design/quality-gates@2.0.0
   (carries QG-001 fix for --json zero-files stdout
    AND the .bin-shim entry-guard fix from QG-001 Bug Y;
    must reach the registry BEFORE caws-cli is published)

3. @paths.design/caws-cli@11.0.0
   (depends on quality-gates@^2.0.0 + caws-kernel@^1.0.0;
    becomes installable once the registry has them)
```

The local sandbox at `/tmp/caws-8c2-sandbox/` works around this because npm resolves dependencies by tarball file path during the test install. Real consumer installs from the npm registry will not.

### Gate 6 — known non-blockers documented

**Status:** ✅ DOCUMENTED

The following items surfaced during 8c.2/8c.3 verification, are real, and are explicitly **not** 8d blockers per the established release bar. They flow into v11.0.x patch / v11.1 lifecycle work.

#### Deferred to v11.1 (lifecycle re-introduction)

- **`rc17 caws claim` / scope unbound**: `caws claim` returns exit 2 with "cwd is not inside a CAWS-tracked worktree"; `caws scope check` returns "NO AUTHORITY scope.no_authority.unbound" with exit 1 when no spec is bound to the cwd's worktree. This is the documented A1 posture in `docs/architecture/caws-vnext-command-surface.md` §1 — v11.0.0 deliberately ships the governed core without the worktree lifecycle CLI (`caws worktree bind`, `caws worktree create`, etc.). v11.1 will reintroduce these. No new blocker spec authored in 8c.2 or 8c.3.

#### Deferred to a follow-up `HOST-GOV-002` style spec (host self-hosting completion)

- **54 spec-load errors in host `.caws/specs/`**: standalone `caws doctor` on the host repo returns exit 1 because the older spec files (CLI-CLAIM-001, CLI-STATUS-001, CLI-GATES-001, CLI-WAIVER-001, OPS-001) remain in v10 spec shape. This is **spec-shape drift**, not governance-shape drift — explicitly outside HOST-GOV-001's `scope.in` (`.caws/policy.yaml`, `.caws/waivers/`, `.caws/working-spec.schema.json`). A `HOST-GOV-002`-style spec covering the spec corpus migration is the right home for this work. It can ship in v11.0.x or later without blocking 8d, because:
  - The findings section (governance-shape) is 0E per HOST-GOV-001's acceptance bar.
  - `caws status`'s embedded doctor view shows the same `0E / 7W / 0I`.
  - The 54 load errors do not affect what 8d cares about (the cutover from `caws-next` to `main` and the v11 release ceremony).

If the release bar is revised to require standalone `caws doctor` exit 0 on the host, then `HOST-GOV-002` becomes a blocker and 8d is paused.

## 8d gate status

8d (the `caws-next` → `main` cutover) is **READY for ceremony**. All v11 release gating items closed:

- ✅ Gates 1–6 above all PASS.
- ✅ CLI-GATES-002 (`4535c33`) — dep declaration, packaging test.
- ✅ QG-001 (`b75a731`) — stdout JSON emit + bin-shim entry guard.
- ✅ HOST-GOV-001 (`847ade7`) — host governance state migrated to v11 shape.
- ✅ CLI-GATES-003 (`27ff6d5`) — subprocess resolution covers global/sandboxed installs.

8d ceremony (per user direction):

```bash
git tag pre-v11-cutover caws-next
git push origin pre-v11-cutover

git checkout main
git pull origin main
git merge --no-ff caws-next

git tag v11.0.0
git push origin main
git push origin v11.0.0
```

Publish in the order documented under Gate 5. After registry publish, do one final smoke from `npm install -g @paths.design/caws-cli@11.0.0` to confirm the published artifacts resolve identically to the sandboxed tarball install.
