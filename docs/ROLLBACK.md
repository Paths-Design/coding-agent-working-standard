# CAWS Rollback & Incident Response

**Author**: @darianrosebrook  
**Last Updated**: October 10, 2025  
**Status**: Production Ready

## Overview

This document provides procedures for rolling back bad releases and responding to production incidents for CAWS packages.

---

## Quick Reference

| Scenario                   | Action             | Time to Resolution |
| -------------------------- | ------------------ | ------------------ |
| **Broken npm package**     | Deprecate + hotfix | 15-30 minutes      |
| **Security vulnerability** | Emergency patch    | 1-4 hours          |
| **Failed CI/CD**           | Revert commit      | 5-10 minutes       |
| **Breaking API change**    | Major version bump | N/A - by design    |

---

## Rollback Strategies

### Strategy 1: npm Deprecation (Recommended)

**When to use**: Broken release discovered after users have installed

**Advantages**:

- Doesn't break existing installations
- Users get warning on new installs
- Can still install if explicitly needed

**Procedure**:

```bash
# 1. Identify broken version
npm view @paths.design/caws-cli versions

# 2. Deprecate the broken version
npm deprecate @paths.design/caws-cli@3.4.1 "Known issue: validation fails on Windows. Use 3.4.0 or wait for 3.4.2"

# 3. Verify deprecation
npm view @paths.design/caws-cli

# 4. Notify users via GitHub Release notes
gh release edit v3.4.1 --notes "⚠️ This release has been deprecated. Use 3.4.0 or wait for 3.4.2"

# 5. Prepare hotfix
git checkout main
git revert <bad-commit>
# semantic-release will auto-publish 3.4.2
```

**User Impact**: Low - existing installations work, new users warned

---

### Strategy 2: Hotfix Release (Fastest)

**When to use**: Critical bug or security issue

**Advantages**:

- Fastest resolution
- Users get fix automatically on update
- Maintains version history

**Procedure**:

```bash
# 1. Create hotfix branch (optional, can work on main)
git checkout main
git pull origin main

# 2. Fix the issue
# ... make code changes ...

# 3. Write fix commit with semantic-release format
git add .
git commit -m "fix: resolve critical validation bug

This fixes the Windows path handling issue introduced in 3.4.1

Fixes #123"

# 4. Push to main
git push origin main

# 5. CI automatically:
#    - Runs tests
#    - Creates 3.4.2 release
#    - Publishes to npm
#    - Creates GitHub release

# 6. Verify release
npm view @paths.design/caws-cli version
# Should show 3.4.2

# 7. Optional: Deprecate bad version
npm deprecate @paths.design/caws-cli@3.4.1 "Fixed in 3.4.2"
```

**User Impact**: Low - users update to fixed version

**Timeline**: 15-30 minutes (including CI/CD)

---

### Strategy 3: npm Unpublish (Emergency Only)

**When to use**: Critical security issue + package published <72 hours ago

**Disadvantages**:

- Breaks anyone who installed it
- Only works within 72 hours
- Creates gaps in version history

**Procedure**:

```bash
# 1. Confirm timing (must be <72 hours)
npm view @paths.design/caws-cli time

# 2. Unpublish the version
npm unpublish @paths.design/caws-cli@3.4.1

# 3. Verify removal
npm view @paths.design/caws-cli versions
# 3.4.1 should be missing

# 4. Publish fixed version
git revert <bad-commit>
git commit -m "fix: security patch"
git push
# CI publishes 3.4.2

# 5. Notify users who may have installed
gh issue create --title "SECURITY: Upgrade from 3.4.1 immediately" \
  --body "Version 3.4.1 has been unpublished due to security issue. Upgrade to 3.4.2."
```

**User Impact**: HIGH - breaks existing installations

**Use only for**: Critical security vulnerabilities

---

### Strategy 4: Major Version Rollback

**When to use**: Breaking changes need to be reverted

**Procedure**:

```bash
# If v4.0.0 introduced breaking changes that need rollback

# 1. Don't unpublish major versions
# 2. Document why v4.x is problematic
# 3. Continue supporting v3.x

# 4. Publish clarification
npm dist-tag add @paths.design/caws-cli@3.9.0 latest

# This makes 3.9.0 the default install again
# Users on v4.x can stay, but new installs get v3.x

# 5. Announce via GitHub
gh release create v3.9.1 --notes "LTS release. v4.x is not recommended yet."
```

