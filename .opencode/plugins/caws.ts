/*
CAWS-MANAGED-HOOK
# hook_pack: opencode
# hook_pack_version: 3
# caws_min_major: 11
# lineage_refs: 1,4,6,11,12,13,16,17,19,22,23,24,25,26,27,28,29,30,31
# edit_stance: this repo OWNS and may grow this hook. Edits are expected and
#   preserved — caws init refuses to overwrite a changed managed hook (re-run
#   with --adopt to keep yours, or --overwrite to pull this upstream template).
#   CAWS owns the failure-class invariant (the why/what you must not silently
#   weaken); you own the how. Do not edit it to BYPASS the guard; do grow it.
*/

// CAWS opencode vendor adapter.
//
// opencode's lifecycle interposition is an in-process TypeScript plugin
// surface (https://opencode.ai/docs/plugins) — there is no "run this bash
// command on PreToolUse" config field like claude-code/codex have. So this
// adapter is a TS shim that translates opencode's plugin callbacks into the
// SAME shared bash dispatchers every other surface uses
// (.caws/hooks/dispatch/<event>.sh), reusing 100% of the guard/check logic.
//
// Blocking: opencode's only PreToolUse block primitive is `throw new Error(msg)`
// inside tool.execute.before. The shim parses the dispatcher's stdout decision
// + exit code and throws on block / ask (ask degrades to block — opencode has
// no PreToolUse ask; matches the codex adapter precedent).
//
// Context surfacing (v2): the shared core PRODUCES context for the agent —
// the multi-agent peer notice, inter-agent message delivery, advisory quality
// warns — as `hookSpecificOutput.additionalContext` on the dispatcher's
// stdout (agent-heartbeat.sh). claude-code injects that natively; opencode
// does not. The shim surfaces it via opencode's sanctioned injection API,
// `client.session.prompt({ noReply: true })` — "Inject context without
// triggering AI response (useful for plugins)" per the SDK docs.
//
// updatedInput (v3): the shared `quiet-merge.sh` handler rewrites
// `caws worktree merge|destroy` bash commands (to cd to repo root + suppress
// output) so subagents don't CWD-crash or overflow context on verbose merge
// output. claude-code/codex honor `hookSpecificOutput.updatedInput` natively;
// the shim applies it by mutating output.args.command before the tool runs.
// Without this, opencode agents would hit the exact crash class quiet-merge
// exists to prevent.
//
// Fail posture: if .caws/hooks/ is absent (CAWS not installed for this repo),
// the shim fails OPEN (allow) and logs once — it never blocks every tool.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SURFACE = 'opencode';
const UNKNOWN_ROOT = '';

let cachedRoot: string | null = null;
let warnedMissing = false;

// The opencode session id, captured from session.* bus events (and defensively
// from tool.execute.before input). Required for (a) the dispatcher payload so
// agent-register/heartbeat run with a real HOOK_SESSION_ID instead of "unknown",
// and (b) addressing client.session.prompt for context injection.
let currentSessionId: string | null = null;

// Re-entrancy guard: session.prompt({noReply:true}) should not re-trigger
// tool.execute.before, but guard against any path that could recurse.
let injecting = false;

interface ProjectRoot {
  worktree?: string | null;
  directory?: string | null;
  project?: { path?: string | null } | null;
}

