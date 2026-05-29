/**
 * @fileoverview DANGER-LATCH-CALIBRATION-001 — classify_command.py
 * calibration acceptance harness.
 *
 * Strategy: shell out to `python3 classify_command.py` once per fixture,
 * pipe the candidate command via stdin, parse the JSON decision from
 * stdout. The script under test is the shipped template at
 * packages/caws-cli/templates/hook-packs/claude-code/classify_command.py,
 * NOT the maintainer-local .claude/hooks/classify_command.py.
 *
 * The harness is hybrid fail-closed (per the spec invariant): unknown
 * git/gh/npm subcommands and the documented read-only allow-list are
 * the only surfaces calibrated. Other commands keep the existing
 * classifier default. Universal-fail-closed is explicitly out of scope.
 *
 * TDD posture: many of these tests are expected to FAIL until the
 * classifier is calibrated. The test names mark which acceptance
 * criterion (A1..A11) each fixture covers, plus negative-fixture
 * suites for quote-safety.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLASSIFIER = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code',
  'classify_command.py'
);

/**
 * Pipe a command string through the classifier and return parsed JSON.
 * Throws if python3 is missing, the classifier crashes, or output is
 * not valid JSON.
 */
function classify(cmd) {
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', REPO_ROOT, '--home', '/tmp/fake-home', '--cwd', REPO_ROOT],
    {
      input: cmd,
      encoding: 'utf8',
      timeout: 5000,
    }
  );
  if (r.error) {
    throw new Error(`classifier invocation failed: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `classifier exited ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`classifier produced non-JSON stdout: ${r.stdout}`);
  }
}

// ===========================================================================
// A1 — Read-only file inspection (`tail`) is admitted
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A1: read-only file inspection allowed', () => {
  it('tail -n 50 /tmp/foo.log → allow', () => {
    const { decision } = classify('tail -n 50 /tmp/foo.log');
    expect(decision).toBe('allow');
  });

  it('head -200 .github/workflows/release.yml → allow', () => {
    const { decision } = classify('head -200 .github/workflows/release.yml');
    expect(decision).toBe('allow');
  });

  it('cat README.md → allow', () => {
    const { decision } = classify('cat README.md');
    expect(decision).toBe('allow');
  });

  it('wc -l packages/caws-cli/src/index.js → allow', () => {
    const { decision } = classify('wc -l packages/caws-cli/src/index.js');
    expect(decision).toBe('allow');
  });

  it('stat README.md → allow', () => {
    const { decision } = classify('stat README.md');
    expect(decision).toBe('allow');
  });

  it('ls -la packages/ → allow', () => {
    const { decision } = classify('ls -la packages/');
    expect(decision).toBe('allow');
  });

  it('grep -n "tag" scripts/release-tag-publish.mjs → allow', () => {
    const { decision } = classify('grep -n "tag" scripts/release-tag-publish.mjs');
    expect(decision).toBe('allow');
  });

  it('rg --files-with-matches "classify" packages/ → allow', () => {
    const { decision } = classify('rg --files-with-matches "classify" packages/');
    expect(decision).toBe('allow');
  });
});

// ===========================================================================
// A2 — Read-only gh subcommands are admitted
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A2: read-only gh subcommands allowed', () => {
  it('gh pr view 5 --json statusCheckRollup → allow', () => {
    const { decision } = classify('gh pr view 5 --json statusCheckRollup');
    expect(decision).toBe('allow');
  });

  it('gh pr checks 5 → allow', () => {
    const { decision } = classify('gh pr checks 5');
    expect(decision).toBe('allow');
  });

  it('gh pr list --state open → allow', () => {
    const { decision } = classify('gh pr list --state open');
    expect(decision).toBe('allow');
  });

  it('gh pr status → allow', () => {
    const { decision } = classify('gh pr status');
    expect(decision).toBe('allow');
  });

  it('gh run view 123 --log-failed → allow', () => {
    const { decision } = classify('gh run view 123 --log-failed');
    expect(decision).toBe('allow');
  });

  it('gh run list --workflow=ci.yml → allow', () => {
    const { decision } = classify('gh run list --workflow=ci.yml');
    expect(decision).toBe('allow');
  });

  it('gh api /repos/foo/bar (no -X, defaults to GET) → allow', () => {
    const { decision } = classify('gh api /repos/foo/bar');
    expect(decision).toBe('allow');
  });

  it('gh api -X GET /repos/foo/bar → allow', () => {
    const { decision } = classify('gh api -X GET /repos/foo/bar');
    expect(decision).toBe('allow');
  });

  it('gh release view caws-cli-v11.1.5 → allow', () => {
    const { decision } = classify('gh release view caws-cli-v11.1.5');
    expect(decision).toBe('allow');
  });
});

