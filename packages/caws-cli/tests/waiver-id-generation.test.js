/**
 * Tests for WaiversManager.generateWaiverId()
 *
 * Verifies:
 * - IDs match the ^WV-\d{4}$ schema pattern
 * - IDs don't collide with existing waiver files in the directory
 * - IDs don't collide with entries in active-waivers.yaml
 * - Rapid sequential generation produces unique IDs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const WaiversManager = require('../src/waivers-manager');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-waiverid-'));
  fs.mkdirSync(path.join(tmpDir, '.caws', 'waivers'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateWaiverId', () => {
  test('produces IDs matching ^WV-\\d{4}$ pattern', async () => {
    const wm = new WaiversManager({ projectRoot: tmpDir });
    const id = await wm.generateWaiverId();
    expect(id).toMatch(/^WV-\d{4}$/);
  });

  test('avoids collision with existing waiver files in directory', async () => {
    // Pre-create waiver files to occupy IDs
    const waiversDir = path.join(tmpDir, '.caws', 'waivers');
    fs.writeFileSync(path.join(waiversDir, 'WV-0001.yaml'), 'id: WV-0001\n');
    fs.writeFileSync(path.join(waiversDir, 'WV-0002.yaml'), 'id: WV-0002\n');
    fs.writeFileSync(path.join(waiversDir, 'WV-0003.yaml'), 'id: WV-0003\n');

    const wm = new WaiversManager({ projectRoot: tmpDir });
    const id = await wm.generateWaiverId();

    expect(id).toMatch(/^WV-\d{4}$/);
    expect(['WV-0001', 'WV-0002', 'WV-0003']).not.toContain(id);
  });

  test('avoids collision with entries in active-waivers.yaml', async () => {
    const waiversDir = path.join(tmpDir, '.caws', 'waivers');
    const activeWaivers = {
      waivers: {
        'WV-0005': {
          id: 'WV-0005',
          title: 'Test',
          reason: 'test reason here',
          gates: ['budget_limit'],
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          approved_by: 'test-user',
          created_at: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(
      path.join(waiversDir, 'active-waivers.yaml'),
      yaml.dump(activeWaivers)
    );

    const wm = new WaiversManager({ projectRoot: tmpDir });
    const id = await wm.generateWaiverId();

    expect(id).toMatch(/^WV-\d{4}$/);
    expect(id).not.toBe('WV-0005');
  });

  test('rapid sequential generation produces unique IDs', async () => {
    const wm = new WaiversManager({ projectRoot: tmpDir });
    const ids = new Set();

    // Generate 20 IDs rapidly — each should be unique
    // We write a file after each to simulate what createWaiver does
    const waiversDir = path.join(tmpDir, '.caws', 'waivers');
    for (let i = 0; i < 20; i++) {
      const id = await wm.generateWaiverId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      // Simulate the waiver file being written (so next call sees it)
      fs.writeFileSync(path.join(waiversDir, `${id}.yaml`), `id: ${id}\n`);
    }

    expect(ids.size).toBe(20);
  });

  test('all generated IDs are valid per schema pattern', async () => {
    const wm = new WaiversManager({ projectRoot: tmpDir });
    const waiversDir = path.join(tmpDir, '.caws', 'waivers');

    for (let i = 0; i < 10; i++) {
      const id = await wm.generateWaiverId();
      expect(id).toMatch(/^WV-\d{4}$/);
      fs.writeFileSync(path.join(waiversDir, `${id}.yaml`), `id: ${id}\n`);
    }
  });
});
