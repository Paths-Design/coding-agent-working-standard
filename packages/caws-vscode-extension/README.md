# CAWS VS Code Extension

**Real-time CAWS Integration for Visual Studio Code**

The CAWS VS Code Extension provides seamless integration between CAWS (Coding Agent Workflow System) and the VS Code development environment. It offers real-time quality monitoring, interactive evaluation tools, and guided development workflows directly within the editor.

## Overview

The extension brings CAWS capabilities directly into VS Code:

- **Real-time Quality Monitoring**: Live quality score in status bar
- **Interactive Evaluation**: Run CAWS assessments with one click
- **Guided Development**: Step-by-step workflow guidance
- **Waiver Management**: Create and manage quality waivers
- **Quality Dashboard**: Visual quality metrics and trends
- **File Watcher Integration**: Automatic validation on file changes

## Features

### Status Bar Integration

- **Live Quality Score**: Real-time quality percentage display
- **Status Indicators**: Visual feedback on evaluation results
- **Quick Actions**: One-click access to CAWS commands
- **Context Awareness**: Project-specific status information

### Quality Dashboard

- **Interactive Webview**: Comprehensive quality metrics panel
- **Real-time Updates**: Live evaluation result display
- **Action Buttons**: Direct access to CAWS operations
- **Historical Trends**: Quality score progression tracking

### Code Action Providers

- **Smart Suggestions**: Context-aware CAWS recommendations
- **Quick Fixes**: Automated quality issue resolution
- **Waiver Creation**: Streamlined waiver request workflow
- **Validation Triggers**: Automatic quality checks

### File Watcher Integration

- **Change Detection**: Monitor file modifications
- **Selective Validation**: Only validate relevant changes
- **Background Processing**: Non-blocking quality assessment
- **Threshold-based Alerts**: Configurable warning levels

## Installation

### From VS Code Marketplace (Recommended)

```bash
# Install from command line
code --install-extension caws.caws-vscode-extension
```

**What's Included**: The extension bundles the CAWS MCP server and CLI tools, so no separate installation is required.

### Manual Installation

If marketplace installation is unavailable:

```bash
# Download from releases or build locally
# The extension includes bundled CAWS components
code --install-extension caws-vscode-extension-1.0.0.vsix
```

### Bundled Components

The extension includes:

- **CAWS MCP Server**: Local agent integration server
- **CAWS CLI Tools**: Core quality assurance commands
- **Quality Gate Tools**: Validation and analysis tools
- **Templates**: Project scaffolding templates

**Bundling Strategy:**
Similar to how ESLint bundles its language server, the CAWS extension bundles all necessary components during the build process. This eliminates the need for separate CAWS installation, providing a seamless out-of-the-box experience.

**Build Process:**

```bash
npm run bundle  # Copies CAWS components into extension
npm run compile # Compiles TypeScript
npm run package # Creates .vsix with bundled components
```

**Fallback Support:**
If bundled components are unavailable, the extension automatically falls back to system-installed CAWS packages.

### System Requirements

- **Node.js**: >= 18.0.0 (bundled with extension)
- **VS Code**: >= 1.74.0
- **Storage**: ~50MB for bundled CAWS components

## Usage

### Getting Started

1. **Install Extension**: Install from marketplace or build locally
2. **Initialize CAWS**: Use `caws init` or `caws scaffold` in your project
3. **Open CAWS Project**: Open a folder containing `.caws/working-spec.yaml`
4. **View Dashboard**: Open CAWS Quality Dashboard from command palette

### Command Palette Commands

```bash
# Access all CAWS commands
Ctrl+Shift+P (or Cmd+Shift+P on Mac)
> CAWS: ...

# Available commands:
CAWS: Evaluate Quality      # Run quality assessment
CAWS: Get Iterative Guidance # Get development guidance
CAWS: Validate Working Spec  # Validate specification
CAWS: Create Waiver         # Create quality waiver
CAWS: Show Quality Dashboard # Open quality dashboard
```

### Status Bar Usage

- **Quality Score**: Click to run evaluation
- **Status Colors**:
  - 🟢 Green: Quality standards met
  - 🟡 Yellow: Quality issues detected
  - 🔴 Red: Critical quality failures
