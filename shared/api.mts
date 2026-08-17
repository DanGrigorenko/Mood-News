import { z } from 'zod'

// Контракт API Mood News: форма ответов сервера, описанная ОДИН раз для обеих
// сторон. Сервер строит по этим схемам ответ, фронт им же его разбирает.
// Расхождение формы теперь ловит компилятор (общий тип), а не пустой экран.
// Здесь только форма данных на проводе — представление (сводка Fact Check,
// разбор текста ошибки) живёт на фронте, генерация Rewrite — на сервере.

// --- Mood ---

// Набор Mood конечен и задан кодом — пользователь не может придумать свой
// (см. CONTEXT.md). Порядок здесь — порядок, в котором Mood показываются фронту.
export const MOOD_IDS = ['neutral', 'joyful', 'sad', 'ironic', 'dramatic'] as const

// Mood в ответе — это его id, а не свободная строка. Одна форма на обе стороны:
// сервер отдаёт id из этого набора, фронт валидирует по нему же (а не как любую
// строку). Смена набора Mood — правка одной этой строки.
export const moodSchema = z.enum(MOOD_IDS)
export type Mood = z.infer<typeof moodSchema>

// Элемент списка GET /api/moods: id — машинный ключ для запроса Rewrite, label —
// человеческое название для переключателя. Фронт показывает то, что отдал сервер.
export const moodOptionSchema = z.object({ id: moodSchema, label: z.string() })
export type MoodOption = z.infer<typeof moodOptionSchema>

export const moodsResponseSchema = z.object({ moods: z.array(moodOptionSchema) })
export type MoodsResponse = z.infer<typeof moodsResponseSchema>

// --- Source ---

// Source — внешняя лента, из которой пришла Article. Набор конечен и задан
// проектом (как MOOD_IDS): читатель не заводит свой. Id живёт здесь, в общем
// контракте, а не в server/src/source.ts, потому что едет на провод в каждой
// Article; url ленты и правило извлечения остаются на сервере, рядом друг с
// другом (issue #30). Опечатка в ключе — ошибка компиляции, а не погасшая лента.
export const SOURCE_IDS = ['Коммерсантъ', 'РИА Новости', 'Интерфакс'] as const

export const sourceSchema = z.enum(SOURCE_IDS)
export type Source = z.infer<typeof sourceSchema>

// --- Anchor ---

// Виды Anchor (см. server/anchor.ts): число/дата/сумма — «number», содержимое
// кавычек — «quote», имя собственное — «name».
export const anchorKindSchema = z.enum(['number', 'quote', 'name'])
export type AnchorKind = z.infer<typeof anchorKindSchema>

// Anchor — факт, обязанный дословно пережить переписывание.
export const anchorSchema = z.object({
  kind: anchorKindSchema,
  text: z.string().min(1),
})
export type Anchor = z.infer<typeof anchorSchema>

// --- Article ---

// Article в том виде, в каком его отдаёт сервер: title, ссылка, дата и announce
// (полный текст статьи после docs/adr/0006).
export const articleSchema = z.object({
  link: z.string().url(),
  source: sourceSchema,
  title: z.string().min(1),
  announce: z.string(),
  publishedAt: z.string(),
})
export type Article = z.infer<typeof articleSchema>

export const articlesResponseSchema = z.object({ articles: z.array(articleSchema) })
export type ArticlesResponse = z.infer<typeof articlesResponseSchema>

// --- Rewrite ---

// Rewrite — версия Article в конкретном Mood: переписанные заголовок и тело плюс
// результат Fact Check (число Anchor, список Missing Anchor и число попыток).
// stub помечает заглушку, отданную без обращения к модели.
export const rewriteSchema = z.object({
  mood: moodSchema,
  title: z.string(),
  body: z.string(),
  anchors: z.array(anchorSchema),
  anchorCount: z.number().int().nonnegative(),
  missing: z.array(anchorSchema),
  attempts: z.number().int().nonnegative(),
  stub: z.boolean(),
  // Rewrite после всех попыток дословно совпал со Snippet — переписывание не
  // сработало. Провалившийся Rewrite в кэш не пишется (docs/adr/0008), но поле
  // остаётся в ответе API для eval и отладки — с экрана оно ушло (issue #12).
  unchanged: z.boolean(),
  // Meaning Check — смысловая сверка Rewrite с источником (docs/adr/0005,
  // docs/adr/0007): passed — исход события сохранён; failed — найдено искажение
  // (см. distortion); skipped — сверка не отработала (нет ключа, сбой, не-JSON
  // от судьи). skipped честно означает «не проверено», а не «пройдено». Как и
  // unchanged, поле живёт в ответе API для eval, но не показывается читателю.
  meaningCheck: z.enum(['passed', 'failed', 'skipped']),
  // Название найденного искажения (Distortion) — непустое только при
  // meaningCheck === 'failed'.
  distortion: z.string(),
})
export type Rewrite = z.infer<typeof rewriteSchema>

export const rewriteResponseSchema = z.object({
  article: articleSchema,
  rewrite: rewriteSchema,
})
export type RewriteResponse = z.infer<typeof rewriteResponseSchema>

// --- Ingest ---

// Ответ POST /api/ingest: сколько новостей добавлено и сколько отброшено при
// заборе полного текста (нет правила или тела, текст короче порога, запрос
// страницы упал). skipped несёт контракт наравне с added: раньше сервер его
// считал, но схема ответа его срезала, роут единственный из четырёх не прогонял
// ответ через схему — и погасшая лента до экрана не доходила (issue #30).
export const ingestResultSchema = z.object({
  added: z.number(),
  skipped: z.number(),
})
export type IngestResult = z.infer<typeof ingestResultSchema>
