---
doc_id: slice-8c2-closure
authority: closure-record
status: closed
title: Slice 8c.2 — verification + RC dogfood closure
slice: 8c.2
branch: caws-next
updated: 2026-05-16
---

# Slice 8c.2 — verification + RC dogfood closure

**Status:** verification complete. **8d is BLOCKED.**

## Sub-step status

| Step | Status | Evidence |
|---|---|---|
| 8c.2a — packed-tarball install smoke | complete | `/tmp/caws-8c2-sandbox/` has `@paths.design/caws-cli@11.0.0` + `@paths.design/caws-kernel@1.0.0` installed from `paths.design-caws-cli-11.0.0.tgz` + kernel tgz; `node_modules/.bin/caws --version` returns `11.0.0` |
| 8c.2b — temp-repo smoke matrix | complete | 41 steps + b-suffix re-runs in `tmp/8d713213-9fdf-4027-b20f-7e493c83b7ae/dogfood-temp.log` |
| 8c.2c — host RC dogfood (read-only) | complete | `tmp/e1329d66-463f-4fa7-b087-12cf0f71f6e1/dogfood-rc.log` (533 lines, 18 rc-steps). No host event/waiver mutation by design. |
| 8c.2d — classification | complete (this document) | 3 MUST-FIX specs authored; 3 doc-fix items rolled into those specs; 1 intentional v11.0 limitation noted |

## Acceptance scans on the RC dogfood log

Both passed:

```text
=== removed-command guidance scan ===
PASS: no removed-command guidance

=== working-spec.yaml scan ===
PASS: no working-spec.yaml reference
```

These confirm Slice 8c.1's doc-cleanup landed correctly: the packaged v11 binary's help and error surfaces do not instruct users to run any removed v10 command, nor to treat `working-spec.yaml` as active authority.

## Findings classification

### MUST FIX BEFORE 8D

Three blocker specs authored under `.caws/specs/`. 8d cannot honestly proceed until each is implemented, the v11 tarballs are repacked and reinstalled, and the pack → install → temp-repo → host-read-only dogfood loop reruns clean.

| Spec | Title | Source finding |
|---|---|---|
| `CLI-GATES-002` | caws-cli package must resolve and install caws-quality-gates for v11 gates run | 8c.2b step 36: `shell.gates.subprocess_not_found: spawnSync /private/tmp/caws-8c2-tempproj/node_modules/.bin/caws-quality-gates ENOENT`. `@paths.design/caws-cli` does not depend on `@paths.design/quality-gates`. |
| `QG-001` | quality-gates --json must emit contract-valid stdout on the zero-files commit path | 8c.2b step 36b: `shell.gates.subprocess_failed: caws-quality-gates produced no stdout (exit=0)`. `run-quality-gates.mjs:1012-1070` calls `process.exit(0)` before any stdout write in `--json` mode when staged files are empty. |
| `HOST-GOV-001` | Migrate host CAWS repo .caws/ governance state to v11 shape | 8c.2c rc11–rc18: host's own `.caws/policy.yaml`, `.caws/waivers/`, and `.caws/working-spec.schema.json` are in v10 shape; v11 kernel correctly rejects. Self-hosting fails: `caws doctor` returns 8E / 31W findings + 58 load errors, `caws scope show/check` all return exit 2 because policy cannot load, `caws waiver list` emits multiple `waiver.schema.invalid_*` diagnostics. |

The `HOST-GOV-001` spec covers three migration atoms (A1 policy, A2 waivers, A3 schema residue) as one operational change rather than three. This matches the structure of the actual repair: it is one self-hosting migration, not three independent product features.

### DOC FIX BEFORE 8D (rolled into the MUST-FIX specs)

These are not separate blockers — they are documentation surfaces the MUST-FIX implementation slices will touch and update as part of their scope. Tracking them here only so they are not lost.

1. `AGENTS.md` and `docs/agents/full-guide.md` still contain v10-shape spec examples (`risk_tier: T3` string, `change_budget` block, `scope.out` globs, `non_functional.perf` field). Fold replacement into `HOST-GOV-001` migration since it touches the spec authoring guidance.
2. `docs/api/cli.md` waiver section does not document the v11 id regex `/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]?$/`. Valid: `DF-1w`, `FOO-12a`. Invalid: `DF-1-w`, `df-1`. Fold into `HOST-GOV-001` since waiver migration touches the same surface.
3. `docs/api/cli.md` evidence section does not document `--data` JSON shape per type. Fold into `CLI-GATES-002` since the gates-run fix loop will exercise evidence appends end-to-end.

