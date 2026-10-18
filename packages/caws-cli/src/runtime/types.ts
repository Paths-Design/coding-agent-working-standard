import type { AgentSurface } from '../init/hook-packs/types';
import type { MACHINE_EVENTS } from '../init/native-hook-identification';

/** Shared invocation vocabulary. Transport observations never confer authority. */
export type HookEvent = keyof typeof MACHINE_EVENTS;

/** Native bytes and exit status are independent of RPC success. */
export interface NativeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface NativeResultContext {
  readonly surface: AgentSurface;
  readonly event: HookEvent;
  readonly runtimeDigest: string;
}

export type DispatchPhase = 'configuration' | 'execution';

/** A Stop budget belongs to one resolved project/session, never a process global. */
export interface StopFailureBudget {
  charge(): Promise<'refuse' | 'release'>;
  reset(): Promise<void>;
}
