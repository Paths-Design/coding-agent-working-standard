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
  disabledHandlers,
  serializeRepoHookPolicy,
  policyAddExtension,
  policyDisableHandler,
  policyReplaceHandler,
  policyRestoreHandler,
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
    // The bare spelling normalizes to an entry carrying no justification — that
    // null is the back-compat guarantee, not an omission.
    expect(result.policy.surfaces.default.disabled.pre_tool_use).toEqual([
      { handler: 'scope-guard.sh', reason: null },
    ]);
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
    expect(disabledHandlers(surface.disabled.pre_tool_use)).toEqual(['scope-guard.sh']);
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

/**
 * CAWS-HOOKS-MUTATING-VERBS-01.
 *
 * The writer half. The reader above decides what a document MEANS; these decide
 * what the governed verbs are allowed to WRITE. The load-bearing property is
 * that the two agree: every mutator returns a policy that has already survived
 * a serialize/parse round trip, so no verb can emit a file the launcher would
 * refuse — a failure mode whose blast radius is every tool call in the repo,
 * from a file the agent is not permitted to repair.
 */

const A_REASON = 'this repo keeps its guards in native/ instead of src/';

/** The reader's verdict on what a mutator produced. */
function reparse(policy) {
  return parseRepoHookPolicy(serializeRepoHookPolicy(policy));
}

