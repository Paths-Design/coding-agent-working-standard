#!/usr/bin/env node

/**
 * Progress Bar Utility for Quality Gates
 *
 * Provides visual progress feedback for long-running quality gate operations.
 * Supports single progress bars, multi-progress tracking, and spinners.
 *
 * Features:
 * - Terminal-aware rendering (no-op in non-TTY or CI environments)
 * - Support for parallel operation tracking
 * - Worker thread progress aggregation
 * - Configurable formats and styles
 *
 * @author @darianrosebrook
 * @version 1.0.0
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR_CHARS = { complete: '█', incomplete: '░', head: '▓' };

/**
 * Determines if we should render progress UI
 * @returns {boolean} True if terminal supports progress rendering
 */
function shouldRender() {
  // Don't render in CI, non-TTY, or when explicitly disabled
  if (process.env.CI || process.env.NO_PROGRESS) return false;
  if (!process.stdout.isTTY) return false;
  if (process.argv.includes('--quiet') || process.argv.includes('--json')) return false;
  return true;
}

/**
 * Gets terminal width, with fallback
 * @returns {number} Terminal width in columns
 */
function getTerminalWidth() {
  return process.stdout.columns || 80;
}

/**
 * Clears the current line and moves cursor to start
 */
function clearLine() {
  if (!shouldRender()) return;
  process.stdout.write('\r\x1b[K');
}

/**
 * Moves cursor up N lines
 * @param {number} n - Number of lines to move up
 */
function cursorUp(n = 1) {
  if (!shouldRender() || n <= 0) return;
  process.stdout.write(`\x1b[${n}A`);
}

/**
 * Hides the cursor
 */
function hideCursor() {
  if (!shouldRender()) return;
  process.stdout.write('\x1b[?25l');
}

/**
 * Shows the cursor
 */
function showCursor() {
  if (!shouldRender()) return;
  process.stdout.write('\x1b[?25h');
}

// Global cleanup registry to prevent duplicate handlers
const cleanupRegistry = {
  handlers: new Set(),
  registered: false,

  register(handler) {
    this.handlers.add(handler);
    if (!this.registered) {
      this.registered = true;
      const runCleanup = () => {
        for (const h of this.handlers) {
          try { h(); } catch (e) { /* ignore */ }
        }
        this.handlers.clear();
      };
      process.on('exit', runCleanup);
      process.on('SIGINT', () => { runCleanup(); process.exit(130); });
      process.on('SIGTERM', () => { runCleanup(); process.exit(143); });
    }
  },

  unregister(handler) {
    this.handlers.delete(handler);
  }
};

/**
 * Single progress bar for tracking operation progress
 */
export class ProgressBar {
  /**
   * @param {Object} options - Progress bar options
   * @param {number} options.total - Total number of items
   * @param {string} [options.format] - Format string with placeholders: :bar :current :total :percent :eta :elapsed :rate
   * @param {number} [options.width] - Bar width in characters (default: 30)
   * @param {string} [options.label] - Label to show before the bar
   * @param {boolean} [options.clearOnComplete] - Clear bar when complete (default: false)
   */
  constructor(options = {}) {
    this.total = options.total || 100;
    this.current = 0;
    this.format = options.format || ':label [:bar] :percent :current/:total';
    this.width = options.width || 30;
    this.label = options.label || '';
    this.clearOnComplete = options.clearOnComplete || false;
    this.startTime = Date.now();
    this.lastRenderTime = 0;
    this.complete = false;
    this.rendered = false;

    // Ensure cursor is shown on process exit (use registry to prevent duplicate handlers)
    if (shouldRender()) {
      this._cleanup = () => showCursor();
      cleanupRegistry.register(this._cleanup);
    }
  }

  /**
   * Updates progress bar to new value
   * @param {number} current - Current progress value
   * @param {Object} [tokens] - Additional tokens to replace in format
   */
  tick(current = this.current + 1, tokens = {}) {
    this.current = Math.min(current, this.total);

    // Throttle rendering to max 10 FPS for performance
    const now = Date.now();
    if (now - this.lastRenderTime < 100 && this.current < this.total) {
      return;
    }
    this.lastRenderTime = now;

    this.render(tokens);

    if (this.current >= this.total && !this.complete) {
      this.complete = true;
      if (this.clearOnComplete) {
        clearLine();
      } else {
        process.stdout.write('\n');
      }
      showCursor();
    }
  }

  /**
   * Increments progress by 1
   * @param {Object} [tokens] - Additional tokens to replace in format
   */
  increment(tokens = {}) {
    this.tick(this.current + 1, tokens);
  }

  /**
   * Updates the label text
   * @param {string} label - New label text
   */
  setLabel(label) {
    this.label = label;
  }

