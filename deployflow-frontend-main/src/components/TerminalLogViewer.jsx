import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'

/**
 * TerminalLogViewer
 * Displays build/deployment logs in a terminal-style console.
 * Auto-scrolls to the bottom whenever new logs are added -
 * mimics real CI/CD tools like GitHub Actions / Vercel logs.
 *
 * Props:
 * - logs: array of { type: 'info' | 'success' | 'error', text: string }
 */
function TerminalLogViewer({ logs }) {
  const scrollRef = useRef(null)

  // Auto-scroll to bottom whenever logs change (simulates live streaming feel)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  // Maps log type -> text color, matching real terminal conventions
  const logColor = {
    info: 'text-text-secondary',
    success: 'text-status-success',
    error: 'text-status-failed',
  }

  return (
    <div className="bg-[#0a0a0f] border border-border-subtle rounded-xl overflow-hidden">
      {/* Terminal header bar - mimics a real terminal window */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle bg-bg-secondary">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-status-failed/60" />
          <span className="w-3 h-3 rounded-full bg-status-pending/60" />
          <span className="w-3 h-3 rounded-full bg-status-success/60" />
        </div>
        <div className="flex items-center gap-1.5 text-text-tertiary text-xs ml-2">
          <Terminal size={12} />
          build-logs.sh
        </div>
      </div>

      {/* Log content - scrollable, monospace font, fixed height */}
      <div
        ref={scrollRef}
        className="p-4 h-80 overflow-y-auto font-mono text-xs space-y-1.5"
      >
        {logs.map((log, index) => (
          <div key={index} className={`${logColor[log.type]} leading-relaxed`}>
            <span className="text-text-tertiary mr-2">[{String(index + 1).padStart(2, '0')}]</span>
            {log.text}
          </div>
        ))}
        {/* Blinking cursor at the end - gives a "live" terminal feel */}
        <div className="flex items-center gap-1 text-text-tertiary">
          <span className="w-2 h-4 bg-brand-primary animate-pulse" />
        </div>
      </div>
    </div>
  )
}

export default TerminalLogViewer