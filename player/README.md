# IberCast Player

Reproductor web P2P para IberCast: **hls.js** con loader propio que resuelve
manifests y segmentos primero vía **IPFS (Helia + bitswap over WebRTC)** y
cae a un **gateway HTTP** como último recurso.

## Uso

```bash
npm install
npm run dev
# abre http://localhost:5173/?cid=<manifest-CID>
```

Parámetros URL:

- `?cid=<CID>` — CID raíz del manifiesto publicado por `ibercastd`.
- `?gw=<url>` — gateway HTTP de respaldo (por defecto `https://ipfs.io`).

## Cómo funciona

```
hls.js ── pide segmento ──► IberLoader
                              1. caché en memoria (re-emisión a otros, futuro)
                              2. P2P: unixfs.cat(rootCID, path) vía bitswap/WebRTC
                              3. fallback: gateway HTTP (?gw=)
```

- El navegador arranca un **nodo Helia completo** (WebRTC + WebSockets +
  circuit relay, noise + yamux) y se conecta a los bootstrappers públicos.
- Cada segmento se pide por path de UnixFS: `<rootCID>/v0/seg-3.ts`.
- Métricas visibles: peers conectados, segmentos servidos por P2P vs
  gateway, bytes por fuente.

## Estructura

```
src/
├── node.ts     # nodo Helia (transportes, bootstrappers, unixfs)
├── loader.ts   # loader custom de hls.js (cache → P2P → gateway)
└── main.ts     # UI, wiring y métricas
```

## Limitaciones conocidas

- El fallback usa `ipfs.io`, que puede estar rate-limitado; usa `?gw=`.
- Aún no anunciamos bloques a la swarm completa (bitswap solo consulta a
  los peers conectados) — fase 3.
- `enableWorker: false` mientras depuramos el loader custom.
