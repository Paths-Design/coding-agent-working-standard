'use strict';

/**
 * HANDOFF-EXPORT-IMPORT-001 contract tests.
 *
 * A1: export writes a metadata-only brief under .caws/handoffs/ carrying
 *     identity, work_state, claimed_paths, prior handoff events — no file
 *     contents, no turn transcripts.
 * A2: a secret-bearing claimed path (.env.production) is redacted to NAME
 *     ONLY with no content anywhere in the brief (Entry 24).
 * A3: import surfaces the brief and appends exactly ONE manual_pickup event
 *     (source from brief, receiving = importer); no claim/lease mutation.
 * A4: peer export (--session <other>) records the OPERATOR as the exporting
 *     authority; self-export by default.
 * A5: an npm-pack-style files-glob assertion — the brief lives under
 *     .caws/handoffs/, never user tmp/, and the package files glob does not
 *     match it (Entry 33).
 */

const fs = require('fs');
const path = require('path');

const {
  runHandoffExportCommand,
  runHandoffImportCommand,
} = require('../../dist/shell/commands/handoff');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

// package.json `files` glob (Entry 33: npm files ignore .gitignore — the brief
// must not match anything the package ships).
const PKG_FILES = ['templates/hook-packs/**'];

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const init = initProject(root);
  if (!init.ok) throw new Error('initProject failed');
  const cawsDir = path.join(root, '.caws');
  return { root, cawsDir };
}

function writeLease(cawsDir, sessionId, fields) {
  const dir = path.join(cawsDir, 'leases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ session_id: sessionId, platform: 'dsh', status: 'active', ...fields })
  );
}

function runExport(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runHandoffExportCommand({
    cwd: root,
    now: () => new Date('2026-08-26T05:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'author-sess' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runImport(root, file) {
  const out = [];
  const err = [];
  const code = runHandoffImportCommand({
    cwd: root,
    file,
    now: () => new Date('2026-08-26T06:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'receiver-sess' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function firstBriefPath(cawsDir) {
  const dir = path.join(cawsDir, 'handoffs');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  expect(files.length).toBeGreaterThan(0);
  return path.join(dir, files[0]);
}

describe('HANDOFF-EXPORT-IMPORT-001', () => {
  test('A1: export writes a metadata-only brief under .caws/handoffs/', () => {
    const { root, cawsDir } = mkRepo();
    writeLease(cawsDir, 'author-sess', {
      work_state: 'review_ready',
      claimed_paths: ['packages/foo'],
    });

    const r = runExport(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('exported handoff brief for author-sess');

    const briefPath = firstBriefPath(cawsDir);
    // .caws-scoped (never user tmp/, never package-shipped).
    expect(briefPath.startsWith(path.join(cawsDir, 'handoffs'))).toBe(true);
    const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    expect(brief.brief_version).toBe(1);
    expect(brief.source_session.session_id).toBe('author-sess');
    expect(brief.source_session.work_state).toBe('review_ready');
    expect(brief.source_session.claimed_paths).toEqual(['packages/foo']);
    expect(Array.isArray(brief.prior_handoffs)).toBe(true);
    expect(typeof brief.content_sha256).toBe('string');
    // METADATA-ONLY: no content/transcript keys by construction.
    expect(brief.turns).toBeUndefined();
    expect(brief.transcript).toBeUndefined();
    expect(brief.contents).toBeUndefined();
  });

  test('A2: a secret-bearing claimed path is redacted to NAME ONLY (Entry 24)', () => {
    const { root, cawsDir } = mkRepo();
    writeLease(cawsDir, 'author-sess', {
      claimed_paths: ['.env.production', 'packages/foo'],
    });

    const r = runExport(root);
    expect(r.code).toBe(0);
    const brief = JSON.parse(fs.readFileSync(firstBriefPath(cawsDir), 'utf8'));
    const envPath = brief.source_session.claimed_paths.find((p) => p.startsWith('.env.production'));
    expect(envPath).toContain('REDACTED');
    expect(envPath).not.toMatch(/API_KEY|SECRET|PASSWORD=\w/);
    // The non-secret path is NOT redacted.
    expect(brief.source_session.claimed_paths).toContain('packages/foo');
    // No file content anywhere in the brief (raw string scan).
    const raw = JSON.stringify(brief);
    expect(raw).not.toMatch(/API_KEY\s*=/);
  });

  test('A3: import surfaces the brief and appends exactly ONE manual_pickup', () => {
    const { root, cawsDir } = mkRepo();
    writeLease(cawsDir, 'author-sess', {
      work_state: 'review_ready',
      claimed_paths: ['packages/foo'],
    });
    expect(runExport(root).code).toBe(0);
    const briefPath = firstBriefPath(cawsDir);

    const r = runImport(root, briefPath);
    expect(r.code).toBe(0);
    expect(r.out).toContain('importing handoff brief for author-sess');
    expect(r.out).toContain('recorded manual_pickup');

    const loaded = loadEvents(cawsDir);
    expect(loaded.ok).toBe(true);
    const pickups = loaded.value.events.filter((e) => e.event === 'manual_pickup');
    expect(pickups).toHaveLength(1);
    expect(pickups[0].data.source_session).toBe('author-sess');
    expect(pickups[0].data.receiving_session).toBe('receiver-sess');

    // No claim/lease mutation: the source lease is byte-identical to what we wrote.
    const lease = JSON.parse(fs.readFileSync(path.join(cawsDir, 'leases', 'author-sess.json'), 'utf8'));
    expect(lease.claimed_paths).toEqual(['packages/foo']);
    expect(lease.session_id).toBe('author-sess');
  });

  test('A3: a malformed brief is refused with nothing appended', () => {
    const { root, cawsDir } = mkRepo();
    fs.mkdirSync(path.join(cawsDir, 'handoffs'), { recursive: true });
    const bad = path.join(cawsDir, 'handoffs', 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ no: 'source_session' }));

    const r = runImport(root, bad);
    expect(r.code).toBe(1);
    expect(r.err).toContain('malformed brief');
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  });

  test('A4: peer export records the OPERATOR as the exporting authority', () => {
    const { root, cawsDir } = mkRepo();
    writeLease(cawsDir, 'author-sess', { claimed_paths: ['packages/foo'] });
    writeLease(cawsDir, 'operator-sess', { claimed_paths: [] });

    // The OPERATOR (author-sess via env) exports a PEER's brief.
    const r = runExport(root, { session: 'operator-sess' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('exported by');
    expect(r.out).toContain('operator authority');
    const brief = JSON.parse(fs.readFileSync(firstBriefPath(cawsDir), 'utf8'));
    expect(brief.source_session.session_id).toBe('operator-sess');
    expect(brief.exported_by).toBe('author-sess');
  });

  test('A5: the brief path never matches the package files glob (Entry 33)', () => {
    const { root, cawsDir } = mkRepo();
    writeLease(cawsDir, 'author-sess', { claimed_paths: ['packages/foo'] });
    expect(runExport(root).code).toBe(0);
    const briefPath = firstBriefPath(cawsDir);
    const rel = path.relative(root, briefPath);
    // It lives under .caws/ (gitignored, provenance-adjacent) — never under
    // templates/hook-packs/ (what the package ships) nor user tmp/.
    expect(rel.startsWith('.caws/handoffs/')).toBe(true);
    expect(rel.startsWith('tmp/')).toBe(false);
    for (const glob of PKG_FILES) {
      const prefix = glob.replace(/\*\*$/, '');
      expect(rel.startsWith(prefix)).toBe(false);
    }
  });
});
