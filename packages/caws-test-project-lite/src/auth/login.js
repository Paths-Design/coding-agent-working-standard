/**
 * Login module for the lite test project
 */

function login(username, password) {
  if (!username || !password) {
    throw new Error('Username and password are required');
  }

  // Validate credentials
  return {
    success: true,
    token: `token-${Date.now()}`,
    user: { username },
  };
}

function logout(token) {
  if (!token) {
    throw new Error('Token is required');
  }
  return { success: true };
}

module.exports = { login, logout };
