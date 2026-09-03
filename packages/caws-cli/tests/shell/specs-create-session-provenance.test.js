'use strict';

/**
 * SPEC-CREATED-BY-SESSION-001 — `caws specs create` stamps the creating
 * session's id into the spec body as an optional `created_by_session` field.
 *
 * The question this answers: an active-but-unbound spec sits in `.caws/specs/`
 * with no worktree binding and no lane to blame — the only creation trace was
 * the `spec_created` event's actor envelope, which requires replaying
 * events.jsonl to read. The field is PROVENANCE ONLY, never authority: it must
 * stay optional in spec.v1.json so every spec that predates it (and every
 * hand-authored spec) validates unchanged, and strictness must not loosen —
 * a near-miss field name is still a schema violation.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand, runSpecsActivateCommand } = require('../../dist/shell/commands/specs');
const { createSpec, planCreateSpec } = require('../../dist/store/specs-writer');
const { parseAndValidateSpec } = require('../../dist/kernel/spec');
const { SPEC_RULES } = require('../../dist/kernel/spec');
const { isOk, isErr } = require('../../dist/kernel/result/construct');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

/**
 * Env with competing session-identity sources stripped, so the one variable a
 * test sets is provably the one the resolver picked. Ambient CI shells have
 * been observed carrying CLAUDE_SESSION_ID; a stray value here would silently
 * outrank the variable under test (resolver precedence) and flip the assertion.
 */
function envWith(sessionVars) {
  const env = { ...process.env, CAWS_QUIET: '1' };
  for (const k of [
    'CLAUDE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_THREAD_ID',
    'DSH_SESSION_ID',
    'CAWS_SESSION_ID',
    'HOOK_SESSION_ID',
  ]) {
    delete env[k];
  }
  return { ...env, ...sessionVars };
}

function setupRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function specBody(cawsDir, id) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8');
}

function runCreate(cwd, id, env, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd,
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    env,
    id,
    title: 'session provenance fixture',
    mode: 'chore',
    riskTier: '3',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('specs create stamps created_by_session', () => {
  test('the session id the resolver picked is rendered into the spec body', () => {
    const { root, cawsDir } = setupRepo();

    const result = runCreate(root, 'PROV-STAMP-001', envWith({ CLAUDE_CODE_SESSION_ID: 'sess_test_creator' }));

    expect(result.code).toBe(0);
    expect(specBody(cawsDir, 'PROV-STAMP-001')).toContain(
      `created_by_session: 'sess_test_creator'`
    );
  });

  test('the written spec still validates, and the field round-trips through the kernel', () => {
    const { root, cawsDir } = setupRepo();

    const result = runCreate(root, 'PROV-VALID-002', envWith({ CLAUDE_CODE_SESSION_ID: 'sess_round_trip' }));
    expect(result.code).toBe(0);

    const parsed = parseAndValidateSpec(specBody(cawsDir, 'PROV-VALID-002'));
    expect(isOk(parsed)).toBe(true);
    if (isOk(parsed)) {
      expect(parsed.value.created_by_session).toBe('sess_round_trip');
    }
  });

  test('a resolver-ambiguous environment still creates the spec (no identity, no crash)', () => {
    const { root, cawsDir } = setupRepo();

    // allowMint: true means the create path always resolves SOME identity —
    // the field must never be the reason a create fails.
    const result = runCreate(root, 'PROV-MINT-003', envWith({}));

    expect(result.code).toBe(0);
    expect(specBody(cawsDir, 'PROV-MINT-003')).toMatch(/^created_by_session: '.+'$/m);
  });

  test('the full spawned-CLI parse path stamps CAWS_SESSION_ID too', () => {
    const { root, cawsDir } = setupRepo();

    const result = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'create', 'PROV-SPAWN-004',
        '--title', 'spawned provenance fixture',
        '--mode', 'chore', '--risk-tier', '3',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: envWith({ CAWS_SESSION_ID: 'sess_spawn_e2e' }),
      }
    );

    expect(result.status).toBe(0);
    expect(specBody(cawsDir, 'PROV-SPAWN-004')).toContain(`created_by_session: 'sess_spawn_e2e'`);
  });
});

