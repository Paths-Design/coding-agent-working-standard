# Changelog - CAWS VS Code Extension

All notable changes to the CAWS VS Code Extension will be documented in this file.

## [Unreleased]

## [4.0.0] - 2025-10-21

### Added

- **Multi-spec Architecture Support**: Extension now supports multiple CAWS working specs
- **Spec Selection UI**: Interactive spec selection when multiple specs exist
- **Spec Management Commands**: New commands for listing, creating, and viewing specs
- **Enhanced CLI Integration**: Updated to work with CAWS CLI v4.0.0 multi-spec architecture
- **Improved Command Conditions**: Commands now activate when `.caws` directory exists (not just legacy spec)

### Commands Added

- `CAWS: List Specs` - Show all available CAWS specs
- `CAWS: Create Spec` - Interactive spec creation with validation
- `CAWS: Show Spec Details` - View details of a specific spec

### Changed

- **Version**: Updated to 4.0.0 to match CLI version
- **Activation**: Commands now activate for any CAWS project (not just legacy spec)
- **Spec Resolution**: Uses CLI's interactive spec selection when multiple specs exist

## [0.9.3] - 2025-10-13

### Fixed

- MCP server now outputs pure JSON responses (no ANSI escape codes or colored output)
- Fixed JSON parsing errors in MCP client communication
- Added CAWS_MCP_SERVER environment variable to force JSON-only logging
- Resolves client communication errors with colored/formatted log output

## [0.9.2] - 2025-10-13

### Fixed

- MCP server now properly installs all dependencies including chokidar, pino, and their transitive dependencies
- Changed bundling strategy from manual copying to `npm install` for reliable dependency resolution
- Resolves ERR_MODULE_NOT_FOUND for @modelcontextprotocol/sdk and other packages

## [0.9.1] - 2025-10-13

### Fixed

- MCP server bundling now includes src/ directory with logger.js and monitoring/index.js
- Resolves ERR_MODULE_NOT_FOUND error when initializing extension on new machines

## [0.9.0] - 2025-10-10 (Pre-release)

### Added

- OutputChannel-based structured logging
- LICENSE file for marketplace compliance
- Marketplace metadata (keywords, categories, homepage)
- Privacy-focused telemetry (opt-in only)

### Changed

- Version changed to 0.9.0 (pre-release status)
- Replaced console statements with OutputChannel logging
- Improved error messages and user feedback

### Fixed

- Marketplace metadata compliance
- Logging best practices

### Added

- Initial VS Code extension for CAWS
- MCP server integration
- Real-time quality monitoring
- Quality dashboard webview
- Command palette integration
- Status bar quality indicators
- File watcher for auto-validation
- Code action providers for quick fixes
- Waiver creation workflow
- Provenance tracking panel

### Features

- **Commands**: 10 CAWS commands via command palette
- **Dashboard**: Interactive quality metrics webview
- **Monitoring**: Real-time file change tracking
- **Integration**: Cursor IDE MCP server auto-registration
- **Status Bar**: Live quality score display

### Bundling

- Bundled CAWS CLI (2.37 MB esbuild)
- Bundled MCP server (2 MB)
- Total extension size: ~2.4 MB
- No external dependencies required

### Requirements

- VS Code >= 1.74.0
- Node.js >= 18.0.0 (bundled with extension)
- CAWS working spec in `.caws/working-spec.yaml`

### Known Limitations

- Experimental status - not all features fully tested
- Requires .caws/working-spec.yaml to activate full features
- MCP server fallback may have reduced functionality
- Performance monitoring in early stages

---

## Release Notes Format

Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Categories

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security fixes

---

Last updated: October 10, 2025
