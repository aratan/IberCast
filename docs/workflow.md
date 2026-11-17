# IberCast — Flujo de trabajo

> Guía operativa de desarrollo y verificación. Complementa [architecture.md](architecture.md).

## 1. Mapa del repositorio

- `ibercastd/`: daemon HTTP en Go, API, autenticación, persistencia y flujos VOD/live.
- `player/`: reproductor web TypeScript/Vite, hls.js y Helia.
- `scripts/e2e.mjs`: comprobación del DAG HLS por gateway; navegador opcional.
- `deploy/`, `mediamtx.yml` y `run.sh`: configuración y arranque del entorno local.
- `.github/workflows/ci.yml`: validaciones automáticas del player y del daemon.

## 2. Requisitos

- Go 1.26 o toolchain compatible con la directiva de `ibercastd/go.mod`.
- Node.js 20 o superior y npm.
- FFmpeg.
- Kubo/IPFS para publicación VOD y recuperación mediante gateway.
- MediaMTX para ingestión RTMP/live.
- Chrome/Chromium compatible con los codecs del vídeo si se ejecuta E2E en navegador.

No es necesario instalar OBS para compilar o probar VOD; OBS es solo una posible fuente RTMP para pruebas live.

## 3. Validación local

Desde la raíz del repositorio:

```bash
# Daemon
cd ibercastd
go vet ./...
go test ./...
go build ./...
cd ..

# Player
cd player
npm ci
npm run typecheck
npm run build
cd ..

# DAG HLS mediante gateway público (usa un fixture por defecto)
node scripts/e2e.mjs --gw https://gateway.pinata.cloud --max-segments 5

# Reproducción real en navegador; requiere Chrome con codecs compatibles
node scripts/e2e.mjs --browser --max-segments 5
```

El E2E tiene dos alcances distintos:

- **Fase A (HTTP):** obtiene el manifiesto, resuelve playlists y descarga una muestra limitada de segmentos. Comprueba el acceso al DAG por gateway y las rutas HLS.
- **Fase B (navegador, `--browser`):** carga el player en un navegador y consulta los hooks `window.__IBER__` para verificar manifiesto, metadata y métricas.

Un resultado positivo contra un fixture público no demuestra por sí solo que una instalación nueva pueda publicar VOD, emitir RTMP o mantener una swarm P2P. Esas rutas requieren pruebas integradas con Kubo, FFmpeg, MediaMTX y peers reales.

## 4. Arranque integrado

`run.sh` puede iniciar MediaMTX, Kubo, compilar y arrancar `ibercastd`, y lanzar Vite. Revisa sus dependencias y opciones antes de ejecutarlo:

```bash
./run.sh
./run.sh --no-live
./run.sh --no-ipfs
./run.sh --no-player
./run.sh --daemon-only
```

El lanzador necesita `ffmpeg`, `go` y `npm`; Kubo y MediaMTX se omiten con las opciones correspondientes. MediaMTX también se omite si no está disponible en `bin/mediamtx`.

## 5. CI

El workflow `.github/workflows/ci.yml` contiene:

| Job | Validaciones |
|---|---|
| Player | Node 20, `npm ci`, `npx tsc --noEmit`, `npx vite build` |
| Daemon | Si existe `ibercastd/go.mod`: Go estable, `go vet ./...`, `go build ./...`, `go test ./...` |

El workflow se dispara con push a `main` y con pull requests. Por tanto, los cambios de una rama de trabajo se validan al abrir un PR; no debe darse por superada la CI hasta comprobar el resultado en la pestaña Actions.

## 6. Publicación y persistencia

El flujo VOD implementado en el daemon usa FFmpeg para generar HLS y Kubo RPC para publicar el contenido. El CID raíz permite recuperar el DAG mediante un gateway o un nodo IPFS.

El pinning local solo protege el contenido en el nodo local. Para mantener disponibilidad cuando ese nodo se apaga, hay que replicar/pinear el CID en otro nodo o en un proveedor remoto. No se debe asumir que el pinning remoto está configurado por el mero hecho de que el proyecto soporte IPFS.

## 7. Seguridad antes de exponer el servicio

- No expongas el RPC de Kubo (`:5001`) a Internet.
- Activa autenticación de administración mediante `--auth-enabled`, `--admin-token` o las variables de entorno documentadas en `ibercastd/internal/config/config.go`.
- Si se genera el administrador inicial, la contraseña temporal se muestra en la consola y exige cambio; no la compartas ni la guardes en el repositorio.
- Configura TLS, CORS restrictivo para el dominio real del player, rate limiting, límites de subida y copias de seguridad antes de publicar el servicio.
- No guardes tokens de pinning, claves RTMP ni credenciales en el repositorio.

## 8. Convenciones

- Commits en inglés, en imperativo, explicando el motivo cuando el cambio no sea obvio.
- Mantener las rutas de playlists HLS relativas: el player depende de ese contrato para resolver segmentos dentro del CID.
- No subir secretos, datos de usuarios ni vídeos privados a fixtures públicos.
- Trabajar en ramas y abrir PR para que CI valide los cambios antes de integrarlos en `main`.
