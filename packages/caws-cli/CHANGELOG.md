# [10.1.0](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.0.1...v10.1.0) (2026-04-17)


### Bug Fixes

* **budget:** sync derivation path + no-crash on absent change_budget (CAWSFIX-07) ([018188b](https://github.com/Paths-Design/coding-agent-working-standard/commit/018188b5a18756929e6362e8536076347f2ec65d))
* **caws:** repoint dangling .caws/validate.js refs at bundled CLI (CAWSFIX-12) ([7f5d4ad](https://github.com/Paths-Design/coding-agent-working-standard/commit/7f5d4ad64f6c859ccfb6d8a519965796c2699278))
* **gates:** budget-limit returns skipped (not pass) in CLI context [CAWSFIX-06] ([0bd49ac](https://github.com/Paths-Design/coding-agent-working-standard/commit/0bd49acc4ae7e977ca550381834edeeecfc771a6))
* **gates:** point spec-completeness at real schema location (CAWSFIX-03) ([2893d83](https://github.com/Paths-Design/coding-agent-working-standard/commit/2893d83d400e1c4c12fa6971f0ac8ab052e58c2d))
* **lint:** add ignoreRestSiblings, remove unused imports to pass CI lint ([7c7c901](https://github.com/Paths-Design/coding-agent-working-standard/commit/7c7c9016a7afc561339ed25caab1e1de9d01744d))
* **lint:** resolve 3 errors and 4 warnings blocking CI ([3052a54](https://github.com/Paths-Design/coding-agent-working-standard/commit/3052a54cc023e05468aeca6ca6bda4ed889baa42))
* **policy:** accept any subset of tiers 1-3 in validatePolicy (CAWSFIX-16) ([ad8ef0e](https://github.com/Paths-Design/coding-agent-working-standard/commit/ad8ef0ebab823890b86da3015e5e7f576000734b))
* **schema+tests:** gates policy schema + fixture migration (CAWSFIX-22) ([59ff892](https://github.com/Paths-Design/coding-agent-working-standard/commit/59ff8921153ce9688065a944cad4e803db985686))
* **schema:** resolver prefers flat .caws/<name>.schema.json over bundled (CAWSFIX-08) ([dbbbf0d](https://github.com/Paths-Design/coding-agent-working-standard/commit/dbbbf0d17a9c032fc97664aecee722ba97074344))
* **schemas:** lift required version from scope.schema.json + document inline-block boundary (CAWSFIX-11) ([5376531](https://github.com/Paths-Design/coding-agent-working-standard/commit/5376531f5b914cb8e50608db2bcb6d81184f4899))
* **schema:** sync template schemas to runtime + align id regex with validator (CAWSFIX-20+21) ([19d5e8c](https://github.com/Paths-Design/coding-agent-working-standard/commit/19d5e8c070e0c2cae0e46f211795534d180dc22d))
* **schema:** tighten working-spec schema to match legacy validator (CAWSFIX-03) ([4771dcd](https://github.com/Paths-Design/coding-agent-working-standard/commit/4771dcd50118e864305546aeec698be144180026))
* **specs:** one-line diff on close + gitignore agents.json (CAWSFIX-15) ([02c6447](https://github.com/Paths-Design/coding-agent-working-standard/commit/02c64475420c76ee990361d6545d6717ae1cf282))
* **state:** fail-loud fence on undefined specId (CAWSFIX-02) ([e10e8f8](https://github.com/Paths-Design/coding-agent-working-standard/commit/e10e8f8baf2ab37bb3959feba1bb474d63c0979f))
* **tests+schema:** add CAWSFIX-18 A2 commit-failure test, tighten policy gate schema ([5efeee5](https://github.com/Paths-Design/coding-agent-working-standard/commit/5efeee58eb85d672018d91117eaf3a144c8924e8))
* **tests:** align test fixtures with post-CAWSFIX schema requirements ([e79692b](https://github.com/Paths-Design/coding-agent-working-standard/commit/e79692b87595b37428f4aad0fcf55ed66d777911))
* **tests:** resolve 3 flaky test suites that failed under parallel Jest workers ([0759cbe](https://github.com/Paths-Design/coding-agent-working-standard/commit/0759cbe9e5e9babd7910b27f31a634dbf0ceda1f))
* **validation:** accept modern acceptance_criteria shape as alias (CAWSFIX-09) ([d796b9e](https://github.com/Paths-Design/coding-agent-working-standard/commit/d796b9eff5a77589723d94ba317b405e09c5b606))
* **validation:** accept multi-segment spec IDs like P03-IMPL-01 (CAWSFIX-10) ([3091ce0](https://github.com/Paths-Design/coding-agent-working-standard/commit/3091ce0a2fd6e8b2c3b6b40486573c8da753232b))
* **waivers:** restructure active-waivers.yaml to conform to schema (CAWSFIX-04 A1) ([adf8b3f](https://github.com/Paths-Design/coding-agent-working-standard/commit/adf8b3f94726c83340612faeccf71f055e7b1cac))
* **waivers:** sync template schema to modern shape + fix wrapping (CAWSFIX-17) ([df0840e](https://github.com/Paths-Design/coding-agent-working-standard/commit/df0840e07266a4ec69a57b26bf8ef448ecc30255))
* **waivers:** validateWaiverStructure accepts modern schema shape (CAWSFIX-13) ([3c18681](https://github.com/Paths-Design/coding-agent-working-standard/commit/3c18681a54d104858192bf946028186c734a0da8))
* **worktree:** auto-close bound spec on successful merge (CAWSFIX-14) ([6834372](https://github.com/Paths-Design/coding-agent-working-standard/commit/683437239c68759e2cdde55743f3938ca0d12779))
* **worktree:** auto-commit .caws/worktrees.json after destroy (CAWSFIX-18) ([ff86ee5](https://github.com/Paths-Design/coding-agent-working-standard/commit/ff86ee5c75c07b17652b535f9deae8c1aadceaf0))


### Features

* **evlog:** add append-only event log and pure renderer (EVLOG-001) ([25506a5](https://github.com/Paths-Design/coding-agent-working-standard/commit/25506a524e40df8abbb73a8e3c3f864ea87cfed6))
* **evlog:** flip iterate.js to loadStateFromEvents (EVLOG-002 A1/A6) ([e280197](https://github.com/Paths-Design/coding-agent-working-standard/commit/e2801976df1f821de1986fb461df9ed3c6243e42))
* **evlog:** flip sidecar.js + gates.js feedback enrichment (EVLOG-002 A3/A4) ([ecf0662](https://github.com/Paths-Design/coding-agent-working-standard/commit/ecf066274c842adc5173415cce0f7c7d696feab6))
* **evlog:** flip status.js to loadStateFromEvents (EVLOG-002 A2) ([9cff551](https://github.com/Paths-Design/coding-agent-working-standard/commit/9cff551a41d47aee2a6e6d3eea37df169fa7a26c))
* **evlog:** loadStateFromEvents returns null on no-events (EVLOG-002 A5) ([5109a15](https://github.com/Paths-Design/coding-agent-working-standard/commit/5109a151c35719cb4c989f794fa9531cf04939c1))
* **evlog:** wire dual-write into 9 recorder and lifecycle call sites ([9564f5c](https://github.com/Paths-Design/coding-agent-working-standard/commit/9564f5c89671eae48635d30d78523820b6e8fabd))
* **scope:** add binding-aware scope guard, `scope show`, and `worktree bind` ([3f41720](https://github.com/Paths-Design/coding-agent-working-standard/commit/3f41720ce243e3508bc0fbb0eb5d2db376d1056b))
* **specs:** warn when feature spec is created with empty contracts [CAWSFIX-06] ([5e44e38](https://github.com/Paths-Design/coding-agent-working-standard/commit/5e44e38553b251db1f431a034bc5b943e14e3cb5))
* **waivers:** add `caws waivers prune --expired` (CAWSFIX-04 A3-A6) ([5f1d263](https://github.com/Paths-Design/coding-agent-working-standard/commit/5f1d26399a492cc6909ce36cd33521c3da7adfca))
* **worktree:** auto-bind specId from spec worktree field during create ([46ad82c](https://github.com/Paths-Design/coding-agent-working-standard/commit/46ad82c1e2fc6735cad254b1660fa370ae1dc9b9))

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
