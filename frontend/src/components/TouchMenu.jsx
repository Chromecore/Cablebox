import { useEffect, useRef } from 'react'

const DISMISS_MS = 4000

export default function TouchMenu({ onChannelUp, onChannelDown, onGuide, onAdmin, onJellyfin, hasJellyfin, onClose }) {
  const barRef = useRef(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    const timer = setTimeout(() => onCloseRef.current(), DISMISS_MS)
    // Start the drain on the next frame so the initial 100% width paints first
    requestAnimationFrame(() => {
      if (barRef.current) {
        barRef.current.style.transition = `width ${DISMISS_MS}ms linear`
        barRef.current.style.width = '0%'
      }
    })
    return () => clearTimeout(timer)
  }, [])

  const buttons = [
    { icon: 'keyboard_arrow_up',    label: 'Channel Up',    action: onChannelUp },
    { icon: 'keyboard_arrow_down',  label: 'Channel Down',  action: onChannelDown },
    { icon: 'grid_view',            label: 'Guide',         action: onGuide },
    { icon: 'admin_panel_settings', label: 'Admin',         action: onAdmin },
    ...(hasJellyfin ? [{ icon: 'stream', label: 'Open Jellyfin', action: onJellyfin }] : []),
  ]

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="rounded-xl overflow-hidden w-72"
        style={{
          background: 'rgba(12,21,32,0.97)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)',
        }}
      >
        {buttons.map(({ icon, label, action }) => (
          <button
            key={label}
            onPointerDown={e => { e.stopPropagation(); action(); onClose() }}
            className="flex items-center gap-4 w-full px-6 py-4 text-left border-b border-white/5 last:border-0 active:bg-white/5"
            style={{ color: 'rgba(255,255,255,0.9)' }}
          >
            <span className="material-symbols-outlined text-app-purple" style={{ fontSize: 26 }}>{icon}</span>
            <span className="font-display font-semibold text-base">{label}</span>
          </button>
        ))}

        {/* Auto-dismiss progress bar */}
        <div className="h-0.5 bg-white/5">
          <div
            ref={barRef}
            style={{ width: '100%', height: '100%', background: 'rgba(var(--accent-rgb),0.6)' }}
          />
        </div>
      </div>
    </div>
  )
}
