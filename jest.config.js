// Root jest entry point. It owns no test configuration of its own — it
// delegates to each package's config, so `npx jest` from the repo root runs
// exactly what `cd packages/caws-cli && npx jest` runs.
//
// This file previously declared its own preset/roots/transform for the
// pre-absorption layout (packages/caws-cli + packages/caws-kernel +
// packages/caws-types, each with src/ tests). After CAWS-ABSORB-KERNEL-01
// that layout is gone: caws-kernel/ and caws-types/ hold nothing but
// node_modules, and caws-cli's real config is a two-project split (compiled
// dist/ for the CLI corpus, ts-jest for the absorbed kernel tests) that this
// file contradicted. Its `'^.+\\.js$': 'babel-jest'` transform also required
// @babel/preset-env, which is not a dependency of this repo — so a bare
// `npx jest` at the root reported 125 of 137 suites "failed to run" in about
// five seconds. That is a catastrophic-looking verdict produced entirely by
// stale configuration, on a tree whose tests pass.
//
// Delegating is what makes the root a real entry point instead of a trap:
// there is one configuration per package, and the root cannot drift from it.
// [CAWS-DEFECT-TEST-VERDICT-INTEGRITY-01]

// Jest does NOT support a nested `projects` key: naming the package DIRECTORY
// here (`projects: ['<rootDir>/packages/caws-cli']`) loads that package's
// config, warns "Option 'projects' is not supported in an individual project
// configuration", and then silently DROPS both of its projects — leaving jest
// running on defaults, where the caws-cli corpus happens to pass and every
// tests/kernel/**/*.test.ts fails to parse for want of ts-jest. So the
// package's projects are lifted to this level, each pinned to the package as
// its own rootDir so the `<rootDir>/...` paths inside them keep resolving to
// packages/caws-cli rather than to the repo root.

const cliProjects = require('./packages/caws-cli/jest.config.js').projects;

/** @type {import('jest').Config} */
module.exports = {
  projects: cliProjects.map((project) => ({
    ...project,
    rootDir: '<rootDir>/packages/caws-cli',
  })),
};
