import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import { extractAnchors, factCheck, anchorSchema, type Anchor } from './anchor.ts'
import { moodSchema, type Mood } from './mood.ts'
import {
  buildMessages,
  buildMeaningCheckMessages,
  type ModelCall,
  type MeaningCheckCall,
} from './llm.ts'
import type { Article } from './rss.ts'
import { getRewrite, insertRewrite } from './db.ts'

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
  // сработало. Все пять Mood обязаны отличаться от Snippet: после docs/adr/0006
  // Snippet — полный текст статьи, и нейтральный Rewrite обязан быть его
  // сжатием (issue #12). Провалившийся Rewrite в кэш не пишется (docs/adr/0008),
  // но поле остаётся в ответе API для eval и отладки — с экрана оно ушло.
  unchanged: z.boolean(),
  // Meaning Check — смысловая сверка Rewrite с источником (docs/adr/0005,
  // docs/adr/0007): passed — исход события сохранён; failed — найдено искажение
  // (см. distortion); skipped — сверка не отработала (нет ключа, сбой, не-JSON
  // от судьи). skipped честно означает «не проверено», а не «пройдено». Как и
  // unchanged, поле живёт в ответе API для eval, но не показывается читателю
  // (docs/adr/0008).
  meaningCheck: z.enum(['passed', 'failed', 'skipped']),
  // Название найденного искажения (Distortion) — непустое только при
  // meaningCheck === 'failed'.
  distortion: z.string(),
})
export type Rewrite = z.infer<typeof rewriteSchema>

// Первичная генерация плюс до двух ретраев по Missing Anchor (docs/adr/0002).
export const MAX_ATTEMPTS = 3

function anchorsOf(article: Article): Anchor[] {
  // Anchor извлекаются из всего Snippet — заголовка и анонса разом.
  return extractAnchors(`${article.title}\n${article.announce}`)
}

// Fact Check гоняется по объединению заголовка и тела: факт может законно
// переехать из одного в другое, и это не потеря.
function missingIn(title: string, body: string, anchors: Anchor[]): Anchor[] {
  return factCheck(`${title}\n${body}`, anchors).missing
}

// Нормализация для сравнения Rewrite со Snippet: всё, кроме букв и цифр,
// схлопывается в один пробел, регистр гасится. Так различие лишь в пробелах,
// регистре или пунктуации переписыванием не считается (issue #8).
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Порог непохожести: Rewrite считается unchanged, если доля словесных триграмм
// Snippet, дословно уцелевших в нём, не ниже порога (issue #13). Копия даёт около
// единицы, честное переписывание — заметно меньше: меняются и формулировки, и
// порядок слов. Именованная константа — калибруется по eval. Половина —
// стартовое значение: строгое сравнение на тождество («МОСКВА, 16 авг» → «16
// августа» уже формально изменение) пропускало копии, триграммы их ловят.
export const UNCHANGED_SIMILARITY_THRESHOLD = 0.5

// Прямая речь вырезается перед сравнением: цитата обязана пережить
// переписывание дословно (Anchor вида quote), и её уцелевшие триграммы говорят о
// послушании, а не о лени. На короткой новости, где цитата — треть текста, они
// одни давали sim 0.85 при честно переписанном остатке.
function withoutQuotes(text: string): string {
  return text.replace(/«[^»]*»/g, ' ')
}

// Словесные триграммы нормализованного текста: тройки соседних слов. Одиночные
// слова для меры непохожести не годятся — новость обязана переиспользовать
// существительные события, и по униграммам честный Rewrite неотличим от копии.
function wordTrigrams(text: string): string[] {
  const words = normalize(text).split(' ').filter(Boolean)
  const grams: string[] = []
  for (let i = 0; i + 3 <= words.length; i++) {
    grams.push(words.slice(i, i + 3).join(' '))
  }
  return grams
}

// Доля словесных триграмм Snippet, дословно уцелевших в Rewrite (0…1). Чистая
// функция: сравнение идёт по склейке заголовка и тела — так же, как Fact Check.
// Snippet короче трёх слов триграмм не даёт — тогда падаем на сравнение на
// тождество нормализованных строк (порог длины Ingest такого не пропустит, но
// функция обязана быть тотальной).
export function unchangedSimilarity(rewrite: string, snippet: string): number {
  const snippetGrams = wordTrigrams(withoutQuotes(snippet))
  if (snippetGrams.length === 0) {
    return normalize(rewrite) === normalize(snippet) ? 1 : 0
  }
  const rewriteGrams = new Set(wordTrigrams(withoutQuotes(rewrite)))
  const kept = snippetGrams.filter((g) => rewriteGrams.has(g)).length
  return kept / snippetGrams.length
}

// Сколько слов подряд должен насчитывать дословно перенесённый кусок, чтобы его
// стоило показывать модели. Шесть — длиннее случайного совпадения на обязательных
// существительных события и достаточно коротко, чтобы поймать перефраз по
// предложению, из которого состоят провалы на длинных статьях.
const SURVIVING_MIN_WORDS = 6
// Сколько кусков называть в ретрае. Список нужен, чтобы модель увидела, где
// именно она шла за источником, а не чтобы переписать за неё весь текст.
const SURVIVING_LIMIT = 3

