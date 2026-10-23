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

const SOURCE = new Set(['.js', '.jsx', '.ts', '.tsx']);
const DOCUMENT = new Set(['.json', '.md', '.yaml', '.yml']);
const isSpec = name =>
  name.startsWith('.caws/specs/') && ['.yaml', '.yml'].includes(path.extname(name));

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
      if (!SOURCE.has(path.extname(name)) && !DOCUMENT.has(path.extname(name))) continue;
      if (!['100644', '100755'].includes(entry.mode)) {
        throw new Failure(`Eligible staged path is not a regular file: ${JSON.stringify(name)}`);
      }
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
    const source = materialized.filter(name => SOURCE.has(path.extname(name)));
    if (source.length) {
      const eslint = binary('eslint');
      for (const batch of chunks(source))
        execute(process.execPath, [eslint, '--fix', '--', ...batch]);
    }
    if (materialized.length) {
      const prettier = binary('prettier');
      for (const batch of chunks(materialized)) {
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
