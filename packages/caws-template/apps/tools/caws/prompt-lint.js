#!/usr/bin/env node

/**
 * @fileoverview CAWS Prompt Linter
 * Validates prompts for secrets and ensures tool allowlist compliance
 * @author @darianrosebrook
 */

const fs = require("fs");
const path = require("path");

/**
 * Common secret patterns to detect
 */
const SECRET_PATTERNS = [
  // API Keys
  /api[_-]?key[_-]?token\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
  /x-api-key\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
  /authorization\s*[=:]\s*['"]?(Bearer\s+)?([a-zA-Z0-9_-]{20,})['"]?/gi,

  // Tokens
  /token\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
  /access[_-]?token\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
  /refresh[_-]?token\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
  /auth[_-]?token\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,

  // Passwords
  /password\s*[=:]\s*['"]?([a-zA-Z0-9_-]{8,})['"]?/gi,
  /passwd\s*[=:]\s*['"]?([a-zA-Z0-9_-]{8,})['"]?/gi,
  /pwd\s*[=:]\s*['"]?([a-zA-Z0-9_-]{8,})['"]?/gi,

  // Secrets
  /secret\s*[=:]\s*['"]?([a-zA-Z0-9_-]{16,})['"]?/gi,
  /private[_-]?key\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,

  // Environment variables that might contain secrets
  /process\.env\.[A-Z_]+_KEY/gi,
  /process\.env\.[A-Z_]+_TOKEN/gi,
  /process\.env\.[A-Z_]+_SECRET/gi,
  /process\.env\.[A-Z_]+_PASSWORD/gi,

  // URLs with potential secrets
  /https?:\/\/[^/]*@[^/]+/gi,

  // Base64 encoded strings that might be secrets
  /[A-Za-z0-9+/=]{40,}/g,

  // AWS keys
  /AKIA[A-Z0-9]{16}/gi,

  // GitHub tokens
  /ghp_[A-Za-z0-9]{36}/gi,
  /github_pat_[A-Za-z0-9]{22}/gi,

  // Slack tokens
  /xoxb-[0-9]+-[0-9]+-[0-9]+-[a-zA-Z0-9]+/gi,

  // Database connection strings
  /mongodb(\+srv)?:\/\/[^:]+:[^@]+@[^/]+/gi,
  /postgres:\/\/[^:]+:[^@]+@[^/]+/gi,
  /mysql:\/\/[^:]+:[^@]+@[^/]+/gi,
];

/**
 * Scan file for potential secrets
 * @param {string} filePath - Path to file to scan
 * @returns {Array} Array of potential secret matches
 */
function scanForSecrets(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const matches = [];

    for (const pattern of SECRET_PATTERNS) {
      const patternMatches = [...content.matchAll(pattern)];
      for (const match of patternMatches) {
        matches.push({
          file: filePath,
          line: content.substring(0, match.index).split("\n").length,
          pattern: pattern.toString(),
          match: match[0],
          severity: "high",
        });
      }
    }

    return matches;
  } catch (error) {
    console.error(`❌ Error scanning ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Validate tools against allowlist
 * @param {Array} tools - Tools used in prompts
 * @param {Array} allowlist - Allowed tools
 * @returns {Array} Array of violations
 */
function validateToolAllowlist(tools, allowlist) {
  const violations = [];

  for (const tool of tools) {
    if (!allowlist.includes(tool)) {
      violations.push({
        tool,
        severity: "high",
        message: `Tool "${tool}" not in allowlist`,
      });
    }
  }

  return violations;
}

/**
 * Extract tools from prompt content
 * @param {string} content - Prompt content
 * @returns {Array} Array of tools mentioned
 */
function extractTools(content) {
  const tools = [];

  // Common tool patterns
  const toolPatterns = [
    /using\s+(node|npm|yarn|pnpm|git|docker|kubectl|aws|azure|gcloud)/gi,
    /(node|npm|yarn|pnpm|git|docker|kubectl|aws|azure|gcloud)\s+command/gi,
    /execute\s+(node|npm|yarn|pnpm|git|docker|kubectl|aws|azure|gcloud)/gi,
    /run\s+(node|npm|yarn|pnpm|git|docker|kubectl|aws|azure|gcloud)/gi,
  ];

  for (const pattern of toolPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const tool = match[1] || match[0];
      if (!tools.includes(tool)) {
        tools.push(tool);
      }
    }
  }

  return tools;
}

/**
 * Lint prompts for security and compliance
 * @param {Array} promptFiles - Array of prompt file paths
 * @param {Array} allowlist - Allowed tools
 * @returns {Object} Lint results
 */
function lintPrompts(promptFiles, allowlist) {
  const results = {
    secrets: [],
    violations: [],
    cleanFiles: 0,
    totalFiles: promptFiles.length,
  };

  for (const file of promptFiles) {
    if (!fs.existsSync(file)) {
      console.warn(`⚠️  Prompt file not found: ${file}`);
      continue;
    }

    // Scan for secrets
    const secretMatches = scanForSecrets(file);
    results.secrets.push(...secretMatches);

    // Extract and validate tools
    const content = fs.readFileSync(file, "utf8");
    const tools = extractTools(content);
    const toolViolations = validateToolAllowlist(tools, allowlist);
    results.violations.push(...toolViolations.map((v) => ({ ...v, file })));

    // Check if file is clean
    if (secretMatches.length === 0 && toolViolations.length === 0) {
      results.cleanFiles++;
    }
  }

  return results;
}

/**
 * Load tool allowlist from file
 * @param {string} allowlistPath - Path to allowlist file
 * @returns {Array} Array of allowed tools
 */
function loadAllowlist(allowlistPath) {
  try {
    if (!fs.existsSync(allowlistPath)) {
      console.warn(`⚠️  Allowlist file not found: ${allowlistPath}`);
      return [];
    }

    const content = fs.readFileSync(allowlistPath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Error loading allowlist:`, error.message);
    return [];
  }
}

// CLI interface
if (require.main === module) {
  const promptFiles = process.argv.slice(2);
  const allowlistArg = process.argv
    .find((arg) => arg.startsWith("--allowlist="))
    ?.split("=")[1];
  const allowlistPath = allowlistArg || ".agent/tools-allow.json";

  if (promptFiles.length === 0) {
    console.log("CAWS Prompt Linter");
    console.log(
      "Usage: node prompt-lint.js <prompt-file1> [prompt-file2] ... [options]"
    );
    console.log("Options:");
    console.log(
      "  --allowlist=<path>  Path to tools allowlist file (default: .agent/tools-allow.json)"
    );
    process.exit(1);
  }

  // Load allowlist
  const allowlist = loadAllowlist(allowlistPath);

  console.log("🔍 Linting prompts for security and compliance...");
  console.log(`📁 Allowlist loaded: ${allowlist.length} tools`);
  console.log(`📄 Scanning ${promptFiles.length} files...`);

  // Lint prompts
  const results = lintPrompts(promptFiles, allowlist);

  // Report results
  if (results.secrets.length > 0) {
    console.log("\n🚨 POTENTIAL SECRETS DETECTED:");
    results.secrets.forEach((secret, index) => {
      console.log(
        `  ${index + 1}. ${secret.file}:${
          secret.line
        } - ${secret.match.substring(0, 50)}...`
      );
    });
  }

  if (results.violations.length > 0) {
    console.log("\n⚠️  TOOL VIOLATIONS:");
    results.violations.forEach((violation, index) => {
      console.log(`  ${index + 1}. ${violation.file} - ${violation.message}`);
    });
  }

  console.log("\n📊 SUMMARY:");
  console.log(`   - Files scanned: ${results.totalFiles}`);
  console.log(`   - Clean files: ${results.cleanFiles}`);
  console.log(`   - Secrets found: ${results.secrets.length}`);
  console.log(`   - Violations: ${results.violations.length}`);

  // Exit with error if issues found
  if (results.secrets.length > 0 || results.violations.length > 0) {
    console.log("\n❌ Linting failed - security issues detected");
    process.exit(1);
  }

  console.log("✅ All prompts passed security checks");
  process.exit(0);
}

module.exports = {
  scanForSecrets,
  validateToolAllowlist,
  extractTools,
  lintPrompts,
  loadAllowlist,
};
