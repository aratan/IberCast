import { CatalogueView } from './catalogue'
import { ScheduleView } from './schedule'

/**
 * Dashboard: composes catalogue + schedule views inside the dashboard container.
 */
export function DashboardView(rootEl: HTMLElement, apiBase: string): void {
  // Create tab navigation
  const tabs = document.createElement('div')
  tabs.className = 'dashboard-tabs'
  tabs.innerHTML = `
    <button class="tab active" data-tab="catalogue">Catalogue</button>
    <button class="tab" data-tab="schedule">Schedule</button>
  `
  rootEl.appendChild(tabs)

  // View containers
  const catalogueContainer = document.createElement('div')
  catalogueContainer.className = 'dashboard-view active'
  catalogueContainer.id = 'catalogue-view'
  rootEl.appendChild(catalogueContainer)

  const scheduleContainer = document.createElement('div')
  scheduleContainer.className = 'dashboard-view'
  scheduleContainer.id = 'schedule-view'
  rootEl.appendChild(scheduleContainer)

  // Channel selector (simplified — single channel for now)
  const channelSelector = document.createElement('div')
  channelSelector.className = 'channel-selector'
  channelSelector.innerHTML = `
    <label>Channel:</label>
    <select id="channel-select">
      <option value="default" selected>Default</option>
    </select>
  `
  rootEl.insertBefore(channelSelector, tabs)

  let currentChannel = 'default'
  let catalogueRefresh: (() => Promise<void>) | null = null
  let scheduleRefresh: (() => Promise<void>) | null = null

  // Load channels
  async function loadChannels(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/channels`)
      if (!res.ok) return
      const channels: Array<{ id: string; name: string }> = await res.json()
      const select = rootEl.querySelector('#channel-select') as HTMLSelectElement
      select.innerHTML = channels
        .map(
          (ch) =>
            `<option value="${ch.id}" ${ch.id === currentChannel ? 'selected' : ''}>${escapeHtml(ch.name)}</option>`
        )
        .join('')
      select.addEventListener('change', () => {
        currentChannel = select.value
        rebuildSchedule()
      })
    } catch {
      // keep default
    }
  }

  function rebuildSchedule(): void {
    scheduleContainer.innerHTML = ''
    scheduleRefresh = null
    const view = ScheduleView(scheduleContainer, apiBase, currentChannel)
    scheduleRefresh = view.refresh
  }

  // Init catalogue
  const catView = CatalogueView(catalogueContainer, apiBase)
  catalogueRefresh = catView.refresh

  // Init schedule
  const schedView = ScheduleView(scheduleContainer, apiBase, currentChannel)
  scheduleRefresh = schedView.refresh

  // Tab switching
  tabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement | null
    if (!tab) return
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')
    const name = tab.dataset.tab!
    rootEl.querySelectorAll('.dashboard-view').forEach((v) => v.classList.remove('active'))
    rootEl.querySelector(`#${name}-view`)?.classList.add('active')
    // Refresh on tab switch
    if (name === 'catalogue') catalogueRefresh?.()
    if (name === 'schedule') scheduleRefresh?.()
  })

  loadChannels()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
