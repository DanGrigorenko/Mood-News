import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { DatabaseSync } from 'node:sqlite'
import { healthPayload } from './health.ts'
import { listArticles, getArticle } from './db.ts'
import { ingest } from './ingest.ts'
import { moodsPayload } from './mood.ts'
import { resolveRewrite } from './rewrite.ts'
import { callModelOverHttp, callMeaningCheckOverHttp, hasApiKey } from './llm.ts'
import {
  articlesResponseSchema,
  ingestResultSchema,
  moodSchema,
  moodsResponseSchema,
  rewriteResponseSchema,
} from '../../shared/api.mts'

// HTTP-обвязка тестами не покрывается (CODING_STANDARDS): роуты — тонкие
// оболочки над проверяемой логикой (healthPayload, listArticles, ingest,
// resolveRewrite, moodsPayload).
export function createApp(db: DatabaseSync): Hono {
  const app = new Hono()

  app.get('/api/health', (c) => c.json(healthPayload()))

  // Список Mood с человеческими названиями — чтобы фронт не дублировал его.
  // Ответ прогоняется через общую схему контракта: сервер отдаёт ровно ту форму,
  // которую разбирает фронт (shared/api.mts).
  app.get('/api/moods', (c) => c.json(moodsResponseSchema.parse(moodsPayload())))

  // Грид новостей: отдаём сохранённые Article как есть, проверив общей схемой.
  app.get('/api/articles', (c) =>
    c.json(articlesResponseSchema.parse({ articles: listArticles(db) })),
  )

  // Article в конкретном Mood: переписанные заголовок и тело плюс Fact Check.
  // :id — ссылка Article (первичный ключ), у фронта она encodeURIComponent.
  app.get('/api/articles/:id', async (c) => {
    const link = c.req.param('id')
    const mood = moodSchema.safeParse(c.req.query('mood') ?? 'neutral')
    if (!mood.success) {
      // Неизвестный Mood отклоняем внятной ошибкой, а не уходим в модель.
      return c.json({ error: `неизвестный Mood: ${c.req.query('mood')}` }, 400)
    }

    const article = getArticle(db, link)
    if (!article) return c.json({ error: 'Article не найдена' }, 404)

    try {
      const rewrite = await resolveRewrite(db, article, mood.data, {
        callModel: callModelOverHttp,
        meaningCheckModel: callMeaningCheckOverHttp,
        useStub: !hasApiKey(),
      })
      return c.json(rewriteResponseSchema.parse({ article, rewrite }))
    } catch (err) {
      // Недоступность или таймаут модели — внятная 502, а не пятисотка без слов.
      const reason = err instanceof Error ? err.message : String(err)
      return c.json({ error: reason }, 502)
    }
  })

  // Кнопка «Обновить»: повторный Ingest, отвечаем числом добавленных и
  // отброшенных (недоступный полный текст) новостей. Ответ прогоняется через
  // общую схему наравне с остальными тремя роутами — skipped доходит до экрана.
  app.post('/api/ingest', async (c) => {
    const result = await ingest(db)
    return c.json(ingestResultSchema.parse(result))
  })

  // Прод-раздача собранного фронта тем же процессом — один Render-сервис вместо
  // двух (нет отдельного статик-хостинга и rewrite-правил). Нет /api, нет
  // роутера на фронте — отдать файл или, для остальных путей, index.html.
  app.use('*', serveStatic({ root: '../web/dist' }))
  app.use('*', serveStatic({ path: '../web/dist/index.html' }))

  return app
}
