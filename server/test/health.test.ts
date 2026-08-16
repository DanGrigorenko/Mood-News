import { test } from 'node:test'
import assert from 'node:assert/strict'
import { healthPayload, healthSchema } from '../src/health.ts'

test('healthPayload сообщает, что сервер жив', () => {
  assert.deepEqual(healthPayload(), { status: 'ok', service: 'mood-news-server' })
})

test('healthPayload проходит собственную схему', () => {
  assert.doesNotThrow(() => healthSchema.parse(healthPayload()))
})
