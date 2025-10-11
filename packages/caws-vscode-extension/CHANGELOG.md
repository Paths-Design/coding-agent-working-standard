# Changelog - CAWS VS Code Extension

All notable changes to the CAWS VS Code Extension will be documented in this file.

## [Unreleased]

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

## [0.9.0] - 2025-10-10 (Pre-release)

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

