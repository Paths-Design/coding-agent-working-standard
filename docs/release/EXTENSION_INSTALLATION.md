# CAWS VS Code Extension Installation - v5.0.0

## Issue Identified

The MCP server in Cursor was running v4.0.0 and experiencing JSON parse errors due to ANSI color codes in output.

## Fixes Applied in v5.0.0

1. **Logger Output Isolation**
   - All logger output now goes to stderr (not stdout)
   - MCP protocol uses stdout exclusively for JSON messages
   - Prevents log messages from corrupting MCP communication

2. **Color Suppression in CLI Calls**
   - All `execSync` calls now set `NO_COLOR='1'` and `FORCE_COLOR='0'`
   - Prevents CLI commands from outputting colored text
   - Ensures pure text output compatible with JSON serialization

3. **Extension Packaging**
   - Improved `.vscodeignore` to exclude parent directories
   - Fixed sensitive file detection issues
   - Reduced package size while maintaining functionality

## Installation Steps

### Option 1: Install from VSIX (Recommended)

```bash
# 1. Uninstall old extension version in Cursor
# Command Palette (Cmd+Shift+P) → "Extensions: Uninstall Extension"
# Search for "CAWS" and uninstall

# 2. Install new v5.0.0 extension
# Command Palette → "Extensions: Install from VSIX..."
# Navigate to: packages/caws-vscode-extension/caws-vscode-extension-5.0.0.vsix

# 3. Reload Cursor window
# Command Palette → "Developer: Reload Window"
```

### Option 2: Command Line Installation

```bash
# Navigate to the package location
cd /Users/darianrosebrook/Desktop/Projects/caws/packages/caws-vscode-extension

# Install via code command (if available)
code --install-extension caws-vscode-extension-5.0.0.vsix

# Or for Cursor specifically
cursor --install-extension caws-vscode-extension-5.0.0.vsix

# Reload Cursor
```

## Verification

After installation:

1. **Check Extension Version**
   - Open Extensions view (Cmd+Shift+X)
   - Search for "CAWS"
   - Verify version shows 5.0.0

2. **Check MCP Server**
   - MCP logs should show no JSON parse errors
   - MCP server path should be: `.../paths-design.caws-vscode-extension-5.0.0/bundled/mcp-server/index.js`

3. **Test Commands**
   - Open Command Palette (Cmd+Shift+P)
   - Type "CAWS:" to see all commands
   - Try "CAWS: Show Quality Dashboard"
   - Verify no errors in Output panel (View → Output → CAWS)

## Known Issues

### Still Running v4.0.0?

If the MCP server log still shows v4.0.0:
- Cursor may be caching the old extension
- Solution: Fully quit and restart Cursor (not just reload window)
- Check: `ls ~/.cursor/extensions/` should show v5.0.0

### MCP JSON Errors Persist?

If you still see "Unexpected token" errors:
- The MCP server may still be loading the old bundled version
- Solution:
  1. Quit Cursor completely
  2. Remove old extension: `rm -rf ~/.cursor/extensions/paths-design.caws-vscode-extension-4.0.0`
  3. Reinstall v5.0.0 extension
  4. Restart Cursor

## Technical Details

### What Was Fixed

**Before (v4.0.0)**:
- CLI commands output colored text (ANSI codes like `\x1b[35m`)
- Logger could output to stdout
- MCP client received: `{"text": "    [35mcompo..."}`
- JSON parser failed: "Unexpected token ''"

**After (v5.0.0)**:
- All CLI commands run with `NO_COLOR='1'` and `FORCE_COLOR='0'`
- Logger outputs only to stderr
- MCP client receives: `{"text": "component: auth"}`
- JSON parser succeeds

### Tools Now Available

**MCP Server**: 27 tools including:
- `caws_quality_gates` - Run quality gates
- `caws_waiver_create` - Create waivers
- `caws_waivers_list` - List waivers
- All other CAWS commands

**VS Code Extension**: 26 commands including:
- `CAWS: Run Quality Gates`
- `CAWS: Create Waiver`
- `CAWS: Show Quality Dashboard`
- All other CAWS features

## Post-Installation Testing

Run these commands to verify:

```bash
# 1. Check CLI version
caws --version
# Should show: 5.0.0

# 2. Test waiver list (should work without JSON errors)
caws waivers list

# 3. In Cursor, test MCP integration
# Command Palette → "CAWS: Show Quality Dashboard"
```

## Support

If issues persist:
1. Check MCP server logs: View → Output → MCP (if available)
2. Check extension logs: View → Output → CAWS
3. Report issues with log excerpts showing the specific error

