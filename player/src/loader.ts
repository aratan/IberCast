import { CID } from 'multiformats/cid'
import { LoadStats, XhrLoader } from 'hls.js'
import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse
} from 'hls.js'
import type { UnixFS } from '@helia/unixfs'
import type { IberNode } from './node'

/**
 * Custom hls.js loader: tries cache + IPFS P2P (bitswap over
 * WebRTC/WebSockets) first, then falls back to hls.js's stock XhrLoader so
 * every gateway response is byte-for-byte identical to plain hls.js (the
 * XhrLoader handles responseType, ranges, retries and callbacks).
 *
 * Path mapping published by ibercastd:
 *   <rootCID>/master.m3u8           -> HLS master manifest
 *   <rootCID>/v<quality>/index.m3u8 -> media playlist
 *   <rootCID>/v<quality>/seg-<n>.ts -> media segment
 *
 * All URIs hls.js asks for resolve under /ipfs/<rootCID>/... (the master
 * manifest URL carries that prefix and hls.js keeps playlist URLs relative),
 * so the P2P layer just strips the prefix to get the UnixFS path.
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

/** Combine an external signal with a timeout into one controller. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortController {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  setTimeout(() => controller.abort(), ms)
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
  // Dual-multiformats copy in the tree: align CID type with @helia/unixfs.
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

/**
 * Loader constructor bound to a Helia node + root CID. With node == null
 * (nop2p mode or failed startup) it is a thin cache wrapper around the
 * stock XhrLoader.
 */
export function createIberLoader(
  node: IberNode | null,
  rootCid: string,
  fetchStats: FetchStats
): HlsConfig['loader'] {
  const cache = new Map<string, Uint8Array>()

  return class IberLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null
    stats = new LoadStats()
    private config: HlsConfig
    private controller: AbortController | null = null
    private xhr: Loader<LoaderContext> | null = null

    constructor(config: HlsConfig) {
      this.config = config
    }

    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>
    ): void {
      this.context = context
      this.controller = new AbortController()
      this.stats = new LoadStats()
      void this.run(context, config, callbacks)
    }

    private async run(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>
    ): Promise<void> {
      const isFrag = context.type === 'media-fragment'

      // 1. in-memory cache (only full-object requests can be served locally)
      const key = context.url.split('?')[0]
      const hit = context.rangeStart === undefined ? cache.get(key) : undefined
      if (hit) {
        fetchStats.segmentsCache++
        fetchStats.lastSource = 'cache'
        this.deliver(context, callbacks, hit)
        return
      }

      // 2. P2P over bitswap/WebRTC: skipped gateway-only (node == null), when
      // the node never fully started, or when there are no peers yet.
      const canP2P =
        node !== null &&
        node.started &&
        node.peerCount() > 0 &&
        context.rangeStart === undefined
      if (canP2P && node !== null) {
        const p2pNode = node
        try {
          const m = key.match(/\/ipfs\/[^/]+\/?(.*)$/)
          const path = m
            ? m[1]
            : key.replace(/^https?:\/\/[^/]+\//, '')
          const data = await fetchViaP2P(p2pNode, rootCid, path, this.controller?.signal)
          fetchStats.bytesP2P += data.byteLength
          if (isFrag) fetchStats.segmentsP2P++
          fetchStats.lastSource = 'p2p'
          cache.set(key, data)
          this.deliver(context, callbacks, data)
          return
        } catch {
          /* fall through to gateway */
        }
      }

      // 3. gateway via stock XhrLoader: identical behaviour to plain hls.js.
      const xhr = new XhrLoader(this.config)
      this.xhr = xhr
      xhr.load(context, config, this.wrapCallbacks(context, callbacks))
    }

    /** Records gateway stats and caches successful full responses. */
    private wrapCallbacks(
      context: LoaderContext,
      callbacks: LoaderCallbacks<LoaderContext>
    ): LoaderCallbacks<LoaderContext> {
      const isFrag = context.type === 'media-fragment'
      return {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          const raw = response.data
          if (raw !== undefined) {
            const bytes =
              raw instanceof ArrayBuffer
                ? new Uint8Array(raw)
                : typeof raw === 'string'
                  ? new TextEncoder().encode(raw)
                  : new Uint8Array(0)
            if (bytes.byteLength > 0) {
              fetchStats.bytesHTTP += bytes.byteLength
              if (isFrag) fetchStats.segmentsHTTP++
              fetchStats.lastSource = 'gateway'
              if (context.rangeStart === undefined) cache.set(key(context), bytes)
            }
          }
          callbacks.onSuccess(response, stats, ctx, networkDetails)
        },
        onError: (error, ctx, networkDetails, stats) => {
          fetchStats.lastSource = 'error'
          callbacks.onError(error, ctx, networkDetails, stats)
        }
      }

      function key(ctx: LoaderContext): string {
        return ctx.url.split('?')[0]
      }
    }

    /** Feed cached/P2P bytes to hls.js exactly as the XhrLoader would. */
    private deliver(
      context: LoaderContext,
      callbacks: LoaderCallbacks<LoaderContext>,
      data: Uint8Array
    ): void {
      let payload: string | ArrayBuffer
      if (
        context.responseType === 'text' ||
        context.type === 'manifest' ||
        context.type === 'level' ||
        context.type === 'audioTrack' ||
        context.type === 'subtitleTrack'
      ) {
        payload = new TextDecoder().decode(data)
      } else {
        payload = data.slice().buffer as ArrayBuffer
      }
      this.stats.total = data.byteLength
      this.stats.loaded = data.byteLength
      const response: LoaderResponse = { url: context.url, data: payload }
      callbacks.onSuccess(response, this.stats, context, null)
    }

    abort(): void {
      this.controller?.abort()
      this.xhr?.abort()
    }

    destroy(): void {
      this.controller?.abort()
      this.xhr?.destroy()
      this.context = null
    }
  }
}
