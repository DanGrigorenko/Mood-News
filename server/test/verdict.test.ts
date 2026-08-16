import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  verdictOf,
  betterVerdict,
  accepted,
  fitForCache,
  anchorsPassed,
  type MeaningCheck,
} from '../src/verdict.ts'
import { UNCHANGED_SIMILARITY_THRESHOLD } from '../src/similarity.ts'
import type { Anchor } from '../src/anchor.ts'

const lost: Anchor[] = [{ kind: 'number', text: '15%' }]

// Ниже/выше порога непохожести — «переписано» и «копия Snippet».
const REWRITTEN = 0.1
const COPY = 0.9

// --- Одно определение «как прошла попытка»: три потребителя, одна таблица ---
//
// Каждая строка — сочетание (Missing Anchor / непохожесть / исход Meaning
// Check) и то, как его читают выход из цикла (accepted) и решение о кэше
// (fitForCache). Новое правило стоит одной строки. Ключевой инвариант issue #20:
// skipped выходит из цикла, но в кэш не пишется — «выходим, но не кэшируем».
const rows: Array<{
  name: string
  missing: Anchor[]
  similarity: number
  meaningCheck: MeaningCheck
  accepted: boolean
  fitForCache: boolean
}> = [
  // missing / similarity / meaningCheck            accepted  cache
  { name: 'чисто пройдено — годно всем',
    missing: [], similarity: REWRITTEN, meaningCheck: 'passed', accepted: true, fitForCache: true },
  { name: 'skipped — выходим, но не кэшируем',
    missing: [], similarity: REWRITTEN, meaningCheck: 'skipped', accepted: true, fitForCache: false },
  { name: 'failed — ещё один ретрай, мимо кэша',
    missing: [], similarity: REWRITTEN, meaningCheck: 'failed', accepted: false, fitForCache: false },
  { name: 'потерян Anchor — ретрай, мимо кэша',
    missing: lost, similarity: REWRITTEN, meaningCheck: 'skipped', accepted: false, fitForCache: false },
  { name: 'копия Snippet — ретрай, мимо кэша',
    missing: [], similarity: COPY, meaningCheck: 'skipped', accepted: false, fitForCache: false },
  { name: 'passed, но текст всё же копия — не годен',
    missing: [], similarity: COPY, meaningCheck: 'passed', accepted: false, fitForCache: false },
  { name: 'passed, но Anchor потерян — не годен',
    missing: lost, similarity: REWRITTEN, meaningCheck: 'passed', accepted: false, fitForCache: false },
]

for (const row of rows) {
  test(`вердикт: ${row.name}`, () => {
    const v = verdictOf({
      missing: row.missing,
      similarity: row.similarity,
      meaningCheck: row.meaningCheck,
      distortion: '',
    })
    assert.equal(accepted(v), row.accepted)
    assert.equal(fitForCache(v), row.fitForCache)
    // Кэш строже приёмки ровно на один шаг: годное для кэша всегда принято.
    if (row.fitForCache) assert.equal(row.accepted, true)
  })
}

test('порог непохожести определяет unchanged вердикта', () => {
  const below = verdictOf({ missing: [], similarity: UNCHANGED_SIMILARITY_THRESHOLD - 0.01, meaningCheck: 'passed', distortion: '' })
  const at = verdictOf({ missing: [], similarity: UNCHANGED_SIMILARITY_THRESHOLD, meaningCheck: 'passed', distortion: '' })
  assert.equal(below.unchanged, false)
  assert.equal(at.unchanged, true) // порог включительно — как в rewrite (issue #13)
  assert.equal(anchorsPassed(below), true)
  assert.equal(anchorsPassed(at), false)
})

// --- Порядок важности попыток сохранён дословно (issue #20) ---

const verdicts = {
  clean: verdictOf({ missing: [], similarity: REWRITTEN, meaningCheck: 'passed', distortion: '' }),
  lostAnchor: verdictOf({ missing: lost, similarity: REWRITTEN, meaningCheck: 'passed', distortion: '' }),
  distorted: verdictOf({ missing: [], similarity: REWRITTEN, meaningCheck: 'failed', distortion: 'исход искажён' }),
  copy: verdictOf({ missing: [], similarity: COPY, meaningCheck: 'skipped', distortion: '' }),
}

test('копия Snippet хуже искажения исхода', () => {
  assert.equal(betterVerdict(verdicts.copy, verdicts.distorted), verdicts.distorted)
})

test('искажение исхода хуже потерянного Anchor', () => {
  assert.equal(betterVerdict(verdicts.distorted, verdicts.lostAnchor), verdicts.lostAnchor)
})

test('потерянный Anchor хуже чистой попытки', () => {
  assert.equal(betterVerdict(verdicts.lostAnchor, verdicts.clean), verdicts.clean)
})

test('при равном ранге побеждает более далёкая от Snippet', () => {
  const near = verdictOf({ missing: [], similarity: 0.4, meaningCheck: 'passed', distortion: '' })
  const far = verdictOf({ missing: [], similarity: 0.1, meaningCheck: 'passed', distortion: '' })
  assert.equal(betterVerdict(near, far), far)
  assert.equal(betterVerdict(far, near), far)
})

test('betterVerdict при полном равенстве возвращает первый аргумент', () => {
  const a = verdictOf({ missing: [], similarity: 0.2, meaningCheck: 'passed', distortion: '' })
  const b = verdictOf({ missing: [], similarity: 0.2, meaningCheck: 'passed', distortion: '' })
  assert.equal(betterVerdict(a, b), a)
})
