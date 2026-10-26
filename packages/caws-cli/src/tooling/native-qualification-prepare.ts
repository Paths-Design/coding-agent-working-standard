import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertOwnership, deriveBindingState, evaluatePath } from '../kernel';
import { resolveRepoRoot, type GitRunner } from '../store/repo-root';
import { loadPolicy } from '../store/policy-store';
import { loadSpecs } from '../store/specs-store';
import { loadWorktrees } from '../store/worktrees-store';
import { resolveCallerSession } from '../shell/session/resolve-session';
import {
  nativeSqlitePreparationCustody,
  type NativeSqliteBuildRequest,
  type ReviewedTree,
} from './native-sqlite-build';
import type { ReviewedFile } from './sqlite-static-build';

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

export interface PreparationSourceSelection {
  sourceRoot: string;
  commit: string;
  tree: string;
  objectFormat: PreparationObjectFormat;
}
export interface PreparationSourceObservation extends PreparationSourceSelection {
  repoRoot: string;
  /** Canonical source does not borrow a lane's authority. */
  worktreeName: string | null;
  specId: string | null;
}

export interface FrozenSourcePreparationRequest {
  schema: 'caws.frozen_source_preparation.v1';
  source: PreparationSourceSelection;
  outputRoot: string;
  futureBuildRoot: string;
}
export interface FrozenSourcePreparationContext extends PreparationCallerContext {
  /** Bound by the maintained caller to the selected project's object store. */
  readObjects: PreparationObjectReader;
  /** Maintained deadline/cancellation observation, never request JSON. */
  checkpoint: () => void;
}
export type FrozenSourcePreparationResult =
  | {
      status: 'prepared';
      adoption: 'NOT_ADOPTED';
      source: PreparationSourceObservation;
      sourceTree: ReviewedTree;
      inventory: ReviewedFile;
      futureBuildRoot: string;
    }
  | {
      status: 'failed';
      adoption: 'NOT_ADOPTED';
      writerState: 'NOT_STARTED' | 'RETAINED_UNCERTAIN';
      phase: string;
      reason: string;
    };

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

function productionInputName(relativePath: string): boolean {
  if (PRODUCTION_INPUT_FILES.has(relativePath)) return true;
  if (relativePath.startsWith('docs/') && relativePath.endsWith('.md')) return true;
  if (
    /^packages\/caws-cli\/src\/(?:store|shell|kernel|init|runtime|transcripts|tooling)\/.+\.(?:ts|json)$/.test(
      relativePath
    )
  )
    return true;
  if (relativePath.startsWith('packages/caws-cli/templates/hook-packs/')) return true;
  if (relativePath.startsWith('packages/caws-native/src/') && relativePath.endsWith('.rs')) {
    const parts = relativePath.split('/');
    return parts[parts.length - 1] !== 'tests.rs' && !parts.slice(3).includes('tests');
  }
  return false;
}

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
        /^(credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519))$/.test(part) ||
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
    /\.(?:pem|key|p12|pfx|pyc|pyo)$/.test(base) ||
    base === '.npmrc' ||
    relativePath.startsWith('packages/caws-cli/dist/') ||
    relativePath.startsWith('packages/caws-native/target/') ||
    relativePath.startsWith('packages/caws-cli/templates/hook-packs/claude-code/tmp/') ||
    relativePath.startsWith('.cargo/')
  )
    return 'protected';
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
  }
  return productionInputName(relativePath) ? 'include' : 'unselected';
}

export interface PreparationProductionPlan extends PreparationExportPlan {
  objectFormat: PreparationObjectFormat;
  /** Names only; none of these source blobs were requested. */
  omitted: { relativePath: string; disposition: 'protected' | 'unselected' }[];
}

/** Maintained transport returns raw fixed cat-file --batch frames, not decoded assertions. */
export type PreparationObjectReader = (selections: readonly PreparationObjectSelection[]) => Buffer;

/**
 * Inspect commit/tree names before selecting any blob. Only the compiled
 * production profile can select content; a protected input required by that
 * profile refuses the entire plan. Source standing and write authority are
 * independent prerequisites enforced by the maintained entry.
 */
