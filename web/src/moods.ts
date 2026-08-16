import { z } from 'zod'

// Mood приходит с сервера (GET /api/moods): id — машинный ключ для запроса
// Rewrite, label — человеческое название для переключателя. Фронт не дублирует
// список Mood, а показывает то, что отдал сервер (acceptance criteria issue #5).
export const moodSchema = z.object({ id: z.string(), label: z.string() })
export type Mood = z.infer<typeof moodSchema>

export const moodsSchema = z.object({ moods: z.array(moodSchema) })

export async function fetchMoods(): Promise<Mood[]> {
  const res = await fetch('/api/moods')
  if (!res.ok) throw new Error(`/api/moods ответил ${res.status}`)
  return moodsSchema.parse(await res.json()).moods
}
