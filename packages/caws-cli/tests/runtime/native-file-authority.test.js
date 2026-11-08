const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  readNativeFileAuthority,
  NativeFileAuthorityError,
} = require('../../dist/runtime/file-tools/authority');
const { evaluatePath } = require('../../dist/kernel');

const roots = [];
const clone = (value) => JSON.parse(JSON.stringify(value));
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-file-authority-')));
  roots.push(root);
  const repo = path.join(root, 'project');
  const lane = path.join(root, 'owned');
  const caws = path.join(repo, '.caws');
  const gitDir = path.join(repo, '.git/worktrees/owned');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(lane);
  const sid = 'original-session_01';
  const policy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 10, max_loc: 250 },
      2: { max_files: 100, max_loc: 10000 },
      3: { max_files: 500, max_loc: 40000 },
    },
    gates: {
      budget_limit: { enabled: true, mode: 'warn' },
      spec_completeness: { enabled: true, mode: 'block' },
      scope_boundary: { enabled: true, mode: 'block' },
    },
  };
  const spec = {
    id: 'NATIVE-FILE-001',
    title: 'Owned native file authority',
    mode: 'chore',
    lifecycle_state: 'active',
    worktree: 'owned',
    blast_radius: { modules: ['fixture'] },
    scope: { in: ['src/allowed/'], out: ['src/forbidden/'] },
    invariants: ['Only the original owning session has standing'],
    acceptance: [{ id: 'A1', given: 'owned lane', when: 'write', then: 'checked' }],
    non_functional: {},
    contracts: [],
  };
  const registry = {
    owned: {
      path: lane,
      branch: 'caws/owned',
      baseBranch: 'main',
      specId: spec.id,
      owner: { session_id: sid, platform: 'claude-code' },
    },
  };
  const context = {
    checkout: lane,
    canonical: repo,
    gitDir,
    commonDir: path.join(repo, '.git'),
    branch: 'caws/owned',
    mergeInProgress: false,
    worktrees: [
      { path: repo, branch: 'refs/heads/main', detached: false, prunable: false, bare: false },
      {
        path: lane,
        branch: 'refs/heads/caws/owned',
        detached: false,
        prunable: false,
        bare: false,
      },
    ],
  };
  const f = {
    root,
    repo,
    lane,
    caws,
    sid,
    policy,
    spec,
    registry,
    context,
    checkpoint: () => {},
    persist() {
      put(path.join(caws, 'policy.yaml'), policy);
      put(path.join(caws, 'worktrees.json'), registry);
      put(path.join(caws, 'specs', spec.id + '.yaml'), spec);
    },
  };
  f.persist();
  return f;
}
function capture(f, changes = {}) {
  return readNativeFileAuthority({
    context: clone(f.context),
    originalSessionId: f.sid,
    surface: 'claude-code',
    checkpoint: f.checkpoint,
    ...changes,
  });
}
function refuses(f, changes = {}) {
  expect(() => capture(f, changes)).toThrow(NativeFileAuthorityError);
}
function addPeer(f, owner = 'other/session:@é') {
  const peer = path.join(f.root, 'peer');
  fs.mkdirSync(peer);
  const spec = { ...clone(f.spec), id: 'NATIVE-PEER-001', worktree: 'peer' };
  f.registry.peer = {
    path: peer,
    branch: 'caws/peer',
    specId: spec.id,
    owner: { session_id: owner, platform: 'other-surface' },
  };
  f.context.worktrees.push({
    path: peer,
    branch: 'refs/heads/caws/peer',
    detached: false,
    prunable: false,
    bare: false,
  });
  put(path.join(f.caws, 'specs', spec.id + '.yaml'), spec);
  f.persist();
  return peer;
}
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('derives the owned external checkout without launching a child or granting arbitrary targets', () => {
  const f = fixture();
  const children = [
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'spawn',
    'spawnSync',
    'fork',
  ].map((name) =>
    jest.spyOn(childProcess, name).mockImplementation(() => {
      throw new Error('Authority capture must not launch a child');
    })
  );
  const authority = capture(f);
  expect({
    checkout: authority.checkout,
    canonical: authority.canonical,
    ownedRoot: authority.ownedRoot,
    sid: authority.originalSessionId,
    surface: authority.surface,
    binding: authority.binding.kind,
    worktree: authority.binding.worktreeName,
    spec: authority.binding.spec.id,
  }).toEqual({
    checkout: f.lane,
    canonical: f.repo,
    ownedRoot: f.lane,
    sid: f.sid,
    surface: 'claude-code',
    binding: 'bound',
    worktree: 'owned',
    spec: f.spec.id,
  });
  expect(evaluatePath('src/allowed/a.ts', authority.binding, authority.policy).kind).toBe('admit');
  expect(evaluatePath('src/forbidden/a.ts', authority.binding, authority.policy).kind).toBe(
    'reject'
  );
  expect(evaluatePath('outside/a.ts', authority.binding, authority.policy).kind).toBe('reject');
  expect(authority.registry.owned.owner.session_id).toBe(f.sid);
  expect(authority.specs.map((entry) => entry.id)).toEqual([f.spec.id]);
  expect(authority.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(() => authority.assertCurrent(clone(f.context))).not.toThrow();
  for (const child of children) expect(child).not.toHaveBeenCalled();
});

test('recorded peer IDs remain opaque while only the exact original SID owns this checkout', () => {
  const f = fixture();
  addPeer(f);
  const authority = capture(f);
  expect(authority.registry.peer.owner.session_id).toBe('other/session:@é');
  const previous = process.env.CLAUDE_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = f.sid;
  try {
    refuses(f, { originalSessionId: 'different-original-session' });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = previous;
  }
});

test.each([
  '',
  'unknown',
  '.',
  '..',
  'has:colon',
  'has/slash',
  'has@at',
  'has space',
  ' leading',
  'trailing ',
  'é',
  'x\0y',
  'a'.repeat(129),
])('rejects lossy or unavailable original SID %j before authority file reads', (sid) => {
  const f = fixture();
  const open = jest.spyOn(fs, 'openSync');
  refuses(f, { originalSessionId: sid });
  expect(open).not.toHaveBeenCalled();
});

test.each([
  [
    'foreign owner',
    (f) => {
      f.registry.owned.owner.session_id = 'foreign';
    },
  ],
  [
    'missing owner',
    (f) => {
      delete f.registry.owned.owner;
    },
  ],
  [
    'unbound row',
    (f) => {
      delete f.registry.owned.specId;
      delete f.spec.worktree;
    },
  ],
  [
    'registry-only binding',
    (f) => {
      delete f.spec.worktree;
    },
  ],
  [
    'spec-only binding',
    (f) => {
      delete f.registry.owned.specId;
    },
  ],
  [
    'inactive spec',
    (f) => {
      f.spec.lifecycle_state = 'draft';
    },
  ],
  [
    'registered branch mismatch',
    (f) => {
      f.registry.owned.branch = 'caws/different';
    },
  ],
  [
    'missing registered path',
    (f) => {
      delete f.registry.owned.path;
    },
  ],
  [
    'ambiguous registered root',
    (f) => {
      f.registry.other = clone(f.registry.owned);
    },
  ],
  [
    'malformed peer owner',
    (f) => {
      addPeer(f);
      f.registry.peer.owner = { session_id: 42 };
    },
  ],
])('refuses %s even when the policy would admit the requested relative path', (_name, change) => {
  const f = fixture();
  expect(evaluatePath('src/allowed/a.ts', capture(f).binding, f.policy).kind).toBe('admit');
  change(f);
  f.persist();
  refuses(f);
});

test('an unresolved live row blocks this strict profile instead of disappearing from its census', () => {
  const f = fixture();
  const peer = addPeer(f);
  fs.rmSync(peer, { recursive: true });
  refuses(f);
});

test.each([
  [
    'branch differs from inventory',
    (f) => {
      f.context.branch = 'different';
    },
  ],
  [
    'checkout absent from inventory',
    (f) => {
      f.context.worktrees = f.context.worktrees.filter((entry) => entry.path !== f.lane);
    },
  ],
  [
    'duplicate native checkout',
    (f) => {
      f.context.worktrees.push(clone(f.context.worktrees[1]));
    },
  ],
  [
    'prunable checkout',
    (f) => {
      f.context.worktrees[1].prunable = true;
    },
  ],
  [
    'detached checkout',
    (f) => {
      f.context.branch = null;
      f.context.worktrees[1].branch = null;
      f.context.worktrees[1].detached = true;
    },
  ],
])('refuses native standing with %s', (_name, change) => {
  const f = fixture();
  change(f);
  refuses(f);
});

test('bare canonical standing is explicitly unsupported by this first profile', () => {
  const f = fixture();
  f.context.worktrees[0].bare = true;
  f.context.worktrees[0].branch = null;
  expect(() => capture(f)).toThrow(/bare canonical context is unsupported/);
});

test.each(['policy.yaml', 'worktrees.json', 'specs'])(
  'missing %s cannot become empty authority',
  (name) => {
    const f = fixture();
    fs.rmSync(path.join(f.caws, name), { recursive: true });
    refuses(f);
  }
);

test.each([
  ['malformed policy', (f) => put(path.join(f.caws, 'policy.yaml'), 'version: [')],
  ['malformed sibling spec', (f) => put(path.join(f.caws, 'specs/broken.yaml'), 'id: [')],
  ['duplicate logical spec', (f) => put(path.join(f.caws, 'specs/alias.yaml'), f.spec)],
  [
    'duplicate YAML selector',
    (f) => put(path.join(f.caws, 'specs/duplicate.yaml'), 'id: A\nid: B\n'),
  ],
  [
    'duplicate registry selector',
    (f) => {
      const row = JSON.stringify(f.registry.owned);
      put(path.join(f.caws, 'worktrees.json'), `{"owned":${row},"owned":${row}}`);
    },
  ],
  [
    'malformed bridge row',
    (f) => put(path.join(f.caws, 'claims/bridge.json'), { OTHER: { session_id: 42 } }),
  ],
])('rejects %s instead of selecting the surviving valid subset', (_name, change) => {
  const f = fixture();
  change(f);
  refuses(f);
});

test.each(['symlink', 'hardlink'])('refuses %s authority files', (kind) => {
  const f = fixture();
  const file = path.join(f.caws, 'policy.yaml');
  const saved = path.join(f.root, 'policy.saved');
  if (kind === 'symlink') {
    fs.renameSync(file, saved);
    fs.symlinkSync(saved, file);
  } else {
    fs.linkSync(file, saved);
  }
  refuses(f);
});

test('refuses a symlink canonical authority directory', () => {
  const f = fixture();
  const saved = path.join(f.repo, 'authority.saved');
  fs.renameSync(f.caws, saved);
  fs.symlinkSync(saved, f.caws);
  refuses(f);
});

test('rejects an oversized authority file before parsing it', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.caws, 'policy.yaml'), Buffer.alloc(1024 * 1024 + 1, 32));
  refuses(f);
});

