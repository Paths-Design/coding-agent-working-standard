# CAWS Quality Gates - Staged Files Analysis

## Overview

CAWS Quality Gates provides comprehensive quality analysis focused on staged files only, eliminating false positives from untouched code. This approach aligns with modern development workflows where developers want to gate their changes without being blocked by issues in unrelated files.

## Features

### 🎯 **Staged Files Only**
- Analyzes only files in git staging area (`git diff --cached --name-only`)
- Eliminates false positives from untouched code
- Fast execution focused on actual changes

### 🏗️ **God Object Detection**
- Identifies files approaching or exceeding size thresholds
- Configurable warning (1750 LOC) and critical (2000 LOC) limits
- Language-specific analysis (Rust, TypeScript, JavaScript, Python)
- **Crisis Mode**: Higher thresholds (3000 LOC) for emergency situations

### 🔍 **Advanced Hidden TODO Analysis**
- **Enhanced Pattern Detection**: Context-aware analysis with reduced false positives
- **Code Stub Detection**: Identifies `pass`, `NotImplementedError`, `throw new Error("TODO")` patterns
- **Engineering-Grade TODO Templates**: Automatic suggestions for CAWS-compliant TODO format
- **Dependency Resolution**: Smart analysis of TODO blocking status based on dependencies
- **Multi-Language Support**: Rust, Python, JavaScript, TypeScript, Go, Java, C#, C++, and more
- **Confidence Scoring**: Context-aware confidence levels (0.0-1.0) with documentation filtering
- **CAWS Tier Integration**: Different thresholds and requirements based on project tier
- **Crisis Mode**: Stricter confidence thresholds (0.9 vs 0.8) for emergency situations

### 🎯 **CAWS Tier Integration**
- Tier 1: 90% coverage, 70% mutation, contracts required, manual review
- Tier 2: 80% coverage, 50% mutation, contracts optional
- Tier 3: 70% coverage, 30% mutation, basic checks

### 🚨 **Waiver System Integration**
- Honors active waivers from `.caws/waivers.yml`
- Supports waiver expiration and status validation
- Gate-specific waiver matching
- Audit trail for waived checks

### 🚨 **Crisis Response Mode**
- Automatic detection from working spec, environment, or commit messages
- Relaxed thresholds for emergency situations
- Clear crisis mode indicators in output
- Guidance for creating waivers during crises

### 👤 **Human Override Support**
- Respects human overrides from working spec
- Bypasses quality gates when human override is active
- Audit trail for override decisions

### 📊 **Provenance Tracking**
- Automatic tracking of quality gate runs
- Error statistics and classification
- Agent type detection (Cursor IDE, VS Code, CLI)
- Crisis mode and waiver tracking
- JSONL journal format for analysis

### 🔍 **Comprehensive Error Taxonomy**
- Structured error types with context and recovery strategies
- Error classification by category, severity, and retryability
- Recovery strategy recommendations
- Error statistics and trend analysis

## Usage

### Command Line

```bash
# Run quality gates on staged files
caws quality-gates

# CI mode (exit with error code on violations)
caws quality-gates --ci

# Check specific languages
caws quality-gates --languages rust,typescript

# Skip specific checks
caws quality-gates --no-todos --no-god-objects
```

### Git Hooks (Automatic)

Quality gates are automatically integrated into git hooks when you run:

```bash
caws scaffold
```

This creates a pre-commit hook that runs:
1. Quality gates on staged files
2. Hidden TODO analysis on staged files
3. Blocks commits with violations

### Manual Script Execution

```bash
# Run quality gates script directly
node scripts/quality-gates/run-quality-gates.js

# Run god object detector
node scripts/quality-gates/check-god-objects.js
```

## Configuration

### Quality Gate Thresholds

```javascript
const CONFIG = {
  godObjectThresholds: {
    warning: 1750,    // Lines of code
    critical: 2000,
  },
  todoConfidenceThreshold: 0.8,
  supportedExtensions: ['.rs', '.ts', '.tsx', '.js', '.jsx', '.py'],
  crisisResponseThresholds: {
    godObjectCritical: 3000,  // Higher threshold in crisis mode
    todoConfidenceThreshold: 0.9,  // Stricter TODO detection
  },
};
```

### Waiver Configuration

Create `.caws/waivers.yml` to define quality gate waivers:

```yaml
waivers:
  - id: "emergency-hotfix-001"
    title: "Emergency hotfix for production issue"
    reason: "emergency_hotfix"
    description: "Critical production bug requiring immediate fix"
    gates: ["god_objects", "hidden_todos"]
    approved_by: "tech-lead@company.com"
    impact_level: "high"
    mitigation_plan: "Full refactoring scheduled for next sprint"
    expires_at: "2024-01-15T23:59:59Z"
    status: "active"
    metadata:
      jira_ticket: "PROD-1234"
      incident_id: "INC-5678"
```

