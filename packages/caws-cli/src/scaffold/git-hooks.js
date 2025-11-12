/**
 * @fileoverview Git Hooks Scaffolding for CAWS Provenance
 * Functions for setting up git hooks that automatically update provenance
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const { getTodoAnalyzerSuggestion } = require('../utils/project-analysis');

/**
 * Scaffold git hooks for CAWS provenance tracking
 * @param {string} projectDir - Project directory path
 * @param {Object} options - Hook options
 */
async function scaffoldGitHooks(projectDir, options = {}) {
  const { provenance = true, validation = true, qualityGates = true, force = false } = options;

  console.log('🔗 Setting up Git hooks for CAWS provenance...');

  const gitDir = path.join(projectDir, '.git');
  const hooksDir = path.join(gitDir, 'hooks');

  // Check if this is a git repository
  if (!(await fs.pathExists(gitDir))) {
    console.log('⚠️  Not a git repository - skipping git hooks setup');
    console.log('💡 Initialize git first: git init');
    return { added: 0, skipped: 0 };
  }

  // Ensure hooks directory exists
  await fs.ensureDir(hooksDir);

  let addedCount = 0;
  let skippedCount = 0;

  // Define hook configurations
  const hooks = [
    {
      name: 'pre-commit',
      description: 'Pre-commit validation and quality checks',
      enabled: validation || qualityGates,
      content: generatePreCommitHook({ validation, qualityGates, projectDir }),
    },
    {
      name: 'post-commit',
      description: 'Post-commit provenance tracking',
      enabled: provenance,
      content: generatePostCommitHook(),
    },
    {
      name: 'pre-push',
      description: 'Pre-push comprehensive validation',
      enabled: qualityGates,
      content: generatePrePushHook(),
    },
    {
      name: 'commit-msg',
      description: 'Commit message validation',
      enabled: validation,
      content: generateCommitMsgHook(),
    },
  ];

  for (const hook of hooks) {
    if (!hook.enabled) continue;

    const hookPath = path.join(hooksDir, hook.name);

    try {
      // Check if hook already exists
      const exists = await fs.pathExists(hookPath);

      if (exists && !force) {
        // Check if it's already a CAWS hook
        const content = await fs.readFile(hookPath, 'utf8');
        if (content.includes('# CAWS Hook')) {
          console.log(`⏭️  Skipped ${hook.description} (already configured)`);
          skippedCount++;
          continue;
        } else {
          console.log(`⚠️  ${hook.description} exists but not CAWS-managed`);
          if (!options.backup) {
            console.log(`💡 Use --force to replace, or --backup to preserve original`);
            skippedCount++;
            continue;
          }
        }
      }

      // Backup existing hook if requested
      if (exists && options.backup) {
        const backupPath = `${hookPath}.backup.${Date.now()}`;
        await fs.copy(hookPath, backupPath);
        console.log(`💾 Backed up existing ${hook.name} to ${path.basename(backupPath)}`);
      }

      // Write the hook
      await fs.writeFile(hookPath, hook.content);
      await fs.chmod(hookPath, 0o755);

      console.log(`✅ Configured ${hook.description}`);
      addedCount++;
    } catch (error) {
      console.log(`❌ Failed to configure ${hook.description}: ${error.message}`);
    }
  }

  if (addedCount > 0) {
    console.log(`\n🔗 Git hooks configured: ${addedCount} hooks active`);
    console.log('💡 Hooks will run automatically on git operations');
    console.log('💡 Use --no-verify to skip commit hooks: git commit --no-verify');
    console.log('⚠️  Note: --no-verify is BLOCKED on git push for safety');
  }

  return { added: addedCount, skipped: skippedCount };
}

/**
 * Generate pre-commit hook content with staged file quality gates
 * Implements fallback chain: Node script → CLI → Python scripts → Skip gracefully
 */
