'use strict';

/**
 * CAWS-DSH-HARNESS-PLUGIN-PARITY-001 A3 — doctor.hooks.harness_plugin_unwired.
 *
 * The finding fires only when BOTH observations exist: the repo has the DSH
 * surface pack installed (`.dsh/AGENTS.md` marker), and the active profile's
 * composition was readable AND does not carry the CAWS bundle. A wired
 * profile, an unobserved one, or a repo without the DSH pack stays silent.
 */

const { inspectProjectState, DOCTOR_RULES } = require('../../dist/kernel');

const NOW = new Date('2026-11-09T12:00:00.000Z');

function input(filesystem) {
  return { now: NOW, specs: [], filesystem };
}

function rulesFor(filesystem) {
  return inspectProjectState(input(filesystem)).findings.map((f) => f.rule);
}

function unwired(overrides = {}) {
  return {
    surface: 'dsh',
    kind: 'unwired',
    profileName: 'desktop',
    profileDir: '/home/u/.dsh/profiles/desktop',
    profileBundle: '@caws/dsh-bundle',
    reason: 'bundle-not-installed',
    expectedPluginIds: ['caws-hooks', 'caws-session-log', 'caws-agents-lifecycle'],
    observedPluginIds: [],
    missingPluginIds: ['caws-hooks', 'caws-session-log', 'caws-agents-lifecycle'],
    repair:
      "install the CAWS DSH bundle into profile 'desktop': `dsh plugin --profile desktop add @caws/dsh-bundle`",
    ...overrides,
  };
}

describe('doctor.hooks.harness_plugin_unwired (A3)', () => {
  test('rule id is the stable string the repair text names', () => {
    expect(DOCTOR_RULES.HOOKS_HARNESS_PLUGIN_UNWIRED).toBe('doctor.hooks.harness_plugin_unwired');
  });

  test('an installed DSH pack plus an unwired profile fires a warning with the repair', () => {
    const report = inspectProjectState(
      input({ adapterPackSurfaceMarkers: ['dsh'], harnessPluginWiring: [unwired()] })
    );
    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.HOOKS_HARNESS_PLUGIN_UNWIRED
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('warning');
    expect(finding.message).toContain('@caws/dsh-bundle');
    expect(finding.narrowRepair).toContain('dsh plugin --profile desktop add');
    expect(finding.data).toMatchObject({
      surface: 'dsh',
      reason: 'bundle-not-installed',
      profile_name: 'desktop',
      profile_bundle: '@caws/dsh-bundle',
    });
  });

  test('a wired composition stays silent', () => {
    const wired = unwired({
      kind: 'wired',
      reason: undefined,
      observedPluginIds: ['caws-hooks', 'caws-session-log', 'caws-agents-lifecycle'],
      missingPluginIds: undefined,
      repair: undefined,
    });
    const rules = rulesFor({
      adapterPackSurfaceMarkers: ['dsh'],
      harnessPluginWiring: [wired],
    });
    expect(rules).not.toContain(DOCTOR_RULES.HOOKS_HARNESS_PLUGIN_UNWIRED);
  });

  test('an unobserved profile stays silent (absence of evidence is not unwired)', () => {
    const unobserved = {
      surface: 'dsh',
      kind: 'unobserved',
      reason: 'no-profile-environment',
      profileBundle: '@caws/dsh-bundle',
    };
    const rules = rulesFor({
      adapterPackSurfaceMarkers: ['dsh'],
      harnessPluginWiring: [unobserved],
    });
    expect(rules).not.toContain(DOCTOR_RULES.HOOKS_HARNESS_PLUGIN_UNWIRED);
  });

  test('no DSH pack marker in the repo stays silent even when the profile is unwired', () => {
    const rules = rulesFor({
      adapterPackSurfaceMarkers: [],
      harnessPluginWiring: [unwired()],
    });
    expect(rules).not.toContain(DOCTOR_RULES.HOOKS_HARNESS_PLUGIN_UNWIRED);
  });

  test('missing wiring observation is unobserved, never a finding', () => {
    const rules = rulesFor({ adapterPackSurfaceMarkers: ['dsh'] });
    expect(rules).not.toContain(DOCTOR_RULES.HOOKS_HARNESS_PLUGIN_UNWIRED);
  });
});
