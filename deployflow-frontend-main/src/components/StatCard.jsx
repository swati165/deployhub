import Card from './Card'

/**
 * StatCard
 * Small reusable stat box used on Dashboard (Total Projects, Success Rate etc.)
 *
 * Props:
 * - label: stat title (e.g. "Total Projects")
 * - value: the number/stat to display
 * - icon: Lucide icon component
 * - trend: optional string like "+12%" to show change
 * - trendUp: boolean — true = green (positive), false = red (negative)
 * - accentColor: tailwind color token for the icon background
 */
function StatCard({ label, value, icon: Icon, trend, trendUp = true, accentColor = 'brand-primary' }) {
  return (
    <Card hover>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-text-secondary text-sm">{label}</p>
          <p className="text-3xl font-bold mt-2">{value}</p>

          {trend && (
            <p
              className={`text-xs mt-2 font-medium ${
                trendUp ? 'text-status-success' : 'text-status-failed'
              }`}
            >
              {trendUp ? '↑' : '↓'} {trend} vs last week
            </p>
          )}
        </div>

        {/* Icon badge */}
        <div className={`p-3 rounded-xl bg-${accentColor}/10`}>
          <Icon size={20} className={`text-${accentColor}`} />
        </div>
      </div>
    </Card>
  )
}

export default StatCard