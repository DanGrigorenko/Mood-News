import type { z } from 'zod'

// Единственный способ сходить в API со схемой: сходить → проверить статус →
// разобрать той же схемой, которой сервер описал ответ (shared/api.mts). Три
// почти одинаковых тела (список статей, список Mood, Ingest) схлопнуты сюда,
// чтобы «внешние данные валидируем zod-ом» (CODING_STANDARDS) жило в одном месте.
// Исключение — fetchRewrite: он ещё и достаёт причину ошибки из тела ответа
// (это представление, а не контракт), поэтому у него своё тело в rewrite.ts.
export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(`${path} ответил ${res.status}`)
  return schema.parse(await res.json())
}
