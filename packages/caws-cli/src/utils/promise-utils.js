/**
 * @fileoverview Promise Utilities
 * Utilities for converting callback-based APIs to promises
 * @author @darianrosebrook
 */

/**
 * Convert readline question to promise
 * @param {readline.Interface} rl - Readline interface
 * @param {string} question - Question to ask
 * @returns {Promise<string>} User's answer
 */
function question(rl, questionText) {
  return new Promise((resolve) => {
    rl.question(questionText, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Close readline interface and return promise
 * @param {readline.Interface} rl - Readline interface
 * @returns {Promise<void>}
 */
function closeReadline(rl) {
  return new Promise((resolve) => {
    rl.once('close', resolve);
    rl.close();
  });
}

/**
 * Create a promise that resolves when event fires
 * @param {EventEmitter} emitter - Event emitter
 * @param {string} event - Event name
 * @param {Object} options - Options
 * @param {number} [options.timeout] - Timeout in ms
 * @returns {Promise<any>} Event data
 */
function once(emitter, event, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeout } = options;

    const timeoutId = timeout
      ? setTimeout(() => {
          emitter.removeListener(event, handler);
          reject(new Error(`Event '${event}' timed out after ${timeout}ms`));
        }, timeout)
      : null;

    const handler = (...args) => {
      if (timeoutId) clearTimeout(timeoutId);
      emitter.removeListener(event, handler);
      resolve(args.length === 1 ? args[0] : args);
    };

    emitter.once(event, handler);
  });
}

module.exports = {
  question,
  closeReadline,
  once,
};

