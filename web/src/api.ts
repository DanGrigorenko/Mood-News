import { z } from 'zod'

// Единственный способ сходить в API со схемой: сходить → разобрать тело →
// проверить статус → отдать телом схему, которой сервер описал ответ
// (shared/api.mts). Три почти одинаковых тела (список статей, список Mood,
// Ingest) и получение Rewrite схлопнуты сюда, чтобы «внешние данные валидируем
// zod-ом» (CODING_STANDARDS) жило в одном месте. Причину ошибки сервер кладёт в
// { error } на всех роутах (400/404/502) — apiFetch достаёт её и доносит до
// читателя. Нет тела или тело неожиданной формы — печатается статус.
export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, init)
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(errorText(path, res.status, body))
  return schema.parse(body)
}

// Причина ошибки из тела ответа, иначе — откат на статус.
function errorText(path: string, status: number, body: unknown): string {
  const parsed = z.object({ error: z.string() }).safeParse(body)
  return parsed.success ? parsed.data.error : `${path} ответил ${status}`
}
