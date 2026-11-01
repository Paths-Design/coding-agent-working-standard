'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSpecs } = require('../../dist/store/specs-store');

let root;
let specsDir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-specs-read-'));
  specsDir = path.join(root, 'specs');
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR', undefined])(
  'hidden specs read failure (%s) is diagnosed rather than absent',
  (code) => {
    const exists = fs.existsSync;
    const read = fs.readdirSync;
    jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((target) => (target === specsDir ? false : exists(target)));
    jest.spyOn(fs, 'readdirSync').mockImplementation((target, ...args) => {
      if (target === specsDir) throw Object.assign(new Error('specs read fault'), { code });
      return read(target, ...args);
    });
    const loaded = loadSpecs(root);
    expect(loaded.specs).toEqual([]);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]).toMatchObject({
      rule: 'store.read.io_failed',
      severity: 'error',
      subject: specsDir,
      message: `Failed to read ${specsDir}: specs read fault.`,
      data: { code },
    });
  }
);

test('missing and readable empty specs directories both resolve empty without diagnostics', () => {
  expect(loadSpecs(root)).toEqual({ specs: [], diagnostics: [] });
  fs.mkdirSync(specsDir);
  expect(loadSpecs(root)).toEqual({ specs: [], diagnostics: [] });
});
