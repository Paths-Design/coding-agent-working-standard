const { setTimeout, clearTimeout } = require('node:timers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

jest.setTimeout(30000);
const launcher = path.resolve(__dirname, '../../dist/execution/git-hook-launcher-main.js');
const node = fs.realpathSync.native(process.execPath);
const git = '/usr/bin/git';
const roots = new Set();
const owned = new Set();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const config = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
};

function fixture({ realGit = false } = {}) {
  const base = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'caws-hook-launcher-')
  );
  roots.add(base);
  const project = path.join(base, 'project');
  const invocation = path.join(base, 'invocation');
  const producer = path.join(base, 'producer');
  const hookDir = path.join(base, 'hooks');
  for (const directory of [project, invocation, producer, hookDir])
    fs.mkdirSync(directory, { mode: 0o700 });
  const roles = ['output', 'tmp', 'cache'].map((name) => path.join(invocation, name));
  for (const directory of roles) fs.mkdirSync(directory, { mode: 0o700 });
  const env = {
    PATH: `${path.dirname(node)}:/usr/bin:/bin`,
    LC_ALL: 'C',
    PWD: project,
    TMPDIR: roles[1],
    HOME: base,
    CAWS_HOME: base,
    CODEX_HOME: base,
    CODEX_THREAD_ID: 'genuine-thread',
    CAWS_AGENT_SURFACE: 'codex',
    CAWS_PROJECT_DIR: project,
    ...config,
  };
  let objectDirectory = path.join(base, 'objects');
  let seed = Buffer.from('seed-index-bytes');
  let index;
  const runGit = (args, extra = {}, input) => {
    const result = childProcess.spawnSync(git, args, {
      cwd: project,
      env: { ...env, ...extra },
      input,
      encoding: null,
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(`git failed: ${String(result.error || result.stderr)}`);
    return result.stdout;
  };
  if (realGit) {
    runGit(['init', '-q']);
    runGit(['config', 'user.name', 'Hook Test']);
    runGit(['config', 'user.email', 'hook@example.invalid']);
    fs.writeFileSync(path.join(project, 'selected.txt'), 'original source\n');
    fs.writeFileSync(path.join(project, 'foreign.txt'), 'foreign source\n');
    runGit(['add', '--', 'selected.txt', 'foreign.txt']);
    runGit(['commit', '-qm', 'baseline']);
    index = runGit(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
      .toString()
      .trim();
    objectDirectory = runGit(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
      .toString()
      .trim();
    seed = fs.readFileSync(index);
  } else fs.mkdirSync(objectDirectory, { mode: 0o700 });
  const seedPath = path.join(producer, 'seed');
  fs.writeFileSync(seedPath, seed, { mode: 0o400 });
  const hook = path.join(hookDir, 'pre-commit');
  const setHook = (source) => {
    fs.writeFileSync(hook, source, { mode: 0o700 });
    fs.chmodSync(hook, 0o700);
  };
  setHook('#!/bin/sh\nexit 0\n');
  const descriptor = {
    schema: 'caws.execution.git-hook-launcher.v1',
    hook: { path: hook, sha256: digest(fs.readFileSync(hook)) },
    args: ['literal argument', '--not-an-option', ''],
    cwd: project,
    seedIndex: { path: seedPath, sha256: digest(seed) },
    objectDirectory,
    outputRoot: roles[0],
    tmpRoot: roles[1],
    cacheRoot: roles[2],
    channel: {
      schema: 'caws.git-hook.format-channel.v1',
      nonce: 'a'.repeat(64),
      replyRoot: producer,
      timeoutMs: 5000,
    },
    stdinBase64: Buffer.from('actual input\n').toString('base64'),
  };
  const descriptorPath = path.join(producer, 'descriptor.json');
  const writeDescriptor = (value = descriptor) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    if (fs.existsSync(descriptorPath)) fs.chmodSync(descriptorPath, 0o600);
    fs.writeFileSync(descriptorPath, bytes, { mode: 0o600 });
    fs.chmodSync(descriptorPath, 0o400);
    return ['--descriptor', descriptorPath, '--sha256', digest(bytes)];
  };
  const updateHook = (source) => {
    setHook(source);
    descriptor.hook.sha256 = digest(fs.readFileSync(hook));
  };
  return {
    base,
    project,
    invocation,
    producer,
    roles,
    env,
    objectDirectory,
    seed,
    seedPath,
    hook,
    descriptor,
    descriptorPath,
    writeDescriptor,
    updateHook,
    runGit,
    index,
  };
}

function direct(f, callback, environment = f.env) {
  // The spy is installed before requiring the compiled SUT. Mutation runners
  // instrument this same process; a closed child environment cannot carry the
  // active mutant into the separate Node executable.
  jest.resetModules();
  const spawnSpy = jest
    .spyOn(childProcess, 'spawnSync')
    .mockReturnValue({ status: 0, signal: null });
  const { runGitHookLauncher } = require('../../dist/execution/git-hook-launcher-main');
  jest.spyOn(process, 'cwd').mockReturnValue(f.project);
  const original = process.env;
  process.env = { ...environment };
  try {
    return callback(runGitHookLauncher, spawnSpy);
  } finally {
    process.env = original;
    jest.restoreAllMocks();
  }
}

function launch(f, options = {}) {
  return childProcess.spawnSync(node, [launcher, ...(options.args || f.writeDescriptor())], {
    cwd: f.project,
    env: options.env || f.env,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10000,
  });
}
function filesUnder(directory) {
  const output = [];
  function visit(current, prefix = '') {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(prefix, entry.name);
      const target = path.join(current, entry.name);
      const stat = fs.statSync(target, { bigint: true });
      const identity = [stat.dev, stat.ino, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs].map(
        String
      );
      if (entry.isDirectory()) {
        output.push([name, 'directory', ...identity]);
        visit(target, name);
      } else output.push([name, digest(fs.readFileSync(target)), ...identity]);
    }
  }
  visit(directory);
  return output;
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const child of owned)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  owned.clear();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test('direct decision preserves the exact Git tuple and starts only the pinned hook', () => {
  const f = fixture();
  const args = f.writeDescriptor();
  direct(f, (run, spawnSpy) => {
    spawnSpy.mockReturnValue({ status: 37, signal: null });
    expect(run(args)).toBe(37);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [executable, argv, options] = spawnSpy.mock.calls[0];
    expect(executable).toBe(f.hook);
    expect(argv).toEqual(f.descriptor.args);
    expect(options).toMatchObject({
      cwd: f.project,
      shell: false,
      stdio: ['pipe', 'inherit', 'inherit'],
      input: Buffer.from('actual input\n'),
    });
    expect(options.env).toEqual({
      ...f.env,
      PWD: f.project,
      TMPDIR: f.roles[1],
      GIT_INDEX_FILE: path.join(f.roles[0], 'transaction/index'),
      GIT_OBJECT_DIRECTORY: path.join(f.roles[0], 'transaction/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: f.objectDirectory,
      CAWS_HOOK_FORMAT_CHANNEL: JSON.stringify(f.descriptor.channel),
    });
    expect(JSON.parse(options.env.CAWS_HOOK_FORMAT_CHANNEL)).toEqual(f.descriptor.channel);
    expect(fs.readFileSync(options.env.GIT_INDEX_FILE)).toEqual(f.seed);
  });
});

test.each([
  [
    'missing config',
    (e) => {
      for (const key of Object.keys(config)) delete e[key];
    },
  ],
  [
    'wrong count',
    (e) => {
      e.GIT_CONFIG_COUNT = '3';
    },
  ],
  [
    'wrong order',
    (e) => {
      e.GIT_CONFIG_KEY_0 = 'gc.auto';
      e.GIT_CONFIG_KEY_1 = 'maintenance.auto';
    },
  ],
  [
    'wrong value',
    (e) => {
      e.GIT_CONFIG_VALUE_0 = 'true';
    },
  ],
  [
    'unknown indexed entry',
    (e) => {
      e.GIT_CONFIG_KEY_2 = 'core.hooksPath';
      e.GIT_CONFIG_VALUE_2 = '/tmp/other';
    },
  ],
  [
    'parameters',
    (e) => {
      e.GIT_CONFIG_PARAMETERS = "'core.hooksPath=/tmp/other'";
    },
  ],
  [
    'Node startup',
    (e) => {
      e.NODE_OPTIONS = '--no-warnings';
    },
  ],
  [
    'private execution',
    (e) => {
      e.CAWS_EXECUTION_SECRET = 'unexpected';
    },
  ],
])('direct decision refuses %s before spawning a hook', (_name, change) => {
  const f = fixture();
  const env = { ...f.env };
  change(env);
  const args = f.writeDescriptor();
  direct(
    f,
    (run, spawnSpy) => {
      expect(() => run(args)).toThrow();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(fs.readdirSync(f.roles[0])).toEqual([]);
    },
    env
  );
});

test.each([
  [
    'unknown field',
    (f) => {
      f.descriptor.extra = true;
    },
  ],
  [
    'wrong schema',
    (f) => {
      f.descriptor.schema = 'wrong';
    },
  ],
  [
    'unexpected hook field',
    (f) => {
      f.descriptor.hook.extra = true;
    },
  ],
  [
    'unexpected seed field',
    (f) => {
      f.descriptor.seedIndex.extra = true;
    },
  ],
  [
    'wrong hook hash',
    (f) => {
      f.descriptor.hook.sha256 = '0'.repeat(64);
    },
  ],
  [
    'wrong seed hash',
    (f) => {
      f.descriptor.seedIndex.sha256 = '0'.repeat(64);
    },
  ],
  [
    'missing seed',
    (f) => {
      fs.unlinkSync(f.seedPath);
    },
  ],
  [
    'writable seed',
    (f) => {
      fs.chmodSync(f.seedPath, 0o600);
    },
  ],
  [
    'unsafe producer root',
    (f) => {
      fs.chmodSync(f.producer, 0o755);
    },
  ],
  [
    'hook not executable',
    (f) => {
      fs.chmodSync(f.hook, 0o600);
    },
  ],
  [
    'invalid argument',
    (f) => {
      f.descriptor.args = ['bad\0argument'];
    },
  ],
  [
    'too many arguments',
    (f) => {
      f.descriptor.args = Array(257).fill('x');
    },
  ],
  [
    'invalid stdin encoding',
    (f) => {
      f.descriptor.stdinBase64 = 'not-base64!';
    },
  ],
  [
    'foreign working directory',
    (f) => {
      f.descriptor.cwd = f.base;
    },
  ],
  [
    'invalid nonce',
    (f) => {
      f.descriptor.channel.nonce = 'A'.repeat(64);
    },
  ],
  [
    'unexpected channel field',
    (f) => {
      f.descriptor.channel.extra = true;
    },
  ],
  [
    'invalid timeout',
    (f) => {
      f.descriptor.channel.timeoutMs = 30001;
    },
  ],
  [
    'zero timeout',
    (f) => {
      f.descriptor.channel.timeoutMs = 0;
    },
  ],
  [
    'role equals project',
    (f) => {
      f.descriptor.outputRoot = f.project;
    },
  ],
  [
    'role nested in project',
    (f) => {
      const parent = path.join(f.project, 'invocation');
      fs.mkdirSync(parent, { mode: 0o700 });
      for (const name of ['output', 'tmp', 'cache'])
        fs.mkdirSync(path.join(parent, name), { mode: 0o700 });
      f.descriptor.outputRoot = path.join(parent, 'output');
      f.descriptor.tmpRoot = path.join(parent, 'tmp');
      f.descriptor.cacheRoot = path.join(parent, 'cache');
    },
  ],
  [
    'roles from different parents',
    (f) => {
      f.descriptor.tmpRoot = f.producer;
    },
  ],
  [
    'producer root overlaps role',
    (f) => {
      f.descriptor.channel.replyRoot = f.invocation;
    },
  ],
  [
    'object root overlaps role',
    (f) => {
      f.descriptor.objectDirectory = f.invocation;
    },
  ],
  [
    'hook overlaps invocation',
    (f) => {
      const target = path.join(f.invocation, 'hook');
      fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      f.descriptor.hook = { path: target, sha256: digest(fs.readFileSync(target)) };
    },
  ],
  [
    'ambiguous object directory',
    (f) => {
      const target = path.join(f.base, 'objects:other');
      fs.mkdirSync(target);
      f.descriptor.objectDirectory = target;
    },
  ],
  [
    'nonempty role',
    (f) => {
      fs.writeFileSync(path.join(f.roles[0], 'prior'), 'existing');
    },
  ],
])('direct decision rejects %s before hook spawn', (_name, change) => {
  const f = fixture();
  change(f);
  const args = f.writeDescriptor();
  direct(f, (run, spawnSpy) => {
    expect(() => run(args)).toThrow();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.roles[0], 'transaction'))).toBe(false);
  });
});

