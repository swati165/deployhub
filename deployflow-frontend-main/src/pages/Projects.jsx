import { useState, useMemo } from 'react'
import { Plus, Search } from 'lucide-react'
import Button from '../components/Button'
import ProjectCard from '../components/ProjectCard'
import { projects } from '../utils/mockData'

/**
 * Projects Page
 * Shows a searchable, filterable grid of all projects.
 */
function Projects() {
  const [searchTerm, setSearchTerm] = useState('')
  const [activeFilter, setActiveFilter] = useState('all') // 'all' | 'active' | 'building' | 'failed'

  // Filter tabs config - easy to extend later
  const filters = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'building', label: 'Building' },
    { key: 'failed', label: 'Failed' },
  ]

  // useMemo avoids re-filtering on every render unless searchTerm/activeFilter/projects change
  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      const matchesSearch = project.name
        .toLowerCase()
        .includes(searchTerm.toLowerCase())
      const matchesFilter =
        activeFilter === 'all' || project.status === activeFilter
      return matchesSearch && matchesFilter
    })
  }, [searchTerm, activeFilter])

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-text-secondary text-sm mt-1">
            Manage and monitor all your deployed projects
          </p>
        </div>
        <Button variant="primary" icon={Plus}>
          New Project
        </Button>
      </div>

      {/* Search + Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        {/* Search input */}
        <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 w-full sm:w-80">
          <Search size={16} className="text-text-tertiary" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search projects..."
            className="bg-transparent outline-none text-sm w-full placeholder:text-text-tertiary"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 bg-bg-hover border border-border-subtle rounded-lg p-1 w-fit">
          {filters.map((filter) => (
            <button
              key={filter.key}
              onClick={() => setActiveFilter(filter.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 ${
                activeFilter === filter.key
                  ? 'bg-brand-primary text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {/* Projects Grid */}
      {filteredProjects.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        // Empty state - shown when search/filter returns nothing
        <div className="text-center py-16">
          <p className="text-text-secondary">No projects found matching your criteria.</p>
        </div>
      )}
    </div>
  )
}

export default Projects