import { motion } from 'framer-motion'

/**
 * Reusable Button Component
 * 
 * Props:
 * - variant: 'primary' | 'secondary' | 'danger' | 'ghost' — controls color style
 * - size: 'sm' | 'md' | 'lg' — controls padding/font size
 * - icon: Lucide icon component (optional) — shown before text
 * - children: button label/text
 * - ...rest: any other native button props (onClick, disabled, type, etc.)
 */
function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  children,
  className = '',
  ...rest
}) {
  // Base styles shared by every button, regardless of variant
  const baseStyles =
    'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed'

  // Variant-specific color styles
  const variants = {
    primary:
      'bg-brand-primary text-white hover:bg-indigo-500 shadow-lg shadow-brand-primary/20',
    secondary:
      'bg-bg-hover text-text-primary border border-border-strong hover:bg-bg-card',
    danger:
      'bg-status-failed/10 text-status-failed border border-status-failed/30 hover:bg-status-failed/20',
    ghost:
      'bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary',
  }

  // Size-specific padding/text styles
  const sizes = {
    sm: 'text-xs px-3 py-1.5',
    md: 'text-sm px-4 py-2.5',
    lg: 'text-base px-6 py-3',
  }

  return (
    // motion.button gives us a subtle press animation - feels premium & responsive
    <motion.button
      whileTap={{ scale: 0.97 }}
      whileHover={{ scale: 1.02 }}
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {Icon && <Icon size={16} />}
      {children}
    </motion.button>
  )
}

export default Button