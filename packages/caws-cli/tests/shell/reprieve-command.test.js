'use strict';

/**
 * CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001 — `caws reprieve` CLI command coverage.
 *
 * Drives the compiled command handlers directly (require from dist/) for
 * grant/show/revoke/list, against temp state dirs. The hook-pack dispatch
 * behavior (the consult + skip log) is covered by reprieve.bats; this suite
 * pins the CLI record shape, the session resolution, the expiry validation,
 * the foreign-session partition at the file-naming layer, and the audit log.
 *
 * Coverage (A4 + the record-shape invariants):
 *   - grant writes the state file with the resolved session id + all fields
 *   - grant refuses a missing session, a past expiry, missing required fields
 *   - show renders the record (ACTIVE) and reports no-reprieve cleanly
 *   - revoke deletes the file + appends an audit line
 *   - list enumerates active reprieves
 *   - a foreign session's filename differs (partition at the file layer)
 *   - the state file + audit log land under the vendor dir (operational cache)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  runReprieveGrantCommand,
  runReprieveShowCommand,
  runReprieveRevokeCommand,
  runReprieveListCommand,
} = require('../../dist/shell/commands/reprieve');

/**
 * Build a synthetic repo root with the CAWS vendor dir structure the command
 * resolves. Returns { repoRoot, stateDir, logsDir } where stateDir is the
 * .claude/hooks/state path the writer targets and the reader consults.
 */
function makeRepoRoot() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reprieve-cli-'));
  // resolveRepoRoot requires a git repo (the command refuses non-repo cwds).
  execSync(`git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m root`, {
    cwd: repoRoot,
  });
  // The command creates the state/logs dirs via mkdir -p, but pre-create so
  // detectVendorDir finds .claude on the grant path.
  fs.mkdirSync(path.join(repoRoot, '.claude', 'hooks', 'state'), {
    recursive: true,
  });
  const stateDir = path.join(repoRoot, '.claude', 'hooks', 'state');
  const logsDir = path.join(repoRoot, '.claude', 'logs');
  return { repoRoot, stateDir, logsDir };
}

const FUTURE_ISO = '2099-01-01T00:00:00Z';
const PAST_ISO = '2020-01-01T00:00:00Z';

/** Collect stdout lines from a command run (the handlers call out() per line). */
function captureOut() {
  const lines = [];
  const out = (s) => lines.push(s);
  return { lines, out };
}

