const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { consumeCommittedSession } = require('../../dist/runtime/committed-session-reader');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const correlation = {
  id: 'original-one',
  runtimeDigest: 'a'.repeat(64),
  token: 'original-token',
  attempt: 'native-attempt',
};
let root, directory, expected, files, controller;
function marker(selection = expected) {
  return Buffer.from(
    JSON.stringify({
      schema: 'caws.session.publication.v1',
      canonicalRoot: selection.canonicalRoot,
      sessionId: selection.sessionId,
      correlation: selection.correlation,
      terminalDigest: selection.terminalDigest,
      artifacts: selection.artifacts,
    })
  );
}
function read(consume = async () => {}, selection = expected) {
  return consumeCommittedSession(
    selection,
    { signal: controller.signal, deadlineEpochMs: Date.now() + 5000 },
    consume
  );
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'committed-session-')));
  directory = path.join(root, '.caws/sessions/session-one');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  files = new Map([
    ['.meta.json', Buffer.from('{"unrelated":{"exact":9007199254740993}}')],
    ['session-index.json', Buffer.from('{"session_id":"session-one","turn_count":1}')],
    ['turn-001.json', Buffer.from('{"user":"actual user text","usage":{"input_tokens":123}}')],
  ]);
  const roles = {
    '.meta.json': 'metadata',
    'session-index.json': 'index',
    'turn-001.json': 'turn',
  };
  const artifacts = [...files].map(([name, bytes]) => ({
    name,
    role: roles[name],
    byteLength: bytes.length,
    sha256: sha(bytes),
  }));
  expected = {
    canonicalRoot: root,
    sessionId: 'session-one',
    correlation,
    terminalDigest: sha(JSON.stringify([correlation, 'published', artifacts])),
    artifacts,
  };
  for (const [name, bytes] of files)
    fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, '.session-publication.json'), marker(), { mode: 0o600 });
  controller = new globalThis.AbortController();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('independent current read supplies owned exact bytes and ignores unrelated audit files', async () => {
  fs.writeFileSync(path.join(directory, 'audit.log'), 'unrelated writer');
  const returned = await read(async (session) => {
    expect(session.correlation).toEqual(correlation);
    expect(session.markerSha256).toBe(sha(marker()));
    for (const [name, bytes] of files) {
      expect(Buffer.from(session.bytes(name))).toEqual(bytes);
      session.bytes(name).fill(0);
      expect(Buffer.from(session.bytes(name))).toEqual(bytes);
    }
    expect(() => session.bytes('../foreign')).toThrow('Unknown committed session artifact');
    return 'ordinary consumer used current bytes';
  });
  expect(returned).toBe('ordinary consumer used current bytes');
});

test.each(['schema', 'canonicalRoot', 'sessionId', 'correlation', 'terminalDigest', 'artifacts'])(
  'stale or foreign marker %s never reaches the ordinary consumer',
  async (field) => {
    const value = JSON.parse(marker());
    value[field] =
      field === 'artifacts'
        ? []
        : field === 'correlation'
          ? { ...correlation, attempt: 'stale' }
          : 'foreign';
    fs.writeFileSync(path.join(directory, '.session-publication.json'), JSON.stringify(value));
    const consumer = jest.fn();
    await expect(read(consumer)).rejects.toThrow(/marker/);
    expect(consumer).not.toHaveBeenCalled();
  }
);

test.each(['duplicate', 'extra', 'newline', 'utf8'])(
  'non-native marker %s refuses',
  async (change) => {
    const original = marker();
    const altered =
      change === 'duplicate'
        ? Buffer.from(original.toString().replace('"schema":', '"schema":"foreign","schema":'))
        : change === 'extra'
          ? Buffer.from(original.toString().replace('"schema":', '"extra":true,"schema":'))
          : change === 'newline'
            ? Buffer.concat([original, Buffer.from('\n')])
            : Buffer.from([0xff]);
    fs.writeFileSync(path.join(directory, '.session-publication.json'), altered);
    const consumer = jest.fn();
    await expect(read(consumer)).rejects.toThrow(/marker/);
    expect(consumer).not.toHaveBeenCalled();
  }
);

test.each(['missing', 'extra', 'bytes'])(
  'current artifact %s differs from the full inventory',
  async (change) => {
    if (change === 'missing') fs.unlinkSync(path.join(directory, 'turn-001.json'));
    if (change === 'extra')
      fs.writeFileSync(path.join(directory, 'turn-999.json'), '{}', { mode: 0o600 });
    if (change === 'bytes')
      fs.writeFileSync(
        path.join(directory, 'turn-001.json'),
        Buffer.alloc(files.get('turn-001.json').length, 120)
      );
    const consumer = jest.fn();
    await expect(read(consumer)).rejects.toThrow(/inventory|bytes/);
    expect(consumer).not.toHaveBeenCalled();
  }
);

test.each(['marker', 'artifact', 'session-directory'])(
  'same-byte %s replacement during consumption refuses return',
  async (kind) => {
    let used = false;
    await expect(
      read(async (session) => {
        used = true;
        expect(Buffer.from(session.bytes('turn-001.json'))).toEqual(files.get('turn-001.json'));
        if (kind === 'session-directory') {
          fs.renameSync(directory, directory + '-old');
          fs.mkdirSync(directory, { mode: 0o700 });
          for (const name of fs.readdirSync(directory + '-old'))
            fs.copyFileSync(path.join(directory + '-old', name), path.join(directory, name));
        } else {
          const name = kind === 'marker' ? '.session-publication.json' : 'turn-001.json';
          const replacement = path.join(directory, 'replacement');
          fs.writeFileSync(replacement, fs.readFileSync(path.join(directory, name)), {
            mode: 0o600,
          });
          fs.renameSync(replacement, path.join(directory, name));
        }
      })
    ).rejects.toThrow(/replaced|changed/);
    expect(used).toBe(true);
  }
);

