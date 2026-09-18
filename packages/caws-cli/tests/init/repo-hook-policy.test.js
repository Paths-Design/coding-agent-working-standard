'use strict';

/**
 * Repo-local hook policy: validator + chain resolver.
 *
 * CAWS-REPO-HOOK-POLICY-RESOLVER-01 (A1-A5).
 *
 * The subject is an AUTHORITY boundary: this document decides which guards run
 * in a repo, so the tests weight the hostile path — a document that tries to
 * remove the guard protecting the document, a document that half-applies, a
 * document whose target escapes the repo.
 */

const {
  parseRepoHookPolicy,
  resolveChain,
  effectiveRepoSurfacePolicy,
  emptyRepoHookPolicy,
  REPO_POLICY_FLOOR,
  HOOK_POLICY_VERSION,
  REPO_HOOK_POLICY_PATH,
} = require('../../dist/init/repo-hook-policy');

/** A minimal valid document; callers override one thing to make it hostile. */
function doc(surfaces, guards) {
  return JSON.stringify({ version: 1, surfaces: surfaces || {}, guards: guards || {} });
}

const STOCK = [
  'block-dangerous.sh',
  'protected-paths.sh',
  'scope-guard.sh',
  'agent-register.sh --quiet',
];

function parsedSurface(surfaces, name) {
  const result = parseRepoHookPolicy(doc(surfaces));
  expect(result.ok).toBe(true);
  return effectiveRepoSurfacePolicy(result.policy, name || 'claude-code');
}

// ── A1: the floor ─────────────────────────────────────────────────────────

describe('A1: a repo policy cannot remove or no-op a floor handler', () => {
  test.each(REPO_POLICY_FLOOR)('disabling %s is rejected', (handler) => {
    const result = parseRepoHookPolicy(doc({ default: { disabled: { pre_tool_use: [handler] } } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(handler);
    expect(result.error).toContain('repo-policy floor');
  });

  test.each(REPO_POLICY_FLOOR)('remapping %s to a local file is rejected too', (handler) => {
    // Replace-with-a-stub is observationally equivalent to disable. Gating only
    // `disabled` would leave the bypass one key away.
    const result = parseRepoHookPolicy(
      doc({ default: { handlers: { [handler]: '.caws/hooks/ext/noop.sh' } } })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain(handler);
    expect(result.error).toContain('repo-policy floor');
  });

  test('the floor is exactly the three handlers that keep the policy reviewable', () => {
    // Pins membership, so widening the floor is a deliberate edit rather than a
    // drive-by. scope-guard.sh must stay OFF it: fencing that guard is what
    // pushes a repo to fork instead of extend.
    expect([...REPO_POLICY_FLOOR].sort()).toEqual([
      'agent-register.sh',
      'block-dangerous.sh',
      'protected-paths.sh',
    ]);
    expect(REPO_POLICY_FLOOR).not.toContain('scope-guard.sh');
  });

  test('a NON-floor guard may be disabled and remapped — the feature still works', () => {
    // Discrimination control: without this, every A1 arm would pass on an
    // implementation that rejected all disabled/handlers entries outright.
    const result = parseRepoHookPolicy(
      doc({
        default: {
          disabled: { pre_tool_use: ['scope-guard.sh'] },
          handlers: { 'rg-replace-guard.sh': '.caws/hooks/ext/rg-replace-guard.sh' },
        },
      })
    );
    expect(result.ok).toBe(true);
    expect(result.policy.surfaces.default.disabled.pre_tool_use).toEqual(['scope-guard.sh']);
    expect(result.policy.surfaces.default.handlers['rg-replace-guard.sh']).toBe(
      '.caws/hooks/ext/rg-replace-guard.sh'
    );
  });

  test('the floor binds the REPO tier only — the machine tier may still disable a floor handler', () => {
    // An operator changing their own machine is the sanctioned escape hatch and
    // affects only that machine. If this ever starts failing, the floor has
    // leaked into the machine tier and taken the escape hatch with it.
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({}),
      machine: {
        disabled: { pre_tool_use: ['protected-paths.sh'] },
        extensions: {},
        handlers: {},
        libraries: {},
      },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers).not.toContain('protected-paths.sh');
  });
});

// ── A2: absent policy is the identity ─────────────────────────────────────

describe('A2: an absent policy resolves to the stock chain unchanged', () => {
  test('null input is the identity policy, not an error', () => {
    const result = parseRepoHookPolicy(null);
    expect(result.ok).toBe(true);
    expect(result.policy).toEqual(emptyRepoHookPolicy());
  });

  test('the resolved chain is element-for-element the stock chain', () => {
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: effectiveRepoSurfacePolicy(emptyRepoHookPolicy(), 'claude-code'),
    });
    expect(resolved.ok).toBe(true);
    // Exact sequence, not length or membership: order IS the semantics here —
    // a guard spliced into the wrong position adjudicates against different
    // state than the one it was meant to precede.
    expect(resolved.handlers).toEqual(STOCK);
    expect(resolved.handlerOverrides).toEqual({});
    expect(resolved.libraries).toEqual({});
  });

  test('an empty document also leaves the chain untouched', () => {
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({}),
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers).toEqual(STOCK);
  });
});

