import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractAnchors,
  factCheck,
  factCheckSchema,
} from '../src/anchor.ts'
import { anchorSchema } from '../../shared/api.mts'

// --- Извлечение Anchor из Snippet (механически, до всякой модели) ---

test('извлекает числа, даты и суммы как один вид "number"', () => {
  const anchors = extractAnchors('Цена выросла на 15% до 1200 рублей 01.02.2024.')
  const numbers = anchors.filter((a) => a.kind === 'number').map((a) => a.text)
  assert.deepEqual(numbers, ['15%', '1200', '01.02.2024'])
})

test('извлекает содержимое кавычек-ёлочек как Anchor вида "quote"', () => {
  const anchors = extractAnchors('Министр заявил: «рост неизбежен» в этом году.')
  const quotes = anchors.filter((a) => a.kind === 'quote').map((a) => a.text)
  assert.deepEqual(quotes, ['рост неизбежен'])
})

test('извлекает имена собственные, но не заглавное слово в начале предложения', () => {
  const anchors = extractAnchors('Компания растёт. Илон Маск купил Twitter вчера.')
  const names = anchors.filter((a) => a.kind === 'name').map((a) => a.text)
  // Заглавные слова в начале предложений — «Компания» и «Илон» — отбрасываются
  // (отличить имя от обычного слова там нельзя); имена в середине берутся.
  assert.deepEqual(names, ['Маск', 'Twitter'])
})

test('первое слово тела после переноса строки не попадает в Anchor', () => {
  // Anchor извлекаются из склейки «заголовок\nтело». Перенос строки — такая же
  // граница предложения, как точка: первое слово тела («Количество», «Жильё»)
  // заглавное лишь из-за начала строки, а не потому, что имя (issue #12).
  const anchors = extractAnchors('Ставка выросла\nКоличество сделок в Москве упало.')
  const names = anchors.filter((a) => a.kind === 'name').map((a) => a.text)
  assert.deepEqual(names, ['Москве']) // «Количество» отброшено, «Москве» взято
})

test('имя собственное в середине предложения после переноса берётся', () => {
  const anchors = extractAnchors('Заголовок\nОб этом сообщил Путин вчера.')
  const names = anchors.filter((a) => a.kind === 'name').map((a) => a.text)
  assert.deepEqual(names, ['Путин']) // «Об» в начале строки отброшено, «Путин» взят
})

test('содержимое кавычек очищается от краевых и внутренних лишних пробелов', () => {
  // Snippet собирается из склейки «заголовок\nтело» и полного текста страницы:
  // цитата легко получает перенос строки или задвоенный пробел. Дословная
  // сверка требует, чтобы Anchor совпал с прозой Rewrite — а модель пишет
  // одиночными пробелами. Нормализуем: края обрезаем, внутренние прогоны в один
  // пробел (issue #15).
  const anchors = extractAnchors('Он сказал: «  рост\nнеизбежен  » сегодня.')
  const quotes = anchors.filter((a) => a.kind === 'quote').map((a) => a.text)
  assert.deepEqual(quotes, ['рост неизбежен'])
})

test('заглавное слово сразу после открывающей кавычки — не имя', () => {
  // Первое слово цитаты заглавно по правилу кавычек, а не потому что имя.
  // Кавычка не закрыта — quote-Anchor не извлекается, но «Компания» после «
  // всё равно не имя собственное (issue #15).
  const anchors = extractAnchors('Источник сообщил: «Компания уходит с рынка')
  const names = anchors.filter((a) => a.kind === 'name').map((a) => a.text)
  assert.deepEqual(names, [])
})

test('имя внутри цитаты не дублируется отдельным name-Anchor', () => {
  // Имя внутри кавычек уже защищено quote-Anchor (цитата хранится дословно):
  // отдельный name-Anchor на него — дубль-подстрока (issue #15).
  const anchors = extractAnchors('Депутат отметил, что «поддержку получит Сибирь целиком».')
  const quotes = anchors.filter((a) => a.kind === 'quote').map((a) => a.text)
  const names = anchors.filter((a) => a.kind === 'name').map((a) => a.text)
  assert.deepEqual(quotes, ['поддержку получит Сибирь целиком'])
  assert.deepEqual(names, [])
})

