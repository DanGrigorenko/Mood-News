import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { healthPayload } from './health.ts'
import { listArticles, getArticle } from './db.ts'
import { ingest } from './ingest.ts'
import { moodSchema, moodsPayload } from './mood.ts'
import { resolveRewrite } from './rewrite.ts'
import { callModelOverHttp, callReviewOverHttp, hasApiKey } from './llm.ts'

// HTTP-обвязка тестами не покрывается (CODING_STANDARDS): роуты — тонкие
// оболочки над проверяемой логикой (healthPayload, listArticles, ingest,
// resolveRewrite, moodsPayload).
export function createApp(db: DatabaseSync): Hono {
  const app = new Hono()

  app.get('/api/health', (c) => c.json(healthPayload()))

  // Список Mood с человеческими названиями — чтобы фронт не дублировал его.
  app.get('/api/moods', (c) => c.json(moodsPayload()))

  // Грид новостей: отдаём сохранённые Article как есть.
  app.get('/api/articles', (c) => c.json({ articles: listArticles(db) }))

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
        reviewModel: callReviewOverHttp,
        useStub: !hasApiKey(),
      })
      return c.json({ article, rewrite })
    } catch (err) {
      // Недоступность или таймаут модели — внятная 502, а не пятисотка без слов.
      const reason = err instanceof Error ? err.message : String(err)
      return c.json({ error: reason }, 502)
    }
  })

  // Кнопка «Обновить»: повторный Ingest, отвечаем числом добавленных и
  // отброшенных (пустой анонс) новостей.
  app.post('/api/ingest', async (c) => {
    const result = await ingest(db)
    return c.json(result)
  })

  return app
}
