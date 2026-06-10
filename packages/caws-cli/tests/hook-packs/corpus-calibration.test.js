/**
 * @fileoverview HOOK-CAPABILITY-ENGINE-003 — corpus calibration regression.
 *
 * Pins the two Surgery Ward producer-side corpora as caws-side regression
 * tests so future classifier calibration argues against DATA, not recollection
 * (surgery-ward/docs/caws-governed-artifacts README: "authority lives in caws").
 *
 *   fixtures/terminal-use.deduped.csv            — ~697 commands with an
 *     intended_decision column (allow|ask|deny). The classifier must MATCH that
 *     intent, OR the divergence must be recorded in corpus-adjudications.json
 *     with a verdict. An UNLISTED divergence fails the test — forcing a human
 *     adjudication instead of silent drift.
 *   fixtures/terminal-use.commandfact-fn-closure.csv — the 80-FN falsification
 *     FLOOR: dangerous commands the regex hook silently allowed. NONE may
 *     classify as `allow` (no silent allow). This is the safety contract that
 *     outranks the deduped intent on conflict.
 *
 * Drives the SHIPPED classify_command.py as a subprocess (tests the artifact a
 * consumer runs, not a Python import).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyTimeoutMs } = require('./lib/classify-timeout');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLASSIFIER = path.join(
  REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code', 'classify_command.py'
);
const FIXTURES = path.join(__dirname, 'fixtures');
// Classify against a fresh tmp repo root so a real node_modules / .caws in the
// repo root does not perturb path-relative rm heuristics (the symlink trap).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-cal-'));

function classify(command) {
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', SANDBOX, '--home', os.homedir(), '--cwd', SANDBOX],
    { input: command, encoding: 'utf8', timeout: classifyTimeoutMs() }
  );
  if (r.error) throw r.error;
  return JSON.parse(r.stdout).decision;
}

/** Minimal CSV reader (handles single-quoted-with-comma fields in our corpora). */
function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

describe('HOOK-CAPABILITY-ENGINE-003: 80-FN falsification floor (no silent allow)', () => {
  const rows = readCsv(path.join(FIXTURES, 'terminal-use.commandfact-fn-closure.csv'))
    .filter((r) => (r.command || '').trim().length > 0);

  it('the floor fixture has the expected ~80 rows', () => {
    expect(rows.length).toBeGreaterThanOrEqual(78);
  });

  it.each(rows.map((r) => [r.command, r]))('FN floor: %s never silent-allows', (command) => {
    expect(classify(command)).not.toBe('allow');
  });
});

describe('HOOK-CAPABILITY-ENGINE-003: deduped corpus matches intent or a recorded adjudication', () => {
  const rows = readCsv(path.join(FIXTURES, 'terminal-use.deduped.csv'))
    .filter((r) => (r.Example_Usage || '').trim() && (r.intended_decision || '').trim());
  const adj = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'corpus-adjudications.json'), 'utf8'));
  const adjMap = new Map(adj.adjudications.map((a) => [a.command, a.expect]));

  it('corpus has a meaningful number of rows', () => {
    expect(rows.length).toBeGreaterThan(600);
  });

  it.each(rows.map((r) => [r.Example_Usage, r.intended_decision]))(
    'deduped: %s',
    (command, intended) => {
      const got = classify(command);
      if (got === intended) return; // agrees with dataset intent
      // Diverges: must be a RECORDED adjudication, and the classifier must
      // produce exactly the adjudicated decision.
      const adjudicated = adjMap.get(command);
      if (adjudicated === undefined) {
        throw new Error(
          `Unadjudicated divergence: "${command}" intended=${intended} got=${got}. ` +
          `Either fix the classifier or add an entry to corpus-adjudications.json with a verdict.`
        );
      }
      expect(got).toBe(adjudicated);
    }
  );

  it('every adjudication still corresponds to a real divergence (no stale entries)', () => {
    const stale = [];
    for (const a of adj.adjudications) {
      const row = rows.find((r) => r.Example_Usage === a.command);
      if (!row) { stale.push(`${a.command} (not in corpus)`); continue; }
      const got = classify(a.command);
      if (got === row.intended_decision) stale.push(`${a.command} (now agrees with intent — remove)`);
    }
    expect(stale).toEqual([]);
  });
});
