#!/usr/bin/env node
/**
 * IberCast — pinning remoto de CIDs publicados.
 *
 * Permite pinear un CID en un servicio remoto de pinning (Pinata, Filebase,
 * Storacha, etc.) para que el contenido sea accesible incluso si el nodo
 * local se apaga.
 *
 * Uso:
 *   node scripts/pin-remote.mjs --cid <cid> --service <nombre> [--name <etiqueta>]
 *
 * Requiere que el servicio esté registrado previamente con:
 *   ipfs pin remote service add <nombre> <endpoint> <token>
 *
 * Ejemplo:
 *   node scripts/pin-remote.mjs --cid Qm... --service pinata --name "ibercast-video-1"
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) {
    const next = process.argv[i + 1]
    args[a.slice(2)] = next && !next.startsWith('--') ? next : true
  }
}

function arg(name, def) {
  return args[name] !== undefined ? args[name] : def
}

function sh(cmd, { silent = false } = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8'
  })
  if (r.status !== 0 && !silent) {
    throw new Error(`fallo: ${cmd}\n${(r.stderr || '').toString().slice(0, 500)}`)
  }
  return {
    ok: r.status === 0,
    out: (r.stdout || '').toString(),
    err: (r.stderr || '').toString()
  }
}

function main() {
  const cid = arg('cid')
  const service = arg('service', 'default')
  const name = arg('name', 'ibercast')

  if (!cid) {
    console.error('Uso: node scripts/pin-remote.mjs --cid <cid> [--service <nombre>] [--name <etiqueta>]')
    process.exit(2)
  }

  // Verificar que ipfs está disponible
  const ipfsCheck = sh('command -v ipfs', { silent: true })
  if (!ipfsCheck.ok) {
    console.error('No se encuentra `ipfs` en el PATH. Instala Kubo.')
    process.exit(1)
  }

  // Verificar que el servicio existe
  const svcList = sh(`ipfs pin remote service ls`, { silent: true })
  if (!svcList.ok) {
    console.error('No se puede conectar al daemon de IPFS. Asegúrate de que está corriendo.')
    process.exit(1)
  }

  const services = svcList.out
    .split('\n')
    .map(line => line.split(/[:\s]/)[0])
    .filter(Boolean)

  if (!services.includes(service)) {
    console.error(`El servicio "${service}" no está registrado.`)
    console.error(`Registra un servicio primero:\n  ipfs pin remote service add ${service} <endpoint> <token>\n\nServicios disponibles: ${services.join(', ')}`)
    process.exit(1)
  }

  // Pinrear el CID
  console.log(`Pinando CID ${cid} en servicio "${service}" con nombre "${name}"...`)
  const result = sh(`ipfs pin remote add --service=${service} --name=${name} ${cid}`, { silent: true })

  if (!result.ok) {
    console.error(`Error al pinar:\n${result.err}`)
    process.exit(1)
  }

  console.log('✅ Pin remoto exitoso')
  console.log(`   CID:  ${cid}`)
  console.log(`   Servicio: ${service}`)
  console.log(`   Nombre: ${name}`)

  // Listar pins del servicio para verificar
  console.log('\nPines en el servicio:')
  const list = sh(`ipfs pin remote ls --service=${service}`, { silent: true })
  if (list.ok) {
    console.log(list.out || '  (vacío)')
  }
}

main()
