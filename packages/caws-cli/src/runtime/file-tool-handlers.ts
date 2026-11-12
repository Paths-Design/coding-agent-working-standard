import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { evaluatePath, matchGlob, type WorktreeRegistry } from '../kernel';
import { assertMachinePath } from '../init/machine-paths';
import { loadPolicy } from '../store/policy-store';
import { loadSpecs } from '../store/specs-store';
import { loadWorktrees } from '../store/worktrees-store';
import { loadBridges } from '../store/bridge-store';
import { resolveBinding } from '../shell/binding/resolve-binding';
import { normalizeCodexFileTool, type CodexFileTool } from './codex-file-tools';
import { environmentHookIdentity } from './identity';
import { mangleGuardName } from './guard-config-loader';
import { executeAgentHeartbeat } from './agent-heartbeat';
import { heartbeatAgentActivity } from '../application/agent-heartbeat';
import { pollAgentMessages } from '../application/message-poll';
import {
  assertFileToolContextRoots,
  type FileToolContextBinding,
  type FileToolContextSnapshot,
} from './file-tool-context';
import { FILE_TOOL_CONTEXT_CAPABILITY, GUARD_STRIKES_CAPABILITY } from './protocol';
import { readOperationalFile } from './operational-files';
import { qualifiesForNativeSessionCache } from './session-cache-admission';
import { qualifiesForFileToolHeartbeat } from './stock-handlers';
import {
  observeWorktreeOwner,
  observeWorktreeOwnership,
  type WorktreeOwnershipRoot,
} from './worktree-ownership';
import type { HandlerResult } from './composer';
import type { SelectedHandler } from './selection';
import type { StockHandlerContext } from './stock-handlers';

interface FileToolHandlerContext extends StockHandlerContext {
  readonly nativeFileToolContext?: FileToolContextBinding;
}

