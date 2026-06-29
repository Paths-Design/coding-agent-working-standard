// Hook-pack install logic. Managed-marker aware; non-destructive by default.
//
// Install policy:
//   - absent             → create the file from the pack's bundled template.
//   - managed_clean      → no-op (same pack/version, content matches).
//   - managed_old_version → update (replace with new bundled content).
//   - managed_drift      → refuse unless adopt/overwrite is passed.
//   - unmanaged_collision → refuse unless adopt/overwrite is passed.
//
// settings.json is intentionally NOT in the pack manifest (it carries
// user-authored permissions/env that the pack must not clobber). This
// module instead MERGES the four CAWS caws_dispatch entrypoints into
// settings.json non-destructively:
//   - absent             → write a fresh settings.json (CAWS wiring only).
//   - present-but-unwired → append the four entries to existing arrays,
//                           preserving all other keys.
//   - already-wired      → no-op (idempotent; byte-identical re-run).
//   - invalid JSON       → refuse to merge; surface the snippet + error.
// A .claude/settings.json.example carrying the canonical wiring is always
// emitted as a reference for the "don't touch my settings.json" case.
// CAWS-owned entries are identified by the "/.claude/hooks/caws_dispatch/"
// path segment in the hook command.

import * as fs from 'fs';
import * as path from 'path';

import type {
  HookPackFile,
  HookPackFileAction,
  HookPackInstallResult,
  HookPackV1,
  InstallFileState,
  ManagedHeader,
} from './hook-packs/types';

/** Location of the pack templates relative to the caws-cli package root.
 *  Resolved at runtime from __dirname so it works both in dev (running
 *  ts-node against src/) and from the dist build. */
function packTemplateRoot(packId: string): string {
  // The templates live alongside the built dist/ at the package root.
  // From dist/, walk up to the package root and down into templates.
  // From src/init/hook-install.ts ts-node mode, the same walk works.
  // We tolerate both: src/init -> package root is two levels up;
  // dist -> package root is one level up.
  const here = __dirname;
  const candidates = [
    path.resolve(here, '..', '..', 'templates', 'hook-packs', packId),
    path.resolve(here, '..', 'templates', 'hook-packs', packId),
    path.resolve(here, '..', '..', '..', 'templates', 'hook-packs', packId),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall through to the first candidate even if missing; downstream will
  // emit a clean "template file missing" diagnostic.
  return candidates[0] ?? '';
}

// ─── Managed header parsing ──────────────────────────────────────────────

/** Match a managed-header block at the top of a file. The block consists
 *  of consecutive `# CAWS-...` lines after an optional shebang or
 *  HTML/JSDoc comment opener. */
const HEADER_MARKER = 'CAWS-MANAGED-HOOK';

function parseJsonManagedHeader(content: string): ManagedHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const description = (parsed as { description?: unknown }).description;
  if (typeof description !== 'string' || !description.includes(HEADER_MARKER)) {
    return null;
  }

  const readString = (key: string): string => {
    const match = description.match(new RegExp(`${key}=([^\\s.]+)`));
    return match ? match[1] ?? '' : '';
  };

  const hookPack = readString('hook_pack');
  const hookPackVersion = Number.parseInt(readString('hook_pack_version'), 10);
  const cawsMinMajor = Number.parseInt(readString('caws_min_major'), 10);
  const lineageRefs = readString('lineage_refs')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));

  if (!hookPack || Number.isNaN(hookPackVersion) || hookPackVersion <= 0) {
    return null;
  }
  return {
    hookPack,
    hookPackVersion,
    cawsMinMajor: Number.isNaN(cawsMinMajor) ? 0 : cawsMinMajor,
    lineageRefs,
  };
}

/** Parse a managed header from file content. Returns null when not
 *  present. Tolerant of leading shebang and of `<!--`/`-->`-style
 *  comment wrappers (for Markdown). */
