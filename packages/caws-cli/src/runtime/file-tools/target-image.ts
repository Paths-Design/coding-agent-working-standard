import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import { evaluatePath, matchGlob, SCOPE_RULES } from '../../kernel';
import { matchPrefix } from '../../kernel/scope/match';
import type { NativeFileAuthority } from './authority';
import { originalNativeFileOperation } from './original-operation';

export const MAX_NATIVE_FILE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_DEPTH = 128;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_TOTAL_ENTRIES = 16384;

type Guard =
  | 'native-file-input'
  | 'native-file-target'
  | 'protected-paths.sh'
  | 'worktree-write-guard.sh'
  | 'scope-guard.sh';

export class NativeFileTargetError extends Error {
  constructor(
    readonly guard: Guard,
    readonly reason: string
  ) {
    super(`Native file target refused: ${guard}/${reason}`);
    this.name = 'NativeFileTargetError';
  }
}

export interface NativeFileTargetInput {
  readonly payload: unknown;
  readonly authority: NativeFileAuthority;
  /**
   * Authenticated original payload.cwd, or original RuntimeRequest.caller.cwd
   * when payload.cwd is absent. Never process.cwd(), PWD or tool_input.cwd.
   */
  readonly sessionCwd: string;
  readonly home: string;
  readonly machineHome: string;
  readonly checkpoint: () => void;
}

interface TargetBinding {
  readonly target: string;
  readonly relativePath: string;
  readonly originalSessionId: string;
  readonly authorityRevision: string;
  /**
   * Revalidates this image's original input and filesystem facts only.
   * GuardPlan must separately call authority.assertCurrent(deliveredContext3).
   */
  assertCurrent(): void;
}

export interface NativeFileTargetImage extends TargetBinding {
  readonly kind: 'admitted';
  /** Semantic operation classified from the retained original surface/tool pair. */
  readonly originalTool: 'Write' | 'Edit';
  readonly preimage: string | null;
  readonly proposedContent: string;
}

export interface NativeFileScopeMiss extends TargetBinding {
  readonly kind: 'scope-miss';
  readonly guard: 'scope-guard.sh';
  readonly reason: 'scope_in_miss' | 'root_not_allowed';
  readonly rule: string;
}

export type NativeFileTargetResult = NativeFileTargetImage | NativeFileScopeMiss;

interface ParsedInput {
  readonly tool: 'Write' | 'Edit';
  readonly filePath: string;
  readonly content: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
  readonly key: string;
}

interface DiskFile {
  readonly bytes: Buffer;
  readonly identity: string;
  readonly sha256: string;
}

interface DirectoryImage {
  readonly path: string;
  readonly identity: string;
  readonly names: readonly string[];
}

interface DiskState {
  readonly directories: readonly string[];
  readonly file: DiskFile | null;
}