// ===========================================================================
// A3 — Mutating gh pr subcommands are REJECTED by allow-list
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A3: mutating gh pr subcommands NOT allow', () => {
  it('gh pr merge 5 --squash → NOT allow', () => {
    const { decision } = classify('gh pr merge 5 --squash');
    expect(decision).not.toBe('allow');
  });

  it('gh pr edit 5 --title "x" → NOT allow', () => {
    const { decision } = classify('gh pr edit 5 --title "x"');
    expect(decision).not.toBe('allow');
  });

  it('gh pr close 5 → NOT allow', () => {
    const { decision } = classify('gh pr close 5');
    expect(decision).not.toBe('allow');
  });

  it('gh pr reopen 5 → NOT allow', () => {
    const { decision } = classify('gh pr reopen 5');
    expect(decision).not.toBe('allow');
  });

  it('gh pr ready 5 → NOT allow', () => {
    const { decision } = classify('gh pr ready 5');
    expect(decision).not.toBe('allow');
  });

  it('gh pr comment 5 --body "x" → NOT allow', () => {
    const { decision } = classify('gh pr comment 5 --body "x"');
    expect(decision).not.toBe('allow');
  });
});

// ===========================================================================
// A4 — Mutating gh run subcommands are REJECTED by allow-list
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A4: mutating gh run subcommands NOT allow', () => {
  it('gh run rerun 12345 → NOT allow', () => {
    const { decision } = classify('gh run rerun 12345');
    expect(decision).not.toBe('allow');
  });

  it('gh run cancel 12345 → NOT allow', () => {
    const { decision } = classify('gh run cancel 12345');
    expect(decision).not.toBe('allow');
  });

  it('gh workflow run release.yml → NOT allow', () => {
    const { decision } = classify('gh workflow run release.yml');
    expect(decision).not.toBe('allow');
  });

  it('gh release create caws-cli-v99.99.99 → NOT allow', () => {
    const { decision } = classify('gh release create caws-cli-v99.99.99');
    expect(decision).not.toBe('allow');
  });
});

// ===========================================================================
// A5 — gh api with mutating -X verbs is REJECTED
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A5: gh api mutating verbs NOT allow', () => {
  it('gh api -X POST /repos/foo/bar/pulls → NOT allow', () => {
    const { decision } = classify('gh api -X POST /repos/foo/bar/pulls');
    expect(decision).not.toBe('allow');
  });

  it('gh api -X PUT /repos/foo/bar → NOT allow', () => {
    const { decision } = classify('gh api -X PUT /repos/foo/bar');
    expect(decision).not.toBe('allow');
  });

  it('gh api -X PATCH /repos/foo/bar → NOT allow', () => {
    const { decision } = classify('gh api -X PATCH /repos/foo/bar');
    expect(decision).not.toBe('allow');
  });

  it('gh api -X DELETE /repos/foo/bar/git/refs/tags/x → NOT allow', () => {
    const { decision } = classify('gh api -X DELETE /repos/foo/bar/git/refs/tags/x');
    expect(decision).not.toBe('allow');
  });
});

// ===========================================================================
// A6 — Existing destructive deny patterns NOT weakened
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A6: destructive denies preserved', () => {
  it('git push --force origin main → ask (existing behavior NOT weakened)', () => {
    const { decision, reason } = classify('git push --force origin main');
    expect(decision).not.toBe('allow');
    expect(reason.toLowerCase()).toContain('force');
  });

  it('git reset --hard HEAD → ask (existing)', () => {
    const { decision } = classify('git reset --hard HEAD');
    expect(decision).not.toBe('allow');
  });

  it('git rebase main → ask (existing)', () => {
    const { decision } = classify('git rebase main');
    expect(decision).not.toBe('allow');
  });

  it('git cherry-pick abc1234 → ask (existing)', () => {
    const { decision } = classify('git cherry-pick abc1234');
    expect(decision).not.toBe('allow');
  });

  it('read-only git is still allow: git status → allow', () => {
    const { decision } = classify('git status');
    expect(decision).toBe('allow');
  });

  it('read-only git is still allow: git log --oneline -5 → allow', () => {
    const { decision } = classify('git log --oneline -5');
    expect(decision).toBe('allow');
  });

  it('read-only git is still allow: git diff HEAD~1 → allow', () => {
    const { decision } = classify('git diff HEAD~1');
    expect(decision).toBe('allow');
  });
});

