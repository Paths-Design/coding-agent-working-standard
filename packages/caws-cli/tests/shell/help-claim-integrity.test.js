'use strict';

/**
 * Help prose must not make claims the runtime can contradict
 * (CAWS-HELP-CLAIM-DECLARED-NOT-DESCRIBED-001).
 *
 * A pre-release audit read every option description that names a mechanism --
 * a binary, a path, an exit code, an accepted value set. The exit-code and
 * behavioural claims held. What did not: three options stated a CLOSED
 * accepted set in prose instead of declaring it, so nothing tied the prose to
 * the code that enforces it. Two of them cited the CAWS version the rule was
 * introduced in and kept saying "v11.2" while the package shipped 12.2.0-rc.2;
 * a third advertised four of the eleven state classes its own guard refuses
 * against, which reads as an open set that mysteriously rejects.
 *
 * The rule these tests hold: a closed accepted set is DECLARED once, in code,
 * and both the help and the guard read that declaration. Prose describing a
 * set is the defect, not the stale wording -- the wording is just how it shows.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const {
  MIGRATABLE_SOURCE_VERSIONS,
  describeMigratableSourceVersions,
} = require('../../dist/store/migration-versions');
const {
  WORKTREE_PRUNE_STATES,
  WORKTREE_PHYSICAL_CLEANUP_STATES,
} = require('../../dist/shell/commands/worktree');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
  });
}

// ─── surface walking ─────────────────────────────────────────────────────────

/** Every option on every command, with the path it is reached by. */
function allOptions() {
  const found = [];
  const walk = (meta, trail) => {
    const here = [...trail, meta.name];
    for (const opt of meta.options ?? []) found.push({ path: here.join(' '), opt });
    if (meta.kind === 'leaf') return;
    for (const sub of meta.subcommands) walk(sub, here);
    if (meta.defaultAction) {
      for (const opt of meta.defaultAction.options ?? []) found.push({ path: here.join(' '), opt });
    }
  };
  for (const meta of COMMAND_SURFACE_METADATA) walk(meta, []);
  return found;
}

function optionOn(commandPath, flag) {
  const hit = allOptions().find((o) => o.path === commandPath && o.opt.flag === flag);
  expect(hit).toBeDefined();
  return hit.opt;
}

// ─── A4: the class, not the instances ────────────────────────────────────────

describe('option descriptions declare rather than describe', () => {
  test('no option description names a CAWS version', () => {
    // A version reference in user-facing text is a staleness probe with no
    // checker behind it: nothing fails when the release moves past it. What a
    // caller needs is which values are accepted, not when that became true --
    // the release it landed in is git history's job.
    const offenders = allOptions()
      .filter(({ opt }) => /\bv\d+\.\d+/.test(opt.description))
      .map(({ path: p, opt }) => `${p} ${opt.flag}: ${opt.description}`);
    expect(offenders).toEqual([]);
  });

  test('no option description states its accepted set in prose', () => {
    // "only X is supported" is the tell for a closed set that was written down
    // instead of declared. Such an option must carry allowedValues, which the
    // help renderer appends from the same array the guard reads.
    const offenders = allOptions()
      .filter(({ opt }) => /\bonly \S+ (?:is |are )?supported\b/i.test(opt.description))
      .filter(({ opt }) => opt.allowedValues === undefined)
      .map(({ path: p, opt }) => `${p} ${opt.flag}: ${opt.description}`);
    expect(offenders).toEqual([]);
  });
});

// ─── A1: --from on both migrators ────────────────────────────────────────────

