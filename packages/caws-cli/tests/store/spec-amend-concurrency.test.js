'use strict';

// Exercise the compiled writers against real isolated repositories. Scheduling
// another complete writer just before lock acquisition makes the first plan
// stale without replacing either writer's validation, persistence, or audit.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const lock = require('../../dist/store/lifecycle-lock');
const { initProject } = require('../../dist/store/init-store');
const {
  createSpec,
  amendScopeSpec,
  closeSpec,
  recordSpecEvidence,
} = require('../../dist/store/specs-writer');
const { amendSpecBody } = require('../../dist/store/specs-body-writer');
const { readYamlSource, readYamlSourceBytes } = require('../../dist/store/yaml-store');
const { cleanupAll, makeTempRepo, git } = require('../helpers/git-repo-factory');

const ID = 'AMEND-RACE-001';
const ACTOR = { kind: 'agent', id: 'amender', session_id: 'amender', platform: 'test' };
const INPUT = { id: ID, actor: ACTOR, now: () => new Date('2026-10-26T12:00:00Z') };

afterEach(() => jest.restoreAllMocks());
afterAll(() => cleanupAll());

function success(result) {
  expect(result.ok).toBe(true);
  expect(result.value.kind).toBe('success');
}

function fixture() {
  const root = makeTempRepo();
  const cawsDir = path.join(root, '.caws');
  expect(initProject(root).ok).toBe(true);
  success(
    createSpec(cawsDir, {
      ...INPUT,
      title: 'Preserve concurrent authority',
      mode: 'chore',
      initialState: 'active',
      scopeIn: ['src/original.ts'],
      modules: ['amendment'],
      invariants: ['Preserve concurrent updates'],
      acceptance: [{ given: 'a plan', when: 'it changes', then: 'it is audited' }],
    })
  );
  return { root, cawsDir, target: path.join(cawsDir, 'specs', `${ID}.yaml`) };
}

function bytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function snapshot(f) {
  return {
    spec: bytes(f.target),
    events: bytes(path.join(f.cawsDir, 'events.jsonl')),
    head: git(f.root, ['rev-parse', 'HEAD']),
  };
}

