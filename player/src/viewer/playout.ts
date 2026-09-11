import Hls, { Events } from 'hls.js'
import { createIberLoader, newFetchStats, type FetchStats } from '../loader'
import { createIberNode, type IberNode } from '../node'
import { gatewayBase } from '../gateway'

function ensureIberState(fetchStats: FetchStats): void {
  if (!window.__IBER__) {
    window.__IBER__ = {
      status: 'booting',
      ready: false,
      hlsError: null,
      fetchStats,
      levels: 0,
      videoW: 0,
      videoH: 0,
      duration: 0,
      playoutState: 'loading'
    }
  }
  window.__IBER__.fetchStats = fetchStats
}

/**
 * Resolved parrilla slot — matches the backend ResolvedSlot shape.
 */
interface ResolvedSlot {
  id: string
  channelId: string
  dayOfWeek: number
  timeStart: string
  type: 'vod' | 'ad' | 'live'
  ref: { id: string; cid: string; hlsUrl: string; title: string; duration: number } | null
  unresolved?: boolean
}

type PlayoutState = 'loading' | 'playing' | 'empty' | 'error' | 'unresolved'

/**
 * Init playout: fetch parrilla, resolve active time slot, play via createIberLoader.
 * Re-resolves at each slot boundary.
 */
export async function initPlayout(
  channelId: string,
  apiBase: string,
  opts: { gateway?: string; videoEl?: string } = {}
): Promise<void> {
  const video = document.getElementById(opts.videoEl || 'video') as HTMLVideoElement | null
  if (!video) return

  const stats: FetchStats = newFetchStats()
  let node: IberNode | null = null
  let hls: Hls | null = null
  let activeSlotId: string | null = null
  let boundaryTimer: ReturnType<typeof setTimeout> | null = null

  ensureIberState(stats)

  function setState(state: PlayoutState, msg: string): void {
    if (window.__IBER__) window.__IBER__.playoutState = state
    if (window.__IBER__) window.__IBER__.status = msg
    // Mirror the status into the viewer UI (#status-viewer initial text is
    // "Cargando parrilla…" — without this it never updates).
    const statusEl = document.getElementById('status-viewer')
    if (statusEl) statusEl.textContent = msg
  }

  async function fetchParrilla(): Promise<ResolvedSlot[]> {
    const now = new Date()
    const day = now.getDay()
    const url = `${apiBase}/api/parrilla?channelId=${encodeURIComponent(channelId)}&day=${day}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  }

  function resolveActiveSlot(slots: ResolvedSlot[]): ResolvedSlot | null {
    const now = new Date()
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const sorted = [...slots].sort((a, b) => a.timeStart.localeCompare(b.timeStart))
    for (let i = 0; i < sorted.length; i++) {
      const slot = sorted[i]
      const nextStart = i + 1 < sorted.length ? sorted[i + 1].timeStart : '24:00'
      if (currentTime >= slot.timeStart && currentTime < nextStart) {
        return slot
      }
    }
    return null
  }

  async function fetchSafely(): Promise<ResolvedSlot[]> {
    try {
      return await fetchParrilla()
    } catch {
      setState('error', 'Backend unreachable — retrying…')
      return []
    }
  }

  function scheduleNextBoundary(): void {
    if (boundaryTimer) clearTimeout(boundaryTimer)
    const now = new Date()
    const nextMinute = new Date(now)
    nextMinute.setSeconds(0, 0)
    nextMinute.setMinutes(nextMinute.getMinutes() + 1)
    const ms = nextMinute.getTime() - now.getTime()
    boundaryTimer = setTimeout(async () => {
      const slots = await fetchSafely()
      const active = resolveActiveSlot(slots)
      if (active && active.id !== activeSlotId) {
        // Slot changed — stop current and play new
        stopPlayback()
        await playSlot(active)
      } else if (!active) {
        stopPlayback()
        setState('empty', 'No content scheduled')
      }
      scheduleNextBoundary()
    }, ms + 1000) // +1s buffer
  }

  async function playSlot(slot: ResolvedSlot): Promise<void> {
    if (slot.unresolved || !slot.ref) {
      setState('unresolved', 'Content unavailable')
      return
    }
    if (slot.type !== 'vod' || !slot.ref.cid) {
      setState('empty', 'Content not playable')
      return
    }

    activeSlotId = slot.id

    // Init node in background — playback starts gateway-only and P2P engages
    // once the node bootstraps; never block the viewer on bootstrap.
    if (!node) {
      createIberNode()
        .then((n) => {
          node = n
        })
        .catch(() => {
          node = null
        })
    }

    hls = new Hls({
      loader: createIberLoader(() => node, slot.ref.cid, stats),
      enableWorker: false,
      progressive: false
    })

    // opts.gateway (explicit, e.g. E2E) wins; otherwise resolve from ?gw= or
    // the default local subdomain gateway for this CID.
    const gateway =
      opts.gateway ? opts.gateway.replace(/\/+$/, '') : gatewayBase(slot.ref.cid)

    const masterUrl = `${gateway}/master.m3u8`
    hls.loadSource(masterUrl)
    if (video) hls.attachMedia(video)

    hls.on(
      Events.MANIFEST_PARSED,
      (_event: unknown, data: { levels: unknown[] }) => {
        if (window.__IBER__) window.__IBER__.levels = data.levels.length
        video?.play().catch(() => {})
        setState('playing', `Playing: ${slot.ref?.title ?? 'Unknown'}`)
      }
    )

    hls.on(
      Events.ERROR,
      (_evt: unknown, data: { fatal: boolean; type: string; details: string }) => {
        if (data.fatal) {
          setState('error', `Playback error: ${data.details}`)
        }
      }
    )
  }

  function stopPlayback(): void {
    if (hls) {
      hls.destroy()
      hls = null
    }
    activeSlotId = null
  }

  // --- Boot ---
  setState('loading', 'Loading schedule…')
  const slots = await fetchSafely()
  const active = resolveActiveSlot(slots)

  // The boundary timer re-checks every minute, so a failed/empty parrilla
  // recovers on its own once the backend or schedule appears. No crash loop.
  scheduleNextBoundary()

  if (!active) {
    setState('empty', 'No content scheduled')
    return
  }

  await playSlot(active)
}