// Куски Snippet, дословно уцелевшие в Rewrite, — от самого длинного. На длинной
// статье модель не тянет «пересобери заново» и идёт по источнику предложение за
// предложением, а голая просьба «смени формулировки» делает ретрай слепым.
// Названные куски делают его прицельным — так же, как Missing Anchor делает
// прицельным ретрай по фактам. Цитаты исключены: они обязаны уцелеть дословно.
export function survivingFragments(rewrite: string, snippet: string): string[] {
  const words = normalize(withoutQuotes(snippet)).split(' ').filter(Boolean)
  const haystack = ` ${normalize(withoutQuotes(rewrite))} `
  const found: string[] = []
  let i = 0
  while (i < words.length) {
    let len = 0
    while (
      i + len < words.length &&
      haystack.includes(` ${words.slice(i, i + len + 1).join(' ')} `)
    ) {
      len++
    }
    if (len >= SURVIVING_MIN_WORDS) {
      found.push(words.slice(i, i + len).join(' '))
      i += len
    } else {
      i++
    }
  }
  return found.sort((a, b) => b.length - a.length).slice(0, SURVIVING_LIMIT)
}

// Доля уцелевших триграмм Snippet в Rewrite. Сравнение идёт по объединению
// заголовка и тела — так же, как Fact Check.
function similarityTo(title: string, body: string, article: Article): number {
  return unchangedSimilarity(
    `${title}\n${body}`,
    `${article.title}\n${article.announce}`,
  )
}

// Одна попытка со всем, что о ней известно: по этим полям попытки и сравниваются.
type Attempt = {
  title: string
  body: string
  missing: Anchor[]
  unchanged: boolean
  similarity: number
  meaningCheck: Rewrite['meaningCheck']
  distortion: string
}

// Ранг попытки: чем меньше, тем лучше. Ретрай просит вернуть потерянное,
// сохранив регистр, но на деле тянет текст обратно к формулировкам источника:
// третья попытка сплошь и рядом набирает все Anchor ценой того, что становится
// почти копией (замер на живой модели: sim 0.19 на первой попытке против 0.93 на
// третьей). Поэтому отдаём лучшую попытку, а не последнюю.
//
// Порядок важности — по тому, что читатель получает на экране. Копия Snippet
// хуже всего: это не Rewrite вовсе, а источник под вывеской «переписано».
// Дальше искажение исхода — оно неправда. Потерянный Anchor мягче обоих: Fact
// Check показывает его честно («факты сохранены: 13/14»), и текст при этом
// остаётся настоящим переписыванием. Ни одна из этих попыток не кэшируется —
// ранг решает лишь, что показать, пока чистого результата нет.
function rank(a: Attempt): [number, number, number] {
  return [a.unchanged ? 1 : 0, a.meaningCheck === 'failed' ? 1 : 0, a.missing.length]
}

// Лучшая из двух попыток: сначала по рангу, при равенстве — та, что дальше от
// Snippet.
function better(a: Attempt, b: Attempt): Attempt {
  const [ra, rb] = [rank(a), rank(b)]
  for (let i = 0; i < ra.length; i++) {
    if (ra[i]! !== rb[i]!) return ra[i]! < rb[i]! ? a : b
  }
  return a.similarity <= b.similarity ? a : b
}

