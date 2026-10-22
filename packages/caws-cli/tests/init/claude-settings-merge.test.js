const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dist = process.env.CAWS_TEST_DIST || path.join(__dirname, '../../dist');
const {
  CANONICAL_HOOK_ENTRIES,
  CANONICAL_SETTINGS_SNIPPET,
  mergeClaudeSettings,
  planClaudeSettingsMerge,
  writeSettingsExample,
} = require(path.join(dist, 'init/hook-install'));
const { renderSettingsWiring } = require(path.join(dist, 'shell/render/init-hook-pack'));

let fixtureContainer, root, settings;
beforeEach(() => {
  fixtureContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-claude-settings-'));
  root = path.join(fixtureContainer, 'repo');
  fs.mkdirSync(root);
  settings = path.join(root, '.claude/settings.json');
});
afterEach(() => fs.rmSync(fixtureContainer, { recursive: true, force: true }));
function write(value) {
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(value));
}
function wired() {
  return JSON.parse(CANONICAL_SETTINGS_SNIPPET);
}
function withPrivatePathWitness(run) {
  const directory = path.join(fixtureContainer, 'path-bin');
  fs.mkdirSync(directory);
  for (const name of ['caws-hook-native', 'caws-hook']) {
    const file = path.join(directory, name);
    fs.writeFileSync(
      file,
      '#!/bin/sh\n# PATH resolution witness only; never executed by these tests.\nexit 97\n',
      { mode: 0o755 }
    );
    fs.copyFileSync(file, path.join(root, name));
    fs.chmodSync(path.join(root, name), 0o755);
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = directory + path.delimiter + (previous || '');
  try {
    expect(process.env.PATH.split(path.delimiter)[0]).toBe(directory);
    return run();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}
function pathCawsOperand(program) {
  const shellSpelling = program === 'caws\\-hook-native' || program === "'caws'-hook-native";
  const name = shellSpelling
    ? 'caws-hook-native'
    : path.basename(program.replace(/^absolute:/, ''));
  const operand = program.startsWith('absolute:')
    ? path.join(fixtureContainer, 'path-bin', name)
    : program;
  // This prospective project cwd witnesses relative paths without executing them.
  const expected = program.startsWith('./')
    ? path.join(root, name)
    : path.join(fixtureContainer, 'path-bin', name);
  const file =
    program.startsWith('./') || program.startsWith('../') || path.isAbsolute(operand)
      ? path.resolve(root, operand)
      : path.join(fixtureContainer, 'path-bin', name);
  expect(fs.realpathSync(file)).toBe(fs.realpathSync(expected));
  expect(fs.statSync(file).isFile()).toBe(true);
  return operand;
}

test('fresh Claude settings and rendered references put block only on the managed PreToolUse hook', () => {
  expect(planClaudeSettingsMerge(root)).toEqual({
    kind: 'created',
    path: settings,
    readOnly: true,
  });
  expect(fs.existsSync(path.dirname(settings))).toBe(false);
  expect(mergeClaudeSettings(root)).toEqual({ kind: 'created', path: settings });
  const value = JSON.parse(fs.readFileSync(settings));
  expect(value.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
  expect(CANONICAL_HOOK_ENTRIES.PreToolUse.hooks[0].onFailure).toBe('block');
  expect(JSON.parse(fs.readFileSync(writeSettingsExample(root)))).toEqual(value);
  for (const [event, entries] of Object.entries(value.hooks)) {
    expect(entries[0]).not.toHaveProperty('onFailure');
    if (event !== 'PreToolUse') expect(entries[0].hooks[0]).not.toHaveProperty('onFailure');
  }
});
test.each(['.caws/hooks/dispatch', '.claude/hooks/caws_dispatch', '.claude/hooks/dispatch'])(
  'Claude project policy repairs only missing managed fields in recognized %s wiring',
  (directory) => {
    const value = wired();
    const foreign = { type: 'command', command: '/operator/notify.sh', onFailure: 'continue' };
    const managed = value.hooks.PreToolUse[0].hooks[0];
    managed.command = `"/project/${directory}/pre_tool_use.sh"`;
    delete managed.onFailure;
    managed.statusMessage = 'Keep operator status';
    value.hooks.PreToolUse[0].matcher = 'Read';
    value.hooks.PreToolUse[0].hooks.unshift(foreign);
    value.hooks.Stop[0].hooks[0].onFailure = 'continue';
    value.permissions = { allow: ['Read'] };
    write(value);
    const before = fs.readFileSync(settings);
    const expected = { kind: 'merged', path: settings, added: [], repaired: ['PreToolUse'] };
    expect(planClaudeSettingsMerge(root)).toEqual({ ...expected, readOnly: true });
    expect(fs.readFileSync(settings)).toEqual(before);
    expect(mergeClaudeSettings(root)).toEqual(expected);
    managed.onFailure = 'block';
    expect(JSON.parse(fs.readFileSync(settings))).toEqual(value);
    const applied = fs.readFileSync(settings);
    expect(planClaudeSettingsMerge(root)).toEqual({
      kind: 'unchanged',
      path: settings,
      readOnly: true,
    });
    expect(mergeClaudeSettings(root)).toEqual({ kind: 'unchanged', path: settings });
    expect(fs.readFileSync(settings)).toEqual(applied);
  }
);
test.each([
  [
    'printf policy',
    { command: 'printf "%s\\n" "/p/.caws/hooks/dispatch/pre_tool_use.sh"', onFailure: 'continue' },
  ],
  ['printf absent policy', { command: 'printf "%s\\n" "/p/.caws/hooks/dispatch/pre_tool_use.sh"' }],
  [
    'misleading executable suffix',
    { command: '"/p/.caws/hooks/dispatch/pre_tool_use.sh-foreign"', onFailure: 'continue' },
  ],
  [
    'bash string containing path data',
    {
      command: 'bash -c \'printf "%s\\n" "/p/.caws/hooks/dispatch/pre_tool_use.sh"\'',
      onFailure: 'continue',
    },
  ],
  [
    'unqualified dynamic wrapper',
    { command: 'bash -c "$OPERATOR_COMMAND"', onFailure: 'continue' },
  ],
])(
  'foreign dispatcher-path data stays untouched beside actual managed policy: %s',
  (_name, foreign) => {
    const value = wired();
    const managed = value.hooks.PreToolUse[0].hooks[0];
    delete managed.onFailure;
    value.hooks.PreToolUse[0].hooks.unshift({ type: 'command', ...foreign });
    write(value);
    const before = fs.readFileSync(settings);
    const expected = { kind: 'merged', path: settings, added: [], repaired: ['PreToolUse'] };
    expect(planClaudeSettingsMerge(root)).toEqual({ ...expected, readOnly: true });
    expect(fs.readFileSync(settings)).toEqual(before);
    expect(mergeClaudeSettings(root)).toEqual(expected);
    managed.onFailure = 'block';
    expect(JSON.parse(fs.readFileSync(settings))).toEqual(value);
  }
);
test.each([
  '"/p/.caws/hooks/dispatch/pre_tool_use.sh" --custom',
  '"/p/.caws/hooks/dispatch/pre_tool_use.sh" && echo operator',
  '\'MODE=demo\' "/p/.caws/hooks/dispatch/pre_tool_use.sh"',
  "'$CLAUDE_PROJECT_DIR/.caws/hooks/dispatch/pre_tool_use.sh'",
  '\\$CLAUDE_PROJECT_DIR/.caws/hooks/dispatch/pre_tool_use.sh',
  '"$CLAUDE_PROJECT_DIR/$UNKNOWN/.caws/hooks/dispatch/pre_tool_use.sh"',
  'bash -c "$UNKNOWN/bin/caws-hook-native"',
  'bash -c \'"/p/.claude/hooks/caws_dispatch/pre_tool_use.sh"\'',
  '/bin/sh -c \'"/p/.claude/hooks/dispatch/pre_tool_use.sh"\'',
])(
  'known dispatcher requiring registration reconciliation refuses every merge write: %s',
  (command) => {
    const value = wired();
    delete value.hooks.PreToolUse[0].hooks[0].onFailure;
    value.hooks.PreToolUse.push({ hooks: [{ type: 'command', command }] });
    write(value);
    const before = fs.readFileSync(settings);
    for (const operation of [planClaudeSettingsMerge, mergeClaudeSettings]) {
      expect(operation(root)).toMatchObject({
        kind: 'invalid',
        reason: 'registration-reconciliation',
      });
      expect(fs.readFileSync(settings)).toEqual(before);
    }
    const rendered = renderSettingsWiring(
      { kind: 'wired' },
      {
        kind: 'invalid',
        path: settings,
        reason: 'registration-reconciliation',
        error: 'Unsupported dispatcher invocation',
      }
    );
    expect(rendered).toContain('registration requires reconciliation');
    expect(rendered).not.toContain('could not be parsed');
    expect(rendered).not.toContain('settings.json.example');
  }
);
test.each([
  '"/p/.caws/hooks/dispatch/pre_tool_use.sh"',
  'bash "/p/.claude/hooks/caws_dispatch/pre_tool_use.sh"',
  'MODE=demo /bin/bash "/p/.claude/hooks/dispatch/pre_tool_use.sh"',
  'env MODE=demo bash "/p/.caws/hooks/dispatch/pre_tool_use.sh"',
  'MODE=demo env bash "/p/.caws/hooks/dispatch/pre_tool_use.sh"',
  'CAWS_AGENT_SURFACE=claude-code CAWS_PROJECT_DIR="$CLAUDE_PROJECT_DIR" "$CLAUDE_PROJECT_DIR"/.caws/hooks/dispatch/pre_tool_use.sh',
  '"${CLAUDE_PROJECT_DIR}/.claude/hooks/dispatch/pre_tool_use.sh"',
])('managed executable-position dispatcher remains eligible for policy repair: %s', (command) => {
  const value = wired();
  const managed = value.hooks.PreToolUse[0].hooks[0];
  managed.command = command;
  delete managed.onFailure;
  write(value);
  expect(mergeClaudeSettings(root)).toEqual({
    kind: 'merged',
    path: settings,
    added: [],
    repaired: ['PreToolUse'],
  });
  managed.onFailure = 'block';
  expect(JSON.parse(fs.readFileSync(settings))).toEqual(value);
});
test('an explicit block project policy keeps existing settings byte-identical', () => {
  const value = wired();
  value.hooks.PreToolUse[0].hooks[0].onFailure = 'block';
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(value, null, 4) + '\n');
  const before = fs.readFileSync(settings);
  expect(mergeClaudeSettings(root)).toEqual({ kind: 'unchanged', path: settings });
  expect(fs.readFileSync(settings)).toEqual(before);
});
test.each([
  { command: 'python3', args: ['/p/bin/caws-hook', 'claude-code', 'pre_tool_use', '--system'] },
  { command: '/p/bin/caws-hook-native', args: ['claude-code', 'pre_tool_use', '--system'] },
  { command: 'operator-wrapper', args: ['/p/bin/caws-hook-native', 'claude-code', 'pre_tool_use'] },
])('exec-form CAWS merge requires registration reconciliation without writes: %j', (fields) => {
  const value = wired();
  delete value.hooks.PreToolUse[0].hooks[0].onFailure;
  value.hooks.PreToolUse.push({ hooks: [{ type: 'command', ...fields }] });
  write(value);
  const before = fs.readFileSync(settings);
  for (const operation of [planClaudeSettingsMerge, mergeClaudeSettings]) {
    expect(operation(root)).toMatchObject({
      kind: 'invalid',
      reason: 'registration-reconciliation',
    });
    expect(fs.readFileSync(settings)).toEqual(before);
  }
});
test.each(['printf', 'echo'])(
  'exec-form literal %s merge preserves argv path data as foreign',
  (command) => {
    const value = wired();
    const managed = value.hooks.PreToolUse[0].hooks[0];
    delete managed.onFailure;
    const foreign = {
      type: 'command',
      command,
      args: [
        '/p/bin/caws-hook-native',
        '/p/.caws/hooks/dispatch/pre_tool_use.sh',
        "$LITERAL 'quoted' `literal`",
      ],
      onFailure: 'continue',
    };
    value.hooks.PreToolUse[0].hooks.unshift(foreign);
    write(value);
    expect(mergeClaudeSettings(root)).toMatchObject({
      kind: 'merged',
      added: [],
      repaired: ['PreToolUse'],
    });
    managed.onFailure = 'block';
    expect(JSON.parse(fs.readFileSync(settings))).toEqual(value);
  }
);
test.each([
  ...['exec', 'env', 'shell'].flatMap((form) =>
    ['caws-hook-native', 'caws-hook'].map((program) => [form, program])
  ),
  ...['exec', 'shell'].flatMap((form) =>
    ['caws-hook-native', 'caws-hook'].flatMap((name) =>
      ['./' + name, '../path-bin/' + name, 'absolute:' + name].map((program) => [form, program])
    )
  ),
  ['shell', 'caws\\-hook-native'],
  ['shell', "'caws'-hook-native"],
])(
  'PATH candidate %s %s merge requires typed reconciliation without writes or execution',
  (form, program) =>
    withPrivatePathWitness(() => {
      program = pathCawsOperand(program);
      const value = wired();
      const args = ['claude-code', 'pre_tool_use', '--system'];
      const hook =
        form === 'shell'
          ? { type: 'command', command: program + ' claude-code pre_tool_use --system' }
          : {
              type: 'command',
              command: form === 'env' ? 'env' : program,
              args: form === 'env' ? [program, ...args] : args,
            };
      value.hooks.PreToolUse = [{ hooks: [hook] }];
      write(value);
      const before = fs.readFileSync(settings);
      for (const operation of [planClaudeSettingsMerge, mergeClaudeSettings]) {
        expect(operation(root)).toMatchObject({
          kind: 'invalid',
          reason: 'registration-reconciliation',
        });
        expect(fs.readFileSync(settings)).toEqual(before);
      }
    })
);
test.each(['printf', 'echo'])(
  'PATH-name data passed to literal %s merge is preserved',
  (command) => {
    withPrivatePathWitness(() => {
      const value = wired();
      const foreign = {
        type: 'command',
        command,
        args: ['caws-hook-native', 'caws-hook'].flatMap((name) =>
          [name, './' + name, '../path-bin/' + name, 'absolute:' + name].map(pathCawsOperand)
        ),
        onFailure: 'continue',
      };
      value.hooks.PreToolUse[0].hooks.unshift(foreign);
      write(value);
      const before = fs.readFileSync(settings);
      expect(mergeClaudeSettings(root)).toEqual({ kind: 'unchanged', path: settings });
      expect(fs.readFileSync(settings)).toEqual(before);
    });
  }
);
test('Claude project policy rendering names repairs and separates policy refusal from JSON parse errors', () => {
  const repaired = renderSettingsWiring(
    { kind: 'wired' },
    {
      kind: 'merged',
      path: settings,
      added: [],
      repaired: ['PreToolUse'],
    }
  );
  expect(repaired).toContain('Repaired managed failure policy: PreToolUse.');
  expect(repaired).toContain('user-authored hooks');
  expect(repaired).not.toContain('any existing hooks');
  const invalid = renderSettingsWiring(
    { kind: 'wired' },
    {
      kind: 'invalid',
      path: settings,
      reason: 'policy-invalid',
      error: 'onFailure must be block',
    }
  );
  expect(invalid).toContain('managed failure policy is invalid');
  expect(invalid).toContain('init did NOT modify the file');
  expect(invalid).not.toContain('could not be parsed');
  expect(invalid).not.toContain('settings.json.example');
  const parseError = renderSettingsWiring(
    { kind: 'invalid', error: 'bad JSON' },
    {
      kind: 'invalid',
      path: settings,
      error: 'bad JSON',
    }
  );
  expect(parseError).toContain('could not be parsed: bad JSON');
});
test.each(['continue', 'BLOCK', null, false, 0, { action: 'block' }, []])(
  'Claude project policy refuses explicit value %j before repairing or appending anything',
  (onFailure) => {
    const absent = { type: 'command', command: '"/p/.caws/hooks/dispatch/pre_tool_use.sh"' };
    const invalid = { ...absent, onFailure };
    write({ hooks: { PreToolUse: [{ hooks: [absent, invalid] }] }, env: { KEEP: 'retained' } });
    const before = fs.readFileSync(settings);
    for (const operation of [planClaudeSettingsMerge, mergeClaudeSettings]) {
      expect(operation(root)).toMatchObject({
        kind: 'invalid',
        path: settings,
        reason: 'policy-invalid',
      });
      expect(fs.readFileSync(settings)).toEqual(before);
      expect(fs.readdirSync(path.dirname(settings))).toEqual(['settings.json']);
    }
  }
);
test('Claude merge rereads and revalidates a policy changed after a successful plan', () => {
  const value = wired();
  delete value.hooks.PreToolUse[0].hooks[0].onFailure;
  write(value);
  expect(planClaudeSettingsMerge(root)).toMatchObject({ kind: 'merged', repaired: ['PreToolUse'] });
  value.hooks.PreToolUse[0].hooks[0].onFailure = 'continue';
  write(value);
  const before = fs.readFileSync(settings);
  expect(mergeClaudeSettings(root)).toMatchObject({ kind: 'invalid', reason: 'policy-invalid' });
  expect(fs.readFileSync(settings)).toEqual(before);
});
test.each(['{', 'null', '[]'])(
  'malformed or non-object Claude settings %s retain the existing untyped invalid result',
  (bytes) => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, bytes);
    for (const operation of [planClaudeSettingsMerge, mergeClaudeSettings]) {
      const result = operation(root);
      expect(result.kind).toBe('invalid');
      expect(result).not.toHaveProperty('reason');
      expect(fs.readFileSync(settings, 'utf8')).toBe(bytes);
    }
  }
);
