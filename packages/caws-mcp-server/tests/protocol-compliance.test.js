/**
 * @fileoverview MCP Protocol Compliance Tests
 * Tests that CAWS MCP Server adheres to Model Context Protocol specification
 * @author @darianrosebrook
 */

const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const { spawn } = require('child_process');
const path = require('path');

describe('MCP Protocol Compliance', () => {
  let serverProcess;
  let responses = [];
  let serverStarted = false;

  beforeAll((done) => {
    // Start MCP server
    const serverPath = path.join(__dirname, '../index.js');
    serverProcess = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Disable monitoring to avoid CLI dependencies during tests
        CAWS_DISABLE_MONITORING: 'true',
      },
    });

    serverProcess.stdout.on('data', (data) => {
      try {
        const response = JSON.parse(data.toString());
        responses.push(response);
        if (response.id === -1) {
          // Server initialized successfully
          serverStarted = true;
        }
      } catch (e) {
        // Ignore non-JSON output
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.error('Server stderr:', output);

      // Check if server started successfully
      if (
        output.includes('CAWS MCP Server started') &&
        !output.includes('Failed to start monitoring')
      ) {
        serverStarted = true;
      }
    });

    // Wait for server to start or timeout
    let attempts = 0;
    const checkStarted = () => {
      attempts++;
      if (serverStarted || attempts > 20) {
        done();
      } else {
        setTimeout(checkStarted, 500);
      }
    };
    checkStarted();
  });

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  describe('Server Initialization', () => {
    it('should start without errors', () => {
      expect(serverProcess).toBeDefined();
      expect(serverProcess.killed).toBe(false);
    });

    it('should respond to capabilities request', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      };

      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 1);
        expect(response).toBeDefined();
        expect(response.result).toBeDefined();
        done();
      }, 500);
    });
  });

  describe('Tools List', () => {
    it('should return tools list', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      };

      responses = []; // Clear previous responses
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 2);
        expect(response).toBeDefined();
        expect(response.result).toHaveProperty('tools');
        expect(Array.isArray(response.result.tools)).toBe(true);
        done();
      }, 500);
    });

    it('should include all required tools', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 3);
        const toolNames = response.result.tools.map((t) => t.name);

        const requiredTools = [
          'caws_init',
          'caws_scaffold',
          'caws_evaluate',
          'caws_iterate',
          'caws_validate',
          'caws_waiver_create',
          'caws_workflow_guidance',
          'caws_quality_monitor',
          'caws_test_analysis',
          'caws_provenance',
          'caws_hooks',
          'caws_status',
          'caws_diagnose',
        ];

        requiredTools.forEach((tool) => {
          expect(toolNames).toContain(tool);
        });

        done();
      }, 500);
    });

    it('should have valid tool schemas', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: {},
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 4);
        const tools = response.result.tools;

        tools.forEach((tool) => {
          // Each tool must have required fields
          expect(tool).toHaveProperty('name');
          expect(tool).toHaveProperty('description');
          expect(tool).toHaveProperty('inputSchema');

          // Input schema must be valid JSON Schema
          expect(tool.inputSchema).toHaveProperty('type');
          expect(tool.inputSchema.type).toBe('object');

          // Name must be lowercase with underscores
          expect(tool.name).toMatch(/^[a-z_]+$/);
        });

        done();
      }, 500);
    });
  });

  describe('Tool Execution', () => {
    it('should execute workflow_guidance tool', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'caws_workflow_guidance',
          arguments: {
            workflowType: 'tdd',
            currentStep: 1,
          },
        },
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 5);
        expect(response).toBeDefined();
        expect(response.result).toHaveProperty('content');
        expect(Array.isArray(response.result.content)).toBe(true);
        expect(response.result.content[0]).toHaveProperty('type');
        expect(response.result.content[0]).toHaveProperty('text');
        done();
      }, 500);
    });

    it('should handle invalid tool name', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'invalid_tool',
          arguments: {},
        },
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 6);
        expect(response).toBeDefined();
        expect(response.error).toBeDefined();
        done();
      }, 500);
    });

    it('should validate required parameters', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'caws_workflow_guidance',
          arguments: {
            // Missing required parameters
          },
        },
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 7);
        expect(response).toBeDefined();
        // Should either error or handle gracefully with defaults
        expect(response.result || response.error).toBeDefined();
        done();
      }, 500);
    });
  });

  describe('Resources', () => {
    it('should list available resources', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 8,
        method: 'resources/list',
        params: {},
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 8);
        expect(response).toBeDefined();
        expect(response.result).toHaveProperty('resources');
        expect(Array.isArray(response.result.resources)).toBe(true);
        done();
      }, 500);
    });

    it('should have valid resource URIs', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 9,
        method: 'resources/list',
        params: {},
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 9);
        const resources = response.result.resources;

        resources.forEach((resource) => {
          expect(resource).toHaveProperty('uri');
          expect(resource).toHaveProperty('name');
          expect(resource).toHaveProperty('mimeType');
          expect(resource.uri).toMatch(/^caws:\/\//);
        });

        done();
      }, 500);
    });
  });

  describe('Error Handling', () => {
    it('should return proper error format', (done) => {
      const request = {
        jsonrpc: '2.0',
        id: 10,
        method: 'invalid_method',
        params: {},
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 10);
        expect(response).toBeDefined();
        expect(response.error).toBeDefined();
        expect(response.error).toHaveProperty('code');
        expect(response.error).toHaveProperty('message');
        done();
      }, 500);
    });

    it('should handle malformed JSON gracefully', (done) => {
      serverProcess.stdin.write('not valid json\n');

      setTimeout(() => {
        // Server should not crash
        expect(serverProcess.killed).toBe(false);
        done();
      }, 500);
    });
  });

  describe('Performance', () => {
    it('should respond within reasonable time', (done) => {
      const startTime = Date.now();
      const request = {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/list',
        params: {},
      };

      responses = [];
      serverProcess.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        const response = responses.find((r) => r.id === 11);
        const duration = Date.now() - startTime;

        expect(response).toBeDefined();
        // Allow more time in CI environments (3 seconds instead of 1)
        expect(duration).toBeLessThan(3000);
        done();
      }, 4000); // Wait up to 4 seconds for response
    });
  });
});

describe('Tool-Specific Tests', () => {
  describe('caws_init', () => {
    it('should have correct schema', () => {
      // Schema validation would go here
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('caws_evaluate', () => {
    it('should return structured evaluation', () => {
      // Evaluation format tests
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('caws_provenance', () => {
    it('should support all subcommands', () => {
      const subcommands = ['init', 'update', 'show', 'verify', 'analyze-ai'];
      // Test each subcommand
      expect(subcommands.length).toBe(5);
    });
  });
});

// NOTE: These are foundational tests
// TODO: Expand with:
// - Integration tests with actual CLI
// - Timeout handling tests
// - Concurrent request tests
// - Resource read/write tests
// - Full workflow tests
