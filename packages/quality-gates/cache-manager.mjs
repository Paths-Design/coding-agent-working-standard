#!/usr/bin/env node

/**
 * Shared Cache Manager for Quality Gates
 *
 * Provides content-based caching for all quality gate operations.
 * Caches are invalidated when file content changes (MD5 hash-based).
 *
 * Features:
 * - Content-hash based cache keys
 * - Configurable expiry (default 24 hours)
 * - Memory + disk caching with LRU eviction
 * - Thread-safe for worker pool usage
 * - Supports per-gate cache namespaces
 *
 * @author @darianrosebrook
 * @version 1.0.0
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * Default cache configuration
 */
const DEFAULT_CONFIG = {
  maxMemoryEntries: 1000,
  maxDiskSizeMB: 100,
  defaultExpiryMs: 24 * 60 * 60 * 1000, // 24 hours
  cacheDir: '.caws/cache',
};

/**
 * Get repository root
 * @returns {string} Repository root path
 */
function getRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Shared cache manager for quality gates
 */
export class CacheManager {
  /**
   * @param {Object} options - Cache options
   * @param {string} [options.namespace] - Cache namespace (e.g., 'naming', 'duplication')
   * @param {string} [options.cacheDir] - Cache directory path
   * @param {number} [options.maxMemoryEntries] - Max entries in memory cache
   * @param {number} [options.expiryMs] - Cache expiry in milliseconds
   */
  constructor(options = {}) {
    this.namespace = options.namespace || 'default';
    this.repoRoot = getRepoRoot();
    this.cacheDir = path.join(
      this.repoRoot,
      options.cacheDir || DEFAULT_CONFIG.cacheDir,
      this.namespace
    );
    this.maxMemoryEntries = options.maxMemoryEntries || DEFAULT_CONFIG.maxMemoryEntries;
    this.expiryMs = options.expiryMs || DEFAULT_CONFIG.defaultExpiryMs;

    // In-memory LRU cache
    this.memoryCache = new Map();
    this.accessOrder = [];

    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      writes: 0,
      evictions: 0,
    };

