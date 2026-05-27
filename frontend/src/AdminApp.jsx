import { useState } from 'react'
import Scheduler from './components/Scheduler.jsx'
import LibraryBrowser from './components/LibraryBrowser.jsx'
import ChannelManager from './components/ChannelManager.jsx'
import Settings from './components/Settings.jsx'

const TABS = [
  { id: 'scheduler', label: 'Scheduler', icon: 'calendar_month' },
  { id: 'channels', label: 'Channels', icon: 'tune' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]

export default function AdminApp({ onExit }) {
  const [tab, setTab] = useState('scheduler')
  const [draggedItem, setDraggedItem] = useState(null)

  return (
    <div className="w-full h-full flex flex-col dot-grid" style={{ background: '#0f1724' }}>
      {/* Top nav */}
      <div
        className="safe-area-top flex items-center gap-2 px-4 py-3 border-b border-white/10 flex-shrink-0"
        style={{ background: '#0c1520' }}
      >
        <span className="material-symbols-outlined text-app-purple text-2xl">settings_remote</span>
        <span className="font-display font-bold text-white text-lg tracking-wide mr-4">CableBox Admin</span>

        <div className="flex gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold transition-all"
              style={{
                background: tab === t.id ? 'rgba(var(--accent-rgb),0.25)' : 'transparent',
                color: tab === t.id ? 'var(--accent)' : 'rgba(255,255,255,0.5)',
                border: tab === t.id ? '1px solid rgba(var(--accent-rgb),0.4)' : '1px solid transparent',
              }}
            >
              <span className="material-symbols-outlined text-base">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        <button
          onClick={onExit}
          className="ml-auto flex items-center gap-2 px-4 py-2 rounded text-sm text-white/50 hover:text-white transition-colors"
          style={{ border: '1px solid rgba(255,255,255,0.1)' }}
        >
          <span className="material-symbols-outlined text-base">tv</span>
          Back to TV
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'scheduler' && (
          <div className="h-full flex">
            {/* Library panel */}
            <div
              className="w-72 flex-shrink-0 flex flex-col border-r border-white/10"
              style={{ background: '#0c1520' }}
            >
              <div className="px-4 py-3 border-b border-white/10">
                <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-base text-app-purple">video_library</span>
                  Library
                </h3>
                <p className="text-white/30 text-xs mt-0.5">Drag to schedule →</p>
              </div>
              <div className="flex-1 overflow-y-auto">
                <LibraryBrowser onDragStart={setDraggedItem} />
              </div>
            </div>

            {/* Scheduler grid */}
            <div className="flex-1 overflow-hidden">
              <Scheduler draggedItem={draggedItem} onDragEnd={() => setDraggedItem(null)} />
            </div>
          </div>
        )}

        {tab === 'channels' && <ChannelManager />}
        {tab === 'settings' && <Settings />}
      </div>
    </div>
  )
}
