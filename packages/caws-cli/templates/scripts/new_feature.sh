#!/bin/bash
# Create a new CAWS feature spec + optional worktree
#
# Usage:
#   scripts/new_feature.sh FEAT-001 "Feature description"
#   scripts/new_feature.sh FEAT-001 "Feature description" --worktree
#
# This script:
#   1. Creates a feature spec in .caws/specs/<ID>.yaml
#   2. Optionally creates a git worktree for isolated development

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: scripts/new_feature.sh <SPEC-ID> <title> [--worktree]" >&2
  echo "  example: scripts/new_feature.sh FEAT-001 'Add user authentication'" >&2
  exit 1
fi

SPEC_ID="$1"
TITLE="$2"
USE_WORKTREE="${3:-}"

# Validate spec ID format (PREFIX-NUMBER, e.g., FEAT-001, AUTH-042)
if ! echo "$SPEC_ID" | grep -qE '^[A-Z]+-[0-9]+$'; then
  echo "error: spec ID must be in format PREFIX-NUMBER (e.g., FEAT-001, AUTH-042)" >&2
  exit 1
fi

SPEC_FILE=".caws/specs/${SPEC_ID}.yaml"

# Check if spec already exists
if [ -f "$SPEC_FILE" ]; then
  echo "error: spec $SPEC_ID already exists at $SPEC_FILE" >&2
  exit 1
fi

# Create spec directory if needed
mkdir -p .caws/specs

# Generate spec scaffold
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$SPEC_FILE" << EOF
id: ${SPEC_ID}
type: feature
title: "${TITLE}"
status: draft
risk_tier: 2
mode: development
created_at: "${TIMESTAMP}"
updated_at: "${TIMESTAMP}"
blast_radius:
  modules: []
  data_migration: false
operational_rollback_slo: 5m
scope:
  in: []
  out:
    - docs/reference/v1/
    - .caws/
threats: []
invariants: []
acceptance: []
acceptance_criteria: []
milestones: []
EOF

echo "Created feature spec: $SPEC_FILE"

# Optionally create worktree
if [ "$USE_WORKTREE" = "--worktree" ]; then
  BRANCH_NAME="feat/${SPEC_ID,,}"  # lowercase
  WORKTREE_DIR=".caws/worktrees/${SPEC_ID,,}"

  git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME"
  echo "Created worktree: $WORKTREE_DIR (branch: $BRANCH_NAME)"
  echo ""
  echo "To start working:"
  echo "  cd $WORKTREE_DIR"
fi
