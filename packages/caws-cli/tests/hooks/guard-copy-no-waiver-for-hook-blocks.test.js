'use strict';

/**
 * Copy shown to a blocked agent must name a remedy that clears the block.
 * `caws waiver` only filters `caws gates run` violations and never lifts a hook
 * guard; a hook handler is lifted by a human-granted `caws reprieve grant`.
 * CAWS-DEFECT-GUARD-COPY-OFFERS-WAIVER-FOR-HOOK-BLOCKS-01.
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const PACKS = path.join(PKG_ROOT, 'templates', 'hook-packs');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

/** The sentence block that tells an agent what to do when a hook blocks it. */
function hookBlockGuidance(text) {
  const start = text.indexOf('If a\nhook blocks work you believe is legitimate');
  const from = start === -1 ? text.indexOf('hook blocks work you believe is legitimate') : start;
  expect(from).toBeGreaterThan(-1);
  const end = text.indexOf('Do not defang the guard.', from);
  expect(end).toBeGreaterThan(from);
  return text.slice(from, end + 'Do not defang the guard.'.length);
}

describe.each([
  ['kimi-code/AGENTS.md', path.join(PACKS, 'kimi-code', 'AGENTS.md')],
  ['qwen-code/CAWS-HOOKS.md', path.join(PACKS, 'qwen-code', 'CAWS-HOOKS.md')],
])('%s hook-block guidance', (_name, file) => {
  const guidance = hookBlockGuidance(read(file));

  test('does not offer creating a waiver for a hook block', () => {
    expect(guidance).not.toMatch(/waiver create/);
    expect(guidance).not.toMatch(/create a waiver/);
  });

  test('names the human-granted reprieve and says a waiver does not lift a hook', () => {
    expect(guidance).toContain('caws reprieve grant --handlers <handler>');
    expect(guidance).toContain('agents cannot grant their own');
    expect(guidance).toMatch(/only filters\s+`caws gates run` and never lifts a hook/);
  });
});

describe('repo CLAUDE.md "Governed paths"', () => {
  const claude = read(path.join(REPO_ROOT, 'CLAUDE.md'));
  const start = claude.indexOf('## Governed paths');
  const end = claude.indexOf('## Spec authoring', start);
  const section = claude.slice(start, end);

  test('the section exists and is bounded', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  test('does not present caws waiver create as an escape', () => {
    expect(section).not.toMatch(/Legitimate escape/);
    expect(section).not.toMatch(/caws waiver create/);
  });

  test('names what lifts each block: reprieve for a hook, a spec for policy.yaml, nothing for --no-verify', () => {
    expect(section).toMatch(/hook handler's refusal[\s\S]*`caws reprieve grant`, run by a human/);
    expect(section).toMatch(/`\.caws\/policy\.yaml` change: an Edit under an active spec/);
    expect(section).toMatch(/`--no-verify` on a pre-commit hook: nothing/);
  });
});
