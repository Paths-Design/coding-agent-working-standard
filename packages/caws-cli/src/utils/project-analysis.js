/**
 * @fileoverview Project Analysis Utilities
 * Functions for analyzing project types and structure
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

/**
 * Detect project type from existing files and structure
 * @param {string} cwd - Current working directory
 * @returns {string} Project type
 */
function detectProjectType(cwd = process.cwd()) {
  const files = fs.readdirSync(cwd);

  // Check for various project indicators
  const hasPackageJson = files.includes('package.json');
  const hasPnpm = files.includes('pnpm-workspace.yaml');
  const hasYarn = files.includes('yarn.lock');

  let packageJson = {};
  if (hasPackageJson) {
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    } catch (e) {
      // Ignore parse errors
    }
  }

  // VS Code Extension detection
  const isVscodeExtension =
    packageJson.engines?.vscode ||
    packageJson.contributes ||
    packageJson.activationEvents ||
    packageJson.main?.includes('extension.js');

  // Monorepo detection
  const isMonorepo = hasPnpm || hasYarn || files.includes('packages') || files.includes('apps');

  // Library detection
  const isLibrary = packageJson.main || packageJson.module || packageJson.exports;

  // CLI detection
  const isCli = packageJson.bin || packageJson.name?.startsWith('@') === false;

  // API detection
  const isApi =
    packageJson.scripts?.start ||
    packageJson.dependencies?.express ||
    packageJson.dependencies?.fastify ||
    packageJson.dependencies?.['@types/express'];

  // Determine primary type
  if (isVscodeExtension) return 'extension';
  if (isMonorepo) return 'monorepo';
  if (isApi) return 'api';
  if (isLibrary) return 'library';
  if (isCli) return 'cli';

  // Default fallback
  return 'application';
}

/**
 * Detect if current directory appears to be a project that should be initialized directly
 * @param {string} projectName - Project name from command line
 * @param {string} currentDir - Current directory path
 * @returns {boolean} Whether to init in current directory
 */
function shouldInitInCurrentDirectory(projectName, currentDir) {
  // If explicitly '.', always init in current directory
  if (projectName === '.') return true;

  // Check for common project indicators
  const projectIndicators = [
    'package.json',
    'tsconfig.json',
    'jest.config.js',
    'eslint.config.js',
    'README.md',
    'src/',
    'lib/',
    'app/',
    'packages/',
    '.git/',
    'node_modules/', // Even if empty, suggests intent to be a project
  ];

  const files = fs.readdirSync(currentDir);
  const hasProjectIndicators = projectIndicators.some((indicator) => {
    if (indicator.endsWith('/')) {
      return files.includes(indicator.slice(0, -1));
    }
    return files.includes(indicator);
  });

  return hasProjectIndicators;
}

/**
 * Detect if project publishes packages to registries
 * Checks for publishing configuration in package.json, pyproject.toml, etc.
 * @param {string} cwd - Current working directory
 * @returns {boolean} Whether project appears to publish packages
 */
