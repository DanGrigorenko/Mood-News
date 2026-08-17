// Извлечение полного текста статьи со страницы публикации. Само правило разбора
// (адресный контейнер конкретной вёрстки) живёт рядом с url ленты в module
// Source; здесь — только применение правила к сохранённому HTML.

import { SOURCES } from './source.ts'
import type { Source } from '../../shared/api.mts'

// Полный текст короче этого — не статья, а обрывок или пустой контейнер: сюда
// же попадает антибот-заглушка, если её вёрстка случайно задела наш селектор.
// Сохранять новость наполовину нельзя (issue #11) — такой текст даёт null.
const MIN_ARTICLE_TEXT = 200

// Снятие тегов и нормализация пробелов внутри одного абзаца. Внутренние теги
// (<a>, <b>, <strong>) уходят, их текст остаётся.
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

// Полный текст статьи по разметке источника — или null, если тела нет либо оно
// подозрительно короткое. Чистая функция: сеть снаружи (ingest), здесь только
// разбор сохранённого HTML — тестируется без сети (issue #11).
export function extractArticleText(html: string, source: Source): string | null {
  const { rule } = SOURCES[source]

  let scope = html
  if (rule.region) {
    const region = rule.region.exec(html)
    if (!region) return null
    scope = region[1]
  }

  const paragraphs: string[] = []
  for (const match of scope.matchAll(rule.block)) {
    const text = stripHtml(match[1])
    if (text !== '') paragraphs.push(text)
  }

  const full = paragraphs.join('\n\n')
  if (full.length < MIN_ARTICLE_TEXT) return null
  return full
}
