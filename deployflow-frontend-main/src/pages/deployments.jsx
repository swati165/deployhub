import { useState, useMemo } from 'react'
import { Filter } from 'lucide-react'
import Card from '../components/Card'
import DeploymentRow from '../components/DeploymentRow'
import { allDeployments } from '../utils/mockData'

/**
 * Deployments Page
 * Shows every deployment across all projects, with status + project filters.
 */
function Deployments() {
  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')

  const statusFilters = [
    { key: 'all', label: 'All' },
    { key: 'success', label: 'Success' },
    { key: 'pending', label: 'Pending' },
    { key: 'failed', label: 'Failed' },
  ]

  // Unique project names for the dropdown (derived from data, not hardcoded)
  const projectOptions = useMemo(() => {
    const unique = [...new Set(allDeployments.map((d) => d.project))]
    return unique
  }, [])

  const filteredDeployments = useMemo(() => {
    return allDeployments.filter((dep) => {
      const matchesStatus = statusFilter === 'all' || dep.status === statusFilter
      const matchesProject = projectFilter === 'all' || dep.project === projectFilter
      return matchesStatus && matchesProject
    })
  }, [statusFilter, projectFilter])

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">Deployments</h1>
        <p className="text-text-secondary text-sm mt-1">
          All deployments across your projects
        </p>
      </div>

      {/* Filters Bar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        {/* Status pill filters */}
        <div className="flex gap-1 bg-bg-hover border border-border-subtle rounded-lg p-1 w-fit">
          {statusFilters.map((filter) => (
            <button
              key={filter.key}
              onClick={() => setStatusFilter(filter.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 ${
                statusFilter === filter.key
                  ? 'bg-brand-primary text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Project dropdown filter */}
        <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2 w-fit">
          <Filter size={14} className="text-text-tertiary" />
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-transparent outline-none text-sm text-text-primary cursor-pointer"
          >
            <option value="all" className="bg-bg-secondary">All Projects</option>
            {projectOptions.map((proj) => (
              <option key={proj} value={proj} className="bg-bg-secondary">
                {proj}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Deployments List */}
      <Card className="!p-2">
        {filteredDeployments.length > 0 ? (
          filteredDeployments.map((dep) => (
            <DeploymentRow key={dep.id} deployment={dep} />
          ))
        ) : (
          <div className="text-center py-16">
            <p className="text-text-secondary">No deployments match your filters.</p>
          </div>
        )}
      </Card>
    </div>
  )
}

export default Deployments