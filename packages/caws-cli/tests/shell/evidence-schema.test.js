'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runEvidenceSchemaCommand } = require('../../dist/shell/commands/evidence');
const { initProject } = require('../../dist/store/init-store');

const repos = [];

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function readEvents(repoRoot) {
  const p = path.join(repoRoot, '.caws', 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function runSchema(opts = {}) {
  const out = [];
  const err = [];
  const code = runEvidenceSchemaCommand({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws evidence schema', () => {
  test('prints kernel-derived JSON schema and example without mutating events', () => {
    const repoRoot = mkRepo('caws-evidence-schema-');
    const init = initProject(repoRoot);
    if (!init.ok) throw new Error('initProject failed: ' + JSON.stringify(init.errors));
    const before = readEvents(repoRoot);

    const result = runSchema({ kind: 'test', json: true });

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const payload = JSON.parse(result.out);
    expect(payload.read_only).toBe(true);
    expect(payload.type).toBe('test');
    expect(payload.event).toBe('test_recorded');
    expect(payload.schema.title).toBe('test_recorded event payload');
    expect(payload.required).toEqual(['command', 'exit_code']);
    expect(payload.properties).toContain('command');
    expect(payload.properties).toContain('exit_code');
    expect(payload.example.data).toEqual({ command: 'npm test', exit_code: 0 });
    expect(payload.example.command).toBe(
      'caws evidence record --type test --spec FEAT-1 --data \'{"command":"npm test","exit_code":0}\''
    );
    expect(readEvents(repoRoot)).toBe(before);
  });

  test('human output names required fields and copy-paste examples for gate and ac', () => {
    const gate = runSchema({ kind: 'gate' });
    const ac = runSchema({ kind: 'ac' });

    expect(gate.code).toBe(0);
    expect(gate.out).toContain('gate (gate_evaluated)');
    expect(gate.out).toContain('required: gate_id, mode, result');
    expect(gate.out).toContain(
      'caws evidence record --type gate --spec FEAT-1 --data \'{"gate_id":"budget_limit","mode":"block","result":"pass","violations":[]}\''
    );
    expect(ac.code).toBe(0);
    expect(ac.out).toContain('ac (ac_recorded)');
    expect(ac.out).toContain('required: criterion_id, status, evidence_ref');
    expect(ac.out).toContain(
      'caws evidence record --type ac --spec FEAT-1 --data \'{"criterion_id":"A1","status":"pass","evidence_ref":"npm test"}\''
    );
  });

  test('invalid types fail before repo or event-log access', () => {
    const result = runSchema({ kind: 'artifact' });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('invalid --type');
    expect(result.err).toContain('expected test|gate|ac');
  });
});
