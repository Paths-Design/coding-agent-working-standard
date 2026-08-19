'use strict';

/**
 * CAWS-DEFECT-INIT-ACTION-POSITIONALS-REFUSED-01 — full CLI parse path.
 *
 * `caws init diff` and `caws init port <path> --from <file>` are documented
 * in `caws init --help` (INIT_COMMAND_META names both subcommands) but were
 * refused before their action ran: INIT_COMMAND_META declared options only
 * (no argument/arguments field), so guardExcessArguments computed 0 declared
 * positionals for init, while register.ts bolted the two positionals onto
 * the Command object AFTER defineFlat() via `.argument()` — Commander
 * accepted them, but the metadata-driven guard did not know they existed and
 * refused every invocation with "unexpected extra argument(s)". Handler-level
 * tests (tests/init/*) call runInitCommand directly and bypass Commander
 * entirely, which is why this shipped undetected. These tests spawn
 * dist/index.js so the argument-declaration/enforcement agreement itself is
 * what is pinned.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

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

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'init-action-positionals-test' },
  });
}

describe('caws init action positionals (full CLI parse path)', () => {
  test('A1: `init diff` reaches the diff action — exits 0 and prints pack output, not the excess-args error', () => {
    const root = mkRepo();
    const result = spawnCli(root, ['init', 'diff']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain('unexpected extra argument(s)');
    expect(output).not.toContain('This command takes no positional arguments');
    expect(output).toContain('Hook pack diff');
  });

  test('A2: `init port <path>` without --from reaches port\'s own usage error, not the excess-args refusal', () => {
    const root = mkRepo();
    const result = spawnCli(root, ['init', 'port', '.caws/hooks/scope-guard.sh']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).not.toContain('unexpected extra argument(s)');
    expect(output).toContain('caws init port: --from <staging-file> is required.');
  });

  test('A3: `init a b c` (three positionals) is still refused, naming the excess token "c"', () => {
    const root = mkRepo();
    const result = spawnCli(root, ['init', 'a', 'b', 'c']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('unexpected extra argument(s): c');
    expect(output).toContain('at most 2 positional arguments');
  });

  test('A4 control: a leaf with no declared positionals (specs list) still refuses a stray positional — the guard is not weakened globally', () => {
    const root = mkRepo();
    const result = spawnCli(root, ['specs', 'list', 'stray-token']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('unexpected extra argument(s): stray-token');
    expect(output).toContain('This command takes no positional arguments');
  });
});
