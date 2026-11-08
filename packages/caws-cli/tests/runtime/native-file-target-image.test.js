'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { evaluatePath } = require('../../dist/kernel');
const { readNativeFileAuthority } = require('../../dist/runtime/file-tools/authority');
const {
  captureNativeFileTargetImage,
  NativeFileTargetError,
  MAX_NATIVE_FILE_IMAGE_BYTES: MAX,
} = require('../../dist/runtime/file-tools/target-image');

const roots = [];
const clone = (value) => JSON.parse(JSON.stringify(value));
const mode = (file) => fs.statSync(file).mode & 0o7777;

function put(file, value, permissions = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  );
  fs.chmodSync(file, permissions);
}
function fixture({
  bridge = false,
  managed = false,
  ancestors = [],
  scope = ['src/allowed'],
  out = [],
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-target-')));
  roots.push(root);
  const container = path.join(root, ...ancestors);
  const repo = path.join(container, 'project');
  const lane = bridge
    ? repo
    : managed
      ? path.join(repo, '.caws/worktrees/owned')
      : path.join(container, 'owned');
  const home = path.join(root, 'home');
  const machineHome = path.join(home, '.caws');
  for (const dir of [repo, lane, home, machineHome, path.join(lane, 'src/allowed')])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const commonDir = path.join(repo, '.git');
  const gitDir = bridge ? commonDir : path.join(commonDir, 'worktrees/owned');
  fs.mkdirSync(gitDir, { recursive: true, mode: 0o700 });
  const sid = 'target-original_01';
  const spec = {
    id: 'NATIVE-TARGET-001',
    title: 'Native target image fixture',
    mode: 'chore',
    lifecycle_state: 'active',
    ...(bridge ? {} : { worktree: 'owned' }),
    blast_radius: { modules: ['fixture'] },
    scope: { in: scope, out },
    invariants: ['Only admitted original target images may proceed'],
    acceptance: [{ id: 'A1', given: 'standing', when: 'file proposal', then: 'checked' }],
    non_functional: {},
    contracts: [],
  };
  const registry = bridge
    ? {}
    : {
        owned: {
          path: lane,
          branch: 'caws/owned',
          baseBranch: 'main',
          specId: spec.id,
          owner: { session_id: sid, platform: 'claude-code' },
        },
      };
  const bridges = bridge
    ? {
        [spec.id]: { session_id: sid, acquired_at: '2026-11-08T00:00:00Z' },
      }
    : {};
  const context = {
    checkout: lane,
    canonical: repo,
    gitDir,
    commonDir,
    branch: bridge ? 'main' : 'caws/owned',
    mergeInProgress: false,
    worktrees: [
      { path: repo, branch: 'refs/heads/main', detached: false, prunable: false, bare: false },
      ...(bridge
        ? []
        : [
            {
              path: lane,
              branch: 'refs/heads/caws/owned',
              detached: false,
              prunable: false,
              bare: false,
            },
          ]),
    ],
  };
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
  const extraSpecs = [];
  const f = {
    root,
    repo,
    lane,
    home,
    machineHome,
    sid,
    spec,
    registry,
    bridges,
    context,
    policy,
    extraSpecs,
    sessionCwd: lane,
    checkpoint: () => {},
    persist() {
      const caws = path.join(repo, '.caws');
      put(path.join(caws, 'policy.yaml'), policy);
      put(path.join(caws, 'worktrees.json'), registry);
      put(path.join(caws, 'specs', spec.id + '.yaml'), spec);
      for (const other of extraSpecs) put(path.join(caws, 'specs', other.id + '.yaml'), other);
      put(path.join(caws, 'claims/bridge.json'), bridges);
    },
    authority() {
      return readNativeFileAuthority({
        context: clone(context),
        originalSessionId: sid,
        surface: 'claude-code',
        checkpoint: f.checkpoint,
      });
    },
    payload(toolInput, tool = 'Write', includeCwd = true) {
      return {
        session_id: sid,
        ...(includeCwd ? { cwd: f.sessionCwd } : {}),
        tool_name: tool,
        tool_input: toolInput,
      };
    },
    args(payload, changes = {}) {
      return {
        payload,
        authority: f.authority(),
        sessionCwd: f.sessionCwd,
        home,
        machineHome,
        checkpoint: f.checkpoint,
        ...changes,
      };
    },
    capture(payload, changes = {}) {
      return captureNativeFileTargetImage(f.args(payload, changes));
    },
    peer({ nested = false, sameOwner = false, claim = ['src/shared'], support = [] } = {}) {
      const peer = path.join(nested ? repo : root, 'peer');
      fs.mkdirSync(peer, { recursive: true, mode: 0o700 });
      const other = {
        ...clone(spec),
        id: 'NATIVE-TARGET-PEER-001',
        worktree: 'peer',
        scope: { in: claim, out: [], support },
      };
      registry.peer = {
        path: peer,
        branch: 'caws/peer',
        specId: other.id,
        owner: { session_id: sameOwner ? sid : 'foreign-session' },
      };
      extraSpecs.push(other);
      context.worktrees.push({
        path: peer,
        branch: 'refs/heads/caws/peer',
        detached: false,
        prunable: false,
        bare: false,
      });
      f.persist();
      return peer;
    },
  };
  f.persist();
  return f;
}

function errorFrom(operation, reason, guard = 'native-file-target') {
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeFileTargetError);
  expect({ guard: caught.guard, reason: caught.reason }).toEqual({ guard, reason });
}
function write(f, file_path, content = 'next') {
  return f.payload({ file_path, content });
}
function edit(f, file_path, old_string, new_string, replace_all) {
  return f.payload(
    {
      file_path,
      old_string,
      new_string,
      ...(replace_all === undefined ? {} : { replace_all }),
    },
    'Edit'
  );
}
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('captures creation and replacement without changing bytes or modes', () => {
  const f = fixture();
  const target = path.join(f.lane, 'src/allowed/file.ts');
  const creation = f.capture(write(f, target, 'created é'));
  expect(creation).toMatchObject({
    kind: 'admitted',
    originalTool: 'Write',
    target,
    relativePath: 'src/allowed/file.ts',
    preimage: null,
    proposedContent: 'created é',
    originalSessionId: f.sid,
  });
  expect(fs.existsSync(target)).toBe(false);
  put(target, 'before', 0o640);
  const replacement = f.capture(write(f, target, 'after'));
  expect(replacement).toMatchObject({
    kind: 'admitted',
    preimage: 'before',
    proposedContent: 'after',
  });
  replacement.assertCurrent();
  expect(fs.readFileSync(target, 'utf8')).toBe('before');
  expect(mode(target)).toBe(0o640);
});

