#!/usr/bin/env node

/**
 * CAWS MCP Server
 *
 * Model Context Protocol server that exposes CAWS tools to AI agents.
 * Uses the high-level McpServer API with Zod schemas for input validation.
 *
 * @author @darianrosebrook
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { registerTools } from './src/tools/index.js';
import { registerResources } from './src/resources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

const server = new McpServer({
  name: 'caws-mcp-server',
  version: pkg.version,
});

registerTools(server);
registerResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
