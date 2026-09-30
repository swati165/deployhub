const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const AUTH_KEY = 'deployflow_auth_token'

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {})
  const token = localStorage.getItem(AUTH_KEY)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers })
  } catch {
    throw new Error(`Cannot reach the DeployHub API at ${API_BASE_URL}. Start the API server and try again.`)
  }

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/register') {
      localStorage.removeItem(AUTH_KEY)
      window.dispatchEvent(new Event('deployhub:unauthorized'))
    }
    throw new Error(data.error || `Request failed (${response.status}).`)
  }
  return data
}

export function apiUrl(path) {
  return `${API_BASE_URL}${path}`
}
