# OIDC Setup for Automated Publishing

This guide explains how to configure GitHub Actions OIDC (OpenID Connect) for automated NPM publishing of the CAWS CLI package.

## Overview

The CAWS CLI uses **semantic-release** with **GitHub Actions OIDC** for secure, automated publishing to NPM. This eliminates the need for NPM tokens while maintaining security.

## Prerequisites

- GitHub repository under the `Paths-Design` organization
- NPM organization: `@paths.design`
- Administrative access to the NPM organization

## Step 1: Configure NPM Trusted Publisher

1. **Go to NPM**: https://www.npmjs.com/settings/tokens
2. **Navigate to Trusted Publishers** (left sidebar)
3. **Click "Add trusted publisher"**
4. **Configure the publisher**:
   - **Publisher name**: `GitHub Actions`
   - **Repository**: `Paths-Design/coding-agent-working-standard`
   - **Package**: `@paths.design/caws-cli`
   - **Environment**: `release` (this will be created automatically)

## Step 2: GitHub Actions Workflow

The `.github/workflows/release.yml` workflow is already configured to:

- ✅ Trigger on pushes to `main`
- ✅ Use OIDC for NPM authentication
- ✅ Run tests and linting before publishing
- ✅ Use semantic-release for version management

## Step 3: Environment Configuration (Optional)

For enhanced security, you can create a GitHub Actions environment:

1. **Go to GitHub**: Settings → Environments → New environment
2. **Environment name**: `release`
3. **Configure protection rules** (optional):
   - Require approval for first-time contributors
   - Restrict to specific branches/tags

## How It Works

### Automated Release Process

1. **Push to main** with conventional commit message
2. **GitHub Actions triggers** the release workflow
3. **OIDC authentication** provides secure NPM access
4. **Tests run** and must pass
5. **semantic-release analyzes** commits for version bump
6. **Package publishes** to `@paths.design/caws-cli`
7. **GitHub release created** with changelog

### Commit Message Format

```bash
# Feature (minor release)
feat: add new CLI command

# Bug fix (patch release)
fix: resolve authentication issue

# Breaking change (major release)
feat!: change API response format

BREAKING CHANGE: The user object now returns additional fields
```

## Security Benefits

- ✅ **No stored secrets** in GitHub repository
- ✅ **Automatic token rotation** via OIDC
- ✅ **Scoped permissions** to specific packages
- ✅ **Audit trail** of all publishing actions
- ✅ **Environment protection** (optional but recommended)

## Troubleshooting

### Common Issues

**"No trusted publisher found"**
- Ensure the NPM trusted publisher is configured correctly
- Verify the repository name matches exactly
- Check that the package name is `@paths.design/caws-cli`

**"Permission denied"**
- Verify the GitHub Actions workflow has `id-token: write` permission
- Ensure the NPM organization has the trusted publisher configured

**"Package not found"**
- Check that the package name in `.releaserc.json` matches the NPM package
- Verify the package exists on NPM under `@paths.design`

### Debug Steps

1. **Check workflow logs** in GitHub Actions
2. **Verify OIDC token** is being generated
3. **Test NPM authentication** manually if needed
4. **Review semantic-release configuration**

## Manual Publishing (Fallback)

If automated publishing fails, you can publish manually:

```bash
# Login to NPM
npm login

# Build and publish
cd packages/caws-cli
npm run build
npm publish --access public
```

## Support

For issues with OIDC setup:
- Check GitHub Actions documentation
- Review NPM trusted publisher documentation
- Contact NPM support for organization-specific issues
