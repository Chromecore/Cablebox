import { useState, useEffect, useCallback, useRef } from 'react'
import VideoPlayer from './components/VideoPlayer.jsx'
import TVGuide from './components/TVGuide.jsx'
import ChannelOverlay from './components/ChannelOverlay.jsx'
import TouchMenu from './components/TouchMenu.jsx'

const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

function NextUpCard({ next }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const startTime = new Date(next.startTime)
  const secsUntil = Math.max(0, Math.floor((startTime - now) / 1000))
  const progress = Math.max(0, Math.min(1, 1 - secsUntil / (next.durationSeconds || 1800)))

  // Hide if more than 24 hours away
  if (secsUntil > 86400) return null

  const hrs  = Math.floor(secsUntil / 3600)
  const mins = Math.floor((secsUntil % 3600) / 60)
  const secs = secsUntil % 60
  const countdownText = hrs > 0
    ? `${hrs}h ${String(mins).padStart(2, '0')}m`
    : mins > 0
    ? `${mins}m ${String(secs).padStart(2, '0')}s`
    : `${secs}s`

  const formatTime = (d) => {
    const h = d.getHours(), m = d.getMinutes()
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  }

  return (
    <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
      {/* Blurred show backdrop as background, fall back to thumb */}
      {(next.backdropUrl || next.thumbUrl) && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${next.backdropUrl || next.thumbUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: 'blur(6px) brightness(0.45) saturate(1.2)',
            transform: 'scale(1.15)',
          }}
        />
      )}
      {/* Dark gradient overlay */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.75) 100%)' }}
      />

      {/* Content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
        {/* Badge */}
        <div
          className="font-mono uppercase tracking-widest px-4 py-1.5 rounded-full"
          style={{
            fontSize: 11,
            background: 'rgba(var(--accent-rgb),0.2)',
            border: '1px solid rgba(var(--accent-rgb),0.5)',
            color: 'var(--accent)',
          }}
        >
          Up Next
        </div>

        {/* Poster thumbnail */}
        {next.thumbUrl && (
          <img
            src={next.thumbUrl}
            alt=""
            className="rounded-xl shadow-2xl"
            style={{
              maxHeight: IS_MOBILE ? 120 : 200,
              maxWidth: IS_MOBILE ? 200 : 340,
              objectFit: 'contain',
              filter: 'drop-shadow(0 8px 32px rgba(0,0,0,0.8))',
            }}
          />
        )}

        {/* Title + time */}
        <div className="text-center px-8">
          <div
            className="text-white font-display font-bold leading-tight"
            style={{
              fontSize: IS_MOBILE ? 26 : 52,
              textShadow: '0 2px 24px rgba(0,0,0,0.9)',
            }}
          >
            {next.title}
          </div>
          <div className="text-white/45 font-mono mt-2" style={{ fontSize: IS_MOBILE ? 12 : 16 }}>
            {formatTime(startTime)} · {Math.round(next.durationSeconds / 60)}m
          </div>
        </div>

        {/* Big countdown */}
        <div
          className="font-mono font-bold"
          style={{
            fontSize: IS_MOBILE ? 60 : 96,
            letterSpacing: '-4px',
            lineHeight: 1,
            color: 'var(--accent)',
            filter: 'drop-shadow(0 0 32px var(--accent))',
          }}
        >
          {countdownText}
        </div>

        {/* Progress bar */}
        <div
          className="rounded-full overflow-hidden"
          style={{
            height: 3,
            width: IS_MOBILE ? '70vw' : 360,
            background: 'rgba(255,255,255,0.1)',
          }}
        >
          <div
            className="h-full rounded-full transition-all duration-1000"
            style={{ width: `${progress * 100}%`, background: 'var(--accent)' }}
          />
        </div>
      </div>
    </div>
  )
}

