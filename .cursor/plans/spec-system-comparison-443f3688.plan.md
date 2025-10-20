<!-- 443f3688-08c5-45d0-8521-f03141b24176 7838cad3-efd3-41ee-b0d9-4e670edd7c83 -->
# Spec-Driven Development System Comparison

## Executive Summary

After analyzing **GitHub Spec-kit**, **Fission-AI OpenSpec**, and **CAWS**, I've identified key differences in philosophy, implementation, and approach. Each system targets spec-driven development but with distinct strategies for AI agent integration and change management.

## 1. Core Philosophy Comparison

### GitHub Spec-kit

- **Philosophy**: Executable specifications as the single source of truth
- **Approach**: Specs directly generate code through AI agents
- **Primary Use Case**: 0-to-1 greenfield development
- **Key Insight**: "Define the what before the how"

### Fission-AI OpenSpec

- **Philosophy**: Lightweight universal framework for AI-human collaboration
- **Approach**: Two-folder model (current specs + proposed changes)
- **Primary Use Case**: Feature development with iterative refinement
- **Key Insight**: Changes as first-class artifacts separate from current state

### CAWS

- **Philosophy**: Engineering-grade operating system with enforced quality gates
- **Approach**: Risk-based rigor with comprehensive provenance tracking
- **Primary Use Case**: Enterprise development requiring audit trails and quality assurance
- **Key Insight**: "No implementation without validated working spec"

## 2. File Structure & Organization

### OpenSpec Structure

```
openspec/
├── specs/              # Current truth
│   └── auth/
│       └── spec.md
└── changes/            # Proposed changes
    └── add-2fa/
        ├── proposal.md
        ├── tasks.md
        ├── design.md
        └── specs/
            └── auth/
                └── spec.md  # Delta only
```

**Strengths**:

- Clean separation of current state vs proposed changes
- Changes are self-contained folders
- Easy to understand what's changing vs what exists
- Natural archival workflow

**Weaknesses**:

- No explicit risk tier or quality gates
- No change budget enforcement
- No provenance tracking
- Limited validation beyond formatting

### Spec-kit Structure

```
specify/
├── spec.md             # Executable specification
├── plan.md             # Implementation plan
├── status.md           # Progress tracking
└── implementation/     # Generated code
```

**Strengths**:

- Simple and minimal
- Direct specification-to-code generation
- Clear progression from spec to implementation

**Weaknesses**:

- Optimized for greenfield, not maintenance
- No cross-spec change management
- No audit trails or provenance
- Limited multi-feature coordination

### CAWS Structure

```
.caws/
├── working-spec.yaml   # Comprehensive specification
├── schemas/            # Validation schemas
├── waivers/            # Quality gate exceptions
├── provenance/         # Audit trails
└── cache/              # Performance optimization

docs/FEAT-001/
├── feature.plan.md
├── test-plan.md
└── codemod/            # Refactor scripts
```

**Strengths**:

- Comprehensive validation and quality enforcement
- Risk-based quality tiers
- Full provenance tracking
- Change budget enforcement
- Contract-first approach

**Weaknesses**:

- Single working-spec.yaml can become monolithic
- No explicit change archival workflow
- More complex setup than alternatives
- Steeper learning curve

## 3. Change Management Approaches

### OpenSpec: Change-as-Folder Model

```bash
# Create change
openspec init add-feature

# Creates: openspec/changes/add-feature/
# - proposal.md (why and what)
# - tasks.md (checklist)
# - specs/ (deltas only)

# Apply change
/openspec:apply add-feature

# Archive when complete
openspec archive add-feature --yes
```

**Key Innovation**: Changes are first-class artifacts with dedicated folders

### Spec-kit: Phase-Based Model

```bash
# Define spec
specify create feature-name

# Generate plan
specify plan

# Implement
specify build

# Validate
specify validate
```

**Key Innovation**: Direct spec-to-code generation with AI assistance

### CAWS: Mode-Based Workflow

```bash
# Create working spec
caws init FEAT-001 --mode=feature

# Validate spec
caws validate

# Update progress
caws progress update --criterion-id A1

# Evaluate compliance
caws evaluate
```

