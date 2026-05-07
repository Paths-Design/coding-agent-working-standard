# Investigation 04: Template/Doc/Schema Drift Audit

**Status:** delivered 2026-05-07
**Blocks:** Slice 0b (corpus capture — negative fixture roster)
**Source:** Explore agent grep + read of `.caws/`, `packages/caws-cli/templates/`, `docs/`, root markdown

vNext strict schema rejects:
1. `change_budget` anywhere in a spec (policy-derived)
2. `acceptance_criteria` (alias removed; canonical key is `acceptance`)
3. `mode: development` (replaced by `feature | refactor | fix | doc | chore`)
4. `scope.include` / `scope.exclude` (canonical: `scope.in` / `scope.out`)
5. Unknown top-level fields (schema becomes `additionalProperties: false`)
6. Root-level files admitted without explicit `scope.in` listing or `policy.root_passthrough`
7. `policy.label` field on tier objects (not in schema)
8. Dangerously broad `non_governed_zones` patterns without explicit `non_governed_zones_force: true`

---

## Summary

### Violation counts by type

- **`change_budget` anywhere in a spec** — 20 YAML spec files (15 archive + 2 working/active + 3 test JS fixtures + 8 doc code blocks). The live `.caws/dx-improvements-working-spec.yaml` is the most egregious active instance. `docs/api/schema.md` declares `change_budget` as a *required* field — direct contradiction. The old template schema blocks it via `"not": {"required":["change_budget"]}` but still emits it as a first-class property; template `CLAUDE.md:135` retains an advisory note treating it as informational.
- **`acceptance_criteria` (alias)** — 28 YAML files (archive + 2 live sub-package specs) + 5 JS test files + 1 docs API reference. Most archive specs carry `acceptance_criteria: *ref_0` — a YAML anchor collision from the old serializer writing both `acceptance:` and `acceptance_criteria:` with identical content.
- **`mode: development`** — 40 YAML files (38 archive + 2 live sub-package specs).
- **`scope.include` / `scope.exclude`** — 0 YAML spec files use these; however `packages/caws-cli/src/commands/scope.js:113-114` falls back to them at runtime. Cursor rule `11-scope-management-waivers.mdc:32` embeds `blast_radius` nested under `scope` (unknown structure).
- **`additionalProperties: false` missing** — old template schema `working-spec.schema.json` declares `"additionalProperties": true` at root and on every sub-object.
- **`policy.label` on tier objects** — `.caws/policy.yaml:12,16,20` carries `label: "Critical"`/`"Standard"`/`"Low Risk"`. Both live and template `policy.schema.json` declare tier objects with `additionalProperties: false` allowing only `max_files`/`max_loc`/`description`. The live `policy.yaml` fails its own schema right now.
- **Dangerously broad `non_governed_zones`** — No entries in any live `policy.yaml`; feature schema-defined but unused. No violations of rule 8, but `non_governed_zones_force` support is entirely absent from both old schemas.
- **Root-level files without explicit listing** — EVLOG-001 (live working-spec) lists `.gitignore` correctly. Many archived specs include `README.md`, `CHANGELOG.md`, `package.json` without explicit listing. `docs/rewrite/corpus/gate-outputs/fail.json` proves 366 files are currently detected as out-of-scope.

### Most instructive examples for negative fixtures

1. **`.caws/specs/.archive/CAWSFIX-02.yaml`** — `mode: development` (line 4), `acceptance_criteria: *ref_0` (line 75), AND no `scope:` block. Three violations cleanly.
2. **`.caws/dx-improvements-working-spec.yaml`** — Live spec with `change_budget:` (lines 5–7) despite same repo's `agent-operating-spec.yaml` forbidding it.
3. **`docs/api/schema.md` (lines 13–311)** — Embedded JSON schema lists `change_budget` as *required*, uses `additionalProperties: false` (which would make `change_budget` irremovable), omits `development` from `mode` enum.
4. **`packages/caws-cli/.caws/specs/test-feature.yaml`** — Live non-archived: `mode: development`, `acceptance_criteria: []`, `risk_tier: T3` (string with T-prefix). Three violations in nine lines.
5. **`.caws/specs/.archive/CAWSFIX-09.yaml`** — Spec whose acceptance criteria *explicitly document* that `acceptance_criteria` is a valid alias to support. Now a record of a decision being reversed.

