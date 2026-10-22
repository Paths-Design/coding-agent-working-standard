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

let root, settings;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-claude-settings-'));
  settings = path.join(root, '.claude/settings.json');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(value) {
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(value));
}
function wired() {
  return JSON.parse(CANONICAL_SETTINGS_SNIPPET);
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
test('an explicit block project policy keeps existing settings byte-identical', () => {
  const value = wired();
  value.hooks.PreToolUse[0].hooks[0].onFailure = 'block';
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(value, null, 4) + '\n');
  const before = fs.readFileSync(settings);
  expect(mergeClaudeSettings(root)).toEqual({ kind: 'unchanged', path: settings });
  expect(fs.readFileSync(settings)).toEqual(before);
});
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
