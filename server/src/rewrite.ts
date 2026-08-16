import type { DatabaseSync } from 'node:sqlite'
import { extractAnchors, factCheck } from './anchor.ts'
// Форма Rewrite, Article, Anchor и Mood — часть общего контракта API: описаны
// один раз в shared/api.mts, оттуда их берут и сервер (генерация, кэш), и фронт
// (разбор ответа).
import { type Rewrite, type Article, type Anchor, type Mood } from '../../shared/api.mts'
import type { ModelCall, MeaningCheckCall } from './llm.ts'
import type { ModelOutput } from './parse.ts'
import type { RewriteFeedback } from './prompt.ts'
import { getRewrite, insertRewrite } from './db.ts'
import {
  verdictOf,
  betterVerdict,
  accepted,
  anchorsPassed,
  fitForCache,
  type MeaningCheck,
  type Verdict,
} from './verdict.ts'
// Непохожесть — «копия или переписано» одним module (issue #28): мера
// непохожести Rewrite от Snippet и список дословно перенесённых кусков для
// ретрая. Триграмм, нормализации и прямой речи переписывание больше не знает.
import { unchangedSimilarity, survivingFragments } from './similarity.ts'

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

// Доля уцелевших триграмм Snippet в Rewrite. Сравнение идёт по объединению
// заголовка и тела — так же, как Fact Check.
function similarityTo(title: string, body: string, article: Article): number {
  return unchangedSimilarity(
    `${title}\n${body}`,
    `${article.title}\n${article.announce}`,
  )
}

// Одна попытка: переписанный текст плюс его вердикт. По вердикту попытки и
// сравниваются, и решают, ретраить ли, и годятся ли в кэш (module Verdict,
// issue #18/#20). Ретрай просит вернуть потерянное, сохранив регистр, но на деле
// тянет текст обратно к формулировкам источника: третья попытка сплошь и рядом
// набирает все Anchor ценой того, что становится почти копией (замер на живой
// модели: sim 0.19 на первой попытке против 0.93 на третьей). Поэтому отдаём
// лучшую попытку, а не последнюю — betterVerdict хранит порядок важности.
type Attempt = {
  title: string
  body: string
  verdict: Verdict
}

// Лучшая из двух попыток — по вердикту (betterVerdict возвращает один из двух по
// ссылке, попытки различимы по своему вердикту).
function betterAttempt(a: Attempt, b: Attempt): Attempt {
  return betterVerdict(a.verdict, b.verdict) === a.verdict ? a : b
}

// Накопитель обратной связи Brief: то самое «что сверки узнали за прошлую
// попытку», за своим interface, а не разбросанное по let-переменным async-цикла
// (issue #33). Держит RewriteFeedback между попытками; next() отдаёт его
// следующей попытке, record() запоминает вердикт очередной попытки. До первого
// record() обратной связи ещё нет (первая попытка вслепую, docs/adr/0009), и
// null-попытка (невалидный JSON) её не трогает: цикл просто не зовёт record().
export type FeedbackAccumulator = {
  next(): RewriteFeedback | undefined
  record(out: ModelOutput, verdict: Verdict): void
}

export function feedbackAccumulator(article: Article): FeedbackAccumulator {
  let feedback: RewriteFeedback | undefined = undefined
  return {
    next: () => feedback,
    record(out, verdict) {
      // missing, unchanged и surviving берём от этой попытки; distortion
      // обновляем только когда Meaning Check отработал (anchorsPassed) — иначе
      // Anchor-провал затёр бы имя искажения, которое следующий ретрай ещё несёт.
      const carriedDistortion = feedback?.distortion ?? ''
      feedback = {
        missing: verdict.missing,
        unchanged: verdict.unchanged,
        surviving: verdict.unchanged
          ? survivingFragments(
              `${out.title}\n${out.body}`,
              `${article.title}\n${article.announce}`,
            )
          : [],
        distortion: anchorsPassed(verdict) ? verdict.distortion : carriedDistortion,
      }
    },
  }
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
  // Обратная связь между попытками — за своим interface (issue #33): первая
  // попытка идёт без неё (docs/adr/0009), ретрай несёт накопленное состояние
  // сверок как Brief в терминах домена. Цикл его не разбирает по полям.
  const feedback = feedbackAccumulator(article)
  let best: Attempt | null = null
  let attempts = 0

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const out = await callModel({
      mood,
      title: article.title,
      announce: article.announce,
      feedback: feedback.next(),
    })
    attempts++
    if (out === null) continue // невалидный JSON — ещё одна неудачная попытка

    // Сверки → предварительный вердикт (Meaning Check ещё не запускался).
    const similarity = similarityTo(out.title, out.body, article)
    let verdict = verdictOf({
      missing: missingIn(out.title, out.body, anchors),
      similarity,
      meaningCheck: 'skipped',
      distortion: '',
    })

    // Meaning Check — только после пройденной Anchor-сверки (docs/adr/0005): судью
    // не тревожим на тексте, который и так провалил Anchor. Сбой запроса и не-JSON
    // от судьи трактуются одинаково — skipped: сверка не отработала. Не роняем
    // запрос и не выдаём непройденное за пройденное.
    if (anchorsPassed(verdict)) {
      let review
      try {
        review = await meaningCheckModel({
          title: article.title,
          announce: article.announce,
          rewrite: out,
        })
      } catch {
        review = null
      }
      const meaningCheck: MeaningCheck =
        review === null ? 'skipped' : review.consistent ? 'passed' : 'failed'
      const found =
        meaningCheck === 'failed'
          ? review!.distortion.trim() || 'исход события искажён относительно источника'
          : ''
      verdict = verdictOf({ missing: verdict.missing, similarity, meaningCheck, distortion: found })
    }

    const attempt: Attempt = { title: out.title, body: out.body, verdict }
    best = best === null ? attempt : betterAttempt(attempt, best)
    if (accepted(verdict)) break // вердикт годен — ретрай не нужен

    // Не принято — накопитель запоминает причину неудачи для прицельного ретрая.
    feedback.record(out, verdict)
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
    missing: best.verdict.missing,
    attempts,
    stub: false, // модель вызывалась — это настоящий Rewrite
    unchanged: best.verdict.unchanged,
    meaningCheck: best.verdict.meaningCheck,
    distortion: best.verdict.distortion,
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

// Вердикт готового Rewrite — мост от записи к module Verdict. Rewrite несёт все
// поля вердикта, кроме similarity: она сыграла свою роль в выборе лучшей попытки
// (тай-брейк) и в решение о кэше не входит — fitForCache её не читает.
function verdictOfRewrite(rewrite: Rewrite): Verdict {
  return {
    missing: rewrite.missing,
    unchanged: rewrite.unchanged,
    similarity: 0,
    meaningCheck: rewrite.meaningCheck,
    distortion: rewrite.distortion,
  }
}

// Ленивый кэш (docs/adr/0001): при попадании читаем из базы, при промахе
// генерируем. В кэш пишется только годное по вердикту (fitForCache, docs/adr/0008):
// провалившийся Rewrite отдаётся читателю (лучшая попытка, а не 500), но не
// кэшируется — следующее открытие пары «Article + Mood» генерит заново, а не
// показывает тот же провал навсегда. Заглушка тоже мимо кэша не особым флагом, а
// своим вердиктом: meaningCheck:'skipped' у неё не проходит fitForCache — с
// появлением ключа генерация происходит по-настоящему.
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

  if (fitForCache(verdictOfRewrite(rewrite))) insertRewrite(db, article.link, mood, rewrite)
  return rewrite
}
