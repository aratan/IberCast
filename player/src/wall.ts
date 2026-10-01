/**
 * WallView: the public landing page.
 *
 * Layout borrows from two places on purpose — a Netflix-style cinematic hero
 * plus horizontally scrollable shelves with hover arrows, and a YouTube-style
 * sticky top bar with search. Cards open WatchView (see ./player-modal).
 *
 * Videos are grouped by channel (data/videos.json `channelId`): each channel
 * known to the API gets its own rail; videos with an empty/unknown
 * channelId land in the "IberCast" (default) rail.
 */
import { openPlayer, closePlayer, getProgress, type PlayerVideo } from './player-modal'
import { gatewayBase } from './gateway'

interface WallVideo extends PlayerVideo {
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

const ICON_PLAY = 'M8 5v14l11-7z'
const ICON_CHEVRON = 'M8.6 5.4 7.2 4 1.2 10l6 6 1.4-1.4L4 10z'
const ICON_LOGO = 'M4 3.5v17l15-8.5z'
const ICON_SEARCH = 'M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z'
const ICON_ADMIN = 'M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5l-9-4zm0 10.5h7c-.5 4-3.2 7.4-7 8.4V11.5H5V6.3l7-3.1v8.3z'

function icon(path: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`
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

function thumbnailSrc(v: PlayerVideo): string {
  // The API returns a root-relative IPFS path (/ipfs/{cid}/thumb.jpg). The
  // gateway base is already CID-scoped (subdomain form), so only the file
  // name is appended — re-appending /ipfs/{cid} would build a bogus path.
  if (v.thumbnailUrl) {
    if (/^https?:\/\//i.test(v.thumbnailUrl)) return v.thumbnailUrl
    const file = v.thumbnailUrl.split('/').pop()
    if (!file) return ''
    return `${gatewayBase(v.cid)}/${file}`
  }
  if (v.cid) return `${gatewayBase(v.cid)}/thumb.jpg`
  return ''
}

export function WallView(rootEl: HTMLElement, apiBase: string): void {
  rootEl.innerHTML = ''

  // Internal links must carry ?api= so the target view keeps talking to the
  // same daemon instead of falling back to location.origin.
  const apiParam = apiBase && apiBase !== location.origin ? `&api=${encodeURIComponent(apiBase)}` : ''

  let allVideos: WallVideo[] = []
  let allLive: WallLive[] = []
  let channels: WallChannel[] = []
  let query = ''
  let currentWatchId: string | null = null

  /* ---------------------------------------------------------------
     Shell
     --------------------------------------------------------------- */

  rootEl.innerHTML = `
    <nav class="nav" id="wall-nav">
      <a class="nav-brand" href="#inicio">
        <span class="nav-mark">${icon(ICON_LOGO)}</span>
        <span>Iber<b>Cast</b></span>
      </a>
      <div class="nav-links" id="nav-links"></div>
      <div class="nav-search">
        ${icon(ICON_SEARCH)}
        <input type="search" id="wall-search" placeholder="Buscar títulos, canales…" aria-label="Buscar" />
      </div>
      <a class="nav-icon-btn" href="?mode=admin${apiParam}" title="Panel de administración">${icon(ICON_ADMIN)}</a>
      <div class="nav-avatar" title="Invitado">IC</div>
    </nav>

    <section class="hero" id="hero">
      <div class="hero-bg"></div>
      <div class="hero-content">
        <span class="hero-badge">DESTACADO</span>
        <h2 class="hero-title" id="hero-title">Cargando catálogo…</h2>
        <div class="hero-meta" id="hero-meta"></div>
        <p class="hero-desc" id="hero-desc"></p>
        <div class="hero-actions">
          <button class="btn btn--play" id="hero-play">${icon(ICON_PLAY)}<span>Reproducir</span></button>
          <button class="btn btn--ghost" id="hero-info">${icon(ICON_ADMIN)}<span>Más info</span></button>
        </div>
      </div>
      <div class="hero-scroll-hint">Desplázate ↓</div>
    </section>

    <div class="rails" id="wall-rails"></div>
  `

  const nav = document.getElementById('wall-nav') as HTMLElement
  const railsEl = document.getElementById('wall-rails') as HTMLElement
  const hero = document.getElementById('hero') as HTMLElement
  const heroTitle = document.getElementById('hero-title') as HTMLElement
  const heroMeta = document.getElementById('hero-meta') as HTMLElement
  const heroDesc = document.getElementById('hero-desc') as HTMLElement
  const heroBg = hero.querySelector('.hero-bg') as HTMLElement
  const heroPlay = document.getElementById('hero-play') as HTMLButtonElement
  const heroInfo = document.getElementById('hero-info') as HTMLButtonElement
  const searchInput = document.getElementById('wall-search') as HTMLInputElement
  const navLinks = document.getElementById('nav-links') as HTMLElement

  window.addEventListener('scroll', () => {
    nav.classList.toggle('nav--solid', window.scrollY > 24)
  }, { passive: true })

  // Keeps ?q= in the URL as the user types so a filtered wall can be shared or
  // reloaded. replaceState avoids flooding the back button.
  function syncQueryParam(value: string): void {
    const url = new URL(location.href)
    if (value) url.searchParams.set('q', value)
    else url.searchParams.delete('q')
    history.replaceState(null, '', url)
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase()
    syncQueryParam(searchInput.value.trim())
    renderRails()
  })

  // Seed the search box from ?q= so tag links (and shared URLs) land on a
  // pre-filtered wall. Runs before the first renderRails() in loadVideos().
  const initialQuery = new URLSearchParams(location.search).get('q')
  if (initialQuery) {
    searchInput.value = initialQuery
    query = initialQuery.trim().toLowerCase()
  }

  /* ---------------------------------------------------------------
     Watch view routing (hash: #watch/<id>)
     --------------------------------------------------------------- */

  function openWatch(video: PlayerVideo): void {
    currentWatchId = video.id
    location.hash = `/watch/${encodeURIComponent(video.id)}`
    const related: WallVideo[] = [
      ...allVideos.filter((v) => v.id !== video.id),
      ...allLive
        .filter((s) => s.status === 'live' && s.hlsUrl)
        .map<WallVideo>((s) => ({
          id: s.id,
          title: s.title,
          cid: '',
          hlsUrl: s.hlsUrl!,
          duration: 0,
          channelId: s.channelId,
          channelName: channelName(s.channelId)
        }))
    ]
    openPlayer({ ...video, channelName: video.channelName || channelName(video.channelId) }, {
      related,
      onBack: () => {
        if (location.hash.includes('/watch/')) history.back()
        else closePlayer()
      }
    })
  }

  function syncWithHash(): void {
    const match = /^#\/watch\/(.+)$/.exec(location.hash)
    const id = match ? decodeURIComponent(match[1]!) : null
    if (id) {
      if (id === currentWatchId) return
      const video =
        allVideos.find((v) => v.id === id) ??
        allLive
          .filter((s) => s.status === 'live' && s.hlsUrl)
          .map<WallVideo>((s) => ({
            id: s.id, title: s.title, cid: '', hlsUrl: s.hlsUrl!, duration: 0, channelId: s.channelId
          }))
          .find((v) => v.id === id)
      if (video) openWatch(video)
    } else if (currentWatchId) {
      currentWatchId = null
      closePlayer()
    }
  }
  window.addEventListener('hashchange', syncWithHash)

  /* ---------------------------------------------------------------
     Data
     --------------------------------------------------------------- */

  async function loadChannels(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/channels`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: WallChannel[] = await res.json()
      channels = Array.isArray(data) && data.length > 0 ? data : [{ id: 'default', name: 'IberCast' }]
    } catch {
      channels = [{ id: 'default', name: 'IberCast' }]
    }
    renderNavLinks()
    renderHero()
  }

  async function loadVideos(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/videos`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) throw new Error(`respuesta no JSON (${ct})`)
      allVideos = (await res.json()) as WallVideo[]
    } catch (e) {
      // Dev fallback: the origin may be the Vite server while ibercastd runs
      // on :8585.
      allVideos = []
      if (typeof location !== 'undefined' && location.hostname === 'localhost') {
        try {
          const res2 = await fetch('http://localhost:8585/api/videos')
          if (res2.ok) allVideos = (await res2.json()) as WallVideo[]
        } catch { /* fall through to the error state */ }
      }
      if (allVideos.length === 0) {
        railsEl.innerHTML = `<div class="empty">
          <h3>No se pudo cargar el catálogo</h3>
          <p>${escapeHtml((e as Error).message)}</p>
          <p><a href="?mode=admin${apiParam}">Abrir el panel de administración</a></p>
        </div>`
        hero.classList.add('hero--empty')
        heroTitle.textContent = 'Catálogo no disponible'
        return
      }
    }
    allVideos = allVideos.map((v) => ({ ...v, channelName: v.channelName || channelName(v.channelId) }))
    renderHero()
    renderRails()
    syncWithHash()
  }

  async function loadLiveStreams(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/live`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: unknown = await res.json()
      allLive = Array.isArray(data) ? (data as WallLive[]) : []
    } catch {
      /* keep previous state; the wall stays usable without live */
    }
    renderRails()
  }

  function channelName(id?: string): string {
    if (!id) return 'IberCast'
    return channels.find((c) => c.id === id)?.name ?? id
  }

  /* ---------------------------------------------------------------
     Nav + hero
     --------------------------------------------------------------- */

  function renderNavLinks(): void {
    navLinks.innerHTML = [
      `<a class="nav-link active" href="#inicio">Inicio</a>`,
      ...channels.slice(0, 4).map((c) => `<a class="nav-link" href="#canal/${escapeHtml(c.id)}">${escapeHtml(c.name)}</a>`)
    ].join('')
  }

  function renderHero(): void {
    const featured = allVideos[0] ?? (allLive[0]
      ? { id: allLive[0].id, title: allLive[0].title, cid: '', hlsUrl: allLive[0].hlsUrl ?? '', duration: 0 }
      : null)

    if (!featured) {
      hero.classList.add('hero--empty')
      heroTitle.textContent = 'Sin contenido todavía'
      heroMeta.innerHTML = ''
      heroDesc.textContent = 'Sube vídeos desde el panel de administración para que aparezcan aquí.'
      heroPlay.disabled = true
      heroPlay.style.opacity = '.5'
      return
    }

    hero.classList.remove('hero--empty')
    heroPlay.disabled = false
    heroPlay.style.opacity = '1'

    const ts = thumbnailSrc(featured)
    if (ts) heroBg.style.backgroundImage = `url("${ts}")`

    heroTitle.textContent = featured.title
    const parts = [
      featured.duration ? `<span>${fmtDuration(featured.duration)}</span><span class="sep">•</span>` : '',
      `<span class="tag">P2P</span>`,
      `<span>${channelName(featured.channelId)}</span>`
    ]
    heroMeta.innerHTML = parts.filter(Boolean).join('')
    heroDesc.textContent = featured.duration
      ? 'Reproducido directamente desde tu navegador: cada espectador reparte fragmentos vía WebRTC, sin servidores centrales ni esperas de descarga.'
      : 'Emisión en directo reenviada por la red, sin intermediarios.'

    heroPlay.onclick = () => openWatch(featured)
    heroInfo.onclick = () => {
      railsEl.querySelector('.rail')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  /* ---------------------------------------------------------------
     Rails
     --------------------------------------------------------------- */

  function matchesQuery(v: PlayerVideo): boolean {
    if (!query) return true
    const haystack = `${v.title} ${v.channelName ?? channelName(v.channelId)}`.toLowerCase()
    return haystack.includes(query)
  }

  function progressOf(v: PlayerVideo): number {
    if (!v.duration) return 0
    const p = getProgress(v.id)
    if (p < 10 || p > v.duration - 25) return 0
    return Math.min(100, (p / v.duration) * 100)
  }

  function cardHtml(v: PlayerVideo, live = false): string {
    const progress = progressOf(v)
    const ts = thumbnailSrc(v)
    return `
      <button class="card ${live ? 'card--live' : ''}" data-id="${escapeHtml(v.id)}">
        <div class="card-art ${live || !v.duration ? 'card-art--live' : ''}">
          ${ts ? `<img src="${escapeHtml(ts)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
          <div class="card-shade"></div>
          <span class="card-play">${icon(ICON_PLAY)}</span>
          <div class="card-chips">
            ${live || !v.duration ? '<span class="chip chip--live">● EN DIRECTO</span>' : ''}
            ${v.qualities && v.qualities.length > 1 ? `<span class="chip chip--hd">${escapeHtml(v.qualities[v.qualities.length - 1]!.label)}</span>` : ''}
            ${!live && v.duration ? '<span class="chip chip--p2p">P2P</span>' : ''}
          </div>
          ${v.duration ? `<span class="card-time">${fmtDuration(v.duration)}</span>` : ''}
          ${progress > 0 ? `<span class="card-progress"><i style="width:${progress.toFixed(1)}%"></i></span>` : ''}
        </div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(v.title)}</div>
          <div class="card-sub">
            ${escapeHtml(v.channelName ?? channelName(v.channelId))}
            ${progress > 0 ? `<span class="dot"></span> ${fmtDuration((progress / 100) * v.duration)} vistos` : ''}
          </div>
        </div>
      </button>
    `
  }

  function railHtml(title: string, count: number, videos: PlayerVideo[], live = false): string {
    const cards = videos.map((v) => cardHtml(v, live)).join('')
    return `
      <section class="rail" data-rail>
        <div class="rail-header">
          <h3 class="rail-title">${live ? '<span class="live-dot"></span>' : ''}${escapeHtml(title)}</h3>
          <span class="rail-count">${count} ${count === 1 ? 'título' : 'títulos'}</span>
        </div>
        <div class="rail-viewport">
          <button class="rail-arrow rail-arrow--prev" hidden aria-label="Anterior">${icon(ICON_CHEVRON)}</button>
          <div class="rail-track" role="list">${cards}</div>
          <button class="rail-arrow rail-arrow--next" aria-label="Siguiente">${icon(ICON_CHEVRON)}</button>
        </div>
      </section>
    `
  }

  function skeletonRail(): string {
    const items = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('')
    return `
      <section class="rail">
        <div class="rail-header"><h3 class="rail-title">Cargando…</h3></div>
        <div class="rail-viewport"><div class="rail-track">${items}</div></div>
      </section>
    `
  }

  function syncArrows(
    track: HTMLElement,
    prev: HTMLButtonElement | null,
    next: HTMLButtonElement | null
  ): void {
    if (prev) prev.hidden = track.scrollLeft < 8
    if (next) next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8
  }

  // bindRails runs again on every live-streams poll, so resize listeners are
  // collected here and refreshed once per render instead of stacking up.
  const arrowTargets: Array<[HTMLElement, HTMLButtonElement, HTMLButtonElement]> = []
  const onWindowResize = (): void => {
    for (const [track, prev, next] of arrowTargets) syncArrows(track, prev, next)
  }
  window.addEventListener('resize', onWindowResize)

  function bindRails(): void {
    arrowTargets.length = 0
    railsEl.querySelectorAll<HTMLElement>('.rail').forEach((rail) => {
      const track = rail.querySelector('.rail-track') as HTMLElement
      if (!track) return
      const prev = rail.querySelector<HTMLButtonElement>('.rail-arrow--prev')
      const next = rail.querySelector<HTMLButtonElement>('.rail-arrow--next')
      // The search-results rail is a flat grid with no arrows, so both may be
      // absent — arrow wiring is skipped in that case, but cards still bind.
      track.addEventListener('scroll', () => syncArrows(track, prev, next), { passive: true })

      if (prev && next) {
        const step = (): number => Math.max(track.clientWidth * 0.85, 240)
        prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }))
        next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }))
        arrowTargets.push([track, prev, next])
        syncArrows(track, prev, next)
      }

      track.querySelectorAll<HTMLElement>('.card').forEach((card) => {
        const id = card.dataset.id!
        const video =
          allVideos.find((v) => v.id === id) ??
          allLive
            .filter((s) => s.hlsUrl)
            .map<WallVideo>((s) => ({
              id: s.id, title: s.title, cid: '', hlsUrl: s.hlsUrl!, duration: 0, channelId: s.channelId
            }))
            .find((v) => v.id === id)
        if (!video) return
        if (!video.channelName) video.channelName = channelName(video.channelId)
        card.addEventListener('click', () => openWatch(video))
      })
    })
  }

  function renderRails(): void {
    if (allVideos.length === 0 && allLive.length === 0) {
      if (!query) {
        railsEl.innerHTML = skeletonRail()
        return
      }
    }

    const liveNow = allLive.filter((s) => s.status === 'live' && s.hlsUrl)
    const sections: string[] = []

    // Search keeps the live card and the channels that hold videos visible, so
    // a query matching no title (e.g. "webrtc") is never a dead end.
    if (query) {
      const matches = [
        ...allVideos.filter(matchesQuery),
        ...liveNow.filter((s) => s.title.toLowerCase().includes(query)).map<PlayerVideo>((s) => ({
          id: s.id, title: s.title, cid: '', hlsUrl: s.hlsUrl!, duration: 0, channelId: s.channelId
        }))
      ]

      const parts: string[] = []

      if (matches.length > 0) {
        const cards = matches.map((v) => cardHtml(v, !v.duration)).join('')
        parts.push(`
        <section class="rail">
          <div class="rail-header">
            <h3 class="rail-title">Resultados</h3>
            <span class="rail-count">${matches.length} ${matches.length === 1 ? 'título' : 'títulos'}</span>
          </div>
          <div class="rail-viewport">
            <button class="rail-arrow rail-arrow--prev" hidden aria-label="Anterior">${icon(ICON_CHEVRON)}</button>
            <div class="rail-track" role="list">${cards}</div>
            <button class="rail-arrow rail-arrow--next" aria-label="Siguiente">${icon(ICON_CHEVRON)}</button>
          </div>
        </section>`)
      }

      // The live stream stays listed even when its title misses the query.
      const liveCards = liveNow.map<PlayerVideo>((s) => ({
        id: s.id, title: s.title, cid: '', hlsUrl: s.hlsUrl!, duration: 0,
        channelId: s.channelId, channelName: channelName(s.channelId)
      }))
      if (liveCards.length > 0) {
        parts.push(railHtml('En directo', liveCards.length, liveCards, true))
      }

      // Channels that actually have videos, same grouping as the default view.
      for (const channel of channels) {
        const list = allVideos.filter((v) => (v.channelId || 'default') === channel.id)
        if (list.length === 0) continue
        parts.push(railHtml(channel.name, list.length, list))
      }

      const known = new Set(channels.map((c) => c.id))
      const orphans = allVideos.filter((v) => !known.has(v.channelId || 'default'))
      if (orphans.length > 0) parts.push(railHtml('Otros títulos', orphans.length, orphans))

      if (parts.length === 0) {
        railsEl.innerHTML = `<div class="empty"><h3>Sin resultados</h3><p>Nada coincide con “${escapeHtml(searchInput.value)}”.</p></div>`
        return
      }
      railsEl.innerHTML = parts.join('')
      bindRails()
      return
    }

    // Continue watching: anything partially seen.
    const continueWatching = allVideos.filter((v) => progressOf(v) > 0).slice(0, 12)
    if (continueWatching.length > 0) {
      sections.push(railHtml('Continuar viendo', continueWatching.length, continueWatching))
    }
    if (liveNow.length > 0) {
      const items = liveNow.map<PlayerVideo>((s) => ({
        id: s.id, title: s.title, cid: '', hlsUrl: s.hlsUrl!, duration: 0,
        channelId: s.channelId, channelName: channelName(s.channelId)
      }))
      sections.push(railHtml('En directo', items.length, items, true))
    }

    for (const channel of channels) {
      const list = allVideos.filter((v) => (v.channelId || 'default') === channel.id)
      if (list.length === 0) continue
      sections.push(railHtml(channel.name, list.length, list))
    }

    // Videos whose channel isn't in the API response still need a home.
    const known = new Set(channels.map((c) => c.id))
    const orphans = allVideos.filter((v) => !known.has(v.channelId || 'default'))
    if (orphans.length > 0) sections.push(railHtml('Otros títulos', orphans.length, orphans))

    railsEl.innerHTML = sections.length > 0
      ? sections.join('')
      : `<div class="empty">
          <h3>Aún no hay nada que ver</h3>
          <p>Sube vídeos o crea un directo desde el <a href="?mode=admin${apiParam}">panel de administración</a>.</p>
        </div>`
    bindRails()
  }

  /* ---------------------------------------------------------------
     Boot
     --------------------------------------------------------------- */

  renderRails() // skeletons
  loadChannels()
  void loadVideos()
  void loadLiveStreams()
  setInterval(() => { void loadLiveStreams() }, 10_000)
}
