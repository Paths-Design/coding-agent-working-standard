// `caws gates run` — single policy-driven gate execution path.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)
//   2. composeStoreSnapshot               — we need the policy
//   3. policy presence check              — gates cannot run without policy
//   4. resolveSession({ allowMint: true }) — we will append events
//   5. runQualityGates(adapter)            — subprocess + JSON validation
//   6. deriveDispositions(report, policy)  — policy decides block/warn/skip
//   7. For each disposition, appendEvent(`gate_evaluated`)
//   8. Render summary
//   9. Exit code:
//      0 if no disposition blocks
//      1 if any disposition blocks
//      2 on hard composition errors (no policy, subprocess contract failure,
//        event append failure)
//
// The subprocess does NOT decide blocking. The policy does. The subprocess
// reports violations; this command groups them per policy-declared gate
// and applies policy.gates[gate].mode to compute outcome.

import {
  type Actor,
  type EventBody,
} from '@paths.design/caws-kernel';

import {
  appendEvent,
  composeStoreSnapshot,
  loadWaivers,
  resolveRepoRoot,
} from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import { renderGatesRun } from '../render/gates';
import { resolveSession } from '../session/resolve-session';
import { buildActor } from '../session/actor';
import { SHELL_RULES } from '../rules';
import {
  deriveDispositions,
  type GateDisposition,
} from '../gates/disposition';
import {
  runQualityGates,
  type QualityGatesRunner,
} from '../gates/quality-gates-adapter';
import {
  filterWaivedViolations,
  type WaiverEvidence,
} from '../gates/waiver-filter';

export interface GatesRunCommandOptions {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Extra args to pass to the subprocess after --json. */
  readonly subprocessArgs?: readonly string[];
  /** Injected subprocess runner (tests). */
  readonly runner?: QualityGatesRunner;
  /** Show structured data on rendered diagnostics. */
  readonly showData?: boolean;
}

const MAX_EVENT_VIOLATIONS = 100;

function dispositionToEventBody(args: {
  disposition: GateDisposition;
  ts: string;
  actor: Actor;
  specId: string;
  waiverEvidence?: WaiverEvidence;
}): EventBody {
  const violations = args.disposition.violations
    .slice(0, MAX_EVENT_VIOLATIONS)
    .map((v) => ({
      rule: typeof v.type === 'string' ? v.type : 'unknown',
      subject:
        typeof v.file === 'string'
          ? typeof v.line === 'number'
            ? `${v.file}:${v.line}`
            : v.file
          : (v.gate ?? 'unknown'),
      ...(v.message !== undefined ? { details: v.message } : {}),
    }));

  const ev = args.waiverEvidence;
  const waivedCount = ev?.waived_count ?? 0;

  return {
    event: 'gate_evaluated',
    ts: args.ts,
    actor: args.actor,
    spec_id: args.specId,
    data: {
      gate_id: args.disposition.gate_id,
      mode: args.disposition.mode,
      result: args.disposition.outcome === 'skipped' ? 'skipped' : args.disposition.outcome,
      violations,
      waived_count: waivedCount,
      ...(ev !== undefined && ev.waiver_ids.length > 0
        ? { waiver_ids: ev.waiver_ids.slice() }
        : {}),
    },
  } as unknown as EventBody;
}

export interface GatesRunCommandRequest {
  readonly specId: string;
}

export function runGatesRunCommand(
  request: GatesRunCommandRequest,
  opts: GatesRunCommandOptions = {}
): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  if (typeof request.specId !== 'string' || request.specId.length === 0) {
    err('caws gates run: --spec is required.');
    err(`(rule: ${SHELL_RULES.COMMAND_MISSING_SPEC_ID})`);
    return 1;
  }

  // 1. Repo root
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws gates run: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  // 2. Snapshot for policy
  let snapshot: ReturnType<typeof composeStoreSnapshot>;
  try {
    snapshot = composeStoreSnapshot({ repoRoot, cawsDir });
  } catch (e) {
    err(`caws gates run: store composition failed: ${(e as Error).message}`);
    return 2;
  }

  // 3. Policy required — gates cannot decide mode without it.
  if (snapshot.policy === undefined) {
    err(
      `caws gates run: no policy.yaml loaded — gates require policy to derive ` +
        `block/warn/skip semantics. Run \`caws doctor\` for details.`
    );
    err(`(rule: ${SHELL_RULES.GATES_POLICY_REQUIRED})`);
    if (snapshot.policyErrors.length > 0) {
      err(renderDiagnostics(snapshot.policyErrors, { showData }));
    }
    return 2;
  }
  const policy = snapshot.policy;

  // 4. Session (write op — gates append events)
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    err('caws gates run: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }
  const actor: Actor = buildActor({
    session: sessionResult.value,
    kind: 'agent',
  });

  // 5. Subprocess + contract validation
  const runOpts: { cwd: string; runner?: QualityGatesRunner; args?: readonly string[] } = {
    cwd: repoRoot,
  };
  if (opts.runner !== undefined) runOpts.runner = opts.runner;
  if (opts.subprocessArgs !== undefined) runOpts.args = opts.subprocessArgs;
  const reportResult = runQualityGates(runOpts);
  if (!reportResult.ok) {
    err('caws gates run: quality-gates subprocess contract failure.');
    err(renderDiagnostics(reportResult.errors, { showData }));
    return 2;
  }
  const report = reportResult.value;

  // 6a. Load + apply waivers BEFORE disposition.
  //     Waivers do NOT mutate policy.gates[gate].mode. They remove
  //     authorized-exception violations from the report so blocking is
  //     computed only from unwaived violations. Malformed waiver files
  //     produce diagnostics but never discard valid waivers.
  const waiversLoad = loadWaivers(cawsDir);
  if (waiversLoad.diagnostics.length > 0) {
    err(renderDiagnostics(waiversLoad.diagnostics, { showData }));
  }
  const waiverFilter = filterWaivedViolations({
    report,
    waivers: waiversLoad.waivers,
    specId: request.specId,
    now: nowFn(),
    policyGateIds: Object.keys(policy.gates),
  });

  // 6b. Policy-driven disposition on UNWAIVED violations only.
  const dispositionResult = deriveDispositions(
    waiverFilter.reportForDisposition,
    policy
  );

  // 7. Append one gate_evaluated event per policy-declared gate.
  //    Failure to append is a hard error: evidence integrity matters.
  const ts = nowFn().toISOString();
  for (const d of dispositionResult.dispositions) {
    const body = dispositionToEventBody({
      disposition: d,
      ts,
      actor,
      specId: request.specId,
      ...(waiverFilter.waivedByGate[d.gate_id] !== undefined
        ? { waiverEvidence: waiverFilter.waivedByGate[d.gate_id] }
        : {}),
    });
    const append = appendEvent(cawsDir, body);
    if (!append.ok) {
      err(`caws gates run: failed to append gate_evaluated event for ${d.gate_id}.`);
      err(renderDiagnostics(append.errors, { showData }));
      return 2;
    }
  }

  // 8. Render summary
  out(renderGatesRun(dispositionResult));

  // 9. Exit by policy disposition.
  return dispositionResult.anyBlocks ? 1 : 0;
}
