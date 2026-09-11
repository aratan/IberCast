/**
 * AdminLogin: token gate for admin dashboard.
 * Checks URL param ?token= or sessionStorage, shows login form if missing.
 * apiBase is the ibercastd endpoint used to validate the token (defaults to
 * the page origin, which forwards /api via the reverse proxy or dev proxy).
 */
export function requireAdminToken(apiBase?: string): Promise<string> {
  const base = apiBase || location.origin
  const params = new URLSearchParams(location.search)
  const urlToken = params.get('token')
  if (urlToken) {
    sessionStorage.setItem('ibercast-admin-token', urlToken)
    return Promise.resolve(urlToken)
  }

  const stored = sessionStorage.getItem('ibercast-admin-token')
  if (stored) return Promise.resolve(stored)

  // Show login form
  return new Promise<string>((resolve) => {
    const root = document.getElementById('admin-root')
    if (!root) return resolve('')

    root.innerHTML = `
      <div class="admin-login">
        <div class="admin-login-card">
          <h2>Iber<span>Cast</span> Admin</h2>
          <p>Introduce el token de administrador para acceder.</p>
          <form id="admin-login-form" class="admin-login-form">
            <input type="password" id="admin-token-input" placeholder="Token de administrador" autocomplete="off" />
            <button type="submit">Entrar</button>
          </form>
          <div class="admin-login-error" id="admin-login-error"></div>
        </div>
      </div>
    `

    const form = document.getElementById('admin-login-form') as HTMLFormElement
    const input = document.getElementById('admin-token-input') as HTMLInputElement
    const errorEl = document.getElementById('admin-login-error') as HTMLElement

    input.focus()

    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const token = input.value.trim()
      if (!token) {
        errorEl.textContent = 'Introduce un token.'
        return
      }

      // Validate token by hitting a protected endpoint
      try {
        const res = await fetch(`${base}/api/videos`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: '{}'
        })
        // 400 = token valid but bad body, 401/403 = bad token
        if (res.status === 401 || res.status === 403) {
          errorEl.textContent = 'Token no válido.'
          return
        }
        // Any other response (even 400) means auth passed
        sessionStorage.setItem('ibercast-admin-token', token)
        // Update URL without reload
        const url = new URL(location.href)
        url.searchParams.set('token', token)
        history.replaceState(null, '', url.toString())
        resolve(token)
      } catch {
        errorEl.textContent = 'Error de conexión al validar token.'
      }
    })
  })
}

export function getStoredToken(): string | null {
  return sessionStorage.getItem('ibercast-admin-token')
}

export function clearToken(): void {
  sessionStorage.removeItem('ibercast-admin-token')
  const url = new URL(location.href)
  url.searchParams.delete('token')
  history.replaceState(null, '', url.toString())
}