export function parseManagedHeader(content: string): ManagedHeader | null {
  const jsonHeader = parseJsonManagedHeader(content);
  if (jsonHeader) return jsonHeader;

  // Search the first ~30 lines for the marker. This is large enough to
  // tolerate shebang + HTML comment wrapper but small enough to stay
  // fast on big files.
  const lines = content.split('\n').slice(0, 30);
  let inBlock = false;
  let hookPack = '';
  let hookPackVersion = 0;
  let cawsMinMajor = 0;
  let lineageRefs: number[] = [];
  let sawMarker = false;

  for (const raw of lines) {
    const line = raw.trim().replace(/^<!--\s*/, '').replace(/\s*-->\s*$/, '');
    if (!line) continue;

    if (line.includes(HEADER_MARKER)) {
      sawMarker = true;
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;

    // The block consists of `# key: value` lines. First non-comment
    // line ends the block.
    if (!line.startsWith('#')) break;

    const stripped = line.replace(/^#\s*/, '');
    const colon = stripped.indexOf(':');
    if (colon < 0) continue;
    const key = stripped.slice(0, colon).trim();
    const value = stripped.slice(colon + 1).trim();

    switch (key) {
      case 'hook_pack':
        hookPack = value;
        break;
      case 'hook_pack_version': {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) hookPackVersion = n;
        break;
      }
      case 'caws_min_major': {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) cawsMinMajor = n;
        break;
      }
      case 'lineage_refs': {
        lineageRefs = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => !Number.isNaN(n));
        break;
      }
      // 'do_not_edit_directly' is informational; ignored here.
    }
  }

  if (!sawMarker || !hookPack || hookPackVersion <= 0) return null;
  return {
    hookPack,
    hookPackVersion,
    cawsMinMajor,
    lineageRefs,
  };
}

// ─── Per-file state evaluation ───────────────────────────────────────────

