import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, getRewrite, insertArticles } from '../src/db.ts'
import {
  generateRewrite,
  stubRewrite,
  resolveRewrite,
  rewriteSchema,
} from '../src/rewrite.ts'
import {
  buildMessages,
  buildMeaningCheckMessages,
  buildRequestBody,
  maxTokensFor,
  parseModelContent,
  parseMeaningCheckContent,
} from '../src/llm.ts'
import type {
  ModelCall,
  ModelOutput,
  MeaningCheckCall,
  MeaningCheckOutput,
} from '../src/llm.ts'
import type { Article } from '../src/rss.ts'

const article: Article = {
  link: 'https://src.test/1',
  source: 'Тест',
  title: 'Собянин выделил 1200 млрд рублей',
  announce: 'Мэр Москвы сообщил о росте на 15% в 2026 году.',
  publishedAt: '2026-08-16T09:00:00.000Z',
}

// Anchor этого Snippet: 1200, 15%, 2026, Собян…, Москв…

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

// --- Цикл генерации и Fact Check ---

test('генерация проходит с первой попытки, когда все Anchor на месте', async () => {
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте на 15% в 2026 году — прекрасно!',
  }
  const model = scriptedModel([good])
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
  const fixed: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте на 15% в 2026 году.',
  }
  const model = scriptedModel([lost, fixed])
  const rewrite = await generateRewrite(article, 'sad', model.call, okReview)

  assert.equal(rewrite.attempts, 2)
  assert.deepEqual(rewrite.missing, [])
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
    title: 'Собянин выделил 1200 млрд',
    body: 'Как грустно: Мэр Москвы сообщил о росте всего на 15% в 2026 году.',
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
    title: 'Собянин выделил 1200 млрд рублей',
    body: 'Мэр Москвы отчитался о росте на 15% за 2026 год.',
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

test('ретрай при совпадении сообщает модели, что она ничего не изменила', () => {
  const messages = buildMessages({
    mood: 'joyful',
    title: article.title,
    announce: article.announce,
    anchors: [],
    missing: [],
    unchanged: true,
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /не изменил|без изменений/)
})

test('невалидный JSON — ещё одна неудачная попытка, а не сбой', async () => {
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте на 15% в 2026 году.',
  }
  // Первый ответ не-JSON (null), второй валиден.
  const model = scriptedModel([null, good])
  const rewrite = await generateRewrite(article, 'neutral', model.call, okReview)

  assert.equal(rewrite.attempts, 2)
  assert.deepEqual(rewrite.missing, [])
})

test('если модель ни разу не вернула валидный JSON — внятная ошибка', async () => {
  const model = scriptedModel([null, null, null])
  await assert.rejects(() => generateRewrite(article, 'neutral', model.call, okReview), /валидный JSON/)
})

// --- Смысловая сверка вторым проходом (issue #10) ---

// Искажённый Rewrite: все Anchor (1200, 15%, 2026, Собян…, Москв…) на месте, но
// «рост» подменён «падением» — Anchor-сверка его пропускает, ловит второй проход.
const distorted: ModelOutput = {
  title: 'Собянин выделил 1200 млрд',
  body: 'Мэр Москвы сообщил о падении на 15% в 2026 году.',
}

test('искажение смысла при целых Anchor не принимается с первой попытки', async () => {
  const corrected: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы с грустью сообщил о росте на 15% в 2026 году.',
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

test('искажение из Meaning Check названо в промпте следующей попытки', async () => {
  const seen: string[] = []
  const model: ModelCall = async (messages) => {
    seen.push(messages.find((m) => m.role === 'user')!.content)
    return distorted
  }
  const review = scriptedReview([
    { consistent: false, distortion: 'исход события изменён' },
    { consistent: true, distortion: '' },
  ])
  await generateRewrite(article, 'joyful', model, review.call)

  assert.equal(seen.length, 2)
  assert.doesNotMatch(seen[0]!, /исход события изменён/) // первая попытка — вслепую
  assert.match(seen[1]!, /исход события изменён/) // ретрай назван, а не слепой
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
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы радостно сообщил о росте на 15% в 2026 году!',
  }
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
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы радостно сообщил о росте на 15% в 2026 году!',
  }
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

test('промпт Meaning Check велит судье проверять исход, а не тон', () => {
  const messages = buildMeaningCheckMessages({
    title: article.title,
    announce: article.announce,
    rewrite: { title: 'Ура!', body: 'Рост на 15%' },
  })
  const all = messages.map((m) => m.content).join('\n')
  assert.match(all, /тон/i) // судью явно просят не придираться к тону
  assert.match(all, /15%/) // переписанный текст вложен
  assert.match(all, /Собянин/) // оригинал вложен для сверки
})

test('промпт Meaning Check: словоформы не считаются подменой, при сомнении consistent', () => {
  const messages = buildMeaningCheckMessages({
    title: article.title,
    announce: article.announce,
    rewrite: { title: 'Ура!', body: 'Рост на 15%' },
  })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /словоформ/i) // разные словоформы — не подмена субъекта
  assert.match(system, /сомнева|consistent:true/i) // при сомнении — не тревога
  assert.match(system, /Outcome|исход/i) // критерий назван через Outcome
})

test('второй проход платится один раз на пару Article + Mood', async () => {
  const db = openDb(':memory:')
  insertArticles(db, [article])
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы радостно сообщил о росте на 15% в 2026 году!',
  }
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
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы радостно сообщил о росте на 15% в 2026 году!',
  }
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
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы радостно сообщил о росте на 15% в 2026 году!',
  }
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
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте на 15% в 2026 году.',
  }
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
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте на 15% в 2026 году.',
  }
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

