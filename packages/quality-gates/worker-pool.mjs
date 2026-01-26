#!/usr/bin/env node

/**
 * Worker Thread Pool for Quality Gates
 *
 * Provides parallel processing for CPU-intensive quality gate operations
 * like AST parsing, duplication detection, and pattern matching.
 *
 * Features:
 * - Configurable pool size (defaults to CPU count - 1)
 * - Task queuing with priority support
 * - Progress reporting from workers
 * - Graceful shutdown and error recovery
 * - Integration with caching system
 *
 * @author @darianrosebrook
 * @version 1.0.0
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Worker pool for parallel file processing
 */
export class WorkerPool {
  /**
   * @param {Object} options - Pool options
   * @param {number} [options.size] - Number of workers (default: CPU count - 1)
   * @param {string} [options.workerScript] - Path to worker script
   * @param {Function} [options.onProgress] - Progress callback (processed, total, workerIndex)
   * @param {Object} [options.workerData] - Data to pass to workers
   */
  constructor(options = {}) {
    this.size = options.size || Math.max(1, cpus().length - 1);
    this.workerScript = options.workerScript || path.join(__dirname, 'worker-pool.mjs');
    this.onProgress = options.onProgress || (() => {});
    this.workerData = options.workerData || {};

    this.workers = [];
    this.taskQueue = [];
    this.activeWorkers = new Map(); // workerId -> { task, resolve, reject }
    this.processed = 0;
    this.total = 0;
    this.terminated = false;

    // Statistics
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalProcessingTime: 0,
    };

    // Register cleanup on process exit
    this._cleanup = () => {
      if (!this.terminated) {
        this.terminate().catch(() => {});
      }
    };
    process.on('exit', this._cleanup);
    process.on('SIGINT', () => { this._cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { this._cleanup(); process.exit(143); });
  }

