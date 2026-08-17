// Форма Rewrite (и конверт ответа /api/articles/:id) описана один раз в общем
// контракте (shared/api.mts) — тем же, по которому сервер её строит. `mood`
// имеет одну форму на обе стороны: серверный enum, а не свободная строка.
import { rewriteResponseSchema, type Mood, type Rewrite } from '../../shared/api.mts'
import { apiFetch } from './api.ts'

// Бейдж Fact Check: сколько Anchor уцелело из общего числа. Потерянные факты
// перечисляются отдельно (rewrite.missing) — здесь только сводка.
export function factCheckSummary(rewrite: Rewrite): string {
  const kept = rewrite.anchorCount - rewrite.missing.length
  return `факты сохранены: ${kept}/${rewrite.anchorCount}`
}

export async function fetchRewrite(link: string, mood: Mood): Promise<Rewrite> {
  // :id — ссылка Article (первичный ключ), поэтому encodeURIComponent. Транспорт
  // (статус, разбор причины ошибки) — у общего apiFetch; здесь только адрес и
  // распаковка конверта.
  const { rewrite } = await apiFetch(
    `/api/articles/${encodeURIComponent(link)}?mood=${encodeURIComponent(mood)}`,
    rewriteResponseSchema,
  )
  return rewrite
}
