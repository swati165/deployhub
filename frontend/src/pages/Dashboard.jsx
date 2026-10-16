import { useCallback, useEffect, useState } from 'react'
import { FolderKanban, Rocket, CheckCircle2, XCircle, Loader2, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import StatCard from '../components/StatCard'
import Card from '../components/Card'
import DeploymentRow from '../components/DeploymentRow'
import { apiRequest } from '../utils/api'

const emptyStats = { totalProjects: 0, activeDeployments: 0, successRate: 0, failedDeployments: 0 }

function Dashboard() {
  const [dashboard, setDashboard] = useState({ stats: emptyStats, recentDeployments: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshDashboard = useCallback(async () => {
    try {
      setDashboard(await apiRequest('/dashboard'))
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshDashboard()
    const timer = setInterval(refreshDashboard, 8000)
    return () => clearInterval(timer)
  }, [refreshDashboard])

  const stats = dashboard.stats

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-text-secondary text-sm mt-1">A live view of your projects and deployment activity.</p>
        </div>
        <Link to="/projects" className="hidden sm:inline-flex items-center gap-2 text-sm text-brand-primary hover:underline">View projects <ArrowRight size={15} /></Link>
      </div>
      {error && <div role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Projects" value={loading ? '—' : stats.totalProjects} icon={FolderKanban} accentColor="brand-primary" />
        <StatCard label="In Progress" value={loading ? '—' : stats.activeDeployments} icon={Rocket} accentColor="status-info" />
        <StatCard label="Live Success Rate" value={loading ? '—' : `${stats.successRate}%`} icon={CheckCircle2} accentColor="status-success" />
        <StatCard label="Failed Deployments" value={loading ? '—' : stats.failedDeployments} icon={XCircle} accentColor="status-failed" />
      </div>
      <Card className="!p-2">
        <div className="flex items-center justify-between px-4 py-2">
          <div>
            <h2 className="font-semibold">Recent Deployments</h2>
            <p className="text-text-tertiary text-xs mt-1">Latest activity from your connected repositories</p>
          </div>
          <Link to="/deployments" className="text-xs text-brand-primary hover:underline">All deployments</Link>
        </div>
        {loading ? <div className="py-12 text-center text-text-secondary"><Loader2 size={20} className="animate-spin mx-auto mb-2" />Loading activity...</div>
          : dashboard.recentDeployments.length ? dashboard.recentDeployments.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} />)
            : <div className="text-center py-14"><p className="text-text-primary font-medium">No deployment activity yet</p><p className="text-text-secondary text-sm mt-1">Connect a GitHub project to start your first deployment.</p><Link to="/projects" className="inline-block mt-4 text-sm text-brand-primary hover:underline">Add a project</Link></div>}
      </Card>
    </div>
  )
}

export default Dashboard
