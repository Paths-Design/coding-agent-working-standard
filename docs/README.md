# CAWS Documentation

This directory contains comprehensive documentation for the CAWS (Coding Agent
Working Standard) framework.

## Documentation Structure

```
docs/
├── README.md                  # This file - documentation overview
├── DOCUMENTATION_STANDARDS.md # Front-matter schema + validator contract
├── command-reference.md       # Authored landing page; full reference is generated when packaging
├── agent-workflow-tools.md    # Agent block-recovery / tool-selection notes
├── failure-lineage.md         # Incident-derived doctrine, entry per failure class
├── v11-surface-matrix.yaml    # v10.2 → v11 command disposition matrix (doctrine)
├── api/                       # API and schema reference
│   ├── cli.md                 # CLI task semantics (defers the option catalogue to --help)
│   ├── schema.md              # Kernel schema specifications
│   └── *.yaml                 # Never-implemented service designs — see api/README.md
├── agents/                    # Agent-specific guides and tutorials
│   ├── EXAMPLES.md            # Agent examples
│   ├── full-guide.md          # Complete agent guide
│   ├── scope-discipline.md    # Pre-edit scope admission procedure
│   └── TUTORIAL.md            # Agent tutorial
├── architecture/              # Architecture doctrine, ADRs, design notes
│   ├── caws-vnext-command-surface.md  # Command-surface doctrine source
│   ├── caws-native-runtime.md         # Native runtime contract
│   ├── event-order.md                 # Event ordering guarantees
│   ├── hook-pack-shared-core.md       # Shared hook-pack core
│   ├── read-surface-authority.v1.yaml # Read-surface authority contract
│   ├── repo-local-hook-policy.md      # Repo-local hook policy
│   ├── session-ownership-metadata.md  # Session ownership metadata design
│   ├── quality-gates-deprecation.md   # Quality-gates package removal
│   ├── cli-ux-job-model-audit.md      # CLI UX audit
│   ├── command-capability-taxonomy.md # Capability classification doctrine
│   ├── command-capability-taxonomy-candidate.md
│   ├── agent-bash-mutation-scope-bypass.md  # Design (not yet built)
│   ├── danger-latch-reset-doctrine-eval.md
│   ├── adr/                   # Architecture decision records
│   └── design/                # Design notes (hook I/O, PID correlation, prepush attribution)
├── audits/                    # Point-in-time qualification reports (dated, not current policy)
├── guides/                    # General guides and documentation
│   ├── agent-integration-guide.md
│   ├── caws-contracts.md
│   ├── caws-developer-guide.md
│   ├── coding-rigor.md
│   ├── command-analysis.md
│   ├── doctor-current-state.md
│   ├── hook-packs.md
│   ├── hooks-and-agent-workflows.md
│   ├── multi-agent-workflow.md
│   ├── placeholder-governance.md     # Historical — see file banner
│   ├── sterling-machine-runtime-migration.md
│   ├── waiver-troubleshooting.md
│   └── worktree-isolation.md
├── philosophy/                # Cross-cutting design philosophy
│   └── reflexivity.md
├── DEPLOYMENT.md              # Hosting / deployment operations
├── MONITORING.md              # Observability and monitoring operations
├── ROLLBACK.md                # Rollback procedures
├── NPM_PUBLISHING_TEST.md     # npm publication and auth testing
├── release-procedure.md       # Tag-driven release procedure
├── release-readiness.md       # Release readiness guidance
├── migration-v10-to-v11.md    # v10.2 → v11 migration guide
├── MIGRATION_GUIDE_V3.5.md    # Superseded historical guide
├── rewrite/                   # vNext rewrite corpus and investigation notes
│   ├── corpus/                # Point-in-time reference corpus (delivered snapshot)
│   └── investigations/        # Point-in-time investigation logs
└── internal/                  # One tracked cutover ledger
                               # (caws-runtime-modernization.md) plus gitignored
                               # local scratch; `git ls-files docs/internal` is the
                               # authority for what is tracked
```

## Core Documentation

### Quick Start Guide