test('managed worktree payload remains distinct from canonical and lane governance', () => {
  const f = fixture({ managed: true });
  const target = path.join(f.lane, 'src/allowed/file.ts');
  expect(f.capture(write(f, target))).toMatchObject({
    kind: 'admitted',
    target,
    proposedContent: 'next',
  });
  expect(fs.existsSync(target)).toBe(false);
  const governance = path.join(f.repo, '.caws/worktrees.json');
  const before = fs.readFileSync(governance);
  errorFrom(() => f.capture(write(f, governance)), 'authority_state', 'protected-paths.sh');
  errorFrom(
    () => f.capture(write(f, path.join(f.lane, '.caws/policy.yaml'))),
    'authority_state',
    'protected-paths.sh'
  );
  expect(fs.readFileSync(governance)).toEqual(before);
});

test.each([
  { ancestors: ['.caws', 'state', 'qualification'] },
  { ancestors: ['.codex', 'worktrees', 'app-lane'] },
])('project beneath $ancestors uses its actual repository domain', ({ ancestors }) => {
  const f = fixture({ ancestors });
  const target = path.join(f.lane, 'src/allowed/file.ts');
  expect(f.capture(write(f, target))).toMatchObject({ kind: 'admitted', target });
  expect(fs.existsSync(target)).toBe(false);
});

