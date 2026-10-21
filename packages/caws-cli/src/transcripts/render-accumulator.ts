/** Pinned renderer accumulation. Inputs carry source custody; indexes confer no execution authority. */
import { createHash } from 'node:crypto';
import { codepointTextFromString, encodeUtf8Strict, isCodepointText } from './codepoint-text';
import { decodeStructuredTextPayload, parseTimestamp } from './harness-common';
import {
  snapshotTranscriptJsonProfile,
  type TranscriptJsonNumericProfile,
} from './transcript-json-profile';
import { isJsonNumber, isJsonObject, pythonStr, type JsonNumber } from './lossless-json';
import { isPythonWordCodepoint, UNICODE_PROFILE_ID } from './python-unicode-profile';
import { PYTHON_WHITESPACE_PATTERN } from './source-occurrence';
import type { PreparedRendererEvent } from './render-reader';
import {
  renderObject,
  renderGet,
  renderHas,
  renderSet,
  renderEntries,
  isRenderObject,
  renderInteger,
  renderTruthy,
  renderIsNumeric,
  renderAdd,
  renderEqual,
  renderJsonDumps,
  renderTextLength,
  renderTextSlice,
  renderTextEqual,
  renderTextStartsWith,
  renderTextStrip,
  renderTextConcat,
  renderTextContains,
  type RenderValue,
  type RenderObject,
  type RenderText,
} from './render-values';

export interface RenderTurn {
  user: RenderText | null;
  user_ts: string | null;
  payload_spill: Map<string, RenderText>;
  timeline: RenderObject[];
  hook_contexts: RenderObject[];
  interjections: RenderObject[];
  edited_files: RenderText[];
  read_files: RenderText[];
  searches: RenderObject[];
  commands: RenderObject[];
  agent_runs: RenderObject[];
  artifacts: RenderObject[];
  control_events: RenderObject[];
  usage: RenderObject;
  models: RenderText[];
  stop_reason: RenderText | null;
  env: RenderObject;
  ended_by?: 'user_interrupt_tool' | 'user_interrupt_generation';
  rewound?: boolean;
  rewound_from_turn?: RenderTurn;
  rewind_kind?: 'same_prompt' | 'edited_prompt';
}
/** Calendar interpretation and Python rounding belong to the explicitly selected caller port. */
export interface RendererDurationPort {
  readonly profileId: string;
  secondsBetween(first: string | null, second: string | null): JsonNumber | null;
}
export interface RendererAccumulationOptions {
  readonly noisePrefixes: readonly string[];
  readonly duration: RendererDurationPort;
  /** Absent only for historical standalone accumulation; preparation supplies its selected profile. */
  readonly numericProfile?: TranscriptJsonNumericProfile;
}
const object = (fields: Readonly<Record<string, RenderValue>>): RenderObject =>
  renderObject(Object.entries(fields));
const get = (
  value: RenderValue | undefined,
  key: string,
  fallback: RenderValue = null
): RenderValue => (renderGet(value, key) === undefined ? fallback : renderGet(value, key)!);
function text(value: RenderValue | undefined, fallback: RenderText = ''): RenderText {
  if (value === undefined) return fallback;
  if (typeof value === 'string' || isCodepointText(value)) return value;
  throw new TypeError('Renderer text operation requires text');
}
const orText = (value: RenderValue | undefined): RenderText =>
  text(renderTruthy(value) ? value : '');
const points = (value: RenderText): readonly number[] =>
  isCodepointText(value)
    ? value.codepoints
    : Array.from(value, (character) => character.codePointAt(0)!);
