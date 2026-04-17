/**
 * Waiver prune tests — CAWSFIX-04 A3-A6.
 *
 * Verifies that `caws waivers prune --expired` correctly identifies
 * active-but-past-expiry waivers, that dry-run mode (no --apply) never
 * modifies disk or emits events, that --apply transitions each prunable
 * waiver file in place to `status: expired` and writes a `waiver_pruned`
 * event to the event log, and that unexpired/revoked/expired waivers are
 * left untouched.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

// chalk is ESM-only; mock it with a transparent pass-through proxy so the
// command module can require('chalk') in this CJS test env.
jest.mock('chalk', () => {
  const handler = {
    get(target, prop) {
      if (typeof prop === 'string') {
        const fn = (str) => str;
        return new Proxy(fn, handler);
      }
      return target[prop];
    },
    apply(target, thisArg, args) {
      return args[0];
    },
  };
  return new Proxy((str) => str, handler);
});

// Avoid full CAWS initialization in pruneWaivers → commandWrapper flow.
jest.mock('../src/config', () => ({
  initializeGlobalSetup: jest.fn(() => ({
    hasWorkingSpec: false,
    type: 'lite',
    capabilities: [],
  })),
}));

const { waiversCommand } = require('../src/commands/waivers');
const WaiversManager = require('../src/waivers-manager');

let tmpDir;
let waiversDir;
let originalCwd;
let mockExit;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-waiver-prune-'));
  waiversDir = path.join(tmpDir, '.caws', 'waivers');
  fs.mkdirSync(waiversDir, { recursive: true });

  // Minimal working-spec so event-log / initializeGlobalSetup has a project root.
  fs.writeFileSync(
    path.join(tmpDir, '.caws', 'working-spec.yaml'),
    'id: TEST-0001\ntitle: test\n'
  );

  originalCwd = process.cwd();
  process.chdir(tmpDir);

  mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  jest.restoreAllMocks();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Helper: write a waiver file to the tmp waivers dir with the given fields.
 */
function writeWaiver(id, fields) {
  const waiver = {
    id,
    applies_to: 'TEST-0001',
    gates: ['budget_limit'],
    reason_code: 'other',
    description:
      'A test waiver used only by the prune test suite. Fifty chars minimum is satisfied by this sentence.',
    mitigation:
      'Test mitigation text; pruning tests do not exercise this field semantically, but schema requires it.',
    expires_at: '2099-12-31T23:59:59Z',
    risk_owner: 'test',
    approvers: [{ handle: 'test', approved_at: '2025-01-01T00:00:00Z' }],
    status: 'active',
    ...fields,
  };
  fs.writeFileSync(
    path.join(waiversDir, `${id}.yaml`),
    yaml.dump(waiver, { lineWidth: -1 })
  );
  return waiver;
}

/**
 * Helper: find the first console.log call that is valid JSON and return its
 * parsed value. Needed because commandWrapper/safeAsync emits timing lines
 * that pollute the output stream in text mode.
 */
function getJsonOutput() {
  for (const args of console.log.mock.calls) {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      const trimmed = arg.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        // not JSON; try next
      }
    }
  }
  return null;
}

/**
 * Helper: read an event log entry (if any events.jsonl exists).
 */
