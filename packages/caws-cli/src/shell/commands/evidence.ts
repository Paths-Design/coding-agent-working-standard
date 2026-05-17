// `caws evidence record` — append one typed evidence event.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)
//   2. resolveSession({ allowMint: true })       — this is a write op
//   3. buildActor({ session, kind })
//   4. construct EventBody from caller inputs   — body-only; no seq/prev/hash
//   5. appendEvent(cawsDir, body)                 — store enforces lock,
//                                                   chain via kernel
//                                                   prepareAppend
//   6. print seq + event_hash AFTER success
//
// Exit codes:
//   0 = append succeeded
//   1 = validation rejected the body OR appendEvent returned Err
//   2 = repo-root / session resolution / composition failure
//
// CRITICAL: the API surface accepts EventBody-shaped inputs only. It does
// not accept `seq`, `prev_hash`, or `event_hash`. The CLI layer parsing
// (commander) MUST NOT add those fields. If a caller does pass them via
// the data object, kernel `validateEventBody` rejects them (additionalProperties:
// false on the per-event-type payload schemas).

import * as path from 'node:path';

import {
  type Actor,
  type ActorKind,
  type EventBody,
  type EventType,
} from '@paths.design/caws-kernel';

import { appendEvent, resolveRepoRoot } from '../../store';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';
import { SHELL_RULES } from '../rules';

export type EvidenceKind = 'test' | 'gate' | 'ac';

const KIND_TO_EVENT_TYPE: Record<EvidenceKind, EventType> = {
  test: 'test_recorded',
  gate: 'gate_evaluated',
  ac: 'ac_recorded',
};

export interface EvidenceRecordOptions {
  /** Which evidence event to record. */
  readonly kind: EvidenceKind;
  /** Required: the spec id this evidence is about. */
  readonly specId: string;
  /** Required: the event payload — must match the kernel's event-type schema. */
  readonly data: Record<string, unknown>;
  /** Actor kind. Defaults to 'agent'. */
  readonly actorKind?: ActorKind;
  /** Optional actor id override. Defaults to session.identity.session_id. */
  readonly actorId?: string;
  /** Optional ISO-8601 ts. Defaults to now. */
  readonly ts?: string;
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Injected clock for tests. */
  readonly now?: () => Date;
  /** Injected env for tests. */
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Show optional `data` blocks on rendered errors. */
  readonly showData?: boolean;
}

function rejectPreChainedFields(data: Record<string, unknown>): string | null {
  for (const banned of ['seq', 'prev_hash', 'event_hash']) {
    if (Object.prototype.hasOwnProperty.call(data, banned)) {
      return banned;
    }
  }
  return null;
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return value === 'test' || value === 'gate' || value === 'ac';
}

export function runEvidenceRecordCommand(opts: EvidenceRecordOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // Validate the evidence kind up front (defensive — Commander should
  // reject unknown values at the parser, but tests / programmatic callers
  // may bypass that).
  if (!isEvidenceKind(opts.kind)) {
    err(
      `caws evidence record: invalid --type. Got ${JSON.stringify(opts.kind)}; expected test|gate|ac.`
    );
    err(
      `(rule: ${SHELL_RULES.COMMAND_INVALID_EVIDENCE_TYPE})`
    );
    return 1;
  }

  // Reject pre-chained fields in the payload BEFORE doing any I/O.
  const banned = rejectPreChainedFields(opts.data);
  if (banned !== null) {
    err(
      `caws evidence record: payload must NOT include \`${banned}\`. Pre-chained events are not accepted by this command.`
    );
    err(`(rule: ${SHELL_RULES.COMMAND_PRE_CHAINED_EVENT_REFUSED})`);
    return 1;
  }

  // Require non-empty spec_id (also enforced by kernel REQUIRES_SPEC_ID
  // fence, but we surface the shell-level error early).
  if (typeof opts.specId !== 'string' || opts.specId.length === 0) {
    err('caws evidence record: --spec is required.');
    err(`(rule: ${SHELL_RULES.COMMAND_MISSING_SPEC_ID})`);
    return 1;
  }

  // 1. Repo root.
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws evidence record: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  // 2. Session (write op → allowMint).
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    err('caws evidence record: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }

  // 3. Actor envelope.
  const actor: Actor = buildActor({
    session: sessionResult.value,
    kind: opts.actorKind ?? 'agent',
    ...(opts.actorId !== undefined ? { id: opts.actorId } : {}),
  });

  // 4. Body.
  const eventType = KIND_TO_EVENT_TYPE[opts.kind];
  const ts = opts.ts ?? now().toISOString();
  // `EventBody.data` is typed as `EventPayload` (a union of per-event
  // payload shapes). The kernel will validate against the right schema
  // at append time; we hand off the caller's already-parsed object.
  const body = {
    event: eventType,
    ts,
    actor,
    spec_id: opts.specId,
    data: opts.data,
  } as unknown as EventBody;

  // 5. Append. `appendEvent` calls `prepareAppend` which calls
  // `validateEventBody` against the per-type schema.
  const appendResult = appendEvent(cawsDir, body);
  if (!appendResult.ok) {
    err('caws evidence record: append rejected.');
    err(renderDiagnostics(appendResult.errors, { showData }));
    return 1;
  }

  // 6. Print outcome AFTER success. Includes seq + event_hash so the
  // caller (agent or human) gets a stable handle for the new event.
  const ev = appendResult.value;
  out(
    `recorded ${ev.event} seq=${ev.seq} hash=${ev.event_hash} spec=${ev.spec_id ?? '(none)'}`
  );
  // Print the relative events file path for ergonomics.
  out(`  written to ${path.relative(repoRoot, path.join(cawsDir, 'events.jsonl'))}`);
  return 0;
}
