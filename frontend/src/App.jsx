import { useState, useEffect, useCallback } from 'react'
import ViewerApp from './ViewerApp.jsx'
import AdminApp from './AdminApp.jsx'
import PINEntry from './components/PINEntry.jsx'
import Settings from './components/Settings.jsx'

// Accent color swatches available in Settings. Each entry: [hex, r, g, b]
export const ACCENT_SWATCHES = [
  { hex: '#7a00ff', rgb: '122, 0, 255',   label: 'Purple'  },
  { hex: '#8b5cf6', rgb: '139, 92, 246',  label: 'Violet'  },
  { hex: '#3b82f6', rgb: '59, 130, 246',  label: 'Blue'    },
  { hex: '#0ea5e9', rgb: '14, 165, 233',  label: 'Sky'     },
  { hex: '#06b6d4', rgb: '6, 182, 212',   label: 'Cyan'    },
  { hex: '#10b981', rgb: '16, 185, 129',  label: 'Emerald' },
  { hex: '#f59e0b', rgb: '245, 158, 11',  label: 'Amber'   },
  { hex: '#f43f5e', rgb: '244, 63, 94',   label: 'Rose'    },
]

export function applyAccent(hex, rgb) {
  document.documentElement.style.setProperty('--accent', hex)
  document.documentElement.style.setProperty('--accent-rgb', rgb)
  // localStorage is a fast-init cache only; server is the source of truth
  try { localStorage.setItem('cablebox-accent', JSON.stringify({ hex, rgb })) } catch {}
}

export default function App() {
  const [mode, setMode] = useState('viewer') // 'viewer' | 'admin'
  const [showPIN, setShowPIN] = useState(false)
  const [jellyfinConfigured, setJellyfinConfigured] = useState(null)

  // Apply cached accent immediately to avoid flash, then server value overrides
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('cablebox-accent'))
      if (saved?.hex && saved?.rgb) applyAccent(saved.hex, saved.rgb)
    } catch {}
  }, [])

  // Check if Jellyfin is configured on load — retry on network errors.
  // Also pick up the global accent color from the server.
  useEffect(() => {
    let cancelled = false
    const attempt = () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      fetch('/api/config', { cache: 'no-store', signal: controller.signal })
        .then(r => r.json())
        .then(d => {
          if (cancelled) return
          setJellyfinConfigured(d.jellyfinConfigured)
          if (d.accentHex && d.accentRgb) applyAccent(d.accentHex, d.accentRgb)
        })
        .catch(() => { if (!cancelled) setTimeout(attempt, 2000) })
        .finally(() => clearTimeout(timer))
    }
    attempt()
    return () => { cancelled = true }
  }, [])

  // Global keyboard handler: * key triggers PIN entry from viewer
  useEffect(() => {
    if (mode !== 'viewer') return
    const handler = (e) => {
      if (e.key === '*' || (e.key === 'Enter' && e.shiftKey)) {
        e.preventDefault()
        setShowPIN(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode])

  const handlePINSuccess = useCallback(() => {
    setShowPIN(false)
    setMode('admin')
  }, [])

  const handleExitAdmin = useCallback(() => {
    setMode('viewer')
  }, [])

  const handleConfigSaved = useCallback(() => {
    setJellyfinConfigured(true)
  }, [])

  // Still loading config
  if (jellyfinConfigured === null) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black">
        <span className="text-white/40 text-lg font-mono">loading...</span>
      </div>
    )
  }

  // Jellyfin not configured → force settings screen
  if (!jellyfinConfigured) {
    return <Settings onSaved={handleConfigSaved} firstRun />
  }

  return (
    <div className="w-full h-full relative overflow-hidden">
      {mode === 'viewer' ? (
        <ViewerApp onOpenPIN={() => setShowPIN(true)} />
      ) : (
        <AdminApp onExit={handleExitAdmin} />
      )}

      {showPIN && (
        <div className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
          <PINEntry
            onSuccess={handlePINSuccess}
            onCancel={() => setShowPIN(false)}
          />
        </div>
      )}
    </div>
  )
}
