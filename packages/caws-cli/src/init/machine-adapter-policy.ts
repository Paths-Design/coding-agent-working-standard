import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertMachinePath, atomicMachineWrite, machineHome } from './machine-adapters';
import { isKnownSurface, resolveHookPack } from './hook-packs/register';
import { readPristineBaseline } from './hook-install';
import { SHARED_PACK } from './hook-packs/manifest-shared';

export const MACHINE_EVENTS = {
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  session_start: 'SessionStart',
  stop: 'Stop',
  pre_compact: 'PreCompact',
} as const;
type Event = keyof typeof MACHINE_EVENTS;
interface EventPolicy {
  hooks_dir: string;
  handlers: string[];
}
export interface SurfacePolicy {
  events: Partial<Record<Event, EventPolicy>>;
  libraries: Record<string, string>;
}
interface ProjectPolicy {
  version: 1;
  surfaces: Record<string, SurfacePolicy>;
}
interface NativeHook {
  command?: string;
  [key: string]: unknown;
}
interface NativeHookGroup {
  hooks: NativeHook[];
  [key: string]: unknown;
}

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const normalize = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
const noVersion = (text: string): string =>
  text.replace(/hook_pack_version:\s*\d+/g, 'hook_pack_version: N');

/** Read a literal handler array, never source/eval project shell during a plan.
 * Only known dispatcher scaffolding is admitted. Custom shell logic outside the
 * array must be reconciled explicitly using --from <surface-policy.json>. */
export function extractMachineHandlers(text: string, reference: string): string[] {
  const array = /^(HANDLERS|_ALL_HANDLERS)=\(\s*\n([\s\S]*?)^\)/m;
  const match = array.exec(text);
  if (!match)
    throw new Error('Dispatcher has no literal handler array; use --from with reviewed policy');
  const skeleton = (body: string): string => normalize(body.replace(array, '$1=(\n)'));
  const legacy = normalize(`set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$HOOKS_DIR/lib/parse-input.sh" 2>/dev/null || exit 0
parse_hook_input || exit 0
source "$HOOKS_DIR/lib/run-handlers.sh" 2>/dev/null || exit 0
HANDLERS=(
)
run_handlers \"\${HANDLERS[@]}\"`);
  const actual = skeleton(text);
  if (
    actual !== skeleton(reference) &&
    actual !== legacy &&
    actual !== legacy.replace('run_handlers ', 'run_handlers --short-circuit-on-block ')
  ) {
    throw new Error(
      'Custom dispatcher logic requires review; use --from with an explicit surface policy'
    );
  }
  const handlers: string[] = [];
  for (const raw of (match[2] as string).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const value = /^(?:"([^"$`\\]+)"|'([^'$`\\]+)'|([A-Za-z0-9_.-]+))(?:\s+#.*)?$/.exec(line);
    const entry = value && (value[1] ?? value[2] ?? value[3]);
    if (!entry || !/^[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*$/.test(entry)) {
      throw new Error(`Nonliteral handler requires review: ${line}`);
    }
    handlers.push(entry);
  }
  return handlers;
}

function validateSurfacePolicy(repo: string, candidate: SurfacePolicy): void {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Object.keys(candidate).sort().join(',') !== 'events,libraries' ||
    !candidate.events ||
    typeof candidate.events !== 'object' ||
    Array.isArray(candidate.events) ||
    !candidate.libraries ||
    typeof candidate.libraries !== 'object' ||
    Array.isArray(candidate.libraries)
  ) {
    throw new Error('Expected surface policy with exactly events and libraries');
  }
  for (const [event, entry] of Object.entries(candidate.events)) {
    if (
      !(event in MACHINE_EVENTS) ||
      !entry ||
      Object.keys(entry).sort().join(',') !== 'handlers,hooks_dir' ||
      !Array.isArray(entry.handlers)
    ) {
      throw new Error(`Invalid event policy: ${event}`);
    }
    if (
      typeof entry.hooks_dir !== 'string' ||
      path.isAbsolute(entry.hooks_dir) ||
      entry.hooks_dir.split('/').includes('..')
    )
      throw new Error('Expected a relative hooks directory');
    const dir = path.resolve(repo, entry.hooks_dir);
    assertMachinePath(repo, dir);
    for (const handler of entry.handlers) {
      if (
        typeof handler !== 'string' ||
        !/^[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*$/.test(handler)
      )
        throw new Error(`Invalid handler: ${handler}`);
      const file = path.join(dir, handler.split(' ')[0] as string);
      assertMachinePath(repo, file);
      fs.accessSync(file, fs.constants.X_OK);
      if (!fs.statSync(file).isFile()) throw new Error(`Not a handler file: ${file}`);
    }
  }
  for (const [name, relative] of Object.entries(candidate.libraries)) {
    if (
      !/^[A-Za-z0-9_.-]+$/.test(name) ||
      typeof relative !== 'string' ||
      path.isAbsolute(relative) ||
      relative.split('/').includes('..')
    )
      throw new Error(`Invalid library override: ${name}`);
    const file = path.resolve(repo, relative);
    assertMachinePath(repo, file);
    if (!fs.statSync(file).isFile()) throw new Error(`Not a library file: ${file}`);
  }
}

