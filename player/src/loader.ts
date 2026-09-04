import { CID } from 'multiformats/cid'
import { LoadStats } from 'hls.js'
import type { UnixFS } from '@helia/unixfs'
import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats
} from 'hls.js'
import type { IberNode } from './node'

/**
 * Custom hls.js loader: resolves HLS manifests and segments from the IPFS
 * network (bitswap over WebRTC/WebSockets) before falling back to an HTTP
 * gateway.
 *
 * Path mapping published by ibercastd:
 *   <rootCID>/master.m3u8           -> HLS master manifest
 *   <rootCID>/v<quality>/index.m3u8 -> media playlist
 *   <rootCID>/v<quality>/seg-<n>.ts -> media segment
 *
 * All URIs hls.js asks for resolve under /ipfs/<rootCID>/... (the master
 * manifest URL is loaded with that prefix and hls.js keeps playlist URLs
 * relative), so this loader just strips the prefix to get the UnixFS path.
 */

export interface FetchStats {
  segmentsP2P: number
  segmentsHTTP: number
  segmentsCache: number
  bytesP2P: number
  bytesHTTP: number
  lastSource: string
}

export function newFetchStats(): FetchStats {
  return {
    segmentsP2P: 0,
    segmentsHTTP: 0,
    segmentsCache: 0,
    bytesP2P: 0,
    bytesHTTP: 0,
    lastSource: '–'
  }
}

const P2P_TIMEOUT_MS = 8_000
const HTTP_TIMEOUT_MS = 20_000

/** Shared segment cache — survives across loader instances and play() calls. */
const CACHE_MAX_BYTES = 100 * 1024 * 1024 // 100 MB
let cacheBytes = 0
const cache = new Map<string, Uint8Array>()

function cacheSet(key: string, value: Uint8Array): void {
  cache.set(key, value)
  cacheBytes += value.byteLength
  // Evict oldest entries when over budget
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value!
    const evicted = cache.get(oldest)!
    cache.delete(oldest)
    cacheBytes -= evicted.byteLength
  }
}

/** Clear the segment cache (e.g. when changing CID). */
export function clearCache(): void {
  cache.clear()
  cacheBytes = 0
}

/** Reusable TextDecoder for manifest/playlist text payloads. */
const textDecoder = new TextDecoder()

/** Combine an external signal with a timeout into one controller. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortController {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timerId = setTimeout(() => controller.abort(), ms)
  // Clean up external listener and timer when the controller fires
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timerId)
    signal?.removeEventListener('abort', onAbort)
  }, { once: true })
  return controller
}

/** Fetch a UnixFS file by path under rootCID over P2P (bitswap). */
async function fetchViaP2P(
  node: IberNode,
  rootCid: string,
  path: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const controller = withTimeout(signal, P2P_TIMEOUT_MS)
  // Dual-multiformats copy in the tree: align the CID type with the one
  // @helia/unixfs expects.
  const root = CID.parse(rootCid) as unknown as Parameters<UnixFS['cat']>[0]
  const chunks: Uint8Array[] = []
  for await (const chunk of node.unixfs.cat(root, {
    path,
    signal: controller.signal
  })) {
    chunks.push(chunk)
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** Fetch over an HTTP gateway. */
async function fetchViaHTTP(
  gatewayUrl: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const controller = withTimeout(signal, HTTP_TIMEOUT_MS)
  const res = await fetch(gatewayUrl, { signal: controller.signal })
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Contexts whose payload hls.js expects as text, not binary. */
function isTextContext(ctx: LoaderContext): boolean {
  return (
    ctx.responseType === 'text' ||
    ctx.type === 'manifest' ||
    ctx.type === 'level' ||
    ctx.type === 'audioTrack' ||
    ctx.type === 'subtitleTrack'
  )
}

/**
 * Returns a hls.js loader constructor bound to the given Helia node and
 * root CID. Used for both playlists (config.loader) and fragments unless
 * fLoader/pLoader are overridden separately.
 */
export function createIberLoader(
  node: IberNode | null,
  rootCid: string,
  fetchStats: FetchStats
): HlsConfig['loader'] {
  return class IberLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null
    stats: LoaderStats = new LoadStats()
    private controller: AbortController | null = null
    private callbacks: LoaderCallbacks<LoaderContext> | null = null

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_config: HlsConfig) {}

    load(
      context: LoaderContext,
      _config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>
    ): void {
      this.context = context
      this.callbacks = callbacks
      this.controller = new AbortController()
      this.stats = new LoadStats()
      void this.run(context)
    }

    private async run(context: LoaderContext): Promise<void> {
      if (!this.callbacks) return

      // /ipfs/<rootCID>/v0/seg-1.ts -> v0/seg-1.ts
      let path = context.url.split('?')[0]
      const m = path.match(/\/ipfs\/[^/]+\/?(.*)$/)
      path = m ? m[1] : path.replace(/^https?:\/\/[^/]+\//, '')

      const isFrag = context.type === 'media-fragment'
      let data: Uint8Array | null = null
      let source = ''

      // 1. in-memory cache
      const hit = cache.get(path)
      if (hit) {
        data = hit
        source = 'cache'
        fetchStats.segmentsCache++
      }

      // 2. P2P over bitswap/WebRTC. Skipped when running gateway-only
      // (node == null), when the node never fully started, or when there
      // are no peers yet — nobody to ask, so don't pay the timeout.
      if (!data && node !== null && node.started && node.peerCount() > 0) {
        try {
          data = await fetchViaP2P(node, rootCid, path, this.controller?.signal)
          source = 'p2p'
          fetchStats.bytesP2P += data.byteLength
          if (isFrag) fetchStats.segmentsP2P++
          cacheSet(path, data)
        } catch (err) {
          console.warn(`[IberCast] P2P failed for ${path}:`, err)
          /* fall through to gateway */
        }
      }

      // 3. HTTP gateway fallback
      if (!data) {
        try {
          data = await fetchViaHTTP(context.url, this.controller?.signal)
          source = 'gateway'
          fetchStats.bytesHTTP += data.byteLength
          if (isFrag) fetchStats.segmentsHTTP++
          cacheSet(path, data)
        } catch (err) {
          const aborted = this.controller?.signal.aborted ?? false
          fetchStats.lastSource = aborted ? 'abort' : 'error'
          this.callbacks.onError(
            {
              code: aborted ? -1 : 400,
              text: err instanceof Error ? err.message : String(err)
            },
            context,
            null,
            this.stats
          )
          return
        }
      }

      if (!data) {
        const msg = `No data resolved for path "${path}"`
        fetchStats.lastSource = 'error'
        this.callbacks.onError({ code: 500, text: msg }, context, null, this.stats)
        return
      }

      fetchStats.lastSource = source
      let payload: string | ArrayBuffer
      if (isTextContext(context)) {
        payload = textDecoder.decode(data)
      } else if (
        context.rangeStart !== undefined &&
        context.rangeEnd !== undefined
      ) {
        const sliced = data.subarray(context.rangeStart, context.rangeEnd)
        payload = sliced.buffer.slice(
          sliced.byteOffset,
          sliced.byteOffset + sliced.byteLength
        ) as ArrayBuffer
      } else {
        payload = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        ) as ArrayBuffer
      }

      this.stats.total = data.byteLength
      this.stats.loaded = data.byteLength

      const response: LoaderResponse = { url: context.url, data: payload }
      this.callbacks.onSuccess(response, this.stats, context, null)
    }

    abort(): void {
      this.controller?.abort()
    }

    destroy(): void {
      this.controller?.abort()
      this.context = null
      this.callbacks = null
    }
  }
}
