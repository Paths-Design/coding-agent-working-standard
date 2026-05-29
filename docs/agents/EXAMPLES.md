---
doc_id: agents-examples
authority: reference
status: active
title: CAWS Examples — Real Feature Specs (v11.1.6)
owner: vNext rewrite team
updated: 2026-05-28
---

# CAWS Examples — Real Feature Specs

**Example working specifications from real projects**

> All examples conform to the v11.1.6 kernel schema (`packages/caws-kernel/src/schemas/spec.v1.json`). Create specs with `caws specs create <id> --title "..." --mode <mode> --risk-tier <n>`, then edit to add scope/invariants/acceptance. Fields `change_budget`, `threats`, `migrations`, `human_override`, `ai_assessment` are rejected by the schema and must not appear. `non_functional` accepts only four string-array subkeys: `accessibility`, `performance`, `reliability`, `security`.

---

## VS Code Extension - Theme Switcher

**Project**: VS Code extension adding theme switching capabilities  
**Risk Tier**: 2 (high user impact)  
**Files Changed**: 12  
**Lines Changed**: 450

```yaml
id: EXT-002
title: "Add Theme Switcher Extension"
risk_tier: 2
mode: feature
lifecycle_state: active
blast_radius:
  modules: ["extension", "webview", "commands"]
  data_migration: false
operational_rollback_slo: "5m"
scope:
  in: ["src/", "webview/", "package.json"]
  out: ["node_modules/", "out/"]
invariants:
  - "Webview only accesses workspace files via VS Code API"
  - "Extension activates in <1s on typical machine"
  - "All commands have keyboard shortcuts"
  - "Theme changes persist across sessions"
acceptance:
  - id: "A1"
    given: "User clicks theme switcher button"
    when: "Theme is selected"
    then: "VS Code theme changes immediately"
  - id: "A2"
    given: "Extension is activated"
    when: "Webview loads"
    then: "No CSP violations occur"
  - id: "A3"
    given: "User restarts VS Code"
    when: "Extension reactivates"
    then: "Previous theme selection is restored"
non_functional:
  accessibility:
    - "keyboard navigation"
    - "screen reader support"
    - "high contrast theme support"
  performance:
    - "activation < 1000ms on typical machine"
  security:
    - "CSP enforcement for webviews"
    - "No arbitrary filesystem access"
    - "Safe theme name validation"
contracts:
  - name: "vscode-api"
    type: "api"
    path: "src/contracts/vscode.d.ts"
observability:
  - "extension.activated"
  - "theme.changed"
  - "webview.loaded"
  - "activation_duration metric"
  - "theme_change_count metric"
rollback:
  - "Disable extension"
  - "Remove webview HTML/CSS/JS files"
  - "Revert package.json contributions"
```

---

## React Component Library - Button Component

**Project**: Add accessible button component to design system  
**Risk Tier**: 2 (API stability required)  
**Files Changed**: 8  
**Lines Changed**: 320

```yaml
id: LIB-003
title: "Add Accessible Button Component"
risk_tier: 2
mode: feature
lifecycle_state: active
blast_radius:
  modules: ["components", "types", "stories"]
  data_migration: false
operational_rollback_slo: "5m"
scope:
  in: ["src/components/Button/", "src/types/", "stories/"]
  out: ["src/components/other/", "node_modules/"]
invariants:
  - "Component API remains backward compatible"
  - "All variants pass accessibility audits"
  - "Bundle size impact < 2KB"
  - "TypeScript types exported correctly"
acceptance:
  - id: "A1"
    given: "Developer imports Button component"
    when: "Component is rendered"
    then: "Button displays with correct styling"
  - id: "A2"
    given: "Screen reader user navigates to button"
    when: "Button receives focus"
    then: "Accessible name is announced"
  - id: "A3"
    given: "Button has loading state"
    when: "Loading prop is true"
    then: "Button shows loading indicator and is disabled"
non_functional:
  accessibility:
    - "WCAG 2.1 AA compliance"
    - "Keyboard navigation support"
    - "Screen reader compatibility"
    - "Focus management"
  performance:
    - "bundle size impact < 5KB"
  security:
    - "XSS prevention in button content"
    - "Safe event handler binding"
contracts:
  - name: "button-component-api"
    type: "schema"
    path: "src/types/button.ts"
observability:
  - "button_click_count metric"
  - "button_render_count metric"
rollback:
  - "Remove Button component files"
  - "Update component exports"
  - "Remove button stories"
```