function readBytes(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function codexCommand(_repoRoot: string, dispatcher: string): string {
  // CAWS-CODEX-HOOK-RUNTIME-ROOT-001: resolve the active Git checkout at
  // hook invocation time, not at install time. Codex sessions may start from a
  // subdirectory, and copied worktrees must not keep stale absolute paths.
  return `REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"; CAWS_AGENT_SURFACE=codex CAWS_PROJECT_DIR="$REPO_ROOT" CODEX_PROJECT_DIR="$REPO_ROOT" "$REPO_ROOT/.caws/hooks/dispatch/${dispatcher}"`;
}

/** Stamp the manifest pack version into a file's managed header so the installed
 *  header tracks the pack version (the template literals are frozen at their
 *  authoring value and would otherwise always read as "old version"). Both
 *  header forms are stamped: the `#`-comment form `# hook_pack_version: N` and
 *  the JSON `description`-field form `hook_pack_version=N`. This is a pure string
 *  rewrite — it must run on BOTH the write path and the comparison path so an
 *  unmodified installed file is byte-identical to the rendered template. */
function stampPackVersion(content: string, packVersion: number): string {
  return content
    .replace(/^(#\s*hook_pack_version:\s*)\d+/m, `$1${packVersion}`)
    .replace(/(hook_pack_version=)\d+/, `$1${packVersion}`);
}

/** Normalize the version stamp to a sentinel so two files can be compared on
 *  body alone — used to tell "differs only by the version line" (an unedited
 *  file predating the current pack version) from a genuinely edited body. */
function stripPackVersion(content: string): string {
  return content
    .replace(/^(#\s*hook_pack_version:\s*)\d+/m, '$1#')
    .replace(/(hook_pack_version=)\d+/, '$1#');
}

const CODEX_EVENT_DISPATCHERS: Record<string, string> = {
  SessionStart: 'session_start.sh',
  PreToolUse: 'pre_tool_use.sh',
  PostToolUse: 'post_tool_use.sh',
  PreCompact: 'pre_compact.sh',
  Stop: 'stop.sh',
};

function parseJsonObject(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function normalizeCodexHooksJson(content: string): string | null {
  const parsed = parseJsonObject(content);
  if (!parsed) return null;
  const description = parsed.description;
  if (typeof description === 'string' && description.includes(HEADER_MARKER)) {
    delete parsed.description;
  }
  return JSON.stringify(parsed);
}

function codexHooksJsonEquivalentIgnoringManagedDescription(
  left: string,
  right: string
): boolean {
  const normalizedLeft = normalizeCodexHooksJson(left);
  const normalizedRight = normalizeCodexHooksJson(right);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft === normalizedRight
  );
}

function parseCodexHooksJsonManagedHeader(content: string): ManagedHeader | null {
  const parsed = parseJsonObject(content);
  if (!parsed) return null;

  const topLevelKeys = Object.keys(parsed).sort();
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'hooks') {
    return null;
  }

  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return null;
  }

  const commands: Array<{ eventName: string; command: string }> = [];
  for (const [eventName, rawEntries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) return null;
    for (const rawEntry of rawEntries) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        return null;
      }
      const rawHooks = (rawEntry as { hooks?: unknown }).hooks;
      if (!Array.isArray(rawHooks)) return null;
      for (const rawHook of rawHooks) {
        if (!rawHook || typeof rawHook !== 'object' || Array.isArray(rawHook)) {
          return null;
        }
        const hook = rawHook as { type?: unknown; command?: unknown };
        if (hook.type === 'command' && typeof hook.command === 'string') {
          commands.push({ eventName, command: hook.command });
        }
      }
    }
  }

  if (commands.length !== Object.keys(CODEX_EVENT_DISPATCHERS).length) {
    return null;
  }

  const seen = new Set<string>();
  for (const { eventName, command } of commands) {
    const dispatcher = CODEX_EVENT_DISPATCHERS[eventName];
    if (!dispatcher || seen.has(eventName)) return null;
    if (
      !command.includes('git rev-parse --show-toplevel') ||
      !command.includes('CAWS_AGENT_SURFACE=codex') ||
      !command.includes('CAWS_PROJECT_DIR="$REPO_ROOT"') ||
      !command.includes('CODEX_PROJECT_DIR="$REPO_ROOT"') ||
      !command.includes(`"$REPO_ROOT/.caws/hooks/dispatch/${dispatcher}"`) ||
      command.includes('.codex/hooks/caws_dispatch') ||
      command.includes('__CAWS_CODEX_')
    ) {
      return null;
    }
    seen.add(eventName);
  }

  if (seen.size !== Object.keys(CODEX_EVENT_DISPATCHERS).length) {
    return null;
  }

  return {
    hookPack: 'codex',
    hookPackVersion: 0,
    cawsMinMajor: 11,
    lineageRefs: [],
  };
}

function renderPackFileBytes(
  sourceBytes: Buffer,
  repoRoot: string,
  file: HookPackFile,
  packVersion: number
): Buffer {
  let rendered = stampPackVersion(sourceBytes.toString('utf8'), packVersion);

  // Exact-match the one templated file: a suffix match would also catch any
  // future nested *.../hooks.json and run codex substitution over it.
  if (file.destPath === '.codex/hooks.json') {
    const replacements: Record<string, string> = {
      __CAWS_CODEX_SESSION_START_COMMAND__: codexCommand(repoRoot, 'session_start.sh'),
      __CAWS_CODEX_PRE_TOOL_USE_COMMAND__: codexCommand(repoRoot, 'pre_tool_use.sh'),
      __CAWS_CODEX_POST_TOOL_USE_COMMAND__: codexCommand(repoRoot, 'post_tool_use.sh'),
      __CAWS_CODEX_PRE_COMPACT_COMMAND__: codexCommand(repoRoot, 'pre_compact.sh'),
      __CAWS_CODEX_STOP_COMMAND__: codexCommand(repoRoot, 'stop.sh'),
    };
    for (const [token, value] of Object.entries(replacements)) {
      rendered = rendered
        .split(token)
        .join(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
  }

  return Buffer.from(rendered, 'utf8');
}

function bytesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return a.compare(b) === 0;
}

function evaluateFileState(
  repoRoot: string,
  packRoot: string,
  packId: string,
  packVersion: number,
  file: HookPackFile
): InstallFileState {
  const destAbs = path.join(repoRoot, file.destPath);
  const localBytes = readBytes(destAbs);
  if (localBytes === null) return { kind: 'absent' };

  if (!file.managed) {
    // Non-managed pack file (none currently exist, but we model the case).
    // Treat any existing content as a collision; let the policy decide.
    return { kind: 'unmanaged_collision' };
  }

  const localContent = localBytes.toString('utf8');
  let header = parseManagedHeader(localContent);
  if (!header && packId === 'codex' && file.destPath === '.codex/hooks.json') {
    header = parseCodexHooksJsonManagedHeader(localContent);
  }
  if (!header) return { kind: 'unmanaged_collision' };

  if (header.hookPack !== packId) {
    // A managed file from a different pack at our destPath. Treat as
    // unmanaged collision so the user sees a clear refusal.
    return { kind: 'unmanaged_collision' };
  }

  const sourceAbs = path.join(packRoot, file.sourcePath);
  const rawSourceBytes = readBytes(sourceAbs);
  if (rawSourceBytes === null) {
    // Source template missing — this is a bug in the install, not a
    // collision. Surface as drift so we don't silently no-op.
    return { kind: 'managed_drift', header };
  }

  // Content is the authority for "did the consumer edit this"; the header
  // version is only the authority for "is a newer template available". We MUST
  // compare content before deciding to overwrite, or a version bump silently
  // clobbers a hook the repo deliberately grew (the template version literals
  // are frozen at their authoring value, so an installed file's header version
  // is almost always below the manifest version — making the old version-first
  // branch overwrite edited content on essentially every re-init).
  //
  // CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001.
  const sourceBytes = renderPackFileBytes(
    rawSourceBytes,
    repoRoot,
    file,
    packVersion
  );
  if (bytesEqual(localBytes, sourceBytes)) {
    // Byte-identical to the (version-stamped) current template. Whether or not
    // the recorded header version was behind, there is no edit to preserve, so
    // this is a clean no-op — never an overwrite that could lose growth.
    return { kind: 'managed_clean', header };
  }

  if (
    packId === 'codex' &&
    file.destPath === '.codex/hooks.json' &&
    codexHooksJsonEquivalentIgnoringManagedDescription(
      localBytes.toString('utf8'),
      sourceBytes.toString('utf8')
    )
  ) {
    return {
      kind: 'managed_old_version',
      header,
      currentVersion: header.hookPackVersion,
    };
  }

  // Not byte-identical. Distinguish "differs ONLY by the version stamp" (an
  // unedited file carrying an older header version — safe to re-stamp) from
  // "the body was edited" (must be preserved). This is the byte/hash check the
  // version bump relies on: compare the two with the version line normalized.
  const localBody = stripPackVersion(localBytes.toString('utf8'));
  const templateBody = stripPackVersion(sourceBytes.toString('utf8'));
  if (localBody === templateBody) {
    // Bodies match; only the version stamp differs. The file was not edited —
    // it just predates the current pack version. Safe to update (re-stamp);
    // applyOne writes the version-stamped template, losing no growth.
    if (header.hookPackVersion < packVersion) {
      return {
        kind: 'managed_old_version',
        header,
        currentVersion: header.hookPackVersion,
      };
    }
    // Same version, body matches but bytes differ — should be unreachable, but
    // treat as clean rather than refusing a non-edit.
    return { kind: 'managed_clean', header };
  }

  // The body genuinely differs — the consumer grew this hook. Preserve it: the
  // applyOne handler refuses (drift) unless --overwrite/--adopt. A version bump
  // alone never silently clobbers an edited hook.
  // CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001.
  return { kind: 'managed_drift', header };
}

// ─── Install ─────────────────────────────────────────────────────────────

export interface HookPackInstallOptions {
  readonly repoRoot: string;
  /** When true, allow overwriting unmanaged or drifted files. */
  readonly overwrite?: boolean;
  /** When true, leave drifted/unmanaged files in place and report. */
  readonly adopt?: boolean;
  /** Override the pack template root (used by tests). */
  readonly packRootOverride?: string;
}

interface InstallContext {
  readonly repoRoot: string;
  readonly packRoot: string;
  readonly pack: HookPackV1;
  readonly overwrite: boolean;
  readonly adopt: boolean;
}

function ensureDir(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

function writeFile(
  destAbs: string,
  sourceAbs: string,
  executable: boolean,
  repoRoot: string,
  file: HookPackFile,
  packVersion: number
): void {
  ensureDir(path.dirname(destAbs));
  const sourceBytes = readBytes(sourceAbs);
  if (sourceBytes === null) {
    throw new Error(`template file missing: ${sourceAbs}`);
  }
  fs.writeFileSync(
    destAbs,
    renderPackFileBytes(sourceBytes, repoRoot, file, packVersion)
  );
  if (executable) {
    try {
      fs.chmodSync(destAbs, 0o755);
    } catch {
      // chmod can fail on some filesystems (Windows). Non-fatal.
    }
  }
}

function applyOne(
  ctx: InstallContext,
  file: HookPackFile
): HookPackFileAction {
  const destAbs = path.join(ctx.repoRoot, file.destPath);
  const sourceAbs = path.join(ctx.packRoot, file.sourcePath);
  const state = evaluateFileState(
    ctx.repoRoot,
    ctx.packRoot,
    ctx.pack.id,
    ctx.pack.packVersion,
    file
  );

  const pv = ctx.pack.packVersion;
  switch (state.kind) {
    case 'absent':
      writeFile(destAbs, sourceAbs, file.executable, ctx.repoRoot, file, pv);
      return { destPath: file.destPath, action: 'created' };

    case 'managed_clean':
      return { destPath: file.destPath, action: 'unchanged' };

    case 'managed_old_version':
      // The body matches the current template; only the header version stamp is
      // behind. The file was NOT edited (evaluateFileState already proved the
      // bodies are equal modulo the version line), so updating it loses no
      // growth — it just re-stamps the version. Safe to write.
      // (CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001.)
      writeFile(destAbs, sourceAbs, file.executable, ctx.repoRoot, file, pv);
      return { destPath: file.destPath, action: 'updated' };

    case 'managed_drift':
      if (ctx.overwrite) {
        writeFile(destAbs, sourceAbs, file.executable, ctx.repoRoot, file, pv);
        return { destPath: file.destPath, action: 'updated' };
      }
      if (ctx.adopt) {
        return { destPath: file.destPath, action: 'unchanged' };
      }
      return {
        destPath: file.destPath,
        action: 'refused',
        refusalReason: 'managed_drift',
      };

    case 'unmanaged_collision':
      if (ctx.overwrite) {
        writeFile(destAbs, sourceAbs, file.executable, ctx.repoRoot, file, pv);
        return { destPath: file.destPath, action: 'updated' };
      }
      if (ctx.adopt) {
        return { destPath: file.destPath, action: 'unchanged' };
      }
      return {
        destPath: file.destPath,
        action: 'refused',
        refusalReason: 'unmanaged_collision',
      };
  }
}

/** Install a pack into repoRoot. Pure with respect to its inputs except
 *  for the filesystem writes it performs. Returns a typed result the
 *  caller renders. */
export function installHookPack(
  pack: HookPackV1,
  options: HookPackInstallOptions
): HookPackInstallResult {
  const ctx: InstallContext = {
    repoRoot: options.repoRoot,
    packRoot: options.packRootOverride ?? packTemplateRoot(pack.id),
    pack,
    overwrite: options.overwrite === true,
    adopt: options.adopt === true,
  };

  const actions: HookPackFileAction[] = [];
  for (const file of pack.installedFiles) {
    actions.push(applyOne(ctx, file));
  }

  // Determine outcome.
  const anyRefused = actions.some((a) => a.action === 'refused');
  const allUnchanged = actions.every((a) => a.action === 'unchanged');

  let outcome: HookPackInstallResult['outcome'];
  if (anyRefused) {
    // Even a single refusal blocks the outcome from being clean —
    // 'installed' on partial success would imply more than was done.
    // Caller reads action[].refusalReason to decide diagnostic.
    outcome = 'installed';
  } else if (allUnchanged) {
    outcome = 'already_installed';
  } else if (
    actions.some((a) => a.action === 'updated') &&
    !actions.some((a) => a.action === 'created')
  ) {
    outcome = 'updated';
  } else {
    outcome = 'installed';
  }

  return {
    outcome,
    pack,
    actions,
    activation: pack.activation,
  };
}

/** Result of inspecting `.claude/settings.json` for hook wiring. */
export type SettingsWiringStatus =
  /** settings.json is absent. Caller should print the canonical snippet
   *  and instruct the user to create the file. */
  | { readonly kind: 'absent' }
  /** settings.json exists and references all four canonical dispatch
   *  entrypoints. No action needed. */
  | { readonly kind: 'wired' }
  /** settings.json exists but is missing one or more canonical entries.
   *  Caller should print which entries are missing and the snippet to add. */
  | { readonly kind: 'partial'; readonly missing: readonly string[] }
  /** settings.json exists but could not be parsed as JSON. Caller should
   *  surface the parse error and refuse to suggest changes. */
  | { readonly kind: 'invalid'; readonly error: string };

/**
 * Inspect `.claude/settings.json` and report whether the canonical
 * Claude Code hook wiring is present. Install is non-destructive on
 * settings.json — this function just surfaces the state so the CLI can
 * tell the user exactly what to add.
 */
export function inspectClaudeSettings(
  repoRoot: string
): SettingsWiringStatus {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return { kind: 'invalid', error: (e as Error).message };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'invalid', error: 'settings.json root is not an object' };
  }
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== 'object') {
    return {
      kind: 'partial',
      missing: ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'],
    };
  }
  const required = ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'];
  const missing: string[] = [];
  for (const key of required) {
    const entry = (hooks as Record<string, unknown>)[key];
    if (!Array.isArray(entry) || entry.length === 0) {
      missing.push(key);
      continue;
    }
    // A canonical entry has a hook whose command path references any of
    // the known CAWS dispatch tails (shared-core or legacy).
    const snake = key
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();
    const sharedCoreTail = `.caws/hooks/dispatch/${snake}.sh`;
    const legacyCawsDispatchTail = `.claude/hooks/caws_dispatch/${snake}.sh`;
    const legacyDispatchTail = `.claude/hooks/dispatch/${snake}.sh`;
    let found = false;
    for (const block of entry as unknown[]) {
      const hookList = (block as { hooks?: unknown }).hooks;
      if (!Array.isArray(hookList)) continue;
      for (const h of hookList as unknown[]) {
        const cmd = (h as { command?: unknown }).command;
        if (
          typeof cmd === 'string' &&
          (cmd.includes(sharedCoreTail) ||
            cmd.includes(legacyCawsDispatchTail) ||
            cmd.includes(legacyDispatchTail))
        ) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) missing.push(key);
  }
  if (missing.length === 0) return { kind: 'wired' };
  return { kind: 'partial', missing };
}

/** The canonical CAWS hook wiring as a structured object. This is the
 *  single source of truth for both the printed snippet and the in-place
 *  merge — each hook-event key maps to the one CAWS entry that wires the
 *  corresponding shared dispatcher entrypoint.
 *
 *  CAWS-HOOK-PACK-SHARED-CORE-001: commands now route to the shared
 *  dispatcher at .caws/hooks/dispatch/<event>.sh with CAWS_AGENT_SURFACE
 *  and CAWS_PROJECT_DIR injected. The legacy paths
 *  .claude/hooks/caws_dispatch/<event>.sh and .claude/hooks/dispatch/<event>.sh
 *  are recognized by arrayHasCawsEntry as already-wired CAWS entries so
 *  re-running init does not duplicate entries for consumers on the old wiring. */
export const CANONICAL_HOOK_ENTRIES: Readonly<
  Record<string, Record<string, unknown>>
> = {
  PreToolUse: {
    matcher: 'Bash|Read|Write|Edit|Glob|Grep|NotebookEdit',
    hooks: [
      {
        type: 'command',
        command:
          'CAWS_AGENT_SURFACE=claude-code CAWS_PROJECT_DIR="$CLAUDE_PROJECT_DIR" "$CLAUDE_PROJECT_DIR"/.caws/hooks/dispatch/pre_tool_use.sh',
        timeout: 45,
      },
    ],
  },
  PostToolUse: {
    matcher: 'Write|Edit|Bash|ExitPlanMode',
    hooks: [
      {
        type: 'command',
        command:
          'CAWS_AGENT_SURFACE=claude-code CAWS_PROJECT_DIR="$CLAUDE_PROJECT_DIR" "$CLAUDE_PROJECT_DIR"/.caws/hooks/dispatch/post_tool_use.sh',
        timeout: 60,
      },
    ],
  },
  SessionStart: {
    hooks: [
      {
        type: 'command',
        command:
          'CAWS_AGENT_SURFACE=claude-code CAWS_PROJECT_DIR="$CLAUDE_PROJECT_DIR" "$CLAUDE_PROJECT_DIR"/.caws/hooks/dispatch/session_start.sh',
        timeout: 30,
      },
    ],
  },
  Stop: {
    hooks: [
      {
        type: 'command',
        command:
          'CAWS_AGENT_SURFACE=claude-code CAWS_PROJECT_DIR="$CLAUDE_PROJECT_DIR" "$CLAUDE_PROJECT_DIR"/.caws/hooks/dispatch/stop.sh',
        timeout: 30,
      },
    ],
  },
};

/** A fresh settings.json containing ONLY the canonical CAWS wiring. */
function canonicalSettingsObject(): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const [key, entry] of Object.entries(CANONICAL_HOOK_ENTRIES)) {
    hooks[key] = [entry];
  }
  return { hooks };
}

