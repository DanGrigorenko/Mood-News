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
  // Ingest теперь ходит на страницу каждой новости и потому заметно дольше —
  // сообщаем ход работы, чтобы старт не выглядел зависшим (issue #11).
  const { added, skipped } = await ingest(db, { onProgress: (m) => console.log(m) })
  console.log(`Стартовый Ingest добавил новостей: ${added} (пропущено ${skipped})`)
}

const app = createApp(db)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server слушает http://localhost:${info.port}`)
})