export default function ViewerApp({ onOpenPIN }) {
  const [channels, setChannels] = useState([])
  const [nowPlaying, setNowPlaying] = useState({}) // channelNumber -> NowPlayingInfo
  const [currentChannel, setCurrentChannel] = useState(1)
  const [showGuide, setShowGuide] = useState(false)
  const [showOverlay, setShowOverlay] = useState(false)
  const [pendingInput, setPendingInput] = useState('') // direct channel entry "04"
  const [showStreamingPrompt, setShowStreamingPrompt] = useState(false)
  const [showTouchMenu, setShowTouchMenu] = useState(false)
  const [jellyfinPublicUrl, setJellyfinPublicUrl] = useState('')
  const [standalone, setStandalone] = useState(false)
  const [localUrl, setLocalUrl] = useState('')

  const overlayTimerRef = useRef(null)
  const pendingTimerRef = useRef(null)
  const refreshTimerRef = useRef(null)
  const lastTapRef = useRef(0)

  const [customBindings, setCustomBindings] = useState({})
  useEffect(() => {
    fetch('/api/keybindings').then(r => r.json()).then(setCustomBindings).catch(() => {})
  }, [])
  useEffect(() => {
    const handler = () => {
      fetch('/api/keybindings').then(r => r.json()).then(setCustomBindings).catch(() => {})
    }
    window.addEventListener('cablebox-keybindings-changed', handler)
    return () => window.removeEventListener('cablebox-keybindings-changed', handler)
  }, [])

  // Load config (for Jellyfin public URL used by streaming toggle)
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(cfg => {
      if (cfg.jellyfinPublicUrl) setJellyfinPublicUrl(cfg.jellyfinPublicUrl)
      if (cfg.standalone) setStandalone(true)
      if (cfg.localUrl) setLocalUrl(cfg.localUrl)
    }).catch(() => {})
  }, [])

  // Load channels
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/channels', { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        setChannels(data)
        if (data.length > 0) setCurrentChannel(data[0].number)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  // Fetch now-playing info, refresh every 30s
  const fetchNow = useCallback(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    fetch('/api/now', { signal: controller.signal })
      .then(r => r.json())
      .then(setNowPlaying)
      .catch(() => {})
      .finally(() => clearTimeout(timer))
  }, [])

  useEffect(() => {
    fetchNow()
    refreshTimerRef.current = setInterval(fetchNow, 30_000)
    return () => clearInterval(refreshTimerRef.current)
  }, [fetchNow])

  const showChannelOverlay = useCallback(() => {
    setShowOverlay(true)
    clearTimeout(overlayTimerRef.current)
    overlayTimerRef.current = setTimeout(() => setShowOverlay(false), 3000)
  }, [])

  const tuneToChannel = useCallback((num) => {
    const channelNums = channels.map(c => c.number)
    if (!channelNums.includes(num)) return
    setCurrentChannel(num)
    showChannelOverlay()
    // Re-fetch now playing immediately for the new channel
    fetchNow()
  }, [channels, showChannelOverlay, fetchNow])

  const channelUp = useCallback(() => {
    const nums = channels.map(c => c.number)
    const idx = nums.indexOf(currentChannel)
    const next = nums[(idx + 1) % nums.length]
    tuneToChannel(next)
  }, [channels, currentChannel, tuneToChannel])

  const channelDown = useCallback(() => {
    const nums = channels.map(c => c.number)
    const idx = nums.indexOf(currentChannel)
    const prev = nums[(idx - 1 + nums.length) % nums.length]
    tuneToChannel(prev)
  }, [channels, currentChannel, tuneToChannel])

  // Double-tap / double-click → show touch menu
  const handleDoubleClick = useCallback(() => {
    if (showGuide || showStreamingPrompt || showTouchMenu) return
    setShowTouchMenu(true)
  }, [showGuide, showStreamingPrompt, showTouchMenu])

  const handleTouchEnd = useCallback((e) => {
    if (showGuide || showStreamingPrompt || showTouchMenu) return
    const now = Date.now()
    if (now - lastTapRef.current < 350) {
      e.preventDefault() // prevent synthetic click and browser double-tap zoom
      setShowTouchMenu(true)
      lastTapRef.current = 0
    } else {
      lastTapRef.current = now
    }
  }, [showGuide, showStreamingPrompt, showTouchMenu])

  // Keyboard handling
  useEffect(() => {
    const handler = (e) => {
      // Samsung/LG Smart TV remote channel keys fire numeric keyCodes
      if (e.keyCode === 427) { e.preventDefault(); channelUp(); return }
      if (e.keyCode === 428) { e.preventDefault(); channelDown(); return }

      // Custom key bindings (additive — don't block default keys below)
      if (!showGuide && !showTouchMenu && !showStreamingPrompt) {
        if (customBindings.channelUp?.key   === e.key) { e.preventDefault(); channelUp();                    return }
        if (customBindings.channelDown?.key === e.key) { e.preventDefault(); channelDown();                   return }
        if (customBindings.guide?.key       === e.key) { e.preventDefault(); setShowGuide(true);              return }
        if (customBindings.streaming?.key   === e.key) { e.preventDefault(); setShowStreamingPrompt(true);    return }
      }

      if (showTouchMenu) {
        if (e.key === 'Escape' || e.key === 'Backspace') {
          e.preventDefault()
          setShowTouchMenu(false)
        }
        return
      }

      // Streaming prompt dismissal
      if (showStreamingPrompt) {
        if (e.key === 'Escape' || e.key === 'Backspace') {
          e.preventDefault()
          setShowStreamingPrompt(false)
        }
        return
      }

      if (showGuide) return // guide handles its own keys

      switch (e.key) {
        case 'ArrowUp':
        case 'ChannelUp':    // W3C TV remote
        case 'PageUp':       // many generic remotes
          e.preventDefault()
          channelUp()
          break
        case 'ArrowDown':
        case 'ChannelDown':  // W3C TV remote
        case 'PageDown':     // many generic remotes
          e.preventDefault()
          channelDown()
          break
        case 'g':
        case 'G':
        case 'F1':
          e.preventDefault()
          setShowGuide(true)
          break
        case 'Escape':
        case 'Backspace':
          e.preventDefault()
          setShowOverlay(false)
          setPendingInput('')
          break
        case 's':
        case 'S':
          e.preventDefault()
          setShowStreamingPrompt(true)
          break
        default:
          // Direct channel entry: 0-9
          if (e.key >= '0' && e.key <= '9') {
            e.preventDefault()
            clearTimeout(pendingTimerRef.current)
            const next = pendingInput + e.key
            setPendingInput(next)

            if (next.length >= 2) {
              const num = parseInt(next, 10)
              tuneToChannel(num)
              setPendingInput('')
            } else {
              // Wait 1.5s for a second digit
              pendingTimerRef.current = setTimeout(() => {
                const num = parseInt(next, 10)
                tuneToChannel(num)
                setPendingInput('')
              }, 1500)
            }
          }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showGuide, showStreamingPrompt, showTouchMenu, channelUp, channelDown, pendingInput, tuneToChannel, customBindings])

  const currentInfo = nowPlaying[currentChannel]

  // When the block ends, re-fetch so the player switches to static
  const blockEndRef = useRef(null)
  useEffect(() => {
    clearTimeout(blockEndRef.current)
    if (!currentInfo?.endTime) return
    const ms = new Date(currentInfo.endTime) - Date.now()
    if (ms <= 0) { fetchNow(); return }
    blockEndRef.current = setTimeout(fetchNow, ms)
    return () => clearTimeout(blockEndRef.current)
  }, [currentInfo?.endTime, fetchNow])
  // Pre-warm Jellyfin's HLS transcoding session on mobile as soon as the channel's
  // info is known, so the session is already starting by the time VideoPlayer mounts.
  useEffect(() => {
    if (!IS_MOBILE) return
    const info = nowPlaying[currentChannel]
    if (!info?.streamUrl?.includes('stream-file')) return
    const itemId = new URLSearchParams(info.streamUrl.split('?')[1] || '').get('itemId')
    if (!itemId) return
    const startTicks = Math.round((info.positionSeconds ?? 0) * 10_000_000)
    fetch(`/api/stream-proxy?itemId=${itemId}&startTicks=${startTicks}`).catch(() => {})
  }, [nowPlaying[currentChannel]?.playbackKey])

  const currentChannelObj = channels.find(c => c.number === currentChannel)

  // Only suppress static when next item is within 24h (same threshold as NextUpCard)
  const nextWithin24h = currentInfo?.next
    ? (new Date(currentInfo.next.startTime) - Date.now()) <= 86_400_000
    : false

  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden"
      onDoubleClick={handleDoubleClick}
      onTouchEnd={handleTouchEnd}
      style={{ touchAction: 'manipulation' }}
    >
      {/* Main video player */}
      <VideoPlayer
        streamUrl={currentInfo?.streamUrl}
        blockId={currentInfo?.playbackKey}
        type={currentInfo?.type}
        emptyImageUrl={currentInfo?.emptyImageUrl}
        seekPosition={currentInfo?.positionSeconds ?? 0}
        onEnded={fetchNow}
        hideStatic={!!(currentInfo?.next && !currentInfo?.streamUrl && nextWithin24h)}
        localUrl={localUrl}
      />

      {/* Next up card — shown during a gap before the next scheduled item */}
      {!currentInfo?.streamUrl && currentInfo?.next && (
        <NextUpCard next={currentInfo.next} />
      )}

      {/* Pending channel input indicator */}
      {pendingInput && (
        <div className="absolute top-8 right-8 z-20 bg-black/80 rounded px-6 py-3 text-white text-5xl font-display font-bold tracking-widest border border-white/20">
          {pendingInput}_
        </div>
      )}

      {/* Channel overlay */}
      {showOverlay && currentChannelObj && (
        <ChannelOverlay
          channel={currentChannelObj}
          info={currentInfo}
        />
      )}

      {/* Streaming toggle prompt */}
      {showStreamingPrompt && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}
        >
          <div
            className="flex flex-col items-center gap-6 p-10 rounded-xl"
            style={{ background: 'rgba(12,21,32,0.95)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)' }}
          >
            <span className="material-symbols-outlined text-app-purple" style={{ fontSize: 56 }}>stream</span>
            <div className="text-center">
              <h2 className="font-display font-bold text-white text-2xl mb-2">Switch to Streaming</h2>
              <p className="text-white/50 text-sm">Opens Jellyfin in the browser.<br />Use the browser Back button to return to Cable.</p>
            </div>
            <div className="flex items-center gap-4">
              {jellyfinPublicUrl ? (
                <button
                  onClick={() => { window.location.href = jellyfinPublicUrl }}
                  className="flex items-center gap-2 px-8 py-3 rounded-lg font-display font-bold text-white text-lg transition-all"
                  style={{ background: 'rgba(var(--accent-rgb),0.5)', border: '1px solid rgba(var(--accent-rgb),0.8)' }}
                >
                  <span className="material-symbols-outlined">open_in_browser</span>
                  Open Jellyfin
                </button>
              ) : (
                <p className="text-white/30 text-sm">Jellyfin URL not configured in Settings.</p>
              )}
              <button
                onClick={() => setShowStreamingPrompt(false)}
                className="px-6 py-3 rounded-lg text-white/50 hover:text-white transition-colors"
                style={{ border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Cancel (Esc)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Touch / mouse menu (double-tap or double-click) */}
      {showTouchMenu && (
        <TouchMenu
          onChannelUp={() => channelUp()}
          onChannelDown={() => channelDown()}
          onGuide={() => setShowGuide(true)}
          onAdmin={() => onOpenPIN?.()}
          onJellyfin={() => setShowStreamingPrompt(true)}
          hasJellyfin={!!jellyfinPublicUrl}
          standalone={standalone}
          onClose={() => setShowTouchMenu(false)}
        />
      )}

      {/* TV Guide overlay */}
      {showGuide && (
        <TVGuide
          channels={channels}
          currentChannel={currentChannel}
          nowPlaying={nowPlaying}
          onTune={(num) => {
            tuneToChannel(num)
            setShowGuide(false)
          }}
          onClose={() => setShowGuide(false)}
        />
      )}
    </div>
  )
}
