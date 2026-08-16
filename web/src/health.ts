import { z } from 'zod'

// Форма ответа /api/health, как её ждёт фронт. Валидируем zod-ом: то, что
// пришло по сети, — внешние данные, даже если сервер наш собственный.
export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
})

export type Health = z.infer<typeof healthSchema>

export function formatHealth(health: Health): string {
  return `${health.service}: ${health.status}`
}