---

## REST API - User Authentication

**Project**: Add JWT-based authentication to user service  
**Risk Tier**: 1 (security critical)  
**Files Changed**: 18  
**Lines Changed**: 850

```yaml
id: API-004
title: "Implement JWT Authentication"
risk_tier: 1
mode: feature
lifecycle_state: active
blast_radius:
  modules: ["auth", "users", "middleware", "database"]
  data_migration: true
operational_rollback_slo: "15m"
scope:
  in: ["src/auth/", "src/users/", "src/middleware/", "migrations/"]
  out: ["src/other-services/", "node_modules/"]
invariants:
  - "All endpoints require valid authentication"
  - "JWT tokens expire within 24 hours"
  - "Failed auth attempts are rate limited"
  - "User passwords are properly hashed"
  - "No sensitive data in application logs"
acceptance:
  - id: "A1"
    given: "User provides valid credentials"
    when: "Login endpoint is called"
    then: "JWT token is returned"
  - id: "A2"
    given: "User provides invalid credentials"
    when: "Login endpoint is called"
    then: "401 Unauthorized is returned"
  - id: "A3"
    given: "Request includes valid JWT"
    when: "Protected endpoint is called"
    then: "Request succeeds with user context"
  - id: "A4"
    given: "Request includes expired JWT"
    when: "Protected endpoint is called"
    then: "401 Unauthorized is returned"
  - id: "A5"
    given: "User logs out"
    when: "Token is used afterward"
    then: "401 Unauthorized is returned"
non_functional:
  accessibility:
    - "API documentation accessible without authentication"
  performance:
    - "auth endpoint p95 < 200ms"
  reliability:
    - "database migration rollback tested before deployment"
    - "token blacklist survives service restart"
  security:
    - "JWT tokens properly signed"
    - "Password hashing with bcrypt"
    - "Rate limiting on auth endpoints"
    - "CORS properly configured"
    - "Helmet security headers"
    - "Input validation and sanitization"
contracts:
  - name: "auth-openapi"
    type: "api"
    path: "docs/api/auth.yaml"
observability:
  - "auth.login.success"
  - "auth.login.failure"
  - "auth.token.expired"
  - "auth.logout"
  - "auth_requests_total metric"
  - "auth_failures_total metric"
  - "active_sessions metric"
rollback:
  - "Revert database migration"
  - "Remove authentication middleware"
  - "Restore original endpoint access"
  - "Clear any cached tokens"
```

---

## Code Refactor - Extract Service Layer

**Project**: Extract business logic into service layer  
**Risk Tier**: 2 (behavior preservation required)  
**Files Changed**: 12  
**Lines Changed**: 380

```yaml
id: REFACTOR-005
title: "Extract User Service Layer"
risk_tier: 2
mode: refactor
lifecycle_state: active
blast_radius:
  modules: ["controllers", "services", "models"]
  data_migration: false
operational_rollback_slo: "5m"
scope:
  in: ["src/controllers/", "src/services/", "src/models/", "tests/"]
  out: ["src/views/", "src/public/", "node_modules/"]
invariants:
  - "All existing APIs return identical responses"
  - "All existing tests continue to pass"
  - "No performance regressions"
  - "Type safety maintained throughout"
acceptance:
  - id: "A1"
    given: "Existing API endpoints"
    when: "Called with same parameters"
    then: "Return identical responses"
  - id: "A2"
    given: "Existing controller tests"
    when: "Executed after refactor"
    then: "All tests pass without modification"
  - id: "A3"
    given: "Service layer methods"
    when: "Called directly"
    then: "Behave identically to controller logic"
non_functional:
  performance:
    - "api p95 < 250ms (no regression)"
  security:
    - "Input validation preserved"
    - "Authorization checks maintained"
contracts:
  - name: "user-service-types"
    type: "schema"
    path: "src/types/services.ts"
observability:
  - "service_method_calls metric"
  - "service_operation_flow trace"
rollback:
  - "Revert controller files to original state"
  - "Remove service layer files"
  - "Update imports back to original"
```