function refuse(guard: Guard, reason: string): never {
  throw new NativeFileTargetError(guard, reason);
}
function need(value: unknown, guard: Guard, reason: string): asserts value {
  if (!value) refuse(guard, reason);
}
function object(value: unknown): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor && !descriptor.get && !descriptor.set;
  });
}
function inputString(value: unknown, maximum: number): string {
  need(typeof value === 'string', 'native-file-input', 'invalid_text');
  need(!value.includes('\0'), 'native-file-input', 'nul_input');
  need(Buffer.from(value, 'utf8').toString('utf8') === value, 'native-file-input', 'invalid_utf8');
  need(Buffer.byteLength(value) <= maximum, 'native-file-input', 'input_too_large');
  return value;
}
function absolutePath(value: unknown, reason: string): string {
  const text = inputString(value, MAX_PATH_BYTES);
  need(
    text.length > 0 &&
      isAbsolute(text) &&
      normalize(text) === text &&
      (text === '/' || !text.endsWith('/')),
    'native-file-input',
    reason
  );
  return text;
}
function inside(root: string, file: string): boolean {
  return file === root || file.startsWith(root === '/' ? '/' : root + '/');
}
function fold(value: string): string {
  // Conservatively reject Unicode normalization/case aliases as well.
  return value.normalize('NFC').toUpperCase().toLowerCase();
}
function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function statKey(stat: fs.BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}
function diskText(bytes: Buffer, reason: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse('native-file-target', reason);
  }
  need(
    !text.includes('\0') && Buffer.from(text, 'utf8').equals(bytes),
    'native-file-target',
    reason
  );
  return text;
}
function parseInput(
  payload: unknown,
  authority: NativeFileAuthority,
  sessionCwd: string
): ParsedInput {
  need(object(payload), 'native-file-input', 'invalid_payload');
  need(
    payload.session_id === authority.originalSessionId,
    'native-file-input',
    'original_session_mismatch'
  );
  need(
    !Object.hasOwn(payload, 'cwd') || payload.cwd === sessionCwd,
    'native-file-input',
    'session_cwd_mismatch'
  );
  const operation = originalNativeFileOperation(authority.surface, payload.tool_name);
  need(operation !== null, 'native-file-input', 'unsupported_tool');
  const tool = operation === 'write' ? 'Write' : 'Edit';
  const input = payload.tool_input;
  need(object(input), 'native-file-input', 'invalid_tool_input');
  const required =
    tool === 'Write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string'];
  const allowed = tool === 'Write' ? required : [...required, 'replace_all'];
  need(
    required.every((key) => Object.hasOwn(input, key)) &&
      Reflect.ownKeys(input).every((key) => typeof key === 'string' && allowed.includes(key)),
    'native-file-input',
    'invalid_tool_input'
  );

  const filePath = inputString(input.file_path, MAX_PATH_BYTES);
  if (authority.surface === 'qwen-code')
    need(
      isAbsolute(filePath) && filePath === filePath.trim(),
      'native-file-input',
      'qwen_requires_absolute_stable_path'
    );
  need(filePath.length > 0, 'native-file-input', 'invalid_file_path');
  const components = (isAbsolute(filePath) ? filePath.slice(1) : filePath).split('/');
  need(
    !filePath.includes('\\') &&
      components.length <= MAX_DEPTH &&
      components.every((part) => part !== '' && part !== '.' && part !== '..'),
    'native-file-input',
    'invalid_file_path'
  );

  const content = tool === 'Write' ? inputString(input.content, MAX_NATIVE_FILE_IMAGE_BYTES) : '';
  const oldString =
    tool === 'Edit' ? inputString(input.old_string, MAX_NATIVE_FILE_IMAGE_BYTES) : '';
  const newString =
    tool === 'Edit' ? inputString(input.new_string, MAX_NATIVE_FILE_IMAGE_BYTES) : '';
  if (tool === 'Edit') {
    need(oldString.length > 0, 'native-file-input', 'edit_empty_old');
    need(
      !Object.hasOwn(input, 'replace_all') || typeof input.replace_all === 'boolean',
      'native-file-input',
      'invalid_replace_all'
    );
  }
  const replaceAll = tool === 'Edit' && input.replace_all === true;
  return {
    tool,
    filePath,
    content,
    oldString,
    newString,
    replaceAll,
    key: JSON.stringify({
      tool,
      filePath,
      content,
      oldString,
      newString,
      replaceAll,
      keys: Object.keys(input).sort(),
      sessionId: payload.session_id,
      hasCwd: Object.hasOwn(payload, 'cwd'),
      cwd: payload.cwd,
    }),
  };
}

// Current vendor directories from surfaces/registry.json and agent-surface.sh.
const VENDORS = new Set([
  '.claude',
  '.codex',
  '.opencode',
  '.zcode',
  '.kimi-code',
  '.qwen',
  '.dsh',
  '.cursor',
  '.windsurf',
]);