/** Exact stock semantics being replaced, independently of the installed generation digest. */
const HANDLERS: Readonly<Record<string, string>> = {
  // The heartbeat has one typed implementation, admitted in stock-handlers.ts;
  // this identity follows that one so the two routes cannot disagree about it.
  'agent-heartbeat.sh': 'a42ba59f826763dae26818b3b2d624c708f33a6f5ddf9a702c34d124faeecc0f',
  'cwd-guard.sh': '7bbef58ccc698002419ad665191cb095e4da99fb1331c79c8954b11c5657edd0',
  'block-dangerous.sh': '636f16dba6556cca02782e1df88864dafa920a35c38424afc88457a90cf57bb5',
  'worktree-guard.sh': 'e58c6b25b4c1de157910cc16523f84070917b5b8a00ab06c80bb97017eeb22a2',
  'scope-guard.sh': '36cd1dc511641035e23b8aff9363d91921d388a8bebaf7fe391be0798457df77',
  'worktree-write-guard.sh': '737ef2a0b6b6a4b4a87ed65cb2a45e56e81b9c95f0b803d6c076dce6e93c41a9',
  'bash-write-guard.sh': 'e19864cc22b8a773fe6f7f20c91f589a0f7f36f725d5b7600698f50a161b79df',
  'protected-paths.sh': '0465b0405e5883d6b8b38e1fe350443b6325bc3ae71d9ade20bf851eb05e58f5',
  'scan-secrets.sh': 'f80c4758222163071dcb0e021c0a6f4b42b076e2ec17e38d8a036d760c36d533',
  'quiet-merge.sh': '94581e2f7c87b7bf61c56c2b475c58c057b12abc10a7dbbd978d24d9fe3515a8',
};
const SHORTCUT_HANDLER = 'shortcut-language-check.sh';
const SHORTCUT_SOURCE_SHA = 'ee7fe03218f72f66e16479a8f96d3e2eb9f42d2cad8a22f8bc892b6d21c929df';
const PATCH_HANDLERS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([
    ...Object.entries(HANDLERS).slice(0, 8),
    [SHORTCUT_HANDLER, SHORTCUT_SOURCE_SHA],
    ...Object.entries(HANDLERS).slice(8),
  ])
);
interface HandlerSourceProfile {
  readonly handlers: Readonly<Record<string, string>>;
  readonly sessionId: string;
}
const HISTORICAL_SESSION_ID = 'cf662f10e6d3477cecbf5deabd8d2b63284f6f4ac14fa7070725ff8502515c53';
const CURRENT_SESSION_ID = 'dac4866c1576b65732ab3eb5b350fd978b3b746c6bce02b484210a1ce3676c8c';
const CURRENT_HANDLERS: Readonly<Record<string, string>> = Object.freeze({
  ...HANDLERS,
  'block-dangerous.sh': '9e8a238b619632744edf0960d44b6c0d98bac546a36f0092147e8566955084f5',
  'worktree-write-guard.sh': '9c71094f1b7d9eba7803163ebf7f20cff4f6fa4f2cf3b84817ca2b5882791aa7',
});
const CURRENT_PATCH_HANDLERS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PATCH_HANDLERS).map(([name, digest]) => [name, CURRENT_HANDLERS[name] ?? digest])
  )
);
const SOURCE_PROFILES: readonly HandlerSourceProfile[] = Object.freeze([
  Object.freeze({ handlers: HANDLERS, sessionId: HISTORICAL_SESSION_ID }),
  Object.freeze({ handlers: PATCH_HANDLERS, sessionId: HISTORICAL_SESSION_ID }),
  Object.freeze({ handlers: CURRENT_HANDLERS, sessionId: CURRENT_SESSION_ID }),
  Object.freeze({ handlers: CURRENT_PATCH_HANDLERS, sessionId: CURRENT_SESSION_ID }),
]);
function selectedHandlerProfile(context: StockHandlerContext): HandlerSourceProfile | undefined {
  return SOURCE_PROFILES.find((profile) => {
    const names = Object.keys(profile.handlers);
    return (
      (!Object.hasOwn(profile.handlers, SHORTCUT_HANDLER) ||
        context.request.payload.tool_name === 'apply_patch') &&
      context.selection.libraries['session-id.sh']?.sha256 === profile.sessionId &&
      context.selection.handlers.length === names.length &&
      context.selection.handlers.every(
        (handler, index) =>
          handler.name === names[index] && handler.sha256 === profile.handlers[handler.name]
      )
    );
  });
}
const SOURCES: Readonly<Record<string, string>> = {
  ...HANDLERS,
  'guard-strikes.sh': '8253de9371aadd20c1e441155b4a19487e5ae7887c6da4358d8f7b31b9719e0a',
  'lib/caws-state.sh': '8a3484f121b0751e566cb7173406c1eb296154af3c1fa08ca09927acd7fdf837',
  'lib/write-allowlist.sh': 'f0eba9d9a03d65b68d7f0808f820593bc4711dd96dd31285d329ad52f65fcdd1',
  'lib/worktree-claim-oracle.cjs':
    'b16a51b7f721e7787c889374d59a33aec662e7bf2636305bda8eaaade73184e7',
  'lib/guard-message.sh': '7b8a131c93cefb31c4205564f4429586325a292924ea809c396b4b154004e148',
  'lib/ask-capability.sh': '7aa8a0be53438fb45f82c3feae7d7043abb9b2734f77048a41794ac3d52ead30',
  'lib/guard-config.sh': 'c3d9d5b0f6ffb4eb6add5a3f27b2d3d2bf7f46d86b39614c351e8b5bba06c73c',
  'lib/guard-config.cjs': 'b7947a24da1670613bb43a548be9951d7fe3be6d4be2f9418607a35dac945a85',
};
const empty = (): HandlerResult => ({
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
});
const block = (reason: string): HandlerResult => ({
  ...empty(),
  exitCode: 2,
  stdout: Buffer.from(JSON.stringify({ decision: 'block', reason }) + '\n'),
});
const notice = (text: string): HandlerResult => ({
  ...empty(),
  stdout: Buffer.from(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: text,
      },
    }) + '\n'
  ),
});
const inside = (root: string, file: string): boolean =>
  file === root || file.startsWith(root + '/');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Resolve parent traversal through the filesystem before appending an absent final entry. */
