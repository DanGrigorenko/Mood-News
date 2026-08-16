import { healthSchema, type Health } from './health.ts'

// Относительный путь: /api проксируется Vite-ом на сервер, поэтому в коде
// фронта не появляется абсолютный URL с портом.
export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health')
  if (!res.ok) {
    throw new Error(`/api/health ответил ${res.status}`)
  }
  return healthSchema.parse(await res.json())
}
