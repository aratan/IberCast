# IberCast

**Streaming de vídeo P2P sobre IPFS.** El vídeo se fragmenta en HLS y se
distribuye entre los propios espectadores: cada navegador que reproduce
actúa a la vez como nodo que sirve fragmentos a otros, reduciendo el coste
de banda ancha del origin a cambios de eficiencia de red.

---

## Objetivos

1. **Distribución P2P real** — los viewers aportan ancho de banda vía
   WebRTC; el origin solo siembra los bloques raíz y los manifiestos.
2. **Coste ~cero de origin** — apoyarse en gateways IPFS públicos o propios
   en vez de CDNs de pago.
3. **Resiliencia por diseño** — sin punto único de fallo: el contenido
   sobrevive mientras haya al menos un nodo con los bloques.
4. **Censura-resistencia** (opcional/futuro) — sin coordenador central que
   pueda apagar la emisión.
5. **Privacidad del espectador** — sin cuentas, tracking mínimo, métricas
   agregadas en el cliente.

## Alcance (MVP)

- VOD: subir un vídeo → transcodificar a HLS → publicar en IPFS como CAR
  → reproducir desde el navegador por P2P.
- Fuera de alcance por ahora: live streaming, chat en vivo, DRM,
  transcodificación en el navegador.

## Stack elegido (híbrido Go + TypeScript)

| Capa | Tecnología | Motivo |
|---|---|---|
| Nodo / seed backend | **Go** + `libp2p` / `go-ipfs-api` (Kubo RPC) | Madurez del ecosistema IPFS, goroutines para cientos de conexiones simultáneas, bajo consumo de memoria en seeders |
| Transcodificación | **FFmpeg** → HLS (`.m3u8` + segmentos `.ts`/`.m4s`) | Estándar de facto; los segmentos son bloques IPFS naturales |
| Cliente / reproductor | **TypeScript** + **Helia** (JS-IPFS en navegador) + **WebRTC** | Los navegadores se convierten en nodos P2P sin plugins |
| Reproducción | **hls.js** con loader personalizado | Permite interceptar cada petición de segmento y resolverla primero vía IPFS/WebRTC, cayendo al gateway HTTP como último recurso |

### Por qué híbrido y no solo un lenguaje

- La infraestructura P2P pesada (seed nodes, publicación CAR, coordinación
  de swarms) vive mejor en Go junto a Kubo/libp2p.
- El P2P de navegador (WebRTC data channels + Helia) solo existe en
  JS/TS; es el núcleo del modelo de coste cero.

## Arquitectura (MVP)

```
            ┌──────────────┐   HLS segments (CAR)   ┌─────────────────┐
 vídeo ──►  │  ibercastd   │ ─────────────────────► │  IPFS network   │
 (input)    │  (Go seed)   │   manifest root CID    │  (Kubo / Helia) │
            └──────────────┘                        └────────┬────────┘
                      ▲                                      │ bitswap
                      │ admin API (publicar, listar)         ▼
                      │                             ┌─────────────────┐
        operador ─────┘                             │  web player     │
                                                    │  TS + Helia +   │
                                                    │  hls.js (P2P)   │
                                                    └─────────────────┘
```

- **`ibercastd`** (Go): transcodifica con FFmpeg, empaqueta a CAR, publica
  en IPFS, sirve API admin/REST para subir y listar canales.
- **`player`** (TS): reproductor embebible; loader de hls.js que pregunta
  primero a la swarm P2P (Helia + WebRTC) y hace fallback a gateway HTTP.

## Roadmap

### Fase 0 — Fundaciones (actual)
- [ ] Repo, CI básica y estructura de carpetas.

### Fase 1 — Pipeline VOD
- [ ] CLI/API `ibercastd`: subir vídeo → HLS con FFmpeg (3 calidades).
- [ ] Empaquetado de la salida HLS a CAR y publicación en IPFS (Kubo RPC).
- [ ] Endpoint que devuelve el CID raíz del manifiesto.

### Fase 2 — Reproductor P2P
- [ ] `player` en TS con Helia (navegador) + bitswap.
- [ ] Loader custom de hls.js: resolver segmentos `segment-N.ts` por CID.
- [ ] Fallback transparente a gateway HTTP si P2P no responde a tiempo.
- [ ] Métricas: % de bytes servidos por P2P vs origin.

### Fase 3 — Producción
- [ ] Seed nodes con proved plumbing (systemd/docker).
- [ ] Pinning remoto (Pinata/web3.storage o Kubo cluster propio).
- [ ] Live streaming con HLS corto ( ventanas de 4–6 s ) + LMDS opcional.
- [ ] Autenticación de operador y multi-tenant.

## Estructura del repo (prevista)

```
IberCast/
├── ibercastd/        # daemon Go: ingest, HLS, IPFS publish, API
├── player/           # cliente TS: Helia + hls.js loader P2P
├── deploy/           # docker/systemd, ejemplos de config
└── docs/             # decisiones de diseño (ADRs cortos)
```

## Cómo probar (cuando exista el código)

```bash
# 1. Arranca Kubo local
ipfs daemon

# 2. Publica un vídeo
cd ibercastd && go run . publish --input video.mp4

# 3. Sirve el player
cd player && npm run dev
# abre http://localhost:5173/?cid=<manifest-CID>
```

## Licencia

Por decidir (MIT o Apache-2.0).

## Estado

🚧 Pre-lanzamiento — README y roadmap vivos, código por llegar.
