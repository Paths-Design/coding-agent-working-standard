'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { adoptLegacyProject } = require('../../dist/store/legacy-adoption');
const { runInitCommand } = require('../../dist/shell/commands/init');
const { DEFAULT_POLICY_YAML } = require('../../dist/store/init-store');
const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const source = '# Original requirements, including unsupported performance budgets\nid: OLD-1\n';
const draft = `id: OLD-1
title: Preserve the unfinished legacy work
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules: [legacy]
operational_rollback_slo: 5m
scope:
  in: [src/]
  out: []
invariants: [Preserve original obligations]
acceptance:
  - id: A1
    given: legacy work
    when: resumed
    then: the original acceptance criteria require verification
non_functional: {}
contracts: []
`;
let root, plan;
beforeEach(() => {
  root = makeTempRepo();
  fs.mkdirSync(path.join(root, '.caws'), { recursive: true });
  fs.writeFileSync(path.join(root, '.caws/working-spec.yaml'), source);
  plan = {
    version: 1,
    reason: 'Reviewed legacy bootstrap for system adoption',
    requirementNotes: [
      'Original performance budgets remain external obligations; this is not a waiver.',
    ],
    changes: [
      { path: '.caws/working-spec.yaml', beforeSha256: sha(source), contents: null },
      { path: '.caws/policy.yaml', beforeSha256: null, contents: DEFAULT_POLICY_YAML },
      { path: '.caws/specs/OLD-1.yaml', beforeSha256: null, contents: draft },
    ],
  };
});
afterAll(cleanupAll);
function unchanged() {
  expect(fs.readFileSync(path.join(root, '.caws/working-spec.yaml'), 'utf8')).toBe(source);
  expect(fs.existsSync(path.join(root, '.caws/legacy'))).toBe(false);
  expect(fs.existsSync(path.join(root, '.caws/policy.yaml'))).toBe(false);
}
test('preview is pure; apply archives exact originals and creates only reviewed draft authority', () => {
  const preview = adoptLegacyProject(root, plan, false);
  unchanged();
  const applied = adoptLegacyProject(root, plan, true);
  expect(applied.archive).toBe(preview.archive);
  expect(fs.readFileSync(path.join(root, applied.archive, 'working-spec.yaml'), 'utf8')).toBe(
    source
  );
  expect(fs.existsSync(path.join(root, '.caws/working-spec.yaml'))).toBe(false);
  expect(fs.readFileSync(path.join(root, '.caws/specs/OLD-1.yaml'), 'utf8')).toBe(draft);
  expect(fs.readFileSync(path.join(root, '.caws/policy.yaml'), 'utf8')).toBe(DEFAULT_POLICY_YAML);
  expect(fs.existsSync(path.join(root, '.git/caws-legacy-adoption.lock'))).toBe(false);
});
test('a stale later input refuses before archiving or removing the singleton', () => {
  plan.changes[2].beforeSha256 = sha('foreign content');
  expect(() => adoptLegacyProject(root, plan, true)).toThrow('Stale migration input');
  unchanged();
});
test.each(['../outside', '.caws/events.jsonl', '.caws/specs/../../outside'])(
  'refuses non-migration target %s without writes',
  (target) => {
    plan.changes[2].path = target;
    expect(() => adoptLegacyProject(root, plan, true)).toThrow('migration path');
    unchanged();
  }
);
test('refuses symlinked archives before changing source', () => {
  fs.symlinkSync(root, path.join(root, '.caws/legacy'), 'dir');
  expect(() => adoptLegacyProject(root, plan, true)).toThrow(/symlink/i);
  expect(fs.readFileSync(path.join(root, '.caws/working-spec.yaml'), 'utf8')).toBe(source);
});
test('refuses granting active authority or fabricated closure evidence', () => {
  plan.changes[2].contents = draft.replace('lifecycle_state: draft', 'lifecycle_state: active');
  expect(() => adoptLegacyProject(root, plan, true)).toThrow('valid unbound draft');
  unchanged();
});
test('requires all legacy specs to be reviewed', () => {
  fs.mkdirSync(path.join(root, '.caws/specs'));
  fs.writeFileSync(path.join(root, '.caws/specs/FOREIGN-1.yaml'), source);
  expect(() => adoptLegacyProject(root, plan, true)).toThrow('Unreviewed legacy spec');
  unchanged();
});
test('cannot replace a modern policy through the legacy adoption escape', () => {
  fs.writeFileSync(path.join(root, '.caws/policy.yaml'), DEFAULT_POLICY_YAML);
  plan.changes[1].beforeSha256 = sha(DEFAULT_POLICY_YAML);
  expect(() => adoptLegacyProject(root, plan, true)).toThrow('Existing modern policy');
  expect(fs.existsSync(path.join(root, '.caws/legacy'))).toBe(false);
});
test('concurrent adoption lock refuses without a partial conversion', () => {
  fs.writeFileSync(path.join(root, '.git/caws-legacy-adoption.lock'), 'foreign owner');
  expect(() => adoptLegacyProject(root, plan, true)).toThrow();
  unchanged();
  expect(fs.readFileSync(path.join(root, '.git/caws-legacy-adoption.lock'), 'utf8')).toBe(
    'foreign owner'
  );
});
test('CLI previews by default and requires explicit apply; incompatible options refuse', () => {
  const fromFile = path.join(root, 'review.json');
  fs.writeFileSync(fromFile, JSON.stringify(plan));
  const invoke = (opts) =>
    runInitCommand({
      cwd: root,
      action: 'migrate',
      fromFile,
      out: () => {},
      err: () => {},
      ...opts,
    });
  expect(invoke({})).toBe(0);
  unchanged();
  expect(invoke({ actionArg: 'apply', plan: true })).toBe(2);
  unchanged();
  expect(invoke({ actionArg: 'apply' })).toBe(0);
  expect(fs.existsSync(path.join(root, '.caws/working-spec.yaml'))).toBe(false);
});

