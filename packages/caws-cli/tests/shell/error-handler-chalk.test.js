'use strict';

// Regression for the chalk 5.x ESM interop crash on CLI error paths.
//
// chalk 5 is ESM-only; under Node's require(esm), `require('chalk')` returns
// the module namespace with the callable instance on `.default`. Every
// `chalk.<color>()` call in index.js / error-handler.js therefore threw
// "chalk.red is not a function", so any CLI error (unknown command, commander
// parse error, domain failure) produced a TypeError stack instead of the
// formatted error. These tests spawn the real dist CLI on error paths and
// assert the message renders without the crash.

const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return root;
}

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'error-handler-chalk-test' },
  });
}

describe('CLI error paths render without the chalk ESM crash', () => {
  test('A1: unknown command renders the suggestion block, no TypeError', () => {
    const root = mkRepo();
    const result = spawnCli(root, ['frobnicate']);
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain('chalk.red is not a function');
    expect(output).not.toContain('TypeError');
    expect(output).toContain('Unknown command: frobnicate');
    expect(result.status).not.toBe(0);
  });

  test('A2: commander parse error reaches handleCliError without crashing it', () => {
    const root = mkRepo();
    // `--spec` requires a value; commander rejects and the CLI error handler
    // formats it — the pre-fix crash site (error-handler.js chalk.red call).
    const result = spawnCli(root, ['gates', 'run', '--spec']);
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain('chalk.red is not a function');
    expect(output).not.toContain('TypeError');
    expect(output).toContain("--spec");
    expect(result.status).not.toBe(0);
  });

  test('A3: domain failure (gates run without --spec) renders the ruled error line', () => {
    const root = mkRepo();
    const result = spawnCli(root, ['gates', 'run']);
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain('chalk.red is not a function');
    expect(output).not.toContain('TypeError');
    expect(output).toContain('caws gates run: --spec is required.');
    expect(result.status).toBe(1);
  });
});
