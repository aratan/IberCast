#!/usr/bin/env node
/**
 * IberCast E2E harness (v3).
 *
 * Fase A (siempre): resuelve el DAG HLS por HTTP contra el gateway —
 * master -> playlists -> segmentos en paralelo con tope (--max-segments).
 * Demuestra el contrato CID + rutas relativas que usa el loader.
 *
 * Fase B (--browser): reproduce de verdad con playwright-core + chromium
 * headless y comprueba window.__IBER__ (manifiesto, metadata, stats).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

// Prefer Chrome for Testing / branded Chrome: open-source chromium builds
// lack proprietary codecs (H.264/AAC) and fail with fragParsingError on MSE.
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  `${process.env.HOME}/.local/bin/google-chrome`,
  `${process.env.HOME}/.local/bin/chromium`,
  'google-chrome',
  'chromium'
].filter(Boolean)

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) {
    const next = process.argv[i + 1]
    args[a.slice(2)] = next && !next.startsWith('--') ? next : true
  }
}

const CID = args.cid || 'QmdpAidwAsBGptFB3b6A9Pyi5coEbgjHrL3K2Qrsutmj9K' // Big Buck Bunny (ipfsvideo.cc)
const GATEWAY = args.gw || 'https://ipfs.io'
const ENTRY = args.path || 'master.m3u8'
const MAX_SEGMENTS = Number(args['max-segments'] ?? 8)
const CONCURRENCY = Number(args.concurrency || 6)
const DO_BROWSER = !!args.browser
const WAIT_S = Number(args.wait || 120)
const playerDir = resolve(args.playerDir || join(process.cwd(), 'player'))

const log = (m) => console.log(m)
let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function fetchUrl(url, timeoutMs = 30_000) {
  const res = spawnSync(
    'curl',
    ['-sSL', '--max-time', String(timeoutMs / 1000), '-D', '-', '-o', '-', url],
    { maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' }
  )

  if (res.error) {
    log(`(aviso: curl failed — ${res.error.message})`)
    return { status: 0, body: Buffer.alloc(0) }
  }

  const out = res.stdout ?? Buffer.alloc(0)
  const sep = out.indexOf('\r\n\r\n')
  const head = out.subarray(0, sep < 0 ? 0 : sep).toString()
  const body = out.subarray(sep < 0 ? 0 : sep + 4)
  const status = Number(head.split('\r\n')[0]?.match(/ (\d{3})/)?.[1] ?? 0)
  return { status, body }
}

async function mapPool(items, limit, fn) {
  const results = []
  let idx = 0
  const worker = async () => {
    while (idx < items.length) {
      const my = idx++
      results[my] = await fn(items[my], my)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// Fase A
// ---------------------------------------------------------------------------
log(`\n=== Fase A: DAG por gateway — ${GATEWAY}/ipfs/${CID}/${ENTRY} ===`)
{
  const { status, body } = fetchUrl(`${GATEWAY}/ipfs/${CID}/${ENTRY}`)
  check('playlist raíz', status === 200, `HTTP ${status}, ${body.length} B`)

  if (status === 200) {
    const master = body.toString()
    const entries = master
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))

    const segments = []
    if (master.includes('#EXT-X-STREAM-INF')) {
      for (const e of entries) {
        const { status: s2, body: b2 } = fetchUrl(`${GATEWAY}/ipfs/${CID}/${e}`)
        check(`media playlist ${e}`, s2 === 200, `HTTP ${s2}, ${b2.length} B`)
        if (s2 === 200) {
          const dir = e.includes('/') ? e.replace(/[^/]+$/, '') : ''
          for (const l of b2.toString().split('\n')) {
            const t = l.trim()
            if (t && !t.startsWith('#') && !/^https?:\/\//i.test(t) && !t.startsWith('/')) {
              segments.push(dir + t)
            }
          }
        }
      }
    } else {
      segments.push(...entries)
    }

    const capped = segments.slice(0, MAX_SEGMENTS)
    log(`segmentos: ${segments.length}; descargando ${capped.length} (concurrency ${CONCURRENCY})…`)

    const results = await mapPool(capped, CONCURRENCY, async (rel) => ({
      rel,
      ...fetchUrl(`${GATEWAY}/ipfs/${CID}/${rel}`)
    }))
    let okCount = 0
    let bytes = 0
    for (const r of results) {
      const ok = r.status === 200 && r.body.length > 0
      check(`segmento ${r.rel}`, ok, `HTTP ${r.status}, ${r.body.length} B`)
      if (ok) {
        okCount++
        bytes += r.body.length
      }
    }
    log(`Fase A: ${okCount}/${capped.length} segmentos OK, ${(bytes / 1024 / 1024).toFixed(2)} MB`)
  }
}

// ---------------------------------------------------------------------------
// Fase B — playwright-core + chromium headless
// ---------------------------------------------------------------------------
if (DO_BROWSER) {
  log('\n=== Fase B: reproducción real (playwright + chromium) ===')
  const distIndex = join(playerDir, 'dist', 'index.html')
  if (!existsSync(distIndex)) {
    check('build del player existe', false, `ejecuta: npm run build en ${playerDir}`)
    process.exit(1)
  }
  const chrome = CHROME_CANDIDATES.find((c) => existsSync(c) || !c.includes('/'))
  if (!chrome) {
    check('binario chromium', false, 'define CHROME_BIN')
    process.exit(1)
  }

  // Sanitize: block path traversal and only serve within dist/
  const DIST_ROOT = join(playerDir, 'dist')
  const server = createServer((req, res) => {
    const p = (req.url || '/').split('?')[0]
    if (p.includes('..')) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const file = join(DIST_ROOT, p === '/' ? 'index.html' : p)
    // Ensure resolved path stays within DIST_ROOT
    if (!file.startsWith(DIST_ROOT)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    try {
      const data = readFileSync(file)
      res.writeHead(200, {
        'content-type': file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.js')
            ? 'application/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream'
      })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('nope')
    }
  }).listen(0)

  const port = server.address().port
  const pageUrl = `http://127.0.0.1:${port}/?cid=${encodeURIComponent(CID)}&gw=${encodeURIComponent(GATEWAY)}`
  log(`player URL: ${pageUrl}`)

  // resolve playwright-core from the player's node_modules
  const require = createRequire(join(playerDir, 'package.json'))
  const { chromium } = require('playwright-core')

  // Workaround for environments with broken IPv6 (like this CI box): chromium
  // prefers AAAA records and fails where curl falls back to IPv4. Map the
  // hosts we need to their A records via --host-resolver-rules.
  let rules = []
  try {
    const dns = (await import('node:dns/promises')).default
    const hostsToForceV4 = [
      new URL(GATEWAY).host,
      'bootstrap.libp2p.io'
    ]
    for (const h of [...new Set(hostsToForceV4)]) {
      try {
        const addrs = await dns.resolve4(h)
        if (addrs[0]) rules.push(`MAP ${h} ${addrs[0]}`)
      } catch {
        log(`(aviso: no pude resolver IPv4 para ${h}; se deja al DNS del sistema)`)
      }
    }
  } catch {
    log('(aviso: node:dns/promises no disponible, omitiendo host-resolver-rules)')
  }
  const chromeArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required'
  ]
  if (rules.length) {
    chromeArgs.push(`--host-resolver-rules=${rules.join(', ')}`)
    log(`host-resolver-rules: ${rules.join(', ')}`)
  }

  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: chromeArgs
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') log(`[console.error] ${m.text().slice(0, 200)}`)
  })

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  const ok = await page.waitForFunction(
    () => window.__IBER__ && (window.__IBER__.ready || window.__IBER__.hlsError),
    { timeout: WAIT_S * 1000, polling: 1000 }
  ).then(() => true).catch(() => false)

  if (!ok) {
    check('window.__IBER__ resuelve (ready o error)', false, 'timeout esperando estado')
  } else {
    const iber = await page.evaluate(() => ({
      status: window.__IBER__.status,
      ready: window.__IBER__.ready,
      hlsError: window.__IBER__.hlsError,
      levels: window.__IBER__.levels,
      videoW: window.__IBER__.videoW,
      videoH: window.__IBER__.videoH,
      duration: window.__IBER__.duration,
      stats: { ...window.__IBER__.fetchStats }
    }))
    log(`status: "${iber.status}" | levels: ${iber.levels} | video: ${iber.videoW}x${iber.videoH} | dur: ${iber.duration?.toFixed?.(1) ?? '?'}s`)
    log(`fetchStats: p2p=${iber.stats.segmentsP2P} http=${iber.stats.segmentsHTTP} cache=${iber.stats.segmentsCache} bytesP2P=${iber.stats.bytesP2P} bytesHTTP=${iber.stats.bytesHTTP} last=${iber.stats.lastSource}`)
    check('sin errores HLS fatales', !iber.hlsError, iber.hlsError ?? '')
    check('metadata de vídeo lista', iber.ready && iber.videoW > 0, `${iber.videoW}x${iber.videoH}`)
    check('manifiesto con niveles', iber.levels > 0, `${iber.levels} niveles`)
    check('algún recurso cargado', (iber.stats.segmentsHTTP + iber.stats.segmentsP2P + iber.stats.segmentsCache) > 0)
  }

  await browser.close()
  server.close()
}

log(failures === 0 ? '\n🎉 E2E OK' : `\n💥 ${failures} check(s) fallidos`)
process.exit(failures === 0 ? 0 : 1)
