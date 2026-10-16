import { useCallback, useEffect, useState } from 'react'
import { Play, Pause, Filter, Loader2 } from 'lucide-react'
import Button from '../components/Button'
import TerminalLogViewer from '../components/TerminalLogViewer'
import { apiRequest } from '../utils/api'

function Logs() {
  const [logs, setLogs] = useState([])
  const [isStreaming, setIsStreaming] = useState(true)
  const [projectFilter, setProjectFilter] = useState('all')
  const [levelFilter, setLevelFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadLogs = useCallback(async () => {
    const query = new URLSearchParams()
    if (projectFilter !== 'all') query.set('projectId', projectFilter)
    if (levelFilter !== 'all') query.set('level', levelFilter)
    try {
      const result = await apiRequest(`/logs?${query}`)
      setLogs(result.logs.reverse())
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [projectFilter, levelFilter])

  useEffect(() => { loadLogs() }, [loadLogs])
  useEffect(() => {
    if (!isStreaming) return undefined
    const timer = setInterval(loadLogs, 3000)
    return () => clearInterval(timer)
  }, [isStreaming, loadLogs])

  const projects = [...new Map(logs.map((log) => [log.projectId, { id: log.projectId, name: log.project }])).values()]
  const levelFilters = [
    { key: 'all', label: 'All' },
    { key: 'info', label: 'Info' },
    { key: 'success', label: 'Success' },
    { key: 'error', label: 'Error' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Deployment Logs</h1>
          <p className="text-text-secondary text-sm mt-1">Logs recorded by your deployment pipeline, refreshed every 3 seconds.</p>
        </div>
        <Button variant={isStreaming ? 'secondary' : 'primary'} icon={isStreaming ? Pause : Play} onClick={() => setIsStreaming((value) => !value)}>
          {isStreaming ? 'Pause refresh' : 'Resume refresh'}
        </Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">{error}</div>}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="flex gap-1 bg-bg-hover border border-border-subtle rounded-lg p-1 w-fit">
          {levelFilters.map((filter) => (
            <button key={filter.key} onClick={() => setLevelFilter(filter.key)} className={`px-3 py-1.5 rounded-md text-xs font-medium ${levelFilter === filter.key ? 'bg-brand-primary text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              {filter.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2 w-fit">
          <Filter size={14} className="text-text-tertiary" />
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className="bg-transparent outline-none text-sm text-text-primary cursor-pointer">
            <option value="all" className="bg-bg-secondary">All Projects</option>
            {projects.map((project) => <option key={project.id} value={project.id} className="bg-bg-secondary">{project.name}</option>)}
          </select>
        </div>
        {isStreaming && <span className="flex items-center gap-1.5 text-xs text-status-success sm:ml-auto"><span className="w-2 h-2 rounded-full bg-status-success animate-pulse" />Refreshing</span>}
      </div>
      {loading ? <div className="py-12 text-center text-text-secondary"><Loader2 size={20} className="animate-spin mx-auto mb-2" />Loading logs...</div>
        : logs.length ? <TerminalLogViewer logs={logs} />
          : <div className="bg-bg-card border border-border-subtle rounded-xl text-center py-16"><p className="text-text-secondary text-sm">No deployment logs yet. Start a deployment to see pipeline activity here.</p></div>}
    </div>
  )
}

export default Logs
