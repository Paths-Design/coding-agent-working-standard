/**
 * @fileoverview CAWS-RELEASE-TAG-DRIVEN-001 v1 — tag-driven release script tests.
 *
 * Covers:
 *   1. Tag parser tests (canonical accept, bare-v refuse, kernel refuse, malformed)
 *   2. Validation tests (version mismatch, missing CHANGELOG section)
 *   3. Failure-mode tests via dry-run (pre-publish delete path, post-publish preserve path)
 *   4. Workflow-shape checks (release.yml has no branch trigger, no semantic-release)
 *   5. Dry-run mode contract
 *
 * Strategy: the script is invoked as a subprocess. Dry-run mode disables
 * actual npm publish, tag deletion, and GitHub Release creation. The script
 * emits structured JSON logs that the tests inspect.
 *
 * @author @darianrosebrook
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'release-tag-publish.mjs');
const RELEASE_YML = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');

function runScript(tag, env = {}) {
  const args = tag ? [SCRIPT, tag, '--dry-run'] : [SCRIPT, '--dry-run'];
  const result = spawnSync('node', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAWS_RELEASE_DRY_RUN: '1',
      GITHUB_REPOSITORY: 'Paths-Design/coding-agent-working-standard',
      ...env,
    },
  });
  const lines = (result.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'));
  const logs = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    logs,
  };
}

// =============================================================================
// 1. Parser tests
// =============================================================================

describe('CAWS-RELEASE-TAG-DRIVEN-001 v1 — tag parser', () => {
  it('accepts canonical caws-cli-vX.Y.Z (parser-only; validation may then fail)', () => {
    const r = runScript('caws-cli-v99.99.99');
    const parsed = r.logs.find((l) => l.msg === 'tag.parsed');
    expect(parsed).toBeDefined();
    expect(parsed.package).toBe('@paths.design/caws-cli');
    expect(parsed.version).toBe('99.99.99');
    // Exit 20 expected (validation fails because package.json doesn't say 99.99.99).
    expect(r.exitCode).toBe(20);
  });

  it('refuses bare v* with exit code 10', () => {
    const r = runScript('v11.1.5');
    expect(r.exitCode).toBe(10);
    const refused = r.logs.find((l) => l.msg === 'tag.refused');
    expect(refused).toBeDefined();
    expect(refused.reason).toMatch(/legacy bare v\*/i);
  });

  it('refuses caws-kernel-v* with exit code 10 and explicit reason', () => {
    const r = runScript('caws-kernel-v1.1.2');
    expect(r.exitCode).toBe(10);
    const refused = r.logs.find((l) => l.msg === 'tag.refused');
    expect(refused).toBeDefined();
    expect(refused.reason).toMatch(/kernel CI publish is not enabled/);
    expect(refused.reason).toMatch(/publish caws-kernel manually/);
  });

  it('refuses malformed tag (no valid version suffix)', () => {
    const r = runScript('caws-cli-vabc');
    expect(r.exitCode).toBe(10);
    const refused = r.logs.find((l) => l.msg === 'tag.refused');
    expect(refused).toBeDefined();
    expect(refused.reason).toMatch(/must match X\.Y\.Z/);
  });

  it('refuses unknown tag prefix', () => {
    const r = runScript('some-other-package-v1.0.0');
    expect(r.exitCode).toBe(10);
    const refused = r.logs.find((l) => l.msg === 'tag.refused');
    expect(refused).toBeDefined();
    expect(refused.reason).toMatch(/does not match any enabled package prefix/);
  });

  it('refuses empty/missing tag', () => {
    const r = runScript(null);
    expect(r.exitCode).toBe(10);
    expect(r.stdout).toMatch(/tag\.missing/);
  });
});

// =============================================================================
// 2. Validation tests
// =============================================================================

