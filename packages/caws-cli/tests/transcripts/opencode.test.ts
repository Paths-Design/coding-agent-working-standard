import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENCODE_INPUT_MAPPERS,
  OPENCODE_NOISE_PREFIXES,
  OPENCODE_SURFACE,
  OPENCODE_SURFACE_REVISION,
  OPENCODE_TOOL_NAME_MAP,
  OpencodeInputError,
  getOpencodeToolName,
  mapOpencodeInput,
  type OpencodeInputToolName,
} from '../../src/transcripts/harness-opencode';
import {
  getMember,
  isJsonObject,
  jsonNumber,
  jsonObject,
  parsePythonJson,
  pythonJsonDumps,
  type JsonObject,
  type JsonValue,
} from '../../src/transcripts/lossless-json';

function input(source: string): JsonObject {
  const value = parsePythonJson(source);
  assert.ok(isJsonObject(value));
  return value;
}
function mapped(tool: string, source: JsonObject): JsonObject {
  const result = mapOpencodeInput(tool, source);
  assert.ok(result !== undefined, `expected declared mapper: ${tool}`);
  return result;
}

// These dict fixtures follow the source owner's explicit field selection and
// dict.get(key, '') semantics; they do not exercise any reconstruction reader.
const examples: readonly (readonly [OpencodeInputToolName, string, string])[] = [
  [
    'edit',
    '{"filePath":"路径/😀","oldString":"old","newString":"new","extra":1}',
    '{"file_path":"路径/😀","old_string":"old","new_string":"new"}',
  ],
  [
    'write',
    '{"content":"α\\nβ","filePath":"a","extra":"omit"}',
    '{"file_path":"a","content":"α\\nβ"}',
  ],
  ['read', '{"filePath":"a","offset":9,"limit":3}', '{"file_path":"a"}'],
  [
    'bash',
    '{"description":"explain","command":"echo Ω","timeout":4}',
    '{"command":"echo Ω","description":"explain"}',
  ],
  ['grep', '{"path":"src","pattern":"😀.*","include":"*.ts"}', '{"pattern":"😀.*","path":"src"}'],
  [
    'glob',
    '{"path":"src","pattern":"**/*.ts","extra":false}',
    '{"pattern":"**/*.ts","path":"src"}',
  ],
  [
    'task',
    '{"description":"summary","subagent_type":"explore","prompt":"inspect","extra":null}',
    '{"prompt":"inspect","subagent_type":"explore","description":"summary"}',
  ],
  ['skill', '{"args":"argument","name":"caws","extra":true}', '{"skill":"caws","args":"argument"}'],
];

// Explicit expectations keep source-coordinate/default drift observable without
// deriving the test oracle from the exported mapping declarations.
const defaults: readonly (readonly [OpencodeInputToolName, string])[] = [
  ['edit', '{"file_path":"","old_string":"","new_string":""}'],
  ['write', '{"file_path":"","content":""}'],
  ['read', '{"file_path":""}'],
  ['bash', '{"command":"","description":""}'],
  ['grep', '{"pattern":"","path":""}'],
  ['glob', '{"pattern":"","path":""}'],
  ['task', '{"prompt":"","subagent_type":"","description":""}'],
  ['skill', '{"skill":"","args":""}'],
];

test('declares exactly nine historical tool names, eight input mapper coordinates and three noise prefixes', () => {
  assert.deepEqual(Object.entries(OPENCODE_TOOL_NAME_MAP), [
    ['read', 'Read'],
    ['write', 'Write'],
    ['edit', 'Edit'],
    ['bash', 'Bash'],
    ['grep', 'Grep'],
    ['glob', 'Glob'],
    ['task', 'Agent'],
    ['skill', 'Skill'],
    ['todowrite', 'TodoWrite'],
  ]);
  assert.deepEqual(Object.keys(OPENCODE_INPUT_MAPPERS), [
    'edit',
    'write',
    'read',
    'bash',
    'grep',
    'glob',
    'task',
    'skill',
  ]);
  assert.equal(OPENCODE_INPUT_MAPPERS.grep, OPENCODE_INPUT_MAPPERS.glob);
  assert.deepEqual(OPENCODE_NOISE_PREFIXES, [
    'The following tool was executed by the user',
    '[Sterling context-authority',
    '<system-reminder>',
  ]);
  for (const [tool, translated] of Object.entries(OPENCODE_TOOL_NAME_MAP))
    assert.equal(getOpencodeToolName(tool), translated);
});

