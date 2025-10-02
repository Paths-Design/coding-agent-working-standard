# CAWS CLI UX Improvements Roadmap

**Based on**: Claude 4.5 Feedback (October 2, 2025)  
**CAWS Version**: 3.0.0 → 3.1.0  
**Author**: @darianrosebrook

---

## Executive Summary

Claude 4.5 provided comprehensive feedback on the CAWS setup experience, identifying key friction points and suggesting actionable improvements. This document tracks implementation status and roadmap for addressing the feedback.

**Current Status**: 5/11 high-priority improvements implemented ✅

---

## Implemented Improvements (v3.0.1)

### 1. In-Place Initialization ✅
**Feedback**: "Had to manually move files from subdirectory to root"

**Implementation**:
- `caws init .` now initializes in current directory
- Smart project detection warns when creating subdirectory in existing project
- Clear messaging about where files will be created

**Impact**: Eliminates manual file moving, saves ~3 minutes

### 2. Scaffold Command Validation ✅
**Feedback**: "Scaffold command logged 'enhancing' before checking if CAWS exists"

**Implementation**:
- Early validation before any logging
- Clear error message with recovery steps
- Helpful guidance pointing to init command

**Impact**: Prevents confusion, clearer error flow

### 3. Template Detection Transparency ✅
**Feedback**: "Complex template detection logic with poor user feedback"

**Implementation**:
- Descriptive logging showing where templates are loaded from
- Clear warnings when templates not found
- Actionable recovery suggestions

**Impact**: Users understand what's happening and why

### 4. Enhanced Error Messages ✅
**Feedback**: "Generic error messages without actionable recovery guidance"

**Implementation**:
- Every error includes specific recovery steps
- Template errors suggest manual copy alternatives
- Language support errors explain impact

**Impact**: Faster problem resolution, reduced frustration

### 5. Project Detection ✅
**Feedback**: "Directory structure assumptions caused unexpected behavior"

**Implementation**:
- `shouldInitInCurrentDirectory()` detects existing projects
- Warnings when creating subdirectory in project directory
- Clear success messaging about location

**Impact**: Better expectations, fewer surprises

---

## Planned Improvements (v3.1.0)

### High Priority

#### 1. Interactive Setup Wizard 🚧
**Status**: Design complete, implementation pending  
**Effort**: Medium (2-3 days)  
**Impact**: High (reduces setup time by 50%+)

**Features**:
- Guided questions about project type
- Risk tier selection with explanations
- Automatic working spec generation
- Tech stack detection and adaptation

**CLI Commands**:
```bash
caws init --interactive
caws init -i
```

**Acceptance Criteria**:
- [ ] Project type selection (library, app, extension, tool)
- [ ] Risk tier selection with examples
- [ ] Key requirements multi-select
- [ ] Testing priorities selection
- [ ] Generated working spec reflects choices
- [ ] Tier policy auto-generated for project type

#### 2. Project-Type Templates 📋
**Status**: Schema designed, examples needed  
**Effort**: Medium (2-3 days)  
**Impact**: High (relevant starting point)

**Templates to Create**:
- VS Code Extension (`--template=extension`)
- React Library (`--template=library`)
- Node.js API (`--template=api`)
- CLI Tool (`--template=cli`)
- Monorepo (`--template=monorepo`)

**CLI Commands**:
```bash
caws init my-project --template=extension
caws init . --template=library
caws init --template=api --interactive
```

**Acceptance Criteria**:
- [ ] Extension template with webview security
- [ ] Library template with bundle size budgets
- [ ] API template with performance SLOs
- [ ] CLI template with ergonomics requirements
- [ ] Monorepo template with per-package policies

#### 3. Validation with Suggestions 💡
**Status**: Schema analysis complete  
**Effort**: Medium (2-3 days)  
**Impact**: High (learning by doing)

**Features**:
- Helpful error messages with examples
- Suggest fixes based on validation errors
- Optional auto-fix for common issues
- Link to relevant documentation

