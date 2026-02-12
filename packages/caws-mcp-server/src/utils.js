/**
 * Shared utilities for CAWS MCP Server
 */

/**
 * Strip ANSI escape codes from text output.
 * Prevents color codes from corrupting JSON responses.
 * Preserves newlines and other essential control characters.
 */
/* eslint-disable no-control-regex */
export function stripAnsi(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\u001b\]8;[^;]*;[^\u0007]*\u0007/g, '')
    .replace(/\u001b\][0-9]+;[^\u0007]*\u0007/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\][^\u001b\\]*\\/g, '')
    .replace(/\u001b[[\]()#;?]?[0-9;:]*[A-Za-z]/g, '')
    .replace(/\u001b./g, '')
    // Remove problematic control chars but keep \n, \r, \t
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}
/* eslint-enable no-control-regex */

/**
 * Format a successful tool response.
 */
export function ok(text) {
  return { content: [{ type: 'text', text }] };
}

/**
 * Format a JSON tool response.
 */
export function jsonOk(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Format an error tool response.
 */
export function err(message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}
