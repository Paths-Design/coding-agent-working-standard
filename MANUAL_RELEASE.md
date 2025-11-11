# Manual Release Guide

Since the automated semantic-release isn't triggering, use these manual release commands.

## Quick Release (All Packages)

Run the automated script:

```bash
./scripts/manual-release.sh
```

## Manual Step-by-Step Release

### Prerequisites

1. **Ensure you're logged into npm:**
   ```bash
   npm whoami
   # If not logged in:
   npm login
   ```

2. **Ensure all changes are committed:**
   ```bash
   git status
   ```

### Release Order (Dependencies First)

#### 1. Release @paths.design/caws-types

```bash
cd packages/caws-types
npm run build
npm publish --access public
cd ../..
git tag -a "caws-types-v1.0.0" -m "chore(release): @paths.design/caws-types@1.0.0"
```

#### 2. Release @paths.design/quality-gates

```bash
cd packages/quality-gates
npm run build
npm publish --access public
cd ../..
git tag -a "quality-gates-v1.0.1" -m "chore(release): @paths.design/quality-gates@1.0.1"
```

#### 3. Release @paths.design/caws-cli

```bash
cd packages/caws-cli
npm run build
npm publish --access public
cd ../..
git tag -a "caws-cli-v6.0.0" -m "chore(release): @paths.design/caws-cli@6.0.0"
```

#### 4. Release @paths.design/caws-mcp-server

```bash
cd packages/caws-mcp-server
npm run build
npm publish --access public
cd ../..
git tag -a "caws-mcp-server-v1.1.2" -m "chore(release): @paths.design/caws-mcp-server@1.1.2"
```

### After All Releases

1. **Push tags to GitHub:**
   ```bash
   git push --tags
   ```

2. **Push commits (if any):**
   ```bash
   git push origin main
   ```

## Verify Releases

Check npm to verify packages were published:

```bash
npm view @paths.design/caws-cli version
npm view @paths.design/caws-mcp-server version
npm view @paths.design/caws-types version
npm view @paths.design/quality-gates version
```

## Troubleshooting

### Package Already Published

If you get an error that the version already exists, you need to bump the version first:

1. Edit `package.json` in the package directory
2. Update the version number (following semantic versioning)
3. Commit the version change
4. Then publish

### Build Errors

Make sure all dependencies are installed:

```bash
npm install
```

### Authentication Errors

Ensure you have publish access to the `@paths.design` scope:

```bash
npm whoami
npm config get @paths.design:registry
```
