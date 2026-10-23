import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import type { RuntimeRequest } from './protocol';
import type { ActiveInvocationSelection, SelectedHandler } from './selection';
import {
  SERVICE_ADAPTER,
  readServiceGrantFd,
  renderServiceClientShell,
  serviceGrantDigest,
  type ServiceRenderGrant,
} from './service-client';

export const SERVICE_IMAGE_SCHEMA = 'caws.service.render.image.v1' as const;
export const SERVICE_IMAGE_PROFILE = 'sterling-session-log-codex-stop-v1' as const;
export const SERVICE_IMAGE_ADMISSION_SCHEMA = 'caws.service.render.admission.v1' as const;
const PREPARED_SCHEMA = 'caws.service.prepared.image.v1' as const;
const MAX_FILES = 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const FILE_MODE = 0o555;
const DIRECTORY_MODE = 0o500;
const MANIFEST_MODE = 0o400;

export const SERVICE_IMAGE_TOOLS = Object.freeze([
  'awk',
  'basename',
  'bash',
  'cat',
  'caws',
  'cp',
  'cut',
  'date',
  'dirname',
  'find',
  'git',
  'grep',
  'head',
  'jq',
  'mkdir',
  'mktemp',
  'node',
  'pgrep',
  'ps',
  'python3',
  'readlink',
  'rm',
  'sed',
  'sh',
  'sleep',
  'sort',
  'stat',
  'tail',
  'tr',
  'wc',
] as const);
/** Optional tools are sealed only when explicitly pinned; they never relax the base set. */
export const SERVICE_IMAGE_OPTIONAL_TOOLS = Object.freeze(['cmp', 'iconv'] as const);
/** Optional owner-configured native helper; never resolved through caller PATH. */
export const SERVICE_IMAGE_PLAN_TOOL = 'caws-native' as const;
export const SERVICE_IMAGE_TEMPLATES = Object.freeze([
  'caws.sh',
  'codex-parser-runtime.sh',
  'dispatch.sh',
  'execute-handler.sh',
  'git.sh',
  'handler-env.sh',
  'handler-routes.sh',
  'libraries.sh',
  'parse-input.sh',
  'plan-transcript-finalize.sh',
  'tool.sh',
] as const);

/** Reviewed original source profile. These are not hashes of the adapted image. */
export const STERLING_SESSION_SOURCE_PROFILE: Readonly<Record<string, string>> = Object.freeze({
  'session-log.sh': 'b51e147dada255a3eecf3676956428e7f404611b8c3333fc41b215b2db9fa099',
  'session_log_renderer.py': '156197775e1b79fa0d74d95c856beedce5b501d66945941ab21b01380f98be39',
  'session_log_daemon.py': '7f03eaa578b7336ebbf5c872630c14d04df7012c7f1d082e431ec3ed3d856a63',
  'runtime-paths.sh': '396b13bad3d34be89f8719e56662de18ccfe85c2b9ce15c4905778449e876325',
  'lib/agent-pid.sh': 'c7857c7d1e3ebf9a13feaefebc0f13a58e8b16a35f140db666f1609b86ac7fe9',
  'lib/agent-surface.sh': '8e70aaf8c1ef334d4f8cce08f0030ecc512610feaf3b04ba8c0d32ee1dc9fe36',
  'lib/bash-mutation-targets.sh':
    '31b3eed7c5d650b3fdaa33c0f6d5cfb529b08b27387afafcd1e79e86d7579250',
  'lib/caws-state.sh': '305a671e75b8e7aed6a6e7e14b1a790338c6a05a76887f519e2ab0e3c2d4fdf7',
  'lib/emit.sh': 'f2098113d5133b1da7c06910a313a26811456fdf47f683e58c62ddfa1cacd5f4',
  'lib/guard-message.sh': '39bb7658443ab8bee62ca493ce278f31de20dfa0a9c5f08ac766ffb6df01d8b9',
  'lib/harness_claude.py': 'f2957c64267973ef93871010592e646357b0f111c4c80ef7ab2fb6f2286a1106',
  'lib/harness_codex.py': '0d706f7b3c011748648da72a2b1c7d7a7483f97a7ee68e84d9a7dc6c2c204618',
  'lib/harness_common.py': '588123f740fd2d651552d72143bc41f6afc1e9d73786271e9a63e8f159d052d9',
  'lib/harness_dsh.py': 'ea729e888fa293ed56690953aa4aa6d7ab357dc428cf5b8d3ec355103a020277',
  'lib/harness_opencode.py': 'dee130fa802a469568f9b79767fe1b44ed646faa24af211f4ca45d013fc88320',
  'lib/harness_qwen.py': 'b2ea715d658062da563cca71821035195c66ebc87bab49f568bad1068231ffd4',
  'lib/harness_zcode.py': '1a3bbad7ed8eb62bb21adb667f272a0e4aed1c270089902f4a4592baa43fa326',
  'lib/heredoc.sh': '34639f74e3ce55c17009ec8be3627029aa072d6e698ef215712423bd9b674b98',
  'lib/opencode-transcript.py': '97c01342baa6094a512c70598f97d1d761205445531b482b452562b55ddb9283',
  'lib/parse-input.sh': 'fa014098b03d39541590d67909569cf99781a1dff53bb06fd393e3e8c214adf7',
  'lib/reprieve.sh': '772c43f82a80688bfb9592eea1f88700fd161d9dc99bcf47f78fb6538b38d19b',
  'lib/run-handlers.sh': '3279fd826435f1dccc37de690446938415f33901d2bc98325273a390604d7f8b',
  'lib/session-id.sh': 'e3a4c15325016892b4448c4bbbeee8bd8560f3b1b2a2bb7848f985cb3832d3e6',
  'lib/session-log-daemon-client.sh':
    '84abf3a80c95eeb637bebac87974b90e83200263e81b62e17685f5982713adc5',
  'lib/surfaces-registry.sh': 'f88ef9ee4b527dffcec411e4ab7630fd4bd8512d47ace083778e210e422c0644',
  'lib/worktree-claim-oracle.cjs':
    '4b29d09d8d3c357963fa1028aa1797fea174d6b4814653f921d4645f773fea23',
  'lib/write-allowlist.sh': '4f72b71c8d4d9a859ce5dbe237c1823543e2ac4db156afefbb52901e37a7cfb6',
  'lib/zcode-transcript.py': '8edc4cc4ec9185bd4ce4babb4aab14fc9a09ebe0c1c784ae45b62f6f89b358b3',
});

