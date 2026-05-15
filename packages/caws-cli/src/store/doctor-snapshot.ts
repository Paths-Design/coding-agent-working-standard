// Doctor snapshot composition.
//
// Pulls state from each store adapter and assembles two artifacts:
//   1. StoreSnapshot — the full I/O-derived state, including load
//      diagnostics. The shell uses this for separate display of
//      load failures.
//   2. DoctorInput — the projection of valid state the kernel's
//      `inspectProjectState` accepts.
//
// Discipline:
//   - The composer does NOT invent validation. It loads, calls the
//     existing kernel functions, and forwards.
//   - The composer accepts `now` as input. It never reads Date.now().
//   - Template-check discovery is OUT OF SCOPE in Slice 5b. If the
//     caller wants template diagnostics, they pass `TemplateCheck[]`
//     themselves.
//   - Session capsules (.caws/sessions/<id>.json) are OUT OF SCOPE in
//     Slice 5b — they're tied to identity resolution which is a Slice
//     5c concern.

import {
  isOk,
  type DoctorInput,
  type TemplateCheck,
} from '@paths.design/caws-kernel';
import { loadAgents } from './agents-store';
import { loadEvents } from './events-store';
import { loadPolicy } from './policy-store';
import { loadSpecs } from './specs-store';
import type { StoreSnapshot } from './types';
import { loadWaivers } from './waivers-store';
import { loadWorktrees } from './worktrees-store';

// ----------------------------------------------------------------------------
// composeStoreSnapshot — fuller snapshot that carries every load diagnostic.
// ----------------------------------------------------------------------------

export interface ComposeOptions {
  readonly repoRoot: string;
  readonly cawsDir: string;
}

export function composeStoreSnapshot(options: ComposeOptions): StoreSnapshot {
  const { repoRoot, cawsDir } = options;
  const specsResult = loadSpecs(cawsDir);
  const policyResult = loadPolicy(cawsDir);
  const worktreesResult = loadWorktrees(cawsDir);
  const agentsResult = loadAgents(cawsDir);
  const eventsResult = loadEvents(cawsDir);
  const waiversResult = loadWaivers(cawsDir);

  return {
    repoRoot,
    cawsDir,
    specs: specsResult.specs,
    specDiagnostics: specsResult.diagnostics,
    ...(policyResult.policy !== undefined ? { policy: policyResult.policy } : {}),
    policyWarnings: policyResult.warnings,
    policyErrors: policyResult.errors,
    worktrees: isOk(worktreesResult) ? worktreesResult.value : {},
    agents: isOk(agentsResult) ? agentsResult.value : {},
    events: isOk(eventsResult) ? eventsResult.value.events : [],
    eventWarnings: isOk(eventsResult) ? eventsResult.value.warnings : eventsResult.errors,
    waivers: waiversResult.waivers,
    waiverDiagnostics: waiversResult.diagnostics,
  };
}

// ----------------------------------------------------------------------------
// composeDoctorSnapshot — project StoreSnapshot onto DoctorInput.
// ----------------------------------------------------------------------------

export interface ComposeDoctorOptions extends ComposeOptions {
  readonly now: Date;
  readonly templates?: readonly TemplateCheck[];
  readonly staleAgentTtlMs?: number;
  readonly unboundActiveThresholdMs?: number;
  readonly priorOwnersGrowthThreshold?: number;
}

export interface ComposeDoctorResult {
  readonly snapshot: StoreSnapshot;
  readonly doctorInput: DoctorInput;
}

export function composeDoctorSnapshot(options: ComposeDoctorOptions): ComposeDoctorResult {
  const snapshot = composeStoreSnapshot(options);

  const doctorInput: DoctorInput = {
    specs: snapshot.specs,
    ...(snapshot.policy !== undefined ? { policy: snapshot.policy } : {}),
    policyWarnings: snapshot.policyWarnings,
    worktrees: snapshot.worktrees,
    agents: snapshot.agents,
    events: snapshot.events,
    ...(options.templates !== undefined ? { templates: options.templates } : {}),
    waivers: snapshot.waivers,
    waiverDiagnostics: snapshot.waiverDiagnostics,
    now: options.now,
    ...(options.staleAgentTtlMs !== undefined
      ? { staleAgentTtlMs: options.staleAgentTtlMs }
      : {}),
    ...(options.unboundActiveThresholdMs !== undefined
      ? { unboundActiveThresholdMs: options.unboundActiveThresholdMs }
      : {}),
    ...(options.priorOwnersGrowthThreshold !== undefined
      ? { priorOwnersGrowthThreshold: options.priorOwnersGrowthThreshold }
      : {}),
  };

  return { snapshot, doctorInput };
}
