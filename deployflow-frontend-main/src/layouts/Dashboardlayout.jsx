import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Sidebar from '../components/Sidebar'
import Navbar from '../components/Navbar'
import PageTransition from '../components/PageTransition'

/**
 * DashboardLayout
 * Wraps all internal app pages with a consistent Sidebar + Navbar shell.
 * Manages mobile sidebar open/close state and page transition animations.
 */
function DashboardLayout() {
  const location = useLocation()
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  return (
    <div className="flex">
      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      <div className="flex-1 lg:ml-64">
        <Navbar onMenuClick={() => setIsSidebarOpen(true)} />
        <main className="p-4 sm:p-6">
          <AnimatePresence mode="wait">
            <PageTransition key={location.pathname}>
              <Outlet />
            </PageTransition>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}

export default DashboardLayout