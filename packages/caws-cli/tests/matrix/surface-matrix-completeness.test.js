'use strict';

// Surface-matrix completeness + equivalence test for
// CAWS-V11-COMMAND-MATRIX-LOCK-001 (Slice 1 of the v11 retirement-readiness
// campaign).
//
// Loads docs/v11-surface-matrix.yaml from disk and the runtime mirror at
// packages/caws-cli/src/shell/legacy-command-map.js, normalizes both to a
// common shape (snake_case → camelCase, null-out missing fields), sorts by
// command, and deep-compares.
//
// The test also enforces:
//   - No duplicate command entries in either source.
//   - Every entry has a valid disposition AND v11_status enum value.
//   - Every shipped replacement's implementation_probe resolves to a known
//     v11 group (with compound-guidance allowlist for "doctor && gates run"
//     style entries that name multiple groups in their replacement string).
//   - Multi-token fixtures present: sidecar gaps, hooks install,
//     session start, provenance verify (at minimum).
//   - No runtime consumer has imported the mirror yet (Slice 1 invariant).

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const YAML_PATH = path.join(REPO_ROOT, 'docs', 'v11-surface-matrix.yaml');
const MIRROR_PATH = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'src',
  'shell',
  'legacy-command-map.js'
);

const VALID_DISPOSITIONS = new Set(['kept', 'renamed', 'replaced', 'removed', 'deferred']);
const VALID_V11_STATUS = new Set(['shipped', 'planned', 'intentionally_absent']);
const VALID_DIAG_KINDS = new Set(['kept', 'renamed', 'replaced', 'removed', 'deferred', 'shipped']);

// Compound replacement strings that name multiple v11 groups and therefore
// cannot resolve to a single implementation_probe.group. The test treats
// these as resolvable if every group named in the replacement is registered.
const COMPOUND_REPLACEMENT_ALLOWLIST = new Set([
  'caws doctor && caws gates run --spec <id>',
]);

// Required multi-token fixture coverage (A7).
const REQUIRED_MULTI_TOKEN_FIXTURES = [
  'sidecar gaps',
  'hooks install',
  'session start',
  'provenance verify',
];

function loadYaml() {
  const raw = fs.readFileSync(YAML_PATH, 'utf8');
  const parsed = yaml.load(raw);
  expect(parsed).toBeTruthy();
  expect(parsed.schema_version).toBe(1);
  expect(Array.isArray(parsed.v10_2_commands)).toBe(true);
  expect(Array.isArray(parsed.v11_registered_groups)).toBe(true);
  return parsed;
}

function loadMirror() {
  // Use require so jest catches syntax errors loudly.
   
  const mod = require(MIRROR_PATH);
  expect(mod).toBeTruthy();
  expect(mod.SCHEMA_VERSION).toBe(1);
  expect(Array.isArray(mod.LEGACY_COMMAND_MAP)).toBe(true);
  expect(Array.isArray(mod.V11_REGISTERED_GROUPS)).toBe(true);
  return mod;
}

// Normalize a YAML entry (snake_case) to the common shape used for compare.
function normalizeYamlEntry(e) {
  return {
    command: e.command,
    disposition: e.disposition,
    v11Status: e.v11_status,
    replacement: e.replacement ?? null,
    since: e.since ?? null,
    sourceDocs: Array.isArray(e.source_docs) ? [...e.source_docs] : [],
    implementationProbe: {
      group: (e.implementation_probe && e.implementation_probe.group) ?? null,
      subcommand: (e.implementation_probe && e.implementation_probe.subcommand) ?? null,
    },
    runtimeDiagnostic: {
      kind: e.runtime_diagnostic.kind,
      message: e.runtime_diagnostic.message,
      use: Array.isArray(e.runtime_diagnostic.use) ? [...e.runtime_diagnostic.use] : undefined,
    },
  };
}

// Normalize a JS mirror entry (already camelCase + Object.freeze) to a plain
// object for compare. Equivalent shape to normalizeYamlEntry output.
function normalizeMirrorEntry(e) {
  return {
    command: e.command,
    disposition: e.disposition,
    v11Status: e.v11Status,
    replacement: e.replacement ?? null,
    since: e.since ?? null,
    sourceDocs: Array.isArray(e.sourceDocs) ? [...e.sourceDocs] : [],
    implementationProbe: {
      group: e.implementationProbe.group ?? null,
      subcommand: e.implementationProbe.subcommand ?? null,
    },
    runtimeDiagnostic: {
      kind: e.runtimeDiagnostic.kind,
      message: e.runtimeDiagnostic.message,
      use: Array.isArray(e.runtimeDiagnostic.use) ? [...e.runtimeDiagnostic.use] : undefined,
    },
  };
}

