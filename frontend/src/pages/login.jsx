import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Boxes, Mail, Lock, Eye, EyeOff, Loader2, GitBranch } from 'lucide-react'
import Button from '../components/Button'
import { loginUser } from '../utils/auth'
import { apiRequest } from '../utils/api'

function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isRegistering, setIsRegistering] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (isRegistering && password.length < 12) {
      setError('Use a password with at least 12 characters.')
      return
    }
    setLoading(true)
    try {
      const result = await apiRequest(`/auth/${isRegistering ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      loginUser(result.token)
      navigate('/', { replace: true })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
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
          <h1 className="text-xl font-bold">{isRegistering ? 'Create your workspace' : 'Welcome to DeployHub'}</h1>
          <p className="text-text-secondary text-sm mt-1">
            {isRegistering ? 'Start shipping your projects with confidence' : 'Sign in to manage your deployments'}
          </p>
        </div>

        {error && (
          <div role="alert" className="bg-status-failed/10 border border-status-failed/30 text-status-failed text-sm rounded-lg px-4 py-2.5 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="text-sm text-text-secondary mb-1.5 block">
              Email address
            </label>
            <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 focus-within:border-brand-primary transition-colors">
              <Mail size={16} className="text-text-tertiary" />
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                required
                className="bg-transparent outline-none text-sm w-full placeholder:text-text-tertiary"
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="text-sm text-text-secondary mb-1.5 block">
              Password
            </label>
            <div className="flex items-center gap-2 bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 focus-within:border-brand-primary transition-colors">
              <Lock size={16} className="text-text-tertiary" />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isRegistering ? 'At least 12 characters' : 'Your password'}
                autoComplete={isRegistering ? 'new-password' : 'current-password'}
                minLength={isRegistering ? 12 : 1}
                required
                className="bg-transparent outline-none text-sm w-full placeholder:text-text-tertiary"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

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
                {isRegistering ? 'Creating account...' : 'Signing in...'}
              </>
            ) : (
              isRegistering ? 'Create Account' : 'Sign In'
            )}
          </Button>
        </form>

        <p className="text-center text-xs text-text-tertiary mt-6">
          {isRegistering ? 'Already have an account? ' : "Don't have an account? "}
          <button
            type="button"
            onClick={() => { setError(''); setIsRegistering((value) => !value) }}
            className="text-brand-primary hover:underline"
          >
            {isRegistering ? 'Sign in' : 'Create an account'}
          </button>
        </p>
        <p className="text-center text-[11px] text-text-tertiary mt-3 flex items-center justify-center gap-1">
          <GitBranch size={12} /> Deployments currently support public GitHub repositories
        </p>
      </motion.div>
    </div>
  )
}

export default Login