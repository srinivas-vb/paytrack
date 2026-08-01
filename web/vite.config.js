import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Forward /api -> local API in dev. No path rewrite: the server mounts
    // everything under /api already, so dev and production URLs are identical
    // and there is no rewriting rule to get subtly wrong.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
