import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMessages,
  buildMeaningCheckMessages,
  type RewriteFeedback,
} from '../src/prompt.ts'
import { MOOD_REGISTER } from '../src/mood.ts'
import type { Anchor } from '../../shared/api.mts'

// Prompt-module unit-тесты: как Brief в терминах домена рендерится в сообщения
// чат-API. Поведение переписывания (какой Brief собирает generateRewrite и что
// он делает с ответом) проверяется через seam в rewrite.test.ts — здесь только
// сам рендер. Сеть этот module не знает (issue #21, PRD #18).

const title = 'Собянин выделил 1200 млрд рублей'
const announce = 'Мэр Москвы сообщил о росте на 15% в 2026 году.'

// Обратная связь ретрая: по умолчанию пустая, тесты заполняют нужное поле.
function feedback(over: Partial<RewriteFeedback> = {}): RewriteFeedback {
  return {
    missing: [],
    unchanged: false,
    surviving: [],
    distortion: '',
    previous: { title: 'Прошлый заголовок', body: 'Прошлый текст попытки.' },
    ...over,
  }
}

// --- Первая попытка: Brief без feedback ---

test('первая попытка держит регистр Mood и правило «цифрами, а не прописью»', () => {
  const messages = buildMessages({ mood: 'ironic', title, announce })
  const all = messages.map((m) => m.content).join('\n')
  assert.match(all, /цифрами/)
  // Регистр вложен — сверяемся с источником истины, а не с прозой: правка
  // формулировки регистра в MOOD_REGISTER этот тест не ломает.
  assert.ok(all.includes(MOOD_REGISTER['ironic']))
})

test('первая попытка не содержит перечня Anchor ни в каком виде (issue #14, docs/adr/0009)', () => {
  // Без feedback список фрагментов, обязанных уцелеть дословно, в промпт не
  // попадает: он толкал модель вернуть источник слово в слово. Snippet содержит
  // 15%, 1200, 2026, Москв… — ни один не должен всплыть перечнем, и слова-маркеры
  // списка (ДОСЛОВНО/склонять) тоже.
  const messages = buildMessages({ mood: 'neutral', title, announce })
  const all = messages.map((m) => m.content).join('\n')
  assert.doesNotMatch(all, /ДОСЛОВНО/)
  assert.doesNotMatch(all, /обязаны присутствовать/)
  assert.doesNotMatch(all, /склонять/) // раскол «дословно/склоняемо» — только ретрай
})

test('промпт требует сохранять азбуку имён собственных, не запрещая склонение', () => {
  // Замер на живой модели: «Мидзухо» → «Midzuhu», «Дойче Банк» → «Deyche Bank».
  // Fact Check считал имена потерянными — и был прав. Правило «не меняй имена»
  // модель понимала как «не подменяй лицо», а не как «не транслитерируй».
  const messages = buildMessages({ mood: 'neutral', title, announce })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /азбук|кириллиц|латиниц|транслитер/i)
  // Требования к форме имени в первой попытке быть не должно: падеж безразличен
  // и сверке (anchor.ts, первые пять символов), и ретраю (docs/adr/0009).
  assert.doesNotMatch(system, /в том же написании|не склоняй/i)
})

test('промпт требует переписывать конец текста наравне с началом', () => {
  // Замер: на длинном источнике модель переписывала начало и дальше шла за ним
  // слово в слово — sim 0.66–0.86 и unchanged даже после трёх попыток.
  const messages = buildMessages({ mood: 'neutral', title, announce })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /конец текста[^\n]*начал/i)
})

test('ретрай по unchanged тоже говорит про хвост, а не только первая попытка', () => {
  // Пять провалов unchanged на замере пережили все три попытки — значит, слабым
  // местом был ретрай, а не первая попытка.
  const messages = buildMessages({
    mood: 'neutral',
    title,
    announce,
    feedback: feedback({ unchanged: true, surviving: ['мэр москвы сообщил о росте'] }),
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /мэр москвы сообщил о росте/) // уцелевший кусок назван
  assert.match(user, /конец текста/i) // и сказано, где его обычно теряют
})

test('промпт запрещает приписывать факты списком в конце (issue #13)', () => {
  const messages = buildMessages({ mood: 'joyful', title, announce })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /списк|перечн/i)
})

test('промпт защищает исход события (Outcome) и запрещает глумиться над пострадавшими', () => {
  const messages = buildMessages({ mood: 'joyful', title, announce })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /исход события|Outcome/) // Outcome неизменяем (docs/adr/0007)
  assert.match(system, /упало значит упало|погиб значит погиб/) // явное правило направления
  assert.match(system, /не глумись|пострадавш/i) // общий пол на все Mood
})

// --- Ретрай: Brief с feedback ---

