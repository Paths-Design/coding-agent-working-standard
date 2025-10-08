# Cursor Rules

This directory contains modular rule files in MDC (Markdown Configuration) format that Cursor uses to guide agent behavior.

## Rule Files

### Always Applied (Core Governance)

- `01-working-style.mdc` - Working style, risk limits, and when to ask first
- `02-quality-gates.mdc` - Tests, linting, commit discipline, and TODOs
- `03-naming-and-refactor.mdc` - Canonical naming and anti-duplication enforcement
- `04-logging-language-style.mdc` - Logging clarity, emoji policy, commit tone
- `07-process-ops.mdc` - Server management and hung command handling
- `08-solid-and-architecture.mdc` - SOLID principles and change isolation

### Context-Specific (Auto-Attached or Agent-Requested)

- `05-safe-defaults-guards.mdc` - Defensive coding patterns (agent-requested)
- `06-typescript-conventions.mdc` - TS/JS specific rules (auto-attached to `*.ts`, `*.tsx`)
- `09-docstrings.mdc` - Cross-language documentation reference (agent-requested)
- `10-authorship-and-attribution.mdc` - File header attribution (agent-requested)

## How MDC Works

Each `.mdc` file has frontmatter that controls when it applies:

```yaml
---
description: Brief description of the rule
globs:
  - '**/*.ts' # Auto-attach to matching files
alwaysApply: true # Or false for opt-in rules
---
```

- **alwaysApply: true** - Rule is always active
- **globs: [...]** - Rule auto-attaches when editing matching files
- **alwaysApply: false, no globs** - Rule is agent-requested or manual

## Migration from Legacy Rules

These rules replace the monolithic `.cursorrules` file with:

- Focused, single-responsibility rule files
- Better composability and maintenance
- Language-agnostic core with language-specific extensions
- Clear governance model (always/auto/manual)

## Usage

Cursor automatically loads these rules from `.cursor/rules/`. View active rules in Cursor's sidebar.

To disable a rule temporarily: Cursor Settings → Rules → Toggle specific rule

## Extending

To add language-specific conventions (e.g., Python, Go, Rust):

1. Create a new file like `06-python-conventions.mdc`
2. Set appropriate globs: `["**/*.py"]`
3. Mirror the structure of `06-typescript-conventions.mdc`

## Relationship to AGENTS.md

The root `AGENTS.md` file provides comprehensive workflow instructions for AI agents using CAWS. These `.mdc` rules enforce the standards described in that guide.

- **AGENTS.md**: High-level workflow, patterns, and best practices
- **`.cursor/rules/*.mdc`**: Specific, enforceable rules for Cursor IDE

Together, they provide both guidance (AGENTS.md) and enforcement (rules).
