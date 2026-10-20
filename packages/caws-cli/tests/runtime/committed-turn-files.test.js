'use strict';

// Actual compiled qualification helper and real filesystem publication controls.
// Compile scripts/qualify-render-lifecycle.ts before running this suite.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const helper =
  process.env.CAWS_COMMITTED_TURN_HELPER ??
  path.resolve(
    __dirname,
    '../../../caws-native/target/qualification-tools/committed-turn-files.js'
  );
if (!path.isAbsolute(helper)) throw new Error('CAWS_COMMITTED_TURN_HELPER must be absolute');
const { committedTurnNames, readCommittedTurnFile } = require(helper);
const artifactRoot =
  process.env.CAWS_TEST_ARTIFACT_DIR ??
  path.resolve(
    __dirname,
    '../../../caws-native/target/qualification/prefix-cohort-2026-10-20/committed-turn-files-fixtures'
  );
if (!path.isAbsolute(artifactRoot)) throw new Error('CAWS_TEST_ARTIFACT_DIR must be absolute');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function put(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
function fixture() {
  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(artifactRoot, 'case-'));
  const session = path.join(root, 'session');
  fs.mkdirSync(session, { mode: 0o700 });
  put(
    path.join(root, 'case.json'),
    JSON.stringify(
      {
        test: expect.getState().currentTestName,
        root,
        session,
        pid: process.pid,
        helper,
        helperSha256: sha(fs.readFileSync(helper)),
      },
      null,
      2
    ) + '\n'
  );
  return { root, session };
}
function observation(root, name, value) {
  put(path.join(root, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}
afterEach(() => jest.restoreAllMocks());

test('unpublished partial staging is ignored; close and atomic rename publish complete same-inode bytes', () => {
  const { root, session } = fixture();
  const staging = path.join(session, 'turn-001.json.tmp.writer');
  const target = path.join(session, 'turn-001.json');
  const complete = Buffer.from('{"turn":1,"text":"actual publication •"}\n');
  const fd = fs.openSync(staging, 'wx', 0o600);
  let before;
  try {
    fs.writeSync(fd, complete.subarray(0, 8));
    before = fs.fstatSync(fd);
    put(path.join(root, 'partial-stage.bin'), fs.readFileSync(staging));
    observation(root, 'before-publication', {
      staging,
      dev: before.dev,
      ino: before.ino,
      partialBytes: before.size,
      finalExists: fs.existsSync(target),
      committed: committedTurnNames(session),
    });
    expect(committedTurnNames(session)).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
    fs.writeSync(fd, complete.subarray(8));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(staging, target);
  const actual = readCommittedTurnFile(session, 'turn-001.json', 1024);
  put(path.join(root, 'published.bin'), actual.bytes);
  observation(root, 'after-publication', {
    target,
    dev: actual.dev,
    ino: actual.ino,
    bytes: actual.bytes.length,
    sha256: sha(actual.bytes),
    committed: committedTurnNames(session),
  });
  expect(committedTurnNames(session)).toEqual(['turn-001.json']);
  expect(actual.bytes).toEqual(complete);
  expect(actual.value).toEqual({ turn: 1, text: 'actual publication •' });
  expect([actual.dev, actual.ino]).toEqual([before.dev, before.ino]);
});

test('disappearing temporary entries and nonmatching symlinks are never probed or traversed', () => {
  const { root, session } = fixture();
  const transient = path.join(session, 'turn-002.json.tmp.writer');
  const link = path.join(session, 'unpublished-link');
  put(transient, '{');
  fs.symlinkSync('absent-target', link);
  fs.mkdirSync(path.join(session, 'nested'));
  put(path.join(session, 'nested', 'turn-999.json'), '{"turn":999}');
  observation(root, 'unpublished', {
    transient,
    link: {
      path: link,
      target: fs.readlinkSync(link),
      symlink: fs.lstatSync(link).isSymbolicLink(),
    },
  });
  const readdir = fs.readdirSync.bind(fs),
    lstat = fs.lstatSync.bind(fs);
  jest.spyOn(fs, 'readdirSync').mockImplementation((directory, ...args) => {
    const names = readdir(directory, ...args);
    if (directory === session && fs.existsSync(transient)) fs.unlinkSync(transient);
    return names;
  });
  const probes = [];
  jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    probes.push(String(file));
    if (file !== session) throw new Error('nonmatching entry must not be probed');
    return lstat(file, ...args);
  });
  jest.spyOn(fs, 'openSync').mockImplementation((file) => {
    throw new Error('nonmatching entry must not be opened: ' + file);
  });
  try {
    expect(committedTurnNames(session)).toEqual([]);
    expect(probes).toEqual([session]);
    expect(fs.existsSync(transient)).toBe(false);
  } finally {
    jest.restoreAllMocks();
    fs.unlinkSync(link);
  }
  // Only our intentional symlink is removed; no target was dereferenced.
  expect(fs.existsSync(path.join(session, 'nested', 'turn-999.json'))).toBe(true);
});

test.each(['directory', 'symlink', 'malformed', 'array', 'invalid-utf8', 'oversize'])(
  'matching %s is a failed committed observation, never omitted',
  (kind) => {
    const { root, session } = fixture(),
      file = path.join(session, 'turn-001.json');
    if (kind === 'directory') fs.mkdirSync(file);
    else if (kind === 'symlink') fs.symlinkSync('absent-target', file);
    else
      put(
        file,
        kind === 'malformed'
          ? '{'
          : kind === 'array'
            ? '[]'
            : kind === 'invalid-utf8'
              ? Buffer.concat([
                  Buffer.from('{"turn":1,"text":"'),
                  Buffer.from([0xff]),
                  Buffer.from('"}'),
                ])
              : JSON.stringify({ turn: 1, text: 'x'.repeat(1025) })
      );
    observation(root, 'named-entry', {
      file,
      kind,
      dev: fs.lstatSync(file).dev,
      ino: fs.lstatSync(file).ino,
      symlink: fs.lstatSync(file).isSymbolicLink(),
      ...(kind === 'symlink' ? { target: fs.readlinkSync(file) } : {}),
    });
    try {
      expect(committedTurnNames(session)).toEqual(['turn-001.json']);
      const expected =
        kind === 'invalid-utf8'
          ? /encoded data was not valid/
          : kind === 'oversize'
            ? /exceeds qualification capture limit/
            : undefined;
      expect(() => readCommittedTurnFile(session, 'turn-001.json', 1024)).toThrow(expected);
    } finally {
      if (kind === 'symlink') fs.unlinkSync(file);
    }
  }
);

test('a valid JSON object fits exactly at the capture limit and fails one byte below it', () => {
  const { root, session } = fixture();
  const prefix = Buffer.from('{"turn":1,"text":"'),
    suffix = Buffer.from('"}\n');
  const text = 'x'.repeat(1024 - prefix.length - suffix.length);
  const bytes = Buffer.concat([prefix, Buffer.from(text), suffix]);
  expect(bytes.length).toBe(1024);
  put(path.join(session, 'turn-001.json'), bytes);
  const captured = readCommittedTurnFile(session, 'turn-001.json', 1024);
  observation(root, 'exact-limit', {
    bytes: captured.bytes.length,
    sha256: sha(captured.bytes),
    limit: 1024,
  });
  expect(captured.bytes).toEqual(bytes);
  expect(captured.value).toEqual({ turn: 1, text });
  expect(() => readCommittedTurnFile(session, 'turn-001.json', 1023)).toThrow(
    /exceeds qualification capture limit/
  );
});

test('a matching entry missing after enumeration is not silently omitted', () => {
  const { root, session } = fixture(),
    file = path.join(session, 'turn-001.json');
  put(file, '{"turn":1}');
  const names = committedTurnNames(session);
  observation(root, 'before-removal', {
    file,
    names,
    dev: fs.lstatSync(file).dev,
    ino: fs.lstatSync(file).ino,
  });
  fs.renameSync(file, path.join(root, 'removed-final.bin'));
  expect(names).toEqual(['turn-001.json']);
  expect(() => readCommittedTurnFile(session, names[0], 1024)).toThrow(/ENOENT/);
});

test.each(['before-open', 'during-read'])(
  'matching replacement %s refuses even identical JSON bytes',
  (boundary) => {
    const { root, session } = fixture(),
      file = path.join(session, 'turn-001.json');
    const bytes = Buffer.from('{"turn":1}\n'),
      replacement = path.join(root, 'replacement.bin');
    put(file, bytes);
    put(replacement, bytes);
    const original = fs.lstatSync(file),
      changed = fs.lstatSync(replacement);
    observation(root, 'before-replacement', {
      boundary,
      original: { dev: original.dev, ino: original.ino },
      replacement: { dev: changed.dev, ino: changed.ino },
      identicalSha256: sha(bytes),
    });
    const open = fs.openSync.bind(fs),
      read = fs.readSync.bind(fs);
    let replaced = false;
    if (boundary === 'before-open')
      jest.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
        if (target === file && !replaced) {
          replaced = true;
          fs.renameSync(replacement, file);
        }
        return open(target, ...args);
      });
    else
      jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
        const count = read(...args);
        if (!replaced) {
          replaced = true;
          fs.renameSync(replacement, file);
        }
        return count;
      });
    try {
      expect(() => readCommittedTurnFile(session, 'turn-001.json', 1024)).toThrow(
        boundary === 'before-open'
          ? /replaced before open/
          : /changed during read|name replaced during read/
      );
      expect(replaced).toBe(true);
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect([fs.lstatSync(file).dev, fs.lstatSync(file).ino]).toEqual([changed.dev, changed.ino]);
    } finally {
      jest.restoreAllMocks();
    }
  }
);

test('mutation through the same inode while reading is a failed observation', () => {
  const { root, session } = fixture(),
    file = path.join(session, 'turn-001.json');
  put(file, '{"turn":1}\n');
  const before = fs.lstatSync(file),
    read = fs.readSync.bind(fs);
  observation(root, 'before-mutation', {
    file,
    dev: before.dev,
    ino: before.ino,
    size: before.size,
  });
  let changed = false;
  jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
    const count = read(...args);
    if (!changed) {
      changed = true;
      fs.appendFileSync(file, ' ');
    }
    return count;
  });
  try {
    expect(() => readCommittedTurnFile(session, 'turn-001.json', 1024)).toThrow(
      /changed during read/
    );
    expect(changed).toBe(true);
    expect([fs.lstatSync(file).dev, fs.lstatSync(file).ino]).toEqual([before.dev, before.ino]);
    expect(fs.lstatSync(file).size).toBe(before.size + 1);
  } finally {
    jest.restoreAllMocks();
  }
});
