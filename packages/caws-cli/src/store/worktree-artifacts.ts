// Advisory artifact linking for CAWS-created worktrees.
//
// This intentionally manages only dependency/cache-style directories that
// are ignored by git in the new worktree. Worktree creation must not depend
// on these links: every failure is represented as a status for the CLI to
// surface, never as a lifecycle error.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type WorktreeArtifactKind =
  | 'node_dependencies'
  | 'pnpm_store'
  | 'python_venv'
  | 'rust_target'
  | 'swift_build';

export type WorktreeArtifactLinkState =
  | 'linked'
  | 'already_linked'
  | 'missing_target'
  | 'skipped_existing_path'
  | 'skipped_not_ignored'
  | 'lock_mismatch'
  | 'link_failed';

export interface WorktreeArtifactLinkStatus {
  readonly path: string;
  readonly kind: WorktreeArtifactKind;
  readonly state: WorktreeArtifactLinkState;
  readonly source?: string;
  readonly linkTarget?: string;
  readonly reason?: string;
  readonly unlinkCommand?: string;
  readonly installHint: string;
}

export interface WorktreeArtifactLinkSummary {
  readonly statuses: readonly WorktreeArtifactLinkStatus[];
}

interface ArtifactCandidate {
  readonly relPath: string;
  readonly kind: WorktreeArtifactKind;
  readonly manifestFiles: readonly string[];
  readonly installHint: string;
}

const KNOWN_DIRS = new Set([
  '.git',
  '.caws',
  '.claude',
  '.codex',
  'node_modules',
  '.pnpm-store',
  '.turbo',
  '.pytest_cache',
  '.ruff_cache',
  'coverage',
  'dist',
  'build',
  'tmp',
]);

const ROOT_CANDIDATES: readonly ArtifactCandidate[] = [
  {
    relPath: 'node_modules',
    kind: 'node_dependencies',
    manifestFiles: [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'package.json',
    ],
    installHint: 'Run the project package-manager install command in the worktree before running tests.',
  },
  {
    // .caws/hooks/node_modules is checked directly here (ROOT_CANDIDATES bypass
    // the walk) because `.caws` is in KNOWN_DIRS, which prunes the entire .caws
    // subtree at walk depth 0 — so walkDirs never descends into .caws/hooks/
    // and would otherwise never discover this nested artifact. Without this
    // link, the worktree-claim-oracle (worktree-claim-oracle.cjs) cannot
    // require('js-yaml') in the worktree, forcing the js-yaml degrade path
    // (CAWS-HOOKPACK-ORACLE-JSYAML-DEGRADE-001) on every hooks-bearing worktree.
    // CAWS-WORKTREE-ARTIFACT-CAWS-HOOKS-NODE-MODULES-001.
    relPath: '.caws/hooks/node_modules',
    kind: 'node_dependencies',
    manifestFiles: ['.caws/hooks/package.json', '.caws/hooks/package-lock.json'],
    installHint:
      'Run npm install in .caws/hooks in the worktree before running hooks ' +
      '(js-yaml is required by the worktree-claim-oracle).',
  },
  {
    relPath: '.pnpm-store',
    kind: 'pnpm_store',
    manifestFiles: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    installHint: 'Run pnpm install in the worktree before running pnpm-backed tests.',
  },
  {
    relPath: '.venv',
    kind: 'python_venv',
    manifestFiles: ['uv.lock', 'poetry.lock', 'requirements.txt', 'pyproject.toml'],
    installHint: 'Create or install the Python environment in the worktree before running Python tests.',
  },
  {
    relPath: 'target',
    kind: 'rust_target',
    manifestFiles: ['Cargo.lock', 'Cargo.toml'],
    installHint: 'Run cargo build or cargo test in the worktree to materialize the Rust target cache.',
  },
  {
    relPath: '.build',
    kind: 'swift_build',
    manifestFiles: ['Package.resolved', 'Package.swift'],
    installHint: 'Run swift build or swift test in the worktree to materialize the Swift build cache.',
  },
];

export function linkWorktreeArtifacts(
  repoRoot: string,
  worktreeRoot: string
): WorktreeArtifactLinkSummary {
  const candidates = discoverCandidates(repoRoot);
  if (candidates.length === 0) return { statuses: [] };

  const seen = new Set<string>();
  const statuses: WorktreeArtifactLinkStatus[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.relPath)) continue;
    seen.add(candidate.relPath);
    statuses.push(linkCandidate(repoRoot, worktreeRoot, candidate));
  }
  return { statuses };
}