function events(f) {
  return bytes(path.join(f.cawsDir, 'events.jsonl'))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function scheduleBeforeAcquire(change) {
  const acquire = lock.withLifecycleLock;
  jest.spyOn(lock, 'withLifecycleLock').mockImplementationOnce((...args) => {
    change();
    return acquire(...args);
  });
}

const AMENDERS = [
  ['scope', (f) => amendScopeSpec(f.cawsDir, { ...INPUT, addIn: ['src/requested.ts'] })],
  [
    'body',
    (f) => amendSpecBody(f.cawsDir, { ...INPUT, setAc: 'A1', acThen: 'the new requirement holds' }),
  ],
];

const COMPETITORS = [
  ['scope', (f) => amendScopeSpec(f.cawsDir, { ...INPUT, addOut: ['src/private.ts'] })],
  ['body', (f) => amendSpecBody(f.cawsDir, { ...INPUT, addInvariants: ['Concurrent invariant'] })],
  [
    'evidence',
    (f) =>
      recordSpecEvidence(f.cawsDir, {
        ...INPUT,
        criterionId: 'A1',
        status: 'pass',
        evidenceRef: 'concurrent verification',
      }),
  ],
  [
    'close',
    (f) =>
      closeSpec(f.cawsDir, {
        ...INPUT,
        resolution: 'completed',
        reason: 'Concurrent lifecycle closure',
      }),
  ],
];

describe.each(AMENDERS)('%s amendment freshness', (_kind, amend) => {
  test.each(COMPETITORS)('preserves the exact concurrent %s update and audit', (_name, change) => {
    const f = fixture();
    let concurrent;
    scheduleBeforeAcquire(() => {
      success(change(f));
      concurrent = snapshot(f);
    });
    const result = amend(f);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'store.lifecycle.plan_rejected', subject: ID }),
      ])
    );
    expect(snapshot(f)).toEqual(concurrent);
    expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
  });

  test('does not recreate a removed target', () => {
    const f = fixture();
    let concurrent;
    scheduleBeforeAcquire(() => {
      fs.unlinkSync(f.target);
      concurrent = snapshot(f);
    });
    const result = amend(f);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.lifecycle.plan_rejected');
    expect(snapshot(f)).toEqual(concurrent);
  });

  test('refuses an unreadable current source before any write or auto-commit', () => {
    const f = fixture();
    const before = snapshot(f);
    const read = fs.readFileSync;
    scheduleBeforeAcquire(() => {
      jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
        if (file === f.target)
          throw Object.assign(new Error('injected read failure'), { code: 'EACCES' });
        return read.call(fs, file, ...args);
      });
    });
    const result = amend(f);
    jest.restoreAllMocks();
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.lifecycle.plan_rejected');
    expect(snapshot(f)).toEqual(before);
    expect(fs.existsSync(path.join(f.cawsDir, 'state.lock'))).toBe(false);
  });

  test('compares bytes even when different invalid UTF-8 decodes to the same text', () => {
    const f = fixture();
    fs.appendFileSync(f.target, Buffer.from([35, 32, 0x80, 10]));
    let concurrent;
    scheduleBeforeAcquire(() => {
      const current = fs.readFileSync(f.target);
      current[current.length - 2] = 0x81;
      fs.writeFileSync(f.target, current);
      concurrent = snapshot(f);
    });
    const result = amend(f);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.lifecycle.plan_rejected');
    expect(snapshot(f)).toEqual(concurrent);
  });

  test('rejects replacement-character bytes substituted for an invalid source byte', () => {
    const f = fixture();
    fs.appendFileSync(f.target, Buffer.from([35, 32, 0x80, 10]));
    let concurrent;
    scheduleBeforeAcquire(() => {
      const current = fs.readFileSync(f.target);
      const replaced = Buffer.concat([
        current.subarray(0, current.length - 2),
        Buffer.from([0xef, 0xbf, 0xbd, 10]),
      ]);
      expect(replaced.equals(current)).toBe(false);
      expect(replaced.toString('utf8')).toBe(current.toString('utf8'));
      fs.writeFileSync(f.target, replaced);
      concurrent = snapshot(f);
    });
    const result = amend(f);
    expect(snapshot(f)).toEqual(concurrent);
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.lifecycle.plan_rejected');
  });

  test('permits unchanged source bytes with a decodable YAML comment', () => {
    const f = fixture();
    fs.appendFileSync(f.target, Buffer.from([35, 32, 0x80, 10]));
    const before = events(f).length;
    success(amend(f));
    expect(
      events(f)
        .slice(before)
        .map((e) => e.event)
    ).toEqual([_kind === 'scope' ? 'spec_scope_amended' : 'spec_body_amended']);
  });

  test('permits unchanged valid bytes and audits exactly the requested change', () => {
    const f = fixture();
    const before = events(f).length;
    success(amend(f));
    expect(
      events(f)
        .slice(before)
        .map((e) => e.event)
    ).toEqual([_kind === 'scope' ? 'spec_scope_amended' : 'spec_body_amended']);
    const spec = yaml.load(fs.readFileSync(f.target, 'utf8'));
    if (_kind === 'scope') expect(spec.scope.in).toEqual(['src/original.ts', 'src/requested.ts']);
    else expect(spec.acceptance[0].then).toBe('the new requirement holds');
  });

  test('a fresh retry preserves competing scope and applies the requested change', () => {
    const f = fixture();
    scheduleBeforeAcquire(() => success(COMPETITORS[0][1](f)));
    expect(amend(f).ok).toBe(false);
    success(amend(f));
    const spec = yaml.load(fs.readFileSync(f.target, 'utf8'));
    expect(spec.scope.out).toEqual(['src/private.ts']);
    if (_kind === 'scope') expect(spec.scope.in).toContain('src/requested.ts');
    else expect(spec.acceptance[0].then).toBe('the new requirement holds');
  });
});

test('retrying an acceptance edit resets the actual current evidence in the same audit', () => {
  const f = fixture();
  const amend = AMENDERS[1][1];
  scheduleBeforeAcquire(() => success(COMPETITORS[2][1](f)));
  expect(amend(f).ok).toBe(false);
  success(amend(f));
  const spec = yaml.load(fs.readFileSync(f.target, 'utf8'));
  expect(spec.acceptance[0].then).toBe('the new requirement holds');
  expect(spec.evidence[0]).toEqual(
    expect.objectContaining({ criterion_id: 'A1', status: 'unchecked' })
  );
  expect(events(f).at(-1).data.reset_evidence).toEqual([
    { criterion_id: 'A1', previous_status: 'pass' },
  ]);
});

test('the text reader preserves decoding while the raw reader retains exact bytes', () => {
  const f = fixture();
  const raw = Buffer.from([35, 32, 0x80, 10]);
  fs.writeFileSync(f.target, raw);
  expect(readYamlSourceBytes(f.target)).toEqual({ ok: true, value: raw });
  expect(readYamlSource(f.target)).toEqual({ ok: true, value: '# \ufffd\n' });
});

test.each([
  ['missing', 'store.read.missing_file'],
  ['directory', 'store.read.not_a_file'],
  ['unreadable', 'store.read.io_failed'],
])('both source readers retain the %s diagnostic', (kind, rule) => {
  const f = fixture();
  if (kind === 'missing') fs.unlinkSync(f.target);
  if (kind === 'directory') {
    fs.unlinkSync(f.target);
    fs.mkdirSync(f.target);
  }
  if (kind === 'unreadable') {
    const read = fs.readFileSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (file === f.target)
        throw Object.assign(new Error('injected read failure'), { code: 'EACCES' });
      return read.call(fs, file, ...args);
    });
  }
  const raw = readYamlSourceBytes(f.target);
  expect(raw.ok).toBe(false);
  expect(raw.errors[0]).toEqual(expect.objectContaining({ rule, subject: f.target }));
  expect(readYamlSource(f.target)).toEqual(raw);
});
