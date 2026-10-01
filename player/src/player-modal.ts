/**
 * WatchView: YouTube-style watch experience for IberCast.
 *
 * Opens as a full-screen page (back button, up-next sidebar, autoplay,
 * custom controls, keyboard shortcuts and a docked mini player) on top of
 * whatever view is mounted. HLS.js + the P2P loader keep VOD on IPFS while
 * live streams come straight from MediaMTX.
 */
import Hls, { Events, ErrorTypes } from 'hls.js'
import type { HlsConfig } from 'hls.js'
import { createIberLoader, newFetchStats, type FetchStats } from './loader'
import { createIberNode, type IberNode } from './node'
import { gatewayBase } from './gateway'

export interface PlayerVideo {
  id: string
  title: string
  cid: string
  hlsUrl: string
  duration: number
  thumbnailUrl?: string
  channelId?: string
  channelName?: string
  qualities?: Array<{ name: string; label: string; bitrate: number }>
}

interface QualityOption {
  label: string
  index: number
}

/* ---------------------------------------------------------------
   Resume progress (localStorage) — powers "Continuar viendo"
   --------------------------------------------------------------- */

const PROGRESS_KEY = 'ibercast:progress'

function readProgressMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeProgressMap(map: Record<string, number>): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(map))
  } catch {
    /* private mode / quota — progress is a nicety, never fatal */
  }
}

/** Seconds already watched for `id` (0 when unknown or finished). */
export function getProgress(id: string): number {
  return readProgressMap()[id] ?? 0
}

export function saveProgress(id: string, seconds: number): void {
  const map = readProgressMap()
  map[id] = Math.max(0, Math.floor(seconds))
  writeProgressMap(map)
}

export function clearProgress(id: string): void {
  const map = readProgressMap()
  delete map[id]
  writeProgressMap(map)
}

/* ---------------------------------------------------------------
   Helpers
   --------------------------------------------------------------- */

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

function thumbOf(v: PlayerVideo): string {
  // The API returns a root-relative IPFS path (/ipfs/{cid}/thumb.jpg). The
  // gateway base is already CID-scoped (subdomain form), so only the file name
  // is appended — re-appending /ipfs/{cid} would build a bogus path.
  if (v.thumbnailUrl) {
    if (/^https?:\/\//i.test(v.thumbnailUrl)) return v.thumbnailUrl
    const file = v.thumbnailUrl.split('/').pop()
    if (!file) return ''
    return `${gatewayBase(v.cid)}/${file}`
  }
  if (v.cid) return `${gatewayBase(v.cid)}/thumb.jpg`
  return ''
}

function icon(path: string, cls = 'icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`
}

/** Topic tags shown in the watch view. They link back to the wall search
 *  (`?mode=wall&q=…`), which seeds its search box from the `q` param. */
const WATCH_TAGS = ['ibercast', 'p2p', 'ipfs', 'webrtc', 'streaming'] as const

/** Carry `?api=` / `?gw=` through internal links so the target view keeps
 *  talking to the same daemon instead of falling back to `location.origin`. */
function apiQuery(): string {
  const p = new URLSearchParams(location.search)
  const parts: string[] = []
  for (const k of ['api', 'gw']) {
    const v = p.get(k)
    if (v) parts.push(`${k}=${encodeURIComponent(v)}`)
  }
  return parts.length ? `&${parts.join('&')}` : ''
}

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  back10: 'M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z',
  fwd10: 'M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5zM19 12a7 7 0 0 1-1 3.5l1.5 1.5A9 9 0 0 0 21 12a9 9 0 0 0-9-9v2a7 7 0 0 1 7 7zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 0 1-2.2 1.2v2.1c1.2-.3 2.3-.9 3.3-1.7l.9.9V19l3 3 1.3-1.3zM12 4 9.9 5.8 12 7.9z',
  fullscreen: 'M7 14H5v5h5v-2H7zm12-7h-2v2h2v3h2V7zm-2 12h5v-5h-2v3h-3zM7 7v3H4V7z',
  exitFullscreen: 'M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z',
  pip: 'M19 11h-8v6h8v-6zm4 8V4.98A2 2 0 0 0 21 3H3a2 2 0 0 0-2 1.98V19a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zm-2 .02H3V4.97h18v14.05z',
  thumbs: 'M18.8 5.6c-1.1 0-2.1.5-2.8 1.3L11 12v7c0 .6.4 1 1 1h5.3c.4 0 .8-.2 1-.6l2.7-6.4c.1-.3.2-.6.2-.9v-4.7c0-1-.8-1.8-1.8-1.8h-.6zM2 6.5C1.5 6.5 1 7 1 7.5V19c0 .6.5 1 1 1h3V6.5H2z',
  share: 'M18 16.1c-.8 0-1.5.3-2 .8l-7-4.1v-.8l7-4.1c.5.5 1.2.8 2 .8a3 3 0 1 0-3-3v.2L8 9.3a3 3 0 1 0 0 5.4l7.1 4.1v.2a3 3 0 1 0 3-2.9z',
  save: 'M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z',
  search: 'M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z',
  admin: 'M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5l-9-4zm0 10.5h7c-.5 4-3.2 7.4-7 8.4V11.5H5V6.3l7-3.1v8.3z',
  chevronLeft: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z',
  close: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z',
  next: 'M6 6l8.5 6L6 18zM16 6h2v12h-2z',
  logo: 'M4 3.5v17l15-8.5z'
} as const

