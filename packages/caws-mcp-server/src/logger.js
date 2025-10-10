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

  // In development, use pretty printing for better readability
  if (isDevelopment && !process.env.CAWS_LOG_JSON) {
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

  // In production, use JSON for log aggregation
  return pino(baseConfig);
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