test('одинаковые Anchor не дублируются', () => {
  const anchors = extractAnchors('В 2024 году, снова в 2024 году.')
  const numbers = anchors.filter((a) => a.kind === 'number').map((a) => a.text)
  assert.deepEqual(numbers, ['2024'])
})

test('каждый извлечённый Anchor проходит собственную схему', () => {
  const anchors = extractAnchors('Курс достиг 90 в Москве.')
  assert.ok(anchors.length > 0)
  for (const anchor of anchors) {
    assert.doesNotThrow(() => anchorSchema.parse(anchor))
  }
})

// --- Fact Check: сверка Rewrite со списком Anchor ---

test('Fact Check проходит, когда все Anchor дословно на месте', () => {
  const anchors = extractAnchors('Ставка 15% названа Путиным.')
  const result = factCheck('Внезапно! Целых 15%! И это сказал Путин.', anchors)
  assert.equal(result.passed, true)
  assert.deepEqual(result.missing, [])
  assert.doesNotThrow(() => factCheckSchema.parse(result))
})

test('Fact Check ловит пропавшее число и не проходит', () => {
  const anchors = extractAnchors('Ставка выросла на 15%.')
  const result = factCheck('Ставка ощутимо выросла, и это тревожно.', anchors)
  assert.equal(result.passed, false)
  assert.deepEqual(
    result.missing.map((a) => a.text),
    ['15%'],
  )
})

test('Fact Check ловит подменённое число', () => {
  const anchors = extractAnchors('Погибло 12 человек.')
  const result = factCheck('Погибло 21 человек — какой ужас.', anchors)
  assert.equal(result.passed, false)
  assert.deepEqual(
    result.missing.map((a) => a.text),
    ['12'],
  )
})

test('число прописью засчитывается: «трое погибших» — это Anchor «3»', () => {
  const anchors = extractAnchors('При пожаре погибли 3 человека, ещё 7 в больнице.')
  const result = factCheck('Трое погибли в огне, семеро увезены в больницу.', anchors)
  assert.equal(result.passed, true)
})

test('число прописью в падеже тоже засчитывается', () => {
  const anchors = extractAnchors('Погибли 3 человека.')
  assert.equal(factCheck('Пожар унёс жизни трёх человек.', anchors).passed, true)
})

test('слово, начинающееся с числительного, за число не сходит', () => {
  const anchors = extractAnchors('Пришли 2 человека и 100 гостей.')
  const result = factCheck('Двадцать лет спустя стоимость выросла.', anchors)
  assert.deepEqual(
    result.missing.map((a) => a.text),
    ['2', '100'],
  )
})

test('заглавное прилагательное перед строчным словом за имя не считается', () => {
  const anchors = extractAnchors('Об этом сообщил глава Центрального банка.')
  assert.deepEqual(
    anchors.map((a) => a.text),
    [],
  )
})

test('заглавное слово перед заглавным — часть названия, Anchor остаётся', () => {
  const anchors = extractAnchors('Он работал в Дойче Банк много лет.')
  assert.deepEqual(
    anchors.map((a) => a.text),
    ['Дойче', 'Банк'],
  )
})

test('цитата в начале предложения — заглавная первая буква не потеря', () => {
  const anchors = extractAnchors('Он сказал: «инфляция выше цели, ставку удержим».')
  const result = factCheck('«Инфляция выше цели, ставку удержим», — заявил глава ЦБ.', anchors)
  assert.equal(result.passed, true)
})

test('изменённые слова внутри цитаты — по-прежнему потеря', () => {
  const anchors = extractAnchors('Он сказал: «инфляция выше цели, ставку удержим».')
  const result = factCheck('«Инфляция ниже цели, ставку снизим», — заявил глава ЦБ.', anchors)
  assert.equal(result.passed, false)
})

test('имя засчитывается по первым 5 символам, переживая падеж', () => {
  const anchors = extractAnchors('Об этом сообщил Зеленский.')
  // Rewrite ставит имя в другой падеж — «Зеленского».
  const result = factCheck('Об этом с грустью сообщил Зеленского представитель.', anchors)
  assert.equal(result.passed, true)
})
