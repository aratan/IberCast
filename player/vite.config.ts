import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // libp2p + helia are big; warn but do not fail
    chunkSizeWarningLimit: 2000
  },
  server: {
    port: 5173
  }
})
