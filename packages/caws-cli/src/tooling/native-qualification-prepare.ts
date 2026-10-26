import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertOwnership, deriveBindingState, evaluatePath } from '../kernel';
import { resolveRepoRoot, type GitRunner } from '../store/repo-root';
import { loadPolicy } from '../store/policy-store';
import { loadSpecs } from '../store/specs-store';
import { loadWorktrees } from '../store/worktrees-store';
import { resolveCallerSession } from '../shell/session/resolve-session';

/** Object identities are storage-format identities, never revision expressions. */
export type PreparationObjectFormat = 'sha1' | 'sha256';
export type PreparationObjectKind = 'commit' | 'tree' | 'blob';
export interface PreparationObjectSelection {
  oid: string;
  kind: PreparationObjectKind;
}
export interface PreparationGitObject extends PreparationObjectSelection {
  bytes: Buffer;
}
export interface PreparationTreeEntry {
  name: string;
  oid: string;
  mode: '40000' | '100644' | '100755';
}
export interface PreparationExportFile {
  relativePath: string;
  oid: string;
  mode: '100644' | '100755';
  bytes: Buffer;
}
export interface PreparationExportPlan {
  commit: string;
  tree: string;
  directories: string[];
  files: PreparationExportFile[];
}

export interface PreparationWriteSelection {
  outputRoot: string;
  /** Complete actual destinations for this phase, including new directories. */
  writePaths: readonly string[];
}
export interface PreparationCallerContext {
  /** Process context supplied by the maintained caller, never request JSON. */
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  /** The maintained caller supplies the independently pinned, bounded runner. */
  git: GitRunner;
}
export interface PreparationWriteObservation {
  repoRoot: string;
  cawsDir: string;
  worktreeRoot: string;
  worktreeName: string;
  specId: string;
  sessionId: string;
  checkedRelativePaths: string[];
}

const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;
const MAX_OBJECTS = 50000;

// This is a production-input profile, not the publication curation authority.
// All tracked first-party Markdown docs feed the maintained audience selector;
// this profile does not duplicate its consumer/publication curation decision.
const PRODUCTION_INPUT_FILES = new Set([
  'LICENSE',
  'package.json',
  'package-lock.json',
  'rust-toolchain.toml',
  'scripts/install-cli-snapshot.mjs',
  ...[
    'package.json',
    'README.md',
    '.npmignore',
    '.gitignore',
    'tsconfig.vnext.json',
    'surfaces/registry.json',
    'src/index.js',
    'src/config/index.js',
    'src/error-handler.js',
    'src/shell/legacy-command-map.js',
    'src/shell/registered-command-groups.js',
    'src/utils/detection.js',
    'src/utils/error-categories.js',
    'src/transcripts/unicode14/LICENSE.txt',
    'src/transcripts/html311/LICENSE.txt',
    'scripts/build-cli.js',
    'scripts/generate-runtime-assets.mjs',
    'scripts/generate-surface-registry.mjs',
    'scripts/check-surface-registry.mjs',
    'scripts/stage-consumer-docs.mjs',
    'scripts/clean-staged-docs.mjs',
    'scripts/generate-command-reference.mjs',
    'scripts/validate-docs.mjs',
  ].map((file) => `packages/caws-cli/${file}`),
  ...[
    'Cargo.toml',
    'Cargo.lock',
    'build.rs',
    'src/process_comm_macos.c',
    'src/owned_group_macos.c',
    'src/service_image/prefix-profile.json',
    'examples/process-comm-vis-oracle.c',
    'examples/service-observer.rs',
    'examples/service-custody-observer.rs',
  ].map((file) => `packages/caws-native/${file}`),
]);

export type PreparationSourceDisposition = 'include' | 'unselected' | 'protected';

