/**
 * Working-State Layer Unit Tests
 *
 * v11.1 surface: the only live consumer of working-state.js is
 * session/session-manager.js, which imports `mergeFilesTouched` only.
 * All other phase-recording APIs (recordValidation, recordEvaluation,
 * recordGates, recordACVerification) and derived-field helpers
 * (computePhase, computeBlockers, computeNextActions) belong to v10
 * removed-command surfaces and are unreachable from v11.1.
 *
 * CAWSFIX-02 fence: the fence is implemented once inside getStatePath
 * and propagates to every public export. The single mergeFilesTouched
 * fence test below is sufficient regression coverage for the live
 * call path. Broader fence-propagation coverage will move out with
 * working-state.js source under the follow-on dead-source cleanup
 * spec.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  initializeState,
  saveState,
  loadState,
  mergeFilesTouched,
} = require('../src/utils/working-state');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ws-test-'));
  fs.mkdirSync(path.join(tmpDir, '.caws'), { recursive: true });
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('mergeFilesTouched', () => {
  test('merges files additively', () => {
    saveState('mft', initializeState('mft'), tmpDir);
    mergeFilesTouched('mft', ['a.js', 'b.js'], tmpDir);
    mergeFilesTouched('mft', ['b.js', 'c.js'], tmpDir);
    const state = loadState('mft', tmpDir);
    expect(state.files_touched.sort()).toEqual(['a.js', 'b.js', 'c.js']);
  });

  test('no-op for empty array', () => {
    saveState('mft-empty', initializeState('mft-empty'), tmpDir);
    mergeFilesTouched('mft-empty', [], tmpDir);
    const state = loadState('mft-empty', tmpDir);
    expect(state.files_touched).toEqual([]);
    expect(state.history.length).toBe(0);
  });

  test('throws on undefined specId (CAWSFIX-02 fence)', () => {
    expect(() => mergeFilesTouched(undefined, ['a.js'], tmpDir)).toThrow(/non-empty string/);
  });
});
