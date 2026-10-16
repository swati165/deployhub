import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, X, GitBranch, Loader2 } from 'lucide-react'
import Button from '../components/Button'
import ProjectCard from '../components/ProjectCard'
import { apiRequest } from '../utils/api'
import {
  isActiveDeploymentStatus,
  normalizeDeploymentStatus,
} from '../utils/deploymentStates'

function Projects() {
  const [projects, setProjects] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', repoUrl: '', branch: 'main', description: '' })

  async function loadProjects() {
    setLoading(true)
    setError('')
    try {
      const result = await apiRequest('/projects')
      setProjects(result.projects)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProjects() }, [])

  const filters = [
    { key: 'all', label: 'All' },
    { key: 'RUNNING', label: 'Live' },
    { key: 'building', label: 'Building' },
    { key: 'FAILED', label: 'Failed' },
  ]
  const filteredProjects = useMemo(() => projects.filter((project) => {
    const matchesSearch = `${project.name} ${project.description} ${project.repoUrl}`
      .toLowerCase().includes(searchTerm.toLowerCase())
    const status = normalizeDeploymentStatus(project.status)
    const isBuilding = isActiveDeploymentStatus(status)
    const matchesFilter = activeFilter === 'all'
      || (activeFilter === 'building' ? isBuilding : status === activeFilter)
    return matchesSearch && matchesFilter
  }), [projects, searchTerm, activeFilter])

  async function createProject(event) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const { project } = await apiRequest('/projects', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      setProjects((current) => [project, ...current])
      setForm({ name: '', repoUrl: '', branch: 'main', description: '' })
      setShowForm(false)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-text-secondary text-sm mt-1">Connect a GitHub repository and deploy it from one place.</p>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => { setShowForm((value) => !value); setError('') }}>
          New Project
        </Button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">{error}</div>}

      {showForm && (
        <form onSubmit={createProject} className="glass rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold">Connect a repository</h2>
              <p className="text-text-secondary text-xs mt-1">Public GitHub repositories only. Builds run only on a configured isolated runner.</p>
            </div>
            <button type="button" aria-label="Close" onClick={() => setShowForm(false)} className="text-text-tertiary hover:text-text-primary"><X size={18} /></button>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="text-xs text-text-secondary space-y-1.5">
              Project name
              <input required maxLength={60} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="my-web-app" className="w-full bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-primary" />
            </label>
            <label className="text-xs text-text-secondary space-y-1.5">
              GitHub repository URL
              <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 focus-within:border-brand-primary">
                <GitBranch size={16} className="text-text-tertiary" />
                <input required type="url" value={form.repoUrl} onChange={(event) => setForm({ ...form, repoUrl: event.target.value })} placeholder="https://github.com/acme/my-web-app" className="w-full bg-transparent py-2.5 text-sm text-text-primary outline-none" />
              </div>
            </label>
            <label className="text-xs text-text-secondary space-y-1.5">
              Production branch
              <input required maxLength={120} value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} className="w-full bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-primary" />
            </label>
            <label className="text-xs text-text-secondary space-y-1.5">
              Description <span className="text-text-tertiary">(optional)</span>
              <input maxLength={500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What does this project do?" className="w-full bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-primary" />
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? <><Loader2 size={16} className="animate-spin" /> Connecting...</> : 'Connect Project'}
            </Button>
          </div>
        </form>
      )}

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 w-full sm:w-80">
          <Search size={16} className="text-text-tertiary" />
          <input type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search projects..." className="bg-transparent outline-none text-sm w-full placeholder:text-text-tertiary" />
        </div>
        <div className="flex gap-1 bg-bg-hover border border-border-subtle rounded-lg p-1 w-fit">
          {filters.map((filter) => (
            <button key={filter.key} onClick={() => setActiveFilter(filter.key)} className={`px-3 py-1.5 rounded-md text-xs font-medium ${activeFilter === filter.key ? 'bg-brand-primary text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-text-secondary"><Loader2 size={20} className="animate-spin mx-auto mb-2" />Loading your projects...</div>
      ) : filteredProjects.length ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((project) => <ProjectCard key={project.id} project={project} />)}
        </div>
      ) : (
        <div className="text-center py-16 border border-dashed border-border-strong rounded-xl">
          <GitBranch size={24} className="mx-auto text-text-tertiary mb-3" />
          <p className="text-text-primary font-medium">{projects.length ? 'No matching projects' : 'Your first deploy starts here'}</p>
          <p className="text-text-secondary text-sm mt-1">{projects.length ? 'Try another search or filter.' : 'Connect a public GitHub repository to get started.'}</p>
        </div>
      )}
    </div>
  )
}

export default Projects
