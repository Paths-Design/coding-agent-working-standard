/**
 * @fileoverview Spec File Manager - WorkingSpec ↔ YAML conversion and file management
 * Handles conversion between JavaScript WorkingSpec objects and YAML files,
 * manages .caws/working-spec.yaml lifecycle, and provides temporary file utilities.
 * Ported from agent-agency v2 CAWS integration patterns.
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');

/**
 * Spec File Manager - Handles WorkingSpec file operations and YAML conversion
 *
 * Features:
 * - Bidirectional WorkingSpec ↔ YAML conversion
 * - Temporary file support for validation workflows
 * - Backup/restore capabilities
 * - Automatic cleanup of old temporary files
 */
class SpecFileManager {
  constructor(config = {}) {
    this.projectRoot = config.projectRoot || process.cwd();
    this.useTemporaryFiles = config.useTemporaryFiles ?? false;
    this.tempDir = config.tempDir || os.tmpdir();
  }

  /**
   * Convert WorkingSpec object to YAML string
   *
   * @param {Object} spec - WorkingSpec to convert
   * @returns {string} YAML string representation
   */
  specToYaml(spec) {
    return yaml.dump(spec, {
      indent: 2,
      lineWidth: 100,
      noRefs: true,
      sortKeys: false,
    });
  }

