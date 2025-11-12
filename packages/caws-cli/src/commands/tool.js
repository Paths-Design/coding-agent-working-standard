/**
 * @fileoverview Tool Command Handler
 * Handles tool execution commands for CAWS CLI
 * @author @darianrosebrook
 */

const { commandWrapper, Output } = require('../utils/command-wrapper');

// Import tool system
const ToolLoader = require('../tool-loader');
const ToolValidator = require('../tool-validator');

// Tool system state
let toolLoader = null;
let toolValidator = null;

/**
 * Initialize tool system
 * @returns {Promise<ToolLoader|null>} Initialized tool loader or null if failed
 */
async function initializeToolSystem() {
  if (toolLoader) return toolLoader;

  try {
    // ToolLoader now checks .caws/tools first, then falls back to legacy location
    toolLoader = new ToolLoader();

    toolValidator = new ToolValidator();

    // Set up event listeners for tool system
    toolLoader.on('discovery:complete', ({ tools: _tools, count }) => {
      if (count > 0) {
        Output.info(`Discovered ${count} tools`);
      }
    });

    toolLoader.on('tool:loaded', ({ id, metadata }) => {
      // Only log in verbose mode or when not using JSON output
      if (!process.env.CAWS_OUTPUT_FORMAT || process.env.CAWS_OUTPUT_FORMAT !== 'json') {
        console.log(`  ✓ Loaded tool: ${metadata.name} (${id})`);
      }
    });

    toolLoader.on('tool:error', ({ id, error }) => {
      Output.warning(`Failed to load tool ${id}: ${error}`);
    });

    // Auto-discover tools on initialization
    await toolLoader.discoverTools();

    return toolLoader;
  } catch (error) {
    Output.warning(
      `Tool system initialization failed: ${error.message}`,
      'Continuing without dynamic tools'
    );
    return null;
  }
}

/**
 * Execute tool command handler
 * @param {string} toolId - ID of the tool to execute
 * @param {Object} options - Command options
 */
async function executeTool(toolId, options) {
  return commandWrapper(
    async () => {
      // Initialize tool system
      const loader = await initializeToolSystem();

      if (!loader) {
        throw new Error('Tool system not available');
      }

      // Load all tools first
      await loader.loadAllTools();
      const tool = loader.getTool(toolId);

      if (!tool) {
        const tools = loader.getAllTools();
        const availableTools = Array.from(tools, ([id, t]) => `${id}: ${t.metadata.name}`).join(
          ', '
        );
        throw new Error(`Tool '${toolId}' not found.\n` + `Available tools: ${availableTools}`);
      }

      // Validate tool before execution
      const validation = await toolValidator.validateTool(tool);
      if (!validation.valid) {
        throw new Error(
          `Tool validation failed:\n` + validation.errors.map((e) => `  - ${e}`).join('\n')
        );
      }

      // Parse parameters
      let params = {};
      if (options.params) {
        try {
          params = JSON.parse(options.params);
        } catch (error) {
          throw new Error(`Invalid JSON parameters: ${error.message}`);
        }
      }

      Output.progress(`Executing tool: ${tool.metadata.name}`);

      // Execute tool
      const result = await tool.module.execute(params, {
        workingDirectory: process.cwd(),
        timeout: options.timeout,
      });

      // Display results
      if (result.success) {
        Output.success('Tool execution successful', {
          output: result.output,
        });
        return result;
      } else {
        throw new Error(
          `Tool execution failed:\n` + result.errors.map((e) => `  - ${e}`).join('\n')
        );
      }
    },
    {
      commandName: `tool ${toolId}`,
      context: { toolId, options },
    }
  );
}

module.exports = {
  initializeToolSystem,
  executeTool,
};
