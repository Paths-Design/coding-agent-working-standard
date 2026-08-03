// Doctor drift check: detect when the compiled dist/ the running caws
// binary loads is older than the src/ TypeScript sources (or allowlisted
// JS sources) it was built from (CAWS-GUARD-BUILD-FRESHNESS-001).
//
// dist/ is gitignored and rebuilt only by a manual `npm run build`
// (scripts/build-cli.js). Nothing previously signaled that the running
// binary lacked recently-edited behavior — an agent could edit src/, run
// `caws`, and silently get the OLD behavior because the symlinked binary
// resolves to a stale dist/. This file makes `caws doctor` surface that
// drift and route to the `npm run build` fix.
//
// This is a CLI/shell concern, NOT a kernel one: the kernel's
// inspectProjectState knows nothing about the package's build layout,
// node_modules, or the dist/src split. The check lives here and doctor
// appends its finding alongside the kernel findings, exactly mirroring
// detectGitignoreDrift (src/init/gitignore-drift.ts).

import * as fs from 'fs';
import * as path from 'path';

import type { DoctorFinding } from '@paths.design/caws-kernel';

import { storeDiagnostic } from '../store/repo-root';

/** Rule id for the build-staleness finding (shell. prefix marks a
 * non-kernel-owned finding, matching GITIGNORE_DRIFT_RULE). */
export const BUILD_DIST_STALE_RULE = 'shell.build.dist_stale';

/**
 * The JS files copied verbatim from src/ to dist/ by scripts/build-cli.js
 * (JS_ALLOWLIST). Each maps 1:1 src/<x>.js -> dist/<x>.js. Kept in sync
 * with that allowlist; if scripts/build-cli.js adds an entry, add it here
 * too. The TypeScript layer (src/store/**, src/shell/**) is emitted by
 * tsc and discovered by walking the tree, so it does not need listing.
 */
const ALLOWLISTED_JS_SOURCES: readonly string[] = [
  'index.js',
  'config/index.js',
  'error-handler.js',
  'shell/legacy-command-map.js',
  'shell/registered-command-groups.js',
  'utils/detection.js',
  'utils/error-categories.js',
];

/** The compiled-artifact suffixes tsc emits for each .ts source. */
const TS_ARTIFACT_SUFFIXES: readonly string[] = ['.js', '.d.ts'];

function mtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function listTsSources(srcDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = ['store', 'shell'];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(srcDir, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = path.join(rel, e.name);
      if (e.isDirectory()) {
        stack.push(childRel);
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        out.push(childRel);
      }
    }
  }
  return out;
}

interface StalenessResult {
  readonly staleCount: number;
  readonly oldestDeltaMs: number;
}

/**
 * Compare every tracked source against its compiled artifact(s) and report
 * staleness. A source is "stale" when ANY of its compiled artifacts is
 * missing OR older than the source. Returns null when there is nothing to
 * compare (no src/ sibling — a published install).
 *
 * Compiled outputs:
 *   src/<rel>.js  (allowlisted) -> dist/<rel>.js
 *   src/<rel>.ts  (tsc input)   -> dist/<rel>.js  AND dist/<rel>.d.ts
 */
