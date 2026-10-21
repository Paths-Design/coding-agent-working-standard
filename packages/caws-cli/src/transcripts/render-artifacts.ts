/** Complete owned artifact preparation. These values never authorize publication. */
import { createHash } from 'node:crypto';
import { codepointTextFromString, encodeUtf8Strict, isCodepointText } from './codepoint-text';
import { isJsonObject } from './lossless-json';
import {
  compactRendererWhitespace,
  extractRendererHeuristicFields,
  type RenderTurn,
} from './render-accumulator';
import {
  isRenderObject,
  isRenderText,
  renderAdd,
  renderEntries,
  renderEqual,
  renderGet,
  renderInteger,
  renderIsNumeric,
  renderJsonBytes,
  renderObject,
  renderSet,
  renderTextEqual,
  renderTextLength,
  renderTextOrder,
  renderTruthy,
  type RenderObject,
  type RenderText,
  type RenderValue,
} from './render-values';

export interface PreparedSessionArtifact {
  readonly name: string;
  readonly role: 'turn' | 'spill' | 'index';
  readonly byteLength: number;
  readonly sha256: string;
  /** A fresh owned copy on every call; mutation cannot change the prepared generation. */
  bytes(): Uint8Array;
}
const issued = new WeakSet<object>();
export function isPreparedSessionArtifact(value: unknown): value is PreparedSessionArtifact {
  return value !== null && typeof value === 'object' && issued.has(value);
}
function artifact(
  name: string,
  role: PreparedSessionArtifact['role'],
  bytes: Uint8Array
): PreparedSessionArtifact {
  const owned = Buffer.from(bytes);
  const result: PreparedSessionArtifact = Object.freeze({
    name,
    role,
    byteLength: owned.length,
    sha256: createHash('sha256').update(owned).digest('hex'),
    bytes: () => Uint8Array.from(owned),
  });
  issued.add(result);
  return result;
}
function uniqueSorted(values: readonly RenderText[]): readonly RenderText[] {
  const unique: RenderText[] = [];
  for (const value of values)
    if (!unique.some((item) => renderTextEqual(item, value))) unique.push(value);
  return unique.sort(renderTextOrder);
}
function textField(value: RenderValue | undefined): RenderText | null {
  return isRenderText(value) ? value : null;
}
function record(
  value: RenderValue | undefined
): value is RenderObject | import('./lossless-json').JsonObject {
  return isRenderObject(value) || isJsonObject(value);
}
function addModel(models: RenderText[], value: RenderValue | undefined): void {
  if (
    isRenderText(value) &&
    renderTextLength(value) &&
    !models.some((model) => renderTextEqual(model, value))
  )
    models.push(value);
}
export interface PreparedSubagentLink {
  readonly toolUseId: string;
  readonly value: RenderObject;
}