// Цикл: сгенерировать → Fact Check → Meaning Check. Если есть Missing Anchor
// или текст дословно совпал со Snippet — повторить, назвав причину. Только после
// того как Anchor-сверка пройдена, запускается Meaning Check (docs/adr/0005):
// модель сверяет исход события (Outcome) Rewrite с источником; найденное
// искажение (Distortion) — тоже неудачная попытка, оно называется в ретрае. Всё
// до MAX_ATTEMPTS попыток. Если после всех попыток потери, совпадение или
// искажение остались — возвращается лучшая (последняя валидная) попытка, а не
// 500 и не откат на Snippet (docs/adr/0008): читатель не упирается в ошибку.
// Провалившийся Rewrite не кэшируется — это забота resolveRewrite. Невалидный
// JSON (callModel вернул null) — ещё одна неудачная попытка. Сбой Meaning Check
// не роняет запрос: Anchor-валидный Rewrite отдаётся с пометкой
// meaningCheck:'skipped'. Все пять Mood, включая neutral, обязаны отличаться от
// Snippet (issue #12): после docs/adr/0006 Snippet — полный текст статьи.
export async function generateRewrite(
  article: Article,
  mood: Mood,
  callModel: ModelCall,
  meaningCheckModel: MeaningCheckCall,
): Promise<Rewrite> {
  const anchors = anchorsOf(article)
  let best: Attempt | null = null
  let missing: Anchor[] = []
  let unchanged = false
  let surviving: string[] = []
  let distortion = ''
  let attempts = 0

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const messages = buildMessages({
      mood,
      title: article.title,
      announce: article.announce,
      missing,
      unchanged,
      surviving,
      distortion,
    })
    const out = await callModel(messages)
    attempts++
    if (out === null) continue // невалидный JSON — ещё одна неудачная попытка
    missing = missingIn(out.title, out.body, anchors)
    const similarity = similarityTo(out.title, out.body, article)
    unchanged = similarity >= UNCHANGED_SIMILARITY_THRESHOLD
    surviving = unchanged
      ? survivingFragments(
          `${out.title}\n${out.body}`,
          `${article.title}\n${article.announce}`,
        )
      : []
    const attempt: Attempt = {
      ...out,
      missing,
      unchanged,
      similarity,
      meaningCheck: 'skipped',
      distortion: '',
    }
    best = best === null ? attempt : better(attempt, best)
    if (missing.length > 0 || unchanged) continue // Anchor-сверка не пройдена — ретрай

    // Anchor-сверка пройдена → Meaning Check (docs/adr/0005). Сбой запроса и
    // не-JSON от судьи трактуются одинаково: сверка ответа не дала. Не роняем
    // запрос — отдаём Anchor-валидный Rewrite, честно помечая сверку непройденной
    // (skipped), а не выдавая её за пройденную.
    let verdict
    try {
      verdict = await meaningCheckModel(
        buildMeaningCheckMessages({ title: article.title, announce: article.announce, rewrite: out }),
      )
    } catch {
      verdict = null
    }
    if (verdict === null || verdict.consistent) {
      attempt.meaningCheck = verdict === null ? 'skipped' : 'passed'
      distortion = ''
      best = better(attempt, best)
      break
    }
    // Искажение — ещё одна неудачная попытка, названная в следующем ретрае.
    attempt.meaningCheck = 'failed'
    attempt.distortion =
      verdict.distortion.trim() || 'исход события искажён относительно источника'
    distortion = attempt.distortion
    best = better(attempt, best)
  }

  if (best === null) {
    throw new Error('модель не вернула валидный JSON ни за одну попытку')
  }

  return {
    mood,
    title: best.title,
    body: best.body,
    anchors,
    anchorCount: anchors.length,
    missing: best.missing,
    attempts,
    stub: false, // модель вызывалась — это настоящий Rewrite
    unchanged: best.unchanged,
    meaningCheck: best.meaningCheck,
    distortion: best.distortion,
  }
}

// Заглушка без ключа: механически преобразованный Snippet, помеченный stub.
// Факты не трогает, поэтому проходит Fact Check всегда. attempts=0 — модель не
// вызывалась. Заглушка не выглядит как настоящий Rewrite: stub:true виден и в
// ответе API, и на экране.
export function stubRewrite(article: Article, mood: Mood): Rewrite {
  const anchors = anchorsOf(article)
  return {
    mood,
    title: article.title,
    body: article.announce,
    anchors,
    anchorCount: anchors.length,
    missing: missingIn(article.title, article.announce, anchors),
    attempts: 0,
    stub: true,
    // Заглушка честно совпадает со Snippet, но об этом говорит её собственная
    // пометка stub:true — вторую («unchanged») на неё не вешаем (issue #8).
    unchanged: false,
    // Модель не вызывалась — Meaning Check тоже: сверка не проведена, а не
    // пройдена (docs/adr/0005).
    meaningCheck: 'skipped',
    distortion: '',
  }
}

export type RewriteDeps = {
  callModel: ModelCall
  // Meaning Check — смысловая сверка Rewrite с источником (docs/adr/0005).
  meaningCheckModel: MeaningCheckCall
  // Без LLM_API_KEY отдаём заглушку вместо обращения к модели.
  useStub: boolean
}

// Прошёл ли Rewrite обе сверки — только такой достоин кэша (docs/adr/0008):
// это не заглушка, все Anchor на месте, текст отличается от Snippet и Meaning
// Check пройден. skipped и failed не кэшируются наравне с чистым результатом,
// иначе одна неудачная попытка стала бы вечным свойством новости (docs/adr/0001).
function passedBothChecks(rewrite: Rewrite): boolean {
  return (
    !rewrite.stub &&
    rewrite.missing.length === 0 &&
    !rewrite.unchanged &&
    rewrite.meaningCheck === 'passed'
  )
}

// Ленивый кэш (docs/adr/0001): при попадании читаем из базы, при промахе
// генерируем. В кэш пишется только прошедшее обе сверки (docs/adr/0008):
// провалившийся Rewrite отдаётся читателю (лучшая попытка, а не 500), но не
// кэшируется — следующее открытие пары «Article + Mood» генерит заново, а не
// показывает тот же провал навсегда. Заглушка тоже мимо кэша: с появлением ключа
// генерация происходит по-настоящему.
export async function resolveRewrite(
  db: DatabaseSync,
  article: Article,
  mood: Mood,
  deps: RewriteDeps,
): Promise<Rewrite> {
  const cached = getRewrite(db, article.link, mood)
  if (cached) return cached

  const rewrite = deps.useStub
    ? stubRewrite(article, mood)
    : await generateRewrite(article, mood, deps.callModel, deps.meaningCheckModel)

  if (passedBothChecks(rewrite)) insertRewrite(db, article.link, mood, rewrite)
  return rewrite
}
