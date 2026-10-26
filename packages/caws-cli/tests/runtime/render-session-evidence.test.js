'use strict';

// Component FS controls of the actual compiled method, not native cleanup or authority proof.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const helper =
  process.env.CAWS_RENDER_HARNESS_HELPER ??
  path.resolve(
    __dirname,
    '../../../caws-native/target/qualification-tools/scripts/render-qualification-harness.js'
  );
const artifacts =
  process.env.CAWS_TEST_ARTIFACT_DIR ??
  path.resolve(
    __dirname,
    '../../../caws-native/target/qualification/prefix-cohort-2026-10-20/render-session-evidence-fixtures'
  );
if (!path.isAbsolute(helper) || !path.isAbsolute(artifacts))
  throw new Error('Helper/artifact overrides must be absolute');
const { RenderHarness } = require(helper);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function put(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
function fixture(state = 'confirmed_inactive') {
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const base = fs.mkdtempSync(path.join(artifacts, 'case-'));
  const root = path.join(base, 'retained'),
    sandbox = path.join(base, 'sandbox');
  const project = path.join(sandbox, 'project'),
    sid = 'session-one';
  const session = path.join(project, '.caws/sessions', sid);
  fs.mkdirSync(session, { recursive: true });
  fs.mkdirSync(root);
  put(path.join(root, 'cleanup.json'), JSON.stringify({ state }) + '\n');
  put(path.join(session, 'hook-invocations/request.jsonl'), '{"stage":"actual fixture bytes"}\n');
  put(path.join(session, 'LEGACY-KNOWN-IDLE-CONTROL'), 'created-marker\n');
  put(
    path.join(base, 'case.json'),
    JSON.stringify(
      {
        test: expect.getState().currentTestName,
        claim:
          'component unit with synthetic cleanup receipt; no native authority or cleanup proof',
        helper,
        helperSha256: sha(fs.readFileSync(helper)),
        base,
        root,
        sandbox,
        session,
      },
      null,
      2
    ) + '\n'
  );
  const receiver = {
    root,
    sandbox,
    sessions: new Map([[project + '\0' + sid, { sessionId: sid, session }]]),
  };
  return {
    base,
    root,
    session,
    receiver,
    retain: () => RenderHarness.prototype.retainSessionEvidence.call(receiver),
  };
}
afterEach(() => jest.restoreAllMocks());

test('copies complete registered journals and markers with exact bytes and explicit absent-marker inventory', () => {
  const f = fixture(),
    result = f.retain();
  const retained = result.sessions[0];
  expect(result.sessions).toHaveLength(1);
  expect(result.cleanupSha256).toBe(sha(fs.readFileSync(path.join(f.root, 'cleanup.json'))));
  expect(retained.beforeFlatFilenames).toEqual(['LEGACY-KNOWN-IDLE-CONTROL', 'hook-invocations']);
  expect(retained.finalFlatFilenames).toEqual(retained.beforeFlatFilenames);
  expect(retained.finalFlatFilenames).not.toContain('MUST-NOT-REPLAY');
  expect(retained.afterFiles).toEqual([
    'LEGACY-KNOWN-IDLE-CONTROL',
    'hook-invocations/request.jsonl',
  ]);
  for (const member of retained.members) {
    const original = fs.readFileSync(member.originalPath),
      copied = fs.readFileSync(member.retainedPath);
    expect(copied).toEqual(original);
    expect(member.sha256).toBe(sha(original));
    expect(member.bytes).toBe(original.length);
    expect([member.dev, member.ino]).toEqual([
      fs.lstatSync(member.originalPath).dev,
      fs.lstatSync(member.originalPath).ino,
    ]);
  }
  expect(fs.existsSync(path.join(f.root, 'session-evidence/inventory.json'))).toBe(true);
});

test('unknown cleanup refuses before creating retained session evidence', () => {
  const f = fixture('unknown');
  expect(() => f.retain()).toThrow(/confirmed inactive cleanup/);
  expect(fs.existsSync(path.join(f.root, 'session-evidence'))).toBe(false);
  expect(fs.readFileSync(path.join(f.session, 'LEGACY-KNOWN-IDLE-CONTROL'), 'utf8')).toBe(
    'created-marker\n'
  );
});

test('existing retained evidence is never overwritten', () => {
  const f = fixture();
  f.retain();
  const inventory = path.join(f.root, 'session-evidence/inventory.json'),
    before = fs.readFileSync(inventory);
  expect(() => f.retain()).toThrow(/EEXIST/);
  expect(fs.readFileSync(inventory)).toEqual(before);
});

test('a source symlink refuses without dereferencing its target', () => {
  const f = fixture(),
    link = path.join(f.session, 'redirected');
  fs.symlinkSync('absent-target', link);
  put(
    path.join(f.base, 'symlink-observation.json'),
    JSON.stringify({
      path: link,
      target: fs.readlinkSync(link),
      symlink: fs.lstatSync(link).isSymbolicLink(),
      dev: fs.lstatSync(link).dev,
      ino: fs.lstatSync(link).ino,
    }) + '\n'
  );
  try {
    expect(() => f.retain()).toThrow(/artifact symlink/);
  } finally {
    fs.unlinkSync(link);
  }
  expect(fs.existsSync(path.join(f.root, 'session-evidence/inventory.json'))).toBe(false);
});

test.each(['replace', 'append'])(
  'source %s during capture refuses instead of claiming a stable copy',
  (kind) => {
    const f = fixture(),
      source = path.join(f.session, 'LEGACY-KNOWN-IDLE-CONTROL');
    const open = fs.openSync.bind(fs),
      read = fs.readSync.bind(fs),
      descriptors = new Set();
    const replacement = path.join(f.base, 'replacement.bin');
    put(replacement, fs.readFileSync(source));
    let changed = false;
    jest.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (file === source && kind === 'replace' && !changed) {
        changed = true;
        fs.renameSync(replacement, source);
      }
      const fd = open(file, ...args);
      if (file === source) descriptors.add(fd);
      return fd;
    });
    jest.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const count = read(fd, ...args);
      if (kind === 'append' && descriptors.has(fd) && !changed) {
        changed = true;
        fs.appendFileSync(source, '!');
      }
      return count;
    });
    try {
      expect(() => f.retain()).toThrow(
        kind === 'replace' ? /replaced before read/ : /size changed during read/
      );
      expect(changed).toBe(true);
      expect(fs.existsSync(path.join(f.root, 'session-evidence/inventory.json'))).toBe(false);
    } finally {
      jest.restoreAllMocks();
    }
  }
);
