/**
 * WallView: Netflix/YouTube-style video wall with hero + responsive grid.
 * Public-facing — no auth required.
 *
 * Videos are grouped by channel (data/videos.json `channelId`): each channel
 * known to the API gets its own section; videos with an empty/unknown
 * channelId land in the "IberCast" (default) section.
 */
import { openPlayer } from './player-modal'
import { gatewayBase } from './gateway'

interface WallVideo {
  id: string
  title: string
  cid: string
  hlsUrl: string
  duration: number
  channelId?: string
  thumbnailUrl?: string
  qualities?: Array<{ name: string; label: string; bitrate: number }>
}

interface WallLive {
  id: string
  channelId?: string
  title: string
  status: string
  streamKey?: string
  hlsUrl?: string
}

interface WallChannel {
  id: string
  name: string
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

function thumbnailSrc(v: WallVideo): string {
  if (v.thumbnailUrl) return v.thumbnailUrl
  if (v.cid) return `${gatewayBase(v.cid)}/thumb.jpg`
  return ''
}

export function WallView(rootEl: HTMLElement, apiBase: string): void {
  rootEl.innerHTML = ''

  // Hero section
  const hero = document.createElement('div')
  hero.className = 'wall-hero'
  hero.innerHTML = `
    <div class="wall-hero-bg"></div>
    <div class="wall-hero-content">
      <div class="wall-hero-badge">IBERCAST</div>
      <h2 class="wall-hero-title">Streaming P2P sobre IPFS</h2>
      <p class="wall-hero-desc">Cada espectador reparte fragmentos vía WebRTC — sin servidores centrales</p>
      <button class="wall-hero-cta" id="wall-hero-play">▶ Ver contenido</button>
    </div>
  `
  rootEl.appendChild(hero)

  // Live section (refreshed every 10s)
  const liveSection = document.createElement('div')
  liveSection.className = 'wall-live-section'
  liveSection.id = 'wall-live-section'
  liveSection.style.display = 'none'
  rootEl.appendChild(liveSection)

  // Channel filter tabs (populated from /api/channels)
  const filterBar = document.createElement('div')
  filterBar.className = 'wall-filter-bar'
  filterBar.id = 'wall-filter-bar'
  rootEl.appendChild(filterBar)

  // Sections container: one header + grid per channel
  const sections = document.createElement('div')
  sections.id = 'wall-sections'
  rootEl.appendChild(sections)

  let allVideos: WallVideo[] = []
  let channels: WallChannel[] = []
  let activeFilter = 'all'

  async function loadChannels(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/channels`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: WallChannel[] = await res.json()
      channels = Array.isArray(data) && data.length > 0
        ? data
        : [{ id: 'default', name: 'IberCast' }]
    } catch {
      channels = [{ id: 'default', name: 'IberCast' }, { id: 'peliculas', name: 'Películas' }, { id: 'noticias', name: 'Noticias' }]
    }
    renderFilterBar()
  }

  function renderFilterBar(): void {
    const bar = document.getElementById('wall-filter-bar')
    if (!bar) return
    const tabs: Array<{ id: string; name: string }> = [
      { id: 'all', name: 'Todos' },
      ...channels
    ]
    bar.innerHTML = tabs
      .map(
        (t) => `
      <button class="wall-filter ${activeFilter === t.id ? 'active' : ''}" data-channel="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>
    `
      )
      .join('')

    bar.querySelectorAll('.wall-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeFilter = (btn as HTMLElement).dataset.channel!
        renderFilterBar()
        renderSections()
        renderLiveSection(allLive.filter((s) => s.status === 'live'))
      })
    })
  }

  async function loadVideos(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/videos`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) throw new Error(`not a JSON response (${ct})`)
      allVideos = await res.json()
      renderSections()
      updateHero(allVideos)
    } catch (e) {
      // dev fallback: if the origin isn't the API (e.g. vite preview on :4173
      // while ibercastd runs on :8585), probe the local dev daemon.
      if (typeof location !== 'undefined' && location.hostname === 'localhost') {
        try {
          const dev = 'http://localhost:8585'
          const res2 = await fetch(`${dev}/api/videos`)
          if (res2.ok && (res2.headers.get('content-type') || '').includes('json')) {
            allVideos = await res2.json()
            renderSections()
            updateHero(allVideos)
            return
          }
        } catch { /* keep original error */ }
      }
      document.getElementById('wall-sections')!.innerHTML = `<div class="wall-empty wall-empty--page">No se pudieron cargar los videos: ${(e as Error).message}</div>`
    }
  }

  function updateHero(videos: WallVideo[]): void {
    if (videos.length === 0) {
      hero.classList.add('wall-hero--empty')
      return
    }
    // Pick first video as featured
    const featured = videos[0]
    const bg = hero.querySelector('.wall-hero-bg') as HTMLElement
    const ts = thumbnailSrc(featured)
    if (ts) bg.style.backgroundImage = `url(${ts})`

    const title = hero.querySelector('.wall-hero-title') as HTMLElement
    title.textContent = featured.title

    const desc = hero.querySelector('.wall-hero-desc') as HTMLElement
    desc.textContent = `${fmtDuration(featured.duration)} · ${featured.qualities?.length ?? 1} quality levels`

    const cta = hero.querySelector('#wall-hero-play') as HTMLButtonElement
    cta.onclick = () => openPlayer(featured)
  }

  /** Group videos by channelId in the order of /api/channels (default first). */
  function groupByChannel(videos: WallVideo[]): Array<{ channel: WallChannel; videos: WallVideo[] }> {
    const byId = new Map<string, WallVideo[]>()
    for (const v of videos) {
      const cid = v.channelId && channels.some((c) => c.id === v.channelId) ? v.channelId : 'default'
      const list = byId.get(cid) ?? []
      list.push(v)
      byId.set(cid, list)
    }
    const groups: Array<{ channel: WallChannel; videos: WallVideo[] }> = []
    for (const ch of channels) {
      const list = byId.get(ch.id)
      if (list && list.length > 0) groups.push({ channel: ch, videos: list })
    }
    return groups
  }

  function cardHtml(v: WallVideo): string {
    return `
      <div class="wall-card" data-id="${v.id}">
        <div class="wall-card-thumb">
          <img src="${thumbnailSrc(v)}" alt="" loading="lazy" onerror="this.style.display='none'" />
          <div class="wall-card-overlay">
            <button class="wall-card-play">▶</button>
          </div>
          <span class="wall-card-duration">${fmtDuration(v.duration)}</span>
          ${v.qualities && v.qualities.length > 1 ? `<span class="wall-card-quality">${v.qualities[0].label}</span>` : ''}
        </div>
        <div class="wall-card-info">
          <div class="wall-card-title">${escapeHtml(v.title)}</div>
        </div>
      </div>
    `
  }

  function bindCards(container: HTMLElement, videos: WallVideo[]): void {
    container.querySelectorAll('.wall-card').forEach((card) => {
      const id = (card as HTMLElement).dataset.id!
      const video = videos.find((v) => v.id === id)
      if (!video) return

      card.addEventListener('click', () => openPlayer(video))

      // Keyboard accessibility
      const cardEl = card as HTMLElement
      cardEl.tabIndex = 0
      cardEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openPlayer(video)
        }
      })
    })
  }

  function renderSections(): void {
    const root = document.getElementById('wall-sections')
    if (!root) return

    const visible = activeFilter === 'all' ? allVideos : allVideos.filter((v) => (v.channelId || 'default') === activeFilter)
    const countEl = document.getElementById('wall-count')

    if (allVideos.length === 0) {
      if (countEl) countEl.textContent = ''
      root.innerHTML = `<div class="wall-empty wall-empty--page">No hay videos disponibles. Sube contenido desde el <a href="?mode=admin">panel de administración</a>.</div>`
      return
    }

    if (countEl) countEl.textContent = `${visible.length} ${visible.length === 1 ? 'video' : 'videos'}`

    if (visible.length === 0) {
      const ch = channels.find((c) => c.id === activeFilter)
      root.innerHTML = `<div class="wall-empty wall-empty--page">Aún no hay videos en el canal ${escapeHtml(ch?.name ?? activeFilter)}.</div>`
      return
    }

    // Filtered view: single flat grid with all matching videos.
    if (activeFilter !== 'all') {
      root.innerHTML = `<div class="wall-grid">${visible.map(cardHtml).join('')}</div>`
      bindCards(root, visible)
      return
    }

    // "Todos": one section per channel that has videos.
    const groups = groupByChannel(allVideos)
    root.innerHTML = groups
      .map(
        (g) => `
      <div class="wall-section">
        <div class="wall-section-header">
          <h3>${escapeHtml(g.channel.name)}</h3>
          <span class="wall-count">${g.videos.length} ${g.videos.length === 1 ? 'video' : 'videos'}</span>
        </div>
        <div class="wall-grid">${g.videos.map(cardHtml).join('')}</div>
      </div>
    `
      )
      .join('')

    for (const g of groups) {
      const section = root.querySelector(`.wall-section:has(.wall-card[data-id="${g.videos[0].id}"])`)
      if (section) bindCards(section as HTMLElement, g.videos)
    }
  }

  // --- Live section (refreshed every 10s) ---
  let allLive: WallLive[] = []

  async function loadLiveStreams(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/live`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: unknown = await res.json()
      allLive = Array.isArray(data) ? data : []
      renderLiveSection(allLive.filter((s) => s.status === 'live'))
    } catch {
      /* keep previous state; wall stays usable without live */
    }
  }

  /** Channel display name from /api/channels; falls back to the raw id. */
  function channelName(id?: string): string {
    if (!id) return 'IberCast'
    return channels.find((c) => c.id === id)?.name ?? id
  }

  function renderLiveSection(live: WallLive[]): void {
    const section = document.getElementById('wall-live-section')
    if (!section) return
    // Respect the channel filter; hide the block when nothing matches.
    const visible = activeFilter === 'all' ? live : live.filter((s) => (s.channelId || 'default') === activeFilter)
    if (visible.length === 0) {
      section.style.display = 'none'
      section.innerHTML = ''
      return
    }

    section.style.display = 'block'
    section.innerHTML = `
      <div class="wall-section-header">
        <h3><span class="wall-live-dot"></span> En directo${activeFilter !== 'all' ? ` · ${escapeHtml(channelName(activeFilter))}` : ''}</h3>
        <span class="wall-count">${visible.length} en emisión</span>
      </div>
      <div class="wall-grid wall-grid--live">
        ${visible
          .map(
            (s) => `
          <div class="wall-card" data-live-id="${s.id}">
            <div class="wall-card-thumb wall-card-thumb--live">
              <div class="wall-card-overlay">
                <button class="wall-card-play">▶</button>
              </div>
              <span class="wall-card-live-badge">● LIVE</span>
            </div>
            <div class="wall-card-info">
              <div class="wall-card-title">${escapeHtml(s.title)}</div>
              <div class="wall-card-sub">${escapeHtml(channelName(s.channelId))}</div>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `

    section.querySelectorAll('.wall-card').forEach((card) => {
      const id = (card as HTMLElement).dataset.liveId!
      const stream = visible.find((s) => s.id === id)
      if (!stream || !stream.hlsUrl) return
      const open = () =>
        openPlayer({ id: stream.id, title: stream.title, cid: '', hlsUrl: stream.hlsUrl!, duration: 0 })
      card.addEventListener('click', open)
      const cardEl = card as HTMLElement
      cardEl.tabIndex = 0
      cardEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      })
    })
  }

  loadChannels()
  loadVideos()
  loadLiveStreams()
  setInterval(loadLiveStreams, 10000)
}
