# Multi-Package Release Strategy

CAWS monorepo contains multiple publishable packages that need independent versioning and releases:

- `@paths.design/caws-cli` - CLI tools
- `@paths.design/caws-mcp-server` - MCP server
- `@paths.design/quality-gates` - Quality gates package

## Current Approach

**Single-Package Release (CLI Only)**

The current `.releaserc.json` is configured to release only the CLI package. This works for CLI-focused changes but doesn't handle MCP server or quality-gates releases automatically.

**Multi-Package Release Script**

A script-based approach (`scripts/multi-package-release.mjs`) has been created to handle multiple packages:

1. Detects which packages have changes
2. Creates package-specific semantic-release configs
3. Runs semantic-release for each changed package independently
4. Avoids conflicts from multiple npm plugins

## Usage

### Automatic (CI/CD)

The GitHub Actions workflow (`/.github/workflows/release.yml`) automatically uses the multi-package script:

```yaml
- name: Release
  run: |
    if [ -f "scripts/multi-package-release.mjs" ]; then
      node scripts/multi-package-release.mjs
    else
      npx semantic-release
    fi
```

### Manual Release

```bash
# Release all changed packages
node scripts/multi-package-release.mjs

# Or release specific package manually
cd packages/caws-mcp-server
npm version patch
npm publish
```

## Commit Message Format

Use scoped commit messages to target specific packages:

```bash
# CLI changes
git commit -m "feat(cli): add new command"

# MCP server changes
git commit -m "feat(mcp-server): add new tool"

# Quality gates changes
git commit -m "feat(quality-gates): add new gate"
```

## Package-Specific Release Rules

Each package is released based on commit scope:

| Scope | Package | Release Type |
|-------|---------|--------------|
| `cli` | `@paths.design/caws-cli` | Minor (feat) / Patch (fix) |
| `mcp-server` | `@paths.design/caws-mcp-server` | Minor (feat) / Patch (fix) |
| `quality-gates` | `@paths.design/quality-gates` | Minor (feat) / Patch (fix) |

## Future Improvements

Consider migrating to:
- **Changesets** - Better monorepo support, explicit versioning
- **semantic-release-monorepo** - Once compatible with semantic-release@25
- **Lerna** - Full monorepo management with independent versioning

## Manual Release Process

If automatic release fails, you can manually release packages:

```bash
# 1. Update version
cd packages/caws-mcp-server
npm version patch  # or minor, major

# 2. Build (if needed)
npm run build

# 3. Publish
npm publish

# 4. Create git tag
git tag @paths.design/caws-mcp-server-v$(node -p "require('./package.json').version")
git push origin @paths.design/caws-mcp-server-v$(node -p "require('./package.json').version")
```

## Troubleshooting

**Issue**: Multiple packages trying to publish simultaneously
**Solution**: Use the multi-package script which releases packages sequentially

**Issue**: Wrong package version bumped
**Solution**: Check commit scope matches package name

**Issue**: Package not detected as changed
**Solution**: Ensure commits modify files in the package directory