// ===========================================================================
// A7 — rm -rf hard-blocks preserved
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A7: rm -rf denies preserved', () => {
  it('rm -rf /Users/darian/important → ask or deny (NOT allow)', () => {
    const { decision } = classify('rm -rf /Users/darian/important');
    expect(decision).not.toBe('allow');
  });

  it('rm -rf / → deny', () => {
    const { decision } = classify('rm -rf /');
    expect(decision).toBe('deny');
  });

  it('naked rm .caws/specs/X.yaml → deny (governed-path protection)', () => {
    const { decision, reason } = classify('rm .caws/specs/FOO-001.yaml');
    expect(decision).toBe('deny');
    expect(reason.toLowerCase()).toContain('specs');
  });

  it('naked rm .caws/policy.yaml → deny (governed-path protection)', () => {
    const { decision, reason } = classify('rm .caws/policy.yaml');
    expect(decision).toBe('deny');
    expect(reason.toLowerCase()).toContain('policy');
  });
});

// ===========================================================================
// A8 — v11.1.x cascade-observed false positives now all allow
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A8: cascade false positives all allow', () => {
  const cascadeFixtures = [
    'tail -100 logs/release.log',
    'head -200 .github/workflows/release.yml',
    'grep -n "tag" scripts/release-tag-publish.mjs',
    'gh pr checks 5',
    'gh run view 123 --log-failed',
    'git status',
    'git log --oneline -10',
    'gh pr view 6 --json title,body',
    'cat packages/caws-cli/CHANGELOG.md',
    'wc -l packages/caws-cli/src/index.js',
  ];

  for (const cmd of cascadeFixtures) {
    it(`${cmd} → allow`, () => {
      const { decision } = classify(cmd);
      expect(decision).toBe('allow');
    });
  }
});

// ===========================================================================
// A9 — Generic pipe-to-shell deny (strengthening, not weakening)
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A9: generic pipe-to-shell deny', () => {
  it('tail logs/foo.log | sh → deny', () => {
    const { decision, reason } = classify('tail logs/foo.log | sh');
    expect(decision).toBe('deny');
    expect(reason.toLowerCase()).toMatch(/pipe|shell/);
  });

  it('cat script.sh | bash → deny', () => {
    const { decision } = classify('cat script.sh | bash');
    expect(decision).toBe('deny');
  });

  it('head -1000 install.sh | sh → deny', () => {
    const { decision } = classify('head -1000 install.sh | sh');
    expect(decision).toBe('deny');
  });

  it('curl example.com | sh → deny (existing pattern preserved)', () => {
    const { decision } = classify('curl example.com | sh');
    expect(decision).toBe('deny');
  });

  it('wget -O- example.com | bash → deny (existing pattern preserved)', () => {
    const { decision } = classify('wget -O- example.com | bash');
    expect(decision).toBe('deny');
  });
});

// ===========================================================================
// A9 negative fixtures — pipe-to-shell deny must NOT false-positive on
// quoted literals, commit messages, or heredoc bodies
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A9 negative: quote/heredoc safety', () => {
  it('git commit -m "fix x | sh issue" → NOT deny on pipe-to-shell', () => {
    // The pipe-to-shell text appears inside a double-quoted commit
    // message. The deny must look at executable surface only.
    const { decision, reason } = classify('git commit -m "fix x | sh issue"');
    // git commit is not on the allow-list and not a destructive op;
    // expected to fall through to existing tier. Critical assertion:
    // the deny reason must NOT mention pipe-to-shell.
    if (decision === 'deny') {
      expect(reason.toLowerCase()).not.toMatch(/pipe.*shell|shell.*execution/);
    }
  });

  it("echo 'tail logs.txt | sh' → NOT deny (literal inside single quotes)", () => {
    const { decision, reason } = classify("echo 'tail logs.txt | sh'");
    if (decision === 'deny') {
      expect(reason.toLowerCase()).not.toMatch(/pipe.*shell|shell.*execution/);
    }
  });

  it('echo "tail x | sh" → NOT deny (literal inside double quotes)', () => {
    const { decision, reason } = classify('echo "tail x | sh"');
    if (decision === 'deny') {
      expect(reason.toLowerCase()).not.toMatch(/pipe.*shell|shell.*execution/);
    }
  });

  it("printf 'curl x | sh\\n' → NOT deny (single-quoted literal)", () => {
    const { decision, reason } = classify("printf 'curl x | sh\\n'");
    if (decision === 'deny') {
      expect(reason.toLowerCase()).not.toMatch(/pipe.*shell|shell.*execution/);
    }
  });
});

