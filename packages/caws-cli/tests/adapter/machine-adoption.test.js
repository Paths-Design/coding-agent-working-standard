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
  fs.mkdirSync(path.join(root, 'user'));
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }).status).toBe(0);
  const init = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../dist/index.js'), 'init', '--agent-surface', 'codex'],
    {
      cwd: repo,
      env: { ...process.env, HOME: path.join(root, 'user'), CI: 'true', CAWS_HOME: home },
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

test('the effective vendor customization survives even when its shared fallback also changed', () => {
  const p = path.join(repo, '.codex/hooks/lib/emit.sh');
  fs.appendFileSync(p, '\nemit_ask() { emit_block "project-refusal:$1"; }\n');
  fs.appendFileSync(path.join(repo, '.caws/hooks/lib/emit.sh'), '\n# inactive fallback growth\n');
  const before = fs.readFileSync(p);
  useProbe(
    'pre_tool_use',
    'source "$CAWS_SHARED_LIB_DIR/agent-surface.sh"\ncaws_source_lib emit.sh\nemit_ask fixture\n'
  );
  const config = path.join(repo, '.codex/hooks.json');
  const old = runHook(JSON.parse(fs.readFileSync(config)).hooks.PreToolUse[0].hooks[0].command);
  expect(JSON.parse(old.stdout)).toEqual({ decision: 'block', reason: 'project-refusal:fixture' });
  const result = adoptMachineAdapter(opts);
  expect(result.policy.surfaces.codex.libraries['emit.sh']).toBe('.codex/hooks/lib/emit.sh');
  expect(fs.readFileSync(p)).toEqual(before);
  const next = runHook(JSON.parse(fs.readFileSync(config)).hooks.PreToolUse[0].hooks[0].command);
  expect(next.status).toBe(old.status);
  expect(JSON.parse(next.stdout)).toEqual(JSON.parse(old.stdout));
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

function useProbe(event, body) {
  const dispatcher = path.join(repo, '.caws/hooks/dispatch', `${event}.sh`);
  fs.writeFileSync(
    dispatcher,
    fs
      .readFileSync(dispatcher, 'utf8')
      .replace(/^(HANDLERS|_ALL_HANDLERS)=\([\s\S]*?^\)/m, '$1=(\n  probe.sh\n)')
  );
  fs.writeFileSync(path.join(repo, '.caws/hooks/probe.sh'), '#!/bin/bash\n' + body, {
    mode: 0o755,
  });
}

function runHook(command, event = 'PreToolUse', surface = 'codex') {
  return spawnSync('bash', ['-c', command], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: opts.userHome,
      CAWS_HOME: home,
      CAWS_AGENT_SURFACE: surface,
      CAWS_PROJECT_DIR: repo,
      CLAUDE_PROJECT_DIR: repo,
      CAWS_SHARED_LIB_DIR: path.join(repo, '.caws/hooks/lib'),
    },
    input: JSON.stringify({
      cwd: repo,
      session_id: 'adoption-fixture',
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command: 'true' },
    }),
  });
}

