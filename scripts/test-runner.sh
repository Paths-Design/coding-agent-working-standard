#!/bin/bash
# CAWS Test Runner
# Provides different test execution strategies for different scenarios
# @author @darianrosebrook

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
MODE="full"
PACKAGE=""
QUIET=false
WATCH=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --package)
      PACKAGE="$2"
      shift 2
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    --watch)
      WATCH=true
      shift
      ;;
    --help)
      echo "CAWS Test Runner"
      echo ""
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --mode <mode>     Test mode: fast, unit, integration, e2e, full (default: full)"
      echo "  --package <pkg>   Run tests for specific package (e.g., caws-cli)"
      echo "  --quiet          Suppress output except errors"
      echo "  --watch          Run tests in watch mode"
      echo "  --help           Show this help"
      echo ""
      echo "Examples:"
      echo "  $0 --mode fast                    # Run fast tests only"
      echo "  $0 --package caws-cli             # Run CLI package tests"
      echo "  $0 --mode unit --quiet            # Run unit tests quietly"
      echo "  $0 --watch                        # Run tests in watch mode"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Helper function for output
log() {
  if [[ "$QUIET" == "false" ]]; then
    echo -e "${BLUE}$1${NC}"
  fi
}

error() {
  echo -e "${RED}❌ $1${NC}" >&2
}

success() {
  if [[ "$QUIET" == "false" ]]; then
    echo -e "${GREEN}✅ $1${NC}"
  fi
}

warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

# Check if we're in the right directory
if [[ ! -f "package.json" ]]; then
  error "Not in project root directory"
  exit 1
fi

# Check if npm is available
if ! command -v npm &> /dev/null; then
  error "npm not found"
  exit 1
fi

# Function to run tests for a specific package
run_package_tests() {
  local pkg="$1"
  local test_mode="$2"
  
  if [[ ! -d "packages/$pkg" ]]; then
    error "Package packages/$pkg not found"
    return 1
  fi
  
  log "Running tests for package: $pkg"
  
  cd "packages/$pkg"
  
  case "$test_mode" in
    "fast")
      if [[ -f "package.json" ]] && grep -q "test:unit" package.json; then
        npm run test:unit --silent
      else
        npm test --silent
      fi
      ;;
    "unit")
      npm run test:unit --silent
      ;;
    "integration")
      if grep -q "test:integration" package.json; then
        npm run test:integration --silent
      else
        warning "No integration tests found for $pkg"
      fi
      ;;
    "e2e")
      if grep -q "test:e2e" package.json; then
        npm run test:e2e:smoke --silent
      else
        warning "No E2E tests found for $pkg"
      fi
      ;;
    "full")
      npm test --silent
      ;;
    *)
      error "Unknown test mode: $test_mode"
      return 1
      ;;
  esac
  
  cd ../..
}

# Function to run tests in watch mode
run_watch_tests() {
  log "Running tests in watch mode..."
  
  if [[ -n "$PACKAGE" ]]; then
    cd "packages/$PACKAGE"
    npm run test:watch
    cd ../..
  else
    npm run test:watch
  fi
}

# Main execution
main() {
  log "🧪 CAWS Test Runner - Mode: $MODE"
  
  # Handle watch mode
  if [[ "$WATCH" == "true" ]]; then
    run_watch_tests
    return $?
  fi
  
  # Handle package-specific tests
  if [[ -n "$PACKAGE" ]]; then
    run_package_tests "$PACKAGE" "$MODE"
    return $?
  fi
  
  # Handle different test modes
  case "$MODE" in
    "fast")
      log "Running fast tests (unit tests only)..."
      if [[ -d "packages/caws-cli" ]]; then
        run_package_tests "caws-cli" "fast"
      else
        npm run test:unit --silent
      fi
      ;;
    "unit")
      log "Running unit tests..."
      npm run test:unit --silent
      ;;
    "integration")
      log "Running integration tests..."
      npm run test:integration --silent
      ;;
    "e2e")
      log "Running E2E smoke tests..."
      npm run test:e2e:smoke --silent
      ;;
    "full")
      log "Running full test suite..."
      npm test --silent
      ;;
    *)
      error "Unknown test mode: $MODE"
      echo "Available modes: fast, unit, integration, e2e, full"
      exit 1
      ;;
  esac
  
  success "Tests completed successfully"
}

# Run main function
main "$@"
