import { Bell, Search, User, Menu, LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { logoutUser } from '../utils/auth'
import { apiRequest } from '../utils/api'

/**
 * Top Navbar
 * Contains: mobile hamburger menu, search bar, notifications, user avatar, logout.
 *
 * Props:
 * - onMenuClick: function - opens the mobile sidebar (only used on small screens)
 */
function Navbar({ onMenuClick }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')

  useEffect(() => {
    apiRequest('/auth/me')
      .then(({ user }) => setEmail(user.email))
      .catch(() => setEmail('Account unavailable'))
  }, [])

  const handleLogout = () => {
    logoutUser()
    navigate('/login')
  }

  return (
    <header className="h-16 bg-bg-secondary/80 backdrop-blur-md border-b border-border-subtle flex items-center justify-between px-4 sm:px-6 sticky top-0 z-10">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-bg-hover text-text-secondary transition-colors"
        >
          <Menu size={20} />
        </button>

        <div className="hidden sm:flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2 w-80">
          <Search size={16} className="text-text-tertiary" />
          <input
            type="text"
            placeholder="Search projects, deployments..."
            className="bg-transparent outline-none text-sm w-full placeholder:text-text-tertiary"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="relative p-2 rounded-lg hover:bg-bg-hover transition-colors">
          <Bell size={18} className="text-text-secondary" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-status-failed rounded-full"></span>
        </button>

        <div className="flex items-center gap-2 pl-3 border-l border-border-subtle">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-primary to-brand-secondary flex items-center justify-center">
            <User size={16} className="text-white" />
          </div>
          <div className="text-sm hidden sm:block">
            <p className="font-medium leading-tight">{email || 'DeployHub user'}</p>
            <p className="text-text-tertiary text-xs leading-tight">Workspace</p>
          </div>
        </div>

        {/* Logout button */}
        <button
          onClick={handleLogout}
          className="p-2 rounded-lg hover:bg-status-failed/10 text-text-secondary hover:text-status-failed transition-colors"
          title="Logout"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  )
}

export default Navbar