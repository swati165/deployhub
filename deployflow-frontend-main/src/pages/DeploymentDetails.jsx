import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, GitCommitHorizontal, User, Clock, Layers, ExternalLink, Loader2 } from 'lucide-react'
import Button from '../components/Button'
import Card from '../components/Card'
import Badge from '../components/Badge'
import DeploymentTimeline from '../components/DeploymentTimeline'
import TerminalLogViewer from '../components/TerminalLogViewer'
import { apiRequest } from '../utils/api'

const timelineStages = ['Queued', 'Cloning', 'Building', 'Pushing', 'Deploying', 'Live']
const activeStatuses = ['queued', 'cloning', 'building', 'pushing', 'deploying']

function statusColor(status) {
  if (status === 'live') return 'success'
  if (status === 'failed') return 'failed'
  if (activeStatuses.includes(status)) return 'pending'
  return 'neutral'
}

function displayTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function DeploymentDetails() {
  const { deploymentId } = useParams()
  const navigate = useNavigate()
  const [deployment, setDeployment] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadDeployment = useCallback(async () => {
    try {
      const result = await apiRequest(`/deployments/${deploymentId}`)
      setDeployment(result.deployment)
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [deploymentId])

  useEffect(() => { loadDeployment() }, [loadDeployment])
  useEffect(() => {
    if (!deployment || !activeStatuses.includes(deployment.status)) return undefined
    const timer = setInterval(loadDeployment, 2500)
    return () => clearInterval(timer)
  }, [deployment, loadDeployment])

  if (loading) return <div className="py-16 text-center text-text-secondary"><Loader2 size={20} className="animate-spin mx-auto mb-2" />Loading deployment...</div>
  if (!deployment) {
    return (
      <div className="text-center py-16">
        <p className="text-text-secondary">{error || 'Deployment not found.'}</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/deployments')}><ArrowLeft size={16} /> Back to Deployments</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <button onClick={() => navigate('/deployments')} className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary text-sm">
        <ArrowLeft size={16} /> Back to Deployments
      </button>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold">{deployment.project}</h1>
            <Badge status={statusColor(deployment.status)} pulse={activeStatuses.includes(deployment.status)}>{deployment.status}</Badge>
          </div>
          <p className="text-text-secondary text-sm mt-1">Branch {deployment.branch} · {deployment.stage}</p>
        </div>
        {deployment.liveUrl && (
          <a href={deployment.liveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-status-success hover:underline">
            Open live site <ExternalLink size={14} />
          </a>
        )}
      </div>

      {error && <div role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">{error}</div>}
      {deployment.error && <div role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">{deployment.error}</div>}

      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div><p className="text-text-tertiary text-xs mb-1 flex items-center gap-1"><GitCommitHorizontal size={12} /> Branch</p><p className="font-mono">{deployment.branch}</p></div>
          <div><p className="text-text-tertiary text-xs mb-1 flex items-center gap-1"><User size={12} /> Created by</p><p className="truncate">{deployment.author}</p></div>
          <div><p className="text-text-tertiary text-xs mb-1 flex items-center gap-1"><Layers size={12} /> Stack</p><p>{deployment.stack || 'Detecting'}</p></div>
          <div><p className="text-text-tertiary text-xs mb-1 flex items-center gap-1"><Clock size={12} /> Started</p><p>{displayTime(deployment.createdAt)}</p></div>
        </div>
        {deployment.image && <p className="text-xs text-text-tertiary font-mono border-t border-border-subtle mt-4 pt-3 break-all">Image: {deployment.image}</p>}
      </Card>

      <Card>
        <h2 className="font-semibold mb-6">Deployment Progress</h2>
        <DeploymentTimeline stages={timelineStages} status={deployment.status} stage={deployment.stage} />
      </Card>

      <div>
        <h2 className="font-semibold mb-3">Deployment Logs</h2>
        {deployment.logs?.length ? <TerminalLogViewer logs={deployment.logs} /> : (
          <div className="bg-bg-card border border-border-subtle rounded-xl text-center py-12 text-text-secondary text-sm">Logs will appear as the deployment progresses.</div>
        )}
      </div>
    </div>
  )
}

export default DeploymentDetails
