# Testing npm Publishing

**Author**: @darianrosebrook  
**Date**: October 10, 2025  
**Purpose**: Verify npm publishing setup before first production release

---

## Pre-Publishing Checklist

Before attempting to publish CAWS to npm, verify these requirements:

### 1. npm Account Setup

- [ ] npm account created at [npmjs.com](https://www.npmjs.com)
- [ ] 2FA enabled on npm account (required for publishing)
- [ ] Member of `@paths.design` organization on npm (or owner)
- [ ] Automation token created with publish permissions

### 2. GitHub Secrets Configured

- [ ] `NPM_TOKEN` secret added to GitHub repository
- [ ] Token has correct permissions (`Automation` type)
- [ ] Token can publish to `@paths.design` scope

### 3. Package Configuration

- [ ] `package.json` has correct package name: `@paths.design/caws-cli`
- [ ] `publishConfig.access` set to `"public"`
- [ ] `.npmignore` or `files` array configured
- [ ] LICENSE file exists (MIT)
- [ ] README.md exists and is current

### 4. semantic-release Configuration

- [ ] `.releaserc.json` has `npmPublish: true`
- [ ] `provenance: true` for SLSA attestation
- [ ] `pkgRoot` points to correct package: `packages/caws-cli`

---

## Testing Procedure

### Step 1: Verify npm Authentication

```bash
# Login to npm (local testing)
npm login

# Verify you're logged in
npm whoami
# Should output your npm username

# Check organization membership
npm org ls @paths.design
# Should list you as a member/owner
```

### Step 2: Verify Package Scope Access

```bash
# Check if scope exists and you have access
npm access ls-collaborators @paths.design/caws-cli
# If package doesn't exist yet, this will error (expected)

# Check your permissions on the scope
npm org ls @paths.design <your-username>
# Should show 'owner' or 'admin'
```

### Step 3: Test Local Build

```bash
# Build the package
cd packages/caws-cli
npm run build

# Verify build output
ls -lh dist/
ls -lh dist-bundle/

# Test the built CLI
node dist/index.js --version
node dist/index.js --help
```

### Step 4: Test Package Contents

```bash
# Pack the package (creates tarball without publishing)
npm pack

# Extract and inspect contents
tar -tzf paths.design-caws-cli-*.tgz

# Verify critical files are included:
# - package/dist/
# - package/templates/
# - package/README.md
# - package/LICENSE

# Check package size
ls -lh paths.design-caws-cli-*.tgz
# Should be around 2-3 MB
```

### Step 5: Test Installation from Tarball

```bash
# Install from local tarball
npm install -g ./paths.design-caws-cli-*.tgz

# Verify CLI works
caws --version
caws --help
caws init test-project

# Cleanup
npm uninstall -g @paths.design/caws-cli
rm -rf test-project
```

### Step 6: Dry-Run Publish (Recommended)

```bash
# Simulate publishing without actually publishing
npm publish --dry-run

# Check output for warnings or errors
# Verify files that would be published
```

### Step 7: Publish to Test Tag (Optional but Recommended)

```bash
# Publish with 'beta' tag instead of 'latest'
# This allows testing without affecting production users
npm publish --tag beta

# Verify it was published
npm view @paths.design/caws-cli@beta

# Test installation
npm install -g @paths.design/caws-cli@beta
caws --version

# If successful, promote to latest
npm dist-tag add @paths.design/caws-cli@3.4.0 latest

# Or if there are issues, deprecate
npm deprecate @paths.design/caws-cli@3.4.0 "Test release, use production version"
```

---

## CI/CD Testing

### Step 8: Test GitHub Actions Workflow

```bash
# Make a test commit to trigger release workflow
git checkout -b test/release-workflow

# Make a minor change
echo "# Test Release" >> docs/test.md
git add docs/test.md
git commit -m "test: verify release workflow"

# Push to trigger workflow
git push origin test/release-workflow

# Monitor workflow in GitHub Actions
# https://github.com/Paths-Design/coding-agent-working-standard/actions
```

### Step 9: Verify OIDC Setup

The release workflow should:

- [ ] Authenticate with npm using OIDC
- [ ] Run security audit
- [ ] Run all tests
- [ ] Build packages
- [ ] Publish with provenance

Check workflow logs for:

```
✅ Setup NPM authentication with OIDC
✅ Verify NPM Authentication
✅ Release
```

---

## Troubleshooting

### Error: `ENEEDAUTH`

```bash
# Cause: npm token not configured
# Fix: Set NPM_TOKEN in GitHub secrets

# Test locally:
export NPM_TOKEN="npm_xxxxx"
npm whoami
```

### Error: `E403 Forbidden`

```bash
# Cause: Token lacks permissions for @paths.design scope
# Fix: Verify organization membership

npm org ls @paths.design

# Or recreate token with correct permissions
```

### Error: `E404 Not Found`

```bash
# Cause: Scope doesn't exist or you don't have access
# Fix: Create organization on npm first

# Go to: https://www.npmjs.com/org/create
# Name: paths.design
```

### Error: `EOTP`

```bash
# Cause: 2FA required for publishing
# Fix: Either:
# 1. Use automation token (recommended)
# 2. Or set 2FA to "Authorization only" (not "Authorization and writes")
```

### Warning: Large Package Size

```bash
# If package is >5 MB:

# Check what's included
npm pack
tar -tzf paths.design-caws-cli-*.tgz | head -20

# Add to .npmignore:
echo "tests/" >> .npmignore
echo "docs/" >> .npmignore
echo "*.test.js" >> .npmignore

# Or use files array in package.json:
{
  "files": [
    "dist/",
    "templates/",
    "README.md"
  ]
}
```

---

## First Production Release Checklist

Once all testing is complete:

- [ ] All tests in this document passed
- [ ] npm authentication verified
- [ ] Package builds successfully
- [ ] CLI works from tarball
- [ ] CI/CD workflow completes
- [ ] Provenance attestation included
- [ ] Security audit clean
- [ ] LICENSE file present
- [ ] README.md current
- [ ] CHANGELOG.md updated
- [ ] Version bumped (semantic-release handles this)

### Trigger First Release

```bash
# Merge to main with conventional commit
git checkout main
git pull origin main

# Make release commit
git commit --allow-empty -m "feat: initial public release

- CLI with all core commands
- MCP server for AI agents
- Comprehensive documentation
- Production-ready deployment

BREAKING CHANGE: First public release"

git push origin main

# Monitor release at:
# https://github.com/Paths-Design/coding-agent-working-standard/actions
```

### Verify Published Package

```bash
# Wait 2-5 minutes for npm CDN propagation

# Verify package is live
npm view @paths.design/caws-cli

# Test clean installation
docker run --rm -it node:22-alpine sh -c "
  npm install -g @paths.design/caws-cli &&
  caws --version &&
  echo 'Success!'
"

# Check provenance
npm audit signatures @paths.design/caws-cli

# Verify on npmjs.com
# https://www.npmjs.com/package/@paths.design/caws-cli
```

---

## Post-Release Actions

After successful first release:

1. **Announce Release**
   - Update README badges
   - Create GitHub Discussion
   - Tweet about release (if applicable)

2. **Monitor Initial Adoption**
   - Check download stats after 24h
   - Monitor GitHub issues for problems
   - Watch CI/CD for any failures

3. **Update Documentation**
   - Mark NPM_PUBLISHING_TEST.md as complete
   - Update DEPLOYMENT.md with actual experience
   - Document any issues encountered

4. **Plan Next Release**
   - Set up monitoring for download trends
   - Schedule regular dependency updates
   - Plan feature releases

---

## Rollback Plan

If first release has critical issues:

```bash
# Option 1: Deprecate (preferred)
npm deprecate @paths.design/caws-cli@3.4.0 "Initial release has issues, wait for 3.4.1"

# Option 2: Unpublish (only if <72 hours)
npm unpublish @paths.design/caws-cli@3.4.0

# Option 3: Publish hotfix
# See docs/ROLLBACK.md for detailed procedures
```

---

## Success Criteria

First release is successful when:

- ✅ Package published to npm
- ✅ Installation works globally: `npm install -g @paths.design/caws-cli`
- ✅ CLI commands execute correctly
- ✅ Provenance attestation present
- ✅ No critical security vulnerabilities
- ✅ Bundle size < 5 MB
- ✅ README displays correctly on npmjs.com
- ✅ All CI/CD checks passing

---

## Resources

- **npm Publishing Docs**: https://docs.npmjs.com/cli/v10/commands/npm-publish
- **semantic-release**: https://semantic-release.gitbook.io/
- **SLSA Provenance**: https://slsa.dev/provenance/
- **Deployment Guide**: `docs/DEPLOYMENT.md`
- **Rollback Guide**: `docs/ROLLBACK.md`

---

## Support

Questions about publishing?

- **Email**: hello@paths.design
- **GitHub Issues**: [Report issue](https://github.com/Paths-Design/coding-agent-working-standard/issues)

---

**Status**: Ready for first publish test  
**Next Step**: Follow Step 1 above to begin verification
