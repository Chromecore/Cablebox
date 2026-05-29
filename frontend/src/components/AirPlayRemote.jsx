const key = (k) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

export default function AirPlayRemote({
  onChannelUp, onChannelDown, onGuide, showGuide,
  standalone, currentChannel, channels, currentInfo, onClose,
}) {
  const channelName = channels?.find(c => c.number === currentChannel)?.name ?? ''
  const showTitle   = currentInfo?.title ?? ''

  const btn = (content, onClick, className = '', style = {}) => (
    <button
      onPointerDown={e => { e.preventDefault(); onClick() }}
      className={`flex items-center justify-center gap-2 rounded-xl font-display font-semibold select-none active:scale-95 transition-transform ${className}`}
      style={style}
    >
      {content}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: '#0c1520' }}
    >
      {/* Status bar */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4 border-b border-white/10">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-white/50 text-xs font-mono uppercase tracking-wider">AirPlaying</div>
          <div className="text-white font-display font-bold text-sm truncate">
            {currentChannel ? `Ch.${currentChannel}${channelName ? ` — ${channelName}` : ''}` : ''}
          </div>
          {showTitle && (
            <div className="text-white/40 text-xs truncate">{showTitle}</div>
          )}
        </div>
        <button
          onPointerDown={e => { e.preventDefault(); onClose?.() }}
          className="text-white/30 hover:text-white/60 active:scale-95 transition-all"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>close</span>
        </button>
      </div>

      {/* Main controls */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6">

        {/* Top row: CH+ and Guide */}
        <div className="flex gap-4 w-full max-w-xs">
          {btn(
            <><span className="material-symbols-outlined" style={{ fontSize: 22 }}>expand_less</span>Channel Up</>,
            onChannelUp,
            'flex-1 py-4 text-white text-sm',
            { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }
          )}
          {btn(
            <><span className="material-symbols-outlined" style={{ fontSize: 22 }}>grid_view</span>{showGuide ? 'Close Guide' : 'Guide'}</>,
            onGuide,
            'flex-1 py-4 text-sm',
            {
              background: showGuide ? 'rgba(var(--accent-rgb),0.3)' : 'rgba(255,255,255,0.07)',
              border: showGuide ? '1px solid rgba(var(--accent-rgb),0.6)' : '1px solid rgba(255,255,255,0.12)',
              color: showGuide ? 'white' : 'rgba(255,255,255,0.8)',
            }
          )}
        </div>

        {/* D-pad */}
        <div className="relative w-44 h-44">
          {/* Up */}
          <button
            onPointerDown={e => { e.preventDefault(); key('ArrowUp') }}
            className="absolute top-0 left-1/2 -translate-x-1/2 w-14 h-14 flex items-center justify-center rounded-2xl active:scale-95 transition-transform"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <span className="material-symbols-outlined text-white/80" style={{ fontSize: 28 }}>keyboard_arrow_up</span>
          </button>

          {/* Left */}
          <button
            onPointerDown={e => { e.preventDefault(); key('ArrowLeft') }}
            className="absolute left-0 top-1/2 -translate-y-1/2 w-14 h-14 flex items-center justify-center rounded-2xl active:scale-95 transition-transform"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <span className="material-symbols-outlined text-white/80" style={{ fontSize: 28 }}>keyboard_arrow_left</span>
          </button>

          {/* Center / Select */}
          <button
            onPointerDown={e => { e.preventDefault(); key('Enter') }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 flex items-center justify-center rounded-full active:scale-95 transition-transform"
            style={{ background: 'rgba(var(--accent-rgb),0.35)', border: '2px solid rgba(var(--accent-rgb),0.7)' }}
          >
            <span className="material-symbols-outlined text-white" style={{ fontSize: 26 }}>check</span>
          </button>

          {/* Right */}
          <button
            onPointerDown={e => { e.preventDefault(); key('ArrowRight') }}
            className="absolute right-0 top-1/2 -translate-y-1/2 w-14 h-14 flex items-center justify-center rounded-2xl active:scale-95 transition-transform"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <span className="material-symbols-outlined text-white/80" style={{ fontSize: 28 }}>keyboard_arrow_right</span>
          </button>

          {/* Down */}
          <button
            onPointerDown={e => { e.preventDefault(); key('ArrowDown') }}
            className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-14 flex items-center justify-center rounded-2xl active:scale-95 transition-transform"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <span className="material-symbols-outlined text-white/80" style={{ fontSize: 28 }}>keyboard_arrow_down</span>
          </button>
        </div>

        {/* CH- */}
        {btn(
          <><span className="material-symbols-outlined" style={{ fontSize: 22 }}>expand_more</span>Channel Down</>,
          onChannelDown,
          'w-full max-w-xs py-4 text-white text-sm',
          { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }
        )}
      </div>

      {/* Shutdown — standalone only */}
      {standalone && (
        <div className="px-6 pb-8">
          {btn(
            <><span className="material-symbols-outlined" style={{ fontSize: 20 }}>power_settings_new</span>Shut Down</>,
            () => fetch('/api/shutdown', { method: 'POST' }).catch(() => {}),
            'w-full py-4 text-sm',
            { background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: 'rgba(239,68,68,0.9)' }
          )}
        </div>
      )}
    </div>
  )
}