function discoverCandidates(repoRoot: string): readonly ArtifactCandidate[] {
  const out: ArtifactCandidate[] = [];

  for (const candidate of ROOT_CANDIDATES) {
    if (hasAnyManifest(repoRoot, candidate) || fs.existsSync(path.join(repoRoot, candidate.relPath))) {
      out.push(candidate);
    }
  }
  for (const entry of readDir(repoRoot)) {
    if (!entry.isDirectory() || !entry.name.startsWith('.venv-')) continue;
    out.push({
      relPath: entry.name,
      kind: 'python_venv',
      manifestFiles: ['uv.lock', 'poetry.lock', 'requirements.txt', 'pyproject.toml'],
      installHint: `Create or install the ${entry.name} Python environment in the worktree before running tests.`,
    });
  }

  for (const dir of walkDirs(repoRoot, 2)) {
    const rel = path.relative(repoRoot, dir);
    if (rel.length === 0) continue;
    const base = path.basename(dir);
    if (base === 'node_modules' || base === '.venv' || base.startsWith('.venv-')) {
      continue;
    }

    const nodeModules = path.join(dir, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      out.push({
        relPath: path.join(rel, 'node_modules'),
        kind: 'node_dependencies',
        manifestFiles: [
          path.join(rel, 'package-lock.json'),
          path.join(rel, 'pnpm-lock.yaml'),
          path.join(rel, 'yarn.lock'),
          path.join(rel, 'bun.lock'),
          path.join(rel, 'bun.lockb'),
          path.join(rel, 'package.json'),
        ],
        installHint: `Run the package-manager install command for ${rel} in the worktree before running tests.`,
      });
    }

    const pyProject = path.join(dir, 'pyproject.toml');
    const requirements = path.join(dir, 'requirements.txt');
    const venv = path.join(dir, '.venv');
    if (fs.existsSync(pyProject) || fs.existsSync(requirements) || fs.existsSync(venv)) {
      out.push({
        relPath: path.join(rel, '.venv'),
        kind: 'python_venv',
        manifestFiles: [
          path.join(rel, 'uv.lock'),
          path.join(rel, 'poetry.lock'),
          path.join(rel, 'requirements.txt'),
          path.join(rel, 'pyproject.toml'),
        ],
        installHint: `Create or install the Python environment for ${rel} in the worktree before running tests.`,
      });
    }

    const cargoToml = path.join(dir, 'Cargo.toml');
    const target = path.join(dir, 'target');
    if (fs.existsSync(cargoToml) || fs.existsSync(target)) {
      out.push({
        relPath: path.join(rel, 'target'),
        kind: 'rust_target',
        manifestFiles: [path.join(rel, 'Cargo.lock'), path.join(rel, 'Cargo.toml')],
        installHint: `Run cargo build or cargo test for ${rel} in the worktree to materialize the Rust target cache.`,
      });
    }
  }

  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function walkDirs(root: string, maxDepth: number): readonly string[] {
  const dirs: string[] = [];

  function visit(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    const entries = readDir(dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (KNOWN_DIRS.has(entry.name) && depth === 0) continue;
      const child = path.join(dir, entry.name);
      dirs.push(child);
      if (!KNOWN_DIRS.has(entry.name)) visit(child, depth + 1);
    }
  }

  visit(root, 0);
  return dirs;
}

function readDir(dir: string): readonly fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function hasAnyManifest(repoRoot: string, candidate: ArtifactCandidate): boolean {
  return candidate.manifestFiles.some((f) => fs.existsSync(path.join(repoRoot, f)));
}

function linkCandidate(
  repoRoot: string,
  worktreeRoot: string,
  candidate: ArtifactCandidate
): WorktreeArtifactLinkStatus {
  const source = path.join(repoRoot, candidate.relPath);
  const dest = path.join(worktreeRoot, candidate.relPath);
  const relSource = candidate.relPath;

  if (!fs.existsSync(source)) {
    return status(candidate, 'missing_target', {
      reason: `No canonical artifact exists at ${relSource}.`,
    });
  }

  const lockMismatch = firstManifestMismatch(repoRoot, worktreeRoot, candidate);
  if (lockMismatch !== undefined) {
    return status(candidate, 'lock_mismatch', {
      source,
      reason: `Manifest differs between canonical checkout and worktree: ${lockMismatch}.`,
    });
  }

  const parent = path.dirname(dest);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (e) {
    return status(candidate, 'link_failed', {
      source,
      reason: `Could not create parent directory ${path.relative(worktreeRoot, parent)}: ${errorMessage(e)}`,
    });
  }

  try {
    const existing = fs.lstatSync(dest);
    if (existing.isSymbolicLink()) {
      const resolved = path.resolve(parent, fs.readlinkSync(dest));
      if (samePath(resolved, source)) {
        const ignored = ensureLinkIgnored(worktreeRoot, candidate.relPath);
        if (!ignored.ok) {
          // A CAWS-shape link that git would report as untracked dirt is
          // worse than no link: it blocks the governed merge/destroy
          // clean checks. Remove it rather than confirm it.
          try {
            fs.unlinkSync(dest);
          } catch {
            /* the honest skipped_not_ignored status below still applies */
          }
          return status(candidate, 'skipped_not_ignored', { source, reason: ignored.reason });
        }
        return status(candidate, 'already_linked', linkDetails(source, dest, worktreeRoot));
      }
    }
    return status(candidate, 'skipped_existing_path', {
      source,
      reason: `${candidate.relPath} already exists in the worktree; CAWS will not overwrite it.`,
    });
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    if (code !== 'ENOENT') {
      return status(candidate, 'link_failed', {
        source,
        reason: `Could not inspect ${candidate.relPath}: ${errorMessage(e)}`,
      });
    }
  }

  const linkTarget = path.relative(parent, source);
  try {
    fs.symlinkSync(linkTarget, dest, 'dir');
  } catch (e) {
    return status(candidate, 'link_failed', {
      source,
      reason: `Could not symlink ${candidate.relPath}: ${errorMessage(e)}`,
    });
  }

  // Verify ignore status on the LIVE symlink, after creation. A pre-create
  // probe cannot be trusted: dir-only gitignore patterns (`node_modules/`,
  // `.venv/`) match a directory at the path but never the symlink CAWS
  // actually creates, so a pre-create "ignored" answer can leave the link
  // visible to `git status` — untracked dirt that blocks the governed
  // merge/destroy clean checks (CAWS-WORKTREE-ARTIFACT-LINK-SYMLINK-
  // IGNORE-001).
  const ignored = ensureLinkIgnored(worktreeRoot, candidate.relPath);
  if (!ignored.ok) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* the honest skipped_not_ignored status below still applies */
    }
    return status(candidate, 'skipped_not_ignored', { source, reason: ignored.reason });
  }

  return status(candidate, 'linked', {
    source,
    linkTarget,
    unlinkCommand: `rm ${shellQuote(candidate.relPath)}`,
  });
}