// --- Промпт и тело запроса (детали, на которых легко потерять время) ---

test('промпт кладёт список Anchor и правило «цифрами, а не прописью»', () => {
  const messages = buildMessages({
    mood: 'ironic',
    title: article.title,
    announce: article.announce,
    anchors: [{ kind: 'number', text: '15%' }],
    missing: [],
  })
  const all = messages.map((m) => m.content).join('\n')
  assert.match(all, /15%/)
  assert.match(all, /цифрами/)
  assert.match(all, /ирони/i) // текст регистра ironic вложен
})

test('промпт защищает исход события (Outcome) и запрещает глумиться над пострадавшими', () => {
  const messages = buildMessages({
    mood: 'joyful',
    title: article.title,
    announce: article.announce,
    anchors: [],
    missing: [],
  })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /исход события|Outcome/) // Outcome неизменяем (docs/adr/0007)
  assert.match(system, /упало значит упало|погиб значит погиб/) // явное правило направления
  assert.match(system, /не глумись|пострадавш/i) // общий пол на все Mood
})

test('промпт называет искажение (Distortion) в ретрае', () => {
  const messages = buildMessages({
    mood: 'joyful',
    title: article.title,
    announce: article.announce,
    anchors: [],
    missing: [],
    distortion: 'рост подменён падением',
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /рост подменён падением/) // названо, а не слепой ретрай
  assert.match(user, /исход события/) // говорит про Outcome словом глоссария
})

test('промпт называет потерянное при ретрае', () => {
  const messages = buildMessages({
    mood: 'sad',
    title: article.title,
    announce: article.announce,
    anchors: [{ kind: 'number', text: '15%' }],
    missing: [{ kind: 'number', text: '15%' }],
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /потеряны/)
})

test('тело запроса отключает reasoning и требует json_object', () => {
  const body = buildRequestBody([{ role: 'user', content: 'x' }], 'glm-4.7-flash')
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.equal(body.model, 'glm-4.7-flash')
})

// --- max_tokens считается от длины входа (issue #12) ---

test('max_tokens: короткий вход даёт нижнюю границу', () => {
  const short = maxTokensFor([{ role: 'user', content: 'Короткая новость' }])
  assert.equal(short, 400) // ниже 400 не опускается — прежний минимум
})

test('max_tokens: длинный вход даёт больше нижней границы', () => {
  const long = maxTokensFor([{ role: 'user', content: 'а'.repeat(4000) }])
  assert.ok(long > 400) // объём входа поднял лимит
})

test('max_tokens: очень длинный вход упирается в потолок', () => {
  const huge = maxTokensFor([{ role: 'user', content: 'а'.repeat(100_000) }])
  assert.equal(huge, 2000) // потолок против пробоя бюджета
})

test('parseModelContent: валидный JSON → объект, мусор → null', () => {
  assert.deepEqual(parseModelContent('{"title":"a","body":"b"}'), {
    title: 'a',
    body: 'b',
  })
  assert.equal(parseModelContent('не json'), null)
  assert.equal(parseModelContent('{"title":"a"}'), null) // нет body
})

test('parseModelContent снимает markdown с title и body', () => {
  const out = parseModelContent(
    '{"title":"# **Россия** победила","body":"Курс _вырос_ на `15%`"}',
  )
  assert.deepEqual(out, { title: 'Россия победила', body: 'Курс вырос на 15%' })
})

test('parseModelContent не портит текст без markdown', () => {
  assert.deepEqual(parseModelContent('{"title":"Обычный текст","body":"Без разметки: 15%"}'), {
    title: 'Обычный текст',
    body: 'Без разметки: 15%',
  })
})

test('parseMeaningCheckContent: валидный вердикт → объект, мусор → null', () => {
  assert.deepEqual(parseMeaningCheckContent('{"consistent":true,"distortion":""}'), {
    consistent: true,
    distortion: '',
  })
  assert.equal(parseMeaningCheckContent('не json'), null)
  assert.equal(parseMeaningCheckContent('{"consistent":false}'), null) // нет distortion
})