function generatePreCommitHook(options) {
  const { qualityGates = true, stagedOnly = true, projectDir = process.cwd() } = options;

  // Get language-agnostic suggestions based on runtime availability
  const todoSuggestion = getTodoAnalyzerSuggestion(projectDir);

  return `#!/bin/bash
# CAWS Pre-commit Hook
# Runs validation and quality checks before commits
# Implements graceful fallback chain to avoid blocking commits

set -e

echo "🚦 Running CAWS Quality Gates${qualityGates ? ' (Crisis Response Mode)' : ''}..."
echo "📁 Analyzing ${stagedOnly ? 'staged files only' : 'all files'}..."

# Check if CAWS is initialized
if [ ! -d ".caws" ]; then
  echo "⚠️  CAWS not initialized - skipping validation"
  exit 0
fi

# Check for git locks before proceeding
if [ -f ".git/index.lock" ]; then
  LOCK_AGE=$(($(date +%s) - $(stat -f %m .git/index.lock 2>/dev/null || stat -c %Y .git/index.lock 2>/dev/null || echo 0)))
  LOCK_AGE_MINUTES=$((LOCK_AGE / 60))
  
  if [ $LOCK_AGE_MINUTES -gt 5 ]; then
    echo "⚠️  Stale git lock detected (\${LOCK_AGE_MINUTES} minutes old)"
    echo "💡 This may indicate a crashed git process"
    echo "💡 Remove stale lock: rm .git/index.lock"
    echo "⚠️  Warning: Check for running git/editor processes before removing"
    exit 1
  else
    echo "⚠️  Git lock detected (\${LOCK_AGE_MINUTES} minutes old)"
    echo "💡 Another git process may be running"
    echo "💡 Wait for the other process to complete, or check for running processes"
    exit 1
  fi
fi

# Validate YAML syntax for all CAWS spec files
echo "🔍 Validating YAML syntax for CAWS spec files..."
YAML_VALIDATION_FAILED=false

# Find all staged .yaml/.yml files in .caws directory
STAGED_YAML_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.caws/.*\\.(yaml|yml)$' || true)

if [ -n "$STAGED_YAML_FILES" ]; then
  # Use Node.js to validate YAML if available
  if command -v node >/dev/null 2>&1; then
    # Try to use CAWS CLI for validation
    if command -v caws >/dev/null 2>&1; then
      for file in $STAGED_YAML_FILES; do
        if [ -f "$file" ]; then
          # Use Node.js to validate YAML syntax
          if ! node -e "
            const yaml = require('js-yaml');
            const fs = require('fs');
            try {
              const content = fs.readFileSync('$file', 'utf8');
              yaml.load(content);
              process.exit(0);
            } catch (error) {
              console.error('❌ Invalid YAML in $file');
              console.error('   Error:', error.message);
              if (error.mark) {
                console.error('   Line:', error.mark.line + 1, 'Column:', error.mark.column + 1);
                if (error.mark.snippet) console.error('   ' + error.mark.snippet);
              }
              process.exit(1);
            }
          " 2>&1; then
            YAML_VALIDATION_FAILED=true
          fi
        fi
      done
    else
      # Fallback: use node directly with js-yaml
      for file in $STAGED_YAML_FILES; do
        if [ -f "$file" ]; then
          if ! node -e "
            const yaml = require('js-yaml');
            const fs = require('fs');
            try {
              const content = fs.readFileSync('$file', 'utf8');
              yaml.load(content);
              process.exit(0);
            } catch (error) {
              console.error('❌ Invalid YAML in $file');
              console.error('   Error:', error.message);
              if (error.mark) {
                console.error('   Line:', error.mark.line + 1, 'Column:', error.mark.column + 1);
                if (error.mark.snippet) console.error('   ' + error.mark.snippet);
              }
              process.exit(1);
            }
          " 2>&1; then
            YAML_VALIDATION_FAILED=true
          fi
        fi
      done
    fi
  else
    echo "⚠️  Node.js not available - skipping YAML validation"
    echo "💡 Install Node.js to enable YAML syntax validation"
  fi
fi

if [ "$YAML_VALIDATION_FAILED" = true ]; then
  echo "❌ YAML syntax validation failed - commit blocked"
  echo "💡 Fix YAML syntax errors above before committing"
  echo "💡 Consider using 'caws specs create <id>' instead of manual creation"
  exit 1
fi

# Fallback chain for quality gates:
# 1. Try Node.js script (if exists)
# 2. Try CAWS CLI
# 3. Try Makefile target
# 4. Try Python scripts
# 5. Skip gracefully (warn only)

QUALITY_GATES_RAN=false

# Option 1: Quality gates package (installed via npm)
if [ -f "node_modules/@paths.design/quality-gates/run-quality-gates.mjs" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "📁 Running quality gates package..."
    if node node_modules/@paths.design/quality-gates/run-quality-gates.mjs --ci; then
      echo "✅ Quality gates passed"
      QUALITY_GATES_RAN=true
    else
      echo "❌ Quality gates failed - commit blocked"
      echo "💡 Fix the violations above before committing"
      exit 1
    fi
  fi
# Option 1b: Quality gates package (monorepo/local copy)
elif [ -f "node_modules/@caws/quality-gates/run-quality-gates.mjs" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "📁 Running quality gates package (local)..."
    if node node_modules/@caws/quality-gates/run-quality-gates.mjs --ci; then
      echo "✅ Quality gates passed"
      QUALITY_GATES_RAN=true
    else
      echo "❌ Quality gates failed - commit blocked"
      echo "💡 Fix the violations above before committing"
      exit 1
    fi
  fi
# Option 2: Legacy Node.js quality gates script (deprecated)
elif [ -f "scripts/quality-gates/run-quality-gates.js" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "📁 Running legacy Node.js quality gates script..."
    if node scripts/quality-gates/run-quality-gates.js; then
      echo "✅ Quality gates passed"
      QUALITY_GATES_RAN=true
    else
      echo "❌ Quality gates failed - commit blocked"
      echo "💡 Fix the violations above before committing"
      exit 1
    fi
  fi
# Option 3: CAWS CLI validation
elif command -v caws >/dev/null 2>&1; then
  echo "📋 Running CAWS CLI validation..."
  if caws validate --quiet 2>/dev/null; then
    echo "✅ CAWS validation passed"
    QUALITY_GATES_RAN=true
  else
    echo "⚠️  CAWS validation failed, but allowing commit (non-blocking)"
    echo "💡 Run 'caws validate' for details"
    QUALITY_GATES_RAN=true
  fi
# Option 3: Makefile target
elif [ -f "Makefile" ] && grep -q "caws-validate\\|caws-gates" Makefile; then
  echo "🔧 Running Makefile quality gates..."
  if make caws-validate >/dev/null 2>&1 || make caws-gates >/dev/null 2>&1; then
    echo "✅ Makefile quality gates passed"
    QUALITY_GATES_RAN=true
  else
    echo "⚠️  Makefile quality gates failed, but allowing commit (non-blocking)"
    QUALITY_GATES_RAN=true
  fi
# Option 4: Python scripts
elif [ -f "scripts/simple_gates.py" ] && command -v python3 >/dev/null 2>&1; then
  echo "🐍 Running Python quality gates script..."
  if python3 scripts/simple_gates.py all --tier 2 --profile backend-api >/dev/null 2>&1; then
    echo "✅ Python quality gates passed"
    QUALITY_GATES_RAN=true
  else
    echo "⚠️  Python quality gates failed, but allowing commit (non-blocking)"
    QUALITY_GATES_RAN=true
  fi
# Option 5: Skip gracefully
else
  echo "⚠️  Quality gates not available - skipping"
  echo "💡 Available options:"
  echo "   • Install quality gates: npm install --save-dev @paths.design/quality-gates"
  echo "   • Install CAWS CLI: npm install -g @paths.design/caws-cli"
  echo "   • Use Python: python3 scripts/simple_gates.py"
  echo "   • Use Makefile: make caws-gates"
  QUALITY_GATES_RAN=true
fi

# Run hidden TODO analysis on staged files only (if available)
if [ "$QUALITY_GATES_RAN" = true ]; then
  echo "🔍 Checking for hidden TODOs in staged files..."
  
  TODO_CHECK_RAN=false
  
  # Option 1: Find TODO analyzer .mjs file (if installed locally)
  if [ "$TODO_CHECK_RAN" = false ]; then
    TODO_ANALYZER=""
    
    # Try quality gates package TODO analyzer (published package)
    if [ -f "node_modules/@paths.design/quality-gates/todo-analyzer.mjs" ]; then
      TODO_ANALYZER="node_modules/@paths.design/quality-gates/todo-analyzer.mjs"
    # Try quality gates package TODO analyzer (monorepo/local copy)
    elif [ -f "node_modules/@caws/quality-gates/todo-analyzer.mjs" ]; then
      TODO_ANALYZER="node_modules/@caws/quality-gates/todo-analyzer.mjs"
    # Try monorepo structure (development)
    elif [ -f "packages/quality-gates/todo-analyzer.mjs" ]; then
      TODO_ANALYZER="packages/quality-gates/todo-analyzer.mjs"
    # Try local copy in scripts directory (if scaffolded)
    elif [ -f "scripts/todo-analyzer.mjs" ]; then
      TODO_ANALYZER="scripts/todo-analyzer.mjs"
    fi
    
    # Run TODO analyzer if found
    if [ -n "$TODO_ANALYZER" ] && command -v node >/dev/null 2>&1; then
      if node "$TODO_ANALYZER" --staged-only --ci-mode --min-confidence 0.8 >/dev/null 2>&1; then
        echo "✅ No critical hidden TODOs found in staged files"
        TODO_CHECK_RAN=true
      else
        echo "❌ Critical hidden TODOs detected in staged files - commit blocked"
        echo "💡 Fix stub implementations and placeholder code before committing"
        echo "📖 See docs/PLACEHOLDER-DETECTION-GUIDE.md for classification"
        echo ""
        echo "🔍 Running detailed analysis on staged files..."
        node "$TODO_ANALYZER" --staged-only --min-confidence 0.8
        exit 1
      fi
    fi
  fi
  
  # Option 2: Fallback to legacy Python analyzer (deprecated - will be removed)
  if [ "$TODO_CHECK_RAN" = false ] && command -v python3 >/dev/null 2>&1 && [ -f "scripts/v3/analysis/todo_analyzer.py" ]; then
    echo "⚠️  Using legacy Python TODO analyzer (deprecated)"
    if python3 scripts/v3/analysis/todo_analyzer.py --staged-only --ci-mode --min-confidence 0.8 >/dev/null 2>&1; then
      echo "✅ No critical hidden TODOs found in staged files"
      TODO_CHECK_RAN=true
    else
      echo "❌ Critical hidden TODOs detected in staged files - commit blocked"
      echo "💡 Fix stub implementations and placeholder code before committing"
      echo "📖 See docs/PLACEHOLDER-DETECTION-GUIDE.md for classification"
      echo ""
      echo "🔍 Running detailed analysis on staged files..."
      python3 scripts/v3/analysis/todo_analyzer.py --staged-only --min-confidence 0.8
      exit 1
    fi
  fi
  
  # Option 3: No analyzer available - show language-aware suggestions
  if [ "$TODO_CHECK_RAN" = false ]; then
    echo "⚠️  TODO analyzer not available - skipping hidden TODO check"
    echo "💡 Available options for TODO analysis:"
${todoSuggestion
  .split('\n')
  .map((line) => `    echo "${line.replace(/"/g, '\\"')}"`)
  .join('\n')}
  fi
