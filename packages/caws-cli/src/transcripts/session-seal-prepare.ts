/** Pure SessionEnd metadata preparation. Prepared JSON grants no publication authority. */
import { parseJsonSource, type JsonSource } from '../runtime/json-custody';

export const SESSION_USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cached_input_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

/** Bounds are UTF16 code units at this string API, not decoded file byte limits. */
export const SESSION_SEAL_LIMITS = Object.freeze({
  maxMetadataCodeUnits: 1_048_576,
  maxTurnCodeUnits: 1_048_576,
  maxTotalCodeUnits: 8_388_608,
  maxTurns: 1024,
  maxDepth: 64,
  maxNodes: 100_000,
  maxCountDigits: 8192,
  maxArithmeticWork: 8_388_608,
  maxModels: 2048,
  maxModelCodeUnits: 4096,
  maxOutputCodeUnits: 2_097_152,
});
export type SessionSealLimits = { readonly [K in keyof typeof SESSION_SEAL_LIMITS]: number };
export interface SessionSealRequest {
  readonly metadataJson: string;
  /** Strictly increasing ASCII turn filenames, as captured by the native owner. */
  readonly turns: readonly { readonly name: string; readonly json: string }[];
  readonly reason: string;
  readonly timestamp: string;
  readonly limits: SessionSealLimits;
}
type SummaryReason = 'turns_contributed' | 'zero_turns' | 'no_contributions';
export type SessionSealPreparation =
  | Readonly<{
      kind: 'ready';
      metadataJson: string;
      summaryMode: 'recomputed' | 'preserved';
      summaryReason: SummaryReason;
    }>
  | Readonly<{
      kind: 'unavailable';
      code: 'invalid_request' | 'invalid_json' | 'invalid_count' | 'resource_limit';
      reason: string;
    }>;
type Node = JsonSource['root'];
type ObjectNode = Extract<Node, { kind: 'object' }>;
class Refusal extends Error {
  constructor(
    readonly code: Extract<SessionSealPreparation, { kind: 'unavailable' }>['code'],
    reason: string
  ) {
    super(reason);
  }
}
function refuse(code: Refusal['code'], reason: string): never {
  throw new Refusal(code, reason);
}
function object(node: Node | undefined, label: string): ObjectNode {
  if (node?.kind !== 'object') return refuse('invalid_json', label);
  return node;
}

