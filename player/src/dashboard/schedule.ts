/**
 * ScheduleView: weekly parrilla grid with drag-from-catalogue and drop-on-slot.
 */
interface ScheduleSlot {
  id: string
  channelId: string
  dayOfWeek: number
  timeStart: string
  type: string
  ref: string | { id: string; title: string } | null
  unresolved?: boolean
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 16 }, (_, i) => `${String(i + 8).padStart(2, '0')}:00`) // 08:00–23:00

export function ScheduleView(
  container: HTMLElement,
  apiBase: string,
  channelId: string,
  token?: string
): { refresh: () => Promise<void> } {
  // Attach auth header if a token is configured (optional).
  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }
  // Split layout: picker (draggable videos) on the left, grid on the right.
  // Both must be visible simultaneously for HTML5 drag-and-drop to work.
  const layoutEl = document.createElement('div')
  layoutEl.className = 'schedule-layout'
  container.appendChild(layoutEl)

  const pickerEl = document.createElement('div')
  pickerEl.className = 'schedule-picker'
  layoutEl.appendChild(pickerEl)

  const sheetEl = document.createElement('div')
  sheetEl.className = 'schedule-sheet'
  layoutEl.appendChild(sheetEl)

  const gridEl = document.createElement('div')
  gridEl.className = 'schedule-grid'
  sheetEl.appendChild(gridEl)

  const toastEl = document.createElement('div')
  toastEl.className = 'schedule-toast hidden'
  sheetEl.appendChild(toastEl)

  function showToast(msg: string, isError = true): void {
    toastEl.textContent = msg
    toastEl.className = `schedule-toast ${isError ? 'err' : 'ok'}`
    setTimeout(() => (toastEl.className = 'schedule-toast hidden'), 3000)
  }

  async function fetchSlots(): Promise<ScheduleSlot[]> {
    // Fetch all days (0-6) and flatten
    const all: ScheduleSlot[] = []
    for (let day = 0; day < 7; day++) {
      try {
        const res = await fetch(`${apiBase}/api/parrilla?channelId=${channelId}&day=${day}`)
        if (!res.ok) continue
        const data: ScheduleSlot[] = await res.json()
        all.push(...data)
      } catch {
        // skip failed day
      }
    }
    return all
  }

  async function refresh(): Promise<void> {
    const slots = await fetchSlots()
    renderGrid(slots)
    renderPicker()
  }

  interface PickerVideo {
    id: string
    title: string
  }

  // Catalogue picker: compact draggable list so users can drop videos onto
  // the grid. The Catalogue tab is mutually exclusive with this panel, so a
  // sidebar inside the Parrilla tab is the only place both are visible.
  async function renderPicker(): Promise<void> {
    pickerEl.innerHTML = '<div class="schedule-picker-header">Catálogo · arrastra a una celda</div>'
    try {
      const res = await fetch(`${apiBase}/api/videos`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: unknown = await res.json()
      const videos: PickerVideo[] = Array.isArray(data) ? data : []
      if (videos.length === 0) {
        pickerEl.insertAdjacentHTML(
          'beforeend',
          '<div class="schedule-picker-empty">No hay vídeos. Súbelos en la pestaña <b>Catálogo</b>.</div>'
        )
        return
      }
      for (const v of videos) {
        const item = document.createElement('div')
        item.className = 'schedule-picker-item'
        item.dataset.id = v.id
        item.draggable = true
        item.title = v.title
        item.innerHTML = `<span class="schedule-picker-title">${escapeHtml(v.title)}</span>`
        item.addEventListener('dragstart', (e) => {
          const de = e as DragEvent
          de.dataTransfer?.setData('text/plain', v.id)
          de.dataTransfer?.setData('application/x-ibercast-video', v.id)
          if (de.dataTransfer) de.dataTransfer.effectAllowed = 'copy'
        })
        pickerEl.appendChild(item)
      }
    } catch {
      pickerEl.insertAdjacentHTML(
        'beforeend',
        '<div class="schedule-picker-empty">Error cargando vídeos.</div>'
      )
    }
  }

  function renderGrid(slots: ScheduleSlot[]): void {
    const slotMap = new Map<string, ScheduleSlot>()
    for (const s of slots) {
      slotMap.set(`${s.dayOfWeek}-${s.timeStart}`, s)
    }

    let html = '<div class="grid-header"><div class="corner"></div>'
    for (const d of DAYS) {
      html += `<div class="day-header">${d}</div>`
    }
    html += '</div>'

    for (const h of HOURS) {
      html += `<div class="hour-label">${h}</div>`
      for (let day = 0; day < 7; day++) {
        const slot = slotMap.get(`${day}-${h}`)
        const slotId = slot ? slot.id : ''
        const title = slot
          ? typeof slot.ref === 'object' && slot.ref
            ? slot.ref.title
            : typeof slot.ref === 'string'
              ? slot.ref
              : slot.unresolved
                ? '⚠ unavailable'
                : '—'
          : ''
        html += `<div class="grid-cell" data-day="${day}" data-time="${h}" data-slot-id="${slotId}" draggable="${slot ? 'true' : 'false'}">${title}</div>`
      }
    }
    gridEl.innerHTML = html

    // Drop targets
    gridEl.querySelectorAll('.grid-cell').forEach((cell) => {
      cell.addEventListener('dragover', (e) => {
        e.preventDefault()
        ;(cell as HTMLElement).classList.add('drop-hover')
      })
      cell.addEventListener('dragleave', () => {
        ;(cell as HTMLElement).classList.remove('drop-hover')
      })
      cell.addEventListener('drop', async (e) => {
        e.preventDefault()
        ;(cell as HTMLElement).classList.remove('drop-hover')
        const videoId = (e as DragEvent).dataTransfer?.getData('text/plain')
        if (!videoId) return
        const day = Number((cell as HTMLElement).dataset.day)
        const time = (cell as HTMLElement).dataset.time!
        const existingSlotId = (cell as HTMLElement).dataset.slotId

        if (existingSlotId) {
          // Overwrite existing slot
          await PUTSlot(existingSlotId, day, time, videoId)
        } else {
          // Create new slot
          await POSTSlot(day, time, videoId)
        }
        refresh()
      })
    })
  }

  async function POSTSlot(day: number, time: string, videoId: string): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/parrilla`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          channelId,
          dayOfWeek: day,
          timeStart: time,
          type: 'vod',
          ref: videoId
        })
      })
      if (res.status === 409) {
        showToast('Time slot conflict: overlapping entry exists')
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      showToast(`Schedule failed: ${(err as Error).message}`)
    }
  }

  async function PUTSlot(
    slotId: string,
    day: number,
    time: string,
    videoId: string
  ): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/parrilla/${slotId}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          channelId,
          dayOfWeek: day,
          timeStart: time,
          type: 'vod',
          ref: videoId
        })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      showToast(`Update failed: ${(err as Error).message}`)
    }
  }

  // Note: catalogue items set their own drag data in catalogue.ts (they live in a
  // sibling panel, so their dragstart does not bubble through this container).

  refresh()

  return { refresh }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
