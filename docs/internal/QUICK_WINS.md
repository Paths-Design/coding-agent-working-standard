# CAWS Quick Wins - Developer Experience Improvements

**Priority**: High  
**Timeline**: 1-2 weeks  
**Effort**: Low to Medium

## 🎯 Immediate Impact Improvements

### 1. Better Error Messages (2-3 days)

**Current**:

```
error: unknown option '--suggestions'
```

**Improved**:

```
❌ Unknown option '--suggestions'

💡 The validate command includes suggestions by default
💡 Try: caws validate
💡 Or: caws validate --help

📚 Learn more: https://docs.caws.dev/commands/validate
```

**Implementation**:

```javascript
// src/error-handler.js
const ERROR_SUGGESTIONS = {
  'unknown option': (option) => [
    `The validate command includes suggestions by default`,
    `Try: caws validate`,
    `Or: caws validate --help`,
  ],
  'template not found': () => [
    `Templates are bundled with CAWS CLI`,
    `Try: caws scaffold (should work automatically)`,
    `If issue persists: npm i -g @paths.design/caws-cli@latest`,
  ],
};
```

**Files to Update**:

- `src/error-handler.js` - Add suggestion engine
- `src/commands/*.js` - Add context to errors
- `src/index.js` - Catch common Commander.js errors

---

### 2. TypeScript Auto-Detection (3-4 days)

**Goal**: Detect TypeScript and configure automatically

**Implementation**:

```javascript
// src/utils/project-detector.js
function detectProjectStack() {
  const hasTypeScript = fs.existsSync('tsconfig.json');
  const hasJest = fs.existsSync('jest.config.js') || packageJson.devDependencies?.jest;
  const hasVitest = packageJson.devDependencies?.vitest;

  return {
    language: hasTypeScript ? 'typescript' : 'javascript',
    testFramework: hasJest ? 'jest' : hasVitest ? 'vitest' : 'none',
    needsTestConfig: hasTypeScript && !hasJest && !hasVitest,
  };
}

// src/commands/init.js - enhance wizard
if (detectedStack.needsTestConfig) {
  console.log('📦 TypeScript project detected');
  const addJest = await inquirer.confirm({
    message: 'Configure Jest for TypeScript?',
    default: true,
  });

  if (addJest) {
    await configureJestForTypeScript(projectDir);
  }
}
```

**Files to Update**:

- `src/utils/project-detector.js` - Detection logic
- `src/generators/jest-config.js` - Config generation
- `templates/typescript/` - TS-specific templates
- `src/commands/init.js` - Wizard integration

---

### 3. Status Command (2 days)

**Goal**: Quick project health overview

**Command**:

```bash
caws status
```

**Output**:

```
📊 CAWS Project Status: agent-agency

✅ Working Spec
   ID: AGENT-0001 | Tier: 1 | Mode: feature
   Last validated: 2 hours ago

✅ Git Hooks
   3/3 active: pre-commit, post-commit, pre-push

⚠️  Quality Gates
   Coverage: 65% (target: 90%) - 25% gap
   Mutation: 45% (target: 70%) - 25% gap

✅ Provenance
   Chain: 15 entries | Last: 2 hours ago

💡 Suggestions:
   - Add tests to increase coverage
   - Run: caws diagnose for detailed analysis

📚 Quick Links:
   - View spec: .caws/working-spec.yaml
   - View gates: node apps/tools/caws/gates.js
```

**Implementation**:

```javascript
// src/commands/status.js
async function statusCommand(options) {
  const spec = await loadWorkingSpec();
  const hooks = await checkGitHooksStatus();
  const gates = await checkQualityGates();
  const provenance = await loadProvenanceChain();

  displayStatus({
    spec,
    hooks,
    gates,
    provenance,
    suggestions: generateSuggestions(gates),
  });
}
```

**Files to Create**:

- `src/commands/status.js`
- `src/utils/status-display.js`
- `src/utils/suggestions-engine.js`

---

### 4. Diagnose Command (3 days)

**Goal**: Identify and fix common issues

**Command**:

```bash
caws diagnose
```

**Output**:

