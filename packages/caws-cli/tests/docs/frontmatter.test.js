'use strict';

// CAWS-DOCS-FRONTMATTER-VALIDATOR-001 — docs front-matter validator.
//
// The validator is an ESM script (.mjs) and the CJS jest suite cannot
// dynamic-import it (no --experimental-vm-modules). So this test drives the
// REAL binary as a subprocess — stronger than importing functions: it exercises
// argv parsing, exit codes, and the --json report exactly as CI will.
//
// Coverage:
//   A1  a strict-set doc with a missing field / bad enum FAILS (exit 1).
//   A2  a doc outside the strict set with no front-matter is a WARNING (exit 0).
//   A3  the real shipped strict set is clean (exit 0).
//   A4  the --all toggle promotes every doc into the strict set (same data,
//       different mode) — the previously-lenient doc now fails.
//   plus: fail-closed on malformed YAML; superseded-without-superseded_by.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const VALIDATOR = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'scripts',
  'validate-docs.mjs'
);

function runCli(args) {
  const r = spawnSync('node', [VALIDATOR, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = null;
    }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const FM = (fields) =>
  '---\n' +
  Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n') +
  '\n---\n\n# Body\n';

const VALID = {
  doc_id: 'x',
  authority: 'reference',
  status: 'active',
  title: 'X',
  owner: 'me',
  updated: '2026-06-02',
  audience: 'consumer',
};

describe('validate-docs.mjs (subprocess)', () => {
  let docsDir;

  beforeEach(() => {
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-docs-fm-'));
    fs.mkdirSync(path.join(docsDir, 'guides'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(docsDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  const write = (rel, content) => {
    const abs = path.join(docsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  it('A3: a strict-set doc with full valid front-matter passes (exit 0)', () => {
    write('guides/good.md', FM({ ...VALID, doc_id: 'good' }));
    const r = runCli(['--docs-dir', docsDir, '--strict', 'guides/good.md', '--json']);
    expect(r.status).toBe(0);
    expect(r.json.violations).toEqual([]);
  });

  it('A1: a strict-set doc missing a required field FAILS (exit 1, names file+field)', () => {
    const { title, ...rest } = VALID;
    write('guides/bad.md', FM({ ...rest, doc_id: 'bad' }));
    const r = runCli(['--docs-dir', docsDir, '--strict', 'guides/bad.md', '--json']);
    expect(r.status).toBe(1);
    expect(r.json.violations).toHaveLength(1);
    expect(r.json.violations[0].file).toBe('guides/bad.md');
    expect(r.json.violations[0].messages.join(' ')).toMatch(/missing required field: title/);
  });

  it('A1: an invalid authority enum FAILS (exit 1)', () => {
    write('guides/e.md', FM({ ...VALID, doc_id: 'e', authority: 'bogus' }));
    const r = runCli(['--docs-dir', docsDir, '--strict', 'guides/e.md', '--json']);
    expect(r.status).toBe(1);
    // Assert on the structured message, not the JSON-escaped string, so the
    // quotes around "bogus" aren't backslash-escaped by JSON.stringify.
    expect(r.json.violations[0].messages.join(' ')).toMatch(/invalid authority "bogus"/);
  });

  it('A2: a doc OUTSIDE the strict set with no front-matter is a WARNING, not a failure (exit 0)', () => {
    write('internal/notes.md', '# maintainer notes, no front-matter\n');
    write('guides/good.md', FM({ ...VALID, doc_id: 'good' }));
    const r = runCli(['--docs-dir', docsDir, '--strict', 'guides/good.md', '--json']);
    expect(r.status).toBe(0); // the bare doc did NOT fail the run
    expect(r.json.violations).toEqual([]);
    expect(r.json.warnings.map((w) => w.file)).toContain('internal/notes.md');
  });

  it('A4: the --all toggle promotes EVERY doc into the strict set (data, not logic)', () => {
    write('internal/notes.md', '# no front-matter\n');
    write('guides/good.md', FM({ ...VALID, doc_id: 'good' }));

    const lenient = runCli(['--docs-dir', docsDir, '--strict', 'guides/good.md', '--json']);
    expect(lenient.status).toBe(0);
    expect(lenient.json.violations).toEqual([]);

    const strictAll = runCli(['--docs-dir', docsDir, '--all', '--json']);
    expect(strictAll.status).toBe(1);
    const failed = strictAll.json.violations.map((v) => v.file);
    expect(failed).toContain('internal/notes.md');
    expect(failed).not.toContain('guides/good.md'); // good.md valid even under --all
  });

  it('audience is required under strict, lenient otherwise', () => {
    const { audience, ...noAud } = VALID;
    write('guides/g.md', FM({ ...noAud, doc_id: 'g' }));
    // strict on g.md → audience missing → fail
    const strict = runCli(['--docs-dir', docsDir, '--strict', 'guides/g.md', '--json']);
    expect(strict.status).toBe(1);
    expect(JSON.stringify(strict.json.violations)).toMatch(/missing required field: audience/);
    // not in strict set → only a warning, and since the rest is valid, NO
    // warning messages about audience (audience is not required when lenient).
    const lenient = runCli(['--docs-dir', docsDir, '--strict', 'guides/other.md', '--json']);
    expect(lenient.status).toBe(0);
    const gWarn = lenient.json.warnings.find((w) => w.file === 'guides/g.md');
    expect(gWarn).toBeUndefined(); // fully valid sans audience → no warning at all
  });

  it('superseded without superseded_by FAILS in strict mode', () => {
    write('guides/s.md', FM({ ...VALID, doc_id: 's', status: 'superseded' }));
    const r = runCli(['--docs-dir', docsDir, '--strict', 'guides/s.md', '--json']);
    expect(r.status).toBe(1);
    expect(JSON.stringify(r.json.violations)).toMatch(/superseded.*requires.*superseded_by/);
  });

  it('FAIL CLOSED: malformed front-matter YAML in a strict doc is a violation, not a skip', () => {
    write('guides/m.md', '---\ndoc_id: x\n  : : :\nbad indent\n---\n\n# Body\n');
    const r = runCli(['--docs-dir', docsDir, '--strict', 'guides/m.md', '--json']);
    expect(r.status).toBe(1);
    expect(JSON.stringify(r.json.violations)).toMatch(/unparseable|non-object/);
  });
});

describe('the real docs/ strict set is clean (A3 against shipped docs)', () => {
  it('the shipped strict set passes (exit 0) and is non-empty', () => {
    const r = runCli(['--json']);
    if (r.status !== 0) {
      const detail = (r.json?.violations || [])
        .map((v) => `${v.file}: ${v.messages.join('; ')}`)
        .join('\n  ');
      throw new Error(`strict-set docs have front-matter violations:\n  ${detail}`);
    }
    expect(r.status).toBe(0);
    expect(r.json.strictCount).toBeGreaterThanOrEqual(6);
  });
});
