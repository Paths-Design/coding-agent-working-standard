# CAWS Tools

This directory contains CAWS-specific tools that aren't available in the CLI.

## scope-guard.js

Enforces that experimental code stays within designated sandbox areas. Used by Cursor hooks for scope validation.

```bash
# Validate experimental code containment
node .caws/tools/scope-guard.js validate

# Check containment status
node .caws/tools/scope-guard.js check .caws/working-spec.yaml
```

**Usage in Cursor Hooks:**

The `.cursor/hooks/scope-guard.sh` hook automatically uses this tool to validate file attachments against working spec scope boundaries.