function computeStaleness(srcDir: string, distDir: string): StalenessResult | null {
  // No src/ sibling → published install (package.json files ships only
  // dist/). Staleness is meaningless; must not raise a false positive.
  if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return null;

  let staleCount = 0;
  let oldestDeltaMs = 0;

  const consider = (srcRel: string, artifactRels: readonly string[]): void => {
    const srcAbs = path.join(srcDir, srcRel);
    const srcMtime = mtimeMs(srcAbs);
    if (srcMtime === null) return; // missing source → nothing to compare
    for (const artifactRel of artifactRels) {
      const distAbs = path.join(distDir, artifactRel);
      const distMtime = mtimeMs(distAbs);
      if (distMtime === null) {
        // Missing artifact is the strongest staleness signal.
        staleCount += 1;
        continue;
      }
      const delta = srcMtime - distMtime;
      if (delta > 0) {
        staleCount += 1;
        if (delta > oldestDeltaMs) oldestDeltaMs = delta;
      }
    }
  };

  // TypeScript sources: src/<rel>.ts -> dist/<rel>.{js,d.ts}
  for (const tsRel of listTsSources(srcDir)) {
    const base = tsRel.slice(0, -'.ts'.length); // strip .ts
    consider(tsRel, TS_ARTIFACT_SUFFIXES.map((s) => base + s));
  }
  // Allowlisted JS sources: src/<rel>.js -> dist/<rel>.js (1:1 copy)
  for (const jsRel of ALLOWLISTED_JS_SOURCES) {
    consider(jsRel, [jsRel]);
  }

  return { staleCount, oldestDeltaMs };
}

/**
 * Resolve the package dist root from a path inside dist/. The dist tree
 * mirrors the src tree (e.g. dist/shell/commands/doctor.js), so a caller's
 * `__dirname` may be nested several levels under dist/. Walk UP from
 * `startDir` until a directory is found whose parent contains a sibling
 * `src/` (i.e. `<parent>/src` exists and `<parent>/dist` is `startDir` or
 * one of its ancestors). Returns the dist root, or null when no such layout
 * exists (published install ships only dist/, no src/).
 */
function resolveDistRoot(startDir: string): string | null {
  let dir = startDir;
  // Guard against infinite loops / filesystem root.
  for (let depth = 0; depth < 16; depth++) {
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    if (fs.existsSync(path.join(parent, 'src')) && fs.existsSync(path.join(parent, 'dist'))) {
      const distRoot = path.join(parent, 'dist');
      // Confirm `dir` is at-or-under parent/dist (it is, since we walked up
      // from inside dist). This guards against a coincidental src/ sibling
      // elsewhere in the tree.
      if (dir === distRoot || dir.startsWith(distRoot + path.sep)) {
        return distRoot;
      }
    }
    dir = parent;
  }
  return null;
}

/**
 * Build the build-staleness doctor finding. Returns null when the running
 * binary has no sibling src/ (published install) OR when dist is fresh.
 *
 * @param startDir A path inside the running caws binary's dist/ tree —
 *   typically the `__dirname` of the doctor command, which is nested at
 *   dist/shell/commands/. The function walks UP to locate the package dist
 *   root (the directory whose parent has a sibling src/). In a dev checkout
 *   this resolves to packages/caws-cli/dist; in a published install there
 *   is no sibling src/ and the check no-ops.
 */
export function detectBuildStaleness(startDir: string): DoctorFinding | null {
  const binaryDistDir = resolveDistRoot(startDir);
  if (binaryDistDir === null) return null; // published install (no src/ sibling)

  // The src/ directory is the sibling of dist/ at the package root.
  const packageRoot = path.dirname(binaryDistDir);
  const srcDir = path.join(packageRoot, 'src');

  const result = computeStaleness(srcDir, binaryDistDir);
  if (result === null || result.staleCount === 0) return null;

  return storeDiagnostic(
    BUILD_DIST_STALE_RULE,
    'The running caws is compiled from dist/ that is older than src/. ' +
      'Edits to TypeScript or allowlisted JS sources have not been rebuilt, ' +
      'so the binary lacks the current behavior. Rebuild before trusting ' +
      '`caws` output (a stale binary silently ran OLD code).',
    {
      severity: 'warning',
      subject: 'dist/',
      narrowRepair:
        'Run `cd packages/caws-cli && npm run build`, then re-run. The ' +
        'global `caws` is symlinked into dist/, which is gitignored and ' +
        'rebuilt only by a manual build — nothing else signals it is stale.',
      data: {
        stale_files: result.staleCount,
        oldest_delta_ms: result.oldestDeltaMs,
      },
    }
  ) as DoctorFinding;
}
