# MCP Server Design Patterns for CAWS Integration

**Author**: @darianrosebrook  
**Date**: October 12, 2025  
**Status**: Recommended Patterns  
**Source**: Extracted from agent-agency v2 CAWS integration

---

## Overview

This guide documents proven patterns for building MCP (Model Context Protocol) servers that integrate with CAWS. These patterns have been validated in production use by agent-agency v2 and demonstrate best practices for agent orchestration, quality enforcement, and real-time monitoring.

---

## Pattern 1: Shared Base Tool Class

### Problem

MCP servers often have dozens of tools with repetitive logic:

- File I/O with error handling
- Consistent logging
- Result object formatting
- Permission validation

### Solution

Create a base tool class with common utilities:

```javascript
/**
 * Base class for CAWS MCP tools
 * Provides standardized functionality for all tools
 */
class CAWSBaseTool {
  constructor(config = {}) {
    this.projectRoot = config.projectRoot || process.cwd();
    this.logger = config.logger || console;
  }

  /**
   * Read JSON file with error handling
   */
  async readJSON(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      this.logError(`Failed to read JSON: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Read YAML file with error handling
   */
  async readYAML(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return yaml.load(content);
    } catch (error) {
      this.logError(`Failed to read YAML: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Write JSON file with backup
   */
  async writeJSON(filePath, data, options = {}) {
    try {
      if (options.backup && (await this.fileExists(filePath))) {
        await fs.copyFile(filePath, `${filePath}.backup-${Date.now()}`);
      }

      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logError(`Failed to write JSON: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Structured logging with levels
   */
  logInfo(message, metadata = {}) {
    this.logger.info(`ℹ️  ${message}`, metadata);
  }

  logWarning(message, metadata = {}) {
    this.logger.warn(`⚠️  ${message}`, metadata);
  }

  logError(message, error, metadata = {}) {
    this.logger.error(`❌ ${message}`, { error: error.message, ...metadata });
  }

  logSuccess(message, metadata = {}) {
    this.logger.info(`✅ ${message}`, metadata);
  }

  /**
   * Create standardized MCP response
   */
  createResponse(success, data = {}, errors = []) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success,
              data,
              errors,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
      isError: !success,
    };
  }

  /**
   * Validate required parameters
   */
  validateParams(params, required = []) {
    const missing = required.filter((key) => !(key in params));

    if (missing.length > 0) {
      throw new Error(`Missing required parameters: ${missing.join(', ')}`);
    }
  }

  /**
   * Check if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { CAWSBaseTool };
```

### Usage

```javascript
class CAWSValidateTool extends CAWSBaseTool {
  async execute(params) {
    this.validateParams(params, ['specFile']);

    try {
      const spec = await this.readYAML(params.specFile);
      const result = await this.validate(spec);

      this.logSuccess(`Validation complete: ${spec.id}`);
      return this.createResponse(true, result);
    } catch (error) {
      this.logError('Validation failed', error);
      return this.createResponse(false, {}, [error.message]);
    }
  }
}
```

---

## Pattern 2: Centralized Type Definitions

### Problem

Without shared types, different tools use inconsistent data structures, making integration difficult.

### Solution

Create a central types module:

```javascript
/**
 * @typedef {Object} CAWSValidationResult
 * @property {boolean} passed - Whether validation passed
 * @property {string} cawsVersion - CAWS version used
 * @property {string} timestamp - ISO timestamp
 * @property {BudgetCompliance} budgetCompliance - Budget check results
 * @property {QualityGateResult[]} qualityGates - Quality gate results
 * @property {string} verdict - Final verdict (pass/fail/waiver-required)
 */

/**
 * @typedef {Object} BudgetCompliance
 * @property {boolean} compliant - Whether budget is complied with
 * @property {Budget} baseline - Baseline budget from policy
 * @property {Budget} effective - Effective budget with waivers
 * @property {ChangeStats} current - Current change statistics
 * @property {BudgetViolation[]} violations - Budget violations
 */

/**
 * @typedef {Object} Budget
 * @property {number} max_files - Maximum files allowed
 * @property {number} max_loc - Maximum lines of code allowed
 */

