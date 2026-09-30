import { motion } from 'framer-motion'
import { Check, X, Loader2 } from 'lucide-react'

/**
 * DeploymentTimeline
 * Visual step indicator showing deployment pipeline progress.
 * e.g. Queued -> Building -> Deploying -> Live
 *
 * Props:
 * - stages: array of stage names, e.g. ['Queued', 'Building', 'Deploying', 'Live']
 * - status: 'success' | 'failed' | 'pending' — determines how far the timeline fills
 */
function DeploymentTimeline({ stages, status, stage = status }) {
  const normalizedStage = stage?.toLowerCase()
  const stageIndex = stages.findIndex((item) => item.toLowerCase() === normalizedStage)
  const currentStepIndex = status === 'live'
    ? stages.length - 1
    : Math.max(stageIndex, 0)

  return (
    <div className="flex items-center w-full">
      {stages.map((stage, index) => {
        const isComplete = index < currentStepIndex || (status === 'live' && index <= currentStepIndex)
        const isCurrent = index === currentStepIndex && status !== 'live'
        const isFailed = isCurrent && status === 'failed'
        const isLast = index === stages.length - 1

        return (
          <div key={stage} className="flex items-center flex-1 last:flex-none">
            {/* Step circle */}
            <div className="flex flex-col items-center gap-2">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: index * 0.1 }}
                className={`w-9 h-9 rounded-full flex items-center justify-center border-2 ${
                  isFailed
                    ? 'bg-status-failed/10 border-status-failed text-status-failed'
                    : isComplete
                    ? 'bg-status-success/10 border-status-success text-status-success'
                    : isCurrent
                    ? 'bg-status-pending/10 border-status-pending text-status-pending'
                    : 'bg-bg-hover border-border-strong text-text-tertiary'
                }`}
              >
                {isFailed ? (
                  <X size={16} />
                ) : isComplete ? (
                  <Check size={16} />
                ) : isCurrent ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <span className="text-xs">{index + 1}</span>
                )}
              </motion.div>
              <span
                className={`text-xs font-medium whitespace-nowrap ${
                  isFailed
                    ? 'text-status-failed'
                    : isComplete || isCurrent
                    ? 'text-text-primary'
                    : 'text-text-tertiary'
                }`}
              >
                {stage}
              </span>
            </div>

            {/* Connector line between steps */}
            {!isLast && (
              <div className="flex-1 h-0.5 mx-2 mb-5 relative overflow-hidden bg-border-subtle">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: index < currentStepIndex ? '100%' : '0%' }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  className="h-full bg-status-success absolute left-0 top-0"
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default DeploymentTimeline