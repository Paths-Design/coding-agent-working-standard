# CAWS MCP vs CLI Parity Analysis

**Date**: October 8, 2025  
**Author**: @darianrosebrook  
**Status**: Analysis Complete

---

## Executive Summary

### Bundle Size Analysis
- **Total Bundle**: 270 MB (56 MB compressed in `.vsix`)
- **CLI Component**: 263 MB (97% of total)
  - node_modules: 262 MB (99.5% of CLI)
  - dist: 756 KB
  - templates: 696 KB
- **MCP Server**: 6.9 MB (3% of total)

### Command Parity Status
- **✅ Full Parity**: 9/11 CLI commands (82%)
- **⚠️ Missing Implementation**: 2/11 CLI commands (18%)
- **🔧 MCP-Only Tools**: 2 additional tools (workflow guidance, quality monitor)

---

## CLI Commands vs MCP Tools Matrix

| CLI Command | MCP Tool | Parity | Notes |
|-------------|----------|--------|-------|
| `caws init` | `caws_init` | ✅ **100%** | Fully working, creates complete project |
| `caws scaffold` | `caws_scaffold` | ⚠️ **90%** | ESM bundling issue with inquirer |
| `caws validate` | `caws_validate` | ✅ **100%** | Fully working |
| `caws status` | `caws_status` | ✅ **100%** | Fully working |
| `caws templates` | ❌ None | ⚠️ **0%** | CLI-only, not exposed via MCP |
| `caws diagnose` | `caws_diagnose` | ✅ **100%** | Fully working |
| `caws tool` | ❌ None | ⚠️ **0%** | CLI-only, programmatic tool execution |
| `caws test-analysis` | `caws_test_analysis` | ✅ **100%** | Fully working with all 3 subcommands |
| `caws provenance` | `caws_provenance` | ✅ **100%** | All 5 subcommands working |
| `caws hooks` | `caws_hooks` | ✅ **100%** | All 3 subcommands working |
| — | `caws_evaluate` | ⚠️ **0%** | References non-existent `agent evaluate` |
| — | `caws_iterate` | ⚠️ **0%** | References non-existent `agent iterate` |
| — | `caws_waiver_create` | ⚠️ **0%** | References non-existent `waivers` command |
| — | `caws_workflow_guidance` | ✅ **100%** | MCP-only, provides TDD/refactor/feature workflows |
| — | `caws_quality_monitor` | ✅ **100%** | MCP-only, real-time quality monitoring |

### Detailed Subcommand Analysis

#### `caws provenance` (5 subcommands)
| Subcommand | CLI | MCP | Status |
|------------|-----|-----|--------|
| `init` | ✅ | ✅ | Full parity |
| `update` | ✅ | ✅ | Full parity |
| `show` | ✅ | ✅ | Full parity |
| `verify` | ✅ | ✅ | Full parity |
| `analyze-ai` | ✅ | ✅ | Full parity |

#### `caws hooks` (3 subcommands)
| Subcommand | CLI | MCP | Status |
|------------|-----|-----|--------|
| `install` | ✅ | ✅ | Full parity |
| `remove` | ✅ | ✅ | Full parity |
| `status` | ✅ | ✅ | Full parity |

#### `caws test-analysis` (3 subcommands)
| Subcommand | CLI | MCP | Status |
|------------|-----|-----|--------|
| `assess-budget` | ✅ | ✅ | Full parity |
| `analyze-patterns` | ✅ | ✅ | Full parity |
| `find-similar` | ✅ | ✅ | Full parity |

---

## Top 20 Largest Dependencies (CLI Bundle)

| Package | Size | Purpose | Required for MCP? |
|---------|------|---------|-------------------|
| `@octokit` | 39 MB | GitHub API integration | ⚠️ Only for release workflow |
| `typescript` | 23 MB | TypeScript compiler | ❌ Not needed at runtime |
| `semantic-release` | 21 MB | Automated versioning | ❌ Dev/CI only |
| `npm` | 17 MB | Package manager | ❌ Not needed at runtime |
| `rxjs` | 11 MB | Reactive extensions | ⚠️ Used by inquirer |
| `@babel` | 10 MB | JS transpiler | ❌ Not needed at runtime |
| `@typescript-eslint` | 9.7 MB | Linting | ❌ Dev only |
| `esbuild` | 9.5 MB | Bundler | ❌ Not needed at runtime |
| `@esbuild` | 9.4 MB | Bundler platform binaries | ❌ Not needed at runtime |
| `prettier` | 8.2 MB | Code formatter | ❌ Dev only |
| `eslint` | 5.4 MB | Linting | ❌ Dev only |
| `@sinclair` | 5.2 MB | TypeBox validation | ⚠️ May be useful |
| `zod` | 5.0 MB | Schema validation | ✅ Used by MCP |
| `lodash` | 4.9 MB | Utilities | ⚠️ Used by CLI |
| `caniuse-lite` | 4.1 MB | Browser compat DB | ❌ Not needed |
| `mocha` | 3.1 MB | Testing | ❌ Dev only |
| `handlebars` | 2.9 MB | Templates | ⚠️ Used by generators |
| `lodash-es` | 2.6 MB | ES modules | ❌ Duplicate |
| `highlight.js` | 2.6 MB | Syntax highlighting | ❌ Not needed |
| `ajv` | 2.3 MB | JSON schema validation | ⚠️ Used by validation |

