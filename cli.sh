#!/bin/bash
# CAWS CLI Wrapper Script
# This script builds and runs the CAWS CLI with proper argument passing

set -e

# Build the CLI if needed
cd packages/caws-cli
npm run build
cd ../..

# Run the CLI with all arguments
exec node packages/caws-cli/dist/index.js "$@"
