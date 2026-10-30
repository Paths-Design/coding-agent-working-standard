import { basename } from 'node:path';
import { analyzeCommand } from '../shell/analysis/analyze';
import { ExecutionAuthorityUnavailable, readExecutionAuthority } from './authority';
import {
  executionProfileArguments,
  executionProfileBindings,
  isExecutionProfileBuiltin,
  discoverEvidenceExecution,
  type EvidenceExecutionPlan,
} from './authorizer';
import { MAX_AUTHORIZER_REPLY_BYTES } from './protocol';
import type { AuthorizerRequest, ExecutionReasonCode, PreparedExecutionV1 } from './prepared';
import { snapshotNpmProject, type NpmProjectSnapshot } from './npm-project';

export interface NpmExecutionPlan {
  readonly kind: 'npm-test-v1';
  readonly argv: readonly string[];
  readonly project: NpmProjectSnapshot;
}

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
  readonly execution: EvidenceExecutionPlan | NpmExecutionPlan | null;
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
    // The producer recognizes this one literal form and independently pins
    // npm before constructing its final record. No shell command is resolved
    // from the submitted source, and this observation grants no launch.
    if (record.profile.source === 'npm test') {
      const path = executionProfileBindings(record).get('PATH')![0]!;
      const project = snapshotNpmProject(
        record.execution.cwd,
        path,
        record.limits.preparationDeadlineUnixMs
      );
      return Object.freeze({
        ...base,
        status: 'observed',
        commands: Object.freeze([]),
        execution: Object.freeze({
          kind: 'npm-test-v1' as const,
          argv: Object.freeze(['npm', 'test']),
          project,
        }),
        reasonCodes: Object.freeze([]),
      });
    }
    const evidence = await discoverEvidenceExecution(record, authority);
    if (evidence)
      return Object.freeze({
        ...base,
        status: 'observed',
        commands: Object.freeze(
          [evidence.argv[0]!, evidence.argv[1]!, '/usr/bin/git'].sort((a, b) =>
            Buffer.compare(Buffer.from(a), Buffer.from(b))
          )
        ),
        execution: Object.freeze({ ...evidence, argv: Object.freeze([...evidence.argv]) }),
        reasonCodes: Object.freeze([]),
      });
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
      execution: null,
    });
  } catch (error) {
    const code =
      error instanceof ExecutionAuthorityUnavailable ? error.reason : 'infrastructure_unavailable';
    return Object.freeze({
      ...base,
      status: 'unresolved',
      commands: Object.freeze([]),
      reasonCodes: Object.freeze([code]),
      execution: null,
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
        execution: null,
        reasonCodes: ['source_unresolved'],
      })
    );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
