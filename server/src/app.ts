import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { healthPayload } from './health.ts'
import { listArticles } from './db.ts'
import { ingest } from './ingest.ts'

// HTTP-обвязка тестами не покрывается (CODING_STANDARDS): роуты — тонкие
// оболочки над проверяемой логикой (healthPayload, listArticles, ingest).
export function createApp(db: DatabaseSync): Hono {
  const app = new Hono()

  app.get('/api/health', (c) => c.json(healthPayload()))

  // Грид новостей: отдаём сохранённые Article как есть.
  app.get('/api/articles', (c) => c.json({ articles: listArticles(db) }))

  // Кнопка «Обновить»: повторный Ingest, отвечаем числом добавленных новостей.
  app.post('/api/ingest', async (c) => {
    const result = await ingest(db)
    return c.json(result)
  })

  return app
}
