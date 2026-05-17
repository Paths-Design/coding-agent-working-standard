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

import * as fs from 'fs';
import * as path from 'path';

import {
  isOk,
  type Diagnostic,
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

  // Slice 7c.1 — observe vNext-shape facts the kernel cannot derive.
  // The store is the only place that may stat the filesystem; doctor
  // consumes the booleans below without any I/O of its own.
  const initResidue = observeInitResidue(cawsDir);
  const filesystem = observeFilesystem(cawsDir);
  const registryDiagnostics = collectRegistryDiagnostics(
    worktreesResult,
    agentsResult
  );

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
    initResidue,
    filesystem,
    registryDiagnostics,
  };
}

// ----------------------------------------------------------------------------
// 7c.1 helpers — file-existence observation
//
// These intentionally do NOT distinguish "not a file vs not a directory" —
// doctor's rules in 7c.2 only need "is this canonical surface present?".
// Distinguishing kind would expand the input shape with information no
// rule yet consumes.
// ----------------------------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function observeInitResidue(cawsDir: string): StoreSnapshot['initResidue'] {
  return {
    workingSpecYaml: isFile(path.join(cawsDir, 'working-spec.yaml')),
    workingSpecSchemaJson: isFile(
      path.join(cawsDir, 'working-spec.schema.json')
    ),
  };
}

function observeFilesystem(cawsDir: string): StoreSnapshot['filesystem'] {
  return {
    cawsDirExists: isDir(cawsDir),
    specsDirExists: isDir(path.join(cawsDir, 'specs')),
    waiversDirExists: isDir(path.join(cawsDir, 'waivers')),
    policyYamlExists: isFile(path.join(cawsDir, 'policy.yaml')),
    worktreesJsonExists: isFile(path.join(cawsDir, 'worktrees.json')),
    agentsJsonExists: isFile(path.join(cawsDir, 'agents.json')),
    eventsJsonlExists: isFile(path.join(cawsDir, 'events.jsonl')),
  };
}

function collectRegistryDiagnostics(
  worktreesResult: ReturnType<typeof loadWorktrees>,
  agentsResult: ReturnType<typeof loadAgents>
): readonly Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isOk(worktreesResult)) out.push(...worktreesResult.errors);
  if (!isOk(agentsResult)) out.push(...agentsResult.errors);
  return out;
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
    initResidue: snapshot.initResidue,
    filesystem: snapshot.filesystem,
    registryDiagnostics: snapshot.registryDiagnostics,
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
