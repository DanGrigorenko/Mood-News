import { z } from 'zod'
// Форма Rewrite (и конверт ответа /api/articles/:id) описана один раз в общем
// контракте (shared/api.mts) — тем же, по которому сервер её строит. `mood`
// имеет одну форму на обе стороны: серверный enum, а не свободная строка.
import { rewriteSchema, rewriteResponseSchema, type Rewrite, type Anchor } from '../../shared/api.mts'
export { rewriteSchema, rewriteResponseSchema, type Rewrite, type Anchor }

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