**CLI Commands**:
```bash
caws validate --suggestions
caws validate --auto-fix
caws validate --explain
```

**Example Output**:
```bash
❌ Validation failed: invariants is required

💡 Suggestions:
  Add at least 1 invariant describing system guarantees
  
  Example for VS Code Extension:
    invariants:
      - 'Webview only accesses workspace files'
      - 'Extension activates in <1s'
  
  See: https://caws.dev/docs/invariants

❓ Generate default invariants? [Y/n]
```

**Acceptance Criteria**:
- [ ] Context-aware suggestions for each validation error
- [ ] Examples specific to project type
- [ ] Auto-fix for safe corrections
- [ ] Documentation links for each error type

### Medium Priority

#### 4. Dependency Analysis 🔍
**Status**: Design in progress  
**Effort**: High (3-5 days)  
**Impact**: Medium (intelligent defaults)

**Features**:
- Detect project structure (monorepo, single package)
- Analyze package.json for tech stack
- Detect testing framework
- Infer appropriate risk tier
- Generate tier policy from workspace structure

**CLI Commands**:
```bash
caws init --analyze
caws analyze
caws check:setup
```

**Acceptance Criteria**:
- [ ] Detect monorepo (workspaces, pnpm, yarn)
- [ ] Identify VS Code extension vs library vs app
- [ ] Detect TypeScript, testing frameworks, linters
- [ ] Suggest risk tier based on package type
- [ ] Generate tier policy from packages

#### 5. Layered Documentation 📚
**Status**: Restructuring in progress  
**Effort**: Low (1 day, mostly reorganization)  
**Impact**: Medium (reduces cognitive load)

**Structure**:
```
AGENTS.md              # Quick reference (100-200 lines)
docs/
  agents/
    FULL_GUIDE.md      # Complete framework (821 lines)
    TUTORIAL.md        # Step-by-step walkthrough
    EXAMPLES.md        # Real-world examples
    CI_CD.md           # CI/CD deep dive
```

**Acceptance Criteria**:
- [ ] Quick reference covers 80% of daily use
- [ ] Full guide maintains completeness
- [ ] Tutorial has hands-on exercises
- [ ] Clear markers: Essential, Recommended, Optional

#### 6. Getting Started Guide 🎯
**Status**: Template ready  
**Effort**: Low (1 day)  
**Impact**: Medium (clear path forward)

**Features**:
- Phase-based checklist
- Interactive verification
- Links to next steps
- Project-specific tips

**Generated**: `.caws/GETTING_STARTED.md`

**Acceptance Criteria**:
- [ ] Generated during init
- [ ] Customized for project type
- [ ] Links to relevant sections
- [ ] Checkboxes for tracking progress

#### 7. Smart .gitignore 📝
**Status**: Patterns defined  
**Effort**: Low (1 day)  
**Impact**: Low (convenience)

**Patterns**:
```gitignore
# CAWS configuration (tracked)
.caws/working-spec.yaml
.caws/policy/
.caws/templates/
.agent/provenance.json

# CAWS temporary files (ignored)
.agent/temp/
.agent/cache/
.caws/.cache/
```

**Acceptance Criteria**:
- [ ] Generated during init
- [ ] Merges with existing .gitignore
- [ ] Comments explain what's tracked vs ignored
- [ ] Detects and warns about conflicts

#### 8. Opt-In Components 🎛️
**Status**: Flag system designed  
**Effort**: Medium (2 days)  
**Impact**: Low (cleaner setup)

**Components**:
- OIDC setup (only for npm publishing)
- Codemods (only for refactor mode)
- CI/CD templates (only when requested)
- Advanced templates (feature flags, migrations)

**CLI Commands**:
```bash
caws scaffold --with-oidc
caws scaffold --with-codemods
caws scaffold --minimal
caws scaffold --full
```

**Acceptance Criteria**:
- [ ] OIDC only created with flag or when publishing detected
- [ ] Codemods only for mode: refactor
- [ ] CI templates detect existing CI system
- [ ] Minimal mode creates only essentials

