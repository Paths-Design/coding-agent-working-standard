---
doc_id: caws-rollback
authority: reference
status: active
title: CAWS Rollback & Incident Response
owner: vNext rewrite team
updated: 2026-05-28
---

# CAWS Rollback & Incident Response

**Author**: @darianrosebrook  
**Last Updated**: 2026-05-28  
**Status**: Production Ready

## Overview

This document provides procedures for rolling back bad releases and responding to production incidents for CAWS packages. For the canonical release procedure (how to publish a new version), see `docs/release-procedure.md`.

**Key release facts:**
- Releases are **tag-driven**. The Release workflow triggers ONLY on `push: tags: [caws-cli-v*, caws-kernel-v*, v*]`. Pushing to `main` NEVER triggers a publish.
- Only `caws-cli-v*` tags are **accepted**. Bare `v*` and `caws-kernel-v*` tags are observed, refused, and deleted from origin.
- The publish script is `scripts/release-tag-publish.mjs`. CI does NOT invoke `semantic-release`, does NOT bump versions, and does NOT generate changelogs.
- Canonical tag format: `caws-cli-vX.Y.Z` (e.g. `caws-cli-v11.1.6`). GitHub Releases use this full tag name.
- Asymmetric failure invariant: pre-publish failures DELETE the tag; post-publish ancillary failures PRESERVE it.

---

## Quick Reference

| Scenario                   | Action             | Time to Resolution |
| -------------------------- | ------------------ | ------------------ |
| **Broken npm package**     | Deprecate + hotfix | 15-30 minutes      |
| **Security vulnerability** | Emergency patch    | 1-4 hours          |
| **Failed CI/CD**           | Revert commit + re-tag | 5-10 minutes   |
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
npm deprecate @paths.design/caws-cli@11.1.5 "Known issue: validation fails on Windows. Use 11.1.4 or wait for 11.1.6"

# 3. Verify deprecation
npm view @paths.design/caws-cli

# 4. Notify users via GitHub Release notes (use the full tag name)
gh release edit caws-cli-v11.1.5 --notes "This release has been deprecated. Use 11.1.4 or wait for 11.1.6"

# 5. Prepare and publish a hotfix
git checkout main
git revert <bad-commit>
git add packages/caws-cli/CHANGELOG.md packages/caws-cli/package.json
git commit -m "chore(release): caws-cli 11.1.6"
# Push the commit (does NOT publish — a tag push is required)
git push origin main
# Tag and push to trigger CI publish
git tag caws-cli-v11.1.6 -m "Release caws-cli 11.1.6"
git push origin caws-cli-v11.1.6
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
# 1. Pull latest main
git checkout main
git pull origin main

# 2. Fix the issue
# ... make code changes ...

# 3. Commit the fix
git add .
git commit -m "fix: resolve critical validation bug

This fixes the Windows path handling issue introduced in 11.1.5

Fixes #123"

# 4. Bump version and update CHANGELOG
# Edit packages/caws-cli/package.json: "version": "11.1.6"
# Add section to packages/caws-cli/CHANGELOG.md for 11.1.6
git add packages/caws-cli/CHANGELOG.md packages/caws-cli/package.json
git commit -m "chore(release): caws-cli 11.1.6"

# 5. Push the commit (does NOT trigger publish)
git push origin main

# 6. Tag and push to trigger CI publish
git tag caws-cli-v11.1.6 -m "Release caws-cli 11.1.6"
git push origin caws-cli-v11.1.6

# 7. Watch the workflow
gh run watch

# 8. Verify the release
npm view @paths.design/caws-cli version
# Should show 11.1.6

gh release view caws-cli-v11.1.6
# Should show the GitHub Release

# 9. Optional: Deprecate bad version
npm deprecate @paths.design/caws-cli@11.1.5 "Fixed in 11.1.6"
```

**User Impact**: Low - users update to fixed version

**Timeline**: 15-30 minutes (including CI)

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
npm unpublish @paths.design/caws-cli@11.1.5

# 3. Verify removal
npm view @paths.design/caws-cli versions
# 11.1.5 should be missing

# 4. Prepare and publish a fixed version
git revert <bad-commit>
git add packages/caws-cli/CHANGELOG.md packages/caws-cli/package.json
git commit -m "chore(release): caws-cli 11.1.6"
git push origin main
git tag caws-cli-v11.1.6 -m "Release caws-cli 11.1.6"
git push origin caws-cli-v11.1.6
# CI publishes 11.1.6 when the tag push completes

# 5. Notify users who may have installed
gh issue create --title "SECURITY: Upgrade from 11.1.5 immediately" \
  --body "Version 11.1.5 has been unpublished due to security issue. Upgrade to 11.1.6."
```

**User Impact**: HIGH - breaks existing installations

**Use only for**: Critical security vulnerabilities

---

### Strategy 4: Major Version Rollback

**When to use**: Breaking changes need to be reverted across a major version line

**Procedure**:

