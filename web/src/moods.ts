// Список Mood приходит с сервера (GET /api/moods): id — машинный ключ для запроса
// Rewrite, label — человеческое название для переключателя. Форма описана один
// раз в общем контракте (shared/api.mts); фронт не дублирует список Mood, а
// показывает то, что отдал сервер.
import { moodsResponseSchema, type MoodOption } from '../../shared/api.mts'
import { apiFetch } from './api.ts'

export type Mood = MoodOption
// Прежнее имя конверта ответа /api/moods, сохранено для импортёров.
export const moodsSchema = moodsResponseSchema

export async function fetchMoods(): Promise<Mood[]> {
  return (await apiFetch('/api/moods', moodsResponseSchema)).moods
}
