const {
  observeWorktreeOwner,
  observeWorktreeOwnership,
} = require('../../dist/runtime/worktree-ownership');

test.each([
  [false, undefined],
  [true, null],
  [true, { session_id: null }],
  [true, { session_id: '' }],
  [true, { session_id: 'unknown' }],
])('unconfirmed owner presence=%p value=%p confers no identity', (ownerPresent, owner) => {
  expect(observeWorktreeOwner({ ownerPresent, owner })).toEqual({ kind: 'unconfirmed' });
});
test.each([
  undefined,
  {},
  [],
  false,
  12,
  'owner',
  { session_id: 1 },
  { session_id: false },
  { session_id: [] },
  { session_id: {} },
  { session_id: '../other' },
  { session_id: '.' },
  { session_id: '..' },
  { session_id: 'a\nb' },
  { session_id: 'a'.repeat(129) },
])('malformed present owner %p is not normalized to absence', (owner) => {
  expect(observeWorktreeOwner({ ownerPresent: true, owner })).toEqual({ kind: 'malformed' });
});
test('only a supported actual owner identity is confirmed', () => {
  expect(
    observeWorktreeOwner({ ownerPresent: true, owner: { session_id: 'a'.repeat(128) } })
  ).toEqual({ kind: 'confirmed', sessionId: 'a'.repeat(128) });
  expect(observeWorktreeOwner({ ownerPresent: false, owner: { session_id: 'self' } })).toEqual({
    kind: 'malformed',
  });
  expect(
    observeWorktreeOwner({ ownerPresent: true, owner: Object.create({ session_id: 'self' }) })
  ).toEqual({ kind: 'malformed' });
});
const root = (name, owner = 'self') => ({
  name,
  root: '/repo/.caws/worktrees/' + name,
  ownerPresent: true,
  owner: owner === null ? null : { session_id: owner },
});
const census = (roots, targets, sessionId = 'self') =>
  observeWorktreeOwnership({
    canonical: '/repo',
    sessionId,
    roots,
    targets,
  });
test('physical payload boundary distinguishes own, unconfirmed and outside targets', () => {
  expect(
    census(
      [root('own'), root('unowned', null)],
      [
        '/repo/.caws/worktrees/own/a',
        '/repo/.caws/worktrees/unowned/a',
        '/repo/.caws/worktrees/own-neighbor/a',
      ]
    )
  ).toEqual([
    { kind: 'owner_self', worktree: 'own' },
    { kind: 'payload_without_owner', worktree: 'unowned' },
    { kind: 'outside_payload' },
  ]);
});
test.each([false, true])(
  'foreign owner survives unresolved roots and target ordering reversed=%p',
  (reverse) => {
    const targets = [null, '/repo/.caws/worktrees/own/a', '/repo/.caws/worktrees/foreign/a'];
    const expected = [
      { kind: 'unresolved' },
      { kind: 'unresolved' },
      { kind: 'foreign_owner', worktree: 'foreign' },
    ];
    if (reverse) {
      targets.reverse();
      expected.reverse();
    }
    expect(
      census([{ ...root('missing'), root: null }, root('own'), root('foreign', 'peer')], targets)
    ).toEqual(expected);
  }
);
test('a missing caller identity does not establish a foreign owner', () => {
  expect(census([root('other', 'peer')], ['/repo/.caws/worktrees/other/a'], null)).toEqual([
    { kind: 'unresolved' },
  ]);
});
test('overlapping roots refuse even when their owners agree; a confirmed peer still wins', () => {
  const child = { ...root('nested'), root: '/repo/.caws/worktrees/own/nested' };
  expect(census([root('own'), child], [child.root + '/a'])).toEqual([{ kind: 'unresolved' }]);
  child.owner = { session_id: 'peer' };
  expect(census([root('own'), child], [child.root + '/a'])).toEqual([
    { kind: 'foreign_owner', worktree: 'nested' },
  ]);
});
test.each([null, 'relative', '/repo', '/'])(
  'an unresolved or overlapping root %p cannot establish absence',
  (physical) => {
    expect(census([{ ...root('bad'), root: physical }], ['/repo/a'])).toEqual([
      { kind: 'unresolved' },
    ]);
  }
);
