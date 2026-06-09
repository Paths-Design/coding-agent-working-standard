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

  const excludeResult = ensureWorktreeExclude(worktreeRoot, candidate.relPath);
  if (!excludeResult.ok) {
    return status(candidate, 'skipped_not_ignored', {
      source,
      reason: `Could not add a worktree-local git exclude for ${candidate.relPath}: ${excludeResult.reason}`,
    });
  }

  if (!isIgnored(worktreeRoot, candidate.relPath)) {
    return status(candidate, 'skipped_not_ignored', {
      source,
      reason: `${candidate.relPath} is not ignored by git in this worktree.`,
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

  try {
    const linkTarget = path.relative(parent, source);
    fs.symlinkSync(linkTarget, dest, 'dir');
    return status(candidate, 'linked', {
      source,
      linkTarget,
      unlinkCommand: `rm ${shellQuote(candidate.relPath)}`,
    });
  } catch (e) {
    return status(candidate, 'link_failed', {
      source,
      reason: `Could not symlink ${candidate.relPath}: ${errorMessage(e)}`,
    });
  }
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

function isIgnored(worktreeRoot: string, relPath: string): boolean {
  for (const candidate of [relPath, `${relPath}/`]) {
    try {
      execFileSync('git', ['-C', worktreeRoot, 'check-ignore', '-q', '--', candidate], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      // Try the next spelling; directory patterns often require a trailing slash.
    }
  }
  return false;
}

function ensureWorktreeExclude(
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
