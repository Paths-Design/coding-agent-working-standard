const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  captureGitHookTransaction,
  validateGitHookTransaction,
  publishGitHookTransaction,
  GitHookTransactionError,
} = require('../../dist/execution/git-hook-transaction');

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture({ format = 'sha1', ...extra } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hook-transaction-')));
  roots.push(root);
  const project = path.join(root, 'project');
  const invocation = path.join(root, 'native');
  const quarantine = path.join(root, 'private');
  for (const dir of [project, invocation, quarantine]) fs.mkdirSync(dir);
  const baseEnv = { PATH: process.env.PATH, HOME: root, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (argv, env = {}, input) =>
    execFileSync('git', argv, {
      cwd: project,
      env: { ...baseEnv, ...env },
      input,
      maxBuffer: 40 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  run(['init', '-q', `--object-format=${format}`]);
  run(['config', 'core.autocrlf', 'false']);
  for (const name of ['selected.txt', 'foreign.txt'])
    fs.writeFileSync(path.join(project, name), `${name} baseline\n`);
  run(['add', '--', 'selected.txt', 'foreign.txt']);
  const writes = [];
  let intercept;
  let authority = true;
  const options = {
    projectRoot: project,
    invocationRoot: invocation,
    authorizedPaths: ['selected.txt'],
    git: (request) => {
      if (request.argv.includes('-w')) writes.push(request.argv);
      if (intercept) intercept(request);
      return run(request.argv, request.env, request.input);
    },
    assertCanonicalAuthority: () => {
      if (!authority) throw new Error('Native authority lost');
    },
    ...extra,
  };
  const start = (overrides = {}) => {
    const transaction = captureGitHookTransaction({ ...options, ...overrides });
    const privateIndex = path.join(quarantine, 'index');
    const objects = path.join(quarantine, 'objects');
    if (!fs.existsSync(objects)) fs.mkdirSync(objects);
    fs.writeFileSync(privateIndex, transaction.seedIndex());
    const env = {
      GIT_INDEX_FILE: privateIndex,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: transaction.objectDirectory,
    };
    return { transaction, privateIndex, env, stage: (...argv) => run(argv, env) };
  };
  return {
    root,
    project,
    invocation,
    run,
    start,
    writes,
    options,
    setIntercept: (fn) => {
      intercept = fn;
    },
    loseAuthority: () => {
      authority = false;
    },
    write: (name, text) => fs.writeFileSync(path.join(project, name), text),
  };
}
function expectedError(fn, message, disposition = 'not-published') {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GitHookTransactionError);
  expect(caught.message).toMatch(message);
  expect(caught.disposition).toBe(disposition);
}
function rewriteIndex(filename, mutate) {
  const old = fs.readFileSync(filename);
  const body = mutate(Buffer.from(old.subarray(0, -20)));
  fs.writeFileSync(filename, Buffer.concat([body, createHash('sha1').update(body).digest()]));
}

test('Source-derived formatter staging publishes exact snapshot and preserves foreign semantic flags', () => {
  const f = fixture();
  f.run(['update-index', '--assume-unchanged', 'foreign.txt']);
  const beforeForeign = f.run(['ls-files', '-v', '--', 'foreign.txt']).toString();
  const p = f.start();
  f.write('selected.txt', 'formatted Source\n');
  p.stage('add', '--', 'selected.txt');
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  const bytes = fs.readFileSync(candidate.snapshotPath);
  expect(publishGitHookTransaction(candidate)).toEqual({
    disposition: 'index-published',
    snapshotHash: candidate.snapshotHash,
  });
  expect(fs.readFileSync(p.transaction.indexPath)).toEqual(bytes);
  expect(f.run(['show', ':selected.txt']).toString()).toBe('formatted Source\n');
  expect(f.run(['ls-files', '-v', '--', 'foreign.txt']).toString()).toBe(beforeForeign);
  expect(fs.existsSync(`${p.transaction.indexPath}.lock`)).toBe(false);
  expect(f.writes).toHaveLength(1);
});

test('skip-worktree foreign flags survive selected settlement', () => {
  const f = fixture();
  f.run(['update-index', '--skip-worktree', 'foreign.txt']);
  const p = f.start();
  f.write('selected.txt', 'new\n');
  p.stage('add', 'selected.txt');
  publishGitHookTransaction(validateGitHookTransaction(p.transaction, p.privateIndex));
  expect(f.run(['ls-files', '-v', '--', 'foreign.txt']).toString()).toBe('S foreign.txt\n');
});

test('mutable private staging after validation cannot alter published bytes or objects', () => {
  const f = fixture();
  const p = f.start();
  f.write('selected.txt', 'settled\n');
  p.stage('add', 'selected.txt');
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  const expected = fs.readFileSync(candidate.snapshotPath);
  const hostile = p.stage('hash-object', '-w', '--stdin').toString().trim();
  p.stage('update-index', '--cacheinfo', `100644,${hostile},selected.txt`);
  fs.rmSync(p.env.GIT_OBJECT_DIRECTORY, { recursive: true, force: true });
  publishGitHookTransaction(candidate);
  expect(fs.readFileSync(p.transaction.indexPath)).toEqual(expected);
  expect(f.run(['show', ':selected.txt']).toString()).toBe('settled\n');
  expect(() => f.run(['cat-file', '-e', hostile])).toThrow();
});

test('private staged bytes must equal actual settled Source', () => {
  const f = fixture();
  const p = f.start();
  f.write('selected.txt', 'private staging\n');
  p.stage('add', 'selected.txt');
  f.write('selected.txt', 'actual Source\n');
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
    'Private staged bytes differ from Source'
  );
  expect(f.writes).toHaveLength(0);
  expect(f.run(['show', ':selected.txt']).toString()).toBe('selected.txt baseline\n');
});

test.each(['addition', 'deletion', 'mode', 'object', 'assume-valid', 'skip-worktree'])(
  'foreign %s staging refuses without publication',
  (kind) => {
    const f = fixture();
    if (kind === 'assume-valid') f.run(['update-index', '--assume-unchanged', 'foreign.txt']);
    const p = f.start();
    if (kind === 'addition') {
      f.write('extra.txt', 'extra\n');
      p.stage('add', 'extra.txt');
    }
    if (kind === 'deletion') p.stage('update-index', '--force-remove', 'foreign.txt');
    if (kind === 'mode') p.stage('update-index', '--chmod=+x', 'foreign.txt');
    if (kind === 'object') {
      f.write('foreign.txt', 'wrong\n');
      p.stage('add', 'foreign.txt');
    }
    if (kind === 'assume-valid') p.stage('update-index', '--no-assume-unchanged', 'foreign.txt');
    if (kind === 'skip-worktree') p.stage('update-index', '--skip-worktree', 'foreign.txt');
    expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
      'outside authorized paths'
    );
    expect(fs.readFileSync(p.transaction.indexPath)).toEqual(p.transaction.seedIndex());
    expect(f.writes).toHaveLength(0);
  }
);

