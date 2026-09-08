import { motion } from 'framer-motion'

/**
 * Reusable Card Component
 * The base container used across Dashboard, Projects, Monitoring pages
 * for stat boxes, charts, lists etc.
 *
 * Props:
 * - children: card content
 * - hover: boolean — adds a subtle lift + glow on hover (for clickable cards)
 * - glass: boolean — toggles glassmorphism effect vs solid background
 * - className: extra utility classes if needed
 * - onClick: optional click handler (makes the card interactive/clickable)
 */
function Card({ children, hover = false, glass = true, className = '', onClick }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      whileHover={hover ? { y: -4 } : {}}
      onClick={onClick}
      className={`
        ${glass ? 'glass' : 'bg-bg-card border border-border-subtle'}
        rounded-2xl p-5
        ${hover ? 'cursor-pointer hover:border-brand-primary/40 hover:shadow-lg hover:shadow-brand-primary/10 transition-all duration-300' : ''}
        ${className}
      `}
    >
      {children}
    </motion.div>
  )
}

export default Card