---

## Incident Response Playbook

### Severity Levels

| Level             | Description                      | Response Time | Example                             |
| ----------------- | -------------------------------- | ------------- | ----------------------------------- |
| **P0 - Critical** | Production down, security breach | <1 hour       | Remote code execution vulnerability |
| **P1 - High**     | Major functionality broken       | <4 hours      | CLI crashes on all platforms        |
| **P2 - Medium**   | Functionality degraded           | <24 hours     | Feature broken on Windows only      |
| **P3 - Low**      | Minor issues, workarounds exist  | <1 week       | Typo in error message               |

---

### P0: Critical Incident Response

**Indicators**:

- Security vulnerability (RCE, credential leak)
- Complete CLI failure
- Data corruption risk

**Response**:

```bash
# === IMMEDIATE (0-15 minutes) ===

# 1. Assess impact
# - How many users affected?
# - What versions affected?
# - What's the attack vector?

# 2. If security issue: Disable if possible
# Option A: Deprecate immediately
npm deprecate @paths.design/caws-cli@3.4.1 "CRITICAL SECURITY ISSUE - DO NOT USE"

# Option B: Unpublish (if <72h)
npm unpublish @paths.design/caws-cli@3.4.1

# 3. Notify team
# Post in #incidents channel
# Page on-call engineer
# Email security@paths.design

# === SHORT TERM (15-60 minutes) ===

# 4. Develop hotfix
git checkout main
git checkout -b hotfix/security-patch

# Make minimal fix
# DO NOT add features or refactor

git add .
git commit -m "fix: CRITICAL security patch

CVE-2025-XXXXX: Prevent arbitrary code execution

BREAKING CHANGE: Removed unsafe eval usage"

# 5. Fast-track testing
npm run test
npm run lint
npm audit --audit-level=high

# 6. Merge and release
git checkout main
git merge hotfix/security-patch
git push origin main

# CI will auto-publish

# === FOLLOW-UP (1-24 hours) ===

# 7. Issue CVE if needed
# Contact GitHub Security Advisory
# https://github.com/Paths-Design/coding-agent-working-standard/security/advisories/new

# 8. Post-mortem
# Write incident report
# Update security procedures
# Notify affected users
```

---

### P1: High Severity Incident

**Indicators**:

- CLI broken for major use cases
- Build failures across platforms
- Multiple user reports

**Response**:

```bash
# === ASSESS (0-30 minutes) ===

# 1. Reproduce issue
npm install -g @paths.design/caws-cli@3.4.1
caws validate test-project

# 2. Check error reports
gh issue list --label "bug" --label "priority:high"

# 3. Identify root cause
git log --oneline -10
git diff v3.4.0...v3.4.1

# === FIX (30 minutes - 4 hours) ===

# 4. Develop fix
git checkout -b fix/broken-validation

# Fix the issue
# Write regression test
# Test thoroughly

# 5. Create PR (yes, even for urgent fixes)
gh pr create --title "fix: resolve validation failure" \
  --body "Root cause: ... \nFix: ... \nTested: ..."

# 6. Fast-track review
# Get approval from maintainer
# Merge to main

# === RELEASE (auto via CI) ===

# 7. CI publishes hotfix
# Monitor release pipeline

# 8. Verify fix
npm install -g @paths.design/caws-cli@latest
caws validate test-project

# === COMMUNICATE ===

# 9. Update GitHub issue
gh issue comment 123 --body "Fixed in v3.4.2. Please upgrade: npm install -g @paths.design/caws-cli@latest"

# 10. Post release notes
gh release edit v3.4.2 --notes "Hotfix for validation failure introduced in 3.4.1"
```

---

### P2: Medium Severity

**Response**: Standard development process + prioritization
**Timeline**: Fix in next sprint (1-2 weeks)

---

### P3: Low Severity

**Response**: Standard backlog prioritization  
**Timeline**: Fix when convenient

---

## Verification Procedures

### Pre-Rollback Checks

```bash
# 1. Identify scope of issue
npm view @paths.design/caws-cli time
# When was bad version published?

npm view @paths.design/caws-cli downloads
# How many downloads?

# 2. Check dependencies
npm view @paths.design/caws-cli dependencies
# Will rollback affect other packages?

# 3. Review open issues
gh issue list --label "bug"
# Are there related issues?
```

### Post-Rollback Verification