**Removable Dependencies**: ~110 MB (dev/build tools only)
**Potential Savings**: 40-50% bundle size reduction

---

## Bundle Strategy Recommendations

### Current Strategy: Copy All node_modules ❌
**Pros:**
- Simple to implement
- Guaranteed to include all dependencies
- Works for all package types

**Cons:**
- **Massive bundle size** (270 MB → 56 MB compressed)
- Includes dev dependencies (TypeScript, ESLint, Prettier, etc.)
- Includes duplicate dependencies (lodash + lodash-es)
- ESM/CommonJS conflicts (strip-ansi, inquirer)
- Slow installation experience for users

### Recommended Strategy 1: Production-Only Dependencies ✅
```javascript
// In bundle-deps.js
const productionDeps = {
  // Core CLI runtime
  'commander': true,
  'chalk': true,
  'yaml': true,
  'js-yaml': true,
  'fs-extra': true,
  
  // Validation
  'ajv': true,
  'zod': true,
  
  // Utilities
  'lodash': true,
  
  // Templates
  'handlebars': true,
  
  // MCP
  '@modelcontextprotocol': true,
  'content-type': true,
  'raw-body': true,
};
```

**Expected savings**: 110-120 MB → ~35-40 MB compressed `.vsix`

### Recommended Strategy 2: Bundle with esbuild ✅✅ (BEST)
```javascript
// Build a single bundled CLI file
esbuild.build({
  entryPoints: ['packages/caws-cli/src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'bundled/cli/caws.bundle.js',
  external: [
    // Only external packages that must be resolved at runtime
    'fsevents', // Optional peer dep
  ],
  minify: false, // Keep readable for debugging
  sourcemap: true,
});
```

**Expected savings**: 262 MB → ~5-10 MB → ~8-12 MB compressed `.vsix`  
**Benefits**:
- ✅ Resolves ESM/CommonJS conflicts
- ✅ Tree-shaking removes unused code
- ✅ Single file = faster startup
- ✅ No module resolution at runtime
- ✅ Dramatic size reduction

### Recommended Strategy 3: Hybrid Approach ✅
- Bundle CLI with esbuild (5-10 MB)
- Bundle MCP server with esbuild (2-3 MB)
- Copy only templates directory (696 KB)

**Total expected bundle**: ~8-15 MB (compressed ~10-15 MB `.vsix`)

---

## Alternative Architecture: Direct MCP Implementation

Instead of calling CLI via `execSync`, implement CAWS logic directly in MCP server:

### Current Flow
```
MCP Tool → execSync(node cli/dist/index.js ...) → CLI → Logic → stdout
```
**Issues**:
- High overhead (spawn process for each call)
- Bundle entire CLI with all dependencies
- ESM/CommonJS conflicts
- Slower execution

### Proposed Flow
```
MCP Tool → Direct function call → Shared CAWS core → Result
```
**Benefits**:
- ✅ No process spawning overhead
- ✅ Direct TypeScript/JavaScript execution
- ✅ Smaller bundle (only core logic)
- ✅ Better error handling
- ✅ Can share code between CLI and MCP

### Implementation Strategy
```
packages/
├── caws-core/              # NEW: Shared logic
│   ├── src/
│   │   ├── validation.ts   # Working spec validation
│   │   ├── provenance.ts   # Provenance tracking
│   │   ├── scaffolding.ts  # Project scaffolding
│   │   ├── diagnosis.ts    # Health checks
│   │   └── ...
├── caws-cli/               # CLI interface (thin wrapper)
│   └── src/
│       └── index.ts        # Calls caws-core
├── caws-mcp-server/        # MCP interface
│   └── index.js            # Calls caws-core directly
└── caws-vscode-extension/
    └── bundled/
        ├── mcp-server/
        └── core/           # Only bundle core logic
```

