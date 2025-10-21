# CAWS Multi-Agent Workflow Guide

**Critical: Each agent MUST work on their own feature-specific spec to avoid conflicts**

## The Problem (Anti-Pattern)

❌ **WRONG**: Multiple agents working on `.caws/working-spec.yaml`

- Agent A working on user authentication
- Agent B working on payment system
- Both modify `.caws/working-spec.yaml`
- **Result**: Agents overwrite each other's work, conflicts, chaos

## The Solution (Correct Pattern)

✅ **CORRECT**: Each agent works on their own feature spec in `.caws/specs/`

- Agent A works on `.caws/specs/user-auth.yaml`
- Agent B works on `.caws/specs/payment-system.yaml`
- **Result**: Parallel development, no conflicts, clear boundaries

## Architecture: Feature-Specific Specs

### Directory Structure

```
.caws/
  ├── specs/                         # Feature-specific specs (NEW, PREFERRED)
  │   ├── registry.json              # Spec registry
  │   ├── user-auth.yaml             # Agent A's feature
  │   ├── payment-system.yaml        # Agent B's feature
  │   └── dashboard-ui.yaml          # Agent C's feature
  └── working-spec.yaml              # Legacy single-spec (DEPRECATED)
```

### Spec Resolution Priority

CAWS uses this resolution order:

1. **Feature spec** (via `--spec-id`): `.caws/specs/<spec-id>.yaml` ← **PREFERRED**
2. **Explicit path** (via spec-file arg): Custom path
3. **Auto-detect**: If only 1 spec exists, use it
4. **Legacy fallback**: `.caws/working-spec.yaml` ← **DEPRECATED**

## Multi-Agent Workflow

### Step 1: Create Feature-Specific Specs

**Each agent creates their own spec:**

```bash
# Agent A: User Authentication
caws specs create user-auth --type feature --title "User Authentication System"

# Agent B: Payment System
caws specs create payment-system --type feature --title "Payment Processing"

# Agent C: Dashboard UI
caws specs create dashboard-ui --type feature --title "Admin Dashboard"
```

### Step 2: Work on Your Feature Spec

**Each agent specifies their spec ID in all commands:**

```bash
# Agent A works on user-auth
caws validate --spec-id user-auth
caws status --spec-id user-auth
caws iterate --spec-id user-auth
caws evaluate --spec-id user-auth

# Agent B works on payment-system
caws validate --spec-id payment-system
caws status --spec-id payment-system

# Agent C works on dashboard-ui
caws validate --spec-id dashboard-ui
caws status --spec-id dashboard-ui
```

### Step 3: Track Progress Independently

Each agent's progress is isolated:

```bash
# Agent A updates their acceptance criteria
caws progress update --spec-id user-auth --criterion-id A1 --status completed

# Agent B updates theirs (no conflict with Agent A)
caws progress update --spec-id payment-system --criterion-id A1 --status in_progress
```

### Step 4: Archive Completed Features

When a feature is complete:

```bash
# Agent A completes user-auth
caws archive FEAT-001 --spec-id user-auth

# Agent B still working on payment-system (no conflict)
caws status --spec-id payment-system
```

## Complete Example: 3 Agents, 3 Features

### Agent A: User Authentication

```bash
# Create spec
caws specs create user-auth --type feature --title "User Authentication"

# Edit spec
# File: .caws/specs/user-auth.yaml
id: FEAT-001
title: "User Authentication System"
risk_tier: T1  # High security
mode: feature
scope:
  in:
    - "src/auth/"
    - "tests/auth/"
  out:
    - "src/payments/"  # Don't touch Agent B's work
    - "src/dashboard/" # Don't touch Agent C's work
acceptance:
  - id: A1
    given: "User submits valid credentials"
    when: "Authentication is requested"
    then: "JWT token is issued"
  - id: A2
    given: "Invalid credentials"
    when: "Authentication is requested"
    then: "401 Unauthorized error returned"

# Validate
caws validate --spec-id user-auth

# Check status
caws status --spec-id user-auth

# Update progress
caws progress update --spec-id user-auth --criterion-id A1 --status completed

# Get guidance
caws iterate --spec-id user-auth --current-state "Implemented JWT generation"
```

### Agent B: Payment System

```bash
# Create spec
caws specs create payment-system --type feature --title "Payment Processing"

# Edit spec
# File: .caws/specs/payment-system.yaml
id: FEAT-002
title: "Payment Processing System"
risk_tier: T1  # High security + financial
mode: feature
scope:
  in:
    - "src/payments/"
    - "tests/payments/"
  out:
    - "src/auth/"      # Don't touch Agent A's work
    - "src/dashboard/" # Don't touch Agent C's work
acceptance:
  - id: A1
    given: "Valid payment method"
    when: "User initiates payment"
    then: "Payment is processed successfully"
  - id: A2
    given: "Insufficient funds"
    when: "Payment is attempted"
    then: "422 Unprocessable Entity error returned"

# All commands use --spec-id payment-system
caws validate --spec-id payment-system
caws status --spec-id payment-system
caws iterate --spec-id payment-system
```

