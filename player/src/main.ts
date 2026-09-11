import Hls, { Events, ErrorTypes } from 'hls.js'
import { createIberNode, type IberNode } from './node'
import {
  createIberLoader,
  newFetchStats,
  type ActivityState,
  type FetchStats
} from './loader'
import { initPlayout } from './viewer/playout'
import { WallView } from './wall'
import { requireAdminToken } from './admin/login'
import { AdminDashboard } from './admin/dashboard'
import { gatewayBase } from './gateway'

// --- E2E test hooks -------------------------------------------------------
declare global {
  interface Window {
    __IBER__: {
      status: string
      ready: boolean
      readyPromise?: Promise<boolean>
      hlsError: string | null
      fetchStats: FetchStats
      levels: number
      videoW: number
      videoH: number
      duration: number
      playoutState?: string
    }
  }
}

const params = new URLSearchParams(location.search)
let mode = params.get('mode') || 'wall'
// Valid modes: wall, admin|dashboard, viewer, legacy
// Design names the admin mode "dashboard"; keep "admin" as backward-compatible alias.
if (mode === 'dashboard') mode = 'admin'

// Hide all containers, then show the active one
function hideAll(): void {
  for (const id of ['wall-root', 'admin-root', 'viewer', 'legacy']) {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  }
}

function show(id: string): HTMLElement | null {
  const el = document.getElementById(id)
  // Explicit block: CSS keeps non-active modes hidden (display:none).
  if (el) el.style.display = 'block'
  return el
}

// --- MODE ROUTING ---
// ?mode=wall     → Video wall (default, public)
// ?mode=admin    → Admin dashboard (token required)
// ?mode=viewer   → TV Playout (auto-play from parrilla)
// ?mode=legacy   → Legacy manual CID input
// ?cid=...       → Legacy mode (backwards compatible)

const effectiveMode = params.get('cid') ? 'legacy' : mode

if (effectiveMode === 'wall') {
  hideAll()
  const root = show('wall-root')!
  const apiBase = params.get('api') || location.origin
  WallView(root, apiBase)
}

if (effectiveMode === 'admin') {
  hideAll()
  const root = show('admin-root')!
  const apiBase = params.get('api') || location.origin
  requireAdminToken(apiBase).then((token) => {
    if (token) AdminDashboard(root, apiBase, token)
  })
}

if (effectiveMode === 'viewer') {
  hideAll()
  show('viewer')
  const apiBase = params.get('api') || location.origin
  const channelId = params.get('channelId') || 'default'
  initPlayout(channelId, apiBase, {
    gateway: params.get('gw') || undefined,
    videoEl: 'video-viewer'
  })
}

