import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const CHILD_FLAG = 'CAWS_ENV_ISOLATION_PROBE_CHILD';
const PROJECT = 'kernel';
const ISOLATED_KEYS = [
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'CAWS_SESSION_ID',
  'HOOK_SESSION_ID',
  'CAWS_PROJECT_DIR',
  'CAWS_HOME',
];

describe('shared jest setup isolates session identity (kernel project)', () => {
  test('no session-identity variable is visible to the test process', () => {
    for (const key of ISOLATED_KEYS) expect([key, process.env[key]]).toEqual([key, undefined]);
  });

  // A parent run with a clean shell proves nothing, so the same assertion is
  // re-run in a child jest whose environment is loaded with foreign identities:
  // the child passes only if setupFiles removed them before the test ran.
  if (!process.env[CHILD_FLAG]) {
    test('setupFiles strips foreign identities exported by the runner shell', () => {
      const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_FLAG]: '1' };
      for (const key of ISOLATED_KEYS) env[key] = `@foreign-${key}`;
      const res = spawnSync(
        process.execPath,
        [
          require.resolve('jest/bin/jest'),
          '--selectProjects',
          PROJECT,
          '--runTestsByPath',
          __filename,
          '--testNamePattern',
          'no session-identity variable',
          '--json',
        ],
        { cwd: ROOT, env, encoding: 'utf8' }
      );
      const report = JSON.parse(res.stdout);
      expect({ passed: report.numPassedTests, failed: report.numFailedTests }).toEqual({
        passed: 1,
        failed: 0,
      });
    }, 120000);
  }
});