function sortByCommand(entries) {
  return [...entries].sort((a, b) => a.command.localeCompare(b.command));
}

describe('CAWS-V11-COMMAND-MATRIX-LOCK-001: surface matrix completeness and equivalence', () => {
  let yamlDoc;
  let mirror;

  beforeAll(() => {
    yamlDoc = loadYaml();
    mirror = loadMirror();
  });

  // ── A1: schema shape ───────────────────────────────────────────────────
  test('A1: every YAML entry has required fields and valid enum values', () => {
    for (const e of yamlDoc.v10_2_commands) {
      expect(typeof e.command).toBe('string');
      expect(e.command.length).toBeGreaterThan(0);
      expect(VALID_DISPOSITIONS.has(e.disposition)).toBe(true);
      expect(VALID_V11_STATUS.has(e.v11_status)).toBe(true);
      expect(e.runtime_diagnostic).toBeTruthy();
      expect(VALID_DIAG_KINDS.has(e.runtime_diagnostic.kind)).toBe(true);
      expect(typeof e.runtime_diagnostic.message).toBe('string');
      expect(Array.isArray(e.source_docs)).toBe(true);
      expect(e.source_docs.length).toBeGreaterThan(0);
      expect(e.implementation_probe).toBeTruthy();
    }
  });

  test('A1: every mirror entry has required fields and valid enum values', () => {
    for (const e of mirror.LEGACY_COMMAND_MAP) {
      expect(typeof e.command).toBe('string');
      expect(e.command.length).toBeGreaterThan(0);
      expect(VALID_DISPOSITIONS.has(e.disposition)).toBe(true);
      expect(VALID_V11_STATUS.has(e.v11Status)).toBe(true);
      expect(e.runtimeDiagnostic).toBeTruthy();
      expect(VALID_DIAG_KINDS.has(e.runtimeDiagnostic.kind)).toBe(true);
      expect(typeof e.runtimeDiagnostic.message).toBe('string');
      expect(Array.isArray(e.sourceDocs)).toBe(true);
      expect(e.sourceDocs.length).toBeGreaterThan(0);
      expect(e.implementationProbe).toBeTruthy();
    }
  });

  // ── A2: no duplicates, no unclassified ────────────────────────────────
  test('A2: YAML has no duplicate command entries', () => {
    const seen = new Map();
    for (const e of yamlDoc.v10_2_commands) {
      expect(seen.has(e.command)).toBe(false);
      seen.set(e.command, true);
    }
  });

  test('A2: mirror has no duplicate command entries', () => {
    const seen = new Map();
    for (const e of mirror.LEGACY_COMMAND_MAP) {
      expect(seen.has(e.command)).toBe(false);
      seen.set(e.command, true);
    }
  });

  // ── A3: shipped replacements resolve to registered v11 groups ─────────
  test('A3: every shipped entry resolves to a registered v11 group OR uses compound guidance', () => {
    const registered = new Set(mirror.V11_REGISTERED_GROUPS);

    for (const e of mirror.LEGACY_COMMAND_MAP) {
      if (e.v11Status !== 'shipped') continue;

      const probedGroup = e.implementationProbe.group;
      if (probedGroup) {
        expect(registered.has(probedGroup)).toBe(true);
        continue;
      }

      // No probe group set. The replacement must be either:
      //   - on the compound-guidance allowlist (e.g. doctor && gates run), OR
      //   - a "read .caws/events.jsonl" / "loop caws worktree create" style
      //     advisory that names no command.
      // Both cases are intentional. The test fails only if a shipped entry
      // has neither a probe group nor a recognized fallback.
      const replacement = e.replacement || '';
      const allowed =
        COMPOUND_REPLACEMENT_ALLOWLIST.has(replacement) ||
        /^read \.caws\//.test(replacement) ||
        /^loop caws /.test(replacement);
      expect(allowed).toBe(true);
    }
  });

  // ── A4: every entry has the diagnostic metadata Slice 2 will consume ──
  test('A4: every entry carries disposition + replacement + source_docs + diagnostic for Slice 2', () => {
    for (const e of mirror.LEGACY_COMMAND_MAP) {
      // disposition drives message shape — already asserted above.
      // replacement may be null (removed-no-replacement); that's fine.
      // source_docs[0] is the "see also" anchor — must exist.
      expect(e.sourceDocs.length).toBeGreaterThan(0);
      expect(typeof e.sourceDocs[0]).toBe('string');
      // runtime_diagnostic.message is the operator-facing string.
      expect(e.runtimeDiagnostic.message.length).toBeGreaterThan(10);
    }
  });

  // ── A5 + A6: YAML and mirror are semantically equivalent ──────────────
  test('A6: YAML and mirror have identical command sets', () => {
    const yamlCmds = new Set(yamlDoc.v10_2_commands.map((e) => e.command));
    const mirrorCmds = new Set(mirror.LEGACY_COMMAND_MAP.map((e) => e.command));

    const onlyInYaml = [...yamlCmds].filter((c) => !mirrorCmds.has(c));
    const onlyInMirror = [...mirrorCmds].filter((c) => !yamlCmds.has(c));

    expect({ onlyInYaml, onlyInMirror }).toEqual({ onlyInYaml: [], onlyInMirror: [] });
  });

  test('A6: YAML and mirror entries are deeply equivalent per command', () => {
    const yamlSorted = sortByCommand(yamlDoc.v10_2_commands.map(normalizeYamlEntry));
    const mirrorSorted = sortByCommand(mirror.LEGACY_COMMAND_MAP.map(normalizeMirrorEntry));

    expect(yamlSorted.length).toBe(mirrorSorted.length);

    for (let i = 0; i < yamlSorted.length; i++) {
      expect(mirrorSorted[i]).toEqual(yamlSorted[i]);
    }
  });

  test('A6: registered-groups list matches between YAML and mirror', () => {
    expect([...mirror.V11_REGISTERED_GROUPS].sort()).toEqual(
      [...yamlDoc.v11_registered_groups].sort()
    );
  });

  // ── A7: multi-token fixture coverage ──────────────────────────────────
  test('A7: required multi-token fixtures are present', () => {
    const commands = new Set(mirror.LEGACY_COMMAND_MAP.map((e) => e.command));
    for (const fixture of REQUIRED_MULTI_TOKEN_FIXTURES) {
      expect(commands.has(fixture)).toBe(true);
    }
  });

  test('A7: at least one one-token/two-token prefix-overlap pair exists', () => {
    // Slice 2's longest-prefix classifier must handle e.g. "sidecar" vs
    // "sidecar gaps". Verify the prefix-overlap case is in the data.
    const commands = new Set(mirror.LEGACY_COMMAND_MAP.map((e) => e.command));
    expect(commands.has('sidecar')).toBe(true);
    expect(commands.has('sidecar gaps')).toBe(true);
    // provenance / provenance verify is a second overlap pair.
    expect(commands.has('provenance')).toBe(true);
    expect(commands.has('provenance verify')).toBe(true);
  });

  // ── A8: consumer wiring — index.js consumes the mirror as of Slice 2 ──
  // Slice 1 asserted index.js did NOT import the mirror. Slice 2
  // (CAWS-REMOVED-COMMAND-DIAGNOSTICS-001) wired the classifier into the
  // unknown-command path, so the invariant flips: index.js MUST now
  // import the mirror. error-handler.js and register.ts remain mirror-free
  // (scope-split invariant — error-handler is owned by
  // ERROR-HANDLER-V11-SURFACE-001; register.ts wiring is deferred).
  test('A8: packages/caws-cli/src/index.js imports the mirror (wired in Slice 2)', () => {
    const indexPath = path.join(
      REPO_ROOT,
      'packages',
      'caws-cli',
      'src',
      'index.js'
    );
    const indexSrc = fs.readFileSync(indexPath, 'utf8');
    expect(indexSrc).toMatch(/legacy-command-map/);
  });

  test('A8: packages/caws-cli/src/error-handler.js does not import the mirror', () => {
    const errorHandlerPath = path.join(
      REPO_ROOT,
      'packages',
      'caws-cli',
      'src',
      'error-handler.js'
    );
    const errorHandlerSrc = fs.readFileSync(errorHandlerPath, 'utf8');
    expect(errorHandlerSrc).not.toMatch(/legacy-command-map/);
  });

  test('A8: packages/caws-cli/src/shell/register.ts does not import the mirror yet', () => {
    const registerPath = path.join(
      REPO_ROOT,
      'packages',
      'caws-cli',
      'src',
      'shell',
      'register.ts'
    );
    const registerSrc = fs.readFileSync(registerPath, 'utf8');
    expect(registerSrc).not.toMatch(/legacy-command-map/);
  });
});
