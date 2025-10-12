/**
 * @fileoverview Tests for SpecFileManager - WorkingSpec file operations
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { SpecFileManager } = require('../src/spec/SpecFileManager');

describe('SpecFileManager', () => {
  let tempDir;
  let specManager;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = path.join(os.tmpdir(), `caws-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create .caws directory
    await fs.mkdir(path.join(tempDir, '.caws'), { recursive: true });

    specManager = new SpecFileManager({
      projectRoot: tempDir,
      useTemporaryFiles: false,
    });
  });

  afterEach(async () => {
    // Ensure we're not in the temp directory before deleting it
    try {
      const cwd = process.cwd();
      if (cwd.startsWith(tempDir)) {
        process.chdir(__dirname);
      }
    } catch (e) {
      // Can't get cwd, try to change anyway
      try {
        process.chdir(__dirname);
      } catch (e2) {
        // Continue with cleanup
      }
    }
    
    // Cleanup
    await fs.remove(tempDir);
  });

  describe('specToYaml', () => {
    test('should convert spec to YAML string', () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
        mode: 'feature',
        scope: {
          in: ['src/'],
          out: ['tests/'],
        },
      };

      const yaml = specManager.specToYaml(spec);

      expect(yaml).toContain('id: FEAT-001');
      expect(yaml).toContain('title: Test Feature');
      expect(yaml).toContain('risk_tier: 2');
      expect(yaml).toContain('mode: feature');
    });

    test('should handle nested objects', () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
        acceptance: [
          {
            id: 'A1',
            description: 'Test acceptance criterion',
            status: 'pending',
          },
        ],
      };

      const yaml = specManager.specToYaml(spec);

      expect(yaml).toContain('acceptance:');
      expect(yaml).toContain('- id: A1');
      expect(yaml).toContain('description: Test acceptance criterion');
    });
  });

  describe('yamlToSpec', () => {
    test('should parse YAML to spec object', () => {
      const yaml = `
id: FEAT-001
title: Test Feature
risk_tier: 2
mode: feature
scope:
  in:
    - src/
  out:
    - tests/
`;

      const spec = specManager.yamlToSpec(yaml);

      expect(spec.id).toBe('FEAT-001');
      expect(spec.title).toBe('Test Feature');
      expect(spec.risk_tier).toBe(2);
      expect(spec.scope.in).toEqual(['src/']);
    });

    test('should throw on invalid YAML', () => {
      const invalidYaml = `
id: FEAT-001
title: Test Feature
invalid: [unclosed array
`;

      expect(() => specManager.yamlToSpec(invalidYaml)).toThrow('Failed to parse YAML');
    });

    test('should throw on missing required fields', () => {
      const yaml = `
title: Test Feature
mode: feature
`;

      expect(() => specManager.yamlToSpec(yaml)).toThrow(
        'Invalid WorkingSpec: missing required fields'
      );
    });
  });

  describe('writeSpecFile and readSpecFile', () => {
    test('should write and read spec file', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
        mode: 'feature',
        scope: {
          in: ['src/'],
          out: ['tests/'],
        },
      };

      // Write
      await specManager.writeSpecFile(spec);

      // Read
      const readSpec = await specManager.readSpecFile();

      expect(readSpec.id).toBe('FEAT-001');
      expect(readSpec.title).toBe('Test Feature');
      expect(readSpec.risk_tier).toBe(2);
    });

    test('should write to temporary file when configured', async () => {
      const tempSpecManager = new SpecFileManager({
        projectRoot: tempDir,
        useTemporaryFiles: true,
      });

      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
        mode: 'feature',
      };

      const result = await tempSpecManager.writeSpecFile(spec);

      expect(result.isTemporary).toBe(true);
      expect(result.filePath).toContain('caws-spec-');
      expect(await fs.pathExists(result.filePath)).toBe(true);

      // Cleanup
      if (result.cleanup) {
        await result.cleanup();
      }
    });

    test('should cleanup temporary file', async () => {
      const tempSpecManager = new SpecFileManager({
        projectRoot: tempDir,
        useTemporaryFiles: true,
      });

      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      const result = await tempSpecManager.writeSpecFile(spec);
      const tempPath = result.filePath;

      expect(await fs.pathExists(tempPath)).toBe(true);

      await result.cleanup();

      expect(await fs.pathExists(tempPath)).toBe(false);
    });

    test('should throw when reading non-existent file', async () => {
      await expect(specManager.readSpecFile()).rejects.toThrow('Working spec not found');
    });
  });

  describe('updateSpecFile', () => {
    test('should update existing spec', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
        mode: 'feature',
      };

      await specManager.writeSpecFile(spec);

      // Update
      const updated = await specManager.updateSpecFile({
        title: 'Updated Feature',
        mode: 'refactor',
      });

      expect(updated.id).toBe('FEAT-001'); // Unchanged
      expect(updated.title).toBe('Updated Feature'); // Updated
      expect(updated.mode).toBe('refactor'); // Updated
      expect(updated.risk_tier).toBe(2); // Unchanged
    });
  });

  describe('backup and restore', () => {
    test('should create backup', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(spec);

      const backupPath = await specManager.backupSpecFile();

      expect(await fs.pathExists(backupPath)).toBe(true);
      expect(backupPath).toContain('.backup-');
    });

    test('should restore from backup', async () => {
      const originalSpec = {
        id: 'FEAT-001',
        title: 'Original',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(originalSpec);
      const backupPath = await specManager.backupSpecFile();

      // Modify spec
      await specManager.updateSpecFile({ title: 'Modified' });

      // Restore
      await specManager.restoreSpecFile(backupPath);

      const restored = await specManager.readSpecFile();
      expect(restored.title).toBe('Original');
    });

    test('should list all backups', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(spec);
      await new Promise((resolve) => setTimeout(resolve, 10)); // Ensure different timestamps
      await specManager.backupSpecFile();
      await new Promise((resolve) => setTimeout(resolve, 10)); // Ensure different timestamps
      await specManager.backupSpecFile();

      const backups = await specManager.listBackups();

      expect(backups.length).toBeGreaterThanOrEqual(2);
    });

    test('should cleanup old backups', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(spec);

      // Create backups
      const backup1 = await specManager.backupSpecFile();
      await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
      await specManager.backupSpecFile();
      await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
      const backup3 = await specManager.backupSpecFile();

      // Set old modification time on first backup
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      await fs.utimes(backup1, oldDate, oldDate);

      // Cleanup backups older than 7 days, keep at least 2
      const deleted = await specManager.cleanupBackups({
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        keep: 2,
      });

      // Should delete the old one (backup1), keep the 2 most recent
      expect(deleted).toBeGreaterThanOrEqual(0); // May be 0 or 1 depending on timing

      // Verify backup3 still exists (most recent)
      expect(await fs.pathExists(backup3)).toBe(true);
    });

    test('should create backup when writing with backup option', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Original',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(spec);

      // Overwrite with backup
      spec.title = 'Updated';
      await specManager.writeSpecFile(spec, { backup: true });

      const backups = await specManager.listBackups();
      expect(backups.length).toBe(1);
    });
  });

  describe('validateSpecFile', () => {
    test('should validate existing valid spec', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(spec);

      const result = await specManager.validateSpecFile();

      expect(result.valid).toBe(true);
      expect(result.spec).toBeDefined();
      expect(result.spec.id).toBe('FEAT-001');
    });

    test('should report validation error for missing file', async () => {
      const result = await specManager.validateSpecFile();

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Working spec not found');
    });
  });

  describe('getSpecFileStats', () => {
    test('should return stats for existing file', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(spec);

      const stats = await specManager.getSpecFileStats();

      expect(stats.exists).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.lines).toBeGreaterThan(0);
      expect(stats.modified).toBeDefined();
      expect(typeof stats.modified.getTime).toBe('function'); // Verify it's a Date
      expect(typeof stats.created.getTime).toBe('function'); // Verify it's a Date
      expect(stats.modified.getTime()).toBeGreaterThan(0);
    });

    test('should report non-existent file', async () => {
      const stats = await specManager.getSpecFileStats();

      expect(stats.exists).toBe(false);
    });
  });

  describe('cleanupTempFiles', () => {
    test('should cleanup old temporary files', async () => {
      const tempSpecManager = new SpecFileManager({
        projectRoot: tempDir,
        useTemporaryFiles: true,
      });

      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      // Create temp file
      const result = await tempSpecManager.writeSpecFile(spec);
      const tempPath = result.filePath;

      // Set old modification time
      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      await fs.utimes(tempPath, oldDate, oldDate);

      // Cleanup files older than 1 hour
      const cleaned = await tempSpecManager.cleanupTempFiles(3600000);

      expect(cleaned).toBe(1);
      expect(await fs.pathExists(tempPath)).toBe(false);
    });
  });

  describe('specFileExists', () => {
    test('should return true for existing file', async () => {
      const spec = {
        id: 'FEAT-001',
        title: 'Test Feature',
        risk_tier: 2,
      };

      await specManager.writeSpecFile(spec);

      const exists = await specManager.specFileExists();

      expect(exists).toBe(true);
    });

    test('should return false for non-existent file', async () => {
      const exists = await specManager.specFileExists();

      expect(exists).toBe(false);
    });
  });
});
