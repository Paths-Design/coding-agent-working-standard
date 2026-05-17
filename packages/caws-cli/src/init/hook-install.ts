// Hook-pack install logic. Managed-marker aware; non-destructive by default.
//
// Install policy:
//   - absent             → create the file from the pack's bundled template.
//   - managed_clean      → no-op (same pack/version, content matches).
//   - managed_old_version → update (replace with new bundled content).
//   - managed_drift      → refuse unless adopt/overwrite is passed.
//   - unmanaged_collision → refuse unless adopt/overwrite is passed.
//
// settings.json is intentionally NOT in the pack manifest. If a user
// already has .claude/settings.json, this module surfaces the canonical
// wiring snippet for them to merge by hand. If they have no settings.json,
// it emits the snippet to put into a new file.

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

/** Parse a managed header from file content. Returns null when not
 *  present. Tolerant of leading shebang and of `<!--`/`-->`-style
 *  comment wrappers (for Markdown). */
export function parseManagedHeader(content: string): ManagedHeader | null {
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
  const header = parseManagedHeader(localContent);
  if (!header) return { kind: 'unmanaged_collision' };

  if (header.hookPack !== packId) {
    // A managed file from a different pack at our destPath. Treat as
    // unmanaged collision so the user sees a clear refusal.
    return { kind: 'unmanaged_collision' };
  }

  const sourceAbs = path.join(packRoot, file.sourcePath);
  const sourceBytes = readBytes(sourceAbs);
  if (sourceBytes === null) {
    // Source template missing — this is a bug in the install, not a
    // collision. Surface as drift so we don't silently no-op.
    return { kind: 'managed_drift', header };
  }

  if (header.hookPackVersion < packVersion) {
    return {
      kind: 'managed_old_version',
      header,
      currentVersion: header.hookPackVersion,
    };
  }

  if (bytesEqual(localBytes, sourceBytes)) {
    return { kind: 'managed_clean', header };
  }
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
  executable: boolean
): void {
  ensureDir(path.dirname(destAbs));
  fs.copyFileSync(sourceAbs, destAbs);
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

  switch (state.kind) {
    case 'absent':
      writeFile(destAbs, sourceAbs, file.executable);
      return { destPath: file.destPath, action: 'created' };

    case 'managed_clean':
      return { destPath: file.destPath, action: 'unchanged' };

    case 'managed_old_version':
      writeFile(destAbs, sourceAbs, file.executable);
      return { destPath: file.destPath, action: 'updated' };

    case 'managed_drift':
      if (ctx.overwrite) {
        writeFile(destAbs, sourceAbs, file.executable);
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
        writeFile(destAbs, sourceAbs, file.executable);
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
    // A canonical entry has a hook whose command path references
    // .claude/hooks/dispatch/<key snake_case>.sh
    const snake = key
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();
    const expectedTail = `.claude/hooks/dispatch/${snake}.sh`;
    let found = false;
    for (const block of entry as unknown[]) {
      const hookList = (block as { hooks?: unknown }).hooks;
      if (!Array.isArray(hookList)) continue;
      for (const h of hookList as unknown[]) {
        const cmd = (h as { command?: unknown }).command;
        if (typeof cmd === 'string' && cmd.includes(expectedTail)) {
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

/** Canonical settings.json wiring snippet, returned as a JSON string
 *  ready to print or copy. Mirrors the snippet in CLAUDE.md. */
export const CANONICAL_SETTINGS_SNIPPET = JSON.stringify(
  {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Read|Write|Edit|Glob|Grep|NotebookEdit',
          hooks: [
            {
              type: 'command',
              command:
                '"$CLAUDE_PROJECT_DIR"/.claude/hooks/dispatch/pre_tool_use.sh',
              timeout: 45,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Write|Edit|Bash|ExitPlanMode',
          hooks: [
            {
              type: 'command',
              command:
                '"$CLAUDE_PROJECT_DIR"/.claude/hooks/dispatch/post_tool_use.sh',
              timeout: 60,
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command:
                '"$CLAUDE_PROJECT_DIR"/.claude/hooks/dispatch/session_start.sh',
              timeout: 30,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command:
                '"$CLAUDE_PROJECT_DIR"/.claude/hooks/dispatch/stop.sh',
              timeout: 30,
            },
          ],
        },
      ],
    },
  },
  null,
  2
);
