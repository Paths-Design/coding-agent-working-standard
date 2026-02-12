# 1.0.0 (2026-02-12)


### Bug Fixes

* add eslint back to packages with root version ([23d00d8](https://github.com/Paths-Design/coding-agent-working-standard/commit/23d00d8837913c82dccc67608e417194b0a933cf))
* add final type assertion for MCP status result ([ef8665d](https://github.com/Paths-Design/coding-agent-working-standard/commit/ef8665da2fc5497b8fa32107eeb40d00d5345ff9))
* add safety checks for ai_assessment fields in working spec ([05f1f20](https://github.com/Paths-Design/coding-agent-working-standard/commit/05f1f20025303660b3bdc87d670514d83ffc9705))
* add safety checks for undefined values in working spec generation ([3fbb9c8](https://github.com/Paths-Design/coding-agent-working-standard/commit/3fbb9c892fff97535c98d8d5c9e2e9833b7d41fc))
* add stripAnsi to all remaining tool response outputs ([53e9ba5](https://github.com/Paths-Design/coding-agent-working-standard/commit/53e9ba5f825b9884f82325fd6e0974b5ed2e72b8))
* adjust performance regression threshold for CI environment ([52dc6fd](https://github.com/Paths-Design/coding-agent-working-standard/commit/52dc6fd166a62eb6a199b39e1242887106425e60))
* Aggressive process.cwd override to prevent ENOENT errors ([d7c0e7d](https://github.com/Paths-Design/coding-agent-working-standard/commit/d7c0e7db0216ac92d25c7f79fddcc3286c3a9d86))
* allow all packages to pass tests when no tests exist ([b244d93](https://github.com/Paths-Design/coding-agent-working-standard/commit/b244d93c7d7fe9cd411f413b3af4bc02b841aebf))
* allow MCP server tests to pass when no tests exist ([c0a8366](https://github.com/Paths-Design/coding-agent-working-standard/commit/c0a8366dc92645dc0e2b6e5444f85e80f1faa361))
* Bind process.cwd mock to avoid context issues ([2d6bee9](https://github.com/Paths-Design/coding-agent-working-standard/commit/2d6bee9a23a7418b5ba8140ca2aa134f20fcf392))
* CLI accessibility, error handling, and comprehensive test cleanup ([08fb690](https://github.com/Paths-Design/coding-agent-working-standard/commit/08fb6902de3b1d85fe675ca8b84f16ca6b0c8f75))
* **cli:** add scripts/** to release workflow path triggers ([9b2b41b](https://github.com/Paths-Design/coding-agent-working-standard/commit/9b2b41bd603248ff2e68f2da9d1a1f3ae4c8d33b))
* **cli:** complete test fixes for CI ([99b88d0](https://github.com/Paths-Design/coding-agent-working-standard/commit/99b88d0dd8dee16dda2e83f50b44c61daef2e2fa))
* **cli:** create COMMIT_CONVENTIONS.md as file instead of directory ([7a21bf5](https://github.com/Paths-Design/coding-agent-working-standard/commit/7a21bf5756041ea1e8558d396daa88c2daaaed23))
* **cli:** prevent glob patterns in scope.out and auto-generate policy.yaml ([8d886f3](https://github.com/Paths-Design/coding-agent-working-standard/commit/8d886f367af004840492cb54b9bd8b57bda34f4f))
* **cli:** rebundle MCP server and VS Code extension dependencies ([52ab2ac](https://github.com/Paths-Design/coding-agent-working-standard/commit/52ab2acc09a1004c3a998725c671f1e881c44618))
* **cli:** resolve linting errors for language-agnostic quality gates ([fd6beb9](https://github.com/Paths-Design/coding-agent-working-standard/commit/fd6beb996022f0f2646598759c0a2822ffea31a9))
* **cli:** resolve linting errors in init and git-hooks ([334332d](https://github.com/Paths-Design/coding-agent-working-standard/commit/334332d8261c28ac0630a5d10ad2161cd79c5576))
* **cli:** resolve test failures in CI ([677a852](https://github.com/Paths-Design/coding-agent-working-standard/commit/677a85292ebd7ac1f06fc3bbb79080f3437a517e))
* **cli:** simplify semantic-release rules to debug scope matching ([27a0b32](https://github.com/Paths-Design/coding-agent-working-standard/commit/27a0b325220d7c867b26a6bc6f329c14f5a40827))
* **cli:** update quality gates command with new options ([4542cec](https://github.com/Paths-Design/coding-agent-working-standard/commit/4542cec92a4acd2a8d46d348833957febd5ef15a))
* **cli:** use Angular preset to fix RegExp serialization issue ([89048f2](https://github.com/Paths-Design/coding-agent-working-standard/commit/89048f2f25f6e31575cddd5affd7c095f1b53518))
* **cli:** waaaah ([ec6929c](https://github.com/Paths-Design/coding-agent-working-standard/commit/ec6929c617289c3658578917edbac06246f37b06))
* complete test isolation across all test files ([b79ecbf](https://github.com/Paths-Design/coding-agent-working-standard/commit/b79ecbf8e00b73871b7f9b7d540bd52d71715b2e))
* complete test isolation across all test files ([4bf431a](https://github.com/Paths-Design/coding-agent-working-standard/commit/4bf431ac7df293a7c391af7c1cba77f004678710))
* complete test isolation across all test files ([7f54eb2](https://github.com/Paths-Design/coding-agent-working-standard/commit/7f54eb259975708c1038494d5331dcc16ac672bd))
* complete TypeScript error resolution with replace_all ([f9aed37](https://github.com/Paths-Design/coding-agent-working-standard/commit/f9aed372faf9bfcad377db3ee103df01d9c49977))
* comprehensive ANSI code stripping in all MCP server output paths ([a8154c7](https://github.com/Paths-Design/coding-agent-working-standard/commit/a8154c7fdd62f7a22bd4b970b308009a5ed10137))
* comprehensive ANSI color code stripping in MCP server ([47576eb](https://github.com/Paths-Design/coding-agent-working-standard/commit/47576eb7056edd6bd65c9ad3079e554f2c275961))
* correct extension ID in MCP client to match actual publisher ([e70d1b5](https://github.com/Paths-Design/coding-agent-working-standard/commit/e70d1b5e997530b9057ebcd97ef4909683215dd3))
* current directory init and file conflict handling ([2622458](https://github.com/Paths-Design/coding-agent-working-standard/commit/26224582fd9633bcdb7c288ef2299812acf1e6bb)), closes [#1](https://github.com/Paths-Design/coding-agent-working-standard/issues/1) [#2](https://github.com/Paths-Design/coding-agent-working-standard/issues/2)
* downgrade inquirer to CommonJS-compatible version and fix CLI detection ([ca6dab6](https://github.com/Paths-Design/coding-agent-working-standard/commit/ca6dab64c9b809a1cb4ad4263996cac8c34b7ea7))
* Ensure tests change directory before deleting temp directories ([2e6fc69](https://github.com/Paths-Design/coding-agent-working-standard/commit/2e6fc695487e4dd44c5bfc18f94923d67bd378f0))
* **extension:** remove shebang from bundled MCP server ([e69769e](https://github.com/Paths-Design/coding-agent-working-standard/commit/e69769e62607285ea8913f8c5fd6e459da007571))
* isolate CLI tests to prevent monorepo conflicts ([8041131](https://github.com/Paths-Design/coding-agent-working-standard/commit/804113104fc275231110593ed64ae2ba4d17b125))
* **lint:** resolve 4 ESLint errors blocking CI/CD ([71a7593](https://github.com/Paths-Design/coding-agent-working-standard/commit/71a7593e9fa313492e14fdfc035cbcaf7431cae2))
* make git initialization test resilient to CI environment ([937f361](https://github.com/Paths-Design/coding-agent-working-standard/commit/937f3612fb6504d0425773caaab3ad637b225fb5))
* **mcp:** add error handling and debug logging to tool/resource handlers ([4cac334](https://github.com/Paths-Design/coding-agent-working-standard/commit/4cac3340d96b73c34b6c1e45fffc1223410dc428))
* **mcp:** add initialize handler and make tool listing synchronous ([8722e95](https://github.com/Paths-Design/coding-agent-working-standard/commit/8722e952905a1efaa2948bccaaad4899faed4fa0))
* **mcp:** add server capabilities to MCP SDK constructor ([fb1309b](https://github.com/Paths-Design/coding-agent-working-standard/commit/fb1309b2de08413135456c6dcecd38c179f6d867))
* **mcp:** convert MCP server to ES modules and fix bundling ([06900d0](https://github.com/Paths-Design/coding-agent-working-standard/commit/06900d026eb5ba8a70050e2eb759e5593131c679))
* **mcp:** correct bundled CLI path for extension deployment ([2480327](https://github.com/Paths-Design/coding-agent-working-standard/commit/24803271359215ad3b5d8ed1a2b31f71f6db1fbd))
* **mcp:** update all CLI command paths and names ([2afc486](https://github.com/Paths-Design/coding-agent-working-standard/commit/2afc486cd42796f20645d0d946f1f3d13c559839))
* **mcp:** use proper MCP SDK schemas for request handlers ([8bbe6b8](https://github.com/Paths-Design/coding-agent-working-standard/commit/8bbe6b82b49ee7e1de59ec7c43fe19191e9274ea))
* migrate to ESLint v9 with flat config ([464acf1](https://github.com/Paths-Design/coding-agent-working-standard/commit/464acf1871ccd1f227ec818654efc87206e6ee7b))
* move js-yaml and chalk to dependencies for global install ([3e05031](https://github.com/Paths-Design/coding-agent-working-standard/commit/3e05031139ec046c53ba5e2d9220dcc3c3b73c1c))
* **packages/caws-cli:** add git hooks integration support ([c53646a](https://github.com/Paths-Design/coding-agent-working-standard/commit/c53646a5a388ac24a4ea11789db3a8c1a09ffaca))
* prevent CLI version bumps when only other packages change ([740878b](https://github.com/Paths-Design/coding-agent-working-standard/commit/740878bcb762bcab3955b4f1aa95129733f55c59))
* Prevent test failures from deleted working directories ([58b7f60](https://github.com/Paths-Design/coding-agent-working-standard/commit/58b7f60ccb0c49d7b8249a8748872677e19dad7f))
* **quality-gates,cli:** improve UX and fix process exit hanging ([2ed1007](https://github.com/Paths-Design/coding-agent-working-standard/commit/2ed10078df6212175ebdbb36b8377fad4735d63d))
* **quality-gates:** fix context scoping for push and CI validation ([ee4386d](https://github.com/Paths-Design/coding-agent-working-standard/commit/ee4386d377322c6dbf07f3d5ab9ad6eba302a9ed))
* **quality-gates:** fix placeholder gate enforcement level handling ([33f6722](https://github.com/Paths-Design/coding-agent-working-standard/commit/33f672294e093784dd65552f3bf7a3a61d97ea04))
* **release:** add explicit headerPattern for scope parsing in semantic-release ([34fca8b](https://github.com/Paths-Design/coding-agent-working-standard/commit/34fca8b4e6664a8fd61d6e516c40b2856d0eb630))
* **release:** expand releaseRules configuration with explicit rule ordering ([9b2f7d2](https://github.com/Paths-Design/coding-agent-working-standard/commit/9b2f7d285e2776cff6b7fb99b50463f9d543348d))
* **release:** handle npm workspace restrictions in manual release script ([e36df34](https://github.com/Paths-Design/coding-agent-working-standard/commit/e36df34e812866b153667a066adca27d1751ff45))
* **release:** skip already-published versions in manual release script ([d590285](https://github.com/Paths-Design/coding-agent-working-standard/commit/d590285a92babce444591ae473500bf5394ea87e))
* **release:** update semantic-release config to properly match feat(cli) commits ([8ebbe9e](https://github.com/Paths-Design/coding-agent-working-standard/commit/8ebbe9e09889cba2e5f5843e573f0a389c9132ea))
* **release:** use absolute paths for semantic-release config files ([2819fe6](https://github.com/Paths-Design/coding-agent-working-standard/commit/2819fe619dbda9cdb6c7965afda80e4255dad0d3))
* **release:** use CommonJS config files for semantic-release compatibility ([13dcb95](https://github.com/Paths-Design/coding-agent-working-standard/commit/13dcb95e58a294ac44e17b79952896938249eb90))
* remove local eslint dependencies from packages ([2957ca8](https://github.com/Paths-Design/coding-agent-working-standard/commit/2957ca824781fb2ebe8017190dda32a36d20330d))
* remove local eslint from MCP server package ([9d99242](https://github.com/Paths-Design/coding-agent-working-standard/commit/9d99242e924bd630ac25d389c3023ab3ecfed4f9))
* remove undefined cliTestProjectPath references in integration tests ([d5b2dda](https://github.com/Paths-Design/coding-agent-working-standard/commit/d5b2dda49bfbd41e89e3f9c0b498c0f04e431e5d))
* remove unnecessary @caws/template dependency from CLI package ([dde6502](https://github.com/Paths-Design/coding-agent-working-standard/commit/dde65028a5e587f141c7278ede4617c6b89979e1))
* remove unused imports from demo-project validate.js ([168f3a5](https://github.com/Paths-Design/coding-agent-working-standard/commit/168f3a586cc5fb3b1fe336cb0190752638ed7b98))
* remove unused imports in diagnose and status commands ([f22b108](https://github.com/Paths-Design/coding-agent-working-standard/commit/f22b10802ad0e080d0bab7b72c0adcaccf9dc062))
* remove unused variable in CLI workflow integration test ([cbb8bb8](https://github.com/Paths-Design/coding-agent-working-standard/commit/cbb8bb860c8c825f78b2198e24b82c8dd33a9b94))
* Remove unused variables in test files ([97e2638](https://github.com/Paths-Design/coding-agent-working-standard/commit/97e263896467cdbb6d41237df2bf1e5beb420f81))
* resolve all ESLint issues for production readiness ([56bbbc6](https://github.com/Paths-Design/coding-agent-working-standard/commit/56bbbc6a99013a5f0fe8f3eaf67d9ea6d24bd832))
* resolve all test suite failures and achieve 100% test pass rate ([d103bf6](https://github.com/Paths-Design/coding-agent-working-standard/commit/d103bf6398212edeaa0c443040fb6ac218d1f4d3))
* resolve all TypeScript compilation errors ([2365fa7](https://github.com/Paths-Design/coding-agent-working-standard/commit/2365fa78a260198f2327c24b17f4ccb32406c405))
* resolve CI dependency and ESLint issues ([631d800](https://github.com/Paths-Design/coding-agent-working-standard/commit/631d800e056c88040d9c3ed10ef1f4bc36d734fb))
* resolve CI dependency and turbo issues for release ([cfe00aa](https://github.com/Paths-Design/coding-agent-working-standard/commit/cfe00aa7b038015f48889412c4e15cff2228784e))
* resolve CI test failures and false positive in pre-commit hook ([3b7171c](https://github.com/Paths-Design/coding-agent-working-standard/commit/3b7171c858dfcdde6647443231151da9c38aeff8))
* resolve CI test failures with ENOENT uv_cwd errors ([6aed7fe](https://github.com/Paths-Design/coding-agent-working-standard/commit/6aed7fe74d80464050067a12a13a8f5013cc7304))
* resolve CI/CD failures and implement waiver sync ([68ea1ac](https://github.com/Paths-Design/coding-agent-working-standard/commit/68ea1acd5b60abb1d792b79ab037711ca81edba1))
* resolve CLI non-interactive mode and test issues ([cefaac3](https://github.com/Paths-Design/coding-agent-working-standard/commit/cefaac30c8dd48f6f5d617acef18275667fd92ae))
* resolve CLI test failures and improve test isolation ([2d1f799](https://github.com/Paths-Design/coding-agent-working-standard/commit/2d1f799dc202f6dc93c0565c70cc2859e9849a70))
* resolve CLI test isolation issues causing release failures ([a47e8e9](https://github.com/Paths-Design/coding-agent-working-standard/commit/a47e8e909332844819efb11d6d7d887734c356a5))
* resolve critical performance issues in quality gates system ([b6cd4df](https://github.com/Paths-Design/coding-agent-working-standard/commit/b6cd4dff1a4d391beb66107e991c775ed211501b))
* resolve ESLint configuration error in VSCode extension ([7bee523](https://github.com/Paths-Design/coding-agent-working-standard/commit/7bee5237974046dafa69318b4d0f9aa1f2f56ca5))
* resolve ESLint errors in MCP server timeout implementation ([00bf912](https://github.com/Paths-Design/coding-agent-working-standard/commit/00bf912d3007117f0b45733e44d9b78c72df8afb))
* resolve inquirer ES module import error and test isolation issues ([0421eaf](https://github.com/Paths-Design/coding-agent-working-standard/commit/0421eaf76acac85d7e545570c2e4f44299d29f91))
* resolve linting and build issues for release ([f9718c6](https://github.com/Paths-Design/coding-agent-working-standard/commit/f9718c689b7f9f90dc009b7a6ad8848685d221cf))
* resolve linting and test issues for semantic release ([29270b3](https://github.com/Paths-Design/coding-agent-working-standard/commit/29270b369ead361f1b70f91f7bbc9e7351fe969f))
* resolve lock file and chalk compatibility issues ([4f00360](https://github.com/Paths-Design/coding-agent-working-standard/commit/4f00360e7941b7d564a8fbf7c8295fd94d797ab7))
* resolve Node.js global function ESLint errors ([cb122b9](https://github.com/Paths-Design/coding-agent-working-standard/commit/cb122b96f9e98a91c5451c0c84ebaeba7517878d))
* resolve remaining CLI test failures for release ([5aeb4bd](https://github.com/Paths-Design/coding-agent-working-standard/commit/5aeb4bd672f69c211446413b1a00ea3b8e0faa88))
* Resolve remaining linting errors ([ad32019](https://github.com/Paths-Design/coding-agent-working-standard/commit/ad320192a2a9c038b8775cf91c81e0f210d91cef))
* resolve remaining linting issues in tools-integration test ([8c213fa](https://github.com/Paths-Design/coding-agent-working-standard/commit/8c213fa4826a542ef56671d70b2b88bca994e0bc))
* resolve remaining test issues and CLI argument parsing ([d926623](https://github.com/Paths-Design/coding-agent-working-standard/commit/d92662358e5b949259bda849072d10dfe0df5126))
* resolve smoke workflow test failures ([365dc45](https://github.com/Paths-Design/coding-agent-working-standard/commit/365dc450ded16f2b0d134c9ea7d4bd2cfa6ccff8))
* resolve testTempDir undefined error in e2e tests ([ad0f743](https://github.com/Paths-Design/coding-agent-working-standard/commit/ad0f74338cb348b343556f3df3333294f64d191d))
* resolve TypeScript compilation errors in VS Code extension ([5fc75f7](https://github.com/Paths-Design/coding-agent-working-standard/commit/5fc75f71f78f521aafe0ad491456451942013fd9))
* resolve TypeScript compilation errors in VSCode extension ([29d051e](https://github.com/Paths-Design/coding-agent-working-standard/commit/29d051e56f0328b683dbf2ff8df323850055de10))
* resolve variable scoping ESLint errors in MCP server ([7b817d4](https://github.com/Paths-Design/coding-agent-working-standard/commit/7b817d439512280d5ff1e650b6122c5e225503f7))
* scaffold command now uses bundled templates ([ceff5e4](https://github.com/Paths-Design/coding-agent-working-standard/commit/ceff5e4e007fde38500f627422320c93acc4b441))
* **security:** resolve audit failures and enhance pre-push hook ([c6759e8](https://github.com/Paths-Design/coding-agent-working-standard/commit/c6759e8bcfecc27c8a81267cfa2f90192e27f6a8))
* Split setup into pre-setup and setup files for Jest compatibility ([16ad99e](https://github.com/Paths-Design/coding-agent-working-standard/commit/16ad99e1fff9cb063706173be253b21755438826))
* suppress ANSI color codes in MCP server output ([bfa5744](https://github.com/Paths-Design/coding-agent-working-standard/commit/bfa57449afb16b7e8c8bb4188473610f31cd95b5))
* sync package-lock.json and add CI/CD improvements ([ebd74e3](https://github.com/Paths-Design/coding-agent-working-standard/commit/ebd74e35e883fe62d53b4966a4f5b17b484de486))
* **tests:** fix fs.readFile mocks to return written content ([c16cd01](https://github.com/Paths-Design/coding-agent-working-standard/commit/c16cd01267530d2601d83e20cd9a8cb701cc0f06))
* **tests:** improve fs.readFile mock to return written content ([22c6485](https://github.com/Paths-Design/coding-agent-working-standard/commit/22c6485b4a01bf487a66480275404ab0aaf9da06))
* **tests:** resolve CI test failures in spec-creation and migration ([1b800fc](https://github.com/Paths-Design/coding-agent-working-standard/commit/1b800fc3ef4275ec75dfde22fb6f1a34af5cb8a0))
* Update .gitignore to allow CAWS template IDE configurations ([6473040](https://github.com/Paths-Design/coding-agent-working-standard/commit/6473040d2303f493cbf5da3e2bc50d2d2c080eea))
* update index tests to use unique project names ([6a600ef](https://github.com/Paths-Design/coding-agent-working-standard/commit/6a600efc71016fcdc416479519285476e7691e1f))
* update provenance tools loader to use bundled templates ([a58996f](https://github.com/Paths-Design/coding-agent-working-standard/commit/a58996fd4fc22eea0f9c2f3d67870ea45df0327c))
* update readme with proper instructions ([fa0dbe7](https://github.com/Paths-Design/coding-agent-working-standard/commit/fa0dbe780020d5a6b4387ed0334ab55f924321ce))
* update release pipeline for monorepo ([81ac859](https://github.com/Paths-Design/coding-agent-working-standard/commit/81ac859e6d8e2e09fe3833b418d2d6202069fc75))
* update release workflow to use npx semantic-release directly ([100e4b7](https://github.com/Paths-Design/coding-agent-working-standard/commit/100e4b7d07450ff5ee7702d4eb6f67b33ac0b218))
* update tests to handle CLI working spec generation issues ([70fd00d](https://github.com/Paths-Design/coding-agent-working-standard/commit/70fd00d0d8f5c0538b1a9abc25436059a600139d))
* update tools test to find templates in CLI package ([43efa15](https://github.com/Paths-Design/coding-agent-working-standard/commit/43efa15028b92d0b46bd867710428c54d9c8fa81))
* use npx eslint in lint scripts for CI compatibility ([4717ae7](https://github.com/Paths-Design/coding-agent-working-standard/commit/4717ae7514bbc3238194f4fa4138f69533c796b8))
* use OS temp directory for test isolation to prevent CLI conflicts ([03af545](https://github.com/Paths-Design/coding-agent-working-standard/commit/03af5456bb43542b62a37130e9c0423c99026b79))
* **vscode:** bundle CLI dependencies from monorepo root ([f1fe37f](https://github.com/Paths-Design/coding-agent-working-standard/commit/f1fe37faa2be19b86699f0cb716f39f8dee9c594))
* **vscode:** bundle complete CLI node_modules with all transitive deps ([9b9dd8c](https://github.com/Paths-Design/coding-agent-working-standard/commit/9b9dd8c0a63ea835c2a53f133666e843e7a55f8c))
* **vscode:** bundle MCP SDK dependencies and fix packaging ([39ac8e3](https://github.com/Paths-Design/coding-agent-working-standard/commit/39ac8e354e4c6b8ca532acb1a84544486c775d30))
* **vscode:** copy all monorepo node_modules for complete dependency resolution ([1125ddf](https://github.com/Paths-Design/coding-agent-working-standard/commit/1125ddf8bcaf5278dc32974f120db351ab300efb))
* **vscode:** improve .vscodeignore to prevent monorepo file inclusion ([bfe9a34](https://github.com/Paths-Design/coding-agent-working-standard/commit/bfe9a34b8fa9990f7bff1b307f5368343c31d205))


### Code Refactoring

* **mcp-server:** rewrite to modular architecture ([683b8d9](https://github.com/Paths-Design/coding-agent-working-standard/commit/683b8d94d1f6c1ac11b987191407d884f6839803))


### Features

* add agents.md guide to project initialization ([7c838b4](https://github.com/Paths-Design/coding-agent-working-standard/commit/7c838b4120a718a7e478ac3f2b3eb042e1a07e7f))
* add Claude Code hooks scaffold and quality gates performance optimization ([7f94ae6](https://github.com/Paths-Design/coding-agent-working-standard/commit/7f94ae6c231f67c85012d5b7d3d618169ef00892))
* add comprehensive quality gates system with staged file analysis ([f34e679](https://github.com/Paths-Design/coding-agent-working-standard/commit/f34e6794ff4cfb77472bf8a853d134c33a835bc2))
* Add Cursor hooks integration for real-time quality gates ([a4df8cf](https://github.com/Paths-Design/coding-agent-working-standard/commit/a4df8cfe5f2eadf70f84976af985205dd61eb696))
* Add defense in depth with agent guardrails and actionable guidance ([809cfa0](https://github.com/Paths-Design/coding-agent-working-standard/commit/809cfa0db040cf8033985686f9dc89bc8e2c9bb8))
* add enhanced error handling and TypeScript auto-detection (DX-001 T1+T2) ([0301996](https://github.com/Paths-Design/coding-agent-working-standard/commit/0301996253f8bd9de5e56f60bcb6b02fa4d964f8))
* Add git author configuration for proper commit attribution ([1831c6b](https://github.com/Paths-Design/coding-agent-working-standard/commit/1831c6b53f1acb1f4156f7b723f66bf95d22f9dc))
* add monorepo-level git hooks with Husky ([9c7e395](https://github.com/Paths-Design/coding-agent-working-standard/commit/9c7e395363e1524a431c15b75ef48410d704eacc))
* add pnpm & lerna workspace support for complete monorepo coverage ([fdc6479](https://github.com/Paths-Design/coding-agent-working-standard/commit/fdc6479f452fa7f8fd6475fccedb0d2e66bc2af0))
* Add PolicyManager, SpecFileManager, and enhanced waiver validation ([9313a3b](https://github.com/Paths-Design/coding-agent-working-standard/commit/9313a3bbded454fd28f18b395c6e4178f2c0ff1e))
* add status command for project health overview (DX-001 T3) ([b7dfa1c](https://github.com/Paths-Design/coding-agent-working-standard/commit/b7dfa1ccddcaaba32640b77a663a962f30947ccc))
* Add waiver schema and comprehensive agent guide ([4645e1e](https://github.com/Paths-Design/coding-agent-working-standard/commit/4645e1ee6e8c9ef9c3c6c38783800f8adb226f2b))
* bundle templates with CLI and improve AI agent experience ([309f6e4](https://github.com/Paths-Design/coding-agent-working-standard/commit/309f6e4233db557575d6a664460bcf92b0c8743a))
* bundle templates with CLI and improve AI agent experience ([aee0e07](https://github.com/Paths-Design/coding-agent-working-standard/commit/aee0e07d210942ce4b5213ffee5c7c0b51bf7264))
* **caws-types:** add placeholder governance types and helpers ([2ec676b](https://github.com/Paths-Design/coding-agent-working-standard/commit/2ec676b71cb7ba89c6a5a167f517b16bb2dc01d9))
* **cli:** add Claude Code hooks scaffold and quality gates performance ([e9b982e](https://github.com/Paths-Design/coding-agent-working-standard/commit/e9b982ec4cc1bb9896f2fdd551ad3aef6b1c1578))
* **cli:** add debug logging to release script ([24e13ae](https://github.com/Paths-Design/coding-agent-working-standard/commit/24e13aec0f57a7aed32779c005451387aa14a67e))
* **cli:** add IDE selection to init and scaffold ([19c6b6a](https://github.com/Paths-Design/coding-agent-working-standard/commit/19c6b6abeb36fc5b6ca035275b5ea1518d4c42d6))
* **cli:** add language-agnostic quality gates support ([f5bd60e](https://github.com/Paths-Design/coding-agent-working-standard/commit/f5bd60ea8ffc8308ab6965beaf5e74c4b21c767d))
* **cli:** add language-agnostic quality gates support ([1977772](https://github.com/Paths-Design/coding-agent-working-standard/commit/19777725a743c77857cb02d555d3d54ae933e8ac))
* **cli:** add language-agnostic quality gates support ([5daa280](https://github.com/Paths-Design/coding-agent-working-standard/commit/5daa280874c1276e94729fe965847812f24a0d00))
* **cli:** add lite mode and worktree isolation ([a22d736](https://github.com/Paths-Design/coding-agent-working-standard/commit/a22d736ff097a5ae8d30544999e06ddc10c132e0))
* **cli:** bundle quality gates for CLI, MCP, and VS Code extension ([acb9252](https://github.com/Paths-Design/coding-agent-working-standard/commit/acb92520af00a9f9ebd5a3b748bbe7f9bc1c5b86))
* **cli:** bundle quality gates for CLI, MCP, and VS Code extension ([1714c07](https://github.com/Paths-Design/coding-agent-working-standard/commit/1714c079235908560d9d24d2ad8cb562c840541b))
* **cli:** enhance CLI description and trigger release workflow ([17dec2b](https://github.com/Paths-Design/coding-agent-working-standard/commit/17dec2ba53450bcc88d7baae38d16b89950a07ad))
* **cli:** enhance sequential workflow guidance for agents ([0cb53c6](https://github.com/Paths-Design/coding-agent-working-standard/commit/0cb53c6e30f79d9255731484d1aaa14f81119195))
* **cli:** implement esbuild bundling for 95.8% size reduction ([3ef4ee8](https://github.com/Paths-Design/coding-agent-working-standard/commit/3ef4ee881ed17a6ad3b0b0bd84860a87e09db819))
* **cli:** implement missing CLI commands (evaluate, iterate, waivers) ([7377a0e](https://github.com/Paths-Design/coding-agent-working-standard/commit/7377a0e27f220e774f2db8f6ba592ec79e0f7a2d))
* **cli:** improve agent guidance and error messages ([f6bcddc](https://github.com/Paths-Design/coding-agent-working-standard/commit/f6bcddcb2b02751dd92a1c816aab94b40502fc06))
* **cli:** improve minimal-cli documentation for clarity ([497a217](https://github.com/Paths-Design/coding-agent-working-standard/commit/497a21722345bda5a2c74380093165aea85dbf47))
* **cli:** improve package description for npm discoverability ([e9a73aa](https://github.com/Paths-Design/coding-agent-working-standard/commit/e9a73aae824a0e7cd666627b94dd80c5426a55ea))
* **cli:** prioritize published [@paths](https://github.com/paths).design/quality-gates package ([303c66a](https://github.com/Paths-Design/coding-agent-working-standard/commit/303c66a756f8e22d7995701b037c8fae2709c43f))
* **cli:** remove preset, use explicit parser config for semantic-release ([f4d12fd](https://github.com/Paths-Design/coding-agent-working-standard/commit/f4d12fd69fe2d7af2fdd03b74069b0acfbb8f7c9))
* **cli:** trigger release with correct v8.0.1 baseline ([f340444](https://github.com/Paths-Design/coding-agent-working-standard/commit/f34044469de9e6102f75321c237430f45937f6fb))
* **cli:** update IDE templates for 2026 best practices ([aec2cc5](https://github.com/Paths-Design/coding-agent-working-standard/commit/aec2cc5476ef4284b699e6388f7478dc39ac1581))
* **cli:** update minimal-cli documentation ([f4789cf](https://github.com/Paths-Design/coding-agent-working-standard/commit/f4789cfacbeef1569bc8ef43923e24e89fbefcf6))
* **cli:** update quality gates help text with new gates ([63740e1](https://github.com/Paths-Design/coding-agent-working-standard/commit/63740e1b65f30b551dca912c7f52708ab92cf098))
* **cli:** use Angular preset defaults for semantic-release ([e4a6756](https://github.com/Paths-Design/coding-agent-working-standard/commit/e4a6756219de5ed907225fa5b0c8645847ab2168))
* complete DX improvements - diagnose and templates commands (DX-001 T4+T5) ([4f207a1](https://github.com/Paths-Design/coding-agent-working-standard/commit/4f207a180b26f9ba59901de8e2a77ecdd1438e6d))
* Complete multi-agent architecture implementation ([60c7cbb](https://github.com/Paths-Design/coding-agent-working-standard/commit/60c7cbbd581bbcf327f1b8e296166815e860ce6b))
* complete P1 Sprint 2 - Trust & Reliability fixes ([a9e8400](https://github.com/Paths-Design/coding-agent-working-standard/commit/a9e84003f9d5430be9619235183edf401c13fcec))
* complete P1 Sprint 3 - Enhanced Error Context ([6ed118b](https://github.com/Paths-Design/coding-agent-working-standard/commit/6ed118b1933f26153f603ec7e6bed8c7bd4b7b1a))
* Complete policy separation and waiver-based budget control ([c852448](https://github.com/Paths-Design/coding-agent-working-standard/commit/c852448bf142b215df31ea46e714a82875dd832c))
* comprehensive CAWS CLI operationalization ([4ba1a14](https://github.com/Paths-Design/coding-agent-working-standard/commit/4ba1a1417596954c5adc7fd6f1dc4f2599ebb4cc))
* configure OIDC automated publishing and fix linting issues ([165d0f3](https://github.com/Paths-Design/coding-agent-working-standard/commit/165d0f34a88986c48343f3c7e605fe1dc069b9a2))
* Enable comprehensive IDE integrations and agent hooks ([c0b7007](https://github.com/Paths-Design/coding-agent-working-standard/commit/c0b700705e6622f25d9ee05dec015b06ced9b29c))
* Enable IDE integrations during project scaffolding ([110438c](https://github.com/Paths-Design/coding-agent-working-standard/commit/110438c0118e01e95ee9f3f6e3b951a3513d05c3))
* enable OIDC trusted publishing with NPM provenance ([93545ea](https://github.com/Paths-Design/coding-agent-working-standard/commit/93545ea2b420b7ca2fe6493039e3ea6abb2a0760))
* enhance CAWS CLI with Chalk styling and improved validation ([f58f205](https://github.com/Paths-Design/coding-agent-working-standard/commit/f58f20520cefcd23c5fa2a852194ff551c69a924))
* Harden quality gates system with enterprise-grade reliability ([da849f7](https://github.com/Paths-Design/coding-agent-working-standard/commit/da849f74a08184f0850d66832c3ec1f0f7cfe9eb))
* implement automated publishing with OIDC and semantic versioning ([eadb9cf](https://github.com/Paths-Design/coding-agent-working-standard/commit/eadb9cffdd8c36d78407dea79fc46f88974dd45e))
* implement automated publishing with semantic versioning and OIDC ([fcd7461](https://github.com/Paths-Design/coding-agent-working-standard/commit/fcd7461266f874fb630a4be858868e6974dd8806))
* Implement basic provenance tracking system ([a127065](https://github.com/Paths-Design/coding-agent-working-standard/commit/a127065eb5a7f3166b99e3615e49ad32e85b51d5))
* Implement complete CAWS toolchain and testing framework ([819fe83](https://github.com/Paths-Design/coding-agent-working-standard/commit/819fe835ee096d6edd67f4c16594d289c86f5835))
* Implement comprehensive CAWS agent workflow extensions ([ab71fb7](https://github.com/Paths-Design/coding-agent-working-standard/commit/ab71fb78ca608fc4f2b2ea325cd3ce39e72b68b9))
* Implement comprehensive CAWS framework enhancements ([8ee395d](https://github.com/Paths-Design/coding-agent-working-standard/commit/8ee395dfe4fda6c5fbc3b65716180e09de729e55))
* implement comprehensive monitoring system for CAWS ([3d45b49](https://github.com/Paths-Design/coding-agent-working-standard/commit/3d45b498b1b0a64d0a14c6807f156f35c80eae9a))
* Implement policy separation and waiver-based budget control ([0a6068b](https://github.com/Paths-Design/coding-agent-working-standard/commit/0a6068b06e2c85ce1825fbeac01a6ad1413d148c))
* Implement statistical test analysis v0.1 - learning quality system ([65a1657](https://github.com/Paths-Design/coding-agent-working-standard/commit/65a1657d2a011f3291872fdca00cb1875d2d463b))
* integrate advanced TODO analyzer with CAWS quality gates ([24385da](https://github.com/Paths-Design/coding-agent-working-standard/commit/24385dafc3c91d1f803294a6ba65654e2a599bd3))
* Integrate Cursor AI Code Tracking API ([c1b10f3](https://github.com/Paths-Design/coding-agent-working-standard/commit/c1b10f32ffd984a07f6d48f1732b5904c12a9ff2))
* Integrate hardened quality gates across CAWS ecosystem ([8fc03f4](https://github.com/Paths-Design/coding-agent-working-standard/commit/8fc03f41400aaabe6e679b31f011e607fc349c95))
* major UX improvements - interactive wizard, templates, validation suggestions ([2b457a1](https://github.com/Paths-Design/coding-agent-working-standard/commit/2b457a19ffbad5f59f3484db99338dbc09b38c0f))
* major UX improvements for CAWS provenance tracking ([d9095ee](https://github.com/Paths-Design/coding-agent-working-standard/commit/d9095ee5e65313b71ebf4ae5796bb5876139c1fb))
* manually create git hooks at monorepo root ([d05c373](https://github.com/Paths-Design/coding-agent-working-standard/commit/d05c373cca589e00d221d5c3af58478ca93f6f64))
* **mcp-server:** rename to [@paths](https://github.com/paths).design/caws-mcp-server ([aa7f36c](https://github.com/Paths-Design/coding-agent-working-standard/commit/aa7f36cf12a40dcbc70ecb48edb832ed4f0b3ce5))
* **mcp-server:** support published [@paths](https://github.com/paths).design/quality-gates package ([2794ae2](https://github.com/Paths-Design/coding-agent-working-standard/commit/2794ae2854d61aaeb8514388f9d6d3087c71397d))
* **p1:** achieve true 100% CLI/MCP parity with workflow and quality-monitor commands ([81aa370](https://github.com/Paths-Design/coding-agent-working-standard/commit/81aa3702de31248e563d89537c7063ef81fc579d))
* production readiness improvements ([0159875](https://github.com/Paths-Design/coding-agent-working-standard/commit/01598759705c463f4d10a90e0828ee031e89fa22))
* **quality-gates:** add placeholder governance gate ([26325ff](https://github.com/Paths-Design/coding-agent-working-standard/commit/26325ff8c30e22a56b6a8a357a255941dc0407ea))
* **quality-gates:** make gates language-agnostic, decompose MCP server god object, and reduce false positives ([15f2f0f](https://github.com/Paths-Design/coding-agent-working-standard/commit/15f2f0fbe728f0b23e6c3741aa14424d258af176))
* **release:** add multi-package semantic-release support ([7f4ebb0](https://github.com/Paths-Design/coding-agent-working-standard/commit/7f4ebb09f1801f4a8c5a217ad6dafc32f014cde7))
* synchronize updated todo-analyzer.mjs from agent-agency ([2bf6eb8](https://github.com/Paths-Design/coding-agent-working-standard/commit/2bf6eb82558e1958400354f1810e0558c3501e0a))
* update CAWS CLI for [@paths](https://github.com/paths).design publication ([9b28ed4](https://github.com/Paths-Design/coding-agent-working-standard/commit/9b28ed4cd61b1b363b0f8661fbb486dfc1027013))
* Update VS Code extension to v4.0.0 with multi-spec support ([30fb4c9](https://github.com/Paths-Design/coding-agent-working-standard/commit/30fb4c98820bb78f351cb5dbb45ca8e461f12564))
* updating the commands to be up to date ([1a3f9e0](https://github.com/Paths-Design/coding-agent-working-standard/commit/1a3f9e0d1f7749698feda30e92ac89bc97b3eece))
* **vscode-extension:** use esbuild for dependency bundling ([17eed0c](https://github.com/Paths-Design/coding-agent-working-standard/commit/17eed0c234e238aa5518c634750e8a12c86c831f))
* **vscode:** add publisher field and improve .vscodeignore for packaging ([7b6ba7e](https://github.com/Paths-Design/coding-agent-working-standard/commit/7b6ba7e1234b75c8a47796bf615845e8926043a8))
* **vscode:** auto-register MCP server with Cursor on extension activation ([c28b6c9](https://github.com/Paths-Design/coding-agent-working-standard/commit/c28b6c9f27516c02f8d1a15ab346b2a9b57a0a7b))


### Performance Improvements

* **mcp:** optimize findWorkingSpecs to eliminate timeout ([436ab63](https://github.com/Paths-Design/coding-agent-working-standard/commit/436ab635438e61e50d78477f2180573b7388739b))


### BREAKING CHANGES

* **mcp-server:** internal module structure completely changed.
MCP protocol interface remains stable.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
* **cli:** Quality gates suggestions now based on runtime availability rather than detected project language. Works universally across all programming languages (Python, Rust, Go, Java, C#, PHP, etc.).
* **mcp-server:** Package renamed from caws-mcp-server to @paths.design/caws-mcp-server
* **release:** None - backward compatible with existing CLI releases
* **cli:** None - backward compatible with existing setups
* **quality-gates:** push context now validates entire repository before push
* TODO analyzer now requires Python3 and provides enhanced analysis capabilities
* New quality-gates command requires Node.js 16+ and Python3 for full functionality
* Extension now supports multiple working specs instead of single legacy spec
* Spec resolution now prioritizes .caws/specs/ over legacy working-spec.yaml
* None - all changes are backward compatible

Features:
- Add PolicyManager with intelligent TTL-based caching (5-min default)
- Add SpecFileManager for bidirectional YAML ↔ JS conversion
- Enhanced waiver validation with explicit error messages
- Validate waiver ID format before loading (must be WV-\d{4})
- Check waiver gate coverage for budget_limit violations
- Improved policy loading diagnostics (path, cache, working dir)
- Warn when budget exceeded but no waivers referenced

Performance:
- 10x faster policy loading on cache hits (~15ms → ~1.5ms)
- Async policy loading throughout
- Reduced file I/O with intelligent caching

Fixes:
- Waiver validation failures now show actionable error messages
- Invalid waiver IDs show correct format requirement
- Missing waiver files show expected path and creation command
- Policy loading issues surface diagnostic information
- Add deprecation notice for change_budget field in working spec

Documentation:
- Add waiver-troubleshooting.md guide (415 lines)
- Add mcp-server-patterns.md guide (527 lines)
- Add reflexivity.md philosophy framework (406 lines)
- Comprehensive agent troubleshooting documentation

Testing:
- Add PolicyManager test suite (18 tests, 100% coverage)
- Add SpecFileManager test suite (22 tests, 100% coverage)
- Migrate budget derivation tests to async (15 tests)
- Total: 55 new tests, all passing

API Exports:
- Export PolicyManager class and singleton
- Export SpecFileManager class and singleton
- Convenience functions: loadPolicy(), clearCache(), getCacheStatus()
- Convenience functions: specToYaml(), yamlToSpec(), readSpecFile(), writeSpecFile()

Closes #TBD
* Working specs no longer accept change_budget fields - budgets are derived from policy.yaml with waivers providing the only sanctioned exception path. This closes the critical bypass vulnerability where agents could edit budgets to avoid quality gates.
* Templates are now bundled with CLI package

- Bundle all template files in CLI package for npm distribution
- Update template detection to prioritize bundled templates
- Add comprehensive AI agent documentation
- Create test environment for AI agent workflows
- Fix template directory not found error after npm install
- Add templates directory to .eslintignore

Fixes:
- Templates now available when installed via npm
- No external dependencies on @caws/template package
- AI agents can use --non-interactive flag successfully
- Clear documentation for AI agent usage patterns

Package size increased from 70KB to 552KB (acceptable trade-off)

Test environment available at /tmp/caws-agent-test
Documentation: docs/AI_AGENT_DX_IMPROVEMENTS.md
* First production release with complete CI/CD automation
* Migrated to automated publishing with OIDC authentication
* Updated CLI argument parsing for gates tool
* Updated error handling to throw exceptions instead of process.exit
* Updated to use OIDC for automated publishing
* Repository moved to Paths-Design organization with automated publishing
