'use strict';

/**
 * Store-side evidence re-derivation (CAWS-SPECS-VERIFY-ACS-REDERIVE-001):
 * A1 (existence ≠ pass), A3 (fabrication classes), A5 (no agent string
 * executes), A6 (bounded subprocess), A7 (argv injection), A9 (merge-stage
 * classes spawn only git), A13 (no false green on infra failure).
 *
 * Drives the REAL compiled executor against a REAL temp git repository that
 * carries a jest package (js/), a pytest package (py/), a tracked artifact,
 * and an orphan commit no ref reaches. Runner spawns are real where the
 * assertion is about runner behavior, and a recording spy where the
 * assertion is about WHAT is spawned.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const {
  buildRederivationReport,
  rederiveSpecEvidence,
  detectTestRunner,
  describeVerdict,
} = require('../../dist/store/evidence-rederive');
const { resolveGitBinary, resetGitBinaryCache } = require('../../dist/store/git-binary');
const { planRederivation } = require('../../dist/kernel');

// jest's package exports hide bin/jest.js from require.resolve; the hoisted
// .bin symlink at the repo root is the same file the CLI would find.
const JEST_BIN = fs.realpathSync(path.resolve(__dirname, '../../../../node_modules/.bin/jest'));

// pytest is not part of this package's toolchain (CI's main test job has no
// python setup). Real-pytest cases run only where it exists; the
// pytest-missing path is pinned unconditionally below with a spy.
const HAS_PYTEST =
  require('child_process').spawnSync('python3', ['-m', 'pytest', '--version'], { encoding: 'utf8' })
    .status === 0;
const describeWithPytest = HAS_PYTEST ? describe : describe.skip;

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
});

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/**
 * Two commits: c1 has the runner fixtures, c2 adds docs/report.md. An orphan
 * commit (no ref) proves the unreachable class.
 */
function mkFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rederive-'));
  repos.push(root);
  git(root, ['init', '--quiet', '-b', 'main']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);

  write(root, 'js/jest.config.js', "module.exports = { testEnvironment: 'node' };\n");
  write(
    root,
    'js/tests/sample.test.js',
    [
      "test('adds', () => { expect(1 + 1).toBe(2); });",
      "test('fails on purpose', () => { expect(1).toBe(2); });",
      '',
    ].join('\n')
  );
  write(root, 'js/tests/hang.test.js', "test('hangs', () => { for (;;) {} });\n");
  write(root, 'py/conftest.py', '');
  write(
    root,
    'py/tests/test_sample.py',
    [
      'def test_passes():',
      '    assert True',
      '',
      'def test_fails():',
      '    assert 1 == 2',
      '',
    ].join('\n')
  );
  write(root, 'plain/tests/orphan.test.js', "test('x', () => {});\n");
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'c1']);
  const c1 = git(root, ['rev-parse', 'HEAD']);

  write(root, 'docs/report.md', '# report\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'c2']);
  const c2 = git(root, ['rev-parse', 'HEAD']);

  const orphan = git(root, ['commit-tree', `${c2}^{tree}`, '-m', 'orphan']);

  // The runner is resolved from the repo's own node_modules, never npx.
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(JEST_BIN, path.join(root, 'node_modules', '.bin', 'jest'));

  return { root, c1, c2, orphan };
}

function spec(entries) {
  // entries: { A1: {commit_sha, artifact_path, test_nodeid, command} , ... }
  const ids = Object.keys(entries);
  return {
    acceptance: ids.map((id) => ({ id, given: 'g', when: 'w', then: 't' })),
    evidence: ids
      .filter((id) => entries[id] !== null)
      .map((id) => ({
        criterion_id: id,
        status: 'pass',
        recorded_at: '2026-09-16T12:00:00.000Z',
        ...entries[id],
      })),
  };
}

const ALL = ['citation', 'artifact', 'test'];

function outcomesFor(root, s, opts) {
  const plan = planRederivation(s);
  const report = buildRederivationReport(root, plan, { classes: ALL, runTests: false, ...opts });
  return report.outcomes;
}

/** A spy execFile that records every spawn and returns ok. */
function spyExec() {
  const calls = [];
  const fn = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    return '';
  };
  return { fn, calls };
}

// ─── citation class (A3) ─────────────────────────────────────────────────────