export interface ServiceToolPin {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}
interface SourceRow {
  readonly origin: 'client' | 'project' | 'runtime';
  readonly path: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}
interface SelectedImageLibrary {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly kind: 'surface' | 'shared';
}
interface ImageSelection {
  readonly canonicalProject: string;
  readonly surface: 'codex';
  readonly event: 'stop';
  readonly configuration: 'system';
  readonly runtimeDigest: string;
  readonly selectedIndex: number;
  readonly handlers: readonly SelectedHandler[];
  readonly libraries: readonly SelectedImageLibrary[];
}
interface ImageFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: 365;
}
export interface ServiceImageManifest {
  readonly schema: typeof SERVICE_IMAGE_SCHEMA;
  readonly adapter: typeof SERVICE_ADAPTER;
  readonly profile: typeof SERVICE_IMAGE_PROFILE;
  readonly selection: ImageSelection;
  readonly originalClosure: readonly SourceRow[];
  readonly originalClosureDigest: string;
  readonly sourceGeneration: string;
  readonly execution: {
    readonly root: string;
    readonly dispatcher: 'runtime/dispatch.sh';
    readonly hooks: 'hooks';
    readonly client: 'client/service-client.js';
    readonly handlerRoutes: readonly {
      readonly selectedIndex: number;
      readonly entry: string;
      readonly originalPath: string;
      readonly originalSha256: string;
      readonly executionRelative: string;
    }[];
    readonly resolvedLibraries: readonly {
      readonly name: string;
      readonly originalPath: string;
      readonly originalSha256: string;
      readonly executionRelative: string;
    }[];
    readonly files: readonly ImageFile[];
  };
  readonly toolchainTcb: {
    readonly tools: readonly ServiceToolPin[];
    readonly pythonFlags: readonly ['-I', '-S', '-B'];
    /**
     * Explicit interim TCB: system interpreters/loaders/stdlib/OS libraries and
     * the versioned CAWS authority CLI package/dependencies. Pinning entry
     * files is not a claim that this entire TCB has been hashed.
     */
    readonly systemDependencies: 'trusted-not-hash-complete';
  };
}
export interface PublishedServiceImage {
  readonly imageKey: string;
  readonly imageDigest: string;
  readonly manifest: ServiceImageManifest;
}
export interface PreparedServiceImage extends PublishedServiceImage {
  readonly schema: typeof PREPARED_SCHEMA;
  /** Native alone publishes this stage atomically without replacing a target. */
  readonly stagingRoot: string | null;
}
export interface PrepareServiceImageOptions {
  readonly selection: ActiveInvocationSelection;
  readonly selectedIndex: number;
  readonly imageParent: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly toolchain: readonly ServiceToolPin[];
  /** Trusted versioned distribution's dist/runtime directory. */
  readonly clientDirectory: string;
  /** Trusted package templates/hook-packs/runtime/service-image directory. */
  readonly templateDirectory: string;
  readonly clientShellPath: string;
}
/**
 * Internal native-issued input only. This TypeScript type and the validation
 * below do not issue a grant, prove authority, publish an image, or attest FD
 * access rights. Root wires it only after native admission.
 */
export interface NativeRenderAdmission {
  readonly schema: typeof SERVICE_IMAGE_ADMISSION_SCHEMA;
  readonly grant: ServiceRenderGrant;
  readonly image: PublishedServiceImage;
  readonly descriptors: {
    readonly transport: number;
    readonly grant: number;
    readonly receipt: number;
  };
  readonly gitDirectory: string;
  readonly gitWorkTree: string;
  readonly gitOriginalDirectory: string;
  readonly gitCommonDirectory: string;
}
export interface AdmittedServiceExecution {
  readonly dispatcher: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly descriptors: readonly [number, number, number];
  /** Idempotent; ownership of parent copies transfers to this execution. */
  close(): void;
}