test('authorized deletion publishes without object writes', () => {
  const f = fixture();
  const p = f.start();
  fs.unlinkSync(path.join(f.project, 'selected.txt'));
  p.stage('update-index', '--force-remove', 'selected.txt');
  publishGitHookTransaction(validateGitHookTransaction(p.transaction, p.privateIndex));
  expect(f.run(['ls-files', '--', 'selected.txt']).toString()).toBe('');
  expect(f.writes).toHaveLength(0);
});

test('normal EOL conversion derives and promotes the same blob', () => {
  const f = fixture();
  f.run(['config', 'core.autocrlf', 'true']);
  const p = f.start();
  f.write('selected.txt', 'formatted\r\n');
  p.stage('add', 'selected.txt');
  publishGitHookTransaction(validateGitHookTransaction(p.transaction, p.privateIndex));
  expect(f.run(['show', ':selected.txt']).toString()).toBe('formatted\n');
  expect(fs.readFileSync(path.join(f.project, 'selected.txt'), 'utf8')).toBe('formatted\r\n');
});

test('explicit Git temporary index is used instead of worktree index', () => {
  const f = fixture();
  const realIndex = f
    .run(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    .toString()
    .trim();
  const original = fs.readFileSync(realIndex);
  const temporary = path.join(path.dirname(realIndex), 'next-index-test');
  fs.writeFileSync(temporary, original);
  const p = f.start({ gitIndexPath: temporary });
  f.write('selected.txt', 'temporary commit\n');
  p.stage('add', 'selected.txt');
  publishGitHookTransaction(validateGitHookTransaction(p.transaction, p.privateIndex));
  expect(p.transaction.indexPath).toBe(temporary);
  expect(fs.readFileSync(realIndex)).toEqual(original);
  expect(f.run(['show', ':selected.txt'], { GIT_INDEX_FILE: temporary }).toString()).toBe(
    'temporary commit\n'
  );
});

test.each(['symlink', 'hardlink'])('private %s index refuses before Git decode', (kind) => {
  const f = fixture();
  const p = f.start();
  const other = path.join(path.dirname(p.privateIndex), 'other');
  fs.renameSync(p.privateIndex, other);
  if (kind === 'symlink') fs.symlinkSync(other, p.privateIndex);
  else fs.linkSync(other, p.privateIndex);
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow();
  expect(f.writes).toHaveLength(0);
});

test('corrupt checksum refuses before publication', () => {
  const f = fixture();
  const p = f.start();
  const bytes = fs.readFileSync(p.privateIndex);
  bytes[20] ^= 1;
  fs.writeFileSync(p.privateIndex, bytes);
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow('checksum');
  expect(f.writes).toHaveLength(0);
});

test.each(['link', 'sdir', 'UNKN'])(
  'dependency-bearing or unknown %s extension refuses explicitly',
  (extension) => {
    const f = fixture();
    const p = f.start();
    rewriteIndex(p.privateIndex, (body) =>
      Buffer.concat([body, Buffer.from(extension), Buffer.alloc(4)])
    );
    expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
      `Unsupported Git index extension: ${extension}`
    );
    expect(f.writes).toHaveLength(0);
  }
);

