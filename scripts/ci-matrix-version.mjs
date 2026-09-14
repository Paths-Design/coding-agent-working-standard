#!/usr/bin/env node
// Bind post-publication verification to the successful release occurrence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseTag } from './release-tag-publish.mjs';

const packageName = '@paths.design/caws-cli';
const versionOf = tag => {
  if (typeof tag !== 'string' || tag.trim() !== tag) throw new Error('Release tag must be a single canonical value');
  const parsed = parseTag(tag);
  if (!parsed.ok) throw new Error(`Cannot identify released CLI version: ${tag}`);
  return parsed.version;
};

export function resolveTarget(eventName, event, view) {
  let requested, expectedSha;
  if (eventName === 'workflow_run') {
    const run = event.workflow_run;
    if (run?.conclusion !== 'success' || run.event !== 'push' ||
        run.path !== '.github/workflows/release.yml' || !Number.isSafeInteger(run.id) || run.id <= 0 ||
        run.head_sha?.length !== 40 || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) {
      throw new Error('Expected a successful tag-driven release run with a commit SHA');
    }
    requested = versionOf(run.head_branch);
    expectedSha = run.head_sha;
  } else if (eventName === 'workflow_dispatch') {
    requested = event.inputs?.version || 'latest';
    if (typeof requested !== 'string' || requested.trim() !== requested) throw new Error('Invalid manual version');
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(requested)) versionOf(`caws-cli-v${requested}`);
  } else {
    throw new Error(`Unsupported matrix event: ${eventName}`);
  }
  const metadata = view(`${packageName}@${requested}`);
  const version = versionOf(`caws-cli-v${metadata.version}`);
  if (expectedSha && (version !== requested || metadata.gitHead !== expectedSha)) {
    throw new Error('Registry version/commit differs from the successful release run');
  }
  // A numeric request is an exact version, never a moving registry channel.
  if (/^[0-9]/.test(requested) && version !== requested) throw new Error('Registry returned a different version');
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata['dist.integrity'] ?? '')) {
    throw new Error('Registry package integrity is missing or malformed');
  }
  return { package: packageName, requested, version, gitHead: metadata.gitHead ?? null,
    integrity: metadata['dist.integrity'], source: eventName, releaseRunId: event.workflow_run?.id ?? null };
}

export function main(env = process.env) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const target = resolveTarget(env.GITHUB_EVENT_NAME, event, spec => {
    const r = spawnSync('npm', ['view', spec, 'version', 'gitHead', 'dist.integrity', '--json', '--workspaces=false'],
      { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`Registry lookup failed: ${r.error?.message ?? r.stderr}`);
    return JSON.parse(r.stdout);
  });
  fs.appendFileSync(env.GITHUB_OUTPUT, `version=${target.version}\n`);
  fs.writeFileSync('matrix-target.json', JSON.stringify(target, null, 2) + '\n');
  console.log(JSON.stringify(target));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
