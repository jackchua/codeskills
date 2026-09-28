import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 4318,
    proxy: { '/api': 'http://localhost:4317' },
  },
})
