import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { apiFetch } from '../src/api.ts'
import { fetchRewrite } from '../src/rewrite.ts'

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

test('apiFetch доносит причину ошибки из тела ответа при не-2xx', async () => {
  await assert.rejects(
    withFetch(
      async () =>
        new Response(JSON.stringify({ error: 'неизвестный Mood: foo' }), {
          status: 400,
        }),
      () => apiFetch('/api/x', schema),
    ),
    /неизвестный Mood: foo/,
  )
})

test('apiFetch откатывается на статус, если сервер ответил без тела', async () => {
  await assert.rejects(
    withFetch(
      async () => new Response(null, { status: 502 }),
      () => apiFetch('/api/x', schema),
    ),
    /\/api\/x ответил 502/,
  )
})

test('apiFetch откатывается на статус при теле неожиданной формы', async () => {
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

// fetchRewrite — ещё одна привязка над apiFetch, а не свой транспорт: у него нет
// собственного разбора статуса и причины. Спрашиваем это у interface, а не грепом
// исходника: причина ошибки от сервера доходит и через путь Rewrite.
test('fetchRewrite доносит причину ошибки сервера через apiFetch', async () => {
  await assert.rejects(
    withFetch(
      async () =>
        new Response(JSON.stringify({ error: 'Article не найдена' }), {
          status: 404,
        }),
      () => fetchRewrite('https://example.com/a', 'joyful'),
    ),
    /Article не найдена/,
  )
})

// А на 2xx он распаковывает конверт контракта и отдаёт сам Rewrite.
test('fetchRewrite распаковывает rewrite из конверта ответа', async () => {
  const article = {
    link: 'https://example.com/a',
    source: 'РИА Новости',
    title: 'T',
    announce: 'A',
    publishedAt: '',
  }
  const rewrite = {
    mood: 'joyful',
    title: 'Заголовок',
    body: 'Тело',
    anchors: [],
    anchorCount: 3,
    missing: [],
    attempts: 1,
    stub: false,
    unchanged: false,
    meaningCheck: 'passed',
    distortion: '',
  }
  const got = await withFetch(
    async () => new Response(JSON.stringify({ article, rewrite }), { status: 200 }),
    () => fetchRewrite('https://example.com/a', 'joyful'),
  )
  assert.equal(got.mood, 'joyful')
  assert.equal(got.anchorCount, 3)
})
