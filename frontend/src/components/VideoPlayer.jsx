import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

// Computed once at module load — false on iOS WebKit (no MSE), true on Chrome/Firefox.
const USE_HLS   = Hls.isSupported()

// Mobile browsers can't decode common audio codecs (AC3/DTS/EAC3) in direct video files.
// Detect mobile once so we skip the doomed direct-file attempt and go straight to HLS.
const IS_IOS    = /iPhone|iPad|iPod/i.test(navigator.userAgent)
const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent)

export default function VideoPlayer({ streamUrl, blockId, type, emptyImageUrl, seekPosition = 0, onEnded, hideStatic = false }) {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [playBlocked, setPlayBlocked] = useState(false)
  const [mutedAutoplay, setMutedAutoplay] = useState(false)
  const [airplayAvailable, setAirplayAvailable] = useState(false)
  const [airplayActive, setAirplayActive] = useState(false)

  // streamUrl is stable per episode (no startTicks in URL), only changes on block/episode switch.
  const streamUrlRef = useRef(streamUrl)
  useEffect(() => { streamUrlRef.current = streamUrl }, [streamUrl])

  // seekPosition is the live episode offset in seconds — set once when the block loads.
  const seekPositionRef = useRef(seekPosition)
  useEffect(() => { seekPositionRef.current = seekPosition }, [seekPosition])

  // AirPlay availability — iOS WebKit only
  useEffect(() => {
    const video = videoRef.current
    if (!video || !('WebKitPlaybackTargetAvailabilityEvent' in window)) return

    const onAvailability = (e) => setAirplayAvailable(e.availability === 'available')

    const onPresentationChange = () => {
      const isWireless = video.webkitCurrentPlaybackTargetIsWireless ?? false
      setAirplayActive(isWireless)
      if (isWireless) {
        // HLS.js attaches via a MediaSource blob URL. Apple TV can't fetch video from a
        // blob — only audio relays, so the TV gets audio-only. Switch to native HLS
        // (real URL) only while AirPlay is active so Apple TV can fetch the stream
        // directly. Local playback keeps HLS.js for better buffering / quality control.
        video.removeAttribute('playsinline')
        video.removeAttribute('webkit-playsinline')
        if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
        // Advance startTicks by elapsed time so Apple TV joins at the current position.
        let url = streamUrlRef.current || ''
        const elapsed = Math.round((video.currentTime || 0) * 10_000_000)
        url = url.replace(/startTicks=(\d+)/, (_, t) => `startTicks=${parseInt(t, 10) + elapsed}`)
        video.src = url
        video.load()
        video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true })
      } else {
        video.setAttribute('playsinline', '')
        // Back on device — restore HLS.js for local playback.
        if (streamUrlRef.current) {
          const hls = new Hls({ startFragPrefetch: true, maxBufferLength: 10, maxMaxBufferLength: 30 })
          hlsRef.current = hls
          hls.attachMedia(video)
          hls.loadSource(streamUrlRef.current)
          video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true })
        }
      }
    }

    video.addEventListener('webkitplaybacktargetavailabilitychanged', onAvailability)
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onPresentationChange)
    return () => {
      video.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvailability)
      video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onPresentationChange)
    }
  }, [])

  // Keep playing when the iOS screen locks.
  // Without MediaSession registration, iOS suspends the page and pauses the video
  // on the first screen-off. Registering handlers (even no-ops) signals active media.
  useEffect(() => {
    if (!IS_MOBILE || !('mediaSession' in navigator)) return
    const video = videoRef.current
    if (!video) return

    navigator.mediaSession.metadata = new MediaMetadata({ title: 'CableBox', album: 'Live TV' })
    navigator.mediaSession.setActionHandler('play', () => video.play().catch(() => {}))
    // No pause handler — registering one intercepts the lock-screen pause button and
    // blocks the user from pausing. Omitting it lets iOS handle it naturally.

    // Immediate resume on any unexpected pause (e.g. first screen lock on iOS).
    // No setTimeout — JS can be suspended at lock time so a timer may never fire.
    // readyState < 2 means video.load() just fired and the element has no data yet —
    // calling play() that early races against loading and can cause audio-only black screen.
    const onPause = () => {
      if (video.ended || !streamUrlRef.current) return
      if (video.readyState < 2) return
      video.play().catch(() => {})
    }
    video.addEventListener('pause', onPause)

    // When the screen turns back on, ensure playback resumes in case the immediate
    // onPause call was also suppressed while JS was suspended.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && video.paused && streamUrlRef.current && !video.ended) {
        video.play().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      video.removeEventListener('pause', onPause)
      document.removeEventListener('visibilitychange', onVisible)
      try { navigator.mediaSession.setActionHandler('play', null) } catch {}
    }
  }, [])

  // initStream: direct video src for files; HLS.js for m3u8/stream-proxy URLs.
  // onHlsError is wired to the caller's retry/fallback logic — without it, HLS.js
  // failures are silently swallowed and the video loads forever.
  function initStream(video, url, onHlsError) {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }

    let effectiveUrl = url
    // Mobile browsers can't decode AC3/DTS/EAC3 — skip the doomed direct-file
    // attempt entirely and go straight to HLS transcoding (outputs AAC).
    if (IS_MOBILE && url.includes('stream-file')) {
      const itemId = new URLSearchParams(url.split('?')[1] || '').get('itemId')
      if (itemId) {
        const startTicks = Math.round(seekPositionRef.current * 10_000_000)
        effectiveUrl = `/api/stream-proxy?itemId=${itemId}&startTicks=${startTicks}`
        streamUrlRef.current = effectiveUrl
      }
    }

    if (USE_HLS && (effectiveUrl.includes('.m3u8') || effectiveUrl.includes('stream-proxy'))) {
      const hls = new Hls({ startFragPrefetch: true, maxBufferLength: 10, maxMaxBufferLength: 30 })
      hlsRef.current = hls
      if (onHlsError) hls.on(Hls.Events.ERROR, onHlsError)
      hls.attachMedia(video)
      hls.loadSource(effectiveUrl)
    } else {
      video.src = effectiveUrl
      video.load()
    }
  }

  // Persistent effect: whenever the user produces a gesture, retry play on a blocked video.
  // This fires before other keydown handlers (capture phase) but does NOT prevent default,
  // so guide / channel navigation is unaffected.
  useEffect(() => {
    const tryUnlock = () => {
      const video = videoRef.current
      if (!video || !streamUrlRef.current || video.ended) return
      if (video.muted && !video.paused) {
        // Playing muted — user tapped for sound, just unmute.
        video.muted = false
        setMutedAutoplay(false)
        return
      }
      if (video.paused) {
        setLoading(true)
        setPlayBlocked(false)
        setMutedAutoplay(false)
        initStream(video, streamUrlRef.current, null)
      }
    }
    window.addEventListener('keydown', tryUnlock, { capture: true })
    window.addEventListener('click', tryUnlock, { capture: true })
    return () => {
      window.removeEventListener('keydown', tryUnlock, { capture: true })
      window.removeEventListener('click', tryUnlock, { capture: true })
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !blockId || !streamUrlRef.current) return

    setError(null)
    setLoading(true)
    setPlayBlocked(false)
    setMutedAutoplay(false)

    let retryTimer = null
    let retryCount = 0
    let firstErrorCode = -1
    let hlsFallbackAttempted = false

    // On MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) with a direct file URL, the device can't
    // decode the format — most commonly AC3/DTS/EAC3 audio on iOS/Android. Switch
    // immediately to HLS via Jellyfin's transcoding pipeline which outputs AAC.
    const tryHLSFallback = (onHlsErr) => {
      const params = new URLSearchParams(streamUrlRef.current.split('?')[1] || '')
      const itemId = params.get('itemId')
      if (!itemId) return false
      const startTicks = Math.round(seekPositionRef.current * 10_000_000)
      const hlsUrl = `/api/stream-proxy?itemId=${itemId}&startTicks=${startTicks}`
      streamUrlRef.current = hlsUrl
      hlsFallbackAttempted = true
      initStream(video, hlsUrl, onHlsErr)
      return true
    }

    const onHlsError = (_, data) => {
      if (!data.fatal) return
      if (firstErrorCode === -1) firstErrorCode = 4
      doRetry()
    }

    const doRetry = () => {
      retryCount++
      if (retryCount <= 3) {
        retryTimer = setTimeout(() => initStream(video, streamUrlRef.current, onHlsError), retryCount * 2000)
      } else {
        setLoading(false)
        setError(firstErrorCode !== -1 ? firstErrorCode : 4)
      }
    }

    const onLoadedMetadata = async () => {
      // Seek to the live position. For direct files this triggers an HTTP range request.
      // For HLS, startTicks in the URL already starts Jellyfin at the right position;
      // this seek is a belt-and-suspenders for iOS native HLS which handles it natively.
      if (seekPosition > 0) {
        video.currentTime = seekPosition
      }
      try {
        await video.play()
      } catch (err) {
        if (err.name !== 'NotAllowedError') return
        // Audio autoplay blocked — try muted as a fallback so video starts immediately.
        video.muted = true
        try {
          await video.play()
          setMutedAutoplay(true) // playing muted; show "tap for sound"
        } catch {
          video.muted = false
          setPlayBlocked(true)
          setLoading(false)
        }
      }
    }
    const onCanPlay = () => { setLoading(false); setError(null) }
    const onError = () => {
      const errCode = video.error?.code ?? -1
      if (firstErrorCode === -1) firstErrorCode = errCode
      // Format not supported → immediately try HLS (avoids multiple retries of an unplayable file)
      if (errCode === 4 && !hlsFallbackAttempted && streamUrlRef.current.includes('stream-file')) {
        if (tryHLSFallback(onHlsError)) return
      }
      doRetry()
    }
    const onEndedHandler = () => { onEnded?.() }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('error', onError)
    video.addEventListener('ended', onEndedHandler)
    initStream(video, streamUrlRef.current, onHlsError)

    return () => {
      clearTimeout(retryTimer)
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('error', onError)
      video.removeEventListener('ended', onEndedHandler)
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
      video.pause()
    }
  }, [blockId])

  if (type === 'empty' || type === 'off' || !streamUrl) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black">
        {emptyImageUrl ? (
          <img src={emptyImageUrl} alt="" className="w-full h-full object-cover opacity-60" />
        ) : hideStatic ? null : (
          <StaticNoise />
        )}
      </div>
    )
  }

  return (
    <div className="relative w-full h-full bg-black">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        autoPlay
        playsInline
        x-webkit-airplay="allow"
        onWaiting={() => setLoading(true)}
        onPlaying={() => { setLoading(false); setPlayBlocked(false) }}
        onVolumeChange={e => { if (!e.target.muted) setMutedAutoplay(false) }}
      />

      {loading && error === null && !playBlocked && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
          <div className="w-10 h-10 border-2 border-white/20 border-t-app-purple rounded-full animate-spin" />
        </div>
      )}

      {mutedAutoplay && error === null && (
        <div className="absolute inset-0 flex items-end justify-center pb-10 pointer-events-none">
          <div
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-display text-white/60"
            style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <span className="material-symbols-outlined text-base text-app-purple">volume_off</span>
            Tap for sound
          </div>
        </div>
      )}

      {airplayAvailable && (
        <button
          onClick={() => videoRef.current?.webkitShowPlaybackTargetPicker()}
          className="absolute top-4 right-4 flex items-center gap-1.5 px-3 py-2 rounded-full transition-all"
          style={{
            background: airplayActive ? 'rgba(var(--accent-rgb),0.85)' : 'rgba(0,0,0,0.55)',
            border: airplayActive ? '1px solid rgba(var(--accent-rgb),0.9)' : '1px solid rgba(255,255,255,0.15)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <AirPlayIcon active={airplayActive} />
          <span
            className="font-mono text-white leading-none"
            style={{ fontSize: 11 }}
          >
            {airplayActive ? 'AirPlaying' : 'AirPlay'}
          </span>
        </button>
      )}

      {playBlocked && error === null && (
        <div className="absolute inset-0 flex items-end justify-center pb-10 pointer-events-none">
          <div
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-display text-white/60"
            style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <span className="material-symbols-outlined text-base text-app-purple">play_circle</span>
            Tap to start
          </div>
        </div>
      )}

      {error !== null && (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <div className="text-center text-white/40 px-6">
            <span className="material-symbols-outlined text-6xl block mb-3">signal_disconnected</span>
            <p className="text-xl font-display">Signal lost</p>
            <p className="text-sm mt-2 text-white/30">
              {error === 1 && 'Playback aborted'}
              {error === 2 && 'Network error — check connection'}
              {error === 3 && 'Video decode error — format may be unsupported'}
              {error === 4 && 'Format not supported by this device'}
              {error !== 1 && error !== 2 && error !== 3 && error !== 4 && 'Unknown error'}
            </p>
            <p className="text-xs font-mono mt-1 text-white/15">err {error}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function AirPlayIcon({ active }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"
        stroke={active ? 'white' : 'rgba(255,255,255,0.8)'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon
        points="12 15 17 21 7 21"
        fill={active ? 'white' : 'rgba(255,255,255,0.8)'}
      />
    </svg>
  )
}

function StaticNoise() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf

    let last = 0
    const draw = (ts) => {
      raf = requestAnimationFrame(draw)
      if (ts - last < 100) return // ~10fps
      last = ts
      const w = canvas.width
      const h = canvas.height
      const img = ctx.createImageData(w, h)
      const data = img.data
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 60 | 0
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
    }

    canvas.width = 160
    canvas.height = 90
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="flex flex-col items-center gap-6 opacity-30">
      <canvas ref={canvasRef} className="w-64 h-36" style={{ imageRendering: 'pixelated' }} />
      <p className="text-white text-2xl font-display tracking-widest">NO SIGNAL</p>
    </div>
  )
}
