'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLeases, safeLeaseFilename } = require('../../dist/store/leases-store');

test('heartbeat caches are separate from leases without hiding malformed sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-lease-cache-'));
  try {
    const dir = path.join(root, 'leases'); fs.mkdirSync(dir);
    const files = {
      'heartbeat-emit-state.json': '{"peer_set_hash":"fixture","peer_count":2,"last_emitted_ts_ms":1}',
      'heartbeat-escalation-state.json': '{"fixture-session":1}',
      'heartbeat-session.json': '{"session_id":"heartbeat-session","status":"active"}',
      'broken-session.json': '{"session_id":"different-session"}',
    };
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    const result = loadLeases(root);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.value.leases)).toEqual(['heartbeat-session']);
    expect(result.value.diagnostics.map(d => path.basename(d.subject))).toEqual(['broken-session.json']);
    for (const [name, bytes] of Object.entries(files)) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(bytes);
    // These exact filenames belong to telemetry even when its bytes are bad.
    fs.writeFileSync(path.join(dir, 'heartbeat-emit-state.json'), 'malformed cache');
    expect(loadLeases(root).value.diagnostics.map(d => path.basename(d.subject))).toEqual(['broken-session.json']);
    expect(fs.existsSync(path.join(root, 'events.jsonl'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session writes cannot collide with the two reserved heartbeat caches', () => {
  for (const id of ['heartbeat-emit-state', 'heartbeat-escalation-state']) {
    expect(safeLeaseFilename(id).ok).toBe(false);
  }
  expect(safeLeaseFilename('heartbeat-session').ok).toBe(true);
});