test('managed foreign payload reaches ownership refusal without borrowing its domain', () => {
  const f = fixture({ managed: true, scope: ['**'] });
  const prior = f.peer({ nested: true });
  const peer = path.join(f.repo, '.caws/worktrees/peer');
  fs.renameSync(prior, peer);
  f.registry.peer.path = peer;
  f.context.worktrees.find((row) => row.path === prior).path = peer;
  f.persist();
  const target = path.join(peer, 'file.ts');
  errorFrom(() => f.capture(write(f, target)), 'foreign_worktree', 'worktree-write-guard.sh');
  expect(fs.existsSync(target)).toBe(false);
});

test.each(['destroyed', 'missing'])(
  'a %s registry row cannot reclassify canonical governance as payload',
  (status) => {
    const f = fixture({ bridge: true, scope: ['**'] });
    f.registry.retired = {
      path: path.join(f.repo, '.caws'),
      branch: 'caws/retired',
      baseBranch: 'main',
      specId: 'RETIRED-TARGET-001',
      status,
      owner: { session_id: 'former-owner' },
    };
    f.persist();
    const target = path.join(f.repo, '.caws/policy.yaml');
    const before = fs.readFileSync(target);
    errorFrom(() => f.capture(write(f, target)), 'authority_state', 'protected-paths.sh');
    expect(fs.readFileSync(target)).toEqual(before);
  }
);

test.each([true, false])(
  'resolves relative input from authenticated physical subdirectory; payload cwd present=%s',
  (includeCwd) => {
    const f = fixture();
    f.sessionCwd = path.join(f.lane, 'src/allowed');
    const payload = f.payload(
      { file_path: 'file.ts', content: 'subdirectory' },
      'Write',
      includeCwd
    );
    const image = f.capture(payload);
    expect(image).toMatchObject({
      kind: 'admitted',
      target: path.join(f.sessionCwd, 'file.ts'),
      relativePath: 'src/allowed/file.ts',
      proposedContent: 'subdirectory',
    });
    expect(fs.existsSync(image.target)).toBe(false);
  }
);

test('rejects foreign or mismatched session directories and original identities', () => {
  const f = fixture();
  const payload = write(f, 'src/allowed/a');
  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  errorFrom(
    () => f.capture({ ...payload, cwd: other }),
    'session_cwd_mismatch',
    'native-file-input'
  );
  errorFrom(
    () => f.capture({ ...payload, cwd: other }, { sessionCwd: other }),
    'session_cwd_outside',
    'worktree-write-guard.sh'
  );
  errorFrom(
    () => f.capture({ ...payload, session_id: 'foreign' }),
    'original_session_mismatch',
    'native-file-input'
  );
  errorFrom(
    () => f.capture(payload, { sessionCwd: undefined }),
    'invalid_text',
    'native-file-input'
  );
});

test.each([
  ['one old end', 'old', 'new', undefined, 'one new end'],
  ['old + old', 'old', 'new', true, 'new + new'],
  ['aaaa', 'aa', 'b', true, 'bb'],
  ['aaa', 'aa', 'b', true, 'ba'],
  ['old', 'old', '$&', false, '$&'],
  ['\uFEFFhéllo 世界', 'héllo', 'salut', false, '\uFEFFsalut 世界'],
  ['delete', 'delete', '', undefined, ''],
])('builds literal Edit postimage %j', (before, old, next, all, expected) => {
  const f = fixture();
  const target = path.join(f.lane, 'src/allowed/file');
  put(target, before);
  const image = f.capture(edit(f, target, old, next, all));
  expect(image).toMatchObject({
    kind: 'admitted',
    originalTool: 'Edit',
    preimage: before,
    proposedContent: expected,
  });
  image.assertCurrent();
  expect(fs.readFileSync(target, 'utf8')).toBe(before);
  expect(mode(target)).toBe(0o600);
});

test.each([
  ['old old', 'old', 'edit_ambiguous'],
  ['aaa', 'aa', 'edit_overlap'],
  ['before', 'absent', 'edit_missing_match'],
  ['before', '', 'edit_empty_old'],
])('refuses ambiguous or absent Edit preimage %j', (before, old, reason) => {
  const f = fixture();
  const target = path.join(f.lane, 'src/allowed/file');
  put(target, before);
  errorFrom(() => f.capture(edit(f, target, old, 'new')), reason, 'native-file-input');
  expect(fs.readFileSync(target, 'utf8')).toBe(before);
  expect(mode(target)).toBe(0o600);
});

