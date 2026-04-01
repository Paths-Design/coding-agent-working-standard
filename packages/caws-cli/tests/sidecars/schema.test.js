/**
 * Sidecar Schema Tests
 *
 * Tests the shared output envelope constructors and text formatter.
 */

const {
  createSidecarOutput,
  createNoStateOutput,
  formatSidecarText,
} = require('../../src/sidecars/schema');

// ============================================================
// createSidecarOutput
// ============================================================

describe('createSidecarOutput', () => {
  test('produces correct envelope structure', () => {
    const output = createSidecarOutput('drift', 'SPEC-1', { drift_detected: false });

    expect(output.type).toBe('sidecar:drift');
    expect(output.specId).toBe('SPEC-1');
    expect(output.status).toBe('ok');
    expect(output.data).toEqual({ drift_detected: false });
    expect(output.meta).toHaveProperty('duration_ms');
    expect(typeof output.meta.duration_ms).toBe('number');
    // Timestamp is ISO-8601
    expect(() => new Date(output.timestamp)).not.toThrow();
    expect(output.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('hoists data.status to top-level status', () => {
    const output = createSidecarOutput('gaps', 'SPEC-2', {
      status: 'warning',
      gaps: [],
    });

    expect(output.status).toBe('warning');
    // data should not contain the hoisted status
    expect(output.data.status).toBeUndefined();
    expect(output.data.gaps).toEqual([]);
  });

  test('defaults status to ok when data has no status', () => {
    const output = createSidecarOutput('provenance', 'SPEC-3', { total: 5 });
    expect(output.status).toBe('ok');
  });

  test('merges extra meta fields', () => {
    const output = createSidecarOutput('drift', 'SPEC-1', {}, { duration_ms: 42, agent: 'test' });
    expect(output.meta.duration_ms).toBe(42);
    expect(output.meta.agent).toBe('test');
  });
});

// ============================================================
// createNoStateOutput
// ============================================================

describe('createNoStateOutput', () => {
  test('returns no-state status with message', () => {
    const output = createNoStateOutput('drift', 'SPEC-1');

    expect(output.type).toBe('sidecar:drift');
    expect(output.specId).toBe('SPEC-1');
    expect(output.status).toBe('no-state');
    expect(output.data.message).toMatch(/no working state/i);
  });
});

// ============================================================
// formatSidecarText
// ============================================================

describe('formatSidecarText', () => {
  test('renders no-state status as message', () => {
    const output = createNoStateOutput('drift', 'SPEC-1');
    const text = formatSidecarText(output);
    expect(text).toContain('No working state');
  });

  test('renders drift output without crashing', () => {
    const output = createSidecarOutput('drift', 'SPEC-1', {
      drift_detected: true,
      out_of_scope_files: ['vendor/lib.js'],
      missing_evidence: [{ id: 'AC-3', description: 'Handle edge case' }],
      failing_criteria: [{ id: 'AC-1', description: 'Core feature works' }],
      scope_creep_files: ['src/unrelated.js'],
      summary: '1 file outside scope, 1 AC failing, 1 AC unchecked',
    });
    const text = formatSidecarText(output);
    expect(text).toContain('Drift');
    expect(text).toContain('vendor/lib.js');
    expect(text).toContain('AC-3');
    expect(text).toContain('AC-1');
  });

  test('renders gaps output without crashing', () => {
    const output = createSidecarOutput('gaps', 'SPEC-1', {
      current_phase: 'implement',
      target_phase: 'verify',
      gaps: [
        { category: 'validation_failure', severity: 'blocker', message: 'No tests written', remediation: 'caws validate' },
        { category: 'no_evaluation', severity: 'warning', message: 'Docs incomplete', remediation: 'caws evaluate' },
      ],
    });
    const text = formatSidecarText(output);
    expect(text).toContain('Phase Gaps');
    expect(text).toContain('implement');
    expect(text).toContain('No tests written');
    expect(text).toContain('caws validate');
  });

  test('renders waiver-draft output without crashing', () => {
    const output = createSidecarOutput('waiver-draft', 'SPEC-1', {
      drafts: [
        { gate: 'scope_boundary', yaml: 'gate: scope_boundary\nreason: emergency' },
      ],
    });
    const text = formatSidecarText(output);
    expect(text).toContain('Waiver');
    expect(text).toContain('scope_boundary');
  });

  test('renders provenance output without crashing', () => {
    const output = createSidecarOutput('provenance', 'SPEC-1', {
      file_stats: { total: 12 },
      command_history: [{ cmd: 'gates' }, { cmd: 'validate' }],
      progression: 'implement -> verify',
      merge_readiness: true,
    });
    const text = formatSidecarText(output);
    expect(text).toContain('Provenance');
    expect(text).toContain('12');
    expect(text).toContain('ready');
  });

  test('renders provenance with merge not ready', () => {
    const output = createSidecarOutput('provenance', 'SPEC-1', {
      file_stats: { total: 3 },
      command_history: [],
      progression: 'plan',
      merge_readiness: false,
    });
    const text = formatSidecarText(output);
    expect(text).toContain('not ready');
  });

  test('handles unknown sidecar type with JSON dump', () => {
    const output = createSidecarOutput('unknown-type', 'SPEC-1', { foo: 'bar' });
    const text = formatSidecarText(output);
    // Should be valid JSON
    const parsed = JSON.parse(text);
    expect(parsed.foo).toBe('bar');
  });
});