function fail(reason: string): never {
  throw new Error('Invalid session render image: ' + reason);
}
const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function absolute(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    Buffer.byteLength(value) > 4096 ||
    /[\0\r\n]/.test(value) ||
    Buffer.from(value).toString('utf8') !== value
  )
    fail('noncanonical path');
  return value;
}
function relativeFile(value: string): string {
  if (
    !/^[A-Za-z0-9_.@/-]+$/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('invalid relative file');
  return value;
}
export function quoteServiceImageLiteral(value: string): string {
  if (
    typeof value !== 'string' ||
    /[\0\r\n]/.test(value) ||
    Buffer.from(value).toString('utf8') !== value
  )
    fail('invalid shell literal');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
/** Expand only original markers, never marker-looking bytes inserted as data. */
export function expandServiceImageTemplate(
  template: string,
  values: Readonly<Record<string, string>>
): string {
  const pattern = /__CAWS_IMAGE_[A-Z_]+__/g;
  const markers = [...template.matchAll(pattern)].map((match) => match[0]);
  if (
    Object.keys(values).length !== markers.length ||
    new Set(markers).size !== markers.length ||
    markers.some((marker) => !Object.hasOwn(values, marker))
  )
    fail('template markers');
  return template.replace(pattern, (marker) => values[marker]!);
}
function text(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('invalid source UTF-8');
  }
}
function noSymlinks(target: string): void {
  absolute(target);
  let cursor = '/';
  for (const part of target.slice(1).split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('symlink source or image');
  }
}
function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function readRegular(file: string, maximum = MAX_FILE_BYTES): Buffer {
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maximum || !Number.isSafeInteger(before.size))
      fail('source file envelope');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('short source read');
      offset += count;
    }
    if (!sameFile(before, fs.fstatSync(fd))) fail('source changed during read');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function hashTool(file: string): string {
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_TOOL_BYTES) fail('tool envelope');
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) break;
      offset += count;
      if (offset > MAX_TOOL_BYTES) fail('tool byte limit');
      digest.update(chunk.subarray(0, count));
    }
    if (offset !== before.size || !sameFile(before, fs.fstatSync(fd)))
      fail('tool changed during read');
    return digest.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function scan(root: string, excludeCaches: boolean): { files: string[]; directories: string[] } {
  noSymlinks(root);
  if (!fs.lstatSync(root).isDirectory()) fail('source root is not a directory');
  const files: string[] = [],
    directories: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const relative = prefix ? prefix + '/' + name : name;
      relativeFile(relative);
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail('symlink tree member');
      if (stat.isDirectory()) {
        if (excludeCaches && name === '__pycache__') continue;
        directories.push(relative);
        visit(target, relative);
      } else if (stat.isFile()) {
        if (excludeCaches && /\.(?:pyc|pyo)$/.test(name)) continue;
        files.push(relative);
      } else fail('nonregular tree member');
      if (files.length + directories.length > MAX_FILES * 2) fail('tree entry limit');
    }
  };
  visit(root, '');
  return { files: files.sort(compare), directories: directories.sort(compare) };
}
export function assertServiceImageEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(environment)) {
    if (!value) continue;
    if (
      [
        'BASH_ENV',
        'ENV',
        'CAWS_PRIOR_BASH_ENV',
        'CAWS_GUARD_CONFIG_PY',
        'SHELLOPTS',
        'BASHOPTS',
        'CAWS_GIT_BINARY',
      ].includes(name) ||
      name.startsWith('BASH_FUNC_') ||
      name.startsWith('_HOOK_') ||
      name.startsWith('_CAWS_') ||
      name.startsWith('CAWS_SERVICE_') ||
      name.startsWith('NODE_') ||
      name.startsWith('LD_') ||
      name.startsWith('DYLD_') ||
      (name.startsWith('PYTHON') && !(name === 'PYTHONDONTWRITEBYTECODE' && value === '1')) ||
      (name === 'CAWS_BIN' && value !== 'caws')
    )
      fail('unsupported ambient executable input');
  }
}
function normalizedSelection(
  selection: ActiveInvocationSelection,
  selectedIndex: number
): ImageSelection {
  if (
    selection.configuration !== 'system' ||
    selection.surface !== 'codex' ||
    selection.event !== 'stop' ||
    !Number.isSafeInteger(selectedIndex) ||
    selectedIndex < 0 ||
    selectedIndex > 65535 ||
    Object.keys(selection.libraryOverrides).length !== 0 ||
    selection.hooksDirectory !== selection.runtimeDirectory
  )
    fail('unsupported selection profile');
  absolute(selection.canonical);
  absolute(selection.checkout);
  absolute(selection.runtimeDirectory);
  const selected = selection.handlers[selectedIndex];
  if (
    !selected ||
    selected.entry !== 'session-log.sh' ||
    selected.name !== 'session-log.sh' ||
    selected.args.length !== 0 ||
    selected.kind !== 'project-override' ||
    path.basename(selected.path) !== 'session-log.sh' ||
    path.relative(selection.canonical, selected.path).startsWith('..') ||
    selection.overrides['session-log.sh'] !== selected.path
  )
    fail('service is outside original selection');
  if (new Set(selection.handlers.map((handler) => handler.path)).size !== selection.handlers.length)
    fail('ambiguous original handler identity');
  const handlers = selection.handlers.map((handler, index): SelectedHandler => {
    absolute(handler.path);
    if (
      !/^[A-Za-z0-9_.-]+\.sh$/.test(handler.name) ||
      handler.entry !== handler.name ||
      handler.args.length !== 0 ||
      !/^[a-f0-9]{64}$/.test(handler.sha256) ||
      (index !== selectedIndex &&
        (handler.kind !== 'stock' ||
          handler.path !== path.join(selection.runtimeDirectory, handler.name)))
    )
      fail('unsupported selected handler');
    return {
      path: handler.path,
      sha256: handler.sha256,
      entry: handler.entry,
      name: handler.name,
      args: [...handler.args],
      tier: handler.tier,
      kind: handler.kind,
    };
  });
  const libraries = Object.entries(selection.libraries)
    .sort(([a], [b]) => compare(a, b))
    .map(([name, library]): SelectedImageLibrary => {
      if (
        !/^[A-Za-z0-9_.-]+$/.test(name) ||
        !['surface', 'shared'].includes(library.kind) ||
        library.path !==
          path.join(
            selection.runtimeDirectory,
            library.kind === 'surface' ? 'surfaces/codex/lib' : 'lib',
            name
          ) ||
        !/^[a-f0-9]{64}$/.test(library.sha256)
      )
        fail('unsupported effective library');
      return {
        name,
        path: library.path,
        sha256: library.sha256,
        kind: library.kind as 'surface' | 'shared',
      };
    });
  if (selection.transcriptAdapter) {
    const transcript = libraries.find((library) => library.name === 'session-transcript.py');
    if (
      !transcript ||
      transcript.path !== selection.transcriptAdapter.path ||
      transcript.sha256 !== selection.transcriptAdapter.sha256
    )
      fail('unsupported transcript adapter');
  }
  return {
    canonicalProject: selection.canonical,
    surface: 'codex',
    event: 'stop',
    configuration: 'system',
    runtimeDigest: selection.runtimeDigest,
    selectedIndex,
    handlers,
    libraries,
  };
}
function once(source: string, needle: string, replacement: string, count = 1): string {
  if (source.split(needle).length !== count + 1) fail('runtime transform anchor');
  return source.split(needle).join(replacement);
}
const STAGED_RUNNER_HELPER = [
  '_rh_exec_staged() {',
  '  local handler_path="$1" stderr_file="$2"',
  '  shift 2',
  '  _rh_stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/caws-handler-stdin-XXXXXX" 2>/dev/null) || _rh_stage_dir=""',
  '  if [[ -n "$_rh_stage_dir" ]]; then',
  '    _rh_stage="$_rh_stage_dir/payload"',
  "    trap '_rh_remove_stage' EXIT",
  '    if printf \'%s\' "${HOOK_INPUT_JSON-}" > "$_rh_stage" 2>/dev/null \\',
  '      && exec 0<"$_rh_stage"; then',
  '      _rh_remove_stage',
  '      if [[ -e "$_rh_stage" ]]; then',
  '        "$handler_path" "$@" 2>"$stderr_file"',
  '        exit $?',
  '      fi',
  '      trap - EXIT',
  '      exec "$handler_path" "$@" 2>"$stderr_file"',
  '    fi',
  '    _rh_remove_stage',
  '    trap - EXIT',
  '  fi',
  '  printf \'%s\' "${HOOK_INPUT_JSON-}" | "$handler_path" "$@" 2>"$stderr_file"',
  '}',
  '',
].join('\n');

