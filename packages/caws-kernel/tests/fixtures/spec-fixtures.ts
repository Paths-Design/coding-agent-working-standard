// Synthetic fixtures: small, focused YAML strings that violate exactly one
// rule. Distinct from the corpus negative-fixtures, which fail on many rules
// at once. Synthetic fixtures pinpoint regressions on specific forbidden
// surfaces (change_budget, acceptance_criteria, mode:development, etc.).

const VALID_T3_BASE = `
id: TEST-1
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: a test fixture
    when: validation runs
    then: it returns ok
non_functional: {}
contracts: []
`;

export const VALID_T3_SPEC = VALID_T3_BASE;

export const SPEC_WITH_CHANGE_BUDGET = `${VALID_T3_BASE}
change_budget:
  max_files: 25
  max_loc: 1000
`;

export const SPEC_WITH_ACCEPTANCE_CRITERIA = `${VALID_T3_BASE}
acceptance_criteria:
  - id: AC1
    description: legacy alias
`;

export const SPEC_WITH_SCOPE_INCLUDE = `
id: TEST-2
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
  include:
    - src/legacy/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_WITH_SCOPE_EXCLUDE = `
id: TEST-3
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
  exclude:
    - src/legacy/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_WITH_MODE_DEVELOPMENT = `
id: TEST-4
title: Test spec
risk_tier: 3
mode: development
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_WITH_STRING_RISK_TIER = `
id: TEST-5
title: Test spec
risk_tier: "T3"
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_WITH_EMPTY_SCOPE_IN = `
id: TEST-6
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in: []
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_WITH_GLOB_IN_SCOPE_OUT = `
id: TEST-7
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
  out:
    - "src/legacy/*"
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_WITH_LEGACY_STATUS_FIELD = `
id: TEST-8
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
status: active
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

// --- Tier-gated fixtures ---

export const SPEC_TIER2_NO_CONTRACTS = `
id: TEST-T2-1
title: Test spec
risk_tier: 2
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_TIER2_CHORE_NO_CONTRACTS = `
id: TEST-T2-2
title: Test spec
risk_tier: 2
mode: chore
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_TIER1_FULL = `
id: TEST-T1-1
title: Test spec
risk_tier: 1
mode: feature
lifecycle_state: draft
operational_rollback_slo: 5m
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional:
  security:
    - input validation
observability:
  - request log
rollback:
  - revert deployment
contracts:
  - name: example
    type: api
`;

export const SPEC_TIER1_MISSING_SUPPORT = `
id: TEST-T1-2
title: Test spec
risk_tier: 1
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts:
  - name: example
    type: api
`;

export const SPEC_TIER1_EXPERIMENTAL = `
id: TEST-T1-3
title: Test spec
risk_tier: 1
mode: feature
lifecycle_state: draft
operational_rollback_slo: 5m
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional:
  security:
    - input validation
observability:
  - request log
rollback:
  - revert deployment
contracts:
  - name: example
    type: api
experimental_mode:
  enabled: true
  rationale: tier-violation test
  expires_at: "2026-12-31T00:00:00Z"
`;

export const SPEC_TIER3_EXPERIMENTAL = `
id: TEST-T3-1
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
experimental_mode:
  enabled: true
  rationale: actually allowed on tier 3
  expires_at: "2026-12-31T00:00:00Z"
`;

// --- Lifecycle-shape fixtures ---

export const SPEC_ACTIVE_WITH_BLOCKERS = `
id: TEST-LC-1
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: active
blockers:
  - reason: waiting on review
    waiting_on: human
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_ACTIVE_WITH_RESOLUTION = `
id: TEST-LC-2
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: active
resolution: completed
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_CLOSED_NO_RESOLUTION = `
id: TEST-LC-3
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: closed
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

export const SPEC_SUPERSEDES_SELF = `
id: TEST-LC-4
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: closed
resolution: superseded
supersedes: TEST-LC-4
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;
