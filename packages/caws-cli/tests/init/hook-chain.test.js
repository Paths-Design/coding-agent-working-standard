'use strict';

/**
 * The compiled-chain renderer (CAWS-HOOKS-READONLY-VERBS-01).
 *
 * The invariant these arms exist for: the renderer must never emit a file its
 * own parser would refuse. `local-chain.sh` is fail-CLOSED — an unparseable
 * sidecar blocks the call with exit 2 — so an over-permissive renderer does
 * not produce a bad config, it produces an outage on every tool call for every
 * project-wired surface, from a file the agent is not allowed to edit.
 *
 * Parity is therefore proven by RUNNING the real bash parser over the real
 * rendered bytes, not by asserting that two copies of a regex agree. A
 * duplicated-regex assertion would keep passing on the day the parser changed.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CHAIN_HEADER_PREFIX,
  chainEntryViolation,
  chainStaleness,
  chainTargetViolation,
  parseChainHeader,
  policyDigest,
  renderChainFile,
} = require('../../dist/init/hook-chain');

const LIB = path.resolve(__dirname, '..', '..', 'templates/hook-packs/shared/lib/local-chain.sh');

const base = {
  surface: 'opencode',
  event: 'pre_tool_use',
  policySha256: 'abc123',
  pack: 83,
};

/**
 * Write `content` as the sidecar and run the REAL parser over it.
 * Returns { status, chain, stdout } — status 0 with the parsed sequence, or
 * the parser's refusal status (2) when it blocks.
 */
