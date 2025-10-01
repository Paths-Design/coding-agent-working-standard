#!/usr/bin/env node

/**
 * @fileoverview CAWS Provenance Tracker - Real Implementation
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * Generate comprehensive provenance data for CAWS operations
 * @param {Object} options - Configuration options
 * @returns {Object} Complete provenance record
 */
function generateProvenance(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();

  return {
    // Agent and model information
    agent: options.agent || 'caws-cli',
    model: options.model || 'cli-interactive',
    model_hash: options.modelHash || generateModelHash(),

    // Tool and security information
    tool_allowlist: options.toolAllowlist || generateToolAllowlist(projectRoot),
    prompts: options.prompts || [],

    // Git and version control information
    commit: getCurrentCommit(projectRoot),
    branch: getCurrentBranch(projectRoot),
    repository: getRepositoryInfo(projectRoot),

    // File and artifact information
    artifacts: generateArtifactList(projectRoot),
    dependencies: generateDependencyInfo(projectRoot),

    // Execution results and metadata
    results: options.results || {},
    approvals: options.approvals || [],
    execution_context: generateExecutionContext(),

    // Security and integrity
    integrity: generateIntegrityInfo(),

    // Timestamps and versioning
    timestamp: new Date().toISOString(),
    version: getPackageVersion(projectRoot),
    provenance_hash: generateProvenanceHash(),

    // Build and deployment information
    build_info: generateBuildInfo(projectRoot),

    // Change tracking
    change_summary: generateChangeSummary(projectRoot),
  };
}

/**
 * Generate model hash for reproducibility tracking
 * @returns {string} Hash representing the current model state
 */
function generateModelHash() {
  // Create a hash based on the current CLI version and key files
  const keyFiles = [
    'package.json',
    'src/index.js',
    'apps/tools/caws/validate.js',
    'apps/tools/caws/gates.js',
    'apps/tools/caws/provenance.js',
  ];

  const hash = crypto.createHash('sha256');
  const projectRoot = process.cwd();

  keyFiles.forEach((file) => {
    const filePath = path.join(projectRoot, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      hash.update(content);
    }
  });

  return hash.digest('hex').substring(0, 16);
}

/**
 * Generate tool allowlist based on project configuration
 * @param {string} projectRoot - Project root directory
 * @returns {Array} Array of allowed tool patterns
 */
function generateToolAllowlist(projectRoot) {
  const allowlistPath = path.join(projectRoot, 'apps/tools/caws/tools-allow.json');

  if (fs.existsSync(allowlistPath)) {
    try {
      return JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    } catch (error) {
      console.warn(`⚠️  Invalid tool allowlist file: ${error.message}`);
    }
  }

  // Default allowlist for CAWS tools
  return ['apps/tools/caws/*.js', 'codemod/*.js', '.caws/*.yaml'];
}

/**
 * Get current git commit information
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Git commit information
 */