test('a named policy replacement during an opened read never acquires standing', () => {
  const f = fixture();
  const policy = path.join(f.caws, 'policy.yaml');
  const bytes = fs.readFileSync(policy);
  const actualRead = fs.readSync;
  let replaced = false;
  jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
    const count = actualRead(...args);
    if (!replaced && count > 0) {
      replaced = true;
      const replacement = path.join(f.root, 'replacement');
      fs.writeFileSync(replacement, bytes);
      fs.renameSync(replacement, policy);
    }
    return count;
  });
  refuses(f);
  expect(replaced).toBe(true);
});

test.each([
  [
    'policy content',
    (f) => {
      f.policy.risk_tiers[1].max_files++;
      put(path.join(f.caws, 'policy.yaml'), f.policy);
    },
  ],
  [
    'policy mode',
    (f) => {
      const file = path.join(f.caws, 'policy.yaml');
      fs.chmodSync(file, (fs.statSync(file).mode & 0o777) ^ 0o100);
    },
  ],
  [
    'same-byte file replacement',
    (f) => {
      const file = path.join(f.caws, 'policy.yaml');
      const replacement = path.join(f.root, 'same-bytes');
      fs.writeFileSync(replacement, fs.readFileSync(file));
      fs.chmodSync(replacement, fs.statSync(file).mode & 0o777);
      fs.renameSync(replacement, file);
    },
  ],
  ['spec inventory', (f) => put(path.join(f.caws, 'specs/inspection-note'), 'new entry')],
  [
    'spec content',
    (f) => {
      f.spec.scope.in.push('src/additional/');
      put(path.join(f.caws, 'specs', f.spec.id + '.yaml'), f.spec);
    },
  ],
  [
    'owner',
    (f) => {
      f.registry.owned.owner.session_id = 'different-owner';
      f.persist();
    },
  ],
  ['bridge absence', (f) => put(path.join(f.caws, 'claims/bridge.json'), {})],
  [
    'checkout inode',
    (f) => {
      fs.renameSync(f.lane, path.join(f.root, 'previous-lane'));
      fs.mkdirSync(f.lane);
    },
  ],
  [
    'canonical authority inode',
    (f) => {
      const saved = path.join(f.repo, 'authority.previous');
      fs.renameSync(f.caws, saved);
      fs.cpSync(saved, f.caws, { recursive: true });
    },
  ],
])('post-effect %s drift refuses final egress authority', async (_name, change) => {
  const f = fixture();
  const authority = capture(f);
  await Promise.resolve().then(() => change(f));
  expect(() => authority.assertCurrent(clone(f.context))).toThrow(NativeFileAuthorityError);
});

