/**
 * @fileoverview Tests for MCP server resource registration
 */

import { jest } from '@jest/globals';

let mockExistsSync;
let mockReadFileSync;

jest.unstable_mockModule('fs', () => ({
  default: {
    existsSync: (...args) => mockExistsSync(...args),
    readFileSync: (...args) => mockReadFileSync(...args),
  },
  existsSync: (...args) => mockExistsSync(...args),
  readFileSync: (...args) => mockReadFileSync(...args),
}));

// Mock child_process to prevent actual git calls
jest.unstable_mockModule('child_process', () => ({
  execSync: jest.fn().mockReturnValue('/mock/project\n'),
}));

const { registerResources } = await import('../src/resources.js');

describe('MCP Server Resources', () => {
  let mockServer;

  beforeEach(() => {
    mockServer = { resource: jest.fn() };
    mockExistsSync = jest.fn().mockReturnValue(false);
    mockReadFileSync = jest.fn().mockReturnValue('');
  });

  test('registers working-spec resource', () => {
    registerResources(mockServer);
    expect(mockServer.resource).toHaveBeenCalledWith(
      'working-spec',
      'caws://working-spec',
      expect.objectContaining({ description: expect.any(String), mimeType: 'application/yaml' }),
      expect.any(Function)
    );
  });

  test('resource handler returns spec content when file exists', async () => {
    registerResources(mockServer);
    const handler = mockServer.resource.mock.calls[0][3];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('risk_tier: T2\nmode: feature');

    const result = await handler();
    expect(result.contents[0].mimeType).toBe('application/yaml');
    expect(result.contents[0].text).toBe('risk_tier: T2\nmode: feature');
  });

  test('resource handler returns not-found message when file missing', async () => {
    registerResources(mockServer);
    const handler = mockServer.resource.mock.calls[0][3];

    mockExistsSync.mockReturnValue(false);

    const result = await handler();
    expect(result.contents[0].mimeType).toBe('text/plain');
    expect(result.contents[0].text).toContain('No working spec found');
  });
});
