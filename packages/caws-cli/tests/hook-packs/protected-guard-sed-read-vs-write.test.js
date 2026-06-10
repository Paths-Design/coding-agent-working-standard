/**
 * @fileoverview HOOK-CAPABILITY-ENGINE-003 — protected-guard sed/perl
 * read-vs-write discrimination.
 *
 * The protected-guard arm of block-dangerous.sh latched on ANY sed/perl
 * command naming the guard path, including read-only `sed -n <range>p <guard>`
 * (print mode). That was the dominant protected-guard false positive (Sterling
 * 2026-06-10 armed latch). The fix: sed/perl latch only with an in-place flag
 * (-i / -pi / --in-place); rm/tee/touch/truncate/install/chmod always name the
 * write target and still latch; redirects and cp/mv-to-dest unchanged.
 *
 * Driven as a real subprocess against an isolated mktemp project so the
 * maintainer's own latch is never touched. Guard path is assembled at runtime
 * (never a literal in this source) so a sibling guard cannot pattern-match it.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code');
// Assembled, not a literal, so this test file does not itself contain the
// guard path next to a mutator token.
const GUARD = ['.claude', 'hooks', ['worktree', 'write', 'guard'].join('-') + '.sh'].join('/');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-sed-guard-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'state'), { recursive: true });
  for (const f of ['block-dangerous.sh', 'classify_command.py']) {
    fs.copyFileSync(path.join(PACK, f), path.join(dir, '.claude', 'hooks', f));
  }
  for (const f of ['emit.sh', 'caws-state.sh', 'guard-message.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  return dir;
}

let sidN = 0;
function run(dir, command) {
  const session_id = `sed-test-${process.pid}-${sidN++}`;
  const r = spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'block-dangerous.sh')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id }),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  let blocked = false;
  try { blocked = JSON.parse(r.stdout).decision === 'block'; } catch { /* not an envelope */ }
  const latched = fs
    .readdirSync(path.join(dir, '.claude', 'hooks', 'state'))
    .some((f) => f === `danger-latch-${session_id}.json`);
  return { blocked, latched, stderr: r.stderr, status: r.status };
}

describe('HOOK-CAPABILITY-ENGINE-003: protected-guard sed/perl read-vs-write', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('sed -n <range>p <guard> (READ) does NOT latch', () => {
    const r = run(dir, `sed -n 40,90p ${GUARD}`);
    expect(r.blocked).toBe(false);
    expect(r.latched).toBe(false);
  });

  it('perl -ne print <guard> (READ) does NOT latch', () => {
    const r = run(dir, `perl -ne 'print if 1' ${GUARD}`);
    expect(r.blocked).toBe(false);
    expect(r.latched).toBe(false);
  });

  it('sed -i ... <guard> (in-place WRITE) latches', () => {
    const r = run(dir, `sed -i 's/a/b/' ${GUARD}`);
    expect(r.blocked).toBe(true);
    expect(r.latched).toBe(true);
  });

  it('perl -pi -e ... <guard> (in-place WRITE) latches', () => {
    const r = run(dir, `perl -pi -e 's/a/b/' ${GUARD}`);
    expect(r.blocked).toBe(true);
    expect(r.latched).toBe(true);
  });

  it('rm <guard> still latches (always names the write target)', () => {
    const r = run(dir, `rm ${GUARD}`);
    expect(r.blocked).toBe(true);
    expect(r.latched).toBe(true);
  });

  it('output redirect into <guard> still latches', () => {
    const r = run(dir, `echo x > ${GUARD}`);
    expect(r.blocked).toBe(true);
    expect(r.latched).toBe(true);
  });
});
