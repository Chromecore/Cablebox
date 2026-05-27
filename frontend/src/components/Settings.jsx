import { useState, useEffect } from 'react'
import { ACCENT_SWATCHES, applyAccent } from '../App.jsx'

const BINDABLE_ACTIONS = [
  { id: 'channelUp',   label: 'Channel Up',        icon: 'expand_less',  defaults: '↑ / PageUp' },
  { id: 'channelDown', label: 'Channel Down',       icon: 'expand_more',  defaults: '↓ / PageDown' },
  { id: 'guide',       label: 'Open Guide',         icon: 'grid_view',    defaults: 'G / F1' },
  { id: 'streaming',   label: 'Jellyfin Streaming', icon: 'stream',       defaults: 'S' },
]

export default function Settings({ onSaved, firstRun = false }) {
  const [form, setForm] = useState({
    jellyfinUrl: '',
    jellyfinPublicUrl: '',
    jellyfinApiKey: '',
    jellyfinUserId: '',
    adminPin: '',
    adminPinConfirm: '',
  })
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [accentHex, setAccentHex] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cablebox-accent'))?.hex || '#7a00ff' } catch { return '#7a00ff' }
  })
  const [bindings, setBindings] = useState({})
  const [capturing, setCapturing] = useState(null)

  useEffect(() => {
    if (firstRun) return
    fetch('/api/config')
      .then(r => r.json())
      .then(d => {
        setForm(f => ({
          ...f,
          jellyfinUrl: d.jellyfinUrl || '',
          jellyfinPublicUrl: d.jellyfinPublicUrl || '',
          jellyfinUserId: d.jellyfinUserId || '',
        }))
      })
    fetch('/api/keybindings')
      .then(r => r.json())
      .then(setBindings)
      .catch(() => {})
  }, [firstRun])

  const saveBindings = (newBindings) => {
    setBindings(newBindings)
    fetch('/api/keybindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newBindings),
    }).catch(() => {})
    window.dispatchEvent(new Event('cablebox-keybindings-changed'))
  }

  // Key capture
  useEffect(() => {
    if (!capturing) return
    const handler = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setCapturing(null); return }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
      saveBindings({ ...bindings, [capturing]: { key: e.key } })
      setCapturing(null)
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [capturing, bindings])

  const clearBinding = (actionId) => {
    const newBindings = { ...bindings }
    delete newBindings[actionId]
    saveBindings(newBindings)
  }

  const testConnection = async () => {
    setTesting(true)
    setStatus('')
    // Save URL and key first so the backend can test them
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jellyfinUrl: form.jellyfinUrl,
        jellyfinApiKey: form.jellyfinApiKey || undefined,
      }),
    })
    const res = await fetch('/api/library/test')
    if (res.ok) {
      const data = await res.json()
      setForm(f => ({ ...f, jellyfinUserId: data.userId }))
      setStatus('✓ Connected! User ID: ' + data.userId)
    } else {
      const text = await res.text()
      setStatus('✗ ' + text)
    }
    setTesting(false)
  }

  const clearSchedule = async () => {
    setClearing(true)
    await fetch('/api/schedule/all', { method: 'DELETE' })
    setClearing(false)
    setClearConfirm(false)
    setStatus('✓ Schedule cleared')
  }

  const save = async () => {
    if (form.adminPin && form.adminPin !== form.adminPinConfirm) {
      setStatus('✗ PINs do not match')
      return
    }

    setSaving(true)
    setStatus('')

    const body = {
      jellyfinUrl: form.jellyfinUrl,
      jellyfinPublicUrl: form.jellyfinPublicUrl,
      jellyfinUserId: form.jellyfinUserId,
    }
    if (form.jellyfinApiKey) body.jellyfinApiKey = form.jellyfinApiKey
    if (form.adminPin) body.adminPin = form.adminPin

    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      setStatus('✓ Settings saved')
      setForm(f => ({ ...f, adminPin: '', adminPinConfirm: '', jellyfinApiKey: '' }))
      onSaved?.()
    } else {
      setStatus('✗ Save failed')
    }
    setSaving(false)
  }

  return (
    <div className="h-full overflow-y-auto p-6" style={firstRun ? { background: '#0f1724' } : {}}>
      <div className="max-w-lg mx-auto">
        {firstRun && (
          <div className="flex items-center gap-3 mb-8">
            <span className="material-symbols-outlined text-app-purple text-4xl">settings_remote</span>
            <div>
              <h1 className="font-display font-black text-white text-3xl">CableBox</h1>
              <p className="text-white/40 text-sm">Connect your Jellyfin server to get started</p>
            </div>
          </div>
        )}

        {!firstRun && (
          <div className="mb-6">
            <h2 className="font-display font-bold text-white text-xl mb-1">Settings</h2>
            <p className="text-white/40 text-sm">Jellyfin connection and admin PIN</p>
          </div>
        )}

        {/* Jellyfin section */}
        <div className="rounded-lg p-5 mb-4 flex flex-col gap-4"
          style={{ background: 'rgba(30,42,58,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 className="font-semibold text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-app-purple text-lg">dns</span>
            Jellyfin Server
          </h3>

          <div>
            <label className="text-white/60 text-xs mb-1 block">Server URL</label>
            <input
              type="text"
              placeholder="http://localhost:8096"
              value={form.jellyfinUrl}
              onChange={e => setForm(f => ({ ...f, jellyfinUrl: e.target.value }))}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-app-purple font-mono"
            />
            <p className="text-white/25 text-xs mt-1">Used by the server to fetch schedules and transcode media.</p>
          </div>

          <div>
            <label className="text-white/60 text-xs mb-1 block">Public URL <span className="text-white/30">(for viewers)</span></label>
            <input
              type="text"
              placeholder="https://jellyfin.internal"
              value={form.jellyfinPublicUrl}
              onChange={e => setForm(f => ({ ...f, jellyfinPublicUrl: e.target.value }))}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-app-purple font-mono"
            />
            <p className="text-white/25 text-xs mt-1">URL that phones and other devices use to stream video. Leave blank to use Server URL.</p>
          </div>

          <div>
            <label className="text-white/60 text-xs mb-1 block">API Key</label>
            <input
              type="password"
              placeholder={firstRun ? 'Paste from Jellyfin → Dashboard → API Keys' : '(unchanged)'}
              value={form.jellyfinApiKey}
              onChange={e => setForm(f => ({ ...f, jellyfinApiKey: e.target.value }))}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-app-purple font-mono"
            />
            <p className="text-white/25 text-xs mt-1">
              Jellyfin → Dashboard → API Keys → + (New Key)
            </p>
          </div>

          {form.jellyfinUserId && (
            <div>
              <label className="text-white/60 text-xs mb-1 block">User ID (auto-detected)</label>
              <div className="text-white/40 text-xs font-mono bg-white/5 rounded px-3 py-2 break-all">
                {form.jellyfinUserId}
              </div>
            </div>
          )}

          <button
            onClick={testConnection}
            disabled={testing || !form.jellyfinUrl}
            className="flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold text-white transition-all w-fit"
            style={{
              background: 'rgba(8,145,178,0.25)',
              border: '1px solid rgba(8,145,178,0.5)',
              opacity: testing || !form.jellyfinUrl ? 0.5 : 1,
            }}
          >
            {testing ? (
              <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : (
              <span className="material-symbols-outlined text-base">wifi_tethering</span>
            )}
            Test Connection
          </button>
        </div>

        {/* Admin PIN section */}
        {!firstRun && (
          <div className="rounded-lg p-5 mb-4 flex flex-col gap-4"
            style={{ background: 'rgba(30,42,58,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <h3 className="font-semibold text-white flex items-center gap-2">
              <span className="material-symbols-outlined text-app-purple text-lg">lock</span>
              Admin PIN
            </h3>
            <p className="text-white/40 text-xs">Default PIN is 1234. Leave blank to keep current.</p>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-white/60 text-xs mb-1 block">New PIN</label>
                <input
                  type="password"
                  placeholder="4+ digits"
                  value={form.adminPin}
                  onChange={e => setForm(f => ({ ...f, adminPin: e.target.value }))}
                  maxLength={8}
                  className="w-full bg-white/5 border border-white/10 rounded px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-app-purple font-mono tracking-widest"
                />
              </div>
              <div className="flex-1">
                <label className="text-white/60 text-xs mb-1 block">Confirm</label>
                <input
                  type="password"
                  placeholder="Repeat"
                  value={form.adminPinConfirm}
                  onChange={e => setForm(f => ({ ...f, adminPinConfirm: e.target.value }))}
                  maxLength={8}
                  className="w-full bg-white/5 border border-white/10 rounded px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-app-purple font-mono tracking-widest"
                />
              </div>
            </div>
          </div>
        )}

        {/* Accent color */}
        {!firstRun && (
          <div className="rounded-lg p-5 mb-4 flex flex-col gap-4"
            style={{ background: 'rgba(30,42,58,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <h3 className="font-semibold text-white flex items-center gap-2">
              <span className="material-symbols-outlined text-app-purple text-lg">palette</span>
              Accent Color
            </h3>
            <div className="flex flex-wrap gap-3">
              {ACCENT_SWATCHES.map(sw => {
                const isActive = accentHex === sw.hex
                return (
                  <button
                    key={sw.hex}
                    title={sw.label}
                    onClick={() => {
                      applyAccent(sw.hex, sw.rgb)
                      setAccentHex(sw.hex)
                      fetch('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ accentHex: sw.hex, accentRgb: sw.rgb }),
                      }).catch(() => {})
                    }}
                    className="flex flex-col items-center gap-1.5 group"
                  >
                    <div
                      className="w-9 h-9 rounded-full transition-all"
                      style={{
                        background: sw.hex,
                        boxShadow: isActive
                          ? `0 0 0 2px #0f1724, 0 0 0 4px ${sw.hex}`
                          : '0 0 0 2px rgba(255,255,255,0.08)',
                        transform: isActive ? 'scale(1.15)' : 'scale(1)',
                      }}
                    />
                    <span
                      className="text-xs font-mono transition-colors"
                      style={{ color: isActive ? sw.hex : 'rgba(255,255,255,0.3)', fontSize: 9 }}
                    >
                      {sw.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Key Bindings */}
        {!firstRun && (
          <div className="rounded-lg p-5 mb-4 flex flex-col gap-4"
            style={{ background: 'rgba(30,42,58,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div>
              <h3 className="font-semibold text-white flex items-center gap-2">
                <span className="material-symbols-outlined text-app-purple text-lg">keyboard</span>
                Key Bindings
              </h3>
              <p className="text-white/30 text-xs mt-1">
                Assign extra keys for remotes or other devices. Default keyboard shortcuts still work.
              </p>
            </div>

            <div className="flex flex-col gap-1">
              {BINDABLE_ACTIONS.map(action => {
                const bound = bindings[action.id]
                const isCapturing = capturing === action.id
                return (
                  <div
                    key={action.id}
                    className="flex items-center gap-3 px-3 py-2.5 rounded"
                    style={{ background: isCapturing ? 'rgba(var(--accent-rgb),0.08)' : 'rgba(255,255,255,0.03)' }}
                  >
                    <span className="material-symbols-outlined text-app-purple" style={{ fontSize: 18 }}>{action.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-sm">{action.label}</div>
                      <div className="text-white/25 font-mono" style={{ fontSize: 10 }}>defaults: {action.defaults}</div>
                    </div>

                    {/* Current custom binding */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {bound ? (
                        <>
                          <span
                            className="font-mono text-xs px-2 py-1 rounded"
                            style={{ background: 'rgba(var(--accent-rgb),0.15)', color: 'var(--accent)', border: '1px solid rgba(var(--accent-rgb),0.3)' }}
                          >
                            {bound.key}
                          </span>
                          <button
                            onClick={() => clearBinding(action.id)}
                            className="text-white/25 hover:text-red-400 transition-colors"
                            title="Remove binding"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                          </button>
                        </>
                      ) : (
                        <span className="text-white/20 font-mono text-xs w-6 text-center">—</span>
                      )}

                      <button
                        onClick={() => setCapturing(isCapturing ? null : action.id)}
                        className="px-3 py-1 rounded text-xs font-mono transition-all"
                        style={isCapturing
                          ? { background: 'rgba(var(--accent-rgb),0.35)', border: '1px solid rgba(var(--accent-rgb),0.7)', color: 'white', minWidth: 100 }
                          : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)', minWidth: 100 }
                        }
                      >
                        {isCapturing ? 'Press a key…' : bound ? 'Change' : 'Set Key'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {capturing && (
              <p className="text-white/30 text-xs text-center">
                Press any key to assign · <span className="font-mono">Esc</span> to cancel
              </p>
            )}
          </div>
        )}

        {/* Danger zone — only shown in admin mode, not first run */}
        {!firstRun && (
          <div className="rounded-lg p-5 mb-4 flex flex-col gap-3"
            style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <h3 className="font-semibold text-red-400/80 flex items-center gap-2 text-sm">
              <span className="material-symbols-outlined text-base">warning</span>
              Danger Zone
            </h3>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-white/70 text-sm font-semibold">Clear entire schedule</div>
                <div className="text-white/35 text-xs">Permanently deletes all scheduled blocks. Cannot be undone.</div>
              </div>
              {clearConfirm ? (
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => setClearConfirm(false)}
                    className="px-3 py-1.5 rounded text-xs text-white/40 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={clearSchedule}
                    disabled={clearing}
                    className="px-3 py-1.5 rounded text-xs font-semibold text-white"
                    style={{ background: 'rgba(239,68,68,0.4)', border: '1px solid rgba(239,68,68,0.6)' }}
                  >
                    {clearing ? 'Clearing…' : 'Yes, clear all'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setClearConfirm(true)}
                  className="flex-shrink-0 px-3 py-1.5 rounded text-xs font-semibold text-red-400 hover:text-white transition-colors"
                  style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)' }}
                >
                  Clear Schedule
                </button>
              )}
            </div>
          </div>
        )}

        {/* Status message */}
        {status && (
          <div className={`px-4 py-3 rounded text-sm font-mono mb-4 ${
            status.startsWith('✓') ? 'text-app-green bg-green-900/20 border border-green-800/30' : 'text-red-400 bg-red-900/20 border border-red-800/30'
          }`}>
            {status}
          </div>
        )}

        <button
          onClick={save}
          disabled={saving || !form.jellyfinUrl}
          className="w-full py-3 rounded font-display font-bold text-white text-base transition-all"
          style={{
            background: 'rgba(var(--accent-rgb),0.5)',
            border: '2px solid rgba(var(--accent-rgb),0.7)',
            boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)',
            opacity: saving || !form.jellyfinUrl ? 0.5 : 1,
          }}
        >
          {saving ? 'Saving...' : firstRun ? 'Save & Launch CableBox' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