test('shadowed shared growth does not replace the effective Codex denial emitter', () => {
  const emit = path.join(repo, '.caws/hooks/lib/emit.sh');
  fs.appendFileSync(emit, '\n# local shared emitter growth\n');
  const beforeBytes = fs.readFileSync(emit);
  useProbe(
    'pre_tool_use',
    'source "$CAWS_SHARED_LIB_DIR/agent-surface.sh"\ncaws_source_lib emit.sh\nemit_ask fixture-denial\n'
  );
  const config = path.join(repo, '.codex/hooks.json');
  const before = runHook(JSON.parse(fs.readFileSync(config)).hooks.PreToolUse[0].hooks[0].command);
  expect(before.status).toBe(2);
  expect(JSON.parse(before.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  adoptMachineAdapter(opts);
  const after = runHook(JSON.parse(fs.readFileSync(config)).hooks.PreToolUse[0].hooks[0].command);
  expect(after.status).toBe(before.status);
  expect(JSON.parse(after.stdout)).toEqual(JSON.parse(before.stdout));
  expect(fs.readFileSync(emit)).toEqual(beforeBytes);
});

test('bootstrap customization requires reconciliation', () => {
  const loader = path.join(repo, '.caws/hooks/lib/agent-surface.sh');
  fs.appendFileSync(loader, '\n# local loader customization\n');
  const before = bytes();
  expect(() => adoptMachineAdapter(opts)).toThrow(/bootstrap library growth/);
  expect(bytes()).toEqual(before);
});

test.each(['agent-surface.sh', 'runtime-paths.sh'])(
  'explicit %s bootstrap overrides are refused before adoption writes',
  (name) => {
    const selected = adoptMachineAdapter({ ...opts, plan: true }).policy.surfaces.codex;
    selected.libraries[name] = '.caws/hooks/custom-bootstrap.sh';
    fs.writeFileSync(path.join(repo, selected.libraries[name]), 'echo custom-bootstrap >&2\n');
    const policy = path.join(root, 'reviewed.json');
    fs.writeFileSync(policy, JSON.stringify(selected));
    const before = bytes();
    expect(() => adoptMachineAdapter({ ...opts, fromFile: policy })).toThrow(
      /Bootstrap library cannot be overridden/
    );
    expect(bytes()).toEqual(before);
  }
);

test.each(['agent-surface.sh', 'runtime-paths.sh'])(
  'runtime refuses an ignored %s bootstrap override before running a handler',
  (name) => {
    useProbe('pre_tool_use', 'echo handler-must-not-run >&2\n');
    adoptMachineAdapter(opts);
    const file = path.join(repo, '.caws/hooks/adapter-policy.json');
    const policy = JSON.parse(fs.readFileSync(file));
    policy.surfaces.codex.libraries[name] = '.caws/hooks/custom-bootstrap.sh';
    fs.writeFileSync(
      path.join(repo, policy.surfaces.codex.libraries[name]),
      'echo custom-bootstrap >&2\n'
    );
    fs.writeFileSync(file, JSON.stringify(policy));
    const wiring = JSON.parse(fs.readFileSync(path.join(repo, '.codex/hooks.json')));
    const result = runHook(wiring.hooks.PreToolUse[0].hooks[0].command);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' });
    expect(result.stderr).toContain('Bootstrap library cannot be overridden');
    expect(result.stderr).not.toContain('handler-must-not-run');
  }
);

test('native matchers, hook attributes and relative hook order survive adoption', () => {
  const config = path.join(repo, '.codex/hooks.json');
  const wiring = JSON.parse(fs.readFileSync(config));
  const hook = wiring.hooks.PreToolUse[0].hooks[0];
  wiring.hooks.PreToolUse = [
    {
      matcher: '*',
      hooks: [
        { type: 'command', command: 'echo before' },
        { ...hook, timeout: 120, statusMessage: 'custom status' },
        { type: 'command', command: 'echo after' },
      ],
    },
  ];
  fs.writeFileSync(config, JSON.stringify(wiring));
  adoptMachineAdapter(opts);
  const actual = JSON.parse(fs.readFileSync(config));
  const expected = JSON.parse(JSON.stringify(wiring));
  expected.hooks.PreToolUse[0].hooks[1].command = actual.hooks.PreToolUse[0].hooks[1].command;
  for (const event of Object.keys(wiring.hooks)) {
    if (event !== 'PreToolUse')
      expected.hooks[event][0].hooks[0].command = actual.hooks[event][0].hooks[0].command;
  }
  expect(actual).toEqual(expected);
  expect(actual.hooks.PreToolUse[0].hooks[1].command).toContain('/bin/caws-hook');
  expect(adoptMachineAdapter(opts).changed).toBe(false);
});

test.each(['claude-code', 'qwen-code'])(
  '%s adoption retains the native tool coverage and timeout units',
  (surface) => {
    const init = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../dist/index.js'), 'init', '--agent-surface', surface],
      { cwd: repo, env: { ...process.env, CI: 'true', CAWS_HOME: home }, encoding: 'utf8' }
    );
    expect(init.status).toBe(0);
    const vendor = surface === 'claude-code' ? '.claude' : '.qwen';
    const config = path.join(repo, vendor, 'settings.json');
    // Qwen init can intentionally leave wiring as a reviewed example. Adoption
    // consumes an existing native registration, so install its shipped shape in
    // the fixture explicitly rather than depending on machine-level settings.
    const {
      CANONICAL_HOOK_ENTRIES,
      CANONICAL_QWEN_HOOK_ENTRIES,
    } = require('../../dist/init/hook-install');
    const entries =
      surface === 'claude-code' ? CANONICAL_HOOK_ENTRIES : CANONICAL_QWEN_HOOK_ENTRIES;
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      JSON.stringify({
        hooks: Object.fromEntries(
          Object.entries(entries).map(([event, entry]) => [event, [entry]])
        ),
      })
    );
    const before = JSON.parse(fs.readFileSync(config));
    adoptMachineAdapter({ ...opts, surface });
    const after = JSON.parse(fs.readFileSync(config));
    for (const event of Object.keys(before.hooks))
      before.hooks[event][0].hooks[0].command = after.hooks[event][0].hooks[0].command;
    expect(after).toEqual(before);
  }
);

