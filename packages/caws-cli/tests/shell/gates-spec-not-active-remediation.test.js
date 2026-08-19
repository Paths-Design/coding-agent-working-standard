'use strict';

/**
 * CAWS-SPEC-ACTIVATION-BINDS-001 — the spec_not_active violation names a
 * command that applies to the state the spec is actually in.
 *
 * The message used to say "Either reopen the spec or run gates against an
 * active spec" for every non-active state. `caws specs reopen` is closed-only,
 * so on a draft that is a remediation the CLI itself refuses — the failure
 * class this repo treats as most dangerous, because it teaches agents that the
 * guidance is not worth following. Since `specs create` now yields a draft,
 * draft is the COMMON way to reach this violation, not a corner case.
 */

const { evaluateSpecCompleteness } = require('../../dist/shell/gates/local-evaluators/spec-completeness');

function violationFor(lifecycleState) {
  const result = evaluateSpecCompleteness({
    spec: {
      id: 'GATE-LIFECYCLE-001',
      lifecycle_state: lifecycleState,
      blast_radius: { modules: ['tests'] },
      invariants: ['fixture'],
      acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
      scope: { in: ['tests'], out: [] },
    },
  });
  return result.violations.find((v) => v.type === 'spec_not_active');
}

describe('gates spec_not_active remediation is state-specific', () => {
  test('a draft is told to bind or activate — never to reopen', () => {
    const v = violationFor('draft');

    expect(v).toBeDefined();
    expect(v.message).toContain('caws worktree create <name> --spec GATE-LIFECYCLE-001');
    expect(v.message).toContain('caws specs activate GATE-LIFECYCLE-001');
    // reopen refuses on a draft; naming it here is a remediation that fails.
    expect(v.message).not.toContain('reopen');
  });

  test('a closed spec is told to reopen', () => {
    const v = violationFor('closed');

    expect(v.message).toContain('caws specs reopen GATE-LIFECYCLE-001');
    expect(v.message).not.toContain('caws specs activate');
  });

  test('an archived spec is told to restore', () => {
    const v = violationFor('archived');

    expect(v.message).toContain('caws specs restore GATE-LIFECYCLE-001');
    expect(v.message).not.toContain('reopen');
  });

  test('an active spec raises no lifecycle violation at all', () => {
    expect(violationFor('active')).toBeUndefined();
  });
});
