// `caws status` — vNext read-only dashboard.
//
// Hard constraint: status MUST NOT mutate anything. It loads state,
// runs the kernel diagnoser, and renders. It does NOT mint capsules,
// refresh heartbeats, write events, mutate worktrees.json, or alter
// agents.json. Ownership mutation belongs to `caws claim`; spec
// lifecycle belongs to `caws spec *`; event emission belongs to
// `caws evidence record`.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)
//   2. composeDoctorSnapshot(...)        → snapshot + doctorInput
//   3. inspectProjectState(doctorInput)  → DoctorReport
//   4. resolveBinding(cwd, registry, specs)
//   5. resolveSession({ allowMint: false }) — read-only; never mints
//   6. renderStatus(...)                  → stdout
//   7. exit 0 (regardless of doctor findings) or 2 on composition error
//
// Doctor findings drive PROMINENT DISPLAY in the dashboard. They do
// NOT change the exit code. `caws doctor` is the diagnostic command
// with 0/1/2 semantics; status is observability.

import { inspectProjectState } from '@paths.design/caws-kernel';

import { composeDoctorSnapshot, resolveRepoRoot } from '../../store';
import { resolveBinding } from '../binding/resolve-binding';
import { renderDiagnostics } from '../render/diagnostic';
import { renderStatus } from '../render/status';
import { resolveSession } from '../session/resolve-session';

export interface StatusCommandOptions {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Stale heartbeat TTL in ms; display only. Default 24h. */
  readonly staleTtlMs?: number;
  /** Cap on rendered top findings. Default 5. */
  readonly findingCap?: number;
  /** Show structured data blocks on rendered diagnostics. */
  readonly showData?: boolean;
}

export function runStatusCommand(opts: StatusCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // 1. Repo root
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws status: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;
  const now = nowFn();

  // 2. Snapshot + doctor input
  let composition: ReturnType<typeof composeDoctorSnapshot>;
  try {
    composition = composeDoctorSnapshot({ repoRoot, cawsDir, now });
  } catch (e) {
    err(`caws status: store composition failed: ${(e as Error).message}`);
    return 2;
  }
  const { snapshot, doctorInput } = composition;

  // 3. Run the kernel diagnoser
  let report: ReturnType<typeof inspectProjectState>;
  try {
    report = inspectProjectState(doctorInput);
  } catch (e) {
    err(`caws status: kernel inspect failed: ${(e as Error).message}`);
    return 2;
  }

  // 4. Binding from cwd
  const binding = resolveBinding({
    repoRoot,
    cwd,
    registry: snapshot.worktrees,
    specs: snapshot.specs,
  });

  // 5. Session — READ-ONLY. Never pass allowMint: true here.
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    // allowMint: false — read-only; status MUST NOT mint capsules.
  });

  // 6. Render
  // Event-chain validity is captured in the doctor findings (via
  // doctor.event.chain_invalid); the status dashboard surfaces a
  // chain-broken note only when the kernel actually emitted that finding.
  const chainBroken = report.findings.some(
    (f) => f.rule === 'doctor.event.chain_invalid' && f.severity === 'error'
  );

  out(
    renderStatus({
      repoRoot,
      cawsDir,
      policyLoaded: snapshot.policy !== undefined,
      specs: snapshot.specs,
      worktrees: snapshot.worktrees,
      agents: snapshot.agents,
      eventCount: snapshot.events.length,
      // Only emit a chain-OK/broken label when there are events to chain.
      ...(snapshot.events.length > 0 ? { eventChainOk: !chainBroken } : {}),
      binding,
      session: sessionResult.ok ? sessionResult.value : null,
      doctorFindings: report.findings,
      now,
      ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
      ...(opts.findingCap !== undefined ? { findingCap: opts.findingCap } : {}),
    })
  );

  // 7. Exit. Status is observability, never a gate.
  return 0;
}
