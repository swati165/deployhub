import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(), // Tailwind v4 plugin - no separate config file needed
  ],
  resolve: {
    alias: {
      // '@' will point to our 'src' folder
      // This lets us write imports like: import Button from '@/components/Button'
      // instead of messy: import Button from '../../../components/Button'
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
})