export function collectPreparationProductionSource(
  read: PreparationObjectReader,
  commit: string,
  tree: string,
  format: PreparationObjectFormat
): PreparationProductionPlan {
  requireOid(commit, format);
  requireOid(tree, format);
  const cache = new Map<string, PreparationGitObject>();
  let objectBytes = 0;
  const get = (oid: string, kind: PreparationObjectKind): Buffer => {
    const cached = cache.get(oid);
    if (cached) {
      requireCondition(cached.kind === kind, 'Incorrect production graph edge type');
      return cached.bytes;
    }
    requireCondition(cache.size < MAX_OBJECTS, 'Production object count exceeds bound');
    const selection = [{ oid, kind }];
    const object = decodePreparationGitBatch(read(selection), selection, format)[0]!;
    objectBytes += object.bytes.length;
    requireCondition(objectBytes <= MAX_BATCH_BYTES, 'Production object bytes exceed bound');
    cache.set(oid, object);
    return object.bytes;
  };
  requireCondition(
    preparationCommitTree(get(commit, 'commit'), format) === tree,
    'Pinned root tree mismatch'
  );
  const selected: Omit<PreparationExportFile, 'bytes'>[] = [];
  const omitted: PreparationProductionPlan['omitted'] = [];
  let entries = 0;
  const walk = (oid: string, prefix: string, depth: number): void => {
    requireCondition(depth <= 64, 'Source tree depth exceeds bound');
    for (const entry of decodePreparationGitTree(get(oid, 'tree'), format)) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      requireCondition(
        relativePath.length <= 4096 && ++entries <= MAX_OBJECTS,
        'Source path inventory exceeds bound'
      );
      if (entry.mode === '40000') {
        walk(entry.oid, relativePath, depth + 1);
        continue;
      }
      const disposition = preparationSourceDisposition(relativePath);
      if (disposition === 'include')
        selected.push({ relativePath, oid: entry.oid, mode: entry.mode });
      else {
        requireCondition(
          disposition !== 'protected' || !productionInputName(relativePath),
          `Required production input is protected: ${relativePath}`
        );
        omitted.push({ relativePath, disposition });
      }
    }
  };
  walk(tree, '', 0);
  requireCondition(selected.length > 0, 'Production source selection is empty');
  selected.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
  omitted.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
  const directories = new Set<string>();
  let materializedBytes = 0;
  const files = selected.map((file): PreparationExportFile => {
    const bytes = get(file.oid, 'blob');
    materializedBytes += bytes.length;
    requireCondition(
      materializedBytes <= MAX_BATCH_BYTES,
      'Materialized source bytes exceed bound'
    );
    let directory = path.posix.dirname(file.relativePath);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
    return { ...file, bytes: Buffer.from(bytes) };
  });
  return {
    commit,
    tree,
    objectFormat: format,
    directories: [...directories].sort(),
    files,
    omitted,
  };
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

/** The CAWS root mapper alone cannot distinguish sibling Git stores. */
function observePreparationProject(
  cwd: string,
  git: GitRunner
): { repoRoot: string; cawsDir: string; commonDir: string } {
  let observedCommon: string | undefined;
  const resolved = resolveRepoRoot(cwd, {
    requireCawsDir: true,
    git: (args, options) => {
      requireCondition(
        args.join('\0') ===
          ['rev-parse', '--path-format=absolute', '--git-common-dir'].join('\0') &&
          options.cwd === cwd,
        'Unexpected preparation project query'
      );
      const value = git(args, options);
      normalizedAbsolute(value);
      observedCommon = value;
      return value;
    },
  });
  requireCondition(
    resolved.ok && observedCommon !== undefined,
    'Cannot resolve canonical preparation project'
  );
  const commonDir = observedCommon;
  const canonicalCommon = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: resolved.value.repoRoot,
  });
  normalizedAbsolute(canonicalCommon);
  requireCondition(
    fs.realpathSync(commonDir) === commonDir &&
      fs.realpathSync(canonicalCommon) === canonicalCommon,
    'Preparation Git directories must be physical'
  );
  requireCondition(commonDir === canonicalCommon, 'Checkout uses another Git object store');
  return { ...resolved.value, commonDir };
}

/**
 * A source pin selects the current canonical or actively bound worktree HEAD
 * in the caller's project. It cannot select history, a foreign object store,
 * an unregistered lane or dirty working files. This is a live observation,
 * not an authority token; recheck it before materializing/publishing inputs.
 * The maintained caller supplies the closed read-only Git transport.
 */
