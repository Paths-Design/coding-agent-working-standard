# Language-Agnostic Quality Gates Release Guide

## Changes Summary

This release adds language-agnostic quality gates support, removing language-specific assumptions and making quality gates work universally across all programming languages.

### Modified Packages

1. **`@paths.design/caws-cli`** (v7.0.3 → v7.0.4)
   - Language-agnostic project detection
   - Runtime-based suggestions (Node.js/npx availability)
   - Enhanced `caws quality-gates` command with npx fallback
   - Updated git hooks with language-agnostic suggestions

2. **`@paths.design/quality-gates`** (v1.0.1)
   - No changes needed (test file only)

## Release Steps

### 1. Commit Changes with Proper Scope

```bash
# Commit with CLI scope to trigger semantic-release
git add packages/caws-cli/src/
git commit -m "feat(cli): add language-agnostic quality gates support

- Detect runtime availability (Node.js/npx) instead of project language
- Add npx fallback for quality gates execution
- Update git hooks with language-agnostic suggestions
- Remove language-specific assumptions from suggestions"
```

### 2. Build and Test

```bash
# Build CLI package
cd packages/caws-cli
npm run build

# Test quality gates command
npm run test

# Test in a Python project
cd /path/to/python-project
node ../../packages/caws-cli/dist/index.js quality-gates --help
```

### 3. Release via Semantic Release

The release will happen automatically via semantic-release when you push:

```bash
git push origin main
```

Semantic-release will:
- Analyze commit message (`feat(cli):...`)
- Bump version (minor: 7.0.3 → 7.0.4)
- Build package
- Publish to npm
- Create git tag
- Update CHANGELOG.md

### 4. Manual Release (If Needed)

If semantic-release doesn't trigger automatically:

```bash
# Option 1: Use manual release script
node scripts/manual-release.mjs patch

# Option 2: Manual publish
cd packages/caws-cli
npm version patch
npm run build
npm publish --access public
git push --tags
```

## Post-Release Steps

### For Existing Projects

Projects need to regenerate git hooks to get the new language-agnostic suggestions:

```bash
# In each project
caws hooks install --force
```

Or manually update hooks:

```bash
# Regenerate hooks with new language-agnostic code
caws scaffold --with-hooks --force
```

### For New Projects

New projects will automatically get the language-agnostic hooks when they run:

```bash
caws init .
# or
caws scaffold
```

## Verification

### Test Language-Agnostic Behavior

1. **Python Project** (no package.json):
```bash
cd /path/to/python-project
caws quality-gates
# Should suggest: npx --yes @paths.design/quality-gates (if Node.js available)
```

2. **Rust Project** (no package.json):
```bash
cd /path/to/rust-project
caws quality-gates
# Should suggest: npx --yes @paths.design/quality-gates (if Node.js available)
```

3. **JavaScript Project**:
```bash
cd /path/to/js-project
caws quality-gates
# Should work with npx or local installation
```

### Verify Git Hooks

```bash
# Check hook suggestions
cat .git/hooks/pre-commit | grep "Available options"
# Should show language-agnostic suggestions based on Node.js availability
```

## What Changed

### Before (Language-Specific)
- Detected project language (Python, JavaScript, etc.)
- Provided different suggestions per language
- Required adding logic for each language

### After (Language-Agnostic)
- Checks runtime availability (Node.js/npx)
- Provides universal suggestions (works for any language)
- Suggests project scripts if they exist (but doesn't assume language)

## Benefits

✅ **Works for all languages** - Python, Rust, Go, Java, C#, PHP, etc.  
✅ **No npm bloat** - Uses npx when available (no installation needed)  
✅ **Runtime-aware** - Adapts to what's available on the system  
✅ **Future-proof** - No need to add language-specific logic for new languages  
✅ **Simpler maintenance** - One code path for all languages

## Rollback Plan

If issues arise:

1. **Revert hooks** in projects:
```bash
caws hooks remove
git checkout .git/hooks/pre-commit
```

2. **Downgrade CLI**:
```bash
npm install -g @paths.design/caws-cli@7.0.3
```

3. **Revert commit**:
```bash
git revert <commit-hash>
git push origin main
```

## Related Documentation

- [Language-Aware Quality Gates](./LANGUAGE_AWARE_QUALITY_GATES.md)
- [Release Checklist](./RELEASE_CHECKLIST.md)
- [Multi-Package Release](./MULTI_PACKAGE_RELEASE.md)

