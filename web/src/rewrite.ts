import { z } from 'zod'
import { articleSchema } from './articles.ts'

// Anchor — факт, обязанный дословно пережить переписывание (см. server/anchor.ts).
// На фронте kind нужен только для подписи потерянного факта.
const anchorSchema = z.object({
  kind: z.enum(['number', 'quote', 'name']),
  text: z.string(),
})
export type Anchor = z.infer<typeof anchorSchema>

// Форма Rewrite, как её отдаёт сервер. Валидируем zod-ом: пришедшее по сети —
// внешние данные (CODING_STANDARDS).
export const rewriteSchema = z.object({
  mood: z.string(),
  title: z.string(),
  body: z.string(),
  anchors: z.array(anchorSchema),
  anchorCount: z.number(),
  missing: z.array(anchorSchema),
  attempts: z.number(),
  stub: z.boolean(),
  // После всех попыток Rewrite дословно совпал со Snippet — переписывание не
  // сработало. Показываем честно, как и Missing Anchor (issue #8).
  unchanged: z.boolean(),
})
export type Rewrite = z.infer<typeof rewriteSchema>

export const rewriteResponseSchema = z.object({
  article: articleSchema,
  rewrite: rewriteSchema,
})

// Бейдж Fact Check: сколько Anchor уцелело из общего числа. Потерянные факты
// перечисляются отдельно (rewrite.missing) — здесь только сводка.
export function factCheckSummary(rewrite: Rewrite): string {
  const kept = rewrite.anchorCount - rewrite.missing.length
  return `факты сохранены: ${kept}/${rewrite.anchorCount}`
}

// Сервер кладёт причину ошибки в { error } (400/404/502). Достаём её, чтобы
// показать читателю, а не только в консоли (acceptance criteria issue #5).
export function errorText(status: number, body: unknown): string {
  const parsed = z.object({ error: z.string() }).safeParse(body)
  return parsed.success ? parsed.data.error : `сервер ответил ${status}`
}

export async function fetchRewrite(link: string, mood: string): Promise<Rewrite> {
  // :id — ссылка Article (первичный ключ), поэтому encodeURIComponent.
  const res = await fetch(
    `/api/articles/${encodeURIComponent(link)}?mood=${encodeURIComponent(mood)}`,
  )
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(errorText(res.status, body))
  return rewriteResponseSchema.parse(body).rewrite
}
