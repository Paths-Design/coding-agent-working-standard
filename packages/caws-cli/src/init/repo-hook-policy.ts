/**
 * Repo-local hook policy: document shape, validator and chain resolver.
 *
 * CAWS-REPO-HOOK-POLICY-RESOLVER-01.
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
 * This module is deliberately UNWIRED: it owns the shape and the merge
 * semantics, and the launcher (python) and CLI verbs adopt it in later slices.
 * Keeping the semantics in one reviewed place is what stops the two planes from
 * drifting into two different answers for the same document.
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
 * Named `Repo…` to stay distinct from machine-adapter-policy.ts's
 * `SurfacePolicy`, which is the LEGACY `{events: {<event>: {hooks_dir,
 * handlers[]}}}` shape this design supersedes. They are different shapes with
 * opposite postures (frozen full copy vs. additive), so they must not share a
 * name.
 */
export interface RepoSurfacePolicy {
  disabled: Record<string, string[]>;
  extensions: Record<string, PolicyExtension[]>;
  handlers: Record<string, string>;
  libraries: Record<string, string>;
  forks: Record<string, PolicyFork>;
}

export interface RepoHookPolicy {
  version: number;
  surfaces: Record<string, RepoSurfacePolicy>;
  guards: Record<string, unknown>;
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

  const guards = raw.guards === undefined ? {} : raw.guards;
  if (!isPlainObject(guards)) {
    return { ok: false, error: `${REPO_HOOK_POLICY_PATH} guards must be an object` };
  }

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
    for (const [event, names] of Object.entries(raw.disabled)) {
      if (!POLICY_EVENTS.includes(event)) {
        return { ok: false, error: `${where}.disabled names an unknown event: ${event}` };
      }
      if (
        !Array.isArray(names) ||
        names.some((n) => typeof n !== 'string' || !HANDLER_NAME.test(n))
      ) {
        return { ok: false, error: `${where}.disabled.${event} must be a list of handler names` };
      }
      for (const name of names as string[]) {
        if (REPO_POLICY_FLOOR.includes(name)) {
          return { ok: false, error: floorMessage(`${where}.disabled.${event}`, name, 'disable') };
        }
      }
      surface.disabled[event] = [...(names as string[])];
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
  const named = policy.surfaces[surface] ?? emptyRepoSurfacePolicy();
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

  const repoError = applyTier(input.repo.disabled, input.repo.extensions, 'repo');
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
