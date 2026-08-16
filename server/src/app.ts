import { Hono } from 'hono'
import { healthPayload } from './health.ts'

// HTTP-обвязка тестами не покрывается (см. CODING_STANDARDS): роут — тонкая
// оболочка над healthPayload, вся проверяемая логика живёт в health.ts.
export const app = new Hono()

app.get('/api/health', (c) => c.json(healthPayload()))