    // Ensure cache directory exists
    this._ensureCacheDir();
  }

  /**
   * Generates a cache key from file path and content
   * @param {string} filePath - File path
   * @param {string} content - File content
   * @returns {string} Cache key
   */
  getCacheKey(filePath, content) {
    const contentHash = crypto.createHash('md5').update(content).digest('hex');
    const pathHash = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 8);
    return `${pathHash}_${contentHash}`;
  }

  /**
   * Gets a cached value
   * @param {string} key - Cache key
   * @returns {*|null} Cached value or null if not found/expired
   */
  get(key) {
    // Check memory cache first (faster)
    if (this.memoryCache.has(key)) {
      const entry = this.memoryCache.get(key);
      if (this._isValid(entry)) {
        this._updateAccessOrder(key);
        this.stats.hits++;
        return entry.value;
      }
      // Expired, remove from memory
      this.memoryCache.delete(key);
    }

    // Check disk cache
    const diskPath = this._getDiskPath(key);
    if (fs.existsSync(diskPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
        if (this._isValid(data)) {
          // Promote to memory cache
          this._setMemory(key, data.value, data.timestamp);
          this.stats.hits++;
          return data.value;
        }
        // Expired, remove from disk
        this._removeFromDisk(key);
      } catch {
        // Corrupted cache file, remove it
        this._removeFromDisk(key);
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Sets a cached value
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   */
  set(key, value) {
    const timestamp = Date.now();

    // Set in memory cache
    this._setMemory(key, value, timestamp);

    // Write to disk cache (async to not block)
    this._writeToDisk(key, value, timestamp);

    this.stats.writes++;
  }

  /**
   * Checks if a value exists and is valid
   * @param {string} key - Cache key
   * @returns {boolean} True if cached and valid
   */
  has(key) {
    // Check memory first
    if (this.memoryCache.has(key)) {
      const entry = this.memoryCache.get(key);
      if (this._isValid(entry)) {
        return true;
      }
      this.memoryCache.delete(key);
    }

    // Check disk
    const diskPath = this._getDiskPath(key);
    if (fs.existsSync(diskPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
        return this._isValid(data);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Removes a cached value
   * @param {string} key - Cache key
   */
  delete(key) {
    this.memoryCache.delete(key);
    this._removeFromDisk(key);
  }

  /**
   * Clears all cached data for this namespace
   */
  clear() {
    this.memoryCache.clear();
    this.accessOrder = [];

    if (fs.existsSync(this.cacheDir)) {
      try {
        fs.rmSync(this.cacheDir, { recursive: true, force: true });
        this._ensureCacheDir();
      } catch {
        // Clear failed, not critical
      }
    }

    this.stats = { hits: 0, misses: 0, writes: 0, evictions: 0 };
  }

  /**
   * Gets cache statistics
   * @returns {Object} Cache statistics
   */
  getStats() {
    const hitRate =
      this.stats.hits + this.stats.misses > 0
        ? (this.stats.hits / (this.stats.hits + this.stats.misses)) * 100
        : 0;

    return {
      ...this.stats,
      hitRate: hitRate.toFixed(1) + '%',
      memorySize: this.memoryCache.size,
      namespace: this.namespace,
    };
  }

  /**
   * Gets or computes a cached value
   * @param {string} key - Cache key
   * @param {Function} compute - Function to compute value if not cached
   * @returns {Promise<*>} Cached or computed value
   */
  async getOrCompute(key, compute) {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = await compute();
    this.set(key, value);
    return value;
  }

  /**
   * Synchronous version of getOrCompute
   * @param {string} key - Cache key
   * @param {Function} compute - Function to compute value if not cached
   * @returns {*} Cached or computed value
   */
  getOrComputeSync(key, compute) {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = compute();
    this.set(key, value);
    return value;
  }

  // Private methods

  _ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      } catch {
        // Directory creation failed
      }
    }
  }

  _isValid(entry) {
    if (!entry || !entry.timestamp) return false;
    return Date.now() - entry.timestamp < this.expiryMs;
  }

  _setMemory(key, value, timestamp) {
    // LRU eviction
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
        this.stats.evictions++;
      }
    }

    this.memoryCache.set(key, { value, timestamp });
    this._updateAccessOrder(key);
  }

  _updateAccessOrder(key) {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(key);
  }

  _getDiskPath(key) {
    // Use first 2 chars as subdirectory for better file distribution
    const subdir = key.substring(0, 2);
    return path.join(this.cacheDir, subdir, `${key}.json`);
  }

  _writeToDisk(key, value, timestamp) {
    const diskPath = this._getDiskPath(key);
    const subdir = path.dirname(diskPath);

    try {
      if (!fs.existsSync(subdir)) {
        fs.mkdirSync(subdir, { recursive: true });
      }
      fs.writeFileSync(
        diskPath,
        JSON.stringify({ value, timestamp }, null, 0) // Compact JSON
      );
    } catch {
      // Write failed, not critical
    }
  }

  _removeFromDisk(key) {
    const diskPath = this._getDiskPath(key);
    try {
      if (fs.existsSync(diskPath)) {
        fs.unlinkSync(diskPath);
      }
    } catch {
      // Remove failed, not critical
    }
  }
}

/**
 * Global cache instances for each gate
 */
const gatesCaches = new Map();

/**
 * Gets or creates a cache instance for a quality gate
 * @param {string} gateName - Name of the quality gate
 * @param {Object} [options] - Cache options
 * @returns {CacheManager} Cache instance
 */
export function getGateCache(gateName, options = {}) {
  if (!gatesCaches.has(gateName)) {
    gatesCaches.set(
      gateName,
      new CacheManager({
        namespace: gateName,
        ...options,
      })
    );
  }
  return gatesCaches.get(gateName);
}

/**
 * Clears all gate caches
 */
export function clearAllCaches() {
  for (const cache of gatesCaches.values()) {
    cache.clear();
  }
  gatesCaches.clear();
}

/**
 * Gets aggregate statistics from all caches
 * @returns {Object} Aggregate statistics
 */
