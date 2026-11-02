import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseJsonSource } from '../../src/runtime/json-custody';
import {
  prepareSessionSeal,
  SESSION_SEAL_LIMITS,
  SESSION_USAGE_FIELDS,
  type SessionSealRequest,
  type SessionSealLimits,
} from '../../src/transcripts/session-seal-prepare';

function request(
  turns: readonly string[] = [],
  metadataJson = '{}',
  limits: Partial<SessionSealLimits> = {}
): SessionSealRequest {
  return {
    metadataJson,
    turns: turns.map((json, index) => ({
      name: `turn-${String(index + 1).padStart(3, '0')}.json`,
      json,
    })),
    reason: 'logout',
    timestamp: '2026-10-22T14:00:00Z',
    limits: { ...SESSION_SEAL_LIMITS, ...limits },
  };
}
function ready(input: SessionSealRequest) {
  const result = prepareSessionSeal(input);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('expected ready result');
  return result;
}
function unavailable(input: SessionSealRequest, code: string) {
  const result = prepareSessionSeal(input);
  assert.equal(result.kind, 'unavailable');
  if (result.kind !== 'unavailable') throw new Error('expected unavailable result');
  assert.equal(result.code, code);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'kind', 'reason']);
}
function turn(extra: string): string {
  return '{"schema_version":2,' + extra + '}';
}
function valueToken(text: string, key: string): string | undefined {
  const source = parseJsonSource(text, 64, 100_000, true);
  assert.equal(source.root.kind, 'object');
  if (source.root.kind !== 'object') throw new Error('expected object');
  const node = source.root.entries.get(key);
  return node ? text.slice(node.start, node.end) : undefined;
}

test('sums all seven independent counts exactly and preserves ordered top-level models', () => {
  const a = SESSION_USAGE_FIELDS.map((key, index) => JSON.stringify(key) + ':' + (index + 1));
  const b = SESSION_USAGE_FIELDS.map((key, index) => JSON.stringify(key) + ':' + (index + 11));
  const result = ready(
    request([
      turn('"usage":{' + a.join(',') + '},"models":["b","a","b"]'),
      turn('"usage":{' + b.join(',') + '},"models":["a","c"]'),
    ])
  );
  const parsed = JSON.parse(result.metadataJson) as Record<string, unknown>;
  assert.deepEqual(
    parsed.usage,
    Object.fromEntries(SESSION_USAGE_FIELDS.map((key, i) => [key, 12 + i * 2]))
  );
  assert.deepEqual(parsed.models, ['b', 'a', 'c']);
  assert.deepEqual(parsed.ended, { reason: 'logout', ts: '2026-10-22T14:00:00Z' });
  assert.deepEqual(parsed.summary_provenance, { mode: 'recomputed', reason: 'turns_contributed' });
});
test('retains a 4300-digit count and carries addition beyond binary numeric range', () => {
  const huge = '9'.repeat(4300);
  const result = ready(
    request([turn('"usage":{"input_tokens":' + huge + '}'), turn('"usage":{"input_tokens":1}')])
  );
  assert.equal(
    valueToken(valueToken(result.metadataJson, 'usage')!, 'input_tokens'),
    '1' + '0'.repeat(4300)
  );
  assert.equal(valueToken(valueToken(result.metadataJson, 'usage')!, 'output_tokens'), undefined);
});
test('interprets finite mathematical integers without rounding decimal or exponent notation', () => {
  const values = ['1.20e1', '100e-2', '0.001e3', '-0', '0e999999999999999999999'];
  const result = ready(
    request(values.map((value) => turn('"usage":{"total_tokens":' + value + '}')))
  );
  assert.equal(valueToken(result.metadataJson, 'usage'), '{"total_tokens":14}');
});
test('recomputes from contributions without inventing missing counts or legacy aliases', () => {
  const result = ready(
    request(
      [turn('"usage":{"output_tokens":0,"input":99},"models":["m"]')],
      '{"usage":{"input":500,"input_tokens":800},"models":["historical"]}'
    )
  );
  assert.equal(valueToken(result.metadataJson, 'usage'), '{"output_tokens":0}');
  assert.equal(valueToken(result.metadataJson, 'models'), '["m"]');
});
test('models-only contributions replace summaries without fabricating usage zeros', () => {
  const result = ready(request([turn('"models":["m"]')], '{"usage":{"total_tokens":9}}'));
  assert.equal(valueToken(result.metadataJson, 'usage'), undefined);
  assert.equal(valueToken(result.metadataJson, 'models'), '["m"]');
});
for (const [name, turns, reason] of [
  ['zero turns', [], 'zero_turns'],
  ['no contributions', [turn('"usage":{},"models":[]')], 'no_contributions'],
] as const)
  test('preserves historical summaries with explicit provenance: ' + name, () => {
    const metadata =
      '{"usage": { "total_tokens": 1.00e999 },"models": ["old"],"ended":{"reason":"old","ts":"old"}}';
    const result = ready(request(turns, metadata));
    assert.equal(valueToken(result.metadataJson, 'usage'), valueToken(metadata, 'usage'));
    assert.equal(valueToken(result.metadataJson, 'models'), valueToken(metadata, 'models'));
    assert.equal(result.summaryMode, 'preserved');
    assert.equal(result.summaryReason, reason);
    assert.equal(
      valueToken(result.metadataJson, 'ended'),
      '{"reason":"logout","ts":"2026-10-22T14:00:00Z"}'
    );
  });
