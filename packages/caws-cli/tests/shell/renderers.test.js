/**
 * Tests for the three pure renderers under src/shell/render/.
 *
 * These are pure string-formatters. They must:
 *   - print the rule id (stable agent handle)
 *   - print severity (so agents and humans can triage at a glance)
 *   - never read files
 *   - never decide exit codes
 *   - distinguish the three scope no_authority shapes when boundContext
 *     is provided (rule id unchanged; only human prose differs)
 *   - NOT inspect `authority` for behavior
 */

'use strict';

const {
  renderDiagnostic,
  renderDiagnostics,
  countSeverities,
  renderFinding,
  renderFindings,
  countFindingSeverities,
  renderDecision,
} = require('../../dist/shell');

describe('renderDiagnostic / renderDiagnostics', () => {
  it('prints the rule id, severity label, and message', () => {
    const out = renderDiagnostic({
      rule: 'shell.session.no_stable_identity',
      authority: 'kernel/diagnostics',
      severity: 'error',
      message: 'No stable session identity could be resolved.',
    });
    expect(out).toContain('[ERROR  ]');
    expect(out).toContain('shell.session.no_stable_identity');
    expect(out).toContain('No stable session identity');
  });

  it('renders subject and narrowRepair when present', () => {
    const out = renderDiagnostic({
      rule: 'store.specs.duplicate_id',
      authority: 'kernel/diagnostics',
      severity: 'warning',
      message: 'Duplicate spec id detected.',
      subject: 'FOO-1.yaml',
      narrowRepair: 'Remove or rename the duplicate file.',
    });
    expect(out).toMatch(/subject: FOO-1\.yaml/);
    expect(out).toMatch(/repair:\s+Remove or rename/);
  });

  it('omits `data` block unless showData is true', () => {
    const d = {
      rule: 'store.events.invalid_event_shape',
      authority: 'kernel/diagnostics',
      severity: 'error',
      message: 'Invalid event shape.',
      data: { line: 7 },
    };
    expect(renderDiagnostic(d)).not.toMatch(/data:/);
    expect(renderDiagnostic(d, { showData: true })).toMatch(/data:\s+{"line":7}/);
  });

  it('defaults missing severity to error', () => {
    const out = renderDiagnostic({
      rule: 'shell.x',
      authority: 'kernel/diagnostics',
      message: 'no severity field present',
    });
    expect(out).toContain('[ERROR  ]');
  });

  it('renderDiagnostics filters below minSeverity', () => {
    const list = [
      {
        rule: 'a',
        authority: 'kernel/diagnostics',
        severity: 'info',
        message: 'i',
      },
      {
        rule: 'b',
        authority: 'kernel/diagnostics',
        severity: 'warning',
        message: 'w',
      },
      {
        rule: 'c',
        authority: 'kernel/diagnostics',
        severity: 'error',
        message: 'e',
      },
    ];
    const out = renderDiagnostics(list, { minSeverity: 'warning' });
    expect(out).toContain('[WARN   ] b');
    expect(out).toContain('[ERROR  ] c');
    expect(out).not.toContain('[INFO   ] a');
  });

  it('countSeverities tallies error/warning/info', () => {
    expect(
      countSeverities([
        { rule: 'a', authority: 'kernel/diagnostics', severity: 'error', message: '' },
        { rule: 'b', authority: 'kernel/diagnostics', severity: 'error', message: '' },
        { rule: 'c', authority: 'kernel/diagnostics', severity: 'warning', message: '' },
        { rule: 'd', authority: 'kernel/diagnostics', severity: 'info', message: '' },
      ])
    ).toEqual({ errors: 2, warnings: 1, infos: 1 });
  });
});

