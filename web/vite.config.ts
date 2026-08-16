import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const serverPort = Number(process.env.SERVER_PORT ?? 8787)

// Vite требует именно default-экспорт из конфига — единственное исключение из
// правила «только именованные экспорты».
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // /api уходит на Hono-сервер, поэтому фронту не нужен абсолютный URL.
    proxy: {
      '/api': `http://localhost:${serverPort}`,
    },
  },
})
