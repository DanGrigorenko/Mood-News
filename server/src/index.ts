import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { openDb, countArticles } from './db.ts'
import { ingest } from './ingest.ts'

const port = Number(process.env.PORT ?? 8787)
const dbPath = process.env.DB_PATH ?? 'mood-news.db'

const db = openDb(dbPath)

// Ingest при старте, только если база пуста — данные переживают перезапуск,
// повторный старт ничего не тянет заново (issue #3). Ждём завершения до
// serve, чтобы грид в свежем клоне был непустым с первого запроса.
if (countArticles(db) === 0) {
  console.log('База пуста — запускаю стартовый Ingest…')
  const { added } = await ingest(db)
  console.log(`Стартовый Ingest добавил новостей: ${added}`)
}

const app = createApp(db)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server слушает http://localhost:${info.port}`)
})