test('Edit requires an existing file and enforces postimage byte bound', () => {
  const f = fixture();
  const target = path.join(f.lane, 'src/allowed/file');
  errorFrom(
    () => f.capture(edit(f, target, 'old', 'new')),
    'edit_missing_file',
    'native-file-input'
  );
  put(target, 'aa');
  errorFrom(
    () => f.capture(edit(f, target, 'a', 'x'.repeat(MAX / 2 + 1), true)),
    'postimage_too_large',
    'native-file-input'
  );
  expect(fs.readFileSync(target, 'utf8')).toBe('aa');
});

test.each([
  [{ file_path: 'src/allowed/a', content: 'x', cwd: '/foreign' }, 'invalid_tool_input'],
  [{ file_path: 'src/allowed/a', content: '\0' }, 'nul_input'],
  [{ file_path: 'src/allowed/a', content: '\uD800' }, 'invalid_utf8'],
  [{ file_path: 'src/allowed/a', content: 'é'.repeat(MAX / 2 + 1) }, 'input_too_large'],
  [{ file_path: './src/allowed/a', content: 'x' }, 'invalid_file_path'],
  [{ file_path: 'src/../allowed/a', content: 'x' }, 'invalid_file_path'],
  [{ file_path: 'src//allowed/a', content: 'x' }, 'invalid_file_path'],
  [{ file_path: 'src\\allowed\\a', content: 'x' }, 'invalid_file_path'],
])('refuses malformed recognized Write input', (input, reason) => {
  const f = fixture();
  errorFrom(() => f.capture(f.payload(input)), reason, 'native-file-input');
  expect(fs.readdirSync(path.join(f.lane, 'src/allowed'))).toEqual([]);
});

test('scope miss is a denial record and does not create strike state', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.lane, 'src/outside'), { recursive: true, mode: 0o700 });
  const result = f.capture(write(f, 'src/outside/a'));
  expect(result).toMatchObject({
    kind: 'scope-miss',
    guard: 'scope-guard.sh',
    reason: 'scope_in_miss',
    rule: 'scope.reject.scope_in_miss',
    originalSessionId: f.sid,
    relativePath: 'src/outside/a',
  });
  result.assertCurrent();
  expect(fs.existsSync(path.join(f.lane, 'src/outside/a'))).toBe(false);
  expect(fs.existsSync(path.join(f.machineHome, 'state'))).toBe(false);
});

test('explicit scope.out shadows non-governed zones and infrastructure admission', () => {
  const f = fixture({ scope: ['**'], out: ['src/forbidden', '.claude/hooks/README.md'] });
  f.policy.non_governed_zones = ['src/**'];
  f.persist();
  fs.mkdirSync(path.join(f.lane, 'src/forbidden'), { recursive: true, mode: 0o700 });
  errorFrom(() => f.capture(write(f, 'src/forbidden/a')), 'scope_out', 'scope-guard.sh');
  errorFrom(() => f.capture(write(f, '.claude/hooks/README.md')), 'scope_out', 'scope-guard.sh');
});

test.each([
  ['.git/config', 'git_metadata'],
  ['.caws/policy.yaml', 'authority_state'],
  ['.caws/specs/A.yaml', 'authority_state'],
  ['.caws/worktrees.json', 'authority_state'],
  ['.caws/claims/bridge.json', 'authority_state'],
  ['.caws/events.jsonl', 'authority_state'],
  ['.caws/state.lock', 'authority_state'],
  ['.caws/hooks/guard.sh', 'hook_artifact'],
  ['.claude/settings.json', 'native_registration'],
  ['.claude/settings.local.json', 'native_registration'],
  ['.codex/hooks.json', 'native_registration'],
  ['.qwen/settings.json', 'native_registration'],
  ['.zcode/config.json', 'native_registration'],
  ['.kimi-code/config.toml', 'native_registration'],
  ['.codex/hooks/state/danger-latch-original.json', 'guard_state'],
  ['.dsh/logs/guard-strikes-original.json', 'guard_state'],
])('protected classifier wins for %s despite otherwise admitted scope', (file, reason) => {
  const f = fixture({ scope: ['**'] });
  const authority = f.authority();
  expect(evaluatePath(file, authority.binding, authority.policy).kind).toBe('admit');
  errorFrom(
    () => captureNativeFileTargetImage(f.args(write(f, file), { authority })),
    reason,
    'protected-paths.sh'
  );
});

