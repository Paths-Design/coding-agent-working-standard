'use strict';

/**
 * Kimi Code user-level config.toml merge coverage (CAWS-HOOK-PACK-KIMI-CODE-001).
 *
 * Modeled on zcode-config-merge.test.js (the merge-layer test infrastructure
 * established there). The kimi merge differs from every other surface in one
 * load-bearing way: it writes OUTSIDE the consumer repo, into the user-level
 * $KIMI_CODE_HOME/config.toml, because Kimi has no project-level hook config.
 * Every test here therefore points KIMI_CODE_HOME at a temp dir via the
 * injected `env` option — the real home directory is never touched.
 *
 * The merge contract under test:
 *   - absent file → created with exactly the five canonical [[hooks]] blocks
 *   - existing file → append-only; missing events appended at EOF, existing
 *     content preserved byte-for-byte (including malformed TOML)
 *   - already wired (by merge OR by a hand-pasted block) → unchanged no-op
 *   - idempotent: a second run is byte-identical
 *   - detection is per-event: partial wiring appends only the missing events
 *
 * The SUT is the compiled surface: require('../../dist/init/hook-install').
 * `npm run build` compiles TS -> dist before jest runs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  mergeKimiUserConfig,
  planKimiConfigMerge,
  inspectKimiUserConfig,
  writeKimiConfigExample,
  planKimiConfigExample,
  kimiUserConfigPath,
  missingKimiHookEvents,
  CANONICAL_KIMI_HOOK_ENTRIES,
  CANONICAL_KIMI_CONFIG_SNIPPET,
} = require('../../dist/init/hook-install');
const {
  resolveHookPack,
  KNOWN_SURFACES,
  IMPLEMENTED_SURFACES,
} = require('../../dist/init/hook-packs/register');

const ALL_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop', 'PreCompact'];

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-kimi-merge-'));
}
function envFor(home) {
  return { ...process.env, KIMI_CODE_HOME: home };
}
function configPathFor(home) {
  return path.join(home, 'config.toml');
}
function readConfig(home) {
  return fs.readFileSync(configPathFor(home), 'utf8');
}
function countShimRefs(content) {
  return (content.match(/caws-kimi-hook\.sh/g) || []).length;
}

describe('registration: kimi-code is a first-class surface', () => {
  test("resolveHookPack('kimi-code') returns the kimi-code pack", () => {
    const r = resolveHookPack('kimi-code');
    expect(r).toEqual({ kind: 'pack', pack: expect.objectContaining({ id: 'kimi-code' }) });
  });

  test('kimi-code is in KNOWN_SURFACES and IMPLEMENTED_SURFACES', () => {
    expect(KNOWN_SURFACES).toContain('kimi-code');
    expect(IMPLEMENTED_SURFACES).toContain('kimi-code');
  });

  test('CANONICAL_KIMI_HOOK_ENTRIES covers all five events', () => {
    expect(CANONICAL_KIMI_HOOK_ENTRIES.map((e) => e.event).sort()).toEqual(
      [...ALL_EVENTS].sort()
    );
  });

  test('every canonical command resolves the git root and no-ops without the shim', () => {
    for (const entry of CANONICAL_KIMI_HOOK_ENTRIES) {
      expect(entry.command).toContain('git rev-parse --show-toplevel');
      expect(entry.command).toContain('test -x "$ROOT/.kimi-code/hooks/caws-kimi-hook.sh"');
      expect(entry.command).toContain(`caws-kimi-hook.sh" ${entry.event} || true`);
    }
  });
});

describe('kimiUserConfigPath', () => {
  test('honors KIMI_CODE_HOME when set', () => {
    expect(kimiUserConfigPath({ KIMI_CODE_HOME: '/tmp/kch' })).toBe(
      path.join('/tmp/kch', 'config.toml')
    );
  });
  test('falls back to ~/.kimi-code/config.toml when unset or blank', () => {
    expect(kimiUserConfigPath({})).toBe(
      path.join(os.homedir(), '.kimi-code', 'config.toml')
    );
    expect(kimiUserConfigPath({ KIMI_CODE_HOME: '   ' })).toBe(
      path.join(os.homedir(), '.kimi-code', 'config.toml')
    );
  });
});

describe('mergeKimiUserConfig: created (absent config.toml)', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test('absent file → created with exactly the five canonical blocks', () => {
    const result = mergeKimiUserConfig({ env: envFor(home) });
    expect(result.kind).toBe('created');
    expect(result.path).toBe(configPathFor(home));
    const content = readConfig(home);
    expect(countShimRefs(content)).toBe(10); // test -x + invoke per block
    for (const ev of ALL_EVENTS) {
      expect(content).toContain(`event = "${ev}"`);
    }
    expect(content).toContain('[[hooks]]');
  });

  test('a second run is a byte-identical no-op (unchanged)', () => {
    mergeKimiUserConfig({ env: envFor(home) });
    const before = readConfig(home);
    const second = mergeKimiUserConfig({ env: envFor(home) });
    expect(second.kind).toBe('unchanged');
    expect(readConfig(home)).toBe(before);
  });
});

describe('mergeKimiUserConfig: merged (existing config.toml)', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test('existing content is preserved byte-for-byte; blocks appended at EOF', () => {
    const prior = '# my kimi config\n\ndefault_model = "kimi-code/k3"\n\ntelemetry = false\n';
    fs.writeFileSync(configPathFor(home), prior);
    const result = mergeKimiUserConfig({ env: envFor(home) });
    expect(result.kind).toBe('merged');
    expect(result.added.sort()).toEqual([...ALL_EVENTS].sort());
    const content = readConfig(home);
    expect(content.startsWith(prior)).toBe(true);
    expect(countShimRefs(content)).toBe(10);
  });

  test('a hand-pasted block counts as wired — no duplicate is appended', () => {
    // The user pasted the example by hand before ever running --wire-user-config.
    fs.writeFileSync(configPathFor(home), CANONICAL_KIMI_CONFIG_SNIPPET);
    const result = mergeKimiUserConfig({ env: envFor(home) });
    expect(result.kind).toBe('unchanged');
    expect(countShimRefs(readConfig(home))).toBe(10);
  });

  test('partial wiring appends only the missing events', () => {
    const preToolBlock = [
      '[[hooks]]',
      'event = "PreToolUse"',
      'matcher = "Bash"',
      'command = \'test -x "$ROOT/.kimi-code/hooks/caws-kimi-hook.sh" && "$ROOT/.kimi-code/hooks/caws-kimi-hook.sh" PreToolUse || true\'',
      'timeout = 45',
      '',
    ].join('\n');
    fs.writeFileSync(configPathFor(home), preToolBlock);
    const result = mergeKimiUserConfig({ env: envFor(home) });
    expect(result.kind).toBe('merged');
    expect(result.added.sort()).toEqual(
      ['PostToolUse', 'SessionStart', 'Stop', 'PreCompact'].sort()
    );
    const content = readConfig(home);
    // The original single block is still there exactly once.
    expect(content.match(/event = "PreToolUse"/g) || []).toHaveLength(1);
  });

  test('malformed TOML is appended to, never rewritten', () => {
    const garbage = 'this is [not valid toml === at all\n{{{';
    fs.writeFileSync(configPathFor(home), garbage);
    const result = mergeKimiUserConfig({ env: envFor(home) });
    expect(result.kind).toBe('merged');
    const content = readConfig(home);
    expect(content.startsWith(garbage)).toBe(true);
  });
});

describe('planKimiConfigMerge (read-only)', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test('absent file → created preview, nothing written', () => {
    const plan = planKimiConfigMerge({ env: envFor(home) });
    expect(plan).toEqual({
      kind: 'created',
      path: configPathFor(home),
      readOnly: true,
    });
    expect(fs.existsSync(configPathFor(home))).toBe(false);
  });

  test('unwired file → merged preview listing all five events, nothing written', () => {
    fs.writeFileSync(configPathFor(home), 'telemetry = false\n');
    const plan = planKimiConfigMerge({ env: envFor(home) });
    expect(plan.kind).toBe('merged');
    expect(plan.readOnly).toBe(true);
    expect(plan.added.sort()).toEqual([...ALL_EVENTS].sort());
    expect(readConfig(home)).toBe('telemetry = false\n');
  });

  test('fully wired file → unchanged', () => {
    mergeKimiUserConfig({ env: envFor(home) });
    const plan = planKimiConfigMerge({ env: envFor(home) });
    expect(plan.kind).toBe('unchanged');
  });
});

describe('inspectKimiUserConfig', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test('absent → absent', () => {
    expect(inspectKimiUserConfig({ env: envFor(home) })).toEqual({ kind: 'absent' });
  });

  test('unwired → partial listing every event', () => {
    fs.writeFileSync(configPathFor(home), 'telemetry = false\n');
    const status = inspectKimiUserConfig({ env: envFor(home) });
    expect(status.kind).toBe('partial');
    expect(status.missing.sort()).toEqual([...ALL_EVENTS].sort());
  });

  test('wired → wired', () => {
    mergeKimiUserConfig({ env: envFor(home) });
    expect(inspectKimiUserConfig({ env: envFor(home) })).toEqual({ kind: 'wired' });
  });
});

describe('missingKimiHookEvents', () => {
  test('empty content → all five', () => {
    expect(missingKimiHookEvents('').sort()).toEqual([...ALL_EVENTS].sort());
  });
  test('full snippet → none', () => {
    expect(missingKimiHookEvents(CANONICAL_KIMI_CONFIG_SNIPPET)).toEqual([]);
  });
  test('a hooks table for a different event does not count', () => {
    const other = '[[hooks]]\nevent = "PreToolUse"\ncommand = "echo hi"\n';
    expect(missingKimiHookEvents(other).sort()).toEqual([...ALL_EVENTS].sort());
  });
  test('shim command without matching event does not count', () => {
    const wrong = '[[hooks]]\nevent = "Notification"\ncommand = \'"$ROOT/.kimi-code/hooks/caws-kimi-hook.sh" PreToolUse || true\'\n';
    const missing = missingKimiHookEvents(wrong);
    expect(missing).toContain('PreToolUse');
  });
});

describe('kimi config example artifact', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-kimi-example-'));
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('writeKimiConfigExample writes the canonical snippet idempotently', () => {
    const p = writeKimiConfigExample(repoRoot);
    expect(p).toBe(path.join(repoRoot, '.kimi-code', 'caws-hooks.toml.example'));
    const first = fs.readFileSync(p, 'utf8');
    expect(first).toBe(CANONICAL_KIMI_CONFIG_SNIPPET);
    writeKimiConfigExample(repoRoot);
    expect(fs.readFileSync(p, 'utf8')).toBe(first);
  });

  test('planKimiConfigExample: would_create → unchanged after write', () => {
    expect(planKimiConfigExample(repoRoot).action).toBe('would_create');
    writeKimiConfigExample(repoRoot);
    expect(planKimiConfigExample(repoRoot).action).toBe('unchanged');
  });

  test('the example content is itself detected as fully wired', () => {
    // Guards the paste path: a user who copies the example into config.toml
    // must be seen as wired (no duplicate append on a later --wire-user-config).
    expect(missingKimiHookEvents(CANONICAL_KIMI_CONFIG_SNIPPET)).toEqual([]);
  });
});
