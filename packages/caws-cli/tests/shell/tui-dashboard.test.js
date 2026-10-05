'use strict';

/**
 * Contract tests for CAWS-TUI-DASHBOARD-001 — `caws tui`, the read-only
 * full-screen terminal dashboard.
 *
 * What each test pins:
 *
 *   - ONE-SHOT (A1): `caws tui --once` renders all six panel sections to a
 *     non-TTY stdout and exits 0.
 *   - SELECTOR PARITY (A2, the panel-selectors behavior contract): the
 *     compiled `caws status --json` panels and the TUI's assembled payload
 *     are field-for-field identical for the same fixture state — panel data
 *     has a single source (shell/panel-data.ts), not parallel derivations.
 *   - READ-ONLY (A3, the tui-readonly behavior contract): running the TUI
 *     twice leaves every byte of the fixture's `.caws/` governance tree
 *     identical — the status-is-observability invariant extends to the TUI.
 *   - NON-TTY FALLBACK (A4): a non-TTY `caws tui` without --once prints a
 *     typed guidance notice on stderr, still emits a one-shot frame on
 *     stdout, and exits 0 (honest fallback, not escape-code soup).
 *   - REFRESH LOOP (A5): with injected timers, the session repaints at the
 *     configured interval and classifies q / Ctrl-C as exit.
 *   - REGISTRATION (A6): `caws --help` lists tui (surface registration
 *     integrity).
 *
 * Environment discipline: spawned runs and in-process calls receive the
 * SAME minimal env, so self-session resolution (and therefore
 * agents.self_session_id) is identical on both sides of the parity test
 * regardless of the machine running the suite.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const { initProject } = require('../../dist/store/init-store');
const { runStatusCommand } = require('../../dist/shell/commands/status');
const { gatherDashboardState, buildStatusPanelPayload } = require('../../dist/shell/panel-data');
const { startDashboardSession, ALT_SCREEN_EXIT } = require('../../dist/shell/tui/screen');
const { renderFrame } = require('../../dist/shell/tui/frame');
const { buildDashboardModel } = require('../../dist/shell/tui/panels');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '../../dist/index.js');
// Minimal, identical env for both sides of every comparison: no
// DSH_SESSION_ID / CLAUDE_SESSION_ID → no self identity → deterministic.
const ENV = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' };
const NOW = () => new Date('2026-07-04T00:00:00.000Z');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, lifecycleState, opts = {}) {
  const worktree = opts.worktree !== undefined ? `worktree: ${opts.worktree}\n` : '';
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
${worktree}created_at: '2026-06-01T00:00:00.000Z'
updated_at: '2026-07-03T00:00:00.000Z'
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

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

/** Deterministic multi-panel fixture: active spec bound to a (ghost) lane,
 *  a draft, a closed one, plus the registry entry. */
function mkRichRepo() {
  const { root, caws } = mkRepo();
  writeSpec(caws, 'TUI-GOLD-ACTIVE-001', 'active', { worktree: 'wt-gold' });
  writeSpec(caws, 'TUI-GOLD-DRAFT-001', 'draft');
  writeSpec(caws, 'TUI-GOLD-CLOSED-001', 'closed');
  writeRegistry(caws, {
    'wt-gold': {
      specId: 'TUI-GOLD-ACTIVE-001',
      branch: 'wt-gold',
      baseBranch: 'main',
      path: path.join(caws, 'worktrees', 'wt-gold'),
    },
  });
  return { root, caws };
}

function runCli(args, cwd) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    env: ENV,
    encoding: 'utf8',
  });
  return stdout;
}

function runStatusJson(root) {
  const out = [];
  const err = [];
  const code = runStatusCommand({
    cwd: root,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: NOW,
    json: true,
    env: ENV,
  });
  return { code, payload: JSON.parse(out.join('\n')) };
}

function hashTree(rootDir) {
  const hashes = [];
  const walk = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const bytes = fs.readFileSync(full);
        hashes.push(
          `${path.relative(rootDir, full)}:${crypto.createHash('sha256').update(bytes).digest('hex')}`
        );
      }
    }
  };
  walk(rootDir);
  return hashes.join('\n');
}

