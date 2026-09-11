import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // libp2p + helia are big; warn but do not fail
    chunkSizeWarningLimit: 2000
  },
  server: {
    port: 5173,
    // Dev integration: forward API calls to the local ibercastd daemon so
    // wall/dashboard/viewer work from the Vite origin without ?api=.
    proxy: {
      '/api': {
        target: 'http://localhost:8585',
        changeOrigin: true
      }
    }
  }
})
