import { useState, useEffect, useRef } from 'react'

export default function PINEntry({ onSuccess, onCancel }) {
  const [digits, setDigits] = useState('')
  const [error, setError] = useState('')
  const [shaking, setShaking] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (digits.length === 4) {
      verifyPIN(digits)
    }
  }, [digits])

  const verifyPIN = async (pin) => {
    try {
      const res = await fetch('/api/auth/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      if (res.ok) {
        onSuccess()
      } else {
        setShaking(true)
        setError('Incorrect PIN')
        setDigits('')
        setTimeout(() => setShaking(false), 600)
      }
    } catch {
      setError('Connection error')
      setDigits('')
    }
  }

  const handleKey = (e) => {
    if (e.key >= '0' && e.key <= '9') {
      setError('')
      setDigits(d => d.length < 4 ? d + e.key : d)
    } else if (e.key === 'Backspace') {
      setError('')
      setDigits(d => d.slice(0, -1))
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  const handleDigitClick = (d) => {
    setError('')
    setDigits(prev => prev.length < 4 ? prev + d : prev)
  }

  return (
    <div
      className={`flex flex-col items-center gap-8 ${shaking ? 'animate-shake' : ''}`}
      onKeyDown={handleKey}
      tabIndex={0}
      ref={inputRef}
      style={{ outline: 'none' }}
    >
      <div className="text-center">
        <span className="material-symbols-outlined text-app-purple text-5xl block mb-2">lock</span>
        <h2 className="font-display font-bold text-2xl text-white">Admin Access</h2>
        <p className="text-white/40 text-sm mt-1">Enter PIN to continue</p>
      </div>

      {/* PIN dots */}
      <div className="flex gap-4">
        {[0,1,2,3].map(i => (
          <div
            key={i}
            className="w-5 h-5 rounded-full transition-all duration-150"
            style={{
              background: i < digits.length
                ? 'var(--accent)'
                : 'rgba(255,255,255,0.15)',
              boxShadow: i < digits.length ? '0 0 10px rgba(var(--accent-rgb),0.6)' : 'none',
            }}
          />
        ))}
      </div>

      {error && (
        <p className="text-red-400 text-sm font-mono">{error}</p>
      )}

      {/* Number pad */}
      <div className="grid grid-cols-3 gap-3">
        {[1,2,3,4,5,6,7,8,9].map(n => (
          <PINButton key={n} label={String(n)} onClick={() => handleDigitClick(String(n))} />
        ))}
        <div />
        <PINButton label="0" onClick={() => handleDigitClick('0')} />
        <button
          className="flex items-center justify-center w-16 h-16 rounded text-white/50 hover:text-white transition-colors"
          onClick={() => setDigits(d => d.slice(0, -1))}
        >
          <span className="material-symbols-outlined text-2xl">backspace</span>
        </button>
      </div>

      <button
        className="text-white/30 text-sm hover:text-white/60 transition-colors"
        onClick={onCancel}
      >
        Cancel (Esc)
      </button>
    </div>
  )
}

function PINButton({ label, onClick }) {
  return (
    <button
      type="button"
      className="w-16 h-16 rounded text-white text-2xl font-display font-bold transition-all active:scale-95"
      style={{
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.12)',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(var(--accent-rgb),0.3)'}
      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
