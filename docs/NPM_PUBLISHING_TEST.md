# npm Publishing Verification

**Author**: @darianrosebrook  
**Date**: October 10, 2025 (revised 2026-05-28 for tag-driven release reality)  
**Purpose**: Verify npm publishing setup before production releases

> **Canonical release doc**: `docs/release-procedure.md` — if anything here
> conflicts, the release-procedure doc wins. This file covers pre-publish
> verification steps and local smoke testing; it does not duplicate the full
> release procedure.

---

## Pre-Publishing Checklist

Before publishing CAWS to npm, verify these requirements:

### 1. npm Account Setup

- [ ] npm account created at [npmjs.com](https://www.npmjs.com)
- [ ] 2FA enabled on npm account (required for publishing interactively)
- [ ] Member of `@paths.design` organization on npm (or owner)
- [ ] Granular npm token created with publish permissions and 2FA-bypass enabled

### 2. GitHub Environment Configured

- [ ] `NPM_TOKEN` secret added to the **Release** GitHub environment (not just repository secrets)
- [ ] Token type: granular npm token with **bypass 2FA for write actions** enabled
- [ ] Token can publish to `@paths.design` scope

> **Auth mechanism**: CI publishes via `NPM_TOKEN` stored in the `Release`
> GitHub environment. The workflow uses `npm publish --provenance`.
> OIDC trusted-publisher is a planned future enhancement — it is NOT the
> current mechanism. The `id-token: write` permission in the workflow is
> retained for that future migration but has no effect on the current
> NPM_TOKEN-based publish.

### 3. Package Configuration

- [ ] `package.json` has correct package name: `@paths.design/caws-cli`
- [ ] `publishConfig.access` set to `"public"`
- [ ] `.npmignore` or `files` array configured
- [ ] LICENSE file exists (MIT)
- [ ] README.md exists and is current

### 4. Tag-Driven Release Pre-flight

- [ ] `packages/caws-cli/package.json` version matches the intended tag (e.g., `11.1.6`)
- [ ] `packages/caws-cli/CHANGELOG.md` has a section for that version
- [ ] Fresh-install smoke passes locally (`npm run smoke:fresh-install -w @paths.design/caws-cli`)

> There is no `.releaserc.json` and semantic-release is not used. CI does not
> bump versions or generate changelogs. The maintainer does both manually
> before tagging.

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

> **Note**: interactive `npm login` and `NPM_TOKEN` env-var auth are different
> identities to the registry. If your account has 2FA enabled, interactive
> `npm publish` still requires an OTP (`--otp=<code>`). Granular npm tokens
> with bypass-2FA work for `NPM_TOKEN`-based CI publishes but do not carry
> over to `npm whoami` sessions. If you see `EOTP` with a valid `npm whoami`,
> the token has 2FA-bypass and the session does not — use the token via env
> (see Step 7 below).

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

### Step 7: Local Token-Based Publish Test (Optional)

```bash
# Test token-based auth locally (mirrors how CI publishes)
export NPM_TOKEN="npm_xxxxx"
export NODE_AUTH_TOKEN="${NPM_TOKEN}"
npm whoami
# Verifies the token is valid

# If you need to publish manually to a beta tag:
npm publish --tag beta --provenance
npm view @paths.design/caws-cli@beta

# If successful, promote to latest (only after confirming quality)
# npm dist-tag add @paths.design/caws-cli@11.1.6 latest
```

---

## CI/CD Testing

### Step 8: Test the Release Workflow via a Tag Push

The Release workflow is **tag-driven**. Pushing to `main` or any branch does
**not** trigger a release. There is no `push: branches` trigger in
`.github/workflows/release.yml`.

To observe the workflow running without completing a real publish, push a
refused-tag-pattern. The workflow fires on `caws-kernel-v*` and bare `v*`
tags, immediately refuses them, deletes the tag from origin, and exits
non-zero. This lets you confirm the workflow runs and the auth plumbing is
wired correctly:

```bash
# Push a refused-pattern tag to exercise the workflow.
# The workflow will fire, emit a structured refusal, delete the tag, and exit
# non-zero. No npm publish occurs. The tag will not remain on origin.
git tag caws-kernel-v0.0.0-test -m "Workflow smoke: refused-pattern test"
git push origin caws-kernel-v0.0.0-test

# Monitor workflow in GitHub Actions:
# https://github.com/Paths-Design/coding-agent-working-standard/actions
# Expect: workflow runs, logs "refused", tag is auto-deleted from origin.

# To trigger an actual candidate run (which will also refuse if package.json
# version doesn't match or CHANGELOG section is missing), push a
# caws-cli-v* tag matching a version bump you've already committed:
#
#   git tag caws-cli-v11.1.6 -m "Release caws-cli 11.1.6"
#   git push origin caws-cli-v11.1.6
#
# See docs/release-procedure.md for the full pre-tag checklist before doing this.
```

### Step 9: Verify NPM_TOKEN Auth in the Release Environment

Check the workflow runs with valid credentials:

- [ ] `NPM_TOKEN` is present in the **Release** GitHub environment (not just repository secrets)
- [ ] The token is a granular npm token with **bypass 2FA for write actions** enabled
- [ ] The token can publish to the `@paths.design` scope

Check workflow logs for:

```
✓ gh api ref read confirmed.
step.end ... step=npm_publish ... ok=true
registry.verify.ok
release.success
```

> **Not** "Setup NPM authentication with OIDC" — the current mechanism is
> NPM_TOKEN, not OIDC. If you see OIDC steps in logs, the workflow has been
> updated; consult `docs/release-procedure.md`.

---

## Troubleshooting

### Error: `ENEEDAUTH`

```bash
# Cause: npm token not configured
# Fix: Set NPM_TOKEN in the Release GitHub environment (not just repo secrets)

# Test locally:
export NPM_TOKEN="npm_xxxxx"
npm whoami
```

### Error: `E403 Forbidden`

```bash
# Cause: Token lacks permissions for @paths.design scope
# Fix: Verify organization membership

npm org ls @paths.design

# Or recreate token with correct permissions (Read and write for @paths.design)
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
# Fix: Use a granular npm token with "bypass 2FA for write actions" enabled.
# Interactive session 2FA bypass does not transfer to token-based auth.
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

## Production Release Checklist

Before pushing the release tag:

- [ ] All pre-publish steps above passed
- [ ] npm authentication verified (NPM_TOKEN in Release environment)
- [ ] Package builds successfully
- [ ] CLI works from tarball
- [ ] `packages/caws-cli/package.json` version bumped manually (e.g., `11.1.6`)
- [ ] `packages/caws-cli/CHANGELOG.md` section authored for the version
- [ ] Fresh-install smoke passes: `npm run smoke:fresh-install -w @paths.design/caws-cli`
- [ ] Security audit clean
- [ ] LICENSE file present
- [ ] README.md current

### Trigger a Release

Releases are triggered by pushing a `caws-cli-vX.Y.Z` tag. Branch pushes
**never** publish. Full procedure in `docs/release-procedure.md`.

```bash
# After committing the version bump and CHANGELOG section:
git tag caws-cli-v11.1.6 -m "Release caws-cli 11.1.6"
git push origin caws-cli-v11.1.6

# Monitor at:
# https://github.com/Paths-Design/coding-agent-working-standard/actions
gh run watch
```

### Verify Published Package

```bash
# Wait 2-5 minutes for npm CDN propagation

# Verify package is live
npm view @paths.design/caws-cli@11.1.6 version

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

After a successful release:

1. **Monitor Initial Adoption**
   - Check download stats after 24h
   - Monitor GitHub issues for problems
   - Watch CI/CD for any failures

2. **Update Documentation**
   - Update README badges if needed
   - Document any issues encountered

3. **Plan Next Release**
   - Set up monitoring for download trends
   - Schedule regular dependency updates
   - Plan feature releases

---

## Rollback Plan

If a release has critical issues:

```bash
# Option 1: Deprecate (preferred)
npm deprecate @paths.design/caws-cli@11.1.6 "Issue found, wait for 11.1.7"

# Option 2: Unpublish (only if <72 hours and no downstream dependents)
npm unpublish @paths.design/caws-cli@11.1.6

# Option 3: Publish hotfix
# Bump to 11.1.7, author CHANGELOG, commit, tag caws-cli-v11.1.7, push tag.
# See docs/release-procedure.md § Failure recovery.
```

---

## Success Criteria

A release is successful when:

- Package published to npm with the correct version
- Installation works globally: `npm install -g @paths.design/caws-cli`
- CLI commands execute correctly
- Provenance attestation present (`npm audit signatures`)
- No critical security vulnerabilities
- Bundle size < 5 MB
- README displays correctly on npmjs.com
- GitHub Release created with CHANGELOG section as body
- All CI workflow steps green

---

## Resources

- **Release Procedure** (canonical): `docs/release-procedure.md`
- **npm Publishing Docs**: https://docs.npmjs.com/cli/v10/commands/npm-publish
- **SLSA Provenance**: https://slsa.dev/provenance/

---

## Support

Questions about publishing?

- **Email**: hello@paths.design
- **GitHub Issues**: [Report issue](https://github.com/Paths-Design/coding-agent-working-standard/issues)

---

**Status**: Tag-driven release procedure in effect as of v11.1.4+1  
**See**: `docs/release-procedure.md` for the full step-by-step procedure
