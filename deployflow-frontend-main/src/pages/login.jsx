import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Boxes, Mail, Lock, Eye, EyeOff, Loader2 } from 'lucide-react'
import Button from '../components/Button'
import { loginUser } from '../utils/auth'

/**
 * Login Page
 * Full-screen auth page - does NOT use DashboardLayout (no sidebar/navbar).
 * Currently uses local state + fake delay to simulate an API call.
 * We'll wire this to a real authService (Axios) in a later step.
 */
function Login() {
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    setError('')

    // Basic validation (real validation/API call comes later)
    if (!email || !password) {
      setError('Please fill in both fields.')
      return
    }

    setLoading(true)

   // TEMP: simulate network delay - will be replaced with real authService.login()
    setTimeout(() => {
      loginUser() // saves the mock auth token to localStorage
      setLoading(false)
      navigate('/') // redirect to Dashboard after "login"
    }, 1200)
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center relative overflow-hidden px-4">
      {/* Decorative background glow blobs - gives depth without being distracting */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-brand-primary/20 rounded-full blur-[120px]" />
      <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-brand-secondary/20 rounded-full blur-[120px]" />

      {/* Auth Card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="glass rounded-2xl p-8 w-full max-w-md relative z-10"
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-primary to-brand-secondary flex items-center justify-center mb-3">
            <Boxes size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-bold">Welcome to DeployFlow</h1>
          <p className="text-text-secondary text-sm mt-1">
            Sign in to manage your deployments
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="bg-status-failed/10 border border-status-failed/30 text-status-failed text-sm rounded-lg px-4 py-2.5 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email field */}
          <div>
            <label className="text-sm text-text-secondary mb-1.5 block">
              Email address
            </label>
            <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 focus-within:border-brand-primary transition-colors">
              <Mail size={16} className="text-text-tertiary" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="bg-transparent outline-none text-sm w-full placeholder:text-text-tertiary"
              />
            </div>
          </div>

          {/* Password field */}
          <div>
            <label className="text-sm text-text-secondary mb-1.5 block">
              Password
            </label>
            <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 focus-within:border-brand-primary transition-colors">
              <Lock size={16} className="text-text-tertiary" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="bg-transparent outline-none text-sm w-full placeholder:text-text-tertiary"
              />
              {/* Toggle password visibility */}
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Forgot password link */}
          <div className="flex justify-end">
            <a href="#" className="text-xs text-brand-primary hover:underline">
              Forgot password?
            </a>
          </div>

          {/* Submit button */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full mt-2"
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign In'
            )}
          </Button>
        </form>

        {/* Footer note */}
        <p className="text-center text-xs text-text-tertiary mt-6">
          Don't have an account?{' '}
          <a href="#" className="text-brand-primary hover:underline">
            Contact your admin
          </a>
        </p>
      </motion.div>
    </div>
  )
}

export default Login