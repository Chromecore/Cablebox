import { useState, useEffect } from 'react'

export default function LibraryBrowser({ onDragStart }) {
  const [tab, setTab] = useState('shows')

  // Shows state
  const [shows, setShows] = useState([])
  const [expanded, setExpanded] = useState({})
  const [expandedSeasons, setExpandedSeasons] = useState({})
  const [episodes, setEpisodes] = useState({})
  const [showsLoading, setShowsLoading] = useState(true)
  const [showsError, setShowsError] = useState('')

  // Movies state
  const [movies, setMovies] = useState([])
  const [moviesLoading, setMoviesLoading] = useState(false)
  const [moviesLoaded, setMoviesLoaded] = useState(false)
  const [moviesError, setMoviesError] = useState('')

  // Videos folder browser state
  const [videoPath, setVideoPath] = useState([]) // [{id, name}] breadcrumb
  const [videoItems, setVideoItems] = useState([])
  const [videosLoading, setVideosLoading] = useState(false)
  const [videosError, setVideosError] = useState('')

  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/library/shows')
      .then(r => r.json())
      .then(data => { setShows(data); setShowsLoading(false) })
      .catch(() => { setShowsError('Could not load library. Check Jellyfin settings.'); setShowsLoading(false) })
  }, [])

  const loadMovies = () => {
    if (moviesLoaded || moviesLoading) return
    setMoviesLoading(true)
    fetch('/api/library/movies')
      .then(r => r.json())
      .then(data => { setMovies(data); setMoviesLoaded(true); setMoviesLoading(false) })
      .catch(() => { setMoviesError('Could not load movies.'); setMoviesLoading(false) })
  }

  const fetchVideoFolder = (parentId) => {
    setVideosLoading(true)
    setVideosError('')
    fetch(`/api/library/videos/browse?parentId=${parentId}`)
      .then(r => r.json())
      .then(data => { setVideoItems(data); setVideosLoading(false) })
      .catch(() => { setVideosError('Could not load videos.'); setVideosLoading(false) })
  }

  const enterFolder = (item) => {
    setVideoPath(p => [...p, { id: item.Id, name: item.Name }])
    fetchVideoFolder(item.Id)
  }

  const navigateToBreadcrumb = (idx) => {
    // idx === -1 means root
    const newPath = videoPath.slice(0, idx + 1)
    setVideoPath(newPath)
    const parentId = newPath.length > 0 ? newPath[newPath.length - 1].id : ''
    fetchVideoFolder(parentId)
  }

  const switchTab = (t) => {
    setTab(t)
    setSearch('')
    if (t === 'movies') loadMovies()
    if (t === 'videos') {
      setVideoPath([])
      fetchVideoFolder('')
    }
  }

  const toggleShow = async (show) => {
    const id = show.Id
    if (expanded[id]) { setExpanded(e => ({ ...e, [id]: false })); return }
    setExpanded(e => ({ ...e, [id]: true }))
    if (!episodes[id]) {
      const res = await fetch(`/api/library/shows/${id}/episodes`)
      const data = await res.json()
      setEpisodes(e => ({ ...e, [id]: data }))
    }
  }

  const toggleSeason = (showId, seasonNum) => {
    const key = `${showId}-${seasonNum}`
    setExpandedSeasons(e => ({ ...e, [key]: !e[key] }))
  }

  const seasonsByShow = (showId) => {
    const eps = episodes[showId] || []
    const map = {}
    for (const ep of eps) {
      const s = ep.ParentIndexNumber || 0
      if (!map[s]) map[s] = []
      map[s].push(ep)
    }
    return Object.entries(map)
      .map(([sNum, eps]) => ({ seasonNum: parseInt(sNum), eps }))
      .sort((a, b) => a.seasonNum - b.seasonNum)
  }

  const filteredShows = shows.filter(s =>
    !search || s.Name.toLowerCase().includes(search.toLowerCase())
  )
  const filteredMovies = movies.filter(m =>
    !search || m.Name.toLowerCase().includes(search.toLowerCase())
  )
  const filteredVideoItems = videoItems.filter(v =>
    !search || v.Name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full">
      {/* Tab switcher */}
      <div className="flex border-b border-white/10 flex-shrink-0">
        {['shows', 'movies', 'videos'].map(t => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className="flex-1 py-2 text-xs font-semibold font-display uppercase tracking-wide transition-colors"
            style={{
              color: tab === t ? 'var(--accent)' : 'rgba(255,255,255,0.35)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="p-3 border-b border-white/10 flex-shrink-0">
        <input
          type="text"
          placeholder={tab === 'shows' ? 'Search shows…' : tab === 'movies' ? 'Search movies…' : 'Search videos…'}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-app-purple"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Shows tab */}
        {tab === 'shows' && (
          <>
            {showsLoading && (
              <div className="flex items-center justify-center h-32 text-white/30 text-sm">
                <div className="w-5 h-5 border-2 border-white/20 border-t-app-purple rounded-full animate-spin mr-2" />
                Loading library...
              </div>
            )}
            {showsError && <div className="p-4 text-red-400 text-xs">{showsError}</div>}
            {!showsLoading && !showsError && filteredShows.map(show => (
              <div key={show.Id}>
                {/* Show row */}
                <div
                  className="flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 border-b border-white/5 cursor-grab active:cursor-grabbing select-none"
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation()
                    const data = { type: 'random', showId: show.Id, showName: show.Name, durationSeconds: 0 }
                    e.dataTransfer.setData('text/plain', JSON.stringify(data))
                    onDragStart?.(data)
                  }}
                  onClick={() => toggleShow(show)}
                >
                  {show.thumbUrl ? (
                    <img src={show.thumbUrl} alt="" className="w-8 h-10 object-cover rounded flex-shrink-0 opacity-80" />
                  ) : (
                    <div className="w-8 h-10 flex items-center justify-center rounded flex-shrink-0 bg-white/5">
                      <span className="material-symbols-outlined text-white/20 text-sm">tv</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-xs font-semibold truncate">{show.Name}</div>
                    <div className="text-white/30 text-xs">All seasons</div>
                  </div>
                  <span
                    className="material-symbols-outlined text-white/30 text-sm transition-transform flex-shrink-0"
                    style={{ transform: expanded[show.Id] ? 'rotate(90deg)' : '' }}
                  >
                    chevron_right
                  </span>
                </div>

                {/* Seasons + episodes */}
                {expanded[show.Id] && (
                  <div>
                    {!episodes[show.Id] ? (
                      <div className="py-3 px-6 text-white/30 text-xs">Loading…</div>
                    ) : (
                      seasonsByShow(show.Id).map(({ seasonNum, eps }) => {
                        const seasonKey = `${show.Id}-${seasonNum}`
                        const isSeasonExpanded = expandedSeasons[seasonKey]
                        const seasonLabel = seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`

                        return (
                          <div key={seasonNum}>
                            {/* Season row */}
                            <div
                              className="flex items-center gap-2 pl-4 pr-3 py-2 hover:bg-white/5 border-b border-white/5 cursor-grab active:cursor-grabbing select-none"
                              draggable
                              onDragStart={(e) => {
                                e.stopPropagation()
                                const data = {
                                  type: 'random',
                                  showId: show.Id,
                                  showName: show.Name,
                                  seasonNumber: seasonNum,
                                  durationSeconds: 0,
                                }
                                e.dataTransfer.setData('text/plain', JSON.stringify(data))
                                onDragStart?.(data)
                              }}
                              onClick={() => toggleSeason(show.Id, seasonNum)}
                            >
                              <span className="material-symbols-outlined text-white/30 text-sm flex-shrink-0">layers</span>
                              <div className="flex-1 min-w-0">
                                <div className="text-white/80 text-xs font-semibold truncate">{seasonLabel}</div>
                                <div className="text-white/30 text-xs">{eps.length} episodes</div>
                              </div>
                              <span
                                className="material-symbols-outlined text-white/20 text-sm transition-transform flex-shrink-0"
                                style={{ transform: isSeasonExpanded ? 'rotate(90deg)' : '' }}
                              >
                                chevron_right
                              </span>
                            </div>

                            {/* Individual episodes */}
                            {isSeasonExpanded && (
                              <div className="bg-black/20">
                                {eps.map(ep => (
                                  <div
                                    key={ep.Id}
                                    className="flex items-center gap-2 pl-10 pr-3 py-2 cursor-grab hover:bg-white/5 active:cursor-grabbing border-b border-white/5"
                                    draggable
                                    onDragStart={(e) => {
                                      e.stopPropagation()
                                      const dur = Math.floor((ep.RunTimeTicks || 0) / 10_000_000)
                                      const data = {
                                        type: 'episode',
                                        jellyfinItemId: ep.Id,
                                        showId: ep.SeriesId,
                                        showName: ep.SeriesName || show.Name,
                                        episodeName: ep.Name,
                                        seasonNumber: ep.ParentIndexNumber || 0,
                                        episodeNumber: ep.IndexNumber || 0,
                                        durationSeconds: dur || 1800,
                                      }
                                      e.dataTransfer.setData('text/plain', JSON.stringify(data))
                                      onDragStart?.(data)
                                    }}
                                  >
                                    <span className="material-symbols-outlined text-white/20 text-xs">drag_indicator</span>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-white/70 text-xs truncate">{ep.Name}</div>
                                      <div className="text-white/30 text-xs font-mono">
                                        S{String(ep.ParentIndexNumber || 0).padStart(2,'0')}E{String(ep.IndexNumber || 0).padStart(2,'0')}
                                        {ep.RunTimeTicks ? ` · ${Math.round(ep.RunTimeTicks / 10_000_000 / 60)}m` : ''}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {/* Videos tab — folder browser */}
        {tab === 'videos' && (
          <>
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-white/10 flex-shrink-0 flex-wrap">
              <button
                onClick={() => navigateToBreadcrumb(-1)}
                className="text-xs font-mono text-app-purple hover:text-white transition-colors"
              >
                Videos
              </button>
              {videoPath.map((crumb, idx) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  <span className="text-white/20 text-xs">/</span>
                  <button
                    onClick={() => navigateToBreadcrumb(idx)}
                    className="text-xs font-mono text-white/50 hover:text-white transition-colors truncate max-w-[80px]"
                    title={crumb.name}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>

            {videosLoading && (
              <div className="flex items-center justify-center h-32 text-white/30 text-sm">
                <div className="w-5 h-5 border-2 border-white/20 border-t-app-purple rounded-full animate-spin mr-2" />
                Loading...
              </div>
            )}
            {videosError && <div className="p-4 text-red-400 text-xs">{videosError}</div>}
            {!videosLoading && !videosError && filteredVideoItems.map(item => {
              const isFolder = ['Folder', 'CollectionFolder', 'UserView', 'BoxSet'].includes(item.Type)
              const dur = Math.floor((item.RunTimeTicks || 0) / 10_000_000) || 3600

              if (isFolder) {
                return (
                  <div
                    key={item.Id}
                    className="flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 border-b border-white/5 cursor-pointer select-none"
                    onClick={() => enterFolder(item)}
                  >
                    <span className="material-symbols-outlined text-app-purple text-base flex-shrink-0">folder</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-xs font-semibold truncate">{item.Name}</div>
                    </div>
                    <span className="material-symbols-outlined text-white/20 text-sm flex-shrink-0">chevron_right</span>
                  </div>
                )
              }

              return (
                <div
                  key={item.Id}
                  className="flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 border-b border-white/5 cursor-grab active:cursor-grabbing select-none"
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation()
                    const data = {
                      type: 'episode',
                      jellyfinItemId: item.Id,
                      showId: item.Id,
                      showName: item.Name,
                      episodeName: '',
                      seasonNumber: 0,
                      episodeNumber: 0,
                      durationSeconds: dur,
                    }
                    e.dataTransfer.setData('text/plain', JSON.stringify(data))
                    onDragStart?.(data)
                  }}
                >
                  {item.thumbUrl ? (
                    <img src={item.thumbUrl} alt="" className="w-8 h-10 object-cover rounded flex-shrink-0 opacity-80" />
                  ) : (
                    <div className="w-8 h-10 flex items-center justify-center rounded flex-shrink-0 bg-white/5">
                      <span className="material-symbols-outlined text-white/20 text-sm">videocam</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-xs font-semibold truncate">{item.Name}</div>
                    {item.RunTimeTicks > 0 && (
                      <div className="text-white/30 text-xs font-mono">{Math.round(dur / 60)}m</div>
                    )}
                  </div>
                  <span className="material-symbols-outlined text-white/20 text-xs flex-shrink-0">drag_indicator</span>
                </div>
              )
            })}
          </>
        )}

        {/* Movies tab */}
        {tab === 'movies' && (
          <>
            {moviesLoading && (
              <div className="flex items-center justify-center h-32 text-white/30 text-sm">
                <div className="w-5 h-5 border-2 border-white/20 border-t-app-purple rounded-full animate-spin mr-2" />
                Loading movies...
              </div>
            )}
            {moviesError && <div className="p-4 text-red-400 text-xs">{moviesError}</div>}
            {!moviesLoading && !moviesError && filteredMovies.map(movie => {
              const dur = Math.floor((movie.RunTimeTicks || 0) / 10_000_000) || 7200
              return (
                <div
                  key={movie.Id}
                  className="flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 border-b border-white/5 cursor-grab active:cursor-grabbing select-none"
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation()
                    const data = {
                      type: 'episode',
                      jellyfinItemId: movie.Id,
                      showId: movie.Id,
                      showName: movie.Name,
                      episodeName: '',
                      seasonNumber: 0,
                      episodeNumber: 0,
                      durationSeconds: dur,
                    }
                    e.dataTransfer.setData('text/plain', JSON.stringify(data))
                    onDragStart?.(data)
                  }}
                >
                  {movie.thumbUrl ? (
                    <img src={movie.thumbUrl} alt="" className="w-8 h-10 object-cover rounded flex-shrink-0 opacity-80" />
                  ) : (
                    <div className="w-8 h-10 flex items-center justify-center rounded flex-shrink-0 bg-white/5">
                      <span className="material-symbols-outlined text-white/20 text-sm">movie</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-xs font-semibold truncate">{movie.Name}</div>
                    <div className="text-white/30 text-xs font-mono">
                      {Math.round(dur / 60)}m
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-white/20 text-xs flex-shrink-0">drag_indicator</span>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
