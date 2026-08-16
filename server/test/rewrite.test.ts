import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, getRewrite, insertArticles } from '../src/db.ts'
import {
  generateRewrite,
  stubRewrite,
  resolveRewrite,
  rewriteSchema,
  feedbackAccumulator,
} from '../src/rewrite.ts'
import type {
  ModelCall,
  ModelOutput,
  MeaningCheckCall,
  MeaningCheckOutput,
} from '../src/llm.ts'
import type { RewriteBrief } from '../src/prompt.ts'
import { verdictOf } from '../src/verdict.ts'
import type { Article } from '../src/rss.ts'

const article: Article = {
  link: 'https://src.test/1',
  source: 'Тест',
  title: 'Собянин выделил 1200 млрд рублей',
  announce: 'Мэр Москвы сообщил о росте на 15% в 2026 году.',
  publishedAt: '2026-08-16T09:00:00.000Z',
}

// Anchor этого Snippet: 1200, 15%, 2026, Москв… (Собянин и Мэр — в начале
// предложения, в Anchor не берутся; см. isSentenceStart).

// Полноценное переписывание: все Anchor на месте, тон сменён, формулировки и
// порядок слов — тоже, поэтому доля уцелевших триграмм ниже порога и unchanged
// == false (issue #13). Общий «годный Rewrite» для тестов, которым важна не
// конкретная фраза, а сам факт прохождения сверок.
const goodRewrite: ModelOutput = {
  title: 'Хорошие вести для Москвы',
  body: 'Собянин объявил рост на 15% по итогам 2026 года — на город направили 1200 млрд рублей.',
}

// Модель, отдающая заранее заданную последовательность выводов (или null).
function scriptedModel(outputs: Array<ModelOutput | null>): {
  call: ModelCall
  calls: () => number
} {
  let i = 0
  return {
    call: async () => outputs[i++] ?? null,
    calls: () => i,
  }
}

// Судья Meaning Check, всегда подтверждающий исход — для тестов, которым важна
// только Anchor-сверка (issue #10).
const okReview: MeaningCheckCall = async () => ({ consistent: true, distortion: '' })

// Судья, отдающий заранее заданную последовательность вердиктов (или null).
function scriptedReview(outputs: Array<MeaningCheckOutput | null>): {
  call: MeaningCheckCall
  calls: () => number
} {
  let i = 0
  return {
    call: async () => outputs[i++] ?? null,
    calls: () => i,
  }
}

// --- Накопитель обратной связи Brief (issue #33) ---

// Накопитель — тот самый interface, за которым живёт «что сверки узнали за
// прошлую попытку»: держит обратную связь между попытками, а async-цикл его не
// разбирает по полям. next() до первого record() — обратной связи ещё нет
// (первая попытка вслепую, docs/adr/0009); record() запоминает вердикт попытки.

test('накопитель Brief: до первого record обратной связи нет', () => {
  const acc = feedbackAccumulator(article)
  assert.equal(acc.next(), undefined)
})

test('накопитель Brief: record запоминает потерянный Anchor для следующей попытки', () => {
  const acc = feedbackAccumulator(article)
  const lost = { kind: 'number', text: '15%' } as const
  const out: ModelOutput = { title: 'Собянин выделил 1200 млрд', body: 'Мэр Москвы сообщил о росте в 2026 году.' }
  acc.record(out, verdictOf({ missing: [lost], similarity: 0, meaningCheck: 'skipped', distortion: '' }))

  const fb = acc.next()!
  assert.deepEqual(fb.missing.map((a) => a.text), ['15%'])
  assert.equal(fb.unchanged, false)
  assert.equal(fb.distortion, '')
})

test('накопитель Brief: distortion переживает следующий Anchor-провал', () => {
  // Meaning Check назвал искажение на попытке с целыми Anchor. Следующая попытка
  // роняет Anchor (Meaning Check по ней не гоняется) — имя искажения обязано
  // уцелеть, чтобы ретрай его ещё нёс, а не быть затёртым Anchor-провалом.
  const acc = feedbackAccumulator(article)
  const distortedOut: ModelOutput = { title: 'т', body: 'т' }
  acc.record(
    distortedOut,
    verdictOf({ missing: [], similarity: 0, meaningCheck: 'failed', distortion: 'рост подменён падением' }),
  )
  assert.equal(acc.next()!.distortion, 'рост подменён падением')

  const lost = { kind: 'number', text: '15%' } as const
  acc.record(
    { title: 'т', body: 'т' },
    verdictOf({ missing: [lost], similarity: 0, meaningCheck: 'skipped', distortion: '' }),
  )
  const fb = acc.next()!
  assert.deepEqual(fb.missing.map((a) => a.text), ['15%'])
  assert.equal(fb.distortion, 'рост подменён падением') // не затёрто Anchor-провалом
})

