import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize, formatSummary } from '../eval/aggregate.ts'
import type { Rewrite } from '../src/rewrite.ts'

// Выдуманный Rewrite с управляемыми исходами трёх проверок — раннер eval сам
// ходит в живую модель и тестами не покрывается, проверяется только агрегация
// (issue #12).
function fake(opts: {
  kept?: boolean
  changed?: boolean
  meaning?: Rewrite['meaningCheck']
}): Rewrite {
  return {
    mood: 'joyful',
    title: 't',
    body: 'b',
    anchors: [],
    anchorCount: 1,
    missing: opts.kept === false ? [{ kind: 'number', text: '1' }] : [],
    attempts: 1,
    stub: false,
    unchanged: opts.changed === false,
    meaningCheck: opts.meaning ?? 'passed',
    distortion: '',
  }
}

// 50 чистых Rewrite — всё прошло.
function clean(n: number): Rewrite[] {
  return Array.from({ length: n }, () => fake({}))
}

test('50/50 по всем проверкам — планка взята', () => {
  const s = summarize(clean(50))
  assert.equal(s.total, 50)
  assert.equal(s.anchorsKept, 50)
  assert.equal(s.changed, 50)
  assert.equal(s.meaningPassed, 50)
  assert.equal(s.productionReady, true)
})

test('48/50 по Meaning Check — планка ещё взята (порог недетерминированного судьи)', () => {
  const rewrites = [...clean(48), fake({ meaning: 'failed' }), fake({ meaning: 'skipped' })]
  const s = summarize(rewrites)
  assert.equal(s.meaningPassed, 48)
  assert.equal(s.productionReady, true)
})

test('47/50 по Meaning Check — планка не взята', () => {
  const rewrites = [...clean(47), fake({ meaning: 'failed' }), fake({ meaning: 'failed' }), fake({ meaning: 'skipped' })]
  const s = summarize(rewrites)
  assert.equal(s.meaningPassed, 47)
  assert.equal(s.productionReady, false)
})

test('49/50 по Missing Anchor — планка не взята (детерминированная проверка — абсолют)', () => {
  const rewrites = [...clean(49), fake({ kept: false })]
  const s = summarize(rewrites)
  assert.equal(s.anchorsKept, 49)
  assert.equal(s.productionReady, false)
})

test('49/50 по unchanged — планка не взята (детерминированная проверка — абсолют)', () => {
  const rewrites = [...clean(49), fake({ changed: false })]
  const s = summarize(rewrites)
  assert.equal(s.changed, 49)
  assert.equal(s.productionReady, false)
})

test('корпус не из 50 текстов планку не берёт даже при чистом прогоне', () => {
  const s = summarize(clean(40))
  assert.equal(s.productionReady, false)
})

test('formatSummary печатает все три планки и итог', () => {
  const text = formatSummary(summarize(clean(50)))
  assert.match(text, /Fact Check/)
  assert.match(text, /Meaning Check/)
  assert.match(text, /планка взята/)
})
