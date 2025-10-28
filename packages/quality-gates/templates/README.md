# Quality Gates Templates

This directory contains template files for CAWS quality gates configuration and build artifacts.

## Files

### Policy/Config Files (Editable by Humans)

- **`.caws/code-freeze.yaml`** - Policy for the code-freeze gate (types, keywords, budgets, allowlists)
- **`.caws/refactor-targets.yaml`** - Week/phase targets used by the refactor progress monitor
- **`.caws/refactor-baselines.yaml`** - Initial/baseline comparison anchors
- **`.caws/quality-exceptions.json`** - Shared exception framework store (all gates)
- **`.caws/naming-exceptions.json`** - Narrow, time-boxed exceptions specific to the naming gate
- **`.caws/file-scope.yaml`** - File-scope policy (tune traversal without editing scope manager)

### Build Artifacts (Written by Scripts; Machine-Readable)

- **`docs-status/refactoring-progress-report.json`** - Current snapshot from the refactor progress monitor
- **`docs-status/refactoring-progress-history.jsonl`** - Time-series append-only log (one JSON object per line)
- **`docs-status/quality-gates-report.json`** - Aggregate output from the quality-gates runner

## Usage

These templates are used when initializing a new CAWS project or when setting up quality gates in an existing project. The policy files can be customized by project maintainers, while the build artifacts are generated automatically by the quality gates system.
