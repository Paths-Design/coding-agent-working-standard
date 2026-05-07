# Corpus Index

**Status:** delivered 2026-05-07
**Tag pin:** archaeology source-of-truth is `caws-legacy-corpus` → `21e7f9a` (chore(release): @paths.design/caws-cli@10.2.0)
**Purpose:** preserve the pathological state of the legacy CAWS implementation as evidence input to the vNext rewrite. The legacy code's value is in the operating semantics it discovered under real agent pressure; this corpus captures the artifacts that demonstrate those semantics, including the contradictions vNext will resolve.

This is **not** a backup. The `caws-legacy-corpus` git tag preserves complete history. The corpus is curated — every file here exists because it answers a question the rewrite will need to answer, or proves a rule the rewrite must enforce.

---

## Layout

```
docs/rewrite/corpus/
├── 00-corpus-index.md          # this file
├── negative-fixtures/          # specs the new schema MUST reject
├── policy/                     # live policy.yaml + live working-spec (drift evidence)
├── hooks/                      # current and template hook surfaces
├── events/                     # events.jsonl chain sample
└── gate-outputs/               # quality-gates JSON (one captured, two pending)
```

---

## negative-fixtures/ — 13 files

Specs that violate at least one rule in the vNext strict schema. These become the test corpus for `caws doctor`'s schema-violation detection. See `docs/rewrite/investigations/04-template-drift.md` for the full violation table.

| File | Violations captured | Why it matters |
|------|--------------------|-----------------|
| `CAWSFIX-14.yaml` | YAML parse failure (backtick in flow scalar) + `change_budget` + `mode: development` | Tests `doctor` graceful handling of unparseable YAML, not crash |
| `CAWSFIX-15.yaml` | YAML parse failure (mapping values disallowed) + `change_budget` + `mode: development` | Second parse-failure mode — different error class |
| `CAWSFIX-02.yaml` | `mode: development` + `acceptance_criteria: *ref_0` anchor alias + missing `scope:` block | Earliest-generation spec; demonstrates three simultaneous violations |
| `CAWSFIX-05.yaml` | `mode: development` + alias + spec text describes `change_budget` as PR violation | Spec that documents the contradiction it embodies |
| `CAWSFIX-07.yaml` | `mode: development` + prose references to `acceptance_criteria` shape compatibility | Captures the "old alias promise" that vNext is reversing |
| `CAWSFIX-09.yaml` | `mode: development` + spec explicitly documenting alias as intentional | A record of a decision being reversed in vNext |
| `CAWSFIX-26.yaml` | `mode: development` + `change_budget` + documents `non_governed_zones` semantics | Captures the `non_governed_zones` rule's introduction context |
| `CAWSFIX-32.yaml` | `mode: development` + `acceptance_criteria:` block with structured items | Exercises alias-with-body, not just empty-array form |
| `ACVERIFY-001.yaml` | `mode: development` + both `acceptance:` AND `acceptance_criteria:` simultaneously | Dual-key failure mode |
| `EVLOG-001.yaml` | `mode: development` + `acceptance_criteria: *ref_0` | The `*ref_0` YAML anchor alias artifact from `yaml.dump` round-trip |
| `cli-test-feature.yaml` | `risk_tier: T3` (unknown enum) + `mode: development` + `acceptance_criteria: []` | Three violations in 9 lines — concise multi-violation fixture |
| `cli-ACVERIFY-001.yaml` | `mode: development` + dual alias fields | Sub-package variant of ACVERIFY case |
| `dx-improvements-working-spec.yaml` | Live spec: `change_budget:` alongside `mode: feature` | Forbidden field is not mode-gated; in-flight contradiction in live repo |

**Slice support:** Slice 5a thin doctor uses these to verify each rejection rule fires; Slice 1 schema validators use them as negative test inputs.

---

## policy/ — 2 files

Captures of the live policy and live working-spec at the time of rewrite. These are **drift evidence**, not negative fixtures — they show how the live repo deviates from its own schemas.

| File | What it captures |
|------|------------------|
| `policy.yaml.live` | Live `.caws/policy.yaml` with `label: "Critical"`/`"Standard"`/`"Low Risk"` on tier objects — fields the live policy schema's `additionalProperties: false` forbids. Demonstrates that the live policy fails its own schema right now. |
| `working-spec.yaml.live` | Live `.caws/working-spec.yaml` (EVLOG-001) — used by current CAWS as project baseline. Shows root-level `.gitignore` correctly listed in `scope.in` but uses `mode: development`. |

**Slice support:** Slice 7 doctor schema-template drift check uses these to verify drift detection; Slice 1 policy validator uses `policy.yaml.live` as a "what NOT to ship as default" reference.

