// Commander registration bridge for the vNext shell commands.
//
// Thin translator: read Commander options → call the existing
// `run*Command` functions → set `process.exitCode`. It does NOT
// reimplement command behavior. It does NOT inspect business logic.
//
// 5c.9 / 5c.10 boundary:
//
//   - REPLACES the legacy `scope` command group (no env-var feature
//     flag, no compatibility alias, no duplicate registration).
//   - ADDS `doctor` and `evidence record` as new noun groups.
//   - Leaves all other legacy commands (validate, iterate, evaluate,
//     verify-acs, status, worktree create/merge, spec create/close,
//     etc.) UNTOUCHED.

import type { Command } from 'commander';

import {
  runClaimCommand,
  runDoctorCommand,
  runEvidenceRecordCommand,
  runGatesRunCommand,
  runInitCommand,
  runScopeCommand,
  runStatusCommand,
  runWaiverCreateCommand,
  runWaiverListCommand,
  runWaiverRevokeCommand,
  runWaiverShowCommand,
  type EvidenceKind,
} from './index';

export interface RegisterShellCommandsOptions {
  /**
   * Exit hook used after every shell command. Default `process.exit`.
   * Tests inject a recorder so they can assert exit codes without
   * actually exiting the test process.
   */
  readonly exit?: (code: number) => void;
}

function parseDataOption(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new TypeError('--data must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `caws evidence record: invalid --data JSON: ${(e as Error).message}`
    );
  }
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return value === 'test' || value === 'gate' || value === 'ac';
}