---

## Violation Table

(See full agent report; abridged here to the most material rows. Complete list in commit history.)

| File | Line/anchor | Violation | Failing field/value | Disposition |
|------|-------------|-----------|---------------------|-------------|
| `.caws/working-spec.yaml` | 6 | mode: development | `mode: development` | NEGATIVE_FIXTURE |
| `.caws/dx-improvements-working-spec.yaml` | 5–7 | change_budget anywhere | `change_budget: {max_files:40, max_loc:2500}` | NEGATIVE_FIXTURE |
| `.caws/policy.yaml` | 12, 16, 20 | policy.label on tier | `label: "Critical"`/`"Standard"`/`"Low Risk"` | UPDATE_VNEXT |
| `.caws/specs/.archive/CAWSFIX-02.yaml` | 4, 75 | mode: development + acceptance_criteria alias | `mode: development`, `acceptance_criteria: *ref_0` | NEGATIVE_FIXTURE |
| `.caws/specs/.archive/CAWSFIX-09.yaml` | 6, 32–91 | mode: development + alias documented as feature | `mode: development`, multiple `acceptance_criteria` refs | NEGATIVE_FIXTURE |
| `.caws/specs/.archive/CAWSFIX-14.yaml` | 6, 14, 43 | mode + change_budget + YAML parse failure | `mode: development`, `change_budget:`, backtick character | NEGATIVE_FIXTURE |
| `.caws/specs/.archive/CAWSFIX-15.yaml` | 6, 14, 46 | mode + change_budget + YAML parse failure | `mode: development`, `change_budget:`, mapping values disallowed | NEGATIVE_FIXTURE |
| `.caws/specs/.archive/CAWSFIX-26.yaml` | 6, 15 | mode + change_budget + non_governed_zones doc | `mode: development`, `change_budget:` | NEGATIVE_FIXTURE |
| `.caws/specs/.archive/CAWSFIX-32.yaml` | 8, 77 | mode + acceptance_criteria block with body | `mode: development`, `acceptance_criteria:` block | NEGATIVE_FIXTURE |
| `.caws/specs/.archive/ACVERIFY-001.yaml` | 6, 25–27 | both `acceptance:` and `acceptance_criteria:` simultaneously | `mode: development`, dual alias fields | NEGATIVE_FIXTURE |
| `.caws/specs/.archive/EVLOG-001.yaml` | 4, 82 | mode + acceptance_criteria alias | `mode: development`, `acceptance_criteria: *ref_0` | DELETE (post-capture) |
| `packages/caws-cli/.caws/specs/test-feature.yaml` | 5, 6, 9 | risk_tier:T3 + mode:development + acceptance_criteria:[] | three violations in 9 lines | NEGATIVE_FIXTURE |
| `packages/caws-cli/.caws/specs/ACVERIFY-001.yaml` | 6, 24 | mode + dual alias fields | `mode: development`, `acceptance: []` + `acceptance_criteria: []` | NEGATIVE_FIXTURE |
| `packages/caws-cli/templates/.caws/schemas/working-spec.schema.json` | 83–95 | mode enum permits `development` | `"development"` in mode enum | UPDATE_VNEXT |
| `packages/caws-cli/templates/.caws/schemas/working-spec.schema.json` | 339 | additionalProperties: true | `"additionalProperties": true` (root) | UPDATE_VNEXT |
| `packages/caws-cli/templates/.caws/schemas/working-spec.schema.json` | 19–22 | change_budget property defined | `"not": {"required":["change_budget"]}` + property still defined | UPDATE_VNEXT |
| `packages/caws-cli/templates/.caws/schemas/policy.schema.json` | 42 | label absent from allowed properties | tier `additionalProperties: false` — `label` silently violates | UPDATE_VNEXT |
| `docs/api/schema.md` | 23, 55–71, 310, 323–326 | change_budget as required + property + interface | full schema declares `change_budget` mandatory | UPDATE_VNEXT |
| `docs/agents/examples.md` | 19, 109, 194, 305, 386, 469, 536, 605 | change_budget in 8 spec examples | `change_budget: {max_files:..., max_loc:...}` | UPDATE_VNEXT |
| `docs/agents/examples.md` | 63, 89, 92 | unknown contract type + unknown ai_assessment fields | `vscode-api`, `complexity_factors`, `risk_factors` | UPDATE_VNEXT |
| `docs/agents/tutorial.md` | 59–61 | change_budget in code example | `change_budget: {max_files:8, max_loc:200}` | UPDATE_VNEXT |
| `docs/agents/full-guide.md` | 82–84, 679–681 | change_budget in code example + troubleshooting | two occurrences | UPDATE_VNEXT |
| `docs/guides/agent-integration-guide.md` | 178 | acceptance_criteria in JSON shape | `"acceptance_criteria": number` | UPDATE_VNEXT |
| `docs/guides/waiver-troubleshooting.md` | 172–184, 264 | change_budget troubleshooting + comment | entire Issue 5 section | UPDATE_VNEXT |
| `AGENTS.md` | 492–494 | change_budget in code block | `change_budget: {max_files:25, max_loc:1000}` | UPDATE_VNEXT |
| `packages/caws-cli/README.md` | 243–245 | change_budget in spec example | `change_budget: {max_files:25, max_loc:1000}` | UPDATE_VNEXT |
| `packages/caws-cli/templates/CLAUDE.md` | 135 | change_budget advisory note | "informational, not enforced" | UPDATE_VNEXT |
| `packages/caws-cli/templates/.github/copilot-instructions.md` | 21–22, 49 | change_budget in spec + rule text | `change_budget: {...}` + rule reference | UPDATE_VNEXT |
| `packages/caws-cli/templates/.cursor/rules/11-scope-management-waivers.mdc` | 19–23, 308–312, 32–36, 314 | change_budget + nested blast_radius + risk_tier:'T2' | multiple violations | UPDATE_VNEXT |
| `packages/caws-cli/src/commands/scope.js` | 113–114 | scope.include/scope.exclude fallback | runtime alias support | UPDATE_VNEXT (delete in rewrite) |
| `packages/quality-gates/todo-analyzer.mjs` | 783, 815, 857 | acceptance_criteria in gate logic | `missing.push('acceptance_criteria')` | UPDATE_VNEXT |
| `packages/caws-cli/tests/index.test.js` | 406, 742 | change_budget in test fixture | template literals | UPDATE_VNEXT |
| `packages/caws-cli/tests/tools.test.js` | 210 | change_budget in test fixture | `change_budget: {…}` | UPDATE_VNEXT |
| `packages/caws-cli/tests/contract/cli-contract.test.js` | 136 | change_budget in test fixture | `change_budget: {max_files:25, max_loc:1000}` | UPDATE_VNEXT |
| `packages/caws-cli/tests/commands/evaluate.test.js` | 44 | change_budget in test fixture | `change_budget: {max_files:20, max_loc:500}` | UPDATE_VNEXT |
| `packages/caws-cli/tests/specs-archive*.test.js` | 34, 44 | mode:development in test fixture | YAML strings | UPDATE_VNEXT |
| `packages/caws-cli/tests/specs-close-diff.test.js` | 51, 117 | mode:development in test fixture | YAML strings | UPDATE_VNEXT |
| `packages/caws-cli/tests/worktree-auto-*.test.js` | 28, 29 | mode:development in test fixture | template strings | UPDATE_VNEXT |
| `packages/caws-cli/tests/agent-claim-wiring.test.js` | 72 | mode:development in test fixture | YAML string | UPDATE_VNEXT |
| `packages/caws-cli/tests/multi-spec-integration.test.js` | 123, 379, 407 | acceptance_criteria in state object | object literal | UPDATE_VNEXT |
| `packages/caws-cli/tests/verify-acs.test.js` | 12–215 | acceptance_criteria alias tests | entire suite testing the alias | NEGATIVE_FIXTURE |
| `packages/caws-cli/tests/validation/acceptance-criteria-alias.test.js` | 16–92 | alias support tests | spec fixture + alias support assertions | NEGATIVE_FIXTURE |

