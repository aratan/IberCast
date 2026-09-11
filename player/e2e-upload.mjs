// E2E: upload a video through the dashboard form and verify it appears in
// the catalogue; then load viewer mode and report its state.
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: '/home/victor/.local/bin/chromium',
  args: ['--no-sandbox']
})

// --- Part 1: dashboard upload ---
const page = await browser.newPage()
const logs = []
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`) })

await page.goto('http://localhost:4173/?mode=dashboard&api=http://localhost:8585&token=e2e-test', { waitUntil: 'networkidle' })

await page.setInputFiles('input[name="file"]', '/tmp/sample.mp4')
await page.fill('input[name="title"]', 'E2E Upload')
await page.click('.catalogue-upload button[type="submit"]')

// Wait for either the OK status or an error
const statusEl = page.locator('.upload-status')
const deadline = Date.now() + 60000
let finalStatus = ''
while (Date.now() < deadline) {
  finalStatus = (await statusEl.textContent()) ?? ''
  if (/complete|error/i.test(finalStatus)) break
  await page.waitForTimeout(500)
}
console.log('upload status:', finalStatus)

// Wait for catalogue refresh
await page.waitForTimeout(1500)
const items = await page.locator('.catalogue-item').count()
console.log('catalogue items:', items)

// --- Part 2: viewer mode ---
const page2 = await browser.newPage()
const logs2 = []
page2.on('pageerror', (e) => logs2.push(`[pageerror] ${e.message}`))
await page2.goto('http://localhost:4173/?mode=viewer&api=http://localhost:8585', { waitUntil: 'networkidle' })
await page2.waitForTimeout(3000)
const viewer = await page2.evaluate(() => ({
  viewerVisible: getComputedStyle(document.getElementById('viewer')).display,
  statusText: document.getElementById('status-viewer')?.textContent ?? null,
  playout: window.__IBER__ ? { state: window.__IBER__.playoutState, status: window.__IBER__.status, err: window.__IBER__.hlsError } : null
}))
console.log('viewer state:', JSON.stringify(viewer, null, 2))

console.log('--- dashboard page errors:', logs.length ? logs : 'none')
console.log('--- viewer page errors:', logs2.length ? logs2 : 'none')

await browser.close()
