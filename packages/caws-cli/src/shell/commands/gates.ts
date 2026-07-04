// `caws gates run` — single policy-driven gate execution path.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)
//   2. composeStoreSnapshot               — we need the policy
//   3. policy presence check              — gates cannot run without policy
//   4. resolveSession({ allowMint: true }) — we will append events
//   5. build an in-process report          — production is empty; tests may inject
//      a report fixture directly
//   6. deriveDispositions(report, policy)  — policy decides block/warn/skip
//   6c. zero-disposition guard             — refuse to "succeed" with no evidence
//   7. For each disposition, appendEvent(`gate_evaluated`); per-gate isolation —
//      one append failure does NOT abort the loop, subsequent gates are still
//      attempted so partial evidence is captured.
//   8. Render summary
//   9. Exit code:
//      0 if no disposition blocks AND every gate's evidence was durably appended
//      1 if any disposition blocks AND every gate's evidence was durably appended
//      2 on hard composition errors (no policy, injected report contract failure,
//        spec not found, session resolution failure)
//      3 on evidence-integrity failure: any gate's gate_evaluated event was
//        rejected by the store (schema violation, lock contention, I/O failure)
//        OR zero gates were dispositioned (no evidence ever appended). Exit 3
//        is distinct from exit 1 so CI can distinguish "policy said block" from
//        "evidence was lost" — both are non-zero, but only one means the
//        coverage signal itself is suspect.
//
// Policy owns blocking. Injected reports, when provided by tests, only report
// violations; this command groups them per policy-declared gate and applies
// policy.gates[gate].mode to compute outcome. Production no longer spawns an
// external quality package.
//
// CAWS-GATES-RUN-ABORT-ON-CORRUPT-CHAIN-001: prior to this slice the append
// loop fail-fast'd on first failure and returned 2; that masked sibling gates'
// outcomes and conflated evidence-integrity with composition failure. The
// zero-disposition guard was absent entirely — a run with no policy-declared
// known-gate intersections silently exited 0 with no audit trail.

import {
  type Actor,
  type Diagnostic,
  type EventBody,
  effectiveWaiversForGate,
  type GateConfig,
  type Policy,
  type Waiver,
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
import { runLocalEvaluators } from '../gates/local-evaluators';
import {
  validateGatesReport,
  type GatesReport,
} from '../gates/gate-result-contract';
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
  /** Injected report fixture (tests). Production omits this. */
  readonly report?: GatesReport | string;
  /** Show structured data on rendered diagnostics. */
  readonly showData?: boolean;
}

export interface GatesListCommandOptions {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly json?: boolean;
  readonly specId?: string;
  /** Show structured data on rendered diagnostics. */
  readonly showData?: boolean;
}

export interface GatesExplainCommandOptions {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly json?: boolean;
  readonly specId?: string;
  readonly gateId: string;
  /** Show structured data on rendered diagnostics. */
  readonly showData?: boolean;
}

const MAX_EVENT_VIOLATIONS = 100;

/** Exit code reserved for evidence-integrity failures (see file header §9). */
const EXIT_EVIDENCE_INTEGRITY = 3;

/**
 * Inline rule strings for diagnostics this command owns. These are kept
 * here rather than added to SHELL_RULES because shell/rules.ts is outside
 * this slice's scope.in; the strings are still typed (string literal),
 * still grep-able, and still propagated verbatim to stderr.
 */
const GATES_NO_DISPOSITIONS_RULE = 'shell.gates.no_dispositions';
const GATES_EVIDENCE_LOST_RULE = 'shell.gates.evidence_lost';

interface GateDiscoverySnapshot {
  readonly repoRoot: string;
  readonly cawsDir: string;
  readonly policy: Policy;
  readonly waivers: readonly Waiver[];
}

interface GateSummary {
  readonly gate_id: string;
  readonly enabled: boolean;
  readonly mode: string;
  readonly description: string | null;
  readonly thresholds: Record<string, unknown>;
  readonly effective_waiver_ids: readonly string[];
  readonly effective_waiver_count: number;
}

function loadGateDiscoverySnapshot(
  cwd: string,
  err: (line: string) => void,
  showData: boolean,
  commandName: string
): GateDiscoverySnapshot | null {
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err(`caws gates ${commandName}: failed to resolve repo root.`);
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return null;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  let snapshot: ReturnType<typeof composeStoreSnapshot>;
  try {
    snapshot = composeStoreSnapshot({ repoRoot, cawsDir });
  } catch (e) {
    err(`caws gates ${commandName}: store composition failed: ${(e as Error).message}`);
    return null;
  }
  if (snapshot.policy === undefined) {
    err(
      `caws gates ${commandName}: no policy.yaml loaded — gate discovery requires policy. Run \`caws doctor\` for details.`
    );
    err(`(rule: ${SHELL_RULES.GATES_POLICY_REQUIRED})`);
    if (snapshot.policyErrors.length > 0) {
      err(renderDiagnostics(snapshot.policyErrors, { showData }));
    }
    return null;
  }
  if (snapshot.waiverDiagnostics.length > 0) {
    err(renderDiagnostics(snapshot.waiverDiagnostics, { showData }));
  }
  return {
    repoRoot,
    cawsDir,
    policy: snapshot.policy,
    waivers: snapshot.waivers,
  };
}

