import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Rocket, GitBranch, Loader2, ExternalLink } from 'lucide-react'
import Button from '../components/Button'
import Card from '../components/Card'
import Badge from '../components/Badge'
import DeploymentRow from '../components/DeploymentRow'
import { apiRequest } from '../utils/api'

const activeStatuses = ['queued', 'cloning', 'building', 'pushing', 'deploying']

function ProjectDetails() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState(null)
  const [deployments, setDeployments] = useState([])
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')

  const loadProject = useCallback(async () => {
    try {
      const [projectResult, deploymentResult] = await Promise.all([
        apiRequest(`/projects/${projectId}`),
        apiRequest(`/projects/${projectId}/deployments`),
      ])
      setProject(projectResult.project)
      setDeployments(deploymentResult.deployments)
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { loadProject() }, [loadProject])
  useEffect(() => {
    if (!deployments.some((deployment) => activeStatuses.includes(deployment.status))) return undefined
    const timer = setInterval(loadProject, 4000)
    return () => clearInterval(timer)
  }, [deployments, loadProject])

  async function deploy() {
    setDeploying(true)
    setError('')
    try {
      const result = await apiRequest(`/projects/${projectId}/deployments`, { method: 'POST', body: '{}' })
      navigate(`/deployments/${result.deployment.id}`)
    } catch (requestError) {
      setError(requestError.message)
      setDeploying(false)
    }
  }

  if (loading) return <div className="py-16 text-center text-text-secondary"><Loader2 size={20} className="animate-spin mx-auto mb-2" />Loading project...</div>
  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-text-secondary">{error || 'Project not found.'}</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/projects')}><ArrowLeft size={16} /> Back to Projects</Button>
      </div>
    )
  }

  const working = deployments.some((deployment) => activeStatuses.includes(deployment.status))

  return (
    <div className="space-y-6">
      <button onClick={() => navigate('/projects')} className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary text-sm">
        <ArrowLeft size={16} /> Back to Projects
      </button>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <Badge status={project.status === 'live' ? 'success' : project.status === 'failed' ? 'failed' : activeStatuses.includes(project.status) ? 'pending' : 'neutral'}>
              {project.status}
            </Badge>
          </div>
          <p className="text-text-secondary text-sm mt-1">{project.description || project.repoUrl}</p>
        </div>
        <Button variant="primary" icon={deploying ? Loader2 : Rocket} disabled={deploying || working} onClick={deploy}>
          {deploying || working ? 'Deployment in progress' : 'Deploy Now'}
        </Button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <h2 className="font-semibold mb-4">Repository</h2>
          <div className="space-y-3 text-sm">
            <a href={project.repoUrl.replace(/\.git$/, '')} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3 text-brand-primary hover:underline">
              <span className="flex items-center gap-2 min-w-0"><GitBranch size={15} /> <span className="truncate">{project.repoUrl.replace(/\.git$/, '')}</span></span>
              <ExternalLink size={14} />
            </a>
            <div className="flex justify-between border-b border-border-subtle pb-3">
              <span className="text-text-secondary">Production branch</span>
              <span className="flex items-center gap-1"><GitBranch size={14} /> {project.branch}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Deployments</span>
              <span>{project.deploymentsCount}</span>
            </div>
          </div>
        </Card>
        <Card>
          <h2 className="font-semibold mb-2">Deployment target</h2>
          <p className="text-text-secondary text-sm">Docker image → Kubernetes Deployment, Service, and Ingress.</p>
          <p className="text-xs text-text-tertiary mt-4">A public GitHub repository is required. Builds remain disabled until an isolated runner and cluster are configured.</p>
        </Card>
      </div>

      <Card className="!p-2">
        <div className="px-4 py-2 flex items-center justify-between">
          <h2 className="font-semibold">Deployment history</h2>
          <span className="text-xs text-text-tertiary">{deployments.length} total</span>
        </div>
        {deployments.length ? deployments.map((deployment) => (
          <DeploymentRow key={deployment.id} deployment={deployment} showProject={false} />
        )) : <p className="text-center text-sm text-text-secondary py-10">No deployments yet. Start one when you’re ready.</p>}
      </Card>
    </div>
  )
}

export default ProjectDetails