export function buildRendererTurnPayload(
  turn: RenderTurn,
  number: number,
  context: RenderObject,
  turnNumbers: ReadonlyMap<RenderTurn, number>,
  links: readonly PreparedSubagentLink[] = []
): RenderObject {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new RangeError('Turn number must be positive and exact');
  const reasoning = turn.timeline.filter((item) => renderGet(item, 'kind') === 'reasoning');
  const heuristic = extractRendererHeuristicFields(
    reasoning.map((item) => {
      const text = renderGet(item, 'text');
      if (!isRenderText(text)) throw new TypeError('Reasoning text must be text');
      return text;
    })
  );
  let summary: RenderText | null = null;
  for (const item of [...reasoning].reverse()) {
    const value = renderGet(item, 'text');
    if (!isRenderText(value)) throw new TypeError('Reasoning text must be text');
    const compact = compactRendererWhitespace(value, 260);
    if (renderTextLength(compact) >= 80) {
      summary = compact;
      break;
    }
  }
  let endedInError = false;
  for (const item of [...turn.timeline].reverse()) {
    if (
      renderGet(item, 'kind') === 'tool_call' &&
      renderEntries(item).some(([key]) => renderEqual(key, 'is_error'))
    ) {
      endedInError = renderTruthy(renderGet(item, 'is_error'));
      break;
    }
  }
  const timestamps: RenderText[] = [];
  if (turn.user_ts) timestamps.push(turn.user_ts);
  for (const item of turn.timeline) {
    for (const key of ['ts', 'result_ts']) {
      const value = renderGet(item, key);
      if (renderTruthy(value)) {
        if (!isRenderText(value)) throw new TypeError('Timeline timestamp must be text');
        timestamps.push(value);
      }
    }
  }
  for (const item of [...turn.hook_contexts, ...turn.interjections]) {
    const value = renderGet(item, 'ts');
    if (renderTruthy(value)) {
      if (!isRenderText(value)) throw new TypeError('Context timestamp must be text');
      timestamps.push(value);
    }
  }
  timestamps.sort(renderTextOrder);
  const blocked = turn.hook_contexts.some((item) =>
    ['block', 'ask'].some((status) => renderEqual(renderGet(item, 'status'), status))
  );
  const agents = turn.agent_runs.map((agent) => {
    const id = renderGet(agent, 'id');
    const linkage = links.find((link) => renderEqual(id, link.toolUseId));
    return linkage ? renderSet(agent, 'subagent', linkage.value) : agent;
  });
  const refs = renderObject([
    [
      'files',
      renderObject([
        ['edited', uniqueSorted(turn.edited_files)],
        ['read', uniqueSorted(turn.read_files)],
      ]),
    ],
    ['searches', turn.searches],
    ['commands', turn.commands],
    ['agents', agents],
    ['artifacts', turn.artifacts],
  ]);
  let result = renderObject([
    ['schema_version', renderInteger(2)],
    ['turn', renderInteger(number)],
    ['context', context],
    [
      'payloads_sidecar',
      turn.payload_spill.size ? `turn-${String(number).padStart(3, '0')}.payloads.json` : null,
    ],
    ['payloads_sha256', [...turn.payload_spill.keys()].sort()],
    ['ts_start', timestamps[0] ?? null],
    ['ts_end', timestamps[timestamps.length - 1] ?? null],
    ['user', turn.user],
    ['user_ts', turn.user_ts],
    ['turn_summary', summary],
    [
      'status',
      turn.rewound
        ? 'rewound'
        : endedInError
          ? 'error'
          : renderTruthy(heuristic.blocking_issue) || blocked
            ? 'blocked'
            : 'ok',
    ],
    ['ended_by', turn.ended_by ?? null],
    ['decisions', heuristic.decisions],
    ['next_action', heuristic.next_action],
    ['blocking_issue', heuristic.blocking_issue],
    ['refs', refs],
    ['hook_contexts', turn.hook_contexts],
    ['interjections', turn.interjections],
    ['timeline', turn.timeline],
  ]);
  for (const [key, value] of [
    ['usage', turn.usage],
    ['models', turn.models],
    ['stop_reason', turn.stop_reason],
    ['env', turn.env],
  ] as const)
    if (renderTruthy(value)) result = renderSet(result, key, value);
  if (turn.rewound_from_turn) {
    const prior = turnNumbers.get(turn.rewound_from_turn);
    if (prior !== undefined) {
      result = renderSet(result, 'rewound_from', renderInteger(prior));
      result = renderSet(result, 'rewind_kind', turn.rewind_kind ?? null);
    }
  }
  return result;
}

export function buildRendererSessionIndex(
  payloads: readonly RenderObject[],
  context: RenderObject
): RenderObject {
  let title: RenderText | null = null,
    usage = renderObject();
  const models: RenderText[] = [],
    timestamps: RenderText[] = [];
  for (const payload of payloads) {
    const timeline = renderGet(payload, 'timeline');
    if (Array.isArray(timeline))
      for (const item of timeline) {
        if (
          renderGet(item, 'kind') === 'control' &&
          renderGet(item, 'subtype') === 'session_title'
        ) {
          const value = textField(renderGet(item, 'text'));
          if (
            value !== null &&
            renderTextLength(compactRendererWhitespace(value, Number.MAX_SAFE_INTEGER))
          )
            title = value;
        }
      }
    const contribution = renderGet(payload, 'usage');
    if (record(contribution))
      for (const [key, value] of renderEntries(contribution)) {
        if (!renderIsNumeric(value)) continue;
        const prior = renderGet(usage, key) ?? renderInteger(0);
        if (!renderIsNumeric(prior)) throw new TypeError('Accumulated usage must be numeric');
        usage = renderSet(usage, key, renderAdd(prior, value));
      }
    const suppliedModels = renderGet(payload, 'models');
    if (Array.isArray(suppliedModels)) for (const value of suppliedModels) addModel(models, value);
    addModel(models, renderGet(renderGet(payload, 'env'), 'model'));
    for (const key of ['ts_start', 'ts_end']) {
      const value = renderGet(payload, key);
      if (isRenderText(value)) timestamps.push(value);
    }
  }
  timestamps.sort(renderTextOrder);
  let result = renderObject([
    ['schema_version', renderInteger(1)],
    ['session_id', renderGet(context, 'session_id') ?? null],
    ['project', renderGet(context, 'project') ?? null],
    ['turn_count', renderInteger(payloads.length)],
    ['ts_start', timestamps[0] ?? null],
    ['ts_end', timestamps[timestamps.length - 1] ?? null],
    ['branch', renderGet(context, 'branch') ?? null],
    ['head_sha', renderGet(context, 'head_sha') ?? null],
  ]);
  if (renderTruthy(title)) result = renderSet(result, 'title', title);
  if (models.length) {
    result = renderSet(result, 'models', models);
    result = renderSet(result, 'model', models[0]!);
  }
  if (renderTruthy(usage)) result = renderSet(result, 'usage', usage);
  return result;
}