```bash
# If a major version introduced breaking changes that need rollback:

# 1. Don't unpublish major versions
# 2. Document why the major version is problematic
# 3. Continue supporting the prior stable line

# 4. Move the latest dist-tag back to the last known-good version
npm dist-tag add @paths.design/caws-cli@11.1.4 latest

# This makes 11.1.4 the default install again.
# Users on the broken version can stay pinned, but new installs get 11.1.4.

# 5. Announce via GitHub (use the full canonical tag name)
gh release create caws-cli-v11.1.4-lts \
  --title "caws-cli v11.1.4 (LTS)" \
  --notes "Pinned as LTS. See release notes for why later versions are not recommended."
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
npm deprecate @paths.design/caws-cli@11.1.5 "CRITICAL SECURITY ISSUE - DO NOT USE"

# Option B: Unpublish (if <72h)
npm unpublish @paths.design/caws-cli@11.1.5

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

# 6. Merge fix and bump version
git checkout main
git merge hotfix/security-patch
# Edit packages/caws-cli/package.json: bump to 11.1.6
# Add CHANGELOG.md section for 11.1.6
git add packages/caws-cli/CHANGELOG.md packages/caws-cli/package.json
git commit -m "chore(release): caws-cli 11.1.6"
git push origin main

# 7. Tag and push to trigger CI publish (branch push alone does NOT publish)
git tag caws-cli-v11.1.6 -m "Release caws-cli 11.1.6 - critical security patch"
git push origin caws-cli-v11.1.6

# Watch CI
gh run watch

# === FOLLOW-UP (1-24 hours) ===

# 8. Issue CVE if needed
# Contact GitHub Security Advisory
# https://github.com/Paths-Design/coding-agent-working-standard/security/advisories/new

# 9. Post-mortem
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
npm install -g @paths.design/caws-cli@<bad-version>
cd test-project && caws doctor

# 2. Check error reports
gh issue list --label "bug" --label "priority:high"

# 3. Identify root cause
git log --oneline -10
git diff caws-cli-v11.1.4...caws-cli-v11.1.5

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

# === RELEASE (requires explicit tag push) ===

# 7. Bump version, update CHANGELOG, commit, tag, push
# Edit packages/caws-cli/package.json: bump version
# Add CHANGELOG.md section
git add packages/caws-cli/CHANGELOG.md packages/caws-cli/package.json
git commit -m "chore(release): caws-cli 11.1.6"
git push origin main
git tag caws-cli-v11.1.6 -m "Release caws-cli 11.1.6"
git push origin caws-cli-v11.1.6

# Monitor CI
gh run watch

# 8. Verify fix
npm install -g @paths.design/caws-cli@latest
cd test-project && caws doctor

# === COMMUNICATE ===

# 9. Update GitHub issue
gh issue comment 123 --body "Fixed in 11.1.6. Please upgrade: npm install -g @paths.design/caws-cli@latest"

# 10. Update release notes (use full tag name)
gh release edit caws-cli-v11.1.6 --notes "Hotfix for validation failure introduced in 11.1.5"
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

echo "Verifying rollback..."

# 1. Check npm package
LATEST=$(npm view @paths.design/caws-cli version)
echo "Latest version on npm: $LATEST"

# 2. Test fresh install
echo "Testing fresh install..."
docker run --rm node:22-alpine sh -c "
  npm install -g @paths.design/caws-cli@$LATEST
  caws --version
  caws --help
"

# 3. Run smoke tests
echo "Running smoke tests..."
npm run test:e2e:smoke

# 4. Check GitHub release (GitHub Releases use the full caws-cli-vX.Y.Z tag name)
echo "Verifying GitHub release..."
gh release view "caws-cli-v$LATEST"

echo "Rollback verification complete"
```

---

## Communication Templates

### GitHub Issue: Security Patch

```markdown
## Security Advisory: Upgrade to v11.1.6

**Severity**: High  
**Affected Versions**: 11.1.5  
**Fixed Version**: 11.1.6

### Issue

Version 11.1.5 contains a vulnerability that could allow [description].

### Action Required

Upgrade immediately:
\`\`\`bash
npm install -g @paths.design/caws-cli@latest
\`\`\`

### Timeline

- Discovered: 2026-05-28 14:00 UTC
- Fixed: 2026-05-28 15:30 UTC
- Published: 2026-05-28 16:00 UTC

### Credits

Thanks to [@reporter] for responsible disclosure.

For more information, contact security@paths.design
```

### GitHub Issue: Bug Hotfix

```markdown
## Hotfix Released: v11.1.6

Fixes critical validation bug introduced in v11.1.5.

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

**Date**: 2026-05-28  
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
- [ ] CHANGELOG updated (packages/caws-cli/CHANGELOG.md)
- [ ] packages/caws-cli/package.json version bumped to match tag
- [ ] Breaking changes documented
```

### Canary Releases (Future)

```bash
# Publish with "next" tag first (requires a caws-cli-v*-next tag or manual publish)
npm publish --tag next

# Test with early adopters
npm install -g @paths.design/caws-cli@next

# Promote to latest after validation
npm dist-tag add @paths.design/caws-cli@11.1.6 latest
```

---

## Resources

- **Release Procedure**: `docs/release-procedure.md` (canonical — read this first)
- **Security Policy**: `SECURITY.md`
- **Contributing**: `CONTRIBUTING.md`
- **Support**: hello@paths.design

---

**Emergency Contact**: security@paths.design  
**Response Time**: <4 hours for P0/P1 incidents
