import { defineConfig } from 'vite'
import { demoApi } from './server/demo-api'

export default defineConfig({
  plugins: [demoApi()],
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: { chunkSizeWarningLimit: 8000 }
})
