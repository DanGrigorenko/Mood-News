import { z } from 'zod'

// Ответ сквозной проверки «сервер жив». Ничего доменного: только повод,
// на котором фронт убеждается, что достаёт данные с бэкенда, а не выдумывает их.
export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
})

export type Health = z.infer<typeof healthSchema>

export function healthPayload(): Health {
  return { status: 'ok', service: 'mood-news-server' }
}