/**
 * @typedef {Object} ChangeStats
 * @property {number} filesChanged - Files changed count
 * @property {number} linesChanged - Lines changed count
 */

/**
 * @typedef {Object} QualityGateResult
 * @property {string} gate - Gate name
 * @property {boolean} passed - Whether gate passed
 * @property {number} [score] - Numeric score
 * @property {number} [threshold] - Required threshold
 * @property {string} message - Result message
 * @property {*} [evidence] - Supporting evidence
 */

/**
 * @typedef {Object} WorkingSpec
 * @property {string} id - Spec ID (e.g., FEAT-001)
 * @property {string} title - Spec title
 * @property {number} risk_tier - Risk tier (1, 2, or 3)
 * @property {string} mode - Mode (feature, refactor, fix, doc, chore)
 * @property {string[]} [waiver_ids] - Active waiver IDs
 * @property {Object} scope - Scope definition
 * @property {string[]} scope.in - Files/dirs in scope
 * @property {string[]} scope.out - Files/dirs out of scope
 * @property {AcceptanceCriterion[]} acceptance - Acceptance criteria
 */

module.exports = {
  // Export types for documentation purposes
};
```

---

## Pattern 3: Schema-Based Validation

### Problem

Invalid tool inputs cause runtime errors that are hard to debug.

### Solution

Use JSON Schema for all tool inputs:

```javascript
const Ajv = require('ajv');
const ajv = new Ajv();

// Define schema for validation tool
const validateToolSchema = {
  type: 'object',
  required: ['specFile'],
  properties: {
    specFile: {
      type: 'string',
      description: 'Path to working spec file',
    },
    autoFix: {
      type: 'boolean',
      description: 'Apply automatic fixes',
      default: false,
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress output',
      default: false,
    },
  },
  additionalProperties: false,
};

class CAWSValidateTool extends CAWSBaseTool {
  constructor(config) {
    super(config);
    this.validate = ajv.compile(validateToolSchema);
  }

  async execute(params) {
    // Validate input schema
    if (!this.validate(params)) {
      const errors = this.validate.errors.map((e) => `${e.instancePath} ${e.message}`);
      return this.createResponse(false, {}, errors);
    }

    // Proceed with validation
    // ...
  }
}
```

### Schema Files

Store schemas in `schemas/` directory:

```
schemas/
├── validate-tool.schema.json
├── evaluate-tool.schema.json
├── working-spec.schema.json
└── waiver.schema.json
```

---

## Pattern 4: Tool Allowlists for Security

### Problem

Agents can abuse MCP tools to access sensitive data or execute dangerous commands.

### Solution

Implement permission-based allowlists:

```javascript
/**
 * Tool allowlist configuration
 * Maps agent types to permitted tools
 */
const toolAllowlists = {
  'code-generation-agent': [
    'read-file',
    'write-file',
    'run-terminal-cmd',
    'grep',
    'list-dir',
    'search-replace',
    'caws_validate',
    'caws_evaluate',
  ],
  'analysis-agent': ['read-file', 'grep', 'list-dir', 'glob-file-search', 'caws_validate'],
  'testing-agent': ['run-terminal-cmd', 'read-file', 'list-dir', 'caws_evaluate'],
  'orchestrator-agent': [
    // Orchestrators have broad permissions
    '*',
  ],
};

/**
 * Check if agent has permission to use a tool
 */
function hasPermission(agentType, toolName) {
  const allowed = toolAllowlists[agentType] || [];

  // Check for wildcard permission
  if (allowed.includes('*')) {
    return true;
  }

  // Check for specific permission
  return allowed.includes(toolName);
}

/**
 * MCP tool wrapper with permission check
 */
class PermissionedTool extends CAWSBaseTool {
  async execute(params, context = {}) {
    const { agentType, toolName } = context;

    if (!hasPermission(agentType, toolName)) {
      this.logWarning(`Permission denied: ${agentType} → ${toolName}`);
      return this.createResponse(false, {}, [
        `Agent type '${agentType}' not permitted to use tool '${toolName}'`,
      ]);
    }

    // Execute tool
    return this.executeInternal(params);
  }

