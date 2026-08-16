import type { DatabaseSync } from 'node:sqlite'
import { parseFeed } from './rss.ts'
import { insertArticles } from './db.ts'
import { extractArticleText } from './article-text.ts'
import { SOURCES, type Source } from './source.ts'
import { type IngestResult } from '../../shared/api.mts'

export type Feed = { url: string; source: Source }

// Ленты, из которых идёт Ingest, — по одной на Source. Список и url ленты живут
// в module Source рядом с правилом извлечения (issue #30): здесь FEEDS лишь
// разворачивает конечный набор в список пар {url, source}. Полный текст лента не
// отдаёт (ни content:encoded, ни длинный description) — Ingest забирает его со
// страницы публикации и хранит как Snippet (issue #11, новый ADR пересматривает
// 0004). Ленты независимы: падение одной не мешает остальным (см. try/catch).
export const FEEDS: Feed[] = (Object.keys(SOURCES) as Source[]).map((source) => ({
  url: SOURCES[source].url,
  source,
}))

// Служебная шапка агентства в начале текста: заглавный топоним, дата, тире,
// название агентства, точка — «МОСКВА, 16 авг - РИА Новости.». Она принадлежит
// Source, а не событию, но даёт добрую половину Anchor на короткой заметке
// («16», «РИА», «Новости» — ни один не факт истории) и тем самым замораживает
// синтаксис Rewrite (issue #13). Правило узкое и якорится на начало: топоним —
// только заглавными, сразу перед запятой; дата — число и месяц; агентство —
// последовательность слов с заглавной. Не совпало — текст не трогается.
const AGENCY_HEADER =
  /^[А-ЯЁ][А-ЯЁ .\-]*,\s*\d{1,2}\s+[а-яё]+\.?\s*[–—-]\s*[А-ЯЁ][А-Яа-яё]*(?:\s+[А-ЯЁ][А-Яа-яё]*)*\.\s*/u

// Срез служебной шапки агентства из начала текста. Совпадения нет — возвращается
// та же строка без единого изменённого символа (issue #13). Дата и Source
// показаны читателю отдельными полями, поэтому на экране ничего не теряется.
export function stripAgencyHeader(text: string): string {
  return text.replace(AGENCY_HEADER, '')
}

// Порог длины Snippet: Article, чей текст (после среза шапки) короче порога, в
// базу не попадает — продолжение ADR-0006 «нет полного текста — нет новости».
// Из одного-двух предложений пять разных регистров сделать нельзя, не добавляя
// отсебятины: обязательные к сохранению Anchor занимают почти весь короткий
// текст (issue #13). Именованная константа — калибруется по eval, а не ищется по
// коду. Замер по базе: 500 отсекает ~11% ленты (медиана 870). Порог применяется
// после среза шапки. Отсев по длине попадает в тот же счётчик skipped.
export const MIN_SNIPPET_LENGTH = 500

export type IngestOptions = {
  feeds?: Feed[]
  fetchFeed?: (url: string) => Promise<string>
  fetchPage?: (url: string) => Promise<string>
  // Ход работы: Ingest стал заметно дольше (запрос на каждую новость), стартовый
  // прогон не должен выглядеть зависшим (issue #11). По умолчанию — тишина.
  onProgress?: (message: string) => void
}

// Один HTTP-GET с нашим user-agent для ленты и для страницы публикации. what —
// «лента» или «страница», подставляется в сообщение об ошибке (оба слова
// женского рода — «ответила»).
async function fetchOverHttp(url: string, what: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'mood-news/1.0' } })
  if (!res.ok) throw new Error(`${what} ${url} ответила ${res.status}`)
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
  const fetchFeed = options.fetchFeed ?? ((url) => fetchOverHttp(url, 'лента'))
  const fetchPage = options.fetchPage ?? ((url) => fetchOverHttp(url, 'страница'))
  const onProgress = options.onProgress ?? (() => {})

  let added = 0
  let skipped = 0
  for (const feed of feeds) {
    let xml: string
    try {
      xml = await fetchFeed(feed.url)
    } catch (err) {
      console.error(`Ingest ленты ${feed.source} провалился:`, err)
      continue
    }
    // parseFeed — чистая функция, на битом XML возвращает [], а не бросает (rss.ts).
    const items = parseFeed(xml, feed.source)

    onProgress(`${feed.source}: ${items.length} публикаций, забираю тексты…`)

    const withText = []
    for (const item of items) {
      try {
        const html = await fetchPage(item.link)
        const extracted = extractArticleText(html, feed.source)
        if (extracted === null) {
          skipped++
          continue
        }
        // Срез шапки — до порога длины: короткий текст меряется по событию, а не
        // по типографике ленты (issue #13).
        const text = stripAgencyHeader(extracted)
        if (text.length < MIN_SNIPPET_LENGTH) {
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
