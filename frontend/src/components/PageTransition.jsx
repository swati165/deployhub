import { motion } from 'framer-motion'

/**
 * PageTransition
 * Wraps page content with a subtle fade + slide-up animation
 * whenever the route changes. Makes navigation feel smooth
 * instead of an abrupt content swap.
 *
 * Usage: wrap each page's root element with this component.
 */
function PageTransition({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}

export default PageTransition