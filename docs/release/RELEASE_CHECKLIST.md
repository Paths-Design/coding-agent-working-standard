# CAWS Release Cycle Checklist

**Version**: 1.0.0  
**Last Updated**: 2025-10-30  
**Author**: @darianrosebrook

---

## 📋 Pre-Release Checklist

### Code Quality Gates

- [ ] **Linting**: `npm run lint` passes with zero errors
  - [ ] CLI package linting passes
  - [ ] MCP server linting passes
  - [ ] Extension linting passes
  - [ ] Quality gates package linting passes (if applicable)

- [ ] **Type Checking**: `npm run typecheck` passes
  - [ ] TypeScript compilation succeeds
  - [ ] No type errors in any package
  - [ ] Type definitions are complete

- [ ] **Code Formatting**: All files formatted consistently
  - [ ] Prettier/ESLint formatting applied
  - [ ] No manual formatting inconsistencies

### Testing Suite

- [ ] **Unit Tests**: `npm run test:unit` passes
  - [ ] All unit tests passing
  - [ ] No skipped tests in production code
  - [ ] Test coverage meets tier requirements

- [ ] **Integration Tests**: `npm run test:integration` passes
  - [ ] Database integration tests (if applicable)
  - [ ] External API integration tests
  - [ ] Component communication tests

- [ ] **Contract Tests**: `npm run test:contract` passes
  - [ ] API contract validation
  - [ ] Schema validation
  - [ ] Interface compatibility

- [ ] **E2E Smoke Tests**: `npm run test:e2e:smoke` passes
  - [ ] Critical user journeys work
  - [ ] End-to-end workflows verified

- [ ] **Mutation Testing**: `npm run test:mutation` passes (if configured)
  - [ ] Mutation score meets tier requirements
  - [ ] Critical components have adequate mutation coverage

### Quality Gates Execution

- [ ] **Manual Quality Gates**: `node packages/quality-gates/run-quality-gates.mjs` passes
  - [ ] Naming conventions check
  - [ ] Code freeze compliance (if applicable)
  - [ ] Duplication detection
  - [ ] God objects detection
  - [ ] Documentation quality

- [ ] **CAWS Quality Gates**: `caws quality-gates` passes
  - [ ] All gates execute successfully
  - [ ] Waiver integration working
  - [ ] No blocking violations

- [ ] **Waiver Validation**: All active waivers valid
  - [ ] `caws waivers list` shows only active waivers
  - [ ] No expired waivers blocking releases
  - [ ] Waiver IDs follow correct format (WV-XXXX)

### Build & Compilation

- [ ] **Full Build**: `npm run build` succeeds
  - [ ] CLI package builds successfully
  - [ ] MCP server builds successfully
  - [ ] Extension bundles correctly
  - [ ] Quality gates package builds (if applicable)

- [ ] **Build Artifacts**: Verify all dist/out directories populated
  - [ ] CLI dist/ contains compiled JavaScript
  - [ ] Extension out/ contains compiled TypeScript
  - [ ] All package.json files updated correctly

### Package Verification

- [ ] **Release Check Script**: `node scripts/release-check.mjs` passes
  - [ ] Version numbers consistent
  - [ ] Build outputs exist
  - [ ] Waiver integration files present

- [ ] **Package Versions**: All packages have correct versions
  - [ ] CLI version matches release version
  - [ ] MCP server version matches release version
  - [ ] Extension version matches release version
  - [ ] Root package.json version updated (if applicable)

- [ ] **NPM Dry Run**: Test publish with `--dry-run`
  - [ ] CLI dry-run succeeds: `cd packages/caws-cli && npm publish --dry-run`
  - [ ] MCP server dry-run succeeds: `cd packages/caws-mcp-server && npm publish --dry-run`
  - [ ] Verify tarball contents are correct

### Git Hooks Status

- [ ] **Pre-Commit Hook**: `.git/hooks/pre-commit` active
  - [ ] Runs CAWS validation
  - [ ] Checks path discipline
  - [ ] Runs fast quality checks
  - [ ] Scans for secrets

- [ ] **Pre-Push Hook**: `.git/hooks/pre-push` active
  - [ ] Runs comprehensive tests
  - [ ] Runs CAWS evaluation
  - [ ] Checks scope compliance
  - [ ] Validates high-risk changes

- [ ] **Post-Commit Hook**: `.git/hooks/post-commit` active
  - [ ] Updates provenance tracking
  - [ ] Logs commit information