  async executeInternal(params) {
    // Implement tool logic
  }
}
```

---

## Pattern 5: Real-Time Monitoring with Events

### Problem

Agents need proactive alerts during work, not just post-hoc validation failures.

### Solution

Use EventEmitter for real-time notifications:

```javascript
const EventEmitter = require('events');

class BudgetMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spec = null;
    this.alertThresholds = options.alertThresholds || [80, 95];
    this.pollInterval = options.pollInterval || 30000; // 30s
    this.isRunning = false;
  }

  /**
   * Start monitoring for a working spec
   */
  async start(spec) {
    this.spec = spec;
    this.isRunning = true;

    this.logInfo(`Budget monitor started for ${spec.id}`);

    // Start periodic checks
    this.interval = setInterval(() => {
      this.checkBudget();
    }, this.pollInterval);

    // Initial check
    await this.checkBudget();
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
    }
    this.logInfo('Budget monitor stopped');
  }

  /**
   * Check current budget status
   */
  async checkBudget() {
    if (!this.spec || !this.isRunning) return;

    const stats = await this.getCurrentChangeStats();
    const budget = await this.deriveBudget(this.spec);

    const filesUsage = (stats.filesChanged / budget.effective.max_files) * 100;
    const locUsage = (stats.linesChanged / budget.effective.max_loc) * 100;
    const maxUsage = Math.max(filesUsage, locUsage);

    // Emit alerts at thresholds
    for (const threshold of this.alertThresholds) {
      if (maxUsage >= threshold && !this.alerted[threshold]) {
        const severity = threshold >= 95 ? 'critical' : 'warning';

        this.emit('budget:alert', {
          severity,
          usage: Math.round(maxUsage),
          threshold,
          budget,
          stats,
          timestamp: new Date().toISOString(),
        });

        this.alerted[threshold] = true;
      }
    }
  }
}

// Usage in MCP server
const monitor = new BudgetMonitor();

monitor.on('budget:warning', (alert) => {
  console.log(`⚠️  Budget at ${alert.usage}% (threshold: ${alert.threshold}%)`);
  // Notify agents via MCP
});

monitor.on('budget:critical', (alert) => {
  console.log(`🚫 Budget critical: ${alert.usage}%`);
  // Block further changes or request human approval
});

await monitor.start(workingSpec);
```

---

## Pattern 6: Graceful Error Handling

### Problem

MCP tools crash on unexpected errors, leaving agents confused.

### Solution

Always return structured responses, never throw:

```javascript
class CAWSBaseTool {
  /**
   * Safe tool execution wrapper
   */
  async safeExecute(params) {
    try {
      // Validate parameters
      this.validateParams(params, this.requiredParams);

      // Execute tool logic
      const result = await this.execute(params);

      return this.createResponse(true, result);
    } catch (error) {
      // Log error for debugging
      this.logError('Tool execution failed', error, { params });

      // Return structured error response
      return this.createResponse(false, {}, [error.message, ...(error.suggestions || [])]);
    }
  }

  /**
   * Create error response with suggestions
   */
  createErrorWithSuggestions(message, suggestions = []) {
    return this.createResponse(false, {}, [
      message,
      '',
      'Suggestions:',
      ...suggestions.map((s) => `  - ${s}`),
    ]);
  }
}

// Example usage
class CAWSValidateTool extends CAWSBaseTool {
  async execute(params) {
    const specPath = params.specFile;

    if (!(await this.fileExists(specPath))) {
      return this.createErrorWithSuggestions(`Working spec not found: ${specPath}`, [
        'Run "caws init" to create a working spec',
        'Check that you are in the correct directory',
        `Ensure the path is correct: ${specPath}`,
      ]);
    }

    // Continue with validation
    // ...
  }
}
```

---

## Pattern 7: Provenance Tracking

### Problem

Need to track which agent performed which actions for audit and debugging.

### Solution

Enrich all results with provenance metadata:

```javascript
class ProvenanceTracker {
  constructor() {
    this.entries = [];
  }