test('unsupported index version refuses even with valid checksum', () => {
  const f = fixture();
  const p = f.start();
  rewriteIndex(p.privateIndex, (body) => {
    body.writeUInt32BE(4, 4);
    return body;
  });
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
    'Unsupported Git index version: 4'
  );
  expect(f.writes).toHaveLength(0);
});

test('private derived cache-tree is removed without promoting private tree objects', () => {
  const f = fixture();
  const p = f.start();
  f.write('selected.txt', 'private tree\n');
  p.stage('add', 'selected.txt');
  const tree = p.stage('write-tree').toString().trim();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  expect(fs.readFileSync(candidate.rawSnapshotPath)).not.toEqual(
    fs.readFileSync(candidate.snapshotPath)
  );
  publishGitHookTransaction(candidate);
  expect(() => f.run(['cat-file', '-e', tree])).toThrow();
  expect(f.run(['show', ':selected.txt']).toString()).toBe('private tree\n');
});

test('an existing unrelated cache-tree cannot change consumer tree content', () => {
  const f = fixture();
  f.run(['write-tree']);
  const emptyTree = f
    .run(['hash-object', '-t', 'tree', '-w', '--stdin'], {}, Buffer.alloc(0))
    .toString()
    .trim();
  const p = f.start();
  rewriteIndex(p.privateIndex, (body) => {
    const marker = body.indexOf(Buffer.from('TREE'));
    expect(marker).toBeGreaterThan(12);
    const nul = body.indexOf(0, marker + 8);
    const newline = body.indexOf(10, nul + 1);
    Buffer.from(emptyTree, 'hex').copy(body, newline + 1);
    return body;
  });
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  publishGitHookTransaction(candidate);
  const tree = f.run(['write-tree']).toString().trim();
  const commit = f
    .run(
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit-tree', tree],
      {},
      Buffer.from('validated transaction\n')
    )
    .toString()
    .trim();
  expect(tree).not.toBe(emptyTree);
  expect(f.run(['show', `${commit}:selected.txt`]).toString()).toBe('selected.txt baseline\n');
  expect(f.run(['show', `${commit}:foreign.txt`]).toString()).toBe('foreign.txt baseline\n');
});

test('foreign lock is never removed or replaced', () => {
  const f = fixture();
  const p = f.start();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  const lock = `${p.transaction.indexPath}.lock`;
  fs.writeFileSync(lock, 'foreign lock');
  expectedError(() => publishGitHookTransaction(candidate), /EEXIST/);
  expect(fs.readFileSync(lock, 'utf8')).toBe('foreign lock');
  expect(f.writes).toHaveLength(0);
});

