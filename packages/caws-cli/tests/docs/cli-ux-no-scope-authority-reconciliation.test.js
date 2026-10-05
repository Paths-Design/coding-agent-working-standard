'use strict';

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

function auditDoc() {
  return fs.readFileSync(
    path.join(repoRoot(), 'docs', 'architecture', 'cli-ux-job-model-audit.md'),
    'utf8'
  );
}

function tableRow(markdown, firstCell) {
  return markdown.split('\n').find((line) => line.startsWith(`| \`${firstCell}\``));
}

describe('CLI UX no-scope-authority reconciliation audit', () => {
  test('marks residual no_scope_authority evidence as reconciled against linked dist', () => {
    const doc = auditDoc();
    const frictionRow = tableRow(doc, 'no_scope_authority');

    expect(frictionRow).toContain('Reconciled against the current linked-dist CLI');
    expect(frictionRow).toContain('active-spec authority candidates');
    expect(frictionRow).toContain('read-only `scope --spec` checks');
    expect(frictionRow).toContain('human and JSON output');
  });

  test('records the resample evidence and implementation ledger entry', () => {
    const doc = auditDoc();

    expect(doc).toContain('### Post-Handoff Authority Resample');
    // The row must still record 4,728 sessions / 364 / 649. Matched with tolerant
    // whitespace because the cell padding is prettier's to decide, not this test's.
    expect(doc).toMatch(/Sterling `\.caws\/sessions`\s*\|\s*4,728\s*\|\s*364\s*\|\s*649/);
    expect(doc).toContain('remediation.authorityCandidates');
    // Wrap-tolerant across the whole phrase: the markdown config is
    // proseWrap: always at printWidth 80, so any word boundary here can become
    // a line break when the surrounding prose changes length.
    expect(doc).toMatch(/omits\s+the\s+stale\s+generic\s+`repair`\s+field/);
    expect(doc).toContain('UX-NO-SCOPE-AUTHORITY-SESSION-RESAMPLE-001');
    expect(doc).toContain(
      'packages/caws-cli/tests/docs/cli-ux-no-scope-authority-reconciliation.test.js'
    );
  });

  test('moves the next implementation slice to option-name mismatch resampling', () => {
    const doc = auditDoc();
    const nextSlice = doc.match(/## Next Slice\n\n([\s\S]*?)\n\n## Findings/)[1];

    // The Next Slice section is a LIVING part of the audit doc — it gets
    // rewritten each slice as work lands and the focus shifts. These
    // assertions track the SECTION'S INTENT (the next slice targets
    // `unknown_or_missing_option` resampling and has moved OFF
    // `no_scope_authority`), not exact wording, so a prose refresh between
    // slices doesn't false-fail. When the doc's next-slice focus legitimately
    //changes away from option-name resampling, update the intent here too.
    expect(nextSlice).toMatch(/`unknown_or_missing_option`/);
    expect(nextSlice).toMatch(/resampl(e|ing) the newest CAWS and\s+Sterling\s+session/);
    expect(nextSlice).not.toContain('residual `no_scope_authority` failures');
  });
});
