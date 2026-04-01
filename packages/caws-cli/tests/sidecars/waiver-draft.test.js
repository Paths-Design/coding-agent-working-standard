/**
 * Waiver Drafting Assistance Sidecar Tests
 *
 * Tests the waiver template generation from gate failures,
 * including schema compliance, description constraints, and YAML output.
 */

const yaml = require('js-yaml');
const { draftWaiver } = require('../../src/sidecars/waiver-draft');

// ============================================================
// Fixtures
// ============================================================

function makeSpec(overrides = {}) {
  return { id: 'test-spec', title: 'Test Spec', ...overrides };
}

function makeState(gateResults = [], history = []) {
  return {
    gates: { passed: false, results: gateResults, last_run: '2026-04-01T00:00:00Z' },
    history,
  };
}

function failingGate(name, messages = []) {
  return {
    name,
    status: 'fail',
    mode: 'block',
    waived: false,
    messages: messages.length > 0 ? messages : [`${name} check failed`],
    duration: 10,
  };
}

function passingGate(name) {
  return { name, status: 'pass', mode: 'block', waived: false, messages: [], duration: 5 };
}

// ============================================================
// Null / edge cases
// ============================================================

describe('draftWaiver', () => {
  test('null state returns no-state envelope', () => {
    const result = draftWaiver(null, makeSpec());
    expect(result.type).toBe('sidecar:waiver-draft');
    expect(result.status).toBe('no-state');
    expect(result.specId).toBe('test-spec');
  });

  test('no gate results returns empty drafts', () => {
    const result = draftWaiver({}, makeSpec());
    expect(result.data.drafts).toEqual([]);
    expect(result.data.summary).toBe('No gate results available');
  });

  test('no failing gates returns empty drafts', () => {
    const state = makeState([passingGate('scope_boundary')]);
    const result = draftWaiver(state, makeSpec());
    expect(result.data.drafts).toEqual([]);
    expect(result.data.summary).toBe('No failing gates found');
  });

  // ============================================================
  // Single gate failure
  // ============================================================

  test('single gate failure produces valid template', () => {
    const state = makeState([
      failingGate('scope_boundary', [
        '1 file(s) outside spec scope boundaries',
        'Out of scope (not in allowed paths): vendor/lib.js',
      ]),
    ]);
    const result = draftWaiver(state, makeSpec());

    expect(result.data.drafts).toHaveLength(1);
    const draft = result.data.drafts[0];
    expect(draft.gate).toBe('scope_boundary');
    expect(draft.category).toBe('scope');
    expect(draft.template).toBeDefined();
    expect(draft.yaml).toBeDefined();
  });

  // ============================================================
  // Schema field completeness
  // ============================================================

  test('template has all required waiver schema fields', () => {
    const state = makeState([failingGate('scope_boundary')]);
    const result = draftWaiver(state, makeSpec());
    const tpl = result.data.drafts[0].template;

    expect(tpl).toHaveProperty('id');
    expect(tpl).toHaveProperty('title');
    expect(tpl).toHaveProperty('reason');
    expect(tpl).toHaveProperty('gates');
    expect(tpl).toHaveProperty('expires_at');
    expect(tpl).toHaveProperty('approved_by');
    expect(tpl).toHaveProperty('created_at');
    expect(tpl).toHaveProperty('description');
    expect(tpl).toHaveProperty('risk_assessment');
    expect(tpl).toHaveProperty('metadata');

    expect(tpl.id).toBe('WV-XXXX');
    expect(tpl.approved_by).toBe('[REQUIRED]');
    expect(tpl.gates).toEqual(['scope_boundary']);
    expect(tpl.metadata.environment).toBe('development');
  });

  // ============================================================
  // Description constraints
  // ============================================================

  test('description is >= 50 chars', () => {
    const state = makeState([failingGate('scope_boundary', ['fail'])]);
    const result = draftWaiver(state, makeSpec());
    const desc = result.data.drafts[0].template.description;
    expect(desc.length).toBeGreaterThanOrEqual(50);
  });

  // ============================================================
  // Title constraints
  // ============================================================

  test('title is 10-200 chars', () => {
    const state = makeState([failingGate('scope_boundary')]);
    const result = draftWaiver(state, makeSpec());
    const title = result.data.drafts[0].template.title;
    expect(title.length).toBeGreaterThanOrEqual(10);
    expect(title.length).toBeLessThanOrEqual(200);
  });

  // ============================================================
  // Gate name filter
  // ============================================================

  test('--gate option filters to specific gate', () => {
    const state = makeState([
      failingGate('scope_boundary'),
      failingGate('god_object', ['CRITICAL: big.js has 2000 lines (threshold: 500)']),
    ]);
    const result = draftWaiver(state, makeSpec(), { gateName: 'god_object' });

    expect(result.data.drafts).toHaveLength(1);
    expect(result.data.drafts[0].gate).toBe('god_object');
  });

  // ============================================================
  // Recurrence → impact level
  // ============================================================

  test('recurrence affects impact_level suggestion', () => {
    // 0 recurrence → low
    const stateNoRecurrence = makeState([failingGate('scope_boundary')]);
    const r1 = draftWaiver(stateNoRecurrence, makeSpec());
    expect(r1.data.drafts[0].template.risk_assessment.impact_level).toBe('low');

    // 4+ recurrence → high (need history with consecutive blocked runs)
    const history = [];
    for (let i = 0; i < 6; i++) {
      history.push({
        command: 'gates',
        summary: '2 passed, 1 blocked',
        timestamp: new Date(Date.now() - (6 - i) * 60000).toISOString(),
      });
    }
    const stateHighRecurrence = makeState([failingGate('scope_boundary')], history);
    const r2 = draftWaiver(stateHighRecurrence, makeSpec());
    expect(r2.data.drafts[0].template.risk_assessment.impact_level).toBe('high');
    expect(r2.data.drafts[0].template.risk_assessment.review_required).toBe(true);
  });

  // ============================================================
  // Category mapping
  // ============================================================

  test('category mapping is correct', () => {
    const gates = [
      failingGate('scope_boundary'),
      failingGate('budget_limit', ['Over budget']),
      failingGate('god_object', ['CRITICAL: big.js has 2000 lines']),
      failingGate('todo_detection', ['src/a.js:10: TODO found']),
    ];
    const state = makeState(gates);
    const result = draftWaiver(state, makeSpec());

    const byGate = {};
    result.data.drafts.forEach(d => { byGate[d.gate] = d; });

    expect(byGate.scope_boundary.category).toBe('scope');
    expect(byGate.scope_boundary.template.reason).toBe('third_party_constraint');

    expect(byGate.budget_limit.category).toBe('policy');
    expect(byGate.budget_limit.template.reason).toBe('infrastructure_limitation');

    expect(byGate.god_object.category).toBe('architectural');
    expect(byGate.god_object.template.reason).toBe('legacy_integration');

    expect(byGate.todo_detection.category).toBe('quality');
    expect(byGate.todo_detection.template.reason).toBe('experimental_feature');
  });

  // ============================================================
  // YAML output
  // ============================================================

  test('YAML output is parseable', () => {
    const state = makeState([failingGate('scope_boundary')]);
    const result = draftWaiver(state, makeSpec());
    const yamlStr = result.data.drafts[0].yaml;

    const parsed = yaml.load(yamlStr);
    expect(parsed.id).toBe('WV-XXXX');
    expect(parsed.gates).toEqual(['scope_boundary']);
    expect(parsed.approved_by).toBe('[REQUIRED]');
  });

  // ============================================================
  // Multiple failing gates
  // ============================================================

  test('multiple failing gates produce multiple drafts', () => {
    const state = makeState([
      failingGate('scope_boundary'),
      failingGate('god_object', ['CRITICAL: big.js has 2000 lines']),
      passingGate('budget_limit'),
    ]);
    const result = draftWaiver(state, makeSpec());

    expect(result.data.drafts).toHaveLength(2);
    const gateNames = result.data.drafts.map(d => d.gate);
    expect(gateNames).toContain('scope_boundary');
    expect(gateNames).toContain('god_object');
    expect(result.data.summary).toContain('2 waiver drafts');
  });
});
