import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRewriteStore, type RewriteFetch } from '../src/useRewrite.ts'
import { type Rewrite } from '../src/rewrite.ts'

function rewriteFor(mood: Rewrite['mood']): Rewrite {
  return {
    mood,
    title: `T:${mood}`,
    body: 'Тело',
    anchors: [],
    anchorCount: 0,
    missing: [],
    attempts: 1,
    stub: false,
    unchanged: false,
    meaningCheck: 'passed',
    distortion: '',
  }
}

// Подставная функция запроса: каждый вызов копит своё обещание, чтобы тест сам
// решал, когда и в каком порядке приходят ответы — сети и таймеров тут нет.
function deferredFetch() {
  const pending: {
    link: string
    mood: string
    resolve: (r: Rewrite) => void
    reject: (e: unknown) => void
  }[] = []
  const fetchOne: RewriteFetch = (link, mood) =>
    new Promise((resolve, reject) => {
      pending.push({ link, mood, resolve, reject })
    })
  return { fetchOne, pending }
}

// Дать отработать очереди микротасков после resolve/reject обещания.
const flush = () => new Promise((r) => setTimeout(r, 0))

test('ответ для пары, которую больше не выбрали, отбрасывается', async () => {
  const { fetchOne, pending } = deferredFetch()
  const store = createRewriteStore(fetchOne)

  store.select('a', 'joyful') // выбрали joyful
  store.select('a', 'sad') // переключили Mood на sad, joyful ещё в полёте

  // Ответ на joyful приходит последним — но эта пара уже не выбрана.
  pending[0].resolve(rewriteFor('joyful'))
  await flush()
  assert.equal(store.getState().rewrite, null, 'устаревший joyful не показан')
  assert.equal(store.getState().loading, true, 'всё ещё ждём sad')

  pending[1].resolve(rewriteFor('sad'))
  await flush()
  assert.equal(store.getState().rewrite?.mood, 'sad', 'на экране выбранный sad')
  assert.equal(store.getState().loading, false)
})

test('select переводит состояние в загрузку и сбрасывает прежний Rewrite', async () => {
  const { fetchOne, pending } = deferredFetch()
  const store = createRewriteStore(fetchOne)

  store.select('a', 'joyful')
  pending[0].resolve(rewriteFor('joyful'))
  await flush()
  assert.equal(store.getState().rewrite?.mood, 'joyful')

  store.select('a', 'sad')
  assert.equal(store.getState().loading, true)
  assert.equal(store.getState().rewrite, null, 'предыдущий регистр не мелькает')
  assert.equal(store.getState().error, null)
})

test('ошибка модели доезжает до состояния', async () => {
  const { fetchOne, pending } = deferredFetch()
  const store = createRewriteStore(fetchOne)

  store.select('a', 'joyful')
  assert.equal(store.getState().loading, true)

  pending[0].reject(new Error('модель недоступна'))
  await flush()
  assert.equal(store.getState().error, 'модель недоступна')
  assert.equal(store.getState().loading, false)
  assert.equal(store.getState().rewrite, null)
})

test('повтор перезапускает запрос за тем же Rewrite', async () => {
  const { fetchOne, pending } = deferredFetch()
  const store = createRewriteStore(fetchOne)

  store.select('a', 'joyful')
  pending[0].reject(new Error('лимит запросов'))
  await flush()
  assert.equal(store.getState().error, 'лимит запросов')

  store.retry()
  assert.equal(pending.length, 2, 'повтор пошёл в API ещё раз')
  assert.equal(pending[1].link, 'a')
  assert.equal(pending[1].mood, 'joyful')
  assert.equal(store.getState().loading, true, 'повтор снова грузит')
  assert.equal(store.getState().error, null, 'прежняя ошибка стёрта')

  pending[1].resolve(rewriteFor('joyful'))
  await flush()
  assert.equal(store.getState().rewrite?.mood, 'joyful')
})

test('повтор отменяет прежний запрос той же пары', async () => {
  const { fetchOne, pending } = deferredFetch()
  const store = createRewriteStore(fetchOne)

  store.select('a', 'joyful')
  store.retry() // первый запрос ещё в полёте, второй его вытесняет

  pending[0].resolve(rewriteFor('joyful')) // ответ первого — устаревший
  await flush()
  assert.equal(store.getState().loading, true, 'ждём ответ повтора, не первого')

  pending[1].resolve(rewriteFor('joyful'))
  await flush()
  assert.equal(store.getState().rewrite?.mood, 'joyful')
  assert.equal(store.getState().loading, false)
})

test('subscribe уведомляет об изменении и отписывается', async () => {
  const { fetchOne, pending } = deferredFetch()
  const store = createRewriteStore(fetchOne)

  let hits = 0
  const off = store.subscribe(() => {
    hits += 1
  })

  store.select('a', 'joyful') // set(loading) — уведомление
  assert.equal(hits, 1)
  pending[0].resolve(rewriteFor('joyful'))
  await flush()
  assert.equal(hits, 2)

  off()
  store.select('a', 'sad')
  assert.equal(hits, 2, 'после отписки уведомлений нет')
})

// Deletion test: состояние ходит в API общим способом из тикета контракта
// (fetchRewrite), а не зовёт глобальный fetch само.
test('deletion: useRewrite.ts не вызывает fetch напрямую', () => {
  const src = readFileSync(new URL('../src/useRewrite.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /fetch\(/, 'useRewrite.ts должен ходить через fetchRewrite')
})
