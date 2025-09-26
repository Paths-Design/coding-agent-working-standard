# Contributing to CAWS

We welcome contributions from the community! This guide will help you get started with contributing to the CAWS (Coding Agent Workflow System) project.

## 🚀 Quick Start

### Prerequisites
- Node.js >= 18.0.0
- npm >= 10.0.0
- Git

### Development Setup
```bash
# 1. Fork the repository
git clone https://github.com/your-username/caws.git
cd caws

# 2. Install dependencies
npm install

# 3. Set up development environment
npm run dev

# 4. Run tests to ensure everything works
npm run test
```

## 📝 Contribution Process

### 1. Create an Issue
Before starting work, open a GitHub issue to discuss:
- Bug reports with reproduction steps
- Feature requests with use cases
- Questions about implementation details
- Documentation improvements

### 2. Fork and Branch
```bash
# Fork the repository on GitHub
# Clone your fork
git clone https://github.com/your-username/caws.git
cd caws

# Create a feature branch
git checkout -b feat/your-feature-name
# or
git checkout -b fix/your-bug-fix
# or
git checkout -b docs/your-documentation-update
```

### 3. Make Changes
Follow these guidelines when making changes:

#### Code Standards
- **TypeScript First**: Use TypeScript for new code and APIs
- **Quality Gates**: Ensure all automated checks pass
- **Testing**: Write comprehensive tests with property-based testing where applicable
- **Documentation**: Update JSDoc comments and relevant documentation
- **Provenance**: Update provenance manifests for significant changes

#### Testing Requirements
- **Unit Tests**: Test individual functions and components
- **Integration Tests**: Test component interactions
- **Edge Cases**: Include tests for error conditions and boundary cases
- **Property Tests**: Use property-based testing where appropriate

#### Documentation Updates
- Update README sections for new features
- Add examples for new functionality
- Update API documentation
- Keep inline code comments current

### 4. Test Thoroughly
```bash
# Run all tests
npm run test

# Run specific package tests
cd packages/caws-cli
npm run test

# Check linting
npm run lint

# Validate configurations
npm run validate
```

### 5. Update Documentation
- Update relevant README sections
- Add examples for new functionality
- Update API documentation if needed
- Keep inline comments current

### 6. Create Pull Request
Submit a pull request with:
- **Clear Title**: Brief description of changes
- **Detailed Description**: What was changed and why
- **Working Specification**: Include scope and acceptance criteria
- **Test Results**: Show that all tests pass
- **Screenshots**: If UI changes are involved

## 🧪 Testing Guidelines

### Test Categories
1. **Unit Tests**: Test individual functions and components in isolation
2. **Integration Tests**: Test interactions between components
3. **E2E Tests**: Test complete user workflows
4. **Property Tests**: Test with generated inputs to find edge cases
5. **Mutation Tests**: Ensure test effectiveness

### Coverage Requirements
- **Tier 1 Projects**: ≥90% branch coverage, ≥70% mutation score
- **Tier 2 Projects**: ≥80% branch coverage, ≥50% mutation score
- **Tier 3 Projects**: ≥70% branch coverage, ≥30% mutation score

### Writing Good Tests
```javascript
// ✅ Good test - descriptive, focused, with assertions
describe('Working Spec Validation', () => {
  test('should validate correct working spec', () => {
    const validSpec = { /* ... */ };
    expect(() => validateSpec(validSpec)).not.toThrow();
  });

  test('should reject invalid risk tier', () => {
    const invalidSpec = { risk_tier: 4 };
    expect(() => validateSpec(invalidSpec)).toThrow('Invalid risk tier');
  });
});
```

## 📚 Documentation Guidelines

### README Updates
- Keep the main README as the primary entry point
- Add detailed guides to package-specific documentation
- Include practical examples for new features
- Update installation and usage instructions

### Code Documentation
- Use JSDoc comments for all public APIs
- Include parameter descriptions and return types
- Add examples for complex functions
- Document any side effects or dependencies

### API Documentation
- Document all CLI commands and options
- Include examples for each tool
- Specify input and output formats
- Document error conditions

## 🔒 Security Considerations

### Secure Development Practices
- Never commit secrets or credentials
- Use the prompt linter for AI-generated code
- Follow tool allowlist restrictions
- Validate all inputs and outputs

### Reporting Security Issues
- Report security vulnerabilities privately
- Do not create public issues for security concerns
- Use responsible disclosure practices
- Include reproduction steps and impact assessment

## 🤝 Community Guidelines

### Communication Standards
- Be respectful and constructive in discussions
- Use clear and professional language
- Focus on technical merit rather than personal preferences
- Acknowledge contributions from others

### Collaboration Practices
- Review pull requests thoroughly
- Provide constructive feedback
- Help new contributors get started
- Share knowledge and learnings

### Code Review Guidelines
- Focus on code quality and functionality
- Suggest improvements rather than just pointing out issues
- Test suggested changes when possible
- Approve when requirements are met

## 📋 Pull Request Checklist

Before submitting a PR, ensure:

- [ ] **Issue Created**: Related GitHub issue exists
- [ ] **Tests Pass**: All tests pass locally
- [ ] **Linting Clean**: No ESLint errors or warnings
- [ ] **Documentation Updated**: README and docs updated
- [ ] **Examples Added**: Practical examples included
- [ ] **Working Spec**: Scope and acceptance criteria documented
- [ ] **Quality Gates**: All validation checks pass
- [ ] **Provenance**: Manifest updated if needed

## 🐛 Bug Reports

When reporting bugs, include:

1. **Description**: Clear description of the issue
2. **Reproduction Steps**: Step-by-step instructions to reproduce
3. **Expected Behavior**: What should happen
4. **Actual Behavior**: What actually happens
5. **Environment**: Node.js version, OS, etc.
6. **Logs**: Any relevant error messages or logs

## ✨ Feature Requests

When requesting features, include:

1. **Use Case**: Why this feature is needed
2. **Examples**: How it would be used
3. **Alternatives**: Other solutions considered
4. **Impact**: How it affects existing functionality
5. **Implementation Ideas**: High-level implementation thoughts

## 📞 Getting Help

### Support Channels
- **GitHub Issues**: Bug reports and feature requests
- **Discussions**: General questions and community discussion
- **Documentation**: Comprehensive guides and examples
- **Examples**: Sample projects for reference

### Community Resources
- **Code Examples**: Look at existing implementations
- **Issue History**: Search past issues for solutions
- **Documentation**: Check README and docs for guidance
- **Community**: Follow agent conduct rules

## 🎯 Recognition

Contributors are recognized for their efforts through:
- **GitHub Recognition**: Stars, forks, and mentions
- **Changelog**: Credit in release notes
- **Documentation**: Author attribution where appropriate
- **Community**: Recognition in community spaces

## 📜 License

By contributing to CAWS, you agree that your contributions will be licensed under the same MIT License that covers the project.

---

Thank you for contributing to CAWS! Your efforts help make this a better tool for the entire community.