### Provenance Tracking

Quality gates automatically track execution data in `.caws/provenance/`:

```json
{
  "id": "qg-1704067200000-a1b2c3d4",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "commit_hash": "abc123def456",
  "crisis_mode": false,
  "staged_files": 5,
  "results": {
    "passed": true,
    "violations": 0,
    "warnings": 1,
    "todos": 0,
    "waived_checks": {
      "god_objects": false,
      "hidden_todos": false
    }
  },
  "error_statistics": {
    "total": 1,
    "byCategory": {
      "business_logic": 1
    },
    "bySeverity": {
      "warning": 1
    },
    "retryable": 0,
    "requiresHumanIntervention": 0,
    "canAutoRecover": 1
  },
  "metadata": {
    "caws_tier": 2,
    "human_override": false,
    "agent_type": "cursor-ide"
  }
}
```

### Error Taxonomy

Quality gates use structured error types with recovery strategies:

```javascript
// God Object Error
const error = createGodObjectError('src/large.rs', 2500, 2000, {
  fileSizeKB: 45.2,
  crisisMode: false,
});

// Error properties
error.category;           // 'business_logic'
error.severity;          // 'error' or 'critical'
error.retryable;         // false
error.recoveryStrategies; // ['manual_intervention', 'waiver']
error.requiresHumanIntervention(); // true
error.canAutoRecover();  // false
```

#### Error Categories

- **`validation`**: Input validation failures
- **`configuration`**: Configuration errors
- **`execution`**: Command execution failures
- **`network`**: Network/API failures
- **`security`**: Security violations
- **`performance`**: Performance issues
- **`business_logic`**: Quality rule violations
- **`infrastructure`**: File system, database errors
- **`data`**: Data processing errors
- **`timeout`**: Operation timeouts
- **`internal`**: Internal system errors

#### Recovery Strategies

- **`retry`**: Can be retried automatically
- **`fallback`**: Use alternative approach
- **`skip`**: Skip this check
- **`escalate`**: Escalate to human
- **`manual_intervention`**: Requires human action
- **`auto_fix`**: Can be auto-fixed
- **`waiver`**: Can be waived

### CAWS Tier Requirements

| Tier | Coverage | Mutation | Contracts | Review |
|------|----------|----------|-----------|--------|
| 1    | ≥90%     | ≥70%     | Required  | Manual |
| 2    | ≥80%     | ≥50%     | Optional  | Auto   |
| 3    | ≥70%     | ≥30%     | None      | Auto   |

## Engineering-Grade TODO Template

The quality gates support your engineering-grade TODO template:

```rust
// TODO: Implement user authentication flow
//       Add JWT-based authentication with proper session management
//
// COMPLETION CHECKLIST:
// [ ] Primary functionality implemented
// [ ] API/data structures defined & stable
// [ ] Error handling + validation aligned with error taxonomy
// [ ] Tests: Unit ≥80% branch coverage (≥50% mutation if enabled)
// [ ] Integration tests for external systems/contracts
// [ ] Documentation: public API + system behavior
// [ ] Performance/profiled against SLA (CPU/mem/latency throughput)
// [ ] Security posture reviewed (inputs, authz, sandboxing)
// [ ] Observability: logs (debug), metrics (SLO-aligned), tracing
// [ ] Configurability and feature flags defined if relevant
// [ ] Failure-mode cards documented (degradation paths)
//
// ACCEPTANCE CRITERIA:
// - User can authenticate with valid credentials
// - Invalid credentials are rejected with appropriate error
// - Session tokens expire within 24h
// - Authentication state persists across page reloads
//
// DEPENDENCIES:
// - JWT library (Required)
// - Database connection (Required)
// - Email service (Optional)
// - File path(s): src/auth/, tests/auth/
//
// ESTIMATED EFFORT: 8h ± 2h
// PRIORITY: High
// BLOCKING: Yes – blocks user dashboard access
//
// GOVERNANCE:
// - CAWS Tier: 2 (impacts rigor, provenance, review policy)
// - Change Budget: 15 files, 800 LOC (if relevant)
// - Reviewer Requirements: Security team, backend lead
```

## Integration with CAWS

### Working Spec Integration

Quality gates automatically read your CAWS working spec to determine:
- Risk tier requirements
- Quality thresholds
- Review requirements

### Provenance Tracking

All quality gate runs are tracked in CAWS provenance:
- Quality metrics
- Violation counts
- Resolution status