(Archive specs CAWSFIX-04, 06, 08, 10, 11, 13, 16, 17, 18, 20, 22, 23, 24, 25, 27, 28, 29, 30, 31, EVLOG-001, EVLOG-002, GUARD-001, payment-system, user-auth*, test-conflict*, conflicting-feature, dashboard, user, test-build, demo-feature — all carry `mode: development` and most carry `change_budget` and/or `acceptance_criteria`. Disposition: DELETE on `caws-next`. The `caws-legacy-corpus` tag preserves them for archaeology.)

---

## YAML Parse Failures (Separate Documentation)

| File | Error | Notes |
|------|-------|-------|
| `.caws/specs/.archive/CAWSFIX-14.yaml:43` | `found character '\`' that cannot start any token` | Backtick in YAML flow scalar — likely unquoted shell command in acceptance criteria |
| `.caws/specs/.archive/CAWSFIX-15.yaml:46` | `mapping values are not allowed here` | Colon inside an unquoted string at column 36 — likely a URL or code snippet in a block value without quoting |

Both also carry `change_budget:` (line 14) and `mode: development` (line 6). Cannot be loaded by any YAML parser; copy verbatim to negative fixture corpus to prove `doctor` handles parse failures gracefully with a clear error message rather than a crash.

---

## Negative Fixture Roster

