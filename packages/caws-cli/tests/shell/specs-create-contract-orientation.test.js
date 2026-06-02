/**
 * FIX-SPECS-CONTRACT-ORIENTATION-001 — shell-level --contract wiring +
 * tier-1/2 contract-requirement orientation.
 *
 * Drives runSpecsCreateCommand in-process (the same entry register.ts invokes)
 * and asserts on captured stdout/stderr + the on-disk spec YAML:
 *   - tier-2 create with NO contract is rejected, the rejection renders the
 *     kernel narrowRepair (A1) AND the inline contract shape (A2), and cites
 *     NO unshipped docs/guides/caws-contracts.md pointer (A3);
 *   - tier-2 create WITH --contract succeeds in one command and writes a valid
 *     contracts: block (A5);
 *   - an invalid --contract type is rejected naming the enum (A5);
 *   - the post-create guidance never points at the unshipped doc (A3).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runSpecsCreateCommand } = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  return root;
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
function setup(prefix) {
  const repoRoot = mkBareGitRepo(prefix);
  const initResult = initProject(repoRoot);
  if (!initResult.ok) throw new Error('initProject failed');
  return { repoRoot, cawsDir: path.join(repoRoot, '.caws') };
}
function capture(fn, opts) {
  const out = []; const err = [];
  const code = fn({ ...opts, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('caws specs create --contract orientation (FIX-SPECS-CONTRACT-ORIENTATION-001)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-contract-')); });
  afterEach(() => rmrf(repoRoot));

  // A1 + A2 + A3: tier-2 with no contract is rejected; the rejection carries
  // the narrowRepair AND the inline shape, and no dangling doc pointer.
  it('tier-2 with no contract: rejection renders narrowRepair + inline shape, no dangling doc', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-201',
      title: 'tier-2 no contract',
      mode: 'feature',
      riskTier: 2,
    });
    expect(r.code).toBe(1);
    // A1: the kernel narrowRepair is surfaced (not only the bare message).
    expect(r.stderr).toMatch(/Add at least one contract or change risk_tier to 3 or mode to chore/);
    // A2: the contract shape is inline.
    expect(r.stderr).toMatch(/name, type: api\|schema\|contract-test\|behavior/);
    // A2: the one-command path is shown.
    expect(r.stderr).toMatch(/--contract/);
    // A3: NO unshipped repo-internal doc pointer.
    expect(r.stderr).not.toMatch(/docs\/guides\/caws-contracts\.md/);
    // No spec file written on rejection.
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'FEAT-201.yaml'))).toBe(false);
  });

  // A5: tier-2 WITH --contract succeeds in one command, valid contracts: block.
  it('tier-2 with --contract creates a valid spec in one command', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-202',
      title: 'tier-2 with contract',
      mode: 'feature',
      riskTier: 2,
      contract: ['core-api:behavior'],
    });
    expect(r.code).toBe(0);
    const yaml = fs.readFileSync(path.join(cawsDir, 'specs', 'FEAT-202.yaml'), 'utf8');
    expect(yaml).toMatch(/contracts:/);
    expect(yaml).toMatch(/- name: 'core-api'/);
    expect(yaml).toMatch(/type: behavior/);
    // It must NOT have the empty-array form when a contract was supplied.
    expect(yaml).not.toMatch(/contracts: \[\]/);
  });

  // A5: --contract with a path field round-trips.
  it('--contract with a path writes the path field', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-203',
      title: 'contract with path',
      mode: 'feature',
      riskTier: 2,
      contract: ['the-schema:schema:contracts/the.json'],
    });
    expect(r.code).toBe(0);
    const yaml = fs.readFileSync(path.join(cawsDir, 'specs', 'FEAT-203.yaml'), 'utf8');
    expect(yaml).toMatch(/- name: 'the-schema'/);
    expect(yaml).toMatch(/type: schema/);
    expect(yaml).toMatch(/path: 'contracts\/the\.json'/);
  });

  // A5: invalid contract type is rejected, naming the enum.
  it('rejects an invalid --contract type, naming the enum', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-204',
      title: 'bad contract type',
      mode: 'feature',
      riskTier: 2,
      contract: ['x:not-a-type'],
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not one of api, schema, contract-test, behavior/);
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'FEAT-204.yaml'))).toBe(false);
  });

  // A3: the post-create SUCCESS guidance also never cites the unshipped doc.
  it('post-create guidance never cites the unshipped caws-contracts.md', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-205',
      title: 'tier-3 chore',
      mode: 'chore',
      riskTier: 3,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/docs\/guides\/caws-contracts\.md/);
    // The orientation is still present, inlined.
    expect(r.stdout).toMatch(/name, type: api\|schema\|contract-test\|behavior/);
  });

  // A5 (Commander-level): the in-process tests above pass `contract:[...]`
  // straight to the handler, which does NOT exercise the register.ts opt-mapping
  // layer. The first live run revealed --contract was parsed by Commander but
  // DROPPED at register.ts (the action only forwarded title/mode/riskTier/scopeIn),
  // so a real `--contract` never reached the writer while the handler test passed.
  // This drives the FULL parse path (registerShellCommands -> Commander -> action
  // -> handler -> on-disk YAML) so that gap can never silently reopen.
  it('--contract flows through Commander/register into the written spec (full parse path)', async () => {
    const { Command } = require('commander');
    const { registerShellCommands } = require('../../dist/shell');
    const origCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      const program = new Command();
      program.exitOverride();
      program.name('caws').version('test');
      registerShellCommands(program, { exit: () => {} });
      await program.parseAsync(
        ['specs', 'create', 'FEAT-206',
          '--title', 'full parse path',
          '--mode', 'feature',
          '--risk-tier', '2',
          '--contract', 'core-api:behavior'],
        { from: 'user' }
      );
      const specPath = path.join(cawsDir, 'specs', 'FEAT-206.yaml');
      // The spec must have been CREATED (not rejected) and carry the contract —
      // proving --contract survived the register.ts mapping layer.
      expect(fs.existsSync(specPath)).toBe(true);
      const yaml = fs.readFileSync(specPath, 'utf8');
      expect(yaml).toMatch(/- name: 'core-api'/);
      expect(yaml).toMatch(/type: behavior/);
      expect(yaml).not.toMatch(/contracts: \[\]/);
    } finally {
      process.chdir(origCwd);
    }
  });
});
