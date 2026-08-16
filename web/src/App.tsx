import { useEffect, useState } from 'react'
import { fetchHealth } from './api.ts'
import { formatHealth } from './health.ts'

export function App() {
  const [status, setStatus] = useState('запрашиваю…')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchHealth()
      .then((health) => setStatus(formatHealth(health)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <main>
      <h1>Mood News</h1>
      <p>{error === null ? status : `ошибка: ${error}`}</p>
    </main>
  )
}