test('real index drift refuses and cleans up only the owned lock', () => {
  const f = fixture();
  const p = f.start();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  f.run(['update-index', '--assume-unchanged', 'foreign.txt']);
  expectedError(() => publishGitHookTransaction(candidate), /index drifted/);
  expect(f.writes).toHaveLength(0);
  expect(fs.existsSync(`${p.transaction.indexPath}.lock`)).toBe(false);
  expect(f.run(['ls-files', '-v', '--', 'foreign.txt']).toString()).toBe('h foreign.txt\n');
});

test('same-byte index replacement is drift in the captured index object', () => {
  const f = fixture();
  const p = f.start();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  fs.unlinkSync(p.transaction.indexPath);
  fs.writeFileSync(p.transaction.indexPath, p.transaction.seedIndex());
  expectedError(() => publishGitHookTransaction(candidate), /index drifted/);
  expect(f.writes).toHaveLength(0);
});

test('Source drift after validation refuses before object writes', () => {
  const f = fixture();
  const p = f.start();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  f.write('selected.txt', 'late change\n');
  expectedError(() => publishGitHookTransaction(candidate), /Source drifted/);
  expect(f.writes).toHaveLength(0);
});

test('partial object promotion reports possible objects and retains the real index', () => {
  const f = fixture();
  const p = f.start();
  f.write('selected.txt', 'promotable\n');
  p.stage('add', 'selected.txt');
  const oid = p.stage('rev-parse', ':selected.txt').toString().trim();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  f.setIntercept((request) => {
    if (request.argv.includes('-w')) {
      f.run(request.argv, request.env, request.input);
      throw new Error('injected post-object failure');
    }
  });
  expectedError(
    () => publishGitHookTransaction(candidate),
    /post-object failure/,
    'objects-may-exist'
  );
  expect(fs.readFileSync(p.transaction.indexPath)).toEqual(p.transaction.seedIndex());
  expect(f.run(['cat-file', '-t', oid]).toString()).toBe('blob\n');
  expect(fs.existsSync(`${p.transaction.indexPath}.lock`)).toBe(false);
});

test('replaced owned lock is left untouched on failure', () => {
  const f = fixture();
  const p = f.start();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  const lock = `${p.transaction.indexPath}.lock`;
  f.setIntercept((request) => {
    if (request.argv.includes('-w')) {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, 'foreign replacement');
    }
  });
  expectedError(() => publishGitHookTransaction(candidate), /lock ownership/, 'objects-may-exist');
  expect(fs.readFileSync(lock, 'utf8')).toBe('foreign replacement');
  expect(fs.readFileSync(p.transaction.indexPath)).toEqual(p.transaction.seedIndex());
});

test('lost Native authority refuses and candidates cannot be forged or reused', () => {
  const f = fixture();
  const p = f.start();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  expectedError(() => publishGitHookTransaction({ ...candidate }), /Unknown validated/);
  f.loseAuthority();
  expectedError(() => publishGitHookTransaction(candidate), /Native authority lost/);
  expectedError(() => publishGitHookTransaction(candidate), /Unknown validated/);
  expect(f.writes).toHaveLength(0);
});

test.each(['../escape', '/absolute', 'a/../b', '.git/config', '.caws/policy.yaml', 'a\\b'])(
  'unsafe selected path %s refuses',
  (name) => {
    const f = fixture();
    expect(() => f.start({ authorizedPaths: [name] })).toThrow();
    expect(f.writes).toHaveLength(0);
  }
);

test('seed bytes are copies and cannot mutate the captured baseline', () => {
  const f = fixture();
  const p = f.start();
  const original = p.transaction.seedIndex();
  const second = p.transaction.seedIndex();
  second.fill(0);
  expect(p.transaction.seedIndex()).toEqual(original);
  publishGitHookTransaction(validateGitHookTransaction(p.transaction, p.privateIndex));
  expect(fs.readFileSync(p.transaction.indexPath)).toEqual(original);
});

