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
  const snippetGrams = wordTrigrams(snippet)
  if (snippetGrams.length === 0) {
    return normalize(rewrite) === normalize(snippet) ? 1 : 0
  }
  const rewriteGrams = new Set(wordTrigrams(rewrite))
  const kept = snippetGrams.filter((g) => rewriteGrams.has(g)).length
  return kept / snippetGrams.length
}

// Слишком ли похож Rewrite на Snippet, чтобы считать его переписыванием.
// Сравнение идёт по объединению заголовка и тела — так же, как Fact Check.
function matchesSnippet(title: string, body: string, article: Article): boolean {
  return (
    unchangedSimilarity(
      `${title}\n${body}`,
      `${article.title}\n${article.announce}`,
    ) >= UNCHANGED_SIMILARITY_THRESHOLD
  )
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
  let last: { title: string; body: string } | null = null
  let missing: Anchor[] = []
  let unchanged = false
  let distortion = ''
  let meaningCheck: Rewrite['meaningCheck'] = 'skipped'
  let attempts = 0

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const messages = buildMessages({
      mood,
      title: article.title,
      announce: article.announce,
      anchors,
      missing,
      unchanged,
      distortion,
    })
    const out = await callModel(messages)
    attempts++
    if (out === null) continue // невалидный JSON — ещё одна неудачная попытка
    last = out
    missing = missingIn(out.title, out.body, anchors)
    unchanged = matchesSnippet(out.title, out.body, article)
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
    if (verdict === null) {
      meaningCheck = 'skipped'
      distortion = ''
      break
    }
    if (verdict.consistent) {
      meaningCheck = 'passed'
      distortion = ''
      break
    }
    // Искажение — ещё одна неудачная попытка, названная в следующем ретрае.
    meaningCheck = 'failed'
    distortion = verdict.distortion.trim() || 'исход события искажён относительно источника'
  }

  if (last === null) {
    throw new Error('модель не вернула валидный JSON ни за одну попытку')
  }

  return {
    mood,
    title: last.title,
    body: last.body,
    anchors,
    anchorCount: anchors.length,
    missing,
    attempts,
    stub: false, // модель вызывалась — это настоящий Rewrite
    unchanged,
    meaningCheck,
    distortion,
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
