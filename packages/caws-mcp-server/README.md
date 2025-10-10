**Author**: @darianrosebrook

**Status**: Production Ready with Structured Logging

---

## Structured Logging

The MCP server now uses **pino** for high-performance structured logging:

### Configuration

Set log level via environment variable:

```bash
# Development (default: debug)
export CAWS_LOG_LEVEL=debug

# Production (default: info)
export NODE_ENV=production
export CAWS_LOG_LEVEL=info

# Force JSON output (useful for log aggregation)
export CAWS_LOG_JSON=true
```

### Log Levels

- **error**: Errors and exceptions
- **warn**: Warning conditions
- **info**: Important events (default in production)
- **debug**: Detailed debugging information (default in development)

### Log Format

**Development** (pretty-printed):

```
[2025-10-10 15:30:00] INFO: MCP client initialized - ready for requests
```

**Production** (JSON for log aggregation):

```json
{
  "level": "info",
  "time": "2025-10-10T15:30:00.000Z",
  "msg": "MCP client initialized - ready for requests"
}
```

### Contextual Logging

The logger adds structured context to all messages:

```javascript
// Component-specific logger
this.logger = createChildLogger({ component: 'CawsMonitor' });

// Structured data in logs
this.logger.info({ specId: 'PROV-0001' }, 'Loaded working spec');

// Error logging with context
this.logger.error({ err: error, file: filePath }, 'Error handling file change');
```

### Benefits

- ✅ **Structured data**: Easy to parse and aggregate
- ✅ **Performance**: Minimal overhead (asynchronous logging)
- ✅ **Production-ready**: JSON output for log aggregation
- ✅ **Development-friendly**: Pretty output with colors
- ✅ **Contextual**: Rich metadata in every log
- ✅ **Standards-compliant**: Follows best practices

---

For more information, see `docs/MONITORING.md`