test('forwards unrelated metadata value tokens exactly, including huge numbers and escapes', () => {
  const metadata =
    '{"n":90071992547409931234567890,"nested": { "n": 1e999, "x": "\\u0061" },"s":"\\ud800"}';
  const result = ready(request([turn('"usage":{"input_tokens":1}')], metadata));
  for (const key of ['n', 'nested', 's'])
    assert.equal(valueToken(result.metadataJson, key), valueToken(metadata, key));
});
for (const numeral of ['-1', '1.1', '1e-1', 'true', 'null', '"1"'])
  test('refuses an invalid count without partial output: ' + numeral, () => {
    unavailable(request([turn('"usage":{"input_tokens":' + numeral + '}')]), 'invalid_count');
  });
for (const json of [
  '{"schema_version":2,"usage":{"input_tokens":1,"input_tokens":2}}',
  '{"schema_version":2,"models":[1]}',
  '{"schema_version":2,"models":null}',
  '{"schema_version":1}',
  '{"schema_version":2,"usage":null}',
  '{"schema_version":2,"extra":{"a":1,"a":2}}',
  '{"schema_version":2,}',
  '[]',
])
  test('refuses duplicate, malformed or wrong-shaped input: ' + json, () => {
    unavailable(request([json]), 'invalid_json');
  });
test('rejects duplicate decoded metadata keys and duplicate or out-of-order turn names', () => {
  unavailable(request([], '{"a":1,"\\u0061":2}'), 'invalid_json');
  const base = request([turn('"models":[]'), turn('"models":[]')]);
  unavailable({ ...base, turns: [base.turns[0]!, base.turns[0]!] }, 'invalid_request');
  unavailable({ ...base, turns: [...base.turns].reverse() }, 'invalid_request');
});
for (const [limit, value, turns, metadata] of [
  ['maxMetadataCodeUnits', 1, [], '{}'],
  ['maxTurnCodeUnits', 1, [turn('"models":[]')], '{}'],
  ['maxTotalCodeUnits', 3, [turn('"models":[]')], '{}'],
  ['maxTurns', 0, [turn('"models":[]')], '{}'],
  ['maxDepth', 0, [turn('"usage":{"input_tokens":1}')], '{}'],
  ['maxNodes', 0, [], '{}'],
  [
    'maxCountDigits',
    1,
    [turn('"usage":{"input_tokens":9}'), turn('"usage":{"input_tokens":1}')],
    '{}',
  ],
  ['maxArithmeticWork', 0, [turn('"usage":{"input_tokens":1}')], '{}'],
  ['maxModels', 0, [turn('"models":["m"]')], '{}'],
  ['maxModelCodeUnits', 0, [turn('"models":["m"]')], '{}'],
  ['maxOutputCodeUnits', 0, [], '{}'],
] as const)
  test('refuses exhausted ' + limit + ' before returning metadata', () => {
    unavailable(request(turns, metadata, { [limit]: value }), 'resource_limit');
  });
