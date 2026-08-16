import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { apiFetch } from '../src/api.ts'

// Подменяем глобальный fetch на время одного вызова.
async function withFetch<T>(
  stub: (input: string, init?: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = stub as typeof globalThis.fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = real
  }
}

const schema = z.object({ ok: z.boolean() })

test('apiFetch разбирает тело схемой при 200', async () => {
  const parsed = await withFetch(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    () => apiFetch('/api/x', schema),
  )
  assert.equal(parsed.ok, true)
})

test('apiFetch бросает по статусу, не трогая тело, при не-2xx', async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('nope', { status: 500 }),
      () => apiFetch('/api/x', schema),
    ),
    /\/api\/x ответил 500/,
  )
})

test('apiFetch отвергает тело, не подходящее под схему', async () => {
  await assert.rejects(
    withFetch(
      async () => new Response(JSON.stringify({ ok: 'да' }), { status: 200 }),
      () => apiFetch('/api/x', schema),
    ),
  )
})

test('apiFetch передаёт init (метод) в fetch', async () => {
  let seen: RequestInit | undefined
  const parsed = await withFetch(
    async (_input, init) => {
      seen = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
    () => apiFetch('/api/x', schema, { method: 'POST' }),
  )
  assert.equal(parsed.ok, true)
  assert.equal(seen?.method, 'POST')
})

// Deletion test: три прежних тела «сходить → проверить статус → распарсить»
// (fetchArticles, runIngest, fetchMoods) больше не ходят в сеть сами — они
// проходят через apiFetch. Если тело вернётся в эти файлы, тест упадёт.
test('deletion: articles.ts и moods.ts не вызывают fetch и не проверяют res.ok сами', () => {
  for (const file of ['articles.ts', 'moods.ts']) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /fetch\(/, `${file} всё ещё вызывает fetch напрямую`)
    assert.doesNotMatch(src, /res\.ok/, `${file} всё ещё проверяет res.ok сам`)
  }
})
