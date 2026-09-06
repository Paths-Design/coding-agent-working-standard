'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  adoptMachineAdapter,
  extractMachineHandlers,
} = require('../../dist/init/machine-adapter-policy');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
let root, repo, home, opts;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-adoption-'));
  repo = path.join(root, 'repo');
  home = path.join(root, 'machine');
  fs.mkdirSync(repo);
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }).status).toBe(0);
  const init = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../dist/index.js'), 'init', '--agent-surface', 'codex'],
    {
      cwd: repo,
      env: { ...process.env, CI: 'true', CAWS_HOME: home },
      encoding: 'utf8',
    }
  );
  expect(init.status).toBe(0);
  installMachineRuntime({ home });
  opts = { repo, home, surface: 'codex', userHome: path.join(root, 'user') };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function bytes() {
  const out = {};
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(repo, p)] = fs.readFileSync(p).toString('base64');
    }
  }
  walk(repo);
  return out;
}

test('plan preserves every byte; apply keeps custom handler order and unrelated hooks; repeat is a no-op', () => {
  const dispatcher = path.join(repo, '.caws/hooks/dispatch/pre_tool_use.sh');
  fs.writeFileSync(
    dispatcher,
    fs.readFileSync(dispatcher, 'utf8').replace('  cwd-guard.sh', '  custom.sh\n  cwd-guard.sh')
  );
  fs.writeFileSync(path.join(repo, '.caws/hooks/custom.sh'), '#!/bin/bash\nexit 0\n', {
    mode: 0o755,
  });
  const config = path.join(repo, '.codex/hooks.json');
  const wiring = JSON.parse(fs.readFileSync(config));
  wiring.hooks.PreToolUse.push({
    matcher: 'Read',
    hooks: [{ type: 'command', command: 'echo user-hook' }],
  });
  fs.writeFileSync(config, JSON.stringify(wiring));
  const before = bytes();
  const plan = adoptMachineAdapter({ ...opts, plan: true });
  expect(bytes()).toEqual(before);
  expect(plan.policy.surfaces.codex.events.pre_tool_use.handlers.slice(0, 3)).toEqual([
    'agent-heartbeat.sh',
    'custom.sh',
    'cwd-guard.sh',
  ]);
  expect(plan.policy.surfaces.codex.libraries).toEqual({});
  expect(plan.changes).toHaveLength(2);
  expect(adoptMachineAdapter(opts).changed).toBe(true);
  const after = bytes();
  for (const [p, value] of Object.entries(before))
    if (p !== '.codex/hooks.json') expect(after[p]).toBe(value);
  const entries = JSON.parse(fs.readFileSync(config)).hooks.PreToolUse.flatMap((g) => g.hooks);
  expect(entries.map((e) => e.command).filter((c) => c.includes('/bin/caws-hook'))).toHaveLength(1);
  expect(entries.map((e) => e.command)).toContain('echo user-hook');
  expect(adoptMachineAdapter(opts).changed).toBe(false);
});

test('custom dispatcher code is refused without executing it; explicit reviewed policy is accepted', () => {
  const reviewed = adoptMachineAdapter({ ...opts, plan: true }).policy.surfaces.codex;
  const dispatcher = path.join(repo, '.caws/hooks/dispatch/pre_tool_use.sh');
  fs.appendFileSync(dispatcher, '\necho custom-semantic-change\n');
  const before = bytes();
  expect(() => adoptMachineAdapter(opts)).toThrow(/Custom dispatcher logic/);
  expect(bytes()).toEqual(before);
  const policy = path.join(root, 'reviewed.json');
  fs.writeFileSync(
    policy,
    JSON.stringify({
      libraries: {},
      events: { pre_tool_use: { hooks_dir: '.caws/hooks', handlers: ['custom.sh'] } },
    })
  );
  fs.writeFileSync(path.join(repo, '.caws/hooks/custom.sh'), '#!/bin/bash\nexit 0\n', {
    mode: 0o755,
  });
  // Existing lifecycle wiring cannot silently disappear under a replacement policy.
  expect(() => adoptMachineAdapter({ ...opts, fromFile: policy })).toThrow(/has no policy/);
  reviewed.events.pre_tool_use.handlers = ['custom.sh'];
  fs.writeFileSync(policy, JSON.stringify(reviewed));
  expect(adoptMachineAdapter({ ...opts, fromFile: policy }).changed).toBe(true);
});

test('intentional library growth is declared explicitly and never overwritten', () => {
  const p = path.join(repo, '.codex/hooks/lib/emit.sh');
  fs.appendFileSync(p, '\n# project-owned diagnostic customization\n');
  const before = fs.readFileSync(p);
  const result = adoptMachineAdapter(opts);
  expect(result.policy.surfaces.codex.libraries['emit.sh']).toBe('.codex/hooks/lib/emit.sh');
  expect(fs.readFileSync(p)).toEqual(before);
});

test('global plus local CAWS wiring is refused; no additional dispatcher is installed', () => {
  const p = path.join(opts.userHome, '.codex/hooks.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ command: 'bash ~/.caws/hooks/dispatch/pre_tool_use.sh' }] }],
      },
    })
  );
  const before = bytes();
  expect(() => adoptMachineAdapter(opts)).toThrow(/Duplicate or ambiguous CAWS wiring/);
  expect(bytes()).toEqual(before);
});

test('a dynamic handler array is never evaluated while extracting policy', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../templates/hook-packs/shared/dispatch/pre_tool_use.sh'),
    'utf8'
  );
  expect(() =>
    extractMachineHandlers(source.replace('  cwd-guard.sh', '  "$(echo injected.sh)"'), source)
  ).toThrow(/Nonliteral handler/);
});

test('shared adapter growth is preserved, while bootstrap customization requires reconciliation', () => {
  const emit = path.join(repo, '.caws/hooks/lib/emit.sh');
  fs.appendFileSync(emit, '\n# local shared emitter growth\n');
  expect(
    adoptMachineAdapter({ ...opts, plan: true }).policy.surfaces.codex.libraries['emit.sh']
  ).toBe('.caws/hooks/lib/emit.sh');
  const loader = path.join(repo, '.caws/hooks/lib/agent-surface.sh');
  fs.appendFileSync(loader, '\n# local loader customization\n');
  const before = bytes();
  expect(() => adoptMachineAdapter(opts)).toThrow(/bootstrap library growth/);
  expect(bytes()).toEqual(before);
});