describe('the field is optional and strictness is unchanged', () => {
  test('a writer-level create without createdBySession renders no line and validates', () => {
    const { cawsDir } = setupRepo();

    const result = createSpec(cawsDir, {
      id: 'PROV-ABSENT-005',
      title: 'no session supplied',
      mode: 'chore',
      riskTier: 3,
      now: () => new Date('2026-09-03T12:00:00.000Z'),
      actor: { kind: 'agent', id: 'writer-direct' },
    });
    expect(isOk(result)).toBe(true);

    const body = specBody(cawsDir, 'PROV-ABSENT-005');
    expect(body).not.toContain('created_by_session');
    expect(isOk(parseAndValidateSpec(body))).toBe(true);
  });

  test('stripping the line from a stamped spec yields a still-valid body (pre-existing specs)', () => {
    const { root, cawsDir } = setupRepo();

    expect(runCreate(root, 'PROV-STRIP-006', envWith({ CLAUDE_CODE_SESSION_ID: 'sess_strip' })).code).toBe(0);

    const withoutField = specBody(cawsDir, 'PROV-STRIP-006')
      .split('\n')
      .filter((line) => !line.startsWith('created_by_session:'))
      .join('\n');
    expect(isOk(parseAndValidateSpec(withoutField))).toBe(true);
  });

  test('a near-miss provenance field name is still rejected as a schema violation', () => {
    const { root, cawsDir } = setupRepo();

    expect(runCreate(root, 'PROV-STRICT-007', envWith({ CLAUDE_CODE_SESSION_ID: 'sess_strict' })).code).toBe(0);

    const smuggled = specBody(cawsDir, 'PROV-STRICT-007') + '\ncreated_by_sessio: sess_typo\n';
    const parsed = parseAndValidateSpec(smuggled);
    expect(isErr(parsed)).toBe(true);
    if (isErr(parsed)) {
      expect(parsed.errors.some((d) => d.rule === SPEC_RULES.SCHEMA_VIOLATION)).toBe(true);
    }
  });
});

describe('provenance survives the spec lifecycle and matches the dry run', () => {
  test('activate patches lifecycle_state and preserves the created_by_session bytes', () => {
    const { root, cawsDir } = setupRepo();

    expect(runCreate(root, 'PROV-LIFE-008', envWith({ CLAUDE_CODE_SESSION_ID: 'sess_lifecycle' })).code).toBe(0);

    const out = [];
    const err = [];
    const code = runSpecsActivateCommand({
      id: 'PROV-LIFE-008',
      cwd: root,
      env: envWith({ CLAUDE_CODE_SESSION_ID: 'sess_lifecycle' }),
      now: () => new Date('2026-09-03T12:01:00.000Z'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(code).toBe(0);

    const body = specBody(cawsDir, 'PROV-LIFE-008');
    expect(body).toContain('lifecycle_state: active');
    expect(body).toContain(`created_by_session: 'sess_lifecycle'`);
  });

  test('planCreateSpec renders the same line the real write would', () => {
    const { cawsDir } = setupRepo();

    const plan = planCreateSpec(cawsDir, {
      id: 'PROV-PLAN-009',
      title: 'plan provenance fixture',
      mode: 'chore',
      riskTier: 3,
      now: () => new Date('2026-09-03T12:00:00.000Z'),
      actor: { kind: 'agent', id: 'planner', session_id: 'sess_plan_actor' },
      createdBySession: 'sess_plan_actor',
    });
    expect(isOk(plan)).toBe(true);
    if (isOk(plan)) {
      expect(plan.value.yaml).toContain(`created_by_session: 'sess_plan_actor'`);
      // The dry run must pre-validate its own candidate — if the schema did
      // not admit the field, this valid flag is exactly what would be false.
      expect(plan.value.valid).toBe(true);
    }
  });
});