let activeHls: Hls | null = null
let activeNode: IberNode | null = null

function destroyHls(): void {
  if (activeHls) {
    activeHls.destroy()
    activeHls = null
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

function toast(message: string): void {
  let el = document.getElementById('watch-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'watch-toast'
    el.className = 'toast'
    document.body.appendChild(el)
  }
  el.textContent = message
  el.classList.add('is-open')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el?.classList.remove('is-open'), 2200)
}

/* ---------------------------------------------------------------
   WatchView
   --------------------------------------------------------------- */

interface WatchOptions {
  /** Videos offered in the "A continuación" sidebar. */
  related?: PlayerVideo[]
  /** Called when the user leaves the watch view (defaults to history back). */
  onBack?: () => void
  /** Whether autoplay of the next item is enabled (persisted). */
  autoplay?: boolean
}

const AUTOPLAY_KEY = 'ibercast:autoplay'

function readAutoplay(): boolean {
  return localStorage.getItem(AUTOPLAY_KEY) !== '0'
}

function writeAutoplay(on: boolean): void {
  try {
    localStorage.setItem(AUTOPLAY_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function openPlayer(video: PlayerVideo, options: WatchOptions = {}): void {
  closePlayer()

  const related = (options.related ?? []).filter((v) => v.id !== video.id)
  const isLive = !video.cid && !!video.hlsUrl && !video.duration
  const channel = video.channelName || 'IberCast'
  const resumeAt = isLive ? 0 : Math.min(getProgress(video.id), Math.max(0, video.duration - 20))

  // --- DOM ---------------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'watch-overlay'
  root.id = 'watch-overlay'
  root.innerHTML = `
    <button class="watch-back" id="watch-back">
      ${icon(ICONS.chevronLeft)}<span>Volver</span>
    </button>

    <div class="watch-grid">
      <div class="watch-main">
        <div class="watch-stage" id="watch-stage">
          <video id="watch-video" playsinline autoplay></video>
          <div class="watch-hud">
            <span class="hud-pill" id="hud-source">…</span>
            <span class="hud-pill hud-pill--p2p" id="hud-p2p">0 peers</span>
          </div>
          <div class="watch-loading" id="watch-loading">
            <div class="spinner"></div>
            <span id="watch-loading-txt">Buscando manifiesto…</span>
          </div>
        </div>

        <div class="watch-controls">
          <button class="icon-btn" id="ctrl-play" title="Reproducir / pausar (k)">${icon(ICONS.play)}</button>
          <button class="icon-btn" id="ctrl-back" title="Retroceder 10 s (j)">${icon(ICONS.back10)}</button>
          <button class="icon-btn" id="ctrl-fwd" title="Avanzar 10 s (l)">${icon(ICONS.fwd10)}</button>
          <button class="icon-btn" id="ctrl-mute" title="Silenciar (m)">${icon(ICONS.volume)}</button>
          <input type="range" id="ctrl-volume" min="0" max="1" step="0.05" value="1" aria-label="Volumen" />
          <span class="hud-pill" id="ctrl-time">0:00 / ${escapeHtml(fmtTime(video.duration))}</span>
          <span class="watch-ctrl-spacer"></span>
          <select class="chip-btn" id="ctrl-quality" aria-label="Calidad" hidden></select>
          <button class="icon-btn" id="ctrl-pip" title="Picture in picture">${icon(ICONS.pip)}</button>
          <button class="icon-btn" id="ctrl-fs" title="Pantalla completa (f)">${icon(ICONS.fullscreen)}</button>
        </div>

        <h1 class="watch-title">${escapeHtml(video.title)}</h1>

        <div class="watch-meta-row">
          <div class="channel-chip">
            <div class="channel-avatar">${escapeHtml(channel.slice(0, 2).toUpperCase())}</div>
            <div>
              <div class="channel-name">${escapeHtml(channel)}</div>
              <div class="channel-sub">${isLive ? 'Emitiendo ahora' : 'Distribuido por IPFS · P2P WebRTC'}</div>
            </div>
          </div>
          <button class="chip-btn" id="act-like">${icon(ICONS.thumbs)}<span>Me gusta</span></button>
          <button class="chip-btn" id="act-share">${icon(ICONS.share)}<span>Compartir</span></button>
          <button class="chip-btn" id="act-save">${icon(ICONS.save)}<span>Guardar</span></button>
        </div>

        <div class="watch-desc" id="watch-desc">
          <div class="clamp">
            <b>${escapeHtml(video.title)}</b> — ${escapeHtml(fmtTime(video.duration))} ·
            ${video.qualities?.length ?? 1} nivel(es) de calidad ·
            <span id="watch-bytes">0 B</span> entregados por la red
            <div id="resume-hint" ${resumeAt > 5 ? '' : 'hidden'}>
              <button class="btn btn--accent btn--sm" id="resume-btn">
                ▶ Continuar desde ${escapeHtml(fmtTime(resumeAt))}
              </button>
            </div>
          </div>
          <div class="watch-desc-toggle" id="desc-toggle">Mostrar más</div>
        </div>

        <div class="watch-tags">
          ${WATCH_TAGS.map(
            (t) => `<a class="tag-pill" href="?mode=wall&q=${encodeURIComponent(t)}${apiQuery()}">#${escapeHtml(t)}</a>`
          ).join('')}
        </div>
      </div>

      <aside class="watch-side">
        <div class="side-head">
          <h4>A continuación</h4>
          <label class="switch" title="Reproducción automática">
            <input type="checkbox" id="autoplay-toggle" ${readAutoplay() ? 'checked' : ''} />
            <i></i>
          </label>
        </div>
        <div class="upnext" id="upnext" ${related.length > 0 ? '' : 'hidden'}>
          Reproducción automática activada
        </div>
        <div id="related-list"></div>
      </aside>
    </div>
  `

  // Mini player (YouTube dock-in-the-corner behaviour).
  const mini = document.createElement('div')
  mini.className = 'mini'
  mini.id = 'watch-mini'
  mini.innerHTML = `
    <div class="mini-stage">
      <video id="mini-video" playsinline></video>
      <button class="mini-click" id="mini-click" aria-label="Volver al reproductor"></button>
    </div>
    <div class="mini-bar">
      <span class="mini-title">${escapeHtml(video.title)}</span>
      <button id="mini-expand" title="Pantalla completa">${icon(ICONS.fullscreen, 'icon')}</button>
      <button id="mini-close" title="Cerrar">${icon(ICONS.close, 'icon')}</button>
    </div>
  `

  document.body.appendChild(root)
  document.body.appendChild(mini)
  document.body.classList.add('watch-locked')

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => root.querySelector(sel) as T
  const mainVideo = $<HTMLVideoElement>('#watch-video')
  const miniVideo = mini.querySelector<HTMLVideoElement>('#mini-video')!
  const loading = $('#watch-loading')
  const loadingTxt = $('#watch-loading-txt')
  const hudSource = $('#hud-source')
  const hudP2p = $('#hud-p2p')
  const timeEl = $('#ctrl-time')
  const playBtn = $('#ctrl-play')
  const volumeInput = $<HTMLInputElement>('#ctrl-volume')
  const qualitySel = $<HTMLSelectElement>('#ctrl-quality')
  const stage = $('#watch-stage')
  const overlay = root

  // --- Related list ------------------------------------------------------
  function renderRelated(): void {
    const list = $('#related-list')
    if (!list) return
    if (related.length === 0) {
      list.innerHTML = `<div class="empty" style="padding:24px 0">Nada más que ver aquí todavía.</div>`
      return
    }
    list.innerHTML = related
      .map(
        (v) => `
      <button class="rel" data-rel-id="${escapeHtml(v.id)}">
        <div class="rel-art">
          ${thumbOf(v) ? `<img src="${escapeHtml(thumbOf(v))}" alt="" loading="lazy" />` : ''}
          ${!v.duration ? '<span class="chip chip--live" style="position:absolute;top:6px;left:6px">LIVE</span>' : ''}
        </div>
        <div class="rel-body">
          <div class="rel-title">${escapeHtml(v.title)}</div>
          <div class="rel-meta">${escapeHtml(v.channelName ?? 'IberCast')}</div>
          <div class="rel-meta">${v.duration ? escapeHtml(fmtTime(v.duration)) : 'En directo'}</div>
        </div>
      </button>`
      )
      .join('')
    list.querySelectorAll('.rel').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.relId!
        const next = related.find((v) => v.id === id)
        if (next) play(next)
      })
    })
  }

  // --- HLS / P2P ---------------------------------------------------------
  const stats: FetchStats = newFetchStats()
  let hls: Hls | null = null
  let hudTimer: ReturnType<typeof setInterval> | null = null

  function buildQualityMenu(levels: Array<{ height: number; bitrate: number }>): void {
    const opts: QualityOption[] = levels
      .map((l, i) => ({ label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps`, index: i }))
      .filter((o, i, arr) => arr.findIndex((x) => x.label === o.label) === i)
      .reverse()
    opts.push({ label: 'Auto', index: -1 })
    qualitySel.hidden = opts.length < 2
    qualitySel.innerHTML = opts
      .map((o) => `<option value="${o.index}" ${o.index === -1 ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
      .join('')
  }

  function destroyStream(): void {
    if (hudTimer) { clearInterval(hudTimer); hudTimer = null }
    destroyHls()
    hls = null
  }

  function play(item: PlayerVideo): void {
    destroyStream()
    const itemIsLive = !item.cid && !!item.hlsUrl && !item.duration
    const itemResume = itemIsLive ? 0 : Math.min(getProgress(item.id), Math.max(0, item.duration - 20))
    const masterUrl = itemIsLive ? item.hlsUrl! : `${gatewayBase(item.cid)}/master.m3u8`

    // Sync the header/meta with the new item.
    const titleEl = root.querySelector('.watch-title')
    if (titleEl) titleEl.textContent = item.title
    const descName = root.querySelector('#watch-desc b')
    if (descName) descName.textContent = item.title
    const miniTitle = mini.querySelector('.mini-title')
    if (miniTitle) miniTitle.textContent = item.title
    timeEl.textContent = `0:00 / ${fmtTime(item.duration)}`
    overlay.scrollTop = 0
    mini.classList.remove('is-open')

    loading.classList.remove('is-hidden')
    loadingTxt.textContent = 'Buscando manifiesto…'

    const config: Partial<HlsConfig> = { enableWorker: false, progressive: false }
    if (itemIsLive) {
      config.liveSyncDurationCount = 3
      config.liveMaxLatencyDurationCount = 6
    } else {
      config.loader = createIberLoader(() => activeNode, item.cid, stats)
    }

    hls = new Hls(config)
    activeHls = hls

    hls.on(Events.MANIFEST_PARSED, (_e, data) => {
      buildQualityMenu(data.levels)
      const n = data.levels.length
      hudSource.textContent = itemIsLive ? 'DIRECTO · MediaMTX' : `P2P · ${n} calidad${n === 1 ? '' : 'es'}`
      loading.classList.add('is-hidden')
    })

    hls.on(Events.ERROR, (_evt, data) => {
      if (!data.fatal) return
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        loadingTxt.textContent = `Error de red: ${data.details}. Reintentando…`
        loading.classList.remove('is-hidden')
        hls?.startLoad()
      } else {
        loadingTxt.textContent = `Error: ${data.details}`
        loading.classList.remove('is-hidden')
        hudSource.classList.add('hud-pill--err')
        hudSource.textContent = 'ERROR'
      }
    })

    hls.loadSource(masterUrl)
    hls.attachMedia(mainVideo)

    mainVideo
      .play()
      .then(() => {
        if (itemResume > 5) {
          mainVideo.currentTime = itemResume
          toast(`Reanudando desde ${fmtTime(itemResume)}`)
        }
      })
      .catch(() => {
        /* autoplay blocked — the user can press play */
      })

    hudTimer = setInterval(() => {
      const peers = activeNode?.peerCount() ?? 0
      hudP2p.textContent = `${peers} peer${peers === 1 ? '' : 's'} · ${stats.segmentsP2P} seg P2P`
      const bytes = root.querySelector('#watch-bytes')
      if (bytes) bytes.textContent = fmtBytes(stats.bytesP2P + stats.bytesHTTP)
    }, 1000)
  }

  // --- Controls ----------------------------------------------------------
  function togglePlay(): void {
    if (mainVideo.paused) mainVideo.play().catch(() => {})
    else mainVideo.pause()
  }

  playBtn.addEventListener('click', togglePlay)
  mainVideo.addEventListener('click', togglePlay)
  mainVideo.addEventListener('dblclick', () => void toggleFullscreen())
  mainVideo.addEventListener('play', () => { playBtn.innerHTML = icon(ICONS.pause) })
  mainVideo.addEventListener('pause', () => { playBtn.innerHTML = icon(ICONS.play) })
  mainVideo.addEventListener('ended', () => {
    if (!isLive && getProgress(video.id) > 0) clearProgress(video.id)
    const next = related[0]
    if (next && readAutoplay()) {
      toast('Siguiente en un momento…')
      setTimeout(() => play(next), 600)
    } else if (next) {
      toast('Autoplay desactivado')
    }
  })

  const seek = (delta: number): void => {
    if (!Number.isFinite(mainVideo.duration)) return
    mainVideo.currentTime = Math.min(Math.max(0, mainVideo.currentTime + delta), mainVideo.duration)
  }
  $('#ctrl-back').addEventListener('click', () => seek(-10))
  $('#ctrl-fwd').addEventListener('click', () => seek(10))

  $('#ctrl-mute').addEventListener('click', () => {
    mainVideo.muted = !mainVideo.muted
    syncMuteIcon()
  })
  function syncMuteIcon(): void {
    $('#ctrl-mute').innerHTML = icon(mainVideo.muted || mainVideo.volume === 0 ? ICONS.mute : ICONS.volume)
  }
  volumeInput.addEventListener('input', () => {
    mainVideo.volume = Number(volumeInput.value)
    if (mainVideo.volume > 0) mainVideo.muted = false
    syncMuteIcon()
  })

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stage.requestFullscreen()
    } catch {
      toast('Pantalla completa no disponible')
    }
  }
  $('#ctrl-fs').addEventListener('click', () => void toggleFullscreen())
  document.addEventListener('fullscreenchange', () => {
    $('#ctrl-fs').innerHTML = icon(document.fullscreenElement ? ICONS.exitFullscreen : ICONS.fullscreen)
  })

  const pipBtn = $<HTMLButtonElement>('#ctrl-pip')
  if (!document.pictureInPictureEnabled) pipBtn.hidden = true
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await mainVideo.requestPictureInPicture()
    } catch {
      toast('Picture-in-picture no disponible')
    }
  })

  qualitySel.addEventListener('change', () => {
    if (!hls) return
    const idx = Number(qualitySel.value)
    hls.currentLevel = idx
    toast(idx === -1 ? 'Calidad automática' : `Calidad fija: ${qualitySel.options[qualitySel.selectedIndex].text}`)
  })

  mainVideo.addEventListener('timeupdate', () => {
    const total = Number.isFinite(mainVideo.duration) ? mainVideo.duration : video.duration
    timeEl.textContent = `${fmtTime(mainVideo.currentTime)} / ${fmtTime(total)}`
    if (!isLive && mainVideo.currentTime > 5) {
      saveProgress(video.id, mainVideo.currentTime)
    }
  })

  // Description expand
  const desc = $('#watch-desc')
  desc.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'resume-btn') return
    desc.classList.toggle('is-open')
    $('#desc-toggle').textContent = desc.classList.contains('is-open') ? 'Mostrar menos' : 'Mostrar más'
  })
  const resumeBtn = $<HTMLButtonElement>('#resume-btn')
  resumeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    mainVideo.currentTime = Math.min(getProgress(video.id), Math.max(0, mainVideo.duration - 5))
    mainVideo.play().catch(() => {})
    resumeBtn.parentElement?.setAttribute('hidden', '')
  })

  // Actions
  $('#act-share').addEventListener('click', async () => {
    const url = video.cid ? `${location.origin}${location.pathname}?cid=${video.cid}` : location.href
    try {
      await navigator.clipboard.writeText(url)
      toast('Enlace copiado al portapapeles')
    } catch {
      toast(url)
    }
  })
  for (const id of ['act-like', 'act-save']) {
    const btn = $<HTMLButtonElement>(`#${id}`)
    btn.addEventListener('click', () => {
      const on = btn.classList.toggle('is-active')
      toast(on ? (id === 'act-like' ? 'Añadido a "Me gusta"' : 'Guardado en tu lista') : 'Quitado')
    })
  }

  // Autoplay switch
  const autoplayToggle = $<HTMLInputElement>('#autoplay-toggle')
  const upnext = $('#upnext')
  function syncAutoplay(): void {
    writeAutoplay(autoplayToggle.checked)
    upnext.hidden = !autoplayToggle.checked || related.length === 0
  }
  autoplayToggle.addEventListener('change', syncAutoplay)
  syncAutoplay()

  // --- Mini player -------------------------------------------------------
  let seekingMini = false
  function moveToMini(): void {
    if (isLive) return
    miniVideo.src = mainVideo.currentSrc
    miniVideo.currentTime = mainVideo.currentTime
    miniVideo.muted = true
    miniVideo.play().catch(() => {})
    mini.classList.add('is-open')
    mainVideo.pause()
  }
  function restoreFromMini(): void {
    seekingMini = true
    mainVideo.currentTime = miniVideo.currentTime
    mainVideo.play().catch(() => {})
    miniVideo.pause()
    miniVideo.removeAttribute('src')
    miniVideo.load()
    mini.classList.remove('is-open')
    // Reset the flag after the seek has been applied.
    setTimeout(() => { seekingMini = false }, 120)
  }
  overlay.addEventListener('scroll', () => {
    const stageBottom = stage.getBoundingClientRect().bottom
    if (stageBottom < 0 && !mini.classList.contains('is-open')) moveToMini()
    if (stageBottom > 0 && mini.classList.contains('is-open')) restoreFromMini()
  })
  // The mini bar lives in its own root appended to body, so it must be
  // queried through `mini` — `$` is scoped to the overlay root and misses it.
  mini.querySelector('#mini-click')?.addEventListener('click', () => {
    restoreFromMini()
    overlay.scrollTo({ top: 0, behavior: 'smooth' })
  })
  mini.querySelector('#mini-expand')?.addEventListener('click', () => {
    restoreFromMini()
    void toggleFullscreen()
  })
  mini.querySelector('#mini-close')?.addEventListener('click', () => {
    miniVideo.pause()
    miniVideo.removeAttribute('src')
    miniVideo.load()
    mini.classList.remove('is-open')
  })
  mainVideo.addEventListener('seeking', () => {
    if (!seekingMini) miniVideo.currentTime = mainVideo.currentTime
  })

  // --- Keyboard shortcuts -------------------------------------------------
  function onKeydown(e: KeyboardEvent): void {
    const el = e.target as HTMLElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return
    switch (e.key) {
      case 'Escape': back(); break
      case ' ':
      case 'k': e.preventDefault(); togglePlay(); break
      case 'j': e.preventDefault(); seek(-10); break
      case 'l': e.preventDefault(); seek(10); break
      case 'm': mainVideo.muted = !mainVideo.muted; syncMuteIcon(); break
      case 'f': void toggleFullscreen(); break
      case 'ArrowLeft': e.preventDefault(); seek(-5); break
      case 'ArrowRight': e.preventDefault(); seek(5); break
      case 'ArrowUp': e.preventDefault(); mainVideo.volume = Math.min(1, mainVideo.volume + .1); volumeInput.value = String(mainVideo.volume); syncMuteIcon(); break
      case 'ArrowDown': e.preventDefault(); mainVideo.volume = Math.max(0, mainVideo.volume - .1); volumeInput.value = String(mainVideo.volume); syncMuteIcon(); break
      default: break
    }
  }
  document.addEventListener('keydown', onKeydown)

  // --- Go back -----------------------------------------------------------
  function back(): void {
    options.onBack ? options.onBack() : closePlayer()
  }
  $('#watch-back').addEventListener('click', back)

  // --- Boot --------------------------------------------------------------
  renderRelated()
  syncMuteIcon()
  mainVideo.volume = 1

  // Warm the P2P node in the background for VOD; playback never waits on it.
  if (!isLive && !activeNode) {
    createIberNode()
      .then((n) => { activeNode = n })
      .catch(() => { activeNode = null })
  }

  play(video)

  ;(overlay as unknown as { __cleanup?: () => void }).__cleanup = () => {
    document.removeEventListener('keydown', onKeydown)
    destroyStream()
    miniVideo?.pause()
    mainVideo?.pause()
    mini.remove()
    document.body.classList.remove('watch-locked')
    overlay.remove()
  }
}

export function closePlayer(): void {
  const overlay = document.getElementById('watch-overlay')
  if (!overlay) return
  const cleanup = (overlay as unknown as { __cleanup?: () => void }).__cleanup
  if (cleanup) cleanup()
  else {
    destroyHls()
    overlay.remove()
    document.getElementById('watch-mini')?.remove()
    document.body.classList.remove('watch-locked')
  }
}

export { ICONS as WATCH_ICONS }
