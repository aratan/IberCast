#!/usr/bin/env node
/**
 * IberCast — publicación persistente de vídeo en IPFS.
 *
 * Convierte un vídeo local a HLS, lo publica en tu nodo Kubo (add + pin
 * local) y lo pine de forma persistente en un servicio de pinning remoto,
 * para que sea accesible "siempre" incluso si apagas tu nodo.
 *
 * Uso:
 *   node scripts/publish.mjs --input <video.mp4>
 *      [--service <nombre>]     nombre del servicio remoto registrado (default: "default")
 *      [--skip-remote]          publica solo en local, sin pinning remoto
 *      [--out <dir>]            dir de trabajo para el HLS (default: /tmp/ibercast-publish)
 *      [--ffmpeg-sync]          forzar sync (evita -f hls bufferizado en codecs no TS)
 *      [--keep]                 no borrar dirs temporales al final
 *
 * Requiere:
 *   - `ipfs` (Kubo) en el PATH y daemon arrancado (127.0.0.1:5001)
 *   - `ffmpeg` en el PATH (para transcodificar a HLS)
 *   - Opcional: `ipfs pin remote service add` ya hecho para --service
 *
 * Ejemplo:
 *   node scripts/publish.mjs --input video.mp4 --service pinata
 */
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// --- utilidades -------------------------------------------------------------

function sh(cmd, { silent = false, inherit = true } = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
  if (r.status !== 0) {
    if (!silent)
      throw new Error(`fallo: ${cmd}\n${(r.stderr || '').toString().slice(0, 500)}`)
  }
  return {
    ok: r.status === 0,
    out: (r.stdout || '').toString(),
    err: (r.stderr || '').toString()
  }
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}

// --- pasos ------------------------------------------------------------------

function checkDeps() {
  const ipfs = sh('command -v ipfs', { silent: true, inherit: false })
  if (!ipfs.ok) throw new Error('No encuentro `ipfs` en el PATH. Instala Kubo.')
  const ffmpeg = sh('command -v ffmpeg', { silent: true, inherit: false })
  if (!ffmpeg.ok) throw new Error('No encuentro `ffmpeg` en el PATH.')
  const daemon = sh('ipfs id', { silent: true, inherit: false })
  if (!daemon.ok)
    throw new Error('El daemon de Kubo no responde en 127.0.0.1:5001. Arranca `ipfs daemon`.')
}

function transcode(input, workdir) {
  console.log('\n[1/4] Transcodificando a HLS…')
  const hls = join(workdir, 'hls')
  mkdirSync(join(hls, 'v0'), { recursive: true })
  const sync = flag('ffmpeg-sync') ? ['-fflags', '+genpts'] : []
  // h264 + aac → .ts (compatible pat. HLS; iOS/todos los navegadores)
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-i', input,
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      ...sync,
      '-hls_time', '6', '-hls_list_size', '0',
      '-hls_segment_filename', join(hls, 'v0', 'seg-%03d.ts'),
      '-f', 'hls', join(hls, 'index.m3u8')
    ],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) throw new Error('ffmpeg falló al transcodificar.')
  // estructura esperada: <root>/master.m3u8 + <root>/v0/seg-*.ts
  renameSync(join(hls, 'index.m3u8'), join(hls, 'master.m3u8'))
  // fijar rutas relativas del master a v0/seg-*.ts (ya lo genera ffmpeg)
  console.log(`  HLS en: ${hls}`)
  return hls
}

function publish(hls) {
  console.log('\n[2/4] Publicando en Kubo (add + pin local)…')
  const out = sh(`ipfs add -r -Q ${hls}`, { inherit: false })
  const cid = out.out.trim()
  if (!cid) throw new Error('ipfs add no devolvió un CID.')
  const pin = sh(`ipfs pin add "${cid}"`, { inherit: false })
  if (!pin.ok) throw new Error(`pin local falló: ${pin.err}`)
  console.log(`  rootCID = ${cid}`)
  return cid
}

function pinRemote(cid, service) {
  console.log(`\n[3/4] Pinning remoto (servicio: ${service})…`)
  const svc = sh(`ipfs pin remote service ls`, { silent: true, inherit: false })
  const names = new Set(
    (svc.out.match(/^([A-Za-z0-9_-]+)[:\s]/gm) || []).map((s) =>
      s.replace(/[:\s]/g, '').replace(':', '')
    )
  )
  if (!names.has(service)) {
    throw new Error(
      `El servicio remoto "${service}" no está registrado.\n` +
      '  Regístralo primero:\n' +
      `    ipfs pin remote service add ${service} <endpoint> <token>\n`
    )
  }
  const r = sh(
    `ipfs pin remote add --service=${service} --name=ibercast ${cid}`,
    { inherit: false }
  )
  if (!r.ok) throw new Error(`pinning remoto falló:\n${r.err}`)
  console.log(`  CID ${cid} pineado remotamente en "${service}".`)
  return true
}

function main() {
  const input = arg('input')
  if (!input) {
    console.error('Uso: node scripts/publish.mjs --input <video.mp4> [--service <nombre>]')
    process.exit(2)
  }
  if (!existsSync(input)) {
    console.error(`No existe: ${input}`)
    process.exit(2)
  }

  const keep = flag('keep')
  const workdir = arg('out') || mkdtempSync(join(tmpdir(), 'ibercast-publish-'))
  if (arg('out') && !existsSync(join(workdir, 'hls'))) mkdirSync(join(workdir, 'hls', 'v0'), { recursive: true })

  try {
    checkDeps()
    const hls = transcode(input, workdir)
    const cid = publish(hls)
    if (!flag('skip-remote')) {
      const service = arg('service', 'default')
      pinRemote(cid, service)
    } else {
      console.log('\n[3/4] Omitido: --skip-remote (solo local).')
    }
    console.log('\n[4/4] Hecho ✔')
    console.log('──────────────────────────────────────────────')
    console.log('  CID raíz:  ' + cid)
    console.log('  Player:    ' + `http://127.0.0.1:5173/?cid=${cid}&gw=${encodeURIComponent('http://127.0.0.1:8080')}`)
    console.log('  Gateway:   ' + `https://ipfs.io/ipfs/${cid}/master.m3u8`)
    console.log('──────────────────────────────────────────────')
    if (!keep && !arg('out')) rmSync(workdir, { recursive: true, force: true })
  } catch (e) {
    console.error(`\n✖ ${e.message}`)
    process.exit(1)
  }
}

main()
