# Privacy Policy - CAWS VS Code Extension

**Last Updated**: October 10, 2025  
**Extension**: CAWS VS Code Extension  
**Publisher**: Paths Design

---

## Overview

The CAWS VS Code Extension is committed to protecting your privacy. This extension operates entirely locally and does not transmit any data to external servers.

---

## Data Collection

### What We DO NOT Collect

The CAWS extension **does not collect, transmit, or store**:

- ❌ Your source code
- ❌ File names or paths
- ❌ Personal information
- ❌ Usage statistics
- ❌ Telemetry data
- ❌ Error reports
- ❌ Any data outside your local machine

### What Stays Local

All extension operations are performed locally:

- ✅ Quality evaluations run on your machine
- ✅ Test results remain in your workspace
- ✅ MCP server runs locally (not cloud)
- ✅ All data stored in `.caws/` directory
- ✅ No network calls to external services

---

## Data Processing

### Local Processing Only

1. **File Watching**: Monitors file changes in your workspace only
2. **Quality Analysis**: Analyzes code locally using bundled CLI
3. **Results Storage**: Stores results in `.caws/` directory in your workspace
4. **MCP Communication**: Process-to-process communication on your machine

### No External Communications

The extension:

- Does not make any network requests
- Does not send data to analytics services
- Does not connect to cloud services
- Does not transmit telemetry

---

## Permissions

### Required Permissions

The extension requires these VS Code permissions:

- **Workspace Access**: Read/write files in your workspace (for quality analysis)
- **Configuration Access**: Read extension settings
- **Command Execution**: Run CAWS CLI commands locally
- **File System Watcher**: Monitor file changes for real-time validation

### How Permissions Are Used

- **Workspace Access**: Only accesses files you explicitly open or modify
- **Configuration**: Reads extension settings (log level, auto-validate, etc.)
- **Commands**: Executes CAWS CLI locally with your permission
- **File Watcher**: Monitors changes to provide real-time feedback

---

## Third-Party Services

### No Third-Party Services

The extension does not use any third-party services:

- No analytics platforms
- No error tracking services
- No cloud storage
- No API calls

### Bundled Dependencies

The extension bundles:

- CAWS CLI (local command-line tool)
- CAWS MCP Server (local communication server)
- Quality gate tools (local analysis)

All bundled components run locally and do not communicate externally.

---

## User Control

### Settings

You control all extension behavior through settings:

```json
{
  "caws.autoValidate": false, // Disable automatic validation
  "caws.showQualityStatus": true, // Show/hide status bar
  "caws.logLevel": "info" // Control logging verbosity
}
```

### Disable Features

To completely disable the extension:

1. Open Extensions panel
2. Find "CAWS"
3. Click "Disable"

Or uninstall completely:

```bash
code --uninstall-extension paths-design.caws-vscode-extension
```

---

## Data Storage

### What's Stored Locally

The extension stores these files in your workspace:

- `.caws/working-spec.yaml` - Your quality specifications
- `.caws/waivers/` - Quality gate waivers (if created)
- `.caws/provenance/` - Development audit trail (optional)
- `coverage/` - Test coverage reports (from your tests)
- `stryker/` - Mutation test results (from your tests)

### User Ownership

All data belongs to you:

- Stored in your workspace
- Under your git control
- Can be deleted anytime
- No cloud sync

---

## Changes to This Policy

### Notification of Changes

If we change this privacy policy:

- Updated "Last Updated" date
- Announced in extension CHANGELOG
- Require acceptance for material changes
- Give users option to opt-out

### Current Status

**Last Updated**: October 10, 2025  
**Material Changes**: None (initial version)

---

## Contact

Questions about privacy?

- **Email**: privacy@paths.design
- **GitHub Issues**: https://github.com/Paths-Design/coding-agent-working-standard/issues
- **General Contact**: hello@paths.design

---

## Compliance

### GDPR Compliance

The extension is GDPR-compliant because:

- No personal data collected
- No data transmitted
- No data stored outside workspace
- User has full control

### CCPA Compliance

The extension complies with CCPA because:

- No personal information collected
- No data sold or shared
- User owns all data
- Transparent about data handling

---

## Summary

**The CAWS VS Code Extension**:

- ✅ Runs entirely locally
- ✅ Collects no data
- ✅ Makes no network calls
- ✅ Stores data only in your workspace
- ✅ Gives you complete control
- ✅ Respects your privacy

**Your code and data stay on your machine. Always.**

---

For questions or concerns, contact: hello@paths.design