describe('disabled admits two spellings and only one carries a justification', () => {
  test('the object spelling parses and keeps the reason', () => {
    const result = parseRepoHookPolicy(
      doc({
        default: { disabled: { pre_tool_use: [{ handler: 'cwd-guard.sh', reason: A_REASON }] } },
      })
    );
    expect(result.ok).toBe(true);
    expect(result.policy.surfaces.default.disabled.pre_tool_use).toEqual([
      { handler: 'cwd-guard.sh', reason: A_REASON },
    ]);
  });

  test('both spellings subtract the same handler from the resolved chain', () => {
    const chains = [['cwd-guard.sh'], [{ handler: 'cwd-guard.sh', reason: A_REASON }]].map(
      (entries) => {
        const parsed = parseRepoHookPolicy(
          doc({ default: { disabled: { pre_tool_use: entries } } })
        );
        expect(parsed.ok).toBe(true);
        const resolved = resolveChain({
          event: 'pre_tool_use',
          stock: [...STOCK, 'cwd-guard.sh'],
          repo: effectiveRepoSurfacePolicy(parsed.policy, 'claude-code'),
        });
        expect(resolved.ok).toBe(true);
        return resolved.handlers;
      }
    );
    expect(chains[0]).toEqual(STOCK);
    expect(chains[1]).toEqual(chains[0]);
  });

  test('the object spelling is refused without a substantive reason', () => {
    for (const entry of [
      { handler: 'cwd-guard.sh' },
      { handler: 'cwd-guard.sh', reason: '  wip  ' },
      { handler: 'cwd-guard.sh', reason: A_REASON, approver: 'me' },
      { handler: 'not a handler', reason: A_REASON },
    ]) {
      const result = parseRepoHookPolicy(doc({ default: { disabled: { pre_tool_use: [entry] } } }));
      expect(result.ok).toBe(false);
    }
  });

  test('a floor handler is refused through the object spelling too', () => {
    for (const name of REPO_POLICY_FLOOR) {
      const result = parseRepoHookPolicy(
        doc({ default: { disabled: { pre_tool_use: [{ handler: name, reason: A_REASON }] } } })
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('repo-policy floor');
    }
  });
});

describe('the serializer emits only decisions, and emits them in a stable order', () => {
  test('an empty policy renders as version alone', () => {
    expect(serializeRepoHookPolicy(emptyRepoHookPolicy())).toBe(
      `${JSON.stringify({ version: HOOK_POLICY_VERSION }, null, 2)}\n`
    );
  });

  test('a surface holding nothing is omitted entirely', () => {
    const policy = emptyRepoHookPolicy();
    policy.surfaces.codex = {
      disabled: {},
      extensions: {},
      handlers: {},
      libraries: {},
      forks: {},
    };
    expect(JSON.parse(serializeRepoHookPolicy(policy)).surfaces).toBeUndefined();
  });

  test('`default` renders first and the remaining surfaces sort', () => {
    const added = ['zcode', 'claude-code', 'default', 'codex'].reduce(
      (policy, surface) =>
        expectMutation(
          policyAddExtension(policy, {
            surface,
            event: 'pre_tool_use',
            handler: 'marker.sh',
            before: null,
            reason: A_REASON,
          })
        ),
      emptyRepoHookPolicy()
    );
    expect(Object.keys(JSON.parse(serializeRepoHookPolicy(added)).surfaces)).toEqual([
      'default',
      'claude-code',
      'codex',
      'zcode',
    ]);
  });

  test('a parsed document survives a serialize/parse round trip unchanged', () => {
    const original = parseRepoHookPolicy(
      doc({
        default: {
          disabled: { pre_tool_use: [{ handler: 'cwd-guard.sh', reason: A_REASON }] },
          extensions: {
            post_tool_use: [{ handler: 'marker.sh --quiet', before: null, reason: A_REASON }],
          },
          handlers: { 'marker.sh': '.caws/hooks/ext/marker.sh' },
          forks: {
            'scope-guard.sh': {
              forked_from: { pack: 'shared', pack_version: 67, sha256: 'a'.repeat(64) },
              reason: A_REASON,
              approver: '@maintainer',
            },
          },
        },
      })
    );
    expect(original.ok).toBe(true);
    const round = reparse(original.policy);
    expect(round.ok).toBe(true);
    expect(round.policy).toEqual(original.policy);
  });
});

/** Assert a mutation succeeded and hand back the policy it produced. */
function expectMutation(result) {
  if (!result.ok) throw new Error(`expected a successful mutation, got: ${result.error}`);
  return result.policy;
}

describe('add splices additively and refuses to overwrite a recorded decision', () => {
  test('an added extension lands before its anchor in the resolved chain', () => {
    const policy = expectMutation(
      policyAddExtension(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'marker.sh',
        before: 'scope-guard.sh',
        reason: A_REASON,
        path: '.caws/hooks/ext/marker.sh',
      })
    );
    const resolved = resolveChain({
      event: 'pre_tool_use',
      stock: STOCK,
      repo: effectiveRepoSurfacePolicy(policy, 'claude-code'),
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers).toEqual([
      'block-dangerous.sh',
      'protected-paths.sh',
      'marker.sh',
      'scope-guard.sh',
      'agent-register.sh --quiet',
    ]);
    expect(resolved.handlerOverrides['marker.sh']).toBe('.caws/hooks/ext/marker.sh');
  });

  test('adding the same handler twice is refused rather than silently rewritten', () => {
    const once = expectMutation(
      policyAddExtension(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'marker.sh',
        before: null,
        reason: A_REASON,
      })
    );
    const twice = policyAddExtension(once, {
      surface: 'default',
      event: 'pre_tool_use',
      handler: 'marker.sh --quiet',
      before: 'scope-guard.sh',
      reason: 'a different justification entirely',
    });
    expect(twice.ok).toBe(false);
    expect(twice.error).toContain('already an extension');
    // The refusal left the first decision — and its reason — intact.
    expect(once.surfaces.default.extensions.pre_tool_use[0].reason).toBe(A_REASON);
  });

  test('a short reason, an unknown event, and an escaping path are each refused', () => {
    const base = {
      surface: 'default',
      event: 'pre_tool_use',
      handler: 'marker.sh',
      before: null,
      reason: A_REASON,
    };
    for (const [override, fragment] of [
      [{ reason: 'too short' }, '--reason'],
      [{ event: 'on_whatever' }, 'unknown event'],
      [{ path: '../elsewhere/marker.sh' }, 'traverse'],
      [{ path: '/etc/marker.sh' }, 'repo-relative'],
      [{ path: '.caws/hooks/*.sh' }, 'glob'],
      [{ before: 'not a handler' }, 'anchor'],
    ]) {
      const result = policyAddExtension(emptyRepoHookPolicy(), { ...base, ...override });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(fragment);
    }
  });

  test('add may not install a floor name as a repo-local file', () => {
    const result = policyAddExtension(emptyRepoHookPolicy(), {
      surface: 'default',
      event: 'pre_tool_use',
      handler: 'protected-paths.sh',
      before: null,
      reason: A_REASON,
      path: '.caws/hooks/ext/protected-paths.sh',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('repo-policy floor');
  });
});

describe('disable records why, and cannot reach the floor', () => {
  test('a disable persists its reason into the document', () => {
    const policy = expectMutation(
      policyDisableHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'cwd-guard.sh',
        reason: A_REASON,
      })
    );
    const written = JSON.parse(serializeRepoHookPolicy(policy));
    expect(written.surfaces.default.disabled.pre_tool_use).toEqual([
      { handler: 'cwd-guard.sh', reason: A_REASON },
    ]);
    expect(disabledHandlers(policy.surfaces.default.disabled.pre_tool_use)).toEqual([
      'cwd-guard.sh',
    ]);
  });

  test('every floor handler is refused even with a reason', () => {
    for (const name of REPO_POLICY_FLOOR) {
      const result = policyDisableHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: name,
        reason: A_REASON,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('repo-policy floor');
    }
  });

  test('a reason under the floor length is refused and names the flag', () => {
    const result = policyDisableHandler(emptyRepoHookPolicy(), {
      surface: 'default',
      event: 'pre_tool_use',
      handler: 'cwd-guard.sh',
      reason: 'because',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('--reason');
  });

  test('disabling the same handler twice is refused', () => {
    const once = expectMutation(
      policyDisableHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'cwd-guard.sh',
        reason: A_REASON,
      })
    );
    const twice = policyDisableHandler(once, {
      surface: 'default',
      event: 'pre_tool_use',
      handler: 'cwd-guard.sh',
      reason: A_REASON,
    });
    expect(twice.ok).toBe(false);
    expect(twice.error).toContain('already disabled');
  });
});

