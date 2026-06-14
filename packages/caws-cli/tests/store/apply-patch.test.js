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

// ---------------------------------------------------------------------------
// Mutation-hardening (CAWS-TEST-MUTATION-GATE-001): the slice-2 tests asserted
// rule CODES + on-disk JSON but not the readRegistryJson read-edge branches,
// the diagnostic MESSAGE/data payloads, or the heartbeat-field writes. These
// pin those so a mutant that swaps a default, blanks a message, drops a field,
// or flips a read-branch is KILLED. (Baseline apply-patch 49.68% -> target 80.)
// ---------------------------------------------------------------------------

describe('apply-patch: readRegistryJson read-edge branches', () => {
  test('a MISSING worktrees.json reads as the default {} -> first bind creates it', () => {
    const dir = cawsDir();
    // No file exists yet; bind must succeed against the {} default.
    const r = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(r.ok).toBe(true);
    expect(readWorktrees(dir)['wt-a'].specId).toBe('SPEC-1');
  });

  test('an EMPTY (whitespace-only) worktrees.json reads as default, bind succeeds', () => {
    const dir = cawsDir();
    fs.writeFileSync(path.join(dir, 'worktrees.json'), '   \n  ');
    const r = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(r.ok).toBe(true);
    expect(readWorktrees(dir)['wt-a'].specId).toBe('SPEC-1');
  });

  test('a JSON null (not an object) -> registry.not_object (distinct from array)', () => {
    const dir = cawsDir();
    fs.writeFileSync(path.join(dir, 'worktrees.json'), 'null');
    const r = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(NOT_OBJECT);
  });

  test('a JSON number (not an object) -> registry.not_object', () => {
    const dir = cawsDir();
    fs.writeFileSync(path.join(dir, 'worktrees.json'), '42');
    expect(applyRegistryPatch(dir, bind('wt-a', 'SPEC-1')).errors[0].rule).toBe(NOT_OBJECT);
  });
});

describe('apply-patch: diagnostic message + data payloads (kills StringLiteral/ObjectLiteral)', () => {
  test('json_invalid message names the file + carries data.filePath', () => {
    const dir = cawsDir();
    const file = path.join(dir, 'worktrees.json');
    fs.writeFileSync(file, '{ broken');
    const e = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1')).errors[0];
    expect(e.message.toLowerCase()).toContain('invalid json');
    expect(e.message).toContain('worktrees.json');
    expect(e.data.filePath).toBe(file);
  });

  test('not_object message names the file and says "not a JSON object"', () => {
    const dir = cawsDir();
    fs.writeFileSync(path.join(dir, 'worktrees.json'), '[]');
    const e = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1')).errors[0];
    expect(e.message).toContain('worktrees.json');
    expect(e.message.toLowerCase()).toContain('not a json object');
  });

  test('patch_target_missing message names the worktree + carries data.worktree_name', () => {
    const dir = cawsDir();
    const e = applyRegistryPatch(dir, {
      kind: 'rebind_worktree',
      worktree_name: 'ghost',
      from_spec_id: 'A',
      to_spec_id: 'B',
      owner,
      when: '2026-06-14T00:00:00.000Z',
    }).errors[0];
    expect(e.message).toContain('ghost');
    expect(e.data.worktree_name).toBe('ghost');
  });
});

