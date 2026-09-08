import { useState, useEffect, useRef } from 'react'
import { Play, Pause, Trash2, Filter } from 'lucide-react'
import Button from '../components/Button'
import TerminalLogViewer from '../components/TerminalLogViewer'
import { liveLogPool, logProjectOptions } from '../utils/mockData'

/**
 * Logs Page
 * Simulates a live-streaming log console across all projects.
 * Uses setInterval to "push" a new random log entry every few seconds -
 * in a real app, this would be replaced with a WebSocket/SSE subscription.
 */
function Logs() {
  const [logs, setLogs] = useState([])
  const [isStreaming, setIsStreaming] = useState(true)
  const [projectFilter, setProjectFilter] = useState('all')
  const [levelFilter, setLevelFilter] = useState('all')

  const poolIndexRef = useRef(0) // tracks which mock log to emit next

  // Simulate live log streaming
  useEffect(() => {
    if (!isStreaming) return // paused - don't start the interval

    const interval = setInterval(() => {
      const nextLog = liveLogPool[poolIndexRef.current % liveLogPool.length]
      setLogs((prev) => [...prev, { ...nextLog, id: Date.now() }])
      poolIndexRef.current += 1
    }, 1800) // new log every 1.8s

    // Cleanup: stops the interval when component unmounts or streaming pauses
    return () => clearInterval(interval)
  }, [isStreaming])

  // Apply project + level filters to the accumulated logs
  const filteredLogs = logs.filter((log) => {
    const matchesProject =
      projectFilter === 'all' || log.text.includes(`[${projectFilter}]`)
    const matchesLevel = levelFilter === 'all' || log.type === levelFilter
    return matchesProject && matchesLevel
  })

  const levelFilters = [
    { key: 'all', label: 'All' },
    { key: 'info', label: 'Info' },
    { key: 'success', label: 'Success' },
    { key: 'error', label: 'Error' },
  ]

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Logs</h1>
          <p className="text-text-secondary text-sm mt-1">
            Real-time logs streaming from all your services
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            variant={isStreaming ? 'secondary' : 'primary'}
            icon={isStreaming ? Pause : Play}
            onClick={() => setIsStreaming((prev) => !prev)}
          >
            {isStreaming ? 'Pause' : 'Resume'}
          </Button>
          <Button variant="ghost" icon={Trash2} onClick={() => setLogs([])}>
            Clear
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        {/* Level filter pills */}
        <div className="flex gap-1 bg-bg-hover border border-border-subtle rounded-lg p-1 w-fit">
          {levelFilters.map((filter) => (
            <button
              key={filter.key}
              onClick={() => setLevelFilter(filter.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 ${
                levelFilter === filter.key
                  ? 'bg-brand-primary text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Project filter dropdown */}
        <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2 w-fit">
          <Filter size={14} className="text-text-tertiary" />
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-transparent outline-none text-sm text-text-primary cursor-pointer"
          >
            <option value="all" className="bg-bg-secondary">All Projects</option>
            {logProjectOptions.map((proj) => (
              <option key={proj} value={proj} className="bg-bg-secondary">
                {proj}
              </option>
            ))}
          </select>
        </div>

        {/* Live indicator */}
        {isStreaming && (
          <span className="flex items-center gap-1.5 text-xs text-status-success ml-auto">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-success opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-status-success" />
            </span>
            Live
          </span>
        )}
      </div>

      {/* Log viewer */}
      {filteredLogs.length > 0 ? (
        <TerminalLogViewer logs={filteredLogs} />
      ) : (
        <div className="bg-bg-card border border-border-subtle rounded-xl text-center py-16">
          <p className="text-text-secondary text-sm">
            {logs.length === 0
              ? 'Waiting for logs...'
              : 'No logs match your current filters.'}
          </p>
        </div>
      )}
    </div>
  )
}

export default Logs