test('refuses hostile exponent expansion before allocating expanded digits', () => {
  for (const numeral of ['1e99999999999999999999', '1e999999', '1e-999999999999'])
    unavailable(request([turn('"usage":{"input_tokens":' + numeral + '}')]), 'resource_limit');
});
test('rejects nonfinite or over-hard-limit resource settings', () => {
  for (const value of [NaN, Infinity, -1, SESSION_SEAL_LIMITS.maxTurns + 1])
    unavailable(request([], '{}', { maxTurns: value }), 'invalid_request');
});
const retainedTurn = process.env.CAWS_SESSION_SEAL_RETAINED_TURN;
test('structural preflight ignores quoted delimiters and rejects deep or wide trees', () => {
  const metadata = '{"quoted":"[ { \\" } ]","nested":{}}';
  const result = ready(request([], metadata));
  assert.equal(valueToken(result.metadataJson, 'quoted'), valueToken(metadata, 'quoted'));
  unavailable(
    request([], '{"x":' + '['.repeat(200) + '0' + ']'.repeat(200) + '}', { maxDepth: 4 }),
    'resource_limit'
  );
  unavailable(request([], '{"x":[' + '0,'.repeat(1000) + '0]}', { maxNodes: 4 }), 'resource_limit');
});
test('output budget admits the exact boundary and refuses one unit less', () => {
  const first = ready(request());
  assert.equal(
    ready(request([], '{}', { maxOutputCodeUnits: first.metadataJson.length })).metadataJson,
    first.metadataJson
  );
  unavailable(
    request([], '{}', { maxOutputCodeUnits: first.metadataJson.length - 1 }),
    'resource_limit'
  );
});
test('preserved historical models remain exact even when repeated', () => {
  const result = ready(request([], '{"models": ["m", "m"]}'));
  assert.equal(valueToken(result.metadataJson, 'models'), '["m", "m"]');
});
test('preserved historical fractions remain exact while new fractional counts refuse', () => {
  const result = ready(request([], '{"usage": {"input_tokens":0.5}}'));
  assert.equal(valueToken(result.metadataJson, 'usage'), '{"input_tokens":0.5}');
  assert.equal(result.summaryMode, 'preserved');
  unavailable(request([turn('"usage":{"input_tokens":0.5}')]), 'invalid_count');
});
test('accepts mathematical version-two spellings admitted by the governing schema', () => {
  for (const version of ['2', '2.0', '2e0', '20e-1']) {
    const result = ready(
      request(['{"schema_version":' + version + ',"usage":{"input_tokens":1}}'])
    );
    assert.equal(valueToken(result.metadataJson, 'usage'), '{"input_tokens":1}');
  }
});
test('retained real turn-v2 4300-digit regression', { skip: !retainedTurn }, () => {
  assert.equal(typeof retainedTurn, 'string');
  const fixture = retainedTurn!;
  const json = readFileSync(fixture, 'utf8');
  const result = ready(request([json]));
  const sourceUsage = valueToken(json, 'usage')!;
  const input = valueToken(sourceUsage, 'input_tokens')!;
  assert.equal(input.length, 4300);
  assert.equal(valueToken(valueToken(result.metadataJson, 'usage')!, 'input_tokens'), input);
});