// Walk up from `from` to the nearest ancestor containing a `.caws/` dir.
function resolveProjectRoot(ctx: ProjectRoot): string {
  if (cachedRoot !== null) return cachedRoot;
  const seeds: string[] = [];
  if (ctx.worktree) seeds.push(ctx.worktree);
  if (ctx.directory) seeds.push(ctx.directory);
  if (ctx.project?.path) seeds.push(ctx.project.path);
  if (process.cwd()) seeds.push(process.cwd());

  for (const seed of seeds) {
    let dir = path.resolve(seed);
    for (let i = 0; i < 24; i++) {
      try {
        if (fs.existsSync(path.join(dir, '.caws'))) {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // ignore stat errors and keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cachedRoot = UNKNOWN_ROOT; // sentinel: not found
  return cachedRoot;
}

// opencode tool name → CAWS dispatcher vocabulary.
function mapToolName(opencodeTool: string): string {
  const map: Record<string, string> = {
    bash: 'Bash',
    write: 'Write',
    edit: 'Edit',
    read: 'Read',
    glob: 'Glob',
    grep: 'Grep',
    task: 'Task',
  };
  return map[opencodeTool] || opencodeTool;
}

// opencode args (camelCase) → CAWS tool_input (snake_case) keys, so the
// shared guards see the field names they were written against.
function normalizeArgs(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'filePath') out.file_path = v;
    else if (k === 'oldString') out.old_string = v;
    else if (k === 'newString') out.new_string = v;
    else out[k] = v;
  }
  return out;
}

interface DispatchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Invoke a shared bash dispatcher with a JSON payload on stdin.
function dispatch(root: string, dispatcher: string, payload: string): DispatchResult {
  const script = path.join(root, '.caws', 'hooks', 'dispatch', dispatcher);
  try {
    const res = spawnSync(script, [], {
      cwd: root,
      input: payload,
      env: { ...process.env, CAWS_AGENT_SURFACE: SURFACE, CAWS_PROJECT_DIR: root },
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      exitCode: res.status === null ? 0 : res.status,
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
      stderr: typeof res.stderr === 'string' ? res.stderr : '',
    };
  } catch (e) {
    return { exitCode: 0, stdout: '', stderr: String(e instanceof Error ? e.message : e) };
  }
}

interface Decision {
  block: boolean;
  reason: string;
  warn: string;
  context: string;
  // hookSpecificOutput.updatedInput — a handler's request to rewrite the
  // tool's args before it runs (currently quiet-merge rewrites bash commands).
  updatedInput: Record<string, unknown> | null;
}

// Interpret a shared dispatcher's stdout JSON + exit code. Aggregates every
// hookSpecificOutput.additionalContext across all emitted JSON objects (the
// heartbeat peer notice, inter-agent messages, advisory warns) into `context`,
// and captures the last updatedInput seen (a single rewrite per call).
function readDecision(stdout: string, exitCode: number): Decision {
  const empty: Decision = { block: false, reason: '', warn: '', context: '', updatedInput: null };
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const decision = obj.decision;
    const hso = obj.hookSpecificOutput;
    const perm = hso?.permissionDecision;
    const reason =
      obj.reason || hso?.permissionDecisionReason || 'CAWS guard blocked this operation.';
    if (decision === 'block') return { block: true, reason, warn: '', context: '', updatedInput: null };
    // ask degrades to block (opencode has no PreToolUse ask; codex precedent).
    if (perm === 'ask' || perm === 'deny') return { block: true, reason, warn: '', context: '', updatedInput: null };
    if (decision === 'warn' || (typeof obj.advisory === 'string' && obj.advisory)) {
      empty.warn = obj.advisory || reason;
    }
    // additionalContext is the multi-agent notice + message-delivery channel.
    const ac = hso?.additionalContext;
    if (typeof ac === 'string' && ac) {
      empty.context = empty.context ? empty.context + '\n\n' + ac : ac;
    }
    // updatedInput is a handler's request to rewrite the tool args (quiet-merge).
    const ui = hso?.updatedInput ?? obj.updatedInput;
    if (ui && typeof ui === 'object') {
      empty.updatedInput = ui as Record<string, unknown>;
    }
  }
  // Exit 2 is the dispatcher's hard-block convention even without parseable JSON.
  if (exitCode === 2) {
    return {
      block: true,
      reason: stdout.trim() || 'CAWS guard blocked this operation (dispatcher exit 2).',
      warn: '',
      context: '',
      updatedInput: null,
    };
  }
  return empty;
}

// Apply a handler's updatedInput to the tool's args. Currently only
// quiet-merge rewrites the bash command; if a future handler emits
// updatedInput for another tool, add the per-tool mapping here (do not
// silently drop it).
function applyUpdatedInput(args: Record<string, unknown>, updated: Record<string, unknown>): void {
  if (typeof updated.command === 'string' && typeof args.command === 'string') {
    args.command = updated.command;
  }
}

interface ToolInput {
  tool?: string;
  [k: string]: unknown;
}

interface CawsClient {
  app?: {
    log?: (args: {
      body: { level: string; message: string; service?: string };
    }) => Promise<unknown>;
  };
  session?: {
    prompt?: (args: {
      path: { id: string };
      body: { noReply?: boolean; parts: { type: string; text: string }[] };
    }) => Promise<unknown>;
  };
}

async function advisoryLog(client: CawsClient | undefined, message: string) {
  if (!message) return;
  try {
    await client?.app?.log?.({
      body: { level: 'warn', message, service: 'caws' },
    });
  } catch {
    // advisory logging is best-effort; never fail a tool call over it
  }
}

// Inject context as a noReply user message — opencode's sanctioned "inject
// context without triggering AI response" API (SDK: session.prompt). The
// model sees `text` on its next turn. Returns false if injection was not
// possible (no session id, client missing, or error) so the caller can fall
// back to client.app.log.
async function injectContext(
  client: CawsClient | undefined,
  sessionId: string | null,
  text: string
): Promise<boolean> {
  if (!text || !sessionId || injecting) return false;
  injecting = true;
  try {
    await client?.session?.prompt?.({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: 'text', text }] },
    });
    return true;
  } catch {
    return false;
  } finally {
    injecting = false;
  }
}

// Defensive session-id extraction across plausible opencode event/input shapes.
// The exact property layout of session.* events isn't fixed by the plugin
// contract, so probe the common nests.
function extractSessionId(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.id,
    obj.sessionID,
    obj.sessionId,
    obj.session?.id,
    obj.session?.info?.id,
    obj.info?.id,
    obj.properties?.id,
    obj.properties?.session?.id,
    obj.data?.id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && c !== 'unknown') return c;
  }
  return null;
}

