const {
  prepareCapturedSessionSeal,
  inspectCommittedSessionSeal,
} = require('../../dist/runtime/session-seal-runtime');
const { parsePythonJson, getMember } = require('../../dist/transcripts/lossless-json');
const counts = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cached_input_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];
function input(entries, changes = {}) {
  return {
    kind: 'seal',
    sessionId: 'original-session',
    observationId: 'native-observation',
    inputDigest: 'a'.repeat(64),
    reason: 'native reason',
    endedAt: '2026-10-23T06:00:00Z',
    files: entries.map(([name, role]) => ({ name, role })),
    priorInventory: [],
    bytes: (name) => Buffer.from(entries.find(([candidate]) => candidate === name)[2]),
    ...changes,
  };
}
function preparedJson(prepared) {
  expect(prepared.disposition).toBe('ready');
  expect(prepared.artifacts.map(({ name, role }) => ({ name, role }))).toEqual([
    { name: '.meta.json', role: 'metadata' },
  ]);
  expect(prepared.removals).toEqual([]);
  return Buffer.from(prepared.artifacts[0].bytes).toString();
}

test('captured ASCII turn order, seven exact counts, independent models and unrelated metadata are preserved', () => {
  const huge = '9'.repeat(4300);
  const usage = (value) =>
    '{' + counts.map((key) => JSON.stringify(key) + ':' + value).join(',') + '}';
  const prepared = prepareCapturedSessionSeal(
    input([
      [
        'turn-002.json',
        'turn',
        '{"schema_version":2,"models":["later","first"],"usage":' + usage('2') + '}',
      ],
      [
        '.meta.json',
        'metadata',
        '{"unrelated":{"exact":9007199254740993},"models":["historical"]}',
      ],
      [
        'turn-001.json',
        'turn',
        '{"schema_version":2,"models":["first","separate"],"usage":' + usage(huge) + '}',
      ],
    ])
  );
  const raw = preparedJson(prepared),
    value = parsePythonJson(raw);
  expect(prepared.summaryMode).toBe('recomputed');
  expect(getMember(value, 'models')).toEqual(['first', 'separate', 'later']);
  for (const key of counts)
    expect(getMember(getMember(value, 'usage'), key).lexeme).toBe((BigInt(huge) + 2n).toString());
  expect(getMember(getMember(value, 'unrelated'), 'exact').lexeme).toBe('9007199254740993');
  expect(getMember(getMember(value, 'ended'), 'reason')).toBe('native reason');
  expect(getMember(getMember(value, 'ended'), 'ts')).toBe('2026-10-23T06:00:00Z');
  const observed = inspectCommittedSessionSeal({ metadata: { json: raw, value } });
  expect(observed.metadataJson).toBe(raw);
  expect(observed.models).toEqual(['first', 'separate', 'later']);
  for (const key of counts)
    expect(getMember(observed.usage, key).lexeme).toBe((BigInt(huge) + 2n).toString());
});

test.each([{ turns: [] }, { turns: [['turn-001.json', 'turn', '{"schema_version":2}']] }])(
  'no-contribution seal explicitly preserves historical summaries %#',
  ({ turns }) => {
    const raw = preparedJson(
      prepareCapturedSessionSeal(
        input([
          [
            '.meta.json',
            'metadata',
            '{"usage":{"legacy":9007199254740993},"models":["z","a"],"keep":true}',
          ],
          ...turns,
        ])
      )
    );
    const value = parsePythonJson(raw);
    expect(getMember(getMember(value, 'usage'), 'legacy').lexeme).toBe('9007199254740993');
    expect(getMember(value, 'models')).toEqual(['z', 'a']);
    expect(getMember(getMember(value, 'summary_provenance'), 'mode')).toBe('preserved');
    expect(getMember(value, 'keep')).toBe(true);
  }
);

test('missing metadata is a definite no-publication preparation, never fabricated success', () => {
  expect(prepareCapturedSessionSeal(input([]))).toEqual({
    disposition: 'aborted',
    diagnostic: 'missing_metadata: SessionEnd has no metadata to seal',
  });
});

test.each([
  { entries: [['.meta.json', 'metadata', '{']] },
  { entries: [['.meta.json', 'metadata', Buffer.from([0xff])]] },
  {
    entries: [
      ['.meta.json', 'metadata', '{}'],
      ['turn-001.json', 'turn', '{"schema_version":2,"usage":{"input_tokens":-1}}'],
    ],
  },
  {
    entries: [
      ['.meta.json', 'metadata', '{}'],
      ['turn-001.json', 'turn', '{}'],
    ],
  },
])('malformed captured metadata or turn refuses without output artifacts %#', ({ entries }) => {
  const prepared = prepareCapturedSessionSeal(input(entries));
  expect(prepared.disposition).toBe('aborted');
  expect(prepared).not.toHaveProperty('artifacts');
});