---

## Bug Fix - Memory Leak in Data Processing

**Project**: Fix memory leak in CSV processing pipeline  
**Risk Tier**: 1 (data integrity + performance)  
**Files Changed**: 3  
**Lines Changed**: 45

```yaml
id: FIX-006
title: "Fix Memory Leak in CSV Processor"
risk_tier: 1
mode: fix
lifecycle_state: active
blast_radius:
  modules: ["csv-processor", "file-upload"]
  data_migration: false
operational_rollback_slo: "1m"
scope:
  in: ["src/csv-processor.ts", "tests/csv-processor.test.ts"]
  out: ["src/other-modules/", "node_modules/"]
invariants:
  - "All CSV files process completely"
  - "Memory usage remains bounded"
  - "Processing performance maintained"
  - "Data integrity preserved"
acceptance:
  - id: "A1"
    given: "Large CSV file (10MB+)"
    when: "Processed through pipeline"
    then: "Memory usage stays under 100MB"
  - id: "A2"
    given: "CSV with malformed data"
    when: "Processed"
    then: "Invalid rows are skipped, valid rows processed"
  - id: "A3"
    given: "Processing interrupted"
    when: "Restarted"
    then: "Can resume from interruption point"
non_functional:
  performance:
    - "processing p95 < 5000ms"
  reliability:
    - "memory usage bounded under 100MB for 10MB+ files"
  security:
    - "File upload size limits enforced"
    - "Path traversal prevented"
contracts:
  - name: "csv-processor-behavior"
    type: "behavior"
    description: "Memory-bounded streaming CSV processing contract"
observability:
  - "csv.processing.started"
  - "csv.processing.completed"
  - "csv.processing.error"
  - "csv_files_processed metric"
  - "csv_processing_duration metric"
  - "memory_usage_peak metric"
rollback:
  - "Revert csv-processor.ts to previous version"
  - "Remove any new test files"
```

---

## Documentation - API Reference

**Project**: Add comprehensive API documentation  
**Risk Tier**: 3 (no functional changes)  
**Files Changed**: 8  
**Lines Changed**: 1200

```yaml
id: DOC-007
title: "Add API Documentation"
risk_tier: 3
mode: doc
lifecycle_state: active
blast_radius:
  modules: ["docs"]
  data_migration: false
scope:
  in: ["docs/", "src/"]
  out: ["src/tests/", "node_modules/"]
invariants:
  - "All public APIs are documented"
  - "Examples are runnable"
  - "Documentation builds successfully"
acceptance:
  - id: "A1"
    given: "Developer visits docs site"
    when: "Looks for API reference"
    then: "Finds complete method signatures and descriptions"
  - id: "A2"
    given: "Developer copies example code"
    when: "Runs it"
    then: "Code executes successfully"
non_functional:
  accessibility:
    - "Documentation accessible without JavaScript"
contracts: []
observability:
  - "docs_page_views metric"
rollback:
  - "Remove documentation files"
  - "Revert any API changes made for documentation"
```

---

## CLI Tool - Add Interactive Mode

**Project**: Add interactive mode to CLI tool  
**Risk Tier**: 3 (low risk feature addition)  
**Files Changed**: 4  
**Lines Changed**: 120

