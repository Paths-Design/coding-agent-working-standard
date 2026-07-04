'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

function snapshotTree(root) {
  const entries = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs);
      const stat = fs.statSync(abs);
      entries.push(`${rel}:${stat.isDirectory() ? 'dir' : fs.readFileSync(abs, 'utf8')}`);
      if (stat.isDirectory()) visit(abs);
    }
  }
  visit(root);
  return entries;
}

function initMeta() {
  return COMMAND_SURFACE_METADATA.find((command) => command.name === 'init');
}

describe('caws init --dry-run alias', () => {
  test('metadata exposes dry-run as a read-only plan alias', () => {
    const init = initMeta();
    expect(init.options.find((option) => option.flag === '--dry-run').description).toContain(
      'Compatibility alias for --plan'
    );
    expect(init.options.find((option) => option.flag === '--json').description).toContain(
      'with --plan or --dry-run'
    );
  });

  test('human dry-run uses the same read-only plan path without mutating', () => {
    const root = makeTempRepo();
    const before = snapshotTree(root);

    const plan = runCli(root, ['init', '--plan', '--agent-surface', 'none']);
    const dryRun = runCli(root, ['init', '--dry-run', '--agent-surface', 'none']);

    expect(plan.status).toBe(0);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stderr).toBe('');
    expect(dryRun.stdout).toBe(plan.stdout);
    expect(dryRun.stdout).toContain('caws init plan: read-only preview');
    expect(dryRun.stdout).toContain('Next apply command: caws init --agent-surface none');
    expect(fs.existsSync(path.join(root, '.caws'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  test('json dry-run emits the same JSON plan shape as plan json', () => {
    const root = makeTempRepo();
    const before = snapshotTree(root);

    const plan = runCli(root, ['init', '--plan', '--json', '--agent-surface', 'codex']);
    const dryRun = runCli(root, ['init', '--dry-run', '--json', '--agent-surface', 'codex']);

    expect(plan.status).toBe(0);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stderr).toBe('');
    expect(JSON.parse(dryRun.stdout)).toEqual(JSON.parse(plan.stdout));
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      ok: true,
      read_only: true,
      command: 'init',
      canonical_state: { outcome: 'would_create', readOnly: true },
      gitignore: { outcome: 'created', readOnly: true },
      hook_pack: { read_only: true },
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  test('nested help lists dry-run with narrowed alias semantics', () => {
    const root = makeTempRepo();

    const result = runCli(root, ['init', '--help']);
    const help = result.stdout.replace(/\s+/g, ' ');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--plan');
    expect(result.stdout).toContain('--dry-run');
    expect(help).toContain('Compatibility alias for --plan');
    expect(help).toContain('previews init changes without writing anything');
  });
});