// Make sure the artifact path is ignored by git as it exists on disk,
// writing the shared exclude when the tracked ignore rules do not cover
// the live symlink.
function ensureLinkIgnored(
  worktreeRoot: string,
  relPath: string
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (isIgnored(worktreeRoot, relPath)) return { ok: true };
  const excludeResult = ensureSharedExclude(worktreeRoot, relPath);
  if (!excludeResult.ok) {
    return {
      ok: false,
      reason: `Could not add a git exclude for ${relPath}: ${excludeResult.reason}`,
    };
  }
  if (!isIgnored(worktreeRoot, relPath)) {
    return {
      ok: false,
      reason: `${relPath} is not ignored by git in this worktree (a dir-only pattern like "${relPath}/" does not match a symlink), even after writing the shared exclude.`,
    };
  }
  return { ok: true };
}

// ─── Verified-link inspection + teardown ────────────────────────────────
//
// The destroy/merge clean-tree gates must distinguish CAWS-created artifact
// links from real work product. A path qualifies as a verified artifact
// link when it sits at a discovered candidate relPath AND is a symlink
// whose target resolves to the canonical counterpart at
// <repoRoot>/<relPath>. Directories, regular files, and foreign-target
// symlinks never qualify.

export function listVerifiedArtifactLinks(
  repoRoot: string,
  worktreeRoot: string
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of discoverCandidates(repoRoot)) {
    if (seen.has(candidate.relPath)) continue;
    seen.add(candidate.relPath);
    const dest = path.join(worktreeRoot, candidate.relPath);
    let existing: fs.Stats;
    try {
      existing = fs.lstatSync(dest);
    } catch {
      continue;
    }
    if (!existing.isSymbolicLink()) continue;
    let target: string;
    try {
      target = fs.readlinkSync(dest);
    } catch {
      continue;
    }
    const resolved = path.resolve(path.dirname(dest), target);
    if (samePath(resolved, path.join(repoRoot, candidate.relPath))) {
      out.push(candidate.relPath);
    }
  }
  return out;
}

