/*
CAWS-MANAGED-HOOK
# hook_pack: opencode
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 1,4,6,8,11,12,13,16,17,19,22,23,24,25,26,27,28,29,30,31
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
// inside tool.execute.before (the message becomes the tool-failure reason the
// agent sees). The shim parses the dispatcher's stdout decision + exit code
// and throws on block / ask (ask degrades to block — opencode has no
// PreToolUse ask; matches the codex adapter precedent).
//
// Fail posture: if .caws/hooks/ is absent (CAWS not installed for this repo),
// the shim fails OPEN (allow) and logs once — it never blocks every tool.
// The shared dispatchers' own fail posture handles the "core lib missing" case.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SURFACE = 'opencode';
const UNKNOWN_ROOT = '';

let cachedRoot: string | null = null;
let warnedMissing = false;

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
}

// Interpret a shared dispatcher's stdout JSON + exit code as a block/warn/allow.
function readDecision(stdout: string, exitCode: number): Decision {
  const empty: Decision = { block: false, reason: '', warn: '' };
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
    if (decision === 'block') return { block: true, reason, warn: '' };
    // ask degrades to block (opencode has no PreToolUse ask; codex precedent).
    if (perm === 'ask' || perm === 'deny') return { block: true, reason, warn: '' };
    if (decision === 'warn' || (typeof obj.advisory === 'string' && obj.advisory)) {
      empty.warn = obj.advisory || reason;
    }
  }
  // Exit 2 is the dispatcher's hard-block convention even without parseable JSON.
  if (exitCode === 2) {
    return {
      block: true,
      reason: stdout.trim() || 'CAWS guard blocked this operation (dispatcher exit 2).',
      warn: '',
    };
  }
  return empty;
}

interface ToolInput {
  tool: string;
}

interface LogClient {
  app?: {
    log?: (args: {
      body: { level: string; message: string; service?: string };
    }) => Promise<unknown>;
  };
}

async function advisoryLog(client: LogClient | undefined, message: string) {
  if (!message) return;
  try {
    await client?.app?.log?.({
      body: { level: 'warn', message, service: 'caws' },
    });
  } catch {
    // advisory logging is best-effort; never fail a tool call over it
  }
}

interface CawsPluginCtx {
  worktree?: string | null;
  directory?: string | null;
  project?: { path?: string | null } | null;
  client?: LogClient;
}

export const CawsPlugin = async (ctx: CawsPluginCtx) => {
  return {
    // PreToolUse analogue. Blocking path: throw on a block/ask decision.
    'tool.execute.before': async (input: ToolInput, output: { args: Record<string, unknown> }) => {
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
      const payload = JSON.stringify({
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: '',
      });

      const res = dispatch(root, 'pre_tool_use.sh', payload);
      const decision = readDecision(res.stdout, res.exitCode);
      if (decision.warn) await advisoryLog(ctx.client, decision.warn);
      if (decision.block) {
        throw new Error(decision.reason);
      }
    },

    // PostToolUse analogue: audit + advisory quality checks. Never blocks.
    'tool.execute.after': async (input: ToolInput, output: { args: Record<string, unknown> }) => {
      try {
        const root = resolveProjectRoot(ctx);
        if (root === UNKNOWN_ROOT) return;
        const toolName = mapToolName(input?.tool || '');
        const toolInput = normalizeArgs(output?.args);
        const payload = JSON.stringify({
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: '',
        });
        const res = dispatch(root, 'post_tool_use.sh', payload);
        const decision = readDecision(res.stdout, res.exitCode);
        if (decision.warn) await advisoryLog(ctx.client, decision.warn);
      } catch {
        // post-tool audit must never interfere with a completed tool call
      }
    },

    // Session lifecycle via the bus. Best-effort; never throws.
    event: async (ev: { event?: { type?: string; properties?: any } } | undefined) => {
      try {
        const type = ev?.event?.type;
        if (!type) return;
        const root = resolveProjectRoot(ctx);
        if (root === UNKNOWN_ROOT) return;
        let dispatcher: string | null = null;
        if (type === 'session.created') dispatcher = 'session_start.sh';
        else if (type === 'session.idle') dispatcher = 'stop.sh';
        else if (type === 'session.compacted') dispatcher = 'pre_compact.sh';
        if (!dispatcher) return;
        dispatch(root, dispatcher, '{}');
      } catch {
        // lifecycle hooks are advisory; never fail the session over them
      }
    },
  };
};

export default CawsPlugin;