describe('replace always records provenance, so a fork cannot hide', () => {
  const FORK = { pack: 'shared', pack_version: 67, sha256: 'b'.repeat(64) };

  test('a replacement writes both the override and its forked_from record', () => {
    const policy = expectMutation(
      policyReplaceHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        handler: 'scope-guard.sh',
        path: '.caws/hooks/ext/scope-guard.local.sh',
        reason: A_REASON,
        approver: '@maintainer',
        forkedFrom: FORK,
      })
    );
    const surface = policy.surfaces.default;
    expect(surface.handlers['scope-guard.sh']).toBe('.caws/hooks/ext/scope-guard.local.sh');
    expect(surface.forks['scope-guard.sh']).toEqual({
      forked_from: FORK,
      reason: A_REASON,
      approver: '@maintainer',
    });
  });

  test('replacing a floor handler is refused — a no-op stub IS a disable', () => {
    for (const name of REPO_POLICY_FLOOR) {
      const result = policyReplaceHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        handler: name,
        path: '.caws/hooks/ext/noop.sh',
        reason: A_REASON,
        approver: '@maintainer',
        forkedFrom: FORK,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('repo-policy floor');
    }
  });

  test('a missing approver or unusable provenance is refused', () => {
    const base = {
      surface: 'default',
      handler: 'scope-guard.sh',
      path: '.caws/hooks/ext/scope-guard.local.sh',
      reason: A_REASON,
      approver: '@maintainer',
      forkedFrom: FORK,
    };
    for (const [override, fragment] of [
      [{ approver: '   ' }, '--approver'],
      [{ reason: 'short' }, '--reason'],
      [{ forkedFrom: { ...FORK, pack_version: '67' } }, 'pack_version'],
      [{ forkedFrom: { ...FORK, sha256: 'not-a-digest' } }, 'sha256'],
      [{ path: '../outside.sh' }, 'traverse'],
    ]) {
      const result = policyReplaceHandler(emptyRepoHookPolicy(), { ...base, ...override });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(fragment);
    }
  });
});

