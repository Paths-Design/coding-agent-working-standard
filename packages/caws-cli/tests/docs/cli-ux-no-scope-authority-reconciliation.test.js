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
  return markdown
    .split('\n')
    .find((line) => line.startsWith(`| \`${firstCell}\``));
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
    expect(doc).toContain('Sterling `.caws/sessions` | 4,728 | 364 | 649');
    expect(doc).toContain('remediation.authorityCandidates');
    expect(doc).toMatch(/omits the stale generic `repair`\s+field/);
    expect(doc).toContain('UX-NO-SCOPE-AUTHORITY-SESSION-RESAMPLE-001');
    expect(doc).toContain(
      'packages/caws-cli/tests/docs/cli-ux-no-scope-authority-reconciliation.test.js'
    );
  });

  test('moves the next implementation slice to option-name mismatch resampling', () => {
    const doc = auditDoc();
    const nextSlice = doc.match(/## Next Slice\n\n([\s\S]*?)\n\n## Findings/)[1];

    expect(nextSlice).toContain('`unknown_or_missing_option` bucket');
    expect(nextSlice).toMatch(/resampling the newest CAWS and\s+Sterling session retries/);
    expect(nextSlice).not.toContain('residual `no_scope_authority` failures');
  });
});
