/**
 * PlayerModal: fullscreen overlay video player with HLS.js + P2P.
 * Opens as a modal overlay — Escape or ✕ to close.
 */
import Hls, { Events, ErrorTypes } from 'hls.js'
import type { HlsConfig } from 'hls.js'
import { createIberLoader, newFetchStats, type FetchStats } from './loader'
import { createIberNode, type IberNode } from './node'
import { gatewayBase } from './gateway'

interface PlayerVideo {
  id: string
  title: string
  cid: string
  hlsUrl: string
  duration: number
  thumbnailUrl?: string
}

let activeHls: Hls | null = null
let activeNode: IberNode | null = null

function destroyActive(): void {
  if (activeHls) {
    activeHls.destroy()
    activeHls = null
  }
}

export function openPlayer(video: PlayerVideo): void {
  // Close any existing player
  closePlayer()

  // Gateway serves HLS manifests/segments — separate from the API base. Kubo
  // subdomain gateway avoids the path→subdomain redirect browsers block.
  const gateway = gatewayBase(video.cid)

  // Build overlay
  const overlay = document.createElement('div')
  overlay.className = 'player-overlay'
  overlay.id = 'player-overlay'

  overlay.innerHTML = `
    <div class="player-backdrop"></div>
    <div class="player-container">
      <div class="player-header">
        <span class="player-title">${escapeHtml(video.title)}</span>
        <button class="player-close" id="player-close-btn">✕</button>
      </div>
      <video id="player-video" controls playsinline autoplay></video>
      <div class="player-status" id="player-status">Cargando…</div>
    </div>
  `

  document.body.appendChild(overlay)
  document.body.classList.add('player-open')

  // Prevent background scroll
  document.body.style.overflow = 'hidden'

  const videoEl = document.getElementById('player-video') as HTMLVideoElement
  const statusEl = document.getElementById('player-status') as HTMLElement
  const closeBtn = document.getElementById('player-close-btn') as HTMLButtonElement

  // Close handlers
  closeBtn.addEventListener('click', closePlayer)
  overlay.querySelector('.player-backdrop')!.addEventListener('click', closePlayer)

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') closePlayer()
  }
  document.addEventListener('keydown', onKeydown)

  // Init P2P node (lazy, reuse)
  const stats: FetchStats = newFetchStats()

  function boot(): void {
    statusEl.textContent = 'Buscando manifiesto…'

    const isLive = !video.cid && !!video.hlsUrl && !video.duration
    // Live streams come straight from MediaMTX (same-origin proxy); no IPFS
    // gateway, no P2P. VOD uses the gateway master playlist.
    const masterUrl = isLive ? video.hlsUrl : `${gateway}/master.m3u8`

    const hlsConfig: Partial<HlsConfig> = {
      enableWorker: false,
      progressive: false
    }
    if (isLive) {
      // Live HLS (mpegts variant) needs short fragments: pull in real time.
      hlsConfig.liveSyncDurationCount = 3
      hlsConfig.liveMaxLatencyDurationCount = 6
    }
    if (!isLive) {
      hlsConfig.loader = createIberLoader(() => activeNode, video.cid, stats)
    }
    // NOTE: hls.js's default (xhr loader) is used for live. Do NOT set
    // loader: undefined explicitly — config merging treats it as "custom
    // loader is undefined" and throws TypeError(new undefined) internally.
    const hls = new Hls(hlsConfig)
    activeHls = hls

    hls.on(Events.MANIFEST_PARSED, (_e, data) => {
      statusEl.textContent = isLive
        ? `En directo · ${data.levels.length} calidad${data.levels.length > 1 || data.levels.length === 0 ? 'es' : ''}`
        : `Reproduciendo · ${data.levels.length} quality levels`
      statusEl.classList.add('player-status--ok')
    })

    hls.on(Events.ERROR, (_evt, data) => {
      if (!data.fatal) return
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        statusEl.textContent = `Error de red: ${data.details}. Reintentando…`
        hls.startLoad()
      } else {
        statusEl.textContent = `Error: ${data.details}`
        statusEl.classList.add('player-status--err')
      }
    })

    hls.loadSource(masterUrl)
    hls.attachMedia(videoEl)

    videoEl.play().catch(() => {})
  }

  // Boot P2P node in background only for VOD; never block playback on it.
  if (!video.cid && !activeNode) {
    createIberNode()
      .then((n) => {
        activeNode = n
      })
      .catch(() => {
        activeNode = null
      })
  }

  boot()

  // Store cleanup refs
  ;(overlay as any).__cleanup = () => {
    document.removeEventListener('keydown', onKeydown)
    destroyActive()
    document.body.classList.remove('player-open')
    document.body.style.overflow = ''
    overlay.remove()
  }
}

export function closePlayer(): void {
  const overlay = document.getElementById('player-overlay')
  if (overlay) {
    const cleanup = (overlay as any).__cleanup
    if (cleanup) cleanup()
    else {
      destroyActive()
      overlay.remove()
      document.body.classList.remove('player-open')
      document.body.style.overflow = ''
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}