/** Canonical settings.json wiring snippet, returned as a JSON string
 *  ready to print or copy. Mirrors the snippet in CLAUDE.md. */
export const CANONICAL_SETTINGS_SNIPPET = JSON.stringify(
  canonicalSettingsObject(),
  null,
  2
);

// ─── settings.json merge (write / append / idempotent / never-clobber) ───

/** Outcome of a settings.json merge attempt. */
export type SettingsMergeResult =
  /** No settings.json existed; a fresh one was written with CAWS wiring. */
  | { readonly kind: 'created'; readonly path: string }
  /** settings.json existed and was missing CAWS entries; they were
   *  appended. `added` lists the hook-event keys that gained an entry. */
  | { readonly kind: 'merged'; readonly path: string; readonly added: readonly string[] }
  /** settings.json already wired all four entries; nothing written. */
  | { readonly kind: 'unchanged'; readonly path: string }
  /** settings.json existed but could not be parsed; left untouched. */
  | { readonly kind: 'invalid'; readonly path: string; readonly error: string };

/** Does this hook-event's entry array already contain a CAWS-owned entry for
 *  `key`? Matches an entry whose command references any of the three known
 *  CAWS dispatch tails so that re-running init on a consumer using an older
 *  wiring does not append a duplicate entry.
 *
 *  Recognised tails (all anchored with a leading slash):
 *   1. `/.caws/hooks/dispatch/<snake>.sh`      — current (shared-core) path
 *   2. `/.claude/hooks/caws_dispatch/<snake>.sh` — legacy pre-shared-core path
 *   3. `/.claude/hooks/dispatch/<snake>.sh`     — pre-rename legacy path
 *
 *  Decision (CAWS-HOOK-PACK-SHARED-CORE-001): for this slice recognizing all
 *  three tails to avoid duplicates is sufficient. A fresh install writes the
 *  new shared-core path; consumers on the old path are detected as wired and
 *  no duplicate is appended. Whether to rewrite an old-path entry to the new
 *  path on merge is deferred — idempotent detection is the required invariant. */
