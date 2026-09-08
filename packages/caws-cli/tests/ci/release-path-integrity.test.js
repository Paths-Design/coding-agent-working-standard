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

// ---------------------------------------------------------------------------
// A4 — a failure before the publish script must not orphan the tag.
// ---------------------------------------------------------------------------

/**
 * Execute the real "Roll back the tag when the publish script never ran" step.
 * `gh` is shimmed so tag-ref reads and deletes are controllable.
 */
function runRollback({ markerPresent, deleteSucceeds, refStillExists }) {
  const rollback = step(workflow('release.yml'), 'release', 'Roll back the tag when the publish script never ran');
  const root = fixture();
  const marker = path.join(root, 'marker');
  if (markerPresent) fs.writeFileSync(marker, 'caws-cli-v12.2.0-rc.1\n');
  const calls = path.join(root, 'gh-calls.txt');
  fs.writeFileSync(
    path.join(root, 'gh'),
    `#!/bin/sh\n` +
      `echo "$@" >> '${calls}'\n` +
      `case "$2" in\n` +
      `  -X) ${deleteSucceeds ? 'exit 0' : 'exit 1'} ;;\n` +
      `  *)  ${refStillExists ? 'exit 0' : 'exit 1'} ;;\n` +
      `esac\n`,
    { mode: 0o755 }
  );
  const result = spawnSync('/bin/bash', ['-e', '-c', rollback.run], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      CAWS_RELEASE_SCRIPT_MARKER: marker,
      GITHUB_REPOSITORY: 'fixture/repo',
      GITHUB_REF_NAME: 'caws-cli-v12.2.0-rc.1',
    },
    encoding: 'utf8',
  });
  return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

describe('tag rollback for failures before the publish script', () => {
  test('the step is wired to run on failure and is not the publish step itself', () => {
    const release = workflow('release.yml');
    const rollback = step(release, 'release', 'Roll back the tag when the publish script never ran');
    expect(rollback.if).toBe('failure()');
    // Both steps must agree on the marker path or the handoff is broken.
    const publish = step(release, 'release', 'Run tag-driven publish');
    expect(publish.env.CAWS_RELEASE_SCRIPT_MARKER).toBe(rollback.env.CAWS_RELEASE_SCRIPT_MARKER);
  });

  test('a script that ran keeps its own tag decision', () => {
    const result = runRollback({ markerPresent: true, deleteSucceeds: true, refStillExists: true });
    expect(result.status).toBe(0);
    // Critically: no delete attempted. Exit 12 deliberately leaves the tag,
    // and exit 30 preserves it after a publish; overriding either would
    // destroy provenance for an already-published package.
    expect(result.calls).toBe('');
  });

  test('a failure before the script deletes the orphaned tag', () => {
    const result = runRollback({ markerPresent: false, deleteSucceeds: true, refStillExists: true });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('-X DELETE repos/fixture/repo/git/refs/tags/caws-cli-v12.2.0-rc.1');
  });

  test('an already-absent tag is not an error', () => {
    // The script deletes the tag itself on exit 20; if the marker write was
    // what failed, this step must tolerate the tag already being gone.
    const result = runRollback({ markerPresent: false, deleteSucceeds: false, refStillExists: false });
    expect(result.status).toBe(0);
  });

  test('a tag that survives a failed delete reports a repair command', () => {
    const result = runRollback({ markerPresent: false, deleteSucceeds: false, refStillExists: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('gh api -X DELETE repos/fixture/repo/git/refs/tags/caws-cli-v12.2.0-rc.1');
  });
});
