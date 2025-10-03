# Cursor Hooks for CAWS

This directory contains Cursor IDE hooks that provide real-time quality gates during AI-assisted coding sessions.

## What Are Cursor Hooks?

Cursor hooks are scripts that run automatically at specific points in the AI coding loop:

- **Before** dangerous commands execute
- **After** files are edited
- **Before** files are read (to prevent leaking secrets)
- **When** you submit prompts
- **When** the AI session ends

## How Hooks Complement Git Hooks

CAWS uses a **three-tier quality approach**:

1. **Cursor Hooks** (Real-time) - Instant feedback as you code
2. **Git Hooks** (Commit/Push) - Validation before sharing code
3. **CI/CD** (PR/Release) - Comprehensive gates before merge

Cursor hooks are **not a replacement** for git hooks - they work together to catch issues earlier in the development flow.

## Available Hooks

### Safety Hooks

#### `block-dangerous.sh`

**Event**: `beforeShellExecution`

Blocks or requires permission for dangerous commands:

- ⛔ **Hard blocks**: `rm -rf /`, `DROP DATABASE`, disk formatting
- ⚠️ **Asks permission**: `git push --force`, `npm publish`, `docker system prune`
- ⚠️ **Warns**: Commands that skip git hooks (`--no-verify`)

#### `scan-secrets.sh`

**Event**: `beforeReadFile`

Prevents AI from reading sensitive files:

- ⛔ **Blocks**: `.env` files, certificates, private keys
- ⚠️ **Warns**: Files containing API keys, passwords, PII patterns

### Quality Hooks

#### `format.sh`

**Event**: `afterFileEdit`

Auto-formats edited files using:

- Prettier (JS, TS, JSON, MD, YAML)
- ESLint (with `--fix` flag)

#### `validate-spec.sh`

**Event**: `afterFileEdit`

Validates `working-spec.yaml` when edited:

- Runs `caws validate` automatically
- Shows validation errors with suggestions

### Scope Hooks

#### `naming-check.sh`

**Event**: `afterFileEdit`

Enforces CAWS naming conventions:

- ⛔ **Blocks**: `enhanced-*`, `*-copy`, `*-new`, `final-*`, etc.
- Detects duplicate modules (e.g., both `processor.ts` and `enhanced-processor.ts`)

#### `scope-guard.sh`

**Event**: `beforeSubmitPrompt`

Checks if attached files are within `working-spec.yaml` scope:

- ⚠️ **Warns**: Files outside defined scope
- Non-blocking (you can proceed with warning)

### Audit Hooks

#### `audit.sh`

**Event**: All events

Logs all AI interactions for provenance:

- Creates daily audit logs in `.cursor/logs/`
- Tracks conversation IDs and generation IDs
- Integrates with CAWS provenance system

## Configuration

### Enable/Disable Specific Hooks

Edit `hooks.json` to control which hooks run:

```json
{
  "version": 1,
  "hooks": {
    "afterFileEdit": [
      { "command": "./.cursor/hooks/format.sh" }
      // Comment out hooks you don't want
    ]
  }
}
```

### Temporarily Disable All Hooks

1. **Via Cursor UI**: Settings → Hooks → Disable
2. **Via config**: Rename `hooks.json` to `hooks.json.disabled`

### Debug Hooks

View hook execution details:

1. Open Cursor Settings → Hooks tab
2. Check the Hooks output channel for errors
3. Review audit logs: `.cursor/logs/audit-*.log`

## Hook Responses

Hooks communicate with Cursor using JSON:

### Permission Decisions

```json
{
  "permission": "allow", // or "deny", "ask"
  "userMessage": "Visible to you",
  "agentMessage": "Sent to AI"
}
```

### Prompt Control

```json
{
  "continue": true, // or false
  "userMessage": "Optional warning"
}
```

## Customizing Hooks

All hooks are bash scripts that:

1. Read JSON input from stdin
2. Process the input (call CAWS tools, check patterns, etc.)
3. Return JSON output to stdout
4. Exit with code 0

Example custom hook:

```bash
#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

# Your custom logic here

echo '{"permission":"allow"}' 2>/dev/null
exit 0
```

## Common Issues

### Hook not executing?

- Restart Cursor after editing `hooks.json`
- Check that scripts are executable: `chmod +x .cursor/hooks/*.sh`
- Verify paths in `hooks.json` are relative to project root

### Hook blocking valid operations?

- Temporarily disable: Cursor Settings → Hooks → Disable
- Edit the specific hook script to adjust rules
- Report false positives as CAWS issues

### Hooks too slow?

- Remove expensive checks from real-time hooks
- Move comprehensive validation to git hooks or CI
- Use `--quiet` flags for faster tool execution

## Integration with CAWS Tools

Hooks leverage existing CAWS tools:

| Hook               | CAWS Tool        | Purpose             |
| ------------------ | ---------------- | ------------------- |
| `validate-spec.sh` | `validate.js`    | Spec validation     |
| `scope-guard.sh`   | `scope-guard.js` | File scope checking |
| `audit.sh`         | `provenance.js`  | Audit logging       |

## Best Practices

1. **Don't block everything** - Use warnings for edge cases
2. **Keep hooks fast** - Real-time means < 500ms
3. **Fail gracefully** - Exit 0 even on errors to avoid breaking Cursor
4. **Log for debugging** - Write to `.cursor/logs/` when investigating issues
5. **Test manually** - Run hooks with sample JSON before committing

## Resources

- [Cursor Hooks Documentation](https://docs.cursor.com/advanced/hooks)
- [CAWS Hook Strategy](../../docs/HOOK_STRATEGY.md)
- [CAWS Developer Guide](../../docs/caws-developer-guide.md)

---

**Last Updated**: October 3, 2025  
**Author**: @darianrosebrook
