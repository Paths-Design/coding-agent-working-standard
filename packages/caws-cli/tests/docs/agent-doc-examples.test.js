'use strict';

// Pins the RUNNABILITY of `caws evidence record` examples in agent-facing docs.
// (CAWS-AGENT-DOC-SURFACE-DRIFT-002)
//
// Why this exists rather than more prose review: seven separate agent-facing
// docs carried the same `--data '{"id":"A1","status":"satisfied"}'` payload.
// It is rejected by the kernel — the schema requires `criterion_id` and
// `evidence_ref`, and `satisfied` is not in the status enum. One bad example
// was copy-pasted until it looked authoritative. Marker-based generation cannot
// catch this: `docs/guides/agent-integration-guide.md` is generator-managed and
// still carried the broken payload, because the generator only guards the
// regions between its markers, not the prose around them.
//
// An agent cannot recall how CAWS works; it can only read what CAWS tells it.
// A documented command that fails when run teaches it a system that does not
// exist, so example payloads are treated here as executable contract.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// The kernel event schemas declare draft 2020-12, which the default Ajv 8
// export does not support — it needs the 2020 build or it throws
// "no schema with key or ref .../2020-12/schema".
const Ajv = require('ajv/dist/2020');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
  }).trim();
}

const ROOT = repoRoot();

// Every agent-facing doc that carries runnable CAWS examples.
const DOC_SURFACES = [
  'AGENTS.md',
  'CLAUDE.md',
  'docs/agent-workflow-tools.md',
  'docs/agents/TUTORIAL.md',
  'docs/agents/full-guide.md',
  'docs/guides/agent-integration-guide.md',
  'docs/guides/hooks-and-agent-workflows.md',
  'docs/guides/multi-agent-workflow.md',
  'packages/caws-cli/templates/CLAUDE.md',
  'packages/caws-cli/templates/agents.md',
];

const EVIDENCE_SCHEMA_BY_TYPE = {
  ac: 'ac_recorded.v1.json',
  test: 'test_recorded.v1.json',
  gate: 'gate_evaluated.v1.json',
};

function loadSchema(file) {
  return JSON.parse(
    fs.readFileSync(
      // CAWS-ABSORB-KERNEL-01: kernel schemas moved from packages/caws-kernel/src/schemas
      // to packages/caws-cli/src/kernel/schemas when the kernel was absorbed into the CLI.
      path.join(ROOT, 'packages/caws-cli/src/kernel/schemas/events', file),
      'utf8'
    )
  );
}

/**
 * Extract `caws evidence record --type <kind> ... --data '<json>'` examples.
 * Handles the backslash-continued multi-line form used across these docs.
 * Placeholder payloads (`{...}`) are intentionally skipped: they are prose
 * ellipsis, not a claim about shape.
 */
function extractEvidenceExamples(body, rel) {
  // Join backslash-continued lines so a --type/--data pair split across lines
  // is matched as one invocation.
  const joined = body.replace(/\\\n\s*/g, ' ');
  const out = [];
  const re = /caws evidence record\s+([^\n`]*?--data\s+'([^']*)')/g;
  let m;
  while ((m = re.exec(joined)) !== null) {
    const invocation = m[1];
    const raw = m[2];
    if (raw.trim() === '{...}') continue; // documented ellipsis, not a shape
    const typeMatch = /--type\s+(\w+)/.exec(invocation);
    out.push({
      rel,
      type: typeMatch ? typeMatch[1] : null,
      raw,
    });
  }
  return out;
}

const ALL_EXAMPLES = DOC_SURFACES.flatMap((rel) =>
  extractEvidenceExamples(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel)
);

describe('caws evidence record examples in agent-facing docs are runnable', () => {
  test('the extractor actually found examples', () => {
    // Guards against a vacuous suite: if the regex or the doc list ever stops
    // matching, this fails loudly instead of silently asserting nothing.
    expect(ALL_EXAMPLES.length).toBeGreaterThan(5);
  });

  test('every example names a real evidence type', () => {
    const bad = ALL_EXAMPLES.filter(
      (e) => !e.type || !EVIDENCE_SCHEMA_BY_TYPE[e.type]
    ).map((e) => `${e.rel}: --type ${e.type}`);
    expect(bad).toEqual([]);
  });

  test('every example payload validates against its kernel event schema', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    // Compile each schema ONCE — the kernel schemas carry a $id, and Ajv
    // refuses to register the same $id twice.
    const validators = Object.fromEntries(
      Object.entries(EVIDENCE_SCHEMA_BY_TYPE).map(([type, file]) => [
        type,
        ajv.compile(loadSchema(file)),
      ])
    );
    const failures = [];

    for (const ex of ALL_EXAMPLES) {
      if (!ex.type || !validators[ex.type]) continue;

      let payload;
      try {
        payload = JSON.parse(ex.raw);
      } catch (err) {
        failures.push(`${ex.rel}: --data is not valid JSON: ${ex.raw}`);
        continue;
      }

      // Placeholder-bearing examples (<id>, ...) are still expected to carry
      // the right KEYS, so they are validated like any other payload.
      const validate = validators[ex.type];
      if (!validate(payload)) {
        const detail = (validate.errors || [])
          .map((e) => `${e.instancePath || '/'} ${e.message}`)
          .join('; ');
        failures.push(`${ex.rel}: --type ${ex.type} ${ex.raw} -> ${detail}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

describe('caws specs create examples satisfy the tier/contract rule', () => {
  // Tier 1 and 2 specs require at least one contract; the CLI refuses without
  // one. TUTORIAL.md's first hands-on command violated this, so a reader
  // following the tutorial literally was blocked on step one.
  const CREATE_RE = /caws specs create\s+([^\n`]*)/g;

  test('no documented tier-1/2 create omits --contract', () => {
    const failures = [];
    for (const rel of DOC_SURFACES) {
      const body = fs
        .readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\\\n\s*/g, ' ');
      let m;
      CREATE_RE.lastIndex = 0;
      while ((m = CREATE_RE.exec(body)) !== null) {
        const inv = m[1];
        const tier = /--risk-tier\s+(\d)/.exec(inv);
        if (!tier) continue;
        const isChore = /--mode\s+chore/.test(inv);
        if (isChore) continue;
        if ((tier[1] === '1' || tier[1] === '2') && !/--contract/.test(inv)) {
          failures.push(`${rel}: tier ${tier[1]} create without --contract: ${inv.trim()}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