- **Tooltip**: Detailed status information

### Quality Dashboard

- **Access**: `View > Open View... > CAWS Quality Dashboard`
- **Features**:
  - Real-time quality score display
  - Criteria breakdown with pass/fail status
  - Next action recommendations
  - Direct command execution buttons

## Configuration

### Extension Settings

```json
{
  "caws.cli.path": "/custom/path/to/caws",
  "caws.autoValidate": true,
  "caws.showQualityStatus": true,
  "caws.experimentalMode": false
}
```

### Setting Descriptions

- **caws.cli.path**: Path to CAWS CLI executable (auto-detected if in PATH)
- **caws.autoValidate**: Automatically validate files on save
- **caws.showQualityStatus**: Display quality score in status bar
- **caws.experimentalMode**: Enable experimental features

## Architecture

### Extension Components

```
caws-vscode-extension/
├── src/
│   ├── extension.ts        # Main extension entry point
│   ├── mcp-client.ts       # MCP server communication
│   ├── quality-monitor.ts  # Real-time quality monitoring
│   ├── status-bar.ts       # Status bar integration
│   └── webview-provider.ts # Quality dashboard webview
├── package.json            # Extension manifest
└── tsconfig.json           # TypeScript configuration
```

### MCP Integration

The extension communicates with CAWS through the MCP server:

- **Tool Calls**: Execute CAWS commands via MCP tools
- **Resource Access**: Read working specs and waivers
- **Real-time Updates**: Live quality monitoring
- **Fallback Support**: Direct CLI calls if MCP unavailable

### Event Flow

```
File Change ──► Quality Monitor ──► MCP Server ──► CAWS CLI
     │                │                     │           │
     └─ Status Update └─ UI Update ────────┴─ Results ─┘
```

## Integration with CAWS Ecosystem

### Relationship to Other Packages

```
┌─────────────────────┐    ┌──────────────────┐
│ caws-vscode-extension │────│  caws-mcp-server │
│   (IDE Integration)  │    │  (Protocol       │
│ • Real-time UI       │    │   Bridge)        │
│ • User Interaction   │────│ • Tool Registry  │
└─────────────────────┘    └──────────────────┘
              │                       │
              └───────────────────────┘
                      │
              ┌─────────────────┐
              │   caws-cli      │
              │   (Core Logic)  │
              └─────────────────┘
```

### Quality Gates Integration

The extension integrates with CAWS quality gates:

1. **Spec Validation**: Real-time YAML validation
2. **Code Quality**: Live linting and type checking
3. **Test Integration**: Test result visualization
4. **Security Checks**: Vulnerability scanning integration
5. **Performance Monitoring**: Budget validation feedback

### Agent Workflow Integration

The extension supports agent workflows through:

- **Command Execution**: Agents can trigger extension commands
- **Status Monitoring**: Agents can read quality status
- **Guidance Display**: Agents can show guidance in UI
- **Waiver Workflows**: Streamlined waiver creation for agents

## Development

### Prerequisites

- Node.js >= 18.0.0
- VS Code >= 1.74.0
- CAWS CLI installed

### Building

```bash
cd packages/caws-vscode-extension

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch
```

### Testing

```bash
# Run unit tests
npm run test

# Run integration tests
npm run test:integration

# Debug extension
npm run debug
```

### Packaging

```bash
# Create .vsix package
npm run package

# Install locally for testing
code --install-extension caws-vscode-extension-1.0.0.vsix
```

## Extension API

### Public API

```typescript
import { CawsApi } from 'caws-vscode-extension';

// Get CAWS API instance
const cawsApi = CawsApi.getInstance();

// Run quality evaluation
const evaluation = await cawsApi.evaluateQuality();

// Get iterative guidance
const guidance = await cawsApi.getIterativeGuidance('current state');

// Create waiver
const waiver = await cawsApi.createWaiver(waiverData);
```

### Event Subscriptions

```typescript
// Listen for quality changes
cawsApi.onQualityChanged((evaluation) => {
  console.log('Quality changed:', evaluation.quality_score);
});

// Listen for guidance updates
cawsApi.onGuidanceAvailable((guidance) => {
  console.log('New guidance:', guidance.next_steps);
});
```