describe('apply-patch: field writes + merge preservation (kills the field-assignment mutants)', () => {
  test('bind writes last_heartbeat = patch.when exactly', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, bind('wt-a', 'SPEC-1'));
    expect(readWorktrees(dir)['wt-a'].last_heartbeat).toBe('2026-06-13T12:00:00.000Z');
  });

  test('bind onto an EXISTING entry preserves its other fields (spread merge)', () => {
    const dir = cawsDir();
    // Seed an entry with an extra field the bind must not drop.
    fs.writeFileSync(
      path.join(dir, 'worktrees.json'),
      JSON.stringify({ 'wt-a': { specId: 'OLD', path: '/keep/me', custom: 'x' } }, null, 2)
    );
    applyRegistryPatch(dir, bind('wt-a', 'SPEC-NEW'));
    const e = readWorktrees(dir)['wt-a'];
    expect(e.specId).toBe('SPEC-NEW'); // updated
    expect(e.path).toBe('/keep/me'); // preserved
    expect(e.custom).toBe('x'); // preserved
  });

  test('rebind preserves owner + path while changing specId', () => {
    const dir = cawsDir();
    fs.writeFileSync(
      path.join(dir, 'worktrees.json'),
      JSON.stringify({ 'wt-a': { specId: 'OLD', owner, path: '/p' } }, null, 2)
    );
    applyRegistryPatch(dir, {
      kind: 'rebind_worktree',
      worktree_name: 'wt-a',
      from_spec_id: 'OLD',
      to_spec_id: 'NEW',
      owner,
      when: '2026-06-14T00:00:00.000Z',
    });
    const e = readWorktrees(dir)['wt-a'];
    expect(e.specId).toBe('NEW');
    expect(e.path).toBe('/p');
    expect(e.owner).toEqual(owner);
  });

  test('refresh_agent writes platform + bound fields when present', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, {
      kind: 'refresh_agent',
      session: { session_id: 's-1', platform: 'claude-code' },
      last_active: '2026-06-14T00:00:00.000Z',
      bound_worktree: 'wt-a',
      bound_spec_id: 'SPEC-1',
    });
    const a = readAgents(dir)['s-1'];
    expect(a.platform).toBe('claude-code');
    expect(a.bound_worktree).toBe('wt-a');
    expect(a.bound_spec_id).toBe('SPEC-1');
    expect(a.last_active).toBe('2026-06-14T00:00:00.000Z');
  });

  test('takeover onto an entry with NO prior_owners initializes the audit array (?? [] default)', () => {
    const dir = cawsDir();
    // Seed an entry that has owner but no prior_owners key at all.
    fs.writeFileSync(
      path.join(dir, 'worktrees.json'),
      JSON.stringify({ 'wt-a': { specId: 'S', owner } }, null, 2)
    );
    const priorOwner = { session_id: 's-1', platform: 'claude-code' };
    const r = applyRegistryPatch(dir, {
      kind: 'takeover_claim',
      worktree_name: 'wt-a',
      owner: owner2,
      prior_owner: priorOwner,
      when: '2026-06-14T00:00:00.000Z',
    });
    expect(r.ok).toBe(true);
    const e = readWorktrees(dir)['wt-a'];
    // The ?? [] default must produce exactly [priorOwner], not undefined-push.
    expect(e.prior_owners).toEqual([priorOwner]);
    expect(e.owner).toEqual(owner2);
    // takeover also writes last_heartbeat = patch.when.
    expect(e.last_heartbeat).toBe('2026-06-14T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Mutation-hardening round 2: the refresh_agent optional-field conditional
// spreads (platform / bound_worktree / bound_spec_id are `!== undefined ?
// {x} : {}`), the merge-onto-existing-agent path, and the storeErr no-data
// branch. A mutant that flips `!== undefined` to `=== undefined`, drops the
// conditional, or always-spreads `data` is killed by asserting field PRESENCE
// vs ABSENCE precisely.
// ---------------------------------------------------------------------------

describe('apply-patch round 2: refresh_agent optional-field conditionals (present vs absent)', () => {
  test('refresh_agent OMITS platform when the session has none (!== undefined arm)', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, {
      kind: 'refresh_agent',
      session: { session_id: 's-noplat' }, // no platform
      last_active: '2026-06-14T01:00:00.000Z',
    });
    const a = readAgents(dir)['s-noplat'];
    expect(a.session_id).toBe('s-noplat');
    expect(a.last_active).toBe('2026-06-14T01:00:00.000Z');
    // platform must be ABSENT, not present-as-undefined.
    expect('platform' in a).toBe(false);
  });

  test('refresh_agent OMITS bound_worktree / bound_spec_id when the patch omits them', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, {
      kind: 'refresh_agent',
      session: { session_id: 's-1', platform: 'claude-code' },
      last_active: '2026-06-14T01:00:00.000Z',
      // no bound_worktree, no bound_spec_id
    });
    const a = readAgents(dir)['s-1'];
    expect('bound_worktree' in a).toBe(false);
    expect('bound_spec_id' in a).toBe(false);
    expect(a.platform).toBe('claude-code'); // present arm still fires
  });

  test('refresh_agent merges onto an EXISTING agent record, preserving unrelated fields', () => {
    const dir = cawsDir();
    fs.writeFileSync(
      path.join(dir, 'agents.json'),
      JSON.stringify(
        { 's-1': { session_id: 's-1', platform: 'old-plat', extra: 'keep', last_active: 'OLD' } },
        null,
        2
      )
    );
    applyRegistryPatch(dir, {
      kind: 'refresh_agent',
      session: { session_id: 's-1', platform: 'new-plat' },
      last_active: '2026-06-14T02:00:00.000Z',
    });
    const a = readAgents(dir)['s-1'];
    expect(a.last_active).toBe('2026-06-14T02:00:00.000Z'); // updated
    expect(a.platform).toBe('new-plat'); // updated from the present arm
    expect(a.extra).toBe('keep'); // unrelated field preserved by spread
  });

  test('refresh_agent onto a NEW session seeds session_id + last_active from the ?? default', () => {
    const dir = cawsDir();
    applyRegistryPatch(dir, {
      kind: 'refresh_agent',
      session: { session_id: 's-fresh' },
      last_active: '2026-06-14T03:00:00.000Z',
    });
    const a = readAgents(dir)['s-fresh'];
    expect(a.session_id).toBe('s-fresh');
    expect(a.last_active).toBe('2026-06-14T03:00:00.000Z');
  });
});

describe('apply-patch round 2: storeErr data-conditional (no-data errors carry no data key)', () => {
  test('not_object error has NO data field (storeErr data === undefined arm)', () => {
    const dir = cawsDir();
    fs.writeFileSync(path.join(dir, 'worktrees.json'), '[]');
    const e = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1')).errors[0];
    expect(e.rule).toBe(NOT_OBJECT);
    // storeErr(NOT_OBJECT, msg) is called WITHOUT data -> the base object,
    // no `data` key. A mutant that always spreads `{ ...base, data }` (with
    // data === undefined) would add an own `data: undefined` key.
    expect('data' in e).toBe(false);
  });

  test('json_invalid error DOES carry data.filePath (storeErr data !== undefined arm)', () => {
    const dir = cawsDir();
    const file = path.join(dir, 'worktrees.json');
    fs.writeFileSync(file, '{ broken');
    const e = applyRegistryPatch(dir, bind('wt-a', 'SPEC-1')).errors[0];
    expect(e.rule).toBe(JSON_INVALID);
    expect('data' in e).toBe(true);
    expect(e.data.filePath).toBe(file);
  });
});
