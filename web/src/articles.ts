import { z } from 'zod'

// Форма Article, как её отдаёт сервер. Валидируем zod-ом: пришедшее по сети —
// внешние данные (CODING_STANDARDS).
export const articleSchema = z.object({
  link: z.string().url(),
  source: z.string(),
  title: z.string(),
  announce: z.string(),
  publishedAt: z.string(),
})

export type Article = z.infer<typeof articleSchema>

export const articlesSchema = z.object({ articles: z.array(articleSchema) })

const ingestResultSchema = z.object({ added: z.number() })

export async function fetchArticles(): Promise<Article[]> {
  const res = await fetch('/api/articles')
  if (!res.ok) throw new Error(`/api/articles ответил ${res.status}`)
  return articlesSchema.parse(await res.json()).articles
}

export async function runIngest(): Promise<number> {
  const res = await fetch('/api/ingest', { method: 'POST' })
  if (!res.ok) throw new Error(`/api/ingest ответил ${res.status}`)
  return ingestResultSchema.parse(await res.json()).added
}

// Русская форма числительного «новость» для отчёта кнопки «Обновить».
function pluralNews(n: number): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return 'новостей'
  if (mod10 === 1) return 'новость'
  if (mod10 >= 2 && mod10 <= 4) return 'новости'
  return 'новостей'
}

export function formatAdded(added: number): string {
  if (added === 0) return 'Новых новостей нет'
  const verb = added % 10 === 1 && added % 100 !== 11 ? 'Добавлена' : 'Добавлено'
  return `${verb} ${added} ${pluralNews(added)}`
}

// Короткая форма для строк выпуска: полная дата занимает две строки и рвёт
// ритм стана. На странице новости остаётся полная.
export function formatShort(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatPublished(iso: string): string {
  if (iso === '') return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
