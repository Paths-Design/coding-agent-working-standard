#!/usr/bin/env node
// Install a standalone package before atomically switching the global command.
// Never point a shared CLI at a checkout whose build deletes dist/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return result.stdout;
}

export function installCliSnapshot({ packageRoot, cawsHome, binPath }) {
  packageRoot = fs.realpathSync(packageRoot);
  cawsHome = path.resolve(cawsHome);
  binPath = path.resolve(binPath);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== '@paths.design/caws-cli') throw new Error('Expected the CAWS CLI package');
  const previous = fs.lstatSync(binPath, { throwIfNoEntry: false });
  if (previous && !previous.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${binPath}`);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  const lockPath = `${binPath}.caws-install.lock`;
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  let stage;
  let temporaryLink;
  try {
    const releases = path.join(cawsHome, 'lib', 'cli');
    fs.mkdirSync(releases, { recursive: true });
    stage = fs.mkdtempSync(path.join(releases, '.install-'));
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], packageRoot));
    const tarball = path.join(stage, path.basename(packed[0].filename));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const install = path.join(stage, 'install');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true }));
    run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefix', install, tarball], stage);
    const candidate = path.join(install, 'node_modules', '@paths.design', 'caws-cli');
    const entry = path.join(candidate, 'dist', 'index.js');
    // Probe outside the checkout, with isolated machine state and no Git overrides.
    const probe = path.join(stage, 'probe');
    fs.mkdirSync(probe);
    const env = { ...process.env, CAWS_HOME: path.join(probe, 'machine') };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_') || /^(CODEX_THREAD_ID|CAWS_SESSION_ID|CLAUDE_SESSION_ID)$/.test(key)) delete env[key];
    }
    run(process.execPath, [entry, '--help'], probe, env);
    run('git', ['init', '-q'], probe, env);
    run(process.execPath, [entry, 'init'], probe, env);
    run(process.execPath, [entry, 'doctor'], probe, env);
    // Tarball truth: dependency resolution and packaged templates must produce
    // the same runtime as the build being installed, before any activation.
    const runtimeArgs = ['init', 'adapters', 'install', '--plan', '--json'];
    const sourceRuntime = JSON.parse(run(process.execPath, [path.join(packageRoot, 'dist', 'index.js'), ...runtimeArgs], probe, env));
    const packagedRuntime = JSON.parse(run(process.execPath, [entry, ...runtimeArgs], probe, env));
    if (!/^[a-f0-9]{64}$/.test(sourceRuntime.digest) || sourceRuntime.digest !== packagedRuntime.digest) {
      throw new Error(`Packaged runtime differs from development build: ${packagedRuntime.digest} != ${sourceRuntime.digest}; reconcile dependencies and rebuild before installation`);
    }

    // The directory and dependencies are retained unchanged after activation.
    const release = path.join(releases, `${digest.slice(0, 16)}-${path.basename(stage).slice(9)}`);
    fs.renameSync(stage, release);
    stage = undefined;
    const target = path.join(release, 'install', 'node_modules', '@paths.design', 'caws-cli', 'dist', 'index.js');
    fs.chmodSync(target, 0o755);
    temporaryLink = `${binPath}.caws-${crypto.randomUUID()}`;
    fs.symlinkSync(target, temporaryLink);
    fs.renameSync(temporaryLink, binPath);
    temporaryLink = undefined;
    return { release, binPath, target, packageSha256: digest, runtimeDigest: packagedRuntime.digest, version: metadata.version };
  } finally {
    if (temporaryLink) fs.rmSync(temporaryLink, { force: true });
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--package', '--caws-home', '--bin'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/install-cli-snapshot.mjs --package <built-cli-package> --bin <global-caws-symlink> [--caws-home <dir>]');
      options[args[i]] = args[i + 1];
    }
    if (!options['--package'] || !options['--bin']) throw new Error('--package and --bin are required');
    console.log(JSON.stringify(installCliSnapshot({
      packageRoot: options['--package'],
      cawsHome: options['--caws-home'] ?? process.env.CAWS_HOME ?? path.join(os.homedir(), '.caws'),
      binPath: options['--bin'],
    }), null, 2));
  } catch (error) {
    console.error(`install-cli-snapshot: ${error.message}`);
    process.exitCode = 1;
  }
}
