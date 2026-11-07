'use strict';

// Shared observation custody for the implemented native harnesses. Receipts are
// observations, never CAWS acceptance or permission to execute their contents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const insist = (value, message) => {
  if (!value) throw Error(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function immutable(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function withoutBytes({ bytes, ...observed }) {
  return observed;
}
function fields(value, required, optional = []) {
  insist(object(value), 'Expected an object');
  insist(
    required.every((key) => Object.hasOwn(value, key)),
    'Missing request field'
  );
  insist(
    Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    'Unexpected request field'
  );
}
function within(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}
function relativeName(value) {
  insist(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4096 &&
      Array.from(value).every(
        (character) =>
          character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127 && character !== '\\'
      ) &&
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Expected a normalized package-relative path'
  );
  insist(
    !value
      .split('/')
      .some(
        (part) =>
          /^\.env(?:\.|$)/i.test(part) ||
          /^(?:auth|credentials?|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(part) ||
          ['.ssh', '.aws', '.azure', '.kube', '.codex', '.claude'].includes(part.toLowerCase()) ||
          /\.(?:pem|key|p12|pfx)$/i.test(part)
      ),
    'Sensitive path is not a public input'
  );
  return value;
}
function identity(stat) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => String(stat[key]))
    .join(':');
}

function openCustody(requestFile) {
  const started = performance.now();
  const packageRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  const reports = path.join(packageRoot, 'reports');
  function lexical(relative) {
    const file = path.resolve(packageRoot, relativeName(relative));
    insist(within(packageRoot, file) && file !== packageRoot, 'Path escapes package');
    return file;
  }
  function physical(file, allowMissing = false) {
    insist(within(packageRoot, file), 'Path escapes package');
    let current = packageRoot;
    const parts = path.relative(packageRoot, file).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (allowMissing && error.code === 'ENOENT') return file;
        throw error;
      }
      insist(!stat.isSymbolicLink(), 'Symbolic-link path refused: ' + current);
      if (index < parts.length - 1) insist(stat.isDirectory(), 'Non-directory ancestor');
    }
    return file;
  }
  const resolvePath = (relative) => physical(lexical(relative), true);
  function readStable(file, maximum = 512 * 1024 * 1024) {
    physical(file);
    const named = fs.lstatSync(file, { bigint: true });
    insist(
      named.isFile() && named.nlink === 1n && named.size <= BigInt(maximum),
      'Expected a bounded, single-link regular public file'
    );
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      insist(identity(before) === identity(named), 'Input replaced before read');
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        insist(count > 0, 'Input truncated during read');
        offset += count;
      }
      insist(fs.readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, 'Input grew during read');
      insist(
        identity(fs.fstatSync(fd, { bigint: true })) === identity(before) &&
          identity(fs.lstatSync(file, { bigint: true })) === identity(before),
        'Input changed during read'
      );
      return {
        path: file,
        sha256: hash(bytes),
        sizeBytes: bytes.length,
        mode: Number(before.mode & 0o7777n),
        bytes,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  const requestAbsolute = path.isAbsolute(requestFile)
    ? requestFile
    : path.resolve(packageRoot, requestFile);
  const requestPath = lexical(
    path.relative(packageRoot, requestAbsolute).split(path.sep).join('/')
  );
  insist(within(reports, requestPath), 'Request must be retained under reports/');
  const requestInput = readStable(requestPath, 64 * 1024);
  const request = immutable(JSON.parse(requestInput.bytes.toString('utf8')));
  fields(
    request,
    ['schema', 'surface', 'candidate', 'host', 'node', 'runtime', 'paths', 'scenario', 'budgetMs'],
    ['adapter']
  );
  insist(request.schema === 'caws.native-session.request.v1', 'Unknown request schema');
  insist(object(request.runtime), 'Select runtime entry explicitly');
  if (request.runtime.entry === 'legacy') fields(request.runtime, ['entry']);
  else if (request.runtime.entry === 'native') fields(request.runtime, ['entry', 'nativeImage']);
  else throw Error('Select runtime entry explicitly: legacy or native');
  if (request.adapter !== undefined)
    insist(
      object(request.adapter) && Buffer.byteLength(JSON.stringify(request.adapter)) <= 16384,
      'Invalid adapter configuration'
    );
  const registryPath = path.join(packageRoot, 'dist/init/hook-packs/register.js');
  const registryInput = readStable(registryPath);
  const { IMPLEMENTED_SURFACES: surfaces } = require(registryPath);
  insist(
    Array.isArray(surfaces) &&
      new Set(surfaces).size === surfaces.length &&
      surfaces.includes(request.surface),
    'Expected an implemented release surface'
  );
  fields(request.candidate, ['commit', 'tarball']);
  insist(/^[0-9a-f]{40}$/.test(request.candidate.commit), 'Invalid declared candidate commit');
  fields(request.host, ['image', 'provenance']);
  insist(
    object(request.host.provenance) &&
      Buffer.byteLength(JSON.stringify(request.host.provenance)) <= 8192,
    'Expected bounded public host provenance'
  );
  fields(request.paths, ['profile', 'consumer', 'project', 'output']);
  const roots = Object.fromEntries(
    Object.entries(request.paths).map(([key, value]) => {
      const file = resolvePath(value);
      insist(file !== reports && within(reports, file), 'Generated root must be under reports/');
      return [key, file];
    })
  );
  const rootValues = Object.values(roots);
  for (let left = 0; left < rootValues.length; left++)
    for (let right = left + 1; right < rootValues.length; right++)
      insist(
        !within(rootValues[left], rootValues[right]) &&
          !within(rootValues[right], rootValues[left]),
        'Generated roots must be pairwise separate'
      );
  fields(request.scenario, ['ownedFile', 'protectedFile'], ['resumeThread']);
  if (request.scenario.resumeThread !== undefined)
    insist(
      typeof request.scenario.resumeThread === 'string' &&
        /^[A-Za-z0-9_-]{1,160}$/.test(request.scenario.resumeThread),
      'Invalid resume thread'
    );
  const sentinels = new Set(
    ['ownedFile', 'protectedFile'].map((key) => {
      const file = lexical(request.scenario[key]);
      insist(
        file !== roots.project && within(roots.project, file),
        'Scenario files must be inside the fixture project'
      );
      return file;
    })
  );
  insist(sentinels.size === 2, 'Owned and protected targets must differ');
  insist(
    Number.isSafeInteger(request.budgetMs) && request.budgetMs > 0 && request.budgetMs <= 180000,
    'Invalid original budget'
  );
  function pin(selection, jsonSchema = null) {
    fields(selection, ['path', 'sha256']);
    insist(/^[0-9a-f]{64}$/.test(selection.sha256), 'Invalid input hash');
    const file = resolvePath(selection.path);
    insist(!within(roots.profile, file), 'Do not inventory private profile contents');
    const { bytes, ...observed } = readStable(
      file,
      jsonSchema ? 16 * 1024 * 1024 : 512 * 1024 * 1024
    );
    insist(observed.sha256 === selection.sha256, 'Public input hash mismatch: ' + file);
    if (jsonSchema) {
      const descriptor = JSON.parse(bytes.toString('utf8'));
      insist(
        object(descriptor) && descriptor.schema === jsonSchema,
        'Expected a native-image v2 descriptor'
      );
    }
    return observed;
  }
  function readPublic(relative, maximum = 64 * 1024) {
    const file = lexical(relative);
    insist(!within(roots.profile, file), 'Public read cannot enter private profile');
    insist(
      Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 16 * 1024 * 1024,
      'Invalid public read bound'
    );
    return readStable(file, maximum);
  }
  const inputs = immutable({
    tooling: withoutBytes(readStable(__filename)),
    request: withoutBytes(requestInput),
    registry: withoutBytes(registryInput),
    candidate: {
      commit: request.candidate.commit,
      commitBasis: 'declared',
      tarball: pin(request.candidate.tarball),
    },
    host: {
      image: pin(request.host.image),
      provenance: { basis: 'declared-not-attested', value: request.host.provenance },
    },
    node: pin(request.node),
    runtime:
      request.runtime.entry === 'native'
        ? {
            entry: 'native',
            nativeImage: pin(request.runtime.nativeImage, 'caws.runtime.native-image-input.v2'),
          }
        : { entry: 'legacy' },
  });
  insist(
    [0o555, 0o755].includes(inputs.host.image.mode) && [0o555, 0o755].includes(inputs.node.mode),
    'Host and Node inputs need reviewed executable modes'
  );
  const expectedInputs = [
    ['tooling', inputs.tooling],
    ['request', inputs.request],
    ['registry', inputs.registry],
    ['candidate', inputs.candidate.tarball],
    ['host', inputs.host.image],
    ['node', inputs.node],
    ...(inputs.runtime.entry === 'native' ? [['nativeImage', inputs.runtime.nativeImage]] : []),
  ].map(([name, observed]) => [name, { ...observed }]);
  function directory(file) {
    physical(file, true);
    fs.mkdirSync(file, { recursive: true, mode: 0o700 });
    physical(file);
    insist(fs.lstatSync(file).isDirectory(), 'Expected a physical directory');
  }
  const home = path.join(roots.profile, 'home'),
    temporary = path.join(roots.profile, 'tmp');
  const env = {
    HOME: home,
    USERPROFILE: home,
    CAWS_HOME: path.join(roots.profile, 'machine'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_cache: path.join(roots.profile, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_update_notifier: 'false',
    PYTHONDONTWRITEBYTECODE: '1',
    FORCE_COLOR: '0',
    PATH: [
      path.join(roots.consumer, 'node_modules/.bin'),
      path.dirname(inputs.node.path),
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(path.delimiter),
  };
  for (const file of [
    ...Object.values(roots),
    home,
    temporary,
    env.CAWS_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.npm_config_cache,
  ])
    directory(file);
  insist(
    (fs.statSync(roots.profile).mode & 0o077) === 0 && (fs.statSync(home).mode & 0o077) === 0,
    'Private profile directories must exclude group and other access'
  );
  function reserve(label) {
    insist(
      typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(label),
      'Invalid receipt label'
    );
    physical(roots.output);
    const file = path.join(roots.output, label + '.json');
    return {
      file,
      fd: fs.openSync(
        file,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      ),
    };
  }
  function persist(opened, data) {
    try {
      const bytes = Buffer.from(
        JSON.stringify(
          {
            schema: 'caws.native-session.receipt.v1',
            surface: request.surface,
            surfaceBasis: 'requested',
            requestSha256: inputs.request.sha256,
            data,
          },
          null,
          2
        ) + '\n'
      );
      fs.writeFileSync(opened.fd, bytes);
      fs.fsyncSync(opened.fd);
      return { path: opened.file, sha256: hash(bytes) };
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  const record = (label, data) => persist(reserve(label), data);
  const remainingMs = () =>
    Math.max(0, Math.floor(request.budgetMs - (performance.now() - started)));
  function capture(relative, options = {}) {
    const file = lexical(relative);
    insist(sentinels.has(file), 'Capture is limited to declared public scenario files');
    try {
      physical(path.dirname(file), true);
      const stat = fs.lstatSync(file);
      const kind = stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
      if (kind !== 'file') return { path: file, kind, mode: stat.mode & 0o7777 };
      const { bytes, ...observed } = readStable(file, 1024 * 1024);
      return {
        ...observed,
        kind,
        ...(options.bytes ? { bytesBase64: bytes.toString('base64') } : {}),
      };
    } catch (error) {
      return {
        path: file,
        kind: error.code === 'ENOENT' ? 'missing' : 'error',
        ...(error.code === 'ENOENT' ? {} : { error: error.message }),
      };
    }
  }
  function run(label, argv, options = {}) {
    insist(
      Array.isArray(argv) &&
        argv.length > 0 &&
        argv.every((value) => typeof value === 'string' && !value.includes('\0')),
      'Invalid argv'
    );
    const cwd = resolvePath(options.cwd ?? request.paths.project);
    insist(fs.lstatSync(cwd).isDirectory(), 'Invalid command cwd');
    const opened = reserve(label),
      before = performance.now();
    let result = {};
    let inputBefore = null,
      inputAfter = null,
      inputError = null,
      stage = 'before';
    try {
      inputBefore = revalidateInputs();
      stage = 'command';
      const remaining = remainingMs(),
        timeout = options.timeoutMs ?? remaining;
      insist(Number.isSafeInteger(timeout) && timeout > 0 && remaining > 0, 'Budget expired');
      result = spawnSync(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        timeout: Math.min(timeout, remaining),
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      result = { error };
      if (stage === 'before') inputError = { phase: 'before', message: error.message };
    }
    if (inputBefore !== null) {
      try {
        inputAfter = revalidateInputs();
      } catch (error) {
        inputError = { phase: 'after', message: error.message };
      }
    }
    const stdout = Buffer.from(result.stdout ?? ''),
      stderr = Buffer.from(result.stderr ?? '');
    const data = {
      argv,
      cwd,
      inputManifest: inputs,
      inputValidation: { before: inputBefore, after: inputAfter, error: inputError },
      status: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error
        ? { code: result.error.code ?? null, message: result.error.message }
        : null,
      durationMs: performance.now() - before,
      stdoutBase64: stdout.toString('base64'),
      stderrBase64: stderr.toString('base64'),
      cleanup: 'Normal direct-child timeout only; descendant settlement is not established',
    };
    const receipt = persist(opened, data);
    if (data.error || data.signal !== null || data.status !== 0 || inputError)
      throw Object.assign(Error('Command failed: ' + label), { receipt, observation: data });
    return { ...data, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), receipt };
  }
  const revalidateInputs = () => {
    const current = {};
    for (const [name, before] of expectedInputs) {
      insist(remainingMs() > 0, 'Budget expired');
      const observed = withoutBytes(readStable(before.path, before.sizeBytes));
      insist(observed.sha256 === before.sha256, 'Public input hash mismatch: ' + name);
      insist(observed.mode === before.mode, 'Public input mode changed: ' + name);
      insist(remainingMs() > 0, 'Budget expired');
      current[name] = observed;
    }
    return current;
  };
  return {
    request,
    packageRoot,
    resolvePath,
    readPublic,
    inputs,
    env,
    capture,
    record,
    run,
    remainingMs,
    revalidateInputs,
  };
}
module.exports = { openCustody };
