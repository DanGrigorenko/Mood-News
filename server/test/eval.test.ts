import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { summarize, formatSummary } from '../eval/aggregate.ts'
import type { Rewrite } from '../src/rewrite.ts'
import { MIN_SNIPPET_LENGTH } from '../src/ingest.ts'

// Корпус eval — данные с диска; читаем его так же, как раннер.
type CorpusEntry = { id: string; link: string; announce: string }
const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL('../eval/corpus.json', import.meta.url)), 'utf8'),
) as CorpusEntry[]

// --- Корпус снят с реальных Article и проходит порог длины (issue #13) ---

test('все записи корпуса проходят порог длины Snippet', () => {
  for (const entry of corpus) {
    assert.ok(
      entry.announce.length >= MIN_SNIPPET_LENGTH,
      `${entry.id}: ${entry.announce.length} < ${MIN_SNIPPET_LENGTH}`,
    )
  }
})

test('ссылки корпуса не из зоны eval.local — корпус снят с реальных Article', () => {
  for (const entry of corpus) {
    assert.doesNotMatch(entry.link, /eval\.local/, `${entry.id} всё ещё выдуман`)
  }
})

test('в корпусе есть случай у самой границы порога длины', () => {
  const shortest = Math.min(...corpus.map((e) => e.announce.length))
  // Худший допустимый вход: над порогом, но у самой границы, а не только
  // удобные длинные тексты (issue #13).
  assert.ok(shortest >= MIN_SNIPPET_LENGTH)
  assert.ok(shortest < MIN_SNIPPET_LENGTH + 50, `граничный кейс далёк от порога: ${shortest}`)
})

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