function physicalEntry(spelling: string): string {
  try {
    return fs.realpathSync.native(spelling);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink is an existing entry, not an absent creation target.
    // Refuse it (including ancestors) instead of checking the link spelling.
    if (present(spelling)) throw new Error('Existing file-tool path cannot be resolved physically');
    const parent = dirname(spelling);
    if (parent === spelling) throw error;
    return join(physicalEntry(parent), basename(spelling));
  }
}
function present(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function sourceValid(context: StockHandlerContext): boolean {
  const { selection } = context;
  const profile = selectedHandlerProfile(context);
  if (!profile) return false;
  const sources = { ...SOURCES, ...profile.handlers, 'lib/session-id.sh': profile.sessionId };
  try {
    for (const [name, expected] of Object.entries(sources)) {
      const file = join(selection.runtimeDirectory, name);
      assertMachinePath(selection.runtimeDirectory, file);
      const bytes = readOperationalFile(selection.runtimeDirectory, file, 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}
/** Existing armed-latch escalation stays on its complete original route before prefix effects. */
function latchAbsent(context: StockHandlerContext): boolean {
  const { selection } = context;
  for (const root of new Set([selection.checkout, selection.canonical])) {
    const directory = join(root, '.codex/hooks/state');
    try {
      assertMachinePath(root, directory);
      if (fs.readdirSync(directory).some((name) => /^danger-latch-.*\.json$/.test(name)))
        return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

interface Authority {
  readonly registry: WorktreeRegistry;
  readonly specs: ReturnType<typeof loadSpecs>['specs'];
  readonly policy: NonNullable<ReturnType<typeof loadPolicy>['policy']>;
  readonly bridges: ReturnType<typeof loadBridges>;
}
function authority(context: StockHandlerContext): Authority {
  const directory = join(context.selection.canonical, '.caws');
  assertMachinePath(context.selection.canonical, directory);
  const policy = loadPolicy(directory);
  const specs = loadSpecs(directory);
  const registry = loadWorktrees(directory);
  const bridges = loadBridges(directory);
  if (
    !policy.policy ||
    policy.errors.length ||
    specs.diagnostics.some((entry) => entry.severity === 'error') ||
    !registry.ok ||
    !bridges.ok
  )
    throw new Error('canonical policy, spec, registry or bridge authority unavailable');
  return { registry: registry.value, specs: specs.specs, policy: policy.policy, bridges };
}
function roots(context: StockHandlerContext, state: Authority): { name: string; root: string }[] {
  const result: { name: string; root: string }[] = [];
  for (const [name, entry] of Object.entries(state.registry)) {
    if (!object(entry)) throw new Error('malformed worktree row');
    if (entry.status === 'destroyed' || entry.status === 'missing') continue;
    let spelling: string;
    if (Object.hasOwn(entry, 'path')) {
      if (typeof entry.path !== 'string' || entry.path.length === 0)
        throw new Error('worktree root has a malformed explicit path');
      spelling = entry.path;
    } else {
      spelling = join(context.selection.canonical, '.caws/worktrees', name);
    }
    if (!isAbsolute(spelling)) throw new Error('worktree root is not an absolute path');
    if (!present(spelling)) continue;
    if (fs.lstatSync(spelling).isSymbolicLink())
      throw new Error('worktree root is not a physical absolute directory');
    const root = fs.realpathSync.native(spelling);
    if (!fs.statSync(root).isDirectory() || inside(root, context.selection.canonical))
      throw new Error('worktree root overlaps canonical authority');
    result.push({ name, root });
  }
  return result;
}
function prefixes(context: StockHandlerContext, key: string): string[] {
  const env = context.environment;
  key = mangleGuardName(key);
  const count = Number(env['CAWS_GUARD_PREFIX_COUNT_' + key] || 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 4096)
    throw new Error('invalid guard prefix count');
  return Array.from(
    { length: count },
    (_, index) => env['CAWS_GUARD_PREFIX_' + key + '_' + index] || ''
  );
}
function scopePrefixes(context: StockHandlerContext): string[] {
  const env = context.environment;
  const result = ['.caws/', '.codex/', 'docs/', 'tests/', 'scripts/', 'tmp/', '.archive/'];
  if (env.HOME) result.push(env.HOME + '/.codex/');
  const count = Number(env.CAWS_GUARD_ZONE_COUNT || 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 4096)
    throw new Error('invalid guard zone count');
  for (let index = 0; index < count; index++) {
    const zone = env['CAWS_GUARD_ZONE_' + index];
    if (zone) result.push(zone);
  }
  return result.concat(prefixes(context, 'scope-guard.sh').filter(Boolean));
}
function targets(context: StockHandlerContext, tool: CodexFileTool): string[] {
  const cwd =
    typeof context.request.payload.cwd === 'string' && context.request.payload.cwd
      ? context.request.payload.cwd
      : context.selection.checkout;
  return tool.targets.map((file) => physicalEntry(isAbsolute(file) ? file : cwd + '/' + file));
}

/** One mutation requests one Native transaction after every target passes hard-refusal checks. */
async function progression(
  context: FileToolHandlerContext,
  detail: string
): Promise<HandlerResult> {
  const rawSid = context.request.payload.session_id;
  const sid = typeof rawSid === 'string' && rawSid !== 'unknown' ? rawSid : null;
  if (!sid || !context.environment.HOME)
    return block('CAWS scope-guard: unresolved strike identity');
  const native = context.nativeFileToolContext;
  if (!native)
    throw new Error('Native scope-strike transaction unavailable; compatibility replay refused');
  const { count } = await native.incrementScopeGuard();
  const reason = `CAWS scope-guard strike ${Math.min(count, 3)} of 3. ${detail}`;
  if (count === 1)
    return notice(
      reason + ' This edit proceeds, but a second out-of-scope edit requires user approval.'
    );
  if (count === 2)
    return {
      ...empty(),
      stdout: Buffer.from(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason + ' Blocked; user approval is required.',
          },
        }) + '\n'
      ),
    };
  return block(reason + ' Hard-blocked until scope is corrected; strike reset is human-only.');
}

async function scope(context: FileToolHandlerContext, tool: CodexFileTool): Promise<HandlerResult> {
  const state = authority(context);
  const registered = roots(context, state);
  const allowed = scopePrefixes(context);
  const sid = environmentHookIdentity(context.request.payload, context.environment, 'codex');
  let advisory = '';
  for (const file of targets(context, tool)) {
    const targetRoot = registered.find(({ root }) => inside(root, file))?.root;
    const work = targetRoot || context.selection.checkout;
    const rel = inside(work, file)
      ? relative(work, file)
      : inside(context.selection.canonical, file)
        ? relative(context.selection.canonical, file)
        : file;
    if (isAbsolute(rel) && !allowed.some((prefix) => isAbsolute(prefix) && file.startsWith(prefix)))
      return block(
        `CAWS scope-guard: '${file}' is in a DIFFERENT repository than this session's project. The entire edit is refused.`
      );
    if (allowed.some((prefix) => file.startsWith(prefix) || rel.startsWith(prefix))) continue;
    const bound = resolveBinding({
      repoRoot: context.selection.canonical,
      cwd: work,
      registry: state.registry,
      specs: state.specs,
      targetPath: rel,
      gitWorktreeList: () => [],
      ...(state.bridges.ok ? { bridges: state.bridges.value.bridges } : {}),
      ...(sid ? { sessionId: sid } : {}),
    });
    if (bound.binding.kind === 'one_sided')
      return block('CAWS scope-guard: one-sided or malformed bound spec; edit refused.');
    const decision = evaluatePath(rel, bound.binding, state.policy);
    if (decision.kind === 'admit') continue;
    if (decision.kind === 'invalid_path')
      return block('CAWS scope-guard: invalid target path; edit refused.');
    if (
      decision.kind === 'reject' &&
      decision.rule.endsWith('scope_out') &&
      ['bound', 'bridged'].includes(bound.binding.kind)
    )
      return block(
        `CAWS scope-guard: '${rel}' is marked out-of-scope. The edit is refused before any write.`
      );
    advisory ||= `Path '${rel}' is not in the defined scope${bound.ambiguous ? '; ambiguous authority' : ''}. ${decision.message}`;
  }
  return advisory ? progression(context, advisory) : empty();
}

function writeAllowlisted(context: StockHandlerContext, file: string, logical: string): boolean {
  if (logical.startsWith('.caws/worktrees/')) return false;
  if (context.environment.HOME && file.startsWith(context.environment.HOME + '/.codex/'))
    return true;
  if (
    ['.caws/', '.codex/', '.tmp/', 'tmp/', '.archive/', '.githooks/', '.github/', 'docs/'].some(
      (prefix) => logical.startsWith(prefix)
    ) ||
    logical === '.gitignore' ||
    logical === 'AGENTS.md'
  )
    return true;
  return prefixes(context, 'write-allowlist.sh').some(
    (prefix) =>
      prefix !== '' && (isAbsolute(prefix) ? file.startsWith(prefix) : logical.startsWith(prefix))
  );
}
function ownership(
  context: StockHandlerContext,
  tool: CodexFileTool,
  observed: FileToolContextSnapshot
): HandlerResult {
  assertFileToolContextRoots(observed, context.selection.checkout, context.selection.canonical);
  const state = authority(context);
  const sid = environmentHookIdentity(context.request.payload, context.environment, 'codex');
  const census: WorktreeOwnershipRoot[] = [];
  for (const [name, record] of Object.entries(state.registry)) {
    if (object(record) && ['destroyed', 'missing'].includes(String(record.status))) continue;
    const raw: Record<string, unknown> = object(record) ? record : {};
    const ownerPresent = Object.hasOwn(raw, 'owner');
    let root: string | null = null;
    try {
      root = roots(context, { ...state, registry: { [name]: record } })[0]?.root ?? null;
    } catch {
      // An unresolved active row cannot establish absence of ownership.
    }
    census.push({ name, root, ownerPresent, owner: ownerPresent ? raw.owner : undefined });
  }
  const files = tool.targets.map((target): string | null => {
    try {
      return targets(context, { ...tool, targets: [target] })[0] ?? null;
    } catch {
      return null;
    }
  });
  const observations = observeWorktreeOwnership({
    canonical: context.selection.canonical,
    sessionId: sid,
    roots: census,
    targets: files,
  });
  const foreign = observations.find((entry) => entry.kind === 'foreign_owner');
  if (foreign?.kind === 'foreign_owner')
    return block(
      `CAWS worktree-write-guard: worktree '${foreign.worktree}' is owned by a different session.`
    );
  const registered = census.flatMap(({ name, root }) => (root === null ? [] : [{ name, root }]));
  const acting = registered
    .filter(({ root }) => inside(root, observed.checkout))
    .sort((left, right) => right.root.length - left.root.length)[0];
  const ownerSelf = (name: string): boolean => {
    const row = census.find((entry) => entry.name === name);
    if (!row) return false;
    const owner = observeWorktreeOwner(row);
    return owner.kind === 'confirmed' && owner.sessionId === sid;
  };
  // Canonical claims survive an unresolved physical root. Inspect every active row.
  const claimed = new Set<string>();
  for (const file of files) {
    if (
      file === null ||
      !inside(context.selection.canonical, file) ||
      registered.some(({ root }) => inside(root, file))
    )
      continue;
    const logical = relative(context.selection.canonical, file);
    for (const row of census) {
      const record = state.registry[row.name];
      if (!object(record)) continue;
      const spec = state.specs.find(
        (entry) => entry.id === record.specId && entry.lifecycle_state === 'active'
      );
      if (spec?.worktree !== row.name || matchGlob(logical, spec.scope.in) === null) continue;
      if (acting?.name !== row.name || !ownerSelf(row.name))
        return block(
          `CAWS worktree-write-guard: canonical path '${logical}' is claimed by worktree '${row.name}'.`
        );
      claimed.add(file);
    }
  }
  if (
    context.selection.checkout !== context.selection.canonical &&
    files.some(
      (file) => file !== null && inside(join(context.selection.checkout, '.caws/specs'), file)
    )
  )
    return block('CAWS worktree-write-guard: linked-worktree spec materialization is refused.');
  if (observations.some((entry) => entry.kind === 'unresolved'))
    return block('CAWS worktree-write-guard: unresolved ownership census; edit refused.');
  const unowned = observations.find((entry) => entry.kind === 'payload_without_owner');
  if (unowned?.kind === 'payload_without_owner')
    return block(
      `CAWS worktree-write-guard: worktree '${unowned.worktree}' has no confirmed owner. This harness cannot request approval.`
    );
  let approval = '';
  for (const [index, file] of files.entries()) {
    if (file === null) return block('CAWS worktree-write-guard: unresolved target; edit refused.');
    if (observations[index]?.kind === 'owner_self') continue;
    if (inside(context.selection.canonical + '/.caws/worktrees', file))
      return block('CAWS worktree-write-guard: unregistered worktree payload has no owner.');
    if (!inside(context.selection.canonical, file)) continue;
    const logical = relative(context.selection.canonical, file);
    if (claimed.has(file)) continue;
    if (acting && ownerSelf(acting.name)) continue;
    if (writeAllowlisted(context, file, logical)) continue;
    const registeredForBase =
      observed.branch === null
        ? []
        : registered.filter(({ name }) => state.registry[name]?.baseBranch === observed.branch);
    let activeCount = registeredForBase.length;
    if (activeCount === 0) {
      const live = new Set<string>();
      for (const worktree of observed.worktrees) {
        if (worktree.bare || worktree.prunable || !present(worktree.path)) continue;
        const physical = fs.realpathSync.native(worktree.path);
        if (physical !== context.selection.canonical && fs.statSync(physical).isDirectory())
          live.add(physical);
      }
      activeCount = live.size;
    }
    if (activeCount === 0 || observed.mergeInProgress) continue;
    if (observed.branch === null)
      return block(
        `CAWS worktree-write-guard: current branch could not be established for canonical path '${logical}'; edit refused.`
      );
    approval ||= `CAWS worktree-write-guard: canonical write '${logical}' on branch '${observed.branch}' has ${activeCount} active worktree(s). User approval is required, or operate from the owning worktree.`;
  }
  if (!approval) return empty();
  if (
    context.environment.CAWS_GUARD_NO_ASK === '1' ||
    context.request.payload.permission_mode === 'bypassPermissions'
  )
    return block(approval + ' This harness cannot request approval.');
  // The selected Codex emit_ask contract is deny, never an unsupported ask value.
  return {
    ...empty(),
    stdout: Buffer.from(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: approval,
        },
      }) + '\n'
    ),
  };
}
function protectedPaths(context: StockHandlerContext, tool: CodexFileTool): HandlerResult {
  const machine =
    context.environment.CAWS_HOME ||
    (context.environment.HOME ? context.environment.HOME + '/.caws' : '');
  for (const file of targets(context, tool)) {
    const protectedPrefix =
      /(?:^|\/)\.(?:caws|codex)\/hooks\//.test(file) ||
      Boolean(
        machine &&
          ['bin/', 'lib/', 'surfaces/', 'state/projects/'].some((prefix) =>
            file.startsWith(machine + '/' + prefix)
          )
      ) ||
      file === machine + '/state/adapter-runtime.json' ||
      Boolean(
        machine && file.startsWith(machine + '/state/sessions/') && /\/guard-reprieve-/.test(file)
      );
    if (protectedPrefix && !file.endsWith('.md'))
      return block(
        `CAWS protected-paths: '${file}' is protected. User permission is required for guard edits.`
      );
    if (/\/\.codex\/logs\/guard-strikes-[^/]*\.json$/.test(file))
      return block('CAWS protected-paths: guard strike state is protected.');
  }
  return empty();
}
function secrets(context: StockHandlerContext, tool: CodexFileTool): HandlerResult {
  const first = targets(context, tool)[0]!;
  if (
    /\/(?:node_modules|dist|build|\.git)\//.test(first) ||
    /\.(?:png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot|zip|tar|gz|bin)$/.test(first)
  )
    return empty();
  let content = tool.authoredContent || '';
  if (!content && present(first) && fs.statSync(first).isFile())
    content = readOperationalFile(dirname(first), first, 2 * 1024 * 1024).toString('utf8');
  const hits: string[] = [];
  for (const line of content.split('\n')) {
    if (line.includes('PRIVATE_KEY') || line.includes('private_key'))
      hits.push('private key material');
    if (/AKIA[0-9A-Z]{16}/.test(line)) hits.push('possible AWS access key');
    if (/gh[pousr]_[A-Za-z0-9_]{36,}/.test(line)) hits.push('possible GitHub token');
  }
  return hits.length
    ? notice(
        `scan-secrets: possible secret detected in '${basename(first)}':\n${hits.map((hit) => '  • ' + hit).join('\n')}\nDo not commit credentials. Use environment variables or a secrets manager. (Advisory — allowed.)`
      )
    : empty();
}

export interface FileToolHandlerPlan {
  execute(handler: SelectedHandler): Promise<HandlerResult>;
}
/** Read-only complete-source admission, independent of native context transport. */
export function qualifiesForFileToolHandlers(context: StockHandlerContext): boolean {
  const { request, selection, environment } = context;
  const profile = selectedHandlerProfile(context);
  const handlers = profile?.handlers;
  if (
    !handlers ||
    request.surface !== 'codex' ||
    request.event !== 'pre_tool_use' ||
    !['apply_patch', 'Write', 'Edit'].includes(String(request.payload.tool_name)) ||
    request.configuration !== 'system' ||
    selection.configuration !== 'system' ||
    selection.surface !== request.surface ||
    selection.event !== request.event ||
    selection.runtimeDigest !== request.runtimeDigest ||
    selection.hooksDirectory !== selection.runtimeDirectory ||
    Object.keys(selection.overrides).length ||
    Object.keys(selection.libraryOverrides).length ||
    Object.values(selection.libraries).some(
      (entry) => !['shared', 'surface'].includes(entry.kind)
    ) ||
    selection.handlers.length !== Object.keys(handlers).length ||
    selection.handlers.some(
      (handler, index) =>
        handler.name !== Object.keys(handlers)[index] ||
        handler.entry !== handler.name ||
        handler.tier !== 'stock' ||
        handler.kind !== 'stock' ||
        handler.args.length ||
        handler.path !== join(selection.runtimeDirectory, handler.name) ||
        handler.sha256 !== handlers[handler.name]
    ) ||
    environment.CAWS_PRIOR_BASH_ENV ||
    environment.ENV ||
    environment.NODE_OPTIONS ||
    environment.NODE_PATH ||
    environment.CAWS_GUARD_CONFIG_PY ||
    request.caller.environment.CAWS_GUARD_CONFIG_PY ||
    (environment.CAWS_BIN && environment.CAWS_BIN !== 'caws') ||
    Object.entries(environment).some(
      ([key, value]) =>
        Boolean(value) &&
        (key.startsWith('BASH_FUNC_') || key.startsWith('DYLD_') || key.startsWith('LD_'))
    ) ||
    !qualifiesForNativeSessionCache(context) ||
    !qualifiesForFileToolHeartbeat(selection.handlers[0]!, context) ||
    !sourceValid(context) ||
    !latchAbsent(context)
  )
    return false;
  return true;
}

/** Called before cache/heartbeat effects. Older frontends retain complete compatibility. */
export function prepareFileToolHandlers(
  context: FileToolHandlerContext
): FileToolHandlerPlan | null {
  const { request, selection } = context;
  const native = context.nativeFileToolContext;
  const sourceProfile = selectedHandlerProfile(context);
  if (
    !sourceProfile ||
    request.fileToolContext !== FILE_TOOL_CONTEXT_CAPABILITY ||
    request.guardStrikes !== GUARD_STRIKES_CAPABILITY ||
    !native ||
    typeof native.incrementScopeGuard !== 'function' ||
    !qualifiesForFileToolHandlers(context)
  )
    return null;
  assertFileToolContextRoots(native.captured, selection.checkout, selection.canonical);
  const assertCurrent = (): void => {
    if (context.signal.aborted || Date.now() >= request.deadlineEpochMs)
      throw new Error('File-tool invocation cancelled or expired');
    if (selectedHandlerProfile(context) !== sourceProfile || !qualifiesForFileToolHandlers(context))
      throw new Error(
        'File-tool selected source or latch changed after prefix; compatibility replay refused'
      );
    assertFileToolContextRoots(native.captured, selection.checkout, selection.canonical);
  };
  let inventory: CodexFileTool | null = null;
  let inventoryError = '';
  try {
    inventory = normalizeCodexFileTool(request.payload);
  } catch (error) {
    inventoryError = String(error);
  }
  return Object.freeze({
    async execute(handler: SelectedHandler): Promise<HandlerResult> {
      assertCurrent();
      if (!selection.handlers.includes(handler))
        throw new Error('File-tool handler outside captured stock sequence');
      if (handler.name === 'agent-heartbeat.sh') {
        const captured = native.captured;
        return executeAgentHeartbeat(context, {
          heartbeat: heartbeatAgentActivity,
          poll: pollAgentMessages,
          now: () => new Date(),
          leaseContext: async () => ({
            repo_root: captured.canonical,
            cwd: captured.checkout,
            git_common_dir: captured.commonDir,
            git_dir: captured.gitDir,
            ...(captured.branch !== null ? { branch: captured.branch } : {}),
            hook_pid: request.caller.processId,
            hostname: hostname(),
          }),
        });
      }
      if (handler.name === 'scope-guard.sh' && (inventoryError || !inventory))
        return block(inventoryError || 'Missing file-tool inventory');
      if (!inventory) return empty();
      try {
        switch (handler.name) {
          case 'cwd-guard.sh':
            return fs.existsSync(String(request.payload.cwd || selection.checkout))
              ? empty()
              : {
                  ...empty(),
                  stderr: Buffer.from(
                    `CAWS cwd-guard: working directory is missing or inaccessible: ${String(request.payload.cwd || selection.checkout)}\n`
                  ),
                };
          case 'scope-guard.sh': {
            const result = await scope(context, inventory);
            assertCurrent();
            return result;
          }
          case 'worktree-write-guard.sh': {
            const fresh = await native.revalidate();
            assertCurrent();
            assertFileToolContextRoots(fresh, selection.checkout, selection.canonical);
            return ownership(context, inventory, fresh);
          }
          case 'protected-paths.sh':
            return protectedPaths(context, inventory);
          case SHORTCUT_HANDLER:
            // The stock pre-tool arm returns before content reads for original
            // apply_patch, including Add patches normalized to Write.
            if (request.payload.tool_name !== 'apply_patch')
              throw new Error('Shortcut handler outside supported original apply_patch profile');
            return empty();
          case 'scan-secrets.sh':
            return secrets(context, inventory);
          // Their selected stock file-tool arms are inactive; the armed latch was
          // excluded before prefix effects and remains checked at every handler.
          case 'block-dangerous.sh':
          case 'worktree-guard.sh':
          case 'bash-write-guard.sh':
          case 'quiet-merge.sh':
            return empty();
          default:
            throw new Error('File-tool handler outside captured stock sequence');
        }
      } catch (error) {
        if (handler.name === 'scan-secrets.sh')
          return {
            ...empty(),
            stderr: Buffer.from('[scan-secrets] advisory unavailable: ' + String(error) + '\n'),
          };
        return block(`CAWS ${handler.name}: authority unavailable; edit refused. ${String(error)}`);
      }
    },
  });
}
