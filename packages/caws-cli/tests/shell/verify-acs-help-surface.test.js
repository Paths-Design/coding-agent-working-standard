'use strict';

/**
 * The --help surface and the shipped templates must agree with what the
 * runtime actually does (CAWS-VERIFY-ACS-HELP-AND-TEMPLATE-DRIFT-001).
 *
 * COMMAND_SURFACE_METADATA derives structure and enum values from runtime
 * constants, so `--help` cannot go stale about a command's SHAPE. Prose is
 * hand-authored and nothing checks it — which is how `--runner` came to list
 * five accepted values without saying that three of them execute nothing,
 * and how the project templates kept naming `verify-acs` as a command that
 * is "not coming back" after it came back.
 *
 * These tests close the two gaps that are mechanically closable:
 *  - the executable/detected-only split in `--runner` help is DERIVED from
 *    EXECUTABLE_TEST_RUNNERS, the same constant the dispatch reads, and the
 *    real `--help` output carries it;
 *  - no template's removed-command list names a live `caws specs` leaf without
 *    also giving that leaf's full path on the same line.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  EXECUTABLE_TEST_RUNNERS,
  SELECTABLE_TEST_RUNNERS,
  buildRederivationReport,
} = require('../../dist/store/evidence-rederive');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { planRederivation } = require('../../dist/kernel');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const TEMPLATES = path.resolve(__dirname, '..', '..', 'templates');

const DETECTED_ONLY = SELECTABLE_TEST_RUNNERS.filter((r) => !EXECUTABLE_TEST_RUNNERS.includes(r));

// ─── surface accessors ───────────────────────────────────────────────────────

function findLeaf(groupName, leafName) {
  const group = COMMAND_SURFACE_METADATA.find((c) => c.kind === 'group' && c.name === groupName);
  if (!group) return undefined;
  return group.subcommands.find((c) => c.kind === 'leaf' && c.name === leafName);
}

/**
 * Leaf names registered under `caws specs`.
 *
 * Deliberately not the whole surface: v10's spec-lifecycle commands are the
 * ones that folded into this group, so a removed name that matches a `specs`
 * leaf is a genuine "did it survive here?" ambiguity for a reader. A collision
 * anywhere else is a shared word, not a surviving command -- `caws scope plan`
 * evaluates paths and has nothing to do with v10's `caws plan`, and asserting
 * on that would only teach the next author to silence the test.
 */
function specsLeafNames() {
  const group = COMMAND_SURFACE_METADATA.find((c) => c.kind === 'group' && c.name === 'specs');
  expect(group).toBeDefined();
  return new Set(group.subcommands.filter((c) => c.kind === 'leaf').map((c) => c.name));
}

function optionDescription(leaf, flag) {
  const opt = leaf.options.find((o) => o.flag === flag);
  return opt === undefined ? undefined : opt.description;
}

// ─── the split is real, and it is a partition ────────────────────────────────

