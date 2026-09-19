/**
 * Repo-local hook policy: document shape, validator, chain resolver and writer.
 *
 * CAWS-REPO-HOOK-POLICY-RESOLVER-01, CAWS-HOOKS-MUTATING-VERBS-01.
 *
 * A consumer repo that needs one behavior change in a shipped guard has one
 * move today: copy the whole guard into `.caws/hooks/<guard>.sh`, edit it, and
 * register a whole-file override in machine state. That fork silences the
 * staleness warning, lives outside git and review, and reaches only the
 * machine-routed surfaces. This module is the additive alternative: a committed
 * `.caws/hooks/hook-policy.json` that extends the guard plane from the repo,
 * scoped to its git root.
 *
 * WHY THE FILE LIVES UNDER `.caws/hooks/`: protected-paths.sh admits only
 * `*.md` there, so a `.json` in that directory is agent-write-blocked and
 * human/CLI-writable. The entity with the incentive to paper over a block
 * cannot author the paper. `.caws/` root would NOT do — write-allowlist.sh
 * returns an unconditional allow for `.caws/*`.
 *
 * This module owns the shape, the merge semantics and the writer. Both planes
 * adopt it: the launcher (python) mirrors the validation, and the `caws hooks`
 * verbs mutate through it. Keeping the semantics in one reviewed place is what
 * stops the two planes from drifting into two different answers for the same
 * document — and the writer sits beside the reader so every mutation can be
 * proven readable before it reaches disk.
 */

/** The document version this runtime understands. */
export const HOOK_POLICY_VERSION = 1;

/** Repo-relative location of the policy document. */
export const REPO_HOOK_POLICY_PATH = '.caws/hooks/hook-policy.json';

/**
 * Handlers a REPO-tier policy may never disable or remap.
 *
 * A handler belongs here iff removing it breaks the mechanism that makes the
 * policy reviewable or its staleness observable:
 *   - protected-paths.sh — a policy that can authorize its own amendment is not
 *     a policy. This guard is what keeps hook-policy.json itself agent-unwritable.
 *   - block-dangerous.sh — the same circularity through the Bash channel: it can
 *     DESTROY the tree it must not be able to EDIT.
 *   - agent-register.sh — carries the pack-drift advisory and the chain-freshness
 *     check, i.e. the signal that a repo's policy has gone stale.
 *
 * scope-guard.sh is deliberately ABSENT: it is exactly the guard consumer repos
 * legitimately need to extend, and fencing it off is what pushes them to fork.
 *
 * The floor binds the REPO tier only. Machine state keeps its existing
 * unrestricted power — an operator changing their own machine is the sanctioned
 * escape hatch, and it affects only that machine. A committed team file reaches
 * every clone and CI, so it answers to a stricter rule.
 */
export const REPO_POLICY_FLOOR: readonly string[] = [
  'protected-paths.sh',
  'block-dangerous.sh',
  'agent-register.sh',
];

/** Events a policy may key on — mirrors the launcher's EVENTS. */
export const POLICY_EVENTS: readonly string[] = [
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'stop',
  'pre_compact',
  'session_end',
];

