/**
 * Unit coverage for the init hook-pack render formatters
 * (CAWS-CLI-COVERAGE-FLOOR-001). These are pure functions taking plain data
 * objects, so every branch is reachable from synthetic fixtures. The
 * formatters are required directly from the compiled subpath — they are not
 * re-exported through the top dist/shell barrel and are otherwise exercised
 * only indirectly through runInitCommand integration tests.
 */

'use strict';

const {
  renderHookPackInstall,
  renderSettingsWiring,
  renderActivationContract,
} = require('../../dist/shell/render/init-hook-pack');

const PACK = {
  id: 'claude-code',
  targetSurface: 'claude-code',
  packVersion: 11,
  cawsMinMajor: 11,
  lifecycleEvents: [],
  files: [],
  summary: 'CAWS Claude Code hook pack',
};

function installResult(overrides = {}) {
  return {
    outcome: 'installed',
    pack: PACK,
    actions: [],
    activation: 'restart_required',
    ...overrides,
  };
}

describe('renderHookPackInstall', () => {
  it('skipped_explicit_none (no pack) renders the --agent-surface none section', () => {
    const out = renderHookPackInstall({
      outcome: 'skipped_explicit_none',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    });
    expect(out).toContain('Skipped — --agent-surface none');
    expect(out).toContain('NOT agent-safe');
  });

  it('skipped_ambiguous (no pack) renders the no-harness-detected section', () => {
    const out = renderHookPackInstall({
      outcome: 'skipped_ambiguous',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    });
    expect(out).toContain('no harness detected');
    expect(out).toContain('--agent-surface claude-code');
  });

  it('renders each action bucket header (created/updated/unchanged)', () => {
    const out = renderHookPackInstall(
      installResult({
        actions: [
          { action: 'created', destPath: 'a.sh' },
          { action: 'updated', destPath: 'b.sh' },
          { action: 'unchanged', destPath: 'c.sh' },
        ],
      })
    );
    expect(out).toContain('Created (1):');
    expect(out).toContain('Updated (1):');
    expect(out).toContain('Unchanged (1):');
  });

  it('refused actions render the remediation block (--overwrite / --adopt)', () => {
    const out = renderHookPackInstall(
      installResult({
        actions: [
          { action: 'refused', destPath: 'd.sh', refusalReason: 'unmanaged_collision' },
        ],
      })
    );
    expect(out).toContain('Refused (1):');
    expect(out).toContain('--overwrite');
    expect(out).toContain('--adopt');
    expect(out).toContain('unmanaged_collision');
  });

  it('refused action with no refusalReason falls back to "unknown"', () => {
    const out = renderHookPackInstall(
      installResult({ actions: [{ action: 'refused', destPath: 'e.sh' }] })
    );
    expect(out).toContain('[refused: unknown]');
  });

  it('no refused actions → no remediation block', () => {
    const out = renderHookPackInstall(
      installResult({ actions: [{ action: 'created', destPath: 'a.sh' }] })
    );
    expect(out).not.toContain('One or more files were refused');
  });
});

describe('renderSettingsWiring — merge-result path', () => {
  const WIRED = { kind: 'wired' };

  it('mergeResult created', () => {
    const out = renderSettingsWiring(WIRED, { kind: 'created', path: '.claude/settings.json' });
    expect(out).toContain('Created .claude/settings.json');
  });

  it('mergeResult merged lists the added keys', () => {
    const out = renderSettingsWiring(WIRED, {
      kind: 'merged',
      path: '.claude/settings.json',
      added: ['PreToolUse', 'Stop'],
    });
    expect(out).toContain('Merged');
    expect(out).toContain('PreToolUse, Stop');
  });

  it('mergeResult unchanged', () => {
    const out = renderSettingsWiring(WIRED, { kind: 'unchanged', path: '.claude/settings.json' });
    expect(out).toContain('already wires all four');
  });

  it('mergeResult invalid surfaces the parse error + canonical snippet', () => {
    const out = renderSettingsWiring(WIRED, {
      kind: 'invalid',
      path: '.claude/settings.json',
      error: 'Unexpected token }',
    });
    expect(out).toContain('could not be parsed: Unexpected token }');
  });

  it('orphanedDispatchDir present → leave-and-warn block', () => {
    const out = renderSettingsWiring(
      WIRED,
      { kind: 'created', path: '.claude/settings.json' },
      '.claude/hooks/dispatch'
    );
    expect(out).toContain('WARNING');
    expect(out).toContain('.claude/hooks/dispatch');
  });

  it('orphanedDispatchDir null → no warning block', () => {
    const out = renderSettingsWiring(
      WIRED,
      { kind: 'created', path: '.claude/settings.json' },
      null
    );
    expect(out).not.toContain('WARNING');
  });
});

describe('renderSettingsWiring — inspection-only fallback (no mergeResult)', () => {
  it('status wired', () => {
    expect(renderSettingsWiring({ kind: 'wired' })).toContain('already wires all four');
  });
  it('status invalid', () => {
    const out = renderSettingsWiring({ kind: 'invalid', error: 'bad json' });
    expect(out).toContain('could not be parsed: bad json');
  });
  it('status absent prints the canonical snippet', () => {
    const out = renderSettingsWiring({ kind: 'absent' });
    expect(out).toContain('No .claude/settings.json present');
  });
  it('status partial lists missing entries', () => {
    const out = renderSettingsWiring({ kind: 'partial', missing: ['Stop', 'SessionStart'] });
    expect(out).toContain('Missing entries (2): Stop, SessionStart');
  });
});

describe('renderActivationContract', () => {
  it('no pack → governance not in effect', () => {
    const out = renderActivationContract({
      outcome: 'skipped_explicit_none',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    });
    expect(out).toContain('NOT in effect');
  });

  it('skipped_ambiguous → no pack selected', () => {
    const out = renderActivationContract({
      outcome: 'skipped_ambiguous',
      pack: null,
      actions: [],
      activation: 'not_applicable',
    });
    expect(out).toContain('NOT in effect');
  });

  it('immediate activation → active in current session', () => {
    const out = renderActivationContract(installResult({ activation: 'immediate' }));
    expect(out).toContain('active in the current session');
  });

  it('restart_required + unchanged + wired → positive confirmation', () => {
    const out = renderActivationContract(
      installResult({ outcome: 'unchanged', activation: 'restart_required' }),
      { kind: 'wired' }
    );
    expect(out).toContain('active in any Claude Code');
  });

  it('restart_required + changed + wired → restart to load updated hooks', () => {
    const out = renderActivationContract(
      installResult({ outcome: 'updated', activation: 'restart_required' }),
      { kind: 'wired' }
    );
    expect(out).toContain('Restart the Claude Code session');
  });

  it('restart_required + changed + NOT wired → STOP sign', () => {
    const out = renderActivationContract(
      installResult({ outcome: 'installed', activation: 'restart_required' }),
      { kind: 'absent' }
    );
    expect(out).toContain('RESTART REQUIRED');
    expect(out).toContain('STOP.');
  });

  it('restart_required + unchanged + NOT wired → wiring-incomplete branch', () => {
    const out = renderActivationContract(
      installResult({ outcome: 'unchanged', activation: 'restart_required' }),
      { kind: 'partial', missing: ['Stop'] }
    );
    expect(out).toContain('wiring is not complete');
  });

  it('unknown activation → consult harness docs', () => {
    const out = renderActivationContract(installResult({ activation: 'unknown' }));
    expect(out).toContain('not known');
  });
});