test('declares zero row adapters and binds only this historical component identity', () => {
  assert.equal(OPENCODE_SURFACE.name, 'opencode');
  assert.equal(OPENCODE_SURFACE.revision, OPENCODE_SURFACE_REVISION);
  assert.equal(
    OPENCODE_SURFACE_REVISION,
    'native-opencode-surface/1;python-sha256:4a1499d1e16991998565c0376f3944e915b8ec5f016f3cae11a7ac11ffdcb612'
  );
  assert.deepEqual(OPENCODE_SURFACE.adapters, []);
  assert.equal(OPENCODE_SURFACE.noisePrefixes, OPENCODE_NOISE_PREFIXES);
  assert.equal('matches' in OPENCODE_SURFACE, false);
  assert.equal('normalize' in OPENCODE_SURFACE, false);
});

test('projects exact values in declared output order and omits all unrelated fields', () => {
  for (const [tool, source, expected] of examples) {
    const original = input(source);
    const before = pythonJsonDumps(original);
    const result = mapped(tool, original);
    assert.deepEqual(result, parsePythonJson(expected), tool);
    assert.equal(pythonJsonDumps(original), before, tool);
    assert.notEqual(result, original);
  }
});

test('defaults only missing selected fields, including partial inputs and wrong-case source names', () => {
  for (const [tool, expected] of defaults)
    assert.deepEqual(mapped(tool, input('{}')), parsePythonJson(expected), tool);
  assert.deepEqual(
    mapped('edit', input('{"filePath":null,"oldString":false}')),
    input('{"file_path":null,"old_string":false,"new_string":""}')
  );
  assert.deepEqual(
    mapped('skill', input('{"Name":"wrong","ARGS":"wrong"}')),
    input('{"skill":"","args":""}')
  );
  assert.deepEqual(
    mapped('read', input('{"file_path":"already-translated"}')),
    input('{"file_path":""}')
  );
});

test('preserves explicit null, falsy scalars, unsafe integers, numeric kinds and nested Unicode values for every selected field', () => {
  const fields: readonly (readonly [
    OpencodeInputToolName,
    readonly string[],
    readonly string[],
  ])[] = [
    ['edit', ['filePath', 'oldString', 'newString'], ['file_path', 'old_string', 'new_string']],
    ['write', ['filePath', 'content'], ['file_path', 'content']],
    ['read', ['filePath'], ['file_path']],
    ['bash', ['command', 'description'], ['command', 'description']],
    ['grep', ['pattern', 'path'], ['pattern', 'path']],
    ['glob', ['pattern', 'path'], ['pattern', 'path']],
    [
      'task',
      ['prompt', 'subagent_type', 'description'],
      ['prompt', 'subagent_type', 'description'],
    ],
    ['skill', ['name', 'args'], ['skill', 'args']],
  ];
  for (const valueSource of [
    'null',
    'false',
    'true',
    '0',
    '-0',
    '0.0',
    '-0.0',
    '9007199254740993',
    '9007199254740993.0',
    '1e999',
    'NaN',
    'Infinity',
    '-Infinity',
    '""',
    '"\\u0000é😀\\ud800"',
    '[]',
    '{}',
    '{"__proto__":{"constructor":[null,false,0,9007199254740993,NaN,"😀"]},"é":["é"]}',
  ]) {
    const value = parsePythonJson(valueSource);
    for (const [tool, sourceFields, targetFields] of fields) {
      const original = jsonObject(sourceFields.map((field) => [field, value] as const));
      const before = pythonJsonDumps(original);
      const result = mapped(tool, original);
      assert.deepEqual(
        result.entries.map(([field]) => field),
        targetFields,
        tool
      );
      for (const target of targetFields)
        assert.deepEqual(getMember(result, target), value, `${tool}.${target}: ${valueSource}`);
      assert.equal(pythonJsonDumps(original), before, tool);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.entries), true);
      for (const entry of result.entries) assert.equal(Object.isFrozen(entry), true);
    }
  }
  const result = mapped('write', input('{"filePath":9007199254740993,"content":0.0}'));
  assert.deepEqual(getMember(result, 'file_path'), jsonNumber('9007199254740993'));
  assert.deepEqual(getMember(result, 'content'), jsonNumber('0.0'));
});

