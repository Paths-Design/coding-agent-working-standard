'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  CAWS_READ_COMMANDS,
  isCawsLiteralExecutable,
  isCawsReadInvocation,
} = require('../../dist/shell/analysis/caws-read-metadata.js');

// These are explicit consumer scenarios, not examples generated from the catalog
// being tested. A route, effect, operand or dependency drift must change a verdict.
const read = (...args) => isCawsReadInvocation(['caws', ...args]);

describe('closed CAWS read metadata', () => {
  test.each(['caws', '/caws', '/usr/local/bin/caws', '/opt/reviewed tools/caws'])(
    'accepts literal executable syntax %s under trusted lookup',
    (value) => expect(isCawsLiteralExecutable(value)).toBe(true)
  );

  test.each([
    undefined,
    '',
    'CAWS',
    'caws-extra',
    './caws',
    '../caws',
    'bin/caws',
    '/bin/caws-extra',
    '/bin/caws/',
    '//caws',
    '/bin//caws',
    '/./caws',
    '/bin/../caws',
    '/bin/./caws',
    '/bin/\ncaws',
    '/bin/\0/caws',
    '/bin/\x7f/caws',
  ])('rejects ambiguous executable syntax %p', (value) => {
    expect(isCawsLiteralExecutable(value)).toBe(false);
    expect(isCawsReadInvocation([value, 'status'])).toBe(false);
  });

  test.each(
    [
      [],
      ['__proto__'],
      ['constructor'],
      ['toString'],
      ['specs', '__proto__'],
      ['specs', 'show-extra', 'EXAMPLE-001'],
      ['specs', 'close', 'EXAMPLE-001'],
      ['message', 'poll'],
      ['gates', 'run', '--spec', 'EXAMPLE-001'],
      ['reprieve', 'grant', '--for', '1h'],
      ['worktree', 'merge', 'example'],
      ['evidence', 'record', '--type', 'test', '--spec', 'EXAMPLE-001'],
      ['status', '--unknown'],
      ['--help'],
    ].map((args) => [args])
  )('declines unreviewed route or option %j', (args) => {
    expect(read(...args)).toBe(false);
  });

  test.each(
    [
      ['status'],
      ['status', '--short', '--json'],
      ['working-tree', 'check', '--json'],
      ['goal', 'show'],
      ['message', 'inbox', '--all', '--limit', '0'],
      ['message', 'history', '--with', 'session-1'],
      ['message', 'status', 'message-1'],
      ['reprieve', 'show', '--session', 'session-1'],
      ['reprieve', 'list'],
      ['agents', 'list', '--include-stale'],
      ['agents', 'show', 'session-1'],
      ['events', 'list', '--limit', '2'],
      ['events', 'show', '1'],
      ['events', 'verify-archive'],
      ['waiver', 'list'],
      ['waiver', 'show', 'waiver-1'],
      ['gates', 'list', '--spec', 'EXAMPLE-001'],
      ['gates', 'explain', 'scope'],
      ['evidence', 'list', '--spec', 'EXAMPLE-001'],
      ['evidence', 'show', '1'],
      ['evidence', 'schema', '--type', 'test'],
      ['scope', 'show', 'src/a b.ts'],
      ['scope', 'check', 'src/a.ts', '--spec', 'EXAMPLE-001'],
      ['scope', 'plan', '--path', 'src/a.ts', '--path', 'src/b.ts'],
      ['scope', 'plan', '--paths-file', 'paths.json'],
      ['scope', 'contention', 'src/a.ts'],
      ['worktree', 'list', '--json'],
      ['worktree', 'review', 'example'],
      ['doctor'],
      ['doctor', '--repair-plan', '--json'],
      ['specs'],
      ['specs', '--status', 'draft'],
      ['specs', 'list', '--archived'],
      ['specs', 'show', 'EXAMPLE-001', '--archived'],
      ['specs', 'recover', 'EXAMPLE-001'],
      ['specs', 'validate', 'spec.yaml'],
      ['specs', 'verify-acs', 'EXAMPLE-001', '--strict'],
    ].map((args) => [args])
  )('admits reviewed consumer %j', (args) => {
    expect(read(...args)).toBe(true);
  });

  test.each(
    [
      ['status', 'extra'],
      ['status', '-'],
      ['status', '--', '--json'],
      ['status', '--short=true'],
      ['status', '--short', '--short'],
      ['status', '-hh'],
      ['status', '--help', '-h'],
      ['specs', 'show'],
      ['specs', 'show', 'EXAMPLE-001', 'EXTRA-002'],
      ['message', 'inbox', '--limit'],
      ['message', 'inbox', '--limit='],
      ['message', 'inbox', '--limit', '--json'],
      ['message', 'inbox', '--limit', '1', '--limit=2'],
      ['message', 'inbox', '--json=false'],
      ['message', 'inbox', '--limit1'],
      ['scope', 'plan', '--paths-file', 'a', '--paths-file', 'b'],
      ['specs', 'show', '--', '--archived'],
    ].map((args) => [args])
  )('rejects invalid arity, duplication or flag shape %j', (args) => {
    expect(read(...args)).toBe(false);
  });

  test.each(
    [
      ['status', '-h'],
      ['status', '--help'],
      ['message', 'inbox', '--limit=2'],
      ['specs', 'show', '--', 'EXAMPLE-001'],
      ['scope', 'check', '--', '--json'],
      ['scope', 'check', '-'],
    ].map((args) => [args])
  )('preserves aliases, equals operands and positional boundary %j', (args) => {
    expect(read(...args)).toBe(true);
  });

  test.each(
    [
      ['specs', 'recover', 'EXAMPLE-001', '--out', 'body.yaml'],
      ['specs', 'recover', 'EXAMPLE-001', '--out=body.yaml'],
      ['specs', 'verify-acs', 'EXAMPLE-001', '--run'],
    ].map((args) => [args])
  )('declines reviewed commands when an option writes or executes %j', (args) => {
    expect(read(...args)).toBe(false);
  });

  test.each(['A-1', 'EXAMPLE-001', 'A1-B2-003abc'])('accepts spec identity %s', (value) =>
    expect(read('specs', 'show', value)).toBe(true)
  );
  test.each(['example-001', 'EXAMPLE', 'EXAMPLE-001A', '1A-001', 'A--001', '', 'A-1\n'])(
    'refuses malformed spec identity %p',
    (value) => expect(read('specs', 'show', value)).toBe(false)
  );
  test.each(['session-1', 'a.b:c_0', '0'])('accepts endpoint identity %s', (value) =>
    expect(read('agents', 'show', value)).toBe(true)
  );
  test.each(['', '-session', '_session', 'session/name', 'session name', 'session\x7f'])(
    'refuses malformed endpoint identity %p',
    (value) => expect(read('agents', 'show', value)).toBe(false)
  );
  test.each(['0', '0002', '9007199254740991'])('accepts exact nonnegative integer %s', (value) =>
    expect(read('events', 'list', '--limit', value)).toBe(true)
  );
  test.each(['-1', '1.0', '1e2', ' 2', '2 ', 'NaN', '9007199254740992', '2\0'])(
    'refuses unsafe or noninteger operand %p',
    (value) => expect(read('events', 'list', '--limit', value)).toBe(false)
  );
  test.each(['0s', '1h30m', '1hr', '2d', '9007199254740s'])(
    'accepts finite millisecond duration %s',
    (value) => expect(read('agents', 'list', '--stale-ttl', value)).toBe(true)
  );
  test.each(['30', '1w', '-1s', '1.5h', '1h-tail', '9007199254741s', '1s\n'])(
    'refuses invalid or unsafe duration %p',
    (value) => expect(read('agents', 'list', '--stale-ttl', value)).toBe(false)
  );
  test.each(['1', '999', 'deadbeef', 'sha256:' + 'a'.repeat(64), 'latest-rotation'])(
    'accepts event reference %s',
    (value) => expect(read('events', 'show', value)).toBe(true)
  );
  test.each([
    '0',
    'deadbee',
    'A'.repeat(64),
    'a'.repeat(65),
    'sha256:xyz',
    'latest',
    'latest-rotation\n',
  ])('refuses malformed event reference %p', (value) =>
    expect(read('events', 'show', value)).toBe(false)
  );
  test.each(['test', 'gate', 'ac', 'human_decision'])(
    'accepts reviewed evidence kind %s',
    (value) => expect(read('evidence', 'schema', '--type', value)).toBe(true)
  );
  test.each(['', 'Test', 'human-decision', 'unknown', 'test\n'])(
    'refuses unreviewed evidence kind %p',
    (value) => expect(read('evidence', 'schema', '--type', value)).toBe(false)
  );
  test.each(['active', 'draft', 'closed', 'archived'])(
    'accepts lifecycle selection %s',
    (value) => {
      expect(read('specs', '--status', value)).toBe(true);
      expect(read('specs', 'list', '--lifecycle', value)).toBe(true);
      expect(read('specs', 'list', '--state', value)).toBe(true);
    }
  );
  test.each(['unknown', 'ACTIVE', 'active,closed'])(
    'refuses undeclared lifecycle selection %s',
    (value) => expect(read('specs', 'list', '--status', value)).toBe(false)
  );
  test.each(['pytest', 'jest', 'node', 'bats', 'vitest', 'cargo', 'go'])(
    'admits runner selection without admitting execution %s',
    (value) => {
      expect(read('specs', 'verify-acs', 'EXAMPLE-001', '--runner', value)).toBe(true);
      expect(read('specs', 'verify-acs', 'EXAMPLE-001', '--runner', value, '--run')).toBe(false);
    }
  );
  test.each(['unknown', 'shell', 'Jest'])('refuses detection-only or unknown runner %s', (value) =>
    expect(read('specs', 'verify-acs', 'EXAMPLE-001', '--runner', value)).toBe(false)
  );

  test.each(
    [
      ['evidence', 'list'],
      ['evidence', 'schema'],
      ['message', 'history'],
      ['message', 'status'],
      ['scope', 'plan'],
      ['doctor', '--json'],
      ['message', 'status', '--mine'],
      ['message', 'status', '--queued'],
      ['message', 'status', 'message-1', '--id', 'message-2'],
      ['message', 'status', 'message-1', '--mine', '--queued'],
      ['message', 'status', 'message-1', '--older-than', '1h'],
      ['message', 'status', 'message-1', '--older-than-ms', '1'],
      ['message', 'status', '--mine', '--queued', '--older-than', '1h', '--older-than-ms', '1'],
      ['reprieve', 'show', '--current', '--session', 'session-1'],
      ['agents', 'list', '--stale-ttl', '1h', '--stale-ttl-ms', '1'],
      ['agents', 'show', 'session-1', '--stale-ttl', '1h', '--stale-ttl-ms', '1'],
      ['specs', 'list', '--status', 'active', '--draft'],
      ['specs', 'list', '--state', 'draft', '--lifecycle', 'draft'],
    ].map((args) => [args])
  )('refuses unsatisfied requirements or incompatible selections %j', (args) => {
    expect(read(...args)).toBe(false);
  });

  test.each(
    [
      ['message', 'status', '--id', 'message-1'],
      ['message', 'status', '--mine', '--queued'],
      ['message', 'status', '--mine', '--queued', '--older-than', '1h'],
      ['message', 'status', '--mine', '--queued', '--older-than-ms', '0'],
      ['scope', 'plan', '--path', 'a', '--paths-file', 'b'],
      ['scope', 'show', 'caf\u00e9/hello world.ts'],
    ].map((args) => [args])
  )('admits satisfied requirements and literal data %j', (args) => {
    expect(read(...args)).toBe(true);
  });

  test.each(['', 'line\nbreak', 'tab\tname', 'nul\0name', 'delete\x7f'])(
    'refuses control or empty literal data %p',
    (value) => expect(read('scope', 'show', value)).toBe(false)
  );

  test('future declarations require explicit read effects, visible exact arity and a known operand role', () => {
    const options = CAWS_READ_COMMANDS.status.options;
    const future = { flag: '--future-count <n>', valueRole: 'integer' };
    options.push(future);
    try {
      expect(read('status', '--future-count', '3')).toBe(false);
      future.effect = 'read';
      expect(read('status', '--future-count', '3')).toBe(true);
      expect(read('status', '--future-count')).toBe(false);
      expect(read('status', '--future-count', 'three')).toBe(false);
      future.hidden = true;
      expect(read('status', '--future-count', '3')).toBe(false);
      delete future.hidden;
      for (const effect of ['write', 'execute']) {
        future.effect = effect;
        expect(read('status', '--future-count', '3')).toBe(false);
      }
      future.effect = 'read';
      delete future.valueRole;
      expect(read('status', '--future-count', '3')).toBe(false);
      future.valueRole = 'integer';
      for (const flag of [
        '--future-count [n]',
        '--future-count <n> <extra>',
        '--future-count <n...>',
      ]) {
        future.flag = flag;
        expect(read('status', '--future-count', '3')).toBe(false);
      }
    } finally {
      options.pop();
    }
  });

  test('leaf effects cannot inherit read authority from their options', () => {
    const leaf = CAWS_READ_COMMANDS.status;
    const previous = leaf.effect;
    try {
      for (const effect of [undefined, 'write', 'execute']) {
        leaf.effect = effect;
        expect(read('status', '--short')).toBe(false);
      }
    } finally {
      leaf.effect = previous;
    }
    expect(read('status', '--short')).toBe(true);
  });
});