// ── A3: fail closed, all-or-nothing ───────────────────────────────────────

describe('A3: a malformed or over-authority document applies ZERO entries', () => {
  test('unparseable JSON is rejected and names the file', () => {
    const result = parseRepoHookPolicy('{ not json');
    expect(result.ok).toBe(false);
    expect(result.error).toContain(REPO_HOOK_POLICY_PATH);
  });

  test('an unknown top-level key is rejected', () => {
    const result = parseRepoHookPolicy(
      JSON.stringify({ version: 1, surfaces: {}, guards: {}, handlers: {} })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('admits only version, surfaces and guards');
  });

  test('a wrong version is rejected', () => {
    const result = parseRepoHookPolicy(JSON.stringify({ version: 2, surfaces: {}, guards: {} }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`version must be ${HOOK_POLICY_VERSION}`);
  });

  test('an unknown per-surface key is rejected', () => {
    const result = parseRepoHookPolicy(doc({ default: { disabled: {}, sneaky: {} } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('surfaces.default');
  });

  test('an unknown event name is rejected', () => {
    const result = parseRepoHookPolicy(doc({ default: { disabled: { on_tuesday: ['x.sh'] } } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('on_tuesday');
  });

  test('ONE bad entry discards the whole document, not just that entry', () => {
    // The all-or-nothing invariant. A partial application is the dangerous
    // shape: the repo believes a policy is in force while half of it was
    // dropped, and nothing reports the loss.
    const result = parseRepoHookPolicy(
      doc({
        default: {
          disabled: { pre_tool_use: ['scope-guard.sh'] }, // valid
          handlers: { 'protected-paths.sh': '.caws/hooks/ext/noop.sh' }, // floor violation
        },
      })
    );
    expect(result.ok).toBe(false);
    expect(result.policy).toBeUndefined();
  });

  test.each([
    ['an absolute target', '/etc/evil.sh', 'repo-relative'],
    ['a traversing target', '../../../etc/evil.sh', 'traverse'],
    ['a glob target', '.caws/hooks/ext/*.sh', 'glob'],
  ])('%s is rejected', (_label, target, expected) => {
    const result = parseRepoHookPolicy(doc({ default: { handlers: { 'x-guard.sh': target } } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(expected);
  });

  test('overriding the lib that RESOLVES overrides is rejected (bootstrap cycle)', () => {
    for (const lib of ['agent-surface.sh', 'runtime-paths.sh']) {
      const result = parseRepoHookPolicy(
        doc({ default: { libraries: { [lib]: '.caws/hooks/lib-local/x.sh' } } })
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain(lib);
    }
  });

  test('an extension without a substantive reason is rejected', () => {
    // The reason is what makes "the guard plane was changed" a reviewable
    // artifact rather than an undocumented diff.
    const result = parseRepoHookPolicy(
      doc({
        default: {
          extensions: { pre_tool_use: [{ handler: 'x.sh', before: null, reason: 'because' }] },
        },
      })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('reason');
  });

  test('a fork record requires real provenance, not a placeholder sha', () => {
    const result = parseRepoHookPolicy(
      doc({
        default: {
          forks: {
            'scope-guard.sh': {
              forked_from: { pack: 'shared', pack_version: 67, sha256: 'deadbeef' },
              reason: 'needs extra allow prefixes for the native/ tree',
              approver: '@maintainer',
            },
          },
        },
      })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sha256');
  });
});

// ── A4: two-tier precedence ───────────────────────────────────────────────

describe('A4: repo resolves before machine, and duplicates fail closed', () => {
  test('repo disable + machine extension compose in the declared order', () => {
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({
        default: {
          disabled: { pre_tool_use: ['scope-guard.sh'] },
          extensions: {
            pre_tool_use: [
              {
                handler: 'repo-guard.sh',
                before: 'agent-register.sh',
                reason: 'repo-specific layout check',
              },
            ],
          },
        },
      }),
      machine: {
        disabled: {},
        extensions: {
          pre_tool_use: [{ handler: 'operator-guard.sh', before: null, reason: 'local only' }],
        },
        handlers: {},
        libraries: {},
      },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers).toEqual([
      'block-dangerous.sh',
      'protected-paths.sh',
      'repo-guard.sh',
      'agent-register.sh --quiet',
      'operator-guard.sh',
    ]);
  });

  test('an anchor is matched on the BASENAME, so a stock entry with arguments still anchors', () => {
    // `agent-register.sh --quiet` must be findable by the anchor
    // `agent-register.sh`; matching the whole entry would silently fail to
    // resolve and surface as "anchor is absent" for a handler plainly present.
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({
        default: {
          extensions: {
            pre_tool_use: [
              { handler: 'x.sh', before: 'agent-register.sh', reason: 'anchored on an argv entry' },
            ],
          },
        },
      }),
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers.indexOf('x.sh')).toBe(3);
  });

  test('an absent anchor fails closed and names the anchor', () => {
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({
        default: {
          extensions: {
            pre_tool_use: [
              { handler: 'x.sh', before: 'not-installed.sh', reason: 'anchor does not exist' },
            ],
          },
        },
      }),
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toContain('not-installed.sh');
  });

  test('a handler duplicated across tiers is refused, not spliced twice', () => {
    // A guard that runs twice returns two verdicts for one call.
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({
        default: {
          extensions: {
            pre_tool_use: [{ handler: 'dup.sh', before: null, reason: 'team-wide addition' }],
          },
        },
      }),
      machine: {
        disabled: {},
        extensions: {
          pre_tool_use: [{ handler: 'dup.sh', before: null, reason: 'operator addition' }],
        },
        handlers: {},
        libraries: {},
      },
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toContain('dup.sh');
  });

  test('machine wins over repo on the same handler override basename', () => {
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({ default: { handlers: { 'x-guard.sh': '.caws/hooks/ext/repo.sh' } } }),
      machine: {
        disabled: {},
        extensions: {},
        handlers: { 'x-guard.sh': '/home/op/machine.sh' },
        libraries: {},
      },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlerOverrides['x-guard.sh']).toBe('/home/op/machine.sh');
  });

  test('a policy keyed to a DIFFERENT event does not touch this event', () => {
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: parsedSurface({ default: { disabled: { stop: ['scope-guard.sh'] } } }),
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers).toEqual(STOCK);
  });

  test('`default` and a named surface merge per key rather than replacing wholesale', () => {
    // This is what removes the duplication a repo hand-rolling the pattern ends
    // up with: two near-identical per-surface copies re-synced by hand.
    const surface = parsedSurface(
      {
        default: {
          extensions: {
            pre_tool_use: [
              { handler: 'shared.sh', before: null, reason: 'every surface needs it' },
            ],
          },
          handlers: { 'a.sh': '.caws/hooks/ext/a.sh' },
        },
        'claude-code': {
          extensions: {
            pre_tool_use: [{ handler: 'claude-only.sh', before: null, reason: 'claude specific' }],
          },
          handlers: { 'b.sh': '.caws/hooks/ext/b.sh' },
        },
      },
      'claude-code'
    );
    expect(surface.extensions.pre_tool_use.map((e) => e.handler)).toEqual([
      'shared.sh',
      'claude-only.sh',
    ]);
    expect(Object.keys(surface.handlers).sort()).toEqual(['a.sh', 'b.sh']);
  });

  test('a surface with no entry of its own still inherits `default`', () => {
    const surface = parsedSurface(
      {
        default: { disabled: { pre_tool_use: ['scope-guard.sh'] } },
      },
      'codex'
    );
    expect(surface.disabled.pre_tool_use).toEqual(['scope-guard.sh']);
  });
});

// ── A5: forward compatibility of the key set ──────────────────────────────

describe('A5: all three top-level keys are admitted in v1', () => {
  test('a document declaring guards validates even though the resolver ignores it', () => {
    // Runtime validators assert EXACT key sets. If `guards` were introduced
    // later, every repo pinned to this runtime would hard-block on a document
    // using it. Admitting it now is the decision that cannot be deferred.
    const result = parseRepoHookPolicy(
      doc({}, { 'scope-guard.sh': { additional_allow_prefixes: [{ prefix: 'native/' }] } })
    );
    expect(result.ok).toBe(true);
    expect(result.policy.guards['scope-guard.sh']).toBeDefined();
  });

  test('guards content does not leak into the resolved chain in this slice', () => {
    const result = parseRepoHookPolicy(
      doc({}, { 'scope-guard.sh': { thresholds: { loc: 2500 } } })
    );
    const resolved = resolveChain({
      stock: STOCK,
      event: 'pre_tool_use',
      repo: effectiveRepoSurfacePolicy(result.policy, 'claude-code'),
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers).toEqual(STOCK);
  });

  test('guards must still be an object, not an array or scalar', () => {
    for (const bad of ['[]', '"x"', '3']) {
      const result = parseRepoHookPolicy(`{"version":1,"surfaces":{},"guards":${bad}}`);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('guards');
    }
  });
});
