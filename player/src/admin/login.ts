/**
 * AdminLogin: session-based auth gate for admin dashboard.
 * Uses /api/auth/login with cookies + CSRF. Stores CSRF and user info.
 */
export interface AuthSession {
  user: { id: string; username: string; role: string }
  csrf: string
}

export function getSession(): AuthSession | null {
  const raw = sessionStorage.getItem('ibercast-session')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function setSession(s: AuthSession): void {
  sessionStorage.setItem('ibercast-session', JSON.stringify(s))
}

export function clearSession(): void {
  sessionStorage.removeItem('ibercast-session')
}

export function getCSRF(): string | null {
  return getSession()?.csrf ?? null
}

export function requireAdminSession(apiBase?: string): Promise<AuthSession> {
  const base = apiBase || location.origin
  const existing = getSession()
  if (existing) return Promise.resolve(existing)

  return new Promise<AuthSession>((resolve) => {
    const root = document.getElementById('admin-root')
    if (!root) return resolve(existing!)

    root.innerHTML = `
      <div class="admin-login">
        <div class="admin-login-card">
          <h2>Iber<span>Cast</span> Admin</h2>
          <form id="admin-login-form" class="admin-login-form">
            <input type="text" id="admin-user" placeholder="Usuario" autocomplete="username" />
            <input type="password" id="admin-pass" placeholder="Contraseña" autocomplete="current-password" />
            <button type="submit">Entrar</button>
          </form>
          <div class="admin-login-error" id="admin-login-error"></div>
        </div>
      </div>
    `

    const form = document.getElementById('admin-login-form') as HTMLFormElement
    const userInput = document.getElementById('admin-user') as HTMLInputElement
    const passInput = document.getElementById('admin-pass') as HTMLInputElement
    const errorEl = document.getElementById('admin-login-error') as HTMLElement
    userInput.focus()

    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const username = userInput.value.trim()
      const password = passInput.value
      if (!username || !password) {
        errorEl.textContent = 'Introduce usuario y contraseña'
        return
      }
      try {
        const res = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username, password })
        })
        if (!res.ok) {
          errorEl.textContent = 'Credenciales inválidas'
          return
        }
        const sess: AuthSession = await res.json()
        setSession(sess)
        resolve(sess)
      } catch {
        errorEl.textContent = 'Error de conexión'
      }
    })
  })
}

// Backwards compat
export function requireAdminToken(_apiBase?: string): Promise<string> {
  return requireAdminSession(_apiBase).then(() => 'session')
}