export function inspectPreparationSourceStanding(
  selection: PreparationSourceSelection,
  caller: PreparationCallerContext
): PreparationSourceObservation {
  normalizedAbsolute(caller.cwd);
  normalizedAbsolute(selection.sourceRoot);
  requireOid(selection.commit, selection.objectFormat);
  requireOid(selection.tree, selection.objectFormat);
  const callerProject = observePreparationProject(caller.cwd, caller.git);
  const sourceProject = observePreparationProject(selection.sourceRoot, caller.git);
  requireCondition(
    sourceProject.repoRoot === callerProject.repoRoot,
    'Source belongs to another canonical project'
  );
  requireCondition(
    sourceProject.commonDir === callerProject.commonDir,
    'Source uses another Git object store'
  );
  const { repoRoot, cawsDir } = callerProject;
  const sourceTop = caller.git(['rev-parse', '--show-toplevel'], { cwd: selection.sourceRoot });
  requireCondition(
    sourceTop === selection.sourceRoot,
    'Source must name its actual Git checkout root'
  );
  requireCondition(
    fs.realpathSync(sourceTop) === sourceTop && fs.realpathSync(repoRoot) === repoRoot,
    'Source project paths must be physical'
  );
  let worktreeName: string | null = null;
  let specId: string | null = null;
  if (sourceTop !== repoRoot) {
    const registry = loadWorktrees(cawsDir);
    requireCondition(registry.ok, 'Cannot load canonical source registry');
    const matches = Object.entries(registry.value).filter(
      ([, record]) => record?.path === sourceTop
    );
    requireCondition(matches.length === 1, 'Source worktree needs exactly one live registry entry');
    const [name, record] = matches[0]!;
    const specs = loadSpecs(cawsDir);
    requireCondition(
      !specs.diagnostics.some((item) => item.severity === 'error'),
      'Canonical source spec load failed'
    );
    const spec = specs.specs.find((item) => item.id === record.specId);
    requireCondition(spec?.lifecycle_state === 'active', 'Source worktree spec must be active');
    requireCondition(
      deriveBindingState(spec, registry.value, name).kind === 'bound',
      'Source binding must be bidirectional'
    );
    worktreeName = name;
    specId = spec.id;
  }
  const gitOptions = { cwd: sourceTop };
  const observedFormat = caller.git(['rev-parse', '--show-object-format'], gitOptions);
  requireCondition(observedFormat === selection.objectFormat, 'Source object format mismatch');
  const observedCommit = caller.git(['rev-parse', '--verify', 'HEAD^{commit}'], gitOptions);
  requireOid(observedCommit, selection.objectFormat);
  requireCondition(observedCommit === selection.commit, 'Source pin is not the current HEAD');
  const observedTree = caller.git(['rev-parse', '--verify', 'HEAD^{tree}'], gitOptions);
  requireOid(observedTree, selection.objectFormat);
  requireCondition(observedTree === selection.tree, 'Source tree pin does not match current HEAD');
  requireCondition(
    caller.git(['rev-parse', '--verify', 'HEAD^{commit}'], gitOptions) === observedCommit,
    'Source HEAD changed during observation'
  );
  return { ...selection, repoRoot, worktreeName, specId };
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
  const { repoRoot, cawsDir } = observePreparationProject(caller.cwd, caller.git);
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

function exactObjectKeys(value: unknown, keys: readonly string[]): void {
  requireCondition(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'),
    'Unexpected preparation request shape'
  );
}

function requireAbsent(file: string): void {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Preparation path already exists: ${file}`);
}

export interface CapturedPreparationInput {
  identity: ReviewedFile;
  bytes: Buffer;
}
export interface PreparedNativeRequestComposition {
  request: NativeSqliteBuildRequest;
  provenance: {
    sourceInventory: ReviewedFile;
    baseRecipe: ReviewedFile;
    source: PreparationSourceObservation;
  };
}

function capturedPreparationJson(captured: CapturedPreparationInput): unknown {
  exactObjectKeys(captured, ['identity', 'bytes']);
  exactObjectKeys(captured.identity, ['path', 'sizeBytes', 'sha256']);
  normalizedAbsolute(captured.identity.path);
  requireCondition(
    Buffer.isBuffer(captured.bytes) &&
      captured.bytes.length > 0 &&
      captured.bytes.length <= MAX_OBJECT_BYTES &&
      captured.bytes.length === captured.identity.sizeBytes &&
      createHash('sha256').update(captured.bytes).digest('hex') === captured.identity.sha256,
    'Captured preparation input identity mismatch'
  );
  const text = captured.bytes.toString('utf8');
  requireCondition(
    Buffer.from(text, 'utf8').equals(captured.bytes),
    'Captured preparation input must be UTF-8'
  );
  return JSON.parse(text);
}

/**
 * Compose request data only from parent-captured, identity-checked byte records.
 * Preserve reviewed tool/vendor/SQLite/SDK pins only when Cargo inputs match.
 * A current source observation is a separate parent dependency, not JSON input.
 * Pins bind records; they do not authenticate the parent, establish semantic
 * acceptance, grant authority or verify current files. No filesystem/child I/O.
 */
export function composePreparedNativeBuildRequest(
  sourceInventory: CapturedPreparationInput,
  baseRecipe: CapturedPreparationInput,
  currentSource: PreparationSourceObservation
): PreparedNativeRequestComposition {
  const inventory = capturedPreparationJson(sourceInventory) as {
    schema: string;
    adoption: string;
    source: PreparationSourceObservation;
    files: (ReviewedTree['files'][number] & { gitObject: string; gitMode: string })[];
    futureBuildRoot: string;
  };
  exactObjectKeys(inventory, [
    'schema',
    'adoption',
    'source',
    'files',
    'omitted',
    'futureBuildRoot',
    'limits',
  ]);
  requireCondition(
    inventory.schema === 'caws.frozen_source_inventory.v1' && inventory.adoption === 'NOT_ADOPTED',
    'Unsupported preparation inventory'
  );
  requireCondition(
    path.basename(sourceInventory.identity.path) === 'source-inventory.json',
    'Expected maintained source inventory path'
  );
  const sourceKeys = [
    'sourceRoot',
    'commit',
    'tree',
    'objectFormat',
    'repoRoot',
    'worktreeName',
    'specId',
  ] as const;
  exactObjectKeys(inventory.source, sourceKeys);
  exactObjectKeys(currentSource, sourceKeys);
  for (const key of sourceKeys)
    requireCondition(
      inventory.source[key] === currentSource[key],
      'Source standing changed before request composition'
    );
  requireOid(currentSource.commit, currentSource.objectFormat);
  requireOid(currentSource.tree, currentSource.objectFormat);
  const sourceTree: ReviewedTree = {
    root: path.join(path.dirname(sourceInventory.identity.path), 'source'),
    files: [],
  };
  normalizedAbsolute(inventory.futureBuildRoot);
  requireCondition(
    Array.isArray(inventory.files) &&
      inventory.files.length > 0 &&
      inventory.files.length <= MAX_OBJECTS,
    'Invalid prepared source inventory count'
  );
  const names = new Set<string>();
  let sourceBytes = 0;
  for (const file of inventory.files) {
    exactObjectKeys(file, [
      'relativePath',
      'sizeBytes',
      'sha256',
      'executable',
      'gitObject',
      'gitMode',
    ]);
    requireCondition(
      preparationSourceDisposition(file.relativePath) === 'include' &&
        !names.has(file.relativePath),
      'Prepared inventory contains an unselected or duplicate source path'
    );
    requireOid(file.gitObject, currentSource.objectFormat);
    requireCondition(
      (file.gitMode === '100644' || file.gitMode === '100755') &&
        file.executable === (file.gitMode === '100755'),
      'Prepared source mode mismatch'
    );
    requireCondition(
      Number.isSafeInteger(file.sizeBytes) &&
        file.sizeBytes >= 0 &&
        file.sizeBytes <= MAX_OBJECT_BYTES &&
        typeof file.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(file.sha256),
      'Invalid prepared file identity'
    );
    sourceBytes += file.sizeBytes;
    requireCondition(sourceBytes <= MAX_BATCH_BYTES, 'Prepared source bytes exceed bound');
    names.add(file.relativePath);
    sourceTree.files.push({
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      executable: file.executable,
    });
  }
  const baseRequest = capturedPreparationJson(baseRecipe) as NativeSqliteBuildRequest;
  nativeSqlitePreparationCustody.validateRequest(baseRequest);
  requireCondition(
    baseRequest.schema === 'caws.native_sqlite_build_request.v2' &&
      baseRequest.profile === 'release',
    'Preparation requires a reviewed v2 release recipe'
  );
  const subtree = (prefix: string): ReviewedTree => ({
    root: path.join(sourceTree.root, prefix),
    files: sourceTree.files
      .filter((file) => file.relativePath.startsWith(`${prefix}/`))
      .map((file) => ({ ...file, relativePath: file.relativePath.slice(prefix.length + 1) })),
  });
  const source = subtree('packages/caws-native');
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    const prior = baseRequest.source.files.find((file) => file.relativePath === name);
    const current = source.files.find((file) => file.relativePath === name);
    requireCondition(
      prior &&
        current &&
        prior.sha256 === current.sha256 &&
        prior.sizeBytes === current.sizeBytes &&
        prior.executable === current.executable,
      `Cargo input changed; review a new dependency recipe: ${name}`
    );
  }
  const clientPath =
    'packages/caws-cli/templates/hook-packs/shared/lib/session-render-service-client.sh';
  const client = sourceTree.files.find((file) => file.relativePath === clientPath);
  requireCondition(client, 'Prepared service client is missing');
  const request = JSON.parse(JSON.stringify(baseRequest)) as NativeSqliteBuildRequest;
  request.source = source;
  request.embedded = {
    serviceClient: {
      path: path.join(sourceTree.root, clientPath),
      sizeBytes: client.sizeBytes,
      sha256: client.sha256,
    },
    serviceImage: subtree('packages/caws-cli/templates/hook-packs/runtime/service-image'),
  };
  request.outputRoot = inventory.futureBuildRoot;
  nativeSqlitePreparationCustody.validateRequest(request);
  return {
    request,
    provenance: {
      sourceInventory: { ...sourceInventory.identity },
      baseRecipe: { ...baseRecipe.identity },
      source: { ...currentSource },
    },
  };
}

/**
 * Materialize the fixed production profile into one exclusive ignored region.
 * This API never launches a build, chooses a tool or grants future build
 * authority. Its injected transports require independent maintained-entry
 * admission. Files use private 0600/0700 modes, preserving Git executability.
 * Custody is checked at operation boundaries; this is not a same-user race
 * sandbox or a hard deadline for stalled filesystem I/O.
 */
export function prepareFrozenProductionSource(
  input: FrozenSourcePreparationRequest,
  context: FrozenSourcePreparationContext
): FrozenSourcePreparationResult {
  let phase = 'request';
  let created = false;
  try {
    context.checkpoint();
    exactObjectKeys(input, ['schema', 'source', 'outputRoot', 'futureBuildRoot']);
    exactObjectKeys(input.source, ['sourceRoot', 'commit', 'tree', 'objectFormat']);
    requireCondition(
      input.schema === 'caws.frozen_source_preparation.v1',
      'Unsupported preparation schema'
    );
    const request: FrozenSourcePreparationRequest = {
      schema: input.schema,
      source: {
        sourceRoot: input.source.sourceRoot,
        commit: input.source.commit,
        tree: input.source.tree,
        objectFormat: input.source.objectFormat,
      },
      outputRoot: input.outputRoot,
      futureBuildRoot: input.futureBuildRoot,
    };
    normalizedAbsolute(request.outputRoot);
    normalizedAbsolute(request.futureBuildRoot);
    requireCondition(
      request.outputRoot !== request.futureBuildRoot &&
        !descendant(request.outputRoot, request.futureBuildRoot) &&
        !descendant(request.futureBuildRoot, request.outputRoot),
      'Preparation and future build roots must be disjoint'
    );
    const sourceRoot = path.join(request.outputRoot, 'source');
    const inventoryPath = path.join(request.outputRoot, 'source-inventory.json');
    const preliminaryWrites = {
      outputRoot: request.outputRoot,
      writePaths: [sourceRoot, inventoryPath],
    };
    phase = 'authority';
    const output = inspectPreparationWriteAuthority(preliminaryWrites, context);
    requireCondition(
      descendant(output.worktreeRoot, request.futureBuildRoot),
      'Future build root must be in the actual worktree; this does not grant build authority'
    );
    nativeSqlitePreparationCustody.realDirectories(path.dirname(request.outputRoot));
    nativeSqlitePreparationCustody.realDirectories(path.dirname(request.futureBuildRoot));
    requireAbsent(request.outputRoot);
    requireAbsent(request.futureBuildRoot);
    const source = inspectPreparationSourceStanding(request.source, context);
    phase = 'objects';
    const plan = collectPreparationProductionSource(
      (selections) => {
        context.checkpoint();
        const bytes = context.readObjects(selections);
        context.checkpoint();
        return bytes;
      },
      source.commit,
      source.tree,
      source.objectFormat
    );
    const sourceTree: ReviewedTree = {
      root: sourceRoot,
      files: plan.files.map((file) => ({
        relativePath: file.relativePath,
        sizeBytes: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        executable: file.mode === '100755',
      })),
    };
    const writes: PreparationWriteSelection = {
      outputRoot: request.outputRoot,
      writePaths: [
        ...preliminaryWrites.writePaths,
        ...plan.directories.map((directory) => path.join(sourceRoot, directory)),
        ...plan.files.map((file) => path.join(sourceRoot, file.relativePath)),
      ],
    };
    const inventoryBytes = Buffer.from(
      JSON.stringify(
        {
          schema: 'caws.frozen_source_inventory.v1',
          adoption: 'NOT_ADOPTED',
          source,
          files: sourceTree.files.map((file, index) => ({
            ...file,
            gitObject: plan.files[index]!.oid,
            gitMode: plan.files[index]!.mode,
          })),
          omitted: plan.omitted,
          futureBuildRoot: request.futureBuildRoot,
          limits: [
            'Input identity and private custody only; no build or installation authority.',
            'Private filesystem modes preserve executability, not the original permission bits.',
            'Point-in-time checks do not exclude same-user races or bound stalled OS I/O.',
          ],
        },
        null,
        2
      ) + '\n'
    );
    requireCondition(
      inventoryBytes.length <= MAX_OBJECT_BYTES,
      'Preparation inventory exceeds metadata bound'
    );
    phase = 'pre-write';
    context.checkpoint();
    inspectPreparationSourceStanding(request.source, context);
    inspectPreparationWriteAuthority(writes, context);
    nativeSqlitePreparationCustody.realDirectories(path.dirname(request.outputRoot));
    requireAbsent(request.outputRoot);
    requireAbsent(request.futureBuildRoot);
    fs.mkdirSync(request.outputRoot, { mode: 0o700 });
    created = true;
    const ownedRoot = fs.lstatSync(request.outputRoot);
    const checkRoot = (): void => {
      context.checkpoint();
      nativeSqlitePreparationCustody.realDirectories(request.outputRoot);
      const current = fs.lstatSync(request.outputRoot);
      requireCondition(
        current.dev === ownedRoot.dev &&
          current.ino === ownedRoot.ino &&
          current.mode === ownedRoot.mode,
        'Preparation root changed during custody'
      );
      requireAbsent(request.futureBuildRoot);
    };
    phase = 'source';
    for (const directory of [
      sourceRoot,
      ...plan.directories.map((relative) => path.join(sourceRoot, relative)),
    ]) {
      checkRoot();
      nativeSqlitePreparationCustody.realDirectories(path.dirname(directory));
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    for (const file of plan.files) {
      checkRoot();
      nativeSqlitePreparationCustody.exclusive(
        path.join(sourceRoot, file.relativePath),
        file.bytes,
        file.mode === '100755'
      );
    }
    phase = 'verify';
    checkRoot();
    nativeSqlitePreparationCustody.inspectTree(sourceTree, false, checkRoot);
    requireCondition(
      fs.readdirSync(request.outputRoot).sort().join('\0') === 'source',
      'Unrepresented preparation root entry'
    );
    inspectPreparationSourceStanding(request.source, context);
    inspectPreparationWriteAuthority(writes, context);
    phase = 'inventory';
    checkRoot();
    nativeSqlitePreparationCustody.exclusive(inventoryPath, inventoryBytes);
    const inventory = nativeSqlitePreparationCustody.fileIdentity(inventoryPath, MAX_OBJECT_BYTES);
    checkRoot();
    requireCondition(
      fs.readdirSync(request.outputRoot).sort().join('\0') ===
        ['source', 'source-inventory.json'].sort().join('\0'),
      'Unrepresented preparation root entry'
    );
    return {
      status: 'prepared',
      adoption: 'NOT_ADOPTED',
      source,
      sourceTree,
      inventory,
      futureBuildRoot: request.futureBuildRoot,
    };
  } catch (error) {
    // Never retry, adopt, remove, or write a failure marker after custody is
    // uncertain. The caller retains this diagnostic and any exclusive output.
    return {
      status: 'failed',
      adoption: 'NOT_ADOPTED',
      writerState: created ? 'RETAINED_UNCERTAIN' : 'NOT_STARTED',
      phase,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
