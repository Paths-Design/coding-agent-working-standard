import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertMachinePath } from '../init/machine-paths';
import type { RuntimeRequest } from './protocol';
import type { ActiveInvocationSelection } from './selection';

/** Compatibility identities for the prefix being replaced, not executable trust. */
const PREFIX: Readonly<Record<string, string>> = {
  'dispatch.sh': '5f8a185f8b63e601aa29af3431d0ddafedb9a44f45d6a2d9279d32410fc2150f',
  'handler-env.sh': '901ecd961b65f5383a48ec0e4db7ef2117975963f117ff48d5ed1fab75773cc7',
  'runtime-paths.sh': 'c2cc098b08c110723c2d1805170ba2d73a855f0864e5792bb7a88a2c3def7f08',
  'lib/agent-surface.sh': '9fb104eab8cc5955157dd2da7dc25c19a4bfcd008aa148cfacfba842c9310c32',
  'surfaces/codex/lib/parse-input.sh':
    '04a21ee0cd24d917bbee4c63f9285a2a867f2f9a08a9cdf2f9a78d3400a73c61',
  'lib/session-cache.sh': 'eea9bb74ec74d07931eb13ac45e6822a348ce7fb49e4a7baa9d590e321e093cb',
  'lib/session-id.sh': 'cf662f10e6d3477cecbf5deabd8d2b63284f6f4ac14fa7070725ff8502515c53',
  'surfaces/codex/lib/emit.sh': '7719c904cce6073598717e6a90d82e1c88e99482f79afbfd12b35d23f6d7e86e',
};
const LIBRARIES = {
  'agent-surface.sh': 'shared',
  'parse-input.sh': 'surface',
  'session-cache.sh': 'shared',
  'session-id.sh': 'shared',
  'emit.sh': 'surface',
} as const;
// Both stock lookups select no override for the enforced empty library map.
// The newer source skips that JSON lookup; executable qualification is separate.
const agentSurfaceProfiles = [
  'f8d154f1795c0f643479daa715411a584cb062136cf9003ee007de5f25338e5a',
  PREFIX['lib/agent-surface.sh']!,
];
const identities = (relative: string): readonly string[] =>
  relative === 'lib/agent-surface.sh' ? agentSurfaceProfiles : [PREFIX[relative]!];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nativePath = (value: string): boolean =>
  path.isAbsolute(value) &&
  path.normalize(value) === value &&
  (value === path.parse(value).root || !value.endsWith(path.sep)) &&
  // Match native root transport; shell command substitution also strips final LF.
  Buffer.byteLength(value, 'utf8') <= 4096 &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value) &&
  Buffer.from(value, 'utf8').toString('utf8') === value;

function directory(file: string): boolean {
  if (!nativePath(file)) return false;
  assertMachinePath(path.parse(file).root, file);
  return fs.lstatSync(file).isDirectory();
}

/** ENOENT alone establishes absence; dangling links and inaccessible paths decline. */
function absent(root: string, file: string): boolean {
  assertMachinePath(root, file);
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function pinned(root: string, relative: string, expected = identities(relative)): boolean {
  const file = path.join(root, relative);
  assertMachinePath(root, file);
  if (!fs.lstatSync(file).isFile()) return false;
  // Nonblocking avoids opening a substituted FIFO indefinitely. Hash the opened
  // regular file, bounded independently of a possibly changing size observation.
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    if (!fs.fstatSync(fd).isFile()) return false;
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return (
      length < bytes.length &&
      expected.includes(createHash('sha256').update(bytes.subarray(0, length)).digest('hex'))
    );
  } finally {
    fs.closeSync(fd);
  }
}