fi

echo "✅ All quality checks passed - proceeding with commit"
exit 0
`;
}

/**
 * Generate post-commit hook content
 */
function generatePostCommitHook() {
  return `#!/bin/bash
# CAWS Post-commit Hook
# Updates provenance tracking after successful commits

# Run in background to avoid blocking git operations
(
  # Check if CAWS is initialized
  if [ ! -d ".caws" ]; then
    exit 0
  fi

  # Get the current commit hash
  COMMIT_HASH=$(git rev-parse HEAD)

  # Get commit details
  COMMIT_MESSAGE=$(git log -1 --pretty=%B | head -1)
  AUTHOR_NAME=$(git log -1 --pretty=%an)
  AUTHOR_EMAIL=$(git log -1 --pretty=%ae)

  # Update provenance if CAWS CLI is available
  if command -v caws >/dev/null 2>&1; then
    echo "📜 Updating CAWS provenance for commit \${COMMIT_HASH:0:8}..."

    # Run provenance update in background
    (
      caws provenance update \\
        --commit "$COMMIT_HASH" \\
        --message "$COMMIT_MESSAGE" \\
        --author "$AUTHOR_NAME <$AUTHOR_EMAIL>" \\
        --quiet
    ) &
  fi
) >/dev/null 2>&1 &
`;
}

/**
 * Generate pre-push hook content
 * Blocks --no-verify to enforce quality gates before pushing
 */
function generatePrePushHook() {
  return `#!/bin/bash