test.each(['marker', 'artifact', 'directory', 'hardlink', 'writable'])(
  'unsafe %s is not followed or consumed',
  async (kind) => {
    const foreign = path.join(root, 'foreign');
    fs.writeFileSync(foreign, files.get('turn-001.json'), { mode: 0o600 });
    if (kind === 'marker' || kind === 'artifact') {
      const file = path.join(
        directory,
        kind === 'marker' ? '.session-publication.json' : 'turn-001.json'
      );
      fs.unlinkSync(file);
      fs.symlinkSync(foreign, file);
    } else if (kind === 'directory') {
      fs.renameSync(directory, directory + '-held');
      fs.symlinkSync(directory + '-held', directory);
    } else if (kind === 'hardlink')
      fs.linkSync(path.join(directory, 'turn-001.json'), path.join(root, 'alias'));
    else fs.chmodSync(path.join(directory, 'turn-001.json'), 0o666);
    const consumer = jest.fn();
    await expect(read(consumer)).rejects.toThrow(/Unsafe|symlink/);
    expect(consumer).not.toHaveBeenCalled();
    expect(fs.readFileSync(foreign)).toEqual(files.get('turn-001.json'));
  }
);

test('a copied marker cannot select another canonical root or session', async () => {
  const other = path.join(root, 'other');
  const otherDirectory = path.join(other, '.caws/sessions/session-one');
  fs.mkdirSync(otherDirectory, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(directory))
    fs.copyFileSync(path.join(directory, name), path.join(otherDirectory, name));
  await expect(read(jest.fn(), { ...expected, canonicalRoot: other })).rejects.toThrow(
    /marker differs/
  );
  await expect(read(jest.fn(), { ...expected, sessionId: '../session-one' })).rejects.toThrow(
    /location/
  );
});

test('consumer failure and cancellation do not turn the validated snapshot into completion', async () => {
  const failure = new Error('ordinary consumer failed');
  await expect(
    read(async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  const cancelled = new Error('request cancelled');
  await expect(
    read(async () => {
      controller.abort(cancelled);
    })
  ).rejects.toBe(cancelled);
});

test.each([
  ['abort', 'resolve'],
  ['abort', 'reject'],
  ['deadline', 'resolve'],
  ['deadline', 'reject'],
])('held reader closes on %s before deferred consumer may %s', async (stop, late) => {
  const live = new Set(),
    actualOpen = fs.openSync,
    actualClose = fs.closeSync;
  const open = jest.spyOn(fs, 'openSync').mockImplementation((...args) => {
    const fd = actualOpen(...args);
    live.add(fd);
    return fd;
  });
  const close = jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    const result = actualClose(fd);
    live.delete(fd);
    return result;
  });
  const now = Date.now();
  if (stop === 'deadline') jest.useFakeTimers({ now, doNotFake: ['setImmediate', 'nextTick'] });
  let entered, release, rejectLate, view;
  const enteredConsumer = new Promise((accept) => {
    entered = accept;
  });
  const deferred = new Promise((accept, reject) => {
    release = accept;
    rejectLate = reject;
  });
  const unhandled = jest.fn(),
    cancelled = new Error('original invocation aborted'),
    lateFailure = new Error('late consumer rejection');
  process.on('unhandledRejection', unhandled);
  const pending = consumeCommittedSession(
    expected,
    { signal: controller.signal, deadlineEpochMs: now + 1000 },
    async (session) => {
      view = session;
      entered();
      await deferred;
      return 'late result';
    }
  );
  const observed = pending.then(
    (value) => ({ kind: 'resolved', value }),
    (error) => ({ kind: 'rejected', error })
  );
  try {
    await Promise.race([
      enteredConsumer,
      observed.then(() => {
        throw new Error('Reader settled before consumption began');
      }),
    ]);
    expect(live.size).toBeGreaterThan(0);
    if (stop === 'abort') controller.abort(cancelled);
    else jest.advanceTimersByTime(1000);
    const result = await Promise.race([
      observed,
      new Promise((accept) => setImmediate(() => accept({ kind: 'pending' }))),
    ]);
    expect(result.kind).toBe('rejected');
    if (stop === 'abort') expect(result.error).toBe(cancelled);
    else expect(result.error.message).toMatch(/deadline/);
    // This occurs while the consumer is still deferred, not after releasing it.
    expect(live.size).toBe(0);
    expect(Buffer.from(view.bytes('turn-001.json'))).toEqual(files.get('turn-001.json'));
    if (late === 'reject') rejectLate(lateFailure);
    else release();
    await new Promise((accept) => setImmediate(accept));
    expect(await observed).toBe(result);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    release();
    await observed;
    await new Promise((accept) => setImmediate(accept));
    process.removeListener('unhandledRejection', unhandled);
    open.mockRestore();
    close.mockRestore();
    if (stop === 'deadline') jest.useRealTimers();
  }
});
