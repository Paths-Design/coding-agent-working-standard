/**
 * Structured logging for CAWS MCP Server
 *
 * Uses pino for high-performance, structured logging with proper log levels
 * and configurable output formats.
 *
 * @author @darianrosebrook
 */

import pino from 'pino';

/**
 * Create logger instance with appropriate configuration
 */
function createLogger() {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const logLevel = process.env.CAWS_LOG_LEVEL || (isDevelopment ? 'debug' : 'info');

  const baseConfig = {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
  };

  // For MCP server, use minimal JSON output to stderr only
  // MCP protocol requires pure JSON communication on stdout
  // All logs must go to stderr to avoid corrupting MCP messages
  if (process.env.CAWS_MCP_SERVER) {
    return pino({
      ...baseConfig,
      // Force all logs to stderr, not stdout (MCP uses stdout for protocol)
      destination: 2, // stderr file descriptor
      // Completely disable formatting and colors
      formatters: {
        level: (label) => ({ level: label }),
      },
    });
  }

  // In production (non-MCP), use JSON output
  if (!isDevelopment || process.env.CAWS_LOG_JSON) {
    return pino(baseConfig);
  }

  // In development (non-MCP), use pretty printing for better readability
  return pino({
    ...baseConfig,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    },
  });
}

const logger = createLogger();

/**
 * Create child logger with additional context
 *
 * @param {Object} context - Additional context to include in all log messages
 * @returns {Object} Child logger instance
 */
function createChildLogger(context) {
  return logger.child(context);
}

export { createChildLogger, logger };
