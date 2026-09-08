'use strict';

/**
 * Focused authority-contract tests for bridge-backed binding resolution.
 *
 * These exercise the resolver directly so that session identity, retired
 * specs, and multiple-bridge disambiguation cannot be hidden behind command
 * rendering or store setup. The command-level lifecycle remains covered by
 * claim-bridge.test.js.
 *
 * [AUTH-BINDING-BRIDGE-001]
 * [CAWS-CI-MUTATION-PROOF-DURABILITY-001]
 */

const { resolveBinding } = require('../../dist/shell/binding/resolve-binding');

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

function bridge(sessionId) {
  return {
    session_id: sessionId,
    acquired_at: '2026-09-04T00:00:00.000Z',
  };
}

function spec(id, scopeIn, lifecycleState = 'active') {
  return {
    id,
    lifecycle_state: lifecycleState,
    scope: { in: scopeIn, out: [] },
  };
}

function resolve(overrides = {}) {
  return resolveBinding({
    repoRoot: '/repo',
    cwd: '/repo',
    registry: {},
    specs: [],
    gitWorktreeList: () => [],
    ...overrides,
  });
}

describe('resolveBinding bridge authority', () => {
  test('one active bridge governs the session independent of target-path admission', () => {
    const active = spec('SPEC-A', ['src/**']);

    const result = resolve({
      bridges: { 'SPEC-A': bridge(SESSION_A) },
      sessionId: SESSION_A,
      specs: [active],
      targetPath: 'docs/outside-scope.md',
    });

    expect(result).toEqual({
      binding: {
        kind: 'bridged',
        spec: active,
        session_id: SESSION_A,
      },
      source: 'bridge_claim',
    });
  });

  test.each([
    ['missing session identity', undefined],
    ['empty session identity', ''],
    ['non-string session identity', 42],
  ])('%s confers no bridge authority', (_label, sessionId) => {
    const result = resolve({
      bridges: { 'SPEC-A': bridge(sessionId ?? SESSION_A) },
      sessionId,
      specs: [spec('SPEC-A', ['src/**'])],
      targetPath: 'src/file.ts',
    });

    expect(result).toEqual({ binding: { kind: 'unbound' }, source: 'none' });
  });

  test('foreign, missing, and retired bridge records confer no authority', () => {
    const result = resolve({
      bridges: {
        FOREIGN: bridge(SESSION_B),
        MISSING: bridge(SESSION_A),
        CLOSED: bridge(SESSION_A),
        ARCHIVED: bridge(SESSION_A),
      },
      sessionId: SESSION_A,
      specs: [
        spec('FOREIGN', ['src/**']),
        spec('CLOSED', ['src/**'], 'closed'),
        spec('ARCHIVED', ['src/**'], 'archived'),
      ],
      targetPath: 'src/file.ts',
    });

    expect(result).toEqual({ binding: { kind: 'unbound' }, source: 'none' });
  });

  test('multiple active bridges select the sole spec whose scope claims the target', () => {
    const sourceSpec = spec('SOURCE', ['src/**']);
    const docsSpec = spec('DOCS', ['docs/**']);

    const result = resolve({
      bridges: {
        SOURCE: bridge(SESSION_A),
        DOCS: bridge(SESSION_A),
      },
      sessionId: SESSION_A,
      specs: [sourceSpec, docsSpec],
      targetPath: 'src/file.ts',
    });

    expect(result).toEqual({
      binding: {
        kind: 'bridged',
        spec: sourceSpec,
        session_id: SESSION_A,
      },
      source: 'bridge_claim',
    });
  });

  test.each([
    ['no bridge claims the target', ['src/**', 'docs/**'], 'examples/file.ts'],
    ['more than one bridge claims the target', ['src/**', 'src/file.ts'], 'src/file.ts'],
    ['there is no target to disambiguate', ['src/**', 'docs/**'], undefined],
    ['the target is empty', ['src/**', 'docs/**'], ''],
  ])('%s leaves a multiple-bridge session honestly unbound', (_label, scopeEntries, targetPath) => {
    const result = resolve({
      bridges: {
        FIRST: bridge(SESSION_A),
        SECOND: bridge(SESSION_A),
      },
      sessionId: SESSION_A,
      specs: [
        spec('FIRST', [scopeEntries[0]]),
        spec('SECOND', [scopeEntries[1]]),
      ],
      targetPath,
    });

    expect(result).toEqual({ binding: { kind: 'unbound' }, source: 'none' });
  });

  test('ineligible records are filtered before multiple-bridge disambiguation', () => {
    const eligible = spec('ELIGIBLE', ['src/**']);

    const result = resolve({
      bridges: {
        ELIGIBLE: bridge(SESSION_A),
        FOREIGN: bridge(SESSION_B),
        MISSING: bridge(SESSION_A),
        CLOSED: bridge(SESSION_A),
      },
      sessionId: SESSION_A,
      specs: [
        eligible,
        spec('FOREIGN', ['src/**']),
        spec('CLOSED', ['src/**'], 'closed'),
      ],
      targetPath: 'not/in/any/scope.txt',
    });

    expect(result.binding.kind).toBe('bridged');
    expect(result.binding.spec.id).toBe('ELIGIBLE');
  });
});
