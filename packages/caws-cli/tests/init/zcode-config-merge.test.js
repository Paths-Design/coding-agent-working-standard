'use strict';

/**
 * .zcode/config.json merge coverage (CAWS-ZCODE-AGENT-SURFACE-001).
 *
 * This is the FIRST unit test for the config-merge layer. The Claude Code
 * settings.json merge (CAWS-INIT-SETTINGS-WIRING-001) shipped untested; the
 * ZCode merge mirrors its shape, so this suite establishes the merge-layer
 * test infrastructure (created/merged/unchanged/invalid + idempotency +
 * non-destructive preservation) that the claude path can backfill later.
 *
 * The SUT is the compiled surface: require('../../dist/init/hook-install').
 * `npm run build` compiles TS -> dist before jest runs.
 *
 * ZCode's schema nests the per-event blocks under `hooks.events.<Event>`
 * (vs Claude's flat `hooks.<Event>`), so these tests also pin that nesting:
 * the canonical entries land at hooks.events.* and hooks.enabled is forced
 * true. CAWS-owned entries are detected by the `/.zcode/hooks/caws-bridge.sh`
 * command path segment.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  mergeZcodeConfig,
  planZcodeConfigMerge,
  inspectZcodeConfig,
  writeZcodeConfigExample,
  planZcodeConfigExample,
  CANONICAL_ZCODE_HOOK_ENTRIES,
  CANONICAL_ZCODE_CONFIG_SNIPPET,
} = require('../../dist/init/hook-install');
const {
  resolveHookPack,
  KNOWN_SURFACES,
  IMPLEMENTED_SURFACES,
} = require('../../dist/init/hook-packs/register');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-zcode-merge-'));
}
function abs(repoRoot, rel) {
  return path.join(repoRoot, rel);
}
function readConfig(repoRoot) {
  return JSON.parse(fs.readFileSync(abs(repoRoot, '.zcode/config.json'), 'utf8'));
}
function writeConfig(repoRoot, obj) {
  fs.mkdirSync(abs(repoRoot, '.zcode'), { recursive: true });
  fs.writeFileSync(abs(repoRoot, '.zcode/config.json'), JSON.stringify(obj, null, 2) + '\n');
}

describe('registration: zcode is a first-class surface', () => {
  test("resolveHookPack('zcode') returns the zcode pack", () => {
    const r = resolveHookPack('zcode');
    expect(r).toEqual({ kind: 'pack', pack: expect.objectContaining({ id: 'zcode' }) });
  });

  test('zcode is in KNOWN_SURFACES and IMPLEMENTED_SURFACES', () => {
    expect(KNOWN_SURFACES).toContain('zcode');
    expect(IMPLEMENTED_SURFACES).toContain('zcode');
  });

  test('CANONICAL_ZCODE_HOOK_ENTRIES covers all four events', () => {
    expect(Object.keys(CANONICAL_ZCODE_HOOK_ENTRIES).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort()
    );
  });
});

describe('mergeZcodeConfig: created (absent config.json)', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('absent config.json → created with canonical wiring + hooks.enabled=true', () => {
    const r = mergeZcodeConfig(repoRoot);
    expect(r.kind).toBe('created');
    expect(r.path).toBe(abs(repoRoot, '.zcode/config.json'));

    const cfg = readConfig(repoRoot);
    expect(cfg.hooks.enabled).toBe(true);
    // Each event block nests under hooks.events.<Event>.
    for (const event of Object.keys(CANONICAL_ZCODE_HOOK_ENTRIES)) {
      const blocks = cfg.hooks.events[event];
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBe(1);
      // The bridge command must reference caws-bridge.sh and the dispatcher tail.
      const cmd = blocks[0].hooks[0].command;
      expect(cmd).toContain('/.zcode/hooks/caws-bridge.sh');
      expect(cmd).toContain(event);
    }
  });
});

describe('mergeZcodeConfig: merged (existing user hooks preserved)', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('user-authored event entries are preserved; CAWS entries appended', () => {
    // A user with their own PreToolUse hook AND hooks.enabled false.
    writeConfig(repoRoot, {
      hooks: {
        enabled: false,
        events: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo user-hook', timeout: 5 }],
            },
          ],
        },
      },
      someOtherKey: 'untouched',
    });

    const r = mergeZcodeConfig(repoRoot);
    expect(r.kind).toBe('merged');
    expect(r.added.sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort());

    const cfg = readConfig(repoRoot);
    // The user's PreToolUse hook survives; the CAWS entry is appended AFTER it.
    expect(cfg.hooks.events.PreToolUse.length).toBe(2);
    expect(cfg.hooks.events.PreToolUse[0].hooks[0].command).toBe('echo user-hook');
    expect(cfg.hooks.events.PreToolUse[1].hooks[0].command).toContain('caws-bridge.sh');
    // enabled is forced true.
    expect(cfg.hooks.enabled).toBe(true);
    // Unrelated top-level key is preserved.
    expect(cfg.someOtherKey).toBe('untouched');
  });

  test('a config.json with hooks present but no events object gets events created', () => {
    writeConfig(repoRoot, { hooks: { enabled: true } });
    const r = mergeZcodeConfig(repoRoot);
    expect(r.kind).toBe('merged');
    const cfg = readConfig(repoRoot);
    expect(cfg.hooks.events).toBeDefined();
    expect(Object.keys(cfg.hooks.events).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort()
    );
  });
});

describe('mergeZcodeConfig: unchanged (already wired)', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('a fully-wired config.json is a byte-identical no-op', () => {
    // First merge creates the canonical wiring.
    mergeZcodeConfig(repoRoot);
    const before = fs.readFileSync(abs(repoRoot, '.zcode/config.json'));

    const r = mergeZcodeConfig(repoRoot);
    expect(r.kind).toBe('unchanged');
    expect(fs.readFileSync(abs(repoRoot, '.zcode/config.json')).equals(before)).toBe(true);
  });

  test('re-running on a config with only-wired entries + enabled true is unchanged', () => {
    mergeZcodeConfig(repoRoot);
    // A second run must NOT append duplicates.
    const r2 = mergeZcodeConfig(repoRoot);
    expect(r2.kind).toBe('unchanged');
    const cfg = readConfig(repoRoot);
    // Exactly one CAWS entry per event.
    for (const event of Object.keys(CANONICAL_ZCODE_HOOK_ENTRIES)) {
      expect(cfg.hooks.events[event].length).toBe(1);
    }
  });
});

describe('mergeZcodeConfig: invalid (unparseable)', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('malformed JSON → invalid, file left untouched', () => {
    fs.mkdirSync(abs(repoRoot, '.zcode'), { recursive: true });
    const garbage = '{ "hooks": this is not json';
    fs.writeFileSync(abs(repoRoot, '.zcode/config.json'), garbage);

    const r = mergeZcodeConfig(repoRoot);
    expect(r.kind).toBe('invalid');
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
    // File is byte-identical to what was there.
    expect(fs.readFileSync(abs(repoRoot, '.zcode/config.json'), 'utf8')).toBe(garbage);
  });

  test('non-object root (a JSON array) → invalid', () => {
    fs.mkdirSync(abs(repoRoot, '.zcode'), { recursive: true });
    fs.writeFileSync(abs(repoRoot, '.zcode/config.json'), '[]\n');
    const r = mergeZcodeConfig(repoRoot);
    expect(r.kind).toBe('invalid');
  });
});

describe('mergeZcodeConfig: idempotency', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('run twice → second run is unchanged and content equals a fresh create body', () => {
    const r1 = mergeZcodeConfig(repoRoot);
    expect(r1.kind).toBe('created');
    const r2 = mergeZcodeConfig(repoRoot);
    expect(r2.kind).toBe('unchanged');
    // The events section matches the canonical entries exactly (no dupes, no drift).
    const cfg = readConfig(repoRoot);
    const events = Object.keys(cfg.hooks.events).sort();
    expect(events).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort());
  });
});

describe('planZcodeConfigMerge: read-only counterpart', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('absent → created (read-only; nothing written)', () => {
    const r = planZcodeConfigMerge(repoRoot);
    expect(r.kind).toBe('created');
    expect(r.readOnly).toBe(true);
    expect(fs.existsSync(abs(repoRoot, '.zcode/config.json'))).toBe(false);
  });

  test('already-wired → unchanged (read-only)', () => {
    mergeZcodeConfig(repoRoot); // establish wiring
    const r = planZcodeConfigMerge(repoRoot);
    expect(r.kind).toBe('unchanged');
    expect(r.readOnly).toBe(true);
  });

  test('partially wired → merged with the missing events reported', () => {
    writeConfig(repoRoot, {
      hooks: { enabled: true, events: { PreToolUse: [CANONICAL_ZCODE_HOOK_ENTRIES.PreToolUse] } },
    });
    const r = planZcodeConfigMerge(repoRoot);
    expect(r.kind).toBe('merged');
    // PreToolUse already present → only the other three reported as added.
    expect(r.added.sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop'].sort());
  });
});

describe('inspectZcodeConfig', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('absent → absent', () => {
    expect(inspectZcodeConfig(repoRoot).kind).toBe('absent');
  });

  test('fully wired → wired', () => {
    mergeZcodeConfig(repoRoot);
    expect(inspectZcodeConfig(repoRoot).kind).toBe('wired');
  });

  test('partially wired → partial with the missing events listed', () => {
    writeConfig(repoRoot, {
      hooks: { enabled: true, events: { Stop: [CANONICAL_ZCODE_HOOK_ENTRIES.Stop] } },
    });
    const s = inspectZcodeConfig(repoRoot);
    expect(s.kind).toBe('partial');
    expect(s.missing.sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart'].sort());
  });

  test('malformed → invalid', () => {
    fs.mkdirSync(abs(repoRoot, '.zcode'), { recursive: true });
    fs.writeFileSync(abs(repoRoot, '.zcode/config.json'), '{ broken');
    expect(inspectZcodeConfig(repoRoot).kind).toBe('invalid');
  });
});

describe('config.json.example reference artifact', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('writeZcodeConfigExample writes the canonical snippet, idempotently', () => {
    const p = writeZcodeConfigExample(repoRoot);
    expect(p).toBe(abs(repoRoot, '.zcode/config.json.example'));
    const written = fs.readFileSync(p, 'utf8');
    expect(written).toBe(CANONICAL_ZCODE_CONFIG_SNIPPET + '\n');
    // Second write is byte-identical.
    writeZcodeConfigExample(repoRoot);
    expect(fs.readFileSync(p, 'utf8')).toBe(written);
  });

  test('planZcodeConfigExample: absent → would_create; present+matching → unchanged', () => {
    expect(planZcodeConfigExample(repoRoot).action).toBe('would_create');
    writeZcodeConfigExample(repoRoot);
    expect(planZcodeConfigExample(repoRoot).action).toBe('unchanged');
  });
});
