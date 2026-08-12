'use strict';

/**
 * `caws evidence record --type ac` is refused and redirected
 * (CAWS-DEFECT-AC-EVIDENCE-VISIBILITY-01, D3).
 *
 * The defect this suite pins: two commands wrote AC evidence and only one
 * populated the closure authority.
 *
 *   caws specs evidence        -> appends ac_recorded AND writes evidence: block
 *   caws evidence record --type ac -> appends ac_recorded, block untouched
 *
 * The close gate reads ONLY the block. So the events route produced evidence
 * that showed up in `caws evidence list --type ac` and looked complete while
 * the gate saw nothing. Measured in a consumer repo (2026-08-11): 13 of 28
 * post-gate specs were in exactly that state. The two command names are near
 * synonyms and nothing signalled which one carried authority.
 *
 * The fix is a redirect rather than a dual-write: the evidence: block keeps a
 * SINGLE writer.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runEvidenceRecordCommand } = require('../../dist/shell/commands/evidence');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return { root, cawsDir: path.join(root, '.caws') };
}

function runRecord(root, opts) {
  const out = [];
  const err = [];
  const code = runEvidenceRecordCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'evidence-ac-redirect-test' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-08-11T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws evidence record --type ac is refused', () => {
  test('refuses, appends NO event, and names the governed replacement', () => {
    const { root, cawsDir } = mkRepo();

    const result = runRecord(root, {
      kind: 'ac',
      specId: 'FEAT-42',
      data: { criterion_id: 'A3', status: 'pass', evidence_ref: 'npx jest foo' },
    });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');

    // The refusal must explain WHY, or an agent reads it as an arbitrary block
    // and looks for a way around it.
    expect(result.err).toContain('CLOSURE AUTHORITY');
    expect(result.err).toContain('evidence: block');

    // The redirect echoes the operator's own values so it is copy-pasteable
    // rather than a template they must re-fill.
    expect(result.err).toContain(
      "caws specs evidence FEAT-42 --ac A3 --status pass --evidence-ref 'npx jest foo'"
    );
    expect(result.err).toContain('shell.command.evidence_ac_wrong_surface');

    // HEADLINE: refusal happens before any I/O. A partially-applied refusal —
    // event appended, then refused — would be worse than the original defect.
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  });

  test('a waived criterion is offered the waiver form, not just --status pass', () => {
    const { root } = mkRepo();

    const result = runRecord(root, {
      kind: 'ac',
      specId: 'FEAT-43',
      data: { criterion_id: 'A2', status: 'waived' },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('caws specs evidence FEAT-43 --ac A2 --status waived');
    expect(result.err).toContain('--waiver-reason');
  });

  test('a payload with no criterion_id still redirects, with placeholders', () => {
    const { root, cawsDir } = mkRepo();

    const result = runRecord(root, { kind: 'ac', specId: 'FEAT-44', data: {} });

    expect(result.code).toBe(1);
    expect(result.err).toContain('caws specs evidence FEAT-44 --ac <A1>');
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  });

  test('read-only inspection is explicitly preserved in the message', () => {
    const { root } = mkRepo();

    const result = runRecord(root, {
      kind: 'ac',
      specId: 'FEAT-45',
      data: { criterion_id: 'A1', status: 'pass', evidence_ref: 'x' },
    });

    // Without this line the refusal reads as "ac evidence is gone", and the
    // reader stops using `evidence list --type ac`, which still works.
    expect(result.err).toContain('caws evidence list --type ac');
  });
});

describe('the other evidence kinds are unaffected', () => {
  test.each(['test', 'gate'])('--type %s still records', (kind) => {
    const { root, cawsDir } = mkRepo();
    const data =
      kind === 'test'
        ? { command: 'npm test', exit_code: 0 }
        : { gate_id: 'budget_limit', mode: 'block', result: 'pass', violations: [] };

    const result = runRecord(root, { kind, specId: 'FEAT-46', data });

    expect(result.code).toBe(0);
    expect(result.out).toContain('recorded');
    const events = fs.readFileSync(path.join(cawsDir, 'events.jsonl'), 'utf8');
    expect(events).toContain(kind === 'test' ? 'test_recorded' : 'gate_evaluated');
  });
});

describe('spawned CLI', () => {
  test('exits 1 with the redirect and writes no events.jsonl', () => {
    const { root, cawsDir } = mkRepo();

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        'evidence',
        'record',
        '--type',
        'ac',
        '--spec',
        'FEAT-47',
        '--data',
        '{"criterion_id":"A1","status":"pass","evidence_ref":"npm test"}',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          CAWS_QUIET: '1',
          CLAUDE_CODE_SESSION_ID: 'evidence-ac-redirect-cli-test',
        },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      "caws specs evidence FEAT-47 --ac A1 --status pass --evidence-ref 'npm test'"
    );
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  });
});
