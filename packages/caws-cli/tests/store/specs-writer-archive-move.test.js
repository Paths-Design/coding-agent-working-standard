'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { archiveSpec, recoverArchivedSpec } = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { runSpecsPruneArchiveCommand } = require('../../dist/shell/commands/specs');

const ACTOR = { kind: 'agent', id: 'jest', platform: 'jest' };

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return { root, caws: path.join(root, '.caws') };
}

function writeClosedSpec(cawsDir, id) {
  const body = `id: ${id}
title: 'Archive move fixture'
risk_tier: 3
mode: chore
lifecycle_state: closed
resolution: completed
created_at: '2026-06-18T00:00:00.000Z'
updated_at: '2026-06-18T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', message]);
}

function latestSpecArchived(cawsDir, id) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) throw new Error('loadEvents failed: ' + JSON.stringify(loaded.errors));
  return [...loaded.value.events]
    .reverse()
    .find((event) => event.event === 'spec_archived' && event.spec_id === id);
}

describe('archiveSpec move semantics', () => {
  test('moves a tracked closed spec into a trackable .archive body', () => {
    const { root, caws } = mkRepo('archive-move-tracked-');
    const id = 'ARCHIVE-MOVE-001';
    const fromRel = `.caws/specs/${id}.yaml`;
    const toRel = `.caws/specs/.archive/${id}.yaml`;
    writeClosedSpec(caws, id);
    commitAll(root, 'add closed spec');

    const result = archiveSpec(caws, {
      id,
      actor: ACTOR,
      now: () => new Date('2026-06-18T01:02:03.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.path).toBe(path.join(root, toRel));
    expect(fs.existsSync(path.join(root, fromRel))).toBe(false);
    expect(fs.existsSync(path.join(root, toRel))).toBe(true);
    expect(fs.readFileSync(path.join(root, toRel), 'utf8')).toContain(
      'lifecycle_state: archived'
    );
    expect(git(root, ['ls-files', '--', toRel]).trim()).toBe(toRel);
    expect(git(root, ['ls-tree', '--name-only', 'HEAD', '--', fromRel]).trim()).toBe('');

    const event = latestSpecArchived(caws, id);
    expect(event.data).toEqual({ from_path: fromRel, to_path: toRel });

    const recovered = recoverArchivedSpec(caws, id);
    expect(recovered.ok).toBe(true);
    expect(recovered.value.source).toContain('lifecycle_state: archived');
  });

  test('leaves a gitignored archive destination unstaged and tells the caller what happened', () => {
    const { root, caws } = mkRepo('archive-move-ignored-');
    const id = 'ARCHIVE-MOVE-002';
    const fromRel = `.caws/specs/${id}.yaml`;
    const toRel = `.caws/specs/.archive/${id}.yaml`;
    writeClosedSpec(caws, id);
    commitAll(root, 'add closed spec');
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.caws/specs/.archive/\n');

    const result = archiveSpec(caws, {
      id,
      actor: ACTOR,
      now: () => new Date('2026-06-18T01:02:03.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(fs.existsSync(path.join(root, fromRel))).toBe(false);
    expect(fs.existsSync(path.join(root, toRel))).toBe(true);
    expect(git(root, ['ls-files', '--', toRel]).trim()).toBe('');
    expect(git(root, ['ls-tree', '--name-only', 'HEAD', '--', fromRel]).trim()).toBe('');
    expect(result.value.warnings).toEqual([
      expect.stringContaining(`${toRel} is ignored by git`),
    ]);

    const event = latestSpecArchived(caws, id);
    expect(event.data).toEqual({ from_path: fromRel, to_path: toRel });
  });

  test('refuses when the archive destination already exists', () => {
    const { root, caws } = mkRepo('archive-move-collision-');
    const id = 'ARCHIVE-MOVE-003';
    const fromPath = path.join(caws, 'specs', `${id}.yaml`);
    const toPath = path.join(caws, 'specs', '.archive', `${id}.yaml`);
    writeClosedSpec(caws, id);
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.writeFileSync(toPath, 'already archived\n');
    commitAll(root, 'add colliding archive fixture');

    const result = archiveSpec(caws, { id, actor: ACTOR });

    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.rule)).toContain('store.lifecycle.plan_rejected');
    expect(fs.existsSync(fromPath)).toBe(true);
    expect(fs.readFileSync(toPath, 'utf8')).toBe('already archived\n');
  });

  test('prune-archive compatibility command does not remove archive bodies', () => {
    const { root, caws } = mkRepo('archive-move-prune-noop-');
    const id = 'ARCHIVE-MOVE-004';
    const toPath = path.join(caws, 'specs', '.archive', `${id}.yaml`);
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.writeFileSync(toPath, 'canonical archive body\n');

    const lines = [];
    const code = runSpecsPruneArchiveCommand({
      cwd: root,
      apply: true,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(fs.readFileSync(toPath, 'utf8')).toBe('canonical archive body\n');
    expect(lines.join('\n')).toContain('no-op');
    expect(lines.join('\n')).toContain('caws specs archive --status closed');
    expect(lines.join('\n')).toContain('caws specs restore <id> --as draft');
    expect(lines.join('\n')).toContain('caws specs recover <id> --out <path>');
  });
});
