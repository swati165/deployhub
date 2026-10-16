import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import DashboardLayout from './layouts/Dashboardlayout'
import ProtectedRoute from './components/protectedRoute'
import Login from './pages/login'
import Dashboard from './pages/Dashboard'
import Projects from './pages/Projects'
import ProjectDetails from './pages/ProjectDetails'
import Deployments from './pages/deployments'
import DeploymentDetails from './pages/DeploymentDetails'
import Logs from './pages/Logs'
import Settings from './pages/Settings'

const Monitoring = lazy(() => import('./pages/monitoring'))

function App() {
  const navigate = useNavigate()

  useEffect(() => {
    const redirectToLogin = () => navigate('/login', { replace: true })
    window.addEventListener('deployhub:unauthorized', redirectToLogin)
    return () => window.removeEventListener('deployhub:unauthorized', redirectToLogin)
  }, [navigate])

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-text-secondary">Loading DeployHub...</div>}>
    <Routes>
      {/* Public route - no auth required */}
      <Route path="/login" element={<Login />} />

      {/* Protected routes - user must be logged in to access these */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:projectId" element={<ProjectDetails />} />
        <Route path="deployments" element={<Deployments />} />
        <Route path="deployments/:deploymentId" element={<DeploymentDetails />} />
        <Route path="logs" element={<Logs />} />
        <Route path="monitoring" element={<Monitoring />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
    </Suspense>
  )
}

export default App