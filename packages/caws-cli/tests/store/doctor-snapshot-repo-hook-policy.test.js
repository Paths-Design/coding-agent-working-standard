'use strict';

/**
 * CAWS-HOOKS-POLICY-DOCTOR-RULES-01 — the STORE half: the observations that
 * feed the four repo-hook-policy rules, measured against a real filesystem
 * and the real shipped templates.
 *
 * The kernel test pins what the classifier does with rows. This one pins that
 * the rows are true: that a fork's upstream verdict is computed from the
 * ACTUAL shipped bytes (not a version number), that chain staleness is
 * measured through the same resolver `caws hooks compile` writes with, and
 * that an absent policy yields undefined rather than a synthesized empty.
 *
 * SUT loaded from dist/ (store tests build first). Fixture repos are temp
 * directories, not git repos — the observers take a repoRoot and do not shell
 * out, which is itself part of the contract.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  observeRepoHookPolicy,
  observeLegacyAdapterPolicy,
  shippedHandlerProvenance,
} = require('../../dist/init/hook-install');
const { SHARED_PACK_VERSION } = require('../../dist/init/hook-packs/manifest-shared');
const { policyDigest, expectedChain } = require('../../dist/init/hook-chain');
const {
  effectiveRepoSurfacePolicy,
  parseRepoHookPolicy,
} = require('../../dist/init/repo-hook-policy');

const TEMPLATES = path.resolve(__dirname, '../../templates/hook-packs/shared');

const made = [];
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-policy-doctor-'));
  made.push(root);
  fs.mkdirSync(path.join(root, '.caws/hooks/dispatch'), { recursive: true });
  return root;
}

/** Install the real shipped dispatchers so the stock chain is the real one. */
function installDispatchers(root, events) {
  for (const event of events) {
    fs.copyFileSync(
      path.join(TEMPLATES, 'dispatch', `${event}.sh`),
      path.join(root, '.caws/hooks/dispatch', `${event}.sh`)
    );
  }
}

function writePolicy(root, policy) {
  const text = typeof policy === 'string' ? policy : JSON.stringify(policy, null, 2);
  fs.writeFileSync(path.join(root, '.caws/hooks/hook-policy.json'), text, 'utf8');
  return text;
}

/** Compile the sidecars exactly as `caws hooks compile` would. */
function compile(root, events) {
  const policyPath = path.join(root, '.caws/hooks/hook-policy.json');
  const text = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, 'utf8') : null;
  const parsed = parseRepoHookPolicy(text);
  if (!parsed.ok) throw new Error(`fixture policy is invalid: ${parsed.error}`);
  const dispatchDir = path.join(root, '.caws/hooks/dispatch');
  for (const event of events) {
    const rendered = expectedChain(
      dispatchDir,
      event,
      effectiveRepoSurfacePolicy(parsed.policy, 'default'),
      policyDigest(text)
    );
    if ('error' in rendered) throw new Error(`fixture compile failed: ${rendered.error}`);
    fs.writeFileSync(path.join(dispatchDir, `${event}.chain`), rendered.text, 'utf8');
  }
}

function policyWithFork(handler, sha256, packVersion) {
  return {
    version: 1,
    surfaces: {
      default: {
        handlers: { [handler]: '.caws/hooks/ext/local.sh' },
        forks: {
          [handler]: {
            forked_from: { pack: 'shared', pack_version: packVersion, sha256 },
            reason: 'this repo keeps its core in native/, which the shipped table does not know',
            approver: 'maintainer',
          },
        },
      },
    },
  };
}

