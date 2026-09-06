'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  installMachineRuntime,
  rollbackMachineRuntime,
} = require('../../dist/init/machine-adapters');

const templatesRoot = path.resolve(__dirname, '../../templates/hook-packs');
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws machine runtime '));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function repository(name, handlers) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, '.caws/hooks'), { recursive: true });
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, encoding: 'utf8' });
  expect(git.status).toBe(0);
  for (const [script, body] of Object.entries(handlers)) {
    fs.writeFileSync(path.join(repo, '.caws/hooks', script), '#!/bin/bash\n' + body, {
      mode: 0o755,
    });
  }
  fs.writeFileSync(
    path.join(repo, '.caws/hooks/adapter-policy.json'),
    JSON.stringify({
      version: 1,
      surfaces: {
        codex: {
          events: {
            pre_tool_use: {
              hooks_dir: '.caws/hooks',
              handlers: Object.keys(handlers),
            },
          },
          libraries: {},
        },
      },
    })
  );
  return repo;
}

function invoke(home, repo, session = 'machine-runtime-test', event = 'pre_tool_use') {
  return spawnSync('python3', [path.join(home, 'bin/caws-hook'), 'codex', event], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: repo },
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'example.ts' },
      session_id: session,
    }),
  });
}

test('planning writes nothing; install is idempotent and runs distinct project guards', () => {
  const home = path.join(root, 'home');
  const plan = installMachineRuntime({ home, templatesRoot, plan: true });
  expect(plan.changed).toBe(true);
  expect(fs.existsSync(home)).toBe(false);
  const installed = installMachineRuntime({ home, templatesRoot });
  expect(installed.digest).toBe(plan.digest);
  expect(installMachineRuntime({ home, templatesRoot }).changed).toBe(false);
  const a = repository('a', {
    'first.sh': 'echo first >&2\n',
    'deny.sh': 'echo \'{"decision":"block","reason":"A denied"}\'\nexit 2\n',
    'never.sh': 'echo SHOULD_NOT_RUN >&2\n',
  });
  const b = repository('b', {
    'only.sh': 'echo \'{"hookSpecificOutput":{"additionalContext":"B allowed"}}\'\n',
  });
  const ra = invoke(home, a);
  expect(ra.status).toBe(2);
  expect(ra.stderr).toContain('first');
  expect(ra.stderr).not.toContain('SHOULD_NOT_RUN');
  expect(JSON.parse(ra.stdout).reason).toBe('A denied');
  const rb = invoke(home, b);
  expect(rb.status).toBe(0);
  expect(JSON.parse(rb.stdout).hookSpecificOutput.additionalContext).toBe('B allowed');
});

test('one runtime update reaches two projects without project edits; rollback restores the digest', () => {
  const home = path.join(root, 'home');
  const sources = path.join(root, 'templates');
  fs.cpSync(templatesRoot, sources, {
    recursive: true,
    filter: (p) =>
      !path.relative(templatesRoot, p).includes('__pycache__') &&
      !path.relative(templatesRoot, p).includes('.caws/'),
  });
  const first = installMachineRuntime({ home, templatesRoot: sources });
  const a = repository('a', {
    'report.sh':
      'echo "$CAWS_ADAPTER_RUNTIME_DIGEST ${CAWS_TEST_ADAPTER_REVISION:-original}" >&2\n',
  });
  const b = repository('b', {
    'report.sh':
      'echo "$CAWS_ADAPTER_RUNTIME_DIGEST ${CAWS_TEST_ADAPTER_REVISION:-original}" >&2\n',
  });
  const policies = [a, b].map((r) =>
    fs.readFileSync(path.join(r, '.caws/hooks/adapter-policy.json'))
  );
  for (const repo of [a, b]) expect(invoke(home, repo).stderr).toContain(first.digest);
  fs.appendFileSync(
    path.join(sources, 'shared/lib/session-id.sh'),
    '\nexport CAWS_TEST_ADAPTER_REVISION=updated\n'
  );
  const second = installMachineRuntime({ home, templatesRoot: sources });
  expect(second.digest).not.toBe(first.digest);
  for (const [i, repo] of [a, b].entries()) {
    const result = invoke(home, repo);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(second.digest);
    expect(result.stderr).toContain('updated');
    expect(fs.readFileSync(path.join(repo, '.caws/hooks/adapter-policy.json'))).toEqual(
      policies[i]
    );
  }
  expect(rollbackMachineRuntime({ home, plan: true }).digest).toBe(first.digest);
  expect(invoke(home, a).stderr).toContain(second.digest);
  rollbackMachineRuntime({ home });
  expect(invoke(home, a).stderr).toContain(first.digest);
  expect(invoke(home, a).stderr).toContain('original');
});

