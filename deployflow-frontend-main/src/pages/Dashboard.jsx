import { FolderKanban, Rocket, CheckCircle2, XCircle } from 'lucide-react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import Card from '../components/Card'
import StatCard from '../components/StatCard'
import Badge from '../components/Badge'
import {
  dashboardStats,
  deploymentHistory,
  recentDeployments,
} from '../utils/mockData'

/**
 * Custom Tooltip for the Recharts Area Chart
 * Styled to match our dark glassmorphism theme instead of
 * Recharts' default white tooltip.
 */
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null

  return (
    <div className="glass rounded-lg p-3 text-sm">
      <p className="text-text-secondary mb-1">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} style={{ color: entry.color }} className="font-medium">
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  )
}

function Dashboard() {
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-text-secondary text-sm mt-1">
          Overview of your deployments and infrastructure
        </p>
      </div>

      {/* Stat Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Projects"
          value={dashboardStats.totalProjects}
          icon={FolderKanban}
          trend="8%"
          trendUp={true}
          accentColor="brand-primary"
        />
        <StatCard
          label="Active Deployments"
          value={dashboardStats.activeDeployments}
          icon={Rocket}
          trend="2%"
          trendUp={true}
          accentColor="status-info"
        />
        <StatCard
          label="Success Rate"
          value={`${dashboardStats.successRate}%`}
          icon={CheckCircle2}
          trend="1.2%"
          trendUp={true}
          accentColor="status-success"
        />
        <StatCard
          label="Failed Deployments"
          value={dashboardStats.failedDeployments}
          icon={XCircle}
          trend="5%"
          trendUp={false}
          accentColor="status-failed"
        />
      </div>

      {/* Deployment History Chart */}
      <Card>
        <div className="mb-4">
          <h2 className="font-semibold">Deployment History</h2>
          <p className="text-text-secondary text-xs mt-0.5">Last 7 days</p>
        </div>

        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={deploymentHistory}>
            <defs>
              {/* Gradient fill for the "success" area */}
              <linearGradient id="successGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
              {/* Gradient fill for the "failed" area */}
              <linearGradient id="failedGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#22222e" vertical={false} />
            <XAxis dataKey="day" stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} />
            <Tooltip content={<CustomTooltip />} />

            <Area
              type="monotone"
              dataKey="success"
              stroke="#22c55e"
              strokeWidth={2}
              fill="url(#successGradient)"
              name="Success"
            />
            <Area
              type="monotone"
              dataKey="failed"
              stroke="#ef4444"
              strokeWidth={2}
              fill="url(#failedGradient)"
              name="Failed"
            />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* Recent Deployments List */}
      <Card>
        <h2 className="font-semibold mb-4">Recent Deployments</h2>
        <div className="space-y-3">
          {recentDeployments.map((dep) => (
            <div
              key={dep.id}
              className="flex items-center justify-between py-3 border-b border-border-subtle last:border-0"
            >
              <div className="flex items-center gap-3">
                <Badge
                  status={dep.status}
                  pulse={dep.status === 'pending'}
                >
                  {dep.status}
                </Badge>
                <div>
                  <p className="text-sm font-medium">{dep.project}</p>
                  <p className="text-text-tertiary text-xs">{dep.commitMsg}</p>
                </div>
              </div>

              <div className="text-right">
                <p className="text-xs text-text-secondary">{dep.branch}</p>
                <p className="text-xs text-text-tertiary">{dep.time}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

export default Dashboard