/**
 * AdminDashboard: main admin panel with stats + tabs (Catalogue, Schedule, Live).
 */
import { CatalogueView } from '../dashboard/catalogue'
import { ScheduleView } from '../dashboard/schedule'
import { clearSession } from './login'
import { openPlayer } from '../player-modal'

interface VideoSummary {
  id: string
  title: string
  cid: string
  duration: number
}

interface ChannelSummary {
  id: string
  name: string
}

interface SlotSummary {
  id: string
  channelId: string
  dayOfWeek: number
  timeStart: string
}

interface LiveSummary {
  id: string
  channelId?: string
  title: string
  status: string
  streamKey?: string
  rtmpUrl?: string
  hlsUrl?: string
}

export function AdminDashboard(rootEl: HTMLElement, apiBase: string, token: string): void {
  rootEl.innerHTML = ''

  // Top bar
  const topbar = document.createElement('div')
  topbar.className = 'admin-topbar'
  topbar.innerHTML = `
    <div class="admin-topbar-brand">Iber<span>Cast</span> Admin</div>
    <div class="admin-topbar-actions">
      <a href="?mode=wall${apiBase && apiBase !== location.origin ? `&api=${encodeURIComponent(apiBase)}` : ''}" class="admin-topbar-link">Ver muro público</a>
      <button class="admin-topbar-logout" id="admin-logout">Cerrar sesión</button>
    </div>
  `
  rootEl.appendChild(topbar)

  document.getElementById('admin-logout')?.addEventListener('click', () => {
    clearSession(); sessionStorage.clear(); location.reload()
    location.reload()
  })

  // Stats cards
  const statsRow = document.createElement('div')
  statsRow.className = 'admin-stats'
  statsRow.id = 'admin-stats'
  rootEl.appendChild(statsRow)

  // Tabs
  const tabs = document.createElement('div')
  tabs.className = 'admin-tabs'
  tabs.innerHTML = `
    <button class="admin-tab active" data-tab="catalogue">Catálogo</button>
    <button class="admin-tab" data-tab="schedule">Parrilla</button>
    <button class="admin-tab" data-tab="live">En vivo</button>
  `
  rootEl.appendChild(tabs)

  // Tab content containers
  const tabContent = document.createElement('div')
  tabContent.className = 'admin-tab-content'

  const catalogueContainer = document.createElement('div')
  catalogueContainer.className = 'admin-panel active'
  catalogueContainer.id = 'panel-catalogue'

  const scheduleContainer = document.createElement('div')
  scheduleContainer.className = 'admin-panel'
  scheduleContainer.id = 'panel-schedule'

  const liveContainer = document.createElement('div')
  liveContainer.className = 'admin-panel'
  liveContainer.id = 'panel-live'

  tabContent.appendChild(catalogueContainer)
  tabContent.appendChild(scheduleContainer)
  tabContent.appendChild(liveContainer)
  rootEl.appendChild(tabContent)

  // Channel selector
  const channelBar = document.createElement('div')
  channelBar.className = 'admin-channel-bar'
  channelBar.innerHTML = `<label>Canal:</label><select id="admin-channel-select"><option value="default" selected>Default</option></select>`
  tabContent.insertBefore(channelBar, scheduleContainer)

  let currentChannel = 'default'

  // Task 3.2.1 — error toast when backend is unreachable.
  function showBackendToast(): void {
    if (document.getElementById('admin-backend-toast')) return
    const toast = document.createElement('div')
    toast.id = 'admin-backend-toast'
    toast.className = 'admin-backend-toast'
    toast.textContent = '⚠️ Backend no disponible — comprueba que ibercastd esté en marcha'
    rootEl.insertBefore(toast, rootEl.querySelector('.admin-stats') ?? topbar.nextSibling)
  }

  // Load stats
  async function loadStats(): Promise<void> {
    try {
      const [videosRes, channelsRes] = await Promise.all([
        fetch(`${apiBase}/api/videos`),
        fetch(`${apiBase}/api/channels`)
      ])
      const videos: VideoSummary[] = videosRes.ok ? await videosRes.json() : []
      const channels: ChannelSummary[] = channelsRes.ok ? await channelsRes.json() : []

      // Load all schedule slots
      let totalSlots = 0
      for (let day = 0; day < 7; day++) {
        try {
          const res = await fetch(`${apiBase}/api/parrilla?channelId=${currentChannel}&day=${day}`)
          if (res.ok) {
            const slots: SlotSummary[] = await res.json()
            totalSlots += slots.length
          }
        } catch { /* skip */ }
      }

      statsRow.innerHTML = `
        <div class="admin-stat-card">
          <div class="admin-stat-value">${videos.length}</div>
          <div class="admin-stat-label">Videos</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-value">${channels.length}</div>
          <div class="admin-stat-label">Canales</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-value">${totalSlots}</div>
          <div class="admin-stat-label">Slots programados</div>
        </div>
      `
    } catch {
      statsRow.innerHTML = `<div class="admin-stat-card"><div class="admin-stat-value">—</div><div class="admin-stat-label">Error cargando stats</div></div>`
      showBackendToast()
    }
  }

  // Load channels
  async function loadChannels(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/channels`)
      if (!res.ok) return
      const channels: ChannelSummary[] = await res.json()
      const select = document.getElementById('admin-channel-select') as HTMLSelectElement
      select.innerHTML = channels
        .map((ch) => `<option value="${ch.id}" ${ch.id === currentChannel ? 'selected' : ''}>${escapeHtml(ch.name)}</option>`)
        .join('')
      select.addEventListener('change', () => {
        currentChannel = select.value
        rebuildSchedule()
        loadStats()
      })
    } catch { /* keep default */ }
  }

  // Init catalogue (admin mode — with auth)
  let catalogueRefresh: (() => Promise<void>) | null = null
  let scheduleRefresh: (() => Promise<void>) | null = null

  const catView = CatalogueView(catalogueContainer, apiBase, token)
  catalogueRefresh = catView.refresh

  function rebuildSchedule(): void {
    scheduleContainer.innerHTML = ''
    scheduleRefresh = null
    const view = ScheduleView(scheduleContainer, apiBase, currentChannel, token)
    scheduleRefresh = view.refresh
  }

  const schedView = ScheduleView(scheduleContainer, apiBase, currentChannel, token)
  scheduleRefresh = schedView.refresh

  // Live streams panel
  renderLivePanel(liveContainer, apiBase, token)

  // Tab switching
  tabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.admin-tab') as HTMLElement | null
    if (!tab) return
    tabs.querySelectorAll('.admin-tab').forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')
    const name = tab.dataset.tab!
    rootEl.querySelectorAll('.admin-panel').forEach((v) => v.classList.remove('active'))
    document.getElementById(`panel-${name}`)?.classList.add('active')
    if (name === 'catalogue') catalogueRefresh?.()
    if (name === 'schedule') scheduleRefresh?.()
  })

  loadChannels()
  loadStats()
}

function renderLivePanel(container: HTMLElement, apiBase: string, token: string): void {
  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  container.innerHTML = `
    <div class="admin-live-header">
      <h4>Streams en vivo</h4>
      <button class="admin-live-create" id="live-create-btn">+ Nuevo stream</button>
    </div>
    <div class="admin-live-list" id="live-list">
      <div class="empty-state">Cargando streams…</div>
    </div>
  `

  const listEl = document.getElementById('live-list')!

  async function loadLive(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/live`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: unknown = await res.json()
      const streams: LiveSummary[] = Array.isArray(data) ? data : []
      if (streams.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No hay streams en vivo. Crea uno con el botón de arriba.</div>'
        return
      }
      listEl.innerHTML = streams
        .map(
          (s) => `
        <div class="admin-live-item">
          <div class="admin-live-top">
            <div class="admin-live-info">
              <span class="admin-live-title">${escapeHtml(s.title)}</span>
              <span class="admin-live-status admin-live-status--${s.status}">${s.status === 'live' ? 'LIVE' : escapeHtml(s.status)}</span>
              ${s.channelId ? `<span class="admin-live-channel">${escapeHtml(s.channelId)}</span>` : ''}
            </div>
            <button class="admin-live-delete" data-id="${s.id}">✕</button>
          </div>
          ${s.streamKey && s.rtmpUrl ? `
          <div class="admin-live-creds">
            <div><span class="admin-live-label">Server OBS:</span> <code>${escapeHtml(s.rtmpUrl.replace(/\/[A-Za-z0-9_]+$/, ''))}</code>
              <button class="admin-live-copy" data-copy="${escapeHtml(s.rtmpUrl.replace(/\/[A-Za-z0-9_]+$/, ''))}" title="Copiar server">Copiar</button></div>
            <div><span class="admin-live-label">Clave (Stream Key):</span> <code>${escapeHtml(s.streamKey)}</code>
              <button class="admin-live-copy" data-copy="${escapeHtml(s.streamKey)}" title="Copiar clave">Copiar</button></div>
          </div>
          ${s.status === 'live' && s.hlsUrl ? `<button class="admin-live-watch" data-id="${s.id}" data-title="${escapeHtml(s.title)}" data-url="${escapeHtml(s.hlsUrl)}">▶ Ver en directo</button>` : ''}
          ` : ''}
        </div>
      `
        )
        .join('')

      listEl.querySelectorAll('.admin-live-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLElement).dataset.id!
          const res = await fetch(`${apiBase}/api/live/${id}`, { method: 'DELETE', headers: authHeaders() })
          if (!res.ok) alert(`Error al borrar (HTTP ${res.status})`)
          loadLive()
        })
      })

      listEl.querySelectorAll('.admin-live-copy').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const val = (btn as HTMLElement).dataset.copy ?? ''
          try {
            await navigator.clipboard.writeText(val)
            const old = (btn as HTMLElement).textContent
            ;(btn as HTMLElement).textContent = '✓'
            setTimeout(() => ((btn as HTMLElement).textContent = old), 1200)
          } catch {
            /* clipboard unavailable */
          }
        })
      })

      listEl.querySelectorAll('.admin-live-watch').forEach((btn) => {
        btn.addEventListener('click', () => {
          const el = btn as HTMLElement
          openPlayer({
            id: el.dataset.id!,
            title: el.dataset.title!,
            cid: '',
            hlsUrl: el.dataset.url!,
            duration: 0
          })
        })
      })
    } catch {
      listEl.innerHTML = '<div class="empty-state">Error cargando streams</div>'
    }
  }

  document.getElementById('live-create-btn')?.addEventListener('click', async () => {
    const title = prompt('Título del stream en vivo:')
    if (!title) return
    try {
      const res = await fetch(`${apiBase}/api/live`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title, channelId: 'default' })
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        alert(`Error al crear el stream (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
        return
      }
      loadLive()
    } catch (e) {
      alert(`Error: ${(e as Error).message}`)
    }
  })

  loadLive()
  setInterval(loadLive, 10000)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}
