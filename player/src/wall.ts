/**
 * WallView: Netflix/YouTube-style video wall with hero + responsive grid.
 * Public-facing — no auth required.
 */
import { openPlayer } from './player-modal'
import { gatewayBase } from './gateway'

interface WallVideo {
  id: string
  title: string
  cid: string
  hlsUrl: string
  duration: number
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

  // Section header
  const sectionHeader = document.createElement('div')
  sectionHeader.className = 'wall-section-header'
  sectionHeader.innerHTML = `<h3>Todos los videos</h3><span class="wall-count" id="wall-count"></span>`
  rootEl.appendChild(sectionHeader)

  // Video grid
  const grid = document.createElement('div')
  grid.className = 'wall-grid'
  grid.id = 'wall-grid'
  rootEl.appendChild(grid)

  // Loading state
  grid.innerHTML = `<div class="wall-loading">Cargando videos…</div>`

  let allVideos: WallVideo[] = []

  async function loadVideos(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/videos`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) throw new Error(`not a JSON response (${ct})`)
      allVideos = await res.json()
      renderGrid(allVideos)
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
            renderGrid(allVideos)
            updateHero(allVideos)
            return
          }
        } catch { /* keep original error */ }
      }
      grid.innerHTML = `<div class="wall-empty">No se pudieron cargar los videos: ${(e as Error).message}</div>`
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

  function renderGrid(videos: WallVideo[]): void {
    if (videos.length === 0) {
      grid.innerHTML = `<div class="wall-empty">No hay videos disponibles. Sube contenido desde el <a href="?mode=admin">panel de administración</a>.</div>`
      return
    }

    const countEl = document.getElementById('wall-count')
    if (countEl) countEl.textContent = `${videos.length} videos`

    grid.innerHTML = videos
      .map(
        (v) => `
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
      )
      .join('')

    // Click handlers
    grid.querySelectorAll('.wall-card').forEach((card) => {
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

  // --- Live section (refreshed every 10s) ---
  async function loadLiveStreams(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/live`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: unknown = await res.json()
      const all: WallLive[] = Array.isArray(data) ? data : []
      renderLiveSection(all.filter((s) => s.status === 'live'))
    } catch {
      /* keep previous state; wall stays usable without live */
    }
  }

  function renderLiveSection(live: WallLive[]): void {
    const section = document.getElementById('wall-live-section')
    if (!section) return
    if (live.length === 0) {
      section.style.display = 'none'
      section.innerHTML = ''
      return
    }

    section.style.display = 'block'
    section.innerHTML = `
      <div class="wall-section-header">
        <h3><span class="wall-live-dot"></span> En directo</h3>
        <span class="wall-count">${live.length} en emisión</span>
      </div>
      <div class="wall-grid wall-grid--live">
        ${live
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
              <div class="wall-card-sub">${s.channelId ? escapeHtml(s.channelId) : 'en directo'}</div>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `

    section.querySelectorAll('.wall-card').forEach((card) => {
      const id = (card as HTMLElement).dataset.liveId!
      const stream = live.find((s) => s.id === id)
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

  loadVideos()
  loadLiveStreams()
  setInterval(loadLiveStreams, 10000)
}
