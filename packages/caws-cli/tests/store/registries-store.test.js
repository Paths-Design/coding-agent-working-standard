/**
 * Tests for worktrees-store and agents-store.
 *   - missing file → Ok({})
 *   - malformed JSON → Err
 *   - non-object payload → Err (REGISTRY_NOT_OBJECT)
 *   - valid object → Ok(object)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadAgents,
  loadWorktrees,
  STORE_RULES,
} = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reg-store-'));
}

describe.each([
  ['worktrees', 'worktrees.json', loadWorktrees],
  ['agents', 'agents.json', loadAgents],
])('%s registry loader', (label, filename, loader) => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('missing file → Ok({})', () => {
    cawsDir = mkTempCawsDir();
    const r = loader(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({});
  });

  it('valid object → Ok(object)', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, filename), JSON.stringify({ entry: { foo: 'bar' } }));
    const r = loader(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.entry.foo).toBe('bar');
  });

  it('malformed JSON → Err with READ_JSON_INVALID', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, filename), '{not valid json');
    const r = loader(cawsDir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.rule === STORE_RULES.READ_JSON_INVALID)).toBe(true);
  });

  it('array payload → Err with REGISTRY_NOT_OBJECT', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, filename), JSON.stringify([1, 2, 3]));
    const r = loader(cawsDir);
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.REGISTRY_NOT_OBJECT);
  });

  it('null payload → Err with REGISTRY_NOT_OBJECT', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, filename), 'null');
    const r = loader(cawsDir);
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.REGISTRY_NOT_OBJECT);
  });
});