### DEFERRED TO v11.1 (no new spec)

`rc17 caws claim` exited 2 with: *"cwd is not inside a CAWS-tracked worktree. v11.0.0 does not ship worktree lifecycle commands; create the worktree externally (git worktree add) and register it via a future `caws worktree` command (planned for v11.1)."*

This matches the A1 doctrine in `docs/architecture/caws-vnext-command-surface.md` §1: v11.0.0 is the governed core, not the full lifecycle CLI. No new blocker spec is created in 8c.2. The future v11.1 lifecycle work should cover worktree create/bind/claim registration as a separate lifecycle tranche; do not pre-author the spec here.

## Out of scope for this slice

- No `caws gates run` or `caws evidence record` was executed against the host repo. Mutating the host's append-only `.caws/events.jsonl` hash chain offered no additional diagnostic value beyond the tempproj evidence already captured in 8c.2b.
- No `caws waiver create/revoke` was executed against the host repo. Same rationale.
- No code changes to `caws-cli` or `quality-gates` in this slice. The two binary bugs land in their own implementation slices keyed to `CLI-GATES-002` and `QG-001`.
- No code changes to host `.caws/` governance state in this slice. The migration lands in its own slice keyed to `HOST-GOV-001`.

## 8d gate

8d (the `caws-next` → `main` cutover) is BLOCKED until:

1. ✅ **`CLI-GATES-002` IMPLEMENTED** (`4535c33`); `@paths.design/quality-gates` is a runtime dependency of `@paths.design/caws-cli`; fresh install of the repacked tarball produces `node_modules/.bin/caws-quality-gates`.
2. ✅ **`QG-001` IMPLEMENTED** (`b75a731`); fixes the `--json` mode silent-stdout on zero-files commit path PLUS a separately-discovered Bug Y where the entry guard `argv[1].endsWith('run-quality-gates.mjs')` silently failed for `.bin` shim invocation, leaving `main()` uncalled. End-to-end `caws gates run --spec DF-1` against `/tmp/caws-8c2-tempproj` now exits 0 with 5 `gate_evaluated` events appended.
3. ✅ **`HOST-GOV-001` IMPLEMENTED** (`847ade7`); host CAWS repo's `.caws/policy.yaml`, `.caws/waivers/`, and legacy `.caws/working-spec.schema.json` migrated to v11 shape. Host `caws doctor` findings now `0E / 3W / 0I` (was `8E / 31W / 0I`) — zero governance-shape errors. (Standalone `caws doctor` still exits 1 due to 54 load errors from out-of-scope v10-shape spec files in `.caws/specs/`; a follow-up `HOST-GOV-002`-style spec is needed to migrate those, but they are spec-shape drift, not governance-shape, and do not block 8d under HOST-GOV-001's acceptance.)
4. ⏳ The full 8c.2 dogfood loop (pack → install → tempproj smoke → host read-only smoke) is rerun against the migrated host as the final RC, with the publish-order requirement below satisfied.

The acceptance scan thresholds for the rerun are the same as those passed in this slice: removed-command guidance scan must return `PASS`, `working-spec.yaml` scan must return `PASS`, and additionally `caws doctor` on the host must show `0E` in the *findings* section (load errors from out-of-scope spec drift may persist until `HOST-GOV-002` lands).

### Publish order (required for 8d release)

`@paths.design/caws-cli@11.0.0` now declares a runtime dependency on `@paths.design/quality-gates@^2.0.0`. The npm registry currently has only `@paths.design/quality-gates@1.0.4` as `latest`. Publishing caws-cli before quality-gates@2.0.0 would break every consumer install with `ERESOLVE` / "no matching version" on the dep.

**Publish order for the v11 release:**

1. `@paths.design/caws-kernel@1.0.0` — base layer, no external dep on the others.
2. `@paths.design/quality-gates@2.0.0` — contains the QG-001 stdout-emit fix and the Bug Y entry-guard fix. Must be on the registry before caws-cli is published.
3. `@paths.design/caws-cli@11.0.0` — depends on `quality-gates@^2.0.0`; once that is live on the registry, this becomes installable.

Local sandbox install (`/tmp/caws-8c2-sandbox/`) currently uses tarball file paths and resolves correctly. The publish-order issue only surfaces for real registry consumers.

This requirement does NOT change the 8d gate items above; it is a release sequencing constraint that the cutover ceremony must honor.
