'use strict';

/**
 * Unit tests for applyRegistryPatch (A3 — typed patch envelope -> on-disk JSON).
 *
 * CAWS-TEST-CLI-STORE-001. This is the SINGLE place kernel-emitted RegistryPatch
 * envelopes become atomic writes to worktrees.json / agents.json. Tests assert
 * the REAL on-disk JSON after each patch kind, the dispatch routing, the
 * missing-target refusal (no silent create), the append-only prior_owners
 * invariant, and the read-refuses-malformed-JSON safety (no overwrite of
 * recoverable state) — by reading the actual files, not mocks.
 *
 * SUT loaded from dist/. cawsDir is a per-test os.tmpdir() directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyRegistryPatch } = require('../../dist/store/apply-patch');

const TARGET_MISSING = 'store.write.patch_target_missing';
const JSON_INVALID = 'store.read.json_invalid';
const NOT_OBJECT = 'store.registry.not_object';

const dirs = [];
function cawsDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ap-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function readWorktrees(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'worktrees.json'), 'utf8'));
}
function readAgents(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
}

const owner = { session_id: 's-1', platform: 'claude-code' };
const owner2 = { session_id: 's-2', platform: 'codex' };

const bind = (name, specId, o = owner) => ({
  kind: 'bind_worktree',
  worktree_name: name,
  spec_id: specId,
  owner: o,
  when: '2026-06-13T12:00:00.000Z',
});

describe('applyRegistryPatch: bind_worktree', () => {
  test('writes worktrees.json with specId + owner + heartbeat', () => {
    const dir = cawsDir();
    const r = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(r.ok).toBe(true);
    const reg = readWorktrees(dir);
    expect(reg['wt-a'].specId).toBe('SPEC-1');
    expect(reg['wt-a'].owner).toEqual(owner);
    expect(reg['wt-a'].last_heartbeat).toBe('2026-06-13T12:00:00.000Z');
  });

  test('a second bind preserves the first entry (flat-map, not overwrite-all)', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    applyRegistryPatch(dir, bind('wt-b', 'SPEC-2'));
    const reg = readWorktrees(dir);
    expect(Object.keys(reg).sort()).toEqual(['wt-a', 'wt-b']);
  });

  test('bind does NOT touch agents.json (registry separation)', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(fs.existsSync(path.join(dir, 'agents.json'))).toBe(false);
  });
});

describe('applyRegistryPatch: rebind_worktree', () => {
  test('changes specId on an existing entry, preserving owner', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    const r = applyRegistryPatch(dir, {
      kind: 'rebind_worktree',
      worktree_name: 'wt-a',
      from_spec_id: 'SPEC-1',
      to_spec_id: 'SPEC-9',
      owner,
      when: '2026-06-13T13:00:00.000Z',
    });
    expect(r.ok).toBe(true);
    const reg = readWorktrees(dir);
    expect(reg['wt-a'].specId).toBe('SPEC-9');
    expect(reg['wt-a'].owner).toEqual(owner); // preserved
  });

  test('rebind of a MISSING entry refuses (no silent create) -> patch_target_missing', () => {
    const dir = cawsDir();
    const r = applyRegistryPatch(dir, {
      kind: 'rebind_worktree',
      worktree_name: 'ghost',
      from_spec_id: 'A',
      to_spec_id: 'B',
      owner,
      when: '2026-06-13T13:00:00.000Z',
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(TARGET_MISSING);
    // And it did NOT create a file with a phantom entry.
    expect(fs.existsSync(path.join(dir, 'worktrees.json'))).toBe(false);
  });
});

describe('applyRegistryPatch: takeover_claim (prior_owners is append-only)', () => {
  const priorOwner = {
    session_id: 's-1',
    platform: 'claude-code',
    takenOver_at: '2026-06-13T14:00:00.000Z',
  };

  test('takeover changes owner and APPENDS to prior_owners', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, bind('wt-a', 'SPEC-1', owner));
    const r = applyRegistryPatch(dir, {
      kind: 'takeover_claim',
      worktree_name: 'wt-a',
      owner: owner2,
      prior_owner: priorOwner,
      when: '2026-06-13T14:00:00.000Z',
    });
    expect(r.ok).toBe(true);
    const reg = readWorktrees(dir);
    expect(reg['wt-a'].owner).toEqual(owner2);
    expect(reg['wt-a'].prior_owners).toEqual([priorOwner]);
  });

  test('a SECOND takeover appends, never truncates the prior_owners audit', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, bind('wt-a', 'SPEC-1', owner));
    applyRegistryPatch(dir, {
      kind: 'takeover_claim',
      worktree_name: 'wt-a',
      owner: owner2,
      prior_owner: priorOwner,
      when: '2026-06-13T14:00:00.000Z',
    });
    const second = { session_id: 's-2', platform: 'codex', takenOver_at: '2026-06-13T15:00:00.000Z' };
    applyRegistryPatch(dir, {
      kind: 'takeover_claim',
      worktree_name: 'wt-a',
      owner,
      prior_owner: second,
      when: '2026-06-13T15:00:00.000Z',
    });
    const reg = readWorktrees(dir);
    expect(reg['wt-a'].prior_owners).toEqual([priorOwner, second]); // both, in order
  });

  test('takeover of a MISSING entry refuses -> patch_target_missing', () => {
    const dir = cawsDir();
    const r = applyRegistryPatch(dir, {
      kind: 'takeover_claim',
      worktree_name: 'ghost',
      owner: owner2,
      prior_owner: priorOwner,
      when: '2026-06-13T14:00:00.000Z',
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(TARGET_MISSING);
  });
});

describe('applyRegistryPatch: refresh_agent (writes agents.json, NOT worktrees.json)', () => {
  test('writes the agent freshness record to agents.json', () => {
    const dir = cawsDir();
    const r = applyRegistryPatch(dir, {
      kind: 'refresh_agent',
      session: owner,
      last_active: '2026-06-13T12:00:00.000Z',
      bound_worktree: 'wt-a',
      bound_spec_id: 'SPEC-1',
    });
    expect(r.ok).toBe(true);
    const agents = readAgents(dir);
    expect(agents['s-1'].last_active).toBe('2026-06-13T12:00:00.000Z');
    expect(agents['s-1'].bound_worktree).toBe('wt-a');
    // refresh_agent must NOT write worktrees.json (registry separation).
    expect(fs.existsSync(path.join(dir, 'worktrees.json'))).toBe(false);
  });
});

describe('applyRegistryPatch: refuses to overwrite malformed on-disk JSON', () => {
  test('malformed worktrees.json -> Err json_invalid, file is NOT overwritten', () => {
    const dir = cawsDir();
    const file = path.join(dir, 'worktrees.json');
    fs.writeFileSync(file, '{ this is not valid json ');
    const r = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(JSON_INVALID);
    // Recoverable user state is preserved, not clobbered.
    expect(fs.readFileSync(file, 'utf8')).toBe('{ this is not valid json ');
  });

  test('a JSON array (not an object) -> Err registry.not_object', () => {
    const dir = cawsDir();
    fs.writeFileSync(path.join(dir, 'worktrees.json'), '[]');
    const r = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(NOT_OBJECT);
  });
});
