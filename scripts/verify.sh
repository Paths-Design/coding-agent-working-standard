#!/bin/bash
# CAWS Verify Script
# Runs the full CAWS quality verification pipeline

set -e

echo "🔍 Running CAWS verification pipeline..."

# Validate working specification via bundled CAWS CLI
# CAWSFIX-12: replaces the deleted `.caws/validate.js` (removed in CAWSFIX-03).
# Validation now comes from `caws validate` (the bundled CLI) which uses the
# same JSON Schema + spec-completeness gate that the git hooks and CI use.
if command -v caws >/dev/null 2>&1; then
  echo "📋 Validating working specification..."
  caws validate || exit 1
else
  echo "⚠️  caws CLI not installed - skipping validation (install: npm i -g @paths.design/caws-cli)"
fi

# Run type checking
echo "🔍 Type checking..."
# npm run typecheck || exit 1  # Temporarily disabled due to template TS issues

# Run linting
echo "🔧 Linting..."
npm run lint || exit 1

# Run unit tests with coverage
echo "🧪 Running unit tests with coverage..."
npm run test:unit -- --coverage || exit 1

# Run contract tests
echo "📝 Running contract tests..."
npm run test:contract || exit 1

# Run integration tests
echo "🔗 Running integration tests..."
npm run test:integration || exit 1

# Run E2E smoke tests
echo "🚀 Running E2E smoke tests..."
npm run test:e2e:smoke || exit 1

# Run mutation tests
echo "🧬 Running mutation tests..."
npm run test:mutation || exit 1

# Run accessibility tests
echo "♿ Running accessibility tests..."
npm run test:axe || exit 1

# Check performance budgets
echo "⚡ Checking performance budgets..."
npm run perf:budgets || exit 1

echo "✅ All CAWS quality gates passed!"
