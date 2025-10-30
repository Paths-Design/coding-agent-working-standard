/**
 * @fileoverview Async Operation Utilities
 * Provides consistent patterns for async operations, parallel execution, and resource cleanup
 * @author @darianrosebrook
 */

/**
 * Execute multiple async operations in parallel
 * @param {Array<Promise>} promises - Array of promises to execute
 * @param {Object} options - Options
 * @param {boolean} [options.failFast=true] - Stop on first error
 * @returns {Promise<Array>} Array of results
 */
async function parallel(promises, options = {}) {
  const { failFast = true } = options;

  if (failFast) {
    return Promise.all(promises);
  } else {
    // Wait for all promises, collecting both successes and failures
    return Promise.allSettled(promises).then((results) => {
      return results.map((result) => {
        if (result.status === 'fulfilled') {
          return { success: true, value: result.value };
        } else {
          return { success: false, error: result.reason };
        }
      });
    });
  }
}

/**
 * Execute async operations sequentially
 * @param {Array<Function>} operations - Array of async functions to execute
 * @param {Object} options - Options
 * @param {boolean} [options.stopOnError=true] - Stop on first error
 * @returns {Promise<Array>} Array of results
 */
async function sequential(operations, options = {}) {
  const { stopOnError = true } = options;
  const results = [];

  for (const operation of operations) {
    try {
      const result = await operation();
      results.push({ success: true, value: result });
    } catch (error) {
      if (stopOnError) {
        throw error;
      }
      results.push({ success: false, error });
    }
  }

  return results;
}

/**
 * Retry an async operation with exponential backoff
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} [options.maxRetries=3] - Maximum number of retries
 * @param {number} [options.initialDelay=1000] - Initial delay in ms
 * @param {number} [options.maxDelay=10000] - Maximum delay in ms
 * @param {Function} [options.shouldRetry] - Function to determine if error should be retried
 * @returns {Promise<any>} Operation result
 */
async function retry(operation, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    shouldRetry = () => true,
  } = options;

  let lastError;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw lastError;
}

/**
 * Execute operation with timeout
 * @param {Promise} promise - Promise to execute
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} [errorMessage] - Custom error message
 * @returns {Promise<any>} Operation result
 */
async function withTimeout(promise, timeoutMs, errorMessage = 'Operation timed out') {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${errorMessage} (${timeoutMs}ms)`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Execute operation with resource cleanup
 * @param {Function} operation - Async operation to execute
 * @param {Function} cleanup - Cleanup function (called in finally)
 * @returns {Promise<any>} Operation result
 */
async function withCleanup(operation, cleanup) {
  try {
    return await operation();
  } finally {
    await cleanup();
  }
}

/**
 * Execute multiple operations and collect all errors
 * @param {Array<Function>} operations - Array of async functions
 * @returns {Promise<{successes: Array, errors: Array}>} Results and errors
 */
async function collectResults(operations) {
  const results = await Promise.allSettled(
    operations.map((op) => op())
  );

  const successes = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successes.push({ index, value: result.value });
    } else {
      errors.push({ index, error: result.reason });
    }
  });

  return { successes, errors };
}

/**
 * Execute operation with cancellation support
 * @param {Function} operation - Async operation to execute
 * @param {AbortSignal} signal - Abort signal for cancellation
 * @returns {Promise<any>} Operation result
 */
async function withCancellation(operation, signal) {
  if (signal.aborted) {
    throw new Error('Operation cancelled');
  }

  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('Operation cancelled'));
    });

    operation()
      .then(resolve)
      .catch(reject);
  });
}

module.exports = {
  parallel,
  sequential,
  retry,
  withTimeout,
  withCleanup,
  collectResults,
  withCancellation,
};

