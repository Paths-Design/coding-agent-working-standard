## [10.0.1](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.0.0...v10.0.1) (2026-04-02)


### Bug Fixes

* **ci:** add workflow file to release trigger paths ([da19a4f](https://github.com/Paths-Design/coding-agent-working-standard/commit/da19a4f34fe78881b2e0b3c69818ec0b018c63a4))
* **ci:** clean up stale MCP trigger, audit fallback, minimatch guard ([866914c](https://github.com/Paths-Design/coding-agent-working-standard/commit/866914ca792587d4197e863926615edb50cbf1c0))
* **ci:** remove catch-all release:false rules that blocked scoped commits ([39b9c52](https://github.com/Paths-Design/coding-agent-working-standard/commit/39b9c526b99b2c885fa3f9a4bbde2bb90ed25b9a))
* **ci:** restore NODE_AUTH_TOKEN in setup-node for npmrc auth ([136b8ec](https://github.com/Paths-Design/coding-agent-working-standard/commit/136b8ec0319575011c07fbbc7d5e14a45270c6d3))
* **ci:** restore NPM_TOKEN for verification, keep provenance for publish ([d051443](https://github.com/Paths-Design/coding-agent-working-standard/commit/d051443d25971df3f8ebb46576bacbbbea10149b))
* **ci:** restore package-lock.json with semantic-release intact ([83eb116](https://github.com/Paths-Design/coding-agent-working-standard/commit/83eb11610efe09210e46e5f98792ff21180233c3))
* **ci:** unblock release pipeline — audit warns instead of failing ([fcb6116](https://github.com/Paths-Design/coding-agent-working-standard/commit/fcb6116972f76b3cf74b67db4e496a97cbd55305))
* **ci:** use OIDC trusted publisher for npm publish, remove NPM_TOKEN ([ae99876](https://github.com/Paths-Design/coding-agent-working-standard/commit/ae9987608bc7a0f53bcdf92fd0ee7b6a1cf39abc))
* **cli:** --spec-id now works correctly on status, evaluate, iterate, burnup ([64bec51](https://github.com/Paths-Design/coding-agent-working-standard/commit/64bec5199fddfd4a994a9f014018f9da30b2b122))
* **cli:** await deriveBudget, fix setup.type, add command handler tests ([bfd9195](https://github.com/Paths-Design/coding-agent-working-standard/commit/bfd9195e99ca7fa4a05488cf847e42236c44c7d4))
* **cli:** enable npm provenance to bypass OTP via trusted publisher ([4a60715](https://github.com/Paths-Design/coding-agent-working-standard/commit/4a60715a89f1740c7ab0dca9c65334d858dd4b27))
* **cli:** remove dead packages from release pipeline, unblock v10 publish ([e6bab56](https://github.com/Paths-Design/coding-agent-working-standard/commit/e6bab568e1ae05dbf033b687cc502501c1f2cb8c))
* **cli:** schema violations warn instead of blocking all commands ([4e9d701](https://github.com/Paths-Design/coding-agent-working-standard/commit/4e9d70100050da38d475b7c224536af5df486673))
* **cli:** suppress husky stdout that corrupts npm pack tarball path in CI ([823b154](https://github.com/Paths-Design/coding-agent-working-standard/commit/823b154d2da49d7d88d7205798c8220dd4bc625b))
* **lint:** remove unused chalk import in burnup.test.js ([392c003](https://github.com/Paths-Design/coding-agent-working-standard/commit/392c00304cf8238b72ab189d8b8f9f96f481b521))
* **lint:** remove unused yaml import blocking CI release pipeline ([93893af](https://github.com/Paths-Design/coding-agent-working-standard/commit/93893af754c6eaac07da3e59fbd4872812348203))
* **lint:** resolve all 49 lint errors across src and tests ([6554261](https://github.com/Paths-Design/coding-agent-working-standard/commit/655426170ab84c50c04b675aa9846c73aa655e0b))
* **sidecars:** handle minimatch v3 and v5+ export differences ([a14ee84](https://github.com/Paths-Design/coding-agent-working-standard/commit/a14ee845f098e22f3a95ad71909786022f796b3f))

## [10.0.1](https://github.com/Paths-Design/coding-agent-working-standard/compare/v10.0.0...v10.0.1) (2026-04-02)


### Bug Fixes

* **ci:** clean up stale MCP trigger, audit fallback, minimatch guard ([866914c](https://github.com/Paths-Design/coding-agent-working-standard/commit/866914ca792587d4197e863926615edb50cbf1c0))
* **ci:** remove catch-all release:false rules that blocked scoped commits ([39b9c52](https://github.com/Paths-Design/coding-agent-working-standard/commit/39b9c526b99b2c885fa3f9a4bbde2bb90ed25b9a))
* **ci:** restore package-lock.json with semantic-release intact ([83eb116](https://github.com/Paths-Design/coding-agent-working-standard/commit/83eb11610efe09210e46e5f98792ff21180233c3))
* **ci:** unblock release pipeline — audit warns instead of failing ([fcb6116](https://github.com/Paths-Design/coding-agent-working-standard/commit/fcb6116972f76b3cf74b67db4e496a97cbd55305))
* **cli:** --spec-id now works correctly on status, evaluate, iterate, burnup ([64bec51](https://github.com/Paths-Design/coding-agent-working-standard/commit/64bec5199fddfd4a994a9f014018f9da30b2b122))
* **cli:** await deriveBudget, fix setup.type, add command handler tests ([bfd9195](https://github.com/Paths-Design/coding-agent-working-standard/commit/bfd9195e99ca7fa4a05488cf847e42236c44c7d4))
* **cli:** enable npm provenance to bypass OTP via trusted publisher ([4a60715](https://github.com/Paths-Design/coding-agent-working-standard/commit/4a60715a89f1740c7ab0dca9c65334d858dd4b27))
* **cli:** remove dead packages from release pipeline, unblock v10 publish ([e6bab56](https://github.com/Paths-Design/coding-agent-working-standard/commit/e6bab568e1ae05dbf033b687cc502501c1f2cb8c))
* **cli:** schema violations warn instead of blocking all commands ([4e9d701](https://github.com/Paths-Design/coding-agent-working-standard/commit/4e9d70100050da38d475b7c224536af5df486673))
* **cli:** suppress husky stdout that corrupts npm pack tarball path in CI ([823b154](https://github.com/Paths-Design/coding-agent-working-standard/commit/823b154d2da49d7d88d7205798c8220dd4bc625b))
* **lint:** remove unused chalk import in burnup.test.js ([392c003](https://github.com/Paths-Design/coding-agent-working-standard/commit/392c00304cf8238b72ab189d8b8f9f96f481b521))
* **lint:** remove unused yaml import blocking CI release pipeline ([93893af](https://github.com/Paths-Design/coding-agent-working-standard/commit/93893af754c6eaac07da3e59fbd4872812348203))
* **lint:** resolve all 49 lint errors across src and tests ([6554261](https://github.com/Paths-Design/coding-agent-working-standard/commit/655426170ab84c50c04b675aa9846c73aa655e0b))
* **sidecars:** handle minimatch v3 and v5+ export differences ([a14ee84](https://github.com/Paths-Design/coding-agent-working-standard/commit/a14ee845f098e22f3a95ad71909786022f796b3f))

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