// --- Цикл генерации и Fact Check ---

test('генерация проходит с первой попытки, когда все Anchor на месте', async () => {
  const model = scriptedModel([goodRewrite])
  const rewrite = await generateRewrite(article, 'joyful', model.call, okReview)

  assert.equal(rewrite.attempts, 1)
  assert.deepEqual(rewrite.missing, [])
  assert.equal(rewrite.stub, false)
  assert.equal(rewrite.anchorCount, rewrite.anchors.length)
  assert.doesNotThrow(() => rewriteSchema.parse(rewrite))
})

test('при потерянном Anchor следует ретрай, названный в запросе', async () => {
  // Первая попытка теряет «15%», вторая — возвращает всё.
  const lost: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте в 2026 году.',
  }
  const fixed = goodRewrite
  const model = scriptedModel([lost, fixed])
  const rewrite = await generateRewrite(article, 'sad', model.call, okReview)

  assert.equal(rewrite.attempts, 2)
  assert.deepEqual(rewrite.missing, [])
})

test('первой попытке обратной связи нет, ретрай называет потерянный Anchor (issue #14, docs/adr/0009)', async () => {
  // Первая попытка теряет «15%», вторая возвращает всё. Проверяем захваченный
  // Brief: обратная связь (в т.ч. перечень потерянных Anchor) на первой попытке
  // отсутствует и появляется только в ретрае — свойство interface, а не
  // договорённость внутри текста промпта.
  const seen: RewriteBrief[] = []
  const outputs: Array<ModelOutput | null> = [
    { title: 'Собянин выделил 1200 млрд', body: 'Мэр Москвы сообщил о росте в 2026 году.' },
    goodRewrite,
  ]
  let i = 0
  const recording: ModelCall = async (brief) => {
    seen.push(brief)
    return outputs[i++] ?? null
  }
  const rewrite = await generateRewrite(article, 'sad', recording, okReview)

  assert.equal(rewrite.attempts, 2)
  assert.deepEqual(rewrite.missing, [])
  assert.equal(seen[0]!.feedback, undefined) // первая попытка идёт вслепую
  // Ретрай называет именно потерянное «15%» — данными Brief, а не подстрокой прозы.
  assert.deepEqual(
    seen[1]!.feedback!.missing.map((a) => a.text),
    ['15%'],
  )
})

test('после всех попыток потеря остаётся — ответ успешный с непустым missing', async () => {
  // Модель упорно теряет «15%».
  const lost: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте в 2026 году.',
  }
  const model = scriptedModel([lost, lost, lost])
  const rewrite = await generateRewrite(article, 'ironic', model.call, okReview)

  assert.equal(rewrite.attempts, 3)
  assert.ok(rewrite.missing.length > 0)
  assert.deepEqual(
    rewrite.missing.map((a) => a.text),
    ['15%'],
  )
})

// --- Rewrite обязан отличаться от Snippet (issue #8) ---

test('дословное совпадение со Snippet — неудачная попытка, а не приёмка', async () => {
  // Модель упорно возвращает исходный текст слово в слово.
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const model = scriptedModel([echo, echo, echo])
  const rewrite = await generateRewrite(article, 'joyful', model.call, okReview)

  assert.equal(rewrite.attempts, 3) // совпадение ушло в тот же цикл ретраев
  assert.equal(rewrite.unchanged, true) // после всех попыток текст не изменился
  assert.deepEqual(rewrite.missing, []) // Anchor все на месте — потеряно другое
})

test('различие лишь в пробелах, регистре и пунктуации за переписывание не считается', async () => {
  // «Тот же текст», отличается только оформлением — это по-прежнему Snippet.
  const cosmetic: ModelOutput = {
    title: 'СОБЯНИН   выделил 1200 млрд рублей!!!',
    body: 'мэр москвы сообщил о росте на 15% в 2026 году',
  }
  const model = scriptedModel([cosmetic, cosmetic, cosmetic])
  const rewrite = await generateRewrite(article, 'joyful', model.call, okReview)

  assert.equal(rewrite.unchanged, true)
  assert.equal(rewrite.attempts, 3)
})

