import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseAndValidateSpec } from '../kernel';
import { parseJsonSource } from '../runtime/json-custody';
import { loadEvents } from '../store/events-store';
import { recordSpecEvidence } from '../store/specs-writer';
import { parseExecutionEvidenceArguments } from './authorizer';
import {
  ExecutionAuthorityUnavailable,
  readExecutionAuthority,
  type ExecutionAuthorityContext,
} from './authority';
import { verifyInheritedFence } from './fence';
import type { FenceObservation } from './prepared';

const ENVIRONMENT = [
  'CAWS_EXECUTION_PROJECT',
  'CAWS_EXECUTION_CALLER',
  'CAWS_EXECUTION_SESSION',
  'CAWS_EXECUTION_THREAD',
  'CAWS_EXECUTION_CALL',
  'PATH',
  'LC_ALL',
];
function requireValue(
  value: unknown,
  reason: 'context_unresolved' | 'authority_changed' | 'fence_unverified' = 'context_unresolved'
): asserts value {
  if (!value) throw new ExecutionAuthorityUnavailable(reason);
}

/** The observation is read from fd3, never reconstructed from an environment
 * assertion. verifyInheritedFence binds it to the direct native parent and the
 * canonical live lock. This consumer never releases the borrowed descriptor. */
function inheritedFence(cawsDir: string): FenceObservation {
  const stat = fs.fstatSync(3, { bigint: true });
  requireValue(stat.isFile() && stat.size > 0n && stat.size <= 4096n, 'fence_unverified');
  const bytes = Buffer.alloc(Number(stat.size) + 1);
  const count = fs.readSync(3, bytes, 0, bytes.length, 0);
  requireValue(BigInt(count) === stat.size, 'fence_unverified');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(0, count)
  );
  parseJsonSource(text, 2, 16, true);
  const value: unknown = JSON.parse(text);
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'fence_unverified'
  );
  const nonce = (value as Record<string, unknown>).nonce;
  requireValue(
    typeof nonce === 'string' && nonce.length > 0 && nonce.length <= 4096,
    'fence_unverified'
  );
  const fence = { dev: stat.dev.toString(), ino: stat.ino.toString(), nonce };
  requireValue(verifyInheritedFence(cawsDir, fence), 'fence_unverified');
  return fence;
}

/** Only object/ref queries are admitted: no status, index, runner, filter,
 * commit, network fetch, hook, signing or executable lookup operation. */
function objectQuery(cwd: string, args: readonly string[]): string {
  return execFileSync(
    '/usr/bin/git',
    [
      '--no-lazy-fetch',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1000,
      maxBuffer: 65536,
    }
  );
}

/** Reject physical aliases before the existing authority writer opens them.
 * Its temporary siblings are part of this typed operation, never general write
 * permission. Concurrent noncooperating filesystem replacement is unsupported. */
function publicationPaths(cawsDir: string, specPath: string): void {
  for (const pathname of [specPath, join(cawsDir, 'events.jsonl')]) {
    try {
      const stat = fs.lstatSync(pathname);
      requireValue(
        stat.isFile() && stat.nlink === 1 && fs.realpathSync.native(pathname) === pathname
      );
    } catch (error) {
      if (
        pathname !== join(cawsDir, 'events.jsonl') ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw error;
    }
  }
  const directory = join(cawsDir, 'specs');
  const prefix = specPath.slice(directory.length + 1) + '.tmp.';
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const stat = fs.lstatSync(join(directory, name));
    requireValue(stat.isFile() && stat.nlink === 1);
  }
}

export interface ExecutionEvidenceResult {
  readonly operation: 'caws-evidence-v1';
  readonly specId: string;
  readonly criterionId: string;
  readonly verification: 'citation-only' | 'not-requested';
  readonly auditCommit: 'pending';
  readonly eventSequence: number;
  readonly specSha256: string;
  readonly auditCommitContinuation: readonly ['caws', 'specs', 'commit', string];
}

/** Private direct-child consumer. Its callers must provide the actual native
 * inherited fence; supplying the same public environment without fd3 refuses. */
