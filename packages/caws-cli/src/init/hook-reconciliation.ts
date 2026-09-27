// A preview is an inventory and a proposal, never evidence of native execution.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { assertMachinePath, verifyRuntime } from './machine-adapters';
import { pristinePathFor } from './hook-install';
import {
  POLICY_EVENTS,
  REPO_HOOK_POLICY_PATH,
  REPO_POLICY_FLOOR,
  emptyRepoSurfacePolicy,
  effectiveRepoSurfacePolicy,
  parseRepoHookPolicy,
  resolveChain,
  serializeRepoHookPolicy,
  type ImportableMachineSurface,
} from './repo-hook-policy';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  return value;
}
export const digest = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
export function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export interface ReconciliationEntry {
  id: string;
  surface: string;
  kind: 'handler' | 'library';
  name: string;
  disposition:
    | 'transferable'
    | 'retain_machine_floor'
    | 'retain_machine_dependency_review'
    | 'retain_machine_destination_exists';
  locations: string[];
  target: string | null;
  target_sha256: string | null;
  baseline: {
    sha256: string | null;
    origin: 'upstream_template' | 'unknown';
    local_differs: boolean | null;
  };
  reason: string;
}
export interface ReconciliationPlan {
  schema: 'caws.hook_reconciliation.v1';
  root: string;
  home: string;
  plan_id: string;
  read_only: true;
  selected: string[];
  entries: ReconciliationEntry[];
  inputs: Record<string, string | null>;
  blockers: string[];
  chains: {
    surface: string;
    event: string;
    before: unknown;
    after: unknown;
    equivalent: boolean;
  }[];
  repo_before: string | null;
  repo_after: string;
  machine_before: string;
  machine_after: string;
  runtime_verified: boolean;
  dependency_scope: string;
}

