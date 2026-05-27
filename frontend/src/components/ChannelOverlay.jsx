function fmtTime(secs) {
  if (!secs || secs <= 0) return null
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function ChannelOverlay({ channel, info }) {
  const hasContent = info && info.type !== 'off' && info.type !== 'empty'
  const title = hasContent
    ? (info?.title || 'Unknown')
    : (info?.type === 'empty' ? 'Empty' : 'Off Air')

  return (
    <div className="absolute bottom-12 left-10 z-30 animate-fade-in pointer-events-none">
      <div
        className="flex items-center gap-4 px-5 py-4 rounded"
        style={{
          background: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '4px 4px 0px 0px rgba(0,0,0,0.8)',
        }}
      >
        {/* Channel logo or number */}
        {channel.logoUrl ? (
          <img src={channel.logoUrl} alt="" className="w-12 h-12 object-contain rounded" />
        ) : (
          <div
            className="w-14 h-14 flex items-center justify-center rounded font-display font-black text-white text-xl flex-shrink-0"
            style={{ background: 'rgba(var(--accent-rgb),0.3)', border: '2px solid rgba(var(--accent-rgb),0.6)' }}
          >
            {channel.number}
          </div>
        )}

        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-white/60 text-sm font-mono tracking-wider uppercase">
              CH {channel.number}
            </span>
            {channel.name && (
              <span className="text-white font-semibold text-base truncate max-w-48">
                {channel.name}
              </span>
            )}
          </div>
          <span className={`text-sm truncate max-w-64 mt-0.5 ${hasContent ? 'text-white/90' : 'text-white/35'}`}>
            {title}
          </span>
          <div className="flex items-center gap-2 mt-0.5">
            {info?.seasonNumber > 0 && info?.episodeNumber > 0 && (
              <span className="text-app-purple text-xs font-mono">
                S{String(info.seasonNumber).padStart(2, '0')}E{String(info.episodeNumber).padStart(2, '0')}
              </span>
            )}
            {hasContent && info?.positionSeconds > 0 && info?.episodeDurationSeconds > 0 && (
              <span className="text-white/35 text-xs font-mono">
                {fmtTime(info.positionSeconds)} / {fmtTime(info.episodeDurationSeconds)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar — use episode duration when available, fall back to block duration */}
      {hasContent && (info.episodeDurationSeconds > 0 || info.durationSeconds > 0) && (
        <div className="mt-1 h-1 rounded-full bg-white/10 overflow-hidden" style={{ width: '100%' }}>
          <div
            className="h-full rounded-full bg-app-purple transition-all"
            style={{ width: `${Math.min(100, (info.positionSeconds / (info.episodeDurationSeconds || info.durationSeconds)) * 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}
