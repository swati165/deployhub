/**
 * Simple Auth Helper
 * 
 * Uses localStorage to persist a fake "logged in" state across page reloads.
 * This is a MOCK implementation for now - when the real backend is ready,
 * we'll replace this with actual JWT token validation via an authService.
 */

const AUTH_KEY = 'deployflow_auth_token'

// Save a fake token after "login"
export function loginUser() {
  localStorage.setItem(AUTH_KEY, 'mock_token_123')
}

// Remove the token on logout
export function logoutUser() {
  localStorage.removeItem(AUTH_KEY)
}

// Check whether the user is currently "authenticated"
export function isAuthenticated() {
  return !!localStorage.getItem(AUTH_KEY)
}