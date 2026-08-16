import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  factCheckSummary,
  errorText,
  rewriteResponseSchema,
  type Rewrite,
} from '../src/rewrite.ts'

const base: Rewrite = {
  mood: 'joyful',
  title: 'Заголовок',
  body: 'Тело',
  anchors: [],
  anchorCount: 12,
  missing: [],
  attempts: 1,
  stub: false,
  unchanged: false,
  review: 'passed',
  contradiction: '',
}

test('rewriteResponseSchema принимает пометку unchanged', () => {
  const parsed = rewriteResponseSchema.parse({
    article: {
      link: 'https://example.com/a',
      source: 'S',
      title: 'T',
      announce: 'A',
      publishedAt: '',
    },
    rewrite: { ...base, unchanged: true },
  })
  assert.equal(parsed.rewrite.unchanged, true)
})

test('rewriteResponseSchema принимает провал смысловой сверки с contradiction', () => {
  const parsed = rewriteResponseSchema.parse({
    article: {
      link: 'https://example.com/a',
      source: 'S',
      title: 'T',
      announce: 'A',
      publishedAt: '',
    },
    rewrite: { ...base, review: 'failed', contradiction: 'рост подменён падением' },
  })
  assert.equal(parsed.rewrite.review, 'failed')
  assert.equal(parsed.rewrite.contradiction, 'рост подменён падением')
})

test('rewriteResponseSchema отвергает неизвестное состояние review', () => {
  assert.throws(() =>
    rewriteResponseSchema.parse({
      article: {
        link: 'https://example.com/a',
        source: 'S',
        title: 'T',
        announce: 'A',
        publishedAt: '',
      },
      rewrite: { ...base, review: 'unknown' },
    }),
  )
})

test('factCheckSummary показывает сохранённые факты как kept/total', () => {
  assert.equal(factCheckSummary(base), 'факты сохранены: 12/12')
})

test('factCheckSummary вычитает потерянные Anchor из сохранённых', () => {
  const lost: Rewrite = {
    ...base,
    missing: [
      { kind: 'name', text: 'Путин' },
      { kind: 'number', text: '2024' },
    ],
  }
  assert.equal(factCheckSummary(lost), 'факты сохранены: 10/12')
})

test('errorText достаёт причину из тела ответа сервера', () => {
  assert.equal(errorText(400, { error: 'неизвестный Mood: foo' }), 'неизвестный Mood: foo')
})

test('errorText откатывается на статус, если тело без error', () => {
  assert.equal(errorText(502, null), 'сервер ответил 502')
})

test('rewriteResponseSchema отвергает ответ без rewrite', () => {
  assert.throws(() =>
    rewriteResponseSchema.parse({
      article: {
        link: 'https://example.com/a',
        source: 'S',
        title: 'T',
        announce: 'A',
        publishedAt: '',
      },
    }),
  )
})
