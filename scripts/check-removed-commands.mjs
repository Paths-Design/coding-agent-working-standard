#!/usr/bin/env node
/**
 * V11-DOCTRINE-HYGIENE-001 — tarball-truth release blocker.
 *
 * Audits the contents of the @paths.design/caws-cli npm tarball for any
 * reference to commands that were removed in v11.0 and are not part of the
 * current v11.x or planned v11.2 surface. If any shipped file (README,
 * shipped templates under templates/hook-packs/**, anything else in
 * package.json `files:`) advertises or instructs a removed command, the
 * release is blocked.
 *
 * Background: in v10 → v11 cutover, the npm package shipped README and
 * scaffold content telling agents to use commands that no longer exist.
 * Agents reading the tarball then attempted those commands. This check
 * exists permanently so that the same drift cannot recur.
 *
 * Doctrine: docs/architecture/caws-vnext-command-surface.md §3 (Removed
 * in v11) and §6 invariants.
 *
 * Output:
 *   - Each shipped file scanned
 *   - Each match with file:line:matched-text
 *   - Total match count
 *
 * Exit:
 *   0 if no matches in shipped files.
 *   1 if any shipped file contains a removed-command reference.
 *   2 on composition failure (cannot run npm pack, cannot read files).
 *
 * Invocation:
 *   node scripts/check-removed-commands.mjs
 *
 * Run from the repo root.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI_PKG = join(REPO_ROOT, 'packages', 'caws-cli');

/**
 * Removed-command regex.
 *
 * Each name listed here was a v10.x command group or subcommand removed
 * in v11.0 and not part of the v11.1.x surface. If v11.2+ restores any
 * of these (e.g., `agents`), update the lookup AND the doctrine doc in
 * the same commit so that this script never lags reality.
 *
 * Word-boundary anchored to avoid false positives in URLs or identifiers.
 */
const REMOVED_COMMANDS = [
  'scaffold',
  'validate',
  'verify-acs',
  'provenance',
  'parallel',
  'session',
  'mode',
  'tutorial',
  'plan',
  'workflow',
  'quality-monitor',
  'diagnose',
  'evaluate',
  'iterate',
  'burnup',
  'archive',
  'sidecar',
  'quality-gates',
  'tool',
  'test-analysis',
  // Singular forms or otherwise removed:
  'waivers', // plural removed in slice 7a.4; current surface is `caws waiver`
];

/**
 * Some matches are legitimate negative-context references, e.g. a code
 * comment that says "v11 replaces `caws session briefing` with `caws
 * status`". Allow those by file:line if they exactly match an entry
 * here. Each allowlist entry must explain WHY.
 *
 * Keep this list short. The default posture is "no removed-command name
 * in shipped content"; allowlist entries are debt with a documented
 * reason.
 */
const ALLOWLIST = [
  // Hook-pack code comment explaining what the shell script replaces.
  // The reference is documentation of historical context inside a
  // managed-hook file, not an instruction to the agent.
  {
    file: 'templates/hook-packs/claude-code/session-caws-status.sh',
    needle: 'caws session briefing',
    reason: 'historical context inside a managed-hook code comment; not an instruction',
  },
  // README "Explicitly deferred to v11.3+" line names `caws session` and
  // `caws parallel` as the commands NOT planned to return. This is a
  // negative-context statement informing readers what is absent, not a
  // call to action.
  {
    file: 'README.md',
    needle: 'Explicitly deferred to v11.3+',
    reason: 'negative-context naming of deferred command groups; not an instruction',
  },
];

/**
 * Get the list of files that npm would actually ship in the tarball.
 * Uses `npm pack --dry-run --json` so we don't pollute the working tree.
 */
function getShippedFiles() {
  try {
    const out = execSync('npm pack --dry-run --json', {
      cwd: CLI_PKG,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('npm pack --dry-run returned no package entries');
    }
    const files = parsed[0]?.files;
    if (!Array.isArray(files)) {
      throw new Error('npm pack --dry-run output missing .files[]');
    }
    return files.map((f) => f.path);
  } catch (err) {
    console.error(`[check-removed-commands] composition failure: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Scan a single file for removed-command references. Returns an array of
 * { line, text, matched } records.
 *
 * Skips binary files (anything containing a NUL byte in the first 1KB)
 * silently.
 */
function scanFile(relPath) {
  const absPath = join(CLI_PKG, relPath);
  if (!existsSync(absPath)) return [];
  let buf;
  try {
    buf = readFileSync(absPath);
  } catch {
    return [];
  }
  // Binary heuristic
  const sniff = buf.subarray(0, 1024);
  for (let i = 0; i < sniff.length; i++) {
    if (sniff[i] === 0) return [];
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const cmd of REMOVED_COMMANDS) {
      // \bcaws\s+<cmd>\b — word-boundary, allow any whitespace between
      // "caws" and the command name.
      const re = new RegExp(`\\bcaws\\s+${cmd.replace(/[-]/g, '[-]')}\\b`);
      const m = line.match(re);
      if (m) {
        const allowed = ALLOWLIST.some(
          (a) => a.file === relPath && line.includes(a.needle)
        );
        if (allowed) continue;
        results.push({
          line: i + 1,
          text: line.trim(),
          matched: m[0],
        });
      }
    }
  }
  return results;
}

function main() {
  const shipped = getShippedFiles();
  console.log(`[check-removed-commands] scanning ${shipped.length} shipped files in @paths.design/caws-cli`);

  const findings = [];
  for (const relPath of shipped) {
    const hits = scanFile(relPath);
    for (const h of hits) {
      findings.push({ file: relPath, ...h });
    }
  }

  if (findings.length === 0) {
    console.log('[check-removed-commands] OK — no removed-command references in shipped files.');
    process.exit(0);
  }

  console.error('[check-removed-commands] BLOCKED — removed-command references found in shipped tarball content:');
  console.error('');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [matched: ${f.matched}]`);
    console.error(`    ${f.text}`);
  }
  console.error('');
  console.error(`Total: ${findings.length} reference(s) across ${new Set(findings.map((f) => f.file)).size} file(s).`);
  console.error('');
  console.error('Doctrine: docs/architecture/caws-vnext-command-surface.md §3 lists removed commands.');
  console.error('Fix: remove the reference, OR if v11.2+ restored the command, update REMOVED_COMMANDS in this script in the same commit as the doctrine update.');
  process.exit(1);
}

main();
