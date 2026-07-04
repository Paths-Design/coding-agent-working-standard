'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runInitCommand } = require('../../dist/shell/commands/init');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function runInit(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runInitCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
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

describe('caws init --plan', () => {
  test('help metadata lists read-only plan and JSON options', () => {
    const init = initMeta();
    expect(init.options.find((option) => option.flag === '--plan').description).toContain(
      'Preview'
    );
    expect(init.options.find((option) => option.flag === '--json').description).toContain(
      'with --plan'
    );
  });

  test('JSON plan for a fresh repo reports intended writes without mutating', () => {
    const root = makeTempRepo();
    const before = snapshotTree(root);

    const result = runInit(root, {
      plan: true,
      json: true,
      agentSurface: 'codex',
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      command: 'init',
      repo_root: fs.realpathSync(root),
      selected_surface: {
        surface: 'codex',
        reason: 'explicit',
        implemented: true,
      },
      canonical_state: {
        outcome: 'would_create',
        readOnly: true,
      },
      gitignore: {
        outcome: 'created',
        readOnly: true,
      },
      hook_pack: {
        read_only: true,
      },
      next_apply_command: 'caws init --agent-surface codex',
    });
    expect(payload.canonical_state.paths.map((entry) => entry.relPath)).toEqual([
      '.caws',
      '.caws/specs',
      '.caws/waivers',
      '.caws/policy.yaml',
      '.caws/worktrees.json',
      '.caws/agents.json',
    ]);
    expect(payload.hook_pack.actions.some((entry) => entry.action === 'created')).toBe(true);
    expect(fs.existsSync(path.join(root, '.caws'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  test('legacy residue is refused and still writes nothing', () => {
    const root = makeTempRepo();
    fs.mkdirSync(path.join(root, '.caws'), { recursive: true });
    fs.writeFileSync(path.join(root, '.caws', 'working-spec.yaml'), 'id: LEGACY\n', 'utf8');
    const before = snapshotTree(root);

    const result = runInit(root, {
      plan: true,
      json: true,
    });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: false,
      read_only: true,
      command: 'init',
      repo_root: fs.realpathSync(root),
    });
    expect(payload.errors[0].rule).toBe('store.init.legacy_residue');
    expect(fs.existsSync(path.join(root, '.caws', 'policy.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  test('initialized repo reports no canonical writes and preserves apply behavior', () => {
    const root = makeTempRepo();
    const initialized = initProject(root);
    if (!initialized.ok) {
      throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
    }
    const before = snapshotTree(root);

    const result = runInit(root, {
      plan: true,
      agentSurface: 'none',
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain('caws init plan: read-only preview');
    expect(result.out).toContain('outcome: already_initialized');
    expect(result.out).toContain('Next apply command: caws init --agent-surface none');
    expect(snapshotTree(root)).toEqual(before);

    const apply = runInit(root, { agentSurface: 'none' });
    expect(apply.code).toBe(0);
    expect(apply.out).toContain('project already initialized; no changes.');
  });
});
