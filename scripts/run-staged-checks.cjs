#!/usr/bin/env node
'use strict';

// No stash or hidden patch is created. As with the former --no-stash hook,
// formatting stages the whole materialized file, including unstaged hunks.
// Governance bytes belong to their writer: validate staged specs, then leave
// every .caws/ index blob and working path untouched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const SOURCE = ['.js', '.jsx', '.ts', '.tsx'];
const DOCUMENT = ['.json', '.md', '.yaml', '.yml'];
const hasExtension = (name, extensions) => extensions.some(extension => name.endsWith(extension));
const isSpec = name => name.startsWith('.caws/specs/') && hasExtension(name, ['.yaml', '.yml']);
const FORMAT_REQUEST = 'CAWS_FORMATTER_REQUEST_V1 ';
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const hasControlCharacter = value =>
  Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const relativePath = name =>
  typeof name === 'string' &&
  name.length > 0 &&
  !name.includes('\\') &&
  !hasControlCharacter(name) &&
  !path.isAbsolute(name) &&
  name
    .split('/')
    .every(
      part =>
        part &&
        part !== '.' &&
        part !== '..' &&
        !['.git', '.caws', '.codex', '.agents'].includes(part.toLowerCase())
    );

class Failure extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}

function chunks(names) {
  const result = [];
  let batch = [];
  let bytes = 0;
  for (const name of names) {
    const size = Buffer.byteLength(name) + 1;
    if (batch.length && (bytes + size > 32768 || batch.length === 128)) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(name);
    bytes += size;
  }
  if (batch.length) result.push(batch);
  return result;
}