// Unlink every verified artifact link in the worktree. Only ever applies
// fs.unlinkSync to a path that passed the verified-link signature — never
// a directory, never a foreign symlink, never rm -rf. Unlink failures are
// skipped so the caller's clean-tree check reports the leftover honestly.
export function removeWorktreeArtifactLinks(
  repoRoot: string,
  worktreeRoot: string
): readonly string[] {
  const removed: string[] = [];
  for (const relPath of listVerifiedArtifactLinks(repoRoot, worktreeRoot)) {
    try {
      fs.unlinkSync(path.join(worktreeRoot, relPath));
      removed.push(relPath);
    } catch {
      /* leave it; the clean-tree check surfaces it */
    }
  }
  return removed;
}

function firstManifestMismatch(
  repoRoot: string,
  worktreeRoot: string,
  candidate: ArtifactCandidate
): string | undefined {
  for (const rel of candidate.manifestFiles) {
    const source = path.join(repoRoot, rel);
    const dest = path.join(worktreeRoot, rel);
    if (!fs.existsSync(source) || !fs.existsSync(dest)) continue;
    try {
      if (!fs.readFileSync(source).equals(fs.readFileSync(dest))) return rel;
    } catch {
      return rel;
    }
  }
  return undefined;
}

// Probe ONLY the plain spelling. The trailing-slash spelling (`relPath/`)
// asks git about a DIRECTORY at that path; the artifact CAWS creates is a
// symlink, which dir-only patterns never match, so a trailing-slash probe
// produces false "ignored" answers that leave the created link visible to
// `git status`. Callers probe after the link exists, so the plain spelling
// reflects git's true lstat-based decision.
function isIgnored(worktreeRoot: string, relPath: string): boolean {
  try {
    execFileSync('git', ['-C', worktreeRoot, 'check-ignore', '-q', '--', relPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// Append relPath to the repository's info/exclude so the symlink does not
// show up as an untracked path. `git rev-parse --git-path info/exclude`
// resolves through the COMMON git dir for linked worktrees, so this exclude
// is SHARED by the canonical checkout and every worktree — it is not
// worktree-local. Callers must only invoke this when the path is not
// already ignored (e.g. via a tracked .gitignore), so repos that already
// ignore their artifact dirs never have this file touched.
function ensureSharedExclude(
  worktreeRoot: string,
  relPath: string
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let excludePath: string;
  try {
    excludePath = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return { ok: false, reason: errorMessage(e) };
  }

  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    const lines = existing.split(/\r?\n/);
    if (lines.includes(relPath) || lines.includes(`${relPath}/`)) return { ok: true };
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      excludePath,
      `${prefix}# CAWS worktree artifact links\n${relPath}\n`
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errorMessage(e) };
  }
}

function linkDetails(
  source: string,
  dest: string,
  worktreeRoot: string
): { readonly source: string; readonly linkTarget: string; readonly unlinkCommand: string } {
  return {
    source,
    linkTarget: path.relative(path.dirname(dest), source),
    unlinkCommand: `rm ${shellQuote(path.relative(worktreeRoot, dest))}`,
  };
}

function status(
  candidate: ArtifactCandidate,
  state: WorktreeArtifactLinkState,
  extra: {
    readonly source?: string;
    readonly linkTarget?: string;
    readonly unlinkCommand?: string;
    readonly reason?: string;
  } = {}
): WorktreeArtifactLinkStatus {
  return {
    path: candidate.relPath,
    kind: candidate.kind,
    state,
    installHint: candidate.installHint,
    ...(extra.source !== undefined ? { source: extra.source } : {}),
    ...(extra.linkTarget !== undefined ? { linkTarget: extra.linkTarget } : {}),
    ...(extra.unlinkCommand !== undefined ? { unlinkCommand: extra.unlinkCommand } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
  };
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
