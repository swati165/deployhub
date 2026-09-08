import { useState } from 'react'

/**
 * Reusable Tabs Component
 * Generic tab switcher - used in Project Details, Deployment Details, Settings etc.
 *
 * Props:
 * - tabs: array of { key, label } objects
 * - defaultTab: which tab key is active by default
 * - children: function that receives activeTab and returns content to render
 *
 * Usage:
 * <Tabs tabs={[{key: 'overview', label: 'Overview'}]} defaultTab="overview">
 *   {(activeTab) => activeTab === 'overview' && <OverviewContent />}
 * </Tabs>
 */
function Tabs({ tabs, defaultTab, children }) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.key)

  return (
    <div>
      {/* Tab headers */}
      <div className="flex gap-1 border-b border-border-subtle mb-6 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-all duration-200 ${
              activeTab === tab.key
                ? 'border-brand-primary text-brand-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content - rendered via render-prop pattern */}
      <div>{children(activeTab)}</div>
    </div>
  )
}

export default Tabs