  /**
   * Renders the progress bar
   * @param {Object} [tokens] - Additional tokens to replace in format
   */
  render(tokens = {}) {
    if (!shouldRender()) return;

    if (!this.rendered) {
      hideCursor();
      this.rendered = true;
    }

    const percent = Math.round((this.current / this.total) * 100);
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rate = this.current / elapsed || 0;
    const eta = rate > 0 ? Math.round((this.total - this.current) / rate) : 0;

    // Build bar
    const availableWidth = Math.min(this.width, getTerminalWidth() - 50);
    const completeLength = Math.round((this.current / this.total) * availableWidth);
    const incompleteLength = availableWidth - completeLength;

    const bar =
      BAR_CHARS.complete.repeat(Math.max(0, completeLength - 1)) +
      (completeLength > 0 ? BAR_CHARS.head : '') +
      BAR_CHARS.incomplete.repeat(incompleteLength);

    // Build output string
    let output = this.format
      .replace(':bar', bar)
      .replace(':current', String(this.current).padStart(String(this.total).length))
      .replace(':total', String(this.total))
      .replace(':percent', `${percent}%`.padStart(4))
      .replace(':elapsed', `${elapsed.toFixed(1)}s`)
      .replace(':eta', `${eta}s`)
      .replace(':rate', `${rate.toFixed(1)}/s`)
      .replace(':label', this.label.padEnd(20));

    // Apply custom tokens
    for (const [key, value] of Object.entries(tokens)) {
      output = output.replace(`:${key}`, String(value));
    }

    // Truncate to terminal width
    const maxWidth = getTerminalWidth() - 1;
    if (output.length > maxWidth) {
      output = output.substring(0, maxWidth);
    }

    clearLine();
    process.stdout.write(output);
  }

  /**
   * Stops the progress bar
   * @param {boolean} [clear] - Whether to clear the bar
   */
  stop(clear = false) {
    if (clear) {
      clearLine();
    } else if (!this.complete) {
      process.stdout.write('\n');
    }
    showCursor();
    this.complete = true;
    // Unregister cleanup handler
    if (this._cleanup) {
      cleanupRegistry.unregister(this._cleanup);
    }
  }
}

/**
 * Spinner for indeterminate progress
 */
export class Spinner {
  /**
   * @param {Object} options - Spinner options
   * @param {string} [options.text] - Text to show next to spinner
   * @param {string[]} [options.frames] - Animation frames
   */
  constructor(options = {}) {
    this.text = options.text || '';
    this.frames = options.frames || SPINNER_FRAMES;
    this.frameIndex = 0;
    this.interval = null;
    this.startTime = Date.now();
    this._cleanup = null;
  }