**Key Innovation**: Risk-based quality gates and comprehensive validation

## 4. AI Agent Integration

### OpenSpec

- **Native slash commands**: `/openspec:proposal`, `/openspec:apply`, `/openspec:archive`
- **Universal fallback**: `AGENTS.md` for non-native tools
- **Multi-tool support**: Cursor, Claude Code, Codex, GitHub Copilot
- **Agent guidance**: Minimal, relies on AI understanding deltas

### Spec-kit

- **Integrated workflows**: Built-in AI agent support
- **Tool compatibility**: GitHub Copilot, Claude Code, Cursor
- **Agent guidance**: Phase-specific instructions
- **Code generation**: Direct AI-to-code generation

### CAWS

- **MCP Server**: Model Context Protocol for standardized interface
- **Comprehensive rules**: Modular `.cursor/rules/` MDC files
- **Real-time hooks**: `.cursor/hooks/` for enforcement
- **Agent guidance**: Extensive documentation with quality contracts
- **Provenance tracking**: Automatic AI contribution attribution

## 5. Quality & Validation

### OpenSpec

- **Format validation**: Markdown structure and delta syntax
- **Link checking**: Documentation integrity
- **Minimal gates**: Focuses on spec completeness, not code quality

### Spec-kit

- **Spec validation**: Ensures specs are executable
- **Plan validation**: Implementation plan completeness
- **Contract testing**: API contract validation

### CAWS

- **Risk-based tiers**: T1 (90% coverage), T2 (80%), T3 (70%)
- **Comprehensive gates**:
  - Test coverage (branch + statement)
  - Mutation testing (test suite strength)
  - Contract validation (OpenAPI compliance)
  - Static analysis (linting, type checking, security)
  - Change budget enforcement
- **Provenance tracking**: Full audit trail with AI attribution

## 6. Key Differences Summary

| Aspect | OpenSpec | Spec-kit | CAWS |

|--------|----------|----------|------|

| **Primary Focus** | Change management | Spec-to-code generation | Quality assurance |

| **Complexity** | Low | Low | High |

| **Learning Curve** | Gentle | Gentle | Steep |

| **Enterprise Ready** | Limited | Limited | Yes |

| **Audit Trails** | No | No | Yes |

| **Quality Gates** | Minimal | Moderate | Comprehensive |

| **Change Archival** | Built-in | No | No |

| **Multi-spec Changes** | Strong | Weak | Moderate |

| **Provenance** | No | No | Yes |

| **Risk Management** | No | No | Yes |

## 7. What Aligns

All three systems share:

1. **Spec-first philosophy**: Define requirements before implementation
2. **AI agent integration**: Built for AI-assisted development
3. **Validation mechanisms**: Automated spec validation
4. **Structured workflows**: Clear development phases
5. **Documentation focus**: Specs as living documentation
6. **Test-driven approach**: Tests derived from specifications

## 8. What CAWS Can Learn

### From OpenSpec

#### 1. Change-as-Folder Model ⭐⭐⭐⭐⭐

**High Value Learning**

OpenSpec's greatest innovation is treating changes as first-class artifacts in dedicated folders.

**Current CAWS Approach**:

- Single `working-spec.yaml` for entire project
- Changes mixed with base spec
- No clear archival path

**OpenSpec's Approach**:

```
openspec/
├── specs/              # Current truth
└── changes/            # Active changes
    ├── add-2fa/
    │   ├── proposal.md
    │   ├── tasks.md
    │   └── specs/      # Deltas
    └── add-search/
        └── ...
```

**Recommendation**: Adopt change folders in CAWS

**Proposed CAWS Evolution**:

```
.caws/
├── base-spec.yaml          # Project baseline
├── specs/                  # Current feature specs
│   └── auth/
│       └── spec.yaml
└── changes/                # Active changes
    ├── FEAT-001-add-2fa/
    │   ├── working-spec.yaml   # Change-specific spec
    │   ├── tasks.md
    │   ├── deltas/             # Spec deltas
    │   │   └── auth/
    │   │       └── delta.yaml
    │   └── metadata.yaml       # Provenance, dates, author
    └── FIX-042-login-bug/
        └── ...
```

