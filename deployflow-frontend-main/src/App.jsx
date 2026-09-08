import { Routes, Route } from 'react-router-dom'
import DashboardLayout from './layouts/DashboardLayout'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Projects from './pages/Projects'
import ProjectDetails from './pages/ProjectDetails'
import Deployments from './pages/Deployments'
import DeploymentDetails from './pages/DeploymentDetails'
import Logs from './pages/Logs'
import Monitoring from './pages/Monitoring'
import Settings from './pages/Settings'

function App() {
  return (
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
  )
}

export default App