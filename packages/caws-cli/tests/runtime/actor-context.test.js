const { actorContext, ingressActorContext } = require('../../dist/runtime/actor-context');

// The JSON texts are the ingress contract; tests/hooks/heartbeat-actor-custody.test.js
// feeds the same rows to the shell heartbeat and requires the same custody decision.
const ROWS = require('../hooks/actor-context-rows.json');

test.each(ROWS)('ingress $label', ({ json, expected }) => {
  expect(ingressActorContext(json)).toBe(expected);
});

test('the contract table covers every class and the present-but-invalid ids', () => {
  const classes = new Set(ROWS.map((row) => row.expected));
  expect([...classes].sort()).toEqual(['main', 'subagent', 'uncertain']);
  const invalidIds = ROWS.filter(
    (row) => row.object && row.expected === 'uncertain' && row.json.includes('"agent_id"')
  );
  expect(invalidIds.map((row) => row.label)).toHaveLength(11);
});

test('values outside a JSON object are uncertain, never main', () => {
  for (const value of [undefined, null, [], ['agent_id'], 'agent_id', 7, true])
    expect(actorContext(value)).toBe('uncertain');
});

// The runtime admits empty hook input as payload {}; only the original text decides.
test('absent or empty original input is uncertain even though its normalized payload is {}', () => {
  expect(actorContext({})).toBe('main');
  expect(ingressActorContext('')).toBe('uncertain');
  expect(ingressActorContext(undefined)).toBe('uncertain');
  expect(ingressActorContext('{}')).toBe('main');
});
