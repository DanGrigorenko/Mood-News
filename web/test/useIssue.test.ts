import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIssueStore } from '../src/useIssue.ts'
import { type Article, type IngestResult } from '../../shared/api.mts'

function articleAt(link: string): Article {
  return {
    link,
    title: `T:${link}`,
    announce: '',
    source: 'РИА Новости',
    publishedAt: '2026-08-16T06:00:00.000Z',
  }
}

// Подставные способы сходить в API — те же зависимости, что fetchRewrite у
// хранилища Rewrite. Каждый вызов копит своё обещание, чтобы тест сам решал,
// когда и чем оно разрешается: сети и таймеров тут нет.
function deferred<T>() {
  const pending: {
    resolve: (v: T) => void
    reject: (e: unknown) => void
  }[] = []
  const fn = () =>
    new Promise<T>((resolve, reject) => {
      pending.push({ resolve, reject })
    })
  return { fn, pending }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

test('успешное обновление кладёт уведомление и обновляет список', async () => {
  const articles = deferred<Article[]>()
  const ingest = deferred<IngestResult>()
  const store = createIssueStore({
    fetchArticles: articles.fn,
    runIngest: ingest.fn,
  })

  void store.refresh()
  assert.equal(store.getState().refreshing, true, 'идёт обновление')

  ingest.pending[0].resolve({ added: 2, skipped: 0 })
  await flush()
  assert.equal(store.getState().notice, 'Добавлено 2 новости', 'уведомление')

  articles.pending[0].resolve([articleAt('a'), articleAt('b')])
  await flush()
  assert.equal(store.getState().articles.length, 2, 'список перечитан')
  assert.equal(store.getState().refreshing, false, 'обновление завершено')
  assert.equal(store.getState().error, null)
})

test('провал обновления кладёт ошибку и снимает признак «идёт обновление»', async () => {
  const articles = deferred<Article[]>()
  const ingest = deferred<IngestResult>()
  const store = createIssueStore({
    fetchArticles: articles.fn,
    runIngest: ingest.fn,
  })

  void store.refresh()
  assert.equal(store.getState().refreshing, true)

  ingest.pending[0].reject(new Error('Ingest упал'))
  await flush()
  assert.equal(store.getState().error, 'Ingest упал', 'ошибка доехала')
  assert.equal(store.getState().refreshing, false, 'признак снят даже при провале')
})

test('провал загрузки списка не стирает уже показанный список', async () => {
  const articles = deferred<Article[]>()
  const ingest = deferred<IngestResult>()
  const store = createIssueStore({
    fetchArticles: articles.fn,
    runIngest: ingest.fn,
  })

  // Сначала показали список.
  void store.load()
  articles.pending[0].resolve([articleAt('a')])
  await flush()
  assert.equal(store.getState().articles.length, 1)

  // Повторная загрузка падает — уже показанный список остаётся на экране.
  void store.load()
  articles.pending[1].reject(new Error('лента недоступна'))
  await flush()
  assert.equal(store.getState().articles.length, 1, 'список не стёрт')
  assert.equal(store.getState().error, 'лента недоступна')
})

test('subscribe уведомляет об изменении и отписывается', async () => {
  const articles = deferred<Article[]>()
  const store = createIssueStore({ fetchArticles: articles.fn })

  let hits = 0
  const off = store.subscribe(() => {
    hits += 1
  })

  void store.load() // без промежуточного состояния загрузки — set по ответу
  articles.pending[0].resolve([articleAt('a')])
  await flush()
  assert.equal(hits, 1)

  off()
  void store.load()
  articles.pending[1].resolve([articleAt('b')])
  await flush()
  assert.equal(hits, 1, 'после отписки уведомлений нет')
})
