import type { DatabaseSync } from 'node:sqlite'
import { parseFeed } from './rss.ts'
import { insertArticles } from './db.ts'

export type Feed = { url: string; source: string }

// Русскоязычные RSS-ленты. По ссылкам из ленты не ходим — берём только то, что
// отдал сам Source (docs/adr/0004). Ленты независимы: падение одной не мешает
// остальным (см. try/catch в ingest).
export const FEEDS: Feed[] = [
  { url: 'https://lenta.ru/rss/news', source: 'Lenta.ru' },
  { url: 'https://ria.ru/export/rss2/archive/index.xml', source: 'РИА Новости' },
  { url: 'https://tass.ru/rss/v2.xml', source: 'ТАСС' },
  { url: 'https://www.kommersant.ru/RSS/news.xml', source: 'Коммерсантъ' },
]

export type IngestResult = { added: number }

export type IngestOptions = {
  feeds?: Feed[]
  fetchFeed?: (url: string) => Promise<string>
}

async function fetchFeedOverHttp(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'mood-news/1.0' } })
  if (!res.ok) throw new Error(`лента ${url} ответила ${res.status}`)
  return res.text()
}

// Забор свежих Article из каждой ленты и их сохранение. Возвращает, сколько
// новых публикаций добавилось (без дублей). Ошибка одной ленты логируется и не
// прерывает остальные — acceptance criteria issue #3.
export async function ingest(
  db: DatabaseSync,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const feeds = options.feeds ?? FEEDS
  const fetchFeed = options.fetchFeed ?? fetchFeedOverHttp

  let added = 0
  for (const feed of feeds) {
    try {
      const xml = await fetchFeed(feed.url)
      added += insertArticles(db, parseFeed(xml, feed.source))
    } catch (err) {
      console.error(`Ingest ленты ${feed.source} провалился:`, err)
    }
  }
  return { added }
}
