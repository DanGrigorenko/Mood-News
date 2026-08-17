import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factCheckSummary } from '../src/rewrite.ts'
import { rewriteResponseSchema, type Rewrite } from '../../shared/api.mts'

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
  meaningCheck: 'passed',
  distortion: '',
}

test('rewriteResponseSchema принимает пометку unchanged', () => {
  const parsed = rewriteResponseSchema.parse({
    article: {
      link: 'https://example.com/a',
      source: 'РИА Новости',
      title: 'T',
      announce: 'A',
      publishedAt: '',
    },
    rewrite: { ...base, unchanged: true },
  })
  assert.equal(parsed.rewrite.unchanged, true)
})

test('rewriteResponseSchema принимает провал Meaning Check с distortion', () => {
  const parsed = rewriteResponseSchema.parse({
    article: {
      link: 'https://example.com/a',
      source: 'РИА Новости',
      title: 'T',
      announce: 'A',
      publishedAt: '',
    },
    rewrite: { ...base, meaningCheck: 'failed', distortion: 'рост подменён падением' },
  })
  assert.equal(parsed.rewrite.meaningCheck, 'failed')
  assert.equal(parsed.rewrite.distortion, 'рост подменён падением')
})

test('rewriteResponseSchema отвергает неизвестное состояние meaningCheck', () => {
  assert.throws(() =>
    rewriteResponseSchema.parse({
      article: {
        link: 'https://example.com/a',
        source: 'РИА Новости',
        title: 'T',
        announce: 'A',
        publishedAt: '',
      },
      rewrite: { ...base, meaningCheck: 'unknown' },
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

test('rewriteResponseSchema отвергает ответ без rewrite', () => {
  assert.throws(() =>
    rewriteResponseSchema.parse({
      article: {
        link: 'https://example.com/a',
        source: 'РИА Новости',
        title: 'T',
        announce: 'A',
        publishedAt: '',
      },
    }),
  )
})