export interface PreparedRendererArtifacts {
  readonly artifacts: readonly PreparedSessionArtifact[];
  readonly turnPayloads: readonly RenderObject[];
  readonly index: RenderObject;
}
function assertSpillReference(
  reference: RenderValue | undefined,
  spill: ReadonlyMap<string, RenderText>
): void {
  if (reference === undefined) return;
  const digest = renderGet(reference, 'sha256'),
    length = renderGet(reference, 'length');
  if (!record(reference) || typeof digest !== 'string' || !spill.has(digest))
    throw new TypeError('Turn references an unavailable sibling spill payload');
  const text = spill.get(digest)!;
  if (!renderEqual(length, renderInteger(renderTextLength(text))))
    throw new TypeError('Spill reference length disagrees with its payload');
}
function assertSpillClosure(payload: RenderObject, spill: ReadonlyMap<string, RenderText>): void {
  // buildRendererTurnPayload carries accumulator-issued references at these
  // timeline coordinates. Nested source values (including tool input and refs
  // indexes) can contain external *_ref data and are not renderer spill links.
  const timeline = renderGet(payload, 'timeline');
  if (!Array.isArray(timeline)) throw new TypeError('Renderer timeline must be an array');
  for (const item of timeline) {
    const kind = renderGet(item, 'kind');
    const fields: string[] = [];
    if (kind === 'reasoning') fields.push('text_ref');
    else if (kind === 'audit_action') fields.push('input_ref', 'response_ref');
    else if (kind === 'tool_call') {
      fields.push('output_ref');
      const originalName = renderGet(item, 'name');
      const name =
        renderGet(item, 'source_harness') === 'codex' && typeof originalName === 'string'
          ? originalName.slice(originalName.lastIndexOf('.') + 1)
          : originalName;
      if (name === 'Edit') fields.push('old_string_ref', 'new_string_ref');
      else if (name === 'Write') fields.push('content_ref');
      else if (name === 'Agent' || name === 'Task') fields.push('prompt_ref');
      else if (name === 'ExitPlanMode') fields.push('plan_ref');
    }
    for (const field of fields) assertSpillReference(renderGet(item, field), spill);
  }
}
/** Encodes and checks the entire generation before exposing any ready artifact. */
export function prepareRendererArtifacts(
  turns: readonly RenderTurn[],
  context: RenderObject,
  links: readonly PreparedSubagentLink[] = []
): PreparedRendererArtifacts {
  const numbers = new Map(turns.map((turn, index) => [turn, index + 1] as const));
  const payloads = turns.map((turn, index) =>
    buildRendererTurnPayload(turn, index + 1, context, numbers, links)
  );
  const artifacts: PreparedSessionArtifact[] = [];
  for (const [index, turn] of turns.entries()) {
    const stem = `turn-${String(index + 1).padStart(3, '0')}`;
    assertSpillClosure(payloads[index]!, turn.payload_spill);
    if (turn.payload_spill.size) {
      for (const [digest, text] of turn.payload_spill) {
        const encoded = encodeUtf8Strict(
          isCodepointText(text) ? text : codepointTextFromString(text, 'renderer-spill')
        );
        if (!encoded.ok) throw new TypeError('Spill payload cannot be encoded as strict UTF8');
        if (createHash('sha256').update(encoded.value).digest('hex') !== digest)
          throw new TypeError('Spill payload digest does not match its content');
      }
      const spill = renderObject([...turn.payload_spill.entries()]);
      artifacts.push(
        artifact(
          `${stem}.payloads.json`,
          'spill',
          renderJsonBytes(spill, { indent: 2, ensureAscii: false, sortKeys: true })
        )
      );
    }
    artifacts.push(
      artifact(
        `${stem}.json`,
        'turn',
        renderJsonBytes(payloads[index]!, { indent: 2, ensureAscii: true })
      )
    );
  }
  const index = buildRendererSessionIndex(payloads, context);
  artifacts.push(
    artifact(
      'session-index.json',
      'index',
      renderJsonBytes(index, { indent: 2, ensureAscii: false })
    )
  );
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    turnPayloads: Object.freeze(payloads),
    index,
  });
}
