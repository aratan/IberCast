/**
 * CatalogueView: fetch and display all videos, plus upload form.
 */
export interface CatalogueVideo {
  id: string
  title: string
  cid: string
  hlsUrl: string
  duration: number
  channelId?: string
  thumbnailUrl?: string
}

export interface CatalogueChannel {
  id: string
  name: string
}

const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov', '.ts', '.m3u8', '.mpg', '.mpeg'])
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MiB — align with backend default

export function CatalogueView(
  container: HTMLElement,
  apiBase: string,
  token?: string
): { refresh: () => Promise<void> } {
  // Attach auth header if a token is configured (optional).
  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }
  const listEl = document.createElement('div')
  listEl.className = 'catalogue-list'
  container.appendChild(listEl)

  const uploadForm = document.createElement('form')
  uploadForm.className = 'catalogue-upload'
  uploadForm.innerHTML = `
    <input type="text" placeholder="Title" name="title" />
    <select name="channel" class="upload-channel" title="Canal del vídeo">
      <option value="default" selected>Canal: IberCast</option>
      <option value="peliculas">Canal: Películas</option>
      <option value="noticias">Canal: Noticias</option>
    </select>
    <div class="upload-drop-zone" role="button" tabindex="0">
      <span class="drop-hint">Drag a video here or click to browse</span>
      <input type="file" name="file" accept="video/*" class="drop-file-input" />
    </div>
    <button type="submit">Upload</button>
    <span class="upload-status"></span>
  `
  container.appendChild(uploadForm)

  // Populate the channel selector from the API (seed values above as fallback).
  void (async () => {
    try {
      const res = await fetch(`${apiBase}/api/channels`)
      if (!res.ok) return
      const channels: CatalogueChannel[] = await res.json()
      const select = uploadForm.querySelector('select[name="channel"]') as HTMLSelectElement
      const current = select.value
      select.innerHTML = channels
        .map((ch) => `<option value="${escapeHtml(ch.id)}">Canal: ${escapeHtml(ch.name)}</option>`)
        .join('')
      if (channels.some((ch) => ch.id === current)) select.value = current
    } catch { /* keep static fallback options */ }
  })()

  const statusEl = uploadForm.querySelector('.upload-status') as HTMLSpanElement
  const dropZone = uploadForm.querySelector('.upload-drop-zone') as HTMLElement
  const fileInput = dropZone.querySelector('input[type="file"]') as HTMLInputElement
  let pendingFile: File | null = null

  // Click to browse
  dropZone.addEventListener('click', () => fileInput.click())
  dropZone.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click() }
  })

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      acceptFile(fileInput.files[0])
    }
  })

  function acceptFile(file: File): void {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
      statusEl.textContent = `Rejected: "${ext}" is not a supported video format`
      statusEl.className = 'upload-status err'
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      statusEl.textContent = `Rejected: file exceeds ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MiB limit`
      statusEl.className = 'upload-status err'
      return
    }
    pendingFile = file
    dropZone.querySelector('.drop-hint')!.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MiB)`
    statusEl.textContent = ''
    statusEl.className = 'upload-status'
  }

  // Drag-drop upload zone
  dropZone.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); dropZone.classList.add('drag-over') })
  dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over') })
  dropZone.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    dropZone.classList.remove('drag-over')
    const file = e.dataTransfer?.files?.[0]
    if (file) acceptFile(file)
  })

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
      <div class="catalogue-item" data-id="${v.id}" draggable="true">
        ${v.thumbnailUrl ? `<div class="catalogue-thumb" style="background-image:url('${escapeHtml(v.thumbnailUrl)}')"></div>` : ''}
        <div class="catalogue-info">
          <div class="catalogue-title">${escapeHtml(v.title)}</div>
          <div class="catalogue-meta">${escapeHtml(v.channelId || 'default')} · ${formatDuration(v.duration)} · ${v.cid.slice(0, 12)}…</div>
        </div>
        <button class="catalogue-delete" data-id="${v.id}" title="Delete">✕</button>
      </div>
    `
      )
      .join('')

    listEl.querySelectorAll('.catalogue-item').forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        const dragEvent = e as DragEvent
        const id = (item as HTMLElement).dataset.id!
        dragEvent.dataTransfer?.setData('text/plain', id)
        dragEvent.dataTransfer?.setData('application/x-ibercast-video', id)
        if (dragEvent.dataTransfer) dragEvent.dataTransfer.effectAllowed = 'copy'
      })
    })

    listEl.querySelectorAll('.catalogue-delete').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const id = (e.target as HTMLElement).dataset.id!
        await fetch(`${apiBase}/api/videos/${id}`, { method: 'DELETE', headers: authHeaders() })
        refresh()
      })
    })
  }

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const title = ((uploadForm.querySelector('input[name="title"]') as HTMLInputElement).value || '').trim()
    const file = pendingFile ?? fileInput.files?.[0] ?? null
    if (!file) {
      statusEl.textContent = 'Select a video file first'
      statusEl.className = 'upload-status err'
      return
    }
    if (!title) {
      statusEl.textContent = 'Title is required'
      statusEl.className = 'upload-status err'
      return
    }
    statusEl.textContent = 'Uploading…'
    statusEl.className = 'upload-status busy'
    const formData = new FormData()
    formData.append('title', title)
    const channel = (uploadForm.querySelector('select[name="channel"]') as HTMLSelectElement).value || 'default'
    formData.append('channelId', channel)
    formData.append('file', file, file.name)
    try {
      // Note: do NOT set Content-Type manually — fetch sets the multipart boundary.
      const res = await fetch(`${apiBase}/api/videos`, { method: 'POST', body: formData, headers: authHeaders() })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      statusEl.textContent = 'Upload complete'
      statusEl.className = 'upload-status ok'
      pendingFile = null
      fileInput.value = ''
      dropZone.querySelector('.drop-hint')!.textContent = 'Drag a video here or click to browse'
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
