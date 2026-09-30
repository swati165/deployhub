import { useCallback, useEffect, useMemo, useState } from 'react'
import { Filter, Loader2 } from 'lucide-react'
import Card from '../components/Card'
import DeploymentRow from '../components/DeploymentRow'
import { apiRequest } from '../utils/api'

const activeStatuses = ['queued', 'cloning', 'building', 'pushing', 'deploying']

function DeploymentsPage() {
  const [deployments, setDeployments] = useState([])
  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadDeployments = useCallback(async () => {
    try {
      const result = await apiRequest('/deployments')
      setDeployments(result.deployments)
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadDeployments() }, [loadDeployments])
  useEffect(() => {
    if (!deployments.some((deployment) => activeStatuses.includes(deployment.status))) return undefined
    const timer = setInterval(loadDeployments, 4000)
    return () => clearInterval(timer)
  }, [deployments, loadDeployments])

  const statusFilters = [
    { key: 'all', label: 'All' },
    { key: 'live', label: 'Live' },
    { key: 'building', label: 'In progress' },
    { key: 'failed', label: 'Failed' },
  ]
  const projectOptions = useMemo(() => [...new Set(deployments.map((deployment) => deployment.project))], [deployments])
  const filteredDeployments = useMemo(() => deployments.filter((deployment) => {
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'building' ? activeStatuses.includes(deployment.status) : deployment.status === statusFilter)
    return matchesStatus && (projectFilter === 'all' || deployment.project === projectFilter)
  }), [deployments, statusFilter, projectFilter])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deployments</h1>
        <p className="text-text-secondary text-sm mt-1">Track builds, deployment status, and live URLs.</p>
      </div>
      {error && <div role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">{error}</div>}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex gap-1 bg-bg-hover border border-border-subtle rounded-lg p-1 w-fit">
          {statusFilters.map((filter) => (
            <button key={filter.key} onClick={() => setStatusFilter(filter.key)} className={`px-3 py-1.5 rounded-md text-xs font-medium ${statusFilter === filter.key ? 'bg-brand-primary text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              {filter.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2 w-fit">
          <Filter size={14} className="text-text-tertiary" />
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className="bg-transparent outline-none text-sm text-text-primary cursor-pointer">
            <option value="all" className="bg-bg-secondary">All Projects</option>
            {projectOptions.map((project) => <option key={project} value={project} className="bg-bg-secondary">{project}</option>)}
          </select>
        </div>
      </div>
      <Card className="!p-2">
        {loading ? <div className="py-12 text-center text-text-secondary"><Loader2 size={20} className="animate-spin mx-auto mb-2" />Loading deployments...</div>
          : filteredDeployments.length ? filteredDeployments.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} />)
            : <div className="text-center py-16"><p className="text-text-secondary">{deployments.length ? 'No deployments match your filters.' : 'Your deployment history will appear here.'}</p></div>}
      </Card>
    </div>
  )
}

export default DeploymentsPage