test('external canonical and machine controls retain protected reasons before outside-root refusal', () => {
  const f = fixture({ scope: ['**'] });
  for (const [target, reason] of [
    [path.join(f.repo, '.caws/worktrees.json'), 'authority_state'],
    [path.join(f.machineHome, 'lib/README.md'), 'machine_runtime'],
    [path.join(f.machineHome, 'state/projects/registration.json'), 'machine_runtime'],
    [path.join(f.machineHome, 'state/sessions/x/guard-reprieve-x.json'), 'machine_runtime'],
  ]) {
    expect(target.startsWith(f.lane + '/')).toBe(false);
    errorFrom(() => f.capture(write(f, target)), reason, 'protected-paths.sh');
  }
});

test('hook documentation remains subject to ownership and scope', () => {
  const f = fixture({ scope: ['**'] });
  for (const vendor of [
    '.caws',
    '.claude',
    '.codex',
    '.opencode',
    '.zcode',
    '.kimi-code',
    '.qwen',
    '.dsh',
    '.cursor',
    '.windsurf',
  ]) {
    const target = path.join(f.lane, vendor, 'hooks/README.md');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    expect(f.capture(write(f, target))).toMatchObject({
      kind: 'admitted',
      preimage: null,
      proposedContent: 'next',
    });
    expect(fs.existsSync(target)).toBe(false);
  }
  errorFrom(
    () => f.capture(write(f, path.join(f.repo, '.claude/hooks/README.md'))),
    'outside_owned_root',
    'worktree-write-guard.sh'
  );
});

test('another registered worktree is forbidden even for the same session', () => {
  const f = fixture({ bridge: true, scope: ['**'] });
  const peer = f.peer({ nested: true, sameOwner: true, claim: ['elsewhere'] });
  errorFrom(
    () => f.capture(write(f, path.join(peer, 'a'))),
    'foreign_worktree',
    'worktree-write-guard.sh'
  );
  expect(fs.existsSync(path.join(peer, 'a'))).toBe(false);
});

test('canonical foreign worktree and bridge scope.in claims refuse, while support is not a claim', () => {
  const f = fixture({ bridge: true, scope: ['**'] });
  fs.mkdirSync(path.join(f.repo, 'src/shared'), { recursive: true, mode: 0o700 });
  f.peer({ claim: ['src/shared'] });
  errorFrom(() => f.capture(write(f, 'src/shared/a')), 'foreign_claim', 'worktree-write-guard.sh');
  f.extraSpecs[0].scope = { in: ['elsewhere'], out: [], support: ['src/shared'] };
  f.persist();
  expect(f.capture(write(f, 'src/shared/a')).kind).toBe('admitted');

  const bridgeSpec = {
    ...clone(f.spec),
    id: 'NATIVE-TARGET-BRIDGE-001',
    scope: { in: ['src/shared'], out: [] },
  };
  delete bridgeSpec.worktree;
  f.extraSpecs.push(bridgeSpec);
  f.bridges[bridgeSpec.id] = {
    session_id: 'foreign-bridge',
    acquired_at: '2026-11-08T00:00:00Z',
  };
  f.persist();
  errorFrom(() => f.capture(write(f, 'src/shared/a')), 'foreign_claim', 'worktree-write-guard.sh');
});

test('an unresolved active canonical claimant cannot be ignored', () => {
  const f = fixture({ bridge: true, scope: ['**'] });
  const peer = f.peer({ claim: ['elsewhere'] });
  const args = f.args(write(f, 'src/allowed/a'));
  fs.rmdirSync(peer);
  errorFrom(
    () => captureNativeFileTargetImage(args),
    'foreign_claim_unresolved',
    'worktree-write-guard.sh'
  );
});

