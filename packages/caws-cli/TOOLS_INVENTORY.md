# CAWS Tools Inventory - v5.0.0

## MCP Server Tools (27 total)

### Core Project Management
- `caws_init` - Initialize new project
- `caws_scaffold` - Add CAWS components
- `caws_validate` - Validate working spec
- `caws_evaluate` - Evaluate quality
- `caws_iterate` - Get iterative guidance
- `caws_status` - Get project health overview
- `caws_diagnose` - Run health checks
- `caws_archive` - Archive completed changes

### Multi-Agent Features
- `caws_specs_list` - List all specs
- `caws_specs_create` - Create new spec
- `caws_specs_show` - Show spec details

### Quality Gates & Monitoring
- `caws_quality_gates` - Run quality gates on staged files
- `caws_quality_gates_run` - Run comprehensive quality gates
- `caws_quality_gates_status` - Check quality gates status
- `caws_quality_monitor` - Monitor code quality in real-time
- `caws_test_analysis` - Statistical test analysis

### Waivers & Exceptions
- `caws_waiver_create` - Create quality gate waiver
- `caws_waivers_list` - List all waivers
- `caws_quality_exceptions_list` - List quality exceptions
- `caws_quality_exceptions_create` - Create quality exception

### Provenance & Compliance
- `caws_provenance` - Manage provenance tracking
- `caws_hooks` - Manage git hooks

### Workflow & Guidance
- `caws_workflow_guidance` - Get workflow-specific guidance
- `caws_refactor_progress_check` - Check refactor progress

### Monitoring & Configuration
- `caws_monitor_status` - Get monitoring status
- `caws_monitor_alerts` - Get active alerts
- `caws_monitor_configure` - Configure monitoring

### Utility
- `caws_help` - Get tool help and documentation
- `caws_slash_commands` - Natural language slash commands

## VS Code Extension Commands (26 total)

### Core Commands
- `caws.init` - Initialize Project
- `caws.scaffold` - Scaffold Components
- `caws.evaluate` - Evaluate Quality
- `caws.iterate` - Get Iterative Guidance
- `caws.validate` - Validate Working Spec

### Waiver Management
- `caws.createWaiver` - Create Waiver
- `caws.qualityExceptionsList` - List Quality Exceptions
- `caws.qualityExceptionsCreate` - Create Quality Exception

### Quality Gates
- `caws.qualityGates` - Run Quality Gates
- `caws.qualityGatesRun` - Run Quality Gates (Interactive)
- `caws.qualityGatesStatus` - Show Quality Gates Status

### Dashboard & Visualization
- `caws.showDashboard` - Show Quality Dashboard
- `caws.showProvenance` - Show Provenance Dashboard

### Git Hooks
- `caws.hooksInstall` - Install Git Hooks
- `caws.hooksStatus` - Check Hooks Status

### Multi-Agent Features
- `caws.specsList` - List Specs
- `caws.specsCreate` - Create Spec
- `caws.specsShow` - Show Spec Details

### Refactoring
- `caws.refactorProgressCheck` - Check Refactor Progress

## Tool Integration Verification

### MCP → CLI Integration
All MCP tools call `@paths.design/caws-cli` via:
- `npx @paths.design/caws-cli <command>` for CLI commands
- Direct package imports for library functionality

### Extension → MCP Integration
Extension commands call MCP tools via:
- `mcpClient.callTool('caws_<tool_name>', args)` for most operations
- Direct CLI execution for specific commands

### Key Integrations Working
- Waiver creation and listing
- Quality gates execution
- Provenance tracking
- Multi-spec management
- Real-time quality monitoring

## Version Compatibility

- **CLI**: v5.0.0
- **MCP Server**: v1.1.1
- **VS Code Extension**: v5.0.0

All packages tested and verified working together.

## Testing the Integration

### Test MCP Server
```bash
cd packages/caws-mcp-server
node index.js
# Server should start without errors
```

### Test CLI
```bash
npx @paths.design/caws-cli --version
# Should show: 5.0.0

npx @paths.design/caws-cli waivers list
# Should list active waivers
```

### Test Extension
1. Install `.vsix` file in VS Code
2. Open Command Palette (Cmd+Shift+P)
3. Type "CAWS:" to see all commands
4. Verify waiver and quality gates commands appear

## Recent Additions (v5.0.0)

- Enhanced waiver integration with quality gates
- Improved cache and lock management
- Quality gates now respect active waivers
- Sophisticated TODO detection with confidence scoring
- Real-time quality monitoring
- Multi-agent architecture support

