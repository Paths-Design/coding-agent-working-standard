# /caws-guided-development

## CAWS-Guided Feature Development Workflow

**Purpose**: Guide agents through feature development with CAWS quality assurance

**Tags**: development, quality, caws, feature

---

### 1. Initialize CAWS Working Spec
```
# Create comprehensive working specification
caws init feature-name --interactive

# Define acceptance criteria, scope, and risk assessment
# Working spec: .caws/working-spec.yaml
```

### 2. Plan Implementation Strategy
```
# Get CAWS guidance for implementation approach
caws agent iterate --current-state "Planning phase complete, need implementation strategy"

# CAWS will suggest:
# - Implementation steps
# - Quality gates to consider
# - Risk mitigation strategies
# - Testing approach
```

### 3. Implement Core Functionality
```
# Start coding with CAWS quality monitoring
# Real-time feedback via CAWS tools

# Regular quality checks
caws agent evaluate --quiet
```

### 4. Quality Assurance Integration
```
# Run comprehensive quality gates
caws validate

# Address any failing gates
# Create waivers if justified
caws waivers create --reason emergency_hotfix --gates coverage_threshold
```

### 5. Testing & Validation
```
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# Contract tests
npm run test:contract
```

### 6. Final Quality Review
```
# Complete CAWS evaluation
caws agent evaluate

# Generate provenance report
caws provenance generate

# Ready for integration
```

---

**Quality Gates**:
- ✅ Working spec validation
- ✅ Code quality standards
- ✅ Test coverage requirements
- ✅ Security scanning
- ✅ Performance budgets

**Success Criteria**:
- All CAWS quality gates pass
- Acceptance criteria met
- No critical security issues
- Performance requirements satisfied

**Call Other Workflows**:
- `/caws-testing-workflow` - Comprehensive testing
- `/caws-security-review` - Security validation
- `/caws-deployment-checklist` - Deployment preparation