/** Name-only selection. Call before requesting any source blob bytes. */
export function preparationSourceDisposition(relativePath: string): PreparationSourceDisposition {
  requireCondition(
    typeof relativePath === 'string' &&
      relativePath.length > 0 &&
      relativePath.length <= 4096 &&
      !path.posix.isAbsolute(relativePath) &&
      path.posix.normalize(relativePath) === relativePath &&
      relativePath
        .split('/')
        .every(
          (name) =>
            name.length > 0 &&
            name.length <= 255 &&
            name !== '.' &&
            name !== '..' &&
            /^[\x20-\x7e]+$/.test(name) &&
            !name.includes('\\')
        ),
    'Unsafe source profile path'
  );
  const parts = relativePath.split('/');
  const lower = parts.map((part) => part.toLowerCase());
  const base = lower[lower.length - 1]!;
  if (
    lower.some(
      (part) =>
        part.startsWith('.env') ||
        part.endsWith('.env') ||
        [
          '.git',
          '.caws',
          '.codex',
          '.claude',
          '.agent',
          '.aws',
          '.ssh',
          '.azure',
          '.kube',
        ].includes(part) ||
        part === 'node_modules' ||
        part === '__pycache__'
    ) ||
    /^(credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519))$/.test(base) ||
    /\.(?:pem|key|p12|pfx|pyc|pyo)$/.test(base) ||
    base === '.npmrc' ||
    relativePath.startsWith('packages/caws-cli/dist/') ||
    relativePath.startsWith('packages/caws-native/target/') ||
    relativePath.startsWith('packages/caws-cli/templates/hook-packs/claude-code/tmp/') ||
    relativePath.startsWith('.cargo/')
  )
    return 'protected';
  if (PRODUCTION_INPUT_FILES.has(relativePath)) return 'include';
  if (relativePath.startsWith('docs/') && relativePath.endsWith('.md')) return 'include';
  if (
    /^packages\/caws-cli\/src\/(?:store|shell|kernel|init|runtime|transcripts|tooling)\/.+\.(?:ts|json)$/.test(
      relativePath
    )
  )
    return 'include';
  if (relativePath.startsWith('packages/caws-cli/templates/hook-packs/')) {
    // These are distributable templates, not effective machine registrations.
    // Their operational scratch/state and arbitrary fixtures are not inputs.
    const templateParts = lower.slice(4);
    if (
      templateParts.some((part) =>
        ['tmp', 'state', 'sessions', 'artifacts', '.caws', '.codex', 'fixtures', 'tests'].includes(
          part
        )
      )
    )
      return 'protected';
    return 'include';
  }
  if (relativePath.startsWith('packages/caws-native/src/') && relativePath.endsWith('.rs')) {
    if (base === 'tests.rs' || parts.slice(3).includes('tests')) return 'unselected';
    return 'include';
  }
  return 'unselected';
}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function normalizedAbsolute(value: string): void {
  requireCondition(
    typeof value === 'string' &&
      value.length <= 4096 &&
      !value.includes('\0') &&
      path.isAbsolute(value) &&
      path.resolve(value) === value,
    'Expected a normalized absolute preparation path'
  );
}