test('oversized index entry counts refuse before decoding', () => {
  const f = fixture();
  const p = f.start();
  rewriteIndex(p.privateIndex, (body) => {
    body.writeUInt32BE(250001, 8);
    return body;
  });
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
    'Oversized Git index entry count'
  );
  expect(f.writes).toHaveLength(0);
});

test('path-escaping private index refuses before publication', () => {
  const f = fixture();
  const p = f.start();
  rewriteIndex(p.privateIndex, (body) => {
    Buffer.from('../evilx.txt').copy(body, body.indexOf(Buffer.from('selected.txt')));
    return body;
  });
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
    'Unsupported Git path'
  );
  expect(f.writes).toHaveLength(0);
});

test('malformed index padding refuses', () => {
  const f = fixture();
  const p = f.start();
  rewriteIndex(p.privateIndex, (body) => {
    const at = body.indexOf(Buffer.from('selected.txt'));
    body[at + 'selected.txt'.length + 1] = 1;
    return body;
  });
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow('padding');
  expect(f.writes).toHaveLength(0);
});

test('duplicate index entries refuse', () => {
  const f = fixture();
  const p = f.start();
  rewriteIndex(p.privateIndex, (body) => {
    const nul = body.indexOf(0, 12 + 62);
    const end = 12 + Math.ceil((nul + 1 - 12) / 8) * 8;
    const header = Buffer.from(body.subarray(0, 12));
    header.writeUInt32BE(3, 8);
    return Buffer.concat([header, body.subarray(12, end), body.subarray(12)]);
  });
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
    'Duplicate Git index entry'
  );
  expect(f.writes).toHaveLength(0);
});

test.each(['symlink', 'hardlink'])(
  'selected %s Source refuses without object promotion',
  (kind) => {
    const f = fixture();
    const p = f.start();
    const selected = path.join(f.project, 'selected.txt');
    fs.unlinkSync(selected);
    if (kind === 'symlink') fs.symlinkSync(path.join(f.project, 'foreign.txt'), selected);
    else fs.linkSync(path.join(f.project, 'foreign.txt'), selected);
    expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow();
    expect(f.writes).toHaveLength(0);
  }
);

test('failure after atomic publication reports index-published truthfully', () => {
  const f = fixture();
  const p = f.start();
  f.write('selected.txt', 'published despite directory sync failure\n');
  p.stage('add', 'selected.txt');
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  const original = fs.fsyncSync;
  const spy = jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('directory sync failed');
    return original(fd);
  });
  try {
    expectedError(
      () => publishGitHookTransaction(candidate),
      /directory sync failed/,
      'index-published'
    );
  } finally {
    spy.mockRestore();
  }
  expect(f.run(['show', ':selected.txt']).toString()).toBe(
    'published despite directory sync failure\n'
  );
  expect(fs.existsSync(`${p.transaction.indexPath}.lock`)).toBe(false);
});

test('SHA256 Git objects and index checksum use the actual repository format', () => {
  const f = fixture({ format: 'sha256' });
  const p = f.start();
  f.write('selected.txt', 'SHA256 Source\n');
  p.stage('add', 'selected.txt');
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  publishGitHookTransaction(candidate);
  expect(p.transaction.objectFormat).toBe('sha256');
  expect(f.run(['rev-parse', ':selected.txt']).toString().trim()).toMatch(/^[a-f0-9]{64}$/);
  expect(f.run(['show', ':selected.txt']).toString()).toBe('SHA256 Source\n');
});

test('an async authority callback cannot authorize synchronous capture', () => {
  const f = fixture();
  expect(() => f.start({ assertCanonicalAuthority: async () => {} })).toThrow(
    'must complete synchronously'
  );
  expect(f.writes).toHaveLength(0);
});

test('empty Source authority accepts identical governance staging without granting metadata writes', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.project, '.caws', 'specs'), { recursive: true });
  f.write('.caws/specs/TEST.yaml', 'lifecycle_state: active\n');
  f.run(['add', '.caws/specs/TEST.yaml']);
  const p = f.start({ authorizedPaths: [] });
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  publishGitHookTransaction(candidate);
  expect(f.run(['show', ':.caws/specs/TEST.yaml']).toString()).toBe('lifecycle_state: active\n');
  expect(f.writes).toHaveLength(0);
  expect(fs.readFileSync(p.transaction.indexPath)).toEqual(p.transaction.seedIndex());
});