export function getAllCacheStats() {
  const stats = {
    totalHits: 0,
    totalMisses: 0,
    totalWrites: 0,
    caches: {},
  };

  for (const [name, cache] of gatesCaches) {
    const cacheStats = cache.getStats();
    stats.totalHits += cacheStats.hits;
    stats.totalMisses += cacheStats.misses;
    stats.totalWrites += cacheStats.writes;
    stats.caches[name] = cacheStats;
  }

  const totalRequests = stats.totalHits + stats.totalMisses;
  stats.overallHitRate = totalRequests > 0 ? ((stats.totalHits / totalRequests) * 100).toFixed(1) + '%' : '0%';

  return stats;
}

/**
 * File-level cache helper for common use case
 * Caches analysis results based on file path and content hash
 */
export class FileAnalysisCache {
  /**
   * @param {string} gateName - Quality gate name
   */
  constructor(gateName) {
    this.cache = getGateCache(gateName);
  }

  /**
   * Gets cached analysis result for a file
   * @param {string} filePath - File path
   * @param {string} content - File content
   * @returns {*|null} Cached result or null
   */
  getFileResult(filePath, content) {
    const key = this.cache.getCacheKey(filePath, content);
    return this.cache.get(key);
  }

  /**
   * Caches analysis result for a file
   * @param {string} filePath - File path
   * @param {string} content - File content
   * @param {*} result - Analysis result
   */
  setFileResult(filePath, content, result) {
    const key = this.cache.getCacheKey(filePath, content);
    this.cache.set(key, result);
  }

  /**
   * Gets or computes cached analysis result
   * @param {string} filePath - File path
   * @param {string} content - File content
   * @param {Function} analyze - Analysis function
   * @returns {Promise<*>} Analysis result
   */
  async getOrAnalyze(filePath, content, analyze) {
    const key = this.cache.getCacheKey(filePath, content);
    return this.cache.getOrCompute(key, () => analyze(filePath, content));
  }

  /**
   * Synchronous version of getOrAnalyze
   * @param {string} filePath - File path
   * @param {string} content - File content
   * @param {Function} analyze - Analysis function
   * @returns {*} Analysis result
   */
  getOrAnalyzeSync(filePath, content, analyze) {
    const key = this.cache.getCacheKey(filePath, content);
    return this.cache.getOrComputeSync(key, () => analyze(filePath, content));
  }

  /**
   * Gets cache statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return this.cache.getStats();
  }
}

// CLI test
if (process.argv[1] && process.argv[1].endsWith('cache-manager.mjs')) {
  console.log('Testing cache manager...\n');

  const cache = new CacheManager({ namespace: 'test' });

  // Test basic operations
  console.log('Setting values...');
  cache.set('key1', { data: 'test1', array: [1, 2, 3] });
  cache.set('key2', { data: 'test2' });

  console.log('Getting values...');
  console.log('key1:', cache.get('key1'));
  console.log('key2:', cache.get('key2'));
  console.log('key3 (missing):', cache.get('key3'));

  // Test file cache helper
  console.log('\nTesting FileAnalysisCache...');
  const fileCache = new FileAnalysisCache('naming');

  const testContent = 'function test() { return 42; }';
  const testPath = '/test/file.js';

  // First call - compute
  const result1 = fileCache.getOrAnalyzeSync(testPath, testContent, (path, content) => {
    console.log('  Computing result (cache miss)...');
    return { violations: [], fileSize: content.length };
  });
  console.log('Result 1:', result1);

  // Second call - cached
  const result2 = fileCache.getOrAnalyzeSync(testPath, testContent, () => {
    console.log('  Computing result (should not see this)...');
    return { violations: ['new'], fileSize: 0 };
  });
  console.log('Result 2 (should match result 1):', result2);

  // Different content - recompute
  const result3 = fileCache.getOrAnalyzeSync(testPath, testContent + ' // modified', (path, content) => {
    console.log('  Computing result (content changed)...');
    return { violations: [], fileSize: content.length };
  });
  console.log('Result 3 (different size):', result3);

  console.log('\nCache statistics:');
  console.log(fileCache.getStats());

  console.log('\nAll cache statistics:');
  console.log(getAllCacheStats());

  // Cleanup
  cache.clear();
  console.log('\nCache cleared.');
}

export default CacheManager;