---

## hooks/ — 24 files

Captures of the live hook surface and template hooks per `01-hooks.md`'s capture roster. These preserve hook behavior that must be replicated, replaced fail-closed, or explicitly dropped in vNext.

| File | Disposition for vNext | Why captured |
|------|----------------------|--------------|
| `live-scope-guard.sh` | REPLACE (fail-closed) | Progressive-strike model is fail-open at strikes 1–2; logic captured to compare against new fail-closed implementation |
| `live-worktree-write-guard.sh` | REPLACE (fail-closed) | Live version has spec-contention check that template lacks; warns on check-failure rather than refusing |
| `live-plan-transcript-snapshot.sh` | CAPTURE | Organic session-tooling; not in template; preserved for reference |
| `live-plan-transcript-finalize.sh` | CAPTURE | Same — paired with snapshot |
| `git-pre-commit` | CAPTURE + REPLACE | Bespoke monorepo logic (turbo, eslint) mixed with CAWS guards; vNext separates these concerns |
| `git-post-commit` | DROP | Calls `caws provenance update`; provenance is dropped in vNext entirely |
| `git-commit-msg` | KEEP_AS_IS | Worktree merge message format enforcement is correct and stable |
| `template-orphan-lite-sprawl-check.sh` | CAPTURE | Template-only feature with no live counterpart — orphaned |
| `template-orphan-simplification-guard.sh` | CAPTURE | Same — template-only orphan |
| `template-cursor/*` (10 files) | CAPTURE | Cursor integration deferred for vNext; full template captured |

**Slice support:** Slice 5b hook integration uses captures as behavioral specifications for new fail-closed implementations; the `git-post-commit` capture is a "do not reintroduce" reference.

---

## events/ — 2 files

| File | What it captures |
|------|------------------|
| `events-sample-head.jsonl` | First 50 events from live `.caws/events.jsonl` — chain-verifiable starting events including `spec_created`, `validation_completed`, etc. |
| `events-total-lines.txt` | Line count of the full live log — context for the sample size |

**Slice support:** Slice 3 evidence kernel ports `canonicalJson`, `computeEventHash`, `verifyChain` verbatim from `event-log.js`; this sample provides chain-verification regression input. Slice 5a doctor uses `verifyChain` against the sample to confirm the algorithm survives the port.

---

## gate-outputs/ — 1 file + 2 placeholders

| File | Status |
|------|--------|
| `fail.json` | Real captured output — proves 366 files detected as out-of-scope under union mode (which is being eliminated) |
| `pass.json.placeholder` | PENDING — Inv 2 needs reopening to capture |
| `warn.json.placeholder` | PENDING — Inv 2 needs reopening to capture |

**Slice support:** Slice 6 gates contract test uses these to define `gate-result.v1.json` schema. Until Inv 2 is reopened and the placeholders are replaced, `gate-result.v1.json` cannot be authored against real data.

---

## What is intentionally NOT in the corpus

- **Closed CAWSFIX specs that pass (or near-pass) the new schema** — those exist in git history under the `caws-legacy-corpus` tag; no need to duplicate to corpus
- **node_modules, build artifacts, lockfiles** — not material to governance semantics
- **Cursor IDE integration code** beyond hook templates — Cursor support is deferred; full code lives in git history
- **Provenance system files** (`.caws/provenance/chain.json`, `commands/provenance.js`) — entirely dropped in vNext; preserved by git tag

---

## Verification

The corpus is functionally complete when:

1. Every file in `negative-fixtures/` would fail `caws spec validate` under the vNext strict schema for a documented reason.
2. Every file in `hooks/` corresponds to a row in `01-hooks.md`'s "Implications for Slice 0b corpus capture" list.
3. Every file in this index has a "Slice support" sentence explaining which future slice consumes it.
4. The full `caws-legacy-corpus` tag exists at `21e7f9a` and is annotated.
5. No corpus file mixes harness reconfiguration changes (those were stashed separately as `harness-disable-for-caws-next`).
6. The `gate-outputs/` placeholders are clearly marked PENDING and Inv 2 is in `pending` status in the task tracker.

---

## Open follow-ups (post-Slice-0)

- **Inv 2** (Capture quality-gates outputs): real `pass.json` and `warn.json` need to replace the placeholders before Slice 6.
- **Inv 3** (Distill status.js derivations): produces `03-status-derivation.md`; gates Slice 6 status command.
- **Inv 5** (Verify workspace boundaries): produces `05-workspace.md`; gates package restructuring before Slice 1.
- **Note from this session:** the live `.caws/policy.yaml` lacks `non_governed_zones` and `root_passthrough` entirely. The vNext seed policy must initialize both, even if empty arrays.
