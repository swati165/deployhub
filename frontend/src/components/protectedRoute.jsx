import { Navigate } from 'react-router-dom'
import { isAuthenticated } from '../utils/auth'

/**
 * ProtectedRoute
 * Wraps any route that requires the user to be logged in.
 * If not authenticated, redirects to /login instead of rendering children.
 *
 * Usage:
 * <Route path="/" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>} />
 */
function ProtectedRoute({ children }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />
  }
  return children
}

export default ProtectedRoute