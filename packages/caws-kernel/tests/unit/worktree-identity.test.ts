import {
  WORKTREE_NAME_REGEX,
  WORKTREE_RULES,
  sameSession,
  validateSessionIdentity,
  validateWorktreeName,
} from '../../src/worktree';
import { isErr, isOk } from '../../src/result';

describe('validateWorktreeName', () => {
  it('accepts simple alphanumeric', () => {
    const r = validateWorktreeName('foo');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe('foo');
  });

  it('accepts hyphens, underscores, and digits', () => {
    for (const ok of ['a-b', 'snake_case', 'wt-123', 'A_B-9']) {
      expect(isOk(validateWorktreeName(ok))).toBe(true);
    }
  });

  it('rejects empty string', () => {
    const r = validateWorktreeName('');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.IDENTITY_NAME_INVALID);
    }
  });

  it('rejects whitespace and special chars', () => {
    for (const bad of [' ', 'foo bar', 'foo/bar', 'foo.bar', 'foo!', 'foo\nbar']) {
      const r = validateWorktreeName(bad);
      expect(isErr(r)).toBe(true);
    }
  });

  it('rejects non-string inputs', () => {
    for (const bad of [null, undefined, 123, {}, []]) {
      const r = validateWorktreeName(bad as unknown);
      expect(isErr(r)).toBe(true);
    }
  });

  it('regex is exported and matches the validator', () => {
    expect(WORKTREE_NAME_REGEX.test('valid-name_1')).toBe(true);
    expect(WORKTREE_NAME_REGEX.test('not valid')).toBe(false);
  });
});

describe('validateSessionIdentity', () => {
  it('accepts a session_id alone', () => {
    const r = validateSessionIdentity({ session_id: 'sess-1' });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.session_id).toBe('sess-1');
      expect(r.value.platform).toBeUndefined();
    }
  });

  it('accepts session_id + platform', () => {
    const r = validateSessionIdentity({ session_id: 'sess-1', platform: 'claude-code' });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.platform).toBe('claude-code');
    }
  });

  it('trims session_id and platform', () => {
    const r = validateSessionIdentity({ session_id: '  sess-1  ', platform: '  cli  ' });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.session_id).toBe('sess-1');
      expect(r.value.platform).toBe('cli');
    }
  });

  it('rejects empty session_id', () => {
    const r = validateSessionIdentity({ session_id: '' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.IDENTITY_SESSION_ID_EMPTY);
    }
  });

  it('rejects whitespace-only session_id', () => {
    const r = validateSessionIdentity({ session_id: '   ' });
    expect(isErr(r)).toBe(true);
  });

  it('rejects non-object inputs', () => {
    for (const bad of [null, undefined, 'sess-1', 123]) {
      expect(isErr(validateSessionIdentity(bad as unknown))).toBe(true);
    }
  });

  it('rejects empty platform when present', () => {
    const r = validateSessionIdentity({ session_id: 'sess-1', platform: '' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.IDENTITY_SESSION_PLATFORM_EMPTY);
    }
  });

  it('rejects whitespace-only platform when present', () => {
    const r = validateSessionIdentity({ session_id: 'sess-1', platform: '   ' });
    expect(isErr(r)).toBe(true);
  });
});

describe('sameSession', () => {
  it('compares by session_id only', () => {
    expect(
      sameSession({ session_id: 'a', platform: 'cli' }, { session_id: 'a', platform: 'cursor' })
    ).toBe(true);
    expect(sameSession({ session_id: 'a' }, { session_id: 'b' })).toBe(false);
  });
});
