import { stopAgentSession, type Diagnostic, type SessionIdentity } from '../kernel';
import { applyLeasePatch, loadLeases } from '../store/leases-store';

export interface AgentStopInput {
  readonly cawsDir: string;
  /** Resolved by the adapter. Stop never discovers or mints an identity. */
  readonly identity: SessionIdentity;
  readonly now: () => Date;
  /** Invocation-owned cancellation/deadline barrier immediately before the write. */
  readonly beforeApply?: () => void;
}
export interface AgentStopPorts {
  readonly loadLeases: typeof loadLeases;
  readonly applyLeasePatch: typeof applyLeasePatch;
}
export type AgentStopResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly session_id: string;
        readonly wrote: boolean;
        readonly diagnostics: ReadonlyArray<Diagnostic>;
      };
    }
  | {
      readonly ok: false;
      readonly stage: 'load' | 'transition' | 'apply';
      readonly errors: ReadonlyArray<Diagnostic>;
    };
const productionPorts: AgentStopPorts = { loadLeases, applyLeasePatch };

/** One lease-stop transaction shared by CLI and hook adapters; presentation stays outside. */
export function stopAgentActivity(
  input: AgentStopInput,
  ports: AgentStopPorts = productionPorts
): AgentStopResult {
  const now = input.now();
  const loaded = ports.loadLeases(input.cawsDir);
  if (!loaded.ok) return { ok: false, stage: 'load', errors: loaded.errors };
  const transition = stopAgentSession(loaded.value.leases, input.identity, now);
  if (!transition.ok) return { ok: false, stage: 'transition', errors: transition.errors };
  input.beforeApply?.();
  const applied = ports.applyLeasePatch(input.cawsDir, transition.value);
  if (!applied.ok) return { ok: false, stage: 'apply', errors: applied.errors };
  return { ok: true, value: { session_id: input.identity.session_id, ...applied.value } };
}