describe('citation checks', () => {
  test('full and abbreviated shas of a reachable commit pass, with the reaching ref named', () => {
    const { root, c2 } = mkFixtureRepo();
    const o = outcomesFor(
      root,
      spec({ A1: { commit_sha: c2 }, A2: { commit_sha: c2.slice(0, 8) } })
    );
    expect(o.A1[0].outcome).toBe('passed');
    expect(o.A1[0].detail).toContain('reachable from refs/heads/main');
    expect(o.A2[0].outcome).toBe('passed');
  });

  test('a sha that is no object -> missing; an orphan commit -> unreachable; garbage -> refused', () => {
    const { root, orphan } = mkFixtureRepo();
    const o = outcomesFor(
      root,
      spec({
        A1: { commit_sha: 'deadbeefcafe' },
        A2: { commit_sha: orphan },
        A3: { commit_sha: 'not-a-sha!' },
      })
    );
    expect(o.A1[0].outcome).toBe('missing');
    expect(o.A1[0].detail).toContain('is not an object');
    expect(o.A2[0].outcome).toBe('unreachable');
    expect(o.A2[0].detail).toContain('no ref reaches it');
    expect(o.A3[0].outcome).toBe('refused');
    expect(o.A3[0].detail).toContain('not a hex object id');
  });
});

// ─── artifact class (A3) ─────────────────────────────────────────────────────

describe('artifact checks', () => {
  test('tracked at HEAD -> passed; absent -> missing; on disk but untracked -> missing with remediation', () => {
    const { root } = mkFixtureRepo();
    write(root, 'scratch/untracked.md', 'x');
    const o = outcomesFor(
      root,
      spec({
        A1: { artifact_path: 'docs/report.md' },
        A2: { artifact_path: 'docs/nope.md' },
        A3: { artifact_path: 'scratch/untracked.md' },
      })
    );
    expect(o.A1[0].outcome).toBe('passed');
    expect(o.A1[0].detail).toBe('docs/report.md present at HEAD');
    expect(o.A2[0].outcome).toBe('missing');
    expect(o.A2[0].detail).toBe('docs/nope.md not found at HEAD');
    expect(o.A3[0].outcome).toBe('missing');
    expect(o.A3[0].detail).toContain('on disk but not tracked at HEAD; commit it');
  });

  test('anchored at the criterion citation: report.md is absent at c1 and present at c2', () => {
    const { root, c1, c2 } = mkFixtureRepo();
    const o = outcomesFor(
      root,
      spec({
        A1: { commit_sha: c1, artifact_path: 'docs/report.md' },
        A2: { commit_sha: c2, artifact_path: 'docs/report.md' },
      })
    );
    expect(o.A1.map((x) => x.outcome)).toEqual(['passed', 'missing']);
    expect(o.A1[1].detail).toBe(
      `docs/report.md is tracked at HEAD but absent at cited ${c1}; cite the commit that added it`
    );
    expect(o.A2.map((x) => x.outcome)).toEqual(['passed', 'passed']);
    expect(o.A2[1].detail).toBe(`docs/report.md present at ${c2}`);
  });

  test('absolute and escaping paths are refused before any spawn', () => {
    const { root } = mkFixtureRepo();
    const { fn, calls } = spyExec();
    const o = outcomesFor(
      root,
      spec({ A1: { artifact_path: '/etc/passwd' }, A2: { artifact_path: '../outside.md' } }),
      { execFile: fn }
    );
    expect(o.A1[0].outcome).toBe('refused');
    expect(o.A2[0].outcome).toBe('refused');
    expect(calls).toHaveLength(0);
  });
});

// ─── test class: jest (A1) ───────────────────────────────────────────────────