describe('renderFinding / renderFindings', () => {
  it('prints rule, severity, and message', () => {
    const out = renderFinding({
      rule: 'doctor.binding.spec_not_governable',
      authority: 'kernel/diagnostics',
      severity: 'error',
      message: 'Spec is bound but is not governable.',
    });
    expect(out).toContain('[ERROR  ]');
    expect(out).toContain('doctor.binding.spec_not_governable');
  });

  it('countFindingSeverities tallies', () => {
    expect(
      countFindingSeverities([
        { rule: 'a', authority: 'kernel/diagnostics', severity: 'error', message: '' },
        { rule: 'b', authority: 'kernel/diagnostics', severity: 'warning', message: '' },
        { rule: 'c', authority: 'kernel/diagnostics', severity: 'warning', message: '' },
        { rule: 'd', authority: 'kernel/diagnostics', severity: 'info', message: '' },
      ])
    ).toEqual({ errors: 1, warnings: 2, infos: 1 });
  });

  it('renderFindings respects minSeverity', () => {
    const out = renderFindings(
      [
        { rule: 'i', authority: 'kernel/diagnostics', severity: 'info', message: '' },
        { rule: 'w', authority: 'kernel/diagnostics', severity: 'warning', message: '' },
      ],
      { minSeverity: 'warning' }
    );
    expect(out).toContain('w');
    expect(out).not.toContain('[INFO');
  });
});

describe('renderDecision — three no_authority shapes', () => {
  // The kernel rule id is constant across shapes; only the human prose
  // changes via the optional boundContext shell hint.

  const baseUnbound = {
    kind: 'no_authority',
    rule: 'scope.no_authority.unbound',
    authority: 'kernel/scope',
    path: 'src/foo.ts',
    normalizedPath: 'src/foo.ts',
    message: 'No spec is bound to this worktree.',
    narrowRepair: 'Run `caws worktree bind <name> --spec <id>` to bind a spec.',
    bindingState: 'unbound',
  };

  it('unbound + boundContext with worktreeName → "tracked worktree without spec"', () => {
    const out = renderDecision(baseUnbound, {
      boundContext: {
        binding: { kind: 'unbound' },
        worktreeName: 'wt-foo',
        source: 'registry_path_match',
      },
    });
    expect(out).toContain('scope.no_authority.unbound');
    expect(out).toMatch(/tracked worktree 'wt-foo'/);
    expect(out).not.toMatch(/outside any CAWS-tracked worktree/);
  });

  it('unbound + boundContext without worktreeName → "outside any worktree"', () => {
    const out = renderDecision(baseUnbound, {
      boundContext: { binding: { kind: 'unbound' }, source: 'none' },
    });
    expect(out).toContain('scope.no_authority.unbound');
    expect(out).toMatch(/outside any CAWS-tracked worktree/);
  });

  it('one_sided is rendered with the distinct rule id', () => {
    const out = renderDecision({
      kind: 'no_authority',
      rule: 'scope.no_authority.binding_one_sided',
      authority: 'kernel/scope',
      path: 'src/foo.ts',
      message: 'Binding is one-sided.',
      bindingState: 'one_sided',
    });
    expect(out).toContain('scope.no_authority.binding_one_sided');
    expect(out).not.toMatch(/tracked worktree '/);
    expect(out).not.toMatch(/outside any/);
  });

  it('admit decision renders without nuance text', () => {
    const out = renderDecision({
      kind: 'admit',
      rule: 'scope.admit.scope_in',
      authority: 'kernel/scope',
      path: 'src/foo.ts',
      message: 'Admitted by scope.in.',
      bindingState: 'bound',
    });
    expect(out).toContain('ADMIT');
    expect(out).toContain('scope.admit.scope_in');
    expect(out).toContain('binding: bound');
  });

  it('reject decision renders distinctly from admit', () => {
    const out = renderDecision({
      kind: 'reject',
      rule: 'scope.reject.scope_out',
      authority: 'kernel/scope',
      path: 'docs/foo.md',
      message: 'Rejected by scope.out.',
      bindingState: 'bound',
    });
    expect(out).toContain('REJECT');
    expect(out).toContain('scope.reject.scope_out');
  });

  it('invalid_path renders the INVALID label', () => {
    const out = renderDecision({
      kind: 'invalid_path',
      rule: 'scope.invalid_path.absolute',
      authority: 'kernel/scope',
      path: '/absolute/x',
      message: 'Path must be relative.',
      bindingState: 'bound',
    });
    expect(out).toContain('INVALID');
    expect(out).toContain('scope.invalid_path.absolute');
  });
});
