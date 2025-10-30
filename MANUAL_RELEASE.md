# Manual Release Guide

When semantic-release isn't detecting changes correctly, use the manual release script.

## Quick Release

```bash
# Bump minor version (5.0.1 -> 5.1.0)
node scripts/manual-release.mjs minor

# Or patch (5.0.1 -> 5.0.2)
node scripts/manual-release.mjs patch

# Or major (5.0.1 -> 6.0.0)
node scripts/manual-release.mjs major
```

## What It Does

1. Bumps version in `packages/caws-cli/package.json`
2. Builds the package
3. Publishes to npm
4. Creates git tag
5. Commits the version bump

## After Running

```bash
# Push commits and tags
git push origin main
git push origin v5.1.0  # Replace with actual version
```

## Prerequisites

- NPM_TOKEN or NODE_AUTH_TOKEN environment variable set
- npm login or token configured
- Build passes (`npm run build`)

## Troubleshooting

If publish fails:
- Check npm authentication: `npm whoami`
- Verify token has publish permissions
- Check package name matches: `@paths.design/caws-cli`