function descendant(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Read live canonical ownership and scope for actual planned destinations.
 * This result is an observation, not a reusable capability. The effecting
 * caller must recheck it and enforce exclusive physical custody separately.
 * It grants no source-read, executable-startup, or candidate-build standing.
 */
export function inspectPreparationWriteAuthority(
  selection: PreparationWriteSelection,
  caller: PreparationCallerContext
): PreparationWriteObservation {
  normalizedAbsolute(caller.cwd);
  normalizedAbsolute(selection.outputRoot);
  requireCondition(
    Array.isArray(selection.writePaths) && selection.writePaths.length <= MAX_OBJECTS,
    'Preparation destination count exceeds bound'
  );
  const resolved = resolveRepoRoot(caller.cwd, { git: caller.git, requireCawsDir: true });
  requireCondition(resolved.ok, 'Cannot resolve canonical preparation project');
  const { repoRoot, cawsDir } = resolved.value;
  const worktreeRoot = caller.git(['rev-parse', '--show-toplevel'], { cwd: caller.cwd });
  normalizedAbsolute(worktreeRoot);
  requireCondition(
    fs.realpathSync(worktreeRoot) === worktreeRoot && fs.realpathSync(repoRoot) === repoRoot,
    'Preparation project paths must be physical'
  );
  requireCondition(
    caller.cwd === worktreeRoot || descendant(worktreeRoot, caller.cwd),
    'Actual caller is outside selected Git worktree'
  );
  requireCondition(worktreeRoot !== repoRoot, 'Preparation requires an owned linked worktree');
  const registry = loadWorktrees(cawsDir);
  requireCondition(registry.ok, 'Cannot load canonical worktree registry');
  const matches = Object.entries(registry.value).filter(
    ([, record]) => record?.path === worktreeRoot
  );
  requireCondition(
    matches.length === 1,
    'Actual Git worktree must match exactly one registry entry'
  );
  const [worktreeName, record] = matches[0]!;
  const specs = loadSpecs(cawsDir);
  requireCondition(
    !specs.diagnostics.some((item) => item.severity === 'error'),
    'Canonical spec load failed'
  );
  const spec = specs.specs.find((item) => item.id === record.specId);
  requireCondition(spec?.lifecycle_state === 'active', 'Preparation spec must be active');
  const binding = deriveBindingState(spec, registry.value, worktreeName);
  requireCondition(binding.kind === 'bound', 'Preparation binding must be bidirectional');
  const session = resolveCallerSession({
    cawsDir,
    worktreeRoot,
    env: { ...caller.environment },
    allowMint: false,
    agentPidWalkFn: () => null,
  });
  requireCondition(session.ok, 'Preparation caller identity unavailable');
  const ownership = assertOwnership(
    registry.value,
    worktreeName,
    session.value.identity,
    { takeover: false },
    new Date()
  );
  requireCondition(
    ownership.ok && ownership.value === null,
    'Preparation worktree belongs to another caller'
  );
  const policy = loadPolicy(cawsDir);
  requireCondition(
    policy.policy && policy.errors.length === 0,
    'Canonical preparation policy unavailable'
  );
  requireCondition(
    descendant(worktreeRoot, selection.outputRoot),
    'Preparation output must be inside the actual worktree'
  );
  const relativeRoot = path.relative(worktreeRoot, selection.outputRoot).split(path.sep).join('/');
  requireCondition(
    !relativeRoot
      .split('/')
      .some((part) => part === '.git' || part === '.caws' || part === '.claude'),
    'Preparation output cannot be control-plane state'
  );
  const checkedRelativePaths: string[] = [];
  for (const destination of new Set([selection.outputRoot, ...selection.writePaths])) {
    normalizedAbsolute(destination);
    requireCondition(
      destination === selection.outputRoot || descendant(selection.outputRoot, destination),
      'Preparation destination escapes selected output'
    );
    const relative = path.relative(worktreeRoot, destination).split(path.sep).join('/');
    const decision = evaluatePath(relative, binding, policy.policy);
    requireCondition(
      decision.kind === 'admit' && decision.rule === 'scope.admit.scope_in',
      `Preparation destination needs explicit scope admission: ${relative}`
    );
    checkedRelativePaths.push(relative);
  }
  // Ignored is an operational constraint, never a substitute for scope above.
  try {
    caller.git(['check-ignore', '--quiet', '--no-index', '--', relativeRoot], {
      cwd: worktreeRoot,
    });
  } catch {
    throw new Error('Preparation output must be ignored by the actual worktree');
  }
  return {
    repoRoot,
    cawsDir,
    worktreeRoot,
    worktreeName,
    specId: spec.id,
    sessionId: session.value.identity.session_id,
    checkedRelativePaths,
  };
}

function oidWidth(format: PreparationObjectFormat): number {
  requireCondition(format === 'sha1' || format === 'sha256', 'Unsupported Git object format');
  return format === 'sha1' ? 40 : 64;
}

function requireOid(oid: string, format: PreparationObjectFormat): void {
  requireCondition(
    typeof oid === 'string' && oid.length === oidWidth(format) && /^[0-9a-f]+$/.test(oid),
    'Expected a full lowercase Git object identity'
  );
}

/**
 * Decode fixed cat-file --batch output. Every returned byte belongs to an
 * explicitly selected, independently rehashed object; surplus output refuses.
 * This establishes object identity, not permission to export or write it.
 */
export function decodePreparationGitBatch(
  output: Buffer,
  selections: readonly PreparationObjectSelection[],
  format: PreparationObjectFormat
): PreparationGitObject[] {
  oidWidth(format);
  requireCondition(
    Buffer.isBuffer(output) && output.length <= MAX_BATCH_BYTES,
    'Git batch exceeds bound'
  );
  requireCondition(
    Array.isArray(selections) && selections.length > 0 && selections.length <= MAX_OBJECTS,
    'Invalid Git object selection count'
  );
  let offset = 0;
  const result: PreparationGitObject[] = [];
  for (const selection of selections) {
    requireOid(selection.oid, format);
    requireCondition(
      selection.kind === 'commit' || selection.kind === 'tree' || selection.kind === 'blob',
      'Unsupported Git object kind'
    );
    const end = output.indexOf(10, offset);
    requireCondition(end >= offset && end - offset <= 128, 'Missing or oversized Git batch header');
    const header = output.subarray(offset, end).toString('utf8');
    const match = /^([0-9a-f]+) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(header);
    requireCondition(match, 'Malformed or missing Git batch object');
    requireCondition(
      match[1] === selection.oid && match[2] === selection.kind,
      'Git batch selection mismatch'
    );
    const size = Number(match[3]);
    requireCondition(
      Number.isSafeInteger(size) && size <= MAX_OBJECT_BYTES,
      'Git object exceeds bound'
    );
    offset = end + 1;
    requireCondition(
      offset + size < output.length && output[offset + size] === 10,
      'Truncated Git object'
    );
    const bytes = Buffer.from(output.subarray(offset, offset + size));
    const actual = createHash(format)
      .update(Buffer.from(`${selection.kind} ${size}\0`, 'ascii'))
      .update(bytes)
      .digest('hex');
    requireCondition(actual === selection.oid, 'Git object content identity mismatch');
    result.push({ oid: selection.oid, kind: selection.kind, bytes });
    offset += size + 1;
  }
  requireCondition(offset === output.length, 'Surplus Git batch output');
  return result;
}

/** Extract the sole root tree header without interpreting commit messages. */
export function preparationCommitTree(bytes: Buffer, format: PreparationObjectFormat): string {
  oidWidth(format);
  requireCondition(
    Buffer.isBuffer(bytes) && bytes.length <= MAX_OBJECT_BYTES,
    'Commit exceeds bound'
  );
  const headerEnd = bytes.indexOf(Buffer.from('\n\n'));
  requireCondition(headerEnd >= 0, 'Commit header terminator missing');
  const header = bytes.subarray(0, headerEnd).toString('utf8');
  requireCondition(!header.includes('\0') && !header.includes('\r'), 'Malformed commit headers');
  const lines = header.split('\n');
  const treeLines = lines.filter((line) => line.startsWith('tree '));
  requireCondition(
    lines[0]?.startsWith('tree ') && treeLines.length === 1,
    'Commit must select one root tree'
  );
  const tree = treeLines[0]!.slice(5);
  requireOid(tree, format);
  return tree;
}

/**
 * Qualification accepts portable ASCII names and regular source files only.
 * The closed domain avoids filesystem case/normalization aliases. Links and
 * submodules require a different explicit contract; no generic following.
 */
export function decodePreparationGitTree(
  bytes: Buffer,
  format: PreparationObjectFormat
): PreparationTreeEntry[] {
  const objectBytes = oidWidth(format) / 2;
  requireCondition(
    Buffer.isBuffer(bytes) && bytes.length <= MAX_OBJECT_BYTES,
    'Tree exceeds bound'
  );
  const entries: PreparationTreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    requireCondition(entries.length < MAX_OBJECTS, 'Tree entry count exceeds bound');
    const space = bytes.indexOf(32, offset);
    const nul = bytes.indexOf(0, offset);
    requireCondition(
      space > offset && nul > space && space - offset <= 6,
      'Malformed Git tree record'
    );
    const mode = bytes.subarray(offset, space).toString('utf8');
    requireCondition(
      mode === '40000' || mode === '100644' || mode === '100755',
      'Unsupported source mode'
    );
    const rawName = bytes.subarray(space + 1, nul);
    requireCondition(
      rawName.length > 0 &&
        rawName.length <= 255 &&
        rawName.every((byte) => byte >= 32 && byte <= 126),
      'Unsupported source name'
    );
    const name = rawName.toString('ascii');
    requireCondition(
      name !== '.' && name !== '..' && name.toLowerCase() !== '.git' && !/[\\/]/.test(name),
      'Unsafe source name'
    );
    const folded = name.toLowerCase();
    requireCondition(!names.has(folded), 'Duplicate or case-colliding source name');
    names.add(folded);
    requireCondition(nul + 1 + objectBytes <= bytes.length, 'Truncated Git tree identity');
    entries.push({
      name,
      mode,
      oid: bytes.subarray(nul + 1, nul + 1 + objectBytes).toString('hex'),
    });
    offset = nul + 1 + objectBytes;
  }
  return entries;
}