test('corrupt runtime and missing declared guards fail closed; unadopted projects are identified', () => {
  const home = path.join(root, 'home');
  const installed = installMachineRuntime({ home, templatesRoot });
  const repo = repository('a', { 'required.sh': 'exit 0\n' });
  fs.unlinkSync(path.join(repo, '.caws/hooks/required.sh'));
  expect(invoke(home, repo).status).toBe(2);
  fs.unlinkSync(path.join(repo, '.caws/hooks/adapter-policy.json'));
  const absent = invoke(home, repo);
  expect(absent.status).toBe(2);
  expect(absent.stderr).toContain('adopt');
  fs.appendFileSync(
    path.join(home, 'lib/runtimes', installed.digest, 'lib/emit.sh'),
    '\n# unreviewed drift\n'
  );
  expect(() => installMachineRuntime({ home, templatesRoot })).toThrow(
    /modified|digest|integrity/i
  );
});

test('invalid policy paths and symlinked machine destinations are refused without execution', () => {
  const home = path.join(root, 'home');
  const external = path.join(root, 'external');
  fs.mkdirSync(home);
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(home, 'lib'));
  expect(() => installMachineRuntime({ home, templatesRoot })).toThrow(/symlink/i);
  expect(fs.readdirSync(external)).toEqual([]);
});

test('failed activation preserves the previous executable runtime; conflicting install and launcher drift are refused', () => {
  const home = path.join(root, 'home');
  const sources = path.join(root, 'sources');
  fs.cpSync(templatesRoot, sources, { recursive: true });
  const first = installMachineRuntime({ home, templatesRoot: sources });
  const repo = repository('project', { 'guard.sh': 'echo healthy >&2\n' });
  fs.appendFileSync(path.join(sources, 'shared/lib/session-id.sh'), '\n# new snapshot\n');
  const rename = fs.renameSync;
  const fault = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === path.join(home, 'state/adapter-runtime.json'))
      throw new Error('fixture activation failure');
    return rename(from, to);
  });
  try {
    expect(() => installMachineRuntime({ home, templatesRoot: sources })).toThrow(
      /activation failure/
    );
  } finally {
    fault.mockRestore();
  }
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state/adapter-runtime.json'))).digest).toBe(
    first.digest
  );
  expect(invoke(home, repo).status).toBe(0);
  fs.mkdirSync(path.join(home, 'state/adapter-install.lock'));
  expect(() => installMachineRuntime({ home, templatesRoot: sources })).toThrow(/locked/);
  fs.rmdirSync(path.join(home, 'state/adapter-install.lock'));
  installMachineRuntime({ home, templatesRoot: sources });
  fs.appendFileSync(path.join(home, 'bin/caws-hook'), '\n# local growth\n');
  expect(() => rollbackMachineRuntime({ home })).toThrow(/launcher modified/);
});

test('quiet outside governed repositories; traversal, symlink policies and missing runtimes fail before guard execution', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home });
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  expect(invoke(home, plain).status).toBe(0);
  const repo = repository('governed', { 'guard.sh': 'echo MUST_NOT_RUN >&2\n' });
  const file = path.join(repo, '.caws/hooks/adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(file));
  policy.surfaces.codex.events.pre_tool_use.hooks_dir = '../outside';
  fs.writeFileSync(file, JSON.stringify(policy));
  const escaped = invoke(home, repo);
  expect(escaped.status).toBe(2);
  expect(escaped.stderr).not.toContain('MUST_NOT_RUN');
  fs.unlinkSync(path.join(home, 'state/adapter-runtime.json'));
  expect(invoke(home, repo).status).toBe(2);
});
