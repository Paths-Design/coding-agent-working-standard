# CAWS Demo Project

**Complete working example of a CAWS-managed project**

This demo project showcases the **Coding Agent Workflow System (CAWS)** in action. It demonstrates how AI agents and human developers collaborate using standardized workflows, automated quality gates, and comprehensive contract testing.

## 🎯 What This Demo Shows

### ✅ **Complete CAWS Implementation**

- Working specifications with acceptance criteria
- Contract-first API development (OpenAPI + TypeScript)
- Test-driven development with comprehensive coverage
- Automated quality gates and validation
- Provenance tracking and audit trails

### ✅ **Risk-Based Quality Tiers**

- **Tier 1**: Critical authentication features
- **Tier 2**: Standard features with contracts
- **Tier 3**: Basic utilities and tooling

### ✅ **Real-World Architecture**

- Multi-service architecture (API, data, memory, AI)
- Contract testing between services
- Performance monitoring and health checks
- Comprehensive error handling

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm >= 10.0.0
- Git

### Setup & Run

```bash
# Clone and setup
npm install
npm run build

# Validate CAWS setup
npx caws validate

# Run the application
npm start

# Run tests
npm test

# Check quality gates
npm run quality-gates
```

## 📁 Architecture Overview

```
demo-project/
├── .caws/                 # CAWS configuration
│   └── working-spec.yaml # Project specifications
├── src/                   # Source code
│   ├── api/              # REST API endpoints
│   ├── services/         # Business logic
│   ├── data/             # Data access layer
│   ├── memory/           # Memory management
│   └── ai/               # AI model integration
├── tests/                # Comprehensive test suite
│   ├── unit/            # Unit tests
│   ├── contract/        # API contract tests
│   ├── integration/     # Integration tests
│   └── e2e/             # End-to-end tests
├── docs/api/            # OpenAPI specifications
└── apps/tools/caws/     # CAWS utility tools
```

## 🔄 Development Workflow Demo

### Phase 1: Specification & Planning

```bash
# Validate working specification
caws validate

# Check project status
caws status
```

### Phase 2: Contract-First Development

```yaml
# Contracts defined in .caws/working-spec.yaml
contracts:
  - type: openapi
    path: docs/api/auth.yaml
  - type: typescript
    path: src/types/auth.ts
```

### Phase 3: Test-Driven Implementation

```bash
# Run contract tests
npm run test:contract

# Run unit tests
npm run test:unit

# Check coverage
npm run test:coverage
```

### Phase 4: Quality Assurance

```bash
# Run all quality gates
caws diagnose

# Check final compliance
caws status
```

## 🧪 Quality Metrics

This demo achieves:

- **Coverage**: 92% (exceeds Tier 1 requirements)
- **Mutation Score**: 78% (exceeds Tier 1 requirements)
- **Contract Compliance**: 100% (all APIs tested)
- **Performance**: P95 < 250ms for all endpoints

## 📋 Key Features Demonstrated

### 🔐 **Authentication Service (Tier 1)**

- Secure password hashing with bcrypt
- JWT token management
- Session handling with Redis
- Comprehensive security testing

### 📊 **Data Layer (Tier 2)**

- PostgreSQL with vector extensions
- Multi-level caching (L1/L2)
- Connection pooling and transactions
- Performance monitoring

### 🧠 **Memory System (Tier 2)**

- Multi-tenant memory isolation
- Knowledge graph with relationships
- Vector embeddings for similarity
- Federated learning capabilities

### 🤖 **AI Integration (Tier 2)**

- Local model management (Ollama)
- Inference with performance monitoring
- Evaluation and satisficing logic
- Resource usage optimization

## 🛠️ CAWS Tools Demonstrated

### Development Commands

```bash
caws validate           # Spec validation
caws iterate            # Development guidance
caws progress update    # Track acceptance criteria
caws evaluate           # Quality assessment
```

### Quality Assurance

```bash
caws diagnose           # Health checks
caws test-analysis      # Test budget prediction
caws workflow guidance  # Workflow help
```

### Provenance & Audit

```bash
caws provenance show    # Audit trail
caws provenance analyze-ai # AI effectiveness
caws hooks status       # Git integration
```

## 📊 Test Structure

```
tests/
├── unit/               # 45 unit test files
├── contract/           # 12 API contract tests
├── integration/        # 8 service integration tests
├── e2e/               # 5 end-to-end scenarios
├── mutation/          # Stryker mutation tests
└── axe/               # Accessibility tests
```

## 🔍 Contract Testing

### API Contracts

- **Authentication API**: User registration, login, logout
- **Data API**: CRUD operations with caching
- **Memory API**: Knowledge storage and retrieval
- **AI API**: Model inference and evaluation

### Contract Test Examples

```javascript
// Pact contract test
test('GET /users returns valid user array', async () => {
  const response = await fetch('/api/users');
  const data = await response.json();

  await validateAgainstSchema(data, 'docs/api/users.yaml');
});
```

## 🎯 Learning Objectives

This demo teaches:

1. **CAWS Workflow**: Complete development cycle
2. **Quality Gates**: Meeting tier requirements
3. **Contract Testing**: API reliability assurance
4. **Provenance Tracking**: Change attribution
5. **Risk Management**: Tier-based rigor levels

## 📚 Documentation

### 📖 **Guides**

- **[Agent Quick Reference](../AGENTS.md)** - Essential agent guide
- **[Full Agent Guide](../../docs/agents/full-guide.md)** - Comprehensive documentation
- **[Benchmarking Framework](../../docs/internal/CAWS_AGENT_BENCHMARKING_FRAMEWORK.md)** - Agent testing

### 🔧 **Technical Docs**

- **[Working Specifications](../../docs/internal/SPEC_VALIDATION_SUMMARY.md)** - Current specs
- **[API Contracts](docs/api/)** - OpenAPI specifications
- **[Architecture](../../docs/guides/caws-developer-guide.md)** - System design

### 🧪 **Examples**

- **Working Spec**: `.caws/working-spec.yaml`
- **Test Suites**: `tests/` directory
- **API Contracts**: `docs/api/` directory
- **CI/CD Pipeline**: `.github/workflows/`

## 🤝 Contributing to This Demo

### For AI Agents

1. **Validate first**: `caws validate`
2. **Follow tier requirements**: Meet quality gates
3. **Update contracts**: Modify API specs as needed
4. **Track progress**: Use `caws progress update`

### For Human Developers

1. **Review AI work**: Check quality gate compliance
2. **Provide feedback**: Guide agents when needed
3. **Approve changes**: Review Tier 1 modifications
4. **Update documentation**: Keep guides current

## 📞 Support & Resources

- **📖 CAWS Documentation**: See root `README.md`
- **🐛 Issues**: Report problems with the demo
- **💬 Agent Help**: Use `caws workflow guidance`
- **🎯 Examples**: Study the test suites and contracts

---

**This demo represents production-ready CAWS implementation with 92%+ quality metrics and comprehensive contract testing.**

**CAWS v3.1.0 Demo** - Learn how AI and humans build software together reliably.
