import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
const frontendDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: frontendDirectory,
  plugins: [
    react(),
    tailwindcss(), // Tailwind v4 plugin - no separate config file needed
  ],
  resolve: {
    alias: {
      // '@' will point to our 'src' folder
      // This lets us write imports like: import Button from '@/components/Button'
      // instead of messy: import Button from '../../../components/Button'
      '@': path.resolve(frontendDirectory, './src'),
    },
  },
  build: {
    outDir: path.resolve(frontendDirectory, '../dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
})