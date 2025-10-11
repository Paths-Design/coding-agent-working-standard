/**
 * Structured logging for CAWS VS Code Extension
 *
 * Uses VS Code OutputChannel for proper logging instead of console statements
 *
 * @author @darianrosebrook
 */

import * as vscode from 'vscode';

/**
 * Log levels for extension logging
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger class using VS Code OutputChannel
 */
class ExtensionLogger {
  private outputChannel: vscode.OutputChannel;
  private currentLevel: LogLevel;

  constructor(channelName: string = 'CAWS Extension') {
    this.outputChannel = vscode.window.createOutputChannel(channelName);
    this.currentLevel = this.getConfiguredLogLevel();
  }

  private getConfiguredLogLevel(): LogLevel {
    const config = vscode.workspace.getConfiguration('caws');
    const levelString = config.get<string>('logLevel', 'info').toLowerCase();

    switch (levelString) {
      case 'debug':
        return LogLevel.DEBUG;
      case 'info':
        return LogLevel.INFO;
      case 'warn':
        return LogLevel.WARN;
      case 'error':
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }

  private formatMessage(level: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ' ' + args.map((a) => JSON.stringify(a)).join(' ') : '';
    return `[${timestamp}] [${level}] ${message}${formattedArgs}`;
  }

  /**
   * Log debug message
   */
  debug(message: string, ...args: any[]): void {
    if (this.currentLevel <= LogLevel.DEBUG) {
      this.outputChannel.appendLine(this.formatMessage('DEBUG', message, ...args));
    }
  }

  /**
   * Log info message
   */
  info(message: string, ...args: any[]): void {
    if (this.currentLevel <= LogLevel.INFO) {
      this.outputChannel.appendLine(this.formatMessage('INFO', message, ...args));
    }
  }

  /**
   * Log warning message
   */
  warn(message: string, ...args: any[]): void {
    if (this.currentLevel <= LogLevel.WARN) {
      this.outputChannel.appendLine(this.formatMessage('WARN', message, ...args));
    }
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error | any): void {
    if (this.currentLevel <= LogLevel.ERROR) {
      const errorDetails = error
        ? `\nError: ${error.message || error}\nStack: ${error.stack || 'N/A'}`
        : '';
      this.outputChannel.appendLine(this.formatMessage('ERROR', message) + errorDetails);
    }
  }

  /**
   * Show the output channel
   */
  show(): void {
    this.outputChannel.show();
  }

  /**
   * Hide the output channel
   */
  hide(): void {
    this.outputChannel.hide();
  }

  /**
   * Clear the output channel
   */
  clear(): void {
    this.outputChannel.clear();
  }

  /**
   * Dispose the output channel
   */
  dispose(): void {
    this.outputChannel.dispose();
  }

  /**
   * Create a child logger for a specific component
   */
  createChild(componentName: string): ComponentLogger {
    return new ComponentLogger(this, componentName);
  }
}

/**
 * Component-specific logger that prefixes messages
 */
class ComponentLogger {
  constructor(
    private parent: ExtensionLogger,
    private componentName: string
  ) {}

  debug(message: string, ...args: any[]): void {
    this.parent.debug(`[${this.componentName}] ${message}`, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.parent.info(`[${this.componentName}] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.parent.warn(`[${this.componentName}] ${message}`, ...args);
  }

  error(message: string, error?: Error | any): void {
    this.parent.error(`[${this.componentName}] ${message}`, error);
  }
}

// Global logger instance
let globalLogger: ExtensionLogger | null = null;

/**
 * Initialize the global logger
 */
export function initializeLogger(channelName: string = 'CAWS Extension'): ExtensionLogger {
  if (!globalLogger) {
    globalLogger = new ExtensionLogger(channelName);
  }
  return globalLogger;
}

/**
 * Get the global logger instance
 */
export function getLogger(): ExtensionLogger {
  if (!globalLogger) {
    globalLogger = new ExtensionLogger();
  }
  return globalLogger;
}

/**
 * Dispose the global logger
 */
export function disposeLogger(): void {
  if (globalLogger) {
    globalLogger.dispose();
    globalLogger = null;
  }
}

export { ExtensionLogger };