test('ретрай требует дословности для чисел, но лишь присутствия — для имён (issue #13)', () => {
  const missing: Anchor[] = [
    { kind: 'number', text: '15%' },
    { kind: 'quote', text: 'дословная цитата' },
    { kind: 'name', text: 'Мойзесу' },
  ]
  const messages = buildMessages({ mood: 'neutral', title, announce, feedback: feedback({ missing }) })
  const user = messages.find((m) => m.role === 'user')!.content
  // Числа и цитаты — дословно.
  assert.match(user, /дословно[^\n]*15%/)
  assert.match(user, /дословно[^\n]*дословная цитата/)
  // Имена — присутствие без требования формы: разрешено склонять.
  assert.match(user, /имена[^\n]*склонять[^\n]*Мойзесу|склонять[^\n]*Мойзесу/i)
  // «Мойзесу» не попадает в строку с требованием дословности.
  const verbatimLine = user.split('\n').find((l) => l.includes('дословно'))!
  assert.doesNotMatch(verbatimLine, /Мойзесу/)
})

test('ретрай по потерянному имени разрешает склонение, а по числу — нет', () => {
  const missing: Anchor[] = [
    { kind: 'number', text: '15%' },
    { kind: 'name', text: 'Мойзесу' },
  ]
  const messages = buildMessages({ mood: 'sad', title, announce, feedback: feedback({ missing }) })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /дословно[^\n]*15%/)
  assert.match(user, /склонять[^\n]*Мойзесу/)
})

test('ретрай называет потерянное и просит вернуть его, сохранив регистр (issue #14)', () => {
  const messages = buildMessages({
    mood: 'joyful',
    title,
    announce,
    feedback: feedback({ missing: [{ kind: 'number', text: '15%' }] }),
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /потеряны/) // потерянное названо
  assert.match(user, /сохрани[^\n]*регистр/i) // держим уже полученный регистр
  assert.match(user, /не переписывай/i) // а не слепая перегенерация с нуля
})

test('ретрай несёт текст прошлой попытки — модель stateless, ей есть что править', () => {
  const messages = buildMessages({
    mood: 'joyful',
    title,
    announce,
    feedback: feedback({ missing: [{ kind: 'number', text: '15%' }] }),
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /Прошлый заголовок/)
  assert.match(user, /Прошлый текст попытки/)
})

test('ретрай при совпадении сообщает модели, что она ничего не изменила', () => {
  const messages = buildMessages({
    mood: 'joyful',
    title,
    announce,
    feedback: feedback({ unchanged: true }),
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /не изменил|без изменений/)
})

test('ретрай называет искажение (Distortion), сохраняя исход события', () => {
  const messages = buildMessages({
    mood: 'joyful',
    title,
    announce,
    feedback: feedback({ distortion: 'рост подменён падением' }),
  })
  const user = messages.find((m) => m.role === 'user')!.content
  assert.match(user, /рост подменён падением/) // названо, а не слепой ретрай
  assert.match(user, /исход события/) // говорит про Outcome словом глоссария
})

// --- Meaning Check ---

test('промпт Meaning Check велит судье проверять исход, а не тон', () => {
  const messages = buildMeaningCheckMessages({
    title,
    announce,
    rewrite: { title: 'Ура!', body: 'Рост на 15%' },
  })
  const all = messages.map((m) => m.content).join('\n')
  assert.match(all, /тон/i) // судью явно просят не придираться к тону
  assert.match(all, /15%/) // переписанный текст вложен
  assert.match(all, /Собянин/) // оригинал вложен для сверки
})

test('промпт Meaning Check: словоформы не считаются подменой, при сомнении consistent', () => {
  const messages = buildMeaningCheckMessages({
    title,
    announce,
    rewrite: { title: 'Ура!', body: 'Рост на 15%' },
  })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /словоформ/i) // разные словоформы — не подмена субъекта
  assert.match(system, /сомнева|consistent:true/i) // при сомнении — не тревога
  assert.match(system, /Outcome|исход/i) // критерий назван через Outcome
})

test('промпт Meaning Check: дорисованная конкретика (время, место, количество, причина, последствие) — Distortion', () => {
  const messages = buildMeaningCheckMessages({
    title,
    announce,
    rewrite: { title: 'Ура!', body: 'Рост на 15%' },
  })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /врем/i) // добавленное время (например, час суток)
  assert.match(system, /мест/i) // добавленное место
  assert.match(system, /количеств/i) // добавленное количество
  assert.match(system, /причин/i) // добавленная причина
  assert.match(system, /последств/i) // добавленное последствие
})

test('промпт Meaning Check: изменение степени/тяжести при сохранённом направлении — Distortion', () => {
  const messages = buildMeaningCheckMessages({
    title,
    announce,
    rewrite: { title: 'Ура!', body: 'Рост на 15%' },
  })
  const system = messages.find((m) => m.role === 'system')!.content
  assert.match(system, /степен|тяжест/i) // изменение степени или тяжести события
  assert.match(system, /повреждение.*разрыв/i) // повреждение → разрыв
})