export function planHookReconciliation(
  rootInput: string,
  homeInput: string,
  selectedInput?: readonly string[]
): ReconciliationPlan {
  const root = fs.realpathSync(rootInput),
    home = path.resolve(homeInput);
  const machineFile = path.join(home, 'state/projects', digest(root) + '.json');
  const machineText = readOptional(machineFile);
  if (machineText === null) throw new Error('This project has no machine overrides to reconcile');
  const settings = JSON.parse(machineText) as {
    version: number;
    root: string;
    surfaces: Record<string, ImportableMachineSurface>;
  };
  if (
    Object.keys(settings).sort().join(',') !== 'root,surfaces,version' ||
    settings.version !== 1 ||
    settings.root !== root ||
    !settings.surfaces ||
    Array.isArray(settings.surfaces)
  )
    throw new Error('Machine state does not identify this canonical project');
  const repoText = readOptional(path.join(root, REPO_HOOK_POLICY_PATH));
  const parsed = parseRepoHookPolicy(repoText);
  if (!parsed.ok) throw new Error(parsed.error);
  const policy = parsed.policy;
  const inputs: Record<string, string | null> = {};
  const observe = (file: string): string | null => {
    const text = readOptional(file);
    inputs[file] = text === null ? null : digest(text);
    return text;
  };
  observe(machineFile);
  observe(path.join(root, REPO_HOOK_POLICY_PATH));
  // Bind the reader/writer implementation and the original native registrations as well.
  observe(__filename);
  observe(path.join(__dirname, 'repo-hook-policy.js'));
  for (const file of ['.codex/hooks.json', '.claude/settings.json', '.claude/settings.local.json'])
    observe(path.join(root, file));
  for (const file of ['.codex/hooks.json', '.claude/settings.json'])
    observe(path.join(os.homedir(), file));
  const pointerText = observe(path.join(home, 'state/adapter-runtime.json'));
  const blockers: string[] = [];
  let runtimeRoot: string | null = null;
  let stock: Record<string, string[]> = {};
  if (pointerText !== null) {
    try {
      const pointer = JSON.parse(pointerText) as { digest: string };
      const files = verifyRuntime(home, pointer.digest);
      runtimeRoot = path.join(home, 'lib/runtimes', pointer.digest);
      observe(path.join(runtimeRoot, 'manifest.json'));
      for (const file of Object.keys(files)) observe(path.join(runtimeRoot, file));
      const system = JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, 'system-policy.json'), 'utf8')
      ) as { events: Record<string, string[]> };
      stock = system.events;
    } catch (e) {
      blockers.push('Runtime verification failed: ' + (e as Error).message);
    }
  } else
    blockers.push('No verified active runtime; install the CLI/runtime before applying this plan');

  // Conservative dependency bound: source siblings may be opened directly rather than
  // through library overrides. Hash the source tree, never audit/session output.
  const machineTrees = new Set<string>();
  const sourceTrees = new Set<string>([path.join(root, '.caws/hooks')]);
  const entries: ReconciliationEntry[] = [];
  for (const surface of Object.keys(settings.surfaces).sort()) {
    const from = settings.surfaces[surface]!;
    const surfaceSettings = observe(path.join(home, 'surfaces', surface, 'settings.json'));
    if (surfaceSettings === null || JSON.parse(surfaceSettings).enabled !== true)
      blockers.push('System surface is not enabled: ' + surface);
    machineTrees.add(path.join(home, 'surfaces', surface, 'lib'));
    if (
      surfaceSettings !== null &&
      typeof JSON.parse(surfaceSettings).native_config_target === 'string'
    )
      observe(JSON.parse(surfaceSettings).native_config_target);
    const names = new Set(Object.keys(from.handlers ?? {}));
    for (const list of Object.values(from.disabled ?? {})) for (const n of list) names.add(n);
    for (const list of Object.values(from.extensions ?? {}))
      for (const e of list) names.add(e.handler.split(' ')[0]!);
    for (const [kind, all] of [
      ['handler', names],
      ['library', new Set(Object.keys(from.libraries ?? {}))],
    ] as const) {
      for (const name of [...all].sort()) {
        const locations: string[] = [];
        if (kind === 'handler') {
          for (const [event, list] of Object.entries(from.disabled ?? {}))
            if (list.includes(name)) locations.push('disabled.' + event);
          for (const [event, list] of Object.entries(from.extensions ?? {}))
            if (list.some((e) => e.handler.split(' ')[0] === name))
              locations.push('extensions.' + event);
        }
        const target = (kind === 'handler' ? from.handlers : from.libraries)?.[name] ?? null;
        if (target !== null) {
          locations.push((kind === 'handler' ? 'handlers.' : 'libraries.') + name);
          if (
            typeof target !== 'string' ||
            path.isAbsolute(target) ||
            target.split('/').includes('..')
          )
            throw new Error('Uncontained machine target: ' + name);
          const full = path.join(root, target);
          assertMachinePath(root, full);
          observe(full);
          sourceTrees.add(path.dirname(full));
        }
        const baselinePath = pristinePathFor(root, 'shared', '.caws/hooks/' + name);
        const baselineText = observe(baselinePath),
          originText = observe(baselinePath + '.origin.json');
        let origin: ReconciliationEntry['baseline']['origin'] = 'unknown';
        if (baselineText !== null && originText !== null) {
          try {
            const record = JSON.parse(originText);
            if (
              record.version === 1 &&
              record.writer === 'upstream-template-only' &&
              record.pack === 'shared' &&
              record.template_sha256 === digest(baselineText)
            )
              origin = 'upstream_template';
          } catch {
            /* unknown origin stays unknown */
          }
        }
        const localText = target === null ? null : readOptional(path.join(root, target));
        const floor = kind === 'handler' && REPO_POLICY_FLOOR.includes(name);
        const destination = Object.prototype.hasOwnProperty.call(policy.surfaces, surface);
        const disposition = floor
          ? 'retain_machine_floor'
          : kind === 'library'
            ? 'retain_machine_dependency_review'
            : destination
              ? 'retain_machine_destination_exists'
              : 'transferable';
        entries.push({
          id: `${surface}:${kind}:${name}`,
          surface,
          kind,
          name,
          disposition,
          locations,
          target,
          target_sha256: localText === null ? null : digest(localText),
          baseline: {
            sha256: baselineText === null ? null : digest(baselineText),
            origin,
            local_differs:
              localText === null || baselineText === null
                ? null
                : digest(localText) !== digest(baselineText),
          },
          reason: floor
            ? 'The repository tier may not replace or disable its floor. Retain this machine override until its behavior is reconciled upstream.'
            : kind === 'library'
              ? 'Direct helper loads cannot be inferred from a library name. Retain pending dependency review.'
              : destination
                ? 'The destination surface already declares policy; do not silently merge or reorder it.'
                : 'Handler and event references transfer together, without widening to default or another surface.',
        });
      }
    }
  }
  const filesSeen = new Set<string>();
  function scan(dir: string, boundary = root): void {
    if (!fs.existsSync(dir)) return;
    assertMachinePath(boundary, dir);
    for (const child of fs.readdirSync(dir).sort()) {
      if (child.startsWith('.') || child === 'node_modules' || child === '__pycache__') continue;
      const full = path.join(dir, child);
      assertMachinePath(boundary, full);
      if (filesSeen.has(full)) continue;
      filesSeen.add(full);
      if (filesSeen.size > 5000) throw new Error('Hook source dependency inventory exceeds bound');
      const stat = fs.statSync(full);
      if (stat.isDirectory()) scan(full, boundary);
      else if (
        /\.(sh|py|cjs|mjs)$/.test(child) ||
        child === 'hook-policy.json' ||
        child.endsWith('.schema.json')
      )
        observe(full);
    }
  }
  for (const tree of sourceTrees) scan(tree);
  for (const tree of machineTrees) scan(tree, home);
  const selected = [
    ...new Set(
      selectedInput ?? entries.filter((e) => e.disposition === 'transferable').map((e) => e.id)
    ),
  ].sort();
  const nextSettings = JSON.parse(machineText) as typeof settings;
  const nextPolicy = parseRepoHookPolicy(repoText);
  if (!nextPolicy.ok) throw new Error(nextPolicy.error);
  for (const id of selected) {
    const row = entries.find((e) => e.id === id);
    if (!row || row.disposition !== 'transferable')
      throw new Error('Selection is not transferable: ' + id);
    const from = nextSettings.surfaces[row.surface]!;
    const into =
      nextPolicy.policy.surfaces[row.surface] ??
      (nextPolicy.policy.surfaces[row.surface] = emptyRepoSurfacePolicy());
    for (const [event, list] of Object.entries(from.disabled ?? {})) {
      const chosen = list.filter((name) => name === row.name);
      if (chosen.length)
        into.disabled[event] = [
          ...(into.disabled[event] ?? []),
          ...chosen.map((handler) => ({ handler, reason: null })),
        ];
      from.disabled![event] = list.filter((name) => name !== row.name);
    }
    for (const [event, list] of Object.entries(from.extensions ?? {})) {
      const chosen = list.filter((e) => e.handler.split(' ')[0] === row.name);
      if (chosen.length)
        into.extensions[event] = [
          ...(into.extensions[event] ?? []),
          ...chosen.map((e) => ({
            ...e,
            reason: `Imported from machine state (${row.surface}); no justification was recorded when it was set there.`,
          })),
        ];
      from.extensions![event] = list.filter((e) => e.handler.split(' ')[0] !== row.name);
    }
    if (from.handlers?.[row.name]) {
      into.handlers[row.name] = from.handlers[row.name]!;
      delete from.handlers[row.name];
    }
  }
  const repoAfter = selected.length
    ? serializeRepoHookPolicy(nextPolicy.policy)
    : (repoText ?? serializeRepoHookPolicy(policy));
  const validated = parseRepoHookPolicy(repoAfter);
  if (!validated.ok) blockers.push('Candidate policy refused: ' + validated.error);
  const chains: ReconciliationPlan['chains'] = [];
  for (const surface of Object.keys(settings.surfaces).sort())
    for (const event of POLICY_EVENTS) {
      if (!stock[event]) {
        blockers.push(`No stock chain observed for ${surface}/${event}`);
        continue;
      }
      const resolve = (repo: typeof policy, machine: ImportableMachineSurface) =>
        resolveChain({
          stock: stock[event]!,
          event,
          repo: effectiveRepoSurfacePolicy(repo, surface),
          machine: {
            disabled: machine.disabled ?? {},
            extensions: Object.fromEntries(
              Object.entries(machine.extensions ?? {}).map(([event, entries]) => [
                event,
                entries.map((e) => ({ ...e, reason: 'Machine state recorded no justification.' })),
              ])
            ),
            handlers: machine.handlers ?? {},
            libraries: machine.libraries ?? {},
          },
        });
      const before = resolve(policy, settings.surfaces[surface]!),
        after = resolve(nextPolicy.policy, nextSettings.surfaces[surface]!);
      const equivalent =
        before.ok &&
        after.ok &&
        JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
      if (!equivalent) blockers.push(`Resolved chain differs or refuses at ${surface}/${event}`);
      if (before.ok)
        for (const handler of before.handlers) {
          const name = handler.split(' ')[0]!;
          const target = before.handlerOverrides[name]
            ? path.join(root, before.handlerOverrides[name]!)
            : path.join(runtimeRoot!, name);
          if (!fs.existsSync(target)) blockers.push('Selected handler is missing: ' + target);
          else {
            observe(target);
            try {
              fs.accessSync(target, fs.constants.X_OK);
            } catch {
              blockers.push('Selected handler is not executable: ' + target);
            }
          }
        }
      chains.push({ surface, event, before, after, equivalent });
    }
  const body = {
    schema: 'caws.hook_reconciliation.v1' as const,
    root,
    home,
    read_only: true as const,
    selected,
    entries,
    inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))),
    blockers: [...new Set(blockers)],
    chains,
    repo_before: repoText,
    repo_after: repoAfter,
    machine_before: machineText,
    machine_after: selected.length ? JSON.stringify(nextSettings, null, 2) + '\n' : machineText,
    runtime_verified: runtimeRoot !== null && !blockers.some((b) => b.startsWith('Runtime')),
    dependency_scope:
      'All source siblings beneath hook and override directories; dynamic non-source loads require separate behavioral qualification.',
  };
  return { ...body, plan_id: digest(JSON.stringify(body)) };
}