function gateSummary(args: {
  readonly gateId: string;
  readonly config: GateConfig;
  readonly waivers: readonly Waiver[];
  readonly specId?: string;
  readonly now: Date;
}): GateSummary {
  const effective = effectiveWaiversForGate({
    waivers: args.waivers,
    gate: args.gateId,
    ...(args.specId !== undefined ? { specId: args.specId } : {}),
    now: args.now,
  });
  return {
    gate_id: args.gateId,
    enabled: args.config.enabled,
    mode: args.config.mode,
    description: args.config.description ?? null,
    thresholds: args.config.thresholds ?? {},
    effective_waiver_ids: effective.map((waiver) => waiver.id).sort(),
    effective_waiver_count: effective.length,
  };
}

function gateSummaries(args: {
  readonly policy: Policy;
  readonly waivers: readonly Waiver[];
  readonly specId?: string;
  readonly now: Date;
}): readonly GateSummary[] {
  return Object.entries(args.policy.gates).map(([gateId, config]) =>
    gateSummary({
      gateId,
      config: config as GateConfig,
      waivers: args.waivers,
      ...(args.specId !== undefined ? { specId: args.specId } : {}),
      now: args.now,
    })
  );
}

export function runGatesListCommand(opts: GatesListCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const now = (opts.now ?? (() => new Date()))();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  const loaded = loadGateDiscoverySnapshot(cwd, err, showData, 'list');
  if (loaded === null) return 2;
  const gates = gateSummaries({
    policy: loaded.policy,
    waivers: loaded.waivers,
    ...(opts.specId !== undefined ? { specId: opts.specId } : {}),
    now,
  });

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      read_only: true,
      spec_id: opts.specId ?? null,
      gate_count: gates.length,
      gates,
      risk_tiers: loaded.policy.risk_tiers,
      waiver_policy: loaded.policy.waivers ?? {},
    }, null, 2));
    return 0;
  }

  out(`caws gates list: ${gates.length} configured gate(s)`);
  if (opts.specId !== undefined) out(`  spec: ${opts.specId}`);
  out('  gates:');
  for (const gate of gates) {
    out(
      `  - ${gate.gate_id}: enabled=${gate.enabled} mode=${gate.mode} ` +
        `effective_waivers=${gate.effective_waiver_count}`
    );
  }
  out('  risk_tiers:');
  for (const [tier, budget] of Object.entries(loaded.policy.risk_tiers)) {
    out(`  - ${tier}: max_files=${budget.max_files} max_loc=${budget.max_loc}`);
  }
  return 0;
}

