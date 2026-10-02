import { requireAdminSession } from './login'

const root = document.getElementById('admin-root')
if (root) {
  requireAdminSession(location.origin).then((_sess) => {
    // Redirect to admin dashboard
    const url = new URL('/admin/', location.href)
    location.href = url.toString()
  })
}
