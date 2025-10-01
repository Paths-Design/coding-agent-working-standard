# NPM Publishing Setup

**Author:** @darianrosebrook

This document explains how to enable NPM publishing for the CAWS CLI package.

## Current Status

NPM publishing is currently **disabled** in `.releaserc.json`:

```json
{
  "npmPublish": false
}
```

This allows semantic-release to:
- ✅ Create version tags
- ✅ Generate `CHANGELOG.md`
- ✅ Commit version bumps
- ✅ Create GitHub releases
- ❌ Publish to NPM registry (disabled)

## Option 1: Traditional NPM Token (Quick Setup)

### Steps:

1. **Generate an NPM Automation Token:**
   - Log in to [npmjs.com](https://www.npmjs.com)
   - Go to Account Settings → Access Tokens
   - Click "Generate New Token" → Select "Automation"
   - Copy the token (starts with `npm_...`)

2. **Add Token to GitHub Secrets:**
   - Go to your GitHub repository
   - Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Paste your NPM token

3. **Enable Publishing:**
   
   Update `.releaserc.json`:
   ```json
   {
     "npmPublish": true
   }
   ```

4. **Verify Workflow:**
   
   Check that `.github/workflows/release.yml` has:
   ```yaml
   - name: Release
     env:
       GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
       NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
     run: npx semantic-release
   ```

## Option 2: OIDC Trusted Publishing (Recommended, More Secure)

OIDC (OpenID Connect) allows publishing without long-lived tokens.

### Steps:

1. **Configure NPM Trusted Publishing:**
   - Log in to [npmjs.com](https://www.npmjs.com)
   - Go to your package settings
   - Navigate to "Publishing Access"
   - Add GitHub as a trusted publisher:
     - **Provider:** GitHub Actions
     - **Repository:** `Paths-Design/coding-agent-working-standard`
     - **Workflow:** `release.yml`
     - **Environment:** (leave blank or specify `production`)

2. **Update Workflow:**
   
   Modify `.github/workflows/release.yml` to use NPM provenance:
   ```yaml
   - name: Setup NPM authentication with OIDC
     uses: actions/setup-node@v4
     with:
       node-version: '22'
       registry-url: 'https://registry.npmjs.org'
   
   - name: Release with NPM Provenance
     env:
       GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
       NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}  # Still needed for verification
     run: npx semantic-release
   ```

3. **Enable Publishing with Provenance:**
   
   Update `.releaserc.json`:
   ```json
   [
     "@semantic-release/npm",
     {
       "npmPublish": true,
       "tarballDir": "dist",
       "pkgRoot": "packages/caws-cli",
       "provenance": true
     }
   ]
   ```

## Option 3: Manual Publishing (Development)

For development or testing, you can publish manually:

```bash
cd packages/caws-cli
npm run build
npm publish --access public
```

## Verification

To test NPM authentication without publishing:

```bash
npm whoami --registry https://registry.npmjs.org
```

In CI, you can add a verification step:

```yaml
- name: Verify NPM Authentication
  run: npm whoami
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Two-Factor Authentication (2FA)

If you have 2FA enabled on your NPM account:

1. Go to npmjs.com → Account Settings → Two-Factor Authentication
2. Set the level to **"Authorization only"**
3. Do NOT use "Authorization and writes" (semantic-release cannot handle this)

## Scoped Packages

The CAWS CLI is published under the `@paths.design` scope:

- Package name: `@paths.design/caws-cli`
- Ensure your NPM token has permission to publish to this scope
- Verify in `packages/caws-cli/package.json`:
  ```json
  {
    "name": "@paths.design/caws-cli",
    "publishConfig": {
      "access": "public"
    }
  }
  ```

## Troubleshooting

### Error: `EINVALIDNPMTOKEN`

- **Cause:** NPM token is missing, expired, or invalid
- **Solution:** Regenerate token and update GitHub secret

### Error: `ENEEDAUTH`

- **Cause:** Token not provided to semantic-release
- **Solution:** Ensure `NPM_TOKEN` is in workflow `env`

### Error: `E403` (Forbidden)

- **Cause:** Token doesn't have permission to publish
- **Solution:** Ensure token is "Automation" type and has access to the `@paths.design` scope

### Publishing Disabled Error

If you see: `Publishing to npm disabled`

This is expected when `npmPublish: false`. Enable it when ready to publish.

## Resources

- [semantic-release NPM Plugin](https://github.com/semantic-release/npm)
- [NPM Token Documentation](https://docs.npmjs.com/creating-and-viewing-access-tokens)
- [NPM Provenance](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub OIDC with NPM](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)