describe('caws tui (CAWS-TUI-DASHBOARD-001)', () => {
  test('A1: --once renders all six dashboard sections to non-TTY stdout and exits 0', () => {
    const { root } = mkRichRepo();
    const stdout = runCli(['tui', '--once'], root);
    for (const section of ['CAWS Dashboard', 'Specs', 'Worktrees', 'Agents', 'Doctor', 'Gates']) {
      expect(stdout).toContain(section);
    }
    // Panel data actually flowed: the fixture's active spec and lane appear.
    expect(stdout).toContain('TUI-GOLD-ACTIVE-001');
    expect(stdout).toContain('wt-gold');
    // One-shot output is deterministic text: no ANSI escape sequences.
    expect(stdout).not.toMatchAnsi();
  });

  test('A1: --once surfaces the default policy gates in the Gates panel', () => {
    const { root } = mkRichRepo();
    const stdout = runCli(['tui', '--once'], root);
    // initProject's default policy declares budget_limit; if the gates panel
    // breaks (or silently renders empty), this fails.
    expect(stdout).toContain('budget_limit');
  });

  test('A2: status --json panels and the TUI payload are identical (single-source selectors)', () => {
    const { root } = mkRichRepo();
    const { code, payload: statusPayload } = runStatusJson(root);
    expect(code).toBe(0);

    const state = gatherDashboardState({ cwd: root, env: ENV, now: NOW });
    if (!state.ok) throw new Error('gatherDashboardState failed: ' + state.message);
    const tuiPayload = buildStatusPanelPayload({
      jsonPanels: ['specs', 'worktrees', 'agents', 'doctor'],
      specs: state.snapshot.specs,
      worktrees: state.snapshot.worktrees,
      leaseSummary: state.leaseSummary,
      selfSessionId: state.selfSessionId,
      wantsHeartbeat: false,
      defaultMode: true,
      lane: state.lane,
      laneWorktree: state.binding.worktreeName ?? null,
      doctorFindings: state.findings,
      mailSummary: state.mailSummary,
    });

    for (const panel of ['specs', 'worktrees', 'agents', 'doctor']) {
      expect(JSON.stringify(tuiPayload[panel])).toBe(JSON.stringify(statusPayload[panel]));
    }
  });

  test('A3: running the TUI twice leaves the .caws governance tree byte-identical', () => {
    const { root, caws } = mkRichRepo();
    const before = hashTree(caws);

    runCli(['tui', '--once'], root);
    const afterFirst = hashTree(caws);
    expect(afterFirst).toBe(before);

    runCli(['tui', '--once'], root);
    const afterSecond = hashTree(caws);
    expect(afterSecond).toBe(before);
  });

  test('A4: non-TTY caws tui without --once prints guidance to stderr, frame to stdout, exits 0', () => {
    const { root } = mkRichRepo();
    const { spawnSync } = require('child_process');
    const result = spawnSync('node', [CLI, 'tui'], {
      cwd: root,
      env: ENV,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not a TTY');
    expect(result.stderr).toContain('--once');
    expect(result.stdout).toContain('CAWS Dashboard');
    expect(result.stdout).toContain('Specs');
  });

  test('A5: session repaints at the configured interval and exits on q / Ctrl-C', () => {
    const { root } = mkRichRepo();
    const writes = [];
    let paintedFrame;
    const gather = () => {
      const state = gatherDashboardState({ cwd: root, env: ENV, now: NOW });
      if (!state.ok) throw new Error(state.message);
      paintedFrame = renderFrame(buildDashboardModel(state), { width: 100, height: 60 });
      return buildDashboardModel(state);
    };
    const registered = [];
    const timers = {
      set(fn, ms) {
        registered.push({ fn, ms });
        return 'handle-1';
      },
      clear(handle) {
        expect(handle).toBe('handle-1');
      },
    };

    const session = startDashboardSession({
      gather,
      size: () => ({ width: 100, height: 60 }),
      write: (s) => writes.push(s),
      intervalMs: 3000,
      timers,
    });

    // Initial paint happened on start, and the interval was registered.
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]).toMatchAnsiEnter();
    expect(registered).toHaveLength(1);
    expect(registered[0].ms).toBe(3000);

    // Two interval ticks → two more paints (fresh gather each tick).
    const beforeTicks = writes.length;
    registered[0].fn();
    registered[0].fn();
    expect(writes.length).toBe(beforeTicks + 2);
    expect(writes[writes.length - 1]).toBe('\x1b[H' + paintedFrame);

    // Key classification: q and Ctrl-C exit; everything else continues.
    expect(session.handleKeypress('q')).toBe('exit');
    expect(session.handleKeypress('\u0003')).toBe('exit');
    expect(session.handleKeypress('j')).toBe('continue');

    // Stop restores the screen exactly once and returns the exit code.
    expect(session.stop()).toBe(0);
    expect(writes[writes.length - 1]).toBe(ALT_SCREEN_EXIT);
    expect(session.stop()).toBe(0);
  });

  test('frame renderer is deterministic and truncates to the given width', () => {
    const { root } = mkRichRepo();
    const state = gatherDashboardState({ cwd: root, env: ENV, now: NOW });
    if (!state.ok) throw new Error(state.message);
    const model = buildDashboardModel(state);
    const a = renderFrame(model, { width: 100, height: 200 });
    const b = renderFrame(model, { width: 100, height: 200 });
    expect(a).toBe(b);
    for (const line of a.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
    // A narrow terminal still renders (min-width clamp) and a short one
    // drops later panels with an explicit marker instead of slicing a box.
    const narrow = renderFrame(model, { width: 20, height: 200 });
    expect(narrow.length).toBeGreaterThan(0);
    const short = renderFrame(model, { width: 100, height: 8 });
    expect(short).toContain('terminal too short');
  });

  test('A6: caws --help lists the tui command', () => {
    const help = runCli(['--help'], process.cwd());
    expect(help).toContain('tui');
  });
});

// ─── tiny matchers ──────────────────────────────────────────────────────────
expect.extend({
  toMatchAnsi(received) {
    // eslint-disable-next-line no-control-regex -- detecting ANSI escapes requires the ESC control character
    const ansi = /\x1b\[/.test(received);
    return {
      pass: ansi,
      message: () =>
        ansi
          ? 'expected output not to contain ANSI escape sequences'
          : 'expected output to contain ANSI escape sequences',
    };
  },
  toMatchAnsiEnter(received) {
    const pass = received.startsWith('\x1b[?1049h');
    return {
      pass,
      message: () =>
        `expected first write to enter the alt screen, got ${JSON.stringify(received.slice(0, 20))}`,
    };
  },
});
