import Hls, { Events, ErrorTypes } from 'hls.js'
import { createIberNode, type IberNode } from './node'
import { createIberLoader, newFetchStats, type FetchStats } from './loader'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

const video = $<HTMLVideoElement>('video')
const cidInput = $<HTMLInputElement>('cid')
const status = $('status')

const stats: FetchStats = newFetchStats()
let node: IberNode | null = null
let hls: Hls | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null
let playGeneration = 0

// Optional overrides: /?cid=...&gw=https://mygateway.example
const params = new URLSearchParams(location.search)
const GATEWAY = params.get('gw') || 'https://ipfs.io'
const cidFromUrl = params.get('cid')

// --- E2E test hooks -------------------------------------------------------
declare global {
  interface Window {
    __IBER__: {
      status: string
      ready: boolean
      readyPromise: Promise<boolean>
      hlsError: string | null
      fetchStats: FetchStats
      levels: number
      videoW: number
      videoH: number
      duration: number
    }
  }
}

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

// -------------------------------------------------------------------------

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

// CID validation: base58 (Qm…) or base32 (bafy…)
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

  // Reset state for new play() call
  playGeneration++
  resetIberState()
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }

  if (!node) {
    if (params.get('nop2p') === '1') {
      // Fast path gateway-only (E2E y entornos sin WebRTC): sin nodo Helia.
      setStatus('ℹ️ Modo nop2p: reproducción solo por gateway')
    } else {
      setStatus('⏳ Arrancando nodo IPFS en el navegador…')
      try {
        node = await createIberNode()
        if (!node.started) {
          setStatus('⚠️ P2P no disponible en este entorno; reproduciendo solo por gateway')
        }
      } catch (err) {
        // Degradación elegante: sin P2P se reproduce igualmente por gateway.
        setStatus(`⚠️ P2P no disponible (${(err as Error).message}); solo gateway`)
        node = null
      }
    }
  }

  setStatus('⏳ Buscando el manifiesto en la red…')

  if (hls) {
    hls.destroy()
    hls = null
  }

  const masterUrl = `${GATEWAY}/ipfs/${cid}/master.m3u8`
  const generation = playGeneration

  hls = new Hls({
    // node == null => loader en modo solo-gateway (nop2p o fallo de arranque)
    loader: createIberLoader(node, cid, stats),
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
      hls?.startLoad()
    } else {
      setStatus(`❌ Error fatal: ${data.details}`)
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

  // Safety net: if nothing produces metadata in 90s, report failure.
  safetyTimer = setTimeout(() => {
    if (generation !== playGeneration) return
    safetyTimer = null
    readyResolve(false)
  }, 90_000)
}

$('go').addEventListener('click', () => {
  void play(cidInput.value.trim())
})

cidInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void play(cidInput.value.trim())
})

void (async () => {
  renderStats()
  if (cidFromUrl) {
    cidInput.value = cidFromUrl
    await play(cidFromUrl)
  } else {
    readyResolve(false)
  }
})()
