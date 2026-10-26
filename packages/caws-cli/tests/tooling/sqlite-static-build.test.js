const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const children = require('node:child_process');
const { setTimeout } = require('node:timers');
const {
  buildPinnedSqliteStatic,
  runSqliteBuildStep,
} = require('../../dist/tooling/sqlite-static-build');

// These are hostile filesystem/request tests. Tiny local bytes must fail the
// pinned-source authentication; they are never substituted for genuine SQLite.
// Actual authenticated builds and child lifecycle controls are host qualification.
describe('pinned SQLite build request and file boundary refusals', () => {
  let root;
  let request;
  let spawn;
  async function identity(file) {
    const bytes = await fs.readFile(file);
    return {
      path: file,
      sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  async function refusal(expected, phase) {
    const result = await buildPinnedSqliteStatic(request);
    expect(result.status).toBe('failed');
    expect(result.adoption).toBe('NOT_ADOPTED');
    expect(result.phase).toBe(phase);
    expect(result.reason).toMatch(expected);
    expect(result.steps).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    await expect(
      fs.lstat(path.join(request.outputRoot, 'recipe-completed.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    return result;
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(syncFs.realpathSync(os.tmpdir()), 'caws-sqlite-boundary-'));
    const tool = path.join(root, 'reviewed-tool');
    await fs.writeFile(tool, 'controlled boundary bytes, never executable SQLite proof\n');
    const sdkRoot = path.join(root, 'sdk');
    await fs.mkdir(sdkRoot);
    const settings = path.join(sdkRoot, 'SDKSettings.json');
    await fs.writeFile(settings, '{}\n');
    const sourceC = path.join(root, 'input.c');
    const sourceHeader = path.join(root, 'input.h');
    await fs.writeFile(sourceC, 'unauthenticated local C\n');
    await fs.writeFile(sourceHeader, 'unauthenticated local header\n');
    const reviewed = await identity(tool);
    request = {
      sourceC,
      sourceHeader,
      tools: {
        clang: { ...reviewed },
        ar: { ...reviewed },
        nm: { ...reviewed },
        otool: { ...reviewed },
      },
      sdk: { root: sdkRoot, settings: await identity(settings) },
      outputRoot: path.join(root, 'build'),
      timeoutMs: 10000,
    };
    spawn = jest.spyOn(children, 'spawn');
  });
  afterEach(async () => {
    spawn.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('unreviewed local source bytes cannot authenticate or launch tools', async () => {
    const result = await refusal(/C source pin mismatch/, 'source-authentication');
    expect(result.writerState).toBe('RETAINED_UNCERTAIN');
    expect(result.failureReceiptPath).toBe(path.join(request.outputRoot, 'build-failed.json'));
    const retained = JSON.parse(await fs.readFile(result.failureReceiptPath, 'utf8'));
    expect(retained.reason).toBe('SQLite C source pin mismatch');
    expect(retained.adoption).toBe('NOT_ADOPTED');
    expect((await fs.stat(request.outputRoot)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(request.outputRoot)).toEqual(['build-failed.json']);
  });
  test.each(['sourceC', 'sourceHeader'])('missing %s refuses before staging', async (field) => {
    await fs.unlink(request[field]);
    await refusal(/ENOENT/, 'source-authentication');
  });
  test.each(['sourceC', 'sourceHeader'])('symlink %s is not followed', async (field) => {
    const target = request[field];
    request[field] = path.join(root, `${field}-link`);
    await fs.symlink(target, request[field]);
    await refusal(/ELOOP|EMLINK/, 'source-authentication');
  });
  test('oversized source is rejected before reading it as source', async () => {
    await fs.truncate(request.sourceC, 9515342);
    await refusal(/Not a bounded regular file/, 'source-authentication');
  });
  test('directory source refuses without blocking on a special file', async () => {
    request.sourceC = root;
    await refusal(/Not a bounded regular file/, 'source-authentication');
  });
  test.each(['clang', 'ar', 'nm', 'otool'])('missing reviewed %s refuses', async (name) => {
    request.tools[name].path = path.join(root, 'missing-tool');
    await refusal(/ENOENT/, 'reviewed-inputs');
  });
  test('changed reviewed tool bytes refuse', async () => {
    await fs.writeFile(request.tools.clang.path, 'x'.repeat(request.tools.clang.sizeBytes));
    await refusal(/Reviewed identity mismatch/, 'reviewed-inputs');
  });
  test('reviewed tool size mismatch refuses', async () => {
    request.tools.clang.sizeBytes += 1;
    await refusal(/Reviewed identity mismatch/, 'reviewed-inputs');
  });
  test('symlink reviewed tool is not followed', async () => {
    const target = request.tools.clang.path;
    request.tools.clang.path = path.join(root, 'clang-link');
    await fs.symlink(target, request.tools.clang.path);
    await refusal(/ELOOP|EMLINK/, 'reviewed-inputs');
  });
  test('missing SDK settings refuse', async () => {
    await fs.unlink(request.sdk.settings.path);
    await refusal(/ENOENT/, 'reviewed-inputs');
  });
  test('changed SDK settings refuse', async () => {
    await fs.writeFile(request.sdk.settings.path, '[]\n');
    await refusal(/Reviewed identity mismatch/, 'reviewed-inputs');
  });
  test('symlink SDK settings refuse', async () => {
    const copy = path.join(root, 'settings-bytes');
    await fs.rename(request.sdk.settings.path, copy);
    await fs.symlink(copy, request.sdk.settings.path);
    await refusal(/ELOOP|EMLINK/, 'reviewed-inputs');
  });
  test('SDK settings outside the selected root refuse', async () => {
    request.sdk.settings.path = path.join(root, 'SDKSettings.json');
    await refusal(/SDK settings must be SDKSettings.json under SDK root/, 'reviewed-inputs');
  });
  test('symlink SDK root refuses', async () => {
    const sdkLink = path.join(root, 'sdk-link');
    await fs.symlink(request.sdk.root, sdkLink);
    request.sdk.root = sdkLink;
    request.sdk.settings.path = path.join(sdkLink, 'SDKSettings.json');
    await refusal(/Not a real directory/, 'reviewed-inputs');
  });
  test('existing output directory is preserved byte for byte', async () => {
    await fs.mkdir(request.outputRoot);
    const sentinel = path.join(request.outputRoot, 'owner');
    await fs.writeFile(sentinel, 'foreign output\n');
    const result = await refusal(/EEXIST/, 'output-root');
    expect(result.writerState).toBe('NOT_STARTED');
    expect(result.failureReceiptPath).toBeNull();
    expect(await fs.readFile(sentinel, 'utf8')).toBe('foreign output\n');
    expect(await fs.readdir(request.outputRoot)).toEqual(['owner']);
  });
  test('symlink output root refuses without touching target', async () => {
    const target = path.join(root, 'foreign');
    await fs.mkdir(target);
    await fs.symlink(target, request.outputRoot);
    await refusal(/EEXIST/, 'output-root');
    expect(await fs.readdir(target)).toEqual([]);
  });
  test('symlink output ancestor refuses before creating a directory', async () => {
    const link = path.join(root, 'parent-link');
    await fs.symlink(root, link);
    request.outputRoot = path.join(link, 'build');
    await refusal(/Not a real directory/, 'output-root');
    await expect(fs.lstat(path.join(root, 'build'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test.each([0, -1, 600001, NaN, 1.5])(
    'invalid timeout %s refuses without creating output',
    async (value) => {
      request.timeoutMs = value;
      const result = await refusal(/timeoutMs must be/, 'request');
      expect(result.writerState).toBe('NOT_STARTED');
    }
  );
  test.each([0, -1, 16777217, NaN, 1.5])('invalid output bound %s refuses', async (value) => {
    request.maxOutputBytes = value;
    await refusal(/maxOutputBytes must be/, 'request');
  });
  test('invalid reviewed archive pin refuses instead of silently becoming unreviewed', async () => {
    request.reviewedArchiveSha256 = 'not-a-sha256';
    await refusal(/Invalid reviewed archive SHA256/, 'request');
  });
  test('relative source refuses', async () => {
    request.sourceC = 'sqlite3.c';
    await refusal(/normalized absolute path/, 'request');
  });
  test('pre-aborted request does not reserve an output root', async () => {
    const controller = new globalThis.AbortController();
    controller.abort();
    const result = await buildPinnedSqliteStatic(request, { signal: controller.signal });
    expect(result).toMatchObject({
      status: 'failed',
      adoption: 'NOT_ADOPTED',
      phase: 'request',
      reason: 'Build aborted',
      writerState: 'NOT_STARTED',
      steps: [],
    });
    expect(spawn).not.toHaveBeenCalled();
    await expect(fs.lstat(request.outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// A controlled real process tests the I/O boundary only. These observations do
// not authenticate SQLite, tool images, SDKs, or descendant quiescence.
describe('SQLite tooling direct-child observation boundary', () => {
  let root;
  let options;
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const script = (source) => ['-e', source];
  async function raw(receipt, out, err) {
    const stdout = Buffer.from(out);
    const stderr = Buffer.from(err);
    expect(Buffer.from(receipt.stdoutBase64, 'base64')).toEqual(stdout);
    expect(Buffer.from(receipt.stderrBase64, 'base64')).toEqual(stderr);
    expect(receipt.stdoutSha256).toBe(digest(stdout));
    expect(receipt.stderrSha256).toBe(digest(stderr));
    expect(receipt.stdoutRetainedBytes).toBe(stdout.length);
    expect(receipt.stderrRetainedBytes).toBe(stderr.length);
    expect(await fs.readFile(receipt.stdoutPath)).toEqual(stdout);
    expect(await fs.readFile(receipt.stderrPath)).toEqual(stderr);
    const persisted = JSON.parse(
      await fs.readFile(path.join(root, `${options.label}.step.json`), 'utf8')
    );
    expect(persisted).toEqual(receipt);
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(syncFs.realpathSync(os.tmpdir()), 'caws-sqlite-child-'));
    options = {
      label: 'controlled-child',
      executable: syncFs.realpathSync(process.execPath),
      args: [],
      cwd: root,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      deadline: Date.now() + 5000,
      maxOutputBytes: 1024,
    };
  });
  afterEach(async () => {
    // The lower boundary has no publication operation. Top-level qualification
    // separately tests that these step outcomes prevent recipe publication.
    await expect(fs.lstat(path.join(root, 'recipe-completed.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  test('observes exit17 and exact binary stdout/stderr independently', async () => {
    options.args = script(
      "require('fs').writeSync(1, Buffer.from([0,255,10])); require('fs').writeSync(2, 'failure\\n'); process.exit(17)"
    );
    const result = await runSqliteBuildStep(options);
    expect(result).toMatchObject({
      exitCode: 17,
      signal: null,
      directChildReaped: true,
      stopReason: null,
      error: null,
      persistenceError: null,
      stdoutBytes: 3,
      stderrBytes: 8,
    });
    await raw(result, Buffer.from([0, 255, 10]), 'failure\n');
  });
  test('observes actual signal termination', async () => {
    options.args = script(
      "require('fs').writeSync(1, 'before-signal\\n'); process.kill(process.pid, 'SIGTERM')"
    );
    const result = await runSqliteBuildStep(options);
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
      directChildReaped: true,
      stopReason: null,
      persistenceError: null,
    });
    await raw(result, 'before-signal\n', '');
  });
  test('spawnENOENT retains error and empty streams without inventing a reaped child', async () => {
    options.executable = path.join(root, 'missing-executable');
    const result = await runSqliteBuildStep(options);
    expect(result).toMatchObject({
      exitCode: null,
      signal: null,
      directChildReaped: false,
      stopReason: 'spawn-error',
      persistenceError: null,
    });
    expect(result.error).toMatch(/ENOENT/);
    await raw(result, '', '');
  });
  test('abort after observed start kills and reaps direct child, retaining prior output', async () => {
    const controller = new globalThis.AbortController();
    options.signal = controller.signal;
    options.args = script(
      "require('fs').writeSync(1, 'started\\n'); require('fs').writeFileSync('started.pending', 'yes'); require('fs').renameSync('started.pending', 'started'); setInterval(() => {}, 1000)"
    );
    const pending = runSqliteBuildStep(options);
    const until = Date.now() + 3000;
    while (!syncFs.existsSync(path.join(root, 'started')) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await fs.readFile(path.join(root, 'started'), 'utf8')).toBe('yes');
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      directChildReaped: true,
      stopReason: 'abort',
      persistenceError: null,
    });
    await raw(result, 'started\n', '');
  });
  test('deadline kills a live child and retains already observed output', async () => {
    options.deadline = Date.now() + 1000;
    options.args = script("require('fs').writeSync(2, 'waiting\\n'); setInterval(() => {}, 1000)");
    const result = await runSqliteBuildStep(options);
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      directChildReaped: true,
      stopReason: 'timeout',
      persistenceError: null,
    });
    await raw(result, '', 'waiting\n');
  });
  test.each([
    [1, 'stdout'],
    [2, 'stderr'],
  ])('bounds overflowing channel %s (%s) and retains exact capped bytes', async (fd, channel) => {
    options.maxOutputBytes = 128;
    options.args = script(
      `require('fs').writeSync(${fd}, Buffer.alloc(4096, 120)); setInterval(() => {}, 1000)`
    );
    const result = await runSqliteBuildStep(options);
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      directChildReaped: true,
      stopReason: 'overflow',
      persistenceError: null,
    });
    expect(result[`${channel}Bytes`]).toBe(4096);
    await raw(
      result,
      fd === 1 ? Buffer.alloc(128, 120) : '',
      fd === 2 ? Buffer.alloc(128, 120) : ''
    );
  });
  test('output exactly at the combined bound completes with both channels intact', async () => {
    options.maxOutputBytes = 4;
    options.args = script("require('fs').writeSync(1, 'ab'); require('fs').writeSync(2, 'cd')");
    const result = await runSqliteBuildStep(options);
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      directChildReaped: true,
      stopReason: null,
      persistenceError: null,
    });
    await raw(result, 'ab', 'cd');
  });
  test('pre-abort and expired deadline refuse spawning a side-effecting child', async () => {
    const controller = new globalThis.AbortController();
    controller.abort();
    options.signal = controller.signal;
    options.args = script("require('fs').writeFileSync('should-not-exist', 'bad')");
    const aborted = await runSqliteBuildStep(options);
    expect(aborted).toMatchObject({
      exitCode: null,
      directChildReaped: false,
      stopReason: 'abort',
    });
    await raw(aborted, '', '');
    const expired = await runSqliteBuildStep({
      ...options,
      signal: undefined,
      label: 'expired',
      deadline: Date.now() - 1,
    });
    expect(expired).toMatchObject({
      exitCode: null,
      directChildReaped: false,
      stopReason: 'timeout',
    });
    await expect(fs.lstat(path.join(root, 'should-not-exist'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  test('conflicting stdout path preserves foreign bytes and returns bounded raw fallback plus child outcome', async () => {
    const conflicting = path.join(root, `${options.label}.stdout`);
    await fs.writeFile(conflicting, 'foreign bytes');
    options.args = script(
      "require('fs').writeSync(1, 'actual-out'); require('fs').writeSync(2, 'actual-err'); process.exit(17)"
    );
    const result = await runSqliteBuildStep(options);
    expect(result).toMatchObject({
      exitCode: 17,
      directChildReaped: true,
      stopReason: null,
      stdoutBytes: 10,
      stderrBytes: 10,
    });
    expect(result.persistenceError).toMatch(/EEXIST/);
    expect(await fs.readFile(conflicting, 'utf8')).toBe('foreign bytes');
    expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('actual-out');
    expect(Buffer.from(result.stderrBase64, 'base64').toString()).toBe('actual-err');
    expect(result.stdoutSha256).toBe(digest(Buffer.from('actual-out')));
    expect(result.stderrSha256).toBe(digest(Buffer.from('actual-err')));
    expect(await fs.readFile(result.stderrPath, 'utf8')).toBe('actual-err');
    expect(
      JSON.parse(await fs.readFile(path.join(root, `${options.label}.step.json`), 'utf8'))
    ).toEqual(result);
  });
  test('conflicting receipt path cannot overwrite foreign evidence or discard actual channels', async () => {
    const target = path.join(root, `${options.label}.step.json`);
    await fs.writeFile(target, 'foreign receipt');
    options.args = script("require('fs').writeSync(1, 'actual'); process.exit(17)");
    const result = await runSqliteBuildStep(options);
    expect(result.exitCode).toBe(17);
    expect(result.directChildReaped).toBe(true);
    expect(result.persistenceError).toMatch(/EEXIST/);
    expect(await fs.readFile(target, 'utf8')).toBe('foreign receipt');
    expect(await fs.readFile(result.stdoutPath, 'utf8')).toBe('actual');
    expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('actual');
  });
  test('snapshots argv/env before awaiting directory checks', async () => {
    options.args = script('process.stdout.write(process.env.FIXTURE)');
    options.env.FIXTURE = 'original';
    const pending = runSqliteBuildStep(options);
    options.args[1] = "process.stdout.write('mutated')";
    options.env.FIXTURE = 'mutated';
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.env.FIXTURE).toBe('original');
    await raw(result, 'original', '');
  });
  test('changed working directory retains raw fallback without writing into the replacement', async () => {
    const moved = `${root}-moved`;
    options.args = script(
      "const fs = require('fs'); const cwd = process.cwd(); fs.writeSync(1, 'before-replacement'); fs.renameSync(cwd, cwd + '-moved'); fs.mkdirSync(cwd)"
    );
    try {
      const result = await runSqliteBuildStep(options);
      expect(result).toMatchObject({
        exitCode: 0,
        directChildReaped: true,
        stopReason: null,
        persistenceError: 'Step working directory identity changed',
      });
      expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('before-replacement');
      expect(await fs.readdir(root)).toEqual([]);
      expect(await fs.readdir(moved)).toEqual([]);
    } finally {
      await fs.rm(moved, { recursive: true, force: true });
    }
  });
  test.each([
    ['label', '../escape', /step label/],
    ['maxOutputBytes', 0, /output bound/],
    ['maxOutputBytes', 16777217, /output bound/],
    ['deadline', NaN, /deadline/],
    ['deadline', Number.MAX_SAFE_INTEGER, /deadline/],
    ['executable', 'node', /absolute path/],
    ['cwd', '../relative', /absolute path/],
  ])('rejects invalid %s=%s before writing evidence', async (key, value, expected) => {
    options[key] = value;
    await expect(runSqliteBuildStep(options)).rejects.toThrow(expected);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