// One unit per source codepoint: regex capture offsets are slices of the original
// value, never a UTF-16 reconstruction of derived Python-literal text.
function mapped(value: RenderText): string {
  return points(value)
    .map((point) => (point > 0xffff ? '\ue000' : String.fromCharCode(point)))
    .join('');
}
// Python re.IGNORECASE adds these four Unicode characters to ASCII letter
// matching. Fold only the keyword-search view; original captures remain intact.
function keywordMapped(value: RenderText): string {
  return mapped(value).replace(/[A-Z\u0130\u0131\u017f\u212a]/g, (character) => {
    if (character === '\u0130' || character === '\u0131') return 'i';
    if (character === '\u017f') return 's';
    if (character === '\u212a') return 'k';
    return character.toLowerCase();
  });
}
const whitespace = new RegExp(`^${PYTHON_WHITESPACE_PATTERN}$`, 'u');
function unique(items: RenderText[], value: RenderText): void {
  if (renderTextLength(value) && !items.some((item) => renderTextEqual(item, value)))
    items.push(value);
}
function relativePath(value: RenderValue | undefined, cwd: string): RenderText {
  const path = orText(value),
    prefix = cwd + '/';
  return renderTextStartsWith(path, prefix)
    ? renderTextSlice(path, Array.from(prefix).length)
    : path;
}
export function compactRendererWhitespace(value: RenderText, limit = 160): RenderText {
  const trimmed = renderTextStrip(value),
    source = points(trimmed);
  const fragments: RenderText[] = [];
  let start = 0;
  for (let index = 0; index < source.length; ) {
    if (!whitespace.test(String.fromCodePoint(source[index]!))) {
      index++;
      continue;
    }
    if (index > start) fragments.push(renderTextSlice(trimmed, start, index));
    while (index < source.length && whitespace.test(String.fromCodePoint(source[index]!))) index++;
    fragments.push(' ');
    start = index;
  }
  if (start < source.length) fragments.push(renderTextSlice(trimmed, start));
  const result = renderTextConcat(...fragments);
  return renderTextLength(result) <= limit
    ? result
    : renderTextConcat(renderTextSlice(result, 0, limit), '...');
}
export interface BoundedRendererText {
  readonly text: RenderText;
  readonly truncated: boolean;
  readonly ref: RenderObject | null;
}
export function boundedRendererText(
  value: RenderText,
  limit: number,
  spill?: Map<string, RenderText>
): BoundedRendererText {
  const length = renderTextLength(value);
  if (length <= limit) return { text: value, truncated: false, ref: null };
  if (length <= 20000) return { text: value, truncated: true, ref: null };
  const head = Math.max(limit - 1500 - 80, 0),
    tail = Math.min(1500, Math.max(Math.floor(limit / 4), 1));
  const inline = renderTextConcat(
    ...[
      renderTextSlice(value, 0, head),
      `\n...[renderer: ${length - head - tail} middle characters truncated; full text in payloads sidecar]...\n`,
      renderTextSlice(value, -tail),
    ]
  );
  let ref: RenderObject | null = null;
  if (spill !== undefined) {
    const encoded = encodeUtf8Strict(
      isCodepointText(value) ? value : codepointTextFromString(value, UNICODE_PROFILE_ID)
    );
    if (!encoded.ok) throw new TypeError('Renderer spill cannot encode a surrogate codepoint');
    const digest = createHash('sha256').update(encoded.value).digest('hex');
    spill.set(digest, value);
    ref = object({ sha256: digest, length: renderInteger(length) });
  }
  return { text: inline, truncated: true, ref };
}
function boundFields(
  record: RenderObject,
  field: string,
  value: RenderText,
  limit: number,
  spill: Map<string, RenderText>,
  length = true
): RenderObject {
  const bounded = boundedRendererText(value, limit, spill);
  record = renderSet(record, field, bounded.text);
  if (length) record = renderSet(record, field + '_length', renderInteger(renderTextLength(value)));
  record = renderSet(record, field + '_truncated', bounded.truncated);
  return bounded.ref === null ? record : renderSet(record, field + '_ref', bounded.ref);
}
function newTurn(user: RenderText | null = null, ts: string | null = null): RenderTurn {
  return {
    user,
    user_ts: ts,
    payload_spill: new Map(),
    timeline: [],
    hook_contexts: [],
    interjections: [],
    edited_files: [],
    read_files: [],
    searches: [],
    commands: [],
    agent_runs: [],
    artifacts: [],
    control_events: [],
    usage: renderObject([]),
    models: [],
    stop_reason: null,
    env: renderObject([]),
  };
}
function open(turn: RenderTurn): boolean {
  return (
    renderTruthy(turn.user) ||
    !!(turn.timeline.length || turn.control_events.length || turn.interjections.length)
  );
}
export function rendererTurnIsSubstantive(turn: RenderTurn): boolean {
  return open(turn) || turn.hook_contexts.length > 0;
}
function capture(value: RenderText, expression: RegExp): RenderText | null {
  const insensitive = expression.flags.includes('i');
  const flags = expression.flags.replace('i', '');
  const indexed = new RegExp(expression.source, flags.includes('d') ? flags : flags + 'd');
  const match = indexed.exec(insensitive ? keywordMapped(value) : mapped(value));
  if (!match || match[1] === undefined) return null;
  const range = match.indices![1]!;
  return renderTextSlice(value, range[0], range[1]);
}
function controlEvent(value: RenderText, ts: string | null): RenderObject {
  const task = capture(value, /<task-id>(.*?)<\/task-id>/s);
  const summary = capture(value, /<summary>(.*?)<\/summary>/s);
  const command = capture(value, /<command-message>(.*?)<\/command-message>/s);
  const bounded = boundedRendererText(value, 1800);
  return object({
    type: renderTextStartsWith(value, '<task-notification>') ? 'task_notification' : 'control',
    task_id: task === null ? null : renderTextStrip(task),
    preview:
      summary !== null
        ? renderTextStrip(summary)
        : command !== null
          ? renderTextStrip(command)
          : compactRendererWhitespace(value, 180),
    raw: bounded.text,
    raw_truncated: bounded.truncated,
    ts,
  });
}
export function extractRendererHeuristicFields(texts: readonly RenderText[]): {
  decisions: RenderObject[];
  next_action: RenderText | null;
  blocking_issue: RenderText | null;
} {
  const full = renderTextConcat(
    ...texts.flatMap((value, index) => (index ? ['\n', value] : [value]))
  );
  const source = keywordMapped(full),
    decisions: RenderObject[] = [];
  const add = (value: RenderText): void => {
    const statement = renderTextSlice(renderTextStrip(value), 0, 240);
    if (
      renderTextLength(statement) &&
      !decisions.some((item) => renderEqual(get(item, 'statement'), statement))
    )
      decisions.push(object({ statement, source: 'heuristic' }));
  };
  const lines = [
    ...source.matchAll(
      /([^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]*)(?:\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]|$)/g
    ),
  ].filter((match) => match[0] !== '');
  const ws = PYTHON_WHITESPACE_PATTERN;
  const heading = new RegExp(
    `^${ws}{0,3}(?:#{1,6}${ws}*)?decisions(?:${ws}+made)?${ws}*:${ws}*$`,
    'iu'
  );
  const bullet = new RegExp(`^${ws}*[-*]${ws}+(.+?)${ws}*$`, 'u');
  for (let index = 0; index < lines.length; index++) {
    if (!heading.test(lines[index]![1]!)) continue;
    let collecting = false;
    for (const candidate of lines.slice(index + 1)) {
      const line = renderTextSlice(full, candidate.index!, candidate.index! + candidate[1]!.length);
      if (!renderTextLength(renderTextStrip(line)) && !collecting) continue;
      const statement = capture(line, bullet);
      if (statement === null) break;
      collecting = true;
      add(statement);
    }
  }
  for (const expression of [
    new RegExp(
      `(?:^|\n)${ws}*(?:decision|decided|choosing|will use|going with)[:${ws.slice(1, -1)}]+([^\n]+?)(?:\n|(?![\\s\\S]))`,
      'gdu'
    ),
    new RegExp(
      `(?:^|\n)${ws}*(?:approach|plan|strategy)[:${ws.slice(1, -1)}]+([^\n]+?)(?:\n|(?![\\s\\S]))`,
      'gdu'
    ),
  ])
    for (const match of source.matchAll(expression)) {
      const range = match.indices![1]!;
      add(renderTextSlice(full, range[0], range[1]));
    }
  const first = (expressions: readonly RegExp[]): RenderText | null => {
    for (const expression of expressions) {
      const value = capture(full, expression);
      if (value !== null) return renderTextSlice(renderTextStrip(value), 0, 240);
    }
    return null;
  };
  return {
    decisions,
    next_action: first([
      new RegExp(
        `(?:^|\n)${ws}*the next recommended tranche is${ws}+([^\n]+?)(?:\n|(?![\\s\\S]))`,
        'iu'
      ),
      new RegExp(
        `(?:^|\n)${ws}*(?:next step|next action|next:|todo:|will now)[:${ws.slice(1, -1)}]+([^\n]+?)(?:\n|(?![\\s\\S]))`,
        'iu'
      ),
    ]),
    blocking_issue: first([
      new RegExp(`(?:^|\n)${ws}*blocking issue:${ws}*([^\n]+?)(?:\n|(?![\\s\\S]))`, 'iu'),
      new RegExp(
        `(?:^|\n)${ws}*(?:blocked|blocking|cannot proceed|stuck)[:${ws.slice(1, -1)}]+([^\n]+?)(?:\n|(?![\\s\\S]))`,
        'iu'
      ),
    ]),
  };
}
function patchPaths(value: RenderText): RenderText[] {
  const paths: RenderText[] = [],
    ws = PYTHON_WHITESPACE_PATTERN;
  const expression = new RegExp(
    `(?:^|\n)\\*\\*\\* (?:Add|Update|Delete) File:${ws}*([^\n]+?)${ws}*(?=\n|(?![\\s\\S]))`,
    'gdu'
  );
  for (const match of mapped(value).matchAll(expression)) {
    const range = match.indices![1]!;
    unique(paths, renderTextStrip(renderTextSlice(value, range[0], range[1])));
  }
  return paths;
}
function decoded(value: RenderText, numericProfile?: TranscriptJsonNumericProfile): RenderText {
  // Structured tool envelopes originate in transcript JSON strings. Derived
  // CodepointText is never serialized and reparsed to manufacture an envelope.
  return typeof value === 'string' ? decodeStructuredTextPayload(value, numericProfile) : value;
}
type ToolReference = { turn: RenderTurn; index: number };
const tool = (reference: ToolReference): RenderObject => reference.turn.timeline[reference.index]!;

