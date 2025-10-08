# CAWS VS Code Extension User Guide

**Version**: 1.0.0  
**Last Updated**: October 8, 2025  
**Author**: @darianrosebrook

---

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Getting Started](#getting-started)
4. [Features](#features)
5. [Commands Reference](#commands-reference)
6. [Workflows](#workflows)
7. [Configuration](#configuration)
8. [Troubleshooting](#troubleshooting)
9. [Best Practices](#best-practices)

---

## Overview

The CAWS VS Code Extension brings the power of the Coding Agent Workflow System directly into your editor. It provides:

- **One-Click Project Setup**: Initialize CAWS in new or existing projects
- **Quality Monitoring**: Real-time code quality feedback
- **Provenance Tracking**: View development history and AI contributions
- **Git Hooks Management**: Easy installation and configuration
- **Interactive Dashboards**: Visual quality and provenance insights

### Who Is This For?

- Developers working on engineering-grade projects
- Teams requiring quality assurance and audit trails
- AI-assisted development workflows
- Projects needing provenance tracking

---

## Installation

### From VS Code Marketplace (Coming Soon)

1. Open VS Code
2. Go to Extensions (`Cmd/Ctrl + Shift + X`)
3. Search for "CAWS"
4. Click "Install"

### From VSIX File

1. Download the `.vsix` file from the releases page
2. Open VS Code
3. Go to Extensions (`Cmd/Ctrl + Shift + X`)
4. Click the `...` menu → "Install from VSIX..."
5. Select the downloaded `.vsix` file

### Requirements

- VS Code version 1.74.0 or higher
- Node.js 18.0.0 or higher (for CLI tools)
- Git installed and accessible

---

## Getting Started

### Quick Start (5 minutes)

#### 1. Initialize a New Project

**Command Palette** (`Cmd/Ctrl + Shift + P`):
```
CAWS: Initialize Project
```

**Steps**:
1. Enter project name (or use `.` for current directory)
2. Select a template:
   - **Extension**: VS Code extension project
   - **Library**: NPM library/package
   - **API**: API service
   - **CLI**: Command-line tool
   - **None**: Manual setup
3. Wait for initialization to complete
4. Working spec file opens automatically

#### 2. Explore Your Setup

The extension creates:
```
.caws/
  ├── working-spec.yaml    # Your project specification
  ├── provenance/          # Development history
  └── waivers/             # Quality gate waivers (if needed)

.git/hooks/                # Git hooks (if installed)
```

#### 3. Run Your First Evaluation

**Command Palette**:
```
CAWS: Evaluate Quality
```

You'll see:
- Overall quality score
- Criteria pass/fail status
- Recommended next actions

---

## Features

### 1. Project Initialization

**Command**: `CAWS: Initialize Project`

Initialize CAWS in a new or existing project with interactive setup.

**What It Does**:
- Creates `.caws` directory structure
- Generates working specification
- Sets up provenance tracking
- Copies project templates (if selected)
- Opens working spec for editing

**When to Use**:
- Starting a new project
- Adding CAWS to existing project
- Switching to CAWS workflow

---

### 2. Component Scaffolding

**Command**: `CAWS: Scaffold Components`

Add CAWS components to an existing project.

**Options**:
- **Full Setup**: All components (recommended)
- **Minimal Setup**: Essential components only
- **With Codemods**: Include refactoring scripts
- **With OIDC**: NPM publishing setup

**What It Adds**:
- Quality gates configuration
- CI/CD integration files
- IDE integrations (VS Code, IntelliJ, etc.)
- Git hooks templates
- Documentation templates

**When to Use**:
- Project already initialized, need additional components
- Setting up CI/CD
- Adding IDE integrations

---

### 3. Quality Evaluation

**Command**: `CAWS: Evaluate Quality`

Run comprehensive quality evaluation against your working spec.

**What It Checks**:
- Code coverage requirements
- Mutation score targets
- Contract compliance
- Security requirements
- Accessibility standards
- Performance budgets

**Results Display**:
```
CAWS Evaluation: QUALITY PASSED (92.3%)

Criteria:
  ✅ Code Coverage (95%) - Exceeds 90% requirement
  ✅ Mutation Score (72%) - Meets 70% requirement  
  ✅ Contract Tests - All passing
  ⚠️ Performance - P95 at 280ms (target: 250ms)
  
Next Actions:
  - Optimize API endpoints for performance
  - Consider caching strategies
```

**When to Use**:
- Before committing code
- After major changes
- Pre-deployment checks
- Regular quality audits

---

### 4. Iterative Guidance

**Command**: `CAWS: Get Iterative Guidance`

Get context-aware guidance for next development steps.

**How It Works**:
1. Describe your current state (e.g., "Completed API, need tests")
2. Extension analyzes your working spec
3. Provides:
   - Specific next steps
   - Confidence level
   - Focus areas
   - CAWS recommendations

**Example Output**:
```
Current State: Completed API implementation

Guidance:
Focus on implementing comprehensive test coverage for your API endpoints.
Priority should be on edge cases and error conditions.

Next Steps:
1. Add unit tests for each endpoint
2. Implement integration tests for workflows
3. Add contract tests for API specification
4. Run mutation testing

Confidence: 85%
Focus Areas: Testing, Error Handling
```

**When to Use**:
- Unsure what to do next
- Planning development sessions
- Breaking down complex tasks
- Following TDD workflow

---

### 5. Working Spec Validation

**Command**: `CAWS: Validate Working Spec`

Validate your working specification format and completeness.

**What It Checks**:
- Required fields present
- Valid YAML syntax
- ID format correctness
- Risk tier appropriateness
- Scope completeness
- Acceptance criteria quality

**Output Channel**:
Results appear in "CAWS Validation" output channel with:
- ✅ Validation passed messages
- ❌ Error descriptions
- 💡 Helpful suggestions
- 🔧 Auto-fix recommendations

**When to Use**:
- After editing working spec
- Before starting implementation
- When spec validation fails
- Learning CAWS spec format

---

### 6. Waiver Creation

**Command**: `CAWS: Create Waiver`

Create quality gate waivers for exceptional circumstances.

**Interactive Form**:
1. **Title**: Brief waiver description
2. **Reason**: Select from:
   - Emergency hotfix
   - Legacy integration
   - Experimental feature
   - Third-party constraint
   - Performance critical
   - Security patch
   - Infrastructure limitation
   - Other
3. **Description**: Detailed explanation
4. **Gates to Waive**: Comma-separated list
5. **Expiration**: ISO 8601 date
6. **Approved By**: Your name/team
7. **Impact Level**: Low/Medium/High/Critical
8. **Mitigation Plan**: How you'll address the gap

**Example**:
```
Title: Emergency security patch
Reason: security_patch
Gates: coverage_threshold
Expires: 2025-11-01T00:00:00Z
Impact: High

Mitigation:
- Manual testing completed
- Automated tests to follow within 48 hours
- Security team approved deployment
```

**When to Use**:
- Emergency deployments
- Known technical debt
- External constraints
- Experimental features
- Performance trade-offs

---

### 7. Git Hooks Management

#### Install Hooks

**Command**: `CAWS: Install Git Hooks`

Install CAWS git hooks for automatic quality checks and provenance tracking.

**Hooks Installed**:
- **pre-commit**: Validation and linting
- **post-commit**: Provenance updates
- **pre-push**: Comprehensive checks
- **commit-msg**: Message format validation

**Options**:
- Backup existing hooks: Yes/No

**What They Do**:
- Validate commits before accepting
- Update provenance automatically
- Run quality gates pre-push
- Enforce commit conventions

#### Check Status

**Command**: `CAWS: Check Hooks Status`

View current git hooks configuration and status.

**Output**:
```
Git Hooks Status:

Installed:
✅ pre-commit (CAWS validation)
✅ post-commit (CAWS provenance)
✅ pre-push (CAWS quality gates)
✅ commit-msg (CAWS format check)

Configuration:
- Provenance tracking: Enabled
- Validation: Enabled
- Quality gates: Enabled
- Backup location: .git/hooks/backups/
```

**When to Use**:
- After installation
- Troubleshooting hook issues
- Verifying hook configuration
- Before making hook changes

---

### 8. Provenance Dashboard

**Command**: `CAWS: Show Provenance Dashboard`

View comprehensive development history and AI contribution metrics.

**Dashboard Sections**:

#### Summary Stats
- Total commits tracked
- AI-assisted commits
- Average quality score
- Active development sessions

#### AI Contribution Analysis
- Composer/Chat contributions
- Tab completion usage
- Manual coding percentage
- Acceptance rates

#### Recent Activity Timeline
- Commit history
- AI assistance markers
- Quality metrics
- Checkpoint tracking

**Interactive Features**:
- Refresh data
- Verify provenance chain
- Initialize tracking
- Filter by date range

**When to Use**:
- Reviewing development progress
- Analyzing AI effectiveness
- Audit trail verification
- Team retrospectives
- Compliance reporting

---

### 9. Quality Dashboard

**Command**: `CAWS: Show Quality Dashboard`

Real-time quality monitoring and metrics.

**What It Shows**:
- Current quality score
- Criteria breakdown
- Recent evaluations
- Trend analysis
- Quick actions

**Auto-Refresh**:
Dashboard updates automatically every 30 seconds.

**When to Use**:
- Continuous monitoring
- During development
- Pre-commit checks
- Team standups

---

## Commands Reference

### Quick Reference Table

| Command | Shortcut | When to Use |
|---------|----------|-------------|
| `CAWS: Initialize Project` | - | New projects |
| `CAWS: Scaffold Components` | - | Add features |
| `CAWS: Evaluate Quality` | - | Check quality |
| `CAWS: Get Iterative Guidance` | - | Next steps |
| `CAWS: Validate Working Spec` | - | Spec changes |
| `CAWS: Create Waiver` | - | Exceptions |
| `CAWS: Install Git Hooks` | - | First setup |
| `CAWS: Check Hooks Status` | - | Verify hooks |
| `CAWS: Show Provenance Dashboard` | - | View history |
| `CAWS: Show Quality Dashboard` | - | Monitor quality |

### Command Palette Access

All commands available via Command Palette (`Cmd/Ctrl + Shift + P`):
```
CAWS: [command name]
```

### Context Menu Access

Some commands available via right-click:
- `CAWS: Evaluate Quality` (in `.js`, `.ts`, `.jsx`, `.tsx` files)

---

## Workflows

### Workflow 1: Starting a New Project

**Duration**: 5-10 minutes

1. **Initialize Project**
   ```
   Command: CAWS: Initialize Project
   Input: Project name, select template
   ```

2. **Review Working Spec**
   - Opens automatically
   - Customize as needed
   - Save changes

3. **Install Git Hooks**
   ```
   Command: CAWS: Install Git Hooks
   Select: Backup existing hooks
   ```

4. **Run Initial Evaluation**
   ```
   Command: CAWS: Evaluate Quality
   ```

5. **Start Coding!**
   - Follow guidance from evaluation
   - Commit regularly (hooks will validate)

---

### Workflow 2: Adding CAWS to Existing Project

**Duration**: 10-15 minutes

1. **Open Existing Project in VS Code**

2. **Initialize CAWS**
   ```
   Command: CAWS: Initialize Project
   Input: "." (current directory)
   Template: Choose based on project type
   ```

3. **Scaffold Components**
   ```
   Command: CAWS: Scaffold Components
   Option: Full Setup
   ```

4. **Customize Working Spec**
   - Edit `.caws/working-spec.yaml`
   - Set appropriate risk tier
   - Define acceptance criteria

5. **Validate Configuration**
   ```
   Command: CAWS: Validate Working Spec
   ```

6. **Install Hooks**
   ```
   Command: CAWS: Install Git Hooks
   ```

7. **Initial Evaluation**
   ```
   Command: CAWS: Evaluate Quality
   Address any issues
   ```

---

### Workflow 3: Daily Development

**Duration**: Continuous

1. **Morning: Check Status**
   ```
   Command: CAWS: Show Quality Dashboard
   Review overnight CI/CD results
   ```

2. **Start Feature Work**
   ```
   Command: CAWS: Get Iterative Guidance
   Input: Current state
   Follow recommendations
   ```

3. **Regular Evaluations**
   ```
   After significant changes:
   Command: CAWS: Evaluate Quality
   ```

4. **Before Commits**
   ```
   Hooks run automatically:
   - Validation
   - Quality checks
   ```

5. **End of Day: Review Provenance**
   ```
   Command: CAWS: Show Provenance Dashboard
   Review AI contributions
   Check quality trends
   ```

---

### Workflow 4: Emergency Hotfix

**Duration**: Variable

1. **Create Waiver**
   ```
   Command: CAWS: Create Waiver
   Reason: emergency_hotfix
   Impact: High
   ```

2. **Make Urgent Fix**
   - Focus on solving immediate problem
   - Document thoroughly

3. **Commit with Waiver Reference**
   ```bash
   git commit -m "hotfix: critical security patch [WV-0001]"
   ```

4. **Deploy**

5. **Follow-Up (Within 48 Hours)**
   ```
   - Add missing tests
   - Update documentation
   - Remove waiver
   ```

---

## Configuration

### Extension Settings

Access via: `Preferences → Settings → Extensions → CAWS`

#### Basic Settings

**`caws.cli.path`**
- **Type**: String
- **Default**: `"caws"`
- **Description**: Path to CAWS CLI executable
- **Example**: `"/usr/local/bin/caws"`

**`caws.autoValidate`**
- **Type**: Boolean
- **Default**: `false`
- **Description**: Automatically validate on file save
- **Recommendation**: Enable for real-time feedback

**`caws.showQualityStatus`**
- **Type**: Boolean
- **Default**: `true`
- **Description**: Show quality status in status bar
- **Recommendation**: Keep enabled

**`caws.experimentalMode`**
- **Type**: Boolean
- **Default**: `false`
- **Description**: Enable experimental features
- **Recommendation**: Only for testing

#### Example Configuration

```json
{
  "caws.cli.path": "caws",
  "caws.autoValidate": true,
  "caws.showQualityStatus": true,
  "caws.experimentalMode": false
}
```

---

## Troubleshooting

### Common Issues

#### 1. "CAWS CLI not found"

**Symptoms**:
- Commands fail with "CLI not found"
- Extension shows error messages

**Solutions**:
1. Verify CLI installation:
   ```bash
   caws --version
   ```
2. If not installed, install globally:
   ```bash
   npm install -g @paths.design/caws-cli
   ```
3. Set custom path in settings:
   ```json
   {"caws.cli.path": "/path/to/caws"}
   ```

---

#### 2. "MCP Server Not Available"

**Symptoms**:
- Tools take long time
- Fallback to direct CLI

**Solutions**:
1. MCP server should be bundled with extension
2. Check extension installation is complete
3. Restart VS Code
4. Reinstall extension if needed

---

#### 3. "Working Spec Not Found"

**Symptoms**:
- Commands don't appear in palette
- Validation fails

**Solutions**:
1. Initialize CAWS:
   ```
   Command: CAWS: Initialize Project
   ```
2. Verify `.caws/working-spec.yaml` exists
3. Check YAML syntax is valid:
   ```
   Command: CAWS: Validate Working Spec
   ```

---

#### 4. Git Hooks Not Working

**Symptoms**:
- Commits succeed without validation
- Provenance not updating

**Solutions**:
1. Check hooks installation:
   ```
   Command: CAWS: Check Hooks Status
   ```
2. Reinstall hooks:
   ```
   Command: CAWS: Install Git Hooks
   ```
3. Verify hooks are executable:
   ```bash
   ls -la .git/hooks/
   chmod +x .git/hooks/pre-commit
   ```

---

#### 5. Slow Performance

**Symptoms**:
- Commands take >5 seconds
- VS Code feels sluggish

**Solutions**:
1. Disable auto-validation:
   ```json
   {"caws.autoValidate": false}
   ```
2. Close quality dashboard when not needed
3. Reduce quality check frequency
4. Check system resources

---

### Getting Help

#### In-App Support
1. Open Command Palette
2. Search for "CAWS"
3. All available commands listed

#### Documentation
- **Full Guide**: `/docs/agents/full-guide.md`
- **API Reference**: `/docs/api/mcp-tools.md`
- **Quickstart**: Workspace root `AGENTS.md`

#### Community Support
- **GitHub Issues**: https://github.com/paths-design/caws/issues
- **Discussions**: https://github.com/paths-design/caws/discussions

---

## Best Practices

### 1. Working Spec Management

✅ **Do**:
- Keep spec up-to-date with changes
- Use clear, measurable acceptance criteria
- Review and validate regularly
- Version control your spec

❌ **Don't**:
- Leave spec unchanged for weeks
- Use vague criteria
- Skip validation
- Edit spec without team review

---

### 2. Quality Evaluation

✅ **Do**:
- Evaluate before commits
- Address issues promptly
- Track quality trends
- Use waivers judiciously

❌ **Don't**:
- Skip evaluations
- Ignore warnings
- Accumulate technical debt
- Abuse waiver system

---

### 3. Git Hooks

✅ **Do**:
- Install hooks early
- Keep hooks updated
- Review hook output
- Backup before updating

❌ **Don't**:
- Bypass hooks (--no-verify)
- Ignore hook failures
- Disable without team agreement
- Make hooks too strict

---

### 4. Provenance Tracking

✅ **Do**:
- Review provenance regularly
- Use for retrospectives
- Track AI effectiveness
- Maintain audit trails

❌ **Don't**:
- Ignore provenance data
- Skip initialization
- Delete provenance files
- Manipulate history

---

### 5. Team Workflows

✅ **Do**:
- Share working specs
- Coordinate on waivers
- Review quality together
- Learn from provenance

❌ **Don't**:
- Work in isolation
- Create conflicting waivers
- Skip team reviews
- Ignore patterns

---

## Keyboard Shortcuts

No default keyboard shortcuts set. Recommended custom shortcuts:

```json
{
  "key": "cmd+shift+e",
  "command": "caws.evaluate",
  "when": "editorTextFocus"
},
{
  "key": "cmd+shift+i",
  "command": "caws.iterate",
  "when": "editorTextFocus"
},
{
  "key": "cmd+shift+d",
  "command": "caws.showDashboard",
  "when": "editorTextFocus"
}
```

Add to: `Preferences → Keyboard Shortcuts → Open Keyboard Shortcuts (JSON)`

---

## Updates & Versioning

### Checking for Updates

Extension auto-updates via VS Code marketplace.

Manual check:
1. Extensions panel
2. Find "CAWS"
3. Click "Update" if available

### Version History

See `CHANGELOG.md` for detailed version history.

---

## Feedback & Contributions

### Reporting Issues

1. Gather information:
   - Extension version
   - VS Code version
   - Error messages
   - Steps to reproduce

2. Create issue:
   - GitHub: https://github.com/paths-design/caws/issues
   - Include gathered information
   - Add screenshots if helpful

### Feature Requests

Use GitHub Discussions for feature requests and ideas.

### Contributing

See `CONTRIBUTING.md` in the main repository.

---

## License

MIT License - see main project LICENSE file.

---

## Next Steps

Now that you're familiar with the extension:

1. **Initialize your first project**
2. **Set up git hooks**
3. **Run your first evaluation**
4. **Explore the dashboards**
5. **Join the community**

Happy coding with CAWS! 🚀