  /**
   * Starts the spinner animation
   */
  start() {
    if (!shouldRender()) {
      // In non-TTY mode, just log the initial text
      if (this.text) {
        console.log(`   ${this.text}...`);
      }
      return;
    }

    hideCursor();
    this.interval = setInterval(() => {
      this.render();
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, 80);

    // Register cleanup to stop spinner on process exit
    this._cleanup = () => this.stop();
    cleanupRegistry.register(this._cleanup);
  }

  /**
   * Updates the spinner text
   * @param {string} text - New text
   */
  setText(text) {
    this.text = text;
    if (!shouldRender()) return;
    this.render();
  }

  /**
   * Renders current frame
   */
  render() {
    if (!shouldRender()) return;

    const frame = this.frames[this.frameIndex];
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    clearLine();
    process.stdout.write(`   ${frame} ${this.text} (${elapsed}s)`);
  }

  /**
   * Stops spinner with success indicator
   * @param {string} [text] - Final text to show
   */
  succeed(text) {
    this.stop();
    if (shouldRender()) {
      clearLine();
      process.stdout.write(`   ✅ ${text || this.text}\n`);
    }
  }

  /**
   * Stops spinner with failure indicator
   * @param {string} [text] - Final text to show
   */
  fail(text) {
    this.stop();
    if (shouldRender()) {
      clearLine();
      process.stdout.write(`   ❌ ${text || this.text}\n`);
    }
  }

  /**
   * Stops spinner with warning indicator
   * @param {string} [text] - Final text to show
   */
  warn(text) {
    this.stop();
    if (shouldRender()) {
      clearLine();
      process.stdout.write(`   ⚠️  ${text || this.text}\n`);
    }
  }

  /**
   * Stops the spinner
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    showCursor();
    // Unregister cleanup handler
    if (this._cleanup) {
      cleanupRegistry.unregister(this._cleanup);
      this._cleanup = null;
    }
  }
}

/**
 * Multi-progress tracker for parallel operations
 */
export class MultiProgress {
  constructor() {
    this.bars = new Map();
    this.spinners = new Map();
    this.renderedLines = 0;
    this.renderInterval = null;
    this.lastRender = '';
    this._cleanup = null;
  }

  /**
   * Adds a progress bar
   * @param {string} id - Unique identifier
   * @param {Object} options - ProgressBar options
   * @returns {ProgressBar}
   */
  addBar(id, options = {}) {
    const bar = new ProgressBar({ ...options, clearOnComplete: true });
    // Override render to not output directly
    bar._originalRender = bar.render;
    bar.render = () => {}; // Disable individual rendering
    this.bars.set(id, bar);
    return bar;
  }

  /**
   * Adds a spinner
   * @param {string} id - Unique identifier
   * @param {Object} options - Spinner options
   * @returns {Spinner}
   */
  addSpinner(id, options = {}) {
    const spinner = new Spinner(options);
    spinner._inMulti = true;
    this.spinners.set(id, spinner);
    return spinner;
  }

  /**
   * Removes a bar or spinner
   * @param {string} id - Identifier to remove
   */
  remove(id) {
    this.bars.delete(id);
    const spinner = this.spinners.get(id);
    if (spinner) {
      spinner.stop();
      this.spinners.delete(id);
    }
  }

  /**
   * Starts rendering all progress indicators
   */
  start() {
    if (!shouldRender()) return;

    hideCursor();
    this.renderInterval = setInterval(() => {
      this.render();
    }, 100);

    // Register cleanup to stop on process exit
    this._cleanup = () => this.stop();
    cleanupRegistry.register(this._cleanup);
  }

  /**
   * Renders all progress indicators
   */
  render() {
    if (!shouldRender()) return;

    const lines = [];

    // Render spinners first
    for (const [id, spinner] of this.spinners) {
      const frame = SPINNER_FRAMES[spinner.frameIndex];
      spinner.frameIndex = (spinner.frameIndex + 1) % SPINNER_FRAMES.length;
      const elapsed = ((Date.now() - spinner.startTime) / 1000).toFixed(1);
      lines.push(`   ${frame} ${spinner.text} (${elapsed}s)`);
    }

    // Render progress bars
    for (const [id, bar] of this.bars) {
      const percent = Math.round((bar.current / bar.total) * 100);
      const width = Math.min(bar.width, 25);
      const completeLength = Math.round((bar.current / bar.total) * width);
      const incompleteLength = width - completeLength;

      const barStr =
        BAR_CHARS.complete.repeat(Math.max(0, completeLength - 1)) +
        (completeLength > 0 ? BAR_CHARS.head : '') +
        BAR_CHARS.incomplete.repeat(incompleteLength);

      lines.push(
        `   ${bar.label.padEnd(15)} [${barStr}] ${percent}% ${bar.current}/${bar.total}`
      );
    }

    // Build output
    const output = lines.join('\n');

    // Only re-render if changed
    if (output === this.lastRender && this.renderedLines > 0) {
      // Just update spinner frames
      if (this.renderedLines > 0) {
        cursorUp(this.renderedLines);
        process.stdout.write(output);
        if (this.renderedLines > 1) {
          process.stdout.write('\n'.repeat(this.renderedLines - 1));
        }
      }
      return;
    }

    // Clear previous lines
    if (this.renderedLines > 0) {
      cursorUp(this.renderedLines);
      for (let i = 0; i < this.renderedLines; i++) {
        clearLine();
        if (i < this.renderedLines - 1) {
          process.stdout.write('\n');
        }
      }
      cursorUp(this.renderedLines - 1);
    }

    // Write new output
    process.stdout.write(output);
    this.renderedLines = lines.length;
    this.lastRender = output;
  }

  /**
   * Stops all progress indicators
   */
  stop() {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }

    // Clear all lines
    if (shouldRender() && this.renderedLines > 0) {
      cursorUp(this.renderedLines);
      for (let i = 0; i < this.renderedLines; i++) {
        clearLine();
        process.stdout.write('\n');
      }
    }

    for (const spinner of this.spinners.values()) {
      spinner.stop();
    }

    showCursor();
    this.renderedLines = 0;
    this.bars.clear();
    this.spinners.clear();

    // Unregister cleanup handler
    if (this._cleanup) {
      cleanupRegistry.unregister(this._cleanup);
      this._cleanup = null;
    }
  }
}

/**
 * Gate progress tracker - specialized for quality gate operations
 */
export class GateProgressTracker {
  constructor() {
    this.multi = new MultiProgress();
    this.gateStates = new Map();
    this.overallStartTime = Date.now();
    this.fileStats = { total: 0, processed: 0, cached: 0 };
  }