**Benefits**:

- Multiple concurrent changes cleanly separated
- Natural archival workflow (move to `.caws/archive/`)
- Easier to track which specs are being modified
- Maintains CAWS quality gates per change
- Preserves provenance in change folder

**Implementation Complexity**: Medium (requires schema updates, CLI changes)

#### 2. Intuitive Archive Command ⭐⭐⭐⭐

**Medium-High Value**

OpenSpec's `openspec archive <change> --yes` provides clear lifecycle management.

**Current CAWS**: No explicit archival mechanism

**Recommendation**: Add `caws archive` command

```bash
# Archive completed change
caws archive FEAT-001 --yes

# What it does:
# 1. Validates all acceptance criteria met
# 2. Merges deltas into base specs
# 3. Moves change folder to .caws/archive/FEAT-001/
# 4. Updates provenance with completion timestamp
# 5. Generates change summary
```

**Implementation Complexity**: Low

#### 3. Delta Format for Spec Changes ⭐⭐⭐⭐

**Medium-High Value**

OpenSpec uses explicit delta markers:

```markdown
## ADDED Requirements
### Requirement: Two-Factor Authentication
...

## MODIFIED Requirements
### Requirement: User Login
...

## REMOVED Requirements
### Requirement: Simple Password Auth
...
```

**Current CAWS**: Changes embedded in working-spec.yaml, hard to see what's new

**Recommendation**: Introduce delta format for change folders

**Implementation Complexity**: Medium (requires new validation logic)

#### 4. Lightweight Slash Commands ⭐⭐⭐

**Medium Value**

OpenSpec's native slash commands are intuitive:

- `/openspec:proposal` - Create change proposal
- `/openspec:apply` - Implement change
- `/openspec:archive` - Archive completed change

**Current CAWS**: MCP tools are powerful but less discoverable

**Recommendation**: Add slash command aliases in MCP server

```typescript
// Map natural commands to MCP tools
{
  '/caws:start': 'caws_init',
  '/caws:validate': 'caws_validate',
  '/caws:apply': 'caws_iterate',
  '/caws:archive': 'caws_archive',  // New command
  '/caws:status': 'caws_status'
}
```

**Implementation Complexity**: Low

### From Spec-kit

#### 1. Simpler Entry Point ⭐⭐⭐

**Medium Value**

Spec-kit's minimal approach reduces friction for new users.

**Current CAWS**: Comprehensive but intimidating for newcomers

**Recommendation**: Add `caws simple-init` mode

```bash
# Simple mode for small projects/POCs
caws init --simple my-project

# Creates minimal structure:
.caws/
├── working-spec.yaml    # Simplified schema
└── README.md

# Default to Tier 3 (70% coverage, 30% mutation)
# No change budget enforcement
# Minimal provenance tracking
```

**Benefits**: Lower barrier to entry, easier adoption

**Implementation Complexity**: Low (schema subset, conditional validation)

#### 2. Interactive Plan Generation ⭐⭐⭐⭐

**Medium-High Value**

Spec-kit's `specify plan` generates implementation plans from specs.

**Current CAWS**: Manual plan creation

**Recommendation**: Add `caws plan generate` command

```bash
# Generate implementation plan from working spec
caws plan generate --from-spec .caws/working-spec.yaml

# Output: .caws/changes/FEAT-001/plan.md
# - Tasks derived from acceptance criteria
# - Test matrix from non-functional requirements
# - Risk mitigation from invariants
```

**Implementation Complexity**: Medium (requires LLM integration or template engine)

#### 3. Status Dashboard ⭐⭐⭐

**Medium Value**

Spec-kit tracks implementation status clearly.

**Current CAWS**: `caws status` exists but could be enhanced

**Recommendation**: Enhanced visual dashboard

```bash
caws status --visual

# Shows:
# - Active changes with progress bars
# - Quality gate status (✓ or ✗)
# - Test coverage trends
# - Mutation score history
# - Time since last update
```

**Implementation Complexity**: Low (enhance existing command)