  /**
   * Initializes the worker pool
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.workers.length > 0) return;

    const workerPromises = [];
    for (let i = 0; i < this.size; i++) {
      workerPromises.push(this._createWorker(i));
    }

    await Promise.all(workerPromises);
  }

  /**
   * Creates a single worker
   * @param {number} index - Worker index
   * @returns {Promise<Worker>}
   * @private
   */
  async _createWorker(index) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerScript, {
        workerData: {
          workerIndex: index,
          ...this.workerData,
        },
      });

      worker.on('online', () => {
        this.workers[index] = worker;
        resolve(worker);
      });

      worker.on('message', (message) => {
        this._handleWorkerMessage(index, message);
      });

      worker.on('error', (error) => {
        console.error(`Worker ${index} error:`, error);
        this._handleWorkerError(index, error);
      });

      worker.on('exit', (code) => {
        if (code !== 0 && !this.terminated) {
          console.error(`Worker ${index} exited with code ${code}`);
          // Attempt to recreate worker
          this._recreateWorker(index);
        }
      });
    });
  }

  /**
   * Handles messages from workers
   * @param {number} workerIndex - Worker index
   * @param {Object} message - Message from worker
   * @private
   */
  _handleWorkerMessage(workerIndex, message) {
    const { type, taskId, result, error, progress, cacheHit } = message;

    switch (type) {
      case 'result': {
        const activeTask = this.activeWorkers.get(workerIndex);
        if (activeTask && activeTask.task.id === taskId) {
          if (error) {
            activeTask.reject(new Error(error));
            this.stats.tasksFailed++;
          } else {
            activeTask.resolve(result);
            this.stats.tasksCompleted++;
            if (cacheHit) {
              this.stats.cacheHits++;
            } else {
              this.stats.cacheMisses++;
            }
          }
          this.activeWorkers.delete(workerIndex);
          this.processed++;
          this.onProgress(this.processed, this.total, workerIndex);
          this._processNextTask(workerIndex);
        }
        break;
      }

      case 'progress': {
        // Individual file progress within a task
        this.onProgress(this.processed, this.total, workerIndex, progress);
        break;
      }

      case 'ready': {
        // Worker is ready for tasks
        this._processNextTask(workerIndex);
        break;
      }
    }
  }

  /**
   * Handles worker errors
   * @param {number} workerIndex - Worker index
   * @param {Error} error - Error object
   * @private
   */
  _handleWorkerError(workerIndex, error) {
    const activeTask = this.activeWorkers.get(workerIndex);
    if (activeTask) {
      activeTask.reject(error);
      this.stats.tasksFailed++;
      this.activeWorkers.delete(workerIndex);
      this.processed++;
    }
    this._processNextTask(workerIndex);
  }

  /**
   * Recreates a failed worker
   * @param {number} index - Worker index
   * @private
   */
  async _recreateWorker(index) {
    if (this.terminated) return;

    try {
      await this._createWorker(index);
      this._processNextTask(index);
    } catch (error) {
      console.error(`Failed to recreate worker ${index}:`, error);
    }
  }

  /**
   * Processes the next task in queue for a worker
   * @param {number} workerIndex - Worker index
   * @private
   */
  _processNextTask(workerIndex) {
    if (this.terminated || this.taskQueue.length === 0) return;

    const worker = this.workers[workerIndex];
    if (!worker || this.activeWorkers.has(workerIndex)) return;

    const task = this.taskQueue.shift();
    this.activeWorkers.set(workerIndex, task);

    worker.postMessage({
      type: 'task',
      task: task.task,
    });
  }

  /**
   * Adds a task to the queue
   * @param {Object} task - Task to process
   * @param {string} task.type - Task type (e.g., 'analyzeFile', 'checkDuplication')
   * @param {*} task.data - Task data
   * @param {number} [priority=0] - Task priority (higher = sooner)
   * @returns {Promise<*>} Task result
   */
  addTask(task, priority = 0) {
    this.total++;

    return new Promise((resolve, reject) => {
      const taskWrapper = {
        task: {
          id: crypto.randomUUID(),
          priority,
          ...task,
        },
        resolve,
        reject,
      };

      // Insert by priority
      const insertIndex = this.taskQueue.findIndex((t) => t.task.priority < priority);
      if (insertIndex === -1) {
        this.taskQueue.push(taskWrapper);
      } else {
        this.taskQueue.splice(insertIndex, 0, taskWrapper);
      }

      // Try to assign to an available worker
      for (let i = 0; i < this.workers.length; i++) {
        if (!this.activeWorkers.has(i)) {
          this._processNextTask(i);
          break;
        }
      }
    });
  }

  /**
   * Processes multiple tasks in parallel
   * @param {Array<Object>} tasks - Tasks to process
   * @param {Object} [options] - Processing options
   * @param {number} [options.concurrency] - Max concurrent tasks (default: pool size)
   * @returns {Promise<Array<*>>} Results in order
   */
  async processBatch(tasks, options = {}) {
    await this.initialize();

    this.total = tasks.length;
    this.processed = 0;

    const results = await Promise.all(tasks.map((task) => this.addTask(task)));

    return results;
  }

  /**
   * Gets current pool statistics
   * @returns {Object} Pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      poolSize: this.size,
      activeWorkers: this.activeWorkers.size,
      queuedTasks: this.taskQueue.length,
      processed: this.processed,
      total: this.total,
    };
  }

  /**
   * Terminates all workers
   * @returns {Promise<void>}
   */
  async terminate() {
    this.terminated = true;

    const terminatePromises = this.workers.map((worker) => {
      if (worker) {
        return new Promise((resolve) => {
          worker.once('exit', resolve);
          worker.terminate();
        });
      }
      return Promise.resolve();
    });

    await Promise.all(terminatePromises);

    // Reject any pending tasks
    for (const task of this.taskQueue) {
      task.reject(new Error('Worker pool terminated'));
    }
    this.taskQueue = [];

    for (const [, activeTask] of this.activeWorkers) {
      activeTask.reject(new Error('Worker pool terminated'));
    }
    this.activeWorkers.clear();

    this.workers = [];
  }
}

/**
 * Shared cache manager for workers
 */