describe('CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001 — caws reprieve CLI', () => {
  describe('grant', () => {
    test('writes the state file with all fields + the resolved session id', () => {
      const { repoRoot, stateDir } = makeRepoRoot();
      const { lines, out } = captureOut();
      const err = () => {};
      const code = runReprieveGrantCommand({
        cwd: repoRoot,
        out,
        err,
        handlers: 'protected-paths.sh,scan-secrets.sh',
        reason: 'editing hooks under CASR-001',
        approvedBy: 'darian',
        expiresAt: FUTURE_ISO,
        session: '019f6289-d6d6-76b3-a6d1-04123944b2e6',
        surface: 'claude-code',
      });
      expect(code).toBe(0);
      const file = path.join(
        stateDir,
        'guard-reprieve-019f6289-d6d6-76b3-a6d1-04123944b2e6.json'
      );
      expect(fs.existsSync(file)).toBe(true);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(record).toEqual({
        session_id: '019f6289-d6d6-76b3-a6d1-04123944b2e6',
        created_at: expect.any(String),
        expires_at: FUTURE_ISO,
        approved_by: 'darian',
        reason: 'editing hooks under CASR-001',
        handlers: ['protected-paths.sh', 'scan-secrets.sh'],
      });
      expect(lines.join('\n')).toContain('granted reprieve');
    });

    test('refuses a missing session id (no --session, no env)', () => {
      const { repoRoot } = makeRepoRoot();
      const errs = [];
      const code = runReprieveGrantCommand({
        cwd: repoRoot,
        out: () => {},
        err: (s) => errs.push(s),
        handlers: 'protected-paths.sh',
        reason: 'x',
        approvedBy: 'd',
        expiresAt: FUTURE_ISO,
        session: undefined,
        env: {}, // no session-bearing env vars
      });
      expect(code).toBe(1);
      expect(errs.join('\n')).toMatch(/could not resolve a session id/i);
    });

    test('refuses a past expiry', () => {
      const { repoRoot } = makeRepoRoot();
      const errs = [];
      const code = runReprieveGrantCommand({
        cwd: repoRoot,
        out: () => {},
        err: (s) => errs.push(s),
        handlers: 'protected-paths.sh',
        reason: 'x',
        approvedBy: 'd',
        expiresAt: PAST_ISO,
        session: 'sess-x',
        surface: 'claude-code',
      });
      expect(code).toBe(1);
      expect(errs.join('\n')).toMatch(/in the past/i);
    });

    test('refuses a naive (timezone-less) expiry with a clear, actionable error', () => {
      // CAWS-GUARD-REPRIEVE-NAIVE-EXPIRY-001: a timezone-less --expires-at
      // must be REFUSED at grant time, not silently accepted. Pre-fix the
      // writer accepted it, printed "granted reprieve", and the reader then
      // silently treated it as inert (TypeError on naive-vs-aware compare).
      const { repoRoot } = makeRepoRoot();
      const errs = [];
      const code = runReprieveGrantCommand({
        cwd: repoRoot,
        out: () => {},
        err: (s) => errs.push(s),
        handlers: 'protected-paths.sh',
        reason: 'x',
        approvedBy: 'd',
        expiresAt: '2099-01-01T00:00:00', // naive — no Z, no offset
        session: 'sess-x',
        surface: 'claude-code',
      });
      expect(code).toBe(1);
      const msg = errs.join('\n');
      expect(msg).toMatch(/missing a timezone/i);
      // The error must tell the user HOW to fix it (append Z), not just refuse.
      expect(msg).toMatch(/2099-01-01T00:00:00Z/);
    });

    test('refuses an empty handlers list', () => {
      const { repoRoot } = makeRepoRoot();
      const errs = [];
      const code = runReprieveGrantCommand({
        cwd: repoRoot,
        out: () => {},
        err: (s) => errs.push(s),
        handlers: ' , ',
        reason: 'x',
        approvedBy: 'd',
        expiresAt: FUTURE_ISO,
        session: 'sess-x',
        surface: 'claude-code',
      });
      expect(code).toBe(1);
      expect(errs.join('\n')).toMatch(/at least one handler/i);
    });
  });

  describe('show', () => {
    test('renders an ACTIVE reprieve', () => {
      const { repoRoot } = makeRepoRoot();
      runReprieveGrantCommand({
        cwd: repoRoot,
        out: () => {},
        err: () => {},
        handlers: 'protected-paths.sh',
        reason: 'r',
        approvedBy: 'a',
        expiresAt: FUTURE_ISO,
        session: 'sess-show',
        surface: 'claude-code',
      });
      const { lines, out } = captureOut();
      const code = runReprieveShowCommand({
        cwd: repoRoot,
        out,
        err: () => {},
        session: 'sess-show',
        surface: 'claude-code',
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('ACTIVE');
      expect(lines.join('\n')).toContain('protected-paths.sh');
    });

    test('reports no-reprieve cleanly (exit 0)', () => {
      const { repoRoot } = makeRepoRoot();
      const { lines, out } = captureOut();
      const code = runReprieveShowCommand({
        cwd: repoRoot,
        out,
        err: () => {},
        session: 'sess-none',
        surface: 'claude-code',
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toMatch(/no reprieve/i);
    });
  });

  describe('revoke', () => {
    test('deletes the state file + appends an audit line', () => {
      const { repoRoot, stateDir, logsDir } = makeRepoRoot();
      runReprieveGrantCommand({
        cwd: repoRoot,
        out: () => {},
        err: () => {},
        handlers: 'protected-paths.sh',
        reason: 'r',
        approvedBy: 'a',
        expiresAt: FUTURE_ISO,
        session: 'sess-revoke',
        surface: 'claude-code',
      });
      const file = path.join(stateDir, 'guard-reprieve-sess-revoke.json');
      expect(fs.existsSync(file)).toBe(true);
      const { out } = captureOut();
      const code = runReprieveRevokeCommand({
        cwd: repoRoot,
        out,
        err: () => {},
        reason: 'task complete',
        session: 'sess-revoke',
        surface: 'claude-code',
      });
      expect(code).toBe(0);
      expect(fs.existsSync(file)).toBe(false);
      // The audit log carries the revoke entry.
      const logPath = path.join(logsDir, 'guard-reprieves.log');
      expect(fs.existsSync(logPath)).toBe(true);
      const log = fs.readFileSync(logPath, 'utf8');
      expect(log).toMatch(/"action":"revoke"/);
      expect(log).toMatch(/sess-revoke/);
    });

    test('revoking a nonexistent reprieve is a clean no-op (exit 0)', () => {
      const { repoRoot } = makeRepoRoot();
      const { lines, out } = captureOut();
      const code = runReprieveRevokeCommand({
        cwd: repoRoot,
        out,
        err: () => {},
        reason: 'nothing to clear',
        session: 'sess-nope',
        surface: 'claude-code',
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toMatch(/nothing to revoke/i);
    });

    test('refuses revoke without --reason', () => {
      const { repoRoot } = makeRepoRoot();
      const errs = [];
      const code = runReprieveRevokeCommand({
        cwd: repoRoot,
        out: () => {},
        err: (s) => errs.push(s),
        reason: '',
        session: 'sess-x',
        surface: 'claude-code',
      });
      expect(code).toBe(1);
      expect(errs.join('\n')).toMatch(/--reason is required/i);
    });
  });

  describe('list', () => {
    test('enumerates active reprieves', () => {
      const { repoRoot } = makeRepoRoot();
      runReprieveGrantCommand({
        cwd: repoRoot,
        out: () => {},
        err: () => {},
        handlers: 'protected-paths.sh',
        reason: 'r',
        approvedBy: 'a',
        expiresAt: FUTURE_ISO,
        session: 'sess-list-1',
        surface: 'claude-code',
      });
      const { lines, out } = captureOut();
      const code = runReprieveListCommand({
        cwd: repoRoot,
        out,
        err: () => {},
        surface: 'claude-code',
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('sess-list-1');
      expect(lines.join('\n')).toContain('ACTIVE');
    });

    test('reports no reprieves cleanly', () => {
      const { repoRoot } = makeRepoRoot();
      const { lines, out } = captureOut();
      const code = runReprieveListCommand({
        cwd: repoRoot,
        out,
        err: () => {},
        surface: 'claude-code',
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toMatch(/no reprieves/i);
    });
  });

  describe('partition at the file layer (foreign session)', () => {
    test('two sessions produce two distinct filenames', () => {
      const { repoRoot, stateDir } = makeRepoRoot();
      for (const sid of ['sess-alpha', 'sess-beta']) {
        runReprieveGrantCommand({
          cwd: repoRoot,
          out: () => {},
          err: () => {},
          handlers: 'protected-paths.sh',
          reason: 'r',
          approvedBy: 'a',
          expiresAt: FUTURE_ISO,
          session: sid,
          surface: 'claude-code',
        });
      }
      expect(
        fs.existsSync(path.join(stateDir, 'guard-reprieve-sess-alpha.json'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(stateDir, 'guard-reprieve-sess-beta.json'))
      ).toBe(true);
      // show for alpha does NOT surface beta's record.
      const { lines, out } = captureOut();
      runReprieveShowCommand({
        cwd: repoRoot,
        out,
        err: () => {},
        session: 'sess-alpha',
        surface: 'claude-code',
      });
      expect(lines.join('\n')).toContain('sess-alpha');
      expect(lines.join('\n')).not.toContain('sess-beta');
    });
  });
});
