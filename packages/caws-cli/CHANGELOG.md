## [10.1.0] (2026-04-17)

### Features

* **scope:** add `caws scope show` command to inspect effective scope boundaries and binding health
* **worktree:** add `caws worktree bind <spec-id>` command to fix mutual spec-worktree binding
* **worktree:** auto-bind specId from spec `worktree:` field during `caws worktree create`
* **scope-guard:** distinguish authoritative mode (bound spec) from union mode (all specs) in block messages
* **scope-guard:** include `caws scope show` and `caws worktree bind` fix instructions in block output
* **templates:** add scope binding explanation, recovery checklist, and new commands to CLAUDE.md
* **waivers:** `caws waivers prune --expired` command with `--apply`, `--dry-run`, and `--json` modes (CAWSFIX-04)
* **worktree:** auto-close bound spec on successful merge (CAWSFIX-14) — eliminates the stale-`active` spec accumulation that followed merged worktrees

### Bug Fixes

* **validation:** unify spec validators — delete legacy `.caws/validate.js`, tighten JSON schema to match all required fields (CAWSFIX-03)
* **ci:** validate all feature specs in PRs, not just `working-spec.yaml`; catch `*.backup` suffix files (CAWSFIX-05)
* **gates:** `budget_limit` gate reports `status: skipped` (not `pass`) in CLI context for accuracy (CAWSFIX-06)
* **specs:** warn when feature-mode specs have `contracts: []` (CAWSFIX-06)
* **validation:** budget derivation no longer crashes when spec has no `change_budget` field — sync path added to resolve `await`-less call bug (CAWSFIX-07)
* **validation:** accept modern `acceptance_criteria:` shape as an alias for legacy `acceptance:` (CAWSFIX-09)
* **validation:** spec IDs with multi-segment prefixes like `P03-IMPL-01` and `ALG-001A-HARDEN-01` now validate (CAWSFIX-10)
* **scope:** `version` field is optional on inline scope blocks; still required on standalone `.caws/scope.json` (CAWSFIX-11)
* **scripts:** repoint `scripts/verify.sh` and `package.json:validate` at `caws validate` (the legacy `.caws/validate.js` is gone — CAWSFIX-12)
* **waivers:** `validateWaiverStructure` accepts modern schema shape (`reason_code`, `delta`, `approvers: [{handle, approved_at}]`) — waivers conforming to `waiver.schema.json` are no longer silently dropped from budget derivation (CAWSFIX-13)
* **schema:** resolver prefers flat `.caws/<name>.schema.json` over stale bundled template, making CAWSFIX-03's tightened repo schemas authoritative at runtime (CAWSFIX-08)
* **specs:** `caws specs close <id>` produces a 2-line diff (status + updated_at) instead of a full YAML reshape (CAWSFIX-15)
* **policy:** `validatePolicy` accepts any subset of tiers 1–3 instead of hard-requiring all three — single-tier policies no longer crash `loadPolicy` (CAWSFIX-16)
* **waivers:** sync template `waivers.schema.json` to modern shape (`reason_code`, `delta`, `approvers`) and fix validation wrapping bug — `createWaiver` now validates the waiver object directly instead of wrapping in `{[id]: waiver}` (CAWSFIX-17)
* **worktree:** `destroyWorktree` auto-commits `.caws/worktrees.json` so the working tree stays clean across sessions; uses `wip(checkpoint):` when other worktrees are active, `chore(worktree):` otherwise (CAWSFIX-18)
* **schema:** sync template working-spec and policy schemas to runtime — `caws init` now scaffolds schemas identical to the ones enforced at runtime; fixes `$schema` draft version (draft-07), `additionalProperties`, required fields, and id regex (CAWSFIX-20)
* **schema:** align `id` pattern regex in `.caws/working-spec.schema.json` with runtime validator (`^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+$`) — specs with valid modern IDs like `P03-TRUTH-001` no longer receive false compliance penalties (CAWSFIX-21)
* **schema:** declare `thresholds` as explicit optional property on policy gate objects and restore `additionalProperties: false` — prevents arbitrary keys while supporting `god_object` and `todo_detection` threshold configs
* **tests:** resolve 3 flaky test suites (`perf-budgets`, `gates-cli`, `event-log-read-parity`) — root causes: Jest default 5s timeout shorter than 30s subprocess timeout causing zombie cascades, `process.chdir` pollution between co-resident tests, wall-clock timing assertions meaningless under parallel CPU contention

