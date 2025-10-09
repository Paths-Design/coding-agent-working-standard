# CAWS Monitoring System

## Overview

The CAWS Monitoring System provides real-time monitoring of contracts, artifacts, budgets, and agent behavior. It enables proactive alerts for budget overruns, progress tracking, and anomaly detection to maintain project health and catch issues early.

## Architecture

### Core Components

1. **File Watcher**: Monitors file system changes using chokidar
2. **Budget Monitor**: Tracks resource usage against working spec limits
3. **Progress Tracker**: Monitors acceptance criteria completion
4. **Alert System**: Generates alerts for threshold violations
5. **MCP Integration**: Exposes monitoring data via Model Context Protocol

### Key Features

- **Real-time File Watching**: Monitors `.caws`, `src`, `tests`, `docs`, and custom paths
- **Budget Enforcement**: Tracks files and lines-of-code against working spec limits
- **Progress Tracking**: Monitors acceptance criteria completion percentages
- **Intelligent Alerts**: Warning/critical thresholds with contextual information
- **Provenance Integration**: Links alerts to agent actions and provenance data

## Usage

### MCP Tools

The monitoring system is exposed through three MCP tools:

#### `caws_monitor_status`

Get current monitoring status including budgets, progress, and alerts.

**Example:**
```javascript
{
  "monitoring_active": true,
  "budgets": {
    "files": { "current": 45, "limit": 50, "type": "count" },
    "loc": { "current": 1250, "limit": 1000, "type": "lines" }
  },
  "progress": {
    "A1": 85,
    "A2": 60
  },
  "overall_progress": 73,
  "active_alerts": 1
}
```

#### `caws_monitor_alerts`

Get active monitoring alerts and warnings.

**Parameters:**
- `severity`: Filter by severity (`info`, `warning`, `critical`)
- `limit`: Maximum alerts to return (default: 10)

**Example:**
```javascript
{
  "alerts_count": 2,
  "alerts": [
    {
      "id": "alert_1234567890_abc123",
      "type": "budget_warning",
      "severity": "warning",
      "message": "Budget warning: files at 90% (45/50)",
      "budget_type": "files",
      "current": 45,
      "limit": 50,
      "ratio": 0.9
    }
  ]
}
```

#### `caws_monitor_configure`

Configure monitoring system settings.

**Parameters:**
- `action`: Configuration action
  - `update_thresholds`: Update budget warning/critical thresholds
  - `add_watch_path`: Add directory to watch list
  - `remove_watch_path`: Remove directory from watch list
  - `set_polling_interval`: Change polling frequency

**Examples:**
```javascript
// Update thresholds
caws_monitor_configure({
  action: 'update_thresholds',
  budgetWarning: 0.85,
  budgetCritical: 0.95
})

// Add watch path
caws_monitor_configure({
  action: 'add_watch_path',
  path: 'packages'
})
```

## Configuration

### Default Settings

```javascript
{
  watchPaths: ['.caws', 'src', 'tests', 'docs'],
  pollingInterval: 30000, // 30 seconds
  alertThresholds: {
    budgetWarning: 0.8,   // 80%
    budgetCritical: 0.95  // 95%
  }
}
```

### Working Spec Integration

The monitor automatically reads `.caws/working-spec.yaml` for:

- **Budget Limits**: `change_budget.max_files` and `change_budget.max_loc`
- **Acceptance Criteria**: Progress tracking for each criterion
- **Project Metadata**: Risk tier, scope, and other project info

## Alert Types

### Budget Alerts

- **Budget Warning**: Usage exceeds warning threshold (default 80%)
- **Budget Critical**: Usage exceeds critical threshold (default 95%)

### Progress Alerts

- **Progress Stalled**: Overall progress below 25% for extended periods

### Future Alerts

- **Anomaly Detection**: Unusual agent behavior patterns
- **Provenance Violations**: Unexpected changes to tracked files
- **Contract Drift**: Changes to API contracts without updates

## Integration Points

### With CAWS CLI

The monitoring system integrates with CLI commands to provide:

- Real-time budget checking during file operations
- Progress updates after test runs
- Alert notifications in command output

### With Provenance System

Links alerts to specific agent actions and commits:

```javascript
{
  alert: {
    type: "budget_critical",
    agent: "cursor-composer",
    commit: "abc123",
    timestamp: "2025-10-09T02:00:00Z"
  }
}
```

### With Dashboard Systems

Provides structured data for dashboard integration:

- Real-time progress charts
- Budget usage graphs
- Alert timelines
- Agent activity monitoring

## Security Considerations

- **File Access**: Only monitors configured paths, respects `.gitignore`
- **Data Privacy**: No sensitive file contents are stored or transmitted
- **Rate Limiting**: Polling intervals prevent excessive resource usage
- **Audit Trail**: All alerts are timestamped and attributable

## Performance

- **Memory Efficient**: Minimal memory footprint with streaming file watching
- **CPU Optimized**: Event-driven architecture with configurable polling
- **Scalable**: Handles large monorepos with thousands of files
- **Non-blocking**: Asynchronous operations don't impact main application

## Future Enhancements

### Advanced Anomaly Detection

- **Agent Behavior Analysis**: Detect unusual patterns in agent actions
- **Predictive Alerts**: Forecast budget overruns before they occur
- **Collaborative Filtering**: Learn from patterns across multiple projects

### Enhanced Integration

- **Slack/Discord Notifications**: Real-time alert delivery
- **CI/CD Integration**: Automatic PR comments and status checks
- **IDE Plugins**: Real-time budget indicators in code editors

### Advanced Provenance

- **Change Attribution**: Link every file change to specific agents/actions
- **Impact Analysis**: Assess the scope of changes automatically
- **Rollback Recommendations**: Suggest safe rollback strategies

## Troubleshooting

### Common Issues

**Monitor Not Starting**
- Check file permissions on watch paths
- Verify working spec exists and is valid
- Ensure chokidar dependency is installed

**False Positive Alerts**
- Adjust threshold values using `caws_monitor_configure`
- Review working spec budget limits
- Check for legitimate large file additions

**Performance Issues**
- Increase polling interval
- Reduce number of watch paths
- Use more specific file patterns

### Debug Mode

Enable detailed logging by setting environment variable:
```bash
CAWS_MONITOR_DEBUG=true
```

## API Reference

### CawsMonitor Class

#### Constructor Options
```javascript
new CawsMonitor({
  watchPaths: string[],      // Paths to monitor
  pollingInterval: number,   // Polling frequency in ms
  alertThresholds: {         // Alert thresholds (0.0-1.0)
    budgetWarning: number,
    budgetCritical: number
  }
})
```

#### Methods
- `start()`: Start monitoring
- `stop()`: Stop monitoring
- `getStatus()`: Get current status
- `addAlert(alert)`: Manually add alert

### Alert Object Structure
```javascript
{
  id: string,           // Unique alert identifier
  type: string,         // Alert type (budget_warning, etc.)
  severity: string,     // info | warning | critical
  message: string,      // Human-readable message
  timestamp: Date,      // When alert was generated
  // Type-specific fields...
  budgetType?: string,  // For budget alerts
  current?: number,     // Current usage
  limit?: number,       // Budget limit
}
```

---

## Conclusion

The CAWS Monitoring System transforms CAWS from a reactive quality assurance tool into a proactive project health management system. By monitoring contracts, budgets, and agent behavior in real-time, it enables early detection of issues and provides actionable insights for maintaining project quality and velocity.
