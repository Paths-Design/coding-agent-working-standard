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
  runScopeCommand,
  runStatusCommand,
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
}