### From Both Systems

#### 1. Reduce Cognitive Load ⭐⭐⭐⭐⭐

**Critical Learning**

Both OpenSpec and Spec-kit are easier to understand than CAWS.

**Root Cause**: CAWS optimizes for comprehensive quality over simplicity

**Recommendation**: Tiered complexity model

- **Simple Mode**: Minimal CAWS for small projects (like Spec-kit)
- **Standard Mode**: Change folders + quality gates (like OpenSpec + CAWS)
- **Enterprise Mode**: Full CAWS with all features

**Implementation Complexity**: High (requires architecture changes)

#### 2. Better AI Agent Onboarding ⭐⭐⭐⭐

**High Value**

OpenSpec's natural language approach and Spec-kit's phase guidance are both more intuitive.

**Recommendation**: Enhanced agent tutorials

- Add interactive agent tutorial: `caws tutorial --agent`
- Provide example transcripts of successful agent workflows
- Create agent-specific quick reference cards
- Add common pitfall detection and guidance

**Implementation Complexity**: Low (documentation + examples)

## 9. Recommendations for CAWS

### Priority 1: High Value, Low Complexity

1. **Add `caws archive` command** (from OpenSpec)

   - Clear lifecycle management
   - Natural completion workflow

2. **Add slash command aliases** (from OpenSpec)

   - `/caws:start`, `/caws:validate`, `/caws:archive`
   - Improve discoverability

3. **Enhanced `caws status --visual`** (from Spec-kit)

   - Better progress tracking
   - Quality gate visualization

### Priority 2: High Value, Medium Complexity

4. **Adopt change-as-folder model** (from OpenSpec)

   - Most impactful improvement
   - Enables concurrent changes
   - Natural archival

5. **Introduce delta format** (from OpenSpec)

   - Clear visibility of changes
   - Easier to review what's new

6. **Add `caws plan generate`** (from Spec-kit)

   - Automated plan creation
   - Reduce manual overhead

### Priority 3: Strategic, High Complexity

7. **Tiered complexity model** (from both)

   - Simple/Standard/Enterprise modes
   - Lower barrier to entry
   - Maintain enterprise capabilities

8. **Interactive agent tutorial** (from both)

   - Guided learning experience
   - Reduce learning curve

## 10. Implementation Roadmap

### Phase 1: Quick Wins (2-3 weeks)

- [ ] Add `caws archive` command
- [ ] Add slash command aliases to MCP server
- [ ] Enhanced visual `caws status`
- [ ] Agent quick reference improvements

### Phase 2: Change Management (4-6 weeks)

- [ ] Design change-as-folder architecture
- [ ] Implement change folder structure
- [ ] Add delta format support
- [ ] Update validation for deltas
- [ ] Migration guide for existing projects

### Phase 3: Simplification (6-8 weeks)

- [ ] Design tiered complexity model
- [ ] Implement simple mode
- [ ] Create simplified schemas
- [ ] Add mode switching support
- [ ] Documentation for each tier

### Phase 4: Agent Experience (4-5 weeks)

- [ ] Interactive agent tutorial
- [ ] Plan generation from specs
- [ ] Agent workflow examples
- [ ] Common pitfall detection

## Conclusion

**Key Takeaways**:

1. **OpenSpec's change-as-folder model** is CAWS's biggest learning opportunity
2. **Spec-kit's simplicity** shows the value of progressive complexity
3. **CAWS's comprehensive approach** is its strength for enterprise use
4. **Balance is key**: Maintain quality rigor while reducing cognitive load

**Recommended Next Steps**:

1. Prototype change-as-folder model in CAWS
2. Gather feedback from current CAWS users
3. Implement Priority 1 quick wins
4. Design migration path for existing projects
5. Create RFC for tiered complexity model

The goal is to preserve CAWS's quality-first philosophy while learning from OpenSpec's intuitive change management and Spec-kit's approachability.

### To-dos

- [ ] Create a new branch for this work
- [ ] Decide if this is a new semver bump of the main CAWS framework
- [ ] Take the recommendation priorities and phases, create implementation documents in our /docs/implementation folder