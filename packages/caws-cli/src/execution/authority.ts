import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  assertOwnership,
  deriveBindingState,
  parseAndValidatePolicy,
  parseAndValidateSpec,
  type BindingState,
  type Policy,
  type Spec,
  type WorktreeRegistry,
} from '../kernel';
import { parseJsonSource } from '../runtime/json-custody';
import { repoRootFromGitCommonDir } from '../store/repo-root';
import { inside } from '../shell/analysis/policies';
import type { ExecutionReasonCode, PreparedExecutionV1 } from './prepared';

export class ExecutionAuthorityUnavailable extends Error {
  constructor(readonly reason: ExecutionReasonCode = 'context_unresolved') {
    super('Execution authority is unavailable');
    this.name = 'ExecutionAuthorityUnavailable';
  }
}
export interface ExecutionAuthority {
  readonly canonical: string;
  readonly cawsDir: string;
  readonly pin: string;
  readonly policy: Policy;
  readonly binding: Extract<BindingState, { kind: 'bound' | 'bridged' }>;
  readonly revision: string;
}
function requireValue(
  value: unknown,
  reason: ExecutionReasonCode = 'context_unresolved'
): asserts value {
  if (!value) throw new ExecutionAuthorityUnavailable(reason);
}
function row(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
function json(bytes: Uint8Array): Record<string, unknown> {
  const text = utf8(bytes);
  parseJsonSource(text, 32, 50_000, true);
  const value: unknown = JSON.parse(text);
  requireValue(row(value));
  return value;
}
function directory(path: string): void {
  const stat = fs.lstatSync(path);
  requireValue(stat.isDirectory() && fs.realpathSync.native(path) === path);
}
function identity(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function file(path: string): { bytes: Buffer; identity: string } {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    requireValue(stat.isFile() && stat.nlink === 1n && stat.size <= 1048576n);
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const final = fs.fstatSync(fd, { bigint: true });
    const pathname = fs.lstatSync(path, { bigint: true });
    requireValue(
      BigInt(length) === stat.size &&
        identity(final) === identity(stat) &&
        identity(pathname) === identity(stat)
    );
    return { bytes: buffer.subarray(0, length), identity: identity(stat) };
  } finally {
    fs.closeSync(fd);
  }
}
interface CapturedAuthority {
  policy: Buffer;
  registry: Buffer;
  bridges: Buffer | null;
  specs: readonly Buffer[];
  revision: string;
}
function capture(cawsDir: string): CapturedAuthority {
  directory(cawsDir);
  const specsDir = join(cawsDir, 'specs');
  directory(specsDir);
  const names = fs
    .readdirSync(specsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  requireValue(names.length > 0 && names.length <= 1024);
  const hash = createHash('sha256');
  const read = (name: string): Buffer => {
    const observed = file(join(cawsDir, name));
    hash
      .update(JSON.stringify([name, observed.identity, observed.bytes.length]))
      .update(observed.bytes);
    return observed.bytes;
  };
  const policy = read('policy.yaml');
  const registry = read('worktrees.json');
  let bridges: Buffer | null = null;
  try {
    directory(join(cawsDir, 'claims'));
    bridges = read('claims/bridge.json');
  } catch (error) {
    // Only actual absence permits the optional bridge file. Existing symlinks,
    // non-directories and unreadable paths never become an empty authority set.
    requireValue(
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
    hash.update('bridge:absent');
  }
  const specs = names.map((name) => read(`specs/${name}`));
  hash.update(JSON.stringify(names));
  return { policy, registry, bridges, specs, revision: hash.digest('hex') };
}

/** Fixed read-only Git query. Remove exactly its one framing LF, never path data.
 * Inherited Git routing, global config and model-selected executables do not enter it.
 */
function callerProject(caller: string): { canonical: string; checkout: string } {
  const query = (argument: '--git-common-dir' | '--show-toplevel'): string => {
    const bytes = execFileSync('/usr/bin/git', ['rev-parse', '--path-format=absolute', argument], {
      cwd: caller,
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 500,
      maxBuffer: 65536,
    });
    requireValue(bytes.length > 1 && bytes.at(-1) === 10);
    const value = utf8(bytes.subarray(0, -1));
    requireValue(isAbsolute(value) && !value.includes('\0'));
    return value;
  };
  return {
    canonical: fs.realpathSync.native(repoRootFromGitCommonDir(query('--git-common-dir')).repoRoot),
    checkout: fs.realpathSync.native(query('--show-toplevel')),
  };
}

/** All values are parsed from the captured bytes, not reloaded through lenient
 * dashboard loaders. The final call runs while the Rust parent owns state.lock.
 * The native private producer, not submitted JSON, establishes caller provenance.
 */
export function readExecutionAuthority(record: PreparedExecutionV1): ExecutionAuthority {
  try {
    const caller = fs.realpathSync.native(record.association.callerAnchor);
    requireValue(caller === record.association.callerAnchor);
    const { canonical, checkout } = callerProject(caller);
    requireValue(
      canonical === record.projectRoot &&
        fs.realpathSync.native(record.execution.cwd) === record.execution.cwd
    );
    const cawsDir = join(canonical, '.caws');
    const captured = capture(cawsDir);
    const parsedPolicy = parseAndValidatePolicy(utf8(captured.policy));
    requireValue(parsedPolicy.ok);
    const specs: Spec[] = [];
    const seen = new Set<string>();
    for (const bytes of captured.specs) {
      const parsed = parseAndValidateSpec(utf8(bytes));
      requireValue(parsed.ok && !seen.has(parsed.value.id));
      seen.add(parsed.value.id);
      specs.push(parsed.value);
    }
    const registry = json(captured.registry);
    const matches: { name: string; path: string; specId: string }[] = [];
    for (const [name, entry] of Object.entries(registry)) {
      requireValue(row(entry));
      requireValue(
        entry.specId === undefined || (typeof entry.specId === 'string' && entry.specId.length > 0)
      );
      requireValue(
        entry.owner === undefined ||
          (row(entry.owner) &&
            typeof entry.owner.session_id === 'string' &&
            entry.owner.session_id.length > 0)
      );
      if (entry.path !== undefined) {
        requireValue(typeof entry.path === 'string' && isAbsolute(entry.path));
        let physical: string;
        try {
          physical = fs.realpathSync.native(entry.path);
        } catch (error) {
          requireValue(
            typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ENOENT'
          );
          continue;
        }
        if (inside(caller, physical)) {
          requireValue(
            typeof entry.specId === 'string' && entry.specId.length > 0,
            'binding_unavailable'
          );
          matches.push({ name, path: physical, specId: entry.specId });
        }
      }
    }
    requireValue(matches.length <= 1, 'binding_unavailable');
    let binding: ExecutionAuthority['binding'];
    let pin: string;
    const match = matches[0];
    if (match) {
      requireValue(match.path !== canonical && match.path === checkout, 'binding_unavailable');
      const spec = specs.find((candidate) => candidate.id === match.specId);
      requireValue(spec?.lifecycle_state === 'active', 'binding_unavailable');
      const derived = deriveBindingState(spec, registry as unknown as WorktreeRegistry, match.name);
      requireValue(derived.kind === 'bound', 'binding_unavailable');
      const owned = assertOwnership(
        registry as unknown as WorktreeRegistry,
        match.name,
        { session_id: record.association.threadId, platform: 'codex' },
        {},
        new Date()
      );
      requireValue(owned.ok && owned.value === null, 'foreign_owner');
      binding = derived;
      pin = match.path;
    } else {
      requireValue(
        checkout === canonical && inside(caller, canonical) && captured.bridges !== null,
        'binding_unavailable'
      );
      const bridges = json(captured.bridges);
      const owned: Spec[] = [];
      for (const [id, entry] of Object.entries(bridges)) {
        requireValue(row(entry) && typeof entry.session_id === 'string');
        if (entry.session_id !== record.association.threadId) continue;
        requireValue(entry.platform === undefined || entry.platform === 'codex', 'foreign_owner');
        const spec = specs.find((candidate) => candidate.id === id);
        requireValue(
          spec?.lifecycle_state === 'active' &&
            !spec.worktree &&
            !Object.values(registry).some((entry) => row(entry) && entry.specId === id),
          'binding_unavailable'
        );
        owned.push(spec);
      }
      requireValue(owned.length === 1, 'binding_unavailable');
      binding = { kind: 'bridged', spec: owned[0]!, session_id: record.association.threadId };
      pin = canonical;
    }
    requireValue(inside(record.execution.cwd, pin), 'context_unresolved');
    requireValue(capture(cawsDir).revision === captured.revision, 'authority_changed');
    return {
      canonical,
      cawsDir,
      pin,
      policy: parsedPolicy.value,
      binding,
      revision: captured.revision,
    };
  } catch (error) {
    if (error instanceof ExecutionAuthorityUnavailable) throw error;
    throw new ExecutionAuthorityUnavailable();
  }
}
