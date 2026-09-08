# Security Policy

## Security Overview

CAWS (Coding Agent Working Standard) governs agent behavior through scope guards, a danger latch on destructive git operations, and a hash-chained audit trail (`.caws/events.jsonl`) — the same mechanisms that enforce project quality gates also bound what an agent can touch and record what it did. This document outlines those mechanisms, the current automated checks, and the vulnerability reporting process.

## Security Measures

### Agent governance (CAWS itself)

- **Scope guard**: a spec's `scope.in`/`scope.out` bounds which paths an agent may write; enforced at hook time via `caws scope check`, not by convention.
- **Danger latch**: a hook pack blocks destructive git patterns (force-push, `reset --hard`, `rebase`, `cherry-pick`, `clean -f`, bare `checkout <path>`) and requires a human-run reset to clear.
- **Audit trail**: every governed mutation (spec lifecycle, worktree binding, gate evaluation, claim/takeover) appends a hash-chained event to `.caws/events.jsonl` — tamper-evident, never hand-edited.
- **Waivers, not silent bypass**: a gate violation can only be suppressed via `caws waiver create` (reason, approver, expiry required), not by editing policy or budget fields directly.

### Automated CI checks

- `npm audit --audit-level=critical` runs in `.github/workflows/pr-checks.yml` (advisory — flags critical vulnerabilities, does not currently block the PR).
- TypeScript type-checking and the CLI's Jest suite run in CI (`ci-matrix.yml`) as correctness gates, which also catch classes of logic error with security relevance (e.g. scope-guard bypasses).

There is no dedicated SAST scanner, secret-scanning integration (GitLeaks/TruffleHog), Snyk, Dependabot, SLSA attestation, or SBOM generation wired into this repo today. If you are relying on this document for a compliance attestation, verify current tooling directly against `.github/workflows/` rather than assuming the items below are active.

## Vulnerability Reporting

### Reporting Security Issues

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report security issues privately to our security team at:

**Email**: security@paths.design
**Subject**: [SECURITY] Vulnerability Report for CAWS

### What to Include in Your Report

1. **Description**: Clear description of the vulnerability
2. **Impact**: Potential impact and severity assessment
3. **Reproduction Steps**: Step-by-step instructions to reproduce
4. **Affected Versions**: Which versions are affected
5. **Environment**: Node.js version, OS, and other relevant details
6. **Proof of Concept**: If available, without exposing sensitive data

### Response Process

1. **Acknowledgment**: Initial response within 24 hours
2. **Assessment**: Security team evaluates the report
3. **Confirmation**: Vulnerability confirmed or rejected
4. **Development**: Fix developed and tested
5. **Disclosure**: Coordinated disclosure with reporter
6. **Release**: Security update released

### Response Timeline

- **Critical Issues**: Response within 24 hours, fix within 7 days
- **High Priority**: Response within 48 hours, fix within 14 days
- **Medium Priority**: Response within 72 hours, fix within 30 days
- **Low Priority**: Response within 1 week, fix in next release

## Security Best Practices

### For Users

#### Safe Usage

- Use official CAWS packages from trusted sources
- Keep dependencies updated
- Follow security guidelines in documentation
- Report suspicious behavior

#### Configuration Security

- Use strong, unique project identifiers
- Limit blast radius in working specifications
- Set appropriate rollback SLOs
- Enable security scanning in CI/CD

### For Contributors

#### Secure Development

- Never commit secrets or credentials
- Use the prompt linter for AI-generated code
- Follow tool allowlist restrictions
- Validate all inputs and outputs
- Write security-focused tests

#### Code Review Security

- Review for potential security issues
- Check for proper input validation
- Verify error handling doesn't leak information
- Ensure compliance with security policies

## Security Incident Response

### Incident Detection

- Automated monitoring for suspicious activity
- Security scanning in CI/CD pipelines
- Community reports and feedback
- Dependency monitoring for vulnerabilities

### Incident Response Team

The security incident response team consists of:

- Core maintainers with security expertise
- External security advisors when needed
- Legal counsel for complex incidents

### Incident Communication

- **Internal**: Secure channels for team coordination
- **External**: Coordinated disclosure to affected parties
- **Public**: Transparent updates when appropriate
- **Regulatory**: Compliance with legal reporting requirements

## Security Updates

### Patch Releases

Security fixes are released promptly:

- Critical issues: Immediate patch releases
- High priority: Released within security update cycle
- Regular updates: Included in standard releases

### Upgrade Recommendations

- **Immediate**: Critical security fixes
- **Urgent**: High-priority vulnerabilities
- **Routine**: Regular security improvements
- **Optional**: Enhanced security features

For urgent security matters requiring immediate attention, use the reporting email above — there is no separate emergency channel today.

## Responsible Disclosure

We support responsible disclosure practices:

1. **Private Reporting**: Submit vulnerabilities privately first
2. **Development Time**: Allow reasonable time for fixes
3. **Coordinated Disclosure**: Work together on disclosure timing
4. **Credit Attribution**: Recognize reporters appropriately
5. **No Retaliation**: No negative consequences for ethical security research

## Security Resources

- **Documentation**: Comprehensive security guides
- **Examples**: Secure implementation patterns
- **Tools**: Security utilities and integrations
- **Community**: Security-focused discussions and resources

---

**Last Updated**: 2025
**Contact**: security@paths.design
**Response Time**: 24-72 hours for initial acknowledgment

For security-related questions or concerns, please contact us through the appropriate channels listed above.
