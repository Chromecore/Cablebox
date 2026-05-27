import { useState, useEffect } from 'react'

export default function ChannelManager() {
  const [channels, setChannels] = useState([])
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ name: '', logoUrl: '' })
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null) // channel id to confirm

  const fetchChannels = () =>
    fetch('/api/channels').then(r => r.json()).then(setChannels)

  useEffect(() => { fetchChannels() }, [])

  const startEdit = (ch) => {
    setEditing(ch.id)
    setConfirmDelete(null)
    setForm({ name: ch.name || '', logoUrl: ch.logoUrl || '' })
  }

  const cancelEdit = () => {
    setEditing(null)
    setForm({ name: '', logoUrl: '' })
  }

  const handleLogoFile = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setUploading(true)
    const data = new FormData()
    data.append('logo', file)
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: data })
      const json = await res.json()
      if (json.url) setForm(f => ({ ...f, logoUrl: json.url }))
    } catch {}
    setUploading(false)
  }

  const saveChannel = async (ch) => {
    setSaving(true)
    const res = await fetch(`/api/channels/${ch.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.name, logoUrl: form.logoUrl }),
    })
    const updated = await res.json()
    setChannels(prev => prev.map(c => c.id === updated.id ? updated : c))
    setEditing(null)
    setSaving(false)
  }

  const addChannel = async () => {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    const ch = await res.json()
    setChannels(prev => [...prev, ch])
    startEdit(ch)
  }

  const deleteChannel = async (id) => {
    await fetch(`/api/channels/${id}`, { method: 'DELETE' })
    const remaining = channels
      .filter(c => c.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.number - b.number)
    // Renumber sequentially so no channel numbers are skipped
    const renumbered = remaining.map((c, i) => ({ ...c, number: i + 1, sortOrder: i + 1 }))
    setChannels(renumbered)
    if (renumbered.length > 0) {
      await fetch('/api/channels/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(renumbered.map(c => ({ id: c.id, sortOrder: c.sortOrder, number: c.number }))),
      })
    }
    setConfirmDelete(null)
    if (editing === id) setEditing(null)
  }

  const moveChannel = async (idx, direction) => {
    const newList = [...channels]
    const swapIdx = idx + direction
    if (swapIdx < 0 || swapIdx >= newList.length) return

    const a = newList[idx]
    const b = newList[swapIdx]
    // Swap both sort_order and number so content (name, logo, schedule) follows the number
    newList[idx] = { ...a, sortOrder: b.sortOrder, number: b.number }
    newList[swapIdx] = { ...b, sortOrder: a.sortOrder, number: a.number }
    newList.sort((x, y) => x.sortOrder - y.sortOrder || x.number - y.number)
    setChannels(newList)

    await fetch('/api/channels/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { id: a.id, sortOrder: b.sortOrder, number: b.number },
        { id: b.id, sortOrder: a.sortOrder, number: a.number },
      ]),
    })
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display font-bold text-white text-xl">Channel Manager</h2>
          <button
            onClick={addChannel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-semibold text-white transition-all"
            style={{ background: 'rgba(var(--accent-rgb),0.35)', border: '1px solid rgba(var(--accent-rgb),0.5)' }}
          >
            <span className="material-symbols-outlined text-base">add</span>
            Add Channel
          </button>
        </div>
        <p className="text-white/40 text-sm mb-6">Set channel names and logos. Use ↕ to reorder.</p>

        <div className="flex flex-col gap-2">
          {channels.map((ch, idx) => (
            <div
              key={ch.id}
              className="flex items-start gap-3 px-4 py-3 rounded"
              style={{
                background: editing === ch.id ? 'rgba(var(--accent-rgb),0.1)' : 'rgba(30,42,58,0.6)',
                border: editing === ch.id ? '1px solid rgba(var(--accent-rgb),0.3)' : '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {/* Reorder arrows */}
              <div className="flex flex-col gap-0.5 flex-shrink-0 mt-1">
                <button
                  onClick={() => moveChannel(idx, -1)}
                  disabled={idx === 0}
                  className="flex items-center justify-center w-5 h-5 rounded transition-colors disabled:opacity-20"
                  style={{ color: 'rgba(255,255,255,0.4)' }}
                  onMouseOver={e => e.currentTarget.style.color = 'white'}
                  onMouseOut={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>keyboard_arrow_up</span>
                </button>
                <button
                  onClick={() => moveChannel(idx, 1)}
                  disabled={idx === channels.length - 1}
                  className="flex items-center justify-center w-5 h-5 rounded transition-colors disabled:opacity-20"
                  style={{ color: 'rgba(255,255,255,0.4)' }}
                  onMouseOver={e => e.currentTarget.style.color = 'white'}
                  onMouseOut={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>keyboard_arrow_down</span>
                </button>
              </div>

              {/* Channel number badge */}
              <div
                className="w-9 h-9 flex items-center justify-center rounded font-display font-bold text-sm flex-shrink-0 mt-0.5"
                style={{ background: 'rgba(var(--accent-rgb),0.2)', color: 'rgba(var(--accent-rgb),0.9)' }}
              >
                {ch.number}
              </div>

              {/* Logo preview */}
              {(editing === ch.id ? form.logoUrl : ch.logoUrl) ? (
                <img
                  src={editing === ch.id ? form.logoUrl : ch.logoUrl}
                  alt=""
                  className="w-9 h-9 object-contain rounded flex-shrink-0 mt-0.5"
                />
              ) : (
                <div
                  className="w-9 h-9 flex items-center justify-center rounded flex-shrink-0 mt-0.5"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}
                >
                  <span className="material-symbols-outlined text-white/20 text-sm">image</span>
                </div>
              )}

              {editing === ch.id ? (
                <div className="flex-1 flex flex-col gap-2 min-w-0">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Channel name"
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded px-3 py-1.5 text-sm text-white placeholder-white/30 outline-none focus:border-app-purple"
                      autoFocus
                    />
                    <label
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm cursor-pointer whitespace-nowrap transition-colors flex-shrink-0"
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: uploading ? 'rgba(255,255,255,0.3)' : form.logoUrl ? 'var(--accent)' : 'rgba(255,255,255,0.5)',
                      }}
                    >
                      <span className="material-symbols-outlined text-sm">
                        {uploading ? 'hourglass_empty' : form.logoUrl ? 'check_circle' : 'upload'}
                      </span>
                      {uploading ? 'Uploading…' : form.logoUrl ? 'Change' : 'Logo'}
                      <input type="file" accept="image/*" className="hidden" onChange={handleLogoFile} disabled={uploading} />
                    </label>
                  </div>
                  <div className="flex items-center gap-2 justify-end">
                    <button onClick={cancelEdit} className="px-3 py-1.5 rounded text-sm text-white/40 hover:text-white transition-colors">
                      Cancel
                    </button>
                    <button
                      onClick={() => saveChannel(ch)}
                      disabled={saving || uploading}
                      className="px-3 py-1.5 rounded text-sm font-semibold text-white"
                      style={{ background: 'rgba(var(--accent-rgb),0.4)', border: '1px solid rgba(var(--accent-rgb),0.6)' }}
                    >
                      {saving ? '…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : confirmDelete === ch.id ? (
                <div className="flex-1 flex items-center justify-between min-w-0 mt-0.5">
                  <span className="text-white/70 text-sm">Delete {ch.name || `Channel ${ch.number}`}?</span>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="px-3 py-1 rounded text-xs text-white/40 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => deleteChannel(ch.id)}
                      className="px-3 py-1 rounded text-xs font-semibold text-red-400"
                      style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-between min-w-0 mt-0.5">
                  <div className="min-w-0">
                    <div className="text-white font-semibold text-sm">
                      {ch.name || <span className="text-white/30 italic">Unnamed channel</span>}
                    </div>
                    {ch.logoUrl && (
                      <div className="text-white/30 text-xs truncate">{ch.logoUrl}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                    <button
                      onClick={() => startEdit(ch)}
                      className="text-white/30 hover:text-white transition-colors p-1"
                    >
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
                    <button
                      onClick={() => setConfirmDelete(ch.id)}
                      className="text-white/20 hover:text-red-400 transition-colors p-1"
                    >
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
