# CAWS Tools

This directory holds optional project-local helper scripts. **Scope decisions are
owned by the CAWS CLI, not by scripts in this directory.**

## Scope checking

Use the CLI for all scope decisions — it resolves through the canonical control
plane (`.caws/specs/`) regardless of cwd, including from inside linked worktrees:

```bash
# Explain the scope decision for a path (always exits 0)
caws scope show src/index.js

# Enforce the scope decision (exit 0 = admit, 1 = reject)
caws scope check src/index.js
```

Hooks (Claude Code, Cursor, etc.) should call `caws scope check <path>` so they
inherit the same authoritative binding the kernel uses. Do not reimplement
scope logic in a local script — a separate reader of `.caws/specs/` can diverge
from the kernel's decision and reintroduce the split-brain authority class CAWS
exists to prevent.