test('переписанный текст, отличающийся от Snippet, проходит с первой попытки', async () => {
  const rewritten: ModelOutput = {
    title: 'Ура! Собянин выделил целых 1200 млрд',
    body: 'Какая радость: Мэр Москвы объявил рост на 15% в 2026 году — прекрасно!',
  }
  const model = scriptedModel([rewritten])
  const rewrite = await generateRewrite(article, 'joyful', model.call, okReview)

  assert.equal(rewrite.attempts, 1)
  assert.equal(rewrite.unchanged, false)
  assert.deepEqual(rewrite.missing, [])
})

test('совпадение со Snippet исправляется ретраем', async () => {
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const changed: ModelOutput = {
    title: 'Грустные итоги для Москвы',
    body: 'Как ни печально, Собянин признал прибавку лишь на 15% за 2026 год — всего 1200 млрд рублей.',
  }
  const model = scriptedModel([echo, changed])
  const rewrite = await generateRewrite(article, 'sad', model.call, okReview)

  assert.equal(rewrite.attempts, 2)
  assert.equal(rewrite.unchanged, false)
})

test('Mood neutral тоже обязан отличаться от Snippet — совпадение уходит в ретрай', async () => {
  // После docs/adr/0006 Snippet — полный текст статьи, и нейтральный Rewrite
  // обязан быть его сжатием, а не побуквенной копией (issue #12).
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const changed: ModelOutput = {
    title: 'Бюджет Москвы: итоги',
    body: 'По данным Собянина, за 2026 год показатель прибавил 15%; на это ушло 1200 млрд рублей.',
  }
  const model = scriptedModel([echo, changed])
  const rewrite = await generateRewrite(article, 'neutral', model.call, okReview)

  assert.equal(rewrite.attempts, 2) // совпадение больше не приёмка и для neutral
  assert.equal(rewrite.unchanged, false)
})

test('neutral, упорно совпадающий со Snippet, после всех попыток помечается unchanged', async () => {
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const model = scriptedModel([echo, echo, echo])
  const rewrite = await generateRewrite(article, 'neutral', model.call, okReview)

  assert.equal(rewrite.attempts, 3)
  assert.equal(rewrite.unchanged, true)
})

// --- Отдаётся лучшая попытка, а не последняя ---

test('копия со всеми Anchor не вытесняет переписывание, потерявшее один Anchor', async () => {
  // Первая попытка — настоящее переписывание, но «15%» потеряно. Ретрай
  // возвращает Anchor ценой того, что текст становится копией Snippet: так
  // ведёт себя живая модель, и последняя попытка тут хуже первой.
  const lost: ModelOutput = {
    title: 'Хорошие вести для Москвы',
    body: 'Собянин объявил: на город направили 1200 млрд рублей по итогам 2026 года.',
  }
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const model = scriptedModel([lost, echo, echo])
  const rewrite = await generateRewrite(article, 'joyful', model.call, okReview)

  assert.equal(rewrite.attempts, 3)
  assert.equal(rewrite.title, lost.title)
  assert.equal(rewrite.unchanged, false)
  assert.deepEqual(
    rewrite.missing.map((a) => a.text),
    ['15%'],
  )
})

test('чистая попытка не вытесняется последующей, если та хуже', async () => {
  // Вторая попытка не понадобится: чистый результат прерывает цикл. Проверяем,
  // что именно он и возвращается.
  const model = scriptedModel([goodRewrite])
  const rewrite = await generateRewrite(article, 'sad', model.call, okReview)

  assert.equal(rewrite.attempts, 1)
  assert.equal(rewrite.title, goodRewrite.title)
  assert.equal(rewrite.meaningCheck, 'passed')
})

test('невалидный JSON — ещё одна неудачная попытка, а не сбой', async () => {
  // Первый ответ не-JSON (null), второй валиден.
  const model = scriptedModel([null, goodRewrite])
  const rewrite = await generateRewrite(article, 'neutral', model.call, okReview)

  assert.equal(rewrite.attempts, 2)
  assert.deepEqual(rewrite.missing, [])
})

