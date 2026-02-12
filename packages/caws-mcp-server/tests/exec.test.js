/**
 * @fileoverview Tests for MCP server exec utilities (path resolution)
 */

import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');

// Mock fs.existsSync to control path resolution
let mockExistsSync;

jest.unstable_mockModule('fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
  default: { existsSync: (...args) => mockExistsSync(...args) },
}));

const { findQualityGatesRunner, findExceptionFramework, findRefactorProgressChecker } =
  await import('../src/exec.js');

describe('MCP Server Exec - Path Resolution', () => {
  beforeEach(() => {
    mockExistsSync = jest.fn().mockReturnValue(false);
  });

  describe('findQualityGatesRunner', () => {
    test('returns path when found in monorepo sibling', () => {
      const expectedPath = path.join(srcDir, '..', '..', 'quality-gates', 'run-quality-gates.mjs');
      mockExistsSync.mockImplementation((p) => p === expectedPath);
      expect(findQualityGatesRunner()).toBe(expectedPath);
    });

    test('returns null when not found', () => {
      expect(findQualityGatesRunner()).toBe(null);
    });
  });

  describe('findExceptionFramework', () => {
    test('returns path when found in monorepo sibling', () => {
      const expectedPath = path.join(srcDir, '..', '..', 'quality-gates', 'shared-exception-framework.mjs');
      mockExistsSync.mockImplementation((p) => p === expectedPath);
      expect(findExceptionFramework()).toBe(expectedPath);
    });

    test('returns null when not found', () => {
      expect(findExceptionFramework()).toBe(null);
    });
  });

  describe('findRefactorProgressChecker', () => {
    test('returns path when found in monorepo sibling', () => {
      const expectedPath = path.join(srcDir, '..', '..', 'quality-gates', 'monitor-refactoring-progress.mjs');
      mockExistsSync.mockImplementation((p) => p === expectedPath);
      expect(findRefactorProgressChecker()).toBe(expectedPath);
    });

    test('returns null when not found', () => {
      expect(findRefactorProgressChecker()).toBe(null);
    });
  });
});