  /**
   * Parse YAML string to WorkingSpec object
   *
   * @param {string} yamlContent - YAML string to parse
   * @returns {Object} Parsed WorkingSpec object
   * @throws {Error} If YAML is invalid or doesn't match WorkingSpec schema
   */
  yamlToSpec(yamlContent) {
    try {
      const parsed = yaml.load(yamlContent);

      // Basic validation
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid YAML: not an object');
      }

      if (!parsed.id || !parsed.title || !parsed.risk_tier) {
        throw new Error('Invalid WorkingSpec: missing required fields (id, title, risk_tier)');
      }

      return parsed;
    } catch (error) {
      throw new Error(`Failed to parse YAML: ${error.message}`);
    }
  }

  /**
   * Get path to .caws/working-spec.yaml in project
   *
   * @returns {string} Absolute path to working spec file
   */
  getSpecFilePath() {
    return path.join(this.projectRoot, '.caws', 'working-spec.yaml');
  }

  /**
   * Check if working spec file exists
   *
   * @returns {Promise<boolean>} True if file exists
   */
  async specFileExists() {
    try {
      await fs.access(this.getSpecFilePath());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read working spec from .caws/working-spec.yaml
   *
   * @returns {Promise<Object>} Parsed WorkingSpec object
   * @throws {Error} If file doesn't exist or is invalid
   */
  async readSpecFile() {
    const specPath = this.getSpecFilePath();

    try {
      const content = await fs.readFile(specPath, 'utf-8');
      return this.yamlToSpec(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Working spec not found: ${specPath}\nRun 'caws init' to create it`);
      }
      throw error;
    }
  }

  /**
   * Write WorkingSpec to file
   *
   * Writes to .caws/working-spec.yaml or a temporary file based on configuration.
   *
   * @param {Object} spec - WorkingSpec to write
   * @param {Object} options - Write options
   * @param {boolean} options.useTemp - Override temp file usage
   * @param {boolean} options.backup - Create backup before writing
   * @returns {Promise<Object>} Write result with file path and cleanup function
   */
  async writeSpecFile(spec, options = {}) {
    const yamlContent = this.specToYaml(spec);
    const useTemp = options.useTemp ?? this.useTemporaryFiles;

    if (useTemp) {
      // Write to temporary file
      const tempPath = path.join(this.tempDir, `caws-spec-${spec.id || 'temp'}-${Date.now()}.yaml`);

      await fs.writeFile(tempPath, yamlContent, 'utf-8');

      return {
        filePath: tempPath,
        isTemporary: true,
        cleanup: async () => {
          try {
            await fs.unlink(tempPath);
          } catch {
            // Ignore cleanup errors (file may already be deleted)
          }
        },
      };
    } else {
      // Write to project .caws directory
      const specPath = this.getSpecFilePath();
      const cawsDir = path.dirname(specPath);

      // Create backup if requested
      if (options.backup && (await this.specFileExists())) {
        await this.backupSpecFile();
      }

      // Ensure .caws directory exists
      await fs.mkdir(cawsDir, { recursive: true });

      await fs.writeFile(specPath, yamlContent, 'utf-8');

      return {
        filePath: specPath,
        isTemporary: false,
      };
    }
  }

  /**
   * Update existing working spec file
   *
   * Reads current spec, merges changes, and writes back.
   *
   * @param {Object} updates - Partial WorkingSpec with fields to update
   * @returns {Promise<Object>} Updated WorkingSpec
   */
  async updateSpecFile(updates) {
    const currentSpec = await this.readSpecFile();
    const updatedSpec = {
      ...currentSpec,
      ...updates,
    };

    // Always write to permanent location for updates
    await this.writeSpecFile(updatedSpec, { useTemp: false });

    return updatedSpec;
  }

  /**
   * Create backup of working spec
   *
   * @returns {Promise<string>} Path to backup file
   */
  async backupSpecFile() {
    const specPath = this.getSpecFilePath();
    const backupPath = `${specPath}.backup-${Date.now()}`;

    await fs.copyFile(specPath, backupPath);

    return backupPath;
  }

  /**
   * Restore working spec from backup
   *
   * @param {string} backupPath - Path to backup file
   * @returns {Promise<void>}
   */
  async restoreSpecFile(backupPath) {
    const specPath = this.getSpecFilePath();
    await fs.copyFile(backupPath, specPath);
  }

  /**
   * List all backup files
   *
   * @returns {Promise<string[]>} Array of backup file paths
   */
  async listBackups() {
    const specPath = this.getSpecFilePath();
    const cawsDir = path.dirname(specPath);
    const specName = path.basename(specPath);

    try {
      const files = await fs.readdir(cawsDir);
      const backups = files
        .filter((f) => f.startsWith(`${specName}.backup-`))
        .map((f) => path.join(cawsDir, f));

      // Sort by timestamp (newest first)
      backups.sort().reverse();

      return backups;
    } catch {
      return [];
    }
  }

  /**
   * Delete old backup files
   *
   * @param {Object} options - Cleanup options
   * @param {number} options.maxAge - Maximum age in milliseconds (default: 7 days)
   * @param {number} options.keep - Minimum number of backups to keep (default: 5)
   * @returns {Promise<number>} Number of backups deleted
   */
  async cleanupBackups(options = {}) {
    const maxAge = options.maxAge ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    const keepCount = options.keep ?? 5;

    const backups = await this.listBackups();
    const now = Date.now();
    let deleted = 0;

    // Delete old backups beyond the keep count
    for (let i = 0; i < backups.length; i++) {
      const backupPath = backups[i];

      try {
        const stats = await fs.stat(backupPath);
        const age = now - stats.mtimeMs;

        // Keep the most recent N backups, or delete if too old
        const shouldDelete = i >= keepCount && age > maxAge;

        if (shouldDelete) {
          await fs.unlink(backupPath);
          deleted++;
        }
      } catch {
        // Skip files that can't be accessed
      }
    }

    return deleted;
  }

  /**
   * Validate spec file exists and is parseable
   *
   * @returns {Promise<Object>} Validation result
   */
  async validateSpecFile() {
    try {
      const spec = await this.readSpecFile();
      return {
        valid: true,
        spec,
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
      };
    }
  }

  /**
   * Clean up old temporary spec files
   *
   * Removes temp files older than specified age.
   *
   * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
   * @returns {Promise<number>} Number of files cleaned up
   */
  async cleanupTempFiles(maxAge = 3600000) {
    try {
      const files = await fs.readdir(this.tempDir);
      const specFiles = files.filter((f) => f.startsWith('caws-spec-'));

      let cleaned = 0;
      const now = Date.now();

      for (const file of specFiles) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = await fs.stat(filePath);
          const age = now - stats.mtimeMs;

          if (age > maxAge) {
            await fs.unlink(filePath);
            cleaned++;
          }
        } catch {
          // Skip files that can't be accessed
        }
      }

      return cleaned;
    } catch {
      return 0;
    }
  }

  /**
   * Get spec file stats (size, modified date, etc.)
   *
   * @returns {Promise<Object>} File stats
   */
  async getSpecFileStats() {
    const specPath = this.getSpecFilePath();

    try {
      const stats = await fs.stat(specPath);
      const content = await fs.readFile(specPath, 'utf-8');
      const lines = content.split('\n').length;

      return {
        exists: true,
        size: stats.size,
        sizeKB: Math.round((stats.size / 1024) * 10) / 10,
        lines,
        modified: stats.mtime,
        created: stats.birthtime,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          exists: false,
        };
      }
      throw error;
    }
  }

  /**
   * Create a new SpecFileManager instance with different configuration
   *
   * @param {Object} config - New configuration
   * @returns {SpecFileManager} New instance
   */
  withConfig(config) {
    return new SpecFileManager({
      projectRoot: this.projectRoot,
      useTemporaryFiles: this.useTemporaryFiles,
      tempDir: this.tempDir,
      ...config,
    });
  }
}

/**
 * Create a SpecFileManager instance with default configuration
 *
 * @param {string} projectRoot - Project root directory
 * @param {Object} options - Additional options
 * @returns {SpecFileManager} SpecFileManager instance
 */
function createSpecFileManager(projectRoot, options = {}) {
  return new SpecFileManager({
    projectRoot,
    ...options,
  });
}

// Export singleton instance for convenience
const defaultSpecFileManager = new SpecFileManager();

module.exports = {
  SpecFileManager,
  defaultSpecFileManager,
  createSpecFileManager,

  // Convenience exports for backward compatibility
  specToYaml: (spec) => defaultSpecFileManager.specToYaml(spec),
  yamlToSpec: (yaml) => defaultSpecFileManager.yamlToSpec(yaml),
  readSpecFile: (projectRoot) => {
    if (projectRoot) {
      return createSpecFileManager(projectRoot).readSpecFile();
    }
    return defaultSpecFileManager.readSpecFile();
  },
  writeSpecFile: (spec, projectRoot, options) => {
    if (projectRoot) {
      return createSpecFileManager(projectRoot).writeSpecFile(spec, options);
    }
    return defaultSpecFileManager.writeSpecFile(spec, options);
  },
};