test('compiled parser consumer preserves CAWS metadata admission without executing submitted source', () => {
  const activeMutant = String(
    globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
  );
  const requests = [
    ['caws specs show EXAMPLE-001 --archived', 0],
    ['caws scope check "src/a b.ts" --spec EXAMPLE-001 --json', 0],
    ['caws specs recover EXAMPLE-001 --out body.yaml', 1],
    ['caws specs verify-acs EXAMPLE-001 --run', 1],
    ['caws specs show', 1],
    ['caws status --short; caws status', 1],
  ];
  const script = String.raw`
    const fs = require('node:fs');
    process.env.__STRYKER_ACTIVE_MUTANT__ = process.argv[2];
    const { classifyInspectionPrefix } = require(process.argv[1]);
    (async () => {
      const results = [];
      for (const [source] of JSON.parse(fs.readFileSync(0, 'utf8'))) {
        results.push(await classifyInspectionPrefix(source));
      }
      process.stdout.write(JSON.stringify({activeMutant:process.env.__STRYKER_ACTIVE_MUTANT__,results}));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      script,
      path.resolve(__dirname, '../../dist/shell/analysis/inspection-prefix.js'),
      activeMutant,
    ],
    {
      input: JSON.stringify(requests),
      encoding: 'utf8',
      shell: false,
      timeout: 10000,
      env: { PATH: path.dirname(process.execPath), __STRYKER_ACTIVE_MUTANT__: activeMutant },
    }
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(JSON.parse(child.stdout)).toEqual({
    activeMutant,
    results: requests.map(([, status]) => status),
  });
});