```
🔍 Diagnosing CAWS Project...

Running checks:
✅ Working spec validity
✅ Git repository
✅ Git hooks
⚠️  Quality gates configuration
❌ Test configuration

Issues Found:

1. ⚠️  Coverage gate misconfigured
   File: .caws/working-spec.yaml
   Issue: non_functional.coverage not set
   Fix: Add coverage requirements

2. ❌ Jest not configured for TypeScript
   File: Missing jest.config.js
   Issue: TypeScript files won't be tested
   Fix: Run 'caws fix jest-config'

3. ⚠️  Missing test files for 5 modules
   Files: src/services/*.ts
   Issue: No corresponding test files
   Fix: Run 'caws scaffold --tests'

? Apply automatic fixes? (Y/n)
```

**Implementation**:

```javascript
// src/commands/diagnose.js
const CHECKS = [
  checkWorkingSpec,
  checkGitSetup,
  checkGitHooks,
  checkQualityGates,
  checkTestConfiguration,
  checkDependencies,
  checkTypeScriptConfig,
];

async function diagnoseCommand(options) {
  const issues = [];

  for (const check of CHECKS) {
    const result = await check();
    if (!result.passed) {
      issues.push({
        severity: result.severity,
        message: result.message,
        fix: result.fix,
      });
    }
  }

  displayIssues(issues);

  if (options.fix && hasAutomaticFixes(issues)) {
    await applyAutomaticFixes(issues);
  }
}
```

**Files to Create**:

- `src/commands/diagnose.js`
- `src/utils/health-checks/` (multiple check files)
- `src/utils/auto-fix.js`

---

### 5. Template List Command (1 day)

**Goal**: Discover available templates

**Command**:

```bash
caws templates list
```

**Output**:

```
📦 Available CAWS Templates

Built-in Templates:
✅ typescript-library     - Production-ready TS library
✅ typescript-api         - REST API with Express
✅ typescript-monorepo    - Monorepo with workspaces
✅ javascript-package     - NPM package
✅ react-component-lib    - React component library

Usage:
  caws init --template=typescript-library my-project
  caws scaffold --template=typescript-api

📚 Learn more: caws templates --help
```

**Implementation**:

```javascript
// src/commands/templates.js
const BUILTIN_TEMPLATES = {
  'typescript-library': {
    name: 'TypeScript Library',
    description: 'Production-ready TS library',
    path: 'templates/typescript/library',
  },
  // ... more templates
};

async function templatesCommand(subcommand, options) {
  switch (subcommand) {
    case 'list':
      return listTemplates();
    case 'info':
      return showTemplateInfo(options.name);
    default:
      return listTemplates();
  }
}
```

**Files to Create**:

- `src/commands/templates.js`
- `templates/typescript/library/`
- `templates/typescript/api/`
- `templates/typescript/monorepo/`

---

## 📋 Implementation Checklist

### Week 1

- [ ] Implement better error messages
- [ ] Add TypeScript auto-detection
- [ ] Create status command
- [ ] Add template list command

### Week 2

- [ ] Implement diagnose command
- [ ] Create TypeScript templates
- [ ] Add auto-fix capabilities
- [ ] Update documentation

### Testing

- [ ] Unit tests for all new features
- [ ] Integration tests
- [ ] Manual testing on real projects
- [ ] User acceptance testing

### Documentation

- [ ] Update CLI help text
- [ ] Add new commands to guide
- [ ] Create troubleshooting guide
- [ ] Add TypeScript setup guide

---

## 🎯 Success Metrics

**Before**:

- Time to successful init: ~15 minutes (with manual config)
- Common issues encountered: 60%
- User satisfaction: 7/10

**After**:

- Time to successful init: < 5 minutes
- Common issues encountered: < 20%
- User satisfaction: > 8.5/10

---

## 🚀 Quick Start for Developers

### 1. Clone and Setup

```bash
git clone https://github.com/Paths-Design/coding-agent-working-standard
cd coding-agent-working-standard/packages/caws-cli
npm install
npm run build
```

### 2. Make Changes

```bash
# Create new command
cp src/commands/validate.js src/commands/status.js

# Edit and implement
code src/commands/status.js
```

### 3. Test Locally

```bash
npm run build
npm link
caws status  # Test your new command
```

### 4. Submit PR

```bash
git checkout -b feat/status-command
git add .
git commit -m "feat: add status command for project health"
git push origin feat/status-command
```

---

**Owner**: @darianrosebrook  
**Status**: Ready for Implementation  
**Next Review**: Weekly standups