### Scaffolding

Quality gates are automatically scaffolded into new CAWS projects:

```bash
# Initialize new project
caws init my-project

# Scaffold quality gates into existing project
caws scaffold
```

## Benefits

### ✅ **Focused Analysis**
- Only analyzes files you're actually changing
- Eliminates false positives from untouched code
- Fast execution for rapid development cycles

### ✅ **Engineering-Grade Standards**
- Supports comprehensive TODO templates
- CAWS tier-aware quality thresholds
- Dependency resolution for blocking TODOs

### ✅ **Developer Experience**
- Clear violation messages with file locations
- Actionable recommendations
- CI/CD integration with proper exit codes

### ✅ **Quality Assurance**
- Prevents god objects from entering codebase
- Catches hidden TODOs and stub implementations
- Maintains code quality standards

## Troubleshooting

### Quality Gates Not Running

```bash
# Check if CAWS is initialized
ls -la .caws/

# Check git hooks
ls -la .git/hooks/

# Re-scaffold if needed
caws scaffold --force
```

### False Positives

Quality gates only analyze staged files. If you're seeing violations in files you didn't change:

1. Check what's staged: `git diff --cached --name-only`
2. Unstage unrelated files: `git reset HEAD <file>`
3. Re-run quality gates: `caws quality-gates`

### TODO Analyzer Issues

```bash
# Check if Python3 is available
python3 --version

# Check if TODO analyzer exists
ls -la scripts/v3/analysis/todo_analyzer.py

# Run TODO analyzer manually
python3 scripts/v3/analysis/todo_analyzer.py --staged-only --min-confidence 0.8
```

## Best Practices

1. **Stage Only Related Files**: Use `git add` selectively to avoid analyzing unrelated changes
2. **Fix Violations Before Committing**: Address quality gate violations in the same commit
3. **Use Engineering-Grade TODOs**: Follow the template format for better dependency resolution
4. **Configure Thresholds**: Adjust god object thresholds based on your project's needs
5. **CI Integration**: Use `--ci` flag in CI/CD pipelines for proper exit codes

## Examples

### Successful Quality Gates Run

```
🚦 CAWS Quality Gates - Staged Files Analysis
============================================================
📁 Analyzing 3 staged files
🎯 CAWS Tier: 2

🔤 Checking naming conventions...
   ✅ Naming conventions check passed

🚫 Checking code freeze compliance...
   ✅ Code freeze compliance check passed

📋 Checking duplication...
   ✅ No duplication regression detected

🏗️  Checking god objects...
📁 Found 2 staged Rust files to check
   ✅ No blocking god object violations

🔍 Checking hidden TODOs...
📁 Found 3 staged files to analyze for TODOs
   ✅ No critical hidden TODOs found in staged files

============================================================
📊 QUALITY GATES RESULTS
============================================================

✅ ALL QUALITY GATES PASSED
🎉 Commit allowed - quality maintained!
```

### Quality Gates with Violations

```
🚦 CAWS Quality Gates - Staged Files Analysis
============================================================
📁 Analyzing 5 staged files
🎯 CAWS Tier: 2
   Coverage: ≥80%, Mutation: ≥50%

🏗️  Checking god objects...
📁 Found 3 staged Rust files to check
   ❌ God object violations detected:
      src/large_module.rs: CRITICAL: 2150 LOC exceeds god object threshold (2000+ LOC)

🔍 Checking hidden TODOs...
📁 Found 5 staged files to analyze for TODOs
   ❌ Found 12 hidden TODOs in staged files

============================================================
📊 QUALITY GATES RESULTS
============================================================

❌ CRITICAL VIOLATIONS (1):
   src/large_module.rs: CRITICAL: 2150 LOC exceeds god object threshold (2000+ LOC)

🔍 HIDDEN TODOS (12):
   Found 12 hidden TODOs in staged files

❌ QUALITY GATES FAILED
🚫 Commit blocked - fix violations above
```

### Crisis Response Mode

```
🚦 CAWS Quality Gates - Staged Files Analysis [CRISIS RESPONSE MODE]
============================================================
📁 Analyzing 3 staged files
🎯 CAWS Tier: 1
   Coverage: ≥90%, Mutation: ≥70%

🏗️  Checking god objects...
📁 Found 2 staged Rust files to check
   ⚠️  God object warnings:
      src/emergency_fix.rs: WARNING: 2500 LOC approaches god object territory (1750+ LOC) [CRISIS MODE]

🔍 Checking hidden TODOs...
📁 Found 3 staged files to analyze for TODOs
   ✅ No critical hidden TODOs found in staged files

============================================================
📊 QUALITY GATES RESULTS
============================================================

⚠️  WARNINGS (1):
   src/emergency_fix.rs: WARNING: 2500 LOC approaches god object territory (1750+ LOC) [CRISIS MODE]

✅ ALL QUALITY GATES PASSED
🎉 Commit allowed - quality maintained!
⚠️  Crisis mode active - consider creating waivers for critical fixes
```