describe('migrate --from', () => {
  for (const commandPath of ['specs migrate', 'events migrate']) {
    test(`${commandPath} declares its accepted versions`, () => {
      const opt = optionOn(commandPath, '--from <version>');
      expect([...opt.allowedValues]).toEqual([...MIGRATABLE_SOURCE_VERSIONS]);
      expect(opt.description).not.toMatch(/v\d+\.\d+/);
    });
  }

  test('both rejection messages derive from the same constant', () => {
    // Not "both messages are equal to this literal" -- both must name the set
    // the shared helper names, so adding a version changes all three at once.
    const accepted = describeMigratableSourceVersions();
    const specs = runCli(['specs', 'migrate', '--from', 'v11']);
    const events = runCli(['events', 'migrate', '--from', 'v9']);

    expect(specs.stderr + specs.stdout).toContain(`--from accepts ${accepted}; got "v11"`);
    expect(events.stderr + events.stdout).toContain(`--from accepts ${accepted}; got "v9"`);
    for (const r of [specs, events]) {
      expect(r.stderr + r.stdout).not.toMatch(/v\d+\.\d+/);
    }
  });

  test('events migrate rejects through its handler, not a parse-layer copy', () => {
    // register.ts carried a duplicate --from guard that forwarded a hardcoded
    // 'v10' to the handler, so the handler's own check was unreachable and its
    // message never reached a caller. Fixing the handler alone changed nothing
    // observable -- exactly the opt-forward false confidence handler tests miss.
    // A rejection naming the shared helper proves the handler decided.
    const r = runCli(['events', 'migrate', '--from', 'not-a-version']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain(
      `caws events migrate: --from accepts ${describeMigratableSourceVersions()}`
    );
  });
});

// ─── A2: worktree state-class filters ────────────────────────────────────────

describe('worktree state-class filters', () => {
  const cases = [
    ['worktree prune', WORKTREE_PRUNE_STATES],
    ['worktree cleanup-plan', WORKTREE_PHYSICAL_CLEANUP_STATES],
  ];

  for (const [commandPath, states] of cases) {
    test(`${commandPath} --state lists every class it dispatches on`, () => {
      const description = optionOn(commandPath, '--state <classes>').description;
      expect(states.length).toBeGreaterThan(0);
      for (const state of states) expect(description).toContain(state);
      // The old wording named a subset as a "for example". Listing every class
      // is the point, so assert the count too: a description that drops one
      // while keeping the phrase would otherwise still pass the loop above.
      const listed = description.split('Accepted classes: ')[1];
      expect(listed).toBeDefined();
      expect(listed.split(', ')).toEqual([...states]);
    });
  }

  test('the two filters are different sets, so neither test passes by coincidence', () => {
    expect([...WORKTREE_PRUNE_STATES]).not.toEqual([...WORKTREE_PHYSICAL_CLEANUP_STATES]);
  });
});

// ─── A3: exit-code claims, checked against the built CLI ─────────────────────

describe('claimed exit codes', () => {
  let root;
  afterEach(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test('specs validate: 0 when valid, non-zero when invalid or unreadable', () => {
    // Claim: "Exits 0 when valid, non-zero with a rendered diagnostic when
    // invalid or unreadable."
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-claims-'));
    const valid = path.join(root, 'valid.yaml');
    const invalid = path.join(root, 'invalid.yaml');
    fs.writeFileSync(valid, VALID_SPEC);
    fs.writeFileSync(invalid, 'this: is not a spec\n');

    expect(runCli(['specs', 'validate', valid]).status).toBe(0);
    expect(runCli(['specs', 'validate', invalid]).status).not.toBe(0);
    expect(runCli(['specs', 'validate', path.join(root, 'absent.yaml')]).status).not.toBe(0);
  });

  test('scope plan: exits 0 even when planned decisions are not all admits', () => {
    // Claim: "Always exits 0 after a successful plan, even when planned
    // decisions include refusals." Exit 0 alone would pass vacuously on a plan
    // where every path was admitted, so the counts must show a non-admit.
    //
    // The non-admit path must be one NO spec can admit. An ordinary repo path
    // (this test used AGENTS.md) couples the oracle to whichever spec happens
    // to be bound here: the moment an agent amends that path into scope, the
    // plan returns all-admits and this goes red for a reason that has nothing
    // to do with the claim. A parent-traversal path is classified
    // invalid_path by the kernel before scope is consulted at all, so it is
    // stable in a bound worktree, an unbound checkout, and CI alike.
    const r = runCli(
      ['scope', 'plan', '--path', '.caws/policy.yaml', '--path', '../../../../etc/passwd'],
      REPO
    );
    expect(r.status).toBe(0);

    const counts = /admit=(\d+) reject=(\d+) no_authority=(\d+) invalid_path=(\d+)/.exec(r.stdout);
    expect(counts).not.toBeNull();
    const [, , reject, noAuthority, invalid] = counts.map(Number);
    expect(reject + noAuthority + invalid).toBeGreaterThan(0);
  });
});

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

const VALID_SPEC = `id: HELP-CLAIM-FIXTURE-001
title: 'help claim fixture'
risk_tier: 3
mode: chore
lifecycle_state: draft
created_at: '2026-09-16T00:00:00.000Z'
updated_at: '2026-09-16T00:00:00.000Z'
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
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