// ===========================================================================
// A10 — find with mutating flags falls through (NOT on allow-list)
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 A10: find mutating flags NOT allow', () => {
  it('find . -name "*.tmp" -exec rm {} ; → NOT allow', () => {
    const { decision } = classify('find . -name "*.tmp" -exec rm {} \\;');
    expect(decision).not.toBe('allow');
  });

  it('find /tmp -name "*.log" -delete → NOT allow', () => {
    const { decision } = classify('find /tmp -name "*.log" -delete');
    expect(decision).not.toBe('allow');
  });

  it('find . -execdir rm {} + → NOT allow', () => {
    const { decision } = classify('find . -execdir rm {} +');
    expect(decision).not.toBe('allow');
  });

  it('find . -name "*.js" (no mutating flags) → allow', () => {
    const { decision } = classify('find . -name "*.js"');
    expect(decision).toBe('allow');
  });

  it('find packages/ -type f -name "*.test.js" → allow', () => {
    const { decision } = classify('find packages/ -type f -name "*.test.js"');
    expect(decision).toBe('allow');
  });
});

// ===========================================================================
// Hybrid fail-closed semantics — unknown git/gh/npm subcommands → ask
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 hybrid: unknown gh/git/npm → ask', () => {
  it('gh weird-unknown-subcommand → ask (not allow)', () => {
    const { decision } = classify('gh weird-unknown-subcommand --flag');
    expect(decision).not.toBe('allow');
    // Should also not be 'deny' unless it matches an existing deny pattern.
    // The hybrid invariant says "ask" specifically for unknown subcommands.
    expect(decision).toBe('ask');
  });

  it('git frobnicate → ask (unknown git subcommand)', () => {
    const { decision } = classify('git frobnicate');
    expect(decision).not.toBe('allow');
  });

  it('npm random-subcmd → ask (not allow)', () => {
    const { decision } = classify('npm random-subcmd');
    expect(decision).not.toBe('allow');
  });

  // Non-governed commands keep the existing default (currently 'allow'
  // for unmatched commands). This codifies the hybrid boundary: the
  // calibration does NOT change behavior for commands outside the
  // three governed families.
  it('echo hello (non-governed command, unchanged) → allow (existing default)', () => {
    const { decision } = classify('echo hello');
    expect(decision).toBe('allow');
  });

  it('date (non-governed command, unchanged) → allow (existing default)', () => {
    const { decision } = classify('date');
    expect(decision).toBe('allow');
  });
});

// ===========================================================================
// Allow-list anchoring — `gh-pr-view-fake-script` does NOT match `gh pr view`
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 anchoring: no false-positive substring matches', () => {
  it('gh-pr-view-fake-script does NOT match gh pr view allow', () => {
    // This command's binary basename is gh-pr-view-fake-script, not gh.
    // The allow-list must NOT admit it.
    const { decision } = classify('gh-pr-view-fake-script');
    expect(decision).not.toBe('allow');
  });

  it('git-foo (hyphenated) does NOT match git allow', () => {
    const { decision } = classify('git-foo --version');
    expect(decision).not.toBe('allow');
  });
});

// ===========================================================================
// Wrapper safety — env / time / nohup prefixes must not bypass classifier
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 wrappers: env/time/nohup respected', () => {
  it('env FOO=bar gh pr view 5 → allow (env wrapper transparent)', () => {
    const { decision } = classify('env FOO=bar gh pr view 5');
    expect(decision).toBe('allow');
  });

  it('time gh pr view 5 → allow (time wrapper transparent)', () => {
    const { decision } = classify('time gh pr view 5');
    expect(decision).toBe('allow');
  });

  it('env GIT_DIR=/tmp/.git git push --force → NOT allow (env does not hide push)', () => {
    const { decision } = classify('env GIT_DIR=/tmp/.git git push --force');
    expect(decision).not.toBe('allow');
  });

  it('time git push --force origin main → NOT allow (time does not hide push)', () => {
    const { decision } = classify('time git push --force origin main');
    expect(decision).not.toBe('allow');
  });
});

