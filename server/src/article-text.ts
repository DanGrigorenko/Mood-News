// Извлечение полного текста статьи со страницы публикации. Универсального
// разбора не существует: общий проход по абзацам тащит рекламу, меню и
// навигацию (проверено). Поэтому по одному узкому правилу на источник —
// адресный контейнер конкретной вёрстки, а не «весь текст страницы».
//
// Проверено 2026-08-16 (см. новый ADR, пересматривающий 0004):
//   Коммерсантъ — абзацы <p class="doc__text">
//   РИА Новости — блоки <div class="article__text">
//   Интерфакс   — абзацы <p> внутри <article itemprop="articleBody">
// ТАСС и Lenta.ru закрыты антиботом/редиректом — их страницы не парсим, а
// источники убраны из FEEDS.

// Полный текст короче этого — не статья, а обрывок или пустой контейнер: сюда
// же попадает антибот-заглушка, если её вёрстка случайно задела наш селектор.
// Сохранять новость наполовину нельзя (issue #11) — такой текст даёт null.
const MIN_ARTICLE_TEXT = 200

type Rule = {
  // region (необязателен): сначала сузить HTML до одного контейнера с телом
  // статьи, чтобы блоки за его пределами не попадали в текст. Группа 1 — тело.
  region?: RegExp
  // block: как выглядит один текстовый блок внутри тела. Глобальный флаг, группа
  // 1 — внутренний HTML блока (теги снимаются отдельно).
  block: RegExp
}

// Правило извлечения на источник. Ключ — строка source из FEEDS.
const RULES: Record<string, Rule> = {
  Коммерсантъ: {
    block: /<p[^>]*class="[^"]*\bdoc__text\b[^"]*"[^>]*>([\s\S]*?)<\/p>/g,
  },
  'РИА Новости': {
    block: /<div[^>]*class="[^"]*\barticle__text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g,
  },
  Интерфакс: {
    region: /<article[^>]*itemprop="articleBody"[^>]*>([\s\S]*?)<\/article>/,
    block: /<p[^>]*>([\s\S]*?)<\/p>/g,
  },
}

// Снятие тегов и нормализация пробелов внутри одного абзаца. Внутренние теги
// (<a>, <b>, <strong>) уходят, их текст остаётся.
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

// Полный текст статьи по разметке источника — или null, если тела нет либо оно
// подозрительно короткое. Чистая функция: сеть снаружи (ingest), здесь только
// разбор сохранённого HTML — тестируется без сети (issue #11).
export function extractArticleText(html: string, source: string): string | null {
  const rule = RULES[source]
  if (!rule) return null

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