test.each(['2000-01-01', '2000-01-01T00:00:00Z'])('archives expired legacy waiver %s without granting a replacement', expires => {
  fs.mkdirSync(path.join(root, '.caws/waivers'));
  const original = `id: OLD-WAIVER\nstatus: active\nexpires_at: ${expires}\n`;
  fs.writeFileSync(path.join(root, '.caws/waivers/OLD-WAIVER.yaml'), original);
  plan.changes.push({ path: '.caws/waivers/OLD-WAIVER.yaml', beforeSha256: sha(original), contents: null });
  const result = adoptLegacyProject(root, plan, true);
  expect(fs.readFileSync(path.join(root, result.archive, 'waivers/OLD-WAIVER.yaml'), 'utf8')).toBe(original);
  expect(fs.existsSync(path.join(root, '.caws/waivers/OLD-WAIVER.yaml'))).toBe(false);
});
test.each(['2999-01-01', 'unknown', '2000-02-31'])('refuses unexpired or ambiguous legacy waiver %s before any writes', expires => {
  fs.mkdirSync(path.join(root, '.caws/waivers'));
  const original = `id: OLD-WAIVER\nstatus: active\nexpires_at: ${expires}\n`;
  fs.writeFileSync(path.join(root, '.caws/waivers/OLD-WAIVER.yaml'), original);
  plan.changes.push({ path: '.caws/waivers/OLD-WAIVER.yaml', beforeSha256: sha(original), contents: null });
  expect(() => adoptLegacyProject(root, plan, true)).toThrow('provably expired or revoked');
  unchanged();
});

test('a legacy aggregate containing one future waiver cannot be archived', () => {
  fs.mkdirSync(path.join(root, '.caws/waivers'));
  const original = 'waivers:\n  old: {expires_at: 2000-01-01}\n  live: {expires_at: 2999-01-01}\n';
  fs.writeFileSync(path.join(root, '.caws/waivers/active-waivers.yaml'), original);
  plan.changes.push({ path: '.caws/waivers/active-waivers.yaml', beforeSha256: sha(original), contents: null });
  expect(() => adoptLegacyProject(root, plan, true)).toThrow('provably expired or revoked');
  unchanged();
});
