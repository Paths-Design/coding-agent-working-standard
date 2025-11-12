# Language-Aware Quality Gates

## Problem

Previously, CAWS git hooks would suggest installing npm packages (`npm install --save-dev @paths.design/quality-gates`) even for non-JavaScript projects (e.g., Python projects). This resulted in:

- Unnecessary `package.json` files in Python projects
- Confusing suggestions that don't match the project's language
- Bloat from managing npm dependencies in non-JS projects

## Solution

CAWS now detects the project's primary programming language and provides **language-appropriate suggestions** for TODO analyzer installation.

## Implementation

### Language Detection

The system detects project languages by checking for common indicators:

- **JavaScript/TypeScript**: `package.json`, `tsconfig.json`
- **Python**: `requirements.txt`, `pyproject.toml`, `setup.py`, `.py` files
- **Rust**: `Cargo.toml`, `.rs` files
- **Go**: `go.mod`, `go.sum`, `.go` files
- **Java**: `pom.xml`, `build.gradle`, `.java` files
- **C#**: `.csproj`, `.sln`, `.cs` files
- **PHP**: `composer.json`, `composer.lock`, `.php` files

### Language-Aware Suggestions

#### JavaScript/TypeScript Projects

```
💡 Available options for TODO analysis:
   • Use npx (no install): npx @paths.design/quality-gates todo-analyzer
   • Install package: npm install --save-dev @paths.design/quality-gates
```

#### Python Projects

```
💡 Available options for TODO analysis:
   • Use CAWS MCP server: caws quality-gates (via MCP)
   • Use npx (if Node.js available): npx @paths.design/quality-gates todo-analyzer
   • Python TODO analyzer: python3 scripts/v3/analysis/todo_analyzer.py
```

#### Other Languages

```
💡 Available options for TODO analysis:
   • Use npx (no install): npx @paths.design/quality-gates todo-analyzer
   • Use CAWS MCP server: caws quality-gates (via MCP)
```

## Usage

The language detection happens automatically when:

1. **Scaffolding git hooks**: `caws scaffold` or `caws hooks install`
2. **Running quality gates**: `caws quality-gates` or pre-commit hooks
3. **Manual detection**: `detectProjectLanguage()` utility function

## Future Enhancements

### Potential Improvements

1. **npx Integration**: Use `npx` to run quality gates without installation (requires package bin command)
2. **MCP Server Integration**: Call CAWS quality gates via MCP server for Python projects
3. **Language-Specific Analyzers**: Native analyzers for each language (Python, Rust, Go, etc.)
4. **Multi-Language Support**: Detect and suggest options for projects using multiple languages

### npx Approach (Future)

If the quality-gates package exposes a bin command for todo-analyzer:

```bash
# In package.json
"bin": {
  "caws-quality-gates": "./run-quality-gates.mjs",
  "caws-todo-analyzer": "./todo-analyzer.mjs"
}

# Then hooks can use:
npx --yes @paths.design/quality-gates caws-todo-analyzer --staged-only --ci-mode
```

### MCP Server Approach

For Python projects, the hook could call the MCP server:

```bash
# Via MCP server (if available)
if command -v caws >/dev/null 2>&1; then
  caws quality-gates --check-hidden-todos --staged-only
fi
```

## Files Modified

- `packages/caws-cli/src/utils/project-analysis.js` - Added language detection
- `packages/caws-cli/src/scaffold/git-hooks.js` - Language-aware hook generation
- `packages/caws-cli/src/utils/quality-gates.js` - Language-aware suggestions

## Testing

To test language detection:

```bash
# In a Python project
cd /path/to/python-project
caws hooks install
git commit  # Should show Python-specific suggestions

# In a JavaScript project
cd /path/to/js-project
caws hooks install
git commit  # Should show npm/npx suggestions
```

## Benefits

✅ **No more npm bloat** in Python projects  
✅ **Language-appropriate suggestions** based on project type  
✅ **Multiple options** for different scenarios (npx, MCP, local install)  
✅ **Backward compatible** with existing JavaScript/TypeScript projects  
✅ **Extensible** for future language support