/** Bare handler basename, e.g. `scope-guard.sh`. */
const HANDLER_NAME = /^[A-Za-z0-9_.-]+\.sh$/;
/** A chain entry: a basename optionally followed by arguments. */
const HANDLER_ENTRY = /^[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*$/;

export interface PolicyExtension {
  handler: string;
  /** Anchor basename to insert before; null appends at the end of the chain. */
  before: string | null;
  reason: string;
}

export interface PolicyFork {
  forked_from: { pack: string; pack_version: number; sha256: string };
  reason: string;
  approver: string;
}

/**
 * One subtraction from the chain.
 *
 * The document admits two spellings: a bare `"handler.sh"` and the object form
 * `{handler, reason}`. Both parse; only the object form carries a
 * justification, and it is the only form `caws hooks disable` writes.
 *
 * The asymmetry that motivates it: `extensions` has always REQUIRED a reason,
 * while `disabled` — the key that REDUCES enforcement — accepted none. The
 * operation more in need of a recorded justification was the one with nowhere
 * to record it. Admitting both spellings keeps every already-valid document
 * valid while giving the governed verb a place to put the answer to "why is
 * this guard off in this repo?" that survives into every clone.
 */
export interface DisabledEntry {
  handler: string;
  /** null for the bare-string spelling, which records no justification. */
  reason: string | null;
}

/** Project disabled entries down to the handler names the resolver subtracts. */
export function disabledHandlers(entries: readonly DisabledEntry[]): string[] {
  return entries.map((entry) => entry.handler);
}

/**
 * Named `Repo…` to stay distinct from machine-adapter-policy.ts's
 * `SurfacePolicy`, which is the LEGACY `{events: {<event>: {hooks_dir,
 * handlers[]}}}` shape this design supersedes. They are different shapes with
 * opposite postures (frozen full copy vs. additive), so they must not share a
 * name.
 */
export interface RepoSurfacePolicy {
  disabled: Record<string, DisabledEntry[]>;
  extensions: Record<string, PolicyExtension[]>;
  handlers: Record<string, string>;
  libraries: Record<string, string>;
  forks: Record<string, PolicyFork>;
}

/**
 * TIER 2 — what data a running guard uses, as opposed to which guards run.
 *
 * The authority boundary here is NOT the `command-adapters` rule that no key
 * may name a decision, because that rule does not transplant: adding `native/`
 * to an allow table IS a verdict change for `native/`. The boundary is drawn
 * on DIRECTION and FLOOR instead — every key is `additional_*` or a clamped
 * threshold, so no repo-declared entry can remove, replace or reorder a
 * shipped one. That is what makes fail-closed cheap: discarding the document
 * is always the STRICTER direction, so a malformed config degrades toward
 * refusal, never toward permission.
 */
export interface GuardPrefixEntry {
  prefix: string;
  /** Rendered by doctor and `hooks list`; "the guard is broken" becomes reviewable. */
  reason: string;
}

export interface GuardConfig {
  additional_allow_prefixes: GuardPrefixEntry[];
  thresholds: Record<string, number>;
}

/**
 * Which guards admit configuration, and what each one admits.
 *
 * A closed set on purpose. An unknown guard name would otherwise be a typo
 * that silently configures nothing — the "reports success while doing
 * nothing" class this repo treats as the most dangerous, and the one most
 * likely to send an operator looking for a bypass when the setting they
 * "already applied" has no effect.
 *
 * Deliberately ABSENT, because these tables ARE the floor:
 * protected-paths.sh artifact classes, write-allowlist.sh's
 * `.caws/worktrees/*` payload exclusion, scope-guard.sh foreign-repo
 * containment, the guard-strikes 1/2/3 ramp and CAWS_TRAP_KILL.
 */
export interface GuardConfigSchema {
  /** Whether this guard reads `additional_allow_prefixes`. */
  prefixes: boolean;
  /** Admitted threshold names with their clamps. */
  thresholds: Record<string, { min: number; max: number }>;
}

export const GUARD_CONFIG_SURFACE: Readonly<Record<string, GuardConfigSchema>> = {
  // Highest leverage first: one arm here fixes BOTH write guards, and they
  // cannot desynchronize because they share the admission function.
  'write-allowlist.sh': { prefixes: true, thresholds: {} },
  'scope-guard.sh': { prefixes: true, thresholds: {} },
  'god-object-check.sh': {
    prefixes: false,
    thresholds: { loc: { min: 100, max: 100000 }, delta: { min: 10, max: 100000 } },
  },
  'loc-delta-check.sh': { prefixes: false, thresholds: { delta: { min: 10, max: 100000 } } },
};

/**
 * R2: keys that name a VERDICT rather than data, refused at any depth.
 *
 * Extends the `classify_command.py` denylist. A document may describe WHAT a
 * guard looks at; it may never describe what the guard decides.
 */
export const GUARD_DECISION_KEYS: readonly string[] = [
  'decision',
  'allow',
  'deny',
  'ask',
  'policy',
  'outcome',
  'severity',
  'override',
  'enforcement',
  'exit_code',
  'verdict',
];

/**
 * R3: prefixes that may never be widened by configuration, because they are
 * the governance plane that adjudicates the configuration.
 */
export const GUARD_RESERVED_PREFIXES: readonly string[] = [
  '.caws',
  '.git',
  '.github/workflows',
  '.claude',
  '.codex',
  '.qwen',
  '.zcode',
  '.opencode',
  '.kimi',
];

/** Caps. A config is a few lines of intent, not a database. */
const MAX_PREFIX_ENTRIES = 64;
const MAX_PREFIX_LENGTH = 200;

export interface RepoHookPolicy {
  version: number;
  surfaces: Record<string, RepoSurfacePolicy>;
  guards: Record<string, GuardConfig>;
}

export type PolicyResult = { ok: true; policy: RepoHookPolicy } | { ok: false; error: string };

/** The identity policy: what an absent file resolves to. */
export function emptyRepoHookPolicy(): RepoHookPolicy {
  return { version: HOOK_POLICY_VERSION, surfaces: {}, guards: {} };
}

function emptyRepoSurfacePolicy(): RepoSurfacePolicy {
  return { disabled: {}, extensions: {}, handlers: {}, libraries: {}, forks: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * Parse and validate a policy document.
 *
 * Fail-closed and ALL-OR-NOTHING: a document with one bad entry applies zero
 * entries, not the valid subset. Partial application is the dangerous shape —
 * it leaves a repo believing a policy is in force when half of it was dropped,
 * and nothing reports the loss. Because every repo-tier key is additive over a
 * floor, discarding the whole document is always the STRICTER direction, so
 * fail-closed costs nothing in enforcement.
 *
 * `null` input (no file on disk) is the identity policy, never an error.
 */
export function parseRepoHookPolicy(text: string | null): PolicyResult {
  if (text === null) return { ok: true, policy: emptyRepoHookPolicy() };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${REPO_HOOK_POLICY_PATH} is not valid JSON: ${String(error)}` };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, error: `${REPO_HOOK_POLICY_PATH} must be a JSON object` };
  }

  // All three top-level keys are admitted in v1 even though `guards` is not
  // consumed yet. Runtime validators assert exact key sets, so introducing
  // `guards` in a later release would hard-block every repo pinned to this
  // runtime. Admitting it now is the one decision that cannot be deferred.
  if (!exactKeys(raw, ['version', 'surfaces', 'guards'])) {
    return {
      ok: false,
      error: `${REPO_HOOK_POLICY_PATH} admits only version, surfaces and guards`,
    };
  }

  if (raw.version !== HOOK_POLICY_VERSION) {
    return {
      ok: false,
      error: `${REPO_HOOK_POLICY_PATH} version must be ${HOOK_POLICY_VERSION}`,
    };
  }

  const guardsResult = parseGuards(raw.guards);
  if (!guardsResult.ok) return guardsResult;
  const guards = guardsResult.guards;

  const surfacesRaw = raw.surfaces === undefined ? {} : raw.surfaces;
  if (!isPlainObject(surfacesRaw)) {
    return { ok: false, error: `${REPO_HOOK_POLICY_PATH} surfaces must be an object` };
  }

  const surfaces: Record<string, RepoSurfacePolicy> = {};
  for (const [surfaceName, surfaceRaw] of Object.entries(surfacesRaw)) {
    const parsed = parseSurface(surfaceName, surfaceRaw);
    if (!parsed.ok) return parsed;
    surfaces[surfaceName] = parsed.surface;
  }

  return { ok: true, policy: { version: HOOK_POLICY_VERSION, surfaces, guards } };
}

type GuardsResult =
  | { ok: true; guards: Record<string, GuardConfig> }
  | { ok: false; error: string };

/**
 * Validate the whole `guards` block, all-or-nothing.
 *
 * ONE bad entry rejects the WHOLE document rather than the offending entry.
 * Applying the admissible subset would leave the repo running a configuration
 * nobody authored and nobody can predict from reading the file — and because
 * every key is append-only, discarding everything is the stricter direction,
 * so the failure mode of being strict here is a guard that enforces MORE.
 */
function parseGuards(raw: unknown): GuardsResult {
  if (raw === undefined) return { ok: true, guards: {} };
  if (!isPlainObject(raw)) {
    return { ok: false, error: `${REPO_HOOK_POLICY_PATH} guards must be an object` };
  }

  // R2 runs over the RAW subtree before any shape checking, so a decision key
  // is refused even where it sits inside an otherwise-unknown structure.
  const decision = findDecisionKey(raw, 'guards');
  if (decision !== null) {
    return {
      ok: false,
      error:
        `${decision} names a decision, and guards may carry DATA only. A config may describe ` +
        `what a guard looks at; it may never describe what the guard decides. Refused keys at ` +
        `any depth: ${GUARD_DECISION_KEYS.join(', ')}.`,
    };
  }

  const guards: Record<string, GuardConfig> = {};
  for (const [guardName, guardRaw] of Object.entries(raw)) {
    const where = `guards.${guardName}`;
    const schema = GUARD_CONFIG_SURFACE[guardName];
    if (schema === undefined) {
      return {
        ok: false,
        error:
          `${where} is not a configurable guard. Configurable today: ` +
          `${Object.keys(GUARD_CONFIG_SURFACE).sort().join(', ')}. An unrecognized name is ` +
          `refused rather than ignored, because a silently inert setting is indistinguishable ` +
          `from one that worked.`,
      };
    }
    if (!isPlainObject(guardRaw)) {
      return { ok: false, error: `${where} must be an object` };
    }

    const admitted: string[] = [];
    if (schema.prefixes) admitted.push('additional_allow_prefixes');
    if (Object.keys(schema.thresholds).length > 0) admitted.push('thresholds');
    if (!exactKeys(guardRaw, admitted)) {
      return {
        ok: false,
        error:
          `${where} admits only ${admitted.join(', ') || '(nothing — this guard takes no config)'}. ` +
          `Only additional_* shapes exist by design: no key removes, replaces or reorders a ` +
          `shipped entry, so a shipped protection can never be configured away.`,
      };
    }

    const config: GuardConfig = { additional_allow_prefixes: [], thresholds: {} };

    const prefixesRaw = guardRaw.additional_allow_prefixes;
    if (prefixesRaw !== undefined) {
      if (!Array.isArray(prefixesRaw)) {
        return { ok: false, error: `${where}.additional_allow_prefixes must be an array` };
      }
      if (prefixesRaw.length > MAX_PREFIX_ENTRIES) {
        return {
          ok: false,
          error: `${where}.additional_allow_prefixes admits at most ${MAX_PREFIX_ENTRIES} entries`,
        };
      }
      const seen = new Set<string>();
      for (const [index, entryRaw] of prefixesRaw.entries()) {
        const at = `${where}.additional_allow_prefixes[${index}]`;
        if (!isPlainObject(entryRaw) || !exactKeys(entryRaw, ['prefix', 'reason'])) {
          return { ok: false, error: `${at} must be an object with exactly prefix and reason` };
        }
        const bad = invalidPrefix(entryRaw.prefix);
        if (bad !== null) return { ok: false, error: `${at}: ${bad}` };
        const prefix = entryRaw.prefix as string;
        if (seen.has(prefix)) {
          return { ok: false, error: `${at}: duplicate prefix ${prefix}` };
        }
        seen.add(prefix);
        const reasonBad = invalidReason(entryRaw.reason, 'reason');
        if (reasonBad !== null) return { ok: false, error: `${at}: ${reasonBad}` };
        config.additional_allow_prefixes.push({
          prefix,
          reason: entryRaw.reason as string,
        });
      }
    }

    const thresholdsRaw = guardRaw.thresholds;
    if (thresholdsRaw !== undefined) {
      if (!isPlainObject(thresholdsRaw)) {
        return { ok: false, error: `${where}.thresholds must be an object` };
      }
      for (const [name, value] of Object.entries(thresholdsRaw)) {
        const clamp = schema.thresholds[name];
        if (clamp === undefined) {
          return {
            ok: false,
            error:
              `${where}.thresholds.${name} is not a threshold this guard reads. ` +
              `Admitted: ${Object.keys(schema.thresholds).sort().join(', ')}.`,
          };
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          return { ok: false, error: `${where}.thresholds.${name} must be an integer` };
        }
        if (value < clamp.min || value > clamp.max) {
          return {
            ok: false,
            error:
              `${where}.thresholds.${name} must be between ${clamp.min} and ${clamp.max}; ` +
              `got ${value}. The clamp is the schema's, not the guard's — a value outside it ` +
              `disables the check in all but name.`,
          };
        }
        config.thresholds[name] = value;
      }
    }

    guards[guardName] = config;
  }

  return { ok: true, guards };
}

/** The first decision-naming key path in the subtree, or null. Recursive by R2. */
function findDecisionKey(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findDecisionKey(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (GUARD_DECISION_KEYS.includes(key.toLowerCase())) return `${path}.${key}`;
    const found = findDecisionKey(child, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

/**
 * R3: contained, bounded, repo-relative, trailing-slash prefix.
 *
 * The ABSOLUTE ban is load-bearing rather than tidiness: scope-guard.sh
 * honors absolute allow-prefixes BEFORE its foreign-repo containment block,
 * so a configured absolute prefix would punch a hole straight through
 * cross-repo containment.
 */
function invalidPrefix(prefix: unknown): string | null {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return 'prefix must be a non-empty string';
  }
  if (prefix.length > MAX_PREFIX_LENGTH) {
    return `prefix must be at most ${MAX_PREFIX_LENGTH} characters`;
  }
  if (prefix.startsWith('/') || /^[A-Za-z]:[\\/]/.test(prefix)) {
    return (
      'prefix must be repo-relative, not absolute. scope-guard.sh honors absolute ' +
      'allow-prefixes before foreign-repo containment, so an absolute entry would be a ' +
      'cross-repo containment hole.'
    );
  }
  if (prefix.split('/').includes('..')) return 'prefix may not traverse with ..';
  if (/[*?[\]]/.test(prefix)) return 'prefix may not contain glob metacharacters';
  // The env transport is whitespace-delimited and line-oriented; a prefix
  // carrying either would silently split into two entries downstream.
  if (/\s/.test(prefix)) return 'prefix may not contain whitespace';
  if (prefix.includes('=')) return 'prefix may not contain =';
  if (!prefix.endsWith('/')) return `prefix must end with / (a directory prefix): ${prefix}/`;
  const head = prefix.replace(/\/+$/, '');
  for (const reserved of GUARD_RESERVED_PREFIXES) {
    if (head === reserved || head.startsWith(`${reserved}/`)) {
      return (
        `${reserved} is reserved and may not be widened by configuration — it is part of the ` +
        'governance plane that adjudicates this very document'
      );
    }
  }
  return null;
}

type SurfaceResult = { ok: true; surface: RepoSurfacePolicy } | { ok: false; error: string };

function parseSurface(surfaceName: string, raw: unknown): SurfaceResult {
  const where = `surfaces.${surfaceName}`;
  if (!isPlainObject(raw)) return { ok: false, error: `${where} must be an object` };
  if (!exactKeys(raw, ['disabled', 'extensions', 'handlers', 'libraries', 'forks'])) {
    return {
      ok: false,
      error: `${where} admits only disabled, extensions, handlers, libraries and forks`,
    };
  }

  const surface = emptyRepoSurfacePolicy();

  // ── disabled ────────────────────────────────────────────────────────────
  if (raw.disabled !== undefined) {
    if (!isPlainObject(raw.disabled)) {
      return { ok: false, error: `${where}.disabled must be an object` };
    }
    for (const [event, values] of Object.entries(raw.disabled)) {
      if (!POLICY_EVENTS.includes(event)) {
        return { ok: false, error: `${where}.disabled names an unknown event: ${event}` };
      }
      if (!Array.isArray(values)) {
        return { ok: false, error: `${where}.disabled.${event} must be a list of handler names` };
      }
      const parsedEntries: DisabledEntry[] = [];
      for (const value of values) {
        if (typeof value === 'string') {
          if (!HANDLER_NAME.test(value)) {
            return {
              ok: false,
              error: `${where}.disabled.${event} must be a list of handler names`,
            };
          }
          parsedEntries.push({ handler: value, reason: null });
          continue;
        }
        if (!isPlainObject(value) || !exactKeys(value, ['handler', 'reason'])) {
          return {
            ok: false,
            error: `${where}.disabled.${event} entries are a handler name or {handler, reason}`,
          };
        }
        if (typeof value.handler !== 'string' || !HANDLER_NAME.test(value.handler)) {
          return { ok: false, error: `${where}.disabled.${event} must be a list of handler names` };
        }
        if (typeof value.reason !== 'string' || value.reason.trim().length < 12) {
          return {
            ok: false,
            error: `${where}.disabled.${event} requires a reason of at least 12 characters`,
          };
        }
        parsedEntries.push({ handler: value.handler, reason: value.reason });
      }
      for (const entry of parsedEntries) {
        if (REPO_POLICY_FLOOR.includes(entry.handler)) {
          return {
            ok: false,
            error: floorMessage(`${where}.disabled.${event}`, entry.handler, 'disable'),
          };
        }
      }
      surface.disabled[event] = parsedEntries;
    }
  }

  // ── extensions ──────────────────────────────────────────────────────────
  if (raw.extensions !== undefined) {
    if (!isPlainObject(raw.extensions)) {
      return { ok: false, error: `${where}.extensions must be an object` };
    }
    for (const [event, entries] of Object.entries(raw.extensions)) {
      if (!POLICY_EVENTS.includes(event)) {
        return { ok: false, error: `${where}.extensions names an unknown event: ${event}` };
      }
      if (!Array.isArray(entries)) {
        return { ok: false, error: `${where}.extensions.${event} must be a list` };
      }
      const parsedEntries: PolicyExtension[] = [];
      for (const entry of entries) {
        if (!isPlainObject(entry) || !exactKeys(entry, ['handler', 'before', 'reason'])) {
          return {
            ok: false,
            error: `${where}.extensions.${event} entries admit only handler, before and reason`,
          };
        }
        if (typeof entry.handler !== 'string' || !HANDLER_ENTRY.test(entry.handler)) {
          return { ok: false, error: `${where}.extensions.${event} has a malformed handler` };
        }
        const before = entry.before === undefined ? null : entry.before;
        if (before !== null && (typeof before !== 'string' || !HANDLER_NAME.test(before))) {
          return { ok: false, error: `${where}.extensions.${event} has a malformed before anchor` };
        }
        // A reason is mandatory so "the guard plane was changed" is a reviewable
        // artifact rather than an undocumented diff. Doctor renders it.
        if (typeof entry.reason !== 'string' || entry.reason.trim().length < 12) {
          return {
            ok: false,
            error: `${where}.extensions.${event} requires a reason of at least 12 characters`,
          };
        }
        parsedEntries.push({ handler: entry.handler, before, reason: entry.reason });
      }
      surface.extensions[event] = parsedEntries;
    }
  }

  // ── handlers (whole-file override) ──────────────────────────────────────
  if (raw.handlers !== undefined) {
    if (!isPlainObject(raw.handlers)) {
      return { ok: false, error: `${where}.handlers must be an object` };
    }
    for (const [name, target] of Object.entries(raw.handlers)) {
      if (!HANDLER_NAME.test(name)) {
        return { ok: false, error: `${where}.handlers has a malformed handler name: ${name}` };
      }
      // Replacing a floor handler with a stub is observationally equivalent to
      // disabling it, so the floor gates BOTH keys. Gating only `disabled`
      // would leave the bypass one rename away.
      if (REPO_POLICY_FLOOR.includes(name)) {
        return { ok: false, error: floorMessage(`${where}.handlers`, name, 'replace') };
      }
      const invalid = invalidTarget(target);
      if (invalid) return { ok: false, error: `${where}.handlers.${name}: ${invalid}` };
      surface.handlers[name] = target as string;
    }
  }

  // ── libraries (whole-file lib override) ─────────────────────────────────
  if (raw.libraries !== undefined) {
    if (!isPlainObject(raw.libraries)) {
      return { ok: false, error: `${where}.libraries must be an object` };
    }
    for (const [name, target] of Object.entries(raw.libraries)) {
      if (!HANDLER_NAME.test(name)) {
        return { ok: false, error: `${where}.libraries has a malformed library name: ${name}` };
      }
      // agent-surface.sh and runtime-paths.sh ARE the resolution mechanism that
      // finds an override, so overriding them is a bootstrap cycle. The machine
      // tier already denylists them; the repo tier inherits that denial.
      if (name === 'agent-surface.sh' || name === 'runtime-paths.sh') {
        return {
          ok: false,
          error: `${where}.libraries may not override ${name} — it is the mechanism that resolves overrides`,
        };
      }
      const invalid = invalidTarget(target);
      if (invalid) return { ok: false, error: `${where}.libraries.${name}: ${invalid}` };
      surface.libraries[name] = target as string;
    }
  }

  // ── forks (provenance only; inert at runtime) ───────────────────────────
  if (raw.forks !== undefined) {
    if (!isPlainObject(raw.forks)) {
      return { ok: false, error: `${where}.forks must be an object` };
    }
    for (const [name, fork] of Object.entries(raw.forks)) {
      if (!HANDLER_NAME.test(name)) {
        return { ok: false, error: `${where}.forks has a malformed handler name: ${name}` };
      }
      if (!isPlainObject(fork) || !exactKeys(fork, ['forked_from', 'reason', 'approver'])) {
        return {
          ok: false,
          error: `${where}.forks.${name} admits only forked_from, reason and approver`,
        };
      }
      const from = fork.forked_from;
      if (
        !isPlainObject(from) ||
        !exactKeys(from, ['pack', 'pack_version', 'sha256']) ||
        typeof from.pack !== 'string' ||
        typeof from.pack_version !== 'number' ||
        !Number.isInteger(from.pack_version) ||
        typeof from.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(from.sha256)
      ) {
        return {
          ok: false,
          error: `${where}.forks.${name}.forked_from requires pack, integer pack_version and a 64-hex sha256`,
        };
      }
      if (typeof fork.reason !== 'string' || fork.reason.trim().length < 12) {
        return {
          ok: false,
          error: `${where}.forks.${name} requires a reason of at least 12 characters`,
        };
      }
      if (typeof fork.approver !== 'string' || fork.approver.trim().length === 0) {
        return { ok: false, error: `${where}.forks.${name} requires an approver` };
      }
      surface.forks[name] = {
        forked_from: {
          pack: from.pack,
          pack_version: from.pack_version,
          sha256: from.sha256,
        },
        reason: fork.reason,
        approver: fork.approver,
      };
    }
  }

  return { ok: true, surface };
}

function floorMessage(where: string, name: string, verb: string): string {
  return (
    `${where} may not ${verb} ${name}: it is on the repo-policy floor. ` +
    `The floor is the set of handlers that keep this policy reviewable and its staleness ` +
    `observable — a policy able to authorize its own amendment is not a policy. ` +
    `A machine-tier override remains available to an operator for their own machine.`
  );
}

/** Repo-relative, contained, non-glob target path. Returns a reason, or null if valid. */
function invalidTarget(target: unknown): string | null {
  if (typeof target !== 'string' || target.length === 0) return 'target must be a non-empty string';
  if (target.startsWith('/')) return 'target must be repo-relative, not absolute';
  if (target.split('/').includes('..')) return 'target may not traverse with ..';
  if (/[*?[\]]/.test(target)) return 'target may not contain glob metacharacters';
  return null;
}

/**
 * The effective surface policy: the named surface merged over `default`.
 *
 * Per-key merge, not a whole-object replacement: `default` carries what every
 * surface shares, and a named surface adds to it. This is what removes the
 * duplication a consumer hand-rolling this pattern ends up with — two
 * byte-identical-except-one-line copies, re-synced by hand.
 */
export function effectiveRepoSurfacePolicy(
  policy: RepoHookPolicy,
  surface: string
): RepoSurfacePolicy {
  const base = policy.surfaces.default ?? emptyRepoSurfacePolicy();
  // `default` is already the base, so asking for it must not layer it over
  // itself. It resolves that way in practice: the project-wired plane has one
  // dispatcher tree, so `caws hooks compile` and `hooks list --surface default`
  // both resolve for 'default'. Concatenating the additive keys would then
  // double every entry, and `resolveChain` fails closed on a duplicate — a
  // legitimate policy refused by the governed command, which is precisely the
  // pressure that sends an agent to hand-edit the sidecar instead.
  const named =
    surface === 'default'
      ? emptyRepoSurfacePolicy()
      : (policy.surfaces[surface] ?? emptyRepoSurfacePolicy());
  const merged = emptyRepoSurfacePolicy();
  for (const event of new Set([...Object.keys(base.disabled), ...Object.keys(named.disabled)])) {
    merged.disabled[event] = [...(base.disabled[event] ?? []), ...(named.disabled[event] ?? [])];
  }
  for (const event of new Set([
    ...Object.keys(base.extensions),
    ...Object.keys(named.extensions),
  ])) {
    merged.extensions[event] = [
      ...(base.extensions[event] ?? []),
      ...(named.extensions[event] ?? []),
    ];
  }
  merged.handlers = { ...base.handlers, ...named.handlers };
  merged.libraries = { ...base.libraries, ...named.libraries };
  merged.forks = { ...base.forks, ...named.forks };
  return merged;
}

export interface MachineTier {
  disabled: Record<string, string[]>;
  extensions: Record<string, PolicyExtension[]>;
  handlers: Record<string, string>;
  libraries: Record<string, string>;
}

export interface ResolveInput {
  /** The stock chain for this event, in order. Entries may carry arguments. */
  stock: string[];
  event: string;
  repo: RepoSurfacePolicy;
  machine?: MachineTier;
}

export type ResolveResult =
  | {
      ok: true;
      handlers: string[];
      handlerOverrides: Record<string, string>;
      libraries: Record<string, string>;
    }
  | { ok: false; error: string };

/**
 * A chain entry may carry arguments (`agent-register.sh --quiet`); every
 * comparison is on the basename. Matching the whole entry would make an anchor
 * silently unresolvable for a handler plainly present in the chain.
 */
const basename = (entry: string): string => entry.split(' ')[0] ?? entry;

/**
 * Resolve the effective chain for one event.
 *
 * Precedence, and WHY this order:
 *   1. stock chain
 *   2. -= repo.disabled     3. += repo.extensions   (anchors resolve post-2)
 *   4. -= machine.disabled  5. += machine.extensions (anchors resolve post-4)
 *   6. overrides = { ...repo.handlers, ...machine.handlers }  // machine wins
 *
 * The repo file is the TEAM's decision — committed, present in every clone and
 * in CI — so it resolves first and forms the shared baseline. Machine state is
 * THIS OPERATOR's decision and resolves second. The asymmetry is deliberate: an
 * operator can locally silence a team extension, but a committed team file
 * cannot reach into an operator's local additions.
 */
export function resolveChain(input: ResolveInput): ResolveResult {
  const machine: MachineTier = input.machine ?? {
    disabled: {},
    extensions: {},
    handlers: {},
    libraries: {},
  };

  let handlers = [...input.stock];

  const applyTier = (
    disabled: Record<string, string[]>,
    extensions: Record<string, PolicyExtension[]>,
    tier: string
  ): string | null => {
    const toDrop = disabled[input.event] ?? [];
    handlers = handlers.filter((entry) => !toDrop.includes(basename(entry)));
    for (const extension of extensions[input.event] ?? []) {
      if (handlers.some((entry) => basename(entry) === basename(extension.handler))) {
        // Fail closed rather than splice twice: a handler present in both tiers
        // would otherwise run twice, and a guard that runs twice reports two
        // verdicts for one call.
        return `${tier} extension ${basename(extension.handler)} is already in the chain for ${input.event}`;
      }
      if (extension.before === null) {
        handlers.push(extension.handler);
        continue;
      }
      const index = handlers.findIndex((entry) => basename(entry) === extension.before);
      if (index === -1) {
        return `${tier} extension anchor is absent: ${extension.before} (event ${input.event})`;
      }
      handlers.splice(index, 0, extension.handler);
    }
    return null;
  };

  const repoDisabled: Record<string, string[]> = {};
  for (const [event, entries] of Object.entries(input.repo.disabled)) {
    repoDisabled[event] = disabledHandlers(entries);
  }

  const repoError = applyTier(repoDisabled, input.repo.extensions, 'repo');
  if (repoError) return { ok: false, error: repoError };
  const machineError = applyTier(machine.disabled, machine.extensions, 'machine');
  if (machineError) return { ok: false, error: machineError };

  return {
    ok: true,
    handlers,
    handlerOverrides: { ...input.repo.handlers, ...machine.handlers },
    libraries: { ...input.repo.libraries, ...machine.libraries },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Writing a policy
//
// Everything above reads a document someone else authored. Everything below
// authors one. The two halves live in one module on purpose: the writer's only
// correctness argument is that the reader accepts what it emits, and `settle`
// below makes that argument mechanically on every mutation rather than leaving
// it to each call site to remember.
// ───────────────────────────────────────────────────────────────────────────

/** A mutation's outcome. `changed` describes what moved, for the caller to echo. */
export type PolicyMutation =
  | { ok: true; policy: RepoHookPolicy; changed: string[] }
  | { ok: false; error: string };

/** Minimum justification length, matching `extensions` and `forks`. */
const MIN_REASON = 12;

/** `default` reads first in a document because every other surface layers over it. */
function surfaceOrder(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'default') return -1;
  if (b === 'default') return 1;
  return a < b ? -1 : 1;
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as [string, T]);
}

function renderSurface(surface: RepoSurfacePolicy): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};

  const disabled: Record<string, unknown[]> = {};
  for (const [event, entries] of sortedEntries(surface.disabled)) {
    if (entries.length === 0) continue;
    disabled[event] = entries.map((entry) =>
      entry.reason === null ? entry.handler : { handler: entry.handler, reason: entry.reason }
    );
  }
  if (Object.keys(disabled).length > 0) out.disabled = disabled;

  const extensions: Record<string, unknown[]> = {};
  for (const [event, entries] of sortedEntries(surface.extensions)) {
    if (entries.length === 0) continue;
    extensions[event] = entries.map((entry) => ({
      handler: entry.handler,
      before: entry.before,
      reason: entry.reason,
    }));
  }
  if (Object.keys(extensions).length > 0) out.extensions = extensions;

  for (const key of ['handlers', 'libraries'] as const) {
    const rendered: Record<string, string> = {};
    for (const [name, target] of sortedEntries(surface[key])) rendered[name] = target;
    if (Object.keys(rendered).length > 0) out[key] = rendered;
  }

  const forks: Record<string, PolicyFork> = {};
  for (const [name, fork] of sortedEntries(surface.forks)) forks[name] = fork;
  if (Object.keys(forks).length > 0) out.forks = forks;

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Render a policy for `.caws/hooks/hook-policy.json`.
 *
 * Empty containers are OMITTED and every key is sorted. Both matter for review
 * rather than for the parser: a repo that declares one extension should get a
 * file whose entire body is that extension, and re-running a mutation should
 * produce a diff the size of the decision it encodes, not a reordering.
 */
export function serializeRepoHookPolicy(policy: RepoHookPolicy): string {
  const surfaces: Record<string, unknown> = {};
  for (const name of Object.keys(policy.surfaces).sort(surfaceOrder)) {
    const surface = policy.surfaces[name];
    const rendered = surface ? renderSurface(surface) : null;
    if (rendered) surfaces[name] = rendered;
  }
  const document: Record<string, unknown> = { version: policy.version };
  if (Object.keys(surfaces).length > 0) document.surfaces = surfaces;
  // Empty additive keys are dropped rather than written back as `[]` / `{}`.
  // The parser normalizes a guard's absent keys into empty containers, so
  // echoing them would grow the document a little on every governed write —
  // and `settle` re-parses what it is about to persist, which would then make
  // the growth permanent and silent.
  const guards: Record<string, unknown> = {};
  for (const [name, config] of sortedEntries(policy.guards)) {
    const rendered: Record<string, unknown> = {};
    if (config.additional_allow_prefixes.length > 0) {
      rendered.additional_allow_prefixes = config.additional_allow_prefixes;
    }
    if (Object.keys(config.thresholds).length > 0) rendered.thresholds = config.thresholds;
    if (Object.keys(rendered).length > 0) guards[name] = rendered;
  }
  if (Object.keys(guards).length > 0) document.guards = guards;
  return `${JSON.stringify(document, null, 2)}\n`;
}

function clonePolicy(policy: RepoHookPolicy): RepoHookPolicy {
  return JSON.parse(JSON.stringify(policy)) as RepoHookPolicy;
}

function mutableSurface(policy: RepoHookPolicy, surface: string): RepoSurfacePolicy {
  if (!policy.surfaces[surface]) policy.surfaces[surface] = emptyRepoSurfacePolicy();
  return policy.surfaces[surface];
}

/**
 * Close out a mutation by proving the reader accepts it.
 *
 * Serialize, parse back, and return the RE-PARSED policy — so a caller that
 * writes `serializeRepoHookPolicy(result.policy)` is writing bytes this build
 * has already read successfully. A mutator can therefore introduce no document
 * the launcher would refuse; the failure surfaces here, before any write, where
 * it costs an error message instead of a guard plane that blocks every tool
 * call from a file the agent is not permitted to repair.
 */
function settle(policy: RepoHookPolicy, changed: string[]): PolicyMutation {
  const parsed = parseRepoHookPolicy(serializeRepoHookPolicy(policy));
  if (!parsed.ok) {
    return {
      ok: false,
      error: `refusing to write a policy this build cannot read back: ${parsed.error}`,
    };
  }
  return { ok: true, policy: parsed.policy, changed };
}

function invalidReason(reason: unknown, flag: string): string | null {
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) {
    return `${flag} must be at least ${MIN_REASON} characters: it is the recorded answer to "why is the guard plane different in this repo?", and it propagates to every clone`;
  }
  return null;
}

function unknownEvent(event: string): string | null {
  return POLICY_EVENTS.includes(event)
    ? null
    : `unknown event: ${event} (expected one of ${POLICY_EVENTS.join(', ')})`;
}

/** The basename of a chain entry, dropping any arguments. */
function entryName(entry: string): string {
  return entry.split(' ')[0] ?? entry;
}

export interface AddExtensionInput {
  surface: string;
  event: string;
  /** A chain entry: basename, optionally followed by arguments. */
  handler: string;
  /** Anchor basename to splice before; null appends. */
  before: string | null;
  reason: string;
  /** Repo-relative path the handler lives at, for a handler the pack does not ship. */
  path?: string;
}

/** Splice a handler into one event's chain. Additive: it removes nothing. */
export function policyAddExtension(
  policy: RepoHookPolicy,
  input: AddExtensionInput
): PolicyMutation {
  const eventError = unknownEvent(input.event);
  if (eventError) return { ok: false, error: eventError };
  if (!HANDLER_ENTRY.test(input.handler)) {
    return { ok: false, error: `malformed handler entry: ${input.handler}` };
  }
  if (input.before !== null && !HANDLER_NAME.test(input.before)) {
    return { ok: false, error: `malformed anchor: ${input.before}` };
  }
  const reasonError = invalidReason(input.reason, '--reason');
  if (reasonError) return { ok: false, error: reasonError };

  const name = entryName(input.handler);
  if (input.path !== undefined) {
    const targetError = invalidTarget(input.path);
    if (targetError) return { ok: false, error: `--path ${targetError}` };
    if (REPO_POLICY_FLOOR.includes(name)) {
      return { ok: false, error: floorMessage('handlers', name, 'replace') };
    }
  }

  const next = clonePolicy(policy);
  const surface = mutableSurface(next, input.surface);
  const existing = surface.extensions[input.event] ?? [];
  if (existing.some((entry) => entryName(entry.handler) === name)) {
    // Refusing beats overwriting: the second invocation is either a typo or an
    // intent to change the anchor, and silently rewriting the first entry would
    // discard a reason someone recorded.
    return {
      ok: false,
      error: `${name} is already an extension for ${input.event} in surfaces.${input.surface}; restore it first to change its anchor`,
    };
  }
  surface.extensions[input.event] = [
    ...existing,
    { handler: input.handler, before: input.before, reason: input.reason },
  ];
  const changed = [
    `+ surfaces.${input.surface}.extensions.${input.event}: ${input.handler} ${
      input.before === null ? '(appended)' : `before ${input.before}`
    }`,
  ];
  if (input.path !== undefined) {
    surface.handlers[name] = input.path;
    changed.push(`+ surfaces.${input.surface}.handlers.${name} -> ${input.path}`);
  }
  return settle(next, changed);
}

export interface DisableInput {
  surface: string;
  event: string;
  handler: string;
  reason: string;
}

/** Subtract a handler from one event's chain. Enforcement-reducing: reason required. */
export function policyDisableHandler(policy: RepoHookPolicy, input: DisableInput): PolicyMutation {
  const eventError = unknownEvent(input.event);
  if (eventError) return { ok: false, error: eventError };
  if (!HANDLER_NAME.test(input.handler)) {
    return { ok: false, error: `malformed handler name: ${input.handler}` };
  }
  if (REPO_POLICY_FLOOR.includes(input.handler)) {
    return { ok: false, error: floorMessage('disabled', input.handler, 'disable') };
  }
  const reasonError = invalidReason(input.reason, '--reason');
  if (reasonError) return { ok: false, error: reasonError };

  const next = clonePolicy(policy);
  const surface = mutableSurface(next, input.surface);
  const existing = surface.disabled[input.event] ?? [];
  if (existing.some((entry) => entry.handler === input.handler)) {
    return {
      ok: false,
      error: `${input.handler} is already disabled for ${input.event} in surfaces.${input.surface}`,
    };
  }
  surface.disabled[input.event] = [...existing, { handler: input.handler, reason: input.reason }];
  return settle(next, [
    `- surfaces.${input.surface}.disabled.${input.event}: ${input.handler} (${input.reason})`,
  ]);
}

export interface ReplaceInput {
  surface: string;
  handler: string;
  /** Repo-relative path of the replacement. */
  path: string;
  reason: string;
  approver: string;
  /** Provenance of the shipped file being forked. */
  forkedFrom: { pack: string; pack_version: number; sha256: string };
}

/**
 * Point a shipped handler's basename at a repo-local file.
 *
 * Always writes the `forks` record alongside, never optionally: the provenance
 * is what lets doctor say "you forked this at pack 67 and it has moved 16
 * times since". A replacement recorded without it is a fork whose staleness
 * nothing can observe, which is the failure this whole design exists to end.
 */
export function policyReplaceHandler(policy: RepoHookPolicy, input: ReplaceInput): PolicyMutation {
  if (!HANDLER_NAME.test(input.handler)) {
    return { ok: false, error: `malformed handler name: ${input.handler}` };
  }
  if (REPO_POLICY_FLOOR.includes(input.handler)) {
    return { ok: false, error: floorMessage('handlers', input.handler, 'replace') };
  }
  const targetError = invalidTarget(input.path);
  if (targetError) return { ok: false, error: `--with ${targetError}` };
  const reasonError = invalidReason(input.reason, '--reason');
  if (reasonError) return { ok: false, error: reasonError };
  if (typeof input.approver !== 'string' || input.approver.trim().length === 0) {
    return { ok: false, error: '--approver must name who accepted the fork' };
  }
  if (!Number.isInteger(input.forkedFrom.pack_version)) {
    return { ok: false, error: 'fork provenance requires an integer pack_version' };
  }
  if (!/^[0-9a-f]{64}$/.test(input.forkedFrom.sha256)) {
    return { ok: false, error: 'fork provenance requires a sha256 of the forked file' };
  }

  const next = clonePolicy(policy);
  const surface = mutableSurface(next, input.surface);
  surface.handlers[input.handler] = input.path;
  surface.forks[input.handler] = {
    forked_from: { ...input.forkedFrom },
    reason: input.reason,
    approver: input.approver,
  };
  return settle(next, [
    `~ surfaces.${input.surface}.handlers.${input.handler} -> ${input.path}`,
    `~ surfaces.${input.surface}.forks.${input.handler}: ${input.forkedFrom.pack}@${input.forkedFrom.pack_version} (${input.approver})`,
  ]);
}

export interface RestoreInput {
  surface: string;
  handler: string;
  /** Scope the removal to one event; omit to sweep every event. */
  event?: string;
}

/**
 * Drop every repo-tier entry naming a handler, returning it to stock.
 *
 * Refuses when nothing referenced it. A restore that reported success over an
 * unchanged document would leave the caller believing a guard came back when
 * the name they typed never appeared in the file — the "confirms while doing
 * nothing" class, applied to the verb whose whole job is undoing.
 */
export function policyRestoreHandler(policy: RepoHookPolicy, input: RestoreInput): PolicyMutation {
  if (!HANDLER_NAME.test(input.handler)) {
    return { ok: false, error: `malformed handler name: ${input.handler}` };
  }
  if (input.event !== undefined) {
    const eventError = unknownEvent(input.event);
    if (eventError) return { ok: false, error: eventError };
  }

  const next = clonePolicy(policy);
  const surface = next.surfaces[input.surface];
  if (!surface) {
    return { ok: false, error: `surfaces.${input.surface} declares no policy` };
  }
  const events = input.event === undefined ? POLICY_EVENTS : [input.event];
  const changed: string[] = [];

  for (const event of events) {
    const disabled = surface.disabled[event];
    if (disabled?.some((entry) => entry.handler === input.handler)) {
      surface.disabled[event] = disabled.filter((entry) => entry.handler !== input.handler);
      changed.push(`restored surfaces.${input.surface}.disabled.${event}: ${input.handler}`);
    }
    const extensions = surface.extensions[event];
    if (extensions?.some((entry) => entryName(entry.handler) === input.handler)) {
      surface.extensions[event] = extensions.filter(
        (entry) => entryName(entry.handler) !== input.handler
      );
      changed.push(`removed surfaces.${input.surface}.extensions.${event}: ${input.handler}`);
    }
  }
  if (surface.handlers[input.handler] !== undefined) {
    delete surface.handlers[input.handler];
    changed.push(`removed surfaces.${input.surface}.handlers.${input.handler}`);
  }
  if (surface.forks[input.handler] !== undefined) {
    delete surface.forks[input.handler];
    changed.push(`removed surfaces.${input.surface}.forks.${input.handler}`);
  }

  if (changed.length === 0) {
    return {
      ok: false,
      error: `surfaces.${input.surface} has no entry for ${input.handler}${
        input.event === undefined ? '' : ` under ${input.event}`
      }; nothing to restore`,
    };
  }
  return settle(next, changed);
}