function main(options = {}) {
  const cwd = options.cwd || process.cwd();
  const spawn = options.spawn || spawnSync;
  const error = options.error || (text => process.stderr.write(text));
  const output = options.output || (text => fs.writeSync(1, text));
  const env = options.env || process.env;
  const execute = (command, args, capture = false) => {
    const result = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw new Failure(`${command} could not spawn: ${result.error.message}`);
    if (result.status === null || result.status === undefined) {
      throw new Failure(`${command} terminated by signal ${result.signal || 'unknown'}`);
    }
    if (result.status !== 0) {
      if (capture && result.stderr?.length) error(result.stderr.toString());
      throw new Failure(`${command} exited ${result.status}`, result.status);
    }
    return result.stdout || Buffer.alloc(0);
  };
  const git = (...args) => execute('git', ['--literal-pathspecs', ...args], true);
  const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const nul = bytes => {
    const text = decode(bytes);
    if (text && !text.endsWith('\0')) throw new Failure('Git returned an incomplete filename list');
    return text ? text.slice(0, -1).split('\0') : [];
  };

  try {
    let channel;
    if (env.CAWS_HOOK_FORMAT_CHANNEL !== undefined) {
      channel = JSON.parse(env.CAWS_HOOK_FORMAT_CHANNEL);
      if (
        !exact(channel, ['schema', 'nonce', 'replyRoot', 'timeoutMs']) ||
        channel.schema !== 'caws.git-hook.format-channel.v1' ||
        typeof channel.nonce !== 'string' ||
        !/^[0-9a-f]{64}$/.test(channel.nonce) ||
        typeof channel.replyRoot !== 'string' ||
        !path.isAbsolute(channel.replyRoot) ||
        fs.realpathSync(channel.replyRoot) !== channel.replyRoot ||
        !Number.isSafeInteger(channel.timeoutMs) ||
        channel.timeoutMs < 1 ||
        channel.timeoutMs > 30000
      ) {
        throw new Failure('Invalid Native formatter channel');
      }
      const directory = fs.lstatSync(channel.replyRoot);
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o7777) !== 0o700
      )
        throw new Failure('Unsafe Native formatter reply root');
    }
    const top = decode(git('rev-parse', '--show-toplevel'));
    if (!top.endsWith('\n') || fs.realpathSync(cwd) !== fs.realpathSync(top.slice(0, -1))) {
      throw new Failure('Run staged checks from the checkout root so formatting fences apply');
    }
    const root = top.slice(0, -1);
    if (git('ls-files', '--unmerged', '-z').length) {
      throw new Failure('Resolve unmerged index entries before running staged checks');
    }
    const staged = nul(git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--'));
    const entries = new Map();
    for (const line of nul(git('ls-files', '--stage', '-z'))) {
      const tab = line.indexOf('\t');
      const [mode, oid, stage] = line.slice(0, tab).split(' ');
      if (tab < 0 || stage !== '0') throw new Failure('Git returned an invalid index entry');
      entries.set(line.slice(tab + 1), { mode, oid });
    }
    const materialized = [];
    // Complete validation before any formatter or restaging effect.
    for (const name of staged) {
      const entry = entries.get(name);
      if (!entry) throw new Failure(`Missing staged entry: ${JSON.stringify(name)}`);
      if (isSpec(name)) {
        if (!['100644', '100755'].includes(entry.mode)) {
          throw new Failure(`Staged spec is not a regular file: ${JSON.stringify(name)}`);
        }
        const bytes = git('cat-file', 'blob', entry.oid);
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-staged-spec-'));
        try {
          const file = path.join(temporary, 'spec.yaml');
          fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
          try {
            execute('caws', ['specs', 'validate', file]);
          } catch (failure) {
            failure.message = `Spec ${JSON.stringify(name)}: ${failure.message}`;
            throw failure;
          }
        } finally {
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      }
      if (name.startsWith('.caws/')) continue;
      if (!hasExtension(name, SOURCE) && !hasExtension(name, DOCUMENT)) continue;
      if (!['100644', '100755'].includes(entry.mode)) {
        throw new Failure(`Eligible staged path is not a regular file: ${JSON.stringify(name)}`);
      }
      try {
        let parent = root;
        for (const segment of name.split('/').slice(0, -1)) {
          parent = path.join(parent, segment);
          const directory = fs.lstatSync(parent);
          if (!directory.isDirectory() || directory.isSymbolicLink()) {
            throw new Failure(
              `Staged path has a non-directory or symlink parent: ${JSON.stringify(name)}`
            );
          }
        }
        const observed = fs.lstatSync(path.join(root, name));
        if (!observed.isFile()) {
          throw new Failure(
            `Materialized staged path is not a regular file: ${JSON.stringify(name)}`
          );
        }
      } catch (failure) {
        if (failure.code === 'ENOENT') {
          throw new Failure(
            `Eligible staged path is absent; materialize it before validation: ${JSON.stringify(name)}`
          );
        }
        throw failure;
      }
      materialized.push(`./${name}`);
    }
    // Resolve installed tools directly: no npx workspace relocation or downloads.
    const binary = name => {
      const manifestPath = require.resolve(`${name}/package.json`, { paths: [root] });
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
      if (!relative) throw new Failure(`Installed ${name} has no executable`);
      return path.resolve(path.dirname(manifestPath), relative);
    };
    const source = materialized.filter(name => hasExtension(name, SOURCE));
    let sequence = 0;
    const format = (kind, batch) => {
      const paths = batch.map(name => name.slice(2));
      const allPaths = materialized.map(name => name.slice(2));
      if (
        allPaths.length > 256 ||
        !allPaths.every(relativePath) ||
        new Set(allPaths).size !== allPaths.length
      )
        throw new Failure('Unsupported Native formatter paths');
      const current = sequence++;
      const replyPath = path.join(channel.replyRoot, `format-${channel.nonce}-${current}.json`);
      if (fs.existsSync(replyPath)) throw new Failure('Native formatter reply already exists');
      const request = {
        schema: 'caws.git-hook.format-request.v1',
        nonce: channel.nonce,
        sequence: current,
        kind,
        paths,
        allPaths,
      };
      output(FORMAT_REQUEST + Buffer.from(JSON.stringify(request)).toString('base64') + '\n');
      const deadline = process.hrtime.bigint() + BigInt(channel.timeoutMs) * 1000000n;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        if (process.hrtime.bigint() >= deadline)
          throw new Failure('Native formatter reply timed out');
        let fd;
        try {
          fd = fs.openSync(
            replyPath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
          );
        } catch (failure) {
          if (failure.code !== 'ENOENT') throw failure;
          Atomics.wait(sleeper, 0, 0, 5);
          continue;
        }
        let reply;
        try {
          const stat = fs.fstatSync(fd);
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.size < 1 ||
            stat.size > 1048576
          ) {
            throw new Failure('Unsafe Native formatter reply');
          }
          reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd)));
        } finally {
          fs.closeSync(fd);
        }
        if (
          !exact(reply, [
            'schema',
            'nonce',
            'sequence',
            'exitCode',
            'stdoutBase64',
            'stderrBase64',
          ]) ||
          reply.schema !== 'caws.git-hook.format-reply.v1' ||
          reply.nonce !== channel.nonce ||
          reply.sequence !== current ||
          !Number.isInteger(reply.exitCode) ||
          reply.exitCode < 0 ||
          reply.exitCode > 255 ||
          !['stdoutBase64', 'stderrBase64'].every(
            key =>
              typeof reply[key] === 'string' &&
              Buffer.from(reply[key], 'base64').toString('base64') === reply[key]
          )
        ) {
          throw new Failure('Invalid Native formatter reply');
        }
        if (reply.stdoutBase64) output(Buffer.from(reply.stdoutBase64, 'base64').toString());
        if (reply.stderrBase64) error(Buffer.from(reply.stderrBase64, 'base64').toString());
        if (reply.exitCode !== 0)
          throw new Failure(`${kind} exited ${reply.exitCode}`, reply.exitCode);
        break;
      }
    };
    if (source.length) {
      const eslint = channel ? undefined : binary('eslint');
      for (const batch of chunks(source)) {
        if (channel) format('eslint', batch);
        else execute(process.execPath, [eslint, '--fix', '--', ...batch]);
      }
    }
    if (materialized.length) {
      const prettier = channel ? undefined : binary('prettier');
      for (const batch of chunks(materialized)) {
        if (channel) format('prettier', batch);
        else
          execute(process.execPath, [
            prettier,
            '--write',
            '--no-error-on-unmatched-pattern',
            '--',
            ...batch,
          ]);
      }
      // Every git status is authoritative, independently of formatter output.
      for (const batch of chunks(materialized)) git('add', '--', ...batch);
    }
    return 0;
  } catch (failure) {
    error(`staged-checks: ${failure.message}\n`);
    return failure instanceof Failure ? failure.status : 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