// --- Legacy mode: manual CID input (backwards compatible) ---
if (effectiveMode === 'legacy') {
hideAll()
show('legacy')

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

const video = $<HTMLVideoElement>('video')
const cidInput = $<HTMLInputElement>('cid')
const status = $('status')
const activityEl = $<HTMLElement>('activity')
const activityTxt = $('activity-txt')

const stats: FetchStats = newFetchStats()
let node: IberNode | null = null
let hls: Hls | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null
let playGeneration = 0

const cidFromUrl = params.get('cid')

let readyResolve: (ok: boolean) => void = () => {}
const readyPromise = new Promise<boolean>((resolve) => {
  readyResolve = resolve
})

window.__IBER__ = {
  status: 'booting',
  ready: false,
  readyPromise,
  hlsError: null,
  fetchStats: stats,
  levels: 0,
  videoW: 0,
  videoH: 0,
  duration: 0
}

function resetIberState(): void {
  window.__IBER__.ready = false
  window.__IBER__.hlsError = null
  window.__IBER__.levels = 0
  window.__IBER__.videoW = 0
  window.__IBER__.videoH = 0
  window.__IBER__.duration = 0
}

function setStatus(s: string): void {
  status.textContent = s
  if (window.__IBER__) window.__IBER__.status = s
}

let activityIdleTimer: ReturnType<typeof setTimeout> | null = null

function setActivity(cls: '' | 'busy' | 'warn' | 'err', text: string): void {
  activityEl.className = cls
  activityTxt.textContent = text
}

function markActivityBusy(label: string): void {
  if (activityIdleTimer) { clearTimeout(activityIdleTimer); activityIdleTimer = null }
  setActivity('busy', label)
}

function markActivityIdle(): void {
  activityIdleTimer = setTimeout(() => {
    activityIdleTimer = null
    setActivity('', navigator.onLine ? 'Reproduciendo' : 'Sin conexión')
  }, 700)
}

function markActivityOffline(): void {
  if (activityIdleTimer) { clearTimeout(activityIdleTimer); activityIdleTimer = null }
  setActivity('err', 'Sin conexión — revísalo')
}

function handleActivity(a: ActivityState): void {
  if (a.state === 'downloading') markActivityBusy('Descargando…')
  else markActivityIdle()
}

window.addEventListener('online', () => {
  if (activityIdleTimer) clearTimeout(activityIdleTimer)
  setActivity('', 'Reproduciendo')
  if (hls && window.__IBER__.ready) hls.startLoad()
})
window.addEventListener('offline', markActivityOffline)

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function renderStats(): void {
  $('m-peers').textContent = String(node?.peerCount() ?? 0)
  $('m-p2p').textContent = String(stats.segmentsP2P)
  $('m-http').textContent = String(stats.segmentsHTTP)
  $('m-cache').textContent = String(stats.segmentsCache)
  $('m-bytes-p2p').textContent = fmtBytes(stats.bytesP2P)
  $('m-bytes-http').textContent = fmtBytes(stats.bytesHTTP)
  $('m-last').textContent = stats.lastSource
}

setInterval(renderStats, 1000)

const CID_RE = /^(Qm[a-zA-Z0-9]{44}|bafy[a-zA-Z0-9]+)$/

async function play(cid: string): Promise<void> {
  if (!cid) {
    setStatus('❌ Falta el CID.')
    readyResolve(false)
    return
  }
  if (!CID_RE.test(cid)) {
    setStatus('❌ CID no válido. Usa un CID IPFS (bafy… o Qm…).')
    readyResolve(false)
    return
  }

  playGeneration++
  resetIberState()
  setActivity('', 'Cargando…')
  if (safetyTimer !== null) { clearTimeout(safetyTimer); safetyTimer = null }

  if (!node) {
    if (params.get('nop2p') === '1') {
      setStatus('ℹ️ Modo nop2p: reproducción solo por gateway')
    } else {
      setStatus('⏳ Arrancando nodo IPFS en el navegador…')
      try {
        node = await createIberNode()
        if (!node.started) setStatus('⚠️ P2P no disponible; reproduciendo solo por gateway')
      } catch (err) {
        setStatus(`⚠️ P2P no disponible (${(err as Error).message}); solo gateway`)
        node = null
      }
    }
  }

  setStatus('⏳ Buscando el manifiesto en la red…')

  if (hls) { hls.destroy(); hls = null }

  const masterUrl = `${gatewayBase(cid)}/master.m3u8`
  const generation = playGeneration

  hls = new Hls({
    loader: createIberLoader(() => node, cid, stats, handleActivity),
    enableWorker: false,
    progressive: false,
    debug: params.get('debug') === '1'
  })

  hls.on(Events.MANIFEST_PARSED, (_e, data) => {
    if (generation !== playGeneration) return
    setStatus('✅ Manifiesto cargado. Reproduciendo…')
    window.__IBER__.levels = data.levels.length
  })

  hls.on(Events.ERROR, (_evt, data) => {
    if (generation !== playGeneration) return
    if (data.fatal) window.__IBER__.hlsError = `${data.type}:${data.details}`
    if (!data.fatal) return
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      setStatus(`⚠️ Error de red: ${data.details}. Reintentando…`)
      setActivity('warn', 'Problema de red — reintentando…')
      hls?.startLoad()
    } else {
      setStatus(`❌ Error fatal: ${data.details}`)
      setActivity('err', 'Error de reproducción')
      window.__IBER__.hlsError = `fatal:${data.details}`
      readyResolve(false)
      hls?.destroy()
      hls = null
    }
  })

  const onMeta = (): void => {
    if (generation !== playGeneration) return
    window.__IBER__.videoW = video.videoWidth
    window.__IBER__.videoH = video.videoHeight
    window.__IBER__.duration = video.duration
    if (window.__IBER__.videoW > 0) {
      window.__IBER__.ready = true
      setStatus('✅ Reproduciendo (metadatos listos)')
      readyResolve(true)
    }
  }
  video.addEventListener('loadedmetadata', onMeta, { once: true })

  hls.loadSource(masterUrl)
  hls.attachMedia(video)

  safetyTimer = setTimeout(() => {
    if (generation !== playGeneration) return
    safetyTimer = null
    readyResolve(false)
  }, 90_000)
}

$('go').addEventListener('click', () => { void play(cidInput.value.trim()) })
cidInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void play(cidInput.value.trim()) })

void (async () => {
  renderStats()
  if (cidFromUrl) {
    cidInput.value = cidFromUrl
    await play(cidFromUrl)
  } else {
    readyResolve(false)
  }
})()
}
