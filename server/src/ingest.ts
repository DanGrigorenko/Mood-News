import type { DatabaseSync } from 'node:sqlite'
import { parseFeed } from './rss.ts'
import { insertArticles } from './db.ts'
import { extractArticleText } from './article-text.ts'

export type Feed = { url: string; source: string }

// Русскоязычные RSS-ленты. Полный текст лента не отдаёт (ни content:encoded, ни
// длинный description) — Ingest забирает его со страницы публикации и хранит как
// Snippet (issue #11, новый ADR пересматривает 0004).
//
// Список сокращён до источников, чьи страницы открыты: Коммерсантъ, РИА Новости,
// Интерфакс. ТАСС (JS-капча Servicepipe) и Lenta.ru (редирект на заглушку)
// убраны — их страницы закрыты, а анонсами мы больше не довольствуемся. Ленты
// независимы: падение одной не мешает остальным (см. try/catch в ingest).
export const FEEDS: Feed[] = [
  { url: 'https://www.kommersant.ru/RSS/news.xml', source: 'Коммерсантъ' },
  { url: 'https://ria.ru/export/rss2/archive/index.xml', source: 'РИА Новости' },
  { url: 'https://www.interfax.ru/rss.asp', source: 'Интерфакс' },
]

export type IngestResult = { added: number; skipped: number }

export type IngestOptions = {
  feeds?: Feed[]
  fetchFeed?: (url: string) => Promise<string>
  fetchPage?: (url: string) => Promise<string>
  // Ход работы: Ingest стал заметно дольше (запрос на каждую новость), стартовый
  // прогон не должен выглядеть зависшим (issue #11). По умолчанию — тишина.
  onProgress?: (message: string) => void
}

async function fetchFeedOverHttp(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'mood-news/1.0' } })
  if (!res.ok) throw new Error(`лента ${url} ответила ${res.status}`)
  return res.text()
}

async function fetchPageOverHttp(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'mood-news/1.0' } })
  if (!res.ok) throw new Error(`страница ${url} ответила ${res.status}`)
  return res.text()
}

// Забор свежих Article из каждой ленты и их сохранение. Для каждой публикации
// Ingest идёт на её страницу и забирает полный текст в Snippet; новость, чей
// текст достать не удалось (заглушка, обрыв, недоступная страница), в базу не
// попадает — огрызков быть не должно (issue #11). Возвращает, сколько новых
// публикаций добавилось (без дублей) и сколько отброшено из-за недоступного
// текста.
//
// Ошибка одной ленты или одной страницы логируется и не прерывает остальные —
// acceptance criteria issue #3 и #11.
export async function ingest(
  db: DatabaseSync,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const feeds = options.feeds ?? FEEDS
  const fetchFeed = options.fetchFeed ?? fetchFeedOverHttp
  const fetchPage = options.fetchPage ?? fetchPageOverHttp
  const onProgress = options.onProgress ?? (() => {})

  let added = 0
  let skipped = 0
  for (const feed of feeds) {
    let items
    try {
      const xml = await fetchFeed(feed.url)
      items = parseFeed(xml, feed.source)
    } catch (err) {
      console.error(`Ingest ленты ${feed.source} провалился:`, err)
      continue
    }

    onProgress(`${feed.source}: ${items.length} публикаций, забираю тексты…`)

    const withText = []
    for (const item of items) {
      try {
        const html = await fetchPage(item.link)
        const text = extractArticleText(html, feed.source)
        if (text === null) {
          skipped++
          continue
        }
        withText.push({ ...item, announce: text })
      } catch (err) {
        console.error(`Ingest страницы ${item.link} провалился:`, err)
        skipped++
      }
    }

    const feedAdded = insertArticles(db, withText)
    added += feedAdded
    onProgress(`${feed.source}: добавлено ${feedAdded}, всего пропущено ${skipped}`)
  }
  return { added, skipped }
}
