import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { assertMachinePath } from '../../init/machine-paths';
import { heartbeatAgentActivity } from '../../application/agent-heartbeat';
import { pollAgentMessages } from '../../application/message-poll';
import { executeAgentHeartbeat } from '../agent-heartbeat';
import type { HandlerResult } from '../composer';
import { readOperationalFile } from '../operational-files';
import type { ActiveInvocationSelection, SelectedSource } from '../selection';
import type { StockHandlerContext } from '../stock-handlers';
import { readNativeFileAuthority, type NativeFileAuthority } from './authority';
import type { FileToolContextSnapshot, NativeFileToolContextPort } from './context-port';
import { FILE_TOOL_CONTEXT_V2_CAPABILITY, GUARD_STRIKES_V2_CAPABILITY } from './metadata';
import { readQwenOriginalWrite } from './original-operation';
import { evaluateNativeShortcutLanguage } from './shortcut-language';
import type { GuardStrikeCommit, NativeGuardStrikesPort } from './strikes-port';
import { captureNativeFileTargetImage, type NativeFileTargetResult } from './target-image';

const ORDER = Object.freeze([
  'agent-heartbeat.sh',
  'cwd-guard.sh',
  'block-dangerous.sh',
  'worktree-guard.sh',
  'scope-guard.sh',
  'worktree-write-guard.sh',
  'bash-write-guard.sh',
  'protected-paths.sh',
  'shortcut-language-check.sh',
  'scan-secrets.sh',
  'quiet-merge.sh',
]);
const SOURCE_LIMIT = 2 * 1024 * 1024;
const TOTAL_SOURCE_LIMIT = 16 * 1024 * 1024;
const empty = (): HandlerResult => ({
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
});
function block(reason: string): HandlerResult {
  return {
    ...empty(),
    exitCode: 2,
    stdout: Buffer.from(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n'
    ),
    // Qwen exit 2 reports the blocking reason through stderr.
    stderr: Buffer.from(reason + '\n'),
  };
}
function advice(reason: string, ask = false): HandlerResult {
  return {
    ...empty(),
    stdout: Buffer.from(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          ...(ask
            ? { permissionDecision: 'ask', permissionDecisionReason: reason }
            : { additionalContext: reason }),
        },
      }) + '\n'
    ),
  };
}
function need(value: unknown, reason: string): asserts value {
  if (!value) throw new Error('Native Qwen file plan refused: ' + reason);
}
function identity(file: string): string {
  const stat = lstatSync(file, { bigint: true });
  need(stat.isFile() && stat.nlink === 1n, 'selected source is not a single regular file');
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}
function selectedSources(selection: ActiveInvocationSelection): readonly SelectedSource[] {
  return [
    ...selection.handlers,
    ...Object.values(selection.libraries),
    ...(selection.transcriptAdapter ? [selection.transcriptAdapter] : []),
  ];
}
export interface NativeFileGuardPlan {
  execute(handler: ActiveInvocationSelection['handlers'][number]): Promise<HandlerResult>;
  /** Actual delivered context3 remains enclosed by the returned synchronous seal. */
  finalize(): Promise<() => void>;
}
export interface NativeFileGuardPlanInput extends StockHandlerContext {
  readonly captured: FileToolContextSnapshot;
  readonly contextPort: NativeFileToolContextPort;
  readonly strikes: NativeGuardStrikesPort;
  readonly machineHome: string;
  readonly observeStrike: (
    operation: 'increment_scope_guard' | 'increment_shortcut_language',
    commit: GuardStrikeCommit
  ) => void;
}
/** Complete first default11 profile. Unknown extensions are never interpreted. */
export function prepareNativeFileGuardPlan(input: NativeFileGuardPlanInput): NativeFileGuardPlan {
  const { request, selection, signal, contextPort, strikes, captured } = input;
  need(
    request.surface === 'qwen-code' &&
      request.fileToolContext === FILE_TOOL_CONTEXT_V2_CAPABILITY &&
      request.guardStrikes === GUARD_STRIKES_V2_CAPABILITY &&
      request.configuration === 'system' &&
      request.event === 'pre_tool_use',
    'unsupported original consumer'
  );
  const original = readQwenOriginalWrite(request.inputJson, request.payload);
  const payload = original.payload;
  const sid = original.sessionId;
  const sessionCwd = Object.hasOwn(payload, 'cwd') ? (payload.cwd as string) : request.caller.cwd;
  const home = request.caller.environment.HOME;
  need(typeof home === 'string' && isAbsolute(home), 'original absolute HOME unavailable');
  need(
    typeof contextPort.finalize === 'function' &&
      typeof contextPort.association === 'function' &&
      typeof strikes.incrementShortcutLanguage === 'function',
    'V2 ports unavailable'
  );
  const association = contextPort.association();
  need(
    /^[a-f0-9]{64}$/.test(association.token) && /^[a-f0-9]{64}$/.test(association.snapshotToken),
    'delivered association unavailable'
  );
  need(
    selection.configuration === 'system' &&
      selection.surface === request.surface &&
      selection.event === request.event &&
      selection.runtimeDigest === request.runtimeDigest &&
      selection.checkout === captured.checkout &&
      selection.canonical === captured.canonical &&
      selection.hooksDirectory === selection.runtimeDirectory &&
      Object.keys(selection.overrides).length === 0 &&
      Object.keys(selection.libraryOverrides).length === 0 &&
      Object.values(selection.libraries).every((entry) =>
        ['surface', 'shared'].includes(entry.kind)
      ) &&
      selection.handlers.length === ORDER.length &&
      selection.handlers.every(
        (handler, index) =>
          handler.name === ORDER[index] &&
          handler.entry === handler.name &&
          handler.kind === 'stock' &&
          handler.tier === 'stock' &&
          handler.args.length === 0 &&
          handler.path === join(selection.runtimeDirectory, handler.name)
      ),
    'unsupported selected chain or extension contract'
  );
  need(
    !['CAWS_HOOK_DRY_RUN', 'CLAUDE_HOOK_DRY_RUN', 'CODEX_HOOK_DRY_RUN'].some((key) =>
      Boolean(input.environment[key] && input.environment[key] !== '0')
    ),
    'dry-run cannot authorize native files'
  );
  const requestKey = JSON.stringify(request);
  const selectionKey = JSON.stringify(selection);
  const checkpoint = (): void => {
    need(
      !signal.aborted && Date.now() < request.deadlineEpochMs,
      'cancelled or original deadline expired'
    );
  };
  const assertBindings = (): void => {
    checkpoint();
    need(JSON.stringify(request) === requestKey, 'original request changed');
    need(JSON.stringify(selection) === selectionKey, 'selected source plan changed');
    const current = contextPort.association!();
    need(
      current.token === association.token && current.snapshotToken === association.snapshotToken,
      'native association changed'
    );
    checkpoint();
  };
  const sourceImage = (): string => {
    assertBindings();
    let total = 0;
    const receipts = selectedSources(selection).map((source) => {
      checkpoint();
      assertMachinePath(selection.runtimeDirectory, source.path);
      const before = identity(source.path);
      const bytes = readOperationalFile(selection.runtimeDirectory, source.path, SOURCE_LIMIT);
      total += bytes.length;
      need(total <= TOTAL_SOURCE_LIMIT, 'selected source total exceeds bound');
      const hash = createHash('sha256').update(bytes).digest('hex');
      need(hash === source.sha256, 'selected source bytes disagree');
      need(identity(source.path) === before, 'source changed while read');
      return [source.path, before, hash];
    });
    checkpoint();
    return JSON.stringify(receipts);
  };
  const sources = sourceImage();
  const requireNoLatch = (): void => {
    for (const root of new Set([captured.checkout, captured.canonical])) {
      const file = join(root, '.qwen/hooks/state', 'danger-latch-' + sid + '.json');
      assertMachinePath(root, file);
      try {
        lstatSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('Original Qwen session is quarantined');
    }
  };
  let next = 0,
    terminal = false,
    finalAttempted = false,
    secondDelivered = false;
  let authority: NativeFileAuthority | undefined;
  let target: NativeFileTargetResult | undefined;
  return Object.freeze({
    async execute(handler: ActiveInvocationSelection['handlers'][number]): Promise<HandlerResult> {
      assertBindings();
      need(!terminal && !finalAttempted, 'handler after terminal/finalization');
      need(handler === selection.handlers[next], 'foreign, repeated or out-of-order handler');
      next++;
      const refuse = (reason: string): HandlerResult => {
        terminal = true;
        return block(reason);
      };
      try {
        switch (handler.name) {
          case 'agent-heartbeat.sh':
            return await executeAgentHeartbeat(input, {
              heartbeat: (options) =>
                heartbeatAgentActivity({
                  ...options,
                  identity: { ...options.identity, platform: original.surface },
                }),
              poll: pollAgentMessages,
              now: () => new Date(),
              leaseContext: async () => ({
                repo_root: captured.canonical,
                cwd: sessionCwd,
                git_common_dir: captured.commonDir,
                git_dir: captured.gitDir,
                ...(captured.branch !== null ? { branch: captured.branch } : {}),
                hook_pid: request.caller.processId,
                hostname: hostname(),
              }),
            });
          case 'cwd-guard.sh':
            return empty();
          case 'block-dangerous.sh':
            requireNoLatch();
            return empty();
          case 'scope-guard.sh': {
            authority = readNativeFileAuthority({
              context: captured,
              originalSessionId: sid,
              surface: original.surface,
              checkpoint,
            });
            target = captureNativeFileTargetImage({
              payload,
              authority,
              sessionCwd,
              home,
              machineHome: input.machineHome,
              checkpoint,
            });
            if (target.kind === 'scope-miss') {
              const commit = await strikes.incrementScopeGuard();
              input.observeStrike('increment_scope_guard', commit);
              assertBindings();
              return refuse(
                'CAWS scope-guard: ' +
                  target.reason +
                  ' (' +
                  target.rule +
                  '); strike ' +
                  commit.count +
                  '. Target has no current scope admission.'
              );
            }
            return empty();
          }
          case 'worktree-write-guard.sh': {
            need(authority && target?.kind === 'admitted', 'target was not admitted');
            const fresh = await contextPort.revalidate();
            assertBindings();
            authority.assertCurrent(fresh);
            target.assertCurrent();
            secondDelivered = true;
            return empty();
          }
          case 'protected-paths.sh':
            need(target?.kind === 'admitted', 'protected target was not admitted');
            target.assertCurrent();
            return empty();
          case 'shortcut-language-check.sh': {
            need(secondDelivered && target?.kind === 'admitted', 'context2 or target unavailable');
            const language = evaluateNativeShortcutLanguage(
              {
                originalTool: 'Write',
                relativePath: target.relativePath,
                content: target.proposedContent,
                preimage: target.preimage,
              },
              checkpoint
            );
            if (language.kind !== 'hit') return empty();
            const commit = await strikes.incrementShortcutLanguage!();
            input.observeStrike('increment_shortcut_language', commit);
            assertBindings();
            const reason =
              'CAWS shortcut-language: ' +
              language.rule +
              ' at ' +
              target.relativePath +
              ':' +
              language.line +
              '; strike ' +
              commit.count +
              '. Replace the authored placeholder or stub with the intended implementation.';
            if (commit.count >= 3) return refuse(reason);
            if (commit.count === 2) {
              if (input.environment.CAWS_GUARD_NO_ASK === '1')
                return refuse(reason + ' User approval is unavailable.');
              return advice(reason, true);
            }
            return advice(reason);
          }
          case 'scan-secrets.sh': {
            need(target?.kind === 'admitted', 'secret target unavailable');
            if (
              /\/(?:node_modules|dist|build|\.git)\//.test(target.target) ||
              /\.(?:png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot|zip|tar|gz|bin)$/.test(target.target)
            )
              return empty();
            const hits = new Set<string>();
            for (const line of target.proposedContent.split('\n')) {
              checkpoint();
              if (line.includes('PRIVATE_KEY') || line.includes('private_key'))
                hits.add('private key material');
              if (/AKIA[0-9A-Z]{16}/.test(line)) hits.add('possible AWS access key');
              if (/gh[pousr]_[A-Za-z0-9_]{36,}/.test(line)) hits.add('possible GitHub token');
            }
            return hits.size
              ? advice(
                  'scan-secrets: possible secret in ' +
                    basename(target.target) +
                    ': ' +
                    [...hits].join(', ') +
                    '. Do not commit credentials. (Advisory — allowed.)'
                )
              : empty();
          }
          case 'worktree-guard.sh':
          case 'bash-write-guard.sh':
          case 'quiet-merge.sh':
            return empty();
          default:
            return refuse('Unsupported native file handler');
        }
      } catch (error) {
        return refuse('CAWS native Qwen file authorization refused: ' + String(error));
      }
    },
    async finalize(): Promise<() => void> {
      need(!finalAttempted, 'finalization replay');
      finalAttempted = true;
      assertBindings();
      need(
        !terminal &&
          next === ORDER.length &&
          secondDelivered &&
          authority &&
          target?.kind === 'admitted',
        'incomplete nonblocking file dispatch'
      );
      const retainedAuthority = authority;
      const retainedTarget = target;
      const fresh = await contextPort.finalize!();
      let sealed = false;
      return (): void => {
        need(!sealed, 'synchronous seal replay');
        sealed = true;
        assertBindings();
        retainedAuthority.assertCurrent(fresh);
        retainedTarget.assertCurrent();
        requireNoLatch();
        need(sourceImage() === sources, 'selected source identity changed');
        checkpoint();
      };
    },
  });
}