test('если модель ни разу не вернула валидный JSON — внятная ошибка', async () => {
  const model = scriptedModel([null, null, null])
  await assert.rejects(() => generateRewrite(article, 'neutral', model.call, okReview), /валидный JSON/)
})

test('ретрай при совпадении несёт уцелевшие куски в Brief', async () => {
  // Первая попытка — копия Snippet, значит второй Brief обязан назвать
  // дословно уцелевшие куски и пометить unchanged.
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const model = scriptedModel([echo, goodRewrite])
  const seen: RewriteBrief[] = []
  const spy: ModelCall = async (brief) => {
    seen.push(brief)
    return model.call(brief)
  }
  await generateRewrite(article, 'ironic', spy, okReview)

  assert.equal(seen[1]!.feedback!.unchanged, true)
  assert.ok(
    seen[1]!.feedback!.surviving.some((s) => s.includes('мэр москвы сообщил о росте')),
  )
})

test('Rewrite выше порога непохожести уходит в ретрай и не кэшируется', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  // Переставленные слова при сохранённых формулировках — выше порога, значит
  // unchanged: тот же путь, что и у точного совпадения.
  const nearCopy: ModelOutput = {
    title: article.title,
    body: 'Мэр Москвы сообщил о росте в 2026 году на 15%.',
  }
  const model = scriptedModel([nearCopy, nearCopy, nearCopy])
  const first = await resolveRewrite(db, article, 'joyful', {
    callModel: model.call,
    meaningCheckModel: okReview,
    useStub: false,
  })

  assert.equal(first.unchanged, true)
  assert.equal(getRewrite(db, article.link, 'joyful'), undefined)
})

// --- Смысловая сверка вторым проходом (issue #10) ---

// Искажённый Rewrite: все Anchor (1200, 15%, 2026, Москв…) на месте и текст
// переписан (unchanged проходит), но исход перевёрнут — «рост» стал «падением».
// Anchor-сверка и мера непохожести его пропускают, ловит второй проход.
const distorted: ModelOutput = {
  title: 'Москва в минусе',
  body: 'Собянин признал падение на 15% по итогам 2026 года: из 1200 млрд рублей толку не вышло.',
}

test('искажение смысла при целых Anchor не принимается с первой попытки', async () => {
  const corrected: ModelOutput = {
    title: 'Грустные итоги для Москвы',
    body: 'Собянин с печалью подвёл 2026 год: показатель прибавил всего 15%, освоено 1200 млрд рублей.',
  }
  const model = scriptedModel([distorted, corrected])
  const review = scriptedReview([
    { consistent: false, distortion: 'рост подменён падением' },
    { consistent: true, distortion: '' },
  ])
  const rewrite = await generateRewrite(article, 'sad', model.call, review.call)

  assert.equal(rewrite.attempts, 2) // с первой попытки не принят
  assert.equal(rewrite.meaningCheck, 'passed') // ретрай исправил смысл
  assert.equal(rewrite.distortion, '')
  assert.deepEqual(rewrite.missing, []) // Anchor были целы всё время
})

test('искажение из Meaning Check названо в Brief следующей попытки', async () => {
  const seen: RewriteBrief[] = []
  const model: ModelCall = async (brief) => {
    seen.push(brief)
    return distorted
  }
  const review = scriptedReview([
    { consistent: false, distortion: 'исход события изменён' },
    { consistent: true, distortion: '' },
  ])
  await generateRewrite(article, 'joyful', model, review.call)

  assert.equal(seen.length, 2)
  assert.equal(seen[0]!.feedback, undefined) // первая попытка — вслепую
  assert.equal(seen[1]!.feedback!.distortion, 'исход события изменён') // назван как данные Brief
})

test('неустранённое искажение остаётся в ответе после всех попыток', async () => {
  const model = scriptedModel([distorted, distorted, distorted])
  const review = scriptedReview([
    { consistent: false, distortion: 'рост подменён падением' },
    { consistent: false, distortion: 'рост подменён падением' },
    { consistent: false, distortion: 'рост подменён падением' },
  ])
  const rewrite = await generateRewrite(article, 'joyful', model.call, review.call)

  assert.equal(rewrite.attempts, 3)
  assert.equal(rewrite.meaningCheck, 'failed')
  assert.equal(rewrite.distortion, 'рост подменён падением')
  assert.deepEqual(rewrite.missing, []) // Anchor целы — искажён исход, а не факт
})

