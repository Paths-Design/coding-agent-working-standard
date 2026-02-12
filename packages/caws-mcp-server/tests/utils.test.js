/**
 * @fileoverview Tests for MCP server utility functions
 */

import { stripAnsi, ok, jsonOk, err } from '../src/utils.js';

describe('MCP Server Utils', () => {
  describe('stripAnsi', () => {
    test('strips SGR color codes', () => {
      expect(stripAnsi('\u001b[31mred text\u001b[0m')).toBe('red text');
    });

    test('strips bold and other SGR sequences', () => {
      expect(stripAnsi('\u001b[1mbold\u001b[22m normal')).toBe('bold normal');
    });

    test('strips multiple color codes', () => {
      expect(stripAnsi('\u001b[32mgreen\u001b[0m and \u001b[34mblue\u001b[0m')).toBe('green and blue');
    });

    test('preserves newlines', () => {
      expect(stripAnsi('line1\nline2\n')).toBe('line1\nline2\n');
    });

    test('preserves tabs', () => {
      expect(stripAnsi('col1\tcol2')).toBe('col1\tcol2');
    });

    test('strips hyperlink sequences', () => {
      expect(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007')).toBe('link');
    });

    test('returns null for null input', () => {
      expect(stripAnsi(null)).toBe(null);
    });

    test('returns undefined for undefined input', () => {
      expect(stripAnsi(undefined)).toBe(undefined);
    });

    test('returns empty string for empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    test('returns plain text unchanged', () => {
      expect(stripAnsi('plain text')).toBe('plain text');
    });
  });

  describe('ok', () => {
    test('returns MCP text response shape', () => {
      const result = ok('hello');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'hello' }],
      });
    });

    test('preserves multiline text', () => {
      const result = ok('line1\nline2');
      expect(result.content[0].text).toBe('line1\nline2');
    });
  });

  describe('jsonOk', () => {
    test('returns pretty-printed JSON content', () => {
      const result = jsonOk({ key: 'value' });
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual({ key: 'value' });
    });

    test('uses 2-space indentation', () => {
      const result = jsonOk({ a: 1 });
      expect(result.content[0].text).toBe('{\n  "a": 1\n}');
    });
  });

  describe('err', () => {
    test('returns error response with isError flag', () => {
      const result = err('something failed');
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: 'something failed' });
    });

    test('wraps message in error object', () => {
      const result = err('test error');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('error', 'test error');
    });
  });
});