/**
 * Derive a complete source inventory from the selected object's closed graph.
 * An inventory is data only: this function grants no filesystem write authority.
 */
export function planPreparationGitExport(
  objects: readonly PreparationGitObject[],
  commit: string,
  tree: string,
  format: PreparationObjectFormat
): PreparationExportPlan {
  requireOid(commit, format);
  requireOid(tree, format);
  requireCondition(
    Array.isArray(objects) && objects.length <= MAX_OBJECTS,
    'Object graph exceeds bound'
  );
  const index = new Map<string, PreparationGitObject>();
  let objectBytes = 0;
  for (const object of objects) {
    requireOid(object.oid, format);
    requireCondition(
      object.kind === 'commit' || object.kind === 'tree' || object.kind === 'blob',
      'Unsupported Git object kind'
    );
    requireCondition(
      Buffer.isBuffer(object.bytes) && object.bytes.length <= MAX_OBJECT_BYTES,
      'Git object exceeds bound'
    );
    objectBytes += object.bytes.length;
    requireCondition(objectBytes <= MAX_BATCH_BYTES, 'Object graph bytes exceed bound');
    requireCondition(!index.has(object.oid), 'Duplicate object graph member');
    const bytes = Buffer.from(object.bytes);
    const oid = createHash(format)
      .update(`${object.kind} ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    requireCondition(oid === object.oid, 'Git object content identity mismatch');
    index.set(oid, { oid, kind: object.kind, bytes });
  }
  const used = new Set<string>();
  const get = (oid: string, kind: PreparationObjectKind): PreparationGitObject => {
    const object = index.get(oid);
    requireCondition(object && object.kind === kind, 'Missing object or incorrect graph edge type');
    used.add(oid);
    return object;
  };
  requireCondition(
    preparationCommitTree(get(commit, 'commit').bytes, format) === tree,
    'Pinned root tree mismatch'
  );
  const directories: string[] = [];
  const files: PreparationExportFile[] = [];
  let materializedBytes = 0;
  let entries = 0;
  const walk = (oid: string, prefix: string, depth: number): void => {
    requireCondition(depth <= 64, 'Source tree depth exceeds bound');
    for (const entry of decodePreparationGitTree(get(oid, 'tree').bytes, format)) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      requireCondition(
        relativePath.length <= 4096 && ++entries <= MAX_OBJECTS,
        'Source path inventory exceeds bound'
      );
      if (entry.mode === '40000') {
        directories.push(relativePath);
        walk(entry.oid, relativePath, depth + 1);
      } else {
        const bytes = get(entry.oid, 'blob').bytes;
        materializedBytes += bytes.length;
        requireCondition(
          materializedBytes <= MAX_BATCH_BYTES,
          'Materialized source bytes exceed bound'
        );
        files.push({ relativePath, mode: entry.mode, oid: entry.oid, bytes: Buffer.from(bytes) });
      }
    }
  };
  walk(tree, '', 0);
  requireCondition(used.size === index.size, 'Unreachable object graph member');
  directories.sort();
  files.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
  return { commit, tree, directories, files };
}
