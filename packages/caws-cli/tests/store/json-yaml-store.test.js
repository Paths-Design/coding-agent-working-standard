'use strict';

/**
 * Branch-coverage tests for:
 *   - src/store/json-store.ts  (readJsonFile)
 *   - src/store/yaml-store.ts  (readYamlFile, readYamlSource)
 *
 * Targets every uncovered branch: ENOENT, non-ENOENT IO failure (stat
 * and read), not-a-file, JSON parse failure, YAML parse failure, and
 * the happy paths. Uses real temp files; no mocks.
 *
 * CAWS-CLI-COVERAGE-FLOOR-001 (bonus file).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJsonFile } = require('../../dist/store/json-store');
const { readYamlFile, readYamlSource } = require('../../dist/store/yaml-store');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// readJsonFile
// ---------------------------------------------------------------------------

describe('readJsonFile', () => {
  let tmp;

  afterEach(() => {
    rmDir(tmp);
    tmp = undefined;
  });

  it('happy path — valid JSON file → ok(parsed)', () => {
    tmp = mkTmpDir('caws-json-store-');
    const file = path.join(tmp, 'data.json');
    fs.writeFileSync(file, JSON.stringify({ hello: 'world', n: 1 }));
    const result = readJsonFile(file);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ hello: 'world', n: 1 });
  });

  it('missing file (ENOENT) → err with rule store.read.missing_file', () => {
    tmp = mkTmpDir('caws-json-store-');
    const file = path.join(tmp, 'nonexistent.json');
    const result = readJsonFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.missing_file');
    expect(result.errors[0].subject).toBe(file);
  });

  it('file exists but unreadable (EACCES) → err with rule store.read.io_failed', () => {
    tmp = mkTmpDir('caws-json-store-');
    const file = path.join(tmp, 'locked.json');
    fs.writeFileSync(file, '{"x":1}');
    fs.chmodSync(file, 0o000);
    try {
      const result = readJsonFile(file);
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.read.io_failed');
      expect(result.errors[0].subject).toBe(file);
      expect(result.errors[0].data).toBeDefined();
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it('malformed JSON → err with rule store.read.json_invalid', () => {
    tmp = mkTmpDir('caws-json-store-');
    const file = path.join(tmp, 'bad.json');
    fs.writeFileSync(file, '{not valid json}');
    const result = readJsonFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.json_invalid');
    expect(result.errors[0].subject).toBe(file);
    expect(result.errors[0].message).toMatch(/JSON parse failed/);
  });

  it('empty file → err with rule store.read.json_invalid', () => {
    tmp = mkTmpDir('caws-json-store-');
    const file = path.join(tmp, 'empty.json');
    fs.writeFileSync(file, '');
    const result = readJsonFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.json_invalid');
  });

  it('valid JSON array → ok(parsed)', () => {
    tmp = mkTmpDir('caws-json-store-');
    const file = path.join(tmp, 'array.json');
    fs.writeFileSync(file, '[1, 2, 3]');
    const result = readJsonFile(file);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// readYamlFile
// ---------------------------------------------------------------------------

describe('readYamlFile', () => {
  let tmp;

  afterEach(() => {
    rmDir(tmp);
    tmp = undefined;
  });

  it('happy path — valid YAML → ok(parsed)', () => {
    tmp = mkTmpDir('caws-yaml-store-');
    const file = path.join(tmp, 'data.yaml');
    fs.writeFileSync(file, 'key: value\nnum: 42\n');
    const result = readYamlFile(file);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: 'value', num: 42 });
  });

  it('missing file (ENOENT) → err with rule store.read.missing_file', () => {
    tmp = mkTmpDir('caws-yaml-store-');
    const file = path.join(tmp, 'missing.yaml');
    const result = readYamlFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.missing_file');
    expect(result.errors[0].subject).toBe(file);
  });

  it('stat non-ENOENT IO failure → err with rule store.read.io_failed', () => {
    tmp = mkTmpDir('caws-yaml-store-');
    const noexecDir = path.join(tmp, 'noexec');
    fs.mkdirSync(noexecDir);
    fs.writeFileSync(path.join(noexecDir, 'file.yaml'), 'key: value');
    fs.chmodSync(noexecDir, 0o000);
    try {
      const file = path.join(noexecDir, 'file.yaml');
      const result = readYamlFile(file);
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.read.io_failed');
      expect(result.errors[0].subject).toBe(file);
    } finally {
      fs.chmodSync(noexecDir, 0o755);
    }
  });

  it('path is a directory (not a regular file) → err with rule store.read.not_a_file', () => {
    tmp = mkTmpDir('caws-yaml-store-');
    const result = readYamlFile(tmp);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.not_a_file');
    expect(result.errors[0].subject).toBe(tmp);
  });

  it('file exists but unreadable (EACCES on read) → err with rule store.read.io_failed', () => {
    tmp = mkTmpDir('caws-yaml-store-');
    const file = path.join(tmp, 'locked.yaml');
    fs.writeFileSync(file, 'key: value');
    fs.chmodSync(file, 0o000);
    try {
      const result = readYamlFile(file);
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.read.io_failed');
      expect(result.errors[0].subject).toBe(file);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it('malformed YAML → err with rule store.read.yaml_invalid', () => {
    tmp = mkTmpDir('caws-yaml-store-');
    const file = path.join(tmp, 'bad.yaml');
    fs.writeFileSync(file, 'key: : invalid:');
    const result = readYamlFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.yaml_invalid');
    expect(result.errors[0].subject).toBe(file);
    expect(result.errors[0].message).toMatch(/YAML parse failed/);
  });
});

// ---------------------------------------------------------------------------
// readYamlSource
// ---------------------------------------------------------------------------

describe('readYamlSource', () => {
  let tmp;

  afterEach(() => {
    rmDir(tmp);
    tmp = undefined;
  });

  it('happy path — returns raw string unparsed', () => {
    tmp = mkTmpDir('caws-yaml-source-');
    const file = path.join(tmp, 'data.yaml');
    const raw = 'key: value\nnum: 42\n';
    fs.writeFileSync(file, raw);
    const result = readYamlSource(file);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(raw);
  });

  it('malformed YAML is returned as raw string (no parse error)', () => {
    tmp = mkTmpDir('caws-yaml-source-');
    const file = path.join(tmp, 'bad.yaml');
    fs.writeFileSync(file, 'key: : invalid:');
    const result = readYamlSource(file);
    // readYamlSource does NOT parse — it must succeed with the raw text
    expect(result.ok).toBe(true);
    expect(typeof result.value).toBe('string');
    expect(result.value).toContain('key: : invalid:');
  });

  it('missing file (ENOENT) → err with rule store.read.missing_file', () => {
    tmp = mkTmpDir('caws-yaml-source-');
    const file = path.join(tmp, 'missing.yaml');
    const result = readYamlSource(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.missing_file');
    expect(result.errors[0].subject).toBe(file);
  });

  it('stat non-ENOENT IO failure → err with rule store.read.io_failed', () => {
    tmp = mkTmpDir('caws-yaml-source-');
    const noexecDir = path.join(tmp, 'noexec');
    fs.mkdirSync(noexecDir);
    fs.writeFileSync(path.join(noexecDir, 'file.yaml'), 'key: value');
    fs.chmodSync(noexecDir, 0o000);
    try {
      const file = path.join(noexecDir, 'file.yaml');
      const result = readYamlSource(file);
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.read.io_failed');
      expect(result.errors[0].subject).toBe(file);
    } finally {
      fs.chmodSync(noexecDir, 0o755);
    }
  });

  it('path is a directory (not a regular file) → err with rule store.read.not_a_file', () => {
    tmp = mkTmpDir('caws-yaml-source-');
    const result = readYamlSource(tmp);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.read.not_a_file');
    expect(result.errors[0].subject).toBe(tmp);
  });

  it('file exists but unreadable (EACCES) → err with rule store.read.io_failed', () => {
    tmp = mkTmpDir('caws-yaml-source-');
    const file = path.join(tmp, 'locked.yaml');
    fs.writeFileSync(file, 'key: value');
    fs.chmodSync(file, 0o000);
    try {
      const result = readYamlSource(file);
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.read.io_failed');
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});
