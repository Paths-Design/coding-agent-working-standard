/**
 * Waiver enforcement tests
 *
 * Validates that waiver self-approval prevention works correctly:
 * - Creator session cannot approve their own waiver
 * - Different approvers are allowed
 * - No enforcement when CLAUDE_SESSION_ID is unset
 * - created_by_session field is stored for audit trail
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

// Mock chalk (ESM-only, can't be required in CJS test environment)
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

// Mock the config module to avoid full CAWS initialization
jest.mock('../../src/config', () => ({
  initializeGlobalSetup: jest.fn(() => ({
    hasWorkingSpec: false,
    setupType: 'lite',
    capabilities: [],
  })),
}));

// Mock the waivers-manager to avoid file system side effects from addToActiveWaivers
jest.mock('../../src/waivers-manager', () => {
  return jest.fn().mockImplementation(() => ({
    loadActiveWaivers: jest.fn().mockResolvedValue([]),
    saveActiveWaivers: jest.fn().mockResolvedValue(undefined),
  }));
});

const { waiversCommand } = require('../../src/commands/waivers');

let tmpDir;
let mockExit;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-waiver-test-'));
  fs.mkdirSync(path.join(tmpDir, '.caws', 'waivers'), { recursive: true });

  // Mock process.exit to prevent test runner from exiting
  mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});

  // Suppress console output during tests
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.CLAUDE_SESSION_ID;
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Helper: build valid waiver options with all required fields.
 */
function validWaiverOptions(overrides = {}) {
  return {
    title: 'Test waiver',
    reason: 'emergency_hotfix',
    description: 'Test description',
    gates: 'naming',
    expiresAt: '2099-12-31T23:59:59Z',
    approvedBy: '@manager',
    impactLevel: 'high',
    mitigationPlan: 'Will fix in follow-up',
    ...overrides,
  };
}

/**
 * Helper: run createWaiver in a tmp directory.
 * Returns { exitCalled, consoleErrors } for inspection.
 */
async function runCreateWaiver(options) {
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await waiversCommand('create', options);
  } finally {
    process.chdir(originalCwd);
  }
}

/**
 * Helper: collect all console.error call arguments as a single string.
 */
function getConsoleErrors() {
  return console.error.mock.calls.map((args) => args.join(' ')).join('\n');
}

describe('Waiver self-approval prevention', () => {
  test('createWaiver rejects when CLAUDE_SESSION_ID matches approvedBy', async () => {
    process.env.CLAUDE_SESSION_ID = 'session-abc-123';

    await runCreateWaiver(
      validWaiverOptions({ approvedBy: 'session-abc-123' })
    );

    // The error handler logs the error message to console.error, then calls process.exit(1)
    const errors = getConsoleErrors();
    expect(errors).toContain('Waiver creator cannot be the approver');
    expect(errors).toContain('session-abc-123');
    expect(mockExit).toHaveBeenCalledWith(1);

    // No waiver file should have been created
    const waiverFiles = fs
      .readdirSync(path.join(tmpDir, '.caws', 'waivers'))
      .filter((f) => f.endsWith('.yaml'));
    expect(waiverFiles.length).toBe(0);
  });

  test('createWaiver rejects when approvedBy contains CLAUDE_SESSION_ID as substring', async () => {
    process.env.CLAUDE_SESSION_ID = 'session-xyz';

    await runCreateWaiver(
      validWaiverOptions({ approvedBy: 'approved-by-session-xyz-and-others' })
    );

    const errors = getConsoleErrors();
    expect(errors).toContain('Waiver creator cannot be the approver');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  test('createWaiver succeeds when approvedBy differs from CLAUDE_SESSION_ID', async () => {
    process.env.CLAUDE_SESSION_ID = 'session-abc-123';

    await runCreateWaiver(
      validWaiverOptions({ approvedBy: '@different-manager' })
    );

    const errors = getConsoleErrors();
    expect(errors).not.toContain('Waiver creator cannot be the approver');

    // Verify a waiver file was actually created
    const waiverFiles = fs
      .readdirSync(path.join(tmpDir, '.caws', 'waivers'))
      .filter((f) => f.endsWith('.yaml'));
    expect(waiverFiles.length).toBe(1);
  });

  test('createWaiver succeeds when CLAUDE_SESSION_ID is not set', async () => {
    delete process.env.CLAUDE_SESSION_ID;

    await runCreateWaiver(
      validWaiverOptions({ approvedBy: 'anyone' })
    );

    const errors = getConsoleErrors();
    expect(errors).not.toContain('Waiver creator cannot be the approver');

    // Verify a waiver file was actually created
    const waiverFiles = fs
      .readdirSync(path.join(tmpDir, '.caws', 'waivers'))
      .filter((f) => f.endsWith('.yaml'));
    expect(waiverFiles.length).toBe(1);
  });

  test('waiver object includes created_by_session field', async () => {
    process.env.CLAUDE_SESSION_ID = 'session-audit-trail';

    await runCreateWaiver(
      validWaiverOptions({ approvedBy: '@different-approver' })
    );

    // Read the created waiver file and verify created_by_session
    const waiverFiles = fs
      .readdirSync(path.join(tmpDir, '.caws', 'waivers'))
      .filter((f) => f.endsWith('.yaml'));
    expect(waiverFiles.length).toBe(1);

    const waiverContent = fs.readFileSync(
      path.join(tmpDir, '.caws', 'waivers', waiverFiles[0]),
      'utf8'
    );
    const waiver = yaml.load(waiverContent);

    expect(waiver.created_by_session).toBe('session-audit-trail');
  });
});
