const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { consumeCommittedSession } = require('../../dist/runtime/committed-session-reader');
const {
  readCommittedSessionLog,
  createSessionLogPublicationConsumer,
} = require('../../dist/runtime/session-log');
const { getMember } = require('../../dist/transcripts/lossless-json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-session-log-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(entries) {
  const directory = path.join(root, '.caws/sessions/session-one');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const correlation = {
    id: 'original',
    runtimeDigest: 'a'.repeat(64),
    token: 'token',
    attempt: 'native-attempt',
  };
  const artifacts = entries
    .map(([name, role, json]) => {
      const bytes = Buffer.from(json);
      fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
      return { name, role, byteLength: bytes.length, sha256: sha(bytes) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const selection = {
    canonicalRoot: root,
    sessionId: 'session-one',
    correlation,
    terminalDigest: sha(JSON.stringify([correlation, 'published', artifacts])),
    artifacts,
  };
  fs.writeFileSync(
    path.join(directory, '.session-publication.json'),
    JSON.stringify({
      schema: 'caws.session.publication.v1',
      ...selection,
    }),
    { mode: 0o600 }
  );
  return { selection, correlation };
}

test('ordinary log consumer uses exact seven counts, model order and unrelated metadata including 4300 digits', async () => {
  const huge = '9'.repeat(4300);
  const counts = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cached_input_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  const usage =
    '{' +
    counts
      .map((name, index) => JSON.stringify(name) + ':' + (index === 0 ? huge : String(index)))
      .join(',') +
    '}';
  const metadata =
    '{ "unrelated":{"exact":9007199254740993},"models":["z-model","a-model"],"usage":' +
    usage +
    '}';
  const turn = '{"schema_version":2,"user":"semantic log text","usage":' + usage + '}';
  const { selection, correlation } = fixture([
    ['.meta.json', 'metadata', metadata],
    ['session-index.json', 'index', '{"session_id":"session-one","turn_count":1}'],
    ['store-projection.jsonl', 'projection', '{"event":"original source"}\n'],
    ['turn-001.json', 'turn', turn],
    ['turn-001.payloads.json', 'spill', '{"hash":"original payload"}'],
  ]);
  let actual;
  const ordinary = createSessionLogPublicationConsumer({
    published: async (log) => {
      actual = log;
    },
    notPublished: async () => {
      throw Error('not a published log');
    },
  });
  await consumeCommittedSession(
    selection,
    { signal: new globalThis.AbortController().signal, deadlineEpochMs: Date.now() + 5000 },
    async (session) =>
      ordinary({
        status: 'published',
        correlation,
        session,
        receipt: {
          status: 'published',
          terminalDigest: selection.terminalDigest,
          artifacts: selection.artifacts,
        },
      })
  );
  expect(actual.metadata.json).toBe(metadata);
  expect(actual.turns[0].json).toBe(turn);
  expect(getMember(actual.turns[0].value, 'user')).toBe('semantic log text');
  expect(getMember(actual.metadata.value, 'models')).toEqual(['z-model', 'a-model']);
  expect(getMember(getMember(actual.metadata.value, 'unrelated'), 'exact').lexeme).toBe(
    '9007199254740993'
  );
  for (const [index, name] of counts.entries())
    expect(getMember(getMember(actual.metadata.value, 'usage'), name).lexeme).toBe(
      index === 0 ? huge : String(index)
    );
  expect(actual.spills[0].json).toBe('{"hash":"original payload"}');
  expect(actual.projectionJsonl).toBe('{"event":"original source"}\n');
});

test('receipt-shaped objects cannot substitute for a committed read', () => {
  expect(() => readCommittedSessionLog({ artifacts: [], bytes: () => Buffer.from('{}') })).toThrow(
    'Unvalidated'
  );
});

test('non-publication remains a separate consumed failure outcome', async () => {
  const published = jest.fn(),
    notPublished = jest.fn(async () => {});
  const consumer = createSessionLogPublicationConsumer({ published, notPublished });
  const outcome = {
    status: 'not_published',
    correlation: {},
    receipt: { status: 'not_published', artifacts: [] },
  };
  await consumer(outcome);
  expect(notPublished).toHaveBeenCalledWith(outcome);
  expect(published).not.toHaveBeenCalled();
});

test.each(['foreign-index', 'invalid-utf8', 'deep'])(
  'ordinary %s log bytes cannot yield consumer success',
  async (kind) => {
    const json =
      kind === 'foreign-index'
        ? '{"session_id":"foreign"}'
        : kind === 'deep'
          ? '{"nested":' + '['.repeat(129) + '0' + ']'.repeat(129) + '}'
          : Buffer.from([0xff]);
    const { selection } = fixture([
      [
        kind === 'foreign-index' ? 'session-index.json' : '.meta.json',
        kind === 'foreign-index' ? 'index' : 'metadata',
        json,
      ],
    ]);
    await expect(
      consumeCommittedSession(
        selection,
        { signal: new globalThis.AbortController().signal, deadlineEpochMs: Date.now() + 5000 },
        (session) => readCommittedSessionLog(session)
      )
    ).rejects.toThrow();
  }
);