describe('jest re-derivation', () => {
  test('existence-only on a PASSING test is not_run, never passed (A1)', () => {
    const { root } = mkFixtureRepo();
    const o = outcomesFor(root, spec({ A1: { test_nodeid: 'js/tests/sample.test.js::adds' } }), {
      runTests: false,
    });
    expect(o.A1[0].outcome).toBe('not_run');
    expect(o.A1[0].detail).toContain('not executed');
  });

  test('existence-only on a FAILING test is also not_run — collected is neither pass nor fail (A1)', () => {
    const { root } = mkFixtureRepo();
    const o = outcomesFor(
      root,
      spec({ A1: { test_nodeid: 'js/tests/sample.test.js::fails on purpose' } }),
      { runTests: false }
    );
    expect(o.A1[0].outcome).toBe('not_run');
  });

  test('--run: passing -> passed; failing -> failed with the runner exit named', () => {
    const { root } = mkFixtureRepo();
    const o = outcomesFor(
      root,
      spec({
        A1: { test_nodeid: 'js/tests/sample.test.js::adds' },
        A2: { test_nodeid: 'js/tests/sample.test.js::fails on purpose' },
      }),
      { runTests: true }
    );
    expect(o.A1[0].outcome).toBe('passed');
    expect(o.A2[0].outcome).toBe('failed');
    expect(o.A2[0].detail).toMatch(/^jest exit 1:/);
  });

  test('unknown test name or missing file -> missing, without spawning', () => {
    const { root } = mkFixtureRepo();
    const { fn, calls } = spyExec();
    const o = outcomesFor(
      root,
      spec({
        A1: { test_nodeid: 'js/tests/sample.test.js::no such test' },
        A2: { test_nodeid: 'js/tests/missing.test.js::x' },
      }),
      { runTests: true, execFile: fn }
    );
    expect(o.A1[0].outcome).toBe('missing');
    expect(o.A1[0].detail).toContain('"no such test" not found');
    expect(o.A2[0].outcome).toBe('missing');
    expect(o.A2[0].detail).toContain('test file not found');
    expect(calls).toHaveLength(0);
  });

  test('jest not installed in the repo -> unavailable, and npx is not reached for', () => {
    const { root } = mkFixtureRepo();
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
    const { fn, calls } = spyExec();
    const o = outcomesFor(root, spec({ A1: { test_nodeid: 'js/tests/sample.test.js::adds' } }), {
      runTests: true,
      execFile: fn,
    });
    expect(o.A1[0].outcome).toBe('unavailable');
    expect(o.A1[0].detail).toContain('npx is deliberately not used');
    expect(calls).toHaveLength(0);
  });

  test('a hanging test hits the bound -> timeout, and leaves no child behind (A6)', () => {
    const { root } = mkFixtureRepo();
    const started = Date.now();
    const o = outcomesFor(root, spec({ A1: { test_nodeid: 'js/tests/hang.test.js::hangs' } }), {
      runTests: true,
      timeouts: { run: 3000 },
    });
    const elapsed = Date.now() - started;
    expect(o.A1[0].outcome).toBe('timeout');
    expect(o.A1[0].detail).toContain('was killed');
    expect(elapsed).toBeLessThan(20000);
    // No orphan: nothing under this process still references the hanging file.
    const ps = execSync('ps -axo ppid=,command=', { encoding: 'utf8' });
    const orphans = ps
      .split('\n')
      .filter((l) => l.includes('hang.test.js') && l.trim().startsWith(String(process.pid)));
    expect(orphans).toEqual([]);
  });
});

// ─── test class: pytest (A1) ─────────────────────────────────────────────────

