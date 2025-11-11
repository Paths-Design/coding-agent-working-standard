# Publishing @paths.design/quality-gates

This guide covers how to publish the quality-gates package to npm.

## Prerequisites

1. **NPM Account**: Ensure you're logged into npm with access to `@paths.design` scope

   ```bash
   npm login
   npm whoami  # Verify you're logged in
   ```

2. **Version Check**: Verify current version in `package.json`

   ```bash
   cat package.json | grep version
   ```

3. **Registry Access**: Ensure you have publish access to `@paths.design` scope
   ```bash
   npm access list packages @paths.design
   ```

## Pre-Publish Checklist

- [ ] All tests pass: `npm test`
- [ ] README.md is up to date
- [ ] Version number is correct in `package.json`
- [ ] `files` array in `package.json` includes all necessary files:
  - `*.mjs` (all quality gate modules)
  - `templates/` (configuration templates)
  - `docs-status/` (status directory structure)
  - `README.md` (documentation)
- [ ] No sensitive data in published files
- [ ] Dependencies are up to date

## Publishing Steps

### 1. Dry Run (Recommended)

Test what will be published without actually publishing:

```bash
cd packages/quality-gates
npm pack --dry-run
```

This creates a tarball and shows what files would be included.

### 2. Verify Package Contents

Check the tarball contents:

```bash
npm pack
tar -tzf paths.design-quality-gates-*.tgz | head -20
```

### 3. Publish to npm

**For first-time publish:**

```bash
npm publish --access public
```

**For updates:**

```bash
# Update version first (if needed)
npm version patch  # or minor, major
npm publish
```

### 4. Verify Publication

Check that the package is available:

```bash
npm view @paths.design/quality-gates
npm view @paths.design/quality-gates versions
```

### 5. Test Installation

Test installing the published package:

```bash
cd /tmp
mkdir test-quality-gates-install
cd test-quality-gates-install
npm init -y
npm install @paths.design/quality-gates
node node_modules/@paths.design/quality-gates/run-quality-gates.mjs --help
```

## Version Management

### Semantic Versioning

- **Patch** (1.0.1 → 1.0.2): Bug fixes, minor improvements
- **Minor** (1.0.1 → 1.1.0): New features, backward compatible
- **Major** (1.0.1 → 2.0.0): Breaking changes

### Update Version

```bash
# Patch version
npm version patch

# Minor version
npm version minor

# Major version
npm version major
```

## Files Included in Package

Based on `package.json` `files` array:

- All `.mjs` files (quality gate modules)
- `templates/` directory (configuration templates)
- `docs-status/` directory (status directory structure)
- `README.md` (documentation)

**Excluded** (not in `files` array):

- Test files (`test-*.mjs`)
- Configuration files in root (`*.qualitygatesrc.yaml`)
- Python files (`*.py`)

## Post-Publish

After publishing:

1. **Update Documentation**: Update any docs that reference the package
2. **Update Scaffold**: The scaffold already references `@paths.design/quality-gates`
3. **Test Integration**: Verify CAWS CLI can find and use the published package
4. **Announce**: Notify team/users about the new package availability

## Troubleshooting

### "You do not have permission to publish"

- Verify you're logged in: `npm whoami`
- Check scope access: `npm access ls-packages @paths.design`
- Request access if needed

### "Package name already exists"

- Check if version already exists: `npm view @paths.design/quality-gates versions`
- Increment version: `npm version patch`

### "Invalid package name"

- Ensure package name is `@paths.design/quality-gates`
- Verify `publishConfig.access` is set to `"public"`

## CI/CD Publishing (Future)

Consider setting up automated publishing via GitHub Actions:

```yaml
# .github/workflows/publish-quality-gates.yml
name: Publish Quality Gates

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          registry-url: 'https://registry.npmjs.org'
      - run: cd packages/quality-gates && npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

**Author**: @darianrosebrook  
**Last Updated**: 2024-11-11
