/**
 * Regression tests for docs/guides/worktree-isolation.md.
 *
 * CAWS-FIRST-CONTACT-UX-001 A5: the worktree-isolation guide must
 * document the workspace package-manager (pnpm/yarn/npm workspaces)
 * node_modules visibility constraint, with two named recovery
 * patterns. Without this section, first-contact users on workspace
 * projects (the typical full-stack-ds / monorepo case) hit a confusing
 * `pnpm test` failure on their first worktree slice and have no
 * documentation pointer.
 *
 * Tests assert the doc's structure, not its prose verbatim, so a
 * future doc rewrite can adjust wording without breaking the test
 * as long as the substance is preserved.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GUIDE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'guides',
  'worktree-isolation.md'
);

describe('docs/guides/worktree-isolation.md — workspace package managers section', () => {
  let body;
  beforeAll(() => {
    body = fs.readFileSync(GUIDE_PATH, 'utf8');
  });

  it('has a section heading naming workspace package managers', () => {
    // Match the section header substantively — allow rewording of the
    // exact phrasing as long as the section is discoverable.
    expect(body).toMatch(/##\s+Workspace package managers/i);
  });

  it('names pnpm, yarn workspaces, and npm workspaces explicitly', () => {
    expect(body).toMatch(/pnpm/);
    expect(body).toMatch(/yarn workspaces/i);
    expect(body).toMatch(/npm workspaces/i);
  });

  it('explains that node_modules is NOT shared into linked worktrees', () => {
    // The crucial fact the user must learn before their first slice.
    expect(body).toMatch(/do NOT share `?node_modules`?|node_modules\/?.+do[ ]?n['o]t share|share.+node_modules/i);
  });

  it('names two recovery options: root-filter and in-worktree install', () => {
    // Option A: -F / --filter / workspace from repo root
    expect(body).toMatch(/(pnpm|npm|yarn|turbo).+(-F|--filter|workspace)/);
    // Option B: install inside the worktree
    expect(body).toMatch(/(pnpm|npm|yarn)\s+install/);
  });

  it('locates the new section between Merging and Filesystem layout', () => {
    const mergingIdx = body.indexOf('## Merging work back');
    const fsLayoutIdx = body.indexOf('## Filesystem layout');
    const workspaceIdx = body.search(/##\s+Workspace package managers/i);
    expect(mergingIdx).toBeGreaterThan(-1);
    expect(fsLayoutIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(mergingIdx);
    expect(workspaceIdx).toBeLessThan(fsLayoutIdx);
  });
});