test.each(['directory', 'file'])('refuses unregistered nested .git %s boundaries', (kind) => {
  const f = fixture();
  const directory = path.join(f.lane, 'src/allowed/nested');
  fs.mkdirSync(directory, { mode: 0o700 });
  if (kind === 'directory') fs.mkdirSync(path.join(directory, '.git'));
  else put(path.join(directory, '.git'), 'gitdir: /unregistered\n');
  errorFrom(
    () => f.capture(write(f, path.join(directory, 'a'))),
    'nested_repository',
    'worktree-write-guard.sh'
  );
  expect(fs.existsSync(path.join(directory, 'a'))).toBe(false);
});

test('rejects missing, redirected and unsafe parents without creating directories', () => {
  const f = fixture();
  errorFrom(() => f.capture(write(f, 'src/allowed/missing/a')), 'parent_missing');
  expect(fs.existsSync(path.join(f.lane, 'src/allowed/missing'))).toBe(false);
  const real = path.join(f.lane, 'src/allowed/real');
  const link = path.join(f.lane, 'src/allowed/link');
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, link, 'dir');
  errorFrom(() => f.capture(write(f, path.join(link, 'a'))), 'aliased_parent');
  fs.chmodSync(real, 0o777);
  errorFrom(() => f.capture(write(f, path.join(real, 'a'))), 'unsafe_parent');
});

test('rejects symlink, hard-link, nonregular and read-only targets', () => {
  const f = fixture();
  const dir = path.join(f.lane, 'src/allowed');
  const real = path.join(dir, 'real');
  put(real, 'before');
  const link = path.join(dir, 'link');
  fs.symlinkSync(real, link);
  errorFrom(() => f.capture(write(f, link)), 'symlink');
  const hard = path.join(dir, 'hard');
  fs.linkSync(real, hard);
  errorFrom(() => f.capture(write(f, real)), 'hardlink');
  fs.unlinkSync(hard);
  const directory = path.join(dir, 'directory');
  fs.mkdirSync(directory);
  errorFrom(() => f.capture(write(f, directory)), 'nonregular_file');
  fs.chmodSync(real, 0o400);
  errorFrom(() => f.capture(write(f, real)), 'permission_denied');
  expect(fs.readFileSync(real, 'utf8')).toBe('before');
  expect(mode(real)).toBe(0o400);
});

test('rejects case aliases, invalid UTF-8, NUL preimages and oversized files', () => {
  const f = fixture();
  const dir = path.join(f.lane, 'src/allowed');
  const named = path.join(dir, 'Named');
  put(named, 'before');
  errorFrom(() => f.capture(write(f, path.join(dir, 'named'))), 'ambiguous_case');
  const binary = path.join(dir, 'binary');
  put(binary, Buffer.from([0xff]));
  errorFrom(() => f.capture(write(f, binary)), 'invalid_preimage_utf8');
  put(binary, Buffer.from([0]));
  errorFrom(() => f.capture(write(f, binary)), 'invalid_preimage_utf8');
  fs.truncateSync(binary, MAX + 1);
  errorFrom(() => f.capture(write(f, binary)), 'preimage_too_large');
  expect(fs.statSync(binary).size).toBe(MAX + 1);
  expect(fs.readFileSync(named, 'utf8')).toBe('before');
});

test.each(['content', 'replacement', 'mode', 'appeared'])(
  'final revalidation detects target %s changes',
  (change) => {
    const f = fixture();
    const target = path.join(f.lane, 'src/allowed/file');
    if (change !== 'appeared') put(target, 'before');
    const image = f.capture(write(f, target, 'proposal'));
    if (change === 'replacement') {
      fs.renameSync(target, target + '.previous');
      put(target, 'before');
    } else if (change === 'mode') fs.chmodSync(target, 0o640);
    else put(target, 'changed');
    errorFrom(() => image.assertCurrent(), 'target_changed');
    expect(fs.readFileSync(target, 'utf8')).toBe(
      change === 'replacement' || change === 'mode' ? 'before' : 'changed'
    );
    expect(mode(target)).toBe(change === 'mode' ? 0o640 : 0o600);
  }
);