test('unknown, differently cased and prototype coordinates never acquire a mapper or tool translation', () => {
  for (const tool of [
    'question',
    '',
    'Read',
    'read ',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
  ]) {
    assert.equal(getOpencodeToolName(tool), undefined, tool);
    assert.equal(mapOpencodeInput(tool, input('{"filePath":"a"}')), undefined, tool);
    assert.equal(Object.prototype.hasOwnProperty.call(OPENCODE_TOOL_NAME_MAP, tool), false, tool);
    assert.equal(Object.prototype.hasOwnProperty.call(OPENCODE_INPUT_MAPPERS, tool), false, tool);
  }
  assert.equal(getOpencodeToolName('todowrite'), 'TodoWrite');
  assert.equal(mapOpencodeInput('todowrite', input('{"todos":[]}')), undefined);
  assert.equal(Object.getPrototypeOf(OPENCODE_TOOL_NAME_MAP), null);
  assert.equal(Object.getPrototypeOf(OPENCODE_INPUT_MAPPERS), null);
});

test('hostile input keys remain data and cannot supply undeclared selected fields', () => {
  const source = input(
    '{"__proto__":{"filePath":"forged"},"constructor":{"filePath":"forged"},"toString":"forged"}'
  );
  const before = pythonJsonDumps(source);
  for (const [tool, expected] of defaults)
    assert.deepEqual(mapped(tool, source), parsePythonJson(expected), tool);
  assert.equal(pythonJsonDumps(source), before);
  assert.deepEqual(
    mapped('read', input('{"__proto__":{},"filePath":"declared","constructor":false}')),
    input('{"file_path":"declared"}')
  );
});

test('freezes exported surface declarations and mapper function objects', () => {
  for (const declaration of [
    OPENCODE_TOOL_NAME_MAP,
    OPENCODE_INPUT_MAPPERS,
    OPENCODE_NOISE_PREFIXES,
    OPENCODE_SURFACE,
    OPENCODE_SURFACE.adapters,
  ]) {
    assert.equal(Object.isFrozen(declaration), true);
    assert.equal(Reflect.set(declaration, 'injected', 'value'), false);
  }
  for (const map of Object.values(OPENCODE_INPUT_MAPPERS)) {
    assert.equal(Object.isFrozen(map), true);
    assert.equal(Reflect.set(map, 'injected', true), false);
  }
  assert.equal(Reflect.set(OPENCODE_TOOL_NAME_MAP, 'read', 'Bash'), false);
  assert.equal(getOpencodeToolName('read'), 'Read');
  assert.equal(Reflect.set(OPENCODE_INPUT_MAPPERS, 'read', OPENCODE_INPUT_MAPPERS.bash), false);
  assert.deepEqual(mapped('read', input('{"filePath":"a"}')), input('{"file_path":"a"}'));
  assert.equal(Reflect.set(OPENCODE_NOISE_PREFIXES, '0', 'changed'), false);
  assert.equal(Reflect.set(OPENCODE_SURFACE.adapters, '0', {}), false);
});

test('constructed non-dict direct controls are refused outside the typed historical input contract', () => {
  // The Python functions annotate dict inputs and call .get; the unlocated
  // reconstruction consumer cannot establish ordinary admission for these.
  const controls: readonly (readonly [JsonValue, string])[] = [
    [null, 'NoneType'],
    [false, 'bool'],
    [true, 'bool'],
    ['', 'str'],
    ['😀', 'str'],
    [[], 'list'],
    [[jsonNumber('0')], 'list'],
    [jsonNumber('0'), 'int'],
    [jsonNumber('9007199254740993'), 'int'],
    [jsonNumber('0.0'), 'float'],
    [jsonNumber('NaN'), 'float'],
    [jsonNumber('Infinity'), 'float'],
  ];
  for (const [value, pythonType] of controls)
    for (const map of Object.values(OPENCODE_INPUT_MAPPERS))
      assert.throws(
        () => map(value as JsonObject),
        (error: unknown) => {
          assert.ok(error instanceof OpencodeInputError);
          assert.equal(error.pythonType, 'AttributeError');
          assert.equal(error.message, `'${pythonType}' object has no attribute 'get'`);
          return true;
        }
      );
});

test('raw JavaScript direct controls receive a separate native contract refusal', () => {
  // These values are not lossless JSON AST values and have no Python dict-input
  // parity claim. They cannot silently become empty historical input objects.
  for (const value of [undefined, 0, NaN, {}, { filePath: 'raw' }, () => null])
    assert.throws(() => OPENCODE_INPUT_MAPPERS.read(value as JsonObject), {
      name: 'TypeError',
      message: 'OpenCode input mapper requires a transcript JSON object',
    });
});
