/**
 * Historical OpenCode translation declarations; deliberately no row adapter.
 * The Python owner's reconstruction comments do not establish an available DB
 * reader. Acquisition, filtering, dispatch and execution remain caller-owned.
 */
import {
  getMember,
  isJsonObject,
  isJsonNumber,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from './lossless-json';

export const OPENCODE_SURFACE_REVISION =
  'native-opencode-surface/1;python-sha256:4a1499d1e16991998565c0376f3944e915b8ec5f016f3cae11a7ac11ffdcb612';

/** Null prototypes keep hostile coordinates distinct from declared entries. */
function declarations<T extends object>(entries: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, entries));
}

export const OPENCODE_TOOL_NAME_MAP = declarations({
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  task: 'Agent',
  skill: 'Skill',
  todowrite: 'TodoWrite',
} as const);
export type OpencodeToolName = keyof typeof OPENCODE_TOOL_NAME_MAP;
export type OpencodeMappedToolName = (typeof OPENCODE_TOOL_NAME_MAP)[OpencodeToolName];

/** Undeclared coordinates have no translation; this supplies no fallback. */
export function getOpencodeToolName(tool: string): OpencodeMappedToolName | undefined {
  return Object.prototype.hasOwnProperty.call(OPENCODE_TOOL_NAME_MAP, tool)
    ? OPENCODE_TOOL_NAME_MAP[tool as OpencodeToolName]
    : undefined;
}

export type OpencodeInputMapper = (input: JsonObject) => JsonObject;
export class OpencodeInputError extends Error {
  readonly pythonType = 'AttributeError' as const;
  constructor(pythonInputType: string) {
    super(`'${pythonInputType}' object has no attribute 'get'`);
    this.name = 'OpencodeInputError';
  }
}
function requireObject(input: unknown): asserts input is JsonObject {
  if (isJsonObject(input)) return;
  // Constructed lossless scalars/lists reproduce the private Python operation's
  // failure; they are outside its declared dict input contract. This does not
  // establish admission by an unlocated reconstruction consumer.
  if (input === null) throw new OpencodeInputError('NoneType');
  if (typeof input === 'boolean') throw new OpencodeInputError('bool');
  if (typeof input === 'string') throw new OpencodeInputError('str');
  if (Array.isArray(input)) throw new OpencodeInputError('list');
  if (isJsonNumber(input))
    throw new OpencodeInputError(input.numberKind === 'integer' ? 'int' : 'float');
  throw new TypeError('OpenCode input mapper requires a transcript JSON object');
}
function mapper(fields: readonly (readonly [string, string])[]): OpencodeInputMapper {
  return Object.freeze((input: JsonObject): JsonObject => {
    requireObject(input);
    return jsonObject(
      fields.map(([source, target]): readonly [string, JsonValue] => {
        const value = getMember(input, source);
        return [target, value === undefined ? '' : value];
      })
    );
  });
}
const searchInput = mapper([
  ['pattern', 'pattern'],
  ['path', 'path'],
]);
export const OPENCODE_INPUT_MAPPERS = declarations({
  edit: mapper([
    ['filePath', 'file_path'],
    ['oldString', 'old_string'],
    ['newString', 'new_string'],
  ]),
  write: mapper([
    ['filePath', 'file_path'],
    ['content', 'content'],
  ]),
  read: mapper([['filePath', 'file_path']]),
  bash: mapper([
    ['command', 'command'],
    ['description', 'description'],
  ]),
  grep: searchInput,
  glob: searchInput,
  task: mapper([
    ['prompt', 'prompt'],
    ['subagent_type', 'subagent_type'],
    ['description', 'description'],
  ]),
  skill: mapper([
    ['name', 'skill'],
    ['args', 'args'],
  ]),
});
export type OpencodeInputToolName = keyof typeof OPENCODE_INPUT_MAPPERS;

/** A translated tool (todowrite) need not have an input mapper. */
export function mapOpencodeInput(tool: string, input: JsonObject): JsonObject | undefined {
  return Object.prototype.hasOwnProperty.call(OPENCODE_INPUT_MAPPERS, tool)
    ? OPENCODE_INPUT_MAPPERS[tool as OpencodeInputToolName](input)
    : undefined;
}

export const OPENCODE_NOISE_PREFIXES = Object.freeze([
  'The following tool was executed by the user',
  '[Sterling context-authority',
  '<system-reminder>',
] as const);

/** Labels and tool names confer no operational authority. */
export const OPENCODE_SURFACE = Object.freeze({
  name: 'opencode' as const,
  revision: OPENCODE_SURFACE_REVISION,
  adapters: Object.freeze([] as const),
  noisePrefixes: OPENCODE_NOISE_PREFIXES,
});
