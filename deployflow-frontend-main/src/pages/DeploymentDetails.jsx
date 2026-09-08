import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, GitCommitHorizontal, User, Clock, Layers, RefreshCw } from 'lucide-react'
import Button from '../components/Button'
import Card from '../components/Card'
import Badge from '../components/Badge'
import DeploymentTimeline from '../components/DeploymentTimeline'
import TerminalLogViewer from '../components/TerminalLogViewer'
import { deploymentDetailsMap, timelineStages, sampleLogs } from '../utils/mockData'

function DeploymentDetails() {
  const { deploymentId } = useParams()
  const navigate = useNavigate()

  // Look up deployment by ID from our mock data map
  const deployment = deploymentDetailsMap[deploymentId]

  // Guard: handle invalid/unknown deployment IDs gracefully
  if (!deployment) {
    return (
      <div className="text-center py-16">
        <p className="text-text-secondary">Deployment not found.</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/deployments')}>
          <ArrowLeft size={16} /> Back to Deployments
        </Button>
      </div>
    )
  }

  const badgeStatus = deployment.status // already 'success' | 'pending' | 'failed'

  return (
    <div className="space-y-6">
      {/* Back link */}
      <button
        onClick={() => navigate('/deployments')}
        className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary text-sm transition-colors"
      >
        <ArrowLeft size={16} /> Back to Deployments
      </button>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold">{deployment.commitMsg}</h1>
            <Badge status={badgeStatus} pulse={badgeStatus === 'pending'}>
              {badgeStatus}
            </Badge>
          </div>
          <p className="text-text-secondary text-sm mt-1">
            {deployment.project} • {deployment.environment}
          </p>
        </div>

        <Button variant="secondary" icon={RefreshCw}>
          Redeploy
        </Button>
      </div>

      {/* Metadata row */}
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-text-tertiary text-xs mb-1 flex items-center gap-1">
              <GitCommitHorizontal size={12} /> Commit
            </p>
            <p className="font-mono">{deployment.commitHash}</p>
          </div>
          <div>
            <p className="text-text-tertiary text-xs mb-1 flex items-center gap-1">
              <User size={12} /> Author
            </p>
            <p>{deployment.author}</p>
          </div>
          <div>
            <p className="text-text-tertiary text-xs mb-1 flex items-center gap-1">
              <Layers size={12} /> Branch
            </p>
            <p>{deployment.branch}</p>
          </div>
          <div>
            <p className="text-text-tertiary text-xs mb-1 flex items-center gap-1">
              <Clock size={12} /> Duration
            </p>
            <p>{deployment.duration}</p>
          </div>
        </div>
      </Card>

      {/* Timeline */}
      <Card>
        <h2 className="font-semibold mb-6">Deployment Progress</h2>
        <DeploymentTimeline stages={timelineStages} status={deployment.status} />
      </Card>

      {/* Terminal Logs */}
      <div>
        <h2 className="font-semibold mb-3">Build Logs</h2>
        <TerminalLogViewer logs={sampleLogs} />
      </div>
    </div>
  )
}

export default DeploymentDetails