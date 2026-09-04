import { createIberLoader, newFetchStats, type FetchStats } from '../loader'
import { createIberNode, type IberNode } from '../node'

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

interface PlayoutCallbacks {
  onState?: (state: PlayoutState, message: string) => void
}

/**
 * Init playout: fetch parrilla, resolve active time slot, play via createIberLoader.
 * Re-resolves at each slot boundary.
 */
export async function initPlayout(
  channelId: string,
  apiBase: string,
  callbacks: PlayoutCallbacks = {}
): Promise<void> {
  const video = document.getElementById('video') as HTMLVideoElement | null
  if (!video) return

  const stats: FetchStats = newFetchStats()
  let node: IberNode | null = null
  let hls: ReturnType<typeof import('hls.js').default.prototype['destroy']> extends never
    ? unknown
    : InstanceType<typeof import('hls.js').default> | null = null
  let activeSlotId: string | null = null
  let boundaryTimer: ReturnType<typeof setTimeout> | null = null

  function setState(state: PlayoutState, msg: string): void {
    callbacks.onState?.(state, msg)
  }

  async function fetchParrilla(): Promise<ResolvedSlot[]> {
    const now = new Date()
    const day = now.getDay()
    const url = `${apiBase}/api/parrilla?channelId=${encodeURIComponent(channelId)}&day=${day}`
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      setState('error', 'No schedule available')
      return []
    }
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

  function scheduleNextBoundary(): void {
    if (boundaryTimer) clearTimeout(boundaryTimer)
    const now = new Date()
    const nextMinute = new Date(now)
    nextMinute.setSeconds(0, 0)
    nextMinute.setMinutes(nextMinute.getMinutes() + 1)
    const ms = nextMinute.getTime() - now.getTime()
    boundaryTimer = setTimeout(async () => {
      const slots = await fetchParrilla()
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

    // Init node if needed
    if (!node) {
      try {
        node = await createIberNode()
      } catch {
        // Gateway-only fallback
        node = null
      }
    }

    const Hls = (await import('hls.js')).default
    hls = new Hls({
      loader: createIberLoader(node, slot.ref.cid, stats),
      enableWorker: false,
      progressive: false
    })

    const masterUrl = `https://ipfs.io/ipfs/${slot.ref.cid}/master.m3u8`
    hls.loadSource(masterUrl)
    if (video) hls.attachMedia(video)

    hls.on(
      (await import('hls.js')).Events.MANIFEST_PARSED,
      () => {
        video?.play().catch(() => {})
        setState('playing', `Playing: ${slot.ref?.title ?? 'Unknown'}`)
      }
    )

    hls.on(
      (await import('hls.js')).Events.ERROR,
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
  const slots = await fetchParrilla()
  const active = resolveActiveSlot(slots)

  if (!active) {
    setState('empty', 'No content scheduled')
    return
  }

  await playSlot(active)
  scheduleNextBoundary()
}
