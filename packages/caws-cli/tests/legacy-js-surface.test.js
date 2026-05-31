'use strict';

/**
 * Coverage backfill for the live legacy-JS surface that the v11 runtime
 * still loads from the JS_ALLOWLIST (scripts/build-cli.js):
 *   - src/utils/error-categories.js  (chalk-free; was 0% branch)
 *   - src/utils/detection.js         (detectCAWSSetup; chalk mocked)
 *   - src/config/index.js            (loadProvenanceTools none-found)
 *
 * These files are required directly from src/ (not dist/) — they are the
 * shipped JS glue, not TS-compiled. chalk@5 is pure ESM, so detection.js /
 * config require a chalk mock to instrument under jest's CommonJS transform.
 *
 * CAWS-CLI-COVERAGE-FLOOR-001 (Cluster E).
 */

// chalk@5 is ESM-only; the legacy files `require('chalk')`. Mock it so the
// modules load under jest's CommonJS transform. The mock is a passthrough
// (each style fn returns its input) so output assertions still work.
jest.mock('chalk', () => {
  const passthrough = (s) => s;
  return {
    __esModule: true,
    default: { blue: passthrough, gray: passthrough, green: passthrough, yellow: passthrough, red: passthrough },
    blue: passthrough,
    gray: passthrough,
    green: passthrough,
    yellow: passthrough,
    red: passthrough,
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// error-categories.js — chalk-free; cover every getErrorCategory branch.
// ---------------------------------------------------------------------------

const {
  ERROR_CATEGORIES,
  getErrorCategory,
  getFriendlyMessage,
  getCategorySuggestions,
} = require('../src/utils/error-categories');

describe('error-categories — getErrorCategory', () => {
  it('maps an errno code (ENOENT) to FILESYSTEM via ERROR_CODES', () => {
    expect(getErrorCategory({ code: 'ENOENT' })).toBe(ERROR_CATEGORIES.FILESYSTEM);
  });

  it('maps EACCES to PERMISSION via ERROR_CODES', () => {
    expect(getErrorCategory({ code: 'EACCES' })).toBe(ERROR_CATEGORIES.PERMISSION);
  });

  it('maps ETIMEDOUT to NETWORK via ERROR_CODES', () => {
    expect(getErrorCategory({ code: 'ETIMEDOUT' })).toBe(ERROR_CATEGORIES.NETWORK);
  });

  it('classifies a validation message', () => {
    expect(getErrorCategory('Schema validation failed')).toBe(ERROR_CATEGORIES.VALIDATION);
    expect(getErrorCategory('invalid input')).toBe(ERROR_CATEGORIES.VALIDATION);
  });

  it('classifies a permission message', () => {
    expect(getErrorCategory('permission denied')).toBe(ERROR_CATEGORIES.PERMISSION);
    expect(getErrorCategory('access forbidden')).toBe(ERROR_CATEGORIES.PERMISSION);
  });

  it('classifies a filesystem message', () => {
    expect(getErrorCategory('file not found')).toBe(ERROR_CATEGORIES.FILESYSTEM);
    expect(getErrorCategory('no such directory path')).toBe(ERROR_CATEGORIES.FILESYSTEM);
  });

  it('classifies a network message', () => {
    expect(getErrorCategory('network connection timeout')).toBe(ERROR_CATEGORIES.NETWORK);
  });

  it('classifies a configuration message', () => {
    expect(getErrorCategory('missing config setting')).toBe(ERROR_CATEGORIES.CONFIGURATION);
  });

  it('classifies a user-input message', () => {
    expect(getErrorCategory('invalid prompt answer')).toBe(ERROR_CATEGORIES.VALIDATION);
    // "prompt"/"answer" alone (no validation words) → USER_INPUT
    expect(getErrorCategory('unexpected prompt')).toBe(ERROR_CATEGORIES.USER_INPUT);
  });

  it('classifies a dependency message', () => {
    expect(getErrorCategory('module not found')).toBe(ERROR_CATEGORIES.FILESYSTEM);
    // "dependency" with no filesystem words → DEPENDENCY
    expect(getErrorCategory('unmet dependency')).toBe(ERROR_CATEGORIES.DEPENDENCY);
  });

  it('falls back to UNKNOWN for an unclassifiable message', () => {
    expect(getErrorCategory('something totally opaque')).toBe(ERROR_CATEGORIES.UNKNOWN);
  });

  it('handles a string error (not an object)', () => {
    expect(getErrorCategory('validation error')).toBe(ERROR_CATEGORIES.VALIDATION);
  });

  it('handles an error object with a message but no code', () => {
    expect(getErrorCategory({ message: 'permission denied' })).toBe(ERROR_CATEGORIES.PERMISSION);
  });

  it('handles a null/undefined error → UNKNOWN', () => {
    expect(getErrorCategory(null)).toBe(ERROR_CATEGORIES.UNKNOWN);
    expect(getErrorCategory(undefined)).toBe(ERROR_CATEGORIES.UNKNOWN);
  });
});

describe('error-categories — getFriendlyMessage / getCategorySuggestions', () => {
  it('returns a category-specific friendly message', () => {
    expect(getFriendlyMessage(ERROR_CATEGORIES.PERMISSION, 'raw')).toMatch(/Permission denied/);
  });

  it('falls back to the original message for an unknown category', () => {
    expect(getFriendlyMessage('not-a-category', 'the original')).toBe('the original');
  });

  it('returns a non-empty suggestion array for a known category', () => {
    const s = getCategorySuggestions(ERROR_CATEGORIES.FILESYSTEM);
    expect(Array.isArray(s)).toBe(true);
    expect(s.length).toBeGreaterThan(0);
  });

  it('returns a fallback for an unknown category', () => {
    const s = getCategorySuggestions('not-a-category');
    expect(Array.isArray(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detection.js — detectCAWSSetup setup-type classification.
// ---------------------------------------------------------------------------

const { detectCAWSSetup } = require('../src/utils/detection');

describe('detection — detectCAWSSetup', () => {
  let tmp;
  const origQuiet = process.env.CAWS_QUIET;

  beforeEach(() => {
    // Quiet so the chalk console.log paths are skipped deterministically and
    // do not spam the test output. The non-quiet path is covered separately.
    process.env.CAWS_QUIET = '1';
  });

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
    if (origQuiet === undefined) delete process.env.CAWS_QUIET;
    else process.env.CAWS_QUIET = origQuiet;
  });

  it('no .caws directory → type "new"', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-detect-'));
    const r = detectCAWSSetup(tmp);
    expect(r.type).toBe('new');
    expect(r.hasCAWSDir).toBe(false);
    expect(r.capabilities).toEqual([]);
  });

  it('.caws with working-spec.yaml → type "standard" with working-spec capability', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-detect-'));
    fs.mkdirSync(path.join(tmp, '.caws'));
    fs.writeFileSync(path.join(tmp, '.caws', 'working-spec.yaml'), 'id: X\n');
    const r = detectCAWSSetup(tmp);
    expect(r.hasCAWSDir).toBe(true);
    expect(r.type).toBe('standard');
    expect(r.capabilities).toContain('working-spec');
  });

  it('.caws with multiple *-spec.yaml + working-spec → type "enhanced"', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-detect-'));
    const cawsDir = path.join(tmp, '.caws');
    fs.mkdirSync(cawsDir);
    fs.writeFileSync(path.join(cawsDir, 'working-spec.yaml'), 'id: X\n');
    fs.writeFileSync(path.join(cawsDir, 'a-spec.yaml'), 'id: A\n');
    fs.writeFileSync(path.join(cawsDir, 'b-spec.yaml'), 'id: B\n');
    const r = detectCAWSSetup(tmp);
    expect(r.type).toBe('enhanced');
    expect(r.capabilities).toContain('multiple-specs');
  });

  it('.caws with policy/schemas/templates dirs adds those capabilities', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-detect-'));
    const cawsDir = path.join(tmp, '.caws');
    fs.mkdirSync(cawsDir);
    fs.writeFileSync(path.join(cawsDir, 'working-spec.yaml'), 'id: X\n');
    fs.mkdirSync(path.join(cawsDir, 'policy'));
    fs.mkdirSync(path.join(cawsDir, 'schemas'));
    fs.mkdirSync(path.join(cawsDir, 'templates'));
    const r = detectCAWSSetup(tmp);
    expect(r.capabilities).toEqual(
      expect.arrayContaining(['policies', 'schemas', 'templates'])
    );
  });

  it('bare .caws dir (no working-spec) → type "basic"', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-detect-'));
    fs.mkdirSync(path.join(tmp, '.caws'));
    const r = detectCAWSSetup(tmp);
    expect(r.type).toBe('basic');
  });

  it('non-quiet path logs without throwing', () => {
    delete process.env.CAWS_QUIET;
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-detect-'));
    try {
      const r = detectCAWSSetup(tmp);
      expect(r.type).toBe('new');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// config/index.js — loadProvenanceTools none-found path (v10 stub).
// ---------------------------------------------------------------------------

const config = require('../src/config');

describe('config — exports + loadProvenanceTools', () => {
  it('exposes CLI_VERSION as a non-empty string', () => {
    expect(typeof config.CLI_VERSION).toBe('string');
    expect(config.CLI_VERSION.length).toBeGreaterThan(0);
  });

  it('loadProvenanceTools returns null when no provenance module is present', () => {
    let tmp;
    const cwdSpy = jest.spyOn(process, 'cwd');
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-config-'));
      cwdSpy.mockReturnValue(tmp);
      // No provenance.js anywhere under the temp cwd → the search exhausts
      // and returns null (the v10-compat stub's none-found branch).
      expect(config.loadProvenanceTools()).toBeNull();
    } finally {
      cwdSpy.mockRestore();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
