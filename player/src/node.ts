import { createHelia } from 'helia'
import { unixfs } from '@helia/unixfs'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bootstrap } from '@libp2p/bootstrap'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import type { Helia } from 'helia'
import type { UnixFS } from '@helia/unixfs'

/**
 * Bootstrap list: public IPFS bootstrappers (WebSocket-capable) so the
 * browser node can join the public DHT-swarm over TCP/WSS relays.
 * Viewers find each other through these and then exchange HLS blocks
 * directly over WebRTC.
 */
const BOOTSTRAPPERS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchMvq78T5ujcMNC7dUYW',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
]

export interface IberNode {
  helia: Helia
  unixfs: UnixFS
  /** true when the node reached 'started' within the wait window */
  started: boolean
  peerCount: () => number
  stop: () => Promise<void>
}

const START_WAIT_MS = 15_000

export async function createIberNode(): Promise<IberNode> {
  const helia = await createHelia({
    libp2p: {
      services: {
        identify: identify(),
        bootstrap: bootstrap({
          list: BOOTSTRAPPERS,
          timeout: 10_000
        })
      },
      transports: [
        webSockets(),
        // Browser-to-browser and browser-to-seed direct data channels
        webRTC(),
        // Fallback through circuit relays when no direct path exists
        circuitRelayTransport()
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()]
    }
  })

  // createHelia resolves while internal services may still be starting.
  // Wait a bounded time for 'started'; if the environment can't complete
  // startup (e.g. broken IPv6/DNS in CI sandboxes), degrade gracefully:
  // P2P stays disabled and playback continues gateway-only.
  const deadline = Date.now() + START_WAIT_MS
  while (helia.status !== 'started' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const started = helia.status === 'started'

  const fs = unixfs(helia)

  return {
    helia,
    unixfs: fs,
    started,
    peerCount: () => (started ? helia.libp2p.getPeers().length : 0),
    stop: async () => {
      await helia.stop()
    }
  }
}
