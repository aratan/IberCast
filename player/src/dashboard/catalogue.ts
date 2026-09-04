/**
 * CatalogueView: fetch and display all videos, plus upload form.
 */
export interface CatalogueVideo {
  id: string
  title: string
  cid: string
  hlsUrl: string
  duration: number
  thumbnailUrl?: string
}

export function CatalogueView(
  container: HTMLElement,
  apiBase: string
): { refresh: () => Promise<void> } {
  const listEl = document.createElement('div')
  listEl.className = 'catalogue-list'
  container.appendChild(listEl)

  const uploadForm = document.createElement('form')
  uploadForm.className = 'catalogue-upload'
  uploadForm.innerHTML = `
    <input type="text" placeholder="Title" name="title" />
    <input type="file" name="file" accept="video/*" />
    <button type="submit">Upload</button>
    <span class="upload-status"></span>
  `
  container.appendChild(uploadForm)

  const statusEl = uploadForm.querySelector('.upload-status') as HTMLSpanElement

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/videos`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const videos: CatalogueVideo[] = await res.json()
      renderList(videos)
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state">Failed to load videos: ${(e as Error).message}</div>`
    }
  }

  function renderList(videos: CatalogueVideo[]): void {
    if (videos.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No videos yet</div>'
      return
    }
    listEl.innerHTML = videos
      .map(
        (v) => `
      <div class="catalogue-item" data-id="${v.id}">
        <div class="catalogue-title">${escapeHtml(v.title)}</div>
        <div class="catalogue-meta">${formatDuration(v.duration)} · ${v.cid.slice(0, 12)}…</div>
        <button class="catalogue-delete" data-id="${v.id}">✕</button>
      </div>
    `
      )
      .join('')

    listEl.querySelectorAll('.catalogue-delete').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const id = (e.target as HTMLElement).dataset.id!
        await fetch(`${apiBase}/api/videos/${id}`, { method: 'DELETE' })
        refresh()
      })
    })
  }

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    statusEl.textContent = 'Uploading…'
    statusEl.className = 'upload-status busy'
    const formData = new FormData(uploadForm)
    try {
      const res = await fetch(`${apiBase}/api/videos`, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      statusEl.textContent = 'Upload complete'
      statusEl.className = 'upload-status ok'
      uploadForm.reset()
      refresh()
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`
      statusEl.className = 'upload-status err'
    }
  })

  refresh()

  return { refresh }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