```yaml
id: CLI-008
title: "Add Interactive Mode to CLI"
risk_tier: 3
mode: feature
lifecycle_state: active
blast_radius:
  modules: ["cli", "commands"]
  data_migration: false
scope:
  in: ["src/cli/", "src/commands/"]
  out: ["src/other/", "node_modules/"]
invariants:
  - "Existing CLI usage unchanged"
  - "Help text remains informative"
  - "Exit codes remain standard"
acceptance:
  - id: "A1"
    given: "User runs command with --interactive"
    when: "Provides inputs"
    then: "Command executes with provided parameters"
  - id: "A2"
    given: "User runs command normally"
    when: "No --interactive flag"
    then: "Behavior identical to before"
non_functional:
  performance:
    - "interactive prompt response < 50ms"
contracts: []
observability:
  - "cli.interactive.started"
  - "cli.interactive.completed"
  - "cli_interactive_usage metric"
rollback:
  - "Remove interactive mode code"
  - "Remove inquirer dependency"
```

---

## Monorepo - Add Shared Component

**Project**: Add shared Button component to monorepo  
**Risk Tier**: 1 (cross-package compatibility)  
**Files Changed**: 12  
**Lines Changed**: 280

```yaml
id: MONO-009
title: "Add Shared Button Component"
risk_tier: 1
mode: feature
lifecycle_state: active
blast_radius:
  modules: ["shared/ui", "packages/app1", "packages/app2"]
  data_migration: false
operational_rollback_slo: "10m"
scope:
  in: ["packages/shared/src/ui/", "packages/app1/", "packages/app2/"]
  out: ["packages/other/", "node_modules/"]
invariants:
  - "All packages continue to build"
  - "Component API remains stable"
  - "TypeScript types work across packages"
  - "Bundle sizes remain acceptable"
acceptance:
  - id: "A1"
    given: "Package imports shared Button"
    when: "Component is used"
    then: "Renders correctly with consistent styling"
  - id: "A2"
    given: "Shared component is updated"
    when: "All packages build"
    then: "No breaking changes detected"
non_functional:
  accessibility:
    - "WCAG 2.1 AA compliance"
  performance:
    - "shared bundle contribution < 15KB"
  security:
    - "XSS prevention"
contracts:
  - name: "shared-ui-types"
    type: "schema"
    path: "packages/shared/src/types/ui.ts"
observability:
  - "shared_component_usage metric"
rollback:
  - "Remove shared component"
  - "Update package imports"
  - "Revert consuming package changes"
```

---

## Key Patterns Observed

### Risk Tier Patterns

**Tier 1 Projects** (Critical):
- Authentication, billing, data migrations
- API contracts always required
- Manual review mandatory
- Higher change budgets for complexity

**Tier 2 Projects** (Standard):
- Features, UI components, refactorings
- Contracts required for external APIs
- E2E testing recommended
- Balanced change budgets

**Tier 3 Projects** (Low Risk):
- Internal tools, docs, simple fixes
- Minimal testing requirements
- Lower change budgets
- Fast rollback times

### Project Type Patterns

**Extensions**: Focus on webview security, activation performance, VS Code API compliance

**Libraries**: Bundle size, TypeScript exports, backward compatibility, tree-shaking

**APIs**: Authentication, data validation, performance, API contracts, migration planning

**CLIs**: Exit codes, help text, error messages, ergonomics

**Monorepos**: Cross-package compatibility, build coordination, shared component stability

### Common Invariants

1. **Security**: Input validation, XSS prevention, secure defaults
2. **Performance**: Response times, bundle sizes, memory bounds
3. **Compatibility**: Backward compatibility, API stability
4. **Reliability**: Error handling, graceful degradation
5. **Observability**: Logging, metrics, tracing coverage

---

## Using These Examples

1. **Find Similar Project**: Look for examples matching your project type and risk level
2. **Create via CLI**: Run `caws specs create <id> --title "..." --mode <mode> --risk-tier <n>` to generate the base YAML
3. **Edit the result**: Add scope, invariants, acceptance criteria, and non-functional requirements from the examples above
4. **Verify early**: Run `caws doctor` and `caws gates run --spec <id>` to catch issues (`caws validate` and `caws scaffold` do not exist in v11)
5. **Iterate**: Refine based on your project's specific requirements; use `caws specs show <id>` to inspect the current state

These examples show how CAWS scales from simple fixes to complex monorepo changes while maintaining consistent quality and safety standards.

---

**Examples Version**: 11.1  
**CAWS Version**: 11.1.6  
**Last Updated**: 2026-05-28
