/**
 * Safe async CLI execution for CAWS MCP Server.
 *
 * Uses execFile (not shell) to prevent command injection.
 * All CLI calls are non-blocking.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripAnsi } from './utils.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the CLI entry point. */
function findCliPath() {
  const candidates = [
    // Monorepo sibling
    path.join(__dirname, '..', '..', 'caws-cli', 'dist', 'index.js'),
    // npm installed peer
    path.join(process.cwd(), 'node_modules', '@paths.design', 'caws-cli', 'dist', 'index.js'),
    // Global fallback (npx will handle if neither found)
    null,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** Resolve the quality-gates runner script. */
export function findQualityGatesRunner() {
  const candidates = [
    path.join(__dirname, '..', '..', 'quality-gates', 'run-quality-gates.mjs'),
    path.join(process.cwd(), 'node_modules', '@paths.design', 'quality-gates', 'run-quality-gates.mjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Resolve the quality-gates exception framework. */
export function findExceptionFramework() {
  const candidates = [
    path.join(__dirname, '..', '..', 'quality-gates', 'shared-exception-framework.mjs'),
    path.join(process.cwd(), 'node_modules', '@paths.design', 'quality-gates', 'shared-exception-framework.mjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Resolve the refactoring progress checker. */
export function findRefactorProgressChecker() {
  const candidates = [
    path.join(__dirname, '..', '..', 'quality-gates', 'monitor-refactoring-progress.mjs'),
    path.join(process.cwd(), 'node_modules', '@paths.design', 'quality-gates', 'monitor-refactoring-progress.mjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const ENV = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  CAWS_OUTPUT_FORMAT: 'json',
  TERM: 'dumb',
  CI: 'true',
};

/**
 * Execute a CAWS CLI command asynchronously.
 * @param {string[]} args - CLI arguments (e.g., ['validate', '.caws/working-spec.yaml'])
 * @param {object} [options]
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.timeout] - Timeout in ms (default 60000)
 * @returns {Promise<string>} Cleaned stdout
 */
export async function execCaws(args, options = {}) {
  const cliPath = findCliPath();
  const timeout = options.timeout || 60000;
  const cwd = options.cwd || process.cwd();

  let stdout;
  if (cliPath) {
    ({ stdout } = await execFileAsync('node', [cliPath, ...args], {
      maxBuffer: 1024 * 1024,
      timeout,
      cwd,
      env: ENV,
    }));
  } else {
    // Fallback to npx
    ({ stdout } = await execFileAsync('npx', ['@paths.design/caws-cli', ...args], {
      maxBuffer: 1024 * 1024,
      timeout,
      cwd,
      env: ENV,
    }));
  }

  return stripAnsi(stdout);
}

/**
 * Spawn a Node script and collect output asynchronously.
 * @param {string} scriptPath - Absolute path to the script
 * @param {string[]} args - Script arguments
 * @param {object} [options]
 * @returns {Promise<string>} Cleaned stdout
 */
export function spawnScript(scriptPath, args = [], options = {}) {
  const timeout = options.timeout || 30000;
  const cwd = options.cwd || process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...ENV,
        CAWS_MCP_INTEGRATION: 'true',
      },
    });

    let stdout = '';
    let stderr = '';
    const timer = globalThis.setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Script timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', () => {
      globalThis.clearTimeout(timer);
      resolve(stripAnsi(stdout || stderr));
    });

    child.on('error', (error) => {
      globalThis.clearTimeout(timer);
      reject(error);
    });
  });
}