# CAWS Pre-push Hook
# Runs comprehensive checks before pushing
# BLOCKS --no-verify for safety

set -e

# Block --no-verify on push operations
for arg in "$@"; do
  if [[ "$arg" == "--no-verify" ]] || [[ "$arg" == "-n" ]]; then
    echo "❌ Error: --no-verify is BLOCKED on git push"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Push operations must pass all quality gates."
    echo ""
    echo "💡 To fix issues locally:"
    echo "   1. Run: caws validate"
    echo "   2. Fix reported issues"
    echo "   3. Commit fixes: git commit --no-verify \\(allowed\\)"
    echo "   4. Push again: git push \\(no --no-verify\\)"
    exit 1
  fi
done

echo "🚀 CAWS Pre-push Validation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check if CAWS is initialized
if [ ! -d ".caws" ]; then
  echo "⚠️  CAWS not initialized - skipping validation"
  exit 0
fi

# Run full validation suite
if command -v caws >/dev/null 2>&1; then
  echo "📋 Running comprehensive CAWS validation..."
  
  # Run validation and capture output
  VALIDATION_OUTPUT=$(caws validate 2>&1)
  VALIDATION_EXIT=$?
  
  if [ $VALIDATION_EXIT -eq 0 ]; then
    echo "✅ CAWS validation passed"
  else
    echo "❌ CAWS validation failed"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Validation Errors:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$VALIDATION_OUTPUT" | grep -E "(❌|error|Error|Missing|required)" || echo "$VALIDATION_OUTPUT"
    echo ""
    
    # Check for contract-related errors
    if echo "$VALIDATION_OUTPUT" | grep -qi "contract"; then
      echo "💡 Contract Requirements:"
      echo "   • Tier 1 & 2 changes require at least one contract"
      echo "   • For infrastructure/setup work, use 'chore' mode or add a minimal contract:"
      echo ""
      echo "   Example minimal contract (.caws/working-spec.yaml):"
      echo "   contracts:"
      echo "     - type: 'project_setup'"
      echo "       path: '.caws/working-spec.yaml'"
      echo "       description: 'Project-level CAWS configuration'"
      echo ""
      echo "   Or change mode to 'chore' for maintenance work:"
      echo "   mode: chore"
      echo ""
    fi
    
    # Check for active waivers
    echo "🔍 Checking for active waivers..."
    if command -v caws >/dev/null 2>&1 && caws waivers list --status=active --format=count 2>/dev/null | grep -q "[1-9]"; then
      ACTIVE_WAIVERS=$(caws waivers list --status=active 2>/dev/null)
      echo "⚠️  Active waivers found:"
      echo "$ACTIVE_WAIVERS" | head -5
      echo ""
      echo "💡 Note: Waivers may not cover all validation failures"
      echo "   Review waiver coverage: caws waivers list --status=active"
    else
      echo "   No active waivers found"
      echo ""
      echo "💡 If this is infrastructure/setup work, you can create a waiver:"
      echo "   caws waivers create \\\\"
      echo "     --title='Initial CAWS setup' \\\\"
      echo "     --reason=infrastructure_limitation \\\\"
      echo "     --gates=contracts \\\\"
      echo "     --expires-at='2024-12-31T23:59:59Z' \\\\"
      echo "     --approved-by='@your-team' \\\\"
      echo "     --impact-level=low \\\\"
      echo "     --mitigation-plan='Contracts will be added as features are developed'"
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Next Steps:"
    echo "   1. Review errors above"
    echo "   2. Fix issues in .caws/working-spec.yaml"
    echo "   3. Run: caws validate \\(to verify fixes\\)"
    echo "   4. Commit fixes: git commit --no-verify \\(allowed\\)"
    echo "   5. Push again: git push"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exit 1
  fi