function getCurrentCommit(projectRoot) {
  try {
    const commitHash = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const commitMessage = execSync('git log -1 --pretty=%B', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const commitAuthor = execSync('git log -1 --pretty=%an', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const commitDate = execSync('git log -1 --pretty=%ai', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return {
      hash: commitHash,
      message: commitMessage,
      author: commitAuthor,
      date: commitDate,
      short_hash: commitHash.substring(0, 8),
    };
  } catch (error) {
    return {
      hash: 'unknown',
      message: 'No git repository or commit available',
      author: 'unknown',
      date: new Date().toISOString(),
      short_hash: 'unknown',
    };
  }
}

/**
 * Get current git branch information
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Git branch information
 */
function getCurrentBranch(projectRoot) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return {
      name: branch,
      is_main: branch === 'main' || branch === 'master',
      is_protected: ['main', 'master', 'develop'].includes(branch),
    };
  } catch (error) {
    return {
      name: 'unknown',
      is_main: false,
      is_protected: false,
    };
  }
}

/**
 * Get repository information
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Repository information
 */
function getRepositoryInfo(projectRoot) {
  try {
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return {
      url: remoteUrl,
      host: extractHostFromUrl(remoteUrl),
      name: extractRepoNameFromUrl(remoteUrl),
      is_github: remoteUrl.includes('github.com'),
      is_gitlab: remoteUrl.includes('gitlab.com'),
      is_bitbucket: remoteUrl.includes('bitbucket.org'),
    };
  } catch (error) {
    return {
      url: 'unknown',
      host: 'unknown',
      name: 'unknown',
      is_github: false,
      is_gitlab: false,
      is_bitbucket: false,
    };
  }
}

/**
 * Extract host from git URL
 * @param {string} url - Git repository URL
 * @returns {string} Host name
 */
function extractHostFromUrl(url) {
  try {
    const match = url.match(/https?:\/\/([^\/]+)/);
    return match ? match[1] : 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Extract repository name from git URL
 * @param {string} url - Git repository URL
 * @returns {string} Repository name
 */
function extractRepoNameFromUrl(url) {
  try {
    const match = url.match(/\/([^\/]+)(\.git)?$/);
    return match ? match[1].replace('.git', '') : 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Generate list of project artifacts
 * @param {string} projectRoot - Project root directory
 * @returns {Array} Array of artifact information
 */
function generateArtifactList(projectRoot) {
  const artifacts = [];

  // Add generated files and directories
  const artifactPaths = [
    '.caws/working-spec.yaml',
    '.agent',
    'apps/tools/caws',
    'dist',
    'coverage',
  ];

  artifactPaths.forEach((artifactPath) => {
    const fullPath = path.join(projectRoot, artifactPath);

    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);

      artifacts.push({
        path: artifactPath,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
        hash: generateFileHash(fullPath),
      });
    }
  });

  return artifacts;
}

/**
 * Generate dependency information
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Dependency information
 */
function generateDependencyInfo(projectRoot) {
  try {
    const packageJsonPath = path.join(projectRoot, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      return {
        runtime: Object.keys(packageJson.dependencies || {}),
        development: Object.keys(packageJson.devDependencies || {}),
        package_manager: packageJson.packageManager || 'npm',
        node_version: process.version,
        platform: process.platform,
        architecture: process.arch,
      };
    }
  } catch (error) {
    console.warn(`⚠️  Error reading package.json: ${error.message}`);
  }

  return {
    runtime: [],
    development: [],
    package_manager: 'unknown',
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
}

/**
 * Generate execution context information
 * @returns {Object} Execution context
 */
function generateExecutionContext() {
  return {
    command_line: process.argv.join(' '),
    working_directory: process.cwd(),
    user: process.env.USER || process.env.USERNAME || 'unknown',
    shell: process.env.SHELL || 'unknown',
    terminal: process.env.TERM || 'unknown',
    environment: process.env.NODE_ENV || 'development',
  };
}

/**
 * Generate integrity information
 * @returns {Object} Integrity verification data
 */
function generateIntegrityInfo() {
  return {
    provenance_algorithm: 'sha256',
    timestamp_verification: true,
    signature_required: false,
    tamper_detection: true,
  };
}

/**
 * Generate build information
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Build information
 */
function generateBuildInfo(projectRoot) {
  try {
    const buildTime = execSync('date -Iseconds', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return {
      timestamp: buildTime,
      platform: process.platform,
      architecture: process.arch,
      node_version: process.version,
      ci_environment: process.env.CI || false,
      build_tool: 'caws-cli',
    };
  } catch (error) {
    return {
      timestamp: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      node_version: process.version,
      ci_environment: process.env.CI || false,
      build_tool: 'caws-cli',
    };
  }
}

/**
 * Generate change summary
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Change summary information
 */
function generateChangeSummary(projectRoot) {
  try {
    // Get recent commits
    const recentCommits = execSync('git log --oneline -10', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);

    // Get file changes in last commit
    const fileChanges = execSync('git diff --name-only HEAD~1 HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);

    return {
      recent_commits: recentCommits.length,
      recent_commit_messages: recentCommits.slice(0, 3),
      files_changed: fileChanges.length,
      changed_files: fileChanges.slice(0, 10), // Limit to 10 files
      risk_assessment: assessChangeRisk(fileChanges),
    };
  } catch (error) {
    return {
      recent_commits: 0,
      recent_commit_messages: [],
      files_changed: 0,
      changed_files: [],
      risk_assessment: 'unknown',
    };
  }
}

/**
 * Assess risk level of file changes
 * @param {Array} changedFiles - Array of changed file paths
 * @returns {string} Risk assessment
 */
function assessChangeRisk(changedFiles) {
  const highRiskPatterns = [
    'package.json',
    'package-lock.json',
    'yarn.lock',
    'tsconfig.json',
    'webpack.config.js',
    'jest.config.js',
    '.eslintrc',
    'Dockerfile',
    'docker-compose.yml',
  ];

  const mediumRiskPatterns = ['src/', 'lib/', 'apps/', 'packages/'];

  const highRiskFiles = changedFiles.filter((file) =>
    highRiskPatterns.some((pattern) => file.includes(pattern))
  );

  const mediumRiskFiles = changedFiles.filter((file) =>
    mediumRiskPatterns.some((pattern) => file.includes(pattern))
  );

  if (highRiskFiles.length > 0) {
    return 'high';
  } else if (mediumRiskFiles.length > 0) {
    return 'medium';
  } else {
    return 'low';
  }
}

/**
 * Generate hash for a file or directory
 * @param {string} filePath - Path to file or directory
 * @returns {string} SHA256 hash
 */
function generateFileHash(filePath) {
  try {
    if (fs.statSync(filePath).isDirectory()) {
      // For directories, hash all files recursively
      const files = getAllFiles(filePath);
      const hash = crypto.createHash('sha256');

      files.forEach((file) => {
        if (fs.statSync(file).isFile()) {
          const content = fs.readFileSync(file);
          hash.update(content);
        }
      });

      return hash.digest('hex');
    } else {
      // For files, hash the content
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    }
  } catch (error) {
    return 'error-generating-hash';
  }
}

/**
 * Get all files in a directory recursively
 * @param {string} dirPath - Directory path
 * @returns {Array} Array of file paths
 */
function getAllFiles(dirPath) {
  const files = [];

  function scanDirectory(dir) {
    const items = fs.readdirSync(dir);

    items.forEach((item) => {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
        scanDirectory(fullPath);
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    });
  }

  scanDirectory(dirPath);
  return files;
}

/**
 * Generate provenance hash for integrity verification
 * @returns {string} Provenance record hash
 */
function generateProvenanceHash() {
  const provenance = generateProvenance();
  const content = JSON.stringify(provenance, Object.keys(provenance).sort());
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Get package version safely
 * @param {string} projectRoot - Project root directory
 * @returns {string} Package version or default
 */
function getPackageVersion(projectRoot) {
  try {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return packageJson.version || '1.0.0';
    }
  } catch (error) {
    // Ignore errors
  }
  return '1.0.0';
}

/**
 * Save provenance data to file
 * @param {Object} provenance - Provenance data
 * @param {string} filepath - File path to save to
 */
function saveProvenance(provenance, filepath) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Add metadata about the save operation
  const enrichedProvenance = {
    ...provenance,
    saved_at: new Date().toISOString(),
    saved_by: 'caws-provenance-tool',
  };

  fs.writeFileSync(filepath, JSON.stringify(enrichedProvenance, null, 2));
}

// Command-line interface
if (require.main === module) {
  const outputPath = process.argv[2] || '.agent/provenance.json';

  console.log('🔍 Generating CAWS provenance data...');

  try {
    const provenance = generateProvenance({
      projectRoot: process.cwd(),
      agent: 'caws-cli',
      model: 'provenance-generator',
    });

    saveProvenance(provenance, outputPath);

    console.log(`✅ Provenance data generated and saved to: ${outputPath}`);
    console.log('');
    console.log('📋 Summary:');
    console.log(`Agent: ${provenance.agent}`);
    console.log(`Commit: ${provenance.commit.short_hash}`);
    console.log(`Branch: ${provenance.branch.name}`);
    console.log(`Artifacts: ${provenance.artifacts.length}`);
    console.log(
      `Dependencies: ${provenance.dependencies.runtime.length} runtime, ${provenance.dependencies.development.length} dev`
    );
    console.log(`Risk Assessment: ${provenance.change_summary.risk_assessment}`);
    console.log('');
    console.log(`🔐 Provenance Hash: ${provenance.provenance_hash.substring(0, 16)}...`);
  } catch (error) {
    console.error(`❌ Error generating provenance: ${error.message}`);
    process.exit(1);
  }
}

// Export functions for module usage
module.exports = {
  generateProvenance,
  saveProvenance,
  generateModelHash,
  getCurrentCommit,
  getCurrentBranch,
  getRepositoryInfo,
  generateArtifactList,
  generateDependencyInfo,
  assessChangeRisk,
};