export function runExecutionEvidenceWriter(argv: readonly string[]): ExecutionEvidenceResult {
  // Darwin's process startup can add this CoreFoundation scalar after execve,
  // even when the native producer supplied exactly the seven profiled keys.
  // It is never forwarded to Git or interpreted as a path or command.
  const cfEncoding = process.env.__CF_USER_TEXT_ENCODING;
  const runtimeKeys = Object.keys(process.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING');
  requireValue(
    cfEncoding === undefined ||
      (process.platform === 'darwin' &&
        /^(?:0x[0-9a-f]+|[0-9]+):(?:0x[0-9a-f]+|[0-9]+):(?:0x[0-9a-f]+|[0-9]+)$/i.test(
          cfEncoding
        ) &&
        Number(cfEncoding.split(':')[0]) === process.getuid?.())
  );
  requireValue(
    runtimeKeys.length === ENVIRONMENT.length &&
      ENVIRONMENT.every((name) => {
        const value = process.env[name];
        return typeof value === 'string' && value.length > 0 && !value.includes('\0');
      })
  );
  requireValue(process.env.PATH === '/usr/bin:/bin' && process.env.LC_ALL === 'C');
  const context: ExecutionAuthorityContext = {
    projectRoot: process.env.CAWS_EXECUTION_PROJECT!,
    association: {
      callerAnchor: process.env.CAWS_EXECUTION_CALLER!,
      threadId: process.env.CAWS_EXECUTION_THREAD!,
    },
    execution: { cwd: process.cwd() },
  };
  const cawsDir = join(context.projectRoot, '.caws');
  const fence = inheritedFence(cawsDir);
  const authority = readExecutionAuthority(context);
  const args = parseExecutionEvidenceArguments(argv, authority.binding.spec.id);
  const specPath = join(cawsDir, 'specs', `${args.id}.yaml`);
  publicationPaths(cawsDir, specPath);
  const expectedSource = fs.readFileSync(specPath, 'utf8');
  const before = loadEvents(cawsDir);
  requireValue(before.ok);
  const validate = (): void => {
    requireValue(verifyInheritedFence(cawsDir, fence), 'fence_unverified');
    requireValue(
      readExecutionAuthority(context).revision === authority.revision,
      'authority_changed'
    );
    publicationPaths(cawsDir, specPath);
  };
  if (args.verify) {
    requireValue(args.commitSha && args.artifactPath);
    objectQuery(authority.pin, ['cat-file', '-e', `${args.commitSha}^{commit}`]);
    requireValue(
      objectQuery(authority.pin, [
        'for-each-ref',
        '--contains',
        args.commitSha,
        '--count=1',
        '--format=%(refname)',
      ]).trim().length > 0
    );
    objectQuery(authority.pin, ['cat-file', '-e', `${args.commitSha}:${args.artifactPath}`]);
  }
  validate();
  const recordedAt = new Date();
  const actor = {
    kind: 'agent' as const,
    id: context.association.threadId,
    session_id: context.association.threadId,
    platform: 'codex',
  };
  const { verify: _verify, ...input } = args;
  const result = recordSpecEvidence(
    cawsDir,
    { ...input, actor, now: () => recordedAt },
    {
      kind: 'bounded-execution',
      fence,
      expectedSource,
      validate,
    }
  );
  requireValue(result.ok && result.value.kind === 'success');
  requireValue(verifyInheritedFence(cawsDir, fence), 'fence_unverified');
  const after = loadEvents(cawsDir);
  const publishedSource = fs.readFileSync(specPath, 'utf8');
  const spec = parseAndValidateSpec(publishedSource);
  requireValue(after.ok && spec.ok);
  const event = after.value.events.at(-1);
  const entries =
    spec.value.evidence?.filter((entry) => entry.criterion_id === args.criterionId) ?? [];
  requireValue(
    after.value.events.length === before.value.events.length + 1 &&
      event?.event === 'ac_recorded' &&
      event.spec_id === args.id
  );
  const expected = {
    criterion_id: args.criterionId,
    status: args.status,
    evidence_ref: args.evidenceRef,
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.exitCode !== undefined ? { exit_code: args.exitCode } : {}),
    ...(args.artifactPath !== undefined ? { artifact_path: args.artifactPath } : {}),
    ...(args.commitSha !== undefined ? { commit_sha: args.commitSha } : {}),
  };
  requireValue(entries.length === 1);
  for (const [name, value] of Object.entries(expected)) {
    requireValue(
      (entries[0] as unknown as Record<string, unknown>)[name] === value &&
        (event.data as Record<string, unknown>)[name] === value
    );
  }
  requireValue(
    entries[0]!.recorded_at === recordedAt.toISOString() && event.ts === recordedAt.toISOString()
  );
  requireValue(JSON.stringify(event.actor) === JSON.stringify(actor));
  requireValue(entries[0]!.test_nodeid === undefined && entries[0]!.test_verified_at === undefined);
  return {
    operation: 'caws-evidence-v1',
    specId: args.id,
    criterionId: args.criterionId,
    verification: args.verify ? 'citation-only' : 'not-requested',
    auditCommit: 'pending',
    eventSequence: event.seq,
    specSha256: createHash('sha256').update(publishedSource).digest('hex'),
    auditCommitContinuation: ['caws', 'specs', 'commit', args.id],
  };
}
