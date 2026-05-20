/**
 * @fileoverview Regression tests for ERROR-HANDLER-V11-SURFACE-001.
 *
 * Asserts that no suggestion produced by the error-handler module references
 * a command removed in v11.0 (and not part of the v11.1 or planned v11.2
 * surface). The published @paths.design/caws-cli must not tell users to run
 * commands that don't exist.
 *
 * If this test fails, it means a regression has reintroduced a removed-command
 * reference. Either:
 *   (a) remove the offending suggestion, OR
 *   (b) if v11.2+ restored the command, update V11_COMMANDS in
 *       packages/caws-cli/src/error-handler.js AND
 *       scripts/check-removed-commands.mjs in the same commit as the
 *       doctrine update in docs/architecture/caws-vnext-command-surface.md.
 */

const {
  COMMAND_SUGGESTIONS,
  TROUBLESHOOTING_GUIDES,
  getRecoverySuggestions,
  getDocumentationLink,
  suggestTroubleshootingGuide,
} = require('../src/error-handler');

// Mirror of scripts/check-removed-commands.mjs REMOVED_COMMANDS.
// Keep these in sync — any change here implies a change there.
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
  'waivers', // singular `waiver` is the v11 surface
];

const removedCommandRegex = new RegExp(
  `\\bcaws\\s+(${REMOVED_COMMANDS.map((c) => c.replace(/-/g, '[-]')).join('|')})\\b`
);

function expectNoRemovedCommandRefs(strings, label) {
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    const m = s.match(removedCommandRegex);
    if (m) {
      throw new Error(
        `${label} suggestion references removed v10 command "${m[1]}": "${s}"`
      );
    }
  }
}

describe('ERROR-HANDLER-V11-SURFACE-001 — v11 surface compliance', () => {
  describe('COMMAND_SUGGESTIONS', () => {
    test('unknown option suggestions contain no removed v10 commands', () => {
      const suggestions = COMMAND_SUGGESTIONS['unknown option']('--bogus', 'doctor');
      expectNoRemovedCommandRefs(suggestions, 'unknown-option');
    });

    test('unknown option suggestions for known v11 flags contain no removed v10 commands', () => {
      for (const opt of ['--help', '--json', '--made-up']) {
        const suggestions = COMMAND_SUGGESTIONS['unknown option'](opt, 'gates');
        expectNoRemovedCommandRefs(suggestions, `unknown-option(${opt})`);
      }
    });

    test('unknown command suggestions contain no removed v10 commands', () => {
      // Exercise a few representative inputs covering each "category" branch
      // in the suggester.
      const cases = ['frobnicate', 'setup', 'create', 'check', 'list', 'evidence-record'];
      for (const c of cases) {
        const suggestions = COMMAND_SUGGESTIONS['unknown command'](c);
        expectNoRemovedCommandRefs(suggestions, `unknown-command(${c})`);
      }
    });

    test('unknown command suggester only proposes v11 commands as "did you mean"', () => {
      // Levenshtein-close to several v11 commands; should suggest one of them,
      // and that one must be in the v11 surface.
      const v11Commands = new Set([
        'init', 'doctor', 'status', 'scope', 'claim',
        'gates', 'evidence', 'waiver', 'specs', 'worktree',
      ]);
      const suggestions = COMMAND_SUGGESTIONS['unknown command']('doctr');
      const didYouMean = suggestions.find((s) => s.startsWith('Did you mean:'));
      if (didYouMean) {
        const match = didYouMean.match(/Did you mean: caws (\S+)\?/);
        expect(match).toBeTruthy();
        expect(v11Commands.has(match[1])).toBe(true);
      }
    });

    test('not-a-caws-project suggestions reference v11 init only', () => {
      const suggestions = COMMAND_SUGGESTIONS['not a caws project']();
      expectNoRemovedCommandRefs(suggestions, 'not-a-caws-project');
      // Sanity: must mention caws init as the bootstrap path
      expect(suggestions.some((s) => /\bcaws\s+init\b/.test(s))).toBe(true);
    });
  });

  describe('TROUBLESHOOTING_GUIDES', () => {
    test('every guide has no removed v10 commands in solutions or commands', () => {
      for (const [key, guide] of Object.entries(TROUBLESHOOTING_GUIDES)) {
        expectNoRemovedCommandRefs(guide.solutions || [], `guide[${key}].solutions`);
        expectNoRemovedCommandRefs(guide.commands || [], `guide[${key}].commands`);
      }
    });

    test('the removed working-spec-validation key is gone; spec-validation is the v11 key', () => {
      expect(TROUBLESHOOTING_GUIDES).not.toHaveProperty('working-spec-validation');
      expect(TROUBLESHOOTING_GUIDES).toHaveProperty('spec-validation');
    });
  });

  describe('getRecoverySuggestions', () => {
    test('VALIDATION category suggestions reference v11 commands only', () => {
      const err = new Error('spec failed validation');
      err.category = 'validation';
      const suggestions = getRecoverySuggestions(err, 'validation');
      expectNoRemovedCommandRefs(suggestions, 'recovery.validation');
      expect(suggestions.some((s) => /\bcaws\s+(doctor|gates)\b/.test(s))).toBe(true);
    });

    test('CONFIGURATION category suggestions reference v11 commands only', () => {
      const err = new Error('config error');
      err.category = 'configuration';
      const suggestions = getRecoverySuggestions(err, 'configuration');
      expectNoRemovedCommandRefs(suggestions, 'recovery.configuration');
      expect(suggestions.some((s) => /\bcaws\s+(init|doctor)\b/.test(s))).toBe(true);
    });
  });

  describe('getDocumentationLink', () => {
    test('commandLinks only contain v11 command keys', () => {
      const v11 = ['init', 'doctor', 'status', 'scope', 'claim', 'gates', 'evidence', 'waiver', 'specs', 'worktree'];
      // Each v11 command resolves to a real-looking URL (doctrine doc)
      for (const cmd of v11) {
        const url = getDocumentationLink('default', { command: cmd });
        expect(url).toMatch(/caws-vnext-command-surface\.md$|coding-agent-working-standard/);
      }
      // Removed commands fall through to the category default (no specific page)
      for (const removed of REMOVED_COMMANDS) {
        const url = getDocumentationLink('default', { command: removed });
        // Should NOT return a page named after the removed command
        expect(url).not.toMatch(new RegExp(`#${removed.replace(/-/g, '[-]')}\\b`));
      }
    });
  });

  describe('suggestTroubleshootingGuide', () => {
    test('routes "spec validation" messages to the v11 spec-validation guide', () => {
      expect(suggestTroubleshootingGuide('spec failed validation')).toBe('spec-validation');
      expect(suggestTroubleshootingGuide('schema error in .caws/specs/FOO.yaml')).toBe(
        'spec-validation'
      );
    });
  });
});