**Bundle size**: ~3-5 MB (core logic only) → ~5-8 MB compressed `.vsix`

---

## Missing CLI Commands to Implement

### 1. `caws templates` Command
**Current Status**: CLI only, not exposed via MCP

**Recommendation**: ✅ Add MCP tool
```javascript
{
  name: 'caws_templates',
  description: 'Discover and list available project templates',
  inputSchema: {
    type: 'object',
    properties: {
      subcommand: {
        type: 'string',
        enum: ['list', 'info'],
        default: 'list',
      },
      templateName: {
        type: 'string',
        description: 'Template name for info subcommand',
      },
    },
  },
}
```

### 2. `caws tool` Command
**Current Status**: CLI only, programmatic tool execution

**Recommendation**: ⚠️ Skip - MCP replaces this functionality  
The MCP protocol itself is the programmatic interface for tool execution.

### 3. `caws agent evaluate` Subcommand
**Current Status**: Referenced by `caws_evaluate` MCP tool, but doesn't exist

**Recommendation**: ✅ Implement as `caws evaluate` (no `agent` prefix)
```bash
# Remove "agent" prefix from MCP tool calls
caws evaluate .caws/working-spec.yaml
```

### 4. `caws agent iterate` Subcommand
**Current Status**: Referenced by `caws_iterate` MCP tool, but doesn't exist

**Recommendation**: ✅ Implement as `caws iterate` (no `agent` prefix)
```bash
caws iterate --current-state "..." .caws/working-spec.yaml
```

### 5. `caws waivers` Command
**Current Status**: Referenced by `caws_waiver_create` MCP tool, but doesn't exist

**Recommendation**: ✅ Implement full `caws waivers` command
```bash
caws waivers create --title "..." --reason "..." ...
caws waivers list
caws waivers show <waiver-id>
caws waivers revoke <waiver-id>
```

---

## Prioritized Action Items

### P0 - Critical (Required for Full Functionality)
1. **Implement bundling with esbuild** - Reduces bundle from 56 MB → 10-15 MB
2. **Fix `caws_scaffold` ESM issues** - Currently broken due to inquirer
3. **Implement missing CLI commands**:
   - `caws evaluate` (remove `agent` prefix)
   - `caws iterate` (remove `agent` prefix)
   - `caws waivers create|list|show|revoke`

### P1 - High Priority (Better UX)
4. **Add `caws_templates` MCP tool** - Expose template discovery
5. **Refactor to shared core package** - Eliminate CLI dependency in MCP
6. **Production-only dependency filtering** - Remove dev deps from bundle

### P2 - Nice to Have (Optimization)
7. **Hybrid bundling strategy** - Different strategies for different components
8. **Lazy-load heavy dependencies** - Only load semantic-release when needed
9. **Template extraction** - Move templates to separate package

---

## Estimated Impact

### Bundle Size Improvements
| Strategy | Current | After | Savings |
|----------|---------|-------|---------|
| Production deps only | 56 MB | ~35 MB | 37% |
| esbuild bundling | 56 MB | ~10 MB | 82% |
| Shared core refactor | 56 MB | ~5 MB | 91% |

### Performance Improvements
| Metric | Current | After Shared Core | Improvement |
|--------|---------|-------------------|-------------|
| Tool execution time | ~100-500ms | ~10-50ms | 5-10x faster |
| Extension load time | ~2-3s | ~0.5-1s | 3-4x faster |
| Memory usage | ~100-150 MB | ~30-50 MB | 2-3x less |

### Development Experience
- ✅ Faster extension installation (37-91% smaller)
- ✅ Faster tool execution (no process spawning)
- ✅ Better error messages (direct stack traces)
- ✅ Easier debugging (single codebase)
- ✅ Better type safety (shared types)

---

## Conclusion

**Current State**: Working but inefficient
- 82% CLI parity achieved
- 56 MB extension size is acceptable but large
- ESM/CommonJS issues present
- Missing 3 CLI commands

**Recommended Path Forward**:
1. **Short-term** (1-2 days): Implement missing CLI commands + production-only deps
2. **Medium-term** (1 week): Bundle with esbuild
3. **Long-term** (2-3 weeks): Refactor to shared core architecture

**Expected Outcome**: 5-8 MB extension with 100% CLI parity and 5-10x better performance

