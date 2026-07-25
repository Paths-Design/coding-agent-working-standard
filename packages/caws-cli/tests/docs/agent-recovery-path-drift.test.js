'use strict';

// Pins the agent-facing RECOVERY PATH surfaces against the v11 reset-script
// location. The strike/latch reset scripts live under the CAWS vendored hooks
// tree (.caws/hooks/), NOT under the harness vendor dir (.claude/hooks/).
//
// Why this test exists: an agent is (correctly) forbidden from clearing its own
// strikes or danger latch, so it must hand a command to a human. Every surface
// that names that command is a recovery path for a HARD BLOCK. When the path is
// wrong, both the agent and the human are stuck holding a command that does not
// resolve — which is how a correct guard becomes an unrecoverable block.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
  }).trim();
}

const ROOT = repoRoot();

// Surfaces an agent reads: session-start doctrine, the scope-discipline guide,
// the hook READMEs, and the templates SHIPPED to every consumer project.
const AGENT_FACING_SURFACES = [
  'CLAUDE.md',
  'docs/agents/scope-discipline.md',
  '.claude/hooks/README.md',
  'packages/caws-cli/templates/CLAUDE.md',
  'packages/caws-cli/templates/hook-packs/claude-code/README.md',
];

function readSurface(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('agent-facing reset-script recovery paths', () => {
  test.each(AGENT_FACING_SURFACES)(
    '%s does not name the non-existent .claude/hooks/ reset scripts',
    (rel) => {
      const body = readSurface(rel);
      const offenders = body
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /\.claude\/hooks\/reset-/.test(line));

      expect(offenders.map(([n, l]) => `${rel}:${n}: ${l.trim()}`)).toEqual([]);
    }
  );

  test('the reset scripts actually live where the docs now point', () => {
    for (const script of ['reset-strikes.sh', 'reset-danger-latch.sh']) {
      expect(fs.existsSync(path.join(ROOT, '.caws', 'hooks', script))).toBe(true);
      // The path the docs used to name must remain absent — if a future change
      // ever creates it, this test's premise (and the doc fix) needs revisiting
      // rather than silently passing.
      expect(fs.existsSync(path.join(ROOT, '.claude', 'hooks', script))).toBe(false);
    }
  });
});

describe('guard remediation text resolves to a real script', () => {
  // The shared hook templates are what ship to consumers. They interpolate a
  // hooks dir at render time; that variable must resolve to the CAWS hooks
  // tree, not the harness vendor dir (which differs per surface: .claude,
  // .codex, .cursor, .windsurf, .opencode, .zcode).
  const SHARED = path.join(
    ROOT,
    'packages/caws-cli/templates/hook-packs/shared'
  );

  const GUARDS_WITH_RESET_REMEDIATION = [
    'scope-guard.sh',
    'protected-paths.sh',
    'block-dangerous.sh',
  ];

  test.each(GUARDS_WITH_RESET_REMEDIATION)(
    '%s does not build a reset path from the vendor dir',
    (script) => {
      const body = fs.readFileSync(path.join(SHARED, script), 'utf8');
      const offenders = body
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) =>
          /\$\{?CAWS_VENDOR_DIR\}?\/hooks\/reset-/.test(line)
        );

      expect(offenders.map(([n, l]) => `${script}:${n}: ${l.trim()}`)).toEqual(
        []
      );
    }
  );

  test('agent-surface.sh exports a CAWS_HOOKS_DIR for remediation text', () => {
    const body = fs.readFileSync(
      path.join(SHARED, 'lib', 'agent-surface.sh'),
      'utf8'
    );
    expect(body).toMatch(/export .*\bCAWS_HOOKS_DIR\b/);
  });
});