describe('restore undoes, and refuses to report success over an unchanged file', () => {
  function populated() {
    let policy = expectMutation(
      policyDisableHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'cwd-guard.sh',
        reason: A_REASON,
      })
    );
    policy = expectMutation(
      policyAddExtension(policy, {
        surface: 'default',
        event: 'post_tool_use',
        handler: 'marker.sh',
        before: null,
        reason: A_REASON,
        path: '.caws/hooks/ext/marker.sh',
      })
    );
    return policy;
  }

  test('restoring a disabled handler returns the chain to stock', () => {
    const before = populated();
    const after = expectMutation(
      policyRestoreHandler(before, {
        surface: 'default',
        handler: 'cwd-guard.sh',
        event: 'pre_tool_use',
      })
    );
    const chain = (policy) =>
      resolveChain({
        event: 'pre_tool_use',
        stock: [...STOCK, 'cwd-guard.sh'],
        repo: effectiveRepoSurfacePolicy(policy, 'claude-code'),
      }).handlers;
    expect(chain(before)).not.toContain('cwd-guard.sh');
    expect(chain(after)).toEqual([...STOCK, 'cwd-guard.sh']);
  });

  test('restore sweeps the extension AND its override together', () => {
    const after = expectMutation(
      policyRestoreHandler(populated(), { surface: 'default', handler: 'marker.sh' })
    );
    expect(after.surfaces.default.extensions.post_tool_use ?? []).toEqual([]);
    expect(after.surfaces.default.handlers['marker.sh']).toBeUndefined();
  });

  test('restoring a handler the document never named is refused, not confirmed', () => {
    const result = policyRestoreHandler(populated(), {
      surface: 'default',
      handler: 'never-mentioned.sh',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nothing to restore');
  });

  test('an event-scoped restore does not reach another event', () => {
    const result = policyRestoreHandler(populated(), {
      surface: 'default',
      handler: 'cwd-guard.sh',
      event: 'post_tool_use',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nothing to restore');
  });

  test('restoring on a surface with no policy is refused', () => {
    const result = policyRestoreHandler(populated(), { surface: 'codex', handler: 'cwd-guard.sh' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('codex');
  });
});

describe('a mutation leaves its input untouched and its output readable', () => {
  test('mutators do not mutate the policy handed to them', () => {
    const original = emptyRepoHookPolicy();
    const snapshot = serializeRepoHookPolicy(original);
    policyAddExtension(original, {
      surface: 'default',
      event: 'pre_tool_use',
      handler: 'marker.sh',
      before: null,
      reason: A_REASON,
    });
    policyDisableHandler(original, {
      surface: 'default',
      event: 'pre_tool_use',
      handler: 'cwd-guard.sh',
      reason: A_REASON,
    });
    expect(serializeRepoHookPolicy(original)).toBe(snapshot);
  });

  test('every successful mutation returns a policy the READER has already accepted', () => {
    // The invariant `settle` exists for. Asserted over each verb rather than
    // once, so a future verb that forgets to route through it fails here.
    const mutations = [
      policyAddExtension(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'marker.sh',
        before: null,
        reason: A_REASON,
        path: '.caws/hooks/ext/marker.sh',
      }),
      policyDisableHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'cwd-guard.sh',
        reason: A_REASON,
      }),
      policyReplaceHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        handler: 'scope-guard.sh',
        path: '.caws/hooks/ext/scope-guard.local.sh',
        reason: A_REASON,
        approver: '@maintainer',
        forkedFrom: { pack: 'shared', pack_version: 67, sha256: 'c'.repeat(64) },
      }),
    ];
    for (const mutation of mutations) {
      const policy = expectMutation(mutation);
      const round = reparse(policy);
      expect(round.ok).toBe(true);
      expect(round.policy).toEqual(policy);
      expect(mutation.changed.length).toBeGreaterThan(0);
    }
  });

  test('the document a mutation writes is at the version the reader requires', () => {
    const policy = expectMutation(
      policyDisableHandler(emptyRepoHookPolicy(), {
        surface: 'default',
        event: 'pre_tool_use',
        handler: 'cwd-guard.sh',
        reason: A_REASON,
      })
    );
    expect(JSON.parse(serializeRepoHookPolicy(policy)).version).toBe(HOOK_POLICY_VERSION);
    expect(REPO_HOOK_POLICY_PATH).toBe('.caws/hooks/hook-policy.json');
  });
});

describe('resolving for `default` must not layer `default` over itself', () => {
  // Regression: `effectiveRepoSurfacePolicy` merged surfaces.default over
  // surfaces[surface] unconditionally, so asking for 'default' concatenated
  // the additive keys with themselves. resolveChain then failed closed on the
  // duplicate, and `caws hooks compile` — which resolves for 'default',
  // because the project-wired plane has ONE dispatcher tree — refused every
  // policy declaring an extension. A governed command refusing a legitimate
  // document is what sends an agent to hand-edit the artifact instead.
  const document = {
    default: {
      disabled: {
        pre_tool_use: [{ handler: 'cwd-guard.sh', reason: 'no worktrees in this repo' }],
      },
      extensions: {
        pre_tool_use: [
          { handler: 'marker.sh', before: 'scope-guard.sh', reason: 'native/ layout' },
        ],
      },
      handlers: { 'marker.sh': '.caws/hooks/ext/marker.sh' },
    },
  };

  test('each entry appears exactly once', () => {
    const surface = parsedSurface(document, 'default');
    expect(surface.extensions.pre_tool_use).toHaveLength(1);
    expect(surface.disabled.pre_tool_use).toHaveLength(1);
  });

  test('the chain resolves instead of failing closed on a phantom duplicate', () => {
    const resolved = resolveChain({
      event: 'pre_tool_use',
      stock: [...STOCK, 'cwd-guard.sh'],
      repo: parsedSurface(document, 'default'),
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.handlers).toEqual([
      'block-dangerous.sh',
      'protected-paths.sh',
      'marker.sh',
      'scope-guard.sh',
      'agent-register.sh --quiet',
    ]);
  });

  test('a NAMED surface still layers over default — the fix did not disable merging', () => {
    // Discrimination control: without it, returning the empty surface for
    // every name would pass both arms above.
    const surface = parsedSurface(
      {
        ...document,
        codex: {
          extensions: {
            pre_tool_use: [{ handler: 'codex-only.sh', before: null, reason: 'codex needs this' }],
          },
        },
      },
      'codex'
    );
    expect(surface.extensions.pre_tool_use.map((e) => e.handler)).toEqual([
      'marker.sh',
      'codex-only.sh',
    ]);
  });
});
