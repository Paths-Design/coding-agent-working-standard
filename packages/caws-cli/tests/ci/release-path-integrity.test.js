'use strict';

// Contract tests for CAWS-RELEASE-PATH-INTEGRITY-001.
//
// These execute the ACTUAL workflow `run:` blocks and the ACTUAL assertion
// script rather than re-implementing their logic, so a future edit that
// narrows a guard or reintroduces a fail-open is caught here instead of in
// production. Asserting on a copy of the logic would prove nothing about the
// file CI runs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const packageRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(packageRoot, '../..');
const temporary = [];

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-release-path-')));
  temporary.push(root);
  return root;
}

function workflow(name) {
  return yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8'));
}

function step(wf, job, name) {
  const found = wf.jobs[job].steps.find((entry) => entry.name === name);
  if (!found) throw new Error(`step "${name}" not found in job "${job}"`);
  return found;
}

afterAll(() => {
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A2 — the shadow-file guard's pattern coverage.
// ---------------------------------------------------------------------------

/** Run the real "Block shadow file patterns" step against a controlled diff. */
function runShadowGuard(changedPaths) {
  const guard = step(workflow('pr-checks.yml'), 'sanity', 'Block shadow file patterns');
  const root = fixture();
  // Shim git so the step sees exactly the paths under test. The step is what
  // is being exercised; git's diff behaviour is not.
  fs.writeFileSync(
    path.join(root, 'git'),
    `#!/bin/sh\nprintf '%s\\n' ${changedPaths.map((p) => `'${p}'`).join(' ')}\n`,
    { mode: 0o755 }
  );
  return spawnSync('/bin/bash', ['-e', '-c', guard.run], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, BASE_REF: 'base', HEAD_REF: 'head' },
    encoding: 'utf8',
  });
}

describe('shadow-file guard pattern coverage', () => {
  // Each of these was enforced by the deleted caws-guards.yml. The three
  // marked (restored) were silently dropped when the job was consolidated
  // into pr-checks.yml and are the reason this test exists.
  test.each([
    ['src/handler-copy.ts', 'copy suffix (doctrine)'],
    ['src/handler-final.ts', 'final suffix (doctrine)'],
    ['src/handler-enhanced.ts', 'enhanced suffix (doctrine)'],
    ['src/handler_copy.ts', 'underscore suffix (doctrine)'],
    ['src/final.ts', 'segment-initial'],
    ['src/new-handler.ts', 'new- prefix'],
    ['src/report - copy.ts', 'windows copy'],
    ['src/duplicate-handler.ts', 'duplicate- prefix (restored)'],
    ['src/backup-config.json', 'backup- prefix (restored)'],
    ['src/config.backup', '.backup suffix (restored)'],
    ['backup-config.json', 'repo-root shadow file'],
  ])('%s is blocked (%s)', (changed) => {
    const result = runShadowGuard([changed]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(changed);
  });

  test('ordinary paths pass', () => {
    const result = runShadowGuard(['src/handler.ts', 'docs/guide.md', 'packages/api/v2/route.ts']);
    expect(result.status).toBe(0);
  });

  test('version-named files are left to the advisory hook, not blocked', () => {
    // All three are tracked in-tree. A blocking gate cannot separate a
    // version-named module from a versioned shadow copy, so it must not try;
    // .caws/hooks/naming-check.sh still flags these advisorily on write.
    for (const legitimate of [
      'packages/caws-cli/src/kernel/schemas/telemetry/turn-log.v2.json',
      'packages/caws-cli/src/kernel/spec/migrate-v10.ts',
      'docs/migration-v10-to-v11.md',
    ]) {
      expect(runShadowGuard([legitimate]).status).toBe(0);
    }
  });

  test('an empty diff passes without matching the blank line', () => {
    expect(runShadowGuard([]).status).toBe(0);
  });

  test('files that detect the anti-pattern are allowlisted, near-misses are not', () => {
    // These exist in-tree; the guard must not fire when they change.
    expect(runShadowGuard(['.caws/hooks/duplicate-export-check.sh']).status).toBe(0);
    expect(runShadowGuard(['packages/caws-cli/templates/hook-packs/shared/duplicate-export-check.sh']).status).toBe(0);
    // The allowlist is anchored and exact: a real shadow file must not be
    // able to hide behind a legitimate neighbour's name.
    expect(runShadowGuard(['src/duplicate-export-check.sh']).status).toBe(1);
    expect(runShadowGuard(['.caws/hooks/duplicate-export-check.sh.backup']).status).toBe(1);
  });

  test('every tracked file passes the guard', () => {
    // A widened pattern that matches existing files would fail CI on any PR
    // touching them. This pins the guard against the real repository.
    const tracked = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    expect(tracked.status).toBe(0);
    const files = tracked.stdout.split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const result = runShadowGuard(files);
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A3 — the per-file mutation floor gates a tag publish.
// ---------------------------------------------------------------------------

// YAML 1.1 parses a bare `on:` key as boolean true, so GitHub workflow
// triggers land under wf[true] rather than wf.on. Read both.
const triggersOf = (wf) => wf.on ?? wf[true];

describe('mutation floor gates the release', () => {
  test('the publish job cannot start unless mutation succeeded', () => {
    const release = workflow('release.yml');
    const needs = release.jobs.release.needs;
    // needs may be a string or a list; normalise before asserting.
    const blocking = Array.isArray(needs) ? needs : [needs];
    expect(blocking).toContain('mutation');
    expect(blocking).toContain('qualification');
    // A `needs` entry only blocks if the job it names actually exists.
    for (const job of blocking) expect(release.jobs[job]).toBeDefined();
  });

  test('the release mutation job runs the full floor, not harness integrity alone', () => {
    const release = workflow('release.yml');
    expect(release.jobs.mutation.uses).toBe('./.github/workflows/mutation.yml');
    expect(release.jobs.mutation.with.required).toBe(true);
  });

  test('mutation.yml honours the required input over its pull_request condition', () => {
    const mutation = workflow('mutation.yml');
    const callable = triggersOf(mutation).workflow_call;
    expect(callable).toBeDefined();
    expect(callable.inputs.required.type).toBe('boolean');
    // Default false keeps mutation off the per-PR critical path.
    expect(callable.inputs.required.default).toBe(false);
    // The full-floor job must consult the input; without this the release
    // caller would fall through to the label/event condition.
    expect(mutation.jobs.mutation.if).toContain('inputs.required');
    expect(mutation.jobs.mutation.needs).toBe('harness_integrity');
  });
});
