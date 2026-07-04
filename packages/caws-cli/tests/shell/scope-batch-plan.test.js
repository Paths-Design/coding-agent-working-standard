'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const {
  groupScopePlanRemediations,
  runScopePlanCommand,
} = require('../../dist/shell/index');
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

function eventsPath(root) {
  return path.join(root, '.caws', 'events.jsonl');
}

function runPlan(root, opts) {
  const out = [];
  const err = [];
  const code = runScopePlanCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws scope plan', () => {
  test('rejects missing path input before composing state', () => {
    const root = mkRepo();
    const result = runPlan(root, {});

    expect(result.code).toBe(1);
    expect(result.err).toContain('provide at least one --path <path> or --paths-file <file>');
    expect(fs.existsSync(eventsPath(root))).toBe(false);
  });

  test('reads a paths file, ignores blanks/comments, and emits grouped JSON read-only', () => {
    const root = mkRepo();
    const pathsFile = path.join(root, 'paths.txt');
    fs.writeFileSync(pathsFile, [
      '# scope paths',
      '',
      'packages/a.ts',
      'packages/b.ts',
      '',
    ].join('\n'));

    const result = runPlan(root, {
      paths: ['packages/inline.ts'],
      pathsFile: 'paths.txt',
      json: true,
    });

    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({
      ok: true,
      read_only: true,
      count: 3,
      counts: { admit: 0, reject: 0, no_authority: 3, invalid_path: 0 },
    });
    expect(json.paths.map((p) => p.path)).toEqual([
      'packages/inline.ts',
      'packages/a.ts',
      'packages/b.ts',
    ]);
    expect(json.remediation_groups).toEqual([
      {
        command: 'caws specs list --status active',
        description: 'List active specs before choosing the authority context.',
        mutates: false,
        paths: ['packages/inline.ts', 'packages/a.ts', 'packages/b.ts'],
      },
      {
        command: 'caws worktree create <name> --spec <spec-id>',
        description: 'Create a governed worktree for the active spec that should own the edit.',
        mutates: true,
        paths: ['packages/inline.ts', 'packages/a.ts', 'packages/b.ts'],
      },
    ]);
    expect(fs.existsSync(eventsPath(root))).toBe(false);
  });
});

describe('groupScopePlanRemediations', () => {
  test('combines same-spec amend-scope adds into one command with repeated --add', () => {
    const groups = groupScopePlanRemediations([
      {
        decision: 'reject',
        rule: 'scope.reject.scope_in_miss',
        path: 'src/a.ts',
        normalizedPath: 'src/a.ts',
        bindingState: 'bound',
        mode: 'authoritative',
        message: 'miss',
        remediation: {
          summary: 'amend',
          commands: [
            {
              command: 'caws specs amend-scope FEATURE-001 --add src/a.ts',
              description: 'Add the path to scope.in, making it editable and worktree-claimed.',
              mutates: true,
            },
          ],
        },
        exit_code: 1,
      },
      {
        decision: 'reject',
        rule: 'scope.reject.scope_in_miss',
        path: 'src/b.ts',
        normalizedPath: 'src/b.ts',
        bindingState: 'bound',
        mode: 'authoritative',
        message: 'miss',
        remediation: {
          summary: 'amend',
          commands: [
            {
              command: 'caws specs amend-scope FEATURE-001 --add src/b.ts',
              description: 'Add the path to scope.in, making it editable and worktree-claimed.',
              mutates: true,
            },
          ],
        },
        exit_code: 1,
      },
    ]);

    expect(groups).toEqual([
      {
        command: 'caws specs amend-scope FEATURE-001 --add src/a.ts --add src/b.ts',
        description: 'Add the path to scope.in, making it editable and worktree-claimed.',
        mutates: true,
        paths: ['src/a.ts', 'src/b.ts'],
      },
    ]);
  });
});
