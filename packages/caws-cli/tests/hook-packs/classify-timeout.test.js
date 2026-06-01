/**
 * HOOK-PACK-SUBPROCESS-TIMEOUT-RELIABILITY-001 (A2): the shared
 * classifyTimeoutMs helper honors a numeric CAWS_TEST_CLASSIFY_TIMEOUT_MS
 * override and falls back to the bounded 15000 ms default for unset / empty /
 * non-numeric / non-positive values. A misconfigured override must NEVER
 * disable the timeout.
 */

'use strict';

const {
  classifyTimeoutMs,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
} = require('./lib/classify-timeout');

describe('classifyTimeoutMs — classifier-spawn timeout resolution', () => {
  it('default is 15000 ms (matches the suite bash/guard spawns)', () => {
    expect(DEFAULT_CLASSIFY_TIMEOUT_MS).toBe(15000);
  });

  it('unset env → default', () => {
    expect(classifyTimeoutMs({})).toBe(15000);
  });

  it('numeric override is honored', () => {
    expect(classifyTimeoutMs({ CAWS_TEST_CLASSIFY_TIMEOUT_MS: '30000' })).toBe(30000);
  });

  it('empty string → default (not 0)', () => {
    expect(classifyTimeoutMs({ CAWS_TEST_CLASSIFY_TIMEOUT_MS: '' })).toBe(15000);
  });

  it('whitespace-only → default', () => {
    expect(classifyTimeoutMs({ CAWS_TEST_CLASSIFY_TIMEOUT_MS: '   ' })).toBe(15000);
  });

  it('non-numeric → default (never NaN-as-timeout)', () => {
    expect(classifyTimeoutMs({ CAWS_TEST_CLASSIFY_TIMEOUT_MS: 'soon' })).toBe(15000);
  });

  it('zero → default (a 0 timeout would DISABLE the abort — refused)', () => {
    expect(classifyTimeoutMs({ CAWS_TEST_CLASSIFY_TIMEOUT_MS: '0' })).toBe(15000);
  });

  it('negative → default', () => {
    expect(classifyTimeoutMs({ CAWS_TEST_CLASSIFY_TIMEOUT_MS: '-1' })).toBe(15000);
  });

  it('result is always a positive finite number', () => {
    for (const v of [undefined, '', 'x', '0', '-5', '12000', '999999']) {
      const env = v === undefined ? {} : { CAWS_TEST_CLASSIFY_TIMEOUT_MS: v };
      const t = classifyTimeoutMs(env);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThan(0);
    }
  });
});
