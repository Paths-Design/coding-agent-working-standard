# Cursor Rules for CAWS Projects

This directory contains modular rule files that Cursor uses to guide development in CAWS projects.

## Rule Files

### Always Applied (Core Governance)

- `01-claims-verification.mdc` - Production readiness claims require verification
- `02-testing-standards.mdc` - Comprehensive testing standards and verification
- `03-infrastructure-standards.mdc` - Infrastructure, deployment, and operational standards
- `04-documentation-integrity.mdc` - Documentation must match implementation reality
- `05-production-readiness-checklist.mdc` - Quick reference checklist for production readiness

## How MDC Works

Each `.mdc` file has frontmatter that controls when it applies:

```yaml
---
description: Brief description of the rule
globs:
alwaysApply: true
---
```

- **alwaysApply: true** - Rule is always active
- **globs: [...]** - Rule auto-attaches when editing matching files

## CAWS Quality Standards

These rules enforce CAWS quality tiers:

| Tier      | Coverage | Mutation | Use Case                    |
| --------- | -------- | -------- | --------------------------- |
| 🔴 **T1** | 90%+     | 70%+     | Auth, billing, migrations   |
| 🟡 **T2** | 80%+     | 50%+     | Features, APIs, data writes |
| 🟢 **T3** | 70%+     | 30%+     | UI, internal tools          |

## Usage

Cursor automatically loads these rules from `.cursor/rules/`. View active rules in Cursor's sidebar.

To disable a rule temporarily: Cursor Settings → Rules → Toggle specific rule

## Integration with CAWS Workflow

These rules complement CAWS tools:

- **Validation**: `caws validate` checks rule compliance
- **Testing**: Rules guide comprehensive testing requirements
- **Quality Gates**: Automated enforcement of standards
- **Documentation**: Ensures docs match implementation reality

## Continuous Improvement

Rules are regularly updated based on:

- Industry best practices
- CAWS user feedback
- Production incident analysis
- Security research and compliance updates

For questions about these rules, see the main CAWS documentation or contact the CAWS team.
