// `caws doctor` — composition command.
//
// Pipeline (no business logic in this file):
//
//   1. resolveRepoRoot(cwd)         (store)
//   2. composeDoctorSnapshot(...)   (store)
//   3. inspectProjectState(input)   (kernel)
//   4. render store-load diagnostics  (renderer)
//   5. render doctor findings         (renderer)
//   6. choose exit code               (this file)
//
// The command does NOT read .caws/ files directly, does NOT walk specs,
// does NOT invent repair rules, and does NOT re-validate state.
//
// Exit codes:
//   0 = no error-severity findings AND no error-severity store-load
//       diagnostics
//   1 = any error-severity finding OR any error-severity store-load
//       diagnostic. (Store-load errors count even when they were filtered
//       out before reaching the kernel, because an invalid spec file is a
//       project-health problem regardless.)
//   2 = repo-root resolution failed, or other hard composition failure.
//
// Testable without Commander: caller passes cwd / out / err / now and
// receives a number. `registerShellCommands(program)` (Slice 5c.9) is the
// only place that wires this to Commander.

import type { Diagnostic } from '@paths.design/caws-kernel';
import { inspectProjectState } from '@paths.design/caws-kernel';

import {
  composeDoctorSnapshot,
  resolveRepoRoot,
} from '../../store';
import {
  countFindingSeverities,
  countSeverities,
  renderDiagnostics,
  renderFindings,
} from '../index';

export interface DoctorCommandOptions {
  readonly cwd?: string;
  readonly now?: Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /**
   * Show the optional `data` block for each diagnostic/finding. Default
   * false to keep output tight.
   */
  readonly showData?: boolean;
}

export function runDoctorCommand(opts: DoctorCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // 1. Repo root
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws doctor: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  // 2 + 3. Compose snapshot, run kernel diagnoser
  let composition: ReturnType<typeof composeDoctorSnapshot>;
  try {
    composition = composeDoctorSnapshot({ repoRoot, cawsDir, now });
  } catch (e) {
    err(`caws doctor: store composition failed: ${(e as Error).message}`);
    return 2;
  }
  const { snapshot, doctorInput } = composition;

  let report: ReturnType<typeof inspectProjectState>;
  try {
    report = inspectProjectState(doctorInput);
  } catch (e) {
    err(`caws doctor: kernel inspect failed: ${(e as Error).message}`);
    return 2;
  }

  // 4. Render store-load diagnostics — kept SEPARATE from doctor findings.
  const loadDiagnostics: Diagnostic[] = [
    ...snapshot.specDiagnostics,
    ...snapshot.policyErrors,
    ...snapshot.policyWarnings,
    ...snapshot.eventWarnings,
  ];

  out('Store load diagnostics:');
  if (loadDiagnostics.length === 0) {
    out('  (none)');
  } else {
    out(renderDiagnostics(loadDiagnostics, { showData }));
  }

  // 5. Render doctor findings — separate section.
  out('');
  out('Doctor findings:');
  if (report.findings.length === 0) {
    out('  (none)');
  } else {
    out(renderFindings(report.findings, { showData }));
  }

  // 6. Exit code
  const loadCounts = countSeverities(loadDiagnostics);
  const findingCounts = countFindingSeverities(report.findings);
  const hasErrors = findingCounts.errors > 0 || loadCounts.errors > 0;

  out('');
  out(
    `Summary: findings ${findingCounts.errors}E/${findingCounts.warnings}W/${findingCounts.infos}I; ` +
      `load ${loadCounts.errors}E/${loadCounts.warnings}W/${loadCounts.infos}I`
  );

  return hasErrors ? 1 : 0;
}
