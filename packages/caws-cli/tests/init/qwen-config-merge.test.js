'use strict';

/**
 * Qwen Code repo-local .qwen/settings.json merge coverage
 * (CAWS-HOOK-PACK-QWEN-CODE-001).
 *
 * Modeled on kimi-config-merge.test.js and the claude/zcode merge tests.
 * Unlike kimi (user-level TOML), the qwen wiring is repo-local JSON — the
 * claude-code/zcode precedent — so every test runs against a temp repo dir
 * and nothing outside it is touched.
 *
 * The merge contract under test:
 *   - absent file → created with exactly the five canonical shim entries
 *   - existing file → append-only per event key; every other key preserved
 *   - already wired (by merge OR by a hand-pasted block) → unchanged no-op
 *   - idempotent: a second run is byte-identical
 *   - unparseable file (incl. JSONC comments) → invalid, left untouched
 *   - detection is per-event: partial wiring appends only the missing events
 *   - root QWEN.md doctrine import: created / appended / idempotent,
 *     user content preserved
 *
 * The SUT is the compiled surface: require('../../dist/init/hook-install').
 * `npm run build` compiles TS -> dist before jest runs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  mergeQwenSettings,
  planQwenSettingsMerge,
  inspectQwenSettings,
  writeQwenSettingsExample,
  planQwenSettingsExample,
  mergeQwenInstructionImport,
  planQwenInstructionImport,
  CANONICAL_QWEN_HOOK_ENTRIES,
  CANONICAL_QWEN_SETTINGS_SNIPPET,
} = require('../../dist/init/hook-install');
const {
  resolveHookPack,
  KNOWN_SURFACES,
  IMPLEMENTED_SURFACES,
} = require('../../dist/init/hook-packs/register');

const ALL_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop', 'PreCompact'];

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-qwen-merge-'));
}
function settingsPathFor(repo) {
  return path.join(repo, '.qwen', 'settings.json');
}
function readSettings(repo) {
  return fs.readFileSync(settingsPathFor(repo), 'utf8');
}
function countShimRefs(content) {
  return (content.match(/caws-qwen-hook\.sh/g) || []).length;
}

describe('registration: qwen-code is a first-class surface', () => {
  test("resolveHookPack('qwen-code') returns the qwen-code pack", () => {
    const r = resolveHookPack('qwen-code');
    expect(r).toEqual({ kind: 'pack', pack: expect.objectContaining({ id: 'qwen-code' }) });
  });

  test('qwen-code is in KNOWN_SURFACES and IMPLEMENTED_SURFACES', () => {
    expect(KNOWN_SURFACES).toContain('qwen-code');
    expect(IMPLEMENTED_SURFACES).toContain('qwen-code');
  });

  test('CANONICAL_QWEN_HOOK_ENTRIES covers all five events', () => {
    expect(Object.keys(CANONICAL_QWEN_HOOK_ENTRIES).sort()).toEqual(
      [...ALL_EVENTS].sort()
    );
  });

  test('every canonical command resolves the git root and no-ops without the shim', () => {
    for (const [event, entry] of Object.entries(CANONICAL_QWEN_HOOK_ENTRIES)) {
      expect(entry.hooks[0].command).toContain('git rev-parse --show-toplevel');
      expect(entry.hooks[0].command).toContain('test -x "$ROOT/.qwen/hooks/caws-qwen-hook.sh"');
      expect(entry.hooks[0].command).toContain(`caws-qwen-hook.sh" ${event} || true`);
    }
  });

  test('matchers use Qwen runtime tool ids, not Claude display names', () => {
    const pre = CANONICAL_QWEN_HOOK_ENTRIES.PreToolUse.matcher;
    expect(pre).toContain('run_shell_command');
    expect(pre).toContain('write_file');
    expect(pre).toContain('edit');
    // Claude display names must NOT leak into qwen matchers.
    expect(pre).not.toMatch(/\bBash\b/);
    expect(pre).not.toMatch(/\bWrite\b/);
    const post = CANONICAL_QWEN_HOOK_ENTRIES.PostToolUse.matcher;
    expect(post).toContain('exit_plan_mode');
  });

  test('the qwen pack installs exactly the shim, doctrine doc, and parse-input override', () => {
    const r = resolveHookPack('qwen-code');
    if (r.kind !== 'pack') throw new Error('expected pack resolution');
    const dests = r.pack.installedFiles.map((f) => f.destPath).sort();
    expect(dests).toEqual([
      '.qwen/CAWS-HOOKS.md',
      '.qwen/hooks/caws-qwen-hook.sh',
      '.qwen/hooks/lib/parse-input.sh',
    ]);
    expect(r.pack.activation).toBe('restart_required');
  });
});

describe('mergeQwenSettings: created (absent settings.json)', () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('absent file → created with exactly the five canonical entries', () => {
    const result = mergeQwenSettings(repo);
    expect(result.kind).toBe('created');
    expect(result.path).toBe(settingsPathFor(repo));
    const content = readSettings(repo);
    const parsed = JSON.parse(content);
    expect(Object.keys(parsed.hooks).sort()).toEqual([...ALL_EVENTS].sort());
    expect(countShimRefs(content)).toBe(10); // test -x + invoke per event
  });

  test('a second run is a byte-identical no-op (unchanged)', () => {
    mergeQwenSettings(repo);
    const before = readSettings(repo);
    const second = mergeQwenSettings(repo);
    expect(second.kind).toBe('unchanged');
    expect(readSettings(repo)).toBe(before);
  });
});

describe('mergeQwenSettings: merged (existing settings.json)', () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.qwen'), { recursive: true });
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('existing keys are preserved; CAWS entries appended per event', () => {
    fs.writeFileSync(
      settingsPathFor(repo),
      JSON.stringify(
        { tools: { approvalMode: 'default' }, memory: { enableTeamMemory: false } },
        null,
        2
      ),
      'utf8'
    );
    const result = mergeQwenSettings(repo);
    expect(result.kind).toBe('merged');
    expect([...result.added].sort()).toEqual([...ALL_EVENTS].sort());
    const parsed = JSON.parse(readSettings(repo));
    expect(parsed.tools).toEqual({ approvalMode: 'default' });
    expect(parsed.memory).toEqual({ enableTeamMemory: false });
    expect(Object.keys(parsed.hooks).sort()).toEqual([...ALL_EVENTS].sort());
  });

  test('a user-authored hook on the same event is kept alongside the CAWS entry', () => {
    fs.writeFileSync(
      settingsPathFor(repo),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'echo user-hook' }] },
            ],
          },
        },
        null,
        2
      ),
      'utf8'
    );
    const result = mergeQwenSettings(repo);
    expect(result.kind).toBe('merged');
    expect(result.added).toContain('PreToolUse');
    const parsed = JSON.parse(readSettings(repo));
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('echo user-hook');
  });

  test('a hand-pasted CAWS block counts as wired — no duplicate is appended', () => {
    fs.writeFileSync(
      settingsPathFor(repo),
      `${CANONICAL_QWEN_SETTINGS_SNIPPET}\n`,
      'utf8'
    );
    const result = mergeQwenSettings(repo);
    expect(result.kind).toBe('unchanged');
  });

  test('partial wiring appends only the missing events', () => {
    const partial = { hooks: { PreToolUse: [CANONICAL_QWEN_HOOK_ENTRIES.PreToolUse] } };
    fs.writeFileSync(settingsPathFor(repo), JSON.stringify(partial, null, 2), 'utf8');
    const result = mergeQwenSettings(repo);
    expect(result.kind).toBe('merged');
    expect([...result.added].sort()).toEqual(
      ['PostToolUse', 'SessionStart', 'Stop', 'PreCompact'].sort()
    );
    const parsed = JSON.parse(readSettings(repo));
    expect(parsed.hooks.PreToolUse).toHaveLength(1); // no duplicate
  });

  test('JSONC-commented settings.json is invalid and left untouched', () => {
    const commented = '{\n  // my comment\n  "tools": {}\n}\n';
    fs.writeFileSync(settingsPathFor(repo), commented, 'utf8');
    const result = mergeQwenSettings(repo);
    expect(result.kind).toBe('invalid');
    expect(readSettings(repo)).toBe(commented);
  });

  test('non-object root is invalid and left untouched', () => {
    fs.writeFileSync(settingsPathFor(repo), '[1, 2, 3]\n', 'utf8');
    const result = mergeQwenSettings(repo);
    expect(result.kind).toBe('invalid');
    expect(readSettings(repo)).toBe('[1, 2, 3]\n');
  });
});

describe('planQwenSettingsMerge (read-only)', () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('absent file → created preview, nothing written', () => {
    const plan = planQwenSettingsMerge(repo);
    expect(plan).toEqual({ kind: 'created', path: settingsPathFor(repo), readOnly: true });
    expect(fs.existsSync(settingsPathFor(repo))).toBe(false);
  });

  test('unwired file → merged preview listing all five events, nothing written', () => {
    fs.mkdirSync(path.join(repo, '.qwen'), { recursive: true });
    fs.writeFileSync(settingsPathFor(repo), '{"tools":{}}', 'utf8');
    const before = fs.readFileSync(settingsPathFor(repo), 'utf8');
    const plan = planQwenSettingsMerge(repo);
    expect(plan.kind).toBe('merged');
    expect([...plan.added].sort()).toEqual([...ALL_EVENTS].sort());
    expect(fs.readFileSync(settingsPathFor(repo), 'utf8')).toBe(before);
  });

  test('fully wired file → unchanged', () => {
    mergeQwenSettings(repo);
    const plan = planQwenSettingsMerge(repo);
    expect(plan.kind).toBe('unchanged');
  });
});

describe('inspectQwenSettings', () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('absent → absent', () => {
    expect(inspectQwenSettings(repo)).toEqual({ kind: 'absent' });
  });

  test('unwired → partial listing every event', () => {
    fs.mkdirSync(path.join(repo, '.qwen'), { recursive: true });
    fs.writeFileSync(settingsPathFor(repo), '{"hooks":{}}', 'utf8');
    const status = inspectQwenSettings(repo);
    expect(status.kind).toBe('partial');
    expect([...status.missing].sort()).toEqual([...ALL_EVENTS].sort());
  });

  test('wired → wired', () => {
    mergeQwenSettings(repo);
    expect(inspectQwenSettings(repo)).toEqual({ kind: 'wired' });
  });

  test('a hooks table whose commands point elsewhere is partial', () => {
    fs.mkdirSync(path.join(repo, '.qwen'), { recursive: true });
    fs.writeFileSync(
      settingsPathFor(repo),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
      'utf8'
    );
    const status = inspectQwenSettings(repo);
    expect(status.kind).toBe('partial');
    expect(status.missing).toContain('PreToolUse');
  });
});

describe('qwen settings example artifact', () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('writeQwenSettingsExample writes the canonical snippet idempotently', () => {
    const p1 = writeQwenSettingsExample(repo);
    const first = fs.readFileSync(p1, 'utf8');
    const p2 = writeQwenSettingsExample(repo);
    expect(p2).toBe(p1);
    expect(fs.readFileSync(p2, 'utf8')).toBe(first);
    expect(first).toBe(`${CANONICAL_QWEN_SETTINGS_SNIPPET}\n`);
  });

  test('planQwenSettingsExample: would_create → unchanged after write', () => {
    expect(planQwenSettingsExample(repo).action).toBe('would_create');
    writeQwenSettingsExample(repo);
    expect(planQwenSettingsExample(repo).action).toBe('unchanged');
  });

  test('the example content is itself detected as fully wired', () => {
    writeQwenSettingsExample(repo);
    // Copy the example over the live settings path: inspection must say wired.
    fs.copyFileSync(
      path.join(repo, '.qwen', 'settings.json.example'),
      settingsPathFor(repo)
    );
    expect(inspectQwenSettings(repo)).toEqual({ kind: 'wired' });
  });
});

describe('mergeQwenInstructionImport: root QWEN.md doctrine import', () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('absent QWEN.md → created carrying the managed import block', () => {
    const result = mergeQwenInstructionImport(repo);
    expect(result.kind).toBe('created');
    const content = fs.readFileSync(path.join(repo, 'QWEN.md'), 'utf8');
    expect(content).toContain('@.qwen/CAWS-HOOKS.md');
    expect(content).toContain('caws qwen-code doctrine import (managed, v1)');
  });

  test('existing QWEN.md → content preserved, block appended', () => {
    const existing = '# My project notes\n\nBuild with npm run build\n';
    fs.writeFileSync(path.join(repo, 'QWEN.md'), existing, 'utf8');
    const result = mergeQwenInstructionImport(repo);
    expect(result.kind).toBe('merged');
    const content = fs.readFileSync(path.join(repo, 'QWEN.md'), 'utf8');
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain('@.qwen/CAWS-HOOKS.md');
  });

  test('existing QWEN.md without trailing newline is separated cleanly', () => {
    fs.writeFileSync(path.join(repo, 'QWEN.md'), '# notes', 'utf8');
    mergeQwenInstructionImport(repo);
    const content = fs.readFileSync(path.join(repo, 'QWEN.md'), 'utf8');
    expect(content).toContain('# notes\n\n<!-- >>>');
  });

  test('a second run is a byte-identical no-op (unchanged)', () => {
    mergeQwenInstructionImport(repo);
    const before = fs.readFileSync(path.join(repo, 'QWEN.md'), 'utf8');
    const second = mergeQwenInstructionImport(repo);
    expect(second.kind).toBe('unchanged');
    expect(fs.readFileSync(path.join(repo, 'QWEN.md'), 'utf8')).toBe(before);
  });

  test('planQwenInstructionImport previews without writing', () => {
    expect(planQwenInstructionImport(repo).kind).toBe('created');
    expect(fs.existsSync(path.join(repo, 'QWEN.md'))).toBe(false);
    fs.writeFileSync(path.join(repo, 'QWEN.md'), '# x\n', 'utf8');
    expect(planQwenInstructionImport(repo).kind).toBe('merged');
    mergeQwenInstructionImport(repo);
    expect(planQwenInstructionImport(repo).kind).toBe('unchanged');
  });
});
