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
  runAgentsHeartbeatCommand,
  runAgentsListCommand,
  runAgentsPruneCommand,
  runAgentsRegisterCommand,
  runAgentsShowCommand,
  runAgentsStopCommand,
  runClaimCommand,
  runDoctorCommand,
  runEventsMigrateCommand,
  runEventsRotateCommand,
  runEventsVerifyArchiveCommand,
  runEvidenceRecordCommand,
  runGatesRunCommand,
  runInitCommand,
  runScopeCommand,
  runSpecsArchiveCommand,
  runSpecsCloseCommand,
  runSpecsCreateCommand,
  runSpecsListCommand,
  runSpecsMigrateCommand,
  runSpecsShowCommand,
  runStatusCommand,
  runWaiverCreateCommand,
  runWaiverListCommand,
  runWaiverRevokeCommand,
  runWaiverShowCommand,
  runWorktreeBindCommand,
  runWorktreeCreateCommand,
  runWorktreeDestroyCommand,
  runWorktreeListCommand,
  runWorktreeMergeCommand,
  runWorktreeMigrateRegistryCommand,
  runWorktreeRepairSparseCommand,
  type EvidenceKind,
} from './index';
import type { LeaseReason } from '@paths.design/caws-kernel';

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
  // caws events migrate / rotate / verify-archive
  //
  // v11.2 maintenance command surface for the event-log writer. See
  // docs/architecture/caws-vnext-command-surface.md §6 invariant 14 and
  // the Maintenance / control-plane subsection. Distinct semantics:
  //
  //   - migrate: v10→v11 chain migration (planner-driven; refuses
  //              fully-unparseable, requires spec-scan).
  //   - rotate:  lower-level maintenance rotation (admits fully-
  //              unparseable as evidence quarantine).
  //   - verify-archive: recompute archive sha256+line count vs the
  //              most recent chain_rotated event.
  // -------------------------------------------------------------------
  const eventsCmd = program
    .command('events')
    .description('Maintenance commands for .caws/events.jsonl (rotate, migrate, verify-archive)');

  eventsCmd
    .command('migrate')
    .description('Migrate a v10-shape events.jsonl to a v11 chain via chain_rotated rotation. Dry-run by default; --apply executes.')
    .requiredOption('--from <version>', 'Source schema version (only v10 supported in v11.2)')
    .option('--apply', 'Execute the rotation (default is dry-run)')
    .option('--reason <text>', 'Operator reason recorded into the chain_rotated payload (required for --apply)')
    .option('--actor-kind <kind>', 'Actor kind: agent | human | system | automation', 'agent')
    .option('--actor-id <id>', 'Override actor id (defaults to session id)')
    .option('--allow-partial-upgrade', 'Allow rotation when v10 specs are still present (off by default; see CAWS-MIGRATE-V10-SPECS-001)')
    .action(
      (opts: {
        from: string;
        apply?: boolean;
        reason?: string;
        actorKind?: string;
        actorId?: string;
        allowPartialUpgrade?: boolean;
      }) => {
        if (opts.from !== 'v10') {
          process.stderr.write(
            `caws events migrate: only --from v10 is supported in v11.2; got ${JSON.stringify(opts.from)}.\n`
          );
          exit(1);
          return;
        }
        const code = runEventsMigrateCommand({
          from: 'v10',
          ...(opts.apply === true ? { apply: true } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          ...(opts.actorKind !== undefined
            ? { actorKind: opts.actorKind as 'agent' | 'human' | 'system' | 'automation' }
            : {}),
          ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
          ...(opts.allowPartialUpgrade === true ? { allowPartialUpgrade: true } : {}),
        });
        exit(code);
      }
    );

  eventsCmd
    .command('rotate')
    .description('Rotate events.jsonl: archive existing chain, start fresh chain with chain_rotated genesis event. Distinct from migrate — admits fully-unparseable logs.')
    .requiredOption('--reason <text>', 'Operator reason recorded into the chain_rotated payload')
    .option('--actor-kind <kind>', 'Actor kind: agent | human | system | automation', 'agent')
    .option('--actor-id <id>', 'Override actor id (defaults to session id)')
    .option('--allow-clean', 'Allow rotation of a clean v11 chain (friction flag)')
    .action(
      (opts: {
        reason: string;
        actorKind?: string;
        actorId?: string;
        allowClean?: boolean;
      }) => {
        const code = runEventsRotateCommand({
          reason: opts.reason,
          ...(opts.actorKind !== undefined
            ? { actorKind: opts.actorKind as 'agent' | 'human' | 'system' | 'automation' }
            : {}),
          ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
          ...(opts.allowClean === true ? { allowClean: true } : {}),
        });
        exit(code);
      }
    );

  eventsCmd
    .command('verify-archive')
    .description('Verify that the archive file named in the most recent chain_rotated event byte-matches its committed digest + line count.')
    .action(() => {
      const code = runEventsVerifyArchiveCommand({});
      exit(code);
    });

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

  // -------------------------------------------------------------------
  // caws specs (CLI-SPECS-001)
  //
  // Restores v11 spec lifecycle commands. All mutation paths go through
  // specs-writer (which uses the lifecycle-transaction substrate from
  // Slice 4). The shell layer parses args + builds the actor envelope;
  // the writer owns YAML patching + event append.
  // -------------------------------------------------------------------
  const specsCmd = program
    .command('specs')
    .description('Manage CAWS spec lifecycle (create/list/show/close/archive)');

  specsCmd
    .command('create <id>')
    .description('Create a new spec in lifecycle_state: active.')
    .requiredOption('--title <title>', 'Short spec title')
    .requiredOption(
      '--mode <mode>',
      'Spec mode: feature | refactor | fix | doc | chore'
    )
    .requiredOption('--risk-tier <n>', 'Risk tier: 1, 2, or 3')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (
        id: string,
        opts: { title: string; mode: string; riskTier: string; data?: boolean }
      ) => {
        const code = runSpecsCreateCommand({
          id,
          title: opts.title,
          mode: opts.mode,
          riskTier: opts.riskTier,
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  specsCmd
    .command('list')
    .description('List specs. By default excludes archived specs.')
    .option('--archived', 'Include archived specs in the listing')
    .option('--data', 'Show structured data block on diagnostics')
    .action((opts: { archived?: boolean; data?: boolean }) => {
      const code = runSpecsListCommand({
        includeArchived: opts.archived === true,
        showData: opts.data === true,
      });
      exit(code);
    });

  specsCmd
    .command('show <id>')
    .description('Show a spec by id (searches active and archived locations).')
    .option('--data', 'Show structured data block on diagnostics')
    .action((id: string, opts: { data?: boolean }) => {
      const code = runSpecsShowCommand({
        id,
        showData: opts.data === true,
      });
      exit(code);
    });

  specsCmd
    .command('close <id>')
    .description(
      'Close an active spec. Non-destructive raw-byte YAML patch; appends spec_closed event.'
    )
    .option(
      '--resolution <r>',
      'Resolution: completed | superseded | abandoned',
      'completed'
    )
    .option(
      '--reason <text>',
      'Closure notes recorded on the spec YAML and the spec_closed event'
    )
    .option(
      '--merge-commit <sha>',
      'Optional merge commit SHA (e.g., when closure follows a worktree merge)'
    )
    .option(
      '--superseded-by <id>',
      'Spec id that supersedes this one (use with --resolution superseded)'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (
        id: string,
        opts: {
          resolution: string;
          reason?: string;
          mergeCommit?: string;
          supersededBy?: string;
          data?: boolean;
        }
      ) => {
        const code = runSpecsCloseCommand({
          id,
          resolution: opts.resolution,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          ...(opts.mergeCommit !== undefined
            ? { mergeCommit: opts.mergeCommit }
            : {}),
          ...(opts.supersededBy !== undefined
            ? { supersededBy: opts.supersededBy }
            : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  specsCmd
    .command('archive <id>')
    .description(
      'Archive a closed spec. Moves the YAML file to .caws/specs/.archive/; appends spec_archived event.'
    )
    .option(
      '--reason <text>',
      'Archive reason (advisory; spec_archived schema does not carry it)'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (id: string, opts: { reason?: string; data?: boolean }) => {
        const code = runSpecsArchiveCommand({
          id,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  specsCmd
    .command('migrate')
    .description(
      'v10→v11 spec YAML migrator (CAWS-MIGRATE-V10-SPECS-001). Default is dry-run; --apply opts into mutation. --apply without --partial refuses if any spec hits a "refused" verdict. --apply --partial writes migratable specs, skips refused, emits a durable JSON report under .caws/migrations/v10-specs/.'
    )
    .requiredOption(
      '--from <version>',
      'Source schema version (only v10 is supported in v11.2)'
    )
    .option('--apply', 'Write migrated YAMLs to disk (default: dry-run)')
    .option(
      '--partial',
      'Allow apply to proceed even when some specs are refused (only meaningful with --apply)'
    )
    .option(
      '--lifecycle-mapping <path>',
      'Path to a JSON file mapping spec ids to v11 lifecycle values, for v10 lifecycles outside the v11 enum (superseded/proven/frozen). Operator-owned; the transformer never auto-defaults.'
    )
    .option('--json', 'Emit machine-readable JSON output instead of human text')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (opts: {
        from: string;
        apply?: boolean;
        partial?: boolean;
        lifecycleMapping?: string;
        json?: boolean;
        data?: boolean;
      }) => {
        const code = runSpecsMigrateCommand({
          from: opts.from,
          apply: opts.apply === true,
          partial: opts.partial === true,
          ...(opts.lifecycleMapping !== undefined
            ? { lifecycleMappingPath: opts.lifecycleMapping }
            : {}),
          json: opts.json === true,
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  // -------------------------------------------------------------------
  // caws worktree (CLI-WORKTREE-001)
  //
  // Restores v11 worktree lifecycle commands. All mutation paths go
  // through worktrees-writer (which uses the lifecycle-transaction
  // substrate from Slice 4 + applyRegistryPatch + specs-writer.closeSpec
  // for auto-close on merge).
  // -------------------------------------------------------------------
  const worktreeCmd = program
    .command('worktree')
    .description(
      'Manage CAWS worktrees (create/list/bind/destroy/merge). Worktrees are git worktrees bound to active specs.'
    );

  worktreeCmd
    .command('create <name>')
    .description(
      'Create a new git worktree under .caws/worktrees/<name> bound to an active spec.'
    )
    .requiredOption('--spec <id>', 'Active spec id to bind the worktree to')
    .option('--base-branch <branch>', 'Base branch to start from (default: current branch)')
    .option('--branch <branch>', 'New branch name (default: worktree name)')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (
        name: string,
        opts: {
          spec: string;
          baseBranch?: string;
          branch?: string;
          data?: boolean;
        }
      ) => {
        const code = runWorktreeCreateCommand({
          name,
          specId: opts.spec,
          ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
          ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  worktreeCmd
    .command('list')
    .description('List registered worktrees with branch, spec binding, and owner.')
    .option('--data', 'Show structured data block on diagnostics')
    .action((opts: { data?: boolean }) => {
      const code = runWorktreeListCommand({ showData: opts.data === true });
      exit(code);
    });

  worktreeCmd
    .command('bind <name>')
    .description(
      'Repair bidirectional binding between a worktree and a spec (one-sided → bound).'
    )
    .requiredOption('--spec <id>', 'Spec id to bind the worktree to')
    .option('--data', 'Show structured data block on diagnostics')
    .action((name: string, opts: { spec: string; data?: boolean }) => {
      const code = runWorktreeBindCommand({
        name,
        specId: opts.spec,
        showData: opts.data === true,
      });
      exit(code);
    });

  worktreeCmd
    .command('destroy <name>')
    .description(
      'Destroy a worktree. Non-forceful: refuses foreign ownership, dirty checkout, unmerged branch (use --abandon-unmerged to override branch check only).'
    )
    .option(
      '--abandon-unmerged',
      'Destroy even when the branch is not merged into base. Still respects ownership and clean working tree.'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (name: string, opts: { abandonUnmerged?: boolean; data?: boolean }) => {
        const code = runWorktreeDestroyCommand({
          name,
          ...(opts.abandonUnmerged === true ? { abandonUnmerged: true } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  worktreeCmd
    .command('merge <name>')
    .description(
      'Merge a worktree branch into its base. Auto-closes the bound spec via caws specs close.'
    )
    .option('--dry-run', 'Validate prerequisites only; no git, no file writes, no events')
    .option('--message <text>', 'Custom merge commit message (default: merge(worktree): <name>)')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (
        name: string,
        opts: { dryRun?: boolean; message?: string; data?: boolean }
      ) => {
        const code = runWorktreeMergeCommand({
          name,
          ...(opts.dryRun === true ? { dryRun: true } : {}),
          ...(opts.message !== undefined ? { message: opts.message } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  worktreeCmd
    .command('migrate-registry')
    .description(
      'Convert v10.2 legacy-envelope .caws/worktrees.json into the v11 flat-map shape. Destroyed records are omitted iff no spec claims them and their path is absent; refuses otherwise. Idempotent on already-flat files.'
    )
    .option('--dry-run', 'Classify and report what would happen; do not write.')
    .option('--data', 'Show structured data block on diagnostics')
    .action((opts: { dryRun?: boolean; data?: boolean }) => {
      const code = runWorktreeMigrateRegistryCommand({
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        showData: opts.data === true,
      });
      exit(code);
    });

  worktreeCmd
    .command('repair-sparse <name>')
    .description(
      'Restore the .caws/specs sparse-checkout invariant on a linked worktree. Idempotent and non-destructive: refuses if .caws/specs/ has dirty or untracked content rather than stashing, cleaning, resetting, or deleting it. Use this after a `git sparse-checkout disable` has materialized canonical spec files into the worktree.'
    )
    .option('--data', 'Show structured data block on diagnostics')
    .action((name: string, opts: { data?: boolean }) => {
      const code = runWorktreeRepairSparseCommand({
        name,
        showData: opts.data === true,
      });
      exit(code);
    });

  // ─── caws agents (MULTI-AGENT-ACTIVITY-REGISTRY-001) ────────────────────
  const agentsCmd = program
    .command('agents')
    .description(
      'Agent liveness substrate: register/heartbeat/stop/list/show/prune. ' +
        'Operational cache only — NEVER authority. CAWS-native JSON; never Claude Code hook envelope.'
    );

  agentsCmd
    .command('register')
    .description('Register this session in .caws/leases/. Hook-invoked at SessionStart.')
    .option('--session-id <id>', 'Explicit session id (required for hook-invoked usage; overrides resolveSession)')
    .option('--platform <p>', 'Platform tag (e.g., claude-code, cursor, manual)')
    .option('--reason <r>', 'session_start | pre_tool_use | manual_register | claim | status')
    .option('--json', 'Emit CAWS-native JSON to stdout (never hookSpecificOutput)')
    .option('--include-active-summary', 'Include active_agent_count + active_agents in JSON output')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (opts: {
        sessionId?: string;
        platform?: string;
        reason?: string;
        json?: boolean;
        includeActiveSummary?: boolean;
        data?: boolean;
      }) => {
        const code = runAgentsRegisterCommand({
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason as LeaseReason } : {}),
          json: opts.json === true,
          includeActiveSummary: opts.includeActiveSummary === true,
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  agentsCmd
    .command('heartbeat')
    .description('Refresh this session\'s lease. Hook-invoked at PreToolUse. Throttle-aware.')
    .option('--session-id <id>', 'Explicit session id (required for hook-invoked usage)')
    .option('--platform <p>', 'Platform tag')
    .option('--reason <r>', 'pre_tool_use | claim | status | manual_register')
    .option('--throttle <ms>', 'Skip write if last_active within this many ms (default: 0 — no throttle)')
    .option('--json', 'Emit CAWS-native JSON to stdout')
    .option('--include-active-summary', 'Include active_agent_count + active_agents in JSON output')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (opts: {
        sessionId?: string;
        platform?: string;
        reason?: string;
        throttle?: string;
        json?: boolean;
        includeActiveSummary?: boolean;
        data?: boolean;
      }) => {
        const throttleMs = opts.throttle !== undefined ? Number(opts.throttle) : 0;
        const code = runAgentsHeartbeatCommand({
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason as LeaseReason } : {}),
          throttleMs: Number.isFinite(throttleMs) && throttleMs > 0 ? throttleMs : 0,
          json: opts.json === true,
          includeActiveSummary: opts.includeActiveSummary === true,
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  agentsCmd
    .command('stop')
    .description('Mark this session\'s lease stopped. Hook-invoked at Stop. Warn no-op if no prior lease.')
    .option('--session-id <id>', 'Explicit session id')
    .option('--platform <p>', 'Platform tag')
    .option('--json', 'Emit CAWS-native JSON to stdout')
    .option('--data', 'Show structured data block on diagnostics')
    .action((opts: { sessionId?: string; platform?: string; json?: boolean; data?: boolean }) => {
      const code = runAgentsStopCommand({
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
        json: opts.json === true,
        showData: opts.data === true,
      });
      exit(code);
    });

  agentsCmd
    .command('list')
    .description('List active / stale / stopped agents. Read-only.')
    .option('--include-stale', 'Include stale (active-but-TTL-expired) records')
    .option('--include-stopped', 'Include stopped records')
    .option('--active', 'Active-only (overrides --include-* flags); TTL-classified active, not raw status field')
    .option('--stale-ttl-ms <ms>', 'TTL for stale classification (default: 1800000 = 30m)')
    .option('--json', 'Emit CAWS-native JSON to stdout')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (opts: {
        includeStale?: boolean;
        includeStopped?: boolean;
        active?: boolean;
        staleTtlMs?: string;
        json?: boolean;
        data?: boolean;
      }) => {
        const ttl = opts.staleTtlMs !== undefined ? Number(opts.staleTtlMs) : undefined;
        const code = runAgentsListCommand({
          includeStale: opts.includeStale === true,
          includeStopped: opts.includeStopped === true,
          activeOnly: opts.active === true,
          ...(ttl !== undefined && Number.isFinite(ttl) ? { staleTtlMs: ttl } : {}),
          json: opts.json === true,
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  agentsCmd
    .command('show <id>')
    .description('Show one lease by session id. Read-only.')
    .option('--json', 'Emit CAWS-native JSON to stdout')
    .option('--data', 'Show structured data block on diagnostics')
    .action((id: string, opts: { json?: boolean; data?: boolean }) => {
      const code = runAgentsShowCommand({
        id,
        json: opts.json === true,
        showData: opts.data === true,
      });
      exit(code);
    });

  agentsCmd
    .command('prune')
    .description(
      'Operator-invoked cleanup. Defaults to dry-run; pass --apply to actually delete. ' +
        'Never invoked by hooks.'
    )
    .requiredOption('--status <s>', 'stopped | stale')
    .requiredOption('--older-than-ms <ms>', 'Retention threshold in milliseconds')
    .option('--stale-ttl-ms <ms>', 'TTL for stale classification (used with --status stale; default 30m)')
    .option('--apply', 'Actually delete (default: dry-run)')
    .option('--json', 'Emit CAWS-native JSON to stdout')
    .option('--data', 'Show structured data block on diagnostics')
    .action(
      (opts: {
        status: string;
        olderThanMs: string;
        staleTtlMs?: string;
        apply?: boolean;
        json?: boolean;
        data?: boolean;
      }) => {
        const status = opts.status === 'stopped' || opts.status === 'stale' ? opts.status : null;
        const olderThanMs = Number(opts.olderThanMs);
        if (status === null || !Number.isFinite(olderThanMs)) {
          process.stderr.write(
            'caws agents prune: --status must be stopped|stale and --older-than-ms must be a number.\n'
          );
          exit(1);
          return;
        }
        const staleTtl = opts.staleTtlMs !== undefined ? Number(opts.staleTtlMs) : undefined;
        const code = runAgentsPruneCommand({
          status,
          olderThanMs,
          ...(staleTtl !== undefined && Number.isFinite(staleTtl) ? { staleTtlMs: staleTtl } : {}),
          apply: opts.apply === true,
          json: opts.json === true,
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
