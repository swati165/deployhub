/**
 * ToggleSwitch
 * A reusable on/off switch - used in Settings > Notifications,
 * and can be reused anywhere else a boolean setting is needed.
 *
 * Props:
 * - checked: boolean - current state
 * - onChange: function - called with the new boolean value when toggled
 */
function ToggleSwitch({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
        checked ? 'bg-brand-primary' : 'bg-bg-hover border border-border-strong'
      }`}
    >
      {/* The sliding circle/knob */}
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export default ToggleSwitch