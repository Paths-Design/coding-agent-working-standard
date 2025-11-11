#!/bin/bash
# Manual Release Script for CAWS Packages
# Run this from the monorepo root

set -e

echo "🚀 Manual CAWS Package Release"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if logged into npm (bypass workspace restrictions)
echo "Checking npm authentication..."
if ! npm whoami --workspaces=false &>/dev/null; then
  echo -e "${RED}❌ Not logged into npm.${NC}"
  echo -e "${YELLOW}Run: npm login --workspaces=false${NC}"
  echo -e "${YELLOW}Or: npm login --no-workspaces${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Logged in as: $(npm whoami --workspaces=false)${NC}"
echo ""

# Function to release a package
release_package() {
  local pkg_path=$1
  local pkg_name=$2
  local current_version=$3
  
  echo -e "${YELLOW}📦 Releasing ${pkg_name}@${current_version}...${NC}"
  
  cd "$pkg_path"
  
  # Build the package
  echo "  Building package..."
  npm run build
  
  # Publish to npm
  echo "  Publishing to npm..."
  npm publish --access public
  
  # Create git tag
  echo "  Creating git tag..."
  local tag_name="${pkg_name/@paths.design\//}-v${current_version}"
  tag_name=$(echo "$tag_name" | tr '/' '-')
  cd ../..
  git tag -a "$tag_name" -m "chore(release): ${pkg_name}@${current_version}"
  
  echo -e "${GREEN}✅ Released ${pkg_name}@${current_version}${NC}"
  echo ""
}

# Release packages in order (dependencies first)
echo "Releasing packages..."
echo ""

# 1. caws-types (no dependencies)
release_package "packages/caws-types" "@paths.design/caws-types" "1.0.0"

# 2. quality-gates (depends on caws-types)
release_package "packages/quality-gates" "@paths.design/quality-gates" "1.0.1"

# 3. caws-cli (depends on quality-gates)
release_package "packages/caws-cli" "@paths.design/caws-cli" "6.0.0"

# 4. caws-mcp-server (depends on caws-cli)
release_package "packages/caws-mcp-server" "@paths.design/caws-mcp-server" "1.1.2"

echo -e "${GREEN}🎉 All packages released successfully!${NC}"
echo ""
echo "Next steps:"
echo "  1. Push tags: git push --tags"
echo "  2. Push commits: git push origin main"