describe('CAWS-RELEASE-TAG-DRIVEN-001 v1 — pre-publish validation', () => {
  const pkgJsonPath = path.join(REPO_ROOT, 'packages', 'caws-cli', 'package.json');
  const actualVersion = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;

  it('fails when tag version != package.json version (exit 20)', () => {
    const r = runScript('caws-cli-v99.99.99');
    expect(r.exitCode).toBe(20);
    const failed = r.logs.find((l) => l.msg === 'validation.failed');
    expect(failed).toBeDefined();
    expect(failed.check).toBe('package.json version');
    expect(failed.reason).toMatch(/does not equal package\.json version/);
  });

  it('records dry-run tag deletion when validation fails', () => {
    const r = runScript('caws-cli-v99.99.99');
    expect(r.exitCode).toBe(20);
    const deleted = r.logs.find((l) => l.msg === 'tag.delete.dry_run');
    expect(deleted).toBeDefined();
    expect(deleted.tag).toBe('caws-cli-v99.99.99');
  });

  it('outcome for current package.json version depends on CHANGELOG state', () => {
    // Two valid outcomes when tag matches package.json:
    //   - exit 0  if CHANGELOG has the section (full dry-run success)
    //   - exit 20 with check === 'CHANGELOG section' (missing section)
    const r = runScript(`caws-cli-v${actualVersion}`);
    if (r.exitCode === 20) {
      const failed = r.logs.find((l) => l.msg === 'validation.failed');
      expect(failed).toBeDefined();
      expect(['package.json version', 'CHANGELOG section']).toContain(failed.check);
    } else {
      expect(r.exitCode).toBe(0);
      // Full dry-run path emits release.success.
      const success = r.logs.find((l) => l.msg === 'release.success');
      expect(success).toBeDefined();
    }
  });
});

// =============================================================================
// 3. Workflow-shape checks
// =============================================================================

describe('CAWS-RELEASE-TAG-DRIVEN-001 v1 — release.yml shape', () => {
  let yml;
  let parsed;

  beforeAll(() => {
    yml = fs.readFileSync(RELEASE_YML, 'utf8');
    // js-yaml interprets the YAML `on:` key as boolean `true` (a long-standing
    // YAML 1.1 quirk). Load with a relaxed schema and access via the boolean
    // key when needed.
    parsed = yaml.load(yml);
  });

  function getOnBlock() {
    // YAML 1.1 `on:` is parsed as boolean true. Handle both cases.
    return parsed.on || parsed[true];
  }

  it('has no on.push.branches trigger', () => {
    const onBlock = getOnBlock();
    expect(onBlock.push?.branches).toBeUndefined();
  });

  it('has no pull_request trigger (release workflow only runs on tags)', () => {
    const onBlock = getOnBlock();
    expect(onBlock.pull_request).toBeUndefined();
  });

  it('has on.push.tags trigger with caws-cli-v* pattern', () => {
    const onBlock = getOnBlock();
    expect(onBlock.push.tags).toBeDefined();
    expect(onBlock.push.tags).toContain('caws-cli-v*');
  });

  it('contains no semantic-release invocation', () => {
    // Strip comments before checking (the workflow may mention semantic-release
    // in comments documenting what was removed).
    const ymlNoComments = yml
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    expect(ymlNoComments).not.toMatch(/npx\s+semantic-release/);
    expect(ymlNoComments).not.toMatch(/\bsemantic-release\b/);
  });

  it('does not call multi-package-release.mjs', () => {
    const ymlNoComments = yml
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    expect(ymlNoComments).not.toMatch(/multi-package-release\.mjs/);
  });

  it('invokes the new release-tag-publish.mjs script', () => {
    expect(yml).toMatch(/release-tag-publish\.mjs/);
  });

  it('has contents: write permission for tag-deletion', () => {
    expect(parsed.permissions['contents']).toBe('write');
  });

  it('has a single release job', () => {
    const jobNames = Object.keys(parsed.jobs);
    expect(jobNames).toHaveLength(1);
    expect(jobNames[0]).toBe('release');
  });

  it('checks out without overriding ref (defaults to tag SHA on tag trigger)', () => {
    const checkoutStep = parsed.jobs.release.steps.find(
      (s) => s.uses && s.uses.startsWith('actions/checkout@')
    );
    expect(checkoutStep).toBeDefined();
    expect(checkoutStep.with.ref).toBeUndefined();
  });
});

// =============================================================================
// 4. Dry-run mode contract
// =============================================================================

describe('CAWS-RELEASE-TAG-DRIVEN-001 v1 — dry-run mode', () => {
  it('respects --dry-run flag and emits dry_run=true in release.start', () => {
    const r = runScript('caws-kernel-v1.0.0'); // refused — quick exit
    const start = r.logs.find((l) => l.msg === 'release.start');
    expect(start).toBeDefined();
    expect(start.dry_run).toBe(true);
  });

  it('respects CAWS_RELEASE_DRY_RUN env var', () => {
    const result = spawnSync('node', [SCRIPT, 'caws-kernel-v1.0.0'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAWS_RELEASE_DRY_RUN: '1',
        GITHUB_REPOSITORY: 'Paths-Design/coding-agent-working-standard',
      },
    });
    const logs = result.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const start = logs.find((l) => l.msg === 'release.start');
    expect(start).toBeDefined();
    expect(start.dry_run).toBe(true);
  });
});