### Low Priority

#### 9. Examples Gallery 📖
**Status**: Collecting examples  
**Effort**: Low (ongoing)  
**Impact**: Medium (learning by example)

**Structure**:
```
.caws/examples/
  working-specs/
  tier-policies/
  feature-plans/
```

#### 10. CLI Commands Expansion 🔧
**Status**: Specification phase  
**Effort**: Medium (varies by command)  
**Impact**: Varies

**New Commands**:
```bash
caws analyze
caws check:setup
caws generate:working-spec
caws generate:tier-policy
caws generate:ci [github|gitlab|jenkins]
caws verify
caws gate:coverage --threshold 80
caws prove
```

---

## Metrics

### Current Setup Time
- CLI commands: 2 mins
- File organization: 3 mins
- Customization: 15 mins
- Policy creation: 10 mins
- Documentation: 10 mins
- **Total: ~45 minutes**

### Target Setup Time (with improvements)
- Interactive init: 5 mins
- Template selection: 1 min
- Customization: 5 mins
- Verification: 2 mins
- **Total: ~15 minutes (67% reduction)**

---

## Implementation Timeline

### Sprint 1 (Week 1-2) - Core Improvements
- [x] In-place initialization
- [x] Scaffold validation
- [x] Better error messages
- [x] Template detection transparency
- [ ] Interactive wizard
- [ ] Project templates

### Sprint 2 (Week 3-4) - Validation & Documentation
- [ ] Validation with suggestions
- [ ] Layered documentation
- [ ] Getting started guide
- [ ] Smart .gitignore

### Sprint 3 (Week 5-6) - Intelligence & Options
- [ ] Dependency analysis
- [ ] Opt-in components
- [ ] Examples gallery

### Sprint 4 (Week 7-8) - Polish & Testing
- [ ] CLI commands expansion
- [ ] End-to-end testing of new flows
- [ ] Documentation updates
- [ ] Release 3.1.0

---

## Testing Strategy

### UX Testing
- [ ] Fresh project initialization (multiple types)
- [ ] Existing project scaffolding
- [ ] Error recovery flows
- [ ] Interactive wizard paths
- [ ] Template customization

### Integration Testing
- [ ] All CLI commands
- [ ] Template generation
- [ ] Validation with suggestions
- [ ] Auto-fix functionality
- [ ] Dependency analysis

### User Acceptance
- [ ] Beta testing with 5 different project types
- [ ] Feedback collection via survey
- [ ] Timed setup comparisons (before/after)
- [ ] Error rate tracking

---

## Success Metrics

**Quantitative**:
- Setup time: 45 min → 15 min (67% reduction)
- Validation errors: Reduce by 50% through suggestions
- File moves: Eliminate 100%
- Template customization: Reduce by 70%

**Qualitative**:
- "Now what?" moments: Eliminate with getting started guide
- Confusion about directory structure: Eliminate with clear messaging
- Frustration with generic defaults: Reduce with project templates
- Documentation overwhelm: Reduce with layered docs

---

## Feedback Integration

This roadmap directly addresses Claude 4.5's feedback:

✅ **Directory structure** - In-place init implemented  
🚧 **Generic working spec** - Project templates in progress  
🚧 **Documentation overwhelm** - Layering in progress  
✅ **Error messages** - Suggestions implemented  
🚧 **Interactive setup** - Wizard in progress  
📋 **Smart defaults** - Dependency analysis planned  
📋 **Validation help** - Suggestions planned  
📋 **Getting started** - Guide planned  

---

## Contributing

To implement any of these improvements:

1. Check the acceptance criteria
2. Create a feature branch: `feature/ux-<improvement-name>`
3. Update tests to cover new functionality
4. Update documentation
5. Submit PR with UX testing results

---

**Last Updated**: October 2, 2025  
**Next Review**: October 16, 2025  
**Owner**: @darianrosebrook

