/**
 * Quality Gates Handler Module
 *
 * Handles quality gate execution, status checking, exception management,
 * and refactoring progress checks.
 *
 * Extracted from index.js to reduce god object size.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { setTimeout: globalSetTimeout, clearTimeout: globalClearTimeout } = globalThis;

/**
 * Install quality gates handlers on a CawsMcpServer instance.
 * @param {object} server - CawsMcpServer instance
 * @param {object} deps - Dependencies: { stripAnsi, execCawsCommand, resolveQualityGatesModule, __filename }
 */
export function installQualityGatesHandlers(server, deps) {
  const { stripAnsi, execCawsCommand, resolveQualityGatesModule, serverFilename } = deps;

  server.handleQualityGates = async function (args) {
    const { args: cliArgs = [], workingDirectory = process.cwd() } = args;

    try {
      const command = `npx @paths.design/caws-cli quality-gates ${cliArgs.join(' ')}`;
      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [{ type: 'text', text: stripAnsi(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: false, error: error.message, command: 'caws quality-gates' },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };

  server.handleQualityGatesRun = async function (args) {
    const {
      gates = '',
      ci = false,
      json = false,
      fix = false,
      workingDirectory = process.cwd(),
    } = args;

    let qualityGatesPath = null;
    let possiblePaths = [];

    try {
      const cliArgs = [];
      if (gates && gates.trim()) cliArgs.push('--gates', gates.trim());
      if (ci) cliArgs.push('--ci');
      if (json) cliArgs.push('--json');
      if (fix) cliArgs.push('--fix');

      const { spawn } = await import('child_process');

      const extensionPath =
        process.env.VSCODE_EXTENSION_PATH || process.env.VSCODE_EXTENSION_DIR;
      possiblePaths = [
        extensionPath
          ? path.join(extensionPath, 'bundled', 'quality-gates', 'run-quality-gates.mjs')
          : null,
        path.join(path.dirname(serverFilename), '..', 'quality-gates', 'run-quality-gates.mjs'),
        path.join(
          path.dirname(path.dirname(serverFilename)),
          '..',
          '..',
          'packages',
          'quality-gates',
          'run-quality-gates.mjs'
        ),
        path.join(
          process.cwd(),
          'node_modules',
          '@paths.design',
          'quality-gates',
          'run-quality-gates.mjs'
        ),
        path.join(
          process.cwd(),
          'node_modules',
          '@caws',
          'quality-gates',
          'run-quality-gates.mjs'
        ),
        path.join(process.cwd(), 'node_modules', 'quality-gates', 'run-quality-gates.mjs'),
      ].filter(Boolean);

      qualityGatesPath = null;
      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          qualityGatesPath = possiblePath;
          break;
        }
      }

      if (!qualityGatesPath) {
        throw new Error(
          `Quality gates runner not found. Searched:\n${possiblePaths.map((p) => `  - ${p}`).join('\n')}`
        );
      }

      return new Promise((resolve, reject) => {
        const timeoutId = globalSetTimeout(() => {
          try {
            if (child && !child.killed) child.kill('SIGTERM');
          } catch {
            // Ignore kill errors
          }
          reject(new Error('Quality gates execution timed out after 30 seconds'));
        }, 30000);

        const child = spawn('node', [qualityGatesPath, ...cliArgs], {
          cwd: workingDirectory,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CAWS_MCP_INTEGRATION: 'true',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('close', () => {
          globalClearTimeout(timeoutId);
          resolve({
            content: [{ type: 'text', text: stripAnsi(stdout || stderr) }],
          });
        });

        child.on('error', (spawnError) => {
          globalClearTimeout(timeoutId);
          reject({
            content: [
              { type: 'text', text: `Failed to start quality gates: ${spawnError.message}` },
            ],
            isError: true,
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws_quality_gates_run',
                workingDirectory: workingDirectory || process.cwd(),
                qualityGatesPath: qualityGatesPath || 'not found',
                attemptedPaths: possiblePaths || [],
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };

  server.handleQualityGatesStatus = async function (args) {
    const { workingDirectory: _workingDirectory = process.cwd(), json = false } = args;

    try {
      const reportPath = path.join(_workingDirectory, 'docs-status', 'quality-gates-report.json');

      if (fs.existsSync(reportPath)) {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

        if (json) {
          return {
            content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
          };
        }

        const status = report.violations.length === 0 ? 'PASSED' : 'FAILED';
        const summary =
          `Quality Gates Status: ${status}\n` +
          `Last run: ${new Date(report.timestamp).toLocaleString()}\n` +
          `Context: ${report.context}\n` +
          `Files checked: ${report.files_scoped}\n` +
          `Violations: ${report.violations.length}\n` +
          `Warnings: ${report.warnings.length}`;

        return { content: [{ type: 'text', text: summary }] };
      } else {
        return {
          content: [
            { type: 'text', text: 'No quality gates report found. Run quality gates first.' },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: false, error: error.message, command: 'caws_quality_gates_status' },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };

  server.handleQualityExceptionsList = async function (args) {
    const { gate, status = 'active', workingDirectory = process.cwd() } = args;

    try {
      const exceptionFrameworkPath = resolveQualityGatesModule('shared-exception-framework.mjs');
      const qualityGatesDir = path.dirname(fileURLToPath(exceptionFrameworkPath));
      const originalNodePath = process.env.NODE_PATH || '';
      const qualityGatesNodeModules = path.join(qualityGatesDir, 'node_modules');
      process.env.NODE_PATH =
        qualityGatesNodeModules + (originalNodePath ? path.delimiter + originalNodePath : '');

      let loadExceptionConfig, setProjectRoot;
      try {
        const module = await import(exceptionFrameworkPath);
        loadExceptionConfig = module.loadExceptionConfig;
        setProjectRoot = module.setProjectRoot;
      } finally {
        process.env.NODE_PATH = originalNodePath;
      }

      setProjectRoot(workingDirectory);
      const config = loadExceptionConfig();
      let exceptions = config.exceptions || [];

      const now = new Date();
      exceptions = exceptions.filter((exc) => {
        const isExpired = new Date(exc.expires_at) < now;
        switch (status) {
          case 'active':
            return !isExpired;
          case 'expired':
            return isExpired;
          case 'all':
            return true;
          default:
            return !isExpired;
        }
      });

      if (gate) exceptions = exceptions.filter((exc) => exc.gate === gate);

      const formatted = exceptions.map((exc) => ({
        id: exc.id,
        gate: exc.gate,
        reason: exc.reason,
        approved_by: exc.approved_by,
        expires_at: exc.expires_at,
        status: new Date(exc.expires_at) > now ? 'active' : 'expired',
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, exceptions: formatted, count: formatted.length, filter: { gate, status } },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error.message || 'Unknown error';
      const isPathError =
        errorMessage.includes('not found') || errorMessage.includes('Cannot find module');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: errorMessage,
                command: 'caws_quality_exceptions_list',
                suggestion: isPathError
                  ? 'Exception framework not available. Ensure quality-gates package is bundled with extension or available in monorepo.'
                  : 'Check error message for details and verify exception framework is properly configured.',
                exceptions: [],
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };

  server.handleQualityExceptionsCreate = async function (args) {
    const {
      gate,
      reason,
      approvedBy,
      expiresAt,
      filePattern,
      violationType,
      context = 'all',
      workingDirectory = process.cwd(),
    } = args;

    try {
      const exceptionFrameworkPath = resolveQualityGatesModule('shared-exception-framework.mjs');
      const qualityGatesDir = path.dirname(fileURLToPath(exceptionFrameworkPath));
      const originalNodePath = process.env.NODE_PATH || '';
      const qualityGatesNodeModules = path.join(qualityGatesDir, 'node_modules');
      process.env.NODE_PATH =
        qualityGatesNodeModules + (originalNodePath ? path.delimiter + originalNodePath : '');

      let addException, setProjectRoot;
      try {
        const module = await import(exceptionFrameworkPath);
        addException = module.addException;
        setProjectRoot = module.setProjectRoot;
      } finally {
        process.env.NODE_PATH = originalNodePath;
      }

      setProjectRoot(workingDirectory);

      let expiresInDays = 180;
      if (expiresAt) {
        const diffMs = new Date(expiresAt).getTime() - Date.now();
        expiresInDays = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
      }

      const exceptionData = {
        reason,
        approvedBy,
        expiresInDays,
        ...(filePattern && { filePattern }),
        ...(violationType && { violationType }),
        context,
      };

      const result = addException(gate, exceptionData);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, message: 'Exception created successfully', exception: result },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error.message || 'Unknown error';
      const isPathError =
        errorMessage.includes('not found') || errorMessage.includes('Cannot find module');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: errorMessage,
                command: 'caws_quality_exceptions_create',
                suggestion: isPathError
                  ? 'Exception framework not available. Ensure quality-gates package is bundled with extension or available in monorepo.'
                  : 'Check error message for details. Verify all required parameters are provided and exception framework is properly configured.',
                exception: null,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };

  server.handleRefactorProgressCheck = async function (args) {
    const {
      context = 'ci',
      strict = false,
      workingDirectory: _workingDirectory = process.cwd(),
    } = args;

    try {
      const { spawn } = await import('child_process');
      const progressCheckerPath = path.join(
        path.dirname(path.dirname(serverFilename)),
        '..',
        '..',
        'packages',
        'quality-gates',
        'monitor-refactoring-progress.mjs'
      );

      const cliArgs = ['--context', context];
      if (strict) cliArgs.push('--strict');

      return new Promise((resolve, reject) => {
        const child = spawn('node', [progressCheckerPath, ...cliArgs], {
          cwd: _workingDirectory,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CAWS_MCP_INTEGRATION: 'true',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('close', () => {
          resolve({
            content: [{ type: 'text', text: stripAnsi(stdout || stderr) }],
          });
        });

        child.on('error', (error) => {
          reject({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { success: false, error: error.message, command: 'caws_refactor_progress_check' },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: false, error: error.message, command: 'caws_refactor_progress_check' },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };
}
