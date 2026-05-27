import { useState, useEffect, useRef, useMemo } from 'react'

const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

const SLOT_WIDTH    = IS_MOBILE ? 110 : 160   // px per 30-min slot
const CHANNEL_COL   = IS_MOBILE ? 74  : 110   // channel label column width
const ROW_HEIGHT    = IS_MOBILE ? 52  : 60    // px per channel row
const HEADER_HEIGHT = 36                       // time header height
const HOURS_BACK    = 4
const HOURS_FORWARD = 24
const TOTAL_SLOTS   = (HOURS_BACK + HOURS_FORWARD) * 2  // half-hour slots
const GRID_WIDTH    = TOTAL_SLOTS * SLOT_WIDTH

const BG_NAV      = 'rgba(8,14,22,0.82)'
const BG_CH_COL   = 'rgb(6,11,18)'       // fully opaque so episodes don't bleed through

export default function TVGuide({ channels, currentChannel, nowPlaying, onTune, onClose }) {
  const [schedule, setSchedule] = useState([])
  const [focusedChannel, setFocusedChannel] = useState(currentChannel)
  const [now, setNow] = useState(new Date())
  const gridRef = useRef(null)
  const scrolledToNow = useRef(false)

  // Fixed window start: snapped to nearest 30-min boundary, HOURS_BACK ago.
  const windowStart = useMemo(() => {
    const base = new Date(Date.now() - HOURS_BACK * 3600_000)
    base.setMinutes(base.getMinutes() < 30 ? 0 : 30, 0, 0)
    return base
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const from = new Date(windowStart).toISOString()
    const to   = new Date(windowStart.getTime() + (HOURS_BACK + HOURS_FORWARD) * 3600_000).toISOString()
    fetch(`/api/schedule?from=${from}&to=${to}&expand=true`)
      .then(r => r.json())
      .then(setSchedule)
      .catch(() => {})
  }, [windowStart])

  // Scroll to current time + current channel once after schedule loads.
  useEffect(() => {
    if (scrolledToNow.current || !gridRef.current || schedule.length === 0) return
    scrolledToNow.current = true
    const el = gridRef.current
    const nX = timeToX(now)
    el.scrollLeft = Math.max(0, nX - (el.clientWidth - CHANNEL_COL) * 0.25)
    const idx = channels.findIndex(c => c.number === currentChannel)
    if (idx >= 0) {
      const y = idx * ROW_HEIGHT + HEADER_HEIGHT
      el.scrollTop = Math.max(0, y - el.clientHeight * 0.3)
    }
  }, [schedule])  // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard navigation (desktop).
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const el = gridRef.current

      switch (e.key) {
        case 'ArrowUp': {
          const idx = channels.findIndex(c => c.number === focusedChannel)
          if (idx > 0) {
            const newCh = channels[idx - 1].number
            setFocusedChannel(newCh)
            if (el) {
              const y = (idx - 1) * ROW_HEIGHT + HEADER_HEIGHT
              if (y - HEADER_HEIGHT < el.scrollTop) el.scrollTop = y - HEADER_HEIGHT
            }
          }
          break
        }
        case 'ArrowDown': {
          const idx = channels.findIndex(c => c.number === focusedChannel)
          if (idx < channels.length - 1) {
            const newCh = channels[idx + 1].number
            setFocusedChannel(newCh)
            if (el) {
              const y = (idx + 1) * ROW_HEIGHT + HEADER_HEIGHT
              if (y + ROW_HEIGHT > el.scrollTop + el.clientHeight)
                el.scrollTop = y + ROW_HEIGHT - el.clientHeight
            }
          }
          break
        }
        case 'ArrowLeft':
          if (el) el.scrollLeft = Math.max(0, el.scrollLeft - SLOT_WIDTH)
          break
        case 'ArrowRight':
          if (el) el.scrollLeft += SLOT_WIDTH
          break
        case 'Enter':
          onTune(focusedChannel)
          break
        case 'Escape':
        case 'Backspace':
        case 'g':
        case 'G':
        case 'F1':
          onClose()
          break
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [focusedChannel, channels, onTune, onClose])

  const timeToX = (t) =>
    (new Date(t).getTime() - windowStart.getTime()) / (30 * 60_000) * SLOT_WIDTH

  const nowX = timeToX(now)

  const timeSlots = useMemo(() => {
    const slots = []
    for (let i = 0; i < TOTAL_SLOTS; i++)
      slots.push(new Date(windowStart.getTime() + i * 30 * 60_000))
    return slots
  }, [windowStart])

  const blocksByChannel = useMemo(() => {
    const map = {}
    for (const b of schedule) {
      if (!map[b.channelId]) map[b.channelId] = []
      map[b.channelId].push(b)
    }
    return map
  }, [schedule])

  const formatTime = (d) => {
    const h = d.getHours(), m = d.getMinutes()
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  }

  return (
    <div className="absolute inset-0 z-40" onClick={onClose}>
    <div
      className="flex flex-col"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width:  IS_MOBILE ? '100%' : 'min(90vw, 1100px)',
        height: IS_MOBILE ? '100%' : 'min(75vh, 620px)',
        background: BG_NAV,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderBottom: IS_MOBILE ? 'none' : '1px solid rgba(255,255,255,0.08)',
        borderRight:  IS_MOBILE ? 'none' : '1px solid rgba(255,255,255,0.08)',
        borderBottomRightRadius: IS_MOBILE ? 0 : 12,
        overflow: 'hidden',
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header bar */}
      <div
        className="flex items-center gap-3 px-4 py-2 border-b border-white/10 flex-shrink-0"
        style={{ background: BG_CH_COL, paddingTop: IS_MOBILE ? 'calc(0.5rem + env(safe-area-inset-top, 0px))' : undefined }}
      >
        <span className="material-symbols-outlined text-app-purple" style={{ fontSize: 20 }}>tv</span>
        <span className="font-display font-bold text-base text-white tracking-wide">TV GUIDE</span>
        <span className="ml-auto text-white/60 text-xs font-mono">{formatTime(now)}</span>
        <button onClick={onClose} className="text-white/40 hover:text-white transition-colors ml-1">
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
        </button>
      </div>

      {/* Single scrollable grid */}
      <div
        ref={gridRef}
        className="flex-1 overflow-auto tvguide-grid"
        style={{
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'none',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          touchAction: 'pan-x pan-y',
        }}
      >
        <div style={{ width: CHANNEL_COL + GRID_WIDTH }}>

          {/* ── Sticky time-header row ── */}
          <div
            className="flex border-b border-white/10"
            style={{ position: 'sticky', top: 0, zIndex: 30, height: HEADER_HEIGHT, background: BG_NAV }}
          >
            {/* Frozen corner */}
            <div
              style={{
                width: CHANNEL_COL, flexShrink: 0,
                position: 'sticky', left: 0, zIndex: 32,
                background: BG_CH_COL,
                borderRight: '1px solid rgba(255,255,255,0.08)',
              }}
            />
            {/* Time slot labels */}
            {timeSlots.map((t, i) => (
              <div
                key={i}
                className="flex-shrink-0 flex items-center pl-2 text-white/50 font-mono border-r border-white/5"
                style={{ width: SLOT_WIDTH, fontSize: IS_MOBILE ? 9 : 11 }}
              >
                {formatTime(t)}
              </div>
            ))}
          </div>

          {/* ── Channel rows ── */}
          <div style={{ position: 'relative' }}>
            {/* "Now" indicator line */}
            {nowX >= 0 && nowX <= GRID_WIDTH && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: CHANNEL_COL + nowX,
                  width: 2,
                  background: 'var(--accent)',
                  boxShadow: '0 0 8px var(--accent)',
                  zIndex: 15,
                }}
              />
            )}

            {channels.map((ch) => {
              const chBlocks = blocksByChannel[ch.id] || []
              const isFocused = focusedChannel === ch.number
              const isCurrent = ch.number === currentChannel

              return (
                <div
                  key={ch.id}
                  className="flex border-b border-white/10"
                  style={{ height: ROW_HEIGHT }}
                >
                  {/* Sticky channel cell */}
                  <div
                    className="flex items-center gap-1.5 px-2 border-r border-white/10 cursor-pointer flex-shrink-0"
                    style={{
                      width: CHANNEL_COL,
                      position: 'sticky', left: 0, zIndex: 20,
                      background: isFocused
                        ? 'rgba(var(--accent-rgb),1)'
                        : isCurrent
                        ? 'rgba(var(--accent-rgb),1)'
                        : BG_CH_COL,
                    }}
                    onClick={() => { setFocusedChannel(ch.number); onTune(ch.number) }}
                  >
                    {ch.logoUrl ? (
                      <img
                        src={ch.logoUrl} alt=""
                        className="object-contain rounded flex-shrink-0"
                        style={{ width: 22, height: 22 }}
                      />
                    ) : (
                      <div
                        className="flex items-center justify-center rounded font-display font-bold flex-shrink-0"
                        style={{
                          width: 26, height: 26,
                          background: 'rgba(var(--accent-rgb),0.25)',
                          color: isCurrent ? 'var(--accent)' : 'rgba(255,255,255,0.7)',
                          fontSize: 9,
                        }}
                      >
                        {ch.number}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div
                        className={`font-mono truncate leading-tight ${isFocused || isCurrent ? 'text-white' : 'text-white/50'}`}
                        style={{ fontSize: 8 }}
                      >
                        CH {ch.number}
                      </div>
                      {ch.name && (
                        <div className={`truncate leading-tight ${isFocused || isCurrent ? 'text-white' : 'text-white/70'}`} style={{ fontSize: 9 }}>
                          {ch.name}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Program area */}
                  <div
                    className="relative flex-shrink-0"
                    style={{
                      width: GRID_WIDTH, height: ROW_HEIGHT,
                      // CSS grid lines — no extra DOM nodes
                      backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, transparent 1px, transparent ${SLOT_WIDTH}px)`,
                    }}
                    onClick={() => { setFocusedChannel(ch.number); onTune(ch.number) }}
                  >
                    {chBlocks.map((block) => {
                      if (!block.computedStart || !block.computedEnd) return null
                      const rawStartX = timeToX(block.computedStart)
                      const rawEndX   = timeToX(block.computedEnd)
                      const startX = Math.max(0, rawStartX)
                      const endX   = Math.min(GRID_WIDTH, rawEndX)
                      const width  = endX - startX
                      if (width <= 2) return null

                      const isLive     = now >= new Date(block.computedStart) && now < new Date(block.computedEnd)
                      const showThumb  = block.thumbUrl && width > 60

                      return (
                        <div
                          key={block.id + block.computedStart}
                          className="absolute top-1 bottom-1 rounded overflow-hidden flex items-center gap-1 cursor-pointer"
                          style={{
                            left: startX,
                            width: Math.max(2, width - 2),
                            background: isFocused
                              ? 'rgba(var(--accent-rgb),0.45)'
                              : isLive && isCurrent ? 'rgba(0,180,90,0.25)'
                              : isLive            ? 'rgba(0,180,90,0.15)'
                              : isCurrent         ? 'rgba(var(--accent-rgb),0.25)'
                              :                     'rgba(30,42,58,0.9)',
                            border: isFocused
                              ? '1px solid rgba(var(--accent-rgb),0.8)'
                              : isLive && isCurrent ? '1px solid rgba(0,200,100,0.7)'
                              : isLive            ? '1px solid rgba(0,200,100,0.35)'
                              :                     '1px solid rgba(255,255,255,0.08)',
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setFocusedChannel(ch.number)
                            onTune(ch.number)
                          }}
                        >
                          {showThumb && (
                            <div
                              className="h-full flex-shrink-0"
                              style={{
                                width: 30,
                                backgroundImage: `url(${block.thumbUrl})`,
                                backgroundSize: 'cover',
                                backgroundPosition: 'center',
                              }}
                            />
                          )}
                          <div className="min-w-0 flex-1 flex flex-col justify-center px-1">
                            <div className="flex items-center gap-1">
                              <div
                                className="text-white font-semibold truncate leading-tight"
                                style={{ fontSize: IS_MOBILE ? 9 : 11 }}
                              >
                                {block.showName || block.episodeName || 'Unknown'}
                              </div>
                              {isLive && (
                                <span
                                  className="flex-shrink-0 font-bold rounded px-0.5"
                                  style={{ fontSize: 7, background: 'rgba(0,200,100,0.9)', color: '#000', lineHeight: '13px' }}
                                >
                                  LIVE
                                </span>
                              )}
                            </div>
                            {!IS_MOBILE && block.seasonNumber > 0 && block.episodeNumber > 0 && (
                              <div className="text-white/60 truncate" style={{ fontSize: 9 }}>
                                S{String(block.seasonNumber).padStart(2, '0')}E{String(block.episodeNumber).padStart(2, '0')}
                                {block.episodeName ? ` · ${block.episodeName}` : ''}
                              </div>
                            )}
                            <div className="text-white/30 truncate" style={{ fontSize: IS_MOBILE ? 8 : 9 }}>
                              {formatTime(new Date(block.computedStart))} · {Math.round(block.durationSeconds / 60)}m
                            </div>
                          </div>
                        </div>
                      )
                    })}

                    {chBlocks.length === 0 && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-white/15 font-mono" style={{ fontSize: 10 }}>—</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

    </div>
    </div>
  )
}