- [ ] **Commit-Msg Hook**: `.git/hooks/commit-msg` active (optional)
  - [ ] Validates commit message format
  - [ ] Checks conventional commits

### CI/CD Verification

- [ ] **PR Checks Workflow**: `.github/workflows/pr-checks.yml`
  - [ ] Sanity checks pass (lint, typecheck, build)
  - [ ] CAWS guards pass (shadow files, scope, budget)
  - [ ] Test suite passes
  - [ ] Quality gates pass

- [ ] **CAWS Gate Workflow**: `.github/workflows/caws-gate.yml`
  - [ ] Working spec validation
  - [ ] Path discipline enforcement
  - [ ] Budget immutability check
  - [ ] Waiver validation
  - [ ] Dual control for policy changes

- [ ] **CAWS Guards Workflow**: `.github/workflows/caws-guards.yml`
  - [ ] Naming guard passes
  - [ ] Scope guard passes
  - [ ] Budget guard passes

- [ ] **Release Workflow**: `.github/workflows/release.yml`
  - [ ] Semantic release configured correctly
  - [ ] NPM authentication configured
  - [ ] OIDC provenance enabled

### Documentation

- [ ] **CHANGELOG**: Updated with changes
  - [ ] Added to CHANGELOG.md
  - [ ] Semantic release will auto-update

- [ ] **README**: Updated if needed
  - [ ] Version numbers updated
  - [ ] New features documented
  - [ ] Breaking changes documented

- [ ] **API Documentation**: Updated if APIs changed
  - [ ] Command help text current
  - [ ] Examples work correctly
  - [ ] Breaking changes documented

### Security & Compliance

- [ ] **Security Audit**: `npm audit --audit-level=high` passes
  - [ ] No high/critical vulnerabilities
  - [ ] Moderate vulnerabilities reviewed

- [ ] **Secret Scanning**: No secrets in code
  - [ ] API keys not committed
  - [ ] Passwords not in code
  - [ ] Tokens properly configured

- [ ] **Dependency Review**: All dependencies reviewed
  - [ ] No unexpected dependencies
  - [ ] License compatibility verified
  - [ ] Security advisories reviewed

---

## 🚀 Release Process

### Step 1: Pre-Release Verification

```bash
# Run release verification script
node scripts/release-check.mjs

# Expected output:
# ✅ All package versions verified
# ✅ All build outputs exist
# ✅ Waiver integration working
```

### Step 2: Final Testing

```bash
# Run full test suite
npm test

# Run quality gates
node packages/quality-gates/run-quality-gates.mjs --gates=all

# Run CAWS validation
caws validate

# Run CAWS diagnosis
caws diagnose
```

### Step 3: Build All Packages

```bash
# Clean build
npm run clean
npm run build

# Verify builds
ls -la packages/caws-cli/dist/
ls -la packages/caws-mcp-server/
ls -la packages/caws-vscode-extension/out/
```

### Step 4: Version Check

```bash
# Verify versions are correct
cat packages/caws-cli/package.json | grep version
cat packages/caws-mcp-server/package.json | grep version
cat packages/caws-vscode-extension/package.json | grep version
```

### Step 5: Git Preparation

```bash
# Ensure all changes committed
git status

# Verify commit messages follow conventional commits
git log --oneline -5

# Ensure working directory clean
git diff --exit-code
```

### Step 6: Release Execution

**Option A: Automated Semantic Release (Recommended)**

```bash
# Push to main triggers semantic-release
git push origin main

# Monitor CI/CD for release
# Check GitHub Actions: Release workflow
```

**Option B: Manual Release**

```bash
# Publish CLI
cd packages/caws-cli
npm publish

# Publish MCP Server
cd ../caws-mcp-server
npm publish

# Package Extension (for VS Code Marketplace)
cd ../caws-vscode-extension
npm run package
# Then manually upload to VS Code Marketplace
```

### Step 7: Post-Release Verification

- [ ] **NPM Verification**: Packages published correctly
  - [ ] CLI available: `npm view @paths.design/caws-cli version`
  - [ ] MCP server available: `npm view caws-mcp-server version`
  - [ ] Extension version updated in marketplace

- [ ] **Installation Test**: Test fresh install

  ```bash
  npm install -g @paths.design/caws-cli@latest
  caws --version
  ```

