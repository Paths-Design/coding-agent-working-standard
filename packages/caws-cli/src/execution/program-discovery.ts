import { basename } from 'node:path';
import { analyzeCommand } from '../shell/analysis/analyze';
import { ExecutionAuthorityUnavailable, readExecutionAuthority } from './authority';
import {
  executionProfileArguments,
  executionProfileBindings,
  isExecutionProfileBuiltin,
} from './authorizer';
import { MAX_AUTHORIZER_REPLY_BYTES } from './protocol';
import type { AuthorizerRequest, ExecutionReasonCode, PreparedExecutionV1 } from './prepared';

/** Advisory lexical program candidates, never admission or an authority revision.
 * Rust must resolve/hash the candidates, freeze a new final record, and run both
 * existing authorizer phases. An omitted or extra image fails final validation.
 */
export interface ProgramDiscoveryReply {
  readonly protocol: 'caws.execution.program-discovery.v1';
  readonly invocationId: string;
  readonly executionDigest: string;
  readonly status: 'observed' | 'unresolved';
  readonly commands: readonly string[];
  readonly reasonCodes: readonly ExecutionReasonCode[];
}

export async function discoverExecutionPrograms(
  record: PreparedExecutionV1,
  request: AuthorizerRequest
): Promise<ProgramDiscoveryReply> {
  const base = {
    protocol: 'caws.execution.program-discovery.v1' as const,
    invocationId: request.invocationId,
    executionDigest: request.executionDigest,
  };
  try {
    if (
      request.phase !== 'analyze' ||
      record.invocationId !== request.invocationId ||
      record.profile.utilities.length !== 0
    )
      throw new ExecutionAuthorityUnavailable('invalid_record');
    if (Date.now() >= record.limits.preparationDeadlineUnixMs)
      throw new ExecutionAuthorityUnavailable('deadline_expired');
    const authority = readExecutionAuthority(record);
    const inheritedBindings = executionProfileBindings(record);
    const commands = new Set<string>();
    const nodeProfiles = new Set<string>();
    let observationError: unknown;
    const result = await analyzeCommand(
      {
        command: record.profile.source,
        cwd: record.execution.cwd,
        worktree: authority.pin,
        shell: 'bash',
      },
      {
        context: { canonical: authority.canonical, worktree: authority.pin },
        inheritedBindings,
        gitContext: () => null,
        observers: {
          invocation({ node, argv }) {
            try {
              const args = executionProfileArguments(argv);
              const command = args[0]?.value;
              if (!command || command.includes('\0') || Buffer.byteLength(command) > 4096)
                throw new ExecutionAuthorityUnavailable('source_unresolved');
              if (isExecutionProfileBuiltin(command)) return;
              commands.add(command);
              if (commands.size > 256) throw new ExecutionAuthorityUnavailable('source_unresolved');
              // This only gathers a Node candidate. The final authorizer still
              // checks literal effects, its actual Node image and the full profile.
              if (basename(command) === 'node') nodeProfiles.add(`${node.pos}:${node.end}`);
            } catch (error) {
              observationError ??= error;
              throw error;
            }
          },
        },
      }
    );
    if (observationError) throw observationError;
    if (result.decision === 'deny') throw new ExecutionAuthorityUnavailable('source_denied');
    if (
      result.reasons.some(
        (reason) =>
          !(
            nodeProfiles.has(`${reason.start}:${reason.end}`) &&
            ['utility-unsupported', 'executable-path'].includes(reason.code)
          )
      )
    )
      throw new ExecutionAuthorityUnavailable('source_unresolved');
    if (Date.now() >= record.limits.preparationDeadlineUnixMs)
      throw new ExecutionAuthorityUnavailable('deadline_expired');
    return Object.freeze({
      ...base,
      status: 'observed',
      commands: Object.freeze(
        [...commands].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      ),
      reasonCodes: Object.freeze([]),
    });
  } catch (error) {
    const code =
      error instanceof ExecutionAuthorityUnavailable ? error.reason : 'infrastructure_unavailable';
    return Object.freeze({
      ...base,
      status: 'unresolved',
      commands: Object.freeze([]),
      reasonCodes: Object.freeze([code]),
    });
  }
}

export function encodeProgramDiscoveryReply(reply: ProgramDiscoveryReply): Buffer {
  let body = Buffer.from(JSON.stringify(reply));
  if (body.length > MAX_AUTHORIZER_REPLY_BYTES)
    body = Buffer.from(
      JSON.stringify({
        ...reply,
        status: 'unresolved',
        commands: [],
        reasonCodes: ['source_unresolved'],
      })
    );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