export class WorkerCacheManager {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.memoryCache = new Map();
    this.maxMemoryEntries = 1000;
  }

  /**
   * Gets a cache key for content
   * @param {string} filePath - File path
   * @param {string} content - File content
   * @returns {string} Cache key
   */
  getCacheKey(filePath, content) {
    const hash = crypto.createHash('md5').update(content).digest('hex');
    return `${filePath}:${hash}`;
  }

  /**
   * Gets cached result
   * @param {string} key - Cache key
   * @returns {*|null} Cached result or null
   */
  get(key) {
    // Check memory cache first
    if (this.memoryCache.has(key)) {
      return this.memoryCache.get(key);
    }

    // Check disk cache
    const cacheFile = this._getCacheFilePath(key);
    if (fs.existsSync(cacheFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        // Check expiry (24 hours)
        if (Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
          // Add to memory cache
          this._addToMemoryCache(key, data.result);
          return data.result;
        }
      } catch {
        // Invalid cache file
      }
    }

    return null;
  }

  /**
   * Sets cached result
   * @param {string} key - Cache key
   * @param {*} result - Result to cache
   */
  set(key, result) {
    // Add to memory cache
    this._addToMemoryCache(key, result);

    // Write to disk cache
    const cacheFile = this._getCacheFilePath(key);
    try {
      const cacheSubDir = path.dirname(cacheFile);
      if (!fs.existsSync(cacheSubDir)) {
        fs.mkdirSync(cacheSubDir, { recursive: true });
      }
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({
          timestamp: Date.now(),
          result,
        })
      );
    } catch {
      // Cache write failed, not critical
    }
  }

  /**
   * Adds to memory cache with LRU eviction
   * @param {string} key - Cache key
   * @param {*} result - Result to cache
   * @private
   */
  _addToMemoryCache(key, result) {
    // LRU eviction
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(key, result);
  }

  /**
   * Gets cache file path for a key
   * @param {string} key - Cache key
   * @returns {string} File path
   * @private
   */
  _getCacheFilePath(key) {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return path.join(this.cacheDir, hash.substring(0, 2), `${hash}.json`);
  }

  /**
   * Clears all cached data
   */
  clear() {
    this.memoryCache.clear();
    if (fs.existsSync(this.cacheDir)) {
      try {
        fs.rmSync(this.cacheDir, { recursive: true, force: true });
      } catch {
        // Clear failed, not critical
      }
    }
  }
}

// Worker thread code
if (!isMainThread) {
  const { workerIndex } = workerData;

  // Notify main thread we're ready
  parentPort.postMessage({ type: 'ready', workerIndex });

  // Handle incoming tasks
  parentPort.on('message', async (message) => {
    if (message.type === 'task') {
      const { task } = message;

      try {
        let result;
        let cacheHit = false;

        switch (task.type) {
          case 'analyzeFile':
            ({ result, cacheHit } = await handleAnalyzeFile(task.data));
            break;

          case 'checkNaming':
            ({ result, cacheHit } = await handleCheckNaming(task.data));
            break;

          case 'checkPlaceholders':
            ({ result, cacheHit } = await handleCheckPlaceholders(task.data));
            break;

          case 'extractRegions':
            ({ result, cacheHit } = await handleExtractRegions(task.data));
            break;

          default:
            throw new Error(`Unknown task type: ${task.type}`);
        }

        parentPort.postMessage({
          type: 'result',
          taskId: task.id,
          result,
          cacheHit,
        });
      } catch (error) {
        parentPort.postMessage({
          type: 'result',
          taskId: task.id,
          error: error.message,
        });
      }
    }
  });

  // Task handlers

  async function handleAnalyzeFile(data) {
    const { filePath, content, analysisType } = data;

    // This would be replaced with actual analysis logic
    // For now, return a placeholder result
    return {
      result: {
        filePath,
        analysisType,
        findings: [],
      },
      cacheHit: false,
    };
  }

  async function handleCheckNaming(data) {
    const { filePath, content, rules } = data;

    // Naming analysis would go here
    const violations = [];

    return {
      result: violations,
      cacheHit: false,
    };
  }

  async function handleCheckPlaceholders(data) {
    const { filePath, content, patterns } = data;

    // Placeholder detection would go here
    const findings = [];

    return {
      result: findings,
      cacheHit: false,
    };
  }

  async function handleExtractRegions(data) {
    const { filePath, content, language, config } = data;

    // Region extraction for duplication detection would go here
    const regions = [];

    return {
      result: regions,
      cacheHit: false,
    };
  }
}

// Export for main thread usage
export { isMainThread };

// CLI test
if (isMainThread && process.argv[1] && process.argv[1].endsWith('worker-pool.mjs')) {
  console.log('Testing worker pool...\n');

  const pool = new WorkerPool({
    size: 2,
    onProgress: (processed, total, workerIndex) => {
      console.log(`Progress: ${processed}/${total} (worker ${workerIndex})`);
    },
  });

  async function test() {
    await pool.initialize();

    // Create test tasks
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      type: 'analyzeFile',
      data: {
        filePath: `test-file-${i}.js`,
        content: `function test${i}() { return ${i}; }`,
        analysisType: 'basic',
      },
    }));

    console.log(`Processing ${tasks.length} tasks with ${pool.size} workers...\n`);

    const results = await pool.processBatch(tasks);

    console.log('\nResults:', results.length, 'items');
    console.log('Stats:', pool.getStats());

    await pool.terminate();
    console.log('\nPool terminated.');
  }

  test().catch(console.error);
}