interface CawsPluginCtx {
  worktree?: string | null;
  directory?: string | null;
  project?: { path?: string | null } | null;
  client?: CawsClient;
}

function buildPayload(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: '',
    // session_id is load-bearing: parse_hook_input reads it into HOOK_SESSION_ID,
    // without which agent-register/heartbeat exit early ("unknown") and produce
    // no peer notice, no message delivery, no registration.
    session_id: currentSessionId || '',
  });
}

export const CawsPlugin = async (ctx: CawsPluginCtx) => {
  return {
    // PreToolUse analogue. Blocking: throw on block/ask. Rewrite: apply
    // updatedInput (quiet-merge). Context: inject heartbeat/messages/advisories.
    'tool.execute.before': async (input: ToolInput, output: { args: Record<string, unknown> }) => {
      // Capture the session id opportunistically from the tool input.
      const sidFromInput = extractSessionId(input);
      if (sidFromInput) currentSessionId = sidFromInput;

      const root = resolveProjectRoot(ctx);
      if (root === UNKNOWN_ROOT || !fs.existsSync(path.join(root, '.caws', 'hooks', 'dispatch'))) {
        if (!warnedMissing) {
          warnedMissing = true;
          await advisoryLog(
            ctx.client,
            'CAWS hook core not found at .caws/hooks/dispatch/ — run `caws init --agent-surface opencode`. Allowing tools (governance off).'
          );
        }
        return;
      }

      const toolName = mapToolName(input?.tool || '');
      const toolInput = normalizeArgs(output?.args);
      const payload = buildPayload(toolName, toolInput);

      const res = dispatch(root, 'pre_tool_use.sh', payload);
      const decision = readDecision(res.stdout, res.exitCode);
      // Block takes precedence — the reason is what the agent should see.
      if (decision.block) {
        throw new Error(decision.reason);
      }
      // Apply a handler's request to rewrite the tool args (quiet-merge).
      // Must happen before the tool runs, so the agent executes the rewritten
      // command (e.g. quiet-merge's cd-to-root + output-suppressed merge).
      if (decision.updatedInput && output?.args && typeof output.args === 'object') {
        applyUpdatedInput(output.args, decision.updatedInput);
      }
      // Surface CAWS context (peer notice / messages / advisories) to the
      // agent. Inject via session.prompt; fall back to structured log if the
      // session id isn't known yet or injection is unavailable.
      const combined = [decision.warn, decision.context].filter(Boolean).join('\n\n');
      if (combined) {
        const ok = await injectContext(ctx.client, currentSessionId, combined);
        if (!ok) await advisoryLog(ctx.client, combined);
      }
    },

    // PostToolUse analogue: audit + advisory quality checks. Never blocks.
    // Also surfaces any post-tool additionalContext (quality advisories).
    'tool.execute.after': async (input: ToolInput, output: { args: Record<string, unknown> }) => {
      try {
        const root = resolveProjectRoot(ctx);
        if (root === UNKNOWN_ROOT) return;
        const toolName = mapToolName(input?.tool || '');
        const toolInput = normalizeArgs(output?.args);
        const payload = buildPayload(toolName, toolInput);
        const res = dispatch(root, 'post_tool_use.sh', payload);
        const decision = readDecision(res.stdout, res.exitCode);
        const combined = [decision.warn, decision.context].filter(Boolean).join('\n\n');
        if (combined) {
          const ok = await injectContext(ctx.client, currentSessionId, combined);
          if (!ok) await advisoryLog(ctx.client, combined);
        }
      } catch {
        // post-tool audit must never interfere with a completed tool call
      }
    },

    // Session lifecycle via the bus. Best-effort; never throws. Also the
    // primary source of the opencode session id (captured from session.* events).
    event: async (ev: { event?: { type?: string; properties?: any } } | undefined) => {
      try {
        const type = ev?.event?.type;
        const props = ev?.event?.properties;
        if (type && String(type).startsWith('session.')) {
          const sid = extractSessionId(props) || extractSessionId(props?.session);
          if (sid) currentSessionId = sid;
        }
        if (!type) return;
        const root = resolveProjectRoot(ctx);
        if (root === UNKNOWN_ROOT) return;
        let dispatcher: string | null = null;
        if (type === 'session.created') dispatcher = 'session_start.sh';
        else if (type === 'session.idle') dispatcher = 'stop.sh';
        else if (type === 'session.compacted') dispatcher = 'pre_compact.sh';
        if (!dispatcher) return;
        // session_id in the payload so session_start registers the lease.
        dispatch(root, dispatcher, JSON.stringify({ session_id: currentSessionId || '' }));
      } catch {
        // lifecycle hooks are advisory; never fail the session over them
      }
    },
  };
};

export default CawsPlugin;