test.each(['object', 'flags'])('empty Source authority refuses governance %s changes', (kind) => {
  const f = fixture();
  fs.mkdirSync(path.join(f.project, '.caws', 'specs'), { recursive: true });
  f.write('.caws/specs/TEST.yaml', 'lifecycle_state: active\n');
  f.run(['add', '.caws/specs/TEST.yaml']);
  const p = f.start({ authorizedPaths: [] });
  if (kind === 'object') {
    f.write('.caws/specs/TEST.yaml', 'lifecycle_state: closed\n');
    p.stage('add', '.caws/specs/TEST.yaml');
  } else p.stage('update-index', '--assume-unchanged', '.caws/specs/TEST.yaml');
  expect(() => validateGitHookTransaction(p.transaction, p.privateIndex)).toThrow(
    'outside authorized paths'
  );
  expect(f.writes).toHaveLength(0);
  expect(fs.readFileSync(p.transaction.indexPath)).toEqual(p.transaction.seedIndex());
});

test('linked worktree metadata is discovered by Git rather than concatenated .git paths', () => {
  const f = fixture();
  f.run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  const lane = path.join(f.root, 'lane');
  f.run(['worktree', 'add', '--detach', lane, 'HEAD']);
  const run = (request) =>
    execFileSync('git', request.argv, {
      cwd: request.cwd,
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        ...request.env,
      },
      input: request.input,
      maxBuffer: 40 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const transaction = captureGitHookTransaction({ ...f.options, projectRoot: lane, git: run });
  expect(transaction.indexPath).toContain(
    `${path.sep}.git${path.sep}worktrees${path.sep}lane${path.sep}index`
  );
  const privateIndex = path.join(f.root, 'linked-private-index');
  fs.writeFileSync(privateIndex, transaction.seedIndex());
  publishGitHookTransaction(validateGitHookTransaction(transaction, privateIndex));
  expect(run({ argv: ['show', ':selected.txt'], cwd: lane, env: {} }).toString()).toBe(
    'selected.txt baseline\n'
  );
});

test.each([false, true])(
  'descriptor close failure preserves publication disposition and prior failure=%s',
  (drift) => {
    const f = fixture();
    const p = f.start();
    const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
    if (drift) f.run(['update-index', '--assume-unchanged', 'foreign.txt']);
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let lockFd;
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((filename, ...args) => {
      const fd = originalOpen(filename, ...args);
      if (filename === `${p.transaction.indexPath}.lock`) lockFd = fd;
      return fd;
    });
    const closeSpy = jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      originalClose(fd);
      if (fd === lockFd) throw new Error('injected descriptor close failure');
    });
    try {
      expectedError(
        () => publishGitHookTransaction(candidate),
        drift ? /index drifted.*descriptor close failed/ : /descriptor close failed/,
        drift ? 'not-published' : 'index-published'
      );
    } finally {
      openSpy.mockRestore();
      closeSpy.mockRestore();
    }
    expect(fs.existsSync(`${p.transaction.indexPath}.lock`)).toBe(false);
    expect(f.run(['show', ':selected.txt']).toString()).toBe('selected.txt baseline\n');
  }
);

test('directory sync and close double failure retains both errors and index publication', () => {
  const f = fixture();
  const p = f.start();
  const candidate = validateGitHookTransaction(p.transaction, p.privateIndex);
  const originalSync = fs.fsyncSync;
  const originalClose = fs.closeSync;
  const syncSpy = jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('primary directory sync failure');
    originalSync(fd);
  });
  const closeSpy = jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    const directory = fs.fstatSync(fd).isDirectory();
    originalClose(fd);
    if (directory) throw new Error('secondary directory close failure');
  });
  try {
    expectedError(
      () => publishGitHookTransaction(candidate),
      /primary directory sync failure.*secondary directory close failure/,
      'index-published'
    );
  } finally {
    syncSpy.mockRestore();
    closeSpy.mockRestore();
  }
  expect(fs.existsSync(`${p.transaction.indexPath}.lock`)).toBe(false);
  expect(f.run(['show', ':selected.txt']).toString()).toBe('selected.txt baseline\n');
});
