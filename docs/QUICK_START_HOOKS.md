# Quick Start: Git Hooks & CI/CD

> **TL;DR**: Hooks catch errors early. Pre-commit = instant, pre-push = local, CI = comprehensive.

## 🚀 Setup (One-Time)

```bash
# Install dependencies (includes lint-staged)
npm install

# Make hooks executable
npm run hooks:install

# Verify setup
ls -la .git/hooks/pre-*
```

## ✅ What Runs Where

### Pre-Commit (< 15s)
**When**: Every `git commit`

```bash
✓ Naming conventions (no "enhanced-*.ts" or "*-copy")
✓ Lint staged files
✓ Type check
✓ Common issues (debugger, etc.)
```

**Skip if needed**: `git commit --no-verify`

### Pre-Push (< 60s)
**When**: Every `git push`

```bash
✓ CAWS spec validation
✓ Unit tests + coverage
✓ Contract tests
✓ Build verification
⚠ Scope compliance (warning)
```

**Skip if needed**: `git push --no-verify`

### CI - Pull Request (< 10min)
**When**: PR created/updated

```bash
✓ Full linting
✓ Full test suite
✓ CAWS guards (hard fail)
✓ Scope/budget enforcement
✓ Mutation testing
✓ Accessibility testing
✓ Performance budgets
```

**Cannot skip**: Required for merge

### CI - Release (Auto)
**When**: Push to `main`

```bash
✓ Full verification
✓ Semantic versioning
✓ Publish to npm
✓ Generate provenance
```

**Cannot skip**: Automated

## 🎯 Quick Commands

```bash
# Run what pre-commit runs
npm run lint:staged
npm run typecheck

# Run what pre-push runs
npm run caws:validate
npm run test:unit -- --coverage
npm run build

# Run what CI runs
npm run caws:verify

# Install/reinstall hooks
npm run hooks:install
```

## 🚨 Emergency Overrides

### Skip Client Hooks (Use Sparingly)
```bash
# Emergency WIP commit
git commit --no-verify -m "WIP: debugging production issue"

# Emergency hotfix push
git push --no-verify
```

### Skip CI Gates (Auditable)
Add to `.caws/working-spec.yaml`:

```yaml
human_override:
  enabled: true
  approver: "your-github-username"
  rationale: "Production hotfix - P0 incident"
  waived_gates: ["mutation", "manual_review"]
  approved_at: "2025-10-01T12:00:00Z"
  expires_at: "2025-10-08T12:00:00Z"
```

## 💡 Best Practices

### ✅ Do
- Let pre-commit catch trivial errors
- Run `npm run caws:verify` before pushing large changes
- Use meaningful commit messages (triggers semantic versioning)
- Keep commits small and focused

### ❌ Don't
- Skip hooks habitually (`--no-verify` should be rare)
- Push broken code ("I'll fix it in CI")
- Commit large binaries or generated files
- Use shadow filenames (`enhanced-*`, `*-copy`)

## 🔧 Troubleshooting

### Hook Not Running
```bash
# Make executable
npm run hooks:install

# Verify
cat .git/hooks/pre-commit
```

### Hook Too Slow
```bash
# Check what's taking time
time git commit -m "test"

# If linting is slow, check .eslintignore
# If type checking is slow, check tsconfig.json
```

### False Positive
```bash
# Skip once (emergency only)
git commit --no-verify

# Fix the underlying issue
# - Update eslint rules
# - Fix type errors
# - Update working-spec.yaml scope
```

## 📚 Learn More

- [Hook Strategy](./HOOK_STRATEGY.md) - Full hook placement rationale
- [CAWS Developer Guide](./caws-developer-guide.md) - Overall workflow
- [Commit Conventions](../COMMIT_CONVENTIONS.md) - Message format for semantic versioning

---

**Remember**: Hooks are here to help catch errors before they become problems. Embrace them!