### Agent C: Dashboard UI

```bash
# Create spec
caws specs create dashboard-ui --type feature --title "Admin Dashboard"

# Edit spec
# File: .caws/specs/dashboard-ui.yaml
id: FEAT-003
title: "Admin Dashboard UI"
risk_tier: T2  # Standard
mode: feature
scope:
  in:
    - "src/dashboard/"
    - "tests/dashboard/"
  out:
    - "src/auth/"     # Don't touch Agent A's work
    - "src/payments/" # Don't touch Agent B's work
acceptance:
  - id: A1
    given: "Admin is authenticated"
    when: "Dashboard is loaded"
    then: "User metrics are displayed"

# All commands use --spec-id dashboard-ui
caws validate --spec-id dashboard-ui
caws status --spec-id dashboard-ui
```

## Listing All Specs

View all active feature specs:

```bash
caws specs list
```

Output:

```
📋 CAWS Specs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ID              Type      Status      Title
─────────────────────────────────────────────────
user-auth       feature   active      User Authentication System
payment-system  feature   in_progress Payment Processing
dashboard-ui    feature   draft       Admin Dashboard UI
```

## Migration from Legacy Single-Spec

### If You're Using `.caws/working-spec.yaml`:

**Step 1: Identify features in your working spec**

Read your `.caws/working-spec.yaml` and identify distinct features.

**Step 2: Split into feature-specific specs**

```bash
# For each feature, create a new spec
caws specs create <feature-id> --type feature --title "<Feature Title>"
```

**Step 3: Copy relevant sections**

Copy the relevant acceptance criteria, scope, and contracts from `working-spec.yaml` to each feature spec.

**Step 4: Update agent instructions**

Tell each agent to use `--spec-id <their-feature-id>` in all commands.

**Step 5: Archive legacy spec (optional)**

```bash
mv .caws/working-spec.yaml .caws/working-spec.yaml.legacy
```

## Common Pitfalls & Solutions

### Pitfall 1: Forgetting `--spec-id`

❌ **Problem**:

```bash
caws validate  # Which spec? Multiple exist!
```

✅ **Solution**:

```bash
caws validate --spec-id user-auth  # Explicit
```

### Pitfall 2: Overlapping Scopes

❌ **Problem**:

```yaml
# user-auth.yaml
scope:
  in: ["src/"]  # Too broad!

# payment-system.yaml
scope:
  in: ["src/"]  # Conflict with user-auth!
```

✅ **Solution**:

```yaml
# user-auth.yaml
scope:
  in: ["src/auth/", "tests/auth/"]
  out: ["src/payments/", "src/dashboard/"]

# payment-system.yaml
scope:
  in: ["src/payments/", "tests/payments/"]
  out: ["src/auth/", "src/dashboard/"]
```

### Pitfall 3: Using Legacy Working Spec

❌ **Problem**:

```bash
# Multiple agents all editing .caws/working-spec.yaml
caws validate  # Defaults to legacy spec, conflicts!
```

✅ **Solution**:

```bash
# Each agent has their own spec
caws validate --spec-id user-auth
caws validate --spec-id payment-system
```

## Best Practices

### 1. One Feature = One Spec

✅ Each feature gets its own spec file
✅ Clear ownership and boundaries
✅ No conflicts between agents

### 2. Always Use `--spec-id`

✅ Explicit is better than implicit
✅ Prevents accidental conflicts
✅ Makes intent clear

### 3. Non-Overlapping Scopes

✅ Define clear `scope.in` boundaries
✅ Explicitly exclude other features in `scope.out`
✅ Prevents accidental modifications

### 4. Coordinate Cross-Feature Changes

If two features need to interact:

1. Define contracts first (API, types)
2. One agent owns the contract
3. Other agent consumes the contract
4. No direct file modifications across scopes

## MCP Server Support

The CAWS MCP server fully supports multi-spec workflows:

```javascript
// Via MCP server
{
  "command": "/caws:validate",
  "specId": "user-auth"  // Feature-specific
}

{
  "command": "/caws:status",
  "specId": "payment-system"  // Another feature
}

{
  "command": "/caws:specs list"  // List all features
}
```

## Summary

### Key Takeaways

1. **Feature-specific specs** (`.caws/specs/<id>.yaml`) are the PRIMARY pattern
2. **Legacy working-spec.yaml** is DEPRECATED for multi-agent workflows
3. **Always use `--spec-id`** when multiple specs exist
4. **Non-overlapping scopes** prevent conflicts
5. **Each agent owns their feature** completely

### Quick Reference

```bash
# Create feature spec
caws specs create <feature-id>

# Always use --spec-id
caws validate --spec-id <feature-id>
caws status --spec-id <feature-id>
caws iterate --spec-id <feature-id>
caws evaluate --spec-id <feature-id>
caws diagnose --spec-id <feature-id>

# List all specs
caws specs list

# View specific spec
caws specs show <feature-id>
```

---

**Remember**: The multi-spec system exists specifically to enable parallel multi-agent development. Use it! Each agent working on their own spec = no conflicts, happy agents.