export interface AdoptMachineAdapterOptions {
  readonly repo: string;
  readonly surface: string;
  readonly home?: string;
  readonly userHome?: string;
  readonly templatesRoot?: string;
  readonly fromFile?: string;
  readonly plan?: boolean;
}

export function adoptMachineAdapter(options: AdoptMachineAdapterOptions): {
  changed: boolean;
  policy: ProjectPolicy;
  changes: readonly { path: string; before: string | null; after: string }[];
  restartRequired: boolean;
} {
  const repo = fs.realpathSync(options.repo);
  const surface = options.surface;
  if (!isKnownSurface(surface)) throw new Error(`Unknown surface: ${surface}`);
  const pack = resolveHookPack(surface);
  if (pack.kind !== 'pack') throw new Error(`No adapter for ${surface}`);
  // Native plugin/profile surfaces consume the same launcher, but their
  // registration belongs to the harness. Do not invent a config file for them.
  if (!['codex', 'claude-code', 'qwen-code'].includes(surface)) {
    throw new Error(
      `Automatic wiring is not implemented for ${surface}; its native adapter can invoke caws-hook ${surface} <event>. No files changed.`
    );
  }
  const vendor =
    surface === 'claude-code' ? '.claude' : surface === 'qwen-code' ? '.qwen' : '.codex';
  const home = options.home ?? machineHome();
  const templatesRoot =
    options.templatesRoot ?? path.resolve(__dirname, '../../templates/hook-packs');
  const configPath = path.join(repo, vendor, surface === 'codex' ? 'hooks.json' : 'settings.json');
  const policyPath = path.join(repo, '.caws/hooks/adapter-policy.json');
  for (const file of [configPath, policyPath]) assertMachinePath(repo, file);
  const beforeConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  const config = beforeConfig === null ? {} : JSON.parse(beforeConfig);
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Malformed harness configuration');
  const isCaws = (command: unknown): boolean =>
    typeof command === 'string' &&
    /(?:\.caws\/hooks\/|\.(?:codex|claude|qwen)\/hooks\/|\/bin\/caws-hook)/.test(command);
  // JSON and inline TOML are additive in Codex. Refuse the other layer rather
  // than claiming a single-dispatch install while it will actually fire twice.
  const userHome = options.userHome ?? process.env.HOME;
  const extraConfigs = [path.join(repo, vendor, 'config.toml')];
  if (userHome)
    extraConfigs.push(
      path.join(userHome, vendor, surface === 'codex' ? 'hooks.json' : 'settings.json'),
      path.join(userHome, vendor, 'config.toml')
    );
  for (const file of extraConfigs) {
    if (fs.existsSync(file) && isCaws(fs.readFileSync(file, 'utf8'))) {
      throw new Error(
        `Duplicate or ambiguous CAWS wiring at ${file}; reconcile it before adoption`
      );
    }
  }
  const beforePolicy = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, 'utf8') : null;
  const policy: ProjectPolicy =
    beforePolicy === null ? { version: 1, surfaces: {} } : JSON.parse(beforePolicy);
  if (
    policy?.version !== 1 ||
    !policy.surfaces ||
    typeof policy.surfaces !== 'object' ||
    Array.isArray(policy.surfaces) ||
    Object.keys(policy).sort().join(',') !== 'surfaces,version'
  )
    throw new Error('Malformed existing adapter policy');
  let selected: SurfacePolicy;
  if (options.fromFile) selected = JSON.parse(fs.readFileSync(options.fromFile, 'utf8'));
  else if (policy.surfaces[surface]) selected = policy.surfaces[surface] as SurfacePolicy;
  else {
    selected = { events: {}, libraries: {} };
    const roots = ['.caws/hooks', `${vendor}/hooks`].filter((dir) =>
      fs.existsSync(path.join(repo, dir, 'dispatch/pre_tool_use.sh'))
    );
    if (roots.length !== 1)
      throw new Error(
        'Cannot uniquely identify the existing dispatcher root; use --from with reviewed policy'
      );
    const hooksDir = roots[0] as string;
    for (const event of Object.keys(MACHINE_EVENTS) as Event[]) {
      const local = path.join(repo, hooksDir, 'dispatch', `${event}.sh`);
      if (!fs.existsSync(local)) continue;
      assertMachinePath(repo, local);
      const handlers = extractMachineHandlers(
        fs.readFileSync(local, 'utf8'),
        fs.readFileSync(path.join(templatesRoot, 'shared/dispatch', `${event}.sh`), 'utf8')
      );
      selected.events[event] = {
        hooks_dir: hooksDir,
        handlers: handlers.filter(
          (h) =>
            !(
              surface === 'codex' &&
              event === 'post_tool_use' &&
              h.split(' ')[0] === 'quality-check.sh'
            )
        ),
      };
    }
    const sharedAdapters = new Set([
      'runtime-paths.sh',
      'lib/agent-surface.sh',
      'lib/session-id.sh',
      'lib/reprieve.sh',
      'lib/run-handlers.sh',
      'lib/parse-input.sh',
      'lib/emit.sh',
    ]);
    const candidates = [
      ...SHARED_PACK.installedFiles
        .filter((f) => sharedAdapters.has(f.sourcePath))
        .map((file) => ({ file, packId: 'shared' })),
      ...pack.pack.installedFiles
        .filter((f) => f.sourcePath.startsWith('hooks/lib/'))
        .map((file) => ({ file, packId: surface })),
    ];
    for (const { file, packId } of candidates) {
      const local = path.join(repo, file.destPath);
      if (!fs.existsSync(local)) continue;
      assertMachinePath(repo, local);
      const bytes = fs.readFileSync(local, 'utf8');
      const baseline = readPristineBaseline(repo, packId, file.destPath);
      const upstream = fs.readFileSync(path.join(templatesRoot, packId, file.sourcePath), 'utf8');
      if (noVersion(bytes) === noVersion(upstream) || (baseline !== null && bytes === baseline))
        continue;
      // Keep the actual local library through an explicit, visible policy row.
      // Runtime integrity never disguises a project override as the shared code.
      if (baseline === null)
        throw new Error(
          `Unresolved adapter growth at ${file.destPath}; no pristine baseline. Review and declare it via --from.`
        );
      const name = path.basename(file.sourcePath);
      if (['runtime-paths.sh', 'agent-surface.sh'].includes(name) || selected.libraries[name]) {
        throw new Error(
          `Conflicting or bootstrap library growth at ${file.destPath}; reconcile before adoption`
        );
      }
      selected.libraries[name] = file.destPath;
    }
  }
  validateSurfacePolicy(repo, selected);
  policy.surfaces[surface] = selected;
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))
    throw new Error('Malformed hooks configuration');
  for (const [event, native] of Object.entries(MACHINE_EVENTS)) {
    const groups = config.hooks[native] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Malformed hook groups: ${native}`);
    let replaced = 0;
    const preserved: NativeHookGroup[] = groups
      .map((group: NativeHookGroup) => {
        if (!group || !Array.isArray(group.hooks))
          throw new Error(`Malformed hook group: ${native}`);
        const hooks = group.hooks.filter((h) => {
          if (!h || typeof h !== 'object') throw new Error(`Malformed hook: ${native}`);
          if (isCaws(h.command)) {
            replaced++;
            return false;
          }
          return true;
        });
        return { ...group, hooks };
      })
      .filter((group: { hooks: unknown[] }) => group.hooks.length > 0);
    if (replaced > 1)
      throw new Error(
        `Multiple CAWS handlers for ${native}; review duplicate wiring before adoption`
      );
    if (selected.events[event as Event]) {
      preserved.push({
        matcher: event.includes('tool_use')
          ? surface === 'qwen-code'
            ? 'run_shell_command|write_file|edit|read_file|glob|grep_search|notebook_edit'
            : 'Bash|apply_patch|Edit|Write|Read'
          : '*',
        hooks: [
          {
            type: 'command',
            command: `CAWS_HOME=${quote(home)} python3 ${quote(path.join(home, 'bin/caws-hook'))} ${surface} ${event}`,
            timeout: surface === 'qwen-code' ? 60000 : 60,
          },
        ],
      });
    } else if (replaced)
      throw new Error(`Existing CAWS wiring for ${native} has no policy; refusing to drop it`);
    config.hooks[native] = preserved;
  }
  const changes = [
    { path: policyPath, before: beforePolicy, after: JSON.stringify(policy, null, 2) + '\n' },
    { path: configPath, before: beforeConfig, after: JSON.stringify(config, null, 2) + '\n' },
  ].filter((change) => change.before !== change.after);
  if (!options.plan && changes.length > 0) {
    const gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    if (
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: repo,
        env: gitEnv,
        encoding: 'utf8',
      }).trim() !== repo
    )
      throw new Error('Adoption requires the repository root');
    // Back up exact pre-adoption bytes outside the project ledger. Every write
    // is checked again against the planned bytes and rolled back on failure.
    const key = createHash('sha256')
      .update(repo + JSON.stringify(changes))
      .digest('hex');
    atomicMachineWrite(
      home,
      path.join(home, 'state/adoption-backups', `${key}.json`),
      JSON.stringify({ repo, changes }, null, 2)
    );
    const applied: typeof changes = [];
    try {
      for (const change of changes) {
        const live = fs.existsSync(change.path) ? fs.readFileSync(change.path, 'utf8') : null;
        if (live !== change.before)
          throw new Error(`Adoption target changed after planning: ${change.path}`);
        atomicMachineWrite(repo, change.path, change.after);
        applied.push(change);
      }
    } catch (error) {
      for (const change of applied.reverse()) {
        if (change.before === null) fs.unlinkSync(change.path);
        else atomicMachineWrite(repo, change.path, change.before);
      }
      throw error;
    }
  }
  return { changed: changes.length > 0, policy, changes, restartRequired: changes.length > 0 };
}