Start with [CLI installation and workflows](api/cli.md), then
[machine runtime setup and adoption](guides/hook-packs.md#machine-adapter-installation).
The [command reference](command-reference.md) explains live help and the
generated package artifact. The CLI package, machine runtime, native
registration, and project governance have separate update and verification
boundaries.

- **Setup**: Installation and configuration steps
- **CLI Usage**: Basic commands and options
- **Project Initialization**: Creating new CAWS projects
- **Quality Gates**: Understanding validation requirements

### Architecture Documentation

- **System Overview**: High-level architecture description
- **Component Design**: Individual component specifications
- **Data Flow**: How data moves through the system
- **Security Model**: Security architecture and practices

### Tool Documentation

- **Validation Tools**: Schema validation and working spec checking
- **Quality Gates**: Automated validation and enforcement
- **Provenance Tools**: Audit trail and attestation generation
- **Security Tools**: Secret detection and compliance checking

### API Reference

- **CLI Commands**: Complete command reference
- **Tool Interfaces**: Programmatic interfaces for tools
- **Configuration Options**: All available configuration parameters
- **Error Codes**: Error handling and troubleshooting

## Advanced Topics

### Security Documentation

- **Security Model**: How CAWS ensures security
- **Threat Modeling**: Identified threats and mitigations
- **Compliance**: Regulatory and industry compliance
- **Best Practices**: Security recommendations

### Testing Documentation

- **Testing Strategy**: Overall approach to testing
- **Test Categories**: Unit, integration, E2E, and mutation testing
- **Coverage Requirements**: Quality thresholds by risk tier
- **Writing Tests**: Guidelines for effective testing

### Contributing Documentation

- **Contribution Process**: How to contribute to CAWS
- **Development Workflow**: Development and testing workflow
- **Code Standards**: Coding conventions and standards
- **Review Process**: Code review guidelines and expectations

## Documentation Standards

### Writing Guidelines

- **Clarity**: Use clear, concise language
- **Structure**: Organize with headings and sections
- **Examples**: Include practical examples when possible
- **Consistency**: Follow established patterns and terminology

### Naming Conventions

- **New file names**: use `kebab-case.md` (e.g., `agent-integration-guide.md`)
- **Directory Names**: Use `kebab-case/` (e.g., `agent-workflows/`)
- **Avoid for new files**: SCREAMING_SNAKE_CASE, camelCase, or spaces in
  filenames
- **Existing exceptions**: earlier docs that use upper-case names
  (`DEPLOYMENT.md`, `MONITORING.md`, `ROLLBACK.md`, `NPM_PUBLISHING_TEST.md`,
  `MIGRATION_GUIDE_V3.5.md`, `DOCUMENTATION_STANDARDS.md`, `agents/EXAMPLES.md`,
  `agents/TUTORIAL.md`) are kept as-is because renaming breaks inbound links;
  the rule applies forward.
- **Purpose-first**: Name files by their primary purpose, not implementation
  details

### Formatting Standards

- **Markdown**: Use standard Markdown syntax
- **Code Blocks**: Properly format code examples
- **Links**: Use relative links for internal references
- **Images**: Include diagrams and screenshots when helpful

### Maintenance

- **Keep Current**: Update documentation with code changes
- **Review Process**: Documentation changes follow same review process
- **Versioning**: Documentation versions with software releases

## Finding Documentation

### Navigation

- **Main README**: Start with the root README.md for overview
- **Package Documentation**: Check individual package READMEs
- **API Reference**: Look in docs/api/ for technical details
- **Agent Guides**: Find agent-specific documentation in docs/agents/
- **General Guides**: Browse step-by-step guides in docs/guides/

### Search and Discovery

- **Table of Contents**: Use TOC in long documents
- **Cross-References**: Link between related documents
- **Index**: Consider creating an index for large documentation sets
- **Search**: Use repository search for specific topics

## Getting Help

### Support Resources

- **Issues**: GitHub issues for bugs and questions
- **Discussions**: GitHub discussions for community interaction
- **Examples**: Sample projects and documentation
- **Community**: Follow community guidelines and conduct

### Documentation Issues

If you find documentation issues:

1. **Check Current**: Ensure you're reading the latest version
2. **Search Issues**: Look for existing documentation issues
3. **Create Issue**: Open a documentation issue with details
4. **Contribute**: Submit a pull request with improvements

## Documentation Roadmap

### Current State

- **Core Documentation**: Basic setup and usage guides
- **API Reference**: Complete tool and command documentation
- **Agent Guides**: Comprehensive agent integration guides
- **General Guides**: Step-by-step guides and tutorials
- **Internal Documentation**: Implementation details and planning docs

### Future Enhancements

- **Interactive Documentation**: Web-based documentation site
- **API Explorer**: Interactive API testing and exploration
- **Video Tutorials**: Video guides for complex topics
- **Community Contributions**: User-contributed guides and examples

## Contributing to Documentation

### How to Contribute

1. **Identify Gaps**: Find areas needing documentation
2. **Write Clearly**: Follow documentation standards
3. **Include Examples**: Add practical examples
4. **Test Instructions**: Ensure instructions work
5. **Submit PR**: Follow contribution process

### Documentation Roles

- **Technical Writers**: Focus on clarity and completeness
- **Developers**: Document new features and APIs
- **Users**: Provide feedback and report issues
- **Maintainers**: Review and merge documentation changes

## Documentation Checklist

### For New Features

- [ ] Feature overview and purpose
- [ ] Installation and setup instructions
- [ ] Usage examples and code samples
- [ ] Configuration options
- [ ] Troubleshooting section
- [ ] API reference if applicable

### For Bug Fixes

- [ ] Problem description
- [ ] Solution explanation
- [ ] Impact assessment
- [ ] Testing verification
- [ ] Migration guidance if needed

### For API Changes

- [ ] Complete API reference
- [ ] Migration guide for breaking changes
- [ ] Deprecation notices
- [ ] Alternative approaches
- [ ] Examples for new usage patterns

## External Resources

- **GitHub Repository**:
  [caws/framework](https://github.com/Paths-Design/coding-agent-working-standard)
- **Issues**:
  [Bug Reports & Features](https://github.com/Paths-Design/coding-agent-working-standard/issues)
- **Discussions**:
  [Community Discussion](https://github.com/Paths-Design/coding-agent-working-standard/discussions)
- **Releases**:
  [Release Notes](https://github.com/Paths-Design/coding-agent-working-standard/releases)
- **Security**:
  [Security Policy](https://github.com/Paths-Design/coding-agent-working-standard/security)

## Contact

For documentation-related questions:

- **Issues**: Report documentation bugs or request improvements
- **Discussions**: Ask questions and share insights
- **Contributions**: Help improve and expand documentation

---

This documentation is maintained by the CAWS community and is continuously
improved based on user feedback and project evolution.
