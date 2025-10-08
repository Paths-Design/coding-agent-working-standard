#!/usr/bin/env node

/**
 * @fileoverview CAWS Tool Loader - Dynamic tool discovery and loading system
 * Provides secure, sandboxed loading of tools from apps/tools/caws/ directory
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { setTimeout, clearTimeout } = require('timers');
const { safeAsync } = require('./error-handler');

/**
 * Tool Loader - Discovers, validates, and loads CAWS tools dynamically
 * @extends EventEmitter
 */
class ToolLoader extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      toolsDir: options.toolsDir || path.join(process.cwd(), 'apps/tools/caws'),
      cacheEnabled: options.cacheEnabled !== false,
      timeout: options.timeout || 10000,
      maxTools: options.maxTools || 50,
      ...options,
    };

    this.loadedTools = new Map();
    this.discoveredTools = new Set();
    this.loadingState = 'idle'; // idle, discovering, loading, ready, error
  }

  /**
   * Discover available tools in the tools directory
   * @returns {Promise<Array<string>>} Array of tool file paths
   */
  async discoverTools() {
    return safeAsync(async () => {
      this.loadingState = 'discovering';
      this.emit('discovery:start');

      // Check if tools directory exists
      if (!fs.existsSync(this.options.toolsDir)) {
        this.emit('discovery:complete', { tools: [], reason: 'directory_not_found' });
        this.loadingState = 'ready';
        return [];
      }

      // Read directory contents
      const files = await fs.promises.readdir(this.options.toolsDir);

      // Filter for valid tool files
      const toolFiles = files
        .filter((file) => {
          // Must be .js file
          if (!file.endsWith('.js')) return false;

          // Must not be hidden or backup file
          if (file.startsWith('.') || file.includes('.backup')) return false;

          // Must not be test file (unless explicitly allowed)
          if (file.includes('.test.') && !this.options.includeTests) return false;

          return true;
        })
        .map((file) => path.join(this.options.toolsDir, file))
        .filter((filePath) => {
          // Validate file exists and is readable
          try {
            const stats = fs.statSync(filePath);
            return stats.isFile() && stats.size > 0 && stats.size < 1024 * 1024; // < 1MB
          } catch (error) {
            this.emit('discovery:warning', { file: filePath, error: error.message });
            return false;
          }
        })
        .slice(0, this.options.maxTools); // Limit number of tools

      this.discoveredTools = new Set(toolFiles);
      this.emit('discovery:complete', { tools: toolFiles, count: toolFiles.length });
      this.loadingState = 'idle';

      return toolFiles;
    }, 'Tool discovery failed');
  }

  /**
   * Load a specific tool module
   * @param {string} toolPath - Path to tool file
   * @returns {Promise<Object>} Loaded tool module
   */
  async loadTool(toolPath) {
    return safeAsync(async () => {
      const toolId = path.basename(toolPath, '.js');

      // Check cache first
      if (this.loadedTools.has(toolId) && this.options.cacheEnabled) {
        return this.loadedTools.get(toolId);
      }

      this.emit('tool:loading', { id: toolId, path: toolPath });

      // Validate tool file before loading
      await this.validateToolFile(toolPath);

      // Load the module with timeout
      const toolModule = await this.loadModuleWithTimeout(toolPath);

      // Validate tool interface
      await this.validateToolInterface(toolModule, toolId);

      // Cache the loaded tool
      const tool = {
        module: toolModule,
        path: toolPath,
        loadedAt: new Date(),
        metadata: toolModule.getMetadata ? toolModule.getMetadata() : {},
      };

      this.loadedTools.set(toolId, tool);
      this.emit('tool:loaded', { id: toolId, metadata: tool.metadata });

      return tool;
    }, `Tool loading failed: ${toolId}`);
  }

  /**
   * Load all discovered tools
   * @returns {Promise<Map<string, Object>>} Map of loaded tools
   */
  async loadAllTools() {
    this.loadingState = 'loading';
    this.emit('loading:start');

    const toolPaths = await this.discoverTools();
    const results = new Map();

    for (const toolPath of toolPaths) {
      try {
        const tool = await this.loadTool(toolPath);
        results.set(path.basename(toolPath, '.js'), tool);
      } catch (error) {
        // Log error but continue loading other tools
        this.emit('loading:warning', { path: toolPath, error: error.message });
      }
    }

    this.loadingState = 'ready';
    this.emit('loading:complete', { loaded: results.size, total: toolPaths.length });

    return results;
  }

  /**
   * Get a loaded tool by ID
   * @param {string} toolId - Tool identifier
   * @returns {Object|null} Tool object or null if not found
   */
  getTool(toolId) {
    return this.loadedTools.get(toolId) || null;
  }

  /**
   * Get all loaded tools
   * @returns {Map<string, Object>} Map of loaded tools
   */
  getAllTools() {
    return new Map(this.loadedTools);
  }

  /**
   * Unload a tool (remove from cache)
   * @param {string} toolId - Tool identifier
   * @returns {boolean} True if tool was unloaded
   */
  unloadTool(toolId) {
    const unloaded = this.loadedTools.delete(toolId);
    if (unloaded) {
      this.emit('tool:unloaded', { id: toolId });
    }
    return unloaded;
  }

  /**
   * Validate tool file before loading
   * @private
   * @param {string} toolPath - Path to tool file
   */
  async validateToolFile(toolPath) {
    // Basic file validation
    const stats = await fs.promises.stat(toolPath);
    if (stats.size === 0) {
      throw new Error('Tool file is empty');
    }

    if (stats.size > 1024 * 1024) {
      // 1MB limit
      throw new Error('Tool file too large (>1MB)');
    }

    // Read first few lines to check for shebang and basic structure
    const fd = await fs.promises.open(toolPath, 'r');
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await fd.read(buffer, 0, 512, 0);
      const content = buffer.toString('utf8', 0, bytesRead);

      // Check for shebang
      if (!content.startsWith('#!/usr/bin/env node') && !content.startsWith('#!')) {
        throw new Error('Tool file missing shebang');
      }

      // Basic syntax check - look for module.exports or ES modules
      const hasExports = content.includes('module.exports') || content.includes('export ');
      if (!hasExports) {
        throw new Error('Tool file does not export anything');
      }
    } finally {
      await fd.close();
    }
  }

  /**
   * Load module with timeout protection
   * @private
   * @param {string} toolPath - Path to tool file
   */
  async loadModuleWithTimeout(toolPath) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Tool loading timeout after ${this.options.timeout}ms`));
      }, this.options.timeout);

      try {
        // Clear require cache to ensure fresh load
        delete require.cache[require.resolve(toolPath)];

        const module = require(toolPath);
        clearTimeout(timeout);
        resolve(module);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Validate tool interface compliance
   * @private
   * @param {Object} toolModule - Loaded tool module
   * @param {string} toolId - Tool identifier
   */
  async validateToolInterface(toolModule, toolId) {
    const requiredMethods = ['execute', 'getMetadata'];

    for (const method of requiredMethods) {
      if (typeof toolModule[method] !== 'function') {
        throw new Error(`Tool ${toolId} missing required method: ${method}`);
      }
    }

    // Validate metadata structure
    if (toolModule.getMetadata) {
      const metadata = toolModule.getMetadata();
      const requiredFields = ['id', 'name', 'version'];

      for (const field of requiredFields) {
        if (!metadata[field]) {
          throw new Error(`Tool ${toolId} metadata missing required field: ${field}`);
        }
      }

      // Validate metadata types
      if (typeof metadata.id !== 'string' || typeof metadata.name !== 'string') {
        throw new Error(`Tool ${toolId} metadata has invalid types`);
      }
    }
  }

  /**
   * Get loader statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      discovered: this.discoveredTools.size,
      loaded: this.loadedTools.size,
      state: this.loadingState,
      cacheEnabled: this.options.cacheEnabled,
      toolsDir: this.options.toolsDir,
    };
  }
}

module.exports = ToolLoader;
