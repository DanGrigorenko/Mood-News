import { XMLParser } from 'fast-xml-parser'

// Форма Article описана один раз в общем контракте shared/api.mts (ответ API) и
// оттуда же валидирует ленту при разборе: сущность одна на проводе и в парсере.
import { articleSchema, type Article } from '../../shared/api.mts'

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

// Безопасный доступ к вложенному объекту: не объект (или null) — undefined.
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function extractItems(parsed: unknown): RawItem[] {
  const item = asObject(asObject(asObject(parsed)?.rss)?.channel)?.item
  if (Array.isArray(item)) return item.filter(isRawItem)
  if (isRawItem(item)) return [item]
  return []
}

function isRawItem(value: unknown): value is RawItem {
  return asObject(value) !== undefined
}