12 files to copy verbatim to `docs/rewrite/corpus/negative-fixtures/`. Each exercises at least one rejection rule from the vNext strict schema.

| # | Source path | Primary violation(s) captured |
|---|-------------|-------------------------------|
| 1 | `.caws/specs/.archive/CAWSFIX-14.yaml` | YAML-parse failure (backtick) + `change_budget` + `mode: development` |
| 2 | `.caws/specs/.archive/CAWSFIX-15.yaml` | YAML-parse failure (bare colon) + `change_budget` + `mode: development` |
| 3 | `.caws/specs/.archive/CAWSFIX-02.yaml` | `mode: development` + `acceptance_criteria: *ref_0` anchor alias + no `scope:` block |
| 4 | `.caws/specs/.archive/CAWSFIX-09.yaml` | `mode: development` + spec that explicitly documents the alias as intentional |
| 5 | `.caws/specs/.archive/CAWSFIX-26.yaml` | `mode: development` + `change_budget` + documents `non_governed_zones` semantics |
| 6 | `.caws/specs/.archive/ACVERIFY-001.yaml` | `mode: development` + both `acceptance:` and `acceptance_criteria:` simultaneously |
| 7 | `packages/caws-cli/.caws/specs/test-feature.yaml` | `risk_tier: T3` (unknown enum) + `mode: development` + `acceptance_criteria: []` |
| 8 | `packages/caws-cli/.caws/specs/ACVERIFY-001.yaml` | `mode: development` + dual alias fields |
| 9 | `.caws/dx-improvements-working-spec.yaml` | Live spec: `change_budget:` alongside `mode: feature` — forbidden field is not mode-gated |
| 10 | `.caws/specs/.archive/CAWSFIX-05.yaml` | `mode: development` + `acceptance_criteria: *ref_0` + spec text describes `change_budget` as PR violation |
| 11 | `.caws/specs/.archive/CAWSFIX-07.yaml` | `mode: development` + prose references to `acceptance_criteria` shape compatibility — captures the old alias promise |
| 12 | `.caws/specs/.archive/CAWSFIX-32.yaml` | `mode: development` + `acceptance_criteria:` block with structured items — exercises alias-with-body case |

Plus one positive-fixture:
| 13 | `.caws/policy.yaml` | Live policy with `label:` on tiers — exercises the `additionalProperties: false` violation at policy level |
