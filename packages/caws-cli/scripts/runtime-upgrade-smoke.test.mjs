import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout } from 'node:timers';
import {
  observedSpawn,
  retainFixtureDiagnostics,
  captureQualificationFile,
  verifyQualificationCustody,
} from './runtime-upgrade-smoke.mjs';

test(
  'timeout stops an owned descendant before fixture cleanup',
  { skip: process.platform === 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-timeout-'));
    try {
      const ready = path.join(root, 'child-ready');
      const lateWrite = path.join(root, 'child-ran-after-timeout');
      const child = `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>fs.writeFileSync(${JSON.stringify(lateWrite)},'late'),5000);`;
      const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
      const result = observedSpawn(process.execPath, ['-e', parent], {
        cwd: root,
        env: { ...process.env, CAWS_QUALIFICATION_ARTIFACT_DIR: root },
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(result.error?.code, 'ETIMEDOUT');
      assert.equal(fs.readFileSync(ready, 'utf8'), 'ready');
      const receipt = JSON.parse(
        fs.readFileSync(
          path.join(
            root,
            fs.readdirSync(root).find((name) => name.startsWith('command-'))
          ),
          'utf8'
        )
      );
      assert.equal(receipt.timeout_cleanup.result, 'signaled');
      await new Promise((resolve) => setTimeout(resolve, 5500));
      const childLateWrite = fs.existsSync(lateWrite);
      if (process.env.CAWS_RELEASE_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.CAWS_RELEASE_ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(process.env.CAWS_RELEASE_ARTIFACT_DIR, 'timeout-cleanup.json'),
          JSON.stringify(
            { ...receipt, child_ready: true, child_late_write: childLateWrite },
            null,
            2
          ) + '\n'
        );
      }
      assert.equal(childLateWrite, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('failed qualification preserves fixture telemetry through cleanup without following links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-traces-'));
  try {
    const fixture = path.join(root, 'fixture');
    const artifacts = path.join(root, 'artifacts');
    const logs = path.join(fixture, 'claude-code-custom/.caws/sessions/probe');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'hook-events.jsonl'), '{"event":"observed"}\n');
    fs.mkdirSync(path.join(fixture, 'tmp'));
    fs.writeFileSync(
      path.join(fixture, 'tmp/caws-hook-execution-interrupted.jsonl'),
      '{"handler":"observed-before-timeout"}\n'
    );
    fs.writeFileSync(path.join(root, 'unrelated'), 'must not copy');
    fs.symlinkSync(path.join(root, 'unrelated'), path.join(logs, 'external-link'));
    retainFixtureDiagnostics(fixture, artifacts);
    fs.rmSync(fixture, { recursive: true });
    const retained = path.join(artifacts, 'failure-traces/claude-code-custom/.caws/sessions/probe');
    assert.equal(
      fs.readFileSync(path.join(retained, 'hook-events.jsonl'), 'utf8'),
      '{"event":"observed"}\n'
    );
    assert.equal(fs.existsSync(path.join(retained, 'external-link')), false);
    assert.equal(fs.existsSync(path.join(artifacts, 'unrelated')), false);
    assert.equal(
      fs.readFileSync(
        path.join(
          artifacts,
          'failure-traces/runtime-exchange/caws-hook-execution-interrupted.jsonl'
        ),
        'utf8'
      ),
      '{"handler":"observed-before-timeout"}\n'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const missing of [false, true]) {
  test(`upgrade evidence retains ${missing ? 'spawn failure' : 'failed child output and input'}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-evidence-'));
    try {
      const env = { ...process.env, CAWS_QUALIFICATION_ARTIFACT_DIR: root };
      const result = observedSpawn(
        missing ? path.join(root, 'absent-command') : process.execPath,
        missing
          ? []
          : [
              '-e',
              'process.stdout.write("observed-output"); process.stderr.write("observed-error"); process.exitCode=7;',
            ],
        { cwd: root, env, encoding: 'utf8', input: 'observed-input', timeout: 5000 }
      );
      const files = fs.readdirSync(root);
      assert.equal(files.length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, files[0]), 'utf8'));
      assert.equal(result.qualificationReceipt.file, files[0]);
      assert.equal(
        result.qualificationReceipt.sha256,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(root, files[0])))
          .digest('hex')
      );
      assert.equal(receipt.input, 'observed-input');
      assert.equal(receipt.cwd, root);
      assert.equal(receipt.exit_code, missing ? null : 7);
      assert.equal(result.status, receipt.exit_code);
      if (missing) assert.match(receipt.error, /ENOENT/);
      else {
        assert.equal(receipt.stdout, 'observed-output');
        assert.equal(receipt.stderr, 'observed-error');
        assert.equal(receipt.error, null);
      }
      assert.equal('env' in receipt, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function custodyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-custody-'));
  const sources = path.join(root, 'sources');
  const artifacts = path.join(root, 'artifacts');
  const pointer = path.join(sources, 'home/state/adapter-runtime.json');
  const proof = { guards: [], renderers: [] };
  const expected = { pointer, launcher: '/fixture/caws-hook', guards: [], renderers: [] };
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const capture = (file, name) => captureQualificationFile(file, artifacts, name);
  const save = () => write(path.join(artifacts, 'custody.json'), JSON.stringify(proof));
  const receipt = (scenario, event, status, stderr, payload) => {
    const file = `${event}-${scenario.id}.json`;
    const bytes = JSON.stringify({
      command: 'python3',
      args: ['/fixture/caws-hook', scenario.surface, event, '--system'],
      cwd: scenario.cwd,
      input: JSON.stringify({ cwd: scenario.cwd, session_id: scenario.sessionId, ...payload }),
      exit_code: status,
      signal: null,
      error: null,
      timeout_cleanup: null,
      stdout: '',
      stderr,
    });
    write(path.join(artifacts, file), bytes);
    return { file, sha256: digest(bytes) };
  };
  for (const id of [
    'migrated-codex-stock',
    'migrated-codex-custom',
    'migrated-claude-code-stock',
    'migrated-claude-code-custom',
    'linked-worktree',
    'updated-codex-stock',
    'updated-codex-custom',
    'corrupt-runtime',
    'rollback-recovered',
  ]) {
    const fixture = id.includes('claude-code')
      ? id.slice('migrated-'.length)
      : id.includes('custom')
        ? 'codex-custom'
        : 'codex-stock';
    const cwd = path.join(sources, id === 'linked-worktree' ? 'linked' : fixture);
    const target = path.join(
      sources,
      fixture,
      fixture.startsWith('codex') ? '.codex' : '.claude',
      'hooks/qualification-probe.sh'
    );
    const scenario = {
      id,
      cwd,
      target,
      surface: fixture.startsWith('codex') ? 'codex' : 'claude-code',
      sessionId: `qualification-${fixture}`,
      sentinel: `qualification-owned-sentinel:${fixture}\n`,
      digest: (id.startsWith('updated-') || id === 'corrupt-runtime' ? 'b' : 'a').repeat(64),
    };
    expected.guards.push(scenario);
    write(target, scenario.sentinel);
    fs.chmodSync(target, 0o640);
    write(pointer, JSON.stringify({ digest: scenario.digest }));
    proof.guards.push({
      id,
      before: capture(target, `${id}-before.bin`),
      after: capture(target, `${id}-after.bin`),
      runtimeBefore: capture(pointer, `${id}-runtime-before.json`),
      runtimeAfter: capture(pointer, `${id}-runtime-after.json`),
      receipt: receipt(
        scenario,
        'pre_tool_use',
        2,
        id === 'corrupt-runtime'
          ? 'Runtime modified'
          : id.startsWith('updated-')
            ? 'qualification-updated-guard'
            : 'protected path',
        {
          tool_name: 'Write',
          tool_input: { file_path: target, content: 'forbidden fixture write' },
        }
      ),
    });
  }
  for (const id of ['codex-stock', 'codex-custom']) {
    const cwd = path.join(sources, id);
    const sessionId = `qualification-update-${id}`;
    const scenario = {
      id,
      cwd,
      surface: 'codex',
      sessionId,
      marker: path.join(sources, `${id}-render-marker`),
      turn: path.join(cwd, '.caws/sessions', sessionId, 'turn-001.json'),
      transcript: path.join(sources, `${id}-transcript.jsonl`),
      prompt: `prompt-${id}`,
      callId: `call-${id}`,
      output: `output-${id}`,
      digest: 'b'.repeat(64),
    };
    expected.renderers.push(scenario);
    const markerBefore = capture(scenario.marker, `${id}-marker-before.bin`);
    const turnBefore = capture(scenario.turn, `${id}-turn-before.json`);
    write(scenario.marker, 'updated-renderer');
    write(
      scenario.transcript,
      [
        { payload: { content: [{ text: scenario.prompt }] } },
        { payload: { call_id: scenario.callId } },
        { payload: { call_id: scenario.callId, output: scenario.output } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n'
    );
    write(
      scenario.turn,
      JSON.stringify({
        context: { cwd, session_id: sessionId },
        user: scenario.prompt,
        timeline: [
          {
            kind: 'tool_call',
            id: scenario.callId,
            name: 'Bash',
            command: 'pwd',
            output: scenario.output,
          },
        ],
      })
    );
    write(pointer, JSON.stringify({ digest: scenario.digest }));
    proof.renderers.push({
      id,
      markerBefore,
      turnBefore,
      marker: capture(scenario.marker, `${id}-marker.bin`),
      turn: capture(scenario.turn, `${id}-turn.json`),
      transcript: capture(scenario.transcript, `${id}-transcript.jsonl`),
      runtimeBefore: capture(pointer, `${id}-runtime-before.json`),
      runtimeAfter: capture(pointer, `${id}-runtime-after.json`),
      receipt: receipt(scenario, 'stop', 0, '', { transcript_path: scenario.transcript }),
    });
  }
  save();
  const rewriteArtifact = (record, change) => {
    const file = path.join(artifacts, record.file);
    const value = JSON.parse(fs.readFileSync(file));
    change(value);
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(file, bytes);
    record.sha256 = digest(bytes);
    if ('size' in record) record.size = bytes.length;
  };
  return { root, sources, artifacts, proof, expected, capture, save, rewriteArtifact };
}

test('custody survives fixture teardown and retains arbitrary bytes exactly', () => {
  const f = custodyFixture();
  try {
    const file = path.join(f.sources, 'binary');
    const bytes = Buffer.from([0, 0xff, 0xfe, 0x80, 0x0a, 0x7f]);
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, 0o640);
    const record = f.capture(file, 'binary.bin');
    fs.rmSync(f.sources, { recursive: true });
    assert.deepEqual(fs.readFileSync(path.join(f.artifacts, record.file)), bytes);
    assert.equal(verifyQualificationCustody(f.artifacts, f.expected), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

for (const [name, tamper] of [
  [
    'missing before bytes',
    (f) => fs.unlinkSync(path.join(f.artifacts, f.proof.guards[0].before.file)),
  ],
  [
    'missing after bytes',
    (f) => fs.unlinkSync(path.join(f.artifacts, f.proof.guards[0].after.file)),
  ],
  [
    'corrupt after bytes',
    (f) => fs.appendFileSync(path.join(f.artifacts, f.proof.guards[0].after.file), '!'),
  ],
  [
    'retained mode change',
    (f) => fs.chmodSync(path.join(f.artifacts, f.proof.guards[0].after.file), 0o600),
  ],
  [
    'unsafe target write with fresh hash',
    (f) => {
      const scenario = f.expected.guards[0];
      fs.writeFileSync(scenario.target, 'unsafe executor changed target');
      f.proof.guards[0].after = f.capture(scenario.target, 'unsafe-after.bin');
    },
  ],
  [
    'actual target mode change',
    (f) => {
      fs.chmodSync(f.expected.guards[0].target, 0o600);
      f.proof.guards[0].after = f.capture(f.expected.guards[0].target, 'changed-mode-after.bin');
    },
  ],
  [
    'missing marker',
    (f) => fs.unlinkSync(path.join(f.artifacts, f.proof.renderers[0].marker.file)),
  ],
  [
    'corrupt marker',
    (f) => fs.appendFileSync(path.join(f.artifacts, f.proof.renderers[0].marker.file), '!'),
  ],
  [
    'missing rendered turn',
    (f) => fs.unlinkSync(path.join(f.artifacts, f.proof.renderers[0].turn.file)),
  ],
  [
    'corrupt rendered turn',
    (f) => fs.appendFileSync(path.join(f.artifacts, f.proof.renderers[0].turn.file), '!'),
  ],
  [
    'wrong rendered user with fresh hash',
    (f) =>
      f.rewriteArtifact(f.proof.renderers[0].turn, (turn) => {
        turn.user = 'wrong user';
      }),
  ],
  [
    'wrong rendered tool with fresh hash',
    (f) =>
      f.rewriteArtifact(f.proof.renderers[0].turn, (turn) => {
        turn.timeline[0].output = 'wrong result';
      }),
  ],
  [
    'preexisting rendered output',
    (f) => {
      f.proof.renderers[0].turnBefore = f.proof.renderers[0].turn;
    },
  ],
  [
    'payload target override with fresh receipt hash',
    (f) =>
      f.rewriteArtifact(f.proof.guards[0].receipt, (receipt) => {
        const payload = JSON.parse(receipt.input);
        payload.tool_input.file_path = '/different/target';
        receipt.input = JSON.stringify(payload);
      }),
  ],
  [
    'wrong denial status with fresh receipt hash',
    (f) =>
      f.rewriteArtifact(f.proof.guards[0].receipt, (receipt) => {
        receipt.exit_code = 0;
      }),
  ],
  [
    'wrong launcher with fresh receipt hash',
    (f) =>
      f.rewriteArtifact(f.proof.guards[0].receipt, (receipt) => {
        receipt.args[0] = '/wrong/caws-hook';
      }),
  ],
  [
    'timeout despite denial status',
    (f) =>
      f.rewriteArtifact(f.proof.guards[0].receipt, (receipt) => {
        receipt.error = 'ETIMEDOUT';
      }),
  ],
  [
    'cross-project Stop receipt',
    (f) => {
      f.proof.renderers[0].receipt = f.proof.renderers[1].receipt;
    },
  ],
  [
    'wrong rollback runtime with fresh hash',
    (f) => {
      const record = f.proof.guards.find(({ id }) => id === 'rollback-recovered');
      f.rewriteArtifact(record.runtimeAfter, (pointer) => {
        pointer.digest = 'b'.repeat(64);
      });
    },
  ],
  [
    'missing scenario',
    (f) => {
      f.proof.guards.pop();
    },
  ],
]) {
  test(`custody verifier rejects ${name}`, () => {
    const f = custodyFixture();
    try {
      tamper(f);
      f.save();
      assert.throws(() => verifyQualificationCustody(f.artifacts, f.expected));
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
}