### Chores

* **.gitignore:** ignore `.caws/agents.json` (per-CLI-invocation session state, not versioned — CAWSFIX-15)
* **tests:** align test fixtures with post-CAWSFIX schema requirements (data_migration, non_functional, MCP removal, worktree binding)
* **tests:** migrate gates.test.js and gates-cli.test.js policy fixtures to include `edit_rules` (CAWSFIX-22)
* **tests:** add CAWSFIX-18 A2 test covering git commit failure path (pre-commit hook rejection)

## [10.0.1](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.0.0...v10.0.1) (2026-04-02)


### Bug Fixes

* **ci:** clean up stale MCP trigger, audit fallback, minimatch guard ([866914c](https://github.com/Paths-Design/coding-agent-working-standard/commit/866914ca792587d4197e863926615edb50cbf1c0))
* **ci:** remove catch-all release:false rules that blocked scoped commits ([39b9c52](https://github.com/Paths-Design/coding-agent-working-standard/commit/39b9c526b99b2c885fa3f9a4bbde2bb90ed25b9a))
* **ci:** restore package-lock.json with semantic-release intact ([83eb116](https://github.com/Paths-Design/coding-agent-working-standard/commit/83eb11610efe09210e46e5f98792ff21180233c3))
* **ci:** unblock release pipeline — audit warns instead of failing ([fcb6116](https://github.com/Paths-Design/coding-agent-working-standard/commit/fcb6116972f76b3cf74b67db4e496a97cbd55305))
* **cli:** --spec-id now works correctly on status, evaluate, iterate, burnup ([64bec51](https://github.com/Paths-Design/coding-agent-working-standard/commit/64bec5199fddfd4a994a9f014018f9da30b2b122))
* **cli:** await deriveBudget, fix setup.type, add command handler tests ([bfd9195](https://github.com/Paths-Design/coding-agent-working-standard/commit/bfd9195e99ca7fa4a05488cf847e42236c44c7d4))
* **cli:** remove dead packages from release pipeline, unblock v10 publish ([e6bab56](https://github.com/Paths-Design/coding-agent-working-standard/commit/e6bab568e1ae05dbf033b687cc502501c1f2cb8c))
* **cli:** schema violations warn instead of blocking all commands ([4e9d701](https://github.com/Paths-Design/coding-agent-working-standard/commit/4e9d70100050da38d475b7c224536af5df486673))
* **cli:** suppress husky stdout that corrupts npm pack tarball path in CI ([823b154](https://github.com/Paths-Design/coding-agent-working-standard/commit/823b154d2da49d7d88d7205798c8220dd4bc625b))
* **lint:** remove unused chalk import in burnup.test.js ([392c003](https://github.com/Paths-Design/coding-agent-working-standard/commit/392c00304cf8238b72ab189d8b8f9f96f481b521))
* **lint:** remove unused yaml import blocking CI release pipeline ([93893af](https://github.com/Paths-Design/coding-agent-working-standard/commit/93893af754c6eaac07da3e59fbd4872812348203))
* **lint:** resolve all 49 lint errors across src and tests ([6554261](https://github.com/Paths-Design/coding-agent-working-standard/commit/655426170ab84c50c04b675aa9846c73aa655e0b))
* **sidecars:** handle minimatch v3 and v5+ export differences ([a14ee84](https://github.com/Paths-Design/coding-agent-working-standard/commit/a14ee845f098e22f3a95ad71909786022f796b3f))
