'use strict';

/**
 * MULTI-AGENT-HANDOFF-EVENT-001 handoff trigger contract tests.
 *
 * A3: `caws working-tree ack` appends an overlap_ack_proceed event (asserted in
 *     working-tree-check.test.js; not duplicated here).
 * A4: `caws session pickup --from <id> --paths <p> [--reason]` appends exactly
 *     one manual_pickup event to the hash-chained audit log; malformed
 *     invocations are refused before any append.
 * A5: handoff events are filterable by type via the events log (chain order
 *     preserved; each event joinable to its sessions).
 */

const fs = require('fs');
const path = require('path');

const { runSessionPickupCommand } = require('../../dist/shell/commands/session');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { verifyChain } = require('../../dist/kernel');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const init = initProject(root);
  if (!init.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function runPickup(root, opts) {
  const out = [];
  const err = [];
  const code = runSessionPickupCommand({
    cwd: root,
    now: () => new Date('2026-08-25T12:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'receiver-sess' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('MULTI-AGENT-HANDOFF-EVENT-001 triggers', () => {
  test('A4: session pickup appends exactly one chain-valid manual_pickup event', () => {
    const { root, cawsDir } = mkRepo();
    const r = runPickup(root, {
      fromSessionId: 'author-sess',
      paths: ['packages/baz/**'],
      reason: 'user-authorized handoff',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('recorded manual_pickup');

    const loaded = loadEvents(cawsDir);
    expect(loaded.ok).toBe(true);
    const events = loaded.value.events;
    // Chain integrity holds with the new event type.
    const verified = verifyChain(events);
    expect(verified.ok).toBe(true);

    const pickups = events.filter((e) => e.event === 'manual_pickup');
    expect(pickups).toHaveLength(1);
    expect(pickups[0].data.source_session).toBe('author-sess');
    expect(pickups[0].data.paths).toEqual(['packages/baz/**']);
    expect(pickups[0].data.reason).toBe('user-authorized handoff');
  });

  test('A4: pickup refuses missing --from or --paths before any append', () => {
    const { root, cawsDir } = mkRepo();
    const noFrom = runPickup(root, { fromSessionId: '', paths: ['x'] });
    expect(noFrom.code).toBe(1);
    expect(noFrom.err).toContain('--from <session-id> is required');

    const noPaths = runPickup(root, { fromSessionId: 'author-sess', paths: [] });
    expect(noPaths.code).toBe(1);
    expect(noPaths.err).toContain('at least one --paths');

    // Refusals append nothing.
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  });
});