/** Transform recognized direct and staged layouts without granting image authority. */
export function transformServiceImageRunner(
  input: Readonly<{
    runner: string;
    selectedIndex: number;
    handlerRoutes: string;
    parseInput: string;
    executeHandler: string;
  }>
): string {
  if (
    !Number.isSafeInteger(input.selectedIndex) ||
    input.selectedIndex < 0 ||
    input.selectedIndex > 65535
  )
    fail('selected handler index');
  let runner = input.runner;
  const fileCall = '      stdout_buf=$("$handler_path" "$@" < "$stdin_file" 2>"$stderr_file")\n';
  const pipeCall = '                    | "$handler_path" "$@" 2>"$stderr_file")\n';
  runner = once(runner, fileCall, fileCall.replace('"$handler_path"', '_caws_service_image_exec'));
  runner = once(runner, pipeCall, pipeCall.replace('"$handler_path"', '_caws_service_image_exec'));
  const stagedCall =
    '    elif (( stage_inline )); then\n      stdout_buf=$(_rh_exec_staged "$handler_path" "$stderr_file" "$@")\n';
  let recognizedHelper = '';
  if (runner.includes('_rh_exec_staged() {') || runner.includes('stdout_buf=$(_rh_exec_staged ')) {
    const guard =
      '  shift 2\n  if [[ "$_rh_handler_index" -ne ' +
      input.selectedIndex +
      ' ]]; then\n' +
      '    exec 3>&- 4<&- 5>&-\n  fi\n';
    recognizedHelper = once(STAGED_RUNNER_HELPER, '  shift 2\n', guard);
    runner = once(runner, STAGED_RUNNER_HELPER, recognizedHelper);
    runner = once(
      runner,
      stagedCall,
      stagedCall.replace('"$handler_path"', '"$handler_execution_path"')
    );
  }
  // Only the exact helper may retain logical call syntax: its argument is sealed.
  const outsideHelper = recognizedHelper ? once(runner, recognizedHelper, '') : runner;
  if (outsideHelper.includes('"$handler_path" "$@"')) fail('runtime transform anchor');
  runner = once(
    runner,
    '    if [[ ! -x "$handler_path" ]]; then\n',
    input.handlerRoutes + '    if [[ ! -x "$handler_path" ]]; then\n'
  );
  runner = once(
    runner,
    '    source "${HOOKS_DIR}/lib/parse-input.sh" 2>/dev/null || return 0\n',
    input.parseInput
  );
  return input.executeHandler + runner;
}
const CODEX_BOOTSTRAP = [
  '_codex_pi_shared="${CAWS_PROJECT_DIR:-.}/.caws/hooks/runtime-paths.sh"',
  'if [[ -f "$_codex_pi_shared" ]]; then',
  '  # shellcheck disable=SC1090',
  '  source "$_codex_pi_shared"',
  'else',
  "  # Fallback: try to find runtime-paths.sh relative to this file's parent's",
  '  # parent (override lib -> override dir -> .caws/hooks).',
  '  _codex_pi_fallback="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && cd ../../.. && pwd)/runtime-paths.sh"',
  '  # shellcheck disable=SC1090',
  '  [[ -f "$_codex_pi_fallback" ]] && source "$_codex_pi_fallback"',
  'fi',
  'unset _codex_pi_shared _codex_pi_fallback',
  '',
].join('\n');
function clientTable(rows: readonly SourceRow[]): object[] {
  return rows
    .filter((row) => row.origin === 'client')
    .map((row) => ({
      relativePath: row.relativePath,
      path: row.path,
      sha256: row.sha256,
      bytes: row.bytes,
    }));
}
function generation(
  selection: ImageSelection,
  closureDigest: string,
  tcb: ServiceImageManifest['toolchainTcb']
): string {
  return sha(
    JSON.stringify([
      'caws-service-source-generation-v1',
      SERVICE_IMAGE_PROFILE,
      selection.canonicalProject,
      selection.runtimeDigest,
      selection.selectedIndex,
      selection.handlers,
      selection.libraries,
      closureDigest,
      tcb,
    ])
  );
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function removeStage(root: string): void {
  const tree = scan(root, false);
  for (const directory of [...tree.directories].sort((a, b) => b.length - a.length))
    fs.chmodSync(path.join(root, directory), 0o700);
  fs.chmodSync(root, 0o700);
  fs.rmSync(root, { recursive: true });
}

/**
 * Builds bytes and seals a private sibling stage. It neither publishes nor
 * admits execution. Native independently reconstructs adapters, validates
 * source/profile/TCB custody, atomically publishes, and issues the FD grant.
 */
export function prepareSessionRenderImage(
  options: PrepareServiceImageOptions
): PreparedServiceImage {
  assertServiceImageEnvironment(options.environment);
  const selection = normalizedSelection(options.selection, options.selectedIndex);
  const imageParent = absolute(options.imageParent);
  noSymlinks(imageParent);
  const parent = fs.lstatSync(imageParent);
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.())
    fail('image parent custody');
  const clientDirectory = absolute(options.clientDirectory);
  const templateDirectory = absolute(options.templateDirectory);
  const clientShellPath = absolute(options.clientShellPath);
  const tools = [...options.toolchain].sort((a, b) => compare(a.name, b.name));
  const expectedTools = [
    ...SERVICE_IMAGE_TOOLS,
    ...SERVICE_IMAGE_OPTIONAL_TOOLS.filter((name) => tools.some((pin) => pin.name === name)),
    ...(tools.some((pin) => pin.name === SERVICE_IMAGE_PLAN_TOOL) ? [SERVICE_IMAGE_PLAN_TOOL] : []),
  ].sort(compare);
  if (JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(expectedTools))
    fail('incomplete toolchain');
  for (const tool of tools) {
    absolute(tool.path);
    if (!/^[a-f0-9]{64}$/.test(tool.sha256) || hashTool(tool.path) !== tool.sha256)
      fail('tool changed');
    if (tool.name !== 'caws') fs.accessSync(tool.path, fs.constants.X_OK);
  }
  const tool = (name: string): ServiceToolPin => {
    const pin = tools.find((candidate) => candidate.name === name);
    return pin ?? fail('missing tool');
  };
  if (
    tool('bash').path !== '/bin/bash' ||
    tool('sh').path !== '/bin/sh' ||
    tool('caws').path !== path.resolve(clientDirectory, '../index.js')
  )
    fail('unsupported interpreter or CLI entry');
  const tcb: ServiceImageManifest['toolchainTcb'] = {
    tools: tools.map((pin) => ({ name: pin.name, path: pin.path, sha256: pin.sha256 })),
    pythonFlags: ['-I', '-S', '-B'],
    systemDependencies: 'trusted-not-hash-complete',
  };
  const rows: SourceRow[] = [];
  const captured = new Map<string, Buffer>();
  let sourceBytes = 0;
  const capture = (
    origin: SourceRow['origin'],
    relativePath: string,
    file: string,
    expected?: string
  ): Buffer => {
    relativeFile(relativePath);
    const bytes = readRegular(file);
    const digest = sha(bytes);
    if (expected !== undefined && digest !== expected) fail('source fingerprint changed');
    sourceBytes += bytes.length;
    if (sourceBytes > MAX_SOURCE_BYTES || rows.length >= MAX_FILES) fail('source closure envelope');
    rows.push({ origin, path: absolute(file), relativePath, sha256: digest, bytes: bytes.length });
    captured.set(origin + ':' + relativePath, bytes);
    return bytes;
  };
  const runtimeRoot = options.selection.runtimeDirectory;
  const runtimeManifest = capture(
    'runtime',
    'manifest.json',
    path.join(runtimeRoot, 'manifest.json')
  );
  if (sha(runtimeManifest) !== selection.runtimeDigest) fail('runtime manifest changed');
  const raw: unknown = JSON.parse(text(runtimeManifest));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('runtime manifest shape');
  const runtimeFiles = Object.entries(raw as Record<string, unknown>);
  for (const [name, digest] of runtimeFiles) {
    relativeFile(name);
    if (
      name === 'manifest.json' ||
      name === 'sealed-libraries.sh' ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      fail('runtime manifest member');
    capture('runtime', name, path.join(runtimeRoot, name), digest);
  }
  const actualRuntime = scan(runtimeRoot, false).files;
  const expectedRuntime = ['manifest.json', ...runtimeFiles.map(([name]) => name)].sort(compare);
  if (JSON.stringify(actualRuntime) !== JSON.stringify(expectedRuntime))
    fail('undeclared runtime member');
  for (const handler of selection.handlers) {
    if (
      handler.kind === 'stock' &&
      captured.get('runtime:' + handler.name) !== undefined &&
      sha(captured.get('runtime:' + handler.name)!) === handler.sha256
    )
      continue;
    if (handler.kind === 'stock') fail('stock handler fingerprint');
  }
  for (const library of selection.libraries) {
    const relative = path.relative(runtimeRoot, library.path);
    const bytes = captured.get('runtime:' + relative);
    if (!bytes || sha(bytes) !== library.sha256) fail('selected library fingerprint');
  }
  const selected = selection.handlers[selection.selectedIndex]!;
  const projectRoot = path.dirname(selected.path);
  const expectedProject = Object.keys(STERLING_SESSION_SOURCE_PROFILE).sort(compare);
  const actualProject = [
    'session-log.sh',
    'session_log_renderer.py',
    'session_log_daemon.py',
    'runtime-paths.sh',
    ...scan(path.join(projectRoot, 'lib'), true).files.map((name) => 'lib/' + name),
  ].sort(compare);
  if (JSON.stringify(actualProject) !== JSON.stringify(expectedProject))
    fail('undeclared project library or incomplete profile');
  for (const name of expectedProject)
    capture('project', name, path.join(projectRoot, name), STERLING_SESSION_SOURCE_PROFILE[name]!);
  if (sha(captured.get('project:session-log.sh')!) !== selected.sha256)
    fail('original selection fingerprint');
  for (const name of ['service-client.js', 'service-protocol.js'])
    capture('client', name, path.join(clientDirectory, name));
  capture('client', 'session-render-service-client.sh', clientShellPath);
  for (const name of SERVICE_IMAGE_TEMPLATES)
    capture('client', 'service-image/' + name, path.join(templateDirectory, name));
  rows.sort((a, b) => compare(a.origin, b.origin) || compare(a.relativePath, b.relativePath));
  const originalClosureDigest = sha(
    JSON.stringify(['caws-service-original-closure-v1', rows, tcb])
  );
  const sourceGeneration = generation(selection, originalClosureDigest, tcb);
  const imageKey = sha(
    JSON.stringify(['caws-service-image-key-v1', sourceGeneration, clientTable(rows)])
  );
  const root = path.join(imageParent, imageKey);
  const files = new Map<string, Buffer>();
  for (const row of rows) {
    if (row.origin === 'runtime' || row.origin === 'project') {
      files.set(
        (row.origin === 'runtime' ? 'runtime/' : 'hooks/') + row.relativePath,
        captured.get(row.origin + ':' + row.relativePath)!
      );
    }
  }
  const template = (name: (typeof SERVICE_IMAGE_TEMPLATES)[number]): string =>
    text(captured.get('client:service-image/' + name) ?? fail('missing adapter template'));
  const render = (
    name: (typeof SERVICE_IMAGE_TEMPLATES)[number],
    values: Readonly<Record<string, string>>
  ): Buffer => Buffer.from(expandServiceImageTemplate(template(name), values));
  const literal = quoteServiceImageLiteral;
  const resolver = literal(path.join(root, 'runtime/sealed-libraries.sh'));
  files.set('runtime/dispatch.sh', render('dispatch.sh', { __CAWS_IMAGE_RESOLVER__: resolver }));
  files.set(
    'runtime/handler-env.sh',
    render('handler-env.sh', { __CAWS_IMAGE_RESOLVER__: resolver })
  );
  const resolvedLibraries = selection.libraries.map((library) => ({
    name: library.name,
    originalPath: library.path,
    originalSha256: library.sha256,
    executionRelative: 'runtime/' + path.relative(runtimeRoot, library.path),
  }));
  files.set(
    'runtime/sealed-libraries.sh',
    render('libraries.sh', {
      __CAWS_IMAGE_LIBRARY_CASES__: resolvedLibraries
        .map(
          (library) =>
            '    ' +
            literal(library.name) +
            ') source ' +
            literal(path.join(root, library.executionRelative)) +
            '; return $? ;;'
        )
        .join('\n'),
    })
  );
  const handlerRoutes = selection.handlers.map((handler, selectedIndex) => ({
    selectedIndex,
    entry: handler.entry,
    originalPath: handler.path,
    originalSha256: handler.sha256,
    executionRelative:
      selectedIndex === selection.selectedIndex
        ? 'hooks/session-log.sh'
        : 'runtime/' + handler.name,
  }));
  const routeBytes = render('handler-routes.sh', {
    __CAWS_IMAGE_HANDLER_CASES__: handlerRoutes
      .map(
        (route) =>
          '      ' +
          route.selectedIndex +
          ') [[ "$entry" == ' +
          literal(route.entry) +
          ' && "$handler_path" == ' +
          literal(route.originalPath) +
          ' ]] || return 2; handler_execution_path=' +
          literal(path.join(root, route.executionRelative)) +
          ' ;;'
      )
      .join('\n'),
  });
  const runner = transformServiceImageRunner({
    runner: text(captured.get('runtime:lib/run-handlers.sh') ?? fail('missing runner')),
    selectedIndex: selection.selectedIndex,
    handlerRoutes: text(routeBytes),
    parseInput: template('parse-input.sh'),
    executeHandler: text(
      render('execute-handler.sh', {
        __CAWS_IMAGE_SELECTED_INDEX__: String(selection.selectedIndex),
      })
    ),
  });
  files.set('runtime/lib/run-handlers.sh', Buffer.from(runner));
  const planNative = tools.find((pin) => pin.name === SERVICE_IMAGE_PLAN_TOOL);
  if (planNative) {
    // The original handler retains its selection/provenance identity. Only the
    // executed sealed-image bytes use the owner-partitioned native consumer.
    files.set(
      'runtime/plan-transcript-finalize.sh',
      render('plan-transcript-finalize.sh', {
        __CAWS_IMAGE_PLAN_PROJECT__: literal(selection.canonicalProject),
        __CAWS_IMAGE_PLAN_NATIVE__: literal(planNative.path),
        __CAWS_IMAGE_PLAN_HOME__: literal(path.resolve(root, '../../../../..')),
      })
    );
  }
  const parserRelative = 'surfaces/codex/lib/parse-input.sh';
  const parser = text(captured.get('runtime:' + parserRelative) ?? fail('missing Codex parser'));
  files.set(
    'runtime/' + parserRelative,
    Buffer.from(
      once(
        parser,
        CODEX_BOOTSTRAP,
        text(
          render('codex-parser-runtime.sh', {
            __CAWS_IMAGE_RUNTIME_PATHS__: literal(path.join(root, 'runtime/runtime-paths.sh')),
          })
        )
      )
    )
  );
  files.set(
    'hooks/lib/session-log-daemon-client.sh',
    Buffer.from(
      renderServiceClientShell(
        text(captured.get('client:session-render-service-client.sh')!),
        tool('node').path,
        path.join(root, 'client/service-client.js')
      )
    )
  );
  for (const name of ['service-client.js', 'service-protocol.js'])
    files.set('client/' + name, captured.get('client:' + name)!);
  files.set('client/package.json', Buffer.from('{"type":"commonjs"}\n'));
  for (const pin of tools) {
    const body =
      pin.name === 'caws'
        ? render('caws.sh', {
            __CAWS_IMAGE_GIT_PATH__: literal(tool('git').path),
            __CAWS_IMAGE_NODE_PATH__: literal(tool('node').path),
            __CAWS_IMAGE_CLI_ENTRY__: literal(pin.path),
          })
        : pin.name === 'git'
          ? render('git.sh', { __CAWS_IMAGE_TOOL_PATH__: literal(pin.path) })
          : render('tool.sh', {
              __CAWS_IMAGE_TOOL_PATH__: literal(pin.path),
              __CAWS_IMAGE_TOOL_FLAGS__:
                pin.name === 'python3' ? tcb.pythonFlags.map(literal).join(' ') : '',
            });
    files.set('bin/' + pin.name, body);
  }
  if (
    files.size > MAX_FILES ||
    [...files.values()].reduce((total, bytes) => total + bytes.length, 0) > MAX_SOURCE_BYTES
  )
    fail('execution image envelope');
  const manifest: ServiceImageManifest = {
    schema: SERVICE_IMAGE_SCHEMA,
    adapter: SERVICE_ADAPTER,
    profile: SERVICE_IMAGE_PROFILE,
    selection,
    originalClosure: rows,
    originalClosureDigest,
    sourceGeneration,
    execution: {
      root,
      dispatcher: 'runtime/dispatch.sh',
      hooks: 'hooks',
      client: 'client/service-client.js',
      handlerRoutes,
      resolvedLibraries,
      files: [...files]
        .sort(([a], [b]) => compare(a, b))
        .map(([name, bytes]) => ({
          path: name,
          sha256: sha(bytes),
          bytes: bytes.length,
          mode: 365 as const,
        })),
    },
    toolchainTcb: tcb,
  };
  deepFreeze(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('manifest envelope');
  const image: PublishedServiceImage = {
    imageKey,
    imageDigest: sha(manifestBytes),
    manifest,
  };
  if (fs.existsSync(root)) {
    verifyPublishedServiceImage(image);
    return Object.freeze({ schema: PREPARED_SCHEMA, ...image, stagingRoot: null });
  }
  const stagingRoot = fs.mkdtempSync(path.join(imageParent, '.stage-'));
  fs.chmodSync(stagingRoot, 0o700);
  try {
    for (const [name, bytes] of files) {
      const target = path.join(stagingRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: FILE_MODE });
      fs.chmodSync(target, FILE_MODE);
    }
    fs.writeFileSync(path.join(stagingRoot, 'manifest.json'), manifestBytes, {
      flag: 'wx',
      mode: MANIFEST_MODE,
    });
    fs.chmodSync(path.join(stagingRoot, 'manifest.json'), MANIFEST_MODE);
    const directories = scan(stagingRoot, false).directories;
    for (const directory of directories.sort((a, b) => b.length - a.length))
      fs.chmodSync(path.join(stagingRoot, directory), DIRECTORY_MODE);
    fs.chmodSync(stagingRoot, DIRECTORY_MODE);
    return Object.freeze({ schema: PREPARED_SCHEMA, ...image, stagingRoot });
  } catch (error) {
    try {
      removeStage(stagingRoot);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Image staging failed');
    }
    throw error;
  }
}

/** Integrity check only; native admission supplies authorization and custody. */
export function verifyPublishedServiceImage(image: PublishedServiceImage): void {
  const manifest = image.manifest;
  if (
    manifest.schema !== SERVICE_IMAGE_SCHEMA ||
    manifest.adapter !== SERVICE_ADAPTER ||
    manifest.profile !== SERVICE_IMAGE_PROFILE
  )
    fail('image schema');
  const root = absolute(manifest.execution.root);
  const closureDigest = sha(
    JSON.stringify([
      'caws-service-original-closure-v1',
      manifest.originalClosure,
      manifest.toolchainTcb,
    ])
  );
  if (
    closureDigest !== manifest.originalClosureDigest ||
    generation(manifest.selection, closureDigest, manifest.toolchainTcb) !==
      manifest.sourceGeneration ||
    sha(
      JSON.stringify([
        'caws-service-image-key-v1',
        manifest.sourceGeneration,
        clientTable(manifest.originalClosure),
      ])
    ) !== image.imageKey ||
    path.basename(root) !== image.imageKey
  )
    fail('image derivation');
  const body = Buffer.from(JSON.stringify(manifest));
  if (
    body.length > MAX_MANIFEST_BYTES ||
    sha(body) !== image.imageDigest ||
    !readRegular(path.join(root, 'manifest.json'), MAX_MANIFEST_BYTES).equals(body)
  )
    fail('published manifest changed');
  const expectedFiles = [
    'manifest.json',
    ...manifest.execution.files.map((file) => relativeFile(file.path)),
  ].sort(compare);
  if (new Set(expectedFiles).size !== expectedFiles.length || expectedFiles.length > MAX_FILES + 1)
    fail('image file table');
  const tree = scan(root, false);
  if (JSON.stringify(tree.files) !== JSON.stringify(expectedFiles)) fail('unlisted image member');
  const expectedDirectories = new Set<string>();
  for (const file of expectedFiles) {
    let parent = path.dirname(file);
    while (parent !== '.') {
      expectedDirectories.add(parent);
      parent = path.dirname(parent);
    }
  }
  if (JSON.stringify(tree.directories) !== JSON.stringify([...expectedDirectories].sort(compare)))
    fail('unlisted image directory');
  const uid = process.getuid?.();
  for (const directory of ['', ...tree.directories]) {
    const stat = fs.lstatSync(path.join(root, directory));
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== DIRECTORY_MODE)
      fail('image directory custody');
  }
  for (const name of expectedFiles) {
    const target = path.join(root, name);
    const stat = fs.lstatSync(target);
    const expectedMode = name === 'manifest.json' ? MANIFEST_MODE : FILE_MODE;
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== expectedMode
    )
      fail('image file custody');
  }
  let bytes = 0;
  for (const file of manifest.execution.files) {
    const actual = readRegular(path.join(root, file.path));
    bytes += actual.length;
    if (
      file.mode !== 365 ||
      file.bytes !== actual.length ||
      file.sha256 !== sha(actual) ||
      bytes > MAX_SOURCE_BYTES
    )
      fail('image file changed');
  }
}

