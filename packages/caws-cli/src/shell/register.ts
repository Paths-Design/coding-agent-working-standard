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
// Runtime import (not type-only): the `Option` class is needed to register a
// hidden option via `new Option(flag, desc).hideHelp()` — Commander's
// `.option(...)` convenience method has no hide-from-help variant.
import { Option } from 'commander';

import {
  INIT_COMMAND_META,
  DOCTOR_COMMAND_META,
  STATUS_COMMAND_META,
  CLAIM_COMMAND_META,
  PREPUSH_COMMAND_META,
  SCOPE_COMMAND_META,
  GATES_COMMAND_META,
  EVIDENCE_COMMAND_META,
  EVENTS_COMMAND_META,
  WAIVER_COMMAND_META,
  AGENTS_COMMAND_META,
  MESSAGE_COMMAND_META,
  SPECS_COMMAND_META,
  WORKTREE_COMMAND_META,
  type GroupCommandMeta,
  type LeafCommandMeta,
  type CommandOptionMeta,
} from './command-metadata';
import {
  runAgentsHeartbeatCommand,
  runAgentsListCommand,
  runAgentsPruneCommand,
  runAgentsRegisterCommand,
  runAgentsShowCommand,
  runAgentsStopCommand,
  runMessageSendCommand,
  runMessagePollCommand,
  runClaimCommand,
  runDoctorCommand,
  runEventsMigrateCommand,
  runEventsRotateCommand,
  runEventsVerifyArchiveCommand,
  runEvidenceRecordCommand,
  runGatesRunCommand,
  runInitCommand,
  runPrepushCommand,
  runScopeCommand,
  runScopeContentionCommand,
  runSpecsActivateCommand,
  runSpecsAmendScopeCommand,
  runSpecsArchiveCommand,
  runSpecsPruneArchiveCommand,
  runSpecsRecoverCommand,
  runSpecsRetireDraftCommand,
  runSpecsCloseCommand,
  runSpecsCreateCommand,
  runSpecsListCommand,
  runSpecsMigrateCommand,
  runSpecsShowCommand,
  runSpecsValidateCommand,
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
  runWorktreeRepairCommand,
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

// ── Metadata-driven help wiring (CAWS-CLI-HELP-METADATA-AUTHORITY-001) ──────
// register.ts no longer authors `.description()` / `.option()` string literals
// for groups present in COMMAND_SURFACE_METADATA; it reads them from the typed
// metadata so the help text has a single, lock-tested source. The `.action()`
// handlers stay inline (they bind to the run*Command functions); only the
// help/option surface is metadata-driven.

/** Render an option's help string: prose, plus a derived "value list" when the
 * option is enum-backed (allowedValues). The value list is the locked part —
 * the lock test asserts it equals the kernel/schema enum. */
function renderOptionDescription(opt: CommandOptionMeta): string {
  if (opt.allowedValues && opt.allowedValues.length > 0) {
    return `${opt.description}: ${opt.allowedValues.join(' | ')}`;
  }
  return opt.description;
}

/** Commander value collector for repeatable string options — accumulates each
 * occurrence into an array, verbatim caller order, no normalization. Shared by
 * every `collect: true` metadata option (claim --paths, prepush --ack, waiver
 * create --gate). */
function collectOption(
  value: string,
  previous: readonly string[] | undefined
): string[] {
  return previous === undefined ? [value] : [...previous, value];
}

/** Apply one metadata option to a Commander command, choosing
 * required/optional, supplying a collector for repeatable (`collect`) options,
 * and passing a default value when declared. */
function applyOptionMeta(cmd: Command, opt: CommandOptionMeta): void {
  const description = renderOptionDescription(opt);
  if (opt.hidden === true) {
    // Registered-but-hidden option (e.g. the removed-v10 `--type` alias): keep
    // it parseable so the handler can emit a migration error, but exclude it
    // from `--help` via Commander's Option.hideHelp(). The flag + description
    // still come from metadata (no inline literal), so the L5 help-string lock
    // is unaffected.
    const hiddenOption = new Option(opt.flag, description).hideHelp();
    cmd.addOption(hiddenOption);
    return;
  }
  if (opt.collect === true) {
    // Repeatable option: Commander needs the collector fn. Whether to seed an
    // initial [] is preserved from the prior hand-written behavior and encoded
    // in metadata as defaultValue: [] (e.g. prepush --ack, waiver --gate seed
    // so the value is always an array; claim --paths omits the seed so an
    // unsupplied option stays `undefined`).
    const seed =
      opt.defaultValue !== undefined ? (opt.defaultValue as string[]) : undefined;
    if (opt.required === true) {
      cmd.requiredOption(opt.flag, description, collectOption, seed ?? ([] as string[]));
    } else if (seed !== undefined) {
      cmd.option(opt.flag, description, collectOption, seed);
    } else {
      cmd.option(opt.flag, description, collectOption);
    }
    return;
  }
  if (opt.required === true) {
    cmd.requiredOption(opt.flag, description);
    return;
  }
  if (opt.defaultValue !== undefined) {
    cmd.option(opt.flag, description, opt.defaultValue as string | boolean | string[]);
    return;
  }
  cmd.option(opt.flag, description);
}

/** Construct the `.command()` name string with the metadata's positional
 * argument suffix (`<name>` required, `[name]` optional), e.g. "create <id>". */
function leafCommandName(leaf: LeafCommandMeta): string {
  if (!leaf.argument) return leaf.name;
  const { name, required } = leaf.argument;
  return required ? `${leaf.name} <${name}>` : `${leaf.name} [${name}]`;
}

/** Register a leaf subcommand from metadata: name(+arg), description, options.
 * Returns the configured Command so the caller can attach `.action()`. */
function defineLeaf(group: Command, leaf: LeafCommandMeta): Command {
  const cmd = group.command(leafCommandName(leaf)).description(leaf.description);
  for (const opt of leaf.options) {
    applyOptionMeta(cmd, opt);
  }
  return cmd;
}

/** Apply the group-level description from metadata to a Commander group. */
function applyGroupMeta(group: Command, meta: GroupCommandMeta): void {
  group.description(meta.description);
}

/** Register a FLAT top-level command from LeafCommandMeta (init/doctor/status/
 * claim/prepush): name(+arg), description, options — all metadata-driven.
 * Returns the configured Command so the caller can attach `.action()`. */
function defineFlat(program: Command, leaf: LeafCommandMeta): Command {
  const cmd = program.command(leafCommandName(leaf)).description(leaf.description);
  for (const opt of leaf.options) {
    applyOptionMeta(cmd, opt);
  }
  return cmd;
}

/** Look up a leaf's metadata within a group by subcommand name. Throws if the
 * metadata is missing — a wiring bug should fail loudly at registration, not
 * silently register a command with no help. */
function leafMeta(meta: GroupCommandMeta, name: string): LeafCommandMeta {
  const found = meta.subcommands.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `register.ts: no metadata for "${meta.name} ${name}" in COMMAND_SURFACE_METADATA`
    );
  }
  return found;
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
  defineFlat(program, INIT_COMMAND_META)
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
  defineFlat(program, DOCTOR_COMMAND_META)
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
  const scopeCmd = program.command('scope');
  applyGroupMeta(scopeCmd, SCOPE_COMMAND_META);

  defineLeaf(scopeCmd, leafMeta(SCOPE_COMMAND_META, 'show'))
    .action((p: string, opts: { data?: boolean; json?: boolean }) => {
      const code = runScopeCommand({
        path: p,
        mode: 'show',
        showData: opts.data === true,
        json: opts.json === true,
      });
      exit(code);
    });

  defineLeaf(scopeCmd, leafMeta(SCOPE_COMMAND_META, 'check'))
    .action((p: string, opts: { data?: boolean }) => {
      const code = runScopeCommand({
        path: p,
        mode: 'check',
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(scopeCmd, leafMeta(SCOPE_COMMAND_META, 'contention'))
    .action((p: string, opts: { json?: boolean }) => {
      const code = runScopeContentionCommand({
        path: p,
        json: opts.json === true,
      });
      exit(code);
    });

  // -------------------------------------------------------------------
  // caws status — read-only dashboard (replaces legacy status)
  // -------------------------------------------------------------------
  defineFlat(program, STATUS_COMMAND_META)
    .action((opts: { data?: boolean }) => {
      const code = runStatusCommand({
        showData: opts.data === true,
      });
      exit(code);
    });

  // -------------------------------------------------------------------
  // caws claim [--takeover] [--paths <path>...]
  // -------------------------------------------------------------------
  defineFlat(program, CLAIM_COMMAND_META)
    .action(
      (opts: {
        takeover?: boolean;
        paths?: readonly string[];
        data?: boolean;
      }) => {
        const code = runClaimCommand({
          takeover: opts.takeover === true,
          showData: opts.data === true,
          ...(opts.paths !== undefined ? { paths: opts.paths } : {}),
        });
        exit(code);
      }
    );

  // -------------------------------------------------------------------
  // caws gates run --spec <id> [--context <ctx>]
  // (replaces the legacy `gates` group and `quality-gates` alias)
  // -------------------------------------------------------------------
  const gatesCmd = program.command('gates');
  applyGroupMeta(gatesCmd, GATES_COMMAND_META);

  defineLeaf(gatesCmd, leafMeta(GATES_COMMAND_META, 'run'))
    .action(
      (opts: { spec: string; context: string; data?: boolean }) => {
        const code = runGatesRunCommand(
          { specId: opts.spec },
          {
            showData: opts.data === true,
          }
        );
        exit(code);
      }
    );

  // -------------------------------------------------------------------
  // caws prepush — MULTI-AGENT-PUSH-RANGE-GUARD-001
  // -------------------------------------------------------------------
  defineFlat(program, PREPUSH_COMMAND_META)
    .action(
      (opts: {
        remote: string;
        branch: string;
        base?: string;
        spec?: string;
        ack: string[];
        data?: boolean;
      }) => {
        const code = runPrepushCommand({
          remote: opts.remote,
          branch: opts.branch,
          ...(opts.base !== undefined ? { base: opts.base } : {}),
          ...(opts.spec !== undefined ? { specId: opts.spec } : {}),
          ack: opts.ack,
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  // -------------------------------------------------------------------
  // caws evidence record
  // -------------------------------------------------------------------
  const evidenceCmd = program.command('evidence');
  applyGroupMeta(evidenceCmd, EVIDENCE_COMMAND_META);

  defineLeaf(evidenceCmd, leafMeta(EVIDENCE_COMMAND_META, 'record'))
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
  const eventsCmd = program.command('events');
  applyGroupMeta(eventsCmd, EVENTS_COMMAND_META);

  defineLeaf(eventsCmd, leafMeta(EVENTS_COMMAND_META, 'migrate'))
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

  defineLeaf(eventsCmd, leafMeta(EVENTS_COMMAND_META, 'rotate'))
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

  defineLeaf(eventsCmd, leafMeta(EVENTS_COMMAND_META, 'verify-archive'))
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
  const waiverCmd = program.command('waiver');
  applyGroupMeta(waiverCmd, WAIVER_COMMAND_META);

  defineLeaf(waiverCmd, leafMeta(WAIVER_COMMAND_META, 'create'))
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

  defineLeaf(waiverCmd, leafMeta(WAIVER_COMMAND_META, 'list'))
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

  defineLeaf(waiverCmd, leafMeta(WAIVER_COMMAND_META, 'show'))
    .action((id: string, opts: { data?: boolean }) => {
      const code = runWaiverShowCommand({
        id,
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(waiverCmd, leafMeta(WAIVER_COMMAND_META, 'revoke'))
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
  const specsCmd = program.command('specs');
  applyGroupMeta(specsCmd, SPECS_COMMAND_META);

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'create'))
    .action(
      (
        id: string,
        opts: {
          title?: string;
          mode?: string;
          riskTier?: string;
          scopeIn?: string[];
          contract?: string[];
          type?: string;
          data?: boolean;
        }
      ) => {
        const code = runSpecsCreateCommand({
          id,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
          ...(opts.riskTier !== undefined ? { riskTier: opts.riskTier } : {}),
          ...(opts.scopeIn !== undefined ? { scopeIn: opts.scopeIn } : {}),
          // FIX-SPECS-CONTRACT-ORIENTATION-001: forward the repeatable
          // --contract values to the handler. Without this the flag is parsed
          // by Commander (so --help shows it) but dropped at this hand-mapping
          // layer, so a live `--contract` never reached the writer.
          ...(opts.contract !== undefined ? { contract: opts.contract } : {}),
          ...(opts.type !== undefined ? { legacyType: opts.type } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'list'))
    .action((opts: { archived?: boolean; data?: boolean }) => {
      const code = runSpecsListCommand({
        includeArchived: opts.archived === true,
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'show'))
    .action((id: string, opts: { data?: boolean; archived?: boolean }) => {
      const code = runSpecsShowCommand({
        id,
        showData: opts.data === true,
        ...(opts.archived === true ? { archived: true } : {}),
      });
      exit(code);
    });

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'recover'))
    .action((id: string, opts: { data?: boolean; out?: string }) => {
      const code = runSpecsRecoverCommand({
        id,
        showData: opts.data === true,
        ...(typeof opts.out === 'string' && opts.out.length > 0 ? { outPath: opts.out } : {}),
      });
      exit(code);
    });

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'retire-draft'))
    .action((id: string, opts: { reason?: string; data?: boolean }) => {
      const code = runSpecsRetireDraftCommand({
        id,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'activate'))
    .action((id: string, opts: { data?: boolean }) => {
      const code = runSpecsActivateCommand({
        id,
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'amend-scope'))
    .action(
      (
        id: string,
        opts: {
          add?: string[];
          remove?: string[];
          addOut?: string[];
          removeOut?: string[];
          addSupport?: string[];
          removeSupport?: string[];
          data?: boolean;
        }
      ) => {
        const code = runSpecsAmendScopeCommand({
          id,
          ...(opts.add !== undefined ? { addIn: opts.add } : {}),
          ...(opts.remove !== undefined ? { removeIn: opts.remove } : {}),
          ...(opts.addOut !== undefined ? { addOut: opts.addOut } : {}),
          ...(opts.removeOut !== undefined ? { removeOut: opts.removeOut } : {}),
          ...(opts.addSupport !== undefined ? { addSupport: opts.addSupport } : {}),
          ...(opts.removeSupport !== undefined ? { removeSupport: opts.removeSupport } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'close'))
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

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'archive'))
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

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'prune-archive'))
    .action((opts: { apply?: boolean; data?: boolean }) => {
      const code = runSpecsPruneArchiveCommand({
        ...(opts.apply === true ? { apply: true } : {}),
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'migrate'))
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

  defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'validate'))
    .action((file: string, opts: { data?: boolean }) => {
      const code = runSpecsValidateCommand({
        file,
        showData: opts.data === true,
      });
      exit(code);
    });

  // -------------------------------------------------------------------
  // caws worktree (CLI-WORKTREE-001)
  //
  // Restores v11 worktree lifecycle commands. All mutation paths go
  // through worktrees-writer (which uses the lifecycle-transaction
  // substrate from Slice 4 + applyRegistryPatch + specs-writer.closeSpec
  // for auto-close on merge).
  // -------------------------------------------------------------------
  const worktreeCmd = program.command('worktree');
  applyGroupMeta(worktreeCmd, WORKTREE_COMMAND_META);

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'create'))
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

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'list'))
    .action((opts: { data?: boolean }) => {
      const code = runWorktreeListCommand({ showData: opts.data === true });
      exit(code);
    });

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'bind'))
    .action(
      (
        name: string,
        opts: { spec: string; steal?: boolean; reason?: string; data?: boolean }
      ) => {
        const code = runWorktreeBindCommand({
          name,
          specId: opts.spec,
          ...(opts.steal === true ? { steal: true } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          showData: opts.data === true,
        });
        exit(code);
      }
    );

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'destroy'))
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

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'merge'))
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

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'migrate-registry'))
    .action((opts: { dryRun?: boolean; data?: boolean }) => {
      const code = runWorktreeMigrateRegistryCommand({
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'repair-sparse'))
    .action((name: string, opts: { data?: boolean }) => {
      const code = runWorktreeRepairSparseCommand({
        name,
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(worktreeCmd, leafMeta(WORKTREE_COMMAND_META, 'repair'))
    .action((opts: { dryRun?: boolean; data?: boolean }) => {
      const code = runWorktreeRepairCommand({
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        showData: opts.data === true,
      });
      exit(code);
    });

  // ─── caws agents (MULTI-AGENT-ACTIVITY-REGISTRY-001) ────────────────────
  const agentsCmd = program.command('agents');
  applyGroupMeta(agentsCmd, AGENTS_COMMAND_META);

  defineLeaf(agentsCmd, leafMeta(AGENTS_COMMAND_META, 'register'))
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

  defineLeaf(agentsCmd, leafMeta(AGENTS_COMMAND_META, 'heartbeat'))
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

  defineLeaf(agentsCmd, leafMeta(AGENTS_COMMAND_META, 'stop'))
    .action((opts: { sessionId?: string; platform?: string; json?: boolean; data?: boolean }) => {
      const code = runAgentsStopCommand({
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
        json: opts.json === true,
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(agentsCmd, leafMeta(AGENTS_COMMAND_META, 'list'))
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

  defineLeaf(agentsCmd, leafMeta(AGENTS_COMMAND_META, 'show'))
    .action((id: string, opts: { json?: boolean; data?: boolean }) => {
      const code = runAgentsShowCommand({
        id,
        json: opts.json === true,
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(agentsCmd, leafMeta(AGENTS_COMMAND_META, 'prune'))
    .action(
      (opts: {
        dead?: boolean;
        status?: string;
        olderThanMs?: string;
        staleTtlMs?: string;
        apply?: boolean;
        json?: boolean;
        data?: boolean;
      }) => {
        // PID-liveness mode: --dead is mutually exclusive with --status.
        if (opts.dead === true) {
          if (opts.status !== undefined || opts.olderThanMs !== undefined) {
            process.stderr.write(
              'caws agents prune: --dead cannot be combined with --status / --older-than-ms.\n'
            );
            exit(1);
            return;
          }
          const code = runAgentsPruneCommand({
            dead: true,
            apply: opts.apply === true,
            json: opts.json === true,
            showData: opts.data === true,
          });
          exit(code);
          return;
        }

        // Retention mode: --status + --older-than-ms required.
        const status = opts.status === 'stopped' || opts.status === 'stale' ? opts.status : null;
        const olderThanMs = Number(opts.olderThanMs);
        if (status === null || !Number.isFinite(olderThanMs)) {
          process.stderr.write(
            'caws agents prune: pass --dead, or --status <stopped|stale> with a numeric --older-than-ms.\n'
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

  // -------------------------------------------------------------------
  // caws message send / poll
  //
  // Inter-agent message channel (AGENT-MESSAGE-CHANNEL-001): directed
  // messages between running sessions over .caws/messages.jsonl, addressed
  // by session id, liveness-checked against the agent registry. Separate
  // from the events audit chain.
  // -------------------------------------------------------------------
  const messageCmd = program.command(MESSAGE_COMMAND_META.name);
  applyGroupMeta(messageCmd, MESSAGE_COMMAND_META);

  defineLeaf(messageCmd, leafMeta(MESSAGE_COMMAND_META, 'send'))
    .action((opts: { to?: string; text?: string; allowDead?: boolean; data?: boolean }) => {
      const code = runMessageSendCommand({
        to: opts.to ?? '',
        text: opts.text ?? '',
        ...(opts.allowDead === true ? { allowDead: true } : {}),
        showData: opts.data === true,
      });
      exit(code);
    });

  defineLeaf(messageCmd, leafMeta(MESSAGE_COMMAND_META, 'poll'))
    .action((opts: { me?: string; wait?: string; peek?: boolean; json?: boolean; data?: boolean }) => {
      const waitMs = opts.wait !== undefined ? Number(opts.wait) : undefined;
      const code = runMessagePollCommand({
        ...(opts.me !== undefined ? { me: opts.me } : {}),
        ...(waitMs !== undefined && Number.isFinite(waitMs) ? { waitMs } : {}),
        ...(opts.peek === true ? { peek: true } : {}),
        json: opts.json === true,
        showData: opts.data === true,
      });
      exit(code);
    });
}