// ===========================================================================
// Command substitution — deny inside $(...) still escalates
// ===========================================================================

describe('DANGER-LATCH-CALIBRATION-001 substitution: $(...) deny still escalates', () => {
  it('echo $(rm -rf /tmp/x) → escalates to ask or deny via substitution', () => {
    // The outer `echo` is allow, but the substitution body `rm -rf /tmp/x`
    // is a recursive delete — escalates the overall decision.
    const { decision } = classify('echo $(rm -rf /tmp/x)');
    expect(decision).not.toBe('allow');
  });

  it('echo `git push --force origin main` → escalates via backtick substitution', () => {
    const { decision } = classify('echo `git push --force origin main`');
    expect(decision).not.toBe('allow');
  });
});

// ===========================================================================
// DANGER-LATCH-WORKFLOW-CALIBRATION-001 — admit everyday git workflow writes
//
// The prior read-only-only allow-list swept plain `git add` / `git commit`
// into "unknown git subcommand -> ask", and an `ask` engages the sticky
// session latch. That trapped agents on the CAWS-documented happy path
// (commit the spec on main, then create the worktree). This slice admits
// the non-destructive everyday-workflow writes while keeping every
// destructive variant governed. See failure-lineage Entry 17.
// ===========================================================================

describe('DANGER-LATCH-WORKFLOW-CALIBRATION-001 A1: plain add/commit allowed', () => {
  it('git add path.py → allow', () => {
    expect(classify('git add path.py').decision).toBe('allow');
  });

  it('git commit -m "msg" → allow', () => {
    expect(classify('git commit -m "msg"').decision).toBe('allow');
  });

  it('git add -A && git commit -m "feat: x" → allow (full commit loop)', () => {
    expect(classify('git add -A && git commit -m "feat: x"').decision).toBe('allow');
  });

  it('git commit message mentioning a dangerous phrase stays allow (quote-safe)', () => {
    // The dangerous phrase is inside the quoted commit message, not
    // executable surface — must not trip a deny/confirm pattern.
    expect(classify('git commit -m "fix: handle git push --force edge case"').decision).toBe('allow');
  });
});

describe('DANGER-LATCH-WORKFLOW-CALIBRATION-001 A2: commit --amend stays ask', () => {
  it('git commit --amend -m "rewrite" → ask (never allow)', () => {
    const { decision, reason } = classify('git commit --amend -m "rewrite"');
    expect(decision).toBe('ask');
    expect(reason.toLowerCase()).toContain('amend');
  });

  it('git commit --amend --no-edit → ask (never allow)', () => {
    expect(classify('git commit --amend --no-edit').decision).toBe('ask');
  });
});

describe('DANGER-LATCH-WORKFLOW-CALIBRATION-001 A3: branch-create allowed, discard stays governed', () => {
  it('git checkout -b feature → allow', () => {
    expect(classify('git checkout -b feature').decision).toBe('allow');
  });

  it('git switch -c feature → allow', () => {
    expect(classify('git switch -c feature').decision).toBe('allow');
  });

  it('git switch main → allow (switch refuses to clobber dirty tree)', () => {
    expect(classify('git switch main').decision).toBe('allow');
  });

  it('git checkout . → ask (discards all changes)', () => {
    expect(classify('git checkout .').decision).not.toBe('allow');
  });

  it('git checkout main → ask (bare checkout to existing ref not auto-admitted)', () => {
    expect(classify('git checkout main').decision).not.toBe('allow');
  });

  it('git switch -f main → ask (force discards local state)', () => {
    expect(classify('git switch -f main').decision).not.toBe('allow');
  });
});

describe('DANGER-LATCH-WORKFLOW-CALIBRATION-001 A4: no destructive regression', () => {
  const mustNotAllow = [
    'git push --force origin main',
    'git push -f origin main',
    'git reset --hard HEAD~1',
    'git rebase main',
    'git cherry-pick abc123',
    'git clean -fd',
    'rm -rf /Users/x/important',
    // Entry 17 bootstrap family — flag-split variants must still engage.
    'git init',
    'git --bare init',
    'git -C /tmp/foo init',
  ];
  mustNotAllow.forEach((cmd) => {
    it(`${cmd} → NOT allow (regression guard)`, () => {
      expect(classify(cmd).decision).not.toBe('allow');
    });
  });
});
