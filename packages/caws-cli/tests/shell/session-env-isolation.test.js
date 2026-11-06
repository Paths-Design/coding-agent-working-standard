'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CHILD_FLAG = 'CAWS_ENV_ISOLATION_PROBE_CHILD';
const PROJECT = 'caws-cli';
const ISOLATED_KEYS = [
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'CAWS_SESSION_ID',
  'HOOK_SESSION_ID',
  'CAWS_PROJECT_DIR',
  'CAWS_HOME',
];

describe('shared jest setup isolates session identity (caws-cli project)', () => {
  test('no session-identity variable is visible to the test process', () => {
    for (const key of ISOLATED_KEYS) expect([key, process.env[key]]).toEqual([key, undefined]);
  });

  // A parent run with a clean shell proves nothing, so the same assertion is
  // re-run in a child jest whose environment is loaded with foreign identities:
  // the child passes only if setupFiles removed them before the test ran.
  if (!process.env[CHILD_FLAG]) {
    test('setupFiles strips foreign identities exported by the runner shell', () => {
      const env = { ...process.env, [CHILD_FLAG]: '1' };
      for (const key of ISOLATED_KEYS) env[key] = `@foreign-${key}`;
      const argv = [
        process.execPath,
        require.resolve('jest/bin/jest'),
        '--selectProjects',
        PROJECT,
        '--runInBand',
        '--runTestsByPath',
        __filename,
        '--testNamePattern',
        'no session-identity variable',
        '--json',
      ];
      const res = spawnSync(argv[0], argv.slice(1), {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        timeout: 100000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const outcome = {
        argv,
        cwd: ROOT,
        status: res.status,
        signal: res.signal,
        error: res.error ? { code: res.error.code, message: res.error.message } : null,
        stdout: res.stdout,
        stderr: res.stderr,
      };
      if (process.env.CAWS_TEST_ARTIFACT_DIR) {
        const directory = path.join(process.env.CAWS_TEST_ARTIFACT_DIR, 'session-env-isolation');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(directory, `${process.pid}.json`),
          JSON.stringify(outcome, null, 2) + '\n',
          {
            mode: 0o600,
            flag: 'wx',
          }
        );
      }
      expect({
        error: outcome.error,
        signal: res.signal,
        status: res.status,
        stderr: res.stderr,
      }).toEqual(expect.objectContaining({ error: null, signal: null, status: 0 }));
      expect(res.stdout).not.toBe('');
      const report = JSON.parse(res.stdout);
      expect({ passed: report.numPassedTests, failed: report.numFailedTests }).toEqual({
        passed: 1,
        failed: 0,
      });
    }, 120000);
  }
});
