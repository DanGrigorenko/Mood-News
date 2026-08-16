import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import { extractAnchors, factCheck, anchorSchema, type Anchor } from './anchor.ts'
import { moodSchema, type Mood } from './mood.ts'
import {
  buildMessages,
  buildReviewMessages,
  type ModelCall,
  type ReviewCall,
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
  // сработало. Как и Missing Anchor, промах не прячется, а показывается
  // читателю (docs/adr/0003, issue #8). Для Mood neutral всегда false: сухой
  // пересказ вправе совпасть с источником.
  unchanged: z.boolean(),
  // Второй проход — смысловая сверка Rewrite с источником (docs/adr/0005,
  // issue #10): passed — противоречий нет; failed — найдено неустранённое
  // противоречие (см. contradiction); skipped — сверка не отработала (нет ключа,
  // сбой, не-JSON от судьи). skipped честно означает «не проверено», а не
  // «пройдено».
  review: z.enum(['passed', 'failed', 'skipped']),
  // Название найденного противоречия — непустое только при review === 'failed'.
  // Показывается читателю рядом с Fact Check (docs/adr/0003).
  contradiction: z.string(),
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

// Совпал ли Rewrite со Snippet дословно (по нормализованному тексту). Сравнение
// идёт по объединению заголовка и тела — так же, как Fact Check.
function matchesSnippet(title: string, body: string, article: Article): boolean {
  return (
    normalize(`${title}\n${body}`) ===
    normalize(`${article.title}\n${article.announce}`)
  )
}

// Цикл: сгенерировать → Fact Check → смысловая сверка. Если есть Missing Anchor
// или текст дословно совпал со Snippet — повторить, назвав причину. Только после
// того как Anchor-сверка пройдена, запускается второй проход (docs/adr/0005):
// модель сверяет Rewrite с источником; найденное противоречие — тоже неудачная
// попытка, оно называется в ретрае. Всё до MAX_ATTEMPTS попыток. Если после всех
// попыток потери, совпадение или противоречие остались — Rewrite всё равно
// возвращается с честной пометкой (не 500, не откат на Snippet, docs/adr/0003).
// Невалидный JSON (callModel вернул null) — ещё одна неудачная попытка. Сбой
// второго прохода не роняет запрос: Anchor-валидный Rewrite отдаётся с пометкой
// review:'skipped'. Mood neutral от отличия не требуется: сухой пересказ вправе
// совпасть с источником.
export async function generateRewrite(
  article: Article,
  mood: Mood,
  callModel: ModelCall,
  reviewModel: ReviewCall,
): Promise<Rewrite> {
  const anchors = anchorsOf(article)
  const mustDiffer = mood !== 'neutral'
  let last: { title: string; body: string } | null = null
  let missing: Anchor[] = []
  let unchanged = false
  let contradiction = ''
  let review: Rewrite['review'] = 'skipped'
  let attempts = 0

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const messages = buildMessages({
      mood,
      title: article.title,
      announce: article.announce,
      anchors,
      missing,
      unchanged,
      contradiction,
    })
    const out = await callModel(messages)
    attempts++
    if (out === null) continue // невалидный JSON — ещё одна неудачная попытка
    last = out
    missing = missingIn(out.title, out.body, anchors)
    unchanged = mustDiffer && matchesSnippet(out.title, out.body, article)
    if (missing.length > 0 || unchanged) continue // Anchor-сверка не пройдена — ретрай

    // Anchor-сверка пройдена → второй проход: смысловая сверка (docs/adr/0005).
    // Сбой запроса и не-JSON от судьи трактуются одинаково: сверка ответа не
    // дала. Не роняем запрос — отдаём Anchor-валидный Rewrite, честно помечая
    // сверку непройденной (skipped), а не выдавая её за пройденную.
    let verdict
    try {
      verdict = await reviewModel(
        buildReviewMessages({ title: article.title, announce: article.announce, rewrite: out }),
      )
    } catch {
      verdict = null
    }
    if (verdict === null) {
      review = 'skipped'
      contradiction = ''
      break
    }
    if (verdict.consistent) {
      review = 'passed'
      contradiction = ''
      break
    }
    // Противоречие — ещё одна неудачная попытка, названная в следующем ретрае.
    review = 'failed'
    contradiction = verdict.contradiction.trim() || 'смысл искажён относительно источника'
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
    review,
    contradiction,
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
    // Модель не вызывалась — второй проход тоже: сверка не проведена, а не
    // пройдена (docs/adr/0005).
    review: 'skipped',
    contradiction: '',
  }
}

export type RewriteDeps = {
  callModel: ModelCall
  // Второй проход — смысловая сверка Rewrite с источником (docs/adr/0005).
  reviewModel: ReviewCall
  // Без LLM_API_KEY отдаём заглушку вместо обращения к модели.
  useStub: boolean
}

// Ленивый вечный кэш (docs/adr/0001): при попадании читаем из базы, при промахе
// генерируем и сохраняем. Заглушка в кэш не попадает под видом настоящего
// Rewrite — с появлением ключа генерация происходит по-настоящему.
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
    : await generateRewrite(article, mood, deps.callModel, deps.reviewModel)

  if (!rewrite.stub) insertRewrite(db, article.link, mood, rewrite)
  return rewrite
}