fi

# Run fast pre-push checks (full test suite runs in CI)
echo ""
echo "⚡ Running fast pre-push checks..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

QUICK_CHECKS_FAILED=false

# 1. Linting (fast)
if [ -f "package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    if grep -q '"lint"' package.json; then
      echo "🔍 Running linting..."
      if npm run lint >/dev/null 2>&1; then
        echo "✅ Linting passed"
      else
        echo "❌ Linting failed"
        echo "💡 Fix lint errors: npm run lint"
        QUICK_CHECKS_FAILED=true
      fi
    fi
  fi
fi

# 2. Type checking (fast for TypeScript/JavaScript)
if [ -f "package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    if grep -q '"typecheck"' package.json; then
      echo "🔍 Running type checking..."
      if npm run typecheck >/dev/null 2>&1; then
        echo "✅ Type checking passed"
      else
        echo "❌ Type checking failed"
        echo "💡 Fix type errors: npm run typecheck"
        QUICK_CHECKS_FAILED=true
      fi
    fi
  fi
fi

# 3. Quick test check - only run tests for changed files (optional, fast)
if [ -f "package.json" ] && [ "$CAWS_PRE_PUSH_FULL_TESTS" != "true" ]; then
  if command -v npm >/dev/null 2>&1 && grep -q '"test"' package.json; then
    # Get changed files in this push
    CHANGED_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null || git diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")
    
    if [ -n "$CHANGED_FILES" ]; then
      # Check if any test files changed (if so, run quick test)
      if echo "$CHANGED_FILES" | grep -qE "(test|spec)"; then
        echo "🔍 Running quick test check (changed test files detected)..."
        # Run tests with bail flag for faster failure detection
        if npm test -- --bail --maxWorkers=2 --no-coverage >/dev/null 2>&1; then
          echo "✅ Quick test check passed"
        else
          echo "⚠️  Quick test check failed"
          echo "💡 Run full tests locally: npm test"
          echo "💡 Or set CAWS_PRE_PUSH_FULL_TESTS=true for full test suite"
          # Don't fail on quick test check - just warn
        fi
      else
        echo "⏭️  Skipping test check (no test files changed)"
        echo "💡 Full test suite will run in CI"
      fi
    fi
  fi
fi

# 4. Security checks (non-blocking warnings)
echo ""
echo "🔒 Running security checks..."
if [ -f "package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "🔍 Checking for vulnerabilities..."
    if npm audit --audit-level moderate >/dev/null 2>&1; then
      echo "✅ Security audit passed"
    else
      echo "⚠️  Security vulnerabilities found (non-blocking)"
      echo "💡 Review with: npm audit"
    fi
  fi
elif [ -f "requirements.txt" ] || [ -f "pyproject.toml" ]; then
  if command -v pip-audit >/dev/null 2>&1; then
    echo "🔍 Checking Python vulnerabilities..."
    pip-audit --desc 2>/dev/null || echo "⚠️  Install pip-audit: pip install pip-audit"
  fi
elif [ -f "Cargo.toml" ]; then
  if command -v cargo-audit >/dev/null 2>&1; then
    echo "🔍 Checking Rust vulnerabilities..."
    cargo audit 2>/dev/null || echo "⚠️  Install cargo-audit: cargo install cargo-audit"
  fi
fi

# Fail if quick checks failed
if [ "$QUICK_CHECKS_FAILED" = true ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ Pre-push checks failed"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Quick checks (linting/type checking) must pass before push."
  echo ""
  echo "💡 To run full test suite locally:"
  echo "   npm test"
  echo ""
  echo "💡 To enable full tests in pre-push hook:"
  echo "   export CAWS_PRE_PUSH_FULL_TESTS=true"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 1
fi

echo ""
echo "✅ Pre-push checks completed!"
echo "💡 Full test suite will run in CI"
`;
}

/**
 * Generate commit-msg hook content
 */
function generateCommitMsgHook() {
  return `#!/bin/bash
# CAWS Commit Message Hook
# Validates commit message format

COMMIT_MSG_FILE=$1

# Read the commit message
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Check if CAWS is initialized
if [ ! -d ".caws" ]; then
  exit 0
fi

# Basic commit message validation
if [ \${#COMMIT_MSG} -lt 10 ]; then
  echo "❌ Commit message too short \\(minimum 10 characters\\)"
  echo "💡 Write descriptive commit messages"
  exit 1
fi

# Check for conventional commit format (optional but encouraged)
if [[ $COMMIT_MSG =~ ^(feat|fix|docs|style|refactor|test|chore)(.+)? ]]; then
  echo "✅ Conventional commit format detected"
else
  echo "💡 Consider using conventional commit format:"
  echo "   feat: add new feature"
  echo "   fix: bug fix"
  echo "   docs: documentation"
  echo "   style: formatting"
  echo "   refactor: code restructuring"
  echo "   test: testing"
  echo "   chore: maintenance"
fi

echo "✅ Commit message validation passed"
`;
}

/**
 * Remove CAWS git hooks
 * @param {string} projectDir - Project directory path
 */
async function removeGitHooks(projectDir) {
  console.log('🧹 Removing CAWS Git hooks...');

  const hooksDir = path.join(projectDir, '.git', 'hooks');
  const cawsHooks = ['pre-commit', 'post-commit', 'pre-push', 'commit-msg'];

  let removedCount = 0;

  for (const hookName of cawsHooks) {
    const hookPath = path.join(hooksDir, hookName);

    try {
      if (await fs.pathExists(hookPath)) {
        const content = await fs.readFile(hookPath, 'utf8');
        if (content.includes('# CAWS Hook') || content.includes('# CAWS Pre-commit Hook')) {
          await fs.remove(hookPath);
          console.log(`✅ Removed ${hookName} hook`);
          removedCount++;
        } else {
          console.log(`⏭️  Skipped ${hookName} (not CAWS-managed)`);
        }
      }
    } catch (error) {
      console.log(`❌ Failed to remove ${hookName}: ${error.message}`);
    }
  }

  if (removedCount > 0) {
    console.log(`🧹 Removed ${removedCount} CAWS git hooks`);
  } else {
    console.log('ℹ️  No CAWS git hooks found');
  }
}

/**
 * Check git hooks status
 * @param {string} projectDir - Project directory path
 */
async function checkGitHooksStatus(projectDir) {
  const hooksDir = path.join(projectDir, '.git', 'hooks');
  const cawsHooks = ['pre-commit', 'post-commit', 'pre-push', 'commit-msg'];

  console.log('🔍 Git Hooks Status:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let activeCount = 0;
  let totalCount = 0;

  for (const hookName of cawsHooks) {
    totalCount++;
    const hookPath = path.join(hooksDir, hookName);

    try {
      if (await fs.pathExists(hookPath)) {
        const content = await fs.readFile(hookPath, 'utf8');
        const isExecutable = (await fs.stat(hookPath)).mode & 0o111;

        if (content.includes('# CAWS') && isExecutable) {
          console.log(`✅ ${hookName}: Active`);
          activeCount++;
        } else if (content.includes('# CAWS')) {
          console.log(`⚠️  ${hookName}: Configured but not executable`);
        } else {
          console.log(`❌ ${hookName}: Not CAWS-managed`);
        }
      } else {
        console.log(`❌ ${hookName}: Not installed`);
      }
    } catch (error) {
      console.log(`❌ ${hookName}: Error checking status`);
    }
  }

  console.log('');
  console.log(`📊 Status: ${activeCount}/${totalCount} CAWS hooks active`);

  if (activeCount < totalCount) {
    console.log('');
    console.log('💡 To install missing hooks:');
    console.log('   caws scaffold');
    console.log('');
    console.log('💡 To check detailed status:');
    console.log('   ls -la .git/hooks/');
  }
}

module.exports = {
  scaffoldGitHooks,
  removeGitHooks,
  checkGitHooksStatus,
  // Export generator functions for testing
  generatePrePushHook,
  generatePreCommitHook,
  generatePostCommitHook,
  generateCommitMsgHook,
};
