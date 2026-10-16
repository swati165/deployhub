import { useState, useEffect, useRef } from 'react'
import { Cpu, HardDrive, Box, AlertTriangle } from 'lucide-react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import Card from '../components/Card'
import Badge from '../components/Badge'
import { initialMetrics, pods } from '../utils/mockData'

/**
 * Custom Tooltip for metric charts - matches our dark glass theme
 */
function MetricTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div className="glass rounded-lg p-3 text-sm">
      <p className="text-text-secondary mb-1">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} style={{ color: entry.color }} className="font-medium">
          {entry.name}: {entry.value}%
        </p>
      ))}
    </div>
  )
}

/**
 * Maps a pod's Kubernetes-style status to our Badge component's status prop
 */
function podBadgeStatus(status) {
  if (status === 'running') return 'success'
  if (status === 'pending') return 'pending'
  return 'failed' // crashloop, error, etc.
}

function Monitoring() {
  const [metrics, setMetrics] = useState(initialMetrics)
  const timeCounterRef = useRef(31) // continues the "10:31", "10:32"... sequence

  // Simulate live metrics updates - appends a new data point every 3s
  // and keeps only the last 10 points so the chart doesn't grow forever
  useEffect(() => {
    const interval = setInterval(() => {
      setMetrics((prev) => {
        const newPoint = {
          time: `10:${timeCounterRef.current}`,
          cpu: Math.floor(30 + Math.random() * 40), // random between 30-70
          memory: Math.floor(40 + Math.random() * 35), // random between 40-75
        }
        timeCounterRef.current += 1
        const updated = [...prev, newPoint]
        return updated.length > 10 ? updated.slice(-10) : updated
      })
    }, 3000)

    return () => clearInterval(interval)
  }, [])

  // Derived stats for the top summary cards
  const runningPods = pods.filter((p) => p.status === 'running').length
  const crashingPods = pods.filter((p) => p.status === 'crashloop').length
  const latestCpu = metrics[metrics.length - 1]?.cpu ?? 0
  const latestMemory = metrics[metrics.length - 1]?.memory ?? 0

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">Monitoring</h1>
        <p className="text-text-secondary text-sm mt-1">
          Infrastructure metrics and pod telemetry
        </p>
      </div>
      <div className="rounded-lg border border-status-pending/30 bg-status-pending/10 px-4 py-3 text-sm text-status-pending">
        Demo data only — live Kubernetes metrics are not connected in this MVP.
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-brand-primary/10">
              <Cpu size={18} className="text-brand-primary" />
            </div>
            <div>
              <p className="text-text-secondary text-xs">CPU Usage</p>
              <p className="text-xl font-bold">{latestCpu}%</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-status-info/10">
              <HardDrive size={18} className="text-status-info" />
            </div>
            <div>
              <p className="text-text-secondary text-xs">Memory Usage</p>
              <p className="text-xl font-bold">{latestMemory}%</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-status-success/10">
              <Box size={18} className="text-status-success" />
            </div>
            <div>
              <p className="text-text-secondary text-xs">Running Pods</p>
              <p className="text-xl font-bold">{runningPods}/{pods.length}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-status-failed/10">
              <AlertTriangle size={18} className="text-status-failed" />
            </div>
            <div>
              <p className="text-text-secondary text-xs">Crash Looping</p>
              <p className="text-xl font-bold">{crashingPods}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* CPU + Memory Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <h2 className="font-semibold mb-4">CPU Usage</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={metrics}>
              <CartesianGrid strokeDasharray="3 3" stroke="#22222e" vertical={false} />
              <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} domain={[0, 100]} />
              <Tooltip content={<MetricTooltip />} />
              <Line
                type="monotone"
                dataKey="cpu"
                stroke="#6366f1"
                strokeWidth={2}
                dot={false}
                name="CPU"
                isAnimationActive={true}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <h2 className="font-semibold mb-4">Memory Usage</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={metrics}>
              <CartesianGrid strokeDasharray="3 3" stroke="#22222e" vertical={false} />
              <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} domain={[0, 100]} />
              <Tooltip content={<MetricTooltip />} />
              <Line
                type="monotone"
                dataKey="memory"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={false}
                name="Memory"
                isAnimationActive={true}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Pod Status Grid */}
      <Card>
        <h2 className="font-semibold mb-4">Pod Status</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-tertiary text-xs border-b border-border-subtle">
                <th className="pb-3 font-medium">Pod Name</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">CPU</th>
                <th className="pb-3 font-medium">Memory</th>
                <th className="pb-3 font-medium">Restarts</th>
                <th className="pb-3 font-medium">Node</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((pod) => (
                <tr key={pod.id} className="border-b border-border-subtle last:border-0">
                  <td className="py-3 font-mono text-xs">{pod.name}</td>
                  <td className="py-3">
                    <Badge status={podBadgeStatus(pod.status)} pulse={pod.status === 'pending'}>
                      {pod.status}
                    </Badge>
                  </td>
                  <td className="py-3 text-text-secondary">{pod.cpu}</td>
                  <td className="py-3 text-text-secondary">{pod.memory}</td>
                  <td className="py-3">
                    <span className={pod.restarts > 3 ? 'text-status-failed font-semibold' : 'text-text-secondary'}>
                      {pod.restarts}
                    </span>
                  </td>
                  <td className="py-3 text-text-secondary">{pod.node}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

export default Monitoring