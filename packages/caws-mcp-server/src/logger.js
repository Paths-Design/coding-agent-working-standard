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
    // Create a minimal logger that writes only to stderr with no colors
    // Use a custom write function to ensure no ANSI codes leak through
    const stderrDestination = pino.destination({
      fd: 2, // stderr
      sync: false,
      minLength: 0, // Disable buffering
    });
    
    // Wrap the destination to strip any ANSI codes that might leak through
    const originalWrite = stderrDestination.write.bind(stderrDestination);
    const stripAnsiCodes = (str) => {
      if (typeof str !== 'string') return str;
      return str
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    };
    
    stderrDestination.write = function(chunk) {
      if (Buffer.isBuffer(chunk)) {
        const str = chunk.toString('utf8');
        const cleaned = stripAnsiCodes(str);
        return originalWrite(Buffer.from(cleaned, 'utf8'));
      }
      if (typeof chunk === 'string') {
        const cleaned = stripAnsiCodes(chunk);
        return originalWrite(cleaned);
      }
      return originalWrite(chunk);
    };
    
    return pino({
      level: 'error', // Only errors - suppress all info/debug/warn logs
      ...baseConfig,
      // Completely disable formatting and colors
      formatters: {
        level: (label) => ({ level: label }),
      },
      // Explicitly disable color detection
      colorize: false,
      // Disable TTY detection
      sync: false,
    }, stderrDestination);
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