function readEvents() {
  const eventsPath = path.join(tmpDir, '.caws', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// AC3 — dry run reports candidates, no disk changes, no events
// ---------------------------------------------------------------------------

describe('CAWSFIX-04 A3: dry-run lists prunable waivers and makes no changes', () => {
  test('reports expired-active waivers and omits expired/revoked/still-active', async () => {
    // 1 active-but-expired (prunable), 1 active-not-expired (skip),
    // 1 already-expired (skip), 1 revoked (skip).
    writeWaiver('WV-1001', {
      status: 'active',
      expires_at: '2020-01-01T00:00:00Z',
    });
    writeWaiver('WV-1002', {
      status: 'active',
      expires_at: '2099-12-31T23:59:59Z',
    });
    writeWaiver('WV-1003', {
      status: 'expired',
      expires_at: '2020-01-01T00:00:00Z',
    });
    writeWaiver('WV-1004', {
      status: 'revoked',
      expires_at: '2020-01-01T00:00:00Z',
    });

    await waiversCommand('prune', { expired: true, json: true });

    const parsed = getJsonOutput();
    expect(parsed).not.toBeNull();
    expect(parsed.status).toBe('dry_run');
    expect(parsed.applied).toBe(false);
    expect(parsed.pruned).toEqual([
      { id: 'WV-1001', expires_at: '2020-01-01T00:00:00Z' },
    ]);
  });

  test('dry-run does not modify any waiver file on disk', async () => {
    writeWaiver('WV-2001', {
      status: 'active',
      expires_at: '2020-01-01T00:00:00Z',
    });
    const beforeStat = fs.statSync(path.join(waiversDir, 'WV-2001.yaml'));
    const beforeContent = fs.readFileSync(path.join(waiversDir, 'WV-2001.yaml'), 'utf8');

    await waiversCommand('prune', { expired: true, json: true });

    const afterStat = fs.statSync(path.join(waiversDir, 'WV-2001.yaml'));
    const afterContent = fs.readFileSync(path.join(waiversDir, 'WV-2001.yaml'), 'utf8');
    expect(afterContent).toBe(beforeContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test('dry-run emits no events to the event log', async () => {
    writeWaiver('WV-3001', {
      status: 'active',
      expires_at: '2020-01-01T00:00:00Z',
    });

    await waiversCommand('prune', { expired: true, json: true });

    expect(readEvents()).toEqual([]);
  });

  test('dry-run exits with status 0 (no process.exit call)', async () => {
    writeWaiver('WV-4001', {
      status: 'active',
      expires_at: '2020-01-01T00:00:00Z',
    });

    await waiversCommand('prune', { expired: true, json: true });

    // process.exit should not be called for a successful dry run.
    // (The only case we exit is missing --expired flag.)
    expect(mockExit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC4 — --apply transitions each prunable waiver in place and emits events
// ---------------------------------------------------------------------------

describe('CAWSFIX-04 A4: --apply transitions status in place and emits events', () => {
  test('prunable waiver file gets status=expired (not deleted)', async () => {
    writeWaiver('WV-5001', {
      status: 'active',
      expires_at: '2020-01-01T00:00:00Z',
    });

    await waiversCommand('prune', { expired: true, apply: true, json: true });

    const filePath = path.join(waiversDir, 'WV-5001.yaml');
    // File still exists — audit trail preserved.
    expect(fs.existsSync(filePath)).toBe(true);
    const after = yaml.load(fs.readFileSync(filePath, 'utf8'));
    expect(after.status).toBe('expired');
    expect(after.id).toBe('WV-5001');
    // expired_at stamp was added.
    expect(typeof after.expired_at).toBe('string');
    expect(Number.isFinite(new Date(after.expired_at).getTime())).toBe(true);
  });

  test('already-expired and revoked waivers are untouched on --apply', async () => {
    writeWaiver('WV-6001', {
      status: 'expired',
      expires_at: '2020-01-01T00:00:00Z',
    });
    writeWaiver('WV-6002', {
      status: 'revoked',
      expires_at: '2020-01-01T00:00:00Z',
    });
    const expBefore = fs.readFileSync(path.join(waiversDir, 'WV-6001.yaml'), 'utf8');
    const revBefore = fs.readFileSync(path.join(waiversDir, 'WV-6002.yaml'), 'utf8');

    await waiversCommand('prune', { expired: true, apply: true, json: true });

    const expAfter = fs.readFileSync(path.join(waiversDir, 'WV-6001.yaml'), 'utf8');
    const revAfter = fs.readFileSync(path.join(waiversDir, 'WV-6002.yaml'), 'utf8');
    expect(expAfter).toBe(expBefore);
    expect(revAfter).toBe(revBefore);
  });

  test('a waiver_pruned event is appended per transitioned waiver', async () => {
    writeWaiver('WV-7001', {
      status: 'active',
      expires_at: '2020-01-01T00:00:00Z',
      applies_to: 'SPEC-ABC',
    });
    writeWaiver('WV-7002', {
      status: 'active',
      expires_at: '2020-06-15T00:00:00Z',
      applies_to: 'SPEC-DEF',
    });
    writeWaiver('WV-7003', {
      status: 'active',
      expires_at: '2099-12-31T23:59:59Z',
    }); // not prunable

    await waiversCommand('prune', { expired: true, apply: true, json: true });

    const events = readEvents();
    const pruneEvents = events.filter((e) => e.event === 'waiver_pruned');
    expect(pruneEvents).toHaveLength(2);

    const ids = pruneEvents.map((e) => e.data.waiver_id).sort();
    expect(ids).toEqual(['WV-7001', 'WV-7002']);

    // spec_id is populated from applies_to when set
    const e1 = pruneEvents.find((e) => e.data.waiver_id === 'WV-7001');
    expect(e1.spec_id).toBe('SPEC-ABC');
    expect(e1.data.previous_status).toBe('active');
    expect(e1.data.new_status).toBe('expired');
    expect(e1.data.expires_at).toBe('2020-01-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// AC5 — active, not-yet-expired waiver is not touched by --apply
// ---------------------------------------------------------------------------

describe('CAWSFIX-04 A5: active-not-expired waivers are never pruned', () => {
  test('--apply does not modify active waiver with future expires_at', async () => {
    writeWaiver('WV-8001', {
      status: 'active',
      expires_at: '2099-12-31T23:59:59Z',
    });
    const before = fs.readFileSync(path.join(waiversDir, 'WV-8001.yaml'), 'utf8');

    await waiversCommand('prune', { expired: true, apply: true, json: true });

    const after = fs.readFileSync(path.join(waiversDir, 'WV-8001.yaml'), 'utf8');
    expect(after).toBe(before);
  });

  test('--apply emits no events when nothing is prunable', async () => {
    writeWaiver('WV-8101', {
      status: 'active',
      expires_at: '2099-12-31T23:59:59Z',
    });

    await waiversCommand('prune', { expired: true, apply: true, json: true });

    const events = readEvents();
    expect(events.filter((e) => e.event === 'waiver_pruned')).toEqual([]);
  });

  test('active-not-expired waiver is not in the reported prune list', async () => {
    writeWaiver('WV-8201', {
      status: 'active',
      expires_at: '2099-12-31T23:59:59Z',
    });

    await waiversCommand('prune', { expired: true, json: true });

    const parsed = getJsonOutput();
    expect(parsed).not.toBeNull();
    expect(parsed.pruned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC6 — empty registry returns exit 0 with friendly message
// ---------------------------------------------------------------------------

describe('CAWSFIX-04 A6: empty registry is a no-op', () => {
  test('no WV-*.yaml files → friendly message, exit 0, no events', async () => {
    // waiversDir exists but contains no waiver files (maybe some unrelated noise).
    fs.writeFileSync(path.join(waiversDir, 'README.txt'), 'not a waiver');

    await waiversCommand('prune', { expired: true, json: true });

    const parsed = getJsonOutput();
    expect(parsed).not.toBeNull();
    expect(parsed.status).toBe('ok');
    expect(parsed.pruned).toEqual([]);
    expect(parsed.message).toMatch(/no active waivers/i);
    expect(mockExit).not.toHaveBeenCalled();
    expect(readEvents()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findExpiredWaivers unit behavior — cross-checks WaiversManager directly
// ---------------------------------------------------------------------------

describe('WaiversManager.findExpiredWaivers — unit', () => {
  test('returns only status=active waivers whose expires_at is in the past', () => {
    writeWaiver('WV-9001', {
      status: 'active',
      expires_at: '2020-01-01T00:00:00Z',
    });
    writeWaiver('WV-9002', {
      status: 'active',
      expires_at: '2099-12-31T23:59:59Z',
    });
    writeWaiver('WV-9003', {
      status: 'expired',
      expires_at: '2020-01-01T00:00:00Z',
    });

    const wm = new WaiversManager({ projectRoot: tmpDir });
    const candidates = wm.findExpiredWaivers();
    const ids = candidates.map((c) => c.id).sort();
    expect(ids).toEqual(['WV-9001']);
  });

  test('accepts an injected clock (nowOverride)', () => {
    writeWaiver('WV-9101', {
      status: 'active',
      expires_at: '2050-06-15T00:00:00Z',
    });

    const wm = new WaiversManager({ projectRoot: tmpDir });
    // Before expiry — nothing prunable.
    expect(wm.findExpiredWaivers(new Date('2049-01-01T00:00:00Z'))).toEqual([]);
    // After expiry — prunable.
    const post = wm.findExpiredWaivers(new Date('2099-01-01T00:00:00Z'));
    expect(post.map((c) => c.id)).toEqual(['WV-9101']);
  });
});