afterAll(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('observeRepoHookPolicy: absence, invalidity and emptiness are three different things', () => {
  test('A6: a repo with no hook-policy.json observes UNDEFINED, not an empty policy', () => {
    expect(observeRepoHookPolicy(makeRepo())).toBeUndefined();
  });

  test('A4: unparseable JSON observes invalid, carrying the parser message — never undefined', () => {
    const root = makeRepo();
    writePolicy(root, '{ "version": 1, ');
    const observed = observeRepoHookPolicy(root);
    expect(observed.kind).toBe('invalid');
    expect(observed.error.length).toBeGreaterThan(0);
  });

  test('A4: valid JSON the VALIDATOR rejects is invalid too — a floor handler may not be disabled', () => {
    const root = makeRepo();
    writePolicy(root, {
      version: 1,
      surfaces: {
        default: {
          disabled: {
            pre_tool_use: [{ handler: 'protected-paths.sh', reason: 'it keeps refusing my edits' }],
          },
        },
      },
    });
    const observed = observeRepoHookPolicy(root);
    expect(observed.kind).toBe('invalid');
    // The message must name the handler, or the operator cannot find the key.
    expect(observed.error).toContain('protected-paths.sh');
  });

  test('an EMPTY but valid policy observes valid with no rows — opting in is not a finding', () => {
    const root = makeRepo();
    writePolicy(root, { version: 1, surfaces: {} });
    const observed = observeRepoHookPolicy(root);
    expect(observed).toEqual({ kind: 'valid', forks: [], staleChains: [] });
  });
});

describe('fork provenance is measured against the real shipped bytes', () => {
  test('a fork recording the CURRENT shipped sha256 reports upstreamChange=false', () => {
    const shipped = shippedHandlerProvenance('scope-guard.sh');
    expect(shipped).not.toBeNull();
    const root = makeRepo();
    writePolicy(root, policyWithFork('scope-guard.sh', shipped.sha256, shipped.pack_version));
    const observed = observeRepoHookPolicy(root);
    expect(observed.forks).toHaveLength(1);
    expect(observed.forks[0]).toMatchObject({
      surface: 'default',
      handler: 'scope-guard.sh',
      recordedPack: 'shared',
      shippingPackVersion: SHARED_PACK_VERSION,
      upstreamChange: false,
    });
  });

  test('A1: a fork recording a STALE sha256 reports upstreamChange=true with the real shipping version', () => {
    const root = makeRepo();
    writePolicy(root, policyWithFork('scope-guard.sh', 'a'.repeat(64), 67));
    const observed = observeRepoHookPolicy(root);
    expect(observed.forks[0]).toMatchObject({
      handler: 'scope-guard.sh',
      recordedPackVersion: 67,
      shippingPackVersion: SHARED_PACK_VERSION,
      upstreamChange: true,
    });
  });

  test('A2: the version number is NOT the discriminator — a stale version with a current sha256 is unchanged', () => {
    const shipped = shippedHandlerProvenance('scope-guard.sh');
    const root = makeRepo();
    // Recorded 16 packs back, but the handler itself never moved.
    writePolicy(root, policyWithFork('scope-guard.sh', shipped.sha256, 67));
    const observed = observeRepoHookPolicy(root);
    expect(observed.forks[0].recordedPackVersion).toBe(67);
    expect(observed.forks[0].upstreamChange).toBe(false);
  });

  test('a fork of a handler the pack does not ship OMITS upstreamChange — unobserved, not "unchanged"', () => {
    const root = makeRepo();
    writePolicy(root, policyWithFork('not-a-shipped-guard.sh', 'b'.repeat(64), 80));
    const observed = observeRepoHookPolicy(root);
    expect(observed.forks).toHaveLength(1);
    expect('upstreamChange' in observed.forks[0]).toBe(false);
  });

  test('forks under a NAMED surface are observed and attributed to that surface', () => {
    const shipped = shippedHandlerProvenance('scope-guard.sh');
    const root = makeRepo();
    writePolicy(root, {
      version: 1,
      surfaces: {
        codex: {
          handlers: { 'scope-guard.sh': '.caws/hooks/ext/codex-scope.sh' },
          forks: {
            'scope-guard.sh': {
              forked_from: { pack: 'shared', pack_version: 70, sha256: 'c'.repeat(64) },
              reason: 'codex needs a wider allow table than the shipped default provides',
              approver: 'maintainer',
            },
          },
        },
      },
    });
    const observed = observeRepoHookPolicy(root);
    expect(observed.forks[0]).toMatchObject({ surface: 'codex', upstreamChange: true });
    expect(shipped.sha256).not.toBe('c'.repeat(64));
  });
});

describe('A3: chain staleness is measured through the resolver compile writes with', () => {
  const EVENTS = ['pre_tool_use', 'session_start'];

  test('freshly compiled sidecars report NO stale chains', () => {
    const root = makeRepo();
    installDispatchers(root, EVENTS);
    writePolicy(root, {
      version: 1,
      surfaces: {
        default: {
          extensions: {
            pre_tool_use: [
              {
                handler: 'repo-lint.sh',
                before: null,
                reason: 'this repo lints generated protobuf stubs on write',
              },
            ],
          },
          handlers: { 'repo-lint.sh': '.caws/hooks/ext/repo-lint.sh' },
        },
      },
    });
    compile(root, EVENTS);
    expect(observeRepoHookPolicy(root).staleChains).toEqual([]);
  });

  test('a policy with NO compiled sidecar at all reports every installed event stale', () => {
    const root = makeRepo();
    installDispatchers(root, EVENTS);
    writePolicy(root, { version: 1, surfaces: {} });
    const stale = observeRepoHookPolicy(root).staleChains;
    expect(stale.map((row) => row.event).sort()).toEqual([...EVENTS].sort());
    expect(stale[0].reason).toBe('no compiled chain on disk');
  });

  test('editing the policy after compiling makes the sidecar stale, and the reason says so', () => {
    const root = makeRepo();
    installDispatchers(root, EVENTS);
    writePolicy(root, { version: 1, surfaces: {} });
    compile(root, EVENTS);
    expect(observeRepoHookPolicy(root).staleChains).toEqual([]);

    // One variable changes: the policy document. Same dispatchers, same pack.
    writePolicy(root, {
      version: 1,
      surfaces: {
        default: {
          extensions: {
            pre_tool_use: [
              {
                handler: 'repo-lint.sh',
                before: null,
                reason: 'this repo lints generated protobuf stubs on write',
              },
            ],
          },
          handlers: { 'repo-lint.sh': '.caws/hooks/ext/repo-lint.sh' },
        },
      },
    });
    // EVERY sidecar goes stale, not just the event the edit touched: the
    // header records the digest of the whole document, so a compiled chain is
    // only ever current with respect to one exact policy file. That is
    // deliberate — `caws hooks compile` rewrites all of them in one pass, and
    // reporting per-event would make doctor disagree with
    // `caws hooks compile --check`, which is the split-brain the shared
    // comparator exists to prevent.
    const stale = observeRepoHookPolicy(root).staleChains;
    expect(stale.map((row) => row.event).sort()).toEqual([...EVENTS].sort());
    for (const row of stale) {
      expect(row.reason).toBe('compiled against a different hook-policy.json');
    }
  });

  test('a HAND-EDITED sidecar whose header still matches is caught by the body comparison', () => {
    const root = makeRepo();
    installDispatchers(root, EVENTS);
    writePolicy(root, { version: 1, surfaces: {} });
    compile(root, EVENTS);
    const chainPath = path.join(root, '.caws/hooks/dispatch/pre_tool_use.chain');
    const text = fs.readFileSync(chainPath, 'utf8');
    const lines = text.split('\n');
    // Drop a guard from the middle of the chain, leaving the header intact —
    // the exact shape a digest-only comparison would call fresh.
    fs.writeFileSync(chainPath, [lines[0], ...lines.slice(2)].join('\n'), 'utf8');
    const stale = observeRepoHookPolicy(root).staleChains;
    expect(stale.map((row) => row.event)).toEqual(['pre_tool_use']);
    expect(stale[0].reason).toBe('compiled chain body differs from the current policy');
  });

  test('an event with no installed dispatcher is not reported: there is nothing to be stale against', () => {
    const root = makeRepo();
    installDispatchers(root, ['pre_tool_use']);
    writePolicy(root, { version: 1, surfaces: {} });
    const stale = observeRepoHookPolicy(root).staleChains;
    expect(stale.map((row) => row.event)).toEqual(['pre_tool_use']);
  });

  test('a repo with no dispatch directory still observes its forks — the chain half fails open alone', () => {
    const root = makeRepo();
    fs.rmSync(path.join(root, '.caws/hooks/dispatch'), { recursive: true, force: true });
    writePolicy(root, policyWithFork('scope-guard.sh', 'd'.repeat(64), 70));
    const observed = observeRepoHookPolicy(root);
    expect(observed.kind).toBe('valid');
    expect(observed.forks).toHaveLength(1);
    expect(observed.staleChains).toEqual([]);
  });
});

describe('A5: the legacy adapter-policy observation', () => {
  test('present is true, absent is false, and it does not depend on hook-policy.json', () => {
    const root = makeRepo();
    expect(observeLegacyAdapterPolicy(root)).toBe(false);
    fs.writeFileSync(
      path.join(root, '.caws/hooks/adapter-policy.json'),
      JSON.stringify({ events: { pre_tool_use: { hooks_dir: '.caws/hooks', handlers: [] } } }),
      'utf8'
    );
    expect(observeLegacyAdapterPolicy(root)).toBe(true);
    expect(observeRepoHookPolicy(root)).toBeUndefined();
  });
});

describe('the snapshot composes these observations for a real repo', () => {
  test('composeDoctorSnapshot carries the observation, and inspectProjectState fires on it', () => {
    const { composeDoctorSnapshot } = require('../../dist/store');
    const { inspectProjectState, DOCTOR_RULES } = require('../../dist/kernel');
    const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');

    const repoRoot = makeTempRepo();
    try {
      fs.mkdirSync(path.join(repoRoot, '.caws/hooks/dispatch'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/hook-policy.json'),
        JSON.stringify(policyWithFork('scope-guard.sh', 'e'.repeat(64), 67), null, 2),
        'utf8'
      );
      const { doctorInput } = composeDoctorSnapshot({
        repoRoot,
        cawsDir: path.join(repoRoot, '.caws'),
        now: new Date(),
      });
      expect(doctorInput.filesystem.repoHookPolicy).toMatchObject({ kind: 'valid' });
      expect(doctorInput.filesystem.repoHookPolicy.forks[0]).toMatchObject({
        handler: 'scope-guard.sh',
        upstreamChange: true,
      });
      const report = inspectProjectState(doctorInput);
      expect(report.findings.map((f) => f.rule)).toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG);
    } finally {
      cleanupAll();
    }
  });

  test('the RENDERED `caws doctor` output names all four rules — proving the renderer, not just the classifier', () => {
    const { execFileSync } = require('child_process');
    const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');

    const repoRoot = makeTempRepo();
    try {
      const dispatchDir = path.join(repoRoot, '.caws/hooks/dispatch');
      fs.mkdirSync(dispatchDir, { recursive: true });
      installDispatchers(repoRoot, ['pre_tool_use']);
      // Legacy file present AND a fork whose upstream moved AND an uncompiled
      // chain — three of the four rules from one repo state.
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/adapter-policy.json'),
        JSON.stringify({ events: {} }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(repoRoot, '.caws/hooks/hook-policy.json'),
        JSON.stringify(policyWithFork('scope-guard.sh', 'f'.repeat(64), 67), null, 2),
        'utf8'
      );
      // Doctor exits non-zero when it reports an error-severity finding, and
      // the invalid-policy half of this test deliberately produces one — so
      // the stdout is read off the thrown result rather than treating a
      // non-zero exit as a harness failure.
      const render = () => {
        try {
          return execFileSync(
            process.execPath,
            [path.resolve(__dirname, '../../dist/index.js'), 'doctor'],
            { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
          );
        } catch (e) {
          if (typeof e.stdout === 'string' && e.stdout.length > 0) return e.stdout;
          throw new Error(`doctor produced no stdout: ${e.stderr || e.message}`);
        }
      };
      const first = render();
      expect(first).toContain('doctor.hooks.repo_policy_fork_lag');
      expect(first).toContain('doctor.hooks.repo_policy_chain_stale');
      expect(first).toContain('doctor.hooks.legacy_adapter_policy');
      // The prose a human actually reads must carry the numbers, not just the id.
      expect(first).toContain('shared@67');

      // One variable changes — the document stops parsing — and the rendered
      // verdict flips to the error, with the other two policy rules gone.
      fs.writeFileSync(path.join(repoRoot, '.caws/hooks/hook-policy.json'), '{ oops', 'utf8');
      const second = render();
      expect(second).toContain('doctor.hooks.repo_policy_invalid');
      expect(second).not.toContain('doctor.hooks.repo_policy_fork_lag');
      expect(second).not.toContain('doctor.hooks.repo_policy_chain_stale');
      // …and the legacy rule is unaffected, because it reads a different file.
      expect(second).toContain('doctor.hooks.legacy_adapter_policy');
    } finally {
      cleanupAll();
    }
  });
});
