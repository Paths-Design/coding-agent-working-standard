const { login, logout } = require('../src/auth/login');

describe('auth', () => {
  test('login returns token', () => {
    const result = login('user', 'pass');
    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
  });

  test('login requires credentials', () => {
    expect(() => login()).toThrow('Username and password are required');
  });

  test('logout requires token', () => {
    expect(() => logout()).toThrow('Token is required');
  });

  test('logout succeeds with token', () => {
    const result = logout('some-token');
    expect(result.success).toBe(true);
  });
});
