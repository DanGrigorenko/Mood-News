import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, listArticles, countArticles } from '../src/db.ts'
import { ingest } from '../src/ingest.ts'

const feedXml = (n: number) => `<?xml version="1.0"?>
  <rss version="2.0"><channel>
    <item><title>Новость ${n}</title><link>https://src.test/${n}</link>
      <description>Анонс ${n}</description>
      <pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate></item>
    <item><title>Новость ${n + 1}</title><link>https://src.test/${n + 1}</link>
      <description>Анонс ${n + 1}</description>
      <pubDate>Mon, 16 Aug 2026 10:00:00 +0300</pubDate></item>
  </channel></rss>`

test('ingest сохраняет Article из ленты и сообщает, сколько добавилось', async () => {
  const db = openDb(':memory:')
  const feeds = [{ url: 'https://a.test/rss', source: 'A' }]
  const result = await ingest(db, { feeds, fetchFeed: async () => feedXml(1) })

  assert.equal(result.added, 2)
  assert.equal(countArticles(db), 2)
  assert.equal(listArticles(db)[0].source, 'A')
})

test('повторный Ingest уже известной публикации ничего не добавляет', async () => {
  const db = openDb(':memory:')
  const feeds = [{ url: 'https://a.test/rss', source: 'A' }]
  const fetchFeed = async () => feedXml(1)

  const first = await ingest(db, { feeds, fetchFeed })
  const second = await ingest(db, { feeds, fetchFeed })

  assert.equal(first.added, 2)
  assert.equal(second.added, 0)
  assert.equal(countArticles(db), 2)
})

test('недоступность одной ленты не роняет Ingest — остальные сохраняются', async () => {
  const db = openDb(':memory:')
  const feeds = [
    { url: 'https://down.test/rss', source: 'Down' },
    { url: 'https://ok.test/rss', source: 'Ok' },
  ]
  const fetchFeed = async (url: string) => {
    if (url.includes('down')) throw new Error('лента недоступна')
    return feedXml(10)
  }

  const result = await ingest(db, { feeds, fetchFeed })
  assert.equal(result.added, 2)
  assert.equal(countArticles(db), 2)
})
