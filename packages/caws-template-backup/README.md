# CAWS Project Template

This is a template project scaffolded with the **Coding Agent Workflow System (CAWS)** - an engineering-grade operating system for coding agents that ensures quality, reliability, and maintainability.

## 🚀 Quick Start

### For New Projects
1. Copy this template to your project root
2. Run `caws init` to customize the project
3. Update `.caws/working-spec.yaml` with your project details
4. Set up your CI/CD pipeline

### For Existing Projects
1. Copy relevant sections from this template
2. Run `caws scaffold` to add missing components
3. Update existing workflows to include CAWS gates

## 📁 Project Structure

```
├── .caws/                          # CAWS configuration
│   ├── policy/                     # Tier policies and rules
│   ├── schemas/                    # JSON schemas for validation
│   ├── templates/                  # PR and planning templates
│   └── working-spec.yaml          # Project specification
├── .agent/                         # Generated provenance artifacts
├── apps/
│   └── tools/
│       └── caws/                   # CAWS utility tools
├── codemod/                        # AST transformation scripts
├── docs/                           # Documentation
├── tests/                          # Test directories
│   ├── unit/                       # Unit tests
│   ├── contract/                   # Contract tests
│   ├── integration/                # Integration tests
│   ├── e2e/                        # End-to-end tests
│   ├── axe/                        # Accessibility tests
│   └── mutation/                   # Mutation tests
└── .github/
    └── workflows/
        └── caws.yml               # CAWS CI/CD pipeline
```

## 🔧 Customization

### Project Specification
Edit `.caws/working-spec.yaml` to customize:
- **Project ID**: Your ticket system prefix (e.g., FEAT-1234)
- **Title**: Descriptive project name
- **Risk Tier**: 1 (critical), 2 (standard), 3 (low risk)
- **Mode**: `feature`, `refactor`, `fix`, `doc`, `chore`
- **Change Budget**: File and line-of-code limits
- **Scope**: What's in/out of scope
- **Contracts**: API specifications
- **Non-functional**: Performance, security, accessibility requirements

### Risk Tiers
- **Tier 1**: Critical path, auth/billing, migrations (highest rigor)
- **Tier 2**: Features, data writes, cross-service APIs (standard rigor)
- **Tier 3**: Low risk, read-only UI, internal tooling (basic rigor)

## 🛠️ Tools & Commands

### CAWS CLI
```bash
# Initialize new project
caws init my-project

# Scaffold existing project
caws scaffold

# Show version
caws --version
```

### Development Tools
- **prompt-lint.js**: Validates prompts for secrets and tool allowlists
- **attest.js**: Generates SBOM and SLSA attestations
- **rename.ts**: AST codemod for refactoring

## 📋 Requirements

- **Node.js**: >= 20.0.0
- **Git**: For version control and provenance tracking
- **CI/CD**: GitHub Actions (or adapt for other platforms)

## 🔒 Security & Quality Gates

CAWS enforces multiple quality gates:
1. **Naming Guard**: Prevents duplicate file patterns
2. **Scope Guard**: Ensures changes stay within declared scope
3. **Budget Guard**: Enforces file/line-of-code limits
4. **Static Analysis**: Type checking, linting, security scanning
5. **Test Coverage**: Branch and mutation testing requirements
6. **Supply Chain**: SBOM generation and attestation

## 🤝 Contributing

Follow the [Agent Conduct Rules](agents.md#4-agent-conduct-rules-hard-constraints) for collaboration:
1. Adhere to declared scope and mode
2. Maintain determinism with injected dependencies
3. Write comprehensive tests with property-based testing
4. Ensure observability and rollback capabilities
5. Document changes and maintain provenance

## 📚 Documentation

- **[Full CAWS Guide](agents.md)**: Complete system documentation
- **[Working Spec Schema](.caws/schemas/working-spec.schema.json)**: JSON schema for validation
- **[Tier Policy](.caws/policy/tier-policy.json)**: Risk tier definitions
- **[CI/CD Pipeline](.github/workflows/caws.yml)**: Quality gates workflow

## 🎯 Trust Score

CAWS calculates a trust score (0-100) based on:
- Test coverage and mutation adequacy
- Contract compliance and versioning
- Accessibility and performance
- Observability and rollback readiness
- Mode and scope discipline
- Supply chain attestations

Target: ≥ 82/100 for production readiness

## 📞 Support

- 📖 **Documentation**: See `agents.md` for comprehensive guidance
- 🛠️ **Tools**: Check `apps/tools/caws/` for utilities
- 🎯 **Examples**: Review `docs/` for implementation examples
- 🤝 **Community**: Follow agent conduct rules for collaboration

---

**Built with**: CAWS v1.0
**Author**: @darianrosebrook
**License**: MIT
