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
  peerCount: () => number
  stop: () => Promise<void>
}

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

  const fs = unixfs(helia)

  return {
    helia,
    unixfs: fs,
    peerCount: () => helia.libp2p.getConnections().length,
    stop: async () => {
      await helia.stop()
    }
  }
}