  /**
   * Record a tool execution
   */
  async record(entry) {
    const provenanceEntry = {
      id: `prov-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      toolName: entry.toolName,
      agentId: entry.agentId,
      agentType: entry.agentType,
      params: this.sanitizeParams(entry.params),
      result: {
        success: entry.result.success,
        duration: entry.duration,
      },
      cawsVersion: '3.4.0',
    };

    this.entries.push(provenanceEntry);

    // Write to provenance file
    await this.writeProvenance();

    return provenanceEntry.id;
  }

  /**
   * Sanitize parameters (remove sensitive data)
   */
  sanitizeParams(params) {
    const sanitized = { ...params };

    // Remove sensitive fields
    delete sanitized.apiKey;
    delete sanitized.password;
    delete sanitized.token;

    return sanitized;
  }

  /**
   * Write provenance to file
   */
  async writeProvenance() {
    const provenancePath = path.join(process.cwd(), '.caws', 'provenance.json');

    await fs.mkdir(path.dirname(provenancePath), { recursive: true });
    await fs.writeFile(provenancePath, JSON.stringify({ entries: this.entries }, null, 2));
  }

  /**
   * Get provenance for an agent
   */
  getAgentProvenance(agentId) {
    return this.entries.filter((e) => e.agentId === agentId);
  }
}

// Usage in MCP server
const provenance = new ProvenanceTracker();

class CAWSMCPServer extends Server {
  async handleToolCall(request) {
    const { name, arguments: params } = request.params;
    const context = this.extractContext(request);

    const startTime = Date.now();
    const result = await this.executeTool(name, params, context);
    const duration = Date.now() - startTime;

    // Record in provenance
    await provenance.record({
      toolName: name,
      agentId: context.agentId,
      agentType: context.agentType,
      params,
      result,
      duration,
    });

    return result;
  }
}
```

---

## Complete Example: CAWS MCP Server

Putting it all together:

```javascript
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CAWSBaseTool } = require('./base-tool.js');
const { BudgetMonitor } = require('./budget-monitor.js');
const { ProvenanceTracker } = require('./provenance-tracker.js');

class CAWSMCPServer extends Server {
  constructor() {
    super(
      {
        name: 'caws-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.monitor = new BudgetMonitor();
    this.provenance = new ProvenanceTracker();

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.setRequestHandler(ListToolsRequestSchema, () => {
      return { tools: CAWS_TOOLS };
    });

    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.handleToolCall(request);
    });
  }

  async handleToolCall(request) {
    const { name, arguments: params } = request.params;
    const context = this.extractContext(request);

    // Check permissions
    if (!hasPermission(context.agentType, name)) {
      return this.createPermissionError(context.agentType, name);
    }

    // Execute tool
    const startTime = Date.now();
    const tool = this.getTool(name);
    const result = await tool.safeExecute(params);
    const duration = Date.now() - startTime;

    // Record provenance
    await this.provenance.record({
      toolName: name,
      agentId: context.agentId,
      agentType: context.agentType,
      params,
      result,
      duration,
    });

    return result;
  }
}

// Start server
async function main() {
  const server = new CAWSMCPServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('CAWS MCP Server started');
}

main().catch(console.error);
```

---

## Best Practices Summary

1. **Use Base Classes** - Reduce duplication with shared utilities
2. **Define Types** - Create centralized type definitions
3. **Validate Inputs** - Use JSON Schema for all tool parameters
4. **Control Permissions** - Implement tool allowlists per agent type
5. **Monitor Proactively** - Emit real-time alerts, don't just validate post-hoc
6. **Handle Errors Gracefully** - Always return structured responses
7. **Track Provenance** - Record all tool executions for audit
8. **Document Thoroughly** - Provide clear error messages and suggestions

---

## Additional Resources

- [CAWS MCP Server Implementation](../../packages/caws-mcp-server/)
- [Agent-Agency V2 Integration](https://github.com/darianrosebrook/agent-agency)
- [MCP Protocol Documentation](https://modelcontextprotocol.io)

---

**Last Updated**: October 12, 2025  
**Maintainer**: @darianrosebrook