function detectsPublishing(cwd = process.cwd()) {
  const files = fs.readdirSync(cwd);

  // Check package.json for npm publishing
  if (files.includes('package.json')) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));

      // Indicators of publishing:
      // - Has publishConfig
      // - Has scripts that include "publish"
      // - Has name that suggests it's a published package
      // - Has repository field (often indicates published package)
      const hasPublishConfig = packageJson.publishConfig;
      const hasPublishScript =
        packageJson.scripts &&
        Object.keys(packageJson.scripts).some((key) => key.toLowerCase().includes('publish'));
      const hasScopedName = packageJson.name && packageJson.name.startsWith('@');
      const hasRepository = packageJson.repository;

      if (hasPublishConfig || hasPublishScript || (hasScopedName && hasRepository)) {
        return true;
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Check pyproject.toml for PyPI publishing
  if (files.includes('pyproject.toml')) {
    try {
      const pyprojectContent = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');

      // Check for build system and project metadata (indicates publishable package)
      const hasBuildSystem = pyprojectContent.includes('[build-system]');
      const hasProjectMetadata = pyprojectContent.includes('[project]');
      const hasToolPublish =
        pyprojectContent.includes('[tool.publish]') || pyprojectContent.includes('[tool.twine]');

      if ((hasBuildSystem && hasProjectMetadata) || hasToolPublish) {
        return true;
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  // Check for Maven publishing (pom.xml)
  if (files.includes('pom.xml')) {
    return true; // Maven projects typically publish
  }

  // Check for .csproj (NuGet publishing)
  const csprojFiles = files.filter((f) => f.endsWith('.csproj'));
  if (csprojFiles.length > 0) {
    return true; // .NET projects typically publish
  }

  // Check for GitHub Actions workflows that publish
  const workflowsPath = path.join(cwd, '.github', 'workflows');
  if (fs.existsSync(workflowsPath)) {
    try {
      const workflowFiles = fs.readdirSync(workflowsPath);
      for (const workflowFile of workflowFiles) {
        if (workflowFile.endsWith('.yml') || workflowFile.endsWith('.yaml')) {
          const workflowContent = fs.readFileSync(path.join(workflowsPath, workflowFile), 'utf8');
          // Check for common publishing actions/commands
          if (
            workflowContent.includes('npm publish') ||
            workflowContent.includes('pypa/gh-action-pypi-publish') ||
            workflowContent.includes('publish-to-npm') ||
            workflowContent.includes('semantic-release') ||
            workflowContent.includes('publish')
          ) {
            return true;
          }
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  return false;
}

/**
 * Detect primary programming language(s) used in project
 * @param {string} cwd - Current working directory
 * @returns {Object} Language detection result with primary language and indicators
 */
function detectProjectLanguage(cwd = process.cwd()) {
  const files = fs.readdirSync(cwd);
  const indicators = {
    javascript: false,
    typescript: false,
    python: false,
    rust: false,
    go: false,
    java: false,
    csharp: false,
    php: false,
  };

  // JavaScript/TypeScript indicators
  if (files.includes('package.json')) {
    indicators.javascript = true;
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const allDeps = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };
      if ('typescript' in allDeps || files.includes('tsconfig.json')) {
        indicators.typescript = true;
        indicators.javascript = false; // TypeScript supersedes JavaScript
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Python indicators
  if (
    files.includes('requirements.txt') ||
    files.includes('pyproject.toml') ||
    files.includes('setup.py') ||
    files.includes('Pipfile') ||
    files.includes('poetry.lock') ||
    files.some((f) => f.endsWith('.py'))
  ) {
    indicators.python = true;
  }

  // Rust indicators
  if (files.includes('Cargo.toml') || files.some((f) => f.endsWith('.rs'))) {
    indicators.rust = true;
  }

  // Go indicators
  if (
    files.includes('go.mod') ||
    files.includes('go.sum') ||
    files.some((f) => f.endsWith('.go'))
  ) {
    indicators.go = true;
  }

  // Java indicators
  if (
    files.includes('pom.xml') ||
    files.includes('build.gradle') ||
    files.some((f) => f.endsWith('.java'))
  ) {
    indicators.java = true;
  }

  // C# indicators
  if (
    files.some((f) => f.endsWith('.csproj')) ||
    files.some((f) => f.endsWith('.sln')) ||
    files.some((f) => f.endsWith('.cs'))
  ) {
    indicators.csharp = true;
  }

  // PHP indicators
  if (
    files.includes('composer.json') ||
    files.includes('composer.lock') ||
    files.some((f) => f.endsWith('.php'))
  ) {
    indicators.php = true;
  }

  // Determine primary language (priority order)
  let primaryLanguage = 'unknown';
  if (indicators.typescript) {
    primaryLanguage = 'typescript';
  } else if (indicators.javascript) {
    primaryLanguage = 'javascript';
  } else if (indicators.python) {
    primaryLanguage = 'python';
  } else if (indicators.rust) {
    primaryLanguage = 'rust';
  } else if (indicators.go) {
    primaryLanguage = 'go';
  } else if (indicators.java) {
    primaryLanguage = 'java';
  } else if (indicators.csharp) {
    primaryLanguage = 'csharp';
  } else if (indicators.php) {
    primaryLanguage = 'php';
  }

  return {
    primary: primaryLanguage,
    indicators,
    hasNodeJs: indicators.javascript || indicators.typescript,
    hasPython: indicators.python,
  };
}

/**
 * Get language-agnostic suggestion for TODO analyzer installation
 * Focuses on runtime availability (Node.js/npx) rather than project language
 * @param {string} cwd - Current working directory
 * @returns {string} Installation suggestion message
 */
function getTodoAnalyzerSuggestion(cwd = process.cwd()) {
  // Check runtime availability (language-agnostic)
  let hasNodeJs = false;
  let hasNpx = false;
  try {
    const { execSync } = require('child_process');
    execSync('command -v node', { encoding: 'utf8', stdio: 'ignore' });
    hasNodeJs = true;
    execSync('command -v npx', { encoding: 'utf8', stdio: 'ignore' });
    hasNpx = true;
  } catch (e) {
    // Node.js/npx not available
  }

  const suggestions = [];

  if (hasNpx) {
    // npx available - works for any language, no installation needed
    suggestions.push(
      '   • Use npx (no installation required): npx --yes @paths.design/quality-gates'
    );
    suggestions.push('   • Install package: npm install --save-dev @paths.design/quality-gates');
  } else if (hasNodeJs) {
    // Node.js available but npx not found (unusual)
    suggestions.push('   • Install package: npm install --save-dev @paths.design/quality-gates');
    suggestions.push(
      '   • Install npx: npm install -g npx (then use: npx --yes @paths.design/quality-gates)'
    );
  } else {
    // Node.js not available - suggest installation
    suggestions.push(
      '   • Install Node.js: https://nodejs.org/ (then use: npx --yes @paths.design/quality-gates)'
    );
    suggestions.push('   • Use CAWS MCP server: caws quality-gates (via MCP)');
  }

  // Check for project-specific scripts (language-agnostic - if they exist, suggest them)
  const pythonScript = path.join(cwd, 'scripts', 'v3', 'analysis', 'todo_analyzer.py');
  if (fs.existsSync(pythonScript)) {
    suggestions.push(`   • Use project script: python3 ${pythonScript}`);
  }

  return suggestions.join('\n');
}

module.exports = {
  detectProjectType,
  shouldInitInCurrentDirectory,
  detectsPublishing,
  detectProjectLanguage,
  getTodoAnalyzerSuggestion,
};