const SESSION_END_SOURCES: Readonly<Record<string, string>> = {
  ...PREFIX,
  'session-log.sh': '8f6358e4ec37e9dcd35c98d77d2a77776e6d73c761895f37069b21e61f2f66a9',
  'lib/parse-input.sh': 'b61ca58672ec23722042fa55b4ba65b8c95ebc67a28dbcdc4f335770fe32d5de',
  'lib/agent-pid.sh': 'f075356c6fe4179ac14ff3e1131ba355690f55a2ced04dd2f42df6aa0f8ff800',
  'lib/emit.sh': '32bd200bf9160dffc5d349a7e13341bbcf6644ab9c47ad3f491f68d3ba77bcf4',
};

/** Finite complete-prefix profile for the sole reviewed SessionEnd logger.
 * This admission is before any native effects. A later source change is fatal,
 * never permission to replay the parser prefix after native completion.
 */
export function qualifiesForNativeSessionEndPrefix(context: {
  readonly request: RuntimeRequest;
  readonly selection: ActiveInvocationSelection;
  readonly environment: Readonly<Record<string, string>>;
  readonly sessionId: string | null;
}): boolean {
  const { request, selection, environment, sessionId } = context;
  try {
    const sid = request.payload.session_id;
    if (
      selection.status !== 'active' ||
      request.configuration !== 'system' ||
      selection.configuration !== 'system' ||
      !['codex', 'claude-code'].includes(request.surface) ||
      selection.surface !== request.surface ||
      request.event !== 'session_end' ||
      selection.event !== request.event ||
      !/^[a-f0-9]{64}$/.test(request.runtimeDigest) ||
      selection.runtimeDigest !== request.runtimeDigest ||
      selection.hooksDirectory !== selection.runtimeDirectory ||
      typeof sid !== 'string' ||
      sid !== sessionId ||
      !sid ||
      sid === 'unknown' ||
      sid === '.' ||
      sid === '..' ||
      Buffer.byteLength(sid) > 128 ||
      !/^[A-Za-z0-9_.@:-]+$/.test(sid) ||
      Object.keys(selection.overrides).length ||
      Object.keys(selection.libraryOverrides).length ||
      Object.values(selection.libraries).some(
        (library) => !['shared', 'surface'].includes(library.kind)
      ) ||
      selection.handlers.length !== 1
    )
      return false;
    const handler = selection.handlers[0]!;
    if (
      handler.kind !== 'stock' ||
      handler.name !== 'session-log.sh' ||
      handler.entry !== 'session-log.sh' ||
      handler.args.length ||
      handler.path !== path.join(selection.runtimeDirectory, 'session-log.sh') ||
      handler.sha256 !== SESSION_END_SOURCES['session-log.sh']
    )
      return false;
    const home =
      environment.CAWS_HOME || (environment.HOME ? path.join(environment.HOME, '.caws') : '');
    if (
      !directory(home) ||
      !directory(selection.checkout) ||
      !directory(selection.canonical) ||
      selection.runtimeDirectory !== path.join(home, 'lib/runtimes', request.runtimeDigest) ||
      !directory(selection.runtimeDirectory) ||
      !environmentSupported(request.caller.environment, null) ||
      !environmentSupported(environment, path.join(selection.runtimeDirectory, 'handler-env.sh'))
    )
      return false;
    const cwd = request.payload.cwd;
    if (cwd !== undefined && cwd !== null && cwd !== '') {
      if (typeof cwd !== 'string' || !directory(cwd)) return false;
      const relative = path.relative(selection.checkout, cwd);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        return false;
    }
    const routing: Readonly<Record<string, string>> = {
      CAWS_PROJECT_DIR: selection.checkout,
      CAWS_MACHINE_POLICY_ROOT: selection.canonical,
      CAWS_MACHINE_RUNTIME: '1',
      CAWS_SYSTEM_RUNTIME: '1',
      CAWS_AGENT_SURFACE: request.surface,
      CAWS_ADAPTER_RUNTIME_DIGEST: request.runtimeDigest,
      CAWS_SHARED_LIB_DIR: path.join(selection.runtimeDirectory, 'lib'),
      CAWS_MACHINE_ADAPTER_LIB_DIR: path.join(
        selection.runtimeDirectory,
        'surfaces',
        request.surface,
        'lib'
      ),
      CAWS_MACHINE_LIBRARIES: '{}',
      CAWS_MACHINE_HANDLERS: '{}',
      HOOKS_DIR: selection.runtimeDirectory,
    };
    for (const [name, expected] of Object.entries(routing))
      if (environment[name] && environment[name] !== expected) return false;
    if (!absent(selection.checkout, path.join(selection.checkout, '.caws/hooks/runtime-paths.sh')))
      return false;
    const libraries: Readonly<Record<string, 'shared' | 'surface'>> = {
      'agent-surface.sh': 'shared',
      'parse-input.sh': request.surface === 'codex' ? 'surface' : 'shared',
      'session-cache.sh': 'shared',
      'session-id.sh': 'shared',
      'agent-pid.sh': 'shared',
      'emit.sh': request.surface === 'codex' ? 'surface' : 'shared',
    };
    const required = new Set([
      'dispatch.sh',
      'handler-env.sh',
      'runtime-paths.sh',
      'session-log.sh',
      'lib/parse-input.sh',
      'lib/agent-surface.sh',
      'lib/session-cache.sh',
      'lib/agent-pid.sh',
    ]);
    for (const [name, kind] of Object.entries(libraries)) {
      const relative =
        kind === 'shared' ? 'lib/' + name : 'surfaces/' + request.surface + '/lib/' + name;
      const library = selection.libraries[name];
      if (
        !library ||
        library.kind !== kind ||
        library.path !== path.join(selection.runtimeDirectory, relative) ||
        library.sha256 !== SESSION_END_SOURCES[relative] ||
        !absent(home, path.join(home, 'surfaces', request.surface, 'lib', name)) ||
        (kind === 'shared' &&
          !absent(
            selection.runtimeDirectory,
            path.join(selection.runtimeDirectory, 'surfaces', request.surface, 'lib', name)
          ))
      )
        return false;
      required.add(relative);
    }
    for (const relative of required) {
      const expected = SESSION_END_SOURCES[relative];
      if (!expected || !pinned(selection.runtimeDirectory, relative, [expected])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function environmentSupported(
  environment: Readonly<Record<string, string>>,
  startup: string | null
): boolean {
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith('BASH_FUNC_')) return false;
    if (!value) continue;
    if (name === 'BASH_ENV') {
      if (value !== startup) return false;
      continue;
    }
    if (
      [
        'CAWS_PRIOR_BASH_ENV',
        'ENV',
        'SHELLOPTS',
        'BASHOPTS',
        'CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES',
      ].includes(name) ||
      /^_(?:CAWS|HOOK).*LOADED/.test(name) ||
      /^(?:CAWS|CLAUDE|CODEX)_HOOK_(?:TIMING|DRY_RUN)$/.test(name) ||
      name.startsWith('LD_') ||
      name.startsWith('DYLD_') ||
      name.startsWith('NODE_') ||
      (name.startsWith('PYTHON') && !(name === 'PYTHONDONTWRITEBYTECODE' && value === '1'))
    )
      return false;
  }
  return true;
}

/**
 * Read-only admission for a finite stock Codex prefix. False requires complete
 * compatibility dispatch before cache effects, even for an empty/reprieved chain.
 * This observes source bytes and paths, not held native custody, PATH-selected
 * executables, Python imports, input decoding, or old-envelope interpretation.
 * The caller must qualify those separately and keep missing/unknown SID inert.
 */
export function qualifiesForNativeSessionCache(context: {
  readonly request: RuntimeRequest;
  readonly selection: ActiveInvocationSelection;
  readonly environment: Readonly<Record<string, string>>;
}): boolean {
  const { request, selection, environment } = context;
  try {
    if (
      selection.status !== 'active' ||
      request.configuration !== 'system' ||
      selection.configuration !== 'system' ||
      request.surface !== 'codex' ||
      selection.surface !== request.surface ||
      request.event !== 'pre_tool_use' ||
      selection.event !== request.event ||
      !/^[a-f0-9]{64}$/.test(request.runtimeDigest) ||
      selection.runtimeDigest !== request.runtimeDigest ||
      selection.hooksDirectory !== selection.runtimeDirectory ||
      request.payload.tool_name !== 'Bash' ||
      !object(request.payload.tool_input) ||
      typeof request.payload.tool_input.command !== 'string' ||
      Object.keys(selection.overrides).length > 0 ||
      Object.keys(selection.libraryOverrides).length > 0 ||
      selection.handlers.some((handler) => handler.kind !== 'stock') ||
      Object.values(selection.libraries).some(
        (library) => !['shared', 'surface'].includes(library.kind)
      )
    )
      return false;
    const home =
      environment.CAWS_HOME || (environment.HOME ? path.join(environment.HOME, '.caws') : '');
    if (
      !directory(home) ||
      !directory(selection.checkout) ||
      !directory(selection.canonical) ||
      selection.runtimeDirectory !== path.join(home, 'lib/runtimes', request.runtimeDigest) ||
      !directory(selection.runtimeDirectory) ||
      !environmentSupported(request.caller.environment, null) ||
      !environmentSupported(environment, path.join(selection.runtimeDirectory, 'handler-env.sh'))
    )
      return false;

    const cwd = request.payload.cwd;
    if (cwd !== undefined && cwd !== null && cwd !== '') {
      if (typeof cwd !== 'string' || !directory(cwd)) return false;
      const relative = path.relative(selection.checkout, cwd);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        return false;
    }
    const routing: Readonly<Record<string, string>> = {
      CAWS_PROJECT_DIR: selection.checkout,
      CAWS_MACHINE_POLICY_ROOT: selection.canonical,
      CAWS_MACHINE_RUNTIME: '1',
      CAWS_SYSTEM_RUNTIME: '1',
      CAWS_AGENT_SURFACE: 'codex',
      CAWS_ADAPTER_RUNTIME_DIGEST: request.runtimeDigest,
      CAWS_SHARED_LIB_DIR: path.join(selection.runtimeDirectory, 'lib'),
      CAWS_MACHINE_ADAPTER_LIB_DIR: path.join(selection.runtimeDirectory, 'surfaces/codex/lib'),
      CAWS_MACHINE_LIBRARIES: '{}',
      CAWS_MACHINE_HANDLERS: '{}',
      HOOKS_DIR: selection.runtimeDirectory,
    };
    for (const [name, expected] of Object.entries(routing))
      if (environment[name] && environment[name] !== expected) return false;
    if (!absent(selection.checkout, path.join(selection.checkout, '.caws/hooks/runtime-paths.sh')))
      return false;
    for (const [name, kind] of Object.entries(LIBRARIES)) {
      const relative = kind === 'shared' ? 'lib/' + name : 'surfaces/codex/lib/' + name;
      const library = selection.libraries[name];
      if (
        !library ||
        library.kind !== kind ||
        library.path !== path.join(selection.runtimeDirectory, relative) ||
        !identities(relative).includes(library.sha256)
      )
        return false;
      // Recheck higher-priority paths: selection is a prior observation and a
      // newly created override must not authorize replacement of its prefix.
      if (!absent(home, path.join(home, 'surfaces/codex/lib', name))) return false;
      if (
        kind === 'shared' &&
        !absent(
          selection.runtimeDirectory,
          path.join(selection.runtimeDirectory, 'surfaces/codex/lib', name)
        )
      )
        return false;
    }
    for (const relative of Object.keys(PREFIX))
      if (!pinned(selection.runtimeDirectory, relative)) return false;
    return true;
  } catch {
    return false;
  }
}