export function registerShellCommands(
  program: Command,
  options: RegisterShellCommandsOptions = {}
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));

  // -------------------------------------------------------------------
  // caws init
  //
  // Creates the canonical vNext .caws/ shape (specs/, waivers/,
  // policy.yaml, worktrees.json, agents.json). Idempotent. Refuses to
  // overwrite legacy state (working-spec.yaml et al.). No --force.
  // Replaces the legacy `caws init` registration removed from
  // src/index.js as part of slice 7b.
  // -------------------------------------------------------------------
  program
    .command('init')
    .description(
      'Bootstrap the canonical vNext .caws/ project state (idempotent; ' +
        'refuses to overwrite legacy single-spec layout). With ' +
        '--agent-surface, also installs the corresponding hook pack.'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .option(
      '--agent-surface <name>',
      'Install a hook pack for an agent harness ' +
        '(claude-code | cursor | windsurf | none). When omitted, init ' +
        'attempts filesystem detection and skips hook install when ' +
        'ambiguous.'
    )
    .option(
      '--overwrite',
      'For hook-pack install: replace drifted or unmanaged files at ' +
        'managed pack paths. CAUTION: local edits to those files will ' +
        'be lost.'
    )
    .option(
      '--adopt',
      'For hook-pack install: leave drifted or unmanaged files in place ' +
        'without enforcing pack contents. CAUTION: pack drift is no ' +
        'longer tracked for those paths.'
    )
    .action(
      (opts: {
        data?: boolean;
        agentSurface?: string;
        overwrite?: boolean;
        adopt?: boolean;
      }) => {
        // Commander hands back the raw string for agentSurface; the
        // runInitCommand validator rejects unknown values with exit 2.
        const runOpts: Parameters<typeof runInitCommand>[0] = {
          showData: opts.data === true,
        };
        if (opts.agentSurface !== undefined) {
          (runOpts as { agentSurface?: string }).agentSurface =
            opts.agentSurface;
        }
        if (opts.overwrite !== undefined) {
          (runOpts as { overwrite?: boolean }).overwrite = opts.overwrite;
        }
        if (opts.adopt !== undefined) {
          (runOpts as { adopt?: boolean }).adopt = opts.adopt;
        }
        const code = runInitCommand(runOpts);
        exit(code);
      }
    );

  // -------------------------------------------------------------------
  // caws doctor
  // -------------------------------------------------------------------
  program
    .command('doctor')
    .description('Run drift detection against the current .caws/ state')
    .option('--data', 'Show structured data block on findings/diagnostics')
    .action((opts: { data?: boolean }) => {
      const code = runDoctorCommand({
        showData: opts.data === true,
      });
      exit(code);
    });

  // -------------------------------------------------------------------
  // caws scope show <path>   /   caws scope check <path>
  // (replaces the legacy `scope` group entirely)
  // -------------------------------------------------------------------
  const scopeCmd = program
    .command('scope')
    .description('Evaluate file paths against the bound spec scope');

  scopeCmd
    .command('show <path>')
    .description('Explain the scope decision for <path>; always exits 0')
    .option('--data', 'Show structured data block')
    .action((p: string, opts: { data?: boolean }) => {
      const code = runScopeCommand({
        path: p,
        mode: 'show',
        showData: opts.data === true,
      });
      exit(code);
    });

  scopeCmd
    .command('check <path>')
    .description('Enforce the scope decision for <path>; exits 0 on admit, 1 otherwise')
    .option('--data', 'Show structured data block')
    .action((p: string, opts: { data?: boolean }) => {
      const code = runScopeCommand({
        path: p,
        mode: 'check',
        showData: opts.data === true,
      });
      exit(code);
    });

  // -------------------------------------------------------------------
  // caws status — read-only dashboard (replaces legacy status)
  // -------------------------------------------------------------------
  program
    .command('status')
    .description(
      'Read-only dashboard: project, current context, claim, and doctor findings'
    )
    .option('--data', 'Show structured data block on rendered diagnostics')
    .action((opts: { data?: boolean }) => {
      const code = runStatusCommand({
        showData: opts.data === true,
      });
      exit(code);
    });

  // -------------------------------------------------------------------
  // caws claim [--takeover]
  // -------------------------------------------------------------------
  program
    .command('claim')
    .description(
      'Surface ownership of the current worktree; with --takeover, ' +
        'acquire ownership from a foreign session (writes prior_owners audit).'
    )
    .option(
      '--takeover',
      'Forcibly take ownership of a foreign-owned worktree. Required when ' +
        'the current owner is a different session.'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action((opts: { takeover?: boolean; data?: boolean }) => {
      const code = runClaimCommand({
        takeover: opts.takeover === true,
        showData: opts.data === true,
      });
      exit(code);
    });

  // -------------------------------------------------------------------
  // caws gates run --spec <id> [--context <ctx>]
  // (replaces the legacy `gates` group and `quality-gates` alias)
  // -------------------------------------------------------------------
  const gatesCmd = program
    .command('gates')
    .description('Run quality gates against the current changes (policy-driven)');

  gatesCmd
    .command('run')
    .description(
      'Invoke quality-gates subprocess and apply policy.gates[gate].mode ' +
        'to decide block/warn/skip. Appends one gate_evaluated event per ' +
        'policy-declared gate.'
    )
    .requiredOption('--spec <id>', 'Spec id this gate run is about')
    .option(
      '--context <ctx>',
      'Subprocess context: cli | commit | ci',
      'cli'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (opts: { spec: string; context: string; data?: boolean }) => {
        const code = runGatesRunCommand(
          { specId: opts.spec },
          {
            subprocessArgs: [`--context=${opts.context}`],
            showData: opts.data === true,
          }
        );
        exit(code);
      }
    );

  // -------------------------------------------------------------------
  // caws evidence record
  // -------------------------------------------------------------------
  const evidenceCmd = program
    .command('evidence')
    .description('Record typed evidence events into .caws/events.jsonl');

  evidenceCmd
    .command('record')
    .description('Append a typed evidence event (test|gate|ac)')
    .requiredOption('--type <kind>', 'Evidence kind: test | gate | ac')
    .requiredOption('--spec <id>', 'Spec id this evidence is about')
    .requiredOption('--data <json>', 'Event payload as a JSON object string')
    .option('--actor-kind <kind>', 'Actor kind: agent | human | system | automation', 'agent')
    .option('--actor-id <id>', 'Override actor id (defaults to session id)')
    .action(
      (opts: {
        type: string;
        spec: string;
        data: string;
        actorKind?: string;
        actorId?: string;
      }) => {
        // Parse --data here; pass already-typed shape to the command.
        let data: Record<string, unknown>;
        try {
          data = parseDataOption(opts.data);
        } catch (e) {
          process.stderr.write(`${(e as Error).message}\n`);
          exit(1);
          return;
        }
        if (!isEvidenceKind(opts.type)) {
          process.stderr.write(
            `caws evidence record: invalid --type ${JSON.stringify(opts.type)}; expected test|gate|ac.\n`
          );
          exit(1);
          return;
        }
        const code = runEvidenceRecordCommand({
          kind: opts.type,
          specId: opts.spec,
          data,
          ...(opts.actorKind !== undefined
            ? { actorKind: opts.actorKind as 'agent' | 'human' | 'system' | 'automation' }
            : {}),
          ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
        });
        exit(code);
      }
    );

  // -------------------------------------------------------------------
  // caws waiver create / list / show / revoke
  //
  // Singular `waiver` is the vNext authority surface. The legacy plural
  // `waivers` group is removed in src/index.js as part of slice 7a.4 —
  // no compatibility alias, no feature flag.
  // -------------------------------------------------------------------
  const waiverCmd = program
    .command('waiver')
    .description(
      'Manage CAWS waivers (bounded exception records that suppress matching gate violations)'
    );

  waiverCmd
    .command('create <id>')
    .description(
      'Create a new active waiver. Validates against the kernel before writing.'
    )
    .requiredOption('--title <title>', 'Short waiver title (≥5 chars)')
    .requiredOption(
      '--gate <gate>',
      'Gate id this waiver covers; repeat for multiple gates',
      collectMulti,
      [] as string[]
    )
    .requiredOption('--reason <reason>', 'Justification for the waiver')
    .requiredOption('--approved-by <id>', 'Approver identity')
    .requiredOption(
      '--expires-at <iso>',
      'Expiry as an ISO-8601 datetime with timezone'
    )
    .option(
      '--spec <id>',
      'Optional spec id this waiver is scoped to (omit for project-wide)'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (
        id: string,
        opts: {
          title: string;
          gate: string[];
          reason: string;
          approvedBy: string;
          expiresAt: string;
          spec?: string;
          data?: boolean;
        }
      ) => {
        const code = runWaiverCreateCommand({
          id,
          title: opts.title,
          gates: opts.gate,
          reason: opts.reason,
          approvedBy: opts.approvedBy,
          expiresAt: opts.expiresAt,
          ...(opts.spec !== undefined ? { specId: opts.spec } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  waiverCmd
    .command('list')
    .description(
      'List waivers. By default excludes revoked and expired records.'
    )
    .option('--include-revoked', 'Include revoked waivers')
    .option('--include-expired', 'Include expired waivers')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (opts: {
        includeRevoked?: boolean;
        includeExpired?: boolean;
        data?: boolean;
      }) => {
        const code = runWaiverListCommand({
          includeRevoked: opts.includeRevoked === true,
          includeExpired: opts.includeExpired === true,
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  waiverCmd
    .command('show <id>')
    .description('Show a waiver, including its derived effectiveness at now.')
    .option('--data', 'Show structured data block on diagnostics')
    .action((id: string, opts: { data?: boolean }) => {
      const code = runWaiverShowCommand({
        id,
        showData: opts.data === true,
      });
      exit(code);
    });

  waiverCmd
    .command('revoke <id>')
    .description(
      'Revoke a waiver. Writes a revocation record; refuses double-revoke.'
    )
    .option('--revoked-by <id>', 'Identity recorded in revocation.revoked_by')
    .option(
      '--reason <reason>',
      'Reason recorded in revocation.reason (recommended for audit)'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (
        id: string,
        opts: { revokedBy?: string; reason?: string; data?: boolean }
      ) => {
        const code = runWaiverRevokeCommand({
          id,
          ...(opts.revokedBy !== undefined ? { revokedBy: opts.revokedBy } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );
}

/** Commander value collector for repeatable string options. */
function collectMulti(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}