describe('pytest not installed (A13)', () => {
  test('python3 present but no pytest module -> unavailable, never missing', () => {
    const { root } = mkFixtureRepo();
    const calls = [];
    const fn = (file, args) => {
      calls.push({ file, args });
      throw Object.assign(new Error('Command failed'), {
        status: 1,
        stdout: '',
        stderr: '/usr/bin/python3: No module named pytest\n',
      });
    };
    const o = outcomesFor(
      root,
      spec({ A1: { test_nodeid: 'py/tests/test_sample.py::test_passes' } }),
      {
        runTests: true,
        execFile: fn,
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('python3');
    expect(o.A1[0].outcome).toBe('unavailable');
    expect(o.A1[0].detail).toBe('pytest is not installed for python3 (No module named pytest)');
  });
});

describeWithPytest('pytest re-derivation', () => {
  test('existence-only -> not_run with the collected count; --run passing -> passed; failing -> failed', () => {
    const { root } = mkFixtureRepo();
    const collect = outcomesFor(
      root,
      spec({ A1: { test_nodeid: 'py/tests/test_sample.py::test_passes' } }),
      { runTests: false }
    );
    expect(collect.A1[0].outcome).toBe('not_run');
    expect(collect.A1[0].detail).toMatch(/^1 item\(s\) collected; not executed$/);

    const run = outcomesFor(
      root,
      spec({
        A1: { test_nodeid: 'py/tests/test_sample.py::test_passes' },
        A2: { test_nodeid: 'py/tests/test_sample.py::test_fails' },
      }),
      { runTests: true }
    );
    expect(run.A1[0].outcome).toBe('passed');
    expect(run.A2[0].outcome).toBe('failed');
    expect(run.A2[0].detail).toMatch(/^pytest exit 1:/);
  });

  test('a nodeid pytest cannot collect -> missing', () => {
    const { root } = mkFixtureRepo();
    const o = outcomesFor(
      root,
      spec({ A1: { test_nodeid: 'py/tests/test_sample.py::test_nope' } }),
      { runTests: true }
    );
    expect(o.A1[0].outcome).toBe('missing');
  });
});

// ─── argv injection (A7) ─────────────────────────────────────────────────────

describe('argv injection is refused before any spawn (A7)', () => {
  test.each(['--collect-only', '-p no:cacheprovider', '-x'])(
    '%s is refused with zero spawns',
    (nodeid) => {
      const { root } = mkFixtureRepo();
      const { fn, calls } = spyExec();
      const o = outcomesFor(root, spec({ A1: { test_nodeid: nodeid } }), {
        runTests: true,
        execFile: fn,
      });
      expect(o.A1[0].outcome).toBe('refused');
      expect(o.A1[0].detail).toContain('begins with "-"');
      expect(calls).toHaveLength(0);
    }
  );

  test('a shell metacharacter string reaches pytest as one operand after --, never a shell', () => {
    const { root } = mkFixtureRepo();
    const hostile = 'py/tests/test_sample.py::; rm -rf /tmp/x';
    const { fn, calls } = spyExec();
    outcomesFor(root, spec({ A1: { test_nodeid: hostile } }), { runTests: false, execFile: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('python3');
    const args = calls[0].args;
    const dd = args.indexOf('--');
    expect(dd).toBeGreaterThan(-1);
    expect(args.slice(dd + 1)).toEqual(['tests/test_sample.py::; rm -rf /tmp/x']);
    expect(calls[0].options.timeout).toBeGreaterThan(0);
    expect(calls[0].options.killSignal).toBe('SIGKILL');
    expect(calls[0].options.maxBuffer).toBeGreaterThan(0);

    // And for real: pytest simply cannot collect it.
    const real = outcomesFor(root, spec({ A1: { test_nodeid: hostile } }), { runTests: true });
    expect(real.A1[0].outcome).toBe('missing');
    expect(fs.existsSync('/tmp/x')).toBe(false);
  });
});

// ─── merge-stage class selection (A9, store half) ────────────────────────────

describe('class selection', () => {
  test("classes ['citation','artifact'] spawns only git; the test check is not_run", () => {
    const { root, c2 } = mkFixtureRepo();
    const { fn, calls } = spyExec();
    const plan = planRederivation(
      spec({
        A1: {
          commit_sha: c2,
          artifact_path: 'docs/report.md',
          test_nodeid: 'js/tests/sample.test.js::adds',
          command: 'touch /tmp/caws-exec-probe',
        },
      })
    );
    const report = buildRederivationReport(root, plan, {
      classes: ['citation', 'artifact'],
      runTests: true,
      execFile: fn,
    });
    const gitBin = resolveGitBinary();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.file).toBe(gitBin);
    const test = report.outcomes.A1.find((o) => o.class === 'test');
    expect(test.outcome).toBe('not_run');
    expect(test.detail).toBe('not selected at this stage');
    // command never produces an outcome — the executor skips it entirely.
    expect(report.outcomes.A1.some((o) => o.class === 'command')).toBe(false);
  });
});

// ─── command never executes (A5, store half) ─────────────────────────────────

describe('command is never executed (A5)', () => {
  test('a command citing touch leaves no file and produces no spawn of anything but the selected classes', () => {
    const { root } = mkFixtureRepo();
    const probe = path.join(os.tmpdir(), `caws-exec-probe-${process.pid}`);
    fs.rmSync(probe, { force: true });
    const { fn, calls } = spyExec();
    const s = spec({ A1: { command: `touch ${probe}`, exit_code: 0 } });
    const r = rederiveSpecEvidence(root, s, { classes: ALL, runTests: true, execFile: fn });
    expect(calls).toHaveLength(0);
    expect(r.verdicts[0].verdict).toBe('not_rederived');
    expect(r.verdicts[0].reason).toBe('command_not_executed');
    // Real executor, same spec: still no file.
    rederiveSpecEvidence(root, s, { classes: ALL, runTests: true });
    expect(fs.existsSync(probe)).toBe(false);
  });
});

// ─── runner detection and unavailability ─────────────────────────────────────

describe('runner detection and unavailable outcomes', () => {
  test('detectTestRunner reads the fixture dirs', () => {
    const { root } = mkFixtureRepo();
    expect(detectTestRunner(path.join(root, 'js'))).toBe('jest');
    expect(detectTestRunner(path.join(root, 'py'))).toBe('pytest');
    expect(detectTestRunner(path.join(root, 'plain'))).toBe('unknown');
    expect(detectTestRunner(root)).toBe('unknown');
  });

  test('no runner config above the nodeid -> unavailable, naming what was looked for', () => {
    const { root } = mkFixtureRepo();
    const o = outcomesFor(root, spec({ A1: { test_nodeid: 'plain/tests/orphan.test.js::x' } }), {
      runTests: true,
    });
    expect(o.A1[0].outcome).toBe('unavailable');
    expect(o.A1[0].detail).toContain('no test runner detected');
  });

  test('a detected-but-unimplemented runner (vitest override) -> unavailable, not a silent pass', () => {
    const { root } = mkFixtureRepo();
    const { fn, calls } = spyExec();
    const o = outcomesFor(root, spec({ A1: { test_nodeid: 'js/tests/sample.test.js::adds' } }), {
      runTests: true,
      runner: 'vitest',
      execFile: fn,
    });
    expect(o.A1[0].outcome).toBe('unavailable');
    expect(o.A1[0].detail).toContain('runner vitest detected; re-derivation is not implemented');
    expect(calls).toHaveLength(0);
  });
});

// ─── no false green on infrastructure failure (A13, store half) ──────────────

describe('infrastructure failure never reads as clean (A13)', () => {
  test('CAWS_GIT_BINARY=/nonexistent -> every git-backed check is unavailable; summary has zero verified', () => {
    const { root, c2 } = mkFixtureRepo();
    const prev = process.env.CAWS_GIT_BINARY;
    process.env.CAWS_GIT_BINARY = '/nonexistent/git';
    resetGitBinaryCache();
    try {
      const r = rederiveSpecEvidence(
        root,
        spec({ A1: { commit_sha: c2 }, A2: { artifact_path: 'docs/report.md' } }),
        {
          classes: ALL,
          runTests: false,
        }
      );
      expect(r.report.outcomes.A1[0].outcome).toBe('unavailable');
      expect(r.report.outcomes.A2[0].outcome).toBe('unavailable');
      expect(r.summary.verified).toBe(0);
      expect(r.summary.not_rederived).toBe(2);
      for (const v of r.verdicts) expect(v.reason).toBe('runner_unavailable');
    } finally {
      if (prev === undefined) delete process.env.CAWS_GIT_BINARY;
      else process.env.CAWS_GIT_BINARY = prev;
      resetGitBinaryCache();
    }
  });
});

// ─── end to end (A2, store half) + describeVerdict (A12) ─────────────────────

describe('rederiveSpecEvidence', () => {
  test('one verified, one refuted, one narrative -> 1/1/1, and the lines read as self-reported', () => {
    const { root, c2 } = mkFixtureRepo();
    const r = rederiveSpecEvidence(
      root,
      spec({
        A1: { commit_sha: c2 },
        A2: { artifact_path: 'docs/nope.md' },
        A3: { evidence_ref: 'trust me' },
      }),
      { classes: ALL, runTests: false }
    );
    expect(r.summary).toEqual({
      total: 3,
      verified: 1,
      refuted: 1,
      not_rederived: 1,
      narrative_only: 1,
      self_reported: 2,
      command_declared: 0,
    });
    const lines = r.verdicts.map(describeVerdict);
    expect(lines[0]).toMatch(
      /^A1: verified \(passed\) — commit .* reachable from refs\/heads\/main \[self-reported\]$/
    );
    expect(lines[1]).toBe(
      'A2: refuted (artifact_missing) — docs/nope.md not found at HEAD [self-reported]'
    );
    expect(lines[2]).toBe('A3: not_rederived (no_mechanical_field)');
  });
});
