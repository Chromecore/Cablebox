import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

const ZOOM_LEVELS = [0.75, 1.5, 3, 6] // px/min options
const ROW_HEIGHT = 56
const CHANNEL_COL = 110
const HEADER_H = 32    // sticky time header height in px
const SNAP_DROP = 10   // drop snaps to 10-min boundaries
const SNAP_DRAG = 10   // resize/move snaps to 10-min intervals

export default function Scheduler({ draggedItem, onDragEnd }) {
  const [channels, setChannels] = useState([])
  const [schedule, setSchedule] = useState([])
  const [selectedDay, setSelectedDay] = useState(startOfToday())
  const [dropPreview, setDropPreview] = useState(null)
  const [editBlock, setEditBlock] = useState(null)
  const [warningTooltip, setWarningTooltip] = useState(null)
  const [blockHoverTooltip, setBlockHoverTooltip] = useState(null) // { block, top, left }
  const [dropTypeModal, setDropTypeModal] = useState(null) // { item, channelId, time }
  const [bulkProgress, setBulkProgress] = useState(null)  // { current, total, showName } | null
  const [zoomIdx, setZoomIdx] = useState(2) // index into ZOOM_LEVELS; default 3px/min
  const pxPerMinRef = useRef(ZOOM_LEVELS[2])
  const zoomScrollTargetRef = useRef(null)

  // Undo/redo stacks — each entry is { undo: async fn, redo: async fn }
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])

  const scrollRef = useRef(null)
  const channelLabelsRef = useRef(null)
  const scrollAnimRef = useRef(null)
  const scrollVelRef = useRef(0)

  // Keep live refs so global mouse handlers always have current data
  const channelsRef = useRef([])
  useEffect(() => { channelsRef.current = channels }, [channels])
  const scheduleRef = useRef([])
  useEffect(() => { scheduleRef.current = schedule }, [schedule])
  const fetchScheduleRef = useRef(null)

  const [selectedBlockIds, setSelectedBlockIds] = useState(new Set())
  const [selectionBox, setSelectionBox] = useState(null)
  const selectedBlockIdsRef = useRef(new Set())
  useEffect(() => { selectedBlockIdsRef.current = selectedBlockIds }, [selectedBlockIds])

  // dragRef tracks in-progress interaction
  // modes: 'resize' | 'move' | 'select' | 'multiMove'
  const dragRef = useRef(null)
  const justDragged = useRef(false)

  // Generation counter: only the most-recent fetchSchedule call may apply its result.
  // A new call bumps the counter; older in-flight responses check and discard if stale.
  const fetchGenRef = useRef(0)

  // Sync pxPerMinRef for use in stale mouse-handler closures
  useEffect(() => { pxPerMinRef.current = ZOOM_LEVELS[zoomIdx] }, [zoomIdx])

  // Restore scroll position after zoom (anchor the center time point)
  useEffect(() => {
    if (zoomScrollTargetRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = zoomScrollTargetRef.current
      zoomScrollTargetRef.current = null
    }
  }, [zoomIdx])

  const fetchSchedule = useCallback(() => {
    const gen = ++fetchGenRef.current
    const from = new Date(selectedDay).toISOString()
    const to = new Date(selectedDay.getTime() + 24 * 3600_000).toISOString()
    Promise.all([
      fetch('/api/channels').then(r => r.json()),
      fetch(`/api/schedule?from=${from}&to=${to}`).then(r => r.json()),
    ]).then(([chs, blocks]) => {
      if (gen !== fetchGenRef.current) return
      const d = dragRef.current
      if (d && d.mode !== 'saving') return  // stale fetch during a live drag
      const wasSaving = !!(d && d.mode === 'saving')
      dragRef.current = null
      justDragged.current = false
      setChannels(chs)
      setSchedule(blocks)
      // After a save cycle, hold a brief cooldown so delayed synthetic pointer events
      // (touchpad tap-to-click fires ~300ms after mouseup) can't start a spurious new drag
      if (wasSaving) {
        dragRef.current = { mode: 'cooldown' }
        setTimeout(() => { dragRef.current = null }, 400)
      }
    })
  }, [selectedDay])

  useEffect(() => { fetchScheduleRef.current = fetchSchedule }, [fetchSchedule])
  useEffect(() => { fetchSchedule() }, [fetchSchedule])

  const pushUndo = useCallback((entry) => {
    undoStackRef.current = [...undoStackRef.current.slice(-50), entry]
    redoStackRef.current = []
  }, [])

  const doUndo = useCallback(async () => {
    const entry = undoStackRef.current.pop()
    if (!entry) return
    redoStackRef.current.push(entry)
    await entry.undo()
  }, [])

  const doRedo = useCallback(async () => {
    const entry = redoStackRef.current.pop()
    if (!entry) return
    undoStackRef.current.push(entry)
    await entry.redo()
  }, [])

  // Global mouse handlers (select | resize | move | multiMove)
  useEffect(() => {
    const saveBlock = async (block) => {
      let startTime = block.computedStart || block.startTime
      if (block.isRecurring) {
        const dt = new Date(startTime)
        startTime = `${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}:${String(dt.getUTCSeconds()).padStart(2,'0')}`
      }
      await fetch(`/api/schedule/${block.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...block, startTime, seasonNumber: block.seasonFilter ?? block.seasonNumber }),
      })
    }

    const onMove = (e) => {
      const d = dragRef.current
      if (!d || d.mode === 'saving' || d.mode === 'cooldown') return
      setWarningTooltip(null)

      if (d.mode === 'select') {
        const rect = scrollRef.current?.getBoundingClientRect()
        if (!rect) return
        const endGX = e.clientX - rect.left + scrollRef.current.scrollLeft
        const endGY = e.clientY - rect.top + scrollRef.current.scrollTop - HEADER_H
        if (Math.abs(endGX - d.startGX) > 4 || Math.abs(endGY - d.startGY) > 4) justDragged.current = true
        d.endGX = endGX
        d.endGY = endGY
        setSelectionBox({ startGX: d.startGX, startGY: d.startGY, endGX, endGY })
        return
      }

      const scrollDelta = (scrollRef.current?.scrollLeft ?? 0) - (d.startScrollLeft ?? 0)
      const dx = e.clientX - d.startX + scrollDelta
      const snappedMin = Math.round(dx / pxPerMinRef.current / SNAP_DRAG) * SNAP_DRAG
      if (snappedMin !== 0) justDragged.current = true

      if (d.mode === 'resize') {
        const dayStartMs = selectedDay.getTime()
        const dayEndMs   = dayStartMs + 24 * 60 * 60_000

        // Update ref directly so onUp always reads final positions regardless of React re-render timing
        scheduleRef.current = scheduleRef.current.map(b => {
          if (b.id !== d.blockId) return b
          if (d.edge === 'right') {
            const rawDur = Math.max(SNAP_DRAG * 60, d.origDurSecs + snappedMin * 60)
            // Clamp so the block doesn't extend past the end of the day
            const maxDur = Math.floor((dayEndMs - d.origStartMs) / 1000)
            return { ...b, durationSeconds: Math.min(rawDur, maxDur) }
          } else {
            const newDurSecs = Math.max(SNAP_DRAG * 60, d.origDurSecs - snappedMin * 60)
            const newStartMs = Math.max(dayStartMs, d.origStartMs + snappedMin * 60_000)
            // Clamp so the block doesn't go before the start of the day
            const clampedDur = d.origStartMs + d.origDurSecs * 1000 - newStartMs
            const newStartIso = new Date(newStartMs).toISOString()
            return { ...b, startTime: newStartIso, computedStart: newStartIso, durationSeconds: Math.max(SNAP_DRAG * 60, Math.floor(clampedDur / 1000)) }
          }
        })
        setSchedule(scheduleRef.current)
      } else if (d.mode === 'move') {
        const dayStartMs = selectedDay.getTime()
        const dayEndMs   = dayStartMs + 24 * 60 * 60_000
        const clampedStartMs = Math.max(dayStartMs, Math.min(dayEndMs - d.origDurSecs * 1000, d.origStartMs + snappedMin * 60_000))
        const newStartIso = new Date(clampedStartMs).toISOString()
        let targetChannelId = d.origChannelId
        if (scrollRef.current && channelsRef.current.length > 0) {
          const rect = scrollRef.current.getBoundingClientRect()
          const mouseYInGrid = e.clientY - rect.top
          const idx = Math.floor((mouseYInGrid - HEADER_H + scrollRef.current.scrollTop) / ROW_HEIGHT)
          const clamped = Math.max(0, Math.min(channelsRef.current.length - 1, idx))
          targetChannelId = channelsRef.current[clamped]?.id ?? d.origChannelId
        }
        scheduleRef.current = scheduleRef.current.map(b => {
          if (b.id !== d.blockId) return b
          return { ...b, computedStart: newStartIso, channelId: targetChannelId }
        })
        setSchedule(scheduleRef.current)
      } else if (d.mode === 'multiMove') {
        let channelDelta = 0
        if (scrollRef.current && channelsRef.current.length > 0) {
          const rect = scrollRef.current.getBoundingClientRect()
          const mouseYInGrid = e.clientY - rect.top
          const currentIdx = Math.floor((mouseYInGrid - HEADER_H + scrollRef.current.scrollTop) / ROW_HEIGHT)
          const clamped = Math.max(0, Math.min(channelsRef.current.length - 1, currentIdx))
          channelDelta = clamped - d.startMouseChannelIdx
          if (channelDelta !== 0) justDragged.current = true
        }
        scheduleRef.current = scheduleRef.current.map(b => {
          if (!d.blockIds.has(b.id)) return b
          const orig = d.origStates[b.id]
          if (!orig) return b
          const newStartIso = new Date(orig.startMs + snappedMin * 60_000).toISOString()
          const newChIdx = Math.max(0, Math.min(channelsRef.current.length - 1, orig.channelIdx + channelDelta))
          const newChId = channelsRef.current[newChIdx]?.id ?? orig.channelId
          return { ...b, computedStart: newStartIso, channelId: newChId }
        })
        setSchedule(scheduleRef.current)
      }

      // Auto-scroll when dragging near left/right edges
      if (scrollRef.current) {
        const SCROLL_ZONE = 80  // px from edge where scrolling kicks in
        const MAX_SPEED  = 14  // px per animation frame at the very edge
        const rect = scrollRef.current.getBoundingClientRect()
        const relX = e.clientX - rect.left
        let vel = 0
        if (relX < SCROLL_ZONE) {
          vel = -MAX_SPEED * (1 - relX / SCROLL_ZONE)
        } else if (relX > rect.width - SCROLL_ZONE) {
          vel = MAX_SPEED * (1 - (rect.width - relX) / SCROLL_ZONE)
        }
        scrollVelRef.current = vel
        if (vel !== 0 && !scrollAnimRef.current) {
          const animate = () => {
            const d2 = dragRef.current
            if (!d2 || d2.mode === 'saving' || d2.mode === 'cooldown') {
              scrollAnimRef.current = null
              return
            }
            if (scrollRef.current && scrollVelRef.current !== 0) {
              scrollRef.current.scrollLeft += scrollVelRef.current
            }
            scrollAnimRef.current = requestAnimationFrame(animate)
          }
          scrollAnimRef.current = requestAnimationFrame(animate)
        } else if (vel === 0 && scrollAnimRef.current) {
          cancelAnimationFrame(scrollAnimRef.current)
          scrollAnimRef.current = null
        }
      }
    }

    const onUp = async (e) => {
      const d = dragRef.current
      if (!d || d.mode === 'saving' || d.mode === 'cooldown') return
      const wasDragged = justDragged.current
      document.body.style.cursor = ''
      if (scrollAnimRef.current) {
        cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = null
        scrollVelRef.current = 0
      }
      setTimeout(() => { if (!dragRef.current) justDragged.current = false }, 50)

      if (d.mode === 'select') {
        dragRef.current = null
        setSelectionBox(null)
        if (!wasDragged) {
          setSelectedBlockIds(new Set())
          selectedBlockIdsRef.current = new Set()
          return
        }
        const selMinX = Math.min(d.startGX, d.endGX ?? d.startGX)
        const selMaxX = Math.max(d.startGX, d.endGX ?? d.startGX)
        const selMinY = Math.min(d.startGY, d.endGY ?? d.startGY)
        const selMaxY = Math.max(d.startGY, d.endGY ?? d.startGY)
        const dayMs = selectedDay.getTime()
        const newSelected = new Set()
        for (const block of scheduleRef.current) {
          const bx = ((new Date(block.computedStart || block.startTime).getTime() - dayMs) / 60_000) * pxPerMinRef.current
          const bw = (block.durationSeconds / 60) * pxPerMinRef.current
          const chIdx = channelsRef.current.findIndex(c => c.id === block.channelId)
          if (chIdx < 0) continue
          const by = chIdx * ROW_HEIGHT
          if (bx + bw >= selMinX && bx <= selMaxX && by + ROW_HEIGHT >= selMinY && by <= selMaxY) {
            newSelected.add(block.id)
          }
        }
        selectedBlockIdsRef.current = newSelected
        setSelectedBlockIds(newSelected)
        return
      }

      if (d.mode === 'multiMove') {
        if (!wasDragged) { dragRef.current = null; return }
        dragRef.current = { mode: 'saving' }
        setSelectedBlockIds(new Set())
        selectedBlockIdsRef.current = new Set()
        // Capture original states before saving for undo
        const mmOrigStates = {}
        const mmNewStates = {}
        for (const id of d.blockIds) {
          const b = scheduleRef.current.find(x => x.id === id)
          if (!b) continue
          mmOrigStates[id] = { startTime: new Date(d.origStates[id]?.startMs ?? new Date(b.computedStart || b.startTime).getTime()).toISOString(), channelId: d.origStates[id]?.channelId ?? b.channelId, block: b }
          mmNewStates[id] = { startTime: b.computedStart || b.startTime, channelId: b.channelId, block: b }
          await saveBlock(b)
        }
        pushUndo({
          undo: async () => {
            for (const [id, s] of Object.entries(mmOrigStates)) {
              await fetch(`/api/schedule/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...s.block, startTime: s.startTime, channelId: s.channelId }) })
            }
            fetchScheduleRef.current?.()
          },
          redo: async () => {
            for (const [id, s] of Object.entries(mmNewStates)) {
              await fetch(`/api/schedule/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...s.block, startTime: s.startTime, channelId: s.channelId }) })
            }
            fetchScheduleRef.current?.()
          },
        })
        fetchSchedule()
        return
      }

      // resize / move
      if (!wasDragged) { dragRef.current = null; return }
      const block = scheduleRef.current.find(b => b.id === d.blockId)
      if (!block) { dragRef.current = null; return }
      // Check for overlaps before saving — past blocks are excluded
      const blockStartMs = new Date(block.computedStart || block.startTime).getTime()
      const nowMs = Date.now()
      const moveConflicts = scheduleRef.current.filter(b => {
        if (b.channelId !== block.channelId || b.id === block.id) return false
        if (block.groupId && b.groupId === block.groupId) return false
        const bS = new Date(b.computedStart || b.startTime).getTime()
        const bE = bS + b.durationSeconds * 1000
        if (bE <= nowMs) return false // already ended — not a conflict
        return blockStartMs < bE && blockStartMs + block.durationSeconds * 1000 > bS
      })
      if (moveConflicts.length > 0) {
        setWarningTooltip({ type: 'overlap', msg: `Overlaps with: ${moveConflicts.map(b => b.showName || 'a block').join(', ')}` })
        setTimeout(() => setWarningTooltip(null), 5000)
      }

      // Capture before/after for undo
      const blockBefore = { startTime: new Date(d.origStartMs).toISOString(), durationSeconds: d.origDurSecs, channelId: d.origChannelId }
      const blockAfter = { startTime: block.computedStart || block.startTime, durationSeconds: block.durationSeconds, channelId: block.channelId }
      const blockSnapshot = { ...block }

      dragRef.current = { mode: 'saving' }
      await saveBlock(block)

      // If this was a move (not resize) and the block belongs to a group,
      // propagate the same time delta AND channel change to all sibling blocks.
      let siblingOrigStates = []
      if (d.mode === 'move' && block.groupId) {
        const timeDeltaMs = new Date(block.computedStart || block.startTime).getTime() - d.origStartMs
        const channelChanged = block.channelId !== d.origChannelId
        if (timeDeltaMs !== 0 || channelChanged) {
          let siblingsFailed = 0
          try {
            const resp = await fetch(`/api/schedule/group/${block.groupId}`)
            if (!resp.ok) throw new Error('fetch failed')
            const siblings = await resp.json()
            siblingOrigStates = siblings.filter(s => s.id !== block.id).map(s => ({ ...s }))
            for (const sibling of siblings) {
              if (sibling.id === block.id) continue
              const newStart = new Date(new Date(sibling.startTime).getTime() + timeDeltaMs).toISOString()
              try {
                const r = await fetch(`/api/schedule/${sibling.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ...sibling, startTime: newStart, channelId: block.channelId }),
                })
                if (!r.ok) siblingsFailed++
              } catch { siblingsFailed++ }
            }
          } catch { siblingsFailed++ }
          if (siblingsFailed > 0) {
            setWarningTooltip({ type: 'overlap', msg: `${siblingsFailed} episode${siblingsFailed > 1 ? 's' : ''} failed to move — refresh to verify` })
            setTimeout(() => setWarningTooltip(null), 6000)
          }
        }
      }

      pushUndo({
        undo: async () => {
          await fetch(`/api/schedule/${blockSnapshot.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...blockSnapshot, ...blockBefore }) })
          for (const orig of siblingOrigStates) {
            await fetch(`/api/schedule/${orig.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...orig }) })
          }
          fetchScheduleRef.current?.()
        },
        redo: async () => {
          await fetch(`/api/schedule/${blockSnapshot.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...blockSnapshot, ...blockAfter }) })
          const deltaMs = new Date(blockAfter.startTime).getTime() - new Date(blockBefore.startTime).getTime()
          for (const orig of siblingOrigStates) {
            const newStart = new Date(new Date(orig.startTime).getTime() + deltaMs).toISOString()
            await fetch(`/api/schedule/${orig.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...orig, startTime: newStart, channelId: blockAfter.channelId }) })
          }
          fetchScheduleRef.current?.()
        },
      })

      fetchSchedule()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('pointerup', onUp)
      if (scrollAnimRef.current) {
        cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = null
      }
    }
  }, [fetchSchedule, selectedDay])

  // Keyboard shortcuts: Escape clears selection, Ctrl+Z/Y undo/redo
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setSelectedBlockIds(new Set())
        selectedBlockIdsRef.current = new Set()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        doUndo()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        doRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doUndo, doRedo])

  // Scroll to 8am on mount
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 8 * 60 * ZOOM_LEVELS[2]
  }, [])

  const pxPerMin = ZOOM_LEVELS[zoomIdx]
  const totalWidth = 24 * 60 * pxPerMin

  // Compute which block IDs overlap with another block on the same channel (for red highlight).
  // Pairs where both blocks have already fully aired are excluded — past conflicts don't matter.
  const overlappingIds = useMemo(() => {
    const ids = new Set()
    const now = Date.now()
    for (let i = 0; i < schedule.length; i++) {
      for (let j = i + 1; j < schedule.length; j++) {
        const a = schedule[i], b = schedule[j]
        if (a.channelId !== b.channelId) continue
        const aS = new Date(a.computedStart || a.startTime).getTime()
        const aE = aS + a.durationSeconds * 1000
        const bS = new Date(b.computedStart || b.startTime).getTime()
        const bE = bS + b.durationSeconds * 1000
        if (aE <= now && bE <= now) continue // both already ended — ignore
        if (a.groupId && a.groupId === b.groupId) continue
        if (aS < bE && aE > bS) { ids.add(a.id); ids.add(b.id) }
      }
    }
    return ids
  }, [schedule])

  // Returns blocks on channelId that overlap [startMs, startMs+durationSecs*1000), optionally excluding one block
  const getOverlaps = (channelId, startMs, durationSecs, excludeId = null, excludeGroupId = null) => {
    const endMs = startMs + durationSecs * 1000
    return scheduleRef.current.filter(b => {
      if (b.channelId !== channelId) return false
      if (excludeId !== null && b.id === excludeId) return false
      if (excludeGroupId && b.groupId === excludeGroupId) return false
      const bS = new Date(b.computedStart || b.startTime).getTime()
      return startMs < bS + b.durationSeconds * 1000 && endMs > bS
    })
  }

  const timeToX = (date) => {
    const ms = new Date(date) - new Date(selectedDay)
    return (ms / 60_000) * pxPerMin
  }

  const xToTime = (x) => {
    const snapped = Math.round((x / pxPerMin) / SNAP_DROP) * SNAP_DROP
    return new Date(selectedDay.getTime() + snapped * 60_000)
  }

  const formatHour = (h) => `${h % 12 || 12}${h >= 12 ? 'PM' : 'AM'}`
  const hours = Array.from({ length: 25 }, (_, i) => i)

  const applyClamp = (container, sl) => {
    container.querySelectorAll('[data-clamp-x]').forEach(el => {
      const bx = +el.dataset.clampX
      const bw = +el.dataset.clampW
      const offset = Math.max(0, Math.min(sl - bx, bw - 70))
      el.style.left = Math.max(8, offset + 8) + 'px'
    })
  }

  const handleGridScroll = (e) => {
    if (channelLabelsRef.current) channelLabelsRef.current.scrollTop = e.currentTarget.scrollTop
    applyClamp(e.currentTarget, e.currentTarget.scrollLeft)
  }

  const postBlock = async (channelId, startTime, item, groupId = '') => {
    const r = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId,
        startTime: startTime.toISOString(),
        durationSeconds: item.durationSeconds || 1800,
        type: item.type || 'episode',
        jellyfinItemId: item.jellyfinItemId || '',
        showId: item.showId || '',
        showName: item.showName || '',
        episodeName: item.episodeName || '',
        seasonNumber: item.seasonNumber || 0,
        episodeNumber: item.episodeNumber || 0,
        isRecurring: false,
        recurDays: '[]',
        groupId,
      }),
    })
    return r.json()
  }

  const handleDrop = async (e, channelId) => {
    e.preventDefault()
    setDropPreview(null)
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return
    let item
    try { item = JSON.parse(raw) } catch { return }
    const rect = e.currentTarget.getBoundingClientRect()
    const time = xToTime(e.clientX - rect.left)

    // Show/season drops: ask how to schedule (single block vs one-per-day)
    if (item.showId && !item.jellyfinItemId) {
      setDropTypeModal({ item, channelId, time })
      onDragEnd?.()
      return
    }

    // Individual episode: check for overlap, then post
    const conflicts = getOverlaps(channelId, time.getTime(), item.durationSeconds || 1800)
    const created = await postBlock(channelId, time, item)
    onDragEnd?.()
    fetchSchedule()
    if (conflicts.length > 0) {
      setWarningTooltip({ type: 'overlap', msg: `Overlaps with: ${conflicts.map(b => b.showName || 'a block').join(', ')}` })
      setTimeout(() => setWarningTooltip(null), 5000)
    }
    if (created?.id) {
      let blockId = created.id
      pushUndo({
        undo: async () => {
          await fetch(`/api/schedule/${blockId}`, { method: 'DELETE' })
          fetchScheduleRef.current?.()
        },
        redo: async () => {
          const r = await postBlock(channelId, time, item)
          blockId = r?.id ?? blockId
          fetchScheduleRef.current?.()
        },
      })
    }
  }

  const handleBulkSchedule = async (episodes, item, channelId, time) => {
    const groupId = 'grp-' + Date.now()
    const sorted = [...episodes].sort((a, b) => {
      if (a.ParentIndexNumber !== b.ParentIndexNumber) return a.ParentIndexNumber - b.ParentIndexNumber
      return (a.IndexNumber || 0) - (b.IndexNumber || 0)
    })
    setDropTypeModal(null)
    setBulkProgress({ current: 0, total: sorted.length, showName: item.showName || 'Show' })
    for (let i = 0; i < sorted.length; i++) {
      const ep = sorted[i]
      const dur = Math.floor((ep.RunTimeTicks || 0) / 10_000_000) || 1800
      const startTime = new Date(time.getTime() + i * 86400_000)
      await postBlock(channelId, startTime, {
        type: 'episode',
        jellyfinItemId: ep.Id,
        showId: item.showId,
        showName: item.showName || ep.SeriesName || '',
        episodeName: ep.Name,
        seasonNumber: ep.ParentIndexNumber || 0,
        episodeNumber: ep.IndexNumber || 0,
        durationSeconds: dur,
      }, groupId)
      setBulkProgress({ current: i + 1, total: sorted.length, showName: item.showName || 'Show' })
    }
    setBulkProgress(null)
    fetchSchedule()
    pushUndo({
      undo: async () => {
        await fetch(`/api/schedule/group/${groupId}`, { method: 'DELETE' })
        fetchScheduleRef.current?.()
      },
      redo: async () => {
        const newGroupId = 'grp-' + Date.now()
        for (let i = 0; i < sorted.length; i++) {
          const ep = sorted[i]
          const dur = Math.floor((ep.RunTimeTicks || 0) / 10_000_000) || 1800
          await postBlock(channelId, new Date(time.getTime() + i * 86400_000), {
            type: 'episode', jellyfinItemId: ep.Id, showId: item.showId,
            showName: item.showName || ep.SeriesName || '', episodeName: ep.Name,
            seasonNumber: ep.ParentIndexNumber || 0, episodeNumber: ep.IndexNumber || 0, durationSeconds: dur,
          }, newGroupId)
        }
        fetchScheduleRef.current?.()
      },
    })
  }

  const handleDragOver = (e, channelId) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    setDropPreview({
      channelId,
      time: xToTime(e.clientX - rect.left),
      width: (draggedItem?.durationSeconds || 1800) / 60 * pxPerMin,
    })
  }

  const handleZoom = (delta) => {
    const newIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIdx + delta))
    if (newIdx === zoomIdx) return
    if (scrollRef.current) {
      const oldPxPerMin = ZOOM_LEVELS[zoomIdx]
      const newPxPerMin = ZOOM_LEVELS[newIdx]
      const sl = scrollRef.current.scrollLeft
      const vw = scrollRef.current.clientWidth
      const centerMin = (sl + vw / 2) / oldPxPerMin
      zoomScrollTargetRef.current = Math.max(0, centerMin * newPxPerMin - vw / 2)
    }
    setZoomIdx(newIdx)
  }

  const deleteBlock = async (blockId) => {
    const blockData = scheduleRef.current.find(b => b.id === blockId)
    await fetch(`/api/schedule/${blockId}`, { method: 'DELETE' })
    setEditBlock(null)
    fetchSchedule()
    if (blockData) {
      let newId = null
      pushUndo({
        undo: async () => {
          const r = await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...blockData }),
          })
          const created = await r.json()
          newId = created?.id ?? null
          fetchScheduleRef.current?.()
        },
        redo: async () => {
          if (newId !== null) {
            await fetch(`/api/schedule/${newId}`, { method: 'DELETE' })
            fetchScheduleRef.current?.()
          }
        },
      })
    }
  }

  const handleDeleteIndividualFromGroup = async (block) => {
    // Push this episode and all later siblings forward by 1 day, leaving today's slot empty
    const resp = await fetch(`/api/schedule/group/${block.groupId}`)
    if (!resp.ok) return
    const siblings = await resp.json()
    const sorted = [...siblings].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    const idx = sorted.findIndex(s => s.id === block.id)
    const toShift = idx >= 0 ? sorted.slice(idx) : sorted

    const origStarts = toShift.map(s => ({ id: s.id, startTime: s.startTime, block: s }))
    for (const sibling of toShift) {
      const newStart = new Date(new Date(sibling.startTime).getTime() + 86400_000).toISOString()
      await fetch(`/api/schedule/${sibling.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sibling, startTime: newStart }),
      })
    }
    setEditBlock(null)
    fetchSchedule()
    pushUndo({
      undo: async () => {
        for (const orig of origStarts) {
          await fetch(`/api/schedule/${orig.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...orig.block, startTime: orig.startTime }) })
        }
        fetchScheduleRef.current?.()
      },
      redo: async () => {
        for (const orig of origStarts) {
          const newStart = new Date(new Date(orig.startTime).getTime() + 86400_000).toISOString()
          await fetch(`/api/schedule/${orig.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...orig.block, startTime: newStart }) })
        }
        fetchScheduleRef.current?.()
      },
    })
  }

  const dayRange = Array.from({ length: 90 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() + i)
    return startOfDay(d)
  })

  const formatDay = (d) => {
    const today = startOfToday()
    if (d.getTime() === today.getTime()) return 'Today'
    if (d.getTime() === today.getTime() + 86400_000) return 'Tomorrow'
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  return (
    <div className="h-full flex flex-col">
      {/* Day selector */}
      <div className="safe-area-top flex items-center gap-1 px-4 py-3 border-b border-white/10 overflow-x-auto flex-shrink-0"
        style={{ background: '#0c1520' }}>
        {/* Zoom controls — fixed left, don't scroll */}
        <div className="flex items-center gap-1 mr-2 flex-shrink-0">
          <button
            onClick={() => handleZoom(-1)}
            disabled={zoomIdx === 0}
            className="w-7 h-7 flex items-center justify-center rounded text-white/50 hover:text-white transition-colors disabled:opacity-30"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            title="Zoom out"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>remove</span>
          </button>
          <button
            onClick={() => handleZoom(1)}
            disabled={zoomIdx === ZOOM_LEVELS.length - 1}
            className="w-7 h-7 flex items-center justify-center rounded text-white/50 hover:text-white transition-colors disabled:opacity-30"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            title="Zoom in"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
          </button>
        </div>
        {dayRange.map(d => (
          <button
            key={d.getTime()}
            onClick={() => { setSelectedDay(d); setSelectedBlockIds(new Set()); selectedBlockIdsRef.current = new Set() }}
            className="flex-shrink-0 px-3 py-1.5 rounded text-xs font-mono transition-all"
            style={{
              background: d.getTime() === selectedDay.getTime() ? 'rgba(var(--accent-rgb),0.3)' : 'rgba(255,255,255,0.05)',
              color: d.getTime() === selectedDay.getTime() ? 'var(--accent)' : 'rgba(255,255,255,0.5)',
              border: d.getTime() === selectedDay.getTime() ? '1px solid rgba(var(--accent-rgb),0.5)' : '1px solid transparent',
            }}
          >
            {formatDay(d)}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-hidden flex">
        {/* Channel labels */}
        <div className="flex flex-col flex-shrink-0 border-r border-white/10" style={{ width: CHANNEL_COL }}>
          <div className="flex-shrink-0 border-b border-white/10" style={{ height: HEADER_H, background: '#0c1520' }} />
          <div ref={channelLabelsRef} style={{ overflowY: 'hidden', flex: 1 }}>
            {channels.map(ch => (
              <div
                key={ch.id}
                className="flex items-center gap-2 px-3 border-b border-white/10 text-white/60 text-xs"
                style={{ height: ROW_HEIGHT, background: '#0c1520' }}
              >
                {ch.logoUrl
                  ? <img src={ch.logoUrl} alt="" className="w-6 h-6 object-contain rounded" />
                  : <div className="w-7 h-7 flex items-center justify-center rounded bg-white/5 text-white/40 font-mono text-xs">{ch.number}</div>
                }
                <span className="truncate">{ch.name || `CH ${ch.number}`}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable time grid */}
        <div className="flex-1 overflow-auto" ref={scrollRef} onScroll={handleGridScroll}>
          {/* Time header */}
          <div
            className="sticky top-0 z-10 border-b border-white/10"
            style={{ width: totalWidth, height: HEADER_H, background: '#0c1520' }}
          >
            {hours.map(h => (
              <div
                key={h}
                className="absolute flex items-center pl-1 text-xs text-white/30 font-mono border-r border-white/5"
                style={{ left: h * 60 * pxPerMin, width: 60 * pxPerMin, height: HEADER_H }}
              >
                {h < 24 ? formatHour(h) : ''}
              </div>
            ))}
          </div>

          {/* Channel rows */}
          <div style={{ width: totalWidth, position: 'relative' }}>
            {/* Box selection overlay */}
            {selectionBox && (
              <div
                className="absolute pointer-events-none z-30"
                style={{
                  left: Math.min(selectionBox.startGX, selectionBox.endGX),
                  top: Math.min(selectionBox.startGY, selectionBox.endGY),
                  width: Math.abs(selectionBox.endGX - selectionBox.startGX),
                  height: Math.abs(selectionBox.endGY - selectionBox.startGY),
                  background: 'rgba(var(--accent-rgb),0.08)',
                  border: '1px solid rgba(var(--accent-rgb),0.6)',
                  borderRadius: 3,
                }}
              />
            )}
            {/* Current time indicator */}
            {(() => {
              const now = new Date()
              const dayMs = selectedDay.getTime()
              if (now < dayMs || now > dayMs + 86400_000) return null
              const x = timeToX(now)
              return x >= 0 && x <= totalWidth ? (
                <div className="absolute top-0 bottom-0 w-0.5 z-10 pointer-events-none"
                  style={{ left: x, background: 'var(--accent)', boxShadow: '0 0 6px rgba(var(--accent-rgb),0.8)' }} />
              ) : null
            })()}

            {channels.map(ch => {
              const chBlocks = schedule.filter(b => b.channelId === ch.id)
              return (
                <div
                  key={ch.id}
                  className="relative border-b border-white/10"
                  style={{ height: ROW_HEIGHT, width: totalWidth }}
                  onDragOver={(e) => handleDragOver(e, ch.id)}
                  onDrop={(e) => handleDrop(e, ch.id)}
                  onDragLeave={() => setDropPreview(null)}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return
                    if (dragRef.current) return
                    const rect = scrollRef.current?.getBoundingClientRect()
                    if (!rect) return
                    const startGX = e.clientX - rect.left + scrollRef.current.scrollLeft
                    const startGY = e.clientY - rect.top + scrollRef.current.scrollTop - HEADER_H
                    justDragged.current = false
                    dragRef.current = { mode: 'select', startGX, startGY }
                  }}
                >
                  {hours.map(h => (
                    <div key={h} className="absolute top-0 bottom-0 border-r border-white/5"
                      style={{ left: h * 60 * pxPerMin }} />
                  ))}

                  {dropPreview?.channelId === ch.id && (
                    <div
                      className="absolute top-1 bottom-1 rounded opacity-50 pointer-events-none"
                      style={{
                        left: timeToX(dropPreview.time) + 1,
                        width: dropPreview.width - 2,
                        background: 'rgba(var(--accent-rgb),0.4)',
                        border: '2px dashed rgba(var(--accent-rgb),0.8)',
                      }}
                    />
                  )}

                  {chBlocks.map(block => {
                    const rawX = timeToX(block.computedStart || block.startTime)
                    const rawW = (block.durationSeconds / 60) * pxPerMin
                    if (rawX + rawW < 0 || rawX > totalWidth) return null
                    // Clamp to day boundaries so midnight-spanning blocks render correctly
                    const x = Math.max(0, rawX)
                    const endX = Math.min(totalWidth, rawX + rawW)
                    const w = endX - x
                    if (w < 2) return null

                    const isSequential = block.type === 'sequential'
                    const isShuffleType = block.type === 'random' || block.type === 'sequential'
                    const seasonFilter = block.seasonFilter ?? block.seasonNumber ?? 0
                    // Recompute skipped episodes live using per-episode durations (updates during resize)
                    const liveSkipped = block.episodeDurations
                      ? block.episodeDurations.filter(e => e.seconds > block.durationSeconds).map(e => e.name)
                      : (block.skippedEpisodes ?? [])
                    const hasWarning = liveSkipped.length > 0

                    const startResizeMouseDown = (e, edge) => {
                      e.stopPropagation()
                      e.preventDefault()
                      if (dragRef.current) return
                      justDragged.current = false
                      setWarningTooltip(null)
                      setBlockHoverTooltip(null)
                      dragRef.current = {
                        mode: 'resize', blockId: block.id, edge,
                        startX: e.clientX,
                        startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
                        origStartMs: new Date(block.computedStart || block.startTime).getTime(),
                        origDurSecs: block.durationSeconds,
                        origChannelId: block.channelId,
                      }
                      document.body.style.cursor = 'ew-resize'
                    }

                    const startMoveMouseDown = (e) => {
                      if (e.button !== 0) return
                      e.stopPropagation() // prevent channel row from starting a selection box
                      e.preventDefault()  // prevent native DnD from capturing pointer events (which swallows mouseup)
                      if (dragRef.current) return // ignore spurious mousedown during active drag
                      justDragged.current = false
                      setWarningTooltip(null)
                      setBlockHoverTooltip(null)

                      const isSelected = selectedBlockIdsRef.current.has(block.id)
                      const multiCount = selectedBlockIdsRef.current.size

                      if (isSelected && multiCount > 1) {
                        // Start multi-block move
                        const anchorChIdx = channelsRef.current.findIndex(c => c.id === block.channelId)
                        const origStates = {}
                        for (const bid of selectedBlockIdsRef.current) {
                          const b = scheduleRef.current.find(x => x.id === bid)
                          if (!b) continue
                          origStates[bid] = {
                            startMs: new Date(b.computedStart || b.startTime).getTime(),
                            channelIdx: channelsRef.current.findIndex(c => c.id === b.channelId),
                            channelId: b.channelId,
                          }
                        }
                        dragRef.current = {
                          mode: 'multiMove',
                          blockIds: new Set(selectedBlockIdsRef.current),
                          origStates,
                          startX: e.clientX,
                          startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
                          startMouseChannelIdx: Math.max(0, anchorChIdx),
                        }
                      } else {
                        // Clear selection when starting to drag an unselected block
                        if (!isSelected) {
                          setSelectedBlockIds(new Set())
                          selectedBlockIdsRef.current = new Set()
                        }
                        dragRef.current = {
                          mode: 'move', blockId: block.id,
                          startX: e.clientX,
                          startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
                          origStartMs: new Date(block.computedStart || block.startTime).getTime(),
                          origDurSecs: block.durationSeconds,
                          origChannelId: block.channelId,
                        }
                      }
                      document.body.style.cursor = 'grabbing'
                    }

                    // Graduated content thresholds (px)
                    const isTiny   = w < 22   // just a colored pill
                    const isSmall  = w < 52   // name only
                    const isMedium = w < 90   // name + duration, no season label
                    const isSelected = selectedBlockIds.has(block.id)
                    const isOverlapping = overlappingIds.has(block.id)

                    // For individual episodes show episode name + S/E label instead of show name
                    const isEpisodeBlock = block.type === 'episode' && block.episodeNumber > 0
                    const blockPrimaryName = isEpisodeBlock
                      ? (block.episodeName || block.showName || 'Block')
                      : (block.showName || block.episodeName || 'Block')
                    const blockSeLabel = isEpisodeBlock
                      ? `S${String(block.seasonNumber).padStart(2,'0')}E${String(block.episodeNumber).padStart(2,'0')}`
                      : null

                    // Compute initial clamp from current scroll position (synchronous DOM read,
                    // avoids flicker on re-render). Scroll handler updates styles directly via DOM.
                    const sl0 = scrollRef.current?.scrollLeft ?? 0
                    const clampOffset = isTiny ? 0 : Math.max(0, Math.min(sl0 - x, w - 70))

                    return (
                      <div
                        key={block.id}
                        className="absolute top-1 bottom-1 rounded flex select-none overflow-hidden"
                        style={{
                          left: x + 1,
                          width: Math.max(4, w - 2),
                          background: isOverlapping ? 'rgba(239,68,68,0.18)' : isSelected ? 'rgba(var(--accent-rgb),0.45)' : 'rgba(var(--accent-rgb),0.22)',
                          border: isOverlapping ? '1.5px solid rgba(239,68,68,0.75)' : isSelected ? '2px solid rgba(var(--accent-rgb),0.9)' : '1px solid rgba(var(--accent-rgb),0.45)',
                          cursor: 'grab',
                          boxShadow: isSelected ? '0 0 0 1px rgba(var(--accent-rgb),0.3)' : 'none',
                        }}
                        onMouseDown={startMoveMouseDown}
                        onClick={() => { if (!justDragged.current) setEditBlock(block) }}
                        onMouseEnter={(isTiny || isSmall) ? (e) => {
                          const r = e.currentTarget.getBoundingClientRect()
                          setBlockHoverTooltip({ block, top: r.top, left: r.left + r.width / 2 })
                        } : undefined}
                        onMouseLeave={(isTiny || isSmall) ? () => setBlockHoverTooltip(null) : undefined}
                      >
                        {/* Left resize handle */}
                        {!isTiny && (
                          <div
                            className="absolute left-0 top-0 bottom-0 flex items-center justify-center z-10"
                            style={{ width: 8, cursor: 'ew-resize' }}
                            onMouseDown={(e) => startResizeMouseDown(e, 'left')}
                          >
                            <div className="rounded-full" style={{ width: 3, height: '40%', background: 'rgba(255,255,255,0.35)' }} />
                          </div>
                        )}

                        {/* Block content — graduated by width */}
                        {!isTiny && !isSmall && (
                          <div className="absolute top-0 bottom-0 flex items-stretch" data-clamp-x={x} data-clamp-w={w} style={{ left: Math.max(8, clampOffset + 8), right: 8 }}>
                            <div className="flex-1 flex flex-col justify-center min-w-0 overflow-hidden">
                              <div className="flex items-center gap-0.5">
                                {isShuffleType && (
                                  <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 9, color: 'rgba(var(--accent-rgb),0.8)' }}>
                                    {isSequential ? 'sort' : 'shuffle'}
                                  </span>
                                )}
                                {block.groupId && (
                                  <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 11, color: 'var(--accent)' }}>link</span>
                                )}
                                <div className="text-white font-semibold truncate leading-tight" style={{ fontSize: 10 }}>
                                  {blockPrimaryName}
                                </div>
                              </div>
                              {!isMedium && isShuffleType && (
                                <div className="text-white/40 truncate leading-tight" style={{ fontSize: 9 }}>
                                  {isSequential
                                    ? (seasonFilter > 0 ? `S${seasonFilter} in order` : 'Show in order')
                                    : (seasonFilter > 0 ? `S${seasonFilter} shuffle` : 'Show shuffle')
                                  }
                                </div>
                              )}
                              {!isMedium && blockSeLabel && (
                                <div className="text-white/40 font-mono leading-tight" style={{ fontSize: 9 }}>{blockSeLabel}</div>
                              )}
                              <div className="text-white/25 font-mono" style={{ fontSize: 9 }}>
                                {Math.round(block.durationSeconds / 60)}m
                              </div>
                            </div>
                            {/* Warning icon */}
                            {(hasWarning || isOverlapping) && (
                              <div
                                className="flex items-center px-1 flex-shrink-0 cursor-default"
                                onMouseEnter={(e) => {
                                  const r = e.currentTarget.getBoundingClientRect()
                                  setWarningTooltip({ top: r.top, left: r.left + r.width / 2, blockId: block.id })
                                }}
                                onMouseLeave={() => setWarningTooltip(null)}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 12, color: isOverlapping ? '#ef4444' : '#facc15' }}>
                                  warning
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Small: name only */}
                        {!isTiny && isSmall && (
                          <div className="absolute top-0 bottom-0 flex items-center overflow-hidden" data-clamp-x={x} data-clamp-w={w} style={{ left: Math.max(8, clampOffset + 8), right: 8 }}>
                            <div className="text-white font-semibold truncate leading-tight" style={{ fontSize: 9 }}>
                              {block.showName || block.episodeName || 'Block'}
                            </div>
                          </div>
                        )}

                        {/* Right resize handle */}
                        {!isTiny && (
                          <div
                            className="absolute right-0 top-0 bottom-0 flex items-center justify-center z-10"
                            style={{ width: 8, cursor: 'ew-resize' }}
                            onMouseDown={(e) => startResizeMouseDown(e, 'right')}
                          >
                            <div className="rounded-full" style={{ width: 3, height: '40%', background: 'rgba(255,255,255,0.35)' }} />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {editBlock && (
        <BlockEditModal
          block={editBlock}
          onClose={() => setEditBlock(null)}
          onDelete={() => deleteBlock(editBlock.id)}
          onDeleteIndividual={editBlock.groupId ? () => handleDeleteIndividualFromGroup(editBlock) : null}
          onDeleteGroup={editBlock.groupId ? async () => {
            const groupData = scheduleRef.current.filter(b => b.groupId === editBlock.groupId)
            await fetch(`/api/schedule/group/${editBlock.groupId}`, { method: 'DELETE' })
            setEditBlock(null)
            fetchSchedule()
            if (groupData.length > 0) {
              pushUndo({
                undo: async () => {
                  for (const b of groupData) {
                    await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...b }) })
                  }
                  fetchScheduleRef.current?.()
                },
                redo: async () => {
                  await fetch(`/api/schedule/group/${editBlock.groupId}`, { method: 'DELETE' })
                  fetchScheduleRef.current?.()
                },
              })
            }
          } : null}
          onSave={async (updated) => {
            await fetch(`/api/schedule/${editBlock.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updated),
            })
            setEditBlock(null)
            fetchSchedule()
          }}
        />
      )}

      {/* Fixed-position warning tooltip — escapes all overflow containers */}
      {warningTooltip && (() => {
        // Overlap toast (from drop/move)
        if (warningTooltip.type === 'overlap') {
          return (
            <div className="fixed bottom-6 left-1/2 z-[9999] pointer-events-none"
              style={{ transform: 'translateX(-50%)' }}>
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
                style={{ background: '#1e2a3a', border: '1px solid rgba(239,68,68,0.6)', boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)' }}>
                <span className="material-symbols-outlined text-red-400" style={{ fontSize: 16 }}>warning</span>
                <span className="text-red-300">{warningTooltip.msg}</span>
              </div>
            </div>
          )
        }
        // Episode-too-long tooltip (hover on block warning icon)
        const tooltipBlock = schedule.find(b => b.id === warningTooltip.blockId)
        if (!tooltipBlock) return null
        const tooltipSkipped = tooltipBlock.episodeDurations
          ? tooltipBlock.episodeDurations.filter(e => e.seconds > tooltipBlock.durationSeconds).map(e => e.name)
          : (tooltipBlock.skippedEpisodes ?? [])
        const isOverlapTooltip = overlappingIds.has(tooltipBlock.id)
        if (tooltipSkipped.length === 0 && !isOverlapTooltip) return null
        return (
          <div
            className="fixed z-[9999] pointer-events-none"
            style={{
              top: warningTooltip.top,
              left: warningTooltip.left,
              transform: 'translateX(-50%) translateY(-100%) translateY(-6px)',
            }}
          >
            <div className="rounded p-2 text-xs"
              style={{
                background: '#1e2a3a',
                border: `1px solid ${isOverlapTooltip ? 'rgba(239,68,68,0.5)' : 'rgba(250,204,21,0.5)'}`,
                boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)',
                minWidth: 200,
                maxWidth: 280,
              }}
            >
              {isOverlapTooltip && <p className="text-red-400 font-semibold mb-1">Overlaps with another block</p>}
              {tooltipSkipped.length > 0 && (
                <>
                  <p className="text-yellow-400 font-semibold mb-1">
                    {tooltipSkipped.length} ep{tooltipSkipped.length > 1 ? 's' : ''} too long to play:
                  </p>
                  {tooltipSkipped.slice(0, 8).map(ep => (
                    <p key={ep} className="text-white/60 truncate">{ep}</p>
                  ))}
                  {tooltipSkipped.length > 8 && (
                    <p className="text-white/30 mt-1">+{tooltipSkipped.length - 8} more</p>
                  )}
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* Hover tooltip for tiny/small blocks — shows full block info near the block */}
      {blockHoverTooltip && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{
            top: blockHoverTooltip.top,
            left: blockHoverTooltip.left,
            transform: 'translateX(-50%) translateY(-100%) translateY(-6px)',
          }}
        >
          <div className="rounded p-2" style={{
            background: '#1e2a3a',
            border: '1px solid rgba(var(--accent-rgb),0.4)',
            boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)',
            minWidth: 130,
            maxWidth: 220,
          }}>
            <div className="text-white font-semibold leading-tight" style={{ fontSize: 11 }}>
              {blockHoverTooltip.block.showName || blockHoverTooltip.block.episodeName || 'Block'}
            </div>
            {blockHoverTooltip.block.episodeName && blockHoverTooltip.block.showName !== blockHoverTooltip.block.episodeName && (
              <div className="text-white/60 truncate" style={{ fontSize: 10 }}>{blockHoverTooltip.block.episodeName}</div>
            )}
            {blockHoverTooltip.block.seasonNumber > 0 && blockHoverTooltip.block.episodeNumber > 0 && (
              <div className="text-white/40 font-mono" style={{ fontSize: 9 }}>
                S{String(blockHoverTooltip.block.seasonNumber).padStart(2,'0')}E{String(blockHoverTooltip.block.episodeNumber).padStart(2,'0')}
              </div>
            )}
            <div className="text-white/30 font-mono" style={{ fontSize: 9 }}>
              {Math.round(blockHoverTooltip.block.durationSeconds / 60)}m
            </div>
          </div>
        </div>
      )}

      {dropTypeModal && (
        <DropTypeModal
          item={dropTypeModal.item}
          channelId={dropTypeModal.channelId}
          time={dropTypeModal.time}
          onClose={() => setDropTypeModal(null)}
          onCreateSingle={async (item) => {
            await postBlock(dropTypeModal.channelId, dropTypeModal.time, item)
            setDropTypeModal(null)
            fetchSchedule()
          }}
          onBulkSchedule={(episodes) => handleBulkSchedule(episodes, dropTypeModal.item, dropTypeModal.channelId, dropTypeModal.time)}
        />
      )}

      {/* Bulk schedule progress overlay */}
      {bulkProgress && (
        <div className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-lg p-8 w-80 flex flex-col gap-5 items-center text-center"
            style={{ background: '#1e2a3a', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)' }}>
            <span className="material-symbols-outlined text-app-purple" style={{ fontSize: 36 }}>calendar_month</span>
            <div>
              <div className="text-white font-display font-bold text-base">{bulkProgress.showName}</div>
              <div className="text-white/40 text-sm mt-1">
                Scheduling episode {bulkProgress.current} of {bulkProgress.total}…
              </div>
            </div>
            <div className="w-full rounded-full overflow-hidden" style={{ height: 6, background: 'rgba(255,255,255,0.08)' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${(bulkProgress.current / bulkProgress.total) * 100}%`, background: 'var(--accent)' }}
              />
            </div>
            <div className="text-white/30 font-mono text-xs">
              {Math.round((bulkProgress.current / bulkProgress.total) * 100)}%
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DropTypeModal({ item, channelId, time, onClose, onCreateSingle, onBulkSchedule }) {
  const [episodes, setEpisodes] = useState(null)
  const [loading, setLoading] = useState(true)
  const [bulkConflicts, setBulkConflicts] = useState([])

  const filteredEps = useMemo(() => {
    if (!episodes) return []
    const eps = item.seasonNumber > 0
      ? episodes.filter(e => e.ParentIndexNumber === item.seasonNumber)
      : episodes
    return [...eps].sort((a, b) => {
      if (a.ParentIndexNumber !== b.ParentIndexNumber) return a.ParentIndexNumber - b.ParentIndexNumber
      return (a.IndexNumber || 0) - (b.IndexNumber || 0)
    })
  }, [episodes, item.seasonNumber])

  useEffect(() => {
    fetch(`/api/library/shows/${item.showId}/episodes`)
      .then(r => r.json())
      .then(data => { setEpisodes(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [item.showId])

  // Check for conflicts in the bulk-schedule date range
  useEffect(() => {
    if (filteredEps.length === 0) return
    const from = time.toISOString()
    const to = new Date(time.getTime() + filteredEps.length * 86400_000).toISOString()
    fetch(`/api/schedule?from=${from}&to=${to}&channel=${channelId}`)
      .then(r => r.json())
      .then(blocks => {
        const h = time.getUTCHours(), m = time.getUTCMinutes()
        const conflicts = []
        filteredEps.forEach((ep, i) => {
          const day = new Date(time.getTime() + i * 86400_000)
          const slotStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, 0)
          const dur = Math.floor((ep.RunTimeTicks || 0) / 10_000_000) || 1800
          const slotEnd = slotStart + dur * 1000
          const hit = blocks.find(b => {
            const bS = new Date(b.computedStart).getTime()
            return slotStart < bS + b.durationSeconds * 1000 && slotEnd > bS
          })
          if (hit) conflicts.push({ dayNum: i + 1, date: new Date(slotStart), name: hit.showName || 'a block' })
        })
        setBulkConflicts(conflicts)
      })
      .catch(() => {})
  }, [filteredEps, channelId, time])

  const totalMins = filteredEps.reduce((s, ep) => s + Math.floor((ep.RunTimeTicks || 0) / 10_000_000 / 60), 0)
  const endDate = filteredEps.length > 0 ? new Date(time.getTime() + (filteredEps.length - 1) * 86400_000) : null

  const btnStyle = { background: 'rgba(var(--accent-rgb),0.25)', border: '1px solid rgba(var(--accent-rgb),0.5)' }
  const fmtDate = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="rounded-lg p-6 w-96 flex flex-col gap-4"
        style={{ background: '#1e2a3a', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)' }}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display font-bold text-white">{item.showName}</h3>
            <p className="text-white/40 text-sm">{item.seasonNumber > 0 ? `Season ${item.seasonNumber}` : 'All seasons'}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <p className="text-white/50 text-xs -mt-1">How would you like to schedule this?</p>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => onCreateSingle({ ...item, type: 'random', durationSeconds: 1800 })}
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-all hover:brightness-125"
            style={btnStyle}
          >
            <span className="material-symbols-outlined text-app-purple">shuffle</span>
            <div>
              <div className="text-white text-sm font-semibold">Shuffle block</div>
              <div className="text-white/40 text-xs">Episodes play in random order within one time slot</div>
            </div>
          </button>

          {loading ? (
            <div className="flex items-center gap-2 px-4 py-3 text-white/30 text-sm">
              <div className="w-4 h-4 border-2 border-white/20 border-t-app-purple rounded-full animate-spin" />
              Loading episodes…
            </div>
          ) : (
            <button
              onClick={() => onBulkSchedule(filteredEps)}
              className="flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-all hover:brightness-125"
              style={{ background: 'rgba(0,180,90,0.15)', border: '1px solid rgba(0,180,90,0.4)' }}
            >
              <span className="material-symbols-outlined" style={{ color: '#4ade80' }}>calendar_month</span>
              <div className="flex-1 min-w-0">
                <div className="text-white text-sm font-semibold">Schedule all {filteredEps.length} episodes, one per day</div>
                <div className="text-white/40 text-xs">
                  {fmtDate(time)}{endDate ? ` – ${fmtDate(endDate)}` : ''} · ~{totalMins}min total
                </div>
                {bulkConflicts.length > 0 && (
                  <div className="text-yellow-400 text-xs mt-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined" style={{ fontSize: 12 }}>warning</span>
                    {bulkConflicts.length} conflict{bulkConflicts.length > 1 ? 's' : ''}: {bulkConflicts.slice(0, 2).map(c => `Day ${c.dayNum} (${c.name})`).join(', ')}{bulkConflicts.length > 2 ? ` +${bulkConflicts.length - 2} more` : ''}
                  </div>
                )}
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function BlockEditModal({ block, onClose, onDelete, onDeleteIndividual, onDeleteGroup, onSave }) {
  const [isRecurring, setIsRecurring] = useState(block.isRecurring)
  const [recurDays, setRecurDays] = useState(() => {
    try { return JSON.parse(block.recurDays) } catch { return [] }
  })
  const isShowBlock = block.type === 'random' || block.type === 'sequential'
  const [playOrder, setPlayOrder] = useState(block.type)
  const [selectedSeason, setSelectedSeason] = useState(block.seasonFilter ?? block.seasonNumber ?? 0)
  const [availableSeasons, setAvailableSeasons] = useState([])
  const [recurConflicts, setRecurConflicts] = useState([])
  const [checkingConflicts, setCheckingConflicts] = useState(false)

  useEffect(() => {
    if (!isShowBlock || !block.showId) return
    fetch(`/api/library/shows/${block.showId}/episodes`)
      .then(r => r.json())
      .then(eps => {
        const seasons = [...new Set(eps.map(e => e.ParentIndexNumber))]
          .filter(s => s > 0)
          .sort((a, b) => a - b)
        setAvailableSeasons(seasons)
      })
      .catch(() => {})
  }, [])

  // Check for conflicts across the next 4 weeks whenever recurring settings change
  useEffect(() => {
    if (!isRecurring || recurDays.length === 0) { setRecurConflicts([]); return }
    setCheckingConflicts(true)
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 28 * 86400_000).toISOString()
    fetch(`/api/schedule?from=${from}&to=${to}&channel=${block.channelId}`)
      .then(r => r.json())
      .then(blocks => {
        // Parse start time-of-day from the block (may be HH:MM:SS or ISO)
        const ref = block.computedStart || block.startTime
        let h = 0, m = 0, s = 0
        if (/^\d{2}:\d{2}:\d{2}$/.test(ref)) {
          ;[h, m, s] = ref.split(':').map(Number)
        } else {
          const d = new Date(ref)
          h = d.getUTCHours(); m = d.getUTCMinutes(); s = d.getUTCSeconds()
        }
        const conflicts = []
        for (let i = 1; i <= 28; i++) {
          const day = new Date(Date.now() + i * 86400_000)
          if (!recurDays.includes(day.getUTCDay())) continue
          const instStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, s)
          const instEnd = instStart + block.durationSeconds * 1000
          const hits = blocks.filter(b => {
            if (b.id === block.id) return false
            if (block.groupId && b.groupId === block.groupId) return false
            const bS = new Date(b.computedStart).getTime()
            const bE = bS + b.durationSeconds * 1000
            return instStart < bE && instEnd > bS
          })
          if (hits.length > 0) {
            conflicts.push({ date: new Date(instStart), names: hits.map(b => b.showName || 'a block') })
          }
        }
        setRecurConflicts(conflicts)
      })
      .catch(() => {})
      .finally(() => setCheckingConflicts(false))
  }, [isRecurring, recurDays.join(',')])

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const toggleDay = (d) => setRecurDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])

  const save = () => {
    let startTime = block.startTime || block.computedStart
    if (isRecurring && !/^\d{2}:\d{2}:\d{2}$/.test(startTime)) {
      const d = new Date(startTime)
      startTime = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`
    }
    // Recurring shuffle blocks get a groupId so chain-link icon shows and group-delete works
    const isRecurringShufle = block.type === 'random' && isRecurring && recurDays.length > 0
    const groupId = isRecurringShufle
      ? (block.groupId || 'grp-' + Date.now())
      : block.groupId
    onSave({
      ...block,
      isRecurring,
      startTime,
      recurDays: JSON.stringify(recurDays),
      groupId: groupId || '',
      ...(isShowBlock ? { type: playOrder, seasonNumber: selectedSeason } : {}),
    })
  }

  const startTime = new Date(block.computedStart || block.startTime)

  const btnActive = { background: 'rgba(var(--accent-rgb),0.35)', border: '1px solid rgba(var(--accent-rgb),0.6)', color: 'var(--accent)' }
  const btnInactive = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.4)' }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="rounded-lg p-6 w-96 flex flex-col gap-4 overflow-y-auto"
        style={{ background: '#1e2a3a', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '4px 4px 0 0 rgba(0,0,0,0.8)', maxHeight: 'min(90vh, 540px)' }}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display font-bold text-white">{block.showName || 'Block'}</h3>
            {block.episodeName && <p className="text-white/50 text-sm">{block.episodeName}</p>}
            <p className="text-white/30 text-xs font-mono mt-1">
              {startTime.toLocaleString()} · {Math.round(block.durationSeconds / 60)}min
            </p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Season filter — for all shuffle blocks; always show if a specific season is selected */}
        {isShowBlock && (availableSeasons.length > 0 || selectedSeason > 0) && (
          <div>
            <p className="text-white/50 text-xs mb-2">Season:</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedSeason(0)}
                className="px-3 py-1.5 rounded text-xs font-semibold transition-all"
                style={selectedSeason === 0 ? btnActive : btnInactive}
              >
                All seasons
              </button>
              {availableSeasons.map(s => (
                <button
                  key={s}
                  onClick={() => setSelectedSeason(s)}
                  className="px-3 py-1.5 rounded text-xs font-semibold transition-all"
                  style={selectedSeason === s ? btnActive : btnInactive}
                >
                  S{s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Repeat weekly — hidden for sequential/in-order blocks and grouped episode series */}
        {block.type !== 'sequential' && !(block.type === 'episode' && block.groupId) && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)}
              className="accent-app-purple w-4 h-4" />
            <span className="text-white text-sm">Repeat weekly</span>
          </label>
        </div>
        )}

        {block.type !== 'sequential' && !(block.type === 'episode' && block.groupId) && isRecurring && (
          <div>
            <p className="text-white/50 text-xs mb-2">Repeat on:</p>
            <div className="flex gap-2">
              {dayNames.map((d, i) => (
                <button key={i} onClick={() => toggleDay(i)}
                  className="w-9 h-9 rounded text-xs font-semibold transition-all"
                  style={{
                    background: recurDays.includes(i) ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(255,255,255,0.05)',
                    color: recurDays.includes(i) ? 'var(--accent)' : 'rgba(255,255,255,0.4)',
                    border: recurDays.includes(i) ? '1px solid rgba(var(--accent-rgb),0.6)' : '1px solid rgba(255,255,255,0.1)',
                  }}>
                  {d}
                </button>
              ))}
            </div>

            {/* Recurring conflict warnings — wrapper always rendered to prevent height jump */}
            <div style={{ minHeight: 20 }}>
            {checkingConflicts && (
              <p className="text-white/30 text-xs mt-2 flex items-center gap-1">
                <span className="w-3 h-3 border border-white/20 border-t-white/60 rounded-full animate-spin inline-block" />
                Checking conflicts…
              </p>
            )}
            {!checkingConflicts && recurConflicts.length > 0 && (
              <div className="mt-2 rounded p-2 text-xs" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                <p className="text-red-400 font-semibold mb-1 flex items-center gap-1">
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>warning</span>
                  {recurConflicts.length} conflict{recurConflicts.length > 1 ? 's' : ''} in the next 4 weeks
                </p>
                {recurConflicts.slice(0, 4).map((c, i) => (
                  <p key={i} className="text-red-300/70 truncate">
                    {c.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — {c.names.join(', ')}
                  </p>
                ))}
                {recurConflicts.length > 4 && <p className="text-red-400/40 mt-0.5">+{recurConflicts.length - 4} more</p>}
              </div>
            )}
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-2">
          <button onClick={save} className="flex-1 py-2 rounded font-semibold text-sm text-white"
            style={{ background: 'rgba(var(--accent-rgb),0.4)', border: '1px solid rgba(var(--accent-rgb),0.6)' }}>
            Save
          </button>
          {!onDeleteGroup && (
            <button onClick={onDelete} className="px-4 py-2 rounded font-semibold text-sm text-red-400 hover:bg-red-900/20"
              style={{ border: '1px solid rgba(239,68,68,0.3)' }}>
              Delete
            </button>
          )}
        </div>
        {onDeleteGroup && (
          <div className="flex gap-2">
            <button onClick={onDeleteIndividual}
              className="flex-1 py-2 rounded text-sm text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-900/10 transition-colors"
              style={{ border: '1px solid rgba(250,204,21,0.2)' }}>
              Skip today (push back)
            </button>
            <button onClick={onDeleteGroup}
              className="flex-1 py-2 rounded text-sm text-red-400/70 hover:text-red-400 hover:bg-red-900/15 transition-colors"
              style={{ border: '1px solid rgba(239,68,68,0.3)' }}>
              Delete entire series
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function startOfToday() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d
}
function startOfDay(d) {
  const r = new Date(d); r.setHours(0, 0, 0, 0); return r
}
