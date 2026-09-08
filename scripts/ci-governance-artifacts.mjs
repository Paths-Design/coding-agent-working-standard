#!/usr/bin/env node
// CI has committed governance artifacts, not the operator's machine/worktrees.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runSpecsValidateCommand } = require('../packages/caws-cli/dist/shell/commands/specs');
const { loadSpecs } = require('../packages/caws-cli/dist/store/specs-store');
const { loadWaivers } = require('../packages/caws-cli/dist/store/waivers-store');

export function validateArtifacts(root, base, head) {
  root = fs.realpathSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const diff = spawnSync('git', ['diff', '--no-ext-diff', '--name-only', '--diff-filter=ACMR', '-z', base, head, '--', '.caws/specs'], { cwd: root, env, encoding: 'utf8' });
  if (diff.status !== 0) throw new Error(`Cannot determine changed specs: ${diff.error?.message ?? diff.stderr}`);
  const inside = file => {
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(root + path.sep)) throw new Error(`Artifact escapes checkout: ${file}`);
    return resolved;
  };
  const specs = [];
  for (const file of diff.stdout.split('\0').filter(Boolean)) {
    if (!/^\.caws\/specs\/.*\.ya?ml$/.test(file) || file.startsWith('.caws/specs/.archive/')) continue;
    const messages = [];
    const code = runSpecsValidateCommand({ file: inside(path.join(root, file)), out: text => messages.push(text), err: text => messages.push(text) });
    specs.push({ file, ok: code === 0, messages });
  }
  for (const kind of ['specs', 'waivers']) {
    const directory = path.join(root, '.caws', kind);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) continue;
    inside(directory);
    for (const name of fs.readdirSync(directory)) {
      if (!/\.ya?ml$/.test(name)) continue;
      const file = path.join(directory, name);
      inside(file);
      // The store ignores non-regular directory entries. Refuse these here
      // instead of reporting that every source artifact was validated.
      if (!fs.lstatSync(file).isFile()) throw new Error(`Artifact is not a regular file: ${file}`);
    }
  }
  // Retain whole-corpus shape/semantics and duplicate-id validation, without
  // asking whether this CI checkout has the operator's live local bindings.
  const corpus = loadSpecs(path.join(root, '.caws'));
  const waivers = loadWaivers(path.join(root, '.caws'));
  return { ok: specs.every(spec => spec.ok) && ![...corpus.diagnostics, ...waivers.diagnostics].some(d => d.severity === 'error'),
    specs, specCount: corpus.specs.length, specDiagnostics: corpus.diagnostics,
    waiverCount: waivers.waivers.length, waiverDiagnostics: waivers.diagnostics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: ci-governance-artifacts.mjs <base-sha> <head-sha>');
    const result = validateArtifacts(process.cwd(), process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