// Native registration paths read by hook-inspection-route/hook-install.
const REGISTRATION: Readonly<Record<string, readonly string[]>> = {
  '.claude': ['settings.json', 'settings.local.json', 'config.toml'],
  '.codex': ['hooks.json', 'settings.local.json', 'config.toml'],
  '.qwen': ['settings.json'],
  '.zcode': ['config.json'],
  '.kimi-code': ['config.toml'],
};

function vendorProtection(vendor: string, rest: readonly string[], target: string): string | null {
  if (VENDORS.has(vendor)) {
    if (rest.length === 1 && REGISTRATION[vendor]?.includes(rest[0]!)) return 'native_registration';
    if (
      rest[0] === 'logs' &&
      rest.some((part) => /^(?:guard-strikes-|danger-latch-|guard-reprieve-)/.test(part))
    )
      return 'guard_state';
    if (vendor === '.opencode' && rest[0] === 'plugins') return 'hook_artifact';
  }
  if (vendor === '.caws' || VENDORS.has(vendor)) {
    if (rest[0] === 'hooks') {
      if (
        rest
          .slice(1)
          .some(
            (part) =>
              part === 'state' ||
              part === '.state' ||
              /^(?:guard-strikes-|danger-latch-|guard-reprieve-)/.test(part)
          )
      )
        return 'guard_state';
      // Documentation is not an admission. Ownership and scope still run.
      return target.endsWith('.md') ? null : 'hook_artifact';
    }
    if (vendor === '.caws') return 'authority_state';
  }
  return null;
}

