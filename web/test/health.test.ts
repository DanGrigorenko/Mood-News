import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatHealth, healthSchema } from '../src/health.ts'

test('formatHealth собирает человекочитаемую строку из ответа', () => {
  assert.equal(
    formatHealth({ status: 'ok', service: 'mood-news-server' }),
    'mood-news-server: ok',
  )
})

test('healthSchema отвергает мусор вместо ответа сервера', () => {
  assert.throws(() => healthSchema.parse({ status: 'down' }))
})