test('literal environment settings still reach guards, including post-tool disabled handlers', () => {
  useProbe('post_tool_use', 'printf "probe:%s\\n" "$CAWS_FIXTURE_SETTING" >&2\n');
  const config = path.join(repo, '.codex/hooks.json');
  const wiring = JSON.parse(fs.readFileSync(config));
  const hook = wiring.hooks.PostToolUse[0].hooks[0];
  hook.command =
    "CAWS_FIXTURE_SETTING='kept value' CAWS_DISABLED_HANDLERS=probe.sh bash .caws/hooks/dispatch/post_tool_use.sh";
  fs.writeFileSync(config, JSON.stringify(wiring));
  const before = runHook(hook.command, 'PostToolUse');
  expect(before.status).toBe(0);
  expect(before.stderr).not.toContain('probe:');
  adoptMachineAdapter(opts);
  const migrated = JSON.parse(fs.readFileSync(config)).hooks.PostToolUse[0].hooks[0].command;
  const disabled = runHook(migrated, 'PostToolUse');
  expect(disabled.status).toBe(0);
  expect(disabled.stderr).not.toContain('probe:');
  const enabled = runHook(
    migrated.replace('CAWS_DISABLED_HANDLERS=probe.sh', 'CAWS_DISABLED_HANDLERS='),
    'PostToolUse'
  );
  expect(enabled.status).toBe(0);
  expect(enabled.stderr).toContain('probe:kept value');
  const other = runHook(
    migrated.replace('CAWS_DISABLED_HANDLERS=probe.sh', 'CAWS_DISABLED_HANDLERS=probe.sh-other'),
    'PostToolUse'
  );
  expect(other.status).toBe(0);
  expect(other.stderr).toContain('probe:kept value');
});

test.each([
  'bash .caws/hooks/dispatch/pre_tool_use.sh; echo custom-tail',
  'CUSTOM="$(touch should-not-exist)" bash .caws/hooks/dispatch/pre_tool_use.sh',
  'bash .caws/hooks/custom-entry.sh',
])(
  'ambiguous native command is refused without executing or changing project files: %s',
  (command) => {
    const config = path.join(repo, '.codex/hooks.json');
    const wiring = JSON.parse(fs.readFileSync(config));
    wiring.hooks.PreToolUse[0].hooks[0].command = command;
    fs.writeFileSync(config, JSON.stringify(wiring));
    const before = bytes();
    expect(() => adoptMachineAdapter(opts)).toThrow(/native command.*reconcil/i);
    expect(bytes()).toEqual(before);
  }
);

test('an explicitly re-enabled quality handler survives Codex adoption', () => {
  useProbe('post_tool_use', 'echo enabled-quality-handler >&2\n');
  const dispatcher = path.join(repo, '.caws/hooks/dispatch/post_tool_use.sh');
  fs.writeFileSync(
    dispatcher,
    fs.readFileSync(dispatcher, 'utf8').replace('  probe.sh', '  quality-check.sh')
  );
  fs.copyFileSync(
    path.join(repo, '.caws/hooks/probe.sh'),
    path.join(repo, '.caws/hooks/quality-check.sh')
  );
  fs.chmodSync(path.join(repo, '.caws/hooks/quality-check.sh'), 0o755);
  const config = path.join(repo, '.codex/hooks.json');
  const command = () => JSON.parse(fs.readFileSync(config)).hooks.PostToolUse[0].hooks[0].command;
  const before = runHook(command(), 'PostToolUse');
  expect(before.status).toBe(0);
  expect(before.stderr).toContain('enabled-quality-handler');
  adoptMachineAdapter(opts);
  const after = runHook(command(), 'PostToolUse');
  expect(after.status).toBe(0);
  expect(after.stderr).toContain('enabled-quality-handler');
});