function runRealParser(content, event = 'pre_tool_use') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-chain-'));
  try {
    fs.mkdirSync(path.join(dir, 'hooks', 'dispatch'), { recursive: true });
    fs.copyFileSync(LIB, path.join(dir, 'hooks', 'local-chain.sh'));
    fs.writeFileSync(path.join(dir, 'hooks', 'dispatch', `${event}.chain`), content);
    const script = `
      set -uo pipefail
      export CAWS_HOOKS_DIR='${dir}/hooks'
      export CAWS_PROJECT_DIR='${dir}'
      source '${dir}/hooks/local-chain.sh'
      if caws_local_chain '${event}'; then
        printf 'CHAIN:%s\\n' "\${CAWS_LOCAL_CHAIN[*]:-}"
      else
        printf 'NOCHAIN\\n'
      fi
    `;
    try {
      const stdout = execFileSync('/bin/bash', ['-c', script], {
        encoding: 'utf8',
        // A test that shells out inherits the harness environment; strip the
        // session vars so this behaves the same in CI and inside an agent.
        env: { PATH: process.env.PATH, HOME: dir },
      });
      return { status: 0, stdout };
    } catch (err) {
      return { status: err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('renderer/parser parity is proven against the real bash parser', () => {
  test('a plain sequence round-trips through local-chain.sh in order', () => {
    const rendered = renderChainFile({
      ...base,
      handlers: ['block-dangerous.sh', 'scope-guard.sh', 'protected-paths.sh'],
      overrides: {},
    });
    const result = runRealParser(rendered);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CHAIN:block-dangerous.sh scope-guard.sh protected-paths.sh');
  });

  test('an override target round-trips, and the entry keeps its arguments', () => {
    const rendered = renderChainFile({
      ...base,
      event: 'stop',
      handlers: ['session-log.sh stop', 'agent-stop.sh'],
      overrides: { 'session-log.sh': '.caws/hooks/ext/session-log.local.sh' },
    });
    // The override is attached by BASENAME while the entry keeps its args.
    expect(rendered).toContain('session-log.sh stop\t.caws/hooks/ext/session-log.local.sh');
    const result = runRealParser(rendered, 'stop');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CHAIN:session-log.sh stop agent-stop.sh');
  });

  test('a chain with no handlers is a valid EMPTY chain, not a parse failure', () => {
    // The header is what makes emptiness explicit; the parser treats a
    // header-only file as a deliberate empty chain rather than falling back.
    const rendered = renderChainFile({ ...base, handlers: [], overrides: {} });
    const result = runRealParser(rendered);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CHAIN:');
    expect(result.stdout).not.toContain('NOCHAIN');
  });

  test('the parity harness can actually observe a refusal', () => {
    // Discrimination control for the three arms above. Without it they would
    // all pass against a harness that reported status 0 unconditionally.
    const result = runRealParser(`${CHAIN_HEADER_PREFIX}surface=x event=y pack=1\nnot-a-script\n`);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('malformed handler entry');
  });
});

describe('the renderer refuses rather than emitting an outage', () => {
  test.each([
    ['an absolute target', '/etc/evil.sh', /repo-relative/],
    ['a traversing target', '../../etc/evil.sh', /traverse/],
    ['a glob target', '.caws/hooks/ext/*.sh', /glob/],
    ['a tab in the target', '.caws/hooks/ext/a\tb.sh', /tab or newline/],
    ['an empty target', '', /empty/],
  ])('%s throws instead of being written', (_label, target, pattern) => {
    expect(() =>
      renderChainFile({
        ...base,
        handlers: ['scope-guard.sh'],
        overrides: { 'scope-guard.sh': target },
      })
    ).toThrow(pattern);
  });

  test('a non-.sh handler entry throws', () => {
    expect(() => renderChainFile({ ...base, handlers: ['not-a-script'], overrides: {} })).toThrow(
      /malformed handler entry/
    );
  });

  test('a handler carrying an illegal argument character throws', () => {
    // `$` is outside the parser's argument grammar; admitting it here would
    // put shell metacharacters into a file the dispatcher reads.
    expect(() =>
      renderChainFile({ ...base, handlers: ['session-log.sh $EVIL'], overrides: {} })
    ).toThrow(/malformed handler entry/);
  });

  test('violation helpers agree with the render-time refusals', () => {
    expect(chainTargetViolation('.caws/hooks/ext/ok.sh')).toBeNull();
    expect(chainTargetViolation('/abs.sh')).toMatch(/repo-relative/);
    expect(chainEntryViolation('agent-register.sh --quiet')).toBeNull();
    expect(chainEntryViolation('agent-register')).toMatch(/malformed/);
  });
});

describe('header round-trip', () => {
  test('a rendered header parses back to the same fields', () => {
    const rendered = renderChainFile({ ...base, handlers: ['scope-guard.sh'], overrides: {} });
    expect(parseChainHeader(rendered)).toEqual(base);
  });

  test('a file with no header parses as null', () => {
    expect(parseChainHeader('scope-guard.sh\n')).toBeNull();
  });

  test('a header missing a required field parses as null, not a partial object', () => {
    expect(parseChainHeader(`${CHAIN_HEADER_PREFIX}surface=x event=y pack=1\n`)).toBeNull();
  });
});

describe('policyDigest distinguishes absent from empty', () => {
  test('an absent policy is not the digest of an empty document', () => {
    expect(policyDigest(null)).toBe('absent');
    expect(policyDigest('{}')).not.toBe('absent');
    expect(policyDigest('{}')).toHaveLength(64);
  });

  test('the digest changes with the bytes', () => {
    expect(policyDigest('{"version":1}')).not.toBe(policyDigest('{"version": 1}'));
  });
});

describe('staleness is decided on BYTES, not on the header', () => {
  const current = renderChainFile({
    ...base,
    handlers: ['block-dangerous.sh', 'scope-guard.sh'],
    overrides: {},
  });

  test('identical bytes are fresh', () => {
    expect(chainStaleness(current, current)).toEqual({ stale: false });
  });

  test('an absent chain is stale and says so', () => {
    expect(chainStaleness(null, current)).toEqual({
      stale: true,
      reason: 'no compiled chain on disk',
    });
  });

  test('a pack bump is reported as a pack bump', () => {
    const older = renderChainFile({
      ...base,
      pack: 82,
      handlers: ['block-dangerous.sh', 'scope-guard.sh'],
      overrides: {},
    });
    expect(chainStaleness(older, current)).toEqual({
      stale: true,
      reason: 'compiled against pack 82, shipping 83',
    });
  });

  test('a policy change is reported as a policy change', () => {
    const other = renderChainFile({
      ...base,
      policySha256: 'deadbeef',
      handlers: ['block-dangerous.sh', 'scope-guard.sh'],
      overrides: {},
    });
    expect(chainStaleness(other, current).reason).toMatch(/different hook-policy/);
  });

  test('THE DANGEROUS CASE: an identical header with a differing body is stale', () => {
    // The stock chain moved underneath an unchanged policy — a pack upgrade
    // that added or reordered a guard. The policy digest is unchanged because
    // the policy is unchanged, and the pack field can match when the sidecar
    // was recompiled for an unrelated reason. Only a body comparison catches
    // it; a header comparison would call this fresh and the repo would keep
    // running a guard chain that no longer matches what ships.
    const sameHeaderDifferentBody = renderChainFile({
      ...base,
      handlers: ['block-dangerous.sh'],
      overrides: {},
    });
    expect(parseChainHeader(sameHeaderDifferentBody)).toEqual(parseChainHeader(current));
    expect(chainStaleness(sameHeaderDifferentBody, current)).toEqual({
      stale: true,
      reason: 'compiled chain body differs from the current policy',
    });
  });

  test('a headerless file on disk is named as such', () => {
    expect(chainStaleness('scope-guard.sh\n', current).reason).toMatch(/no recognizable header/);
  });
});
