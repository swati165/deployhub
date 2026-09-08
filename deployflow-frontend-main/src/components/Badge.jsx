/**
 * Reusable Badge Component
 * Used for deployment status, pod health, environment tags etc.
 *
 * Props:
 * - status: 'success' | 'failed' | 'pending' | 'info' | 'neutral'
 * - children: badge text (e.g. "Deployed", "Failed", "Building")
 * - pulse: boolean — adds a live pulsing dot (for in-progress states)
 */
function Badge({ status = 'neutral', children, pulse = false }) {
  // Maps each status to its color tokens (defined in index.css @theme)
  const statusStyles = {
    success: 'bg-status-success/10 text-status-success border-status-success/30',
    failed: 'bg-status-failed/10 text-status-failed border-status-failed/30',
    pending: 'bg-status-pending/10 text-status-pending border-status-pending/30',
    info: 'bg-status-info/10 text-status-info border-status-info/30',
    neutral: 'bg-bg-hover text-text-secondary border-border-strong',
  }

  // Dot color matches the badge status - used for the pulsing indicator
  const dotColor = {
    success: 'bg-status-success',
    failed: 'bg-status-failed',
    pending: 'bg-status-pending',
    info: 'bg-status-info',
    neutral: 'bg-text-tertiary',
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${statusStyles[status]}`}
    >
      {pulse && (
        <span className="relative flex h-1.5 w-1.5">
          {/* Animated ping ring - gives a "live" feel to pending/in-progress states */}
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${dotColor[status]} opacity-75`}
          ></span>
          <span
            className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dotColor[status]}`}
          ></span>
        </span>
      )}
      {children}
    </span>
  )
}

export default Badge