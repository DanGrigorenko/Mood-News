import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, getRewrite, insertArticles } from '../src/db.ts'
import {
  generateRewrite,
  stubRewrite,
  resolveRewrite,
  rewriteSchema,
} from '../src/rewrite.ts'
import { buildMessages, buildRequestBody, parseModelContent } from '../src/llm.ts'
import type { ModelCall, ModelOutput } from '../src/llm.ts'
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

// --- Цикл генерации и Fact Check ---

test('генерация проходит с первой попытки, когда все Anchor на месте', async () => {
  const good: ModelOutput = {
    title: 'Собянин выделил 1200 млрд',
    body: 'Мэр Москвы сообщил о росте на 15% в 2026 году — прекрасно!',
  }
  const model = scriptedModel([good])
  const rewrite = await generateRewrite(article, 'joyful', model.call)

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
  const rewrite = await generateRewrite(article, 'sad', model.call)

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
  const rewrite = await generateRewrite(article, 'ironic', model.call)

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
  const rewrite = await generateRewrite(article, 'joyful', model.call)

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
  const rewrite = await generateRewrite(article, 'joyful', model.call)

  assert.equal(rewrite.unchanged, true)
  assert.equal(rewrite.attempts, 3)
})

test('переписанный текст, отличающийся от Snippet, проходит с первой попытки', async () => {
  const rewritten: ModelOutput = {
    title: 'Ура! Собянин выделил целых 1200 млрд',
    body: 'Какая радость: Мэр Москвы объявил рост на 15% в 2026 году — прекрасно!',
  }
  const model = scriptedModel([rewritten])
  const rewrite = await generateRewrite(article, 'joyful', model.call)

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
  const rewrite = await generateRewrite(article, 'sad', model.call)

  assert.equal(rewrite.attempts, 2)
  assert.equal(rewrite.unchanged, false)
})

test('для Mood neutral совпадение со Snippet допустимо и ретрая не вызывает', async () => {
  const echo: ModelOutput = { title: article.title, body: article.announce }
  const model = scriptedModel([echo])
  const rewrite = await generateRewrite(article, 'neutral', model.call)

  assert.equal(rewrite.attempts, 1) // нейтральный пересказ вправе совпасть
  assert.equal(rewrite.unchanged, false)
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
  const rewrite = await generateRewrite(article, 'neutral', model.call)

  assert.equal(rewrite.attempts, 2)
  assert.deepEqual(rewrite.missing, [])
})

test('если модель ни разу не вернула валидный JSON — внятная ошибка', async () => {
  const model = scriptedModel([null, null, null])
  await assert.rejects(() => generateRewrite(article, 'neutral', model.call), /валидный JSON/)
})

// --- Заглушка без ключа ---

test('заглушка проходит Fact Check, помечена stub и не звала модель', () => {
  const rewrite = stubRewrite(article, 'dramatic')
  assert.equal(rewrite.stub, true)
  assert.equal(rewrite.attempts, 0)
  assert.deepEqual(rewrite.missing, [])
  assert.equal(rewrite.title, article.title)
  assert.equal(rewrite.body, article.announce)
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
    useStub: false,
  })
  const second = await resolveRewrite(db, article, 'joyful', {
    callModel: model.call,
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
  assert.match(all, /Иронично/)
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

test('parseModelContent: валидный JSON → объект, мусор → null', () => {
  assert.deepEqual(parseModelContent('{"title":"a","body":"b"}'), {
    title: 'a',
    body: 'b',
  })
  assert.equal(parseModelContent('не json'), null)
  assert.equal(parseModelContent('{"title":"a"}'), null) // нет body
})