function arrayHasCawsEntry(entryArray: unknown, key: string): boolean {
  if (!Array.isArray(entryArray)) return false;
  const snake = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const sharedCoreTail = `/.caws/hooks/dispatch/${snake}.sh`;
  const legacyCawsDispatchTail = `/.claude/hooks/caws_dispatch/${snake}.sh`;
  const legacyDispatchTail = `/.claude/hooks/dispatch/${snake}.sh`;
  for (const block of entryArray as unknown[]) {
    const hookList = (block as { hooks?: unknown }).hooks;
    if (!Array.isArray(hookList)) continue;
    for (const h of hookList as unknown[]) {
      const cmd = (h as { command?: unknown }).command;
      if (
        typeof cmd === 'string' &&
        (cmd.includes(sharedCoreTail) ||
          cmd.includes(legacyCawsDispatchTail) ||
          cmd.includes(legacyDispatchTail))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Merge the canonical CAWS hook wiring into `.claude/settings.json`,
 * non-destructively. The CAWS entry for each hook-event is appended only
 * if an equivalent entry (matched by the caws_dispatch command path) is
 * not already present. All other keys — permissions, env, user-authored
 * hooks — are preserved byte-for-byte outside the appended entries.
 *
 * Never overwrites an unparseable file. Idempotent: a second run on a
 * fully-wired settings.json is a no-op and leaves the file byte-identical.
 */
export function mergeClaudeSettings(repoRoot: string): SettingsMergeResult {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    ensureDir(path.dirname(settingsPath));
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(canonicalSettingsObject(), null, 2)}\n`,
      'utf8'
    );
    return { kind: 'created', path: settingsPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return { kind: 'invalid', path: settingsPath, error: (e as Error).message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'invalid',
      path: settingsPath,
      error: 'settings.json root is not an object',
    };
  }

  const root = parsed as Record<string, unknown>;
  const hooks: Record<string, unknown> =
    root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};

  const added: string[] = [];
  for (const [key, entry] of Object.entries(CANONICAL_HOOK_ENTRIES)) {
    const existing = hooks[key];
    if (arrayHasCawsEntry(existing, key)) continue; // already wired
    if (Array.isArray(existing)) {
      (existing as unknown[]).push(entry);
    } else {
      hooks[key] = [entry];
    }
    added.push(key);
  }

  if (added.length === 0) {
    return { kind: 'unchanged', path: settingsPath };
  }

  root.hooks = hooks;
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(root, null, 2)}\n`,
    'utf8'
  );
  return { kind: 'merged', path: settingsPath, added };
}

/** Write `.claude/settings.json.example` with the canonical CAWS wiring.
 *  Idempotent (always writes the same bytes). This is the reference
 *  artifact for users who decline the in-place merge. */
export function writeSettingsExample(repoRoot: string): string {
  const examplePath = path.join(
    repoRoot,
    '.claude',
    'settings.json.example'
  );
  ensureDir(path.dirname(examplePath));
  fs.writeFileSync(examplePath, `${CANONICAL_SETTINGS_SNIPPET}\n`, 'utf8');
  return examplePath;
}

/** Detect a leftover pre-rename `.claude/hooks/dispatch/` directory from a
 *  CAWS install that predates the caws_dispatch/ namespace. Returns the
 *  absolute path when present, else null. The caller emits a leave-and-warn
 *  message; init never deletes or modifies the old dir (it may carry user
 *  customizations and we cannot assume version parity). */
export function detectOrphanedDispatchDir(repoRoot: string): string | null {
  const oldDir = path.join(repoRoot, '.claude', 'hooks', 'dispatch');
  try {
    return fs.statSync(oldDir).isDirectory() ? oldDir : null;
  } catch {
    return null;
  }
}