```bash
#!/bin/bash
# rollback-verification.sh

set -e

echo "🔍 Verifying rollback..."

# 1. Check npm package
LATEST=$(npm view @paths.design/caws-cli version)
echo "Latest version on npm: $LATEST"

# 2. Test fresh install
echo "Testing fresh install..."
docker run --rm node:22-alpine sh -c "
  npm install -g @paths.design/caws-cli@$LATEST
  caws --version
  caws validate --help
"

# 3. Run smoke tests
echo "Running smoke tests..."
npm run test:e2e:smoke

# 4. Check GitHub release
echo "Verifying GitHub release..."
gh release view v$LATEST

echo "✅ Rollback verification complete"
```

---

## Communication Templates

### GitHub Issue: Security Patch

```markdown
## Security Advisory: Upgrade to v3.4.2

**Severity**: High  
**Affected Versions**: 3.4.1  
**Fixed Version**: 3.4.2

### Issue

Version 3.4.1 contains a vulnerability that could allow [description].

### Action Required

Upgrade immediately:
\`\`\`bash
npm install -g @paths.design/caws-cli@latest
\`\`\`

### Timeline

- Discovered: 2025-10-10 14:00 UTC
- Fixed: 2025-10-10 15:30 UTC
- Published: 2025-10-10 16:00 UTC

### Credits

Thanks to [@reporter] for responsible disclosure.

For more information, contact security@paths.design
```

### GitHub Issue: Bug Hotfix

```markdown
## Hotfix Released: v3.4.2

Fixes critical validation bug introduced in v3.4.1.

### Issue

CLI validation failed on Windows with path separators.

### Fixed

- Corrected path normalization
- Added cross-platform tests
- Improved error messages

### Upgrade

\`\`\`bash
npm install -g @paths.design/caws-cli@latest
\`\`\`

Closes #123
```

---

## Escalation Procedures

### Level 1: Developer Response

- Non-critical bugs
- Documentation issues
- Minor feature requests

**Contact**: GitHub Issues

---

### Level 2: Maintainer Response

- Critical bugs
- Performance issues
- Breaking change requests

**Contact**: hello@paths.design

---

### Level 3: Security Response

- Security vulnerabilities
- Data privacy issues
- Supply chain attacks

**Contact**: security@paths.design  
**Response Time**: <4 hours

---

### Level 4: Executive Escalation

- Legal issues
- Major incident (P0)
- Business impact

**Contact**: hello@paths.design (mark URGENT)

---

## Post-Incident Review

### Template

```markdown
# Incident Post-Mortem: [Title]

**Date**: 2025-10-10  
**Severity**: P1  
**Duration**: 2 hours  
**Impact**: 500 users affected

## Timeline

- 14:00: Issue reported
- 14:15: Issue confirmed
- 14:30: Root cause identified
- 15:00: Fix developed
- 15:30: Fix tested
- 16:00: Hotfix published
- 16:15: Users notified

## Root Cause

[Technical explanation]

## Impact

- Users affected: ~500
- Downtime: 2 hours
- Data loss: None

## Response

### What Went Well

- Fast detection
- Clear communication
- Good testing

### What Could Improve

- Earlier detection via monitoring
- Better test coverage
- Automated rollback

## Action Items

- [ ] Add monitoring for [metric]
- [ ] Add test for [scenario]
- [ ] Update documentation
- [ ] Schedule training

## Lessons Learned

[Key takeaways]
```

---

## Preventive Measures

### Pre-Release Checks

```bash
# Automated in CI, but manual checklist:
- [ ] All tests pass
- [ ] Security audit clean
- [ ] Lint checks pass
- [ ] Bundle size acceptable
- [ ] Documentation updated
- [ ] CHANGELOG updated
- [ ] Breaking changes documented
```

### Canary Releases (Future)

```bash
# Publish with "next" tag first
npm publish --tag next

# Test with early adopters
npm install -g @paths.design/caws-cli@next

# Promote to latest after validation
npm dist-tag add @paths.design/caws-cli@3.4.1 latest
```

---

## Resources

- **Deployment Guide**: `docs/DEPLOYMENT.md`
- **Security Policy**: `SECURITY.md`
- **Contributing**: `CONTRIBUTING.md`
- **Support**: hello@paths.design

---

**Emergency Contact**: security@paths.design  
**Response Time**: <4 hours for P0/P1 incidents
