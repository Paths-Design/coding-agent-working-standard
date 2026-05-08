// Synthetic policy fixtures. The corpus has the live drifted policy.yaml.live;
// these are focused scenarios that pinpoint individual rules.

export const VALID_MINIMAL_POLICY = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
`;

export const POLICY_WITH_LABEL_FIELDS = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
    label: "Critical"
  "2":
    max_files: 100
    max_loc: 10000
    label: "Standard"
  "3":
    max_files: 500
    max_loc: 40000
    label: "Low Risk"
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
`;

export const POLICY_MISPLACED_APPROVERS = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
edit_rules:
  policy_and_code_same_pr: false
  min_approvers_for_budget_raise: 2
`;

export const POLICY_CORRECTED_APPROVERS = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
waivers:
  min_approvers_for_budget_raise: 2
edit_rules:
  policy_and_code_same_pr: false
`;

export const POLICY_UNKNOWN_GATE = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
  cosmic_ray_check:
    enabled: true
    mode: block
`;

export const POLICY_UNKNOWN_GATE_MODE = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: complain
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
`;

export const POLICY_MISSING_REQUIRED_GATE = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
`;

export const POLICY_BROAD_NON_GOVERNED_ZONE = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
non_governed_zones:
  - "**"
`;

export const POLICY_BROAD_NON_GOVERNED_ZONE_FORCED = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
non_governed_zones_force: true
non_governed_zones:
  - "**"
`;

export const POLICY_NON_MONOTONIC_FILES = `
version: 1
risk_tiers:
  "1":
    max_files: 100
    max_loc: 250
  "2":
    max_files: 50
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
`;

export const POLICY_NON_MONOTONIC_LOC = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 50000
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
`;

export const POLICY_CRITICAL_GATE_NOT_BLOCK = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: warn
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
`;

export const POLICY_RISKY_ROOT_PASSTHROUGH = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
root_passthrough:
  - README.md
  - package.json
  - .gitignore
`;

export const POLICY_ROOT_PASSTHROUGH_WITH_SLASH = `
version: 1
risk_tiers:
  "1":
    max_files: 10
    max_loc: 250
  "2":
    max_files: 100
    max_loc: 10000
  "3":
    max_files: 500
    max_loc: 40000
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
root_passthrough:
  - "src/foo.ts"
`;