export function runGatesExplainCommand(opts: GatesExplainCommandOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const now = (opts.now ?? (() => new Date()))();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  const loaded = loadGateDiscoverySnapshot(cwd, err, showData, 'explain');
  if (loaded === null) return 2;
  const config = loaded.policy.gates[opts.gateId as keyof typeof loaded.policy.gates];
  if (config === undefined) {
    const accepted = Object.keys(loaded.policy.gates).sort();
    err(
      `caws gates explain: unknown gate ${JSON.stringify(opts.gateId)}; expected one of ${accepted.join('|')}.`
    );
    return 1;
  }
  const summary = gateSummary({
    gateId: opts.gateId,
    config: config as GateConfig,
    waivers: loaded.waivers,
    ...(opts.specId !== undefined ? { specId: opts.specId } : {}),
    now,
  });

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      read_only: true,
      spec_id: opts.specId ?? null,
      gate: summary,
      waiver_policy: loaded.policy.waivers ?? {},
    }, null, 2));
    return 0;
  }

  out(`caws gates explain: ${summary.gate_id}`);
  if (opts.specId !== undefined) out(`  spec: ${opts.specId}`);
  out(`  enabled=${summary.enabled}`);
  out(`  mode=${summary.mode}`);
  if (summary.description !== null) out(`  description=${summary.description}`);
  out(`  thresholds=${JSON.stringify(summary.thresholds)}`);
  out(
    `  effective_waivers=${summary.effective_waiver_count}` +
      (summary.effective_waiver_ids.length > 0
        ? ` (${summary.effective_waiver_ids.join(', ')})`
        : '')
  );
  return 0;
}

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
  const now = nowFn();
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

  // 5. Injected report ingestion.
  //
  // `caws gates run` is the governed policy/event surface. Production no
  // longer spawns or resolves an external quality package. Tests may
  // inject a report fixture directly so the JSON contract and aliasing behavior
  // remain covered without a package dependency.
  let report: GatesReport = {
    timestamp: now.toISOString(),
    context: 'cli',
    files_scoped: 0,
    warnings: [],
    violations: [],
  };
  if (opts.report !== undefined) {
    const reportResult =
      typeof opts.report === 'string'
        ? validateGatesReport(opts.report)
        : validateGatesReport(JSON.stringify(opts.report));
    if (!reportResult.ok) {
      err('caws gates run: injected report contract failure.');
      err(renderDiagnostics(reportResult.errors, { showData }));
      return 2;
    }
    report = reportResult.value;
  }

  // 5b. Local CAWS policy evaluators. These produce violations under
  //     canonical policy gate IDs (budget_limit, scope_boundary,
  //     spec_completeness). Locating them in caws-cli keeps gate execution
  //     coupled to CAWS spec/policy authority rather than a retired package.
  //
  //     The active spec must exist and be loadable. If it isn't,
  //     refuse the run with a typed diagnostic — running gates against
  //     a missing or unparseable spec is a category error.
  const activeSpec = snapshot.specs.find((s) => s.id === request.specId);
  if (activeSpec === undefined) {
    err(
      `caws gates run: spec ${request.specId} not found in .caws/specs/. ` +
        `Either the id is wrong, or the spec failed to load (run \`caws doctor\` for details).`
    );
    err(`(rule: ${SHELL_RULES.GATES_POLICY_REQUIRED})`);
    return 2;
  }
  const localResult = runLocalEvaluators({
    spec: activeSpec,
    policy,
    repoRoot,
    nowIso: now.toISOString(),
  });
  const mergedReport: GatesReport = {
    ...report,
    violations: [...report.violations, ...localResult.violations],
  };

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
    report: mergedReport,
    waivers: waiversLoad.waivers,
    specId: request.specId,
    now,
    policyGateIds: Object.keys(policy.gates),
  });

  // 6b. Policy-driven disposition on UNWAIVED violations only.
  const dispositionResult = deriveDispositions(
    waiverFilter.reportForDisposition,
    policy
  );

  // 6c. Zero-disposition guard. A "run" that emits zero gate_evaluated
  //     events is a silent CI false-green: the dashboard goes green with
  //     no evidence that any gate was actually evaluated. Refuse before
  //     reaching the (empty) append loop. This catches the case where
  //     policy.gates intersects KNOWN_GATE_IDS only with `enabled: false`
  //     gates, or where the policy declares no gates that the disposition
  //     module recognizes.
  if (dispositionResult.dispositions.length === 0) {
    err(
      `caws gates run: no policy-declared gates were dispositioned — ` +
        `zero gate_evaluated events would be appended. A run with no ` +
        `evidence is treated as evidence-integrity failure, not success.`
    );
    err(`(rule: ${GATES_NO_DISPOSITIONS_RULE})`);
    return EXIT_EVIDENCE_INTEGRITY;
  }

  // 7. Append one gate_evaluated event per policy-declared gate.
  //
  //    Per-gate isolation: a failure to append for one gate MUST NOT abort
  //    the loop. Subsequent gates are still attempted so partial evidence
  //    is captured and operators can see which gates' evidence survived.
  //    At the end of the loop, if ANY gate's append failed, the command
  //    exits 3 (evidence integrity) with a summary listing every lost
  //    gate. This is the fix for the silent-success class: prior behavior
  //    fail-fast'd on first failure and returned 2, which conflated
  //    evidence-integrity failure with composition failure and (worse)
  //    hid subsequent gates' outcomes.
  const ts = now.toISOString();
  const lostEvidenceGates: Array<{
    readonly gateId: string;
    readonly errors: readonly Diagnostic[];
  }> = [];
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
      lostEvidenceGates.push({ gateId: d.gate_id, errors: append.errors });
      // Per-gate isolation: continue the loop, do NOT early-return.
    }
  }

  // 8. Render summary (always — partial evidence is still operator-useful).
  out(renderGatesRun(dispositionResult));

  // 9. Exit code, in priority order:
  //    - exit 3 if any gate's evidence was lost (evidence integrity beats
  //      policy disposition; a green-looking policy decision over a chain
  //      with holes is worse than a clean fail).
  //    - exit 1 if any disposition blocks (policy fail).
  //    - exit 0 otherwise (all gates appended, no policy block).
  if (lostEvidenceGates.length > 0) {
    const lostIds = lostEvidenceGates.map((e) => e.gateId).join(', ');
    err(
      `caws gates run: evidence-integrity failure — ` +
        `${lostEvidenceGates.length} of ${dispositionResult.dispositions.length} ` +
        `gate_evaluated events were rejected by the events store. ` +
        `Gates with lost evidence: ${lostIds}. Per-gate diagnostics above.`
    );
    err(`(rule: ${GATES_EVIDENCE_LOST_RULE})`);
    return EXIT_EVIDENCE_INTEGRITY;
  }
  return dispositionResult.anyBlocks ? 1 : 0;
}
