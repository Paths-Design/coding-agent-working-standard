import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const [cliArg, rootArg, nativeArg] = process.argv.slice(2);
assert(
  cliArg && rootArg && nativeArg && process.argv.length === 5,
  'Usage: qualify-guard-config <absolute-cli-root> <new-absolute-artifact-root> <absolute-native-binary>'
);
for (const value of [cliArg, rootArg, nativeArg])
  assert(path.isAbsolute(value), 'absolute paths required');
const cli = fs.realpathSync(cliArg),
  native = fs.realpathSync(nativeArg),
  root = path.resolve(rootArg);
assert(!fs.existsSync(root), 'artifact root must be new');
fs.accessSync(native, fs.constants.X_OK);
assert(fs.statSync(native).isFile());
assert(
  fs.existsSync(path.join(cli, 'dist/runtime/engine-entry.js')),
  'build the owning candidate first'
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const resolve = createRequire(path.join(cli, 'package.json'));
const args = [
  resolve.resolve('jest/bin/jest'),
  '--runInBand',
  '--bail=1',
  '--selectProjects',
  'caws-cli',
  '--runTestsByPath',
  'tests/runtime/guard-config-integration.test.js',
];
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cli, encoding: 'utf8' });
assert.equal(revision.status, 0, revision.stderr);
const dirty = spawnSync('git', ['status', '--porcelain=v1'], { cwd: cli, encoding: 'utf8' });
assert.equal(dirty.status, 0, dirty.stderr);
const runtime = path.join(cli, 'dist/runtime');
const manifest = {
  schema: 'caws.guard-config-qualification.v1',
  cli,
  root,
  revision: revision.stdout.trim(),
  native,
  nativeSha256: sha(native),
  dirtyState: dirty.stdout,
  testSha256: sha(path.join(cli, 'tests/runtime/guard-config-integration.test.js')),
  qualifierSha256: sha(__filename),
  runtimeModules: Object.fromEntries(
    fs
      .readdirSync(runtime)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => [name, sha(path.join(runtime, name))])
  ),
  command: [process.execPath, ...args],
  nonclaims: [
    'Private selected-extension fixture; no machine install or native harness registration',
    'Scope authority is a deterministic refusal fixture; kernel scope correctness is not exercised',
    'Other first-party Python consumers remain; no whole-runtime parity or retirement',
    'No containment, cancellation, renderer, machine-load or performance qualification',
  ],
};
fs.writeFileSync(path.join(root, 'command.json'), JSON.stringify(manifest, null, 2) + '\n');
const result = spawnSync(process.execPath, args, {
  cwd: cli,
  env: {
    ...process.env,
    CAWS_GUARD_CONFIG_ARTIFACT_ROOT: root,
    CAWS_GUARD_CONFIG_NATIVE_BIN: native,
  },
  timeout: 300000,
  maxBuffer: 8 * 1024 * 1024,
});
fs.writeFileSync(path.join(root, 'stdout.bin'), result.stdout || Buffer.alloc(0));
fs.writeFileSync(path.join(root, 'stderr.bin'), result.stderr || Buffer.alloc(0));
fs.writeFileSync(
  path.join(root, 'status.json'),
  JSON.stringify(
    {
      status: result.status,
      signal: result.signal,
      error: result.error ? String(result.error) : null,
    },
    null,
    2
  ) + '\n'
);
process.stdout.write(result.stdout || Buffer.alloc(0));
process.stderr.write(result.stderr || Buffer.alloc(0));
process.exitCode = result.status === 0 && !result.error ? 0 : 1;
