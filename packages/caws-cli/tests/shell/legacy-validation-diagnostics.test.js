'use strict';

const {
  classifyLegacyCommand,
  formatLegacyDiagnostic,
} = require('../../src/shell/legacy-command-map');

function diagnosticFor(argv) {
  const entry = classifyLegacyCommand(argv);
  if (entry === null) throw new Error(`expected legacy command for ${argv.join(' ')}`);
  return formatLegacyDiagnostic(entry).join('\n');
}

describe('validation-era legacy command diagnostics', () => {
  test('validate and verify hand off to doctor plus gates', () => {
    for (const command of ['validate', 'verify']) {
      const diagnostic = diagnosticFor([command]);

      expect(diagnostic).toContain(`caws ${command}`);
      expect(diagnostic).toContain('Use instead:');
      expect(diagnostic).toContain('caws doctor');
      expect(diagnostic).toContain('caws gates run --spec <id>');
      expect(diagnostic).toContain('docs/migration-v10-to-v11.md#replaced');
    }
  });

  test('removed validation-era commands preserve command-specific guidance', () => {
    const cases = [
      {
        argv: ['verify-acs'],
        expected: 'Encode AC-evidence assertions in your test suite directly.',
      },
      {
        argv: ['evaluate'],
        expected: 'caws gates run covers policy gates; quality-evaluation reports are not reproduced.',
      },
      {
        argv: ['iterate'],
        expected: "Use spec acceptance criteria as guidance.",
      },
      {
        argv: ['burnup'],
        expected: 'Derive budget burn-up from caws status + spec change_budget manually.',
      },
    ];

    for (const { argv, expected } of cases) {
      const diagnostic = diagnosticFor(argv);

      expect(diagnostic).toContain(expected);
      expect(diagnostic).not.toContain('Use instead:\n  caws doctor\n  caws gates run --spec <id>');
      expect(diagnostic).toContain('docs/migration-v10-to-v11.md#removed-without-replacement');
    }
  });

  test('diagnose remains a direct doctor rename', () => {
    const diagnostic = diagnosticFor(['diagnose']);

    expect(diagnostic).toContain('caws diagnose was renamed to caws doctor in v11.');
    expect(diagnostic).toContain('Use instead:');
    expect(diagnostic).toContain('caws doctor');
    expect(diagnostic).not.toContain('caws gates run --spec <id>');
  });
});
