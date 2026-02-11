# Language-Aware Quality Gates

## Problem

Previously, CAWS git hooks would suggest installing npm packages (`npm install --save-dev @paths.design/quality-gates`) even for non-JavaScript projects (e.g., Python projects). This resulted in:

- Unnecessary `package.json` files in Python projects
- Confusing suggestions that don't match the project's language
- Bloat from managing npm dependencies in non-JS projects

## Solution

CAWS quality gates are now fully language-agnostic. The system detects the project's primary programming language, provides **language-appropriate suggestions** for TODO analyzer installation, and applies multi-language analysis across all supported gates.

## Implementation

### Shared Language Support Module

Language-agnostic behavior is centralized in `packages/quality-gates/language-support.mjs`, which exports:

- **`CODE_EXTENSIONS`** -- Set of 20+ recognized code file extensions used by all gates to decide which files to analyze for SLOC, stubs, naming, etc.
- **`CONVENTION_FILES`** -- Set of conventional entry-point filenames (e.g., `__init__.py`, `main.go`, `lib.rs`, `Program.cs`) excluded from duplicate-stem analysis in the naming gate.
- **`commentStyleFor(ext)`** -- Returns the comment style for a given extension: `'c'` for `//` and `/* */` comments (C-family, JS, TS, Rust, Go, Java, Swift, Kotlin, Scala, C#, etc.) or `'hash'` for `#` comments (Python, Ruby, Shell, Elixir, Lua).
- **`PACKAGE_MARKERS`** -- List of package boundary marker files used to determine project/crate roots across ecosystems.

### Supported Languages

The following languages are supported across all quality gates:

- **JavaScript / TypeScript** (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`)
- **Python** (`.py`)
- **Rust** (`.rs`)
- **Go** (`.go`)
- **Java** (`.java`)
- **Kotlin** (`.kt`)
- **Swift** (`.swift`)
- **Ruby** (`.rb`)
- **PHP** (`.php`)
- **C / C++** (`.c`, `.cpp`, `.h`, `.hpp`, `.cc`, `.cxx`)
- **C#** (`.cs`)
- **Scala** (`.scala`)
- **Lua** (`.lua`)
- **Elixir** (`.ex`, `.exs`)

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
Available options for TODO analysis:
   - Use npx (no install): npx @paths.design/quality-gates todo-analyzer
   - Install package: npm install --save-dev @paths.design/quality-gates
```

#### Python Projects

```
Available options for TODO analysis:
   - Use CAWS MCP server: caws quality-gates (via MCP)
   - Use npx (if Node.js available): npx @paths.design/quality-gates todo-analyzer
   - Python TODO analyzer: python3 scripts/v3/analysis/todo_analyzer.py
```

#### Other Languages

```
Available options for TODO analysis:
   - Use npx (no install): npx @paths.design/quality-gates todo-analyzer
   - Use CAWS MCP server: caws quality-gates (via MCP)
```

## Usage

The language detection happens automatically when:

1. **Scaffolding git hooks**: `caws scaffold` or `caws hooks install`
2. **Running quality gates**: `caws quality-gates` or pre-commit hooks
3. **Manual detection**: `detectProjectLanguage()` utility function

## Multi-Language Gate Details

### God Objects Gate

The god objects gate uses multi-language SLOC counting powered by `commentStyleFor()` from `language-support.mjs`. For each file, the gate determines the comment style based on file extension:

- **`'c'` style** -- Strips `//` line comments and `/* */` block comments (used by JS, TS, Rust, Go, Java, Kotlin, Swift, C, C++, C#, Scala)
- **`'hash'` style** -- Strips `#` line comments (used by Python, Ruby, Shell, Elixir, Lua)

This allows accurate SLOC counting across all supported languages, filtering out comments and blank lines before comparing against thresholds.

### Naming Gate

The naming gate checks 20+ file extensions via `CODE_EXTENSIONS` and uses expanded convention files for language-specific entry points:

- **Python**: `__init__.py`, `setup.py`, `conftest.py`, `__main__.py`
- **Go**: `main.go`, `doc.go`
- **Java**: `Main.java`, `Application.java`
- **C#**: `Program.cs`
- **Rust**: `lib.rs`, `mod.rs`, `main.rs`, `build.rs`

These convention files are excluded from duplicate-stem analysis since multiple packages legitimately share these names.

### File Scoping

In push context, quality gates scope analysis to changed-since-base files rather than scanning the entire repository. This ensures gates only evaluate files that have been modified relative to the base branch.

## npx Approach

The quality-gates package exposes bin commands for direct invocation:

```bash
# In package.json
"bin": {
  "caws-quality-gates": "./run-quality-gates.mjs",
  "caws-todo-analyzer": "./todo-analyzer.mjs"
}

# Hooks can use:
npx --yes @paths.design/quality-gates caws-todo-analyzer --staged-only --ci-mode
```

## MCP Server Approach

For non-JavaScript projects, the hook can call the MCP server:

```bash
# Via MCP server (if available)
if command -v caws >/dev/null 2>&1; then
  caws quality-gates --check-hidden-todos --staged-only
fi
```

## Key Files

- `packages/quality-gates/language-support.mjs` - Shared module: CODE_EXTENSIONS, CONVENTION_FILES, commentStyleFor(), PACKAGE_MARKERS
- `packages/caws-cli/src/utils/project-analysis.js` - Language detection
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

- **No more npm bloat** in Python projects
- **Language-appropriate suggestions** based on project type
- **Multiple options** for different scenarios (npx, MCP, local install)
- **Backward compatible** with existing JavaScript/TypeScript projects
- **Multi-language** with 16 supported languages across all gates