function protectedReason(
  target: string,
  authority: NativeFileAuthority,
  home: string,
  machineHome: string,
  checkpoint: () => void
): string | null {
  const file = fold(target);
  if (file.split('/').includes('.git')) return 'git_metadata';

  if (inside(fold(machineHome), file)) {
    const rel = file.slice(fold(machineHome).length).replace(/^\//, '');
    if (
      rel === '' ||
      ['bin', 'lib', 'surfaces', 'state'].some(
        (prefix) => rel === prefix || rel.startsWith(prefix + '/')
      )
    )
      return 'machine_runtime';
  }

  // User-layer registrations and hooks retain their role even when a real
  // repository is rooted inside their directory. Repository placement cannot
  // hide the exact paths that the installed harness reads from HOME.
  for (const vendor of VENDORS) {
    checkpoint();
    const root = fold(join(home, vendor));
    if (!inside(root, file)) continue;
    const rest = file.slice(root.length).replace(/^\//, '').split('/');
    const reason = vendorProtection(vendor, rest, target);
    if (reason) return reason;
  }

  // A managed checkout's ancestors can include another project's .caws.
  // Reserved names describe this actual project domain, not those ancestors.
  // Domain selection only classifies protection; ownership still runs below.
  const livePaths = new Set<string>();
  for (const row of Object.values(authority.registry)) {
    checkpoint();
    const status = (row as { readonly status?: unknown }).status;
    if (status !== 'destroyed' && status !== 'missing') {
      need(typeof row.path === 'string', 'worktree-write-guard.sh', 'foreign_claim_unresolved');
      livePaths.add(row.path);
    }
  }
  const canonicalState = fold(join(authority.canonical, '.caws'));
  const canonicalPayload = fold(join(authority.canonical, '.caws/worktrees'));
  let domain = '';
  for (const root of [home, authority.canonical, authority.checkout, ...livePaths]) {
    checkpoint();
    const candidate = fold(root);
    if (
      inside(canonicalState, candidate) &&
      !(
        candidate !== canonicalPayload &&
        inside(canonicalPayload, candidate) &&
        livePaths.has(root)
      )
    )
      continue;
    if (candidate.length > domain.length && inside(candidate, file)) domain = candidate;
  }
  const parts = domain ? file.slice(domain.length).replace(/^\//, '').split('/') : [];
  for (let index = 0; index < parts.length; index++) {
    checkpoint();
    const vendor = parts[index]!;
    const rest = parts.slice(index + 1);
    const reason = vendorProtection(vendor, rest, target);
    if (reason) return reason;
  }

  for (const root of [authority.checkout, authority.canonical]) {
    if (['opencode.json', 'opencode.jsonc'].some((name) => file === fold(join(root, name))))
      return 'native_registration';
  }
  for (const root of [join(home, '.opencode'), join(home, '.config/opencode')]) {
    if (
      ['config.json', 'opencode.json', 'opencode.jsonc'].some(
        (name) => file === fold(join(root, name))
      ) ||
      inside(fold(join(root, 'plugins')), file)
    )
      return 'native_registration';
  }
  for (const vendor of VENDORS) {
    const root = fold(join(home, vendor));
    if (
      ['projects', 'sessions', 'state', 'logs', 'cache'].some((name) =>
        inside(join(root, name), file)
      )
    )
      return 'operational_state';
  }
  return null;
}

function proposedEdit(preimage: Buffer, input: ParsedInput, checkpoint: () => void): string {
  const old = Buffer.from(input.oldString, 'utf8');
  const replacement = Buffer.from(input.newString, 'utf8');
  const first = preimage.indexOf(old);
  need(first >= 0, 'native-file-input', 'edit_missing_match');
  if (!input.replaceAll) {
    const second = preimage.indexOf(old, first + 1);
    need(
      second < 0,
      'native-file-input',
      second >= 0 && second < first + old.length ? 'edit_overlap' : 'edit_ambiguous'
    );
  }
  let count = 0;
  let cursor = 0;
  for (;;) {
    checkpoint();
    const at = preimage.indexOf(old, cursor);
    if (at < 0) break;
    count++;
    cursor = at + old.length;
    need(
      preimage.length + count * (replacement.length - old.length) <= MAX_NATIVE_FILE_IMAGE_BYTES,
      'native-file-input',
      'postimage_too_large'
    );
    if (!input.replaceAll) break;
  }
  const length = preimage.length + count * (replacement.length - old.length);
  need(
    length >= 0 && length <= MAX_NATIVE_FILE_IMAGE_BYTES,
    'native-file-input',
    'postimage_too_large'
  );
  const output = Buffer.alloc(length);
  cursor = 0;
  let written = 0;
  for (let index = 0; index < count; index++) {
    checkpoint();
    const at = preimage.indexOf(old, cursor);
    need(at >= cursor, 'native-file-input', 'edit_image_changed');
    written += preimage.copy(output, written, cursor, at);
    written += replacement.copy(output, written);
    cursor = at + old.length;
  }
  written += preimage.copy(output, written, cursor);
  need(written === length, 'native-file-input', 'edit_image_changed');
  checkpoint();
  return diskText(output, 'invalid_postimage_utf8');
}

export function captureNativeFileTargetImage(input: NativeFileTargetInput): NativeFileTargetResult {
  need(typeof input.checkpoint === 'function', 'native-file-input', 'missing_checkpoint');
  const checkpoint = input.checkpoint;
  checkpoint();
  need(
    ['darwin', 'linux'].includes(process.platform) &&
      typeof process.geteuid === 'function' &&
      typeof fs.constants.O_NOFOLLOW === 'number' &&
      typeof fs.constants.O_DIRECTORY === 'number',
    'native-file-target',
    'unsupported_filesystem_profile'
  );
  const uid = BigInt(process.geteuid!());
  const authority = input.authority;
  need(
    ['claude-code', 'qwen-code'].includes(authority?.surface) &&
      ['bound', 'bridged'].includes(authority.binding.kind),
    'scope-guard.sh',
    'no_authority'
  );
  const root = absolutePath(authority.ownedRoot, 'invalid_owned_root');
  const checkout = absolutePath(authority.checkout, 'invalid_checkout');
  const sessionCwd = absolutePath(input.sessionCwd, 'invalid_session_cwd');
  const home = absolutePath(input.home, 'invalid_home');
  const machineHome = absolutePath(input.machineHome, 'invalid_machine_home');
  need(home !== '/' && machineHome !== '/', 'native-file-input', 'invalid_home');
  const payload = input.payload;
  const parsed = parseInput(payload, authority, sessionCwd);
  const target = isAbsolute(parsed.filePath) ? parsed.filePath : join(sessionCwd, parsed.filePath);
  need(Buffer.byteLength(target) <= MAX_PATH_BYTES, 'native-file-input', 'invalid_file_path');
  const protection = protectedReason(target, authority, home, machineHome, checkpoint);
  if (protection) refuse('protected-paths.sh', protection);

  need(
    inside(root, sessionCwd) && inside(checkout, sessionCwd),
    'worktree-write-guard.sh',
    'session_cwd_outside'
  );

  function io<T>(
    operation: () => T,
    reason = 'filesystem_unavailable',
    guard: Guard = 'native-file-target'
  ): T {
    checkpoint();
    let result: T;
    try {
      result = operation();
    } catch (error) {
      if (error instanceof NativeFileTargetError) throw error;
      return refuse(guard, reason);
    }
    checkpoint();
    return result;
  }

  function openRead(file: string, flags: number): number {
    checkpoint();
    let fd: number;
    try {
      fd = fs.openSync(file, flags);
    } catch {
      return refuse('native-file-target', 'filesystem_unavailable');
    }
    try {
      checkpoint();
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  function ownership(): void {
    for (const row of Object.values(authority.registry)) {
      checkpoint();
      const status = (row as { readonly status?: unknown }).status;
      if (status === 'destroyed' || status === 'missing') continue;
      need(typeof row.path === 'string', 'worktree-write-guard.sh', 'foreign_claim_unresolved');
      if (row.path !== root && inside(row.path, target))
        refuse('worktree-write-guard.sh', 'foreign_worktree');
    }
    if (!inside(authority.canonical, target)) return;
    const canonicalPath = relative(authority.canonical, target);
    for (const spec of authority.specs) {
      checkpoint();
      if (spec.lifecycle_state !== 'active' || spec.id === authority.binding.spec.id) continue;
      let claimed = false;
      if (spec.worktree) {
        const row = authority.registry[spec.worktree];
        need(
          row && row.specId === spec.id && typeof row.path === 'string',
          'worktree-write-guard.sh',
          'foreign_claim_unresolved'
        );
        const path = row.path;
        const before = io(
          () => fs.lstatSync(path, { bigint: true }),
          'foreign_claim_unresolved',
          'worktree-write-guard.sh'
        );
        need(
          before.isDirectory() &&
            !before.isSymbolicLink() &&
            io(
              () => fs.realpathSync.native(path),
              'foreign_claim_unresolved',
              'worktree-write-guard.sh'
            ) === path &&
            statKey(before) ===
              statKey(
                io(
                  () => fs.lstatSync(path, { bigint: true }),
                  'foreign_claim_unresolved',
                  'worktree-write-guard.sh'
                )
              ),
          'worktree-write-guard.sh',
          'foreign_claim_unresolved'
        );
        claimed = true;
      } else {
        const bridge = authority.bridges[spec.id];
        claimed = Boolean(bridge && bridge.session_id !== authority.originalSessionId);
      }
      if (claimed && matchGlob(canonicalPath, spec.scope.in) !== null)
        refuse('worktree-write-guard.sh', 'foreign_claim');
    }
  }

  ownership();
  need(target !== root && inside(root, target), 'worktree-write-guard.sh', 'outside_owned_root');
  const relativePath = relative(root, target);
  if (matchPrefix(relativePath, authority.binding.spec.scope.out ?? []) !== null)
    refuse('scope-guard.sh', 'scope_out');
  const decision = evaluatePath(relativePath, authority.binding, authority.policy);
  const scopeMiss =
    decision.kind === 'reject' &&
    [SCOPE_RULES.REJECT_SCOPE_IN_MISS, SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED].includes(
      decision.rule as
        | typeof SCOPE_RULES.REJECT_SCOPE_IN_MISS
        | typeof SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED
    );
  need(
    decision.kind === 'admit' || scopeMiss,
    'scope-guard.sh',
    decision.kind === 'no_authority' ? 'no_authority' : 'scope_refused'
  );

  function state(): DiskState {
    let entryCount = 0;
    let nameBytes = 0;
    const directories = new Map<string, DirectoryImage>();
    function directory(path: string): DirectoryImage {
      const cached = directories.get(path);
      if (cached) return cached;
      const before = io(() => fs.lstatSync(path, { bigint: true }), 'parent_missing');
      need(!before.isSymbolicLink(), 'native-file-target', 'aliased_parent');
      need(before.isDirectory(), 'native-file-target', 'non_directory_parent');
      need(
        before.uid === uid && (before.mode & 0o022n) === 0n && (before.mode & 0o7000n) === 0n,
        'native-file-target',
        'unsafe_parent'
      );
      need((before.mode & 0o700n) === 0o700n, 'native-file-target', 'permission_denied');
      need(io(() => fs.realpathSync.native(path)) === path, 'native-file-target', 'aliased_parent');
      io(
        () => fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK),
        'permission_denied'
      );
      const fd = openRead(
        path,
        fs.constants.O_RDONLY |
          fs.constants.O_DIRECTORY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK
      );
      let names: string[];
      try {
        need(
          statKey(io(() => fs.fstatSync(fd, { bigint: true }))) === statKey(before),
          'native-file-target',
          'parent_changed'
        );
        const entries = io(() => fs.readdirSync(path, { encoding: 'buffer' }));
        entryCount += entries.length;
        need(
          entries.length <= MAX_DIRECTORY_ENTRIES && entryCount <= MAX_TOTAL_ENTRIES,
          'native-file-target',
          'directory_inventory_bound'
        );
        names = entries.map((entry) => {
          checkpoint();
          nameBytes += entry.length;
          need(
            nameBytes <= MAX_NATIVE_FILE_IMAGE_BYTES,
            'native-file-target',
            'directory_inventory_bound'
          );
          return diskText(entry, 'invalid_directory_utf8');
        });
        need(
          statKey(io(() => fs.fstatSync(fd, { bigint: true }))) === statKey(before) &&
            statKey(io(() => fs.lstatSync(path, { bigint: true }))) === statKey(before),
          'native-file-target',
          'parent_changed'
        );
      } finally {
        fs.closeSync(fd);
      }
      if (path !== root && names.some((name) => fold(name) === '.git'))
        refuse('worktree-write-guard.sh', 'nested_repository');
      const result = { path, identity: statKey(before), names: names.sort() };
      directories.set(path, result);
      return result;
    }
    function spelling(parent: DirectoryImage, name: string, allowAbsent: boolean): boolean {
      const aliases = parent.names.filter((entry) => fold(entry) === fold(name));
      need(
        aliases.length <= 1 && (aliases.length === 0 || aliases[0] === name),
        'native-file-target',
        'ambiguous_case'
      );
      need(allowAbsent || aliases.length === 1, 'native-file-target', 'parent_missing');
      return aliases.length === 1;
    }
    function walk(path: string): DirectoryImage {
      const rel = relative(root, path);
      const parts = rel === '' ? [] : rel.split('/');
      need(parts.length <= MAX_DEPTH, 'native-file-target', 'path_depth_bound');
      let current = directory(root);
      for (const part of parts) {
        checkpoint();
        spelling(current, part, false);
        current = directory(join(current.path, part));
      }
      return current;
    }

    walk(sessionCwd);
    const parent = walk(dirname(target));
    const expectedPresent = spelling(parent, basename(target), true);
    let named: fs.BigIntStats | null;
    checkpoint();
    try {
      named = fs.lstatSync(target, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return refuse('native-file-target', 'filesystem_unavailable');
      named = null;
    }
    checkpoint();
    need(expectedPresent === (named !== null), 'native-file-target', 'target_changed');

    let file: DiskFile | null = null;
    if (named !== null) {
      need(!named.isSymbolicLink(), 'native-file-target', 'symlink');
      need(named.isFile(), 'native-file-target', 'nonregular_file');
      need(named.nlink === 1n, 'native-file-target', 'hardlink');
      need(
        named.uid === uid && (named.mode & 0o022n) === 0n && (named.mode & 0o7000n) === 0n,
        'native-file-target',
        'unsafe_file'
      );
      need((named.mode & 0o600n) === 0o600n, 'native-file-target', 'permission_denied');
      need(
        named.size <= BigInt(MAX_NATIVE_FILE_IMAGE_BYTES),
        'native-file-target',
        'preimage_too_large'
      );
      io(() => fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK), 'permission_denied');
      const fd = openRead(
        target,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      try {
        need(
          statKey(io(() => fs.fstatSync(fd, { bigint: true }))) === statKey(named!),
          'native-file-target',
          'target_changed'
        );
        const bytes = Buffer.alloc(Number(named.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = io(() => fs.readSync(fd, bytes, length, bytes.length - length, length));
          if (count === 0) break;
          length += count;
        }
        need(
          BigInt(length) === named.size &&
            statKey(io(() => fs.fstatSync(fd, { bigint: true }))) === statKey(named) &&
            statKey(io(() => fs.lstatSync(target, { bigint: true }))) === statKey(named),
          'native-file-target',
          'target_changed'
        );
        const captured = bytes.subarray(0, length);
        diskText(captured, 'invalid_preimage_utf8');
        file = { bytes: captured, identity: statKey(named), sha256: sha(captured) };
        checkpoint();
      } finally {
        fs.closeSync(fd);
      }
    }
    return {
      directories: [...directories.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) =>
          JSON.stringify([
            entry.path,
            entry.identity,
            sha(Buffer.from(JSON.stringify(entry.names))),
          ])
        ),
      file,
    };
  }

  const original = state();
  const preimage =
    original.file === null ? null : diskText(original.file.bytes, 'invalid_preimage_utf8');
  if (parsed.tool === 'Edit')
    need(original.file !== null, 'native-file-input', 'edit_missing_file');
  const proposedContent =
    parsed.tool === 'Write'
      ? parsed.content
      : proposedEdit(original.file!.bytes, parsed, checkpoint);

  function assertCurrent(): void {
    checkpoint();
    need(
      input.payload === payload &&
        input.authority === authority &&
        input.sessionCwd === sessionCwd &&
        input.home === home &&
        input.machineHome === machineHome &&
        parseInput(input.payload, authority, sessionCwd).key === parsed.key,
      'native-file-input',
      'input_changed'
    );
    need(BigInt(process.geteuid!()) === uid, 'native-file-target', 'permission_changed');
    ownership();
    const current = state();
    need(
      (original.file === null && current.file === null) ||
        (original.file !== null &&
          current.file !== null &&
          original.file.identity === current.file.identity &&
          original.file.sha256 === current.file.sha256 &&
          original.file.bytes.equals(current.file.bytes)),
      'native-file-target',
      'target_changed'
    );
    need(
      JSON.stringify(original.directories) === JSON.stringify(current.directories),
      'native-file-target',
      'parent_changed'
    );
    checkpoint();
  }

  assertCurrent();
  const binding = {
    target,
    relativePath,
    originalSessionId: authority.originalSessionId,
    authorityRevision: authority.revision,
    assertCurrent,
  };
  if (scopeMiss)
    return Object.freeze({
      ...binding,
      kind: 'scope-miss' as const,
      guard: 'scope-guard.sh' as const,
      reason:
        decision.rule === SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED
          ? ('root_not_allowed' as const)
          : ('scope_in_miss' as const),
      rule: decision.rule,
    });
  return Object.freeze({
    ...binding,
    kind: 'admitted' as const,
    originalTool: parsed.tool,
    preimage,
    proposedContent,
  });
}