test('сбой второго прохода не роняет запрос — сверка честно помечена skipped', async () => {
  const good = goodRewrite
  const model = scriptedModel([good])
  const failing: MeaningCheckCall = async () => {
    throw new Error('смысловая сверка недоступна: сеть')
  }
  const rewrite = await generateRewrite(article, 'joyful', model.call, failing)

  assert.equal(rewrite.meaningCheck, 'skipped') // не выдана за пройденную
  assert.equal(rewrite.attempts, 1) // Anchor-валидный Rewrite всё равно отдан
  assert.deepEqual(rewrite.missing, [])
})

test('судья Meaning Check вернул не-JSON — сверка честно skipped', async () => {
  const good = goodRewrite
  const model = scriptedModel([good])
  const review = scriptedReview([null])
  const rewrite = await generateRewrite(article, 'joyful', model.call, review.call)

  assert.equal(rewrite.meaningCheck, 'skipped')
})

test('смена одного лишь тона при сохранённом исходе Meaning Check проходит', async () => {
  const toned: ModelOutput = {
    title: 'Ура! Собянин выделил целых 1200 млрд',
    body: 'Прекрасная новость: Мэр Москвы объявил рост на 15% в 2026 году!',
  }
  const model = scriptedModel([toned])
  const review = scriptedReview([{ consistent: true, distortion: '' }])
  const rewrite = await generateRewrite(article, 'joyful', model.call, review.call)

  assert.equal(rewrite.attempts, 1) // тон сменился, исход цел — ретрая нет
  assert.equal(rewrite.meaningCheck, 'passed')
})

test('второй проход платится один раз на пару Article + Mood', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const good = goodRewrite
  const model = scriptedModel([good])
  const review = scriptedReview([{ consistent: true, distortion: '' }])

  const deps = { callModel: model.call, meaningCheckModel: review.call, useStub: false }
  await resolveRewrite(db, article, 'joyful', deps)
  await resolveRewrite(db, article, 'joyful', deps)

  assert.equal(model.calls(), 1)
  assert.equal(review.calls(), 1) // повторный запрос сверку не гонял
})

// --- ADR-0008: в кэш пишется только прошедшее обе сверки ---

test('meaningCheck и distortion прошедшего сверку Rewrite переживают кэш', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const good = goodRewrite
  const model = scriptedModel([good])
  const review = scriptedReview([{ consistent: true, distortion: '' }])
  await resolveRewrite(db, article, 'joyful', {
    callModel: model.call,
    meaningCheckModel: review.call,
    useStub: false,
  })

  const cached = getRewrite(db, article.link, 'joyful')
  assert.ok(cached)
  assert.equal(cached.meaningCheck, 'passed')
  assert.equal(cached.distortion, '')
})

test('провал Meaning Check в кэш не пишется — повторное открытие генерит заново', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const model = scriptedModel(Array(6).fill(distorted))
  const failed = { consistent: false, distortion: 'рост подменён падением' } as const
  const review = scriptedReview(Array(6).fill(failed))
  const deps = { callModel: model.call, meaningCheckModel: review.call, useStub: false }
  const first = await resolveRewrite(db, article, 'joyful', deps)

  assert.equal(first.meaningCheck, 'failed') // читателю всё же отдана лучшая попытка
  // В кэше пусто: одна неудачная попытка не становится вечной (docs/adr/0008).
  assert.equal(getRewrite(db, article.link, 'joyful'), undefined)

  // Повторное открытие снова идёт к модели, а не показывает тот же провал.
  await resolveRewrite(db, article, 'joyful', deps)
  assert.equal(model.calls(), 6) // 3 попытки + ещё 3 при повторном открытии
})

test('провал Fact Check (Missing Anchor) в кэш не пишется', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const lost: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте в 2026 году.', // потерян «15%»
  }
  const model = scriptedModel([lost, lost, lost])
  const first = await resolveRewrite(db, article, 'joyful', {
    callModel: model.call,
    meaningCheckModel: okReview,
    useStub: false,
  })

  assert.ok(first.missing.length > 0)
  assert.equal(getRewrite(db, article.link, 'joyful'), undefined)
})

