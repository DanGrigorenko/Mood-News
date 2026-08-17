import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchChatContent,
  buildRequestBody,
  maxTokensFor,
  llmConfig,
  hasApiKey,
  type Transport,
} from '../src/llm.ts'
import type { ChatMessage } from '../src/prompt.ts'

const messages: ChatMessage[] = [{ role: 'user', content: 'x' }]

// Успешный ответ chat/completions с заданным content первого choice.
function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// Подставной транспорт: сценарий request по вызовам плюс запись пауз backoff.
// Пауза здесь мгновенная — повтор по 429 проверяется без реального ожидания, а
// величины пауз остаются наблюдаемыми в paused. retryDelays по умолчанию несёт
// прод-значения [1000,4000,10000], чтобы прежние тесты видели те же паузы; тест
// на источник пауз подставляет свои.
const PROD_DELAYS = [1_000, 4_000, 10_000]
function scriptedTransport(
  handlers: Array<() => Promise<Response>>,
  retryDelays: number[] = PROD_DELAYS,
): { transport: Transport; calls: () => number; paused: number[] } {
  let call = 0
  const paused: number[] = []
  const transport: Transport = {
    request: () => {
      const handler = handlers[call++]
      if (!handler) throw new Error(`лишний запрос #${call}`)
      return handler()
    },
    sleep: async (ms) => {
      paused.push(ms)
    },
    retryDelays,
  }
  return { transport, calls: () => call, paused }
}

// --- Тело запроса и max_tokens (детали, на которых легко потерять время) ---

test('тело запроса отключает reasoning и требует json_object', () => {
  const body = buildRequestBody([{ role: 'user', content: 'x' }], 'glm-4.7-flash')
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.equal(body.model, 'glm-4.7-flash')
})

test('max_tokens: короткий вход даёт нижнюю границу', () => {
  const short = maxTokensFor([{ role: 'user', content: 'Короткая новость' }])
  assert.equal(short, 400) // ниже 400 не опускается — прежний минимум
})

test('max_tokens: длинный вход даёт больше нижней границы', () => {
  const long = maxTokensFor([{ role: 'user', content: 'а'.repeat(4000) }])
  assert.ok(long > 400) // объём входа поднял лимит
})

test('max_tokens: очень длинный вход упирается в потолок', () => {
  const huge = maxTokensFor([{ role: 'user', content: 'а'.repeat(100_000) }])
  assert.equal(huge, 2000) // потолок против пробоя бюджета
})

// --- Повтор по 429: backoff отрабатывает, клиентские ошибки не повторяются ---

test('429: транспорт повторяет с растущей паузой и отдаёт content успеха', async () => {
  const { transport, calls, paused } = scriptedTransport([
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 429 }),
    async () => okResponse('готово'),
  ])
  const content = await fetchChatContent(messages, 'модель', transport)
  assert.equal(content, 'готово')
  assert.equal(calls(), 3) // две неудачи + успех
  assert.deepEqual(paused, [1_000, 4_000]) // прежние паузы backoff, не тронуты
})

test('повтор берёт паузы из транспорта, а не из константы module', async () => {
  const { transport, calls, paused } = scriptedTransport(
    [
      async () => new Response('', { status: 429 }),
      async () => new Response('', { status: 429 }),
      async () => okResponse('готово'),
    ],
    [7, 13, 19], // подставные паузы: не прод-константа RETRY_DELAYS_MS
  )
  const content = await fetchChatContent(messages, 'модель', transport)
  assert.equal(content, 'готово')
  assert.equal(calls(), 3) // две неудачи + успех
  assert.deepEqual(paused, [7, 13]) // паузы взяты из transport.retryDelays, а не из module
})

test('429 без просвета: попытки кончаются, отдаётся внятная ошибка', async () => {
  const { transport, calls, paused } = scriptedTransport([
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 429 }),
  ])
  await assert.rejects(fetchChatContent(messages, 'модель', transport), /модель ответила 429/)
  assert.equal(calls(), 4) // первичный вызов + три повтора (RETRY_DELAYS_MS.length)
  assert.deepEqual(paused, [1_000, 4_000, 10_000]) // все три паузы backoff
})

test('5xx повторяется так же, как 429', async () => {
  const { transport, calls, paused } = scriptedTransport([
    async () => new Response('', { status: 503 }),
    async () => okResponse('после 503'),
  ])
  const content = await fetchChatContent(messages, 'модель', transport)
  assert.equal(content, 'после 503')
  assert.equal(calls(), 2)
  assert.deepEqual(paused, [1_000])
})

test('клиентская ошибка (400) не повторяется', async () => {
  const { transport, calls, paused } = scriptedTransport([
    async () => new Response('', { status: 400 }),
  ])
  await assert.rejects(fetchChatContent(messages, 'модель', transport), /модель ответила 400/)
  assert.equal(calls(), 1) // без повторов
  assert.deepEqual(paused, []) // backoff не трогали
})

test('401 (нет ключа/доступа) не повторяется', async () => {
  const { transport, calls, paused } = scriptedTransport([
    async () => new Response('', { status: 401 }),
  ])
  await assert.rejects(fetchChatContent(messages, 'модель', transport), /модель ответила 401/)
  assert.equal(calls(), 1)
  assert.deepEqual(paused, [])
})

// --- Таймаут/падение провайдера: внятная ошибка, а не зависание ---

test('падение запроса (таймаут) отдаёт внятную ошибку, а не висит', async () => {
  const { transport, calls } = scriptedTransport([
    async () => {
      throw new Error('The operation timed out')
    },
  ])
  await assert.rejects(
    fetchChatContent(messages, 'смысловая сверка', transport),
    /смысловая сверка недоступна: The operation timed out/,
  )
  assert.equal(calls(), 1) // бросок запроса не ретраится
})

// --- Ответ неожиданной формы ---

test('ответ без choices — внятная ошибка про форму', async () => {
  const { transport } = scriptedTransport([
    async () =>
      new Response(JSON.stringify({ nope: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ])
  await assert.rejects(
    fetchChatContent(messages, 'модель', transport),
    /модель вернула ответ неожиданной формы/,
  )
})

// --- Чтение конфигурации модели из окружения ---

const ENV_KEYS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'] as const

function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  Object.assign(process.env, env)
  try {
    fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

test('llmConfig читает три переменные и нормализует их', () => {
  withEnv({ LLM_BASE_URL: 'https://api.test/', LLM_MODEL: 'glm-4.7', LLM_API_KEY: '  secret  ' }, () => {
    const cfg = llmConfig()
    assert.equal(cfg.baseUrl, 'https://api.test') // хвостовой слэш снят
    assert.equal(cfg.model, 'glm-4.7')
    assert.equal(cfg.apiKey, 'secret') // пробелы обрезаны
  })
})

test('отсутствие ключа предсказуемо ведёт к заглушке: hasApiKey false', () => {
  withEnv({}, () => assert.equal(hasApiKey(), false))
})

test('ключ (даже из пробелов пустой) не включает модель', () => {
  withEnv({ LLM_API_KEY: '   ' }, () => assert.equal(hasApiKey(), false))
})

test('непустой ключ включает вызов модели: hasApiKey true', () => {
  withEnv({ LLM_API_KEY: 'k' }, () => assert.equal(hasApiKey(), true))
})
