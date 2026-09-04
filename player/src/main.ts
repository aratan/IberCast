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

// Optional overrides: /?cid=...&gw=https://mygateway.example
const params = new URLSearchParams(location.search)
const GATEWAY = params.get('gw') || 'https://ipfs.io'
const cidFromUrl = params.get('cid')

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

async function play(cid: string): Promise<void> {
  if (!cid) {
    status.textContent = '❌ Falta el CID.'
    return
  }

  if (!node) {
    status.textContent = '⏳ Arrancando nodo IPFS en el navegador…'
    try {
      node = await createIberNode()
    } catch (err) {
      status.textContent = `❌ No se pudo iniciar el nodo P2P: ${(err as Error).message}`
      return
    }
  }

  status.textContent = '⏳ Buscando el manifiesto en la red…'

  if (hls) {
    hls.destroy()
    hls = null
  }

  // The master manifest URL carries the /ipfs/<cid>/ prefix; hls.js keeps
  // playlist and segment URLs relative to it, so our loader can map every
  // request back to a UnixFS path under the root CID.
  const url = `${GATEWAY}/ipfs/${cid}/master.m3u8`

  hls = new Hls({
    loader: createIberLoader(node, cid, stats),
    enableWorker: false,
    progressive: false
  })

  hls.on(Events.MANIFEST_PARSED, () => {
    status.textContent = '✅ Manifiesto cargado. Reproduciendo…'
  })

  hls.on(Events.ERROR, (_evt, data) => {
    if (!data.fatal) return
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      status.textContent = `⚠️ Error de red: ${data.details}. Reintentando…`
      hls?.startLoad()
    } else {
      status.textContent = `❌ Error fatal: ${data.details}`
      hls?.destroy()
      hls = null
    }
  })

  hls.loadSource(url)
  hls.attachMedia(video)
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
  }
})()