- [ ] **Git Tag**: Release tag created

  ```bash
  git tag -l | tail -5
  ```

- [ ] **GitHub Release**: Release notes published
  - [ ] Release notes generated
  - [ ] Changelog updated
  - [ ] Release visible on GitHub

---

## 🔍 Quality Gates Checklist

### Pre-Commit Quality Gates

- [ ] Working spec validation passes
- [ ] Path discipline enforced (no policy + code changes)
- [ ] Budget immutability checked
- [ ] Fast quality checks pass
- [ ] Secret scanning passes
- [ ] Basic linting passes

### Pre-Push Quality Gates

- [ ] Full test suite passes
- [ ] CAWS evaluation passes
- [ ] CAWS validation passes
- [ ] High-risk changes have waivers
- [ ] Scope compliance verified
- [ ] Change budget within limits

### CI/CD Quality Gates

- [ ] PR checks workflow passes
- [ ] CAWS gate workflow passes
- [ ] CAWS guards workflow passes
- [ ] Test suite passes
- [ ] Quality gates pass
- [ ] Security audit passes

### Release Quality Gates

- [ ] All packages build successfully
- [ ] All tests pass
- [ ] All quality gates pass
- [ ] Version numbers consistent
- [ ] Documentation updated
- [ ] NPM dry-run succeeds

---

## 🐛 Known Issues & Gaps

### Current Process Gaps

1. **Waiver Active File Sync**: `caws waivers create` doesn't automatically update `active-waivers.yaml`
   - **Impact**: Manual sync required for quality gates integration
   - **Priority**: Medium
   - **Status**: Temporary workaround in place

2. **Extension Packaging**: VS Code extension has template dependency issues
   - **Impact**: Extension not published in v4.1.0
   - **Priority**: High
   - **Status**: Requires investigation

3. **CI/CD Test Coverage**: Some test scripts have fallback warnings
   - **Impact**: Tests may silently skip
   - **Priority**: Low
   - **Status**: Acceptable for now

4. **Pre-Commit Hook Dependencies**: Some hooks reference scripts that may not exist
   - **Impact**: Hooks may fail silently
   - **Priority**: Medium
   - **Status**: Needs verification

### Process Improvements Needed

1. **Automated Waiver Sync**: Implement automatic `active-waivers.yaml` update
2. **Pre-Release Smoke Tests**: Add automated pre-release smoke test suite
3. **Release Verification**: Enhance `release-check.mjs` with more checks
4. **Hook Testing**: Add tests for git hooks themselves
5. **CI/CD Parallelization**: Optimize CI/CD workflow execution time
6. **Dry-Run Everything**: Add dry-run mode for all release steps

---

## 📊 Release Metrics

### Release Success Criteria

- ✅ All tests pass
- ✅ All quality gates pass
- ✅ All packages build successfully
- ✅ All packages publish successfully
- ✅ Documentation updated
- ✅ Git tags created
- ✅ GitHub release created

### Release Failure Indicators

- ❌ Any test failures
- ❌ Quality gate violations (without waivers)
- ❌ Build failures
- ❌ Linting errors
- ❌ Type check errors
- ❌ Security vulnerabilities
- ❌ Broken CI/CD workflows

---

## 🔄 Continuous Improvement

### After Each Release

1. **Post-Mortem**: Review what went well and what didn't
2. **Update Checklist**: Add any missing steps discovered
3. **Document Issues**: Note any process gaps or failures
4. **Improve Automation**: Automate any manual steps discovered
5. **Update Documentation**: Keep docs current with process changes

### Monthly Reviews

1. **Process Audit**: Review entire release process
2. **Tool Updates**: Update dependencies and tools
3. **Workflow Optimization**: Improve CI/CD efficiency
4. **Quality Metric Review**: Track quality trends over time

---

## 📝 Release Notes Template

```markdown
## [Version] - [Date]

### 🔖 Features

- Feature 1 description
- Feature 2 description

### 🐛 Bug Fixes

- Bug fix 1 description
- Bug fix 2 description

### 🔧 Improvements

- Improvement 1 description
- Improvement 2 description

### ⚠️ Breaking Changes

- Breaking change 1 description
- Migration guide link

### 📚 Documentation

- Doc update 1
- Doc update 2

### 🔒 Security

- Security fix 1
- Security fix 2
```

---

**Last Updated**: 2025-10-30  
**Maintained By**: CAWS Team  
**Review Frequency**: After each release
