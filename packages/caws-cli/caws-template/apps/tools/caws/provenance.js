#!/usr/bin/env node
/* eslint-disable */

/**
 * @fileoverview CAWS Provenance Tracker
 * Generates and manages provenance manifests for agent operations
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Generate provenance manifest
 * @param {Object} options - Provenance options
 * @returns {Object} Provenance manifest
 */
function generateProvenance(options = {}) {
  const {
    agent = 'caws-cli',
    model = 'unknown',
    modelHash = 'unknown',
    toolAllowlist = [],
    prompts = [],
    commit = null,
    artifacts = [],
    results = {},
    approvals = [],
  } = options;

  // Get git commit if available
  const currentCommit = commit || getCurrentGitCommit();

  const manifest = {
    agent,
    model,
    model_hash: modelHash,
    tool_allowlist: toolAllowlist,
    prompts,
    commit: currentCommit,
    artifacts,
    results,
    approvals,
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };

  // Generate hash of the manifest
  manifest.hash = generateManifestHash(manifest);

  return manifest;
}

/**
 * Get current git commit hash
 * @returns {string} Git commit hash or null
 */
function getCurrentGitCommit() {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch (error) {
    return null;
  }
}

/**
 * Generate hash of provenance manifest
 * @param {Object} manifest - Manifest to hash
 * @returns {string} SHA-256 hash
 */
function generateManifestHash(manifest) {
  const manifestCopy = { ...manifest };
  delete manifestCopy.hash; // Don't include hash in hash calculation

  const manifestString = JSON.stringify(manifestCopy, Object.keys(manifestCopy).sort());
  return crypto.createHash('sha256').update(manifestString).digest('hex');
}

/**
 * Generate SBOM (Software Bill of Materials)
 * @param {string} projectPath - Path to project
 * @returns {Object} SBOM data
 */
function generateSBOM(projectPath = '.') {
  const packageJsonPath = path.join(projectPath, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    console.warn('⚠️  No package.json found, skipping SBOM generation');
    return null;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const sbom = {
      spdxId: 'SPDXRef-DOCUMENT',
      spdxVersion: 'SPDX-2.3',
      creationInfo: {
        created: new Date().toISOString(),
        creators: ['Tool: caws-cli-1.0.0'],
      },
      name: packageJson.name || 'unknown',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      documentNamespace: `https://swinslow.net/spdx/${packageJson.name || 'unknown'}-${Date.now()}`,
      packages: [
        {
          SPDXID: 'SPDXRef-Package-Root',
          name: packageJson.name || 'unknown',
          version: packageJson.version || '0.0.0',
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: false,
          supplier: 'Organization: Unknown',
          originator: 'Organization: Unknown',
        },
      ],
    };

    // Add dependencies as packages
    if (packageJson.dependencies) {
      Object.entries(packageJson.dependencies).forEach(([name, version]) => {
        sbom.packages.push({
          SPDXID: `SPDXRef-Package-${name}`,
          name,
          version,
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: false,
          supplier: 'Organization: Unknown',
          originator: 'Organization: Unknown',
        });
      });
    }

    return sbom;
  } catch (error) {
    console.error('❌ Error generating SBOM:', error.message);
    return null;
  }
}

/**
 * Generate SLSA attestation
 * @param {Object} provenance - Provenance manifest
 * @returns {Object} SLSA attestation
 */
function generateSLSA(provenance) {
  return {
    _type: 'https://in-toto.io/Statement/v0.1',
    subject: [
      {
        name: 'caws-project',
        digest: {
          sha256: provenance.hash,
        },
      },
    ],
    predicateType: 'https://slsa.dev/provenance/v0.2',
    predicate: {
      builder: {
        id: 'https://github.com/caws/cli',
      },
      buildType: 'https://github.com/caws/cli@v1.0.0',
      invocation: {
        configSource: {
          uri: 'git+https://github.com/caws/cli',
          digest: {
            sha1: provenance.commit || 'unknown',
          },
        },
        parameters: {
          agent: provenance.agent,
          model: provenance.model,
          timestamp: provenance.timestamp,
        },
      },
      buildConfig: {
        tool_allowlist: provenance.tool_allowlist,
      },
      metadata: {
        invocationId: provenance.hash,
      },
      materials: provenance.artifacts.map((artifact) => ({
        uri: artifact,
        digest: {
          sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
        },
      })),
      byproducts: [
        {
          name: 'provenance.json',
          digest: {
            sha256: provenance.hash,
          },
        },
      ],
    },
  };
}

/**
 * Save provenance manifest to file
 * @param {Object} manifest - Provenance manifest
 * @param {string} outputPath - Output file path
 */
function saveProvenance(manifest, outputPath = '.agent/provenance.json') {
  try {
    // Ensure directory exists
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
    console.log(`✅ Provenance saved to ${outputPath}`);
  } catch (error) {
    console.error('❌ Error saving provenance:', error.message);
    process.exit(1);
  }
}

/**
 * Load provenance manifest from file
 * @param {string} inputPath - Input file path
 * @returns {Object} Provenance manifest
 */
function loadProvenance(inputPath = '.agent/provenance.json') {
  try {
    const content = fs.readFileSync(inputPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('❌ Error loading provenance:', error.message);
    return null;
  }
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];

  switch (command) {
    case 'generate':
      const options = {
        agent: process.argv[3] || 'caws-cli',
        model: process.argv[4] || 'unknown',
        modelHash: process.argv[5] || 'unknown',
        toolAllowlist: process.argv[6] ? process.argv[6].split(',') : [],
        prompts: process.argv[7] ? process.argv[7].split(',') : [],
        commit: process.argv[8] || null,
        artifacts: process.argv[9] ? process.argv[9].split(',') : [],
        results: process.argv[10] ? JSON.parse(process.argv[10]) : {},
        approvals: process.argv[11] ? process.argv[11].split(',') : [],
      };

      const manifest = generateProvenance(options);
      console.log(JSON.stringify(manifest, null, 2));
      break;

    case 'sbom':
      const sbom = generateSBOM(process.argv[3] || '.');
      if (sbom) {
        const outputPath = process.argv[4] || '.agent/sbom.json';
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(sbom, null, 2));
        console.log(`✅ SBOM generated and saved to ${outputPath}`);
      }
      break;

    case 'slsa':
      const provPath = process.argv[3] || '.agent/provenance.json';
      const provenance = loadProvenance(provPath);
      if (provenance) {
        const attestation = generateSLSA(provenance);
        const outputPath = process.argv[4] || '.agent/attestation.json';
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(attestation, null, 2));
        console.log(`✅ SLSA attestation generated and saved to ${outputPath}`);
      } else {
        console.error('❌ Provenance manifest not found. Generate it first.');
        process.exit(1);
      }
      break;

    default:
      console.log('CAWS Provenance Tool');
      console.log('Usage:');
      console.log(
        '  node provenance.js generate [agent] [model] [modelHash] [toolAllowlist] [prompts] [commit] [artifacts] [results] [approvals]'
      );
      console.log('  node provenance.js sbom [projectPath] [outputPath]');
      console.log('  node provenance.js slsa [provenancePath] [outputPath]');
      process.exit(1);
  }
}

module.exports = {
  generateProvenance,
  generateSBOM,
  generateSLSA,
  saveProvenance,
  loadProvenance,
};