export function accumulateRendererEvents(
  events: readonly PreparedRendererEvent[],
  cwd: string,
  options: RendererAccumulationOptions
): { turns: RenderTurn[]; sessionEvents: RenderObject[] } {
  const numericProfile =
    options.numericProfile === undefined
      ? undefined
      : snapshotTranscriptJsonProfile(options.numericProfile);
  if (
    !options.duration ||
    typeof options.duration.profileId !== 'string' ||
    !options.duration.profileId
  )
    throw new TypeError('Renderer accumulation requires a selected duration profile');
  const turns: RenderTurn[] = [],
    sessionEvents: RenderObject[] = [];
  let current = newTurn(),
    pendingEnv = renderObject([]),
    pendingShell: RenderObject[] = [];
  const pendingTools: { id: RenderValue; reference: ToolReference }[] = [];
  const seenRequests: { message: string; request: string | null }[] = [];
  const promptParents = new Map<string, RenderTurn>();
  const hashable = (id: RenderValue): void => {
    if (Array.isArray(id) || isJsonObject(id) || isRenderObject(id))
      throw new TypeError('Unhashable renderer tool identifier');
  };
  const pending = (id: RenderValue): ToolReference | undefined => {
    hashable(id);
    return pendingTools.find((item) => renderEqual(item.id, id))?.reference;
  };
  for (const prepared of events) {
    const entry = prepared.envelope.event,
      ev = entry.ev,
      ts = parseTimestamp(entry.ts);
    const member = (key: string, fallback: RenderValue = null): RenderValue =>
      entry[key] === undefined ? fallback : entry[key]!;
    if (ev === 'turn_boundary') {
      if (rendererTurnIsSubstantive(current)) turns.push(current);
      current = newTurn(null, ts);
      pendingEnv = renderObject([]);
      for (const key of ['model', 'effort', 'cwd', 'approval_policy', 'sandbox_policy'])
        if (member(key) !== null) pendingEnv = renderSet(pendingEnv, key, member(key));
      current.env = pendingEnv;
      continue;
    }
    if (ev === 'user_text') {
      const value = text(member('text', ''));
      if (
        options.noisePrefixes.some((prefix) => renderTextStartsWith(value, prefix)) ||
        new RegExp(
          `^Called the [^${PYTHON_WHITESPACE_PATTERN.slice(1, -1)}]+ tool with the following input:`,
          'u'
        ).test(mapped(value)) ||
        !renderTextLength(renderTextStrip(value))
      )
        continue;
      if (
        ['<task-notification>', '[Request interrupted', 'Conversation rewind applied.'].some(
          (prefix) => renderTextStartsWith(value, prefix)
        )
      ) {
        if (renderTextStartsWith(value, '[Request interrupted') && open(current))
          current.ended_by = renderTextStartsWith(
            value,
            '[Request interrupted by user for tool use]'
          )
            ? 'user_interrupt_tool'
            : 'user_interrupt_generation';
        sessionEvents.push(controlEvent(value, ts));
        continue;
      }
      if (rendererTurnIsSubstantive(current)) turns.push(current);
      current = newTurn(value, ts);
      current.env = pendingEnv;
      pendingEnv = renderObject([]);
      const parent = member('parent_uuid');
      if (typeof parent === 'string' && parent) {
        const rewound = promptParents.get(parent);
        if (rewound !== undefined) {
          current.rewound_from_turn = rewound;
          current.rewind_kind = renderTextEqual(rewound.user ?? '', value)
            ? 'same_prompt'
            : 'edited_prompt';
          rewound.rewound = true;
        }
        promptParents.set(parent, current);
      }
      if (pendingShell.length) {
        current.timeline = pendingShell.concat(current.timeline);
        pendingShell = [];
      }
      continue;
    }
    if (ev === 'user_shell') {
      const target = open(current) ? current.timeline : pendingShell;
      const output = entry.stdout !== undefined || entry.stderr !== undefined,
        last = target[target.length - 1];
      if (
        output &&
        last !== undefined &&
        get(last, 'kind') === 'user_shell' &&
        !renderHas(last, 'stdout')
      ) {
        let item = renderSet(
          renderSet(last, 'stdout', member('stdout', '')),
          'stderr',
          member('stderr', '')
        );
        if (ts) item = renderSet(item, 'result_ts', ts);
        target[target.length - 1] = item;
      } else
        target.push(
          object({
            kind: 'user_shell',
            ts,
            provenance: 'user_shell',
            ...(output
              ? { stdout: member('stdout', ''), stderr: member('stderr', '') }
              : { command: member('command', '') }),
          })
        );
      continue;
    }
    if (ev === 'reasoning') {
      const value = orText(member('text', ''));
      if (renderTextLength(renderTextStrip(value))) {
        const bounded = boundedRendererText(value, 2000, current.payload_spill);
        let item = object({ kind: 'reasoning', text: bounded.text, ts, provenance: 'thinking' });
        if (bounded.truncated)
          item = renderSet(
            renderSet(item, 'text_truncated', true),
            'text_length',
            renderInteger(renderTextLength(value))
          );
        if (bounded.ref) item = renderSet(item, 'text_ref', bounded.ref);
        current.timeline.push(item);
      }
      continue;
    }
    if (ev === 'assistant_meta') {
      const message = member('message_id'),
        request = member('request_id');
      const requestId = typeof request === 'string' ? request : null;
      const repeat =
        typeof message === 'string' &&
        !!message &&
        seenRequests.some((item) => item.message === message && item.request === requestId);
      if (typeof message === 'string' && message && !repeat)
        seenRequests.push({ message, request: requestId });
      const usage = member('usage');
      if ((isJsonObject(usage) || isRenderObject(usage)) && !repeat)
        for (const [key, value] of renderEntries(usage))
          if (renderIsNumeric(value)) {
            const previous = renderGet(current.usage, key) ?? renderInteger(0);
            if (!renderIsNumeric(previous))
              throw new TypeError('Accumulated usage must be numeric');
            current.usage = renderSet(current.usage, key, renderAdd(previous, value));
          }
      const model = member('model'),
        stop = member('stop_reason');
      if (typeof model === 'string' && model) unique(current.models, model);
      if (typeof stop === 'string' && stop) current.stop_reason = stop;
      continue;
    }
    if (ev === 'control') {
      const subtype =
        entry.subtype !== undefined && renderTruthy(entry.subtype) ? entry.subtype : 'control';
      const value = orText(member('text', ''));
      let item = object({
        kind: 'control',
        subtype,
        ts,
        provenance: member('provenance', 'harness:' + pythonStr(subtype)),
      });
      if (renderTextLength(value))
        item = renderSet(item, 'text', compactRendererWhitespace(value, 400));
      if (renderIsNumeric(member('duration_ms')))
        item = renderSet(item, 'duration_ms', member('duration_ms'));
      for (const key of ['model', 'source'])
        if (typeof member(key) === 'string' && renderTruthy(member(key)))
          item = renderSet(item, key, member(key));
      const step = member('step');
      if (typeof step === 'boolean' || (isJsonNumber(step) && step.numberKind === 'integer'))
        item = renderSet(item, 'step', step);
      for (const key of [
        'cost_usd',
        'api_duration_ms',
        'tool_duration_ms',
        'lines_added',
        'lines_removed',
        'message_count',
        'level',
      ]) {
        const value = member(key);
        if (typeof value === 'string' || renderIsNumeric(value)) item = renderSet(item, key, value);
      }
      const models = member('models');
      if (Array.isArray(models))
        item = renderSet(
          item,
          'models',
          models.filter((value) => typeof value === 'string')
        );
      current.timeline.push(item);
      continue;
    }
    if (ev === 'assistant_text') {
      const value = text(member('text', ''));
      if (renderTextEqual(renderTextStrip(value), 'No response requested.')) continue;
      if (renderTextLength(renderTextStrip(value)))
        current.timeline.push(
          object({
            kind: 'reasoning',
            text: value,
            ts,
            provenance: member('thought') === true ? 'thinking' : 'assistant_reasoning',
            ...(member('thought') === true ? { thought: true } : {}),
          })
        );
      continue;
    }
    if (ev === 'tool_use') {
      const original = member('name', ''),
        codex = member('source_harness') === 'codex';
      if (codex && typeof original !== 'string')
        throw new TypeError('Codex tool names must be strings');
      const name =
        codex && typeof original === 'string'
          ? original.slice(original.lastIndexOf('.') + 1)
          : original;
      const input = member('input', renderObject([])),
        id = member('id', '');
      let item = object({
        kind: 'tool_call',
        name: original,
        source_harness: member('source_harness', ''),
        id,
        ts,
        provenance: 'tool_call',
      });
      if (codex && !((isJsonObject(input) || isRenderObject(input)) && renderHas(input, 'raw')))
        item = renderSet(item, 'input', input);
      const raw = renderGet(input, 'raw');
      if (typeof raw === 'string' || isCodepointText(raw)) {
        item = renderSet(
          renderSet(
            renderSet(item, 'input_raw', raw),
            'input_length',
            renderInteger(renderTextLength(raw))
          ),
          'input_truncated',
          false
        );
        if (name === 'exec') {
          if (prepared.derived === null || prepared.derived.kind !== 'codex-source-index')
            throw new TypeError('Codex exec source requires the actual prepared source index');
          const derived = prepared.derived;
          if (
            derived.sourceField.length !== 2 ||
            derived.sourceField[0] !== 'input' ||
            derived.sourceField[1] !== 'raw' ||
            typeof raw !== 'string' ||
            derived.index.rawSource !== raw ||
            derived.index.interpretationProfileId !== UNICODE_PROFILE_ID
          )
            throw new TypeError('Prepared Codex source index does not match its event context');
          const actions: RenderObject[] = [];
          for (const action of prepared.derived.index.actions) {
            let indexed = object({
              tool: action.tool,
              observation_boundary: action.observation_boundary,
              execution: action.execution,
            });
            for (const key of [
              'command',
              'workdir',
              'path',
              'patch_preview',
              'args_preview',
            ] as const)
              if (action[key] !== undefined) indexed = renderSet(indexed, key, action[key]!);
            if (action.files !== undefined) indexed = renderSet(indexed, 'files', action.files);
            if (action.patch_length !== undefined)
              indexed = renderSet(indexed, 'patch_length', renderInteger(action.patch_length));
            if (action.batch_commands !== undefined)
              indexed = renderSet(indexed, 'batch_commands', action.batch_commands);
            actions.push(indexed);
            if (action.tool === 'exec_command') {
              const commands = [
                ...(action.command ? [action.command] : []),
                ...(action.batch_commands ?? []),
              ];
              for (const command of commands) {
                if (!current.commands.some((ref) => renderEqual(get(ref, 'command'), command)))
                  current.commands.push(
                    object({
                      command,
                      description: 'Codex inner exec_command',
                      ts,
                      provenance: 'codex_exec_source_index',
                      execution: 'not_observed',
                    })
                  );
                const source = mapped(command);
                if (
                  new RegExp(
                    `(?:^|[;&|]${PYTHON_WHITESPACE_PATTERN}*)rg${PYTHON_WHITESPACE_PATTERN}`,
                    'u'
                  ).test(source)
                )
                  current.searches.push(
                    object({
                      tool: 'rg',
                      query: command,
                      ts,
                      provenance: 'codex_exec_source_index',
                      execution: 'not_observed',
                    })
                  );
                const ws = PYTHON_WHITESPACE_PATTERN;
                const expression = new RegExp(
                  `sed${ws}+-n${ws}+(?:"[^"]*"|'[^']*'|[^${ws.slice(1, -1)}]+)${ws}+([^${ws.slice(1, -1)};&|]+)`,
                  'gu'
                );
                for (const match of source.matchAll(expression)) {
                  if (match.index! > 0 && isPythonWordCodepoint(points(command)[match.index! - 1]!))
                    continue;
                  const offset = match.index! + match[0].lastIndexOf(match[1]!);
                  unique(
                    current.read_files,
                    relativePath(renderTextSlice(command, offset, offset + match[1]!.length), cwd)
                  );
                }
              }
            } else if (action.tool === 'apply_patch') {
              for (const file of action.files ?? []) {
                const path = relativePath(file, cwd);
                unique(current.edited_files, path);
                if (
                  !current.artifacts.some(
                    (artifact) =>
                      get(artifact, 'type') === 'file_edit' &&
                      renderEqual(get(artifact, 'path'), path)
                  )
                )
                  current.artifacts.push(
                    object({
                      type: 'file_edit',
                      path,
                      ts,
                      provenance: 'codex_exec_source_index',
                      execution: 'not_observed',
                    })
                  );
              }
            } else if (action.tool === 'view_image' && action.path)
              unique(current.read_files, relativePath(action.path, cwd));
          }
          item = renderSet(item, 'inner_actions', actions);
        }
      }
      if (
        (name === 'Write' ||
          name === 'Edit' ||
          name === 'Read' ||
          name === 'Grep' ||
          name === 'Glob' ||
          name === 'WebSearch' ||
          name === 'WebFetch' ||
          name === 'Bash' ||
          name === 'Agent' ||
          name === 'Task' ||
          name === 'Skill' ||
          name === 'ExitPlanMode') &&
        !isJsonObject(input) &&
        !isRenderObject(input)
      )
        throw new TypeError('Known renderer tool requires a mapping input');
      if (name === 'Write' || name === 'Edit') {
        const file = relativePath(renderGet(input, 'file_path'), cwd);
        item = renderSet(item, 'file', file);
        unique(current.edited_files, file);
        if (name === 'Edit')
          for (const key of ['old_string', 'new_string'])
            item = boundFields(
              item,
              key,
              orText(renderGet(input, key)),
              1800,
              current.payload_spill
            );
        else {
          const value = orText(renderGet(input, 'content')),
            bounded = boundedRendererText(value, 1600, current.payload_spill);
          item = renderSet(
            renderSet(
              renderSet(item, 'content_preview', bounded.text),
              'content_length',
              renderInteger(renderTextLength(value))
            ),
            'content_truncated',
            bounded.truncated
          );
          if (bounded.ref) item = renderSet(item, 'content_ref', bounded.ref);
        }
        current.artifacts.push(
          object({ type: name === 'Edit' ? 'file_edit' : 'file_write', path: file, ts })
        );
      } else if (name === 'Read') {
        const file = relativePath(renderGet(input, 'file_path'), cwd);
        item = renderSet(item, 'file', file);
        unique(current.read_files, file);
      } else if (
        name === 'Grep' ||
        name === 'Glob' ||
        name === 'WebSearch' ||
        name === 'WebFetch'
      ) {
        const search = name === 'Grep' || name === 'Glob';
        const value = renderGet(input, search ? 'pattern' : 'query');
        const query = renderTruthy(value) ? value! : get(input, search ? 'path' : 'url', '');
        item = renderSet(item, search ? 'pattern' : 'query', query);
        if (renderTruthy(query)) current.searches.push(object({ tool: name, query, ts }));
      } else if (name === 'Bash') {
        const command = text(get(input, 'command', '')),
          description = orText(renderGet(input, 'description'));
        item = renderSet(
          renderSet(renderSet(item, 'command', command), 'description', description),
          'run_in_background',
          get(input, 'run_in_background')
        );
        current.commands.push(object({ command, description, ts }));
        if (renderTextContains(command, 'git commit') && renderTextContains(command, '-m'))
          current.artifacts.push(object({ type: 'git_commit', command, ts }));
        if (
          ['pytest', 'npm test', 'pnpm test'].some((keyword) =>
            renderTextContains(command, keyword)
          )
        )
          current.artifacts.push(object({ type: 'test_run', command, ts }));
      } else if (name === 'Agent' || name === 'Task') {
        const prompt = orText(renderGet(input, 'prompt'));
        item = boundFields(item, 'prompt', prompt, 1800, current.payload_spill);
        for (const key of ['subagent_type', 'run_in_background', 'isolation'])
          item = renderSet(item, key, get(input, key));
        item = renderSet(item, 'provenance', 'sub_agent_dispatch');
        current.agent_runs.push(
          object({
            id,
            tool: name,
            subagent_type: get(input, 'subagent_type'),
            prompt_preview: compactRendererWhitespace(prompt, 300),
            status: 'launched',
            ts,
          })
        );
      } else if (name === 'Skill') {
        item = renderSet(
          renderSet(item, 'skill', get(input, 'skill', '')),
          'args',
          get(input, 'args', '')
        );
      } else if (name === 'ExitPlanMode') {
        const plan = orText(renderGet(input, 'plan'));
        item = renderSet(
          boundFields(item, 'plan', plan, 6000, current.payload_spill),
          'provenance',
          'plan_approval'
        );
        const artifact = boundedRendererText(plan, 2500);
        current.artifacts.push(
          object({
            type: 'plan',
            content: artifact.text,
            content_truncated: artifact.truncated,
            ts,
          })
        );
      }
      current.timeline.push(item);
      hashable(id);
      const previous = pendingTools.findIndex((entry) => renderEqual(entry.id, id));
      const reference = { turn: current, index: current.timeline.length - 1 };
      if (previous < 0) pendingTools.push({ id, reference });
      else pendingTools[previous] = { id, reference };
      continue;
    }
    if (ev === 'audit_action') {
      const name = member('tool', ''),
        originalInput = member('input'),
        originalResponse = member('response');
      const input =
        isJsonObject(originalInput) || isRenderObject(originalInput)
          ? originalInput
          : renderObject([]);
      const response =
        isJsonObject(originalResponse) || isRenderObject(originalResponse)
          ? originalResponse
          : renderObject([]);
      let action = object({
        kind: 'audit_action',
        tool: name,
        tool_use_id: member('id', ''),
        is_error: renderTruthy(member('is_error')),
        permission_mode: member('permission_mode'),
        ts,
        provenance: 'hook_audit',
      });
      const jsonOptions = {
        ensureAscii: false,
        sortKeys: true,
        ...(numericProfile === undefined ? {} : { numericProfile }),
      };
      const inputText = renderJsonDumps(input, jsonOptions);
      action = boundFields(action, 'input_preview', inputText, 2000, current.payload_spill, false);
      // The reference uses input_truncated/input_ref rather than preview suffixes.
      action = object(
        renderEntries(action).reduce<Record<string, RenderValue>>((fields, [key, value]) => {
          if (typeof key !== 'string') throw new TypeError('Internal audit field must be a string');
          fields[
            key === 'input_preview_truncated'
              ? 'input_truncated'
              : key === 'input_preview_ref'
                ? 'input_ref'
                : key
          ] = value;
          return fields;
        }, {})
      );
      action = renderSet(action, 'input_length', renderInteger(renderTextLength(inputText)));
      if (renderTruthy(response))
        action = boundFields(
          action,
          'response',
          renderJsonDumps(response, jsonOptions),
          3000,
          current.payload_spill,
          false
        );
      const file = relativePath(
        renderTruthy(renderGet(input, 'file_path'))
          ? renderGet(input, 'file_path')
          : renderGet(input, 'path'),
        cwd
      );
      const command = renderTruthy(renderGet(input, 'command'))
        ? renderGet(input, 'command')!
        : get(input, 'cmd', '');
      if ((name === 'Write' || name === 'Edit' || name === 'apply_patch') && renderTextLength(file))
        unique(current.edited_files, file);
      else if (
        name === 'apply_patch' &&
        (typeof renderGet(input, 'patch') === 'string' ||
          isCodepointText(renderGet(input, 'patch')))
      )
        for (const path of patchPaths(text(renderGet(input, 'patch'))))
          unique(current.edited_files, relativePath(path, cwd));
      else if ((name === 'Read' || name === 'view_image') && renderTextLength(file))
        unique(current.read_files, file);
      else if (name === 'Grep' || name === 'Glob') {
        const query = renderTruthy(renderGet(input, 'pattern'))
          ? renderGet(input, 'pattern')!
          : get(input, 'path', '');
        if (renderTruthy(query))
          current.searches.push(object({ tool: name, query, ts, provenance: 'hook_audit' }));
      }
      if (
        (name === 'Bash' || name === 'exec_command') &&
        renderTruthy(command) &&
        !current.commands.some((ref) => renderEqual(get(ref, 'command'), command))
      )
        current.commands.push(
          object({
            command,
            description: 'Audited inner tool action',
            ts,
            provenance: 'hook_audit',
            is_error: renderTruthy(member('is_error')),
          })
        );
      current.timeline.push(action);
      continue;
    }
    if (ev === 'tool_result') {
      const id = member('id', ''),
        reference = pending(id),
        content = orText(member('content', ''));
      if (reference !== undefined) {
        let info = tool(reference);
        const name = get(info, 'name', ''),
          codex = get(info, 'source_harness') === 'codex';
        let result =
          codex || name === 'Agent' || name === 'Task' || name === 'exec' || name === 'wait'
            ? decoded(content, numericProfile)
            : content;
        if (name === 'Read') result = content;
        const bounded = boundedRendererText(
          result,
          name === 'Read' || name === 'Write' || name === 'Edit' ? 2500 : 3000,
          reference.turn.payload_spill
        );
        if (bounded.ref) info = renderSet(info, 'output_ref', bounded.ref);
        const first = get(info, 'ts'),
          duration = options.duration.secondsBetween(typeof first === 'string' ? first : null, ts);
        if (duration !== null && !isJsonNumber(duration))
          throw new TypeError('Duration port returned an invalid numeric value');
        const outputLength = renderTextLength(decoded(content, numericProfile));
        for (const [key, value] of Object.entries({
          output: bounded.text,
          output_length: renderInteger(outputLength),
          output_truncated: outputLength > renderTextLength(bounded.text),
          output_cut: renderTextContains(bounded.text, 'payloads sidecar]...'),
          is_error: renderTruthy(member('is_error')),
          result_ts: ts,
          duration_s: duration,
        }))
          info = renderSet(info, key, value);
        reference.turn.timeline[reference.index] = info;
        if (name === 'Bash')
          for (let index = current.commands.length - 1; index >= 0; index--) {
            let command = current.commands[index]!;
            if (
              !renderEqual(get(command, 'command'), get(info, 'command')) ||
              renderHas(command, 'output_preview')
            )
              continue;
            for (const [key, value] of Object.entries({
              output: bounded.text,
              output_preview: compactRendererWhitespace(bounded.text, 320),
              duration_s: duration,
              is_error: renderTruthy(member('is_error')),
            }))
              command = renderSet(command, key, value);
            current.commands[index] = command;
            break;
          }
        if (name === 'Agent' || name === 'Task')
          for (let index = current.agent_runs.length - 1; index >= 0; index--) {
            let agent = current.agent_runs[index]!;
            if (!renderEqual(get(agent, 'id'), id)) continue;
            for (const [key, value] of Object.entries({
              status: renderTruthy(member('is_error')) ? 'error' : 'completed',
              output: bounded.text,
              output_preview: compactRendererWhitespace(bounded.text, 500),
              duration_s: duration,
            }))
              agent = renderSet(agent, key, value);
            current.agent_runs[index] = agent;
            break;
          }
      } else {
        const bounded = boundedRendererText(content, 3000);
        current.timeline.push(
          object({
            kind: 'tool_output',
            id,
            content: bounded.text,
            content_truncated: bounded.truncated,
            is_error: renderTruthy(member('is_error')),
            ts,
            provenance: 'tool_output_orphan',
          })
        );
      }
      continue;
    }
    if (ev === 'interjection') {
      const value = text(member('text', ''));
      if (renderTextLength(renderTextStrip(value))) {
        current.interjections.push(object({ text: value, ts }));
        current.timeline.push(
          object({ kind: 'interjection', text: value, ts, provenance: 'user_interjection' })
        );
      }
      continue;
    }
    if (ev === 'hook_context') {
      let context = renderObject([]);
      for (const key of [
        'kind',
        'hook_name',
        'hook_event',
        'tool_use_id',
        'additional_context',
        'context_authority',
        'status',
        'tool_name',
        'stdout',
        'stderr',
        'provenance',
        'exit_code',
        'duration_ms',
        'observation_boundary',
        'delivery',
        'invocation_id',
        'source_sha256',
        'runtime_digest',
        'adapter_exit_code',
      ])
        context = renderSet(context, key, member(key));
      context = renderSet(context, 'ts', ts);
      current.hook_contexts.push(context);
      const reference = pending(renderTruthy(member('tool_use_id')) ? member('tool_use_id') : '');
      if (reference !== undefined) {
        const info = tool(reference),
          contexts = get(info, 'hook_contexts', []);
        if (!Array.isArray(contexts))
          throw new TypeError('Tool hook context index must be an array');
        reference.turn.timeline[reference.index] = renderSet(info, 'hook_contexts', [
          ...contexts,
          context,
        ]);
      }
    }
  }
  if (rendererTurnIsSubstantive(current)) turns.push(current);
  if (pendingShell.length) {
    const synthetic = newTurn();
    synthetic.timeline = pendingShell;
    turns.push(synthetic);
  }
  return { turns, sessionEvents };
}
