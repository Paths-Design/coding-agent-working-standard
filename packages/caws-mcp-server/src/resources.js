/**
 * CAWS MCP Resource Registration
 *
 * Registers CAWS resources (working specs, waivers) on the McpServer.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Detect project root directory (git root or cwd).
 */
function getProjectRoot() {
  if (process.env.CURSOR_WORKSPACE_ROOT) return process.env.CURSOR_WORKSPACE_ROOT;
  if (process.env.VSCODE_WORKSPACE_ROOT) return process.env.VSCODE_WORKSPACE_ROOT;
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return process.cwd();
  }
}

export function registerResources(server) {
  // Working spec resource
  server.resource(
    'working-spec',
    'caws://working-spec',
    { description: 'CAWS working specification', mimeType: 'application/yaml' },
    async () => {
      const projectRoot = getProjectRoot();
      const specPath = path.join(projectRoot, '.caws', 'working-spec.yaml');

      if (!fs.existsSync(specPath)) {
        return { contents: [{ uri: 'caws://working-spec', mimeType: 'text/plain', text: 'No working spec found.' }] };
      }

      const content = fs.readFileSync(specPath, 'utf8');
      return {
        contents: [{
          uri: 'caws://working-spec',
          mimeType: 'application/yaml',
          text: content,
        }],
      };
    }
  );
}
