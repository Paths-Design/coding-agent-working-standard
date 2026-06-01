/**
 * @fileoverview HOOK-ASK-ENFORCEMENT-001 — capability-aware ask enforcement.
 *
 * The capability lattice now produces `ask` for genuinely dangerous operations
 * (kubectl delete pod, aws s3 rm, curl POST, kill -9, docker prune), not just
 * for the legacy "unknown family subcommand" uncertainty. This slice makes a
 * CAPABILITY-derived ask operationally meaningful at the hook boundary
 * (blocking-confirmation) while keeping LEGACY-family ask advisory — preserving
 * CAWS-DANGER-LATCH-CATASTROPHIC-ONLY-001.
 *
 * Two layers under test:
 *   1. classify_command.py emits additive {source, enforcement} alongside the
 *      unchanged {decision, reason} (Slice A). Asserted directly on stdout JSON.
 *   2. block-dangerous.sh branches on `enforcement` (Slice B): confirm -> block
 *      + latch with a confirmation message DISTINCT from a catastrophic deny;
 *      advisory -> exit 0, no latch. Asserted by running the hook as a real
 *      subprocess with a Claude Code JSON envelope.
 *
 * Acceptance (from the spec):
 *   A1 capability ask -> source=capability, enforcement=confirm -> hook BLOCKS.
 *   A2 legacy/regex ask -> enforcement=advisory -> hook does NOT block.
 *   A3 deny -> enforcement=block (hook hard-blocks); allow -> enforcement=pass.
 *   A4 classifier unavailable -> fail closed (hook blocks).
 *   A5 capability ask nested in eval/$()/sh -c -> confirm propagates outward.
 *   A6 additive contract: decision/reason unchanged; new fields always present.
 *
 * Strategy mirrors latch_readonly_and_reset.test.js: copy the shipped scripts +
 * lib into an isolated mktemp project and drive block-dangerous.sh as a real
 * subprocess. The classifier is invoked directly for the stdout-field asserts.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code'
);
const CLASSIFIER = path.join(PACK, 'classify_command.py');

beforeAll(() => {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(
      'ask_enforcement: `python3` is not available on PATH. This suite shells ' +
        `out to the classifier + hook. Underlying error: ${probe.error.message}`
    );
  }
  if (!fs.existsSync(CLASSIFIER)) {
    throw new Error(`ask_enforcement: classifier template not found at ${CLASSIFIER}`);
  }
});

/** Run the classifier directly; return the parsed stdout decision envelope. */
function classify(cmd, repoRoot = REPO_ROOT) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ae-home-'));
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', repoRoot, '--home', home, '--cwd', repoRoot],
    { input: cmd, encoding: 'utf8', timeout: 8000 }
  );
  if (r.error) throw new Error(`classifier invocation failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`classifier exited ${r.status}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Copy the shipped hook scripts + lib into an isolated mktemp project. */
function makeProject({ withClassifier = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ask-enf-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  const scripts = ['block-dangerous.sh', 'reset-danger-latch.sh'];
  if (withClassifier) scripts.push('classify_command.py');
  for (const f of scripts) {
    fs.copyFileSync(path.join(PACK, f), path.join(dir, '.claude', 'hooks', f));
  }
  for (const f of ['caws-state.sh', 'emit.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  return dir;
}

/** Drive block-dangerous.sh with a Claude Code Bash envelope. */
function runHook(dir, command, sessionId) {
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'block-dangerous.sh')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: sessionId }),
    encoding: 'utf8',
    timeout: 8000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

function latchFiles(dir) {
  const stateDir = path.join(dir, '.claude', 'hooks', 'state');
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .filter((f) => f.startsWith('danger-latch-') && f.endsWith('.json'));
}

/** A hook "blocks" iff it emitted a block/deny/ask permission envelope. */
function emittedBlock(result) {
  if (!result.stdout || result.stdout.trim() === '') return null;
  try {
    const j = JSON.parse(result.stdout);
    const d = j?.hookSpecificOutput?.permissionDecision ?? j?.decision ?? j?.permission;
    if (d === 'deny' || d === 'block' || d === 'ask') return j;
    return null;
  } catch {
    return null;
  }
}

let sidCounter = 0;
const freshSid = (tag) => `ae-${tag}-${(sidCounter += 1)}-0000-0000-000000000000`;

// ===========================================================================
// Slice A — classifier emits source + enforcement (stdout asserts)
// ===========================================================================
describe('HOOK-ASK-ENFORCEMENT-001 A1/A6: capability ask carries source=capability, enforcement=confirm', () => {
  const CAP_ASK = [
    'kubectl delete pod mypod',
    'aws s3 rm s3://bucket/key',
    "curl -X POST https://api.example.com/users -d '{}'",
    'kill -9 1234',
    'docker system prune',
  ];
  CAP_ASK.forEach((cmd) => {
    it(`${cmd.slice(0, 40)} -> ask/capability/confirm`, () => {
      const o = classify(cmd);
      expect(o.decision).toBe('ask');
      expect(o.source).toBe('capability');
      expect(o.enforcement).toBe('confirm');
      // A6: decision/reason still present + unchanged shape.
      expect(typeof o.reason).toBe('string');
      expect(o.reason.length).toBeGreaterThan(0);
    });
  });

  it('A6: additive contract — every decision carries all four keys', () => {
    for (const cmd of ['ls -la', 'kubectl delete pod x', 'shred -u f', 'git rebase -i HEAD~2']) {
      const o = classify(cmd);
      expect(Object.keys(o).sort()).toEqual(['decision', 'enforcement', 'reason', 'source']);
    }
  });
});

describe('HOOK-ASK-ENFORCEMENT-001 A2: legacy/regex ask carries enforcement=advisory', () => {
  const LEGACY_ASK = [
    ['git rebase -i HEAD~2', ['legacy_family', 'regex']],
    ['git commit --amend', ['legacy_family', 'regex']],
    ['npm run frobnicate', ['legacy_family']],
  ];
  LEGACY_ASK.forEach(([cmd, srcs]) => {
    it(`${cmd} -> ask/${srcs.join('|')}/advisory`, () => {
      const o = classify(cmd);
      expect(o.decision).toBe('ask');
      expect(srcs).toContain(o.source);
      expect(o.enforcement).toBe('advisory');
    });
  });
});

describe('HOOK-ASK-ENFORCEMENT-001 A3: deny->block, allow->pass enforcement', () => {
  it('deny (capability catastrophic) -> enforcement=block', () => {
    for (const cmd of ['kubectl delete namespace prod', 'shred -u secret', 'terraform destroy']) {
      const o = classify(cmd);
      expect(o.decision).toBe('deny');
      expect(o.enforcement).toBe('block');
    }
  });
  it('allow -> enforcement=pass', () => {
    for (const cmd of ['ls -la', 'git status', 'cat README.md']) {
      const o = classify(cmd);
      expect(o.decision).toBe('allow');
      expect(o.enforcement).toBe('pass');
    }
  });
});

describe('HOOK-ASK-ENFORCEMENT-001 A5: capability confirm propagates through recursion', () => {
  it('eval "kubectl delete pod mypod" (literal opaque-exec) -> capability/confirm', () => {
    const o = classify('eval "kubectl delete pod mypod"');
    expect(o.decision).toBe('ask');
    expect(o.source).toBe('capability');
    expect(o.enforcement).toBe('confirm');
  });
  it('command substitution carrying a capability danger propagates confirm', () => {
    // `echo $(aws s3 rm s3://b/k)` — the inner capability ask surfaces outward.
    const o = classify('echo $(aws s3 rm s3://b/k)');
    expect(o.decision).toBe('ask');
    expect(o.enforcement).toBe('confirm');
  });
});

// ===========================================================================
// Slice B — block-dangerous.sh branches on enforcement (end-to-end hook)
// ===========================================================================
describe('HOOK-ASK-ENFORCEMENT-001 A1: capability ask BLOCKS at the hook with a confirmation message', () => {
  it('kubectl delete pod mypod -> hook blocks + records a latch', () => {
    const dir = makeProject();
    const sid = freshSid('cap');
    const r = runHook(dir, 'kubectl delete pod mypod', sid);
    const env = emittedBlock(r);
    expect(env).not.toBeNull(); // the hook emitted a block/ask envelope
    // The confirmation message is DISTINCT from a catastrophic deny.
    const text = JSON.stringify(env);
    expect(text).toMatch(/USER CONFIRMATION/);
    expect(text).not.toMatch(/HARD BLOCK/);
    // A latch was recorded (sticky for the session).
    expect(latchFiles(dir)).toHaveLength(1);
  });
});

describe('HOOK-ASK-ENFORCEMENT-001 A2: legacy ask does NOT block at the hook', () => {
  it('git rebase -i HEAD~2 -> advisory, exit 0, no latch', () => {
    const dir = makeProject();
    const sid = freshSid('leg');
    const r = runHook(dir, 'git rebase -i HEAD~2', sid);
    expect(r.status).toBe(0);
    expect(emittedBlock(r)).toBeNull(); // nothing blocking on stdout
    expect(r.stderr).toMatch(/advisory \(non-blocking\)/);
    expect(latchFiles(dir)).toHaveLength(0); // CATASTROPHIC-ONLY preserved
  });

  it('npm run frobnicate (unknown subcommand) -> not blocked', () => {
    const dir = makeProject();
    const r = runHook(dir, 'npm run frobnicate', freshSid('npm'));
    expect(r.status).toBe(0);
    expect(emittedBlock(r)).toBeNull();
    expect(latchFiles(dir)).toHaveLength(0);
  });
});

describe('HOOK-ASK-ENFORCEMENT-001 A3: deny hard-blocks; allow passes', () => {
  it('shred -u f -> HARD BLOCK + latch (distinct from confirm)', () => {
    const dir = makeProject();
    const r = runHook(dir, 'shred -u f', freshSid('deny'));
    const env = emittedBlock(r);
    expect(env).not.toBeNull();
    expect(JSON.stringify(env)).toMatch(/HARD BLOCK/);
    expect(latchFiles(dir)).toHaveLength(1);
  });
  it('ls -la -> passes (exit 0, no envelope, no latch)', () => {
    const dir = makeProject();
    const r = runHook(dir, 'ls -la', freshSid('allow'));
    expect(r.status).toBe(0);
    expect(emittedBlock(r)).toBeNull();
    expect(latchFiles(dir)).toHaveLength(0);
  });
});

describe('HOOK-ASK-ENFORCEMENT-001 A4: fail-closed when the classifier is unavailable', () => {
  it('no classifier present -> hook blocks (does not advisory-pass a capability danger)', () => {
    const dir = makeProject({ withClassifier: false });
    const r = runHook(dir, 'kubectl delete pod mypod', freshSid('fc'));
    const env = emittedBlock(r);
    expect(env).not.toBeNull(); // fail-closed: blocked, never advisory exit-0
    expect(latchFiles(dir)).toHaveLength(1);
  });
});

describe('HOOK-ASK-ENFORCEMENT-001 A5: nested capability ask blocks at the hook', () => {
  it('eval "kubectl delete pod mypod" -> hook blocks (confirm propagated)', () => {
    const dir = makeProject();
    const r = runHook(dir, 'eval "kubectl delete pod mypod"', freshSid('nest'));
    const env = emittedBlock(r);
    expect(env).not.toBeNull();
    expect(JSON.stringify(env)).toMatch(/USER CONFIRMATION/);
  });
});
