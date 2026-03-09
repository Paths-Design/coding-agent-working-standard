# CAWS Tools

This directory contains CAWS-specific tools that aren't available in the CLI.

## scope-guard.js

Checks whether a file is within scope of active working-spec and feature specs. Used by Cursor hooks for scope validation on file attachments.

```bash
# Check if a file is in scope
node .caws/tools/scope-guard.js check src/index.js

# Exit code 0 = in scope, 1 = out of scope
```

**Usage in Cursor Hooks:**

The `.cursor/hooks/scope-guard.sh` hook automatically uses this tool to validate file attachments against working spec scope boundaries.