test('fresh native branch or inventory changes cannot reuse the captured record', async () => {
  const f = fixture();
  const authority = capture(f);
  const changed = clone(f.context);
  await Promise.resolve().then(() => {
    changed.branch = 'caws/new';
    changed.worktrees[1].branch = 'refs/heads/caws/new';
  });
  expect(() => authority.assertCurrent(changed)).toThrow(/native context changed/);
});

test('operational journal and heartbeat children do not invalidate the .caws root pin', async () => {
  const f = fixture();
  const authority = capture(f);
  await Promise.resolve().then(() => {
    put(path.join(f.caws, 'sessions', f.sid, 'hook-invocations/event.json'), { observed: true });
    put(path.join(f.caws, 'leases', f.sid + '.json'), { last_seen: 'operational' });
  });
  expect(() => authority.assertCurrent(clone(f.context))).not.toThrow();
  expect(capture(f).revision).toBe(authority.revision);
});

test.each([
  [
    'new spec insertion',
    (f) => {
      const added = {
        ...clone(f.spec),
        id: 'LATE-NATIVE-001',
        lifecycle_state: 'draft',
      };
      delete added.worktree;
      put(path.join(f.caws, 'specs', added.id + '.yaml'), added);
    },
  ],
  [
    'canonical authority symlink replacement',
    (f) => {
      const retained = path.join(f.repo, 'authority-retained');
      fs.renameSync(f.caws, retained);
      fs.symlinkSync(retained, f.caws);
    },
  ],
])('%s during final file verification cannot escape the namespace check', (_name, mutate) => {
  const f = fixture();
  const authority = capture(f);
  const watched = path.join(f.caws, 'specs', f.spec.id + '.yaml');
  const descriptors = new Set();
  const actualOpen = fs.openSync;
  const actualClose = fs.closeSync;
  let completedSpecReads = 0;
  let injected = false;

  jest.spyOn(fs, 'openSync').mockImplementation((...args) => {
    const descriptor = actualOpen(...args);
    if (args[0] === watched) descriptors.add(descriptor);
    return descriptor;
  });
  jest.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
    const watchedRead = descriptors.delete(descriptor);
    const result = actualClose(descriptor);
    if (watchedRead && ++completedSpecReads === 2) {
      // assertCurrent captures once: the first read collects this sole spec;
      // the second verifies it as the final consumed file in ReadSet.finish.
      // Mutate actual filesystem state after its stable descriptor read,
      // before finish can return the captured revision.
      injected = true;
      mutate(f);
    }
    return result;
  });

  expect(() => authority.assertCurrent(clone(f.context))).toThrow(NativeFileAuthorityError);
  expect(injected).toBe(true);
});