  /**
   * Starts tracking a gate
   * @param {string} gateName - Name of the gate
   * @param {number} [totalFiles] - Total files to process (optional)
   */
  startGate(gateName, totalFiles = 0) {
    this.gateStates.set(gateName, {
      status: 'running',
      startTime: Date.now(),
      totalFiles,
      processedFiles: 0,
    });

    if (totalFiles > 0) {
      this.multi.addBar(gateName, {
        total: totalFiles,
        label: gateName,
        width: 20,
      });
    } else {
      this.multi.addSpinner(gateName, {
        text: `${gateName}`,
      });
    }
  }

  /**
   * Updates file progress for a gate
   * @param {string} gateName - Gate name
   * @param {number} processed - Files processed
   * @param {number} [cached] - Files retrieved from cache
   */
  updateGateProgress(gateName, processed, cached = 0) {
    const state = this.gateStates.get(gateName);
    if (!state) return;

    state.processedFiles = processed;

    const bar = this.multi.bars.get(gateName);
    if (bar) {
      bar.current = processed;
    }

    const spinner = this.multi.spinners.get(gateName);
    if (spinner) {
      const cacheInfo = cached > 0 ? ` (${cached} cached)` : '';
      spinner.text = `${gateName}: ${processed} files${cacheInfo}`;
    }

    this.fileStats.processed = processed;
    this.fileStats.cached = cached;
  }

  /**
   * Marks a gate as complete
   * @param {string} gateName - Gate name
   * @param {'success'|'warning'|'error'} status - Completion status
   * @param {string} [message] - Optional completion message
   */
  completeGate(gateName, status, message) {
    const state = this.gateStates.get(gateName);
    if (!state) return;

    state.status = status;
    state.endTime = Date.now();
    state.duration = state.endTime - state.startTime;

    const spinner = this.multi.spinners.get(gateName);
    const bar = this.multi.bars.get(gateName);

    if (spinner) {
      const duration = (state.duration / 1000).toFixed(1);
      const finalText = message || `${gateName} (${duration}s)`;

      switch (status) {
        case 'success':
          spinner.succeed(finalText);
          break;
        case 'warning':
          spinner.warn(finalText);
          break;
        case 'error':
          spinner.fail(finalText);
          break;
      }
    }

    this.multi.remove(gateName);
  }

  /**
   * Starts the progress display
   */
  start() {
    this.multi.start();
  }

  /**
   * Stops all progress tracking
   */
  stop() {
    this.multi.stop();
  }

  /**
   * Gets summary of gate execution
   * @returns {Object} Summary statistics
   */
  getSummary() {
    const summary = {
      totalDuration: Date.now() - this.overallStartTime,
      gates: {},
      fileStats: this.fileStats,
    };

    for (const [name, state] of this.gateStates) {
      summary.gates[name] = {
        status: state.status,
        duration: state.duration || Date.now() - state.startTime,
        filesProcessed: state.processedFiles,
      };
    }

    return summary;
  }
}

// Export utilities
export { shouldRender, clearLine, hideCursor, showCursor };

// CLI test
if (process.argv[1] && process.argv[1].endsWith('progress.mjs')) {
  console.log('Testing progress utilities...\n');

  // Test single progress bar
  console.log('Single progress bar:');
  const bar = new ProgressBar({
    total: 50,
    format: ':label [:bar] :percent :current/:total (:elapsed)',
    label: 'Processing',
  });

  let i = 0;
  const interval = setInterval(() => {
    bar.tick(++i);
    if (i >= 50) {
      clearInterval(interval);

      // Test spinner
      console.log('\nSpinner test:');
      const spinner = new Spinner({ text: 'Analyzing files' });
      spinner.start();

      setTimeout(() => {
        spinner.setText('Almost done...');
      }, 1000);

      setTimeout(() => {
        spinner.succeed('Analysis complete');

        // Test gate tracker
        console.log('\nGate progress tracker:');
        const tracker = new GateProgressTracker();
        tracker.start();

        tracker.startGate('naming', 100);
        tracker.startGate('duplication');

        let fileCount = 0;
        const gateInterval = setInterval(() => {
          fileCount += 5;
          tracker.updateGateProgress('naming', fileCount, Math.floor(fileCount * 0.3));

          if (fileCount >= 100) {
            clearInterval(gateInterval);
            tracker.completeGate('naming', 'success', 'naming: 0 violations');
            tracker.completeGate('duplication', 'warning', 'duplication: 2 warnings');
            tracker.stop();

            console.log('\nSummary:', JSON.stringify(tracker.getSummary(), null, 2));
          }
        }, 100);
      }, 2000);
    }
  }, 50);
}
