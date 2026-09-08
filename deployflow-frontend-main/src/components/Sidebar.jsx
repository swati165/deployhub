import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  FolderKanban,
  Rocket,
  Terminal,
  Activity,
  Settings,
  Boxes,
  X,
} from 'lucide-react'

/**
 * Sidebar Navigation
 * Fixed left panel with links to all main sections of the app.
 *
 * Props:
 * - isOpen: boolean - controls visibility on mobile (slide-in overlay)
 * - onClose: function - called to close the sidebar (mobile only)
 */
function Sidebar({ isOpen, onClose }) {
  const navItems = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/deployments', label: 'Deployments', icon: Rocket },
    { to: '/logs', label: 'Logs', icon: Terminal },
    { to: '/monitoring', label: 'Monitoring', icon: Activity },
    { to: '/settings', label: 'Settings', icon: Settings },
  ]

  return (
    <>
      {/* Mobile backdrop overlay - clicking it closes the sidebar */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
        />
      )}

      <aside
        className={`
          w-64 h-screen bg-bg-secondary border-r border-border-subtle flex flex-col
          fixed left-0 top-0 z-40
          transition-transform duration-300 ease-in-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0
        `}
      >
        {/* Logo / Brand + mobile close button */}
        <div className="flex items-center justify-between px-6 h-16 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-primary to-brand-secondary flex items-center justify-center">
              <Boxes size={18} className="text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">DeployFlow</span>
          </div>
          {/* Close button - only visible on mobile */}
          <button onClick={onClose} className="lg:hidden text-text-secondary hover:text-text-primary">
            <X size={20} />
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onClose} // auto-close sidebar on mobile after clicking a link
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-brand-primary/10 text-brand-primary border border-brand-primary/20'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="px-6 py-4 border-t border-border-subtle">
          <p className="text-xs text-text-tertiary">v1.0.0 — Production</p>
        </div>
      </aside>
    </>
  )
}

export default Sidebar