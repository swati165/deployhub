import { useNavigate } from 'react-router-dom'
import { GitCommitHorizontal, User, Clock } from 'lucide-react'
import Badge from './Badge'

function statusColor(status) {
  if (status === 'live') return 'success'
  if (status === 'failed') return 'failed'
  if (['queued', 'cloning', 'building', 'pushing', 'deploying'].includes(status)) return 'pending'
  return 'neutral'
}

function displayTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

/**
 * DeploymentRow
 * A single row representing one deployment.
 * Renders as a table row on desktop, and adapts to a stacked
 * card layout on mobile (via flex-wrap + responsive classes).
 *
 * Props:
 * - deployment: object from mockData (allDeployments / projectDeployments)
 * - showProject: boolean — whether to show the project name column
 *   (Deployments page shows it, Project Details > Deployments tab doesn't need it)
 */
function DeploymentRow({ deployment, showProject = true }) {
  const navigate = useNavigate()

  return (
    <div
      onClick={() => navigate(`/deployments/${deployment.id}`)}
      className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-0 justify-between py-4 px-4 border-b border-border-subtle last:border-0 hover:bg-bg-hover cursor-pointer transition-colors rounded-lg"
    >
      {/* Left: status + commit info */}
      <div className="flex items-center gap-3 sm:w-2/5">
        <Badge status={statusColor(deployment.status)} pulse={statusColor(deployment.status) === 'pending'}>
          {deployment.status}
        </Badge>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{deployment.commitMsg || `Deploy ${deployment.branch}`}</p>
          {showProject && (
            <p className="text-text-tertiary text-xs mt-0.5">{deployment.project}</p>
          )}
        </div>
      </div>

      {/* Middle: branch + author */}
      <div className="flex items-center gap-4 sm:w-1/4 text-xs text-text-secondary">
        <span className="flex items-center gap-1">
          <GitCommitHorizontal size={12} /> {deployment.branch}
        </span>
        <span className="flex items-center gap-1">
          <User size={12} /> {deployment.author}
        </span>
      </div>

      {/* Right: duration + time */}
      <div className="flex items-center gap-4 sm:w-1/5 justify-end text-xs text-text-tertiary">
        <span className="capitalize">{deployment.duration || deployment.stage || '—'}</span>
        <span className="flex items-center gap-1">
          <Clock size={12} /> {displayTime(deployment.createdAt || deployment.time)}
        </span>
      </div>
    </div>
  )
}

export default DeploymentRow