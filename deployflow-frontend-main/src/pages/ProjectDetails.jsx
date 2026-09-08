import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Rocket, RefreshCw, GitBranch, Eye, EyeOff, Copy } from 'lucide-react'
import { useState } from 'react'
import Button from '../components/Button'
import Card from '../components/Card'
import Badge from '../components/Badge'
import Tabs from '../components/Tabs'
import { projects, projectDeployments, envVariables } from '../utils/mockData'

function ProjectDetails() {
  const { projectId } = useParams() // grabs ':projectId' from the URL
  const navigate = useNavigate()

  // Find the matching project from mock data.
  // Later, this becomes: const project = await projectService.getById(projectId)
  const project = projects.find((p) => p.id === projectId)

  const badgeStatus =
    project?.status === 'building' ? 'pending' : project?.status === 'active' ? 'success' : 'failed'

  // Guard: if someone visits an invalid project ID, show a friendly fallback
  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-text-secondary">Project not found.</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/projects')}>
          <ArrowLeft size={16} /> Back to Projects
        </Button>
      </div>
    )
  }

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'deployments', label: 'Deployments' },
    { key: 'environment', label: 'Environment Variables' },
    { key: 'settings', label: 'Settings' },
  ]

  return (
    <div className="space-y-6">
      {/* Back link */}
      <button
        onClick={() => navigate('/projects')}
        className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary text-sm transition-colors"
      >
        <ArrowLeft size={16} /> Back to Projects
      </button>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <Badge status={badgeStatus} pulse={project.status === 'building'}>
              {project.status}
            </Badge>
          </div>
          <p className="text-text-secondary text-sm mt-1">{project.description}</p>
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" icon={RefreshCw}>Redeploy</Button>
          <Button variant="primary" icon={Rocket}>Deploy Now</Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} defaultTab="overview">
        {(activeTab) => (
          <>
            {activeTab === 'overview' && <OverviewTab project={project} />}
            {activeTab === 'deployments' && <DeploymentsTab />}
            {activeTab === 'environment' && <EnvironmentTab />}
            {activeTab === 'settings' && <SettingsTab project={project} />}
          </>
        )}
      </Tabs>
    </div>
  )
}

/* ============================================
   TAB CONTENTS
   Kept in the same file for now since they're
   small and tightly coupled to this page.
   ============================================ */

function OverviewTab({ project }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card className="md:col-span-2">
        <h3 className="font-semibold mb-3">Project Info</h3>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between border-b border-border-subtle pb-2">
            <span className="text-text-secondary">Branch</span>
            <span className="flex items-center gap-1"><GitBranch size={14} /> {project.branch}</span>
          </div>
          <div className="flex justify-between border-b border-border-subtle pb-2">
            <span className="text-text-secondary">Total Deployments</span>
            <span>{project.deploymentsCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Last Deployed</span>
            <span>{project.lastDeployed}</span>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">Tech Stack</h3>
        <div className="flex flex-wrap gap-1.5">
          {project.techStack.map((tech) => (
            <span key={tech} className="text-xs px-2 py-1 rounded-md bg-bg-hover text-text-secondary border border-border-subtle">
              {tech}
            </span>
          ))}
        </div>
      </Card>
    </div>
  )
}

function DeploymentsTab() {
  return (
    <Card>
      <div className="space-y-1">
        {projectDeployments.map((dep) => (
          <div key={dep.id} className="flex items-center justify-between py-3 border-b border-border-subtle last:border-0">
            <div className="flex items-center gap-3">
              <Badge status={dep.status}>{dep.status}</Badge>
              <div>
                <p className="text-sm font-medium">{dep.commitMsg}</p>
                <p className="text-text-tertiary text-xs">{dep.author} • {dep.branch}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-text-secondary">{dep.duration}</p>
              <p className="text-xs text-text-tertiary">{dep.time}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function EnvironmentTab() {
  // Tracks which env variable rows currently have their value revealed
  const [visibleKeys, setVisibleKeys] = useState({})

  const toggleVisibility = (key) => {
    setVisibleKeys((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">Environment Variables</h3>
        <Button variant="secondary" size="sm">+ Add Variable</Button>
      </div>

      <div className="space-y-2">
        {envVariables.map((env) => (
          <div
            key={env.key}
            className="flex items-center justify-between bg-bg-hover border border-border-subtle rounded-lg px-4 py-2.5"
          >
            <div className="flex-1">
              <p className="text-sm font-mono font-medium">{env.key}</p>
              <p className="text-xs text-text-tertiary font-mono mt-0.5">
                {visibleKeys[env.key] ? env.value.replace(/•/g, 'x') : env.value}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleVisibility(env.key)}
                className="p-1.5 rounded-md hover:bg-bg-card text-text-tertiary hover:text-text-primary transition-colors"
              >
                {visibleKeys[env.key] ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button className="p-1.5 rounded-md hover:bg-bg-card text-text-tertiary hover:text-text-primary transition-colors">
                <Copy size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function SettingsTab({ project }) {
  return (
    <Card>
      <h3 className="font-semibold mb-4">Project Settings</h3>
      <div className="space-y-4 max-w-md">
        <div>
          <label className="text-sm text-text-secondary mb-1.5 block">Project Name</label>
          <input
            type="text"
            defaultValue={project.name}
            className="w-full bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 text-sm outline-none focus:border-brand-primary transition-colors"
          />
        </div>
        <div>
          <label className="text-sm text-text-secondary mb-1.5 block">Production Branch</label>
          <input
            type="text"
            defaultValue={project.branch}
            className="w-full bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 text-sm outline-none focus:border-brand-primary transition-colors"
          />
        </div>
        <Button variant="primary">Save Changes</Button>

        <div className="pt-4 border-t border-border-subtle">
          <p className="text-sm font-medium text-status-failed mb-2">Danger Zone</p>
          <Button variant="danger">Delete Project</Button>
        </div>
      </div>
    </Card>
  )
}

export default ProjectDetails