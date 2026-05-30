/**
 * @fileoverview CAWS-SESSION-LOG-RELOCATE-001 A1 — per-session state writes
 * land under .caws/sessions/, never repo-root tmp/.
 *
 * Per-session state (turn logs via session-log.sh, .session-envelope.json +
 * .caller-session.json via lib/parse-input.sh) used to write to repo-root
 * tmp/<sessionId>/ — a user-owned scratch dir that bloats and gets committed.
 * It now writes to <canonical>/.caws/sessions/ (gitignored, provenance-
 * adjacent), resolved via git-common-dir so a linked worktree writes to the
 * canonical .caws/sessions/, not a per-worktree copy.
 *
 * Strategy: build a real git repo with .caws/, copy the shipped scripts + lib,
 * invoke session-log.sh (SessionStart) and the envelope writer as real
 * subprocesses, assert the new paths exist and repo-root tmp/ stays empty.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code');

function git(repo, args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

/** Build a git repo with .caws/ and the session-log scripts installed. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-sess-reloc-'));
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.com']);
  git(dir, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '--quiet', '-m', 'init']);

  fs.mkdirSync(path.join(dir, '.caws'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(PACK, 'session-log.sh'), path.join(dir, '.claude', 'hooks', 'session-log.sh'));
  fs.copyFileSync(path.join(PACK, 'session_log_renderer.py'), path.join(dir, '.claude', 'hooks', 'session_log_renderer.py'));
  fs.copyFileSync(path.join(PACK, 'runtime-paths.sh'), path.join(dir, '.claude', 'hooks', 'runtime-paths.sh'));
  for (const f of ['parse-input.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  return dir;
}

/** Fire session-log.sh for SessionStart with the given session id. */
function fireSessionLog(dir, sessionId) {
  const input = JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    cwd: dir,
    source: 'startup',
    model: 'test',
  });
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'session-log.sh')], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

/** Source parse-input.sh and trigger the durable-envelope writer. */
function fireEnvelopeWriter(dir, sessionId) {
  const script =
    `source "${path.join(dir, '.claude', 'hooks', 'lib', 'parse-input.sh')}"\n` +
    `parse_hook_input\n`;
  return spawnSync('bash', ['-c', script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: dir }),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

describe('CAWS-SESSION-LOG-RELOCATE-001 A1: per-session state under .caws/sessions/', () => {
  let dir;
  afterEach(() => { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('session-log.sh writes turn logs to .caws/sessions/<id>/, not repo-root tmp/', () => {
    dir = makeRepo();
    const sid = 'sess-A-001';
    const r = fireSessionLog(dir, sid);
    expect(r.status).toBe(0);

    const newDir = path.join(dir, '.caws', 'sessions', sid);
    expect(fs.existsSync(newDir)).toBe(true);
    // session.json (or .meta.json) landed under the new home.
    const files = fs.readdirSync(newDir);
    expect(files.length).toBeGreaterThan(0);

    // Nothing under repo-root tmp/.
    expect(fs.existsSync(path.join(dir, 'tmp', sid))).toBe(false);
  });

  it('parse-input.sh writes .session-envelope.json + .caller-session.json under .caws/sessions/', () => {
    dir = makeRepo();
    const sid = 'sess-A-002';
    const r = fireEnvelopeWriter(dir, sid);
    expect(r.status).toBe(0);

    const envelope = path.join(dir, '.caws', 'sessions', sid, '.session-envelope.json');
    expect(fs.existsSync(envelope)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(envelope, 'utf8'));
    expect(payload.session_id).toBe(sid);
    // repo_root field is the CANONICAL root (so it matches the resolver).
    expect(payload.repo_root).toBe(fs.realpathSync(dir));

    const pointer = path.join(dir, '.caws', 'sessions', '.caller-session.json');
    expect(fs.existsSync(pointer)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pointer, 'utf8')).session_id).toBe(sid);

    // Nothing under repo-root tmp/.
    expect(fs.existsSync(path.join(dir, 'tmp'))).toBe(false);
  });

  it('the created .caws/sessions/ path is git-ignored when the managed block is present', () => {
    dir = makeRepo();
    // Seed the managed ephemeral gitignore entry (what caws init writes).
    fs.writeFileSync(path.join(dir, '.gitignore'), '.caws/sessions/\n');
    const sid = 'sess-A-003';
    fireEnvelopeWriter(dir, sid);

    const rel = path.join('.caws', 'sessions', sid, '.session-envelope.json');
    const check = spawnSync('git', ['-C', dir, 'check-ignore', rel], { encoding: 'utf8' });
    // exit 0 = the path IS ignored.
    expect(check.status).toBe(0);
  });
});