### Waiver Integration

```
🚦 CAWS Quality Gates - Staged Files Analysis
============================================================
📁 Analyzing 4 staged files
🎯 CAWS Tier: 2

🏗️  Checking god objects...
📁 Found 2 staged Rust files to check
   ⚠️  God object check waived: Active waiver: Emergency hotfix for production issue (expires: 2024-01-15T23:59:59Z)

🔍 Checking hidden TODOs...
📁 Found 4 staged files to analyze for TODOs
   ⚠️  Hidden TODO check waived: Active waiver: Emergency hotfix for production issue (expires: 2024-01-15T23:59:59Z)

============================================================
📊 QUALITY GATES RESULTS
============================================================

✅ ALL QUALITY GATES PASSED
🎉 Commit allowed - quality maintained!
⚠️  Some checks were waived - review waivers before merging
```

### Human Override

```
🚦 CAWS Quality Gates - Staged Files Analysis
============================================================
📁 Analyzing 2 staged files
🎯 CAWS Tier: 1

⚠️  Human override active: Emergency production fix approved by tech lead
   Quality gates will be bypassed
```

## TODO Analyzer Script

The CAWS quality gates system includes an advanced Python-based TODO analyzer (`scripts/v3/analysis/todo_analyzer.py`) that provides sophisticated hidden TODO detection:

### Key Features

- **Context-Aware Analysis**: Distinguishes between legitimate documentation and actual TODOs
- **Multi-Language Support**: Analyzes Rust, Python, JavaScript, TypeScript, Go, Java, C#, C++, and more
- **Code Stub Detection**: Identifies incomplete implementations beyond just comments
- **Engineering-Grade Templates**: Suggests CAWS-compliant TODO formats with completion checklists
- **Dependency Resolution**: Determines if TODOs are blocking based on dependencies
- **Confidence Scoring**: Context-aware confidence levels to reduce false positives

### Usage

```bash
# Analyze staged files with dependency resolution
python3 scripts/v3/analysis/todo_analyzer.py --staged-only --min-confidence 0.8

# Analyze specific files
python3 scripts/v3/analysis/todo_analyzer.py --files src/main.rs src/utils.py

# Include engineering-grade suggestions
python3 scripts/v3/analysis/todo_analyzer.py --staged-only --engineering-suggestions

# CI mode (exit with error code if TODOs found)
python3 scripts/v3/analysis/todo_analyzer.py --staged-only --ci-mode
```

### Engineering-Grade TODO Template

The analyzer can suggest upgrades to CAWS-compliant TODO formats:

```rust
// TODO: Implement user authentication
//       <One-sentence context & why this exists>
//
// COMPLETION CHECKLIST:
// [ ] Primary functionality implemented
// [ ] API/data structures defined & stable
// [ ] Error handling + validation aligned with error taxonomy
// [ ] Tests: Unit ≥80% branch coverage (≥50% mutation if enabled)
// [ ] Integration tests for external systems/contracts
// [ ] Documentation: public API + system behavior
// [ ] Performance/profiled against SLA (CPU/mem/latency throughput)
// [ ] Security posture reviewed (inputs, authz, sandboxing)
// [ ] Observability: logs (debug), metrics (SLO-aligned), tracing
// [ ] Configurability and feature flags defined if relevant
// [ ] Failure-mode cards documented (degradation paths)
//
// ACCEPTANCE CRITERIA:
// - <User-facing measurable behavior>
// - <Invariant or schema contract requirements>
// - <Performance/statistical bounds>
// - <Interoperation requirements or protocol contract>
//
// DEPENDENCIES:
// - <System or feature this relies on> (Required/Optional)
// - <Interop/contract references>
// - File path(s)/module links to dependent code
//
// ESTIMATED EFFORT: <Number + confidence range>
// PRIORITY: High
// BLOCKING: {Yes/No} – If Yes: explicitly list what it blocks
//
// GOVERNANCE:
// - CAWS Tier: 2 (impacts rigor, provenance, review policy)
// - Change Budget: <LOC or file count> (if relevant)
// - Reviewer Requirements: <Roles or domain expertise>
```

This comprehensive quality gates system ensures that only high-quality, well-structured code enters your codebase while maintaining developer productivity through focused analysis.
