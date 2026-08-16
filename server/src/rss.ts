import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'

// Article в том виде, в каком его отдал Source: Snippet (title + announce),
// ссылка на оригинал и дата публикации. Полный текст не забираем — см.
// docs/adr/0004-snippet-only-no-page-scraping.md.
export const articleSchema = z.object({
  link: z.string().url(),
  source: z.string(),
  title: z.string().min(1),
  announce: z.string(),
  publishedAt: z.string(),
})

export type Article = z.infer<typeof articleSchema>

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true })

// RSS-поля приходят строкой, числом или объектом CDATA — приводим к строке.
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

// Анонс из ленты нередко приходит с HTML-обёрткой (<p>, <img>). Снимаем теги,
// чтобы в гриде был чистый текст, но сам текст оставляем как отдал Source.
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function toIso(pubDate: unknown): string {
  const raw = asText(pubDate)
  if (raw === '') return ''
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString()
}

// Чистая функция: XML ленты → список Article. Сеть и хранилище снаружи.
// На битом XML или отсутствии item возвращает [], а не бросает.
export function parseFeed(xml: string, source: string): Article[] {
  let parsed: unknown
  try {
    parsed = parser.parse(xml)
  } catch {
    return []
  }

  const rawItems = extractItems(parsed)
  const articles: Article[] = []
  for (const item of rawItems) {
    const candidate = {
      link: asText(item.link),
      source,
      title: stripHtml(asText(item.title)),
      announce: stripHtml(asText(item.description)),
      publishedAt: toIso(item.pubDate),
    }
    const result = articleSchema.safeParse(candidate)
    if (result.success) articles.push(result.data)
  }
  return articles
}

type RawItem = Record<string, unknown>

function extractItems(parsed: unknown): RawItem[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const channel = (parsed as Record<string, unknown>).rss
  const inner =
    typeof channel === 'object' && channel !== null
      ? (channel as Record<string, unknown>).channel
      : undefined
  const item =
    typeof inner === 'object' && inner !== null
      ? (inner as Record<string, unknown>).item
      : undefined
  if (Array.isArray(item)) return item.filter(isRawItem)
  if (isRawItem(item)) return [item]
  return []
}

function isRawItem(value: unknown): value is RawItem {
  return typeof value === 'object' && value !== null
}
