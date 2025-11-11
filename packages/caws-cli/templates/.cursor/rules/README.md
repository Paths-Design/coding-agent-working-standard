# Cursor Rules for CAWS Projects

This directory contains modular rule files that Cursor uses to guide development in CAWS projects.

## Rule Files

### Always Applied (Core Governance)

- `00-claims-verification.mdc` - Production readiness claims require rigorous verification
- `01-working-style.mdc` - Default agent behavior, edit style, and risk limits
- `02-quality-gates.mdc` - Comprehensive testing standards and verification requirements
- `03-infrastructure-standards.mdc` - Infrastructure, deployment, and operational standards
- `03-naming-and-refactor.mdc` - Canonical naming enforcement and refactor strategies
- `04-documentation-integrity.mdc` - Documentation must match implementation reality
- `05-production-readiness-checklist.mdc` - Quick reference checklist for production readiness
- `05-safe-defaults-guards.mdc` - Safe defaults, guard clauses, and early returns
- `06-typescript-conventions.mdc` - TypeScript/JS conventions and best practices
- `07-process-ops.mdc` - Process discipline and server management
- `08-solid-and-architecture.mdc` - SOLID principles and architectural patterns
- `09-docstrings.mdc` - Language-specific docstring formats, standards, and file headers
- `10-documentation-quality-standards.mdc` - Engineering-grade documentation standards
- `11-scope-management-waivers.mdc` - Scope management, change budgets, and emergency waiver procedures
- `12-implementation-completeness.mdc` - Anti-fake implementation guardrails with sophisticated TODO detection
- `13-language-agnostic-standards.mdc` - Universal engineering standards (conditional - applies to code files only)

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

## Comprehensive Coverage Areas

### Core Engineering Standards

- **Production Readiness**: Rigorous verification requirements with evidence-based claims and accountability measures
- **Testing Standards**: Complete testing pyramid (unit/integration/E2E) with coverage thresholds and quality gates
- **Infrastructure**: Database, API, security, monitoring, deployment, and operational standards
- **Documentation**: Engineering-grade content with reality alignment verification and prohibited patterns

### Advanced Quality Controls

- **Scope Management**: Change budget enforcement with emergency waiver procedures and critical fix protocols
- **Implementation Completeness**: Anti-fake implementation guardrails with sophisticated TODO detection
- **Language-Agnostic Standards**: Universal patterns across all programming languages with complexity metrics
- **Duplication Prevention**: Canonical naming enforcement and refactor strategies (merge-then-delete)

### Development Workflow Standards

- **Working Style**: Risk-based edit principles with targeted edit plans for complex changes
- **Quality Gates**: Execution discipline, commit hygiene, and automated enforcement
- **Safe Defaults**: Guard clauses, early returns, and defensive programming patterns
- **Process Operations**: Server management, hung command handling, and development discipline

### Code Quality & Architecture

- **SOLID Principles**: Single responsibility, open-closed, Liskov substitution, interface segregation, dependency inversion
- **TypeScript Conventions**: Alias imports, const preferences, and type system management
- **Documentation Standards**: Language-specific docstring formats and comprehensive API documentation
- **Authorship & Attribution**: File headers, authorship tracking, and contribution standards

### Risk-Based Enforcement

- **Tier 1 (Critical Systems)**: 90%+ coverage, 95%+ branch, 70%+ mutation, manual review required
- **Tier 2 (Standard Features)**: 80%+ coverage, 90%+ branch, 50%+ mutation, optional review
- **Tier 3 (Low Risk)**: 70%+ coverage, 80%+ branch, 30%+ mutation, optional review

### Integration with Existing Tooling

- **TODO Analysis**: Sophisticated detection with confidence scoring and context-aware analysis
- **CAWS Workflow**: Seamless integration with CAWS validation, testing, and quality gates
- **Automated Detection**: Ripgrep patterns for banned naming, incomplete implementations, and quality violations

## Key Features

### Sophisticated TODO Detection

- **Context-aware analysis** with confidence scoring (0.0-1.0)
- **Language-specific patterns** for 13+ languages including Rust, Python, JavaScript, TypeScript
- **Code stub detection** beyond just comments (detects `pass`, `...`, `NotImplementedError`, etc.)
- **Dependency resolution** for staged files with blocking analysis
- **Sophisticated exclusion patterns** to prevent false positives

### Risk-Based Quality Gates

- **Tier 1 (Critical)**: Auth, billing, migrations - 90%+ coverage, 70%+ mutation, manual review
- **Tier 2 (Standard)**: Features, APIs, data writes - 80%+ coverage, 50%+ mutation, optional review
- **Tier 3 (Low Risk)**: UI, internal tools - 70%+ coverage, 30%+ mutation, optional review

### Emergency Procedures

- **Scope Management**: Change budget enforcement with automatic detection
- **Waiver System**: Structured procedures for critical fixes outside scope
- **Critical Fix Protocols**: Emergency override conditions with proper documentation

### Anti-Pattern Prevention

- **Banned Naming**: Prevents `enhanced-*`, `new-*`, `final-*` duplicate patterns
- **Implementation Completeness**: Detects fake persistence, stub APIs, placeholder business logic
- **Documentation Reality**: Ensures documented features actually work

## Usage

Cursor automatically loads these rules from `.cursor/rules/`. View active rules in Cursor's sidebar.

To disable a rule temporarily: Cursor Settings → Rules → Toggle specific rule

## Integration with CAWS Workflow

These rules complement CAWS tools and existing project tooling:

- **Validation**: `caws validate` checks rule compliance and working spec validity
- **Testing**: Rules guide comprehensive testing requirements with coverage thresholds
- **Quality Gates**: Automated enforcement of standards with risk-based tiers
- **Documentation**: Ensures docs match implementation reality with engineering-grade standards
- **TODO Analysis**: Sophisticated hidden TODO detection with confidence scoring
- **Scope Management**: Change budget enforcement with emergency waiver procedures
- **Implementation Completeness**: Anti-fake implementation guardrails with stub detection

## Continuous Improvement

Rules are regularly updated based on:

- Industry best practices
- CAWS user feedback
- Production incident analysis
- Security research and compliance updates

For questions about these rules, see the main CAWS documentation or contact the CAWS team.