export function prepareSessionSeal(request: SessionSealRequest): SessionSealPreparation {
  try {
    const limits = {} as { -readonly [K in keyof SessionSealLimits]: number };
    for (const key of Object.keys(SESSION_SEAL_LIMITS) as (keyof SessionSealLimits)[]) {
      const value = request?.limits?.[key];
      if (!Number.isSafeInteger(value) || value < 0 || value > SESSION_SEAL_LIMITS[key])
        refuse('invalid_request', 'invalid finite limit');
      limits[key] = value;
    }
    if (
      typeof request.metadataJson !== 'string' ||
      !Array.isArray(request.turns) ||
      typeof request.reason !== 'string' ||
      !request.reason.length ||
      request.reason.length > 1024 ||
      typeof request.timestamp !== 'string' ||
      !request.timestamp.length ||
      request.timestamp.length > 1024
    )
      refuse('invalid_request', 'invalid preparation input');
    if (request.turns.length > limits.maxTurns) refuse('resource_limit', 'turn count');
    let total = 0;
    let work = 0;
    const spend = (amount: number): void => {
      if (amount > limits.maxArithmeticWork - work) refuse('resource_limit', 'arithmetic work');
      work += amount;
    };
    const read = (text: string, bound: number): JsonSource => {
      if (typeof text !== 'string') return refuse('invalid_request', 'invalid JSON input');
      if (text.length > bound || text.length > limits.maxTotalCodeUnits - total)
        refuse('resource_limit', 'input code units');
      total += text.length;
      // Bound the grammar parser's temporary tree before JSON.parse allocates it.
      // A valid JSON tree has at most one key token per value node; the exact
      // indexed-node and scalar-depth checks remain in parseJsonSource below.
      let quoted = false;
      let escaped = false;
      let bare = false;
      let depth = 0;
      let tokens = 0;
      for (const char of text) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') {
          quoted = true;
          bare = false;
          tokens++;
        } else if (char === '{' || char === '[') {
          if (++depth > limits.maxDepth + 1) refuse('resource_limit', 'JSON structure');
          bare = false;
          tokens++;
        } else if (char === '}' || char === ']') {
          if (depth-- === 0) refuse('invalid_json', 'unmatched JSON delimiter');
          bare = false;
        } else if (char === ':' || char === ',' || /[ \t\r\n]/.test(char)) bare = false;
        else if (!bare) {
          bare = true;
          tokens++;
        }
        if (tokens > limits.maxNodes * 2) refuse('resource_limit', 'JSON structure');
      }
      try {
        return parseJsonSource(text, limits.maxDepth, limits.maxNodes, true);
      } catch (error) {
        if (error instanceof Error && error.message === 'Hook input exceeds structural limit')
          return refuse('resource_limit', 'JSON structure');
        return refuse('invalid_json', 'invalid or duplicate-member JSON');
      }
    };
    const metadata = read(request.metadataJson, limits.maxMetadataCodeUnits);
    const root = object(metadata.root, 'metadata must be an object');
    const sums = new Map<string, string>();
    const models = new Set<string>();

    // Interpret decimal JSON numerals mathematically, without binary floating-point.
    const count = (token: string): string => {
      spend(token.length);
      const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
      if (!match) return refuse('invalid_count', 'count must be a JSON number');
      const fraction = match[3] ?? '';
      const digits = (match[2]! + fraction).replace(/^0+/, '');
      if (!digits) {
        if (limits.maxCountDigits < 1) refuse('resource_limit', 'count digits');
        return '0';
      }
      if (match[1]) return refuse('invalid_count', 'negative count');
      const exponentText = match[4] ?? '0';
      const exponentDigits = exponentText.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
      if (exponentDigits.length > 6) return refuse('resource_limit', 'numeric expansion');
      const shift = Number(exponentText) - fraction.length;
      let result: string;
      if (shift >= 0) {
        if (digits.length + shift > limits.maxCountDigits)
          return refuse('resource_limit', 'count digits');
        spend(digits.length + shift);
        result = digits + '0'.repeat(shift);
      } else {
        const remove = -shift;
        if (remove >= digits.length || !/^0*$/.test(digits.slice(-remove)))
          return refuse('invalid_count', 'fractional count');
        result = digits.slice(0, -remove);
        if (result.length > limits.maxCountDigits) refuse('resource_limit', 'count digits');
      }
      return result;
    };
    let previous = '';
    for (const turn of request.turns) {
      if (
        !turn ||
        typeof turn.name !== 'string' ||
        turn.name.length > 128 ||
        !/^turn-[0-9]{3,}\.json$/.test(turn.name) ||
        turn.name <= previous
      )
        refuse('invalid_request', 'turn filenames must be unique and ordered');
      previous = turn.name;
      const source = read(turn.json, limits.maxTurnCodeUnits);
      const value = object(source.root, 'turn must be an object');
      const version = value.entries.get('schema_version');
      if (version?.kind !== 'number' || source.text.slice(version.start, version.end) !== '2')
        refuse('invalid_json', 'expected turn schema version 2');
      const usage = value.entries.get('usage');
      if (usage !== undefined) {
        const fields = object(usage, 'usage must be an object');
        for (const name of SESSION_USAGE_FIELDS) {
          const node = fields.entries.get(name);
          if (node === undefined) continue;
          if (node.kind !== 'number') refuse('invalid_count', 'count must be numeric');
          const contribution = count(source.text.slice(node.start, node.end));
          const prior = sums.get(name);
          if (prior === undefined) sums.set(name, contribution);
          else {
            spend(prior.length + contribution.length);
            const sum = (BigInt(prior) + BigInt(contribution)).toString();
            if (sum.length > limits.maxCountDigits) refuse('resource_limit', 'sum digits');
            sums.set(name, sum);
          }
        }
      }
      const recordedModels = value.entries.get('models');
      if (recordedModels !== undefined) {
        if (recordedModels.kind !== 'array') refuse('invalid_json', 'models must be an array');
        for (const node of recordedModels.items) {
          if (node.kind !== 'scalar' || typeof node.value !== 'string')
            refuse('invalid_json', 'model must be a string');
          if (node.value.length > limits.maxModelCodeUnits)
            refuse('resource_limit', 'model length');
          if (!models.has(node.value)) {
            if (models.size >= limits.maxModels) refuse('resource_limit', 'model count');
            models.add(node.value);
          }
        }
      }
    }
    const recomputed = sums.size > 0 || models.size > 0;
    const summaryMode = recomputed ? 'recomputed' : 'preserved';
    const summaryReason: SummaryReason = recomputed
      ? 'turns_contributed'
      : request.turns.length === 0
        ? 'zero_turns'
        : 'no_contributions';
    const entries: string[] = [];
    let outputLength = 2;
    const append = (key: string, raw: string): void => {
      const name = JSON.stringify(key);
      const size = name.length + 1 + raw.length + (entries.length ? 1 : 0);
      if (size > limits.maxOutputCodeUnits - outputLength)
        refuse('resource_limit', 'output code units');
      outputLength += size;
      entries.push(name + ':' + raw);
    };
    for (const [key, node] of root.entries) {
      if (
        key === 'ended' ||
        key === 'summary_provenance' ||
        (recomputed && (key === 'usage' || key === 'models'))
      )
        continue;
      append(key, metadata.text.slice(node.start, node.end));
    }
    append('ended', JSON.stringify({ reason: request.reason, ts: request.timestamp }));
    if (recomputed) {
      if (sums.size)
        append(
          'usage',
          '{' + [...sums].map(([key, value]) => JSON.stringify(key) + ':' + value).join(',') + '}'
        );
      if (models.size) append('models', JSON.stringify([...models]));
    }
    append('summary_provenance', JSON.stringify({ mode: summaryMode, reason: summaryReason }));
    return Object.freeze({
      kind: 'ready',
      metadataJson: '{' + entries.join(',') + '}',
      summaryMode,
      summaryReason,
    });
  } catch (error) {
    return Object.freeze({
      kind: 'unavailable',
      code: error instanceof Refusal ? error.code : 'invalid_request',
      reason: error instanceof Refusal ? error.message : 'unavailable preparation input',
    });
  }
}
