const AUTH_KEY = 'deployflow_auth_token'

export function loginUser(token) {
  localStorage.setItem(AUTH_KEY, token)
}

export function logoutUser() {
  localStorage.removeItem(AUTH_KEY)
}

export function isAuthenticated() {
  return Boolean(localStorage.getItem(AUTH_KEY))
}