test('unchanged Rewrite в кэш не пишется', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const model = scriptedModel([echo, echo, echo])
  const first = await resolveRewrite(db, article, 'neutral', {
    callModel: model.call,
    meaningCheckModel: okReview,
    useStub: false,
  })

  assert.equal(first.unchanged, true)
  assert.equal(getRewrite(db, article.link, 'neutral'), undefined)
})

test('skipped Meaning Check в кэш не пишется наравне с failed', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const good = goodRewrite
  const model = scriptedModel([good])
  const failing: MeaningCheckCall = async () => {
    throw new Error('смысловая сверка недоступна')
  }
  const first = await resolveRewrite(db, article, 'joyful', {
    callModel: model.call,
    meaningCheckModel: failing,
    useStub: false,
  })

  assert.equal(first.meaningCheck, 'skipped')
  assert.equal(getRewrite(db, article.link, 'joyful'), undefined)
})

// --- Заглушка без ключа ---

test('заглушка проходит Fact Check, помечена stub и не звала модель', () => {
  const rewrite = stubRewrite(article, 'dramatic')
  assert.equal(rewrite.stub, true)
  assert.equal(rewrite.attempts, 0)
  assert.deepEqual(rewrite.missing, [])
  assert.equal(rewrite.title, article.title)
  assert.equal(rewrite.body, article.announce)
  assert.equal(rewrite.meaningCheck, 'skipped') // модель не звалась — сверки не было
  assert.equal(rewrite.distortion, '')
})

// --- Ленивый кэш ---

test('промах кэша генерирует, попадание читает из базы без модели', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const good = goodRewrite
  const model = scriptedModel([good])

  const first = await resolveRewrite(db, article, 'joyful', {
    callModel: model.call,
    meaningCheckModel: okReview,
    useStub: false,
  })
  const second = await resolveRewrite(db, article, 'joyful', {
    callModel: model.call,
    meaningCheckModel: okReview,
    useStub: false,
  })

  assert.equal(model.calls(), 1) // второй запрос модель не трогал
  assert.deepEqual(second, first)
})

test('заглушка не попадает в кэш под видом настоящего Rewrite', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])

  const rewrite = await resolveRewrite(db, article, 'sad', {
    callModel: async () => null,
    meaningCheckModel: okReview,
    useStub: true,
  })
  assert.equal(rewrite.stub, true)
  // В кэше пусто — с появлением ключа генерация произойдёт по-настоящему.
  assert.equal(getRewrite(db, article.link, 'sad'), undefined)
})

test('сгенерированный Rewrite переживает перезапуск (файловая база)', async () => {
  const path = `test/tmp-rewrite-${process.pid}.db`
  const good = goodRewrite
  try {
    const db = openDb(path)
    insertArticles(db, [article])
    await resolveRewrite(db, article, 'joyful', {
      callModel: scriptedModel([good]).call,
      meaningCheckModel: okReview,
      useStub: false,
    })
    db.close()

    // «Перезапуск»: заново открываем ту же базу.
    const reopened = openDb(path)
    const cached = getRewrite(reopened, article.link, 'joyful')
    reopened.close()
    assert.ok(cached)
    assert.equal(cached.title, good.title)
  } finally {
    const { rmSync } = await import('node:fs')
    rmSync(path, { force: true })
  }
})

// --- Валидация записи кэша на чтении ---

test('устаревшая запись кэша (не проходит схему Rewrite) читается как промах', () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  // Прямая запись строки, валидной как JSON, но не проходящей rewriteSchema:
  // так выглядела бы запись, оставшаяся от прежней формы Rewrite. На чтении она
  // должна обнаружиться и не доехать до экрана — getRewrite отдаёт промах.
  db.prepare('INSERT INTO rewrites (link, mood, data) VALUES (?, ?, ?)').run(
    article.link,
    'joyful',
    JSON.stringify({ mood: 'joyful', title: 'заголовок' }), // не хватает полей
  )
  assert.equal(getRewrite(db, article.link, 'joyful'), undefined)
})

test('битый JSON в кэше читается как промах, а не роняет чтение', () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  db.prepare('INSERT INTO rewrites (link, mood, data) VALUES (?, ?, ?)').run(
    article.link,
    'sad',
    '{ это не json',
  )
  assert.equal(getRewrite(db, article.link, 'sad'), undefined)
})