## Security

### Safe Execution

- **Sandboxed Communication**: MCP server runs in separate process
- **Input Validation**: All user inputs validated before processing
- **Permission Checks**: File system access restricted to workspace
- **Audit Logging**: All CAWS operations logged for review

### Privacy Protection

- **Local Processing**: Quality analysis runs locally
- **No Data Transmission**: Results stay within VS Code environment
- **Workspace-only Access**: No access to files outside workspace
- **Opt-in Features**: User controls which features are enabled

## Troubleshooting

### Common Issues

**Extension not activating**

```bash
# Check VS Code version
code --version

# Check CAWS installation
caws --version

# Verify working spec exists
ls -la .caws/working-spec.yaml
```

**MCP server connection failed**

```bash
# Check MCP server is running
ps aux | grep caws-mcp-server

# Restart extension
# Developer: Reload Window command

# Check extension logs
# Developer: Show Logs command
```

**Quality monitoring not working**

```bash
# Verify file watcher permissions
ls -la src/

# Check auto-validate setting
# Settings: search for "caws.autoValidate"

# Test manual evaluation
# Command Palette: CAWS: Evaluate Quality
```

**Status bar not showing**

```bash
# Check status bar setting
# Settings: search for "caws.showQualityStatus"

# Restart VS Code
# Developer: Reload Window command
```

### Debug Mode

Enable debug logging:

```json
{
  "caws.debugMode": true
}
```

Check extension logs in Output panel under "CAWS Extension".

## Contributing

### Development Setup

1. **Clone Repository**: `git clone https://github.com/paths-design/caws.git`
2. **Navigate**: `cd caws/packages/caws-vscode-extension`
3. **Install**: `npm install`
4. **Build**: `npm run compile`
5. **Test**: `npm run test`
6. **Debug**: Open in VS Code, press F5

### Code Standards

- **TypeScript**: Strict type checking enabled
- **Async/Await**: Use async patterns for all operations
- **Error Handling**: Comprehensive error handling and user feedback
- **Event Cleanup**: Proper disposal of subscriptions and listeners
- **Performance**: Efficient UI updates and background processing

### Testing Guidelines

- **Unit Tests**: Test individual components in isolation
- **Integration Tests**: Test extension with CAWS MCP server
- **UI Tests**: Test webview components and user interactions
- **Performance Tests**: Ensure operations don't block UI

## Performance Considerations

### Resource Usage

- **Lazy Loading**: Components loaded only when needed
- **Efficient Updates**: Minimal UI updates for status changes
- **Background Processing**: Quality checks run without blocking editor
- **Memory Management**: Proper cleanup of event listeners and resources

### Optimization Strategies

- **Debounced Updates**: File change events debounced to prevent spam
- **Selective Validation**: Only validate relevant files and changes
- **Caching**: Results cached to avoid redundant operations
- **Progressive Loading**: Dashboard loads data progressively

## Relationship to VS Code Ecosystem

### Similar Extensions

- **ESLint**: Linting and code quality (CAWS provides broader quality gates)
- **Prettier**: Code formatting (CAWS includes formatting in quality checks)
- **Jest**: Testing integration (CAWS orchestrates multiple test types)
- **GitLens**: Git integration (CAWS includes provenance tracking)

### Extension Points Used

- **Status Bar Items**: Quality score display
- **Webview Views**: Quality dashboard panel
- **Code Action Providers**: Quick fix suggestions
- **Command Contributions**: CAWS command palette
- **Configuration Sections**: User settings
- **File System Watchers**: Real-time file monitoring

## License

MIT License - see main project LICENSE file.

## Links

- **Main Project**: https://github.com/Paths-Design/coding-agent-working-standard
- **VS Code Marketplace**: Coming soon (pre-release)
- **Documentation**: See `docs/guides/vscode-extension-guide.md` in main repository
- **Issues**: https://github.com/Paths-Design/coding-agent-working-standard/issues
- **Discussions**: https://github.com/Paths-Design/coding-agent-working-standard/discussions
- **Support**: hello@paths.design