test('only one existing active original-session bridge can establish canonical standing', () => {
  const f = fixture();
  delete f.spec.worktree;
  delete f.registry.owned;
  f.context.checkout = f.repo;
  f.context.gitDir = f.context.commonDir;
  f.context.branch = 'main';
  f.persist();
  refuses(f);
  put(path.join(f.caws, 'claims/bridge.json'), {
    [f.spec.id]: {
      session_id: f.sid,
      platform: 'claude-code',
      acquired_at: '2026-11-07T00:00:00Z',
    },
  });
  const authority = capture(f);
  expect(authority.binding.kind).toBe('bridged');
  expect(authority.ownedRoot).toBe(f.repo);
  expect(authority.binding.session_id).toBe(f.sid);
  const other = { ...clone(f.spec), id: 'OTHER-ACTIVE-001' };
  put(path.join(f.caws, 'specs', other.id + '.yaml'), other);
  put(path.join(f.caws, 'claims/bridge.json'), {
    [f.spec.id]: { session_id: f.sid, acquired_at: '2026-11-07T00:00:00Z' },
    [other.id]: { session_id: f.sid, acquired_at: '2026-11-07T00:00:00Z' },
  });
  refuses(f);
});

test('the caller checkpoint is required and expiration precedes any authority read', () => {
  const f = fixture();
  const open = jest.spyOn(fs, 'openSync');
  refuses(f, { checkpoint: undefined });
  expect(() =>
    capture(f, {
      checkpoint: () => {
        throw new Error('expired');
      },
    })
  ).toThrow(/checkpoint failed/);
  expect(open).not.toHaveBeenCalled();
});

test('expiration during a real file read prevents further authority opens', () => {
  const f = fixture();
  const actualRead = fs.readSync;
  const actualOpen = fs.openSync;
  let expired = false;
  const openedAfterExpiration = [];
  f.checkpoint = () => {
    if (expired) throw new Error('original deadline expired');
  };
  jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
    const count = actualRead(...args);
    if (count > 0) expired = true;
    return count;
  });
  jest.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (expired) openedAfterExpiration.push(args[0]);
    return actualOpen(...args);
  });
  expect(() => capture(f)).toThrow(/checkpoint failed/);
  expect(expired).toBe(true);
  expect(openedAfterExpiration).toEqual([]);
});

test('final synchronous validation checks the same original budget before reading', async () => {
  const f = fixture();
  let expired = false;
  f.checkpoint = () => {
    if (expired) throw new Error('original deadline expired');
  };
  const authority = capture(f);
  await Promise.resolve().then(() => {
    expired = true;
  });
  const open = jest.spyOn(fs, 'openSync');
  expect(() => authority.assertCurrent(clone(f.context))).toThrow(/checkpoint failed/);
  expect(open).not.toHaveBeenCalled();
});