describe('executable vs selectable runners', () => {
  test('every executable runner is selectable, and the two lists partition it', () => {
    for (const runner of EXECUTABLE_TEST_RUNNERS) {
      expect(SELECTABLE_TEST_RUNNERS).toContain(runner);
    }
    expect([...EXECUTABLE_TEST_RUNNERS, ...DETECTED_ONLY].sort()).toEqual(
      [...SELECTABLE_TEST_RUNNERS].sort()
    );
    // A collapsed split would make the help text below vacuous: if every
    // selectable runner were declared executable the "verifies nothing" half
    // would be empty and the warning would silently disappear.
    expect(DETECTED_ONLY.length).toBeGreaterThan(0);
  });

  test('a detected-only runner reports unavailable and spawns nothing', () => {
    // The dispatch decides on EXECUTABLE_TEST_RUNNERS. Driving every
    // selectable runner through the real compiled executor proves the two
    // lists and the dispatch arms are the same partition -- not merely that
    // the prose and the constant agree with each other.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-split-'));
    try {
      const spec = {
        acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
        evidence: [
          {
            criterion_id: 'A1',
            status: 'pass',
            recorded_at: '2026-09-16T12:00:00.000Z',
            test_nodeid: 'tests/nothing.test.js::a name',
          },
        ],
      };
      const plan = planRederivation(spec);

      for (const runner of SELECTABLE_TEST_RUNNERS) {
        const spawns = [];
        const outcomes = buildRederivationReport(root, plan, {
          classes: ['test'],
          runTests: true,
          runner,
          execFile: (file) => {
            spawns.push(file);
            return '';
          },
        }).outcomes;
        const check = outcomes.A1[0];

        if (EXECUTABLE_TEST_RUNNERS.includes(runner)) {
          expect(check.detail).not.toMatch(/does not execute this runner/);
          expect(check.detail).not.toMatch(/declared executable but has no dispatch arm/);
        } else {
          expect(check.outcome).toBe('unavailable');
          expect(check.detail).toBe(
            `runner ${runner} detected; re-derivation does not execute this runner — ` +
              'run the test yourself and cite the resulting commit or artifact'
          );
          // Reporting "this runner is not executed" must not have executed it.
          expect(spawns).toEqual([]);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── the help text names the split ───────────────────────────────────────────

describe('specs verify-acs --runner help', () => {
  const leaf = () => findLeaf('specs', 'verify-acs');

  test('the option is registered with the selectable values', () => {
    const opt = leaf().options.find((o) => o.flag === '--runner <name>');
    expect(opt).toBeDefined();
    expect([...opt.allowedValues]).toEqual([...SELECTABLE_TEST_RUNNERS]);
  });

  test('the description names each executable runner and each detected-only one', () => {
    const description = optionDescription(leaf(), '--runner <name>');
    // Parsed back out of the rendered prose rather than compared to a rebuilt
    // string: a literal description that drifts from the constants fails here,
    // which is the whole point of deriving it.
    const executablePart = /Only ([^.]+?) execute under --run/.exec(description);
    const detectedPart = /naming ([^.]+?) reports unavailable/.exec(description);
    expect(executablePart).not.toBeNull();
    expect(detectedPart).not.toBeNull();
    expect(executablePart[1].split(', ')).toEqual([...EXECUTABLE_TEST_RUNNERS]);
    expect(detectedPart[1].split(', ')).toEqual([...DETECTED_ONLY]);
  });

  test('--run help does not claim pytest is resolved from the repository', () => {
    // jest is resolved from the repo's node_modules/.bin; pytest runs as the
    // ambient `python3 -m pytest`, so a sibling project's virtualenv on PATH
    // can change the verdict. Help that says otherwise sends a reader looking
    // for a repo-local pytest that was never consulted.
    const description = optionDescription(leaf(), '--run');
    expect(description).toMatch(/node_modules\/\.bin/);
    expect(description).toMatch(/never npx/);
    expect(description).toMatch(/python3 -m pytest/);
    expect(description).toMatch(/not repo-resolved/);
  });

  test('the built CLI prints both halves of the split', () => {
    // register.ts opt-forwarding means metadata can be right while the help a
    // user actually sees is not. Assert against the artifact.
    const help = spawnSync(process.execPath, [CLI, 'specs', 'verify-acs', '--help'], {
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    // Commander hard-wraps option help at the terminal width, so the phrases
    // below are split across lines and re-indented. Match on the unwrapped text.
    const text = help.stdout.replace(/\s+/g, ' ');
    for (const runner of EXECUTABLE_TEST_RUNNERS) expect(text).toContain(runner);
    for (const runner of DETECTED_ONLY) expect(text).toContain(runner);
    expect(text).toContain(`Only ${EXECUTABLE_TEST_RUNNERS.join(', ')} execute under --run`);
    expect(text).toContain(
      `naming ${DETECTED_ONLY.join(', ')} reports unavailable and verifies nothing`
    );
  });
});

// ─── templates must not bury a live command ──────────────────────────────────

describe('template removed-command lists', () => {
  const MARKER = 'were removed in v11.0 and are not coming back:';

  /** The single line enumerating removed commands, from one template. */
  function removedLine(file) {
    const lines = fs.readFileSync(path.join(TEMPLATES, file), 'utf8').split('\n');
    const markerAt = lines.findIndex((l) => l.includes(MARKER));
    expect(markerAt).toBeGreaterThanOrEqual(0);
    const listAt = lines.findIndex((l, i) => i > markerAt && l.trim() !== '');
    expect(listAt).toBeGreaterThan(markerAt);
    return lines[listAt];
  }

  /** Backticked tokens with no space -- bare command names, not full paths. */
  function bareNames(line) {
    return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((name) => !name.includes(' '));
  }

  for (const file of ['CLAUDE.md', 'agents.md']) {
    test(`${file}: a removed name that is a live specs leaf must give its full path`, () => {
      const line = removedLine(file);
      const names = bareNames(line);
      expect(names.length).toBeGreaterThan(5);

      const leaves = specsLeafNames();
      const collisions = names.filter((name) => leaves.has(name));
      // Guards against the assertion below passing because the parse returned
      // nothing useful: `validate` and `archive` both live here today.
      expect(collisions.length).toBeGreaterThan(0);

      for (const name of collisions) {
        // The name still resolves to a command a reader can run. The line may
        // only keep it if it also says where that command lives -- otherwise an
        // agent reads "not coming back" about a command that is right there.
        expect(line).toContain(`caws specs ${name}`);
      }
    });

    test(`${file}: verify-acs is not listed as removed, and the restoration is stated`, () => {
      const body = fs.readFileSync(path.join(TEMPLATES, file), 'utf8');
      expect(bareNames(removedLine(file))).not.toContain('verify-acs');
      expect(body).toContain('caws specs verify-acs');
    });
  }

  test('verify-acs is registered under specs', () => {
    // Guards the pair above from passing vacuously if the command were removed
    // again: then the templates would be right to list it, and these tests
    // would need to change deliberately rather than silently.
    expect(findLeaf('specs', 'verify-acs')).toBeDefined();
  });
});
