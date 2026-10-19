const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseGuardConfiguration,
  parseNonGovernedZones,
  guardConfigurationEnvironment,
  serializeGuardEnvironment,
  loadGuardConfigurationEnvironment,
  mangleGuardName,
} = require('../../dist/runtime/guard-config');
const policy = (guards) => JSON.stringify({ guards });
const prefix = (value) => ({ prefix: value, reason: 'Generated build artifacts' });

describe('runtime guard configuration', () => {
  test('distinguishes absence, malformed input and valid empty documents', () => {
    expect(parseGuardConfiguration(null)).toEqual({ status: 'absent', guards: {} });
    for (const value of ['{', '[]', 'null', 'true']) {
      expect(parseGuardConfiguration(value)).toEqual({ status: 'invalid', guards: {} });
    }
    for (const value of ['{}', '{"guards":null}', '{"unrelated":true}']) {
      expect(parseGuardConfiguration(value)).toEqual({ status: 'ok', guards: {} });
    }
  });
  test('renders exact prefixes and clamped thresholds without touching process environment', () => {
    const before = process.env.CAWS_GUARD_CONFIG_STATUS;
    expect(
      guardConfigurationEnvironment(
        policy({
          'scope-guard.sh': { additional_allow_prefixes: [prefix('generated/')] },
          'god-object-check.sh': { thresholds: { loc: 100, delta: 100000 } },
          'write-allowlist.sh': { additional_allow_prefixes: null },
          'loc-delta-check.sh': { thresholds: null },
        }),
        null
      )
    ).toEqual({
      CAWS_GUARD_ZONE_COUNT: '0',
      CAWS_GUARD_CONFIG_STATUS: 'ok',
      CAWS_GUARD_PREFIX_COUNT_SCOPE_GUARD_SH: '1',
      CAWS_GUARD_PREFIX_SCOPE_GUARD_SH_0: 'generated/',
      CAWS_GUARD_PREFIX_COUNT_GOD_OBJECT_CHECK_SH: '0',
      CAWS_GUARD_THRESHOLD_GOD_OBJECT_CHECK_SH_LOC: '100',
      CAWS_GUARD_THRESHOLD_GOD_OBJECT_CHECK_SH_DELTA: '100000',
      CAWS_GUARD_PREFIX_COUNT_WRITE_ALLOWLIST_SH: '0',
      CAWS_GUARD_PREFIX_COUNT_LOC_DELTA_CHECK_SH: '0',
    });
    expect(process.env.CAWS_GUARD_CONFIG_STATUS).toBe(before);
  });
  test.each([
    '/elsewhere/',
    'C:\\elsewhere/',
    '../outside/',
    'a/../b/',
    'a*/',
    'a?/',
    'a[b]/',
    'a b/',
    'a=b/',
    'missing-slash',
    '.caws/',
    '.git/data/',
    '.github/workflows/',
    '.claude/',
    '.codex/',
    '.qwen/',
    '.zcode/',
    '.opencode/',
    '.kimi/',
    'a'.repeat(200) + '/',
  ])('rejects forbidden prefix %s and discards otherwise valid settings', (bad) => {
    expect(
      parseGuardConfiguration(
        policy({
          'scope-guard.sh': { additional_allow_prefixes: [prefix('generated/'), prefix(bad)] },
        })
      )
    ).toEqual({ status: 'invalid', guards: {} });
  });
  test.each([
    { unknown: {} },
    { constructor: {} },
    JSON.parse('{"__proto__":{}}'),
    { 'scope-guard.sh': [] },
    { 'scope-guard.sh': { thresholds: {} } },
    { 'scope-guard.sh': { additional_allow_prefixes: [prefix('a/'), prefix('a/')] } },
    { 'scope-guard.sh': { additional_allow_prefixes: [{ prefix: 'a/', reason: 'short' }] } },
    { 'scope-guard.sh': { additional_allow_prefixes: [{ ...prefix('a/'), extra: true }] } },
    {
      'scope-guard.sh': {
        additional_allow_prefixes: Array.from({ length: 65 }, (_, i) => prefix(`a${i}/`)),
      },
    },
    { 'scope-guard.sh': { nested: [{ DeCiSiOn: 'allow' }] } },
    { 'god-object-check.sh': { thresholds: { loc: true } } },
    { 'god-object-check.sh': { thresholds: { loc: 99 } } },
    { 'god-object-check.sh': { thresholds: { loc: 100001 } } },
    { 'loc-delta-check.sh': { thresholds: { delta: 9 } } },
    { 'loc-delta-check.sh': { thresholds: { delta: 10.5 } } },
    { 'loc-delta-check.sh': { thresholds: { loc: 100 } } },
  ])('rejects malformed guard data %#', (guards) => {
    expect(parseGuardConfiguration(policy(guards))).toEqual({ status: 'invalid', guards: {} });
  });
  test('retains legacy zone normalization independently of invalid hook policy', () => {
    const yaml =
      'non_governed_zones:\n  - "build/**" # generated\n  - \'other space/*\'\n  - /\nnext: true\n  - excluded\n';
    expect(parseNonGovernedZones(yaml)).toEqual(['build/', 'other space/', '/']);
    expect(guardConfigurationEnvironment('{', yaml)).toEqual({
      CAWS_GUARD_ZONE_COUNT: '3',
      CAWS_GUARD_ZONE_0: 'build/',
      CAWS_GUARD_ZONE_1: 'other space/',
      CAWS_GUARD_ZONE_2: '/',
      CAWS_GUARD_CONFIG_STATUS: 'invalid',
    });
    expect(parseNonGovernedZones('  non_governed_zones:\n  - excluded')).toEqual([]);
  });
  test('assignment serialization blocks forged lines and foreign variables', () => {
    expect(mangleGuardName('scope-guard.sh')).toBe('SCOPE_GUARD_SH');
    expect(
      serializeGuardEnvironment({
        CAWS_GUARD_ZONE_0: 'a b/',
        CAWS_GUARD_ZONE_1: 'a\nPATH=x',
        PATH: 'evil',
      })
    ).toBe('CAWS_GUARD_ZONE_0=a b/\n');
  });
  test('filesystem boundary treats missing optional documents as absent and reads real documents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-guard-config-'));
    try {
      expect(loadGuardConfigurationEnvironment(root)).toEqual({
        CAWS_GUARD_ZONE_COUNT: '0',
        CAWS_GUARD_CONFIG_STATUS: 'absent',
      });
      fs.mkdirSync(path.join(root, '.caws/hooks'), { recursive: true });
      fs.writeFileSync(path.join(root, '.caws/hooks/hook-policy.json'), '{}');
      fs.writeFileSync(
        path.join(root, '.caws/policy.yaml'),
        'non_governed_zones:\n  - generated/**\n'
      );
      expect(loadGuardConfigurationEnvironment(root)).toEqual({
        CAWS_GUARD_ZONE_COUNT: '1',
        CAWS_GUARD_ZONE_0: 'generated/',
        CAWS_GUARD_CONFIG_STATUS: 'ok',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
