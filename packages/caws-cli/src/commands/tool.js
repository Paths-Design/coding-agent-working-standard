/**
 * @fileoverview Tool Command Handler
 * Handles tool execution commands for CAWS CLI
 * @author @darianrosebrook
 */

const path = require('path');
const chalk = require('chalk');

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
    toolLoader = new ToolLoader({
      toolsDir: path.join(process.cwd(), 'apps/tools/caws'),
    });

    toolValidator = new ToolValidator();

    // Set up event listeners for tool system
    toolLoader.on('discovery:complete', ({ tools: _tools, count }) => {
      if (count > 0) {
        console.log(chalk.blue(`🔧 Discovered ${count} tools`));
      }
    });

    toolLoader.on('tool:loaded', ({ id, metadata }) => {
      console.log(chalk.gray(`  ✓ Loaded tool: ${metadata.name} (${id})`));
    });

    toolLoader.on('tool:error', ({ id, error }) => {
      console.warn(chalk.yellow(`⚠️  Failed to load tool ${id}: ${error}`));
    });

    // Auto-discover tools on initialization
    await toolLoader.discoverTools();

    return toolLoader;
  } catch (error) {
    console.warn(chalk.yellow('⚠️  Tool system initialization failed:'), error.message);
    console.warn(chalk.blue('💡 Continuing without dynamic tools'));
    return null;
  }
}

/**
 * Execute tool command handler
 * @param {string} toolId - ID of the tool to execute
 * @param {Object} options - Command options
 */
async function executeTool(toolId, options) {
  try {
    // Initialize tool system
    const loader = await initializeToolSystem();

    if (!loader) {
      console.error(chalk.red('❌ Tool system not available'));
      process.exit(1);
    }

    // Load all tools first
    await loader.loadAllTools();
    const tool = loader.getTool(toolId);

    if (!tool) {
      console.error(chalk.red(`❌ Tool '${toolId}' not found`));
      console.log(chalk.blue('💡 Available tools:'));
      const tools = loader.getAllTools();
      for (const [id, t] of tools) {
        console.log(`   - ${id}: ${t.metadata.name}`);
      }
      process.exit(1);
    }

    // Validate tool before execution
    const validation = await toolValidator.validateTool(tool);
    if (!validation.valid) {
      console.error(chalk.red('❌ Tool validation failed:'));
      validation.errors.forEach((error) => {
        console.error(`   ${chalk.red('✗')} ${error}`);
      });
      process.exit(1);
    }

    // Parse parameters
    let params = {};
    if (options.params) {
      try {
        params = JSON.parse(options.params);
      } catch (error) {
        console.error(chalk.red('❌ Invalid JSON parameters:'), error.message);
        process.exit(1);
      }
    }

    console.log(chalk.blue(`🚀 Executing tool: ${tool.metadata.name}`));

    // Execute tool
    const result = await tool.module.execute(params, {
      workingDirectory: process.cwd(),
      timeout: options.timeout,
    });

    // Display results
    if (result.success) {
      console.log(chalk.green('✅ Tool execution successful'));
      if (result.output && typeof result.output === 'object') {
        console.log(chalk.gray('Output:'), JSON.stringify(result.output, null, 2));
      }
    } else {
      console.error(chalk.red('❌ Tool execution failed'));
      result.errors.forEach((error) => {
        console.error(`   ${chalk.red('✗')} ${error}`);
      });
      process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`❌ Error executing tool ${toolId}:`), error.message);
    process.exit(1);
  }
}

module.exports = {
  initializeToolSystem,
  executeTool,
};