test('descriptor hash, duplicate members, physical aliases, writable descriptor and argv are refused', () => {
  for (const kind of ['hash', 'duplicate', 'symlink', 'writable', 'argv']) {
    const f = fixture();
    let args = f.writeDescriptor();
    if (kind === 'hash') args[3] = '0'.repeat(64);
    if (kind === 'duplicate')
      args = f.writeDescriptor(
        JSON.stringify(f.descriptor).replace(
          '{"schema":',
          '{"schema":"caws.execution.git-hook-launcher.v1","schema":'
        )
      );
    if (kind === 'symlink') {
      const alias = path.join(f.producer, 'alias');
      fs.symlinkSync(f.descriptorPath, alias);
      args[1] = alias;
    }
    if (kind === 'writable') fs.chmodSync(f.descriptorPath, 0o600);
    if (kind === 'argv') args.push('extra');
    direct(f, (run, spawnSpy) => {
      expect(() => run(args)).toThrow();
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  }
});

test.each([
  [{ status: null, signal: 'SIGTERM' }, 143],
  [{ status: null, signal: 'unknown' }, 1],
  [{ status: null, signal: null }, 1],
  [{ status: null, signal: null, error: new Error('spawn failed') }, 1],
])('direct hook exit is reported truthfully for %j', (outcome, expected) => {
  const f = fixture();
  const args = f.writeDescriptor();
  direct(f, (run, spawnSpy) => {
    spawnSpy.mockReturnValue(outcome);
    expect(run(args)).toBe(expected);
  });
});
test.each([-1, 256])('direct hook exit outside 0..255 refuses %s', (status) => {
  const f = fixture();
  const args = f.writeDescriptor();
  direct(f, (run, spawnSpy) => {
    spawnSpy.mockReturnValue({ status, signal: null });
    expect(() => run(args)).toThrow();
  });
});

test('real Node launcher preserves hook argv, stdin, quarantine variables and exit code', () => {
  const f = fixture();
  f.updateHook(
    `#!${node}\nconst fs=require('node:fs');\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8'),index:process.env.GIT_INDEX_FILE,objects:process.env.GIT_OBJECT_DIRECTORY,alternate:process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,configCount:process.env.GIT_CONFIG_COUNT,config0:process.env.GIT_CONFIG_KEY_0,config1:process.env.GIT_CONFIG_KEY_1}));\nprocess.exitCode=37;\n`
  );
  const result = launch(f);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(37);
  expect(JSON.parse(result.stdout)).toEqual({
    args: f.descriptor.args,
    stdin: 'actual input\n',
    index: path.join(f.roles[0], 'transaction/index'),
    objects: path.join(f.roles[0], 'transaction/objects'),
    alternate: f.objectDirectory,
    configCount: '2',
    config0: 'maintenance.auto',
    config1: 'gc.auto',
  });
  expect(result.stderr).toBe('');
});

test.each(['hash', 'duplicate', 'role overlap', 'environment'])(
  'real Node launcher refuses %s without running the hook',
  (kind) => {
    const f = fixture();
    f.updateHook('#!/bin/sh\necho HOOK_EXECUTED\n');
    if (kind === 'role overlap') f.descriptor.outputRoot = f.project;
    const args =
      kind === 'duplicate'
        ? f.writeDescriptor(
            JSON.stringify(f.descriptor).replace(
              '{"schema":',
              '{"schema":"caws.execution.git-hook-launcher.v1","schema":'
            )
          )
        : f.writeDescriptor();
    if (kind === 'hash') args[3] = '0'.repeat(64);
    const env =
      kind === 'environment'
        ? { ...f.env, GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/unexpected' }
        : f.env;
    const result = launch(f, { args, env });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('caws Git hook launcher refused');
    expect(result.stdout).not.toContain('HOOK_EXECUTED');
  }
);

test('real Git hook reads baseline objects and stages only into quarantine', () => {
  const f = fixture({ realGit: true });
  f.runGit(['config', 'core.hooksPath', path.dirname(f.hook)]);
  fs.writeFileSync(path.join(f.project, 'selected.txt'), 'changed source\n');
  const indexBefore = fs.readFileSync(f.index);
  const indexStat = fs.statSync(f.index, { bigint: true });
  const objectsBefore = filesUnder(f.objectDirectory);
  f.env.GIT_INDEX_FILE = f.index;
  f.env.GIT_OBJECT_DIRECTORY = f.objectDirectory;
  f.updateHook(
    '#!/bin/sh\nset -e\ngit config --get core.hooksPath\ngit cat-file -e HEAD^{commit}\ngit add -- selected.txt\n'
  );
  const result = launch(f);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe(path.dirname(f.hook));
  const privateIndex = path.join(f.roles[0], 'transaction/index');
  const privateObjects = path.join(f.roles[0], 'transaction/objects');
  expect(fs.readFileSync(f.index)).toEqual(indexBefore);
  expect(filesUnder(f.objectDirectory)).toEqual(objectsBefore);
  const indexAfter = fs.statSync(f.index, { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
    expect(indexAfter[key]).toBe(indexStat[key]);
  expect(fs.readFileSync(path.join(f.project, 'selected.txt'), 'utf8')).toBe('changed source\n');
  expect(fs.readFileSync(path.join(f.project, 'foreign.txt'), 'utf8')).toBe('foreign source\n');
  expect(fs.readFileSync(privateIndex).equals(indexBefore)).toBe(false);
  expect(filesUnder(privateObjects).length).toBeGreaterThan(0);
  expect(
    f
      .runGit(['show', ':selected.txt'], {
        GIT_INDEX_FILE: privateIndex,
        GIT_OBJECT_DIRECTORY: privateObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: f.objectDirectory,
      })
      .toString()
  ).toBe('changed source\n');
  expect(
    f
      .runGit(['show', ':foreign.txt'], {
        GIT_INDEX_FILE: privateIndex,
        GIT_OBJECT_DIRECTORY: privateObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: f.objectDirectory,
      })
      .toString()
  ).toBe('foreign source\n');
});

test('the USER hook cannot reach either launcher private descriptor object', () => {
  const f = fixture();
  f.updateHook(
    `#!${node}\nconst fs=require('node:fs');const rows=[];for(const value of fs.readdirSync('/dev/fd')){const fd=Number(value);if(!Number.isInteger(fd)||fd<3)continue;try{const stat=fs.fstatSync(fd,{bigint:true});let bytes='';if(stat.isFile()){try{const b=Buffer.alloc(128);const n=fs.readSync(fd,b,0,b.length,0);bytes=b.subarray(0,n).toString('base64')}catch{}}rows.push({fd,dev:stat.dev.toString(),ino:stat.ino.toString(),bytes})}catch{}}process.stdout.write(JSON.stringify(rows));\n`
  );
  const three = fs.openSync(path.join(f.producer, 'fd3'), 'w+');
  const four = fs.openSync(path.join(f.producer, 'fd4'), 'w+');
  try {
    const markers = [Buffer.from('private-fd3-marker'), Buffer.from('private-fd4-marker')];
    fs.writeSync(three, markers[0], 0, markers[0].length, 0);
    fs.writeSync(four, markers[1], 0, markers[1].length, 0);
    const identities = [three, four].map((fd) => {
      const stat = fs.fstatSync(fd, { bigint: true });
      return { dev: stat.dev.toString(), ino: stat.ino.toString() };
    });
    const result = launch(f, { stdio: ['ignore', 'pipe', 'pipe', three, four] });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(Array.isArray(observed)).toBe(true);
    const observedIdentities = observed.map((row) => ({ dev: row.dev, ino: row.ino }));
    const observedBytes = observed.map((row) => row.bytes);
    for (const identity of identities) expect(observedIdentities).not.toContainEqual(identity);
    for (const marker of markers) expect(observedBytes).not.toContain(marker.toString('base64'));
  } finally {
    fs.closeSync(three);
    fs.closeSync(four);
  }
});

test('a real hook signal is reported as 128 plus the signal number', () => {
  const f = fixture();
  f.updateHook('#!/bin/sh\nkill -TERM $$\n');
  const result = launch(f);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(143);
});

test('detached hook descendant output arrives after the launcher has exited', async () => {
  const f = fixture();
  const request = {
    schema: 'caws.git-hook.format-request.v1',
    nonce: f.descriptor.channel.nonce,
    sequence: 0,
    kind: 'prettier',
    paths: ['selected.txt'],
    allPaths: ['selected.txt'],
  };
  const late = `CAWS_FORMATTER_REQUEST_V1 ${Buffer.from(JSON.stringify(request)).toString('base64')}\n`;
  const observedExit = path.join(f.producer, 'launcher-exited');
  const descendant = `const fs=require('node:fs');const end=Date.now()+4000;const emit=()=>{if(fs.existsSync(${JSON.stringify(observedExit)})||Date.now()>=end)process.stdout.write(${JSON.stringify(late)});else setTimeout(emit,10)};setTimeout(emit,120)`;
  f.updateHook(
    `#!${node}\nconst {spawn}=require('node:child_process');\nconst child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','inherit']});\nchild.unref();\nprocess.exit(0);\n`
  );
  const child = childProcess.spawn(node, [launcher, ...f.writeDescriptor()], {
    cwd: f.project,
    env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  owned.add(child);
  let exitObserved = false;
  let lateAfterExit = false;
  let output = '';
  let stderr = '';
  let markerError;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes(late)) lateAfterExit = exitObserved;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      reject(new Error('owned launcher did not settle'));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      exitObserved = true;
      try {
        fs.writeFileSync(observedExit, 'launcher exited');
      } catch (error) {
        markerError = error;
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      owned.delete(child);
      resolve({ code, signal });
    });
  });
  expect(outcome).toEqual({ code: 0, signal: null });
  expect(markerError).toBeUndefined();
  expect(output).toContain(late);
  expect(lateAfterExit).toBe(true);
  expect(stderr).toBe('');
});