interface AdmissionDescriptorState {
  readonly descriptors: readonly [number, number, number];
  claimed: boolean;
  closed: boolean;
}
const admissionDescriptorStates = new WeakMap<object, AdmissionDescriptorState>();
function descriptorState(admission: NativeRenderAdmission): AdmissionDescriptorState {
  let state = admissionDescriptorStates.get(admission);
  if (!state) {
    state = {
      descriptors: Object.freeze([
        admission.descriptors.transport,
        admission.descriptors.grant,
        admission.descriptors.receipt,
      ] as const),
      claimed: false,
      closed: false,
    };
    admissionDescriptorStates.set(admission, state);
  }
  return state;
}
/** Dispose transferred copies without validating or reading grant/image inputs. */
export function disposeNativeRenderAdmission(admission: NativeRenderAdmission): void {
  const state = descriptorState(admission);
  if (state.closed) return;
  state.closed = true;
  state.claimed = true;
  for (const fd of new Set(state.descriptors)) {
    if (Number.isSafeInteger(fd) && fd >= 3) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Preserve the primary refusal/result. */
      }
    }
  }
}
export function claimNativeRenderAdmission(
  admission: NativeRenderAdmission,
  request: RuntimeRequest,
  selection: ActiveInvocationSelection,
  environment: Readonly<Record<string, string>>
): AdmittedServiceExecution {
  const state = descriptorState(admission);
  if (state.claimed) fail('admission already consumed');
  state.claimed = true;
  const descriptors = state.descriptors;
  const close = (): void => disposeNativeRenderAdmission(admission);
  try {
    if (
      admission.schema !== SERVICE_IMAGE_ADMISSION_SCHEMA ||
      descriptors.some((fd) => !Number.isSafeInteger(fd) || fd < 3) ||
      new Set(descriptors).size !== 3
    )
      fail('admission descriptors');
    assertServiceImageEnvironment(environment);
    const grant = readServiceGrantFd(descriptors[1]);
    if (serviceGrantDigest(grant) !== serviceGrantDigest(admission.grant))
      fail('grant descriptor mismatch');
    const expected = normalizedSelection(selection, grant.selectedIndex);
    const image = admission.image;
    verifyPublishedServiceImage(image);
    const manifest = image.manifest;
    const selected = expected.handlers[expected.selectedIndex]!;
    if (
      JSON.stringify(expected) !== JSON.stringify(manifest.selection) ||
      grant.invocationId !== request.id ||
      grant.canonicalProject !== selection.canonical ||
      grant.originalHandlerEntry !== selected.entry ||
      grant.originalHandlerPath !== selected.path ||
      grant.originalSource.handlerSha256 !== selected.sha256 ||
      grant.originalSource.closureDigest !== manifest.originalClosureDigest ||
      grant.sourceGeneration !== manifest.sourceGeneration ||
      grant.executionImage.imageDigest !== image.imageDigest ||
      grant.executionImage.clientSha256 !==
        manifest.execution.files.find((file) => file.path === 'client/service-client.js')?.sha256 ||
      grant.hooksDirectory !== path.join(manifest.execution.root, 'hooks') ||
      grant.leaseFile !== path.join(selection.canonical, '.caws/sessions/.renderer-daemon.json')
    )
      fail('grant selection or image mismatch');
    if (
      !fs.fstatSync(descriptors[0]).isSocket() ||
      !fs.fstatSync(descriptors[2]).isFile() ||
      fs.fstatSync(descriptors[2]).size !== 0
    )
      fail('capability descriptor kind');
    for (const row of manifest.originalClosure)
      if (sha(readRegular(row.path)) !== row.sha256) fail('source retired before launch');
    for (const pin of manifest.toolchainTcb.tools)
      if (hashTool(pin.path) !== pin.sha256) fail('tool retired before launch');
    absolute(admission.gitDirectory);
    absolute(admission.gitOriginalDirectory);
    absolute(admission.gitCommonDirectory);
    if (absolute(admission.gitWorkTree) !== selection.checkout) fail('Git work tree mismatch');
    const root = manifest.execution.root;
    const transcript = selection.transcriptAdapter
      ? manifest.execution.resolvedLibraries.find(
          (library) => library.originalPath === selection.transcriptAdapter?.path
        )
      : undefined;
    if (selection.transcriptAdapter && !transcript) fail('transcript image binding');
    return {
      dispatcher: path.join(root, manifest.execution.dispatcher),
      descriptors,
      environment: Object.freeze({
        PATH: path.join(root, 'bin'),
        BASH_ENV: path.join(root, 'runtime/handler-env.sh'),
        CAWS_PRIOR_BASH_ENV: '',
        CAWS_BIN: path.join(root, 'bin/caws'),
        CAWS_SHARED_LIB_DIR: path.join(root, 'runtime/lib'),
        CAWS_MACHINE_ADAPTER_LIB_DIR: path.join(root, 'runtime/surfaces/codex/lib'),
        CAWS_SESSION_TRANSCRIPT_ADAPTER: transcript
          ? path.join(root, transcript.executionRelative)
          : '',
        CAWS_SERVICE_GIT_DIRECTORY: admission.gitDirectory,
        CAWS_SERVICE_GIT_WORK_TREE: admission.gitWorkTree,
        CAWS_SERVICE_GIT_ORIGINAL_DIRECTORY: admission.gitOriginalDirectory,
        CAWS_SERVICE_GIT_COMMON_DIRECTORY: admission.gitCommonDirectory,
        PYTHONDONTWRITEBYTECODE: '1',
      }),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