test('final revalidation detects parent replacement and permission changes', () => {
  const f = fixture();
  const parent = path.join(f.lane, 'src/allowed');
  const image = f.capture(write(f, path.join(parent, 'new')));
  fs.renameSync(parent, parent + '-previous');
  fs.mkdirSync(parent, { mode: 0o700 });
  errorFrom(() => image.assertCurrent(), 'parent_changed');
  const next = f.capture(write(f, path.join(parent, 'new')));
  fs.chmodSync(parent, 0o777);
  errorFrom(() => next.assertCurrent(), 'unsafe_parent');
  expect(fs.existsSync(path.join(parent, 'new'))).toBe(false);
});

test('late nested Git boundary and original input mutation cannot pass revalidation', () => {
  const f = fixture();
  const dir = path.join(f.lane, 'src/allowed');
  const first = f.capture(write(f, path.join(dir, 'new')));
  put(path.join(dir, '.git'), 'gitdir: /later\n');
  errorFrom(() => first.assertCurrent(), 'nested_repository', 'worktree-write-guard.sh');
  fs.unlinkSync(path.join(dir, '.git'));
  const payload = write(f, path.join(dir, 'new'));
  const second = f.capture(payload);
  payload.tool_input.content = 'substituted';
  errorFrom(() => second.assertCurrent(), 'input_changed', 'native-file-input');
  expect(fs.existsSync(path.join(dir, 'new'))).toBe(false);
});

test('preserves the original checkpoint failure and closes an opened target descriptor', () => {
  const f = fixture();
  const target = path.join(f.lane, 'src/allowed/file');
  put(target, 'before');
  const args = f.args(write(f, target));
  const original = fs.openSync;
  const close = jest.spyOn(fs, 'closeSync');
  let targetFd;
  let expired = false;
  const failure = new Error('original deadline expired');
  args.checkpoint = () => {
    if (expired) throw failure;
  };
  jest.spyOn(fs, 'openSync').mockImplementation((file, ...rest) => {
    const fd = original(file, ...rest);
    if (file === target) {
      targetFd = fd;
      close.mockClear();
      expired = true;
    }
    return fd;
  });
  expect(() => captureNativeFileTargetImage(args)).toThrow(failure);
  // The open wrapper throws at its post-operation checkpoint, before the caller
  // receives the descriptor. This exposes the resource-ownership defect if present.
  expect(targetFd).toBeDefined();
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith(targetFd);
  expect(() => fs.fstatSync(targetFd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
});

test('capture and revalidation never launch children or perform proposed writes', () => {
  const f = fixture();
  const target = path.join(f.lane, 'src/allowed/file');
  put(target, 'before', 0o640);
  const args = f.args(write(f, target, 'after'));
  const writes = [
    'writeFileSync',
    'appendFileSync',
    'writeSync',
    'copyFileSync',
    'renameSync',
    'unlinkSync',
    'truncateSync',
    'chmodSync',
    'mkdirSync',
    'rmdirSync',
    'rmSync',
    'linkSync',
    'symlinkSync',
    'utimesSync',
  ].map((name) =>
    jest.spyOn(fs, name).mockImplementation(() => {
      throw new Error('target image must not mutate the filesystem');
    })
  );
  const open = fs.openSync;
  jest.spyOn(fs, 'openSync').mockImplementation((file, flags, ...rest) => {
    const writing =
      typeof flags === 'number'
        ? (flags &
            (fs.constants.O_WRONLY |
              fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_TRUNC |
              fs.constants.O_APPEND)) !==
          0
        : !['r', 'rs'].includes(flags);
    if (writing) throw new Error('target image must not open writable descriptors');
    return open(file, flags, ...rest);
  });
  const spies = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].map(
    (name) =>
      jest.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error('target image must not launch children');
      })
  );
  const image = captureNativeFileTargetImage(args);
  image.assertCurrent();
  expect(image).toMatchObject({ preimage: 'before', proposedContent: 'after' });
  expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  expect(writes.map((spy) => spy.mock.calls.length)).toEqual(writes.map(() => 0));
  expect(fs.readFileSync(target, 'utf8')).toBe('before');
  expect(mode(target)).toBe(0o640);
});
